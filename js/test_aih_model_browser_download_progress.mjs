// Test d'INTÉGRATION du téléchargement de modèle du Model Browser
// (02_aih_model_browser.js) — jsdom + fetch stubé, AUCUN appel réseau réel.
// Usage : node js/test_aih_model_browser_download_progress.mjs
//
// Contexte (signalement « le téléchargement des modèles ne se fait pas et ça
// fait même tout planter ») : le transfert d'un modèle de 13,5 Go dure des
// dizaines de minutes. Avant ce correctif, l'UI restait à 0 % (aucun appel à
// /api/aih/models/download/progress) et AUCUNE annulation n'était possible.
//
// Verrouille :
//   1. i18n FR/EN des nouvelles clés + parité stricte des dictionnaires ;
//   2. le download démarre bien sur /api/aih/models/download (timeout: 0) ;
//   3. la progression LIVE : le pourcentage et la barre suivent
//      /api/aih/models/download/progress?upload_id=… ;
//   4. le bouton ✕ appelle /api/aih/models/download/cancel avec l'upload_id ;
//   5. le polling S'ARRÊTE une fois la requête réglée (pas d'empilement) ;
//   6. CONTRÔLE NÉGATIF : une réponse {cancelled: true} affiche « annulé » et
//      masque le bouton — jamais une « erreur » brute ni une barre bloquée.
//
// jsdom est résolu par le loader partagé ; introuvable = SKIP bruyant (exit 2).
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_aih_model_browser_download_progress");

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
globalThis.requestAnimationFrame = window.requestAnimationFrame?.bind(window) || ((cb) => setTimeout(cb, 0));
globalThis.cancelAnimationFrame = window.cancelAnimationFrame?.bind(window) || clearTimeout;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.ResizeObserver = globalThis.ResizeObserver;
window.comfyAPI = { app: { app: { registerExtension() {} } }, api: { api: { api_base: "/" } } };
globalThis.URL.createObjectURL = () => "blob:mock";
globalThis.URL.revokeObjectURL = () => {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

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

for (const key of ["mb.cancelDownload", "mb.downloadCancelled", "mb.downloadPreparing"]) {
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
ok("clés progression/annulation FR+EN + parité stricte");

/* ─── 2. Fetch factice : traçage des trois routes du download ──────────── */
const calls = { download: [], progress: [], cancel: [], cancelBodies: [] };
let pendingDownload = null;   // {resolve(response)} — résolu manuellement
let progressPct = 0;
let progressRecv = 0;

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
    });
}

globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("/auth/me")) return jsonResponse({ role: "user" });
    if (u.includes("/models/local")) return jsonResponse({ items: {}, total: 0 });
    if (u.includes("/models/remote")) {
        return jsonResponse({
            items: [{ name: "Krea2-Turbo-int8-ConvRot.safetensors", id: "uid-1", type: "unet", size: 13500000000 }],
            total: 1, page: 1, limit: 50,
        });
    }
    if (u.includes("/models/download/progress")) {
        calls.progress.push(u);
        return jsonResponse({
            percent: progressPct,
            speed_mbs: progressRecv > 0 ? 12.5 : 0,
            bytes_recv: progressRecv,
            bytes_total: 13500000000,
        });
    }
    if (u.includes("/models/download/cancel")) {
        calls.cancel.push(u);
        try { calls.cancelBodies.push(JSON.parse(opts.body)); } catch (_) { calls.cancelBodies.push(null); }
        return jsonResponse({ ok: true });
    }
    if (u.includes("/models/download")) {
        calls.download.push(JSON.parse(opts.body));
        return new Promise((resolve) => { pendingDownload = resolve; });
    }
    return jsonResponse({});
};
window.fetch = globalThis.fetch;

window.localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "https://aih.example.com", apiKey: "tok" }));

await import("./02_aih_model_browser.js");
for (const k of ["aihOpenModalV2", "aihShowAlert", "aihShowConfirm", "aihToast", "showConflictModal", "HolafModal"]) {
    if (typeof window[k] !== "undefined") globalThis[k] = window[k];
}
assert.strictEqual(typeof window.openModelBrowser, "function", "openModelBrowser exposé");

/* ─── 3. Ouverture + lancement d'un download (double-clic) ─────────────── */
console.log("2. Ouverture + download");
window.openModelBrowser();
await sleep(150);

const remoteItems = () => document.querySelectorAll("#mb-remote-list .mb-item");
assert.strictEqual(remoteItems().length, 1, "un modèle distant listé");
I18n.setLocale("en");

remoteItems()[0].dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
await sleep(80);

assert.strictEqual(calls.download.length, 1, "le download est parti sur /api/aih/models/download");
assert.strictEqual(calls.download[0].upload_id, "uid-1", "upload_id transmis");
const row = document.querySelector(".mb-progress-row");
assert.ok(row, "une ligne de progression est affichée");
const cancelBtn = document.querySelector(".mb-progress-cancel");
assert.ok(cancelBtn, "un bouton d'annulation est présent");
assert.notStrictEqual(cancelBtn.style.display, "none", "bouton d'annulation visible pendant le transfert");
ok("double-clic : POST /models/download (timeout 0) + ligne de progression + bouton ✕");

/* ─── 4. Progression live (polling) ────────────────────────────────────── */
console.log("3. Progression live");
{
    // 1er sondage : AUCUN octet reçu (le backend précharge 13,5 Go du stockage
    // vers son temp) → l'UI doit dire « préparation côté serveur ».
    progressPct = 0;
    progressRecv = 0;
    await sleep(950); // > DOWNLOAD_POLL_MS (800 ms)
    assert.ok(calls.progress.length >= 1, "la progression est interrogée pendant le transfert");
    assert.ok(calls.progress[0].includes("upload_id=uid-1"), "progression ciblée par upload_id");
    assert.ok(/preparing on server/i.test(row.querySelector(".mb-progress-name").textContent),
        "préchargement serveur annoncé (pas un 0 % muet)");

    // 2e sondage : les octets arrivent → pourcentage, barre et vitesse.
    progressPct = 37;
    progressRecv = 3000000000;
    await sleep(950);
    assert.strictEqual(row.querySelector(".mb-progress-fill").style.width, "37%", "barre mise à jour");
    assert.strictEqual(row.querySelector(".mb-progress-pct").textContent, "37%", "pourcentage affiché");
    assert.ok(/MB\/s/.test(row.querySelector(".mb-progress-name").textContent), "vitesse affichée");
}
ok(`progression live : ${calls.progress.length} sondage(s), préparation puis barre 37 % + vitesse`);

/* ─── 5. Annulation : POST /models/download/cancel ─────────────────────── */
console.log("4. Annulation");
cancelBtn.click();
await sleep(80);
assert.strictEqual(calls.cancel.length, 1, "l'annulation appelle /models/download/cancel");
assert.strictEqual(calls.cancelBodies[0].upload_id, "uid-1", "upload_id transmis à l'annulation");
ok("clic ✕ : POST /models/download/cancel {upload_id}");

/* ─── 6. Fin du transfert : barre 100 %, polling arrêté ────────────────── */
console.log("5. Fin + arrêt du polling");
const progressBefore = calls.progress.length;
pendingDownload(jsonResponse({ success: true, path: "/models/unet/Krea2.safetensors" }));
await sleep(120);
assert.strictEqual(row.querySelector(".mb-progress-fill").style.width, "100%", "barre terminée à 100 %");
assert.strictEqual(document.querySelector(".mb-progress-cancel").style.display, "none",
    "bouton masqué une fois le transfert réglé");
await sleep(1000);
assert.strictEqual(calls.progress.length, progressBefore,
    "le polling s'arrête (aucun appel après la fin : pas d'empilement)");
ok("fin : 100 %, bouton masqué, polling arrêté (aucun appel en rafale)");

/* ─── 7. CONTRÔLE NÉGATIF : réponse {cancelled:true} → message dédié ───── */
console.log("6. Contrôle négatif — annulation côté serveur");
I18n.setLocale("fr");
remoteItems()[0].dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
await sleep(80);
pendingDownload(jsonResponse({ success: false, cancelled: true, error: "Téléchargement annulé" }, 400));
await sleep(120);
{
    const rows = document.querySelectorAll(".mb-progress-row");
    const last = rows[rows.length - 1];
    const txt = last.querySelector(".mb-progress-name").textContent;
    assert.ok(/annul/i.test(txt), `message d'annulation attendu, obtenu « ${txt} »`);
    const btn = last.querySelector(".mb-progress-cancel");
    assert.strictEqual(btn.style.display, "none", "bouton masqué après annulation");
    assert.strictEqual(last.querySelector(".mb-progress-fill").style.width, "0%", "pas de fausse barre « terminé »");
}
ok("contrôle négatif : {cancelled:true} → « annulé », bouton masqué, pas de faux 100 %");

/* ─── 8. CONTRÔLE NÉGATIF : échec réel toujours visible ────────────────── */
console.log("7. Contrôle négatif — échec réel");
remoteItems()[0].dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
await sleep(80);
pendingDownload(jsonResponse({ success: false, error: "Modèle introuvable côté serveur (jamais uploadé ou supprimé)" }, 400));
await sleep(120);
{
    const rows = document.querySelectorAll(".mb-progress-row");
    const last = rows[rows.length - 1];
    const txt = last.querySelector(".mb-progress-name").textContent;
    assert.ok(/introuvable/i.test(txt), `message d'échec serveur visible, obtenu « ${txt} »`);
}
ok("contrôle négatif : échec serveur → message réel affiché (jamais masqué)");

console.log(`\n✅ test_aih_model_browser_download_progress : ${n} groupes PASSENT`);
