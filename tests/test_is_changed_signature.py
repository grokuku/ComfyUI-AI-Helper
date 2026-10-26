"""Hooks ComfyUI appelés sur la CLASSE : ``IS_CHANGED`` doit être un classmethod.

BUG RÉEL (log du worker Modal) :

    WARNING: HolafResolutionPresetV2.IS_CHANGED() missing 1 required positional
    argument: 'self'

ComfyUI évalue ``class_def.IS_CHANGED(**inputs)`` — c'est-à-dire la fonction
récupérée sur la CLASSE, donc NON liée. Déclarée ``def IS_CHANGED(self, …)``
(méthode d'instance), l'appel perd ``self`` : ComfyUI attrape le ``TypeError``,
se contente d'un warning et PERD le cache fin de la node (ré-exécution ou
résultat périmé selon le cas). C'est un vrai bug d'API, pas un artefact.

Ce fichier verrouille :
  1. TOUS les ``def IS_CHANGED`` des nodes du pack sont décorés ``@classmethod``
     (analyse AST : aucun import de torch/ComfyUI requis) — MUTANT M1 : retirer
     le décorateur d'un node ⇒ ROUGE ;
  2. les hooks sont appelables SANS instance, exactement comme ComfyUI le fait
     (``Cls.IS_CHANGED(**inputs)``), pour les nodes de résolution v1 et v2 ;
  3. la valeur renvoyée reste stable (elle sert de clé de cache).

Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
"""

import ast
import sys
from pathlib import Path

import pytest

PACK_DIR = Path(__file__).resolve().parent.parent
NODES_DIR = PACK_DIR / "nodes"

# ── torch / folder_paths : absents du venv de dev (chargés hors ComfyUI) ────
# Ces tests importent les VRAIS modules du pack. Le venv de dev n'a ni torch ni
# folder_paths : on installe un stub MINIMAL (réutilisé s'il existe déjà, pour
# ne pas casser `isinstance(x, torch.Tensor)` des autres fichiers de tests).
def _ensure_import_stubs():
    import types

    if "torch" not in sys.modules:
        try:
            import torch  # noqa: F401
        except ImportError:
            torch_stub = types.ModuleType("torch")

            class _StubTensor:  # seuls `shape` / `ndim` sont lus par les nodes
                pass

            torch_stub.Tensor = _StubTensor
            sys.modules["torch"] = torch_stub

    if "folder_paths" not in sys.modules:
        try:
            import folder_paths  # noqa: F401
        except ImportError:
            fp_stub = types.ModuleType("folder_paths")
            fp_stub.get_output_directory = lambda: "/root/comfy/ComfyUI/output"
            fp_stub.base_path = "/root/comfy/ComfyUI"
            sys.modules["folder_paths"] = fp_stub


_ensure_import_stubs()


# Hooks que ComfyUI invoque sur la classe (execution.py).
CLASS_HOOKS = ("IS_CHANGED", "VALIDATE_INPUTS")


def _node_files():
    return sorted(p for p in NODES_DIR.glob("*.py") if not p.name.startswith("__"))


def _hook_defs(path):
    """[(nom_hook, decorateurs, ligne)] pour chaque hook ComfyUI du fichier."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if node.name not in CLASS_HOOKS:
            continue
        decorators = []
        for dec in node.decorator_list:
            if isinstance(dec, ast.Name):
                decorators.append(dec.id)
            elif isinstance(dec, ast.Attribute):
                decorators.append(dec.attr)
        found.append((node.name, decorators, node.lineno, deco_first_arg(node)))
    return found


def deco_first_arg(func_node):
    args = [a.arg for a in func_node.args.args]
    return args[0] if args else None


# ════════════ 1. Analyse AST : tout hook de classe est un classmethod ════════


def test_every_class_hook_is_a_classmethod():
    """MUTANT M1 : un ``@classmethod`` retiré rend ce test ROUGE."""
    offenders = []
    for path in _node_files():
        for name, decorators, lineno, _first in _hook_defs(path):
            if "classmethod" not in decorators:
                offenders.append(f"{path.name}:{lineno} {name}({_first})")
    assert not offenders, (
        "hooks appelés par ComfyUI sur la CLASSE sans @classmethod "
        "(→ « missing 1 required positional argument: 'self' ») : "
        + ", ".join(offenders)
    )


def test_class_hook_first_argument_is_cls():
    """Un classmethod dont le 1er paramètre s'appelle ``self`` est suspect."""
    suspicious = []
    for path in _node_files():
        for name, decorators, lineno, first in _hook_defs(path):
            if "classmethod" in decorators and first == "self":
                suspicious.append(f"{path.name}:{lineno} {name}")
    assert not suspicious, "1er paramètre nommé « self » sur un classmethod : " + ", ".join(suspicious)


def test_scan_actually_finds_the_hooks():
    """Garde anti-test-vide : le pack déclare bien des hooks (sinon test creux)."""
    names = {name for path in _node_files() for name, *_ in _hook_defs(path)}
    assert "IS_CHANGED" in names, "aucun IS_CHANGED trouvé : la recherche est cassée"
    assert "VALIDATE_INPUTS" in names


# ══════════ 2. Appel SANS instance, comme le fait ComfyUI (cas v2 nommé) ═════


@pytest.fixture(scope="module")
def presets():
    if str(NODES_DIR) not in sys.path:
        sys.path.insert(0, str(NODES_DIR))
    from holaf_resolution_preset import HolafResolutionPreset
    from holaf_resolution_preset_v2 import HolafResolutionPresetV2

    return HolafResolutionPreset, HolafResolutionPresetV2


def test_v2_is_changed_is_callable_on_the_class(presets):
    """Reproduit EXACTEMENT le log d'erreur du worker (appel sur la classe)."""
    _v1, v2 = presets

    value = v2.IS_CHANGED(
        model_type="SDXL",
        use_hd=False,
        megapixels=2.5,
        multiple_of=16,
        aspect_ratio="3:4",
        orientation=False,
        use_image_ratio=False,
        image=None,
    )

    assert isinstance(value, str) and value, "clé de cache non vide attendue"
    # Déterministe : mêmes entrées ⇒ même clé (sinon cache inutile).
    again = v2.IS_CHANGED(
        model_type="SDXL", use_hd=False, megapixels=2.5, multiple_of=16,
        aspect_ratio="3:4", orientation=False, use_image_ratio=False, image=None,
    )
    assert value == again


def test_v1_is_changed_is_callable_on_the_class(presets):
    v1, _v2 = presets

    value = v1.IS_CHANGED(
        model_type="SDXL", aspect_ratio="3:4", use_image_ratio=False, image=None
    )

    assert isinstance(value, str) and value


def test_v2_random_ratio_always_changes(presets):
    _v1, v2 = presets

    first = v2.IS_CHANGED(
        model_type="SDXL", use_hd=False, megapixels=2.5, multiple_of=16,
        aspect_ratio="Random", orientation=False, use_image_ratio=False, image=None,
    )
    second = v2.IS_CHANGED(
        model_type="SDXL", use_hd=False, megapixels=2.5, multiple_of=16,
        aspect_ratio="Random", orientation=False, use_image_ratio=False, image=None,
    )

    assert first != second, "« Random » doit toujours invalider le cache"


def test_elements_is_changed_is_callable_on_the_class():
    """Le node Elements était déjà correct : verrouille le bon modèle."""
    if str(PACK_DIR) not in sys.path:
        sys.path.insert(0, str(PACK_DIR))
    from nodes import elements_node as N

    assert N.AIHElementsNode.IS_CHANGED(seed=1, _elements_json="{}") == ""
