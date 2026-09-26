// Test de régression — grille virtualisée du pack (brique HolafGrid VENDUE).
// Usage : node js/test_iv_gallery_grid.mjs
//
// La galerie du node (js/image_viewer/image_viewer_gallery.js) délègue layout,
// pool, resize, sélection et scroll à js/vendor/holaf/holaf-virtual-grid.js.
// Ce test rejoue le CONTRAT d'adaptation du pack (cell renderer icône/checkbox,
// actions, onVisibleRange, sélection) contre la copie VENDUE, et prouve la
// non-régression UX attendue :
//   1. rendu virtualisé (borné, pas un élément par image) ;
//   2. sélection shift (plage) / ctrl (toggle) ;
//   3. double-clic → onActivate(..., 'dblclick') et clic action → onAction ;
//   4. clavier ←/→/↓ + Espace = toggle de sélection ;
//   5. resize conserve la rangée du haut ;
//   6. destroy retire la racine et les listeners.
//
// jsdom est résolu par le loader partagé ; introuvable = SKIP bruyant (exit 2).
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_iv_gallery_grid");

const dom = new JSDOM(`<!doctype html><html><body><div id="holaf-viewer-gallery"></div></body></html>`, {
    pretendToBeVisual: true,
    url: "http://localhost/",
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.MouseEvent = window.MouseEvent;
globalThis.KeyboardEvent = window.KeyboardEvent;

const { HolafGrid } = await import("./vendor/holaf/holaf-virtual-grid.js");

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

// ── Conteneur scrollable de géométrie connue (jsdom renvoie 0 par défaut) ──
const container = document.getElementById("holaf-viewer-gallery");
let cw = 400, ch = 300, st = 0;
Object.defineProperty(container, "clientWidth", { configurable: true, get: () => cw });
Object.defineProperty(container, "clientHeight", { configurable: true, get: () => ch });
Object.defineProperty(container, "scrollTop", {
    configurable: true, get: () => st, set: (v) => { st = Math.max(0, v); },
});
container.getBoundingClientRect = () => ({ left: 0, top: 0, right: cw, bottom: ch, width: cw, height: ch, x: 0, y: 0, toJSON() {} });

// ── Cell renderer « galerie du node » : placeholder + icône action + checkbox ──
const calls = { create: 0, update: 0, release: 0 };
let lastAction = null, lastActivate = null;
const cell = {
    create() {
        calls.create++;
        const el = document.createElement("div");
        el.className = "holaf-viewer-thumbnail-placeholder";
        const ai = document.createElement("div");
        ai.className = "holaf-viewer-edit-icon";
        ai.setAttribute("data-holaf-action", "zoom");
        el._actionIcon = ai;
        el.appendChild(ai);
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "holaf-viewer-thumb-checkbox";
        el._checkbox = cb;
        el.appendChild(cb);
        return el;
    },
    update(el, item) {
        calls.update++;
        el.dataset.pathCanon = item.path_canon;
    },
    release() { calls.release++; },
};

const items = [];
for (let i = 0; i < 1000; i++) items.push({ path_canon: "p" + i, format: "PNG" });

const grid = HolafGrid.create(container, {
    itemSize: 100,
    gap: 0,
    aspect: 1,
    getId: (it) => it.path_canon,
    css: { injectStyles: false },
    cell,
    activateOnClick: true,
    onActivate: (it, idx, kind) => { lastActivate = { id: it.path_canon, idx, kind }; },
    onAction: (actionId, it, idx) => { lastAction = { actionId, id: it.path_canon, idx }; },
});
grid.setItems(items);

const cellEl = (i) => grid.surface.querySelector(`[data-holaf-index="${i}"]`);
const click = (el, mods = {}) => el.dispatchEvent(new window.MouseEvent("click", {
    bubbles: true, shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl,
}));

/* ─── 1. Rendu virtualisé ──────────────────────────────────────────────── */
console.log("1. Rendu virtualisé");
assert.strictEqual(grid.getColumnCount(), 4, "400px / 100px = 4 colonnes");
assert.ok(grid.surface.children.length > 0, "des cellules sont rendues");
assert.ok(grid.surface.children.length < 80, `rendu borné (< 80), pas 1000 (=${grid.surface.children.length})`);
assert.ok(cellEl(0) && cellEl(0).dataset.pathCanon === "p0", "cellule 0 liée au bon item");
ok("fenêtre bornée + liaison des cellules");

/* ─── 2. Sélection shift / ctrl ────────────────────────────────────────── */
console.log("2. Sélection shift / ctrl");
click(cellEl(2));
assert.deepStrictEqual(grid.selection.ids(), ["p2"], "clic simple = mono");
click(cellEl(4), { ctrl: true });
assert.deepStrictEqual(grid.selection.ids().sort(), ["p2", "p4"], "ctrl = toggle (ajout)");
click(cellEl(4), { ctrl: true });
assert.deepStrictEqual(grid.selection.ids(), ["p2"], "ctrl = toggle (retrait)");
click(cellEl(2)); // re-ancre sur 2 (le ctrl-toggle avait déplacé l'ancre)
click(cellEl(6), { shift: true });
assert.deepStrictEqual(grid.selection.ids(), ["p2", "p3", "p4", "p5", "p6"], "shift = plage depuis l'ancre");
ok("mono / ctrl-toggle / shift-plage");

/* ─── 3. Double-clic → onActivate ; clic action → onAction ─────────────── */
console.log("3. Activation & actions");
cellEl(3).dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
assert.deepStrictEqual(lastActivate, { id: "p3", idx: 3, kind: "dblclick" }, "dblclick → zoom (onActivate)");
cellEl(1).querySelector('[data-holaf-action="zoom"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
assert.deepStrictEqual(lastAction, { actionId: "zoom", id: "p1", idx: 1 }, "clic icône → onAction (sans sélection)");
assert.ok(!grid.selection.ids().includes("p1"), "un clic sur une action ne sélectionne pas");
ok("double-clic → zoom, icône → action");

/* ─── 4. Clavier : flèches + Espace ────────────────────────────────────── */
console.log("4. Navigation clavier");
const key = (k) => { const e = new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }); return grid.selection.handleKey(e); };
grid.selection.set([], { silent: true });
click(cellEl(2));                 // actif = 2
assert.strictEqual(key("ArrowRight"), true, "ArrowRight consommée");
assert.strictEqual(grid.selection.anchor(), 3, "→ avance de +1");
key("ArrowDown");
assert.strictEqual(grid.selection.anchor(), 3 + grid.getColumnCount(), "↓ avance d'une rangée (ancre)");
click(cellEl(2));                 // actif = 2, sélection {p2}
key(" ");                         // Espace = toggle de l'actif
assert.ok(!grid.selection.ids().includes("p2"), "Espace retire l'actif de la sélection");
key(" ");
assert.ok(grid.selection.ids().includes("p2"), "Espace le remet");
key("Home");
assert.strictEqual(grid.selection.anchor(), 0, "Home → premier");
key("End");
assert.strictEqual(grid.selection.anchor(), 999, "End → dernier");
ok("flèches / Home / End / Espace");

/* ─── 5. Resize conserve la rangée du haut ─────────────────────────────── */
console.log("5. Resize");
st = 250;                          // rangée 2 (hauteur 100) → topIndex 8
cw = 200;                          // reflow → 2 colonnes
grid._handleResize();
assert.strictEqual(grid.getColumnCount(), 2, "recalcul des colonnes");
assert.strictEqual(st, 400, "rangée du haut conservée (floor(8/2)*100 = 400)");
ok("resize → ancrage de la rangée");

/* ─── 6. destroy ───────────────────────────────────────────────────────── */
console.log("6. destroy");
grid.destroy();
assert.strictEqual(container.querySelector(".holaf-grid-root"), null, "racine retirée");
assert.ok(calls.release > 0, "les cellules ont été relâchées");
let threw = false;
try { container.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); } catch { threw = true; }
assert.strictEqual(threw, false, "plus de listener après destroy");
ok("destroy : racine retirée, listeners coupés");

console.log(`\n✅ Test grille virtualisée du pack (HolafGrid vendue) : ${n} groupes PASSENT`);
