# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# GARDE-FOU Nodes 2.0 : les hooks LiteGraph au niveau NODE qui sont SAUTÉS par le
# renderer Vue de ComfyUI (« Modern Node Design (Nodes 2.0) ») ne doivent plus
# apparaître dans le JS de production du pack sans justification explicite.
#
# Faits vérifiés dans la source ComfyUI de référence (1.47.11) :
#   - LGraphCanvas.drawNode retourne tôt en vueNodesMode → node.onDrawForeground /
#     node.onDrawBackground ne sont JAMAIS appelés ;
#   - LGraphCanvas.processMouseMove met `node = null` → node.onMouseDown/Move/
#     Enter/Leave ne sont JAMAIS appelés ;
#   - EN REVANCHE canvas.onDrawForeground (niveau CANVAS) survit aux deux modes.
#
# Principe : toute occurrence à risque doit être justifiée dans ALLOWLIST, soit :
#   - ("canvas-hook", …) : le fichier bride/entretient le chemin Vue via le hook
#     canvas-level survivant (import holaf_nodes2_compat + onCanvasDraw requis) ;
#   - ("documented-incompatible", …) : l'UI n'est pas portable telle quelle ; le
#     fichier doit porter le marqueur NODES2_INCOMPATIBLE ET un signal runtime
#     (console.warn) — jamais une dégradation silencieuse en Nodes 2.0.
#
# Un hook à risque NOUVEAU (non allowlisté) fait ÉCHOUER le test ; une entrée
# d'allowlist PÉRIMÉE (hook disparu) fait aussi échouer → l'allowlist reste
# exacte. Les contrôles négatifs par mutation prouvent que le vérificateur
# n'est pas vacant.
#
# Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh

import re
import sys
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
FRONT_DIRS = (PACKAGE_DIR / "js", PACKAGE_DIR / "aih_frontend" / "js")

# Chaque motif cible une forme NON AMBIGUË (assignation de hook, méthode de
# classe LiteGraph). Les méthodes onMouseDown/Move exigent un paramètre `canvas`
# pour NE PAS confondre un helper non-node (ex. Blobby `onMouseDown(pos)`).
RISKY_PATTERNS = {
    "prototype.onDrawForeground": re.compile(r"prototype\.onDrawForeground\s*="),
    "prototype.onDrawBackground": re.compile(r"prototype\.onDrawBackground\s*="),
    "node.onMouseDown": re.compile(r"(?:this|prototype)\.onMouseDown\s*="),
    "node.onMouseMove": re.compile(r"(?:this|prototype)\.onMouseMove\s*="),
    "node.onMouseEnter": re.compile(r"(?:this|prototype)\.onMouseEnter\s*="),
    "node.onMouseLeave": re.compile(r"(?:this|prototype)\.onMouseLeave\s*="),
    "class.onDrawForeground": re.compile(r"^\s*(?:async\s+)?onDrawForeground\s*\([^)]*\)\s*\{", re.M),
    "class.onDrawBackground": re.compile(r"^\s*(?:async\s+)?onDrawBackground\s*\([^)]*\)\s*\{", re.M),
    "class.onMouseEnter": re.compile(r"^\s*(?:async\s+)?onMouseEnter\s*\([^)]*\)\s*\{", re.M),
    "class.onMouseLeave": re.compile(r"^\s*(?:async\s+)?onMouseLeave\s*\([^)]*\)\s*\{", re.M),
    "class.onMouseDown.canvas": re.compile(r"^\s*(?:async\s+)?onMouseDown\s*\([^)]*\bcanvas\b[^)]*\)\s*\{", re.M),
    "class.onMouseMove.canvas": re.compile(r"^\s*(?:async\s+)?onMouseMove\s*\([^)]*\bcanvas\b[^)]*\)\s*\{", re.M),
    "addCustomWidget": re.compile(r"\baddCustomWidget\s*\("),
}

# Justification par fichier : {relpath: {kind: (bridge, raison)}}.
# bridge ∈ {"canvas-hook", "documented-incompatible"}.
ALLOWLIST = {
    "js/holaf_to_text.js": {
        "prototype.onDrawForeground": (
            "canvas-hook",
            "rendu riche (Markdown/JSON) entretenu côté Vue via onCanvasDraw "
            "(hook canvas-level survivant) — le chemin classique reste onDrawForeground",
        ),
    },
    "js/holaf_remote_control.js": {
        "node.onMouseEnter": (
            "canvas-hook",
            "refresh du combo comfy_group maintenu côté Vue via onCanvasDraw ; "
            "le survol classique (onMouseEnter) est inchangé",
        ),
    },
    "js/holaf_image_comparer.js": {
        "class.onMouseEnter": (
            "documented-incompatible",
            "interaction Slide/Click (survol A/B) : hooks node-level non appelés en Vue",
        ),
        "class.onMouseLeave": (
            "documented-incompatible",
            "interaction Slide/Click (fin de survol) : hook node-level non appelé en Vue",
        ),
        "class.onMouseDown.canvas": (
            "documented-incompatible",
            "interaction Slide/Click (clic) : hook node-level non appelé en Vue",
        ),
        "class.onMouseMove.canvas": (
            "documented-incompatible",
            "interaction Slide/Click (position) : hook node-level non appelé en Vue",
        ),
        "addCustomWidget": (
            "documented-incompatible",
            "widget canvas custom — s'affiche en Vue (WidgetLegacy) mais l'interaction "
            "node-level n'est pas portable sans réécriture risquée",
        ),
    },
}


def _production_files():
    """JS de production du front (hors tests, harnais et briques `vendor/`)."""
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
                continue
            files.append(path)
    return files


def find_risky_patterns(text):
    """{kind: …} des motifs à risque présents dans un source."""
    return {kind for kind, rx in RISKY_PATTERNS.items() if rx.search(text)}


def scan(files):
    """{relpath: {kinds}} pour tout le front de production (fonction pure)."""
    actual = {}
    for path in files:
        kinds = find_risky_patterns(path.read_text(encoding="utf-8", errors="ignore"))
        if kinds:
            actual[str(path.relative_to(PACKAGE_DIR))] = kinds
    return actual


def check_allowlist(actual, allowlist):
    """Problèmes d'allowlist : hooks non autorisés + entrées périmées."""
    problems = []
    for rel, kinds in actual.items():
        allowed = allowlist.get(rel, {})
        for kind in sorted(kinds - set(allowed)):
            problems.append(f"{rel}: hook node-level à risque NON autorisé « {kind} »")
    for rel, allowed in allowlist.items():
        present = actual.get(rel, set())
        for kind in sorted(set(allowed) - present):
            problems.append(f"{rel}: entrée d'allowlist PÉRIMÉE « {kind} » (hook absent)")
    return problems


def check_bridges(allowlist, texts):
    """Chaque entrée allowlistée doit prouver sa bridge / son signal."""
    problems = []
    for rel, allowed in allowlist.items():
        text = texts.get(rel, "")
        for kind, (bridge, _reason) in allowed.items():
            if bridge == "canvas-hook":
                if "holaf_nodes2_compat" not in text or "onCanvasDraw(" not in text:
                    problems.append(
                        f"{rel} « {kind} » : bridge « canvas-hook » sans import "
                        "holaf_nodes2_compat + onCanvasDraw"
                    )
            elif bridge == "documented-incompatible":
                if "NODES2_INCOMPATIBLE" not in text or "console.warn" not in text:
                    problems.append(
                        f"{rel} « {kind} » : incompatibilité non signalée "
                        "(marqueur NODES2_INCOMPATIBLE + console.warn requis)"
                    )
            else:
                problems.append(f"{rel} « {kind} » : bridge inconnue « {bridge} »")
    return problems


# ── Vérité de production ────────────────────────────────────────────────────

def test_scanner_parses_some_production_files():
    assert _production_files(), "aucun fichier JS de production scanné (scanner cassé ?)"


def test_known_risky_occurrences_are_present():
    """Anti-vacuité : les cas connus (Remote/ToText/Comparer) sont bien détectés."""
    actual = scan(_production_files())
    assert "js/holaf_remote_control.js" in actual
    assert "js/holaf_to_text.js" in actual
    assert "js/holaf_image_comparer.js" in actual
    assert "node.onMouseEnter" in actual["js/holaf_remote_control.js"]
    assert "prototype.onDrawForeground" in actual["js/holaf_to_text.js"]
    assert "addCustomWidget" in actual["js/holaf_image_comparer.js"]


def test_every_risky_hook_is_allowlisted():
    actual = scan(_production_files())
    problems = check_allowlist(actual, ALLOWLIST)
    assert problems == [], "hooks node-level à risque non justifiés : " + "; ".join(problems)


def test_allowlisted_hooks_have_bridge_or_signal():
    files = {str(p.relative_to(PACKAGE_DIR)): p.read_text(encoding="utf-8", errors="ignore")
             for p in _production_files()}
    problems = check_bridges(ALLOWLIST, files)
    assert problems == [], "justifications incomplètes : " + "; ".join(problems)


# ── Contrôles négatifs par mutation (vérificateur non vacant) ───────────────

_VALID = {"js/ok.js": {"node.onMouseEnter": ("canvas-hook", "rafraîchit via onCanvasDraw")}}
_VALID_TEXT = {"js/ok.js": "import { onCanvasDraw } from './holaf_nodes2_compat.js';\nonCanvasDraw(() => {})"}


def test_positive_control_valid_case_is_clean():
    actual = {"js/ok.js": {"node.onMouseEnter"}}
    assert check_allowlist(actual, _VALID) == []
    assert check_bridges(_VALID, _VALID_TEXT) == []


def test_scanner_flags_new_prototype_draw_hook():
    js = "nodeType.prototype.onDrawForeground = function (ctx) {};"
    assert "prototype.onDrawForeground" in find_risky_patterns(js)


def test_scanner_flags_new_node_mouse_assignment():
    js = "nodeType.prototype.onMouseEnter = function (e) {};"
    assert "node.onMouseEnter" in find_risky_patterns(js)
    js2 = "this.onMouseLeave = () => {};"
    assert "node.onMouseLeave" in find_risky_patterns(js2)


def test_scanner_flags_class_mouse_hooks_with_canvas_param():
    js = "class N extends L {\n    onMouseDown(event, pos, canvas) { return false; }\n}"
    assert "class.onMouseDown.canvas" in find_risky_patterns(js)


def test_scanner_ignores_non_node_helper_onMouseDown():
    """Un helper non-node (ex. Blobby `onMouseDown(pos)`) ne doit PAS être flaggé."""
    js = "const companion = {\n    onMouseDown(pos) { return false; },\n    onMouseUp() {},\n};"
    assert find_risky_patterns(js) == set()


def test_scanner_flags_addCustomWidget():
    assert "addCustomWidget" in find_risky_patterns("this.canvasWidget = this.addCustomWidget(w);")


def test_mutation_new_unallowlisted_hook_is_detected():
    actual = {"js/new.js": {"node.onMouseMove"}}
    problems = check_allowlist(actual, {})
    assert any("js/new.js" in p and "node.onMouseMove" in p for p in problems)


def test_mutation_stale_allowlist_entry_is_detected():
    actual = {"js/ok.js": {"node.onMouseEnter"}}
    allowlist = {"js/ok.js": {"node.onMouseEnter": ("canvas-hook", "x"),
                              "addCustomWidget": ("documented-incompatible", "y")}}
    problems = check_allowlist(actual, allowlist)
    assert any("PÉRIMÉE" in p and "addCustomWidget" in p for p in problems)


def test_mutation_canvas_hook_without_bridge_is_detected():
    problems = check_bridges(_VALID, {"js/ok.js": "nodeType.prototype.onMouseEnter = () => {};"})
    assert any("holaf_nodes2_compat" in p for p in problems)


def test_mutation_incompatible_without_signal_is_detected():
    allowlist = {"js/x.js": {"addCustomWidget": ("documented-incompatible", "y")}}
    problems = check_bridges(allowlist, {"js/x.js": "this.addCustomWidget(w);"})
    assert any("NODES2_INCOMPATIBLE" in p for p in problems)


def test_mutation_documented_incompatible_with_signal_is_clean():
    allowlist = {"js/x.js": {"addCustomWidget": ("documented-incompatible", "y")}}
    text = "// NODES2_INCOMPATIBLE: explains why\nif (x) { console.warn('degraded'); } this.addCustomWidget(w);"
    assert check_bridges(allowlist, {"js/x.js": text}) == []


if __name__ == "__main__":  # pragma: no cover
    sys.exit(pytest.main([__file__, "-q"]))
