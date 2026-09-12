// ─────────────────────────────────────────────────────────────────────────
// Contrat de sauvegarde / duplication d'un preset (onglet « AIH · Provider LLM »
// de js/aih_menu.js).
//
// Couverture :
//   1. PUT édition avec champ clé VIDE → le body ne contient PAS `api_key`
//      (préserve la clé chiffrée existante ; miroir de app-filters.js).
//   2. PUT édition avec clé fournie → `api_key` transmise.
//   3. POST création (même clé vide) → `api_key` transmise (contrat du POST).
//   4. Dup → POST /api/presets/<id>/duplicate (endpoint dédié : copie la clé
//      chiffrée + force is_global=0), jamais POST /api/presets.
//
// Usage : node js/test_aih_preset_save.mjs
//   jsdom est résolu par le helper partagé js/test_helpers/jsdom_loader.mjs ;
//   introuvable = SKIP bruyant (exit 2).
//
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_aih_preset_save");

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
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };

localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "https://aih.test", apiKey: "k" }));
localStorage.setItem("aih_locale", "fr");

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

// ── Serveur distant mocké : enregistre CHAQUE requête (méthode + body) ──
const requests = [];

function jsonResponse(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
        json: async () => data,
        text: async () => JSON.stringify(data),
    };
}

const PRESETS = [{
    id: "p-1", name: "Preset 1", model: "m1", base_url: "http://x/v1",
    is_global: 0, is_client_side: false,
    context_length: 64000, context_source: "auto",
}];

window.fetch = globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = ((init && init.method) || "GET").toUpperCase();
    let body = null;
    if (init && init.body) {
        try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    requests.push({ url: u, method, body });
    if (/\/api\/presets\/[^/]+\/duplicate$/.test(u) && method === "POST") {
        return jsonResponse({ id: "p-dup", name: "Preset 1 (copie)" }, 201);
    }
    if (/\/api\/presets\/[^/]+$/.test(u) && method === "PUT") return jsonResponse({ status: "ok" });
    if (/\/api\/presets$/.test(u) && method === "GET") return jsonResponse(PRESETS);
    if (/\/api\/presets$/.test(u) && method === "POST") return jsonResponse({ id: "p-new", name: "Nouveau" }, 201);
    return jsonResponse({ error: "not found" }, 404);
};

await import("./aih_i18n.js");
await import("./aih_menu.js");

const doc = window.document;
const flush = () => new Promise((r) => setTimeout(r, 30));

let alertMessage = null;
window.aihShowConfirm = () => Promise.resolve(true);
window.aihShowAlert = (_title, message) => { alertMessage = message; return Promise.resolve(); };
window.aihShowPrompt = () => Promise.resolve("");

const container = doc.createElement("div");
doc.body.appendChild(container);
await window.AIHMenu.renderProvidersTab(container);
await flush();

const byText = (label) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label);
const bodyOf = (pred) => (requests.find(pred) || {}).body;

console.log("1. PUT édition — champ clé vide");
requests.length = 0;
byText("Edit").click();
await flush();
const keyInput = container.querySelector('input[type=password]');
assert.ok(keyInput, "champ clé (password) présent");
assert.strictEqual(keyInput.value, "", "champ clé volontairement vidé à l'édition");
byText("Sauvegarder").click();
await flush();
const putEmpty = requests.find((r) => r.method === "PUT");
assert.ok(putEmpty, "un PUT a bien été émis vers le preset existant");
assert.ok(!("api_key" in putEmpty.body),
    "PUT édition + clé vide : le body ne contient PAS `api_key` (la clé chiffrée est préservée)");
assert.strictEqual(putEmpty.body.name, "Preset 1", "le reste du body est intact (name)");
assert.ok("context_length" in putEmpty.body, "context_length reste transmis");
ok("PUT édition clé vide : aucune clé api_key envoyée (pas d'écrasement par '')");

console.log("2. PUT édition — clé fournie");
requests.length = 0;
byText("Edit").click();
await flush();
keyInput.value = "sk-NEW-SECRET";
byText("Sauvegarder").click();
await flush();
const putFilled = requests.find((r) => r.method === "PUT");
assert.ok(putFilled, "un PUT a été émis");
assert.strictEqual(putFilled.body.api_key, "sk-NEW-SECRET",
    "PUT édition + clé fournie : `api_key` transmise (rotation de clé possible)");
ok("PUT édition clé fournie : api_key transmise");

console.log("3. POST création — champ clé vide");
requests.length = 0;
byText("Annuler").click();           // repasse en mode création
await flush();
const textInputs = Array.from(container.querySelectorAll('input[type=text]'));
assert.ok(textInputs.length >= 2, "champs texte présents (name, model)");
textInputs[0].value = "Nouveau";
textInputs[1].value = "m-new";
container.querySelector('input[type=url]').value = "https://api.example.com/v1";
byText("Sauvegarder").click();
await flush();
const postCreate = requests.find((r) => r.method === "POST" && /\/api\/presets$/.test(r.url));
assert.ok(postCreate, "un POST création a été émis");
assert.ok("api_key" in postCreate.body, "POST création : `api_key` transmise même vide (contrat du POST)");
assert.strictEqual(postCreate.body.api_key, "", "clé vide transmise telle quelle à la création");
ok("POST création clé vide : api_key toujours transmise (contrat inchangé)");

console.log("4. Dup — endpoint dédié /duplicate");
requests.length = 0;
byText("Dup").click();
await flush();
const dupReq = requests.find((r) => /\/api\/presets\/[^/]+\/duplicate$/.test(r.url));
assert.ok(dupReq, "Dup appelle POST /api/presets/<id>/duplicate");
assert.strictEqual(dupReq.method, "POST", "méthode POST");
assert.ok(dupReq.url.endsWith("/api/presets/p-1/duplicate"),
    "l'endpoint dédié reçoit bien l'id du preset (copie clé chiffrée + is_global=0)");
assert.ok(!requests.some((r) => r.method === "POST" && /\/api\/presets$/.test(r.url)),
    "Dup n'utilise PLUS POST /api/presets (perte de clé + is_global recopié)");
ok("Dup : endpoint dédié /duplicate utilisé (plus de POST /presets)");

console.log(`\n✅ Contrat save/Dup des presets : TOUS LES TESTS PASSENT (${n} groupes)`);
