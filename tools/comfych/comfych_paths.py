"""Résolution des dossiers ComfyUI dont ComfyCH a besoin.

ComfyCH a été écrit comme une extension POSÉE À PLAT dans ``custom_nodes/`` :
il déduisait la racine ComfyUI de sa propre position —

    PROJECT_ROOT = custom_nodes/ComfyCH
    PROJECT_ROOT.parent        = custom_nodes
    PROJECT_ROOT.parent.parent = racine ComfyUI   (output/, models/, user/)

Intégré au pack AI-Helper sous ``tools/comfych/``, ces quatre déductions
pointent FAUX — et silencieusement (un dossier inexistant n'échoue pas, il
renvoie simplement des listes vides). Ce module est désormais le SEUL endroit
qui sait où ces dossiers vivent :

    output/        ← folder_paths.get_output_directory()      (gère --output-directory)
    models/        ← folder_paths (checkpoints → parent, sinon base_path/models)
    custom_nodes/  ← folder_paths.get_folder_paths("custom_nodes")  (liste, extra paths)
    user/          ← holaf_user_paths.get_comfy_user_dir()     (même référence que le pack)

Chaque fonction retombe sur l'ANCIENNE déduction (``_legacy_comfy_root()``) si
folder_paths est absent/partiel : hors ComfyUI (tests, scripts), le
comportement d'origine est conservé à l'identique.
"""
from __future__ import annotations

from pathlib import Path

# Dossier du code ComfyCH (tools/comfych) : sert de dernier recours pour
# retrouver l'ancienne disposition « à plat » dans custom_nodes.
CODEFYCH_CODE_ROOT = Path(__file__).resolve().parent


def _folder_paths():
    """Import paresseux de folder_paths (module GLOBAL de ComfyUI).

    Volontairement paresseux : hors ComfyUI le module n'existe pas (tests,
    ``modal run``), et l'absence est un cas NORMAL, pas une erreur.
    """
    try:
        import folder_paths  # import paresseux assumé
        return folder_paths
    except Exception:  # noqa: BLE001 — hors ComfyUI : absence normale
        return None


def _safe_call(func, *args):
    """Appelle *func* en avalant toute exception (folder_paths peut être partiel).

    Selon la version de ComfyUI et le moment de l'import,
    ``get_user_directory``/``get_output_directory`` peuvent lever
    (initialisation en cours) : un repli silencieux est le comportement attendu.
    """
    try:
        return func(*args)
    except Exception:  # noqa: BLE001 — repli attendu
        return None


def _walk_up_to_comfy_root() -> Path | None:
    """Remonte depuis le dossier du code jusqu'à une racine ComfyUI plausible.

    Critère : présence d'un dossier ``custom_nodes`` ou du ``main.py`` de
    ComfyUI. Robuste aux deux dispositions (à plat dans custom_nodes/ComfyCH
    ou imbriqué dans le pack, sous tools/comfych), et ne DEVINE rien hors
    ComfyUI : None plutôt qu'un chemin arbitraire.
    """
    for parent in CODEFYCH_CODE_ROOT.parents:
        try:
            if (parent / "custom_nodes").is_dir() or (parent / "main.py").is_file():
                return parent
        except OSError:
            continue
    return None


def _legacy_comfy_root() -> Path:
    """Dernier recours quand folder_paths est absent (hors ComfyUI).

    Aucune racine identifiable ⇒ le dossier du CODE lui-même : on ne crée
    jamais de dossier ailleurs « au cas où ».
    """
    return _walk_up_to_comfy_root() or CODEFYCH_CODE_ROOT


# ---------------------------------------------------------------------------
# Dossiers résolus
# ---------------------------------------------------------------------------
def output_dir() -> Path:
    """Dossier ``output/`` de ComfyUI (téléchargements « Save locally »).

    Ordre : folder_paths.get_output_directory() → racine ComfyUI/output →
    ``<code ComfyCH>/output`` (dernier recours, jamais créé ici).
    """
    module = _folder_paths()
    getter = getattr(module, "get_output_directory", None) if module else None
    value = _safe_call(getter) if callable(getter) else None
    if value:
        return Path(value).resolve()
    return _legacy_comfy_root() / "output"


def models_dir() -> Path:
    """Dossier ``models/`` de ComfyUI, base du scan « modèles locaux ».

    Ordre : dossier parent des chemins « checkpoints » (c'est TOUJOURS
    ``models/checkpoints`` par défaut) → ``folder_paths.models_dir`` →
    ``folder_paths.base_path/models`` → racine ComfyUI/models.
    """
    module = _folder_paths()
    if module is not None:
        getter = getattr(module, "get_folder_paths", None)
        if callable(getter):
            checkpoints = _safe_call(getter, "checkpoints") or []
            for candidate in checkpoints:
                try:
                    parent = Path(candidate).resolve().parent
                except OSError:
                    continue
                if parent.is_dir():
                    return parent
        for attribute in ("models_dir", "models_path"):
            raw = getattr(module, attribute, None)
            if raw:
                return Path(raw).resolve()
        base = getattr(module, "base_path", None)
        if base:
            return Path(base).resolve() / "models"
    return _legacy_comfy_root() / "models"


def custom_nodes_dirs() -> list[Path]:
    """TOUS les dossiers ``custom_nodes`` connus de ComfyUI (jamais vide).

    ``folder_paths.get_folder_paths("custom_nodes")`` gère les emplacements
    supplémentaires (extra_model_paths.yaml) ; on y ajoute le dossier parent du
    pack, qui est la vérité terrain quand on est chargé comme custom node.
    """
    found: list[Path] = []
    module = _folder_paths()
    getter = getattr(module, "get_folder_paths", None) if module else None
    if callable(getter):
        for raw in _safe_call(getter, "custom_nodes") or []:
            try:
                path = Path(raw).resolve()
            except OSError:
                continue
            if path not in found:
                found.append(path)
    # Dernier recours : dossier parent du PACK (custom_nodes/ComfyUI-AI-Helper),
    # qui est la vérité terrain quand on est chargé comme custom node.
    legacy = _comfy_root() / "custom_nodes" if _comfy_root() else CODEFYCH_CODE_ROOT.parents[1]
    if legacy not in found:
        found.append(legacy)
    return found


def _comfy_root() -> Path | None:
    """Racine ComfyUI (None hors ComfyUI) — voir :func:`_walk_up_to_comfy_root`."""
    return _walk_up_to_comfy_root()


def custom_nodes_dir() -> Path:
    """Premier dossier ``custom_nodes`` (compatibilité des appelants simples)."""
    return custom_nodes_dirs()[0]


def user_dir() -> Path:
    """Dossier ``<ComfyUI>/user`` — MÊME référence que le reste du pack.

    Passe par holaf_user_paths.get_comfy_user_dir() quand le pack est présent
    (une seule source de vérité pour ``--user-directory``), sinon par
    folder_paths, sinon par l'ancienne déduction.
    """
    try:
        from holaf_user_paths import get_comfy_user_dir

        return Path(get_comfy_user_dir()).resolve()
    except Exception:  # noqa: BLE001, S110 — pack absent (script isolé) : repli
        pass
    module = _folder_paths()
    getter = getattr(module, "get_user_directory", None) if module else None
    value = _safe_call(getter) if callable(getter) else None
    if value:
        return Path(value).resolve()
    base = getattr(module, "base_path", None) if module else None
    if base:
        return Path(base).resolve() / "user"
    return _legacy_comfy_root() / "user"


def project_dir() -> Path:
    """Dossier du CODE ComfyCH = cwd des commandes ``modal run`` / ``deploy``.

    Contient ``sync.py``, ``image.py``, ``apps/``, ``workers/`` : il ne change
    pas avec l'intégration (le code reste ici), seule la localisation des
    DONNÉES change (voir comfych_store.py).
    """
    return CODEFYCH_CODE_ROOT


__all__ = [
    "CODEFYCH_CODE_ROOT",
    "custom_nodes_dir",
    "custom_nodes_dirs",
    "models_dir",
    "output_dir",
    "project_dir",
    "user_dir",
]
