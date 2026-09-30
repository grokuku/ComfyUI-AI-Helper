// ─────────────────────────────────────────────────────────────────────────
// RÉGRESSION — Panneau « Workflow » (détail/installation) : BUG A + BUG B.
//
// BUG A (capture utilisateur) : « 8 modèles/LoRAs détectés, seulement 6
// téléchargés » — les 2 manquants étaient EXACTEMENT l'unet (13,5 Go) et le
// clip (4,6 Go) : ceux dont l'upload avait échoué puis été refait. Cause
// RÉELLE : dans le clone du détail, la boucle de téléchargement faisait
//   `if (!uploadId || …) continue;`
// → toute entrée SANS `upload_id` était SAUTÉE EN SILENCE (aucune ligne, aucune
// erreur) alors que la liste l'affichait cochée. Le compteur affichait donc
// « Téléchargement de 6 model(s)... » au lieu de 8.
//   (a) « type non géré » = FAUSSE PISTE : `typeToFolder` (JS) et `type_to_cat`
//       (Python) contiennent DÉJÀ 'unet' et 'clip' (vérifié statiquement ici).
//   (b) `upload_id` manquant = VRAIE cause (reproduite ici : 6 POST download).
// Correctif : l'entrée non téléchargeable est SIGNALÉE (badge rouge dans la
// liste + ligne ⏭ du panneau + raison explicite + toast) ; le compteur reflète
// la réalité ; les 8/8 avec upload_id sont bien téléchargés au bon type.
//
// BUG B (capture utilisateur) : « les custom nodes DÉJÀ INSTALLÉS sont
// réinstallés et ça échoue ». Cause RÉELLE : la détection comparait l'URL git
// par ÉGALITÉ DE CHAÎNE EXACTE (`installedUrls[n.url]`), donc les alias du même
// dépôt (casse, `.git`, http/https, git@ vs https, préfixe ComfyUI-, dossier
// renommé) n'étaient PAS reconnus ; et la boucle d'installation installait TOUS
// les nodes cochés sans jamais consulter l'état « déjà installé » (la case
// était même TOUJOURS cochée). Résultat : POST install → 400 « Node 'X' already
// installed » → erreur brute.
// Correctif : normalisation d'URL/nom de dépôt + index partagé ; les nodes
// déjà installés sont DÉCOCHÉS et SKIPPÉS (aucune tentative) ; l'échec réel
// d'un node non détectable remonte le message serveur exact (jamais « erreur
// serveur (statut 400) » générique).
//
// Usage : node js/test_aih_workflow_share_detail_deps.mjs
//   jsdom résolu par js/test_helpers/jsdom_loader.mjs (introuvable = SKIP
//   bruyant, exit 2 — jamais compté PASS).
// Code de sortie : 0 = PASS, 2 = SKIP, 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_aih_workflow_share_detail_deps");

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
let workflow = null;           // workflow renvoyé par GET /api/workflows/<id>
let installedNodes = [];       // réponse /api/aih/custom-nodes
let installBehaviour = "ok";   // "ok" | "already" (400) | "boom" (500)
let downloadDelayMs = 0;       // ralentit les downloads pour observer le compteur
let remoteItems = [];          // réponse /api/aih/models/remote (résolution par nom)
const downloadCalls = [];
const installCalls = [];
const toastTexts = [];

const MODELS_ALL_WITH_UPLOAD = [
    { name: "Krea2-Turbo-int8-ConvRot.safetensors", type: "unet", size: 13.5e9, upload_id: "u-unet" },
    { name: "OmniSR_X2_DIV2K.safetensors", type: "upscale", size: 100e6, upload_id: "u-up2" },
    { name: "qwen_image_vae.safetensors", type: "vae", size: 200e6, upload_id: "u-vae" },
    { name: "OmniSR_X4_DIV2K.safetensors", type: "upscale", size: 100e6, upload_id: "u-up4" },
    { name: "qwen3-vl-4b-heritic_int8.safetensors", type: "clip", size: 4.6e9, upload_id: "u-clip" },
];
const LORAS = [
    { name: "lora-a.safetensors", type: "lora", size: 10e6, upload_id: "u-la" },
    { name: "lora-b.safetensors", type: "lora", size: 10e6, upload_id: "u-lb" },
    { name: "lora-c.safetensors", type: "lora", size: 10e6, upload_id: "u-lc" },
];

window.fetch = globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || "GET";

    if (u.includes("/api/aih/custom-nodes/install")) {
        const body = JSON.parse((init && init.body) || "{}");
        installCalls.push(body);
        if (installBehaviour === "already") {
            return jsonResponse({ success: false, message: `Node '${body.name}' already installed` }, 400);
        }
        if (installBehaviour === "boom") {
            return jsonResponse({ error: "git clone failed: repository not found" }, 500);
        }
        return jsonResponse({ success: true, message: `Installed ${body.name}` });
    }
    if (u.includes("/api/aih/custom-nodes")) return jsonResponse({ nodes: installedNodes });
    if (u.includes("/api/aih/models/download/progress")) {
        return jsonResponse({ percent: 100, speed_mbs: 12 });
    }
    if (u.includes("/api/aih/models/download")) {
        downloadCalls.push(JSON.parse((init && init.body) || "{}"));
        if (downloadDelayMs) await sleep(downloadDelayMs);
        return jsonResponse({ success: true });
    }
    if (u.includes("/api/aih/models/list")) return jsonResponse({});
    if (u.includes("/api/aih/models/remote")) {
        return jsonResponse({ items: remoteItems, total: remoteItems.length });
    }
    if (u.includes("/api/aih/models/fingerprint")) return jsonResponse({ head: "h", tail: "t" });
    if (/\/object_info\/CheckpointLoaderSimple/.test(u)) {
        return jsonResponse({ CheckpointLoaderSimple: { inputs: { required: { ckpt_name: [[]] } } } });
    }
    if (/\/object_info\/LoraLoader/.test(u)) {
        return jsonResponse({ LoraLoader: { inputs: { required: { lora_name: [[]] } } } });
    }
    if (/\/api\/workflows\/\d+\/download$/.test(u)) {
        return jsonResponse({ workflow_json: JSON.stringify({ nodes: [], links: [] }), name: workflow && workflow.name });
    }
    if (/\/api\/workflows\/\d+$/.test(u)) return jsonResponse(workflow);
    if (/\/api\/workflows\?/.test(u)) return jsonResponse({ total: 0, page: 1, limit: 20, items: [] });
    // /files/<id>/fingerprint (remoteGet) → 404 avalé par le code (serverFp null)
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

// Capture les messages de toast pour prouver qu'un message CLAIR est affiché.
window.AIHToast = window.AIHToast || {};
const origToastBridge = window.AIHToast;
void origToastBridge;

const waitFor = async (cond, label, tries = 600) => {
    for (let i = 0; i < tries; i++) {
        if (cond()) return;
        await sleep(5);
    }
    throw new Error("waitFor timeout: " + label);
};

let n = 0;
const ok = (m) => { n++; console.log("  ✓ " + m); };

const nodeCb = (name) => Array.from(window.document.querySelectorAll('.wf-dep-cb[data-type="node"]'))
    .find((cb) => cb.dataset.name === name);
const modelCb = (name) => Array.from(window.document.querySelectorAll('.wf-dep-cb[data-type="model"], .wf-dep-cb[data-type="lora"]'))
    .find((cb) => cb.dataset.name === name);
const loadStatus = () => (window.document.getElementById("wf-load-status") || {}).textContent || "";
const bodyText = () => window.document.body.textContent;
const baseFor = (cb) => {
    const d = cb && cb.closest ? cb.closest("div") : null;
    const b = d ? d.querySelector(".wf-dep-basepath") : null;
    return b ? b.textContent : "";
};

// openWorkflowManager définit window._wfOpenDetail (global) une seule fois.
window.openWorkflowManager();
await waitFor(() => typeof window._wfOpenDetail === "function", "définition _wfOpenDetail");
await sleep(20);

async function openDetail(wf) {
    workflow = wf;
    downloadCalls.length = 0;
    installCalls.length = 0;
    window.document.body.innerHTML = "";
    window._wfOpenDetail(42);
    await waitFor(() => window.document.querySelectorAll("#wf-install-deps .wf-dep-cb").length > 0 ||
        /aucune dépendance/i.test(bodyText()), "dépendances rendues");
    await sleep(30);
}

/* ══ 1. BUG A — 8 deps AVEC upload_id → 8/8 téléchargés, au bon type ══════ */
console.log("1. BUG A — workflow complet (unet + clip avec upload_id) : 8/8 téléchargés");
{
    installedNodes = [];
    downloadDelayMs = 250;
    await openDetail({
        id: 42, name: "Krea 2", author: "moi", version: 1, likes: 0, downloads: 0,
        required_nodes: [],
        required_models: MODELS_ALL_WITH_UPLOAD,
        required_loras: LORAS,
    });
    // les 5 modèles + 3 loras sont cochés et présents
    for (const m of MODELS_ALL_WITH_UPLOAD) {
        const cb = modelCb(m.name);
        assert.ok(cb, "le modèle " + m.name + " doit être listé");
        assert.strictEqual(cb.checked, true, m.name + " coché (non installé localement)");
        assert.strictEqual(cb.dataset.uploadId, m.upload_id, m.name + " porte son upload_id");
    }
    // LE champ « dossier de destination » doit être VISIBLE pour l'unet et le
    // clip (typeToFolder contient bien unet/clip) — c'est exactement ce que la
    // capture utilisateur ne montrait pas.
    assert.strictEqual(baseFor(modelCb("Krea2-Turbo-int8-ConvRot.safetensors")), "unet/",
        "dossier de destination « unet/ » affiché pour l'unet");
    assert.strictEqual(baseFor(modelCb("qwen3-vl-4b-heritic_int8.safetensors")), "clip/",
        "dossier de destination « clip/ » affiché pour le clip");
    assert.ok(modelCb("Krea2-Turbo-int8-ConvRot.safetensors").closest("div").querySelector(".wf-dep-path"),
        "champ de nom de fichier (dest_path) présent pour l'unet");
    window.document.getElementById("wf-load-btn").click();
    // Les 8 lignes sont listées IMMÉDIATEMENT (téléchargements + non
    // téléchargeables) — c'est le « 8/8 présents dans la liste ».
    const allNames = MODELS_ALL_WITH_UPLOAD.map((m) => m.name).concat(LORAS.map((l) => l.name));
    await waitFor(() => allNames.every((nm) => bodyText().includes(nm)),
        "8/8 lignes présentes dans le panneau de téléchargement");
    await waitFor(() => downloadCalls.length >= 8, "8 Téléchargements émis (" + downloadCalls.length + ")");
    assert.ok(/Téléchargement de 8 model\(s\)/.test(loadStatus()),
        "compteur réel : « Téléchargement de 8 model(s) » (obtenu « " + loadStatus() + " »)");
    await sleep(1600);
    downloadDelayMs = 0;

    const byType = {};
    for (const d of downloadCalls) byType[d.type] = (byType[d.type] || 0) + 1;
    assert.strictEqual(downloadCalls.length, 8, "8/8 téléchargements émis (unet + clip inclus)");
    assert.strictEqual(byType.unet, 1, "l'unet est téléchargé (type 'unet')");
    assert.strictEqual(byType.clip, 1, "le clip est téléchargé (type 'clip')");
    assert.strictEqual(byType.upscale, 2, "les 2 upscale téléchargés");
    assert.strictEqual(byType.vae, 1, "le vae téléchargé");
    assert.strictEqual(byType.lora, 3, "les 3 loras téléchargés");
    const unet = downloadCalls.find((d) => d.type === "unet");
    assert.strictEqual(unet.filename, "Krea2-Turbo-int8-ConvRot.safetensors");
    assert.strictEqual(unet.dest_path, "Krea2-Turbo-int8-ConvRot.safetensors", "nom de fichier conservé");
    ok("8/8 avec upload_id → unet + clip téléchargés, type correct, compteur = 8");
}

/* ══ 2. BUG A — unet + clip SANS upload_id → signalés (pas de skip muet) ══ */
console.log("2. BUG A — unet + clip sans upload_id : signalés clairement, jamais sautés");
{
    installedNodes = [];
    downloadDelayMs = 250;
    const modelsNoRef = MODELS_ALL_WITH_UPLOAD.map((m) =>
        (m.type === "unet" || m.type === "clip") ? { name: m.name, type: m.type, size: m.size } : m
    );
    await openDetail({
        id: 42, name: "Krea 2", author: "moi", version: 1, likes: 0, downloads: 0,
        required_nodes: [],
        required_models: modelsNoRef,
        required_loras: LORAS,
    });

    // La liste signale les 2 entrées non téléchargeables (badge rouge).
    const unetCb = modelCb("Krea2-Turbo-int8-ConvRot.safetensors");
    const clipCb = modelCb("qwen3-vl-4b-heritic_int8.safetensors");
    assert.strictEqual(unetCb.dataset.uploadId, undefined, "unet n'a pas d'upload_id (fixture)");
    assert.ok(bodyText().includes("non téléchargeable"), "la liste signale « non téléchargeable »");

    window.document.getElementById("wf-load-btn").click();
    await waitFor(() => downloadCalls.length >= 6, "6 téléchargements partis (" + downloadCalls.length + ")");
    assert.ok(/Téléchargement de 6 model\(s\)/.test(loadStatus()),
        "compteur = 6 téléchargés (obtenu « " + loadStatus() + " »)");
    assert.ok(/non téléchargé/.test(loadStatus()), "le compteur annonce aussi « non téléchargé(s) »");
    await waitFor(() => /non téléchargé|aucune référence serveur/.test(loadStatus() + bodyText()),
        "message de non-téléchargement affiché");
    await sleep(1200);
    downloadDelayMs = 0;

    assert.strictEqual(downloadCalls.length, 6, "seuls les 6 téléchargeables partent (pas de faux 8)");
    assert.ok(!downloadCalls.some((d) => d.upload_id === "u-unet" || d.type === "unet"),
        "l'unet sans upload_id n'est PAS téléchargé");
    // Raison explicite visible (ligne ⏭ du panneau + toast).
    assert.ok(bodyText().includes("upload_id manquant"),
        "la raison « upload_id manquant » est affichée (jamais un skip muet)");
    assert.ok(bodyText().includes("republiez le workflow"),
        "l'action corrective est indiquée à l'utilisateur");
    assert.ok(bodyText().includes("Krea2-Turbo-int8-ConvRot.safetensors"),
        "l'entrée non téléchargeable est NOMMÉE dans le panneau (ligne visible)");
    ok("2 entrées sans upload_id → signalées (liste + panneau + compteur), 6 téléchargés");
}

/* ══ 2bis. RÉSOLUTION PAR NOM — upload_id absent mais fichier sur le serveur ═ */
console.log("2bis. upload_id absent MAIS fichier trouvé sur le serveur → résolu et téléchargé");
{
    installedNodes = [];
    downloadDelayMs = 250;
    // Le workflow ne porte PAS l'upload_id, mais la liste distante (route
    // locale /api/aih/models/remote) contient les 2 fichiers. L'homonyme de
    // type incompatible doit être IGNORÉ (jamais un fichier d'un autre type).
    remoteItems = [
        { filename: "Krea2-Turbo-int8-ConvRot.safetensors", type: "unet", size: 13.5e9, upload_id: "u-unet-remote" },
        { filename: "qwen3-vl-4b-heritic_int8.safetensors", type: "clip", size: 4.6e9, upload_id: "u-clip-remote" },
        { filename: "Krea2-Turbo-int8-ConvRot.safetensors", type: "lora", size: 1, upload_id: "u-wrong-type" },
    ];
    const modelsNoRef = MODELS_ALL_WITH_UPLOAD.map((m) =>
        (m.type === "unet" || m.type === "clip") ? { name: m.name, type: m.type, size: m.size } : m
    );
    await openDetail({
        id: 42, name: "Krea 2", author: "moi", version: 1, likes: 0, downloads: 0,
        required_nodes: [],
        required_models: modelsNoRef,
        required_loras: LORAS,
    });

    const unetCb = modelCb("Krea2-Turbo-int8-ConvRot.safetensors");
    const clipCb = modelCb("qwen3-vl-4b-heritic_int8.safetensors");
    assert.strictEqual(unetCb.dataset.uploadId, "u-unet-remote",
        "upload_id de l'unet résolu PAR NOM (+ type) — homonyme lora ignoré");
    assert.strictEqual(clipCb.dataset.uploadId, "u-clip-remote", "upload_id du clip résolu par nom");
    assert.ok(bodyText().includes("réf. serveur retrouvée"), "badge « réf. serveur retrouvée » affiché");
    assert.strictEqual(baseFor(unetCb), "unet/", "dossier unet/ affiché après résolution");
    assert.strictEqual(baseFor(clipCb), "clip/", "dossier clip/ affiché après résolution");

    window.document.getElementById("wf-load-btn").click();
    await waitFor(() => downloadCalls.length >= 8, "8/8 téléchargements émis après résolution (" + downloadCalls.length + ")");
    await sleep(1600);
    downloadDelayMs = 0;
    remoteItems = [];

    assert.strictEqual(downloadCalls.length, 8, "8/8 TÉLÉCHARGÉS malgré l'upload_id absent du workflow");
    const unetDl = downloadCalls.find((d) => d.type === "unet");
    const clipDl = downloadCalls.find((d) => d.type === "clip");
    assert.strictEqual(unetDl.upload_id, "u-unet-remote", "l'unet est téléchargé via l'upload_id résolu");
    assert.strictEqual(unetDl.dest_path, "Krea2-Turbo-int8-ConvRot.safetensors", "dest_path unet conservé");
    assert.strictEqual(clipDl.upload_id, "u-clip-remote", "le clip est téléchargé via l'upload_id résolu");
    assert.ok(!downloadCalls.some((d) => d.upload_id === "u-wrong-type"),
        "jamais l'homonyme d'un type incompatible");
    ok("2 unet/clip sans upload_id → résolus par nom+type, 8/8 téléchargés au bon dossier");
}

/* ══ 3. BUG B — alias du même dépôt détectés « déjà installé » + SKIP ═════ */
console.log("3. BUG B — alias (casse/.git/https-ssh/ComfyUI-) détectés et sautés");
{
    installedNodes = [{
        name: "ComfyUI-AI-Helper",
        git_url: "https://github.com/Holaf/ComfyUI-AI-Helper.git",
        has_git: true, node_types: ["AIHX"],
    }];
    await openDetail({
        id: 42, name: "Krea 2", author: "moi", version: 1, likes: 0, downloads: 0,
        required_loras: [], required_models: [],
        required_nodes: [
            { name: "ComfyUI-AI-Helper", url: "https://github.com/Holaf/ComfyUI-AI-Helper.git" }, // exact
            { name: "AI-Helper", url: "https://github.com/holaf/comfyui-ai-helper" },              // casse + .git + owner
            { name: "ComfyUI-AI-Helper", url: "git@github.com:Holaf/ComfyUI-AI-Helper.git" },      // ssh vs https
            { name: "ComfyUI-Holaf", url: "https://github.com/Holaf/ComfyUI-Holaf.git" },          // AUTRE dépôt (non installé)
        ],
    });

    const exact = nodeCb("ComfyUI-AI-Helper");
    const ssh = Array.from(window.document.querySelectorAll('.wf-dep-cb[data-type="node"]'))
        .find((cb) => cb.dataset.url === "git@github.com:Holaf/ComfyUI-AI-Helper.git");
    const aliasName = nodeCb("AI-Helper");
    const other = nodeCb("ComfyUI-Holaf");

    assert.strictEqual(exact.checked, false, "URL identique → décoché (déjà installé)");
    assert.ok(aliasName.checked === false, "alias casse/.git/owner → décoché (déjà installé)");
    assert.ok(ssh.checked === false, "alias git@ vs https → décoché (déjà installé)");
    assert.strictEqual(other.checked, true, "dépôt NON installé → coché (à installer)");
    assert.ok(bodyText().includes("déjà installé"), "badge « déjà installé » affiché pour les alias");

    window.document.getElementById("wf-load-btn").click();
    await waitFor(() => downloadCalls.length >= 0, "chargement terminé (noop)");
    await sleep(1200);

    const installedNames = installCalls.map((c) => c.name);
    assert.ok(!installedNames.includes("AI-Helper"),
        "aucune tentative d'installation pour l'alias AI-Helper");
    assert.ok(!installCalls.some((c) => /ComfyUI-AI-Helper/.test(c.name) === false && /git@github.com:Holaf\/ComfyUI-AI-Helper/.test(c.git_url)),
        "aucune tentative pour l'alias git@ du même dépôt");
    assert.deepStrictEqual(installedNames, ["ComfyUI-Holaf"],
        "seul le dépôt réellement manquant est installé (obtenu : " + JSON.stringify(installedNames) + ")");
    ok("alias décochés + sautés, seul le dépôt manquant est installé");
}

/* ══ 4. FILET DE SÉCURITÉ — « already installed » = skip bénin (zéro erreur) ═ */
console.log("4. FILET — réponse serveur « already installed » → skip bénin, aucune erreur");
{
    installedNodes = [];            // non détecté au rendu → coché, installation tentée
    installBehaviour = "already";
    await openDetail({
        id: 42, name: "Krea 2", author: "moi", version: 1, likes: 0, downloads: 0,
        required_loras: [], required_models: [],
        required_nodes: [{ name: "ComfyUI-Holaf", url: "https://github.com/Holaf/ComfyUI-Holaf.git" }],
    });
    const cb = nodeCb("ComfyUI-Holaf");
    assert.strictEqual(cb.checked, true, "non détecté au rendu → coché (installation tentée)");
    window.document.getElementById("wf-load-btn").click();
    await waitFor(() => installCalls.length >= 1, "tentative d'installation émise");
    await waitFor(() => cb.dataset.installed === '1', "ligne repassée en « déjà installé »");
    await sleep(300);
    assert.strictEqual(cb.checked, false, "case décochée après le skip bénin");
    assert.ok(bodyText().includes("déjà installé"), "badge « déjà installé » affiché");
    assert.ok(!bodyText().includes("Node 'ComfyUI-Holaf' already installed"),
        "le message serveur brut n'est PAS présenté comme une erreur");
    assert.ok(!/Échec de l'installation|Failed to install/.test(bodyText()),
        "AUCUNE erreur d'installation affichée pour un node déjà présent");
    assert.ok(!bodyText().includes("erreur serveur (statut 400)"),
        "pas de message générique HolafFetch");
    installBehaviour = "ok";
    ok("« already installed » → skip bénin (ligne déjà installé, zéro erreur)");
}

/* ══ 4bis. ÉCHEC RÉEL — message serveur exact conservé ═══════════════════ */
console.log("4bis. ÉCHEC RÉEL (git clone) → message serveur exact, jamais muet");
{
    installedNodes = [];
    installBehaviour = "boom";
    await openDetail({
        id: 42, name: "Krea 2", author: "moi", version: 1, likes: 0, downloads: 0,
        required_loras: [], required_models: [],
        required_nodes: [{ name: "ComfyUI-Holaf", url: "https://github.com/Holaf/ComfyUI-Holaf.git" }],
    });
    window.document.getElementById("wf-load-btn").click();
    await waitFor(() => installCalls.length >= 1, "tentative d'installation émise");
    await sleep(300);
    assert.ok(bodyText().includes("git clone failed: repository not found"),
        "l'échec réel remonte le message serveur exact");
    assert.ok(/Échec de l'installation/.test(bodyText()), "un vrai échec est bien signalé (❌)");
    installBehaviour = "ok";
    ok("échec réel → message exact conservé (le filet ne masque pas les vrais échecs)");
}

/* ══ 5. BUG B — node sans URL git et non installé → message clair ════════ */
console.log("5. BUG B — node ni détectable ni installable → message clair");
{
    installedNodes = [];
    await openDetail({
        id: 42, name: "Krea 2", author: "moi", version: 1, likes: 0, downloads: 0,
        required_loras: [], required_models: [],
        required_nodes: [{ name: "PacksansUrl", url: "" }],
    });
    assert.ok(bodyText().includes("URL git non trouvée"), "la liste signale l'absence d'URL git");
    const cb = nodeCb("PacksansUrl");
    window.document.getElementById("wf-load-btn").click();
    await sleep(400);
    assert.strictEqual(installCalls.length, 0, "aucune tentative d'installation sans URL");
    assert.ok(bodyText().includes("sans URL git"), "un message clair est affiché (jamais un échec muet)");
    ok("node sans URL → aucune tentative + message clair");
}

/* ══ 6. FAUX NÉGATIF #1 — node installé SANS git_url (dossier seul) ══════ */
console.log("6. node installé SANS git_url (dossier seul) → détecté, aucun POST install");
{
    // Le serveur liste désormais TOUS les dossiers custom_nodes, y compris sans
    // remote git : la détection s'appuie alors sur le NOM DE DOSSIER normalisé.
    installedNodes = [{
        name: "ComfyUI-KJNodes", git_url: "", has_git: false,
        node_types: ["ImageResizeKJ", "GetImageSizeKJ"],
    }];
    await openDetail({
        id: 42, name: "Krea 2", author: "moi", version: 1, likes: 0, downloads: 0,
        required_loras: [], required_models: [],
        required_nodes: [
            // node_types ABSENTS côté workflow : seul le NOM DE DOSSIER peut le détecter.
            { name: "ComfyUI-KJNodes", url: "https://github.com/kijai/ComfyUI-KJNodes" },
            { name: "ComfyUI-Holaf", url: "https://github.com/Holaf/ComfyUI-Holaf.git" },
        ],
    });
    const kj = nodeCb("ComfyUI-KJNodes");
    const holaf = nodeCb("ComfyUI-Holaf");
    assert.strictEqual(kj.checked, false, "KJNodes (dossier seul, sans git_url) → décoché");
    assert.strictEqual(kj.dataset.installed, "1", "KJNodes marqué data-installed");
    assert.ok(bodyText().includes("dossier"), "la RAISON « dossier » est affichée");
    assert.strictEqual(holaf.checked, true, "Holaf (absent) reste coché");
    window.document.getElementById("wf-load-btn").click();
    await waitFor(() => installCalls.length >= 1, "Holaf installé");
    await sleep(300);
    assert.strictEqual(installCalls.length, 1, "UN seul POST install (Holaf)");
    assert.ok(!installCalls.some((c) => c.name === "ComfyUI-KJNodes"),
        "AUCUN POST install pour KJNodes (détecté installé sans git_url)");
    ok("node sans git_url (dossier) → détecté par nom de dossier, aucun POST install");
}

/* ══ 7. Multi-signaux — dossier renommé, remote lu, url équivalente ══════ */
console.log("7. multi-signaux : dossier renommé + remote .git lu + url équivalente autrement écrite");
{
    installedNodes = [
        { name: "kjnodes", git_url: "", has_git: true, node_types: [] },                                            // dossier renommé, pas de remote
        { name: "SansNomRepo", git_url: "git@github.com:Holaf/ComfyUI-Holaf.git", has_git: true, node_types: [] },   // remote réel lu
    ];
    await openDetail({
        id: 42, name: "Krea 2", author: "moi", version: 1, likes: 0, downloads: 0,
        required_loras: [], required_models: [],
        required_nodes: [
            { name: "ComfyUI-KJNodes", url: "git@github.com:kijai/ComfyUI-KJNodes.git" },  // dossier renommé « kjnodes »
            { name: "ComfyUI-Holaf", url: "https://www.github.com/Holaf/ComfyUI-Holaf/" },  // url équivalente (www, slash)
        ],
    });
    const kj = nodeCb("ComfyUI-KJNodes");
    const holaf = nodeCb("ComfyUI-Holaf");
    assert.strictEqual(kj.checked, false, "dossier renommé « kjnodes » → détecté");
    assert.strictEqual(holaf.checked, false, "remote git lu depuis le dossier installé → détecté");
    assert.ok(bodyText().includes("dossier"), "raison dossier affichée");
    assert.ok(bodyText().includes("URL"), "raison URL affichée");
    window.document.getElementById("wf-load-btn").click();
    await sleep(400);
    assert.strictEqual(installCalls.length, 0, "aucun POST install (les deux sont déjà installés)");
    ok("dossier renommé + remote .git + url équivalente → tous détectés, aucun POST");
}

/* ══ 8. Signal classes de nodes (workflow) — sans faux positif ═══════════ */
console.log("8. signal classes de nodes (node_types) → détecté sans faux positif");
{
    installedNodes = [{ name: "PackInstalle", git_url: "", has_git: false, node_types: ["Krea2AttentionTweak"] }];
    await openDetail({
        id: 42, name: "Krea 2", author: "moi", version: 1, likes: 0, downloads: 0,
        required_loras: [], required_models: [],
        required_nodes: [
            { name: "ComfyUI-Krea2-attention-tweak", url: "https://github.com/x/krea2", node_types: ["Krea2AttentionTweak"] },
            { name: "PackInconnu", url: "https://github.com/x/PackInconnu", node_types: ["ClasseInexistante"] },
        ],
    });
    const known = nodeCb("ComfyUI-Krea2-attention-tweak");
    const unknown = nodeCb("PackInconnu");
    assert.strictEqual(known.checked, false, "classe présente dans un pack installé → détecté");
    assert.ok(bodyText().includes("node «"), "raison « node <classe> » affichée");
    assert.strictEqual(unknown.checked, true, "classe absente → PAS de faux positif, reste coché");
    window.document.getElementById("wf-load-btn").click();
    await waitFor(() => installCalls.length >= 1, "PackInconnu installé");
    await sleep(300);
    assert.deepStrictEqual(installCalls.map((c) => c.name), ["PackInconnu"],
        "seul le pack réellement absent est installé");
    ok("signal classes → détecté sans faux positif (pack absent toujours proposé)");
}

/* ══ 9. Forçage — recocher une case « déjà installé » = install tentée ═══ */
console.log("9. forçage : recocher la case « déjà installé » force l'installation");
{
    installedNodes = [{ name: "ComfyUI-KJNodes", git_url: "", has_git: false, node_types: [] }];
    installBehaviour = "already";  // forcer un node réellement présent → skip bénin final
    await openDetail({
        id: 42, name: "Krea 2", author: "moi", version: 1, likes: 0, downloads: 0,
        required_loras: [], required_models: [],
        required_nodes: [{ name: "ComfyUI-KJNodes", url: "https://github.com/kijai/ComfyUI-KJNodes" }],
    });
    const kj = nodeCb("ComfyUI-KJNodes");
    assert.strictEqual(kj.checked, false, "détecté installé → décoché par défaut");
    kj.checked = true;  // l'utilisateur force
    window.document.getElementById("wf-load-btn").click();
    await waitFor(() => installCalls.length >= 1, "l'installation est FORCÉE malgré la détection");
    assert.strictEqual(installCalls[0].name, "ComfyUI-KJNodes", "POST install émis pour le node forcé");
    await sleep(300);
    assert.ok(!/Échec de l'installation/.test(bodyText()),
        "le forçage d'un node déjà présent reste un skip bénin (aucune erreur)");
    installBehaviour = "ok";
    ok("recocher force l'installation ; serveur « already installed » → skip bénin");
}

/* ══ 10. Verrous statiques + contrôle négatif par mutation (texte source) ══ */
console.log("10. Verrous statiques et parité i18n");
{
    const src = readFileSync(new URL("./aih_workflow_share.js", import.meta.url), "utf8");
    const strings = readFileSync(new URL("./aih_strings.js", import.meta.url), "utf8");

    // Mutation A1 : remettre le skip muet (`if (!uploadId … ) continue;`) rougit.
    assert.ok(/if \(!uploadId\) \{[\s\S]{0,120}skippedDeps\.push/.test(src),
        "mutation : une entrée sans upload_id doit être COLLECTÉE (plus de `continue` muet)");
    assert.ok(!/if \(!uploadId \|\| \(dtype !== 'model'/.test(src),
        "mutation : l'ancien skip muet `if (!uploadId || …) continue;` a disparu");
    // Mutation A2 : `setResult` doit gérer l'état 'skipped' (ligne ⏭ visible).
    assert.ok(/success === 'skipped'/.test(src),
        "mutation : setResult doit rendre un état « skipped » (sinon le skip redeviendrait muet)");
    // Mutation A3 : le compteur n'est plus le seul chiffre.
    assert.ok(/wf\.depsSkippedSuffix/.test(src) && /wf\.depsNoneDownloadable/.test(src),
        "mutation : le compteur/état doit mentionner les dépendances non téléchargées");

    // Mutation B1 : normalisation d'URL/nom présente.
    assert.ok(/function normalizeRepoUrl/.test(src) && /function normalizeRepoName/.test(src),
        "mutation : la détection d'installation doit normaliser URL git + nom de dépôt");
    assert.ok(/nodeMatchesInstalledIndex/.test(src),
        "mutation : la détection doit utiliser l'index normalisé (alias reconnus)");
    // Mutation B2 : la boucle d'installation doit SKIPPER les installés.
    assert.ok(/nodeMatchesInstalledIndex\(installedIndex, nname, nurl, ntypes\)/.test(src),
        "mutation : la boucle d'installation doit consulter l'état « déjà installé » (mêmes signaux que le badge, classes incluses)");
    assert.ok(/JSON\.parse\(decodeURIComponent\(ncb\.dataset\.nodeTypes/.test(src),
        "mutation : les classes de nodes (node_types) doivent être relues depuis la case pour le skip");
    assert.ok(/dataset\.installed === '1'/.test(src),
        "mutation : la case déjà installée doit porter data-installed et être sautée");
    // Mutation B3 : message d'erreur réel.
    assert.ok(/function installErrorMessage/.test(src) && /installErrorMessage\(e\)/.test(src),
        "mutation : l'échec d'installation doit remonter data.message/data.error");
    // Mutation C1 : filet de sécurité « already installed » → skip bénin.
    assert.ok(/function isAlreadyInstalledMessage/.test(src),
        "mutation : le classifieur « already installed » doit exister");
    assert.ok((src.match(/isAlreadyInstalledMessage\(/g) || []).length >= 3,
        "mutation : le filet doit être utilisé au rendu manuel ET dans la boucle de chargement");
    assert.ok(/markNodeInstalled\(ncb\)/.test(src) && /markNodeInstalled\(cb\)/.test(src),
        "mutation : la ligne doit repasser en « déjà installé » sur réponse serveur");
    // Mutation D1 : détection multi-signaux (URL + dossier + classes).
    assert.ok(/function matchInstalledNode/.test(src) && /function buildInstalledNodeIndex/.test(src),
        "mutation : la détection doit se faire par match multi-signaux");
    assert.ok(/idx\.types\[tname\]/.test(src) && /names\[n\] = label/.test(src),
        "mutation : indexer le nom de dossier (label) ET les classes de nodes");
    assert.ok(/reason: "url"/.test(src) && /reason: "folder"/.test(src) && /reason: "types"/.test(src),
        "mutation : chaque signal doit produire une raison affichable");
    // Mutation E1 : le forçage (recocher) tente l'installation.
    assert.ok(/var forced = ncb\.dataset\.installed === '1'/.test(src) && /!forced && nodeMatchesInstalledIndex/.test(src),
        "mutation : recocher une case déjà installée doit FORCER l'installation");
    // FAUSSE PISTE (a) écartée : 'unet'/'clip' SONT gérés des deux côtés.
    assert.ok(/'unet':'unet'/.test(src) && /'clip':'clip'/.test(src),
        "(a) écartée : typeToFolder JS gère déjà unet + clip");
    const py = readFileSync(new URL("../aih/model_manager.py", import.meta.url), "utf8");
    assert.ok(/'unet': 'unet'/.test(py) && /'clip': 'clip'/.test(py),
        "(a) écartée : type_to_cat Python gère déjà unet + clip");
    // Mutation F1 (Python) : l'index serveur ne doit plus EXCLURE les dossiers
    // custom_nodes sans remote git — sinon le signal « nom de dossier » n'existe
    // jamais pour eux (faux négatif racine).
    const cnm = readFileSync(new URL("../aih/custom_nodes_manager.py", import.meta.url), "utf8");
    assert.ok(/def _get_installed_custom_nodes/.test(cnm),
        "mutation : _get_installed_custom_nodes doit exister");
    assert.ok(!/if has_git or git_url:/.test(cnm),
        "mutation : plus de filtre `if has_git or git_url:` (les dossiers sans git doivent être listés)");
    assert.ok(/for section in config\.sections\(\)/.test(cnm),
        "mutation : _read_git_url doit lire un remote non-origin (remote réel du dossier)");

    // Mutation G1 : la version du module est VÉRIFIABLE (constante + sonde).
    assert.ok(/var AIH_WF_SHARE_BUILD = "wf-share-/.test(src),
        "mutation : marqueur de build présent dans le module");
    assert.ok(/window\.AIH_WF_SHARE = \{/.test(src),
        "mutation : build exposée sur window.AIH_WF_SHARE (DevTools)");
    assert.ok(/function checkServedBuildFreshness/.test(src) && /cache: "no-store"/.test(src),
        "mutation : sonde de fraîcheur (fichier servi ≠ build exécutée)");
    assert.ok(/id="wf-stale-banner"/.test(src) && /wf\.staleBuild/.test(src),
        "mutation : bandeau « version obsolète » affiché si le serveur sert une autre build");
    assert.ok(/wf\.buildLabel/.test(src), "mutation : build affichée dans l'UI");
    // Mutation H1 : résolution par NOM de la référence serveur.
    assert.ok(/function resolveRemoteUploadId/.test(src) && /function remoteTypeCompatible/.test(src),
        "mutation : résolution upload_id par nom (unet/clip sans upload_id)");
    assert.ok((src.match(/resolveRemoteUploadId\(/g) || []).length >= 3,
        "mutation : résolution tentée au rendu ET dans la boucle de chargement");
    assert.ok(/\/api\/aih\/models\/remote\?search=/.test(src),
        "mutation : la résolution interroge la route locale (proxy) de liste distante");
    // Mutation I1 : FIN de chargement explicite (progression + récapitulatif).
    assert.ok(/wf\.dlProgress/.test(src) && /wf\.dlDoneTitle/.test(src) && /wf\.dlRecap/.test(src),
        "mutation : progression globale + récapitulatif final du panneau");
    assert.ok(/stats\.noref\+\+/.test(src) && /stats\.already\+\+/.test(src) &&
        /stats\.downloaded\+\+/.test(src) && /stats\.failed\+\+/.test(src),
        "mutation : le récap distingue téléchargés / déjà présents / non téléchargeables / échecs");
    assert.ok(/panel\.dataset\.state = "done"/.test(src),
        "mutation : état final 'done' posé sur le panneau");

    // Parité i18n stricte FR/EN des clés ajoutées.
    const enIdx = strings.indexOf("const EN = {");
    assert.ok(enIdx > 0, "bloc EN localisé");
    const keys = [
        "wf.depNoServerRef", "wf.depSkippedNoRef", "wf.depSkippedAlreadyLocal",
        "wf.depSkippedKept", "wf.depsSkippedSuffix", "wf.depsNoneDownloadable",
        "wf.depsSkippedToast", "wf.nodesNoGitUrl", "wf.uploadLocalMissing",
        "wf.alreadyInstalledMatch", "wf.matchReasonFolder", "wf.matchReasonUrl",
        "wf.matchReasonNode", "wf.matchReasonServer", "wf.forceInstallHint",
        "wf.alreadyInstalledMsg", "wf.alreadyInstalledSummary",
        "wf.buildLabel", "wf.staleBuild", "wf.dlProgress", "wf.dlDoneTitle",
        "wf.dlRecap", "wf.dlRecapToast", "wf.depResolved",
    ];
    for (const key of keys) {
        const token = '"' + key + '"';
        assert.ok(strings.indexOf(token) > 0 && strings.indexOf(token) < enIdx,
            `clé ${key} absente du bloc FR`);
        assert.ok(strings.indexOf(token, enIdx) > 0,
            `clé ${key} absente du bloc EN (parité stricte FR/EN)`);
    }
    ok("verrous statiques (mutation A1-A3, B1-B3, C1, D1, E1, F1) + fausse piste (a) + parité i18n " + keys.length + " clés");
}

console.log(`\n✅ test_aih_workflow_share_detail_deps : ${n} groupes PASSENT`);
process.exit(0);
