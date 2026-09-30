// ─────────────────────────────────────────────────────────────────────────
// ONGLET « AIH · COMPTE » — la saisie URL + clé API est normalisée puis
// utilisée pour l'authentification Bearer (chemin utilisateur RÉEL).
//
// Régression attrapée : sur une instance ComfyUI neuve, l'utilisateur saisit
// l'adresse du serveur (souvent sans schéma, ou avec un « /api » recopié du
// navigateur) ; l'URL était stockée telle quelle et le bridge fabriquait une
// URL cassée → « Serveur hors ligne ». Ici on prouve que la sauvegarde
// normalise l'URL (fichier local + localStorage) et que la sonde de statut
// interroge ensuite la BONNE URL avec le Bearer.
//
// Usage : node js/test_aih_account_url.mjs
//   jsdom est résolu par js/test_helpers/jsdom_loader.mjs ; introuvable =
//   SKIP bruyant (exit 2).
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_aih_account_url");

// Page ComfyUI servie en HTTPS : le schéma implicite saisi doit devenir https.
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "https://comfy.example/",
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };

// Nouvelle instance : aucune config en localStorage.
assert.strictEqual(localStorage.getItem("AIH_config"), null, "config vide au départ");

const calls = [];
let saved = null;

function jsonResponse(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
        json: async () => data,
        text: async () => JSON.stringify(data),
    };
}

window.fetch = globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = ((init && init.method) || "GET").toUpperCase();
    calls.push({ url: u, method, auth: ((init && init.headers) || {})["Authorization"] });

    // Route LOCALE du pack (same-origin ComfyUI).
    if (/\/aih\/credentials$/.test(u)) {
        if (method === "POST") {
            saved = JSON.parse(init.body);
            return jsonResponse({ status: "ok", path: "/fake/user/default/aih/credentials.json" });
        }
        return jsonResponse({ status: "ok", api_key: "", server_url: "", path: "/fake/...", exists: false });
    }

    // Serveur DISTANT : n'accepte QUE la bonne URL avec un Bearer.
    const auth = ((init && init.headers) || {})["Authorization"] || "";
    if (/^https:\/\/aih\.holaf\.fr\/api\/(stats|auth\/me)$/.test(u)) {
        if (!auth.startsWith("Bearer ")) return jsonResponse({ error: "Connexion requise." }, 401);
        if (/auth\/me$/.test(u)) return jsonResponse({ id: "u1", username: "alice", display_name: "Alice" });
        return jsonResponse({ total: 1 });
    }
    return jsonResponse({ error: "not found: " + u }, 404);
};

await import("./aih_i18n.js");
await import("./aih_menu.js");
window.AIH.I18n.setLocale("fr");

const doc = window.document;
const flush = () => new Promise((r) => setTimeout(r, 30));

// ── 1. Ouvrir l'onglet Compte et saisir une URL « sale » ─────────────────
const container = doc.createElement("div");
doc.body.appendChild(container);
await window.AIHMenu.renderAccountTab(container);
await flush();

const inputs = Array.from(container.querySelectorAll("input"));
assert.strictEqual(inputs.length, 2, "l'onglet expose l'URL + la clé");
inputs[0].value = "aih.holaf.fr/api/"; // schéma absent + suffixe /api + slash final
inputs[1].value = "aih_0123456789abcdef";

const saveBtn = Array.from(container.querySelectorAll("button"))
    .find((b) => /Sauvegarder|Save/.test(b.textContent));
assert.ok(saveBtn, "bouton Enregistrer présent");
saveBtn.click();
await flush();

// ── 2. La sauvegarde NORMALISE l'URL (fichier + cache localStorage) ──────
assert.ok(saved, "POST /aih/credentials émis");
assert.strictEqual(saved.server_url, "https://aih.holaf.fr",
    "URL envoyée au fichier local normalisée (schéma https + sans /api)");
const cached = JSON.parse(localStorage.getItem("AIH_config"));
assert.strictEqual(cached.serverUrl, "https://aih.holaf.fr",
    "URL du cache localStorage normalisée");
assert.strictEqual(cached.apiKey, "aih_0123456789abcdef", "clé API conservée");
assert.strictEqual(inputs[0].value, "https://aih.holaf.fr",
    "le champ affiche l'URL corrigée à l'utilisateur");

// ── 3. La sonde de statut interroge la BONNE URL avec le Bearer ──────────
calls.length = 0;
const statusEl = doc.createElement("div");
doc.body.appendChild(statusEl);
await window.AIHMenu.checkServerStatus(statusEl);
await flush();

const remoteCalls = calls.filter((c) => /aih\.holaf\.fr/.test(c.url));
assert.strictEqual(remoteCalls.length, 2, "stats + auth/me interrogés");
for (const c of remoteCalls) {
    assert.strictEqual(c.auth, "Bearer aih_0123456789abcdef", "Bearer présent sur la sonde (" + c.url + ")");
}
assert.strictEqual(statusEl.textContent, "🟢Alice",
    "l'utilisateur distant est affiché → connexion établie");

console.log("✅ Onglet Compte — URL normalisée puis sonde Bearer : TOUS LES TESTS PASSENT");
