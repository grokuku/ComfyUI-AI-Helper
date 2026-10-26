// ─────────────────────────────────────────────────────────────────────────
// ComfyCH — « Copier l'erreur » ≠ « Copier le log » (retour utilisateur).
//
// RETOUR UTILISATEUR, cité tel quel : « j'ai l'impression que les boutons copy
// error et copy log ça fait la même chose, non ? ». En pratique OUI : l'extrait
// remontait tout depuis le dernier « Traceback », donc le LOG ENTIER quand le
// traceback était en haut du fichier (et jusqu'à 200 lignes par le repli par
// motifs). Les deux boutons copiaient donc, la plupart du temps, la même chose.
//
// Ce que ce fichier verrouille (chaque point a son mutant) :
//   §1 « Copier le log » copie TOUT (toutes les lignes + en-tête du run) ;
//   §2 « Copier l'erreur » copie UNIQUEMENT l'erreur : message du run + extrait
//      de pile BORNÉ (≤ RUN_ERROR_MAX_LINES lignes), et JAMAIS les lignes
//      neutres du log — MUTANT M1 « copy-error copie le log » → ROUGE ;
//   §3 sans erreur détectable, le bouton est DÉSACTIVÉ et le clic ne copie
//      rien du tout — MUTANT M2 « bouton toujours actif » → ROUGE ;
//   §4 une erreur détectée dans le LOG seul (run terminé « success ») active le
//      bouton, et l'extrait suit les lignes de pile (continuations) ;
//   §5 la primitive pure `extractErrorExcerpt` est bornée dans TOUS les cas —
//      MUTANT M3 « extrait non borné » → ROUGE ;
//   §6 i18n : les clés ajoutées existent en FR ET EN (vérifié aussi par
//      test_comfych_run_monitor.mjs §8).
//
// Usage : node js/test_comfych_run_copy_error.mjs
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

const JSDOM = await loadJsdomOrSkip("test_comfych_run_copy_error");
const dom = new JSDOM(
    `<!doctype html><html><head></head><body>
       <div id="comfy-canvas"></div>
       <button id="cfg-run-restart-worker"></button>
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
localStorage.setItem("modal-gateway-mode", "modal:h100");

/* ══════════════ Harnais : fetch contrôlable + presse-papiers ══════════════ */

const workerTail = { lines: [] };
const generateQueue = [];

function pendingGenerate() {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
}

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
        return jsonResponse({ lines: workerTail.lines.slice() });
    }
    if (target.includes("/generate")) {
        // Le deferred est créé et poussé par startRun() : c'est lui que le test
        // résout pour conclure le run (aucune attente réelle).
        const deferred = generateQueue.shift();
        void opts;
        return deferred.promise;
    }
    if (target.includes("/api/modal/restart-worker")) {
        return jsonResponse({ ok: true, message: "ok" });
    }
    return jsonResponse({});
};

class FakeEventSource {
    constructor(url) { this.url = url; this.closed = false; }
    addEventListener() {}
    close() { this.closed = true; }
}
globalThis.EventSource = FakeEventSource;
domWindow.EventSource = FakeEventSource;

const clipboardWrites = [];
try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: domWindow.navigator });
} catch { /* ignore */ }
try {
    Object.defineProperty(globalThis.navigator, "clipboard", {
        configurable: true,
        value: {
            writeText(text) { clipboardWrites.push(String(text)); return Promise.resolve(); },
        },
    });
} catch { /* ignore */ }

/* Faux app ComfyUI (point d'interception de queuePrompt). */
const fakeApi = { queuePrompt() { return Promise.resolve({}); } };
const app = {
    graph: { nodes: [] },
    canvas: {},
    ui: {},
    api: fakeApi,
    extensions: [],
    menu: { settingsGroup: { element: document.getElementById("cfg-run-restart-worker") } },
    registerExtension(ext) { app.extensions.push(ext); },
};
globalThis.window.app = app;
domWindow.app = app;
globalThis.app = app;
domWindow.api = fakeApi;
domWindow.comfyAPI = { app: { app } };

await import("./comfych_gateway.js");
await import("./comfych/modal_gateway.js");
await tick(1000);

const host = () => domWindow.AIHComfyCHHost;
assert.ok(host(), "pont window.AIHComfyCHHost exposé");
assert.strictEqual(typeof host().extractErrorExcerpt, "function",
    "primitive pure extractErrorExcerpt exposée (heuristique testable sans DOM)");

const controls = host().buildControls();
document.body.appendChild(controls);
document.getElementById("modal-gpu-selector").value = "modal:h100";

const monitorEl = () => document.getElementById("comfych-run-monitor");
const copyErrorBtn = () => monitorEl().querySelector('button[data-act="copy-error"]');
const logEl = () => monitorEl().querySelector(".comfych-run-log");
function linesFrom(start, end, prefix) {
    const out = [];
    for (let i = start; i <= end; i++) out.push(`${prefix || "line"}-${i}`);
    return out;
}
async function startRun() {
    const deferred = pendingGenerate();
    generateQueue.push(deferred);
    fakeApi.queuePrompt(1, { nodes: [] }, {}).catch(() => { /* échec attendu en test */ });
    await tick(80);
    return deferred;
}
async function clickAction(action) {
    const btn = monitorEl().querySelector(`button[data-act="${action}"]`);
    assert.ok(btn, `bouton « ${action} » présent`);
    btn.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
    await tick(20);
    return btn;
}

/* ═════════ 5 (primitive pure, testée en premier : aucun DOM requis) ═════════ */
console.log("5. Primitive pure : extrait d'erreur borné, heuristique explicite");

{
    const extract = host().extractErrorExcerpt;

    assert.strictEqual(extract([]), "", "log vide ⇒ aucun extrait");
    assert.strictEqual(extract(["ligne normale", "encore normale"]), "",
        "sans motif d'erreur ⇒ AUCUN extrait (le bouton sera désactivé)");

    // Traceback EN HAUT d'un log de 1500 lignes : l'ancien code copiait 1495
    // lignes ; le nouveau doit se limiter au plafond.
    const huge = ["Traceback (most recent call last):"]
        .concat(linesFrom(1, 1495))
        .concat(['  File "/root/comfy/ComfyUI/execution.py", line 42, in execute',
                 "RuntimeError: CUDA out of memory"]);
    const excerpt = extract(huge, 60);
    const excerptLines = excerpt.split("\n").filter((l) => l.length > 0);
    assert.ok(excerptLines.length <= 60, `MUTANT M3 : extrait borné (${excerptLines.length} lignes)`);
    assert.ok(excerpt.includes("RuntimeError: CUDA out of memory"),
        "l'exception FINALE est conservée (la plus informative)");
    assert.ok(!excerpt.includes("line-1\n"), "le début du log n'est pas aspiré");

    // Repli par motifs : lignes d'erreur + continuations de pile.
    const motifs = [
        "line-1", "line-2",
        "2026-01-01 ERROR something failed",
        '  File "/x.py", line 3, in f',
        "    raise RuntimeError('boom')",
        "line-3",
        "Exception: kaput",
        "line-4",
    ];
    const byMotifs = extract(motifs, 60);
    assert.ok(byMotifs.includes("ERROR something failed"), "ligne ERROR retenue");
    assert.ok(byMotifs.includes('File "/x.py", line 3, in f'), "continuation de pile retenue");
    assert.ok(byMotifs.includes("Exception: kaput"), "ligne Exception retenue");
    assert.ok(!byMotifs.includes("line-3"), "les lignes neutres ne sont PAS copiées");

    // Un plafond personnalisé est respecté.
    const capped = extract(linesFrom(1, 200, "ERROR boom"), 5);
    assert.strictEqual(capped.split("\n").length, 5, "plafond explicite respecté");

    ok("extrait borné, continuations suivies, lignes neutres exclues");
}

/* ═════════ 1. « Copier le log » = TOUT le log ═════════ */
console.log("1. « Copier le log » copie l'intégralité des lignes reçues");

const run1 = await startRun();
// 300 lignes < plafond de rétention (800) : « Copier le log » doit TOUT contenir.
workerTail.lines = linesFrom(1, 300).concat(["ERROR something odd happened"]);
run1.resolve(jsonResponse({ images: [] }, 200));
await tick(200);

clipboardWrites.length = 0;
await clickAction("copy-all");
const fullLog = clipboardWrites[0];
assert.ok(fullLog, "le log complet est copié");
assert.ok(fullLog.includes("line-1\n") || fullLog.includes("line-1\r\n"),
    `la PREMIÈRE ligne du log est copiée (c'est bien le log complet) — reçu: ${JSON.stringify(fullLog.slice(0, 300))}`);
assert.ok(fullLog.includes("line-300"), "la DERNIÈRE ligne aussi");
assert.ok(/Run Modal #/.test(fullLog), "l'en-tête du run accompagne le log");
ok(`« Copier le log » : ${fullLog.split("\n").length} lignes copiées (log entier + en-tête)`);

/* ═════════ 2. « Copier l'erreur » = UNIQUEMENT l'erreur ═════════ */
console.log("2. « Copier l'erreur » ne copie QUE l'erreur (jamais les 300 lignes)");

clipboardWrites.length = 0;
await clickAction("copy-error");
const copiedError = clipboardWrites[0] || "";
const errorLines = copiedError.split("\n").filter((l) => l.length > 0);

assert.ok(copiedError.length > 0, "un contenu est copié (une erreur existe dans le log)");
assert.ok(copiedError.includes("ERROR something odd happened"), "l'erreur est bien présente");
assert.ok(errorLines.length <= 61,
    `MUTANT M1 : l'erreur copiée doit rester un EXTRAIT (${errorLines.length} lignes)`);
assert.ok(!copiedError.includes("line-10\n"), "les lignes neutres du log ne sont PAS copiées");
assert.notStrictEqual(copiedError, fullLog,
    "« Copier l'erreur » et « Copier le log » ne donnent PAS le même contenu");
assert.ok(copiedError.length < fullLog.length / 4,
    `l'erreur (${copiedError.length} o) est bien plus courte que le log (${fullLog.length} o)`);
ok(`« Copier l'erreur » : ${errorLines.length} ligne(s) — extrait seul, distinct du log`);

/* ═════════ 3. Aucune erreur ⇒ bouton DÉSACTIVÉ, clic sans effet ═════════ */
console.log("3. Sans erreur détectable : bouton désactivé (aucune copie)");

// La queue est posée AVANT le run : le suivi lit le log dès son ouverture.
workerTail.lines = linesFrom(1, 30);       // aucune ligne d'erreur
const run3 = await startRun();
run3.resolve(jsonResponse({ images: [] }, 200));
await tick(200);

const btn = copyErrorBtn();
assert.ok(btn, "le bouton « Copier l'erreur » existe");
assert.strictEqual(btn.disabled, true,
    `MUTANT M2 : sans erreur, le bouton est DÉSACTIVÉ (pas de copie du log entier) — état=${JSON.stringify(host().runState())} title=${btn.title}`);
assert.strictEqual(btn.getAttribute("aria-disabled"), "true", "l'état est exposé aux lecteurs d'écran");
assert.ok(/Aucune erreur/i.test(btn.title), `l'infobulle explique pourquoi : « ${btn.title} »`);

clipboardWrites.length = 0;
await clickAction("copy-error");
assert.deepStrictEqual(clipboardWrites, [],
    "MUTANT M2 : un clic sur le bouton désactivé ne copie RIEN (surtout pas le log)");
ok("bouton désactivé, infobulle explicite, aucun contenu copié");

/* ═════════ 4. Erreur détectée dans le LOG seul ⇒ bouton actif ═════════ */
console.log("4. Erreur présente dans le log d'un run « success » : bouton actif");

workerTail.lines = linesFrom(1, 20).concat([
    "Traceback (most recent call last):",
    '  File "/root/comfy/ComfyUI/nodes.py", line 7, in execute',
    "KeyError: 'model'",
]).concat(linesFrom(21, 40));
const run4 = await startRun();
run4.resolve(jsonResponse({ images: [] }, 200));
await tick(200);

assert.strictEqual(host().runState().status, "success", "le run est bien conclu en succès");
assert.strictEqual(copyErrorBtn().disabled, false,
    "une erreur dans le log active le bouton, même si le run a réussi");
assert.ok(/extrait/i.test(copyErrorBtn().title), "l'infobulle décrit ce qui sera copié");

clipboardWrites.length = 0;
await clickAction("copy-error");
const tracebackCopy = clipboardWrites[0] || "";
assert.ok(tracebackCopy.includes("KeyError: 'model'"), "l'exception finale est copiée");
assert.ok(tracebackCopy.includes("Traceback (most recent call last):"), "le bloc de pile est copié");
assert.ok(!tracebackCopy.includes("line-2\n"), "aucune ligne neutre");
ok("extrait = dernier bloc de pile, borné, activé sans échec du run");

/* ═════════ 6. i18n des clés ajoutées ═════════ */
console.log("6. i18n : les clés ajoutées existent en FR et en EN");

{
    const source = readFileSync(join(HERE, "aih_strings.js"), "utf8");
    for (const key of ["comfych.run.copyErrorHint", "comfych.run.copyErrorNone"]) {
        const occurrences = source.split(`"${key}"`).length - 1;
        assert.strictEqual(occurrences, 2, `clé « ${key} » attendue en FR ET EN (${occurrences})`);
    }
    ok("clés copyErrorHint / copyErrorNone présentes FR+EN");
}

/* ═════════ 7. Mutants ═════════ */
console.log("7. Mutants : copie du log entier, bouton toujours actif, extrait non borné");

{
    const SRC = readFileSync(join(COMFYCH_DIR, "modal_gateway.js"), "utf8");
    for (const f of readdirSync(COMFYCH_DIR)) {
        if (/^\.__mut_copyerr_\d+\.js$/.test(f)) rmSync(join(COMFYCH_DIR, f), { force: true });
    }
    let seq = 0;

    async function loadMutant(label, mutate) {
        const mutated = mutate(SRC);
        assert.notStrictEqual(mutated, SRC, `mutation « ${label} » sans effet (ancre introuvable)`);
        const file = join(COMFYCH_DIR, `.__mut_copyerr_${++seq}.js`);
        writeFileSync(file, mutated, "utf8");
        document.querySelectorAll(".aih-dialog-overlay").forEach((el) => el.remove());
        document.getElementById("comfych-run-monitor")?.remove();
        delete domWindow.AIHComfyCHHost;
        await import("file://" + file + "?m=" + seq);
        await tick(950);
        const mutantHost = domWindow.AIHComfyCHHost;
        assert.ok(mutantHost, `mutation « ${label} » : pont du module absent`);
        document.getElementById("modal-gpu-selector").value = "modal:h100";
        return { bridge: mutantHost, file };
    }

    function cleanupMutant(handle) {
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

    // M1 — « Copier l'erreur » recopie le log complet (le bug signalé).
    {
        const handle = await loadMutant(
            "copy-error copie le log",
            (s) => s.replace(
                "                copyToClipboard(this.errorText()).then(function (ok) {",
                "                copyToClipboard(this.fullLogText()).then(function (ok) {"
            )
        );
        try {
            workerTail.lines = linesFrom(1, 400).concat(["ERROR boom"]);
            const deferred = await startMutantRun();
            deferred.resolve(jsonResponse({ images: [] }, 200));
            await tick(200);
            clipboardWrites.length = 0;
            document.getElementById("comfych-run-monitor")
                .querySelector('button[data-act="copy-error"]')
                .dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
            await tick(20);
            const copied = clipboardWrites[0] || "";
            const copiedLines = copied.split("\n").filter((l) => l.length > 0).length;
            assert.ok(copiedLines > 200 && copied.includes("line-10"),
                `mutant M1 : ${copiedLines} lignes copiées → l'assertion (2) serait ROUGE`);
        } finally {
            cleanupMutant(handle);
        }
        ok("M1 copy-error = log complet → l'assertion (2) devient ROUGE");
    }

    // M2 — bouton jamais désactivé.
    {
        const handle = await loadMutant(
            "bouton toujours actif",
            (s) => s.replace(
                "            els.copyError.disabled = !enabled;",
                "            els.copyError.disabled = false;"
            )
        );
        try {
            workerTail.lines = linesFrom(1, 20);
            const deferred = await startMutantRun();
            deferred.resolve(jsonResponse({ images: [] }, 200));
            await tick(200);
            const mutantBtn = document.getElementById("comfych-run-monitor")
                .querySelector('button[data-act="copy-error"]');
            assert.strictEqual(mutantBtn.disabled, false,
                "mutant M2 : sans erreur le bouton resterait actif → l'assertion (3) serait ROUGE");
        } finally {
            cleanupMutant(handle);
        }
        ok("M2 bouton toujours actif → l'assertion (3) devient ROUGE");
    }

    // M3 — extrait non borné (tout le log depuis le traceback).
    {
        const handle = await loadMutant(
            "extrait non borné",
            (s) => s.replace(
                "        var limit = maxLines > 0 ? maxLines : RUN_ERROR_MAX_LINES;",
                "        var limit = Infinity;"
            )
        );
        try {
            const huge = ["Traceback (most recent call last):"]
                .concat(linesFrom(1, 400))
                .concat(["RuntimeError: boom"]);
            const extract = handle.bridge.extractErrorExcerpt(huge, 60);
            const counted = extract.split("\n").filter((l) => l.length > 0).length;
            assert.ok(counted > 100,
                `mutant M3 : ${counted} lignes extraites → l'assertion (5) serait ROUGE`);
            workerTail.lines = [];
            const deferred = await startMutantRun();
            deferred.resolve(jsonResponse({ images: [] }, 200));
            await tick(120);
        } finally {
            cleanupMutant(handle);
        }
        ok("M3 extrait non borné → l'assertion (5) devient ROUGE");
    }

    assert.strictEqual(readFileSync(join(COMFYCH_DIR, "modal_gateway.js"), "utf8"), SRC,
        "source intacte après les mutations (aucune modification laissée sur disque)");
    assert.strictEqual(
        readdirSync(COMFYCH_DIR).filter((f) => /^\.__mut_copyerr_\d+\.js$/.test(f)).length,
        0,
        "aucun fichier mutant résiduel dans js/comfych/"
    );
    ok("source intacte, aucun mutant résiduel");
}

console.log(`\n✅ ComfyCH — « Copier l'erreur » ≠ « Copier le log » : TOUS LES TESTS PASSENT (${n} groupes)`);
process.exit(0);
