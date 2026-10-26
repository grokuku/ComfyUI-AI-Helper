"""CPU-only Modal app to sync model files into the ``comfy-models`` Volume.

Supports two sync modes:
1. **Local models** — files detected in the local ComfyUI/models/ directory,
   selected via the Modal Gateway UI, added to the image and copied to the Volume.
2. **HuggingFace models** — files listed in ``models.py``, downloaded via
   ``huggingface_hub``.

Usage::

    modal run sync.py                    # modèles locaux + HF + user settings
    modal run sync.py --sync-custom-nodes # archive des custom nodes seulement
    modal run sync.py --sync-user-only    # user settings seulement (étape 3)
"""

from __future__ import annotations

import ast
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime
from pathlib import Path

# Le dossier du script sur sys.path AVANT les imports frères : ``modal run``
# importe ce fichier par chemin, et les modules du pack (helpers, models,
# comfych_paths) doivent être résolvables de façon déterministe.
_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

import modal
from comfych_paths import (  # bootstrap sys.path ci-dessus
    ComfyPathNotFound,
    custom_nodes_dir_candidates,
    first_existing,
    first_existing_or_raise,
    models_dir_candidates,
    user_dir_candidates,
)
from helpers import (
    download_external_model,
    get_hf_secrets,
    hf_download,
    resolve_model_dir,
)
from models import models, models_ext

vol = modal.Volume.from_name("comfy-models", create_if_missing=True)
custom_nodes_vol = modal.Volume.from_name("comfy-custom-nodes", create_if_missing=True)

CHUNK_SIZE = 100 * 1024 * 1024  # 100 MB

# Nom du manifeste écrit dans le volume comfy-custom-nodes : liste des dossiers
# de nodes réellement extraits (source de vérité des badges « déjà installé »).
NODES_MANIFEST_NAME = ".nodes_manifest.json"

# Point de montage du volume des custom nodes (surchargeable en test).
_CUSTOM_NODES_ROOT = "/custom_nodes"

# Dossiers internes du volume (jamais considérés comme des nodes).
_STAGING_DIR_NAME = ".staging"
_UPLOAD_DIR_NAME = "_upload"
# Sauvegarde de secours du contenu précédent, créée PENDANT le swap (renommage,
# aucune copie) et conservée une génération : elle n'est remplacée qu'une fois le
# swap suivant réellement terminé (voir :func:`_swap_volume_content`).
_BACKUP_DIR_NAME = ".backup"
# Marqueur écrit dans ``.backup`` quand l'ancien contenu y est COMPLET : sans
# lui, la sauvegarde vient d'un swap interrompu et ne doit jamais être écrasée.
_BACKUP_COMPLETE_MARKER = ".complete"

_CACHE_ROOT = Path("/cache")

_MB = 1024 * 1024

# ── Filtrage / garde-fous de l'archive des custom nodes ──────────────────

# Ce script vit dans le dossier du projet ComfyCH. Deux dispositions existent :
#   custom_nodes/ComfyCH/                → le dossier du script EST le projet ;
#   custom_nodes/<pack>/tools/comfych/    → le projet est le GRAND-PARENT (pack).
# Déduire le nom du seul parent du script donnait « comfych » dans le second
# cas : le pack lui-même n'était alors plus exclu de sa propre archive.
PROJECT_ROOT_NAME = (
    _SCRIPT_DIR.parents[1].name if _SCRIPT_DIR.parent.name == "tools" else _SCRIPT_DIR.name
)

GATEWAY_CODE_DIR = _SCRIPT_DIR
"""Dossier du CODE du gateway (``tools/comfych``, ou ``custom_nodes/ComfyCH``).

DÉCISION « UNE SEULE SOURCE DE VÉRITÉ » (documentée dans ``docs/COMFYCH.md``) :

* le **code des nodes du pack** vient du **VOLUME** (archive des custom nodes) :
  c'est lui que ``base_worker._sync_custom_nodes_from_volume`` lie dans
  ``ComfyUI/custom_nodes`` au démarrage ;
* le **code du gateway** (``sync.py``, ``image.py``, ``apps/``, ``workers/``) est
  embarqué dans l'**IMAGE** Modal par ``add_local_python_source`` et n'est
  JAMAIS poussé sur le volume : il n'a aucun usage côté worker, et il contient
  la configuration locale (clé API).

Conséquence : ``tools/comfych`` est élagué de l'archive du pack, et un dossier
de ``custom_nodes/`` qui EST ce dossier (installation ComfyCH autonome) n'est
pas un node — il est exclu de la sélection.
"""

# Dossiers de custom_nodes/ qui ne sont PAS des nodes : uniquement le dossier
# de données ComfyUI. Le PACK n'est plus exclu : ses nodes doivent arriver sur
# le worker par le volume, l'image ne contenant que ses dépendances pip
# (l'ancienne exclusion « code déjà présent dans l'image » était FAUSSE et
# rendait ses nodes introuvables côté worker : « AIH Prompt Enhancer not
# found »).
EXCLUDED_NODE_NAMES = {"user"}


def _is_gateway_code_dir(entry) -> bool:
    """True si *entry* EST le dossier du code du gateway (jamais un node).

    Indépendant de tout nom de dossier : couvre les deux dispositions (node à
    plat ``custom_nodes/ComfyCH`` ou imbriqué ``custom_nodes/<pack>/tools/
    comfych``).
    """
    try:
        return GATEWAY_CODE_DIR == Path(entry).resolve()
    except (OSError, ValueError):
        return False

# Dossiers techniques ignorés où qu'ils soient dans l'arbre d'un node.
# Les noms sont comparés en minuscules (cf. :func:`_dir_exclusion_reason`).
EXCLUDE_DIRS = {
    ".git",
    "__pycache__",
    "node_modules",
    ".venv",
    "venv",
    ".cache",
    "dist",
    "build",
    "models",
    "output",
    "input",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".staging",
    ".github",
    ".idea",
    ".vscode",
}

# Sous-ensemble CACHÉ de :data:`EXCLUDE_DIRS` : les SEULS dossiers commençant
# par ``.`` élagués dans l'arbre d'un node.
#
# ATTENTION — ne JAMAIS revenir à une règle « tout dossier caché est exclu » :
# plusieurs repos de nodes embarquent des SOUS-MODULES git légitimes dont le nom
# commence par un point et que le node importe au runtime. Régression observée en
# production après une sync :
#
#     [VRGDG] 1 failed submodule(s): .VRGDG_LTXLoopingSampler
#     ModuleNotFoundError: No module named 'ComfyUI-LTXVideo'
#
# Tout AUTRE dossier commençant par ``.`` est donc CONSERVÉ (son poids éventuel
# reste couvert par :data:`EXCLUDE_FILE_EXTS` et les garde-fous de taille).
HIDDEN_EXCLUDE_DIRS = {
    ".git",  # volume souvent énorme : jamais transféré
    ".github",
    ".venv",
    ".idea",
    ".vscode",
    ".cache",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    _STAGING_DIR_NAME,  # dossier interne du volume, jamais un node
}

# Fichiers de code conservés même quand leur nom commence par ``.`` : un
# sous-module conservé peut livrer du bytecode natif (``.so``/``.pyd``) ou du
# Python sous un nom pointé. Les métadonnées cachées (``.DS_Store``,
# ``.gitignore``, ``.gitmodules``…) restent, elles, exclues.
HIDDEN_KEEP_FILE_EXTS = {".py", ".pyi", ".so", ".pyd"}

# Contenu de démonstration embarqué par certains repos de nodes (captures
# d'écran, workflows d'exemple, jeux de test, documentation) : jamais chargé au
# runtime, mais facilement des centaines de Mo (images et vidéos de preview).
#
# Mesuré sur des repos réels : ComfyUI-vrgamedevgirl = 375 MB de `Workflows/`,
# 102 MB de `LUTS/` (.cube), 17 MB d'`images/` pour ~1 MB de code réel.
# ATTENTION : ces noms sont du contenu d'exemple dans ces repos ; l'UI d'un node
# vit dans `web/` (ou `js/`), qui n'est jamais exclu.
EXCLUDE_CONTENT_DIRS = {
    "previews",
    "preview",
    "samples",
    "sample",
    "examples",
    "example",
    "docs",
    "doc",
    "test",
    "tests",
    "__tests__",
    "benchmarks",
    # Workflows d'exemple livrés avec le node (le plus gros contributeur).
    "workflows",
    "workflow",
    # Tables de color grading `.cube` livrées avec les nodes vidéo/LUT.
    "luts",
    "lut",
    # Images d'exemple. Compromis assumé : quelques nodes rangent leurs icônes
    # dans `images/`. Les icônes UI sont en général dans `web/` ou à la racine
    # (chemins non filtrés), et le garde-fou MAX_IMAGE_MB protège les cas
    # isolés ; les dossiers restants d'images d'exemple, eux, pèsent des
    # dizaines de Mo.
    "images",
    "image",
    # Même compromis pour `assets/` : un front bundlé (Vite) peut y déposer son
    # JS/CSS. Sans ce filtre, les assets d'exemple coûtent des centaines de Mo ;
    # `web/` et `js/`, où vit l'UI de la grande majorité des nodes, ne sont
    # jamais exclus.
    "assets",
    "screenshots",
    "screenshot",
    "media",
    "videos",
    "video",
    "audio",
    "sounds",
    "fonts",
}

# Radicaux d'un nom de dossier qui trahissent du contenu même combinés à
# d'autres mots. Les repos réels nomment rarement ces dossiers exactement comme
# ci-dessus : ``example_workflows/`` (ComfyUI-RES4LYF, plusieurs centaines de
# Mo), ``previews_old/``, ``workflows_v2/``… Découpage sur ``-_.`` et espace
# (cf. :func:`_dir_name_tokens`) : on n'exclut que des mots entiers, jamais un
# préfixe arbitraire (``image_utils`` reste du code).
CONTENT_DIR_STEMS = {
    "workflow",
    "workflows",
    "preview",
    "previews",
    "screenshot",
    "screenshots",
    "example",
    "examples",
    "benchmark",
    "benchmarks",
}

# Extensions média/démo (vidéos, audio, assets 3D/Photoshop) : inutiles côté
# Modal et souvent stockées en dizaines d'exemples de plusieurs Mo.
# Les images restent autorisées (icônes et UI des nodes), sauf dans les
# dossiers de :data:`EXCLUDE_CONTENT_DIRS`, élagués avant d'y arriver.
EXCLUDE_MEDIA_EXTS = {
    ".mp4",
    ".webm",
    ".mov",
    ".avi",
    ".mkv",
    ".flv",
    ".wmv",
    ".psd",
    ".blend",
    ".fbx",
    ".obj",
    ".glb",
    ".gltf",
    ".wav",
    ".mp3",
    ".flac",
    ".ogg",
}

# Extensions de fichiers lourds (modèles, archives, bytecode) : inutiles côté
# Modal et responsables d'archives de plusieurs Go.
EXCLUDE_FILE_EXTS = {
    ".safetensors",
    ".ckpt",
    ".pt",
    ".pth",
    ".bin",
    ".gguf",
    ".onnx",
    ".pkl",
    ".h5",
    ".msgpack",
    ".zip",
    ".tar",
    ".gz",
    ".7z",
    # Roues pypi téléchargées à la main dans le dossier d'un pack : artefacts de
    # build (les dépendances du worker viennent des ``requirements.txt``, cf.
    # docs/COMFYCH.md). Mesuré sur le pack AI-Helper : 8 MB sur 9,2 MB d'archive.
    ".whl",
    ".pyc",
    ".pyo",
    # Contenu lourd, jamais du code : LUTs, images HDR/EXR, raws d'images.
    ".cube",
    ".exr",
    ".hdr",
    ".tiff",
    ".tif",
    ".bmp",
    # Fichiers techniques résiduels (logs, sauvegardes d'éditeur/merge).
    ".log",
    ".tmp",
    ".bak",
    ".orig",
    ".rej",
    # Notebooks de démo et documentation bureautique.
    ".ipynb",
    ".pdf",
    ".docx",
    ".xlsx",
    ".pptx",
    # NOTE : `.ico` et `.json` restent autorisés — une favicon d'UI et un preset
    # de node sont fréquemment nécessaires au runtime.
}

# Garde-fous de taille : un fichier trop gros est ignoré, une archive trop
# grosse est refusée avant l'upload (message explicite, pas de crash).
MAX_FILE_MB = 50
MAX_ARCHIVE_MB = 500

# Garde-fou ciblé sur les images : une icône/asset d'UI pèse < 200 Ko ; une
# image de plus de MAX_IMAGE_MB est une capture ou un exemple, jamais un asset
# de node. Seule la règle par taille les distingue, d'où cette liste.
MAX_IMAGE_MB = 2
LARGE_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


# ── Path / archive validation helpers ────────────────────────────────────


def _safe_model_filename(filename: str) -> str:
    """Validate a model *filename* against path traversal and return it.

    The name must be a bare file name: no path separator (``/`` or ``\\``),
    no ``.``/``..`` component, and ``Path(filename).name`` must be the name
    itself. Raises :class:`ValueError` otherwise.
    """
    if not filename:
        raise ValueError("Model filename is empty")
    if "/" in filename or "\\" in filename:
        raise ValueError(f"Model filename '{filename}' must not contain a path separator")
    if filename in (".", ".."):
        raise ValueError(f"Model filename '{filename}' is not a valid file name")
    if Path(filename).name != filename:
        raise ValueError(f"Model filename '{filename}' is not a bare file name")
    return filename


def _model_dest(filename: str) -> Path:
    """Return the validated volume path (``/cache/<filename>``) for *filename*.

    Validates the name with :func:`_safe_model_filename` and double-checks that
    the resolved path stays under the volume root (belt + braces).
    """
    _safe_model_filename(filename)
    dest = _CACHE_ROOT / filename
    if not dest.resolve().is_relative_to(_CACHE_ROOT.resolve()):
        raise ValueError(f"Model filename '{filename}' escapes the volume root")
    return dest


def _validate_tar_members(members, staging_dir: str) -> None:
    """Validate tar members before extraction into *staging_dir*.

    Rejects, in order:

    1. links — symlink/hardlink members can have an innocuous ``name`` while
       ``linkname`` points outside the staging directory (extraction escape);
    2. absolute names and ``..`` components;
    3. any member whose resolved path would land outside *staging_dir*.

    Raises :class:`ValueError` on the first offending member.
    """
    staging_root = os.path.normpath(staging_dir)
    for member in members:
        if member.issym() or member.islnk():
            raise ValueError(f"Tar member '{member.name}' is a link — rejected")
        if member.name.startswith("/") or ".." in member.name.split("/"):
            raise ValueError(f"Tar member '{member.name}' contains unsafe path")
        member_path = os.path.normpath(os.path.join(staging_root, member.name))
        if not member_path.startswith(staging_root + os.sep):
            raise ValueError(
                f"Tar member '{member.name}' would extract outside target directory"
            )


# ── Sélection des nodes / filtrage des fichiers ──────────────────────────

# Raisons d'exclusion, réutilisées par les messages de progression du sync.
_SKIP_HIDDEN = "dossier caché"
_SKIP_TECHNICAL = "dossier technique"
_SKIP_DEMO_DIR = "contenu de démonstration"
_SKIP_HEAVY_FILE = "extension lourde"
_SKIP_MEDIA_FILE = "média de démonstration"
_SKIP_LARGE_IMAGE = "image volumineuse"


# Suffixes qui marquent un dossier de custom_nodes DÉSACTIVÉ à la main
# (``ComfyUI-GGUF.disabled``, ``X.bak``…). Jamais des nodes.
DISABLED_NODE_SUFFIXES = (".disabled", ".disabled_by_user", ".bak", ".off")


def _not_a_node_reason(entry) -> str | None:
    """Raison pour laquelle *entry* n'est PAS un custom node chargeable.

    ComfyUI ne charge un dossier de ``custom_nodes/`` QUE s'il contient un
    ``__init__.py`` : un dossier sans ``__init__.py`` (ex. un dépôt frère dont
    on a retiré le ``__init__.py`` pour qu'il ne soit pas chargé, un reste
    d'installation, un dossier de données) n'est pas un node et n'a rien à
    faire dans l'archive — sa présence sur le volume écraserait du code
    existant pour rien.
    """
    lowered = Path(entry).name.lower()
    for suffix in DISABLED_NODE_SUFFIXES:
        if lowered.endswith(suffix):
            return f"node désactivé (suffixe « {suffix} »)"
    if not (Path(entry) / "__init__.py").is_file():
        return "pas de __init__.py — pas un custom node"
    return None


def _node_skip_reason(name: str, entry=None) -> str | None:
    """Raison d'exclure le dossier *name* de custom_nodes/, ou ``None``.

    Le dossier du CODE du gateway (cf. :func:`_is_gateway_code_dir`) et
    ``user`` ne sont pas des nodes ; les dossiers techniques
    (``__pycache__``, ``.git``…) et les dossiers cachés de bookkeeping du
    volume (``.staging``…) non plus. Les radicaux de contenu
    (:data:`CONTENT_DIR_STEMS`) ne s'appliquent PAS ici : un node peut
    légitimement s'appeler ``ComfyUI-Workflows``.

    Le PACK AI-Helper n'est PAS exclu : c'est un custom node comme un autre, et
    son code doit arriver sur le worker par le VOLUME (l'image n'embarque que
    ses ``requirements.txt``). Son sous-dossier ``tools/comfych`` (code du
    gateway), lui, est élagué du packaging — voir :func:`_is_gateway_code_dir`.
    """
    if entry is not None and _is_gateway_code_dir(entry):
        return "gateway ComfyCH (code du gateway : embarqué dans l'image)"
    if name in EXCLUDED_NODE_NAMES:
        return "données ComfyUI, pas un custom node"
    reason = _dir_exclusion_reason(name, node_root=True)
    if reason is not None:
        return reason
    if entry is not None:
        return _not_a_node_reason(entry)
    return None


def _select_node_dirs(custom_nodes_dir) -> tuple[list, list]:
    """Sépare les nodes retenus des dossiers exclus.

    Retourne ``(node_dirs, skipped)`` où *skipped* est une liste de couples
    ``(nom, raison)``.
    """
    kept: list[Path] = []
    skipped: list[tuple[str, str]] = []
    for entry in sorted(Path(custom_nodes_dir).iterdir()):
        if not entry.is_dir():
            continue
        reason = _node_skip_reason(entry.name, entry)
        if reason:
            skipped.append((entry.name, reason))
        else:
            kept.append(entry)
    return kept, skipped


def _dir_name_tokens(lowered_name: str) -> set[str]:
    """Mots d'un nom de dossier (découpage sur ``-``, ``_``, ``.``, espace)."""
    return {token for token in re.split(r"[-_.\s]+", lowered_name) if token}


def _dir_exclusion_reason(name: str, *, node_root: bool = False) -> str | None:
    """Raison d'ignorer le dossier *name* rencontré dans l'arbre d'un node.

    Retourne ``None`` si le dossier doit être archivé. La comparaison est
    insensible à la casse : les repos écrits sous Windows/macOS utilisent
    fréquemment ``Docs``, ``Previews`` ou ``Tests``.

    *node_root* signale un dossier de premier niveau de ``custom_nodes/`` (donc
    un nom de node) : les radicaux de :data:`CONTENT_DIR_STEMS` n'y sont pas
    appliqués, un node pouvant s'appeler ``ComfyUI-Workflows``.

    Les dossiers cachés ne sont PAS exclus en bloc : seuls les noms de
    :data:`HIDDEN_EXCLUDE_DIRS` le sont (cf. la régression des sous-modules git
    nommés ``.VRGDG_LTXLoopingSampler``). Au premier niveau de ``custom_nodes/``
    en revanche (``node_root``), un dossier caché n'est pas un node : bookkeeping
    du volume (``.staging``, ``.Trash``…) ou reste de montage.
    """
    lowered = name.lower()
    if lowered in HIDDEN_EXCLUDE_DIRS:
        return _SKIP_HIDDEN
    if lowered in EXCLUDE_DIRS:
        return _SKIP_TECHNICAL
    if lowered in EXCLUDE_CONTENT_DIRS:
        return _SKIP_DEMO_DIR
    if node_root and name.startswith("."):
        return _SKIP_HIDDEN
    if not node_root and _dir_name_tokens(lowered) & CONTENT_DIR_STEMS:
        return _SKIP_DEMO_DIR
    return None


def _file_exclusion_reason(
    name: str, size_bytes: int | None = None
) -> str | None:
    """Raison d'ignorer le fichier *name* (``None`` s'il doit être archivé).

    *size_bytes* (facultatif) active le garde-fou par taille
    (cf. :data:`MAX_IMAGE_MB`) : une image de plus de ``MAX_IMAGE_MB`` est une
    capture ou un exemple, pas un asset d'UI. Sans taille connue, la décision
    par nom seul fait foi (le fichier est conservé).

    Les fichiers cachés de métadonnées sont écartés, SAUF le code
    (:data:`HIDDEN_KEEP_FILE_EXTS`) : un sous-module conservé peut livrer du
    ``.so``/``.pyd`` (cf. :data:`HIDDEN_EXCLUDE_DIRS`).
    """
    suffix = Path(name).suffix.lower()
    if name.startswith(".") and suffix not in HIDDEN_KEEP_FILE_EXTS:
        return _SKIP_HIDDEN
    if suffix in EXCLUDE_FILE_EXTS:
        return _SKIP_HEAVY_FILE
    if suffix in EXCLUDE_MEDIA_EXTS:
        return _SKIP_MEDIA_FILE
    if (
        size_bytes is not None
        and suffix in LARGE_IMAGE_EXTS
        and size_bytes > MAX_IMAGE_MB * _MB
    ):
        return _SKIP_LARGE_IMAGE
    return None


def _is_excluded_dir(name: str) -> bool:
    """True si le dossier *name* doit être ignoré (technique, démo ou caché)."""
    return _dir_exclusion_reason(name) is not None


def _is_excluded_file(name: str) -> bool:
    """True si le fichier *name* doit être ignoré (caché, lourd ou média).

    Vérification par nom seul : le garde-fou par taille (``MAX_IMAGE_MB``) ne
    s'applique qu'à l'énumération, où la taille est connue.
    """
    return _file_exclusion_reason(name) is not None


def _file_size(file_path) -> int | None:
    """Taille de *file_path* en octets, ou ``None`` si elle est inaccessible."""
    try:
        return Path(file_path).stat().st_size
    except OSError:
        return None


def _new_archive_counters() -> dict:
    """Compteurs d'exclusion remplis pendant l'énumération d'un node."""
    return {
        "demo_dirs": set(),
        "hidden_dirs": set(),
        "skipped_demo_dirs": 0,
        "media_exts": set(),
        "skipped_media": 0,
        "image_exts": set(),
        "skipped_large_images": 0,
        # Nom du sous-dossier de code du gateway élagué (``tools/comfych``)
        # s'il a été rencontré : trace dans le résumé du packaging.
        "gateway_dir": "",
    }


def _iter_node_files(node_dir, counters: dict | None = None):
    """Énumère ``(dossier, [fichiers retenus])`` pour *node_dir*.

    Les dossiers exclus sont élagués (``os.walk`` ne descend pas dedans) et les
    liens symboliques ignorés : ils seraient de toute façon rejetés à
    l'extraction par :func:`_validate_tar_members`. Les images dépassant
    ``MAX_IMAGE_MB`` sont écartées ici, avant tout ajout au tar.

    Le CODE DU GATEWAY (``tools/comfych``) est élagué par CHEMIN, pas par nom :
    il est embarqué dans l'image Modal et ne doit jamais partir dans le volume
    (ni ses logs, ni sa configuration locale qui porte la clé API).

    *counters* (facultatif, cf. :func:`_new_archive_counters`) est incrémenté
    au passage pour que l'appelant puisse rapporter ce qui a été écarté.
    """
    node_dir = Path(node_dir)
    for root, dirs, filenames in os.walk(node_dir):
        kept_dirs = []
        for dir_name in sorted(dirs):
            child = os.path.join(root, dir_name)
            if _is_gateway_code_dir(child):
                # Auto-archivage du gateway : jamais dans sa propre archive.
                if counters is not None:
                    counters["gateway_dir"] = dir_name
                continue
            reason = _dir_exclusion_reason(dir_name)
            if reason is not None:
                if counters is not None and reason == _SKIP_DEMO_DIR:
                    counters["demo_dirs"].add(dir_name)
                    counters["skipped_demo_dirs"] += 1
                continue
            if os.path.islink(os.path.join(root, dir_name)):
                continue
            if dir_name.startswith(".") and counters is not None:
                # Sous-module caché conservé (ex. `.VRGDG_LTXLoopingSampler`) :
                # tracé dans le résumé du packaging, mais JAMAIS élagué.
                counters["hidden_dirs"].add(dir_name)
            kept_dirs.append(dir_name)
        dirs[:] = kept_dirs

        kept = []
        for name in sorted(filenames):
            file_path = Path(root) / name
            if file_path.is_symlink():
                continue
            # La taille n'est statée que pour les extensions concernées par le
            # garde-fou MAX_IMAGE_MB : pas de stat inutile sur tout l'arbre.
            suffix = Path(name).suffix.lower()
            size = _file_size(file_path) if suffix in LARGE_IMAGE_EXTS else None
            reason = _file_exclusion_reason(name, size)
            if reason is not None:
                if counters is not None:
                    if reason == _SKIP_MEDIA_FILE:
                        counters["media_exts"].add(suffix)
                        counters["skipped_media"] += 1
                    elif reason == _SKIP_LARGE_IMAGE:
                        counters["image_exts"].add(suffix)
                        counters["skipped_large_images"] += 1
                continue
            kept.append(file_path)
        yield Path(root), kept


def _node_dir_size(node_dir) -> int:
    """Taille (octets) des fichiers de *node_dir* réellement archivés."""
    total = 0
    for _root, files in _iter_node_files(node_dir):
        for file_path in files:
            try:
                total += file_path.stat().st_size
            except OSError:
                continue
    return total


def _node_size_report(node_dirs) -> list[tuple[str, int]]:
    """Tailles des nodes retenus, triées du plus lourd au plus léger."""
    sizes = [(Path(d).name, _node_dir_size(d)) for d in node_dirs]
    return sorted(sizes, key=lambda item: item[1], reverse=True)


def _build_custom_nodes_archive(
    node_dirs, archive_path, *, max_file_mb: int = MAX_FILE_MB
) -> dict:
    """Écrit un tar.gz des *node_dirs* dans *archive_path* (sur disque).

    Les mêmes exclusions que :func:`_node_dir_size` s'appliquent, plus le
    garde-fou par fichier (``max_file_mb``) dont les rejets sont comptés.

    Retourne ``{"files": n, "skipped_large": n, "size": octets}`` complété par
    le détail des exclusions : ``skipped_demo_dirs``/``demo_dir_names``
    (dossiers de démonstration élagués), ``skipped_media``/``media_exts``
    (fichiers média ignorés), ``skipped_large_images``/``image_exts``
    (images au-delà de ``MAX_IMAGE_MB``) et ``kept_hidden_dirs`` (sous-modules
    cachés conservés).
    """
    import tarfile

    limit = max_file_mb * _MB
    files_count = 0
    skipped_large = 0
    counters = _new_archive_counters()

    with tarfile.open(archive_path, mode="w:gz") as tar:
        for node_dir in node_dirs:
            node_dir = Path(node_dir)
            # Entrée racine du node, même si le dossier est vide.
            tar.add(str(node_dir), arcname=node_dir.name, recursive=False)
            for root, files in _iter_node_files(node_dir, counters):
                rel_root = root.relative_to(node_dir)
                if rel_root != Path("."):
                    tar.add(
                        str(root),
                        arcname=str(Path(node_dir.name) / rel_root),
                        recursive=False,
                    )
                for file_path in files:
                    try:
                        size = file_path.stat().st_size
                    except OSError:
                        continue
                    if size > limit:
                        skipped_large += 1
                        continue
                    arcname = str(Path(node_dir.name) / rel_root / file_path.name)
                    tar.add(str(file_path), arcname=arcname)
                    files_count += 1

    return {
        "files": files_count,
        "skipped_large": skipped_large,
        "skipped_demo_dirs": counters["skipped_demo_dirs"],
        "demo_dir_names": sorted(counters["demo_dirs"]),
        "skipped_media": counters["skipped_media"],
        "media_exts": sorted(counters["media_exts"]),
        "skipped_large_images": counters["skipped_large_images"],
        "image_exts": sorted(counters["image_exts"]),
        "kept_hidden_dirs": sorted(counters["hidden_dirs"]),
        "skipped_gateway_dir": counters["gateway_dir"],
        "size": os.path.getsize(archive_path),
    }


def _format_mb(size_bytes: float) -> str:
    """Formate une taille en MB (une décimale sous 10 MB, entier au-dessus)."""
    mb = size_bytes / _MB
    return f"{mb:.0f} MB" if mb >= 10 else f"{mb:.1f} MB"


def _archive_too_big_message(
    size_bytes: int, node_sizes=(), *, max_archive_mb: int = MAX_ARCHIVE_MB
) -> str | None:
    """Message d'abandon si *size_bytes* dépasse la limite, sinon ``None``.

    Ne lève jamais : l'appelant imprime le message et s'arrête proprement.
    """
    if size_bytes <= max_archive_mb * _MB:
        return None

    lines = [
        f"❌ Archive trop volumineuse : {_format_mb(size_bytes)} "
        f"(maximum {max_archive_mb} MB)",
        "   Vérifiez que vos custom nodes ne contiennent pas de modèles ou de caches",
        "   (ni de contenus de démonstration : previews, samples, examples, docs,",
        "   tests, Workflows, LUTS, images, ni de vidéos ou captures d'écran).",
    ]
    ranked = list(node_sizes)[:5]
    if ranked:
        lines.append("   Nodes les plus lourds :")
        for name, node_bytes in ranked:
            lines.append(f"     - {name} : {_format_mb(node_bytes)}")
        lines.append(
            f"   Total des nodes : {_format_mb(sum(b for _, b in node_sizes))}"
        )
    return "\n".join(lines)


def _format_node_list(names, limit: int = 10) -> str:
    """Résumé lisible des nodes (« a, b, … et N autre(s) »)."""
    names = list(names)
    shown = names[:limit]
    text = ", ".join(shown)
    remaining = len(names) - len(shown)
    if remaining > 0:
        text += f" … et {remaining} autre(s)"
    return text


def _archive_exclusion_summary_lines(stats: dict) -> list[str]:
    """Lignes de résumé des exclusions d'un packaging de custom nodes.

    Une ligne par catégorie non vide, dans l'ordre d'affichage de ``main`` :
    dossiers de démonstration, fichiers média, images au-delà de
    ``MAX_IMAGE_MB``, puis fichiers au-delà de ``MAX_FILE_MB``. *stats* est le
    dict retourné par :func:`_build_custom_nodes_archive`.
    """
    lines: list[str] = []
    if stats.get("skipped_demo_dirs"):
        demo_names = [f"{name}/" for name in stats.get("demo_dir_names", ())]
        lines.append(
            f"  ⊘ {_format_node_list(demo_names)} exclu(s) "
            f"({stats['skipped_demo_dirs']} dossier(s), contenu de démonstration)"
        )
    if stats.get("skipped_media"):
        exts = " ".join(stats.get("media_exts", ()))
        lines.append(
            f"  ⊘ {stats['skipped_media']} fichier(s) média/démo ignoré(s) ({exts})"
        )
    if stats.get("skipped_large_images"):
        exts = " ".join(stats.get("image_exts", ()))
        lines.append(
            f"  ⊘ {stats['skipped_large_images']} image(s) > {MAX_IMAGE_MB} MB "
            f"ignorée(s) ({exts})"
        )
    if stats.get("skipped_large"):
        lines.append(
            f"⚠️ {stats['skipped_large']} fichier(s) > {MAX_FILE_MB} MB ignoré(s)"
        )
    if stats.get("kept_hidden_dirs"):
        # Sous-modules git nommés avec un point : conservés volontairement (le
        # node les importe). Ligne informative, PAS une exclusion.
        names = [f"{name}/" for name in stats["kept_hidden_dirs"]]
        lines.append(
            f"  ✔ sous-module(s) caché(s) conservé(s) : {_format_node_list(names)}"
        )
    if stats.get("skipped_gateway_dir"):
        # Code du gateway : embarqué dans l'image, jamais dans le volume (source
        # de vérité unique, cf. docs/COMFYCH.md).
        lines.append(
            f"  ⊘ {stats['skipped_gateway_dir']}/ exclu "
            f"(code du gateway : embarqué dans l'image)"
        )
    return lines

# ── Read config.json for local models to sync ────────────────────────────

# Le config.json de ComfyCH ne vit PLUS dans le dossier du code : il passe par
# holaf_user_paths (arborescence utilisateur du pack AI-Helper). Un `modal run`
# est un PROCESSUS SÉPARÉ : il doit lire/écrire EXACTEMENT le même fichier que
# le serveur, sinon les badges « déjà installé » (synced_custom_nodes) ne
# remonteraient jamais dans l'UI. Repli historique : config.json à côté du
# script (comportement d'origine, hors pack).
try:  # pragma: no cover - dépend du mode de chargement
    from comfych_store import config_path as _resolve_config_path

    _CONFIG_PATH = Path(_resolve_config_path())
except Exception:  # noqa: BLE001 — repli : jamais bloquant pour un sync
    _CONFIG_PATH = _SCRIPT_DIR / "config.json"


def _update_local_config(updates: dict) -> None:
    """Merge *updates* into the local ``config.json`` (best-effort).

    Called from the local entrypoint (``modal run``) so the ComfyUI backend can
    serve facts about the remote volumes without a Modal round-trip.
    A read-only/missing ``config.json`` must never break a successful sync, hence
    the broad exception guard.
    """
    try:
        current = {}
        if _CONFIG_PATH.exists():
            try:
                loaded = json.loads(_CONFIG_PATH.read_text())
                if isinstance(loaded, dict):
                    current = loaded
            except (json.JSONDecodeError, OSError):
                current = {}
        current.update(updates)
        _CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        _CONFIG_PATH.write_text(json.dumps(current, indent=2))
    except OSError as e:  # noqa: BLE001 — le sync lui-même a réussi
        print(f"⚠️ Impossible d'écrire {_CONFIG_PATH}: {e}")


models_to_sync: list[dict] = []
if _CONFIG_PATH.exists():
    try:
        _cfg = json.loads(_CONFIG_PATH.read_text())
        models_to_sync = _cfg.get("models_to_sync", [])
    except (json.JSONDecodeError, OSError):
        pass

# ── Find local ComfyUI models directory ──────────────────────────────────

def _require_models_dir() -> Path:
    """``models/`` local EXISTANT, ou échec explicite (code de sortie ≠ 0).

    Un dossier introuvable ne doit JAMAIS se traduire par un sync « réussi » :
    les modèles sélectionnés ne seraient simplement pas poussés, et l'UI
    afficherait quand même une réussite. Toute la logique de résolution vit
    dans :func:`comfych_paths.models_dir_candidates` (folder_paths → walk-up →
    dossier du code), et le message d'échec liste TOUS les chemins essayés.
    """
    return first_existing_or_raise("models/", models_dir_candidates())


# Dossier ``models/`` local s'il EXISTE (``None`` sinon). Déterminé au
# chargement pour l'affichage, mais l'étape 1 exige un dossier réel via
# :func:`_require_models_dir` — un chemin inexistant n'est jamais utilisé.
local_models_dir: Path | None = first_existing(models_dir_candidates())

# ── Build image (minimal) ─────────────────────────────────────────────
# Local models are NO LONGER baked into the image — they are uploaded in
# chunks directly to the volume (see upload_model_chunk below). The image
# only needs Python sources + aria2 + huggingface_hub for HF downloads.

# ── Modules LOCAUX embarqués dans l'image (source de vérité du CODE) ──
# ``modal run sync.py`` monte ``/root/sync.py`` dans le container, mais PAS ses
# modules frères. Tout module local importé par CE fichier doit donc être
# déclaré ici : sinon le container plante à l'import et Modal RÉESSAIE en boucle
# (log réel :
#
#     File "/root/sync.py", line 36, in <module>
#         from comfych_paths import (...)
#     ModuleNotFoundError: No module named 'comfych_paths'
#     Runner failed with exception … toujours en cours (66s) (76s) (86s) …
#
# ). Toutes les fonctions distantes deviennent alors inutilisables.
# ``test_comfych_image_modules.py`` compare AUTOMATIQUEMENT cette liste aux
# imports locaux RÉELS de ce fichier (analyse AST) : la récidive est impossible.
IMAGE_LOCAL_PYTHON_SOURCES = ("comfych_paths", "helpers", "models")

# Modules locaux importés de façon OPTIONNELLE (sous ``try:``) : le script se
# charge sans eux grâce au repli prévu dans le code, ils ne sont donc pas
# exigés dans l'image. ``comfych_store`` en fait partie et n'est PAS ajouté
# volontairement : il résout l'arborescence utilisateur du pack via
# ``holaf_user_paths`` (absent du container de sync, utile seulement au
# processus LOCAL ``modal run``).
OPTIONAL_LOCAL_PYTHON_SOURCES = ("comfych_store",)


def _module_level_import_names(tree) -> tuple[set[str], set[str]]:
    """``(imports de niveau MODULE requis, optionnels)`` d'un arbre AST.

    « Requis » = imports exécutés à CHAQUE chargement du module : leur absence
    dans le container tue le démarrage. Les imports placés dans un ``try:``
    (repli assumé) ou derrière un ``if`` de niveau module (``TYPE_CHECKING``)
    sont « optionnels » : le module se charge sans eux.

    Les imports faits DANS une fonction ne sont pas examinés : ils sont
    paresseux (ex. ``import tarfile``) et ne peuvent pas empêcher le container
    de démarrer.
    """

    def _names_of(node) -> set[str]:
        found: set[str] = set()
        if isinstance(node, ast.Import):
            for alias in node.names:
                found.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if getattr(node, "level", 0) or not node.module:
                return found  # import relatif : hors sujet pour l'image
            found.add(node.module.split(".")[0])
        return found

    required: set[str] = set()
    optional: set[str] = set()

    def _walk(statements, is_optional: bool) -> None:
        for stmt in statements:
            if isinstance(stmt, (ast.Import, ast.ImportFrom)):
                (optional if is_optional else required).update(_names_of(stmt))
            elif isinstance(stmt, (ast.Try, getattr(ast, "TryStar", ast.Try))):
                _walk(stmt.body, True)
                for handler in stmt.handlers:
                    _walk(handler.body, True)
                _walk(getattr(stmt, "finalbody", []), True)
            elif isinstance(stmt, ast.If):
                _walk(stmt.body, True)
                _walk(stmt.orelse, True)
            elif isinstance(stmt, ast.With):
                _walk(stmt.body, is_optional)

    _walk(tree.body, False)
    return required, optional


def local_import_modules(source_path=None) -> dict:
    """Imports **locaux** de *source_path* (modules FRÈRES du même dossier).

    Retourne ``{"required": [...], "optional": [...], "available": [...]}``.
    « Local » = un module frère existe (``<dir>/<nom>.py`` ou
    ``<dir>/<nom>/__init__.py``). Les modules de la stdlib et les paquets pip
    ne sont donc jamais concernés — aucun jugement à porter sur eux.
    """
    path = Path(source_path) if source_path is not None else Path(__file__)
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except (OSError, SyntaxError, ValueError):
        return {"required": [], "optional": [], "available": []}

    required, optional = _module_level_import_names(tree)
    directory = path.parent
    available = {
        name
        for name in (required | optional)
        if (directory / f"{name}.py").is_file()
        or (directory / name / "__init__.py").is_file()
    }
    return {
        "required": sorted(required & available),
        "optional": sorted(optional & available - required),
        "available": sorted(available),
    }


def missing_local_python_sources(declared=None, source_path=None) -> list[str]:
    """Modules locaux REQUIS par le script mais ABSENTS de *declared*.

    C'est la liste qui rend impossible la régression « ModuleNotFoundError: No
    module named 'comfych_paths' » : un test la veut vide, et un mutant (module
    retiré de la déclaration) la rend non vide.
    """
    if declared is None:
        declared = IMAGE_LOCAL_PYTHON_SOURCES
    declared_set = set(declared or ())
    required = local_import_modules(source_path)["required"]
    return sorted(name for name in required if name not in declared_set)


def _preflight_image_modules() -> None:
    """Échoue VITE et CLAIREMENT si l'image ne peut pas importer un module local.

    Un container qui plante à l'import est relancé indéfiniment par Modal
    (« Runner failed with exception » … « toujours en cours (66s) (76s) ») : du
    temps GPU brûlé pour un défaut DÉTERMINISTE, détectable AVANT tout appel
    distant. La vérification porte sur la MÊME liste que l'image (aucune seconde
    source de vérité) et produit un message qui nomme le module manquant.
    """
    missing = missing_local_python_sources()
    if not missing:
        return
    _fail(
        "Image Modal INCOMPLÈTE pour sync.py",
        "Module(s) local(aux) importé(s) mais ABSENT(s) de "
        f"add_local_python_source : {_format_node_list(missing)}.\n"
        f"Déclaré(s) : {_format_node_list(IMAGE_LOCAL_PYTHON_SOURCES)}.\n"
        "Sans eux, CHAQUE fonction distante plante à l'import et Modal réessaie "
        "en boucle (coût GPU, aucun node synchronisé).",
    )


_sync_image = (
    modal.Image.debian_slim(python_version="3.11")
    # Les INSTALLATIONS d'abord : les couches apt/pip restent en cache quand on
    # édite seulement un module du pack. Avec ``add_local_python_source`` AVANT
    # elles, chaque édition de ``helpers.py``/``models.py``/``comfych_paths.py``
    # changeait le hash des couches apt+pip et les faisait rejouer au run
    # suivant (impression que « ça réinstalle » à chaque sync).
    .apt_install("aria2")
    .pip_install("huggingface_hub")
    # Le CODE local EN DERNIER. ``comfych_paths`` est indispensable : sync.py
    # l'importe au niveau module (résolution des chemins ComfyUI).
    .add_local_python_source(*IMAGE_LOCAL_PYTHON_SOURCES, copy=True)
)

app = modal.App("comfy-sync", image=_sync_image)


# ── Remote functions: chunked upload of local models to the volume ──────


def _link_and_update_manifest(filename: str, model_dir: str) -> None:
    """Create the ComfyUI symlink for a model and update model_manifest.json.

    Must be called inside a Modal function with the volume mounted at /cache.
    """
    import json as _json

    dst = _model_dest(filename)

    # Create symlink in ComfyUI model directory
    target_dir = resolve_model_dir(model_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / filename

    if target_path.exists() or target_path.is_symlink():
        target_path.unlink()

    target_path.symlink_to(dst)

    # Update manifest (accumulate with existing entries)
    manifest_path = Path("/cache") / "model_manifest.json"
    existing_manifest = {}
    if manifest_path.exists():
        try:
            existing_manifest = _json.loads(manifest_path.read_text())
        except (ValueError, OSError):
            pass
    existing_manifest[filename] = model_dir
    manifest_path.write_text(_json.dumps(existing_manifest, indent=2))


@app.function(
    cpu=1,
    memory=512,
    volumes={"/cache": vol},
    timeout=60,
)
def check_model_exists(filename: str, size: int) -> dict:
    """Check whether a model file already exists on the volume with the same size."""
    dst = _model_dest(filename)
    exists = dst.exists() and dst.stat().st_size == size
    return {"exists": exists}


@app.function(
    cpu=2,
    memory=4096,
    volumes={"/cache": vol},
    timeout=3600,
)
def upload_model_chunk(
    chunk_data: bytes,
    filename: str,
    model_dir: str,
    offset: int,
    is_last: bool,
) -> dict:
    """Append one chunk of a model file to the volume.

    Chunks are written sequentially (mode "ab" when offset > 0, "wb" for the
    first chunk). On the last chunk, the symlink + manifest are updated and
    the volume is committed.
    """
    dest = _model_dest(filename)

    mode = "ab" if offset > 0 else "wb"
    with open(dest, mode) as f:
        f.write(chunk_data)

    if is_last:
        _link_and_update_manifest(filename, model_dir)
        vol.commit()
        return {"ok": True, "filename": filename, "size": os.path.getsize(dest)}

    return {"ok": True, "offset": offset + len(chunk_data)}


@app.function(
    cpu=1,
    memory=512,
    volumes={"/cache": vol},
    timeout=120,
)
def link_model(filename: str, model_dir: str) -> dict:
    """Re-create symlink + manifest entry for a model already on the volume."""
    _model_dest(filename)  # validate the name before touching the volume
    _link_and_update_manifest(filename, model_dir)
    vol.commit()
    return {"ok": True, "filename": filename, "linked": True}


# ── Volume custom nodes : extraction / swap / manifeste ─────────────────


def _extract_archive_to_staging(archive_path: str, staging_dir: str) -> list[str]:
    """Valide puis extrait l'archive tar.gz *archive_path* dans *staging_dir*.

    Les liens, chemins absolus, ``..`` et échappements sont rejetés par
    :func:`_validate_tar_members` AVANT toute écriture. L'extraction se fait
    dans un dossier de staging : **le contenu existant du volume n'est pas
    touché ici** (une archive corrompue ou tronquée laisse donc le volume
    intact).

    Retourne la liste des entrées de premier niveau extraites (toujours non
    vide : une archive vide est refusée).
    """
    import shutil as _shutil
    import tarfile

    if os.path.exists(staging_dir):
        _shutil.rmtree(staging_dir)
    os.makedirs(staging_dir)

    with tarfile.open(archive_path, mode="r:gz") as tar:
        _validate_tar_members(tar.getmembers(), staging_dir)
        tar.extractall(path=staging_dir)

    extracted = sorted(os.listdir(staging_dir))
    if not extracted:
        raise ValueError(
            f"Archive VIDE ({os.path.basename(archive_path)}) : rien à installer — "
            "le volume est laissé en l'état."
        )
    return extracted


def _move_path(src: str, dst: str) -> None:
    """Déplace *src* vers *dst* (renommage atomique, repli copie+déplacement).

    Indirection volontaire : les tests de rollback simulent un échec en
    remplaçant cette fonction, sans patcher ``os`` globalement.
    """
    try:
        os.replace(src, dst)
    except OSError:
        # Montages différents (impossible dans le volume, mais un test ou un
        # montage exotique peut l'être) : repli non atomique assumé.
        import shutil as _shutil

        _shutil.move(src, dst)


def _remove_path(path: str) -> None:
    """Supprime un fichier, un lien ou un dossier (*path* peut ne pas exister)."""
    import shutil as _shutil

    if os.path.isdir(path) and not os.path.islink(path):
        _shutil.rmtree(path)
    elif os.path.exists(path) or os.path.islink(path):
        os.remove(path)


# Préfixe des dossiers internes du volume : jamais swappés (staging, upload,
# sauvegarde, manifeste).
_INTERNAL_ENTRIES = {_STAGING_DIR_NAME, _UPLOAD_DIR_NAME, _BACKUP_DIR_NAME}


def _is_internal_entry(name: str) -> bool:
    """True si l'entrée de premier niveau *name* est interne au volume.

    Les entrées cachées (``.staging``, ``.backup``, ``.nodes_manifest.json``,
    ``.Trash``…) ne sont jamais des nodes et sont PRÉSERVÉES par le swap : les
    supprimer avant d'installer le nouveau contenu exposerait le volume à une
    perte de données en cas d'échec.
    """
    return name in _INTERNAL_ENTRIES or name.startswith(".")


def _swap_volume_content(base_path: str, staging_dir: str) -> list[str]:
    """Remplace le contenu de *base_path* par celui de *staging_dir*.

    SWAP NON DESTRUCTIF, en quatre temps :

    1. l'ancien contenu est **renommé** dans ``.backup`` (renommage : aucun
       octet copié, aucune consommation d'espace supplémentaire), puis marqué
       complet (``.backup/.complete``) ;
    2. les entrées du staging sont installées dans ``base_path`` ;
    3. en cas d'échec en (2), l'installation partielle est retirée et
       **l'ancien contenu est restauré** depuis ``.backup`` avant que
       l'exception ne remonte (la sauvegarde n'est jamais détruite tant que la
       restauration n'est pas complète) ;
    4. en cas de succès, la génération précédente est **conservée** (une seule
       génération, cf. ``.complete``) : un sync raté ou un contenu douteux peut
       toujours être comparé/restauré.

    L'ancien code SUPPRIMAIT tout le contenu de ``custom_nodes`` avant
    d'installer le nouveau : un échec au milieu (quota, disque plein, entrée
    non déplaçable, container tué) laissait le volume VIDE ou partiel — d'où des
    packs qui « disparaissent » après un sync raté (« ComfyCH n'existe plus »).

    Retourne la liste triée des nodes (dossiers) présents après le swap.
    """
    import shutil as _shutil

    backup_dir = os.path.join(base_path, _BACKUP_DIR_NAME)
    marker = os.path.join(backup_dir, _BACKUP_COMPLETE_MARKER)

    # Rien à installer : ne pas toucher au volume (garde-fou explicite).
    if not os.path.isdir(staging_dir) or not os.listdir(staging_dir):
        raise ValueError("Staging vide : swap annulé, le volume est laissé en l'état.")

    # Sauvegarde existante : remplaçable SEULEMENT si le swap qui l'a créée est
    # allé au bout (marqueur). Sinon elle peut être le seul exemplaire des
    # anciens nodes (swap interrompu) — on refuse plutôt que de la détruire.
    if os.path.isdir(backup_dir) and os.listdir(backup_dir):
        if not os.path.isfile(marker):
            raise RuntimeError(
                f"{backup_dir} contient une sauvegarde INCOMPLÈTE (swap interrompu) : "
                "swap refusé pour ne rien détruire. Examinez/restaurez-la, puis "
                "relancez le sync."
            )
        _shutil.rmtree(backup_dir)
    os.makedirs(backup_dir, exist_ok=True)

    # (1) Ancien contenu → sauvegarde (renommage : réversible et instantané).
    saved: list[str] = []
    for item in os.listdir(base_path):
        if _is_internal_entry(item):
            continue
        _move_path(os.path.join(base_path, item), os.path.join(backup_dir, item))
        saved.append(item)
    _write_backup_marker(marker, saved)

    # (2) Nouveau contenu du staging → volume.
    installed: list[str] = []
    try:
        for item in sorted(os.listdir(staging_dir)):
            _move_path(os.path.join(staging_dir, item), os.path.join(base_path, item))
            installed.append(item)
    except (OSError, shutil.Error, ValueError) as exc:
        # (3) ROLLBACK : retirer ce qui a été installé, remettre l'ancien contenu.
        for item in installed:
            try:
                _remove_path(os.path.join(base_path, item))
            except OSError:
                pass
        restored = 0
        for item in saved:
            try:
                _move_path(os.path.join(backup_dir, item), os.path.join(base_path, item))
                restored += 1
            except OSError:
                pass  # ce qui reste dans .backup y demeure (jamais supprimé)
        if restored == len(saved):
            # Ancien contenu intégralement restauré : la sauvegarde est vide.
            try:
                _remove_path(marker)
                os.rmdir(backup_dir)
            except OSError:
                pass
        else:
            print(
                f"⚠️ Restauration PARTIELLE ({restored}/{len(saved)}) : le reste est "
                f"conservé dans {backup_dir}",
                flush=True,
            )
        raise RuntimeError(
            f"Échec pendant l'installation du nouveau contenu ({exc}) : ancien "
            f"contenu restauré ({restored}/{len(saved)} entrée(s)), volume inchangé."
        ) from exc

    # (4) Succès : staging vidé, génération précédente conservée dans .backup.
    _shutil.rmtree(staging_dir)

    return sorted(
        d for d in os.listdir(base_path)
        if not _is_internal_entry(d)
        and os.path.isdir(os.path.join(base_path, d))
    )


def _write_backup_marker(marker_path: str, entries) -> None:
    """Marque la sauvegarde comme COMPLÈTE (entrées sauvegardées, dénombrable)."""
    try:
        with open(marker_path, "w") as f:
            json.dump({"complete": True, "entries": list(entries)}, f, indent=2)
    except OSError as exc:  # pragma: no cover - écriture de quelques octets
        print(f"⚠️ Marqueur de sauvegarde non écrit ({marker_path}) : {exc}", flush=True)


def _write_nodes_manifest(base_path: str, nodes: list[str]) -> None:
    """Écrit ``.nodes_manifest.json`` : nodes RÉELLEMENT présents sur le volume.

    Source de vérité des badges « déjà installé » dans l'UI (le volume, pas la
    sélection). À écrire AVANT le ``commit()`` pour être persisté avec le swap.
    """
    manifest_path = os.path.join(base_path, NODES_MANIFEST_NAME)
    with open(manifest_path, "w") as f:
        json.dump({"nodes": nodes, "synced_at": datetime.now().isoformat()}, f, indent=2)


@app.function(
    cpu=2,
    memory=4096,
    volumes={"/custom_nodes": custom_nodes_vol},
    timeout=1800,
)
def extract_custom_nodes_from_volume(archive_name: str) -> dict:
    """Extrait sur le volume une archive tar.gz déjà uploadée (streaming).

    L'archive est lue depuis ``/custom_nodes/_upload/<archive_name>`` : plus
    aucun contenu binaire ne transite par un argument RPC (l'ancien transport
    ``bytes`` faisait sérialiser plusieurs Go côté client → OOM/SIGKILL).

    Même pipeline qu'avant — validation des membres, extraction en
    ``.staging``, swap, manifeste, ``commit()`` — mais le swap est
    **non destructif** : l'ancien contenu est renommé en ``.backup`` avant
    toute installation et restauré si le swap échoue (cf.
    :func:`_swap_volume_content`). Une archive corrompue, tronquée ou vide est
    refusée AVANT de toucher au volume. L'archive temporaire et le dossier
    ``_upload`` sont supprimés AVANT le commit (sinon la suppression ne serait
    pas persistée).
    """
    import shutil as _shutil
    import tarfile

    name = str(archive_name or "")
    if not name or name in (".", "..") or "/" in name or "\\" in name:
        raise ValueError(f"Nom d'archive invalide : {archive_name!r}")

    base_path = _CUSTOM_NODES_ROOT
    upload_dir = os.path.join(base_path, _UPLOAD_DIR_NAME)
    archive_path = os.path.join(upload_dir, name)
    staging_dir = os.path.join(base_path, _STAGING_DIR_NAME)

    if not os.path.isfile(archive_path):
        raise FileNotFoundError(f"Archive introuvable sur le volume : {archive_path}")

    try:
        expected = _extract_archive_to_staging(archive_path, staging_dir)
        print(
            f"📦 {len(expected)} entrée(s) extraites dans {staging_dir} : "
            f"{', '.join(expected[:10])}{' …' if len(expected) > 10 else ''}",
            flush=True,
        )
        nodes = _swap_volume_content(base_path, staging_dir)
    # ``EOFError`` = gzip tronqué (« Compressed file ended before the
    # end-of-stream marker was reached »), ``tarfile.TarError`` = archive
    # corrompue : aucun des deux ne doit empêcher le message explicite.
    except (OSError, ValueError, RuntimeError, EOFError, tarfile.TarError) as exc:
        # Le volume n'a pas été modifié (ou a été restauré) : on le dit, et on
        # laisse l'exception remonter → code ≠ 0 côté ``modal run``.
        print(
            f"❌ Extraction ANNULÉE, volume inchangé : {exc}",
            flush=True,
        )
        raise

    # Le swap préserve ``_upload`` : on le supprime explicitement (archive
    # consommée et éventuels restes d'un run précédent).
    try:
        if os.path.isdir(upload_dir):
            _shutil.rmtree(upload_dir)
    except OSError as e:  # noqa: BLE001 — le sync lui-même a réussi
        print(f"⚠️ Nettoyage de {upload_dir} impossible : {e}")

    _write_nodes_manifest(base_path, nodes)
    custom_nodes_vol.commit()

    return {"status": "ok", "nodes": nodes}


# ── Remote function: read the custom nodes manifest from the volume ─────


@app.function(
    cpu=1,
    memory=512,
    volumes={"/custom_nodes": custom_nodes_vol},
    timeout=60,
)
def get_custom_nodes_manifest() -> dict:
    """Read ``/custom_nodes/.nodes_manifest.json`` from the volume.

    Returns ``{"nodes": [...], "synced_at": <iso>}``, or an empty list and
    ``None`` when the manifest is absent (volume never synced by this code).
    """
    custom_nodes_vol.reload()
    manifest_path = os.path.join(_CUSTOM_NODES_ROOT, NODES_MANIFEST_NAME)
    if not os.path.isfile(manifest_path):
        return {"nodes": [], "synced_at": None}
    try:
        with open(manifest_path) as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return {"nodes": [], "synced_at": None}
    nodes = data.get("nodes") if isinstance(data, dict) else None
    return {
        "nodes": nodes if isinstance(nodes, list) else [],
        "synced_at": data.get("synced_at") if isinstance(data, dict) else None,
    }


# ── Remote function: download HuggingFace + external models ──────────────


@app.function(
    cpu=1,
    memory=2048,
    volumes={"/cache": vol},
    secrets=get_hf_secrets(),
)
def sync_hf_models() -> None:
    """Download all models defined in ``models.py`` into the shared Volume."""
    print(f"HuggingFace models: {len(models)} | External: {len(models_ext)}")

    for i, model in enumerate(models, start=1):
        print(f"[{i}/{len(models)}] HF: {model['repo_id']}/{model['filename']}")
        hf_download(model["repo_id"], model["filename"], model["model_dir"])

    for i, model in enumerate(models_ext, start=1):
        print(f"[{i}/{len(models_ext)}] External: {model['filename']}")
        download_external_model(model["url"], model["filename"], model["model_dir"])


# ── User settings sync : bases SQLite ────────────────────────────────────

# Suffixes de bases SQLite : INCLUS dans l'upload des réglages utilisateur.
# Les custom nodes y persistent leurs préférences (ex. ComfyUI-AI-Helper y
# stocke ``server_url``/``api_key``) : les exclure vidait les réglages.
SQLITE_SUFFIXES = {".db", ".sqlite"}

# Compagnons d'une base en mode WAL : jamais uploadés seuls (ils seraient
# incohérents), ils accompagnent la copie cohérente — ou le fallback quand la
# base est verrouillée en écriture exclusive.
SQLITE_SIDECAR_SUFFIXES = ("-wal", "-shm")

# Fichiers tournants ou temporaires : jamais synchronisés.
USER_SETTINGS_EXCLUDE_SUFFIXES = {".log", ".tmp", ".temp"}

# Garde-fou : au-delà, une base n'est pas transférée (durée d'upload et poids
# du volume). Les réglages qu'elle contient sont alors perdus côté worker.
MAX_USER_DB_MB = 200

# Fichier de credentials AIH : ``<user>/default/AI-Helper/config/credentials.json``
# (nouvel emplacement) ou ``<user>/default/aih/credentials.json`` (historique).
# Il porte ``server_url`` + ``api_key`` lus par les nodes AIH du worker.
CREDENTIALS_FILENAME = "credentials.json"


def _value_presence(value) -> str:
    """« renseignée » / « vide » — JAMAIS la valeur (clé API en clair).

    C'est la seule information nécessaire au diagnostic : le log ne doit
    jamais contenir la clé elle-même (il finit dans un volume, puis dans le
    navigateur via la fenêtre de suivi du run).
    """
    return "renseignée" if str(value or "").strip() else "vide"


def _credentials_sync_report(user_dir, selected) -> list:
    """Lignes de diagnostic de ``credentials.json`` avant l'upload.

    Répond à la question qui compte quand le worker se plaint de
    « credentials incomplets (api_key ou server_url manquant) » :
      1. le fichier est-il DANS le périmètre poussé (``user/``) ? ;
      2. est-il renseigné CÔTÉ LOCAL ?
    Si (1) est oui et (2) aussi, le problème est en aval (volume périmé /
    worker non redémarré) ; si (1) est non, la résolution du dossier ``user/``
    locale ne voit pas le fichier que l'UI vient d'écrire.

    Args:
        user_dir: dossier ``user/`` local effectivement synchronisé.
        selected: fichiers retenus par :func:`_select_user_setting_files`.

    Retours:
        list[str]: UNE ligne de synthèse, plus une ligne d'aide si absent.
    """
    user_dir = Path(user_dir)
    creds = [p for p in selected if Path(p).name == CREDENTIALS_FILENAME]
    if not creds:
        return [
            (
                f"📁 user/ : {len(selected)} fichier(s), "
                f"{CREDENTIALS_FILENAME} présent=non — les nodes AIH du worker "
                f"n'auront ni server_url ni api_key (renseignez Settings ▸ "
                f"onglet « AIH · Compte » puis relancez la sync)"
            ),
        ]

    # Plusieurs emplacements peuvent coexister (nouveau + historique) : le
    # worker retient le NOUVEAU s'il est présent, on cite le premier trouvé.
    chosen = min(creds, key=lambda p: ("aih" in Path(p).parts, str(p)))
    try:
        with open(chosen, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        if not isinstance(data, dict):
            data = {}
        read_error = ""
    except (OSError, ValueError) as exc:
        data = {}
        read_error = f" (illisible : {type(exc).__name__})"

    rel = Path(chosen).relative_to(user_dir) if Path(chosen).is_relative_to(user_dir) else chosen
    lines = [
        (
            f"📁 user/ : {len(selected)} fichier(s), {CREDENTIALS_FILENAME} présent=oui "
            f"({rel}), server_url={_value_presence(data.get('server_url'))}, "
            f"api_key={_value_presence(data.get('api_key'))}{read_error}"
        )
    ]
    if not str(data.get("server_url") or "").strip():
        lines.append(
            "   ↳ server_url VIDE en local : le worker ne pourra résoudre aucune "
            "URL relative (Settings ▸ onglet « AIH · Compte »)"
        )
    if not str(data.get("api_key") or "").strip():
        lines.append(
            "   ↳ api_key VIDE en local : les appels AIH du worker seront refusés"
        )
    return lines


def _is_sqlite_file(path: Path) -> bool:
    """True si *path* est une base SQLite (``.db`` / ``.sqlite``)."""
    return Path(path).suffix.lower() in SQLITE_SUFFIXES


def _is_sqlite_sidecar(path: Path) -> bool:
    """True si *path* est un journal SQLite (``*-wal`` / ``*-shm``)."""
    name = Path(path).name.lower()
    return any(name.endswith(suffix) for suffix in SQLITE_SIDECAR_SUFFIXES)


def _snapshot_sqlite(src: Path, dst: Path) -> bool:
    """Copie cohérente d'une base SQLite via l'API backup.

    Une simple copie de fichier peut être incohérente si la base est en mode
    WAL et qu'une transaction est en cours (cas d'un ComfyUI qui tourne). L'API
    backup lit un état transactionnellement cohérent.

    Returns True si la copie a réussi, False sinon (l'appelant fait un fallback).
    """
    src = Path(src)
    dst = Path(dst)
    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        src_conn = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
        try:
            dst_conn = sqlite3.connect(str(dst))
            try:
                src_conn.backup(dst_conn)
            finally:
                dst_conn.close()
        finally:
            src_conn.close()
        return True
    except Exception as e:
        print(f"  ⚠️ Snapshot SQLite impossible pour {src.name} : {e}", flush=True)
        return False


def _copy_sqlite_with_journal(src: Path, dst: Path) -> bool:
    """Fallback : copie la base ET ses journaux ``-wal``/``-shm``.

    Utilisé quand l'API backup échoue (base verrouillée en écriture exclusive).
    Copier les compagnons permet à SQLite de rejouer le journal au chargement
    côté worker. Returns True si au moins le fichier principal a été copié.
    """
    src = Path(src)
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    copied = False
    for p in (src, Path(str(src) + "-wal"), Path(str(src) + "-shm")):
        if p.is_file():
            try:
                shutil.copy2(str(p), str(dst.parent / p.name))
                copied = copied or p == src
            except OSError as e:
                print(f"  ⚠️ Copie de {p.name} impossible : {e}", flush=True)
    return copied


def _prepare_sqlite_upload(
    src: Path, rel_path: Path, tmp_dir: Path
) -> list[tuple[Path, Path]]:
    """Prépare l'upload d'une base : ``[(fichier local, chemin relatif)]``.

    Chemin nominal : un snapshot cohérent (API backup) est uploadé seul.
    Fallback : la base et ses journaux sont copiés dans *tmp_dir* puis
    uploadés ensemble, pour que SQLite rejoue le WAL au chargement.
    """
    tmp_dir = Path(tmp_dir)
    tmp_dir.mkdir(parents=True, exist_ok=True)
    snapshot = tmp_dir / Path(src).name
    if _snapshot_sqlite(src, snapshot):
        return [(snapshot, rel_path)]

    if _copy_sqlite_with_journal(src, snapshot):
        return [
            (p, Path(rel_path).parent / p.name)
            for p in sorted(tmp_dir.iterdir())
            if p.is_file()
        ]

    # Dernier recours : le fichier tel quel (mieux qu'une base absente).
    return [(Path(src), rel_path)]


def _select_user_setting_files(
    user_dir, *, max_db_mb: float | None = None
) -> list[Path]:
    """Fichiers de ``user/`` à uploader vers ``comfy-user-settings``.

    Les bases SQLite sont conservées (les réglages des custom nodes y vivent),
    mais leurs journaux ``-wal``/``-shm`` sont écartés : ils accompagnent la
    copie cohérente gérée par :func:`_prepare_sqlite_upload`. Les fichiers de
    log/temp et les dossiers de cache restent exclus.
    """
    user_dir = Path(user_dir)
    limit_mb = MAX_USER_DB_MB if max_db_mb is None else max_db_mb
    limit_bytes = limit_mb * _MB

    selected: list[Path] = []
    for f in sorted(user_dir.rglob("*")):
        if not f.is_file():
            continue
        if f.suffix.lower() in USER_SETTINGS_EXCLUDE_SUFFIXES:
            continue
        # Journaux SQLite : jamais uploadés séparément de leur base.
        if _is_sqlite_sidecar(f):
            continue
        # Dossiers de cache (téléchargements du manager, cache HF local…).
        if "cache" in f.parts or "__manager" in f.parts:
            continue
        if _is_sqlite_file(f):
            size = _file_size(f)
            if size is not None and size > limit_bytes:
                print(
                    f"  ⚠️ Base ignorée (> {limit_mb:g} MB) : {f.name} — les "
                    f"réglages qu'elle contient ne seront pas transférés",
                    flush=True,
                )
                continue
        selected.append(f)
    return selected


# ── Échec explicite ───────────────────────────────────────────────────


def _fail(message: str, error=None) -> None:
    """Termine le script en ÉCHEC EXPLICITE (code de sortie 1).

    Point unique de sortie en erreur : un dossier introuvable ne doit jamais
    être suivi d'un « ✅ terminé » ni d'un code 0. Le gateway lit le code de
    retour de ``modal run`` (``_run_cmd`` → ``_run_sequence_inner``), qui
    ANNULES les étapes suivantes (le redémarrage du worker n'a donc pas lieu).

    Le message liste TOUS les chemins essayés quand *error* est un
    :class:`ComfyPathNotFound` — c'est ce qui rend le diagnostic immédiat.
    """
    print(f"\n{'='*60}", flush=True)
    print(f"❌ {message}", flush=True)
    if error is not None:
        print(f"{error}", flush=True)
    print(f"{'='*60}", flush=True)
    print("Aucune autre étape n'a été exécutée.", flush=True)
    raise SystemExit(1)


# ── Local entrypoint: orchestrate the full sync ──────────────────────────


@app.local_entrypoint()
def main(sync_custom_nodes: bool = False, sync_user_only: bool = False) -> None:
    """Local entrypoint — uploads local models, then syncs HuggingFace models.

    With ``--sync-custom-nodes``, only the custom nodes archive is synced to
    the dedicated ``comfy-custom-nodes`` volume (other steps are skipped).
    With ``--sync-user-only``, only step 3 (user settings) runs.
    """

    # GARDE-FOU ANTI-RETRY-INFINI : un module local importé par ce fichier mais
    # absent de ``add_local_python_source`` fait planter CHAQUE fonction distante
    # à l'import, et Modal relance le container indéfiniment (coût GPU, log qui
    # tourne en boucle). Le défaut est déterministe : on échoue AVANT le premier
    # appel distant. ``--sync-user-only`` n'appelle aucune fonction distante
    # (upload client seulement) : pas de contrôle nécessaire.
    if not sync_user_only:
        _preflight_image_modules()


    def _sync_user_settings() -> None:
        """Step 3 — upload the local ``user/`` directory to its Volume.

        ÉCHEC BRUYANT : un dossier ``user/`` introuvable sort en code ≠ 0 (voir
        :func:`_fail`) — jamais un « ✅ Sync terminée ! ». Sinon le worker
        redémarrerait en relisant un volume INCHANGÉ, et les réglages locaux
        seraient écrasés par les anciens, en silence.
        """
        print(f"\n{'='*60}")
        print(f"👤 Syncing user settings to volume")
        print(f"{'='*60}\n")

        user_vol = modal.Volume.from_name("comfy-user-settings", create_if_missing=True)

        # Dossier user/ de ComfyUI : résolution du module (env explicite →
        # folder_paths si importable → WALK-UP depuis le code → holaf_user_paths
        # → ~/.config/comfyui seulement s'il existe). Hors ComfyUI (``modal
        # run`` est un processus séparé), seul le walk-up est fiable : c'est
        # lui qui donne ``…/ComfyUI/user``.
        try:
            user_dir = first_existing_or_raise("user/", user_dir_candidates())
        except ComfyPathNotFound as exc:
            _fail("Sync des réglages utilisateur IMPOSSIBLE", exc)

        # Bases SQLite incluses (réglages des custom nodes) : elles sont
        # copiées via l'API backup et non par une simple copie de fichier.
        files_to_upload = _select_user_setting_files(user_dir)
        dbs = sum(1 for f in files_to_upload if _is_sqlite_file(f))

        print(f"📁 Dossier user/ local : {user_dir}", flush=True)
        # Diagnostic CREDENTIALS : une seule ligne qui dit si le fichier lu par
        # les nodes AIH du worker est bien DANS le périmètre et renseigné. Jamais
        # la valeur de la clé (seulement « vide » / « renseignée »).
        for line in _credentials_sync_report(user_dir, files_to_upload):
            print(line, flush=True)
        print(
            f"📁 Uploading {len(files_to_upload)} user setting file(s)"
            f" (dont {dbs} base(s) SQLite)…",
            flush=True,
        )

        uploaded = 0
        skipped = 0
        skipped_names: list[str] = []
        # Dossier de travail des snapshots SQLite : nettoyé quoi qu'il
        # arrive, il ne doit jamais rester de copie de base sur disque.
        tmp_root = Path(tempfile.mkdtemp(prefix="comfych-user-sync-"))
        # Un SEUL batch_upload pour tous les fichiers : chaque
        # ``with user_vol.batch_upload()`` ouvre une session réseau, la
        # rouvrir par fichier rendait l'upload très lent.
        #
        # ⚠️ ``force=True`` est INDISPENSABLE. Par défaut, Modal REFUSE
        # d'écraser un fichier déjà présent sur le volume
        # (``batch_upload(force=False)`` → ``put_file`` lève ``FileExistsError``).
        # L'ancien code avalait cette exception en comptant « already present » :
        # un fichier poussé une première fois n'était donc PLUS JAMAIS mis à
        # jour. C'est exactement le piège qui vidait les credentials du worker :
        # ``credentials.json`` (server_url + api_key) restait sur le volume dans
        # sa version d'origine, et le container la recopiait à chaque démarrage.
        try:
            with user_vol.batch_upload(force=True) as batch:
                for index, f in enumerate(files_to_upload):
                    rel_path = f.relative_to(user_dir)
                    if _is_sqlite_file(f):
                        entries = _prepare_sqlite_upload(
                            f, rel_path, tmp_root / f"db{index}"
                        )
                    else:
                        entries = [(f, rel_path)]
                    for src_file, dest_rel in entries:
                        try:
                            batch.put_file(str(src_file), f"/{dest_rel}")
                            uploaded += 1
                        except FileExistsError:
                            skipped += 1
                            skipped_names.append(str(dest_rel))
        except FileExistsError as exc:
            # Batch refusé d'emblée (ex. conflit signalé hors put_file).
            skipped += 1
            skipped_names.append(f"(batch) {exc}")
        finally:
            shutil.rmtree(tmp_root, ignore_errors=True)

        print(
            f"✅ User settings synced to volume ({uploaded} uploaded "
            f"(fichiers existants remplacés), {skipped} skipped)",
            flush=True,
        )
        if skipped_names:
            preview = ", ".join(skipped_names[:5])
            more = f" (+{len(skipped_names) - 5})" if len(skipped_names) > 5 else ""
            print(
                f"⚠️ NON transféré(s) : {preview}{more} — si "
                f"{CREDENTIALS_FILENAME} apparaît ici, le volume garde son "
                f"ancienne version et le worker lira des credentials périmés",
                flush=True,
            )
        print(
            "ℹ️ Le worker ne relit le volume qu'à son DÉMARRAGE : "
            "redémarrez-le pour que les réglages (dont credentials.json) soient "
            "pris en compte.",
            flush=True,
        )

    # ── User settings only mode ────────────────────────────────────────
    if sync_user_only:
        _sync_user_settings()
        # Ce bloc n'est atteint QUE si l'étape 3 a réussi (_fail sort avant).
        print(f"\n{'='*60}")
        print("✅ Sync terminée !")
        print(f"{'='*60}")
        return

    # ── Custom nodes only mode ─────────────────────────────────────────
    if sync_custom_nodes:
        # NOTE : tous les ``print`` de cette branche utilisent ``flush=True``.
        # Sans flush, la sortie est bufferisée quand stdout n'est pas un TTY
        # (cas de ``modal run`` lancé par le gateway) : l'UI resterait muette
        # pendant tout le packaging, qui est la partie la plus longue.
        print(f"\n{'='*60}", flush=True)
        print("🧩 Syncing custom nodes to volume", flush=True)
        print(f"{'='*60}\n", flush=True)

        # Dossier custom_nodes : résolu par comfych_paths (folder_paths →
        # walk-up → position du pack). L'ancienne déduction
        # ``_SCRIPT_DIR.parent`` visait ``<pack>/tools`` dans le pack : elle
        # « trouvait » un dossier (tools/) et n'y voyait aucun node — échec
        # silencieux.
        try:
            custom_nodes_dir = first_existing_or_raise(
                "custom_nodes/", custom_nodes_dir_candidates()
            )
        except ComfyPathNotFound as exc:
            _fail("Sync des custom nodes IMPOSSIBLE", exc)

        print(f"📦 Packaging des custom nodes depuis {custom_nodes_dir}…", flush=True)

        # Sélection : le gateway lui-même et le dossier de données ``user`` ne
        # sont pas des nodes ; les dossiers techniques/cachés non plus, ni ceux
        # qui n'ont pas de ``__init__.py`` (non chargeables par ComfyUI).
        node_dirs, skipped = _select_node_dirs(custom_nodes_dir)
        for name, reason in skipped:
            print(f"  ⊘ {name} exclu ({reason})", flush=True)
        print(f"  → {len(node_dirs)} node(s) inclus", flush=True)
        if not node_dirs:
            _fail(f"Aucun custom node à synchroniser dans {custom_nodes_dir}")
        if any(Path(d).name == PROJECT_ROOT_NAME for d in node_dirs):
            # SOURCE DE VÉRITÉ UNIQUE (cf. docs/COMFYCH.md) : le code des nodes
            # du pack voyage par le VOLUME (l'image ne porte que ses deps pip).
            # Le log le dit, pour qu'on ne croie jamais que l'image le fournit.
            print(
                f"  ✔ {PROJECT_ROOT_NAME} inclus : son code vient du VOLUME "
                "(l'image n'embarque que ses dépendances pip)",
                flush=True,
            )

        # Tailles calculées AVANT le packaging : sert au résumé et au diagnostic
        # en cas d'archive trop volumineuse.
        node_sizes = _node_size_report(node_dirs)
        total = _format_mb(sum(size for _, size in node_sizes))
        print(f"  → {total} de fichiers retenus "
              f"(modèles, caches, binaires et contenus de démonstration exclus)",
              flush=True)

        # Archive écrite sur disque (jamais en RAM : plusieurs centaines de Mo).
        tmp_archive = tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False)
        tmp_path = tmp_archive.name
        tmp_archive.close()
        archive_name = f"custom_nodes_{datetime.now().strftime('%Y%m%d_%H%M%S')}.tar.gz"

        try:
            stats = _build_custom_nodes_archive(node_dirs, tmp_path)
            size_bytes = stats["size"]

            for line in _archive_exclusion_summary_lines(stats):
                print(line, flush=True)
            print(f"✅ Archive créée : {_format_mb(size_bytes)}", flush=True)

            too_big = _archive_too_big_message(size_bytes, node_sizes)
            if too_big:
                # Refus explicite : l'archive n'est PAS poussée (code ≠ 0).
                _fail(too_big)

            names = [Path(d).name for d in node_dirs]
            print(
                f"📦 Archive : {_format_mb(size_bytes)} — {len(names)} node(s)\n"
                f"   {_format_node_list(names)}",
                flush=True,
            )

            # Upload streaming : ``batch_upload`` envoie le fichier octet par
            # octet vers le volume. L'ancien transport passait l'archive
            # entière en argument RPC (sérialisation de plusieurs Go → OOM /
            # SIGKILL côté client).
            print("☁️  Upload de l'archive vers le volume…", flush=True)
            with custom_nodes_vol.batch_upload() as batch:
                batch.put_file(tmp_path, f"/{_UPLOAD_DIR_NAME}/{archive_name}")

            print("🔧 Extraction sur Modal…", flush=True)
            result = extract_custom_nodes_from_volume.remote(archive_name)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

        nodes = result.get("nodes", [])
        print(f"✅ Sync terminé : {len(nodes)} node(s) sur le volume", flush=True)
        for n in nodes:
            print(f"  📁 {n}", flush=True)
        print(
            "🗄️  Génération précédente conservée sur le volume dans "
            f"/custom_nodes/{_BACKUP_DIR_NAME} (restaurable après un sync "
            "douteux ; à supprimer si le volume manque d'espace).",
            flush=True,
        )

        # Le volume est la source de vérité : on en garde une copie locale dans
        # config.json pour que le backend ComfyUI puisse répondre instantanément
        # à GET /api/modal/plugins/installed (sans appel Modal).
        if result.get("status") == "ok":
            _update_local_config({
                "synced_custom_nodes": nodes,
                "last_sync_custom_nodes": datetime.now().isoformat(),
            })
            print(f"📝 Manifeste local mis à jour ({len(nodes)} node(s))", flush=True)
        return

    # ── Step 1: Upload + link local models ───────────────────────────────
    if models_to_sync:
        print(f"\n{'='*60}")
        print(f"📦 Step 1: Uploading {len(models_to_sync)} local model(s) to Volume")
        print(f"{'='*60}\n")

        # Dossier ``models/`` local : EXIGÉ existant. Sans lui, chaque modèle
        # sélectionné était annoncé « not found » puis le script sortait en
        # code 0 — l'UI affichait une réussite pour un upload inexistant.
        try:
            models_root = _require_models_dir()
        except ComfyPathNotFound as exc:
            _fail("Sync des modèles IMPOSSIBLE", exc)
        print(f"📁 Dossier models/ local : {models_root}", flush=True)

        results = {}

        for model in models_to_sync:
            filename = model["filename"]
            model_dir = model["model_dir"]

            model_path = models_root / model_dir / filename
            if not model_path.exists():
                print(f"  ❌ Local model not found: {model_path}")
                results[filename] = {"ok": False, "error": "not found locally"}
                continue

            size = model_path.stat().st_size
            size_mb = size / (1024 * 1024)

            # Skip upload if already on the volume with the same size
            existing = check_model_exists.remote(filename, size)
            if existing.get("exists"):
                print(f"  ⏭️ Already on volume: {filename} ({size_mb:.0f} MB) — linking only")
                link_model.remote(filename, model_dir)
                results[filename] = {"ok": True, "size_mb": round(size_mb, 1), "skipped": True}
                continue

            # Upload by chunks of 100 MB
            print(f"  📤 Uploading: {filename} ({size_mb:.0f} MB)")
            offset = 0
            uploaded_mb = 0
            try:
                with open(model_path, "rb") as f:
                    while True:
                        chunk = f.read(CHUNK_SIZE)
                        if not chunk:
                            break
                        is_last = offset + len(chunk) >= size
                        upload_model_chunk.remote(chunk, filename, model_dir, offset, is_last)
                        offset += len(chunk)
                        uploaded_mb = offset / (1024 * 1024)
                        pct = (offset / size) * 100 if size else 100
                        print(f"     {uploaded_mb:.0f}/{size_mb:.0f} MB ({pct:.0f}%)")
            except Exception as e:  # noqa: BLE001 — report and continue with next model
                print(f"  ❌ Upload failed: {filename}: {e}")
                results[filename] = {"ok": False, "error": str(e)}
                continue

            print(f"  ✅ {filename}: uploaded ({size_mb:.0f} MB) + linked")
            results[filename] = {"ok": True, "size_mb": round(size_mb, 1)}

        ok_count = sum(1 for r in results.values() if r.get("ok"))
        fail_count = len(results) - ok_count

        print(f"\n📊 Results: {ok_count} OK, {fail_count} failed")
        for filename, info in results.items():
            status = "✅" if info.get("ok") else "❌"
            size = info.get("size_mb", 0)
            error = info.get("error", "")
            if info.get("ok"):
                skipped = " (déjà présent)" if info.get("skipped") else ""
                print(f"  {status} {filename} ({size} MB){skipped}")
            else:
                print(f"  {status} {filename}: {error}")

        if fail_count > 0:
            # Échec BRUYANT : des modèles sélectionnés n'ont pas été poussés.
            # Un code 0 ferait croire à une sync complète côté gateway.
            _fail(f"{fail_count} fichier(s) n'ont pas pu être uploadés")

    else:
        print("\nℹ️ No local models selected in config.json")

    # ── Step 2: Download HuggingFace models (from models.py) ─────────────
    if models or models_ext:
        print(f"\n{'='*60}")
        print(f"📥 Step 2: Downloading HuggingFace/external models")
        print(f"{'='*60}\n")
        sync_hf_models.remote()

    # ── Step 3: Sync user settings to volume ───────────────────────────────
    _sync_user_settings()

    # Ce bloc n'est atteint QUE si toutes les étapes ont réussi : _fail() sort
    # en code 1 avant (étape 3 comprise), ce qui annule le redémarrage du
    # worker côté gateway.
    print(f"\n{'='*60}")
    print("✅ Sync terminée !")
    print(f"{'='*60}")