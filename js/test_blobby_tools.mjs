// ─────────────────────────────────────────────────────────────────────────
// ÉTAPE 2 — Outils Blobby : registre + dispatcher/enforcement de mode +
// snapshot/undo + boucle tool_calls + repli 4b + intégration chat.
//
// Couverture :
//   1. (a) FILTRAGE du schéma par mode : les outils 'active' ne sont pas
//      proposés au LLM en mode 'read' (getToolsForMode) ;
//   2. (b) ENFORCEMENT : un tool_call 'active' en mode 'read' → refus
//      structuré SANS exécution (exécuteur jamais appelé, widget intact,
//      aucun snapshot) + contrôle négatif in-suite (même appel en 'active'
//      passe bien : la différence prouve que c'est l'enforcement qui bloque) ;
//   3. (c) UNDO : snapshot COMPLET avant mutation, pile bornée (10),
//      restauration qui rétablit l'état (faux graphe/stub) ;
//   4. (d) chemin tool_calls : provider → dispatch → messages role:'tool'
//      (tool_call_id) renvoyés au tour suivant (stubs dispatch + send) ;
//      arguments JSON invalides → erreur structurée, dispatch NON appelé ;
//   5. (e) repli 4b : détection DÉLIMITÉE (erreur payload tools / réponse
//      inattendue au 1ᵉʳ tour), et PAS de détection sur 401/5xx/texte normal ;
//   6. (f) NON-RÉGRESSION chat : en 'read' le POST ne contient NI tools NI
//      messages, le parsing texte ([SET…]/[MOVE_TO]/[SHELL]) continue de
//      marcher, [SET…] en 'read' est refusé SANS muter le workflow ;
//   7. (g) parité i18n FR/EN des clés bl.* ajoutées.
//
// Usage : node js/test_blobby_tools.mjs
//   La partie 1 est PURE (node, aucun DOM). La partie 2 (chemin chat) utilise
//   jsdom, résolu par le helper partagé js/test_helpers/jsdom_loader.mjs ;
//   introuvable = SKIP bruyant (exit 2).
//
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";
import {
    normalizeMode, getToolsForMode, listTools, dispatchToolCall,
    pushUndoSnapshot, undoSnapshot, undoLast, canUndo, canUndoId, clearUndo, UNDO_LIMIT,
    extractToolCalls, parseToolArguments, renderToolContent, runToolLoop,
    detectToolsUnsupported, toolCallName, toolCallArguments, normalizeToolCallForEcho,
} from "./blobby_tools.js";

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

// ─── Fabriques de faux graphes / nœuds (pur, sans DOM) ──────────────────────

function makeWidget(seed) {
    return {
        name: seed.name, type: seed.type || "text", value: seed.value,
        options: seed.options ? { ...seed.options } : undefined,
        callbackCalls: [],
        callback(v) { this.callbackCalls.push(v); },
    };
}

function makeNode(seed) {
    const nd = {
        id: seed.id, type: seed.type, title: seed.title ?? seed.type,
        pos: seed.pos ? seed.pos.slice() : [0, 0],
        widgets: (seed.widgets || []).map(makeWidget),
        inputs: (seed.inputs || []).map((i) => ({ ...i, link: i.link === undefined ? null : i.link })),
        outputs: (seed.outputs || []).map((o) => ({ ...o, links: (o.links || []).slice() })),
        properties: seed.properties ? { ...seed.properties } : {},
        mode: seed.mode === undefined ? 0 : seed.mode,
    };
    // Formes défensives testées du dispatcher (signature LiteGraph-like).
    nd.connect = function (slot, target, inputIdx) {
        if (!this.outputs[slot] || !target.inputs[inputIdx]) return null;
        const link = { id: 700 + slot, origin_id: this.id, origin_slot: slot, target_id: target.id, target_slot: inputIdx, type: "X" };
        target.inputs[inputIdx].link = link.id;
        this.outputs[slot].links.push(link.id);
        return link;
    };
    nd.disconnectOutput = function (slot, target) {
        const o = this.outputs[slot];
        if (!o || !Array.isArray(o.links) || o.links.length === 0) return false;
        if (target) {
            const kept = o.links.filter((lid) => lid !== 700 + slot); // stub : un seul lien
            const removed = kept.length < o.links.length;
            o.links = kept;
            if (removed && target.inputs[0]) target.inputs[0].link = null;
            return removed;
        }
        o.links = [];
        return true;
    };
    nd.disconnectInput = function (idx) {
        if (!this.inputs[idx]) return false;
        this.inputs[idx].link = null;
        return true;
    };
    return nd;
}

function makeGraph(nodes) {
    const g = {
        nodes: nodes.map(makeNode),
        links: {},
        dirtyCount: 0,
        serialize() {
            return {
                version: 1,
                nodes: this.nodes.map((nd) => ({
                    id: nd.id, type: nd.type, title: nd.title,
                    widgets: nd.widgets.map((w) => ({ name: w.name, type: w.type, value: w.value })),
                })),
            };
        },
        configure(data) { this.lastConfigured = data; },
        setDirtyCanvas() { this.dirtyCount++; },
        getNodeById(id) { return this.nodes.find((nd) => String(nd.id) === String(id)) || null; },
    };
    return g;
}

function makeApp(nodes, opts = {}) {
    const graph = makeGraph(nodes);
    const app = {
        graph,
        canvas: { setDirtyCanvas() {}, centerOnNode() {} },
        loadGraphData(data) {
            // Re-construit les nœuds depuis le snapshot : une VRAIE restauration.
            graph.nodes = (data.nodes || []).map((nd) => makeNode({
                id: nd.id, type: nd.type, title: nd.title,
                widgets: (nd.widgets || []).map((w) => ({ name: w.name, type: w.type, value: w.value })),
            }));
            graph.lastRestored = data;
            return Promise.resolve();
        },
    };
    if (opts.queuePrompt) app.queuePrompt = function (a, b) { app.queuePromptCalls.push([a, b]); return Promise.resolve(); };
    app.queuePromptCalls = [];
    return app;
}

const SEED = [
    { id: 1, type: "CheckpointLoaderSimple", title: "Checkpoint", widgets: [
        { name: "ckpt_name", type: "combo", value: "v1-5.safetensors", options: { values: ["v1-5.safetensors", "sdxl.safetensors"] } },
        { name: "steps", type: "number", value: 20, options: { min: 1, max: 100 } },
    ], outputs: [{ name: "MODEL", type: "MODEL" }] },
    { id: 2, type: "KSampler", title: "KSampler", widgets: [{ name: "steps", type: "number", value: 20 }], inputs: [{ name: "model", type: "MODEL" }] },
];

/* ══════════════════ 1. (a) Filtrage du schéma par mode ═════════════════ */
console.log("1. Filtrage du schéma par mode (getToolsForMode)");

const READ_EXPECTED = ["describe_workflow", "list_nodes", "get_node_by_id", "get_node_widgets", "get_node_widget", "get_node_connections", "get_object_info", "get_queue_status", "get_execution_status"];
const ACTIVE_ONLY = ["set_widget_value", "set_node_title", "set_node_color", "move_node", "add_node", "remove_node", "connect_nodes", "disconnect_nodes", "queue_prompt", "interrupt"];

const readTools = getToolsForMode("read");
const readNames = readTools.map((x) => x.function.name);
assert.deepStrictEqual(readNames.sort(), READ_EXPECTED.slice().sort(), "mode read : uniquement les outils de lecture");
assert.ok(readNames.every((nm) => !ACTIVE_ONLY.includes(nm)), "mode read : AUCUN outil 'active' proposé au LLM");
ok("mode read : 9 outils de lecture, 0 outil actif");

const activeTools = getToolsForMode("active");
const activeNames = activeTools.map((x) => x.function.name);
assert.deepStrictEqual(activeNames.sort(), READ_EXPECTED.concat(ACTIVE_ONLY).sort(), "mode active : tous les outils");
assert.strictEqual(activeTools.length, listTools().length, "getToolsForMode('active') === registre complet");
ok(`mode active : ${activeNames.length} outils (registre complet)`);

// Format function-calling exploitable par le LLM.
for (const tl of activeTools) {
    assert.strictEqual(tl.type, "function", "type function");
    assert.ok(tl.function.name && tl.function.description, "name + description");
    assert.strictEqual(tl.function.parameters.type, "object", "schema type object");
}
const setW = activeTools.find((x) => x.function.name === "set_widget_value").function;
assert.ok(setW.parameters.required.includes("id") && setW.parameters.required.includes("widget") && setW.parameters.required.includes("value"), "set_widget_value: id/widget/value requis");
const objInfo = activeTools.find((x) => x.function.name === "get_object_info").function;
assert.ok(objInfo.parameters.properties.class_type && objInfo.parameters.required.length === 0, "get_object_info: class_type optionnel");
ok("schémas JSON-Schema valides (type/properties/required) pour tous les outils");

// Normalisation défensive du mode.
assert.strictEqual(normalizeMode(undefined), "read", "mode absent → read (défaut sûr)");
assert.strictEqual(normalizeMode("ACTIVE"), "active", "casse tolérée");
assert.strictEqual(normalizeMode("nonsense"), "read", "valeur inconnue → read (fail-safe)");
ok("normalizeMode : absent/inconnu → read (fail-safe)");

/* ══════════════════ 2. (b) Enforcement (refus sans exécution) ══════════ */
console.log("2. Enforcement du mode (2ᵉ barrière après le filtrage)");

clearUndo();
{
    const app = makeApp(SEED);
    const w = app.graph.nodes[0].widgets[1]; // steps
    const res = await dispatchToolCall("set_widget_value", { id: 1, widget: "steps", value: 30 }, { app: app, mode: "read" });
    assert.strictEqual(res.ok, false, "refusé en mode read");
    assert.strictEqual(res.code, "mode_forbidden", "code structuré mode_forbidden");
    assert.ok(res.error.includes("interdit en mode 'read'"), `message explicite : ${res.error}`);
    assert.strictEqual(w.value, 20, "exécuteur NON appelé : widget intact");
    assert.strictEqual(w.callbackCalls.length, 0, "callback widget NON appelé");
    assert.strictEqual(canUndo(), false, "aucun snapshot poussé (refus avant snapshot)");
    ok("set_widget_value en read → refus structuré, exécuteur jamais appelé");
}

// Contrôle négatif IN-SUITE : le MÊME appel en mode 'active' passe — la
// différence prouve que c'est bien l'enforcement qui bloque, pas l'exécuteur.
{
    const app = makeApp(SEED);
    const res = await dispatchToolCall("set_widget_value", { id: 1, widget: "steps", value: 30 }, { app: app, mode: "active" });
    assert.strictEqual(res.ok, true, "le même appel passe en mode active");
    assert.strictEqual(app.graph.nodes[0].widgets[1].value, 30, "widget muté");
    assert.strictEqual(app.graph.nodes[0].widgets[1].callbackCalls.length, 1, "callback appelé (pattern holaf_resolution_preset_v2)");
    assert.strictEqual(canUndo(), true, "snapshot poussé avant mutation");
    ok("contrôle négatif : même appel en active → mutation OK + snapshot (l'enforcement est bien la seule différence)");
}

// Mode absent du ctx → read par défaut (défensif).
{
    const app = makeApp(SEED);
    const res = await dispatchToolCall("set_widget_value", { id: 1, widget: "steps", value: 30 }, { app: app });
    assert.strictEqual(res.ok, false, "mode absent du ctx → read par défaut → refus");
    assert.strictEqual(app.graph.nodes[0].widgets[1].value, 20, "widget intact");
    ok("ctx sans mode → read implicite → refus");
}

// Outil inconnu.
{
    const res = await dispatchToolCall("outil_fantome", {}, { mode: "active" });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, "unknown_tool");
    assert.ok(res.error.includes("outil_fantome"), "message nomme l'outil inconnu");
    ok("outil inconnu → erreur structurée unknown_tool");
}

// Erreurs métier structurées (pas de crash).
clearUndo();
{
    const app = makeApp(SEED);
    let r = await dispatchToolCall("get_node_by_id", { id: 42 }, { app: app, mode: "read" });
    assert.strictEqual(r.code, "not_found", "nœud introuvable → not_found");
    assert.ok(r.error.includes("#42"), "message nomme l'id");
    r = await dispatchToolCall("get_node_widget", { id: 1, widget: "inexistant" }, { app: app, mode: "read" });
    assert.strictEqual(r.code, "widget_not_found", "widget introuvable → widget_not_found");
    r = await dispatchToolCall("set_widget_value", { id: 1, widget: "ckpt_name", value: "pas-dans-la-liste.safetensors" }, { app: app, mode: "active" });
    assert.strictEqual(r.code, "invalid_value", "combo : valeur hors liste → invalid_value");
    assert.strictEqual(app.graph.nodes[0].widgets[0].value, "v1-5.safetensors", "valeur combo intacte");
    assert.strictEqual(canUndo(), false, "erreur métier → snapshot retiré (pile honnête)");
    r = await dispatchToolCall("set_widget_value", { id: 1, widget: "steps", value: "abc" }, { app: app, mode: "active" });
    assert.strictEqual(r.code, "invalid_value", "number : non-numérique → invalid_value");
    ok("nœud/widget introuvable, combo/number invalides → erreurs structurées, zéro crash");
}

// Nombre borné aux min/max du widget.
{
    const app = makeApp(SEED);
    const res = await dispatchToolCall("set_widget_value", { id: 1, widget: "steps", value: 9999 }, { app: app, mode: "active" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(app.graph.nodes[0].widgets[1].value, 100, "borné au max (100)");
    ok("number borné aux options min/max du widget");
}

// Exécutions (queue/interrupt) + défense API.
{
    const app = makeApp(SEED, { queuePrompt: true });
    let res = await dispatchToolCall("queue_prompt", { batch: 2 }, { app: app, mode: "active" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(app.queuePromptCalls.length, 1);
    assert.deepStrictEqual(app.queuePromptCalls[0], [0, 2], "app.queuePrompt(0, batch)");
    res = await dispatchToolCall("queue_prompt", {}, { app: {}, mode: "active" }); // app sans queuePrompt
    assert.strictEqual(res.ok, false, "queuePrompt indisponible → erreur structurée");
    assert.strictEqual(res.code, "queue_failed");
    ok("queue_prompt : exécution via app.queuePrompt(0, batch), erreur structurée si API absente");
}
{
    // interrupt : api.interrupt prioritaire, sinon POST /interrupt (fetch hook).
    const calls = [];
    let res = await dispatchToolCall("interrupt", {}, { mode: "active", api: { interrupt: async () => { calls.push("api.interrupt"); } } });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.via, "api.interrupt");
    res = await dispatchToolCall("interrupt", {}, { mode: "active", fetchImpl: async (url, init) => {
        calls.push(String(url) + " " + (init && init.method));
        return { ok: true, status: 200, json: async () => ({}) };
    } });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.via, "POST /interrupt");
    assert.strictEqual(calls[1], "/interrupt POST", "POST /interrupt via fetch");
    ok("interrupt : api.interrupt → POST /interrupt (chaîne défensive établie)");
}

// Lectures : formes retournées au LLM.
{
    const app = makeApp(SEED);
    let res = await dispatchToolCall("describe_workflow", {}, { app: app, mode: "read" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.node_count, 2);
    assert.deepStrictEqual(res.data.nodes[0].widgets.steps, 20);
    res = await dispatchToolCall("get_node_widget", { id: 1, widget: "CKPT_NAME" }, { app: app, mode: "read" });
    assert.strictEqual(res.ok, true, "recherche widget insensible à la casse");
    assert.strictEqual(res.data.value, "v1-5.safetensors");
    res = await dispatchToolCall("get_object_info", {}, { app: app, mode: "read", fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ KSampler: {}, LoraLoader: {} }) }) });
    assert.strictEqual(res.data.class_count, 2, "get_object_info sans argument → liste des classes");
    res = await dispatchToolCall("get_object_info", { class_type: "Nope" }, { app: app, mode: "read", fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
    assert.strictEqual(res.code, "not_found", "classe inconnue → erreur structurée");
    res = await dispatchToolCall("get_queue_status", {}, { app: app, mode: "read", fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ queue_running: [[1, "t", { a: 1, b: 2 }]], queue_pending: [] }) }) });
    assert.strictEqual(res.data.queue_running_count, 1);
    assert.strictEqual(res.data.running[0].node_count, 2, "résumé sans le graphe complet du prompt");
    assert.strictEqual(res.data.queue_pending_count, 0);
    ok("lectures (describe/widget/object_info/queue) : rendus sérialisables pour le LLM");
}

/* ══════════════════ 3. (c) Snapshot / UNDO ═════════════════════════════ */
console.log("3. Snapshot/UNDO (pile bornée, restauration complète)");

clearUndo();
{
    const app = makeApp(SEED);
    const ids = [];
    for (let i = 0; i < 12; i++) {
        const s = pushUndoSnapshot({ app: app }, "act" + i);
        assert.strictEqual(s.ok, true);
        ids.push(s.id);
    }
    assert.strictEqual(canUndo(), true);
    assert.strictEqual(ids.length, 12);
    // Pile bornée à 10 : les 2 plus anciens sont tombés.
    assert.strictEqual(canUndoId(ids[0]), false, "plus ancien évacué (limite 10)");
    assert.strictEqual(canUndoId(ids[1]), false, "2ᵉ plus ancien évacué");
    assert.strictEqual(canUndoId(ids[2]), true, "le 3ᵉ est encore dans la pile");
    ok(`pile bornée à ${UNDO_LIMIT} : les plus anciens sortent`);
}
clearUndo();
{
    // Mutation → snapshot → restauration qui rétablit l'ÉTAT.
    const app = makeApp(SEED);
    const before = app.graph.serialize();
    const snap = pushUndoSnapshot({ app: app }, "set steps");
    // ... mutation réelle via le dispatcher ...
    await dispatchToolCall("set_widget_value", { id: 1, widget: "steps", value: 30 }, { app: app, mode: "active" });
    await dispatchToolCall("set_node_title", { id: 1, title: "Mon Loader" }, { app: app, mode: "active" });
    assert.strictEqual(app.graph.nodes[0].widgets[1].value, 30, "pré-condition : muté");
    const undo = await undoSnapshot(snap.id, { app: app });
    assert.strictEqual(undo.ok, true, "undo OK");
    assert.strictEqual(undo.data.restored_via, "loadGraphData", "restauration via loadGraphData (chemin canonique)");
    assert.deepStrictEqual(app.graph.nodes[0].widgets[1].value, 20, "steps rétabli à 20");
    assert.strictEqual(app.graph.nodes[0].title, "Checkpoint", "titre rétabli");
    assert.deepStrictEqual(app.graph.lastRestored, before, "snapshot = workflow COMPLET d'avant la mutation");
    // Les snapshots postérieurs à l'entrée annulée sortent de la pile.
    assert.strictEqual(canUndo(), false, "pile vide après annulation du seul snapshot");
    ok("undo : re-charge du graphe + état rétabli (steps/titre), snapshot complet");
}
clearUndo();
{
    // undoLast : annule la dernière mutation.
    const app = makeApp(SEED);
    await dispatchToolCall("set_widget_value", { id: 2, widget: "steps", value: 50 }, { app: app, mode: "active" });
    const u = await undoLast({ app: app });
    assert.strictEqual(u.ok, true);
    assert.strictEqual(app.graph.nodes[1].widgets[0].value, 20, "rétabli via undoLast");
    const u2 = await undoLast({ app: app });
    assert.strictEqual(u2.ok, false, "pile vide → erreur structurée");
    assert.strictEqual(u2.code, "undo_empty");
    ok("undoLast : dernière mutation annulée, pile vide → erreur structurée");
}
clearUndo();
{
    // undoSnapshot d'un id inconnu (bouton d'une action déjà annulée).
    const r = await undoSnapshot("uXXX", {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "undo_unknown");
    ok("id inconnu → undo_unknown (boutons expirés)");
}

/* ══════════════════ 4. (d) Boucle tool_calls (pure) ════════════════════ */
console.log("4. Boucle tool_calls (stubs send/dispatch)");

{
    const posts = [];
    const providerTc1 = { id: "c1", type: "function", function: { name: "set_widget_value", arguments: '{"id":1,"widget":"steps","value":30}' } };
    const providerTc2 = { id: "c2", type: "function", function: { name: "get_node_widget", arguments: '{"id":1,"widget":"steps"}' } };
    const responses = [
        { tool_calls: [providerTc1, providerTc2] },
        { output: "C'est réglé !" },
    ];
    const dispatched = [];
    const toolLines = [];
    const result = await runToolLoop({
        messages: [{ role: "user", content: "mets steps à 30" }],
        send: async (convo) => { posts.push(JSON.parse(JSON.stringify(convo))); return responses[posts.length - 1]; },
        dispatch: async (name, args) => { dispatched.push([name, args]); return { ok: true, data: { echo: name }, action: "⚙️ " + name }; },
        onToolCall: (res, tc) => toolLines.push([tc.id, res.ok, res.action]),
    });
    assert.strictEqual(result.ok, true, "boucle terminée sur une réponse texte");
    assert.strictEqual(result.finalReply, "C'est réglé !");
    assert.strictEqual(result.turns, 2);
    assert.deepStrictEqual(dispatched[0], ["set_widget_value", { id: 1, widget: "steps", value: 30 }], "arguments = STRING → JSON.parse");
    assert.deepStrictEqual(dispatched[1], ["get_node_widget", { id: 1, widget: "steps" }]);
    // Tour 2 : echo assistant + messages role:'tool' avec tool_call_id.
    const convo2 = posts[1];
    assert.strictEqual(convo2.length, 4, "user + assistant + 2 tool");
    assert.strictEqual(convo2[1].role, "assistant");
    assert.strictEqual(convo2[1].tool_calls.length, 2, "tool_calls du backend renvoyés tels quels");
    // ECHO conforme à l'API provider : `type:'function'` + wrapper `function`.
    assert.deepStrictEqual(convo2[1].tool_calls[0], providerTc1);
    assert.strictEqual(convo2[1].tool_calls[0].type, "function", "type:'function' présent à l'echo (exigence DeepSeek)");
    assert.strictEqual(convo2[1].tool_calls[0].function.name, "set_widget_value", "wrapper function.name présent à l'echo");
    assert.deepStrictEqual(convo2[1].tool_calls[1], providerTc2);
    assert.strictEqual(convo2[2].role, "tool");
    assert.strictEqual(convo2[2].tool_call_id, "c1");
    assert.ok(convo2[2].content.includes("set_widget_value"), "contenu du résultat sérialisé");
    assert.strictEqual(convo2[3].tool_call_id, "c2");
    assert.deepStrictEqual(toolLines, [["c1", true, "⚙️ set_widget_value"], ["c2", true, "⚙️ get_node_widget"]], "onToolCall → lignes d'action");
    ok("tool_calls → dispatch séquentiel + role:'tool' (tool_call_id) au tour suivant");
}

// Arguments JSON invalides : erreur structurée, dispatch NON appelé, pas de crash.
{
    const posts = [];
    const dispatched = [];
    const result = await runToolLoop({
        messages: [{ role: "user", content: "x" }],
        send: async (convo) => {
            posts.push(convo.length);
            return posts.length === 1
                ? { tool_calls: [{ id: "c9", type: "function", function: { name: "set_widget_value", arguments: "{bad json" } }] }
                : { output: "ok" };
        },
        dispatch: async (name, args) => { dispatched.push(name); return { ok: true, data: {} }; },
    });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(dispatched, [], "dispatch NON appelé sur arguments illisibles");
    assert.strictEqual(posts[1], 3, "user + assistant + 1 tool");
    ok("arguments JSON invalides → erreur structurée réinjectée au LLM, dispatch épargné");
}

// Garde anti-boucle : un provider qui ne fait que des tool_calls finit par la garde.
{
    let calls = 0;
    const result = await runToolLoop({
        messages: [{ role: "user", content: "x" }],
        maxTurns: 5,
        send: async () => ({ tool_calls: [{ id: "c", type: "function", function: { name: "get_queue_status", arguments: "" } }] }),
        dispatch: async () => { calls++; return { ok: true, data: {} }; },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.exhausted, true, "garde anti-boucle atteinte");
    assert.strictEqual(result.turns, 5);
    assert.strictEqual(calls, 5, "un dispatch par tour");
    ok("garde anti-boucle : maxTurns borne la boucle (comme le chemin texte)");
}

// Réponse inattendue (ni tool_calls ni output) → signalée au chat (4b possible).
{
    const result = await runToolLoop({
        messages: [{ role: "user", content: "x" }],
        send: async () => ({ output: null }),
        dispatch: async () => ({ ok: true, data: {} }),
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.unexpected, true);
    assert.strictEqual(result.turns, 1, "délimité au 1ᵉʳ tour");
    ok("réponse inattendue au 1ᵉʳ tour → unexpected (repli 4b possible)");
}

// Erreur d'envoi au 1ᵉʳ tour → phase first (le chat vérifie 4b puis affiche).
{
    const result = await runToolLoop({
        messages: [{ role: "user", content: "x" }],
        send: async () => { const e = new Error("erreur serveur"); e.status = 500; throw e; },
        dispatch: async () => ({ ok: true, data: {} }),
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.sendError.status, 500);
    assert.strictEqual(result.phase, "first");
    ok("erreur d'envoi → phase first, transmise au chat (bl.sorry)");
}

// Helpers de rendu.
{
    assert.deepStrictEqual(extractToolCalls({ tool_calls: [] }), [], "tool_calls vide → []");
    assert.deepStrictEqual(extractToolCalls({}), [], "pas de tool_calls → []");
    // Forme provider (contrat étape 1) : lecture via .function.name.
    const provTc = { id: "c1", type: "function", function: { name: "get_queue_status", arguments: "" } };
    assert.deepStrictEqual(extractToolCalls({ tool_calls: [provTc] }), [provTc], "forme provider extraite");
    assert.strictEqual(toolCallName(provTc), "get_queue_status");
    assert.strictEqual(toolCallArguments(provTc), "");
    // Tolérance lecture : ancienne forme normalisée encore lisible…
    assert.strictEqual(toolCallName({ id: "c", name: "f", arguments: "{}" }), "f");
    assert.strictEqual(toolCallArguments({ id: "c", name: "f", arguments: "{}" }), "{}");
    // …mais l'ECHO repasse en forme provider (défense en profondeur).
    assert.deepStrictEqual(normalizeToolCallForEcho({ id: "c", name: "f", arguments: "{}" }),
        { id: "c", type: "function", function: { name: "f", arguments: "{}" } });
    // Echo verbatim pour la forme provider (même référence).
    assert.strictEqual(normalizeToolCallForEcho(provTc), provTc, "forme provider échoée verbatim");
    const p = parseToolArguments('{"a":1}');
    assert.deepStrictEqual(p, { ok: true, value: { a: 1 } });
    assert.strictEqual(parseToolArguments("").ok, true, "arguments vides → {}");
    assert.strictEqual(parseToolArguments("[1,2]").ok, false, "tableau → refusé (attendu objet)");
    assert.strictEqual(parseToolArguments("null").ok, false, "JSON non-objet → refusé");
    const long = renderToolContent({ ok: true, data: "x".repeat(9000) });
    assert.ok(long.length < 8300 && long.endsWith("…[tronqué]"), "contenu borné (~8000)");
    assert.strictEqual(renderToolContent({ ok: false, error: "boom", code: "exec_error" }), '{"error":"boom","code":"exec_error"}');
    ok("extract/parse/render : contrat backend respecté, contenu borné");
}

/* ══════════════════ 5. (e) Repli 4b : détection délimitée ══════════════ */
console.log("5. Repli 4b (détection délimitée d'un provider sans tools)");

assert.strictEqual(detectToolsUnsupported(null, { message: "tools are not supported by this model", status: 400 }), true, "payload error tools");
assert.strictEqual(detectToolsUnsupported(null, { message: "This provider does not support function calling", status: 422 }), true, "function calling");
assert.strictEqual(detectToolsUnsupported(null, { message: "Unexpected keyword argument 'tools'", status: 400 }), true, "argument inconnu tools");
assert.strictEqual(detectToolsUnsupported({ output: "Erreur : tool use not supported here." }), true, "sortie modèle");
assert.strictEqual(detectToolsUnsupported(null, { message: "unauthorized", status: 401 }), false, "401 → PAS 4b");
assert.strictEqual(detectToolsUnsupported(null, { message: "Internal Server Error", status: 500 }), false, "5xx → PAS 4b");
assert.strictEqual(detectToolsUnsupported(null, { message: "réponse non-JSON (statut 502)", status: 502 }), false, "502 → PAS 4b");
assert.strictEqual(detectToolsUnsupported({ output: "Voici tes outils : set_widget_value, add_node" }), false, "texte normal qui PARLE d'outils → PAS 4b");
assert.strictEqual(detectToolsUnsupported({ output: "Je vais utiliser set_widget_value pour régler steps." }), false, "texte normal 2 → PAS 4b");
assert.strictEqual(detectToolsUnsupported(null, null), false, "rien → PAS 4b");
ok("détection 4b : signaux tools explicites seulement (401/5xx/texte normal épargnés)");

/* ══════════════════ 6. Mutations restantes (formes défensives) ═════════ */
console.log("6. Mutations restantes + formes défensives API");

{
    // connect_nodes / disconnect_nodes.
    const app = makeApp(SEED);
    let res = await dispatchToolCall("connect_nodes", { from_id: 1, from_slot: 0, to_id: 2, to_input: "model" }, { app: app, mode: "active" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(app.graph.nodes[1].inputs[0].link, 700, "lien posé");
    assert.ok(res.action.includes("→"), `ligne d'action : ${res.action}`);
    res = await dispatchToolCall("connect_nodes", { from_id: 1, from_slot: 0, to_id: 2, to_input: "inexistant" }, { app: app, mode: "active" });
    assert.strictEqual(res.code, "invalid_args", "entrée inexistante → erreur structurée");
    res = await dispatchToolCall("disconnect_nodes", { from_id: 1, from_slot: 0, to_id: 2 }, { app: app, mode: "active" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.disconnected, 1);
    assert.strictEqual(app.graph.nodes[1].inputs[0].link, null, "lien coupé");
    res = await dispatchToolCall("disconnect_nodes", {}, { app: app, mode: "active" });
    assert.strictEqual(res.code, "invalid_args", "aucun couple fourni → erreur structurée");
    ok("connect/disconnect : liens posés/coupés, erreurs structurées sinon");
}
{
    // add_node : hook de création, sinon erreur structurée (jamais de crash).
    const app = makeApp(SEED);
    let created = null;
    const res = await dispatchToolCall("add_node", { class_type: "KSampler", x: 12, y: 34, title: "Samp" }, {
        app: app, mode: "active",
        createNodeImpl: (cls) => { created = cls; return { id: 9, type: cls, title: cls, pos: [0, 0], widgets: [] }; },
    });
    assert.strictEqual(created, "KSampler", "hook createNodeImpl utilisé");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(app.graph.nodes.length, 3, "nœud ajouté au graphe");
    const added = app.graph.nodes[2];
    assert.deepStrictEqual(added.pos, [12, 34], "position appliquée");
    assert.strictEqual(added.title, "Samp");
    assert.strictEqual(res.data.id, 9);
    // Sans hook et sans LiteGraph exposé (forme runtime inconnue) → erreur claire.
    const res2 = await dispatchToolCall("add_node", { class_type: "KSampler" }, { app: app, mode: "active" });
    assert.strictEqual(res2.ok, false);
    assert.strictEqual(res2.code, "add_failed");
    assert.ok(res2.error.includes("get_object_info"), "message oriente vers get_object_info");
    ok("add_node : création via hook/LiteGraph, add_failed structuré sinon (forme addNode non confirmée gérée)");
}
{
    // remove_node : graph.remove prioritaire, fallback node.remove / splice.
    const app = makeApp(SEED);
    app.graph.remove = (nd) => { app.graph.nodes = app.graph.nodes.filter((x) => x !== nd); };
    let res = await dispatchToolCall("remove_node", { id: 2 }, { app: app, mode: "active" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(app.graph.nodes.length, 1, "graph.remove utilisé");
    assert.ok(res.action.includes("🗑️"), `ligne d'action : ${res.action}`);
    const app2 = makeApp(SEED);
    app2.graph.nodes[1].remove = function () { app2.graph.nodes = app2.graph.nodes.filter((x) => x !== this); };
    res = await dispatchToolCall("remove_node", { id: 2 }, { app: app2, mode: "active" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(app2.graph.nodes.length, 1, "fallback node.remove");
    const app3 = makeApp(SEED);
    res = await dispatchToolCall("remove_node", { id: 2 }, { app: app3, mode: "active" });
    assert.strictEqual(res.ok, true, "dernier recours : splice du tableau nodes");
    assert.strictEqual(app3.graph.nodes.length, 1);
    ok("remove_node : graph.remove → node.remove → splice (chaîne défensive)");
}
{
    // set_node_color : validation hex.
    const app = makeApp(SEED);
    let res = await dispatchToolCall("set_node_color", { id: 1, color: "#FF8F00", bgcolor: "#2a1a00" }, { app: app, mode: "active" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(app.graph.nodes[0].color, "#FF8F00");
    assert.strictEqual(app.graph.nodes[0].bgcolor, "#2a1a00");
    res = await dispatchToolCall("set_node_color", { id: 1, color: "rouge" }, { app: app, mode: "active" });
    assert.strictEqual(res.code, "invalid_value", "couleur non-hex → erreur structurée");
    ok("set_node_color : hex validé, sinon erreur structurée");
}
{
    // move_node.
    const app = makeApp(SEED);
    const res = await dispatchToolCall("move_node", { id: 1, x: 100, y: 200 }, { app: app, mode: "active" });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(app.graph.nodes[0].pos, [100, 200]);
    assert.deepStrictEqual(res.data.previous, [0, 0], "position précédente rapportée");
    ok("move_node : position posée + précédent rapporté");
}
{
    // Pas d'app du tout → no_app structuré (jamais de crash).
    const res = await dispatchToolCall("describe_workflow", {}, { mode: "read" });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, "no_app");
    ok("app/graph absents → erreur structurée no_app");
}

console.log(`\n✅ Partie 1 (pure) : ${n} groupes d'assertions PASS — suite jsdom…`);

/* ════════════════════════════════════════════════════════════════════════
   7. PARTIE 2 (jsdom) — chemin chat : (d) tool_calls, (e) 4b, (f) non-
   régression du chemin texte, (g) parité i18n.
   ════════════════════════════════════════════════════════════════════════ */

const JSDOM = await loadJsdomOrSkip("test_blobby_tools");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
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

// Config : serveur + preset Blobby, locale FR déterministe.
localStorage.setItem("aih_locale", "fr");
localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "http://aih.test", apiKey: "k", blobbyPreset: "3" }));

// ── Fake fetch global (remoteRequest/HolafFetch passe par lui) ──
const httpCalls = [];   // { url, method, body }
const llmQueue = [];    // réponses en file pour /api/keywords/llm-process
function jsonResponse(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) },
        json: async () => data,
        text: async () => JSON.stringify(data),
    };
}
globalThis.fetch = async (url, init) => {
    const u = String(url);
    let body = null;
    try { body = init && typeof init.body === "string" ? JSON.parse(init.body) : null; } catch { body = init?.body ?? null; }
    httpCalls.push({ url: u, method: (init && init.method) || "GET", body });

    if (u.includes("/api/keywords/llm-process")) {
        // App de mise à jour de personnalité (fire-and-forget, tous les 5 msg) :
        // réponse dédiée pour ne PAS consommer la file de test.
        if (body && typeof body.instruction === "string" && body.instruction.includes("Personnalite actuelle")) {
            return jsonResponse({ output: "Blobby perso" });
        }
        if (llmQueue.length) {
            const item = llmQueue.shift();
            if (item && item.__status !== undefined) return jsonResponse(item.data, item.__status);
            return jsonResponse(item);
        }
        return jsonResponse({ output: "..." });
    }
    if (u.includes("/aih/blobby/exec")) return jsonResponse({ ok: true, output: "hello" });
    if (u.includes("/api/blobby/memory")) return jsonResponse({ results: [] });
    if (u.includes("/api/settings")) return jsonResponse({});
    return jsonResponse({});
};

// ── Faux app ComfyUI (AVANT l'import : waitForApp s'y enregistre) ──
function freshApp() {
    const app = makeApp(structuredClone(SEED), { queuePrompt: true });
    app.registerExtension = function (ext) { app.extensions.push(ext); };
    app.extensions = [];
    return app;
}
globalThis.window.app = freshApp();

// Capture des dictionnaires AVANT leur enregistrement (parité FR/EN) —
// aih_strings.js est importé transitivement par blobby_companion.js.
await import("./aih_i18n.js");
const I18n = domWindow.AIH.I18n;
const captured = {};
const origAddDict = I18n.addDict.bind(I18n);
I18n.addDict = (lang, entries) => {
    captured[lang] = Object.assign(captured[lang] || {}, entries);
    return origAddDict(lang, entries);
};
I18n.setLocale("fr");
await import("./blobby_companion.js");

const Blobby = domWindow.Blobby;
assert.ok(Blobby && typeof Blobby._handleChatMessage === "function", "Blobby exposé (window.Blobby) avec le chat");
assert.strictEqual(domWindow.BlobbyCompanion.getMode(), "read", "façade : mode par défaut = read");
ok("module chat chargé (jsdom) — mode défaut read via la façade");

const chat = domWindow.document.getElementById("blobby-chat-msgs") || (() => {
    const el = domWindow.document.createElement("div");
    el.id = "blobby-chat-msgs";
    domWindow.document.body.appendChild(el);
    return el;
})();

function resetChat() {
    chat.innerHTML = "";
    clearUndo();
    httpCalls.length = 0;
    llmQueue.length = 0;
    globalThis.window.app = freshApp();
    domWindow.document.querySelectorAll("#blobby-chat-ctx").forEach((e) => e.remove());
}
const msgs = (role) => [...chat.querySelectorAll(".blobby-msg")].filter((el) => el.dataset.role === role);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
// POST LLM du chat SANS l'app de mise à jour de personnalité (fire-and-forget
// au 5ᵉ message, même URL /api/keywords/llm-process — réponse dédiée côté
// fake fetch, exclue ici pour garder les assertions déterministes).
const llmPosts = () => httpCalls
    .filter((c) => c.url.includes("/api/keywords/llm-process"))
    .filter((c) => !(c.body && typeof c.body.instruction === "string" && c.body.instruction.includes("Personnalite actuelle")));

/* ── (g) Parité i18n FR/EN des clés bl.* ── */
const frKeys = Object.keys(captured.fr || {}).filter((k) => k.startsWith("bl."));
const missingEn = frKeys.filter((k) => !(k in (captured.en || {})));
const emptyEn = frKeys.filter((k) => String((captured.en || {})[k] ?? "").trim() === "");
assert.deepStrictEqual(missingEn, [], `clés bl.* sans traduction EN : ${missingEn.join(", ")}`);
assert.deepStrictEqual(emptyEn, [], `clés bl.* vides en EN : ${emptyEn.join(", ")}`);
assert.ok(frKeys.length >= 40, `bloc outils Blobby présent (${frKeys.length} clés bl.*)`);
ok(`(g) parité FR/EN OK : ${frKeys.length} clés bl.*, 0 manquante, 0 vide`);

/* ── (d) Chemin tool_calls complet à travers _handleChatMessage ── */
resetChat();
llmQueue.push(
    { tool_calls: [
        { id: "c1", type: "function", function: { name: "set_widget_value", arguments: '{"id":1,"widget":"steps","value":30}' } },
        { id: "c2", type: "function", function: { name: "set_node_title", arguments: '{"id":1,"title":"Mon <b>Loader</b>"}' } },
    ] },
    { output: "Voilà, c'est réglé !" },
);
Blobby.setMode("active");
assert.strictEqual(domWindow.BlobbyCompanion.getMode(), "active", "mode actif via la façade");
await Blobby._handleChatMessage(chat, "mets steps à 30");
await tick();

const llmPostsD = llmPosts();
assert.strictEqual(llmPostsD.length, 2, "2 tours LLM (tool_calls puis final)");
assert.strictEqual(llmPostsD[0].body.preset_id, 3, "preset_id transmis");
assert.ok(Array.isArray(llmPostsD[0].body.tools) && llmPostsD[0].body.tools.length === listTools().length, "tools (schémas filtrés par mode) envoyés");
assert.strictEqual(llmPostsD[0].body.tool_choice, "auto", "tool_choice auto");
assert.ok(!("instruction" in llmPostsD[0].body), "nouveau contrat : PAS de champ instruction quand messages est fourni");
assert.ok(Array.isArray(llmPostsD[0].body.messages) && llmPostsD[0].body.messages.length === 1, "messages = liste complète (user)");
assert.ok(llmPostsD[0].body.messages[0].content.includes("Workflow actuel"), "instruction enrichie (workflow)");
// Tour 2 : echo assistant + role:'tool'.
const convo2 = llmPostsD[1].body.messages;
assert.strictEqual(convo2.length, 4, "user + assistant + 2 role:'tool'");
assert.strictEqual(convo2[1].role, "assistant");
assert.strictEqual(convo2[1].tool_calls.length, 2, "tool_calls renvoyés au backend");
// ECHO conforme API provider : `type` + wrapper `function` (sinon DeepSeek 400).
assert.strictEqual(convo2[1].tool_calls[0].type, "function", "type:'function' à l'echo");
assert.deepStrictEqual(convo2[1].tool_calls[0],
    { id: "c1", type: "function", function: { name: "set_widget_value", arguments: '{"id":1,"widget":"steps","value":30}' } });
assert.strictEqual(convo2[2].role, "tool");
assert.strictEqual(convo2[2].tool_call_id, "c1");
assert.ok(convo2[2].content.includes("steps"), "résultat outil sérialisé dans le message tool");
assert.strictEqual(convo2[3].tool_call_id, "c2");
// Effets réels sur le faux graphe.
assert.strictEqual(globalThis.window.app.graph.nodes[0].widgets[1].value, 30, "widget muté (steps=30)");
assert.strictEqual(globalThis.window.app.graph.nodes[0].title, "Mon <b>Loader</b>", "titre muté");
// Lignes d'action avec bouton Annuler + échappement HTML des valeurs.
const actionLines = msgs("action");
assert.strictEqual(actionLines.length, 2, "2 lignes d'action loggées");
assert.ok(actionLines[0].querySelector("button[data-undo-id]"), "bouton Annuler sur la ligne de mutation");
const titleLine = actionLines[1];
assert.ok(!titleLine.innerHTML.includes("<b>Loader"), "valeur du graphe ÉCHAPPÉE dans le log (escapeHtml)");
assert.ok(titleLine.innerHTML.includes("&lt;b&gt;"), "entités HTML échappées");
// Réponse finale.
assert.strictEqual(msgs("blobby").length, 1, "réponse finale affichée");
assert.ok(msgs("blobby")[0].textContent.includes("Voilà, c'est réglé !"), "texte final du LLM");
assert.ok(!chat.textContent.includes("❌ Erreur"), "aucun message d'erreur système");
ok("(d) tool_calls : POST messages/tools/tool_choice → dispatch → role:'tool' → réponse finale + lignes d'action échappées");

/* ── (c) au travers du chat : bouton « Annuler » restaure le graphe ── */
const firstBtn = actionLines[0].querySelector("button[data-undo-id]");
assert.ok(firstBtn && !firstBtn.disabled, "bouton Annuler actif");
assert.strictEqual(canUndo(), true, "pile undo non vide");
firstBtn.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick(30);
assert.strictEqual(globalThis.window.app.graph.nodes[0].widgets[1].value, 20, "undo : steps rétabli à 20");
assert.strictEqual(globalThis.window.app.graph.nodes[0].title, "Checkpoint", "undo : titre rétabli");
assert.strictEqual(canUndo(), false, "pile vide après restauration");
const sysAfterUndo = msgs("system").map((e) => e.textContent).join(" ");
assert.ok(sysAfterUndo.includes("Workflow restauré"), "log d'annulation affiché");
assert.strictEqual(firstBtn.disabled, true, "bouton de l'action annulée désactivé");
assert.strictEqual(actionLines[1].querySelector("button[data-undo-id]").disabled, true, "bouton de l'action postérieure désactivé (incohérente)");
ok("(c) bouton « Annuler » : snapshot complet restauré, log + boutons postérieurs désactivés");

/* ── (e) Repli 4b à travers le chat : erreur payload tools au 1ᵉʳ tour ── */
resetChat();
llmQueue.push(
    { __status: 400, data: { error: "tools are not supported by this model" } },
    { output: "Réponse texte de repli." },
);
Blobby.setMode("active");
await Blobby._handleChatMessage(chat, "aide-moi");
await tick();
const llmPosts4b = llmPosts();
assert.strictEqual(llmPosts4b.length, 2, "1ᵉʳ tour (tools) puis repli texte");
assert.ok(Array.isArray(llmPosts4b[0].body.tools), "1ᵉʳ POST : avec tools");
assert.ok(!("tools" in llmPosts4b[1].body) && !("messages" in llmPosts4b[1].body), "2ᵉ POST : chemin texte historique (sans tools/messages)");
const sys4b = msgs("system").map((e) => e.textContent).join(" ");
assert.ok(sys4b.includes("ne sait pas utiliser d'outils"), "avertissement clair dans le chat");
assert.ok(msgs("blobby").length === 1 && msgs("blobby")[0].textContent.includes("Réponse texte de repli."), "le tour N'EST PAS cassé : réponse finale rendue");
assert.ok(!chat.textContent.includes("❌ Erreur"), "aucun crash");
ok("(e) 4b : erreur payload tools → avertissement + reprise du tour en chemin texte");

/* ── (e) variante : réponse 200 inattendue (ni tool_calls ni output) ── */
resetChat();
llmQueue.push(
    { output: null },
    { output: "ok texte" },
);
await Blobby._handleChatMessage(chat, "encore");
await tick();
const llmPosts4b2 = llmPosts();
assert.strictEqual(llmPosts4b2.length, 2, "repli texte après réponse inattendue");
assert.ok(!("tools" in llmPosts4b2[1].body), "2ᵉ POST sans tools");
assert.ok(msgs("system").map((e) => e.textContent).join(" ").includes("ne sait pas utiliser d'outils"), "avertissement (variante inattendue)");
assert.ok(msgs("blobby")[0].textContent.includes("ok texte"), "réponse finale");
ok("(e) 4b variante : réponse 200 inattendue → même repli, pas de crash");

/* ── (f) NON-RÉGRESSION : chemin texte en Lecture seule ── */
resetChat();
Blobby.setMode("read");
llmQueue.push({ output: "Je regarde. [SET Checkpoint steps 25] et [MOVE_TO Checkpoint]" });
await Blobby._handleChatMessage(chat, "change les steps");
await tick();
const llmPostsRead = llmPosts();
assert.strictEqual(llmPostsRead.length, 1, "un seul tour (pas de boucle tool)");
assert.ok(!("tools" in llmPostsRead[0].body) && !("messages" in llmPostsRead[0].body) && "instruction" in llmPostsRead[0].body, "mode read : POST historique (instruction, sans tools/messages)");
assert.strictEqual(globalThis.window.app.graph.nodes[0].widgets[1].value, 20, "[SET…] en read : workflow NON muté");
assert.ok(!httpCalls.some((c) => c.url.includes("/aih/blobby/exec")), "pas d'exec shell");
const finalRead = msgs("blobby")[0].textContent;
assert.ok(finalRead.includes("interdit en mode 'read'"), `[SET…] refusé explicitement : ${finalRead}`);
assert.ok(finalRead.includes("Vue déplacée"), "[MOVE_TO] continue de marcher (vue)");
assert.ok(!chat.textContent.includes("❌ Erreur"), "aucun crash");
ok("(f) read : POST sans tools/messages, [SET…] refusé sans muter, [MOVE_TO] intact");

/* ── (f) bis : [SET…] texte en mode ACTIF (réponse finale du tool-loop) ── */
resetChat();
Blobby.setMode("active");
llmQueue.push({ output: "Je m'en occupe. [SET KSampler steps 45]" });
await Blobby._handleChatMessage(chat, "steps 45 via SET");
await tick();
assert.strictEqual(globalThis.window.app.graph.nodes[1].widgets[0].value, 45, "[SET…] actif : widget muté via le dispatcher");
const setActions = msgs("action");
assert.strictEqual(setActions.length, 1, "ligne d'action pour [SET…]");
assert.ok(setActions[0].querySelector("button[data-undo-id]"), "bouton Annuler (snapshot pris)");
const llmPostsSet = llmPosts();
assert.strictEqual(llmPostsSet[0].body.tools.length, listTools().length, "mode actif : tools au POST (le modèle a ignoré les outils, [SET…] texte reste compris)");
assert.ok(msgs("blobby")[0].textContent.includes("steps = 45"), "commande [SET…] remplacée par le rendu d'action dans la réponse");
ok("(f) bis : [SET…] en actif → exécuté via le dispatcher (enforcement + snapshot), sans boucle tool supplémentaire");

/* ── (f) ter : [SHELL] continue de marcher en Lecture seule ── */
resetChat();
Blobby.setMode("read");
llmQueue.push(
    { output: "Je vérifie. [SHELL echo hello]" },
    { output: "Résultat obtenu !" },
);
await Blobby._handleChatMessage(chat, "lance un shell");
await tick();
const execCalls = httpCalls.filter((c) => c.url.includes("/aih/blobby/exec"));
assert.strictEqual(execCalls.length, 1, "[SHELL] → POST /aih/blobby/exec");
assert.strictEqual(execCalls[0].body.command, "echo hello", "commande transmise");
const llmPostsShell = llmPosts();
assert.strictEqual(llmPostsShell.length, 2, "boucle agentic texte : 2 tours");
assert.ok(!("tools" in llmPostsShell[0].body), "aucun tools en read");
assert.ok(llmPostsShell[1].body.instruction.includes("Résultat"), "résultats réinjectés au tour suivant (chemin historique)");
assert.ok(msgs("blobby")[0].textContent.includes("Résultat obtenu !"), "réponse finale");
ok("(f) ter : [SHELL] et la boucle agentic texte inchangés en Lecture seule");

/* ── Persistance du mode ── */
Blobby.setMode("active");
assert.strictEqual(JSON.parse(localStorage.getItem("AIH_config")).blobbyData.blobbyMode, "active", "mode persisté (blobbyData.blobbyMode)");
Blobby.setMode("read");
assert.strictEqual(JSON.parse(localStorage.getItem("AIH_config")).blobbyData.blobbyMode, "read", "retour en read persisté");
assert.strictEqual(Blobby.setMode("nonsense"), "read", "valeur inconnue ignorée (reste read)");
Blobby.setMode("active");
Blobby.setMode("");
assert.strictEqual(Blobby.getMode(), "active", "setMode('') ignoré : mode conservé");
Blobby.setMode("read");
ok("persistance : blobbyData.blobbyMode via _blobbySave/_blobbyLoad, valeurs invalides rejetées");

console.log(`\n✅ Outils Blobby (étape 2) : TOUS LES TESTS PASSENT (${n} groupes d'assertions)`);
process.exit(0);