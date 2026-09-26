// Tests d'intégration — checkForUpdates() de l'AIH Image Viewer (jsdom).
// Usage : node js/test_iv_checkforupdates_delta.mjs
//
// Couvre la décision de rafraîchissement du poll périodique :
//   1. « changement de filtre » (signature dossier/formats modifiée) → reload
//      COMPLET (loadAndPopulateFilters + loadFilteredImages) : NON-RÉGRESSION.
//   2. delta (nouvelles images) → AUCUN loadFilteredImages, AUCUN
//      resetWindowCache ; l'image est insérée EN TÊTE et la fenêtre chargée est
//      conservée (isWindowLoaded(0) reste true).
//
// jsdom est résolu par le loader partagé ; introuvable = SKIP bruyant (exit 2).
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_iv_checkforupdates_delta");

const dom = new JSDOM(`<!doctype html><html><body>
  <div id="holaf-viewer-gallery"></div>
  <div id="holaf-viewer-statusbar"></div>
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
globalThis.MouseEvent = window.MouseEvent;
globalThis.requestAnimationFrame = window.requestAnimationFrame?.bind(window) || ((cb) => setTimeout(cb, 0));
globalThis.cancelAnimationFrame = window.cancelAnimationFrame?.bind(window) || clearTimeout;
// jsdom n'implémente pas ResizeObserver : la galerie en crée un à l'init.
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

// ── Fetch mocké : route par sous-chaîne d'URL ──────────────────────────────
let fetchRoutes = {};
globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    for (const key of Object.keys(fetchRoutes)) {
        if (u.includes(key)) {
            const handler = fetchRoutes[key];
            return typeof handler === "function" ? handler(url, init) : handler;
        }
    }
    throw new Error(`Unexpected fetch: ${u}`);
};
const jsonResponse = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// galerie : clientHeight non nul (sinon checkForUpdates considère « pas en haut »).
const galleryEl = document.getElementById("holaf-viewer-gallery");
Object.defineProperty(galleryEl, "clientHeight", { value: 800, configurable: true });
Object.defineProperty(galleryEl, "scrollTop", { value: 0, configurable: true, writable: true });

const { default: viewer } = await import("./holaf_image_viewer.js");
const { imageViewerState } = await import("./image_viewer/image_viewer_state.js");
const { setWindowLoaded, isWindowLoaded } = await import("./image_viewer/image_viewer_data.js");

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

const SAME_SIGNATURE = { subfolders: "root", formats: "PNG" };

function resetViewerState(images) {
    imageViewerState.setState({
        images: [],
        totalCount: 0,
        filters: { folder_filters: ["root"] },
        status: { lastDbUpdateTime: 0 },
    });
    if (images && images.length) {
        setWindowLoaded(imageViewerState.getState(), 0, images);
        imageViewerState.setState({ totalCount: images.length });
    }
    viewer.isLoading = false;
    viewer._isGalleryScrolling = false;
    if (viewer._resyncDebounceTimer) { clearTimeout(viewer._resyncDebounceTimer); viewer._resyncDebounceTimer = null; }
}

function baseRoutes() {
    fetchRoutes = {
        "/holaf/images/last-update-time": () => jsonResponse({ last_update: 100 }),
        "/holaf/images/filter-options": () => jsonResponse({
            subfolders: [{ path: "root", count: 2 }],
            formats: ["PNG"],
            last_update_time: 100,
        }),
        "/holaf/images/list": () => jsonResponse({
            images: [{ path_canon: "new.png", mtime: 200, filename: "new.png", subfolder: "", format: "PNG" }],
            total_db_count: 2,
            generated_thumbnails_count: 0,
        }),
    };
}

/* ─── 1. Changement de filtre → reload COMPLET (non-régression) ──────────── */
console.log("1. Changement de filtre → reload complet");
{
    baseRoutes();
    resetViewerState([{ path_canon: "old.png", mtime: 150, filename: "old.png", subfolder: "", format: "PNG" }]);
    viewer._lastFilterSignature = { subfolders: "AUTRE", formats: "PNG" }; // signature différente

    const calls = [];
    viewer.loadAndPopulateFilters = async () => { calls.push("filters"); };
    viewer.loadFilteredImages = async () => { calls.push("load"); };
    viewer.updateStatusBar = () => {};

    await viewer.checkForUpdates();

    assert.ok(calls.includes("filters"), "signature changée → rebuild des filtres");
    assert.ok(calls.includes("load"), "signature changée → loadFilteredImages (reload complet)");
    ok("changement de filtre → loadAndPopulateFilters + loadFilteredImages (préservé)");
}

/* ─── 2. Delta → AUCUN reload complet, insertion en tête ─────────────────── */
console.log("2. Delta → patch en place, pas de reload");
{
    baseRoutes();
    resetViewerState([{ path_canon: "old.png", mtime: 150, filename: "old.png", subfolder: "", format: "PNG" }]);
    viewer._lastFilterSignature = { ...SAME_SIGNATURE };

    const calls = [];
    viewer.loadAndPopulateFilters = async () => { calls.push("filters"); };
    viewer.loadFilteredImages = async () => { calls.push("load"); };
    viewer.updateStatusBar = () => {};

    // Espionne _applyIncrementalDelta tout en laissant l'implémentation réelle
    // s'exécuter, pour prouver que le callback débouncé applique bien le DELTA
    // (et pas loadFilteredImages — contrôle négatif : si on réintroduit un
    // reload complet dans le callback, applyCalls reste 0 et ce test est ROUGE).
    const originalApply = viewer._applyIncrementalDelta.bind(viewer);
    let applyCalls = 0;
    viewer._applyIncrementalDelta = async (d) => { applyCalls++; return originalApply(d); };

    await viewer.checkForUpdates();

    assert.ok(!calls.includes("load"), "delta NE doit PAS faire de loadFilteredImages");
    assert.ok(!calls.includes("filters"), "signature inchangée → pas de rebuild filtres");
    assert.ok(viewer._resyncDebounceTimer, "checkForUpdates doit planifier l'application du delta");

    // Laisse le débounce (INCREMENTAL_APPLY_DEBOUNCE_MS = 1200 ms) s'exécuter.
    for (let waited = 0; waited < 3000 && applyCalls === 0; waited += 50) {
        await new Promise((r) => setTimeout(r, 50));
    }

    assert.strictEqual(applyCalls, 1, "le delta doit être appliqué via _applyIncrementalDelta (pas loadFilteredImages)");
    assert.ok(!calls.includes("load"), "l'application du delta ne fait toujours pas de reload complet");

    const state = imageViewerState.getState();
    assert.strictEqual(state.images[0].path_canon, "new.png", "nouvelle image insérée EN TÊTE");
    assert.strictEqual(state.images[1].path_canon, "old.png", "ancienne tête décalée");
    assert.strictEqual(state.totalCount, 2, "totalCount mis à jour");
    // PREUVE : pas de resetWindowCache dans le chemin delta.
    assert.strictEqual(isWindowLoaded(0), true, "fenêtre chargée conservée (aucun resetWindowCache)");
    ok("delta → insertion en tête + fenêtre conservée, aucun reload");
}

/* ─── 3. Baisse du compteur DB (suppression hors-bande) → reload complet ──── */
console.log("3. Baisse du compteur DB → reload complet");
{
    baseRoutes();
    fetchRoutes["/holaf/images/list"] = () => jsonResponse({
        images: [],
        total_db_count: 4, // < totalImageCount connu (5) → suppression hors-bande
        generated_thumbnails_count: 0,
    });
    resetViewerState([{ path_canon: "old.png", mtime: 150, filename: "old.png", subfolder: "", format: "PNG" }]);
    imageViewerState.setState({ status: { totalImageCount: 5 } });
    viewer._lastFilterSignature = { ...SAME_SIGNATURE };

    const calls = [];
    viewer.loadAndPopulateFilters = async () => { calls.push("filters"); };
    viewer.loadFilteredImages = async () => { calls.push("load"); };
    viewer.updateStatusBar = () => {};

    await viewer.checkForUpdates();
    assert.ok(calls.includes("load"), "baisse du compteur DB → loadFilteredImages (reload)");
    assert.ok(!viewer._resyncDebounceTimer, "pas d'application de delta quand la suppression exige un reload");
    ok("baisse du compteur DB → reload complet (suppression réconciliée)");
}

console.log(`\n✅ Test checkForUpdates (delta vs filtre) : TOUS LES TESTS PASSENT (${n} étapes)`);

// holaf_comfy_bridge.js ouvre un BroadcastChannel à l'import, ce qui garde la
// boucle d'événements Node en vie : on quitte explicitement une fois les
// assertions passées (le yield laisse stdout se vider avant exit).
await new Promise((r) => setTimeout(r, 0));
process.exit(0);
