"""Clé API masquée : jamais renvoyée, persistée, ni envoyée en Bearer.

BUG RÉEL (utilisateur) : le bouton « Copier » du panneau Compte copiait le
TEXTE de masquage (« Clé masquée — clique sur « Régénérer » pour en afficher
une nouvelle. ») placé dans la VALEUR du champ ; l'utilisateur l'a collé comme
clé API sur une nouvelle instance ComfyUI → connexion refusée (401) avec un
message incompréhensible.

Ce fichier verrouille le garde-fou COTÉ BACKEND du pack :

  1. ``aih.credentials.is_masked_api_key`` reconnaît les libellés de masquage
     (et NE confond PAS une vraie clé avec un masque) ;
  2. ``get_api_key()`` ignore une clé enregistrée qui est un masque → jamais
     de ``Authorization: Bearer`` avec le masque (rattrapage d'état) ;
  3. GET /aih/credentials ne renvoie JAMAIS le masque comme clé : valeur
     blanchie + ``api_key_masked: true`` (l'UI affiche l'avertissement) ;
  4. POST /aih/credentials REFUSE de persister un masque (400, message clair,
     fichier existant INTACT) ;
  5. une vraie clé reste acceptée (contrôle négatif : le garde-fou ne bloque
     pas les vraies clés).

Les handlers testés sont le CODE RÉEL de ``aih/routes.py``, extrait par AST
(fonctions imbriquées dans ``_register_credentials_group``) et servi par une
vraie app aiohttp. Le fichier de credentials pointe vers ``tmp_path``.

⚠️ Pas d'import du package ``aih`` complet : ``aih/credentials.py`` est chargé
par chemin (comme les tests existants chargent les modules du pack), ce qui
évite toute dépendance ComfyUI.
"""

import ast
import asyncio
import importlib.util
import json
import os
import sys
import traceback
from datetime import datetime
from pathlib import Path

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

PACKAGE_DIR = Path(__file__).resolve().parent.parent
ROUTES_FILE = PACKAGE_DIR / "aih" / "routes.py"
CREDENTIALS_FILE = PACKAGE_DIR / "aih" / "credentials.py"

MASK_FR = "Clé masquée — clique sur « Régénérer » pour en afficher une nouvelle."
MASK_FR_TYPO = "Clé masquée — clique sur « Regénérer » pour en afficher une nouvelle."
REAL_KEY = "aih_0123456789abcdef"


# ── Chargement du VRAI module aih/credentials.py (par chemin) ────────────


def _load_credentials_module():
    spec = importlib.util.spec_from_file_location("aih_credentials_mask_guard_test", CREDENTIALS_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _extract_functions(file_path, names, namespace):
    """Exécute le CODE RÉEL des handlers demandés (décorateurs retirés).

    Les routes credentials sont IMBRIQUÉES dans _register_credentials_group :
    on les retrouve par ast.walk (pas seulement tree.body).
    """
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
def credentials_mod(tmp_path, monkeypatch):
    """Module réel avec un fichier de credentials isolé dans tmp_path."""
    module = _load_credentials_module()
    monkeypatch.setattr(module, "_CREDENTIALS_PATH", str(tmp_path / "aih" / "credentials.json"))
    monkeypatch.setattr(module, "_CREDENTIALS_CACHE", None)
    return module


def _write_credentials(credentials_mod, payload):
    path = Path(credentials_mod.get_credentials_path())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    credentials_mod.invalidate_cache()
    return path


def _build_app(credentials_mod):
    """App aiohttp réelle : les handlers credentials extraits de routes.py."""
    ns = {
        "os": os,
        "json": json,
        "web": web,
        "datetime": datetime,
        "traceback": traceback,
        "credentials": credentials_mod,
    }
    _extract_functions(
        ROUTES_FILE,
        {"aih_get_credentials_route", "aih_save_credentials_route"},
        ns,
    )
    app = web.Application()
    app.router.add_get("/aih/credentials", ns["aih_get_credentials_route"])
    app.router.add_post("/aih/credentials", ns["aih_save_credentials_route"])
    return app


def _client_scenario(app, scenario):
    async def run():
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            await scenario(client)
        finally:
            await client.close()

    asyncio.run(run())


# ── 1. Reconnaissance des masques (et non-des-masques) ───────────────────


@pytest.mark.parametrize(
    "value",
    [
        MASK_FR,
        MASK_FR_TYPO,
        "Clé masquée",
        "clé MASQUÉE pour l'affichage",
        "Chargement...",
        "Loading...",
        "Erreur : pas de token",
        "placeholder",
        "hidden key",
        "clé indisponible",
        "Régénérer la clé",
        "No token",
    ],
)
def test_is_masked_api_key_detects_masking_labels(credentials_mod, value):
    assert credentials_mod.is_masked_api_key(value) is True


@pytest.mark.parametrize(
    "value",
    [
        "",
        "   ",
        None,
        REAL_KEY,
        "aih_real_0123456789",
        "terror123",          # « error » en sous-chaîne ≠ mot
        "my-aih-key",
        "0123456789abcdef",
    ],
)
def test_is_masked_api_key_does_not_flag_real_keys(credentials_mod, value):
    assert credentials_mod.is_masked_api_key(value) is False


# ── 2. get_api_key() ignore une clé enregistrée = masque (aucun Bearer) ──


def test_get_api_key_ignores_stored_mask(credentials_mod):
    _write_credentials(credentials_mod, {
        "api_key": MASK_FR,
        "server_url": "https://aih.holaf.fr",
    })
    assert credentials_mod.get_api_key() == "", \
        "une clé enregistrée qui est un masque ne doit JAMAIS être utilisée (Bearer)"
    # L'URL reste exploitable : un serveur « configure mais pas authentifie »
    # ne doit pas être presenté comme totalement absent.
    assert credentials_mod.get_api_url() == "https://aih.holaf.fr/api"


def test_get_api_key_returns_real_key(credentials_mod):
    _write_credentials(credentials_mod, {"api_key": REAL_KEY, "server_url": "https://aih.holaf.fr"})
    assert credentials_mod.get_api_key() == REAL_KEY, "une vraie clé reste utilisée telle quelle"


# ── 3. GET /aih/credentials ne renvoie jamais le masque comme clé ────────


def test_get_route_blanks_mask_and_flags_it(credentials_mod):
    _write_credentials(credentials_mod, {"api_key": MASK_FR, "server_url": "https://aih.holaf.fr"})
    app = _build_app(credentials_mod)

    async def scenario(client):
        resp = await client.get("/aih/credentials")
        assert resp.status == 200
        data = await resp.json()
        assert data["status"] == "ok"
        assert data["api_key"] == "", "le masque ne doit jamais être renvoyé comme clé"
        assert data["api_key_masked"] is True, "l'UI doit pouvoir avertir (drapeau)"
        assert data["server_url"] == "https://aih.holaf.fr"

    _client_scenario(app, scenario)


def test_get_route_returns_real_key_without_flag(credentials_mod):
    _write_credentials(credentials_mod, {"api_key": REAL_KEY, "server_url": "https://aih.holaf.fr"})
    app = _build_app(credentials_mod)

    async def scenario(client):
        resp = await client.get("/aih/credentials")
        data = await resp.json()
        assert data["api_key"] == REAL_KEY
        assert data["api_key_masked"] is False

    _client_scenario(app, scenario)


# ── 4. POST /aih/credentials refuse le masque et ne l'écrit jamais ───────


def test_post_route_refuses_mask_and_does_not_create_file(credentials_mod):
    app = _build_app(credentials_mod)

    async def scenario(client):
        resp = await client.post("/aih/credentials", json={
            "api_key": MASK_FR,
            "server_url": "https://aih.holaf.fr",
        })
        assert resp.status == 400, "un masque doit être refusé (400), jamais persisté"
        data = await resp.json()
        assert data["status"] == "error"
        assert "masquage" in data["message"], "message clair pour l'utilisateur"
        path = Path(credentials_mod.get_credentials_path())
        assert not path.exists() or MASK_FR not in path.read_text(encoding="utf-8"), \
            "le masque ne doit apparaître nulle part dans le fichier"

    _client_scenario(app, scenario)


def test_post_route_mask_does_not_overwrite_existing_real_key(credentials_mod):
    path = _write_credentials(credentials_mod, {"api_key": REAL_KEY, "server_url": "https://aih.holaf.fr"})
    app = _build_app(credentials_mod)

    async def scenario(client):
        resp = await client.post("/aih/credentials", json={
            "api_key": MASK_FR_TYPO,
            "server_url": "https://evil.example",
        })
        assert resp.status == 400
        # Le fichier existant reste INTACT (ni clé, ni URL écrasées).
        assert credentials_mod.get_api_key() == REAL_KEY
        assert json.loads(path.read_text(encoding="utf-8"))["server_url"] == "https://aih.holaf.fr"

    _client_scenario(app, scenario)


def test_post_route_accepts_real_key(credentials_mod):
    app = _build_app(credentials_mod)

    async def scenario(client):
        resp = await client.post("/aih/credentials", json={
            "api_key": REAL_KEY,
            "server_url": "https://aih.holaf.fr",
        })
        assert resp.status == 200, "une vraie clé doit être acceptée (pas de sur-blocage)"
        data = await resp.json()
        assert data["status"] == "ok"
        assert credentials_mod.get_api_key() == REAL_KEY
        path = Path(credentials_mod.get_credentials_path())
        assert REAL_KEY in path.read_text(encoding="utf-8")

    _client_scenario(app, scenario)


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
