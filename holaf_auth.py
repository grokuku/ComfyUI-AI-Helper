# === Holaf Utilities - Shared Authentication ===
#
# Developer: Gemini (AI Assistant), under the direction of Holaf
# Date: 2025-06-01
#
# Purpose:
# Shared, stateless authentication for the Holaf utilities. It reuses the
# password hash stored in config.ini ([Security] / password_hash) and issues a
# signed SESSION cookie (holaf_session) instead of keeping server-side state.
# The signing key is persisted as [Security] / session_secret and generated on
# first use so sessions survive ComfyUI restarts.
#
# Session semantics (NO timeout — explicit product requirement):
# - The cookie is a BROWSER SESSION cookie: no Max-Age / Expires attribute, so
#   it dies when the browser is closed. There is no persistent cookie either.
# - The signed token has NO server-side expiry. A session ends for exactly two
#   reasons: an explicit logout (POST /holaf/auth/logout) or the browser being
#   closed. This deliberately rules out the "long command silently kills the
#   terminal and asks for the password again" regression.
# - ALL password-consuming frontends share ONE prompt (js/holaf_auth.js); this
#   module is the single backend implementation of login/setup/status/logout.
#
# Security notes:
#   ⚠️ ASSUMED TRADE-OFF: because the token never expires server-side, a stolen
#   token (or cookie) stays valid until an explicit logout. The only other
#   bound is the browser-session cookie (dies on browser close). This is an
#   accepted trade-off by the product owner (a defensive TTL used to log the
#   user out mid-download). Deploy behind an authenticated reverse proxy.
# - Password hashing is PBKDF2-HMAC-SHA256 (the same algorithm already used by
#   __main__.py / holaf_terminal.py).
# - Session tokens are HMAC-SHA256 signed payloads. No server-side session store
#   is required; validation only recomputes the MAC (no expiry check).
# - Client-facing errors are intentionally generic to avoid leaking whether a
#   password is configured or which part of a token is invalid.
# - NO rate-limiting is implemented on purpose (explicit user requirement): the
#   deployment is expected to sit behind an authenticated reverse proxy.
# === End Documentation ===

import base64
import binascii
import functools
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
import traceback

from aiohttp import web

from . import holaf_config

SESSION_COOKIE_NAME = "holaf_session"
# NO server-side token lifetime on purpose: a session only ends with an
# explicit logout or when the browser is closed (the cookie has no Max-Age).
PBKDF2_ITERATIONS = 260000

# Longueur minimale d'un NOUVEAU mot de passe (setup / changement).
# Ne s'applique qu'aux nouveaux mots de passe — les hashes existants restent
# valides. Surchargeable via l'environnement (défaut : 8).
MIN_PASSWORD_LENGTH = int(os.environ.get("AIH_MIN_PASSWORD_LENGTH", "8"))

_session_secret_lock = threading.Lock()
_session_secret_cache = None


# --- Password hashing (factorized from holaf_terminal.py) ---
def hash_password(password: str) -> str:
    """Return a PBKDF2-HMAC-SHA256 password hash (salt$digest, hex encoded)."""
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac(
        'sha256', password.encode('utf-8'), salt, PBKDF2_ITERATIONS
    )
    return f"{salt.hex()}${digest.hex()}"


def verify_password(stored_hash, provided_password) -> bool:
    """Return True if *provided_password* matches *stored_hash*."""
    if not stored_hash or not provided_password:
        return False
    try:
        salt_hex, key_hex = stored_hash.split('$', 1)
        salt = bytes.fromhex(salt_hex)
        key = bytes.fromhex(key_hex)
    except (ValueError, TypeError):
        return False

    new_key = hashlib.pbkdf2_hmac(
        'sha256', provided_password.encode('utf-8'), salt, PBKDF2_ITERATIONS
    )
    return hmac.compare_digest(new_key, key)


# --- Session secret persistence ---
def _load_session_secret():
    try:
        config_parser = holaf_config.get_config_parser()
        secret = config_parser.get('Security', 'session_secret', fallback='')
    except Exception:
        return None
    secret = (secret or '').strip()
    return secret or None


def _persist_session_secret(secret):
    config_path = holaf_config.get_config_path()
    try:
        config_parser = holaf_config.get_config_parser()
        if not config_parser.has_section('Security'):
            config_parser.add_section('Security')
        config_parser.set('Security', 'session_secret', secret)

        # Write atomically so a crash mid-write cannot corrupt config.ini.
        tmp_path = f"{config_path}.tmp"
        with open(tmp_path, 'w', encoding='utf-8') as config_file:
            config_parser.write(config_file)
        os.replace(tmp_path, config_path)
    except Exception as e:
        # Persistence is best-effort: if config.ini is read-only or malformed,
        # the session still works for this process but will not survive a restart.
        print(f"🔴 [Holaf-Auth] Could not persist session_secret: {e}")


def get_session_secret() -> str:
    """Return the HMAC signing key, generating and persisting it on first use."""
    global _session_secret_cache
    with _session_secret_lock:
        if _session_secret_cache:
            return _session_secret_cache

        secret = _load_session_secret()
        if not secret:
            secret = secrets.token_hex(32)  # 256 bits of entropy
            _persist_session_secret(secret)

        _session_secret_cache = secret
        return secret


# --- Signed stateless session tokens ---
def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def _b64url_decode(value: str) -> bytes:
    padding = '=' * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _sign(payload_b64: str) -> str:
    secret = get_session_secret()
    return hmac.new(
        secret.encode('ascii'),
        payload_b64.encode('ascii'),
        hashlib.sha256,
    ).hexdigest()


def create_session_token(now: int | None = None) -> str:
    """Create a signed session token that NEVER expires server-side.

    The payload keeps an ``iat`` timestamp for traceability only; no ``exp``
    field is written and none is checked on validation, so a long-running
    (silent) command can never invalidate the session.
    """
    if now is None:
        now = int(time.time())
    payload = {
        "iat": now,
    }
    payload_b64 = _b64url_encode(
        json.dumps(payload, separators=(',', ':')).encode('utf-8')
    )
    return f"{payload_b64}.{_sign(payload_b64)}"


def validate_session_token(token, now: int | None = None) -> bool:
    """Return True if *token* has a valid signature (no expiry check).

    *now* is accepted for backward compatibility with callers/tests but is
    intentionally ignored: a signed session token is valid until logout.
    """
    if not token or not isinstance(token, str):
        return False

    try:
        payload_b64, signature = token.split('.', 1)
    except ValueError:
        return False

    if not payload_b64 or not signature:
        return False

    expected_signature = _sign(payload_b64)
    if not hmac.compare_digest(expected_signature, signature):
        return False

    # The payload must at least be well-formed JSON (defense against a validly
    # signed token whose body was never a JSON object).
    try:
        payload = json.loads(_b64url_decode(payload_b64).decode('utf-8'))
    except (binascii.Error, ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError):
        return False
    if not isinstance(payload, dict):
        return False

    return True


# --- Cookie helpers ---
def _is_secure_request(request: web.Request) -> bool:
    """Detect HTTPS, including the common reverse-proxy TLS offload header."""
    forwarded_proto = (
        request.headers.get('X-Forwarded-Proto', '').split(',')[0].strip().lower()
    )
    if forwarded_proto:
        return forwarded_proto == 'https'
    return request.scheme == 'https'


def set_session_cookie(response: web.Response, request: web.Request, token: str | None = None) -> str:
    """Attach the shared SESSION cookie to *response* and return the token.

    SESSION cookie on purpose: no max_age / expires → the browser discards it
    when closed (the old code issued a persistent 30-day cookie).
    """
    if token is None:
        token = create_session_token()

    response.set_cookie(
        SESSION_COOKIE_NAME,
        token,
        httponly=True,
        samesite='Strict',
        secure=_is_secure_request(request),
        path='/',
    )
    return token


def clear_session_cookie(response: web.Response):
    response.del_cookie(SESSION_COOKIE_NAME, path='/')


def is_authenticated(request: web.Request) -> bool:
    """Return True if the request carries a valid holaf_session cookie."""
    token = request.cookies.get(SESSION_COOKIE_NAME)
    return bool(token) and validate_session_token(token)


# --- Route-level auth guard ---
def require_auth(handler):
    """Decorator that rejects unauthenticated requests with a clean 401 JSON."""
    @functools.wraps(handler)
    async def wrapper(request: web.Request, *args, **kwargs):
        if not is_authenticated(request):
            return web.json_response(
                {"success": False, "error": "Authentication required."},
                status=401,
            )
        return await handler(request, *args, **kwargs)

    return wrapper


# --- Unified auth endpoints (single implementation for ALL frontends) ---
async def login_route(request: web.Request, global_config) -> web.Response:
    """POST /holaf/auth/login — verify the password, set the session cookie.

    Deliberately NOT rate-limited (explicit product decision; the pack is meant
    to live behind an authenticated reverse proxy).
    """
    password_hash = global_config.get('password_hash')
    password = None
    try:
        data = await request.json()
        if isinstance(data, dict):
            password = data.get('password')
    except Exception:
        password = None

    # Generic message on purpose: do not reveal whether a password is set.
    if not password_hash or not verify_password(password_hash, password):
        return web.json_response(
            {"success": False, "error": "Invalid credentials."},
            status=401,
        )

    response = web.json_response({"success": True})
    set_session_cookie(response, request)
    return response


async def setup_route(request: web.Request, global_config) -> web.Response:
    """POST /holaf/auth/setup — define the password (first time) or change it.

    - First-time setup (no hash configured yet) is open: it is protected by the
      CSRF middleware (Origin/Referer) and, in remote deployments, by the
      authenticated reverse proxy. Pre-configure 'password_hash' in config.ini
      to avoid a first-come-first-served takeover on an exposed instance.
    - Changing an existing password requires the CURRENT password.
    - On success the shared session cookie is set (auto-login): the setup
      prompt is the only prompt the user sees.
    """
    try:
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"status": "error", "message": "Invalid request."}, status=400)

        if not isinstance(data, dict):
            return web.json_response({"status": "error", "message": "Invalid request."}, status=400)

        current_hash = global_config.get('password_hash')

        if current_hash:
            # A password already exists: changing it requires proving knowledge
            # of the current password (no unauthenticated takeover).
            current_password = data.get('current_password')
            if not current_password or not verify_password(current_hash, current_password):
                return web.json_response(
                    {"status": "error", "message": "Current password is incorrect."},
                    status=403,
                )

        password = data.get('password')
        if not password or len(password) < MIN_PASSWORD_LENGTH:
            return web.json_response(
                {"status": "error", "message": f"New password is too short (min {MIN_PASSWORD_LENGTH} characters)."},
                status=400,
            )

        new_hash = hash_password(password)

        try:
            await holaf_config.save_setting_to_config('Security', 'password_hash', new_hash)
            global_config['password_hash'] = new_hash  # Update live global config
            if current_hash:
                print("🔑 [Holaf-Auth] The shared password has been changed via the UI.")
            else:
                print("🔑 [Holaf-Auth] The shared password has been set via the UI.")
            response = web.json_response({"status": "ok", "action": "reload"})
            set_session_cookie(response, request)  # Auto-login after setup.
            return response
        except PermissionError:
            print("🔵 [Holaf-Auth] A user tried to set/change the password, but file permissions prevented saving.")
            if not current_hash:
                # First-time setup: offer the manual fallback (README-documented UX):
                # the user copies the hash into config.ini under [Security] password_hash.
                return web.json_response({"status": "manual_required", "hash": new_hash})
            return web.json_response({"status": "error", "message": "Could not save config.ini due to file permissions."}, status=500)
    except Exception as e:
        print(f"🔴 [Holaf-Auth] Error setting password: {e}")
        traceback.print_exc()
        return web.json_response({"status": "error", "message": "An unexpected error occurred while updating the password."}, status=500)


async def logout_route(request: web.Request) -> web.Response:
    """POST /holaf/auth/logout"""
    response = web.json_response({"success": True})
    clear_session_cookie(response)
    return response


async def status_route(request: web.Request, global_config=None) -> web.Response:
    """GET /holaf/auth/status — drives the SINGLE shared frontend prompt."""
    return web.json_response({
        "authenticated": is_authenticated(request),
        "password_configured": bool(global_config.get('password_hash')) if global_config else None,
        "min_password_length": MIN_PASSWORD_LENGTH,
    })
