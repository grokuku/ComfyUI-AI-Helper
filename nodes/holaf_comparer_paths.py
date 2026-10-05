# Copyright (C) 2026 Holaf
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""AIHRemoteComparer — détection « chaîne -> chemin de fichier » et service.

Ce module est VOLONTAIREMENT pur (aucun import de ``torch``/``server``) afin
d'être testable sans le runtime ComfyUI. Le node ``holaf_remote_comparer.py``
n'ajoute qu'UNE branche : si une entrée reçoit une CHAÎNE qui désigne un
fichier EXISTANT, on affiche ce fichier ; tout le reste (tensors IMAGE, dict
AUDIO ``{waveform, sample_rate}``, dicts/objets d'autres nodes, etc.) continue
de passer par le chemin de code existant, inchangé.

Décisions (chemin LOCAL à la machine qui exécute ComfyUI) :
  * Le fichier doit EXISTER et être un fichier ordinaire (jamais un dossier) ;
    aucun listing de dossier n'est exposé, les refus sont journalisés.
  * Une chaîne qui n'est PAS un chemin (ex. un mot, un prompt) est IGNORÉE
    silencieusement -> comportement habituel (aucune erreur parasite).
  * Un chemin absolu est utilisé tel quel (le pack tourne sur un LAN de
    confiance : pas d'auth applicative, décision produit). Un chemin relatif
    est résolu, dans l'ordre, contre les dossiers connus de ComfyUI
    (output/, input/, temp/) puis relativement au cwd (parité historique).
  * Le FICHIER est servi TEL QUEL (jamais ré-encodé, jamais copié) via
    ``web.FileResponse`` qui gère nativement le Range (seek) et le MIME.
"""

import mimetypes
import os

try:  # web est toujours disponible quand ComfyUI sert des routes, mais on
    # tolère l'import pour rendre ce module testable seul.
    from aiohttp import web
except ImportError:  # pragma: no cover - aiohttp est requis en pratique
    web = None


# Genre d'affichage déduit DU FICHIER (extension/MIME réels) — pas une
# énumération de types d'entrée. Sert à choisir <img>/<video>/<audio> côté JS
# et à décider du repli « non prévisualisable ».
IMAGE_EXTS = {
    ".png", ".jpg", ".jpeg", ".jfif", ".webp", ".gif", ".bmp",
    ".tif", ".tiff", ".avif", ".ico",
}
VIDEO_EXTS = {
    ".mp4", ".webm", ".mkv", ".avi", ".mov", ".m4v", ".mpg", ".mpeg",
    ".wmv", ".flv", ".ts", ".m2ts",
}
AUDIO_EXTS = {
    ".wav", ".mp3", ".flac", ".ogg", ".oga", ".opus", ".m4a", ".aac", ".wma",
}

# Codes d'erreur (traduits côté JS -> i18n FR/EN).
ERR_NOT_FOUND = "not_found"
ERR_NOT_A_FILE = "not_a_file"
ERR_INVALID = "invalid"


def guess_genre(path):
    """Genre d'affichage : 'image' | 'video' | 'audio' | 'other'."""
    ext = os.path.splitext(path)[1].lower()
    if ext in VIDEO_EXTS:
        return "video"
    if ext in AUDIO_EXTS:
        return "audio"
    if ext in IMAGE_EXTS:
        return "image"
    mime, _ = mimetypes.guess_type(path)
    if mime:
        if mime.startswith("video/"):
            return "video"
        if mime.startswith("audio/"):
            return "audio"
        if mime.startswith("image/"):
            return "image"
    return "other"


def mimetype_for(path):
    """MIME à annoncer pour ce fichier (défaut octet-stream)."""
    mime, _ = mimetypes.guess_type(path)
    return mime or "application/octet-stream"


def is_servable_file(path):
    """True si path est un fichier ordinaire existant (jamais un dossier)."""
    try:
        return bool(path) and os.path.isfile(path)
    except (OSError, ValueError):
        return False


def known_media_roots():
    """Dossiers ComfyUI servis habituellement (output/input/temp), réalignés.

    Import paresseux de ``folder_paths`` pour rester testable sans ComfyUI.
    """
    roots = []
    try:
        import folder_paths
    except ImportError:
        return roots
    for getter_name in ("get_output_directory", "get_input_directory", "get_temp_directory"):
        getter = getattr(folder_paths, getter_name, None)
        if not callable(getter):
            continue
        try:
            directory = getter()
        except Exception:
            directory = None
        if directory:
            roots.append(os.path.realpath(directory))
    return roots


def _strip(raw):
    """Retire espaces et guillemets englobants (chemins copiés/collés)."""
    s = raw.strip()
    while len(s) >= 2 and s[0] in "\"'`" and s[-1] == s[0]:
        s = s[1:-1].strip()
    return s


def _candidate_paths(s):
    """Candidats à tester, dans l'ordre (absolu tel quel, sinon dossiers connus)."""
    candidates = []
    if os.path.isabs(s):
        candidates.append(s)
    else:
        for root in known_media_roots():
            candidates.append(os.path.join(root, s))
        # Parité historique : l'ancienne branche utilisait os.path.exists(data)
        # (donc relatif au cwd de ComfyUI).
        candidates.append(s)
    # Dédoublonne en conservant l'ordre.
    seen = set()
    unique = []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            unique.append(c)
    return unique


def _looks_like_explicit_path(s):
    """Heuristique : la chaîne PRÉTEND désigner un chemin de fichier.

    Sert à distinguer « clip.mp4 » (chemin manquant -> erreur explicite) d'un
    simple mot/prompt (-> ignoré silencieusement). Volontairement STRICT pour ne
    pas transformer un prompt contenant un « / » en erreur parasite : seuls un
    chemin absolu, un préfixe « ~ » ou une extension de fichier comptent.
    """
    if os.path.isabs(s) or s.startswith("~"):
        return True
    return bool(os.path.splitext(s)[1])


def analyze_input_string(raw):
    """Analyse une valeur reçue sur A/B quand c'est une CHAÎNE.

    Retourne un tuple ``(kind, payload)`` :
      * ``("media", {"path", "genre", "name"})``  fichier existant à afficher ;
      * ``("error", {"code", "detail"})``          chemin voulu mais invalide ;
      * ``("ignore", None)``                        pas un chemin -> habituel.
    """
    if not isinstance(raw, str):
        return ("ignore", None)
    s = _strip(raw)
    if not s:
        return ("ignore", None)
    if "\x00" in s:
        return ("error", {"code": ERR_INVALID, "detail": s})

    s = os.path.expanduser(s)
    for candidate in _candidate_paths(s):
        try:
            if os.path.isdir(candidate):
                return ("error", {"code": ERR_NOT_A_FILE, "detail": candidate})
            if os.path.isfile(candidate):
                abs_path = os.path.abspath(candidate)
                return ("media", {
                    "path": abs_path,
                    "genre": guess_genre(abs_path),
                    "name": os.path.basename(abs_path),
                })
        except (OSError, ValueError):
            continue

    if _looks_like_explicit_path(s):
        return ("error", {"code": ERR_NOT_FOUND, "detail": s})
    return ("ignore", None)


def build_direct_media_meta(info):
    """Méta média « fichier direct » consommable par le comparer JS.

    Ne copie rien : le JS construit l'URL vers la route de service
    (``/holaf/comparer/file``) à partir de ``path``.
    """
    return {
        "filename": info["name"],
        "format": info["genre"],
        "direct": True,
        "path": info["path"],
    }


async def serve_comparer_file(request):
    """GET /holaf/comparer/file?path=... — sert le fichier TEL QUEL.

    FileResponse gère nativement le Range (206/Content-Range/Accept-Ranges) et
    le MIME : aucune recompression, aucune copie. Les refus sont journalisés.
    """
    if web is None:  # pragma: no cover
        raise RuntimeError("aiohttp.web indisponible")

    raw = request.query.get("path", "")
    kind, info = analyze_input_string(raw)

    if kind == "media" and is_servable_file(info["path"]):
        return web.FileResponse(
            info["path"],
            headers={"Content-Type": mimetype_for(info["path"])},
        )

    if kind == "error":
        code = info["code"]
        detail = info["detail"]
    else:
        code = ERR_INVALID
        detail = raw
    print(f"[HolafRemoteComparer] Refused media request ({code}): {detail!r}")
    status = {
        ERR_NOT_FOUND: 404,
        ERR_NOT_A_FILE: 415,
        ERR_INVALID: 400,
    }.get(code, 400)
    return web.Response(status=status, text=f"ERR: {code}: {detail}")
