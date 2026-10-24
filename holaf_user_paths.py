# === Holaf Utilities - User data paths (SINGLE SOURCE OF TRUTH) ===
#
# POURQUOI CE MODULE
# ------------------
# Motif utilisateur, cité tel quel : « mon but c'est d'alléger mon dossier de
# custom nodes ». Sur l'installation déployée du pack, le dossier
# custom_nodes/ComfyUI-AI-Helper pesait ~1,8 Go, dont holaf_utilities.sqlite à
# lui seul 1,8 Go (le reste : docs 7 Mo, js 3,2 Mo, nodes 1,2 Mo, aih 630 Ko).
# Trois raisons à cette migration, dans cet ordre :
#   1. ALLÉGER custom_nodes/ComfyUI-AI-Helper : une base de 1,8 Go n'a rien à
#      faire dans un dossier de code ;
#   2. SURVIVRE à une réinstallation / mise à jour du pack (ComfyUI Manager
#      remplace le dossier : les données ne doivent pas partir avec) ;
#   3. SÉPARER code et données pour la sauvegarde (on sauvegarde
#      user/default/AI-Helper/ sans embarquer le code, et inversement).
# Il ne s'agit PAS d'un problème de dépôt git : cette base n'est pas versionnée
# (cf. .gitignore : *.sqlite, *.sqlite-wal, *.sqlite-shm, *.sqlite.backup_*).
#
# ARBORESCENCE CIBLE (actée), surchargeable par l'env AIH_USER_ROOT :
#
#   <ComfyUI>/user/default/AI-Helper/
#   ├── db/        holaf_utilities.sqlite (+ -wal/-shm) · aihelper.db (+ …)
#   ├── profiler/  holaf_profiler.db          (déjà là : rien à déplacer)
#   ├── config/    config.ini · credentials.json · openai_keys.json
#   │              blobby.json · sftp_known_hosts
#   ├── presets/   aih_elements_presets.json
#   ├── data/      music3/{manifest.json,references/}
#   ├── backups/   holaf_utilities.sqlite.backup_*
#   ├── cache/     thumbnails/
#   └── .migration.json (+ .migration.lock)   ← audit seulement
#
# RESTENT DEHORS (jamais migrés) : temp_uploads/ et temp_exports/ (purgés au
# démarrage, cf. holaf_utils : ils doivent viser le dossier temporaire de
# ComfyUI), <user>/default/workflows/ (PARTAGÉ avec le core ComfyUI : ne pas
# toucher), output/, models/, bin/, __pycache__.
#
# ÉTAT DE CE CHANTIER
# -------------------
# Phase 1 : socle (helper de chemins, moteur de migration, point d'entrée
# __init__.py, garde anti-test).
# Phase 2 : TOUS les consommateurs lisent désormais ce module via les
# accesseurs `resolved_*` (repli automatique sur l'ancien chemin tant que rien
# n'a été déplacé : comportement IDENTIQUE sur une installation non migrée).
#
# ⚠️ RISQUE ÉCARTÉ (garde-fou permanent, voir CONSUMERS_WIRED) : la migration
# DÉPLACE la base holaf_utilities.sqlite (1,8 Go) et les autres données hors du
# pack. Si un seul consommateur lisait encore l'ancien chemin, la migration
# ferait perdre ses données à l'utilisateur (base neuve et vide à la place des
# modèles indexés, tags, stats). La migration ne peut donc s'exécuter QUE
# lorsque `CONSUMERS_WIRED` vaut True ET que AIH_USER_MIGRATION_ENABLED ne la
# désactive pas. Tant que `CONSUMERS_WIRED` est False, RIEN n'est déplacé,
# quels que soient l'env et `force=True`.
#
# ⚠️ DIVERGENCE CORRIGÉE ICI : holaf_user_data_manager.UserDataManager
# compose en dur "<folder_paths.base_path>/user/default" alors que
# aih/store.py, aih/routes.py et aih/credentials.py passent par
# folder_paths.get_user_directory(). Dès que ComfyUI tourne avec
# --user-directory (ou COMFYUI_USER), les deux familles de chemins DIVERGENT.
# get_comfy_user_dir() ci-dessous prend get_user_directory() D'ABORD : c'est
# désormais l'unique résolution de référence.

import errno
import glob
import json
import os
import shutil
import sqlite3
import threading
import time

try:  # POSIX ; sous Windows (pas de fcntl) le verrou O_EXCL reste suffisant.
    import fcntl
except ImportError:  # pragma: no cover - dépend de la plateforme
    fcntl = None

# --- Constantes publiques ------------------------------------------------
ROOT_NAME = "AI-Helper"
DEFAULT_USER_PROFILE = "default"

# Racine de CE pack (dossier custom_nodes/ComfyUI-AI-Helper).
PACK_ROOT = os.path.dirname(os.path.abspath(__file__))

ENV_USER_ROOT = "AIH_USER_ROOT"
ENV_SKIP_MIGRATION = "AIH_SKIP_USER_MIGRATION"
ENV_SFTP_KNOWN_HOSTS = "AIH_SFTP_KNOWN_HOSTS"
# Interrupteur explicite : "0"/"false" = ne rien déplacer ; "1"/"true" =
# autoriser (mais JAMAIS si CONSUMERS_WIRED est False). Absent = valeur de
# CONSUMERS_WIRED.
ENV_MIGRATION_ENABLED = "AIH_USER_MIGRATION_ENABLED"

JOURNAL_FILENAME = ".migration.json"
LOCK_FILENAME = ".migration.lock"
MARKER_FILENAME = "MIGRATED_TO_AI-HELPER.txt"

# Un verrou plus vieux que ça est considéré PÉRIMÉ (processus tué, machine
# redémarrée…). Il est loggé puis cassé, sinon une migration ne redémarrerait
# jamais après un crash.
LOCK_STALE_SECONDS = 600

DB_UTILS_FILENAME = "holaf_utilities.sqlite"
DB_UTILS_BACKUP_PATTERN = DB_UTILS_FILENAME + ".backup_*"
DB_AIH_FILENAME = "aihelper.db"
DB_PROFILER_FILENAME = "holaf_profiler.db"

_TRUTHY = ("1", "true", "yes", "on")
_FALSEY = ("0", "false", "no", "off", "")

# ---------------------------------------------------------------------------
# GARDE-FOU PERMANENT : les consommateurs lisent-ils TOUS ce module ?
# ---------------------------------------------------------------------------
# La migration DÉPLACE les données utilisateur hors du pack. Elle n'est donc
# légitime que si TOUS les consommateurs listés en fin de fichier lisent les
# accesseurs de ce module : sinon le pack recréerait une base neuve et vide à
# l'ancien emplacement et ignorerait les données déplacées (perte silencieuse).
#
# Défaut sûr : False = NE RIEN DÉPLACER. Cette constante n'est pas contournable
# par l'environnement ni par force=True : elle ne devient True qu'à la fin de
# la phase 2, quand le branchement est prouvé par les tests.
CONSUMERS_WIRED = True


# ---------------------------------------------------------------------------
# Logger minimal (injectable dans les tests : aucun bruit)
# ---------------------------------------------------------------------------
class _PrintLogger:
    """Logger par défaut : print préfixé (le pack n'utilise pas logging partout)."""

    def _emit(self, prefix, message):
        print(f"{prefix} [Holaf-UserPaths] {message}")

    def info(self, message):
        self._emit("🔵", message)

    def warning(self, message):
        self._emit("🟡", message)

    def error(self, message):
        self._emit("🔴", message)


_DEFAULT_LOGGER = _PrintLogger()


def _truthy(value):
    """True si la valeur d'environnement ressemble à une activation."""
    return str(value if value is not None else "").strip().lower() in _TRUTHY


def migration_enabled():
    """La migration est-elle autorisée par la configuration ?

    Ordre : `CONSUMERS_WIRED` est ABSOLU (False ⇒ jamais de migration, même
    avec AIH_USER_MIGRATION_ENABLED=1). Ensuite l'env explicite :
      - "1"/"true"/"yes"/"on" → autorisé ;
      - "0"/"false"/"no"/"off" → refusé (opt-out) ;
      - absent → autorisé (la constante fait foi).

    Retourne:
        bool: True si la migration peut s'exécuter.
    """
    if not CONSUMERS_WIRED:
        return False
    raw = str(os.environ.get(ENV_MIGRATION_ENABLED, "")).strip().lower()
    if not raw:
        return True
    if raw in _FALSEY:
        return False
    if raw in _TRUTHY:
        return True
    return True


# ---------------------------------------------------------------------------
# Résolution de la racine ComfyUI « user »
# ---------------------------------------------------------------------------
def _safe_call(func, *args):
    """Appelle `func` en avalant toute exception (folder_paths peut être partiel).

    folder_paths est un module GLOBAL de ComfyUI : selon la version et le moment
    de l'import, get_user_directory() peut lever (initialisation en cours) ou
    ne pas exister. Un repli silencieux est ici le comportement ATTENDU.
    """
    try:
        return func(*args)
    except Exception:  # noqa: BLE001 — repli attendu : module global partiel
        return None


def _folder_paths_module():
    """Import paresseux de folder_paths (absent hors runtime ComfyUI)."""
    try:
        # Import volontairement paresseux : hors ComfyUI le module n'existe pas.
        import folder_paths
        return folder_paths
    except Exception:  # noqa: BLE001 — hors ComfyUI : absence normale
        return None


def folder_paths_available():
    """True si ComfyUI est importable ET expose une racine utilisateur."""
    module = _folder_paths_module()
    if module is None:
        return False
    getter = getattr(module, "get_user_directory", None)
    if callable(getter) and _safe_call(getter):
        return True
    return bool(getattr(module, "base_path", None))


def get_comfy_user_dir():
    """Dossier `<ComfyUI>/user` — résolution de RÉFÉRENCE.

    Ordre (identique à ce qu'attendent aih/store.py & co, mais un seul endroit) :
      1. folder_paths.get_user_directory()  ← gère --user-directory
      2. folder_paths.base_path + "/user"   ← repli
      3. ~/.config/comfyui                  ← dernier recours (hors ComfyUI)

    Retourne:
        str: chemin absolu, sans création de dossier.
    """
    module = _folder_paths_module()
    if module is not None:
        getter = getattr(module, "get_user_directory", None)
        user_dir = _safe_call(getter) if callable(getter) else None
        if user_dir:
            return os.path.abspath(user_dir)
        base = getattr(module, "base_path", None)
        if base:
            return os.path.abspath(os.path.join(base, "user"))
    return os.path.expanduser(os.path.join("~", ".config", "comfyui"))


def _env_user_root():
    """Valeur normalisée de AIH_USER_ROOT ('' si non définie)."""
    raw = os.environ.get(ENV_USER_ROOT, "")
    raw = str(raw).strip()
    if not raw:
        return ""
    return os.path.abspath(os.path.expanduser(raw))


def get_user_root(root=None):
    """Racine des données utilisateur du pack.

    Ordre de précédence : argument explicite > env AIH_USER_ROOT > défaut
    `<ComfyUI>/user/default/AI-Helper`.

    Retourne:
        str: chemin absolu (AUCUNE création : voir ensure_user_data_layout).
    """
    if root:
        return os.path.abspath(os.path.expanduser(str(root)))
    env_root = _env_user_root()
    if env_root:
        return env_root
    return os.path.join(get_comfy_user_dir(), DEFAULT_USER_PROFILE, ROOT_NAME)


# ---------------------------------------------------------------------------
# Accesseurs des chemins CIBLES (purs : ils ne créent rien)
# ---------------------------------------------------------------------------
def _under(root, *parts):
    return os.path.join(get_user_root(root), *parts)


def p_db_utils(root=None):
    """Base principale du pack (ex-custom_nodes/…/holaf_utilities.sqlite)."""
    return _under(root, "db", DB_UTILS_FILENAME)


def p_db_aih(root=None):
    """Base miroir AIH (ex-<user>/default/aih/data/aihelper.db)."""
    return _under(root, "db", DB_AIH_FILENAME)


def p_db_profiler(root=None):
    """Base du profiler (déjà à sa place finale : profiler/)."""
    return _under(root, "profiler", DB_PROFILER_FILENAME)


def p_config(root=None):
    """config.ini des panneaux (ex-config.ini à la racine du pack)."""
    return _under(root, "config", "config.ini")


def p_credentials(root=None):
    """credentials.json (serveur distant + api_key)."""
    return _under(root, "config", "credentials.json")


def p_openai_keys(root=None):
    """openai_keys.json (clé de secours côté node OpenAI Settings)."""
    return _under(root, "config", "openai_keys.json")


def p_presets(root=None):
    """Presets de l'Elements Picker."""
    return _under(root, "presets", "aih_elements_presets.json")


def p_blobby(root=None):
    """Paramètres du Blobby Companion (dont blobbyShellAccess)."""
    return _under(root, "config", "blobby.json")


def p_known_hosts(root=None):
    """Clés d'hôte SFTP (TOFU). AIH_SFTP_KNOWN_HOSTS reste PRIORITAIRE."""
    explicit = str(os.environ.get(ENV_SFTP_KNOWN_HOSTS, "")).strip()
    if explicit:
        return os.path.abspath(os.path.expanduser(explicit))
    return _under(root, "config", "sftp_known_hosts")


def p_music3_dir(root=None):
    """Miroir local music3 (manifest.json + references/)."""
    return _under(root, "data", "music3")


def p_thumb_cache(root=None):
    """Cache des miniatures (ex-.cache/thumbnails dans le pack)."""
    return _under(root, "cache", "thumbnails")


def p_backups_dir(root=None):
    """Sauvegardes de migration de schéma de la base principale."""
    return _under(root, "backups")


def p_journal(root=None):
    """Journal d'audit de la migration (jamais un drapeau bloquant)."""
    return _under(root, JOURNAL_FILENAME)


def p_lock(root=None):
    """Verrou inter-processus de la migration."""
    return _under(root, LOCK_FILENAME)


# ---------------------------------------------------------------------------
# Chemins LEGACY (à NE PAS SUPPRIMER : la migration et la phase 2 en dépendent,
# et un rollback doit rester possible)
# ---------------------------------------------------------------------------
def legacy_aih_dir(comfy_user_dir=None):
    """<user>/default/aih — socle AIH historique (store/credentials/routes)."""
    base = comfy_user_dir or get_comfy_user_dir()
    return os.path.join(base, DEFAULT_USER_PROFILE, "aih")


def legacy_aihelper_dir(comfy_user_dir=None):
    """<user>/default/aihelper — arborescence pré-aih (music3, aihelper.db)."""
    base = comfy_user_dir or get_comfy_user_dir()
    return os.path.join(base, DEFAULT_USER_PROFILE, "aihelper")


def legacy_pack_root():
    """Dossier du pack = custom_nodes/ComfyUI-AI-Helper (données historiques)."""
    return PACK_ROOT


# ---------------------------------------------------------------------------
# PHASE 2 — Résolution « nouveau chemin SI migré, sinon ancien » pour les
# consommateurs. C'est CE point d'entrée que les modules historiques utilisent :
# sans migration (ou avant elle), ils retrouvent exactement leurs anciens
# chemins → comportement inchangé, aucune donnée inventée.
# ---------------------------------------------------------------------------
def user_layout_adopted():
    """La nouvelle arborescence est-elle le lieu d'écriture légitime ?

    True si on tourne sous ComfyUI (folder_paths disponible) ou avec une racine
    explicite (AIH_USER_ROOT). False sous le harnais de test
    (AIH_SKIP_USER_MIGRATION=1) et hors ComfyUI : dans ce cas les consommateurs
    gardent leurs anciens chemins (aucune écriture hors ComfyUI, tests
    déterministes).

    Retourne:
        bool: True si la nouvelle racine peut recevoir des données.
    """
    if _truthy(os.environ.get(ENV_SKIP_MIGRATION)):
        return False
    return bool(_env_user_root()) or folder_paths_available()


def _path_present(path, kind="file"):
    """Présence RÉELLE d'un chemin (un dossier vide ne fait pas autorité).

    `kind="sqlite"` exige un fichier NON VIDE : une base de 0 octet (créée par
    une ouverture malencontreuse) ne doit JAMAIS masquer les données réelles
    restées à l'ancien emplacement.
    """
    if not path:
        return False
    if kind == "dir":
        return os.path.isdir(path) and _has_entries(path)
    if kind == "sqlite":
        try:
            return os.path.isfile(path) and os.path.getsize(path) > 0
        except OSError:
            return False
    return os.path.isfile(path)


def _in_pack(path):
    """True si `path` est à l'intérieur du dossier du pack."""
    try:
        root = os.path.abspath(PACK_ROOT)
        return os.path.commonpath([os.path.abspath(path), root]) == root
    except (ValueError, OSError):
        return False


def resolve_data_path(new, legacy=(), kind="file"):
    """Chemin à utiliser par un consommateur : nouveau s'il existe, sinon ancien.

    Règles, dans cet ordre :
      1. le NOUVEAU chemin existe déjà (donc la migration a eu lieu, ou
         l'installation est neuve) → il fait autorité ;
      2. sinon le premier ANCIEN chemin encore présent → l'utilisateur garde ses
         données, comportement strictement identique à avant la phase 2 ;
      3. sinon (rien nulle part) : nouveau si on est sous ComfyUI (ou racine
         explicite), ancien sinon (on n'écrit rien hors ComfyUI) ;
      4. hors ComfyUI, on n'écrit JAMAIS hors du pack : on reprend le dernier
         recours historique de chaque consommateur (chemin DANS le pack).

    Args:
        new: chemin cible (issu de p_*).
        legacy: chemins historiques connus, du plus canonique au dernier recours.
        kind: "file", "sqlite" (fichier non vide) ou "dir" (dossier non vide).

    Retourne:
        str: chemin absolu à ouvrir/écrire.
    """
    legacy = [item for item in (legacy or ()) if item]
    if _path_present(new, kind):
        return new
    for candidate in legacy:
        if _path_present(candidate, kind):
            return candidate
    if user_layout_adopted():
        return new
    if not folder_paths_available():
        for candidate in reversed(legacy):
            if _in_pack(candidate):
                return candidate
    return legacy[0] if legacy else new


def comfy_temp_dir():
    """Dossier temporaire de ComfyUI (folder_paths.get_temp_directory()) ou None."""
    module = _folder_paths_module()
    if module is None:
        return None
    getter = getattr(module, "get_temp_directory", None)
    value = _safe_call(getter) if callable(getter) else None
    return os.path.abspath(value) if value else None


def resolved_temp_dir(name, legacy):
    """Sous-dossier temporaire PROPRE au pack dans le temp de ComfyUI.

    `temp_uploads`/`temp_exports` sont vidés au démarrage (shutil.rmtree) : ils
    ne doivent JAMAIS désigner le dossier temporaire de ComfyUI lui-même, d'où
    le sous-dossier `<temp ComfyUI>/AI-Helper/<name>`. Hors ComfyUI (tests,
    harnais), on garde l'ancien emplacement DANS le pack.

    Args:
        name: nom du sous-dossier (ex. "temp_uploads").
        legacy: ancien chemin dans le pack.

    Retourne:
        str: chemin absolu.
    """
    if not user_layout_adopted():
        return legacy
    temp = comfy_temp_dir()
    if not temp:
        return legacy
    return os.path.join(temp, ROOT_NAME, name)


# --- Anciens emplacements connus, par donnée (aucun n'est supprimé) ---------
def legacy_db_utils_paths():
    """holaf_utilities.sqlite : racine du pack (emplacement historique)."""
    return [os.path.join(PACK_ROOT, DB_UTILS_FILENAME)]


def legacy_db_aih_paths(comfy_user_dir=None):
    """aihelper.db : user/default/aih/data puis dernier recours dans le pack."""
    aih = legacy_aih_dir(comfy_user_dir)
    return [
        os.path.join(aih, "data", DB_AIH_FILENAME),
        os.path.join(PACK_ROOT, "user_data", "aih", "data", DB_AIH_FILENAME),
    ]


def legacy_db_profiler_paths(comfy_user_dir=None):
    """holaf_profiler.db : déjà sous user/default/AI-Helper/profiler."""
    base = comfy_user_dir or get_comfy_user_dir()
    return [
        os.path.join(base, DEFAULT_USER_PROFILE, ROOT_NAME, "profiler", DB_PROFILER_FILENAME)
    ]


def legacy_config_paths():
    """config.ini : racine du pack."""
    return [os.path.join(PACK_ROOT, "config.ini")]


def legacy_credentials_paths(comfy_user_dir=None):
    """credentials.json : chaîne historique d'aih/credentials.py."""
    base = comfy_user_dir or get_comfy_user_dir()
    return [
        os.path.join(base, DEFAULT_USER_PROFILE, "aih", "credentials.json"),
        os.path.join(base, "aih", "credentials.json"),
        os.path.expanduser(os.path.join("~", ".config", "comfyui", "aih", "credentials.json")),
        os.path.expanduser(os.path.join("~", ".aih", "credentials.json")),
    ]


def legacy_openai_keys_paths(comfy_user_dir=None):
    """openai_keys.json : user/default/aih puis dernier recours dans le pack."""
    base = comfy_user_dir or get_comfy_user_dir()
    return [
        os.path.join(base, DEFAULT_USER_PROFILE, "aih", "openai_keys.json"),
        os.path.join(PACK_ROOT, "user_data", "aih", "openai_keys.json"),
    ]


def legacy_presets_paths(comfy_user_dir=None):
    """aih_elements_presets.json : user/default/aih."""
    base = comfy_user_dir or get_comfy_user_dir()
    return [os.path.join(base, DEFAULT_USER_PROFILE, "aih", "aih_elements_presets.json")]


def legacy_blobby_paths(comfy_user_dir=None):
    """blobby.json : user/default/aih puis l'ancien user/default/aih_blobby.json."""
    base = comfy_user_dir or get_comfy_user_dir()
    return [
        os.path.join(base, DEFAULT_USER_PROFILE, "aih", "blobby.json"),
        os.path.join(base, DEFAULT_USER_PROFILE, "aih_blobby.json"),
    ]


def legacy_known_hosts_paths():
    """sftp_known_hosts : custom_nodes/.sftp_known_hosts puis racine du pack."""
    return [
        os.path.join(os.path.dirname(PACK_ROOT), ".sftp_known_hosts"),
        os.path.join(PACK_ROOT, ".sftp_known_hosts"),
    ]


def legacy_music3_paths(comfy_user_dir=None):
    """music3 : user/default/aihelper/data/music3 (anomalie historique assumée)."""
    return [os.path.join(legacy_aihelper_dir(comfy_user_dir), "data", "music3")]


def legacy_thumb_cache_paths():
    """.cache/thumbnails : racine du pack."""
    return [os.path.join(PACK_ROOT, ".cache", "thumbnails")]


# --- Accesseurs résolus (utilisés par les consommateurs) --------------------
def resolved_db_utils(root=None):
    return resolve_data_path(p_db_utils(root), legacy_db_utils_paths(), kind="sqlite")


def resolved_db_aih(root=None, comfy_user_dir=None):
    return resolve_data_path(p_db_aih(root), legacy_db_aih_paths(comfy_user_dir), kind="sqlite")


def resolved_db_profiler(root=None, comfy_user_dir=None):
    return resolve_data_path(
        p_db_profiler(root), legacy_db_profiler_paths(comfy_user_dir), kind="sqlite"
    )


def resolved_config(root=None):
    return resolve_data_path(p_config(root), legacy_config_paths())


def resolved_credentials(root=None, comfy_user_dir=None):
    return resolve_data_path(p_credentials(root), legacy_credentials_paths(comfy_user_dir))


def resolved_openai_keys(root=None, comfy_user_dir=None):
    return resolve_data_path(p_openai_keys(root), legacy_openai_keys_paths(comfy_user_dir))


def resolved_presets(root=None, comfy_user_dir=None):
    return resolve_data_path(p_presets(root), legacy_presets_paths(comfy_user_dir))


def resolved_blobby(root=None, comfy_user_dir=None):
    return resolve_data_path(p_blobby(root), legacy_blobby_paths(comfy_user_dir))


def resolved_known_hosts(root=None):
    """AIH_SFTP_KNOWN_HOSTS reste PRIORITAIRE (p_known_hosts le gère)."""
    explicit = str(os.environ.get(ENV_SFTP_KNOWN_HOSTS, "")).strip()
    if explicit:
        return p_known_hosts(root)
    return resolve_data_path(p_known_hosts(root), legacy_known_hosts_paths())


def resolved_music3_dir(root=None, comfy_user_dir=None):
    return resolve_data_path(p_music3_dir(root), legacy_music3_paths(comfy_user_dir), kind="dir")


def resolved_thumb_cache(root=None):
    return resolve_data_path(p_thumb_cache(root), legacy_thumb_cache_paths(), kind="dir")


def resolved_backups_dir(root=None):
    """Dossier des sauvegardes de schéma de la base principale.

    Cible `backups/` dès que l'arborescence existe ; sinon le dossier de la
    base EFFECTIVEMENT utilisée (l'ancien comportement : à côté du .sqlite).
    """
    target = p_backups_dir(root)
    if os.path.isdir(target):
        return target
    return os.path.dirname(resolved_db_utils(root))


# ---------------------------------------------------------------------------
# Garde anti-test / hors-ComfyUI
# ---------------------------------------------------------------------------
def migration_blocked_reason(force=False, comfy_user_dir=None, user_root=None):
    """Raison de NE PAS migrer, ou None si la migration est autorisée.

    Verrous, du plus absolu au plus contextuel :
      0. CONSUMERS_WIRED=False : les consommateurs ne lisent pas encore ce
         module → migrer détruirait les données (le pack relirait l'ancien
         emplacement vide). `force=True` n'y change RIEN.
      0bis. AIH_USER_MIGRATION_ENABLED=0 → opt-out explicite.
      1. AIH_SKIP_USER_MIGRATION=1 (posé par run_tests.sh ET tests/conftest.py) ;
      2. PYTEST_CURRENT_TEST présent (pytest en cours) ;
      3. folder_paths absent ET aucune racine explicite (on n'est pas dans
         ComfyUI) → on n'écrit rien hors de ComfyUI.
    `force=True` n'est utilisé que par les tests de migration eux-mêmes et par
    un éventuel outil de diagnostic explicite : il n'outrepasse PAS le point 1.
    """
    if not CONSUMERS_WIRED:
        return (
            "consommateurs non branchés sur holaf_user_paths "
            "(CONSUMERS_WIRED=False) : rien n'est déplacé tant qu'ils ne lisent "
            "pas les accesseurs resolved_*"
        )
    raw = str(os.environ.get(ENV_MIGRATION_ENABLED, "")).strip().lower()
    if raw in _FALSEY and raw:
        return f"{ENV_MIGRATION_ENABLED}={raw} (opt-out explicite)"
    if _truthy(os.environ.get(ENV_SKIP_MIGRATION)):
        return f"{ENV_SKIP_MIGRATION}=1"
    if os.environ.get("PYTEST_CURRENT_TEST") and not force:
        return "pytest (PYTEST_CURRENT_TEST)"
    # Aucune racine explicite ET ComfyUI introuvable : on n'écrit nulle part
    # (sinon on créerait des données dans ~/.config/comfyui au premier import).
    root_explicit = bool(user_root or _env_user_root() or comfy_user_dir)
    if not root_explicit and not folder_paths_available():
        return "folder_paths absent (hors runtime ComfyUI)"
    return None


# ---------------------------------------------------------------------------
# Verrou inter-processus (deux instances ComfyUI partageant user/ : une seule migre)
# ---------------------------------------------------------------------------
class MigrationLock:
    """Verrou `.migration.lock` : O_CREAT|O_EXCL + flock, périmé après 10 min."""

    def __init__(self, path, logger=None, stale_seconds=LOCK_STALE_SECONDS):
        self.path = path
        self.stale_seconds = stale_seconds
        self.logger = logger or _DEFAULT_LOGGER
        self._fd = None

    def _is_stale(self):
        try:
            return (time.time() - os.path.getmtime(self.path)) > self.stale_seconds
        except OSError:
            return False

    def _unlink_quietly(self):
        try:
            os.unlink(self.path)
        except OSError:
            pass

    def acquire(self):
        """True si le verrou est pris. False = une autre instance migre."""
        for attempt in (0, 1):
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            except FileExistsError:
                if attempt == 1 or not self._is_stale():
                    return False
                self.logger.warning(
                    f"verrou périmé (> {self.stale_seconds}s) : {self.path} — il est cassé."
                )
                self._unlink_quietly()
                continue
            except OSError as exc:
                self.logger.warning(f"verrou impossible ({exc}) — migration reportée.")
                return False
            if fcntl is not None:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError:
                    # Un autre processus tient le flock : on ne touche à rien.
                    os.close(fd)
                    self._unlink_quietly()
                    return False
            try:
                os.write(fd, f"pid={os.getpid()} start={time.time():.0f}\n".encode("ascii"))
            except OSError:
                pass
            self._fd = fd
            return True
        return False

    def release(self):
        fd, self._fd = self._fd, None
        if fd is None:
            return
        try:
            if fcntl is not None:
                fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass
        self._unlink_quietly()


# ---------------------------------------------------------------------------
# Primitives de déplacement (atomicité + durabilité)
# ---------------------------------------------------------------------------
def _fsync_dir(path):
    """Rend le rename/création durable dans le dossier (best effort)."""
    if not path:
        return
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


def _copy_durably(src, dst):
    """copy2 + fsync + os.replace : la cible n'apparaît que complète."""
    tmp = f"{dst}.aih-migrating-{os.getpid()}"
    shutil.copy2(src, tmp)
    with open(tmp, "rb+") as handle:
        os.fsync(handle.fileno())
    os.replace(tmp, dst)
    _fsync_dir(os.path.dirname(dst))


def transfer_file(src, dst):
    """Déplace `src` vers `dst`. Retourne True si la SOURCE existe encore.

    - même volume  : os.replace = rename ATOMIQUE (aucune fenêtre de perte) ;
    - cross-device : copy2 + fsync + os.replace, puis la source reste tant que
      l'appelant n'a pas VÉRIFIÉ la copie (suppression par l'appelant).
    N'écrase JAMAIS une cible existante (la règle de conflit l'interdit déjà :
    ce garde-fou est la seconde barrière).
    """
    parent = os.path.dirname(dst)
    if parent:
        os.makedirs(parent, exist_ok=True)
    if os.path.exists(dst):
        raise FileExistsError(f"cible déjà présente : {dst}")
    try:
        os.replace(src, dst)
    except OSError as exc:
        if getattr(exc, "errno", None) not in (errno.EXDEV, errno.ENOTSUP):
            raise
        _copy_durably(src, dst)
        return os.path.exists(src)
    _fsync_dir(parent)
    return False


# ---------------------------------------------------------------------------
# SQLite : checkpoint WAL, relevé AVANT, vérification APRÈS
# ---------------------------------------------------------------------------
def _sqlite_ro_connect(path):
    """Connexion EN LECTURE SEULE (ne crée jamais le fichier)."""
    abs_path = os.path.abspath(path)
    uri = "file:" + abs_path.replace("?", "%3f").replace("#", "%23") + "?mode=ro"
    return sqlite3.connect(uri, uri=True, timeout=15)


def _quote_ident(name):
    return '"' + str(name).replace('"', '""') + '"'


def sqlite_snapshot(path, with_integrity=True):
    """Relevé d'une base : nb de tables, count(*) par table, integrity_check.

    `with_integrity=False` évite le `PRAGMA integrity_check` (parcours COMPLET
    du fichier : inutile et coûteux sur une base de 1,8 Go) pour le relevé
    AVANT ; la vérification d'intégrité n'est exigée qu'APRÈS le déplacement.

    Retourne:
        dict: {"tables": int, "rows": {nom: n}, "total": int, "integrity": str|None}
    """
    conn = _sqlite_ro_connect(path)
    try:
        names = [row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
        )]
        rows = {}
        for name in names:
            rows[name] = conn.execute(
                f"SELECT count(*) FROM {_quote_ident(name)}"
            ).fetchone()[0]
        integrity = None
        if with_integrity:
            integrity = "".join(str(row[0]) for row in conn.execute("PRAGMA integrity_check"))
    finally:
        conn.close()
    return {
        "tables": len(names),
        "rows": rows,
        "total": sum(rows.values()),
        "integrity": integrity,
    }


def snapshot_matches(before, after):
    """None si `after` est conforme à `before`, sinon un message d'écart."""
    if after.get("integrity") != "ok":
        return f"integrity_check = {after.get('integrity')!r}"
    if before.get("tables") != after.get("tables"):
        return f"nombre de tables {before.get('tables')} → {after.get('tables')}"
    if before.get("rows") != after.get("rows"):
        diff = sorted(
            key for key in set(before.get("rows", {})) | set(after.get("rows", {}))
            if before.get("rows", {}).get(key) != after.get("rows", {}).get(key)
        )
        return f"count(*) différent sur {diff[:5]}"
    if before.get("total") != after.get("total"):
        return f"total de lignes {before.get('total')} → {after.get('total')}"
    return None


def checkpoint_wal(path):
    """`PRAGMA wal_checkpoint(TRUNCATE)` : rapatrie le -wal dans le .db.

    OBLIGATOIRE avant tout déplacement : sans ce checkpoint, déplacer le seul
    `.db` perdrait toutes les écritures encore présentes dans le `-wal`.
    Lève RuntimeError si le checkpoint est BUSY (base utilisée par un autre
    processus) : mieux vaut retenter au prochain démarrage que déplacer une
    base dont le WAL est encore actif.
    """
    conn = sqlite3.connect(path, timeout=15, isolation_level=None)
    try:
        row = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
    finally:
        conn.close()
    busy = row[0] if row else 0
    if busy:
        raise RuntimeError(f"wal_checkpoint BUSY (base utilisée ailleurs) : {row}")


# ---------------------------------------------------------------------------
# Journal d'audit (.migration.json) + marqueur de rollback
# ---------------------------------------------------------------------------
def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _atomic_write_text(path, text):
    """Écrit un fichier texte via un temporaire + os.replace (jamais tronqué)."""
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def _write_journal(root, report, logger=None):
    """Journal = AUDIT SEULEMENT : il n'est jamais relu comme un drapeau."""
    logger = logger or _DEFAULT_LOGGER
    path = p_journal(root)
    previous = _read_json(path)
    items = dict(previous.get("items") or {})
    conflicts = list(previous.get("conflicts") or [])
    for key, result in report.get("items", {}).items():
        items[key] = {
            "status": result.get("status"),
            "from": result.get("from"),
            "to": result.get("to"),
            "files": result.get("files"),
            "detail": result.get("detail") or result.get("error"),
            "at": report.get("at"),
        }
    seen = {(entry.get("key"), entry.get("from")) for entry in conflicts}
    for entry in report.get("conflicts", []):
        if (entry.get("key"), entry.get("from")) not in seen:
            conflicts.append(entry)
            seen.add((entry.get("key"), entry.get("from")))
    journal = {
        "version": 1,
        "root": report.get("root"),
        "at": report.get("at"),
        "items": items,
        "conflicts": conflicts[-100:],
    }
    try:
        _atomic_write_text(path, json.dumps(journal, indent=2, ensure_ascii=False) + "\n")
    except OSError as exc:
        logger.warning(f"journal non écrit ({exc}) — sans conséquence : audit seulement.")


def _write_markers(report, logger=None):
    """`MIGRATED_TO_AI-HELPER.txt` dans chaque ancien dossier touché.

    Il documente le rollback : on ne supprime RIEN, on explique où sont les
    données et comment revenir en arrière.
    """
    logger = logger or _DEFAULT_LOGGER
    by_dir = {}
    for key, result in report.get("items", {}).items():
        if result.get("status") not in ("migrated", "conflict"):
            continue
        legacy = result.get("from")
        if not legacy:
            continue
        folder = legacy if os.path.isdir(legacy) else os.path.dirname(legacy)
        entry = by_dir.setdefault(folder, {"moved": [], "conflicts": []})
        if result.get("status") == "migrated":
            entry["moved"].append((key, legacy, result.get("to")))
        else:
            entry["conflicts"].append((key, legacy, result.get("to")))
    for folder, entry in by_dir.items():
        if not os.path.isdir(folder):
            continue
        lines = [
            "# ComfyUI-AI-Helper — données utilisateur DÉPLACÉES",
            "",
            f"Date            : {report.get('at')}",
            f"Nouvelle racine : {report.get('root')}",
            "",
            "Motif : alléger custom_nodes/ComfyUI-AI-Helper (une base de 1,8 Go y",
            "vivait), survivre à une réinstallation/mise à jour du pack et séparer",
            "code et données pour la sauvegarde.",
            "",
        ]
        if entry["moved"]:
            lines.append("Déplacé depuis ce dossier :")
            lines.extend(f"  - {legacy}  →  {target}" for _key, legacy, target in entry["moved"])
            lines.append("")
        if entry["conflicts"]:
            lines.append("CONFLIT — laissé INTACT ici (la cible existait déjà) :")
            lines.extend(f"  - {legacy}  (cible conservée : {target})"
                         for _key, legacy, target in entry["conflicts"])
            lines.append("")
        lines.extend([
            "Rollback documenté : arrêter ComfyUI, remettre chaque fichier listé",
            "ci-dessus à son ancien emplacement, puis relancer. Aucune suppression",
            "n'a été faite par la migration elle-même.",
            "",
        ])
        try:
            _atomic_write_text(os.path.join(folder, MARKER_FILENAME), "\n".join(lines))
        except OSError as exc:
            logger.warning(f"marqueur non écrit dans {folder} ({exc}).")


# ---------------------------------------------------------------------------
# Plan de migration : liste ORDONNÉE des items
# ---------------------------------------------------------------------------
def _has_entries(path):
    try:
        return bool(os.listdir(path))
    except OSError:
        return False


def build_migration_plan(comfy_user_dir=None, pack_root=None, root=None):
    """Items à migrer, dans l'ordre imposé (audit + tests la lisent).

    Chaque item :
        key    : identifiant stable (clé du journal)
        kind   : "sqlite" | "file" | "dir" | "backups" | "noop"
        new    : chemin CIBLE
        legacy : liste de chemins historiques connus (le premier présent gagne)
        env    : (optionnel) env explicite qui GAGNE et interdit toute migration
    """
    pack = os.path.abspath(pack_root or PACK_ROOT)
    comfy_user = comfy_user_dir or get_comfy_user_dir()
    aih = legacy_aih_dir(comfy_user)
    aihelper = legacy_aihelper_dir(comfy_user)
    custom_nodes = os.path.dirname(pack)
    target_root = get_user_root(root)

    def dst(*parts):
        return os.path.join(target_root, *parts)

    return [
        # 1) Bases SQLite
        {
            "key": "db_aih",
            "kind": "sqlite",
            "new": dst("db", DB_AIH_FILENAME),
            "legacy": [os.path.join(aih, "data", DB_AIH_FILENAME)],
        },
        # 2) Profiler : déjà dans son dossier final → rien à déplacer.
        {
            "key": "db_profiler",
            "kind": "noop",
            "new": dst("profiler", DB_PROFILER_FILENAME),
            "legacy": [],
        },
        # 3) Secrets (fichiers sensibles : jamais écrasés, jamais recréés vides)
        {
            "key": "credentials",
            "kind": "file",
            "new": dst("config", "credentials.json"),
            "legacy": [os.path.join(aih, "credentials.json")],
        },
        {
            "key": "openai_keys",
            "kind": "file",
            "new": dst("config", "openai_keys.json"),
            "legacy": [os.path.join(aih, "openai_keys.json")],
        },
        {
            "key": "sftp_known_hosts",
            "kind": "file",
            "new": dst("config", "sftp_known_hosts"),
            "legacy": [
                os.path.join(custom_nodes, ".sftp_known_hosts"),
                os.path.join(pack, ".sftp_known_hosts"),
            ],
            "env": ENV_SFTP_KNOWN_HOSTS,
        },
        # 4) Base principale (1,8 Go) + ses sauvegardes de schéma
        {
            "key": "db_utils",
            "kind": "sqlite",
            "new": dst("db", DB_UTILS_FILENAME),
            "legacy": [os.path.join(pack, DB_UTILS_FILENAME)],
        },
        {
            "key": "db_utils_backups",
            "kind": "backups",
            "new": dst("backups"),
            "legacy": [pack],
            "pattern": DB_UTILS_BACKUP_PATTERN,
        },
        # 5) Réglages d'interface
        {
            "key": "config_ini",
            "kind": "file",
            "new": dst("config", "config.ini"),
            "legacy": [os.path.join(pack, "config.ini")],
        },
        # 6) Presets + companion
        {
            "key": "presets",
            "kind": "file",
            "new": dst("presets", "aih_elements_presets.json"),
            "legacy": [os.path.join(aih, "aih_elements_presets.json")],
        },
        {
            "key": "blobby",
            "kind": "file",
            "new": dst("config", "blobby.json"),
            "legacy": [os.path.join(aih, "blobby.json")],
        },
        # 7) Données music3 (miroir local) puis cache de miniatures
        {
            "key": "music3",
            "kind": "dir",
            "new": dst("data", "music3"),
            "legacy": [os.path.join(aihelper, "data", "music3")],
            # Un `aihelper/` vidé n'a plus de raison d'être (anomalie historique).
            "prune_stop": os.path.join(comfy_user, DEFAULT_USER_PROFILE),
        },
        {
            "key": "thumbnails",
            "kind": "dir",
            "new": dst("cache", "thumbnails"),
            "legacy": [os.path.join(pack, ".cache", "thumbnails")],
            "prune_stop": pack,
        },
    ]


def layout_dirs(root=None):
    """Dossiers de l'arborescence cible (créés par ensure_user_data_layout)."""
    base = get_user_root(root)
    return [
        os.path.join(base, "db"),
        os.path.join(base, "profiler"),
        os.path.join(base, "config"),
        os.path.join(base, "presets"),
        os.path.join(base, "data", "music3"),
        os.path.join(base, "backups"),
        os.path.join(base, "cache", "thumbnails"),
    ]


# ---------------------------------------------------------------------------
# Détection de présence / conflit
# ---------------------------------------------------------------------------
def _backup_matches(item):
    """Fichiers `holaf_utilities.sqlite.backup_*` présents dans l'ancien dossier."""
    matches = []
    for candidate in item.get("legacy") or []:
        matches.extend(sorted(glob.glob(os.path.join(candidate, item["pattern"]))))
    return matches


def _legacy_present(item):
    """Chemins legacy RÉELLEMENT présents (premier gagnant pour l'affichage)."""
    kind = item["kind"]
    found = []
    for candidate in item.get("legacy") or []:
        if kind == "dir":
            if os.path.isdir(candidate) and _has_entries(candidate):
                found.append(candidate)
        elif kind == "backups":
            if _backup_matches(item):
                found.append(candidate)
        elif os.path.isfile(candidate):
            found.append(candidate)
    return found


def _new_present(item):
    """True si la CIBLE existe déjà (= elle fait autorité, on n'écrase rien)."""
    if item["kind"] == "dir":
        return os.path.isdir(item["new"]) and _has_entries(item["new"])
    if item["kind"] == "backups":
        return os.path.isdir(item["new"]) and bool(glob.glob(os.path.join(item["new"], item["pattern"])))
    if item["kind"] == "noop":
        return os.path.exists(item["new"])
    return os.path.isfile(item["new"])


# ---------------------------------------------------------------------------
# Migration d'un item
# ---------------------------------------------------------------------------
def _rollback_transfers(moved, logger):
    """Défait les transferts déjà faits (déplacement inverse immédiat)."""
    for src, dst, source_remains in reversed(moved):
        try:
            if source_remains:
                # Copie cross-device : la source n'a jamais été supprimée.
                if os.path.exists(dst):
                    os.remove(dst)
            elif os.path.exists(dst):
                transfer_file(dst, src)
        except Exception as exc:  # noqa: BLE001 — rollback : on continue les autres
            logger.error(f"rollback partiel {dst} → {src} : {exc}")


def _migrate_sqlite_item(item, logger):
    """Déplace `.db` + `-wal` + `-shm` ENSEMBLE, avec checkpoint et vérification.

    Règles NON négociables :
      - checkpoint WAL AVANT (sinon les écritures du -wal sont perdues) ;
      - jamais le `.db` seul : on déplace tous les sidecars présents ;
      - relevé AVANT (nb de tables + count(*) par table), vérification APRÈS
        (integrity_check + comparaison) ; tout écart ⇒ déplacement INVERSE.
    """
    legacy = item["from"]
    new = item["new"]
    checkpoint_wal(legacy)
    before = sqlite_snapshot(legacy, with_integrity=False)
    group = [legacy, legacy + "-wal", legacy + "-shm"]
    present = [path for path in group if os.path.exists(path)]
    moved = []
    try:
        for src in present:
            dst = new + src[len(legacy):]
            source_remains = transfer_file(src, dst)
            moved.append((src, dst, source_remains))
        after = sqlite_snapshot(new)
        discrepancy = snapshot_matches(before, after)
        if discrepancy:
            raise RuntimeError(f"vérification post-déplacement échouée : {discrepancy}")
    except Exception:
        _rollback_transfers(moved, logger)
        raise
    # Suppression des sources copiées (cross-device) : APRÈS vérification.
    for src, _dst, source_remains in moved:
        if source_remains and os.path.exists(src):
            try:
                os.remove(src)
            except OSError as exc:
                logger.warning(f"source non supprimée {src} : {exc}")
    return {
        "status": "migrated",
        "from": legacy,
        "to": new,
        "files": [os.path.basename(path) for path in present],
        "detail": f"{before['tables']} tables / {before['total']} lignes vérifiées",
    }


def _migrate_file_item(item, logger):
    """Déplace un fichier unique (jamais d'écrasement)."""
    legacy = item["from"]
    new = item["new"]
    source_remains = transfer_file(legacy, new)
    if source_remains:
        # cross-device : vérification minimale AVANT toute suppression.
        if os.path.getsize(new) != os.path.getsize(legacy):
            _rollback_transfers([(legacy, new, source_remains)], logger)
            raise RuntimeError("taille différente après copie cross-device")
        os.remove(legacy)
    return {"status": "migrated", "from": legacy, "to": new}


def _prune_empty_parents(path, stop):
    """Supprime les parents devenus VIDES (jamais `stop`, jamais un dossier non vide).

    Allègement réel : après le départ de `<pack>/.cache/thumbnails`, un dossier
    `.cache` vide dans custom_nodes n'a plus de raison d'être. On s'arrête
    toujours AVANT `stop` (racine du pack ou profil utilisateur).
    """
    if not stop:
        return
    stop = os.path.abspath(stop)
    current = os.path.dirname(os.path.abspath(path))
    while current and os.path.abspath(current) != stop:
        if not os.path.abspath(current).startswith(stop + os.sep):
            return
        try:
            if os.listdir(current):
                return
            os.rmdir(current)
        except OSError:
            return
        current = os.path.dirname(current)


def _migrate_dir_item(item, logger):
    """Déplace un dossier entier (music3, thumbnails)."""
    legacy = item["from"]
    new = item["new"]
    # La cible peut avoir été créée vide par ensure_user_data_layout : dans ce
    # cas elle ne fait PAS autorité (sinon music3/thumbnails ne migreraient
    # jamais). On ne traite ici que ce cas : un dossier non vide = conflit.
    if os.path.isdir(new) and not _has_entries(new):
        os.rmdir(new)
    parent = os.path.dirname(new)
    if parent:
        os.makedirs(parent, exist_ok=True)
    shutil.move(legacy, new)
    _fsync_dir(parent)
    _prune_empty_parents(legacy, item.get("prune_stop"))
    return {"status": "migrated", "from": legacy, "to": new}


def _migrate_backups_item(item, logger):
    """Déplace les `holaf_utilities.sqlite.backup_*` vers backups/."""
    target_dir = item["new"]
    os.makedirs(target_dir, exist_ok=True)
    migrated, conflicts = [], []
    for legacy in sorted(glob.glob(os.path.join(item["legacy"][0], item["pattern"]))):
        dst = os.path.join(target_dir, os.path.basename(legacy))
        if os.path.exists(dst):
            conflicts.append({"key": item["key"], "from": legacy, "to": dst})
            logger.warning(
                f"CONFLIT « {item['key']} » : {legacy} et {dst} existent tous deux "
                "— AUCUN écrasement, l'ancien fichier reste intact."
            )
            continue
        source_remains = transfer_file(legacy, dst)
        if source_remains and os.path.exists(legacy):
            os.remove(legacy)
        migrated.append(os.path.basename(legacy))
    if not migrated and not conflicts:
        return {"status": "absent", "to": target_dir}
    result = {
        "status": "migrated" if migrated else "conflict",
        "from": item["legacy"][0],
        "to": target_dir,
        "files": migrated,
    }
    if conflicts:
        result["conflicts"] = conflicts
    return result


def _migrate_item(item, logger):
    """Applique la précédence PAR ITEM (jamais d'exception qui remonte)."""
    kind = item["kind"]

    # (1) env explicite : gagne, AUCUNE migration.
    env_name = item.get("env")
    if env_name and str(os.environ.get(env_name, "")).strip():
        return {
            "status": "skipped",
            "to": item["new"],
            "detail": f"{env_name} explicite (chemin imposé par l'utilisateur)",
        }

    if kind == "noop":
        parent = os.path.dirname(item["new"])
        if parent:
            os.makedirs(parent, exist_ok=True)
        return {"status": "noop", "to": item["new"]}

    # Les sauvegardes se raisonnent FICHIER par FICHIER (jamais de mélange
    # entre la règle « tout ou rien » des items et le contenu d'un dossier).
    if kind == "backups":
        if not _backup_matches(item):
            return {"status": "existing" if _new_present(item) else "absent",
                    "to": item["new"]}
        return _migrate_backups_item(item, logger)

    legacy_candidates = _legacy_present(item)
    new_exists = _new_present(item)
    legacy = legacy_candidates[0] if legacy_candidates else None

    # (5) les DEUX présents : on n'écrase RIEN, la cible fait autorité.
    if new_exists and legacy:
        logger.warning(
            f"CONFLIT « {item['key']} » : {legacy} et {item['new']} existent tous deux "
            "— AUCUN écrasement, la cible fait autorité et l'ancien fichier reste intact."
        )
        return {
            "status": "conflict",
            "from": legacy,
            "to": item["new"],
            "detail": "cible déjà présente : ancien fichier laissé intact",
        }
    # (2) nouveau seul : autorité, rien à faire.
    if new_exists and not legacy:
        return {"status": "existing", "to": item["new"]}
    # (4) les deux absents : on ne crée AUCUN fichier de données vide
    #     (créer un credentials.json vide serait pire que l'absence) — les
    #     consommateurs créent à l'écriture, les dossiers sont déjà créés.
    if not legacy:
        return {"status": "absent", "to": item["new"]}

    # (3) migration réelle.
    item["from"] = legacy
    if kind == "sqlite":
        return _migrate_sqlite_item(item, logger)
    if kind == "file":
        return _migrate_file_item(item, logger)
    if kind == "dir":
        return _migrate_dir_item(item, logger)
    raise ValueError(f"type d'item inconnu : {kind}")


# ---------------------------------------------------------------------------
# Point d'entrée public
# ---------------------------------------------------------------------------
def ensure_user_data_layout(force=False, comfy_user_dir=None, pack_root=None,
                            user_root=None, logger=None):
    """Crée l'arborescence cible et migre les données — IDEMPOTENT.

    Un échec sur un item n'interrompt RIEN : l'item retombe sur son ancien
    chemin et sera retenté au démarrage suivant (aucun drapeau bloquant).

    Args:
        force: tests/diagnostic uniquement — outrepasse la garde pytest
            (jamais AIH_SKIP_USER_MIGRATION, jamais la règle « hors ComfyUI »).
        comfy_user_dir / pack_root / user_root: overrides (tests).
        logger: logger injectable (défaut : print préfixé).

    Returns:
        dict: {"status", "root", "blocked_reason", "items", "conflicts", "at"}
    """
    logger = logger or _DEFAULT_LOGGER
    root = get_user_root(user_root)
    report = {
        "status": "ok",
        "root": root,
        "blocked_reason": None,
        "items": {},
        "conflicts": [],
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }

    reason = migration_blocked_reason(
        force=force, comfy_user_dir=comfy_user_dir, user_root=user_root or _env_user_root()
    )
    if reason:
        # Rien n'est créé, rien n'est déplacé : sous pytest (et hors ComfyUI)
        # on ne touche à AUCUNE donnée utilisateur.
        report["status"] = "skipped"
        report["blocked_reason"] = reason
        logger.info(f"migration ignorée ({reason}) — aucune donnée touchée.")
        return report

    # Arborescence d'abord (idempotent), puis verrou, puis items.
    for directory in layout_dirs(root):
        os.makedirs(directory, exist_ok=True)

    lock = MigrationLock(p_lock(root), logger=logger)
    if not lock.acquire():
        report["status"] = "locked"
        logger.info("une autre instance migre déjà (verrou) — migration ignorée.")
        return report

    try:
        plan = build_migration_plan(
            comfy_user_dir=comfy_user_dir, pack_root=pack_root, root=root
        )
        for item in plan:
            key = item["key"]
            try:
                result = _migrate_item(item, logger)
            except Exception as exc:  # noqa: BLE001 — échec PAR ITEM : jamais bloquant
                # ÉCHEC PAR ITEM : l'item garde son ancien chemin, les suivants
                # continuent, et il sera retenté au prochain démarrage.
                legacy = (item.get("legacy") or [None])[0]
                result = {
                    "status": "failed",
                    "from": legacy,
                    "to": item["new"],
                    "error": f"{type(exc).__name__}: {exc}",
                }
                logger.error(
                    f"« {key} » : échec ({exc}) — l'ancien chemin reste utilisé, "
                    "nouvelle tentative au prochain démarrage."
                )
            report["items"][key] = result
            if result.get("status") == "migrated":
                logger.info(f"« {key} » migré : {result.get('from')} → {result.get('to')}")
            for conflict in result.get("conflicts") or []:
                report["conflicts"].append(conflict)
            if result.get("status") == "conflict" and result.get("from"):
                report["conflicts"].append(
                    {"key": key, "from": result.get("from"), "to": result.get("to")}
                )
        _write_markers(report, logger)
        _write_journal(root, report, logger)
    finally:
        lock.release()

    if any(item.get("status") == "failed" for item in report["items"].values()):
        report["status"] = "partial"
    return report


_ENSURE_LOCK = threading.Lock()
_ENSURE_STATE = {"done": False, "report": None}


def ensure_once(**kwargs):
    """Idempotence PROCESSUS : ensure_user_data_layout une seule fois.

    Appelé depuis __init__.py juste après le bootstrap sys.path : la migration
    doit précéder tout consommateur (qui ouvrirait sinon la base dans le pack).
    """
    with _ENSURE_LOCK:
        if _ENSURE_STATE["done"]:
            return _ENSURE_STATE["report"]
        report = ensure_user_data_layout(**kwargs)
        _ENSURE_STATE["report"] = report
        _ENSURE_STATE["done"] = True
        return report


def reset_ensure_once():
    """Réinitialise le drapeau processus (tests uniquement)."""
    with _ENSURE_LOCK:
        _ENSURE_STATE["done"] = False
        _ENSURE_STATE["report"] = None


# ---------------------------------------------------------------------------
# PHASE 2 — consommateurs BRANCHÉS sur ce module (état vérifié, fichier:ligne)
# ---------------------------------------------------------------------------
# Chacun appelle un accesseur `resolved_*` ci-dessus : nouveau chemin si la
# migration l'a déplacé, ANCIEN chemin sinon (comportement identique à avant la
# phase 2 tant que rien n'a bougé). Vérifié par
# tests/test_user_paths_consumers.py (avant ET après migration) et
# tests/test_user_paths_guard.py (cohérence drapeau ⇄ branchement).
#
#   holaf_database.py:24              DB_PATH = resolved_db_utils() (+ DB_DIR)
#   holaf_database.py:271             sauvegardes .backup_v… → resolved_backups_dir()
#   holaf_user_data_manager.py:28,33  get_user_base_path()/get_root_path() → get_comfy_user_dir()/get_user_root()
#                                     (⚠️ divergence base_path/user/default CORRIGÉE)
#   holaf_user_data_manager.py:58     get_profiler_db_path() → resolved_db_profiler()
#   holaf_profiler_database.py:24     ProfilerDatabase.db_path → resolved_db_profiler()
#   holaf_config.py:66                get_config_path() → resolved_config()
#   holaf_utils.py:67,70              temp_uploads/temp_exports → resolved_temp_dir()
#   holaf_utils.py:73                 THUMBNAIL_CACHE_DIR → resolved_thumb_cache()
#   nodes/holaf_model_manager.py:53   HOLAF_MODELS_DB_PATH → resolved_db_utils()
#                                     (⚠️ DOUBLE source de vérité supprimée)
#   nodes/openai_settings_node.py:65  openai_keys.json → resolved_openai_keys()
#   aih/store.py:89                   _get_aih_user_dir() → legacy_aih_dir()
#   aih/store.py:101                  get_store_path() → resolved_db_aih()
#   aih/routes.py:166                 _get_aih_user_dir() → legacy_aih_dir()
#   aih/routes.py:175                 _get_presets_path() → resolved_presets()
#   aih/routes.py:517,540             openai_keys.json → resolved_openai_keys()
#   aih/routes.py:611                 _get_blobby_file() → resolved_blobby()
#   aih/routes.py:1394                music3 → resolved_music3_dir()
#   aih/credentials.py:118            get_credentials_path() → resolved_credentials()
#   aih/local_source.py:316           refs music3 → resolved_music3_dir()
#   aih/sync_engine.py:837            sync_music3_local() → resolved_music3_dir()
#   aih/model_manager.py:110          sftp_known_hosts → resolved_known_hosts()
#
# INCHANGÉ VOLONTAIREMENT : aih/routes.py:179-198 (_get_workflows_dir, dossier
# user/default/workflows PARTAGÉ avec le core ComfyUI via /api/userdata), ainsi
# que output/ et models/ (jamais migrés).
