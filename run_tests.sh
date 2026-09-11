#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# Lance les tests du projet :
#   1. les tests Python (pytest)       → ./tests
#   2. la suite JS (node)              → ./js/test_*.mjs (via js/run_js_tests.sh)
#
# Pourquoi lancer pytest depuis un répertoire neutre :
#   Le __init__.py à la racine est le point d'entrée de l'extension ComfyUI
#   (il importe `server`). Si pytest est invoqué depuis le dossier du projet,
#   il importe ce __init__.py pour résoudre le package et échoue.
#   En lançant depuis un répertoire temporaire avec un chemin absolu,
#   pytest importe uniquement les fichiers de tests (--import-mode=importlib).
#
# Suite JS : les tests qui nécessitent jsdom sortent 2 = SKIP (jamais PASS) ;
#   jsdom est résolu automatiquement (JSDOM_DIR, ./node_modules,
#   ../holaf-lib/node_modules, /projects/holaf-lib/node_modules).
#   Pour ne lancer QUE pytest : AIH_SKIP_JS=1 ./run_tests.sh
#
#   La ligne finale affiche le récap RÉEL (PASS/FAIL/SKIP) et distingue
#   explicitement le cas « aucun test JS n'a réellement tourné » (tout en SKIP
#   ou node absent) : plus de faux vert.
#
# Usage :
#   ./run_tests.sh                       # utilise python3 (env courant)
#   PYTHON=/chemin/vers/venv/bin/python ./run_tests.sh
#   ./run_tests.sh -k rate_limited       # options pytest passées au script
#   AIH_SKIP_JS=1 ./run_tests.sh         # pytest seulement
#
# Code de sortie : non nul si pytest OU un test JS ÉCHOUE réellement.
# ─────────────────────────────────────────────────────────────────────────
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${PYTHON:-python3}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

cd "$WORK_DIR"
"$PYTHON" -m pytest "$SCRIPT_DIR/tests" --import-mode=importlib "$@"
PYTEST_STATUS=$?

JS_STATUS=0
JS_RAN=0
JS_SUMMARY_FILE="$WORK_DIR/js_summary"
if [ "${AIH_SKIP_JS:-0}" = "1" ]; then
    echo ""
    echo "⚠️  SKIP JS — suite js/test_*.mjs ignorée (AIH_SKIP_JS=1)."
else
    if [ -f "$SCRIPT_DIR/js/run_js_tests.sh" ]; then
        AIH_JS_SUMMARY="$JS_SUMMARY_FILE" bash "$SCRIPT_DIR/js/run_js_tests.sh"
        JS_STATUS=$?
        JS_RAN=1
    else
        echo ""
        echo "⚠️  SKIP JS — runner introuvable : $SCRIPT_DIR/js/run_js_tests.sh"
    fi
fi

# Récap machine écrit par js/run_js_tests.sh (PASS/FAIL/SKIP/TOTAL).
js_pass=0
js_fail=0
js_skip=0
js_total=0
if [ -f "$JS_SUMMARY_FILE" ]; then
    js_pass="$(sed -n 's/^PASS=//p' "$JS_SUMMARY_FILE" | head -n1)"; js_pass="${js_pass:-0}"
    js_fail="$(sed -n 's/^FAIL=//p' "$JS_SUMMARY_FILE" | head -n1)"; js_fail="${js_fail:-0}"
    js_skip="$(sed -n 's/^SKIP=//p' "$JS_SUMMARY_FILE" | head -n1)"; js_skip="${js_skip:-0}"
    js_total="$(sed -n 's/^TOTAL=//p' "$JS_SUMMARY_FILE" | head -n1)"; js_total="${js_total:-0}"
fi

if [ "$PYTEST_STATUS" -ne 0 ] || [ "$JS_STATUS" -ne 0 ]; then
    echo ""
    echo "❌ ÉCHEC GLOBAL — pytest(exit=$PYTEST_STATUS) / js(exit=$JS_STATUS)"
    if [ "$js_fail" -gt 0 ]; then
        echo "   JS : PASS=$js_pass FAIL=$js_fail SKIP=$js_skip (fichiers en échec listés ci-dessus)."
    fi
    exit 1
fi

echo ""
if [ "$JS_RAN" -eq 0 ]; then
    echo "ℹ️  pytest OK — suite JS NON exécutée (AIH_SKIP_JS=1 ou runner absent)."
    echo "⚠️  Aucun test JS n'a réellement tourné : ce bilan ne vaut PAS succès de test JS."
elif [ "$js_pass" -eq 0 ] && [ "$js_fail" -eq 0 ]; then
    echo "⚠️  pytest OK — AUCUN test JS n'a réellement tourné (PASS=0 FAIL=0 SKIP=$js_skip/$js_total)."
    echo "    Ce n'est PAS un succès de test JS (dépendances de test absentes, ex. jsdom ou node)."
else
    echo "✅ Terminé sans échec — pytest OK ; suite JS PASS=$js_pass FAIL=0 SKIP=$js_skip (sur $js_total fichiers)."
fi
