// ─────────────────────────────────────────────────────────────────────────
// ComfyCH — l'état affiché dans la modale se RAFRAÎCHIT après une opération.
//
// Bug constaté en test réel : après un déploiement, la date « Dernier
// déploiement » restait l'ancienne valeur (« ⏳ Jamais ») jusqu'à ce que
// l'utilisateur FERME puis ROUVRE la modale. Le serveur n'écrit `last_deploy`
// qu'à la FIN de l'opération : une modale déjà ouverte ne relisait donc jamais
// la config.
//
// Ce que ce fichier verrouille (chaque point a son mutant) :
//   §1 la première ouverture affiche l'état fourni par /api/modal/config ;
//   §2 après la fin d'un déploiement (event SSE `done`, code 0), la date est
//      réaffichée SANS fermer/rouvrir — MUTANT M1 « rafraîchissement retiré »
//      → ROUGE ;
//   §3 le rafraîchissement ne touche QUE les badges : le panneau est le MÊME
//      élément (pas de reconstruction), le champ en cours de saisie et la
//      position de défilement sont préservés — MUTANT M2 « re-render global »
//      → ROUGE ;
//   §4 le même rafraîchissement vaut pour les AUTRES opérations (sync, sync
//      user, redémarrage du worker), pas seulement deploy.
//
// Usage : node js/test_comfych_op_state_refresh.mjs
//   jsdom résolu par js/test_helpers/jsdom_loader.mjs ; absent = SKIP (exit 2).
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 20));

const JSDOM = await loadJsdomOrSkip("test_comfych_op_state_refresh");
const dom = new JSDOM(
    `<!doctype html><html><head></head><body>
       <button id="comfy-node-button">node</button>
     </body></html>`,
    { pretendToBeVisual: true, url: "http://localhost/" }
);
const { window: domWindow } = dom;
globalThis.window = domWindow;
globalThis.document = domWindow.document;
globalThis.localStorage = domWindow.localStorage;
globalThis.getComputedStyle = domWindow.getComputedStyle.bind(domWindow);
globalThis.HTMLElement = domWindow.HTMLElement;
globalThis.Node = domWindow.Node;
globalThis.Blob = domWindow.Blob;
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
try { globalThis.navigator = domWindow.navigator; } catch { /* déjà fourni */ }
domWindow.matchMedia = domWindow.matchMedia
    || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));

localStorage.setItem("aih_locale", "fr");
localStorage.setItem("modal-gateway-mode", "modal:h100");

/* ══════════════ Harnais : config serveur mutable + EventSource ══════════════ */

/**
 * Config renvoyée par GET /api/modal/config. Le serveur ne renseigne `last_*`
 * qu'à la FIN d'une opération réussie : le test modifie cet objet pour simuler
 * la fin de l'opération.
 */
const serverConfig = {
    api_url: "https://gw.modal.run",
    api_key_set: true,
    render_mode_forced: "",
    last_deploy: null,
    last_sync: null,
    last_user_sync: null,
};
let configFetches = 0;
const postedOperations = [];

function jsonResponse(body, status) {
    return {
        ok: (status || 200) < 400,
        status: status || 200,
        headers: { get: () => "application/json" },
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

globalThis.fetch = async (url, opts) => {
    const target = String(url);
    if (target.includes("/api/modal/config")) {
        configFetches++;
        return jsonResponse({ ...serverConfig });
    }
    if (target.includes("/api/modal/status")) {
        return jsonResponse({
            modal_installed: true,
            modal_authenticated: true,
            volume_exists: true,
            secret_exists: true,
            api_configured: true,
            last_deploy: serverConfig.last_deploy,
            last_sync: serverConfig.last_sync,
        });
    }
    if (target.includes("/api/modal/plugins/installed")) {
        return jsonResponse({ nodes: [], synced_at: serverConfig.last_sync_custom_nodes || null });
    }
    if (target.includes("/api/modal/user-settings/status")) {
        return jsonResponse({ exists: true, path: "/tmp/user", file_count: 3, size_mb: 0.1 });
    }
    if (/\/api\/modal\/(deploy|sync|sync-user|sync-custom-nodes|restart-worker)$/.test(target)) {
        postedOperations.push({ url: target, method: opts && opts.method });
        return jsonResponse({ ok: true, message: "Opération lancée" });
    }
    return jsonResponse({ ok: true });
};

/** EventSource de test : permet de déclencher `done` à la main. */
class FakeEventSource {
    constructor(url) {
        this.url = url;
        this.closed = false;
        this.handlers = {};
        FakeEventSource.instances.push(this);
    }
    addEventListener(type, fn) {
        (this.handlers[type] = this.handlers[type] || []).push(fn);
    }
    emit(type, data) {
        for (const fn of this.handlers[type] || []) {
            fn({ data: JSON.stringify(data) });
        }
    }
    close() { this.closed = true; }
}
FakeEventSource.instances = [];
globalThis.EventSource = FakeEventSource;
domWindow.EventSource = FakeEventSource;

/* Faux app ComfyUI (l'extension s'enregistre au chargement). */
const app = {
    graph: { nodes: [] },
    canvas: {},
    ui: {},
    api: { queuePrompt: () => Promise.resolve({}) },
    extensions: [],
    menu: { settingsGroup: { element: document.getElementById("comfy-node-button") } },
    registerExtension(ext) { app.extensions.push(ext); },
};
globalThis.window.app = app;
domWindow.app = app;
globalThis.app = app;
domWindow.comfyAPI = { app: { app } };

/* ══════════════ Chargement du module (chemin réel du pack) ══════════════ */
await import("./comfych_gateway.js");
await import("./comfych/modal_gateway.js");
await tick(400);

const host = () => domWindow.AIHComfyCHHost;
assert.ok(host(), "pont window.AIHComfyCHHost exposé");
assert.strictEqual(typeof host().openSettings, "function", "openSettings() exposé");

const overlay = () => document.getElementById("modal-settings-overlay");
const badgeText = (id) => (document.getElementById(id) || {}).textContent;

/** Ouvre la modale de réglages et attend son remplissage. */
async function openModal() {
    host().openSettings();
    await tick(120);
    assert.ok(overlay(), "la modale de réglages est ouverte");
    return overlay().querySelector(".modal-settings-panel");
}

/** Lance une opération et renvoie l'EventSource SSE associé. */
async function startOperation(buttonId) {
    const before = FakeEventSource.instances.length;
    const btn = document.getElementById(buttonId);
    assert.ok(btn, `bouton ${buttonId} présent`);
    btn.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
    await tick(120);
    const created = FakeEventSource.instances.slice(before);
    assert.ok(created.length > 0, `un flux SSE est ouvert pour ${buttonId}`);
    return created[created.length - 1];
}

/* ═════════ 1. Première ouverture : état lu depuis la config ═════════ */
console.log("1. Ouverture de la modale : état initial affiché");

await openModal();
assert.strictEqual(badgeText("status-deploy"), "⏳ Jamais",
    "aucun déploiement connu → « ⏳ Jamais »");
assert.strictEqual(badgeText("status-sync"), "⏳ Jamais", "aucune sync connue → « ⏳ Jamais »");
assert.ok(configFetches > 0, "la modale lit GET /api/modal/config");
ok("état initial rendu depuis la config");

/* ═════════ 2. Fin d'un déploiement : la date se met à jour ═════════ */
console.log("2. Après un déploiement, la date est réaffichée SANS fermeture");

const panel = overlay().querySelector(".modal-settings-panel");
// Simule un utilisateur en train de saisir + une zone scrollée.
const urlInput = document.getElementById("cfg-api-url");
urlInput.value = "https://saisie-en-cours.modal.run";
panel.scrollTop = 240;
const samePanel = panel;

const sse = await startOperation("cfg-run-deploy");
assert.ok(postedOperations.some((op) => /\/api\/modal\/deploy$/.test(op.url)),
    "POST /api/modal/deploy a bien été envoyé");

// Le serveur écrit la date à la FIN de l'opération (code 0).
serverConfig.last_deploy = "2026-10-26T12:34:56";
sse.emit("done", { code: "0" });
await tick(1400);   // le rafraîchissement est différé (1 s)

assert.strictEqual(badgeText("status-deploy"), "✅ 2026-10-26T12:34:56",
    "MUTANT M1 : la date de déploiement est réaffichée après la fin de l'opération");
assert.ok(document.getElementById("status-deploy").className.includes("ok"),
    "le badge passe en état « ok » (plus « muted »)");
ok("date de déploiement rafraîchie sans fermer la modale");

/* ═════════ 3. Rafraîchissement CIBLÉ : ni scroll ni saisie perdus ═════════ */
console.log("3. Le rafraîchissement ne reconstruit PAS la modale");

assert.strictEqual(overlay().querySelector(".modal-settings-panel"), samePanel,
    "MUTANT M2 : le panneau est le MÊME élément (aucun re-render global)");
assert.strictEqual(document.getElementById("cfg-api-url").value,
    "https://saisie-en-cours.modal.run",
    "MUTANT M2 : le champ en cours de saisie est préservé");
assert.strictEqual(document.getElementById("cfg-api-url"), urlInput,
    "MUTANT M2 : le champ n'a pas été remplacé");
assert.strictEqual(overlay().querySelector(".modal-settings-panel").scrollTop, 240,
    "MUTANT M2 : la position de défilement est conservée");
assert.strictEqual(overlay().style.display === "none", false, "la modale est toujours ouverte");
ok("seuls les badges sont réécrits (scroll + saisie intacts)");

/* ═════════ 4. Idem pour les AUTRES opérations ═════════ */
console.log("4. Même rafraîchissement pour sync / sync user / redémarrage");

const sseSync = await startOperation("cfg-run-sync");
serverConfig.last_sync = "2026-10-26T13:00:00";
sseSync.emit("done", { code: "0" });
await tick(1400);
assert.strictEqual(badgeText("status-sync"), "✅ 2026-10-26T13:00:00",
    "la date de sync des modèles est réaffichée");

const sseUser = await startOperation("cfg-sync-user");
serverConfig.last_user_sync = "2026-10-26T13:10:00";
sseUser.emit("done", { code: "0" });
await tick(1400);
assert.strictEqual(badgeText("status-user-sync"), "✅ 2026-10-26T13:10:00",
    "la date de sync des user settings est réaffichée");

// Redémarrage du worker : pas de date propre, mais l'état est relu (pas de
// fermeture nécessaire) — le panneau reste le même élément.
const sseRestart = await startOperation("cfg-run-restart-worker");
serverConfig.last_user_sync = "2026-10-26T13:20:00";
sseRestart.emit("done", { code: "0" });
await tick(1400);
assert.strictEqual(badgeText("status-user-sync"), "✅ 2026-10-26T13:20:00",
    "le redémarrage du worker relit aussi l'état affiché");
assert.strictEqual(overlay().querySelector(".modal-settings-panel"), samePanel,
    "la modale n'a jamais été reconstruite sur ces trois opérations");
ok("sync, sync user et redémarrage rafraîchissent l'état");

/* ═════════ 5. Fermeture / réouverture : comportement d'origine conservé ═════════ */
console.log("5. Fermer puis rouvrir affiche toujours l'état courant (non-régression)");

overlay().querySelector(".modal-settings-close").dispatchEvent(
    new domWindow.MouseEvent("click", { bubbles: true })
);
await tick(60);
assert.strictEqual(overlay(), null, "la modale est fermée");

await openModal();
assert.notStrictEqual(overlay().querySelector(".modal-settings-panel"), samePanel,
    "la réouverture construit bien un nouveau panneau");
assert.strictEqual(badgeText("status-deploy"), "✅ 2026-10-26T12:34:56",
    "à la réouverture, la date de déploiement est toujours celle du serveur");
assert.strictEqual(badgeText("status-sync"), "✅ 2026-10-26T13:00:00",
    "à la réouverture, la date de sync est toujours celle du serveur");
assert.strictEqual(badgeText("status-user-sync"), "✅ 2026-10-26T13:20:00",
    "à la réouverture, la date de sync user est toujours celle du serveur");
ok("la réouverture reste correcte (le rafraîchissement ne casse pas l'existant)");

console.log(`\n✅ ${n} vérifications OK`);
