# === Holaf Utilities - Startup checks (non-blocking, never modifies anything) ===
#
# HISTORICAL NOTE — what this module used to do and why it no longer does it:
# older revisions of this pack tried to "protect" the front-end from an old
# sibling copy of itself (the pack used to be named ComfyUI-Holaf-Utilities).
# They migrated data out of a sibling folder named ComfyUI-Holaf-Utilities,
# renamed the legacy per-user data root, moved the __init__.py of a loadable
# legacy sibling into a quarantine folder, and refused to install/update any
# pack whose folder name or git URL matched a historical name of this pack.
#
# ALL of that has been REMOVED on purpose:
#   - the historical names "ComfyUI-Holaf-Utilities" / "ComfyUI-Holaf-Utils" /
#     "ComfyUI-Holaf" are NOT special. The user may legitimately create a new
#     pack under one of these names one day: blocking its installation or
#     touching its files (even to "neutralise" it) would be an unacceptable
#     breakage. This pack NEVER creates, writes to, moves, renames, deletes or
#     quarantines anything inside a folder named ComfyUI-Holaf* (or any other
#     custom_nodes folder).
#   - the automatic one-shot data migration (Zones A/B) is gone as well: a
#     folder carrying a historical name is not assumed to be THIS pack's old
#     folder anymore, so it must not have its database/config/user-root moved
#     or renamed by us.
#
# The ONLY remaining startup behaviour is a NON-BLOCKING log warning, and it is
# strictly PROOF-BASED: the scan looks at the CONTENT of sibling custom_nodes
# extensions and reports a folder only when it provably serves a STALE copy of
# THIS pack's own web assets, i.e.:
#   * the sibling folder is loadable by ComfyUI (it has __init__.py), AND
#   * it contains one of our own asset relative paths, AND
#   * that file contains our ownership marker ("openModelBrowser"), AND
#   * it has NO build marker ("AIH_MB_BUILD = ...").
# The folder NAME is never used: a future legitimate pack named
# ComfyUI-Holaf* whose JS is current (marker present) stays completely silent.
#
# Why the warning exists at all: ComfyUI loads every custom_nodes folder that
# exposes WEB_DIRECTORY. If a second, still-loadable folder serves a pre-marker
# copy of "js/02_aih_model_browser.js", both copies are imported in the same
# page and the stale one can overwrite window.openModelBrowser -> old Model
# Browser UI (no "Transferts" button / no transfers window) even though the
# file served by the current pack is up to date. The warning explains that
# symptom and the manual remedy; it performs NO action whatsoever.
import os
import re

# Build marker of THIS pack's Model Browser (see js/02_aih_model_browser.js:
# `var AIH_MB_BUILD = "mb-transfers-2026-09-30-r7";`). A pre-marker copy has no
# such assignment at all — that absence is the "old copy" proof.
_BUILD_MARKER_RX = re.compile(r"""AIH_MB_BUILD\s*=\s*["']""")

# Ownership marker: a file that never mentions openModelBrowser is NOT one of
# our Model Browser scripts, whatever its name/path. Both conditions together
# (ownership present, build marker absent) make the detection an evidence
# check, never a folder-name check.
_OWNERSHIP_MARKER = "openModelBrowser"

# Relative asset paths that only THIS pack ships as its own web assets.
_WEB_ASSET_RELATIVE_PATHS = (
    os.path.join("js", "02_aih_model_browser.js"),
)

# Refuse to load absurdly large files (a candidate is a JS module, not a dump).
_MAX_JS_READ_BYTES = 5 * 1024 * 1024


def _same_path(a, b):
    """Case/separator-insensitive equality check for two absolute paths."""
    return os.path.normcase(os.path.normpath(os.path.abspath(a))) == \
           os.path.normcase(os.path.normpath(os.path.abspath(b)))


def _looks_like_stale_own_web_asset(path):
    """True when ``path`` is one of OUR web files WITHOUT the current build marker.

    Read-only: the file is opened for reading and never written. Any I/O error
    means "not provable" → False (we only ever warn on positive proof).
    """
    try:
        if os.path.getsize(path) > _MAX_JS_READ_BYTES:
            return False
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        return False
    if _OWNERSHIP_MARKER not in text:
        return False  # not one of our scripts
    return _BUILD_MARKER_RX.search(text) is None


def find_stale_own_web_copies(current_dir=None):
    """Return the list of PROVEN stale copies of our web assets in siblings.

    Scans the sibling folders of ``current_dir`` (i.e. the other extensions in
    ``custom_nodes/``) and returns the absolute path of every loadable sibling
    file that is one of our asset paths, contains the ownership marker and has
    NO build marker. The folder name is deliberately ignored.

    @param current_dir: this pack's root directory (defaults to the directory
        containing this module). Exposed mainly so tests can point it at a
        temporary tree.
    @returns: sorted list of absolute paths (empty when nothing is provable).
    """
    if current_dir is None:
        current_dir = os.path.dirname(os.path.abspath(__file__))
    found = []
    try:
        current = os.path.abspath(current_dir)
        parent = os.path.dirname(current)
        if not os.path.isdir(parent):
            return []
        for name in sorted(os.listdir(parent), key=str.lower):
            sibling = os.path.join(parent, name)
            try:
                if not os.path.isdir(sibling) or _same_path(sibling, current):
                    continue
                # ComfyUI only loads a custom_nodes folder exposing __init__.py;
                # a folder without it cannot be served → no double import risk.
                if not os.path.isfile(os.path.join(sibling, "__init__.py")):
                    continue
                for relative in _WEB_ASSET_RELATIVE_PATHS:
                    candidate = os.path.join(sibling, relative)
                    if os.path.isfile(candidate) and _looks_like_stale_own_web_asset(candidate):
                        found.append(os.path.abspath(candidate))
            except OSError:
                continue
    except Exception:
        # A startup check must NEVER prevent the extension from starting.
        return []
    return sorted(found, key=str.lower)


def _warn_stale_own_web_copies(current_dir=None):
    """Print a NON-BLOCKING, actionable warning for each proven stale copy.

    Nothing is created, moved, renamed, deleted or blocked: the message only
    explains the possible UI overwrite and the manual remedy.

    @returns: the list of stale paths (same as find_stale_own_web_copies).
    """
    stale = find_stale_own_web_copies(current_dir)
    if not stale:
        return stale
    print(
        "⚠️  [Holaf-Startup] ANCIENNE COPIE de nos scripts Model Browser détectée :\n"
        + "".join(f"    - {path}\n" for path in stale)
        + "    Ce(s) dossier(s) sont chargés par ComfyUI EN PLUS du pack courant :\n"
        "    les deux copies de '02_aih_model_browser.js' (l'ancienne sans marqueur\n"
        "    de build, la nouvelle avec) sont importées dans la même page, et\n"
        "    l'ancienne peut écraser window.openModelBrowser → UI ancienne (pas de\n"
        "    bouton « Transferts », pas de fenêtre de transferts) même si le\n"
        "    fichier servi par le pack courant est à jour.\n"
        "    AUCUN fichier n'a été modifié ni bloqué par ce contrôle : supprimez\n"
        "    ou renommez vous-même le dossier concerné, puis redémarrez ComfyUI\n"
        "    et rechargez la page en forcé (Ctrl+Shift+R).\n"
    )
    return stale


def run_startup_checks(current_dir=None):
    """Entry point called at the very beginning of package initialisation.

    Non-blocking and read-only: it only logs the proof-based stale-copy warning
    described at the top of this module. It NEVER creates, writes to, moves,
    renames, deletes or quarantines any folder/file — in particular nothing is
    ever done to a folder named ComfyUI-Holaf*.

    @param current_dir: this pack's root (defaults to this module's directory;
        exposed for tests).
    @returns: list of proven stale web-asset paths (possibly empty).
    """
    try:
        return _warn_stale_own_web_copies(current_dir)
    except Exception as e:
        print(f"🟡 [Holaf-Startup] Stale web-asset check failed: {e}")
        return []
