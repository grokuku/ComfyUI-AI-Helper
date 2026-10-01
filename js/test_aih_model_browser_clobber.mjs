// Scénario PROUVÉ de l'UI « ancienne » malgré un fichier servi à jour :
// DEUX copies de 02_aih_model_browser.js coexistent dans la même page (deux
// préfixes /extensions/<nom>/ — dossier legacy conservé, cf. ComfyUI qui
// charge CHAQUE custom_node exposant WEB_DIRECTORY). L'import parallèle du
// front est non déterministe : une copie PÉRIMÉE (qui ne connaît ni le bouton
// « Transferts » ni la fenêtre) pouvait s'exécuter en DERNIER et écraser
// window.openModelBrowser.
//
// Ce test installe une fonction legacy SANS marqueur AVANT le chargement des
// extensions, puis vérifie que la copie courante REPREND la main, le DIT
// (console.error) et rend bien l'UI complète (bouton + libellé + fenêtre).
//
// Usage : node js/test_aih_model_browser_clobber.mjs
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";
import { loadAllExtensions } from "./test_helpers/ext_load.mjs";
import { assertVisible } from "./test_helpers/visibility.mjs";

const JSDOM = await loadJsdomOrSkip("test_aih_model_browser_clobber");

const dom = new JSDOM(`<!doctype html><html><body></body></html>`, {
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
globalThis.URL.createObjectURL = () => "blob:mock";
globalThis.URL.revokeObjectURL = () => {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

const consoleErrors = [];
const origError = console.error.bind(console);
console.error = (...a) => { consoleErrors.push(a.map(String).join(" ")); origError(...a); };

const setupHooks = [];
window.comfyAPI = {
    app: {
        app: {
            registerExtension(ext) { if (ext && typeof ext.setup === "function") setupHooks.push(ext.setup); },
            api: {},
        },
    },
    api: { api: { api_base: "/" } },
};
window.app = window.comfyAPI.app.app;

// ↓ LA COPIE PÉRIMÉE : fonction installée AVANT le chargement du pack courant,
// exactement comme une 2e instance du module qui s'exécuterait en premier.
const legacyCalls = [];
window.openModelBrowser = function legacyOpenModelBrowser() { legacyCalls.push("legacy"); };

globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const json = (d) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
    if (u.includes("aih_build_probe")) {
        // Fichier servi sans marqueur de build (fichier périmé) : la page doit
        // le dire bruyamment, mais la copie COURANTE garde la main.
        return new Response("/* AIH Model Browser — vieux fichier sans marqueur de build */", {
            status: 200, headers: { "content-type": "text/javascript" },
        });
    }
    if (u.includes("/auth/me")) return json({ role: "user" });
    if (u.includes("/models/local")) return json({ items: {} });
    if (u.includes("/models/remote")) {
        return json({ items: [{ upload_id: "uid-1", filename: "m.safetensors", type: "unet", size: 1 }], total: 1, page: 1, limit: 50 });
    }
    if (u.includes("/models/download/progress")) return json({ percent: 10, bytes_recv: 1, bytes_total: 10 });
    if (u.includes("/models/download")) return new Promise(() => {});
    return json({});
};
window.fetch = globalThis.fetch;
window.localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "https://aih.example.com", apiKey: "tok" }));

/* ─── 1. Chargement : la copie courante reprend la main ──────────────────── */
console.log("1. Copie périmée déjà installée → reprise de la main par le build courant");
const results = await loadAllExtensions();
const byFile = Object.fromEntries(results.map((r) => [r.file, r]));
assert.ok(byFile["02_aih_model_browser.js"] && byFile["02_aih_model_browser.js"].ok,
    "02_aih_model_browser.js chargé sans exception");
for (const k of ["aihOpenModalV2", "aihShowAlert", "aihShowConfirm", "aihToast", "HolafModal"]) {
    if (typeof window[k] !== "undefined") globalThis[k] = window[k];
}
assert.notStrictEqual(window.openModelBrowser, undefined, "openModelBrowser publié");
assert.strictEqual(window.openModelBrowser.__aihMbBuild, "mb-transfers-2026-09-30-r7",
    "la fonction publiée est la copie COURANTE (estampillée)");
legacyCalls.length = 0;
window.openModelBrowser();
await sleep(50);
assert.strictEqual(legacyCalls.length, 0, "la fonction legacy n'est JAMAIS appelée");
assert.ok(document.getElementById("aih-modal-model-browser"), "l'UI courante s'ouvre (parcours réel)");
assert.ok(consoleErrors.some((l) => /ÉCRASÉ/.test(l) && /REFUSÉ/.test(l)),
    "la reprise de la main est journalisée (console.error)");
assert.strictEqual(window.AIH_MB.clobberedBy, "sans-marqueur", "diagnostic clobberedBy exposé");
assert.ok(window.AIH_MB.clobberRefused >= 1, "compteur de refus exposé");
await sleep(60);
assert.strictEqual(window.AIH_MB.stale, true,
    "la page reste signalée obsolète (copie périmée présente) même si le build courant s'exécute");

// Contrats du garde : même build = silencieux ; build antérieur = refusé ;
// build réellement plus récent = prioritaire (aucune régression de version).
const refusedCount = window.AIH_MB.clobberRefused;
const sameBuildFn = function sameBuildOpen() {};
sameBuildFn.__aihMbBuild = "mb-transfers-2026-09-30-r7";
window.openModelBrowser = sameBuildFn;
assert.strictEqual(window.openModelBrowser, sameBuildFn, "même build accepté (deux instances du même fichier)");
assert.strictEqual(window.AIH_MB.clobberRefused, refusedCount, "aucune alerte pour le même build");
window.openModelBrowser = window.AIH_MB.openModelBrowser; // restaure la copie courante
const olderFn = function olderBuild() {};
olderFn.__aihMbBuild = "mb-transfers-2026-09-30-r6";
window.openModelBrowser = olderFn;
assert.notStrictEqual(window.openModelBrowser, olderFn, "build antérieur (r6) refusé");
const newerFn = function newerBuild() {};
newerFn.__aihMbBuild = "2099-01-01-r1";
window.openModelBrowser = newerFn;
assert.strictEqual(window.openModelBrowser, newerFn,
    "build réellement plus récent prioritaire (r10/r99 gérés par rang, pas par tri de chaîne)");
window.openModelBrowser = window.AIH_MB.openModelBrowser; // restaure pour la suite
assert.strictEqual(window.openModelBrowser.__aihMbBuild, "mb-transfers-2026-09-30-r7", "copie courante restaurée");
ok("garde : même build silencieux, build antérieur refusé, build plus récent prioritaire");
ok("copie périmée neutralisée + journalisée, UI courante ouverte, page signalée obsolète");

/* ─── 2. L'UI courante est COMPLÈTE (bouton + libellé + fenêtre) ─────────── */
console.log("2. L'UI rendue est bien la nouvelle (bouton + libellé + fenêtre)");
await sleep(80);
const modal = document.getElementById("aih-modal-model-browser");
const btn = modal.querySelector(".mb-transfers-btn");
assert.ok(btn, "bouton « Transferts » présent");
assertVisible(assert, btn, "bouton « Transferts »", { window });
const label = modal.querySelector(".mb-build-label");
assert.ok(label && label.textContent === "mb-transfers-2026-09-30-r7", "libellé de build courant présent");
assertVisible(assert, label, "libellé de build", { window });
const row = modal.querySelector("#mb-remote-list .mb-item");
assert.ok(row, "ligne distante rendue");
row.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
await sleep(150);
const dlw = document.getElementById("aih-download-window");
assert.ok(dlw, "fenêtre de transferts ouverte (le legacy ne pouvait pas le faire)");
assertVisible(assert, dlw, "fenêtre de transferts", { window });
ok("UI complète : bouton, libellé et fenêtre VISIBLES malgré la copie périmée");

/* ─── 3. Le banner stale est visible dans la fenêtre du navigateur ───────── */
console.log("3. Bandeau « build obsolète » visible (copie périmée détectée)");
window.openModelBrowser(); // re-rendu : le bandeau doit s'afficher
await sleep(80);
const staleBanner = modal.querySelector("#mb-stale-banner");
assert.ok(staleBanner, "bandeau stale présent");
assertVisible(assert, staleBanner, "bandeau stale", { window });
ok("bandeau « recharge FORCÉE » VISIBLE quand la page a chargé une copie périmée");

console.log(`\n✅ test_aih_model_browser_clobber : ${n} groupes PASSENT`);
try { dom.window.close(); } catch (e) { /* silencieux */ }
process.exit(0);
