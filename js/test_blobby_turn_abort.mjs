// ─────────────────────────────────────────────────────────────────────────
// Chat Blobby — INDICATEUR D'ACTIVITÉ + BOUTON D'ABANDON (⏹ Stop).
//
// Demande utilisateur : « un indicateur d'activité + un bouton abort » pendant
// que Blobby travaille (réflexion, streaming, outil, tours d'outils successifs).
//
// Couverture :
//   (A) l'indicateur apparaît au lancement d'un tour et DISPARAÎT à la fin
//       (succès) — le texte streame PENDANT l'indicateur ;
//   (B) l'abandon (bouton / API) déclenche bien l'annulation : AbortController
//       aborté + reader.cancel() appelés (assertions vérifiables) ;
//   (C) l'abandon STOPPE la boucle d'outils (aucun tour suivant lancé) ;
//   (D) l'abandon affiche un état « interrompu » DISTINCT du message
//       d'INACTIVITÉ (bl.llmIdle) — jamais confondus ;
//   (E) aucun TIMER orphelin après abandon (le watchdog d'inactivité est
//       désarmé) ;
//   (F) double-clic / clic après la fin : inoffensif ;
//   (G) l'abandon pendant l'exécution d'un outil NON annulable signale qu'il
//       peut finir côté serveur ;
//   (H) i18n FR/EN (parité stricte des nouvelles clés) ;
//   (I) INVARIANTS STATIQUES : finalisation du tour, indicateur hors défilement.
//
// Contrôles négatifs PAR MUTATION : voir /projects/.aih_tmp/blobby_turn_abort/
// mutate.sh (retirer l'annulation → rouge ; retirer le nettoyage de l'indicateur
// → rouge ; confondre abandon et inactivité → rouge).
//
// Usage : node js/test_blobby_turn_abort.mjs
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const JSDOM = await loadJsdomOrSkip("test_blobby_turn_abort");
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
});
const { window: domWindow } = dom;

globalThis.window = domWindow;
globalThis.document = domWindow.document;
globalThis.localStorage = domWindow.localStorage;
globalThis.getComputedStyle = domWindow.getComputedStyle.bind(domWindow);
globalThis.HTMLElement = domWindow.HTMLElement;
globalThis.Node = domWindow.Node;
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
try { globalThis.navigator = domWindow.navigator; } catch { /* Node fournit déjà un navigator */ }
domWindow.matchMedia = domWindow.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));

localStorage.setItem("aih_locale", "fr");
localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "http://aih.test", apiKey: "k", blobbyPreset: "3" }));

// ── Instrumentation des timers : détecte un watchdog d'inactivité ORPHELIN ──
// On enregistre les setTimeout par délai ; après abandon, AUCUN timer armé avec
// le délai du watchdog ne doit subsister.
const _origSetTimeout = globalThis.setTimeout;
const _origClearTimeout = globalThis.clearTimeout;
const pendingTimers = new Map(); // id -> delay(ms)
globalThis.setTimeout = function (fn, ms) {
    const args = Array.prototype.slice.call(arguments, 2);
    const id = _origSetTimeout(function () {
        pendingTimers.delete(id);
        return fn.apply(this, arguments);
    }, ms, ...args);
    pendingTimers.set(id, ms);
    return id;
};
globalThis.clearTimeout = function (id) {
    pendingTimers.delete(id);
    return _origClearTimeout(id);
};
const pendingWithDelay = (ms) => [...pendingTimers.values()].filter((d) => d === ms).length;

// ── Fake fetch pilotable (flux NDJSON + JSON) ───────────────────────────
const httpCalls = [];       // { url, method, body, signal }
const streamPlans = [];     // { chunks: [...] }
let streamCancelCount = 0;  // incrémenté à chaque reader.cancel() (annulation propre)
let streamErrorCount = 0;

const ndjson = (obj) => JSON.stringify(obj) + "\n";

function jsonResponse(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) },
        json: async () => data,
        text: async () => JSON.stringify(data),
    };
}

// Vraie ReadableStream (lue via res.body.getReader()) : l'abort du signal
// reçu par fetch PROVOQUE l'erreur du flux, comme le vrai fetch.
function streamResponse(chunks, signal, hold) {
    const enc = new TextEncoder();
    let cancelled = false;
    let finished = false;
    let pendingRead = false;
    const realBody = new ReadableStream({
        start(controller) {
            if (signal) {
                signal.addEventListener("abort", () => {
                    streamErrorCount++;
                    if (finished || cancelled || !pendingRead) return;
                    try { controller.error(Object.assign(new Error("Aborted"), { name: "AbortError" })); } catch { /* ignore */ }
                }, { once: true });
            }
            (async () => {
                for (const ch of chunks) {
                    if (cancelled) return;
                    if (ch.wait) await new Promise((r) => _origSetTimeout(r, ch.wait));
                    if (cancelled) return;
                    pendingRead = false;
                    try { controller.enqueue(enc.encode(ch.text)); } catch { return; }
                }
                if (!cancelled && !hold) { finished = true; try { controller.close(); } catch { /* ignore */ } }
            })();
        },
        pull() { pendingRead = true; },
        cancel() { cancelled = true; },
    });
    // Compte EXPLICITEMENT les appels `reader.cancel()` du helper (annulation
    // propre du flux). Le `cancel()` sous-jacent peut être ignoré sur un flux
    // déjà en erreur — on vérifie donc l'appel, pas l'effet sur la source.
    const body = {
        getReader() {
            const r = realBody.getReader();
            const origCancel = r.cancel.bind(r);
            r.cancel = function () { streamCancelCount++; return origCancel(); };
            return r;
        },
    };
    return {
        ok: true,
        status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/x-ndjson" : null) },
        body,
        json: async () => ({}),
        text: async () => "",
    };
}

globalThis.fetch = async (url, init) => {
    const u = String(url);
    let body = null;
    try { body = init && typeof init.body === "string" ? JSON.parse(init.body) : null; } catch { body = init?.body ?? null; }
    httpCalls.push({ url: u, method: (init && init.method) || "GET", body, signal: init && init.signal });

    if (u.includes("/api/keywords/llm-process/stream")) {
        const plan = streamPlans.shift();
        assert.ok(plan, "un plan de flux NDJSON doit être armé avant l'appel");
        const chunks = plan.chunks.map((c) => (typeof c === "string" ? { text: c } : c));
        return streamResponse(chunks, init && init.signal, plan.hold === true);
    }
    if (u.includes("/api/keywords/llm-process")) return jsonResponse({ output: "json-non-stream" });
    if (u.includes("/api/blobby/memory")) return jsonResponse({ results: [] });
    if (u.includes("/api/presets")) return jsonResponse([]);
    if (u.includes("/api/settings")) return jsonResponse({});
    return jsonResponse({});
};

// ── Faux app ComfyUI ────────────────────────────────────────────────────
function freshApp() {
    const app = { graph: { nodes: [], setDirtyCanvas() {}, getNodeById() { return null; } }, canvas: { setDirtyCanvas() {}, centerOnNode() {} } };
    app.registerExtension = function (ext) { app.extensions.push(ext); };
    app.extensions = [];
    return app;
}
globalThis.window.app = freshApp();

await import("./aih_i18n.js");
await import("./blobby_companion.js");
const Blobby = domWindow.Blobby;
assert.ok(Blobby && typeof Blobby._handleChatMessage === "function", "Blobby exposé (window.Blobby)");
assert.ok(typeof Blobby._abortTurn === "function" && typeof Blobby._turnActive === "function", "API de tour exposée (_abortTurn/_turnActive)");
const BlobbyTools = domWindow.BlobbyTools;

// Modale factice (pour tester le bouton ⏹ Stop réel).
function mockOpenModal(opts) {
    const modal = document.createElement("div");
    modal.className = "aih-dialog-root " + (opts.className || "");
    const header = document.createElement("div");
    header.className = "aih-dialog-header";
    const body = document.createElement("div");
    body.className = "aih-dialog-body";
    if (opts.content) body.appendChild(opts.content);
    modal.appendChild(header);
    modal.appendChild(body);
    document.body.appendChild(modal);
    return { modal, el: modal, body, header, headerRight: header, close() { modal.remove(); } };
}
domWindow.aihOpenModalV2 = mockOpenModal;

const chat = document.createElement("div");
chat.id = "blobby-chat-msgs";
document.body.appendChild(chat);

const tick = (ms = 20) => new Promise((r) => _origSetTimeout(r, ms));
const withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise((_, rej) => _origSetTimeout(() => rej(new Error(`test timeout (${label})`)), ms)),
]);
const msgs = (role) => [...chat.querySelectorAll(".blobby-msg")].filter((el) => el.dataset.role === role);
const sysText = () => msgs("system").map((e) => e.textContent).join(" | ");
const activityEl = () => document.querySelector(".blobby-chat-activity");
const actVisible = () => { const el = activityEl(); return !!(el && el.classList.contains("on") && el.style.display === "flex"); };
function reset() {
    chat.innerHTML = "";
    document.querySelectorAll(".blobby-chat-activity").forEach((e) => e.remove());
    httpCalls.length = 0;
    streamPlans.length = 0;
    streamCancelCount = 0;
    streamErrorCount = 0;
    Blobby.setMode("read");
    BlobbyTools.dispatchToolCall = _origDispatch;
}
const _origDispatch = BlobbyTools.dispatchToolCall;

const doneEvent = (output) => ndjson({ status: "done", output, usage: {}, max_context: 8192, context_source: "manual" });

/* ══════════ (A) Indicateur : apparaît au lancement, disparaît à la fin ══ */
console.log("(A) Indicateur d'activité : visible pendant le tour, nettoyé à la fin");
reset();
domWindow.AIH_BLOBBY_IDLE_TIMEOUT_MS = 5000;
streamPlans.push({ chunks: [
    { text: ndjson({ status: "start" }) },
    { text: ndjson({ status: "delta", text: "Bon" }) },
    { text: ndjson({ status: "delta", text: "jour" }), wait: 80 },
    { text: doneEvent("Bonjour !") },
] });
{
    const p = withTimeout(Blobby._handleChatMessage(chat, "salut"), 8000, "A");
    await tick(30);
    assert.ok(activityEl(), "l'indicateur d'activité est créé");
    assert.ok(actVisible(), "l'indicateur est VISIBLE pendant le tour");
    assert.ok(Blobby._turnActive(), "_turnActive() vrai pendant le tour");
    // Le texte streame PENDANT l'indicateur (bulle temporaire présente).
    assert.ok(chat.querySelector(".blobby-msg-streaming"), "le texte streame pendant l'indicateur (bulle progressive)");
    await p;
    assert.ok(!actVisible(), "l'indicateur est MASQUÉ à la fin (succès) — aucun résidu");
    assert.ok(!Blobby._turnActive(), "_turnActive() faux après le tour");
    assert.ok(msgs("blobby").some((e) => e.textContent.includes("Bonjour")), "réponse finale affichée");
}
ok("(A) apparition pendant le tour + disparition à la fin");

/* ══════════ (B)(D)(E) Abandon : annulation réelle, état distinct, timers ══ */
console.log("(B) Abandon : AbortController/reader.cancel appelés + état distinct + timers");
reset();
domWindow.AIH_BLOBBY_IDLE_TIMEOUT_MS = 9999; // délai distinctif : détecte un watchdog orphelin
streamPlans.push({ hold: true, chunks: [
    { text: ndjson({ status: "start" }) },
    { text: ndjson({ status: "delta", text: "je réfléchis" }), wait: 20 },
    // ... puis la connexion reste OUVERTE (Blobby « travaille ») → on abandonne.
] });
{
    const p = withTimeout(Blobby._handleChatMessage(chat, "fais un truc long"), 8000, "B");
    await tick(60);
    assert.ok(actVisible(), "l'indicateur est visible pendant l'attente");
    const aborted = Blobby._abortTurn();
    assert.strictEqual(aborted, true, "l'abandon est pris en compte (true)");
    await p;
    const streamCall = httpCalls.find((c) => c.url.includes("/api/keywords/llm-process/stream"));
    assert.ok(streamCall, "appel streaming effectué");
    assert.ok(streamCall.signal && streamCall.signal.aborted === true, "AbortController aborté (annulation réelle du flux)");
    assert.ok(streamCancelCount >= 1, "reader.cancel() appelé (flux relâché proprement)");
    assert.ok(!actVisible(), "indicateur MASQUÉ après abandon (aucun fantôme)");
    assert.ok(!Blobby._turnActive(), "le tour est terminé après abandon");
    // (D) état « interrompu » DISTINCT du message d'inactivité.
    assert.ok(sysText().includes("Interrompu"), `état « interrompu » affiché : ${sysText()}`);
    assert.ok(!sysText().includes("ne renvoie plus rien"), "ce n'est PAS le message d'inactivité (bl.llmIdle)");
    assert.ok(!chat.textContent.includes("Erreur réseau"), "ce n'est PAS une erreur réseau");
    assert.ok(!msgs("blobby").some((e) => /Bonjour|json-non-stream/.test(e.textContent)), "aucun faux succès écrit");
    // (E) le watchdog d'INACTIVITÉ (délai 9999) est désarmé : aucun timer orphelin.
    await tick(30);
    assert.strictEqual(pendingWithDelay(9999), 0, "aucun watchdog d'inactivité orphelin après abandon");
}
ok("(B)(D)(E) annulation réelle + état interrompu distinct + zéro timer orphelin");

/* ══════════ (F) Double-clic / clic après la fin : inoffensif ═══════════ */
console.log("(F) Double-clic sur Stop et clic après la fin : inoffensif");
{
    assert.strictEqual(Blobby._abortTurn(), false, "second appel (double-clic) → false, inoffensif");
    assert.strictEqual(Blobby._turnActive(), false, "toujours inactif après la fin");
}
ok("(F) double-clic inoffensif");

/* ══════════ (C) L'abandon STOPPE la boucle d'outils ═════════════════════ */
console.log("(C) Abandon : la boucle d'outils ne lance AUCUN tour suivant");
reset();
domWindow.AIH_BLOBBY_IDLE_TIMEOUT_MS = 5000;
Blobby.setMode("active");
let dispatchCount = 0;
BlobbyTools.dispatchToolCall = async function () { dispatchCount++; return { ok: true, data: { nodes: [] } }; };
const toolCallResp = ndjson({ status: "done", output: "", tool_calls: [
    { id: "call_1", type: "function", function: { name: "list_nodes", arguments: "{}" } },
] });
// 1ᵉʳ tour : outil appelé ; 2ᵉ tour : flux maintenu ouvert → on abandonne.
streamPlans.push({ chunks: [{ text: toolCallResp }] });
streamPlans.push({ hold: true, chunks: [{ text: ndjson({ status: "delta", text: "…" }), wait: 20 }] });
{
    const p = withTimeout(Blobby._handleChatMessage(chat, "liste les nœuds"), 8000, "C");
    await tick(80);
    assert.ok(dispatchCount >= 1, "le 1ᵉʳ outil a bien été exécuté");
    const before = httpCalls.filter((c) => c.url.includes("/llm-process/stream")).length;
    assert.ok(before >= 2, "la boucle a atteint un tour suivant");
    Blobby._abortTurn();
    await p;
    await tick(80);
    const after = httpCalls.filter((c) => c.url.includes("/llm-process/stream")).length;
    assert.strictEqual(after, before, "AUCUN tour d'outil suivant lancé après l'abandon");
    assert.ok(sysText().includes("Interrompu"), "état interrompu affiché pendant la boucle d'outils");
}
ok("(C) boucle d'outils stoppée (aucun send supplémentaire)");

/* ══════════ (G) Outil NON annulable : l'état le signale ════════════════ */
console.log("(G) Abandon pendant un outil en cours : message « peut finir »");
reset();
domWindow.AIH_BLOBBY_IDLE_TIMEOUT_MS = 5000;
Blobby.setMode("active");
let resolveTool;
BlobbyTools.dispatchToolCall = function () { return new Promise((res) => { resolveTool = res; }); };
streamPlans.push({ chunks: [{ text: toolCallResp }] });
{
    const p = withTimeout(Blobby._handleChatMessage(chat, "lance un outil long"), 8000, "G");
    // Attend que l'outil soit réellement EN COURS (promesse non résolue).
    for (let i = 0; i < 100 && typeof resolveTool !== "function"; i++) await tick(10);
    assert.strictEqual(typeof resolveTool, "function", "l'outil est en cours d'exécution");
    assert.ok(actVisible(), "l'indicateur signale l'outil en cours");
    Blobby._abortTurn();
    // L'outil non annulable se termine ensuite.
    resolveTool({ ok: true, data: { done: true } });
    await p;
    assert.ok(sysText().includes("Interrompu"), "état interrompu");
    assert.ok(/peut se terminer|15 s/.test(sysText()), `le message signale que l'outil peut finir : ${sysText()}`);
}
ok("(G) outil non annulable signalé dans l'état d'abandon");

/* ══════════ Bouton réel de la modale : ➤ → ⏹ Stop → ➤ ══════════════════ */
console.log("(Bouton) le bouton d'envoi devient ⏹ Stop pendant un tour");
reset();
document.querySelectorAll(".aih-dialog-root").forEach((e) => e.remove());
Blobby._openChatModal();
await tick(30);
{
    const btn = document.querySelector(".blobby-chat-send");
    assert.ok(btn, "bouton d'envoi présent dans la modale");
    assert.ok(btn.textContent.includes("➤"), "au repos : bouton ➤");
    const chatInModal = document.getElementById("blobby-chat-msgs");
    domWindow.AIH_BLOBBY_IDLE_TIMEOUT_MS = 5000;
    streamPlans.push({ hold: true, chunks: [{ text: ndjson({ status: "start" }) }] });
    const p = withTimeout(Blobby._handleChatMessage(chatInModal, "coucou"), 8000, "btn");
    await tick(40);
    assert.ok(btn.textContent.includes("Stop"), `pendant le tour : bouton ⏹ Stop (${btn.textContent})`);
    assert.ok(btn.classList.contains("blobby-chat-stop"), "classe blobby-chat-stop présente");
    btn.onclick({ stopPropagation() {} }); // clic = abandon
    await p;
    assert.ok(btn.textContent.includes("➤"), "après la fin : bouton revenu à ➤");
    assert.ok(!btn.classList.contains("blobby-chat-stop"), "classe stop retirée");
    // Clic après la fin sans texte : inoffensif (n'ouvre aucun tour).
    btn.onclick({ stopPropagation() {} });
    assert.ok(!Blobby._turnActive(), "clic après la fin : aucun tour lancé");
}
ok("(Bouton) bascule ➤ ⇄ ⏹ Stop correcte et clic final inoffensif");

/* ══════════ (H) i18n FR/EN ═════════════════════════════════════════════ */
console.log("(H) i18n : clés d'abandon présentes en FR et EN");
{
    const here = path.dirname(fileURLToPath(import.meta.url));
    const stringsSrc = fs.readFileSync(path.join(here, "aih_strings.js"), "utf8");
    for (const key of ["bl.stop", "bl.stopTitle", "bl.sendTitle", "bl.aborting", "bl.interrupted", "bl.interruptedNote"]) {
        const re = new RegExp('"' + key.replace(/\./g, "\\.") + '"\\s*:', "g");
        assert.strictEqual((stringsSrc.match(re) || []).length, 2, `${key} définie exactement 2x (FR + EN)`);
    }
}
ok("(H) parité FR/EN des clés d'abandon");

/* ══════════ (I) Invariants STATIQUES ═══════════════════════════════════ */
console.log("(I) Invariants statiques : finalisation, indicateur hors défilement");
{
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, "blobby_companion.js"), "utf8");
    // Finalisation GARANTIE du tour (finally) → indicateur + bouton nettoyés.
    assert.ok(/try\s*\{[\s\S]*?_runChatTurn[\s\S]*?\}\s*finally\s*\{[\s\S]*?_blobbyTurnEnd\(\)/.test(src),
        "le tour se termine dans un finally (_blobbyTurnEnd toujours appelé)");
    // L'abandon propage l'annulation au flux via opts.signal.
    assert.ok(/opts\.signal/.test(src), "le streaming accepte un signal d'abandon externe");
    assert.ok(/signal:\s*_blobbyTurnSignal\(\)/.test(src), "le chat relie l'abandon du tour au flux");
    // L'indicateur vit HORS de la zone de défilement des messages.
    assert.ok(/blobby-chat-activity/.test(src), "barre d'activité définie");
    assert.ok(/bodyWrapper\.appendChild\(activityBar\)/.test(src), "barre d'activité ajoutée au corps (hors messages)");
    // La boucle d'outils vérifie l'abandon avant chaque send.
    assert.ok(/_blobbyTurnAborted\(\)\)\s*throw\s*_blobbyAbortError\(\)/.test(src), "send() refuse de démarrer un tour après abandon");
    // Plus de message système de « thinking » défilant (remplacé par la barre).
    assert.ok(!/_addChatMessage\(container,\s*'system',\s*t\("bl\.thinking"\)\)/.test(src),
        "plus de faux message système « thinking » (indicateur dédié)");
}
ok("(I) invariants statiques");

/* ══════════ (J) Nettoyage CIBLÉ : un message d'état légitime survit ════ */
console.log("(J) _removeThinking ne supprime QUE les marqueurs de réflexion legacy");
{
    const c = document.createElement("div");
    const shellMsg = document.createElement("div");
    shellMsg.className = "blobby-msg";
    shellMsg.dataset.role = "system";
    shellMsg.textContent = "⚠️ Accès au shell AUTORISÉ (mode Actif) : Blobby peut exécuter des commandes locales.";
    c.appendChild(shellMsg);
    const legacy = document.createElement("div");
    legacy.className = "blobby-msg";
    legacy.dataset.role = "system";
    legacy.textContent = "🤔 Blobby réfléchit...";
    c.appendChild(legacy);
    Blobby._removeThinking(c);
    assert.ok(c.contains(shellMsg), "un message d'état légitime mentionnant Blobby N'EST PAS supprimé");
    assert.ok(!c.contains(legacy), "le marqueur de réflexion legacy est bien nettoyé");
}
ok("(J) nettoyage ciblé des marqueurs legacy (pas de message d'état légitime supprimé)");

// Restaure les timers instrumentés (propreté du processus de test).
globalThis.setTimeout = _origSetTimeout;
globalThis.clearTimeout = _origClearTimeout;

console.log(`\n✅ Chat Blobby — indicateur d'activité + abandon (⏹ Stop) : ${n} groupes d'assertions PASSENT`);
