// Upload de modèles du Model Manager (js/model_manager/model_manager_actions.js)
// et INVITE D'AUTHENTIFICATION PARTAGÉE — jsdom + fetch stubé, AUCUN réseau réel.
// Usage : node js/test_model_manager_auth_upload.mjs
//
// Contexte (bug réel corrigé) : les routes /holaf/models/upload-chunk et
// /holaf/models/finalize-upload sont protégées par mot de passe
// (@holaf_auth.require_auth) mais le front de l'upload ne déclenchait JAMAIS
// l'invite partagée (HolafAuth) : un utilisateur non authentifié recevait un
// 401 muet affiché comme « Échec du segment N », sans invite ni retry.
//
// Ce test verrouille :
//   1. session absente → l'invite PARTAGÉE s'ouvre AVANT tout envoi, puis
//      l'upload se fait (chunk + finalize 200) et le job passe 'done' ;
//   2. invite annulée → AUCUN envoi, message d'auth explicite, état non bloqué ;
//   3. session déjà valide → AUCUNE invite (aucune régression UX) ;
//   4. 401 tardif (session invalidée en cours d'upload) → invite UNE fois,
//      requête rejouée une fois, upload terminé ;
//   5. i18n FR/EN : nouvelles clés mma.auth* présentes + parité stricte ;
//   6. statique : le module importe l'invite partagée (aucun login recréé).
//
// jsdom est résolu par le loader partagé ; introuvable = SKIP bruyant (exit 2).
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_model_manager_auth_upload");

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

const NEW_KEYS = ["mma.sessionRequired", "mma.authCancelled", "mma.authRefused"];
for (const key of NEW_KEYS) {
    assert.ok(dictionaries.fr && key in dictionaries.fr, `clé ${key} absente en FR`);
    assert.ok(dictionaries.en && key in dictionaries.en, `clé ${key} absente en EN`);
    assert.notStrictEqual(dictionaries.fr[key], key, `FR ${key} non traduite`);
    assert.notStrictEqual(dictionaries.en[key], key, `EN ${key} non traduite`);
}
{
    const frKeys = Object.keys(dictionaries.fr || {});
    const enKeys = Object.keys(dictionaries.en || {});
    const onlyFr = frKeys.filter((k) => !(k in (dictionaries.en || {})));
    const onlyEn = enKeys.filter((k) => !(k in (dictionaries.fr || {})));
    assert.deepStrictEqual(onlyFr, [], `clés FR absentes en EN : ${onlyFr.join(", ")}`);
    assert.deepStrictEqual(onlyEn, [], `clés EN absentes en FR : ${onlyEn.join(", ")}`);
}
ok(`clés ${NEW_KEYS.join(", ")} présentes FR/EN + parité stricte`);

/* ─── 2. Modules + réseau stubé ────────────────────────────────────────── */
console.log("2. Invite partagée branchée sur l'upload");
const authMod = await import("./holaf_auth.js");
const HolafAuth = window.HolafAuth;
assert.ok(HolafAuth, "window.HolafAuth exposé");

const actionsMod = await import("./model_manager/model_manager_actions.js");
const { addFilesToUploadQueue, processUploadQueue } = actionsMod;

// Stub de AIH.ask (dialogue d'erreur) : on veut vérifier CE QUI EST ANNONCÉ à
// l'utilisateur, sans ouvrir de vrai dialogue dans le banc de test.
const askCalls = [];
window.AIH.ask = (opts) => { askCalls.push(opts); return Promise.resolve(true); };
// En navigateur window === globalThis ; sous Node, le global AIH doit exister
// explicitement pour les modules qui appellent AIH.ask (reportUploadErrors).
globalThis.AIH = window.AIH;

// Stub du dialogue partagé : capture les invites, simule acceptation/annulation
// en pilotant le vrai code de HolafAuth (guard + _onResolve).
const dialogCalls = [];
let dialogOutcome = "accept";
const PASSWORD = "password-8";
window.AIH.Dialog = {
    open(opts) {
        dialogCalls.push(opts);
        const body = document.createElement("div");
        document.body.appendChild(body);
        opts.content(body);
        const inputs = body.querySelectorAll("input");
        (async () => {
            if (dialogOutcome === "cancel") {
                opts._onResolve("cancel");
                return;
            }
            for (const input of inputs) input.value = PASSWORD;
            const accepted = await opts.guard("submit");
            if (accepted) opts._onResolve("submit");
        })();
        return { close() {} };
    },
};

const CHUNK_401_BODY = { success: false, error: "Authentication required." };
let sessionValid = false; // état serveur simulé (cookie holaf_session absent/valide)
const calls = { chunk: [], finalize: [], status: [], login: [] };

function jsonResponse(status, data) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    const method = init.method || "GET";
    if (path.includes("/holaf/auth/status")) {
        calls.status.push({ path, method });
        return jsonResponse(200, {
            authenticated: sessionValid,
            password_configured: true,
            min_password_length: 8,
        });
    }
    if (path.includes("/holaf/auth/login")) {
        calls.login.push({ path, method });
        sessionValid = true; // login réussi → cookie de session côté navigateur
        return jsonResponse(200, { success: true });
    }
    if (path.includes("/holaf/models/upload-chunk")) {
        calls.chunk.push({ path, method });
        if (!sessionValid) return jsonResponse(401, CHUNK_401_BODY);
        return jsonResponse(200, { status: "ok", message: "Chunk received." });
    }
    if (path.includes("/holaf/models/finalize-upload")) {
        calls.finalize.push({ path, method });
        if (!sessionValid) return jsonResponse(401, CHUNK_401_BODY);
        return jsonResponse(200, { status: "ok", message: "Finalization started." });
    }
    throw new Error("unexpected fetch: " + path);
};

/* ─── Helpers manager/upload ───────────────────────────────────────────── */
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

function resetCounters() {
    dialogCalls.length = 0;
    askCalls.length = 0;
    calls.chunk.length = 0;
    calls.finalize.length = 0;
    calls.status.length = 0;
    calls.login.length = 0;
}

/* ════ 3. Session absente : invite AVANT envoi puis upload réussi ═══════ */
console.log("3. Session absente → invite partagée → upload");
authMod.resetAuthState();
resetCounters();
sessionValid = false;
dialogOutcome = "accept";
{
    const manager = makeManager();
    const file = enqueueFile(manager);
    const job = await waitForJob(manager);
    assert.strictEqual(job.status, "done",
        `job attendu 'done', obtenu '${job.status}' (message : ${job.errorMessage || "-"})`);
    assert.strictEqual(dialogCalls.length, 1, "l'invite partagée doit s'ouvrir une fois");
    assert.strictEqual(calls.login.length, 1, "un login via l'invite");
    assert.strictEqual(calls.chunk.length, 1, "un seul envoi de chunk (le cookie est posé AVANT)");
    assert.strictEqual(calls.finalize.length, 1, "une finalisation");
    assert.strictEqual(calls.status.length, 1, "le statut est interrogé une fois (avant l'invite)");
    assert.strictEqual(HolafAuth.isAuthenticated(), true, "session mémorisée après login");
    assert.strictEqual(job.sentBytes, file.size, "tous les octets envoyés");
    assert.strictEqual(askCalls.length, 0, "aucune erreur annoncée quand l'upload réussit");
    ok("401 évité, invite AVANT envoi, upload terminé (chunk + finalize 200)");
}

/* ════ 4. Invite annulée : aucun envoi + message d'auth explicite ════════ */
console.log("4. Invite annulée → message explicite, aucun envoi");
authMod.resetAuthState();
resetCounters();
sessionValid = false;
dialogOutcome = "cancel";
{
    const manager = makeManager();
    enqueueFile(manager);
    const job = await waitForJob(manager);
    assert.strictEqual(job.status, "error", "upload bloqué si l'utilisateur annule");
    assert.strictEqual(calls.chunk.length, 0, "AUCUN chunk envoyé sans session");
    assert.strictEqual(calls.finalize.length, 0, "AUCUNE finalisation sans session");
    assert.strictEqual(dialogCalls.length, 1, "une seule invite");
    assert.ok(
        job.errorMessage === I18n.t("mma.authCancelled"),
        `message attendu « ${I18n.t("mma.authCancelled")} », obtenu « ${job.errorMessage} »`
    );
    assert.strictEqual(manager.activeUploads, 0, "compteur de transferts remis à zéro");
    assert.strictEqual(manager.isUploading, false, "état d'upload libéré (pas de blocage)");
    assert.strictEqual(askCalls.length, 1, "l'erreur est ANNONCÉE à l'utilisateur (pas seulement en console)");
    assert.strictEqual(askCalls[0].message, I18n.t("mma.authCancelled"), "message d'auth annoncée");
    ok("annulation : message d'authentification clair, file d'upload non bloquée");
}

/* ════ 5. Session déjà valide : aucune invite (non-régression) ═══════════ */
console.log("5. Session valide → aucune invite");
authMod.resetAuthState();
resetCounters();
sessionValid = true;
dialogOutcome = "accept";
{
    const manager = makeManager();
    enqueueFile(manager);
    const job = await waitForJob(manager);
    assert.strictEqual(job.status, "done", `job attendu 'done', obtenu '${job.status}'`);
    assert.strictEqual(dialogCalls.length, 0, "aucune invite quand le cookie est valide");
    assert.strictEqual(calls.login.length, 0, "aucun login nécessaire");
    assert.strictEqual(calls.chunk.length, 1, "un envoi de chunk");
    assert.strictEqual(calls.finalize.length, 1, "une finalisation");
    ok("cookie valide : upload direct, zéro invite (pas de régression UX)");
}

/* ════ 6. 401 tardif : invite UNE fois + un seul retry ═══════════════════ */
console.log("6. 401 tardif (session invalidée en cours d'upload)");
authMod.resetAuthState();
resetCounters();
sessionValid = true;
dialogOutcome = "accept";
{
    assert.strictEqual(await authMod.ensureAuthenticated("initial"), true, "session initiale");
    sessionValid = false; // le serveur a invalidé la session (logout autre onglet…)
    const manager = makeManager();
    enqueueFile(manager);
    const job = await waitForJob(manager);
    assert.strictEqual(job.status, "done",
        `job attendu 'done', obtenu '${job.status}' (message : ${job.errorMessage || "-"})`);
    assert.strictEqual(calls.chunk.length, 2, "chunk rejoué UNE fois après le 401 tardif");
    assert.strictEqual(dialogCalls.length, 1, "invite partagée une seule fois");
    assert.strictEqual(calls.finalize.length, 1, "finalisation après ré-authentification");
    ok("401 tardif → invite partagée → retry, upload terminé");
}

/* ════ 7. Statique : branchement de l'invite partagée ════════════════════ */
console.log("7. Branchement statique");
{
    const src = readFileSync(new URL("./model_manager/model_manager_actions.js", import.meta.url), "utf8");
    assert.ok(src.includes("holaf_auth.js"), "le module importe holaf_auth.js");
    assert.ok(src.includes("ensureAuthenticated"), "le module appelle ensureAuthenticated");
    assert.ok(!src.includes("/holaf/auth/login"), "aucun login recréé localement");
    assert.ok(!/type\s*=\s*"password"/.test(src), "aucun champ mot de passe créé localement");
    ok("model_manager_actions.js délègue à l'invite partagée (0 duplication)");
}

console.log(`\n✅ test_model_manager_auth_upload : ${n} groupes PASSENT`);
