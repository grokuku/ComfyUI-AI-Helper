/**
 * AIH Model Workflow — extraction des modèles référencés par le workflow
 * ComfyUI courant + filtrage des listes du Model Browser.
 *
 * Module PUR : aucune dépendance DOM / réseau / i18n → importable et testable
 * avec `node` seul (js/test_aih_model_workflow.mjs). Le Model Browser
 * (02_aih_model_browser.js) l'importe et lui fournit soit l'application ComfyUI
 * (`window.app` / `window.comfyAPI.app.app`), soit un graphe, soit un workflow
 * sérialisé (`graph.serialize()`).
 *
 * ─── Mécanisme d'extraction (et limites) ────────────────────────────────────
 * On parcourt TOUS les nœuds (y compris les sous-graphes) et on collecte les
 * valeurs de widgets qui sont des NOMS DE MODÈLES. Deux signaux, dans l'ordre :
 *   1. la valeur se termine par une extension de fichier modèle connue
 *      (.safetensors, .ckpt, .gguf, …) — signal FORT, indépendant du nœud ;
 *   2. le NOM du widget évoque un chargeur de modèle (ckpt_name, lora_name,
 *      control_net_name, …) — signal SECONDAIRE pour les valeurs sans extension.
 *
 * Limites assumées (documentées, testées) :
 *   - un workflow SÉRIALISÉ (sans nœuds vivants) ne porte pas les NOMS de
 *     widgets (`widgets_values` est une liste nue) → seul le signal « extension »
 *     s'applique. Le chemin nominal passe par les nœuds vivants (node.widgets).
 *   - les valeurs DYNAMIQUES / expressions non résolues au moment de l'appel
 *     (nœuds non exécutés, valeurs calculées par un script) ne sont pas vues.
 *   - les embeddings référencés dans le texte d'un prompt (« embedding:xxx »)
 *     ne sont PAS extraits (ce ne sont pas des fichiers modèles).
 *   - le matching se fait sur le BASENAME (sans dossier), insensible à la casse :
 *     deux fichiers de même nom dans des dossiers différents sont indistinguables.
 */

// ─── Extensions de fichiers modèles connues ─────────────────────────────────
// (Miroir volontairement réduit de MODEL_EXTENSIONS d'aih_workflow_share.js :
// ici on ne fait que DÉTECTER qu'une valeur ressemble à un fichier modèle.)
export const MODEL_FILE_EXTENSIONS = [
    ".safetensors", ".ckpt", ".pt", ".pth", ".gguf", ".bin",
    ".t5", ".fp16", ".fp8", ".bf16", ".onnx", ".ggml", ".sft",
];

// ─── Noms de widgets porteurs d'un nom de modèle (signal secondaire) ────────
// Un widget est considéré « modèle » s'il contient « name » ET un mot-clé de
// catégorie. Ex. : ckpt_name, unet_name, vae_name, lora_name, lora_name_1,
// clip_name1, clip_vision_name, control_net_name, style_model_name,
// hypernetwork_name, gligen_name, upscale_model_name, text_encoder_name,
// diffusion_model_name, model_name…
const MODEL_WIDGET_RE =
    /(ckpt|checkpoint|unet|vae|lora|control[_-]?net|clip[_-]?vision|clip|style[_-]?model|hypernetwork|gligen|upscale|diffusion[_-]?model|text[_-]?encoder|embedding|model)/;

/**
 * Le nom de widget désigne-t-il un chargeur de modèle ?
 * @param {string} name
 * @returns {boolean}
 */
export function isModelWidgetName(name) {
    if (typeof name !== "string" || !name) return false;
    const n = name.toLowerCase();
    if (n.indexOf("name") < 0) return false;
    return MODEL_WIDGET_RE.test(n);
}

/**
 * La valeur ressemble-t-elle à un nom de fichier modèle (par son extension) ?
 * @param {string} value
 * @returns {boolean}
 */
export function looksLikeModelFile(value) {
    if (typeof value !== "string") return false;
    const v = value.trim().toLowerCase();
    if (v.length < 4) return false;
    for (let i = 0; i < MODEL_FILE_EXTENSIONS.length; i++) {
        if (v.endsWith(MODEL_FILE_EXTENSIONS[i])) return true;
    }
    return false;
}

/**
 * Normalise un nom de modèle pour comparaison : chemin → basename, minuscules.
 * « checkpoints/SDXL/foo.SafeTensors » → « foo.safetensors ».
 * @param {string} value
 * @returns {string}
 */
export function normalizeModelName(value) {
    if (typeof value !== "string") return "";
    let v = value.trim().replace(/\\/g, "/");
    while (v.startsWith("./")) v = v.slice(2);
    const idx = v.lastIndexOf("/");
    return (idx >= 0 ? v.slice(idx + 1) : v).toLowerCase();
}

// Valeurs sentinelles à ignorer (widgets non renseignés).
const _SENTINELS = { "none": 1, "undefined": 1, "null": 1 };

/**
 * Collecte les noms de modèles référencés par le workflow courant.
 *
 * @param {object} source  Une application ComfyUI ({graph}), un graphe
 *                         ({nodes}), ou un workflow sérialisé ({nodes,
 *                         definitions.subgraphs}). `null`/invalide → [].
 * @returns {string[]}     Noms ORIGINAUX (dédoublonnés par basename), dans
 *                         l'ordre de rencontre.
 */
export function collectWorkflowModelNames(source) {
    const found = new Map(); // basename normalisé → nom original
    const visited = new Set(); // anti-cycle (graphes/sous-graphes)

    function addValue(widgetName, value) {
        if (typeof value === "string") {
            const v = value.trim();
            if (!v || v.toLowerCase() in _SENTINELS) return;
            if (looksLikeModelFile(v) || isModelWidgetName(widgetName)) {
                const key = normalizeModelName(v);
                if (key && !found.has(key)) found.set(key, v);
            }
        } else if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i++) addValue(widgetName, value[i]);
        }
    }

    function visitNode(node) {
        if (!node || typeof node !== "object") return;
        if (visited.has(node)) return;
        visited.add(node);

        // Nœuds vivants LiteGraph : node.widgets = [{ name, value }]
        if (Array.isArray(node.widgets)) {
            for (let i = 0; i < node.widgets.length; i++) {
                const w = node.widgets[i];
                if (w && typeof w === "object") addValue(w.name, w.value);
            }
        }
        // Nœuds sérialisés : node.widgets_values = [valeurs nues]
        if (Array.isArray(node.widgets_values)) {
            for (let i = 0; i < node.widgets_values.length; i++) {
                addValue("", node.widgets_values[i]);
            }
        }
        // Sous-graphes : propriétés connues selon la version du frontend.
        visitGraph(node.subgraph);
        visitGraph(node._subgraph);
        visitGraph(node.graph);
        visitGraph(node._graph);
    }

    function visitGraph(graph) {
        if (!graph || typeof graph !== "object") return;
        if (visited.has(graph)) return;
        visited.add(graph);
        if (Array.isArray(graph.nodes)) {
            for (let i = 0; i < graph.nodes.length; i++) visitNode(graph.nodes[i]);
        }
        if (Array.isArray(graph.subgraphs)) {
            for (let i = 0; i < graph.subgraphs.length; i++) visitGraph(graph.subgraphs[i]);
        }
    }

    function visitSerialized(wf) {
        if (!wf || typeof wf !== "object") return;
        if (visited.has(wf)) return;
        visited.add(wf);
        if (Array.isArray(wf.nodes)) {
            for (let i = 0; i < wf.nodes.length; i++) visitNode(wf.nodes[i]);
        }
        const subs =
            (wf.definitions && wf.definitions.subgraphs) || wf.subgraphs;
        if (Array.isArray(subs)) {
            for (let i = 0; i < subs.length; i++) visitSerialized(subs[i]);
        }
    }

    if (!source || typeof source !== "object") return [];

    if (source.graph && typeof source.graph === "object") {
        // Chemin nominal : application ComfyUI vivante.
        visitGraph(source.graph);
        if (found.size === 0 && typeof source.graph.serialize === "function") {
            // Repli : graphe vivant sans widgets exploitables → sérialisation.
            try { visitSerialized(source.graph.serialize()); } catch (e) { /* ignore */ }
        }
    } else if (Array.isArray(source.nodes) ||
               (source.definitions && Array.isArray(source.definitions.subgraphs))) {
        visitSerialized(source);
    } else if (Array.isArray(source)) {
        for (let i = 0; i < source.length; i++) visitNode(source[i]);
    }

    return Array.from(found.values());
}

/**
 * Construit l'index de correspondance (basenames normalisés) des modèles du
 * workflow.
 * @param {string[]} names
 * @returns {Set<string>}
 */
export function buildWorkflowNameIndex(names) {
    const set = new Set();
    if (Array.isArray(names)) {
        for (let i = 0; i < names.length; i++) {
            const key = normalizeModelName(names[i]);
            if (key) set.add(key);
        }
    }
    return set;
}

/**
 * L'item (local ou distant) correspond-il à un modèle du workflow ?
 * Compare les basenames des champs nom/chemin de l'item.
 * @param {object} item
 * @param {Set<string>} index  Index non vide. Vide → false (aucun match).
 * @returns {boolean}
 */
export function isModelInWorkflow(item, index) {
    if (!item || !index || index.size === 0) return false;
    const candidates = [
        item.name, item.filename, item.original_name,
        item.path, item.filepath,
    ];
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (typeof c !== "string" || !c) continue;
        const key = normalizeModelName(c);
        if (key && index.has(key)) return true;
    }
    return false;
}

/**
 * Filtre une liste d'items sur les modèles du workflow.
 * @param {object[]} items
 * @param {Set<string>|null} workflowIndex  null → liste inchangée (copie).
 *                                          Set (même vide) → filtre strict.
 * @returns {object[]}
 */
export function filterModelsByWorkflow(items, workflowIndex) {
    if (!Array.isArray(items)) return [];
    if (!workflowIndex) return items.slice();
    return items.filter((it) => isModelInWorkflow(it, workflowIndex));
}

/**
 * Filtre GÉNÉRIQUE des items du Model Browser : types + recherche + workflow.
 * Cumul des trois filtres (les critères s'additionnent).
 * @param {object[]} items
 * @param {object} [opts]
 * @param {string[]|null} [opts.types]         Types actifs (null/[] = tous).
 * @param {string|null}   [opts.search]        Sous-chaîne nom (insensible casse).
 * @param {Set<string>|null} [opts.workflowIndex]
 * @param {function} [opts.getType]            item → type ; défaut item.type.
 * @returns {object[]}
 */
export function filterModelItems(items, opts) {
    opts = opts || {};
    const types = opts.types;
    const search = opts.search;
    const workflowIndex = opts.workflowIndex;
    const getType = typeof opts.getType === "function"
        ? opts.getType
        : function (i) { return (i && (i._overrideType || i.type)) || "model"; };

    let result = Array.isArray(items) ? items.slice() : [];
    if (types && types.length) {
        result = result.filter((i) => types.indexOf(getType(i)) >= 0);
    }
    if (search) {
        const q = search.toLowerCase();
        result = result.filter((i) => {
            const name = (i && (i.name || i.filename || "")) + "";
            return name.toLowerCase().indexOf(q) >= 0;
        });
    }
    if (workflowIndex) {
        result = result.filter((i) => isModelInWorkflow(i, workflowIndex));
    }
    return result;
}

/**
 * Compte, parmi les items, combien de basenames normalisés appartiennent à
 * l'index du workflow (pour le récapitulatif « présent local / distant »).
 * @param {object[]} items
 * @param {Set<string>} index
 * @returns {number}
 */
export function countWorkflowMatches(items, index) {
    if (!Array.isArray(items) || !index || index.size === 0) return 0;
    const hit = new Set();
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it) continue;
        const candidates = [it.name, it.filename, it.original_name, it.path, it.filepath];
        for (let c = 0; c < candidates.length; c++) {
            const v = candidates[c];
            if (typeof v !== "string" || !v) continue;
            const key = normalizeModelName(v);
            if (key && index.has(key)) { hit.add(key); break; }
        }
    }
    return hit.size;
}
