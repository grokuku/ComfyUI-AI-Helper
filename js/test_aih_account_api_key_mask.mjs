// ─────────────────────────────────────────────────────────────────────────
// ONGLET « AIH · COMPTE » — la clé API masquée n'est JAMAIS copiée/sauvée.
//
// Bug réel (utilisateur) : le masquage d'affichage mettait le TEXTE
// « Clé masquée — clique sur « Régénérer » pour en afficher une nouvelle. »
// dans la VALEUR du champ `input` ; le bouton « Copier » recopiait donc ce
// texte, que l'utilisateur a collé comme clé API sur une nouvelle instance
// ComfyUI → connexion refusée (401) avec un message incompréhensible.
//
// Ce banc verrouille le correctif de renderCompteTab (js/aih_menu.js) :
//   1. masque dans `placeholder`, champ VIDE (jamais le masque en valeur) ;
//   2. bouton « Copier » DÉSACTIVÉ tant qu'aucune vraie clé en clair ;
//   3. clic « Copier » (même bouton ré-activé de force) → presse-papiers
//      intact, JAMAIS le masque ; infobulle/message explicites ;
//   4. saisie d'une VRAIE clé → activé, et le presse-papiers reçoit la vraie
//      valeur (stub navigator.clipboard.writeText) ;
//   5. sauvegarde avec un masque → refusée, aucun POST /aih/credentials,
//      champ nettoyé (le masque ne peut pas être persisté) ;
//   6. clé déjà enregistrée = masque (GET /aih/credentials avec
//      api_key_masked) → ignorée, avertissement affiché ;
//   7. bridge : une clé masquée en localStorage n'est jamais envoyée en
//      Authorization: Bearer (aucune requête distante émise).
//
// Usage : node js/test_aih_account_api_key_mask.mjs
//   jsdom est résolu par js/test_helpers/jsdom_loader.mjs ; introuvable =
//   SKIP bruyant (exit 2).
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_aih_account_api_key_mask");

const MASK = "Clé masquée — clique sur « Regénérer » pour en afficher une nouvelle.";
const REAL_KEY = "aih_0123456789abcdef";

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

// ── Stub presse-papiers (le VRAI contenu copié est enregistré ici) ───────
const copied = [];
Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: async (text) => { copied.push(String(text)); } },
    configurable: true,
});
try {
    Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
} catch { /* navigator Node non configurable : le repli execCommand est testé plus bas */ }

// ── localStorage : clé DÉJÀ ENREGISTRÉE qui est en réalité le masque ────
// C'est l'état de l'utilisateur : le masque a été collé puis sauvegardé.
localStorage.setItem("AIH_config", JSON.stringify({
    serverUrl: "aih.holaf.fr",
    apiKey: MASK,
}));

// ── Stub fetch : GET credentials signale la clé masquée (blanchie) ───────
const calls = [];
const posts = [];

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
    calls.push({ url: u, method });

    // Route LOCALE du pack (same-origin ComfyUI).
    if (/\/aih\/credentials$/.test(u)) {
        if (method === "POST") {
            posts.push(JSON.parse(init.body));
            return jsonResponse({ status: "ok", path: "/fake/user/default/aih/credentials.json" });
        }
        // Le backend ne renvoie JAMAIS un masque comme clé : valeur blanchie
        // + drapeau api_key_masked (rattrapage de l'état existant).
        return jsonResponse({
            status: "ok",
            api_key: "",
            api_key_masked: true,
            server_url: "https://aih.holaf.fr",
            path: "/fake/user/default/aih/credentials.json",
            exists: true,
        });
    }
    return jsonResponse({ status: "error", message: "unexpected " + u }, 404);
};

await import("./aih_i18n.js");
await import("./aih_menu.js");
window.AIH.I18n.setLocale("fr");

const doc = window.document;
const flush = () => new Promise((r) => setTimeout(r, 30));

// ── 1. Rendu : champ VIDE + masque en placeholder + copie désactivée ─────
const container = doc.createElement("div");
doc.body.appendChild(container);
await window.AIHMenu.renderAccountTab(container);
await flush();

const inputs = Array.from(container.querySelectorAll("input"));
assert.strictEqual(inputs.length, 2, "l'onglet expose l'URL + la clé");
const inputKey = inputs[1];

assert.strictEqual(inputKey.value, "",
    "champ clé VIDE : le texte de masquage ne doit JAMAIS être dans la valeur");
assert.ok(!inputKey.value.includes("masquée"),
    "la VALEUR du champ ne contient pas le masque (copier manuel impossible)");
assert.ok(inputKey.placeholder.includes("masquée"),
    "le masque vit dans l'attribut placeholder (grisé, non copiable comme valeur)");

const statusEl = container.querySelector("p");
const copyBtn = Array.from(container.querySelectorAll("button"))
    .find((b) => /Copier|Copy/.test(b.textContent));
assert.ok(copyBtn, "bouton « Copier » présent dans l'onglet Compte");
assert.strictEqual(copyBtn.disabled, true,
    "copie désactivée : aucune vraie clé connue en clair");
assert.ok((copyBtn.title || "").includes("masquée"),
    "infobulle explicite (« masquée ») sur le bouton désactivé");
assert.ok(statusEl.textContent.includes("masquage"),
    "avertissement clair : la clé enregistrée est un texte de masquage");

// ── 2. Clic « Copier » (même ré-activé de force) : jamais le masque ──────
copyBtn.disabled = false; // simulation d'une régression UI : le garde-fou doit tenir
copyBtn.click();
await flush();
assert.deepStrictEqual(copied, [],
    "le presse-papiers ne reçoit RIEN quand la clé est masquée (jamais le masque)");
assert.ok(statusEl.textContent.includes("masquée"),
    "message explicite après le refus de copie");

// ── 3. Saisie d'une VRAIE clé → copiable correctement ────────────────────
inputKey.value = REAL_KEY;
inputKey.dispatchEvent(new window.Event("input", { bubbles: true }));
assert.strictEqual(copyBtn.disabled, false, "vraie clé saisie → bouton Copier actif");

copyBtn.click();
await flush();
assert.deepStrictEqual(copied, [REAL_KEY],
    "le presse-papiers reçoit EXACTEMENT la vraie clé");
assert.ok(!copied.includes(MASK), "le masque n'a jamais été copié");

// ── 4. Masque re-collé à la main → copie refusée + sauvegarde refusée ────
inputKey.value = MASK;
inputKey.dispatchEvent(new window.Event("input", { bubbles: true }));
assert.strictEqual(copyBtn.disabled, true, "masque re-saisi → copie re-désactivée");
copyBtn.disabled = false; // régression UI simulée
copyBtn.click();
await flush();
assert.deepStrictEqual(copied, [REAL_KEY], "toujours AUCUN masque copié");

const saveBtn = Array.from(container.querySelectorAll("button"))
    .find((b) => /Sauvegarder|Save/.test(b.textContent));
assert.ok(saveBtn, "bouton Enregistrer présent");
saveBtn.click();
await flush();
assert.strictEqual(posts.length, 0,
    "le masque n'est JAMAIS envoyé à POST /aih/credentials (impossible à persister)");
assert.ok(statusEl.textContent.includes("Refusé"),
    "message clair de refus de sauvegarde du masque");
assert.strictEqual(inputKey.value, "", "champ nettoyé après refus (aucun masque résiduel)");

// ── 5. La vraie clé reste acceptée (le garde-fou ne bloque pas les vraies) ─
inputKey.value = REAL_KEY;
inputKey.dispatchEvent(new window.Event("input", { bubbles: true }));
saveBtn.click();
await flush();
assert.strictEqual(posts.length, 1, "POST /aih/credentials émis pour la vraie clé");
assert.strictEqual(posts[0].api_key, REAL_KEY, "la vraie clé est bien enregistrée");
const cached = JSON.parse(localStorage.getItem("AIH_config"));
assert.strictEqual(cached.apiKey, REAL_KEY, "cache localStorage mis à jour avec la vraie clé");

// ── 6. Bridge : clé masquée en localStorage ≠ Bearer ─────────────────────
assert.strictEqual(window.AIHFetchBridge.isMaskedApiKey(MASK), true,
    "le garde-fou du bridge reconnaît le masque");
assert.strictEqual(window.AIHFetchBridge.isMaskedApiKey(REAL_KEY), false,
    "une vraie clé n'est pas prise pour un masque");

localStorage.setItem("AIH_config", JSON.stringify({
    serverUrl: "https://aih.holaf.fr",
    apiKey: MASK,
}));
calls.length = 0;
await assert.rejects(
    () => window.AIHFetchBridge.remoteGet("stats"),
    (err) => {
        assert.strictEqual(err.data && err.data.code, "API_KEY_MASKED",
            "erreur locale explicite (code API_KEY_MASKED) au lieu d'un Bearer masqué");
        return true;
    },
    "remoteGet doit refuser une clé masquée au lieu de l'envoyer en Bearer"
);
assert.strictEqual(calls.filter((c) => /aih\.holaf\.fr/.test(c.url)).length, 0,
    "aucune requête distante émise avec un masque (pas de Bearer masqué)");

console.log("✅ Onglet Compte — clé masquée jamais copiée/sauvée/Bearer : TOUS LES TESTS PASSENT");
