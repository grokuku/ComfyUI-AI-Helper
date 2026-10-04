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
//   8. (h) SUBGRAPHS / POSITION / MODES (6bis) : Subgraph Blueprints
//      (registre root.subgraphs, chemin/instances/ouverture), get_node_position
//      (scope subgraph + locator uuid:id), set_node_mode (enable/mute/bypass,
//      lots, groupe, atomicité), resize_node, add/remove DANS un subgraph,
//      undo complet des mutations internes, refus d'un subgraph non instancié
//      (undo-safe) et refus des mutations en mode Lecture seule.
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

const READ_EXPECTED = ["describe_workflow", "list_nodes", "get_node_by_id", "get_node_widgets", "get_node_widget", "get_node_connections", "get_object_info", "get_queue_status", "get_execution_status", "get_node_position", "list_subgraphs", "get_subgraph", "list_groups", "open_subgraph", "close_subgraph", "focus_view", "select_node"];
const ACTIVE_ONLY = ["set_widget_value", "set_node_title", "set_node_color", "move_node", "resize_node", "set_node_mode", "change_node_type", "add_node", "remove_node", "connect_nodes", "disconnect_nodes", "create_group", "edit_group", "create_subgraph", "convert_to_subgraph", "unpack_subgraph", "queue_prompt", "interrupt"];

const readTools = getToolsForMode("read");
const readNames = readTools.map((x) => x.function.name);
assert.deepStrictEqual(readNames.sort(), READ_EXPECTED.slice().sort(), "mode read : uniquement les outils de lecture");
assert.ok(readNames.every((nm) => !ACTIVE_ONLY.includes(nm)), "mode read : AUCUN outil 'active' proposé au LLM");
ok("mode read : 17 outils de lecture, 0 outil actif");

const activeTools = getToolsForMode("active");
const activeNames = activeTools.map((x) => x.function.name);
// Défaut sûr : sans shellAccess, l'outil shell n'est PAS proposé (1ʳᵉ barrière).
assert.deepStrictEqual(activeNames.sort(), READ_EXPECTED.concat(ACTIVE_ONLY).sort(), "mode active (shell off) : tous les outils SAUF run_shell");
assert.strictEqual(activeTools.length, listTools().length - 1, "shell off : run_shell retiré (35 des 36 outils du registre)");
ok(`mode active (shell off) : ${activeNames.length} outils (run_shell filtré)`);

const activeShellTools = getToolsForMode("active", { shellAccess: true });
const activeShellNames = activeShellTools.map((x) => x.function.name);
assert.deepStrictEqual(activeShellNames.sort(), READ_EXPECTED.concat(ACTIVE_ONLY, ["run_shell"]).sort(), "mode active (shell on) : registre complet + run_shell");
assert.strictEqual(activeShellTools.length, listTools().length, "shell on : getToolsForMode('active') === registre complet");
ok(`mode active (shell on) : ${activeShellNames.length} outils (run_shell proposé)`);

// Le mode reste la 1ʳᵉ barrière : même avec shellAccess, rien de shell en read.
const readShellNames = getToolsForMode("read", { shellAccess: true }).map((x) => x.function.name);
assert.ok(!readShellNames.includes("run_shell"), "read + shell on : run_shell ABSENT (le mode prime)");
ok("read + shellAccess:true : run_shell reste absent (mode = 1ʳᵉ barrière)");

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
const posFn = readTools.find((x) => x.function.name === "get_node_position").function;
assert.ok(posFn.parameters.required.includes("id"), "get_node_position: id requis (lecture seule)");
const subFn = readTools.find((x) => x.function.name === "get_subgraph").function;
assert.ok(subFn.parameters.required.includes("subgraph"), "get_subgraph: subgraph requis");
const modeFn = activeTools.find((x) => x.function.name === "set_node_mode").function;
assert.strictEqual(modeFn.parameters.required.length, 1, "set_node_mode: une seule clé REQUISE (mode)");
assert.ok(modeFn.parameters.required.includes("mode") && modeFn.parameters.properties.nodes && modeFn.parameters.properties.group, "set_node_mode: mode requis + cibles nodes/group");
const resizeFn = activeTools.find((x) => x.function.name === "resize_node").function;
assert.ok(resizeFn.parameters.required.includes("width") && resizeFn.parameters.required.includes("height"), "resize_node: width/height requis");
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

// ── Shell (run_shell) : 1ʳᵉ/2ᵉ barrière au niveau du registre/dispatcher ──
{
    const namesOff = getToolsForMode("active").map((x) => x.function.name);
    const namesOn = getToolsForMode("active", { shellAccess: true }).map((x) => x.function.name);
    assert.ok(!namesOff.includes("run_shell") && namesOn.includes("run_shell"), "run_shell : filtré sans shellAccess, présent avec (1ʳᵉ barrière)");

    let called = 0;
    const execImpl = () => { called++; return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, output: "sortie" }) }); };
    // Refus SANS exécution quand shellAccess absent/faux.
    let r = await dispatchToolCall("run_shell", { command: "ls" }, { mode: "active", fetchImpl: execImpl });
    assert.strictEqual(r.ok, false, "refusé sans shellAccess");
    assert.strictEqual(r.code, "shell_forbidden", "code shell_forbidden");
    assert.strictEqual(called, 0, "exécuteur JAMAIS appelé (aucune requête réseau)");
    // Le mode reste prioritaire : read + shell on → refus mode, toujours aucune requête.
    r = await dispatchToolCall("run_shell", { command: "ls" }, { mode: "read", shellAccess: true, fetchImpl: execImpl });
    assert.strictEqual(r.code, "mode_forbidden", "read + shell on → mode_forbidden (le mode prime)");
    assert.strictEqual(called, 0, "toujours aucune requête");
    // Contrôle négatif IN-SUITE : active + shell on → exécuté (la différence EST l'autorisation).
    r = await dispatchToolCall("run_shell", { command: "ls" }, { mode: "active", shellAccess: true, fetchImpl: execImpl });
    assert.strictEqual(r.ok, true, "autorisé avec shellAccess + active");
    assert.strictEqual(called, 1, "exécuteur appelé une fois");
    assert.ok(r.action && r.action.includes("ls"), "ligne d'action pour la commande");
    // Refus serveur (403 shell_forbidden) → erreur structurée claire, pas de crash.
    r = await dispatchToolCall("run_shell", { command: "x" }, { mode: "active", shellAccess: true, fetchImpl: () => Promise.resolve({ ok: false, status: 403, json: async () => ({ ok: false, error: "shell_forbidden", output: "refus" }) }) });
    assert.strictEqual(r.ok, false, "refus serveur → ok:false");
    assert.strictEqual(r.code, "shell_forbidden", "code shell_forbidden remonté");
    assert.ok(r.error.includes("serveur"), `message clair : ${r.error}`);
    ok("run_shell : filtré/refusé sans shellAccess, autorisé avec (contrôle négatif in-suite), refus serveur propagé");
}

/* ══════════════ 6bis. Subgraphs / position / modes de nœud ═══════════ */
console.log("6bis. Subgraphs (Subgraph Blueprints), position étendue, modes de nœud");

const SG_ID = "11111111-2222-4333-8444-555555555555";
const SG2_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function serializeFixtureNode(n) {
    return {
        id: n.id, type: n.type, title: n.title,
        pos: Array.isArray(n.pos) ? n.pos.slice() : null,
        size: Array.isArray(n.size) ? n.size.slice() : null,
        mode: n.mode,
        widgets: Array.isArray(n.widgets) ? n.widgets.map((w) => ({ name: w.name, type: w.type, value: w.value })) : [],
    };
}

function applyFixtureSnapshot(node, data) {
    if (!node || !data) return;
    if (Array.isArray(data.pos)) node.pos = data.pos.slice();
    if (Array.isArray(data.size)) node.size = data.size.slice();
    if (data.mode !== undefined) node.mode = data.mode;
    if (data.title !== undefined) node.title = data.title;
    if (Array.isArray(data.widgets)) data.widgets.forEach((wd) => {
        const w = (node.widgets || []).find((x) => x && String(x.name) === String(wd.name));
        if (w) w.value = wd.value;
    });
}

// Fixture « Subgraph Blueprints » : racine (nœud 1 + instance node 10 du sg)
// → sg « Upscale Chain » (nœud interne 1 + instance node 20 du sg2)
//   → sg2 « Nested Blueprint » (nœud interne 7). Registre root.subgraphs = Map.
function makeSubgraphFixture() {
    const inner7 = makeNode({ id: 7, type: "ImageScale", title: "Scale", pos: [1, 2] });
    inner7.size = [140, 80];
    const sg2 = {
        id: SG2_ID, name: "Nested Blueprint", description: "sous-subgraph",
        nodes: [inner7], links: {}, inputs: [], outputs: [], groups: [],
        getNodeById(id) { return this.nodes.find((n) => String(n.id) === String(id)) || null; },
        add(n) {
            if (n && typeof n.recomputeInsideNodes === "function" && Array.isArray(n.nodes) && n.type === undefined) {
                if (!this.groups.includes(n)) this.groups.push(n);
            } else { this.nodes.push(n); }
            n.graph = this;
            return n;
        },
        remove(n) { const i = this.nodes.indexOf(n); if (i >= 0) this.nodes.splice(i, 1); },
        setDirtyCanvas() {},
    };
    inner7.graph = sg2;
    const inner1 = makeNode({ id: 1, type: "KSampler", title: "InnerSampler", pos: [5, 6], mode: 0, widgets: [{ name: "steps", type: "number", value: 10, options: { min: 1, max: 100 } }] });
    inner1.size = [210, 100];
    const subNode2 = makeNode({ id: 20, type: SG2_ID, title: "Nested Blueprint", pos: [300, 0] });
    subNode2.subgraph = sg2;
    subNode2.isSubgraphNode = function () { return true; };
    const sg = {
        id: SG_ID, name: "Upscale Chain", description: "chaîne de test",
        nodes: [inner1, subNode2], links: {}, groups: [],
        inputs: [{ name: "image", type: "IMAGE" }],
        outputs: [{ name: "image", type: "IMAGE" }],
        getNodeById(id) { return this.nodes.find((n) => String(n.id) === String(id)) || null; },
        add(n) {
            if (n && typeof n.recomputeInsideNodes === "function" && Array.isArray(n.nodes) && n.type === undefined) {
                if (!this.groups.includes(n)) this.groups.push(n);
            } else { this.nodes.push(n); }
            n.graph = this;
            return n;
        },
        remove(n) { const i = this.nodes.indexOf(n); if (i >= 0) this.nodes.splice(i, 1); },
        setDirtyCanvas() {},
    };
    inner1.graph = sg;
    subNode2.graph = sg;
    const rootNode1 = makeNode({ id: 1, type: "CheckpointLoaderSimple", title: "Checkpoint", widgets: [{ name: "steps", type: "number", value: 20, options: { min: 1, max: 100 } }] });
    rootNode1.size = [210, 100];
    const rootSub = makeNode({ id: 10, type: SG_ID, title: "Upscale Chain", pos: [100, 100], mode: 4 });
    rootSub.subgraph = sg;
    rootSub.isSubgraphNode = function () { return true; };
    const groupSampling = {
        id: 1, title: "Sampling", color: "#335", pos: [0, 0], size: [400, 300], graph: null,
        nodes: [rootNode1], recomputeInsideNodes() { /* le fixture garde nodes */ },
    };
    const groupEmpty = {
        id: 2, title: "Empty", color: "#335", pos: [0, 0], size: [100, 80], graph: null,
        nodes: [], recomputeInsideNodes() {},
    };
    const root = {
        id: "root-graph",
        nodes: [rootNode1, rootSub],
        links: {},
        groups: [groupSampling, groupEmpty],
        subgraphs: new Map([[SG_ID, sg], [SG2_ID, sg2]]),
        rootGraph: null,
        getNodeById(id) { return this.nodes.find((n) => String(n.id) === String(id)) || null; },
        add(n) {
            // Route les groupes vers .groups (forme LGraphGroup : nodes[] +
            // recomputeInsideNodes, sans .type) et les nœuds vers .nodes.
            if (n && typeof n.recomputeInsideNodes === "function" && Array.isArray(n.nodes) && n.type === undefined) {
                if (!this.groups.includes(n)) this.groups.push(n);
            } else {
                this.nodes.push(n);
            }
            n.graph = this;
            return n;
        },
        remove(n) { const i = this.nodes.indexOf(n); if (i >= 0) this.nodes.splice(i, 1); },
        setDirtyCanvas() {},
        change() {},
        serialize() {
            return {
                version: 1,
                nodes: this.nodes.map(serializeFixtureNode),
                definitions: { subgraphs: [sg, sg2].map((s) => ({ id: s.id, name: s.name, nodes: s.nodes.map(serializeFixtureNode) })) },
            };
        },
        configure(data) { this.lastConfigured = data; },
        loadGraphData(data) {
            // Restauration fidèle : racine + definitions.subgraphs (comme le
            // vrai loadGraphData sur un snapshot racine des Subgraph Blueprints).
            (data.nodes || []).forEach((d) => applyFixtureSnapshot(this.getNodeById(d.id), d));
            const defs = data.definitions && Array.isArray(data.definitions.subgraphs) ? data.definitions.subgraphs : [];
            defs.forEach((sd) => {
                const s = this.subgraphs.get(sd.id);
                if (!s) return;
                (sd.nodes || []).forEach((d) => applyFixtureSnapshot(s.getNodeById(d.id), d));
            });
            this.lastRestored = data;
            return Promise.resolve();
        },
    };
    root.rootGraph = root;
    sg.rootGraph = root;
    sg2.rootGraph = root;
    groupSampling.graph = root;
    groupEmpty.graph = root;
    const canvas = {
        graph: root, subgraph: null,
        canvas: { width: 800, height: 600 },
        ds: {
            offset: [0, 0], scale: 1, min_scale: 0.1, max_scale: 10,
            fitToBounds(bounds, opts) { this.fitCalls.push([bounds.slice(), opts && opts.zoom]); this.scale = 0.5; this.offset = [-bounds[0] - bounds[2] / 2, -bounds[1] - bounds[3] / 2]; },
            fitCalls: [],
        },
        centerOnNodeCalls: [],
        centerOnNode(node) { this.centerOnNodeCalls.push(node.id); },
        selectedItems: new Set(),
        lastSelect: null,
        selectItems(items) { this.selectedItems = new Set(items); this.lastSelect = items.map((n) => n.id); },
        deselectAll() { this.selectedItems.clear(); this.lastSelect = []; },
        selectNode(node) { this.selectedItems = new Set([node]); this.lastSelect = [node.id]; },
        dirtyCount: 0,
        setDirty() { this.dirtyCount++; },
        setDirtyCanvas() { this.dirtyCount++; },
        setGraph(g) {
            this.graph = g;
            this.subgraph = (g && g.rootGraph && g.rootGraph !== g) ? g : undefined;
        },
    };
    const app = {
        graph: root, rootGraph: root, canvas: canvas,
        loadGraphData(data) { return root.loadGraphData(data); },
    };
    return { app, root, sg, sg2, canvas, rootNode1, rootSub, inner1, inner7, groupSampling, groupEmpty };
}

// ── list_subgraphs : registre + chemin + instances + état d'ouverture ──
{
    const fx = makeSubgraphFixture();
    const res = await dispatchToolCall("list_subgraphs", {}, { app: fx.app, mode: "read" });
    assert.strictEqual(res.ok, true, "list_subgraphs OK");
    assert.strictEqual(res.data.count, 2, "2 subgraphs (sg + imbriqué)");
    const byId = Object.fromEntries(res.data.subgraphs.map((s) => [s.id, s]));
    assert.ok(byId[SG_ID] && byId[SG2_ID], "les deux subgraphs listés");
    assert.deepStrictEqual(byId[SG2_ID].path, [SG_ID, SG2_ID], "chemin d'imbrication");
    assert.strictEqual(byId[SG2_ID].parent_id, SG_ID, "parent du sous-subgraph");
    assert.strictEqual(byId[SG_ID].node_count, 2, "node_count du sg");
    assert.strictEqual(byId[SG_ID].instances[0], 10, "instance racine du sg = nœud 10");
    assert.strictEqual(byId[SG_ID].open, false, "sg fermé au départ");
    assert.strictEqual(res.data.active_graph, "root", "graphe actif = racine");
    assert.strictEqual(res.data.current_subgraph, null, "aucun subgraph ouvert");
    ok("list_subgraphs : registre + chemin + instances + état d'ouverture");
}

// ── get_subgraph : id/nom/erreurs + nœuds internes détaillés ──
{
    const fx = makeSubgraphFixture();
    let res = await dispatchToolCall("get_subgraph", { subgraph: SG_ID }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.name, "Upscale Chain");
    assert.strictEqual(res.data.node_count, 2);
    const inner = res.data.nodes.find((n) => n.id === 1);
    assert.ok(inner, "nœud interne id 1 présent");
    assert.strictEqual(inner.mode, 0);
    assert.strictEqual(inner.mode_name, "enable", "mode_name lisible");
    assert.deepStrictEqual(inner.pos, [5, 6]);
    assert.strictEqual(inner.widgets.steps, 10, "widgets internes inclus");
    assert.deepStrictEqual(res.data.inputs, [{ name: "image", type: "IMAGE" }]);
    assert.deepStrictEqual(res.data.outputs, [{ name: "image", type: "IMAGE" }]);
    assert.deepStrictEqual(res.data.nested_subgraphs.map((s) => s.id), [SG2_ID], "sous-subgraph listé");
    res = await dispatchToolCall("get_subgraph", { subgraph: "Upscale Chain" }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.ok, true, "résolution par nom exact");
    res = await dispatchToolCall("get_subgraph", { subgraph: "nope" }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.code, "subgraph_not_found", "nom inconnu → erreur structurée");
    const prevName = fx.sg2.name;
    fx.sg2.name = fx.sg.name;
    res = await dispatchToolCall("get_subgraph", { subgraph: "Upscale Chain" }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.code, "subgraph_ambiguous", "nom ambigu → erreur structurée");
    fx.sg2.name = prevName;
    ok("get_subgraph : id/nom/erreurs, nœuds internes (mode/pos/widgets) et sous-subgraphs");
}

// ── open/close_subgraph : navigation canvas (aucun snapshot) ──
{
    const fx = makeSubgraphFixture();
    let res = await dispatchToolCall("open_subgraph", { subgraph: SG_ID }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.ok, true, "ouverture OK en mode lecture (vue seulement)");
    assert.strictEqual(fx.canvas.subgraph, fx.sg, "subgraph attaché au canvas");
    assert.strictEqual(res.snapshotId, null, "navigation : AUCUN snapshot (pas une mutation)");
    res = await dispatchToolCall("list_subgraphs", {}, { app: fx.app, mode: "read" });
    assert.strictEqual(res.data.current_subgraph.id, SG_ID, "état d'ouverture reflété");
    assert.strictEqual(res.data.subgraphs.find((s) => s.id === SG_ID).open, true, "open:true");
    res = await dispatchToolCall("get_node_position", { id: 1, subgraph: "current" }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.ok, true, "'current' cible le subgraph ouvert");
    assert.deepStrictEqual(res.data.pos, [5, 6]);
    assert.strictEqual(res.data.subgraph.id, SG_ID);
    res = await dispatchToolCall("close_subgraph", {}, { app: fx.app, mode: "read" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(fx.canvas.graph, fx.root, "retour racine : canvas.graph = root");
    assert.ok(!fx.canvas.subgraph, "subgraph détaché (undefined, comme le vrai attachCanvas)");
    res = await dispatchToolCall("close_subgraph", {}, { app: fx.app, mode: "read" });
    assert.strictEqual(res.data.already_at_root, true, "déjà racine → no-op signalé");
    res = await dispatchToolCall("open_subgraph", { subgraph: "unknown" }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.code, "subgraph_not_found");
    res = await dispatchToolCall("get_node_position", { id: 1, subgraph: "current" }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.code, "subgraph_not_open", "'current' sans subgraph ouvert → erreur claire");
    res = await dispatchToolCall("open_subgraph", { subgraph: SG_ID }, { app: { graph: fx.root }, mode: "read" });
    assert.strictEqual(res.code, "no_canvas", "sans canvas → erreur structurée");
    res = await dispatchToolCall("list_subgraphs", {}, { mode: "read" });
    assert.strictEqual(res.code, "no_app", "sans app/graph → erreur structurée");
    ok("open/close_subgraph : navigation canvas (aucun snapshot), 'current', no-op et erreurs");
}

// ── get_node_position : scope subgraph + locator uuid:id ──
{
    const fx = makeSubgraphFixture();
    let res = await dispatchToolCall("get_node_position", { id: 7 }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.code, "not_found", "id 7 absent de la racine (défaut = racine)");
    res = await dispatchToolCall("get_node_position", { id: 7, subgraph: SG_ID }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.code, "not_found", "id 7 n'est pas dans sg");
    assert.ok(res.error.includes("Upscale Chain"), "message nomme le subgraph");
    res = await dispatchToolCall("get_node_position", { id: 7, subgraph: SG2_ID }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.data.pos, [1, 2]);
    assert.strictEqual(res.data.subgraph.name, "Nested Blueprint");
    res = await dispatchToolCall("get_node_position", { id: SG2_ID + ":7" }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.ok, true, "locator uuid:id résolu sans argument subgraph");
    assert.deepStrictEqual(res.data.pos, [1, 2]);
    ok("get_node_position : scope subgraph + locator uuid:id + erreurs localisées");
}

// ── Mutations internes (widget/position) + undo complet ──
clearUndo();
{
    const fx = makeSubgraphFixture();
    let res = await dispatchToolCall("set_widget_value", { id: 1, widget: "steps", value: 33, subgraph: SG_ID }, { app: fx.app, mode: "active" });
    assert.strictEqual(res.ok, true, "widget interne muté via subgraph");
    assert.strictEqual(fx.inner1.widgets[0].value, 33);
    assert.ok(res.snapshotId, "snapshot avant mutation interne");
    const snapId = res.snapshotId;
    res = await dispatchToolCall("move_node", { id: 1, x: 50, y: 60, subgraph: SG_ID }, { app: fx.app, mode: "active" });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(fx.inner1.pos, [50, 60]);
    assert.deepStrictEqual(res.data.previous, [5, 6], "position précédente rapportée");
    const undo = await undoSnapshot(snapId, { app: fx.app });
    assert.strictEqual(undo.ok, true, "undo via loadGraphData racine");
    assert.strictEqual(fx.inner1.widgets[0].value, 10, "undo restaure le widget interne");
    assert.deepStrictEqual(fx.inner1.pos, [5, 6], "snapshot COMPLET : position d'avant aussi restaurée");
    clearUndo();
    ok("mutations internes (widget/position) : snapshot racine + undo restaure le subgraph");
}

// ── set_node_mode : enable/mute/bypass, read refusé, erreurs, atomicité ──
clearUndo();
{
    const fx = makeSubgraphFixture();
    let res = await dispatchToolCall("set_node_mode", { id: 1, mode: "mute" }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.code, "mode_forbidden", "mutation interdite en read");
    assert.strictEqual(fx.rootNode1.mode, 0, "mode intact en read");
    assert.strictEqual(canUndo(), false, "aucun snapshot poussé en read");
    res = await dispatchToolCall("set_node_mode", { id: 1, mode: "mute" }, { app: fx.app, mode: "active" });
    assert.strictEqual(res.ok, true, "contrôle négatif in-suite : active passe");
    assert.strictEqual(fx.rootNode1.mode, 2, "mute appliqué (NEVER=2)");
    assert.strictEqual(res.data.mode_name, "mute");
    assert.ok(res.snapshotId, "snapshot pour le changement de mode");
    const undo = await undoSnapshot(res.snapshotId, { app: fx.app });
    assert.strictEqual(undo.ok, true);
    assert.strictEqual(fx.rootNode1.mode, 0, "undo restaure enable (0)");
    res = await dispatchToolCall("set_node_mode", { id: 1, mode: "bypass", subgraph: SG_ID }, { app: fx.app, mode: "active" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(fx.inner1.mode, 4, "bypass interne (BYPASS=4)");
    res = await dispatchToolCall("set_node_mode", { id: 10, mode: 2 }, { app: fx.app, mode: "active" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(fx.rootSub.mode, 2, "mode numérique accepté");
    res = await dispatchToolCall("set_node_mode", { id: 1, mode: "pizza" }, { app: fx.app, mode: "active" });
    assert.strictEqual(res.code, "invalid_value", "mode inconnu → erreur");
    assert.ok(res.error.includes("enable/mute/bypass"), "message liste les modes attendus");
    res = await dispatchToolCall("set_node_mode", { mode: "mute" }, { app: fx.app, mode: "active" });
    assert.strictEqual(res.code, "invalid_args", "cible manquante → erreur");
    res = await dispatchToolCall("set_node_mode", { mode: "mute", id: 1, nodes: [10] }, { app: fx.app, mode: "active" });
    assert.strictEqual(res.code, "invalid_args", "deux cibles → refus");
    res = await dispatchToolCall("set_node_mode", { mode: "mute", nodes: [1, 999] }, { app: fx.app, mode: "active" });
    assert.strictEqual(res.code, "not_found");
    assert.strictEqual(fx.rootNode1.mode, 0, "atomicité : aucun nœud muté quand un id du lot est invalide");
    clearUndo();
    ok("set_node_mode : enable/mute/bypass (+0/2/4), refus read, erreurs, atomicité du lot");
}

// ── set_node_mode sur un GROUPE + list_groups ──
clearUndo();
{
    const fx = makeSubgraphFixture();
    const listed = await dispatchToolCall("list_groups", {}, { app: fx.app, mode: "read" });
    assert.strictEqual(listed.ok, true);
    assert.strictEqual(listed.data.count, 2, "2 groupes listés");
    const sampling = listed.data.groups.find((g) => g.title === "Sampling");
    assert.deepStrictEqual(sampling.node_ids, [1], "node_ids du groupe");
    assert.strictEqual(sampling.color, "#335");
    let res = await dispatchToolCall("set_node_mode", { mode: "mute", group: "Sampling" }, { app: fx.app, mode: "active" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.applied, 1, "1 nœud appliqué");
    assert.strictEqual(fx.rootNode1.mode, 2);
    assert.strictEqual(res.data.nodes[0].previous_name, "enable");
    assert.ok(res.snapshotId, "snapshot pour le groupe");
    await undoSnapshot(res.snapshotId, { app: fx.app });
    assert.strictEqual(fx.rootNode1.mode, 0, "undo restaure le mode du groupe");
    res = await dispatchToolCall("set_node_mode", { mode: "mute", group: "Empty" }, { app: fx.app, mode: "active" });
    assert.strictEqual(res.code, "group_empty", "groupe vide → erreur structurée");
    res = await dispatchToolCall("set_node_mode", { mode: "mute", group: "Nope" }, { app: fx.app, mode: "active" });
    assert.strictEqual(res.code, "group_not_found", "groupe inconnu → erreur structurée");
    clearUndo();
    ok("list_groups + set_node_mode sur un GROUPE : node_ids, undo, erreurs vide/inconnu");
}

// ── resize_node : read refusé, bornes, snapshot + undo ──
clearUndo();
{
    const fx = makeSubgraphFixture();
    let res = await dispatchToolCall("resize_node", { id: 1, width: 300, height: 150 }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.code, "mode_forbidden", "redimensionner interdit en read");
    res = await dispatchToolCall("resize_node", { id: 1, width: 0, height: 10 }, { app: fx.app, mode: "active" });
    assert.strictEqual(res.code, "invalid_value", "taille nulle → erreur");
    res = await dispatchToolCall("resize_node", { id: 1, width: 300, height: 150 }, { app: fx.app, mode: "active" });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(fx.rootNode1.size, [300, 150]);
    assert.deepStrictEqual(res.data.previous, [210, 100]);
    assert.ok(res.snapshotId, "snapshot pour le resize");
    await undoSnapshot(res.snapshotId, { app: fx.app });
    assert.deepStrictEqual(fx.rootNode1.size, [210, 100], "undo restaure la taille");
    clearUndo();
    ok("resize_node : read refusé, bornes > 0, snapshot + undo restaure la taille");
}

// ── add_node / remove_node dans un subgraph ──
{
    const fxAdd = makeSubgraphFixture();
    let res = await dispatchToolCall("add_node", { class_type: "Note", x: 1, y: 2, subgraph: SG_ID }, {
        app: fxAdd.app, mode: "active",
        createNodeImpl: (cls) => ({ id: 99, type: cls, title: cls, pos: [0, 0], size: [100, 60], widgets: [], mode: 0 }),
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(fxAdd.sg.nodes.length, 3, "nœud ajouté DANS le subgraph");
    assert.strictEqual(fxAdd.root.nodes.length, 2, "racine inchangée");
    assert.strictEqual(res.data.subgraph.id, SG_ID, "scope rapporté au LLM");
    const fxDel = makeSubgraphFixture();
    res = await dispatchToolCall("remove_node", { id: 1, subgraph: SG_ID }, { app: fxDel.app, mode: "active" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(fxDel.sg.nodes.length, 1, "nœud retiré du subgraph propriétaire");
    ok("add_node/remove_node : scope subgraph (dans le subgraph, racine intacte)");
}

// ── Subgraph non instancié : liste reachable:false + actions refusées ──
{
    const fx = makeSubgraphFixture();
    const orphan = { id: "99999999-9999-4999-8999-999999999999", name: "Orphan", nodes: [makeNode({ id: 1, type: "X" })], links: {}, inputs: [], outputs: [] };
    fx.root.subgraphs.set(orphan.id, orphan);
    let res = await dispatchToolCall("list_subgraphs", {}, { app: fx.app, mode: "read" });
    const entry = res.data.subgraphs.find((s) => s.id === orphan.id);
    assert.ok(entry, "subgraph du registre listé");
    assert.strictEqual(entry.reachable, false, "non instancié → reachable:false");
    res = await dispatchToolCall("get_node_position", { id: 1, subgraph: orphan.id }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.code, "subgraph_unreachable", "action sur subgraph non instancié refusée (undo-safe)");
    res = await dispatchToolCall("open_subgraph", { subgraph: orphan.id }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.code, "subgraph_unreachable", "ouverture refusée aussi");
    ok("subgraph non instancié : listé reachable:false, actions refusées (pas de couverture undo)");
}

// ══════════════════════ 6ter. Groupes / subgraphs / navigation ═══════════
// Fixture MUTABLE dédiée : serialize()/loadGraphData() reconstruisent
// fidèlement la topologie (racine + groups + definitions.subgraphs), ce qui
// permet de VRAIMENT vérifier que l'undo restaure une création/conversion/
// dépaquetage. Les tests existants gardent makeSubgraphFixture (mutation en
// place des objets) : les deux fixtures coexistent.

let _testUuidSeq = 0;
function generateTestUuid() {
    _testUuidSeq++;
    return "aaaaaaaa-bbbb-4ccc-8ddd-" + String(_testUuidSeq).padStart(12, "0");
}

function makeEditableGroup(seed) {
    const g = {
        id: seed.id, title: seed.title || "Group", color: seed.color || "#335",
        pos: [seed.pos ? seed.pos[0] : 0, seed.pos ? seed.pos[1] : 0],
        size: [seed.size ? seed.size[0] : 140, seed.size ? seed.size[1] : 80],
        graph: null,
        nodes: (seed.nodes || []).slice(),
        // Recompute fidèle : un nœud est DANS le groupe si le centre de sa
        // boîte est contenu (même critère que LGraphGroup.containsCentre).
        recomputeInsideNodes() {
            const graph = this.graph;
            if (!graph || !Array.isArray(graph.nodes)) return;
            const bx = this.pos[0], by = this.pos[1], bw = this.size[0], bh = this.size[1];
            this.nodes = graph.nodes.filter((n) => {
                const p = Array.isArray(n.pos) ? n.pos : [0, 0];
                const s = Array.isArray(n.size) ? n.size : [0, 0];
                const cx = p[0] + s[0] / 2, cy = p[1] + s[1] / 2;
                return cx >= bx && cx <= bx + bw && cy >= by && cy <= by + bh;
            });
        },
        serialize() { return { id: this.id, title: this.title, color: this.color, bounding: [this.pos[0], this.pos[1], this.size[0], this.size[1]], flags: {} }; },
        configure(o) {
            this.id = o.id; this.title = o.title; this.color = o.color;
            if (Array.isArray(o.bounding)) { this.pos = [o.bounding[0], o.bounding[1]]; this.size = [o.bounding[2], o.bounding[3]]; }
        },
    };
    Object.defineProperty(g, "boundingRect", { get() { return [this.pos[0], this.pos[1], this.size[0], this.size[1]]; } });
    return g;
}

function makeEditableFixture() {
    const n1 = makeNode({ id: 1, type: "KSampler", title: "Sampler", pos: [10, 10], widgets: [{ name: "steps", type: "number", value: 20, options: { min: 1, max: 100 } }] });
    n1.size = [100, 60];
    const n2 = makeNode({ id: 2, type: "SaveImage", title: "Save", pos: [500, 500] });
    n2.size = [210, 100];
    const n3 = makeNode({ id: 3, type: "Note", title: "Note", pos: [900, 900] });
    n3.size = [140, 60];
    const group = makeEditableGroup({ id: 1, title: "Existing", pos: [0, 0], size: [300, 200], nodes: [n1] });

    const root = {
        id: "root-graph", _nodes: [n1, n2, n3], _groups: [group], links: {},
        subgraphs: new Map(), rootGraph: null,
        state: { lastGroupId: 1, lastNodeId: 3, lastLinkId: 0, lastRerouteId: 0 },
        get nodes() { return this._nodes; },
        set nodes(v) { this._nodes = v; },
        get groups() { return this._groups; },
        set groups(v) { this._groups = v; },
        getNodeById(id) { return this._nodes.find((n) => String(n.id) === String(id)) || null; },
        add(item) {
            if (item && typeof item.recomputeInsideNodes === "function" && item.type === undefined) this._groups.push(item);
            else this._nodes.push(item);
            item.graph = this;
            return item;
        },
        remove(item) {
            const i = this._nodes.indexOf(item);
            if (i >= 0) { this._nodes.splice(i, 1); return; }
            this._groups = this._groups.filter((g) => g !== item);
        },
        setDirtyCanvas() {}, change() {},
        _nextNodeId() { this.state.lastNodeId = (this.state.lastNodeId || 0) + 1; return this.state.lastNodeId; },
        _makeSubgraph(id, name) {
            const sg = {
                id: id, name: name, description: "", nodes: [], links: {}, inputs: [], outputs: [], rootGraph: root,
                getNodeById(x) { return this.nodes.find((n) => String(n.id) === String(x)) || null; },
                add(n) { n.graph = this; this.nodes.push(n); return n; },
                remove(n) { const i = this.nodes.indexOf(n); if (i >= 0) this.nodes.splice(i, 1); },
                setDirtyCanvas() {},
            };
            this.subgraphs.set(id, sg);
            return sg;
        },
        createSubgraph(data) { return this._makeSubgraph(data.id, data.name); },
        convertToSubgraph(items) {
            const arr = [...items];
            const id = generateTestUuid();
            const sg = this._makeSubgraph(id, "New Subgraph");
            for (const node of arr) {
                const i = this._nodes.indexOf(node);
                if (i >= 0) this._nodes.splice(i, 1);
                node.graph = sg;
                sg.nodes.push(node);
            }
            const inst = makeNode({ id: this._nextNodeId(), type: id, title: "New Subgraph", pos: [50, 50] });
            inst.size = [200, 80];
            inst.subgraph = sg;
            inst.isSubgraphNode = () => true;
            inst.graph = this;
            this._nodes.push(inst);
            return { subgraph: sg, node: inst };
        },
        unpackSubgraph(node) {
            const sg = node.subgraph;
            if (!sg) return;
            const i = this._nodes.indexOf(node);
            if (i >= 0) this._nodes.splice(i, 1);
            for (const n of sg.nodes) { n.graph = this; this._nodes.push(n); }
        },
        serialize() {
            const defs = [];
            for (const sg of this.subgraphs.values()) defs.push({ id: sg.id, name: sg.name, nodes: sg.nodes.map(serializeFixtureNode) });
            return { version: 1, nodes: this._nodes.map(serializeFixtureNode), groups: this._groups.map((g) => g.serialize()), definitions: { subgraphs: defs } };
        },
        _recreate(d, owner) {
            const node = makeNode({
                id: d.id, type: d.type, title: d.title, pos: d.pos || [0, 0],
                mode: d.mode === undefined ? 0 : d.mode,
                widgets: (d.widgets || []).map((w) => ({ name: w.name, type: w.type, value: w.value })),
            });
            node.size = Array.isArray(d.size) ? d.size.slice() : [210, 100];
            const sg = this.subgraphs.get(String(d.type));
            if (sg) { node.subgraph = sg; node.isSubgraphNode = () => true; }
            node.graph = owner;
            return node;
        },
        loadGraphData(data) {
            const defs = (data.definitions && Array.isArray(data.definitions.subgraphs)) ? data.definitions.subgraphs : [];
            // 1) définitions (créer/retirer) — AVANT les nœuds racine pour que
            //    les nœuds instance retrouvent leur .subgraph.
            for (const id of [...this.subgraphs.keys()]) if (!defs.some((d) => d.id === id)) this.subgraphs.delete(id);
            const sgs = [];
            for (const d of defs) {
                let sg = this.subgraphs.get(d.id);
                if (!sg) sg = this._makeSubgraph(d.id, d.name);
                sg.name = d.name;
                sgs.push([sg, d]);
            }
            for (const [sg, d] of sgs) sg.nodes = (d.nodes || []).map((nd) => this._recreate(nd, sg));
            // 2) racine + groupes
            this._nodes = (data.nodes || []).map((d) => this._recreate(d, this));
            this._groups = (data.groups || []).map((o) => {
                const g = makeEditableGroup({ id: o.id, title: o.title, color: o.color, pos: o.bounding ? [o.bounding[0], o.bounding[1]] : [0, 0], size: o.bounding ? [o.bounding[2], o.bounding[3]] : [140, 80] });
                g.graph = this;
                return g;
            });
            this.lastRestored = data;
            return Promise.resolve();
        },
        configure(data) { this.lastConfigured = data; },
    };
    root.rootGraph = root;
    n1.graph = root; n2.graph = root; n3.graph = root; group.graph = root;
    const canvas = {
        graph: root, subgraph: null,
        canvas: { width: 800, height: 600 },
        ds: {
            offset: [123, 45], scale: 1.25, min_scale: 0.1, max_scale: 10, fitCalls: [],
            fitToBounds(bounds, opts) { this.fitCalls.push([bounds.slice(), opts && opts.zoom]); this.scale = 0.5; this.offset = [-bounds[0] - bounds[2] / 2, -bounds[1] - bounds[3] / 2]; },
        },
        centerOnNodeCalls: [], centerOnNode(node) { this.centerOnNodeCalls.push(node.id); },
        selectedItems: new Set(), lastSelect: null,
        selectItems(items) { this.selectedItems = new Set(items); this.lastSelect = items.map((n) => n.id); },
        deselectAll() { this.selectedItems.clear(); this.lastSelect = []; },
        dirtyCount: 0, setDirty() { this.dirtyCount++; },
        openSubgraphCalls: [],
        openSubgraph(sg) { this.openSubgraphCalls.push(sg.id); this.subgraph = sg; this.graph = sg; },
        setGraph(g) { this.graph = g; this.subgraph = (g && g.rootGraph && g.rootGraph !== g) ? g : undefined; },
        setDirtyCanvas() { this.dirtyCount++; },
    };
    const app = { graph: root, rootGraph: root, canvas: canvas, loadGraphData(data) { return root.loadGraphData(data); } };
    return { app, root, canvas, n1, n2, n3, group };
}

// Groupe de test pour buildGroup (Part 1 pure : pas de window.LiteGraph).
let _fakeGroupId = 100;
function fakeCreateGroup(_graph, title) {
    _fakeGroupId += 1;
    return makeEditableGroup({ id: _fakeGroupId, title: title, pos: [0, 0], size: [140, 80] });
}

// ── create_group : read refusé, création (id/pos/size/couleur) + undo ──
clearUndo();
{
    const fx = makeEditableFixture();
    const ctx = { app: fx.app, mode: "active", createGroupImpl: fakeCreateGroup };
    let res = await dispatchToolCall("create_group", { title: "G" }, { app: fx.app, mode: "read", createGroupImpl: fakeCreateGroup });
    assert.strictEqual(res.code, "mode_forbidden", "création interdite en lecture");
    assert.strictEqual(fx.root.groups.length, 1, "aucun groupe créé en read");
    assert.strictEqual(canUndo(), false, "aucun snapshot en read");
    res = await dispatchToolCall("create_group", { title: "Block A", color: "#FF0000", x: 10, y: 20, width: 300, height: 150 }, ctx);
    assert.strictEqual(res.ok, true, "contrôle négatif in-suite : active passe");
    assert.strictEqual(fx.root.groups.length, 2, "groupe ajouté à la racine");
    const created = fx.root.groups[1];
    assert.strictEqual(created.title, "Block A");
    assert.strictEqual(created.color, "#FF0000");
    assert.deepStrictEqual(created.pos, [10, 20], "position respectée");
    assert.deepStrictEqual(created.size, [300, 150], "taille respectée");
    assert.strictEqual(res.data.id, created.id);
    assert.ok(res.snapshotId, "snapshot avant création");
    const u = await undoSnapshot(res.snapshotId, { app: fx.app });
    assert.strictEqual(u.ok, true);
    assert.strictEqual(fx.root.groups.length, 1, "undo retire le groupe créé");
    assert.strictEqual(fx.root.groups[0].title, "Existing", "groupe d'origine intact");
    res = await dispatchToolCall("create_group", { title: "X", color: "bleu" }, ctx);
    assert.strictEqual(res.code, "invalid_value", "couleur invalide → refus");
    assert.strictEqual(fx.root.groups.length, 1, "aucun groupe créé sur erreur");
    assert.strictEqual(canUndo(), false, "snapshot retiré après erreur métier");
    clearUndo();
    ok("create_group : read refusé, création réelle (titre/couleur/pos/taille), couleur validée, undo restaure");
}

// ── create_group / list_groups scopés à un subgraph ──
clearUndo();
{
    const fx = makeSubgraphFixture();
    let res = await dispatchToolCall("create_group", { title: "InnerGroup", x: 1, y: 2, subgraph: SG_ID }, { app: fx.app, mode: "active", createGroupImpl: fakeCreateGroup });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(fx.sg.groups.length, 1, "groupe créé DANS le subgraph");
    assert.strictEqual(fx.root.groups.length, 2, "racine inchangée");
    assert.strictEqual(res.data.subgraph.id, SG_ID, "scope rapporté au LLM");
    res = await dispatchToolCall("list_groups", { subgraph: SG_ID }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.data.count, 1, "list_groups scopé au subgraph");
    assert.strictEqual(res.data.groups[0].title, "InnerGroup");
    res = await dispatchToolCall("create_group", { title: "X", subgraph: "99999999-9999-4999-8999-999999999999" }, { app: fx.app, mode: "active", createGroupImpl: fakeCreateGroup });
    assert.strictEqual(res.code, "subgraph_not_found", "subgraph inconnu → refus");
    clearUndo();
    ok("create_group/list_groups : scope subgraph (groupe dans le subgraph, racine intacte)");
}

// ── edit_group : édition réelle + undo + erreurs ──
clearUndo();
{
    const fx = makeEditableFixture();
    const before = { title: fx.group.title, pos: fx.group.pos.slice(), size: fx.group.size.slice() };
    let res = await dispatchToolCall("edit_group", { group: "Existing", title: "Nope" }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.code, "mode_forbidden", "édition interdite en lecture");
    res = await dispatchToolCall("edit_group", { group: "Existing", title: "Renamed", color: "#00FF00", x: 5, y: 6, width: 320, height: 210 }, { app: fx.app, mode: "active" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(fx.group.title, "Renamed", "titre modifié");
    assert.strictEqual(fx.group.color, "#00FF00", "couleur modifiée");
    assert.deepStrictEqual(fx.group.pos, [5, 6], "position modifiée");
    assert.deepStrictEqual(fx.group.size, [320, 210], "taille modifiée");
    assert.ok(res.snapshotId, "snapshot avant édition");
    const u = await undoSnapshot(res.snapshotId, { app: fx.app });
    assert.strictEqual(u.ok, true);
    assert.strictEqual(fx.root.groups[0].title, before.title, "undo restaure le titre");
    assert.deepStrictEqual(fx.root.groups[0].pos, before.pos, "undo restaure la position");
    assert.deepStrictEqual(fx.root.groups[0].size, before.size, "undo restaure la taille");
    res = await dispatchToolCall("edit_group", { group: "Nope", title: "X" }, { app: fx.app, mode: "active" });
    assert.strictEqual(res.code, "group_not_found");
    res = await dispatchToolCall("edit_group", { group: "Existing" }, { app: fx.app, mode: "active" });
    assert.strictEqual(res.code, "invalid_args", "aucun champ → refus");
    res = await dispatchToolCall("edit_group", { group: "Existing", x: 1 }, { app: fx.app, mode: "active" });
    assert.strictEqual(res.code, "invalid_args", "x sans y → refus");
    clearUndo();
    ok("edit_group : édition titre/couleur/pos/taille, undo restaure, erreurs (inconnu/vide/partiel)");
}

// ── create_subgraph : création + instance + undo ──
clearUndo();
{
    const fx = makeEditableFixture();
    const makeInst = (sg) => {
        const n = makeNode({ id: fx.root._nextNodeId(), type: sg.id, title: sg.name, pos: [0, 0] });
        n.size = [200, 80]; n.subgraph = sg; n.isSubgraphNode = () => true;
        return n;
    };
    let res = await dispatchToolCall("create_subgraph", { name: "x" }, { app: fx.app, mode: "read", createSubgraphNodeImpl: makeInst });
    assert.strictEqual(res.code, "mode_forbidden", "création de subgraph interdite en lecture");
    res = await dispatchToolCall("create_subgraph", { name: "MySG" }, { app: fx.app, mode: "active", createSubgraphNodeImpl: makeInst });
    assert.strictEqual(res.ok, true);
    const sgId = res.data.id;
    assert.strictEqual(res.data.name, "MySG");
    assert.ok(fx.root.subgraphs.has(sgId), "définition enregistrée dans root.subgraphs");
    const inst = fx.root.nodes.find((n) => n.subgraph && String(n.subgraph.id) === String(sgId));
    assert.ok(inst, "nœud instance Subgraph ajouté au workflow");
    assert.strictEqual(res.data.node_id, inst.id);
    assert.ok(res.snapshotId, "snapshot avant création");
    const u = await undoSnapshot(res.snapshotId, { app: fx.app });
    assert.strictEqual(u.ok, true);
    assert.strictEqual(fx.root.subgraphs.has(sgId), false, "undo retire la définition");
    assert.strictEqual(fx.root.nodes.some((n) => n.subgraph && String(n.subgraph.id) === String(sgId)), false, "undo retire l'instance");
    res = await dispatchToolCall("create_subgraph", {}, { app: { graph: { nodes: [], groups: [], subgraphs: new Map(), serialize() { return { nodes: [] }; } } }, mode: "active" });
    assert.strictEqual(res.code, "subgraph_create_failed", "API createSubgraph absente → erreur structurée");
    clearUndo();
    ok("create_subgraph : read refusé, définition + instance créées, undo restaure, API absente gérée");
}

// ── convert_to_subgraph : conversion + undo + erreurs ──
clearUndo();
{
    const fx = makeEditableFixture();
    let res = await dispatchToolCall("convert_to_subgraph", { nodes: [1, 2] }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.code, "mode_forbidden", "conversion interdite en lecture");
    assert.ok(fx.root.getNodeById(1), "nœuds intacts en read");
    res = await dispatchToolCall("convert_to_subgraph", { nodes: [1, 2], name: "Chain" }, { app: fx.app, mode: "active" });
    assert.strictEqual(res.ok, true);
    const sgId = res.data.id;
    assert.strictEqual(res.data.node_count, 2);
    assert.strictEqual(res.data.name, "Chain", "nom du subgraph conservé");
    assert.ok(fx.root.subgraphs.has(sgId), "définition créée");
    assert.strictEqual(fx.root.getNodeById(1), null, "nœud 1 déplacé DANS le subgraph");
    assert.strictEqual(fx.root.getNodeById(2), null, "nœud 2 déplacé DANS le subgraph");
    assert.deepStrictEqual(fx.root.subgraphs.get(sgId).nodes.map((n) => n.id).sort(), [1, 2]);
    assert.ok(res.data.node_id, "nœud Subgraph de remplacement");
    assert.ok(res.snapshotId, "snapshot avant conversion");
    const u = await undoSnapshot(res.snapshotId, { app: fx.app });
    assert.strictEqual(u.ok, true);
    assert.ok(fx.root.getNodeById(1) && fx.root.getNodeById(2), "undo restaure les nœuds dans la racine");
    assert.strictEqual(fx.root.subgraphs.has(sgId), false, "undo retire la définition créée");
    res = await dispatchToolCall("convert_to_subgraph", { group: "Existing" }, { app: fx.app, mode: "active" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.node_count, 1, "conversion depuis un GROUPE (1 nœud)");
    clearUndo();
    // Graphe mixte refusé (racine + subgraph).
    const fxs = makeSubgraphFixture();
    res = await dispatchToolCall("convert_to_subgraph", { nodes: [1, SG_ID + ":1"] }, { app: fxs.app, mode: "active" });
    assert.strictEqual(res.code, "mixed_graph", "nœuds de graphes différents → refus");
    ok("convert_to_subgraph : read refusé, nodes/groupe convertis, undo restaure, graphe mixte refusé");
}

// ── unpack_subgraph : dépaquetage + undo ──
clearUndo();
{
    const fx = makeEditableFixture();
    const conv = await dispatchToolCall("convert_to_subgraph", { nodes: [3], name: "Tmp" }, { app: fx.app, mode: "active" });
    const instId = conv.data.node_id;
    const sgId = conv.data.id;
    clearUndo();
    let res = await dispatchToolCall("unpack_subgraph", { id: instId }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.code, "mode_forbidden", "dépaquetage interdit en lecture");
    res = await dispatchToolCall("unpack_subgraph", { id: 1 }, { app: fx.app, mode: "active" });
    assert.strictEqual(res.code, "not_subgraph", "nœud non-subgraph → refus");
    res = await dispatchToolCall("unpack_subgraph", { id: instId }, { app: fx.app, mode: "active" });
    assert.strictEqual(res.ok, true);
    assert.ok(res.data.added_count >= 1, "nœuds remontés dans le parent");
    assert.ok(fx.root.getNodeById(3), "nœud interne de retour dans la racine");
    assert.strictEqual(fx.root.nodes.some((n) => n.id === instId), false, "nœud Subgraph retiré");
    assert.ok(fx.root.subgraphs.has(sgId), "définition conservée (comportement du front)");
    assert.ok(res.snapshotId, "snapshot avant dépaquetage");
    const u = await undoSnapshot(res.snapshotId, { app: fx.app });
    assert.strictEqual(u.ok, true);
    assert.ok(fx.root.nodes.some((n) => n.id === instId && n.subgraph && String(n.subgraph.id) === String(sgId)), "undo restaure l'instance Subgraph");
    assert.strictEqual(fx.root.getNodeById(3), null, "nœud interne re-déplacé dans le subgraph");
    clearUndo();
    ok("unpack_subgraph : read refusé, nœuds remontés, instance retirée, undo restaure");
}

// ── focus_view : recadrage (nœud/lot/groupe/zone/tout) + subgraph + zoom ──
clearUndo();
{
    const fx = makeSubgraphFixture();
    let res = await dispatchToolCall("focus_view", { id: 1 }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.ok, true, "focus_view autorisé en LECTURE (action de vue)");
    assert.strictEqual(res.snapshotId, null, "AUCUN snapshot (pas une mutation)");
    assert.deepStrictEqual(fx.canvas.centerOnNodeCalls, [1], "nœud unique sans zoom → centerOnNode (mécanisme existant)");
    assert.strictEqual(res.data.via, "centerOnNode");
    res = await dispatchToolCall("focus_view", { id: 1, zoom: 2 }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.via, "offset", "zoom fourni → recentrage + échelle imposée");
    assert.strictEqual(fx.canvas.ds.scale, 2, "zoom absolu appliqué");
    res = await dispatchToolCall("focus_view", { nodes: [1, 10] }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.centered_on, "nodes");
    assert.ok(Number.isFinite(fx.canvas.ds.offset[0]) && Number.isFinite(fx.canvas.ds.offset[1]), "offset calculé pour un lot");
    res = await dispatchToolCall("focus_view", { group: "Sampling" }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.data.centered_on, "group");
    res = await dispatchToolCall("focus_view", { area: { x: 0, y: 0, width: 100, height: 50 } }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.data.centered_on, "area");
    res = await dispatchToolCall("focus_view", { area: { x: 0, y: 0, width: 0, height: 50 } }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.code, "invalid_value", "zone de taille nulle → refus");
    fx.canvas.ds.fitCalls.length = 0;
    res = await dispatchToolCall("focus_view", { all: true }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.via, "fitToBounds");
    assert.strictEqual(fx.canvas.ds.fitCalls.length, 1, "all → cadrage complet (fitToBounds)");
    assert.strictEqual(fx.canvas.ds.scale, 0.5, "échelle modifiée par le cadrage complet");
    res = await dispatchToolCall("focus_view", {}, { app: fx.app, mode: "read" });
    assert.strictEqual(res.data.centered_on, "all", "sans cible → tout le workflow");
    // Cible dans un subgraph : l'ouvre puis centre.
    fx.canvas.subgraph = null; fx.canvas.graph = fx.root; fx.canvas.centerOnNodeCalls.length = 0;
    res = await dispatchToolCall("focus_view", { id: 1, subgraph: SG_ID }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(fx.canvas.subgraph, fx.sg, "subgraph contenant la cible ouvert");
    assert.strictEqual(res.data.graph, "subgraph");
    assert.ok(fx.canvas.centerOnNodeCalls.includes(1), "nœud INTERNE centré");
    // Retour racine pour montrer un nœud racine.
    res = await dispatchToolCall("focus_view", { id: 1 }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(fx.canvas.subgraph, undefined, "retour à la racine");
    assert.strictEqual(res.data.graph, "root");
    res = await dispatchToolCall("focus_view", { id: 1, zoom: -3 }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.code, "invalid_value", "zoom négatif → refus");
    res = await dispatchToolCall("focus_view", { id: 1, all: true }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.code, "invalid_args", "deux cibles → refus");
    res = await dispatchToolCall("focus_view", { id: 1 }, { mode: "read" });
    assert.strictEqual(res.code, "no_canvas", "sans canvas → erreur structurée");
    res = await dispatchToolCall("focus_view", { id: 1 }, { mode: "read", canvas: {} });
    assert.strictEqual(res.code, "no_app", "sans app/graph → erreur structurée");
    clearUndo();
    ok("focus_view : recentrage nœud/lot/groupe/zone/tout, zoom, ouverture du subgraph, refus lecture des mutations");
}

// ── focus_view : réutilise le mécanisme holaf_shortcuts ──
{
    const fx = makeSubgraphFixture();
    const calls = [];
    fx.app.holafShortcuts = {
        findPathToGraph(target, root) { calls.push(["find", target.id, root === fx.root]); return [10]; },
        navigateToPath(p) { calls.push(["nav", p.length]); if (p.length) { fx.canvas.subgraph = fx.sg; fx.canvas.graph = fx.sg; } else { fx.canvas.subgraph = undefined; fx.canvas.graph = fx.root; } },
    };
    const res = await dispatchToolCall("focus_view", { id: 1, subgraph: SG_ID }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(calls[0].slice(0, 1), ["find"], "holaf_shortcuts.findPathToGraph utilisé");
    assert.ok(calls.some((c) => c[0] === "nav"), "holaf_shortcuts.navigateToPath utilisé");
    assert.strictEqual(res.data.via, "centerOnNode");
    assert.strictEqual(res.data.graph, "subgraph");
    delete fx.app.holafShortcuts;
    ok("focus_view : réutilise holaf_shortcuts.navigateToPath (mécanisme existant du pack)");
}

// ── select_node : sélection/surlignage en lecture + recentrage optionnel ──
clearUndo();
{
    const fx = makeSubgraphFixture();
    let res = await dispatchToolCall("select_node", { id: 1 }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.ok, true, "select_node autorisé en lecture");
    assert.strictEqual(res.snapshotId, null, "sélection = vue, aucun snapshot");
    assert.deepStrictEqual(res.data.selected, [1]);
    assert.deepStrictEqual(fx.canvas.lastSelect, [1], "nœud sélectionné sur le canvas");
    fx.canvas.centerOnNodeCalls.length = 0;
    res = await dispatchToolCall("select_node", { id: 1, center: true }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.data.centered, true);
    assert.ok(fx.canvas.centerOnNodeCalls.includes(1), "center:true recadre la vue sur la sélection");
    res = await dispatchToolCall("select_node", { group: "Sampling" }, { app: fx.app, mode: "read" });
    assert.deepStrictEqual(res.data.selected, [1], "groupe → tous ses nœuds sélectionnés");
    res = await dispatchToolCall("select_node", { clear: true }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(fx.canvas.lastSelect, [], "clear:true efface la sélection");
    res = await dispatchToolCall("select_node", {}, { app: fx.app, mode: "read" });
    assert.strictEqual(res.code, "invalid_args", "aucune cible → refus");
    fx.canvas.subgraph = null; fx.canvas.graph = fx.root;
    res = await dispatchToolCall("select_node", { id: 1, subgraph: SG_ID }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(fx.canvas.subgraph, fx.sg, "sélection d'un nœud interne : subgraph ouvert");
    clearUndo();
    ok("select_node : sélection/surlignage en lecture, recentrage optionnel, clear, ouverture subgraph");
}

// ══════════ 6quater. change_node_type + correction pos/size (Float64Array) ══
// ⚠️ BUG RÉEL corrigé ici : dans le LiteGraph récent, `node.pos`/`node.size`
// (et ceux d'un groupe) sont des Float64Array (Rectangle.subarray), PAS des
// Array → `Array.isArray()` renvoie false et l'ancien code produisait `null`.
console.log("\n6quater. change_node_type + correction pos/size (Float64Array LiteGraph)");

// Fixture dédiée au retype : liens ENREGISTRÉS (graph.links) + pos/size en
// Float64Array (comme le LiteGraph réel), serialize()/loadGraphData() qui font
// un VRAI aller-retour nœuds+liens (pour tester l'undo).
function makeRetypeFixture() {
    const DEF = {
        1: { id: 1, type: "LegacyNode", title: "Mon titre", pos: [10, 20], size: [120, 80], mode: 4,
             color: "#FF8F00", bgcolor: "#222",
             widgets: [{ name: "steps", type: "number", value: 20 }, { name: "seed", type: "number", value: 5 }],
             inputs: [{ name: "model", type: "MODEL", link: 501 }, { name: "control", type: "CONTROL", link: 503 }, { name: "vae_alias", type: "VAE", link: 504 }],
             outputs: [{ name: "IMAGE", type: "IMAGE", links: [502] }] },
        2: { id: 2, type: "CheckpointLoader", pos: [0, 0], size: [100, 50], outputs: [{ name: "MODEL", type: "MODEL", links: [501] }] },
        3: { id: 3, type: "SaveImage", pos: [400, 0], size: [100, 50], inputs: [{ name: "images", type: "IMAGE", link: 502 }] },
        4: { id: 4, type: "VAELoader", pos: [0, 200], size: [100, 50], outputs: [{ name: "VAE", type: "VAE", links: [504] }] },
        5: { id: 5, type: "ControlNetLoader", pos: [0, 400], size: [100, 50], outputs: [{ name: "CONTROL", type: "CONTROL", links: [503] }] },
    };
    const LINKS = {
        501: { id: 501, origin_id: 2, origin_slot: 0, target_id: 1, target_slot: 0, type: "MODEL" },
        502: { id: 502, origin_id: 1, origin_slot: 0, target_id: 3, target_slot: 0, type: "IMAGE" },
        503: { id: 503, origin_id: 5, origin_slot: 0, target_id: 1, target_slot: 1, type: "CONTROL" },
        504: { id: 504, origin_id: 4, origin_slot: 0, target_id: 1, target_slot: 2, type: "VAE" },
    };
    const buildNode = (d) => {
        const n = makeNode({
            id: d.id, type: d.type, title: d.title, pos: d.pos, mode: d.mode,
            widgets: (d.widgets || []).map((w) => ({ name: w.name, type: w.type, value: w.value })),
        });
        n.color = d.color; n.bgcolor = d.bgcolor;
        n.pos = new Float64Array(d.pos || [0, 0]);
        n.size = new Float64Array(d.size || [100, 50]);
        n.inputs = (d.inputs || []).map((i) => ({ name: i.name, type: i.type, link: i.link === undefined ? null : i.link }));
        n.outputs = (d.outputs || []).map((o) => ({ name: o.name, type: o.type, links: (o.links || []).slice() }));
        return n;
    };
    const root = {
        id: "root", _nodes: [], links: {}, _groups: [], subgraphs: new Map(), rootGraph: null,
        get nodes() { return this._nodes; },
        set nodes(v) { this._nodes = v; },
        getNodeById(id) { return this._nodes.find((n) => String(n.id) === String(id)) || null; },
        setDirtyCanvas() {}, change() {},
        serialize() {
            return {
                version: 1,
                nodes: this._nodes.map((n) => ({
                    id: n.id, type: n.type, title: n.title,
                    pos: [n.pos[0], n.pos[1]], size: [n.size[0], n.size[1]], mode: n.mode,
                    color: n.color, bgcolor: n.bgcolor,
                    widgets: (n.widgets || []).map((w) => ({ name: w.name, type: w.type, value: w.value })),
                    inputs: (n.inputs || []).map((i) => ({ name: i.name, type: i.type, link: i.link })),
                    outputs: (n.outputs || []).map((o) => ({ name: o.name, type: o.type, links: (o.links || []).slice() })),
                })),
                links: Object.keys(this.links).map((k) => Object.assign({}, this.links[k])),
            };
        },
        loadGraphData(data) {
            this.links = {};
            (data.links || []).forEach((l) => { this.links[l.id] = Object.assign({}, l); });
            this._nodes = (data.nodes || []).map((d) => {
                const n = buildNode(d);
                n.graph = this;
                return n;
            });
            return Promise.resolve();
        },
    };
    for (const d of Object.values(DEF)) { const n = buildNode(d); n.graph = root; root._nodes.push(n); }
    Object.assign(root.links, LINKS);
    root.rootGraph = root;
    const app = { graph: root, rootGraph: root, canvas: { setDirtyCanvas() {} }, loadGraphData(data) { return root.loadGraphData(data); } };
    return { app, root, LINKS };
}

function makeNewNode() {
    const n = makeNode({
        id: 77, type: "NewNode", title: "NewNode", pos: [0, 0],
        widgets: [{ name: "steps", type: "number", value: 0 }],
        inputs: [{ name: "model", type: "MODEL" }, { name: "vae", type: "VAE" }],
        outputs: [{ name: "IMAGE", type: "IMAGE" }, { name: "LATENT", type: "LATENT" }],
    });
    n.size = [210, 100];
    return n;
}

// ── (H1) pos/size en Float64Array : jamais null + erreur claire si absente ──
{
    const fx = makeRetypeFixture();
    let res = await dispatchToolCall("get_node_position", { id: 1 }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.data.pos, [10, 20], "get_node_position : pos [x,y] (Float64Array lu)");
    assert.deepStrictEqual(res.data.size, [120, 80], "get_node_position : size [w,h]");
    assert.strictEqual(res.data.type, "LegacyNode");
    assert.strictEqual(res.data.title, "Mon titre");
    assert.strictEqual(res.snapshotId, null, "lecture : aucun snapshot");
    res = await dispatchToolCall("list_nodes", {}, { app: fx.app, mode: "read" });
    const ln1 = res.data.find((x) => x.id === 1);
    assert.deepStrictEqual(ln1.pos, [10, 20], "list_nodes : pos non nulle pour un Float64Array");
    res = await dispatchToolCall("get_node_by_id", { id: 1 }, { app: fx.app, mode: "read" });
    assert.deepStrictEqual(res.data.pos, [10, 20], "get_node_by_id : pos non nulle");
    assert.deepStrictEqual(res.data.size, [120, 80], "get_node_by_id : size en tableau");
    assert.ok(Array.isArray(res.data.size), "size sérialisable en tableau JSON (pas un typed array brut)");
    res = await dispatchToolCall("get_node_position", { id: 999 }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, "not_found", "cible inexistante → erreur claire (pas de null silencieux)");
    ok("(H1) get_node_position/list_nodes/get_node_by_id : pos & size (Float64Array) non nuls + erreur claire si absente");
}

// ── (H2) root + subgraph + locator uuid:id (pos en Float64Array) ──
{
    const fx = makeSubgraphFixture();
    fx.inner1.pos = new Float64Array([5, 6]);
    fx.inner1.size = new Float64Array([210, 100]);
    let res = await dispatchToolCall("get_node_position", { id: 1, subgraph: SG_ID }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.data.pos, [5, 6], "subgraph : pos lue (Float64Array)");
    assert.deepStrictEqual(res.data.size, [210, 100]);
    res = await dispatchToolCall("get_node_position", { id: SG_ID + ":1" }, { app: fx.app, mode: "read" });
    assert.strictEqual(res.ok, true, "locator uuid:id résolu");
    assert.deepStrictEqual(res.data.pos, [5, 6], "locator uuid:id : pos lue");
    res = await dispatchToolCall("get_node_position", { id: 7, subgraph: SG2_ID }, { app: fx.app, mode: "read" });
    assert.deepStrictEqual(res.data.pos, [1, 2], "sous-subgraph : pos lue");
    ok("(H2) get_node_position : racine + subgraph + locator uuid:id (Float64Array), taille renvoyée");
}

// ── (I0) l'outil est ABSENT de la liste read et présent en actif ──
{
    const readNames = getToolsForMode("read").map((x) => x.function.name);
    const activeNames = getToolsForMode("active").map((x) => x.function.name);
    assert.ok(!readNames.includes("change_node_type"), "change_node_type ABSENT de la liste Lecture seule");
    assert.ok(activeNames.includes("change_node_type"), "change_node_type présent en mode Actif");
    ok("(I0) change_node_type : absent en Lecture seule, présent en Actif");
}

// ── (I1) retype : préservation + liens + widgets perdus + undo ──
{
    clearUndo();
    const fx = makeRetypeFixture();
    let res0 = await dispatchToolCall("change_node_type", { id: 1, type: "NewNode" }, { app: fx.app, mode: "read", createNodeImpl: () => makeNewNode() });
    assert.strictEqual(res0.code, "mode_forbidden", "retypage interdit en Lecture seule");
    assert.strictEqual(fx.root.getNodeById(1).type, "LegacyNode", "type intact en read");
    assert.strictEqual(canUndo(), false, "aucun snapshot poussé en read");
    const res = await dispatchToolCall("change_node_type", { id: 1, type: "NewNode" }, { app: fx.app, mode: "active", createNodeImpl: () => makeNewNode() });
    assert.strictEqual(res.ok, true, "contrôle négatif in-suite : active passe");
    assert.ok(res.snapshotId, "snapshot avant retype (annulable)");
    const n1 = fx.root.getNodeById(1);
    assert.ok(n1, "le nœud (id conservé) est toujours dans le graphe");
    assert.strictEqual(n1.type, "NewNode", "classe changée EN PLACE");
    assert.deepStrictEqual(n1.pos, [10, 20], "position préservée");
    assert.deepStrictEqual(n1.size, [120, 80], "taille préservée");
    assert.strictEqual(n1.title, "Mon titre", "titre personnalisé préservé");
    assert.strictEqual(n1.color, "#FF8F00", "couleur préservée");
    assert.strictEqual(n1.bgcolor, "#222", "couleur de fond préservée");
    assert.strictEqual(n1.mode, 4, "mode (bypass) préservé");
    assert.strictEqual(res.data.kept.mode_name, "bypass");
    assert.strictEqual(res.data.links_reconnected, 3, "3 liens recâblés (MODEL nom + VAE type + IMAGE nom)");
    assert.strictEqual(res.data.links_lost, 1, "1 lien perdu (CONTROL sans équivalent)");
    assert.strictEqual(n1.inputs.find((i) => i.name === "model").link, 501, "MODEL recâblé par NOM");
    assert.strictEqual(n1.inputs.find((i) => i.name === "vae").link, 504, "VAE recâblé par TYPE (vae_alias → vae)");
    assert.strictEqual(n1.outputs.find((o) => o.name === "IMAGE").links[0], 502, "IMAGE recâblé par NOM");
    assert.strictEqual(fx.root.links[501].target_id, 1, "lien 501 pointe sur le nœud retypé");
    assert.strictEqual(fx.root.links[504].target_slot, 1, "lien 504 pointe sur le slot vae");
    assert.strictEqual(fx.root.links[502].origin_id, 1, "lien de sortie 502 : origine = nœud retypé");
    assert.ok(fx.root.getNodeById(2).outputs[0].links.indexOf(501) >= 0, "source MODEL inchangée");
    assert.strictEqual(fx.root.links[503], undefined, "lien CONTROL détaché du graphe (jamais orphelin)");
    assert.deepStrictEqual(fx.root.getNodeById(5).outputs[0].links, [], "sortie source CONTROL nettoyée");
    assert.deepStrictEqual(res.data.lost_inputs, ["control"], "slot d'entrée non transférable listé");
    assert.deepStrictEqual(res.data.lost_outputs, [], "aucune sortie perdue");
    assert.ok(res.data.lost_widgets.some((w) => w.name === "seed"), "widget perdu listé (seed)");
    assert.strictEqual(res.data.widgets_copied, 1, "widget steps recopié");
    assert.ok(res.action.includes("LegacyNode") && res.action.includes("NewNode"), `ligne d'action : ${res.action}`);
    const u = await undoSnapshot(res.snapshotId, { app: fx.app });
    assert.strictEqual(u.ok, true, "undo via loadGraphData");
    const back = fx.root.getNodeById(1);
    assert.strictEqual(back.type, "LegacyNode", "undo restaure la classe précédente");
    assert.ok(fx.root.links[503], "undo restaure le lien CONTROL");
    assert.strictEqual(back.inputs.find((i) => i.name === "control").link, 503, "undo restaure l'entrée control");
    assert.strictEqual(back.inputs.find((i) => i.name === "model").link, 501, "undo restaure l'entrée model");
    assert.strictEqual(back.outputs.find((o) => o.name === "IMAGE").links[0], 502, "undo restaure la sortie IMAGE");
    clearUndo();
    ok("(I1) change_node_type : pos/taille/titre/couleur/mode préservés, liens recâblés (nom+type), perdus listés, undo restaure type & liens");
}

// ── (I2) même type (no-op), classe inconnue, nœud inexistant, type manquant ──
{
    clearUndo();
    const fx = makeRetypeFixture();
    let used = 0;
    const mkNew = () => { used++; return makeNewNode(); };
    let res = await dispatchToolCall("change_node_type", { id: 1, type: "LegacyNode" }, { app: fx.app, mode: "active", createNodeImpl: mkNew });
    assert.strictEqual(res.ok, true, "même type → succès (no-op)");
    assert.strictEqual(res.data.noop, true, "no-op signalé");
    assert.strictEqual(res.data.changed, false);
    assert.strictEqual(used, 0, "aucune création de nœud pour un no-op");
    assert.strictEqual(fx.root.getNodeById(1).type, "LegacyNode", "type inchangé");
    res = await dispatchToolCall("change_node_type", { id: 1, type: "DoesNotExist" }, { app: fx.app, mode: "active", createNodeImpl: () => null });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, "class_unknown", "classe inexistante → erreur claire");
    assert.ok(res.error.includes("get_object_info"), "message oriente vers get_object_info");
    assert.strictEqual(fx.root.getNodeById(1).type, "LegacyNode", "type intact après erreur");
    res = await dispatchToolCall("change_node_type", { id: 999, type: "NewNode" }, { app: fx.app, mode: "active", createNodeImpl: mkNew });
    assert.strictEqual(res.code, "not_found", "nœud inexistant → erreur claire");
    res = await dispatchToolCall("change_node_type", { id: 1 }, { app: fx.app, mode: "active", createNodeImpl: mkNew });
    assert.strictEqual(res.code, "invalid_args", "type manquant → erreur");
    clearUndo();
    ok("(I2) change_node_type : même type = no-op signalé ; classe inconnue & nœud inexistant & type manquant = erreurs claires");
}

// ── (I3) retype DANS un subgraph (paramètre subgraph + locator uuid:id) ──
{
    clearUndo();
    const fx = makeSubgraphFixture();
    fx.inner1.pos = new Float64Array([5, 6]);
    fx.inner1.size = new Float64Array([210, 100]);
    let res = await dispatchToolCall("change_node_type", { id: 1, type: "NewInner", subgraph: SG_ID }, {
        app: fx.app, mode: "active",
        createNodeImpl: () => makeNode({ id: 55, type: "NewInner", title: "NewInner", pos: [0, 0], widgets: [{ name: "steps", type: "number", value: 0 }] }),
    });
    assert.strictEqual(res.ok, true, "retype DANS le subgraph");
    assert.strictEqual(res.data.subgraph.id, SG_ID, "scope rapporté");
    const inner = fx.sg.getNodeById(1);
    assert.strictEqual(inner.type, "NewInner", "type interne changé en place");
    assert.deepStrictEqual(inner.pos, [5, 6], "position interne préservée (Float64Array)");
    assert.strictEqual(fx.root.getNodeById(1).type, "CheckpointLoaderSimple", "racine intacte (id 1 = racine)");
    const fx2 = makeSubgraphFixture();
    const res2 = await dispatchToolCall("change_node_type", { id: SG_ID + ":1", type: "NewInner2" }, {
        app: fx2.app, mode: "active",
        createNodeImpl: () => makeNode({ id: 56, type: "NewInner2", title: "NewInner2", pos: [0, 0], widgets: [] }),
    });
    assert.strictEqual(res2.ok, true, "locator uuid:id résolu");
    assert.strictEqual(fx2.sg.getNodeById(1).type, "NewInner2");
    clearUndo();
    ok("(I3) change_node_type : fonctionne DANS un subgraph (subgraph + locator uuid:id), racine intacte");
}

// ══════ 6quinquies. change_node_type : ÉTAT RÉEL DU GRAPHE (pas un compteur) ══
// On vérifie, pour CHAQUE lien d'origine, les 5 invariants d'état : (i) le lien
// existe dans graph.links, (ii) origine/cible + slots pointent la NOUVELLE node,
// (iii) la nouvelle node a ses références dans inputs[k].link / outputs[j].links,
// (iv) aucune référence PENDANTE ne subsiste (slots ↔ registre cohérents), (v)
// l'ancienne node est retirée. Fixture à liens en Map (forme du frontend récent)
// pour coller au LiteGraph réel (outputs[].links peut être null).

/** Nouvelle node de test (slots déclarés ; links null comme le vrai LiteGraph). */
function makeNewNodeOf({ id = 99, inputs = [], outputs = [], widgets = [] } = {}) {
    const n = makeNode({ id, type: "New", title: "New", pos: [0, 0], widgets });
    n.size = [210, 100];
    n.inputs = inputs.map((i) => ({ name: i.name, type: i.type, link: null }));
    n.outputs = outputs.map((o) => ({ name: o.name, type: o.type, links: null }));
    return n;
}

/** Graphe à liens en Map (forme frontend) + serialize()/loadGraphData() réels. */
function makeMapRetypeFixture(nodeDefs, linkList) {
    const buildNode = (d) => {
        const n = makeNode({
            id: d.id, type: d.type, title: d.title, pos: d.pos, mode: d.mode,
            widgets: (d.widgets || []).map((w) => ({ name: w.name, type: w.type, value: w.value })),
        });
        n.color = d.color; n.bgcolor = d.bgcolor;
        n.pos = new Float64Array(d.pos || [0, 0]);
        n.size = new Float64Array(d.size || [100, 50]);
        n.inputs = (d.inputs || []).map((i) => ({ name: i.name, type: i.type, link: i.link === undefined ? null : i.link }));
        n.outputs = (d.outputs || []).map((o) => ({ name: o.name, type: o.type, links: o.links === undefined || o.links === null ? null : o.links.slice() }));
        return n;
    };
    const root = {
        id: "root", _nodes: [], _nodes_by_id: {}, links: new Map(), _groups: [], subgraphs: new Map(), rootGraph: null,
        get nodes() { return this._nodes; },
        set nodes(v) { this._nodes = v; },
        getNodeById(id) { return this._nodes.find((n) => String(n.id) === String(id)) || null; },
        setDirtyCanvas() {}, change() {}, updateExecutionOrder() {},
        serialize() {
            return {
                version: 1,
                nodes: this._nodes.map((n) => ({
                    id: n.id, type: n.type, title: n.title,
                    pos: [n.pos[0], n.pos[1]], size: [n.size[0], n.size[1]], mode: n.mode,
                    color: n.color, bgcolor: n.bgcolor,
                    widgets: (n.widgets || []).map((w) => ({ name: w.name, type: w.type, value: w.value })),
                    inputs: (n.inputs || []).map((i) => ({ name: i.name, type: i.type, link: i.link })),
                    outputs: (n.outputs || []).map((o) => ({ name: o.name, type: o.type, links: o.links ? o.links.slice() : null })),
                })),
                links: [...this.links.values()].map((l) => ({ ...l })),
            };
        },
        loadGraphData(data) {
            this.links = new Map();
            (data.links || []).forEach((l) => this.links.set(l.id, { ...l }));
            this._nodes = (data.nodes || []).map((d) => { const n = buildNode(d); n.graph = this; return n; });
            this._nodes_by_id = {};
            this._nodes.forEach((n) => { this._nodes_by_id[n.id] = n; });
            return Promise.resolve();
        },
    };
    for (const d of nodeDefs) { const n = buildNode(d); n.graph = root; root._nodes.push(n); root._nodes_by_id[n.id] = n; }
    for (const l of linkList) root.links.set(l.id, { ...l });
    root.rootGraph = root;
    const app = { graph: root, rootGraph: root, canvas: { setDirtyCanvas() {} }, loadGraphData(data) { return root.loadGraphData(data); } };
    return { app, root };
}

/**
 * Invariants d'état de graphe (renvoie la liste des problèmes, [] = cohérent).
 * spec.kept : { <linkId>: { origin:'new'|'other', origin_id?, origin_slot?, target:'new'|'other', target_id?, target_slot? } }
 * spec.gone : [ linkId, ... ] liens qui DOIVENT avoir disparu partout.
 */
function graphStateProblems(g, newNodeId, spec) {
    const problems = [];
    const newNode = g.getNodeById(newNodeId);
    if (!newNode) return ["nouvelle node absente du graphe"];
    const refCount = new Map();
    for (const n of g.nodes) {
        for (const i of n.inputs || []) if (i.link !== null && i.link !== undefined) refCount.set(String(i.link), (refCount.get(String(i.link)) || 0) + 1);
        for (const o of n.outputs || []) for (const lid of o.links || []) if (lid !== null && lid !== undefined) refCount.set(String(lid), (refCount.get(String(lid)) || 0) + 1);
    }
    for (const [lid, exp] of Object.entries(spec.kept || {})) {
        const link = g.links.get(Number(lid)) || g.links.get(lid);
        if (!link) { problems.push(`lien ${lid} absent de graph.links`); continue; }
        if (exp.origin === "new" && String(link.origin_id) !== String(newNodeId)) problems.push(`lien ${lid}: origin_id=${link.origin_id} ≠ ${newNodeId}`);
        if (exp.target === "new" && String(link.target_id) !== String(newNodeId)) problems.push(`lien ${lid}: target_id=${link.target_id} ≠ ${newNodeId}`);
        if (exp.origin_slot !== undefined && Number(link.origin_slot) !== exp.origin_slot) problems.push(`lien ${lid}: origin_slot=${link.origin_slot} ≠ ${exp.origin_slot}`);
        if (exp.target_slot !== undefined && Number(link.target_slot) !== exp.target_slot) problems.push(`lien ${lid}: target_slot=${link.target_slot} ≠ ${exp.target_slot}`);
        if (exp.target === "new") {
            const s = newNode.inputs[exp.target_slot];
            if (!s || String(s.link) !== String(lid)) problems.push(`nouvelle node : inputs[${exp.target_slot}].link=${s && s.link} ≠ ${lid}`);
        }
        if (exp.origin === "new") {
            const s = newNode.outputs[exp.origin_slot];
            if (!s || !(s.links || []).some((x) => String(x) === String(lid))) problems.push(`nouvelle node : outputs[${exp.origin_slot}].links ne contient pas ${lid}`);
        }
        if (exp.origin === "other") {
            const src = g.getNodeById(exp.origin_id);
            if (!src || !(src.outputs || []).some((o) => (o.links || []).some((x) => String(x) === String(lid)))) problems.push(`lien ${lid}: sortie source (node ${exp.origin_id}) ne référence plus le lien`);
        }
        if (exp.target === "other") {
            const tgt = g.getNodeById(exp.target_id);
            if (!tgt || !(tgt.inputs || []).some((i) => String(i.link) === String(lid))) problems.push(`lien ${lid}: entrée cible (node ${exp.target_id}) ne référence plus le lien`);
        }
    }
    for (const [lid] of refCount) {
        if (!g.links.get(Number(lid)) && !g.links.get(lid)) problems.push(`RÉFÉRENCE PENDANTE : linkId ${lid} référencé par un slot mais absent de graph.links`);
    }
    for (const lid of spec.gone || []) {
        if (g.links.get(Number(lid)) || g.links.get(lid)) problems.push(`lien ${lid} (sans équivalent) toujours dans graph.links`);
        if (refCount.has(String(lid))) problems.push(`lien ${lid} encore référencé quelque part (devrait être détaché partout)`);
    }
    return problems;
}

/**
 * Fixture SUBGRAPH RÉALISTE (corrige la simplification de l'ancienne fixture) :
 *   - chaque graphe (RACINE, subgraph, subgraph IMBRIQUÉ) a SON PROPRE registre
 *     de liens `_links` (Map), comme `Subgraph extends LGraph` de la référence ;
 *   - les nœuds d'I/O du subgraph (-10/-20) ne sont PAS dans `subgraph.nodes`
 *     (modèle RÉEL) : leurs liens vivent dans `linkIds` des slots exposés par
 *     `subgraph.inputs` / `subgraph.outputs` ;
 *   - un lien de FRONTIÈRE (nœud interne → nœud d'I/O) est posé ;
 *   - un subgraph IMBRIQUÉ est instancié (nœud 20 dans sg) ;
 *   - serialize()/loadGraphData() font un vrai aller-retour racine +
 *     definitions.subgraphs (liens inclus) ⇒ l'undo restaure aussi les liens
 *     internes.
 * Retourne { app, root, sg, sg2, inst }.
 */
function makeRealSubgraphWorld() {
    const mk = (o) => {
        const n = makeNode({ id: o.id, type: o.type, title: o.title, pos: [0, 0], mode: o.mode });
        n.size = new Float64Array(o.size || [100, 60]);
        n.pos = new Float64Array(o.pos || [0, 0]);
        n.inputs = (o.inputs || []).map((i) => ({ name: i.name, type: i.type, link: i.link === undefined ? null : i.link }));
        n.outputs = (o.outputs || []).map((x) => ({ name: x.name, type: x.type, links: x.links ? x.links.slice() : [] }));
        n.widgets = (o.widgets || []).map((w) => ({ name: w.name, type: w.type, value: w.value }));
        return n;
    };
    const makeGraph = (id, name, rootGraph) => {
        const g = {
            id, name, _links: new Map(), _nodes: [], _nodes_by_id: {}, _groups: [],
            get nodes() { return this._nodes; },
            set nodes(v) { this._nodes = v; },
            get isRootGraph() { return this === this.rootGraph; },
            rootGraph,
            getNodeById(nid) { return this._nodes_by_id[nid] || this._nodes.find((n) => String(n.id) === String(nid)) || null; },
            add(n) { n.graph = this; this._nodes.push(n); this._nodes_by_id[n.id] = n; return n; },
            setDirtyCanvas() {}, change() {}, updateExecutionOrder() {},
        };
        // `links` = accesseur du registre PROPRE au graphe (Map), comme le vrai
        // `LGraph.links` (Proxy sur `_links`).
        Object.defineProperty(g, "links", { get() { return this._links; } });
        return g;
    };
    const serialNode = (n) => ({ id: n.id, type: n.type, title: n.title, mode: n.mode,
        pos: [n.pos[0], n.pos[1]], size: [n.size[0], n.size[1]],
        inputs: (n.inputs || []).map((i) => ({ name: i.name, type: i.type, link: i.link })),
        outputs: (n.outputs || []).map((o) => ({ name: o.name, type: o.type, links: o.links ? o.links.slice() : [] })),
        widgets: (n.widgets || []).map((w) => ({ name: w.name, type: w.type, value: w.value })) });
    const restoreNode = (d) => mk({ id: d.id, type: d.type, title: d.title, mode: d.mode, pos: d.pos,
        size: d.size, inputs: d.inputs, outputs: d.outputs, widgets: d.widgets });
    const restoreLinks = (sd) => new Map((sd.links || []).map((l) => [l.id, { ...l }]));

    const root = makeGraph("root", "root", null);
    root.rootGraph = root;
    root.subgraphs = new Map();
    // sg2 (IMBRIQUÉ) : 6 Load → 7 Scale → 8 Save
    const sg2 = makeGraph(SG2_ID, "Nested Blueprint", root);
    // sg : 30 Load → 1 Legacy → 31 Save, + frontière I/O, + instance de sg2 (20)
    const sg = makeGraph(SG_ID, "Upscale Chain", root);

    sg2.add(mk({ id: 6, type: "Load", outputs: [{ name: "IMAGE", type: "IMAGE", links: [401] }] }));
    sg2.add(mk({ id: 7, type: "ImageScale", inputs: [{ name: "image", type: "IMAGE", link: 401 }], outputs: [{ name: "IMAGE", type: "IMAGE", links: [402] }] }));
    sg2.add(mk({ id: 8, type: "Save", inputs: [{ name: "images", type: "IMAGE", link: 402 }] }));
    sg2._links.set(401, { id: 401, origin_id: 6, origin_slot: 0, target_id: 7, target_slot: 0, type: "IMAGE" });
    sg2._links.set(402, { id: 402, origin_id: 7, origin_slot: 0, target_id: 8, target_slot: 0, type: "IMAGE" });

    const inner30 = mk({ id: 30, type: "Load", outputs: [{ name: "MODEL", type: "MODEL", links: [201] }] });
    const inner1 = mk({ id: 1, type: "Legacy", title: "Legacy",
        inputs: [{ name: "model", type: "MODEL", link: 201 }, { name: "image", type: "IMAGE", link: 200 }],
        outputs: [{ name: "IMAGE", type: "IMAGE", links: [202, 203] }] });
    const inner31 = mk({ id: 31, type: "Save", inputs: [{ name: "images", type: "IMAGE", link: 202 }] });
    const nestedInst = mk({ id: 20, type: SG2_ID, title: "Nested Blueprint", pos: [300, 0] });
    nestedInst.subgraph = sg2; nestedInst.isSubgraphNode = () => true;
    sg.add(inner30); sg.add(inner1); sg.add(inner31); sg.add(nestedInst);
    sg._links.set(200, { id: 200, origin_id: -10, origin_slot: 0, target_id: 1, target_slot: 1, type: "IMAGE" });
    sg._links.set(201, { id: 201, origin_id: 30, origin_slot: 0, target_id: 1, target_slot: 0, type: "MODEL" });
    sg._links.set(202, { id: 202, origin_id: 1, origin_slot: 0, target_id: 31, target_slot: 0, type: "IMAGE" });
    sg._links.set(203, { id: 203, origin_id: 1, origin_slot: 0, target_id: -20, target_slot: 0, type: "IMAGE" });
    // Slots d'I/O du subgraph (nœuds -10/-20 hors `sg.nodes`, comme le vrai modèle).
    sg.inputs = [{ name: "image", type: "IMAGE", displayName: "image", linkIds: [200] }];
    sg.outputs = [{ name: "image", type: "IMAGE", displayName: "image", linkIds: [203] }];
    sg.inputNode = { id: -10, slots: sg.inputs };
    sg.outputNode = { id: -20, slots: sg.outputs };

    const inst = mk({ id: 10, type: SG_ID, title: "Upscale Chain", pos: [100, 100] });
    inst.subgraph = sg; inst.isSubgraphNode = () => true;
    inst.outputs = [{ name: "IMAGE", type: "IMAGE", links: [901] }];
    root.add(inst);
    root.add(mk({ id: 40, type: "Preview", inputs: [{ name: "images", type: "IMAGE", link: 901 }] }));
    root._links.set(901, { id: 901, origin_id: 10, origin_slot: 0, target_id: 40, target_slot: 0, type: "IMAGE" });
    root.subgraphs.set(SG_ID, sg);
    root.subgraphs.set(SG2_ID, sg2);

    root.serialize = function () {
        return { version: 1, nodes: this._nodes.map(serialNode), links: [...this._links.values()].map((l) => ({ ...l })),
            definitions: { subgraphs: [sg, sg2].map((s) => ({ id: s.id, name: s.name, nodes: s._nodes.map(serialNode), links: [...s._links.values()].map((l) => ({ ...l })) })) } };
    };
    root.loadGraphData = function (d) {
        for (const sd of (d.definitions && d.definitions.subgraphs) || []) {
            const s = this.subgraphs.get(sd.id); if (!s) continue;
            s._links = restoreLinks(sd);
            s._nodes = (sd.nodes || []).map(restoreNode);
            s._nodes_by_id = {}; s._nodes.forEach((n) => { s._nodes_by_id[n.id] = n; n.graph = s; });
        }
        this._links = new Map((d.links || []).map((l) => [l.id, { ...l }]));
        this._nodes = (d.nodes || []).map(restoreNode);
        this._nodes_by_id = {}; this._nodes.forEach((n) => { this._nodes_by_id[n.id] = n; n.graph = this; });
        return Promise.resolve();
    };
    const app = { graph: root, rootGraph: root, canvas: { setDirtyCanvas() {} }, loadGraphData: (d) => root.loadGraphData(d) };
    return { app, root, sg, sg2, inst };
}

/** Liens d'un graphe sous forme lisible « id:orig[slot]->target[slot] ». */
function realLinks(g) { return [...g._links.values()].map((l) => `${l.id}:${l.origin_id}[${l.origin_slot}]->${l.target_id}[${l.target_slot}]`).join(", "); }

// ── (I4) entrées ET sorties, sortie multi-liens, node au milieu d'une chaîne ──
{
    clearUndo();
    const fx = makeMapRetypeFixture(
        [
            { id: 10, type: "Loader", outputs: [{ name: "MODEL", type: "MODEL", links: [101] }] },
            { id: 11, type: "Loader2", outputs: [{ name: "MODEL", type: "MODEL", links: [102] }] },
            { id: 1, type: "Legacy", title: "T", pos: [5, 6],
              inputs: [{ name: "model", type: "MODEL", link: 101 }, { name: "model2", type: "MODEL", link: 102 }],
              outputs: [{ name: "IMAGE", type: "IMAGE", links: [103, 104] }] },
            { id: 20, type: "Saver", inputs: [{ name: "images", type: "IMAGE", link: 103 }] },
            { id: 21, type: "Saver2", inputs: [{ name: "images", type: "IMAGE", link: 104 }] },
        ],
        [
            { id: 101, origin_id: 10, origin_slot: 0, target_id: 1, target_slot: 0, type: "MODEL" },
            { id: 102, origin_id: 11, origin_slot: 0, target_id: 1, target_slot: 1, type: "MODEL" },
            { id: 103, origin_id: 1, origin_slot: 0, target_id: 20, target_slot: 0, type: "IMAGE" },
            { id: 104, origin_id: 1, origin_slot: 0, target_id: 21, target_slot: 0, type: "IMAGE" },
        ],
    );
    const res = await dispatchToolCall("change_node_type", { id: 1, type: "New" }, {
        app: fx.app, mode: "active",
        createNodeImpl: () => makeNewNodeOf({ inputs: [{ name: "model", type: "MODEL" }, { name: "model2", type: "MODEL" }], outputs: [{ name: "IMAGE", type: "IMAGE" }] }),
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.links_reconnected, 4, "4 liens conservés");
    assert.strictEqual(res.data.links_lost, 0, "aucun lien perdu (slots équivalents)");
    const problems = graphStateProblems(fx.root, 1, {
        kept: {
            101: { origin: "other", origin_id: 10, target: "new", target_slot: 0 },
            102: { origin: "other", origin_id: 11, target: "new", target_slot: 1 },
            103: { origin: "new", origin_slot: 0, target: "other", target_id: 20 },
            104: { origin: "new", origin_slot: 0, target: "other", target_id: 21 },
        },
    });
    assert.deepStrictEqual(problems, [], `état de graphe (I4) : ${problems.join(" | ")}`);
    assert.strictEqual(fx.root.nodes.filter((n) => String(n.id) === "1").length, 1, "ancienne node retirée (une seule node d'id 1)");
    ok("(I4) milieu de chaîne + sortie multi-liens : 4 liens conservés, origine/cible/slots corrects, zéro pendant");
}

// ── (I5) slots incompatibles : perte LÉGITIME, détachement PROPRE, message non alarmant ──
{
    clearUndo();
    const fx = makeMapRetypeFixture(
        [
            { id: 10, type: "Loader", outputs: [{ name: "MODEL", type: "MODEL", links: [101] }] },
            { id: 11, type: "Control", outputs: [{ name: "CONTROL", type: "CONTROL", links: [102] }] },
            { id: 1, type: "Legacy", inputs: [{ name: "model", type: "MODEL", link: 101 }, { name: "ctrl", type: "CONTROL", link: 102 }] },
        ],
        [
            { id: 101, origin_id: 10, origin_slot: 0, target_id: 1, target_slot: 0, type: "MODEL" },
            { id: 102, origin_id: 11, origin_slot: 0, target_id: 1, target_slot: 1, type: "CONTROL" },
        ],
    );
    const res = await dispatchToolCall("change_node_type", { id: 1, type: "New" }, {
        app: fx.app, mode: "active",
        createNodeImpl: () => makeNewNodeOf({ inputs: [{ name: "model", type: "MODEL" }] }),
    });
    assert.strictEqual(res.data.links_reconnected, 1, "1 lien compatible conservé");
    assert.strictEqual(res.data.links_lost, 1, "1 lien sans équivalent détaché");
    assert.deepStrictEqual(res.data.lost_inputs, ["ctrl"]);
    const problems = graphStateProblems(fx.root, 1, {
        kept: { 101: { origin: "other", origin_id: 10, target: "new", target_slot: 0 } },
        gone: [102],
    });
    assert.deepStrictEqual(problems, [], `état de graphe (I5) : ${problems.join(" | ")}`);
    assert.strictEqual(typeof res.data.notice, "string", "notice présent dans le résultat");
    assert.ok(/conserv/.test(res.data.notice) && /détach/.test(res.data.notice), `notice distingue conservé/détaché : ${res.data.notice}`);
    ok("(I5) slots incompatibles : perte légitime détachée proprement (102 retiré partout) + message non alarmant");
}

// ── (I6) retype DANS un subgraph : liens internes conservés (état vérifié) ──
{
    clearUndo();
    const sg = makeMapRetypeFixture(
        [
            { id: 30, type: "Load", outputs: [{ name: "MODEL", type: "MODEL", links: [201] }] },
            { id: 1, type: "Legacy", inputs: [{ name: "model", type: "MODEL", link: 201 }], outputs: [{ name: "IMAGE", type: "IMAGE", links: [202] }] },
            { id: 31, type: "Save", inputs: [{ name: "images", type: "IMAGE", link: 202 }] },
        ],
        [
            { id: 201, origin_id: 30, origin_slot: 0, target_id: 1, target_slot: 0, type: "MODEL" },
            { id: 202, origin_id: 1, origin_slot: 0, target_id: 31, target_slot: 0, type: "IMAGE" },
        ],
    ).root;
    sg.id = SG_ID; sg.name = "Chain";
    const root = makeMapRetypeFixture([], []).root;
    root.subgraphs.set(SG_ID, sg);
    const inst = makeNode({ id: 10, type: SG_ID, title: "Chain", pos: [0, 0] });
    inst.size = [200, 80]; inst.subgraph = sg; inst.isSubgraphNode = () => true; inst.graph = root;
    root._nodes.push(inst); root._nodes_by_id[10] = inst;
    const app = { graph: root, rootGraph: root, canvas: { setDirtyCanvas() {} }, loadGraphData: (d) => root.loadGraphData(d) };
    const res = await dispatchToolCall("change_node_type", { id: 1, type: "New", subgraph: SG_ID }, {
        app, mode: "active",
        createNodeImpl: () => makeNewNodeOf({ id: 55, inputs: [{ name: "model", type: "MODEL" }], outputs: [{ name: "IMAGE", type: "IMAGE" }] }),
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.subgraph.id, SG_ID);
    const problems = graphStateProblems(sg, 1, {
        kept: {
            201: { origin: "other", origin_id: 30, target: "new", target_slot: 0 },
            202: { origin: "new", origin_slot: 0, target: "other", target_id: 31 },
        },
    });
    assert.deepStrictEqual(problems, [], `état de graphe (I6) : ${problems.join(" | ")}`);
    assert.strictEqual(root.getNodeById(1), null, "racine : aucun nœud d'id 1 (retype bien DANS le subgraph)");
    clearUndo();
    ok("(I6) subgraph : liens internes conservés (origine/cible/slots + zéro pendant)");
}

// ── (I7) undo restaure type ET liens (état de graphe vérifié) ──
{
    clearUndo();
    const fx = makeMapRetypeFixture(
        [
            { id: 10, type: "L", outputs: [{ name: "MODEL", type: "MODEL", links: [101] }] },
            { id: 1, type: "Legacy", inputs: [{ name: "model", type: "MODEL", link: 101 }], outputs: [{ name: "OUT", type: "IMAGE", links: [102] }] },
            { id: 20, type: "S", inputs: [{ name: "x", type: "IMAGE", link: 102 }] },
        ],
        [
            { id: 101, origin_id: 10, origin_slot: 0, target_id: 1, target_slot: 0, type: "MODEL" },
            { id: 102, origin_id: 1, origin_slot: 0, target_id: 20, target_slot: 0, type: "IMAGE" },
        ],
    );
    const res = await dispatchToolCall("change_node_type", { id: 1, type: "New" }, {
        app: fx.app, mode: "active",
        createNodeImpl: () => makeNewNodeOf({ inputs: [{ name: "model", type: "MODEL" }], outputs: [{ name: "OUT", type: "IMAGE" }] }),
    });
    assert.strictEqual(res.ok, true);
    const u = await undoSnapshot(res.snapshotId, { app: fx.app });
    assert.strictEqual(u.ok, true, "undo via loadGraphData");
    assert.strictEqual(fx.root.getNodeById(1).type, "Legacy", "undo : type restauré");
    const problems = graphStateProblems(fx.root, 1, {
        kept: {
            101: { origin: "other", origin_id: 10, target: "new", target_slot: 0 },
            102: { origin: "new", origin_slot: 0, target: "other", target_id: 20 },
        },
    });
    assert.deepStrictEqual(problems, [], `état de graphe après undo (I7) : ${problems.join(" | ")}`);
    clearUndo();
    ok("(I7) undo restaure type ET liens (état de graphe vérifié des deux côtés)");
}

// ── (I8) garde anti-lien-pendant : un id de lien absent du registre n'est jamais recréé ──
{
    clearUndo();
    // Node 1 : sortie IMAGE dont l'id de lien (999) n'existe PAS dans graph.links
    // (référence pendante PRÉEXISTANTE). Après retype, l'outil ne doit ni la
    // recréer ni la compter « recâblée » — le graphe reste sans aucune pendante.
    const fx = makeMapRetypeFixture(
        [
            { id: 1, type: "Legacy", inputs: [{ name: "model", type: "MODEL", link: null }], outputs: [{ name: "IMAGE", type: "IMAGE", links: [999] }] },
        ],
        [],
    );
    const res = await dispatchToolCall("change_node_type", { id: 1, type: "New" }, {
        app: fx.app, mode: "active",
        createNodeImpl: () => makeNewNodeOf({ inputs: [{ name: "model", type: "MODEL" }], outputs: [{ name: "IMAGE", type: "IMAGE" }] }),
    });
    assert.strictEqual(res.data.links_reconnected, 0, "lien pendant 999 NON compté recâblé");
    assert.strictEqual(res.data.links_lost, 1, "lien pendant 999 compté détaché");
    const problems = graphStateProblems(fx.root, 1, { kept: {}, gone: [999] });
    assert.deepStrictEqual(problems, [], `état de graphe (I8) : ${problems.join(" | ")}`);
    assert.deepStrictEqual(fx.root.getNodeById(1).outputs.find((o) => o.name === "IMAGE").links, [], "nouvelle node : sortie sans référence pendante");
    clearUndo();
    ok("(I8) garde anti-lien-pendant : id de lien absent du registre jamais recréé (zéro référence pendante)");
}

// ══════ 6sexies. change_node_type DANS UN SUBGRAPH : modèle RÉEL (registre
// par graphe). L'ancienne fixture I6 était déjà FIDÈLE sur l'axe du registre
// (node.graph = subgraph, liens dans le Map du subgraph) ; elle était en
// revanche SIMPLIFIÉE sur 3 points qui masquaient 2 défauts réels : (a) pas de
// nœuds d'I/O (-10/-20) HORS `subgraph.nodes` donc pas de lien de FRONTIÈRE, ni
// de nettoyage de leurs `linkIds` ; (b) pas de sous-subgraph IMBRIQUÉ instancié ;
// (c) aucune assertion « registre RACINE non pollué » ni « node.graph === sg ».
// Ce bloc les couvre avec makeRealSubgraphWorld().

// ── (I6b) subgraph RÉEL : registre par graphe, frontière, racine non polluée ──
{
    clearUndo();
    const w = makeRealSubgraphWorld();
    const before = w.sg.nodes.length;
    const res = await dispatchToolCall("change_node_type", { id: 1, type: "New", subgraph: SG_ID }, {
        app: w.app, mode: "active",
        createNodeImpl: () => makeNewNodeOf({ id: 55, inputs: [{ name: "model", type: "MODEL" }, { name: "image", type: "IMAGE" }], outputs: [{ name: "IMAGE", type: "IMAGE" }] }),
    });
    assert.strictEqual(res.ok, true, "retype interne OK");
    assert.strictEqual(res.data.links_reconnected, 4, "4 liens conservés (entrées model+image, sortie multi-liens)");
    assert.strictEqual(res.data.links_lost, 0, "aucun lien perdu (slots équivalents)");
    // Registre PROPRE au subgraph intact ; racine NON polluée.
    assert.strictEqual(realLinks(w.sg), "200:-10[0]->1[1], 201:30[0]->1[0], 202:1[0]->31[0], 203:1[0]->-20[0]", "registre du SUBGRAPH intact (ids/origine/cible/slots)");
    assert.strictEqual(w.root._links.size, 1, "la racine ne garde QUE son lien 901 (aucune pollution par un lien interne)");
    // Nœud propriétaire = subgraph ; refs de slot de la nouvelle node posées.
    assert.strictEqual(w.sg.getNodeById(1).graph, w.sg, "nœud interne : owner = subgraph");
    assert.strictEqual(w.sg.getNodeById(1).type, "New", "type changé en place");
    assert.strictEqual(w.sg.getNodeById(1).inputs[0].link, 201, "inputs[model].link posé");
    assert.strictEqual(w.sg.getNodeById(1).inputs[1].link, 200, "inputs[image].link (frontière) posé");
    assert.deepStrictEqual(w.sg.getNodeById(1).outputs[0].links, [202, 203], "outputs[IMAGE].links posés (interne + frontière)");
    // Ancienne node retirée ; nœuds d'I/O du subgraph intacts.
    assert.strictEqual(w.sg.nodes.filter((n) => String(n.id) === "1").length, 1, "ancienne node retirée (une seule node d'id 1)");
    assert.strictEqual(w.sg.nodes.length, before, "nombre de nœuds du subgraph inchangé");
    assert.deepStrictEqual(w.sg.inputs[0].linkIds, [200], "entrée I/O du subgraph intacte");
    assert.deepStrictEqual(w.sg.outputs[0].linkIds, [203], "sortie I/O du subgraph intacte");
    // 5 invariants d'état de graphe (aucune référence pendante).
    const problems = graphStateProblems(w.sg, 1, {
        kept: {
            201: { origin: "other", origin_id: 30, target: "new", target_slot: 0 },
            200: { target: "new", target_slot: 1 },
            202: { origin: "new", origin_slot: 0, target: "other", target_id: 31 },
            203: { origin: "new", origin_slot: 0 },
        },
    });
    assert.deepStrictEqual(problems, [], `état de graphe réel (I6b) : ${problems.join(" | ")}`);
    clearUndo();
    ok("(I6b) subgraph RÉEL : registre par graphe, frontière conservée, refs de slot + zéro pendant, racine non polluée");
}

// ── (I6n) subgraph IMBRIQUÉ : registre du sous-subgraph seul ──
{
    clearUndo();
    const w = makeRealSubgraphWorld();
    const res = await dispatchToolCall("change_node_type", { id: 7, type: "New", subgraph: SG2_ID }, {
        app: w.app, mode: "active",
        createNodeImpl: () => makeNewNodeOf({ id: 56, inputs: [{ name: "image", type: "IMAGE" }], outputs: [{ name: "IMAGE", type: "IMAGE" }] }),
    });
    assert.strictEqual(res.ok, true, "retype dans le subgraph IMBRIQUÉ");
    assert.strictEqual(res.data.links_reconnected, 2, "2 liens internes au sous-subgraph conservés");
    assert.strictEqual(realLinks(w.sg2), "401:6[0]->7[0], 402:7[0]->8[0]", "registre du sous-subgraph intact");
    assert.strictEqual(w.sg2.getNodeById(7).graph, w.sg2, "propriétaire = sous-subgraph");
    assert.strictEqual(w.sg._links.has(401), false, "les liens du sous-subgraph ne remontent PAS dans le parent");
    const problems = graphStateProblems(w.sg2, 7, {
        kept: {
            401: { origin: "other", origin_id: 6, target: "new", target_slot: 0 },
            402: { origin: "new", origin_slot: 0, target: "other", target_id: 8 },
        },
    });
    assert.deepStrictEqual(problems, [], `état de graphe imbriqué (I6n) : ${problems.join(" | ")}`);
    clearUndo();
    ok("(I6n) subgraph IMBRIQUÉ : retype d'un nœud interne, registre du sous-subgraph seul");
}

// ── (I6u) undo DANS un subgraph : type ET liens internes restaurés ──
{
    clearUndo();
    const w = makeRealSubgraphWorld();
    const res = await dispatchToolCall("change_node_type", { id: 1, type: "New", subgraph: SG_ID }, {
        app: w.app, mode: "active",
        createNodeImpl: () => makeNewNodeOf({ id: 57, inputs: [{ name: "model", type: "MODEL" }, { name: "image", type: "IMAGE" }], outputs: [{ name: "IMAGE", type: "IMAGE" }] }),
    });
    assert.strictEqual(res.ok, true);
    const u = await undoSnapshot(res.snapshotId, { app: w.app });
    assert.strictEqual(u.ok, true, "undo via loadGraphData (snapshot racine embarque definitions.subgraphs)");
    assert.strictEqual(w.sg.getNodeById(1).type, "Legacy", "undo : type du nœud interne restauré");
    assert.strictEqual(realLinks(w.sg), "200:-10[0]->1[1], 201:30[0]->1[0], 202:1[0]->31[0], 203:1[0]->-20[0]", "undo : liens INTERNES du subgraph restaurés");
    const problems = graphStateProblems(w.sg, 1, {
        kept: {
            201: { origin: "other", origin_id: 30, target: "new", target_slot: 0 },
            200: { target: "new", target_slot: 1 },
            202: { origin: "new", origin_slot: 0, target: "other", target_id: 31 },
            203: { origin: "new", origin_slot: 0 },
        },
    });
    assert.deepStrictEqual(problems, [], `état après undo subgraph (I6u) : ${problems.join(" | ")}`);
    clearUndo();
    ok("(I6u) undo DANS un subgraph : restaure le type ET les liens internes");
}

// ── (I6io) lien de FRONTIÈRE détaché : I/O du subgraph nettoyée ──
{
    clearUndo();
    const w = makeRealSubgraphWorld();
    const res = await dispatchToolCall("change_node_type", { id: 1, type: "New", subgraph: SG_ID }, {
        app: w.app, mode: "active",
        createNodeImpl: () => makeNewNodeOf({ id: 58, inputs: [{ name: "model", type: "MODEL" }, { name: "image", type: "IMAGE" }], outputs: [] }),
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.links_lost, 2, "2 liens de sortie (202,203) détachés faute d'équivalent");
    assert.strictEqual(w.sg._links.has(203), false, "203 (frontière) retiré du registre du subgraph");
    assert.deepStrictEqual(w.sg.outputs[0].linkIds, [], "sortie I/O du subgraph nettoyée (AUCUNE référence pendante)");
    assert.deepStrictEqual(w.sg.inputs[0].linkIds, [200], "entrée I/O conservée intacte");
    const problems = graphStateProblems(w.sg, 1, {
        kept: {
            201: { origin: "other", origin_id: 30, target: "new", target_slot: 0 },
            200: { target: "new", target_slot: 1 },
        },
        gone: [202, 203],
    });
    assert.deepStrictEqual(problems, [], `état frontière (I6io) : ${problems.join(" | ")}`);
    clearUndo();
    ok("(I6io) lien de FRONTIÈRE détaché : I/O du subgraph nettoyée (zéro référence pendante)");
}

// ── (I8b) ENTRÉE pendante : jamais comptée « recâblée » (symétrie SORTIE) ──
{
    clearUndo();
    const fx = makeMapRetypeFixture(
        [
            { id: 1, type: "Legacy", inputs: [{ name: "model", type: "MODEL", link: 777 }], outputs: [] },
        ],
        [],
    );
    const res = await dispatchToolCall("change_node_type", { id: 1, type: "New" }, {
        app: fx.app, mode: "active",
        createNodeImpl: () => makeNewNodeOf({ inputs: [{ name: "model", type: "MODEL" }] }),
    });
    assert.strictEqual(res.data.links_reconnected, 0, "entrée pendante 777 NON comptée recâblée");
    assert.strictEqual(res.data.links_lost, 1, "entrée pendante 777 comptée détachée");
    assert.strictEqual(fx.root.getNodeById(1).inputs.find((i) => i.name === "model").link, null, "nouvelle node : entrée sans référence pendante");
    const problems = graphStateProblems(fx.root, 1, { kept: {}, gone: [777] });
    assert.deepStrictEqual(problems, [], `état de graphe (I8b) : ${problems.join(" | ")}`);
    clearUndo();
    ok("(I8b) entrée pendante : jamais recréée ni comptée recâblée (symétrie avec la SORTIE)");
}

// ── (I6s) hook POST-SWAP destructeur DANS UN SUBGRAPH : I/O de frontière RÉPARÉES ──
// Comme J2 en contexte RACINE, mais dans un SUBGRAPH et avec un hook qui vide
// AUSSI les `linkIds` des I/O de frontière (hors `graph.nodes`). Le correctif
// doit RÉPARER les deux extrémités (slots de node + linkIds de frontière) :
// un `linkIds` vidé laissait auparavant le lien de frontière « perdu » à tort.
{
    clearUndo();
    const w = makeRealSubgraphWorld();
    // Hook destructeur (resynchronisation de slots façon ComfyUI via change()).
    w.sg.change = function () {
        const nn = this.getNodeById(1);
        if (nn) { nn.inputs.forEach((i) => { i.link = null; }); nn.outputs.forEach((o) => { o.links = []; }); }
        this.inputs[0].linkIds.length = 0;
        this.outputs[0].linkIds.length = 0;
    };
    const res = await dispatchToolCall("change_node_type", { id: 1, type: "New", subgraph: SG_ID }, {
        app: w.app, mode: "active",
        createNodeImpl: () => makeNewNodeOf({ id: 59, inputs: [{ name: "model", type: "MODEL" }, { name: "image", type: "IMAGE" }], outputs: [{ name: "IMAGE", type: "IMAGE" }] }),
    });
    assert.strictEqual(res.ok, true, "retype interne OK malgré le hook destructeur");
    assert.strictEqual(res.data.links_lost, 0, "hook destructeur subgraph : liens RÉPARÉS (aucun perdu)");
    assert.strictEqual(res.data.links_reconnected, 4, "4 liens vivants après réparation");
    assert.strictEqual(res.data.link_verification.verified, true, "liens VÉRIFIÉS en subgraph");
    assert.deepStrictEqual(w.sg.inputs[0].linkIds, [200], "linkIds d'ENTRÉE de frontière RÉPARÉS");
    assert.deepStrictEqual(w.sg.outputs[0].linkIds, [203], "linkIds de SORTIE de frontière RÉPARÉS");
    assert.strictEqual(w.sg.getNodeById(1).inputs[1].link, 200, "frontière entrante ré-posée sur la nouvelle node");
    assert.strictEqual(w.sg.getNodeById(1).outputs[0].links.includes(203), true, "frontière sortante ré-posée");
    assert.strictEqual(noticeKeptCount(res.data.notice), 4, "le notice ne ment pas (4 conservées)");
    const problems = graphStateProblems(w.sg, 1, {
        kept: {
            200: { target: "new", target_slot: 1 },
            201: { origin: "other", origin_id: 30, target: "new", target_slot: 0 },
            202: { origin: "new", origin_slot: 0, target: "other", target_id: 31 },
            203: { origin: "new", origin_slot: 0 },
        },
    });
    assert.deepStrictEqual(problems, [], `état après hook destructeur subgraph (I6s) : ${problems.join(" | ")}`);
    clearUndo();
    ok("(I6s) hook post-swap destructeur DANS UN SUBGRAPH : I/O de frontière RÉPARÉES (linkIds) + notice honnête");
}

console.log("\n6septies. change_node_type : RÉGRESSION « liens détruits + notice mensonger » (hooks post-swap)");

// Reproduction fidèle du scénario réel signalé : un hook POST-SWAP destructeur
// (resynchronisation de slots façon ComfyUI via graph.change()/configure, ou
// changement qui ré-écrit inputs/outputs) ÉCRASE les liens recâblés. L'ANCIEN
// code comptait ces liens « conservés » (compteur OPTIMISTE) → comportement
// cassé ET message MENSONGER (« N connexion(s) conservée(s) » alors que tout
// est à null). Le correctif RE-LIT l'état réel APRÈS les hooks, ré-applique une
// fois, puis VÉRIFIE chaque lien (registre + refs des deux extrémités + slots).

/** Registre de liens FIDÈLE au Proxy Map+Record du frontend récent : méthodes
 *  Map (.get/.set/.delete/.values…) ET accès indexé (links[id]) fonctionnent. */
function makeProxyLinks(map) {
    const backing = map instanceof Map ? map : new Map();
    return new Proxy(backing, {
        get(t, p) {
            if (typeof p === "symbol") return Reflect.get(t, p, t);
            if (typeof t[p] === "function") return t[p].bind(t);
            if (p in t) return t[p];
            const k = Number(p);
            return Number.isNaN(k) ? undefined : t.get(k);
        },
        set(t, p, v) {
            if (typeof p === "symbol") { t[p] = v; return true; }
            const k = Number(p);
            if (Number.isNaN(k)) { t[p] = v; return true; }
            t.set(k, v); return true;
        },
        deleteProperty(t, p) {
            const k = Number(p);
            return Number.isNaN(k) ? delete t[p] : t.delete(k);
        },
        has(t, p) { const k = Number(p); return Number.isNaN(k) ? (p in t) : t.has(k); },
    });
}

/** Compte, en RE-LISANT l'état réel, les liens qui traversent `nodeId` ET dont
 *  les DEUX extrémités (slots) concordent — indépendant des compteurs du code. */
function countLiveLinksThrough(g, nodeId) {
    const links = g.links && typeof g.links.values === "function" ? [...g.links.values()] : [];
    let count = 0;
    for (const link of links) {
        if (!link || (String(link.origin_id) !== String(nodeId) && String(link.target_id) !== String(nodeId))) continue;
        const org = g.getNodeById(link.origin_id);
        const tgt = g.getNodeById(link.target_id);
        const orgSlot = org && Array.isArray(org.outputs) ? org.outputs[link.origin_slot] : null;
        const tgtSlot = tgt && Array.isArray(tgt.inputs) ? tgt.inputs[link.target_slot] : null;
        const orgOk = !org || (!!orgSlot && Array.isArray(orgSlot.links) && orgSlot.links.some((x) => String(x) === String(link.id)));
        const tgtOk = !tgt || (!!tgtSlot && String(tgtSlot.link) === String(link.id));
        if (orgOk && tgtOk) count++;
    }
    return count;
}

/** L'invariant « le notice ne ment pas » : le nombre annoncé « conservé » DOIT
 *  égaler le nombre de liens réellement vivants (re-lus), sinon on a menti. */
function noticeKeptCount(notice) {
    const m = String(notice || "").match(/(\d+)\s+connexion/i);
    return m ? Number(m[1]) : null;
}
function assertNoticeHonest(res, g, nodeId, ctxLabel) {
    const announced = res.data.links_reconnected;
    const live = countLiveLinksThrough(g, nodeId);
    assert.strictEqual(announced, live, `${ctxLabel} : compte rendu HONNÊTE (annoncé ${announced} === vivants ${live})`);
    assert.strictEqual(noticeKeptCount(res.data.notice), announced, `${ctxLabel} : le notice annonce exactement ${announced}`);
    assert.ok(res.data.link_verification && res.data.link_verification.verified === true, `${ctxLabel} : liens VÉRIFIÉS`);
}

// ── (J1) BATcH 17 nodes en chaîne : liens entre nodes retypés tous conservés ──
{
    clearUndo();
    const defs = [];
    const links = [];
    defs.push({ id: 1, type: "Legacy", outputs: [{ name: "MODEL", type: "MODEL", links: [100] }] });
    for (let i = 2; i <= 18; i++) {
        defs.push({ id: i, type: "Legacy",
            inputs: [{ name: "MODEL", type: "MODEL", link: 100 + (i - 2) }],
            outputs: [{ name: "MODEL", type: "MODEL", links: i <= 17 ? [100 + (i - 1)] : [] }] });
    }
    for (let i = 0; i < 17; i++) links.push({ id: 100 + i, origin_id: 1 + i, origin_slot: 0, target_id: 2 + i, target_slot: 0, type: "MODEL" });
    const fx = makeMapRetypeFixture(defs, links);
    fx.root.links = makeProxyLinks(fx.root.links);
    const ids = defs.map((d) => d.id);
    for (const id of ids) {
        const res = await dispatchToolCall("change_node_type", { id, type: "New" }, {
            app: fx.app, mode: "active",
            createNodeImpl: () => makeNewNodeOf({ inputs: [{ name: "MODEL", type: "MODEL" }], outputs: [{ name: "MODEL", type: "MODEL" }] }),
        });
        assert.strictEqual(res.ok, true, `retype #${id} OK`);
        assert.strictEqual(res.data.links_lost, 0, `retype #${id} : aucun lien perdu`);
        assertNoticeHonest(res, fx.root, id, `(J1#${id})`);
    }
    const problems = graphStateProblems(fx.root, 1, {
        kept: { 100: { origin: "new", origin_slot: 0, target: "other", target_id: 2 } },
    });
    assert.deepStrictEqual(problems, [], `état après lot 17 (J1) : ${problems.join(" | ")}`);
    assert.strictEqual(fx.root.links.size, 17, "les 17 liens sont intacts dans le registre");
    clearUndo();
    ok("(J1) lot 17 nodes (registre Proxy Map+Record) : liens entre nodes retypés conservés ET VÉRIFIÉS (notice honnête)");
}

// ── (J2) hook POST-SWAP destructeur réparé (réconciliation) ──
{
    clearUndo();
    const fx = makeMapRetypeFixture(
        [
            { id: 10, type: "Loader", outputs: [{ name: "MODEL", type: "MODEL", links: [101] }] },
            { id: 1, type: "Legacy", inputs: [{ name: "model", type: "MODEL", link: 101 }], outputs: [{ name: "IMAGE", type: "IMAGE", links: [102] }] },
            { id: 20, type: "Saver", inputs: [{ name: "x", type: "IMAGE", link: 102 }] },
        ],
        [
            { id: 101, origin_id: 10, origin_slot: 0, target_id: 1, target_slot: 0, type: "MODEL" },
            { id: 102, origin_id: 1, origin_slot: 0, target_id: 20, target_slot: 0, type: "IMAGE" },
        ],
    );
    fx.root.links = makeProxyLinks(fx.root.links);
    // Hook post-swap destructeur : vide les slots du nœud remplacé (simule la
    // resynchronisation de slots d'un `graph.change()`/reconfigure réel).
    fx.root.change = function () {
        const nn = this.getNodeById(1);
        if (nn) { nn.inputs.forEach((i) => { i.link = null; }); nn.outputs.forEach((o) => { o.links = []; }); }
    };
    const res = await dispatchToolCall("change_node_type", { id: 1, type: "New" }, {
        app: fx.app, mode: "active",
        createNodeImpl: () => makeNewNodeOf({ inputs: [{ name: "model", type: "MODEL" }], outputs: [{ name: "IMAGE", type: "IMAGE" }] }),
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.links_lost, 0, "liens RÉPARÉS (ré-appliqués) : aucun perdu");
    assertNoticeHonest(res, fx.root, 1, "(J2)");
    const problems = graphStateProblems(fx.root, 1, {
        kept: {
            101: { origin: "other", origin_id: 10, target: "new", target_slot: 0 },
            102: { origin: "new", origin_slot: 0, target: "other", target_id: 20 },
        },
    });
    assert.deepStrictEqual(problems, [], `état après hook destructeur (J2) : ${problems.join(" | ")}`);
    clearUndo();
    ok("(J2) hook post-swap destructeur : liens RÉ-APPLIQUÉS puis VÉRIFIÉS (le compte rendu ne ment pas)");
}

// ── (J3) perte IRRÉCUPÉRABLE : le notice NE prétend PAS conserver ──
{
    clearUndo();
    const fx = makeMapRetypeFixture(
        [
            { id: 10, type: "Loader", outputs: [{ name: "MODEL", type: "MODEL", links: [101] }] },
            { id: 1, type: "Legacy", inputs: [{ name: "model", type: "MODEL", link: 101 }], outputs: [{ name: "IMAGE", type: "IMAGE", links: [102] }] },
            { id: 20, type: "Saver", inputs: [{ name: "x", type: "IMAGE", link: 102 }] },
        ],
        [
            { id: 101, origin_id: 10, origin_slot: 0, target_id: 1, target_slot: 0, type: "MODEL" },
            { id: 102, origin_id: 1, origin_slot: 0, target_id: 20, target_slot: 0, type: "IMAGE" },
        ],
    );
    const backing = fx.root.links;
    fx.root.links = makeProxyLinks(backing);
    // Hook post-swap qui DÉTRUIT les liens ET rend le registre non inscriptible
    // (réconciliation impossible) — cas extrême = « les liens sont bien détruits ».
    fx.root.change = function () {
        const nn = this.getNodeById(1);
        if (nn) {
            const ids = [...nn.inputs.map((i) => i.link), ...nn.outputs.flatMap((o) => o.links || [])].filter((v) => v !== null && v !== undefined);
            for (const id of ids) backing.delete(id);
            nn.inputs.forEach((i) => { i.link = null; }); nn.outputs.forEach((o) => { o.links = []; });
        }
        backing.set = function () { return this; }; // inscriptible = non
    };
    const res = await dispatchToolCall("change_node_type", { id: 1, type: "New" }, {
        app: fx.app, mode: "active",
        createNodeImpl: () => makeNewNodeOf({ inputs: [{ name: "model", type: "MODEL" }], outputs: [{ name: "IMAGE", type: "IMAGE" }] }),
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.links_reconnected, 0, "aucune connexion annoncée conservée (état re-vérifié)");
    assert.strictEqual(res.data.link_verification.verified, false, "vérification : NON (les liens ont bien été détruits)");
    assert.ok(/PAS survécu|détach/.test(res.data.notice), `le notice signale la perte : ${res.data.notice}`);
    // L'invariant « le notice ne ment pas » : annoncé === vivants (0).
    assert.strictEqual(noticeKeptCount(res.data.notice), 0, "le notice annonce 0 conservé (jamais 2)");
    assert.strictEqual(countLiveLinksThrough(fx.root, 1), 0, "état réel : aucun lien vivant (cohérent avec le notice)");
    clearUndo();
    ok("(J3) perte irrécupérable : le compte rendu SIGNALE les liens perdus (jamais de « conservé » mensonger)");
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
    Blobby.setShellAccess(false); // défaut sûr : chaque groupe fixe explicitement l'état shell
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
assert.ok(Array.isArray(llmPostsD[0].body.tools) && llmPostsD[0].body.tools.length === listTools().length - 1, "tools envoyés (shell off ⇒ 35 des 36, run_shell filtré)");
assert.ok(!llmPostsD[0].body.tools.some((t) => t.function.name === "run_shell"), "shell off : run_shell absent des tools");
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

/* ── (f) Lecture seule : boucle d'outils avec outils de LECTURE uniquement ── */
resetChat();
Blobby.setMode("read");
llmQueue.push({ output: "Je regarde. [SET Checkpoint steps 25] et [MOVE_TO Checkpoint]" });
await Blobby._handleChatMessage(chat, "change les steps");
await tick();
const llmPostsRead = llmPosts();
assert.strictEqual(llmPostsRead.length, 1, "un seul tour (aucun tool_call dans la réponse)");
assert.ok(Array.isArray(llmPostsRead[0].body.messages) && Array.isArray(llmPostsRead[0].body.tools), "mode read : contrat messages+tools (boucle d'outils en Lecture seule)");
assert.strictEqual(globalThis.window.app.graph.nodes[0].widgets[1].value, 20, "[SET…] en read : workflow NON muté");
assert.ok(!httpCalls.some((c) => c.url.includes("/aih/blobby/exec")), "pas d'exec shell");
const finalRead = msgs("blobby")[0].textContent;
assert.ok(finalRead.includes("interdit en mode 'read'"), `[SET…] refusé explicitement : ${finalRead}`);
assert.ok(finalRead.includes("Vue déplacée"), "[MOVE_TO] continue de marcher (vue)");
assert.ok(!chat.textContent.includes("❌ Erreur"), "aucun crash");
ok("(f) read : contrat messages+tools, [SET…] refusé sans muter, [MOVE_TO] intact");

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
assert.strictEqual(llmPostsSet[0].body.tools.length, listTools().length - 1, "mode actif + shell off : tools au POST (35/36 ; le modèle a ignoré les outils, [SET…] texte reste compris)");
assert.ok(msgs("blobby")[0].textContent.includes("steps = 45"), "commande [SET…] remplacée par le rendu d'action dans la réponse");
ok("(f) bis : [SET…] en actif → exécuté via le dispatcher (enforcement + snapshot), sans boucle tool supplémentaire");

/* ── (f) ter : matrice mode × shell — READ + shell coché → REFUS ── */
resetChat();
Blobby.setMode("read");
Blobby.setShellAccess(true); // même coché, le mode read doit tout bloquer
llmQueue.push({ output: "Je vérifie. [SHELL echo hello]" });
await Blobby._handleChatMessage(chat, "lance un shell");
await tick();
assert.strictEqual(httpCalls.filter((c) => c.url.includes("/aih/blobby/exec")).length, 0, "read : AUCUN appel à /aih/blobby/exec (mode = 1ʳᵉ barrière)");
assert.ok(/refus/i.test(chat.textContent), `refus clair affiché : ${chat.textContent}`);
assert.ok(!chat.textContent.includes("❌ Erreur"), "aucun crash");
ok("(f) ter : read + shell coché → [SHELL] REFUSÉ sans exécution (le mode prime)");

/* ── (f) quater A : ACTIF + shell décoché → [SHELL] texte refusé ── */
resetChat();
Blobby.setMode("active");
Blobby.setShellAccess(false);
llmQueue.push({ output: "Je vérifie. [SHELL echo secret]" });
await Blobby._handleChatMessage(chat, "lance un shell");
await tick();
assert.strictEqual(httpCalls.filter((c) => c.url.includes("/aih/blobby/exec")).length, 0, "actif + shell off : aucun appel exec");
assert.ok(/refus/i.test(chat.textContent), "refus shell explicite (message système)");
ok("(f) quater A : actif + shell décoché → [SHELL] refusé, zéro appel exec");

/* ── (f) quater B : ACTIF + shell coché → run_shell exécuté (outil) ── */
resetChat();
Blobby.setMode("active");
Blobby.setShellAccess(true);
llmQueue.push(
    { tool_calls: [{ id: "s1", type: "function", function: { name: "run_shell", arguments: '{"command":"echo hello"}' } }] },
    { output: "C'est fait." },
);
await Blobby._handleChatMessage(chat, "lance echo hello");
await tick();
const execCalls = httpCalls.filter((c) => c.url.includes("/aih/blobby/exec"));
assert.strictEqual(execCalls.length, 1, "actif + shell on : run_shell → POST /aih/blobby/exec");
assert.strictEqual(execCalls[0].body.command, "echo hello", "commande transmise");
assert.strictEqual(execCalls[0].body.action, "shell", "action shell");
assert.ok(msgs("action").length >= 1, "ligne d'action pour run_shell");
ok("(f) quater B : actif + shell coché → run_shell exécuté via le dispatcher");

/* ── (f) quinquies : run_shell dans la liste `tools` envoyée au LLM ── */
resetChat();
Blobby.setMode("active");
Blobby.setShellAccess(false);
llmQueue.push({ output: "ok" });
await Blobby._handleChatMessage(chat, "test tools off");
await tick();
let namesSent = llmPosts()[0].body.tools.map((t) => t.function.name);
assert.ok(!namesSent.includes("run_shell"), "shell off : run_shell ABSENT de la liste tools envoyée au LLM");
assert.ok(namesSent.includes("queue_prompt"), "les autres outils restent proposés");

resetChat();
Blobby.setMode("active");
Blobby.setShellAccess(true);
llmQueue.push({ output: "ok" });
await Blobby._handleChatMessage(chat, "test tools on");
await tick();
namesSent = llmPosts()[0].body.tools.map((t) => t.function.name);
assert.ok(namesSent.includes("run_shell"), "shell on : run_shell PRÉSENT dans la liste tools envoyée au LLM");
ok("(f) quinquies : run_shell retiré/ajouté de la liste `tools` selon la case");

/* ── (f) sexies : 2ᵉ barrière front — tool_call run_shell alors que shell off ── */
resetChat();
Blobby.setMode("active");
Blobby.setShellAccess(false);
llmQueue.push(
    { tool_calls: [{ id: "s2", type: "function", function: { name: "run_shell", arguments: '{"command":"echo secret"}' } }] },
    { output: "Je ne peux pas exécuter." },
);
await Blobby._handleChatMessage(chat, "tente une commande");
await tick();
assert.strictEqual(httpCalls.filter((c) => c.url.includes("/aih/blobby/exec")).length, 0, "2ᵉ barrière : run_shell refusé, ZÉRO exec malgré le tool_call");
const convoShell = llmPosts()[1].body.messages;
const toolMsgShell = convoShell.find((m) => m.role === "tool");
assert.ok(toolMsgShell && /shell/i.test(toolMsgShell.content), "erreur shell réinjectée au LLM (role:'tool')");
ok("(f) sexies : tool_call run_shell alors que shell off → dispatcher refuse (zéro exec), message clair injecté");

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