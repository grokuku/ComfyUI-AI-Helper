// ─────────────────────────────────────────────────────────────────────────
// ComfyCH — on ne lance JAMAIS un rendu long sur un gateway obsolète.
//
// Bug vécu : `HTTP 503: Job interrompu (déconnexion client ou redéploiement)`
// à ~32 s (2 étapes sur 8), APRÈS le correctif « spawn + polling ».
// Explication : le bouton « ♻️ Redémarrer le worker » fait
// `modal container stop` — il relance les conteneurs de l'application déjà
// déployée et ne peut donc PAS publier le nouveau code (`modal deploy` seul le
// fait). Le gateway restait en v1 : rendu attaché à la requête HTTP, puis
// `scaledown_window` (30 s sur L4) arrêtait le conteneur GPU en plein rendu.
// Rien dans l'UI ne permettait de voir qu'on testait l'ancien code.
//
// Ce que ce fichier verrouille (chaque point a son mutant) :
//   §1 gateway v1 (`/health` sans `api_version`) → AUCUNE soumission
//      `/generate`, message actionnable citant « Déployer » — MUTANT « ne pas
//      sonder /health » ou « lancer quand même » → ROUGE ;
//   §2 gateway v2 (`api_version: 2`) → le rendu se déroule normalement
//      (spawn + polling puis « Terminé ») — MUTANT « refuser un gateway à
//      jour » → ROUGE ;
//   §3 version INDÉTERMINABLE (`/health` en échec réseau) → on ne bloque pas
//      (aucune régression pour un gateway sans route /health) — MUTANT
//      « bloquer sur une supposition » → ROUGE.
//
// Usage : node js/test_comfych_stale_gateway.mjs
//   jsdom résolu par js/test_helpers/jsdom_loader.mjs ; absent = SKIP (exit 2).
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 20));

const JSDOM = await loadJsdomOrSkip("test_comfych_stale_gateway");
const dom = new JSDOM(
    `<!doctype html><html><head></head><body>
       <button id="comfy-node-button">node</button>
       <select id="modal-gpu-selector">
         <option value="local">local</option>
         <option value="modal:L4" selected>L4</option>
       </select>
     </body></html>`,
    { pretendToBeVisual: true, url: "http://localhost/" }
);
const { window: domWindow } = dom;
globalThis.window = domWindow;
globalThis.document = domWindow.document;
globalThis.localStorage = domWindow.localStorage;
globalThis.getComputedStyle = domWindow.getComputedStyle.bind(domWindow);
globalThis.HTMLElement = domWindow.HTMLElement;
globalThis.Node = domWindow.Node;
globalThis.Blob = domWindow.Blob;
globalThis.MutationObserver = domWindow.MutationObserver;
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
try { globalThis.navigator = domWindow.navigator; } catch { /* déjà fourni */ }
domWindow.matchMedia = domWindow.matchMedia
    || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));

localStorage.setItem("aih_locale", "fr");
localStorage.setItem("modal-gateway-mode", "modal:L4");
localStorage.setItem("modal-api-url", "https://gw.modal.run");
localStorage.setItem("modal-api-key", "test-key");
localStorage.setItem("modal-job-poll-ms", "10");
localStorage.setItem("modal-retry-delay-ms", "10");

/* ═══════════════ Harnais fetch pilotable ═══════════════ */
const gateway = {
    /** Réponse de `GET /health` : `{body, status}` ou `{throw: true}`. */
    health: null,
    generate: [],
    jobStates: [],
    jobPolls: 0,
    healthCalls: 0,
    generateCalls: [],
    jobCalls: [],
};

function jsonResponse(body, status) {
    return {
        ok: (status || 200) < 400,
        status: status || 200,
        headers: { get: () => "application/json" },
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

globalThis.fetch = async (url, opts) => {
    const target = String(url);
    if (target.includes("/api/modal/worker-logs")) return jsonResponse({ lines: [] });
    if (target.startsWith("https://gw.modal.run/health")) {
        gateway.healthCalls++;
        if (gateway.health && gateway.health.throw) throw new TypeError("Failed to fetch");
        return jsonResponse(gateway.health.body, gateway.health.status);
    }
    if (target.startsWith("https://gw.modal.run/generate")) {
        gateway.generateCalls.push(JSON.parse((opts && opts.body) || "{}"));
        const next = gateway.generate.length > 1 ? gateway.generate.shift() : gateway.generate[0];
        return jsonResponse(next.body, next.status);
    }
    if (target.startsWith("https://gw.modal.run/job/")) {
        gateway.jobCalls.push(target);
        const index = Math.min(gateway.jobPolls, gateway.jobStates.length - 1);
        gateway.jobPolls++;
        return jsonResponse(gateway.jobStates[index], 200);
    }
    if (target.includes("/api/modal/save-local")) return jsonResponse({ ok: true });
    return jsonResponse({ ok: true });
};

/* Faux app ComfyUI : l'extension intercepte app.api.queuePrompt. */
const app = {
    graph: { nodes: [] },
    canvas: {},
    ui: {},
    api: { queuePrompt: () => Promise.resolve({ local: true }) },
    extensions: [],
    menu: { settingsGroup: { element: document.getElementById("comfy-node-button") } },
    registerExtension(ext) { app.extensions.push(ext); },
};
globalThis.window.app = app;
domWindow.app = app;
globalThis.app = app;
domWindow.comfyAPI = { app: { app } };

const originalQueuePrompt = app.api.queuePrompt;

await import("./comfych_gateway.js");
await import("./comfych/modal_gateway.js");

async function waitForInterception(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 5000);
    while (Date.now() < deadline) {
        if (app.api.queuePrompt !== originalQueuePrompt) return true;
        await tick(25);
    }
    throw new Error("interception de queuePrompt jamais installée");
}
await waitForInterception(5000);

const host = () => domWindow.AIHComfyCHHost;
assert.ok(host(), "pont window.AIHComfyCHHost exposé");
const runState = () => host().runState();

const IMAGE = "iVBORw0KGgoAAAANSUhEUg==";
const WORKFLOW = { "1": { class_type: "KSampler", inputs: { seed: 1 } } };

async function waitFor(predicate, timeoutMs, label) {
    const deadline = Date.now() + (timeoutMs || 5000);
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await tick(20);
    }
    throw new Error(`délai dépassé : ${label}`);
}

function resetGateway(health, generate, jobStates) {
    gateway.health = health;
    gateway.generate = generate || [];
    gateway.jobStates = jobStates || [];
    gateway.jobPolls = 0;
    gateway.healthCalls = 0;
    gateway.generateCalls = [];
    gateway.jobCalls = [];
}

/** Lance un rendu et attend sa conclusion (succès ou échec). */
async function runOnce() {
    await app.api.queuePrompt(1, WORKFLOW, {}).catch(() => {});
    await waitFor(() => !runState().running && runState().status !== "idle", 8000, "conclusion du run");
}

/* ═════════ §1 — gateway v1 : on refuse AVANT d'engager du GPU ═════════ */
console.log("1. Gateway v1 (/health sans api_version) → rendu NON lancé + action claire");

resetGateway(
    // Réponse EXACTE d'un gateway d'avant le découplage spawn+polling.
    { status: 200, body: { status: "ok" } },
    [{ status: 202, body: { status: "running", job_id: "req-v1" } }],
    [{ status: "done", job_id: "req-v1", images: [{ filename: "img.png", data: IMAGE }] }]
);

await runOnce();

assert.strictEqual(gateway.healthCalls, 1,
    "MUTANT §1 : la version du gateway doit être sondée (GET /health) avant tout rendu");
assert.strictEqual(gateway.generateCalls.length, 0,
    "MUTANT §1 : AUCUNE soumission ne doit partir vers un gateway v1 (rendu condamné)");
assert.strictEqual(runState().status, "failed", "le run doit conclure à l'échec, avec la cause");
assert.ok(String(runState().error).includes("Déployer"),
    `MUTANT §1 : le message doit donner l'ACTION (« Déployer ») — reçu : ${runState().error}`);
assert.ok(/API v1/.test(String(runState().error)),
    "le message doit nommer la version détectée (API v1)");
ok("gateway v1 détecté : rendu refusé, message actionnable");

/* ═════════ §2 — gateway v2 : rendu normal, aucune régression ═════════ */
console.log("2. Gateway v2 (api_version: 2) → rendu lancé, suivi, « Terminé »");

resetGateway(
    { status: 200, body: { status: "ok", api_version: 2, features: ["spawn", "job-polling"], build: "abc123" } },
    [{ status: 202, body: { status: "running", job_id: "req-v2" } }],
    [
        { status: "running", job_id: "req-v2" },
        { status: "done", job_id: "req-v2", images: [{ filename: "img2.png", data: IMAGE }] },
    ]
);

await runOnce();

assert.strictEqual(gateway.generateCalls.length, 1, "une soumission sur un gateway à jour");
assert.strictEqual(gateway.generateCalls[0].async_mode, true, "la soumission reste détachée");
assert.ok(gateway.jobCalls.length >= 1, "le suivi par GET /job/<id> a bien lieu");
assert.strictEqual(runState().status, "success",
    "MUTANT §2 : un gateway v2 ne doit JAMAIS être refusé (régression interdite)");
ok("gateway v2 accepté : spawn + polling jusqu'à « Terminé »");

/* ═════════ §3 — version indéterminable : on ne bloque pas ═════════ */
console.log("3. /health injoignable → version inconnue, le rendu se déroule");

resetGateway(
    { throw: true },
    [{ status: 202, body: { status: "running", job_id: "req-inconnu" } }],
    [
        { status: "running", job_id: "req-inconnu" },
        { status: "done", job_id: "req-inconnu", images: [{ filename: "img3.png", data: IMAGE }] },
    ]
);

await runOnce();

assert.strictEqual(gateway.generateCalls.length, 1,
    "MUTANT §3 : une version INDÉTERMINABLE ne doit pas bloquer le rendu");
assert.strictEqual(runState().status, "success", "le rendu aboutit malgré /health muet");
ok("version indéterminable : aucune régression");

console.log(`\n✅ ComfyCH — gateway obsolète : ${n} assertions, tous les scénarios PASSENT`);
