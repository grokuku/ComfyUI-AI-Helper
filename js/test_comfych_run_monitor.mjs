// ─────────────────────────────────────────────────────────────────────────
// ComfyCH — suivi de run NON BLOQUANT + redémarrage du worker (sync → restart).
//
// Ce que ce fichier verrouille (chaque point a son mutant) :
//   §1 la fenêtre de suivi REMPLACE l'overlay bloquant : aucun overlay plein
//      écran ne capte les clics, la fenêtre est bornée et ComfyUI reste
//      utilisable — MUTANT M1 « modal:true » (overlay) → ROUGE ;
//   §2 fermer la fenêtre N'ANNULE PAS le run, et la fenêtre est ROUVRABLE
//      depuis le badge du sous-menu ComfyCH — MUTANT M2 « onClose annule le
//      run » → ROUGE ;
//   §3 les logs du worker arrivent en direct (route existante
//      /api/modal/worker-logs) et seul le DELTA est ajouté ;
//   §4 le PLAFOND de lignes est respecté et signalé — MUTANT M3 « plafond
//      ignoré » → ROUGE ;
//   §5 « Copier le log » / « Copier l'erreur » reçoivent un contenu NON VIDE —
//      MUTANT M4 « copie d'un contenu vide » → ROUGE ;
//   §6 pause du défilement (l'utilisateur remonte) et « Aller à la fin » ;
//   §7 redémarrage : confirmation OBLIGATOIRE si un rendu tourne, puis
//      POST /api/modal/restart-worker avec {render_in_progress, confirm} —
//      MUTANT M5 « redémarrage sans confirmation » → ROUGE ;
//   §8 i18n : toutes les clés `t('…')` du module existent en FR ET EN.
//
// Usage : node js/test_comfych_run_monitor.mjs
//   jsdom résolu par js/test_helpers/jsdom_loader.mjs ; absent = SKIP (exit 2).
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMFYCH_DIR = join(HERE, "comfych");

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 20));

const JSDOM = await loadJsdomOrSkip("test_comfych_run_monitor");
const dom = new JSDOM(
    `<!doctype html><html><head></head><body>
       <div id="comfy-canvas"><button id="comfy-node-button">node</button></div>
       <button id="cfg-run-restart-worker"></button>
       <div id="modal-log-section">
         <span id="modal-log-count"></span>
         <span id="modal-log-progress" style="display:none;"></span>
         <pre id="modal-log-output"></pre>
       </div>
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
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
try { globalThis.navigator = domWindow.navigator; } catch { /* déjà fourni */ }
domWindow.matchMedia = domWindow.matchMedia
    || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));

localStorage.setItem("aih_locale", "fr");
// Préférence cloud de l'utilisateur (aucun forçage serveur : le test pilote le
// mode par le sélecteur GPU, comme le ferait un utilisateur).
localStorage.setItem("modal-gateway-mode", "modal:h100");

/* ══════════════ Harnais : fetch / EventSource contrôlables ══════════════ */

/** Queue de log renvoyée par la route /api/modal/worker-logs. */
const workerTail = { lines: [] };
const generateCalls = [];
const restartCalls = [];
let workerLogCalls = 0;

/** POST /generate qui reste en attente (le run est « en cours »). */
function pendingGenerate() {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
}
const generateQueue = [];

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
    if (target.includes("/api/modal/config")) {
        return jsonResponse({ api_url: "https://gw.modal.run", api_key_set: true, render_mode_forced: "" });
    }
    if (target.includes("/api/modal/worker-logs")) {
        workerLogCalls++;
        return jsonResponse({ lines: workerTail.lines.slice() });
    }
    if (target.includes("/generate")) {
        const entry = { url: target, body: JSON.parse((opts && opts.body) || "{}"), signal: opts && opts.signal };
        generateCalls.push(entry);
        const deferred = generateQueue.shift() || pendingGenerate();
        entry.deferred = deferred;
        return deferred.promise;
    }
    if (target.includes("/api/modal/restart-worker")) {
        restartCalls.push({
            method: opts && opts.method,
            body: JSON.parse((opts && opts.body) || "null"),
        });
        return jsonResponse({
            ok: true,
            message: "Sync puis redémarrage du worker lancés",
            sequence: ["sync", "restart"],
        });
    }
    if (target.includes("/api/modal/")) {
        return jsonResponse({ ok: true });
    }
    return jsonResponse({});
};

/** EventSource de test (l'UI des opérations en ouvre un après un POST). */
class FakeEventSource {
    constructor(url) {
        this.url = url;
        this.closed = false;
        FakeEventSource.instances.push(this);
    }
    addEventListener() {}
    close() { this.closed = true; }
}
FakeEventSource.instances = [];
globalThis.EventSource = FakeEventSource;
domWindow.EventSource = FakeEventSource;

// Presse-papiers espionné (navigator.clipboard est absent de jsdom).
// NB : sous Node, `navigator` est un global propre (pas celui de jsdom) : on
// remplace le global par celui de la fenêtre de test, puis on y pose l'espion.
const clipboardWrites = [];
const clipboard = {
    writeText(text) {
        clipboardWrites.push(String(text));
        return Promise.resolve();
    },
};
try {
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: domWindow.navigator,
    });
} catch { /* ignore */ }
try {
    Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: clipboard });
} catch { /* ignore */ }
assert.strictEqual(typeof globalThis.navigator.clipboard.writeText, "function",
    "presse-papiers espionnable (repli du test)");

/* Faux app ComfyUI (point d'interception de queuePrompt). */
const fakeApi = {
    queuePrompt() { return Promise.resolve({}); },
};
const app = {
    graph: { nodes: [] },
    canvas: {},
    ui: {},
    api: fakeApi,
    extensions: [],
    menu: { settingsGroup: { element: document.getElementById("comfy-node-button") } },
    registerExtension(ext) { app.extensions.push(ext); },
};
globalThis.window.app = app;
domWindow.app = app;
globalThis.app = app;
domWindow.api = fakeApi;
domWindow.comfyAPI = { app: { app } };

/* ══════════════ Chargement du module (chemin réel du pack) ══════════════ */
await import("./comfych_gateway.js");
await import("./comfych/modal_gateway.js");
// Laisse le fetch de config + l'interception de queuePrompt s'installer (800 ms).
await tick(1000);

const host = () => domWindow.AIHComfyCHHost;
assert.ok(host(), "pont window.AIHComfyCHHost exposé");
assert.strictEqual(typeof host().openRunMonitor, "function", "openRunMonitor() exposé");
assert.strictEqual(typeof host().runState, "function", "runState() exposé (observation de test)");
assert.strictEqual(typeof host().restartWorker, "function", "restartWorker() exposé");

// Contrôles ComfyCH montés (sélecteur GPU + badge) et mode cloud sélectionné.
const controls = host().buildControls();
assert.ok(controls, "buildControls() retourne un élément");
document.body.appendChild(controls);
const gpuSelect = document.getElementById("modal-gpu-selector");
assert.ok(gpuSelect && document.getElementById("modal-queue-badge"), "sélecteur GPU + badge présents");
gpuSelect.value = "modal:h100";

/** Lance un rendu cloud et laisse le suivi s'ouvrir. */
async function startRun() {
    const deferred = pendingGenerate();
    generateQueue.push(deferred);
    // NON attendu : le queuePrompt intercepté ne résout qu'à la FIN du rendu.
    fakeApi.queuePrompt(1, { nodes: [] }, {}).catch(() => { /* échec attendu en test */ });
    await tick(80);
    return deferred;
}

const monitorEl = () => document.getElementById("comfych-run-monitor");
const overlays = () => Array.from(document.querySelectorAll(".aih-dialog-overlay"));
const logEl = () => monitorEl().querySelector(".comfych-run-log");
const logLines = () => logEl().textContent.split("\n");
const lineCount = () => logLines().filter((l) => l.startsWith("line-")).length;
function linesFrom(start, end) {
    const out = [];
    for (let i = start; i <= end; i++) out.push(`line-${i}`);
    return out;
}

/* ═════════ 1. Le suivi remplace l'overlay bloquant (non bloquant) ═════════ */
console.log("1. Fenêtre de suivi NON bloquante (aucun overlay plein écran)");

const firstRun = await startRun();
assert.ok(monitorEl(), "la fenêtre de suivi est ouverte au lancement du run");
assert.strictEqual(monitorEl().classList.contains("aih-dialog-root"), true,
    "le suivi est un AIH.Dialog du pack (pas un nouveau système de modale)");
assert.strictEqual(document.getElementById("modal-loading-overlay"), null,
    "MUTANT M1 : l'ancien overlay de chargement plein écran n'existe plus");
assert.deepStrictEqual(overlays(), [],
    "MUTANT M1 : AIH.Dialog en modal:false ne crée AUCUN overlay capturant les clics");
assert.strictEqual(monitorEl().style.width, "640px",
    "la fenêtre est BORNÉE (640 px), pas une couche plein écran");
assert.notStrictEqual(monitorEl().style.pointerEvents, "none",
    "aucun hack pointer-events : c'est une vraie fenêtre, pas un fond plein écran");

// ComfyUI reste utilisable : un clic sur un nœud arrive bien pendant le run.
let canvasClicks = 0;
document.getElementById("comfy-node-button").addEventListener("click", () => { canvasClicks++; });
document.getElementById("comfy-node-button").dispatchEvent(
    new domWindow.MouseEvent("click", { bubbles: true })
);
assert.strictEqual(canvasClicks, 1, "un clic sur ComfyUI est reçu pendant le run (rien ne le capte)");

const infoText = monitorEl().textContent;
assert.ok(infoText.includes("Run"), "la fenêtre affiche l'identifiant du run");
assert.ok(/H100/.test(infoText), "la fenêtre affiche le GPU du run");
assert.ok(infoText.includes("Durée"), "la fenêtre affiche la durée");
assert.ok(host().runState().running, "le run est marqué en cours");
ok("suivi ouvert, borné, sans overlay ; les clics ComfyUI passent encore");

/* ═════════ 2. Fermer n'annule pas ; réouverture par le badge ═════════ */
console.log("2. Fermeture SANS annulation, puis réouverture depuis le menu ComfyCH");

const runIdBefore = host().runState().runId;
monitorEl().querySelector(".aih-dialog-close").dispatchEvent(
    new domWindow.MouseEvent("click", { bubbles: true })
);
await tick(10);
assert.strictEqual(monitorEl(), null, "la fenêtre est fermée");
assert.strictEqual(host().runState().running, true,
    "MUTANT M2 : fermer la fenêtre N'ANNULE PAS le run");
assert.strictEqual(host().runState().runId, runIdBefore, "c'est toujours le même run qui est suivi");
assert.strictEqual(generateCalls[0].signal.aborted, false,
    "MUTANT M2 : la requête /generate n'est pas interrompue par la fermeture");

// Le badge reste affiché pendant le run (indicateur discret) et rouvre la fenêtre.
const badge = document.getElementById("modal-queue-badge");
assert.notStrictEqual(badge.style.display, "none", "le badge reste visible pendant le run");
badge.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick(20);
assert.ok(monitorEl(), "MUTANT M2 : la fenêtre est ROUVRABLE depuis le badge du sous-menu ComfyCH");
ok("fermeture = pas d'annulation ; réouverture par le badge, run conservé");

/* ═════════ 3. Logs du worker en direct (delta seulement) ═════════ */
console.log("3. Logs du worker Modal : flux en direct, seul le delta est ajouté");

// Le worker a déjà écrit 500 lignes : la fin du run relit la queue une dernière fois.
workerTail.lines = linesFrom(1, 500);
firstRun.resolve(jsonResponse({ images: [] }));
await tick(120);
assert.ok(workerLogCalls > 0, "les logs viennent de la route existante /api/modal/worker-logs");
assert.strictEqual(host().runState().status, "success", "le run est conclu en succès");
assert.ok(logEl().textContent.includes("line-500"), "le log du worker s'affiche dans la fenêtre");
assert.strictEqual(lineCount(), 500, "les 500 lignes du worker sont affichées");

// 20 lignes de plus : la relecture finale différée (2 s) n'ajoute QUE le delta.
workerTail.lines = linesFrom(1, 520);
await tick(2200);
assert.ok(logEl().textContent.includes("line-520"), "les nouvelles lignes arrivent en direct");
assert.strictEqual(lineCount(), 520,
    "MUTANT (delta) : seules les lignes NOUVELLES sont ajoutées (aucun doublon)");
ok("log worker en direct sur la route existante, diffé par ancre — 520 lignes, aucun doublon");

/* ═════════ 4. Plafond de lignes ═════════ */
console.log("4. Plafond mémoire des logs (800 lignes) signalé à l'utilisateur");

const maxLines = host().runState().maxLines;
assert.strictEqual(maxLines, 800, "le plafond est exposé (800 lignes) par le pont");
workerTail.lines = linesFrom(1, 1500);
// Un nouveau run relance la lecture de la queue (poll immédiat).
const capRun = await startRun();
await tick(80);
assert.strictEqual(lineCount(), maxLines,
    `MUTANT M3 : plafond respecté (${lineCount()} lignes conservées pour 1500 reçues)`);
assert.ok(host().runState().dropped > 0, "le nombre de lignes masquées est compté");
assert.ok(/plafond|masquée/.test(logEl().textContent),
    "l'utilisateur est PRÉVENU que des lignes ont été masquées");
assert.ok(logEl().textContent.includes("line-1500"), "les lignes les plus RÉCENTES sont conservées");
assert.ok(!logEl().textContent.includes("line-1\n"), "les plus anciennes ont bien été retirées");
ok(`plafond : ${lineCount()} lignes max, ${host().runState().dropped} masquée(s) et signalé(s)`);

/* ═════════ 5. Copier (log et erreur) ═════════ */
console.log("5. Boutons « Copier le log » et « Copier l'erreur »");

async function clickAction(action) {
    const btn = monitorEl().querySelector(`button[data-act="${action}"]`);
    assert.ok(btn, `bouton « ${action} » présent`);
    btn.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
    await tick(20);
    return btn;
}

clipboardWrites.length = 0;
await clickAction("copy-all");
assert.strictEqual(clipboardWrites.length, 1, "un seul appel au presse-papiers");
const copiedLog = clipboardWrites[0];
assert.ok(copiedLog.length > 100, "MUTANT M4 : le log copié n'est pas vide");
assert.ok(copiedLog.includes("line-1500"), "le log copié contient bien les lignes du worker");
assert.ok(/Run Modal #/.test(copiedLog), "le log copié porte l'en-tête du run (id, état, GPU, durée)");

// Échec du run : message + extrait de log copiables, état DISTINCT du succès.
clipboardWrites.length = 0;
workerTail.lines = linesFrom(1, 40).concat([
    "Traceback (most recent call last):",
    '  File "/root/comfy/ComfyUI/execution.py", line 12, in execute',
    "RuntimeError: CUDA out of memory",
]);
clipboardWrites.length = 0;
capRun.resolve(jsonResponse({ detail: "worker crashed" }, 500));
await tick(120);
assert.strictEqual(host().runState().status, "failed", "l'échec est un état distinct et lisible");
const errBox = monitorEl().querySelector(".comfych-run-error");
assert.ok(errBox && errBox.textContent.length > 0, "le bloc d'erreur est affiché dans la fenêtre");
assert.ok(/crashed|500/.test(errBox.textContent), "le message d'erreur du run est lisible");

await clickAction("copy-error");
assert.ok(clipboardWrites[0] && clipboardWrites[0].length > 0,
    "MUTANT M4 : « Copier l'erreur » copie un contenu NON VIDE");
assert.ok(/crashed|500/.test(clipboardWrites[0]), "le contenu copié contient le message d'erreur");
ok("copie du log complet et de l'erreur (contenu vérifié, jamais vide)");

/* ═════════ 6. Pause du défilement + « Aller à la fin » ═════════ */
console.log("6. Défilement : pause quand l'utilisateur remonte, retour explicite");

{
    const log = logEl();
    // jsdom ne calcule pas la mise en page : on simule un long log scrollé.
    Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => 2000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, get: () => 300 });
    log.scrollTop = 0;
    log.dispatchEvent(new domWindow.Event("scroll"));
    assert.strictEqual(host().runState().paused, true,
        "remonter dans le log met le défilement auto en PAUSE (on n'arrache pas la lecture)");
    const toEnd = monitorEl().querySelector('button[data-act="to-end"]');
    assert.notStrictEqual(toEnd.style.display, "none", "le bouton « Aller à la fin » apparaît");

    toEnd.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
    await tick(10);
    assert.strictEqual(host().runState().paused, false, "« Aller à la fin » réarme le défilement auto");
    assert.strictEqual(toEnd.style.display, "none", "le bouton disparaît une fois en bas");
    ok("pause de défilement + bouton « Aller à la fin » opérationnels");
}

/* ═════════ 7. Redémarrage du worker : confirmation puis POST ═════════ */
console.log("7. Redémarrage du worker : confirmation si un rendu tourne, puis POST");

// Le bouton des réglages est câblé sur restartWorker() : on vérifie le câblage.
{
    const settingsPromise = host().openSettings();
    await tick(120);
    const settingsOverlay = document.getElementById("modal-settings-overlay");
    assert.ok(settingsOverlay, "la modale de réglages s'ouvre (elle porte le bouton de redémarrage)");
    const wiredBtn = settingsOverlay.querySelector("#cfg-run-restart-worker");
    assert.ok(wiredBtn, "le bouton « Redémarrer » existe dans l'étape Build");
    // Nettoyage : la modale de réglages est un overlay plein écran (hors sujet ici).
    settingsOverlay.remove();
    void settingsPromise;
    ok("bouton « Redémarrer le worker » présent dans les réglages ComfyCH");
}

// (a) Un rendu tourne + confirmation REFUSÉE → aucun POST.
const confirmRun = await startRun();
assert.strictEqual(host().runState().running, true, "un rendu est en cours");
let confirmCalls = 0;
domWindow.AIH.confirm = () => { confirmCalls++; return Promise.resolve(false); };
restartCalls.length = 0;
await host().restartWorker();
await tick(40);
assert.strictEqual(confirmCalls, 1, "un rendu tourne : l'utilisateur est consulté d'abord");
assert.strictEqual(restartCalls.length, 0,
    "MUTANT M5 : refus = AUCUN redémarrage (le rendu n'est pas tué)");

// (b) Confirmation ACCEPTÉE → POST avec les deux drapeaux.
domWindow.AIH.confirm = () => { confirmCalls++; return Promise.resolve(true); };
await host().restartWorker();
await tick(80);
assert.strictEqual(restartCalls.length, 1, "le redémarrage est demandé APRÈS confirmation");
assert.strictEqual(restartCalls[0].method, "POST");
assert.deepStrictEqual(
    restartCalls[0].body,
    { render_in_progress: true, confirm: true },
    "le serveur reçoit l'état du rendu ET la confirmation (il peut refuser sinon)"
);
assert.ok(
    FakeEventSource.instances.some((es) => es.url.includes("/api/modal/logs/stream")),
    "les logs de l'opération passent par le SSE existant (/api/modal/logs/stream)"
);

// (c) Aucun rendu en cours → pas de question inutile.
confirmRun.resolve(jsonResponse({ images: [] }));
await tick(120);
restartCalls.length = 0;
confirmCalls = 0;
await host().restartWorker();
await tick(80);
assert.strictEqual(confirmCalls, 0, "aucun rendu en cours : aucune confirmation demandée");
assert.deepStrictEqual(restartCalls[0].body, { render_in_progress: false, confirm: false },
    "sans rendu en cours, le client annonce render_in_progress=false");
ok("redémarrage : confirmation obligatoire pendant un rendu, drapeaux envoyés au serveur");

/* ═════════ 8. i18n : parité stricte des clés utilisées ═════════ */
console.log("8. i18n FR/EN : toutes les clés utilisées par le module existent");

{
    const parseDicts = (source, name) => {
        const iFr = source.indexOf("const FR = {");
        const iEn = source.indexOf("const EN = {");
        assert.ok(iFr > 0 && iEn > iFr, `${name} : dictionnaires FR/EN introuvables`);
        const parse = (chunk) => {
            const out = {};
            const re = /"([^"]+)"\s*:\s*("(?:[^"\\]|\\.)*")/g;
            let m;
            while ((m = re.exec(chunk)) !== null) out[m[1]] = JSON.parse(m[2]);
            return out;
        };
        return { fr: parse(source.slice(iFr, iEn)), en: parse(source.slice(iEn)) };
    };

    const strings = parseDicts(readFileSync(join(HERE, "aih_strings.js"), "utf8"), "aih_strings.js");
    const i18n = parseDicts(readFileSync(join(HERE, "aih_i18n.js"), "utf8"), "aih_i18n.js");

    assert.deepStrictEqual(Object.keys(strings.fr).sort(), Object.keys(strings.en).sort(),
        "parité FR/EN cassée : jeux de clés différents dans aih_strings.js");

    const source = readFileSync(join(COMFYCH_DIR, "modal_gateway.js"), "utf8");
    const used = new Set();
    const re = /\bt\(\s*'([a-zA-Z][a-zA-Z0-9_.]*)'/g;
    let m;
    while ((m = re.exec(source)) !== null) used.add(m[1]);
    assert.ok(used.size >= 40, `le module utilise ${used.size} clés i18n`);

    const known = new Set([...Object.keys(strings.fr), ...Object.keys(i18n.fr)]);
    const missing = [...used].filter((k) => !known.has(k));
    assert.deepStrictEqual(missing, [], `clés i18n absentes des dictionnaires : ${missing}`);

    const added = [...used].filter((k) => k.startsWith("comfych."));
    assert.ok(added.length >= 40, `${added.length} clés comfych.* utilisées`);
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    for (const key of added) {
        assert.ok(String(strings.fr[key]).trim().length > 0, `clé FR vide : ${key}`);
        assert.ok(String(strings.en[key]).trim().length > 0, `clé EN vide : ${key}`);
        assert.ok(!emoji.test(strings.fr[key]), `emoji en FR dans « ${key} »`);
        assert.ok(!emoji.test(strings.en[key]), `emoji en EN dans « ${key} »`);
    }
    // Le module n'utilise AUCUN emoji dans le code du suivi de run
    // (les icônes passent par la façade js/aih_icons.js).
    const startIdx = source.indexOf("var RUN_MONITOR_ID");
    const endMarker = source.indexOf("renderToEndButton: function () {");
    const endIdx = source.indexOf("\n    };", endMarker);
    assert.ok(startIdx > 0 && endMarker > startIdx && endIdx > endMarker,
        "bloc du suivi de run introuvable dans le module");
    const runMonitorSource = source.slice(startIdx, endIdx);
    assert.ok(runMonitorSource.length > 2000, "le bloc du suivi de run est bien extrait");
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(runMonitorSource),
        "aucun emoji dans le code du suivi de run");
    ok(`${used.size} clés i18n utilisées — toutes présentes FR+EN, sans emoji`);
}

/* ═════════ 9. Contrôles négatifs par mutation ═════════ */
console.log("9. Mutants : fenêtre bloquante, fermeture qui annule, plafond, copie, redémarrage");

{
    const SRC = readFileSync(join(COMFYCH_DIR, "modal_gateway.js"), "utf8");

    for (const f of readdirSync(COMFYCH_DIR)) {
        if (/^\.__mut_runmon_\d+\.js$/.test(f)) rmSync(join(COMFYCH_DIR, f), { force: true });
    }

    let seq = 0;
    /**
     * Importe un MUTANT du module. Le fichier est écrit DANS js/comfych/ pour
     * que les imports relatifs (`../aih_icons.js`) résolvent comme en production.
     */
    async function loadMutant(label, mutate) {
        const mutated = mutate(SRC);
        assert.notStrictEqual(mutated, SRC, `mutation « ${label} » sans effet (ancre introuvable)`);
        const file = join(COMFYCH_DIR, `.__mut_runmon_${++seq}.js`);
        writeFileSync(file, mutated, "utf8");
        // Remise à zéro : aucune fenêtre résiduelle, aucun pont précédent.
        document.querySelectorAll(".aih-dialog-overlay").forEach((el) => el.remove());
        document.getElementById("comfych-run-monitor")?.remove();
        delete domWindow.AIHComfyCHHost;
        await import("file://" + file + "?m=" + seq);
        await tick(950); // interception de queuePrompt (800 ms) + config
        const mutantHost = domWindow.AIHComfyCHHost;
        assert.ok(mutantHost, `mutation « ${label} » : pont du module absent`);
        // Le sélecteur partagé reste en mode cloud (une seule instance dans le DOM).
        document.getElementById("modal-gpu-selector").value = "modal:h100";
        return { bridge: mutantHost, file };
    }

    function cleanupMutant(handle) {
        try {
            if (handle.bridge.runState().running) handle.bridge.openRunMonitor();
        } catch { /* ignore */ }
        if (document.getElementById("comfych-run-monitor")) {
            document.getElementById("comfych-run-monitor").remove();
        }
        document.querySelectorAll(".aih-dialog-overlay").forEach((el) => el.remove());
        delete domWindow.AIHComfyCHHost;
        rmSync(handle.file, { force: true });
    }

    async function startMutantRun() {
        const deferred = pendingGenerate();
        generateQueue.push(deferred);
        fakeApi.queuePrompt(1, { nodes: [] }, {}).catch(() => { /* échec attendu */ });
        await tick(80);
        return deferred;
    }

    // M1 — fenêtre MODALE (overlay plein écran) : les clics ComfyUI sont captés.
    {
        const handle = await loadMutant(
            "fenêtre modale (overlay)",
            (s) => s.replace("                modal: false,\n", "                modal: true,\n")
        );
        try {
            const deferred = await startMutantRun();
            assert.notDeepStrictEqual(
                overlays(), [],
                "mutant M1 : en modal:true un overlay plein écran apparaît → l'assertion (1) serait ROUGE"
            );
            deferred.resolve(jsonResponse({ images: [] }));
        } finally {
            cleanupMutant(handle);
        }
        ok("M1 fenêtre modale → overlay capturant, l'assertion (1) devient ROUGE");
    }

    // M2 — la fermeture ANNULE le run.
    {
        const handle = await loadMutant(
            "fermeture qui annule le run",
            (s) => s.replace(
                "                    // Fermer ≠ annuler : on oublie seulement le DOM.\n                    self.ctrl = null;",
                "                    self.finish('cancelled', 'closed');\n                    self.ctrl = null;"
            )
        );
        try {
            const deferred = await startMutantRun();
            document.getElementById("comfych-run-monitor")
                .querySelector(".aih-dialog-close")
                .dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
            await tick(20);
            assert.strictEqual(handle.bridge.runState().running, false,
                "mutant M2 : la fermeture conclut le run → l'assertion (2) serait ROUGE");
            deferred.resolve(jsonResponse({ images: [] }));
        } finally {
            cleanupMutant(handle);
        }
        ok("M2 fermeture qui annule → run interrompu, l'assertion (2) devient ROUGE");
    }

    // M3 — plafond de logs ignoré.
    {
        const handle = await loadMutant(
            "plafond de logs ignoré",
            (s) => s.replace(
                "            if (this.lines.length > RUN_LOG_MAX_LINES) {",
                "            if (false) {"
            )
        );
        try {
            workerTail.lines = linesFrom(1, 1500);
            const deferred = await startMutantRun();
            await tick(80);
            const keptMutant = document.getElementById("comfych-run-monitor")
                .querySelector(".comfych-run-log").textContent
                .split("\n").filter((l) => l.startsWith("line-")).length;
            assert.ok(keptMutant > 800,
                `mutant M3 : ${keptMutant} lignes conservées → l'assertion (4) serait ROUGE`);
            deferred.resolve(jsonResponse({ images: [] }));
        } finally {
            cleanupMutant(handle);
        }
        ok("M3 plafond ignoré → plus de 800 lignes, l'assertion (4) devient ROUGE");
    }

    // M4 — « Copier » colle un contenu vide.
    {
        const handle = await loadMutant(
            "copie d'un contenu vide",
            (s) => s.replace(
                "                copyToClipboard(this.fullLogText()).then(function (ok) {",
                "                copyToClipboard('').then(function (ok) {"
            )
        );
        try {
            workerTail.lines = linesFrom(1, 30);
            const deferred = await startMutantRun();
            deferred.resolve(jsonResponse({ images: [] }));
            await tick(80);
            clipboardWrites.length = 0;
            document.getElementById("comfych-run-monitor")
                .querySelector('button[data-act="copy-all"]')
                .dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
            await tick(20);
            assert.strictEqual(clipboardWrites[0], "",
                "mutant M4 : la copie est VIDE → l'assertion (5) serait ROUGE");
        } finally {
            cleanupMutant(handle);
        }
        ok("M4 copie vide → presse-papiers vide, l'assertion (5) devient ROUGE");
    }

    // M5 — redémarrage SANS confirmation alors qu'un rendu tourne.
    {
        const handle = await loadMutant(
            "redémarrage sans confirmation",
            (s) => s.replace(
                "            var confirmed = await confirmRestartDuringRender();",
                "            var confirmed = true;"
            )
        );
        try {
            const deferred = await startMutantRun();
            domWindow.AIH.confirm = () => Promise.resolve(false);
            restartCalls.length = 0;
            await handle.bridge.restartWorker();
            await tick(80);
            assert.strictEqual(restartCalls.length, 1,
                "mutant M5 : le redémarrage part SANS confirmation → l'assertion (7a) serait ROUGE");
            deferred.resolve(jsonResponse({ images: [] }));
        } finally {
            cleanupMutant(handle);
        }
        ok("M5 redémarrage sans confirmation → POST immédiat, l'assertion (7a) devient ROUGE");
    }

    assert.strictEqual(readFileSync(join(COMFYCH_DIR, "modal_gateway.js"), "utf8"), SRC,
        "source intacte après les mutations (aucune modification laissée sur disque)");
    assert.strictEqual(
        readdirSync(COMFYCH_DIR).filter((f) => /^\.__mut_runmon_\d+\.js$/.test(f)).length,
        0,
        "aucun fichier mutant résiduel dans js/comfych/"
    );
    ok("source intacte, aucun mutant résiduel");
}

console.log(`\n✅ ComfyCH — suivi de run non bloquant + redémarrage du worker : TOUS LES TESTS PASSENT (${n} groupes)`);
process.exit(0);
