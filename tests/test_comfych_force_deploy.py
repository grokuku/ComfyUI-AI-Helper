# ─────────────────────────────────────────────────────────────────────────
# ComfyCH — « Forcer le déploiement » (anti « Deployment skipped »).
#
# Contexte : la CLI ``modal deploy`` N'A AUCUN flag ``--force``. Quand la
# définition de l'app n'a pas changé, Modal répond
#   ``✓ Deployment skipped: no changes detected! ⏭️``
# et l'image n'est JAMAIS reconstruite — les dépendances ajoutées (watchdog,
# cv2, gguf…) ne sont donc jamais installées dans l'image des workers.
#
# Le seul levier possible est de changer la définition de l'image : le build lit
# ``COMFYCH_DEPLOY_FORCE_TOKEN`` (tools/comfych/image.py, ``_force_token``) et
# régénère l'empreinte de déploiement. Cette variable est posée par la ROUTE
# pour le seul subprocess ``modal deploy`` (jamais pour les autres opérations,
# qui ne construisent pas d'image : une sync ne doit pas être « forcée »).
#
# Ce fichier verrouille :
#   §1 ``POST /api/modal/deploy`` sans corps → déploiement normal, aucun jeton
#      — MUTANT « jeton de forcage permanent » → rouge (rebuild à chaque fois) ;
#   §2 avec ``{"force": true}`` → jeton transmis au subprocess ``modal deploy``
#      — MUTANT « force ignoré » → rouge ;
#   §3 corps tolérant (``"true"``, ``false``, JSON invalide/absent) ;
#   §4 ``_cmd_step`` propage ``env_extra`` jusqu'à ``_run_cmd`` et l'ANNONCE
#      dans le log de déploiement ;
#   §5 ``_run_cmd`` injecte bien les variables dans l'environnement du
#      subprocess (c'est ce que lira ``image.py`` au build) ;
#   §6 la garde « opération déjà en cours » reste prioritaire (409, rien lancé).
#
# Aucune vraie CLI Modal n'est exécutée.
#
# Usage :
#   PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
#   pytest tests/test_comfych_force_deploy.py
# ─────────────────────────────────────────────────────────────────────────
import asyncio
import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

import holaf_user_paths as aih_paths  # après le bootstrap sys.path

COMFYCH_DIR = PACKAGE_DIR / "tools" / "comfych"
DEPLOY_PATH = "/api/modal/deploy"
FORCE_ENV = "COMFYCH_DEPLOY_FORCE_TOKEN"


# ---------------------------------------------------------------------------
# Chargement du module réel, avec un faux ``server`` de ComfyUI
# ---------------------------------------------------------------------------
@pytest.fixture
def tree(tmp_path):
    """Fausse installation ComfyUI : aucune écriture dans le vrai pack."""
    comfy = tmp_path / "ComfyUI"
    pack = comfy / "custom_nodes" / "ComfyUI-AI-Helper"
    code = pack / "tools" / "comfych"
    code.mkdir(parents=True)
    user_root = comfy / "user" / "default" / "AI-Helper"
    user_root.mkdir(parents=True)
    return types.SimpleNamespace(comfy=comfy, pack=pack, code=code, user_root=user_root)


@pytest.fixture
def comfych(monkeypatch, tree, tmp_path):
    """Module chargé (routes montées) sur une arborescence jetable."""
    monkeypatch.setattr(aih_paths, "PACK_ROOT", str(tree.pack))
    monkeypatch.setenv(aih_paths.ENV_USER_ROOT, str(tree.user_root))
    monkeypatch.delenv(aih_paths.ENV_SKIP_MIGRATION, raising=False)
    # Aucun jeton de forcage ne doit fuiter depuis l'environnement du test.
    monkeypatch.delenv(FORCE_ENV, raising=False)
    monkeypatch.delenv("COMFYCH_FORCE_DEPLOY", raising=False)

    routes = []

    class _Router:
        def add_route(self, method, path, handler):
            routes.append((method, path, handler))

    class _App:
        def __init__(self):
            self.router = _Router()
            self.middlewares = []

    class PromptServer:
        instance = None

        def __init__(self):
            self.app = _App()
            self.routes = []
            PromptServer.instance = self

        def add_routes(self):
            return "orig"

    server_module = types.ModuleType("server")
    server_module.PromptServer = PromptServer
    monkeypatch.setitem(sys.modules, "server", server_module)
    PromptServer()

    spec = importlib.util.spec_from_file_location(
        "holaf_comfych_force_under_test",
        COMFYCH_DIR / "__init__.py",
        submodule_search_locations=[str(COMFYCH_DIR)],
    )
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, "holaf_comfych_force_under_test", module)
    spec.loader.exec_module(module)

    monkeypatch.setattr(module._store, "CODEFYCH_CODE_ROOT", tree.code)
    monkeypatch.setattr(
        module._store, "custom_nodes_dirs", lambda: [tree.comfy / "custom_nodes"]
    )
    monkeypatch.setattr(module, "_log_path", lambda: tmp_path / "op.log")
    monkeypatch.setattr(module, "_status_path", lambda: tmp_path / "op.status")

    PromptServer.instance.add_routes()
    return module, routes


class _Request:
    """Requête minimale (le strict nécessaire pour les handlers testés)."""

    def __init__(self, body=None):
        self._body = body
        self.rel_url = types.SimpleNamespace(query={})
        self.headers = {"Host": "localhost:8188"}

    async def json(self):
        if self._body is None:
            raise ValueError("pas de corps JSON")
        return self._body


def _handler(routes, method, path):
    for route_method, route_path, handler in routes:
        if (route_method, route_path) == (method, path):
            return handler
    raise AssertionError(f"route absente : {method} {path}")


def _deploy_response(comfych, body=None):
    _module, routes = comfych
    response = asyncio.run(_handler(routes, "POST", DEPLOY_PATH)(_Request(body)))
    return response, json.loads(response.text)


@pytest.fixture
def spawned(monkeypatch, comfych):
    """Capture les appels à ``_spawn_op`` (aucune commande Modal lancée)."""
    module, _routes = comfych
    calls = []

    def _fake_spawn(operation, cmd, env_extra=None):
        calls.append({"operation": operation, "cmd": list(cmd), "env": dict(env_extra or {})})
        return True

    monkeypatch.setattr(module, "_spawn_op", _fake_spawn)
    return calls


# ---------------------------------------------------------------------------
# §1 Sans corps : déploiement NORMAL (aucun jeton de forcage)
# ---------------------------------------------------------------------------
def test_deploy_without_body_does_not_force(comfych, spawned):
    """MUTANT « jeton de forcage permanent » : rouge (rebuild à chaque clic).

    Le forcage doit rester EXPLICITE : sans lui, un déploiement inchangé doit
    pouvoir être sauté par Modal (pas de reconstruction payée inutilement).
    """
    _response, payload = _deploy_response(comfych)

    assert payload["ok"] is True
    assert payload["force"] is False, payload
    assert len(spawned) == 1, spawned
    assert spawned[0]["operation"] == "deploy"
    assert spawned[0]["cmd"] == ["modal", "deploy", "apps/all_in_one.py"]
    assert FORCE_ENV not in spawned[0]["env"], spawned[0]["env"]


# ---------------------------------------------------------------------------
# §2 ``{"force": true}`` → jeton transmis au subprocess
# ---------------------------------------------------------------------------
def test_force_true_passes_a_force_token(comfych, spawned):
    """MUTANT « force ignoré » : rouge (l'image serait encore sautée)."""
    _response, payload = _deploy_response(comfych, {"force": True})

    assert payload["ok"] is True
    assert payload["force"] is True, payload
    assert len(spawned) == 1, spawned
    token = spawned[0]["env"].get(FORCE_ENV)
    assert token, f"jeton de forcage absent de l'environnement : {spawned[0]['env']}"
    assert len(token) >= 8, f"jeton trop faible : {token!r}"
    # La commande, elle, reste la même : c'est l'ENV qui change l'image.
    assert spawned[0]["cmd"] == ["modal", "deploy", "apps/all_in_one.py"]


def test_two_forces_use_distinct_tokens(comfych, spawned):
    """Deux clics « Forcer » → deux jetons : deux reconstructions distinctes."""
    _deploy_response(comfych, {"force": True})
    _deploy_response(comfych, {"force": True})
    tokens = [call["env"].get(FORCE_ENV) for call in spawned]
    assert len(tokens) == 2 and all(tokens), tokens
    assert tokens[0] != tokens[1], tokens


# ---------------------------------------------------------------------------
# §3 Corps tolérant
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("body", [None, {}, {"force": False}, {"force": 0}, ["pas", "un", "objet"]])
def test_body_without_force_flag_is_not_forced(comfych, spawned, body):
    _response, payload = _deploy_response(comfych, body)
    assert payload["force"] is False, (body, payload)
    assert spawned[0]["env"] == {}, spawned[0]["env"]


@pytest.mark.parametrize("value", [True, "true", "TRUE", "1", "yes", "on"])
def test_force_flag_accepts_string_forms(comfych, spawned, value):
    _response, payload = _deploy_response(comfych, {"force": value})
    assert payload["force"] is True, (value, payload)
    assert spawned[0]["env"].get(FORCE_ENV), spawned[0]["env"]


# ---------------------------------------------------------------------------
# §4 ``_cmd_step`` propage l'env et l'annonce dans le log
# ---------------------------------------------------------------------------
def test_cmd_step_forwards_env_to_run_cmd(comfych, monkeypatch, tmp_path):
    """MUTANT « env perdu en route » : rouge (force sans effet au build)."""
    module, _routes = comfych
    seen = {}

    async def _fake_run_cmd(cmd, log_path, started_at=None, env_extra=None):
        seen["cmd"] = list(cmd)
        seen["env"] = dict(env_extra or {})
        return 0

    monkeypatch.setattr(module, "_run_cmd", _fake_run_cmd)
    log_path = tmp_path / "step.log"
    log_path.write_text("")

    label, runner = module._cmd_step(
        "deploy", ["modal", "deploy", "apps/all_in_one.py"], {FORCE_ENV: "jeton-xyz"}
    )
    code = asyncio.run(runner(log_path, 0.0))

    assert code == 0
    assert label == "deploy"
    assert seen["env"] == {FORCE_ENV: "jeton-xyz"}, seen
    assert runner.env_extra == {FORCE_ENV: "jeton-xyz"}
    text = log_path.read_text(encoding="utf-8")
    assert "Reconstruction FORCÉE" in text, text


def test_cmd_step_without_force_is_silent(comfych, monkeypatch, tmp_path):
    """Sans forcage, le log ne prétend rien forcer (pas de faux positif)."""
    module, _routes = comfych

    async def _fake_run_cmd(cmd, log_path, started_at=None, env_extra=None):
        return 0

    monkeypatch.setattr(module, "_run_cmd", _fake_run_cmd)
    log_path = tmp_path / "step.log"
    log_path.write_text("")

    _label, runner = module._cmd_step("deploy", ["modal", "deploy", "apps/all_in_one.py"])
    asyncio.run(runner(log_path, 0.0))
    assert "Reconstruction FORCÉE" not in log_path.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# §5 ``_run_cmd`` injecte l'env dans le subprocess
# ---------------------------------------------------------------------------
def test_run_cmd_injects_env_extra(comfych, monkeypatch, tmp_path):
    """MUTANT « variable jamais posée » : rouge.

    ``image.py`` lit ``COMFYCH_DEPLOY_FORCE_TOKEN`` dans l'environnement du
    process qui importe l'app : la variable doit donc être posée sur le
    subprocess ``modal deploy``.
    """
    module, _routes = comfych
    captured = {}

    class _FakeProcess:
        returncode = 0

        def __init__(self):
            self.stdout = self

        async def readline(self):
            return b""

        async def wait(self):
            return 0

        def kill(self):  # pragma: no cover - jamais appelé ici
            pass

    async def _fake_create(*cmd, **kwargs):
        captured["cmd"] = cmd
        captured["env"] = kwargs.get("env") or {}
        return _FakeProcess()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fake_create)
    log_path = tmp_path / "run.log"
    log_path.write_text("")

    code = asyncio.run(
        module._run_cmd(
            ["modal", "deploy", "apps/all_in_one.py"],
            log_path,
            0.0,
            {FORCE_ENV: "jeton-subprocess"},
        )
    )

    assert code == 0
    assert captured["env"].get(FORCE_ENV) == "jeton-subprocess", captured["env"]
    assert captured["cmd"] == ("modal", "deploy", "apps/all_in_one.py"), captured["cmd"]


# ---------------------------------------------------------------------------
# §6 La garde « opération déjà en cours » reste prioritaire
# ---------------------------------------------------------------------------
def test_force_still_respects_the_busy_slot(comfych, monkeypatch):
    """Une opération en cours → 409, même pour un déploiement forcé."""
    module, _routes = comfych
    monkeypatch.delenv(FORCE_ENV, raising=False)

    assert module._try_acquire_op("sync") is True
    try:
        response, payload = _deploy_response(comfych, {"force": True})
        assert response.status == 409, payload
        assert payload["ok"] is False, payload
        assert payload["operation"] == "sync", payload
    finally:
        module._release_op()
