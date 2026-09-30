# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Contrat HTTP RÉEL de POST /api/aih/custom-nodes/install (Workflow Share).
#
# Le handler est monté tel quel (aih.routes._register_models_group) dans une
# app aiohttp et appelé par de VRAIES requêtes HTTP. On verrouille les DEUX
# formes de 400, qui n'ont PAS le même impact côté front :
#   - « déjà installé » : {"success": false, "message": "Node 'X' already
#     installed"} — NI "error" NI "detail" : la brique HolafFetch (qui ne lit
#     que body.error/detail pour son message) lève donc le message GÉNÉRIQUE
#     « erreur serveur (statut 400) », et c'est au front (installErrorMessage +
#     isAlreadyInstalledMessage) d'extraire err.data.message → skip bénin ;
#   - « git_url requis » : {"error": "git_url required"} — la brique le
#     remonte déjà comme message réel.
# Toute évolution du message « already installed » (casse comprise) casserait
# le filet de sécurité JS : ce test le détecte.
#
# Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
#         (sans aiohttp : test ignoré, jamais un faux PASS)

import asyncio
import sys
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

pytest.importorskip("aiohttp")

from aiohttp import ClientSession, web  # noqa: E402

from aih import custom_nodes_manager as cnm  # noqa: E402
from aih import routes as aih_routes  # noqa: E402


class _Recorder:
    """Shim décorateur : collecte les VRAIS handlers de _register_models_group.

    aiohttp 3.14 exige le handler explicite (formes décorateurs retirées) : on
    monte les handlers nous-mêmes, sans en modifier aucun.
    """

    def __init__(self):
        self.routes = []

    def _deco(self, method):
        def factory(path):
            def deco(handler):
                self.routes.append((method, path, handler))
                return handler
            return deco
        return factory

    def get(self, path):
        return self._deco("GET")(path)

    def post(self, path):
        return self._deco("POST")(path)


def _register(app):
    rec = _Recorder()
    aih_routes._register_models_group(rec)
    for method, path, handler in rec.routes:
        if method == "GET":
            app.router.add_get(path, handler)
        elif method == "POST":
            app.router.add_post(path, handler)
    return rec


async def _post_to_real_route(payload):
    """Monte l'app réelle, POST le payload, retourne (statut, json)."""
    app = web.Application()
    _register(app)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    try:
        async with ClientSession() as session:
            async with session.post(
                f"http://127.0.0.1:{port}/api/aih/custom-nodes/install", json=payload
            ) as resp:
                return resp.status, await resp.json(), resp.headers.get("Content-Type", "")
    finally:
        await runner.cleanup()


@pytest.fixture()
def custom_nodes_dir(tmp_path, monkeypatch):
    """Point le VRAI custom_nodes_manager sur un dossier temporaire."""
    monkeypatch.setattr(cnm, "_CUSTOM_NODES_DIR", str(tmp_path))
    return tmp_path


def test_already_installed_400_has_no_error_field(custom_nodes_dir):
    """400 réel « already installed » : message dans `message`, pas `error`.

    C'est CETTE forme qui fait dire à la brique « erreur serveur (statut 400) »
    et rend le filet JS (err.data.message + /already installed/i) obligatoire.
    """
    (custom_nodes_dir / "ComfyUI-Holaf").mkdir()

    status, data, content_type = asyncio.run(_post_to_real_route({
        "git_url": "https://github.com/Holaf/ComfyUI-Holaf",
        "name": "ComfyUI-Holaf",
    }))

    assert status == 400
    assert content_type.startswith("application/json")
    assert data == {
        "success": False,
        "message": "Node 'ComfyUI-Holaf' already installed",
    }
    # Ni error, ni detail : la brique ne peut PAS construire le message réel.
    assert "error" not in data and "detail" not in data
    # Le filet JS matche ce message (casse-insensible).
    assert "already installed" in data["message"].lower()


def test_missing_git_url_400_has_error_field(custom_nodes_dir):
    """400 « git_url required » : `error` présent → la brique le remonte déjà."""
    status, data, _ = asyncio.run(_post_to_real_route({"name": "X"}))
    assert status == 400
    assert data == {"error": "git_url required"}


def test_success_path_returns_200_with_path(custom_nodes_dir, monkeypatch):
    """Succès : le handler réel renvoie 200 {success, message, path}.

    Le clone git est monkeypatché (aucun réseau) : on verrouille le CONTRAT de
    réponse du chemin nominal, pas git.
    """

    def _fake_install(git_url, name=""):
        target = str(custom_nodes_dir / (name or "Repo"))
        Path(target).mkdir(exist_ok=True)
        return {"success": True, "message": f"Installed {name}.", "path": target}

    monkeypatch.setattr(cnm, "_install_custom_node", _fake_install)
    status, data, _ = asyncio.run(_post_to_real_route({
        "git_url": "https://github.com/x/Repo",
        "name": "Repo",
    }))
    assert status == 200
    assert data["success"] is True
    assert data["path"].endswith("Repo")
