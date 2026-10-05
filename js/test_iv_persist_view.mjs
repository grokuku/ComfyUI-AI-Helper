// Test — persistance LOCALE de l'état de travail de la galerie du pack.
// Usage : node js/test_iv_persist_view.mjs
//
// Verrouille la demande « garder l'état de la galerie quand on la ferme » :
//   - ce qui est DÉJÀ persisté côté backend (source/filtres/tri/taille) n'est
//     PAS redoublé ici ; on ne mémorise QUE défilement + élément actif ;
//   - stockage localStorage, PAR SOURCE (local ↔ serveur) : revenir sur une
//     source restaure SA vue, jamais celle de l'autre ;
//   - valeurs invalides/obsolètes → dégradation propre (scrollTop 0, aucun
//     élément actif, pas de throw) ;
//   - capture/restore réels (DOM + state).
//
// Contrôles négatifs par mutation (l'assertion échoue si on retire la logique) :
//   M1 retirer la clé par source → l'isolation local/remote casse ;
//   M2 retirer la normalisation → les valeurs invalides fuient telles quelles ;
//   M3 retirer le filtre « activePath retrouvé » → un actif obsolète serait posé.
//
// jsdom est résolu par le loader partagé ; introuvable = SKIP bruyant (exit 2).
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_iv_persist_view");

const dom = new JSDOM(`<!doctype html><html><body><div id="holaf-viewer-gallery"></div></body></html>`, {
    url: "http://localhost/",
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.localStorage = window.localStorage;

const persist = await import("./image_viewer/image_viewer_persist.js");
const { imageViewerState } = await import("./image_viewer/image_viewer_state.js");
const { GallerySource } = await import("./image_viewer/image_viewer_source.js");

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

const KEY = persist.STORAGE_KEY;
const mem = () => localStorage.getItem(KEY);

/* ── 1. Normalisation (PUR) ─────────────────────────────────────────────── */
console.log("1. normalizePersistedView");
assert.deepStrictEqual(
    persist.normalizePersistedView({ scrollTop: -12, activePath: 42, navIndex: 1.5 }),
    { scrollTop: 0, activePath: null, navIndex: -1 },
    "valeurs invalides → défauts (M2 : sans normalisation, elles fuient)");
assert.deepStrictEqual(
    persist.normalizePersistedView({ scrollTop: "340.9", activePath: "p12", navIndex: 3 }),
    { scrollTop: 340, activePath: "p12", navIndex: 3 },
    "valeurs valides converties/rognées");
assert.deepStrictEqual(
    persist.normalizePersistedView(null),
    { scrollTop: 0, activePath: null, navIndex: -1 },
    "entrée absente → défauts");
ok("normalisation stricte (scrollTop/navIndex/activePath)");

/* ── 2. Save / load PAR SOURCE ──────────────────────────────────────────── */
console.log("2. saveGalleryView / loadGalleryView — portée par source");
persist.saveGalleryView("local", { scrollTop: 800, activePath: "out/a.png", navIndex: 7 });
persist.saveGalleryView("remote", { scrollTop: 120, activePath: "srv:5", navIndex: 1 });
assert.deepStrictEqual(persist.loadGalleryView("local"),
    { scrollTop: 800, activePath: "out/a.png", navIndex: 7 });
assert.deepStrictEqual(persist.loadGalleryView("remote"),
    { scrollTop: 120, activePath: "srv:5", navIndex: 1 });
assert.notDeepStrictEqual(persist.loadGalleryView("local"), persist.loadGalleryView("remote"),
    "M1 : retirer la clé par source ferait fuir la vue local dans remote");
assert.strictEqual(persist.loadGalleryView("inconnu"), null, "source jamais vue → null");
ok("deux sources → deux vues indépendantes");

// Un état « vide » ne fige rien (l'entrée est retirée).
persist.saveGalleryView("local", { scrollTop: 0, activePath: null, navIndex: -1 });
assert.strictEqual(persist.loadGalleryView("local"), null, "état vide → entrée supprimée");
ok("état vide → pas d'entrée persistée");

// Tolérance JSON corrompu.
localStorage.setItem(KEY, "{pas du json");
assert.strictEqual(persist.loadGalleryView("remote"), null, "JSON corrompu → null, jamais throw");
localStorage.removeItem(KEY);
ok("JSON corrompu toléré");

/* ── 3. Capture / restore réels (DOM + state) ───────────────────────────── */
console.log("3. captureGalleryView / restoreGalleryView");
const el = document.getElementById("holaf-viewer-gallery");
el.scrollTop = 640;

GallerySource.setActive("local");
imageViewerState.setState({
    images: [{ path_canon: "p0" }, { path_canon: "p1" }],
    activeImage: { path_canon: "p1" },
    currentNavIndex: 1,
});
persist.captureGalleryView();
assert.deepStrictEqual(persist.loadGalleryView("local"),
    { scrollTop: 640, activePath: "p1", navIndex: 1 },
    "capture lit le DOM (scroll) + le state (actif)");

// Reconstituer un état « neuf » (comme après un rechargement de page).
el.scrollTop = 0;
imageViewerState.setState({ activeImage: null, currentNavIndex: -1 });
persist.restoreGalleryView();
assert.strictEqual(el.scrollTop, 640, "restore réapplique la position de défilement");
const restored = imageViewerState.getState();
assert.strictEqual(restored.activeImage && restored.activeImage.path_canon, "p1");
assert.strictEqual(restored.currentNavIndex, 1);
ok("restore réapplique défilement + élément actif");

// Dégradation : l'élément actif mémorisé n'existe plus → aucun actif posé.
persist.saveGalleryView("local", { scrollTop: 300, activePath: "disparu.png", navIndex: 4 });
imageViewerState.setState({ images: [{ path_canon: "p0" }], activeImage: null, currentNavIndex: -1 });
persist.restoreGalleryView();
assert.strictEqual(imageViewerState.getState().activeImage, null,
    "M3 : un activePath obsolète ne doit PAS devenir actif");
assert.strictEqual(el.scrollTop, 300, "le défilement reste restauré même si l'actif a disparu");
ok("dégradation propre sur élément obsolète");

/* ── 4. Isolation par source au moment du switch ─────────────────────────── */
console.log("4. capture par source au re-câblage (simulé)");
// Provider « remote » FACTICE : suffit pour la portée de stockage par source.
GallerySource.register("remote", { id: "remote", label: "Server" });
persist.saveGalleryView("local", { scrollTop: 900, activePath: "a", navIndex: 0 });
persist.saveGalleryView("remote", { scrollTop: 50, activePath: "srv:1", navIndex: 0 });
GallerySource.setActive("remote");
imageViewerState.setState({ images: [{ path_canon: "srv:1" }], activeImage: null, currentNavIndex: -1 });
el.scrollTop = 0;
persist.restoreGalleryView();
assert.strictEqual(el.scrollTop, 50, "source remote → sa position (pas celle du local)");
GallerySource.setActive("local");
imageViewerState.setState({ images: [{ path_canon: "a" }], activeImage: null, currentNavIndex: -1 });
el.scrollTop = 0;
persist.restoreGalleryView();
assert.strictEqual(el.scrollTop, 900, "retour source local → sa position");
ok("revenir sur une source restaure SA vue");

console.log(`\n${n} vérifications — PASS`);
