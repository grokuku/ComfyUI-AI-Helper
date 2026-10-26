"""Shared Docker image for ComfyUI workers.

Extracted from ``comfyui.py`` so that multiple worker variants (L4, L40S,
A100, H100) can reuse the same image definition without duplication.

Model downloads have been moved to ``sync.py`` (CPU-only, runs on a cheap
container).  This image **must not** download any models.
"""

from __future__ import annotations

import json
import re
import shlex
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


def _build_image() -> modal.Image:
    """Build and return the ComfyUI Docker image (no model downloads)."""
    image = (
        modal.Image.debian_slim(python_version="3.11")
        .add_local_python_source("image", "helpers", "auth", "gateway_router", "workers", "models", "plugins", copy=True)
        .apt_install("git", "git-lfs", "libgl1-mesa-dev", "libglib2.0-0", "aria2")
        .pip_install_from_requirements(str(root_dir / "requirements_comfy.txt"))
        .run_commands("comfy --skip-prompt install --nvidia")
        .run_commands("git lfs install")
    )

    # ── Optional workflow dependencies ──────────────────────────────────
    workflow_file_path = root_dir / "workflow_api.json"
    if workflow_file_path.exists():
        image = image.add_local_file(
            workflow_file_path, "/root/workflow_api.json", copy=True
        ).run_commands("comfy node install-deps --workflow=/root/workflow_api.json")
    else:
        print(
            "Warning: workflow_api.json not found. "
            "API endpoint might not work without a workflow."
        )

    # ── Dépendances pip de TOUS les custom nodes locaux (installées AU BUILD) ──
    # Les nodes sont synchronisés par le volume à l'exécution, donc leur code
    # n'est pas dans l'image — MAIS leurs requirements.txt sont lisibles ici.
    # Les installer au build évite de payer ``pip install`` à chaque démarrage
    # de container (mesuré : 141-187 s de « préparation » sur 30 nodes) et rend
    # les dépendances persistantes (les installs runtime ne survivent pas au
    # snapshot).
    local_custom_nodes_dir = root_dir.parent  # ComfyUI/custom_nodes
    if local_custom_nodes_dir.is_dir():
        node_dirs = []
        for entry in sorted(local_custom_nodes_dir.iterdir()):
            if not entry.is_dir():
                continue
            if entry.name.startswith(".") or entry.name == "__pycache__":
                continue
            if entry.name == root_dir.name:  # le gateway lui-même
                continue
            node_dirs.append(entry)

        installed = 0
        for node_dir in node_dirs:
            name = node_dir.name
            # Le nom devient un composant de chemin dans l'image : on refuse ce
            # qui pourrait en sortir (``..``, séparateurs, shell).
            if ".." in name or _SAFE_NODE_DIR_RE.fullmatch(name) is None:
                print(f"⚠️ Nom de dossier de node ignoré (non sûr) : {name!r}")
                continue
            req_file = node_dir / "requirements.txt"
            if not req_file.is_file():
                continue
            try:
                image = image.add_local_file(
                    str(req_file), f"/deps/{name}/requirements.txt", copy=True
                )
                image = image.run_commands(
                    f"pip install -r /deps/{name}/requirements.txt || "
                    f"echo '⚠️ Échec deps pour {name} (build continue)'"
                )
                installed += 1
            except Exception as e:  # noqa: BLE001 — jamais bloquant pour le build
                print(f"⚠️ Impossible de préparer les deps de {name} : {e}")
        print(f"📦 Dépendances de {installed} custom node(s) locales installées au build")

    # ── Paquets pip supplémentaires (dépendances optionnelles des nodes) ──
    # Ex. sageattention est requis par comfyui-kjnodes mais absent de son
    # requirements.txt ; mediapipe pour comfyui_facetools. Installé en
    # best-effort : un échec (compilation CUDA impossible au build, version
    # incompatible) ne doit JAMAIS casser l'image.
    try:
        for package in _extra_pip_packages(_read_saved_config()):
            print(f"📦 Paquet pip supplémentaire : {package}")
            image = image.run_commands(_pip_install_command(package))
    except Exception as exc:  # noqa: BLE001 — jamais bloquant pour le build
        print(f"⚠️ Paquets pip supplémentaires ignorés : {exc}")

    # ── Reverse-proxy fix so workflow save works behind Modal's edge proxy
    image = image.add_local_dir(
        root_dir / "vendor_nodes" / "reverse_proxy_fix",
        "/root/comfy/ComfyUI/custom_nodes/reverse_proxy_fix",
        copy=True,
    )

    return image


# ── Single shared instance ───────────────────────────────────────────────
image = _build_image()
