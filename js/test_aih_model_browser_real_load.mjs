// Test du CHEMIN DE CHARGEMENT RÉEL de ComfyUI pour le Model Browser.
// jsdom + fetch stubé, AUCUN appel réseau réel.
// Usage : node js/test_aih_model_browser_real_load.mjs
//
// Contexte (signalement utilisateur) : « J'ai rien qui s'ouvre quand je
// double-clique. » Le test historique importait 02_aih_model_browser.js en
// ISOLÉ — il ne prouvait donc PAS que le module est chargé par ComfyUI. Ici on
// reproduit le chemin réel : le front importe EN PARALLÈLE tous les .js du
// WEB_DIRECTORY (GET /api/extensions → import()), comme
// comfyui-frontend-src/src/services/extensionService.ts#loadExtensions.
//
// Verrous :
//   1. 02_aih_model_browser.js ET aih_download_window.js se chargent sans
//      exception dans le chargement parallèle complet ;
//   2. window.AIH.DownloadWindow.open + window.openModelBrowser exposés ;
//   3. double-clic sur une ligne DISTANTE → fenêtre ouverte + POST download ;
//   4. point d'entrée permanent « Transferts » + badge présents dans l'UI.
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";
import { loadAllExtensions } from "./test_helpers/ext_load.mjs";

const JSDOM = await loadJsdomOrSkip("test_aih_model_browser_real_load");

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
window.comfyAPI = { app: { app: { registerExtension() {}, api: {} } }, api: { api: { api_base: "/" } } };
globalThis.URL.createObjectURL = () => "blob:mock";
globalThis.URL.revokeObjectURL = () => {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

const calls = { download: [] };
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const json = (d, status = 200) =>
        new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
    if (u.includes("/auth/me")) return json({ role: "user" });
    if (u.includes("/models/local")) return json({ items: {} });
    if (u.includes("/models/remote")) {
        return json({
            items: [
                { upload_id: "uid-1", filename: "Krea2.safetensors", type: "unet", size: 13500000000 },
                { upload_id: "uid-2", filename: "clip_l.safetensors", type: "clip", size: 246000000 },
            ],
            total: 2, page: 1, limit: 50,
        });
    }
    if (u.includes("/models/download/progress")) {
        return json({ percent: 5, bytes_recv: 5, bytes_total: 100, phase: "transferring" });
    }
    if (u.includes("/models/download/cancel")) return json({ ok: true });
    if (u.includes("/models/download")) {
        if (opts && opts.body) calls.download.push(JSON.parse(opts.body));
        return new Promise(() => {}); // reste en vol : rien n'est réglé
    }
    return json({});
};
window.fetch = globalThis.fetch;
window.localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "https://aih.example.com", apiKey: "tok" }));

/* ─── 1. Chargement RÉEL façon ComfyUI (import parallèle du WEB_DIRECTORY) ── */
console.log("1. Chargement réel (import parallèle de tous les .js du WEB_DIRECTORY)");
const results = await loadAllExtensions();
const byFile = Object.fromEntries(results.map((r) => [r.file, r]));
for (const f of ["02_aih_model_browser.js", "aih_download_window.js", "aih_dialog.js", "aih_strings.js"]) {
    assert.ok(byFile[f], `${f} fait bien partie des extensions servies`);
    assert.strictEqual(byFile[f].ok, true,
        `${f} importé sans exception (erreur: ${byFile[f].error && byFile[f].error.message})`);
}
ok("02_aih_model_browser.js + aih_download_window.js chargés par le chemin RÉEL (import parallèle)");

// Dans un vrai navigateur window === globalThis : les helpers posés sur window
// par aih_dialog.js sont accessibles en référence GLOBALE (aihOpenModalV2).
// Sous Node/jsdom, globalThis ≠ window : on recopie les globales du pack.
for (const k of ["aihOpenModalV2", "aihShowAlert", "aihShowConfirm", "aihShowPrompt", "aihToast", "showConflictModal", "HolafModal"]) {
    if (typeof window[k] !== "undefined") globalThis[k] = window[k];
}

/* ─── 2. API exposée par le chargement réel ──────────────────────────────── */
console.log("2. API exposée");
assert.strictEqual(typeof window.openModelBrowser, "function", "window.openModelBrowser exposé");
assert.ok(window.AIH && window.AIH.DownloadWindow, "window.AIH.DownloadWindow exposé");
assert.strictEqual(typeof window.AIH.DownloadWindow.open, "function", "AIH.DownloadWindow.open est une fonction");
ok("openModelBrowser + AIH.DownloadWindow.open disponibles après le chargement réel");

/* ─── 3. Double-clic sur la liste DISTANTE → fenêtre + transfert ──────────── */
console.log("3. Double-clic distant → fenêtre + téléchargement");
window.openModelBrowser();
await sleep(200);
const remoteItems = () => document.querySelectorAll("#mb-remote-list .mb-item");
assert.strictEqual(remoteItems().length, 2, "deux modèles distants listés");

remoteItems()[0].dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
await sleep(120);

const dlw = document.querySelector("#aih-download-window");
assert.ok(dlw, "la fenêtre de progression est OUVERTE au double-clic");
assert.strictEqual(document.querySelectorAll("#aih-download-window .aih-dlw-row").length, 1, "une ligne de progression");
assert.strictEqual(calls.download.length, 1, "le téléchargement est bien parti");
assert.strictEqual(calls.download[0].upload_id, "uid-1", "upload_id du modèle double-cliqué");
ok("double-clic distant → fenêtre ouverte (1 ligne) + POST /models/download");

/* ─── 4. Point d'entrée permanent « Transferts » + badge ─────────────────── */
console.log("4. Bouton « Transferts » + badge");
const transfersBtn = document.querySelector(".mb-transfers-btn");
assert.ok(transfersBtn, "bouton « Transferts » présent dans la barre d'outils");
const badge = document.querySelector(".mb-transfers-badge");
assert.ok(badge, "badge de compteur présent");
assert.strictEqual(badge.textContent, "1", "badge = 1 transfert en cours");
ok("bouton « Transferts » + badge (1) présents après un lancement");

console.log(`\n✅ test_aih_model_browser_real_load : ${n} groupes PASSENT`);
try { dom.window.close(); } catch (e) { /* silencieux */ }
process.exit(0);
