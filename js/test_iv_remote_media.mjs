// Test de l'ÉTAPE 4 — plein écran + panneau d'infos en mode SERVEUR.
// Usage : node js/test_iv_remote_media.mjs
//
// Verrouille, SANS aucun appel réseau réel (fetch stubé), le comportement de
// résolution du média / des métadonnées quand la source active est 'remote',
// et prouve que le mode LOCAL reste STRICTEMENT inchangé :
//   1. i18n FR/EN : parité stricte + libellés serveur présents des 2 côtés ;
//   2. resolveMediaUrl (provider) : endpoint /download, Bearer, objectURL +
//      revoke, 401/404/réseau, annulation (signal) ; vidéo/audio = REFUS sans
//      fetch ;
//   3. hôte PLEIN ÉCRAN : image serveur → fetch download → objectURL affiché,
//      revoke au CHANGEMENT d'image et à la FERMETURE (aucune fuite) ;
//   4. VIDÉO/AUDIO serveur : vignette + message, AUCUN fetch binaire, aucun
//      spinner infini ;
//   5. ÉDITEUR neutralisé (edit:false) : panneau fermé, aucun appel local
//      (/holaf/images/load-edits…) ;
//   6. resolveInfo : mapping complet + workflow_json PARSÉ + cas absents +
//      erreurs ; « Load workflow » opérationnel en mode serveur ;
//   7. MODE LOCAL inchangé : resolveMediaUrl = chaîne (URL /holaf/images/full,
//      pas d'objectURL), capacités edit/mediaPlayback/preloadFull à true ;
//   8. contrôles négatifs (retirer la revoke → rouge ; charger la vidéo →
//      rouge ; ne pas parser workflow_json → rouge).
//
// jsdom est résolu par le loader partagé ; introuvable = SKIP bruyant (exit 2).
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_iv_remote_media");

const dom = new JSDOM(`<!doctype html><html><body>
  <div id="holaf-viewer-gallery"></div>
  <div id="holaf-viewer-right-column"></div>
  <div id="holaf-viewer-zoom-view" style="display:none;">
    <img src="" draggable="false" />
    <video id="holaf-viewer-zoom-video" style="display:none;"></video>
  </div>
  <div id="holaf-viewer-fullscreen-overlay" style="display:none;">
    <img src="" draggable="false" />
    <video id="holaf-viewer-fs-video" style="display:none;"></video>
  </div>
  <div id="holaf-viewer-right-pane"><div id="holaf-viewer-info-content"></div></div>
</body></html>`, { pretendToBeVisual: true, url: "http://localhost/" });

const { window } = dom;
const { document } = window;
globalThis.window = window;
globalThis.document = document;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;
globalThis.Element = window.Element;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.MouseEvent = window.MouseEvent;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.requestAnimationFrame = window.requestAnimationFrame?.bind(window) || ((cb) => setTimeout(cb, 0));
globalThis.cancelAnimationFrame = window.cancelAnimationFrame?.bind(window) || clearTimeout;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.ResizeObserver = globalThis.ResizeObserver;

// ── AIH : ask() stubé + I18n réel (dictionnaires FR/EN) ─────────────────────
window.AIH = window.AIH || {};
window.AIH.ask = async () => true;
globalThis.AIH = window.AIH;
// Empêche holaf_api_compat.js de poller window.comfyAPI pendant 5 s.
window.comfyAPI = {
    app: { app: { registerExtension() {}, loadGraphData: () => {} } },
    api: { api: { api_base: "/" } },
};

// jsdom n'implémente pas createObjectURL → on le stubbe et on compte (fuite).
const createdUrls = [];
const revokedUrls = [];
globalThis.URL.createObjectURL = () => {
    const u = `blob:mock-${createdUrls.length + 1}`;
    createdUrls.push(u);
    return u;
};
globalThis.URL.revokeObjectURL = (u) => { revokedUrls.push(u); };

// FakeImage : capture les src ET déclenche onload (asynchrone) pour que le
// renderer hôte affecte l'URL à l'élément <img> sans réseau.
class FakeImage {
    constructor() { this.onload = null; this.onerror = null; this._src = ""; this.naturalWidth = 640; this.naturalHeight = 480; this.complete = false; }
    set src(v) {
        this._src = v;
        if (v) queueMicrotask(() => { this.complete = true; if (this.onload) this.onload(); });
    }
    get src() { return this._src; }
}
globalThis.Image = FakeImage;
window.Image = FakeImage;

// jsdom : play()/pause() inexistants sur <video> (bruit console).
if (window.HTMLMediaElement) {
    window.HTMLMediaElement.prototype.pause = function () {};
    window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
}

// ── Fetch factice : capture (url, init), routes par sous-chaîne, LOCAL détecté ─
const captured = [];
const localCalls = [];
let fetchRoutes = {};
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
function binaryResponse(status = 200) {
    return new Response(new Blob([new Uint8Array([1, 2, 3, 4])]), { status, headers: { "content-type": "image/png" } });
}
globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/holaf/images/") || u.includes("/holaf/")) {
        // Endpoint LOCAL sollicité : on le TRACE (le mode serveur ne doit jamais
        // l'appeler) et on répond une charge vide bénigne (pas d'erreur parasite).
        localCalls.push(u);
        return jsonResponse({ status: "ok" }, 200);
    }
    captured.push({ url: u, init });
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
const flush = async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
    await sleep(0);
    for (let i = 0; i < 40; i++) await Promise.resolve();
};
let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

const SERVER_URL = "https://aih.example.com:8443";
const API_KEY = "tok-999";
function setConfig(present = true) {
    if (present) window.localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: SERVER_URL, apiKey: API_KEY }));
    else window.localStorage.removeItem("AIH_config");
}
setConfig(true);

// ── 1. i18n : capture AVANT import d'aih_strings.js (parité FR/EN) ──────────
console.log("1. i18n FR/EN");
await import("./aih_i18n.js");
const I18n = window.AIH.I18n;
I18n.setLocale("fr");
const dictCapture = {};
const origAddDict = I18n.addDict.bind(I18n);
I18n.addDict = (lang, entries) => {
    dictCapture[lang] = Object.assign(dictCapture[lang] || {}, entries);
    return origAddDict(lang, entries);
};
await import("./aih_strings.js");

const frKeys = Object.keys(dictCapture.fr || {});
const enKeys = Object.keys(dictCapture.en || {});
const onlyFr = frKeys.filter((k) => !(k in (dictCapture.en || {})));
const onlyEn = enKeys.filter((k) => !(k in (dictCapture.fr || {})));
assert.deepStrictEqual(onlyFr, [], `clés FR absentes en EN : ${onlyFr.join(", ")}`);
assert.deepStrictEqual(onlyEn, [], `clés EN absentes en FR : ${onlyEn.join(", ")}`);
assert.strictEqual(frKeys.length, enKeys.length, `FR=${frKeys.length} EN=${enKeys.length}`);
for (const k of ["iv.duration", "iv.codec", "iv.viewImage", "iv.remotePlaybackUnavailable",
    "iv.remoteAuthExpired", "iv.remoteNotFound", "iv.remoteMediaError", "iv.remoteEditUnavailable"]) {
    assert.ok(k in (dictCapture.fr || {}), `clé ${k} absente en FR`);
    assert.ok(k in (dictCapture.en || {}), `clé ${k} absente en EN`);
    assert.ok(String(dictCapture.fr[k]).length > 0 && String(dictCapture.en[k]).length > 0, `${k} vide`);
}
assert.strictEqual(I18n.t("iv.remotePlaybackUnavailable"), "Lecture vidéo/audio indisponible en mode serveur pour l'instant.");
ok(`libellés serveur FR+EN + parité stricte (${frKeys.length} clés)`);

// ── Modules ─────────────────────────────────────────────────────────────────
const { GallerySource } = await import("./image_viewer/image_viewer_source.js");
const remoteMod = await import("./image_viewer/image_viewer_source_remote.js");
const { imageViewerState } = await import("./image_viewer/image_viewer_state.js");
const Nav = await import("./image_viewer/image_viewer_navigation.js");
const Infopane = await import("./image_viewer/image_viewer_infopane.js");
const { ImageEditor } = await import("./image_viewer/image_viewer_editor.js");
const { mapRemoteMetadata, isPlayableImage } = remoteMod;

const provider = remoteMod.createRemoteSource();
assert.ok(remoteMod.ensureRemoteSourceRegistered(), "provider remote enregistré (config présente)");
GallerySource.setActive("remote");
assert.strictEqual(GallerySource.activeId(), "remote");

function mediaItem(over = {}) {
    return remoteMod.normalizeItem({
        id: 1, path: "u/1.png", filename: "srv1.png", subfolder: "dossier", size: 2097152,
        created_at: "2024-05-01T10:00:00Z", kind: "image", favorite: false,
        tags: [], has_prompt: true, has_workflow: true, status: "complete", trashed: false, ...over,
    });
}

// ── 2. resolveMediaUrl (provider) ───────────────────────────────────────────
console.log("2. resolveMediaUrl (provider)");
{
    captured.length = 0; createdUrls.length = 0; revokedUrls.length = 0;
    fetchRoutes = { "/api/media/1/download": () => binaryResponse(200) };
    const res = await provider.resolveMediaUrl(mediaItem({ id: 1, kind: "image" }), {});
    assert.ok(res && typeof res === "object", "retour = { url, revoke }");
    assert.ok(String(res.url).startsWith("blob:"), "url = objectURL");
    assert.strictEqual(typeof res.revoke, "function", "revoke fourni");
    const req = captured.at(-1);
    assert.ok(new URL(req.url).pathname.endsWith("/api/media/1/download"), "endpoint = /api/media/<id>/download (original)");
    assert.strictEqual(req.init.method, "GET");
    assert.strictEqual(req.init.headers.Authorization, `Bearer ${API_KEY}`, "Bearer injecté");
    assert.strictEqual(createdUrls.length, 1, "un objectURL créé");
    res.revoke();
    assert.ok(revokedUrls.includes(res.url), "revoke() libère l'objectURL");
    ok("resolveMediaUrl : /download + Bearer → {url, revoke} ; revoke libère");
}

// 401 / 404 / réseau
{
    fetchRoutes = { "/api/media/1/download": () => new Response("nope", { status: 401 }) };
    await assert.rejects(() => provider.resolveMediaUrl(mediaItem({ id: 1 }), {}),
        (e) => e.status === 401, "401 → erreur typée status 401");
    fetchRoutes = { "/api/media/1/download": () => new Response("nope", { status: 404 }) };
    await assert.rejects(() => provider.resolveMediaUrl(mediaItem({ id: 1 }), {}),
        (e) => e.status === 404, "404 → status 404");
    fetchRoutes = { "/api/media/1/download": () => { throw new Error("boom réseau"); } };
    await assert.rejects(() => provider.resolveMediaUrl(mediaItem({ id: 1 }), {}),
        (e) => e.status === 0, "erreur réseau → status 0");
    ok("resolveMediaUrl : 401 (jeton) / 404 / réseau → erreurs typées (aucun objectURL)");
}

// Annulation (signal déjà avorté)
{
    const ac = new AbortController(); ac.abort();
    captured.length = 0;
    await assert.rejects(() => provider.resolveMediaUrl(mediaItem({ id: 1 }), { signal: ac.signal }),
        (e) => e.name === "AbortError", "signal avorté → AbortError");
    assert.strictEqual(captured.length, 0, "aucun fetch si déjà annulé");
    ok("resolveMediaUrl : annulation via signal (aucun fetch)");
}

// Vidéo/audio → REFUS avant tout fetch
{
    captured.length = 0;
    fetchRoutes = { "/download": () => binaryResponse(200) };
    await assert.rejects(() => provider.resolveMediaUrl(mediaItem({ id: 4, filename: "clip.mp4", kind: "video" }), {}),
        (e) => e.status === -1, "vidéo → refus (lecture désactivée)");
    await assert.rejects(() => provider.resolveMediaUrl(mediaItem({ id: 5, filename: "song.mp3", kind: "audio" }), {}),
        (e) => e.status === -1, "audio → refus");
    assert.strictEqual(captured.length, 0, "AUCUN binaire vidéo/audio téléchargé");
    assert.strictEqual(isPlayableImage({ kind: "video" }), false);
    assert.strictEqual(isPlayableImage({ kind: "image" }), true);
    ok("resolveMediaUrl : vidéo/audio REFUSÉS avant tout fetch (aucun binaire complet)");
}

// ── 3. resolveInfo (provider) + workflow_json PARSÉ ─────────────────────────
console.log("3. resolveInfo (provider)");
{
    captured.length = 0;
    fetchRoutes = {
        "/api/media/1/metadata": () => jsonResponse({
            id: 1, filename: "srv1.png", subfolder: "dossier", kind: "image", ext: ".png", size: 2097152,
            created_at: "2024-05-01T10:00:00Z", width: 800, height: 600, ratio: 1.3333,
            duration: null, duration_ms: null, codec: null,
            prompt: "un chat sur un tapis", workflow: JSON.stringify({ nodes: [{ id: 1, type: "KSampler" }] }),
            has_prompt: true, has_workflow: true, favorite: false, tags: [],
        }),
    };
    const info = await provider.resolveInfo(mediaItem({ id: 1 }), {});
    assert.ok(new URL(captured.at(-1).url).pathname.endsWith("/api/media/1/metadata"), "endpoint /metadata");
    assert.strictEqual(captured.at(-1).init.headers.Authorization, `Bearer ${API_KEY}`, "Bearer sur /metadata");
    assert.strictEqual(info.prompt, "un chat sur un tapis");
    assert.deepStrictEqual(info.workflow, { nodes: [{ id: 1, type: "KSampler" }] }, "workflow_json PARSÉ en objet");
    assert.strictEqual(info.width, 800);
    assert.strictEqual(info.height, 600);
    assert.strictEqual(info.ratio, "1.3333", "ratio sérialisé en chaîne");
    assert.strictEqual(info.duration_ms, null);
    assert.strictEqual(info.codec, null);
    ok("resolveInfo : /metadata + Bearer → schéma local (prompt, workflow parsé, dims/ratio)");
}

// mapRemoteMetadata : cas limites
{
    assert.strictEqual(mapRemoteMetadata({ workflow: "" }).workflow, null, "workflow vide → null");
    assert.strictEqual(mapRemoteMetadata({}).workflow, null, "workflow absent → null");
    assert.deepStrictEqual(mapRemoteMetadata({ workflow: "{ not json" }).workflow,
        { error: "Corrupt workflow JSON" }, "workflow corrompu → {error} (parité locale)");
    assert.deepStrictEqual(mapRemoteMetadata({ workflow: '{"a":1}' }).workflow, { a: 1 }, "chaîne JSON valide → objet");
    assert.strictEqual(mapRemoteMetadata({ width: 0, height: 0, ratio: "" }).ratio, null, "ratio vide → null");
    ok("mapRemoteMetadata : vide/absent/corrompu/valide");
}

// resolveInfo : erreur 500
{
    fetchRoutes = { "/api/media/1/metadata": () => new Response("boom", { status: 500 }) };
    await assert.rejects(() => provider.resolveInfo(mediaItem({ id: 1 }), {}),
        (e) => e.status === 500, "500 → erreur remontée");
    ok("resolveInfo : erreur HTTP 500 remontée");
}

// ── Harnais visionneuse (navigation réelle + brique lightbox) ───────────────
const zoomView = document.getElementById("holaf-viewer-zoom-view");
const fsOverlay = document.getElementById("holaf-viewer-fullscreen-overlay");
const galleryEl = document.getElementById("holaf-viewer-gallery");
const zoomImg = zoomView.querySelector("img");

const remoteItems = [
    mediaItem({ id: 1, filename: "srv1.png", created_at: "2024-05-03T10:00:00Z" }),
    mediaItem({ id: 2, filename: "srv2.png", created_at: "2024-05-02T10:00:00Z" }),
    mediaItem({ id: 4, filename: "clip.mp4", kind: "video", created_at: "2024-05-01T10:00:00Z" }),
];
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
        render() {}, ensureImageVisible() {}, alignImageOnExit() {},
        getColumnCount() { return 3; },
        ensureImageLoaded(i) { return Promise.resolve(remoteItems[i] || null); },
    },
};
viewer.panelElements.panelEl.style.display = "flex";
document.body.appendChild(viewer.panelElements.panelEl);
Nav.setupZoomAndPan(viewer.zoomViewState, zoomView, zoomImg);
Nav.setupZoomAndPan(viewer.fullscreenViewState, fsOverlay, fsOverlay.querySelector("img"));

function setState(over) {
    imageViewerState.setState({
        images: remoteItems,
        totalCount: remoteItems.length,
        currentNavIndex: 0,
        activeImage: remoteItems[0],
        ui: { view_mode: "gallery" },
        ...over,
    });
}

// ── 4. Plein écran IMAGE serveur : fetch + objectURL + revoke ───────────────
console.log("4. Plein écran IMAGE serveur (objectURL + revoke)");
{
    setState();
    captured.length = 0; createdUrls.length = 0; revokedUrls.length = 0; localCalls.length = 0;
    fetchRoutes = {
        "/api/media/1/download": () => binaryResponse(200),
        "/api/media/2/download": () => binaryResponse(200),
    };
    await Nav.showZoomedView(viewer, remoteItems[0]);
    await flush();
    assert.equal(zoomView.style.display, "flex", "zoom affiché");
    assert.ok(captured.some((c) => c.url.includes("/api/media/1/download") && c.init.headers.Authorization === `Bearer ${API_KEY}`),
        "le média serveur est téléchargé via /download AVEC Bearer");
    assert.ok(String(zoomImg.src).startsWith("blob:"), "l'<img> affiche l'objectURL (pas de src directe)");
    const firstBlob = zoomImg.src;
    assert.strictEqual(createdUrls.length, 1, "1 objectURL créé");
    // Badge lecture seule (édition serveur indisponible) posé dans la vue zoom.
    assert.ok(zoomView.querySelector(".holaf-viewer-readonly-badge"), "badge « lecture seule » en zoom serveur");
    ok("image serveur affichée en plein écran (fetch /download + Bearer + objectURL) + badge lecture seule");

    // Changement d'image → revoke du précédent. (Le plein média en navigation
    // est chargé avec un léger différé de 200 ms → on laisse passer ce délai.)
    await Nav.navigate(viewer, 1);
    await sleep(260);
    await flush();
    assert.ok(revokedUrls.includes(firstBlob), "objectURL du média précédent LIBÉRÉ au changement");
    assert.ok(String(zoomImg.src).startsWith("blob:") && zoomImg.src !== firstBlob, "nouveau média affiché");
    const secondBlob = zoomImg.src;

    // Fermeture → revoke du dernier.
    await Nav.handleEscape(viewer);
    await flush();
    assert.ok(revokedUrls.includes(secondBlob), "objectURL LIBÉRÉ à la fermeture de la visionneuse");
    assert.ok(!revokedUrls.includes(secondBlob) === false, "revoke effectif");
    // Aucune fuite : tout objectURL créé a été révoqué.
    assert.deepStrictEqual(createdUrls.slice().sort(), revokedUrls.slice().sort(), "tous les objectURL créés sont révoqués (0 fuite)");
    assert.strictEqual(localCalls.length, 0, "aucun endpoint local sollicité");
    ok("revoke au changement + à la fermeture ; aucune fuite d'objectURL");
}

// ── 5. VIDÉO/AUDIO serveur : vignette + message, aucun binaire ──────────────
console.log("5. VIDÉO/AUDIO serveur (vignette + message)");
{
    setState();
    captured.length = 0; createdUrls.length = 0; revokedUrls.length = 0;
    fetchRoutes = { "/api/media/4/download": () => binaryResponse(200) };
    await Nav.showZoomedView(viewer, remoteItems[2]); // clip.mp4
    await flush();
    assert.strictEqual(captured.filter((c) => c.url.includes("/download")).length, 0,
        "AUCUN binaire vidéo téléchargé (lecture désactivée)");
    const msg = zoomView.querySelector(".holaf-viewer-media-message");
    assert.ok(msg, "message affiché");
    assert.strictEqual(msg.textContent, "Lecture vidéo/audio indisponible en mode serveur pour l'instant.", "message FR explicite");
    assert.ok(!zoomView.querySelector(".holaf-viewer-loading-spinner"), "aucun spinner infini");
    assert.strictEqual(createdUrls.length, 0, "aucun objectURL (pas de binaire)");
    await Nav.handleEscape(viewer); await flush();
    ok("vidéo serveur : message explicite, aucun fetch binaire, aucun spinner");
}

// ── 6. ÉDITEUR neutralisé en mode serveur ───────────────────────────────────
console.log("6. Éditeur neutralisé (serveur)");
{
    const rightCol = document.getElementById("holaf-viewer-right-column");
    const editorViewer = { elements: { rightColumn: rightCol } };
    const editor = new ImageEditor(editorViewer);
    editor.init();
    assert.ok(editor.panelEl, "panneau éditeur créé (mais masqué)");
    localCalls.length = 0; captured.length = 0;
    fetchRoutes = {
        "/api/media/1/download": () => binaryResponse(200),
        "/api/media/1/metadata": () => jsonResponse({ id: 1, filename: "srv1.png", workflow: "", prompt: "" }),
    };
    // Mode zoom + image active : sans le garde, _show() appellerait load-edits.
    imageViewerState.setState({ activeImage: remoteItems[0], ui: { view_mode: "zoom" } });
    await flush();
    assert.strictEqual(editor.panelEl.style.display, "none", "panneau éditeur FERMÉ en mode serveur");
    assert.strictEqual(editor.activeImage, null, "éditeur sans image active (jamais _show)");
    assert.strictEqual(localCalls.length, 0, "AUCUN appel local (load-edits…) en mode serveur");
    assert.ok(!captured.some((c) => c.url.includes("load-edits")), "aucun load-edits");
    ok("éditeur serveur : panneau fermé, aucun appel local (load-edits)");
}

// ── 7. MODE LOCAL inchangé ──────────────────────────────────────────────────
console.log("7. NON-RÉGRESSION mode LOCAL");
{
    GallerySource.setActive("local");
    const caps = GallerySource.active().capabilities;
    assert.strictEqual(caps.edit, true, "local : edit true");
    assert.strictEqual(caps.mediaPlayback, true, "local : mediaPlayback true");
    assert.strictEqual(caps.preloadFull, true, "local : preloadFull true");

    const localItem = { path_canon: "loc/1.png", filename: "1.png", subfolder: "loc", format: "PNG", mtime: 123 };
    const url = GallerySource.active().resolveMediaUrl(localItem);
    assert.strictEqual(typeof url, "string", "local : resolveMediaUrl = chaîne SYNCHRONE (pas de Promise/objet)");
    assert.ok(url.includes("/holaf/images/full"), "local : endpoint /holaf/images/full");
    assert.ok(url.includes("path_canon=loc%2F1.png"), "local : path_canon dans l'URL");

    // Plein écran local : src = URL directe, AUCUN objectURL.
    const localItems = [localItem];
    imageViewerState.setState({ images: localItems, totalCount: 1, currentNavIndex: 0, activeImage: localItem, ui: { view_mode: "gallery" } });
    viewer.gallery.ensureImageLoaded = (i) => Promise.resolve(localItems[i] || null);
    createdUrls.length = 0; revokedUrls.length = 0; localCalls.length = 0;
    await Nav.showZoomedView(viewer, localItem);
    await flush();
    assert.ok(String(zoomImg.src).includes("/holaf/images/full"), "local : <img> reçoit l'URL directe /full");
    assert.strictEqual(createdUrls.length, 0, "local : AUCUN objectURL (pas de blob)");
    assert.strictEqual(zoomView.querySelector(".holaf-viewer-readonly-badge"), null, "local : aucun badge lecture seule");
    await Nav.handleEscape(viewer); await flush();
    ok("local : URL directe /full, 0 objectURL, aucun badge — comportement inchangé");
    GallerySource.setActive("remote");
}

// ── 8. PANNEAU D'INFOS serveur + « Load workflow » ──────────────────────────
console.log("8. Panneau d'infos serveur + Load workflow");
{
    const workflowObj = { nodes: [{ id: 1, type: "KSampler" }], links: [] };
    const loadCalls = [];
    window.comfyAPI.app.app.loadGraphData = (wf) => { loadCalls.push(wf); };
    const askCalls = [];
    window.AIH.ask = async (opts) => { askCalls.push(opts); return true; };

    fetchRoutes = {
        "/api/media/1/metadata": () => jsonResponse({
            id: 1, filename: "srv1.png", subfolder: "dossier", kind: "image", ext: ".png", size: 2097152,
            created_at: "2024-05-01T10:00:00Z", width: 800, height: 600, ratio: 1.3333,
            prompt: "un chat", workflow: JSON.stringify(workflowObj), has_prompt: true, has_workflow: true,
        }),
        "/api/media/2/metadata": () => jsonResponse({
            id: 2, filename: "srv2.png", subfolder: "", kind: "image", ext: ".png", size: 1024,
            created_at: "2024-05-01T10:00:00Z", width: 100, height: 100, ratio: 1,
            prompt: "", workflow: "", has_prompt: false, has_workflow: false,
        }),
        "/api/media/3/metadata": () => new Response("boom", { status: 500 }),
        "/api/media/4/metadata": () => jsonResponse({
            id: 4, filename: "clip.mp4", subfolder: "clips", kind: "video", ext: ".mp4", size: 5242880,
            created_at: "2024-06-04T12:00:00Z", width: 1280, height: 720, ratio: 1.7778,
            duration: 12.5, duration_ms: 12500, codec: "h264",
            prompt: "a running cat", workflow: "", has_prompt: true, has_workflow: false,
        }),
    };

    Infopane.setupInfoPane();
    const container = document.getElementById("holaf-viewer-info-content");
    const paneEl = () => container.querySelector(".holaf-infopane");
    const textareas = () => Array.from(container.querySelectorAll("textarea.holaf-infopane-text"));
    const buttons = () => Array.from(container.querySelectorAll("button"));

    // 8a. Item 1 : workflow_json PARSÉ → bloc + Load workflow opérationnel.
    imageViewerState.setState({ activeImage: remoteItems[0], ui: { view_mode: "gallery" } });
    await flush();
    assert.ok(container.textContent.includes("Résolution"), "champ résolution");
    assert.ok(container.textContent.includes("800x600 px"), "valeur résolution");
    assert.equal(textareas().length, 2, "blocs prompt + workflow (2 textarea)");
    assert.equal(textareas()[0].value, "un chat", "prompt serveur");
    assert.equal(textareas()[1].value, JSON.stringify(workflowObj, null, 2), "workflow_json PARSE puis sérialisé pour affichage");
    const loadBtn = buttons().find((b) => b.textContent.includes("Charger le workflow"));
    assert.ok(loadBtn && !loadBtn.disabled, "bouton Load workflow activé");
    loadBtn.click();
    await flush();
    assert.equal(askCalls.length, 1, "confirmation AIH.ask");
    assert.equal(loadCalls.length, 1, "loadGraphData appelé");
    assert.deepStrictEqual(loadCalls[0], workflowObj, "workflow PARSÉ transmis (pas la chaîne)");
    ok("panneau serveur : prompt + workflow_json parsé + Load workflow fonctionnel");

    // 8b. Item 2 : workflow/prompt absents → boutons désactivés + messages.
    imageViewerState.setState({ activeImage: remoteItems[1], ui: { view_mode: "gallery" } });
    await flush();
    const loadBtn2 = buttons().find((b) => b.textContent.includes("Charger le workflow"));
    assert.ok(loadBtn2 && loadBtn2.disabled, "Load workflow désactivé (workflow absent)");
    assert.ok(container.textContent.includes("Aucun workflow trouvé"), "message workflow absent");
    assert.ok(container.textContent.includes("Indisponible."), "message prompt indisponible");
    ok("panneau serveur : prompt/workflow absents → boutons désactivés + messages");

    // 8c. Item 3 : erreur HTTP → état erreur.
    imageViewerState.setState({ activeImage: mediaItem({ id: 3, filename: "srv3.png" }), ui: { view_mode: "gallery" } });
    await flush();
    assert.equal(paneEl().getAttribute("data-state"), "error", "erreur HTTP → état erreur");
    ok("panneau serveur : erreur HTTP → état erreur");

    // 8d. Vidéo serveur : durée + codec affichés (métadonnées détaillées).
    imageViewerState.setState({ activeImage: remoteItems[2], ui: { view_mode: "gallery" } });
    await flush();
    assert.ok(container.textContent.includes("Durée"), "champ durée présent");
    assert.ok(container.textContent.includes("0:12"), "durée formatée (12.5 s → 0:12)");
    assert.ok(container.textContent.includes("Codec"), "champ codec présent");
    assert.ok(container.textContent.includes("h264"), "codec serveur");
    ok("panneau serveur : durée + codec (métadonnées vidéo)");
}

// ── 9. Contrôles négatifs ───────────────────────────────────────────────────
console.log("9. Contrôles négatifs");
{
    // (a) Si on ne révoque pas l'objectURL, la comparaison créés/révoqués échoue.
    createdUrls.length = 0; revokedUrls.length = 0;
    const u = URL.createObjectURL(new Blob(["x"]));
    assert.strictEqual(createdUrls.length, 1);
    assert.ok(!revokedUrls.includes(u), "sans revoke : URL non libérée (le test de fuite (§4) rougirait)");
    URL.revokeObjectURL(u);

    // (b) resolveMediaUrl vidéo ne doit JAMAIS produire d'objectURL ni de fetch.
    captured.length = 0; createdUrls.length = 0;
    fetchRoutes = { "/download": () => binaryResponse(200) };
    await assert.rejects(() => provider.resolveMediaUrl(mediaItem({ id: 9, filename: "v.mp4", kind: "video" }), {}));
    assert.strictEqual(captured.length, 0, "vidéo : aucun fetch (le test §5 rougirait si on chargeait la vidéo)");
    assert.strictEqual(createdUrls.length, 0, "vidéo : aucun objectURL");

    // (c) Ne PAS parser workflow_json laisserait une chaîne → Load workflow KO.
    const notParsed = { workflow: '{"a":1}' };
    assert.notStrictEqual(notParsed.workflow, mapRemoteMetadata(notParsed).workflow, "mapRemoteMetadata parse bien (sinon §8a rougirait)");
    assert.strictEqual(typeof mapRemoteMetadata(notParsed).workflow, "object");
    ok("contrôles négatifs : revoke exigée, vidéo non chargée, workflow_json parsé");
}

console.log(`\n✅ Test étape 4 (plein écran + infos serveur) : ${n} groupes PASSENT`);

dom.window.close();
process.exit(0);
