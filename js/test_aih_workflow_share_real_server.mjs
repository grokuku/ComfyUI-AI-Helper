// ─────────────────────────────────────────────────────────────────────────
// E2E RÉEL — Workflow Share contre les VRAIS serveurs.
//
// Contrairement aux autres tests du dossier (fetch stubbé), ce test monte :
//   - les VRAIS handlers aiohttp du pack (aih.routes._register_models_group :
//     /api/aih/custom-nodes, /api/aih/custom-nodes/install, /api/aih/models/*)
//     via tests/serve_workflow_share_e2e.py (sous-processus) ;
//   - le VRAI backend AI-Helper (Flask + DB) pour /api/workflows* et
//     /api/aih/models/remote (le proxy du pack fait un vrai requests.get) ;
//   - la VRAIE brique HolafFetch du pack + le vrai fetch Node (HTTP réel).
//
// Il verrouille les 3 symptômes utilisateur :
//   (1) forme RÉELLE de l'erreur d'installation et filet « already installed » ;
//       cases DÉCOCHÉES pour les nodes badgés « déjà installé » ; deux chemins
//       (bouton Installer / boucle Charger) qui skippent réellement ;
//   (2) unet/clip sans upload_id : résolution par nom (types compatibles,
//       diffusion_model inclus) ou badge rouge explicite + pas de champ ;
//   (3) fenêtre de téléchargement : progression N/M + récap + état « Terminé ».
//
// Usage : node js/test_aih_workflow_share_real_server.mjs
//   Interpréteur Python : $AIH_TEST_PYTHON, sinon /projects/AI-Helper/.venv/bin/python,
//   sinon python3 (doit fournir aiohttp+flask+requests). Introuvable = SKIP (exit 2).
// Code de sortie : 0 = PASS, 2 = SKIP, 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_aih_workflow_share_real_server");
const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = resolve(HERE, "..");
const HELPER = resolve(HERE, "..", "tests", "serve_workflow_share_e2e.py");

// ── Interpréteur Python avec aiohttp+flask+requests ──────────────────────
function findPython() {
    const candidates = [
        process.env.AIH_TEST_PYTHON,
        "/projects/AI-Helper/.venv/bin/python",
        process.env.PYTHON,
        "python3",
    ].filter(Boolean);
    for (const cmd of candidates) {
        const probe = spawnSync(cmd, ["-c", "import aiohttp, flask, requests"], {
            timeout: 20000, stdio: "ignore",
        });
        if (probe.status === 0) return cmd;
    }
    return null;
}
const PYTHON = findPython();
if (!PYTHON) {
    console.warn(
        "⚠️  test_aih_workflow_share_real_server : aucun interpréteur Python " +
        "(aiohttp+flask+requests) trouvé → test ignoré (SKIP, exit 2).\n" +
        "    Fournir AIH_TEST_PYTHON=/chemin/vers/python pour l'exécuter."
    );
    process.exit(2);
}

// ── Démarrage du harnais (serveurs réels) ────────────────────────────────
const srv = spawn(PYTHON, [HELPER], { stdio: ["ignore", "pipe", "pipe"] });
// Nettoyage garanti, même si une assertion échoue (jamais d'orphelin).
process.on("exit", () => { try { srv.kill(); } catch (e) { /* déjà mort */ } });
let srvErr = "";
srv.stderr.on("data", (d) => { srvErr += String(d); });
const info = await new Promise((resolvePromise, reject) => {
    let buf = "";
    const to = setTimeout(
        () => reject(new Error("timeout démarrage harnais\n" + srvErr)), 60000);
    srv.stdout.on("data", (d) => {
        buf += String(d);
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
            clearTimeout(to);
            try { resolvePromise(JSON.parse(buf.slice(0, nl))); }
            catch (e) { reject(new Error("JSON harnais illisible: " + buf.slice(0, 300))); }
        }
    });
    srv.on("exit", (c) => reject(new Error("harnais sorti code " + c + "\n" + srvErr)));
});
const PACK_URL = info.PACK_URL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── jsdom + VRAI fetch (URLs relatives résolues vers PACK_URL) ───────────
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: PACK_URL + "/",
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
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
    const url = (typeof input === "string" && !/^https?:/i.test(input))
        ? new URL(input, PACK_URL).toString() : input;
    return realFetch(url, init);
};
window.fetch = globalThis.fetch;

window.app = {
    graph: { serialize: () => ({ nodes: [], links: [], extra: {} }), _nodes: [] },
    ui: {},
    workflowName: "",
    loadGraphData: () => Promise.resolve(),
};

// ── Modules réels du pack ────────────────────────────────────────────────
const { HolafFetch, HolafFetchError } =
    await import(new URL("../js/vendor/holaf/holaf-fetch.js", import.meta.url));
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
window.localStorage.setItem("AIH_config",
    JSON.stringify({ serverUrl: info.BACKEND_URL, apiKey: info.TOKEN }));

const waitFor = async (cond, label, tries = 1200) => {
    for (let i = 0; i < tries; i++) {
        if (cond()) return;
        await sleep(5);
    }
    throw new Error("waitFor timeout: " + label);
};

let n = 0;
const ok = (m) => { n++; console.log("  ✓ " + m); };
const post = (p, body) => fetch(PACK_URL + p, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
}).then((r) => r.json());
const calls = () => fetch(PACK_URL + "/__calls").then((r) => r.json());
const bodyText = () => window.document.body.textContent;
const nodeCb = (name) => Array.from(window.document.querySelectorAll('.wf-dep-cb[data-type="node"]'))
    .find((cb) => cb.dataset.name === name);
const modelCb = (name) => Array.from(window.document.querySelectorAll('.wf-dep-cb[data-type="model"], .wf-dep-cb[data-type="lora"]'))
    .find((cb) => cb.dataset.name === name);
const baseFor = (cb) => {
    const d = cb && cb.closest ? cb.closest("div") : null;
    const b = d ? d.querySelector(".wf-dep-basepath") : null;
    return b ? b.textContent : "";
};
const donePanel = () => window.document.querySelector('[data-state="done"]');

window.openWorkflowManager();
await waitFor(() => typeof window._wfOpenDetail === "function", "_wfOpenDetail défini");
await sleep(20);

async function openDetail(workflowId, opts = {}) {
    await post("/__calls/reset");
    if (opts.faultCustomNodesOnce) await post("/__fault/custom-nodes-once");
    window.document.body.innerHTML = "";
    window._wfOpenDetail(workflowId);
    await waitFor(() => window.document.querySelectorAll("#wf-install-deps .wf-dep-cb").length > 0 ||
        /aucune dépendance/i.test(bodyText()), "dépendances rendues");
    await sleep(120); // laisse la résolution par nom (async) se terminer
}

/* ══ 1. FORME RÉELLE DE L'ERREUR (handler + brique réels) ════════════════ */
console.log("1. Erreur 400 réelle du handler install + extraction par le front");
let errShape = null;
try {
    await HolafFetch.request(PACK_URL + "/api/aih/custom-nodes/install", {
        method: "POST",
        body: { git_url: "https://github.com/Holaf/ComfyUI-Holaf", name: "ComfyUI-Holaf" },
    });
} catch (e) { errShape = e; }
{
    assert.ok(errShape, "un 400 réel doit être levé");
    assert.ok(errShape instanceof HolafFetchError, "l'erreur réelle est une HolafFetchError");
    assert.strictEqual(errShape.status, 400, "statut HTTP conservé");
    assert.strictEqual(errShape.message, "erreur serveur (statut 400)",
        "la brique (qui ne lit que error/detail) produit le message GÉNÉRIQUE");
    assert.ok(errShape.data && typeof errShape.data.message === "string",
        "le corps JSON réel est attaché à err.data");
    assert.ok(/already installed/i.test(errShape.data.message),
        "err.data.message contient le message serveur réel « already installed »");
    ok("erreur réelle : status=400, message générique, err.data.message=" +
        JSON.stringify(errShape.data.message));
}

/* ══ 2. NODES DÉJÀ INSTALLÉS : décochés + badge, ZÉRO install ═══════════ */
console.log("2. Nodes réellement installés (alias + classes) → décochés, zéro POST install");
{
    await openDetail(info.WORKFLOW_ID);
    const aliases = [
        "ComfyUI-Holaf", "ComfyUI-AI-Helper", "AI-Helper",
        "comfyui-vrgamedevgirl", "ComfyUI-Holaf-Utilities",
    ];
    for (const name of aliases) {
        const cb = nodeCb(name);
        assert.ok(cb, "node listé : " + name);
        assert.strictEqual(cb.checked, false, name + " → case DÉCOCHÉE (badge)");
        assert.strictEqual(cb.dataset.installed, "1", name + " → marqué data-installed");
        const label = cb.closest("label");
        assert.ok(/déjà installé/.test(label.textContent), name + " → badge « déjà installé » visible");
    }
    const kj = nodeCb("ComfyUI-KJRenamed");
    assert.strictEqual(kj.checked, false, "match par CLASSES uniquement → décoché");
    assert.ok(/node «/.test(kj.closest("label").textContent),
        "la raison « node <classe> » est affichée (badge = détection partagée)");
    const c = await calls();
    assert.deepStrictEqual(c.install, [], "AUCUN POST install pour des nodes déjà installés");
    ok("6 nodes détectés (alias + classes) → décochés/badgés, zéro install");
}

/* ══ 3. UNET/CLIP SANS upload_id MAIS PRÉSENTS CÔTÉ SERVEUR ══════════════ */
console.log("3. unet/clip sans upload_id : résolution par nom contre le VRAI backend");
{
    await openDetail(info.WORKFLOW_ID);
    const unet = modelCb("Krea2-Turbo-int8-ConvRot.safetensors");
    const clip = modelCb("qwen3-vl-4b-heritic_int8.safetensors");
    assert.strictEqual(unet.dataset.uploadId, "u-unet", "unet résolu par nom+type");
    assert.strictEqual(clip.dataset.uploadId, "u-clip", "clip résolu par nom+type");
    assert.strictEqual(baseFor(unet), "unet/", "champ destination unet/ affiché");
    assert.strictEqual(baseFor(clip), "clip/", "champ destination clip/ affiché");
    assert.ok(/réf\. serveur retrouvée/.test(bodyText()), "badge « réf. serveur retrouvée » affiché");
    assert.ok(!/non téléchargeable/.test(bodyText()), "aucun faux « non téléchargeable »");
    ok("unet+clip résolus via /api/aih/models/remote réel (proxy pack → backend Flask)");
}

/* ══ 3bis. TYPE BACKEND « diffusion_model » ≡ « unet » ═══════════════════ */
console.log("3bis. backend stocke diffusion_model alors que le workflow dit unet");
{
    await post("/__uploads/delete");
    await post("/__uploads/seed", { items: [
        { upload_id: "u-unet-dm", filename: "Krea2-Turbo-int8-ConvRot.safetensors",
          size: 13500000000, type: "diffusion_model" },
    ] });
    await openDetail(info.WORKFLOW_ID);
    const unet = modelCb("Krea2-Turbo-int8-ConvRot.safetensors");
    const clip = modelCb("qwen3-vl-4b-heritic_int8.safetensors");
    assert.strictEqual(unet.dataset.uploadId, "u-unet-dm",
        "unet ↔ diffusion_model : équivalence honorée (sinon red badge à tort)");
    assert.strictEqual(baseFor(unet), "unet/", "destination unet/ toujours affichée");
    assert.ok(/non téléchargeable/.test(clip.closest("div").textContent),
        "le clip réellement absent reste signalé");
    ok("équivalence unet/diffusion_model → résolu ; clip absent → red badge explicite");
}

/* ══ 4. UNET/CLIP ABSENTS : badge rouge + pas de champ + skip motivé ════ */
console.log("4. unet/clip absents du serveur → badge rouge, pas de champ, skip expliqué");
{
    await post("/__uploads/delete");
    await openDetail(info.WORKFLOW_ID);
    for (const name of ["Krea2-Turbo-int8-ConvRot.safetensors", "qwen3-vl-4b-heritic_int8.safetensors"]) {
        const cb = modelCb(name);
        assert.ok(/non téléchargeable \(aucune référence serveur\)/.test(cb.closest("div").textContent),
            name + " → badge rouge explicite");
        assert.strictEqual(baseFor(cb), "", name + " → PAS de champ destination (rien à télécharger)");
    }
    window.document.getElementById("wf-load-btn").click();
    await waitFor(() => donePanel(), "panneau à l'état final");
    const c = await calls();
    assert.ok(!c.download.some((d) => d.type === "unet" || d.type === "clip"),
        "aucun POST download pour les non téléchargeables");
    assert.ok(/upload_id manquant/.test(bodyText()), "la raison « upload_id manquant » est visible");
    const panel = donePanel();
    assert.ok(/non téléchargeable\(s\)/.test(panel.textContent), "récap : non téléchargeables comptés");
    assert.ok(/Progression : \d+\/\d+/.test(panel.textContent), "progression N/M affichée");
    assert.ok(/Téléchargement terminé/.test(panel.textContent), "état final « Téléchargement terminé »");
    ok("red badge + reason + aucune tentative ; panneau finalisé (N/M + récap)");
}

/* ══ 5. PRÉSENTS → vrais POST download aux bons types ═══════════════════ */
console.log("5. fichiers présents → POST download unet/clip aux bons types + fin de panneau");
{
    await post("/__uploads/seed", { items: [
        { upload_id: "u-unet", filename: "Krea2-Turbo-int8-ConvRot.safetensors", size: 13500000000, type: "unet" },
        { upload_id: "u-clip", filename: "qwen3-vl-4b-heritic_int8.safetensors", size: 4600000000, type: "clip" },
        { upload_id: "u-up2", filename: "OmniSR_X2_DIV2K.safetensors", size: 100000000, type: "upscale" },
        { upload_id: "u-vae", filename: "qwen_image_vae.safetensors", size: 200000000, type: "vae" },
        { upload_id: "u-la", filename: "lora-a.safetensors", size: 10000000, type: "lora" },
    ] });
    await openDetail(info.WORKFLOW_ID);
    window.document.getElementById("wf-load-btn").click();
    await waitFor(() => donePanel(), "panneau à l'état final");
    const c = await calls();
    const byType = {};
    for (const d of c.download) byType[d.type] = (byType[d.type] || 0) + 1;
    assert.strictEqual(byType.unet, 1, "l'unet est réellement téléchargé (type 'unet')");
    assert.strictEqual(byType.clip, 1, "le clip est réellement téléchargé (type 'clip')");
    const unetDl = c.download.find((d) => d.type === "unet");
    assert.strictEqual(unetDl.upload_id, "u-unet", "upload_id résolu utilisé");
    assert.strictEqual(unetDl.filename, "Krea2-Turbo-int8-ConvRot.safetensors");
    const panel = donePanel();
    assert.ok(/Progression : \d+\/\d+/.test(panel.textContent), "progression N/M");
    assert.ok(/téléchargé\(s\)/.test(panel.textContent) && /échec\(s\)/.test(panel.textContent),
        "récap chiffré téléchargés/échecs visible");
    const closeBtn = Array.from(panel.querySelectorAll("button")).find((b) => /Fermer/.test(b.textContent));
    assert.ok(closeBtn, "bouton Fermer posé par l'état final");
    ok("unet+clip téléchargés (types exacts) ; panneau terminé avec récap + Fermer");
}

/* ══ 6. PANNE TRANSITOIRE de l'index + classes → skip sans install ══════ */
console.log("6. index d'installation en panne au rendu puis OK → skip réel au chargement");
{
    await openDetail(info.WORKFLOW_ID, { faultCustomNodesOnce: true });
    // La panne du rendu laisse (à dessein) TOUTES les cases cochées.
    assert.strictEqual(nodeCb("ComfyUI-Holaf").checked, true,
        "panne de l'index au rendu → case cochée (pas de détection)");
    window.document.getElementById("wf-load-btn").click();
    await waitFor(() => donePanel(), "panneau à l'état final");
    const c = await calls();
    assert.deepStrictEqual(c.install, [],
        "au chargement, l'index est RÉESSAYÉ et les 6 packs (alias + classes) sont skippés");
    assert.ok(c.custom_nodes >= 2, "l'index est bien réinterrogé après l'échec (non mémorisé)");
    assert.strictEqual(nodeCb("ComfyUI-Holaf").checked, false,
        "après chargement, la case repasse décochée");
    ok("échec transitoire non mémorisé + classes honorées au chargement → zéro install");
}

/* ══ 7. FORÇAGE « déjà installé » → skip bénin, message réel ════════════ */
console.log("7. forcer un node installé → 400 réel classé bénin, jamais le message générique");
{
    await openDetail(info.WORKFLOW_ID);
    const cb = nodeCb("ComfyUI-Holaf");
    assert.strictEqual(cb.dataset.installed, "1", "node détecté installé (badge)");
    cb.checked = true; // l'utilisateur force explicitement
    window.document.getElementById("wf-load-btn").click();
    let forcedCalls = null;
    for (let i = 0; i < 600; i++) {
        forcedCalls = await calls();
        if (forcedCalls.install.length >= 1) break;
        await sleep(5);
    }
    assert.ok(forcedCalls && forcedCalls.install.length >= 1, "POST install forcé émis");
    await waitFor(() => nodeCb("ComfyUI-Holaf").checked === false, "case décochée après skip bénin");
    const c = await calls();
    assert.strictEqual(c.install.length, 1, "un seul POST (le node forcé)");
    assert.strictEqual(c.install[0].name, "ComfyUI-Holaf");
    assert.ok(!/erreur serveur \(statut 400\)/.test(bodyText()),
        "le message GÉNÉRIQUE de la brique n'est JAMAIS affiché (err.data.message lu)");
    assert.ok(/déjà installé/.test(bodyText()), "toast de skip bénin « déjà installé »");
    ok("400 réel « already installed » → skip bénin, aucun message générique");
}

/* ══ 7bis. BOUTON « Installer » PAR NODE → déjà installé = skip bénin ═══ */
console.log("7bis. bouton Installer par node : pack apparu après le rendu → skip bénin");
{
    await openDetail(info.LATE_WORKFLOW_ID);
    const cb = nodeCb("ComfyUI-LateAdded");
    assert.ok(cb && cb.checked, "pack inconnu au rendu → coché");
    const label = cb.closest("label");
    const btn = Array.from(label.querySelectorAll("button"))
        .find((b) => /Installer/.test(b.textContent));
    assert.ok(btn, "bouton Installer par node présent");
    // Le pack est installé CÔTÉ SERVEUR entre le rendu et le clic.
    await post("/__pack/add", { folder: "ComfyUI-LateAdded", git_url: "https://github.com/Holaf/ComfyUI-LateAdded" });
    // jsdom n'exécute pas les onclick inline : on appelle la MÊME fonction
    // globale que le handler du bouton (window._wfInstallNode).
    assert.strictEqual(typeof window._wfInstallNode, "function", "handler global présent");
    await window._wfInstallNode(cb.dataset.url, "ComfyUI-LateAdded", btn);
    await waitFor(() => /Installé/.test(btn.textContent), "bouton passé en « Installé »");
    await sleep(150);
    const c = await calls();
    assert.strictEqual(c.install.length, 1, "un POST install émis par le bouton");
    assert.ok(!/erreur serveur \(statut 400\)/.test(bodyText()),
        "le 400 réel « already installed » n'est PAS présenté comme une erreur générique");
    assert.ok(/déjà installé/.test(bodyText()), "message bénin « déjà installé » affiché");
    assert.strictEqual(nodeCb("ComfyUI-LateAdded").checked, false,
        "case décochée après le skip bénin du bouton");
    assert.strictEqual(nodeCb("ComfyUI-LateAdded").dataset.installed, "1",
        "ligne marquée installée (badge)");
    ok("bouton par node : 400 réel classé bénin, case décochée, badge posé");
}

/* ══ 8. Erreur NON-JSON : le corps texte réel est remonté ═══════════════ */
console.log("8. erreur serveur NON-JSON (texte brut) → le message réel est remonté");
{
    await openDetail(info.TEXTFAIL_WORKFLOW_ID);
    window.document.getElementById("wf-load-btn").click();
    await waitFor(() => /git explode: permission denied/.test(bodyText()),
        "le corps texte réel apparaît");
    assert.ok(!/réponse non-JSON/.test(bodyText()),
        "pas de message technique « réponse non-JSON » à la place du texte serveur");
    ok("corps texte 500 remonté tel quel (installErrorMessage lit err.body)");
}

/* ══ 9. Verrous statiques (mutations) + parité table type→dossier ═══════ */
console.log("9. Verrous statiques et parité JS/Python des dossiers de destination");
{
    const src = readFileSync(new URL("./aih_workflow_share.js", import.meta.url), "utf8");
    // M1 : décochage des nodes détectés.
    assert.ok(/\(installed \? '' : ' checked'\)/.test(src),
        "mutation : un node détecté installé doit être DÉCOCHÉ au rendu");
    // M2 : mêmes signaux au rendu ET au chargement (classes incluses).
    assert.ok(/data-node-types/.test(src) && /dataset\.nodeTypes/.test(src),
        "mutation : les classes de nodes doivent traverser rendu → chargement");
    // M3 : filet « already installed » + message réel.
    assert.ok(/function installErrorMessage/.test(src) && /typeof d\.detail === "string"/.test(src) &&
        /typeof e\.body === "string"/.test(src),
        "mutation : installErrorMessage doit lire message/error/detail ET le corps texte");
    assert.ok((src.match(/isAlreadyInstalledMessage\(/g) || []).length >= 3,
        "mutation : filet présent au bouton Installer ET dans la boucle Charger");
    // M4 : équivalence unet/diffusion_model.
    assert.ok(/unet: "diffusion_model"/.test(src),
        "mutation : l'équivalence unet ↔ diffusion_model doit exister");
    // M5 : index non mémorisé après échec.
    assert.ok(/_installedIndexPromise = null;/.test(src),
        "mutation : un échec d'index ne doit pas être mémorisé");
    // M6 : finalisation garantie du panneau.
    assert.ok(/finally \{\s*dlPanel\.done\(\);/.test(src),
        "mutation : dlPanel.done() doit être garanti (try/finally)");

    // Parité STRICTE JS `typeToFolder` ↔ Python `type_to_cat` (le dossier
    // affiché doit être celui où le Python écrit réellement le fichier).
    const py = readFileSync(new URL("../aih/model_manager.py", import.meta.url), "utf8");
    const jsM = src.match(/var typeToFolder = \{([^}]*)\}/);
    assert.ok(jsM, "la table typeToFolder doit être lisible");
    const jsMap = {};
    for (const m of jsM[1].matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)) jsMap[m[1]] = m[2];
    const pyM = py.match(/type_to_cat = \{([\s\S]*?)\n    \}/);
    assert.ok(pyM, "la table type_to_cat du pack Python doit être lisible");
    const pyMap = {};
    for (const m of pyM[1].matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)) pyMap[m[1]] = m[2];
    assert.deepStrictEqual(jsMap, pyMap,
        "les tables JS/Python des dossiers de destination doivent être identiques " +
        "(écart = fichier écrit dans un dossier ≠ de celui affiché)");
    ok("verrous M1-M6 + parité typeToFolder ↔ type_to_cat (" + Object.keys(jsMap).length + " types)");
}

console.log(`\n✅ test_aih_workflow_share_real_server : ${n} groupes PASSENT (serveurs réels)`);
srv.kill();
process.exit(0);
