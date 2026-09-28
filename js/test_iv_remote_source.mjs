// Test de l'ÉTAPE 2 — provider de source galerie « SERVEUR » (data + vignettes).
// Usage : node js/test_iv_remote_source.mjs
//
// Verrouille, SANS aucun appel réseau réel (fetch stubé), le provider
// js/image_viewer/image_viewer_source_remote.js et son branchement à l'hôte :
//   1. normalisation d'item (mapping complet, clé srv:<id>, format MAJUSCULE,
//      mtime dérivé de created_at) + itemKey/sortKey ;
//   2. snap des tailles de vignette vers le HAUT (80→128, 129→256, 257→512,
//      300→512, >512→512) ;
//   3. fetchPage : URL + query exactes par filtre, page calculée depuis offset,
//      limit borné à 200, total/items normalisés ;
//   4. buildThumbnailUrl (size snappé + cache-buster) ;
//   5. loadThumbnail (remoteGet raw:true → Response, Bearer injecté, signal) ;
//   6. createThumbCache (strategy 'blob', capacity 1000, concurrence 4-6) ;
//   7. fetchFilterOptions (dossiers → {path,count}, tags, formats vide) ;
//   8. non supporté → null / no-op ; resolveMediaUrl/resolveInfo → fail-fast ;
//   9. enregistrement CONDITIONNEL du provider (config serveur requise) ;
//  10. bascule local→remote (garde-fou étape 1) → PAGE_SIZE passe à 200, la
//      grille se remplit de médias serveur et les vignettes sont demandées avec
//      le bon size + Authorization (grille réelle, jsdom) ;
//  11. contrôles négatifs (snap vers le bas, mapping absent, provider sans config).
//
// jsdom est résolu par le loader partagé ; introuvable = SKIP bruyant (exit 2).
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_iv_remote_source");

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
// jsdom n'implémente pas createObjectURL : la stratégie 'blob' de la brique
// en a besoin. On renvoie une URL factice et on compte les créations.
let objectUrls = 0;
globalThis.URL.createObjectURL = () => `blob:mock-${++objectUrls}`;
globalThis.URL.revokeObjectURL = () => {};

// ── Fetch factice : capture (url, init) et route par sous-chaîne d'URL ──────
const captured = [];
let fetchRoutes = {};
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
function thumbResponse() {
    return new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200, headers: { "content-type": "image/jpeg" } });
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
let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

const SERVER_URL = "https://aih.example.com:8443";
const API_KEY = "tok-123";

// IMPORTANT : aucun AIH_config au chargement des modules → le provider n'est PAS
// enregistré au chargement (contrat conditionnel testé en §9).
const { GallerySource } = await import("./image_viewer/image_viewer_source.js");
const remoteMod = await import("./image_viewer/image_viewer_source_remote.js");
const switchMod = await import("./image_viewer/image_viewer_source_switch.js");
const { imageViewerState } = await import("./image_viewer/image_viewer_state.js");
const dataMod = await import("./image_viewer/image_viewer_data.js");
const { normalizeItem, snapThumbSize, serverIdFromPath, extOfFilename, mtimeFromCreatedAt, createRemoteSource, ensureRemoteSourceRegistered, isRemoteConfigured, REMOTE_PAGE_SIZE } = remoteMod;

function mediaItem(over = {}) {
    return {
        id: 7, path: "u/7.png", filename: "7.png", subfolder: "dossier", size: 2048,
        created_at: "2024-05-01T10:00:00Z", kind: "image", favorite: true,
        tags: ["ciel", "mer"], has_prompt: true, has_workflow: false,
        status: "complete", trashed: false, ...over,
    };
}

// ── Configuration serveur GLOBALE (pour remoteGet) ──────────────────────────
function setConfig(present = true) {
    if (present) window.localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: SERVER_URL, apiKey: API_KEY }));
    else window.localStorage.removeItem("AIH_config");
}

/* ─── 1. Normalisation d'item ──────────────────────────────────────────── */
console.log("1. Normalisation d'item (mapping local → serveur)");
const norm = normalizeItem(mediaItem({ id: 42, filename: "cat.PNG", subfolder: "a/b", size: 1234, created_at: "2024-05-01T10:00:00Z", trashed: true, status: "trashed", kind: "image", favorite: false, tags: ["x"], has_prompt: false, has_workflow: true }));
assert.strictEqual(norm.path_canon, "srv:42", "clé synthétique srv:<id>");
assert.strictEqual(norm.server_id, 42, "server_id conservé");
assert.strictEqual(norm.filename, "cat.PNG");
assert.strictEqual(norm.subfolder, "a/b");
assert.strictEqual(norm.format, "PNG", "format = extension MAJUSCULE");
assert.strictEqual(norm.mtime, Date.parse("2024-05-01T10:00:00Z") / 1000, "mtime dérivé de created_at");
assert.strictEqual(norm.size_bytes, 1234);
assert.strictEqual(norm.is_trashed, true, "trashed → is_trashed");
assert.strictEqual(norm.has_edit_file, false, "pas d'édition serveur");
assert.strictEqual(norm.kind, "image");
assert.strictEqual(norm.favorite, false);
assert.deepStrictEqual(norm.tags, ["x"]);
assert.strictEqual(norm.has_prompt, false);
assert.strictEqual(norm.has_workflow, true);
assert.strictEqual(norm.width, null);
assert.strictEqual(norm.height, null);
assert.strictEqual(norm.duration_ms, null);
assert.strictEqual(norm.codec, null);
assert.strictEqual(norm.created_at, "2024-05-01T10:00:00Z");
assert.strictEqual(norm.server_status, "trashed");
assert.strictEqual(extOfFilename("a/b/c.mp4"), "mp4", "extension sans point");
assert.strictEqual(extOfFilename("noext"), "", "sans extension → ''");
assert.strictEqual(mtimeFromCreatedAt("pas une date"), 0, "date illisible → 0");
assert.strictEqual(serverIdFromPath("srv:99"), 99);
assert.strictEqual(serverIdFromPath("local.png"), null);
const prov0 = createRemoteSource({ serverUrl: SERVER_URL, apiKey: API_KEY });
assert.strictEqual(prov0.id, "remote");
assert.strictEqual(prov0.itemKey({ id: 5 }), "srv:5", "itemKey = srv:<id>");
assert.strictEqual(prov0.itemKey({ path_canon: "srv:12" }), "srv:12");
assert.strictEqual(prov0.sortKey({ mtime: 7 }), 7, "sortKey = mtime");
assert.strictEqual(prov0.pageSize, 200, "pageSize = 200 (borne serveur)");
assert.strictEqual(prov0.mode, "window");
ok("mapping complet (srv:<id>, format MAJ, mtime, size, trashed…) + itemKey/sortKey/pageSize");

/* ─── 2. Snap des tailles de vignette (vers le HAUT) ───────────────────── */
console.log("2. snapThumbSize (vers le HAUT)");
assert.strictEqual(snapThumbSize(80), 128);
assert.strictEqual(snapThumbSize(128), 128);
assert.strictEqual(snapThumbSize(129), 256);
assert.strictEqual(snapThumbSize(256), 256);
assert.strictEqual(snapThumbSize(257), 512);
assert.strictEqual(snapThumbSize(300), 512);
assert.strictEqual(snapThumbSize(513), 512, ">512 borné à 512");
assert.strictEqual(snapThumbSize(0), 256, "0/absent → défaut 256");
// Contrôle négatif : snap vers la PLUS PROCHE donnerait 129→128 (ici 256).
assert.notStrictEqual(snapThumbSize(129), 128, "surtout PAS la taille inférieure (snap vers le haut)");
ok("80→128, 129→256, 257→512, 300→512, borné/défaut");

/* ─── 3. fetchPage : URL + query + calcul de page ──────────────────────── */
console.log("3. fetchPage (page/limit + filtres)");
setConfig(true);
const src = createRemoteSource(); // config via getRemoteConfig (localStorage)
captured.length = 0;
fetchRoutes = { "/api/media?": () => jsonResponse({ items: [mediaItem({ id: 1 }), mediaItem({ id: 2 })], total: 57, page: 1, limit: 200 }) };

let page = await src.fetchPage({ offset: 0, limit: 200, filters: { folder_filters: ["root"] } });
let u = new URL(captured.at(-1).url);
assert.strictEqual(u.origin, SERVER_URL, "serverUrl résolu depuis la config");
assert.strictEqual(u.pathname, "/api/media");
assert.strictEqual(u.search, "?page=1&limit=200&subfolders=", "racine 'root' → subfolders= vide");
assert.strictEqual(page.images.length, 2, "items normalisés");
assert.strictEqual(page.images[0].path_canon, "srv:1");
assert.strictEqual(page.total_count, 57, "total_count = total serveur");
assert.strictEqual(page.total_db_count, 57);
assert.strictEqual(page.generated_thumbnails_count, 57, "pas de stats serveur → tout « généré »");
assert.strictEqual(page.filtered_count, 57);
ok("fetchPage : GET /api/media, total/items normalisés, generated=total");

// Page calculée depuis offset + limit borné à 200.
captured.length = 0;
await src.fetchPage({ offset: 400, limit: 200, filters: {} });
u = new URL(captured.at(-1).url);
assert.strictEqual(u.searchParams.get("page"), "3", "offset 400 / limit 200 → page 3");
assert.strictEqual(u.searchParams.get("limit"), "200");
captured.length = 0;
await src.fetchPage({ offset: 0, limit: 999, filters: {} });
u = new URL(captured.at(-1).url);
assert.strictEqual(u.searchParams.get("limit"), "200", "limit borné à 200");
assert.strictEqual(u.searchParams.get("page"), "1");
ok("page = floor(offset/limit)+1 ; limit borné à 200");

// Chaque filtre mappé → query exacte.
captured.length = 0;
await src.fetchPage({
    offset: 0, limit: 200,
    filters: {
        folder_filters: ["a/b", "root", "trashcan"],
        tags_filter: ["ciel", "mer"],
        filename_search: "chat",
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        favorite: true,
        sort: "name_asc",
    },
});
u = new URL(captured.at(-1).url);
assert.deepStrictEqual(u.searchParams.getAll("subfolders"), ["a/b", ""], "dossiers OU (racine = '')");
assert.strictEqual(u.searchParams.get("status"), "trashed", "'trashcan' → status=trashed");
assert.deepStrictEqual(u.searchParams.getAll("tags"), ["ciel", "mer"], "tags OU");
assert.strictEqual(u.searchParams.get("q"), "chat", "q ← filename_search");
assert.strictEqual(u.searchParams.get("from"), "2024-01-01", "from ← startDate");
assert.strictEqual(u.searchParams.get("to"), "2024-12-31", "to ← endDate");
assert.strictEqual(u.searchParams.get("favorite"), "1");
assert.strictEqual(u.searchParams.get("sort"), "name_asc");
assert.ok(!u.search.includes("locked_folders") && !u.search.includes("format_filters"), "filtres internes/non supportés absents");
ok("mapping exact de kind/dossiers/tags/q/dates/favori/tri (filtres internes exclus)");

// Pas de config → remoteGet refuse proprement (aucune requête).
setConfig(false);
await assert.rejects(() => src.fetchPage({ offset: 0, limit: 200 }), /non configuré/, "sans config → refus explicite");
setConfig(true);
ok("sans config serveur → fetchPage refuse (HolafFetchError 'non configuré')");

/* ─── 4. buildThumbnailUrl ─────────────────────────────────────────────── */
console.log("4. buildThumbnailUrl");
const tu = new URL(src.buildThumbnailUrl({ server_id: 5 }, { size: 129 }));
assert.strictEqual(tu.pathname, "/api/media/5/thumbnail");
assert.strictEqual(tu.searchParams.get("size"), "256", "129 → 256 (snap haut)");
const tu2 = new URL(src.buildThumbnailUrl({ server_id: 5 }, { size: 80 }));
assert.strictEqual(tu2.searchParams.get("size"), "128", "80 → 128");
const tu3 = src.buildThumbnailUrl({ path_canon: "srv:9" }, { size: 300 });
assert.ok(new URL(tu3).pathname.endsWith("/api/media/9/thumbnail"), "id dérivé de srv:<id>");
assert.strictEqual(new URL(tu3).searchParams.get("size"), "512");
src.setThumbnailCacheBuster("bench42");
const tu4 = new URL(src.buildThumbnailUrl({ server_id: 5 }, { size: 256 }));
assert.strictEqual(tu4.searchParams.get("v"), "bench42", "cache-buster ajouté");
src.setThumbnailCacheBuster("");
ok("buildThumbnailUrl : size snappé + cache-buster optionnel");

/* ─── 5. loadThumbnail (raw → Response, Bearer, signal) ────────────────── */
console.log("5. loadThumbnail");
captured.length = 0;
fetchRoutes = { "/thumbnail": thumbResponse };
const ac = new AbortController();
const res = await src.loadThumbnail({ server_id: 5 }, { signal: ac.signal, priority: 1 });
assert.ok(res instanceof Response, "raw:true → Response (pas de throw)");
assert.strictEqual(res.status, 200);
const lu = new URL(captured.at(-1).url);
assert.strictEqual(lu.pathname, "/api/media/5/thumbnail");
assert.strictEqual(lu.searchParams.get("size"), "256", "size d'affichage par défaut (150) → 256");
assert.strictEqual(captured.at(-1).init.method, "GET");
assert.strictEqual(captured.at(-1).init.headers.Authorization, `Bearer ${API_KEY}`, "Bearer injecté par la brique");
assert.ok(captured.at(-1).init.signal && typeof captured.at(-1).init.signal.aborted === "boolean", "signal relayé au fetch");
ok("loadThumbnail : GET thumbnail raw, size snappé, Authorization Bearer, signal");

// Un 4xx NE lève PAS en raw (la brique thumbcache lit err.status).
captured.length = 0;
fetchRoutes = { "/thumbnail": () => new Response("nope", { status: 404 }) };
const res404 = await src.loadThumbnail({ server_id: 6 }, {});
assert.strictEqual(res404.status, 404, "404 renvoyé sans throw (géré par la brique)");
ok("loadThumbnail : 404 renvoyé sans throw (raw)");

/* ─── 6. createThumbCache ──────────────────────────────────────────────── */
console.log("6. createThumbCache");
const cache = src.createThumbCache({ concurrency: 3 });
assert.strictEqual(cache.strategyName, "blob", "stratégie blob (Bearer)");
assert.strictEqual(cache.capacity, 1000, "capacité 1000");
assert.strictEqual(cache.concurrency, 3, "concurrence surchargée par l'hôte");
const cacheDefault = src.createThumbCache();
assert.ok(cacheDefault.concurrency >= 4 && cacheDefault.concurrency <= 6, "concurrence par défaut dans 4-6");
ok("createThumbCache : blob / capacity 1000 / concurrence 4-6 (surchargeable)");

// Le cache utilise BIEN loadThumbnail du provider (URL serveur + Bearer).
setConfig(true);
captured.length = 0;
objectUrls = 0;
fetchRoutes = { "/thumbnail": thumbResponse };
const cache2 = src.createThumbCache({ concurrency: 2 });
const handle = await cache2.request({ path_canon: "srv:8", server_id: 8 });
assert.ok(String(handle).startsWith("blob:"), "valeur = object URL (strategy blob)");
assert.ok(captured.some((c) => c.url.includes("/api/media/8/thumbnail") && c.init.headers.Authorization === `Bearer ${API_KEY}`),
    "la vignette est demandée via l'URL serveur AVEC Bearer");
ok("createThumbCache : request() passe par l'URL serveur + Authorization");

/* ─── 7. fetchFilterOptions ────────────────────────────────────────────── */
console.log("7. fetchFilterOptions");
captured.length = 0;
fetchRoutes = {
    "/api/media/folders": () => jsonResponse({ folders: [{ subfolder: "", count: 3 }, { subfolder: "a/b", count: 2 }], total: 5 }),
    "/api/media/tags": () => jsonResponse({ tags: [{ tag: "ciel", count: 2 }, { tag: "mer", count: 1 }], total: 2 }),
};
const opts = await src.fetchFilterOptions();
assert.deepStrictEqual(opts.subfolders, [{ path: "root", count: 3 }, { path: "a/b", count: 2 }], "'' → 'root'");
assert.deepStrictEqual(opts.tags, ["ciel", "mer"]);
assert.deepStrictEqual(opts.formats, [], "formats vide (filtres UI = étape 5)");
assert.strictEqual(opts.last_update_time, 0, "pas de last_update_time serveur");
ok("fetchFilterOptions : dossiers {path,count} + tags + formats vide");

/* ─── 8. Non supporté → null / no-op ; étape 4 fail-fast ───────────────── */
console.log("8. Non supporté / fail-fast");
assert.strictEqual(await src.fetchLastUpdateTime(), null, "pas de last-update-time (étape 6)");
assert.strictEqual(await src.fetchThumbnailStats(), null, "pas de stats serveur");
assert.strictEqual(await src.reportViewerActivity(true), null, "pas de heartbeat");
assert.strictEqual(src.loadEdits, null, "pas d'édition serveur");
assert.strictEqual(await src.prioritizeThumbnails(["srv:1"]), null, "priorisation = no-op");
for (const m of ["deleteImages", "restoreImages", "runMetadataOperation", "extractMetadata", "injectMetadata", "prepareExport", "exportChunkUrl", "fetchExportChunk", "emptyTrashcan"]) {
    assert.strictEqual(src[m], null, `action ${m} = null (non supportée)`);
}
assert.throws(() => src.resolveMediaUrl({ server_id: 1 }), /étape 4/, "resolveMediaUrl → fail-fast (plein écran)");
assert.throws(() => src.resolveInfo({ server_id: 1 }), /étape 4/, "resolveInfo → fail-fast (métadonnées)");
assert.strictEqual(src.capabilities.edit, false);
assert.strictEqual(src.capabilities.trash, false);
assert.strictEqual(src.capabilities.export, false);
assert.strictEqual(src.capabilities.extractInject, false);
assert.strictEqual(src.capabilities.favorite, true);
assert.strictEqual(src.capabilities.serverDownload, true);
assert.strictEqual(src.capabilities.pollDelta, true);
ok("null/no-op explicites + resolveMediaUrl/resolveInfo fail-fast + capabilities");

// fetchDelta = squelette vide (étape 6).
const delta = await src.fetchDelta({ filters: {}, minMtime: 123 });
assert.deepStrictEqual(delta.images, [], "delta vide (poll = étape 6)");
assert.ok(Array.isArray(delta.removed_path_canons));
ok("fetchDelta : squelette vide documenté");

// favorite / download = réellement supportés (endpoints serveur).
captured.length = 0;
fetchRoutes = { "/api/media/favorite": () => jsonResponse({ updated: 2, skipped: [] }) };
const fav = await src.favorite(["srv:1", "srv:2"]);
assert.deepStrictEqual(fav, { updated: 2, skipped: [] });
assert.strictEqual(captured.at(-1).url, `${SERVER_URL}/api/media/favorite`);
assert.deepStrictEqual(JSON.parse(captured.at(-1).init.body), { ids: [1, 2], favorite: true });
const dl = await src.download(["srv:5"]);
assert.strictEqual(dl[0].url, `${SERVER_URL}/api/media/5/download`);
ok("favorite (bulk) + download (URLs) réellement supportés");

/* ─── 9. Enregistrement conditionnel ───────────────────────────────────── */
console.log("9. Enregistrement conditionnel du provider");
setConfig(false);
GallerySource.unregister("remote");
assert.strictEqual(isRemoteConfigured(), false, "sans config → non configuré");
assert.strictEqual(ensureRemoteSourceRegistered(), false, "sans config → PAS d'enregistrement");
assert.ok(!GallerySource.has("remote"), "provider absent du registre");
// Contrôle négatif : un provider enregistré sans config serait une entorse au garde-fou.
assert.strictEqual(switchMod.evaluateSourceSwitch("remote").reason, "not-configured");

setConfig(true);
assert.strictEqual(isRemoteConfigured(), true);
assert.strictEqual(ensureRemoteSourceRegistered(), true, "config complète → enregistré");
assert.ok(GallerySource.has("remote"), "provider 'remote' présent");
assert.strictEqual(ensureRemoteSourceRegistered(), true, "idempotent");
const remoteStatus = switchMod.getRemoteStatus();
assert.strictEqual(remoteStatus.configured, true);
assert.strictEqual(remoteStatus.hasProvider, true, "le garde-fou ouvre la bascule (hasProvider)");
assert.strictEqual(switchMod.evaluateSourceSwitch("remote").ok, true, "bascule autorisée");
ok("provider enregistré SSI serveur configuré ; garde-fou étape 1 ouvert sans autre modif");

/* ─── 10. Bascule local→remote → la grille se remplit (jsdom) ──────────── */
console.log("10. Bascule + rendu de la grille serveur");
// Serveur configuré (déjà) → on importe le viewer réel APRÈS l'enregistrement.
const { default: viewer } = await import("./holaf_image_viewer.js");

const galleryEl = document.getElementById("holaf-viewer-gallery");
Object.defineProperty(galleryEl, "clientWidth", { value: 400, configurable: true });
Object.defineProperty(galleryEl, "clientHeight", { value: 600, configurable: true });
Object.defineProperty(galleryEl, "scrollTop", { value: 0, configurable: true, writable: true });
galleryEl.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600, x: 0, y: 0, toJSON() {} });

captured.length = 0;
objectUrls = 0;
fetchRoutes = {
    "/api/media/folders": () => jsonResponse({ folders: [{ subfolder: "", count: 3 }], total: 3 }),
    "/api/media/tags": () => jsonResponse({ tags: [{ tag: "ciel", count: 2 }], total: 2 }),
    "/api/media/": (url) => (String(url).includes("/thumbnail") ? thumbResponse() : jsonResponse({ items: [], total: 0 })),
    "/api/media?": () => jsonResponse({
        items: [
            mediaItem({ id: 1, filename: "serveur1.png", subfolder: "", created_at: "2024-05-03T10:00:00Z" }),
            mediaItem({ id: 2, filename: "serveur2.png", subfolder: "", created_at: "2024-05-02T10:00:00Z" }),
            mediaItem({ id: 3, filename: "clip.mp4", subfolder: "", created_at: "2024-05-01T10:00:00Z", kind: "video" }),
        ],
        total: 3, page: 1, limit: 200,
    }),
};

imageViewerState.setState({ ui: { gallery_source: "local", thumbnail_size: 150 }, filters: { folder_filters: ["root"] } });
viewer.isLoading = false;
// Le panneau n'est pas ouvert dans ce test : on fournit un panelElements factice
// (suffisant : setLoadingState n'utilise que getElementById) pour que le wrapper
// viewer.syncGallery() rende RÉELLEMENT la grille.
viewer.panelElements = {};
viewer.settings = viewer.settings || {};

const switched = await switchMod.applySourceSwitch(viewer, "remote");
assert.strictEqual(switched.ok, true, "bascule acceptée");
assert.strictEqual(GallerySource.activeId(), "remote", "source active = remote");
assert.strictEqual(imageViewerState.getState().ui.gallery_source, "remote");
assert.strictEqual(dataMod.PAGE_SIZE, 200, "PAGE_SIZE aligné sur le pageSize serveur (200)");

// La grille se remplit de médias serveur.
await sleep(150);
const st = imageViewerState.getState();
assert.strictEqual(st.totalCount, 3, "total_count serveur");
assert.strictEqual(st.images.length, 3, "tableau creux dimensionné sur le total serveur");
const cells = Array.from(document.querySelectorAll("#holaf-viewer-gallery [data-path-canon]"));
assert.ok(cells.length > 0, `des cellules sont rendues (${cells.length})`);
const renderedIds = cells.map((c) => c.dataset.pathCanon);
assert.ok(renderedIds.every((id) => id.startsWith("srv:")), "cellules liées aux médias serveur (srv:<id>)");
assert.ok(renderedIds.includes("srv:1"), "le média serveur 1 est affiché");

// Les vignettes sont demandées avec le bon size + Authorization.
const thumbReqs = captured.filter((c) => c.url.includes("/api/media/") && c.url.includes("/thumbnail"));
assert.ok(thumbReqs.length > 0, `vignettes serveur demandées (${thumbReqs.length})`);
for (const req of thumbReqs) {
    const t = new URL(req.url);
    assert.strictEqual(t.searchParams.get("size"), "256", "taille d'affichage 150 → snap 256");
    assert.strictEqual(req.init.headers.Authorization, `Bearer ${API_KEY}`, "Bearer sur chaque vignette");
}
assert.ok(objectUrls > 0, "les vignettes blob ont produit des object URLs (affichage)");
assert.ok(document.querySelectorAll("#holaf-viewer-gallery img").length > 0, "des <img> de vignette sont dessinées");
ok("bascule → PAGE_SIZE 200, grille peuplée de srv:<id>, vignettes size=256 + Bearer");

// Retour local : la source redevient locale et PAGE_SIZE repasse à 500.
const back = await switchMod.applySourceSwitch(viewer, "local");
await sleep(30);
assert.strictEqual(back.ok, true);
assert.strictEqual(GallerySource.activeId(), "local");
assert.strictEqual(dataMod.PAGE_SIZE, 500, "PAGE_SIZE revenu à 500 en local (mode local inchangé)");
ok("retour local : source et PAGE_SIZE (500) restaurés");

/* ─── 11. Contrôles négatifs ───────────────────────────────────────────── */
console.log("11. Contrôles négatifs");
// (a) snap vers le bas → rouge : la valeur 129 doit être 256, jamais 128.
assert.notStrictEqual(snapThumbSize(129), 128);
// (b) mapping absent → rouge : path_canon doit être srv:<id> (pas l'id brut).
assert.strictEqual(normalizeItem({ id: 1, filename: "a.png" }).path_canon, "srv:1");
assert.notStrictEqual(normalizeItem({ id: 1, filename: "a.png" }).path_canon, 1);
// (c) provider enregistré sans config → rouge : non configuré ⇒ non enregistré.
setConfig(false);
GallerySource.unregister("remote");
assert.strictEqual(ensureRemoteSourceRegistered(), false, "sans config : pas d'enregistrement (contrôle)");
assert.strictEqual(GallerySource.has("remote"), false);
setConfig(true);
ensureRemoteSourceRegistered();
ok("contrôles négatifs : snap vers le haut, mapping srv:<id>, enregistrement conditionnel");

console.log(`\n✅ Test provider de source serveur (étape 2) : ${n} groupes PASSENT`);

// jsdom (pretendToBeVisual) entretient une boucle rAF : on termine franchement
// une fois tous les assertions passées (aucun handle ni requête ne doit survivre).
dom.window.close();
process.exit(0);
