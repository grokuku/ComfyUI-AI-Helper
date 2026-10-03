// ─────────────────────────────────────────────────────────────────────────
// Chat Blobby — REPLI ROBUSTE de la route de streaming vers la route JSON.
//
// Bug bloquant réel : TOUTE conversation échouait avec « HTTP 405 ».
// Cause : la route de streaming `POST /api/keywords/llm-process/stream` est
// ABSENTE du backend EN COURS (process pas redémarré après la mise à jour) ;
// le catch-all SPA `@app.route('/<path:path>')` (GET/HEAD/OPTIONS seulement,
// backend/app.py) intercepte alors le POST et répond 405. Le front n'avait
// AUCUN repli sur 405 → `_blobbyParseJsonReply` fabriquait « HTTP 405 » et
// l'affichait tel quel à l'utilisateur.
//
// Ce fichier verrouille la correction :
//   (a) route de streaming NORMALE → le chat répond via le flux NDJSON
//       (et l'appel est bien un POST) ;
//   (b) repli : stream 405 → le chat répond via la route JSON (silencieusement) ;
//   (c) repli : stream 404 → idem ;
//   (d) repli : stream 501 et 502 → idem ;
//   (e) contrôle : si LES DEUX routes échouent, AUCUN « HTTP 405 » brut
//       n'apparaît — seule une message clair et lisible est affiché ;
//   (f) invariants STATIQUES : jeu de statuts de repli complet, branche de
//       repli présente, plus de concaténation brute « HTTP » + code.
//
// Contrôles négatifs PAR MUTATION : voir /projects/.aih_tmp/blobby405/mutate.py
// (forcer GET → rouge ; désactiver le repli → rouge).
//
// Usage : node js/test_blobby_llm_fallback.mjs
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const JSDOM = await loadJsdomOrSkip("test_blobby_llm_fallback");
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

// ── Fake fetch pilotable par scénario ────────────────────────────────────
const httpCalls = [];      // { url, method, body }
let streamMode = "stream"; // "stream" | {status:N} (erreur brute côté route /stream)
let jsonMode = "ok";       // "ok" | {status:N} (erreur brute côté route JSON)

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

// Réponse d'erreur « brute » : page HTML générique (catch-all SPA / proxy),
// exactement ce que renvoie Flask pour un POST intercepté par une route GET-only.
function htmlErrorResponse(status, body) {
    return {
        ok: false,
        status,
        headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
        json: async () => { throw new Error("not json"); },
        text: async () => (body || `<!doctype html><title>${status}</title>`),
    };
}

// Flux NDJSON nominal abouti (done immédiat).
function ndjsonStreamResponse(output) {
    const body = `\n${ndjson({ status: "done", output, usage: {}, max_context: 8192, context_source: "manual" })}`;
    const bytes = new TextEncoder().encode(body);
    let sent = false;
    return {
        ok: true,
        status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/x-ndjson" : null) },
        body: new ReadableStream({
            pull(controller) {
                if (sent) { controller.close(); return; }
                sent = true;
                controller.enqueue(bytes);
            },
        }),
        json: async () => ({}),
        text: async () => body,
    };
}

globalThis.fetch = async (url, init) => {
    const u = String(url);
    let body = null;
    try { body = init && typeof init.body === "string" ? JSON.parse(init.body) : null; } catch { body = init?.body ?? null; }
    httpCalls.push({ url: u, method: (init && init.method) || "GET", body });

    if (u.endsWith("/api/keywords/llm-process/stream")) {
        if (streamMode === "stream") return ndjsonStreamResponse("reponse-stream");
        return htmlErrorResponse(streamMode.status);
    }
    if (u.endsWith("/api/keywords/llm-process")) {
        if (jsonMode === "ok") return jsonResponse({ output: "repli-json", max_context: 8192, context_source: "manual" });
        return htmlErrorResponse(jsonMode.status);
    }
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

const withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`test timeout (${label})`)), ms)),
]);
const msgs = (role) => [...chat.querySelectorAll(".blobby-msg")].filter((el) => el.dataset.role === role);
const sysText = () => msgs("system").map((e) => e.textContent).join(" | ");
const streamCalls = () => httpCalls.filter((c) => c.url.endsWith("/api/keywords/llm-process/stream"));
const jsonCalls = () => httpCalls.filter((c) => c.url.endsWith("/api/keywords/llm-process"));
function reset(stream, json) {
    chat.innerHTML = "";
    httpCalls.length = 0;
    streamMode = stream === undefined ? "stream" : stream;
    jsonMode = json === undefined ? "ok" : json;
    Blobby.setMode("read"); // chemin texte : un seul tour LLM, sans outils
}

/* ══════════ (a) route de streaming NORMALE → réponse via le flux ═══════ */
console.log("(a) Route de streaming normale : le chat répond via le flux NDJSON");
reset("stream", "ok");
await withTimeout(Blobby._handleChatMessage(chat, "bonjour"), 8000, "a");
assert.ok(msgs("blobby").some((e) => e.textContent.includes("reponse-stream")), "réponse issue du flux affichée");
assert.ok(streamCalls().length >= 1, "la route de streaming a bien été appelée");
assert.ok(streamCalls().every((c) => c.method === "POST"), "l'appel de streaming est un POST (jamais GET)");
assert.strictEqual(jsonCalls().length, 0, "aucun appel JSON : le flux a suffi");
assert.ok(!chat.textContent.includes("HTTP 405"), "pas d'erreur brute");
ok("(a) flux NDJSON nominal, appel POST, aucune bascule");

/* ══════════ (b) repli : stream 405 → route JSON ════════════════════════ */
console.log("(b) stream 405 (route absente interceptée par le catch-all) → repli JSON silencieux");
reset({ status: 405 }, "ok");
await withTimeout(Blobby._handleChatMessage(chat, "bonjour"), 8000, "b");
assert.ok(msgs("blobby").some((e) => e.textContent.includes("repli-json")), "réponse rendue via la route JSON");
assert.ok(streamCalls().length >= 1, "le streaming a été tenté d'abord");
assert.ok(streamCalls().every((c) => c.method === "POST"), "tentative de streaming en POST");
assert.ok(jsonCalls().length >= 1, "repli : la route JSON a été appelée");
assert.ok(jsonCalls().every((c) => c.method === "POST"), "repli JSON en POST");
assert.ok(!chat.textContent.includes("HTTP 405"), "JAMAIS « HTTP 405 » affiché à l'utilisateur");
assert.ok(!sysText().includes("405"), "aucune erreur système 405");
ok("(b) 405 → bascule silencieuse, chat fonctionnel, aucun 405 affiché");

/* ══════════ (c) repli : stream 404 → route JSON ════════════════════════ */
console.log("(c) stream 404 (route non déployée) → repli JSON silencieux");
reset({ status: 404 }, "ok");
await withTimeout(Blobby._handleChatMessage(chat, "bonjour"), 8000, "c");
assert.ok(msgs("blobby").some((e) => e.textContent.includes("repli-json")), "réponse rendue via la route JSON");
assert.ok(jsonCalls().length >= 1, "repli : route JSON appelée");
assert.ok(!chat.textContent.includes("HTTP 404"), "pas d'erreur brute 404");
ok("(c) 404 → bascule silencieuse, chat fonctionnel");

/* ══════════ (d) repli : stream 501 / 502 → route JSON ══════════════════ */
console.log("(d) stream 501/502 (non supporté / proxy) → repli JSON silencieux");
for (const status of [501, 502]) {
    reset({ status }, "ok");
    await withTimeout(Blobby._handleChatMessage(chat, "bonjour"), 8000, `d${status}`);
    assert.ok(msgs("blobby").some((e) => e.textContent.includes("repli-json")), `${status} → réponse via route JSON`);
    assert.ok(jsonCalls().length >= 1, `${status} → route JSON appelée`);
    assert.ok(!chat.textContent.includes(`HTTP ${status}`), `${status} non affiché à l'utilisateur`);
}
ok("(d) 501 et 502 → bascule silencieuse, chat fonctionnel");

/* ══════════ (e) les DEUX routes échouent : message clair, jamais brut ══ */
console.log("(e) Échec des DEUX routes (stream 405 + JSON 405) : message clair, jamais « HTTP 405 »");
reset({ status: 405 }, { status: 405 });
await withTimeout(Blobby._handleChatMessage(chat, "bonjour"), 8000, "e");
assert.ok(!chat.textContent.includes("HTTP 405"), "aucun « HTTP 405 » brut");
assert.ok(!chat.textContent.includes("réponse non-JSON"), "aucun message technique brut");
assert.ok(/n'a pas pu joindre le service/i.test(chat.textContent), `message clair attendu : ${chat.textContent}`);
assert.ok(msgs("blobby").length >= 1, "l'utilisateur reçoit une réponse explicite (pas un silence)");
ok("(e) double échec → message clair « n'a pas pu joindre le service (statut 405) », jamais brut");

/* ══════════ (f) Invariants STATIQUES ═══════════════════════════════════ */
console.log("(f) Invariants statiques : jeu de statuts complet + branche de repli");
{
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, "blobby_companion.js"), "utf8");
    // Les 4 statuts demandés déclenchent le repli.
    for (const code of [404, 405, 501, 502]) {
        assert.ok(new RegExp(`${code}\\s*:\\s*1`).test(src), `le statut ${code} doit être dans le jeu de repli`);
    }
    assert.ok(/_blobbyStreamUnavailable\(res\.status\)/.test(src), "la réponse non-OK du flux déclenche le repli");
    assert.ok(/_blobbyLlmJson\(baseUrl, _blobbyJsonPathFor\(path\), body\)/.test(src), "le repli POSTe vers le chemin JSON dérivé");
    // Plus AUCUNE concaténation brute « HTTP » + code (l'ancienne cause du message).
    assert.ok(!/['"]HTTP ['"]\s*\+/.test(src), "plus de « 'HTTP ' + code » brut dans le front");
    // La route JSON de repli existe bien (dérivée du chemin de streaming).
    assert.ok(/_blobbyJsonPathFor/.test(src), "dérivation du chemin JSON présente");
    const stringsSrc = fs.readFileSync(path.join(here, "aih_strings.js"), "utf8");
    assert.strictEqual((stringsSrc.match(/"bl\.llmUnavailable"\s*:/g) || []).length, 2, "bl.llmUnavailable définie FR + EN");
}
ok("(f) statuts 404/405/501/502, branche de repli et i18n verrouillés");

console.log(`\n✅ Chat Blobby — repli streaming → JSON : ${n} groupes d'assertions PASSENT`);
