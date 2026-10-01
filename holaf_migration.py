# === Holaf Utilities - Legacy Data Migration ===
#
# One-shot automatic migration triggered at the very beginning of package
# initialisation (before the database, cache, config or temp directories are
# opened anywhere else). It handles the rename of the extension folder
# (ComfyUI-Holaf-Utilities -> ComfyUI-AI-Helper) without any perceived data
# loss for the user.
#
# Two zones are migrated:
#   Zone A - artefacts living INSIDE the extension folder (relative to the
#            location of this file): database (+ WAL/SHM), thumbnail cache,
#            config.ini, temp upload/export dirs. The source is a sibling
#            folder named "ComfyUI-Holaf-Utilities".
#   Zone B - the per-user data root under ComfyUI/user/default/
#            ("ComfyUI-Holaf-Utilities" -> "AI-Helper").
#
# Safety rules:
#   - MOVE (rename) instead of copy+delete whenever possible (atomic on the
#     same filesystem, no duplicated disk space).
#   - NEVER overwrite newer data already present at the destination: on
#     conflict the NEW side is kept and the OLD side is left untouched
#     (no merge, no deletion).
#   - NEVER delete the legacy folder itself: the user cleans it up manually.
#   - Each individual move is wrapped in its own try/except so one failure
#     never blocks the others.
#   - Idempotent: once artefacts have been moved (or left as conflicts), the
#     next startup finds nothing to do and stays completely silent.
import os
import shutil

# --- Constants ---
LEGACY_EXTENSION_DIR_NAME = "ComfyUI-Holaf-Utilities"
NEW_USER_DATA_ROOT_NAME = "AI-Helper"

# Zone A artefacts, checked in this order. ".cache" is moved wholesale (it
# only holds generated thumbnails; same-filesystem rename is instantaneous).
_ZONE_A_ARTIFACTS = [
    "holaf_utilities.sqlite",
    "holaf_utilities.sqlite-wal",
    "holaf_utilities.sqlite-shm",
    ".cache",
    "config.ini",
    "temp_uploads",
    "temp_exports",
]


def _same_path(a, b):
    """Case/separator-insensitive equality check for two absolute paths."""
    return os.path.normcase(os.path.normpath(os.path.abspath(a))) == \
           os.path.normcase(os.path.normpath(os.path.abspath(b)))


def _get_user_base_path():
    """
    Mirrors UserDataManager.get_user_base_path() WITHOUT any side effect
    (get_root_path() creates directories, which would defeat the
    'destination absent' check below).

    Returns None when ComfyUI's folder_paths module is unavailable (e.g.
    running outside ComfyUI): Zone B is then simply skipped.
    """
    try:
        import folder_paths
    except ImportError:
        return None
    base_path = getattr(folder_paths, "base_path", None)
    if not base_path:
        return None
    return os.path.join(base_path, "user", "default")


def _migrate_zone_a_artifact(name, old_dir, new_dir):
    """
    Migrates a single Zone A artefact.

    Returns one of: 'moved', 'conflict', 'absent'.
    Raises on unexpected I/O errors (caught by the caller).
    """
    src = os.path.join(old_dir, name)
    dst = os.path.join(new_dir, name)

    if not os.path.exists(src):
        return "absent"

    if os.path.exists(dst):
        # Never overwrite newer data: keep the NEW side, leave the old copy
        # in place (no merge, no deletion).
        print(f"⚠️ [Holaf-Migration] '{name}' exists in BOTH "
              f"'{old_dir}' and '{new_dir}'. Keeping the NEW one; "
              f"old copy left untouched (no merge, manual cleanup required).")
        return "conflict"

    shutil.move(src, dst)
    print(f"🔵 [Holaf-Migration] Moved '{name}':\n"
          f"    from: {src}\n    to:   {dst}")
    return "moved"


def find_legacy_extension_double_load(current_dir):
    """
    Détecte un dossier legacy SIBLING encore chargé par ComfyUI (double pack).

    Pourquoi : la migration ne supprime JAMAIS le dossier legacy. Or ComfyUI
    charge TOUT dossier de ``custom_nodes/`` exposant ``WEB_DIRECTORY`` : si
    ``ComfyUI-Holaf-Utilities/`` existe encore à côté du dossier courant, ses
    anciens ``__init__.py``/``js/`` sont chargés EN PLUS des nouveaux. Le front
    importe alors TOUS les .js des deux préfixes ``/extensions/<nom>/`` en
    parallèle : deux copies de ``02_aih_model_browser.js`` coexistent, une
    copie périmée peut écraser ``window.openModelBrowser`` et l'UI ouverte est
    l'ancienne (pas de bouton « Transferts », pas de fenêtre de transferts,
    progression en ligne seule) — même si le fichier SERVI et
    ``window.AIH_MB.build`` sont à jour.

    @param current_dir: dossier du pack courant (racine de l'extension).
    @returns: chemin du dossier legacy s'il est encore chargeable, sinon None.
    """
    try:
        current = os.path.abspath(current_dir)
        legacy = os.path.join(os.path.dirname(current), LEGACY_EXTENSION_DIR_NAME)
        if _same_path(legacy, current) or not os.path.isdir(legacy):
            return None
        # Un dossier sans __init__.py n'est PAS chargé par ComfyUI : rien à
        # signaler (l'utilisateur a déjà neutralisé l'ancien pack).
        if not os.path.isfile(os.path.join(legacy, "__init__.py")):
            return None
        return legacy
    except Exception:
        return None


def _warn_legacy_double_load(current_dir):
    """Avertit BRUYAMMENT tant que le pack legacy est encore chargeable.

    Appelée à CHAQUE démarrage (pas seulement quand quelque chose a été
    migré) : sans ce signal, un utilisateur peut ne jamais comprendre pourquoi
    son navigateur exécute encore l'ancien JS d'un pack doublement chargé.
    """
    legacy = find_legacy_extension_double_load(current_dir)
    if not legacy:
        return
    print(
        "⚠️  [Holaf-Migration] DOUBLE CHARGEMENT DÉTECTÉ : le dossier legacy\n"
        f"    '{legacy}'\n"
        "    est encore chargeable par ComfyUI en plus du pack courant.\n"
        "    Deux copies des mêmes scripts JS seront servies sous deux préfixes\n"
        "    '/extensions/<nom>/' et importées EN PARALLÈLE : une copie PÉRIMÉE\n"
        "    peut écraser window.openModelBrowser (UI ancienne sans bouton\n"
        "    « Transferts » ni fenêtre de transferts, alors que le fichier servi\n"
        "    est à jour). Remède : supprimer (ou renommer) le dossier legacy,\n"
        "    puis redémarrer ComfyUI et recharger la page en forcé.\n"
    )


def _migrate_zone_a(stats):
    """
    Zone A: migrate artefacts from the legacy sibling extension folder into
    the current one. Silent no-op when the legacy folder does not exist.
    """
    current_dir = os.path.dirname(os.path.abspath(__file__))
    old_dir = os.path.join(os.path.dirname(current_dir), LEGACY_EXTENSION_DIR_NAME)

    # Extension still running from its legacy folder (or legacy folder absent):
    # nothing to migrate.
    if not os.path.isdir(old_dir) or _same_path(old_dir, current_dir):
        return

    for name in _ZONE_A_ARTIFACTS:
        try:
            result = _migrate_zone_a_artifact(name, old_dir, current_dir)
            if result == "moved":
                stats["moved"] += 1
            elif result == "conflict":
                stats["conflicts"] += 1
        except Exception as e:
            stats["errors"] += 1
            print(f"🔴 [Holaf-Migration] Failed to migrate '{name}' from "
                  f"'{old_dir}' to '{current_dir}': {e}")

    if stats["moved"] or stats["conflicts"] or stats["errors"]:
        try:
            leftovers = sorted(os.listdir(old_dir))
        except OSError:
            leftovers = []
        if leftovers:
            print(f"⚠️ [Holaf-Migration] Legacy extension folder NOT deleted "
                  f"(kept intact for safety). Remaining contents you can "
                  f"review/delete manually: {leftovers}")
        else:
            print(f"🔵 [Holaf-Migration] Legacy extension folder is now "
                  f"empty of tracked data; it was NOT deleted "
                  f"(you can remove it manually: {old_dir})")


def _migrate_zone_b(stats):
    """
    Zone B: rename <user>/default/ComfyUI-Holaf-Utilities ->
    <user>/default/AI-Helper. Silent no-op when the legacy root is absent.
    """
    base = _get_user_base_path()
    if not base:
        return

    old_root = os.path.join(base, LEGACY_EXTENSION_DIR_NAME)
    new_root = os.path.join(base, NEW_USER_DATA_ROOT_NAME)

    if not os.path.isdir(old_root) or _same_path(old_root, new_root):
        return

    if os.path.exists(new_root):
        print(f"⚠️ [Holaf-Migration] User data root exists in BOTH "
              f"'{old_root}' and '{new_root}'. Keeping the NEW one; "
              f"old root left untouched (no merge, manual cleanup required).")
        stats["conflicts"] += 1
        return

    try:
        # Same parent directory => same filesystem => atomic readdir rename.
        os.rename(old_root, new_root)
    except OSError:
        # Extremely defensive fallback (exotic mounts); move preserves data.
        shutil.move(old_root, new_root)

    stats["moved"] += 1
    print(f"🔵 [Holaf-Migration] Moved user data root:\n"
          f"    from: {old_root}\n    to:   {new_root}")


def run_data_migration():
    """
    Entry point. Must be called at the VERY TOP of __init__.py, BEFORE any
    other initialisation touches the database, thumbnail cache, config.ini,
    temp directories or the user data root.

    Completely silent (fast no-op) when there is nothing to migrate. A global
    guard per zone guarantees that a migration failure can never prevent the
    extension itself from starting.
    """
    stats = {"moved": 0, "conflicts": 0, "errors": 0}
    try:
        _migrate_zone_a(stats)
    except Exception as e:
        stats["errors"] += 1
        print(f"🔴 [Holaf-Migration] Unexpected Zone A failure: {e}")
    try:
        _migrate_zone_b(stats)
    except Exception as e:
        stats["errors"] += 1
        print(f"🔴 [Holaf-Migration] Unexpected Zone B failure: {e}")

    # Toujours : signaler un éventuel pack legacy ENCORE chargé par ComfyUI
    # (double import des scripts front — cause prouvée d'UI « ancienne » malgré
    # un fichier servi à jour).
    try:
        _warn_legacy_double_load(os.path.dirname(os.path.abspath(__file__)))
    except Exception as e:
        print(f"🟡 [Holaf-Migration] Legacy double-load check failed: {e}")

    if stats["moved"] or stats["conflicts"] or stats["errors"]:
        print(f"✅ [Holaf-Migration] Data migration finished: "
              f"{stats['moved']} item(s) moved, "
              f"{stats['conflicts']} conflict(s) kept on the NEW side, "
              f"{stats['errors']} error(s).")
