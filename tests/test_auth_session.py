"""Authentification partagée par mot de passe (version intermédiaire).

Contrat verrouillé par ces tests :
  - le socle est RESTAURÉ (holaf_auth.py + __main__.py) et ADAPTÉ : cookie de
    SESSION (aucun Max-Age / Expires → mort à la fermeture du navigateur),
    minimum 8 caractères, PAS de rate-limiting ;
  - AUCUNE expiration de jeton côté serveur : un jeton signé reste valide
    indéfiniment (fin de session = logout explicite ou fermeture navigateur) ;
  - le terminal ne porte AUCUN plafond de durée (pas de timeout d'asyncio.wait)
    et garde un keepalive WebSocket (heartbeat) pour survivre aux proxys ;
  - UNE seule implémentation backend (holaf_auth) : login / setup / logout /
    status ; le terminal n'a plus ses routes d'auth dédiées ;
  - les gardes sont réappliquées sur EXACTEMENT les 18 routes d'avant
    (10 dans __init__.py + 8 dans aih/routes.py), avec un test fonctionnel 401 ;
  - l'invite UNIQUE côté front est un module dédié (js/holaf_auth.js) utilisé
    par le terminal, le Nodes Manager et Blobby — vérifié par js/test_holaf_auth.mjs.

Le package ComfyUI-AI-Helper n'étant pas importable directement (tiret dans le
nom du dossier), on charge ses modules sous un nom Python valide via importlib
(même stratégie que les autres tests du dossier).
"""

import ast
import asyncio
import importlib.util
import inspect
import json
import os
import sys
import types
from pathlib import Path

import pytest

# Le minimum par défaut doit être déterministe dans les tests : les variables
# d'environnement priment à l'import de holaf_auth.
os.environ.pop("AIH_MIN_PASSWORD_LENGTH", None)

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


_auth = None


def auth():
    """Importe (une fois) holaf_auth dans le package synthétique."""
    global _auth
    if _auth is None:
        _load_module("holaf_config")
        _auth = _load_module("holaf_auth")
    return _auth


# ── Socle restauré ──────────────────────────────────────────────────────


def test_auth_module_and_cli_are_restored():
    """holaf_auth.py (sessions partagées) et __main__.py (CLI de hash) existent."""
    assert (PACKAGE_DIR / "holaf_auth.py").is_file(), "holaf_auth.py doit être restauré"
    assert (PACKAGE_DIR / "__main__.py").is_file(), "le CLI de génération de hash est restauré"
    a = auth()
    assert callable(a.hash_password) and callable(a.verify_password)
    assert callable(a.require_auth) and callable(a.login_route)
    assert callable(a.setup_route) and callable(a.status_route)


def test_config_exposes_password_hash():
    """load_all_configs() expose de nouveau la clé 'password_hash'."""
    cfg = _load_module("holaf_config")
    loaded = cfg.load_all_configs()
    assert "password_hash" in loaded


# ── Minimum 8 (et contrôles négatifs) ───────────────────────────────────


def test_min_password_length_is_eight():
    """Le minimum est 8 (l'ancien terminal enforçait 12, l'UI affichait 4)."""
    assert auth().MIN_PASSWORD_LENGTH == 8


def test_minimum_boundary_negative_control():
    """Preuve que la borne testée n'est pas vide : 7 < 8 <= 8."""
    assert len("1234567") < auth().MIN_PASSWORD_LENGTH
    assert len("12345678") >= auth().MIN_PASSWORD_LENGTH


# ── Hash PBKDF2 ─────────────────────────────────────────────────────────


def test_hash_verify_roundtrip():
    a = auth()
    stored = a.hash_password("correct horse battery")
    assert a.verify_password(stored, "correct horse battery") is True
    assert a.verify_password(stored, "wrong password") is False


def test_verify_rejects_malformed_or_empty():
    a = auth()
    assert a.verify_password(None, "x") is False
    assert a.verify_password("not-a-hash", "x") is False
    assert a.verify_password(a.hash_password("x"), "") is False


# ── Jeton signé : AUCUNE expiration serveur ──────────────────────────


def test_session_token_never_expires():
    """Un jeton signé reste valide indéfiniment (plus de TTL serveur)."""
    a = auth()
    now = 1_700_000_000
    token = a.create_session_token(now=now)
    assert a.validate_session_token(token, now=now) is True
    # Valide des années plus tard, et même sans horloge fournie.
    assert a.validate_session_token(token, now=now + 10 * 365 * 24 * 3600) is True
    assert a.validate_session_token(token) is True


def test_no_session_ttl_constant_exists():
    """Contrôle négatif : les constantes de TTL introduites précédemment ont disparu."""
    a = auth()
    assert not hasattr(a, "SESSION_TTL_SECONDS")
    assert not hasattr(a, "SESSION_MAX_AGE_SECONDS")


def test_exp_field_is_not_written_in_token():
    """Le payload ne porte plus de champ 'exp' (seul 'iat' reste, informatif)."""
    import base64
    import json as _json
    a = auth()
    token = a.create_session_token(now=1_700_000_000)
    payload_b64 = token.split(".", 1)[0]
    padding = "=" * (-len(payload_b64) % 4)
    payload = _json.loads(base64.urlsafe_b64decode(payload_b64 + padding).decode("utf-8"))
    assert "exp" not in payload
    assert payload.get("iat") == 1_700_000_000


def test_session_token_rejects_tampering():
    a = auth()
    token = a.create_session_token()
    assert a.validate_session_token(token + "x") is False
    assert a.validate_session_token("payload.signature") is False
    assert a.validate_session_token("") is False
    assert a.validate_session_token(None) is False


# ── Cookie de SESSION : AUCUN Max-Age / Expires ─────────────────────────


class _FakeRequest:
    """Requête minimale : cookies + en-têtes + scheme (pas de vrai aiohttp)."""

    def __init__(self, cookies=None, headers=None, scheme="http", body=None):
        self.cookies = cookies or {}
        self.headers = headers or {}
        self.scheme = scheme
        self._body = body or {}

    async def json(self):
        return self._body


def _cookie_string(response, name="holaf_session") -> str:
    """Sérialise le cookie posé par holaf_auth (sans prepare(), qui n'existe
    qu'à l'envoi réseau)."""
    return response.cookies[name].output(header="").strip()


def test_session_cookie_has_no_max_age_or_expires():
    """Le cookie est un cookie de SESSION : il meurt à la fermeture du navigateur."""
    from aiohttp import web
    a = auth()
    response = web.Response()
    a.set_session_cookie(response, _FakeRequest())
    morsel = response.cookies["holaf_session"]
    header = _cookie_string(response)
    assert header.startswith("holaf_session="), header
    assert not morsel.get("max-age"), f"cookie persistant interdit : {header}"
    assert not morsel.get("expires"), f"cookie persistant interdit : {header}"
    assert "Max-Age" not in header and "expires=" not in header.lower()


def test_session_cookie_flags():
    """HttpOnly + SameSite=Strict + Path=/ : mêmes protections qu'avant."""
    from aiohttp import web
    a = auth()
    response = web.Response()
    a.set_session_cookie(response, _FakeRequest())
    morsel = response.cookies["holaf_session"]
    header = _cookie_string(response)
    assert morsel["httponly"] is True
    assert morsel["samesite"] == "Strict"
    assert morsel["path"] == "/"
    low = header.lower()
    assert "httponly" in low and "samesite=strict" in low and "path=/" in low


def test_session_cookie_secure_behind_https_proxy():
    """Derrière un proxy TLS, le cookie porte Secure."""
    from aiohttp import web
    a = auth()
    response = web.Response()
    a.set_session_cookie(response, _FakeRequest(headers={"X-Forwarded-Proto": "https"}))
    assert response.cookies["holaf_session"]["secure"] is True


def test_max_age_assertion_is_not_vacuous():
    """Contrôle négatif : l'assertion « pas de Max-Age » détecte un cookie persistant.

    On reproduit ici le comportement de l'ANCIEN code (30 jours) : si holaf_auth
    régressait vers un cookie persistant, test_session_cookie_has_no_max_age_or_expires
    passerait au rouge.
    """
    from aiohttp import web
    persistent = web.Response()
    persistent.set_cookie("holaf_session", "token", max_age=30 * 24 * 60 * 60)
    header = _cookie_string(persistent)
    assert "Max-Age" in header, "le contrôle négatif doit voir le Max-Age"


def test_clear_session_cookie_deletes_it():
    from aiohttp import web
    a = auth()
    response = web.Response()
    a.clear_session_cookie(response)
    morsel = response.cookies["holaf_session"]
    assert morsel["max-age"] == "0"
    assert morsel["expires"]


def test_session_cookie_over_the_wire_has_no_max_age_and_authenticates():
    """Bout en bout (vrai serveur aiohttp) : l'en-tête Set-Cookie envoyé n'a
    NI Max-Age NI Expires, et le cookie de session authentifie /holaf/auth/status."""
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    a = auth()
    config = {"password_hash": a.hash_password("password-8")}
    app = web.Application()

    async def login(request):
        return await a.login_route(request, config)

    async def status(request):
        return await a.status_route(request, config)

    app.router.add_post("/holaf/auth/login", login)
    app.router.add_get("/holaf/auth/status", status)

    async def scenario():
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            resp = await client.post("/holaf/auth/login", json={"password": "password-8"})
            assert resp.status == 200
            header = resp.headers.get("Set-Cookie", "")
            assert header.startswith("holaf_session="), header
            assert "Max-Age" not in header, f"cookie de session attendu, reçu : {header}"
            assert "expires=" not in header.lower(), f"cookie de session attendu, reçu : {header}"

            # Le cookie de session suffit : statut authentifié.
            resp = await client.get("/holaf/auth/status")
            assert (await resp.json())["authenticated"] is True

            # Mauvais mot de passe : 401, aucun cookie posé.
            resp = await client.post("/holaf/auth/login", json={"password": "bad"})
            assert resp.status == 401
            assert "Set-Cookie" not in resp.headers
        finally:
            await client.close()

    asyncio.run(scenario())


# ── require_auth ────────────────────────────────────────────────────────


def test_setup_auto_login_then_guarded_route_over_the_wire(monkeypatch):
    """Setup 8 caractères → cookie de session posé (auto-login) → la garde
    require_auth laisse passer SANS second login ; 7 caractères → 400."""
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    a = auth()
    config = {}
    saved = {}

    async def fake_save(section, key, value):
        saved[(section, key)] = value

    monkeypatch.setattr(a.holaf_config, "save_setting_to_config", fake_save)

    async def setup(request):
        return await a.setup_route(request, config)

    async def guarded(request):
        return web.json_response({"ok": True})

    app = web.Application()
    app.router.add_post("/holaf/auth/setup", setup)
    app.router.add_get("/protected", a.require_auth(guarded))

    async def scenario():
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            resp = await client.post("/holaf/auth/setup", json={"password": "1234567"})
            assert resp.status == 400
            assert saved == {}

            resp = await client.post("/holaf/auth/setup", json={"password": "12345678"})
            assert resp.status == 200
            header = resp.headers.get("Set-Cookie", "")
            assert header.startswith("holaf_session=")
            assert "Max-Age" not in header and "expires=" not in header.lower()
            assert a.verify_password(saved[("Security", "password_hash")], "12345678")

            # Le cookie posé par le setup authentifie directement les routes gardées.
            resp = await client.get("/protected")
            assert resp.status == 200
        finally:
            await client.close()

    asyncio.run(scenario())


def test_require_auth_rejects_without_cookie():
    from aiohttp import web
    a = auth()

    @a.require_auth
    async def handler(request):
        return web.json_response({"ok": True})

    response = asyncio.run(handler(_FakeRequest()))
    assert response.status == 401
    assert json.loads(response.body)["success"] is False


def test_require_auth_accepts_valid_cookie():
    from aiohttp import web
    a = auth()
    token = a.create_session_token()

    @a.require_auth
    async def handler(request):
        return web.json_response({"ok": True})

    response = asyncio.run(handler(_FakeRequest(cookies={"holaf_session": token})))
    assert response.status == 200
    assert json.loads(response.body)["ok"] is True


def test_require_auth_accepts_token_at_any_age():
    """Aucune expiration : même un jeton « vieux » ouvre la route gardée."""
    from aiohttp import web
    a = auth()
    token = a.create_session_token(now=1_700_000_000)

    @a.require_auth
    async def handler(request):
        return web.json_response({"ok": True})

    response = asyncio.run(handler(_FakeRequest(cookies={"holaf_session": token})))
    assert response.status == 200
    assert json.loads(response.body)["ok"] is True


# ── /holaf/auth/login (sans rate-limiting) ──────────────────────────────


def test_login_sets_session_cookie_on_success():
    a = auth()
    stored = a.hash_password("password-8")
    config = {"password_hash": stored}
    response = asyncio.run(a.login_route(_FakeRequest(body={"password": "password-8"}), config))
    assert response.status == 200
    assert _cookie_string(response).startswith("holaf_session=")
    assert not response.cookies["holaf_session"].get("max-age")


def test_login_rejects_wrong_password_with_generic_error():
    a = auth()
    stored = a.hash_password("password-8")
    response = asyncio.run(a.login_route(_FakeRequest(body={"password": "nope"}), {"password_hash": stored}))
    assert response.status == 401
    assert "holaf_session" not in response.cookies
    assert json.loads(response.body)["error"] == "Invalid credentials."


def test_login_refuses_when_no_password_configured():
    a = auth()
    response = asyncio.run(a.login_route(_FakeRequest(body={"password": "whatever"}), {}))
    assert response.status == 401


def test_login_has_no_rate_limiting_and_no_429():
    """20 échecs consécutifs restent des 401 : aucun verrouillage/429."""
    a = auth()
    stored = a.hash_password("password-8")
    for _ in range(20):
        response = asyncio.run(a.login_route(_FakeRequest(body={"password": "bad"}), {"password_hash": stored}))
        assert response.status == 401, "aucun 429/verrouillage attendu (pas de rate-limiting)"
    assert not hasattr(a, "is_rate_limited")
    assert not hasattr(a, "record_failed_login")
    assert not hasattr(a, "RATE_LIMIT_MAX_FAILURES")


# ── /holaf/auth/setup (definition / changement, min 8) ──────────────────


@pytest.fixture()
def saved_settings(monkeypatch):
    """Capture les écritures config ([Security] password_hash)."""
    a = auth()
    saved = {}

    async def fake_save(section, key, value):
        saved[(section, key)] = value

    monkeypatch.setattr(a.holaf_config, "save_setting_to_config", fake_save)
    return saved


def test_setup_accepts_exactly_eight_characters(saved_settings):
    a = auth()
    config = {}
    response = asyncio.run(a.setup_route(_FakeRequest(body={"password": "12345678"}), config))
    assert response.status == 200
    assert json.loads(response.body)["status"] == "ok"
    assert _cookie_string(response).startswith("holaf_session=")
    new_hash = saved_settings[("Security", "password_hash")]
    assert a.verify_password(new_hash, "12345678") is True
    assert config["password_hash"] == new_hash


def test_setup_rejects_seven_characters(saved_settings):
    a = auth()
    response = asyncio.run(a.setup_route(_FakeRequest(body={"password": "1234567"}), {}))
    assert response.status == 400
    assert "8" in json.loads(response.body)["message"]
    assert saved_settings == {}, "un mot de passe trop court ne doit rien écrire"


def test_setup_rejects_empty_password(saved_settings):
    a = auth()
    response = asyncio.run(a.setup_route(_FakeRequest(body={"password": ""}), {}))
    assert response.status == 400


def test_setup_change_requires_current_password(saved_settings):
    a = auth()
    config = {"password_hash": a.hash_password("old-password")}

    # Mauvais mot de passe actuel → 403, rien n'est écrit.
    response = asyncio.run(a.setup_route(
        _FakeRequest(body={"current_password": "wrong", "password": "new-password"}), config
    ))
    assert response.status == 403
    assert saved_settings == {}

    # Bon mot de passe actuel → 200 + nouvelle session.
    response = asyncio.run(a.setup_route(
        _FakeRequest(body={"current_password": "old-password", "password": "new-password"}), config
    ))
    assert response.status == 200
    assert a.verify_password(config["password_hash"], "new-password") is True


def test_setup_manual_fallback_on_permission_error(monkeypatch):
    """config.ini non inscriptible → hash renvoyé pour collage manuel (1er setup)."""
    a = auth()

    async def denied(section, key, value):
        raise PermissionError("read-only")

    monkeypatch.setattr(a.holaf_config, "save_setting_to_config", denied)
    response = asyncio.run(a.setup_route(_FakeRequest(body={"password": "12345678"}), {}))
    data = json.loads(response.body)
    assert response.status == 200 and data["status"] == "manual_required"
    assert a.verify_password(data["hash"], "12345678") is True


# ── /holaf/auth/status ──────────────────────────────────────────────────


def test_status_reports_session_config_and_min_length():
    a = auth()
    anonymous = asyncio.run(a.status_route(_FakeRequest(), {"password_hash": "x"}))
    data = json.loads(anonymous.body)
    assert data == {
        "authenticated": False,
        "password_configured": True,
        "min_password_length": 8,
    }

    token = a.create_session_token()
    session = asyncio.run(a.status_route(_FakeRequest(cookies={"holaf_session": token}), {"password_hash": "x"}))
    assert json.loads(session.body)["authenticated"] is True


def test_logout_clears_cookie():
    a = auth()
    response = asyncio.run(a.logout_route(_FakeRequest()))
    assert response.status == 200
    assert response.cookies["holaf_session"]["max-age"] == "0"


# ── Une SEULE implémentation backend (pas de routes d'auth dupliquées) ──


def test_terminal_has_no_password_routes():
    """holaf_terminal ne porte plus set_password_route / auth_route (unifiés)."""
    _load_module("holaf_config")
    auth()  # charge holaf_auth avant le terminal (import relatif)
    term = _load_module("holaf_terminal")
    assert not hasattr(term, "set_password_route"), "le setup vit dans holaf_auth uniquement"
    assert not hasattr(term, "auth_route"), "la route token legacy a disparu"


def test_terminal_ws_refuses_without_cookie():
    """Défense en profondeur : le handler WS refuse une requête sans cookie."""
    _load_module("holaf_config")
    auth()
    term = _load_module("holaf_terminal")
    response = asyncio.run(term.websocket_handler(_FakeRequest(), {}))
    assert response.status == 401


def test_terminal_websocket_has_no_stall_timeout():
    """Aucun plafond de durée sur la boucle de session du terminal.

    Le symptôme historique (« le téléchargement HF se termine → le terminal se
    ferme et redemande le mot de passe ») venait d'un `asyncio.wait(...,
    timeout=300)` : au bout de 5 min sans qu'aucune tâche ne se termine (une
    commande muette = reader bloqué, rien à envoyer), le PTY était tué. On
    prouve ici que plus aucune attente du handler ne porte de `timeout=`.
    """
    tree = ast.parse((PACKAGE_DIR / "holaf_terminal.py").read_text(encoding="utf-8"))
    handler = next(
        n for n in ast.walk(tree)
        if isinstance(n, ast.AsyncFunctionDef) and n.name == "websocket_handler"
    )
    waits = [
        n for n in ast.walk(handler)
        if isinstance(n, ast.Call)
        and isinstance(n.func, ast.Attribute)
        and n.func.attr == "wait"
        and isinstance(n.func.value, ast.Name)
        and n.func.value.id == "asyncio"
    ]
    assert waits, "le handler doit attendre ses tâches via asyncio.wait"
    for call in waits:
        assert not any(k.arg == "timeout" for k in call.keywords), \
            "aucun timeout de session ne doit subsister dans le terminal"


def test_terminal_websocket_has_keepalive_heartbeat():
    """Un keepalive WebSocket (heartbeat) survit aux proxys/idle."""
    source = (PACKAGE_DIR / "holaf_terminal.py").read_text(encoding="utf-8")
    assert "WebSocketResponse(heartbeat=" in source, \
        "le WS du terminal doit envoyer des PING périodiques"
    assert "timeout=300" not in source


def test_terminal_ws_stays_open_through_idle():
    """Fonctionnel : une période SANS I/O ne ferme pas la session.

    On ouvre une vraie connexion WebSocket au handler (PTY /bin/sh réel) et on
    la laisse silencieuse > 1,5 s : aucun frame 'session-ended' ne doit arriver
    et la socket doit rester ouverte. (Un plafond de durée, même court, ferait
    échouer ce test sur une version régressée.)
    """
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer

    if os.name == "nt":
        pytest.skip("PTY réel indisponible/testé uniquement sur POSIX")

    _load_module("holaf_config")
    a = auth()
    term = _load_module("holaf_terminal")
    token = a.create_session_token()
    config = {"shell_command": "/bin/sh"}
    app = web.Application()

    async def ws_route(request):
        return await term.websocket_handler(request, config)

    app.router.add_get("/holaf/terminal", ws_route)

    async def scenario():
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            ws = await client.ws_connect(
                "/holaf/terminal",
                headers={"Cookie": f"holaf_session={token}"},
            )
            # Bouche d'inactivité : aucune frame entrante ni sortante.
            await asyncio.sleep(1.5)
            assert not ws.closed, "la session ne doit pas se fermer pendant l'inactivité"
            await ws.close()
        finally:
            await client.close()

    asyncio.run(scenario())


# ── Les 18 gardes réappliquées (liste IDENTIQUE à l'existant d'origine) ─


def _guarded_routes_init():
    """Extrait (méthode, chemin) des routes gardées par holaf_auth.require_auth
    dans __init__.py (le module n'est pas importable : il importe `server`)."""
    tree = ast.parse((PACKAGE_DIR / "__init__.py").read_text(encoding="utf-8"))
    return _guarded_routes_from_tree(tree)


def _guarded_routes_from_tree(tree):
    guarded = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        has_guard = any(
            isinstance(d, ast.Attribute) and d.attr == "require_auth"
            and isinstance(d.value, ast.Name) and d.value.id == "holaf_auth"
            for d in node.decorator_list
        )
        if not has_guard:
            continue
        for d in node.decorator_list:
            if not isinstance(d, ast.Call):
                continue
            fn = d.func
            if not (isinstance(fn, ast.Attribute) and fn.attr in ("get", "post", "put", "delete")):
                continue
            if d.args and isinstance(d.args[0], ast.Constant):
                guarded.add((fn.attr.upper(), d.args[0].value))
    return guarded


def _guarded_routes_aih():
    """Idem pour aih/routes.py (décorateur @require_auth sur des @r.get/post)."""
    tree = ast.parse((PACKAGE_DIR / "aih" / "routes.py").read_text(encoding="utf-8"))
    guarded = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        # `guard` est la variable locale de _register_blobby_group, assignée à
        # require_auth quand il est fourni (sinon garde fail-closed) : les deux
        # noms désignent la même garde de session.
        has_guard = any(
            isinstance(d, ast.Name) and d.id in ("require_auth", "guard")
            for d in node.decorator_list
        )
        if not has_guard:
            continue
        for d in node.decorator_list:
            if not isinstance(d, ast.Call):
                continue
            fn = d.func
            if not (isinstance(fn, ast.Attribute) and fn.attr in ("get", "post")):
                continue
            if d.args and isinstance(d.args[0], ast.Constant):
                guarded.add((fn.attr.upper(), d.args[0].value))
    return guarded


EXPECTED_INIT_ROUTES = {
    ("GET", "/holaf/terminal"),
    ("POST", "/holaf/utilities/restart"),
    ("POST", "/holaf/models/upload-chunk"),
    ("POST", "/holaf/models/finalize-upload"),
    ("POST", "/holaf/models/deep-scan-local"),
    ("POST", "/holaf/models/delete"),
    ("POST", "/holaf/nodes/update"),
    ("POST", "/holaf/nodes/delete"),
    ("POST", "/holaf/nodes/install-requirements"),
    ("POST", "/holaf/nodes/install"),
}

EXPECTED_AIH_ROUTES = {
    ("GET", "/aih/credentials"),
    ("POST", "/aih/credentials"),
    ("GET", "/aih/openai/keys"),
    ("POST", "/aih/update"),
    ("POST", "/aih/blobby/save"),
    ("GET", "/aih/blobby/load"),
    ("POST", "/aih/blobby/exec"),
    ("POST", "/api/aih/custom-nodes/install"),
}


def test_init_guards_exactly_the_ten_original_routes():
    assert _guarded_routes_init() == EXPECTED_INIT_ROUTES


def test_aih_guards_exactly_the_eight_original_routes():
    assert _guarded_routes_aih() == EXPECTED_AIH_ROUTES


def test_total_guarded_routes_is_eighteen():
    """Ni élargissement ni réduction : 18 routes protégées, comme à l'origine."""
    assert len(EXPECTED_INIT_ROUTES) + len(EXPECTED_AIH_ROUTES) == 18


# ── Les handlers aih répondent 401 SANS cookie (fonctionnel) ────────────


class _CapturingRoutes:
    """Faux objet routes qui capture les handlers enregistrés par groupe."""

    def __init__(self):
        self.captured = {}

    def get(self, path):
        def deco(fn):
            self.captured[("GET", path)] = fn
            return fn
        return deco

    def post(self, path):
        def deco(fn):
            self.captured[("POST", path)] = fn
            return fn
        return deco


def _aih_routes():
    if str(PACKAGE_DIR) not in sys.path:
        sys.path.insert(0, str(PACKAGE_DIR))
    from aih import routes
    return routes


def _register_all_aih_groups():
    a = auth()
    routes = _aih_routes()
    rec = _CapturingRoutes()
    routes._register_credentials_group(rec, a.require_auth)
    routes._register_update_group(rec, a.require_auth)
    routes._register_blobby_group(rec, a.require_auth)
    routes._register_models_group(rec, a.require_auth)
    return rec.captured


@pytest.mark.parametrize("route", sorted(EXPECTED_AIH_ROUTES))
def test_aih_guarded_route_returns_401_without_cookie(route):
    method, path = route
    handlers = _register_all_aih_groups()
    handler = handlers[(method, path)]
    response = asyncio.run(handler(_FakeRequest()))
    assert response.status == 401, f"{method} {path} doit exiger la session partagée"


def test_aih_guarded_route_passes_with_valid_cookie(monkeypatch, tmp_path):
    """Avec cookie valide, la garde laisse passer (ici : GET /aih/credentials)."""
    from aih import credentials
    a = auth()
    monkeypatch.setattr(
        credentials, "_load_aih_credentials",
        lambda use_cache=False: {"api_key": "k-123", "server_url": "https://x"},
    )
    monkeypatch.setattr(credentials, "get_credentials_path", lambda: str(tmp_path / "credentials.json"))

    handlers = _register_all_aih_groups()
    handler = handlers[("GET", "/aih/credentials")]
    token = a.create_session_token()
    response = asyncio.run(handler(_FakeRequest(cookies={"holaf_session": token})))
    assert response.status == 200
    assert json.loads(response.body)["api_key"] == "k-123"


def test_aih_register_passes_require_auth_and_fails_closed_without_it():
    """register() accepte require_auth ; la garde fail-closed renvoie 503."""
    from aiohttp import web
    routes = _aih_routes()
    params = inspect.signature(routes.register).parameters
    assert "require_auth" in params

    async def open_shell(request):
        return web.json_response({"ok": True})

    handler = routes._fail_closed_auth_guard(open_shell)
    response = asyncio.run(handler(_FakeRequest()))
    assert response.status == 503, "sans fonction d'auth, jamais de shell ouvert"


# ── Protection CONSERVÉE (non-mot-de-passe) ────────────────────────────


def test_bulk_settings_still_blocks_terminal_and_security():
    """L'allow-list de /holaf/utilities/save-all-settings reste verrouillée."""
    cfg = _load_module("holaf_config")
    assert "Terminal" in cfg.BLOCKED_BULK_SECTIONS
    assert "Security" in cfg.BLOCKED_BULK_SECTIONS
    assert "Terminal" not in cfg.ALLOWED_BULK_SECTIONS
    assert "Security" not in cfg.ALLOWED_BULK_SECTIONS


def test_bulk_settings_rejects_password_hash_key():
    """Le motif sensible 'password' bloque toute clé d'un section autorisée."""
    cfg = _load_module("holaf_config")
    assert cfg.SENSITIVE_KEY_PATTERN.search("password_hash")
    assert cfg.SENSITIVE_KEY_PATTERN.search("session_secret")


# ── L'invite UNIQUE côté front (structurel) ────────────────────────────


def test_single_shared_prompt_module_used_by_tools():
    """js/holaf_auth.js est LE composant partagé ; terminal + NodesManager l'utilisent."""
    shared = (PACKAGE_DIR / "js" / "holaf_auth.js").read_text(encoding="utf-8")
    assert "AIH.Dialog" in shared, "l'invite partagée utilise le système AIH.Dialog"
    assert "ensureAuthenticated" in shared and "withAuthRetry" in shared

    for tool in ("holaf_terminal.js", "holaf_nodes_manager.js", "blobby_companion.js"):
        source = (PACKAGE_DIR / "js" / tool).read_text(encoding="utf-8")
        assert "holaf_auth.js" in source, f"{tool} doit consommer l'invite partagée"


def test_tools_do_not_reimplement_password_dialogs():
    """Aucun outil ne recrée ses propres champs/modal de mot de passe (pas de duplication)."""
    terminal = (PACKAGE_DIR / "js" / "holaf_terminal.js").read_text(encoding="utf-8")
    nodes = (PACKAGE_DIR / "js" / "holaf_nodes_manager.js").read_text(encoding="utf-8")
    assert 'type = "password"' not in terminal
    assert 'type="password"' not in terminal
    assert 'type = "password"' not in nodes
    assert 'type="password"' not in nodes
    assert "/holaf/auth/login" not in terminal
    assert "/holaf/auth/login" not in nodes
    for fn in ("createLoginView", "createSetupView", "createManualSetupView", "_showLoginModal"):
        assert fn not in terminal and fn not in nodes


# ── Changement de mot de passe depuis les PARAMÈTRES ───────


_CHANGE_PASSWORD_KEYS = [
    "settings.security",
    "settings.changePassword",
    "settings.changePasswordDesc",
    "settings.changeCurrent",
    "settings.changeNew",
    "settings.changeConfirm",
    "settings.changeSubmit",
    "settings.changeSubmitting",
    "settings.changeSuccess",
    "settings.changeCurrentRequired",
    "settings.changeNewRequired",
    "settings.changeNewMin",
    "settings.changeMismatch",
    "settings.changeCurrentWrong",
    "settings.changeReach",
    "settings.changeError",
]


def test_settings_expose_password_change_tab():
    """L'UI de réglages porte un onglet Sécurité branché sur l'auth partagée."""
    settings = (PACKAGE_DIR / "js" / "holaf_settings_manager.js").read_text(encoding="utf-8")
    assert "renderSecurityTab" in settings
    assert '{ id: "security"' in settings, "un onglet 'security' doit exister"
    assert "settings.changePassword" in settings
    # Utilise les helpers partagés de holaf_auth (aucune duplication de logique).
    assert "holaf_auth.js" in settings
    assert "changePassword" in settings and "validatePasswordChange" in settings
    # Trois champs mot de passe : actuel + nouveau + confirmation.
    assert 'input.type = "password"' in settings
    assert "current-password" in settings and "new-password" in settings


def test_change_password_helper_hits_existing_route():
    """changePassword poste sur la route EXISTANTE /holaf/auth/setup (courant exigé)."""
    shared = (PACKAGE_DIR / "js" / "holaf_auth.js").read_text(encoding="utf-8")
    assert '"/holaf/auth/setup"' in shared
    assert "current_password" in shared
    assert "validatePasswordChange" in shared


def test_password_change_i18n_keys_present_in_both_locales():
    """Chaque clé de l'onglet Sécurité existe exactement 2 fois (FR + EN)."""
    src = (PACKAGE_DIR / "js" / "aih_strings.js").read_text(encoding="utf-8")
    for key in _CHANGE_PASSWORD_KEYS:
        assert src.count(f'"{key}"') == 2, f"{key} doit exister en FR ET en EN"
