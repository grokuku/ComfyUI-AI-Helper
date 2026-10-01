// TOUS les points d'entrée de TÉLÉCHARGEMENT du Model Browser doivent ouvrir
// la FENÊTRE de transferts (js/aih_download_window.js) — jamais l'ancien
// affichage « en ligne » seul. La capture utilisateur (« Download terminé » +
// barre verte en bas, AUCUNE fenêtre) prouve qu'au moins un chemin pouvait
// encore y retomber.
//
// Deux verrous complémentaires :
//   1. DYNAMIQUE : espionne AIH.DownloadWindow.open/addFile/startFile et
//      rejoue les 3 chemins réels (double-clic, bouton « Download selected »
//      du pied, reprise après conflit) — la fenêtre doit être VISIBLE et la
//      ligne du fichier démarrée pour CHACUN ;
//   2. STRUCTUREL : dans js/02_aih_model_browser.js, toute fonction qui appelle
//      _downloadRequest() doit aussi piloter la fenêtre (_dlWinAdd/_dlWinStart/
//      _dlWinOpen). Un NOUVEAU chemin ajouté sans fenêtre fait échouer ce test.
//
// Usage : node js/test_aih_model_browser_download_paths.mjs
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";
import { loadAllExtensions } from "./test_helpers/ext_load.mjs";
import { assertVisible, assertStackedAbove } from "./test_helpers/visibility.mjs";

const JSDOM = await loadJsdomOrSkip("test_aih_model_browser_download_paths");

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

window.comfyAPI = { app: { app: { registerExtension() {}, api: {} } }, api: { api: { api_base: "/" } } };

const calls = { download: [], added: [], started: [], opened: 0 };
let pendingDownloads = [];
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const json = (d, status = 200) =>
        new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
    if (u.includes("aih_build_probe")) {
        const src = readFileSync(new URL("./02_aih_model_browser.js", import.meta.url), "utf-8");
        return new Response(src, { status: 200, headers: { "content-type": "text/javascript" } });
    }
    if (u.includes("/auth/me")) return json({ role: "user" });
    if (u.includes("/models/local")) return json({ items: {} });
    if (u.includes("/models/remote")) {
        return json({
            items: [
                { upload_id: "uid-1", filename: "a.safetensors", type: "unet", size: 1000 },
                { upload_id: "uid-2", filename: "b.safetensors", type: "clip", size: 2000 },
            ],
            total: 2, page: 1, limit: 50,
        });
    }
    if (u.includes("/models/download/progress")) return json({ percent: 5, bytes_recv: 5, bytes_total: 100 });
    if (u.includes("/models/download/cancel")) return json({ ok: true });
    if (u.includes("/models/download")) {
        calls.download.push(JSON.parse(opts.body));
        return new Promise((resolve) => { pendingDownloads.push(resolve); });
    }
    return json({});
};
window.fetch = globalThis.fetch;
window.localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "https://aih.example.com", apiKey: "tok" }));

function resolveNextDownload(data, status = 200) {
    assert.ok(pendingDownloads.length > 0, "aucun download en attente");
    pendingDownloads.shift()(new Response(JSON.stringify(data), {
        status, headers: { "content-type": "application/json" },
    }));
}

/* ─── 0. Chargement + espions sur la fenêtre ─────────────────────────────── */
console.log("0. Chargement réel + espions AIH.DownloadWindow");
const results = await loadAllExtensions();
const byFile = Object.fromEntries(results.map((r) => [r.file, r]));
assert.ok(byFile["02_aih_model_browser.js"].ok && byFile["aih_download_window.js"].ok, "modules chargés");
for (const k of ["aihOpenModalV2", "aihShowAlert", "aihShowConfirm", "aihToast", "HolafModal"]) {
    if (typeof window[k] !== "undefined") globalThis[k] = window[k];
}

const DW = window.AIH.DownloadWindow;
assert.ok(DW, "AIH.DownloadWindow exposé");
// addFile/startFile vivent sur le CONTRÔLEUR renvoyé par open() (pas sur le
// module) : on enveloppe open() puis on espionne les méthodes du contrôleur.
const realOpen = DW.open.bind(DW);
DW.open = function (...args) {
    calls.opened++;
    const w = realOpen(...args);
    if (w && !w.__spied) {
        w.__spied = true;
        for (const m of ["addFile", "startFile"]) {
            const orig = w[m].bind(w);
            w[m] = function (...a) {
                (m === "addFile" ? calls.added : calls.started).push(a[0]);
                return orig(...a);
            };
        }
    }
    return w;
};
ok("espions posés sur open()/addFile()/startFile()");

window.openModelBrowser();
await sleep(150);
const modal = document.getElementById("aih-modal-model-browser");
assert.ok(modal, "Model Browser ouvert");
const rows = () => Array.from(document.querySelectorAll("#mb-remote-list .mb-item"));
assert.strictEqual(rows().length, 2, "deux modèles distants");

const dlw = () => document.getElementById("aih-download-window");
function assertWindowFor(label) {
    assert.ok(dlw(), `${label} : la fenêtre de transferts doit exister`);
    assertVisible(assert, dlw(), `fenêtre de transferts (${label})`, { window });
    assertStackedAbove(assert, dlw(), modal, `fenêtre vs Model Browser (${label})`, window);
}

/* ─── 1. Double-clic liste distante ──────────────────────────────────────── */
console.log("1. Double-clic distant → fenêtre + ligne démarrée");
let before = calls.opened;
rows()[0].dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
await sleep(150);
assert.ok(calls.opened > before, "AIH.DownloadWindow.open() appelé");
assert.ok(calls.added.includes("uid-1") || calls.started.includes("uid-1"),
    "le fichier double-cliqué est suivi par la fenêtre");
assert.ok(calls.started.includes("uid-1"), "startFile(uid-1) appelé (phase transfert)");
assertWindowFor("double-clic");
ok("double-clic → fenêtre VISIBLE + startFile(uid-1)");

resolveNextDownload({ success: true, path: "/models/a.safetensors" });
await sleep(120);
DW.dismiss();
await sleep(30);

/* ─── 2. Bouton « Download selected » du pied de panneau ─────────────────── */
console.log("2. Bouton du pied « Download selected » → fenêtre + ligne démarrée");
rows()[1].click();
await sleep(20);
assert.ok(!modal.querySelector(".mb-batch-download").disabled, "bouton du pied activé après sélection");
before = calls.opened;
modal.querySelector(".mb-batch-download").click();
await sleep(150);
assert.ok(calls.opened > before, "AIH.DownloadWindow.open() appelé pour le lot");
assert.ok(calls.started.includes("uid-2"), "startFile(uid-2) appelé (le lot démarre la ligne)");
assertWindowFor("download selected");
ok("bouton du pied → fenêtre VISIBLE + startFile(uid-2)");

resolveNextDownload({ success: true, path: "/models/b.safetensors" });
await sleep(120);
DW.dismiss();
await sleep(30);

/* ─── 3. Reprise après conflit ───────────────────────────────────────────── */
console.log("3. Reprise après conflit → fenêtre toujours pilotée");
const confirmStub = window.aihShowConfirm;
const yes = () => Promise.resolve(true);
window.aihShowConfirm = yes;
globalThis.aihShowConfirm = yes;
before = calls.opened;
rows()[0].dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
await sleep(120);
const downloadsBeforeRetry = calls.download.length;
resolveNextDownload({ success: true, conflict: true, local: { size: 1 }, remote: { size: 2 } });
await sleep(300);
assert.ok(calls.download.length > downloadsBeforeRetry, "la reprise est envoyée");
assert.strictEqual(calls.download[calls.download.length - 1].conflict_resolution, "overwrite", "reprise overwrite");
assert.ok(calls.opened > before, "la fenêtre est (ré)ouverte pour la reprise");
assertWindowFor("retry conflit");
window.aihShowConfirm = confirmStub;
globalThis.aihShowConfirm = confirmStub;
resolveNextDownload({ success: true, path: "/models/a.safetensors" });
await sleep(120);
ok("conflit → résolution → reprise dans la fenêtre (jamais l'en-ligne seul)");

/* ─── 4. Structurel : aucun chemin _downloadRequest sans fenêtre ─────────── */
console.log("4. Invariant structurel (chemin de download futur sans fenêtre)");
const SOURCE = readFileSync(new URL("./02_aih_model_browser.js", import.meta.url), "utf-8");
function functionBody(name) {
    const start = SOURCE.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `fonction ${name} introuvable`);
    let i = SOURCE.indexOf("{", start);
    let depth = 0;
    for (let j = i; j < SOURCE.length; j++) {
        const c = SOURCE[j];
        if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) return SOURCE.slice(i, j + 1);
        }
    }
    throw new Error(`corps de ${name} non fermé`);
}
const DOWNLOAD_FUNCS = ["downloadRemoteModel", "downloadFile", "retryDownload", "batchDownload"];
for (const fn of DOWNLOAD_FUNCS) {
    const body = functionBody(fn);
    const usesWindow = /_dlWin(Add|Start|Open)\(/.test(body);
    assert.ok(usesWindow, `${fn}() DOIT piloter la fenêtre de transferts (_dlWinAdd/_dlWinStart/_dlWinOpen)`);
}
// Toute NOUVELLE fonction qui appelle _downloadRequest doit piloter la fenêtre
// (même si elle n'est pas dans la liste ci-dessus).
const requestCallers = [];
for (const m of SOURCE.matchAll(/function\s+([A-Za-z0-9_$]+)\s*\(/g)) {
    const name = m[1];
    if (DOWNLOAD_FUNCS.includes(name)) continue;
    const body = functionBody(name);
    if (/_downloadRequest\(/.test(body)) requestCallers.push({ name, body });
}
for (const { name, body } of requestCallers) {
    assert.ok(/_dlWin(Add|Start|Open)\(/.test(body),
        `${name}() appelle _downloadRequest SANS piloter la fenêtre de transferts (ancien affichage en ligne seul)`);
}
assert.ok(/showProgress\(m, filename, \{ cancelable: true \}\)/.test(SOURCE),
    "la progression en LIGNE reste en place (aucune régression) — secondaire, pas primaire");
ok(`invariant structurel : ${DOWNLOAD_FUNCS.length + requestCallers.length} fonctions de download pilotent la fenêtre`);

console.log(`\n✅ test_aih_model_browser_download_paths : ${n} groupes PASSENT`);
try { dom.window.close(); } catch (e) { /* silencieux */ }
process.exit(0);
