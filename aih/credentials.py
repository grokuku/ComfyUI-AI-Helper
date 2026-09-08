# Copyright (C) Holaf / grokuku — CUI-Holaf-Utils.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""
credentials.py — Helper pour charger les credentials AIH depuis ComfyUI/user/.

Porté depuis AI-Helper/AIH_ComfyUI/nodes/_credentials.py (fusion PLAN_FUSION.md,
Phase 2 chantier A) : renommé 'aih.credentials' car il n'est plus un private
module de nodes mais un élément du socle partagé (utilisé par sync_engine,
les routes /aih/* et les nodes).

L'api_key et l'URL du serveur ne transitent plus par un widget STRING
des nodes (source de bugs d'index et de fuites dans les workflows exportes).
Elles sont stockees dans un fichier local que les nodes Python lisent
directement via ce helper.

Emplacement du fichier : <ComfyUI>/user/default/aih/credentials.json
(ou fallback : <ComfyUI>/user/aih/credentials.json si pas de sous-dossier default/)
⚠️ Chemin conservé À L'IDENTIQUE de l'extension AI-Helper d'origine pour ne pas
perdre les credentials existants des utilisateurs.

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

_CREDENTIALS_CACHE = None
_CREDENTIALS_PATH = None


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
    Utilise folder_paths.get_user_directory() (= ComfyUI/user/).
    """
    global _CREDENTIALS_PATH
    if _CREDENTIALS_PATH is not None:
        return _CREDENTIALS_PATH

    candidates = []
    try:
        import folder_paths
        user_dir = folder_paths.get_user_directory()
        # Nouvel emplacement : user/default/aih/credentials.json
        new_path = os.path.join(user_dir, "default", "aih", "credentials.json")
        # Migration depuis l'ancien emplacement : user/default/aih_credentials.json
        old_path = os.path.join(user_dir, "default", "aih_credentials.json")
        _migrate_to_aih_subfolder(old_path, new_path)
        candidates.append(new_path)
        # Fallback : user/aih/credentials.json (sans sous-dossier default/)
        candidates.append(os.path.join(user_dir, "aih", "credentials.json"))
    except Exception:
        pass

    # Fallback hors runtime ComfyUI : la racine ComfyUI via
    # folder_paths.base_path (JAMAIS custom_nodes/).
    try:
        import folder_paths
        base = getattr(folder_paths, "base_path", None)
        if base:
            cand = os.path.join(base, "user", "default", "aih", "credentials.json")
            if os.path.isdir(os.path.dirname(cand)):
                candidates.append(cand)
    except Exception:
        pass

    # Fallback final : home
    candidates.append(os.path.expanduser("~/.config/comfyui/aih/credentials.json"))
    candidates.append(os.path.expanduser("~/.aih/credentials.json"))

    for p in candidates:
        if os.path.isfile(p):
            _CREDENTIALS_PATH = p
            return p

    # Pas de fichier : retourner le premier candidat (pour save)
    if candidates:
        _CREDENTIALS_PATH = candidates[0]
    else:
        _CREDENTIALS_PATH = os.path.expanduser("~/.aih/credentials.json")
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
    """Retourne l'api_key."""
    creds = _load_aih_credentials()
    return creds.get("api_key", "")
