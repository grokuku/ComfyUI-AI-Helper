// Test de l'ÉTAPE 6 — AUTO-RAFRAÎCHISSEMENT du mode SERVEUR (poll de tête + delta).
// Usage : node js/test_iv_remote_poll.mjs
//
// Verrouille, SANS aucun appel réseau réel (fetch stubé), le poll serveur :
//   1. cycle de vie : démarre en source 'remote' + panneau visible, s'arrête au
//      retour 'local', idempotent (jamais deux timers) ;
//   2. fetchDelta du provider : tête de page 1, MÊMES filtres + tri que la vue,
//      nouveaux = ids de tête absents du curseur, resync si tri non-descendant ;
//   3. nouveau média → INSERTION EN TÊTE (insertTop), AUCUN loadFilteredImages ;
//   4. aucun changement → aucun rechargement (contrôle négatif n°1) ;
//   5. suppression hors-bande (baisse du total) → resynchronisation complète,
//      DIFFÉRÉE tant que sélection/visionneuse/scroll la rendraient perturbante
//      (contrôle négatif n°2 : pas de resync sous sélection) ;
//   6. nos PROPRES mutations pendant la requête → réponse périmée jetée (pas de
//      reload parasite : contrôle négatif n°3) ;
//   7. non-perturbation au scroll : « pendingNewImages » + toast, rien inséré ;
//   8. erreur réseau → le tick suivant réessaie (le poll ne meurt jamais :
//      contrôle négatif n°4) + jamais deux requêtes concurrentes ;
//   9. onglet masqué → poll arrêté ; retour → reprise + contrôle immédiat ;
//  10. mode LOCAL strictement inchangé (poll 2 s, last-update-time + min_mtime)
//      et AUCUN poll serveur (contrôle négatif n°5).
//
// jsdom est résolu par le loader partagé ; introuvable = SKIP bruyant (exit 2).
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_iv_remote_poll");

const dom = new JSDOM(`<!doctype html><html><body>
  <div id="holaf-viewer-gallery"></div>
  <div id="holaf-viewer-statusbar"></div>
</body></html>`, { pretendToBeVisual: true, url: "http://localhost/" });

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

// ── Fetch factice : capture (url, init) et route par sous-chaîne d'URL ──────
const captured = [];
let fetchRoutes = {};
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
globalThis.fetch = async (url, init = {}) => {
    captured.push({ url: String(url), init });
    const u = String(url);
    for (const key of Object.keys(fetchRoutes)) {
        if (u.includes(key)) {
            const handler = fetchRoutes[key];
            return typeof handler === "function" ? handler(url, init) : handler;
        }
    }
    throw new Error(`Unexpected fetch: ${u}`);
};
window.fetch = globalThis.fetch;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (fn, timeoutMs = 3000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (fn()) return true;
        await sleep(25);
    }
    return fn();
};
let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

const SERVER_URL = "https://aih.example.com:8443";
const API_KEY = "tok-123";
// Config AVANT l'import du viewer : le provider 'remote' doit être enregistré.
window.localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: SERVER_URL, apiKey: API_KEY }));

// galerie : clientHeight non nul (sinon tout est « en haut »).
const galleryEl = document.getElementById("holaf-viewer-gallery");
Object.defineProperty(galleryEl, "clientHeight", { value: 800, configurable: true });
Object.defineProperty(galleryEl, "scrollTop", { value: 0, configurable: true, writable: true });

const { default: viewer } = await import("./holaf_image_viewer.js");
const { GallerySource } = await import("./image_viewer/image_viewer_source.js");
const { imageViewerState } = await import("./image_viewer/image_viewer_state.js");
const { setWindowLoaded, isWindowLoaded } = await import("./image_viewer/image_viewer_data.js");

// Le viewer est remplacé par un compteur de rechargements COMPLET : les
// assertions « pas de reload » portent sur ce compteur (contrôle négatif n°1 :
// si le poll appelait loadFilteredImages à chaque tick, les compteurs rougiraient).
let loadCalls = 0;
viewer.loadFilteredImages = async () => { loadCalls++; };

const isHeadRequest = (c) => { try { return new URL(c.url).pathname === "/api/media"; } catch (e) { return false; } };
const headRequests = () => captured.filter(isHeadRequest);

function remoteItem(id, created = "2024-05-01T10:00:00Z") {
    return {
        id, path: `u/${id}.png`, filename: `${id}.png`, subfolder: id === 2 ? "a/b" : "",
        size: 1000, created_at: created, kind: "image", favorite: false, tags: [],
        has_prompt: false, has_workflow: false, status: "complete", trashed: false,
    };
}
function normItem(id, over = {}) {
    return {
        path_canon: `srv:${id}`, server_id: id, filename: `${id}.png`, subfolder: "",
        format: "PNG", mtime: 1000 + id, size_bytes: 1000, is_trashed: false,
        has_edit_file: false, kind: "image", favorite: false, tags: [],
        has_prompt: false, has_workflow: false, width: null, height: null,
        duration_ms: null, codec: null, created_at: "2024-05-01T10:00:00Z", server_status: "complete",
        ...over,
    };
}

/** Ré-ensemence l'état + la collection (fenêtre 0 chargée), comme l'hôte réel. */
function seed(images, total) {
    imageViewerState.setState({
        images: [],
        totalCount: 0,
        selectedImages: new Set(),
        activeImage: null,
        currentNavIndex: -1,
        filters: { folder_filters: [] },
        status: { pendingNewImages: false, totalImageCount: total != null ? total : images.length, lastDbUpdateTime: 0 },
    });
    if (images && images.length) {
        setWindowLoaded(imageViewerState.getState(), 0, images);
        imageViewerState.setState({ totalCount: total != null ? total : images.length });
    }
    viewer.isLoading = false;
    viewer._isGalleryScrolling = false;
    viewer._remotePollPendingResync = false;
    if (viewer._resyncDebounceTimer) { clearTimeout(viewer._resyncDebounceTimer); viewer._resyncDebounceTimer = null; }
    loadCalls = 0;
}

/* ─── 1. Cycle de vie : démarrage/arrêt selon la source, idempotent ─────── */
console.log("1. Cycle de vie du poll selon la source");
viewer.panelElements = { panelEl: { style: { display: "flex" } } };
GallerySource.setActive("remote");
viewer._syncSourcePolling();
assert.strictEqual(viewer._remotePollActive, true, "source remote + panneau visible → poll serveur DÉMARRÉ");
assert.ok(viewer.remotePollTimer, "un timer est planifié");
assert.strictEqual(viewer.filterRefreshIntervalId, null, "le poll local 2 s est arrêté en mode serveur");
const timerRef = viewer.remotePollTimer;
viewer._startRemotePoll();
assert.strictEqual(viewer.remotePollTimer, timerRef, "pas de double démarrage (_startRemotePoll idempotent)");
viewer._syncSourcePolling();
assert.strictEqual(viewer.remotePollTimer, timerRef, "_syncSourcePolling idempotent");

// Arrêt quand le panneau est masqué.
viewer.panelElements.panelEl.style.display = "none";
viewer._syncSourcePolling();
assert.strictEqual(viewer._remotePollActive, false, "panneau masqué → poll serveur arrêté");
assert.strictEqual(viewer.remotePollTimer, null, "timer annulé");
viewer.panelElements.panelEl.style.display = "flex";

// Retour local → poll serveur arrêté, poll local 2 s (re)démarré.
GallerySource.setActive("local");
viewer._syncSourcePolling();
assert.strictEqual(viewer._remotePollActive, false, "retour local → poll serveur ARRÊTÉ");
assert.strictEqual(viewer.remotePollTimer, null);
assert.ok(viewer.filterRefreshIntervalId, "poll local 2 s (re)démarré (comportement historique)");
clearInterval(viewer.filterRefreshIntervalId);
viewer.filterRefreshIntervalId = null;
GallerySource.setActive("remote");
viewer._syncSourcePolling();
ok("cycle de vie : démarrage remote, arrêt local/masqué, idempotence (aucun double timer)");

/* ─── 2. fetchDelta : tête + filtres + tri de la vue ───────────────────── */
console.log("2. fetchDelta provider : tête de page 1 + filtres + tri");
imageViewerState.setState({ ui: {
    remote_kind: "image", remote_subfolders: ["a/b"], remote_tags: ["ciel"],
    remote_q: "chat", remote_sort: "created_at_desc",
} });
captured.length = 0;
fetchRoutes = {
    "/api/media?": () => jsonResponse({
        items: [remoteItem(3), remoteItem(2), remoteItem(1)],
        total: 3, page: 1, limit: 30,
    }),
};
let delta = await GallerySource.active().fetchDelta({
    filters: imageViewerState.getState().filters,
    cursor: { ids: ["srv:2", "srv:1"], total: 2 },
});
let u = new URL(headRequests().at(-1).url);
assert.strictEqual(u.pathname, "/api/media");
assert.strictEqual(u.searchParams.get("page"), "1", "tête = page 1");
assert.strictEqual(u.searchParams.get("limit"), "30", "borne de tête (REMOTE_POLL_LIMIT)");
assert.strictEqual(u.searchParams.get("kind"), "image", "filtre actif kind transmis");
assert.deepStrictEqual(u.searchParams.getAll("subfolders"), ["a/b"], "filtre actif dossiers");
assert.deepStrictEqual(u.searchParams.getAll("tags"), ["ciel"], "filtre actif tags");
assert.strictEqual(u.searchParams.get("q"), "chat", "filtre actif recherche");
assert.strictEqual(u.searchParams.get("sort"), null, "tri défaut created_at_desc non émis (≡ vue)");
assert.strictEqual(delta.resync_reason, null, "diff cohérent → delta exploitable");
assert.deepStrictEqual(delta.images.map((i) => i.path_canon), ["srv:3"], "seul srv:3 est nouveau");
assert.strictEqual(delta.total_count, 3, "total serveur autoritaire");

// Tri NON descendant : nouveau + baisse → resync exigée (jamais de patch aveugle).
imageViewerState.setState({ ui: { remote_sort: "name_asc" } });
captured.length = 0;
fetchRoutes = {
    "/api/media?": () => jsonResponse({ items: [remoteItem(4), remoteItem(3)], total: 4, page: 1, limit: 30 }),
};
delta = await GallerySource.active().fetchDelta({
    filters: imageViewerState.getState().filters,
    cursor: { ids: ["srv:3", "srv:2"], total: 3 },
});
assert.strictEqual(new URL(headRequests().at(-1).url).searchParams.get("sort"), "name_asc", "tri de la vue transmis");
assert.strictEqual(delta.resync_reason, "sort", "tri non-descendant + total changé → resync");
assert.deepStrictEqual(delta.images, [], "aucune insertion proposée hors tri descendant");
imageViewerState.setState({ ui: {
    remote_kind: "", remote_subfolders: [], remote_tags: [], remote_q: "", remote_sort: "created_at_desc",
} });
ok("fetchDelta : page 1 limit 30, filtres/tri de la vue, diff curseur, resync si tri non-desc");

/* ─── 3. Nouveau média → insertTop, AUCUN reload ───────────────────────── */
console.log("3. Nouveau média → insertion en tête sans reload");
seed([normItem(1)], 1);
fetchRoutes = {
    "/api/media?": () => jsonResponse({ items: [remoteItem(2), remoteItem(1)], total: 2, page: 1, limit: 30 }),
};
let res = await viewer.checkRemoteUpdates();
assert.strictEqual(res.action, "inserted", "tick : delta inséré (pas de reload)");
assert.strictEqual(loadCalls, 0, "aucun loadFilteredImages pendant le tick");
assert.ok(viewer._resyncDebounceTimer, "application du delta planifiée (debounce)");
await waitFor(() => imageViewerState.getState().images[0]?.path_canon === "srv:2");
const st3 = imageViewerState.getState();
assert.strictEqual(st3.images[0].path_canon, "srv:2", "nouveau média EN TÊTE");
assert.strictEqual(st3.images[1].path_canon, "srv:1", "ancienne tête décalée");
assert.strictEqual(st3.totalCount, 2, "total local mis à jour");
assert.strictEqual(st3.status.totalImageCount, 2, "compteur serveur rafraîchi (autoritaire)");
assert.strictEqual(isWindowLoaded(0), true, "fenêtre chargée CONSERVÉE (aucun resetWindowCache)");
assert.strictEqual(loadCalls, 0, "aucun reload après application");
ok("nouveau média → insertTop + fenêtre conservée, zéro rechargement complet");

/* ─── 4. Aucun changement → aucun reload (contrôle négatif n°1) ────────── */
console.log("4. Aucun changement → aucun rechargement (NC1)");
seed([normItem(1)], 1);
fetchRoutes = {
    "/api/media?": () => jsonResponse({ items: [remoteItem(1)], total: 1, page: 1, limit: 30 }),
};
res = await viewer.checkRemoteUpdates();
assert.strictEqual(res.action, "none", "tête identique → rien à faire");
res = await viewer.checkRemoteUpdates();
assert.strictEqual(res.action, "none", "2e tick identique → rien à faire");
assert.strictEqual(loadCalls, 0, "NC1 : un tick sans changement ne recharge JAMAIS la liste");
assert.strictEqual(imageViewerState.getState().images[0].path_canon, "srv:1", "liste intacte");
assert.strictEqual(viewer._resyncDebounceTimer, null, "aucun delta planifié");
ok("NC1 : polling sans changement → zéro reload (rougirait si reload à chaque tick)");

/* ─── 5. Suppression hors-bande → resync DIFFÉRÉE si perturbante ───────── */
console.log("5. Suppression hors-bande → resynchronisation différée");
seed([normItem(1), normItem(2)], 2);
imageViewerState.setState({ selectedImages: new Set([normItem(2)]) }); // sélection active
fetchRoutes = {
    "/api/media?": () => jsonResponse({ items: [remoteItem(1)], total: 1, page: 1, limit: 30 }),
};
galleryEl.scrollTop = 0;
res = await viewer.checkRemoteUpdates();
assert.strictEqual(res.action, "reload-deferred", "baisse du total → resync demandée");
assert.strictEqual(viewer._remotePollPendingResync, true, "resync EN ATTENTE (pas exécutée)");
assert.strictEqual(loadCalls, 0, "NC2 : aucune resync tant que la sélection existe");
assert.strictEqual(imageViewerState.getState().selectedImages.length, 1, "sélection préservée");

// Visionneuse ouverte → toujours différée.
imageViewerState.setState({ selectedImages: new Set(), ui: { view_mode: "zoom" } });
res = await viewer.checkRemoteUpdates();
assert.strictEqual(viewer._remotePollPendingResync, true, "resync toujours en attente (visionneuse ouverte)");
assert.strictEqual(loadCalls, 0, "aucune resync visionneuse ouverte");

// Plus rien de perturbant → la resync est rejouée au tick suivant.
imageViewerState.setState({ ui: { view_mode: "gallery" } });
res = await viewer.checkRemoteUpdates();
assert.strictEqual(res.action, "pending-resync", "resync rejouée au tick suivant");
assert.strictEqual(loadCalls, 1, "loadFilteredImages exécuté UNE fois");
assert.strictEqual(viewer._remotePollPendingResync, false, "plus rien en attente");
ok("suppression hors-bande : resync complète, différée tant que sélection/visionneuse");

/* ─── 6. Nos propres mutations → réponse périmée jetée (NC3) ───────────── */
console.log("6. Notre suppression pendant la requête → stale (NC3)");
seed([normItem(1)], 1);
let resolveHead = null;
fetchRoutes = {
    // Réponse RETARDÉE (décrit l'état d'AVANT notre suppression : total 0).
    "/api/media?": () => new Promise((resolve) => {
        resolveHead = () => resolve(jsonResponse({ items: [], total: 0, page: 1, limit: 30 }));
    }),
};
const inFlight = viewer.checkRemoteUpdates();
await waitFor(() => resolveHead !== null, 1000); // laisse partir la requête
await viewer._applyIncrementalDelta({ images: [], removed_path_canons: ["srv:1"] }); // NOTRE suppression
resolveHead();
res = await inFlight;
assert.strictEqual(res.action, "stale", "réponse d'avant-mutation → jetée");
assert.strictEqual(viewer._remotePollPendingResync, false, "NC3 : pas de reload parasite déclenché");
assert.strictEqual(loadCalls, 0, "NC3 : zéro rechargement pour notre propre suppression");
assert.strictEqual(imageViewerState.getState().totalCount, 0, "total local décrémenté par notre mutation");
ok("NC3 : mutation locale pendant la requête → réponse périmée, aucun reload parasite");

/* ─── 7. Scroll : non-perturbation (pendingNewImages + toast) ──────────── */
console.log("7. Scrolé ailleurs → rien inséré, nouveauté signalée");
seed([normItem(1)], 1);
galleryEl.scrollTop = 1200; // ≥ clientHeight → PAS en haut
fetchRoutes = {
    "/api/media?": () => jsonResponse({ items: [remoteItem(2), remoteItem(1)], total: 2, page: 1, limit: 30 }),
};
res = await viewer.checkRemoteUpdates();
assert.strictEqual(res.action, "pending", "scrollé → delta en attente");
assert.strictEqual(imageViewerState.getState().status.pendingNewImages, true, "badge « nouveaux » posé");
assert.strictEqual(viewer._resyncDebounceTimer, null, "aucune insertion en tête planifiée");
assert.strictEqual(imageViewerState.getState().images[0].path_canon, "srv:1", "tête de liste INCHANGÉE");
assert.strictEqual(galleryEl.scrollTop, 1200, "scroll PRÉSERVÉ");
assert.strictEqual(loadCalls, 0, "aucun reload");
galleryEl.scrollTop = 0;
imageViewerState.setState({ status: { pendingNewImages: false } });
ok("scroll préservé : nouveauté signalée, aucune insertion/reload perturbant");

/* ─── 8. Erreur réseau → le poll survit ; pas de concurrence ───────────── */
console.log("8. Erreur réseau (NC4) + concurrence");
seed([normItem(1)], 1);
viewer._startRemotePoll();
const beforeErr = headRequests().length;
fetchRoutes = { "/api/media?": () => { throw new Error("network down"); } };
await viewer._remotePollTick();
assert.strictEqual(headRequests().length, beforeErr + 1, "la requête a bien été tentée");
assert.strictEqual(viewer._remotePollActive, true, "le poll reste ACTIF après l'erreur");
assert.ok(viewer.remotePollTimer, "NC4 : prochain tick REPLANIFIÉ (rougirait si le poll mourait)");

// Le tick suivant retente et réussit.
fetchRoutes = {
    "/api/media?": () => jsonResponse({ items: [remoteItem(1)], total: 1, page: 1, limit: 30 }),
};
await viewer._remotePollTick();
assert.strictEqual(headRequests().length, beforeErr + 2, "le tick suivant réessaie (récupération)");

// Jamais deux requêtes concurrentes : 2 ticks dont un en vol → 1 seule requête.
let resolveSlow = null;
fetchRoutes = {
    "/api/media?": () => new Promise((resolve) => {
        resolveSlow = () => resolve(jsonResponse({ items: [remoteItem(1)], total: 1, page: 1, limit: 30 }));
    }),
};
const beforeConc = headRequests().length;
const p1 = viewer._remotePollTick();
await sleep(0);
const p2 = viewer._remotePollTick(); // doit être absorbé par _remotePollInFlight
await sleep(0);
assert.strictEqual(headRequests().length, beforeConc + 1, "une seule requête en vol (pas de concurrence)");
resolveSlow();
await Promise.all([p1, p2]);
ok("NC4 : survit à une erreur réseau et repart ; jamais deux requêtes concurrentes");

/* ─── 9. Onglet masqué → arrêt ; retour → reprise + check immédiat ─────── */
console.log("9. visibilitychange : arrêt masqué, reprise au retour");
viewer.panelElements.panelEl.style.display = "flex";
viewer._bindVisibilityPollGuard();
viewer._startRemotePoll();
let hiddenFlag = false;
Object.defineProperty(document, "hidden", { configurable: true, get: () => hiddenFlag });
const beforeVis = headRequests().length;
hiddenFlag = true;
document.dispatchEvent(new window.Event("visibilitychange"));
assert.strictEqual(viewer._remotePollActive, false, "onglet masqué → poll serveur arrêté");
assert.strictEqual(viewer.remotePollTimer, null, "aucun timer pendant le masquage");
await sleep(0);
assert.strictEqual(headRequests().length, beforeVis, "aucune requête pendant le masquage");
hiddenFlag = false;
document.dispatchEvent(new window.Event("visibilitychange"));
assert.strictEqual(viewer._remotePollActive, true, "retour d'onglet → poll REPRIS");
assert.ok(viewer.remotePollTimer, "timer replanifié");
await waitFor(() => headRequests().length === beforeVis + 1);
assert.strictEqual(headRequests().length, beforeVis + 1, "contrôle IMMÉDIAT au retour d'onglet");
ok("visibilitychange : arrêt à l'onglet masqué, reprise + check immédiat au retour");

/* ─── 10. Mode LOCAL strictement inchangé (NC5) ────────────────────────── */
console.log("10. Mode local : poll 2 s intact, aucun poll serveur (NC5)");
GallerySource.setActive("local");
viewer._stopRemotePoll();
viewer._syncSourcePolling();
assert.strictEqual(viewer._remotePollActive, false, "NC5 : aucun poll serveur en mode local");
assert.strictEqual(viewer.remotePollTimer, null);
assert.ok(viewer.filterRefreshIntervalId, "poll local 2 s actif");
clearInterval(viewer.filterRefreshIntervalId);
viewer.filterRefreshIntervalId = null;

seed([{ path_canon: "local1.png", mtime: 150, filename: "local1.png", subfolder: "", format: "PNG" }], 1);
imageViewerState.setState({ filters: { folder_filters: ["root"] }, status: { lastDbUpdateTime: 0, totalImageCount: 1 } });
let lastUpdateCalls = 0;
fetchRoutes = {
    "/holaf/images/last-update-time": () => { lastUpdateCalls++; return jsonResponse({ last_update: 100 }); },
    "/holaf/images/filter-options": () => jsonResponse({ subfolders: [{ path: "root", count: 1 }], formats: ["PNG"], last_update_time: 100 }),
    "/holaf/images/list": () => jsonResponse({ images: [], total_db_count: 1, generated_thumbnails_count: 1, removed_path_canons: [] }),
};
viewer._lastFilterSignature = { subfolders: "root", formats: "PNG" };
const beforeLocal = headRequests().length;
await viewer.checkForUpdates();
assert.strictEqual(lastUpdateCalls, 1, "le poll local interroge TOUJOURS /holaf/images/last-update-time");
assert.strictEqual(headRequests().length, beforeLocal, "NC5 : AUCUNE requête de tête serveur en mode local");
assert.strictEqual(viewer._remotePollActive, false, "NC5 : poll serveur inactif en local");
const localListPosts = captured.filter((c) => c.url.includes("/holaf/images/list"));
assert.ok(localListPosts.length >= 1, "delta local demandé (POST /holaf/images/list)");
assert.strictEqual(JSON.parse(localListPosts.at(-1).init.body).min_mtime, 150, "delta local = min_mtime de la tête (historique)");
ok("mode local inchangé : last-update-time + delta min_mtime, aucun poll serveur (NC5)");

console.log(`\n✅ Test auto-refresh source serveur (étape 6) : ${n} groupes PASSENT`);

// Nettoyage : timers + listener + fermeture jsdom.
viewer._stopRemotePoll();
if (viewer.filterRefreshIntervalId) { clearInterval(viewer.filterRefreshIntervalId); viewer.filterRefreshIntervalId = null; }
dom.window.close();
process.exit(0);
