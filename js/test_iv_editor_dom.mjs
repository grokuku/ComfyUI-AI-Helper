// Tests jsdom du front de l'éditeur v2 :
//   - rendu d'une ligne zonale : 4 sliders étiquetés + pastilles des SEULES
//     bandes ≠ neutre (ligne repliée) ;
//   - double-clic = reset du slider CIBLÉ (et pas des autres bandes) ;
//   - picker V4 master-detail : clic famille + clic contrôle = ajout direct
//     (UNE seule boîte de dialogue, plus d'étape « plage ») ;
//   - mémorisation de la dernière famille + navigation clavier (↑↓ / ↵).
//
// jsdom est résolu par le loader partagé js/test_helpers/jsdom_loader.mjs ;
// introuvable = SKIP bruyant (exit 2), jamais compté PASS.
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_iv_editor_dom");

const dom = new JSDOM(`<!doctype html><html><body>
  <div id="holaf-viewer-zoom-view"></div>
  <div id="holaf-viewer-right-column"></div>
</body></html>`, { pretendToBeVisual: true, url: "http://localhost/" });

const { window } = dom;
const { document } = window;
globalThis.window = window;
globalThis.document = document;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.Image = window.Image;
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.CustomEvent = window.CustomEvent;
globalThis.ResizeObserver = window.ResizeObserver;
globalThis.MouseEvent = window.MouseEvent;

// AIH.Dialog stub : reproduit le contrat minimal utilisé par _pickFromList
// (open → content(body) → { el, close }), sans fenêtre réelle.
const openedDialogs = [];
window.AIH = window.AIH || {};
const dialogStub = {
    open(opts) {
        const el = document.createElement("div");
        const body = document.createElement("div");
        el.appendChild(body);
        document.body.appendChild(el);
        if (typeof opts.content === "function") opts.content(body);
        let closed = false;
        const api = {
            el, body, opts,
            close(value) {
                if (closed) return;
                closed = true;
                el.remove();
                if (typeof opts._onResolve === "function") opts._onResolve(value);
            },
        };
        openedDialogs.push(api);
        return api;
    },
};
window.AIH.Dialog = dialogStub;

const { ImageEditor } = await import("./image_viewer/image_viewer_editor.js");
window.AIH.I18n = window.AIH.I18n || { t: (k) => k };
globalThis.AIH = window.AIH; // les modules référencent AIH (global) ET window.AIH

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const dblclick = (el) => el.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
const key = (el, k) => el.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

const viewer = { gallery: null, zoomViewState: null, elements: {} };
const ed = new ImageEditor(viewer);
ed.createPanel();
assert.ok(ed.panelEl, "panneau éditeur créé");

/* ─── 1. Ligne zonale dépliée = 4 sliders ──────────────────────────────── */
console.log("1. Ligne de contrôle zonale");

ed.currentState = {
    v: 2,
    controls: [{ id: "c_1", type: "brightness", zones: { all: 1.2, shadows: 1.5, midtones: 1, highlights: 1 } }],
    targetFps: null, playbackRate: 1, interpolate: false, crop: null,
};
ed._expandedCtrlId = "c_1";
ed._renderControlsList();

const list = document.getElementById("holaf-editor-controls-list");
const zonal = list.querySelector('[data-ctrl-id="c_1"]');
assert.ok(zonal.classList.contains("holaf-editor-zonal"), "classe zonal posée");
const rows = zonal.querySelectorAll(".holaf-editor-zone-row");
assert.strictEqual(rows.length, 4, "4 lignes de bande");
assert.deepStrictEqual(
    Array.from(zonal.querySelectorAll("input[data-zone]")).map((i) => i.dataset.zone),
    ["all", "shadows", "midtones", "highlights"],
    "4 sliders data-zone (all/shadows/midtones/highlights)"
);
// Les labels des bandes sont affichés.
assert.strictEqual(zonal.querySelectorAll(".holaf-editor-zone-label").length, 4, "4 labels de bande");
// Colonne étroite (58px) : libellé COURT affiché, forme LONGUE en `title`.
// On compare aux traductions réellement chargées (la langue dépend de
// navigator.language) plutôt qu'à des chaînes en dur.
const tkey = (k) => window.AIH.I18n.t(k);
const zoneLabels = Array.from(zonal.querySelectorAll(".holaf-editor-zone-label"));
assert.deepStrictEqual(
    zoneLabels.map((el) => el.textContent),
    ["iv.zoneShortAll", "iv.zoneShortShadows", "iv.zoneShortMidtones", "iv.zoneShortHighlights"].map(tkey),
    "libellés courts affichés"
);
assert.deepStrictEqual(
    zoneLabels.map((el) => el.getAttribute("title")),
    ["iv.all", "iv.shadows", "iv.midtones", "iv.highlights"].map(tkey),
    "formes longues en title (tooltip)"
);
// Le libellé court diffère bien du long pour les bandes tronquées.
assert.notStrictEqual(tkey("iv.zoneShortMidtones"), tkey("iv.midtones"), "midtones court ≠ long");
assert.notStrictEqual(tkey("iv.zoneShortHighlights"), tkey("iv.highlights"), "highlights court ≠ long");
// Contrainte : chaque input range + valeur reste dans un .holaf-editor-slider-container.
assert.strictEqual(zonal.querySelectorAll(".holaf-editor-slider-container input[type=range]").length, 4);
assert.strictEqual(zonal.querySelectorAll(".holaf-editor-slider-value").length, 4);
ok("déplié : 4 sliders (Tout/Ombres/Tons/Hautes) + tooltips longs (iv.all/iv.shadows/…)");

/* ─── 2. Ligne repliée = pastilles des bandes ≠ neutre ─────────────────── */
console.log("2. Ligne repliée");

ed._expandedCtrlId = null;
ed._renderControlsList();
const collapsed = list.querySelector('[data-ctrl-id="c_1"]');
const pills = collapsed.querySelectorAll(".holaf-editor-zone-pill");
assert.strictEqual(pills.length, 2, "2 pastilles (all + shadows non neutres)");
assert.deepStrictEqual(Array.from(pills).map((p) => p.dataset.zone), ["all", "shadows"], "seules les bandes ≠ neutre");
assert.strictEqual(collapsed.querySelectorAll(".holaf-editor-zone-row").length, 0, "aucun slider en replié");
ok("replié : nom + pastilles des SEULES bandes ≠ neutre (all, shadows)");

// Un contrôle entièrement neutre n'affiche aucune pastille (placeholder —).
ed.currentState.controls = [{ id: "c_2", type: "contrast", zones: { all: 1, shadows: 1, midtones: 1, highlights: 1 } }];
ed._expandedCtrlId = null;
ed._renderControlsList();
assert.strictEqual(list.querySelectorAll('[data-ctrl-id="c_2"] .holaf-editor-zone-pill').length, 0, "neutre → 0 pastille");
ok("contrôle neutre : aucune pastille");

/* ─── 3. Double-clic = reset du slider CIBLÉ ───────────────────────────── */
console.log("3. Double-clic = reset de la bande ciblée");

ed.currentState.controls = [{ id: "c_1", type: "brightness", zones: { all: 1.2, shadows: 1.5, midtones: 1.1, highlights: 1.3 } }];
ed._expandedCtrlId = "c_1";
ed._renderControlsList();
const ctrlRef = ed.currentState.controls[0];
const shadowsInput = list.querySelector('[data-ctrl-id="c_1"] input[data-zone="shadows"]');
dblclick(shadowsInput);
assert.strictEqual(ctrlRef.zones.shadows, 1, "shadows reset à la valeur neutre (1)");
assert.strictEqual(ctrlRef.zones.all, 1.2, "all NON touché");
assert.strictEqual(ctrlRef.zones.midtones, 1.1, "midtones NON touché");
assert.strictEqual(ctrlRef.zones.highlights, 1.3, "highlights NON touché");
ok("double-clic sur shadows → seul shadows reset (1), les autres bandes intactes");

// Non zonal : double-clic reset la value.
ed.currentState.controls = [{ id: "c_9", type: "blur", value: 20 }];
ed._expandedCtrlId = "c_9";
ed._renderControlsList();
const blurInput = list.querySelector('[data-ctrl-id="c_9"] input[type=range]');
dblclick(blurInput);
assert.strictEqual(ed.currentState.controls[0].value, 8, "blur reset à son défaut (8)");
ok("non zonal : double-clic reset la value au défaut");

/* ─── 4. Picker V4 : ajout direct (pas d'étape plage) ──────────────────── */
console.log("4. Picker V4 master-detail");

ed.currentState = { v: 2, controls: [], targetFps: null, playbackRate: 1, interpolate: false, crop: null };
ed._lastPickerFamily = null;
const addBtn = document.getElementById("holaf-editor-add-btn");

const dialogsBefore = openedDialogs.length;
const flow1 = addBtn.onclick();
assert.strictEqual(openedDialogs.length, dialogsBefore + 1, "une seule boîte ouverte");
let dlg = openedDialogs[openedDialogs.length - 1];
// Master-detail : familles + contrôles, et pas de choix de plage.
assert.ok(dlg.el.querySelector(".aih-picker-families"), "colonne familles présente");
assert.ok(dlg.el.querySelector(".aih-picker-controls"), "colonne contrôles présente");
assert.strictEqual(dlg.el.querySelectorAll(".aih-picker-family").length, 5, "5 familles");
assert.ok(dlg.el.querySelector(".aih-picker-family-count").textContent === "1", "compteur famille affiché");
assert.ok(!dlg.el.querySelector('[data-pick="all"]') && !dlg.el.querySelector('[data-pick="shadows"]'), "aucun item de plage");
ok("picker : master-detail (5 familles + compteurs), aucune étape plage");

// Basculer vers « basic » (clic famille) puis ajouter brightness (clic contrôle).
click(dlg.el.querySelector('[data-family="basic"]'));
assert.ok(dlg.el.querySelector('.aih-picker-family[data-family="basic"]').classList.contains("active"), "famille active = basic");
assert.ok(dlg.el.querySelector('[data-pick="brightness"]'), "contrôles de basic affichés");
click(dlg.el.querySelector('[data-pick="brightness"]'));
await flow1;
assert.strictEqual(openedDialogs.length, dialogsBefore + 1, "toujours UNE seule boîte (pas de 2e picker plage)");
assert.strictEqual(ed.currentState.controls.length, 1, "un contrôle ajouté");
assert.deepStrictEqual(ed.currentState.controls[0].zones, { all: 1, shadows: 1, midtones: 1, highlights: 1 }, "contrôle zonaux à bandes neutres");
assert.ok(!("value" in ed.currentState.controls[0]) && !("range" in ed.currentState.controls[0]), "ni value ni range");
ok("clic contrôle → ajout direct d'un contrôle zonaux (zones neutres, pas de value/range)");

/* ─── 5. Mémorisation de la dernière famille ───────────────────────────── */
console.log("5. Mémorisation de la famille");

assert.strictEqual(ed._lastPickerFamily, "basic", "dernière famille mémorisée");
const flow2 = addBtn.onclick();
dlg = openedDialogs[openedDialogs.length - 1];
assert.ok(dlg.el.querySelector('.aih-picker-family[data-family="basic"]').classList.contains("active"), "réouverture sur basic");
// Échap simulé : fermeture sans ajout.
dlg.close(null);
await flow2;
assert.strictEqual(ed.currentState.controls.length, 1, "aucun contrôle ajouté après annulation");
ok("réouverture sur la dernière famille + annulation sans effet");

/* ─── 6. Navigation clavier du picker ──────────────────────────────────── */
console.log("6. Navigation clavier");

ed._lastPickerFamily = null;
const flow3 = addBtn.onclick();
dlg = openedDialogs[openedDialogs.length - 1];
const activeFamily = () => dlg.el.querySelector(".aih-picker-family.active").dataset.family;
const firstFamily = activeFamily();
key(dlg.el.querySelector(`.aih-picker-family[data-family="${firstFamily}"]`), "ArrowDown");
assert.notStrictEqual(activeFamily(), firstFamily, "↑↓ change la famille active");
// → focus le premier contrôle, ↵ l'ajoute.
key(dlg.el.querySelector(".aih-picker-family.active"), "ArrowRight");
const focusedItem = document.activeElement;
assert.ok(focusedItem && focusedItem.classList.contains("aih-picker-item"), "→ place le focus sur un contrôle");
key(focusedItem, "Enter");
await flow3;
assert.strictEqual(ed.currentState.controls.length, 2, "↵ ajoute le contrôle focalisé");
ok("clavier : ↑↓ (familles), → (contrôle), ↵ (ajout)");

console.log(`\n✅ Test jsdom éditeur v2 : TOUS LES TESTS PASSENT (${n} assertions de groupe)`);
