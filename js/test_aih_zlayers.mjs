// Simulation : BANDES de z-index du gestionnaire partagé (holaf_window_utils).
//
// Régression BUG : le menu du pack (dropdown « Holaf Utilities ») passait SOUS
// l'overlay plein écran du viewer (z-index 10999) parce que son z-index inline
// était figé à '10005' (écrasant la règle CSS à 100000). Le fix place le menu
// dans une couche « popup » (AIH_POPUP_Z = 50000) au-dessus de tous les
// panneaux / overlays viewer, et remonte les dialogues MODAUX AIH.Dialog dans
// une bande supérieure (AIH_MODAL_Z = 90000) pour qu'ils restent au-dessus.
//
// Usage : node js/test_aih_zlayers.mjs
// Faux DOM minimal fourni par le helper PARTAGÉ js/test_helpers/fake_dom.mjs.
//
// Code de sortie : 0 = PASS, 1 = FAIL.
import assert from "node:assert";
import "./test_helpers/fake_dom.mjs";

globalThis.ResizeObserver = class { observe(){} disconnect(){} unobserve(){} };
globalThis.fetch = async () => ({ ok:false, json: async () => ({}) });
globalThis.Node = class {};
globalThis.HTMLElement = globalThis.Node;
if (!globalThis.window) globalThis.window = globalThis;
globalThis.window.setTimeout = globalThis.setTimeout;

const prevInfo = console.info; console.info = () => {};
await import("./aih_i18n.js");
await import("./aih_dialog.js");
const { HolafPanelManager } = await import("./holaf_panel_manager.js");
const { aihWindowManager, AIH_POPUP_Z, AIH_MODAL_Z } = await import("./holaf_window_utils.js");
console.info = prevInfo;

const D = globalThis.window.AIH.Dialog;
const zOf = (el) => parseInt(el.style.zIndex, 10);

/* ── 1. Contrat des couches ─────────────────────────────────────────────── */
assert.ok(AIH_POPUP_Z > 0 && AIH_POPUP_Z < AIH_MODAL_Z,
    `couche popup (${AIH_POPUP_Z}) strictement sous la bande modale (${AIH_MODAL_Z})`);
// Le menu doit couvrir l'overlay plein écran du viewer (10999).
assert.ok(AIH_POPUP_Z > 10999, "la couche popup couvre l'overlay fullscreen du viewer (10999)");
// La modale doit rester sous les toasts (200000).
assert.ok(AIH_MODAL_Z < 200000, "la bande modale reste sous les toasts (200000)");

/* ── 2. Panneau galerie : sous la couche popup ──────────────────────────── */
const gallery = HolafPanelManager.createPanel({
    id: "galerie", title: "Galerie",
    defaultSize: { width: 400, height: 300 },
    defaultPosition: { x: 10, y: 10 },
});
const galleryZ = zOf(gallery.panelEl);
assert.ok(galleryZ >= 1000 && galleryZ < AIH_POPUP_Z,
    `panneau galerie sous la couche popup (z=${galleryZ} < ${AIH_POPUP_Z})`);

/* ── 3. Modale AIH.Dialog : AU-DESSUS de la couche popup ────────────────── */
const modal = D.open({ title: "Modale", content: "x", modal: true });
const modalZ = zOf(modal.el);
const overlayEl = modal.el.parentNode.children.find(
    (c) => c.className && String(c.className).includes("aih-dialog-overlay"));
assert.ok(modalZ >= AIH_MODAL_Z && modalZ > AIH_POPUP_Z,
    `modale au-dessus de la couche popup (z=${modalZ} > ${AIH_POPUP_Z})`);
assert.ok(overlayEl && zOf(overlayEl) === modalZ,
    "l'overlay de la modale partage le z de la racine");

/* ── 4. Dialogue NON-modal : reste sous la couche popup ─────────────────── */
const dlg = D.open({ title: "Non modale", content: "y" }); // modal défaut = false
assert.ok(zOf(dlg.el) < AIH_POPUP_Z, `dialogue non-modal sous la couche popup (z=${zOf(dlg.el)})`);

/* ── 5. Un panneau créé APRÈS la modale ne la dépasse pas ───────────────── */
const latePanel = HolafPanelManager.createPanel({
    id: "late", title: "Late",
    defaultSize: { width: 120, height: 80 },
    defaultPosition: { x: 5, y: 5 },
});
assert.ok(zOf(latePanel.panelEl) < AIH_MODAL_Z,
    `panneau tardif sous la bande modale (z=${zOf(latePanel.panelEl)} < ${AIH_MODAL_Z})`);

/* ── 6. Empilement de deux modales (dernière au premier plan) ───────────── */
const modal2 = D.open({ title: "Modale 2", content: "z", modal: true });
assert.ok(zOf(modal2.el) >= modalZ, `2e modale au niveau ou au-dessus de la 1re (${zOf(modal2.el)} >= ${modalZ})`);
modal2.close();

/* ── 7. Le gestionnaire reste cohérent ──────────────────────────────────── */
assert.ok(aihWindowManager().counter >= 1, "compteur de bande fenêtres toujours actif");
assert.ok(aihWindowManager().size >= 3, "fenêtres enregistrées dans le gestionnaire commun");

console.log("✅ Bandes de z-index : menu popup > panneaux, modales > menu, toasts > modales");
