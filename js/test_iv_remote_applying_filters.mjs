// Test de RÉGRESSION — galerie PACK, source « SERVEUR » bloquée sur
// « Application des filtres… » (iv.applyingFilters) : le chargement ne se
// terminait JAMAIS, aucune image, aucun message d'erreur.
// Usage : node js/test_iv_remote_applying_filters.mjs
//
// BUG RÉEL (juste après le correctif « galerie serveur vide ») : lors de la
// bascule vers la source « Serveur », le panneau affichait uniquement
// « Application des filtres... ». La requête de liste partait bien (correctif
// précédent) et se terminait (`isLoading` repassait à false), mais la zone de
// galerie restait sur le libellé de chargement.
//
// CAUSE : `holaf_image_viewer.js#setLoadingState()` faisait
// `galleryEl.innerHTML = '<p class="holaf-viewer-message">…</p>'`. Or la grille
// virtualisée (HolafGrid, brique vendor) a construit son `root`/`sizer`/
// `surface` DANS `#holaf-viewer-gallery` au moment de l'ouverture du panneau :
// le `innerHTML =` arrachait donc la grille du DOM. Ensuite `syncGallery()` ne
// la recréait pas (galleryEl non nul) et, sur le chemin « mêmes images »
// (state.images déjà remplacé avant l'appel), ne retirait que le placeholder
// « aucune image » — jamais `.holaf-viewer-message`. Résultat : libellé éternel.
//
// CE QUE CE TEST VERROUILLE (jsdom, fetch stubé, grille RÉELLE, volume 218) :
//   1. bascule local→remote avec panneau OUVERT (initGallery déjà appelée) :
//      la grille survit (même nœud root), les 218 médias sont chargés, les
//      cellules srv:<id> sont rendues, les vignettes blob+Bearer sont demandées,
//      le libellé de chargement est RETIRÉ et `isLoading` est false ;
//   2. non-ré-entrance : UN SEUL loadFilteredImages pour la bascule, aucun
//      rechargement en boucle pendant que le poll/état se stabilise ;
//   3. échec de VIGNETTE (500) : le chargement se termine quand même, la grille
//      reste dans le DOM, le libellé est retiré ;
//   4. erreur de LISTE (500) : le chargement se termine TOUJOURS, un message
//      d'erreur EXPLICITE est affiché, la grille n'est pas détruite ;
//   5. contrôle négatif : le libellé statique du template UI
//      (« iv.loadingImages ») est lui aussi nettoyé au premier rendu.
//
// Contrôles par MUTATION (prouvés en session) :
//   M1 remettre `g.innerHTML = '<p class="holaf-viewer-message">…</p>'` dans
//      setLoadingState → §1 et §3 rouges (root de grille détruit, libellé figé) ;
//   M2 retirer `clearLoadingState()` du début de syncGallery → §1 rouge
//      (libellé de chargement encore présent après succès).
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_iv_remote_applying_filters");

const dom = new JSDOM(
    `<!doctype html><html><body><div id="iv-ui-root"></div></body></html>`,
    { pretendToBeVisual: true, url: "http://localhost/" },
);
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
window.AIH = window.AIH || {};
window.AIH.I18n = { t: (k) => k };
globalThis.AIH = window.AIH;
// Empêche holaf_api_compat.js de poller window.comfyAPI pendant 5 s.
window.comfyAPI = {
    app: { app: { registerExtension() {} } },
    api: { api: { api_base: "/" } },
};
let objectUrls = 0;
globalThis.URL.createObjectURL = () => `blob:mock-${++objectUrls}`;
globalThis.URL.revokeObjectURL = () => {};

// ── Serveur factice : 218 items, vignettes blob, routes mutables ────────────
const captured = [];
let listStatus = 200;
let thumbStatus = 200;
let listIdBase = 0;
const jsonResponse = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const blobResponse = (status = 200) =>
    new Response(new Blob([new Uint8Array([1, 2, 3])]), { status, headers: { "content-type": "image/png" } });

const N = 218;
const ITEMS = Array.from({ length: N }, (_, i) => ({
    id: i + 1,
    filename: `img-${i + 1}.png`,
    subfolder: i % 3 === 0 ? "2026-09-27" : (i % 3 === 1 ? "2026-09-28" : "2026-09-30"),
    size: 1000 + i,
    kind: "image",
    created_at: `2026-09-28 10:${String(i % 60).padStart(2, "0")}:00`,
    status: "complete",
    trashed: 0,
    favorite: 0,
    tags: [],
    has_prompt: 0,
    has_workflow: 0,
}));

globalThis.fetch = async (url, init = {}) => {
    captured.push({ url: String(url), init });
    const u = String(url);
    if (u.includes("/holaf/utilities/settings")) return jsonResponse({ ImageViewerUI: {} });
    if (u.includes("/holaf/image-viewer/save-settings")) return jsonResponse({ status: "ok" });
    if (u.includes("/api/media/folders")) {
        return jsonResponse({
            folders: [
                { subfolder: "2026-09-27", count: 73 },
                { subfolder: "2026-09-28", count: 73 },
                { subfolder: "2026-09-30", count: 72 },
            ],
            total: N,
        });
    }
    if (u.includes("/api/media/tags")) return jsonResponse({ tags: [], total: 0 });
    if (u.includes("/thumbnail")) return blobResponse(thumbStatus);
    if (u.includes("/api/media?") || /\/api\/media$/.test(u)) {
        if (listStatus >= 400) return jsonResponse({ error: "boom" }, listStatus);
        const items = ITEMS.map((it) => (listIdBase ? { ...it, id: it.id + listIdBase } : it));
        return jsonResponse({ items, total: N, page: 1, limit: 200 });
    }
    throw new Error(`Unexpected fetch: ${u}`);
};
window.fetch = globalThis.fetch;

const SERVER_URL = "https://aih.example.com";
const API_KEY = "tok-applying-filters";
window.localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: SERVER_URL, apiKey: API_KEY }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Modules réels ───────────────────────────────────────────────────────────
const { imageViewerState } = await import("./image_viewer/image_viewer_state.js");
const { GallerySource } = await import("./image_viewer/image_viewer_source.js");
const { UI } = await import("./image_viewer/image_viewer_ui.js");
const { reconcileStoredSource, applySourceSwitch } = await import("./image_viewer/image_viewer_source_switch.js");
const { initGallery } = await import("./image_viewer/image_viewer_gallery.js");
const { default: viewerHost } = await import("./holaf_image_viewer.js");

viewerHost.updateStatusBar = () => {};
viewerHost._updateActionButtonsState = () => {};

UI.init(document.getElementById("iv-ui-root"), {
    getViewer: () => viewerHost,
    onFilterChange: () => viewerHost.triggerFilterChange(),
    onResetFilters: () => {},
});

const galleryEl = document.getElementById("holaf-viewer-gallery");
assert.ok(galleryEl, "le template UI a créé #holaf-viewer-gallery");
for (const [prop, val] of [["clientWidth", 1000], ["clientHeight", 700], ["scrollTop", 0]]) {
    Object.defineProperty(galleryEl, prop, { configurable: true, get: () => val });
}
galleryEl.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700, x: 0, y: 0, toJSON() {} });

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };
const srvListCalls = () => captured.filter((c) => { try { return new URL(c.url).pathname === "/api/media"; } catch (e) { return false; } });
const thumbCalls = () => captured.filter((c) => c.url.includes("/thumbnail"));
const loadingMsg = () => galleryEl.querySelector(".holaf-viewer-loading-message");
const gridRoot = () => galleryEl.querySelector(".holaf-grid-root");

// ── Ouverture du panneau : grille RÉELLE créée AVANT toute bascule ──────────
await viewerHost.loadSettings();
await reconcileStoredSource(viewerHost);
viewerHost.panelElements = { panelEl: { style: { display: "flex" } } };
initGallery(viewerHost);
const rootBefore = gridRoot();
assert.ok(rootBefore, "la grille réelle est en place avant la bascule");

/* ─── 1. Bascule local→remote : le chargement TERMINE, la grille survit ─── */
console.log("1. Bascule vers la source Serveur avec panneau ouvert (grille réelle)");
{
    captured.length = 0;
    let loadCalls = 0;
    const originalLoad = viewerHost.loadFilteredImages.bind(viewerHost);
    viewerHost.loadFilteredImages = function (...args) { loadCalls++; return originalLoad(...args); };

    const switched = await applySourceSwitch(viewerHost, "remote");
    assert.strictEqual(switched.ok, true, "bascule acceptée");
    assert.strictEqual(GallerySource.activeId(), "remote", "source active = remote");

    // Laisse la grille/le pipeline de vignettes se stabiliser.
    await sleep(250);

    assert.strictEqual(viewerHost.isLoading, false, "le chargement est TERMINÉ (isLoading=false)");
    assert.strictEqual(loadCalls, 1, "UN SEUL loadFilteredImages pour la bascule (aucune boucle)");

    assert.strictEqual(loadingMsg(), null, "le libellé de chargement a été RETIRÉ de la galerie");
    assert.strictEqual(gridRoot(), rootBefore, "LA MÊME grille est toujours dans le DOM (jamais détruite)");
    assert.ok(gridRoot().isConnected, "la grille est bien attachée au document");

    const st = imageViewerState.getState();
    assert.strictEqual(st.totalCount, N, `les ${N} médias serveur sont chargés`);
    assert.strictEqual(st.status.error, null, "aucune erreur avalée");

    const cells = Array.from(galleryEl.querySelectorAll("[data-path-canon]"));
    assert.ok(cells.length > 0, `des cellules sont rendues (${cells.length})`);
    assert.ok(cells.every((c) => c.dataset.pathCanon.startsWith("srv:")), "cellules = médias serveur srv:<id>");

    assert.ok(thumbCalls().length > 0, `vignettes blob+Bearer demandées (${thumbCalls().length})`);
    assert.ok(thumbCalls().every((c) => c.init.headers.Authorization === `Bearer ${API_KEY}`), "Bearer sur chaque vignette");

    // Toujours aucune boucle : le poll serveur est à 10 s, rien ne recharge ici.
    captured.length = 0;
    await sleep(400);
    assert.strictEqual(viewerHost.isLoading, false, "toujours pas de chargement en cours");
    assert.strictEqual(srvListCalls().length, 0, "aucune requête de liste parasite (pas de rechargement en boucle)");
    assert.strictEqual(loadCalls, 1, "aucun loadFilteredImages supplémentaire");
}
ok("bascule ouverte : chargement terminé, grille conservée, libellé retiré, aucune boucle");

/* ─── 2. Le libellé statique du template est nettoyé au premier rendu ───── */
console.log("2. Nettoyage du libellé statique « iv.loadingImages » du template");
{
    // À ce stade un rendu a eu lieu : plus aucun `.holaf-viewer-message` dans la
    // galerie (l'ancien code ne le retirait que sur le chemin « rebuild »).
    assert.strictEqual(galleryEl.querySelector(".holaf-viewer-message"), null,
        "plus aucun message de chargement dans la zone de galerie");
}
ok("le libellé statique du template est nettoyé (aucun message résiduel)");

/* ─── 3. Échec des VIGNETTES (500) : le chargement se termine quand même ── */
console.log("3. Vignettes en erreur (500)");
{
    thumbStatus = 500;
    // Nouveaux ids → la liste change → la grille redemande réellement les
    // vignettes (sinon le cache LRU les servirait sans requête).
    listIdBase = 1000;
    captured.length = 0;
    await viewerHost.loadAndPopulateFilters(true);
    await sleep(250);

    assert.strictEqual(viewerHost.isLoading, false, "chargement terminé malgré les vignettes en échec");
    assert.strictEqual(loadingMsg(), null, "aucun libellé de chargement figé");
    assert.strictEqual(gridRoot(), rootBefore, "la grille est intacte (même nœud)");
    assert.ok(thumbCalls().length > 0, "les vignettes ont bien été demandées (et ont échoué)");
    assert.ok(thumbCalls().every((c) => c.init.headers.Authorization === `Bearer ${API_KEY}`), "Bearer sur les vignettes en échec");
    thumbStatus = 200;
    listIdBase = 0;
}
ok("vignette 500 : le chargement se termine, grille intacte, pas de libellé figé");

/* ─── 4. Erreur de LISTE (500) : fin TOUJOURS + message d'erreur explicite ─ */
console.log("4. Erreur serveur sur la liste (500)");
{
    listStatus = 500;
    captured.length = 0;
    await viewerHost.loadAndPopulateFilters(true);
    await sleep(50);

    assert.strictEqual(viewerHost.isLoading, false, "le chargement se TERMINE en erreur (jamais éternel)");
    assert.strictEqual(imageViewerState.getState().status.error, "HTTP error 500", "erreur explicite propagée dans l'état");
    const msg = galleryEl.querySelector(".holaf-viewer-message");
    assert.ok(msg && /HTTP error 500/.test(msg.textContent), "le message d'erreur est affiché dans la galerie");
    assert.strictEqual(gridRoot(), rootBefore, "la grille n'est PAS détruite par l'erreur");
    listStatus = 200;
}
ok("liste 500 : fin du chargement + message d'erreur explicite + grille conservée");

/* ─── 5. Contrôle négatif : l'état se rétablit après l'erreur ───────────── */
console.log("5. Rétablissement après l'erreur (le libellé d'erreur est nettoyé)");
{
    captured.length = 0;
    await viewerHost.loadAndPopulateFilters(true);
    await sleep(150);
    assert.strictEqual(viewerHost.isLoading, false, "rechargement terminé");
    assert.strictEqual(galleryEl.querySelector(".holaf-viewer-message"), null, "aucun message résiduel après succès");
    assert.strictEqual(imageViewerState.getState().status.error, null, "erreur effacée");
}
ok("après une erreur, un succès nettoie le message et rétablit la galerie");

console.log(`\n✅ Test régression « Application des filtres » (galerie serveur) : ${n} groupes PASSENT`);

dom.window.close();
process.exit(0);
