// ─────────────────────────────────────────────────────────────────────────
// BUG 1 — « Ouvrir le Chat depuis le menu AIH ne ferme pas le menu ».
//
// Cause : js/holaf_main.js, fin du handler de clic d'une entrée du menu,
//   `if (!checkbox && itemInfo.special !== 'aih_chat') { this.hideDropdown(); }`
//   excluait explicitement 'aih_chat' → le menu restait ouvert par-dessus la
//   fenêtre du chat (et chaque clic répété empilait une modale).
//
// Couverture :
//   (a) clic sur « 💬 Chat » → openChat() appelé ET menu fermé (display:none) ;
//   (b) CONTRÔLE NÉGATIF : clic sur la ligne « Activer Blobby » (toggle, pas de
//       fermeture par design) → le menu reste OUVERT. Prouve que l'assertion (a)
//       n'est pas vide (un menu qui reste ouvert serait détecté).
//
// Usage : node js/test_aih_menu_chat_close.mjs
//   jsdom résolu par js/test_helpers/jsdom_loader.mjs ; absent = SKIP (exit 2).
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const JSDOM = await loadJsdomOrSkip("test_aih_menu_chat_close");
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

localStorage.setItem("aih_locale", "fr");
globalThis.fetch = async () => ({
    ok: true, status: 200,
    headers: { get: () => "application/json" },
    json: async () => ({}), text: async () => "{}",
});

// Faux app ComfyUI : capture l'extension enregistrée par holaf_main.js.
const app = {
    graph: { nodes: [] },
    canvas: {},
    ui: {},
    registerExtension(ext) { app.ext = ext; },
    extensions: [],
    menu: null,
};
globalThis.window.app = app;
domWindow.app = app;
globalThis.app = app;

// Toutes les features WIP activées → l'entrée « 💬 Chat » est visible.
// NB : holaf_wip_settings.js (importé par holaf_main.js) pose son PROPRE
// wipManager ; on (ré)installe le stub APRÈS l'import, avant setup().
domWindow.holaf = { wipManager: { isEnabled: () => true } };

await import("./aih_i18n.js");
domWindow.AIH.I18n.setLocale("fr");
await import("./holaf_main.js");

domWindow.holaf = domWindow.holaf || {};
domWindow.holaf.wipManager = { isEnabled: () => true };

assert.ok(app.ext && typeof app.ext.setup === "function", "extension menu enregistrée");
await app.ext.setup(); // init() est planifié via setTimeout(…, 10)

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(60);

const mainButton = document.getElementById("holaf-utilities-menu-button");
const dropdown = document.getElementById("holaf-utilities-dropdown-menu");
assert.ok(mainButton, "bouton de menu présent");
assert.ok(dropdown, "dropdown présent");

// Stubs AIHMenu : on observe l'appel openChat/toggleBlobby.
let openChatCalls = 0;
domWindow.AIHMenu = {
    openChat: () => { openChatCalls++; },
    toggleBlobby: () => false,
    getBlobbyState: () => false,
    checkServerStatus: () => {},
};

/* ══════════════════ (a) Ouverture du chat → menu fermé ══════════════════ */
console.log("(a) Clic « 💬 Chat » : openChat() appelé ET menu fermé");

mainButton.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
assert.strictEqual(dropdown.style.display, "block", "menu ouvert au clic sur le bouton");
const chatItem = document.getElementById("holaf-menu-aih-chat");
assert.ok(chatItem, "entrée « 💬 Chat » présente (feature WIP active)");
chatItem.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
assert.strictEqual(openChatCalls, 1, "openChat() appelé une fois");
assert.strictEqual(dropdown.style.display, "none", "menu FERMÉ après ouverture du chat");
ok("(a) le menu se ferme après l'ouverture du chat (BUG 1 corrigé)");

/* ══════════════════ (b) Contrôle négatif : toggle Blobby ════════════════ */
console.log("(b) Contrôle négatif : la ligne « Activer Blobby » laisse le menu ouvert");

mainButton.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
assert.strictEqual(dropdown.style.display, "block", "menu ré-ouvert");
const blobbyItem = document.getElementById("holaf-menu-aih-blobby");
assert.ok(blobbyItem, "ligne toggle Blobby présente");
blobbyItem.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
assert.strictEqual(dropdown.style.display, "block", "CONTRÔLE : le toggle ne ferme pas le menu (comportement voulu)");
// Et l'entrée chat, elle, ferme toujours.
mainButton.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true })); // ferme (toggle)
mainButton.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true })); // rouvre
document.getElementById("holaf-menu-aih-chat").dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
assert.strictEqual(dropdown.style.display, "none", "chat ferme toujours le menu (non-régression du toggle)");
ok("(b) contrôle négatif : le test distingue bien « reste ouvert » de « se ferme »");

console.log(`\n✅ BUG 1 — fermeture du menu à l'ouverture du chat : TOUS LES TESTS PASSENT (${n} groupes)`);
process.exit(0);
