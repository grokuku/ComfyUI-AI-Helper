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
    user/          ← folder_paths.get_user_directory()        (gère --user-directory)

PRINCIPE — « un dossier résolu est un dossier qui EXISTE »
----------------------------------------------------------
``folder_paths`` est le module GLOBAL de ComfyUI : il n'est importable que dans
le processus de ComfyUI. Or ``modal run sync.py`` (et tout script du module)
s'exécute dans un **processus SÉPARÉ** où il ne l'est pas : les replis
historiques y renvoyaient ``~/.config/comfyui`` — un chemin qui n'existe pas sur
la machine, accepté comme s'il était bon. La sync des réglages utilisateur
échouait alors en silence (message « local user/ not found », puis « ✅ Sync
terminée ! » et code de sortie 0).

Chaque dossier est donc résolu par une liste ORDONNÉE de candidats
(``*_dir_candidates()``) dont on retient le premier qui **existe réellement** :

1. variable d'environnement explicite (``AIH_COMFY_USER_DIR``) ;
2. ``folder_paths`` (uniquement s'il est importable) ;
3. **walk-up** depuis le dossier du code : le dossier cherché, FRÈRE d'un
   ``custom_nodes`` (c'est le seul indice disponible hors ComfyUI) ;
4. ``holaf_user_paths`` quand le pack est présent (même référence que le reste
   du pack : ``--user-directory`` en tête) ;
5. dernier recours ``~/.config/comfyui`` — **accepté seulement s'il existe**.

:func:`first_existing_or_raise` lève :class:`ComfyPathNotFound` quand AUCUN
candidat n'existe, avec la liste de TOUS les chemins essayés : l'appelant ne
peut plus prendre un chemin inexistant pour une réussite.
"""
from __future__ import annotations

import os
from pathlib import Path

# Dossier du code ComfyCH (tools/comfych) : sert de point de départ au walk-up
# et de dernier recours pour retrouver l'ancienne disposition « à plat ».
CODEFYCH_CODE_ROOT = Path(__file__).resolve().parent

# Variable d'environnement forçant le dossier ``user/`` de ComfyUI (disposition
# exotique, ``--user-directory`` particulier, script externe). Distincte de
# ``AIH_USER_ROOT`` (qui désigne ``<ComfyUI>/user/default/AI-Helper``).
ENV_COMFY_USER_DIR = "AIH_COMFY_USER_DIR"

# Libellés d'origine des candidats (visibles dans les diagnostics).
_SRC_ENV_USER_DIR = f"env {ENV_COMFY_USER_DIR}"
_SRC_FOLDER_PATHS = "folder_paths"
_SRC_WALK_UP = "walk-up (racine ComfyUI déduite du code)"
_SRC_HOLAF = "holaf_user_paths.get_comfy_user_dir()"
_SRC_HOME = "dernier recours (~/.config/comfyui)"
_SRC_CODE_ROOT = "dossier du code ComfyCH"


class ComfyPathNotFound(RuntimeError):
    """Aucun candidat n'existe pour un dossier ComfyUI attendu.

    Porte la liste complète des chemins essayés (:attr:`candidates`) afin que
    l'appelant puisse l'afficher : c'est ce qui rend l'échec DIAGNOSTIQUABLE
    (et impossible à confondre avec un succès).
    """

    def __init__(self, label, candidates):
        self.label = str(label)
        self.candidates = [(str(source), Path(path)) for source, path in candidates]
        super().__init__(format_candidates(self.label, self.candidates))


def format_candidates(label, candidates) -> str:
    """Message d'échec listant TOUS les chemins essayés pour *label*.

    *candidates* est une liste de couples ``(origine, chemin)`` telle que
    retournée par les fonctions ``*_dir_candidates()``.
    """
    lines = [
        f"❌ Dossier {label} de ComfyUI INTROUVABLE — aucun des chemins essayés n'existe :"
    ]
    for source, path in candidates:
        lines.append(f"   ✗ {source} : {path}")
    lines.append(
        "   → ComfyCH tourne peut-être HORS de ComfyUI (``modal run`` est un "
        "processus séparé : folder_paths y est absent)."
    )
    lines.append(
        f"   → Forcez le chemin avec {ENV_COMFY_USER_DIR}=<ComfyUI>"
        f"{os.sep}user si votre disposition est particulière."
    )
    return "\n".join(lines)


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


def _container_hints() -> list[Path]:
    """Dossiers ``custom_nodes`` plausibles déduits de la position du code.

    Couvre les deux dispositions connues :

    - ``custom_nodes/ComfyCH``      → ``parents[0]`` est déjà custom_nodes ;
    - ``custom_nodes/<pack>/tools/comfych`` → ``parents[2]`` (le pack est
      imbriqué dans custom_nodes).

    Seuls les dossiers réellement NOMMÉS ``custom_nodes`` sont retenus : le
    parent d'un pack posé ailleurs (checkout de développement, ``<pack>/tools``)
    n'est pas un dossier de custom nodes, et le retenir ferait scanner
    n'importe quoi comme un node.
    """
    code = CODEFYCH_CODE_ROOT
    hints: list[Path] = []
    try:
        candidates = [code.parents[0]] if len(code.parents) >= 1 else []
        if code.parent.name == "tools" and len(code.parents) >= 3:
            candidates.insert(0, code.parents[2])
    except OSError:  # pragma: no cover — chemin exotique
        return []
    for candidate in candidates:
        try:
            if candidate.name == "custom_nodes" and candidate not in hints:
                hints.append(candidate)
        except OSError:  # pragma: no cover
            continue
    return hints


def _unique(candidates) -> list[tuple[str, Path]]:
    """Dédoublonne les couples ``(origine, chemin)`` en gardant le premier.

    Les chemins sont normalisés (``~`` développé, chemin absolu) : deux
    candidats identiques ne doivent pas apparaître deux fois dans le
    diagnostic.
    """
    seen: set[str] = set()
    result: list[tuple[str, Path]] = []
    for source, raw in candidates:
        if raw is None:
            continue
        try:
            path = Path(os.path.expanduser(str(raw))).resolve()
        except (OSError, ValueError):
            continue
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        result.append((str(source), path))
    return result


# ---------------------------------------------------------------------------
# Listes de candidats (ordre = préférence)
# ---------------------------------------------------------------------------
def user_dir_candidates() -> list[tuple[str, Path]]:
    """Candidats pour ``<ComfyUI>/user``, du plus fiable au dernier recours.

    Le walk-up y figure AVANT le dernier recours : hors ComfyUI (``modal run``),
    c'est le seul indice fiable — ``…/ComfyUI/user`` est un FRÈRE de
    ``…/ComfyUI/custom_nodes``, donc deux niveaux au-dessus du code du pack.
    """
    candidates: list[tuple[str, Path]] = []

    raw_env = os.environ.get(ENV_COMFY_USER_DIR, "")
    if str(raw_env).strip():
        candidates.append((_SRC_ENV_USER_DIR, raw_env))

    module = _folder_paths()
    if module is not None:
        getter = getattr(module, "get_user_directory", None)
        value = _safe_call(getter) if callable(getter) else None
        if value:
            candidates.append((f"{_SRC_FOLDER_PATHS}.get_user_directory()", value))
        base = getattr(module, "base_path", None)
        if base:
            candidates.append((f"{_SRC_FOLDER_PATHS}.base_path/user", Path(base) / "user"))

    root = _walk_up_to_comfy_root()
    if root is not None:
        candidates.append((_SRC_WALK_UP, root / "user"))

    try:  # même référence que le reste du pack (--user-directory en tête)
        from holaf_user_paths import get_comfy_user_dir

        candidates.append((_SRC_HOLAF, get_comfy_user_dir()))
    except Exception:  # noqa: BLE001, S110 — pack absent (script isolé) : repli
        pass

    candidates.append((_SRC_HOME, Path.home() / ".config" / "comfyui"))
    return _unique(candidates)


def models_dir_candidates() -> list[tuple[str, Path]]:
    """Candidats pour ``models/``, du plus fiable au dernier recours.

    Ordre : dossier parent des chemins « checkpoints » (c'est TOUJOURS
    ``models/checkpoints`` par défaut) → ``folder_paths.models_dir`` →
    ``folder_paths.base_path/models`` → walk-up → dossier du code.
    """
    candidates: list[tuple[str, Path]] = []

    module = _folder_paths()
    if module is not None:
        getter = getattr(module, "get_folder_paths", None)
        if callable(getter):
            for candidate in _safe_call(getter, "checkpoints") or []:
                try:
                    parent = Path(candidate).resolve().parent
                except (OSError, ValueError):
                    continue
                candidates.append(
                    (f"{_SRC_FOLDER_PATHS} (parent de checkpoints)", parent)
                )
        for attribute in ("models_dir", "models_path"):
            raw = getattr(module, attribute, None)
            if raw:
                candidates.append((f"{_SRC_FOLDER_PATHS}.{attribute}", raw))
        base = getattr(module, "base_path", None)
        if base:
            candidates.append((f"{_SRC_FOLDER_PATHS}.base_path/models", Path(base) / "models"))

    root = _walk_up_to_comfy_root()
    if root is not None:
        candidates.append((_SRC_WALK_UP, root / "models"))
    candidates.append((_SRC_CODE_ROOT, CODEFYCH_CODE_ROOT / "models"))
    return _unique(candidates)


def custom_nodes_dir_candidates() -> list[tuple[str, Path]]:
    """Candidats pour ``custom_nodes/``, du plus fiable au dernier recours.

    ``folder_paths.get_folder_paths("custom_nodes")`` gère les emplacements
    supplémentaires (extra_model_paths.yaml) ; le walk-up et la position du pack
    couvrent le cas hors ComfyUI.
    """
    candidates: list[tuple[str, Path]] = []

    module = _folder_paths()
    getter = getattr(module, "get_folder_paths", None) if module else None
    if callable(getter):
        for raw in _safe_call(getter, "custom_nodes") or []:
            candidates.append((f"{_SRC_FOLDER_PATHS}.get_folder_paths('custom_nodes')", raw))

    root = _walk_up_to_comfy_root()
    if root is not None:
        candidates.append((_SRC_WALK_UP, root / "custom_nodes"))
    for hint in _container_hints():
        candidates.append(("dossier contenant le code ComfyCH", hint))
    return _unique(candidates)


def output_dir_candidates() -> list[tuple[str, Path]]:
    """Candidats pour ``output/``, du plus fiable au dernier recours.

    Ordre : ``folder_paths.get_output_directory()`` (gère
    ``--output-directory``) → walk-up → dossier du code.
    """
    candidates: list[tuple[str, Path]] = []

    module = _folder_paths()
    getter = getattr(module, "get_output_directory", None) if module else None
    value = _safe_call(getter) if callable(getter) else None
    if value:
        candidates.append((f"{_SRC_FOLDER_PATHS}.get_output_directory()", value))

    root = _walk_up_to_comfy_root()
    if root is not None:
        candidates.append((_SRC_WALK_UP, root / "output"))
    candidates.append((_SRC_CODE_ROOT, CODEFYCH_CODE_ROOT / "output"))
    return _unique(candidates)


# ---------------------------------------------------------------------------
# Sélection d'un candidat
# ---------------------------------------------------------------------------
def first_existing(candidates) -> Path | None:
    """Premier candidat qui EXISTE réellement (``None`` si aucun)."""
    for _source, path in candidates:
        try:
            if path.is_dir():
                return Path(path).resolve()
        except OSError:
            continue
    return None


def first_existing_or_raise(label, candidates) -> Path:
    """Premier candidat existant, sinon :class:`ComfyPathNotFound`.

    C'est le contrat « jamais un chemin inexistant présenté comme bon » : un
    appelant qui a besoin d'un dossier réel lève, et le message liste tous les
    chemins essayés.
    """
    found = first_existing(candidates)
    if found is not None:
        return found
    raise ComfyPathNotFound(label, candidates)


def _lenient(candidates) -> Path:
    """Premier candidat existant, sinon le candidat PRÉFÉRÉ (jamais d'exception).

    Réservé aux appelants d'affichage/scan (UI, détection) qui doivent pouvoir
    montrer un chemin même absent : les opérations qui écrivent ou poussent des
    données utilisent :func:`first_existing_or_raise`.
    """
    found = first_existing(candidates)
    if found is not None:
        return found
    return candidates[-1][1] if candidates else CODEFYCH_CODE_ROOT


# ---------------------------------------------------------------------------
# Dossiers résolus
# ---------------------------------------------------------------------------
def output_dir() -> Path:
    """Dossier ``output/`` de ComfyUI (téléchargements « Save locally »).

    Premier candidat réellement présent ; à défaut, le candidat préféré
    (jamais créé ici).
    """
    return _lenient(output_dir_candidates())


def models_dir() -> Path:
    """Dossier ``models/`` de ComfyUI, base du scan « modèles locaux ».

    Premier candidat réellement présent ; à défaut, le candidat préféré.
    """
    return _lenient(models_dir_candidates())


def custom_nodes_dirs() -> list[Path]:
    """TOUS les dossiers ``custom_nodes`` connus de ComfyUI (jamais vide).

    Seuls les dossiers EXISTANTS sont retenus ; si aucun n'existe, la liste des
    candidats est renvoyée telle quelle pour que l'appelant puisse l'afficher
    dans son diagnostic (contrat historique : jamais de liste vide).
    """
    candidates = custom_nodes_dir_candidates()
    found: list[Path] = []
    for _source, path in candidates:
        try:
            if not path.is_dir():
                continue
            resolved = Path(path).resolve()
        except OSError:
            continue
        if resolved not in found:
            found.append(resolved)
    if found:
        return found
    return [path for _source, path in candidates]


def _comfy_root() -> Path | None:
    """Racine ComfyUI (None hors ComfyUI) — voir :func:`_walk_up_to_comfy_root`."""
    return _walk_up_to_comfy_root()


def custom_nodes_dir() -> Path:
    """Premier dossier ``custom_nodes`` (compatibilité des appelants simples)."""
    return custom_nodes_dirs()[0]


def user_dir() -> Path:
    """Dossier ``<ComfyUI>/user`` — MÊME référence que le reste du pack.

    EXIGE un dossier existant : lève :class:`ComfyPathNotFound` sinon (avec la
    liste des chemins essayés). Voir :func:`user_dir_candidates` pour l'ordre.
    """
    return first_existing_or_raise("user/", user_dir_candidates())


def project_dir() -> Path:
    """Dossier du CODE ComfyCH = cwd des commandes ``modal run`` / ``deploy``.

    Contient ``sync.py``, ``image.py``, ``apps/``, ``workers/`` : il ne change
    pas avec l'intégration (le code reste ici), seule la localisation des
    DONNÉES change (voir comfych_store.py).
    """
    return CODEFYCH_CODE_ROOT


__all__ = [
    "CODEFYCH_CODE_ROOT",
    "ENV_COMFY_USER_DIR",
    "ComfyPathNotFound",
    "custom_nodes_dir",
    "custom_nodes_dir_candidates",
    "custom_nodes_dirs",
    "first_existing",
    "first_existing_or_raise",
    "format_candidates",
    "models_dir",
    "models_dir_candidates",
    "output_dir",
    "output_dir_candidates",
    "project_dir",
    "user_dir",
    "user_dir_candidates",
]
