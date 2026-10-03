// ─────────────────────────────────────────────────────────────────────────
// Chat Blobby — STREAMING + watchdog d'INACTIVITÉ (jamais un plafond de durée
// totale). Vérifie la demande utilisateur : « une tâche un peu longue ne doit
// plus être coupée en plein milieu ; un vrai silence doit être signalé ».
//
// Couverture :
//   (a) réponse LENTE mais ACTIVE (durée totale >> seuil d'inactivité, chaque
//       morceau < seuil) → ABOUTIT (cœur de la demande) ;
//   (b) flux SILENCIEUX (aucun morceau > seuil) → coupé avec message explicite
//       (« le modèle ne renvoie plus rien depuis N s »), distinct d'un réseau ;
//   (c) RÉARMEMENT : activité régulière pendant longtemps → jamais coupé ;
//   (d) annulation propre : aucun timer/tâche résiduel (signal aborté, reader
//       relâché), pas de rejet non capturé ;
//   (e) INVARIANTS STATIQUES : le helper passe `timeout: 0` (aucune durée
//       totale), la route streaming est utilisée par le chat, le watchdog est
//       réarmé par morceau.
//
// Contrôles négatifs PAR MUTATION : voir /projects/.aih_tmp/blobby_chat_idle/
// mutate.py (réintroduire un plafond total → rouge ; retirer le réarmement →
// rouge ; revenir à la route JSON non streamée → rouge).
//
// Usage : node js/test_blobby_chat_idle_timeout.mjs
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const JSDOM = await loadJsdomOrSkip("test_blobby_chat_idle_timeout");
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

// ── Fake fetch : flux NDJSON pour la route /stream, JSON pour le reste ──
const httpCalls = [];       // { url, method, body, signal }
const streamPlans = [];     // { chunks: [{ text, wait }] }
let streamCancelCount = 0;  // compté à chaque reader.cancel() (annulation propre)
let streamEnqueued = 0;

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

// Vraie ReadableStream : le helper la lit via res.body.getReader(). Le signal
// reçu par fetch (init.signal) PROVOQUE l'erreur du flux : c'est ainsi qu'une
// annulation du watchdog se propage au reader (comme le vrai fetch).
function streamResponse(chunks, signal, hold) {
    const enc = new TextEncoder();
    let cancelled = false;
    let finished = false;
    let pendingRead = false;
    const body = new ReadableStream({
        start(controller) {
            if (signal) {
                signal.addEventListener("abort", () => {
                    // N'erreure QUE si une lecture est réellement en attente (cas
                    // « silence ») — sinon l'abort de fin de flux n'a aucun effet
                    // observable (et ne doit pas produire d'erreur orpheline).
                    if (finished || cancelled || !pendingRead) return;
                    try { controller.error(Object.assign(new Error("Aborted"), { name: "AbortError" })); } catch (e) { /* ignore */ }
                }, { once: true });
            }
            (async () => {
                for (const ch of chunks) {
                    if (cancelled) return;
                    if (ch.wait) await new Promise((r) => setTimeout(r, ch.wait));
                    if (cancelled) return;
                    pendingRead = false;
                    try { controller.enqueue(enc.encode(ch.text)); streamEnqueued++; } catch (e) { return; }
                }
                // hold=true : la connexion RESTE OUVERTE sans rien envoyer (silence).
                if (!cancelled && !hold) { finished = true; try { controller.close(); } catch (e) { /* ignore */ } }
            })();
        },
        pull() { pendingRead = true; },
        cancel() { cancelled = true; streamCancelCount++; },
    });
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

const chat = document.createElement("div");
chat.id = "blobby-chat-msgs";
document.body.appendChild(chat);

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
// Borne un await : une mutation qui supprime le watchdog ferait sinon bloquer
// le test indéfiniment (échec rapide = détection nette par le harnais).
const withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`test timeout (${label})`)), ms)),
]);
const msgs = (role) => [...chat.querySelectorAll(".blobby-msg")].filter((el) => el.dataset.role === role);
const sysText = () => msgs("system").map((e) => e.textContent).join(" | ");
function reset() {
    chat.innerHTML = "";
    httpCalls.length = 0;
    streamPlans.length = 0;
    streamCancelCount = 0;
    streamEnqueued = 0;
    Blobby.setMode("read"); // chemin texte : un seul tour LLM, sans outils
}

const doneEvent = (output) => ndjson({ status: "done", output, usage: {}, max_context: 8192, context_source: "manual" });

/* ══════════ (a) LENT mais ACTIF : durée totale >> seuil → ABOUTIT ══════ */
console.log("(a) Réponse lente mais ACTIVE : aboutit malgré une durée totale > seuil");
reset();
domWindow.AIH_BLOBBY_IDLE_TIMEOUT_MS = 200; // seuil d'INACTIVITÉ : 200 ms
// 12 morceaux toutes les 60 ms → durée totale ~720 ms ≫ 200 ms, mais chaque
// intervalle est < 200 ms : un watchdog d'INACTIVITÉ doit tenir, un plafond de
// durée TOTALE couperait ~au 3ᵉ morceau.
{
    const chunks = [{ text: ndjson({ status: "start", idle_timeout: 120 }) }];
    for (let i = 0; i < 12; i++) chunks.push({ text: ndjson({ status: "keepalive" }), wait: 60 });
    chunks.push({ text: doneEvent("Tâche longue terminée !") });
    streamPlans.push({ chunks });
}
const t0 = Date.now();
await withTimeout(Blobby._handleChatMessage(chat, "fais une tâche longue"), 8000, "a");
const elapsed = Date.now() - t0;
assert.ok(elapsed > 600, `la réponse a bien duré > seuil (${elapsed} ms)`);
assert.ok(msgs("blobby").some((e) => e.textContent.includes("Tâche longue terminée")), "réponse finale affichée");
assert.ok(!sysText().includes("ne renvoie plus rien"), "AUCUN message d'inactivité (flux actif)");
assert.ok(!chat.textContent.includes("Erreur réseau"), "pas d'erreur réseau");
ok(`(a) ${elapsed} ms de durée totale, flux réarmé à chaque morceau → réponse rendue`);

/* ══════════ (c) RÉARMEMENT : longue activité régulière ════════════════ */
console.log("(c) Réarmement : activité régulière pendant longtemps → jamais coupé");
reset();
domWindow.AIH_BLOBBY_IDLE_TIMEOUT_MS = 150;
{
    const chunks = [{ text: ndjson({ status: "start" }) }];
    for (let i = 0; i < 16; i++) chunks.push({ text: ndjson({ status: "delta", text: "x" }), wait: 40 });
    chunks.push({ text: doneEvent("OK") });
    streamPlans.push({ chunks });
}
{
    const t = Date.now();
    await withTimeout(Blobby._handleChatMessage(chat, "activité régulière"), 8000, "c");
    assert.ok(Date.now() - t > 600, "durée totale ≫ seuil (plusieurs réarmements)");
    assert.ok(msgs("blobby").some((e) => e.textContent.includes("OK")), "abouti");
    assert.ok(!sysText().includes("ne renvoie plus rien"), "aucune coupure malgré la durée");
}
ok("(c) 16 morceaux sur ~640 ms (seuil 150 ms) : watchdog réarmé, aucune coupure");

/* ══════════ (b) SILENCIEUX : coupé + message explicite ════════════════ */
console.log("(b) Flux SILENCIEUX : coupé avec message explicite (pas une erreur réseau)");
reset();
domWindow.AIH_BLOBBY_IDLE_TIMEOUT_MS = 1200;
streamPlans.push({ hold: true, chunks: [
    { text: ndjson({ status: "start" }) },
    { text: ndjson({ status: "keepalive" }) },
    // ... puis PLUS RIEN : la connexion reste ouverte (silence).
] });
{
    const t = Date.now();
    await withTimeout(Blobby._handleChatMessage(chat, "réponds"), 6000, "b");
    const el = Date.now() - t;
    assert.ok(el >= 1100, `coupé au bout d'un vrai silence (${el} ms)`);
    assert.ok(chat.textContent.includes("ne renvoie plus rien"), `message d'inactivité explicite : ${chat.textContent}`);
    assert.ok(/depuis\s+1\s*s/.test(chat.textContent), "le message mentionne le délai (1 s) — distinct d'une erreur réseau");
    assert.ok(!chat.textContent.includes("Erreur réseau"), "ce n'est PAS présenté comme une erreur réseau");
}
ok("(b) silence > seuil → coupure + message « le modèle ne renvoie plus rien depuis … s »");

/* ══════════ (d) Annulation PROPRE : aucun timer/tâche résiduel ════════ */
console.log("(d) Annulation propre : signal aborté, reader relâché, aucun résidu");
reset();
domWindow.AIH_BLOBBY_IDLE_TIMEOUT_MS = 500;
streamPlans.push({ chunks: [
    { text: ndjson({ status: "start" }) },
    { text: ndjson({ status: "delta", text: "salut" }), wait: 30 },
    { text: doneEvent("salut !") },
] });
await withTimeout(Blobby._handleChatMessage(chat, "bonjour"), 8000, "d");
const streamCall = httpCalls.find((c) => c.url.includes("/api/keywords/llm-process/stream"));
assert.ok(streamCall, "appel streaming effectué");
assert.ok(streamCall.signal && streamCall.signal.aborted === true, "AbortController abrogé en fin de flux (aucun flux fantôme)");
// Un tour terminé proprement ne doit PAS laisser de rejet non capturé.
process.once("unhandledRejection", () => { throw new Error("unhandledRejection : annulation sale"); });
await tick(50);
ok("(d) signal aborté + reader relâché + aucun rejet non capturé");

/* ══════════ (e) Invariants STATIQUES (anti-durée-totale / streaming) ══ */
console.log("(e) Invariants statiques : pas de plafond total, streaming, réarmement");
{
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, "blobby_companion.js"), "utf8");
    assert.ok(src.includes("'/api/keywords/llm-process/stream'"), "le chat passe par la route STREAMING");
    assert.ok(!/remotePost\(baseUrl \+ '\/api\/keywords\/llm-process'/.test(src), "plus d'appel JSON non streamé (baseUrl)");
    assert.ok(!/remotePost\(p\.baseUrl \+ '\/api\/keywords\/llm-process'/.test(src), "plus d'appel JSON non streamé (p.baseUrl)");
    // Le helper passe timeout: 0 → AUCUN plafond de durée totale côté brique.
    // (Ancre de LIGNE : une mutation `timeout: 1000,` doit être détectée, sans
    //  être masquée par le `timeout: 0` présent dans un commentaire.)
    assert.ok(/^\s*timeout:\s*0,\s*$/m.test(src), "le helper passe timeout: 0 (aucune durée totale)");
    // Le watchdog est RÉARMÉ : arm()/disarm() encadrent chaque lecture du reader.
    assert.ok(/while \(true\)[\s\S]*?arm\(\);[\s\S]*?reader\.read\(\)[\s\S]*?disarm\(\);/.test(src),
        "arm() → reader.read() → disarm() : le watchdog est réarmé à chaque morceau");
    assert.ok(/setTimeout\([\s\S]*?idleMs/.test(src), "le watchdog utilise idleMs (inactivité)");
    // La constante est documentée et lisible par l'extérieur (réglage/tests).
    assert.ok(/AIH_BLOBBY_IDLE_TIMEOUT_MS/.test(src), "seuil réglable via window.AIH_BLOBBY_IDLE_TIMEOUT_MS");
    assert.ok(/BL_CHAT_IDLE_TIMEOUT_MS\s*=\s*45000/.test(src), "valeur par défaut documentée : 45 s");
}
ok("(e) pas de plafond total (timeout: 0), route streaming, watchdog réarmé par morceau");

/* ══════════ (f) i18n : clé d'inactivité présente FR + EN ══════════════ */
{
    const here = path.dirname(fileURLToPath(import.meta.url));
    const stringsSrc = fs.readFileSync(path.join(here, "aih_strings.js"), "utf8");
    const defs = (stringsSrc.match(/"bl\.llmIdle"\s*:/g) || []).length;
    assert.strictEqual(defs, 2, "bl.llmIdle définie exactement 2x (FR + EN)");
}
ok("(f) clé i18n bl.llmIdle présente en FR et EN");

console.log(`\n✅ Chat Blobby — streaming + timeout d'INACTIVITÉ : ${n} groupes d'assertions PASSENT`);
