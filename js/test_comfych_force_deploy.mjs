// ─────────────────────────────────────────────────────────────────────────
// ComfyCH — « 🔨 Forcer le déploiement » (anti « Deployment skipped »).
//
// Pourquoi : `modal deploy` n'a AUCUN flag `--force`. Quand la définition de
// l'app n'a pas changé, la CLI répond
//     ✓ Deployment skipped: no changes detected! ⏭️
// et l'image n'est jamais reconstruite — les dépendances ajoutées (watchdog,
// cv2, gguf…) ne sont alors jamais installées chez les workers, qui échouent à
// importer les packs (`ModuleNotFoundError`).
//
// Ce que ce fichier verrouille (chaque point a son mutant) :
//   §1 le bouton « Forcer le déploiement » est présent dans le pied de l'étape 1
//      — MUTANT M1 « bouton retiré » → ROUGE ;
//   §2 un clic envoie POST /api/modal/deploy avec le corps {"force": true}
//      — MUTANT M2 « corps sans force » → ROUGE ;
//   §3 « 🚀 Déployer » (déploiement normal) n'envoie AUCUN corps : le forcage
//      reste explicite (pas de reconstruction payée à chaque clic)
//      — MUTANT M3 « forcage permanent » → ROUGE ;
//   §4 le bouton cliqué (et pas un autre) passe en état « en cours »
//      — MUTANT M4 « buttonId ignoré » → ROUGE.
//
// Usage : node js/test_comfych_force_deploy.mjs
//   jsdom résolu par js/test_helpers/jsdom_loader.mjs ; absent = SKIP (exit 2).
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 20));

const JSDOM = await loadJsdomOrSkip("test_comfych_force_deploy");
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

/* ══════════════ Harnais : fetch/EventSource factices ══════════════ */
const jsonResponse = (payload) => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
});

/** Toutes les requêtes POST vers les routes d'opération (corps capturé). */
const postedOperations = [];

globalThis.fetch = async (target, opts) => {
    const url = String(target);
    const method = (opts && opts.method) || "GET";
    if (url.includes("/api/modal/config")) {
        return jsonResponse({
            api_url: "",
            api_key: "",
            custom_nodes: [],
            custom_nodes_ext: [],
            custom_nodes_local: [],
            extra_pip_packages: [],
            render_mode_forced: "",
            worker_app_name: "",
            api_configured: true,
            last_deploy: null,
            last_sync: null,
            last_user_sync: null,
        });
    }
    if (url.includes("/api/modal/plugins/installed")) {
        return jsonResponse({ nodes: [], synced_at: null });
    }
    if (url.includes("/api/modal/user-settings/status")) {
        return jsonResponse({ exists: true, path: "/tmp/user", file_count: 3, size_mb: 0.1 });
    }
    if (/\/api\/modal\/(deploy|sync|sync-user|sync-custom-nodes|restart-worker)$/.test(url)) {
        postedOperations.push({
            url,
            method,
            body: opts && opts.body ? JSON.parse(opts.body) : null,
        });
        return jsonResponse({ ok: true, message: "Opération lancée" });
    }
    return jsonResponse({ ok: true });
};
domWindow.fetch = globalThis.fetch;

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

/** Ouvre la modale de réglages et rend le panneau. */
async function openModal() {
    host().openSettings();
    await tick(120);
    const overlay = document.getElementById("modal-settings-overlay");
    assert.ok(overlay, "la modale de réglages est ouverte");
    return overlay.querySelector(".modal-settings-panel");
}

/* ═════════ 1. Le bouton existe dans le pied de l'étape 1 ═════════ */
console.log("1. Bouton « Forcer le déploiement » présent à côté de « Déployer »");

const panel = await openModal();
const forceBtn = document.getElementById("cfg-force-deploy");
assert.ok(forceBtn, "MUTANT M1 : bouton « Forcer le déploiement » absent");
assert.ok(/forcer/i.test(forceBtn.textContent), forceBtn.textContent);
const foot = forceBtn.closest(".modal-step-foot");
assert.ok(foot, "le bouton doit vivre dans le pied d'étape (toujours visible)");
assert.ok(
    foot.contains(document.getElementById("cfg-run-deploy")),
    "le forcage doit être adjacent au déploiement normal"
);
assert.ok(panel.contains(forceBtn), "bouton dans le panneau de la modale");
ok("bouton « Forcer le déploiement » présent et adjacent à « Déployer »");

/* ═════════ 2. Clic « Forcer » → {"force": true} ═════════ */
console.log("2. Un clic sur « Forcer » envoie {\"force\": true} à la route deploy");

postedOperations.length = 0;
forceBtn.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick(150);

const forced = postedOperations.find((op) => op.url.includes("/api/modal/deploy"));
assert.ok(forced, `aucun POST /api/modal/deploy (vu : ${JSON.stringify(postedOperations)})`);
assert.strictEqual(forced.method, "POST", "la route de déploiement attend un POST");
assert.ok(forced.body, "MUTANT M2 : aucun corps JSON envoyé (force perdu)");
assert.strictEqual(forced.body.force, true, `corps inattendu : ${JSON.stringify(forced.body)}`);
ok("POST /api/modal/deploy reçoit {\"force\": true}");

/* ═════════ 3. « 🚀 Déployer » n'envoie AUCUN corps (forçage explicite) ═════════ */
console.log("3. « Déployer » reste un déploiement normal (sans force)");

// L'opération précédente occupe le slot : on rend la main au harnais.
for (const source of FakeEventSource.instances) {
    for (const fn of source.handlers.done || []) {
        fn({ data: JSON.stringify({ code: 0 }) });
    }
}
await tick(150);

postedOperations.length = 0;
const deployBtn = document.getElementById("cfg-run-deploy");
deployBtn.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick(150);

const normal = postedOperations.find((op) => op.url.includes("/api/modal/deploy"));
assert.ok(normal, "MUTANT M3 : le déploiement normal n'a pas été lancé");
assert.strictEqual(
    normal.body, null,
    `MUTANT M3 : un déploiement normal ne doit pas forcer (corps ${JSON.stringify(normal.body)})`
);
ok("« Déployer » envoie un POST sans corps (forçage explicite seulement)");

/* ═════════ 4. Le bouton CLIQÉ passe en état « en cours » ═════════ */
console.log("4. L'état « en cours » s'applique au bouton cliqué");

for (const source of FakeEventSource.instances) {
    for (const fn of source.handlers.done || []) {
        fn({ data: JSON.stringify({ code: 0 }) });
    }
}
await tick(150);

forceBtn.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick(150);
assert.ok(
    forceBtn.disabled || /en cours/i.test(forceBtn.textContent),
    "MUTANT M4 : le bouton « Forcer » cliqué doit passer en état « en cours »"
);
ok("le bouton « Forcer » cliqué porte l'état « en cours »");

/* ═════════ 5. Garde de source : le flag est bien câblé ═════════ */
console.log("5. Garde de source : la branche de forcage ne peut pas disparaître en silence");

const SRC = readFileSync(join(HERE, "comfych", "modal_gateway.js"), "utf8");
assert.ok(SRC.includes("cfg-force-deploy"), "MUTANT M1 : identifiant du bouton absent du source");
assert.ok(
    /runOperation\('deploy',\s*\{\s*body:\s*\{\s*force:\s*true\s*\}/.test(SRC),
    "MUTANT M2 : l'appel runOperation('deploy', {body: {force: true}}) est absent"
);
assert.ok(
    SRC.includes("options.buttonId"),
    "MUTANT M4 : runOperation() doit accepter un buttonId explicite"
);
ok("source : bouton + corps {force:true} + buttonId présents");

console.log(`\n✅ Forcer le déploiement (anti « Deployment skipped ») : ${n} vérifications PASS`);
process.exit(0);
