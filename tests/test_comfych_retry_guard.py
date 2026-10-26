# ─────────────────────────────────────────────────────────────────────────
# ComfyCH — garde-fou ANTI-RETRY-INFINI côté gateway (``tools/comfych/__init__.py``).
#
# Log réel de ``modal run sync.py --sync-custom-nodes`` (container qui plante à
# l'import) :
#
#     Runner failed with exception …
#     … toujours en cours (66s) (76s) (86s) (96s) (108s) (118s)
#
# Le superviseur Modal relançait le container en boucle : coût GPU, log qui
# n'explique rien, opération qui ne rend pas la main avant 30 min. L'échec est
# DÉTERMINISTE (module absent de l'image) : insister ne peut pas réussir.
#
# Ce que ce fichier verrouille (chaque point a son mutant) :
#   §1 ``_stream_process`` ABANDONNE après ``_RETRY_ABORT_THRESHOLD`` marqueurs
#      de retry — MUTANT « aucun abandon » → ROUGE ;
#   §2 un log normal (sans marqueur) n'abandonne JAMAIS ;
#   §3 ``_run_cmd`` TUE le subprocess et retourne 1 (pas d'attente du timeout
#      global de 30 min) — MUTANT « code 0 / attente » → ROUGE ;
#   §4 le message d'abandon dit quoi corriger (cause déterministe, module).
#
# Aucun test n'exécute la vraie CLI Modal : ``asyncio.create_subprocess_exec``
# et le process sont remplacés.
#
# Usage :
#   PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
#   pytest tests/test_comfych_retry_guard.py
# ─────────────────────────────────────────────────────────────────────────
import asyncio
import importlib.util
import sys
import types
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

import holaf_user_paths as aih_paths  # après le bootstrap sys.path

COMFYCH_DIR = PACKAGE_DIR / "tools" / "comfych"


# ---------------------------------------------------------------------------
# Chargement du module réel (faux ``server`` ComfyUI + arbre utilisateur jetable)
# ---------------------------------------------------------------------------
@pytest.fixture
def tree(tmp_path):
    """Fausse installation ComfyUI : le module écrit sa config dans ``user/``.

    Sans cette redirection, le chargement de ``tools/comfych/__init__.py``
    écrirait dans le VRAI dossier utilisateur (~/.config/comfyui/…).
    """
    comfy = tmp_path / "ComfyUI"
    pack = comfy / "custom_nodes" / "ComfyUI-AI-Helper"
    code = pack / "tools" / "comfych"
    code.mkdir(parents=True)
    user_root = comfy / "user" / "default" / "AI-Helper"
    user_root.mkdir(parents=True)
    return types.SimpleNamespace(comfy=comfy, pack=pack, code=code, user_root=user_root)


@pytest.fixture
def comfych(monkeypatch, tree):
    """Charge ``tools/comfych/__init__.py`` (aucune route montée)."""
    monkeypatch.setattr(aih_paths, "PACK_ROOT", str(tree.pack))
    monkeypatch.setenv(aih_paths.ENV_USER_ROOT, str(tree.user_root))
    monkeypatch.delenv(aih_paths.ENV_SKIP_MIGRATION, raising=False)

    class _Router:
        def add_route(self, method, path, handler):
            pass

    class _App:
        def __init__(self):
            self.router = _Router()
            self.middlewares = []

    class PromptServer:
        instance = None

        def __init__(self):
            self.app = _App()

        def add_routes(self):
            return "orig"

    server_module = types.ModuleType("server")
    server_module.PromptServer = PromptServer
    monkeypatch.setitem(sys.modules, "server", server_module)
    PromptServer.instance = PromptServer()

    spec = importlib.util.spec_from_file_location(
        "holaf_comfych_retry_under_test",
        COMFYCH_DIR / "__init__.py",
        submodule_search_locations=[str(COMFYCH_DIR)],
    )
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, "holaf_comfych_retry_under_test", module)
    spec.loader.exec_module(module)

    monkeypatch.setattr(module._store, "CODEFYCH_CODE_ROOT", tree.code)
    monkeypatch.setattr(
        module._store, "custom_nodes_dirs", lambda: [tree.comfy / "custom_nodes"]
    )
    return module


class _FakeStdout:
    """``process.stdout`` : lignes pré-définies (octets), puis EOF."""

    def __init__(self, lines):
        self.lines = list(lines)

    async def readline(self):
        if not self.lines:
            return b""
        return self.lines.pop(0).encode() + b"\n"


class _FakeProcess:
    def __init__(self, lines):
        self.stdout = _FakeStdout(lines)
        self.killed = False
        self.returncode = None

    def kill(self):
        self.killed = True

    async def wait(self):
        self.returncode = -9
        return self.returncode


# ═════════════ §1/§2. ``_stream_process`` : abandon vs log normal ═══════════


class TestStreamProcessAbort:
    def test_aborts_after_repeated_container_failures(self, comfych, tmp_path):
        """MUTANT « aucun abandon » : la boucle de retry ne s'arrête jamais."""
        log_path = tmp_path / "op.log"
        retry_line = "Runner failed with exception: ModuleNotFoundError"
        process = _FakeProcess([retry_line] * (comfych._RETRY_ABORT_THRESHOLD + 5))

        with pytest.raises(comfych._DeterministicContainerFailure) as excinfo:
            asyncio.run(comfych._stream_process(process, log_path))

        message = str(excinfo.value)
        assert str(comfych._RETRY_ABORT_THRESHOLD) in message
        assert "add_local_python_source" in message
        assert "déterministe" in message
        # Les lignes réellement reçues restent dans le log (diagnostic).
        assert retry_line in log_path.read_text(encoding="utf-8")

    def test_a_normal_log_never_aborts(self, comfych, tmp_path):
        log_path = tmp_path / "op.log"
        process = _FakeProcess([
            "Lancement de: modal run sync.py",
            "📦 Packaging des custom nodes…",
            "✅ Sync terminé : 30 node(s) sur le volume",
        ])

        asyncio.run(comfych._stream_process(process, log_path))

        text = log_path.read_text(encoding="utf-8")
        assert "30 node(s) sur le volume" in text
        assert "abandon" not in text

    def test_a_single_failure_marker_is_tolerated(self, comfych, tmp_path):
        """Un unique redémarrage (transitoire) ne doit PAS faire échouer le run."""
        log_path = tmp_path / "op.log"
        process = _FakeProcess(["Runner failed with exception: OOM", "✅ terminé"])

        asyncio.run(comfych._stream_process(process, log_path))

        assert "✅ terminé" in log_path.read_text(encoding="utf-8")


# ════════ §3/§4. ``_run_cmd`` : tue le process et renvoie 1 (échec rapide) ══


class TestRunCmdFailsFast:
    def test_run_cmd_kills_the_process_and_returns_failure(
        self, comfych, monkeypatch, tmp_path
    ):
        """MUTANT « on attend le timeout de 30 min » → ROUGE."""
        log_path = tmp_path / "op.log"
        process = _FakeProcess(
            ["Runner failed with exception: ModuleNotFoundError"] * 10
        )
        killed = []

        async def fake_create_subprocess_exec(*args, **kwargs):
            return process

        monkeypatch.setattr(
            comfych.asyncio, "create_subprocess_exec", fake_create_subprocess_exec
        )
        monkeypatch.setattr(comfych, "_OP_TIMEOUT_SECONDS", 3600.0)
        monkeypatch.setattr(
            comfych, "_kill_and_reap",
            lambda proc: _record_kill(proc, killed),
        )

        code = asyncio.run(comfych._run_cmd(["modal", "run", "sync.py"], log_path))

        assert code == 1, "un container qui plante à l'import doit sortir en échec"
        assert killed == [process], "le subprocess doit être tué, pas attendu"
        text = log_path.read_text(encoding="utf-8")
        assert "ERROR: abandon après" in text
        assert "add_local_python_source" in text


async def _record_kill(process, killed):
    killed.append(process)
    process.kill()
    await process.wait()
