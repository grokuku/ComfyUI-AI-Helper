// ─────────────────────────────────────────────────────────────────────────
// ComfyCH — le résultat d'un rendu n'est JAMAIS perdu par une coupure.
//
// Bug vécu : `HTTP 503: Job interrompu (déconnexion client ou redéploiement)`
// après ~4 min, alors que le rendu avait produit ses images (visibles dans la
// galerie AI-Helper via le node AIH Save Media). Deux défauts se cumulaient :
//
//  1. l'extension attendait le résultat dans UNE requête `fetch` longue : toute
//     coupure donnait un 503, donc un « Échec » à l'écran, alors que le travail
//     était fait ;
//  2. fermer la fenêtre de suivi ne devait PAS interrompre le rendu (exigence
//     produit) et aucun `abort()` ne doit être déclenché par cette fermeture.
//
// Ce que ce fichier verrouille (chaque point a son mutant) :
//   §1 la soumission est DÉTACHÉE (`async_mode: true`) : le client ne garde
//      jamais une requête ouverte pendant le rendu — MUTANT « requête
//      bloquante réintroduite » → ROUGE ;
//   §2 le suivi se fait par `GET /job/<id>` et un rendu long aboutit : l'UI
//      affiche « Terminé » — MUTANT « suivi par un seul fetch » → ROUGE ;
//   §3 un 503 « Job interrompu » avec un résultat disponible n'affiche PLUS
//      « Échec » : le résultat est récupéré et l'UI le dit honnêtement —
//      MUTANT « 503 traité comme échec alors qu'un résultat existe » → ROUGE ;
//   §4 un échec RÉEL (aucune image) reste un échec visible — MUTANT « vrai
//      échec masqué » → ROUGE ;
//   §5 fermer la fenêtre de suivi n'appelle AUCUN `abort()` et le rendu va au
//      bout — MUTANT « abort à la fermeture » → ROUGE.
//
// Usage : node js/test_comfych_run_recovery.mjs
//   jsdom résolu par js/test_helpers/jsdom_loader.mjs ; absent = SKIP (exit 2).
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 20));

const JSDOM = await loadJsdomOrSkip("test_comfych_run_recovery");
const dom = new JSDOM(
    `<!doctype html><html><head></head><body>
       <button id="comfy-node-button">node</button>
       <select id="modal-gpu-selector">
         <option value="local">local</option>
         <option value="modal:L40S" selected>L40S</option>
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
localStorage.setItem("modal-gateway-mode", "modal:L40S");
localStorage.setItem("modal-api-url", "https://gw.modal.run");
localStorage.setItem("modal-api-key", "test-key");
// Cadences de test : les valeurs de prod (2,5 s / 5 s) rendraient la suite lente.
localStorage.setItem("modal-job-poll-ms", "10");
localStorage.setItem("modal-retry-delay-ms", "10");

/* ═══════════════ 0. Instrumentation des AbortController ═══════════════ */
const abortCalls = [];
const RealAbortController = globalThis.AbortController;
globalThis.AbortController = class extends RealAbortController {
    abort() { abortCalls.push(new Error("abort").stack); return super.abort(); }
};

/* Le VRAI AIH.Dialog du pack est chargé par ./comfych_gateway.js : la fenêtre
   de suivi est donc manipulée exactement comme en production. */

/* ═══════════════ 1. Harnais fetch pilotable ═══════════════ */
const gateway = {
    /** Réponses de POST /generate, consommées une à une. */
    generate: [],
    /** États successifs de GET /job/<id> (le dernier est répété). */
    jobStates: [],
    jobPolls: 0,
    /** Quand true, `GET /job/<id>` reste « running » (rendu long simulé). */
    jobHold: false,
    generateCalls: [],
    jobCalls: [],
    saved: [],
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
    if (target.includes("/api/modal/worker-logs")) {
        return jsonResponse({ lines: [] });
    }
    if (target.startsWith("https://gw.modal.run/generate")) {
        const body = JSON.parse((opts && opts.body) || "{}");
        gateway.generateCalls.push(body);
        const next = gateway.generate.length > 1 ? gateway.generate.shift() : gateway.generate[0];
        if (next && next.throw) throw new TypeError("Failed to fetch");
        return jsonResponse(next.body, next.status);
    }
    if (target.startsWith("https://gw.modal.run/job/")) {
        gateway.jobCalls.push(target);
        if (gateway.jobHold) {
            return jsonResponse({ status: "running", job_id: "req-ferme" }, 200);
        }
        const index = Math.min(gateway.jobPolls, gateway.jobStates.length - 1);
        gateway.jobPolls++;
        return jsonResponse(gateway.jobStates[index], 200);
    }
    if (target.includes("/api/modal/save-local")) {
        gateway.saved.push(JSON.parse((opts && opts.body) || "{}"));
        return jsonResponse({ ok: true });
    }
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

/* ═══════════════ 2. Chargement du module réel ═══════════════ */
/** `queuePrompt` d'origine : l'interception le REMPLACE (elle réessaie toutes
 *  les 800 ms jusqu'à trouver `window.comfyAPI.app.app.api`). */
const originalQueuePrompt = app.api.queuePrompt;

await import("./comfych_gateway.js");
await import("./comfych/modal_gateway.js");

/** Attend que l'interception soit réellement installée (sinon le test
 *  déclencherait `queuePrompt` AVANT le patch et ne testerait rien). */
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

/** Attend une condition (avec plafond) — évite les attentes arbitraires. */
async function waitFor(predicate, timeoutMs, label) {
    const deadline = Date.now() + (timeoutMs || 4000);
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await tick(20);
    }
    throw new Error(`délai dépassé : ${label}`);
}

/** Remet le harnais à zéro avant chaque scénario. */
function resetGateway(generate, jobStates) {
    gateway.generate = generate;
    gateway.jobStates = jobStates;
    gateway.jobPolls = 0;
    gateway.jobHold = false;
    gateway.generateCalls = [];
    gateway.jobCalls = [];
    gateway.saved = [];
    abortCalls.length = 0;
}

/* ═════════ §1 + §2 — soumission détachée + suivi par id de job ═════════ */
console.log("1. Rendu long : soumission détachée puis suivi par GET /job/<id>");

resetGateway(
    [{ status: 202, body: { status: "running", job_id: "req-suivi" } }],
    [
        { status: "running", job_id: "req-suivi" },
        { status: "running", job_id: "req-suivi" },
        { status: "done", job_id: "req-suivi", images: [{ filename: "img1.png", data: IMAGE }] },
    ]
);

// `queuePrompt` rejette quand le rendu échoue (comme dans ComfyUI) : on
// attend la conclusion via l'état du suivi, pas via la promesse.
await app.api.queuePrompt(1, WORKFLOW, {}).catch(() => {});
await waitFor(() => !runState().running && runState().status !== "idle", 6000, "fin du rendu suivi");

assert.strictEqual(runState().status, "success",
    "un rendu long doit afficher « Terminé » (pas « Échec »)");
assert.strictEqual(gateway.generateCalls.length, 1, "une seule soumission");
assert.strictEqual(gateway.generateCalls[0].async_mode, true,
    "MUTANT §1 : la soumission doit être détachée (async_mode: true)");
assert.ok(gateway.jobCalls.length >= 3,
    "MUTANT §2 : le résultat doit être suivi par GET /job/<id>, pas par un fetch bloquant");
assert.ok(gateway.jobCalls.every((u) => u.includes("/job/")), "toutes les lectures visent /job/");
assert.strictEqual(gateway.saved.length, 1, "l'image reçue est enregistrée localement");
assert.strictEqual(abortCalls.length, 0, "MUTANT §5 : aucun abort() pendant un rendu normal");
ok("rendu long abouti via spawn + polling");

/* ═════════ §3 — 503 « Job interrompu » MAIS résultat disponible ═════════ */
console.log("2. 503 « Job interrompu » avec résultat existant → pas d'échec affiché");

resetGateway(
    // La soumission échoue exactement comme en production (connexion coupée /
    // annulation côté Modal), et le corps 503 est celui du gateway.
    [{ status: 503, body: { error: "Job interrompu (déconnexion client ou redéploiement)" } }],
    [
        { status: "running", job_id: "req-recup" },
        { status: "done", job_id: "req-recup", images: [{ filename: "img2.png", data: IMAGE }] },
    ]
);

// `queuePrompt` rejette quand le rendu échoue (comme dans ComfyUI) : on
// attend la conclusion via l'état du suivi, pas via la promesse.
await app.api.queuePrompt(1, WORKFLOW, {}).catch(() => {});
await waitFor(() => !runState().running && runState().status !== "idle", 8000, "fin du rendu récupéré");

assert.strictEqual(runState().status, "success",
    "MUTANT §3 : un 503 avec résultat disponible NE DOIT PAS afficher « Échec »");
assert.strictEqual(gateway.saved.length, 1, "l'image récupérée est bien enregistrée");
assert.ok(gateway.generateCalls.every((c) => c.request_id === gateway.generateCalls[0].request_id),
    "toutes les tentatives réutilisent le MÊME request_id (idempotence côté serveur)");
ok("503 sans gravité : résultat récupéré, « Terminé » affiché");

/* ═════════ §4 — un échec RÉEL reste un échec ═════════ */
console.log("3. Échec réel (aucune image) → « Échec » avec le message du worker");

resetGateway(
    [{ status: 202, body: { status: "running", job_id: "req-ko" } }],
    [
        { status: "running", job_id: "req-ko" },
        { status: "failed", job_id: "req-ko", error: "KSampler: CUDA out of memory", images: [] },
    ]
);

// `queuePrompt` rejette quand le rendu échoue (comme dans ComfyUI) : on
// attend la conclusion via l'état du suivi, pas via la promesse.
await app.api.queuePrompt(1, WORKFLOW, {}).catch(() => {});
await waitFor(() => !runState().running && runState().status !== "idle", 6000, "fin du rendu en échec");

assert.strictEqual(runState().status, "failed",
    "MUTANT §4 : un échec réel ne doit jamais être masqué par un « Terminé »");
assert.ok(String(runState().error).includes("CUDA out of memory"),
    "le message du worker reste visible");
assert.strictEqual(gateway.saved.length, 0, "aucune image enregistrée pour un échec réel");
ok("échec réel préservé et message visible");

/* ═════════ §5 — fermer la fenêtre de suivi n'interrompt pas le rendu ═════ */
console.log("4. Fermeture de la fenêtre de suivi : aucun abort(), le rendu continue");

resetGateway(
    [{ status: 202, body: { status: "running", job_id: "req-ferme" } }],
    [
        { status: "running", job_id: "req-ferme" },
        { status: "done", job_id: "req-ferme", images: [{ filename: "img3.png", data: IMAGE }] },
    ]
);
// Le rendu reste « en cours » tant que le test ne le libère pas : c'est la
// fenêtre pendant laquelle l'utilisateur peut fermer le suivi.
gateway.jobHold = true;

// `queuePrompt` ne rend la main qu'à la FIN du run : ici le rendu est
// volontairement long (job maintenu « running »), donc on n'attend PAS la
// promesse — le test pilote le suivi et vérifie qu'il survit à la fermeture.
app.api.queuePrompt(1, WORKFLOW, {}).catch(() => {});

await waitFor(() => runState().running, 3000, "rendu démarré");

// L'utilisateur ferme la fenêtre pendant le rendu (exigence produit : la
// fermeture ne doit RIEN annuler). `openRunMonitor()` BASCULE : la fenêtre
// ayant été ouverte par `RunMonitor.begin`, ce 1er appel la ferme.
host().openRunMonitor();
await tick(60);

assert.strictEqual(abortCalls.length, 0,
    "MUTANT §5 : fermer la fenêtre ne doit appeler AUCUN abort()");
assert.strictEqual(gateway.jobCalls.length > 0, true, "le suivi continue après la fermeture");

// Le worker termine son rendu : le suivi, lui, a survécu à la fermeture.
gateway.jobHold = false;
await waitFor(() => !runState().running && runState().status !== "idle", 8000, "fin après fermeture");
assert.strictEqual(runState().status, "success",
    "le rendu va au bout malgré la fermeture de la fenêtre de suivi");
assert.strictEqual(host().hasRun(), true,
    "le run reste suivi (donc réouvrable) après la fermeture de la fenêtre");
assert.ok(host().openRunMonitor(), "la fenêtre de suivi se réouvre après coup");
ok("fermeture de la fenêtre sans effet sur le rendu (aucun abort)");

console.log(`\n✅ ComfyCH — résultat jamais perdu : ${n} assertions, tous les scénarios PASSENT`);
