// ─────────────────────────────────────────────────────────────────────────
// RÉGRESSION — Fenêtre « Téléchargement des dépendances » : INDICATION DE FIN.
//
// Problème utilisateur (3) : la fenêtre ne permettait pas de savoir si le
// chargement était terminé (pas de progression globale, pas d'état final).
// Correctif verrouillé ici :
//   - progression GLOBALE « N/M » visible en permanence (en-tête + barre) ;
//   - récapitulatif FINAL chiffré : X téléchargés, Y déjà présents,
//     Z non téléchargeables, W échecs ;
//   - état final explicite : titre « Téléchargement terminé », bandeau de
//     récap coloré, bouton « Fermer » — et le panneau reste ouvert (aucun
//     échec masqué, aucune fermeture surprise).
//
// Scénarios : (1) 2 téléchargés + 1 non téléchargeable ; (2) 1 échec réel
// (recap + toast, jamais masqué) ; (3) 1 déjà présent localement ; (4) sonde de
// fraîcheur de version (même build / build divergente + bandeau) ; (5) verrous
// statiques anti-régression (mutations).
//
// Usage : node js/test_aih_workflow_share_download_done.mjs
// Code de sortie : 0 = PASS, 2 = SKIP, 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_aih_workflow_share_download_done");

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

window.app = {
    graph: { serialize: () => ({ nodes: [], links: [], extra: {} }), _nodes: [] },
    ui: {},
    workflowName: "",
    loadGraphData: () => Promise.resolve(),
};

const SERVER_URL = "https://aih.test";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jsonResponse(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
        json: async () => data,
        text: async () => JSON.stringify(data),
    };
}

// ── État du faux serveur, piloté par scénario ────────────────────────────
let localModelsList = {};      // réponse /api/aih/models/list
let fingerprintSize = 0;       // taille renvoyée par /files/<id>/fingerprint
let downloadBehaviour = "ok";  // "ok" | "fail" | "cancel"
let downloadDelayMs = 0;       // ralentit le download pour annuler en cours
let probeBody = "";            // corps renvoyé pour la sonde de build (aih_build_probe)
const downloadCalls = [];
const cancelCalls = [];

window.fetch = globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("aih_build_probe")) {
        return {
            ok: true, status: 200,
            headers: { get: () => "application/javascript" },
            text: async () => probeBody,
        };
    }
    if (u.includes("/api/aih/custom-nodes")) return jsonResponse({ nodes: [] });
    if (u.includes("/api/aih/models/download/progress")) return jsonResponse({ percent: 100, speed_mbs: 12 });
    if (u.includes("/api/aih/models/download/cancel")) {
        cancelCalls.push(JSON.parse((init && init.body) || "{}"));
        return jsonResponse({ ok: true });
    }
    if (u.includes("/api/aih/models/download")) {
        downloadCalls.push(JSON.parse((init && init.body) || "{}"));
        if (downloadDelayMs) await sleep(downloadDelayMs);
        if (downloadBehaviour === "cancel") {
            return jsonResponse({ success: false, cancelled: true, error: "Téléchargement annulé" }, 400);
        }
        if (downloadBehaviour === "fail") {
            return jsonResponse({ success: false, error: "SFTP download failed: host unreachable" });
        }
        return jsonResponse({ success: true });
    }
    if (u.includes("/api/aih/models/list")) return jsonResponse(localModelsList);
    if (u.includes("/api/aih/models/fingerprint")) return jsonResponse({ head: "h", tail: "t" });
    if (/\/files\/[^/]+\/fingerprint/.test(u)) {
        return fingerprintSize > 0
            ? jsonResponse({ size: fingerprintSize, head: "h", tail: "t" })
            : jsonResponse({ error: "not found" }, 404);
    }
    if (/\/object_info\/CheckpointLoaderSimple/.test(u)) {
        return jsonResponse({ CheckpointLoaderSimple: { inputs: { required: { ckpt_name: [[]] } } } });
    }
    if (/\/object_info\/LoraLoader/.test(u)) {
        return jsonResponse({ LoraLoader: { inputs: { required: { lora_name: [[]] } } } });
    }
    if (/\/api\/workflows\/\d+\/download$/.test(u)) {
        return jsonResponse({ workflow_json: JSON.stringify({ nodes: [], links: [] }), name: "wf" });
    }
    if (/\/api\/workflows\/\d+$/.test(u)) return jsonResponse(workflow);
    if (/\/api\/workflows\?/.test(u)) return jsonResponse({ total: 0, page: 1, limit: 20, items: [] });
    return jsonResponse({ error: "not found" }, 404);
};

// ── Modules réels ────────────────────────────────────────────────────────
await import("./aih_i18n.js");
await import("./aih_strings.js");
await import("./aih_dialog.js");
await import("./aih_toast_bridge.js");
window.AIH.I18n.setLocale("fr");

window.aihShowAlert = () => Promise.resolve();
window.aihShowConfirm = () => Promise.resolve(true);
for (const key of ["aihOpenModalV2", "aihShowAlert", "aihShowConfirm", "AIH"]) {
    if (window[key] !== undefined) globalThis[key] = window[key];
}
await import("./aih_workflow_share.js");
window.localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: SERVER_URL, apiKey: "k" }));

let workflow = null;
const waitFor = async (cond, label, tries = 800) => {
    for (let i = 0; i < tries; i++) {
        if (cond()) return;
        await sleep(5);
    }
    throw new Error("waitFor timeout: " + label);
};

let n = 0;
const ok = (m) => { n++; console.log("  ✓ " + m); };
const bodyText = () => window.document.body.textContent;
const donePanel = () => window.document.querySelector('[data-state="done"]');

window.openWorkflowManager();
await waitFor(() => typeof window._wfOpenDetail === "function", "définition _wfOpenDetail");
await sleep(20);

async function openDetail(wf) {
    workflow = wf;
    downloadCalls.length = 0;
    cancelCalls.length = 0;
    downloadBehaviour = "ok";
    downloadDelayMs = 0;
    fingerprintSize = 0;
    localModelsList = {};
    window.document.body.innerHTML = "";
    window._wfOpenDetail(42);
    await waitFor(() => window.document.querySelectorAll("#wf-install-deps .wf-dep-cb").length > 0 ||
        /aucune dépendance/i.test(bodyText()), "dépendances rendues");
    await sleep(30);
}

/* ══ 1. FIN EXPLICITE — 2 téléchargés + 1 non téléchargeable ═════════════ */
console.log("1. Fin de chargement : progression N/M + récapitulatif + état « Terminé »");
{
    await openDetail({
        id: 42, name: "Krea 2", author: "moi", version: 1, likes: 0, downloads: 0,
        required_nodes: [],
        required_models: [
            { name: "a.safetensors", type: "unet", upload_id: "u-a" },
            { name: "b.safetensors", type: "vae", upload_id: "u-b" },
            { name: "c.safetensors", type: "clip" }, // sans upload_id → non téléchargeable
        ],
        required_loras: [],
    });
    window.document.getElementById("wf-load-btn").click();
    await waitFor(() => downloadCalls.length >= 2, "2 téléchargements émis");
    await waitFor(() => donePanel(), "panneau à l'état final 'done'");
    await sleep(150);

    const panel = donePanel();
    const text = panel.textContent;
    assert.ok(text.includes("Téléchargement terminé"), "titre final « Téléchargement terminé » affiché");
    assert.ok(text.includes("Progression : 3/3"),
        "progression GLOBALE terminée 3/3 (obtenu : « " + (text.match(/Progression[^·]*/) || [""])[0].trim() + " »)");
    assert.ok(/2 téléchargé\(s\) · 0 déjà présent\(s\) · 1 non téléchargeable\(s\) · 0 échec\(s\)/.test(text),
        "récapitulatif exact : 2 téléchargés, 0 déjà présents, 1 non téléchargeable, 0 échec");
    const closeBtn = Array.from(panel.querySelectorAll("button")).find((b) => /Fermer/.test(b.textContent));
    assert.ok(closeBtn, "bouton « Fermer » explicite présent");
    assert.ok(text.includes("aucune référence serveur"),
        "la raison de la non-téléchargeable reste visible (jamais masquée)");
    assert.strictEqual(window.document.querySelectorAll('[data-state="done"]').length, 1,
        "le panneau reste OUVERT après la fin (pas de fermeture surprise)");
    closeBtn.click();
    assert.ok(!donePanel(), "« Fermer » retire réellement le panneau");
    ok("progression 3/3 + récapitulatif + bouton Fermer, panneau laissé visible");
}

/* ══ 2. ÉCHEC RÉEL — recap + toast, jamais masqué ════════════════════════ */
console.log("2. Échec de téléchargement : recap « échec(s) » + toast, jamais masqué");
{
    await openDetail({
        id: 42, name: "Krea 2", author: "moi", version: 1, likes: 0, downloads: 0,
        required_nodes: [],
        required_models: [{ name: "boom.safetensors", type: "unet", upload_id: "u-boom" }],
        required_loras: [],
    });
    downloadBehaviour = "fail"; // après openDetail (qui remet l'état serveur à zéro)
    window.document.getElementById("wf-load-btn").click();
    await waitFor(() => downloadCalls.length >= 1, "téléchargement émis");
    await waitFor(() => donePanel(), "panneau à l'état final");
    await sleep(150);

    const text = donePanel().textContent;
    assert.ok(text.includes("Progression : 1/1"), "progression 1/1 malgré l'échec");
    assert.ok(/0 téléchargé\(s\) · 0 déjà présent\(s\) · 0 non téléchargeable\(s\) · 1 échec\(s\)/.test(text),
        "récap : 1 échec (obtenu : « " + text + " »)");
    assert.ok(text.includes("SFTP download failed: host unreachable"),
        "le message d'erreur réel reste visible dans la ligne");
    assert.ok(/Téléchargement terminé — .*1 échec\(s\)/.test(bodyText()),
        "toast de fin avec échec (visible même si le panneau est fermé)");
    downloadBehaviour = "ok";
    ok("échec réel → recap 1 échec + message exact + toast, jamais masqué");
}

/* ══ 3. DÉJÀ PRÉSENT — catégorie distincte dans le recap ═════════════════ */
console.log("3. Fichier déjà présent localement : compté « déjà présent(s) »");
{
    await openDetail({
        id: 42, name: "Krea 2", author: "moi", version: 1, likes: 0, downloads: 0,
        required_nodes: [],
        required_models: [{ name: "present.safetensors", type: "checkpoint", upload_id: "u-p" }],
        required_loras: [],
    });
    // Après openDetail (qui remet l'état serveur à zéro) : le fichier est présent
    // localement AVEC la même taille que la référence serveur.
    fingerprintSize = 12345;
    localModelsList = {
        checkpoints: [{ name: "present.safetensors", path: "/models/present.safetensors", size: 12345 }],
    };
    window.document.getElementById("wf-load-btn").click();
    await waitFor(() => donePanel(), "panneau à l'état final");
    await sleep(150);

    const text = donePanel().textContent;
    assert.ok(/0 téléchargé\(s\) · 1 déjà présent\(s\) · 0 non téléchargeable\(s\) · 0 échec\(s\)/.test(text),
        "récap : 1 déjà présent (obtenu : « " + text + " »)");
    assert.strictEqual(downloadCalls.length, 0, "aucun octet demandé pour un fichier déjà présent");
    ok("déjà présent → catégorie « déjà présent(s) » du récap (aucun téléchargement)");
}

/* ══ 4. ANNULATION — le bouton ✕ interrompt le transfert en cours ══ */
console.log("4. Annulation d'un téléchargement en cours (bouton ✕)");
{
    await openDetail({
        id: 42, name: "Krea 2", author: "moi", version: 1, likes: 0, downloads: 0,
        required_nodes: [],
        required_models: [{ name: "long.safetensors", type: "unet", upload_id: "u-abort" }],
        required_loras: [],
    });
    downloadDelayMs = 500;        // transfert lent : le panneau reste ouvert
    downloadBehaviour = "cancel"; // le serveur répond 400 {cancelled: true}
    window.document.getElementById("wf-load-btn").click();
    await waitFor(() => window.document.querySelector(".wf-dl-cancel"), "bouton ✕ du panneau");
    window.document.querySelector(".wf-dl-cancel").click();
    await waitFor(() => cancelCalls.length >= 1, "POST /models/download/cancel émis");
    assert.strictEqual(cancelCalls[0].upload_id, "u-abort", "upload_id transmis à l'annulation");
    await waitFor(() => donePanel(), "panneau à l'état final après annulation");
    await sleep(120);
    {
        const panel = donePanel();
        assert.ok(/annul/i.test(panel.textContent), "l'annulation reste visible dans le panneau");
        const btn = panel.querySelector(".wf-dl-cancel");
        assert.ok(!btn || btn.style.display === "none", "bouton ✕ masqué une fois la ligne réglée");
        assert.ok(/1 échec\(s\)/.test(panel.textContent),
            "une annulation est comptée comme non téléchargée (jamais un faux succès)");
    }
    downloadBehaviour = "ok";
    downloadDelayMs = 0;
    ok("✕ : annulation envoyée, ligne réglée, bouton masqué, jamais comptée comme succès");
}

/* ══ 5. VÉRIFICATION DE VERSION — sonde de fraîcheur + bandeau ═══════════ */
console.log("5. Vérification de version : même build OK, build divergente → bandeau obsolète");
{
    const MODULE_URL = "http://comfy.local/extensions/ComfyUI-AI-Helper/aih_workflow_share.js";
    assert.strictEqual(typeof window.AIH_WF_SHARE, "object", "window.AIH_WF_SHARE exposé (DevTools)");
    assert.ok(/^wf-share-/.test(window.AIH_WF_SHARE.build), "build courante exposée");

    probeBody = 'var AIH_WF_SHARE_BUILD = "' + window.AIH_WF_SHARE.build + '";';
    assert.strictEqual(await window.AIH_WF_SHARE.check(MODULE_URL), false,
        "fichier servi = même build → pas d'obsolescence");

    probeBody = 'var AIH_WF_SHARE_BUILD = "wf-share-2026-06-01-r1";';
    assert.strictEqual(await window.AIH_WF_SHARE.check(MODULE_URL), true,
        "fichier servi d'une AUTRE build → obsolète détecté");
    assert.strictEqual(window.AIH_WF_SHARE.stale, true, "drapeau stale exposé sur window.AIH_WF_SHARE");
    assert.strictEqual(window.AIH_WF_SHARE.servedBuild, "wf-share-2026-06-01-r1",
        "build réellement servie exposée (diagnostic)");

    // Le bandeau rouge est affiché à l'ouverture de la fenêtre Workflows.
    window.document.body.innerHTML = "";
    window.openWorkflowManager();
    await waitFor(() => {
        const b = window.document.querySelector("#wf-stale-banner");
        return b && b.style.display === "block" && /Version obsolète/.test(b.textContent);
    }, "bandeau « version obsolète » affiché");
    ok("même build → silencieux ; build divergente → stale + bandeau visibles (Ctrl+Shift+R)");
}

/* ══ 6. Verrous statiques + parité i18n (mutations) ══════════════════════ */
console.log("6. Verrous statiques et parité i18n");
{
    const src = readFileSync(new URL("./aih_workflow_share.js", import.meta.url), "utf8");
    const strings = readFileSync(new URL("./aih_strings.js", import.meta.url), "utf8");

    // Mutation J1 : progression globale (compteur + barre) initialisée ET mise à jour.
    assert.ok(/wf\.dlProgress/.test(src) && /function updateProgress\(\)/.test(src),
        "mutation : la progression globale doit exister et se mettre à jour");
    assert.ok(/stats\.finished\+\+/.test(src) && /globalFill\.style\.width/.test(src),
        "mutation : chaque résultat incrémente la progression et la barre globale");
    // Mutation J2 : récapitulatif construit à partir des QUATRE compteurs.
    assert.ok(/function renderSummary\(\)/.test(src), "mutation : le récapitulatif doit être rendu");
    assert.ok(/stats\.downloaded/.test(src) && /stats\.already/.test(src) &&
        /stats\.noref/.test(src) && /stats\.failed/.test(src),
        "mutation : les 4 catégories (téléchargé / déjà présent / non téléchargeable / échec) doivent exister");
    // Mutation J3 : état final explicite + bouton Fermer, posés par done().
    assert.ok(/headerTitle\.textContent = t\("wf\.dlDoneTitle"\)/.test(src),
        "mutation : done() doit basculer le titre sur « Téléchargement terminé »");
    assert.ok(/panel\.dataset\.state = "done"/.test(src),
        "mutation : done() doit marquer l'état final du panneau");
    assert.ok(/closeBtn\.textContent = t\("dialog\.close"\)/.test(src),
        "mutation : bouton « Fermer » posé par done()");
    // Mutation J4 : anti-double comptage (un résultat terminal par ligne).
    assert.ok(/r\.settled = true/.test(src) && /if \(!r \|\| r\.settled\) return/.test(src),
        "mutation : un même panneau ne doit compter qu'une seule fois par ligne");
    // Mutation J5 : les skip distinguent « déjà présent » de « non téléchargeable ».
    assert.ok(/kind === 'noref'/.test(src) && /skippedDeps\[si3\]\.kind/.test(src),
        "mutation : le kind des skips doit être transmis au panneau");

    // Parité i18n stricte FR/EN des clés de fin.
    const enIdx = strings.indexOf("const EN = {");
    const keys = ["wf.dlProgress", "wf.dlDoneTitle", "wf.dlRecap", "wf.dlRecapToast"];
    for (const key of keys) {
        const token = '"' + key + '"';
        assert.ok(strings.indexOf(token) > 0 && strings.indexOf(token) < enIdx,
            `clé ${key} absente du bloc FR`);
        assert.ok(strings.indexOf(token, enIdx) > 0,
            `clé ${key} absente du bloc EN (parité stricte FR/EN)`);
    }
    ok("verrous statiques (mutations J1-J5) + parité i18n " + keys.length + " clés");
}

console.log(`\n✅ test_aih_workflow_share_download_done : ${n} groupes PASSENT`);
process.exit(0);
