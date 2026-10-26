// ─────────────────────────────────────────────────────────────────────────
// ComfyCH (intégration pack AI-Helper) — visibilité WIP et sous-menu.
//
// Ce que ce test verrouille :
//   (a) feature WIP « comfych » DÉSACTIVÉE → AUCUNE ligne ComfyCH dans le menu
//       AIH (contrôle négatif : c'est l'assertion qui devient rouge si la
//       condition WIP saute) ;
//   (b) feature ACTIVÉE → la ligne « ComfyCH » de la section « Outils & Dev »
//       porte le sélecteur GPU + le bouton ⚙ (fournis par le pont
//       window.AIHComfyCHHost) ;
//   (c) le sélecteur n'est JAMAIS injecté dans la barre d'outils ComfyUI
//       (l'ancien dropdown d'origine doit disparaître de la barre) ;
//   (d) Échap ET clic extérieur referment le menu, y compris depuis la ligne
//       ComfyCH ; un clic DANS la ligne (curseur de réglage) ne le referme pas ;
//   (e) mode de rendu forcé « local » au démarrage : la valeur affichée est
//       local SANS que la préférence enregistrée (localStorage) ne soit
//       réécrite, et l'interception de queuePrompt reste en place (elle délègue
//       simplement à l'implémentation d'origine).
//
// Usage : node js/test_comfych_menu.mjs
//   jsdom résolu par js/test_helpers/jsdom_loader.mjs ; absent = SKIP (exit 2).
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const JSDOM = await loadJsdomOrSkip("test_comfych_menu");
const dom = new JSDOM(
    "<!doctype html><html><head></head><body><div id=\"comfy-toolbar\"></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" }
);
const { window: domWindow } = dom;
globalThis.window = domWindow;
globalThis.document = domWindow.document;
globalThis.localStorage = domWindow.localStorage;
globalThis.getComputedStyle = domWindow.getComputedStyle.bind(domWindow);
globalThis.HTMLElement = domWindow.HTMLElement;
globalThis.Node = domWindow.Node;
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
try { globalThis.navigator = domWindow.navigator; } catch { /* déjà fourni */ }
domWindow.matchMedia = domWindow.matchMedia
    || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));

localStorage.setItem("aih_locale", "fr");
// Préférence de GPU de l'utilisateur : elle doit RESTER intacte malgré le
// forçage « local » du démarrage (décision utilisateur).
localStorage.setItem("modal-gateway-mode", "modal:h100");

// Réponse de /api/modal/config : le serveur force le mode « local » en mémoire.
globalThis.fetch = async (url) => {
    const body = String(url).includes("/api/modal/config")
        ? { api_url: "", api_key_set: true, render_mode_forced: "local" }
        : {};
    return {
        ok: true, status: 200,
        headers: { get: () => "application/json" },
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
};

// Faux app ComfyUI : une « barre d'outils » contient le bouton Settings, et
// l'API expose queuePrompt (point d'interception de ComfyCH).
const toolbar = document.getElementById("comfy-toolbar");
const settingsButton = document.createElement("button");
settingsButton.id = "comfy-settings-button";
toolbar.appendChild(settingsButton);

let originalQueueCalls = 0;
const fakeApi = {
    queuePrompt(number, workflow, options) {
        originalQueueCalls++;
        return Promise.resolve({ number, workflow, options });
    },
};
// Référence AVANT tout import : ComfyCH installe son interception dès que
// l'API est visible, donc la capture doit précéder les imports.
const pristineQueuePrompt = fakeApi.queuePrompt;
const app = {
    graph: { nodes: [] },
    canvas: {},
    ui: {},
    api: fakeApi,
    extensions: [],
    menu: { settingsGroup: { element: settingsButton } },
    registerExtension(ext) { app.extensions.push(ext); if (!app.ext) app.ext = ext; },
};
globalThis.window.app = app;
domWindow.app = app;
globalThis.app = app;
domWindow.api = fakeApi;
domWindow.comfyAPI = { app: { app } };

/* ══════════════ 1. Le frontend ComfyCH se charge (pont) ══════════════ */
console.log("1. Chargement du module ComfyCH et de son pont");

await import("./comfych_gateway.js");
await import("./comfych/modal_gateway.js");

assert.ok(domWindow.AIHComfyCHHost, "pont window.AIHComfyCHHost exposé");
assert.strictEqual(typeof domWindow.AIHComfyCHHost.buildControls, "function", "buildControls() disponible");
assert.strictEqual(typeof domWindow.AIHComfyCHHost.openSettings, "function", "openSettings() disponible");
ok("pont ComfyCH disponible (buildControls/openSettings)");

/* ══════ 2. Mode de rendu forcé à local, sans écrire la préférence ══════ */
console.log("2. Mode de rendu forcé « local » (en mémoire)");

// Laisse la promesse fetch('/api/modal/config') se résoudre.
await new Promise((r) => setTimeout(r, 30));
assert.strictEqual(
    domWindow.AIHComfyCHHost.currentMode(), "local",
    "le mode effectif doit être « local » au démarrage (forçage serveur)"
);
assert.strictEqual(
    localStorage.getItem("modal-gateway-mode"), "modal:h100",
    "la préférence GPU enregistrée NE DOIT PAS être écrasée par le forçage"
);
ok("mode effectif = local ; préférence « modal:h100 » intacte dans localStorage");

const controls = domWindow.AIHComfyCHHost.buildControls();
assert.ok(controls, "buildControls() retourne un élément");
const gpuSelect = controls.querySelector("#modal-gpu-selector");
const gearButton = controls.querySelector("#modal-settings-btn");
assert.ok(gpuSelect, "sélecteur GPU présent dans les contrôles");
assert.ok(gearButton, "bouton ⚙ présent dans les contrôles");
assert.strictEqual(gpuSelect.value, "local", "le sélecteur affiche le mode forcé (local)");
assert.ok(
    [...gpuSelect.options].some((o) => o.value === "modal:h100"),
    "l'option cloud de l'utilisateur reste proposée (rien n'est supprimé)"
);
ok("contrôles : 🎮 + sélecteur GPU (local) + bouton ⚙");

/* ══════ 3. Aucune injection dans la barre d'outils de ComfyUI ══════ */
console.log("3. Le dropdown d'origine disparaît de la barre d'outils ComfyUI");

for (const ext of app.extensions) {
    if (typeof ext.setup === "function") await ext.setup();
}
await new Promise((r) => setTimeout(r, 120));
assert.strictEqual(
    toolbar.querySelector("#modal-gateway-container"), null,
    "MUTANT : la barre d'outils ne doit plus contenir le conteneur ComfyCH"
);
assert.strictEqual(
    document.getElementById("modal-gateway-container"), null,
    "aucun conteneur ComfyCH monté hors du menu AIH"
);
ok("barre d'outils ComfyUI allégée (aucun #modal-gateway-container)");

/* ══════ 4. Interception de queuePrompt toujours en place ══════ */
console.log("4. Interception du bouton Queue conservée, inactive en mode local");

// L'interception est retentée toutes les CONFIG.RETRY_INTERVAL (800 ms).
await new Promise((r) => setTimeout(r, 1000));
assert.notStrictEqual(
    fakeApi.queuePrompt, pristineQueuePrompt,
    "MUTANT : l'interception de queuePrompt doit rester installée (masqué ≠ désactivé)"
);
await fakeApi.queuePrompt(1, { nodes: [] }, {});
assert.strictEqual(originalQueueCalls, 1, "en mode local, l'implémentation d'origine est appelée");
ok("queuePrompt intercepté puis délégué (mode local = aucune action cloud)");

/* ══════════ 5. WIP désactivée → AUCUNE ligne ComfyCH dans le menu ══════ */
console.log("5. Feature WIP « comfych » désactivée → ligne absente");

await import("./aih_i18n.js");
domWindow.AIH.I18n.setLocale("fr");
await import("./holaf_main.js");

domWindow.holaf = domWindow.holaf || {};
domWindow.holaf.wipManager = { isEnabled: () => false }; // toutes les WIP off
if (typeof domWindow.holaf.rebuildMenu === "function") domWindow.holaf.rebuildMenu();

const menuExt = app.extensions.find((e) => e && e.name === "Holaf.Utilities.Menu");
assert.ok(menuExt, "extension du menu AIH enregistrée");
await menuExt.setup();
// setup() planifie init() via setTimeout(…, 10) : on laisse le tour de boucle.
await new Promise((r) => setTimeout(r, 150));

const mainButton = document.getElementById("holaf-utilities-menu-button");
const dropdown = document.getElementById("holaf-utilities-dropdown-menu");
assert.ok(mainButton, "bouton de menu AIH présent");
assert.ok(dropdown, "menu déroulant AIH présent");
assert.strictEqual(
    document.getElementById("holaf-menu-comfych"), null,
    "MUTANT : la ligne ComfyCH ne doit PAS apparaître quand la feature WIP est désactivée"
);
assert.strictEqual(
    document.querySelector("#holaf-menu-comfych-controls"), null,
    "aucun contrôle ComfyCH dans le menu quand la feature est masquée"
);
ok("feature WIP désactivée → menu sans ComfyCH");

/* ══════════ 6. WIP activée → ligne avec dropdown GPU + bouton ⚙ ══════ */
console.log("6. Feature WIP « comfych » activée → ligne avec contrôles");

domWindow.holaf.wipManager = { isEnabled: (id) => id === "comfych" };
domWindow.holaf.rebuildMenu();
await new Promise((r) => setTimeout(r, 80));

const comfychRow = document.getElementById("holaf-menu-comfych");
assert.ok(comfychRow, "ligne ComfyCH présente quand la feature est activée");
assert.ok(
    comfychRow.textContent.includes("ComfyCH"),
    "la ligne porte le libellé traduit « ComfyCH »"
);
const rowSelect = comfychRow.querySelector("#modal-gpu-selector");
const rowGear = comfychRow.querySelector("#modal-settings-btn");
assert.ok(rowSelect, "sélecteur GPU présent DANS la ligne du menu");
assert.ok(rowGear, "bouton ⚙ présent à droite de la ligne");
assert.ok(
    comfychRow.contains(rowSelect),
    "le sélecteur est bien monté dans la ligne (pas ailleurs)"
);
ok("sous-menu ComfyCH : libellé + sélecteur GPU + bouton ⚙");

// Ouvrir le menu puis vérifier qu'un clic dans la ligne ne le referme pas.
mainButton.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
assert.strictEqual(dropdown.style.display, "block", "menu ouvert");
comfychRow.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
assert.strictEqual(dropdown.style.display, "block", "un clic dans la ligne ComfyCH ne ferme pas le menu");
const toolbarContainer = toolbar.querySelector("#modal-gateway-container");
assert.strictEqual(toolbarContainer, null, "MUTANT : la barre d'outils reste sans ComfyCH (menu ouvert)");
ok("la ligne reste utilisable sans fermer le menu ; barre d'outils toujours allégée");

/* ══════════ 7. Fermeture : Échap et clic extérieur ══════════ */
console.log("7. Fermeture au clavier (Échap) et au clic extérieur");

document.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
assert.strictEqual(dropdown.style.display, "none", "Échap ferme le menu");

mainButton.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
assert.strictEqual(dropdown.style.display, "block", "menu ré-ouvert");
document.body.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
assert.strictEqual(dropdown.style.display, "none", "un clic extérieur ferme le menu");
ok("fermeture Échap + clic extérieur opérationnelle");

console.log(`\n✅ ComfyCH — visibilité WIP et sous-menu : TOUS LES TESTS PASSENT (${n} groupes)`);
process.exit(0);
