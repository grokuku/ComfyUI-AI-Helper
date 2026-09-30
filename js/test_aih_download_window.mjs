// Test d'INTÉGRATION de la fenêtre de progression dédiée des téléchargements
// de modèles (js/aih_download_window.js + js/02_aih_model_browser.js).
// jsdom + fetch stubé, AUCUN appel réseau réel (vrais modules).
// Usage : node js/test_aih_download_window.mjs
//
// Contexte (signalement utilisateur) : « le téléchargement de modèle est hyper
// lent... en plus j'ai aucune fenêtre pour suivre la progression ». La
// progression « en ligne » de la liste (mb-progress-row) existe mais est peu
// visible ; ce test verrouille la FENÊTRE dédiée exigée :
//   1. i18n FR/EN des clés mb.dlw* + parité stricte des dictionnaires ;
//   2. ouverture de la fenêtre au lancement d'un téléchargement UNITAIRE ;
//   3. une ligne par fichier : phase explicite (« Préparation côté serveur… »
//      sans octets, « Transfert » dès les premiers octets), %, octets/total,
//      débit MB/s, temps écoulé + ETA ;
//   4. bouton ✕ par ligne → POST /api/aih/models/download/cancel {upload_id} ;
//   5. progression GLOBALE N/M + état final « Téléchargement terminé » +
//      récapitulatif chiffré + bouton Fermer ;
//   6. LOT : une ligne par fichier, « En attente » AVANT le 1er transfert,
//      récap mixte (réussi/échec) ;
//   7. CONTRÔLES NÉGATIFS : annulation → récap « annulé » (pas un succès) ;
//      échec serveur → message visible + compteur échec.
//
// jsdom est résolu par le loader partagé ; introuvable = SKIP bruyant (exit 2).
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_aih_download_window");

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

const DLW_KEYS = [
    "mb.dlwTitle", "mb.dlwGlobal", "mb.dlwQueued", "mb.dlwPhasePreparing",
    "mb.dlwPhaseTransferring", "mb.dlwEta", "mb.dlwDoneTitle", "mb.dlwRecap",
];
for (const key of DLW_KEYS) {
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
ok("clés fenêtre (titre, phases, globale, ETA, récap) FR+EN + parité stricte");

/* ─── 2. Fetch factice : download / progress / cancel ──────────────────── */
const calls = { download: [], progress: [], cancel: [], cancelBodies: [] };
let pendingDownloads = [];
const progressByUid = {};

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
            items: [
                { name: "Krea2-Turbo-int8-ConvRot.safetensors", id: "uid-1", type: "unet", size: 13500000000 },
                { name: "clip_l.safetensors", id: "uid-2", type: "clip", size: 246000000 },
            ],
            total: 2, page: 1, limit: 50,
        });
    }
    if (u.includes("/models/download/progress")) {
        const m = /upload_id=([^&]+)/.exec(u);
        const uid = m ? decodeURIComponent(m[1]) : "";
        calls.progress.push(uid);
        return jsonResponse(progressByUid[uid] || {
            percent: 0, speed_mbs: 0, bytes_recv: 0, bytes_total: 0, phase: "preparing",
        });
    }
    if (u.includes("/models/download/cancel")) {
        calls.cancel.push(u);
        try { calls.cancelBodies.push(JSON.parse(opts.body)); } catch (_) { calls.cancelBodies.push(null); }
        return jsonResponse({ ok: true });
    }
    if (u.includes("/models/download")) {
        calls.download.push(JSON.parse(opts.body));
        return new Promise((resolve) => { pendingDownloads.push(resolve); });
    }
    return jsonResponse({});
};
window.fetch = globalThis.fetch;

function resolveNextDownload(data, status = 200) {
    assert.ok(pendingDownloads.length > 0, "aucun download en attente à résoudre");
    const resolve = pendingDownloads.shift();
    resolve(jsonResponse(data, status));
}

window.localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "https://aih.example.com", apiKey: "tok" }));

await import("./02_aih_model_browser.js");
for (const k of ["aihOpenModalV2", "aihShowAlert", "aihShowConfirm", "aihToast", "showConflictModal", "HolafModal"]) {
    if (typeof window[k] !== "undefined") globalThis[k] = window[k];
}
assert.strictEqual(typeof window.AIH.DownloadWindow, "object", "AIH.DownloadWindow exposé");
assert.strictEqual(typeof window.AIH.DownloadWindow.open, "function", "AIH.DownloadWindow.open exposé");

const winEl = () => document.querySelector("#aih-download-window");
const dlRows = () => Array.from(document.querySelectorAll("#aih-download-window .aih-dlw-row"));
const rowEl = (i) => dlRows()[i];
const phaseOf = (i) => rowEl(i).querySelector(".aih-dlw-phase").textContent;
const globalCount = () => document.querySelector("#aih-download-window .aih-dlw-count").textContent;
const finalEl = () => document.querySelector("#aih-download-window .aih-dlw-final");
const finalText = () => document.querySelector("#aih-download-window .aih-dlw-final-text").textContent;
const windowTitle = () => winEl().querySelector(".aih-dialog-title").textContent;

/* ─── 3. Ouverture + lancement d'un download UNITAIRE ──────────────────── */
console.log("2. Fenêtre ouverte au lancement (unitaire)");
window.openModelBrowser();
await sleep(150);
const remoteItems = () => document.querySelectorAll("#mb-remote-list .mb-item");
assert.strictEqual(remoteItems().length, 2, "deux modèles distants listés");

remoteItems()[0].dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
await sleep(120);

assert.ok(winEl(), "la fenêtre de progression est ouverte au lancement du download");
assert.ok(/Téléchargement/.test(windowTitle()), `titre fenêtre = téléchargement, obtenu « ${windowTitle()} »`);
assert.strictEqual(dlRows().length, 1, "une ligne pour le fichier lancé");
assert.ok(/Krea2-Turbo/.test(rowEl(0).querySelector(".aih-dlw-name").textContent), "nom du fichier affiché");
assert.strictEqual(phaseOf(0), "Préparation côté serveur…", "phase initiale = préparation côté serveur");
assert.strictEqual(globalCount(), "Progression : 0/1", "progression globale 0/1");
assert.strictEqual(calls.download.length, 1, "le download est bien parti");
assert.strictEqual(calls.download[0].upload_id, "uid-1", "upload_id transmis");
ok("dblclick → fenêtre + 1 ligne (nom, phase serveur) + globale 0/1");

/* ─── 4. Phases + % · octets · MB/s · temps/ETA (polling) ──────────────── */
console.log("3. Phases + mesures en ligne");
progressByUid["uid-1"] = { percent: 0, speed_mbs: 0, bytes_recv: 0, bytes_total: 13500000000, phase: "preparing" };
await sleep(950); // > POLL_MS (800 ms)
assert.ok(calls.progress.length >= 1, "la progression est interrogée");
assert.ok(calls.progress.includes("uid-1"), "progression ciblée par upload_id");
assert.strictEqual(phaseOf(0), "Préparation côté serveur…", "0 octet → phase préparation (pas un 0 % muet)");
assert.strictEqual(rowEl(0).querySelector(".aih-dlw-speed").textContent, "— MB/s", "aucun débit inventé");

progressByUid["uid-1"] = { percent: 37, speed_mbs: 12.5, bytes_recv: 4995000000, bytes_total: 13500000000, phase: "transferring" };
await sleep(950);
assert.strictEqual(phaseOf(0), "Transfert", "des octets arrivent → phase transfert");
assert.strictEqual(rowEl(0).querySelector(".aih-dlw-fill").style.width, "37%", "barre = % serveur");
assert.strictEqual(rowEl(0).querySelector(".aih-dlw-pct").textContent, "37%", "pourcentage affiché");
assert.ok(/GB/.test(rowEl(0).querySelector(".aih-dlw-bytes").textContent), "octets transférés/total affichés");
assert.ok(/MB\/s/.test(rowEl(0).querySelector(".aih-dlw-speed").textContent), "débit MB/s affiché");
assert.ok(/reste ~/.test(rowEl(0).querySelector(".aih-dlw-time").textContent), "temps écoulé + ETA affichés");
ok("préparation → transfert, 37 %, octets/total, MB/s et ETA");

/* ─── 5. ✕ par ligne → route d'annulation ──────────────────────────────── */
console.log("4. Annulation par ligne");
rowEl(0).querySelector(".aih-dlw-cancel").click();
await sleep(80);
assert.strictEqual(calls.cancel.length, 1, "le ✕ appelle /models/download/cancel");
assert.strictEqual(calls.cancelBodies[0].upload_id, "uid-1", "upload_id transmis à l'annulation");
ok("✕ par ligne : POST /models/download/cancel {upload_id}");

/* ─── 6. État final : titre + récap + Fermer ───────────────────────────── */
console.log("5. État final + récap + Fermer");
resolveNextDownload({ success: true, path: "/models/unet/Krea2.safetensors" });
await sleep(200);
assert.ok(rowEl(0).classList.contains("is-ok"), "ligne marquée réussie");
assert.strictEqual(windowTitle(), "Téléchargement terminé", "titre final explicite");
assert.ok(finalEl().classList.contains("is-visible"), "bandeau final VISIBLE (état explicite, pas seulement en DOM)");
assert.strictEqual(globalCount(), "Progression : 1/1", "progression globale 1/1");
assert.ok(/1 réussi\(s\)/.test(finalText()) && /0 annulé\(s\)/.test(finalText()) && /0 échec\(s\)/.test(finalText()),
    `récap chiffré attendu, obtenu « ${finalText()} »`);
const closeBtn = document.querySelector("#aih-download-window .aih-dlw-close");
assert.ok(closeBtn && closeBtn.style.display !== "none", "bouton Fermer visible");
closeBtn.click();
await sleep(80);
assert.strictEqual(winEl(), null, "le bouton Fermer ferme la fenêtre");
ok("fin unitaire : « Téléchargement terminé » + récap (1/0/0) + Fermer");

/* ─── 7. LOT : une ligne par fichier, « En attente », globale N/M ──────── */
console.log("6. Lot de 2 fichiers");
{
    const cbs = document.querySelectorAll("#mb-remote-list .mb-checkbox");
    assert.strictEqual(cbs.length, 2, "cases de sélection présentes");
    cbs.forEach((cb) => {
        // jsdom exécute l'action par défaut du clic : la case bascule.
        // Ctrl enfoncé = sélection MULTIPLE. Les modifieurs sont lus sur le
        // CLIC (vrai MouseEvent) : un évènement 'change' ne porte jamais
        // ctrlKey/shiftKey dans un vrai navigateur (piège historique).
        cb.dispatchEvent(new window.MouseEvent("click", { bubbles: true, ctrlKey: true }));
    });
}
document.querySelector(".mb-batch-download").click();
await sleep(150);

assert.ok(winEl(), "la fenêtre s'ouvre pour le LOT");
assert.strictEqual(dlRows().length, 2, "une ligne par fichier du lot");
assert.strictEqual(globalCount(), "Progression : 0/2", "globale 0/2 avant transfert");
assert.strictEqual(phaseOf(0), "Préparation côté serveur…", "1er fichier en préparation");
assert.strictEqual(phaseOf(1), "En attente", "2e fichier en attente (pas encore lancé)");
assert.strictEqual(calls.download.length, 2, "seul le 1er download est parti (lot séquentiel)");

resolveNextDownload({ success: true, path: "/models/unet/Krea2.safetensors" });
await sleep(200);
assert.ok(rowEl(0).classList.contains("is-ok"), "1er fichier réglé réussi");
assert.strictEqual(globalCount(), "Progression : 1/2", "globale 1/2 après le 1er");
assert.strictEqual(phaseOf(1), "Préparation côté serveur…", "2e fichier démarré à son tour");
assert.strictEqual(calls.download.length, 3, "le 2e download est parti");

resolveNextDownload({ success: false, error: "Modèle introuvable côté serveur" }, 400);
await sleep(250);
assert.ok(rowEl(1).classList.contains("is-failed"), "2e fichier en échec");
{
    const msg = rowEl(1).querySelector(".aih-dlw-msg");
    assert.ok(/introuvable/i.test(msg.textContent), "message d'échec réel affiché");
    assert.ok(msg.classList.contains("is-visible"), "message d'échec visible");
}
assert.strictEqual(windowTitle(), "Téléchargement terminé", "titre final du lot");
assert.ok(finalEl().classList.contains("is-visible"), "bandeau final du lot VISIBLE");
assert.strictEqual(globalCount(), "Progression : 2/2", "globale 2/2");
assert.ok(/1 réussi\(s\)/.test(finalText()) && /0 annulé\(s\)/.test(finalText()) && /1 échec\(s\)/.test(finalText()),
    `récap mixte attendu, obtenu « ${finalText()} »`);
ok("lot : 2 lignes, attente→préparation, globale 0/2→2/2, récap 1·0·1");

/* ─── 8. CONTRÔLE NÉGATIF : annulation ≠ succès ────────────────────────── */
console.log("7. Contrôle négatif — annulation");
document.querySelector("#aih-download-window .aih-dlw-close").click();
await sleep(60);
remoteItems()[0].dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
await sleep(120);
resolveNextDownload({ success: false, cancelled: true, error: "Téléchargement annulé" }, 400);
await sleep(200);
assert.ok(rowEl(0).classList.contains("is-cancelled"), "ligne marquée annulée");
assert.ok(/0 réussi\(s\)/.test(finalText()) && /1 annulé\(s\)/.test(finalText()) && /0 échec\(s\)/.test(finalText()),
    `récap attendu 0·1·0, obtenu « ${finalText()} »`);
ok("contrôle négatif : {cancelled:true} → compteur « annulé », jamais un succès");

/* ─── 9. CONTRÔLE NÉGATIF : échec réel visible ─────────────────────────── */
console.log("8. Contrôle négatif — échec réel");
document.querySelector("#aih-download-window .aih-dlw-close").click();
await sleep(60);
remoteItems()[0].dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
await sleep(120);
resolveNextDownload({ success: false, error: "Transfert interrompu : connection reset" }, 400);
await sleep(200);
assert.ok(rowEl(0).classList.contains("is-failed"), "ligne marquée échec");
assert.ok(/connection reset/.test(rowEl(0).querySelector(".aih-dlw-msg").textContent), "raison exacte affichée");
assert.ok(/0 réussi\(s\)/.test(finalText()) && /0 annulé\(s\)/.test(finalText()) && /1 échec\(s\)/.test(finalText()),
    `récap attendu 0·0·1, obtenu « ${finalText()} »`);
ok("contrôle négatif : échec → raison visible + compteur échec (jamais masqué)");

console.log(`\n✅ test_aih_download_window : ${n} groupes PASSENT`);
