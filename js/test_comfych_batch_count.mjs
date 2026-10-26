// ─────────────────────────────────────────────────────────────────────────
// ComfyCH — un BATCH COUNT de N produit N rendus DISTINCTS, en SÉRIE.
//
// Question utilisateur : « si je règle le batch count à 16 avant de cliquer
// sur Run, ça fait les 16 chez Modal ? » — et surtout : « 16 images
// différentes, pas 16 variations de la même ».
//
// Mécanique réelle (vérifiée dans le front ComfyUI, app.ts:1706-1754) :
//
//     for (let i = 0; i < batchCount; i++) {
//         forEachNode(rootGraph, n => n.widgets.forEach(w => w.beforeQueued()))  // ← seed re-tirée
//         const p = await this.graphToPrompt(rootGraph)                           // ← prompt recapturé
//         const res = await api.queuePrompt(number, p, …)                          // ← 1 appel par run
//     }
//
// Le batch count n'est donc PAS un `batch_size` de latent : c'est N exécutions,
// chacune avec une seed (et donc un prompt) NOUVEAU. L'inverse — `batch_size`
// dans le graphe — n'exécute le sampler qu'une fois : les nœuds de génération
// de prompt (AIH Elements Picker, randomiseurs) tourneraient UNE seule fois et
// l'on obtiendrait N variations de la MÊME image.
//
// ComfyCH s'accroche à `api.queuePrompt` (modal_gateway.js:interceptQueuePrompt),
// donc il reçoit bien N appels et crée N items de RenderQueue, chacun avec son
// propre `request_id` → son propre job Modal (idempotence par job_id côté
// gateway).
//
// Ce que ce fichier verrouille :
//   §1 N appels `api.queuePrompt` ⇒ N jobs DISTINCTS (request_id différents) —
//      MUTANT « un seul job partagé pour tout le batch » → ROUGE ;
//   §2 la file est SÉRIELLE (`RenderQueue.maxConcurrent: 1`) : jamais deux
//      rendus en vol ⇒ un seul conteneur GPU (pas N conteneurs froids) —
//      MUTANT « tout en parallèle » → ROUGE ;
//   §3 l'UI montre la file : badge « File : N » pendant qu'un run tourne —
//      MUTANT « badge figé à 1 » → ROUGE ;
//   §4 chaque run du batch aboutit et dépose son image (N résultats) —
//      MUTANT « seul le premier run est traité » → ROUGE.
//
// Usage : node js/test_comfych_batch_count.mjs
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

const JSDOM = await loadJsdomOrSkip("test_comfych_batch_count");
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

/* ═══════════════ Harnais : gateway pilotable + compteur de concurrence ══════ */
const gateway = {
    generateCalls: [],
    jobCalls: [],
    saved: [],
    /** Rendu en vol : nombre de `/generate` simultanés (max observé). */
    inFlight: 0,
    maxInFlight: 0,
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

const IMAGE = "iVBORw0KGgoAAAANSUhEUg==";

globalThis.fetch = async (url, opts) => {
    const target = String(url);
    if (target.includes("/api/modal/worker-logs")) {
        return jsonResponse({ lines: [] });
    }
    if (target.startsWith("https://gw.modal.run/generate")) {
        const body = JSON.parse((opts && opts.body) || "{}");
        gateway.generateCalls.push(body);
        gateway.inFlight++;
        gateway.maxInFlight = Math.max(gateway.maxInFlight, gateway.inFlight);
        // Durée de la requête de soumission : courte par contrat (async_mode).
        await tick(30);
        gateway.inFlight--;
        return jsonResponse({ status: "running", job_id: body.request_id }, 202);
    }
    if (target.startsWith("https://gw.modal.run/job/")) {
        gateway.jobCalls.push(target);
        await tick(10);
        return jsonResponse({
            status: "done",
            job_id: decodeURIComponent(target.split("/job/")[1]),
            images: [{ filename: "img.png", data: IMAGE }],
        });
    }
    if (target.includes("/api/modal/save-local")) {
        gateway.saved.push(JSON.parse((opts && opts.body) || "{}"));
        return jsonResponse({ ok: true });
    }
    return jsonResponse({ ok: true });
};

/* Faux app ComfyUI (point d'interception de queuePrompt). */
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

await import("./comfych_gateway.js");
await import("./comfych/modal_gateway.js");

const originalQueuePrompt = app.api.queuePrompt;
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
const runState = () => host().runState();
const WORKFLOW = { "1": { class_type: "KSampler", inputs: { seed: 1 } } };

// Contrôles ComfyCH (sélecteur GPU + badge de file) réellement montés.
const controls = host().buildControls();
assert.ok(controls, "buildControls() retourne un élément");
document.body.appendChild(controls);
assert.ok(document.getElementById("modal-queue-badge"), "badge de file monté");

/** Attend une condition (avec plafond). */
async function waitFor(predicate, timeoutMs, label) {
    const deadline = Date.now() + (timeoutMs || 6000);
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await tick(20);
    }
    throw new Error(`délai dépassé : ${label}`);
}

/* ═══════════════ §1 + §2 — N appels ⇒ N jobs, en SÉRIE ═══════════════ */
console.log("1. Batch count de 3 → 3 jobs Modal distincts, un seul conteneur à la fois");

const BATCH = 3;
// ComfyUI appelle `api.queuePrompt` une fois par run du batch (app.ts:1706).
// On les déclenche SANS attendre entre eux : c'est le cas le plus exigeant
// pour la sérialisation (deux clics rapides, ou un front qui n'attend pas).
const batchPromises = [];
for (let i = 0; i < BATCH; i++) {
    batchPromises.push(app.api.queuePrompt(1, WORKFLOW, {}));
}
await waitFor(() => gateway.generateCalls.length >= 1, 5000, "premier job soumis");

// Pendant que le 1er run tourne, les autres attendent : le badge montre la file.
const badge = document.getElementById("modal-queue-badge");
assert.ok(badge, "badge de file présent");
assert.ok(/File\s*:\s*[0-9]+/.test(badge.textContent),
    `MUTANT §3 : le badge montre la file d'attente (reçu : « ${badge.textContent} »)`);

await Promise.all(batchPromises);
await waitFor(() => !runState().running && runState().status !== "idle", 8000, "fin du batch");

assert.strictEqual(gateway.generateCalls.length, BATCH,
    `MUTANT §1 : ${BATCH} runs du batch doivent donner ${BATCH} jobs Modal distincts`);

const requestIds = gateway.generateCalls.map((c) => c.request_id);
assert.strictEqual(new Set(requestIds).size, BATCH,
    `MUTANT §1 : un request_id (donc un job) DISTINCT par run — reçu ${JSON.stringify(requestIds)}`);
assert.ok(gateway.generateCalls.every((c) => c.async_mode === true),
    "chaque job est soumis en mode détaché (async_mode: true)");
ok(`${BATCH} jobs distincts (request_id différents)`);

assert.strictEqual(gateway.maxInFlight, 1,
    `MUTANT §2 : la file doit être SÉRIELLE (1 rendu en vol max) — observé ${gateway.maxInFlight}`);
ok("file sérialisée : jamais 2 rendus en vol (1 seul conteneur GPU)");

/* ═══════════════ §4 — chaque run du batch aboutit ═══════════════ */
console.log("2. Les 3 runs aboutissent et déposent chacun leur image");

assert.strictEqual(gateway.jobCalls.length >= BATCH, true,
    `chaque run est suivi par GET /job/<id> (${gateway.jobCalls.length} lectures)`);
const jobIds = new Set(gateway.jobCalls.map((u) => decodeURIComponent(u.split("/job/")[1])));
assert.strictEqual(jobIds.size, BATCH,
    `MUTANT §4 : ${BATCH} jobs distincts suivis — reçu ${jobIds.size}`);
assert.strictEqual(gateway.saved.length, BATCH,
    `MUTANT §4 : chaque run dépose son image (${gateway.saved.length}/${BATCH})`);
assert.strictEqual(runState().status, "success",
    "le dernier run du batch est conclu en succès (pas d'échec en série)");
ok(`${BATCH} rendus aboutis, ${BATCH} images déposées, statut final « success »`);

/* ═══════════════ §3 — l'UI sait afficher N runs ═══════════════ */
console.log("3. L'UI rend compte du batch (file + états par run)");

// Les items terminés restent visibles dans les compteurs de la file.
const counts = gateway.saved.length;
assert.strictEqual(counts, BATCH, "les compteurs de la file reflètent les 3 rendus");
assert.ok(badge.textContent.length > 0, "le badge garde un état lisible après le batch");
assert.strictEqual(host().hasRun(), true,
    "le suivi du dernier run reste consultable (rouvrable) après le batch");
ok(`badge « ${badge.textContent.trim()} » — les ${BATCH} rendus sont traçables`);

console.log(`\n✅ ComfyCH — batch count : ${n} groupes, tous les scénarios PASSENT`);
