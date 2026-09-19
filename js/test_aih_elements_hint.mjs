// ─────────────────────────────────────────────────────────────────────────
// Elements Picker — hint optionnel (préfixe de résolution) + suppression du
// concept inline « ;hint ».
//
// Couverture (lecture de source par regex, pas de DOM) :
//   1. le champ hint est rendu sur les entrées `text` (même pattern que le filtre) ;
//   2. le hint est sérialisé dans _elements_json ET dans le payload Test /generate ;
//   3. le hint survit aux DEUX branches de restauration (preset local + workflow) —
//      sans ça, perte silencieuse ;
//   4. _parseConceptSyntax ne gère plus « ;hint » et « ; » devient littéral ;
//   5. le parsing inline a disparu côté node Python (nodes/elements_node.py).
//
// Usage : node js/test_aih_elements_hint.mjs
// Code de sortie : 0 = PASS, 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { readFileSync } from "node:fs";

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const widgetSrc = readFileSync(new URL("./aih_elements_widget.js", import.meta.url), "utf8");
const nodeSrc = readFileSync(new URL("../nodes/elements_node.py", import.meta.url), "utf8");

/* ══════════════ 1. UI : hint sur les entrées `text` ═══════════════════ */
console.log("1. UI — input hint sur les entrées text");
const hintValueAssign = widgetSrc.match(/hintInput\.value = item\.hint \|\| "";/g) || [];
assert.ok(hintValueAssign.length >= 2,
    `hintInput.value = item.hint || "" présent pour le filtre ET le text (trouvé ${hintValueAssign.length})`);
const hintWriteback = widgetSrc.match(/item\.hint = this\.value;/g) || [];
assert.ok(hintWriteback.length >= 2,
    `item.hint = this.value présent pour le filtre ET le text (trouvé ${hintWriteback.length})`);
assert.ok(/hintInput\.placeholder = t\("el\.hintPlaceholder"\)/.test(widgetSrc),
    "libellé i18n existant `el.hintPlaceholder` réutilisé (aucune nouvelle clé)");
ok("champ hint rendu sur `text` avec le même pattern que le filtre");

/* ══════════════ 2. Sérialisation (JSON + payload Test) ════════════════ */
console.log("2. Sérialisation du hint pour les textes");
const rawWithHint = widgetSrc.match(/type: "raw", text: e\.text, hint: e\.hint \|\| ""/g) || [];
assert.strictEqual(rawWithHint.length, 2,
    `hint dans la sérialisation _elements_json ET le payload Test /generate (trouvé ${rawWithHint.length}, attendu 2)`);
ok("`hint: e.hint || \"\"` présent dans _elements_json ET le payload Test");

/* ══════════════ 3. Restauration (preset + workflow) ══════════════════ */
console.log("3. Restauration — le hint ne doit PAS être jeté");
const restoreWithHint = widgetSrc.match(/type: "text", text: e\.text \|\| "", hint: e\.hint \|\| "", visible/g) || [];
assert.strictEqual(restoreWithHint.length, 2,
    `hint dans les DEUX branches de restauration (loadEpPreset + restoreFromWidgets) — trouvé ${restoreWithHint.length}, attendu 2`);
ok("hint conservé dans loadEpPreset ET restoreFromWidgets (pas de perte silencieuse)");

/* ══════════════ 4. Suppression du « ;hint » inline ════════════════════ */
console.log("4. Syntaxe inline « ;hint » supprimée");
const fnMatch = widgetSrc.match(/function _parseConceptSyntax\s*\([\s\S]*?\n\}/);
assert.ok(fnMatch, "_parseConceptSyntax introuvable dans la source");
assert.ok(!/hint/i.test(fnMatch[0]),
    "_parseConceptSyntax ne doit plus contenir de logique hint");
assert.ok(/return \{ concept: concept, count: count \};/.test(fnMatch[0]),
    "_parseConceptSyntax retourne {concept, count} (plus de champ hint)");
assert.ok(!/parsed\.hint/.test(widgetSrc), "plus aucune consommation de parsed.hint");
assert.ok(!/chosen = hint\b/.test(widgetSrc), "plus de « chosen = hint + … » (préfixe inline retiré)");
ok("parsing inline ;hint retiré du widget (concept + count uniquement)");

// Le « ; » n'est plus un séparateur : il fait partie du concept littéral.
const parseConceptSyntax = new Function(`${fnMatch[0]}; return _parseConceptSyntax;`)();
assert.deepStrictEqual(parseConceptSyntax("||color:20", 10), { concept: "color", count: 20 });
assert.deepStrictEqual(parseConceptSyntax("||color", 10), { concept: "color", count: 10 });
assert.deepStrictEqual(parseConceptSyntax("||a;b", 10), { concept: "a;b", count: 10 },
    "« ; » devient du texte littéral du concept (changement de comportement assumé)");
assert.strictEqual(parseConceptSyntax("hello", 10), null);
ok("||concept[:count] fonctionne ; « ; » est désormais littéral");

/* ══════════════ 5. Node Python : plus de parsing inline ══════════════ */
console.log("5. nodes/elements_node.py — parsing inline supprimé");
const pyFn = nodeSrc.match(/def _parse_concept_syntax\s*\([\s\S]*?\n    return \(concept, count\)/);
assert.ok(pyFn, "_parse_concept_syntax introuvable dans nodes/elements_node.py");
assert.ok(!/hint_part/.test(pyFn[0]), "plus de découpage sur « ; » (hint_part)");
assert.ok(!/f"\{hint\}: /.test(nodeSrc), "plus de préfixe hint construit dans le node");
assert.ok(/concept, count = parsed/.test(nodeSrc), "le node consomme (concept, count)");
ok("node Python : parsing ;hint retiré, hint forwardé tel quel à /api/generate");

console.log(`\n✅ Elements Picker hint + suppression ;hint : TOUS LES TESTS PASSENT (${n} groupes)`);
