// Tests de la MULTI-SÉLECTION du Model Browser : Ctrl/Cmd+clic (ajouter/
// retirer), Maj+clic (plage), « tout sélectionner » sur le résultat filtré,
// compteur « N sélectionné(s) », effacement, téléchargement groupé.
// jsdom + fetch stubé, AUCUN appel réseau réel.
// Usage : node js/test_aih_model_browser_multiselect.mjs
//
// PIÈGE HISTORIQUE CORRIGÉ : la sélection lisait les modifieurs sur l'évènement
// 'change' d'une case à cocher. Dans un vrai navigateur, 'change' ne porte PAS
// shiftKey/ctrlKey/metaKey (propriétés undefined) → TOUT clic tombait dans la
// branche « sélection unique » et décrochait les autres. Les tests historiques
// ne le voyaient pas car ils fabriquaient un MouseEvent('change', {ctrlKey}).
// Ici les modifieurs sont lus sur le CLIC (vrai MouseEvent), comme le fait le
// navigateur.
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_aih_model_browser_multiselect");

const dom = new JSDOM(`<!doctype html><html><body></body></html>`, {
    pretendToBeVisual: true, url: "http://localhost/",
});
const { window } = dom;
const { document } = window;
globalThis.window = window;
globalThis.document = document;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.MouseEvent = window.MouseEvent;
globalThis.Image = window.Image;
globalThis.requestAnimationFrame = window.requestAnimationFrame?.bind(window) || ((cb) => setTimeout(cb, 0));
globalThis.cancelAnimationFrame = window.cancelAnimationFrame?.bind(window) || clearTimeout;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.ResizeObserver = globalThis.ResizeObserver;
window.comfyAPI = { app: { app: { registerExtension() {}, api: {} } }, api: { api: { api_base: "/" } } };
globalThis.URL.createObjectURL = () => "blob:mock";
globalThis.URL.revokeObjectURL = () => {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

const calls = { download: [] };
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const json = (d, status = 200) =>
        new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
    if (u.includes("/auth/me")) return json({ role: "user" });
    if (u.includes("/models/local")) return json({ items: {} });
    if (u.includes("/models/remote")) {
        const items = [];
        for (let i = 1; i <= 5; i++) {
            items.push({ upload_id: "uid-" + i, filename: "m" + i + ".safetensors", type: "unet", size: 1000 * i });
        }
        return json({ items, total: 5, page: 1, limit: 50 });
    }
    if (u.includes("/models/download/progress")) return json({ percent: 0, bytes_recv: 0, bytes_total: 0, phase: "preparing" });
    if (u.includes("/models/download/cancel")) return json({ ok: true });
    if (u.includes("/models/download")) {
        if (opts && opts.body) calls.download.push(JSON.parse(opts.body));
        return new Promise(() => {});
    }
    return json({});
};
window.fetch = globalThis.fetch;
window.localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "https://aih.example.com", apiKey: "tok" }));

await import("./02_aih_model_browser.js");
for (const k of ["aihOpenModalV2", "aihShowAlert", "aihShowConfirm", "aihToast", "showConflictModal", "HolafModal"]) {
    if (typeof window[k] !== "undefined") globalThis[k] = window[k];
}
window.AIH.I18n.setLocale("fr");

const rows = () => Array.from(document.querySelectorAll("#mb-remote-list .mb-item"));
const cbOf = (i) => rows()[i].querySelector(".mb-checkbox");
const checkedFlags = () => rows().map((r) => r.querySelector(".mb-checkbox").checked);
const count = () => document.querySelector('.mb-selection-count[data-scope="remote"]').textContent;
const batchBtn = () => document.querySelector(".mb-batch-download");
const click = (el, mods) => el.dispatchEvent(new window.MouseEvent("click", Object.assign({ bubbles: true }, mods || {})));

/* ─── 1. Liste + état initial ────────────────────────────────────────────── */
console.log("1. Liste + état initial");
window.openModelBrowser();
await sleep(250);
assert.strictEqual(rows().length, 5, "5 modèles distants");
assert.strictEqual(count(), "0 sélectionné(s)", "compteur initial à 0");
assert.strictEqual(batchBtn().disabled, true, "bouton de lot désactivé sans sélection");
ok("5 lignes, compteur 0, lot désactivé");

/* ─── 2. Clic simple = sélection unique ──────────────────────────────────── */
console.log("2. Clic simple = sélection unique");
click(rows()[0]);
assert.deepStrictEqual(checkedFlags(), [true, false, false, false, false], "seule la ligne 0 est cochée");
assert.strictEqual(count(), "1 sélectionné(s)", "compteur 1");
click(rows()[1]);
assert.deepStrictEqual(checkedFlags(), [false, true, false, false, false], "clic simple remplace la sélection");
ok("clic simple → sélection unique (remplace)");

/* ─── 3. Ctrl/Cmd+clic = ajouter / retirer ───────────────────────────────── */
console.log("3. Ctrl/Cmd+clic = ajouter/retirer");
click(rows()[0]);
click(rows()[2], { ctrlKey: true });
assert.deepStrictEqual(checkedFlags(), [true, false, true, false, false], "Ctrl+clic AJOUTE (0 + 2)");
assert.strictEqual(count(), "2 sélectionné(s)", "compteur 2");
assert.strictEqual(batchBtn().disabled, false, "bouton de lot activé");
assert.ok(/\(2\)/.test(batchBtn().textContent), "libellé du lot = (2)");
click(rows()[2], { ctrlKey: true });
assert.deepStrictEqual(checkedFlags(), [true, false, false, false, false], "Ctrl+clic RETIRE (2)");
click(rows()[0], { metaKey: true }); // Cmd (macOS)
assert.deepStrictEqual(checkedFlags(), [false, false, false, false, false], "Cmd+clic retire aussi (0)");
ok("Ctrl/Cmd+clic → ajout puis retrait sans toucher les autres");

/* ─── 4. Maj+clic = plage depuis l'ancre ─────────────────────────────────── */
console.log("4. Maj+clic = plage");
click(rows()[1]);           // ancre = 1 (cochée)
click(rows()[4], { shiftKey: true }); // plage 1..4
assert.deepStrictEqual(checkedFlags(), [false, true, true, true, true], "Maj+clic sélectionne la plage 1..4");
assert.strictEqual(count(), "4 sélectionné(s)", "compteur 4");
ok("Maj+clic → plage 1..4 (ancre conservée)");

/* ─── 5. « Tout sélectionner » sur le résultat filtré ────────────────────── */
console.log("5. Tout sélectionner / effacer");
const allBox = document.querySelector('.mb-select-all-row[data-scope="remote"] .mb-select-all-cb');
assert.ok(allBox, "case « tout sélectionner » présente");
click(rows()[2], { ctrlKey: true }); // retire 2 → sélection partielle
assert.strictEqual(count(), "3 sélectionné(s)", "sélection partielle 3");
assert.strictEqual(allBox.checked, false, "case tout-sélectionner non cochée en partiel");
assert.strictEqual(allBox.indeterminate, true, "état indéterminé en sélection partielle");
allBox.checked = true;
allBox.dispatchEvent(new window.Event("change", { bubbles: true }));
assert.deepStrictEqual(checkedFlags(), [true, true, true, true, true], "tout sélectionner coche toutes les lignes");
assert.strictEqual(count(), "5 sélectionné(s)", "compteur 5");
const clearBtn = document.querySelector('.mb-clear-selection[data-scope="remote"]');
assert.strictEqual(clearBtn.disabled, false, "bouton effacer activé");
clearBtn.click();
assert.deepStrictEqual(checkedFlags(), [false, false, false, false, false], "effacer décoche tout");
assert.strictEqual(count(), "0 sélectionné(s)", "compteur 0 après effacement");
assert.strictEqual(batchBtn().disabled, true, "lot redésactivé");
ok("tout sélectionner (résultat filtré) → 5 ; effacer → 0");

/* ─── 6. Téléchargement GROUPÉ de la sélection ───────────────────────────── */
console.log("6. Téléchargement groupé");
click(rows()[0]);
click(rows()[3], { ctrlKey: true });
assert.strictEqual(count(), "2 sélectionné(s)", "2 lignes sélectionnées");
batchBtn().click();
await sleep(150);
const dlwRows = document.querySelectorAll("#aih-download-window .aih-dlw-row");
assert.strictEqual(dlwRows.length, 2, "la fenêtre affiche 1 ligne par fichier du lot");
assert.strictEqual(calls.download.length, 1, "lot séquentiel : 1er transfert lancé");
assert.strictEqual(calls.download[0].upload_id, "uid-1", "1er fichier = ligne 0");
ok("sélection (2) → fenêtre 2 lignes + 1er téléchargement (uid-1)");

/* ─── 7. CONTRÔLE NÉGATIF : clic sans modifieur ne fait jamais du multi ──── */
console.log("7. Contrôle négatif — pas de multi sans modifieur");
document.querySelector("#aih-download-window .aih-dlw-close").click();
await sleep(40);
clearSelectionAll();
function clearSelectionAll() {
    const b = document.querySelector('.mb-clear-selection[data-scope="remote"]');
    if (b && !b.disabled) b.click();
}
click(rows()[0]);
click(rows()[1]); // sans ctrl → remplace
assert.deepStrictEqual(checkedFlags(), [false, true, false, false, false],
    "deux clics simples successifs = sélection unique (jamais 2)");
ok("contrôle négatif : deux clics simples → une seule ligne (pas de multi accidentel)");

/* ─── 8. CONTRÔLE NÉGATIF : 'change' ne porte pas les modifieurs ─────────── */
console.log("8. Contrôle négatif — 'change' sans modifieur lu");
clearSelectionAll();
// Un évènement 'change' (comme en vrai navigateur : sans shiftKey/ctrlKey) ne
// doit PAS produire de sélection multiple : le code lit le CLIC.
cbOf(0).checked = true;
cbOf(0).dispatchEvent(new window.Event("change", { bubbles: true }));
cbOf(2).checked = true;
cbOf(2).dispatchEvent(new window.Event("change", { bubbles: true }));
assert.strictEqual(count(), "0 sélectionné(s)",
    "la logique ne dépend plus de 'change' (les modifieurs viennent du clic)");
ok("contrôle négatif : 'change' ignoré (modifieurs lus sur le clic)");

console.log(`\n✅ test_aih_model_browser_multiselect : ${n} groupes PASSENT`);
try { dom.window.close(); } catch (e) { /* silencieux */ }
process.exit(0);
