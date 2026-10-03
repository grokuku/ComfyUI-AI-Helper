# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# GARDE-FOU : tout type de node référencé par le JS du pack doit exister dans
# l'enregistrement Python (`NODE_CLASS_MAPPINGS` des fichiers de `nodes/`).
#
# Pourquoi ce test existe (régression silencieuse) : un widget JS qui cible un
# type de node inexistant NE LÈVE AUCUNE ERREUR — son `beforeRegisterNodeDef`
# ne matche simplement jamais, la node perd son UI custom et ComfyUI affiche
# son rendu générique. C'est exactement ce qui a été soupçonné lors de la
# suppression des 34 alias legacy (`Holaf*` → `AIH*`) : si la clé conservée par
# le JS n'est pas celle réellement enregistrée côté Python, l'UI disparaît
# sans bruit.
#
# Principe : UNE SEULE SOURCE DE VÉRITÉ = le Python. Le JS SUIT. Ce test
# échoue si on référence un type de node non enregistré.
#
# Portée : les types de node du pack sont PascalCase et préfixés `AIH`/`Holaf`
# sans underscore (`AIHPromptEnhancer`, `AIHImageComparer`, …). Cela exclut
# naturellement les clés localStorage / thème (`AIH_config`, `Holaf_Theme`,
# `AIH_Mode`, …) et les noms de DOM widget (`AIH_Enhance`) — qui NE SONT PAS
# des types de node. Les `js/vendor/**` (briques tierces) sont hors périmètre.
#
# Les contrôles NÉGATIFS par mutation prouvent que le vérificateur détecte
# bien un type inexistant (sinon le test serait vert à vide).
#
# Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh

import ast
import re
import sys
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
NODES_DIR = PACKAGE_DIR / "nodes"
FRONT_DIRS = (PACKAGE_DIR / "js", PACKAGE_DIR / "aih_frontend" / "js")

# Un type de node du pack : préfixe AIH/Holaf + PascalCase, SANS underscore.
# (Les clés de config/thème ont un underscore et ne matchent donc pas.)
NODE_TYPE_LITERAL_RE = re.compile(r"""['"]((?:AIH|Holaf)[A-Z][A-Za-z0-9]*)['"]""")

# Littéraux PascalCase `AIH*`/`Holaf*` cités dans le front de production qui
# ne sont PAS des types de node. Volontairement vide : toute chaîne inconnue
# fait ÉCHOUER le test et force une décision explicite (allowlist ou typo).
NON_NODE_LITERALS = frozenset()


def _python_registration_keys():
    """Toutes les clés NODE_CLASS_MAPPINGS littérales de `nodes/*.py`."""
    keys = {}
    for path in sorted(NODES_DIR.glob("*.py")):
        if path.name.startswith("__"):
            continue
        source = path.read_text(encoding="utf-8")
        if "NODE_CLASS_MAPPINGS" not in source:
            continue
        tree = ast.parse(source)
        for node in tree.body:
            if not isinstance(node, ast.Assign):
                continue
            if not any(getattr(t, "id", None) == "NODE_CLASS_MAPPINGS" for t in node.targets):
                continue
            if not isinstance(node.value, ast.Dict):
                continue
            for key in node.value.keys:
                if isinstance(key, ast.Constant) and isinstance(key.value, str):
                    keys.setdefault(key.value, path.name)
    return keys


def _front_production_files():
    """JS de production du front (hors tests/harnais et briques `vendor/`)."""
    files = []
    for root in FRONT_DIRS:
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*.js")):
            name = path.name
            if name.startswith(("test_", "xterm")):
                continue
            if "test_helpers" in path.parts or "__pycache__" in path.parts:
                continue
            if "vendor" in path.parts:
                # Briques tierces (toast, modal, viewport, fetch…) : hors pack.
                continue
            files.append(path)
    return files


def _find_node_type_references(text):
    """Types de node du pack littéralement cités dans un source JS."""
    return set(NODE_TYPE_LITERAL_RE.findall(text))


def _collect_references(files):
    """{type_de_node: {fichiers}} pour tout le front de production."""
    refs = {}
    for path in files:
        for lit in _find_node_type_references(path.read_text(encoding="utf-8", errors="ignore")):
            refs.setdefault(lit, set()).add(str(path.relative_to(PACKAGE_DIR)))
    return refs


def _find_unregistered_types(references, registry_keys, non_node_literals=NON_NODE_LITERALS):
    """Types référencés par le JS qui n'existent PAS côté Python (fonction pure)."""
    problems = {}
    for lit, files in references.items():
        if lit in non_node_literals:
            continue
        if lit not in registry_keys:
            problems[lit] = sorted(files)
    return problems


# ── Vérité de production ────────────────────────────────────────────────────

def test_python_registry_is_parsed():
    keys = _python_registration_keys()
    assert keys, "aucune clé NODE_CLASS_MAPPINGS parsée — parseur AST en échec"
    assert "AIHPromptEnhancer" in keys, "le Prompt Enhancer doit être enregistré"


def test_some_front_node_types_are_referenced():
    refs = _collect_references(_front_production_files())
    assert refs, "aucun type de node référencé détecté dans le JS de production (scanner cassé ?)"


def test_every_front_node_type_exists_in_python():
    keys = _python_registration_keys()
    refs = _collect_references(_front_production_files())
    problems = _find_unregistered_types(refs, keys)
    assert problems == {}, (
        "type(s) de node référencé(s) par le JS mais ABSENT(S) de "
        f"NODE_CLASS_MAPPINGS (UI silencieusement perdue) : {problems}"
    )


def test_enhancer_widget_targets_the_registered_key():
    """Cas emblématique : le widget enhancer doit cibler la clé Python."""
    keys = _python_registration_keys()
    refs = _collect_references([PACKAGE_DIR / "js" / "aih_enhance_widget.js"])
    assert "AIHPromptEnhancer" in refs, (
        "js/aih_enhance_widget.js ne référence plus AIHPromptEnhancer "
        "(clé réellement enregistrée par nodes/enhance_node.py)"
    )
    assert _find_unregistered_types(refs, keys) == {}


# ── Contrôles négatifs par mutation (vérificateur non vacuous) ──────────────

_VALID_REGISTRY = {"AIHAlpha": "node_a.py", "AIHBeta": "node_b.py"}


def test_positive_control_valid_references_are_clean():
    refs = {"AIHAlpha": {"js/a.js"}, "AIHBeta": {"js/b.js"}}
    assert _find_unregistered_types(refs, _VALID_REGISTRY) == {}


def test_mutation_unknown_node_type_is_detected():
    refs = {"AIHDoesNotExist": {"js/a.js"}}
    problems = _find_unregistered_types(refs, _VALID_REGISTRY)
    assert "AIHDoesNotExist" in problems, "un type inexistant doit être signalé"


def test_mutation_wrong_enhancer_key_is_detected():
    """Si le widget visait l'ancien alias retiré, le garde-fou rougit."""
    refs = {"AIHEnhanceNode": {"js/aih_enhance_widget.js"}}
    problems = _find_unregistered_types(refs, _VALID_REGISTRY)
    assert problems == {"AIHEnhanceNode": ["js/aih_enhance_widget.js"]}


def test_scanner_extracts_key_from_node_types_array():
    js = 'const NODE_TYPES = ["AIHPromptEnhancer"];'
    assert _find_node_type_references(js) == {"AIHPromptEnhancer"}
    js_multi = 'const NODE_TYPES = ["AIHElementsPicker", "AIHElementsNode"];'
    assert _find_node_type_references(js_multi) == {"AIHElementsPicker", "AIHElementsNode"}


def test_scanner_extracts_key_from_equality_guard():
    js = 'if (nodeData.name === "AIHImageComparer") return;'
    assert _find_node_type_references(js) == {"AIHImageComparer"}
    js2 = 'if (isFamilyType(nodeData.name)) { }'
    assert _find_node_type_references(js2) == set()


def test_scanner_ignores_config_and_widget_names():
    js = 'localStorage.getItem("AIH_config"); const w = "AIH_Enhance"; const k = "Holaf_Theme";'
    assert _find_node_type_references(js) == set()


def test_mutation_new_unknown_pascalcase_literal_fails_by_default():
    """Un littéral PascalCase inconnu doit échouer (allowlist vide par défaut)."""
    refs = {"HolafSomethingNew": {"js/x.js"}}
    assert _find_unregistered_types(refs, _VALID_REGISTRY) != {}


@pytest.mark.parametrize("key", ["AIHPromptEnhancer", "AIHElementsPicker", "AIHKeywords", "AIHImageComparer"])
def test_registered_key_is_actually_used_by_some_widget(key):
    """Anti-vacuité ciblée : la clé est bien ciblée par le JS du pack."""
    keys = _python_registration_keys()
    assert key in keys
    refs = _collect_references(_front_production_files())
    assert key in refs, f"{key} n'est ciblé par aucun JS du pack"


if __name__ == "__main__":  # pragma: no cover
    sys.exit(pytest.main([__file__, "-q"]))
