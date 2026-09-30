"""Le pack ComfyUI-AI-Helper n'a AUCUNE authentification applicative.

Décision produit actée : « zéro mot de passe, sécurité uniquement par Caddy +
Authentik ». La barrière d'accès se fait EN AMONT du reverse-proxy devant
l'hôte ComfyUI ; le pack lui-même ne contient aucun mécanisme de mot de passe.
⚠️ Règle de déploiement : ne JAMAIS exposer le port 8188 directement.

Ce fichier verrouille :
  - l'absence des modules d'auth (holaf_auth.py, __main__.py) et de toute
    référence résiduelle dans le code du pack ;
  - l'absence de garde `require_auth` sur TOUTES les routes (balayage AST de
    __init__.py et aih/routes.py) ;
  - le WebSocket du terminal qui se connecte SANS aucun cookie ;
  - la CONSERVATION des protections non-auth (allow-list de config
    anti-injection, plafond 15 s de blobby/exec, refus des URLs git à
    identifiants, confinement des chemins).
"""

import ast
import asyncio
import importlib.util
import inspect
import os
import sys
import types
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
_PKG = "holaf_utils_pkg"


def _ensure_pkg():
    if _PKG not in sys.modules:
        pkg = types.ModuleType(_PKG)
        pkg.__path__ = [str(PACKAGE_DIR)]
        sys.modules[_PKG] = pkg


def _load_module(name):
    _ensure_pkg()
    spec = importlib.util.spec_from_file_location(f"{_PKG}.{name}", PACKAGE_DIR / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[f"{_PKG}.{name}"] = module
    spec.loader.exec_module(module)
    return module


# ── 1. Les modules d'auth ont disparu ───────────────────────────────────


def test_auth_modules_are_gone():
    assert not (PACKAGE_DIR / "holaf_auth.py").exists(), "holaf_auth.py doit être supprimé"
    assert not (PACKAGE_DIR / "__main__.py").exists(), "le CLI de hash doit être supprimé"
    assert not (PACKAGE_DIR / "js" / "holaf_auth.js").exists(), "js/holaf_auth.js doit être supprimé"


def test_config_has_no_password_or_session_secret():
    cfg = _load_module("holaf_config")
    loaded = cfg.load_all_configs()
    assert "password_hash" not in loaded, "plus de password_hash dans la config"
    assert "session_secret" not in loaded, "plus de session_secret dans la config"

    content = (PACKAGE_DIR / "config.ini").read_text(encoding="utf-8")
    assert "password" not in content.lower(), "config.ini ne doit contenir aucun mot de passe"
    assert "session_secret" not in content, "config.ini ne doit plus contenir de session_secret"


# ── 2. AUCUNE route n'est gardée (balayage AST) ─────────────────────────


def _auth_guard_symbols(tree):
    """Retourne les usages AST d'un garde d'auth (require_auth / guard)."""
    uses = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and node.attr == "require_auth":
            uses.append(("attribute", node.attr))
        if isinstance(node, ast.Name) and node.id in ("require_auth", "guard"):
            uses.append(("name", node.id))
        if isinstance(node, ast.Name) and node.id == "holaf_auth":
            uses.append(("name", node.id))
    return uses


@pytest.mark.parametrize("relpath", ["__init__.py", "aih/routes.py"])
def test_no_route_uses_auth_guard(relpath):
    tree = ast.parse((PACKAGE_DIR / relpath).read_text(encoding="utf-8"))
    uses = _auth_guard_symbols(tree)
    assert uses == [], f"{relpath} référence encore une garde d'auth : {uses}"


def test_aih_register_has_no_require_auth_parameter():
    if str(PACKAGE_DIR) not in sys.path:
        sys.path.insert(0, str(PACKAGE_DIR))
    from aih import routes
    params = inspect.signature(routes.register).parameters
    assert "require_auth" not in params, "register() ne doit plus accepter require_auth"
    assert not hasattr(routes, "_fail_closed_auth_guard"), "la garde fail-closed doit avoir disparu"


# ── 3. Aucune référence résiduelle dans le code du pack ─────────────────


AUTH_TOKENS = (
    "holaf_auth",
    "require_auth",
    "holaf_session",
    "session_secret",
    "ensureAuthenticated",
    "expireSession",
    "authFetch",
    "postAuthenticated",
    "withAuthRetry",
    "HolafAuth",
    "is_authenticated",
    "/holaf/auth",
    "password_hash",
)


def _pack_source_files():
    """Fichiers de CODE du pack (hors tests, briques vendor/ et app AI-Helper embarquée)."""
    files = []
    for pattern in ("*.py", "aih/*.py", "aih/**/*.py", "nodes/*.py", "nodes/**/*.py"):
        files.extend(PACKAGE_DIR.glob(pattern))
    for js in (PACKAGE_DIR / "js").rglob("*.js"):
        if "vendor" in js.parts or js.name.startswith("test_"):
            continue
        files.append(js)
    return sorted(set(files))


def test_no_residual_auth_reference_in_pack_source():
    offenders = []
    for path in _pack_source_files():
        text = path.read_text(encoding="utf-8", errors="replace")
        for token in AUTH_TOKENS:
            if token in text:
                offenders.append(f"{path.relative_to(PACKAGE_DIR)}: {token}")
    assert offenders == [], "références d'auth résiduelles :\n" + "\n".join(offenders)


def test_front_settings_and_nodes_have_no_auth():
    settings = (PACKAGE_DIR / "js" / "holaf_settings_manager.js").read_text(encoding="utf-8")
    assert "renderSecurityTab" not in settings, "l'onglet Sécurité doit être supprimé"
    assert '{ id: "security"' not in settings, "plus d'onglet 'security'"
    assert "changePassword" not in settings and "validatePasswordChange" not in settings

    nodes = (PACKAGE_DIR / "js" / "holaf_nodes_manager.js").read_text(encoding="utf-8")
    assert "holaf_auth.js" not in nodes and "ensureAuthenticated" not in nodes

    terminal = (PACKAGE_DIR / "js" / "holaf_terminal.js").read_text(encoding="utf-8")
    assert "holaf_auth.js" not in terminal and "authRequired" not in terminal


def test_i18n_has_no_auth_keys():
    strings = (PACKAGE_DIR / "js" / "aih_strings.js").read_text(encoding="utf-8")
    for key in ('"auth.', '"settings.security"', '"settings.change', '"term.authRequired"',
                '"bl.sessionRequired"', '"mma.sessionRequired"', '"mma.authCancelled"',
                '"mma.authRefused"'):
        assert key not in strings, f"clé i18n d'auth résiduelle : {key}"


# ── 4. WebSocket terminal SANS cookie (fonctionnel) ─────────────────────


def test_terminal_websocket_connects_without_cookie():
    """Le WS /holaf/terminal s'ouvre SANS cookie et reste ouvert sans I/O.

    On ouvre une vraie connexion WebSocket au handler (PTY /bin/sh réel) sans
    en-tête Cookie : aucun 401, aucun frame 'session-ended', la socket reste
    ouverte après une période silencieuse.
    """
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer

    if os.name == "nt":
        pytest.skip("PTY réel indisponible/testé uniquement sur POSIX")

    term = _load_module("holaf_terminal")
    config = {"shell_command": "/bin/sh"}
    app = web.Application()

    async def ws_route(request):
        return await term.websocket_handler(request, config)

    app.router.add_get("/holaf/terminal", ws_route)

    async def scenario():
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            # AUCUN cookie : la connexion doit réussir malgré tout.
            ws = await client.ws_connect("/holaf/terminal")
            assert ws.closed is False, "le WS doit s'ouvrir sans cookie"
            await asyncio.sleep(1.5)
            assert not ws.closed, "la session ne doit pas se fermer pendant l'inactivité"
            await ws.close()
        finally:
            await client.close()

    asyncio.run(scenario())


def test_terminal_websocket_has_no_stall_timeout_and_keepalive():
    source = (PACKAGE_DIR / "holaf_terminal.py").read_text(encoding="utf-8")
    assert "WebSocketResponse(heartbeat=" in source, "keepalive WebSocket attendu"
    assert "asyncio.wait(" in source and "timeout=300" not in source, \
        "aucun plafond de durée sur la session du terminal"


# ── 5. Protections NON-auth CONSERVÉES ──────────────────────────────────


def test_bulk_settings_still_blocks_terminal_and_security():
    """L'allow-list anti-injection reste verrouillée (aucun rapport avec un mot de passe)."""
    cfg = _load_module("holaf_config")
    assert "Terminal" in cfg.BLOCKED_BULK_SECTIONS
    assert "Security" in cfg.BLOCKED_BULK_SECTIONS
    assert "Terminal" not in cfg.ALLOWED_BULK_SECTIONS
    assert "Security" not in cfg.ALLOWED_BULK_SECTIONS


def test_blobby_exec_keeps_15s_timeout():
    routes = (PACKAGE_DIR / "aih" / "routes.py").read_text(encoding="utf-8")
    assert "timeout=15" in routes, "le plafond de 15 s de /aih/blobby/exec doit rester"


def test_git_urls_with_credentials_are_still_refused():
    for rel in ("aih/custom_nodes_manager.py", "nodes/holaf_nodes_manager.py"):
        source = (PACKAGE_DIR / rel).read_text(encoding="utf-8")
        assert "parsed.username" in source and "parsed.password" in source, \
            f"{rel} doit refuser les URLs git contenant des identifiants"


def test_path_sanitizers_are_still_present():
    # Vérification STATIQUE (holaf_utils importe aiofiles, absent du venv de test).
    source = (PACKAGE_DIR / "holaf_utils.py").read_text(encoding="utf-8")
    for fn in ("sanitize_upload_id", "sanitize_filename", "sanitize_directory_component"):
        assert f"def {fn}(" in source, f"{fn} doit rester (confinement des chemins)"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
