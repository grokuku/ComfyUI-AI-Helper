// Simulation : autorité z-index / actif / halo UNIQUE entre AIH.Dialog et
// HolafPanelManager.
// Usage : node js/test_aih_window_manager.mjs
import assert from "node:assert";
// Le faux DOM minimal est fourni par le helper PARTAGÉ js/test_helpers/fake_dom.mjs,
// importé EXPLICITEMENT. Fini l'extraction par marqueur texte dans
// test_aih_dialog.mjs : un renommage de commentaire ne peut plus provoquer
// l'import silencieux de TOUT le fichier de test (asserts exécutés + effets de
// bord) au lieu d'un échec clair.
import "./test_helpers/fake_dom.mjs";

globalThis.ResizeObserver = class { observe(){} disconnect(){} unobserve(){} };
globalThis.fetch = async () => ({ ok:false, json: async () => ({}) });
globalThis.setTimeout = (fn) => { if (fn) { try { fn(); } catch {} } };
globalThis.clearTimeout = () => {};
globalThis.Node = class {};
globalThis.HTMLElement = globalThis.Node;
if (!globalThis.window) globalThis.window = globalThis;
globalThis.window.setTimeout = globalThis.setTimeout;

const prev = console.info; console.info = () => {};
await import("./aih_i18n.js");
await import("./aih_dialog.js");
const HPM = (await import("./holaf_panel_manager.js")).HolafPanelManager;
const { aihWindowManager } = await import("./holaf_window_utils.js");
console.info = prev;

const doc = globalThis.document;
const D = globalThis.window.AIH.Dialog;

/* ── 1. Un seul compteur partagé (instance unique du module ESM) ─────────── */
assert.strictEqual(aihWindowManager().counter, 0, "compteur global partagé");

/* ── 2. Ouvrir 1 dialog AIH + 1 panel holaf ──────────────────────────────── */
const dlg = D.open({ title: "Dialogue AIH", width: "300px" });   // modal:false, non-persistant
assert.ok(dlg.el.classList.contains("active"), "dialog actif à l'ouverture (halo)");
assert.ok(parseInt(dlg.el.style.zIndex) >= 1000, "z dialog sur échelle unifiée");

const panel = HPM.createPanel({
    id: "panel1",
    title: "Panneau Holaf",
    defaultSize: { width: 200, height: 150 },
    defaultPosition: { x: 20, y: 20 },
});
const panelEl = panel.panelEl;

// Une seule .active : la fenêtre créée en dernier (le panel) est active.
let activeCount = 0;
doc.body._allDescendants([]).forEach(n => { if (n.classList && n.classList.contains("active")) activeCount++; });
assert.strictEqual(activeCount, 1, "une seule fenêtre .active à la fois, got " + activeCount);
assert.ok(panelEl.classList.contains("active"), "panel actif après création");

/* ── 3. Cliquer le dialog → il passe AU-DESSUS du panel et devient seul actif ── */
const dialogZ = parseInt(dlg.el.style.zIndex, 10);
const panelZ = parseInt(panelEl.style.zIndex, 10);
assert.ok(panelZ > dialogZ, "panel ouvert après le dialog → z panel > z dialog");

dlg.bringToFront(); // équivalent au mousedown sur le dialog

const dialogZ2 = parseInt(dlg.el.style.zIndex, 10);
const panelZ2 = parseInt(panelEl.style.zIndex, 10);
assert.ok(dialogZ2 > panelZ2, "cliquer le dialog → dialog au-dessus du panel (" + dialogZ2 + " > " + panelZ2 + ")");
assert.ok(dlg.el.classList.contains("active"), "dialog .active");
assert.ok(!panelEl.classList.contains("active"), "panel a perdu .active (halo unique)");

activeCount = 0;
doc.body._allDescendants([]).forEach(n => { if (n.classList && n.classList.contains("active")) activeCount++; });
assert.strictEqual(activeCount, 1, "toujours une seule .active");

/* ── 4. Cliquer le panel → il repasse au-dessus du dialog, halo inversé ──── */
HPM.bringToFront(panelEl);
const dialogZ3 = parseInt(dlg.el.style.zIndex, 10);
const panelZ3 = parseInt(panelEl.style.zIndex, 10);
assert.ok(panelZ3 > dialogZ3, "cliquer le panel → panel au-dessus du dialog (" + panelZ3 + " > " + dialogZ3 + ")");
assert.ok(panelEl.classList.contains("active"), "panel .active");
assert.ok(!dlg.el.classList.contains("active"), "dialog a perdu .active");

activeCount = 0;
doc.body._allDescendants([]).forEach(n => { if (n.classList && n.classList.contains("active")) activeCount++; });
assert.strictEqual(activeCount, 1, "halo unique après aller-retour");

/* ── 5. Compteur partagé : même échelle continue ─────────────────────────── */
assert.ok(aihWindowManager().counter >= 2, "compteur global partagé incrémenté, got " + aihWindowManager().counter);
assert.strictEqual(aihWindowManager().size, 2, "les deux fenêtres sont enregistrées dans le gestionnaire commun");

/* ── 6. Fermeture : désenregistrement ────────────────────────────────────── */
dlg.close();
assert.strictEqual(aihWindowManager().size, 1, "dialog fermé → désenregistré du gestionnaire commun");
assert.ok(!dlg.el.classList.contains("active"), "dialog fermé → plus de halo");

console.log("✅ Simulation aihWindowManager : UNE seule .active, z-index unifié, halo inversé entre dialog et panel");
