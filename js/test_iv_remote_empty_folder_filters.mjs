// Test de RÉGRESSION — galerie PACK, source « SERVEUR » qui restait VIDE alors
// que les dossiers/compteurs s'affichaient. Usage : node js/test_iv_remote_empty_folder_filters.mjs
//
// BUG RÉEL (capture utilisateur) : en source « Serveur », le panneau dossiers
// affichait `2026-09-27 (28)`, `2026-09-28 (130)`, `2026-09-30 (60)` cochés
// (données de GET /api/media/folders) mais la zone principale disait « Aucune
// image ne correspond aux filtres actuels. » — AUCUNE requête de liste n'était
// même émise.
//
// CAUSE : le court-circuit « dossiers LOCAUX tous décochés » de
// `holaf_image_viewer.js#loadFilteredImages` (folder_filters === []) s'appliquait
// aussi à la source serveur, AVANT tout fetch ; de plus `imageViewerState
// #getState()` convertissait `folder_filters: null` (« jamais choisi » = pas de
// filtre) en `[]` (« tout décoché » = zéro image), rendant le tri-état documenté
// inatteignable.
//
// CE QUE CE TEST VERROUILLE (sans réseau, fetch stubé) :
//   1. tri-état de getState : null reste null, [] reste [], tableau recopié ;
//   2. état EXACT de la capture (remote, 3 dossiers datés cochés, Type=Tout,
//      dates/recherche vides) + folder_filters local = [] → la liste /api/media
//      DOIT être demandée avec les bons `subfolders` répétés et rendue ;
//   3. même état avec folder_filters ABSENT (null) → la liste DOIT charger ;
//   4. NON-RÉGRESSION locale : folder_filters=[] → zéro requête et placeholder
//      (comportement historique conservé) ;
//   5. NON-RÉGRESSION locale : folder_filters absent (null) → requête avec
//      `folder_filters: null` (contrat backend « pas de filtre ») et images ;
//   6. contrôle négatif : remote_subfolders vide = AUCUN paramètre subfolders
//      (l'absence de sélection serveur = tout, pas « zéro image »).
//
// Contrôles par MUTATION (prouvés en session) :
//   M1 retirer `GallerySource.activeId() !== 'remote' &&` du court-circuit
//      → §2 rouge (0 requête /api/media, 0 image rendue) ;
//   M2 revenir à `[...(state.filters.folder_filters || [])]` dans getState
//      → §3 et §5 rouges (null converti en [], court-circuit/contrat cassés).
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_iv_remote_empty_folder_filters");

const dom = new JSDOM(
    `<!doctype html><html><body><div id="iv-ui-root"></div><div id="holaf-viewer-gallery" style="width:1000px;height:700px"></div></body></html>`,
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
// Empêche holaf_api_compat.js de poller window.comfyAPI pendant 5 s.
window.comfyAPI = {
    app: { app: { registerExtension() {} } },
    api: { api: { api_base: "/" } },
};
globalThis.URL.createObjectURL = () => "blob:mock";
globalThis.URL.revokeObjectURL = () => {};

// ── Serveur factice : capture (url, init) + routes par sous-chaîne ──────────
const captured = [];
let settingsPayload = {};
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

const CAPTURE_FOLDERS = {
    folders: [
        { subfolder: "2026-09-27", count: 28 },
        { subfolder: "2026-09-28", count: 130 },
        { subfolder: "2026-09-30", count: 60 },
    ],
    total: 218,
};
function srvItem(id, folder) {
    return {
        id, filename: `img-${id}.png`, subfolder: folder, size: 1000, kind: "image",
        created_at: `2026-09-28 10:00:0${id % 10}`, status: "complete", trashed: 0,
        favorite: 0, tags: [], has_prompt: 0, has_workflow: 0,
    };
}
const SRV_LIST_PAGE = {
    items: [srvItem(1, "2026-09-27"), srvItem(2, "2026-09-27"), srvItem(3, "2026-09-28"),
            srvItem(4, "2026-09-28"), srvItem(5, "2026-09-28"), srvItem(6, "2026-09-30")],
    total: 6, page: 1, limit: 200,
};
const LOCAL_FILTER_OPTIONS = {
    subfolders: [{ path: "root", count: 1 }, { path: "d1", count: 2 }],
    formats: ["PNG"], tags: [], last_update_time: 0,
};
const LOCAL_LIST = {
    images: [
        { path_canon: "d1/a.png", filename: "a.png", subfolder: "d1", format: "PNG", mtime: 1, size_bytes: 1, is_trashed: false, has_edit_file: false },
        { path_canon: "d1/b.png", filename: "b.png", subfolder: "d1", format: "PNG", mtime: 2, size_bytes: 1, is_trashed: false, has_edit_file: false },
    ],
    total_count: 2, filtered_count: 2, total_db_count: 2, generated_thumbnails_count: 2,
};

globalThis.fetch = async (url, init = {}) => {
    captured.push({ url: String(url), init });
    const u = String(url);
    if (u.includes("/holaf/utilities/settings")) return jsonResponse({ ImageViewerUI: settingsPayload });
    if (u.includes("/holaf/image-viewer/save-settings")) return jsonResponse({ status: "ok" });
    if (u.includes("/holaf/images/filter-options")) return jsonResponse(LOCAL_FILTER_OPTIONS);
    if (u.includes("/holaf/images/list")) return jsonResponse(LOCAL_LIST);
    if (u.includes("/api/media/folders")) return jsonResponse(CAPTURE_FOLDERS);
    if (u.includes("/api/media/tags")) return jsonResponse({ tags: [], total: 0 });
    if (u.includes("/api/media?") || /\/api\/media$/.test(u)) return jsonResponse(SRV_LIST_PAGE);
    throw new Error(`Unexpected fetch: ${u}`);
};
window.fetch = globalThis.fetch;

const SERVER_URL = "https://aih.example.com";
const API_KEY = "tok-regression";
window.localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: SERVER_URL, apiKey: API_KEY }));

// ── Modules réels ───────────────────────────────────────────────────────────
const { imageViewerState } = await import("./image_viewer/image_viewer_state.js");
const { GallerySource } = await import("./image_viewer/image_viewer_source.js");
const { UI } = await import("./image_viewer/image_viewer_ui.js");
const { reconcileStoredSource } = await import("./image_viewer/image_viewer_source_switch.js");
const { default: viewerHost } = await import("./holaf_image_viewer.js");

// Stubs de rendu : on observe CE QUI SERAIT RENDU, sans grille/DOM virtualisé.
const syncCalls = [];
let loadingMsg = null;
viewerHost.syncGallery = (images) => { syncCalls.push(images); };
viewerHost.updateStatusBar = () => {};
viewerHost.setLoadingState = (m) => { loadingMsg = m; };
viewerHost._updateActionButtonsState = () => {};
viewerHost.panelElements = {};

UI.init(document.getElementById("iv-ui-root"), {
    getViewer: () => viewerHost,
    onFilterChange: () => viewerHost.triggerFilterChange(),
    onResetFilters: () => {},
});

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };
const srvListFetches = () => captured.filter((c) => { try { return new URL(c.url).pathname === "/api/media"; } catch (e) { return false; } });
const localListFetches = () => captured.filter((c) => c.url.includes("/holaf/images/list"));
const lastRendered = () => syncCalls.length ? syncCalls[syncCalls.length - 1] : null;

/* ─── 1. Tri-état de getState (brique de base du correctif) ───────────── */
console.log("1. getState : null ≠ [] (folder_filters/format_filters)");
{
    imageViewerState.setState({ filters: { folder_filters: null, format_filters: null } });
    assert.strictEqual(imageViewerState.getState().filters.folder_filters, null, "null reste null (pas de filtre)");
    assert.strictEqual(imageViewerState.getState().filters.format_filters, null, "format_filters null reste null");
    imageViewerState.setState({ filters: { folder_filters: [], format_filters: [] } });
    assert.deepStrictEqual(imageViewerState.getState().filters.folder_filters, [], "[] reste [] (tout décoché)");
    imageViewerState.setState({ filters: { folder_filters: ["root"], format_filters: ["PNG"] } });
    assert.deepStrictEqual(imageViewerState.getState().filters.folder_filters, ["root"], "tableau recopié");
    const snap = imageViewerState.getState().filters.folder_filters;
    snap.push("mutation");
    assert.deepStrictEqual(imageViewerState.getState().filters.folder_filters, ["root"], "copie isolée de l'état");
}
ok("getState préserve le tri-état : null (jamais choisi) ≠ [] (tout décoché)");

/* ─── 2. LA CAPTURE : remote + 3 dossiers cochés + folder_filters=[] ──── */
console.log("2. Source serveur, état exact de la capture, folder_filters local = []");
{
    settingsPayload = {
        gallery_source: "remote",
        folder_filters: "[]", // persisté par une session locale antérieure (ou bug historique)
        remote_kind: "",      // Type = Tout
        remote_subfolders: JSON.stringify(["2026-09-27", "2026-09-28", "2026-09-30"]),
        remote_tags: "[]",
        remote_from: "", remote_to: "", remote_q: "", // dates/recherche vides
        remote_favorite: false, remote_status: "", remote_sort: "created_at_desc",
    };
    captured.length = 0; syncCalls.length = 0; loadingMsg = null;
    await viewerHost.loadSettings();
    await reconcileStoredSource(viewerHost);

    const lf = srvListFetches();
    assert.strictEqual(lf.length, 1, "LA LISTE SERVEUR DOIT ÊTRE DEMANDÉE (bug : 0 requête → galerie vide)");
    const u = new URL(lf[0].url);
    assert.strictEqual(u.origin, SERVER_URL, "même hôte que la config");
    assert.strictEqual(u.pathname, "/api/media");
    assert.strictEqual(u.searchParams.get("page"), "1");
    assert.strictEqual(u.searchParams.get("limit"), "200", "pageSize distant aligné sur PAGE_LIMIT_MAX");
    assert.deepStrictEqual(u.searchParams.getAll("subfolders"),
        ["2026-09-27", "2026-09-28", "2026-09-30"], "dossiers cochés → subfolders RÉPÉTÉS (exacts)");
    assert.strictEqual(u.searchParams.get("kind"), null, "Type=Tout → aucun kind");
    assert.strictEqual(u.searchParams.get("from"), null, "dates vides → aucun from");
    assert.strictEqual(u.searchParams.get("to"), null, "dates vides → aucun to");
    assert.strictEqual(u.searchParams.get("q"), null, "recherche vide → aucun q");
    assert.strictEqual(lf[0].init.headers.Authorization, `Bearer ${API_KEY}`, "Bearer présent");

    // Panneau serveur : les 3 dossiers sont rendus AVEC comptes ET cochés.
    const items = document.querySelectorAll("#holaf-viewer-remote-folders-filter .holaf-viewer-filter-item");
    assert.strictEqual(items.length, 3, "3 dossiers serveur rendus");
    assert.ok(items[0].querySelector("label").textContent.includes("(28)"), "compteur affiché");
    assert.strictEqual(document.querySelectorAll("#holaf-viewer-remote-folders-filter input:checked").length, 3,
        "3 dossiers cochés (comme la capture)");

    // La liste est RENDUE : le placeholder « aucune image » n'est PAS le résultat.
    const rendered = lastRendered();
    assert.ok(Array.isArray(rendered) && rendered.length === 6, "6 médias rendus (bug : tableau vide)");
    assert.strictEqual(imageViewerState.getState().totalCount, 6);
    assert.strictEqual(imageViewerState.getState().status.error, null, "aucune erreur avalée");
}
ok("capture (remote + folder_filters=[]) : requête /api/media émise + 6 médias rendus");

/* ─── 3. Remote + folder_filters ABSENT (null) ─────────────────────────── */
console.log("3. Source serveur, folder_filters absent des réglages (null)");
{
    const payload = { ...settingsPayload };
    delete payload.folder_filters;
    settingsPayload = payload;
    captured.length = 0; syncCalls.length = 0; loadingMsg = null;
    await viewerHost.loadSettings();
    assert.strictEqual(imageViewerState.getState().filters.folder_filters, null, "clé absente → null (jamais [])");
    await viewerHost.loadAndPopulateFilters(true);

    assert.strictEqual(srvListFetches().length, 1, "liste demandée malgré folder_filters null");
    assert.deepStrictEqual(new URL(srvListFetches()[0].url).searchParams.getAll("subfolders"),
        ["2026-09-27", "2026-09-28", "2026-09-30"], "filtres serveur intacts");
    assert.strictEqual(lastRendered().length, 6, "6 médias rendus");
}
ok("remote + folder_filters null : la liste charge (null = pas de filtre, pas « zéro image »)");

/* ─── 4. NON-RÉGRESSION locale : folder_filters=[] → zéro image ────────── */
console.log("4. Source locale, dossier(s) décochés = [] (comportement historique)");
{
    settingsPayload = { gallery_source: "local", folder_filters: "[]", format_filters: null };
    captured.length = 0; syncCalls.length = 0; loadingMsg = null;
    await viewerHost.loadSettings();
    await reconcileStoredSource(viewerHost);

    assert.strictEqual(localListFetches().length, 0, "aucune requête locale (court-circuit conservé)");
    const rendered = lastRendered();
    assert.ok(Array.isArray(rendered) && rendered.length === 0, "placeholder affiché (0 image)");
}
ok("local + folder_filters=[] : court-circuit conservé (0 requête, 0 image)");

/* ─── 5. NON-RÉGRESSION locale : folder_filters null → tout charger ────── */
console.log("5. Source locale, folder_filters absent (null) → toutes les images");
{
    settingsPayload = { gallery_source: "local" };
    captured.length = 0; syncCalls.length = 0; loadingMsg = null;
    await viewerHost.loadSettings();
    await viewerHost.loadAndPopulateFilters(true);

    assert.strictEqual(localListFetches().length, 1, "la liste locale est demandée");
    const body = JSON.parse(localListFetches()[0].init.body);
    assert.strictEqual(body.folder_filters, null, "contrat backend local : null = PAS de filtre (≠ zéro image)");
    assert.strictEqual(lastRendered().length, 2, "images locales rendues");
}
ok("local + folder_filters null : requête `folder_filters: null` + images (contrat backend)");

/* ─── 6. Contrôle négatif : sélection serveur vide = tout ──────────────── */
console.log("6. Contrôle négatif : remote_subfolders [] → aucun paramètre subfolders");
{
    settingsPayload = {
        gallery_source: "remote",
        folder_filters: "[]",
        remote_subfolders: "[]", // « Aucun » côté serveur = pas de filtre (tout), PAS zéro image
        remote_kind: "", remote_tags: "[]", remote_from: "", remote_to: "", remote_q: "",
        remote_favorite: false, remote_status: "", remote_sort: "created_at_desc",
    };
    captured.length = 0; syncCalls.length = 0;
    await viewerHost.loadSettings();
    await reconcileStoredSource(viewerHost);
    assert.strictEqual(srvListFetches().length, 1, "liste demandée (sélection vide ≠ court-circuit)");
    assert.deepStrictEqual(new URL(srvListFetches()[0].url).searchParams.getAll("subfolders"), [],
        "aucun subfolders émis");
    assert.strictEqual(lastRendered().length, 6, "tous les médias rendus");
}
ok("contrôle négatif : sélection serveur vide → pas de paramètre subfolders (tout est montré)");

console.log(`\n✅ Test régression galerie serveur vide (folder_filters) : ${n} groupes PASSENT`);

// jsdom (pretendToBeVisual) entretient une boucle rAF : on termine franchement.
dom.window.close();
process.exit(0);
