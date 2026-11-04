# ─────────────────────────────────────────────────────────────────────────
# ComfyCH — logs exploitables + ComfyUI-Manager réellement retiré du worker.
#
# Deux défauts constatés en production, tous deux « silencieux » :
#
#  1. LOGS SANS HORODATAGE : impossible de savoir si une ligne vient du run en
#     cours ou d'un run précédent, ni quand un run est mort. Aggravé par le fait
#     que le worker n'écrivait son statut que dans le log de COMfyUI (invisible
#     depuis ``modal app logs``) ou seulement sur stdout (invisible depuis l'UI).
#     → chaque ligne ComfyCH porte ``…T13:21:07.412Z [job 7f3a2c] …``, les deux
#     destinations sont écrites, et un CHIEN DE GARDE dit « aucune progression
#     depuis N s (dernière étape X/Y) » + la raison de la mort du run.
#
#  2. « NODE MARQUÉ À SUPPRIMER » JAMAIS SUPPRIMÉ : ``comfy install`` pose
#     ComfyUI-Manager **par défaut** (option inverse ``--skip-manager``), donc il
#     était cuit dans l'IMAGE ; le sync poussait en plus le dossier local sur le
#     volume. Supprimer le node localement ne changeait donc rien — d'où le
#     traceback ``manager_core.InvalidChannel`` à chaque démarrage.
#
# Ce que ce fichier verrouille (chaque point a son mutant) :
#   §1 horodatage UTC ISO 8601 + identifiant de run court sur CHAQUE ligne, et
#      écriture dans le log lu par l'UI — MUTANT « print() sans horodatage »,
#      « pas de run id », « écrit seulement sur stdout » → ROUGE ;
#   §2 marqueur de démarrage (build + version ComfyUI + spawn+polling + timeout)
#      — MUTANT « marqueur retiré » → ROUGE ;
#   §3 raison de la mort du run : ``CancelledError`` est journalisée et le
#      manifeste ne reste plus « running » à vie — MUTANT « annulation avalée »
#      → ROUGE ;
#   §4 chien de garde : absence de progression journalisée avec l'étape et
#      l'horodatage — MUTANT « chien de garde muet » → ROUGE ;
#   §5 ComfyUI-Manager retiré (image ET volume), idempotent, une seule ligne de
#      log — MUTANT « nettoyage retiré » / « node toujours lié » → ROUGE ;
#   §6 l'exclusion est APPLIQUÉE aussi côté sync (l'intention « à supprimer »
#      arrive jusqu'à l'archive) — MUTANT « sync ignore la liste » → ROUGE ;
#   §7 `--skip-manager` dans le build (l'image ne le recrée plus).
#
# Usage :
#   PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
#   pytest tests/test_comfych_logs_and_manager.py
# ─────────────────────────────────────────────────────────────────────────
import asyncio
import importlib.util
import re
import sys
import types
from pathlib import Path
from typing import ClassVar

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
COMFYCH_DIR = PACKAGE_DIR / "tools" / "comfych"
WORKER_FILE = COMFYCH_DIR / "workers" / "base_worker.py"
SYNC_FILE = COMFYCH_DIR / "sync.py"
IMAGE_FILE = COMFYCH_DIR / "image.py"

ISO_UTC_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
LINE_RE = re.compile(
    r"^(?P<stamp>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) "
    r"\[job (?P<job>[A-Za-z0-9_-]+)\] \[ComfyCH\] (?P<msg>.*)$"
)


# ---------------------------------------------------------------------------
# Stubs `modal` / `httpx` (paquets pip absents en test)
# ---------------------------------------------------------------------------
def _decorator(*args, **kwargs):
    if len(args) == 1 and callable(args[0]) and not kwargs:
        return args[0]

    def wrap(fn):
        return fn

    return wrap


class _FakeVolume:
    @classmethod
    def from_name(cls, *a, **k):
        return cls()

    def commit(self):
        return None


class _FakeResponse:
    def __init__(self, status_code=200, payload=None, content=b"", headers=None):
        self.status_code = status_code
        self._payload = payload
        self.content = content
        self.headers = headers or {"content-type": "image/png"}
        self.text = "{}" if payload is None else "payload"

    def json(self):
        return self._payload


class _FakeAsyncClient:
    handler: ClassVar = None
    calls: ClassVar[list] = []

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, url, **kwargs):
        type(self).calls.append(("GET", url, kwargs))
        return await type(self).handler("GET", url, kwargs)

    async def post(self, url, **kwargs):
        type(self).calls.append(("POST", url, kwargs))
        return await type(self).handler("POST", url, kwargs)


def _module(name, **attrs):
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    return module


@pytest.fixture(scope="module")
def worker_module():
    """Charge ``base_worker.py`` avec des stubs ``modal``/``httpx``."""
    saved = {n: sys.modules.get(n) for n in ("modal", "httpx")}
    modal_stub = _module(
        "modal",
        Volume=_FakeVolume,
        method=lambda *a, **k: _decorator(*a, **k),
        enter=lambda *a, **k: _decorator(*a, **k),
        exit=lambda *a, **k: _decorator(*a, **k),
        concurrent=lambda *a, **k: _decorator(*a, **k),
    )
    httpx_stub = _module(
        "httpx",
        AsyncClient=_FakeAsyncClient,
        HTTPError=type("HTTPError", (Exception,), {}),
    )
    sys.modules["modal"] = modal_stub
    sys.modules["httpx"] = httpx_stub
    try:
        spec = importlib.util.spec_from_file_location(
            "comfych_base_worker_logs_under_test", WORKER_FILE
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        yield module
    finally:
        sys.modules.pop("comfych_base_worker_logs_under_test", None)
        for name, previous in saved.items():
            if previous is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous


@pytest.fixture
def log_env(tmp_path, worker_module, monkeypatch):
    """Redirige le log ComfyUI, le store de jobs et les volumes vers tmp."""
    log_path = tmp_path / "logs" / "comfyui.log"
    jobs_root = tmp_path / "jobs"
    jobs_root.mkdir()
    comfy_custom = tmp_path / "ComfyUI" / "custom_nodes"
    comfy_custom.mkdir(parents=True)
    volume = tmp_path / "volume_custom_nodes"
    volume.mkdir()
    monkeypatch.setattr(worker_module, "COMFY_LOG_PATH", log_path)
    monkeypatch.setattr(worker_module, "JOBS_VOLUME_DIR", jobs_root)
    monkeypatch.setattr(worker_module, "COMFY_CUSTOM_NODES_DIR", comfy_custom)
    monkeypatch.setattr(worker_module, "CUSTOM_NODES_VOLUME_PATH", volume)
    return types.SimpleNamespace(
        log=log_path, jobs=jobs_root, custom_nodes=comfy_custom, volume=volume
    )


# ---------------------------------------------------------------------------
# Chargement du module réel ``sync.py`` (le paquet pip ``modal`` est absent)
# ---------------------------------------------------------------------------
class _FakeImage:
    def add_local_python_source(self, *a, **k):
        return self

    def apt_install(self, *a, **k):
        return self

    def pip_install(self, *a, **k):
        return self


class _SyncVolume:
    @classmethod
    def from_name(cls, *a, **k):
        return cls()

    def commit(self):
        return None

    def batch_upload(self, *a, **k):
        raise AssertionError("aucun upload attendu ici")


class _SyncApp:
    def __init__(self, *a, **k):
        pass

    def function(self, *a, **k):
        return lambda fn: fn

    def local_entrypoint(self, *a, **k):
        return lambda fn: fn


class _SyncSecret:
    def hydrate(self):
        return None


@pytest.fixture
def sync_module(monkeypatch, tmp_path):
    """Charge ``sync.py`` avec des stubs ``modal``/``helpers``/``models``."""
    saved = {
        name: sys.modules.pop(name)
        for name in ("comfych_paths", "helpers", "models", "comfych_store")
        if name in sys.modules
    }
    try:
        modal_stub = types.ModuleType("modal")
        modal_stub.Image = types.SimpleNamespace(debian_slim=lambda **k: _FakeImage())
        modal_stub.App = _SyncApp
        modal_stub.Volume = _SyncVolume
        modal_stub.Secret = types.SimpleNamespace(
            from_name=lambda *a, **k: _SyncSecret(),
            from_dict=lambda *a, **k: _SyncSecret(),
        )
        modal_stub.exception = types.SimpleNamespace(NotFoundError=RuntimeError)
        monkeypatch.setitem(sys.modules, "modal", modal_stub)

        helpers_stub = types.ModuleType("helpers")
        helpers_stub.download_external_model = lambda *a, **k: None
        helpers_stub.get_hf_secrets = list
        helpers_stub.hf_download = lambda *a, **k: None
        helpers_stub.resolve_model_dir = lambda name: tmp_path / str(name)
        monkeypatch.setitem(sys.modules, "helpers", helpers_stub)
        models_stub = types.ModuleType("models")
        models_stub.models = []
        models_stub.models_ext = []
        monkeypatch.setitem(sys.modules, "models", models_stub)
        store_stub = types.ModuleType("comfych_store")
        store_stub.config_path = lambda: tmp_path / "config.json"
        monkeypatch.setitem(sys.modules, "comfych_store", store_stub)

        spec = importlib.util.spec_from_file_location(
            "comfych_sync_logs_test", SYNC_FILE
        )
        module = importlib.util.module_from_spec(spec)
        monkeypatch.setitem(sys.modules, "comfych_sync_logs_test", module)
        spec.loader.exec_module(module)
        yield module
    finally:
        for name in ("comfych_paths", "helpers", "models", "comfych_store"):
            sys.modules.pop(name, None)
        sys.modules.update(saved)


# ═════════════════ §1. Horodatage + identifiant de run ═════════════════


class TestTimestampedLogs:
    def test_stamp_is_iso8601_utc_with_milliseconds(self, worker_module):
        stamp = worker_module.utc_stamp(1700000000.123)
        assert ISO_UTC_RE.match(stamp), stamp
        assert stamp.endswith("Z"), "l'horodatage doit être en UTC explicite"

    def test_short_job_id_is_stable_and_short(self, worker_module):
        tagged = worker_module.short_job_id("req-9f3a2c1b")
        assert tagged == "3a2c1b", tagged
        assert worker_module.short_job_id("req-9f3a2c1b") == tagged
        assert worker_module.short_job_id("") == "-"
        # Deux runs distincts ne doivent JAMAIS partager le préfixe (sinon le
        # log ne permet pas de séparer deux rendus du batch).
        assert worker_module.short_job_id("req-aaaaaa1") != worker_module.short_job_id(
            "req-bbbbbb2"
        )

    def test_log_line_carries_stamp_and_run_id(self, worker_module, log_env):
        """MUTANT « print() sans horodatage » / « pas de run id » → ROUGE."""
        line = worker_module.comfych_log("run DÉMARRÉ", "req-9f3a2c1b")

        match = LINE_RE.match(line)
        assert match, line
        assert match.group("job") == "3a2c1b"
        assert match.group("msg") == "run DÉMARRÉ"

    def test_log_line_reaches_the_ui_log_file(self, worker_module, log_env):
        """MUTANT « écrit seulement sur stdout » → l'UI ne voit rien → ROUGE.

        Le log consultable depuis le pack est ``COMFY_LOG_PATH`` (stdout de
        ComfyUI redirigée) : un ``print()`` seul n'y apparaît pas.
        """
        worker_module.comfych_log("bonjour", "req-1")

        content = log_env.log.read_text()
        assert "bonjour" in content
        assert "[job " in content
        assert ISO_UTC_RE.match(content.strip().splitlines()[-1].split(" ")[0])


# ═════════════════ §2. Marqueur de version au démarrage ═════════════════


class TestStartupBanner:
    def test_banner_has_build_comfy_version_and_feature_flag(self, worker_module):
        banner = worker_module.job_api_banner("0.3.61")
        assert "worker build" in banner
        assert worker_module.WORKER_BUILD_ID in banner
        assert "ComfyUI 0.3.61" in banner
        assert "spawn+polling=on" in banner
        assert "timeout=" in banner

    def test_comfy_version_is_read_from_the_installed_tree(
        self, worker_module, tmp_path
    ):
        tree = tmp_path / "tree"
        tree.mkdir()
        version_file = tree / "comfyui_version.py"
        version_file.write_text('__version__ = "0.3.62"\n')
        assert (
            worker_module.comfyui_version(version_file=version_file, root=tree)
            == "0.3.62"
        )
        # Rien de lisible → « inconnu », jamais une exception (le démarrage ne
        # doit pas dépendre d'un log de version).
        empty = tmp_path / "empty"
        empty.mkdir()
        assert (
            worker_module.comfyui_version(
                version_file=empty / "absent.py", root=empty
            )
            == "inconnu"
        )


# ═════════════════ §3. Raison de la mort du run ═════════════════


def _prompt_handler(polls_before_done=1):
    state = {"polls": 0}

    async def handler(method, url, kwargs):
        if url.endswith("/prompt"):
            return _FakeResponse(200, {"prompt_id": "pid-1"})
        if "/history/" in url:
            state["polls"] += 1
            if state["polls"] <= polls_before_done:
                return _FakeResponse(200, {})
            return _FakeResponse(200, {"pid-1": {"outputs": {}}})
        if url.endswith("/progress"):
            return _FakeResponse(200, {"value": 2, "max": 8, "node": 12})
        if url.endswith("/view"):
            return _FakeResponse(404, {})
        return _FakeResponse(404, {})

    return handler


class TestDeathReason:
    def test_cancelled_run_is_logged_and_not_left_running(
        self, worker_module, log_env, monkeypatch
    ):
        """MUTANT « annulation avalée » → log muet + manifeste « running » à vie."""
        seen = {}

        async def handler(method, url, kwargs):
            if url.endswith("/prompt"):
                return _FakeResponse(200, {"prompt_id": "pid-annule"})
            if "/history/" in url:
                # Le conteneur est arrêté pendant le rendu.
                seen["cancelled"] = True
                raise asyncio.CancelledError()
            return _FakeResponse(200, {})

        monkeypatch.setattr(_FakeAsyncClient, "handler", staticmethod(handler))
        monkeypatch.setattr(worker_module, "JOB_POLL_INTERVAL_SECONDS", 0.01)

        with pytest.raises(asyncio.CancelledError):
            asyncio.run(worker_module.ComfyWorker().run_job({"1": {}}, "run-annule"))

        content = log_env.log.read_text()
        assert "run ANNULÉ" in content, content
        assert re.search(r"run ANNULÉ.*entrée Modal annulée", content), content
        # Le manifeste ne doit PAS rester « running » (sinon le gateway attend
        # jusqu'au budget d'une heure avant de déclarer le job perdu).
        import json

        state = json.loads((log_env.jobs / "run-annule" / "manifest.json").read_text())
        assert state["status"] == "failed", state
        assert "annulé" in state["error"], state


# ═════════════════ §4. Chien de garde (progression) ═════════════════


class TestProgressWatchdog:
    def test_stall_is_logged_with_step_and_timestamp(
        self, worker_module, log_env, monkeypatch
    ):
        """MUTANT « chien de garde muet » → le log s'arrête net, sans raison."""
        monkeypatch.setattr(_FakeAsyncClient, "handler", staticmethod(_prompt_handler()))
        monkeypatch.setattr(worker_module, "JOB_WATCHDOG_INTERVAL_SECONDS", 0.01)
        monkeypatch.setattr(worker_module, "JOB_STALL_WARN_SECONDS", 0.02)
        monkeypatch.setattr(worker_module, "JOB_POLL_INTERVAL_SECONDS", 0.01)

        import time as real_time

        class _SlowClock:
            """Horloge qui avance très lentement : la progression est figée."""

            def __init__(self):
                self.now = 1000.0

            def time(self):
                # Chaque lecture avance d'UNE seconde : le silence franchit
                # vite le seuil, sans faire durer le test.
                self.now += 1.0
                return self.now

            def __getattr__(self, name):
                # strftime/gmtime/... viennent du vrai module (horodatage).
                return getattr(real_time, name)

        monkeypatch.setattr(worker_module, "time", _SlowClock())

        async def run():
            task = asyncio.create_task(
                worker_module.ComfyWorker()._watch_progress("run-bloque", "pid-42")
            )
            await asyncio.sleep(0.3)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        asyncio.run(run())

        content = log_env.log.read_text()
        assert "aucune progression depuis" in content, content
        assert "2/8" in content, content
        assert "pid-42" in content, content
        line = [ln for ln in content.splitlines() if "aucune progression" in ln][0]
        assert LINE_RE.match(line), line


# ═════════════════ §5. ComfyUI-Manager retiré (volume ET image) ═════════════════


class TestManagerRemoval:
    def test_disabled_default_contains_manager(self, worker_module, monkeypatch):
        monkeypatch.delenv(worker_module.DISABLED_NODES_ENV, raising=False)
        assert "comfyui-manager" in worker_module.disabled_node_names()
        # Variable vide = échappatoire explicite (plus rien de désactivé).
        monkeypatch.setenv(worker_module.DISABLED_NODES_ENV, "")
        assert worker_module.disabled_node_names() == set()
        monkeypatch.setenv(worker_module.DISABLED_NODES_ENV, "Foo, BAR")
        assert worker_module.disabled_node_names() == {"foo", "bar"}

    def test_manager_is_unlinked_from_volume_and_removed_from_image(
        self, worker_module, log_env, monkeypatch
    ):
        """MUTANT « nettoyage retiré » → le node revient à chaque run."""
        monkeypatch.delenv(worker_module.DISABLED_NODES_ENV, raising=False)
        # 1. Le node est sur le VOLUME (donc re-symlinké à chaque démarrage).
        (log_env.volume / "ComfyUI-Manager").mkdir()
        (log_env.volume / "ComfyUI-GGUF").mkdir()
        # 2. Le node est aussi dans l'IMAGE (``comfy install`` par défaut).
        image_copy = log_env.custom_nodes / "ComfyUI-Manager"
        image_copy.mkdir()
        (image_copy / "manager_core.py").write_text("# bruit\n")

        linked = worker_module.ComfyWorker()._sync_custom_nodes_from_volume()

        assert not image_copy.exists(), "la copie de l'IMAGE doit être supprimée"
        assert not (log_env.custom_nodes / "ComfyUI-Manager").exists()
        assert (log_env.custom_nodes / "ComfyUI-GGUF").is_symlink(), (
            "les autres nodes doivent continuer à être liés"
        )
        assert linked == 1
        content = log_env.log.read_text()
        assert "removed residual custom node: ComfyUI-Manager" in content, content
        # Une seule ligne de bruit pour ce node : le nettoyage est idempotent.
        assert content.count("removed residual custom node") == 1

    def test_cleanup_is_idempotent(self, worker_module, log_env, monkeypatch):
        """Un second démarrage ne doit plus rien logger (déjà propre)."""
        monkeypatch.delenv(worker_module.DISABLED_NODES_ENV, raising=False)
        worker = worker_module.ComfyWorker()
        worker._sync_custom_nodes_from_volume()
        before = log_env.log.read_text() if log_env.log.exists() else ""
        worker._sync_custom_nodes_from_volume()
        after = log_env.log.read_text() if log_env.log.exists() else ""
        assert after == before, "le nettoyage ne doit rien réécrire quand c'est propre"


# ═════════════════ §6/§7. L'intention « à supprimer » va jusqu'au sync ══════


class TestSyncAppliesTheRemoval:
    def test_sync_module_excludes_disabled_nodes(self, sync_module, tmp_path):
        """MUTANT « sync ignore la liste » → le node reste sur le volume.

        C'est le bug rapporté : le node était marqué « à supprimer » dans l'UI,
        la config était enregistrée, et le sync l'embarquait quand même (il ne
        lisait QUE le dossier local). Ici on vérifie le comportement réel de
        ``_select_node_dirs``, pas une présence de texte.
        """
        root = tmp_path / "ComfyUI" / "custom_nodes"
        root.mkdir(parents=True)
        for name in ("ComfyUI-Manager", "ComfyUI-GGUF"):
            node = root / name
            node.mkdir()
            (node / "__init__.py").write_text("# node\n", encoding="utf-8")

        kept, skipped = sync_module._select_node_dirs(root)

        kept_names = sorted(Path(d).name for d in kept)
        assert "ComfyUI-Manager" not in kept_names, kept_names
        assert "ComfyUI-GGUF" in kept_names, "les autres nodes doivent rester"
        reasons = {name: reason for name, reason in skipped}
        assert "ComfyUI-Manager" in reasons, reasons
        assert "désactivé" in reasons["ComfyUI-Manager"], reasons

    def test_disabled_list_is_overridable(self, sync_module, tmp_path, monkeypatch):
        """``COMFYCH_DISABLED_NODES`` REMPLACE la liste (pas de fusion)."""
        root = tmp_path / "ComfyUI" / "custom_nodes"
        root.mkdir(parents=True)
        for name in ("ComfyUI-Manager", "ComfyUI-GGUF"):
            node = root / name
            node.mkdir()
            (node / "__init__.py").write_text("# node\n", encoding="utf-8")

        monkeypatch.setenv(sync_module.DISABLED_NODES_ENV, "comfyui-gguf")
        kept, _skipped = sync_module._select_node_dirs(root)
        kept_names = sorted(Path(d).name for d in kept)
        assert kept_names == ["ComfyUI-Manager"], kept_names
        # Liste vide = plus rien de désactivé (échappatoire explicite).
        monkeypatch.setenv(sync_module.DISABLED_NODES_ENV, "")
        kept, _skipped = sync_module._select_node_dirs(root)
        assert len(kept) == 2

    def test_image_is_built_without_manager(self):
        """`comfy install` installe le Manager par défaut → `--skip-manager`."""
        source = IMAGE_FILE.read_text()
        assert "--skip-manager" in source, (
            "sans --skip-manager, ComfyUI-Manager est cuit dans l'image et "
            "revient à chaque container, quoi qu'on supprime localement"
        )
        assert "COMFYCH_INSTALL_MANAGER" in source, "échappatoire documentée"
