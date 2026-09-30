// ─────────────────────────────────────────────────────────────────────────
// RÉGRESSION — « Erreur: timeout » à la copie/upload des GROS modèles.
//
// Bug réel (capture utilisateur) : dans l'onglet 📤 Partager de
// js/aih_workflow_share.js, l'upload d'un modèle passait par
//   HolafFetch.request('/api/aih/models/upload', { method:'POST', body })
// SANS option `timeout`. HolafFetch applique alors son défaut de 30 s
// (DEFAULT_TIMEOUT = 30000, js/vendor/holaf/holaf-fetch.js) → l'AbortController
// coupait le transfert en plein vol dès que l'envoi dépassait ~30 s. Résultat :
//   - petits fichiers OK (≈240 Mo à ~10 Mo/s = 24 s < 30 s) ;
//   - gros fichiers KO (13 Go, 4,6 Go…) avec « Erreur: timeout » ;
//   - toutes les lignes en échec à ~30,0 s (le titre « Upload terminé (N, 30.0s) »).
//
// Ce test reproduit le mécanisme à constantes de temps RÉDUITES (défaut global
// 120 ms ≙ 30 s ; réponse lente 300 ms ≙ transfert > seuil) puis vérifie :
//   1. la sonde : un appel SANS timeout explicite est bien aborté avec le
//      message exact « timeout » (prouve que le harnais reproduit le bug) ;
//   2. l'upload long de l'onglet Partager aboutit (aucune « Erreur: timeout »,
//      statut ✅, signal jamais aborté) — le correctif `timeout: 0` ;
//   3. un item réellement en échec n'affiche AUCUN débit inventé (le bug
//      « 449.1 MB/s » venait de size/elapsed calculé même en échec) et affiche
//      le message d'erreur réel ;
//   4. verrou statique : chaque appel upload/download long porte `timeout: 0`
//      (aih_workflow_share.js ET 02_aih_model_browser.js).
//
// Usage : node js/test_aih_workflow_share_upload_timeout.mjs
//   jsdom résolu par js/test_helpers/jsdom_loader.mjs (introuvable = SKIP
//   bruyant, exit 2 — jamais compté PASS).
// Code de sortie : 0 = PASS, 2 = SKIP, 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_aih_workflow_share_upload_timeout");

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

// Grappe ComfyUI minimale : un workflow actif avec un checkpoint.
window.app = {
    graph: {
        serialize: () => ({
            nodes: [{ id: 1, type: "CheckpointLoaderSimple", widgets_values: ["model.safetensors"] }],
            links: [],
            extra: { title: "Mon workflow" },
        }),
        _nodes: [],
    },
    ui: { title: "Mon workflow" },
    workflowName: "Mon workflow",
};

const SERVER_URL = "https://aih.test";
const MODEL_SIZE = 13 * 1024 * 1024 * 1024; // ≈13 Go (taille réelle signalée)

// ── Faux serveur local (les routes /api/aih/* sont same-origin) ──────────
let uploadDelayMs = 0;
let uploadFail = false;
const uploadCalls = [];

function jsonResponse(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
        json: async () => data,
        text: async () => JSON.stringify(data),
    };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Réponse différée qui HONORE le signal d'abort (comme le vrai fetch) : sans
// cela, un timeout ne se traduirait pas par un rejet AbortError.
function makeAbortError() {
    const e = new Error("The operation was aborted.");
    e.name = "AbortError";
    return e;
}
function delayedJson(ms, data, status, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) { reject(makeAbortError()); return; }
        const timer = setTimeout(() => resolve(jsonResponse(data, status)), ms);
        if (signal) {
            signal.addEventListener("abort", () => { clearTimeout(timer); reject(makeAbortError()); }, { once: true });
        }
    });
}

window.fetch = globalThis.fetch = async (url, init) => {
    const u = String(url);
    const signal = init && init.signal;
    if (u.includes("/api/aih/models/upload/progress")) {
        return jsonResponse({ percent: 40, speed_mbs: 12.5 });
    }
    if (u.includes("/api/aih/models/upload")) {
        uploadCalls.push({ url: u, signal });
        if (uploadFail) return jsonResponse({ success: false, error: "boom" }, 400);
        return delayedJson(uploadDelayMs, { success: true, upload_id: "u1", file_path: "model.safetensors" }, 200, signal);
    }
    if (u.includes("/api/aih/models/download")) {
        return jsonResponse({ success: true, upload_id: "u1" });
    }
    if (u.includes("/api/aih/models/list")) {
        return jsonResponse({
            checkpoints: [{ name: "model.safetensors", path: "/models/model.safetensors", size: MODEL_SIZE }],
        });
    }
    if (u.includes("/api/aih/custom-nodes")) return jsonResponse({ nodes: [] });
    if (/\/api\/workflows\?/.test(u)) return jsonResponse({ total: 0, page: 1, limit: 20, items: [] });
    if (/\/api\/workflows$/.test(u)) return jsonResponse({ id: 1, version: 1 });
    return jsonResponse({ error: "not found" }, 404);
};

// ── Modules ──────────────────────────────────────────────────────────────
await import("./aih_i18n.js");
await import("./aih_strings.js");
await import("./aih_dialog.js");
window.AIH.I18n.setLocale("fr");

window.aihShowAlert = () => Promise.resolve();
window.aihShowConfirm = () => Promise.resolve(true);
for (const key of ["aihOpenModalV2", "aihShowAlert", "aihShowConfirm", "AIH"]) {
    if (window[key] !== undefined) globalThis[key] = window[key];
}

const { HolafFetch } = await import("./vendor/holaf/holaf-fetch.js");
await import("./aih_workflow_share.js");

// Constante de temps RÉDUITE : le défaut global de 30 s est remplacé par 120 ms
// (même mécanisme AbortController ; permet un test déterministe et rapide).
const SCALED_DEFAULT_MS = 120;
const SLOW_TRANSFER_MS = 300; // > SCALED_DEFAULT_MS → doit être aborté SANS le correctif
HolafFetch.configure({ timeout: SCALED_DEFAULT_MS });

window.localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: SERVER_URL, apiKey: "k" }));

// ── Helpers DOM ──────────────────────────────────────────────────────────
const waitFor = async (cond, label, tries = 400) => {
    for (let i = 0; i < tries; i++) {
        if (cond()) return;
        await sleep(5);
    }
    throw new Error("waitFor timeout: " + label);
};
const uploadRows = () => Array.from(window.document.querySelectorAll("#aih-upload-body > div"))
    .filter((r) => r.querySelectorAll("span").length >= 3); // exclut le pied (bouton Fermer)
const statusOf = (row) => row.querySelectorAll("span")[0].textContent;
const speedOf = (row) => row.querySelectorAll("span")[2].textContent;

// Déclenche le VRAI chemin de publication (bouton de l'onglet Partager) et
// attend la fin du panneau d'upload (« Upload terminé (…) »).
async function publish({ delayMs, fail }) {
    uploadDelayMs = delayMs;
    uploadFail = fail;
    uploadCalls.length = 0;
    window.document.body.innerHTML = "";
    window.openWorkflowManager();
    await waitFor(() => window.document.getElementById("wf-publish-btn"), "bouton publier rendu");
    window.document.getElementById("wf-publish-btn").click();
    await waitFor(() => /Upload terminé/.test(window.document.body.textContent), "panneau d'upload terminé");
}

let n = 0;
const ok = (m) => { n++; console.log("  ✓ " + m); };

/* ══ 1. SONDE : sans timeout explicite, un transfert lent est aborté ══════ */
console.log("1. Sonde — le harnais reproduit bien l'abort « timeout »");
{
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => delayedJson(SLOW_TRANSFER_MS, { ok: true }, 200, init && init.signal);
    let err = null;
    try {
        await HolafFetch.request("http://localhost/slow-forever", {});
    } catch (e) {
        err = e;
    } finally {
        globalThis.fetch = prevFetch;
    }
    assert.ok(err, "un transfert lent SANS timeout explicite doit être aborté (sinon le harnais ne prouve rien)");
    assert.strictEqual(err.message, "timeout",
        `message d'abort attendu « timeout », obtenu « ${err.message} »`);
    ok("défaut global actif → abort au message exact « timeout » (≙ 30 s en production)");
}

/* ══ 2. CORRECTIF : l'upload long aboutit (plus d'« Erreur: timeout ») ══ */
console.log("2. Upload long de l'onglet Partager → aboutit");
{
    await publish({ delayMs: SLOW_TRANSFER_MS, fail: false });
    const bodyTxt = window.document.body.textContent;
    assert.ok(!bodyTxt.includes("Erreur: timeout"),
        "AUCUNE « Erreur: timeout » ne doit apparaître : le transfert long doit aboutir");
    assert.strictEqual(uploadCalls.length, 1, "un seul upload appelé");
    assert.strictEqual(statusOf(uploadRows()[0]), "✅", "la ligne d'upload est marquée réussie");
    assert.ok(uploadCalls[0].signal && uploadCalls[0].signal.aborted === false,
        "le signal de l'upload long n'a JAMAIS été aborté (timeout: 0)");
    ok("transfert > seuil : succès, aucun abort (correctif timeout: 0 effectif)");
}

/* ══ 3. ÉCHEC RÉEL : aucun débit inventé + message d'erreur réel ════════ */
console.log("3. Item échoué → pas de débit absurde, erreur réelle affichée");
{
    await publish({ delayMs: 0, fail: true });
    const rows = uploadRows();
    assert.strictEqual(rows.length, 1, "une ligne d'upload");
    assert.strictEqual(statusOf(rows[0]), "❌", "la ligne est marquée en échec");
    assert.strictEqual(speedOf(rows[0]), "—",
        `aucun débit ne doit être inventé pour un item échoué (obtenu « ${speedOf(rows[0])} »)`);
    assert.ok(!/MB\/s/.test(speedOf(rows[0])), "aucune vitesse type « 449.1 MB/s » sur un échec");
    assert.ok(window.document.body.textContent.includes("Erreur: boom"),
        "le message d'erreur RÉEL du serveur est affiché");
    ok("échec : débit « — » (fini le size/elapsed absurde) + erreur serveur visible");
}

/* ══ 4. VERROU STATIQUE : chaque transfert long porte timeout: 0 ════════ */
console.log("4. Verrou statique sur les appels de transfert longs");
{
    const checkFile = (rel, expected) => {
        const src = readFileSync(new URL(rel, import.meta.url), "utf8");
        const re = /\/api\/aih\/models\/(?:upload|download)'/g;
        let m, seen = 0;
        while ((m = re.exec(src))) {
            const tail = src.slice(m.index, m.index + 900);
            assert.ok(/timeout:\s*0/.test(tail),
                `${rel}: appel ${m[0]} sans timeout:0 → transfert long à nouveau plafonné à 30 s`);
            seen++;
        }
        assert.strictEqual(seen, expected, `${rel}: ${expected} appels upload/download longs attendus, ${seen} trouvés`);
    };
    checkFile("./aih_workflow_share.js", 3);
    // 02_aih_model_browser.js : 2 uploads + 1 download. Les 3 appels download
    // (downloadFile, downloadRemoteModel, retryDownload) ont été CENTRALISÉS
    // dans _downloadRequest (progression live + annulation) : un seul site
    // d'appel, toujours avec timeout: 0 — l'invariant par appel est inchangé.
    checkFile("./02_aih_model_browser.js", 3);
    ok("aih_workflow_share.js (3) + 02_aih_model_browser.js (3) : timeout: 0 sur chaque transfert long");
}

HolafFetch.configure({ timeout: null }); // restaure le défaut (hygiène)
console.log(`\n✅ test_aih_workflow_share_upload_timeout : ${n} groupes PASSENT`);
process.exit(0);
