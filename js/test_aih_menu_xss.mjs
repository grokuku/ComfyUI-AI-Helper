// ─────────────────────────────────────────────────────────────────────────
// VAGUE 17/18 — XSS STOCKÉ dans js/aih_menu.js.
//
// Preuve que TOUTE valeur fournie par le serveur (membres ET presets) est
// rendue INERTE avant interpolation innerHTML :
//   1. table des membres : nom + avatar (Vague 17) ;
//   2. message de confirmation de suppression d'un membre (AIH.confirm =
//      innerHTML) ;
//   3. rendu des PRESETS (left.innerHTML) : name / owner_name / model /
//      base_url échappés (Vague 18) ;
//   4. confirmation de suppression d'un preset (p.name → AIH.confirm) ;
//   5. message d'ERREUR serveur (body.error → AIH.alert = innerHTML).
//
// Usage : node js/test_aih_menu_xss.mjs
//   jsdom est résolu par le helper partagé js/test_helpers/jsdom_loader.mjs
//   (JSDOM_DIR → ./node_modules → ../holaf-lib/node_modules →
//    /projects/holaf-lib/node_modules) ; introuvable = SKIP bruyant (exit 2).
//
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_aih_menu_xss");

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

// Serveur distant configuré + fetch mocké (contrôlé par le test).
localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "https://aih.test", apiKey: "k" }));

const MALICIOUS_NAME = "<img src=x onerror=alert(1)>";
const MALICIOUS_NAME2 = "\"><script>alert('xss')</script>";
const MALICIOUS_AVATAR = "\"><script>alert(2)</script>";
const NORMAL_NAME = "Amélie & Jean-Luc"; // accents + esperluette : escapeHtml transparent

// Valeurs malveillantes d'origine serveur pour les presets.
const MALICIOUS_PRESET_NAME = "<img src=x onerror=alert(1)>";
const MALICIOUS_OWNER = "<script>alert('owner')</script>";
const MALICIOUS_MODEL = "\"><svg onload=alert(3)>";
const MALICIOUS_URL = "http://evil.test/\"><img src=y>";

const MEMBERS = [
    { id: "u-admin", role: "admin", display_name: "Alice", filter_count: 0, prompt_count: 0 },
    { id: "u-ok", role: "user", display_name: NORMAL_NAME, filter_count: 3, prompt_count: 7 },
    { id: "u-bad-1", role: "kw_editor", display_name: MALICIOUS_NAME, filter_count: 0, prompt_count: 0 },
    { id: "u-bad-2", role: "user", display_name: MALICIOUS_NAME2, avatar_url: MALICIOUS_AVATAR, filter_count: 0, prompt_count: 0 },
];

const PRESETS = [{
    id: "p-bad",
    name: MALICIOUS_PRESET_NAME,
    owner_name: MALICIOUS_OWNER,
    model: MALICIOUS_MODEL,
    base_url: MALICIOUS_URL,
    is_global: 0,
    is_client_side: false,
}];

// Erreur serveur (body.error) réinjectée via AIH.alert lors d'une action presets.
let presetPostError = null;
// `detail` d'origine serveur renvoyé par detect-context (contrôle XSS).
let detectDetail = null;

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
    if (/\/api\/members$/.test(u)) return jsonResponse(MEMBERS);
    if (/\/api\/auth\/me$/.test(u)) return jsonResponse({ id: "u-admin", role: "admin" });
    // Duplication : endpoint dédié (le pack ne POSTe plus sur /presets).
    if (/\/api\/presets\/[^/]+\/duplicate$/.test(u) && method === "POST") {
        if (presetPostError) return jsonResponse({ error: presetPostError }, 500);
        return jsonResponse({ status: "ok" });
    }
    // detect-context : réponse pilotée par le test (detail malveillant possible).
    if (/\/api\/presets\/[^/]+\/detect-context$/.test(u) && method === "POST") {
        return jsonResponse({ detected_length: null, source: "unknown", probe: "none",
                              status: "unreachable", detail: detectDetail });
    }
    if (/\/api\/presets$/.test(u) && method === "POST") {
        if (presetPostError) return jsonResponse({ error: presetPostError }, 500);
        return jsonResponse({ status: "ok" });
    }
    if (/\/api\/presets$/.test(u)) return jsonResponse(PRESETS);
    return jsonResponse({ error: "not found" }, 404);
};

// Import du module RÉEL (installe window.AIHMenu, window.aihOpenModalV2, etc.).
await import("./aih_i18n.js");
await import("./aih_menu.js");
// Locale figée en FR : les libellés (Edit/Dup/Del) sont identiques dans les
// deux langues, mais « Détecter » est nécessaire pour le bloc detect-context.
window.AIH.I18n.setLocale("fr");

const doc = window.document;
const flush = () => new Promise((r) => setTimeout(r, 20));

// Sonde commune : reproduit EXACTEMENT l'insertion innerHTML des helpers
// (AIH.confirm / AIH.alert / AIH.prompt passent leur message en innerHTML).
const probe = doc.createElement("div");
doc.body.appendChild(probe);
let confirmMessage = null;
let alertMessage = null;
window.aihShowConfirm = (_title, message) => {
    confirmMessage = message;
    probe.innerHTML = message;
    return Promise.resolve(false); // refus : n'exécute aucune action destructive
};
window.aihShowAlert = (_title, message) => {
    alertMessage = message;
    probe.innerHTML = message;
    return Promise.resolve();
};

/* ══════════════════ 1. MEMBRES (Vague 17) ═══════════════════════════════ */
// Modale stubbée : on ne teste QUE le rendu du corps.
const modalBody = doc.createElement("div");
doc.body.appendChild(modalBody);
window.aihOpenModalV2 = () => ({ body: modalBody, close() {} });

await window.AIHMenu.openMembers();

// 1a. Cellule du tableau : nom malveillant inerte
assert.strictEqual(modalBody.querySelectorAll("script").length, 0,
    "aucun <script> injecté dans le tableau");
assert.strictEqual(modalBody.querySelectorAll("img[onerror]").length, 0,
    "aucun <img onerror> injecté par le nom");
assert.strictEqual(modalBody.querySelectorAll("img[src='x']").length, 0,
    "aucun <img src=x> injecté par le nom");

const cellTexts = Array.from(modalBody.querySelectorAll("tr td:first-child span")).map((s) => s.textContent);
assert.ok(cellTexts.includes(MALICIOUS_NAME),
    "le nom <img …> s'affiche en TEXTE dans la cellule");
assert.ok(cellTexts.includes(MALICIOUS_NAME2),
    "le nom \"><script>… s'affiche en TEXTE dans la cellule");
assert.ok(cellTexts.includes(NORMAL_NAME),
    "nom normal (accents + esperluette) affiché à l'identique, sans altération visible");

// 1b. src d'avatar : valeur serveur gardée comme attribut (pas de breakout)
const avatarImgs = Array.from(modalBody.querySelectorAll("img"));
assert.strictEqual(avatarImgs.length, 1, "un seul <img> : l'avatar légitime, aucun créé par les noms");
assert.strictEqual(avatarImgs[0].getAttribute("src"), MALICIOUS_AVATAR,
    "le src malveillant est conservé comme VALEUR d'attribut (échappé), sans créer de tag");

// 1c. Confirmation de suppression membre : nom échappé, aucune balise
const delBtns = Array.from(modalBody.querySelectorAll(".aih-member-del"));
const target = delBtns.find((b) => b.getAttribute("data-name") === MALICIOUS_NAME);
assert.ok(target, "bouton de suppression du membre au nom malveillant présent");
target.click();
await flush();
assert.ok(typeof confirmMessage === "string" && confirmMessage.length > 0,
    "le message de confirmation a bien été construit");
assert.ok(confirmMessage.includes("&lt;img") && !confirmMessage.includes("<img"),
    "le nom est ÉCHAPPÉ dans le message (entités HTML, pas de balise brute)");
assert.strictEqual(probe.querySelectorAll("script, img").length, 0,
    "aucun élément <script>/<img> injecté par le message de confirmation");
assert.ok(probe.textContent.includes(MALICIOUS_NAME),
    "le nom s'affiche en TEXTE dans la confirmation (entités décodées)");

// 1d. Nom NORMAL : confirmation rendue à l'identique (pas d'entités visibles)
const normalBtn = delBtns.find((b) => b.getAttribute("data-name") === NORMAL_NAME);
assert.ok(normalBtn, "bouton de suppression du membre au nom normal présent");
normalBtn.click();
await flush();
assert.ok(probe.textContent.includes(NORMAL_NAME),
    "message de confirmation : le nom normal est rendu à l'identique (espaces, &, accents)");
assert.strictEqual(probe.querySelectorAll("script, img").length, 0,
    "aucun élément injecté par le message d'un nom normal");

/* ══════════════════ 2. PRESETS (Vague 18) ═══════════════════════════════ */
const providerContainer = doc.createElement("div");
doc.body.appendChild(providerContainer);
await window.AIHMenu.renderProvidersTab(providerContainer);

// 2a. Aucune balise injectée par name / owner_name / model / base_url.
assert.strictEqual(providerContainer.querySelectorAll("script, img, svg").length, 0,
    "aucun <script>/<img>/<svg> injecté par les champs de preset");

// 2b. Les valeurs serveur s'affichent en TEXTE.
const strongEl = providerContainer.querySelector("strong");
assert.ok(strongEl, "le nom du preset est rendu dans un <strong>");
assert.strictEqual(strongEl.textContent, MALICIOUS_PRESET_NAME,
    "le nom malveillant du preset s'affiche en TEXTE (aucune balise)");

const presetSpans = Array.from(providerContainer.querySelectorAll("span"));
const scopeSpan = presetSpans.find((s) => s.textContent.includes("("));
assert.ok(scopeSpan, "le scope (owner_name) est rendu");
assert.ok(scopeSpan.textContent.includes(MALICIOUS_OWNER),
    "owner_name malveillant affiché en TEXTE dans le scope");
const modelSpan = presetSpans.find((s) => s.textContent.includes("@"));
assert.ok(modelSpan, "la ligne model @ base_url est rendue");
assert.ok(modelSpan.textContent.includes(MALICIOUS_MODEL) && modelSpan.textContent.includes(MALICIOUS_URL),
    "model + base_url malveillants affichés en TEXTE");

// 2c. Confirmation de suppression d'un preset : p.name échappé.
confirmMessage = null;
probe.innerHTML = "";
const presetButtons = Array.from(providerContainer.querySelectorAll("button"));
const presetDelBtn = presetButtons.find((b) => b.textContent === "Del");
assert.ok(presetDelBtn, "bouton de suppression de preset présent");
presetDelBtn.click();
await flush();
assert.ok(confirmMessage && confirmMessage.includes("&lt;img") && !confirmMessage.includes("<img"),
    "suppression preset : p.name est ÉCHAPPÉ dans la confirmation");
assert.strictEqual(probe.querySelectorAll("script, img, svg").length, 0,
    "aucun élément injecté par la confirmation de preset");

// 2d. Message d'ERREUR serveur (body.error → AIH.alert) échappé.
alertMessage = null;
probe.innerHTML = "";
presetPostError = MALICIOUS_PRESET_NAME;
const dupBtn = presetButtons.find((b) => b.textContent === "Dup");
assert.ok(dupBtn, "bouton de duplication de preset présent");
dupBtn.click();
await flush();
assert.ok(alertMessage && alertMessage.includes("&lt;img") && !alertMessage.includes("<img"),
    "erreur serveur : e.message est ÉCHAPPÉ dans l'alerte");
assert.strictEqual(probe.querySelectorAll("script, img, svg").length, 0,
    "aucun élément injecté par le message d'erreur serveur");
assert.ok(probe.textContent.includes(MALICIOUS_PRESET_NAME),
    "le message d'erreur s'affiche en TEXTE (entités décodées)");

/* ══════════ 3. DETECT-CONTEXT (detail serveur échappé) ═════════════════ */
// Le `detail` renvoyé par POST /api/presets/<id>/detect-context est une donnée
// d'origine serveur injectée dans AIH.alert (innerHTML) : il DOIT être échappé.
// Retirer escapeHtml() sur cette interpolation doit faire ÉCHOUER ce bloc.
const editBtn = Array.from(providerContainer.querySelectorAll("button"))
    .find((b) => b.textContent === "Edit");
assert.ok(editBtn, "bouton Edit présent pour tester la détection");
editBtn.click();
await flush();

const detectBtn = Array.from(providerContainer.querySelectorAll("button"))
    .find((b) => b.textContent === "Détecter");
assert.ok(detectBtn, "bouton Détecter présent");
alertMessage = null;
probe.innerHTML = "";
detectDetail = MALICIOUS_PRESET_NAME;   // <img src=x onerror=alert(1)>
detectBtn.click();
await flush(); await flush();
assert.ok(alertMessage && alertMessage.includes("&lt;img") && !alertMessage.includes("<img"),
    "detect-context : le `detail` serveur est ÉCHAPPÉ dans l'alerte");
assert.strictEqual(probe.querySelectorAll("script, img, svg").length, 0,
    "aucun élément injecté par le detail de detect-context");
assert.ok(probe.textContent.includes(MALICIOUS_PRESET_NAME),
    "le detail s'affiche en TEXTE (entités décodées)");

console.log("✅ VAGUES 17/18 — XSS rendu INERTE : membres (nom/avatar/confirm), presets (name/owner/model/url/confirm), erreur serveur et detail detect-context : TOUS LES TESTS PASSENT");
