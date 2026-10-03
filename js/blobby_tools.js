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
 * Accès shell (barrière supplémentaire, orthogonale au mode) : l'outil
 * `run_shell` (mode 'active') porte `requiresShell: true`. Il n'est proposé au
 * LLM que si `getToolsForMode(mode, { shellAccess: true })` (1ʳᵉ barrière
 * shell), refusé par le dispatcher sans `ctx.shellAccess` (2ᵉ) et refusé par la
 * route serveur POST /aih/blobby/exec tant que l'état persisté ne l'autorise
 * pas (3ᵉ). Défaut = désactivé (fail-safe : absent/faux ⇒ refus).
 *
 * SUBGRAPHS (frontend « Subgraph Blueprints », root.subgraphs = Map<UUID,
 * Subgraph>) : les outils peuvent cibler un nœud INTERNE en passant
 * `subgraph` (UUID, nom, ou 'current'). Résolution/refus détaillés dans la
 * section dédiée plus bas. Les mutations internes passent par le MÊME
 * snapshot (serialize() racine embarque definitions.subgraphs pour tous les
 * subgraphs instanciés) — un subgraph non instancié est refusé (undo-safe).
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
 * Recherche locale d'un nœud dans UN graphe (LGraph ou Subgraph).
 * graph.nodes peut être un ARRAY (LiteGraph historique) ou un MAP (formes
 * défensives) ; getNodeById existe selon les versions.
 */
function findNodeInGraph(graph, id) {
    if (!graph) return null;
    let node = null;
    try {
        if (typeof graph.getNodeById === "function") node = graph.getNodeById(id) || null;
    } catch { /* forme inattendue → résolution manuelle */ }
    if (!node && Array.isArray(graph.nodes)) {
        node = graph.nodes.find((n) => n && String(n.id) === String(id)) || null;
    }
    if (!node && graph.nodes && typeof graph.nodes === "object" && !Array.isArray(graph.nodes)) {
        node = graph.nodes[String(id)] || graph.nodes[Number(id)] || null;
    }
    return node;
}

/**
 * Retrouve un nœud par id. Par défaut : graphe RACINE (comportement
 * historique). `opts.subgraph` (UUID, nom exact, ou "current") cible un
 * subgraph — l'id est alors l'id LOCAL dans ce subgraph. Un id au format
 * locator `"<uuid-subgraph>:<id-local>"` (frontend Subgraph Blueprints) est
 * aussi accepté. Retourne { node, subgraph, entry } ou { error, code }.
 */
function findNode(ctx, id, opts) {
    if (id === undefined || id === null || id === "") {
        return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "id manquant" }, "arguments invalides : {detail}"), code: "invalid_args" };
    }
    const graph = getGraph(ctx);
    if (!graph) {
        return { error: label(ctx, "bl.toolErr.noApp", {}, "workflow ComfyUI indisponible (app/graph introuvable)"), code: "no_app" };
    }
    const ref = opts && opts.subgraph !== undefined && opts.subgraph !== null ? String(opts.subgraph).trim() : "";
    let scope = null;
    let entry = null;
    let localId = id;
    if (ref) {
        const rs = resolveSubgraphRef(ctx, ref);
        if (rs.error) return rs;
        scope = rs.subgraph;
        entry = rs.entry;
    } else if (typeof id === "string") {
        // Locator `"<uuid-subgraph>:<id-local>"` : l'id local est cherché dans
        // ce subgraph (format du frontend, les ids de nœuds ne contiennent
        // jamais ':' — parseNodeId l'interdit).
        const i = id.indexOf(":");
        if (i > 0 && UUID_RE.test(id.slice(0, i))) {
            const rs = resolveSubgraphRef(ctx, id.slice(0, i));
            if (rs.error) return rs;
            scope = rs.subgraph;
            entry = rs.entry;
            localId = id.slice(i + 1);
        }
    }
    const node = findNodeInGraph(scope || graph, localId);
    if (!node) {
        if (scope) {
            return {
                error: label(ctx, "bl.toolErr.nodeNotFoundInSubgraph", { id: String(localId), name: String(scope.name || "?"), sg: String(scope.id) }, "nœud #{id} introuvable dans le subgraph « {name} » (#{sg})"),
                code: "not_found",
            };
        }
        return { error: label(ctx, "bl.toolErr.nodeNotFound", { id: String(id) }, "nœud #{id} introuvable"), code: "not_found" };
    }
    if (entry && !entry.reachable) {
        // Pas d'instance dans le workflow ⇒ absent du serialize() racine ⇒
        // aucune action sans possibilité d'annulation (règle undo-safe).
        return {
            error: label(ctx, "bl.toolErr.subgraphUnreachable", { ref: entry.id }, "subgraph '{ref}' non instancié dans le workflow (aucun nœud SubgraphNode) — action impossible : il n'est pas couvert par l'annulation"),
            code: "subgraph_unreachable",
        };
    }
    return { node: node, subgraph: scope, entry: entry };
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

// ─── Subgraphs (frontend « Subgraph Blueprints ») ────────────────────────────
// API réellement disponible (frontend ComfyUI récent — vérifié sur la source
// 1.47.11 de référence du pack) :
//   - `app.rootGraph.subgraphs` : Map<UUID, Subgraph> (registre central) ;
//   - `Subgraph extends LGraph` → `.nodes`, `.id`, `.name`, `.inputs`,
//     `.outputs`, `.rootGraph` ;
//   - un nœud instance expose `.isSubgraphNode()` + `.subgraph` ;
//   - navigation : `app.canvas.subgraph` (subgraph ouvert) + `canvas.setGraph
//     (g)` / `canvas.openSubgraph(sg, fromNode)` ; retour : `setGraph(root)`.
//   - sérialisation : le serialize() RACINE embarque `definitions.subgraphs`
//     pour tous les subgraphs UTILISÉS (instanciés) ⇒ le snapshot undo les
//     couvre ; un subgraph du registre sans nœud instance n'est pas sérialisé
//     et toute action de nœud le ciblant est refusée (pas d'undo ⇒ pas de
//     mutation) — `list_subgraphs` le signale `reachable:false`.

const SUBGRAPH_CURRENT_ALIASES = ["current", "open", "active", "this", "courant"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Canvas ComfyUI (ctx.canvas prioritaire, puis app.canvas). */
function resolveCanvas(ctx) {
    if (ctx && ctx.canvas) return ctx.canvas;
    const app = resolveApp(ctx);
    return (app && app.canvas) || null;
}

/** Subgraph actuellement ouvert dans le canvas (null si graphe racine). */
function activeSubgraph(ctx) {
    const canvas = resolveCanvas(ctx);
    if (!canvas) return null;
    if (canvas.subgraph) return canvas.subgraph;
    // Forme défensive : certains frontends posent canvas.graph = subgraph.
    const g = canvas.graph;
    if (g && g.rootGraph && g.rootGraph !== g && Array.isArray(g.nodes)) return g;
    return null;
}

/** Subgraph référencé par un nœud instance (isSubgraphNode()/.subgraph). */
function subgraphIdOf(node) {
    if (!node || typeof node !== "object") return null;
    try {
        if (typeof node.isSubgraphNode === "function" && node.isSubgraphNode() && node.subgraph) return node.subgraph;
    } catch { /* API capricieuse → forme suivante */ }
    if (node.subgraph && typeof node.subgraph === "object") return node.subgraph;
    return null;
}

/**
 * Parcourt la hiérarchie depuis le graphe racine : Map id → { subgraph, path,
 * parent_id, instances, reachable:true } pour chaque subgraph INSTANCIÉ.
 */
function collectSubgraphs(ctx) {
    const out = new Map();
    const root = getGraph(ctx);
    if (!root) return out;
    const visit = (graph, path, parentId) => {
        const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
        for (const n of nodes) {
            const sg = subgraphIdOf(n);
            if (!sg || sg.id === undefined || sg.id === null) continue;
            const sid = String(sg.id);
            let entry = out.get(sid);
            if (!entry) {
                entry = { id: sid, subgraph: sg, path: path.concat(sid), parent_id: parentId, instances: [], reachable: true };
                out.set(sid, entry);
            }
            if (n.id !== undefined) entry.instances.push(n.id);
            visit(sg, path.concat(sid), sid);
        }
    };
    visit(root, [], null);
    return out;
}

/** Registre central root.subgraphs (Map) quand la version l'expose. */
function registrySubgraphs(ctx) {
    const root = getGraph(ctx);
    try {
        if (root && root.subgraphs && typeof root.subgraphs.get === "function") return root.subgraphs;
    } catch { /* registre capricieux → walk seul */ }
    return null;
}

/** Liste fusionnée (instanciés + registre seul), triée par chemin. */
function listSubgraphEntries(ctx) {
    const out = collectSubgraphs(ctx);
    const reg = registrySubgraphs(ctx);
    if (reg) {
        try {
            reg.forEach((sg, id) => {
                if (!sg) return;
                const sid = String(sg.id !== undefined && sg.id !== null ? sg.id : id);
                if (!out.has(sid)) {
                    out.set(sid, { id: sid, subgraph: sg, path: [sid], parent_id: null, instances: [], reachable: false });
                }
            });
        } catch { /* Map exotique → walk seul */ }
    }
    return [...out.values()].sort((a, b) => (a.path.join("/") < b.path.join("/") ? -1 : 1));
}

/**
 * Résout une référence de subgraph : id UUID, nom exact (insensible à la
 * casse), ou alias "current"/"open" (= subgraph ouvert dans le canvas).
 * Retourne { subgraph, entry } ou { error, code }.
 */
function resolveSubgraphRef(ctx, ref) {
    if (!getGraph(ctx)) {
        return { error: label(ctx, "bl.toolErr.noApp", {}, "workflow ComfyUI indisponible (app/graph introuvable)"), code: "no_app" };
    }
    const raw = String(ref === undefined || ref === null ? "" : ref).trim();
    if (!raw) {
        return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "subgraph manquant (id UUID ou nom)" }, "arguments invalides : {detail}"), code: "invalid_args" };
    }
    const lower = raw.toLowerCase();
    if (SUBGRAPH_CURRENT_ALIASES.indexOf(lower) >= 0) {
        const sg = activeSubgraph(ctx);
        if (!sg) {
            return { error: label(ctx, "bl.toolErr.subgraphNotOpen", {}, "aucun subgraph n'est ouvert dans le canvas (précise un id ou un nom)"), code: "subgraph_not_open" };
        }
        const sid = String(sg.id);
        const entries = listSubgraphEntries(ctx);
        const entry = entries.find((e) => e.id === sid) || { id: sid, subgraph: sg, path: [sid], parent_id: null, instances: [], reachable: true };
        return { subgraph: sg, entry: entry };
    }
    const entries = listSubgraphEntries(ctx);
    let entry = entries.find((e) => e.id === raw) || null;
    if (!entry) {
        const byName = entries.filter((e) => e.subgraph && String(e.subgraph.name || "").toLowerCase() === lower);
        if (byName.length > 1) {
            return {
                error: label(ctx, "bl.toolErr.subgraphAmbiguous", { ref: raw, ids: byName.map((e) => e.id).join(", ") }, "subgraph '{ref}' ambigu — plusieurs correspondances : {ids} (précise l'UUID)"),
                code: "subgraph_ambiguous",
            };
        }
        if (byName.length === 1) entry = byName[0];
    }
    if (!entry) {
        return { error: label(ctx, "bl.toolErr.subgraphNotFound", { ref: raw }, "subgraph '{ref}' introuvable (utilise list_subgraphs pour voir les subgraphs disponibles)"), code: "subgraph_not_found" };
    }
    return { subgraph: entry.subgraph, entry: entry };
}

/** Refus si le subgraph n'est pas instancié (pas de couverture undo). */
function requireReachableSubgraph(ctx, rs) {
    if (rs.error) return rs;
    if (rs.entry && !rs.entry.reachable) {
        return {
            error: label(ctx, "bl.toolErr.subgraphUnreachable", { ref: rs.entry.id }, "subgraph '{ref}' non instancié dans le workflow (aucun nœud SubgraphNode) — action impossible : il n'est pas couvert par l'annulation"),
            code: "subgraph_unreachable",
        };
    }
    return rs;
}

/** Forme courte passée au LLM pour situer un nœud. */
function subgraphScopeInfo(sg) {
    return sg ? { id: sg.id, name: sg.name || null } : null;
}

/** Propriété de schéma « subgraph » (id UUID, nom exact, ou "current"). */
function subgraphProp() {
    return {
        type: "string",
        description: "Subgraph cible : UUID, nom exact, ou 'current' = subgraph ouvert dans le canvas. Optionnel : sans lui, le nœud est cherché dans le graphe racine.",
    };
}

// ─── Groupes (cadres) ────────────────────────────────────────────────────────

function graphGroups(graph) {
    if (!graph) return [];
    if (Array.isArray(graph.groups)) return graph.groups;
    if (Array.isArray(graph._groups)) return graph._groups;
    return [];
}

function findGroup(graph, ref) {
    const raw = String(ref === undefined || ref === null ? "" : ref).trim();
    if (!raw) return null;
    const groups = graphGroups(graph);
    const lower = raw.toLowerCase();
    return groups.find((g) => g && String(g.id) === raw)
        || groups.find((g) => g && String(g.title || "").toLowerCase() === lower)
        || null;
}

/** Nœuds d'un groupe (recompute LiteGraph best-effort, liste courante sinon). */
function recomputeGroupNodes(group) {
    let nodes = Array.isArray(group && group.nodes) ? group.nodes : [];
    try {
        if (group && group.graph && typeof group.recomputeInsideNodes === "function") {
            group.recomputeInsideNodes();
            if (Array.isArray(group.nodes)) nodes = group.nodes;
        }
    } catch { /* calcul défensif : liste courante conservée */ }
    return nodes;
}

/** Premier nœud instance d'un subgraph (pour canvas.openSubgraph). */
function findSubgraphInstanceNode(ctx, subgraphId) {
    const root = getGraph(ctx);
    if (!root) return null;
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
        const g = stack.pop();
        if (!g || seen.has(g)) continue;
        seen.add(g);
        const nodes = Array.isArray(g.nodes) ? g.nodes : [];
        for (const n of nodes) {
            const sg = subgraphIdOf(n);
            if (!sg) continue;
            if (String(sg.id) === String(subgraphId)) return n;
            stack.push(sg);
        }
    }
    return null;
}

// ─── Modes de nœud (convention ComfyUI/LiteGraph) ────────────────────────────
// LGraphEventMode : ALWAYS=0, ON_EVENT=1, NEVER=2 (mute), ON_TRIGGER=3,
// BYPASS=4. Exposés : enable (0), mute (2), bypass (4) — les valeurs 1/3 ne
// sont pas proposées (usage interne au moteur).

const NODE_MODE_VALUES = {
    enable: 0, enabled: 0, always: 0, active: 0, on: 0, normal: 0,
    mute: 2, muted: 2, never: 2, off: 2, disable: 2, disabled: 2, skip: 2,
    bypass: 4, bypassed: 4,
    "0": 0, "2": 2, "4": 4,
};
const NODE_MODE_NAMES = { 0: "enable", 1: "on_event", 2: "mute", 3: "on_trigger", 4: "bypass" };

function nodeModeName(mode) {
    const k = Number(mode);
    return NODE_MODE_NAMES[k] !== undefined ? NODE_MODE_NAMES[k] : String(mode);
}

/** normalizeNodeModeValue('bypass'|'mute'|'enable'|0|2|4) → 0/2/4, sinon null. */
function normalizeNodeModeValue(v) {
    if (typeof v === "number") return v === 0 || v === 2 || v === 4 ? v : null;
    const key = String(v === undefined || v === null ? "" : v).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(NODE_MODE_VALUES, key) ? NODE_MODE_VALUES[key] : null;
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
 *
 * `opts.shellAccess` (défaut FALSE, fail-safe) : les outils marqués
 * `requiresShell` (ex. run_shell) ne sont proposés au LLM que si l'accès au
 * shell est explicitement autorisé. C'est la 1ʳᵉ barrière « shell » ; le
 * dispatcher applique la 2ᵉ (refus sans exécution) et la route serveur la 3ᵉ.
 */
function getToolsForMode(mode, opts) {
    const m = normalizeMode(mode);
    const shellAccess = !!(opts && opts.shellAccess);
    return listTools()
        .filter((tl) => (MODE_RANK[tl.mode] === undefined ? 1 : MODE_RANK[tl.mode]) <= MODE_RANK[m])
        .filter((tl) => tl.requiresShell !== true || shellAccess)
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
    // 2ᵉ barrière « shell » : un outil qui exige l'accès shell est refusé SANS
    // exécution tant que ctx.shellAccess n'est pas explicitement vrai (défaut
    // sûr : absent/faux ⇒ refus). Le mode reste la 1ʳᵉ barrière (testée
    // au-dessus) : en 'read', un outil shell est déjà refusé comme 'active'.
    if (tool.requiresShell === true && !ctx.shellAccess) {
        return _fail(ctx, "shell_forbidden", label(ctx, "bl.toolErr.shellAccessDisabled", {}, "accès au shell désactivé — autorise-le avec la case « Autoriser l'accès au shell » dans le chat Blobby (et passe en mode Actif)"));
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
        properties: { id: { type: ["number", "string"], description: "Identifiant du nœud (vu dans describe_workflow / list_nodes)." }, subgraph: subgraphProp() },
        required: ["id"],
    },
    mode: "read",
    async exec(args, ctx) {
        const r = findNode(ctx, args.id, args);
        if (r.error) return r;
        const n = r.node;
        return {
            data: {
                id: n.id, type: n.type, title: n.title || n.comfyClass || n.type,
                mode: n.mode, mode_name: nodeModeName(n.mode), pos: Array.isArray(n.pos) ? n.pos : null, size: n.size || null,
                subgraph: subgraphScopeInfo(r.subgraph),
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
        properties: { id: { type: ["number", "string"], description: "Identifiant du nœud." }, subgraph: subgraphProp() },
        required: ["id"],
    },
    mode: "read",
    async exec(args, ctx) {
        const r = findNode(ctx, args.id, args);
        if (r.error) return r;
        const n = r.node;
        const widgets = Array.isArray(n.widgets)
            ? n.widgets.filter((w) => w && w.name !== undefined).map((w) => {
                const out = { name: w.name, type: w.type, value: w.value };
                if (w.options && Array.isArray(w.options.values)) out.options = { values: w.options.values };
                return out;
            })
            : [];
        return { data: { id: n.id, subgraph: subgraphScopeInfo(r.subgraph), widget_count: widgets.length, widgets: widgets } };
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
            subgraph: subgraphProp(),
        },
        required: ["id", "widget"],
    },
    mode: "read",
    async exec(args, ctx) {
        const r = findNode(ctx, args.id, args);
        if (r.error) return r;
        const w = findWidget(r.node, args.widget);
        if (!w) {
            return {
                error: label(ctx, "bl.toolErr.widgetNotFound", { widget: String(args.widget), id: String(r.node.id) }, "widget '{widget}' introuvable sur le nœud #{id}"),
                code: "widget_not_found",
            };
        }
        const out = { id: r.node.id, subgraph: subgraphScopeInfo(r.subgraph), name: w.name, type: w.type, value: w.value };
        if (w.options && Array.isArray(w.options.values)) out.options = { values: w.options.values };
        return { data: out };
    },
});

registerTool({
    name: "get_node_connections",
    description: "Connexions d'un nœud : entrées (nom/type + nœud source) et sorties (nom/type + nœuds cibles).",
    schema: {
        type: "object",
        properties: { id: { type: ["number", "string"], description: "Identifiant du nœud." }, subgraph: subgraphProp() },
        required: ["id"],
    },
    mode: "read",
    async exec(args, ctx) {
        const r = findNode(ctx, args.id, args);
        if (r.error) return r;
        const graph = r.subgraph || getGraph(ctx);
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
                    source: l ? { id: l.from.id, slot: l.from.slot, title: nodeTitle(getNodeSafe(ctx, l.from.id, args)) } : null,
                };
            })
            : [];
        const outputs = Array.isArray(n.outputs)
            ? n.outputs.map((o) => ({
                name: o.name, type: o.type,
                targets: (o.links || []).map(resolveLink).filter(Boolean).map((l) => ({ id: l.to.id, slot: l.to.slot, title: nodeTitle(getNodeSafe(ctx, l.to.id, args)) })),
            }))
            : [];
        return { data: { id: n.id, subgraph: subgraphScopeInfo(r.subgraph), inputs: inputs, outputs: outputs } };
    },
});

function getNodeSafe(ctx, id, opts) {
    try {
        const r = findNode(ctx, id, opts);
        if (r.node) return r.node;
        // Liens trans-frontières : cible hors du scope → repli sur la racine.
        if (opts && opts.subgraph) {
            const rr = findNode(ctx, id, {});
            return rr.node || null;
        }
        return null;
    } catch { return null; }
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

registerTool({
    name: "get_node_position",
    description: "Position et taille d'un nœud sur le canvas : pos [x,y] et size [largeur,hauteur] en unités du graphe. Lecture seule — pour DÉPLACER un nœud utilise move_node, pour le redimensionner utilise resize_node. Pour un nœud dans un subgraph, fournis subgraph (UUID, nom, ou 'current').",
    schema: {
        type: "object",
        properties: {
            id: { type: ["number", "string"], description: "Identifiant du nœud." },
            subgraph: subgraphProp(),
        },
        required: ["id"],
    },
    mode: "read",
    async exec(args, ctx) {
        const r = findNode(ctx, args.id, args);
        if (r.error) return r;
        const n = r.node;
        return {
            data: {
                id: n.id, type: n.type, title: nodeTitle(n),
                pos: Array.isArray(n.pos) ? [n.pos[0], n.pos[1]] : null,
                size: Array.isArray(n.size) ? [n.size[0], n.size[1]] : null,
                subgraph: subgraphScopeInfo(r.subgraph),
            },
        };
    },
});

registerTool({
    name: "list_subgraphs",
    description: "Liste les Subgraphs (blueprints) du workflow ouvert : id (UUID), nom, nombre de nœuds, chemin d'imbrication, celui qui est OUVERT dans le canvas et ceux non instanciés (reachable:false). Point d'entrée pour l'inspection : détail avec get_subgraph, ouverture avec open_subgraph ; les outils de mutation acceptent subgraph='<UUID ou nom>' pour agir sur un nœud interne.",
    schema: { type: "object", properties: {}, required: [] },
    mode: "read",
    async exec(_args, ctx) {
        if (!getGraph(ctx)) {
            return { error: label(ctx, "bl.toolErr.noApp", {}, "workflow ComfyUI indisponible (app/graph introuvable)"), code: "no_app" };
        }
        const entries = listSubgraphEntries(ctx);
        const cur = activeSubgraph(ctx);
        const curId = cur ? String(cur.id) : null;
        return {
            data: {
                count: entries.length,
                active_graph: cur ? "subgraph" : "root",
                current_subgraph: cur ? { id: curId, name: cur.name || null } : null,
                subgraphs: entries.map((e) => ({
                    id: e.id,
                    name: e.subgraph.name || null,
                    description: e.subgraph.description || null,
                    path: e.path,
                    depth: e.path.length,
                    parent_id: e.parent_id,
                    node_count: Array.isArray(e.subgraph.nodes) ? e.subgraph.nodes.length : null,
                    instances: e.instances,
                    open: curId !== null && curId === e.id,
                    reachable: e.reachable,
                })),
            },
        };
    },
});

registerTool({
    name: "get_subgraph",
    description: "Inspecte UN subgraph en détail (par UUID ou nom exact) : nœuds internes (id LOCAL dans le subgraph, type, titre, mode, mode_name, position, taille, widgets), entrées/sorties et sous-subgraphs. Pour MODIFIER un nœud interne, repasse son id local avec subgraph à set_widget_value / set_node_title / move_node / resize_node / set_node_mode / connect_nodes / remove_node…",
    schema: {
        type: "object",
        properties: { subgraph: { type: "string", description: "UUID ou nom exact du subgraph (vu dans list_subgraphs)." } },
        required: ["subgraph"],
    },
    mode: "read",
    async exec(args, ctx) {
        const rs = resolveSubgraphRef(ctx, args.subgraph);
        if (rs.error) return rs;
        const sg = rs.subgraph;
        const cur = activeSubgraph(ctx);
        const nodes = (Array.isArray(sg.nodes) ? sg.nodes : []).map((n) => {
            const widgets = {};
            if (Array.isArray(n.widgets)) n.widgets.forEach((w) => { if (w && w.name !== undefined) widgets[w.name] = w.value; });
            return {
                id: n.id, type: n.type, title: nodeTitle(n),
                mode: n.mode, mode_name: nodeModeName(n.mode),
                pos: Array.isArray(n.pos) ? [n.pos[0], n.pos[1]] : null,
                size: Array.isArray(n.size) ? [n.size[0], n.size[1]] : null,
                is_subgraph: !!subgraphIdOf(n),
                widgets: widgets,
            };
        });
        const nested = listSubgraphEntries(ctx).filter((e) => e.parent_id === String(sg.id));
        return {
            data: {
                id: sg.id, name: sg.name || null, description: sg.description || null,
                path: rs.entry ? rs.entry.path : [String(sg.id)],
                parent_id: rs.entry ? rs.entry.parent_id : null,
                open: cur !== null && String(cur.id) === String(sg.id),
                reachable: rs.entry ? rs.entry.reachable : true,
                instances: rs.entry ? rs.entry.instances : [],
                node_count: nodes.length,
                nodes: nodes,
                inputs: (Array.isArray(sg.inputs) ? sg.inputs : []).map((i) => ({ name: i && i.name, type: i && i.type })),
                outputs: (Array.isArray(sg.outputs) ? sg.outputs : []).map((o) => ({ name: o && o.name, type: o && o.type })),
                nested_subgraphs: nested.map((e) => ({
                    id: e.id, name: e.subgraph.name || null,
                    node_count: Array.isArray(e.subgraph.nodes) ? e.subgraph.nodes.length : null,
                })),
            },
        };
    },
});

registerTool({
    name: "list_groups",
    description: "Liste les groupes (cadres) du graphe : titre, id, couleur, position/taille et ids des nœuds contenus. Cible ensuite un groupe entier avec set_node_mode (argument group). Pour les groupes d'un subgraph, fournis subgraph.",
    schema: { type: "object", properties: { subgraph: subgraphProp() }, required: [] },
    mode: "read",
    async exec(args, ctx) {
        let graph = getGraph(ctx);
        let scope = null;
        if (args.subgraph !== undefined && args.subgraph !== null && String(args.subgraph).trim() !== "") {
            const rs = resolveSubgraphRef(ctx, args.subgraph);
            if (rs.error) return rs;
            graph = rs.subgraph;
            scope = rs.subgraph;
        }
        if (!graph) {
            return { error: label(ctx, "bl.toolErr.noApp", {}, "workflow ComfyUI indisponible (app/graph introuvable)"), code: "no_app" };
        }
        const groups = graphGroups(graph).map((g) => {
            const nodes = recomputeGroupNodes(g);
            return {
                id: g.id, title: g.title || null, color: g.color || null,
                pos: Array.isArray(g.pos) ? [g.pos[0], g.pos[1]] : null,
                size: Array.isArray(g.size) ? [g.size[0], g.size[1]] : null,
                node_count: nodes.length,
                node_ids: nodes.map((n) => n && n.id),
            };
        });
        return { data: { subgraph: subgraphScopeInfo(scope), count: groups.length, groups: groups } };
    },
});

registerTool({
    name: "open_subgraph",
    description: "Ouvre un subgraph dans le canvas (action de VUE : ne modifie PAS le workflow, aucun snapshot). Par UUID ou nom exact. Une fois ouvert, subgraph:'current' cible ce subgraph dans les autres outils. Retour au graphe racine : close_subgraph.",
    schema: {
        type: "object",
        properties: { subgraph: { type: "string", description: "UUID ou nom exact du subgraph à ouvrir (vu dans list_subgraphs)." } },
        required: ["subgraph"],
    },
    mode: "read",
    async exec(args, ctx) {
        const rs = requireReachableSubgraph(ctx, resolveSubgraphRef(ctx, args.subgraph));
        if (rs.error) return rs;
        const canvas = resolveCanvas(ctx);
        if (!canvas) {
            return { error: label(ctx, "bl.toolErr.noCanvas", {}, "canvas ComfyUI indisponible (app.canvas introuvable)"), code: "no_canvas" };
        }
        const sg = rs.subgraph;
        const already = activeSubgraph(ctx);
        if (already && String(already.id) === String(sg.id)) {
            return {
                data: { opened: true, already_open: true, subgraph: subgraphScopeInfo(sg) },
                action: label(ctx, "bl.toolAct.openSubgraph", { name: String(sg.name || sg.id) }, "📂 Subgraph « {name} » ouvert"),
            };
        }
        const openFail = (detail) => ({
            error: label(ctx, "bl.toolErr.subgraphOpenFailed", { error: detail }, "ouverture du subgraph impossible : {error}"),
            code: "subgraph_open_failed",
        });
        try {
            // openSubgraph respecte l'événement annulable 'subgraph-opening' ;
            // setGraph est le repli des versions qui ne l'exposent pas.
            if (typeof canvas.openSubgraph === "function") canvas.openSubgraph(sg, findSubgraphInstanceNode(ctx, sg.id));
            else if (typeof canvas.setGraph === "function") canvas.setGraph(sg);
            else return openFail("aucune API canvas (openSubgraph/setGraph)");
        } catch (e) {
            return openFail((e && e.message) || String(e));
        }
        const now = activeSubgraph(ctx);
        if (!now || String(now.id) !== String(sg.id)) {
            return openFail("le canvas n'a pas changé (événement 'subgraph-opening' annulé par une extension ?)");
        }
        dirtyCanvas(ctx);
        return {
            data: { opened: true, subgraph: subgraphScopeInfo(sg) },
            action: label(ctx, "bl.toolAct.openSubgraph", { name: String(sg.name || sg.id) }, "📂 Subgraph « {name} » ouvert"),
        };
    },
});

registerTool({
    name: "close_subgraph",
    description: "Revient au graphe racine depuis un subgraph ouvert (action de VUE uniquement, aucun snapshot). Sans subgraph ouvert : no-op signalé (already_at_root).",
    schema: { type: "object", properties: {}, required: [] },
    mode: "read",
    async exec(_args, ctx) {
        const canvas = resolveCanvas(ctx);
        if (!canvas) {
            return { error: label(ctx, "bl.toolErr.noCanvas", {}, "canvas ComfyUI indisponible (app.canvas introuvable)"), code: "no_canvas" };
        }
        const root = getGraph(ctx);
        if (!root) {
            return { error: label(ctx, "bl.toolErr.noApp", {}, "workflow ComfyUI indisponible (app/graph introuvable)"), code: "no_app" };
        }
        const cur = activeSubgraph(ctx);
        if (!cur) {
            return { data: { closed: false, already_at_root: true, active_graph: "root" } };
        }
        const closeFail = (detail) => ({
            error: label(ctx, "bl.toolErr.subgraphCloseFailed", { error: detail }, "retour au graphe racine impossible : {error}"),
            code: "subgraph_close_failed",
        });
        try {
            if (typeof canvas.setGraph === "function") canvas.setGraph(root);
            else return closeFail("aucune API canvas.setGraph");
        } catch (e) {
            return closeFail((e && e.message) || String(e));
        }
        if (activeSubgraph(ctx)) return closeFail("le canvas est toujours dans un subgraph");
        dirtyCanvas(ctx);
        return {
            data: { closed: true, closed_subgraph: subgraphScopeInfo(cur), active_graph: "root" },
            action: label(ctx, "bl.toolAct.closeSubgraph", {}, "📂 Retour au graphe racine"),
        };
    },
});

// ─── Mutations ('active', undoable : snapshot avant exec) ────────────────────

registerTool({
    name: "set_widget_value",
    description: "Change la valeur d'un widget (champ) d'un nœud. Les nombres sont bornés aux min/max du widget, les combos vérifiés contre la liste des valeurs possibles. Pour un nœud dans un subgraph, fournis subgraph.",
    schema: {
        type: "object",
        properties: {
            id: { type: ["number", "string"], description: "Identifiant du nœud." },
            widget: { type: "string", description: "Nom du widget (ex. 'steps')." },
            value: { description: "Nouvelle valeur (nombre, texte ou booléen selon le widget)." },
            subgraph: subgraphProp(),
        },
        required: ["id", "widget", "value"],
    },
    mode: "active",
    undoable: true,
    async exec(args, ctx) {
        const r = findNode(ctx, args.id, args);
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
            data: { node: node.id, widget: w.name, type: w.type, value: v, subgraph: subgraphScopeInfo(r.subgraph) },
            action: label(ctx, "bl.toolAct.setWidget", { name: nodeTitle(node), widget: w.name, value: String(v) }, "⚙️ {name} · {widget} = {value}"),
        };
    },
});

registerTool({
    name: "set_node_title",
    description: "Renomme le titre d'un nœud. Pour un nœud dans un subgraph, fournis subgraph.",
    schema: {
        type: "object",
        properties: {
            id: { type: ["number", "string"], description: "Identifiant du nœud." },
            title: { type: "string", description: "Nouveau titre." },
            subgraph: subgraphProp(),
        },
        required: ["id", "title"],
    },
    mode: "active",
    undoable: true,
    async exec(args, ctx) {
        const r = findNode(ctx, args.id, args);
        if (r.error) return r;
        const old = r.node.title;
        r.node.title = String(args.title);
        dirtyCanvas(ctx);
        return {
            data: { node: r.node.id, title: r.node.title, previous: old, subgraph: subgraphScopeInfo(r.subgraph) },
            action: label(ctx, "bl.toolAct.setTitle", { id: String(r.node.id), title: String(args.title) }, "🏷️ #{id} renommé « {title} »"),
        };
    },
});

const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

registerTool({
    name: "set_node_color",
    description: "Change la couleur d'un nœud (color = cadre, bgcolor = fond). Formats hexadécimaux (#RGB / #RRGGBB / #RRGGBBAA). Pour un nœud dans un subgraph, fournis subgraph.",
    schema: {
        type: "object",
        properties: {
            id: { type: ["number", "string"], description: "Identifiant du nœud." },
            color: { type: "string", description: "Couleur du cadre, ex. '#FF8F00'." },
            bgcolor: { type: "string", description: "Couleur de fond (optionnel)." },
            subgraph: subgraphProp(),
        },
        required: ["id", "color"],
    },
    mode: "active",
    undoable: true,
    async exec(args, ctx) {
        const r = findNode(ctx, args.id, args);
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
            data: { node: node.id, color: color, bgcolor: bg !== undefined ? bg : node.bgcolor, previous: previous, subgraph: subgraphScopeInfo(r.subgraph) },
            action: label(ctx, "bl.toolAct.setColor", { name: nodeTitle(node), color: color }, "🎨 {name} recoloré ({color})"),
        };
    },
});

registerTool({
    name: "move_node",
    description: "Déplace un nœud sur le canvas (coordonnées du graphe). Pour le redimensionner, utilise resize_node. Pour un nœud dans un subgraph, fournis subgraph (UUID, nom, ou 'current').",
    schema: {
        type: "object",
        properties: {
            id: { type: ["number", "string"], description: "Identifiant du nœud." },
            x: { type: "number", description: "Position X." },
            y: { type: "number", description: "Position Y." },
            subgraph: subgraphProp(),
        },
        required: ["id", "x", "y"],
    },
    mode: "active",
    undoable: true,
    async exec(args, ctx) {
        const r = findNode(ctx, args.id, args);
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
            data: { node: node.id, pos: [x, y], previous: previous, subgraph: subgraphScopeInfo(r.subgraph) },
            action: label(ctx, "bl.toolAct.moveNode", { name: nodeTitle(node), x: String(x), y: String(y) }, "↔️ {name} déplacé ({x}, {y})"),
        };
    },
});

registerTool({
    name: "resize_node",
    description: "Redimensionne un nœud (width/height en unités du graphe ; LiteGraph applique ses tailles minimales — la taille réellement appliquée est renvoyée). Pour un nœud dans un subgraph, fournis subgraph.",
    schema: {
        type: "object",
        properties: {
            id: { type: ["number", "string"], description: "Identifiant du nœud." },
            width: { type: "number", description: "Largeur souhaitée (> 0)." },
            height: { type: "number", description: "Hauteur souhaitée (> 0)." },
            subgraph: subgraphProp(),
        },
        required: ["id", "width", "height"],
    },
    mode: "active",
    undoable: true,
    async exec(args, ctx) {
        const r = findNode(ctx, args.id, args);
        if (r.error) return r;
        const w = Number(args.width);
        const h = Number(args.height);
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
            return { error: label(ctx, "bl.toolErr.invalidValue", { detail: "width/height doivent être des nombres > 0" }, "valeur invalide : {detail}"), code: "invalid_value" };
        }
        const node = r.node;
        const previous = Array.isArray(node.size) ? node.size.slice() : null;
        try {
            if (typeof node.setSize === "function") node.setSize([w, h]);
            else node.size = [w, h];
        } catch (e) {
            return { error: label(ctx, "bl.toolErr.exec", { error: (e && e.message) || String(e) }, "échec de l'outil : {error}"), code: "exec_error" };
        }
        const size = Array.isArray(node.size) ? [node.size[0], node.size[1]] : [w, h];
        dirtyCanvas(ctx);
        return {
            data: { node: node.id, title: nodeTitle(node), size: size, previous: previous, subgraph: subgraphScopeInfo(r.subgraph) },
            action: label(ctx, "bl.toolAct.resizeNode", { name: nodeTitle(node), w: String(size[0]), h: String(size[1]) }, "📐 {name} redimensionné ({w}×{h})"),
        };
    },
});

registerTool({
    name: "set_node_mode",
    description: "Change le mode d'exécution d'un ou plusieurs nœuds : 'enable' (ALWAYS=0, exécution normale), 'mute' (NEVER=2, nœud ignoré : sa sortie est coupée), 'bypass' (BYPASS=4, nœud court-circuité : ses entrées traversent vers la sortie compatible). Cible EXACTEMENT UNE forme : id (un nœud), nodes ([ids]) ou group (titre/id d'un groupe vu dans list_groups). mode accepte aussi 0/2/4. Pour des nœuds dans un subgraph, fournis subgraph.",
    schema: {
        type: "object",
        properties: {
            mode: { type: ["string", "number"], description: "'enable' | 'mute' | 'bypass' (ou 0/2/4)." },
            id: { type: ["number", "string"], description: "Nœud cible (alternative à nodes/group)." },
            nodes: { type: "array", items: { type: ["number", "string"] }, description: "Liste d'ids de nœuds cibles (alternative à id/group)." },
            group: { type: ["string", "number"], description: "Titre ou id d'un groupe : applique le mode à TOUS ses nœuds (alternative à id/nodes)." },
            subgraph: subgraphProp(),
        },
        required: ["mode"],
    },
    mode: "active",
    undoable: true,
    async exec(args, ctx) {
        const m = normalizeNodeModeValue(args.mode);
        if (m === null) {
            return { error: label(ctx, "bl.toolErr.invalidMode", { detail: String(args.mode === undefined || args.mode === null ? "mode manquant" : args.mode) }, "mode invalide : {detail} — attendu enable/mute/bypass (ou 0/2/4)"), code: "invalid_value" };
        }
        const hasId = args.id !== undefined && args.id !== null && args.id !== "";
        const hasNodes = Array.isArray(args.nodes);
        const hasGroup = args.group !== undefined && args.group !== null && String(args.group).trim() !== "";
        if ((hasId ? 1 : 0) + (hasNodes ? 1 : 0) + (hasGroup ? 1 : 0) !== 1) {
            return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "fournir UNE cible exactement : id, nodes ou group" }, "arguments invalides : {detail}"), code: "invalid_args" };
        }
        // Scope éventuel (subgraph) : résolu UNE fois pour tout le lot.
        let scope = null;
        if (args.subgraph !== undefined && args.subgraph !== null && String(args.subgraph).trim() !== "") {
            const rs = requireReachableSubgraph(ctx, resolveSubgraphRef(ctx, args.subgraph));
            if (rs.error) return rs;
            scope = rs.subgraph;
        }
        const targets = [];
        const seen = new Set();
        const pushNode = (node) => { if (node && !seen.has(node)) { seen.add(node); targets.push(node); } };
        if (hasId) {
            const r = findNode(ctx, args.id, args);
            if (r.error) return r;
            pushNode(r.node);
        } else if (hasNodes) {
            if (args.nodes.length === 0 || args.nodes.length > 500) {
                return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "nodes doit contenir 1 à 500 ids" }, "arguments invalides : {detail}"), code: "invalid_args" };
            }
            for (const oneId of args.nodes) {
                const r = findNode(ctx, oneId, args);
                if (r.error) return r; // erreur atomique : aucun nœud muté avant la validation complète
                pushNode(r.node);
            }
        } else {
            const graph = scope || getGraph(ctx);
            const group = findGroup(graph, args.group);
            if (!group) {
                return { error: label(ctx, "bl.toolErr.groupNotFound", { ref: String(args.group) }, "groupe '{ref}' introuvable (utilise list_groups)"), code: "group_not_found" };
            }
            const groupNodes = recomputeGroupNodes(group);
            if (!groupNodes.length) {
                return { error: label(ctx, "bl.toolErr.groupEmpty", { ref: String(group.title || args.group) }, "groupe '{ref}' sans nœud à modifier"), code: "group_empty" };
            }
            if (groupNodes.length > 500) {
                return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "groupe > 500 nœuds" }, "arguments invalides : {detail}"), code: "invalid_args" };
            }
            groupNodes.forEach(pushNode);
        }
        if (!targets.length) {
            return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "aucun nœud cible" }, "arguments invalides : {detail}"), code: "invalid_args" };
        }
        const results = targets.map((node) => {
            const previous = node.mode;
            node.mode = m;
            try { if (typeof node.updateComputedDisabled === "function") node.updateComputedDisabled(); } catch { /* best-effort */ }
            return { id: node.id, title: nodeTitle(node), previous: previous, previous_name: nodeModeName(previous) };
        });
        // Marque le graphe modifié (même comportement que le menu natif de
        // groupe ComfyUI), sans casser sur les formes qui ne l'exposent pas.
        const scopeGraph = scope || getGraph(ctx);
        try { if (scopeGraph && typeof scopeGraph.change === "function") scopeGraph.change(); } catch { /* best-effort */ }
        dirtyCanvas(ctx);
        return {
            data: {
                mode: m, mode_name: nodeModeName(m), applied: results.length,
                nodes: results.slice(0, 100), results_truncated: results.length > 100,
                subgraph: subgraphScopeInfo(scope),
            },
            action: label(ctx, "bl.toolAct.setNodeMode", { count: String(results.length), mode: nodeModeName(m) }, "⚡ {count} nœud(s) → {mode}"),
        };
    },
});

registerTool({
    name: "add_node",
    description: "Ajoute un nœud du type ComfyUI donné au workflow (racine, ou DANS un subgraph avec subgraph). Si le type est inconnu, l'erreur invite à vérifier avec get_object_info.",
    schema: {
        type: "object",
        properties: {
            class_type: { type: "string", description: "Type ComfyUI du nœud (ex. 'KSampler')." },
            x: { type: "number", description: "Position X (optionnel, défaut 0)." },
            y: { type: "number", description: "Position Y (optionnel, défaut 0)." },
            title: { type: "string", description: "Titre personnalisé (optionnel)." },
            subgraph: subgraphProp(),
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
        // Cible : racine par défaut, ou subgraph (id/nom/'current').
        let targetGraph = graph;
        let scope = null;
        if (args.subgraph !== undefined && args.subgraph !== null && String(args.subgraph).trim() !== "") {
            const rs = requireReachableSubgraph(ctx, resolveSubgraphRef(ctx, args.subgraph));
            if (rs.error) return rs;
            targetGraph = rs.subgraph;
            scope = rs.subgraph;
        }
        // Forme défensive de création (selon la version LiteGraph/ComfyUI) :
        // hook de test → window.LiteGraph.createNode → graph.createNode.
        let node = null;
        try {
            if (ctx && typeof ctx.createNodeImpl === "function") node = ctx.createNodeImpl(classType, ctx);
            else if (typeof window !== "undefined" && window.LiteGraph && typeof window.LiteGraph.createNode === "function") node = window.LiteGraph.createNode(classType);
            else if (typeof targetGraph.createNode === "function") node = targetGraph.createNode(classType);
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
        try { if (typeof targetGraph.add === "function") { targetGraph.add(node); added = true; } } catch { /* forme inattendue */ }
        if (!added && Array.isArray(targetGraph.nodes)) {
            try { targetGraph.nodes.push(node); added = true; } catch { /* ignore */ }
        }
        if (!added) {
            return { error: label(ctx, "bl.toolErr.addFailed", { class: classType }, "création du nœud '{class}' impossible (API LiteGraph indisponible ou type inconnu — vérifie avec get_object_info)"), code: "add_failed" };
        }
        dirtyCanvas(ctx);
        return {
            data: { id: node.id, type: node.type || classType, title: node.title, subgraph: subgraphScopeInfo(scope) },
            action: label(ctx, "bl.toolAct.addNode", { class: classType, id: String(node.id) }, "➕ {class} ajouté (id {id})"),
        };
    },
});

registerTool({
    name: "remove_node",
    description: "Supprime un nœud du workflow (les liens connectés sont coupés par l'API du graphe). Pour un nœud dans un subgraph, fournis subgraph.",
    schema: {
        type: "object",
        properties: { id: { type: ["number", "string"], description: "Identifiant du nœud à supprimer." }, subgraph: subgraphProp() },
        required: ["id"],
    },
    mode: "active",
    undoable: true,
    async exec(args, ctx) {
        const r = findNode(ctx, args.id, args);
        if (r.error) return r;
        const rootGraph = getGraph(ctx);
        const node = r.node;
        const title = nodeTitle(node);
        // Retrait sur le graphe PROPRIÉTAIRE du nœud (racine ou subgraph) :
        // graph.remove sur la racine avec un nœud de subgraph serait incohérent.
        const owner = (node && node.graph && typeof node.graph.remove === "function") ? node.graph
            : (r.subgraph && typeof r.subgraph.remove === "function") ? r.subgraph
                : rootGraph;
        let removed = false;
        try {
            if (owner && typeof owner.remove === "function") { owner.remove(node); removed = true; }
            else if (node && typeof node.remove === "function") { node.remove(); removed = true; }
            else if (owner && Array.isArray(owner.nodes)) {
                const i = owner.nodes.indexOf(node);
                if (i >= 0) { owner.nodes.splice(i, 1); removed = true; }
            }
        } catch (e) {
            return { error: label(ctx, "bl.toolErr.removeFailed", { error: (e && e.message) || String(e) }, "suppression impossible : {error}"), code: "remove_failed" };
        }
        if (!removed) {
            return { error: label(ctx, "bl.toolErr.removeFailed", { error: "aucune API compatible (graph.remove/node.remove)" }, "suppression impossible : {error}"), code: "remove_failed" };
        }
        dirtyCanvas(ctx);
        return {
            data: { removed: node.id, title: title, subgraph: subgraphScopeInfo(r.subgraph) },
            action: label(ctx, "bl.toolAct.removeNode", { name: title }, "🗑️ {name} supprimé"),
        };
    },
});

registerTool({
    name: "connect_nodes",
    description: "Connecte la sortie from_slot du nœud from_id à l'entrée to_input du nœud to_id (to_input = nom d'entrée ou index). Les DEUX nœuds doivent être dans le même graphe (même subgraph le cas échéant, via subgraph).",
    schema: {
        type: "object",
        properties: {
            from_id: { type: ["number", "string"], description: "Nœud source." },
            from_slot: { type: "number", description: "Index de la sortie du nœud source." },
            to_id: { type: ["number", "string"], description: "Nœud cible." },
            to_input: { type: ["number", "string"], description: "Nom (ex. 'model') ou index de l'entrée du nœud cible." },
            subgraph: subgraphProp(),
        },
        required: ["from_id", "from_slot", "to_id", "to_input"],
    },
    mode: "active",
    undoable: true,
    async exec(args, ctx) {
        const rFrom = findNode(ctx, args.from_id, args);
        if (rFrom.error) return rFrom;
        const rTo = findNode(ctx, args.to_id, args);
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
                subgraph: subgraphScopeInfo(rFrom.subgraph),
            },
            action: label(ctx, "bl.toolAct.connect", { from: nodeTitle(nodeOut), to: nodeTitle(nodeIn) }, "🔗 {from} → {to}"),
        };
    },
});

registerTool({
    name: "disconnect_nodes",
    description: "Déconnecte : (from_id + from_slot [+ to_id]) coupe sur la sortie donnée, sinon (to_id + to_input) coupe l'entrée donnée du nœud cible. Pour des nœuds dans un subgraph, fournis subgraph.",
    schema: {
        type: "object",
        properties: {
            from_id: { type: ["number", "string"], description: "Nœud source (avec from_slot)." },
            from_slot: { type: "number", description: "Index de sortie du nœud source." },
            to_id: { type: ["number", "string"], description: "Nœud cible." },
            to_input: { type: ["number", "string"], description: "Nom ou index de l'entrée à couper sur le nœud cible." },
            subgraph: subgraphProp(),
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
            const rFrom = findNode(ctx, args.from_id, args);
            if (rFrom.error) return rFrom;
            const nodeOut = rFrom.node;
            const slot = Number(args.from_slot);
            if (!Number.isFinite(slot) || slot < 0 || !Array.isArray(nodeOut.outputs) || slot >= nodeOut.outputs.length) {
                return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "sortie " + String(args.from_slot) + " inexistante sur #" + String(nodeOut.id) }, "arguments invalides : {detail}"), code: "invalid_args" };
            }
            if (hasTo) {
                const rTo = findNode(ctx, args.to_id, args);
                if (rTo.error) return rTo;
                try { if (nodeOut.disconnectOutput(slot, rTo.node)) disconnected++; }
                catch (e) { return { error: label(ctx, "bl.toolErr.disconnectFailed", { error: (e && e.message) || String(e) }, "déconnexion impossible : {error}"), code: "disconnect_failed" }; }
            } else {
                const before = Array.isArray(nodeOut.outputs[slot].links) ? nodeOut.outputs[slot].links.length : 0;
                try { nodeOut.disconnectOutput(slot); disconnected = before; }
                catch (e) { return { error: label(ctx, "bl.toolErr.disconnectFailed", { error: (e && e.message) || String(e) }, "déconnexion impossible : {error}"), code: "disconnect_failed" }; }
            }
        } else {
            const rTo = findNode(ctx, args.to_id, args);
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
            action: label(ctx, "bl.toolAct.disconnect", { from: nodeTitle(getNodeSafe(ctx, args.from_id, args)), to: nodeTitle(getNodeSafe(ctx, args.to_id, args)) }, "✂️ {from} ✕ {to}"),
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
    name: "run_shell",
    description: "Exécute une commande shell locale sur la machine où tourne ComfyUI (bash/sh, plafond dur de 15 s) et renvoie sa sortie. ⚠️ Accès shell : la commande s'exécute réellement ; cet outil n'est disponible que si l'utilisateur a coché « Autoriser l'accès au shell » ET si le mode est Actif.",
    schema: {
        type: "object",
        properties: { command: { type: "string", description: "Commande shell à exécuter (ex. 'ls -la', 'git status', 'python --version')." } },
        required: ["command"],
    },
    // 'active' ⇒ jamais proposé/accepté en Lecture seule (1ʳᵉ barrière = mode).
    mode: "active",
    // requiresShell ⇒ filtré par getToolsForMode sans shellAccess et refusé
    // par le dispatcher (2ᵉ barrière) puis par la route serveur (3ᵉ).
    requiresShell: true,
    // Non undoable : un snapshot de workflow ne peut pas annuler une commande
    // déjà lancée sur le système (même raisonnement que queue_prompt).
    async exec(args, ctx) {
        const cmd = String(args && args.command !== undefined && args.command !== null ? args.command : "").trim();
        if (!cmd) {
            return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "command manquante" }, "arguments invalides : {detail}"), code: "invalid_args" };
        }
        let res;
        try {
            res = await sameOriginFetch(ctx, "/aih/blobby/exec", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "shell", command: cmd }),
            });
        } catch (e) {
            return { error: label(ctx, "bl.toolErr.shellUnreachable", { error: (e && e.message) || String(e) }, "exécution shell impossible : {error}"), code: "shell_unreachable" };
        }
        let data = null;
        try { data = await res.json(); } catch { /* corps illisible → data null */ }
        if (!res || !res.ok) {
            // Refus serveur (403 shell_forbidden, 400 commande vide…) : message
            // clair réinjecté au LLM, JAMAIS un échec silencieux.
            const detail = data && (data.output || data.error) ? String(data.output || data.error) : "";
            return {
                error: label(ctx, "bl.toolErr.shellForbidden", { status: res ? res.status : 0, detail: detail ? " — " + detail : "" }, "exécution shell refusée par le serveur (autorisation absente) : {detail}"),
                code: "shell_forbidden",
            };
        }
        if (data && data.ok === false) {
            return { error: label(ctx, "bl.toolErr.shellFailed", { detail: String(data.output || data.error || "") }, "échec de la commande shell : {detail}"), code: "shell_failed" };
        }
        return {
            data: { command: cmd, output: data ? data.output : null },
            action: label(ctx, "bl.toolAct.runShell", { command: cmd }, "🖥️ {command}"),
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