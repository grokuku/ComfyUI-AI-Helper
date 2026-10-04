// ─────────────────────────────────────────────────────────────────────────
// RÉGRESSION — « quand je partage le workflow, ça inclut les anciens packs ».
//
// Signalement utilisateur : un workflow ancien garde des RÉSIDUS de l'ancien
// pack (avant le renommage « ComfyUI-Holaf-Utilities ») :
//   * `nodes[].properties.cnr_id` / `aux_id` pointant sur l'ancien pack ;
//   * des « widgets orphelins » nommés `holaf_…` dans les DONNÉES
//     SAUVEGARDÉES : références de slot `{widget: {name: "holaf_…"}}`
//     (cf. comfyui-frontend-src/src/lib/litegraph/src/node/slotUtils.ts:50-70
//      et types/serialisation.ts:74/81), inertes à l'exécution.
//
// Bug : l'analyse de dépendances (`detectDependencies`) déclarait l'ANCIEN
// pack comme dépendance REQUISE → au partage, on pouvait re-cloner la vieille
// copie (dossier legacy qui écrasait l'UI).
//
// Correctif vérifié ici :
//   (a) plus aucune déclaration du pack obsolète comme dépendance ;
//   (b) l'anomalie est SIGNALÉE (jamais embarquée silencieusement) ;
//   (c) les VRAIES dépendances restent détectées : pack custom réel, modèles,
//       LoRAs ; les widgets ENCORE fournis par le pack courant ne sont pas
//       confondus avec des résidus.
//
// CONTRÔLES NÉGATIFS (par mutation/portée) :
//   * si le pack legacy était de nouveau déclaré → le compte de nodes ≠ 1 ROUGIT ;
//   * si une vraie dépendance disparaissait (sur-filtrage) → ROUGIT ;
//   * si le signalement disparaissait → ROUGIT.
//
// Usage : node js/test_aih_workflow_share_legacy_refs.mjs
//   jsdom résolu par js/test_helpers/jsdom_loader.mjs (introuvable = SKIP
//   bruyant, exit 2 — jamais compté PASS).
// Code de sortie : 0 = PASS, 2 = SKIP, 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_aih_workflow_share_legacy_refs");

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.CustomEvent = window.CustomEvent;
globalThis.Event = window.Event;
globalThis.ResizeObserver = window.ResizeObserver = class {
    observe() {} disconnect() {} unobserve() {}
};

// ── Workflow RÉALISTE : résidus de l'ancien pack + vraies dépendances ────
const WORKFLOW = {
    id: "root-uuid",
    version: 1,
    nodes: [
        // Node ACTUEL (fonctionne) mais portant un RÉSIDU de cnr_id (ancien pack).
        {
            id: 1, type: "AIHRemoteComparer",
            inputs: [
                { name: "in", type: "*", link: null },
                // Widget orphelin (pack historique supprimé) : inerte.
                { name: "holaf_terminal_widget", type: "*", link: null, widget: { name: "holaf_terminal_widget" } },
            ],
            outputs: [],
            properties: { "Node name for S&R": "AIHRemoteComparer", cnr_id: "comfyui-holaf-utilities" },
            widgets_values: ["Cmp", "fast"],
        },
        // Autre node : résidu de aux_id (owner/repo de l'ancien pack).
        {
            id: 2, type: "AIHRemoteComparer",
            inputs: [
                { name: "x", type: "*", link: null, widget: { name: "holaf_terminal_widget" } },
            ],
            outputs: [],
            properties: { aux_id: "grokuku/ComfyUI-Holaf-Utilities", ver: "1.0.0" },
        },
        // Widget ENCORE fourni par le pack courant : NE DOIT PAS être un résidu.
        {
            id: 3, type: "AIHImageComparer",
            inputs: [{ name: "holaf_comparer", type: "*", link: null, widget: { name: "holaf_comparer" } }],
            outputs: [],
            properties: { "Node name for S&R": "AIHImageComparer" },
        },
        // VRAIE dépendance : un pack custom réel (non legacy) doit rester.
        {
            id: 4, type: "RealPackNode", inputs: [], outputs: [],
            properties: { aux_id: "some/Real-Pack" }, widgets_values: [],
        },
        // Vrais modèles / LoRAs.
        { id: 5, type: "CheckpointLoaderSimple", inputs: [], outputs: [], widgets_values: ["modelA.safetensors"] },
        { id: 6, type: "LoraLoader", inputs: [], outputs: [], widgets_values: ["loraX.safetensors"] },
    ],
    links: [], groups: [], extra: { title: "Mon workflow" },
};

window.app = {
    graph: { serialize: () => WORKFLOW, _nodes: [] },
    ui: { title: "Mon workflow" },
    workflowName: "Mon workflow",
};

const SERVER_URL = "https://aih.test";

function jsonResponse(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
        json: async () => data,
        text: async () => JSON.stringify(data),
    };
}

window.fetch = globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/aih/custom-nodes")) return jsonResponse({ nodes: [] });
    if (u.includes("/api/aih/models/list")) return jsonResponse({});
    if (/\/api\/workflows\?/.test(u)) return jsonResponse({ total: 0, page: 1, limit: 20, items: [] });
    if (/\/api\/aih\//.test(u)) return jsonResponse({});
    return jsonResponse({ error: "not found" }, 404);
};

await import("./aih_i18n.js");
await import("./aih_strings.js");
await import("./aih_dialog.js");
await import("./aih_toast_bridge.js");
await import("./aih_menu.js");

window.AIH.I18n.setLocale("fr");
window.aihShowAlert = () => Promise.resolve();
window.aihShowConfirm = () => Promise.resolve(true);
for (const key of ["aihOpenModalV2", "aihShowAlert", "aihShowConfirm", "AIH"]) {
    if (window[key] !== undefined) globalThis[key] = window[key];
}
await import("./aih_workflow_share.js");
window.localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: SERVER_URL, apiKey: "k" }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, label, tries = 600) => {
    for (let i = 0; i < tries; i++) { if (cond()) return; await sleep(5); }
    throw new Error("waitFor timeout: " + label);
};

let n = 0;
const ok = (m) => { n++; console.log("  ✓ " + m); };
const normalize = (v) => String(v == null ? "" : v).toLowerCase().replace(/^comfyui[-_]/, "").replace(/[^a-z0-9]/g, "");

/* ══ 1. detectDependencies : le pack legacy n'est PLUS déclaré ═══════════ */
console.log("1. analyse de dépendances : résidus ignorés, vraies dépendances conservées");
{
    assert.strictEqual(typeof window.AIH_WF_SHARE.detectDeps, "function",
        "detectDeps doit être exposée (analyse testable, comme check)");
    const deps = await window.AIH_WF_SHARE.detectDeps(WORKFLOW);

    // (a) Le pack obsolète n'est JAMAIS une dépendance.
    const nodeNames = deps.nodes.map((p) => p.name);
    assert.ok(!nodeNames.some((nm) => normalize(nm) === "holafutilities"),
        "le pack obsolète ComfyUI-Holaf-Utilities ne doit plus être déclaré (obtenu : " + JSON.stringify(nodeNames) + ")");

    // (c) La VRAIE dépendance custom reste déclarée (contrôle anti-sur-filtrage).
    assert.strictEqual(deps.nodes.length, 1,
        "exactement 1 pack réel attendu (obtenu : " + JSON.stringify(nodeNames) + ")");
    assert.strictEqual(deps.nodes[0].name, "Real-Pack", "le pack custom réel est conservé");
    assert.ok(/github\.com\/some\/Real-Pack/.test(deps.nodes[0].url || ""),
        "l'URL git de la vraie dépendance est résolue depuis aux_id/cnr_id");

    // Modèles / LoRAs intacts (aucun faux négatif).
    assert.deepStrictEqual(deps.models.map((m) => m.name), ["modelA.safetensors"], "le modèle réel reste détecté");
    assert.deepStrictEqual(deps.loras.map((l) => l.name), ["loraX.safetensors"], "le LoRA réel reste détecté");

    // (b) Les résidus sont SIGNALÉS (jamais embarqués silencieusement).
    const ignored = deps.ignoredLegacy || [];
    const packEntry = ignored.find((x) => x.kind === "pack");
    const widgetEntry = ignored.find((x) => x.kind === "widget" && x.name === "holaf_terminal_widget");
    assert.ok(packEntry, "le résidu de pack est signalé dans ignoredLegacy");
    assert.strictEqual(normalize(packEntry.name), "holafutilities", "le résidu signalé est bien l'ancien pack");
    assert.strictEqual(packEntry.count, 2, "2 occurrences de référence de pack (cnr_id + aux_id)");
    assert.ok(widgetEntry, "le widget orphelin holaf_terminal_widget est signalé");
    assert.strictEqual(widgetEntry.count, 2, "2 occurrences du widget orphelin (comptage exact)");

    // Le widget encore fourni par le pack courant n'est PAS un résidu.
    assert.ok(!ignored.some((x) => x.name === "holaf_comparer"),
        "holaf_comparer (widget courant) ne doit pas être signalé comme résidu");
    ok("pack legacy ignoré + signalé (2), widget orphelin signalé (2), vraie dépendance + model + lora conservés");
}

/* ══ 2. Contrôle négatif : le résidu legacy n'est pas un pack requis ═════ */
console.log("2. contrôle négatif : sans le filtre, le pack legacy serait déclaré");
{
    // Un pack IDENTIQUE mais légitime (même forme) reste déclaré : prouve que le
    // filtre cible bien les NOMS historiques et pas « tout ».
    const legit = {
        nodes: [{ id: 1, type: "SomeNode", inputs: [], outputs: [], properties: { aux_id: "owner/Holaf-Utilities-Fork" } }],
        links: [], extra: {},
    };
    const deps = await window.AIH_WF_SHARE.detectDeps(legit);
    assert.strictEqual(deps.nodes.length, 1, "un pack au nom VOISIN mais non historique reste déclaré (pas de sur-blocage)");
    assert.strictEqual((deps.ignoredLegacy || []).length, 0, "aucun résidu signalé pour un nom non historique");
    ok("nom voisin non historique conservé (filtre ciblé, pas un couperet)");
}

/* ══ 3. Rendu dans l'onglet Partager : signalement visible, legacy absent ═ */
console.log("3. onglet Partager : signalement affiché, legacy non listé comme pack");
{
    window.openWorkflowManager();
    await waitFor(() => window.document.getElementById("wf-tab-share"), "onglet partager rendu");
    window.document.getElementById("wf-tab-share").click();
    await waitFor(() => {
        const el = window.document.getElementById("wf-deps");
        return el && /Dépendances détectées|Références obsolètes/.test(el.textContent || "");
    }, "dépendances rendues");
    await sleep(30);
    const txt = (window.document.getElementById("wf-deps") || {}).textContent || "";
    assert.ok(/Références obsolètes ignorées/.test(txt),
        "le bandeau « références obsolètes ignorées » est affiché (signalement)");
    assert.ok(/Real-Pack/.test(txt), "la vraie dépendance est listée");
    assert.ok(!/grokuku/.test(txt) && !/ComfyUI-Holaf-Utilities/.test(txt),
        "l'ancien pack n'apparaît NI comme dépendance NI avec son URL (obtenu : " + txt.replace(/\s+/g, " ").slice(0, 200) + ")");
    ok("signalement visible, vrai pack listé, ancien pack absent de la liste des dépendances");
}

/* ══ 4. Verrous statiques + contrôle négatif par mutation (source) ══════ */
console.log("4. verrous statiques (mutation) + parité i18n");
{
    const src = readFileSync(new URL("./aih_workflow_share.js", import.meta.url), "utf8");
    const strings = readFileSync(new URL("./aih_strings.js", import.meta.url), "utf8");

    assert.ok(/var LEGACY_PACK_TOKENS = \["holafutilities", "holafutils", "holaf"\]/.test(src),
        "mutation : la liste des identifiants de l'ancien pack doit exister");
    assert.ok(/function isLegacyPackReference/.test(src) && /function normalizePackToken/.test(src),
        "mutation : le classifieur de pack obsolète doit exister");
    assert.ok(/isLegacyPackReference\(packId\) \|\| isLegacyPackReference\(packName\)/.test(src),
        "mutation : la détection doit tester l'ID ET le nom du pack");
    assert.ok(/ignoredLegacy\[lkey\]\.count\+\+/.test(src),
        "mutation : les occurrences du résidu doivent être COMPTÉES (une ligne par type)");
    assert.ok(/function isLegacyWidgetReference/.test(src) && /CURRENT_EXTENSION_WIDGETS/.test(src),
        "mutation : les widgets orphelins doivent être distingués des widgets courants");
    assert.ok(/deps\.ignoredLegacy = ignoredList/.test(src),
        "mutation : les résidus ignorés doivent être exposés (signalement, pas silence)");
    assert.ok(/detectDeps: detectDependencies/.test(src),
        "mutation : detectDeps doit être exposée pour la vérification");

    // Parité i18n stricte FR/EN des clés ajoutées.
    const enIdx = strings.indexOf("const EN = {");
    assert.ok(enIdx > 0, "bloc EN localisé");
    for (const key of ["wf.legacyRefsIgnored", "wf.legacyRefItem"]) {
        const token = '"' + key + '"';
        assert.ok(strings.indexOf(token) > 0 && strings.indexOf(token) < enIdx, `clé ${key} absente du bloc FR`);
        assert.ok(strings.indexOf(token, enIdx) > 0, `clé ${key} absente du bloc EN (parité stricte)`);
    }
    ok("verrous statiques (mutation) + parité i18n 2 clés");
}

console.log(`\n✅ test_aih_workflow_share_legacy_refs : ${n} groupes PASSENT`);
process.exit(0);
