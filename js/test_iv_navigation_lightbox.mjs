// Test de NON-RÉGRESSION — visionneuse de la galerie du node, déléguée à la
// brique HolafLightbox VENDUE (js/vendor/holaf/holaf-lightbox.js).
// Usage : node js/test_iv_navigation_lightbox.mjs
//
// image_viewer_navigation.js ne porte plus la machine à états/navigation/clavier
// de la visionneuse : elle devient un ADAPTATEUR qui injecte dans la brique la
// source d'items, le renderer média (_updateMediaSource), les conteneurs
// (zoom/fullscreen), le viewport (HolafViewport) et le garde-fou clavier.
// Ce test rejoue le contrat d'adaptation et prouve la non-régression UX :
//   1. ouverture zoom (vue affichée, galerie masquée, mode 'zoom') ;
//   2. préchargement de l'item suivant ;
//   3. navigation ‹/› + wrap-around ;
//   4. navigation grille ↑/↓ (±colonnes) ;
//   5. ouverture fullscreen DEPUIS zoom puis Échap → restauration de la vue
//      source (zoom) ;
//   6. Échap depuis zoom → retour galerie ;
//   7. garde clavier : aucune capture quand un champ a le focus ;
//   8. clavier visionneuse (flèche) actif sinon.
//
// jsdom est résolu par le loader partagé ; introuvable = SKIP bruyant (exit 2).
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_iv_navigation_lightbox");

const dom = new JSDOM(`<!doctype html><html><body>
  <div id="holaf-viewer-gallery"></div>
  <div id="holaf-viewer-zoom-view" style="display:none;">
    <img src="" draggable="false" />
    <video id="holaf-viewer-zoom-video" style="display:none;"></video>
  </div>
  <div id="holaf-viewer-fullscreen-overlay" style="display:none;">
    <img src="" draggable="false" />
    <video id="holaf-viewer-fs-video" style="display:none;"></video>
  </div>
</body></html>`, { pretendToBeVisual: true, url: "http://localhost/" });

const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.CustomEvent = window.CustomEvent;
globalThis.ResizeObserver = window.ResizeObserver;
globalThis.MouseEvent = window.MouseEvent;
globalThis.KeyboardEvent = window.KeyboardEvent;
window.AIH = window.AIH || {};
window.AIH.I18n = { t: (k) => k };
globalThis.AIH = window.AIH;

// Image stub : capture les src (préchargement + loader) sans réseau.
const preloaded = [];
class FakeImage {
    constructor() { this.onload = null; this.onerror = null; this._src = ""; }
    set src(v) { this._src = v; preloaded.push(v); }
    get src() { return this._src; }
}
globalThis.Image = FakeImage;
window.Image = FakeImage;

// jsdom n'implémente pas play()/pause() → on les neutralise (bruit console).
if (window.HTMLMediaElement) {
    window.HTMLMediaElement.prototype.pause = function () {};
    window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
}

const Nav = await import("./image_viewer/image_viewer_navigation.js");
const { imageViewerState } = await import("./image_viewer/image_viewer_state.js");

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

// ─── Items (10 images PNG) ───────────────────────────────────────────────
const items = [];
for (let i = 0; i < 10; i++) {
    items.push({ path_canon: "p" + i, filename: "f" + i + ".png", subfolder: "", mtime: 1000 + i, format: "PNG" });
}
imageViewerState.setState({
    images: items,
    totalCount: items.length,
    currentNavIndex: 0,
    activeImage: items[0],
    ui: { view_mode: "gallery" },
});

const zoomView = document.getElementById("holaf-viewer-zoom-view");
const fsOverlay = document.getElementById("holaf-viewer-fullscreen-overlay");
const galleryEl = document.getElementById("holaf-viewer-gallery");

// ─── Viewer factice (contrat minimal consommé par navigation.js) ─────────
const viewer = {
    panelElements: { panelEl: document.createElement("div") },
    elements: { zoomVideo: document.getElementById("holaf-viewer-zoom-video") },
    fullscreenElements: {
        overlay: fsOverlay,
        img: fsOverlay.querySelector("img"),
        video: fsOverlay.querySelector("video"),
    },
    zoomViewState: {},
    fullscreenViewState: {},
    editor: null,
    gallery: {
        render() {},
        ensureImageVisible() {},
        alignImageOnExit() {},
        getColumnCount() { return 3; },
        ensureImageLoaded(i) { return Promise.resolve(items[i] || null); },
    },
};
viewer.panelElements.panelEl.style.display = "flex";
document.body.appendChild(viewer.panelElements.panelEl);

// Déclaration des vues (comme le font l'UI et l'entry à l'init).
Nav.setupZoomAndPan(viewer.zoomViewState, zoomView, zoomView.querySelector("img"));
Nav.setupZoomAndPan(viewer.fullscreenViewState, fsOverlay, fsOverlay.querySelector("img"));

// ─── 1. Ouverture zoom ───────────────────────────────────────────────────
await Nav.showZoomedView(viewer, items[0]);
await flush();
assert.equal(zoomView.style.display, "flex", "zoom affiché");
assert.equal(galleryEl.style.display, "none", "galerie masquée");
assert.equal(imageViewerState.getState().ui.view_mode, "zoom", "mode zoom");
assert.ok(viewer.zoomViewState.viewport, "viewport créé pour la vue zoom");
ok("ouverture zoom (vue affichée, galerie masquée, viewport injecté)");

// ─── 2. Préchargement du suivant ─────────────────────────────────────────
assert.ok(preloaded.some((u) => u.includes("path_canon=p1")), "item suivant préchargé");
ok("préchargement de l'item suivant");

// ─── 3. Navigation ‹/› + wrap-around ─────────────────────────────────────
imageViewerState.setState({ currentNavIndex: 0 });
await Nav.navigate(viewer, 1);
await flush();
assert.equal(imageViewerState.getState().currentNavIndex, 1, "navigate +1");
imageViewerState.setState({ currentNavIndex: 0 });
await Nav.navigate(viewer, -1);
await flush();
assert.equal(imageViewerState.getState().currentNavIndex, 9, "wrap -1 → dernier");
ok("navigation ‹/› + wrap-around");

// ─── 4. Navigation grille ↑/↓ (±colonnes) ────────────────────────────────
imageViewerState.setState({ currentNavIndex: 0 });
await Nav.navigateGrid(viewer, 1);
await flush();
assert.equal(imageViewerState.getState().currentNavIndex, 3, "grille +1 colonne (×3)");
ok("navigation grille ↑/↓ (±colonnes)");

// ─── 5. Fullscreen depuis zoom, Échap restaure la vue source ─────────────
await Nav.showFullscreenView(viewer, items[0]);
await flush();
assert.equal(fsOverlay.style.display, "flex", "fullscreen affiché");
assert.equal(zoomView.style.display, "none", "zoom masqué sous fullscreen");
await Nav.handleEscape(viewer);
await flush();
assert.equal(fsOverlay.style.display, "none", "fullscreen masqué");
assert.equal(zoomView.style.display, "flex", "zoom restauré (vue source)");
assert.equal(imageViewerState.getState().ui.view_mode, "zoom", "mode zoom restauré");
ok("Échap restaure la vue source (fullscreen → zoom)");

// ─── 6. Échap depuis zoom → galerie ──────────────────────────────────────
await Nav.handleEscape(viewer);
await flush();
assert.equal(zoomView.style.display, "none", "zoom fermé");
assert.equal(galleryEl.style.display, "flex", "galerie restaurée");
assert.equal(imageViewerState.getState().ui.view_mode, "gallery", "mode gallery");
ok("Échap ferme le zoom → retour galerie");

// ─── 7. Garde clavier : champ focus → pas de capture ─────────────────────
imageViewerState.setState({ currentNavIndex: 2 });
await Nav.handleKeyDown(viewer, { key: "ArrowRight", target: { tagName: "INPUT" }, preventDefault() {} });
await flush();
assert.equal(imageViewerState.getState().currentNavIndex, 2, "flèche bloquée sur champ focus");
ok("garde clavier (aucune capture quand un champ a le focus)");

// ─── 8. Clavier visionneuse actif (hors champ) ───────────────────────────
await Nav.handleKeyDown(viewer, { key: "ArrowRight", target: { tagName: "BODY" }, preventDefault() {} });
await flush();
assert.equal(imageViewerState.getState().currentNavIndex, 3, "flèche navigue hors champ");
ok("clavier visionneuse actif (flèche → navigation)");

console.log(`\n✅ Test non-régression visionneuse (HolafLightbox) : ${n} groupes PASS`);
process.exit(0);
