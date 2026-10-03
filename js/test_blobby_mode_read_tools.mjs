// ─────────────────────────────────────────────────────────────────────────
// Blobby — la boucle d'outils tourne AUSSI en mode « Lecture seule ».
//
// Correctif : `_runToolModeChat` était gaté par getMode()==='active' → en
// Lecture seule, AUCUN outil n'était utilisable (même les outils de lecture),
// ce qui contredisait le nom du mode. Désormais la boucle d'outils tourne dans
// les DEUX modes, avec la liste filtrée par getToolsForMode(mode) :
//   - Lecture seule : UNIQUEMENT les outils 'read' (inspecter : lister, lire un
//     widget, recadrer la vue, lister/ouvrir les subgraphs…) ; toute MUTATION
//     est refusée par la 2ᵉ barrière (dispatcher mode_forbidden) avec un message
//     VISIBLE dans le chat (jamais silencieux) et sans casser le tour ;
//   - Actif : comportement inchangé (tous les outils autorisés).
//
// Couverture :
//   (A) Lecture seule : la boucle d'outils démarre (contrat messages+tools) et
//       la liste envoyée au LLM ne contient QUE des outils 'read' (exhaustif) ;
//   (B) Lecture seule : un outil de lecture s'exécute (list_nodes) → ligne
//       d'action + résultat role:'tool' renvoyé + réponse finale ;
//   (C) Lecture seule : un appel MUTANT est refusé (sans muter) + message
//       système VISIBLE + le tour N'EST PAS cassé (réponse finale affichée) ;
//   (D) Lecture seule : ⏹ Stop interrompt la boucle + l'indicateur apparaît
//       puis disparaît (identique aux deux modes) ;
//   (E) Mode Actif : NON-RÉGRESSION (tous les outils autorisés, boucle OK) ;
//   (F) Invariants statiques + i18n FR/EN strict.
//
// Contrôles négatifs PAR MUTATION : /projects/.aih_tmp/blobby_read_tools/mutate.sh
//   (M1 réintroduire le gating `getMode()==='active'` → rouge ;
//    M2 laisser fuiter un outil mutant dans la liste read → rouge ;
//    M3 rendre le refus mode_forbidden silencieux → rouge).
//
// Usage : node js/test_blobby_mode_read_tools.mjs
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const JSDOM = await loadJsdomOrSkip("test_blobby_mode_read_tools");
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

// ── Instrumentation des timers (détecte un watchdog orphelin après abandon) ──
const _origSetTimeout = globalThis.setTimeout;
const _origClearTimeout = globalThis.clearTimeout;
const pendingTimers = new Map();
globalThis.setTimeout = function (fn, ms) {
    const args = Array.prototype.slice.call(arguments, 2);
    const id = _origSetTimeout(function () { pendingTimers.delete(id); return fn.apply(this, arguments); }, ms, ...args);
    pendingTimers.set(id, ms);
    return id;
};
globalThis.clearTimeout = function (id) { pendingTimers.delete(id); return _origClearTimeout(id); };
const pendingWithDelay = (ms) => [...pendingTimers.values()].filter((d) => d === ms).length;

// ── Fake fetch : JSON (défaut) ou flux NDJSON piloté (abandon) ──────────────
const httpCalls = [];   // { url, method, body, signal }
const streamPlans = []; // { json:{...} } | { ndjson:[chunks], hold? }
let streamCancelCount = 0;

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

function streamResponse(chunks, signal, hold) {
    const enc = new TextEncoder();
    let cancelled = false;
    let finished = false;
    let pendingRead = false;
    const body = new ReadableStream({
        start(controller) {
            if (signal) {
                signal.addEventListener("abort", () => {
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
    const wrappedBody = {
        getReader() {
            const r = body.getReader();
            const origCancel = r.cancel.bind(r);
            r.cancel = function () { streamCancelCount++; return origCancel(); };
            return r;
        },
    };
    return {
        ok: true,
        status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/x-ndjson" : null) },
        body: wrappedBody,
        json: async () => ({}),
        text: async () => "",
    };
}

globalThis.fetch = async (url, init) => {
    const u = String(url);
    let body = null;
    try { body = init && typeof init.body === "string" ? JSON.parse(init.body) : null; } catch { body = init?.body ?? null; }
    httpCalls.push({ url: u, method: (init && init.method) || "GET", body, signal: init && init.signal });

    if (u.includes("/api/keywords/llm-process")) {
        if (body && typeof body.instruction === "string" && body.instruction.includes("Personnalite actuelle")) {
            return jsonResponse({ output: "Blobby perso" });
        }
        const plan = streamPlans.shift();
        if (plan) {
            if (plan.ndjson) {
                const chunks = plan.ndjson.map((c) => (typeof c === "string" ? { text: c } : c));
                return streamResponse(chunks, init && init.signal, plan.hold === true);
            }
            return jsonResponse(plan.json);
        }
        return jsonResponse({ output: "…" });
    }
    if (u.includes("/api/blobby/memory")) return jsonResponse({ results: [] });
    if (u.includes("/api/presets")) return jsonResponse([]);
    if (u.includes("/api/settings")) return jsonResponse({});
    return jsonResponse({});
};

// ── Faux app ComfyUI (graphe minimal pour les outils de lecture) ────────────
function freshApp() {
    const nodes = [
        { id: 1, type: "CheckpointLoader", title: "Checkpoint", pos: [10, 20], mode: 0, widgets: [{ name: "ckpt_name", type: "combo", value: "model.safetensors", callback() {} }] },
        { id: 2, type: "KSampler", title: "Sampler", pos: [200, 40], mode: 0, widgets: [{ name: "steps", type: "number", value: 20, callback() {} }] },
    ];
    const graph = {
        nodes,
        links: {},
        setDirtyCanvas() {},
        getNodeById(id) { return nodes.find((x) => String(x.id) === String(id)) || null; },
        serialize() { return { version: 1, nodes: nodes.map((nd) => ({ id: nd.id, type: nd.type, title: nd.title, widgets: nd.widgets })) }; },
    };
    const app = { graph, canvas: { setDirtyCanvas() {}, centerOnNode() {}, selectItems() {}, deselectAll() {} } };
    app.registerExtension = function (ext) { app.extensions.push(ext); };
    app.extensions = [];
    return app;
}
globalThis.window.app = freshApp();

await import("./aih_i18n.js");
const I18n = domWindow.AIH.I18n;
const captured = {};
const origAddDict = I18n.addDict.bind(I18n);
I18n.addDict = (lang, entries) => { captured[lang] = Object.assign(captured[lang] || {}, entries); return origAddDict(lang, entries); };
I18n.setLocale("fr");
await import("./blobby_companion.js");

const Blobby = domWindow.Blobby;
const BlobbyTools = domWindow.BlobbyTools;
assert.ok(Blobby && typeof Blobby._handleChatMessage === "function", "Blobby exposé (window.Blobby)");
assert.ok(BlobbyTools && typeof BlobbyTools.getToolsForMode === "function", "BlobbyTools exposé");

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
const llmPosts = () => httpCalls.filter((c) => c.url.includes("/api/keywords/llm-process"))
    .filter((c) => !(c.body && typeof c.body.instruction === "string" && c.body.instruction.includes("Personnalite actuelle")));
const toolNamesOf = (post) => (post.body.tools || []).map((tl) => tl.function.name).filter(Boolean);
const lastMsgContent = (post) => post.body.messages[post.body.messages.length - 1].content;

function reset() {
    chat.innerHTML = "";
    document.querySelectorAll(".blobby-chat-activity").forEach((e) => e.remove());
    httpCalls.length = 0;
    streamPlans.length = 0;
    streamCancelCount = 0;
    BlobbyTools.clearUndo();
    Blobby.setShellAccess(false);
    globalThis.window.app = freshApp();
}

// Jeux d'outils attendus (source unique : le registre lui-même).
const ALL = BlobbyTools.listTools();
const READ_TOOLS = ALL.filter((tl) => BlobbyTools.MODE_RANK[tl.mode] <= BlobbyTools.MODE_RANK.read && tl.requiresShell !== true).map((tl) => tl.name).sort();
const ACTIVE_TOOLS = ALL.filter((tl) => BlobbyTools.MODE_RANK[tl.mode] === BlobbyTools.MODE_RANK.active).map((tl) => tl.name).sort();
assert.ok(READ_TOOLS.length >= 17, `registre : ${READ_TOOLS.length} outils read`);
assert.ok(ACTIVE_TOOLS.length >= 18, `registre : ${ACTIVE_TOOLS.length} outils active`);

/* ══════════ (A) Lecture seule : boucle d'outils + liste read UNIQUEMENT ══ */
console.log("(A) Lecture seule : la boucle d'outils démarre, liste = outils read uniquement");
reset();
Blobby.setMode("read");
streamPlans.push({ json: { output: "Je regarde, sans modifier." } });
{
    const p = withTimeout(Blobby._handleChatMessage(chat, "que contient le workflow ?"), 8000, "A");
    await p;
    await tick();
    const posts = llmPosts();
    assert.strictEqual(posts.length, 1, "read : un tour LLM (contrat boucle d'outils)");
    assert.ok(Array.isArray(posts[0].body.messages), "read : contrat `messages` (boucle d'outils, plus le chemin texte seul)");
    assert.ok(Array.isArray(posts[0].body.tools) && posts[0].body.tools.length > 0, "read : `tools` NON vide (outils de lecture proposés)");
    assert.strictEqual(posts[0].body.tool_choice, "auto", "read : tool_choice cohérent");
    const sent = toolNamesOf(posts[0]).sort();
    assert.deepStrictEqual(sent, READ_TOOLS, "read : liste EXHAUSTIVE = outils 'read' du registre (ni plus ni moins)");
    for (const name of sent) {
        const tool = ALL.find((tl) => tl.name === name);
        assert.strictEqual(tool.mode, "read", `read : « ${name} » est bien un outil de lecture`);
    }
    // Aucun outil MUTANT ne fuit dans la liste envoyée au LLM.
    for (const mutName of ["set_widget_value", "remove_node", "add_node", "queue_prompt", "interrupt", "run_shell", "create_group", "convert_to_subgraph", "unpack_subgraph"]) {
        assert.ok(!sent.includes(mutName), `read : l'outil mutant « ${mutName} » N'EST PAS envoyé au LLM`);
    }
    // Les outils de lecture classés 'read' exprès sont bien disponibles.
    for (const must of ["focus_view", "select_node", "list_nodes", "list_subgraphs", "open_subgraph", "get_object_info"]) {
        assert.ok(sent.includes(must), `read : outil de lecture disponible : ${must}`);
    }
    assert.ok(msgs("blobby").some((e) => e.textContent.includes("sans modifier")), "réponse finale affichée");
}
ok(`(A) read : boucle d'outils + liste exhaustive de ${READ_TOOLS.length} outils read, 0 mutant`);

/* ══════════ (B) Lecture seule : un outil de lecture S'EXÉCUTE ══════════ */
console.log("(B) Lecture seule : list_nodes s'exécute (action + résultat renvoyé)");
reset();
Blobby.setMode("read");
streamPlans.push({ json: {
    tool_calls: [{ id: "r1", type: "function", function: { name: "list_nodes", arguments: "{}" } }],
    output: "",
} });
streamPlans.push({ json: { output: "Deux nœuds : CheckpointLoader et KSampler." } });
{
    const p = withTimeout(Blobby._handleChatMessage(chat, "liste les nœuds"), 8000, "B");
    await p;
    await tick();
    const posts = llmPosts();
    assert.strictEqual(posts.length, 2, "read : deux tours (outil puis réponse)");
    // Ligne d'action pour l'outil exécuté.
    assert.ok(msgs("action").some((e) => e.textContent.includes("list_nodes")), "read : ligne d'action « list_nodes » affichée");
    // Le 2ᵉ tour renvoie le RÉSULTAT de l'outil en role:'tool'.
    const toolMsgs = posts[1].body.messages.filter((m) => m.role === "tool");
    assert.strictEqual(toolMsgs.length, 1, "read : un message role:'tool' renvoyé au LLM");
    assert.ok(/CheckpointLoader|KSampler/.test(toolMsgs[0].content), "read : le résultat contient bien les nœuds du graphe");
    assert.ok(msgs("blobby").some((e) => e.textContent.includes("Deux nœuds")), "read : réponse finale affichée");
}
ok("(B) read : list_nodes exécuté, résultat role:'tool' renvoyé, réponse finale OK");

/* ══════════ (C) Lecture seule : MUTANT refusé + message VISIBLE ════════ */
console.log("(C) Lecture seule : outil mutant refusé (message visible), tour non cassé");
reset();
Blobby.setMode("read");
const before = globalThis.window.app.graph.nodes[1].widgets[0].value;
streamPlans.push({ json: {
    tool_calls: [{ id: "m1", type: "function", function: { name: "set_widget_value", arguments: '{"id":2,"widget":"steps","value":99}' } }],
    output: "",
} });
streamPlans.push({ json: { output: "Je ne peux pas modifier en Lecture seule." } });
{
    const p = withTimeout(Blobby._handleChatMessage(chat, "mets steps à 99"), 8000, "C");
    await p;
    await tick();
    // Aucune mutation réelle.
    assert.strictEqual(globalThis.window.app.graph.nodes[1].widgets[0].value, before, "read : le widget est INTACT (aucune mutation)");
    assert.strictEqual(BlobbyTools.canUndo(), false, "read : aucun snapshot (aucune mutation tentée n'a abouti)");
    // Refus VISIBLE dans le chat (jamais silencieux).
    const sys = sysText();
    assert.ok(/set_widget_value/.test(sys), `refus nommant l'outil visible : ${sys}`);
    assert.ok(/refus/i.test(sys) && /Lecture seule/.test(sys), "refus compréhensible (mode Lecture seule) affiché");
    // Le refus repart au LLM comme résultat d'outil → le tour CONTINUE.
    const posts = llmPosts();
    assert.strictEqual(posts.length, 2, "read : tour non cassé (2 tours)");
    const toolMsgs = posts[1].body.messages.filter((m) => m.role === "tool");
    assert.strictEqual(toolMsgs.length, 1, "read : refus renvoyé au LLM (role:'tool')");
    assert.ok(/mode_forbidden|interdit/.test(toolMsgs[0].content), "read : le refus structuré (mode_forbidden) est réinjecté");
    assert.ok(msgs("blobby").some((e) => e.textContent.includes("Je ne peux pas modifier")), "read : réponse finale affichée (tour non cassé)");
}
ok("(C) read : mutant refusé, widget intact, refus visible + réinjecté, tour poursuivi");

/* ══════════ (D) Lecture seule : ⏹ Stop + indicateur ═════════════════════ */
console.log("(D) Lecture seule : indicateur visible puis nettoyé + ⏹ Stop interrompt");
reset();
Blobby.setMode("read");
domWindow.AIH_BLOBBY_IDLE_TIMEOUT_MS = 9999;
streamPlans.push({ hold: true, ndjson: [
    ndjson({ status: "start" }),
    ndjson({ status: "delta", text: "je réfléchis" }),
] });
{
    const p = withTimeout(Blobby._handleChatMessage(chat, "inspecte longuement"), 8000, "D");
    await tick(50);
    assert.ok(activityEl(), "read : l'indicateur d'activité est créé");
    assert.ok(actVisible(), "read : l'indicateur est VISIBLE pendant le tour");
    assert.ok(Blobby._turnActive(), "read : _turnActive() vrai (bouton ⏹ armé)");
    assert.strictEqual(Blobby._abortTurn(), true, "read : ⏹ Stop pris en compte");
    await p;
    assert.ok(!actVisible(), "read : indicateur MASQUÉ après abandon (aucun fantôme)");
    assert.ok(!Blobby._turnActive(), "read : _turnActive() faux après abandon");
    assert.ok(sysText().includes("Interrompu"), `read : état « interrompu » affiché : ${sysText()}`);
    const streamCall = httpCalls.find((c) => c.url.includes("/llm-process/stream"));
    assert.ok(streamCall && streamCall.signal && streamCall.signal.aborted === true, "read : le flux a bien été annulé (AbortController)");
    await tick(30);
    assert.strictEqual(pendingWithDelay(9999), 0, "read : aucun watchdog d'inactivité orphelin");
}
ok("(D) read : indicateur apparaît/disparaît + ⏹ Stop interrompt (identique mode Actif)");

/* ══════════ (E) Mode Actif : NON-RÉGRESSION ════════════════════════════ */
console.log("(E) Mode Actif : tous les outils autorisés + boucle d'outils OK");
reset();
Blobby.setMode("active");
streamPlans.push({ json: {
    tool_calls: [{ id: "a1", type: "function", function: { name: "list_nodes", arguments: "{}" } }],
    output: "",
} });
streamPlans.push({ json: { output: "C'est listé." } });
{
    const p = withTimeout(Blobby._handleChatMessage(chat, "liste les nœuds"), 8000, "E");
    await p;
    await tick();
    const posts = llmPosts();
    assert.strictEqual(posts.length, 2, "active : deux tours (outil puis réponse)");
    const sent = toolNamesOf(posts[0]).sort();
    const expectedActive = ALL.filter((tl) => BlobbyTools.MODE_RANK[tl.mode] <= BlobbyTools.MODE_RANK.active && tl.requiresShell !== true).map((tl) => tl.name).sort();
    assert.deepStrictEqual(sent, expectedActive, "active : tous les outils autorisés (shell off) envoyés — non-régression");
    assert.ok(sent.includes("set_widget_value") && sent.includes("remove_node"), "active : les outils mutants restent disponibles");
    assert.ok(msgs("action").some((e) => e.textContent.includes("list_nodes")), "active : la boucle d'outils s'exécute comme avant");
    assert.ok(msgs("blobby").some((e) => e.textContent.includes("C'est listé")), "active : réponse finale affichée");
}
// Le paramètre shell en Actif reste orthogonal : activé → run_shell ajouté.
reset();
Blobby.setMode("active");
Blobby.setShellAccess(true);
streamPlans.push({ json: { output: "ok" } });
{
    await withTimeout(Blobby._handleChatMessage(chat, "coucou"), 8000, "E-shell");
    await tick();
    const sent = toolNamesOf(llmPosts()[0]);
    assert.ok(sent.includes("run_shell"), "active + shell ON : run_shell proposé (non-régression shell)");
}
// En Lecture seule, même case cochée, run_shell ne fuite JAMAIS dans la liste.
reset();
Blobby.setMode("read");
Blobby.setShellAccess(true);
streamPlans.push({ json: { output: "ok" } });
{
    await withTimeout(Blobby._handleChatMessage(chat, "coucou"), 8000, "E-shell-read");
    await tick();
    const sent = toolNamesOf(llmPosts()[0]);
    assert.ok(!sent.includes("run_shell"), "read + shell ON : run_shell JAMAIS proposé (shell doublement barré)");
    assert.deepStrictEqual(sent.sort(), READ_TOOLS, "read + shell ON : liste toujours = outils read uniquement");
}
ok("(E) active : non-régression (tous outils + boucle) ; read : run_shell jamais proposé");

/* ══════════ (F) Invariants statiques + i18n FR/EN strict ═══════════════ */
console.log("(F) Invariants statiques + i18n FR/EN");
{
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, "blobby_companion.js"), "utf8");
    const stringsSrc = fs.readFileSync(path.join(here, "aih_strings.js"), "utf8");
    // La liste d'outils est construite par getToolsForMode(this.getMode()) —
    // le gating « active » du chemin d'outils a disparu.
    assert.ok(/getToolsForMode\(this\.getMode\(\)/.test(src), "getToolsForMode appelé avec le mode COURANT (les deux modes)");
    assert.ok(!/if\s*\(this\.getMode\(\)\s*===\s*['"]active['"]\)\s*\{[^}]*toolSchemas/.test(src), "plus de gating `active` autour de la construction des schémas");
    // Le refus mode_forbidden est rendu VISIBLE (jamais silencieux).
    assert.ok(/code\s*===\s*['"]mode_forbidden['"]/.test(src), "le refus mode_forbidden est traité côté UI (message visible)");
    // i18n strict : chaque nouvelle clé définie exactement 2x (FR+EN), non vide.
    for (const key of ["bl.toolsIntro.read", "bl.toolsIntro.active", "bl.toolsHow.read", "bl.toolsHow.active", "bl.toolErr.forbiddenChat"]) {
        const re = new RegExp('"' + key.replace(/\./g, "\\.") + '"\\s*:', "g");
        assert.strictEqual((stringsSrc.match(re) || []).length, 2, `${key} définie exactement 2x (FR + EN)`);
    }
    const frKeys = Object.keys(captured.fr || {}).filter((k) => k.startsWith("bl."));
    const missingEn = frKeys.filter((k) => !(k in (captured.en || {})));
    const emptyEn = frKeys.filter((k) => String((captured.en || {})[k] ?? "").trim() === "");
    assert.deepStrictEqual(missingEn, [], `clés bl.* sans traduction EN : ${missingEn.join(", ")}`);
    assert.deepStrictEqual(emptyEn, [], `clés bl.* vides en EN : ${emptyEn.join(", ")}`);
    // L'instruction système read mentionne l'inspection ET le refus de mutation.
    const readPromptFr = captured.fr["bl.mode.readPrompt"];
    assert.ok(/INSPECTER/.test(readPromptFr) && /ne peux PAS modifier/.test(readPromptFr), "readPrompt : inspecter OUI / modifier NON");
    const howReadFr = captured.fr["bl.toolsHow.read"];
    assert.ok(/REFUSÉ/.test(howReadFr), "toolsHow.read : la mutation est annoncée comme refusée");
    assert.ok(/INSPECT/.test(captured.en["bl.mode.readPrompt"]), "readPrompt EN : mentionne l'inspection");
}
ok("(F) invariants statiques + parité i18n FR/EN strictes");

globalThis.setTimeout = _origSetTimeout;
globalThis.clearTimeout = _origClearTimeout;

console.log(`\n✅ Blobby — boucle d'outils en Lecture seule (outils read uniquement) : ${n} groupes d'assertions PASSENT`);
