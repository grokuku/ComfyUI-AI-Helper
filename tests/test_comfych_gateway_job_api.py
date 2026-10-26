# ─────────────────────────────────────────────────────────────────────────
# ComfyCH — le rendu est DÉCOUPLÉ de la requête HTTP (spawn + polling).
#
# Bug vécu : `HTTP 503: Job interrompu (déconnexion client ou redéploiement)`
# après 4 min alors que le rendu avait produit ses images (visibles dans la
# galerie via AIH Save Media). Cause exacte : `gateway_router.generate`
# attendait la fin du rendu **dans la même requête HTTP**, en pollant
# `worker.history` une fois par seconde. Toute coupure de cette requête
# (déconnexion du navigateur, proxy, redéploiement, et surtout le `timeout`
# implicite de **300 s** de `@app.function()` — Modal annule alors l'entrée)
# levait `asyncio.CancelledError` → 503 « Job interrompu ». Le rendu, lui,
# continuait ou aboutissait : l'UI affichait un FAUX ÉCHEC.
#
# Ce que ce fichier verrouille (chaque point a son mutant) :
#   §1 `POST /generate` en `async_mode` rend la main IMMÉDIATEMENT (202 +
#      job_id) et lance le job par `spawn` — MUTANT « requête bloquante
#      réintroduite » → ROUGE (le test mesure la durée de l'appel) ;
#   §2 un rendu long ABOUTIT : le client suit `GET /job/<id>` et reçoit les
#      images, sans jamais de 503 — MUTANT « pas de reprise d'état » → ROUGE ;
#   §3 une coupure du client n'annule PAS le job (`cancel()` jamais appelé) et
#      le résultat reste récupérable ensuite — MUTANT « résultat non
#      récupérable après coupure » → ROUGE ;
#   §4 budget d'attente dépassé → `504` **explicite** avec `resume_url`
#      (jamais « Job interrompu ») ;
#   §5 un échec RÉEL reste une erreur (le résultat ne masque pas l'échec) ;
#   §6 le `timeout` des fonctions web est CONFIGURABLE et explicitement déclaré
#      dans les apps — MUTANT « timeout non configurable » → ROUGE.
#
# Usage :
#   PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
#   pytest tests/test_comfych_gateway_job_api.py
# ─────────────────────────────────────────────────────────────────────────
import asyncio
import importlib.util
import sys
import time
import types
from pathlib import Path
from typing import ClassVar

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
COMFYCH_DIR = PACKAGE_DIR / "tools" / "comfych"
ROUTER_FILE = COMFYCH_DIR / "gateway_router.py"
APPS_DIR = COMFYCH_DIR / "apps"

IMAGE_PAYLOAD = {
    "filename": "ComfyUI_0001_.png",
    "subfolder": "",
    "type": "output",
    "content_type": "image/png",
    "data": "iVBORw0KGgo=",
}


# ---------------------------------------------------------------------------
# Stubs `fastapi` / `pydantic` (les paquets pip ne sont pas installés en test)
# ---------------------------------------------------------------------------
class JSONResponse:
    """Réponse de test : ``content`` + ``status_code`` (comme fastapi)."""

    def __init__(self, content=None, status_code=200, **kwargs):
        self.content = content
        self.status_code = status_code

    def __repr__(self):  # pragma: no cover - confort de debug
        return f"JSONResponse({self.status_code}, {self.content!r})"


class Response:
    def __init__(self, content=b"", media_type=None, **kwargs):
        self.body = content
        self.media_type = media_type


class FakeFastAPI:
    def __init__(self, title="", **kwargs):
        self.title = title
        self.routes = {}

    def add_middleware(self, *a, **k):
        return None

    def _register(self, method, path):
        def decorator(fn):
            self.routes[(method, path)] = fn
            return fn

        return decorator

    def post(self, path, **kwargs):
        return self._register("POST", path)

    def get(self, path, **kwargs):
        return self._register("GET", path)


class FakeBaseModel:
    """`pydantic.BaseModel` minimal : annotations + valeurs par défaut + kwargs."""

    def __init__(self, **kwargs):
        annotations = {}
        for klass in reversed(type(self).__mro__):
            annotations.update(getattr(klass, "__annotations__", {}))
        for name in annotations:
            default = getattr(type(self), name, None)
            setattr(self, name, kwargs.pop(name, default))
        for name, value in kwargs.items():
            setattr(self, name, value)


def _module(name, **attrs):
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    return module


@pytest.fixture(scope="module")
def router_module():
    """Charge ``gateway_router.py`` avec des stubs `fastapi`/`pydantic`."""
    saved = {n: sys.modules.get(n) for n in ("fastapi", "pydantic", "auth")}

    responses = _module("fastapi.responses", JSONResponse=JSONResponse, Response=Response)
    cors = _module("fastapi.middleware.cors", CORSMiddleware=lambda *a, **k: None)
    middleware = _module("fastapi.middleware", cors=cors)
    fastapi = _module(
        "fastapi",
        FastAPI=FakeFastAPI,
        Depends=lambda dep=None, **k: dep,
        Request=object,
        responses=responses,
    )
    fastapi.middleware = middleware
    pydantic = _module("pydantic", BaseModel=FakeBaseModel)
    # `auth` réel non importable (dépend de fastapi/starlette) → module factice.
    auth = _module("auth", require_api_key=lambda: None, get_modal_secrets=list)

    sys.modules.update(
        {
            "fastapi": fastapi,
            "fastapi.responses": responses,
            "fastapi.middleware": middleware,
            "fastapi.middleware.cors": cors,
            "pydantic": pydantic,
            "auth": auth,
        }
    )
    try:
        spec = importlib.util.spec_from_file_location(
            "comfych_gateway_router_under_test", ROUTER_FILE
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        yield module
    finally:
        sys.modules.pop("comfych_gateway_router_under_test", None)
        for name, previous in saved.items():
            if previous is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous


# ---------------------------------------------------------------------------
# Doubles Modal : handle de `spawn`, worker, fonction CPU `job_reader`
# ---------------------------------------------------------------------------
class _AsyncGetter:
    """Imite `call.get.aio(timeout=0)`."""

    def __init__(self, call):
        self._call = call

    async def aio(self, timeout=None, index=0):
        if self._call.result is None:
            raise asyncio.TimeoutError()
        return self._call.result


class FakeCall:
    def __init__(self):
        self.object_id = "fc-test"
        self.result = None
        self.cancelled = 0

    @property
    def get(self):
        return _AsyncGetter(self)

    async def cancel(self, *a, **k):
        self.cancelled += 1


class _AsyncSpawner:
    def __init__(self, owner):
        self._owner = owner

    async def aio(self, *args, **kwargs):
        call = FakeCall()
        self._owner.cls.spawned.append({"args": args, "kwargs": kwargs, "call": call})
        return call


class FakeRunJob:
    def __init__(self, cls):
        self.cls = cls
        self.spawn = _AsyncSpawner(self)


class FakeWorker:
    """Worker Modal de test : `run_job.spawn.aio(workflow, job_id)`."""

    spawned: ClassVar[list] = []

    def __init__(self):
        self.run_job = FakeRunJob(type(self))


class _Remote:
    def __init__(self, reader):
        self._reader = reader

    async def aio(self, *a, **k):
        return self._reader.read(*a, **k)


class FakeJobReader:
    """Fonction CPU `read_job_result` : lit le store de résultats (volume)."""

    def __init__(self):
        self.store = {}
        self.reads = 0
        self.remote = _Remote(self)

    def read(self, job_id):
        self.reads += 1
        state = self.store.get(job_id)
        if state is None:
            return {"status": "missing", "job_id": job_id}
        return dict(state)

    def set_running(self, job_id, elapsed=1.0):
        self.store[job_id] = {
            "status": "running",
            "job_id": job_id,
            "started_at": time.time() - elapsed,
            "budget": 3600,
        }

    def set_done(self, job_id, images=None):
        self.store[job_id] = {
            "status": "done",
            "job_id": job_id,
            "prompt_id": "pid-1",
            "images": images if images is not None else [dict(IMAGE_PAYLOAD)],
        }

    def set_failed(self, job_id, error="node manquant"):
        self.store[job_id] = {
            "status": "failed",
            "job_id": job_id,
            "error": error,
            "images": [],
        }


@pytest.fixture
def gateway(router_module, monkeypatch):
    """Routeur monté + store de jobs pilotable."""
    FakeWorker.spawned = []
    reader = FakeJobReader()
    app = router_module.build_router(
        worker_map={"L4": FakeWorker},
        cors_origins=["*"],
        title="test",
        logs_reader=None,
        job_reader=reader,
    )
    monkeypatch.setattr(router_module, "job_poll_interval_seconds", lambda: 0.01)
    # Budget du mode bloquant BORNÉ : le défaut de production est de 900 s, ce
    # qui ferait PENDRE la suite (au lieu de la faire échouer) si la lecture du
    # store de jobs régressait — un test doit toujours rendre un verdict.
    monkeypatch.setattr(router_module, "sync_wait_seconds", lambda: 2.0)
    # Isolation : les caches mémoire sont globaux au module.
    monkeypatch.setattr(router_module, "_idempotency_cache", {})
    monkeypatch.setattr(router_module, "_jobs", {})
    return types.SimpleNamespace(module=router_module, app=app, reader=reader)


def call_generate(gateway, **kwargs):
    payload = {"workflow": {"1": {"class_type": "X"}}, "gpu": "L4"}
    payload.update(kwargs)
    request = gateway.module.GenerateRequest(**payload)
    return asyncio.run(gateway.app.routes[("POST", "/generate")](request))


def call_job(gateway, job_id):
    return asyncio.run(gateway.app.routes[("GET", "/job/{job_id}")](job_id))


def status_of(response):
    return response.status_code if isinstance(response, JSONResponse) else 200


def body_of(response):
    return response.content if isinstance(response, JSONResponse) else response


# ---------------------------------------------------------------------------
# §1 — la soumission ne bloque pas : 202 immédiat + spawn
# ---------------------------------------------------------------------------
def test_soumission_detachee_rend_la_main_immediatement(gateway):
    started = time.monotonic()
    response = call_generate(gateway, async_mode=True, job_id="job-async")
    elapsed = time.monotonic() - started

    assert status_of(response) == 202, response
    body = body_of(response)
    assert body["status"] == "running"
    assert body["job_id"] == "job-async"
    # MUTANT « requête bloquante réintroduite » : si /generate attendait le
    # résultat, le store (toujours « running ») ne serait jamais rendu la main.
    assert elapsed < 1.0, f"la soumission a duré {elapsed:.2f}s (elle doit être immédiate)"
    assert len(FakeWorker.spawned) == 1, "le job doit être lancé par spawn"
    args = FakeWorker.spawned[0]["args"]
    assert args[1] == "job-async", "le job_id doit être transmis au worker"


def test_idempotence_aucune_relance_sur_meme_job_id(gateway):
    gateway.reader.set_done("job-deja-fait")
    response = call_generate(gateway, async_mode=True, job_id="job-deja-fait")
    body = body_of(response)
    assert body["status"] == "done"
    assert body["images"] and body["images"][0]["filename"] == "ComfyUI_0001_.png"
    assert FakeWorker.spawned == [], "un job terminé ne doit jamais être relancé"


# ---------------------------------------------------------------------------
# §2 — un rendu long aboutit (suivi par id, jamais de 503)
# ---------------------------------------------------------------------------
def test_rendu_long_aboutit_sans_503(gateway):
    response = call_generate(gateway, async_mode=True, job_id="job-long")
    assert status_of(response) == 202

    # Le worker avance, puis termine : le client apprend le résultat par
    # `GET /job/<id>` (requêtes courtes), jamais par une requête bloquante.
    gateway.reader.set_running("job-long")
    running = call_job(gateway, "job-long")
    assert status_of(running) == 200
    assert body_of(running)["status"] == "running"

    gateway.reader.set_done("job-long")
    done = call_job(gateway, "job-long")
    assert status_of(done) == 200
    body = body_of(done)
    assert body["status"] == "done"
    assert body["images"][0]["data"] == IMAGE_PAYLOAD["data"]
    assert status_of(done) != 503


def test_mode_bloquant_aboutit_aussi(gateway):
    """Compatibilité : l'ancien contrat (résultat dans la réponse) fonctionne."""
    gateway.reader.set_done("job-sync", images=[dict(IMAGE_PAYLOAD)])
    response = call_generate(gateway, async_mode=False, job_id="job-sync")
    body = body_of(response)
    assert status_of(response) == 200
    assert body["status"] == "done" and body["images"]


# ---------------------------------------------------------------------------
# §3 — la coupure du client n'annule pas le rendu, et le résultat est repris
# ---------------------------------------------------------------------------
def test_coupure_client_n_annule_pas_le_rendu(gateway):
    async def scenario():
        request = gateway.module.GenerateRequest(
            workflow={"1": {"class_type": "X"}}, gpu="L4", job_id="job-coupe"
        )
        route = gateway.app.routes[("POST", "/generate")]
        task = asyncio.create_task(route(request))
        await asyncio.sleep(0.05)
        # Le job est lancé et le worker l'exécute pendant que le client attend…
        gateway.reader.set_running("job-coupe")
        await asyncio.sleep(0.1)
        # … puis le client disparaît (fermeture d'onglet, timeout, proxy).
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        return task.cancelled()

    assert asyncio.run(scenario()) is True
    call = FakeWorker.spawned[-1]["call"]
    assert call.cancelled == 0, "une déconnexion cliente ne doit JAMAIS annuler le job"

    # Le rendu aboutit côté worker : le résultat est récupérable ensuite.
    gateway.reader.set_done("job-coupe")
    recovered = call_job(gateway, "job-coupe")
    assert status_of(recovered) == 200
    assert body_of(recovered)["status"] == "done"
    assert body_of(recovered)["images"][0]["data"] == IMAGE_PAYLOAD["data"]


def test_job_inconnu_renvoie_404_explicite(gateway):
    response = call_job(gateway, "job-fantome")
    assert status_of(response) == 404
    assert body_of(response)["status"] == "unknown"


# ---------------------------------------------------------------------------
# §4 — budget dépassé : 504 explicite avec reprise (jamais « Job interrompu »)
# ---------------------------------------------------------------------------
def test_budget_depasse_renvoie_504_avec_reprise(gateway, monkeypatch):
    monkeypatch.setenv("COMFYCH_SYNC_WAIT_S", "1")
    monkeypatch.setenv("COMFYCH_JOB_POLL_INTERVAL_S", "0.2")
    gateway.reader.set_running("job-tres-long")

    response = call_generate(gateway, async_mode=False, job_id="job-tres-long")
    assert status_of(response) == 504, response
    body = body_of(response)
    assert body["resume_url"] == "/job/job-tres-long"
    assert body["status"] == "running", "le job continue : il n'a PAS échoué"
    assert "Job interrompu" not in str(body), "plus de faux échec de déconnexion"
    # Aucune relance : le job déjà en cours est simplement suivi.
    assert FakeWorker.spawned == []


def test_job_orphelin_finit_par_etre_declare_perdu(gateway):
    """Conteneur mort sans résultat : échec HONNÊTE, pas d'attente infinie."""
    gateway.reader.store["job-orphelin"] = {
        "status": "running",
        "job_id": "job-orphelin",
        "started_at": time.time() - 10_000,
        "budget": 60,
    }
    response = call_job(gateway, "job-orphelin")
    body = body_of(response)
    assert status_of(response) == 200
    assert body["status"] == "failed"
    assert "sans résultat" in body["error"]


# ---------------------------------------------------------------------------
# §5 — un échec RÉEL reste une erreur
# ---------------------------------------------------------------------------
def test_echec_reel_non_masque(gateway):
    gateway.reader.set_failed("job-ko", error="KSampler: CUDA out of memory")
    body = body_of(call_job(gateway, "job-ko"))
    assert body["status"] == "failed"
    assert "out of memory" in body["error"]
    assert body["images"] == []

    # En mode bloquant, c'est un 500 (le rendu a réellement échoué).
    gateway.reader.set_failed("job-ko2", error="node manquant")
    response = call_generate(gateway, async_mode=False, job_id="job-ko2")
    assert status_of(response) == 500
    assert "node manquant" in str(body_of(response))


# ---------------------------------------------------------------------------
# §6 — timeout web CONFIGURABLE et déclaré explicitement dans les apps
# ---------------------------------------------------------------------------
def test_timeout_gateway_configurable(router_module, monkeypatch):
    monkeypatch.delenv("COMFYCH_GATEWAY_TIMEOUT_S", raising=False)
    assert router_module.gateway_timeout_seconds() == 3600, (
        "sans timeout explicite, Modal applique 300 s et tue la requête"
    )
    monkeypatch.setenv("COMFYCH_GATEWAY_TIMEOUT_S", "5400")
    assert router_module.gateway_timeout_seconds() == 5400
    # Valeur absurde → repli (jamais un timeout de 0 s qui tuerait tout).
    monkeypatch.setenv("COMFYCH_GATEWAY_TIMEOUT_S", "5")
    assert router_module.gateway_timeout_seconds() >= 120
    monkeypatch.setenv("COMFYCH_GATEWAY_TIMEOUT_S", "n'importe quoi")
    assert router_module.gateway_timeout_seconds() == 3600
    # Le budget bloquant reste TOUJOURS sous le timeout Modal.
    assert router_module.sync_wait_seconds() < router_module.gateway_timeout_seconds()


def test_apps_declarent_un_timeout_explicite_et_configurable():
    """MUTANT « timeout non configurable » : `@app.function()` nu → ROUGE."""
    apps = sorted(APPS_DIR.glob("all_in_one*.py"))
    assert apps, "aucune app trouvée"
    for app_file in apps:
        source = app_file.read_text()
        assert "timeout=gateway_timeout_seconds()" in source, (
            f"{app_file.name} : le timeout des fonctions web doit venir de "
            "gateway_timeout_seconds() (configurable), pas de la valeur par "
            "défaut de Modal (300 s)"
        )
        assert "startup_timeout=gateway_startup_timeout_seconds()" in source
        assert "job_reader=read_job_result" in source, (
            f"{app_file.name} : le routeur doit pouvoir lire les résultats sur "
            "le volume (reprise après coupure)"
        )
        # Aucune fonction web ne doit rester sans timeout explicite.
        assert "@app.function()\n@modal.concurrent" not in source


def test_resolve_job_id(gateway):
    resolve = gateway.module.resolve_job_id
    assert resolve("req-123") == "req-123"
    assert resolve("", "job-abc") == "job-abc"
    # Identifiant douteux → nettoyé, jamais un chemin.
    assert "/" not in resolve("../../etc/passwd")
    generated = resolve("")
    assert generated.startswith("job-") and len(generated) > 8
