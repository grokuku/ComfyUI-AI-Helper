// ─────────────────────────────────────────────────────────────────────────
// FRONT AI-HELPER EMBARQUÉ (aih_frontend/) — bouton « Copier » de la clé API.
//
// C'est ICI qu'était le bug réel : `loadApiKey()` (aih_frontend/js/app-admin.js)
// écrivait le TEXTE de masquage dans la VALEUR du champ `settings-api-key`, et
// `copyApiKey()` copiait cette valeur → l'utilisateur a collé la phrase
// « Clé masquée — clique sur « Regénérer »… » comme clé API sur une nouvelle
// instance ComfyUI → 401 incompréhensible.
//
// Ce banc exécute le VRAI fichier app-admin.js dans jsdom (script classique,
// eval côté fenêtre) et verrouille :
//   1. clé masquée : champ VIDE, masque en `placeholder`, bouton Copier
//      `disabled` + infobulle explicite, presse-papiers intact au clic ;
//   2. erreur réseau / absence de clé : le texte d'état reste HORS du champ ;
//   3. « Regenerer » : la clé en clair est affichée ET copiable correctement ;
//   4. garde-fou en profondeur : même avec l'état interne corrompu
//      (`apiKeyCopyable = true`) et le masque dans la valeur, `copyApiKey()`
//      refuse de copier le masque.
//
// Contrôle négatif par mutation : réintroduire le masque dans `input.value`
// (au lieu du placeholder) OU retirer le garde-fou de `copyApiKey` fait ROUGIR
// ce test (prouvé en session, cf. livrable).
//
// Usage : node js/test_aih_frontend_api_key_copy.mjs
//   jsdom est résolu par js/test_helpers/jsdom_loader.mjs ; introuvable =
//   SKIP bruyant (exit 2).
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_aih_frontend_api_key_copy");

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "..", "aih_frontend", "js", "app-admin.js"), "utf8");

const MASK = "Clé masquée — clique sur « Regénérer » pour en afficher une nouvelle.";
const REAL_KEY = "aih_real_0123456789";

const dom = new JSDOM(
    `<!doctype html><html><body>
        <span id="settings-username"></span>
        <input type="text" id="settings-api-key" readonly>
        <button id="settings-copy-key" type="button" disabled>Copier</button>
        <p id="settings-key-status" class="hidden"></p>
    </body></html>`,
    { url: "https://aih.example/", runScripts: "outside-only" }
);
const { window } = dom;

// ── Globals du site admin (app-core.js / app-filters.js en production) ───
window.API = "/api";
window.LOCAL_MODE = false;
window.currentUser = { username: "alice" };
window.showModal = () => {};
window.confirm = () => true;

// ── Stub presse-papiers : enregistre le VRAI contenu copié ───────────────
const copied = [];
Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: async (text) => { copied.push(String(text)); } },
    configurable: true,
});

// ── Stub fetch : /auth/token renvoie ce que le scénario demande ──────────
let tokenResponse = { exists: true }; // défaut : clé stockée hashée → masquée
let failNext = false;
window.fetch = async (url, init) => {
    if (failNext) {
        failNext = false;
        throw new Error("réseau coupé");
    }
    return {
        ok: true,
        status: 200,
        json: async () => tokenResponse,
    };
};

// Exécute le VRAI app-admin.js dans la fenêtre (script classique).
window.eval(SRC);

const input = window.document.getElementById("settings-api-key");
const copyBtn = window.document.getElementById("settings-copy-key");
const statusEl = window.document.getElementById("settings-key-status");
const flush = () => new Promise((r) => setTimeout(r, 10));

// ── Garde-fou exporté : reconnaissance des masques ───────────────────────
assert.strictEqual(window.apiKeyLooksMasked(MASK), true, "le masque est reconnu");
assert.strictEqual(window.apiKeyLooksMasked("Masqué"), true, "« masqué » est reconnu");
assert.strictEqual(window.apiKeyLooksMasked("Chargement..."), true, "l'état de chargement est reconnu");
assert.strictEqual(window.apiKeyLooksMasked(REAL_KEY), false, "une vraie clé n'est pas un masque");
assert.strictEqual(window.apiKeyLooksMasked(""), false, "vide ≠ masque (simplement absent)");
assert.strictEqual(window.apiKeyLooksMasked("terror123"), false, "« error » en sous-chaîne ne matche pas");

// ── 1. Clé masquée : champ vide + placeholder + copie désactivée ─────────
await window.loadApiKey();
assert.strictEqual(input.value, "",
    "la VALEUR du champ est vide : le masque n'est plus dans `input.value`");
assert.ok(!input.value.includes("masquée"),
    "copier MANUELLEMENT le champ (Ctrl+C) ne peut plus produire le masque");
assert.ok(input.placeholder.includes("masquée"),
    "le masque vit dans `placeholder` (grisé, non copiable comme valeur)");
assert.strictEqual(copyBtn.disabled, true,
    "bouton Copier désactivé quand la clé est masquée");
assert.ok(copyBtn.title.includes("masquée"),
    "infobulle explicite : « Clé masquée : clique sur « Regenerer »… »");
assert.ok(statusEl.textContent.includes("masquée"),
    "message de statut : clé masquée, inviter à régénérer");

window.copyApiKey();
await flush();
assert.deepStrictEqual(copied, [],
    "le presse-papiers ne reçoit RIEN (surtout pas le masque) quand la clé est masquée");

// ── 2. Erreur réseau : le texte d'erreur reste HORS du champ ─────────────
failNext = true;
await window.loadApiKey();
assert.strictEqual(input.value, "", "champ vide en cas d'erreur (pas de « Erreur : … » en valeur)");
assert.ok(!input.value.includes("Erreur"), "le message d'erreur n'est pas copiable comme clé");
assert.ok(statusEl.textContent.includes("Erreur"), "l'erreur est affichée dans le statut");
assert.strictEqual(copyBtn.disabled, true, "copie désactivée en cas d'erreur");

// ── 3. « Regenerer » : clé en clair affichée ET copiable ─────────────────
tokenResponse = { token: REAL_KEY };
await window.regenerateApiKey();
assert.strictEqual(input.value, REAL_KEY, "après Regenerer : la clé en clair est affichée");
assert.strictEqual(input.placeholder, "", "plus de placeholder de masque après Regenerer");
assert.strictEqual(copyBtn.disabled, false, "après Regenerer : bouton Copier actif");

window.copyApiKey();
await flush();
assert.deepStrictEqual(copied, [REAL_KEY],
    "le presse-papiers reçoit EXACTEMENT la clé en clair après Regenerer");
assert.ok(!copied.includes(MASK), "jamais le masque dans le presse-papiers");

// ── 3bis. Rechargement d'une clé réelle : copiable aussi ─────────────────
input.value = "";
await window.loadApiKey();
assert.strictEqual(input.value, REAL_KEY, "loadApiKey expose la vraie clé renvoyée");
assert.strictEqual(copyBtn.disabled, false, "copie active pour une vraie clé chargée");

// ── 4. Garde-fou en profondeur : état corrompu + masque en valeur ────────
window.apiKeyCopyable = true;       // régression simulée : l'état prétend « copiable »
input.value = MASK;                 // ...et la valeur redevient le masque
copied.length = 0;
window.copyApiKey();
await flush();
assert.deepStrictEqual(copied, [],
    "même corrompu, copyApiKey refuse de copier le masque (garde-fou sur la VALEUR)");
assert.ok(statusEl.textContent.includes("masquée"),
    "message explicite : clé masquée, régénère avant de copier");

console.log("✅ Front AI-HELPER — bouton Copier de la clé API : TOUS LES TESTS PASSENT");
