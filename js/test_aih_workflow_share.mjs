// ─────────────────────────────────────────────────────────────────────────
// RÉGRESSION — « Le Workflow Sharing ne se lance pas ».
//
// Bug historique (commit 02e1252, corrigé ici) : js/aih_workflow_share.js
// contenait une accolade manquante (le `else` de _wfOpenDetail remplacé par
// `})` + un `.catch` dupliqué). Le fichier ne PARSAIT PLUS comme module ES
// (« SyntaxError: Unexpected token ')' »), donc ComfyUI ne définissait jamais
// window.openWorkflowManager et le menu « 📤 Workflows » affichait
// « Workflow Sharing pas encore chargé. Réessaie. » — la modale ne s'ouvrait
// jamais.
//
// Ce test :
//   1. importe le module RÉEL : un SyntaxError fait ÉCHOUER le test (exact
//      symptôme d'origine) ;
//   2. vérifie le chemin de clic réel du menu
//      window.AIHMenu.openWorkflows() → window.openWorkflowManager() →
//      modale ouverte (onglets Partager/Parcourir + formulaire de
//      publication) ;
//   3. CONTRÔLE NÉGATIF : sans serveur configuré, la même entrée menu NE
//      DOIT PAS ouvrir de modale et DOIT afficher l'invite de configuration
//      (comportement dégradé voulu) — prouve que le test détecte bien un
//      lancement silencieusement inopérant.
//
// Usage : node js/test_aih_workflow_share.mjs
//   jsdom résolu par js/test_helpers/jsdom_loader.mjs (introuvable = SKIP
//   bruyant, exit 2 — jamais compté PASS).
//
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_aih_workflow_share");

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

// ── Stub ComfyUI minimal : un graphe sérialisable (= workflow actif) ──────
window.app = {
    graph: {
        serialize: () => ({
            nodes: [{ id: 1, type: "KSampler", widgets_values: ["model.safetensors"] }],
            links: [],
            extra: { title: "Mon workflow" },
        }),
        _nodes: [],
    },
    ui: { title: "Mon workflow" },
    workflowName: "Mon workflow",
};

const SERVER_URL = "https://aih.test";
const calledUrls = [];

function jsonResponse(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
        json: async () => data,
        text: async () => JSON.stringify(data),
    };
}

window.fetch = globalThis.fetch = async (url, init) => {
    const u = String(url);
    calledUrls.push({ url: u, method: (init && init.method) || "GET" });
    if (/\/api\/auth\/me$/.test(u)) return jsonResponse({ id: "u1", role: "user" });
    if (/\/api\/workflows\?/.test(u)) return jsonResponse({ total: 0, page: 1, limit: 20, items: [] });
    if (/\/api\/workflows$/.test(u)) return jsonResponse({ id: 1, version: 1, updated: false });
    if (/\/api\/aih\//.test(u)) return jsonResponse({}, 404); // endpoints locaux absents en test
    return jsonResponse({ error: "not found" }, 404);
};

// Locale FR figée : les assertions portent sur les clés i18n, pas sur le texte.
await import("./aih_i18n.js");
await import("./aih_strings.js");
await import("./aih_dialog.js");
await import("./aih_toast_bridge.js");
await import("./aih_menu.js");

window.AIH.I18n.setLocale("fr");

// Sonde d'alerte : openWorkflowManager passe par window.aihShowAlert.
const alerts = [];
window.aihShowAlert = (title, message) => {
    alerts.push({ title, message });
    return Promise.resolve();
};
// Les modules ES du navigateur voient window comme global ; en Node ESM la
// résolution des identifiants nus passe par globalThis : on ré-aligne les
// globaux utilisés par le module (aihOpenModalV2, aihShowAlert…).
for (const key of ["aihOpenModalV2", "aihShowAlert", "aihShowConfirm", "AIH"]) {
    if (window[key] !== undefined) globalThis[key] = window[key];
}

/* ══ 1. IMPORT DU MODULE RÉEL (le bug d'origine faisait échouer CE point) ══ */
let importError = null;
try {
    await import("./aih_workflow_share.js");
} catch (e) {
    importError = e;
}
assert.strictEqual(
    importError,
    null,
    "js/aih_workflow_share.js doit être un module ES valide (import sans SyntaxError) — " +
    "sinon window.openWorkflowManager n'existe pas et le menu « 📤 Workflows » ne lance rien" +
    (importError ? ` ; erreur observée : ${importError.name}: ${importError.message}` : "")
);
assert.strictEqual(
    typeof window.openWorkflowManager,
    "function",
    "window.openWorkflowManager est défini par le module (contrat consommé par AIHMenu.openWorkflows)"
);
assert.strictEqual(
    typeof window.AIHMenu.openWorkflows,
    "function",
    "l'entrée menu window.AIHMenu.openWorkflows est exposée"
);

const flush = () => new Promise((r) => setTimeout(r, 50));
const modalCount = () =>
    window.document.querySelectorAll(".aih-modal, [id^='aih-modal'], [data-aih-modal]").length;
const hasShareModal = () =>
    !!window.document.getElementById("wf-tab-share") && !!window.document.getElementById("wf-tab-browse");

/* ══════ 2. CONTRÔLE NÉGATIF : sans serveur configuré → pas de modale ══════ */
// Aucune clé AIH_config : getApiUrl() renvoie "" → ensureServerConfigured()
// refuse et invite à configurer le serveur (comportement dégradé voulu).
window.localStorage.removeItem("AIH_config");
alerts.length = 0;
calledUrls.length = 0;

await window.AIHMenu.openWorkflows();
await flush();

assert.strictEqual(hasShareModal(), false,
    "contrôle négatif : sans serverUrl, AUCUNE modale de partage ne doit s'ouvrir");
assert.ok(alerts.some((a) => a.title === window.AIH.I18n.t("aih.notConfiguredTitle")),
    "contrôle négatif : l'invite « serveur non configuré » est affichée (titre i18n exact)");
assert.strictEqual(calledUrls.filter((c) => /\/api\/workflows/.test(c.url)).length, 0,
    "contrôle négatif : aucune requête workflows n'est émise sans serveur configuré");

/* ═════ 3. CHEMIN RÉEL DU MENU : clic → modale de partage ouverte ════════ */
window.localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: SERVER_URL, apiKey: "k" }));
calledUrls.length = 0;

await window.AIHMenu.openWorkflows();
await flush();

assert.strictEqual(hasShareModal(), true,
    "clic menu « 📤 Workflows » : la modale s'ouvre (onglets Partager + Parcourir)");
assert.ok(window.document.getElementById("wf-publish-btn"),
    "l'onglet Partager est rendu (formulaire de publication présent)");
assert.ok(calledUrls.some((c) => c.url.startsWith(SERVER_URL + "/api/workflows?q=")),
    "le contrôle de workflow existant interroge bien le serveur configuré");
assert.ok(calledUrls.some((c) => c.url === SERVER_URL + "/api/auth/me"),
    "l'identité serveur est récupérée (comparaison propriétaire pour la mise à jour)");

console.log(
    "✅ RÉGRESSION « Workflow Sharing ne se lance pas » : module ES importable, " +
    "window.openWorkflowManager défini, clic menu → modale ouverte, " +
    "et contrôle négatif (sans serveur → invite, pas de modale) : TOUS LES TESTS PASSENT"
);
