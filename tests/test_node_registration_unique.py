# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# UNE seule clé d'enregistrement par node — les alias legacy ont été SUPPRIMÉS.
#
# Pourquoi : /api/object_info expose UNE ENTRÉE PAR CLÉ de NODE_CLASS_MAPPINGS.
# Tant que chaque node était enregistré sous deux clés (canonique `AIH…` +
# alias legacy `Holaf…` / ancien `AIH…Node` / clé espacée) partageant le MÊME
# display_name, la recherche « Add Node » du frontend — qui liste les
# définitions sans dédoublonnage — affichait chaque node DEUX FOIS (mêmes nom,
# catégorie et badge de source).
#
# Décision utilisateur : retirer les alias plutôt que de conserver une
# compatibilité de chargement des vieux workflows (ils sont à refaire).
# Ce test verrouille la situation :
#   1. chaque fichier de node enregistre EXACTEMENT une clé, présente aussi
#      dans NODE_DISPLAY_NAME_MAPPINGS (mêmes ensembles de clés) ;
#   2. aucune clé n'est enregistrée par deux fichiers ;
#   3. aucun display_name n'est partagé par deux clés ;
#   4. les 34 clés d'alias supprimées ne réapparaissent JAMAIS ;
#   5. le JS de production ne contient plus AUCUNE référence entre guillemets à
#      ces clés (les tests `js/test_*.mjs` peuvent les citer : contrôles
#      négatifs « l'ancien alias n'est plus branché »).
# Les contrôles NÉGATIFS par mutation prouvent que les vérificateurs détectent
# bien une réintroduction (sinon le test serait vert à vide).
#
# Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh

import ast
import sys
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
NODES_DIR = PACKAGE_DIR / "nodes"
FRONT_DIRS = (PACKAGE_DIR / "js", PACKAGE_DIR / "aih_frontend" / "js")

if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

# Clés d'alias legacy supprimées (décision utilisateur, 2026) : chacune
# partageait son display_name avec la clé canonique de la même classe.
# Table jamais reconstruite : toute réapparition doit être traitée comme une
# régression (et non « remise en service »).
REMOVED_LEGACY_ALIAS_KEYS = frozenset({
    "AIH Ref Image Prep",
    "AIHElementsNode",
    "AIHEnhanceNode",
    "AIHIdeogram4Node",
    "AIHKeywordsNode",
    "AIHLMStudioSettingsNode",
    "AIHMusicNode",
    "AIHOpenAISettingsNode",
    "HolafAutoSelectX2",
    "HolafBundleCreator",
    "HolafBundleExtractor",
    "HolafBypasser",
    "HolafGroupBypasser",
    "HolafImageAdjustment",
    "HolafImageBatchSlice",
    "HolafImageComparer",
    "HolafInstagramResize",
    "HolafLoadImageVideo",
    "HolafLutGenerator",
    "HolafLutSaver",
    "HolafMaskToBoolean",
    "HolafOverlayNode",
    "HolafPinterestRandomImage",
    "HolafRemote",
    "HolafRemoteComparer",
    "HolafRemoteSelector",
    "HolafResolutionPreset",
    "HolafResolutionPresetV2",
    "HolafSaveMedia",
    "HolafSimpleBypasser",
    "HolafTextBox",
    "HolafTiledKSampler",
    "HolafToText",
    "UpscaleImageHolaf",
})


def _parse_registrations():
    """{fichier: {"classes": {clé: expression}, "displays": {clé: libellé}}}.

    Seuls les dicts littéraux de niveau module sont lus (forme utilisée par
    tous les nodes du pack). Un fichier qui construirait ses mappings
    dynamiquement ferait échouer test_every_declaring_file_is_parseable.
    """
    registrations = {}
    for path in sorted(NODES_DIR.glob("*.py")):
        if path.name.startswith("__"):
            continue
        source = path.read_text(encoding="utf-8")
        if "NODE_CLASS_MAPPINGS" not in source and "NODE_DISPLAY_NAME_MAPPINGS" not in source:
            continue
        tree = ast.parse(source)
        classes, displays = {}, {}
        parsed_class_literal = False
        for node in tree.body:
            if not isinstance(node, ast.Assign):
                continue
            for target in node.targets:
                if not isinstance(target, ast.Name):
                    continue
                if target.id == "NODE_CLASS_MAPPINGS" and isinstance(node.value, ast.Dict):
                    parsed_class_literal = True
                    for key, value in zip(node.value.keys, node.value.values):
                        if isinstance(key, ast.Constant) and isinstance(key.value, str):
                            classes[key.value] = ast.unparse(value)
                if target.id == "NODE_DISPLAY_NAME_MAPPINGS" and isinstance(node.value, ast.Dict):
                    for key, value in zip(node.value.keys, node.value.values):
                        if isinstance(key, ast.Constant) and isinstance(key.value, str) and isinstance(value, ast.Constant):
                            displays[key.value] = value.value
        if classes or displays or parsed_class_literal:
            registrations[path.name] = {"classes": classes, "displays": displays}
    return registrations


def _find_registration_problems(registrations, removed_alias_keys):
    """Incohérences d'enregistrement (fonction pure, testable par mutation)."""
    problems = []
    key_owner = {}
    display_owner = {}

    for filename, data in registrations.items():
        classes = set(data["classes"])
        displays = set(data["displays"])
        if classes != displays:
            problems.append(
                f"{filename}: clés NODE_CLASS_MAPPINGS {sorted(classes)} != "
                f"clés NODE_DISPLAY_NAME_MAPPINGS {sorted(displays)}"
            )
        for key in sorted(classes):
            if key in key_owner:
                problems.append(f"{filename}: clé {key!r} déjà enregistrée par {key_owner[key]}")
            key_owner[key] = filename
            if key in removed_alias_keys:
                problems.append(f"{filename}: alias legacy supprimé {key!r} réapparu")
        for key in sorted(displays):
            display = data["displays"][key]
            if display in display_owner:
                other_key, other_file = display_owner[display]
                problems.append(
                    f"{filename}: display_name {display!r} partagé par {other_key!r} "
                    f"({other_file}) et {key!r} — la recherche afficherait 2 lignes"
                )
            else:
                display_owner[display] = (key, filename)
    return problems


def _find_quoted_references(text, alias_keys):
    """Clés d'alias citées ENTRE GUILLEMETS dans un source front."""
    return sorted(
        key for key in alias_keys if f'"{key}"' in text or f"'{key}'" in text
    )


def _front_production_files():
    """JS de production du front (hors tests/harnais et briques vendor)."""
    files = []
    for root in FRONT_DIRS:
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*.js")):
            name = path.name
            if name.startswith("test_") or name.startswith("xterm"):
                continue
            if "test_helpers" in path.parts or "__pycache__" in path.parts:
                continue
            files.append(path)
    return files


# ── Vérité de production ────────────────────────────────────────────────────

def test_no_duplicate_keys_or_display_names_in_pack():
    registrations = _parse_registrations()
    assert registrations, "aucun enregistrement de node parsé — le parseur AST est en échec"
    assert _find_registration_problems(registrations, REMOVED_LEGACY_ALIAS_KEYS) == [], (
        "enregistrement de node non conforme : une seule clé par node, aucun display_name partagé"
    )


def test_one_key_per_node_file():
    """Un fichier de node = un node = une clé (les alias en ajoutaient une 2e).

    Les fichiers à mapping vide (helpers) sont ignorés.
    """
    registrations = _parse_registrations()
    offenders = {
        name: sorted(data["classes"])
        for name, data in registrations.items()
        if data["classes"] and len(data["classes"]) != 1
    }
    assert offenders == {}, f"fichiers avec != 1 clé d'enregistrement : {offenders}"


def test_every_declaring_file_is_parseable():
    """Aucun mapping construit dynamiquement ne doit échapper au parseur."""
    unparsed = []
    for path in sorted(NODES_DIR.glob("*.py")):
        if path.name.startswith("__"):
            continue
        source = path.read_text(encoding="utf-8")
        if "NODE_CLASS_MAPPINGS" not in source:
            continue
        if path.name not in _parse_registrations() and "NODE_CLASS_MAPPINGS" in source:
            unparsed.append(path.name)
    assert unparsed == [], (
        f"mappings non parsables (forme dynamique ?) : {unparsed} — "
        "étendre le parseur de ce test avant d'introduire une construction dynamique"
    )


def test_removed_alias_keys_are_gone_from_registrations():
    registrations = _parse_registrations()
    present = sorted(
        key
        for data in registrations.values()
        for key in data["classes"]
        if key in REMOVED_LEGACY_ALIAS_KEYS
    )
    assert present == [], f"alias legacy réapparus dans un mapping : {present}"


def test_removed_alias_key_list_shape():
    assert len(REMOVED_LEGACY_ALIAS_KEYS) == 34, "34 alias legacy ont été supprimés"


def test_front_production_js_has_no_quoted_alias_reference():
    offenders = {}
    for path in _front_production_files():
        hits = _find_quoted_references(path.read_text(encoding="utf-8", errors="ignore"), REMOVED_LEGACY_ALIAS_KEYS)
        if hits:
            offenders[str(path.relative_to(PACKAGE_DIR))] = hits
    assert offenders == {}, (
        f"références front résiduelles aux alias supprimés : {offenders}"
    )


# ── Contrôles négatifs par mutation (vérificateurs non vacuous) ─────────────

_VALID_REGISTRY = {
    "node_a.py": {"classes": {"AIHAlpha": "Alpha"}, "displays": {"AIHAlpha": "AIH Alpha"}},
    "node_b.py": {"classes": {"AIHBeta": "Beta"}, "displays": {"AIHBeta": "AIH Beta"}},
}


def test_positive_control_valid_registry_is_clean():
    assert _find_registration_problems(_VALID_REGISTRY, REMOVED_LEGACY_ALIAS_KEYS) == []


def test_mutation_reintroduced_alias_is_detected():
    mutated = dict(_VALID_REGISTRY)
    mutated["node_a.py"] = {
        "classes": {"AIHAlpha": "Alpha", "HolafAlpha": "Alpha"},
        "displays": {"AIHAlpha": "AIH Alpha", "HolafAlpha": "AIH Alpha"},
    }
    problems = _find_registration_problems(mutated, REMOVED_LEGACY_ALIAS_KEYS)
    assert any("display_name" in p for p in problems), "le display_name partagé doit être détecté"
    assert any("HolafAlpha" in p for p in problems), "la clé connue comme alias doit être détectée"


def test_mutation_duplicate_key_across_files_is_detected():
    mutated = dict(_VALID_REGISTRY)
    mutated["node_c.py"] = {"classes": {"AIHAlpha": "AlphaBis"}, "displays": {"AIHAlpha": "AIH Autre"}}
    problems = _find_registration_problems(mutated, REMOVED_LEGACY_ALIAS_KEYS)
    assert any("déjà enregistrée" in p for p in problems)


def test_mutation_missing_display_entry_is_detected():
    mutated = {"node_a.py": {"classes": {"AIHAlpha": "Alpha"}, "displays": {}}}
    problems = _find_registration_problems(mutated, REMOVED_LEGACY_ALIAS_KEYS)
    assert any("NODE_DISPLAY_NAME_MAPPINGS" in p for p in problems)


def test_mutation_quoted_reference_scanner_flags_js_and_ignores_identifier():
    js_with_key = 'const NODE_TYPES = ["AIHAlpha", "HolafAlpha"];'
    assert _find_quoted_references(js_with_key, {"HolafAlpha"}) == ["HolafAlpha"]
    js_identifier_only = "const HolafAlpha = { init() {} };"
    assert _find_quoted_references(js_identifier_only, {"HolafAlpha"}) == []
    js_clean = 'const NODE_TYPES = ["AIHAlpha"];'
    assert _find_quoted_references(js_clean, {"HolafAlpha"}) == []


@pytest.mark.parametrize("key", ["HolafRemote", "UpscaleImageHolaf", "AIH Ref Image Prep"])
def test_production_files_never_contain_legacy_keys(key):
    """Contrôle ciblé sur 3 formes (Holaf*, ancien AIH…Node, clé espacée)."""
    assert key in REMOVED_LEGACY_ALIAS_KEYS
    for path in _front_production_files():
        assert not _find_quoted_references(path.read_text(encoding="utf-8", errors="ignore"), {key}), path


if __name__ == "__main__":  # pragma: no cover
    sys.exit(pytest.main([__file__, "-q"]))
