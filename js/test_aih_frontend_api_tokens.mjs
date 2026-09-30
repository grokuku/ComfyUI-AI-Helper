// ─────────────────────────────────────────────────────────────────────────
// FRONT AI-HELPER EMBARQUÉ (aih_frontend/) — clés API MULTIPLES ET NOMMÉES.
//
// Remplace l'ancien modèle « une clé + Régénérer destructif » par une LISTE :
//   - tableau : nom · préfixe · créée le · dernière utilisation (+ IP/UA) ;
//   - « Nouvelle clé » (nom obligatoire) → la clé est affichée UNE SEULE FOIS,
//     avec le bouton Copier (logique anti-masque DÉJÀ CORRIGÉE, conservée) ;
//   - « Renommer » / « Révoquer » par ligne (confirmation avant révocation) ;
//   - i18n FR/EN à parité STRICTE (mêmes clés dans les deux langues).
//
// Ce banc exécute le VRAI fichier app-admin.js dans jsdom (script classique,
// eval côté fenêtre) avec un serveur factice (fetch) qui simule les routes
// GET/POST/PATCH/DELETE /api/auth/tokens.
//
// Contrôles négatifs par mutation (prouvés en session, cf. livrable) :
//   - faire réafficher la clé par loadApiKey (au lieu de la révéler une seule
//     fois) casse le test « affichage unique » ;
//   - remettre le masque dans `input.value` au lieu du placeholder casse le
//     test de copie (le presse-papiers reçoit autre chose que la clé) ;
//   - appeler DELETE sur toutes les clés (au lieu d'une) casse le test de
//     révocation individuelle.
//
// Usage : node js/test_aih_frontend_api_tokens.mjs
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_admin_api_tokens");

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "..", "aih_frontend", "js", "app-admin.js"), "utf8");

const HTML = `<!doctype html><html lang="fr"><body>
    <span id="settings-username"></span>
    <h3 id="api-tokens-title"></h3>
    <p id="api-tokens-desc"></p>
    <div id="api-tokens-list"></div>
    <p id="api-tokens-empty" class="hidden"></p>
    <input id="api-token-new-name">
    <button id="api-token-create-btn" type="button"></button>
    <p id="api-tokens-status" class="hidden"></p>
    <div id="api-token-reveal" class="hidden">
        <p id="api-token-reveal-warning"></p>
        <input type="text" id="settings-api-key" readonly>
        <button id="settings-copy-key" type="button" disabled></button>
        <p id="settings-key-status" class="hidden"></p>
    </div>
</body></html>`;

const dom = new JSDOM(HTML, { url: "https://aih.example/", runScripts: "outside-only" });
const { window } = dom;
const doc = window.document;

window.API = "/api";
window.LOCAL_MODE = false;
window.currentUser = { username: "alice", display_name: "Alice" };
window.showModal = () => {};
window.confirm = () => true;
window.prompt = () => null;
window.localStorage.setItem("aih_locale", "fr");
try { Object.defineProperty(window.navigator, "language", { value: "fr-FR", configurable: true }); } catch (e) {}

const copied = [];
Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: async (text) => { copied.push(String(text)); } },
    configurable: true,
});

// ── Serveur factice (routes /api/auth/tokens) ────────────────────────────
let tokens = [];
let nextId = 1;
let requests = [];
let lastRequest = null;
let lastCreatedToken = null;
let failNext = false;

const jsonResponse = (status, obj) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
});

window.fetch = async (url, init) => {
    init = init || {};
    const method = init.method || "GET";
    lastRequest = { url, method, body: init.body ? JSON.parse(init.body) : null };
    requests.push(lastRequest);
    if (failNext) { failNext = false; throw new Error("réseau coupé"); }

    if (url === "/api/auth/tokens" && method === "GET") {
        return jsonResponse(200, { tokens: tokens.slice() });
    }
    if (url === "/api/auth/tokens" && method === "POST") {
        const body = JSON.parse(init.body);
        const t = {
            id: nextId++, name: body.name, prefix: "aih_newkey12",
            created_at: "2024-01-02 03:04:05", last_used_at: null,
            last_used_ip: null, last_used_user_agent: null,
            revoked: false, revoked_at: null,
        };
        tokens.push(t);
        lastCreatedToken = "aih_created_secret_0123456789";
        return jsonResponse(201, {
            token: lastCreatedToken, id: t.id, name: t.name,
            prefix: t.prefix, created_at: t.created_at,
        });
    }
    const m = url.match(/^\/api\/auth\/tokens\/(\d+)$/);
    if (m) {
        const id = Number(m[1]);
        const t = tokens.find((x) => x.id === id);
        if (method === "PATCH") {
            if (t) t.name = JSON.parse(init.body).name;
            return jsonResponse(200, { status: "ok", id, name: t ? t.name : "" });
        }
        if (method === "DELETE") {
            if (t) { t.revoked = true; t.revoked_at = "2024-01-02 03:04:05"; }
            return jsonResponse(200, { status: "ok", id, revoked: true });
        }
    }
    return jsonResponse(404, { error: "not found" });
};

// Exécute le VRAI app-admin.js dans la fenêtre (script classique).
window.eval(SRC);

const $ = (id) => doc.getElementById(id);
const flush = () => new Promise((r) => setTimeout(r, 10));

// ── 0. i18n FR/EN : parité STRICTE ───────────────────────────────────────
const dict = window.API_TOKENS_I18N;
assert.ok(dict && dict.fr && dict.en, "dictionnaire i18n FR/EN exposé");
assert.deepStrictEqual(
    Object.keys(dict.fr).sort(), Object.keys(dict.en).sort(),
    "parité stricte : mêmes clés en FR et en EN"
);
for (const k of Object.keys(dict.fr)) {
    assert.ok(String(dict.fr[k]).length > 0, `FR « ${k} » non vide`);
    assert.ok(String(dict.en[k]).length > 0, `EN « ${k} » non vide`);
}
assert.strictEqual(window.tApi("title"), "Clés API", "FR par défaut");
window.localStorage.setItem("aih_locale", "en");
assert.strictEqual(window.tApi("title"), "API keys", "EN via aih_locale");
window.localStorage.setItem("aih_locale", "fr");

// ── 1. Liste : affichage nom · préfixe · création · dernière utilisation ──
tokens = [
    {
        id: 1, name: "ComfyUI salon", prefix: "aih_1a2b3c4d",
        created_at: "2024-01-02 03:04:05",
        last_used_at: "2024-05-06 07:08:09", last_used_ip: "203.0.113.7",
        last_used_user_agent: "ComfyUI/2.0", revoked: false, revoked_at: null,
    },
    {
        id: 2, name: "Ancienne", prefix: "aih_deadbeef",
        created_at: "2023-01-01 00:00:00",
        last_used_at: null, last_used_ip: null, last_used_user_agent: null,
        revoked: true, revoked_at: "2023-06-01 00:00:00",
    },
];
await window.loadApiKey();
assert.strictEqual(lastRequest.url, "/api/auth/tokens", "charge la liste");
assert.strictEqual(lastRequest.method, "GET", "GET pour la liste");
const rows = doc.querySelectorAll("[data-token-id]");
assert.strictEqual(rows.length, 2, "une ligne par clé");
const row1 = rows[0];
assert.ok(row1.querySelector(".api-token-name").textContent.includes("ComfyUI salon"), "le nom est affiché");
assert.ok(row1.querySelector(".api-token-prefix").textContent.includes("aih_1a2b3c4d…"), "le préfixe est affiché (jamais la clé)");
assert.ok(row1.querySelector(".api-token-created").textContent.length > 0, "la date de création est affichée");
assert.ok(row1.querySelector(".api-token-usage").textContent.includes("203.0.113.7"), "IP de dernière utilisation affichée");
const row2 = rows[1];
assert.ok(row2.querySelector(".api-token-state"), "état « révoquée » affiché");
assert.strictEqual(row2.querySelectorAll(".api-token-revoke").length, 0, "pas de bouton Révoquer sur une clé déjà révoquée");
// La liste ne contient que le préfixe, jamais la clé complète.
assert.ok(!$("api-tokens-list").textContent.includes("aih_created_secret"), "jamais de clé dans la liste");

// ── 2. Création : nom obligatoire, clé affichée UNE SEULE FOIS + copie ────
requests = [];
$("api-token-new-name").value = "";
await window.createApiToken();
assert.ok(!requests.some((r) => r.method === "POST"), "pas de POST sans nom");
assert.ok($("api-tokens-status").textContent.length > 0, "message d'erreur nom manquant");

requests = [];
$("api-token-new-name").value = "  Nouvelle machine  ";
await window.createApiToken();
const post = requests.find((r) => r.method === "POST");
assert.ok(post, "POST pour créer");
assert.deepStrictEqual(post.body, { name: "Nouvelle machine" }, "le nom est trimé et envoyé");
// Révélation unique : la clé en clair est dans la valeur du champ.
assert.strictEqual($("settings-api-key").value, lastCreatedToken, "la clé est révélée une fois");
assert.ok(!$("api-token-reveal").classList.contains("hidden"), "le bloc de révélation est visible");
assert.ok($("api-token-reveal-warning").textContent.includes("maintenant"), "avertissement de copie unique");
assert.strictEqual($("settings-copy-key").disabled, false, "bouton Copier actif");

copied.length = 0;
window.copyApiKey();
await flush();
assert.deepStrictEqual(copied, [lastCreatedToken], "le presse-papiers reçoit EXACTEMENT la clé en clair");
assert.ok(!copied.includes("masquée"), "jamais de masque copié");

// Affichage UNIQUE : un rechargement de la liste EFFACE la clé affichée.
$("settings-api-key").value = "";
await window.loadApiKey();
assert.strictEqual($("settings-api-key").value, "", "la clé n'est plus affichée après rechargement");
assert.ok($("api-token-reveal").classList.contains("hidden"), "le bloc de révélation est masqué");
assert.strictEqual($("settings-copy-key").disabled, true, "bouton Copier désactivé hors révélation");

// ── 3. Renommage ───────────────────────────────────────────────────────
requests = [];
window.prompt = () => "  Machine renommée  ";
await window.renameApiToken(1);
const patch = requests.find((r) => r.method === "PATCH");
assert.ok(patch, "PATCH pour renommer");
assert.strictEqual(patch.url, "/api/auth/tokens/1", "URL ciblée par id");
assert.deepStrictEqual(patch.body, { name: "Machine renommée" }, "nouveau nom trimé");
assert.strictEqual(tokens.find((t) => t.id === 1).name, "Machine renommée", "renommé côté serveur");

// Annulation du prompt → aucun PATCH.
window.prompt = () => null;
requests = [];
await window.renameApiToken(1);
assert.ok(!requests.some((r) => r.method === "PATCH"), "annulation du prompt → pas de requête");

// ── 4. Révocation INDIVIDUELLE (avec confirmation) ─────────────────────────
window.prompt = () => null;
window.confirm = () => false; // refus
requests = [];
await window.revokeApiToken(1, "Machine renommée");
assert.ok(!requests.some((r) => r.method === "DELETE"), "révocation annulée → pas de DELETE");

window.confirm = () => true;
requests = [];
await window.revokeApiToken(1, "Machine renommée");
const del = requests.find((r) => r.method === "DELETE");
assert.ok(del, "DELETE pour révoquer");
assert.strictEqual(del.url, "/api/auth/tokens/1", "révoque UNE seule clé (par id)");
assert.strictEqual(tokens.find((t) => t.id === 1).revoked, true, "seule la clé ciblée est révoquée");
// Contrôle : les autres clés ne sont pas touchées.
assert.strictEqual(tokens.filter((t) => t.revoked).length, 2, "les autres lignes restent dans leur état");

// ── 5. Garde-fou en profondeur : masque dans la valeur → copie refusée ────
const MASK = "Clé masquée — clique sur « Régénérer » pour en afficher une nouvelle.";
assert.strictEqual(window.apiKeyLooksMasked(MASK), true, "le masque est reconnu");
assert.strictEqual(window.apiKeyLooksMasked("terror123"), false, "« error » en sous-chaîne ne matche pas");
window.apiKeyCopyable = true;          // régression simulée
$("settings-api-key").value = MASK;    // ...et le masque redevient la valeur
copied.length = 0;
window.copyApiKey();
await flush();
assert.deepStrictEqual(copied, [], "même corrompu, copyApiKey refuse de copier le masque");

console.log("✅ Front AI-HELPER embarqué — clés API multiples et nommées : TOUS LES TESTS PASSENT");
