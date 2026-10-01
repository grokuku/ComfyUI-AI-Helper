// PARCOURS UTILISATEUR RÉEL du Model Browser, de bout en bout :
//   - chargement de TOUS les .js du WEB_DIRECTORY en parallèle (chemin exact de
//     ComfyUI, cf. js/test_helpers/ext_load.mjs) ;
//   - ouverture PAR LE MENU (app.registerExtension → setup() → clic sur
//     l'entrée « 📦 Models », comme l'utilisateur) — pas un appel interne ;
//   - téléchargement PAR LE BOUTON DU PIED DE PANNEAU puis PAR DOUBLE-CLIC ;
//   - assertions de VISIBILITÉ RÉELLE (cascade CSS + empilement), pas seulement
//     d'existence.
//
// Verrous anti-régression (symptômes signalés) :
//   1. bouton « Transferts » ET libellé de build VISIBLES dans la barre d'outils ;
//   2. fenêtre de transferts VISIBLE et EMPILÉE AU-DESSUS du Model Browser sur
//      le bouton du pied (« Download selected ») ET sur le double-clic ;
//   3. stale ≠ null : la sonde de fraîcheur conclut false SANS ouvrir le
//      navigateur (fichier servi = fichier courant) ;
//   4. une copie PÉRIMÉE du module ne peut plus écraser window.openModelBrowser
//      (refus BRUYANT), et la barre d'outils manquante est réparée bruyamment ;
//   5. fenêtre de transferts indisponible → échec BRUYANT ET VISIBLE (bandeau
//      + console), jamais un repli silencieux sur la progression en ligne.
//
// Usage : node js/test_aih_model_browser_user_path.mjs
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";
import { loadAllExtensions } from "./test_helpers/ext_load.mjs";
import { assertVisible, assertStackedAbove } from "./test_helpers/visibility.mjs";

const JSDOM = await loadJsdomOrSkip("test_aih_model_browser_user_path");

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
globalThis.URL.createObjectURL = () => "blob:mock";
globalThis.URL.revokeObjectURL = () => {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

/* ─── Console capturée (les échecs doivent être BRUYANTS) ────────────────── */
const consoleErrors = [];
const consoleWarns = [];
const origError = console.error.bind(console);
const origWarn = console.warn.bind(console);
console.error = (...a) => { consoleErrors.push(a.map(String).join(" ")); origError(...a); };
console.warn = (...a) => { consoleWarns.push(a.map(String).join(" ")); origWarn(...a); };

/* ─── Front ComfyUI simulé, qui exécute VRAIMENT registerExtension/setup ── */
const pendingSetups = [];
window.comfyAPI = {
    app: {
        app: {
            registerExtension(ext) { if (ext && typeof ext.setup === "function") pendingSetups.push(ext.setup); },
            api: {},
        },
    },
    api: { api: { api_base: "/" } },
};
window.app = window.comfyAPI.app.app;

/* ─── Fetch stubé : l'API AIH + la sonde de build (fichier réel) ─────────── */
const CURRENT_SOURCE = readFileSync(new URL("./02_aih_model_browser.js", import.meta.url), "utf-8");
const calls = { download: [] };
let pendingDownloads = [];
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const json = (d, status = 200) =>
        new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
    // Sonde de fraîcheur : le serveur renvoie le fichier COURANT → stale=false.
    if (u.includes("aih_build_probe")) {
        return new Response(CURRENT_SOURCE, { status: 200, headers: { "content-type": "text/javascript" } });
    }
    if (u.includes("/auth/me")) return json({ role: "user" });
    if (u.includes("/models/local")) return json({ items: {} });
    if (u.includes("/models/remote")) {
        return json({
            items: [
                { upload_id: "uid-1", filename: "Krea2.safetensors", type: "unet", size: 13500000000 },
                { upload_id: "uid-2", filename: "clip_l.safetensors", type: "clip", size: 246000000 },
            ],
            total: 2, page: 1, limit: 50,
        });
    }
    if (u.includes("/models/download/progress")) {
        return json({ percent: 10, bytes_recv: 10, bytes_total: 100, phase: "transferring" });
    }
    if (u.includes("/models/download/cancel")) return json({ ok: true });
    if (u.includes("/models/download")) {
        if (opts && opts.body) calls.download.push(JSON.parse(opts.body));
        return new Promise((resolve) => { pendingDownloads.push(resolve); });
    }
    return json({});
};
window.fetch = globalThis.fetch;
window.localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "https://aih.example.com", apiKey: "tok" }));

function resolveNextDownload(data, status = 200) {
    assert.ok(pendingDownloads.length > 0, "aucun download en attente à résoudre");
    pendingDownloads.shift()(new Response(JSON.stringify(data), {
        status, headers: { "content-type": "application/json" },
    }));
}

/* ─── 0. Chargement RÉEL puis exécution des setup() (comme ComfyUI) ──────── */
console.log("0. Chargement réel (import parallèle) + setup des extensions");
const results = await loadAllExtensions();
const byFile = Object.fromEntries(results.map((r) => [r.file, r]));
for (const f of ["02_aih_model_browser.js", "aih_download_window.js", "aih_menu.js", "holaf_main.js"]) {
    assert.ok(byFile[f] && byFile[f].ok,
        `${f} importé sans exception (${byFile[f] && byFile[f].error ? byFile[f].error.message : ""})`);
}
for (const k of ["aihOpenModalV2", "aihShowAlert", "aihShowConfirm", "aihShowPrompt", "aihToast", "showConflictModal", "HolafModal"]) {
    if (typeof window[k] !== "undefined") globalThis[k] = window[k];
}
for (const setup of pendingSetups) {
    try { await setup(); } catch (e) { /* le test le signalera via ses assertions */ }
}
await sleep(40); // HolafUtilitiesMenu.init est planifié par setTimeout(…, 10)
assert.strictEqual(typeof window.openModelBrowser, "function", "openModelBrowser exposé");
assert.ok(window.AIH && window.AIH.DownloadWindow, "AIH.DownloadWindow exposé");
ok("modules chargés en parallèle + menus initialisés comme ComfyUI");

/* ─── 1. Sonde de fraîcheur : stale ≠ null SANS ouvrir le navigateur ─────── */
console.log("1. Sonde de fraîcheur (fichier servi = fichier courant)");
await sleep(60);
assert.strictEqual(window.AIH_MB.build, "mb-transfers-2026-09-30-r7", "marqueur de build courant");
assert.strictEqual(window.AIH_MB.stale, false,
    `stale doit conclure false sans ouverture (obtenu ${JSON.stringify(window.AIH_MB.stale)}, probe=${window.AIH_MB.probe})`);
assert.strictEqual(window.AIH_MB.probe, "ok", "sonde exécutée et concluante");
ok("window.AIH_MB.stale === false dès le chargement (plus de null trompeur)");

/* ─── 2. Ouverture PAR LE MENU (parcours utilisateur réel) ──────────────── */
console.log("2. Ouverture par le menu Holaf → « 📦 Models »");
const menuButton = document.getElementById("holaf-utilities-menu-button");
assert.ok(menuButton, "bouton de menu Holaf présent (init via setup())");
menuButton.click();
const dropdown = document.getElementById("holaf-utilities-dropdown-menu");
assert.ok(dropdown && dropdown.style.display === "block", "menu déroulant ouvert");
const modelsEntry = Array.from(dropdown.querySelectorAll("li"))
    .find((li) => /Models/.test(li.textContent || ""));
assert.ok(modelsEntry, "entrée « 📦 Models » présente dans le menu");
modelsEntry.click();
await sleep(200);

const modal = document.getElementById("aih-modal-model-browser");
assert.ok(modal, "le Model Browser s'ouvre par le menu");
const toolbar = modal.querySelector(".mb-toolbar");
assert.ok(toolbar, "barre d'outils présente");
const transfersBtn = modal.querySelector(".mb-transfers-btn");
assert.ok(transfersBtn, "bouton « ⬇️ Transferts » présent");
assertVisible(assert, transfersBtn, "bouton « Transferts »", { window });
const buildLabel = modal.querySelector(".mb-build-label");
assert.ok(buildLabel, "libellé de build présent");
assertVisible(assert, buildLabel, "libellé de build", { window });
assert.strictEqual(buildLabel.textContent, "mb-transfers-2026-09-30-r7",
    "libellé = build courant (repère visuel de non-obsolescence)");
assert.strictEqual(toolbar.querySelector(".mb-transfers-badge").textContent, "0", "badge initial 0");
ok("bouton « Transferts » + libellé de build VISIBLES (ouverts par le menu)");

/* ─── 3. Téléchargement PAR LE BOUTON DU PIED DE PANNEAU ────────────────── */
console.log("3. « Download selected » (pied de panneau) → fenêtre empilée");
let openCalls = 0;
const realOpen = window.AIH.DownloadWindow.open;
window.AIH.DownloadWindow.open = function (...args) { openCalls++; return realOpen.apply(this, args); };
const remoteRows = () => Array.from(document.querySelectorAll("#mb-remote-list .mb-item"));
assert.strictEqual(remoteRows().length, 2, "deux modèles distants listés");
remoteRows()[0].click(); // sélection simple (clic ligne)
await sleep(20);
const batchBtn = modal.querySelector(".mb-batch-download");
assert.ok(!batchBtn.disabled, "bouton « Download selected » activé après sélection");
assert.ok(/\(1\)/.test(batchBtn.textContent), `compteur de sélection (obtenu « ${batchBtn.textContent} »)`);
batchBtn.click();
await sleep(150);

const dlw = () => document.getElementById("aih-download-window");
assert.ok(dlw(), "la fenêtre de transferts s'ouvre sur le bouton du pied");
assertVisible(assert, dlw(), "fenêtre de transferts (bouton du pied)", { window });
assertStackedAbove(assert, dlw(), modal, "fenêtre de transferts vs Model Browser", window);
assert.ok(openCalls >= 1, "AIH.DownloadWindow.open() a été réellement appelé");
assert.strictEqual(dlw().querySelectorAll(".aih-dlw-row").length, 1, "une ligne de transfert");
assert.strictEqual(calls.download.length, 1, "le téléchargement est parti");
ok("bouton du pied → fenêtre VISIBLE au-dessus du Model Browser + POST download");

resolveNextDownload({ success: true, path: "/models/unet/Krea2.safetensors" });
await sleep(150);
window.AIH.DownloadWindow.dismiss();
await sleep(30);

/* ─── 4. Téléchargement PAR DOUBLE-CLIC ──────────────────────────────────── */
console.log("4. Double-clic sur une ligne distante → fenêtre empilée");
const before = openCalls;
remoteRows()[1].dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
await sleep(150);
assert.ok(openCalls > before, "AIH.DownloadWindow.open() appelé au double-clic");
assert.ok(dlw(), "fenêtre ouverte au double-clic");
assertVisible(assert, dlw(), "fenêtre de transferts (double-clic)", { window });
assertStackedAbove(assert, dlw(), modal, "fenêtre de transferts vs Model Browser (dblclick)", window);
assert.strictEqual(calls.download[calls.download.length - 1].upload_id, "uid-2", "upload_id de la ligne double-cliquée");
ok("double-clic → fenêtre VISIBLE au-dessus du Model Browser + POST download");

resolveNextDownload({ success: true, path: "/models/clip/clip_l.safetensors" });
await sleep(150);
window.AIH.DownloadWindow.dismiss();
await sleep(30);

/* ─── 5. Retry après conflit : la fenêtre est (ré)ouverte, pas l'en-ligne seul ── */
console.log("5. Conflit → résolution → reprise dans la MÊME fenêtre");
const confirmStub = window.aihShowConfirm;
const confirmResolve = () => Promise.resolve(true);
window.aihShowConfirm = confirmResolve;
globalThis.aihShowConfirm = confirmResolve;
const beforeConflict = openCalls;
const downloadsBeforeConflict = calls.download.length;
remoteRows()[0].dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
await sleep(120);
resolveNextDownload({
    success: true, conflict: true,
    local: { size: 1 }, remote: { size: 2 },
});
await sleep(300);
assert.ok(calls.download.length > downloadsBeforeConflict, "la reprise après conflit a bien été envoyée");
const retryBody = calls.download[calls.download.length - 1];
assert.strictEqual(retryBody.conflict_resolution, "overwrite", "résolution « overwrite » transmise");
assert.ok(openCalls > beforeConflict, "la fenêtre a été réutilisée/rouverte pour la reprise");
assert.ok(dlw(), "fenêtre toujours présente après résolution du conflit");
assertVisible(assert, dlw(), "fenêtre de transferts (retry conflit)", { window });
window.aihShowConfirm = confirmStub;
globalThis.aihShowConfirm = confirmStub;
resolveNextDownload({ success: true, path: "/models/unet/Krea2.safetensors" });
await sleep(150);
window.AIH.DownloadWindow.dismiss();
await sleep(30);
ok("retry après conflit → fenêtre VISIBLE (jamais un retour silencieux à l'en-ligne)");

/* ─── 6. Copie périmée : écrasement REFUSÉ et BRUYANT ───────────────────── */
console.log("6. Garde anti-écrasement (copie périmée de openModelBrowser)");
const legacyFn = function legacyOpenModelBrowser() {};
const errorsBefore = consoleErrors.length;
window.openModelBrowser = legacyFn;
assert.notStrictEqual(window.openModelBrowser, legacyFn,
    "une copie SANS marqueur de build ne peut PAS reprendre la main");
assert.strictEqual(window.openModelBrowser.__aihMbBuild, "mb-transfers-2026-09-30-r7",
    "la copie courante reste publiée");
assert.ok(consoleErrors.slice(errorsBefore).some((l) => /ÉCRASÉ/.test(l) && /REFUSÉ/.test(l)),
    "l'écrasement refusé est journalisé (console.error)");
assert.strictEqual(window.AIH_MB.clobberedBy, "sans-marqueur", "diagnostic clobberedBy exposé");
ok("copie périmée refusée + journalisée ; la copie courante reste active");

/* ─── 7. Barre d'outils effacée après coup → réparée BRUYAMMENT ─────────── */
console.log("7. Auto-réparation de la barre d'outils");
transfersBtn.remove();
assert.ok(!modal.querySelector(".mb-transfers-btn"), "bouton retiré (simule un re-rendu sauvage)");
const errorsBeforeRepair = consoleErrors.length;
const repaired = window.AIH_MB.ensureTransfersToolbar();
assert.strictEqual(repaired, true, "réparation signalée réussie");
assert.ok(modal.querySelector(".mb-transfers-btn"), "bouton réinséré");
assertVisible(assert, modal.querySelector(".mb-transfers-btn"), "bouton « Transferts » réparé", { window });
assert.ok(consoleErrors.slice(errorsBeforeRepair).some((l) => /ABSENTE/.test(l)),
    "la disparition de la barre est journalisée (console.error)");
ok("barre absente → journalisée + réinsérée (aucun échec silencieux)");

/* ─── 8. AIH.DownloadWindow absent → échec BRUYANT ET VISIBLE ───────────── */
console.log("8. Fenêtre de transferts indisponible → bandeau visible + console");
const savedDW = window.AIH.DownloadWindow;
delete window.AIH.DownloadWindow;
const errorsBeforeMissing = consoleErrors.length;
const beforeMissing = calls.download.length;
remoteRows()[0].dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
await sleep(150);
const banner = modal.querySelector("#mb-dlw-unavailable");
assert.ok(banner, "bandeau « fenêtre indisponible » présent");
assertVisible(assert, banner, "bandeau fenêtre indisponible", { window });
assert.ok(calls.download.length > beforeMissing, "le téléchargement continue malgré tout (repli en ligne)");
assert.ok(consoleErrors.slice(errorsBeforeMissing).some((l) => /INDISPONIBLE/.test(l)),
    "l'indisponibilité est journalisée (console.error)");
assert.strictEqual(window.AIH_MB.downloadWindow, "unavailable", "diagnostic exposé");
pendingDownloads.shift()(new Response(JSON.stringify({ success: true }), {
    status: 200, headers: { "content-type": "application/json" },
}));
await sleep(100);
window.AIH.DownloadWindow = savedDW;
ok("fenêtre absente → bandeau VISIBLE + console.error (repli en ligne signalé)");

console.log(`\n✅ test_aih_model_browser_user_path : ${n} groupes PASSENT`);
try { dom.window.close(); } catch (e) { /* silencieux */ }
process.exit(0);
