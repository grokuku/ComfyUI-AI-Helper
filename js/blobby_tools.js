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

/**
 * Lit une paire [x, y] depuis une position/taille LiteGraph.
 * ⚠️ Dans LiteGraph récent (frontend ComfyUI de référence), `node.pos` et
 * `node.size` — ainsi que ceux d'un `LGraphGroup` — sont des `Float64Array`
 * (Rectangle.subarray), PAS des `Array` : `Array.isArray()` y renvoie `false`
 * et une lecture naïve `Array.isArray(v) ? [...] : null` produit `null`.
 * On indexe donc la valeur (Array OU typed array) et on renvoie TOUJOURS un
 * Array de deux nombres finis (jamais le typed array lui-même, qui ne se
 * sérialise pas en JSON comme un tableau), sinon `null`.
 */
function numberPair(v) {
    if (v === undefined || v === null || typeof v !== "object") return null;
    const a = Number(v[0]);
    const b = Number(v[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return [a, b];
}

/**
 * Liens d'un graphe sous forme de liste, quelle que soit la forme exposée :
 * Map (frontend récent — accesseur `.get` + accès indexé via Proxy), Array
 * (LiteGraph historique) ou objet indexé par id.
 */
function graphLinks(graph) {
    const L = graph && graph.links;
    if (!L) return [];
    if (typeof L.values === "function") { try { return [...L.values()]; } catch { /* forme suivante */ } }
    if (Array.isArray(L)) return L.filter(Boolean);
    return Object.keys(L).map((k) => L[k]).filter(Boolean);
}

/** Lien du graphe par id (Map/Array/objet ; jamais de crash). */
function getLinkById(graph, linkId) {
    if (!graph || !graph.links || linkId === undefined || linkId === null) return null;
    try { if (typeof graph.links.get === "function") { const l = graph.links.get(linkId); if (l) return l; } } catch { /* forme suivante */ }
    try { if (graph.links[linkId]) return graph.links[linkId]; } catch { /* forme suivante */ }
    return graphLinks(graph).find((l) => l && String(l.id) === String(linkId)) || null;
}

/** Retire un lien du registre du graphe (Map ou objet indexé). */
function removeGraphLink(graph, linkId) {
    if (!graph || !graph.links) return;
    try { if (typeof graph.links.delete === "function") { graph.links.delete(linkId); return; } } catch { /* ignore */ }
    try { delete graph.links[linkId]; } catch { /* ignore */ }
}

/**
 * Efface TOUTE référence à `linkId` dans les entrées/sorties des nœuds du
 * graphe (sauf `excludeNode`). Sert à détacher proprement un lien non
 * recâblable (jamais de lien orphelin après un retype).
 */
function clearLinkRefs(graph, linkId, excludeNode) {
    if (!graph || linkId === undefined || linkId === null) return;
    const target = String(linkId);
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    for (const n of nodes) {
        if (!n || n === excludeNode) continue;
        if (Array.isArray(n.inputs)) {
            for (const inp of n.inputs) {
                if (inp && inp.link !== undefined && String(inp.link) === target) inp.link = null;
            }
        }
        if (Array.isArray(n.outputs)) {
            for (const out of n.outputs) {
                if (out && Array.isArray(out.links)) out.links = out.links.filter((id) => String(id) !== target);
            }
        }
    }
    // Slots d'ENTRÉE/SORTIE d'un SUBGRAPH : ils ne figurent PAS dans
    // `graph.nodes` (nœuds d'I/O hors liste, cf. Subgraph.inputNode/outputNode)
    // et portent leurs propres références de liens dans `linkIds`. Sans ce
    // nettoyage, détacher un lien de FRONTIÈRE (nœud interne ↔ I/O du subgraph)
    // laisserait une RÉFÉRENCE PENDANTE dans l'entrée/sortie du subgraph.
    for (const list of [graph.inputs, graph.outputs]) {
        if (!Array.isArray(list)) continue;
        for (const slot of list) {
            if (!slot || !Array.isArray(slot.linkIds)) continue;
            const kept = slot.linkIds.filter((id) => String(id) !== target);
            if (kept.length !== slot.linkIds.length) {
                // Mutation EN PLACE (linkIds est `readonly` côté classes Subgraph).
                slot.linkIds.length = 0;
                for (const id of kept) slot.linkIds.push(id);
            }
        }
    }
}

/**
 * Index du slot de `newSlots` correspondant à `oldSlot` : d'abord par NOM
 * (exact, insensible à la casse), sinon par TYPE de données. `used` (Set
 * d'index déjà pris) évite de réutiliser un slot. -1 si aucun équivalent.
 */
function matchNewSlot(oldSlot, newSlots, used) {
    if (!oldSlot || !Array.isArray(newSlots)) return -1;
    const name = oldSlot.name === undefined || oldSlot.name === null ? "" : String(oldSlot.name).toLowerCase().trim();
    if (name) {
        const i = newSlots.findIndex((s, idx) => !used.has(idx) && s && s.name !== undefined && s.name !== null && String(s.name).toLowerCase().trim() === name);
        if (i >= 0) return i;
    }
    const type = oldSlot.type === undefined || oldSlot.type === null ? "" : String(oldSlot.type);
    if (type && type !== "*") {
        const j = newSlots.findIndex((s, idx) => !used.has(idx) && s && s.type !== undefined && String(s.type) === type);
        if (j >= 0) return j;
    }
    return -1;
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

// ─── Navigation / recadrage de la VUE (action de vue : aucun snapshot) ──────
// API réellement disponible (frontend ComfyUI récent — vérifié sur la source de
// référence 1.47.11 du pack) :
//   - `canvas.ds` (DragAndScale) : `.offset` [x,y], `.scale`, `.min_scale`,
//     `.max_scale`, `.fitToBounds(bounds, { zoom })` (cadrage SYNCHRONE),
//     `.animateToBounds(...)` ;
//   - `canvas.centerOnNode(node)` : centre en conservant l'échelle courante
//     (mécanisme DÉJÀ utilisé par le pack : [FOCUS]/[MOVE_TO] du chat
//     historique, blobby_companion.js) ;
//   - `canvas.setGraph(g)` / `canvas.openSubgraph(sg, fromNode)` : navigation
//     (déjà utilisée par open_subgraph/close_subgraph) ;
//   - `canvas.selectItems(items)` / `.deselectAll()` : sélection = état de VUE.
// `js/holaf_shortcuts.js` (mécanisme EXISTANT du pack) est réutilisé quand il
// est chargé : `app.holafShortcuts.navigateToPath(path)` bascule de graphe (il
// gère la hiérarchie des subgraphs), puis on applique offset/échelle comme un
// raccourci enregistré. Repli direct openSubgraph/setGraph sinon.

/** Boîte [x,y,w,h] d'un nœud OU d'un groupe (boundingRect réel, sinon pos/size). */
function nodeBoundsRect(item) {
    if (!item) return [0, 0, 0, 0];
    const br = item.boundingRect;
    if (br && typeof br.length === "number" && br.length >= 4
        && Number.isFinite(br[0]) && Number.isFinite(br[1]) && Number.isFinite(br[2]) && Number.isFinite(br[3])) {
        return [br[0], br[1], br[2], br[3]];
    }
    const p = numberPair(item.pos) || [0, 0];
    const s = numberPair(item.size) || [0, 0];
    return [Number(p[0]) || 0, Number(p[1]) || 0, Number(s[0]) || 0, Number(s[1]) || 0];
}

/** Union de boîtes [x,y,w,h] (marge optionnelle) ; null si aucune boîte finie. */
function unionBounds(rects, padding) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of rects) {
        if (!r) continue;
        minX = Math.min(minX, r[0]);
        minY = Math.min(minY, r[1]);
        maxX = Math.max(maxX, r[0] + r[2]);
        maxY = Math.max(maxY, r[1] + r[3]);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
    const pad = Number.isFinite(Number(padding)) ? Number(padding) : 0;
    return [minX - pad, minY - pad, (maxX - minX) + 2 * pad, (maxY - minY) + 2 * pad];
}

/** Taille CSS du viewport canvas [largeur, hauteur] (px CSS, comme fitToBounds). */
function canvasViewportSize(canvas) {
    const el = (canvas && canvas.canvas) || (canvas && canvas.ds && canvas.ds.element) || null;
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    const w = el && Number.isFinite(Number(el.width)) && Number(el.width) > 0 ? Number(el.width) / dpr : 1024;
    const h = el && Number.isFinite(Number(el.height)) && Number(el.height) > 0 ? Number(el.height) / dpr : 768;
    return [w, h];
}

/** Centre du viewport exprimé en coordonnées du graphe (pour un placement par défaut). */
function viewportCenter(ctx) {
    const canvas = resolveCanvas(ctx);
    const ds = canvas && canvas.ds;
    if (!ds || !Array.isArray(ds.offset)) return [0, 0];
    const scale = Number.isFinite(ds.scale) && ds.scale > 0 ? ds.scale : 1;
    const [cw, ch] = canvasViewportSize(canvas);
    return [(cw * 0.5) / scale - ds.offset[0], (ch * 0.5) / scale - ds.offset[1]];
}

/** Échelle bornée aux min/max de DragAndScale ; null si la valeur est invalide. */
function clampScale(ds, value) {
    const z = Number(value);
    if (!Number.isFinite(z) || z <= 0) return null;
    const lo = ds && Number.isFinite(ds.min_scale) ? ds.min_scale : 0.1;
    const hi = ds && Number.isFinite(ds.max_scale) ? ds.max_scale : 10;
    return Math.min(hi, Math.max(lo, z));
}

/**
 * Applique un recadrage de vue. `opts` :
 *   - singleNode : nœud unique, sans zoom explicite → `canvas.centerOnNode`
 *     (mécanisme existant, échelle conservée) ;
 *   - scale : échelle absolue (null = conserver l'échelle courante) ;
 *   - fit : cadrer l'ensemble des bornes (tout le workflow) ; fitZoom = marge.
 * Retourne { ok, via, scale, offset } ou { ok:false, code, error }.
 */
function applyFocusView(ctx, bounds, opts) {
    const canvas = resolveCanvas(ctx);
    const noCanvas = () => ({ ok: false, code: "no_canvas", error: label(ctx, "bl.toolErr.noCanvas", {}, "canvas ComfyUI indisponible (app.canvas introuvable)") });
    if (!canvas) return noCanvas();
    const ds = canvas.ds;
    if (!ds || !Array.isArray(ds.offset)) return noCanvas();
    const o = opts || {};
    const b = Array.isArray(bounds) && bounds.length >= 4 ? bounds : [0, 0, 0, 0];
    if (o.singleNode && o.scale === null && typeof canvas.centerOnNode === "function") {
        canvas.centerOnNode(o.singleNode);
        if (typeof canvas.setDirty === "function") canvas.setDirty(true, true);
        return { ok: true, via: "centerOnNode", scale: ds.scale, offset: ds.offset.slice(0, 2) };
    }
    if (o.fit && o.scale === null && typeof ds.fitToBounds === "function") {
        ds.fitToBounds(b, { zoom: o.fitZoom });
        if (typeof canvas.setDirty === "function") canvas.setDirty(true, true);
        return { ok: true, via: "fitToBounds", scale: ds.scale, offset: ds.offset.slice(0, 2) };
    }
    const [cw, ch] = canvasViewportSize(canvas);
    let scale = o.scale !== null ? o.scale : ds.scale;
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    if (o.fit && o.scale === null) {
        const fitScale = Math.min(cw / Math.max(b[2], 1), ch / Math.max(b[3], 1)) * (o.fitZoom || 0.85);
        const clamped = clampScale(ds, fitScale);
        if (clamped !== null) scale = clamped;
    }
    ds.scale = scale;
    // Même formule que DragAndScale.fitToBounds / centerOnNode : offset = centre
    // de l'écran (en unités du graphe) − centre des bornes.
    ds.offset[0] = -b[0] - b[2] * 0.5 + (cw / scale) * 0.5;
    ds.offset[1] = -b[1] - b[3] * 0.5 + (ch / scale) * 0.5;
    if (typeof canvas.setDirty === "function") canvas.setDirty(true, true);
    return { ok: true, via: "offset", scale: ds.scale, offset: ds.offset.slice(0, 2) };
}

/** Bascule le canvas sur `targetGraph` (racine si null/root). Réutilise holaf_shortcuts. */
function navigateToGraph(ctx, targetGraph) {
    const canvas = resolveCanvas(ctx);
    const root = getGraph(ctx);
    if (!canvas) return { ok: false, code: "no_canvas", error: label(ctx, "bl.toolErr.noCanvas", {}, "canvas ComfyUI indisponible (app.canvas introuvable)") };
    if (!root) return { ok: false, code: "no_app", error: label(ctx, "bl.toolErr.noApp", {}, "workflow ComfyUI indisponible (app/graph introuvable)") };
    const fail = (detail) => ({ ok: false, code: "focus_failed", error: label(ctx, "bl.toolErr.focusFailed", { error: detail }, "recadrage de la vue impossible : {error}") });
    const app = resolveApp(ctx);
    const hs = app && app.holafShortcuts;
    const cur = activeSubgraph(ctx);
    const targetIsRoot = !targetGraph || targetGraph === root;
    if (targetIsRoot) {
        if (!cur) return { ok: true, switched: false, at_root: true };
        try {
            if (hs && typeof hs.navigateToPath === "function") hs.navigateToPath([]);
            else if (typeof canvas.setGraph === "function") canvas.setGraph(root);
            else return fail("aucune API canvas (setGraph) pour revenir à la racine");
        } catch (e) { return fail((e && e.message) || String(e)); }
        if (activeSubgraph(ctx)) return fail("le canvas est toujours dans un subgraph");
        return { ok: true, switched: true, at_root: true };
    }
    if (cur && String(cur.id) === String(targetGraph.id)) return { ok: true, switched: false };
    // Réutilisation du mécanisme EXISTANT des raccourcis (chemin de nœuds racine→subgraph).
    if (hs && typeof hs.findPathToGraph === "function" && typeof hs.navigateToPath === "function") {
        try {
            const path = hs.findPathToGraph(targetGraph, root);
            if (path) {
                hs.navigateToPath(path);
                const now = activeSubgraph(ctx);
                if (now && String(now.id) === String(targetGraph.id)) return { ok: true, switched: true, via: "holafShortcuts" };
            }
        } catch { /* repli direct ci-dessous */ }
    }
    try {
        if (typeof canvas.openSubgraph === "function") canvas.openSubgraph(targetGraph, findSubgraphInstanceNode(ctx, targetGraph.id));
        else if (typeof canvas.setGraph === "function") canvas.setGraph(targetGraph);
        else return fail("aucune API canvas (openSubgraph/setGraph)");
    } catch (e) { return fail((e && e.message) || String(e)); }
    const now = activeSubgraph(ctx);
    if (!now || String(now.id) !== String(targetGraph.id)) return fail("le canvas n'a pas changé de graphe");
    return { ok: true, switched: true, via: "openSubgraph" };
}

/**
 * Résout une cible « nœud/groupe » : exactement UNE forme parmi id, nodes ou
 * group (avec `subgraph` optionnel pour le scope). Retourne
 * { nodes, group, graph } ou { error, code }. Partagé par focus_view et select_node.
 */
function resolveNodeTargets(ctx, args) {
    const a = args || {};
    const hasId = a.id !== undefined && a.id !== null && a.id !== "";
    const hasNodes = Array.isArray(a.nodes) && a.nodes.length > 0;
    const hasGroup = a.group !== undefined && a.group !== null && String(a.group).trim() !== "";
    if ((hasId ? 1 : 0) + (hasNodes ? 1 : 0) + (hasGroup ? 1 : 0) !== 1) {
        return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "fournir UNE cible exactement : id, nodes ou group" }, "arguments invalides : {detail}"), code: "invalid_args" };
    }
    const scopeArgs = (a.subgraph !== undefined && a.subgraph !== null && String(a.subgraph).trim() !== "") ? { subgraph: a.subgraph } : {};
    if (hasGroup) {
        let graph = getGraph(ctx);
        let scope = null;
        if (scopeArgs.subgraph !== undefined) {
            const rs = requireReachableSubgraph(ctx, resolveSubgraphRef(ctx, a.subgraph));
            if (rs.error) return rs;
            graph = rs.subgraph;
            scope = rs.subgraph;
        }
        if (!graph) return { error: label(ctx, "bl.toolErr.noApp", {}, "workflow ComfyUI indisponible (app/graph introuvable)"), code: "no_app" };
        const group = findGroup(graph, a.group);
        if (!group) return { error: label(ctx, "bl.toolErr.groupNotFound", { ref: String(a.group) }, "groupe '{ref}' introuvable (utilise list_groups)"), code: "group_not_found" };
        return { nodes: recomputeGroupNodes(group).slice(), group: group, graph: scope || group.graph || getGraph(ctx) };
    }
    const ids = hasId ? [a.id] : a.nodes.slice();
    if (ids.length > 500) return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "1 à 500 ids maximum" }, "arguments invalides : {detail}"), code: "invalid_args" };
    const nodes = [];
    let graph = null;
    for (const one of ids) {
        const r = findNode(ctx, one, scopeArgs);
        if (r.error) return r;
        if (!nodes.includes(r.node)) nodes.push(r.node);
        const g = r.subgraph || r.node.graph || getGraph(ctx);
        if (!graph) graph = g;
        else if (g !== graph && String(g && g.id) !== String(graph && graph.id)) {
            return { error: label(ctx, "bl.toolErr.mixedGraph", {}, "les nœuds ciblés n'appartiennent pas tous au même graphe (cible un seul subgraph à la fois)"), code: "mixed_graph" };
        }
    }
    return { nodes: nodes, group: null, graph: graph || getGraph(ctx) };
}

// ─── Groupes : création / édition ────────────────────────────────────────────

/** Construit un LGraphGroup réel (LiteGraph courant), sinon le constructeur d'un groupe existant. */
function buildGroup(ctx, graph, title) {
    try { if (ctx && typeof ctx.createGroupImpl === "function") return ctx.createGroupImpl(graph, title); } catch { /* repli */ }
    const LG = (typeof window !== "undefined" && window.LiteGraph) || (typeof globalThis !== "undefined" && globalThis.LiteGraph) || null;
    if (LG && typeof LG.LGraphGroup === "function") {
        try { return new LG.LGraphGroup(title); } catch { /* repli */ }
    }
    const existing = graphGroups(graph)[0];
    if (existing && existing.constructor && existing.constructor !== Object) {
        try { return new existing.constructor(title); } catch { /* repli */ }
    }
    return null;
}

/** Ajoute un groupe au graphe (graph.add, sinon poussée directe dans graph.groups). */
function addGroupToGraph(graph, group) {
    if (!graph || !group) return false;
    const groups = graphGroups(graph);
    try {
        if (typeof graph.add === "function") {
            graph.add(group, true);
            if (groups.indexOf(group) >= 0) return true;
        }
    } catch { /* repli direct */ }
    if (Array.isArray(groups) && groups.indexOf(group) < 0) {
        groups.push(group);
        try { group.graph = graph; } catch { /* ignore */ }
        try { if (typeof graph.setDirtyCanvas === "function") graph.setDirtyCanvas(true, true); } catch { /* ignore */ }
        return true;
    }
    return groups.indexOf(group) >= 0;
}

// ─── Subgraphs : création / conversion / dépaquetage ─────────────────────────

/** UUID v4 (crypto.randomUUID si disponible, sinon repli Math.random). */
function generateUuid() {
    try { if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID(); } catch { /* repli */ }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return ((c === "x" ? r : ((r & 0x3) | 0x8))).toString(16);
    });
}

/** Données d'un subgraph VIDE (mêmes champs que ceux produits par convertToSubgraph). */
function emptySubgraphData(id, name) {
    return {
        id: id,
        name: name,
        description: "",
        inputNode: { id: -10, bounding: [0, 0, 75, 100] },
        outputNode: { id: -20, bounding: [0, 0, 75, 100] },
        inputs: [],
        outputs: [],
        widgets: [],
        version: 1,
        state: { lastGroupId: 0, lastNodeId: 0, lastLinkId: 0, lastRerouteId: 0 },
        revision: 0,
        config: {},
        links: [],
        nodes: [],
        reroutes: [],
        groups: [],
    };
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
                pos: numberPair(n.pos),
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
                mode: n.mode, mode_name: nodeModeName(n.mode), pos: numberPair(n.pos), size: numberPair(n.size),
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
                pos: numberPair(n.pos),
                size: numberPair(n.size),
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
                pos: numberPair(n.pos),
                size: numberPair(n.size),
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
    description: "Liste les groupes (cadres) du graphe : titre, id, couleur, position/taille et ids des nœuds contenus. Cible ensuite un groupe entier avec set_node_mode (argument group), le MODIFIE avec edit_group, ou le CADRE avec focus_view. Pour les groupes d'un subgraph, fournis subgraph.",
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
                pos: numberPair(g.pos),
                size: numberPair(g.size),
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

registerTool({
    name: "focus_view",
    description: "Recadre la VUE du canvas (pan/zoom) pour MONTRER une cible précise : un nœud (id), un lot (nodes), un groupe (group), une zone (area) ou tout le workflow (all). Ouvre automatiquement le subgraph qui contient la cible (subgraph) — utile pour montrer un nœud interne. Action de VUE uniquement : ne modifie PAS le workflow, aucun snapshot. zoom = échelle absolue optionnelle (1 = 100 %) ; sans zoom l'échelle courante est conservée (sauf all, qui cadre le workflow entier).",
    schema: {
        type: "object",
        properties: {
            id: { type: ["number", "string"], description: "Nœud à cadrer (alternative à nodes/group/area/all)." },
            nodes: { type: "array", items: { type: ["number", "string"] }, description: "Lot de nœuds à cadrer (alternative à id/group/area/all)." },
            group: { type: ["string", "number"], description: "Titre ou id d'un groupe à cadrer (alternative à id/nodes/area/all)." },
            area: {
                type: "object",
                description: "Zone rectangulaire du graphe (unités du graphe).",
                properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
                required: ["x", "y", "width", "height"],
            },
            all: { type: "boolean", description: "true = cadrer tout le workflow (défaut si aucune autre cible)." },
            subgraph: subgraphProp(),
            zoom: { type: "number", description: "Échelle absolue optionnelle (1 = 100 %)." },
        },
        required: [],
    },
    mode: "read",
    async exec(args, ctx) {
        const canvas = resolveCanvas(ctx);
        if (!canvas) return { error: label(ctx, "bl.toolErr.noCanvas", {}, "canvas ComfyUI indisponible (app.canvas introuvable)"), code: "no_canvas" };
        const root = getGraph(ctx);
        if (!root) return { error: label(ctx, "bl.toolErr.noApp", {}, "workflow ComfyUI indisponible (app/graph introuvable)"), code: "no_app" };
        const hasId = args.id !== undefined && args.id !== null && args.id !== "";
        const hasNodes = Array.isArray(args.nodes) && args.nodes.length > 0;
        const hasGroup = args.group !== undefined && args.group !== null && String(args.group).trim() !== "";
        const hasArea = !!args.area && typeof args.area === "object" && !Array.isArray(args.area);
        const wantsAll = args.all === true;
        const forms = ((hasId || hasNodes || hasGroup) ? 1 : 0) + (hasArea ? 1 : 0) + (wantsAll ? 1 : 0);
        if (forms > 1) {
            return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "fournir UNE cible exactement : id, nodes, group, area ou all" }, "arguments invalides : {detail}"), code: "invalid_args" };
        }
        let zoom = null;
        if (args.zoom !== undefined && args.zoom !== null && args.zoom !== "") {
            zoom = Number(args.zoom);
            if (!Number.isFinite(zoom) || zoom <= 0) {
                return { error: label(ctx, "bl.toolErr.invalidValue", { detail: "zoom '" + String(args.zoom) + "' (attendu un nombre > 0)" }, "valeur invalide : {detail}"), code: "invalid_value" };
            }
        }
        const hasScope = args.subgraph !== undefined && args.subgraph !== null && String(args.subgraph).trim() !== "";
        let scope = null;
        if (hasScope) {
            const rs = resolveSubgraphRef(ctx, args.subgraph);
            if (rs.error) return rs;
            scope = rs.subgraph;
        }
        let targetGraph = null;
        let nodes = [];
        let bounds = null;
        let kind = "all";
        let singleNode = null;
        let targetDesc = label(ctx, "bl.focus.all", {}, "tout le workflow");
        if (hasId || hasNodes || hasGroup) {
            const rt = resolveNodeTargets(ctx, args);
            if (rt.error) return rt;
            nodes = rt.nodes;
            targetGraph = rt.graph;
            if (rt.group) {
                kind = "group";
                targetDesc = String(rt.group.title || args.group);
                bounds = nodeBoundsRect(rt.group);
            } else {
                kind = "nodes";
                if (nodes.length === 1) {
                    singleNode = nodes[0];
                    targetDesc = nodeTitle(nodes[0]);
                } else {
                    targetDesc = label(ctx, "bl.focus.nodes", { count: String(nodes.length) }, "{count} nœud(s)");
                }
                bounds = unionBounds(nodes.map(nodeBoundsRect), 20);
            }
            if (!bounds) bounds = [0, 0, 0, 0];
        } else if (hasArea) {
            const a = args.area;
            const x = Number(a.x), y = Number(a.y), w = Number(a.width), h = Number(a.height);
            if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
                return { error: label(ctx, "bl.toolErr.invalidValue", { detail: "area requiert x/y/width/height numériques avec width>0 et height>0" }, "valeur invalide : {detail}"), code: "invalid_value" };
            }
            targetGraph = scope || activeSubgraph(ctx) || root;
            kind = "area";
            targetDesc = label(ctx, "bl.focus.zone", {}, "une zone");
            bounds = [x, y, w, h];
        } else {
            targetGraph = scope || activeSubgraph(ctx) || root;
            kind = "all";
            const list = Array.isArray(targetGraph.nodes) ? targetGraph.nodes : [];
            const rects = list.map(nodeBoundsRect).concat(graphGroups(targetGraph).map(nodeBoundsRect));
            bounds = unionBounds(rects, 20) || [0, 0, 0, 0];
            nodes = list.slice();
        }
        const nav = navigateToGraph(ctx, targetGraph);
        if (!nav.ok) return { error: nav.error, code: nav.code };
        const applied = applyFocusView(ctx, bounds, { singleNode: singleNode, scale: zoom, fit: kind === "all", fitZoom: 0.85 });
        if (!applied.ok) return { error: applied.error, code: applied.code };
        dirtyCanvas(ctx);
        const cur = activeSubgraph(ctx);
        return {
            data: {
                centered_on: kind,
                graph: cur ? "subgraph" : "root",
                subgraph: cur ? subgraphScopeInfo(cur) : null,
                node_count: nodes.length,
                bounds: [bounds[0], bounds[1], bounds[2], bounds[3]],
                scale: applied.scale,
                offset: applied.offset,
                via: applied.via,
            },
            action: label(ctx, "bl.toolAct.focusView", { target: targetDesc }, "🎯 Vue recentrée sur {target}"),
        };
    },
});

registerTool({
    name: "select_node",
    description: "Sélectionne et surligne (état de sélection du canvas) un nœud (id), un lot (nodes) ou un groupe entier (group) pour attirer l'attention — action de VUE, aucune mutation, aucun snapshot. Ouvre le subgraph contenant la cible si nécessaire. clear=true efface la sélection. center=true recadre aussi la vue sur la sélection.",
    schema: {
        type: "object",
        properties: {
            id: { type: ["number", "string"], description: "Nœud à sélectionner (alternative à nodes/group)." },
            nodes: { type: "array", items: { type: ["number", "string"] }, description: "Lot de nœuds à sélectionner (alternative à id/group)." },
            group: { type: ["string", "number"], description: "Titre ou id d'un groupe : sélectionne TOUS ses nœuds (alternative à id/nodes)." },
            subgraph: subgraphProp(),
            clear: { type: "boolean", description: "true = désélectionner tout (ignore id/nodes/group)." },
            center: { type: "boolean", description: "true = recadrer aussi la vue sur la sélection." },
        },
        required: [],
    },
    mode: "read",
    async exec(args, ctx) {
        const canvas = resolveCanvas(ctx);
        if (!canvas) return { error: label(ctx, "bl.toolErr.noCanvas", {}, "canvas ComfyUI indisponible (app.canvas introuvable)"), code: "no_canvas" };
        const selectUnavailable = () => ({ error: label(ctx, "bl.toolErr.selectUnavailable", {}, "sélection canvas indisponible (API selectItems/selectNodes absente)"), code: "select_unavailable" });
        if (args.clear === true) {
            if (typeof canvas.deselectAll === "function") canvas.deselectAll();
            else if (typeof canvas.selectItems === "function") canvas.selectItems([]);
            else return selectUnavailable();
            dirtyCanvas(ctx);
            return { data: { cleared: true, selected: [] }, action: label(ctx, "bl.toolAct.deselect", {}, "👁️ Sélection effacée") };
        }
        const rt = resolveNodeTargets(ctx, args);
        if (rt.error) return rt;
        if (!rt.nodes.length) {
            return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "aucun nœud à sélectionner" }, "arguments invalides : {detail}"), code: "invalid_args" };
        }
        const nav = navigateToGraph(ctx, rt.graph);
        if (!nav.ok) return { error: nav.error, code: nav.code };
        let selected = false;
        if (typeof canvas.selectItems === "function") { canvas.selectItems(rt.nodes, false); selected = true; }
        else if (typeof canvas.selectNodes === "function") { canvas.selectNodes(rt.nodes, false); selected = true; }
        else if (typeof canvas.selectNode === "function" && rt.nodes.length === 1) { canvas.selectNode(rt.nodes[0], false); selected = true; }
        if (!selected) return selectUnavailable();
        let centered = false;
        if (args.center === true) {
            const bounds = unionBounds(rt.nodes.map(nodeBoundsRect), 20) || [0, 0, 0, 0];
            const applied = applyFocusView(ctx, bounds, { singleNode: rt.nodes.length === 1 ? rt.nodes[0] : null, scale: null, fit: false });
            centered = !!applied.ok;
        }
        dirtyCanvas(ctx);
        const name = rt.group
            ? String(rt.group.title || args.group)
            : (rt.nodes.length === 1 ? nodeTitle(rt.nodes[0]) : label(ctx, "bl.focus.nodes", { count: String(rt.nodes.length) }, "{count} nœud(s)"));
        return {
            data: {
                selected: rt.nodes.map((n) => n.id),
                group: rt.group ? String(rt.group.title || "") : null,
                centered: centered,
                subgraph: activeSubgraph(ctx) ? subgraphScopeInfo(activeSubgraph(ctx)) : null,
            },
            action: label(ctx, "bl.toolAct.selectNode", { name: name }, "👁️ {name} sélectionné"),
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
        const previous = numberPair(node.pos);
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
        const previous = numberPair(node.size);
        try {
            if (typeof node.setSize === "function") node.setSize([w, h]);
            else node.size = [w, h];
        } catch (e) {
            return { error: label(ctx, "bl.toolErr.exec", { error: (e && e.message) || String(e) }, "échec de l'outil : {error}"), code: "exec_error" };
        }
        const size = numberPair(node.size) || [w, h];
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
    name: "change_node_type",
    description: "Change la CLASSE (le type ComfyUI) d'un nœud EXISTANT, SANS le supprimer ni le recréer : le nœud garde sa position, sa taille, son titre, sa couleur et son mode (enable/mute/bypass). Les CONNEXIONS EXISTANTES SONT CONSERVÉES : chaque lien est recâblé vers le slot de même NOM (puis de même TYPE de données) de la nouvelle classe — les liaisons compatibles ne sont donc PAS cassées. Seuls les liens qui n'ont AUCUN slot équivalent dans la nouvelle classe sont détachés PROPREMENT (jamais de lien pendant) et comptés (links_lost / lost_inputs / lost_outputs) : c'est le comportement normal d'un changement de classe, PAS une connexion cassée. Idéal pour RÉPARER un workflow dont un nœud a un type manquant/supprimé (ex. ancien alias 'Holaf*' → 'AIH*'). Les widgets absents de la nouvelle classe sont également listés (lost_widgets). La nouvelle classe doit exister (erreur claire sinon — vérifie son nom exact avec get_object_info). Retyper vers le MÊME type est un no-op signalé. Mutatif (annulable). Pour un nœud dans un subgraph, fournis subgraph (UUID, nom, ou 'current').",
    schema: {
        type: "object",
        properties: {
            id: { type: ["number", "string"], description: "Identifiant du nœud à retyper (accepte aussi le locator « uuid-subgraph:id »)." },
            type: { type: "string", description: "Nouvelle classe/type ComfyUI du nœud (ex. 'KSampler' ; le nom exact se vérifie avec get_object_info)." },
            subgraph: subgraphProp(),
        },
        required: ["id", "type"],
    },
    mode: "active",
    undoable: true,
    async exec(args, ctx) {
        const r = findNode(ctx, args.id, args);
        if (r.error) return r;
        const oldNode = r.node;
        const newType = String(args.type === undefined || args.type === null ? "" : args.type).trim();
        if (!newType) {
            return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "type manquant" }, "arguments invalides : {detail}"), code: "invalid_args" };
        }
        const owner = (oldNode && oldNode.graph) || r.subgraph || getGraph(ctx);
        if (!owner) {
            return { error: label(ctx, "bl.toolErr.noApp", {}, "workflow ComfyUI indisponible (app/graph introuvable)"), code: "no_app" };
        }
        const oldType = String(oldNode.type || oldNode.comfyClass || "");
        // Même type → no-op explicitement signalé (aucune mutation).
        if (oldType && oldType === newType) {
            return {
                data: {
                    node: oldNode.id, previous_type: oldType, type: newType,
                    noop: true, changed: false,
                    pos: numberPair(oldNode.pos), size: numberPair(oldNode.size),
                    subgraph: subgraphScopeInfo(r.subgraph),
                },
                action: label(ctx, "bl.toolAct.changeNodeTypeNoop", { name: nodeTitle(oldNode), type: newType }, "⏭️ {name} est déjà de type {type} (aucun changement)"),
            };
        }
        // 1) Créer l'instance de la nouvelle classe. C'est la VALIDATION
        //    d'existence : LiteGraph.createNode renvoie null pour un type non
        //    enregistré (ce que get_object_info signalerait sans argument).
        let newNode = null;
        try {
            if (ctx && typeof ctx.createNodeImpl === "function") newNode = ctx.createNodeImpl(newType, ctx);
            else if (typeof window !== "undefined" && window.LiteGraph && typeof window.LiteGraph.createNode === "function") newNode = window.LiteGraph.createNode(newType);
            else if (typeof owner.createNode === "function") newNode = owner.createNode(newType);
        } catch { newNode = null; }
        if (!newNode) {
            return {
                error: label(ctx, "bl.toolErr.classUnknown", { class: newType }, "type de nœud '{class}' inconnu (get_object_info sans argument liste les types disponibles)"),
                code: "class_unknown",
            };
        }
        const changeFail = (detail) => ({
            error: label(ctx, "bl.toolErr.changeFailed", { error: detail }, "changement de type impossible : {error}"),
            code: "change_failed",
        });

        // 2) Sérialisation de l'ancien nœud (properties + titre personnalisé).
        let serialized = null;
        try { serialized = (typeof oldNode.serialize === "function") ? oldNode.serialize() : null; } catch { serialized = null; }

        // 3) Préserver identité & présentation : id, pos, size, order, mode,
        //    flags, couleur, titre personnalisé, properties.
        const keptPos = numberPair(oldNode.pos);
        const keptSize = numberPair(oldNode.size);
        try { if (oldNode.id !== undefined) newNode.id = oldNode.id; } catch { /* id figé ? tant pis */ }
        // Frontend récent : re-binder chaque widget sur l'id (définitif) du nœud.
        // Les widgets créés par `createNode` visent un id non assigné ; sans ce
        // setNodeId, leurs valeurs peuvent perdre leur liaison (WidgetValueStore)
        // après le remplacement. Le frontend de référence le fait dans
        // replaceWithMapping (isNodeBindable(widget) → widget.setNodeId(id)).
        for (const w of (Array.isArray(newNode.widgets) ? newNode.widgets : [])) {
            if (w && typeof w.setNodeId === "function") { try { w.setNodeId(newNode.id); } catch { /* widget non bindable */ } }
        }
        if (keptPos) { try { newNode.pos = [keptPos[0], keptPos[1]]; } catch { /* ignore */ } }
        if (keptSize) { try { newNode.size = [keptSize[0], keptSize[1]]; } catch { /* ignore */ } }
        if (oldNode.order !== undefined) { try { newNode.order = oldNode.order; } catch { /* ignore */ } }
        if (oldNode.mode !== undefined) { try { newNode.mode = oldNode.mode; } catch { /* ignore */ } }
        if (oldNode.flags) { try { newNode.flags = Object.assign({}, oldNode.flags); } catch { /* ignore */ } }
        if (oldNode.color !== undefined) { try { newNode.color = oldNode.color; } catch { /* ignore */ } }
        if (oldNode.bgcolor !== undefined) { try { newNode.bgcolor = oldNode.bgcolor; } catch { /* ignore */ } }
        // Titre : on conserve le titre PERSONNALISÉ (celui de serialize(), sinon
        // un titre live qui n'est ni l'ancien type ni l'ancienne comfyClass).
        let customTitle = null;
        if (serialized && serialized.title !== undefined && serialized.title !== null && serialized.title !== "") customTitle = String(serialized.title);
        else if (typeof oldNode.title === "string" && oldNode.title && oldNode.title !== oldType && oldNode.title !== String(oldNode.comfyClass || "")) customTitle = oldNode.title;
        if (customTitle !== null) { try { newNode.title = customTitle; } catch { /* ignore */ } }
        // Propriétés : recopie + « Node name for S&R » aligné sur la nouvelle classe.
        const props = (serialized && serialized.properties) || oldNode.properties;
        if (props && typeof props === "object") {
            const copy = Object.assign({}, props);
            if ("Node name for S&R" in copy) copy["Node name for S&R"] = newType;
            try { newNode.properties = copy; } catch { /* ignore */ }
        }

        // 4) Widgets : recopie par NOM (valeur + callback). Les widgets de
        //    l'ancien nœud absents de la nouvelle classe sont PERDUS → listés.
        const oldWidgets = Array.isArray(oldNode.widgets) ? oldNode.widgets.filter((w) => w && w.name !== undefined) : [];
        const newWidgets = Array.isArray(newNode.widgets) ? newNode.widgets.filter((w) => w && w.name !== undefined) : [];
        const lostWidgets = [];
        let widgetsCopied = 0;
        for (const w of oldWidgets) {
            const target = newWidgets.find((x) => String(x.name) === String(w.name));
            if (!target) { lostWidgets.push({ name: w.name, value: w.value }); continue; }
            try {
                target.value = w.value;
                if (typeof target.callback === "function") target.callback(target.value);
                widgetsCopied++;
            } catch { lostWidgets.push({ name: w.name, value: w.value }); }
        }
        const newOnlyWidgets = newWidgets.filter((x) => !oldWidgets.some((w) => String(w.name) === String(x.name))).map((x) => x.name);

        // 5) Liens : rattacher chaque entrée/sortie de l'ancien nœud au slot
        //    correspondant de la nouvelle classe (nom exact, puis type). Ce qui
        //    n'a pas d'équivalent est DÉTACHÉ et listé (jamais de lien orphelin).
        const oldInputs = Array.isArray(oldNode.inputs) ? oldNode.inputs : [];
        const newInputs = Array.isArray(newNode.inputs) ? newNode.inputs : [];
        const oldOutputs = Array.isArray(oldNode.outputs) ? oldNode.outputs : [];
        const newOutputs = Array.isArray(newNode.outputs) ? newNode.outputs : [];
        const usedIn = new Set();
        const usedOut = new Set();
        let reconnected = 0;
        let linksLost = 0;
        const lostInputs = [];
        const lostOutputs = [];
        const slotLabel = (slot, idx) => (slot && slot.name !== undefined && slot.name !== null ? slot.name : idx);

        for (let oi = 0; oi < oldInputs.length; oi++) {
            const oldIn = oldInputs[oi];
            if (!oldIn) continue;
            const ni = matchNewSlot(oldIn, newInputs, usedIn);
            if (ni < 0) {
                // Slot sans équivalent → signalé « perdu » (lien détaché s'il existait).
                lostInputs.push(slotLabel(oldIn, oi));
                if (oldIn.link !== undefined && oldIn.link !== null) {
                    const lostLinkId = oldIn.link;
                    linksLost++;
                    clearLinkRefs(owner, lostLinkId, newNode);
                    removeGraphLink(owner, lostLinkId);
                    try { oldIn.link = null; } catch { /* ignore */ }
                }
                continue;
            }
            const linkId = oldIn.link;
            if (linkId === undefined || linkId === null) { usedIn.add(ni); continue; }
            try {
                const link = getLinkById(owner, linkId);
                if (link) {
                    link.target_id = newNode.id; link.target_slot = ni;
                    newInputs[ni].link = linkId;
                    oldIn.link = null;
                    usedIn.add(ni);
                    reconnected++;
                } else {
                    // Lien absent du registre (référence pendante PRÉEXISTANTE) :
                    // on ne RECRÉE pas la référence sur la nouvelle node et on ne
                    // la compte pas « recâblée » — on la nettoie partout, EXACTEMENT
                    // comme la branche SORTIE (jamais de lien pendant, pas de faux
                    // « conservé »). Un éventuel doublon posé par createNode est
                    // nettoyé aussi.
                    const dup = newInputs[ni].link;
                    if (dup !== undefined && dup !== null) { clearLinkRefs(owner, dup, newNode); removeGraphLink(owner, dup); }
                    newInputs[ni].link = null;
                    oldIn.link = null;
                    usedIn.add(ni);
                    linksLost++;
                    clearLinkRefs(owner, linkId, newNode);
                    removeGraphLink(owner, linkId);
                }
            } catch {
                lostInputs.push(slotLabel(oldIn, oi));
                linksLost++;
                clearLinkRefs(owner, linkId, newNode);
                removeGraphLink(owner, linkId);
                try { oldIn.link = null; } catch { /* ignore */ }
            }
        }

        for (let oo = 0; oo < oldOutputs.length; oo++) {
            const oldOut = oldOutputs[oo];
            if (!oldOut) continue;
            const outLinks = Array.isArray(oldOut.links) ? oldOut.links.slice() : (oldOut.links === undefined || oldOut.links === null ? [] : [oldOut.links]);
            const no = matchNewSlot(oldOut, newOutputs, usedOut);
            if (no < 0) {
                lostOutputs.push(slotLabel(oldOut, oo));
                linksLost += outLinks.length;
                for (const lid of outLinks) { clearLinkRefs(owner, lid, newNode); removeGraphLink(owner, lid); }
                try { oldOut.links = []; } catch { /* ignore */ }
                continue;
            }
            usedOut.add(no);
            if (!Array.isArray(newOutputs[no].links)) newOutputs[no].links = [];
            for (const lid of outLinks) {
                try {
                    const link = getLinkById(owner, lid);
                    if (link) {
                        link.origin_id = newNode.id; link.origin_slot = no;
                        newOutputs[no].links.push(lid);
                        reconnected++;
                    } else {
                        // Lien absent du registre (référence pendante préexistante) :
                        // on ne RECRÉE pas la référence — on la nettoie partout
                        // (jamais de lien pendant, pas de faux « recâblé »).
                        linksLost++;
                        clearLinkRefs(owner, lid, newNode);
                        removeGraphLink(owner, lid);
                    }
                } catch { linksLost++; clearLinkRefs(owner, lid, newNode); removeGraphLink(owner, lid); }
            }
            try { oldOut.links = []; } catch { /* ignore */ }
        }

        // 6) Remplacement EN PLACE dans le graphe propriétaire (identité conservée).
        const nodesArr = Array.isArray(owner.nodes) ? owner.nodes : (Array.isArray(owner._nodes) ? owner._nodes : null);
        if (!nodesArr) return changeFail("liste de nœuds du graphe introuvable");
        const idx = nodesArr.indexOf(oldNode);
        if (idx < 0) return changeFail("nœud absent de la liste du graphe");
        try { nodesArr[idx] = newNode; } catch (e) { return changeFail((e && e.message) || String(e)); }
        try { if (owner._nodes_by_id && typeof owner._nodes_by_id === "object") owner._nodes_by_id[newNode.id] = newNode; } catch { /* ignore */ }
        try { newNode.graph = owner; } catch { /* ignore */ }
        // Vue réactive (le remplacement contourne graph.add) + ordre d'exécution
        // + hook de retrait de l'ancien nœud (nettoyage custom).
        try { if (typeof owner.onNodeAdded === "function") owner.onNodeAdded(newNode); } catch { /* ignore */ }
        try { if (typeof owner.updateExecutionOrder === "function") owner.updateExecutionOrder(); } catch { /* ignore */ }
        try { if (typeof owner.change === "function") owner.change(); } catch { /* ignore */ }
        try { if (typeof oldNode.onRemoved === "function") oldNode.onRemoved(); } catch { /* ignore */ }
        dirtyCanvas(ctx);

        // Message NON ALARMANT pour Blobby/l'utilisateur : distinguer explicitement
        // les connexions CONSERVÉES des liens sans équivalent DÉTACHÉS proprement,
        // pour ne pas présenter un détachement légitime comme « les connexions
        // sont cassées ». `notice` est le champ lu par le LLM (renderToolContent).
        const notice = linksLost > 0
            ? label(ctx, "bl.toolRes.changeNodeTypeKeptLost", { kept: String(reconnected), lost: String(linksLost) },
                "{kept} connexion(s) conservée(s) ; {lost} détachée(s) proprement (aucun slot équivalent dans la nouvelle classe — normal lors d'un changement de classe)")
            : label(ctx, "bl.toolRes.changeNodeTypeAllKept", { kept: String(reconnected) },
                "{kept} connexion(s) conservée(s) (tous les slots ont un équivalent dans la nouvelle classe)");

        return {
            data: {
                node: newNode.id,
                previous_type: oldType || null,
                type: newType,
                noop: false, changed: true,
                notice: notice,
                kept: {
                    pos: keptPos, size: keptSize,
                    title: customTitle,
                    color: oldNode.color !== undefined ? oldNode.color : null,
                    bgcolor: oldNode.bgcolor !== undefined ? oldNode.bgcolor : null,
                    mode: oldNode.mode, mode_name: nodeModeName(oldNode.mode),
                },
                widgets_copied: widgetsCopied,
                lost_widgets: lostWidgets,
                new_widgets: newOnlyWidgets,
                links_reconnected: reconnected,
                links_lost: linksLost,
                lost_inputs: lostInputs,
                lost_outputs: lostOutputs,
                subgraph: subgraphScopeInfo(r.subgraph),
            },
            action: label(ctx, "bl.toolAct.changeNodeType", { name: nodeTitle(oldNode), from: oldType || "?", to: newType }, "🔁 {name} : {from} → {to}"),
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

registerTool({
    name: "create_group",
    description: "Crée un groupe (cadre) dans le graphe : titre, couleur, position et taille. Un groupe organise et repère visuellement une zone du workflow. Mutatif (annulable). Pour créer le groupe DANS un subgraph, fournis subgraph. Pour le modifier ensuite : edit_group ; pour le cadrer : focus_view.",
    schema: {
        type: "object",
        properties: {
            title: { type: "string", description: "Titre du groupe (obligatoire)." },
            color: { type: "string", description: "Couleur du cadre, ex. '#335' ou '#FF8F00' (optionnel)." },
            x: { type: "number", description: "Position X (optionnel, défaut : centre de la vue)." },
            y: { type: "number", description: "Position Y (optionnel, défaut : centre de la vue)." },
            width: { type: "number", description: "Largeur > 0 (optionnel, défaut 140)." },
            height: { type: "number", description: "Hauteur > 0 (optionnel, défaut 80)." },
            subgraph: subgraphProp(),
        },
        required: ["title"],
    },
    mode: "active",
    undoable: true,
    async exec(args, ctx) {
        const title = String(args.title === undefined || args.title === null ? "" : args.title).trim();
        if (!title) {
            return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "title manquant" }, "arguments invalides : {detail}"), code: "invalid_args" };
        }
        let graph = getGraph(ctx);
        let scope = null;
        if (args.subgraph !== undefined && args.subgraph !== null && String(args.subgraph).trim() !== "") {
            const rs = requireReachableSubgraph(ctx, resolveSubgraphRef(ctx, args.subgraph));
            if (rs.error) return rs;
            graph = rs.subgraph;
            scope = rs.subgraph;
        }
        if (!graph) {
            return { error: label(ctx, "bl.toolErr.noApp", {}, "workflow ComfyUI indisponible (app/graph introuvable)"), code: "no_app" };
        }
        let color;
        if (args.color !== undefined && args.color !== null) {
            color = String(args.color).trim();
            if (!COLOR_RE.test(color)) {
                return { error: label(ctx, "bl.toolErr.invalidValue", { detail: "couleur '" + color + "' (attendu #RGB/#RRGGBB)" }, "valeur invalide : {detail}"), code: "invalid_value" };
            }
        }
        const groupFail = (detail) => ({
            error: label(ctx, "bl.toolErr.groupCreateFailed", { error: detail }, "création du groupe impossible : {error}"),
            code: "group_create_failed",
        });
        const group = buildGroup(ctx, graph, title);
        if (!group) return groupFail("API LGraphGroup indisponible");
        try {
            group.title = title;
            if (color !== undefined) group.color = color;
        } catch (e) {
            return groupFail((e && e.message) || String(e));
        }
        let x = Number(args.x);
        let y = Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            const c = viewportCenter(ctx);
            if (!Number.isFinite(x)) x = c[0] - 70;
            if (!Number.isFinite(y)) y = c[1] - 40;
        }
        const wRaw = Number(args.width);
        const hRaw = Number(args.height);
        const w = Number.isFinite(wRaw) && wRaw > 0 ? wRaw : 140;
        const h = Number.isFinite(hRaw) && hRaw > 0 ? hRaw : 80;
        try {
            group.pos = [x, y];
            group.size = [w, h];
        } catch (e) {
            return groupFail((e && e.message) || String(e));
        }
        if (!addGroupToGraph(graph, group)) return groupFail("ajout au graphe impossible (graph.add/groups)");
        try { if (typeof group.recomputeInsideNodes === "function") group.recomputeInsideNodes(); } catch { /* best-effort */ }
        dirtyCanvas(ctx);
        const size = numberPair(group.size) || [w, h];
        return {
            data: {
                id: group.id, title: group.title, color: group.color || null,
                pos: [x, y], size: size,
                node_count: recomputeGroupNodes(group).length,
                subgraph: subgraphScopeInfo(scope),
            },
            action: label(ctx, "bl.toolAct.createGroup", { title: String(group.title || title) }, "🆕 Groupe « {title} » créé"),
        };
    },
});

registerTool({
    name: "edit_group",
    description: "Modifie un groupe existant : titre, couleur, position (x+y ensemble), taille (width+height ensemble). Mutatif (annulable). Cible le groupe par son titre ou son id (vu dans list_groups) ; pour un groupe d'un subgraph, fournis subgraph. La position déplace le cadre ; la taille minimum du groupe est appliquée par LiteGraph.",
    schema: {
        type: "object",
        properties: {
            group: { type: ["string", "number"], description: "Titre ou id du groupe à modifier (obligatoire)." },
            title: { type: "string", description: "Nouveau titre (optionnel)." },
            color: { type: "string", description: "Nouvelle couleur, ex. '#335' (optionnel)." },
            x: { type: "number", description: "Position X (avec y)." },
            y: { type: "number", description: "Position Y (avec x)." },
            width: { type: "number", description: "Largeur > 0 (avec height)." },
            height: { type: "number", description: "Hauteur > 0 (avec width)." },
            subgraph: subgraphProp(),
        },
        required: ["group"],
    },
    mode: "active",
    undoable: true,
    async exec(args, ctx) {
        let graph = getGraph(ctx);
        let scope = null;
        if (args.subgraph !== undefined && args.subgraph !== null && String(args.subgraph).trim() !== "") {
            const rs = requireReachableSubgraph(ctx, resolveSubgraphRef(ctx, args.subgraph));
            if (rs.error) return rs;
            graph = rs.subgraph;
            scope = rs.subgraph;
        }
        if (!graph) {
            return { error: label(ctx, "bl.toolErr.noApp", {}, "workflow ComfyUI indisponible (app/graph introuvable)"), code: "no_app" };
        }
        const group = findGroup(graph, args.group);
        if (!group) {
            return { error: label(ctx, "bl.toolErr.groupNotFound", { ref: String(args.group) }, "groupe '{ref}' introuvable (utilise list_groups)"), code: "group_not_found" };
        }
        const previous = {
            title: group.title,
            color: group.color || null,
            pos: numberPair(group.pos),
            size: numberPair(group.size),
        };
        let changed = false;
        if (args.title !== undefined && args.title !== null) {
            try { group.title = String(args.title); changed = true; } catch (e) { return { error: label(ctx, "bl.toolErr.exec", { error: (e && e.message) || String(e) }, "échec de l'outil : {error}"), code: "exec_error" }; }
        }
        if (args.color !== undefined && args.color !== null) {
            const color = String(args.color).trim();
            if (!COLOR_RE.test(color)) {
                return { error: label(ctx, "bl.toolErr.invalidValue", { detail: "couleur '" + color + "' (attendu #RGB/#RRGGBB)" }, "valeur invalide : {detail}"), code: "invalid_value" };
            }
            try { group.color = color; changed = true; } catch (e) { return { error: label(ctx, "bl.toolErr.exec", { error: (e && e.message) || String(e) }, "échec de l'outil : {error}"), code: "exec_error" }; }
        }
        const hasX = args.x !== undefined && args.x !== null;
        const hasY = args.y !== undefined && args.y !== null;
        if (hasX || hasY) {
            const x = Number(args.x), y = Number(args.y);
            if (!hasX || !hasY || !Number.isFinite(x) || !Number.isFinite(y)) {
                return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "x et y doivent être fournis ENSEMBLE (nombres)" }, "arguments invalides : {detail}"), code: "invalid_args" };
            }
            try { group.pos = [x, y]; changed = true; } catch (e) { return { error: label(ctx, "bl.toolErr.exec", { error: (e && e.message) || String(e) }, "échec de l'outil : {error}"), code: "exec_error" }; }
        }
        const hasW = args.width !== undefined && args.width !== null;
        const hasH = args.height !== undefined && args.height !== null;
        if (hasW || hasH) {
            const w = Number(args.width), h = Number(args.height);
            if (!hasW || !hasH || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
                return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "width et height doivent être fournis ENSEMBLE (nombres > 0)" }, "arguments invalides : {detail}"), code: "invalid_args" };
            }
            try { group.size = [w, h]; changed = true; } catch (e) { return { error: label(ctx, "bl.toolErr.exec", { error: (e && e.message) || String(e) }, "échec de l'outil : {error}"), code: "exec_error" }; }
        }
        if (!changed) {
            return { error: label(ctx, "bl.toolErr.invalidArgs", { detail: "aucun champ à modifier (title, color, x+y, width+height)" }, "arguments invalides : {detail}"), code: "invalid_args" };
        }
        try { if (typeof group.recomputeInsideNodes === "function") group.recomputeInsideNodes(); } catch { /* best-effort */ }
        try { if (typeof graph.change === "function") graph.change(); } catch { /* best-effort */ }
        dirtyCanvas(ctx);
        const pos = numberPair(group.pos);
        const size = numberPair(group.size);
        return {
            data: {
                id: group.id, title: group.title, color: group.color || null,
                pos: pos, size: size, previous: previous,
                node_count: recomputeGroupNodes(group).length,
                subgraph: subgraphScopeInfo(scope),
            },
            action: label(ctx, "bl.toolAct.editGroup", { title: String(group.title || "") }, "🖊️ Groupe « {title} » modifié"),
        };
    },
});

registerTool({
    name: "create_subgraph",
    description: "Crée un NOUVEAU subgraph (blueprint) VIDE et l'instancie dans le workflow (nœud Subgraph). Mutatif (annulable). Remplis-le ensuite avec add_node / set_widget_value / connect_nodes (paramètre subgraph='<UUID ou nom>'), ou convertis des nœuds existants avec convert_to_subgraph. Ouvre-le pour le voir avec open_subgraph.",
    schema: {
        type: "object",
        properties: {
            name: { type: "string", description: "Nom du subgraph (optionnel, défaut « Nouveau subgraph »)." },
            x: { type: "number", description: "Position X du nœud Subgraph (optionnel, défaut : centre de la vue)." },
            y: { type: "number", description: "Position Y du nœud Subgraph (optionnel, défaut : centre de la vue)." },
        },
        required: [],
    },
    mode: "active",
    undoable: true,
    async exec(args, ctx) {
        const root = getGraph(ctx);
        if (!root) {
            return { error: label(ctx, "bl.toolErr.noApp", {}, "workflow ComfyUI indisponible (app/graph introuvable)"), code: "no_app" };
        }
        const fail = (detail) => ({
            error: label(ctx, "bl.toolErr.subgraphCreateFailed", { error: detail }, "création du subgraph impossible : {error}"),
            code: "subgraph_create_failed",
        });
        if (typeof root.createSubgraph !== "function") return fail("API createSubgraph indisponible");
        const name = (args.name !== undefined && args.name !== null && String(args.name).trim() !== "")
            ? String(args.name).trim()
            : label(ctx, "bl.subgraph.defaultName", {}, "Nouveau subgraph");
        const id = generateUuid();
        const data = emptySubgraphData(id, name);
        let sg = null;
        try { sg = root.createSubgraph(data); } catch (e) { return fail((e && e.message) || String(e)); }
        if (!sg) return fail("createSubgraph n'a rien retourné");
        // Comme convertToSubgraph : configure la définition (nœuds/liens)
        // APRÈS l'enregistrement du type par l'événement 'subgraph-created'.
        try { if (typeof sg.configure === "function") sg.configure(data); } catch { /* best-effort */ }
        let node = null;
        try { if (ctx && typeof ctx.createSubgraphNodeImpl === "function") node = ctx.createSubgraphNodeImpl(sg, ctx); } catch { node = null; }
        if (!node) {
            const LG = (typeof window !== "undefined" && window.LiteGraph) || (typeof globalThis !== "undefined" && globalThis.LiteGraph) || null;
            try { if (LG && typeof LG.createNode === "function") node = LG.createNode(sg.id, sg.name); } catch { node = null; }
        }
        if (!node) return fail("instanciation impossible (LiteGraph.createNode indisponible)");
        try { if (!node.subgraph) node.subgraph = sg; } catch { /* best-effort */ }
        let x = Number(args.x);
        let y = Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            const c = viewportCenter(ctx);
            if (!Number.isFinite(x)) x = c[0] - 100;
            if (!Number.isFinite(y)) y = c[1] - 50;
        }
        try { node.pos = [x, y]; } catch { /* pos immuable ? tant pis */ }
        let added = false;
        try { if (typeof root.add === "function") { root.add(node); added = true; } } catch { /* forme inattendue */ }
        if (!added && Array.isArray(root.nodes)) {
            try { root.nodes.push(node); if (!node.graph) node.graph = root; added = true; } catch { /* ignore */ }
        }
        if (!added) return fail("ajout du nœud Subgraph au graphe impossible");
        dirtyCanvas(ctx);
        return {
            data: {
                id: sg.id, name: sg.name || name, node_id: node.id,
                node_count: 0,
            },
            action: label(ctx, "bl.toolAct.createSubgraph", { name: String(sg.name || name) }, "🧩 Subgraph « {name} » créé"),
        };
    },
});

registerTool({
    name: "convert_to_subgraph",
    description: "Convertit des nœuds EXISTANTS en un subgraph : fournis nodes ([ids]) ou group (titre/id d'un groupe entier). Les nœuds sont déplacés DANS une nouvelle définition de subgraph et remplacés par un nœud Subgraph au même endroit (liens internes/entrants/sortants réécrits par ComfyUI). Mutatif (annulable). Inverse : unpack_subgraph.",
    schema: {
        type: "object",
        properties: {
            nodes: { type: "array", items: { type: ["number", "string"] }, description: "Ids des nœuds à convertir (alternative à group)." },
            group: { type: ["string", "number"], description: "Titre ou id d'un groupe : convertit TOUS ses nœuds (alternative à nodes)." },
            name: { type: "string", description: "Nom du subgraph créé (optionnel)." },
            subgraph: subgraphProp(),
        },
        required: [],
    },
    mode: "active",
    undoable: true,
    async exec(args, ctx) {
        const rt = resolveNodeTargets(ctx, args);
        if (rt.error) return rt;
        const fail = (detail) => ({
            error: label(ctx, "bl.toolErr.subgraphConvertFailed", { error: detail }, "conversion en subgraph impossible : {error}"),
            code: "subgraph_convert_failed",
        });
        if (!rt.nodes.length) {
            if (rt.group) return { error: label(ctx, "bl.toolErr.groupEmpty", { ref: String(rt.group.title || args.group) }, "groupe '{ref}' sans nœud à modifier"), code: "group_empty" };
            return { error: label(ctx, "bl.toolErr.nothingToConvert", {}, "aucun nœud à convertir en subgraph"), code: "invalid_args" };
        }
        const owner = rt.graph;
        if (!owner || typeof owner.convertToSubgraph !== "function") {
            return fail("API convertToSubgraph indisponible (cible des nœuds d'un même graphe)");
        }
        let res = null;
        try { res = owner.convertToSubgraph(new Set(rt.nodes)); } catch (e) { return fail((e && e.message) || String(e)); }
        if (!res || !res.subgraph) return fail("convertToSubgraph n'a rien retourné");
        const name = (args.name !== undefined && args.name !== null && String(args.name).trim() !== "") ? String(args.name).trim() : null;
        if (name) {
            try { res.subgraph.name = name; } catch { /* best-effort */ }
            try { if (res.node) res.node.title = name; } catch { /* best-effort */ }
        }
        dirtyCanvas(ctx);
        return {
            data: {
                id: res.subgraph.id, name: res.subgraph.name || null,
                node_id: res.node && res.node.id !== undefined ? res.node.id : null,
                node_count: rt.nodes.length,
            },
            action: label(ctx, "bl.toolAct.convertSubgraph", { count: String(rt.nodes.length), name: String(res.subgraph.name || res.subgraph.id) }, "🧩 {count} nœud(s) → Subgraph « {name} »"),
        };
    },
});

registerTool({
    name: "unpack_subgraph",
    description: "Dépaquette un subgraph : le nœud Subgraph ciblé (id) est remplacé par le contenu de sa définition — ses nœuds internes remontent dans le graphe parent. Mutatif (annulable). Inverse de convert_to_subgraph. Le nœud peut être dans le graphe racine ou dans un subgraph (fournis subgraph).",
    schema: {
        type: "object",
        properties: {
            id: { type: ["number", "string"], description: "Id du nœud Subgraph à dépaquetter (vu dans list_nodes / list_subgraphs)." },
            subgraph: subgraphProp(),
        },
        required: ["id"],
    },
    mode: "active",
    undoable: true,
    async exec(args, ctx) {
        const scopeArgs = (args.subgraph !== undefined && args.subgraph !== null && String(args.subgraph).trim() !== "") ? { subgraph: args.subgraph } : {};
        const r = findNode(ctx, args.id, scopeArgs);
        if (r.error) return r;
        const fail = (detail) => ({
            error: label(ctx, "bl.toolErr.subgraphUnpackFailed", { error: detail }, "dépaquetage du subgraph impossible : {error}"),
            code: "subgraph_unpack_failed",
        });
        const node = r.node;
        const sg = subgraphIdOf(node);
        if (!sg) {
            return { error: label(ctx, "bl.toolErr.notSubgraphNode", { id: String(node.id) }, "le nœud #{id} n'est pas un nœud de subgraph (utilise list_subgraphs)"), code: "not_subgraph" };
        }
        const owner = node.graph || r.subgraph || getGraph(ctx);
        if (!owner || typeof owner.unpackSubgraph !== "function") return fail("API unpackSubgraph indisponible");
        const beforeIds = (Array.isArray(owner.nodes) ? owner.nodes : []).map((n) => String(n.id));
        try { owner.unpackSubgraph(node, { skipMissingNodes: true }); } catch (e) { return fail((e && e.message) || String(e)); }
        const after = Array.isArray(owner.nodes) ? owner.nodes : [];
        const added = after.map((n) => n.id).filter((id) => beforeIds.indexOf(String(id)) < 0);
        dirtyCanvas(ctx);
        return {
            data: {
                unpacked: node.id,
                subgraph: { id: sg.id, name: sg.name || null },
                added_node_ids: added,
                added_count: added.length,
            },
            action: label(ctx, "bl.toolAct.unpackSubgraph", { name: String(sg.name || sg.id), count: String(added.length) }, "🧩 Subgraph « {name} » dépaqueté ({count} nœuds)"),
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
 * PAS la détection. Appelé par le chat UNIQUEMENT au 1ᵉʳ tour (les DEUX modes :
 * read et active), pour replier vers le chemin texte si le modèle ignore tools.
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