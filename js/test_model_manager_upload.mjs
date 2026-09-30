// Upload de modèles du Model Manager (js/model_manager/model_manager_actions.js)
// SANS AUCUNE authentification applicative — jsdom + fetch stubé, aucun réseau.
// Usage : node js/test_model_manager_upload.mjs
//
// Décision produit : « zéro mot de passe, sécu uniquement par Caddy + Authentik ».
// Les routes /holaf/models/* ne sont PLUS gardées (aucun cookie, aucune invite).
// Ce test verrouille l'INVERSE de l'ancien test d'auth :
//   1. l'upload se fait SANS cookie et SANS aucune invite de mot de passe ;
//   2. aucune requête vers /holaf/auth/* n'est émise ;
//   3. un vrai message serveur (409 « existe déjà ») reste affiché à l'utilisateur ;
//   4. i18n : aucune clé mma.auth* résiduelle + parité FR/EN ;
//   5. statique : le module n'importe plus l'auth et appelle HolafFetch en direct.
//
// jsdom est résolu par le loader partagé ; introuvable = SKIP bruyant (exit 2).
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_model_manager_upload");

const dom = new JSDOM(`<!doctype html><html><body></body></html>`, {
    pretendToBeVisual: true,
    url: "http://localhost/",
});
const { window } = dom;
const { document } = window;
globalThis.window = window;
globalThis.document = document;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.MouseEvent = window.MouseEvent;
globalThis.Image = window.Image;
globalThis.Blob = window.Blob;
globalThis.File = window.File;
globalThis.FormData = window.FormData;
globalThis.requestAnimationFrame = window.requestAnimationFrame?.bind(window) || ((cb) => setTimeout(cb, 0));
globalThis.cancelAnimationFrame = window.cancelAnimationFrame?.bind(window) || clearTimeout;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.ResizeObserver = globalThis.ResizeObserver;
window.comfyAPI = { app: { app: { registerExtension() {} } }, api: { api: { api_base: "/" } } };
globalThis.URL.createObjectURL = () => "blob:mock";
globalThis.URL.revokeObjectURL = () => {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, label) {
    for (let i = 0; i < 400; i++) {
        if (cond()) return;
        await sleep(5);
    }
    throw new Error("waitFor timeout: " + label);
}
let n = 0;
const ok = (m) => { n++; console.log("  ✓ " + m); };

/* ─── 1. i18n : capture AVANT l'import d'aih_strings.js ────────────────── */
console.log("1. i18n FR/EN");
await import("./aih_i18n.js");
const I18n = window.AIH.I18n;
I18n.setLocale("fr");
const dictionaries = {};
const origAddDict = I18n.addDict.bind(I18n);
I18n.addDict = (lang, entries) => {
    dictionaries[lang] = Object.assign(dictionaries[lang] || {}, entries);
    return origAddDict(lang, entries);
};
await import("./aih_strings.js");

// Aucune clé d'auth résiduelle.
for (const lang of ["fr", "en"]) {
    const keys = Object.keys(dictionaries[lang] || {});
    const leftover = keys.filter((k) => /^(auth\.|settings\.(security|change)|term\.authRequired|bl\.sessionRequired|mma\.(sessionRequired|authCancelled|authRefused))/.test(k));
    assert.deepStrictEqual(leftover, [], `clés d'auth résiduelles en ${lang.toUpperCase()} : ${leftover.join(", ")}`);
}
// Les clés d'upload légitimes restent présentes FR/EN + parité stricte.
for (const key of ["mma.chunkFailed", "mma.finalizationFailed", "mma.uploadErrorTitle", "mma.unknownUploadError"]) {
    assert.ok(dictionaries.fr && key in dictionaries.fr, `clé ${key} absente en FR`);
    assert.ok(dictionaries.en && key in dictionaries.en, `clé ${key} absente en EN`);
}
{
    const frKeys = Object.keys(dictionaries.fr || {});
    const enKeys = Object.keys(dictionaries.en || {});
    const onlyFr = frKeys.filter((k) => !(k in (dictionaries.en || {})));
    const onlyEn = enKeys.filter((k) => !(k in (dictionaries.fr || {})));
    assert.deepStrictEqual(onlyFr, [], `clés FR absentes en EN : ${onlyFr.join(", ")}`);
    assert.deepStrictEqual(onlyEn, [], `clés EN absentes en FR : ${onlyEn.join(", ")}`);
}
ok("aucune clé d'auth résiduelle + parité FR/EN stricte");

/* ─── 2. Modules + réseau stubé (aucune route d'auth) ──────────────────── */
console.log("2. Aucune invite, aucune route d'auth");
const actionsMod = await import("./model_manager/model_manager_actions.js");
const { addFilesToUploadQueue } = actionsMod;

// Aucune invite de mot de passe ne doit JAMAIS s'ouvrir.
let dialogOpened = 0;
window.AIH.Dialog = { open() { dialogOpened++; return { close() {} }; } };

const askCalls = [];
window.AIH.ask = (opts) => { askCalls.push(opts); return Promise.resolve(true); };
globalThis.AIH = window.AIH;

const CHUNK_401_BODY = { success: false, error: "Authentication required." };
const calls = { chunk: [], finalize: [], auth: [] };

function jsonResponse(status, data) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

// Statut serveur simulé : 200 direct, OU une erreur 409 avec message réel.
let finalizeStatus = 200;
let finalizeBody = { status: "ok", message: "Finalization started." };

globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    const method = init.method || "GET";
    if (path.includes("/holaf/auth")) {
        calls.auth.push({ path, method });
        return jsonResponse(200, { success: true });
    }
    if (path.includes("/holaf/models/upload-chunk")) {
        calls.chunk.push({ path, method });
        return jsonResponse(200, { status: "ok", message: "Chunk received." });
    }
    if (path.includes("/holaf/models/finalize-upload")) {
        calls.finalize.push({ path, method });
        return jsonResponse(finalizeStatus, finalizeBody);
    }
    throw new Error("unexpected fetch: " + path);
};

function makeManager() {
    return {
        UPLOAD_CHUNK_SIZE: 5 * 1024 * 1024,
        MAX_CONCURRENT_UPLOADS: 1,
        MAX_CONCURRENT_CHUNKS: 4,
        uploadQueue: [],
        activeUploads: 0,
        isUploading: false,
        refreshAfterUpload: false,
        uploadStats: { history: [], currentSpeed: 0, totalBytes: 0, totalSentBytes: 0 },
        statusUpdateRaf: null,
        updateActionButtonsState() {},
        updateStatusBarText() {},
        filterModels() {},
    };
}

function enqueueFile(manager, name = "model.safetensors", size = 1024) {
    const file = new window.File([new Uint8Array(size)], name, { type: "application/octet-stream" });
    manager.uploadDialog = {
        fileInput: { files: [file], value: "" },
        destTypeSelect: { value: "checkpoints" },
        subfolderInput: { value: "" },
        dialogEl: { style: {} },
        fileListEl: { style: {} },
        statusMessage: { textContent: "" },
    };
    addFilesToUploadQueue(manager);
    return file;
}

async function waitForJob(manager, index = 0) {
    await waitFor(() => {
        const job = manager.uploadQueue[index];
        return job && (job.status === "done" || job.status === "error");
    }, `job ${index} terminé (status=${manager.uploadQueue[index] && manager.uploadQueue[index].status})`);
    return manager.uploadQueue[index];
}

/* ════ 3. Upload SANS cookie : aucun 401, aucune invite ═════════════════ */
console.log("3. Upload sans cookie → réussite directe, zéro invite");
{
    calls.chunk.length = 0;
    calls.finalize.length = 0;
    calls.auth.length = 0;
    askCalls.length = 0;
    finalizeStatus = 200;
    finalizeBody = { status: "ok", message: "Finalization started." };
    const manager = makeManager();
    const file = enqueueFile(manager);
    const job = await waitForJob(manager);
    assert.strictEqual(job.status, "done",
        `job attendu 'done', obtenu '${job.status}' (message : ${job.errorMessage || "-"})`);
    assert.strictEqual(dialogOpened, 0, "AUCUNE invite de mot de passe ne doit s'ouvrir");
    assert.strictEqual(calls.auth.length, 0, "AUCUNE requête vers /holaf/auth/*");
    assert.strictEqual(calls.chunk.length, 1, "un seul envoi de chunk (aucun retry d'auth)");
    assert.strictEqual(calls.finalize.length, 1, "une finalisation");
    assert.strictEqual(job.sentBytes, file.size, "tous les octets envoyés");
    assert.strictEqual(askCalls.length, 0, "aucune erreur annoncée quand l'upload réussit");
    ok("upload terminé sans cookie ni invite (routes /holaf/models/* non gardées)");
}

/* ════ 4. Vrai message serveur conservé (409) ═══════════════════════════ */
console.log("4. Le message d'erreur RÉEL du serveur est affiché");
{
    calls.chunk.length = 0;
    calls.finalize.length = 0;
    calls.auth.length = 0;
    askCalls.length = 0;
    finalizeStatus = 409;
    finalizeBody = { status: "error", message: "File already exists." };
    const manager = makeManager();
    enqueueFile(manager, "duplicate.safetensors");
    const job = await waitForJob(manager);
    assert.strictEqual(job.status, "error", "le 409 doit marquer le job en erreur");
    assert.strictEqual(job.errorMessage, "File already exists.",
        `message serveur attendu, obtenu « ${job.errorMessage} »`);
    assert.ok(askCalls.length >= 1, "l'erreur est annoncée à l'utilisateur (reportUploadErrors)");
    assert.ok(askCalls.some((c) => String(c.message).includes("File already exists.")),
        "le message d'erreur réel est remonté dans le dialogue");
    assert.strictEqual(dialogOpened, 0, "aucune invite d'auth sur une erreur métier");
    assert.strictEqual(calls.auth.length, 0, "aucune requête d'auth");
    ok("message serveur réel conservé (jamais un échec muet ni un 401 brut)");
}

/* ════ 5. Statique : plus aucune dépendance d'auth ══════════════════════ */
console.log("5. Branchement statique (aucune auth)");
{
    const src = readFileSync(new URL("./model_manager/model_manager_actions.js", import.meta.url), "utf8");
    assert.ok(!src.includes("holaf_auth.js"), "le module ne doit plus importer holaf_auth.js");
    assert.ok(!src.includes("ensureAuthenticated"), "plus d'appel ensureAuthenticated");
    assert.ok(!src.includes("postAuthenticated"), "plus de wrapper postAuthenticated");
    assert.ok(!src.includes("/holaf/auth"), "aucune route d'auth appelée");
    assert.ok(!/type\s*=\s*"password"/.test(src), "aucun champ mot de passe");
    assert.ok(src.includes("HolafFetch.post"), "les requêtes passent par HolafFetch en direct");
    ok("model_manager_actions.js : HolafFetch direct, zéro dépendance d'auth");
}

console.log(`\n✅ test_model_manager_upload : ${n} groupes PASSENT`);
