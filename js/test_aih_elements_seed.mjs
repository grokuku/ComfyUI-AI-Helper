// ─────────────────────────────────────────────────────────────────────────
// Elements Picker — SEED PAR ÉLÉMENT (js/aih_elements_seed.js + intégration
// dans js/aih_elements_widget.js).
//
// Couverture :
//   1. sémantique des 3 modes (hérité / random / fixe) et cycle de clic ;
//   2. valeurs de seed : bornes 0..0xffffffffffffffff, grands entiers, saisies
//      invalides (aucune valeur parasite) ;
//   3. persistance : les anciens éléments (sans champ) ne produisent AUCUN champ
//      (round-trip identique au format historique) ;
//   4. seed effectif par élément (miroir de nodes/elements_node.py) ;
//   5. MIROIR Python : la table de resolveBraceBlocks est la même que celle
//      vérifiée côté pytest (aucune divergence de hash entre aperçu et Run) ;
//   6. DOM (jsdom) : contrôle à 3 états, clic direct SANS mousedown/pointerdown,
//      champ de valeur révélé en mode fixe, validation ;
//   7. intégration widget (_elements_json, restauration workflow + preset,
//      aperçu « Test generation », payload serveur inchangé) ;
//   8. i18n FR/EN à parité STRICTE.
//
// Usage : node js/test_aih_elements_seed.mjs
//   jsdom est résolu par js/test_helpers/jsdom_loader.mjs ; introuvable = SKIP
//   bruyant (exit 2), jamais compté PASS.
// Code de sortie : 0 = PASS, 2 = SKIP, 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";
import {
    SEED_MODE_NODE,
    SEED_MODE_RANDOM,
    SEED_MODE_FIXED,
    normalizeSeedMode,
    nextSeedMode,
    seedModeIcon,
    seedModeTitleKey,
    parseSeedDigits,
    normalizeSeedValue,
    seedValueDigits,
    normalizeElementSeed,
    elementSeedFields,
    derivedElementSeed,
    effectiveElementSeed,
    resolveBraceBlocks,
    seedModeTooltip,
    createSeedControl,
} from "./aih_elements_seed.js";

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const widgetSrc = readFileSync(new URL("./aih_elements_widget.js", import.meta.url), "utf8");
const seedSrc = readFileSync(new URL("./aih_elements_seed.js", import.meta.url), "utf8");

/* ══════════════ 1. Sémantique des 3 modes / cycle ══════════════════════ */
console.log("1. Modes : hérité (défaut) · random · fixe");
assert.strictEqual(SEED_MODE_NODE, "node");
assert.strictEqual(SEED_MODE_RANDOM, "random");
assert.strictEqual(SEED_MODE_FIXED, "fixed");

for (const legacy of [undefined, null, "", "bogus", 42, {}, []]) {
    assert.strictEqual(normalizeSeedMode(legacy), "node",
        `valeur de mode inconnue ${JSON.stringify(legacy)} → hérité (défaut)`);
}
assert.strictEqual(normalizeSeedMode(" FIXED "), "fixed", "mode insensible à la casse/espaces");
assert.strictEqual(normalizeSeedMode("Random"), "random");
ok("normalizeSeedMode : inconnu → « node » (rétro-compatibilité stricte)");

assert.strictEqual(nextSeedMode("node"), "random");
assert.strictEqual(nextSeedMode("random"), "fixed");
assert.strictEqual(nextSeedMode("fixed"), "node");
assert.strictEqual(nextSeedMode(undefined), "random", "mode absent traité comme hérité");
let cycled = "node";
for (let i = 0; i < 3; i++) cycled = nextSeedMode(cycled);
assert.strictEqual(cycled, "node", "3 clics ramènent au mode hérité");
ok("cycle de clic : hérité → random → fixe → hérité");

const icons = ["node", "random", "fixed"].map(seedModeIcon);
assert.deepStrictEqual(icons, ["🔗", "🎲", "🔒"], "icônes : chaînon / dé / cadenas");
assert.strictEqual(new Set(icons).size, 3, "les 3 icônes sont distinctes (aucune ambiguïté)");
for (const mode of ["node", "random", "fixed"]) {
    assert.ok(seedModeTitleKey(mode).startsWith("el.seed"), `clé i18n du mode ${mode}`);
}
ok("icônes explicites et clés i18n dédiées par mode");

/* ══════════════ 2. Valeurs de seed : bornes et saisies ═════════════════ */
console.log("2. Valeurs de seed");
assert.strictEqual(seedValueDigits(undefined), "0");
assert.strictEqual(seedValueDigits(null), "0");
assert.strictEqual(seedValueDigits("  "), "0");
assert.strictEqual(seedValueDigits("abc"), "0");
assert.strictEqual(seedValueDigits("-5"), "0");
assert.strictEqual(seedValueDigits("007"), "7", "zéros de tête normalisés");
assert.strictEqual(seedValueDigits("0"), "0");
assert.strictEqual(seedValueDigits(42), "42");
assert.strictEqual(seedValueDigits(42.9), "42", "entier tronqué");
ok("seedValueDigits : canonique, négatifs/texte → « 0 »");

assert.strictEqual(normalizeSeedValue("42"), 42);
assert.strictEqual(normalizeSeedValue(42), 42);
assert.strictEqual(normalizeSeedValue("abc"), 0);
assert.strictEqual(normalizeSeedValue(-1), 0);
assert.strictEqual(normalizeSeedValue(undefined), 0);
assert.strictEqual(normalizeSeedValue("18446744073709551616"), "18446744073709551615",
    "au-delà de 2^64-1 : borné à la limite du widget seed ComfyUI");
assert.strictEqual(normalizeSeedValue("99999999999999999999999"), "18446744073709551615");
assert.strictEqual(normalizeSeedValue(1e30), "18446744073709551615",
    "Number hors bornes borné (jamais rejeté en silence)");
const huge = normalizeSeedValue("18446744073709551615");
assert.strictEqual(typeof huge, "string", "grand entier conservé en chaîne (pas de perte JSON)");
assert.strictEqual(huge, "18446744073709551615");
ok("normalizeSeedValue : bornes 0..0xffffffffffffffff, grands entiers sans perte");

assert.strictEqual(parseSeedDigits("abc"), null, "saisie invalide signalée (aucune persistance)");
assert.strictEqual(parseSeedDigits(""), null);
assert.strictEqual(parseSeedDigits("12a"), null);
assert.strictEqual(parseSeedDigits("12"), "12");
ok("parseSeedDigits : null = saisie refusée (pas de valeur parasite)");

/* ══════════════ 3. Persistance / round-trip ════════════════════════════ */
console.log("3. Persistance : anciens éléments intacts");
assert.deepStrictEqual(normalizeElementSeed({ type: "text", text: "abc", hint: "" }), {},
    "élément historique → AUCUN champ ajouté");
assert.deepStrictEqual(normalizeElementSeed({ seed_mode: "node", seed_value: 5 }), {},
    "mode hérité explicite → aucun champ (pas de valeur parasite)");
assert.deepStrictEqual(normalizeElementSeed({ seed_mode: "bogus", seed_value: 5 }), {});
assert.deepStrictEqual(normalizeElementSeed({ seed_mode: "random" }), { seed_mode: "random" });
assert.deepStrictEqual(normalizeElementSeed({ seed_mode: "fixed", seed_value: "42" }),
    { seed_mode: "fixed", seed_value: 42 });
assert.deepStrictEqual(normalizeElementSeed({ seed_mode: "fixed" }),
    { seed_mode: "fixed", seed_value: 0 }, "mode fixe sans valeur → 0 (repli dérivé du texte)");
assert.strictEqual(elementSeedFields, normalizeElementSeed, "alias de sérialisation");

// Round-trip complet : élément interne → JSON → rechargement → même élément.
const internal = { type: "text", text: "{a::b}", hint: "h", visible: true, seed_mode: "fixed", seed_value: 7 };
const json = JSON.parse(JSON.stringify({ visible: true, ...elementSeedFields(internal), type: "raw", text: internal.text, hint: "h" }));
assert.deepStrictEqual(json, { visible: true, seed_mode: "fixed", seed_value: 7, type: "raw", text: "{a::b}", hint: "h" });
assert.deepStrictEqual(normalizeElementSeed(json), { seed_mode: "fixed", seed_value: 7 },
    "round-trip complet sans perte");
// Un ancien preset réécrit ne gagne AUCUN champ.
const legacyJson = { visible: true, type: "raw", text: "{a::b}", hint: "" };
assert.deepStrictEqual(
    JSON.parse(JSON.stringify({ ...legacyJson, ...elementSeedFields(legacyJson) })),
    legacyJson,
    "un ancien élément réécrit reste strictement identique (bit-à-bit)",
);
ok("persistance : round-trip des 3 modes, format historique jamais modifié");

/* ══════════════ 4. Seed effectif par élément ═══════════════════════════ */
console.log("4. Seed effectif par élément (miroir Python)");
assert.strictEqual(effectiveElementSeed({}, 123), 123, "hérité → seed de la node");
assert.strictEqual(effectiveElementSeed({ seed_mode: "node" }, 0), 0, "hérité sans seed node → 0");
assert.strictEqual(effectiveElementSeed({ seed_mode: "fixed", seed_value: 42 }, 999), 42,
    "fixe → valeur de l'élément, indépendante du seed de la node");
assert.strictEqual(effectiveElementSeed({ seed_mode: "fixed", seed_value: "18446744073709551615" }, 1),
    "18446744073709551615", "fixe grand entier conservé tel quel");

// Mode fixe avec valeur 0 : repli STABLE dérivé du texte (jamais le chemin random).
const textEl = { seed_mode: "fixed", seed_value: 0, text: "femme de {25::30::35::40} ans" };
const derivedA = effectiveElementSeed(textEl, 1);
const derivedB = effectiveElementSeed(textEl, 987654321);
assert.strictEqual(derivedA, derivedB, "repli identique quel que soit le seed de la node");
assert.strictEqual(derivedA, derivedElementSeed(textEl));
assert.ok(derivedA > 0, "repli jamais nul (jamais le chemin « aléatoire » des helpers)");
assert.notStrictEqual(derivedA, 1 + 0, "repli non trivial");
ok("hérité → seed node · fixe → valeur propre · fixe 0 → dérivé du texte (stable)");

// Mode random : hors du seed de la node, et variable d'un appel à l'autre.
const randomSeeds = [];
for (let i = 0; i < 40; i++) randomSeeds.push(effectiveElementSeed({ seed_mode: "random" }, 123));
assert.ok(randomSeeds.every((s) => typeof s === "number" && s > 0), "random : toujours non nul");
assert.ok(randomSeeds.every((s) => s !== 123), "random : jamais le seed de la node");
assert.ok(new Set(randomSeeds).size > 1, "random : ne se répète pas");
const twoElems = [effectiveElementSeed({ seed_mode: "random" }, 7), effectiveElementSeed({ seed_mode: "random" }, 7)];
assert.notStrictEqual(twoElems[0], twoElems[1], "deux éléments random ne tirent pas la même valeur");
ok("random : tirage indépendant par élément et par exécution");

/* ══════════════ 5. Miroir Python (table vérifiée des deux côtés) ═══════ */
console.log("5. resolveBraceBlocks == nodes/elements_node.py::_resolve_braces");
// Table GÉNÉRÉE par le Python réel (tests/test_elements_seed_modes.py vérifie la
// même table) : toute divergence de hash entre l'aperçu JS et le Run casse ici.
const MIRROR_TABLE = [
    ["a {x::y::z} b", 42, 0, "a y b"],
    ["{blond::brun} cheveux {long::court}", 7, 3, "brun cheveux long"],
    ["{bleu::rouge::vert}", 1234567890123456789, 1, "vert"],
    ["{A::B} et {A::B}", 99, 4, "A et A"],
    ["{seul}", 5, 0, "seul"],
    ["texte littéral", 5, 0, "texte littéral"],
    ["{a::b::c} {a::b::c}", 20260101, 2, "c c"],
    ["femme de {25::30::35::40} ans", 3503270066, 2, "femme de 30 ans"],
    ["{:://vide::}", 8, 1, "//vide"],
];
for (const [text, seed, index, expected] of MIRROR_TABLE) {
    assert.strictEqual(resolveBraceBlocks(text, seed, index), expected,
        `resolveBraceBlocks(${JSON.stringify(text)}, ${seed}, ${index})`);
}
assert.strictEqual(resolveBraceBlocks("", 5, 0), "");
assert.strictEqual(resolveBraceBlocks(null, 5, 0), "");
// Grand entier en chaîne : même représentation que le Python (f"{seed}|…").
assert.strictEqual(resolveBraceBlocks("{bleu::rouge::vert}", "1234567890123456789", 1), "vert");
ok(`table de hash identique au Python (${MIRROR_TABLE.length} cas, aperçu == Run)`);

/* ══════════════ 6. DOM (jsdom) : contrôle 3 états ══════════════════════ */
console.log("6. Contrôle DOM à 3 états");
const JSDOM = await loadJsdomOrSkip("test_aih_elements_seed");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const { window } = dom;
const doc = window.document;

const fakeT = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key);
const calls = [];
const onChange = (mode, value, kind) => calls.push([mode, value, kind]);

// 6.a Mode hérité : icône chaînon, PAS de champ de valeur.
const nodeEl = { type: "text", text: "abc" };
const ctlNode = createSeedControl({ doc, element: nodeEl, t: fakeT, onChange });
assert.ok(ctlNode, "contrôle créé");
const btnNode = ctlNode.querySelector("button.aih-seed-mode");
assert.ok(btnNode, "bouton de mode présent");
assert.strictEqual(btnNode.textContent, "🔗");
assert.strictEqual(btnNode.dataset.seedMode, "node");
assert.ok(btnNode.title.includes("el.seedModeNode"), `infobulle du mode hérité : ${btnNode.title}`);
assert.ok(btnNode.title.includes("el.seedCycleHint"), "infobulle rappelle « clic : mode suivant »");
assert.strictEqual(ctlNode.querySelectorAll("button").length, 1, "un seul bouton par ligne");
assert.strictEqual(ctlNode.querySelector("input.aih-seed-value"), null,
    "aucun champ de valeur en mode hérité (ligne non élargie)");
// Le pattern imposé : onclick direct, JAMAIS mousedown/pointerdown (DOM widgets).
assert.strictEqual(typeof btnNode.onclick, "function", "onclick direct posé");
assert.strictEqual(btnNode.onmousedown, null, "aucun onmousedown (casserait la synthèse du clic)");
assert.strictEqual(btnNode.onpointerdown, null, "aucun onpointerdown (casserait la synthèse du clic)");
assert.ok(!/addEventListener\(\s*["'](?:pointerdown|mousedown)/.test(seedSrc),
    "le module n'ajoute aucun listener pointerdown/mousedown");
ok("mode hérité : 🔗 + infobulle, pas de champ, clic direct uniquement");

// 6.b Clic : hérité → random (aucune valeur transmise) → fixe (valeur proposée).
btnNode.click();
assert.deepStrictEqual(calls.pop(), ["random", undefined, "mode"],
    "hérité → random, aucune valeur de seed proposée");
ok("clic : hérité → random (indépendant du seed de la node)");

// 6.c Mode fixe : champ de valeur révélé + valeurs par défaut sûres.
// L'élément est le MÊME objet que celui du widget : le callback de la ligne y
// écrit seed_mode / seed_value (comme le fait renderList) — le contrôle relit
// donc toujours l'état persistant, jamais le texte brut du champ.
calls.length = 0;
const fixedEl = { type: "text", text: "abc", seed_mode: "fixed", seed_value: 7 };
const onFixedChange = (mode, value, kind) => {
    fixedEl.seed_mode = mode;
    if (mode === "fixed" && value !== undefined) fixedEl.seed_value = value;
    calls.push([mode, value, kind]);
};
const ctlFixed = createSeedControl({ doc, element: fixedEl, t: fakeT, onChange: onFixedChange });
const btnFixed = ctlFixed.querySelector("button.aih-seed-mode");
assert.strictEqual(btnFixed.textContent, "🔒");
assert.strictEqual(btnFixed.dataset.seedMode, "fixed");
assert.ok(btnFixed.title.includes('"value":"7"'), `infobulle affiche la valeur réelle : ${btnFixed.title}`);
const input = ctlFixed.querySelector("input.aih-seed-value");
assert.ok(input, "champ de valeur présent en mode fixe");
assert.strictEqual(input.value, "7", "valeur de l'élément affichée");
assert.strictEqual(input.title, "el.seedFixedTitle");
assert.strictEqual(input.placeholder, "el.seedFixedPlaceholder");
assert.strictEqual(input.inputMode, "numeric");
ok("mode fixe : 🔒 + champ numérique inline (pas de modale) prérempli");

// 6.d Saisie valide → callback "value" (pas de re-rendu de ligne).
input.value = "42";
input.dispatchEvent(new window.Event("input"));
assert.deepStrictEqual(calls.pop(), ["fixed", 42, "value"]);
assert.ok(btnFixed.title.includes('"value":"42"'),
    `infobulle rafraîchie sans re-rendu : ${btnFixed.title}`);
ok("saisie valide : valeur persistée via onChange(kind=« value »)");

// 6.e Saisie invalide → AUCUNE persistance, champ signalé.
input.value = "abc";
input.dispatchEvent(new window.Event("input"));
assert.strictEqual(calls.length, 0, "une saisie non entière ne persiste RIEN");
assert.strictEqual(input.getAttribute("aria-invalid"), "true");
assert.ok(/248,\s*113,\s*113|f87171/i.test(input.style.borderColor),
    `bordure rouge (refus visible), got ${JSON.stringify(input.style.borderColor)}`);
assert.strictEqual(input.title, "el.seedFixedInvalid", "message d'aide i18n affiché");

// 6.f Perte de focus → valeur canonique restaurée (dernière valeur valide).
input.dispatchEvent(new window.Event("change"));
assert.strictEqual(input.value, "42", "champ réécrit avec la dernière valeur valide");
assert.deepStrictEqual(calls.pop(), ["fixed", 42, "value"]);
assert.strictEqual(input.getAttribute("aria-invalid"), null, "erreur effacée");
ok("saisie invalide : refusée sans écriture, valeur restaurée à la sortie du champ");

// 6.g Bornes : valeur hors limite bornée, jamais rejetée en silence.
input.value = "99999999999999999999999";
input.dispatchEvent(new window.Event("input"));
const clamped = calls.pop();
assert.deepStrictEqual(clamped, ["fixed", "18446744073709551615", "value"],
    "valeur bornée à 0xffffffffffffffff");
input.dispatchEvent(new window.Event("change"));
assert.strictEqual(input.value, "18446744073709551615", "borne affichée après validation");
ok("bornes 0..0xffffffffffffffff appliquées à la saisie");

// 6.h Clic depuis le mode fixe vers hérité : aucune valeur transmise.
calls.length = 0;
btnFixed.click();
assert.deepStrictEqual(calls.pop(), ["node", undefined, "mode"]);
ok("clic : fixe → hérité (retour au comportement historique)");

/* ══════════════ 7. Intégration dans le widget ══════════════════════════ */
console.log("7. Intégration widget (sources)");
assert.ok(/from "\.\/aih_elements_seed\.js"/.test(widgetSrc),
    "le widget importe le module de seed (source unique)");
assert.strictEqual((widgetSrc.match(/\.\.\.elementSeedFields\(e\)/g) || []).length, 2,
    "seed sérialisé dans _elements_json pour les filtres ET les textes");
assert.strictEqual((widgetSrc.match(/const seed = elementSeedFields\(e\);/g) || []).length, 2,
    "seed normalisé dans les DEUX branches de restauration (preset + workflow)");
assert.ok(/const seedCtl = createSeedControl\(\{/.test(widgetSrc), "contrôle rendu par ligne");
assert.ok(/if \(kind === "mode"\) renderList\(\);/.test(widgetSrc),
    "seul un changement de MODE re-rend la ligne (focus du champ préservé)");
assert.ok(/resolveBraceBlocks\(rawText, effectiveElementSeed\(el, nodeSeed\), i\)/.test(widgetSrc),
    "aperçu « Test generation » déterministe pour les éléments en mode fixe");
assert.ok(/const seed = nodeSeed;/.test(widgetSrc), "payload Test : seed de la node (inchangé)");
assert.strictEqual((widgetSrc.match(/if \(seed > 0\) payload\.seed = seed;/g) || []).length, 1,
    "seed envoyé au serveur SEULEMENT s'il est > 0 (comportement d'origine)");
assert.ok(!/payload\.seed_mode|payload\.seed_value/.test(widgetSrc),
    "aucun champ de seed par élément envoyé au backend (contrat serveur inchangé)");
ok("widget : sérialisation, restauration, aperçu et payload conformes");

/* ══════════════ 8. i18n FR/EN parité stricte ═══════════════════════════ */
console.log("8. i18n FR/EN");
globalThis.window = globalThis.window || window;
globalThis.localStorage = window.localStorage;
await import("./aih_i18n.js");
const I18n = (globalThis.window.AIH = globalThis.window.AIH || window.AIH).I18n;
const dictionaries = {};
const origAddDict = I18n.addDict.bind(I18n);
I18n.addDict = (lang, entries) => {
    dictionaries[lang] = Object.assign(dictionaries[lang] || {}, entries);
    return origAddDict(lang, entries);
};
await import("./aih_strings.js");

const SEED_KEYS = [
    "el.seedModeNode", "el.seedModeRandom", "el.seedModeFixed", "el.seedCycleHint",
    "el.seedFixedTitle", "el.seedFixedPlaceholder", "el.seedFixedInvalid",
];
for (const key of SEED_KEYS) {
    assert.ok(dictionaries.fr && key in dictionaries.fr, `clé ${key} absente en FR`);
    assert.ok(dictionaries.en && key in dictionaries.en, `clé ${key} absente en EN`);
    assert.ok(String(dictionaries.fr[key]).trim().length > 0, `${key} vide en FR`);
    assert.ok(String(dictionaries.en[key]).trim().length > 0, `${key} vide en EN`);
}
{
    const frKeys = Object.keys(dictionaries.fr || {});
    const enKeys = Object.keys(dictionaries.en || {});
    const onlyFr = frKeys.filter((k) => !(k in (dictionaries.en || {})));
    const onlyEn = enKeys.filter((k) => !(k in (dictionaries.fr || {})));
    assert.deepStrictEqual(onlyFr, [], `clés FR absentes en EN : ${onlyFr.join(", ")}`);
    assert.deepStrictEqual(onlyEn, [], `clés EN absentes en FR : ${onlyEn.join(", ")}`);
}
assert.ok(/\{value\}/.test(dictionaries.fr["el.seedModeFixed"]), "placeholders {value} en FR");
assert.ok(/\{value\}/.test(dictionaries.en["el.seedModeFixed"]), "placeholders {value} en EN");
// Infobulle réelle (I18n) : le mode fixe affiche la valeur utilisée.
const tip = seedModeTooltip("fixed", { seed_value: 3 }, (k, p) => I18n.t(k, p));
assert.ok(tip.includes("3"), `infobulle traduite contient la valeur : ${tip}`);
ok(`i18n : ${SEED_KEYS.length} clés FR+EN, parité stricte des dictionnaires`);

console.log(`\n✅ Elements Picker — seed par élément : TOUS LES TESTS PASSENT (${n} groupes)`);
