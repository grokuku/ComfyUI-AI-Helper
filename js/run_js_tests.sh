#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# Runner des tests JS autonomes (js/test_*.mjs).
#
# Chaque fichier est exécuté par `node`. Convention de code de sortie :
#   0  = PASS
#   2  = SKIP (dépendance de test absente, ex. jsdom) — JAMAIS compté PASS
#   *  = FAIL (vrai échec : le runner global sort en erreur)
#
# Sans `node`, toute la suite est un SKIP BRUYANT — jamais un succès silencieux.
#
# Usage :
#   ./js/run_js_tests.sh
#   JSDOM_DIR=/chemin/vers/node_modules ./js/run_js_tests.sh
#       (JSDOM_DIR pointe sur un dossier où jsdom est résolvable ; sans lui, les
#        tests qui en dépendent sortent 2 = SKIP. jsdom est aussi cherché dans
#        ./node_modules, ../holaf-lib/node_modules et /projects/holaf-lib/node_modules
#        par le helper partagé js/test_helpers/jsdom_loader.mjs.)
#   AIH_JS_SUMMARY=/chemin/fichier ./js/run_js_tests.sh
#       écrit le récap machine (PASS=… / FAIL=… / SKIP=… / TOTAL=…) pour que
#       run_tests.sh affiche un bilan final non trompeur.
# ─────────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUMMARY_FILE="${AIH_JS_SUMMARY:-}"
cd "$SCRIPT_DIR"

write_summary() {
    # $1=PASS $2=FAIL $3=SKIP $4=TOTAL
    [ -n "$SUMMARY_FILE" ] && printf 'PASS=%s\nFAIL=%s\nSKIP=%s\nTOTAL=%s\n' "$1" "$2" "$3" "$4" > "$SUMMARY_FILE"
    return 0
}

shopt -s nullglob
TESTS=(test_*.mjs)
TOTAL=${#TESTS[@]}

# Pas de node → SKIP BRUYANT de toute la suite (jamais PASS silencieux).
if ! command -v node >/dev/null 2>&1; then
    echo "⚠️  SKIP JS — 'node' introuvable : la suite js/test_*.mjs n'est PAS exécutée."
    echo ""
    echo "════════════════════════════════════════════════════════════════"
    echo " Récapitulatif JS ($TOTAL fichiers) : PASS=0 FAIL=0 SKIP=$TOTAL"
    echo " ⚠️ AUCUN test JS n'a réellement tourné (node absent) — ce n'est PAS un succès de test."
    echo "════════════════════════════════════════════════════════════════"
    write_summary 0 0 "$TOTAL" "$TOTAL"
    exit 0
fi

if [ "$TOTAL" -eq 0 ]; then
    echo "⚠️  SKIP JS — aucun fichier js/test_*.mjs trouvé."
    write_summary 0 0 0 0
    exit 0
fi

pass=0
fail=0
skip=0
failed_files=()

echo "════════════════════════════════════════════════════════════════"
echo " Tests JS (js/test_*.mjs) — node $(node --version 2>/dev/null)"
echo "════════════════════════════════════════════════════════════════"

for t in "${TESTS[@]}"; do
    echo ""
    echo "── $t ──────────────────────────────────────────────────────────"
    output="$(node "$t" 2>&1)"
    status=$?
    if [ -n "$output" ]; then
        echo "$output"
    fi
    case "$status" in
        0)
            echo "   → PASS : $t"
            pass=$((pass + 1))
            ;;
        2)
            echo "   → SKIP : $t (dépendance de test absente — pas compté comme succès)"
            skip=$((skip + 1))
            ;;
        *)
            echo "   → FAIL : $t (exit=$status)"
            fail=$((fail + 1))
            failed_files+=("$t")
            ;;
    esac
done

echo ""
echo "════════════════════════════════════════════════════════════════"
echo " Récapitulatif JS ($TOTAL fichiers) : PASS=$pass  FAIL=$fail  SKIP=$skip"
if [ "$fail" -gt 0 ]; then
    echo " Échecs : ${failed_files[*]}"
fi
# Cas « tout en SKIP » : PASS=0 et FAIL=0 — le récap ne doit PAS ressembler à
# un succès de test (les tests n'ont pas tourné).
if [ "$pass" -eq 0 ] && [ "$fail" -eq 0 ]; then
    echo " ⚠️ AUCUN test JS n'a réellement tourné (PASS=0 FAIL=0 SKIP=$skip) — ce n'est PAS un succès de test."
fi
echo "════════════════════════════════════════════════════════════════"

write_summary "$pass" "$fail" "$skip" "$TOTAL"

# Sortie non nulle UNIQUEMENT en cas de vrai échec (SKIP exclu).
[ "$fail" -eq 0 ]
