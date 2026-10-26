# ─────────────────────────────────────────────────────────────────────────
# ComfyCH — un rendu vit DANS le worker et son résultat est PERSISTANT.
#
# Bug vécu : `HTTP 503: Job interrompu (déconnexion client ou redéploiement)`
# après 4 min, alors que le rendu avait bel et bien produit ses images (elles
# apparaissaient dans la galerie via le node AIH Save Media). Le travail était
# fait, seul l'ACHEMINEMENT du résultat cassait :
#
#  - le gateway attendait la fin du rendu DANS sa requête HTTP ; toute coupure
#    arrêtait le suivi, donc le conteneur GPU n'avait plus d'entrée et
#    `scaledown_window` (30 s) l'arrêtait en plein rendu ;
#  - les images vivaient dans le FS éphémère du conteneur (voire `/dev/shm`),
#    donc elles disparaissaient avec lui.
#
# Ce que ce fichier verrouille (chaque point a son mutant) :
#   §1 `run_job` va au bout TOUT SEUL (aucun client, aucun polling externe) et
#      rend des images — MUTANT « suivre le rendu depuis l'extérieur » → ROUGE ;
#   §2 le résultat est écrit sur le VOLUME (manifeste + fichiers), jamais dans
#      un répertoire éphémère comme `/dev/shm` — MUTANT « outputs en tmpfs »
#      → ROUGE ;
#   §3 il est RELISIBLE après la mort du conteneur (`read_job_state`, le même
#      helper que la fonction CPU `read_job_result`) : c'est la reprise après
#      coupure — MUTANT « résultat non persisté » → ROUGE ;
#   §4 un échec RÉEL écrit `status: failed` + le message (jamais un faux
#      « terminé ») et ne laisse pas d'images ;
#   §5 budget de rendu borné : au-delà de `COMFYCH_JOB_TIMEOUT_S` le job conclut
#      `failed` avec un message explicite (pas d'attente infinie).
#
# Usage :
#   PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
#   pytest tests/test_comfych_worker_jobs.py
# ─────────────────────────────────────────────────────────────────────────
import asyncio
import base64
import importlib.util
import json
import sys
import types
from pathlib import Path
from typing import ClassVar

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
WORKER_FILE = PACKAGE_DIR / "tools" / "comfych" / "workers" / "base_worker.py"


# ---------------------------------------------------------------------------
# Stubs `modal` / `httpx` (les paquets pip ne sont pas installés en test)
# ---------------------------------------------------------------------------
def _decorator(*args, **kwargs):
    """Décorateur permissif : `@modal.method()`, `@modal.enter(snap=True)`…"""
    if len(args) == 1 and callable(args[0]) and not kwargs:
        return args[0]

    def wrap(fn):
        return fn

    return wrap


class _FakeVolume:
    commits = 0

    @classmethod
    def from_name(cls, *a, **k):
        return cls()

    def commit(self):
        type(self).commits += 1


class _FakeResponse:
    def __init__(self, status_code=200, payload=None, content=b"", headers=None):
        self.status_code = status_code
        self._payload = payload
        self.content = content
        self.headers = headers or {"content-type": "image/png"}
        self.text = json.dumps(payload) if payload is not None else ""

    def json(self):
        return self._payload


class _HTTPError(Exception):
    pass


class _FakeAsyncClient:
    """Client httpx de test : délègue à ``handler(method, url, kwargs)``."""

    handler: ClassVar = None
    calls: ClassVar[list] = []

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, **kwargs):
        type(self).calls.append(("GET", url, kwargs))
        return await type(self).handler("GET", url, kwargs)

    async def post(self, url, **kwargs):
        type(self).calls.append(("POST", url, kwargs))
        return await type(self).handler("POST", url, kwargs)


def _httpx_stub():
    module = types.ModuleType("httpx")
    module.AsyncClient = _FakeAsyncClient
    module.HTTPError = _HTTPError
    module.Response = _FakeResponse
    return module


def _modal_stub():
    module = types.ModuleType("modal")
    module.method = _decorator
    module.enter = _decorator
    module.exit = _decorator
    module.concurrent = _decorator
    module.build = _decorator
    module.Volume = _FakeVolume
    module.App = lambda *a, **k: types.SimpleNamespace()
    module.Image = types.SimpleNamespace(debian_slim=lambda *a, **k: None)
    return module


@pytest.fixture(scope="module")
def worker_module():
    """Charge ``workers/base_worker.py`` avec des stubs `modal`/`httpx`."""
    saved = {name: sys.modules.get(name) for name in ("modal", "httpx")}
    sys.modules["modal"] = _modal_stub()
    sys.modules["httpx"] = _httpx_stub()
    try:
        spec = importlib.util.spec_from_file_location(
            "comfych_base_worker_under_test", WORKER_FILE
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        yield module
    finally:
        sys.modules.pop("comfych_base_worker_under_test", None)
        for name, previous in saved.items():
            if previous is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous


@pytest.fixture
def jobs_root(tmp_path, worker_module, monkeypatch):
    """Redirige le store de jobs vers un dossier JETABLE."""
    root = tmp_path / "jobs"
    root.mkdir()
    monkeypatch.setattr(worker_module, "JOBS_VOLUME_DIR", root)
    return root


# ---------------------------------------------------------------------------
# Helpers d'assertion (les « garde-fous de mutant »)
# ---------------------------------------------------------------------------
def is_persistent_root(path) -> bool:
    """Le store de jobs est-il sur un support PERSISTANT (volume Modal) ?

    ``/dev/shm`` et ``/tmp`` sont éphémères : un résultat qui y est écrit est
    perdu dès l'arrêt du conteneur — exactement le bug constaté. Ce prédicat
    est l'assertion utilisée par les tests : le passer sur un répertoire
    éphémère DOIT renvoyer False (sinon le test ne détecte pas le mutant).
    """
    text = str(path)
    ephemeral = ("/dev/shm", "/tmp", "/var/tmp", "/run")
    return text.startswith("/cache") and not any(
        text == e or text.startswith(e + "/") for e in ephemeral
    )


EPHEMERAL_IMAGES = {
    "images": [
        {
            "filename": "ComfyUI_0001_.png",
            "subfolder": "",
            "type": "output",
            "content_type": "image/png",
            "data": base64.b64encode(b"\x89PNG-fake-image").decode("ascii"),
        }
    ]
}

WORKFLOW = {"1": {"class_type": "CheckpointLoaderSimple", "inputs": {}}}


def _handler_factory(polls_before_done=2):
    """Handler ComfyUI de test : /prompt OK, /history muet N fois, /view OK."""
    state = {"polls": 0}

    async def handler(method, url, kwargs):
        if url.endswith("/prompt"):
            return _FakeResponse(200, {"prompt_id": "pid-123", "number": 1})
        if "/history/" in url:
            state["polls"] += 1
            if state["polls"] <= polls_before_done:
                return _FakeResponse(200, {})
            return _FakeResponse(
                200,
                {
                    "pid-123": {
                        "outputs": {
                            "9": {
                                "images": [
                                    {
                                        "filename": "ComfyUI_0001_.png",
                                        "subfolder": "",
                                        "type": "output",
                                    }
                                ]
                            }
                        }
                    }
                },
            )
        if url.endswith("/view"):
            name = (kwargs.get("params") or {}).get("filename", "")
            if name == "ComfyUI_0001_.png":
                return _FakeResponse(200, content=b"\x89PNG-fake-image")
            return _FakeResponse(404, content=b"")
        return _FakeResponse(404, {})

    return handler


# ---------------------------------------------------------------------------
# §1 + §2 — le rendu va au bout seul, et son résultat va sur le volume
# ---------------------------------------------------------------------------
def test_run_job_aboutit_seul_et_persiste_sur_le_volume(
    worker_module, jobs_root, monkeypatch
):
    _FakeAsyncClient.calls = []
    monkeypatch.setattr(_FakeAsyncClient, "handler", staticmethod(_handler_factory()))
    monkeypatch.setattr(worker_module, "JOB_POLL_INTERVAL_SECONDS", 0.01)

    worker = worker_module.ComfyWorker()
    result = asyncio.run(worker.run_job(WORKFLOW, "job-test-1"))

    assert result["status"] == "done", result
    assert result["job_id"] == "job-test-1"
    assert result["prompt_id"] == "pid-123"
    assert len(result["images"]) == 1
    assert result["images"][0]["filename"] == "ComfyUI_0001_.png"
    assert result["images"][0]["data"], "l'image doit être renvoyée en base64"
    assert result["persisted"] is True

    # §2 — les fichiers vivent sur le store persistant, pas dans un tmpfs.
    job_files = list((jobs_root / "job-test-1").glob("*.png"))
    assert job_files, "l'image doit être écrite sur le volume"
    assert base64.b64decode(result["images"][0]["data"]) == job_files[0].read_bytes()
    for path in result["dir"], str(job_files[0]):
        assert "/dev/shm" not in str(path), f"résultat en tmpfs : {path}"

    manifest = json.loads((jobs_root / "job-test-1" / "manifest.json").read_text())
    assert manifest["status"] == "done"
    assert manifest["prompt_id"] == "pid-123"
    assert manifest["images"][0]["filename"] == "ComfyUI_0001_.png"


def test_le_store_de_jobs_est_sur_un_support_persistant(worker_module):
    """MUTANT « outputs en tmpfs » : la racine du store doit être /cache."""
    assert is_persistent_root(worker_module.JOBS_VOLUME_DIR), (
        "les résultats doivent être persistés sur le volume /cache, "
        f"pas dans {worker_module.JOBS_VOLUME_DIR}"
    )
    # Le garde-fou mord réellement : sur /dev/shm il refuse.
    assert not is_persistent_root("/dev/shm/jobs")
    assert not is_persistent_root("/tmp/jobs")


# ---------------------------------------------------------------------------
# §3 — le résultat survit à la mort du conteneur (reprise après coupure)
# ---------------------------------------------------------------------------
def test_resultat_recuperable_apres_arret_du_conteneur(
    worker_module, jobs_root, monkeypatch
):
    monkeypatch.setattr(_FakeAsyncClient, "handler", staticmethod(_handler_factory()))
    monkeypatch.setattr(worker_module, "JOB_POLL_INTERVAL_SECONDS", 0.01)

    asyncio.run(worker_module.ComfyWorker().run_job(WORKFLOW, "job-reprise"))
    # « Le conteneur GPU s'arrête » : plus de process ComfyUI, plus d'instance
    # de worker. Seul le volume reste — c'est ce que lit la fonction CPU.
    state = worker_module.read_job_state("job-reprise")
    assert state["status"] == "done"
    assert state["images"] and state["images"][0]["data"]
    assert base64.b64decode(state["images"][0]["data"]).startswith(b"\x89PNG")


def test_job_inconnu_ou_identifiant_douteux(worker_module, jobs_root):
    assert worker_module.read_job_state("jamais-lance")["status"] == "missing"
    # Aucun chemin ne doit pouvoir sortir du store (job_id = nom de dossier).
    escape = worker_module.read_job_state("../../etc")
    assert escape["status"] == "missing"
    with pytest.raises(ValueError):
        worker_module.job_dir("a/b")


# ---------------------------------------------------------------------------
# §4 — un échec RÉEL est un échec (jamais un faux « terminé »)
# ---------------------------------------------------------------------------
def test_echec_reel_du_rendu_est_rapporte(worker_module, jobs_root, monkeypatch):
    async def handler(method, url, kwargs):
        if url.endswith("/prompt"):
            return _FakeResponse(500, {"error": "node manquant"})
        return _FakeResponse(404, {})

    monkeypatch.setattr(_FakeAsyncClient, "handler", staticmethod(handler))
    result = asyncio.run(worker_module.ComfyWorker().run_job(WORKFLOW, "job-ko"))

    assert result["status"] == "failed"
    assert "node manquant" in (result["error"] or "")
    assert result["images"] == []
    state = worker_module.read_job_state("job-ko")
    assert state["status"] == "failed"
    assert "node manquant" in state["error"]


# ---------------------------------------------------------------------------
# §5 — budget de rendu borné (pas d'attente infinie)
# ---------------------------------------------------------------------------
def test_budget_de_rendu_borne(worker_module, jobs_root, monkeypatch):
    async def handler(method, url, kwargs):
        if url.endswith("/prompt"):
            return _FakeResponse(200, {"prompt_id": "pid-lent"})
        return _FakeResponse(200, {})  # /history toujours vide

    monkeypatch.setattr(_FakeAsyncClient, "handler", staticmethod(handler))
    monkeypatch.setattr(worker_module, "JOB_POLL_INTERVAL_SECONDS", 0.01)
    monkeypatch.setattr(worker_module, "JOB_TIMEOUT_SECONDS", 0.15)

    result = asyncio.run(worker_module.ComfyWorker().run_job(WORKFLOW, "job-slow"))
    assert result["status"] == "failed"
    assert "TimeoutError" in (result["error"] or "")
    assert worker_module.read_job_state("job-slow")["status"] == "failed"


def test_manifeste_ecrit_de_facon_atomique(worker_module, jobs_root):
    """Aucun JSON tronqué ne doit être lisible pendant l'écriture."""
    worker_module.write_job_state("job-atomic", {"status": "running"})
    first = json.loads((jobs_root / "job-atomic" / "manifest.json").read_text())
    worker_module.write_job_state("job-atomic", {"status": "done", "images": []})
    second = json.loads((jobs_root / "job-atomic" / "manifest.json").read_text())
    assert first["status"] == "running"
    assert second["status"] == "done"
    assert not list((jobs_root / "job-atomic").glob("*.tmp"))
