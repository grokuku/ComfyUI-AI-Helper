# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""
credentials.py — Helper pour charger les credentials AIH depuis ComfyUI/user/.

Porté depuis l'ancien monorepo AI-Helper (fusion PLAN_FUSION.md,
Phase 2 chantier A) : renommé 'aih.credentials' car il n'est plus un private
module de nodes mais un élément du socle partagé (utilisé par sync_engine,
les routes /aih/* et les nodes).

L'api_key et l'URL du serveur ne transitent plus par un widget STRING
des nodes (source de bugs d'index et de fuites dans les workflows exportes).
Elles sont stockees dans un fichier local que les nodes Python lisent
directement via ce helper.

Emplacement du fichier : <ComfyUI>/user/default/AI-Helper/config/credentials.json
après migration (résolu par holaf_user_paths.resolved_credentials()).
Repli sur le chemin historique <ComfyUI>/user/default/aih/credentials.json
(ou <ComfyUI>/user/aih/credentials.json si pas de sous-dossier default/)
tant que la migration n'a rien déplacé : aucun credentials existant perdu.

Format JSON :
{
    "api_key": "xxx...",
    "server_url": "https://aih.holaf.fr",
    "updated_at": "2026-06-13T22:00:00Z"
}

Securite (ameliorations futures) :
    - Le helper supporte deja un mode chiffre via Fernet (si cryptography
      est installe et AIH_PASSPHRASE defini). Pour l'instant on lit en clair
      par defaut, le chiffrement sera active dans une session ulterieure.
"""

import json
import os
import logging
import re

# Emplacement des données utilisateur : UNE seule source de vérité
# (holaf_user_paths). Repli sur la chaîne de candidats historique tant que la
# migration n'a rien déplacé : aucun credentials perdu.
try:  # import à plat (aih/__init__.py a mis la racine du pack dans sys.path)
    import holaf_user_paths as _user_paths
except ImportError:  # pack importé comme package : import relatif
    from .. import holaf_user_paths as _user_paths

_CREDENTIALS_CACHE = None
_CREDENTIALS_PATH = None

# Garde-fou anti-masque : un libellé d'affichage (« Clé masquée — clique sur
# « Régénérer »… », placeholder, message d'état) a déjà été collé comme clé API
# par un utilisateur (bug du bouton « Copier » côté front). Une telle valeur ne
# doit JAMAIS être envoyée en Authorization: Bearer ni persistée.
_MASKED_API_KEY_RE = re.compile(
    r"(masqu"                                # FR : masquée/masqué/masques
    r"|r[ée]g[ée]n[ée]r"                     # « Régénérer » (les libellés y invitent)
    r"|\bhidden\b|\bplaceholder\b"
    r"|\b(chargement|loading)\b"
    r"|\b(indisponible|unavailable)\b"
    r"|\b(pas de token|no token)\b"
    r"|\b(erreur|error)\b)",
    re.IGNORECASE,
)


def is_masked_api_key(value):
    """Vrai si la valeur ressemble à un libellé de masquage / message d'état.

    Une valeur vide n'est PAS un masque : elle est simplement absente.
    """
    s = (value or "").strip()
    return bool(s) and bool(_MASKED_API_KEY_RE.search(s))


def _migrate_to_aih_subfolder(old_path, new_path):
    """Déplace un fichier vers le sous-dossier aih/ s'il existe à l'ancien emplacement."""
    import shutil as _shutil
    if os.path.isfile(old_path) and not os.path.isfile(new_path):
        os.makedirs(os.path.dirname(new_path), exist_ok=True)
        _shutil.move(old_path, new_path)
        logging.info(f"[AIH] Migrated {old_path} → {new_path}")


def get_credentials_path():
    """
    Retourne le chemin du fichier de credentials.

    Résolution unique : holaf_user_paths.resolved_credentials() →
    <user>/default/AI-Helper/config/credentials.json si la migration l'a
    déplacé, sinon le premier emplacement historique encore présent
    (user/default/aih/credentials.json, user/aih/…, ~/.config/comfyui/…).
    """
    global _CREDENTIALS_PATH
    if _CREDENTIALS_PATH is not None:
        return _CREDENTIALS_PATH

    # Migration paresseuse depuis l'ancien emplacement plat (aih_credentials.json)
    try:
        import folder_paths
        user_dir = folder_paths.get_user_directory()
    except Exception:
        user_dir = None
    if user_dir:
        try:
            _migrate_to_aih_subfolder(
                os.path.join(user_dir, "default", "aih_credentials.json"),
                os.path.join(user_dir, "default", "aih", "credentials.json"),
            )
        except Exception as exc:  # pragma: no cover - défensif
            logging.warning(f"[AIH] credentials: migration paresseuse ignorée ({exc})")

    _CREDENTIALS_PATH = _user_paths.resolved_credentials()
    return _CREDENTIALS_PATH


def _load_aih_credentials(use_cache=True):
    """
    Charge les credentials depuis le fichier local.
    Retourne {"api_key": str, "server_url": str}.

    Si le fichier n'existe pas, retourne des valeurs par defaut.
    Le cache evite de relire le fichier a chaque appel de node.
    """
    global _CREDENTIALS_CACHE

    if use_cache and _CREDENTIALS_CACHE is not None:
        return _CREDENTIALS_CACHE

    path = get_credentials_path()
    if not os.path.isfile(path):
        _CREDENTIALS_CACHE = {"api_key": "", "server_url": ""}
        return _CREDENTIALS_CACHE

    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            data = {}
    except Exception as e:
        logging.warning(f"[AIH credentials] Failed to read {path}: {e}")
        data = {}

    _CREDENTIALS_CACHE = {
        "api_key": data.get("api_key", ""),
        "server_url": data.get("server_url", ""),
    }
    return _CREDENTIALS_CACHE


def invalidate_cache():
    """Force la relecture du fichier au prochain appel."""
    global _CREDENTIALS_CACHE
    _CREDENTIALS_CACHE = None


def get_api_url():
    """Retourne l'URL du backend (avec /api), ou "" si non configurée.

    Aucune URL par défaut codée en dur : la chaîne vide signale l'absence de
    configuration et les appelants doivent dégrader proprement (les
    credentials se renseignent dans Settings ▸ onglet « AIH · Compte »).
    Les données existantes (server_url déjà présent dans le fichier) restent
    bien sûr lues et retournées telles quelles.
    """
    creds = _load_aih_credentials()
    base = (creds.get("server_url") or "").rstrip("/")
    return base + "/api" if base else ""


def get_api_key():
    """Retourne l'api_key — ou "" si la valeur enregistrée est un masque.

    Rattrapage : une clé DÉJÀ ENREGISTRÉE qui est en réalité un texte de
    masquage (copiée par erreur depuis un champ masqué) est ignorée : elle ne
    doit jamais partir en Authorization: Bearer (401 incompréhensible).
    """
    creds = _load_aih_credentials()
    key = creds.get("api_key", "")
    if is_masked_api_key(key):
        logging.warning(
            "[AIH credentials] api_key ignorée : texte de masquage enregistré "
            "(ressaisir la vraie clé dans Settings ▸ AIH · Compte)"
        )
        return ""
    return key


# ── Diagnostic de démarrage (worker Modal / ComfyUI) ────────────────────

def _presence(value):
    """« renseignée » ou « vide » — JAMAIS la valeur (clé API en clair)."""
    return "renseignée" if str(value or "").strip() else "vide"


def credentials_status_line():
    """Ligne de diagnostic NEUTRE décrivant les credentials effectivement lus.

    Objectif : trancher en UNE ligne, depuis le log de démarrage du worker, les
    trois causes possibles d'un « credentials incomplets » alors que les
    réglages sont renseignés côté local :
      - fichier ABSENT à ce chemin (mauvaise résolution de ``user/`` ou volume
        non synchronisé) ;
      - fichier présent mais VIDE (l'UI a écrit ailleurs, ou la sync n'a jamais
        poussé la version remplie) ;
      - fichier présent et renseigné (le problème est alors côté backend/URL).

    La valeur de la clé n'est JAMAIS incluse, seulement sa présence (le log
    part dans un volume, puis dans le navigateur via le suivi de run).

    Retours:
        str: ``credentials: server_url=<vide|renseignée> api_key=<vide|renseignée>
        (source: fichier <chemin>)``.
    """
    path = get_credentials_path()
    exists = os.path.isfile(path)
    creds = _load_aih_credentials(use_cache=False) if exists else {}
    raw_key = creds.get("api_key", "")
    key_state = _presence(raw_key)
    if key_state == "renseignée" and is_masked_api_key(raw_key):
        # Une valeur de masquage n'est PAS utilisable : elle est déjà ignorée
        # par get_api_key(), le diagnostic doit le dire (sinon on cherche au
        # mauvais endroit).
        key_state = "masquée (ignorée)"
    source = f"source: fichier {path}"
    if not exists:
        source += " — ABSENT (valeurs par défaut : vides)"
    return (
        f"credentials: server_url={_presence(creds.get('server_url'))} "
        f"api_key={key_state} ({source})"
    )


def log_credentials_status(prefix="[AIH credentials]"):
    """Écrit :func:`credentials_status_line` dans le log (INFO) et le renvoie."""
    line = credentials_status_line()
    logging.info(f"{prefix} {line}")
    return line
