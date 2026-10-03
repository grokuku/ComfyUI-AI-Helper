"""Barrière SERVEUR de l'accès shell Blobby (POST /aih/blobby/exec).

Le pack n'a AUCUNE authentification applicative (protection en amont par le
reverse-proxy). La route d'exécution shell doit néanmoins REFUSER d'exécuter
tant que l'accès shell n'a pas été explicitement autorisé — état persisté
côté serveur dans ``blobby.json`` (clé ``blobbyShellAccess``), publié par le
companion via POST /aih/blobby/save.

Ce fichier verrouille :
  1. ``_blobby_shell_access_enabled`` : strict (``is True``), fail-closed
     (fichier absent/corrompu, clé absente/fausse ou non booléenne ⇒ False) ;
  2. POST /aih/blobby/exec REFUSE (403 ``shell_forbidden``) sans autorisation,
     y compris en appel DIRECT (aucune barrière front supposée) — et la
     commande n'est PAS exécutée (preuve : fichier sentinelle non créé) ;
  3. une autorisation persistée (POST /aih/blobby/save) rend l'exécution
     possible (contrôle négatif in-suite : la seule différence est l'état) ;
  4. le plafond dur de 15 s reste présent (statique).

Les handlers testés sont le CODE RÉEL de ``aih/routes.py``, extrait par AST et
servi par une vraie app aiohttp ; ``blobby.json`` pointe vers ``tmp_path``.

⚠️ Pas d'import du package ``aih`` complet (évite la dépendance ComfyUI) :
``folder_paths`` est simulé via ``sys.modules``.
"""

import ast
import asyncio
import json
import logging
import os
import sys
import types
from pathlib import Path

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

PACKAGE_DIR = Path(__file__).resolve().parent.parent
ROUTES_FILE = PACKAGE_DIR / "aih" / "routes.py"


def _extract_functions(file_path, names, namespace):
    """Exécute le CODE RÉEL des handlers demandés (décorateurs retirés)."""
    tree = ast.parse(Path(file_path).read_text(encoding="utf-8"))
    picked = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names:
            node.decorator_list = []
            picked.append(node)
    found = {node.name for node in picked}
    assert found == set(names), f"fonctions introuvables dans {file_path}: {set(names) - found}"
    module = ast.Module(body=picked, type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), str(file_path), "exec"), namespace)
    return namespace


@pytest.fixture
def blobby_ns(tmp_path, monkeypatch):
    """Namespace des handlers + dossier user simulé (tmp_path)."""
    fake_folder_paths = types.ModuleType("folder_paths")
    fake_folder_paths.get_user_directory = lambda: str(tmp_path)
    monkeypatch.setitem(sys.modules, "folder_paths", fake_folder_paths)

    ns = {"os": os, "json": json, "web": web, "logging": logging}
    _extract_functions(
        ROUTES_FILE,
        {"aih_blobby_exec_route", "aih_blobby_save_route",
         "_blobby_shell_access_enabled", "_get_blobby_file"},
        ns,
    )
    ns["_tmp_path"] = tmp_path
    return ns


def _blobby_file(tmp_path):
    return tmp_path / "default" / "aih" / "blobby.json"


def _write_state(tmp_path, payload, raw=None):
    path = _blobby_file(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if raw is not None:
        path.write_text(raw, encoding="utf-8")
    else:
        path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _build_app(ns):
    app = web.Application()
    app.router.add_post("/aih/blobby/save", ns["aih_blobby_save_route"])
    app.router.add_post("/aih/blobby/exec", ns["aih_blobby_exec_route"])
    return app


async def _post(ns, path, payload):
    # App fraîche à chaque appel : chaque asyncio.run crée sa propre boucle
    # (l'état vit dans le fichier, pas dans l'objet Application).
    app = _build_app(ns)
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        resp = await client.post(path, json=payload)
        data = await resp.json()
        return resp.status, data
    finally:
        await client.close()


def _exec(ns, command):
    return asyncio.run(_post(ns, "/aih/blobby/exec", {"action": "shell", "command": command}))


def _save(ns, key, data):
    return asyncio.run(_post(ns, "/aih/blobby/save", {"key": key, "data": data}))


# ── 1. États fail-closed ─────────────────────────────────────────────────


def test_shell_access_disabled_when_file_missing(blobby_ns):
    assert blobby_ns["_blobby_shell_access_enabled"]() is False


def test_shell_access_strict_boolean_only(blobby_ns, tmp_path):
    # Seul le booléen JSON `true` autorise ; toute autre valeur est refusée.
    _write_state(tmp_path, {"blobbyShellAccess": "true"})
    assert blobby_ns["_blobby_shell_access_enabled"]() is False
    _write_state(tmp_path, {"blobbyShellAccess": 1})
    assert blobby_ns["_blobby_shell_access_enabled"]() is False
    _write_state(tmp_path, {"blobbyShellAccess": False})
    assert blobby_ns["_blobby_shell_access_enabled"]() is False
    _write_state(tmp_path, {"blobbyShellAccess": True})
    assert blobby_ns["_blobby_shell_access_enabled"]() is True


def test_shell_access_fail_closed_on_corrupt_file(blobby_ns, tmp_path):
    _write_state(tmp_path, None, raw="{ ceci n'est pas du JSON")
    assert blobby_ns["_blobby_shell_access_enabled"]() is False


# ── 2. Refus de la route sans autorisation + preuve de non-exécution ─────


def test_exec_refused_without_authorization_and_command_not_run(blobby_ns, tmp_path):
    sentinel = tmp_path / "pwned"
    status, data = _exec(blobby_ns, f"touch {sentinel}")
    assert status == 403, "sans autorisation : refus 403"
    assert data.get("ok") is False
    assert data.get("error") == "shell_forbidden", "code d'erreur structuré"
    assert not sentinel.exists(), "la commande n'a PAS été exécutée (fichier sentinelle absent)"


def test_exec_refused_when_state_explicitly_false(blobby_ns, tmp_path):
    _write_state(tmp_path, {"blobbyShellAccess": False})
    sentinel = tmp_path / "nope"
    status, data = _exec(blobby_ns, f"touch {sentinel}")
    assert status == 403
    assert data.get("ok") is False
    assert not sentinel.exists()


# ── 3. Autorisé quand l'état persisté l'explicite (contrôle négatif) ─────


def test_exec_allowed_when_state_true(blobby_ns, tmp_path):
    _write_state(tmp_path, {"blobbyShellAccess": True})
    status, data = _exec(blobby_ns, "echo hello")
    assert status == 200, "avec autorisation : exécution possible"
    assert data.get("ok") is True
    assert "hello" in (data.get("output") or "")


def test_persisted_state_via_save_route_enables_exec(blobby_ns, tmp_path):
    """Round-trip réel : POST save → état lu par la route exec."""
    # Tant que rien n'est persisté → refus.
    status, _ = _exec(blobby_ns, "echo x")
    assert status == 403
    # Persistance de l'autorisation via la route de sauvegarde du companion.
    s_status, s_data = _save(blobby_ns, "blobbyShellAccess", True)
    assert s_status == 200 and s_data.get("status") == "ok"
    assert json.loads(_blobby_file(tmp_path).read_text(encoding="utf-8"))["blobbyShellAccess"] is True
    # Maintenant l'exécution est autorisée.
    status, data = _exec(blobby_ns, "echo hello")
    assert status == 200 and data.get("ok") is True
    assert "hello" in (data.get("output") or "")


def test_exec_still_refuses_unknown_action_even_when_allowed(blobby_ns, tmp_path):
    _write_state(tmp_path, {"blobbyShellAccess": True})
    status, data = asyncio.run(_post(blobby_ns, "/aih/blobby/exec", {"action": "nope"}))
    assert status == 400
    assert data.get("ok") is False


# ── 4. Le plafond de 15 s reste (statique) ───────────────────────────────


def test_exec_keeps_15s_timeout():
    source = ROUTES_FILE.read_text(encoding="utf-8")
    assert "timeout=15" in source, "le plafond de 15 s de /aih/blobby/exec doit rester"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
