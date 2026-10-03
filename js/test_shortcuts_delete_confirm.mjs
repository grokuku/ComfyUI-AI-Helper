// ─────────────────────────────────────────────────────────────────────────
// SHORTCUTS — CONFIRMATION DESTRUCTIVE avant la suppression d'un raccourci.
//
// Existant (avant correctif) : clic sur ✕ → suppression IMMÉDIATE et
//   IRRÉVERSIBLE de `HolafShortcuts.shortcuts` + écriture de persistance
//   (`app.graph.extra.holaf_shortcuts`), sans aucune demande de confirmation.
//
// Couverture (vraie AIH.Dialog, aucun stub de dialogue) :
//   (a) clic sur ✕ → la modale de confirmation du système UNIFIÉ s'ouvre
//       (AIH.Dialog) ; le bouton destructif porte la classe
//       `aih-dialog-btn-danger` et le libellé i18n « Supprimer » ; le message
//       nomme le raccourci et annonce le caractère définitif ; RIEN n'est
//       supprimé tant que la modale est ouverte ;
//   (b) bouton « Annuler » → AUCUNE suppression : état en mémoire intact,
//       AUCUNE écriture de persistance (graph.extra inchangé) ;
//   (c) Échap → annule (idem Annuler) ;
//   (d) clic sur le fond (overlay) → annule (fail-safe) ;
//   (e) « Supprimer » → suppression EXACTEMENT comme avant (retrait + sync) ;
//   (f) anti-XSS : un nom contenant du HTML est échappé (AIH.confirm insère le
//       message en innerHTML) ;
//   (g) parité i18n FR/EN stricte des nouvelles clés.
//
// Usage : node js/test_shortcuts_delete_confirm.mjs
//   jsdom résolu par js/test_helpers/jsdom_loader.mjs ; absent = SKIP (exit 2).
// Code de sortie : 0 = PASS, 2 = SKIP, 1 = FAIL.
//
// Contrôles négatifs par mutation : /projects/.aih_tmp/shortcuts_delete_confirm/mutate.sh
//   M1 retire la confirmation (clic ✕ = suppression directe) → ce test doit être
//   ROUGE ; M2 rend « Annuler » destructif → ce test doit être ROUGE.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const JSDOM = await loadJsdomOrSkip("test_shortcuts_delete_confirm");
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
});
const { window: domWindow } = dom;
globalThis.window = domWindow;
globalThis.document = domWindow.document;
globalThis.localStorage = domWindow.localStorage;
globalThis.getComputedStyle = domWindow.getComputedStyle.bind(domWindow);
globalThis.HTMLElement = domWindow.HTMLElement;
globalThis.Node = domWindow.Node;
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
try { globalThis.navigator = domWindow.navigator; } catch { /* Node fournit déjà un navigator */ }
domWindow.matchMedia = domWindow.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));

// Interdit formellement window.confirm : si le code y recourt, le test échoue.
domWindow.confirm = () => { throw new Error("window.confirm() INTERDIT — utiliser AIH.confirm"); };

localStorage.setItem("aih_locale", "fr");

// ── Faux app / api ComfyUI (avant import : la couche compat s'y accroche). ──
domWindow.app = {
    graph: { extra: {}, _nodes: [], getNodeById() { return null; } },
    canvas: { graph: null, setGraph() {}, ds: { offset: [0, 0], scale: 1 }, setDirty() {} },
    registerExtension(ext) { this.extensions.push(ext); },
    extensions: [],
};
domWindow.app.canvas.graph = domWindow.app.graph;
domWindow.api = { api_base: "", addEventListener() {} };

await import("./aih_i18n.js");
const I18n = domWindow.AIH.I18n;
const captured = {};
const origAddDict = I18n.addDict.bind(I18n);
I18n.addDict = (lang, entries) => {
    captured[lang] = Object.assign(captured[lang] || {}, entries);
    return origAddDict(lang, entries);
};
I18n.setLocale("fr");
await import("./aih_dialog.js");
await import("./aih_strings.js");
await import("./holaf_shortcuts.js");

assert.strictEqual(typeof domWindow.AIH.Dialog.open, "function", "VRAI AIH.Dialog disponible (aucun stub)");
assert.strictEqual(typeof domWindow.AIH.confirm, "function", "AIH.confirm (dialogue unifié) disponible");

const ext = domWindow.app.extensions.find((e) => e && e.name === "Holaf.Shortcuts");
assert.ok(ext && typeof ext.setup === "function", "extension Holaf.Shortcuts enregistrée");
await ext.setup();
const HS = domWindow.app.holafShortcuts;
assert.ok(HS && typeof HS.deleteShortcut === "function", "HolafShortcuts exposé (app.holafShortcuts)");

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const dialogOf = () => [...document.querySelectorAll(".aih-dialog-root")].find((r) => r.querySelector("[data-aih-ok]"));

// Espion de persistance : compte les appels à syncToGraph.
let syncCount = 0;
const origSync = HS.syncToGraph.bind(HS);
HS.syncToGraph = function () { syncCount++; return origSync(); };

const GRAPH_KEY = HS.GRAPH_EXTRA_KEY;
const setShortcut = (id, name) => {
    HS.shortcuts = [{ id, name, x: 0, y: 0, zoom: 1, path: [] }];
    HS.renderList();
};
const delBtnOf = (id) => {
    const row = HS.listElement.querySelector(`[data-id="${id}"]`);
    assert.ok(row, `ligne du raccourci ${id} présente`);
    return [...row.querySelectorAll("button")].find((b) => b.textContent === "✕");
};

/* ══════════════════ (a) Clic ✕ → modale de confirmation ═════════════════ */
console.log("(a) Clic sur ✕ → modale de confirmation (AIH.Dialog) ouverte, bouton destructif rouge");

setShortcut("a", "Alpha");
domWindow.app.graph.extra = {};   // aucune persistance initiale
syncCount = 0;
const delBtn = delBtnOf("a");
assert.ok(delBtn, "bouton de suppression ✕ présent");
delBtn.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick();
const confirmRoot = dialogOf();
assert.ok(confirmRoot, "la modale de confirmation est OUVERTE (racine AIH.Dialog avec [data-aih-ok])");
const okBtn = confirmRoot.querySelector("[data-aih-ok]");
const cancelBtn = confirmRoot.querySelector("[data-aih-cancel]");
assert.ok(okBtn && cancelBtn, "deux actions : Annuler + action de confirmation");
assert.ok(okBtn.classList.contains("aih-dialog-btn-danger"), "action de confirmation en ROUGE (aih-dialog-btn-danger)");
assert.strictEqual(okBtn.textContent.trim(), I18n.t("sc.deleteConfirmAction"), `libellé destructif i18n : « ${okBtn.textContent.trim()} »`);
assert.strictEqual(cancelBtn.textContent.trim(), I18n.t("dialog.cancel"), "libellé Annuler i18n");
const confirmMsg = (confirmRoot.querySelector(".aih-dialog-message") || {}).textContent || "";
assert.strictEqual(confirmMsg.trim(), I18n.t("sc.deleteConfirm", { name: "Alpha" }), "message = clé i18n sc.deleteConfirm interpolée avec le nom");
assert.ok(/définitiv|irréversible/i.test(confirmMsg), "le message annonce le caractère DÉFINITIF/irréversible");
assert.ok(confirmMsg.includes("Alpha"), "le message NOMME le raccourci concerné");
assert.strictEqual(confirmRoot.querySelector(".aih-dialog-title").textContent.trim(), I18n.t("sc.deleteTitle"), "titre i18n de la confirmation");
// Tant que la modale est ouverte : RIEN n'a été supprimé ni persisté.
assert.strictEqual(HS.shortcuts.length, 1, "tant que la modale est ouverte, le raccourci est intact (mémoire)");
assert.strictEqual(syncCount, 0, "tant que la modale est ouverte, AUCUNE écriture de persistance");
assert.ok(!(GRAPH_KEY in domWindow.app.graph.extra), "tant que la modale est ouverte, graph.extra ne contient pas de raccourcis");
ok("(a) ✕ → modale unifiée avec bouton rouge « Supprimer », aucun effet immédiat");

/* ══════════════════ (b) Annuler → AUCUNE suppression ════════════════════ */
console.log("(b) Annuler → raccourci intact, aucune écriture de persistance");

cancelBtn.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick();
assert.ok(!document.body.contains(confirmRoot), "la modale de confirmation est fermée après Annuler");
assert.strictEqual(HS.shortcuts.length, 1, "Annuler : le raccourci est TOUJOURS présent (mémoire)");
assert.strictEqual(HS.shortcuts[0].id, "a", "Annuler : c'est bien le même raccourci conservé");
assert.strictEqual(syncCount, 0, "Annuler : AUCUNE écriture de persistance (syncToGraph jamais appelé)");
assert.ok(!(GRAPH_KEY in domWindow.app.graph.extra), "Annuler : graph.extra inchangé (aucune persistance écrite)");
ok("(b) Annuler : aucune suppression, ni état ni persistance modifiés");

/* ══════════════════ (c) Échap → annule ═════════════════════════════════ */
console.log("(c) Échap → annule (aucune suppression)");

delBtnOf("a").dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick();
const confirmEsc = dialogOf();
assert.ok(confirmEsc, "modale réouverte pour le test Échap");
document.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await tick();
assert.ok(!document.body.contains(confirmEsc), "Échap ferme la modale de confirmation");
assert.strictEqual(HS.shortcuts.length, 1, "Échap : le raccourci est intact");
assert.strictEqual(syncCount, 0, "Échap : AUCUNE écriture de persistance");
ok("(c) Échap = Annuler : fermeture sans suppression");

/* ══════════════════ (d) Clic sur le fond → annule ══════════════════════ */
console.log("(d) Clic sur le fond (overlay) → annule");

delBtnOf("a").dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick();
const confirmOverlay = dialogOf();
assert.ok(confirmOverlay, "modale réouverte pour le test clic sur le fond");
const overlay = document.querySelector(".aih-dialog-overlay");
assert.ok(overlay, "overlay de modale présent");
overlay.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick();
assert.ok(!document.body.contains(confirmOverlay), "clic sur le fond ferme la modale");
assert.strictEqual(HS.shortcuts.length, 1, "clic sur le fond : le raccourci est intact");
assert.strictEqual(syncCount, 0, "clic sur le fond : AUCUNE écriture de persistance");
ok("(d) clic sur le fond = Annuler : fermeture sans suppression");

/* ══════════════════ (e) Supprimer → suppression comme avant ════════════ */
console.log("(e) Supprimer → suppression effective, identique à l'existant");

delBtnOf("a").dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick();
const confirmDel = dialogOf();
assert.ok(confirmDel, "modale réouverte pour le test Supprimer");
confirmDel.querySelector("[data-aih-ok]").dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick();
assert.ok(!document.body.contains(confirmDel), "la modale est fermée après Supprimer");
assert.strictEqual(HS.shortcuts.length, 0, "Supprimer : le raccourci est SUPPRIMÉ (comportement d'origine)");
assert.strictEqual(syncCount, 1, "Supprimer : la persistance est écrite (syncToGraph appelé une fois)");
assert.ok(GRAPH_KEY in domWindow.app.graph.extra, "Supprimer : graph.extra contient la clé de raccourcis");
assert.deepStrictEqual(domWindow.app.graph.extra[GRAPH_KEY], [], "Supprimer : la persistance reflète la liste vide");
assert.ok(!HS.listElement.querySelector('[data-id="a"]'), "Supprimer : la liste est re-rendue (plus de ligne)");
ok("(e) Supprimer : suppression effective + persistance, comportement d'origine conservé");

/* ══════════════════ (f) Anti-XSS : nom échappé ════════════════════════ */
console.log("(f) Anti-XSS : un nom contenant du HTML est échappé dans la modale");

const EVIL = '<img src=x onerror="window.__xss=1">';
domWindow.__xss = undefined;
setShortcut("x", EVIL);
syncCount = 0;
delBtnOf("x").dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick();
const xssRoot = dialogOf();
assert.ok(xssRoot, "modale ouverte pour le nom piégé");
const xssMsg = (xssRoot.querySelector(".aih-dialog-message") || {}).textContent || "";
assert.ok(!xssRoot.querySelector(".aih-dialog-message img"), "aucune balise <img> injectée (nom échappé)");
assert.ok(xssMsg.includes("<img"), "le nom est rendu LITTÉRALEMENT (échappé) dans le message");
assert.strictEqual(domWindow.__xss, undefined, "aucun script exécuté");
xssRoot.querySelector("[data-aih-cancel]").dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick();
assert.strictEqual(HS.shortcuts.length, 1, "Annuler sur le nom piégé : raccourci intact");
ok("(f) anti-XSS : nom échappé avant interpolation dans AIH.confirm");

/* ══════════════════ (g) Parité i18n FR/EN ═════════════════════════════ */
console.log("(g) Parité i18n FR/EN des nouvelles clés");

const NEW_KEYS = ["sc.deleteTitle", "sc.deleteConfirm", "sc.deleteConfirmAction"];
for (const k of NEW_KEYS) {
    assert.ok(k in (captured.fr || {}), `clé FR présente : ${k}`);
    assert.ok(k in (captured.en || {}), `clé EN présente : ${k}`);
    assert.ok(String(captured.fr[k]).trim() !== "", `clé FR non vide : ${k}`);
    assert.ok(String(captured.en[k]).trim() !== "", `clé EN non vide : ${k}`);
}
assert.notStrictEqual(captured.fr["sc.deleteConfirm"], captured.en["sc.deleteConfirm"], "le message FR et EN diffèrent (vraie traduction)");
assert.ok(String(captured.fr["sc.deleteConfirm"]).includes("{name}"), "la clé FR conserve le placeholder {name}");
assert.ok(String(captured.en["sc.deleteConfirm"]).includes("{name}"), "la clé EN conserve le placeholder {name}");
// Clé de dialogue partagée.
const savedLocale = I18n.getLocale();
I18n.setLocale("fr");
const frCancel = I18n.t("dialog.cancel");
I18n.setLocale("en");
const enCancel = I18n.t("dialog.cancel");
I18n.setLocale(savedLocale);
assert.ok(frCancel.trim() !== "" && enCancel.trim() !== "", "clé dialogue partagée non vide FR/EN : dialog.cancel");
ok(`(g) parité FR/EN OK : ${NEW_KEYS.length} nouvelles clés présentes et non vides`);

console.log(`\n✅ Confirmation de suppression d'un raccourci : TOUS LES TESTS PASSENT (${n} assertions)`);
process.exit(0);
