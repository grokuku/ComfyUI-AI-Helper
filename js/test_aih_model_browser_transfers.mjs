// Tests du point d'entrée PERMANENT « Transferts » du Model Browser :
// bouton + badge, fermeture = MASQUAGE tant qu'un transfert est actif (le suivi
// n'est jamais perdu), réouverture par le bouton, ✕ par ligne toujours réel.
// jsdom + fetch stubé, AUCUN appel réseau réel.
// Usage : node js/test_aih_model_browser_transfers.mjs
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_aih_model_browser_transfers");

const dom = new JSDOM(`<!doctype html><html><body></body></html>`, {
    pretendToBeVisual: true, url: "http://localhost/",
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

const calls = { download: [], cancel: [] };
const pending = [];
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const json = (d, status = 200) =>
        new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
    if (u.includes("/auth/me")) return json({ role: "user" });
    if (u.includes("/models/local")) return json({ items: {} });
    if (u.includes("/models/remote")) {
        return json({
            items: [
                { upload_id: "uid-1", filename: "a.safetensors", type: "unet", size: 1000 },
                { upload_id: "uid-2", filename: "b.safetensors", type: "clip", size: 2000 },
                { upload_id: "uid-3", filename: "c.safetensors", type: "vae", size: 3000 },
            ],
            total: 3, page: 1, limit: 50,
        });
    }
    if (u.includes("/models/download/progress")) {
        return json({ percent: 10, bytes_recv: 10, bytes_total: 100, phase: "transferring" });
    }
    if (u.includes("/models/download/cancel")) {
        calls.cancel.push(u);
        return json({ ok: true });
    }
    if (u.includes("/models/download")) {
        if (opts && opts.body) calls.download.push(JSON.parse(opts.body));
        return new Promise((resolve) => { pending.push(resolve); });
    }
    return json({});
};
window.fetch = globalThis.fetch;
window.localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "https://aih.example.com", apiKey: "tok" }));

await import("./02_aih_model_browser.js");
for (const k of ["aihOpenModalV2", "aihShowAlert", "aihShowConfirm", "aihToast", "showConflictModal", "HolafModal"]) {
    if (typeof window[k] !== "undefined") globalThis[k] = window[k];
}

const winEl = () => document.querySelector("#aih-download-window");
const badge = () => document.querySelector(".mb-transfers-badge");
const transfersBtn = () => document.querySelector(".mb-transfers-btn");
const remoteItems = () => document.querySelectorAll("#mb-remote-list .mb-item");

/* ─── 1. Bouton + badge initiaux ─────────────────────────────────────────── */
console.log("1. Bouton « Transferts » + badge à l'ouverture");
window.openModelBrowser();
await sleep(200);
assert.ok(transfersBtn(), "bouton « Transferts » présent");
assert.ok(badge(), "badge présent");
assert.strictEqual(badge().textContent, "0", "badge à 0 sans transfert");
assert.ok(badge().classList.contains("is-empty"), "badge 0 marqué vide");
ok("bouton « Transferts » + badge 0 (aucun transfert)");

/* ─── 2. Lancement → fenêtre visible + badge 1 ───────────────────────────── */
console.log("2. Lancement → fenêtre + badge 1");
remoteItems()[0].dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
await sleep(120);
assert.ok(winEl(), "fenêtre ouverte");
assert.strictEqual(window.AIH.DownloadWindow.isVisible(), true, "fenêtre VISIBLE");
assert.strictEqual(badge().textContent, "1", "badge = 1");
assert.ok(!badge().classList.contains("is-empty"), "badge non vide");
ok("lancement → fenêtre visible + badge 1");

/* ─── 3. Fermer pendant le transfert = MASQUER (jamais perdre le suivi) ──── */
console.log("3. ✕ pendant transfert = masquer");
const headerClose = winEl().querySelector(".aih-dialog-close");
assert.ok(headerClose, "bouton ✕ d'en-tête présent");
headerClose.click();
await sleep(60);
assert.ok(winEl(), "la fenêtre reste dans le DOM (masquée, PAS détruite)");
assert.strictEqual(winEl().style.display, "none", "fenêtre masquée (display:none)");
assert.strictEqual(window.AIH.DownloadWindow.isVisible(), false, "isVisible() false après masquage");
assert.strictEqual(window.AIH.DownloadWindow.isOpen(), true, "isOpen() true : le suivi continue");
assert.strictEqual(badge().textContent, "1", "badge MAINTENU à 1 pendant le masquage");
assert.strictEqual(window.AIH.DownloadWindow.activeCount(), 1, "activeCount() = 1");
ok("✕ pendant transfert → masquage, suivi + badge maintenus");

/* ─── 4. Réouverture par le bouton « Transferts » ────────────────────────── */
console.log("4. Réouverture par le bouton");
transfersBtn().click();
await sleep(60);
assert.ok(winEl(), "fenêtre toujours présente");
assert.notStrictEqual(winEl().style.display, "none", "fenêtre ré-affichée");
assert.strictEqual(window.AIH.DownloadWindow.isVisible(), true, "isVisible() true après réouverture");
assert.strictEqual(badge().textContent, "1", "badge toujours 1");
ok("bouton « Transferts » → réouverture de la même fenêtre (suivi intact)");

/* ─── 5. ✕ par ligne toujours RÉEL (annulation) ──────────────────────────── */
console.log("5. ✕ par ligne = annulation réelle");
winEl().querySelector(".aih-dlw-cancel").click();
await sleep(60);
assert.strictEqual(calls.cancel.length, 1, "POST /models/download/cancel émis par le ✕ par ligne");
ok("✕ par ligne → annulation réelle (non modifiée)");

/* ─── 6. Fin des transferts → badge 0 → ✕ ferme vraiment ─────────────────── */
console.log("6. Fin → badge 0 → ✕ ferme");
assert.ok(pending.length >= 1, "un download en vol à résoudre");
pending.shift()(new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } }));
await sleep(150);
assert.strictEqual(badge().textContent, "0", "badge retombe à 0 après réglage");
assert.strictEqual(window.AIH.DownloadWindow.activeCount(), 0, "activeCount() = 0");
winEl().querySelector(".aih-dialog-close").click();
await sleep(60);
assert.strictEqual(winEl(), null, "sans transfert actif, ✕ ferme réellement");
assert.strictEqual(window.AIH.DownloadWindow.isOpen(), false, "isOpen() false après fermeture réelle");
ok("fin → badge 0 ; ✕ sans transfert ferme réellement");

/* ─── 7. CONTRÔLE NÉGATIF : fermeture pendant transfert ne détruit pas ───── */
console.log("7. Contrôle négatif — le ✕ actif ne détruit jamais");
remoteItems()[1].dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
await sleep(120);
assert.ok(winEl(), "nouvelle fenêtre pour le 2e transfert");
const before = winEl();
winEl().querySelector(".aih-dialog-close").click();
await sleep(40);
assert.ok(document.querySelector("#aih-download-window"), "toujours en DOM après ✕ actif");
assert.strictEqual(document.querySelector("#aih-download-window").style.display, "none", "masquée");
// La MÊME fenêtre (pas une nouvelle) doit être rouverte.
window.AIH.DownloadWindow.open();
await sleep(40);
assert.strictEqual(document.querySelector("#aih-download-window"), before, "la réouverture réutilise le MÊME nœud");
ok("contrôle négatif : ✕ actif → masquage (jamais destruction ni recréation)");

console.log(`\n✅ test_aih_model_browser_transfers : ${n} groupes PASSENT`);
try { dom.window.close(); } catch (e) { /* silencieux */ }
process.exit(0);
