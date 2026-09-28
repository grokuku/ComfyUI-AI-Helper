// Test de contrat — REGISTRE de sources de la galerie (ÉTAPE 0).
// Usage : node js/test_iv_source.mjs
//
// Verrouille le CADRE « source » (js/image_viewer/image_viewer_source.js) SANS
// dépendre du DOM ni de la suite vendue :
//   1. registre : register/active/setActive/unregister + active() par défaut
//      = 'local' ;
//   2. provider local : itemKey = path_canon, pageSize = 500, mode 'window' ;
//   3. adaptateurs : chaque méthode appelle BIEN l'endpoint attendu (stub fetch)
//      et compose le corps attendu (retrait des filtres internes, limit/offset,
//      skip_count, min_mtime, force…) ;
//   4. contrôles négatifs : setActive inconnue → lève ; unregister('local') →
//      active() lève (pas de repli silencieux) ; le squelette 'remote' n'est
//      PAS enregistré et lève « non implémenté » ;
//   5. les actions non supportées en local (favorite/download) sont null.
//
// Aucune dépendance jsdom : un `window` minimal (location.origin) suffit aux
// constructeurs d'URL. Un stub `fetch` global capture les requêtes.
import assert from "node:assert";

// `window` minimal AVANT l'import (les constructeurs d'URL lisent location.origin).
globalThis.window = globalThis.window || { location: { origin: "http://localhost" } };

const { GallerySource, LOCAL_ENDPOINTS } = await import("./image_viewer/image_viewer_source.js");
const { createRemoteSource } = await import("./image_viewer/image_viewer_source_remote.js");

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

// ── Stub fetch : capture (url, init) et renvoie du JSON ────────────────────
let captured = [];
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
globalThis.fetch = async (url, init = {}) => {
    captured.push({ url: String(url), init });
    return jsonResponse({ ok: true });
};
const last = () => captured[captured.length - 1];
const lastBody = () => JSON.parse(last().init.body);

/* ─── 1. Registre : enregistrement + active() par défaut = 'local' ───────── */
console.log("1. Registre");
assert.strictEqual(GallerySource.activeId(), "local", "active par défaut = 'local'");
assert.ok(GallerySource.has("local"), "la source 'local' est enregistrée");
assert.deepStrictEqual(GallerySource.list(), ["local"], "une seule source enregistrée");
const src = GallerySource.active();
assert.strictEqual(src.id, "local");
ok("register('local') + active() par défaut = 'local'");

/* ─── 2. Provider local : clé, pageSize, mode ──────────────────────────── */
console.log("2. Provider local");
assert.strictEqual(src.pageSize, 500, "pageSize = 500");
assert.strictEqual(src.mode, "window", "mode = 'window'");
assert.strictEqual(src.itemKey({ path_canon: "a/b.png" }), "a/b.png", "itemKey = path_canon");
assert.strictEqual(src.itemKey({}), null, "itemKey d'un item sans path_canon = null");
assert.strictEqual(src.itemKey(null), null, "itemKey(null) = null");
const col = src.createCollection();
for (const m of ["at", "windowStart", "setWindow", "resetWindowCache", "insertTop", "removeByIds", "bindState"]) {
    assert.strictEqual(typeof col[m], "function", `createCollection() expose ${m}()`);
}
ok("itemKey=path_canon, pageSize=500, mode=window, collection vendue configurée");

/* ─── 3. fetchPage : endpoint + corps ──────────────────────────────────── */
console.log("3. fetchPage");
captured = [];
await src.fetchPage({ offset: 0, limit: 500, filters: { folder_filters: ["root"], locked_folders: ["root"] } });
assert.ok(last().url.includes(LOCAL_ENDPOINTS.list), "POST /holaf/images/list");
assert.strictEqual(last().init.method, "POST");
assert.strictEqual(lastBody().limit, 500, "limit transmis");
assert.strictEqual(lastBody().offset, 0, "offset transmis");
assert.deepStrictEqual(lastBody().folder_filters, ["root"], "filtres transmis");
assert.ok(!("locked_folders" in lastBody()), "locked_folders (interne) retiré du corps");
assert.ok(!captured.some(c => c.url.includes(LOCAL_ENDPOINTS.thumbnail)), "aucun appel vignette parasite");
captured = [];
await src.fetchPage({ offset: 500, limit: 500, filters: {}, skipCount: true });
assert.strictEqual(lastBody().skip_count, true, "skip_count transmis pour les fenêtres");
assert.strictEqual(lastBody().offset, 500, "offset de fenêtre transmis");
captured = [];
await src.fetchPage({ filters: { filename_search: "x" } });
assert.ok(!("limit" in lastBody()), "sans limit explicite : pas de limit/offset");
ok("fetchPage : /holaf/images/list, filtres nettoyés, limit/offset/skip_count");

/* ─── 4. fetchDelta ────────────────────────────────────────────────────── */
console.log("4. fetchDelta");
captured = [];
await src.fetchDelta({ filters: { locked_folders: ["z"], filename_search: "x" }, minMtime: 123 });
assert.ok(last().url.includes(LOCAL_ENDPOINTS.list), "POST /holaf/images/list");
assert.strictEqual(lastBody().min_mtime, 123, "min_mtime transmis");
assert.strictEqual(lastBody().filename_search, "x");
assert.ok(!("locked_folders" in lastBody()), "locked_folders retiré");
ok("fetchDelta : min_mtime + filtres (sans locked_folders)");

/* ─── 5. Options / poll / stats / activité / edits ─────────────────────── */
console.log("5. Options, poll, stats, activité, edits");
captured = [];
await src.fetchFilterOptions();
assert.ok(last().url.includes(LOCAL_ENDPOINTS.filterOptions) && last().init.method === "GET");
await src.fetchLastUpdateTime();
assert.ok(last().url.includes(LOCAL_ENDPOINTS.lastUpdateTime) && last().init.method === "GET");
await src.fetchThumbnailStats();
assert.ok(last().url.includes(LOCAL_ENDPOINTS.thumbnailStats) && last().init.method === "GET");
captured = [];
await src.reportViewerActivity(true);
assert.ok(last().url.includes(LOCAL_ENDPOINTS.viewerActivity));
assert.deepStrictEqual(lastBody(), { active: true });
captured = [];
await src.loadEdits("a b/c.png");
assert.ok(last().url.includes(`${LOCAL_ENDPOINTS.loadEdits}?path_canon=${encodeURIComponent("a b/c.png")}`));
ok("filter-options / last-update-time / thumbnail-stats / viewer-activity / load-edits");

/* ─── 6. Vignette : URL + chargement ───────────────────────────────────── */
console.log("6. Vignette");
const tu = src.buildThumbnailUrl({ path_canon: "p", filename: "f.png", subfolder: "d", thumb_hash: "H", mtime: 5 });
assert.ok(tu.startsWith("http://localhost/holaf/images/thumbnail?"), "endpoint /holaf/images/thumbnail");
const tuu = new URL(tu);
assert.strictEqual(tuu.searchParams.get("filename"), "f.png");
assert.strictEqual(tuu.searchParams.get("subfolder"), "d");
assert.strictEqual(tuu.searchParams.get("path_canon"), "p");
assert.strictEqual(tuu.searchParams.get("mtime"), "H", "thumb_hash prioritaire comme cache-buster");
const tu2 = src.buildThumbnailUrl({ path_canon: "p", filename: "f", subfolder: "", mtime: 5 }, { forceReload: true });
assert.ok(new URL(tu2).searchParams.get("t"), "forceReload ajoute un cache-buster t");
captured = [];
await src.loadThumbnail({ path_canon: "p", filename: "f", subfolder: "", mtime: 5 }, { priority: 0 });
assert.ok(last().url.includes("/holaf/images/thumbnail"), "loadThumbnail tape la vignette");
assert.strictEqual(last().init.priority, "low", "priority basse forwardée");
captured = [];
await src.loadThumbnail({ path_canon: "p", filename: "f", subfolder: "", mtime: 5 }, { priority: 1 });
assert.strictEqual(last().init.priority, "high", "priority haute forwardée");
ok("buildThumbnailUrl + loadThumbnail (raw, priority)");

/* ─── 7. Média plein écran + infos ─────────────────────────────────────── */
console.log("7. resolveMediaUrl / resolveInfo");
const mu = src.resolveMediaUrl({ path_canon: "p/c.png", mtime: 7 });
assert.ok(mu.startsWith("http://localhost/holaf/images/full?"), "endpoint /holaf/images/full");
assert.strictEqual(new URL(mu).searchParams.get("path_canon"), "p/c.png");
assert.strictEqual(new URL(mu).searchParams.get("mtime"), "7");
const mu2 = src.resolveMediaUrl({ filename: "f.png", subfolder: "d", mtime: 1 });
assert.strictEqual(new URL(mu2).searchParams.get("filename"), "f.png", "repli filename");
assert.strictEqual(new URL(mu2).searchParams.get("type"), "output", "repli type=output");
assert.strictEqual(src.resolveMediaUrl(null), "");
captured = [];
await src.resolveInfo({ filename: "f.png", subfolder: "d" });
assert.ok(last().url.includes("/holaf/images/metadata?"));
assert.strictEqual(new URL(last().url).searchParams.get("filename"), "f.png");
assert.strictEqual(new URL(last().url).searchParams.get("subfolder"), "d");
ok("resolveMediaUrl (/full) + resolveInfo (/metadata)");

/* ─── 8. Actions ───────────────────────────────────────────────────────── */
console.log("8. Actions");
captured = [];
await src.deleteImages(["a"], { permanent: false });
assert.ok(last().url.includes(LOCAL_ENDPOINTS.delete) && !last().url.includes("permanently"), "delete (corbeille)");
await src.deleteImages(["a"], { permanent: true });
assert.ok(last().url.includes(LOCAL_ENDPOINTS.deletePermanently), "delete-permanently");
await src.restoreImages(["a"]);
assert.ok(last().url.includes(LOCAL_ENDPOINTS.restore));
await src.extractMetadata(["a"]);
assert.ok(last().url.includes(LOCAL_ENDPOINTS.extractMetadata));
assert.deepStrictEqual(lastBody(), { paths_canon: ["a"], force: false });
await src.injectMetadata(["a"]);
assert.ok(last().url.includes(LOCAL_ENDPOINTS.injectMetadata));
await src.runMetadataOperation("extract", ["a"], { force: true });
assert.ok(last().url.includes(LOCAL_ENDPOINTS.extractMetadata));
assert.strictEqual(lastBody().force, true, "overwrite force=true");
await src.prepareExport({ paths_canon: ["a"] });
assert.ok(last().url.includes(LOCAL_ENDPOINTS.prepareExport));
await src.emptyTrashcan();
assert.ok(last().url.includes(LOCAL_ENDPOINTS.emptyTrashcan));
ok("delete/restore/extract/inject/prepare-export/empty-trashcan");

/* ─── 9. Export chunk ──────────────────────────────────────────────────── */
console.log("9. Export chunk");
const eu = new URL(src.exportChunkUrl({ exportId: "E", filePath: "m.json", chunkIndex: 0, chunkSize: 1000 }));
assert.strictEqual(eu.pathname, "/holaf/images/export-chunk");
assert.strictEqual(eu.searchParams.get("export_id"), "E");
assert.strictEqual(eu.searchParams.get("file_path"), "m.json");
assert.strictEqual(eu.searchParams.get("chunk_index"), "0");
captured = [];
await src.fetchExportChunk({ exportId: "E", filePath: "x", chunkIndex: 1, chunkSize: 2 });
assert.ok(last().url.includes(LOCAL_ENDPOINTS.exportChunk));
ok("exportChunkUrl + fetchExportChunk");

/* ─── 10. Priorisation + capacités + thumbCache ────────────────────────── */
console.log("10. Priorisation, capacités, thumbCache");
captured = [];
await src.prioritizeThumbnails(["a", "b"]);
assert.ok(last().url.includes(LOCAL_ENDPOINTS.prioritizeThumbnails));
assert.deepStrictEqual(lastBody(), { paths_canon: ["a", "b"] });
assert.strictEqual(src.capabilities.pollDelta, true);
assert.strictEqual(src.capabilities.trash, true);
assert.strictEqual(src.capabilities.favorite, false, "favorite non supporté en local");
assert.strictEqual(src.capabilities.serverDownload, false, "serverDownload non supporté en local");
assert.strictEqual(src.favorite, null, "action favorite = null (nullable selon capacités)");
assert.strictEqual(src.download, null, "action download = null");
const cache = src.createThumbCache({ concurrency: 3 });
assert.strictEqual(typeof cache.request, "function", "createThumbCache() renvoie une instance");
assert.strictEqual(typeof cache.has, "function");
ok("prioritize-thumbnails + capabilities + instance thumbCache dédiée");

/* ─── 11. Contrôles négatifs ───────────────────────────────────────────── */
console.log("11. Contrôles négatifs");
assert.throws(() => GallerySource.setActive("inexistante"), /source inconnue/, "setActive inconnue → lève");
assert.strictEqual(GallerySource.activeId(), "local", "l'échec ne change pas la source active");
assert.throws(() => GallerySource.register("", {}), /id requis/, "register sans id → lève");
assert.throws(() => GallerySource.register("bis", null), /provider requis/, "register sans provider → lève");

// active() ne fait AUCUN repli silencieux si la source active disparaît.
GallerySource.unregister("local");
assert.strictEqual(GallerySource.has("local"), false);
assert.throws(() => GallerySource.active(), /source active inconnue/, "unregister('local') → active() lève");
GallerySource.register("local", src); // restaure
assert.strictEqual(GallerySource.active().id, "local");

// Bascule de registre (contrat de setActive, non branché à l'UI en étape 0).
const dummy = { id: "dummy" };
GallerySource.register("dummy", dummy);
assert.strictEqual(GallerySource.setActive("dummy").id, "dummy", "setActive renvoie le provider");
assert.strictEqual(GallerySource.active().id, "dummy");
GallerySource.setActive("local");
assert.strictEqual(GallerySource.active().id, "local", "retour à local");
GallerySource.unregister("dummy");
assert.ok(!GallerySource.has("dummy"));

// Le squelette remote existe mais n'est PAS enregistré (étape 2).
const remote = createRemoteSource();
assert.strictEqual(remote.id, "remote");
assert.ok(!GallerySource.has("remote"), "le squelette 'remote' n'est PAS enregistré");
assert.throws(() => remote.fetchPage({}), /non implémenté/, "remote.fetchPage → fail-fast (étape 2)");
assert.strictEqual(GallerySource.active().id, "local", "l'import du squelette ne bascule pas la source");
ok("setActive/register/unregister validés, remote non activable, active() par défaut préservé");

console.log(`\n✅ Test registre de sources (contrat étape 0) : ${n} groupes PASSENT`);
