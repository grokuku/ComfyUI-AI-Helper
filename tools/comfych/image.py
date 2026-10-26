"""Shared Docker image for ComfyUI workers.

Extracted from ``comfyui.py`` so that multiple worker variants (L4, L40S,
A100, H100) can reuse the same image definition without duplication.

Model downloads have been moved to ``sync.py`` (CPU-only, runs on a cheap
container).  This image **must not** download any models.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import uuid
from pathlib import Path

import modal
from plugins import comfy_plugins

try:
    from plugins import comfy_plugins_ext
except ImportError:
    comfy_plugins_ext = []

custom_nodes_local = []

# Ces trois listes (config.json / plugins.py) décrivent la sélection *côté
# gateway* : elles ne pilotent plus les deps installées au build. Le build scanne
# TOUS les dossiers de custom nodes locaux (voir ``_build_image``) parce que les
# nodes réellement actifs sont ceux du volume, pas ceux de ``config.json``.
_CONFIG_PATH = Path(__file__).resolve().parent / "config.json"
if _CONFIG_PATH.exists():
    try:
        _saved = json.loads(_CONFIG_PATH.read_text())
        if _saved.get("custom_nodes"):
            comfy_plugins = list(_saved["custom_nodes"])
        if _saved.get("custom_nodes_ext"):
            comfy_plugins_ext = list(_saved["custom_nodes_ext"])
        if _saved.get("custom_nodes_local"):
            custom_nodes_local = list(_saved["custom_nodes_local"])
    except (json.JSONDecodeError, OSError):
        pass


# ── Paquets pip supplémentaires (dépendances optionnelles des nodes) ────

# Même liste blanche que __init__.py (défense en profondeur : ``config.json``
# est éditable à la main). Tout le reste est ignoré, jamais concaténé dans une
# commande shell.
_PIP_PACKAGE_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.\-+=<>!~,\[\]]*$")
_PIP_PACKAGE_MAX_LEN = 80

# Nom de dossier de custom node utilisable comme composant de chemin dans
# l'image (``/deps/<name>/requirements.txt``) : pas de séparateur, pas de
# ``..``, pas de caractère de shell. Tout le reste est ignoré.
_SAFE_NODE_DIR_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.\-]*$")


def _read_saved_config() -> dict:
    """Contenu de ``config.json`` sous forme de dict (vide si absent/illisible).

    Aucune exception ne remonte : l'image doit pouvoir être construite même avec
    un ``config.json`` corrompu ou un dossier en lecture seule.
    """
    try:
        loaded = json.loads(_CONFIG_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _is_safe_pip_package(package) -> bool:
    """True si *package* peut être passé tel quel à ``pip install``."""
    if not isinstance(package, str):
        return False
    value = package.strip()
    if not value or len(value) > _PIP_PACKAGE_MAX_LEN:
        return False
    return _PIP_PACKAGE_RE.fullmatch(value) is not None


def _extra_pip_packages(config: dict | None = None) -> list[str]:
    """Paquets pip supplémentaires valides de *config* (jamais d'exception).

    Les entrées refusées (caractère interdit, nom vide, type inattendu) sont
    écartées silencieusement : elles ne doivent jamais empêcher le build.
    """
    if config is None:
        config = _read_saved_config()
    if not isinstance(config, dict):
        return []
    packages = config.get("extra_pip_packages")
    if not isinstance(packages, list):
        return []
    accepted: list[str] = []
    for item in packages:
        if _is_safe_pip_package(item):
            value = item.strip()
            if value not in accepted:
                accepted.append(value)
    return accepted


def _pip_install_command(package: str) -> str:
    """Commande d'installation de *package*, qui ne peut JAMAIS casser le build.

    ``pip install`` peut échouer au build (compilation CUDA impossible sans GPU,
    version incompatible, index injoignable). La commande est donc suffixée d'un
    ``|| echo`` : ``run_commands`` voit toujours un code de retour 0 et l'image
    est construite, le node concerné échouant seulement à l'exécution.
    """
    quoted = shlex.quote(package.strip())
    return f"pip install {quoted} || echo '⚠️ Échec installation {quoted} (build continue)'"


root_dir = Path(__file__).parent
"""``<custom_nodes>/ComfyUI-AI-Helper/tools/comfych`` (les modules du gateway)."""

# Modules LOCAUX du gateway embarqués dans l'image worker (module frères de ce
# fichier). Toute absence d'un module réellement importé par l'un d'eux fait
# planter le container à l'import (``ModuleNotFoundError``) et Modal réessaie en
# boucle : ``tests/test_comfych_image_modules.py`` vérifie cette liste par
# analyse AST (aucune récidive possible).
IMAGE_LOCAL_PYTHON_SOURCES = (
    "image",
    "helpers",
    "auth",
    "gateway_router",
    "workers",
    "models",
    "plugins",
)

PACK_DIR = root_dir.parent.parent
"""Dossier du pack AI-Helper = ``<custom_nodes>/ComfyUI-AI-Helper``.

ATTENTION : ``custom_nodes`` est **deux** niveaux au-dessus de ``root_dir``.
L'ancien code déduisait ``root_dir.parent`` (= ``<pack>/tools``) et excluait en
plus les dossiers nommés ``comfych`` : il ne trouvait donc AUCUN custom node et
loggait « 📦 Dépendances de 0 custom node(s) locales installées au build » —
conséquence : ``watchdog`` (pack AI-Helper), ``cv2`` (Impact…), ``gguf``
(ComfyUI-GGUF), ``pywt`` (RES4LYF)… n'étaient jamais installés et les packs
échouaient à l'import sur le worker (« Node 'AIH Prompt Enhancer' not found »).
"""

# Un dossier ``custom_nodes`` de ComfyUI : ``custom_nodes``, ``custom_nodes_ext``…
_CUSTOM_NODES_DIR_RE = re.compile(r"^custom_nodes(_[A-Za-z0-9_.\-]+)?$", re.IGNORECASE)

# Nombre de caractères hexadécimaux de l'empreinte de déploiement.
_STAMP_LEN = 16

# Préfixe de version de l'empreinte : l'incrémenter invalide tous les caches de
# déploiement (à faire si la formule change, sinon un build « identique » serait
# sauté à tort).
_FINGERPRINT_VERSION = "comfych-deps-v1"


def custom_nodes_dir_candidates(pack_dir: Path | str | None = None) -> list[Path]:
    """Candidats pour le dossier ``custom_nodes`` **local** (celui du build).

    Les dépendances sont installées dans l'image à partir des fichiers locaux
    (``add_local_file``), donc le dossier doit être résolu sur la machine qui
    lance ``modal deploy`` — pas dans le container.

    Ordre : ``$COMFYCH_CUSTOM_NODES_DIR`` (override explicite) → parent direct du
    pack s'il s'appelle ``custom_nodes*`` → ancêtre ``custom_nodes*`` du pack →
    ``<ancêtre>/custom_nodes`` existant.

    Un dossier n'est retenu que si son NOM ressemble à ``custom_nodes`` : sans ce
    filtre, un pack installé hors ComfyUI (``/projects/ComfyUI-AI-Helper``)
    ferait scanner ``/projects`` et installer les dépendances de projets voisins.
    """
    pack = Path(pack_dir) if pack_dir is not None else PACK_DIR
    candidates: list[Path] = []

    def _add(path: Path) -> None:
        try:
            resolved = Path(path)
        except (OSError, TypeError):
            return
        if resolved not in candidates:
            candidates.append(resolved)

    override = (os.environ.get("COMFYCH_CUSTOM_NODES_DIR") or "").strip()
    if override:
        _add(Path(override))

    for ancestor in pack.parents:
        if _CUSTOM_NODES_DIR_RE.match(ancestor.name):
            _add(ancestor)

    for ancestor in pack.parents:
        sibling = ancestor / "custom_nodes"
        if sibling not in candidates and sibling.is_dir():
            _add(sibling)

    return candidates


def local_custom_nodes_dir(pack_dir: Path | str | None = None) -> Path | None:
    """Dossier ``custom_nodes`` local EXISTANT, ou ``None`` (jamais d'exception)."""
    for candidate in custom_nodes_dir_candidates(pack_dir):
        try:
            if candidate.is_dir():
                return candidate
        except OSError:
            continue
    return None


def _requirements_entries(
    pack_dir: Path | str | None = None,
    custom_nodes_dir: Path | str | None = None,
) -> list[dict]:
    """``requirements.txt`` à installer au build, **PACK AI-HELPER EN PREMIER**.

    Ordre imposé :

    1. ``requirements.txt`` du pack AI-Helper — il porte les dépendances vitales
       du pack lui-même (``watchdog``, ``aiohttp``, ``av``, ``psutil``…). Sans
       elles, l'import du pack échoue entièrement sur le worker (et TOUS ses
       nodes disparaissent de ComfyUI). Ce fichier est donc ajouté même quand
       la découverte des autres nodes échoue ou renvoie 0.
    2. ``requirements.txt`` de CHAQUE custom node local détecté (tous packs
       confondus : ``cv2`` pour Impact, ``gguf``, ``pywt``…).

    Le pack n'est jamais exclu de cette liste : son dossier est simplement
    dédoublonné (il est déjà en tête). Seuls les dossiers cachés/techniques et
    les noms non sûrs (utilisables comme composant de chemin dans l'image) sont
    écartés.

    Returns
    -------
    list[dict]
        ``{"name": str, "path": Path, "is_pack": bool}`` dans l'ordre
        d'installation.
    """
    pack = Path(pack_dir) if pack_dir is not None else PACK_DIR
    entries: list[dict] = []
    seen: set = set()

    def _add(name: str, path: Path, is_pack: bool) -> None:
        try:
            key = path.resolve()
        except OSError:
            key = path
        if key in seen:
            return
        seen.add(key)
        entries.append({"name": name, "path": path, "is_pack": bool(is_pack)})

    pack_requirements = pack / "requirements.txt"
    if pack_requirements.is_file():
        _add(pack.name or "ComfyUI-AI-Helper", pack_requirements, True)

    if custom_nodes_dir is not None:
        nodes_dir: Path | None = Path(custom_nodes_dir)
    else:
        nodes_dir = local_custom_nodes_dir(pack)
    if nodes_dir is None or not nodes_dir.is_dir():
        return entries

    for entry in sorted(nodes_dir.iterdir()):
        try:
            if not entry.is_dir():
                continue
        except OSError:
            continue
        name = entry.name
        if name.startswith((".", "__")):
            continue
        # Le nom devient un composant de chemin dans l'image : on refuse ce qui
        # pourrait en sortir (``..``, séparateurs, shell).
        if _SAFE_NODE_DIR_RE.fullmatch(name) is None:
            print(f"⚠️ Nom de dossier de node ignoré (non sûr) : {name!r}")
            continue
        requirements = entry / "requirements.txt"
        if not requirements.is_file():
            continue
        _add(name, requirements, False)

    return entries


def _file_digest(path) -> bytes:
    """SHA-256 du contenu du fichier *path* (jamais d'exception)."""
    try:
        return hashlib.sha256(Path(path).read_bytes()).digest()
    except (OSError, TypeError, ValueError):
        return b"<illisible>"


def dependencies_fingerprint(
    entries: list[dict] | None = None,
    extra_packages=None,
    force_token: str = "",
) -> str:
    """Empreinte des dépendances installées au build (hex tronqué).

    C'est l'empreinte de déploiement de l'image : elle dépend du **contenu** de
    chaque ``requirements.txt`` retenu, de la **liste** des nodes détectés et
    d'``extra_pip_packages``. Un changement de dépendances produit donc une
    image différente — et ``modal deploy`` reconstruit au lieu de répondre
    « ✓ Deployment skipped: no changes detected! ⏭️ ».

    *force_token* non vide rend l'empreinte unique : c'est le levier du bouton
    « Forcer le déploiement » (aucun flag ``--force`` n'existe dans la CLI
    ``modal deploy`` : la seule façon de ne pas être « skippé » est de changer
    la définition de l'app).
    """
    digest = hashlib.sha256()
    digest.update(_FINGERPRINT_VERSION.encode("utf-8"))
    token = str(force_token or "").strip()
    if token:
        digest.update(b"|force:" + token.encode("utf-8"))
    for entry in entries or []:
        digest.update(b"|node:" + str(entry.get("name") or "").encode("utf-8"))
        digest.update(b"|content:" + _file_digest(entry.get("path")))
    for package in extra_packages or []:
        digest.update(b"|pip:" + str(package).encode("utf-8"))
    return digest.hexdigest()[:_STAMP_LEN]


def _force_token() -> str:
    """Jeton de reconstruction forcée demandé par l'appelant (``""`` sinon).

    ``COMFYCH_DEPLOY_FORCE_TOKEN`` : jeton explicite (route ``/api/modal/deploy``
    avec ``{"force": true}``). ``COMFYCH_FORCE_DEPLOY=1`` : équivalent, jeton
    tiré au hasard.
    """
    explicit = (os.environ.get("COMFYCH_DEPLOY_FORCE_TOKEN") or "").strip()
    if explicit:
        return explicit
    flag = (os.environ.get("COMFYCH_FORCE_DEPLOY") or "").strip().lower()
    if flag in {"1", "true", "yes", "on"}:
        return uuid.uuid4().hex
    return ""


def deploy_stamp(
    pack_dir: Path | str | None = None,
    custom_nodes_dir: Path | str | None = None,
    extra_packages=None,
    force_token: str | None = None,
) -> str:
    """Empreinte de déploiement complète (dépendances + jeton de forcage)."""
    entries = _requirements_entries(pack_dir, custom_nodes_dir)
    if extra_packages is None:
        extra_packages = _extra_pip_packages()
    if force_token is None:
        force_token = _force_token()
    return dependencies_fingerprint(entries, extra_packages, force_token)


def _build_image() -> modal.Image:
    """Build and return the ComfyUI Docker image (no model downloads)."""
    image = (
        modal.Image.debian_slim(python_version="3.11")
        # ORDRE : les INSTALLATIONS lourdes d'abord, le CODE local en DERNIER.
        # ``add_local_python_source`` était en tête : éditer un module du
        # gateway (``workers/base_worker.py``, ``gateway_router.py``…) changeait
        # le hash des couches suivantes et refaisait apt + pip + ``comfy install
        # --nvidia`` (plusieurs minutes de build) à chaque déploiement.
        .apt_install("git", "git-lfs", "libgl1-mesa-dev", "libglib2.0-0", "aria2")
        .pip_install_from_requirements(str(root_dir / "requirements_comfy.txt"))
        .run_commands("comfy --skip-prompt install --nvidia")
        .run_commands("git lfs install")
    )

    # ── Optional workflow dependencies ──────────────────────────────────
    # ``workflow_api.json`` est OPTIONNEL, et son absence n'est plus un
    # avertissement : il ne servait qu'à faire installer par
    # ``comfy node install-deps`` les dépendances des nodes d'UN workflow.
    # Les deps de TOUS les custom nodes locaux sont désormais installées juste
    # en dessous (détection corrigée), et l'endpoint ``/prompt`` reçoit le
    # workflow dans le corps de la requête — il n'a pas besoin de ce fichier.
    workflow_file_path = root_dir / "workflow_api.json"
    if workflow_file_path.exists():
        print("📄 workflow_api.json trouvé : installation des deps du workflow")
        image = image.add_local_file(
            workflow_file_path, "/root/workflow_api.json", copy=True
        ).run_commands("comfy node install-deps --workflow=/root/workflow_api.json")

    # ── Dépendances pip de TOUS les custom nodes locaux (installées AU BUILD) ──
    # Les nodes sont synchronisés par le volume à l'exécution, donc leur code
    # n'est pas dans l'image — MAIS leurs requirements.txt sont lisibles ici.
    # Les installer au build évite de payer ``pip install`` à chaque démarrage
    # de container (mesuré : 141-187 s de « préparation » sur 30 nodes) et rend
    # les dépendances persistantes (les installs runtime ne survivent pas au
    # snapshot).
    #
    # ORDRE : le pack AI-Helper D'ABORD (watchdog, aiohttp, av… : sans eux le
    # pack ne s'importe pas et tous ses nodes disparaissent), puis chaque node
    # détecté (cv2, gguf, pywt…), puis ``extra_pip_packages``.
    extra_packages = _extra_pip_packages(_read_saved_config())
    entries = _requirements_entries()
    nodes_dir = local_custom_nodes_dir()
    installed = 0

    if nodes_dir is None:
        print(
            "⚠️ Dossier custom_nodes local INTROUVABLE : seules les dépendances "
            "du pack AI-Helper seront installées (les autres packs échoueront à "
            "l'import). Définir COMFYCH_CUSTOM_NODES_DIR pour forcer le chemin."
        )
    elif len(entries) <= 1:
        print(
            f"⚠️ Aucun requirements.txt de custom node trouvé dans {nodes_dir} "
            "(seules les dépendances du pack AI-Helper seront installées)."
        )

    for entry in entries:
        name = entry["name"]
        destination = f"/deps/{name}/requirements.txt"
        label = f"{name} (pack AI-Helper, prioritaire)" if entry["is_pack"] else name
        # Échec EXPLICITE dans le log de déploiement : le nom du node doit y
        # être lisible, sinon l'utilisateur ne voit qu'un ``ModuleNotFoundError``
        # opaque côté worker (le node échouera au chargement, pas au build).
        failure_note = (
            f"echo '❌ ÉCHEC des dépendances de {name} — build poursuivi, ce "
            f"node échouera au chargement sur le worker'"
        )
        try:
            image = image.add_local_file(
                str(entry["path"]), destination, copy=True
            )
            image = image.run_commands(
                f"pip install -r {destination} || {failure_note}"
            )
            installed += 1
            print(f"📦 {installed}. Dépendances de {label}")
        except Exception as exc:  # noqa: BLE001 — jamais bloquant pour le build
            print(f"⚠️ Impossible de préparer les deps de {name} (build continue) : {exc}")

    print(f"📦 Dépendances de {installed} custom node(s) locales installées au build")

    # ── Paquets pip supplémentaires (dépendances optionnelles des nodes) ──
    # Ex. sageattention est requis par comfyui-kjnodes mais absent de son
    # requirements.txt ; mediapipe pour comfyui_facetools. Installé en
    # best-effort : un échec (compilation CUDA impossible au build, version
    # incompatible) ne doit JAMAIS casser l'image.
    try:
        for package in extra_packages:
            print(f"📦 Paquet pip supplémentaire : {package}")
            image = image.run_commands(_pip_install_command(package))
    except Exception as exc:  # noqa: BLE001 — jamais bloquant pour le build
        print(f"⚠️ Paquets pip supplémentaires ignorés : {exc}")

    # ── Code LOCAL du gateway (module frères de ``image.py``) ────────────────
    # Déclaration EN DERNIER : une couche de sources ne réexécute aucune des
    # couches apt/pip/``comfy install`` déjà en cache. ``comfych_paths`` n'est
    # PAS nécessaire ici : aucun module déclaré ci-dessus ne l'importe (vérifié
    # par ``tests/test_comfych_image_modules.py``, qui compare cette liste aux
    # imports locaux RÉELS — même garde-fou que ``sync.py``).
    image = image.add_local_python_source(*IMAGE_LOCAL_PYTHON_SOURCES, copy=True)

    # ── Reverse-proxy fix so workflow save works behind Modal's edge proxy
    image = image.add_local_dir(
        root_dir / "vendor_nodes" / "reverse_proxy_fix",
        "/root/comfy/ComfyUI/custom_nodes/reverse_proxy_fix",
        copy=True,
    )

    # ── Empreinte de déploiement (ANTI « Deployment skipped ») ─────────────
    # ``modal deploy`` ne possède AUCUN flag ``--force`` : quand la définition
    # de l'app n'a pas changé, la CLI répond « ✓ Deployment skipped: no changes
    # detected! ⏭️ » et l'image n'est jamais reconstruite. Cette empreinte entre
    # dans la définition de l'image (variable d'environnement) : elle change dès
    # qu'un requirements.txt, la liste des nodes détectés ou extra_pip_packages
    # change — et le bouton « Forcer le déploiement » la rend unique.
    # Elle est posée en DERNIÈRE étape : une couche ENV ne réexécute aucune des
    # couches pip déjà en cache (le cache Modal reste réutilisé).
    stamp = deploy_stamp(extra_packages=extra_packages)
    print(f"🧾 Empreinte de déploiement : {stamp}")
    image = image.env({"COMFYCH_DEPLOY_STAMP": stamp})

    return image


# ── Single shared instance ───────────────────────────────────────────────
image = _build_image()
