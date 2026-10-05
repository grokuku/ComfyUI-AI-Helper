// ─────────────────────────────────────────────────────────────────────────
// AIHRemoteComparer — entrée « chaîne -> chemin de fichier » (double branche).
//
// Vérifie, en chargeant le VRAI module du pack sous jsdom :
//   * une chaîne-chemin devient un MÉDIA DIRECT servi par la route du pack
//     (/holaf/comparer/file?path=...) — image, vidéo, audio ;
//   * le genre est déduit du FICHIER (image/vidéo/audio) et un fichier non
//     prévisualisable donne un repli explicite (nom + « non prévisualisable »
//     + lien de téléchargement), jamais un faux média ni un écran vide ;
//   * NON-RÉGRESSION : une méta NON directe (tensor IMAGE/AUDIO) garde la route
//     historique /view et le même élément (Image / Audio) ;
//   * une erreur de chemin (payload.errors) affiche un message explicite ;
//   * double renderer : aucun hook node-level (Vue comme classique — l'UI est
//     un overlay DOM, indépendant du renderer de node).
//
// Usage : node js/test_remote_comparer_path.mjs
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom absent), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_remote_comparer_path");

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
});
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Event = window.Event;
globalThis.HTMLMediaElement = window.HTMLMediaElement;
globalThis.HTMLVideoElement = window.HTMLVideoElement;
globalThis.HTMLAudioElement = window.HTMLAudioElement;
globalThis.HTMLImageElement = window.HTMLImageElement;
globalThis.Image = window.Image;
globalThis.Audio = window.Audio;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame?.bind(window) || ((cb) => setTimeout(cb, 0));
globalThis.cancelAnimationFrame = window.cancelAnimationFrame?.bind(window) || clearTimeout;
globalThis.ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
};

// jsdom n'implémente ni le canvas 2D ni la lecture média : on neutralise pour
// ne tester que la LOGIQUE du comparer (URL, éléments, genre, messages).
window.HTMLCanvasElement.prototype.getContext = () => null;
Object.defineProperty(window.HTMLMediaElement.prototype, "currentTime", {
    configurable: true,
    get() { return this.__ct || 0; },
    set(v) { this.__ct = v; },
});
Object.defineProperty(window.HTMLMediaElement.prototype, "duration", {
    configurable: true,
    get() { return this.__dur ?? NaN; },
});
window.HTMLMediaElement.prototype.play = function () {};
window.HTMLMediaElement.prototype.pause = function () {};
window.HTMLMediaElement.prototype.load = function () {};

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };
const t = (key, params) => window.AIH.I18n.t(key, params);

// ── Boot « comme ComfyUI » (window.comfyAPI) ────────────────────────────────
const registered = [];
const fakeApp = {
    registerExtension(ext) { registered.push(ext); },
};
window.comfyAPI = {
    app: { app: fakeApp },
    api: {
        api: {
            api_base: "",
            apiURL: (p) => p,
            addEventListener() {},
            fetchApi: () => Promise.resolve({ ok: true }),
        },
    },
};

await import("./aih_strings.js");
window.AIH.I18n.setLocale("fr");
await import("./holaf_remote_comparer.js");

const ext = registered.find((e) => e.name === "Holaf.RemoteComparer");
assert.ok(ext, "extension Holaf.RemoteComparer enregistrée");
await ext.setup();
const comparer = fakeApp.holafRemoteComparer;
assert.ok(comparer, "comparer exposé sous app.holafRemoteComparer");

/* ── Charge une méta et déclenche la « disponibilité » (jsdom ne charge pas). */
async function loadAndFire(metas, durations = {}) {
    const p = comparer.loadMedia(metas);
    comparer.images.forEach((el, i) => {
        if (!el || el._holafGenre === "other") return;
        el.__dur = durations[i] ?? 10;
        if (typeof el.onloadeddata === "function") el.onloadeddata();
        else if (typeof el.onload === "function") el.onload();
    });
    await p;
}

/* ════════════════ 1. Chaîne-chemin -> média DIRECT (image/vidéo/audio) ═════ */
console.log("1. Chaîne-chemin -> média direct");
await loadAndFire([{ filename: "pic.png", format: "image", direct: true, path: "/tmp/out/pic.png" }]);
assert.ok(comparer.images[0] instanceof window.HTMLImageElement, "image directe -> <img>");
assert.ok(comparer.images[0].src.includes("/holaf/comparer/file?path="), "image servie par la route directe");
assert.ok(comparer.images[0].src.includes(encodeURIComponent("/tmp/out/pic.png")), "chemin encodé dans l'URL");
assert.ok(!comparer.images[0].src.includes("/view?"), "jamais la route /view pour un direct");
ok("image directe : <img> + route /holaf/comparer/file");

await loadAndFire([{ filename: "clip.mp4", format: "video", direct: true, path: "/tmp/out/clip.mp4" }]);
assert.ok(comparer.images[0] instanceof window.HTMLVideoElement, "vidéo directe -> <video>");
assert.ok(comparer.images[0].src.includes("/holaf/comparer/file?path="), "vidéo servie par la route directe");
assert.strictEqual(comparer.uiControls.container.style.display, "flex", "contrôles de lecture affichés pour une vidéo");
comparer.uiControls.timeline.value = "500";
comparer.uiControls.timeline.oninput({ target: comparer.uiControls.timeline });
assert.strictEqual(comparer.images[0].currentTime, 5, "seek : la timeline positionne currentTime (Range)");
ok("vidéo directe : <video> + contrôles + seek");

await loadAndFire([{ filename: "track.wav", format: "audio", direct: true, path: "/tmp/out/track.wav" }]);
assert.ok(comparer.images[0] instanceof window.HTMLAudioElement, "audio direct -> <audio>");
assert.ok(comparer.images[0].src.includes("/holaf/comparer/file?path="), "audio servi par la route directe");
ok("audio direct : <audio> (seek via la timeline)");

/* ══════════════ 2. Repli non prévisualisable (jamais écran vide) ═══════════ */
console.log("2. Repli non prévisualisable");
await loadAndFire([{ filename: "notes.txt", format: "other", direct: true, path: "/tmp/out/notes.txt" }]);
assert.strictEqual(comparer.images[0]._holafGenre, "other", "placeholder 'other' posé");
assert.strictEqual(comparer.images[0].src, undefined, "aucun faux média pour un fichier non prévisualisable");
assert.strictEqual(comparer.mediaLabelEl.style.display, "block", "étiquette de repli visible");
const fallbackHtml = comparer.mediaLabelEl.innerHTML;
assert.ok(fallbackHtml.includes("notes.txt"), "nom du fichier affiché");
assert.ok(fallbackHtml.includes(t("rc.notPreviewable")), "mention « non prévisualisable »");
assert.ok(fallbackHtml.includes("holaf/comparer/file?path="), "lien de téléchargement présent");
ok("fichier non prévisualisable : nom + mention + téléchargement (pas d'écran vide)");

/* ════════════════════ 3. NON-RÉGRESSION (types existants) ═════════════════ */
console.log("3. Non-régression des types existants");
await loadAndFire([{ filename: "legacy.png", type: "output", subfolder: "", format: "image" }]);
assert.ok(comparer.images[0] instanceof window.HTMLImageElement, "tensor IMAGE -> <img> (inchangé)");
assert.ok(comparer.images[0].src.includes("/view?filename=legacy.png"), "tensor IMAGE -> route /view (inchangée)");
ok("tensor IMAGE : <img> + /view (STRICTEMENT inchangé)");

await loadAndFire([{ filename: "legacy.wav", type: "temp", subfolder: "", format: "audio" }]);
assert.ok(comparer.images[0] instanceof window.HTMLAudioElement, "AUDIO -> <audio> (inchangé)");
assert.ok(comparer.images[0].src.includes("/view?filename=legacy.wav"), "AUDIO -> route /view (inchangée)");
ok("AUDIO : <audio> + /view (STRICTEMENT inchangé)");

/* ═══════════════════════ 4. Messages d'erreur explicites ═══════════════════ */
console.log("4. Messages d'erreur");
await comparer.handleNodeExecution({
    detail: {
        node: {},
        output: { ui: { holaf_payload: [{ comparison_name: "C", media: [], errors: [{ code: "not_found", detail: "/tmp/out/ghost.mp4" }] }] } },
    },
});
assert.strictEqual(comparer.statusTextEl.style.display, "block", "statut affiché pour une erreur");
assert.ok(comparer.statusTextEl.innerText.includes("ghost.mp4"), "le fichier fautif est nommé");
assert.ok(comparer.statusTextEl.innerText.includes("introuvable"), "message explicite (FR) issu du backend (not_found)");
ok("payload.errors -> message explicite (jamais silencieux)");

// Erreur de chargement client (fichier présent mais illisible/codec) :
await loadAndFire([{ filename: "legacy.png", type: "output", subfolder: "", format: "image" }]);
comparer.images[0].onerror();
assert.ok(comparer.statusTextEl.innerText.includes("legacy.png"), "erreur de lecture nomme le fichier");
ok("onerror média -> message explicite (nom du fichier)");

/* ═════════════ 5. Double renderer + i18n (FR/EN parité stricte) ════════════ */
console.log("5. Double renderer + i18n");
assert.strictEqual(ext.beforeRegisterNodeDef, undefined, "aucun hook node-level (Vue comme classique)");
assert.strictEqual(ext.nodeCreated, undefined, "aucun hook node-level nodeCreated");
// L'UI est un overlay DOM : elle fonctionne identiquement en Vue.
window.LiteGraph = { vueNodesMode: true };
await loadAndFire([{ filename: "clip.mp4", format: "video", direct: true, path: "/tmp/out/clip.mp4" }]);
assert.ok(comparer.images[0] instanceof window.HTMLVideoElement, "mode Vue : la vidéo directe fonctionne encore");
window.LiteGraph = { vueNodesMode: false };
ok("double renderer : aucun hook node-level, l'overlay DOM marche dans les deux modes");

const frMsg = window.AIH.I18n.t("rc.errNotFound", { name: "X.mp4" });
window.AIH.I18n.setLocale("en");
const enMsg = window.AIH.I18n.t("rc.errNotFound", { name: "X.mp4" });
assert.ok(frMsg.includes("X.mp4") && enMsg.includes("X.mp4"), "interpolation du nom");
assert.notStrictEqual(frMsg, enMsg, "FR et EN diffèrent (clé traduite des deux côtés)");
assert.ok(enMsg.toLowerCase().includes("not found"), "EN réel = 'not found'");
ok("i18n FR/EN : clés rc.errNotFound présentes et interpolées");

comparer.stopAnimation();
console.log(`\n✅ Remote Comparer — chaîne-chemin : ${n} groupes d'assertions OK`);
process.exit(0);
