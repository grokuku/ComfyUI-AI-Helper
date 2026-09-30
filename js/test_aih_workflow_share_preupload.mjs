// ─────────────────────────────────────────────────────────────────────────
// RÉGRESSION — Modale de PRÉ-UPLOAD de l'onglet 📤 Partager.
//
// Bug réel (capture utilisateur) : « Upload terminé (8 fichiers, 0.2s) » avec
// TOUS les items en ✅ et des débits absurdes (140 391 MB/s pour un fichier de
// 13 477 Mo). Cause : la déduplication serveur (fingerprint head/tail) SAUTE
// silencieusement les fichiers déjà présents et l'UI calculait size/elapsed
// comme un débit → aucun octet transféré, faux succès, débit inventé.
//
// Ce test pilote le VRAI chemin de publication (bouton Publier) avec un faux
// serveur et vérifie :
//   1. la modale apparaît UNIQUEMENT si un modèle de la sélection existe déjà ;
//   2. les DÉFAUTS intelligents : absent → coché + verrouillé ; identique /
//      différent → non coché, écrasable (« Tout écraser » / « Ignorer ») ;
//   3. confirmer n'envoie que nouveaux + cochés (drapeau overwrite:true) ;
//   4. annuler = AUCUN envoi (ni modèle, ni workflow) ;
//   5. le résultat distingue envoyé ✅ / écrasé ♻️ / ignoré ⏭ / échec ❌ et
//      n'affiche JAMAIS de débit pour un fichier non transféré ;
//   6. le récapitulatif final est chiffré par état ;
//   7. dégradation : check impossible (404) → pas de modale, mais un skip de
//      dédup reste affiché « ignoré » (jamais un faux ✅ / 140 391 MB/s) ;
//   8. contrôle négatif par mutation : si `overwrite` n'était pas transmis à
//      l'upload, le corps de requête resterait sans drapeau → rouge ;
//   9. parité i18n FR/EN stricte des clés ajoutées.
//
// Usage : node js/test_aih_workflow_share_preupload.mjs
//   jsdom résolu par js/test_helpers/jsdom_loader.mjs (introuvable = SKIP
//   bruyant, exit 2 — jamais compté PASS).
// Code de sortie : 0 = PASS, 2 = SKIP, 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_aih_workflow_share_preupload");

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

// ── Grappe ComfyUI minimale : 1 checkpoint + 1 lora référencés ──────────
window.app = {
    graph: {
        serialize: () => ({
            nodes: [
                { id: 1, type: "CheckpointLoaderSimple", widgets_values: ["big.safetensors"] },
                { id: 2, type: "LoraLoader", widgets_values: ["style.safetensors", 1.0, 1.0] },
            ],
            links: [],
            extra: { title: "Mon workflow" },
        }),
        _nodes: [],
    },
    ui: { title: "Mon workflow" },
    workflowName: "Mon workflow",
};

const SERVER_URL = "https://aih.test";
const BIG = { name: "big.safetensors", path: "/models/checkpoints/big.safetensors", size: 13477 * 1024 * 1024 };
const STYLE = { name: "style.safetensors", path: "/models/loras/style.safetensors", size: 2 * 1024 * 1024 };

function jsonResponse(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
        json: async () => data,
        text: async () => JSON.stringify(data),
    };
}

// ── État du faux serveur (piloté par scénario) ───────────────────────────
let checkMode = "mixed";          // "mixed" (big identique) | "none" | "fail" | "different"
let dedupAll = false;             // /upload répond deduplicated:true (aucun octet)
// Phase renvoyée par /upload/progress : 'uploading' (défaut) ou 'finalizing'
// (tous les octets reçus, le serveur recopie le fichier complet vers son
// stockage — étape longue et sans progression fine pour un 13 Go).
let progressPhase = "uploading";
let uploadDelayMs = 0;            // retarde la réponse /upload (laisse poller)
const checkCalls = [];
const uploadCalls = [];
const workflowPosts = [];
let uploadSeq = 0;

window.fetch = globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || "GET";
    if (u.includes("/api/aih/models/list")) {
        return jsonResponse({
            checkpoints: [BIG].map(({ name, path, size }) => ({ name, path, size })),
            loras: [STYLE].map(({ name, path, size }) => ({ name, path, size })),
        });
    }
    if (u.includes("/api/aih/custom-nodes")) return jsonResponse({ nodes: [] });
    if (u.includes("/api/aih/models/check")) {
        checkCalls.push({ url: u, body: init && init.body });
        if (checkMode === "fail") return jsonResponse({ error: "not found" }, 404);
        const items = JSON.parse((init && init.body) || "{}").items || [];
        return jsonResponse({
            ok: true,
            error: null,
            items: items.map((it) => {
                const isBig = it.path === BIG.path;
                if (checkMode === "none" || !isBig) {
                    return { path: it.path, name: it.path.split("/").pop(), type: it.type, size: 0, status: "absent", remote: null, error: null };
                }
                if (checkMode === "different") {
                    return {
                        path: it.path, name: "big.safetensors", type: it.type, size: BIG.size,
                        status: "different",
                        remote: { upload_id: "srv-big-old", filename: "big.safetensors", size: BIG.size - 4096, file_path: "workflows/models/srv-big-old/big.safetensors", created_at: "2026-05-01 10:00:00" },
                        error: null,
                    };
                }
                return {
                    path: it.path, name: "big.safetensors", type: it.type, size: BIG.size,
                    status: "identical",
                    remote: { upload_id: "srv-big", filename: "big.safetensors", size: BIG.size, file_path: "workflows/models/srv-big/big.safetensors", created_at: "2026-05-01 10:00:00" },
                    error: null,
                };
            }),
        });
    }
    if (u.includes("/api/aih/models/upload/progress")) {
        return jsonResponse({ percent: 100, speed_mbs: 12.5, phase: progressPhase });
    }
    if (u.includes("/api/aih/models/upload")) {
        uploadCalls.push({ url: u, body: init && init.body, signal: init && init.signal });
        if (uploadDelayMs) await sleep(uploadDelayMs);
        if (dedupAll) {
            return jsonResponse({ success: true, upload_id: "srv-old", file_path: "workflows/models/srv-old/x", deduplicated: true });
        }
        uploadSeq++;
        const parsed = JSON.parse((init && init.body) || "{}");
        return jsonResponse({
            success: true,
            upload_id: "new-" + uploadSeq,
            file_path: "workflows/models/new-" + uploadSeq + "/" + String(parsed.path || "").split("/").pop(),
            deduplicated: false,
        });
    }
    if (/\/api\/workflows\?/.test(u)) return jsonResponse({ total: 0, page: 1, limit: 20, items: [] });
    if (/\/api\/workflows$/.test(u)) {
        if (method === "POST") workflowPosts.push({ body: init && init.body });
        return jsonResponse({ id: 1, version: 1 });
    }
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

// ── Helpers ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, label, tries = 400) => {
    for (let i = 0; i < tries; i++) {
        if (cond()) return;
        await sleep(5);
    }
    throw new Error("waitFor timeout: " + label);
};
const uploadRows = () => Array.from(window.document.querySelectorAll("#aih-upload-body > div"))
    .filter((r) => r.querySelectorAll("span").length >= 3);
const statusOf = (row) => row.querySelectorAll("span")[0].textContent;
const speedOf = (row) => row.querySelectorAll("span")[2].textContent;
const nameOf = (row) => row.querySelectorAll("span")[1].textContent;
const rowFor = (frag) => uploadRows().find((r) => nameOf(r).includes(frag));
const preCb = (key) => window.document.querySelector('.wf-pre-cb[data-key="' + key + '"]');
const modalOpen = () => !!window.document.getElementById("wf-pre-send");
const panelTitle = () => {
    const el = window.document.querySelector("#aih-upload-body");
    if (!el) return "";
    const root = el.closest(".aih-dialog-root") || el.parentElement;
    const t = root ? root.querySelector(".aih-dialog-title") : null;
    return t ? t.textContent : window.document.body.textContent;
};

let n = 0;
const ok = (m) => { n++; console.log("  ✓ " + m); };

async function openShare() {
    window.document.body.innerHTML = "";
    checkCalls.length = 0;
    uploadCalls.length = 0;
    workflowPosts.length = 0;
    progressPhase = "uploading";
    uploadDelayMs = 0;
    window.openWorkflowManager();
    await waitFor(() => window.document.getElementById("wf-publish-btn"), "bouton publier");
    await waitFor(() => window.document.querySelectorAll("#wf-deps .wf-upload-cb").length === 2, "dépendances listées");
}

async function publishAndWaitModal() {
    window.document.getElementById("wf-publish-btn").click();
    await waitFor(modalOpen, "modale de pré-upload");
}

async function waitDone() {
    await waitFor(() => /Upload terminé/.test(window.document.body.textContent), "panneau d'upload terminé");
    await sleep(20); // laisse les handlers de résultat se terminer
}

/* ══ 1. Défauts intelligents + confirmation n'envoie que le nouveau ══════ */
console.log("1. Modale : identique non coché, absent coché/verrouillé, envoi ciblé");
{
    checkMode = "mixed"; dedupAll = false;
    await openShare();
    await publishAndWaitModal();

    const bigCb = preCb("checkpoint|big.safetensors");
    const styleCb = preCb("lora|style.safetensors");
    assert.ok(bigCb && styleCb, "une case par ligne");
    assert.strictEqual(bigCb.checked, false, "« déjà présent (identique) » NON coché par défaut");
    assert.strictEqual(bigCb.disabled, false, "« identique » reste écrasable manuellement");
    assert.strictEqual(styleCb.checked, true, "« absent » coché par défaut");
    assert.strictEqual(styleCb.disabled, true, "« absent » verrouillé (toujours envoyé)");
    assert.ok(window.document.getElementById("wf-pre-volume").textContent.includes("2.0 MB"),
        "volume à envoyer = taille des lignes cochées uniquement");
    assert.ok(window.document.getElementById("wf-pre-send").textContent.includes("(1)"),
        "bouton Envoyer = nombre de lignes cochées");

    window.document.getElementById("wf-pre-send").click();
    await waitDone();

    assert.strictEqual(uploadCalls.length, 1, "un seul upload : l'absent (l'identique est ignoré)");
    const sent = JSON.parse(uploadCalls[0].body);
    assert.strictEqual(sent.path, STYLE.path);
    assert.notStrictEqual(sent.overwrite, true, "absent → pas de drapeau overwrite");

    const bigRow = rowFor("big.safetensors");
    const styleRow = rowFor("style.safetensors");
    assert.strictEqual(statusOf(styleRow), "✅", "l'envoyé est marqué ✅");
    assert.strictEqual(statusOf(bigRow), "⏭", "l'ignoré (déjà présent) n'est PAS un ✅");
    assert.strictEqual(speedOf(bigRow), "—", "aucun débit pour un fichier NON transféré");
    assert.ok(!/MB\/s/.test(speedOf(bigRow)), "jamais de débit inventé sur un ignoré");
    assert.ok(window.document.body.textContent.includes("1 ignoré(s)"), "récap : 1 ignoré");
    assert.ok(window.document.body.textContent.includes("1 envoyé(s)"), "récap : 1 envoyé");

    const wf = JSON.parse(workflowPosts[0].body);
    const bigDep = (wf.required_models || []).find((d) => d.name === "big.safetensors");
    assert.strictEqual(bigDep.upload_id, "srv-big",
        "l'existant IGNORÉ reste référencé par son upload_id serveur (téléchargeable ailleurs)");
    ok("défauts + envoi ciblé + référence du modèle ignoré");
}

/* ══ 2. « Tout écraser » : overwrite explicite transmis ═══════════════════ */
console.log("2. « Tout écraser » → drapeau overwrite:true et état ♻️");
{
    checkMode = "mixed"; dedupAll = false;
    await openShare();
    await publishAndWaitModal();

    window.document.getElementById("wf-pre-all").click();
    assert.strictEqual(preCb("checkpoint|big.safetensors").checked, true, "« Tout écraser » coche l'existant");
    assert.ok(window.document.getElementById("wf-pre-send").textContent.includes("(2)"), "compteur = 2");
    window.document.getElementById("wf-pre-send").click();
    await waitDone();

    assert.strictEqual(uploadCalls.length, 2, "les deux fichiers sont envoyés");
    const bigCall = uploadCalls.map((c) => JSON.parse(c.body)).find((b) => b.path === BIG.path);
    const styleCall = uploadCalls.map((c) => JSON.parse(c.body)).find((b) => b.path === STYLE.path);
    assert.strictEqual(bigCall.overwrite, true, "coché = écrasement explicite (overwrite:true)");
    assert.notStrictEqual(styleCall.overwrite, true, "l'absent n'est pas marqué overwrite");
    assert.strictEqual(statusOf(rowFor("big.safetensors")), "♻️", "l'écrasé a son propre état ♻️");
    assert.strictEqual(statusOf(rowFor("style.safetensors")), "✅");
    assert.ok(window.document.body.textContent.includes("1 écrasé(s)"), "récap : 1 écrasé");
    ok("« Tout écraser » → upload réel des deux, dont overwrite:true");
}

/* ══ 3. « Ignorer les existants » puis annulation ═════════════════════════ */
console.log("3. « Ignorer les existants » et Annuler (aucun envoi)");
{
    checkMode = "mixed"; dedupAll = false;
    await openShare();
    await publishAndWaitModal();
    window.document.getElementById("wf-pre-all").click();
    window.document.getElementById("wf-pre-none").click();
    assert.strictEqual(preCb("checkpoint|big.safetensors").checked, false, "« Ignorer les existants » décoche");
    assert.strictEqual(preCb("lora|style.safetensors").checked, true, "l'absent reste coché/verrouillé");
    assert.ok(window.document.getElementById("wf-pre-send").textContent.includes("(1)"), "compteur = 1");
    ok("« Ignorer les existants » ne touche pas aux absents");

    window.document.getElementById("wf-pre-cancel").click();
    await sleep(60);
    assert.strictEqual(modalOpen(), false, "la modale est fermée par Annuler");
    assert.strictEqual(uploadCalls.length, 0, "Annuler → AUCUN upload");
    assert.strictEqual(workflowPosts.length, 0, "Annuler → AUCUN workflow publié");
    const status = window.document.getElementById("wf-status");
    assert.ok(!status || status.style.display === "none" || status.textContent === "",
        "le statut de publication est effacé après annulation");
    ok("Annuler → aucun envoi (modèles ni workflow)");
}

/* ══ 4. Taille différente : libellé dédié, écrasement sur demande ════════ */
console.log("4. « déjà présent (taille différente) » → signalé, écrasable");
{
    checkMode = "different"; dedupAll = false;
    await openShare();
    await publishAndWaitModal();

    const bigCb = preCb("checkpoint|big.safetensors");
    assert.strictEqual(bigCb.checked, false, "taille différente → non coché par défaut");
    const modalText = window.document.body.textContent;
    assert.ok(modalText.includes("taille différente"), "l'état est signalé visuellement (libellé dédié)");
    assert.ok(modalText.includes("serveur :"), "la taille serveur est affichée pour décider");
    assert.strictEqual(uploadCalls.length, 0, "rien n'est envoyé tant que la modale est ouverte");

    window.document.getElementById("wf-pre-send").click();
    await waitDone();
    assert.strictEqual(uploadCalls.length, 1, "sans case cochée, l'existant différent n'est pas envoyé");
    assert.strictEqual(statusOf(rowFor("big.safetensors")), "⏭", "existant non écrasé → ignoré");
    ok("taille différente : visible, ignoré par défaut, écrasable via « Tout écraser »");
}

/* ══ 5. Aucun existant → PAS de modale (comportement actuel) ═════════════ */
console.log("5. Aucun modèle existant → pas de modale, upload direct");
{
    checkMode = "none"; dedupAll = false;
    await openShare();
    window.document.getElementById("wf-publish-btn").click();
    await waitDone();
    assert.strictEqual(modalOpen(), false, "aucune friction si rien n'existe déjà");
    assert.strictEqual(uploadCalls.length, 2, "les deux fichiers sont envoyés");
    assert.strictEqual(statusOf(rowFor("big.safetensors")), "✅");
    assert.strictEqual(statusOf(rowFor("style.safetensors")), "✅");
    assert.ok(window.document.body.textContent.includes("2 envoyé(s)"), "récap : 2 envoyés");
    ok("aucun existant → pas de modale, comportement historique conservé");
}

/* ══ 6. Skip de dédup AVEC check impossible : jamais un faux succès ══════ */
console.log("6. Check indisponible + dédup serveur → « ignoré », pas de faux ✅/débit");
{
    checkMode = "fail"; dedupAll = true;
    await openShare();
    window.document.getElementById("wf-publish-btn").click();
    await waitDone();
    assert.strictEqual(modalOpen(), false, "check impossible → pas de modale (dégradation)");
    assert.strictEqual(uploadCalls.length, 2, "l'upload normal a bien été tenté");
    const rows = uploadRows();
    assert.strictEqual(rows.length, 2);
    for (const row of rows) {
        assert.strictEqual(statusOf(row), "⏭", "un skip de dédup est « ignoré », jamais un succès ✅");
        assert.strictEqual(speedOf(row), "—", "aucun octet transféré → aucun débit (fin du 140 391 MB/s)");
    }
    assert.ok(window.document.body.textContent.includes("2 ignoré(s)"), "récap : 2 ignorés");
    assert.ok(window.document.body.textContent.includes("aucun octet envoyé"), "raison explicite affichée");
    ok("déduplication visible et honnête (réplique exacte du bug « 0.2 s »)");
}

/* ══ 7. Progression : la finalisation serveur n'est plus muette ═════════ */
console.log("7. Progression : phase 'finalizing' affichée puis retirée au résultat");
{
    checkMode = "mixed"; dedupAll = false;
    await openShare();
    progressPhase = "finalizing";
    uploadDelayMs = 800;   // laisse le polling (500 ms) renvoyer la phase finalizing
    await publishAndWaitModal();
    window.document.getElementById("wf-pre-all").click();   // envoie aussi l'existant
    window.document.getElementById("wf-pre-send").click();
    await waitFor(() => rowFor("style.safetensors"), "ligne d'upload");
    await sleep(700);      // ≥ 1 poll : la phase finalizing doit s'afficher

    const row = rowFor("style.safetensors");
    assert.ok(row && /finalisation/i.test(row.textContent),
        "pendant la finalisation (recopie serveur d'un gros fichier), la ligne l'annonce — jamais un blocage muet");
    assert.strictEqual(statusOf(row), "⏳", "toujours en cours : aucun faux résultat");

    await waitDone();
    assert.ok(!/finalisation/i.test(rowFor("style.safetensors").textContent),
        "la note de finalisation est retirée quand le résultat arrive");
    assert.strictEqual(statusOf(rowFor("style.safetensors")), "✅");
    ok("phase finalizing affichée pendant l'attente puis nettoyée au résultat");
}

/* ══ 8. Verrous statiques (mutation) ════════════════════════════════════ */
console.log("8. Verrous statiques : drapeau transmis, modale via AIH.Dialog, i18n FR/EN");
{
    const src = readFileSync(new URL("./aih_workflow_share.js", import.meta.url), "utf8");
    assert.ok(/uploadModelToServer\(item\.path,\s*item\.type,\s*isOverwrite\)/.test(src),
        "mutation : si `isOverwrite` n'était plus passé à l'upload, l'écrasement coché n'aurait aucun effet");
    assert.ok(/deduplicated\s*===\s*true[\s\S]{0,40}'skipped'/.test(src),
        "mutation : si le flag deduplicated n'était plus traité, un skip redeviendrait un faux succès");
    assert.ok(/window\.AIH\s*&&\s*window\.AIH\.Dialog/.test(src) && /D\.open\(/.test(src),
        "mutation : la modale doit passer par le système de fenêtres unifié AIH.Dialog");
    assert.ok(!/\/files\/check/.test(src), "le front ne devine jamais l'existence : il interroge la route de check du pack");
    assert.ok(/p\.phase === 'finalizing'/.test(src),
        "mutation : si la phase finalizing n'était plus traitée, la finalisation d'un 13 Go resterait une barre figée muette");

    // Parité i18n stricte : chaque clé nouvelle existe en FR ET en EN.
    const strings = readFileSync(new URL("./aih_strings.js", import.meta.url), "utf8");
    const enIdx = strings.indexOf("const EN = {");
    assert.ok(enIdx > 0, "bloc EN localisé");
    const keys = [
        "wf.uploadDone", "wf.uploadCountSent", "wf.uploadCountOverwritten",
        "wf.uploadCountSkipped", "wf.uploadCountFailed",
        "wf.preUploadTitle", "wf.preUploadIntro", "wf.preUploadStateAbsent",
        "wf.preUploadStateIdentical", "wf.preUploadStateDifferentSize",
        "wf.preUploadStateDifferentHash", "wf.preUploadLocal", "wf.preUploadRemote",
        "wf.preUploadRemoteDate", "wf.preUploadOverwrite", "wf.preUploadVolume",
        "wf.preUploadOverwriteAll", "wf.preUploadIgnoreExisting", "wf.preUploadSend",
        "wf.preUploadSkippedNoBytes", "wf.uploadFinalizing",
    ];
    for (const key of keys) {
        const token = '"' + key + '"';
        assert.ok(strings.indexOf(token) > 0 && strings.indexOf(token) < enIdx,
            `clé ${key} absente du bloc FR`);
        assert.ok(strings.indexOf(token, enIdx) > 0,
            `clé ${key} absente du bloc EN (parité stricte FR/EN)`);
    }
    ok("drapeau overwrite verrouillé, modale unifiée, parité i18n FR/EN (" + keys.length + " clés)");
}

console.log(`\n✅ test_aih_workflow_share_preupload : ${n} groupes PASSENT`);
process.exit(0);
