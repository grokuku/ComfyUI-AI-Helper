// ─────────────────────────────────────────────────────────────────────────
// URL DU SERVEUR AIH — normalisation + injection Bearer (js/aih_fetch_bridge.js).
//
// Régression attrapée : l'URL saisie par l'utilisateur était utilisée TELLE
// QUELLE (hors suppression du slash final) pour construire les appels au
// serveur distant. Trois saisies pourtant courantes cassaient la connexion :
//   - "aih.holaf.fr"            → chemin RELATIF à l'origine ComfyUI → 404 ;
//   - "https://aih.holaf.fr/api"→ double "/api/api/..." → 404 ;
//   - slash final               → déjà géré.
// Symptôme utilisateur : « je n'arrive plus à me connecter à mon serveur sur
// un nouveau ComfyUI alors que j'ai rentré l'adresse du serveur ».
//
// Ce test verrouille :
//   1. normalizeServerUrl : schéma implicite (celui de la page), slash final,
//      suffixe "/api", idempotence, cas vides ;
//   2. le bridge : serverUrl normalisée (dans localStorage OU via window.AIH)
//      → appel ABSOLU correct + en-tête Authorization: Bearer <apiKey>.
//
// Usage : node js/test_aih_server_url.mjs (aucune dépendance externe).
// Code de sortie : 0 = PASS, 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import {
    normalizeServerUrl,
    remoteGet,
    remotePost,
    remoteRequest,
} from "./aih_fetch_bridge.js";

// ── Faux globals navigateur ─────────────────────────────────────────────
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
};
// Page ComfyUI en http (LAN) : le schéma implicite doit être repris de la page.
globalThis.window = { location: { protocol: "http:" } };

const setCfg = (cfg) => localStorage.setItem("AIH_config", JSON.stringify(cfg));

// Capture des requêtes émises par la brique.
let calls = [];
function jsonResponse(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
        json: async () => data,
        text: async () => JSON.stringify(data),
    };
}
globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || "GET", headers: (init && init.headers) || {} });
    return jsonResponse({ ok: true });
};

/* ══════════════════ 1. normalizeServerUrl ═══════════════════════════════ */

// 1a. Saisie sans schéma, hôte PUBLIC → https (serveur derrière Caddy).
assert.strictEqual(normalizeServerUrl("aih.holaf.fr"), "https://aih.holaf.fr",
    "URL publique sans schéma → https");

// 1a-bis. Hôte LOCAL sans schéma → schéma de la page (http ici : LAN).
assert.strictEqual(normalizeServerUrl("192.168.1.10:5000"), "http://192.168.1.10:5000",
    "hôte privé sans schéma → schéma de la page (http)");
assert.strictEqual(normalizeServerUrl("localhost:5000"), "http://localhost:5000",
    "localhost sans schéma → http");

// 1b. Slash final retiré.
assert.strictEqual(normalizeServerUrl("https://aih.holaf.fr/"), "https://aih.holaf.fr",
    "slash final retiré");
assert.strictEqual(normalizeServerUrl("https://aih.holaf.fr///"), "https://aih.holaf.fr",
    "slashes finaux multiples retirés");

// 1c. Suffixe "/api" retiré (le bridge l'ajoute lui-même).
assert.strictEqual(normalizeServerUrl("https://aih.holaf.fr/api"), "https://aih.holaf.fr",
    "suffixe /api retiré");
assert.strictEqual(normalizeServerUrl("https://aih.holaf.fr/api/"), "https://aih.holaf.fr",
    "suffixe /api/ retiré");

// 1d. Espaces + schéma présent : conservé tel quel (hors slash final).
assert.strictEqual(normalizeServerUrl("  https://aih.holaf.fr  "), "https://aih.holaf.fr",
    "espaces de saisie ignorés");
assert.strictEqual(normalizeServerUrl("http://192.168.1.10:5000/"), "http://192.168.1.10:5000",
    "URL LAN http conservée (schéma explicite non écrasé)");

// 1e. Idempotence : normaliser deux fois = une fois.
const once = normalizeServerUrl("aih.holaf.fr/api/");
assert.strictEqual(normalizeServerUrl(once), once, "normalisation idempotente");

// 1f. Valeurs vides → "".
for (const v of ["", "   ", null, undefined]) {
    assert.strictEqual(normalizeServerUrl(v), "", `valeur vide ${JSON.stringify(v)} → ""`);
}

/* ══════════════════ 2. Bridge : résolution + Bearer ═════════════════════ */

// 2a. Chemin RELATIF + localStorage sale (sans schéma) → URL absolue correcte.
setCfg({ serverUrl: "aih.holaf.fr", apiKey: "aih_secret" });
calls = [];
await remoteGet("media?page=1");
assert.strictEqual(calls.length, 1, "un seul appel émis");
assert.strictEqual(calls[0].url, "https://aih.holaf.fr/api/media?page=1",
    "chemin relatif préfixé par la racine NORMALISÉE + /api/");
assert.strictEqual(calls[0].headers["Authorization"], "Bearer aih_secret",
    "en-tête Bearer injecté depuis apiKey");

// 2b. localStorage avec suffixe "/api" → pas de double "/api/api".
setCfg({ serverUrl: "https://aih.holaf.fr/api/", apiKey: "k2" });
calls = [];
await remotePost("workflows", { name: "wf" });
assert.strictEqual(calls[0].url, "https://aih.holaf.fr/api/workflows",
    "suffixe /api de la config neutralisé (aucun /api/api)");
assert.strictEqual(calls[0].method, "POST", "méthode POST conservée");

// 2c. URL absolue (les widgets qui construisent déjà l'URL) : utilisée telle
// quelle, le Bearer reste appliqué.
setCfg({ serverUrl: "aih.holaf.fr", apiKey: "k3" });
calls = [];
await remoteRequest("https://aih.holaf.fr/api/stats", { method: "GET" });
assert.strictEqual(calls[0].url, "https://aih.holaf.fr/api/stats", "URL absolue inchangée");
assert.strictEqual(calls[0].headers["Authorization"], "Bearer k3", "Bearer sur URL absolue");

// 2d. window.AIH (source canonique) prime et est normalisée elle aussi.
setCfg({ serverUrl: "", apiKey: "" });
globalThis.window.AIH = {
    getServerUrl: () => "aih.holaf.fr/api",
    getApiKey: () => "k4",
};
calls = [];
await remoteGet("members");
assert.strictEqual(calls[0].url, "https://aih.holaf.fr/api/members",
    "window.AIH.getServerUrl() normalisée");
assert.strictEqual(calls[0].headers["Authorization"], "Bearer k4", "clé lue via window.AIH");
delete globalThis.window.AIH;

// 2e. Serveur non configuré + chemin relatif → erreur explicite (pas d'appel).
setCfg({ serverUrl: "", apiKey: "" });
calls = [];
let threw = null;
try {
    await remoteGet("media");
} catch (e) {
    threw = e;
}
assert.ok(threw && /non configur/.test(threw.message),
    "serveur non configuré : erreur explicite attendue");
assert.strictEqual(calls.length, 0, "aucune requête émise sans serveur configuré");

console.log(
    "✅ URL serveur AIH — normalisation (schéma/slash/api) + Bearer : TOUS LES TESTS PASSENT"
);
