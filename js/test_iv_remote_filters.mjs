// Test de l'ÉTAPE 5 — FILTRES de la source galerie « SERVEUR » (colonne gauche).
// Usage : node js/test_iv_remote_filters.mjs
//
// Verrouille, SANS aucun appel réseau réel (fetch stubé), les filtres serveur :
//   1. i18n FR/EN : clés des filtres serveur présentes + parité stricte ;
//   2. fetchFilterOptions : URLs (/api/media/folders + /api/media/tags), status
//      optionnel, mapping dossiers {path,count} ('' → 'root'), tags + comptes ;
//   3. buildMediaListQuery : chaque filtre → bon paramètre, sémantique OU pour
//      dossiers/tags, tri par défaut non émis, AUCUN paramètre local envoyé ;
//   4. persistance par source : load/save des clés remote_* (state.ui), clés
//      absentes → défauts, POST save-settings, filtres locaux NON touchés ;
//   5. UI par source (jsdom) : groupes affichés/masqués, contrôles serveur
//      présents, scopes prompt/workflow absents, listes peuplées + comptes,
//      corbeille serveur (lecture seule), RESET limité à la source active ;
//   6. bascule local ↔ serveur : chaque source recharge avec SES filtres.
//
// jsdom est résolu par le loader partagé ; introuvable = SKIP bruyant (exit 2).
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_iv_remote_filters");

const dom = new JSDOM(`<!doctype html><html><body><div id="iv-ui-root"></div></body></html>`, {
    pretendToBeVisual: true,
    url: "http://localhost/",
});
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
let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

const SERVER_URL = "https://aih.example.com:8443";
const API_KEY = "tok-123";

/* ─── 1. i18n : capture AVANT tout import d'aih_strings.js ─────────────── */
console.log("1. i18n FR/EN");
await import("./aih_i18n.js");
const I18n = window.AIH.I18n;
I18n.setLocale("fr");
const dictionaries = {};
const origAddDict = I18n.addDict.bind(I18n);
I18n.addDict = (lang, entries) => {
    dictionaries[lang] = Object.assign(dictionaries[lang] || {}, entries);
    return origAddDict(lang, entries);
};
await import("./aih_strings.js");

const REMOTE_FILTER_KEYS_I18N = [
    "iv.type", "iv.kindAll", "iv.kindImages", "iv.kindVideos", "iv.kindAudio",
    "iv.searchRemotePlaceholder", "iv.tagsAny", "iv.favoritesOnly",
    "iv.trashcanReadonly", "iv.sort", "iv.sortNewest", "iv.sortOldest",
    "iv.sortNameAsc", "iv.sortNameDesc", "iv.sortSizeDesc", "iv.sortSizeAsc",
    "iv.noFolders", "iv.noTags",
];
for (const key of REMOTE_FILTER_KEYS_I18N) {
    assert.ok(dictionaries.fr && key in dictionaries.fr, `clé ${key} absente en FR`);
    assert.ok(dictionaries.en && key in dictionaries.en, `clé ${key} absente en EN`);
}
{
    const frKeys = Object.keys(dictionaries.fr || {});
    const enKeys = Object.keys(dictionaries.en || {});
    const onlyFr = frKeys.filter((k) => !(k in (dictionaries.en || {})));
    const onlyEn = enKeys.filter((k) => !(k in (dictionaries.fr || {})));
    assert.deepStrictEqual(onlyFr, [], `clés FR absentes en EN : ${onlyFr.join(", ")}`);
    assert.deepStrictEqual(onlyEn, [], `clés EN absentes en FR : ${onlyEn.join(", ")}`);
}
ok(`libellés des filtres serveur FR+EN + parité stricte (${REMOTE_FILTER_KEYS_I18N.length} clés)`);

/* ─── 2. fetchFilterOptions : URLs + mapping dossiers/tags ─────────────── */
console.log("2. fetchFilterOptions");
const { GallerySource } = await import("./image_viewer/image_viewer_source.js");
const remoteMod = await import("./image_viewer/image_viewer_source_remote.js");
const { imageViewerState } = await import("./image_viewer/image_viewer_state.js");
const { createRemoteSource, buildMediaListQuery, readRemoteFilters, REMOTE_KIND_VALUES, REMOTE_SORT_VALUES } = remoteMod;

function setConfig(present = true) {
    if (present) window.localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: SERVER_URL, apiKey: API_KEY }));
    else window.localStorage.removeItem("AIH_config");
}
setConfig(true);
const src = createRemoteSource();

const FOLDERS_RESPONSE = { folders: [{ subfolder: "", count: 3 }, { subfolder: "a/b", count: 2 }], total: 5 };
const TAGS_RESPONSE = { tags: [{ tag: "ciel", count: 2 }, { tag: "mer", count: 1 }], total: 3 };

captured.length = 0;
fetchRoutes = {
    "/api/media/folders": () => jsonResponse(FOLDERS_RESPONSE),
    "/api/media/tags": () => jsonResponse(TAGS_RESPONSE),
};
const opts = await src.fetchFilterOptions();
assert.deepStrictEqual(opts.subfolders, [{ path: "root", count: 3 }, { path: "a/b", count: 2 }], "'' → 'root' + comptes");
assert.deepStrictEqual(opts.tags, ["ciel", "mer"], "tags = liste de chaînes");
assert.deepStrictEqual(opts.tags_detail, [{ tag: "ciel", count: 2 }, { tag: "mer", count: 1 }], "tags_detail = comptes");
assert.deepStrictEqual(opts.formats, [], "formats vide (non applicable en serveur)");
assert.deepStrictEqual(opts.kinds, ["image", "video", "audio"], "kind = valeurs proposées");
assert.strictEqual(opts.sorts.length, REMOTE_SORT_VALUES.length, "sorts = valeurs proposées");
assert.strictEqual(opts.sorts[0], "created_at_desc", "tri par défaut en tête");
assert.strictEqual(opts.last_update_time, 0, "pas de last_update_time serveur");
assert.strictEqual(opts.total, 5, "total dossiers");
const fu = new URL(captured.find((c) => c.url.includes("/api/media/folders")).url);
const tu = new URL(captured.find((c) => c.url.includes("/api/media/tags")).url);
assert.strictEqual(fu.pathname, "/api/media/folders");
assert.strictEqual(tu.pathname, "/api/media/tags");
assert.strictEqual(fu.search, "", "aucun status par défaut (vivants)");
ok("fetchFilterOptions : GET folders+tags, '' → root, comptes, formats vide, kinds/sorts");

// status optionnel → reflète la vue ('' → rien, 'trashed' → status).
captured.length = 0;
await src.fetchFilterOptions({ status: "trashed" });
assert.ok(captured.every((c) => new URL(c.url).searchParams.get("status") === "trashed"), "status=trashed propagé aux 2 endpoints");
// Par défaut, status lu depuis state.ui.remote_status.
imageViewerState.setState({ ui: { remote_status: "trashed" } });
captured.length = 0;
await src.fetchFilterOptions();
assert.ok(captured.every((c) => new URL(c.url).searchParams.get("status") === "trashed"), "status lu depuis state.ui.remote_status");
imageViewerState.setState({ ui: { remote_status: "" } });
ok("fetchFilterOptions : status optionnel / depuis state.ui (corbeille)");

/* ─── 3. buildMediaListQuery : mapping exact + OU + exclusions ──────────── */
console.log("3. buildMediaListQuery");
{
    const q = buildMediaListQuery({
        remote_kind: "video",
        remote_subfolders: ["a/b", "root", "trashcan"],
        remote_tags: ["ciel", "mer"],
        remote_q: "chat",
        remote_from: "2024-01-01",
        remote_to: "2024-12-31",
        remote_favorite: true,
        remote_sort: "name_asc",
    });
    assert.strictEqual(q.get("kind"), "video", "remote_kind → ?kind=");
    assert.deepStrictEqual(q.getAll("subfolders"), ["a/b", ""], "dossiers OU, root → ''");
    assert.strictEqual(q.get("status"), "trashed", "'trashcan' → status=trashed");
    assert.deepStrictEqual(q.getAll("tags"), ["ciel", "mer"], "tags OU");
    assert.strictEqual(q.get("q"), "chat", "remote_q → ?q=");
    assert.strictEqual(q.get("from"), "2024-01-01", "remote_from → ?from=");
    assert.strictEqual(q.get("to"), "2024-12-31", "remote_to → ?to=");
    assert.strictEqual(q.get("favorite"), "1", "remote_favorite → ?favorite=1");
    assert.strictEqual(q.get("sort"), "name_asc", "remote_sort → ?sort=");
}
ok("mapping exact : kind / dossiers OU / tags OU / q / dates / favori / tri / status");

// Défauts : aucun paramètre superflu ; 'all'/'' pour kind ; favori off ; tri défaut.
{
    const q = buildMediaListQuery({
        remote_kind: "", remote_subfolders: [], remote_tags: [], remote_q: "",
        remote_from: "", remote_to: "", remote_favorite: false, remote_status: "",
        remote_sort: "created_at_desc",
    });
    assert.strictEqual([...q.keys()].length, 0, "défauts → AUCUN paramètre (URL minimale)");
}
{
    const q = buildMediaListQuery({ remote_kind: "all" });
    assert.strictEqual(q.get("kind"), null, "'all' → pas de filtre kind");
}
ok("défauts (kind tout, aucun dossier/tag, tri created_at_desc) → aucun paramètre");

// Contrôle négatif 1 : AUCUN paramètre LOCAL n'est jamais émis.
{
    const q = buildMediaListQuery({
        remote_kind: "", remote_subfolders: [], remote_tags: [], remote_q: "",
        remote_from: "", remote_to: "", remote_favorite: false,
        remote_status: "", remote_sort: "created_at_desc",
        // clés locales fournies AUSSI : elles ne doivent PAS primer ni fuir.
        folder_filters: ["local-x"], format_filters: ["PNG"], tags_filter: ["local-tag"],
        filename_search: "local-q", prompt_search: "p", workflow_search: "w",
        locked_folders: ["local-x"], workflow_sources: ["internal_png"],
        bool_filters: { has_workflow: true }, startDate: "2000-01-01", endDate: "2000-12-31",
        favorite: true, sort: "size_asc",
    });
    const s = q.toString();
    for (const forbidden of ["folder_filters", "format_filters", "tags_filter", "filename_search",
        "prompt_search", "workflow_search", "locked_folders", "workflow_sources", "bool_filters",
        "startDate", "endDate"]) {
        assert.ok(!s.includes(forbidden), `paramètre local interdit émis : ${forbidden}`);
    }
    assert.strictEqual(q.getAll("subfolders").length, 0, "remote_* vides priment → pas de dossiers");
    assert.strictEqual(q.get("q"), null, "remote_q vide prime → pas de q");
    assert.strictEqual(q.get("favorite"), null, "remote_favorite=false prime → pas de favori");
    assert.strictEqual(q.get("sort"), null, "remote_sort par défaut → pas de sort");
}
ok("contrôle négatif : aucun paramètre local (locked_folders/formats/bool_filters…) émis");

// Contrôle négatif 2 : sans clés remote_*, le fallback générique/local marche
// (compat ascendante des appels directs) — mais il n'émet toujours pas de local.
{
    const q = buildMediaListQuery({ kind: "image", tags: ["x"], q: "y" });
    assert.strictEqual(q.get("kind"), "image");
    assert.deepStrictEqual(q.getAll("tags"), ["x"]);
    assert.strictEqual(q.get("q"), "y");
}
ok("contrôle négatif : fallback générique (kind/tags/q) hors clés remote_*");

// readRemoteFilters : reflète state.ui.
assert.deepStrictEqual(readRemoteFilters().remote_sort, "created_at_desc", "readRemoteFilters → défaut tri");
imageViewerState.setState({ ui: { remote_sort: "size_desc" } });
assert.strictEqual(readRemoteFilters().remote_sort, "size_desc", "readRemoteFilters suit state.ui");
imageViewerState.setState({ ui: { remote_sort: "created_at_desc" } });
ok("readRemoteFilters lit state.ui");

/* ─── 4. Persistance par source ────────────────────────────────────────── */
console.log("4. Persistance par source");
const Settings = await import("./image_viewer/image_viewer_settings.js");
const { REMOTE_FILTER_DEFAULTS } = await import("./image_viewer/image_viewer_state.js");

let settingsPayload = {};
fetchRoutes = {
    "/holaf/utilities/settings": () => jsonResponse({ ImageViewerUI: settingsPayload }),
    "/holaf/image-viewer/save-settings": () => jsonResponse({ status: "ok" }),
};

const fakeViewer = {
    settings: {}, zoomViewState: {}, gallery: null,
    savedSettings: [], reloadCalls: 0,
    saveSettings(s) { this.savedSettings.push(s); Settings.saveSettings(this, s); },
    async loadAndPopulateFilters() { this.reloadCalls++; },
    _applyThumbnailFit() {}, _applyThumbnailSize() {},
    _hideZoomedView() {}, _showFullscreenView() {},
};

// Clés absentes → défauts.
settingsPayload = {};
await Settings.loadSettings(fakeViewer);
let ui = imageViewerState.getState().ui;
assert.strictEqual(ui.remote_kind, "", "kind absent → ''");
assert.deepStrictEqual(ui.remote_subfolders, [], "subfolders absent → []");
assert.deepStrictEqual(ui.remote_tags, [], "tags absent → []");
assert.strictEqual(ui.remote_sort, "created_at_desc", "sort absent → created_at_desc");
assert.strictEqual(ui.remote_favorite, false, "favori absent → false");
assert.strictEqual(ui.remote_status, "", "status absent → ''");
ok("load : clés absentes → défauts (kind tout, pas de dossiers/tags, tri created_at_desc)");

// Clés présentes (dont tableaux JSON, comme folder_filters) → chargées.
settingsPayload = {
    gallery_source: "remote",
    remote_kind: "video",
    remote_subfolders: JSON.stringify(["a/b", "root"]),
    remote_tags: JSON.stringify(["ciel"]),
    remote_from: "2024-01-01", remote_to: "2024-12-31", remote_q: "chat",
    remote_favorite: "true", remote_status: "trashed", remote_sort: "name_asc",
    folder_filters: JSON.stringify(["local-keep"]),
};
await Settings.loadSettings(fakeViewer);
ui = imageViewerState.getState().ui;
assert.strictEqual(ui.remote_kind, "video");
assert.deepStrictEqual(ui.remote_subfolders, ["a/b", "root"], "tableau JSON relu");
assert.deepStrictEqual(ui.remote_tags, ["ciel"], "tableau JSON relu");
assert.strictEqual(ui.remote_favorite, true, "booléen relu");
assert.strictEqual(ui.remote_status, "trashed");
assert.strictEqual(ui.remote_sort, "name_asc");
ok("load : clés présentes (scalaires + tableaux JSON) → chargées");

// Save : les clés remote_* partent dans le POST save-settings, sans toucher
// aux filtres locaux.
imageViewerState.setState({ filters: { folder_filters: ["local-keep"], filename_search: "localq" } });
captured.length = 0;
fakeViewer.saveSettings({
    remote_kind: "audio",
    remote_subfolders: ["x/y"],
    remote_tags: ["t1", "t2"],
    remote_from: "2020-01-01", remote_to: "2020-12-31", remote_q: "foo",
    remote_favorite: true, remote_status: "", remote_sort: "size_asc",
});
await sleep(900);
const savePost = captured.find((c) => c.url.includes("/holaf/image-viewer/save-settings"));
assert.ok(savePost, "POST save-settings émis");
const body = JSON.parse(savePost.init.body);
assert.strictEqual(body.remote_kind, "audio");
assert.deepStrictEqual(body.remote_subfolders, ["x/y"], "tableau envoyé tel quel (JSON)");
assert.deepStrictEqual(body.remote_tags, ["t1", "t2"]);
assert.strictEqual(body.remote_favorite, true);
assert.strictEqual(body.remote_sort, "size_asc");
ui = imageViewerState.getState().ui;
assert.strictEqual(ui.remote_kind, "audio", "état mis à jour");
assert.deepStrictEqual(imageViewerState.getState().filters.folder_filters, ["local-keep"], "filtres locaux intacts");
assert.strictEqual(imageViewerState.getState().filters.filename_search, "localq", "recherche locale intacte");
ok("save : remote_* POSTés (tableaux JSON), filtres locaux NON touchés");

// Contrôle négatif : un patch local ne modifie pas les filtres serveur.
imageViewerState.setState({ ui: { remote_kind: "audio", remote_sort: "size_asc" } });
fakeViewer.saveSettings({ folder_filters: ["another"], filename_search: "zzz" });
assert.strictEqual(imageViewerState.getState().ui.remote_kind, "audio", "reset local n'efface pas remote_kind");
assert.strictEqual(imageViewerState.getState().ui.remote_sort, "size_asc", "reset local n'efface pas remote_sort");
ok("contrôle négatif : sauvegarde locale → filtres serveur préservés");

/* ─── 5. UI par source (jsdom) ─────────────────────────────────────────── */
console.log("5. UI par source");
setConfig(false); // Le garde-fou du switch grise « Serveur » sans config ; on teste le DOM seul.
const { UI } = await import("./image_viewer/image_viewer_ui.js");
const { applySourceSwitch } = await import("./image_viewer/image_viewer_source_switch.js");

let filterChanges = 0;
let resetCalls = 0;
UI.init(document.getElementById("iv-ui-root"), {
    getViewer: () => fakeViewer,
    onFilterChange: () => { filterChanges++; },
    onResetFilters: () => { resetCalls++; },
});
const root = document.getElementById("holaf-viewer-left-pane");
const visible = (el) => el && !el.classList.contains("holaf-src-hidden");
const groupsBySrc = (src) => Array.from(root.querySelectorAll(`[data-src="${src}"]`));

// Source locale : groupes locaux visibles, groupes serveur masqués.
imageViewerState.setState({ ui: { gallery_source: "local" } });
UI._render(imageViewerState.getState());
assert.strictEqual(root.dataset.source, "local", "pane marqué local");
assert.ok(groupsBySrc("local").length > 0 && groupsBySrc("local").every(visible), "groupes locaux visibles");
assert.ok(groupsBySrc("remote").length > 0 && groupsBySrc("remote").every((el) => !visible(el)), "groupes serveur masqués");
ok("local : groupes locaux visibles, groupes serveur masqués (.holaf-src-hidden)");

// Source serveur : l'inverse, et les contrôles serveur existent.
imageViewerState.setState({ ui: { gallery_source: "remote" } });
UI._render(imageViewerState.getState());
assert.strictEqual(root.dataset.source, "remote", "pane marqué remote");
assert.ok(groupsBySrc("remote").every(visible), "groupes serveur visibles");
assert.ok(groupsBySrc("local").every((el) => !visible(el)), "groupes locaux masqués");
for (const id of ["holaf-viewer-remote-kind", "holaf-viewer-remote-search", "holaf-viewer-remote-date-start",
    "holaf-viewer-remote-date-end", "holaf-viewer-remote-folders-filter", "holaf-viewer-remote-tags-filter",
    "holaf-viewer-remote-favorite", "holaf-viewer-remote-sort", "holaf-viewer-remote-trash"]) {
    assert.ok(document.getElementById(id), `contrôle serveur présent : #${id}`);
}
// Les scopes Prompt/Workflow (locaux) sont bien dehors du groupe de recherche serveur.
const remoteSearchGroup = document.getElementById("holaf-viewer-remote-search").closest(".holaf-viewer-filter-group");
assert.ok(!remoteSearchGroup.querySelector(".holaf-viewer-scope-buttons"), "pas de scopes prompt/workflow en serveur");
const promptScope = document.getElementById("holaf-search-scope-prompt");
const workflowScope = document.getElementById("holaf-search-scope-workflow");
assert.ok(promptScope && workflowScope, "scopes locaux toujours présents dans le DOM (mode local intact)");
assert.ok(!visible(promptScope.closest('[data-src]')) && !visible(workflowScope.closest('[data-src]')), "scopes prompt/workflow masqués en serveur");
ok("serveur : groupes serveur visibles, locaux masqués, scopes prompt/workflow absents du groupe de recherche");

// Listes peuplées depuis fetchFilterOptions (dossiers/tags + comptes).
UI.populateRemoteFilterOptions({
    subfolders: [{ path: "root", count: 3 }, { path: "a/b", count: 2 }],
    tags: ["ciel", "mer"],
    tags_detail: [{ tag: "ciel", count: 2 }, { tag: "mer", count: 1 }],
});
const folderItems = root.querySelectorAll("#holaf-viewer-remote-folders-filter .holaf-viewer-filter-item");
assert.strictEqual(folderItems.length, 2, "2 dossiers rendus");
assert.ok(folderItems[0].querySelector("label").textContent.includes("(3)"), "compte racine affiché");
assert.strictEqual(folderItems[0].dataset.folderId, "root", "dataset.folderId");
const tagItems = root.querySelectorAll("#holaf-viewer-remote-tags-filter .holaf-viewer-filter-item");
assert.strictEqual(tagItems.length, 2, "2 tags rendus");
assert.ok(tagItems[0].querySelector("label").textContent.includes("(2)"), "compte tag affiché");
assert.strictEqual(tagItems[0].dataset.tag, "ciel", "dataset.tag");
ok("populateRemoteFilterOptions : dossiers/tags rendus avec comptes");

// Interactions : dossiers (OU) + corbeille (lecture seule) + filtres locaux intacts.
imageViewerState.setState({ filters: { folder_filters: ["local-keep"] } });
UI._render(imageViewerState.getState());
const fire = (el) => el.dispatchEvent(new window.Event("change", { bubbles: true }));
const rootFolderCb = document.getElementById("remote-folder-filter-root");
rootFolderCb.checked = true;
fire(rootFolderCb);
assert.deepStrictEqual(imageViewerState.getState().ui.remote_subfolders, ["root"], "dossier coché → remote_subfolders");
const abCb = document.getElementById("remote-folder-filter-a/b");
abCb.checked = true;
fire(abCb);
assert.deepStrictEqual(imageViewerState.getState().ui.remote_subfolders, ["root", "a/b"], "multi-sélection OU");
const tagCb = document.getElementById("remote-tag-filter-ciel");
tagCb.checked = true;
fire(tagCb);
assert.deepStrictEqual(imageViewerState.getState().ui.remote_tags, ["ciel"], "tag coché → remote_tags");
assert.deepStrictEqual(imageViewerState.getState().filters.folder_filters, ["local-keep"], "filtres locaux intacts pendant interactions serveur");

// Corbeille serveur → status=trashed + dossiers grisés (lecture seule).
const trashCb = document.getElementById("holaf-viewer-remote-trash");
trashCb.checked = true;
fire(trashCb);
assert.strictEqual(imageViewerState.getState().ui.remote_status, "trashed", "corbeille → remote_status=trashed");
assert.ok(rootFolderCb.disabled && abCb.disabled, "dossiers grisés quand corbeille active");
trashCb.checked = false;
fire(trashCb);
assert.strictEqual(imageViewerState.getState().ui.remote_status, "", "décoche corbeille → statut vide");
assert.ok(!rootFolderCb.disabled, "dossiers réactivés");
ok("interactions serveur : dossiers OU, tags, corbeille (lecture seule), local préservé");

// Sélecteurs TYPE / TRI / FAVORIS / RECHERCHE.
const kindSel = document.getElementById("holaf-viewer-remote-kind");
kindSel.value = "video"; fire(kindSel);
assert.strictEqual(imageViewerState.getState().ui.remote_kind, "video", "TYPE → remote_kind");
const sortSel = document.getElementById("holaf-viewer-remote-sort");
sortSel.value = "size_desc"; fire(sortSel);
assert.strictEqual(imageViewerState.getState().ui.remote_sort, "size_desc", "TRI → remote_sort");
const favCb = document.getElementById("holaf-viewer-remote-favorite");
favCb.checked = true; fire(favCb);
assert.strictEqual(imageViewerState.getState().ui.remote_favorite, true, "FAVORIS → remote_favorite");
const search = document.getElementById("holaf-viewer-remote-search");
search.value = "chat";
search.dispatchEvent(new window.Event("input", { bubbles: true }));
assert.strictEqual(imageViewerState.getState().ui.remote_q, "chat", "RECHERCHE → remote_q");
assert.ok(filterChanges > 0, "changements déclenchent onFilterChange");
ok("sélecteurs serveur : TYPE / TRI / FAVORIS / RECHERCHE mappés sur state.ui.remote_*");

/* ─── 6. RESET limité à la source active ───────────────────────────────── */
console.log("6. RESET par source");
imageViewerState.setState({
    filters: { folder_filters: ["local-keep"], tags_filter: ["local-tag"], filename_search: "localq", startDate: "2001-01-01" },
    ui: {
        gallery_source: "remote", remote_kind: "video", remote_subfolders: ["root"],
        remote_tags: ["ciel"], remote_q: "chat", remote_favorite: true,
        remote_status: "trashed", remote_sort: "name_asc", remote_from: "2020-01-01", remote_to: "2020-12-31",
    },
});
UI._render(imageViewerState.getState());
resetCalls = 0;
document.getElementById("holaf-viewer-btn-reset-filters").click();
ui = imageViewerState.getState().ui;
assert.strictEqual(ui.remote_kind, "", "reset serveur : kind → défaut");
assert.deepStrictEqual(ui.remote_subfolders, [], "reset serveur : dossiers vidés");
assert.deepStrictEqual(ui.remote_tags, [], "reset serveur : tags vidés");
assert.strictEqual(ui.remote_q, "", "reset serveur : recherche vidée");
assert.strictEqual(ui.remote_favorite, false, "reset serveur : favoris off");
assert.strictEqual(ui.remote_status, "", "reset serveur : statut vidé");
assert.strictEqual(ui.remote_sort, "created_at_desc", "reset serveur : tri par défaut");
assert.strictEqual(ui.remote_from, "", "reset serveur : date from vidée");
assert.strictEqual(resetCalls, 0, "reset serveur n'appelle PAS le reset local");
const localFiltersAfterRemoteReset = imageViewerState.getState().filters;
assert.deepStrictEqual(localFiltersAfterRemoteReset.folder_filters, ["local-keep"], "reset serveur ne touche PAS folder_filters local");
assert.deepStrictEqual(localFiltersAfterRemoteReset.tags_filter, ["local-tag"], "reset serveur ne touche PAS tags_filter local");
ok("reset serveur : remote_* → défauts, filtres locaux INTACTS");

// Reset local : appelle le reset local, ne touche PAS les filtres serveur.
imageViewerState.setState({ ui: { gallery_source: "local", remote_kind: "audio", remote_sort: "name_asc" } });
UI._render(imageViewerState.getState());
resetCalls = 0;
document.getElementById("holaf-viewer-btn-reset-filters").click();
assert.strictEqual(resetCalls, 1, "reset local → onResetFilters appelé");
assert.strictEqual(imageViewerState.getState().ui.remote_kind, "audio", "reset local ne touche PAS remote_kind");
assert.strictEqual(imageViewerState.getState().ui.remote_sort, "name_asc", "reset local ne touche PAS remote_sort");
ok("reset local : onResetFilters appelé, filtres serveur INTACTS");

// Contrôle négatif : les défauts de reset == REMOTE_FILTER_DEFAULTS.
{
    imageViewerState.setState({ ui: { ...REMOTE_FILTER_DEFAULTS, remote_kind: "x" } });
    assert.strictEqual(REMOTE_FILTER_DEFAULTS.remote_sort, "created_at_desc");
    assert.deepStrictEqual(REMOTE_FILTER_DEFAULTS.remote_subfolders, []);
}
ok("contrôle négatif : défauts partagés = REMOTE_FILTER_DEFAULTS");

/* ─── 7. Bascule local ↔ serveur : chaque source recharge SES filtres ──── */
console.log("7. Bascule + rechargement par source");
setConfig(true);
remoteMod.ensureRemoteSourceRegistered();
fetchRoutes = {
    "/api/media/folders": () => jsonResponse(FOLDERS_RESPONSE),
    "/api/media/tags": () => jsonResponse(TAGS_RESPONSE),
    "/api/media?": () => jsonResponse({ items: [], total: 0, page: 1, limit: 200 }),
    "/holaf/images/list": () => jsonResponse({ images: [], total_count: 0, filtered_count: 0, total_db_count: 0, generated_thumbnails_count: 0 }),
};

imageViewerState.setState({
    filters: { folder_filters: ["local-a"], tags_filter: ["local-tag"], filename_search: "localq" },
    ui: { gallery_source: "local", remote_subfolders: ["remote-a"], remote_tags: ["remote-tag"], remote_q: "remoteq", remote_kind: "image", remote_sort: "name_asc" },
});

const switchViewer = {
    settings: {}, zoomViewState: {}, gallery: null,
    saveSettings() {}, async loadAndPopulateFilters() {},
};
const toRemote = await applySourceSwitch(switchViewer, "remote");
assert.strictEqual(toRemote.ok, true, "bascule serveur OK");
assert.strictEqual(GallerySource.activeId(), "remote");
captured.length = 0;
await GallerySource.active().fetchPage({ offset: 0, limit: 200, filters: imageViewerState.getState().filters });
let qu = new URL(captured.at(-1).url);
assert.strictEqual(qu.origin, SERVER_URL);
assert.deepStrictEqual(qu.searchParams.getAll("subfolders"), ["remote-a"], "requête serveur = remote_subfolders");
assert.deepStrictEqual(qu.searchParams.getAll("tags"), ["remote-tag"], "requête serveur = remote_tags");
assert.strictEqual(qu.searchParams.get("q"), "remoteq", "requête serveur = remote_q");
assert.strictEqual(qu.searchParams.get("kind"), "image");
assert.strictEqual(qu.searchParams.get("sort"), "name_asc");
assert.ok(!qu.search.includes("local-a") && !qu.search.includes("localq"), "filtres locaux ABSENTS de la requête serveur");
ok("bascule serveur → la requête utilise les filtres remote_* (pas les locaux)");

const toLocal = await applySourceSwitch(switchViewer, "local");
assert.strictEqual(toLocal.ok, true, "retour local OK");
assert.strictEqual(GallerySource.activeId(), "local");
captured.length = 0;
await GallerySource.active().fetchPage({ offset: 0, limit: 500, filters: imageViewerState.getState().filters });
const localPost = captured.at(-1);
const localBody = JSON.parse(localPost.init.body);
assert.deepStrictEqual(localBody.folder_filters, ["local-a"], "requête locale = folder_filters");
assert.deepStrictEqual(localBody.tags_filter, ["local-tag"]);
assert.strictEqual(localBody.filename_search, "localq");
assert.ok(!("remote_subfolders" in localBody) && !("remote_kind" in localBody), "aucune clé remote_* dans la requête locale");
ok("retour local → la requête utilise les filtres locaux (aucune clé remote_*)");

/* ─── 7bis. Non-régression : triggerFilterChange par source ────────────── */
console.log("7bis. triggerFilterChange par source");
const { default: viewerHost } = await import("./holaf_image_viewer.js");
imageViewerState.setState({ filters: { folder_filters: ["local-keep"], format_filters: ["PNG"] }, ui: { gallery_source: "remote" } });
GallerySource.setActive("remote");
viewerHost.panelElements = {};
viewerHost.isLoading = false;
let savedLocalFilters = null;
viewerHost.saveSettings = (s) => { savedLocalFilters = s; };
viewerHost.triggerFilterChange(false);
if (viewerHost.filterDebounceTimer) { clearTimeout(viewerHost.filterDebounceTimer); viewerHost.filterDebounceTimer = null; }
assert.strictEqual(savedLocalFilters, null, "serveur : triggerFilterChange ne relit PAS le DOM local");
assert.deepStrictEqual(imageViewerState.getState().filters.folder_filters, ["local-keep"], "filtres locaux intacts après trigger serveur");
imageViewerState.setState({ ui: { gallery_source: "local" } });
GallerySource.setActive("local");
viewerHost.triggerFilterChange(false);
if (viewerHost.filterDebounceTimer) { clearTimeout(viewerHost.filterDebounceTimer); viewerHost.filterDebounceTimer = null; }
assert.ok(savedLocalFilters && Array.isArray(savedLocalFilters.folder_filters), "local : triggerFilterChange sauvegarde bien les filtres locaux");
ok("triggerFilterChange par source : local sauvegarde, serveur ne touche pas aux filtres locaux");

/* ─── 8. Contrôles négatifs récapitulatifs ─────────────────────────────── */
console.log("8. Contrôles négatifs");
// (a) envoyer locked_folders en serveur → interdit : jamais dans l'URL.
{
    imageViewerState.setState({ filters: { locked_folders: ["secret"], folder_filters: ["x"] } });
    captured.length = 0;
    await src.fetchPage({ offset: 0, limit: 200, filters: imageViewerState.getState().filters });
    const u = new URL(captured.at(-1).url);
    assert.ok(!u.search.includes("locked_folders"), "locked_folders JAMAIS émis en serveur");
    assert.ok(!u.search.includes("secret"), "valeur verrouillée JAMAIS fuie");
}
// (b) ne pas mapper kind → rouge : remote_kind='video' DOIT produire ?kind=video.
{
    imageViewerState.setState({ filters: {}, ui: { remote_kind: "video", remote_subfolders: [], remote_tags: [] } });
    captured.length = 0;
    await src.fetchPage({ offset: 0, limit: 200 });
    assert.strictEqual(new URL(captured.at(-1).url).searchParams.get("kind"), "video", "kind mappé");
}
// (c) reset qui toucherait l'autre source → rouge (déjà couvert §6) : ici on
// s'assure que le reset serveur n'appelle pas onResetFilters local.
imageViewerState.setState({ ui: { gallery_source: "remote" } });
UI._render(imageViewerState.getState());
resetCalls = 0;
document.getElementById("holaf-viewer-btn-reset-filters").click();
assert.strictEqual(resetCalls, 0, "reset serveur ne déclenche jamais le reset local");
ok("contrôles négatifs : locked_folders interdit, kind obligatoire, reset cloisonné");

console.log(`\n✅ Test filtres source serveur (étape 5) : ${n} groupes PASSENT`);

// jsdom (pretendToBeVisual) entretient une boucle rAF : on termine franchement.
dom.window.close();
process.exit(0);
