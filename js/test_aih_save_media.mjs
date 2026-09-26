// ─────────────────────────────────────────────────────────────────────────
// Contrat « sauvegarde serveur » du node AIH Save Media.
//
// Couverture :
//   1. présence + ORDRE du toggle `save_to_server` (avant `base_path`) dans
//      INPUT_TYPES (nodes/holaf_save_media.py), et défaut False ;
//   2. parité i18n FR/EN des clés `sm.*` (dont `sm.saveToServer`) ;
//   3. widget js/aih_save_media_widget.js : renommage du label via i18n,
//      grisage de `base_path` quand le toggle est ON, réactivation sinon ;
//   4. hooks : les deux clés node (AIHSaveMedia + alias HolafSaveMedia) sont
//      branchées ; un node non-AIH n'est PAS modifié (contrôle négatif).
//
// Usage : node js/test_aih_save_media.mjs
// Code de sortie : 0 = PASS, 1 = FAIL (aucune dépendance jsdom requise).
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { readFileSync } from "node:fs";

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

/* ─── Environnement minimal (window + localStorage + navigator) ─────────── */
const store = {};
globalThis.window = {
    localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; },
    },
    navigator: { language: "fr-FR" },
};

/* ─── i18n : capture des dictionnaires AVANT enregistrement ─────────────── */
await import("./aih_i18n.js");
const I18n = window.AIH.I18n;
const captured = {};
const origAddDict = I18n.addDict.bind(I18n);
I18n.addDict = (lang, entries) => {
    captured[lang] = Object.assign(captured[lang] || {}, entries);
    return origAddDict(lang, entries);
};
await import("./aih_strings.js");
I18n.setLocale("fr");

/* ─── Fake app : le widget s'enregistre immédiatement (pas de polling) ──── */
let capturedExt = null;
window.app = {
    graph: { setDirtyCanvas() {} },
    registerExtension(ext) { capturedExt = ext; },
};

await import("./aih_save_media_widget.js");
const SW = window.AIH.SaveMediaWidget;

/* ══════════════════ 1. INPUT_TYPES : présence + ordre ═══════════════════ */
console.log("1. INPUT_TYPES du node (ordre + défaut)");

const py = readFileSync(new URL("../nodes/holaf_save_media.py", import.meta.url), "utf8");
const iToggle = py.indexOf('"save_to_server": ("BOOLEAN"');
const iBase = py.indexOf('"base_path": ("STRING"');
assert.ok(iToggle > 0, "save_to_server déclaré dans INPUT_TYPES");
assert.ok(iBase > 0, "base_path déclaré dans INPUT_TYPES");
assert.ok(iToggle < iBase, "save_to_server est déclaré AVANT base_path (affiché au-dessus)");
ok("save_to_server avant base_path");

assert.ok(
    /"save_to_server": \("BOOLEAN", \{"default": False\}\)/.test(py),
    "le toggle a pour défaut False (compat anciens workflows)"
);
ok("défaut False (compat arrière)");

assert.ok(py.includes('kwargs.get("save_to_server", False)'), "save_media lit le toggle avec défaut False");
assert.ok(py.includes("MediaUploadError") || py.includes("media_upload.upload_media"), "le node appelle l'upload serveur");
ok("save_media lit le toggle + upload serveur branché");

/* ══════════════════ 2. Parité i18n FR/EN des clés sm.* ══════════════════ */
console.log("2. i18n FR/EN (clés sm.*)");

const frKeys = Object.keys(captured.fr || {}).filter((k) => k.startsWith("sm."));
const enKeys = Object.keys(captured.en || {}).filter((k) => k.startsWith("sm."));
assert.ok(frKeys.includes("sm.saveToServer"), "FR contient sm.saveToServer");
assert.deepStrictEqual(frKeys.slice().sort(), enKeys.slice().sort(), "parité stricte des clés sm.* FR/EN");
for (const k of frKeys) {
    assert.ok(captured.fr[k] && captured.fr[k] !== k, `FR ${k} non vide`);
    assert.ok(captured.en[k] && captured.en[k] !== k, `EN ${k} non vide`);
}
assert.strictEqual(captured.fr["sm.saveToServer"], "Sauvegarder sur le serveur");
assert.strictEqual(captured.en["sm.saveToServer"], "Save to server");
ok(`sm.* FR/EN OK (${frKeys.length} clés, valeurs non vides)`);

/* ══════════════════ 3. Helpers du widget ════════════════════════════════ */
console.log("3. Widget : label + grisage de base_path");

assert.ok(SW && typeof SW.applyBasePathState === "function", "AIH.SaveMediaWidget exposé");

const makeNode = () => ({
    widgets: [
        { name: "save_to_server", value: false },
        { name: "base_path", value: "/out", inputEl: { style: {}, disabled: false, readOnly: false } },
    ],
});

const node = makeNode();
SW.localize(node);
assert.strictEqual(node.widgets[0].label, "Sauvegarder sur le serveur", "label FR via i18n");
ok("label du toggle renommé (FR)");

// Toggle OFF → base_path actif.
SW.applyBasePathState(node);
assert.strictEqual(node.widgets[1].disabled, false, "toggle OFF → base_path actif");
assert.strictEqual(node.widgets[1].inputEl.style.opacity, "1");
ok("toggle OFF → base_path actif");

// Toggle ON → base_path grisé.
node.widgets[0].value = true;
SW.applyBasePathState(node);
assert.strictEqual(node.widgets[1].disabled, true, "toggle ON → base_path désactivé");
assert.strictEqual(node.widgets[1].inputEl.disabled, true);
assert.strictEqual(node.widgets[1].inputEl.readOnly, true);
assert.strictEqual(node.widgets[1].inputEl.style.opacity, "0.45");
assert.strictEqual(node.widgets[1].inputEl.style.pointerEvents, "none");
assert.ok(node.widgets[1].inputEl.title && node.widgets[1].inputEl.title.length > 0, "tooltip de grisage");
ok("toggle ON → base_path grisé (opacity 0.45, non cliquable)");

// Retour OFF → réactivé.
node.widgets[0].value = false;
SW.applyBasePathState(node);
assert.strictEqual(node.widgets[1].disabled, false);
assert.strictEqual(node.widgets[1].inputEl.style.opacity, "1");
assert.strictEqual(node.widgets[1].inputEl.style.pointerEvents, "");
ok("retour OFF → base_path réactivé");

// Contrôle négatif : node sans widgets → aucun crash.
SW.applyBasePathState({});
SW.localize(null);
ok("robustesse : node vide / null sans crash");

/* ══════════════════ 4. Hooks ComfyUI (beforeRegisterNodeDef) ════════════ */
console.log("4. Hooks ComfyUI");

assert.ok(capturedExt && typeof capturedExt.beforeRegisterNodeDef === "function", "extension enregistrée");

// Node AIH canonique.
const nodeType = { prototype: {} };
await capturedExt.beforeRegisterNodeDef(nodeType, { name: "AIHSaveMedia" });
assert.strictEqual(typeof nodeType.prototype.onNodeCreated, "function", "AIHSaveMedia branché");
ok("AIHSaveMedia branché");

// Alias hérité.
const legacyType = { prototype: {} };
await capturedExt.beforeRegisterNodeDef(legacyType, { name: "HolafSaveMedia" });
assert.strictEqual(typeof legacyType.prototype.onNodeCreated, "function", "HolafSaveMedia branché");
ok("HolafSaveMedia (alias) branché");

// Contrôle négatif : node étranger NON modifié.
const otherType = { prototype: {} };
await capturedExt.beforeRegisterNodeDef(otherType, { name: "SomeOtherNode" });
assert.strictEqual(otherType.prototype.onNodeCreated, undefined, "node non-AIH non modifié");
ok("node non-AIH non modifié (contrôle négatif)");

// Intégration : onNodeCreated applique label + état, callback grise en direct.
const inst = makeNode();
nodeType.prototype.onNodeCreated.call(inst);
assert.strictEqual(inst.widgets[0].label, "Sauvegarder sur le serveur");
assert.strictEqual(inst.widgets[1].disabled, false);
inst.widgets[0].value = true;
inst.widgets[0].callback();
assert.strictEqual(inst.widgets[1].disabled, true, "le callback du toggle grise base_path");
ok("onNodeCreated : label + grisage via callback");

console.log(`\n✅ Test AIH Save Media : TOUS LES TESTS PASSENT (${n} étapes)`);
