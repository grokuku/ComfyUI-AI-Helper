/*
 * Copyright (C) 2026 Holaf
 * Blobby Tools — registre d'outils + dispatcher avec enforcement de mode +
 * snapshot/undo + boucle d'agents pure (tool_calls) + repli 4b.
 * ----------------------------------------------------------------------------
 * ÉTAPE 2 (pack JS) : mécanique d'agent pour le chat Blobby. L'UI (dropdown de
 * mode) viendra à l'étape 3 et se branchera sur Blobby.setMode() ;
 * ce module n'est PAS dépendant du DOM.
 *
 * Design validé (2 modes) :
 *   - 🔵 'read'  (défaut) : lecture seule. Les outils de mutation/exécution ne
 *     sont même pas proposés au LLM (filtrage du schéma = 1ʳᵉ barrière) et
 *     sont refusés à l'exécution (dispatcher = 2ᵉ barrière).
 *   - 🟠 'active' : tout, SANS confirmation humaine. Toute mutation est
 *     précédée d'un snapshot COMPLET du workflow (app.graph.serialize()),
 *     empilé (borné à 10) pour alimenté le bouton « Annuler » du log d'action.
 *
 * Contrat backend (étape 1) : POST /api/keywords/llm-process accepte
 * `tools`, `tool_choice` et `messages` (liste complète, remplace la
 * construction system+user) ; la réponse contient `tool_calls` en forme
 * PROVIDER VERBATIM `[{id, type:'function', function:{name, arguments}}]`
 * (arguments = STRING à JSON.parse) et `output` (peut être null sur un tour
 * d'outil pur). Le pack lit `.function.name` / `.function.arguments` et
 * re-écho ce tour assistant dans `messages` — la forme est ainsi acceptée par
 * DeepSeek/OpenAI (qui exigent `type` + le wrapper `function`).
 *
 * PURETÉ : aucun import, aucun accès DOM à l'import. `app` / `api` arrivent
 * via ctx (ou sont résolus défensivement depuis window À L'APPEL). Les textes
 * passent par ctx.t (i18n AIH) avec repli FR (langue par défaut du pack) ;
 * ce fichier ne déclare JAMAIS de variable locale `t` qui masquerait le
 * helper i18n des consommateurs.
 */

// ─── Modes & enforcement ─────────────────────────────────────────────────────

const MODES = ["read", "active"];

// read=0 < active=1 : un outil dont le rang dépasse celui du mode courant est
// REFUSÉ sans exécution (defense en profondeur après le filtrage du schéma).
const MODE_RANK = { read: 0, active: 1 };

/** Normalise défensivement un mode : inconnu → 'read' (défaut sûr). */
function normalizeMode(mode) {
    if (typeof mode !== "string") return "read";
    const m = mode.trim().toLowerCase();
    return MODES.indexOf(m) >= 0 ? m : "read";
}

// ─── Résolution défensive des API ComfyUI (à l'appel, jamais à l'import) ─────

function resolveApp(ctx) {
    if (ctx && ctx.app) return ctx.app;
    if (typeof window === "undefined") return null;
    // Même chaîne que blobby_companion.js:574 / holaf_api_compat.js.
    return (window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app) || window.app || null;
}

function resolveApi(ctx) {
    if (ctx && ctx.api) return ctx.api;
    if (typeof window === "undefined") return null;
    // Même chaîne que aih_elements_widget.js:1715 (ancien/nouveau frontend).
    return (window.app && window.app.api)
        || (window.comfyAPI && window.comfyAPI.api && window.comfyAPI.api.api)
        || window.api
        || null;
}

function getGraph(ctx) {
    const app = resolveApp(ctx);
    return app && app.graph ? app.graph : null;
}

/** Dirty-canvas best-effort (les deux niveaux existent selon les versions). */
function dirtyCanvas(ctx) {
    const app = resolveApp(ctx);
    try { if (app && app.canvas && typeof app.canvas.setDirtyCanvas === "function") app.canvas.setDirtyCanvas(true, true); } catch { /* ignore */ }
    try { const g = app && app.graph; if (g && typeof g.setDirtyCanvas === "function") g.setDirtyCanvas(true, true); } catch { /* ignore */ }
}

/**
 * Fetch same-origin (endpoints ComfyUI : /object_info, /queue, /prompt,
 * /interrupt). Priorité : api.fetchApi (auth/base gérées par ComfyUI, même
 * précédent que holaf_remote_comparer.js:217) → hook de test ctx.fetchImpl →
 * fetch global (même précédent que aih_workflow_share.js:500). Aucun appel
 * vers le backend distant AIH ici : ce pont reste du ressort de remoteRequest.
 */
function sameOriginFetch(ctx, url, opts) {
    const api = resolveApi(ctx);
    if (api && typeof api.fetchApi === "function") return api.fetchApi(url, opts || {});
    if (ctx && typeof ctx.fetchImpl === "function") return ctx.fetchImpl(url, opts || {});
    if (typeof fetch === "function") return fetch(url, opts || {});
    return Promise.reject(new Error("aucun accès réseau disponible (api.fetchApi/fetch absents)"));
}

// ─── i18n local : ctx.t (AIH.I18n) avec repli FR, sans masquer le helper t() ──

function label(ctx, key, params, fallbackFr) {
    let s = null;
    try {
        if (ctx && typeof ctx.t === "function") {
            const v = ctx.t(key, params);
            if (typeof v === "string" && v.length > 0 && v !== key) s = v;
        }
    } catch { /* traducteur capricieux → repli */ }
    if (s === null) {
        s = fallbackFr || key;
        if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
    }
    return s;
}

// ─── Résolution défensive des nœuds / widgets ────────────────────────────────

/**
 * Retrouve un nœud par id. graph.nodes peut être un ARRAY (LiteGraph
 * historique) ou un MAP (formes défensives) ; getNodeById existe selon les
 * versions. Retourne { node } ou { error, code }.
 */
function findNode(ctx, id) {
    if (id === undefined || id === null || id === "") {
        return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "id manquant" }, "arguments invalides : {detail}"), code: "invalid_args" };
    }
    const graph = getGraph(ctx);
    if (!graph) {
        return { error: label(ctx, "bl.toolErr.noApp", {}, "workflow ComfyUI indisponible (app/graph introuvable)"), code: "no_app" };
    }
    let node = null;
    try {
        if (typeof graph.getNodeById === "function") node = graph.getNodeById(id) || null;
    } catch { /* forme inattendue → résolution manuelle */ }
    if (!node && Array.isArray(graph.nodes)) {
        node = graph.nodes.find((n) => n && String(n.id) === String(id)) || null;
    }
    if (!node && graph.nodes && typeof graph.nodes === "object") {
        node = graph.nodes[String(id)] || graph.nodes[Number(id)] || null;
    }
    if (!node) {
        return { error: label(ctx, "bl.toolErr.nodeNotFound", { id: String(id) }, "nœud #{id} introuvable"), code: "not_found" };
    }
    return { node };
}

/** Widget par nom (exact d'abord, puis inclusion — tolérant aux approximations LLM). */
function findWidget(node, name) {
    if (!node || !Array.isArray(node.widgets)) return null;
    const target = String(name === undefined || name === null ? "" : name).toLowerCase().trim();
    if (!target) return null;
    let w = node.widgets.find((x) => x && String(x.name).toLowerCase() === target);
    if (!w) w = node.widgets.find((x) => x && String(x.name).toLowerCase().indexOf(target) >= 0);
    return w || null;
}

function nodeTitle(node) {
    return (node && (node.title || node.comfyClass || node.type)) || "?";
}

// ─── Snapshot / UNDO (pile bornée, snapshot = workflow COMPLET) ──────────────

const UNDO_LIMIT = 10;
const _undoStack = [];   // [{ id, snapshot, action, ts }]
let _undoSeq = 0;

function clearUndo() { _undoStack.length = 0; }

function canUndo() { return _undoStack.length > 0; }

/** Le bouton d'une ligne d'action reste actif tant que son id est dans la pile. */
function canUndoId(id) {
    return id !== undefined && id !== null && _undoStack.some((e) => e.id === String(id));
}

/**
 * Capture le workflow COMPLET (app.graph.serialize()) AVANT une mutation.
 * Échec du snapshot ⇒ pas de mutation : le dispatcher refuse l'action.
 */
function pushUndoSnapshot(ctx, actionLabel) {
    const graph = getGraph(ctx);
    if (!graph || typeof graph.serialize !== "function") {
        return { ok: false, error: label(ctx, "bl.toolErr.snapshotFailed", {}, "snapshot du workflow impossible — action refusée (aucune mutation sans possibilité d'annulation)"), code: "snapshot_failed" };
    }
    try {
        const snapshot = graph.serialize();
        if (!snapshot) {
            return { ok: false, error: label(ctx, "bl.toolErr.snapshotFailed", {}, "snapshot du workflow impossible — action refusée (aucune mutation sans possibilité d'annulation)"), code: "snapshot_failed" };
        }
        const entry = { id: "u" + (++_undoSeq) + "-" + Date.now(), snapshot: snapshot, action: actionLabel || "", ts: Date.now() };
        _undoStack.push(entry);
        while (_undoStack.length > UNDO_LIMIT) _undoStack.shift(); // pile bornée : le plus ancien sort
        return { ok: true, id: entry.id, depth: _undoStack.length };
    } catch (e) {
        return { ok: false, error: label(ctx, "bl.toolErr.snapshotFailed", {}, "snapshot du workflow impossible — action refusée (aucune mutation sans possibilité d'annulation)") + " (" + ((e && e.message) || e) + ")", code: "snapshot_failed" };
    }
}

/** Re-représente proprement le graphe depuis un snapshot. */
async function restoreSnapshot(entry, ctx) {
    const app = resolveApp(ctx);
    if (!app || !app.graph) {
        return { ok: false, error: label(ctx, "bl.toolErr.noApp", {}, "workflow ComfyUI indisponible (app/graph introuvable)"), code: "no_app" };
    }
    let how = null;
    try {
        if (ctx && typeof ctx.restoreImpl === "function") {
            await ctx.restoreImpl(app, entry.snapshot);
            how = "ctx.restoreImpl";
        } else if (typeof app.loadGraphData === "function") {
            // Chemin canonique ComfyUI : re-crée les nœuds/widgets depuis les
            // définitions, puis redessine (le plus propre pour TOUT restaurer).
            await app.loadGraphData(entry.snapshot);
            how = "loadGraphData";
        } else if (typeof app.graph.configure === "function") {
            app.graph.configure(entry.snapshot);
            how = "graph.configure";
        } else if (typeof app.graph.load === "function") {
            const r = app.graph.load(entry.snapshot);
            if (r && typeof r.then === "function") await r;
            how = "graph.load";
        } else {
            return { ok: false, error: label(ctx, "bl.toolErr.noRestore", {}, "restauration impossible (aucune API graph compatible)"), code: "no_restore_api" };
        }
    } catch (e) {
        return { ok: false, error: label(ctx, "bl.toolErr.restoreFailed", { error: (e && e.message) || String(e) }, "restauration échouée : {error}"), code: "restore_error" };
    }
    dirtyCanvas(ctx);
    return { ok: true, data: { restored_via: how, action: entry.action, ts: entry.ts } };
}

/**
 * Annule jusqu'à (et y compris) l'action `id` : les snapshots postérieurs
 * deviennent incohérents avec l'état restauré, ils sortent de la pile —
 * mais UNIQUEMENT si la restauration réussit (sinon l'entrée reste
 * retable : un échec d'API ne détruit pas la possibilité d'annuler).
 */
async function undoSnapshot(id, ctx) {
    const idx = _undoStack.findIndex((e) => e.id === String(id));
    if (idx < 0) {
        return { ok: false, error: label(ctx, "bl.toolErr.undoUnknown", {}, "action déjà annulée ou expirée"), code: "undo_unknown" };
    }
    const res = await restoreSnapshot(_undoStack[idx], ctx);
    if (res.ok) _undoStack.splice(idx); // entrée ciblée + toutes les suivantes
    return res;
}

/** Annule la dernière mutation (bouton générique). */
async function undoLast(ctx) {
    if (!_undoStack.length) {
        return { ok: false, error: label(ctx, "bl.toolErr.undoEmpty", {}, "rien à annuler (pile vide)"), code: "undo_empty" };
    }
    const res = await restoreSnapshot(_undoStack[_undoStack.length - 1], ctx);
    if (res.ok) _undoStack.pop();
    return res;
}

// ─── Registre d'outils ───────────────────────────────────────────────────────
// Chaque entrée : { name, description, schema, mode, undoable?, exec(args, ctx) }
//   - schema   : JSON-Schema des paramètres (envoyé au LLM).
//   - mode     : 'read' | 'active' (enforcement + filtrage).
//   - undoable : true ⇒ mutation du graphe ⇒ snapshot avant exec.
//   - exec     : async (args, ctx) → { data, action? } | { error, code? }.
// RENDU : `data` = valeur sérialisable pour le LLM ; `action` = description
// courte (i18n) pour la ligne d'action du log avec bouton « Annuler ».

const TOOL_REGISTRY = Object.create(null);

function registerTool(entry) {
    if (!entry || typeof entry.name !== "string" || !entry.name) throw new Error("registerTool: name requis");
    if (!entry.exec || typeof entry.exec !== "function") throw new Error("registerTool(" + entry.name + "): exec requis");
    if (!entry.schema || typeof entry.schema !== "object") throw new Error("registerTool(" + entry.name + "): schema requis");
    entry.mode = normalizeMode(entry.mode);
    if (MODE_RANK[entry.mode] === undefined) throw new Error("registerTool(" + entry.name + "): mode invalide");
    TOOL_REGISTRY[entry.name] = entry;
    return entry;
}

function listTools() {
    return Object.keys(TOOL_REGISTRY).map((k) => TOOL_REGISTRY[k]);
}

/**
 * Schémas filtrés par le mode (format function-calling). 1ʳᵉ barrière : en
 * mode 'read', les outils 'active' ne sont même pas proposés au LLM.
 */
function getToolsForMode(mode) {
    const m = normalizeMode(mode);
    return listTools()
        .filter((tl) => (MODE_RANK[tl.mode] === undefined ? 1 : MODE_RANK[tl.mode]) <= MODE_RANK[m])
        .map((tl) => ({
            type: "function",
            function: { name: tl.name, description: tl.description, parameters: tl.schema },
        }));
}

// ─── Dispatcher avec ENFORCEMENT (2ᵉ barrière) ───────────────────────────────

function _fail(ctx, code, error) { return { ok: false, code: code, error: error }; }

/**
 * dispatchToolCall(name, args, ctx) :
 *   1. outil inconnu            → erreur structurée (réinjectée au LLM) ;
 *   2. rank(tool.mode) > rank(ctx.mode) → REFUS sans exécution ;
 *   3. outil undoable           → snapshot COMPLET AVANT exec (pile bornée 10) ;
 *   4. exec, résultat normalisé : { ok, data?, action?, snapshotId? } |
 *                                { ok:false, error, code }.
 * ctx : { app?, api?, mode ('read'|'active', défaut 'read'), t?, fetchImpl?,
 *         createNodeImpl?, restoreImpl? }.
 */
async function dispatchToolCall(name, args, ctx) {
    ctx = ctx || {};
    const tool = TOOL_REGISTRY[name];
    if (!tool) {
        return _fail(ctx, "unknown_tool", label(ctx, "bl.toolErr.unknown", { name: String(name) }, "outil '{name}' inconnu"));
    }
    const mode = normalizeMode(ctx.mode);
    const toolRank = MODE_RANK[tool.mode] === undefined ? 1 : MODE_RANK[tool.mode];
    if (toolRank > MODE_RANK[mode]) {
        // Enforcement : refus SANS exécution, message réinjectable au LLM.
        return _fail(ctx, "mode_forbidden", label(ctx, "bl.toolErr.forbidden", { name: name, mode: mode }, "outil '{name}' interdit en mode '{mode}' (réservé au mode Actif)"));
    }
    let snapshotId = null;
    if (tool.undoable) {
        const snap = pushUndoSnapshot(ctx, tool.name);
        if (!snap.ok) return _fail(ctx, "snapshot_failed", snap.error);
        snapshotId = snap.id;
    }
    let out;
    try {
        out = await tool.exec(args || {}, ctx);
    } catch (e) {
        // Exception : mutation partielle possible → on CONSERVE le snapshot
        // (l'utilisateur doit pouvoir revenir en arrière).
        return _fail(ctx, "exec_error", label(ctx, "bl.toolErr.exec", { error: (e && e.message) || String(e) }, "échec de l'outil : {error}"));
    }
    if (out && out.error) {
        // Erreur métier propre (nœud/widget introuvable, valeur refusée…) :
        // pas de mutation ⇒ on retire le snapshot fraîchement poussé.
        if (snapshotId !== null) {
            const i = _undoStack.findIndex((e) => e.id === snapshotId);
            if (i >= 0 && i === _undoStack.length - 1) _undoStack.pop();
        }
        return _fail(ctx, out.code || "exec_error", out.error);
    }
    const data = out && out.data !== undefined ? out.data : (out === undefined ? null : out);
    const action = (out && out.action)
        || (tool.mode === "read"
            ? label(ctx, "bl.toolAct.read", { name: tool.name }, "🔍 {name}")
            : undefined);
    return { ok: true, data: data, action: action, snapshotId: snapshotId, mode: tool.mode };
}

// ─── Lectures ('read') ───────────────────────────────────────────────────────

registerTool({
    name: "describe_workflow",
    description: "Résumé COMPLET du workflow ComfyUI ouvert : nombre de nœuds, puis pour chaque nœud son id, son type, son titre et les valeurs de ses widgets.",
    schema: { type: "object", properties: {}, required: [] },
    mode: "read",
    async exec(_args, ctx) {
        const graph = getGraph(ctx);
        if (!graph || !Array.isArray(graph.nodes)) {
            return { error: label(ctx, "bl.toolErr.noApp", {}, "workflow ComfyUI indisponible (app/graph introuvable)"), code: "no_app" };
        }
        const nodes = graph.nodes.map((n) => {
            const widgets = {};
            if (Array.isArray(n.widgets)) n.widgets.forEach((w) => { if (w && w.name !== undefined) widgets[w.name] = w.value; });
            return { id: n.id, type: n.type, title: n.title || n.comfyClass || n.type, widgets: widgets };
        });
        return { data: { node_count: nodes.length, nodes: nodes } };
    },
});

registerTool({
    name: "list_nodes",
    description: "Liste légère des nœuds du workflow : id, type, titre, position. Pour les valeurs de widgets, préférer describe_workflow, get_node_widgets ou get_node_widget.",
    schema: { type: "object", properties: {}, required: [] },
    mode: "read",
    async exec(_args, ctx) {
        const graph = getGraph(ctx);
        if (!graph || !Array.isArray(graph.nodes)) {
            return { error: label(ctx, "bl.toolErr.noApp", {}, "workflow ComfyUI indisponible (app/graph introuvable)"), code: "no_app" };
        }
        return {
            data: graph.nodes.map((n) => ({
                id: n.id, type: n.type, title: n.title || n.comfyClass || n.type,
                pos: Array.isArray(n.pos) ? [n.pos[0], n.pos[1]] : null,
            })),
        };
    },
});

registerTool({
    name: "get_node_by_id",
    description: "Détail complet d'un nœud : type, titre, mode, position, taille, properties, widgets (nom/type/valeur), entrées et sorties.",
    schema: {
        type: "object",
        properties: { id: { type: ["number", "string"], description: "Identifiant du nœud (vu dans describe_workflow / list_nodes)." } },
        required: ["id"],
    },
    mode: "read",
    async exec(args, ctx) {
        const r = findNode(ctx, args.id);
        if (r.error) return r;
        const n = r.node;
        return {
            data: {
                id: n.id, type: n.type, title: n.title || n.comfyClass || n.type,
                mode: n.mode, pos: Array.isArray(n.pos) ? n.pos : null, size: n.size || null,
                properties: n.properties || {},
                widgets: Array.isArray(n.widgets)
                    ? n.widgets.filter((w) => w && w.name !== undefined).map((w) => ({ name: w.name, type: w.type, value: w.value }))
                    : [],
                inputs: Array.isArray(n.inputs) ? n.inputs.map((i) => ({ name: i.name, type: i.type, link: i.link === undefined ? null : i.link })) : [],
                outputs: Array.isArray(n.outputs) ? n.outputs.map((o) => ({ name: o.name, type: o.type, links: o.links || [] })) : [],
            },
        };
    },
});

registerTool({
    name: "get_node_widgets",
    description: "Tous les widgets d'un nœud : nom, type, valeur courante et valeurs possibles (combo).",
    schema: {
        type: "object",
        properties: { id: { type: ["number", "string"], description: "Identifiant du nœud." } },
        required: ["id"],
    },
    mode: "read",
    async exec(args, ctx) {
        const r = findNode(ctx, args.id);
        if (r.error) return r;
        const n = r.node;
        const widgets = Array.isArray(n.widgets)
            ? n.widgets.filter((w) => w && w.name !== undefined).map((w) => {
                const out = { name: w.name, type: w.type, value: w.value };
                if (w.options && Array.isArray(w.options.values)) out.options = { values: w.options.values };
                return out;
            })
            : [];
        return { data: { id: n.id, widget_count: widgets.length, widgets: widgets } };
    },
});

registerTool({
    name: "get_node_widget",
    description: "Valeur d'UN widget précis d'un nœud (recherche du nom insensible à la casse).",
    schema: {
        type: "object",
        properties: {
            id: { type: ["number", "string"], description: "Identifiant du nœud." },
            widget: { type: "string", description: "Nom du widget (ex. 'steps', 'ckpt_name')." },
        },
        required: ["id", "widget"],
    },
    mode: "read",
    async exec(args, ctx) {
        const r = findNode(ctx, args.id);
        if (r.error) return r;
        const w = findWidget(r.node, args.widget);
        if (!w) {
            return {
                error: label(ctx, "bl.toolErr.widgetNotFound", { widget: String(args.widget), id: String(r.node.id) }, "widget '{widget}' introuvable sur le nœud #{id}"),
                code: "widget_not_found",
            };
        }
        const out = { id: r.node.id, name: w.name, type: w.type, value: w.value };
        if (w.options && Array.isArray(w.options.values)) out.options = { values: w.options.values };
        return { data: out };
    },
});

registerTool({
    name: "get_node_connections",
    description: "Connexions d'un nœud : entrées (nom/type + nœud source) et sorties (nom/type + nœuds cibles).",
    schema: {
        type: "object",
        properties: { id: { type: ["number", "string"], description: "Identifiant du nœud." } },
        required: ["id"],
    },
    mode: "read",
    async exec(args, ctx) {
        const r = findNode(ctx, args.id);
        if (r.error) return r;
        const graph = getGraph(ctx);
        const n = r.node;
        const resolveLink = (linkId) => {
            try {
                const l = graph && graph.links ? graph.links[linkId] : null;
                if (!l) return null;
                return { id: l.id, from: { id: l.origin_id, slot: l.origin_slot }, to: { id: l.target_id, slot: l.target_slot }, type: l.type };
            } catch { return null; }
        };
        const inputs = Array.isArray(n.inputs)
            ? n.inputs.map((i) => {
                const l = resolveLink(i.link);
                return {
                    name: i.name, type: i.type, link: i.link === undefined ? null : i.link,
                    source: l ? { id: l.from.id, slot: l.from.slot, title: nodeTitle(getNodeSafe(ctx, l.from.id)) } : null,
                };
            })
            : [];
        const outputs = Array.isArray(n.outputs)
            ? n.outputs.map((o) => ({
                name: o.name, type: o.type,
                targets: (o.links || []).map(resolveLink).filter(Boolean).map((l) => ({ id: l.to.id, slot: l.to.slot, title: nodeTitle(getNodeSafe(ctx, l.to.id)) })),
            }))
            : [];
        return { data: { id: n.id, inputs: inputs, outputs: outputs } };
    },
});

function getNodeSafe(ctx, id) {
    try { const r = findNode(ctx, id); return r.node || null; } catch { return null; }
}

registerTool({
    name: "get_object_info",
    description: "Définitions ComfyUI des types de nœuds (inputs, types, valeurs de combo). Sans argument : liste des classes disponibles. Avec class_type : définition complète de ce type.",
    schema: {
        type: "object",
        properties: { class_type: { type: "string", description: "Type de nœud ComfyUI (ex. 'KSampler'). Optionnel : absent ⇒ liste des classes." } },
        required: [],
    },
    mode: "read",
    async exec(args, ctx) {
        const cls = args.class_type ? String(args.class_type).trim() : "";
        const url = cls ? "/object_info/" + encodeURIComponent(cls) : "/object_info";
        let res;
        try { res = await sameOriginFetch(ctx, url, { method: "GET" }); }
        catch (e) { return { error: label(ctx, "bl.toolErr.fetchFailed", { status: 0 }, "requête ComfyUI échouée (HTTP {status})") + " (" + ((e && e.message) || e) + ")", code: "fetch_error" }; }
        let data = null;
        try { data = await res.json(); } catch { /* corps illisible → data null */ }
        if (!res || !res.ok) {
            return { error: label(ctx, "bl.toolErr.fetchFailed", { status: res ? res.status : 0 }, "requête ComfyUI échouée (HTTP {status})"), code: "fetch_error" };
        }
        if (!cls) {
            const classes = data && typeof data === "object" ? Object.keys(data) : [];
            return { data: { class_count: classes.length, classes: classes } };
        }
        const info = data && typeof data === "object" ? data[cls] : undefined;
        if (info === undefined) {
            return { error: label(ctx, "bl.toolErr.classUnknown", { class: cls }, "type de nœud '{class}' inconnu (get_object_info sans argument liste les types disponibles)"), code: "not_found" };
        }
        return { data: info };
    },
});

registerTool({
    name: "get_queue_status",
    description: "État de la file ComfyUI : nombre de jobs en cours et en attente (résumé, sans le graphe complet des prompts).",
    schema: { type: "object", properties: {}, required: [] },
    mode: "read",
    async exec(_args, ctx) {
        let res;
        try { res = await sameOriginFetch(ctx, "/queue", { method: "GET" }); }
        catch (e) { return { error: label(ctx, "bl.toolErr.fetchFailed", { status: 0 }, "requête ComfyUI échouée (HTTP {status})") + " (" + ((e && e.message) || e) + ")", code: "fetch_error" }; }
        let data = null;
        try { data = await res.json(); } catch { /* ignore */ }
        if (!res || !res.ok) {
            return { error: label(ctx, "bl.toolErr.fetchFailed", { status: res ? res.status : 0 }, "requête ComfyUI échouée (HTTP {status})"), code: "fetch_error" };
        }
        const summarize = (list) => (Array.isArray(list) ? list : []).map((e) => ({
            number: e && e[0] !== undefined ? e[0] : null,
            task_id: e && e[1] !== undefined ? e[1] : null,
            node_count: e && e[2] && typeof e[2] === "object" ? Object.keys(e[2]).length : null,
        }));
        return {
            data: {
                queue_running_count: Array.isArray(data && data.queue_running) ? data.queue_running.length : 0,
                queue_pending_count: Array.isArray(data && data.queue_pending) ? data.queue_pending.length : 0,
                running: summarize(data && data.queue_running),
                pending: summarize(data && data.queue_pending),
            },
        };
    },
});

registerTool({
    name: "get_execution_status",
    description: "État d'exécution : nombre de prompts restants (exec_info.queue_remaining) et nœud en cours d'exécution s'il est connu.",
    schema: { type: "object", properties: {}, required: [] },
    mode: "read",
    async exec(_args, ctx) {
        let res;
        try { res = await sameOriginFetch(ctx, "/prompt", { method: "GET" }); }
        catch (e) { return { error: label(ctx, "bl.toolErr.fetchFailed", { status: 0 }, "requête ComfyUI échouée (HTTP {status})") + " (" + ((e && e.message) || e) + ")", code: "fetch_error" }; }
        let data = null;
        try { data = await res.json(); } catch { /* ignore */ }
        if (!res || !res.ok) {
            return { error: label(ctx, "bl.toolErr.fetchFailed", { status: res ? res.status : 0 }, "requête ComfyUI échouée (HTTP {status})"), code: "fetch_error" };
        }
        const app = resolveApp(ctx);
        return {
            data: {
                queue_remaining: data && data.exec_info ? (data.exec_info.queue_remaining !== undefined ? data.exec_info.queue_remaining : null) : null,
                running_node_id: app && app.runningNodeId !== undefined ? app.runningNodeId : null,
            },
        };
    },
});

// ─── Mutations ('active', undoable : snapshot avant exec) ────────────────────

registerTool({
    name: "set_widget_value",
    description: "Change la valeur d'un widget (champ) d'un nœud. Les nombres sont bornés aux min/max du widget, les combos vérifiés contre la liste des valeurs possibles.",
    schema: {
        type: "object",
        properties: {
            id: { type: ["number", "string"], description: "Identifiant du nœud." },
            widget: { type: "string", description: "Nom du widget (ex. 'steps')." },
            value: { description: "Nouvelle valeur (nombre, texte ou booléen selon le widget)." },
        },
        required: ["id", "widget", "value"],
    },
    mode: "active",
    undoable: true,
    async exec(args, ctx) {
        const r = findNode(ctx, args.id);
        if (r.error) return r;
        const node = r.node;
        const w = findWidget(node, args.widget);
        if (!w) {
            return {
                error: label(ctx, "bl.toolErr.widgetNotFound", { widget: String(args.widget), id: String(node.id) }, "widget '{widget}' introuvable sur le nœud #{id}"),
                code: "widget_not_found",
            };
        }
        let v = args.value;
        const isCombo = w.type === "combo" || (w.options && Array.isArray(w.options.values));
        const isNumber = w.type === "number" || w.type === "slider" || typeof w.value === "number";
        const isToggle = w.type === "toggle" || w.type === "checkbox" || typeof w.value === "boolean";
        if (isCombo) {
            const vals = w.options && Array.isArray(w.options.values) ? w.options.values : null;
            if (vals) {
                const hit = vals.some((x) => String(x) === String(v));
                if (!hit) {
                    return {
                        error: label(ctx, "bl.toolErr.invalidValue", { detail: "'" + String(v) + "' ∉ [" + vals.slice(0, 30).map(String).join(", ") + "]" }, "valeur invalide : {detail}"),
                        code: "invalid_value",
                    };
                }
            }
            v = String(v);
        } else if (isNumber) {
            let n = Number(v);
            if (!Number.isFinite(n)) {
                return { error: label(ctx, "bl.toolErr.invalidValue", { detail: "'" + String(v) + "' n'est pas un nombre" }, "valeur invalide : {detail}"), code: "invalid_value" };
            }
            if (w.options) {
                if (w.options.min !== undefined && Number.isFinite(Number(w.options.min))) n = Math.max(Number(w.options.min), n);
                if (w.options.max !== undefined && Number.isFinite(Number(w.options.max))) n = Math.min(Number(w.options.max), n);
            }
            v = n;
        } else if (isToggle) {
            v = (v === true || v === "true" || v === 1 || v === "1" || v === "yes" || v === "on");
        } else {
            v = String(v === undefined || v === null ? "" : v);
        }
        try {
            w.value = v;
            if (typeof w.callback === "function") w.callback(v);
        } catch (e) {
            return { error: label(ctx, "bl.toolErr.exec", { error: (e && e.message) || String(e) }, "échec de l'outil : {error}"), code: "exec_error" };
        }
        dirtyCanvas(ctx);
        return {
            data: { node: node.id, widget: w.name, type: w.type, value: v },
            action: label(ctx, "bl.toolAct.setWidget", { name: nodeTitle(node), widget: w.name, value: String(v) }, "⚙️ {name} · {widget} = {value}"),
        };
    },
});

registerTool({
    name: "set_node_title",
    description: "Renomme le titre d'un nœud.",
    schema: {
        type: "object",
        properties: {
            id: { type: ["number", "string"], description: "Identifiant du nœud." },
            title: { type: "string", description: "Nouveau titre." },
        },
        required: ["id", "title"],
    },
    mode: "active",
    undoable: true,
    async exec(args, ctx) {
        const r = findNode(ctx, args.id);
        if (r.error) return r;
        const old = r.node.title;
        r.node.title = String(args.title);
        dirtyCanvas(ctx);
        return {
            data: { node: r.node.id, title: r.node.title, previous: old },
            action: label(ctx, "bl.toolAct.setTitle", { id: String(r.node.id), title: String(args.title) }, "🏷️ #{id} renommé « {title} »"),
        };
    },
});

const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

registerTool({
    name: "set_node_color",
    description: "Change la couleur d'un nœud (color = cadre, bgcolor = fond). Formats hexadécimaux (#RGB / #RRGGBB / #RRGGBBAA).",
    schema: {
        type: "object",
        properties: {
            id: { type: ["number", "string"], description: "Identifiant du nœud." },
            color: { type: "string", description: "Couleur du cadre, ex. '#FF8F00'." },
            bgcolor: { type: "string", description: "Couleur de fond (optionnel)." },
        },
        required: ["id", "color"],
    },
    mode: "active",
    undoable: true,
    async exec(args, ctx) {
        const r = findNode(ctx, args.id);
        if (r.error) return r;
        const color = String(args.color).trim();
        if (!COLOR_RE.test(color)) {
            return { error: label(ctx, "bl.toolErr.invalidValue", { detail: "couleur '" + color + "' (attendu #RGB/#RRGGBB)" }, "valeur invalide : {detail}"), code: "invalid_value" };
        }
        let bg = args.bgcolor !== undefined && args.bgcolor !== null ? String(args.bgcolor).trim() : undefined;
        if (bg !== undefined && !COLOR_RE.test(bg)) {
            return { error: label(ctx, "bl.toolErr.invalidValue", { detail: "couleur de fond '" + bg + "'" }, "valeur invalide : {detail}"), code: "invalid_value" };
        }
        const node = r.node;
        const previous = { color: node.color, bgcolor: node.bgcolor };
        node.color = color;
        if (bg !== undefined) node.bgcolor = bg;
        dirtyCanvas(ctx);
        return {
            data: { node: node.id, color: color, bgcolor: bg !== undefined ? bg : node.bgcolor, previous: previous },
            action: label(ctx, "bl.toolAct.setColor", { name: nodeTitle(node), color: color }, "🎨 {name} recoloré ({color})"),
        };
    },
});

registerTool({
    name: "move_node",
    description: "Déplace un nœud sur le canvas (coordonnées du graphe).",
    schema: {
        type: "object",
        properties: {
            id: { type: ["number", "string"], description: "Identifiant du nœud." },
            x: { type: "number", description: "Position X." },
            y: { type: "number", description: "Position Y." },
        },
        required: ["id", "x", "y"],
    },
    mode: "active",
    undoable: true,
    async exec(args, ctx) {
        const r = findNode(ctx, args.id);
        if (r.error) return r;
        const x = Number(args.x);
        const y = Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return { error: label(ctx, "bl.toolErr.invalidValue", { detail: "x/y doivent être des nombres" }, "valeur invalide : {detail}"), code: "invalid_value" };
        }
        const node = r.node;
        const previous = Array.isArray(node.pos) ? node.pos.slice() : null;
        node.pos = [x, y];
        dirtyCanvas(ctx);
        return {
            data: { node: node.id, pos: [x, y], previous: previous },
            action: label(ctx, "bl.toolAct.moveNode", { name: nodeTitle(node), x: String(x), y: String(y) }, "↔️ {name} déplacé ({x}, {y})"),
        };
    },
});

registerTool({
    name: "add_node",
    description: "Ajoute un nœud du type ComfyUI donné au workflow. Si le type est inconnu, l'erreur invite à vérifier avec get_object_info.",
    schema: {
        type: "object",
        properties: {
            class_type: { type: "string", description: "Type ComfyUI du nœud (ex. 'KSampler')." },
            x: { type: "number", description: "Position X (optionnel, défaut 0)." },
            y: { type: "number", description: "Position Y (optionnel, défaut 0)." },
            title: { type: "string", description: "Titre personnalisé (optionnel)." },
        },
        required: ["class_type"],
    },
    mode: "active",
    undoable: true,
    async exec(args, ctx) {
        const classType = String(args.class_type === undefined || args.class_type === null ? "" : args.class_type).trim();
        if (!classType) {
            return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "class_type manquant" }, "arguments invalides : {detail}"), code: "invalid_args" };
        }
        const graph = getGraph(ctx);
        if (!graph) {
            return { error: label(ctx, "bl.toolErr.noApp", {}, "workflow ComfyUI indisponible (app/graph introuvable)"), code: "no_app" };
        }
        // Forme défensive de création (selon la version LiteGraph/ComfyUI) :
        // hook de test → window.LiteGraph.createNode → graph.createNode.
        let node = null;
        try {
            if (ctx && typeof ctx.createNodeImpl === "function") node = ctx.createNodeImpl(classType, ctx);
            else if (typeof window !== "undefined" && window.LiteGraph && typeof window.LiteGraph.createNode === "function") node = window.LiteGraph.createNode(classType);
            else if (typeof graph.createNode === "function") node = graph.createNode(classType);
        } catch { node = null; }
        if (!node) {
            // createNode renvoie null pour un type inconnu ET si l'API n'est
            // pas exposée : erreur structurée (jamais de crash).
            return {
                error: label(ctx, "bl.toolErr.addFailed", { class: classType }, "création du nœud '{class}' impossible (API LiteGraph indisponible ou type inconnu — vérifie avec get_object_info)"),
                code: "add_failed",
            };
        }
        const x = Number(args.x);
        const y = Number(args.y);
        try { node.pos = [Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0]; } catch { /* pos immuable ? tant pis */ }
        if (args.title !== undefined && args.title !== null) { try { node.title = String(args.title); } catch { /* ignore */ } }
        let added = false;
        try { if (typeof graph.add === "function") { graph.add(node); added = true; } } catch { /* forme inattendue */ }
        if (!added && Array.isArray(graph.nodes)) {
            try { graph.nodes.push(node); added = true; } catch { /* ignore */ }
        }
        if (!added) {
            return { error: label(ctx, "bl.toolErr.addFailed", { class: classType }, "création du nœud '{class}' impossible (API LiteGraph indisponible ou type inconnu — vérifie avec get_object_info)"), code: "add_failed" };
        }
        dirtyCanvas(ctx);
        return {
            data: { id: node.id, type: node.type || classType, title: node.title },
            action: label(ctx, "bl.toolAct.addNode", { class: classType, id: String(node.id) }, "➕ {class} ajouté (id {id})"),
        };
    },
});

registerTool({
    name: "remove_node",
    description: "Supprime un nœud du workflow (les liens connectés sont coupés par l'API du graphe).",
    schema: {
        type: "object",
        properties: { id: { type: ["number", "string"], description: "Identifiant du nœud à supprimer." } },
        required: ["id"],
    },
    mode: "active",
    undoable: true,
    async exec(args, ctx) {
        const r = findNode(ctx, args.id);
        if (r.error) return r;
        const graph = getGraph(ctx);
        const node = r.node;
        const title = nodeTitle(node);
        let removed = false;
        try {
            if (graph && typeof graph.remove === "function") { graph.remove(node); removed = true; }
            else if (node && typeof node.remove === "function") { node.remove(); removed = true; }
            else if (graph && Array.isArray(graph.nodes)) {
                const i = graph.nodes.indexOf(node);
                if (i >= 0) { graph.nodes.splice(i, 1); removed = true; }
            }
        } catch (e) {
            return { error: label(ctx, "bl.toolErr.removeFailed", { error: (e && e.message) || String(e) }, "suppression impossible : {error}"), code: "remove_failed" };
        }
        if (!removed) {
            return { error: label(ctx, "bl.toolErr.removeFailed", { error: "aucune API compatible (graph.remove/node.remove)" }, "suppression impossible : {error}"), code: "remove_failed" };
        }
        dirtyCanvas(ctx);
        return {
            data: { removed: node.id, title: title },
            action: label(ctx, "bl.toolAct.removeNode", { name: title }, "🗑️ {name} supprimé"),
        };
    },
});

registerTool({
    name: "connect_nodes",
    description: "Connecte la sortie from_slot du nœud from_id à l'entrée to_input du nœud to_id (to_input = nom d'entrée ou index).",
    schema: {
        type: "object",
        properties: {
            from_id: { type: ["number", "string"], description: "Nœud source." },
            from_slot: { type: "number", description: "Index de la sortie du nœud source." },
            to_id: { type: ["number", "string"], description: "Nœud cible." },
            to_input: { type: ["number", "string"], description: "Nom (ex. 'model') ou index de l'entrée du nœud cible." },
        },
        required: ["from_id", "from_slot", "to_id", "to_input"],
    },
    mode: "active",
    undoable: true,
    async exec(args, ctx) {
        const rFrom = findNode(ctx, args.from_id);
        if (rFrom.error) return rFrom;
        const rTo = findNode(ctx, args.to_id);
        if (rTo.error) return rTo;
        const nodeOut = rFrom.node;
        const nodeIn = rTo.node;
        const fromSlot = Number(args.from_slot);
        if (!Number.isFinite(fromSlot) || fromSlot < 0 || !Array.isArray(nodeOut.outputs) || fromSlot >= nodeOut.outputs.length) {
            return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "sortie " + String(args.from_slot) + " inexistante sur #" + String(nodeOut.id) }, "arguments invalides : {detail}"), code: "invalid_args" };
        }
        let toInput = args.to_input;
        if (typeof toInput === "string") {
            const idx = (Array.isArray(nodeIn.inputs) ? nodeIn.inputs : [])
                .findIndex((inp) => inp && String(inp.name).toLowerCase() === toInput.toLowerCase().trim());
            if (idx < 0) {
                return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "entrée '" + toInput + "' inexistante sur #" + String(nodeIn.id) }, "arguments invalides : {detail}"), code: "invalid_args" };
            }
            toInput = idx;
        } else {
            toInput = Number(toInput);
            if (!Number.isFinite(toInput) || toInput < 0 || !Array.isArray(nodeIn.inputs) || toInput >= nodeIn.inputs.length) {
                return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "entrée " + String(args.to_input) + " inexistante sur #" + String(nodeIn.id) }, "arguments invalides : {detail}"), code: "invalid_args" };
            }
        }
        let link = null;
        try { link = nodeOut.connect(fromSlot, nodeIn, toInput); }
        catch (e) {
            return { error: label(ctx, "bl.toolErr.connectFailed", { error: (e && e.message) || String(e) }, "connexion impossible : {error}"), code: "connect_failed" };
        }
        dirtyCanvas(ctx);
        return {
            data: {
                connected: true, link: link === undefined ? null : link,
                from: { id: nodeOut.id, slot: fromSlot, title: nodeTitle(nodeOut) },
                to: { id: nodeIn.id, input: typeof args.to_input === "string" ? args.to_input : toInput, title: nodeTitle(nodeIn) },
            },
            action: label(ctx, "bl.toolAct.connect", { from: nodeTitle(nodeOut), to: nodeTitle(nodeIn) }, "🔗 {from} → {to}"),
        };
    },
});

registerTool({
    name: "disconnect_nodes",
    description: "Déconnecte : (from_id + from_slot [+ to_id]) coupe sur la sortie donnée, sinon (to_id + to_input) coupe l'entrée donnée du nœud cible.",
    schema: {
        type: "object",
        properties: {
            from_id: { type: ["number", "string"], description: "Nœud source (avec from_slot)." },
            from_slot: { type: "number", description: "Index de sortie du nœud source." },
            to_id: { type: ["number", "string"], description: "Nœud cible." },
            to_input: { type: ["number", "string"], description: "Nom ou index de l'entrée à couper sur le nœud cible." },
        },
        required: [],
    },
    mode: "active",
    undoable: true,
    async exec(args, ctx) {
        const hasFrom = args.from_id !== undefined && args.from_id !== null && args.from_slot !== undefined && args.from_slot !== null;
        const hasTo = args.to_id !== undefined && args.to_id !== null;
        if (!hasFrom && !hasTo) {
            return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "fournir from_id+from_slot et/ou to_id" }, "arguments invalides : {detail}"), code: "invalid_args" };
        }
        let disconnected = 0;
        if (hasFrom) {
            const rFrom = findNode(ctx, args.from_id);
            if (rFrom.error) return rFrom;
            const nodeOut = rFrom.node;
            const slot = Number(args.from_slot);
            if (!Number.isFinite(slot) || slot < 0 || !Array.isArray(nodeOut.outputs) || slot >= nodeOut.outputs.length) {
                return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "sortie " + String(args.from_slot) + " inexistante sur #" + String(nodeOut.id) }, "arguments invalides : {detail}"), code: "invalid_args" };
            }
            if (hasTo) {
                const rTo = findNode(ctx, args.to_id);
                if (rTo.error) return rTo;
                try { if (nodeOut.disconnectOutput(slot, rTo.node)) disconnected++; }
                catch (e) { return { error: label(ctx, "bl.toolErr.disconnectFailed", { error: (e && e.message) || String(e) }, "déconnexion impossible : {error}"), code: "disconnect_failed" }; }
            } else {
                const before = Array.isArray(nodeOut.outputs[slot].links) ? nodeOut.outputs[slot].links.length : 0;
                try { nodeOut.disconnectOutput(slot); disconnected = before; }
                catch (e) { return { error: label(ctx, "bl.toolErr.disconnectFailed", { error: (e && e.message) || String(e) }, "déconnexion impossible : {error}"), code: "disconnect_failed" }; }
            }
        } else {
            const rTo = findNode(ctx, args.to_id);
            if (rTo.error) return rTo;
            const nodeIn = rTo.node;
            let toInput = args.to_input;
            if (typeof toInput === "string") {
                const idx = (Array.isArray(nodeIn.inputs) ? nodeIn.inputs : [])
                    .findIndex((inp) => inp && String(inp.name).toLowerCase() === toInput.toLowerCase().trim());
                if (idx < 0) {
                    return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "entrée '" + toInput + "' inexistante sur #" + String(nodeIn.id) }, "arguments invalides : {detail}"), code: "invalid_args" };
                }
                toInput = idx;
            } else if (toInput === undefined || toInput === null) {
                return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "to_input requis quand seul to_id est fourni" }, "arguments invalides : {detail}"), code: "invalid_args" };
            } else {
                toInput = Number(toInput);
                if (!Number.isFinite(toInput) || toInput < 0 || !Array.isArray(nodeIn.inputs) || toInput >= nodeIn.inputs.length) {
                    return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "entrée " + String(args.to_input) + " inexistante sur #" + String(nodeIn.id) }, "arguments invalides : {detail}"), code: "invalid_args" };
                }
            }
            try { if (nodeIn.disconnectInput(toInput)) disconnected++; }
            catch (e) { return { error: label(ctx, "bl.toolErr.disconnectFailed", { error: (e && e.message) || String(e) }, "déconnexion impossible : {error}"), code: "disconnect_failed" }; }
        }
        dirtyCanvas(ctx);
        return {
            data: { disconnected: disconnected },
            action: label(ctx, "bl.toolAct.disconnect", { from: nodeTitle(getNodeSafe(ctx, args.from_id)), to: nodeTitle(getNodeSafe(ctx, args.to_id)) }, "✂️ {from} ✕ {to}"),
        };
    },
});

// ─── Exécution ('active', NON undoable : un snapshot ne peut pas arrêter un job) ──

registerTool({
    name: "queue_prompt",
    description: "Lance la génération (met le workflow courant dans la file ComfyUI). ATTENTION : c'est une action d'exécution réelle.",
    schema: {
        type: "object",
        properties: { batch: { type: "number", description: "Nombre d'exécutions (optionnel, défaut 1)." } },
        required: [],
    },
    mode: "active",
    async exec(args, ctx) {
        const app = resolveApp(ctx);
        if (!app || typeof app.queuePrompt !== "function") {
            return { error: label(ctx, "bl.toolErr.queueFailed", {}, "lancement impossible (app.queuePrompt indisponible)"), code: "queue_failed" };
        }
        const batch = Number(args.batch);
        try {
            await app.queuePrompt(0, Number.isFinite(batch) && batch >= 1 ? batch : 1);
        } catch (e) {
            return { error: label(ctx, "bl.toolErr.queueFailed", {}, "lancement impossible (app.queuePrompt indisponible)") + " (" + ((e && e.message) || e) + ")", code: "queue_failed" };
        }
        return {
            data: { queued: true, batch: Number.isFinite(batch) && batch >= 1 ? batch : 1 },
            action: label(ctx, "bl.toolAct.queue", {}, "▶️ Génération lancée"),
        };
    },
});

registerTool({
    name: "interrupt",
    description: "Interrompt l'exécution ComfyUI en cours (POST /interrupt). N'a d'effet que si une génération tourne.",
    schema: { type: "object", properties: {}, required: [] },
    mode: "active",
    async exec(_args, ctx) {
        const api = resolveApi(ctx);
        // Chaîne défensive : api.interrupt (nouvelles versions) → POST /interrupt.
        try {
            if (api && typeof api.interrupt === "function") {
                await api.interrupt();
                return { data: { interrupted: true, via: "api.interrupt" }, action: label(ctx, "bl.toolAct.interrupt", {}, "⏹️ Exécution interrompue") };
            }
        } catch (e) {
            return { error: label(ctx, "bl.toolErr.interruptFailed", { error: (e && e.message) || String(e) }, "interruption impossible : {error}"), code: "interrupt_failed" };
        }
        let res = null;
        try { res = await sameOriginFetch(ctx, "/interrupt", { method: "POST" }); }
        catch (e) { return { error: label(ctx, "bl.toolErr.interruptFailed", { error: (e && e.message) || String(e) }, "interruption impossible : {error}"), code: "interrupt_failed" }; }
        if (!res || !res.ok) {
            return { error: label(ctx, "bl.toolErr.interruptFailed", { error: "HTTP " + (res ? res.status : 0) }, "interruption impossible : {error}"), code: "interrupt_failed" };
        }
        return { data: { interrupted: true, via: "POST /interrupt" }, action: label(ctx, "bl.toolAct.interrupt", {}, "⏹️ Exécution interrompue") };
    },
});

// ─── Boucle d'agents PURE (tool_calls) ───────────────────────────────────────

/**
 * Nom d'un tool_call. Contrat backend (étape 1) : forme provider VERBATIM
 * `{id, type, function:{name, arguments}}` — on lit donc `.function.name`.
 * Tolérance : l'ancienne forme normalisée `{id, name, arguments}` reste lisible
 * (rétrocompat lecture), mais l'ECHO, lui, repasse en forme provider.
 */
function toolCallName(tc) {
    if (!tc || typeof tc !== "object") return "";
    if (tc.function && typeof tc.function === "object" && typeof tc.function.name === "string") {
        return tc.function.name;
    }
    return typeof tc.name === "string" ? tc.name : "";
}

/** Arguments bruts d'un tool_call (STRING à JSON.parse) — `.function.arguments`. */
function toolCallArguments(tc) {
    if (!tc || typeof tc !== "object") return "";
    if (tc.function && typeof tc.function === "object") return tc.function.arguments;
    return tc.arguments;
}

/**
 * Garantit la forme provider `{id, type:'function', function:{name, arguments}}`
 * pour l'ECHO du message assistant renvoyé au provider au tour suivant.
 *
 * - forme provider (`.function`) : renvoyée TELLE QUELLE (même référence) —
 *   l'écho est verbatim, donc TOUJOURS conforme au fournisseur ; `type` est
 *   complété à 'function' seulement s'il manque ;
 * - ancienne forme normalisée `{id, name, arguments}` : reconstruite en forme
 *   provider (défense en profondeur si un backend plus ancien est déployé) ;
 * - entrée inexploitable (ni `.function` ni `.name`) : `null` (ignorée).
 */
function normalizeToolCallForEcho(tc) {
    if (!tc || typeof tc !== "object") return null;
    if (tc.function && typeof tc.function === "object") {
        if (tc.type === "function") return tc; // verbatim (même référence)
        return Object.assign({}, tc, { type: "function" });
    }
    const name = typeof tc.name === "string" ? tc.name : "";
    if (!name) return null;
    let args = tc.arguments;
    if (args === undefined || args === null) args = "";
    else if (typeof args !== "string") {
        try { args = JSON.stringify(args); } catch { args = ""; }
    }
    return {
        id: tc.id !== undefined && tc.id !== null ? tc.id : "",
        type: "function",
        function: { name: name, arguments: args },
    };
}

/** Extrait les tool_calls d'une réponse backend (contrat étape 1, forme provider). */
function extractToolCalls(resp) {
    if (!resp || !Array.isArray(resp.tool_calls)) return [];
    return resp.tool_calls.filter((tc) => tc && typeof tc === "object" && toolCallName(tc).length > 0);
}

/** arguments = STRING à JSON.parse (contrat backend) ; objet déjà parsé accepté. */
function parseToolArguments(raw) {
    if (raw === undefined || raw === null || raw === "") return { ok: true, value: {} };
    if (typeof raw === "object") {
        if (Array.isArray(raw)) return { ok: false, error: "arguments d'outil : tableau au lieu d'objet" };
        return { ok: true, value: raw };
    }
    if (typeof raw !== "string") return { ok: false, error: "arguments d'outil illisibles (" + typeof raw + ")" };
    let v;
    try { v = JSON.parse(raw); }
    catch (e) { return { ok: false, error: "JSON invalide : " + ((e && e.message) || e) }; }
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "arguments d'outil : JSON non-objet" };
    return { ok: true, value: v };
}

const TOOL_CONTENT_MAX = 8000;

/** Contenu du message role:'tool' réinjecté au LLM (sérialisable, borné). */
function renderToolContent(result) {
    if (!result || typeof result !== "object") return JSON.stringify({ error: "résultat d'outil vide" });
    if (result.ok) {
        const data = result.data !== undefined ? result.data : null;
        let s;
        try { s = typeof data === "string" ? data : JSON.stringify(data); }
        catch { s = String(data); }
        if (s.length > TOOL_CONTENT_MAX) s = s.slice(0, TOOL_CONTENT_MAX) + "…[tronqué]";
        return s;
    }
    let errPayload = { error: result.error || "erreur inconnue", code: result.code || "error" };
    try { return JSON.stringify(errPayload); } catch { return '{"error":"erreur inconnue"}'; }
}

/**
 * runToolLoop — boucle d'agents PURE (aucun DOM) :
 *   send(messages)    → Promise<resp> : un tour vers le backend ;
 *   dispatch(name,args) → Promise<résultat dispatchToolCall> ;
 *   onTurn(turn)      → hook UI (indicateur de réflexion) ;
 *   onToolCall(result, tc, index) → hook UI (ligne d'action + bouton Annuler).
 *
 * À chaque réponse : si resp.tool_calls est non vide → dispatch séquentiel,
 * echo assistant dans la forme provider `{id, type:'function', function:{...}}`
 * (le backend relaie ces tool_calls VERBATIM depuis le provider, donc l'echo
 * reste conforme — DeepSeek exige `type` + wrapper `function`) + messages
 * role:'tool' (tool_call_id + contenu) → tour suivant. Sinon → réponse finale
 * (resp.output). Garde anti-boucle : maxTurns (le chemin texte historique
 * plafonne déjà à 100 tours).
 *
 * Retour : { ok, finalReply, turns } | { ok:false, sendError?, turns, phase }
 *          | { ok:false, unexpected:true, resp, turns } | { ok:false, exhausted:true, turns, lastOutput }.
 */
async function runToolLoop(opts) {
    const o = opts || {};
    const send = typeof o.send === "function" ? o.send : null;
    const dispatch = typeof o.dispatch === "function" ? o.dispatch : function (name) {
        return { ok: false, code: "unknown_tool", error: "outil '" + name + "' inconnu (dispatcher absent)" };
    };
    const maxTurns = Number.isFinite(Number(o.maxTurns)) && Number(o.maxTurns) >= 1 ? Number(o.maxTurns) : 100;
    const convo = Array.isArray(o.messages) ? o.messages.slice() : [];
    let turns = 0;
    let lastOutput = "";

    if (!send) return { ok: false, sendError: new Error("runToolLoop: send() manquant"), turns: 0, phase: "first" };

    while (turns < maxTurns) {
        turns++;
        if (typeof o.onTurn === "function") { try { o.onTurn(turns); } catch { /* hook UI : non bloquant */ } }
        let resp;
        try { resp = await send(convo); }
        catch (e) {
            return { ok: false, sendError: e, turns: turns, phase: turns === 1 ? "first" : "later" };
        }
        const tcs = extractToolCalls(resp);
        if (!tcs.length) {
            const out = resp && resp.output !== undefined && resp.output !== null ? String(resp.output) : "";
            if (!out) {
                // Ni tool_calls ni texte : réponse inattendue (repli 4b possible).
                return { ok: false, unexpected: true, resp: resp, turns: turns };
            }
            return { ok: true, finalReply: out, turns: turns, resp: resp };
        }
        lastOutput = resp && resp.output !== undefined && resp.output !== null ? String(resp.output) : "";
        // Echo du tour assistant : chaque tool_call est renvoyé dans la forme
        // provider (verbatim si le backend a déjà relayé `{id, type, function}` ;
        // sinon reconstruit — défense en profondeur). Le champ content garde le
        // texte éventuellement produit à côté des appels.
        const echoCalls = [];
        for (let k = 0; k < tcs.length; k++) {
            const echo = normalizeToolCallForEcho(tcs[k]);
            if (echo) echoCalls.push(echo);
        }
        convo.push({ role: "assistant", content: lastOutput, tool_calls: echoCalls });
        for (let i = 0; i < tcs.length; i++) {
            const tc = tcs[i];
            const parsed = parseToolArguments(toolCallArguments(tc));
            const result = parsed.ok
                ? await dispatch(toolCallName(tc), parsed.value)
                : { ok: false, code: "bad_arguments", error: parsed.error };
            if (typeof o.onToolCall === "function") { try { o.onToolCall(result, tc, i); } catch { /* hook UI : non bloquant */ } }
            convo.push({
                role: "tool",
                tool_call_id: tc.id !== undefined && tc.id !== null ? tc.id : "call_" + i,
                name: toolCallName(tc),
                content: renderToolContent(result),
            });
        }
    }
    return { ok: false, exhausted: true, turns: maxTurns, lastOutput: lastOutput };
}

// ─── Repli 4b : détection DÉLIMITÉE d'un fournisseur sans support tools ──────

/**
 * detectToolsUnsupported(resp, err) — vrai uniquement sur des signaux CLAIRS
 * de refus du tool-calling (message d'erreur payload OU sortie du modèle).
 * Une 401 auth, une 5xx réseau/serveur ou un texte ordinaire ne déclenchent
 * PAS la détection. Appelé par le chat UNIQUEMENT au 1ᵉʳ tour du mode actif.
 */
function detectToolsUnsupported(resp, err) {
    const hay = [];
    if (err) {
        if (err.message) hay.push(String(err.message));
        try { if (err.data !== undefined && err.data !== null) hay.push(JSON.stringify(err.data).slice(0, 2000)); } catch { /* ignore */ }
        if (typeof err.body === "string") hay.push(err.body.slice(0, 2000));
    }
    if (resp) {
        if (typeof resp.error === "string") hay.push(resp.error);
        if (typeof resp.detail === "string") hay.push(resp.detail);
        if (typeof resp.output === "string") hay.push(resp.output.slice(0, 2000));
    }
    const s = hay.join(" | ").toLowerCase();
    if (!s) return false;
    const patterns = [
        /tools?\s+(are|is)?\s*not\s+(supported|available|enabled|allowed)/,
        /(does\s+not|doesnt|doesn't|cannot|can't|cant)\s+(support|use|handle|accept)\s+(tool|function)/,
        /(tool|function)\s+(calling|use)\s+(is\s+)?not\s+supported/,
        /unsupported\s+(parameter|field|argument|body)[^|]{0,80}\btools?\b/,
        /unexpected\s+(keyword\s+)?argument[^|]{0,80}\btools?\b/,
        /unrecognized\s+(keyword\s+)?argument[^|]{0,80}\btools?\b/,
        /\btools?\b[^|]{0,40}not\s+support/,
        /\bnot\s+support[^|]{0,40}\btools?\b/,
    ];
    return patterns.some((re) => re.test(s));
}

// ─── Exposition ──────────────────────────────────────────────────────────────

const BlobbyTools = {
    MODES: MODES,
    MODE_RANK: MODE_RANK,
    normalizeMode: normalizeMode,
    listTools: listTools,
    getToolsForMode: getToolsForMode,
    registerTool: registerTool,
    dispatchToolCall: dispatchToolCall,
    UNDO_LIMIT: UNDO_LIMIT,
    pushUndoSnapshot: pushUndoSnapshot,
    undoSnapshot: undoSnapshot,
    undoLast: undoLast,
    canUndo: canUndo,
    canUndoId: canUndoId,
    clearUndo: clearUndo,
    extractToolCalls: extractToolCalls,
    toolCallName: toolCallName,
    toolCallArguments: toolCallArguments,
    normalizeToolCallForEcho: normalizeToolCallForEcho,
    parseToolArguments: parseToolArguments,
    renderToolContent: renderToolContent,
    runToolLoop: runToolLoop,
    detectToolsUnsupported: detectToolsUnsupported,
    TOOL_REGISTRY: TOOL_REGISTRY,
};

export default BlobbyTools;
export {
    MODES, MODE_RANK, normalizeMode,
    listTools, getToolsForMode, registerTool, dispatchToolCall,
    UNDO_LIMIT, pushUndoSnapshot, undoSnapshot, undoLast, canUndo, canUndoId, clearUndo,
    extractToolCalls, parseToolArguments, renderToolContent, runToolLoop, detectToolsUnsupported,
    toolCallName, toolCallArguments, normalizeToolCallForEcho,
    TOOL_REGISTRY,
};

// Exposition globale (console / étape 3 : dropdown de mode, facette outils).
if (typeof window !== "undefined") {
    window.BlobbyTools = BlobbyTools;
}