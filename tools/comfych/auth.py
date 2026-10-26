"""API key authentication for the Modal Gateway router.

Le routeur FastAPI (``apps/all_in_one*.py``) attend la clé dans le Secret
Modal ``comfy-gateway-secret`` (variable d'env ``API_KEY``), avec un
fallback local (``MODAL_GATEWAY_API_KEY``) pour le dev.

Mise en place côté Modal (CLI) ::

    modal secret create comfy-gateway-secret API_KEY=<votre-clé>

Puis renseignez la **même** clé dans l'UI Modal Gateway (Paramètres ⚙️ →
Connexion API Modal → Clé API). La clé est envoyée par l'extension JS dans
l'en-tête ``X-API-Key``.

Fail-closed : si aucun Secret n'est configuré sur le compte, les routes
protégées répondent 503 avec les instructions — jamais d'accès ouvert.
"""

from __future__ import annotations

import hmac
import os

import modal
from fastapi import Header, HTTPException

# Nom du Secret Modal qui porte la clé API du gateway.
SECRET_NAME = "comfy-gateway-secret"
# Variable d'env exposée par le Secret (et/ou fallback local).
SECRET_ENV_KEY = "API_KEY"
FALLBACK_ENV_KEY = "MODAL_GATEWAY_API_KEY"


def get_modal_secrets() -> list[modal.Secret]:
    """Return the gateway Secret if it exists on the account, else ``[]``.

    Passée à ``modal.App(secrets=...)`` : le Secret est monté comme variable
    d'env (``API_KEY``) sur tous les containers de l'app. S'il est absent,
    les routes protégées répondent 503 (fail-closed) avec les instructions.
    """
    try:
        s = modal.Secret.from_name(SECRET_NAME)
        s.hydrate()  # from_name est lazy — force la vérification d'existence
        return [s]
    except modal.exception.NotFoundError:
        print(
            f"⚠️  Modal Secret '{SECRET_NAME}' introuvable — les routes protégées "
            f"répondront 503. Créez-le avec :\n"
            f"    modal secret create {SECRET_NAME} {SECRET_ENV_KEY}=<votre-clé>"
        )
        return []
    except modal.exception.AuthError:
        print(
            "⚠️  Authentification Modal requise : exécutez "
            "`modal token set --token-id <id> --token-secret <secret>` "
            "ou renseignez le token dans les paramètres ComfyUI "
            "(Paramètres ⚙️ → Token Modal (compte) → ✅ Enregistrer le token). "
            "Les routes protégées répondront 503 tant que le secret n'est pas monté."
        )
        return []
    except Exception as exc:  # noqa: BLE001 — ConnectionError, timeouts, etc.
        print(
            f"⚠️  Impossible de vérifier le Modal Secret '{SECRET_NAME}' "
            f"({type(exc).__name__}: {exc}) — les routes protégées répondront 503. "
            "Vérifiez votre connexion réseau puis redéployez (modal deploy apps/all_in_one.py)."
        )
        return []


def _configured_key() -> str:
    """Clé attendue, depuis le Secret monté (API_KEY) ou l'env local."""
    return os.environ.get(SECRET_ENV_KEY) or os.environ.get(FALLBACK_ENV_KEY, "")


def require_api_key(x_api_key: str = Header(default="", alias="X-API-Key")) -> None:
    """FastAPI dependency — contrôle fail-closed de la clé API.

    - 503 si le serveur n'a aucune clé configurée (avec instructions)
    - 401 si la clé fournie ne correspond pas (comparaison en temps constant)
    """
    expected = _configured_key()
    if not expected:
        raise HTTPException(
            status_code=503,
            detail=(
                f"API key non configurée sur le serveur. Créez le Secret Modal :\n"
                f"    modal secret create {SECRET_NAME} {SECRET_ENV_KEY}=<clé>\n"
                f"puis redéployez (modal deploy apps/all_in_one.py)."
            ),
        )
    if not hmac.compare_digest(x_api_key, expected):
        raise HTTPException(status_code=401, detail="Clé API invalide")
