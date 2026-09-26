# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""media_upload.py — Upload CHUNKÉ des médias vers le backend AI-Helper.

Consommé par le node ``AIH save media`` (nodes/holaf_save_media.py) quand le
toggle ``save_to_server`` est activé. Calqué sur le client chunké de
``aih/model_manager.py`` (``upload_model_to_server``) : ``/media/init`` →
``/media/chunk`` × N → ``/media/complete``, header ``Authorization: Bearer``.

Différences vs ``model_manager`` :
  - le prompt (texte) et le workflow (JSON) sont transmis et persistés par le
    backend avec le média ;
  - l'échec est DUR : toute erreur lève :class:`MediaUploadError` (pas de
    fallback local côté node).

Endpoints backend (voir ``backend/routes/media.py``) :
  POST /api/media/init      → {upload_id, chunk_size, total_chunks}
  POST /api/media/chunk     → append (multipart)
  POST /api/media/complete  → {id, path, filename, subfolder, size, url, …}

``requests`` est importé paresseusement (comme dans model_manager) pour que ce
module reste importable sans dépendance côté tests.
"""

import logging
import os
import re

# Types acceptés + whitelist d'extensions (miroir du backend).
MEDIA_KINDS = ("image", "video", "audio")
_EXT_BY_KIND = {
    "image": {".png", ".jpg", ".jpeg", ".webp"},
    "video": {".mp4", ".webm", ".gif"},
    "audio": {".wav", ".mp3", ".flac"},
}


class MediaUploadError(Exception):
    """Échec d'upload média (serveur non configuré, injoignable ou en erreur)."""


# ── Sanitization (miroir du backend, pour un nom propre dès le client) ──

def _sanitize_segment(segment):
    segment = str(segment or "").replace("\\", "/")
    segment = segment.replace("..", "")
    segment = re.sub(r'[<>:"|?*\x00-\x1f]', "", segment)
    segment = segment.strip(" /.")
    # Un nom/sous-dossier est mono-segment : « / » devient « _ » (pas de sous-chemin).
    return segment.replace("/", "_")


def sanitize_subfolder(subfolder):
    """Réduit un sous-dossier à une suite de segments sûrs (``a/b``)."""
    raw = str(subfolder or "").replace("\\", "/")
    parts = []
    for seg in raw.split("/"):
        s = _sanitize_segment(seg)
        if s and s != ".":
            parts.append(s)
    return "/".join(parts)


def sanitize_base_filename(name):
    """Nom de base sans extension, sans séparateur ni ``..``."""
    return _sanitize_segment(name) or "untitled"


def normalize_kind(kind):
    """Retourne le type normalisé, ou lève si inconnu."""
    k = str(kind or "").strip().lower()
    if k not in MEDIA_KINDS:
        raise MediaUploadError(f"Type de média non reconnu : {kind!r} (image/video/audio)")
    return k


def normalize_ext(ext):
    ext = str(ext or "").strip().lower()
    if ext and not ext.startswith("."):
        ext = "." + ext
    return ext


def validate_ext(kind, ext):
    """Lève si l'extension n'est pas autorisée pour ce type."""
    if ext not in _EXT_BY_KIND.get(kind, set()):
        raise MediaUploadError(f"Extension {ext!r} invalide pour le type {kind!r}")


def build_remote_path(user_id, subfolder, filename, ext):
    """Chemin server relatif attendu ``media/<user>/<sub>/<name><ext>``.

    Utile pour les tests et l'affichage : la construction faisant foi reste
    celle du backend (qui re-sanitize).
    """
    safe_uid = re.sub(r"[^A-Za-z0-9_-]", "_", str(user_id or "")) or "unknown"
    parts = ["media", safe_uid]
    sub = sanitize_subfolder(subfolder)
    if sub:
        parts.append(sub)
    return "/".join(parts) + "/" + sanitize_base_filename(filename) + normalize_ext(ext)


# ── Credentials ───────────────────────────────────────────────────────

def _get_credentials():
    """(api_url, api_key) lus depuis user/default/aih/credentials.json."""
    from aih import credentials

    return credentials.get_api_url(), credentials.get_api_key()


# ── Upload chunké ─────────────────────────────────────────────────────

def _error_text(resp, limit=300):
    try:
        data = resp.json()
        if isinstance(data, dict) and data.get("error"):
            return str(data["error"])
    except Exception:
        pass
    text = getattr(resp, "text", "") or ""
    return text[:limit] or f"HTTP {resp.status_code}"


def upload_media(file_path, subfolder, filename_base, ext, kind,
                 prompt="", workflow="", on_progress=None, chunk_size=None):
    """Upload un média en chunks vers le backend AIH.

    Args:
        file_path: chemin local du média à envoyer.
        subfolder: sous-dossier cible (sanitizé ici, re-sanitizé côté serveur).
        filename_base: nom de base SANS extension.
        ext: extension avec point (``.png``…).
        kind: ``image`` | ``video`` | ``audio``.
        prompt: texte du prompt (persisté avec le média).
        workflow: JSON du workflow (persisté avec le média).
        on_progress: callback ``(sent, total)`` optionnel.
        chunk_size: taille de chunk (défaut : imposée par le serveur).

    Returns:
        dict: réponse ``complete`` enrichie de ``{"success": True}``.

    Raises:
        MediaUploadError: serveur non configuré, injoignable, chunk refusé ou
            erreur serveur — l'appelant (node) DOIT propager (échec dur).
    """
    import requests

    api_url, api_key = _get_credentials()
    if not api_url:
        raise MediaUploadError(
            "Serveur AIH non configuré (Settings ▸ onglet « AIH · Compte »)"
        )
    if not api_key:
        raise MediaUploadError(
            "Clé API AIH non configurée (Settings ▸ onglet « AIH · Compte »)"
        )

    kind = normalize_kind(kind)
    ext = normalize_ext(ext)
    validate_ext(kind, ext)
    filename_base = sanitize_base_filename(filename_base)
    subfolder = sanitize_subfolder(subfolder)

    try:
        size = os.path.getsize(file_path)
    except OSError as e:
        raise MediaUploadError(f"Média introuvable : {file_path} ({e})") from e
    if size <= 0:
        raise MediaUploadError(f"Média vide : {file_path}")

    headers = {"Authorization": f"Bearer {api_key}"}
    init_payload = {
        "filename": filename_base,
        "ext": ext,
        "size": size,
        "kind": kind,
        "subfolder": subfolder,
        "prompt": prompt or "",
        "workflow": workflow or "",
    }

    # 1. Init
    try:
        resp = requests.post(
            f"{api_url}/media/init",
            json=init_payload,
            headers={**headers, "Content-Type": "application/json"},
            timeout=60,
        )
    except Exception as e:
        raise MediaUploadError(f"Serveur AIH injoignable (init) : {e}") from e
    if not resp.ok:
        raise MediaUploadError(f"Init upload refusé : HTTP {resp.status_code} {_error_text(resp)}")

    init_data = resp.json()
    upload_id = init_data["upload_id"]
    srv_chunk_size = init_data.get("chunk_size") or chunk_size
    total_chunks = int(init_data["total_chunks"])
    if not srv_chunk_size or total_chunks < 1:
        raise MediaUploadError("Réponse d'init invalide (chunk_size/total_chunks)")

    # 2. Chunks
    multipart_name = f"{filename_base}{ext}"
    try:
        with open(file_path, "rb") as f:
            for i in range(total_chunks):
                chunk = f.read(srv_chunk_size)
                if not chunk and i < total_chunks - 1:
                    raise MediaUploadError(
                        f"Lecture interrompue du média (chunk {i}/{total_chunks} vide)"
                    )
                resp = requests.post(
                    f"{api_url}/media/chunk",
                    data={"upload_id": upload_id, "chunk_index": str(i)},
                    files={"data": (multipart_name, chunk)},
                    headers=headers,
                    timeout=600,
                )
                if not resp.ok:
                    raise MediaUploadError(
                        f"Chunk {i}/{total_chunks} rejeté : HTTP {resp.status_code} {_error_text(resp)}"
                    )
                if on_progress:
                    try:
                        on_progress(i + 1, total_chunks)
                    except Exception:
                        pass
    except MediaUploadError:
        raise
    except Exception as e:
        raise MediaUploadError(f"Upload interrompu (chunk) : {e}") from e

    # 3. Complete
    try:
        resp = requests.post(
            f"{api_url}/media/complete",
            json={"upload_id": upload_id},
            headers={**headers, "Content-Type": "application/json"},
            timeout=300,
        )
    except Exception as e:
        raise MediaUploadError(f"Serveur AIH injoignable (complete) : {e}") from e
    if not resp.ok:
        raise MediaUploadError(f"Finalisation refusée : HTTP {resp.status_code} {_error_text(resp)}")

    result = resp.json()
    if not isinstance(result, dict) or not result.get("path"):
        raise MediaUploadError("Réponse de finalisation invalide (path manquant)")

    logging.info(f"[AIH media] Upload OK: {multipart_name} → {result.get('path')}")
    return {"success": True, **result}
