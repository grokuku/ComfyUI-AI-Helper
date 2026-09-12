// ─────────────────────────────────────────────────────────────────────────
// ÉTAPE 3 — Fenêtre de contexte LLM : helpers purs, barre de contexte Blobby
// et bouton « Détecter » de l'onglet Provider LLM (js/aih_menu.js).
//
// Couverture :
//   1. helpers purs (js/aih_context_utils.js) : 3 états (détecté / ≈ estimation
//      / inconnu), JAMAIS de 4096 inventé, coloration seuil, mapping badge et
//      messages d'échec par status ;
//   2. barre de contexte DOM (applyContextBar) : texte, tooltip, couleur ;
//   3. onglet Provider LLM : résumé dans la liste, badge de source, préremplissage,
//      et bouton « Détecter » (succès, 401, injoignable, champ absent, SSRF) —
//      la saisie manuelle reste TOUJOURS possible après un échec ;
//   4. aucun repli 4096 dans les sources ;
//   5. parité i18n FR/EN des dictionnaires.
//
// Usage : node js/test_aih_llm_context.mjs
//   jsdom est résolu par le helper partagé js/test_helpers/jsdom_loader.mjs ;
//   introuvable = SKIP bruyant (exit 2).
//
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";
import {
    normalizeContextSource,
    hasContextLength,
    formatContextCount,
    formatContextBar,
    contextBarText,
    contextBarColor,
    applyContextBar,
    contextBadgeKey,
    contextBadgeTitleKey,
    contextSummaryKey,
    contextSummaryText,
    contextDetectStatusKey,
} from "./aih_context_utils.js";

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

/* ══════════════════ 1. Helpers PURS ═══════════════════════════════════ */
console.log("1. Helpers purs (aih_context_utils.js)");

assert.strictEqual(normalizeContextSource("manual"), "manual");
assert.strictEqual(normalizeContextSource("AUTO"), "auto");
assert.strictEqual(normalizeContextSource(" family "), "family");
assert.strictEqual(normalizeContextSource(null), "unknown");
assert.strictEqual(normalizeContextSource("garbage"), "unknown");
ok("normalizeContextSource : valeurs reconnues, le reste → unknown");

assert.strictEqual(hasContextLength(64000), true);
assert.strictEqual(hasContextLength("64000"), true);
assert.strictEqual(hasContextLength(0), false);
assert.strictEqual(hasContextLength(-1), false);
assert.strictEqual(hasContextLength(""), false);
assert.strictEqual(hasContextLength(null), false);
assert.strictEqual(hasContextLength(undefined), false);
assert.strictEqual(hasContextLength("abc"), false);
ok("hasContextLength : seuls les entiers > 0 sont exploitables");

assert.strictEqual(formatContextCount(64000), "64 000");
assert.strictEqual(formatContextCount(4096), "4 096");
assert.strictEqual(formatContextCount(500), "500");
assert.strictEqual(formatContextCount("64000"), "64 000");
ok("formatContextCount : séparateur de milliers (espace) déterministe");

// État 1 : détecté (auto), valeur connue.
const d = formatContextBar(1000, 64000, "auto");
assert.strictEqual(d.unknown, false);
assert.strictEqual(d.estimated, false);
assert.strictEqual(d.max, 64000);
assert.strictEqual(d.source, "auto");
assert.strictEqual(contextBarText(d, (k, p) => (k === "bl.ctxBar" ? "~{tokens} tokens | {max} max" : k)
    .replace("{tokens}", p.tokens).replace("{max}", p.max)), "~1000 tokens | 64 000 max");
assert.strictEqual(contextBarColor(d.ratio), "#555");
ok("barre détectée : « ~1000 tokens | 64 000 max » (couleur neutre, usage faible)");

// État 2 : estimation famille (préfixe ≈).
const f = formatContextBar(1000, 64000, "family");
assert.strictEqual(f.estimated, true);
assert.strictEqual(f.unknown, false);
const fText = contextBarText(f, (k, p) => (k === "bl.ctxBar" ? "~{tokens} tokens | {max} max" : k)
    .replace("{tokens}", p.tokens).replace("{max}", p.max));
assert.strictEqual(fText, "~1000 tokens | ≈ 64 000 max");
ok("barre estimation famille : « ~1000 tokens | ≈ 64 000 max »");

// Coloration seuil : ratio connu uniquement.
assert.strictEqual(contextBarColor(0.9), "#f87171", "> 75 % → rouge");
assert.strictEqual(contextBarColor(0.6), "#facc15", "> 50 % → jaune");
assert.strictEqual(contextBarColor(0.1), "#555", "≤ 50 % → neutre");
assert.strictEqual(contextBarColor(null), "#555", "ratio inconnu → neutre (jamais rouge)");
assert.strictEqual(contextBarColor(undefined), "#555");
assert.strictEqual(contextBarColor(NaN), "#555");
// Une estimation famille reste colorée selon le ratio (meilleure valeur
// disponible) — contrairement à l'inconnu, jamais rouge.
assert.strictEqual(contextBarColor(formatContextBar(90, 100, "family").ratio), "#f87171", "estimation à 90 % → rouge");
assert.strictEqual(contextBarColor(formatContextBar(20, 100, "family").ratio), "#555", "estimation à 20 % → neutre");
ok("coloration seuil : rouge/jaune seulement sur un ratio réellement calculable");

// État 3 : inconnu → « ? max », et AUCUN 4096.
const u = formatContextBar(1000, null, null);
assert.strictEqual(u.unknown, true);
assert.strictEqual(u.max, null);
assert.strictEqual(u.ratio, null);
assert.strictEqual(u.source, "unknown");
const uText = contextBarText(u, (k, p) => (k === "bl.ctxBar" ? "~{tokens} tokens | {max} max" : k)
    .replace("{tokens}", p.tokens).replace("{max}", p.max));
assert.strictEqual(uText, "~1000 tokens | ? max");
assert.ok(!uText.includes("4096"), "aucun 4096 affiché quand la fenêtre est inconnue");
assert.strictEqual(contextBarColor(u.ratio), "#555");
// Cas dataset vide / "0" / valeur non numérique → aussi inconnu.
for (const bogus of ["", null, undefined, "0", 0, "abc"]) {
    const b = formatContextBar(10, bogus, "auto");
    assert.strictEqual(b.unknown, true, `maxContext ${JSON.stringify(bogus)} → inconnu`);
}
ok("barre inconnue : « ~1000 tokens | ? max » — jamais de 4096 ni de repli");

// Une vraie valeur 4096 doit s'afficher telle quelle (preuve qu'on ne filtre pas).
const real = formatContextBar(100, 4096, "manual");
assert.ok(contextBarText(real, (k, p) => (k === "bl.ctxBar" ? "~{tokens} tokens | {max} max" : k)
    .replace("{tokens}", p.tokens).replace("{max}", p.max)).includes("4 096"),
    "une vraie valeur 4096 reste affichée (seul le repli inventé est banni)");
ok("4096 réel honoré ; seul le repli inventé est banni");

// Badges + tooltips.
assert.strictEqual(contextBadgeKey("manual"), "menu.ctxBadgeManual");
assert.strictEqual(contextBadgeKey("auto"), "menu.ctxBadgeAuto");
assert.strictEqual(contextBadgeKey("family"), "menu.ctxBadgeFamily");
assert.strictEqual(contextBadgeKey(null), "menu.ctxBadgeUnknown");
assert.strictEqual(contextBadgeTitleKey("family"), "menu.ctxBadgeFamilyTitle");
assert.strictEqual(contextBadgeTitleKey("nope"), "menu.ctxBadgeUnknownTitle");
ok("mapping badge/tooltip de source correct");

// Résumé de liste (4 cas).
const fakeT = (dict) => (key, params) => {
    let s = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
    if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
    return s;
};
const sumT = fakeT({
    "menu.ctxSummaryManual": "{value} tokens (manuel)",
    "menu.ctxSummaryAuto": "{value} tokens (détecté)",
    "menu.ctxSummaryFamily": "≈ {value} tokens (estimation)",
    "menu.ctxSummaryUnknown": "? contexte inconnu",
    "menu.ctxSummaryUnknownSource": "{value} tokens (? source)",
});
assert.strictEqual(contextSummaryText(64000, "manual", sumT), "64 000 tokens (manuel)");
assert.strictEqual(contextSummaryText(64000, "auto", sumT), "64 000 tokens (détecté)");
assert.strictEqual(contextSummaryText(64000, "family", sumT), "≈ 64 000 tokens (estimation)");
assert.strictEqual(contextSummaryText(null, null, sumT), "? contexte inconnu");
assert.strictEqual(contextSummaryText(64000, "", sumT), "64 000 tokens (? source)");
assert.strictEqual(contextSummaryKey("family"), "menu.ctxSummaryFamily");
ok("résumé de liste : manuel / détecté / ≈ estimation / ? inconnu");

// Messages d'échec par status.
assert.strictEqual(contextDetectStatusKey("unauthorized"), "menu.ctxDetectUnauthorized");
assert.strictEqual(contextDetectStatusKey("unreachable"), "menu.ctxDetectUnreachable");
assert.strictEqual(contextDetectStatusKey("not_found"), "menu.ctxDetectNotFound");
assert.strictEqual(contextDetectStatusKey("blocked"), "menu.ctxDetectBlocked");
assert.strictEqual(contextDetectStatusKey("weird"), "menu.ctxDetectFailed");
assert.strictEqual(contextDetectStatusKey("ok"), null);
ok("mapping status → message explicite (401 / injoignable / champ absent / SSRF)");

/* ══════════════════ 2. Barre DOM (jsdom) + 3. bouton Détecter ═════════ */
const JSDOM = await loadJsdomOrSkip("test_aih_llm_context");
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

await import("./aih_i18n.js");
// Capture des dictionnaires AVANT leur enregistrement (parité FR/EN).
const I18n = window.AIH.I18n;
const captured = {};
const origAddDict = I18n.addDict.bind(I18n);
I18n.addDict = (lang, entries) => {
    captured[lang] = Object.assign(captured[lang] || {}, entries);
    return origAddDict(lang, entries);
};
await import("./aih_strings.js");
I18n.setLocale("fr");
const t = (key, params) => I18n.t(key, params);

console.log("2. Barre de contexte DOM (applyContextBar)");
const doc = window.document;

// jsdom normalise style.color en rgb(...) : on compare à la forme normalisée.
const rgb = (hex) => {
    let m = hex.replace("#", "");
    if (m.length === 3) m = m.split("").map((c) => c + c).join("");
    return `rgb(${parseInt(m.slice(0, 2), 16)}, ${parseInt(m.slice(2, 4), 16)}, ${parseInt(m.slice(4, 6), 16)})`;
};

function makeBar() {
    const el = doc.createElement("div");
    el.id = "blobby-chat-ctx";
    doc.body.appendChild(el);
    return el;
}

// Détecté.
const barDetected = makeBar();
applyContextBar(barDetected, formatContextBar(1200, 64000, "auto"), t);
assert.strictEqual(barDetected.textContent, "~1200 tokens | 64 000 max");
assert.strictEqual(barDetected.style.color, rgb("#555"));
assert.strictEqual(barDetected.title, "");
assert.strictEqual(barDetected.style.cursor, "default");
ok("DOM détecté : texte exact, pas de tooltip, curseur normal");

// Estimation.
const barEstimated = makeBar();
applyContextBar(barEstimated, formatContextBar(1200, 64000, "family"), t);
assert.strictEqual(barEstimated.textContent, "~1200 tokens | ≈ 64 000 max");
assert.strictEqual(barEstimated.style.color, rgb("#555"));
assert.ok(barEstimated.title.includes("estimée"), "tooltip d'estimation présent");
assert.strictEqual(barEstimated.style.cursor, "pointer");
ok("DOM estimation : préfixe ≈ + tooltip + curseur cliquable");

// Inconnu.
const barUnknown = makeBar();
applyContextBar(barUnknown, formatContextBar(1200, null, null), t);
assert.strictEqual(barUnknown.textContent, "~1200 tokens | ? max");
assert.ok(!barUnknown.textContent.includes("4096"), "aucun 4096 dans la barre inconnue");
assert.strictEqual(barUnknown.style.color, rgb("#555"), "inconnu → neutre, jamais rouge");
assert.ok(barUnknown.title.includes("inconnue"), "tooltip « fenêtre inconnue » présent");
assert.strictEqual(barUnknown.style.cursor, "pointer");
ok("DOM inconnu : « ? max », curseur cliquable, aucun chiffre inventé");

// Seuil rouge quand la valeur est connue.
const barRed = makeBar();
applyContextBar(barRed, formatContextBar(90, 100, "manual"), t);
assert.strictEqual(barRed.style.color, rgb("#f87171"));
// Estimation à ratio élevé : colorée aussi (mais l'inconnu reste neutre).
applyContextBar(barRed, formatContextBar(90, 100, "family"), t);
assert.strictEqual(barRed.style.color, rgb("#f87171"), "estimation > 75 % → rouge");
assert.ok(barRed.title.includes("estimée"), "tooltip d'estimation conservé même en alerte");
ok("DOM seuil : rouge quand ~90 % de la fenêtre connue est utilisée");

/* ─── 3. Onglet Provider LLM : badge, préremplissage, bouton Détecter ── */
console.log("3. Onglet Provider LLM — contexte + bouton Détecter");

const PRESETS = [
    {
        id: "p-auto", name: "Auto 64k", model: "m1", base_url: "http://x/v1",
        is_global: 0, is_client_side: false,
        context_length: 64000, context_source: "auto",
    },
    {
        id: "p-unknown", name: "Sans contexte", model: "m2", base_url: "http://y/v1",
        is_global: 0, is_client_side: false,
        context_length: null, context_source: null,
    },
];

function jsonResponse(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
        json: async () => data,
        text: async () => JSON.stringify(data),
    };
}

// Réponse de detect-context pilotée par le test (défaut : succès famille).
let detectImpl = async () => jsonResponse({ detected_length: 64000, source: "family", probe: "models", status: "ok", detail: "" });
// Compte les GET /presets : sert à prouver le rechargement après détection.
let presetGetCalls = 0;
window.fetch = globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = ((init && init.method) || "GET").toUpperCase();
    if (/\/api\/presets\/[^/]+\/detect-context$/.test(u) && method === "POST") return detectImpl(u, init);
    if (/\/api\/presets$/.test(u) && method === "GET") { presetGetCalls++; return jsonResponse(PRESETS); }
    if (/\/api\/presets$/.test(u) && method === "POST") return jsonResponse({ status: "ok" });
    return jsonResponse({ error: "not found" }, 404);
};

const flush = () => new Promise((r) => setTimeout(r, 30));
let confirmMessage = null;
let confirmAnswer = true;
let alertMessage = null;

await import("./aih_menu.js");

// Stubs posés APRÈS l'import : aih_dialog.js définit window.aihShowConfirm/Alert.
window.aihShowConfirm = (_title, message) => { confirmMessage = message; return Promise.resolve(confirmAnswer); };
window.aihShowAlert = (_title, message) => { alertMessage = message; return Promise.resolve(); };
window.aihShowPrompt = () => Promise.resolve("");

const container = doc.createElement("div");
doc.body.appendChild(container);
await window.AIHMenu.renderProvidersTab(container);
await flush();

// 3a. Résumé de contexte dans la liste des presets.
const allText = container.textContent;
assert.ok(allText.includes("64 000 tokens (détecté)"), "liste : contexte détecté affiché");
assert.ok(allText.includes("? contexte inconnu"), "liste : contexte inconnu affiché");
ok("liste des presets : valeur + source reportées (détecté / ? inconnu)");

// 3b. Préremplissage à l'édition + badge de source.
const buttons = Array.from(container.querySelectorAll("button"));
const editAuto = buttons.find((b) => b.textContent === "Edit");
assert.ok(editAuto, "bouton Edit présent");
editAuto.click();
await flush();
const ctxInput = container.querySelector('input[type=number]');
assert.ok(ctxInput, "champ « Contexte (tokens) » présent");
const badge = container.querySelector("#aih-preset-ctx-badge");
assert.ok(badge, "badge de source présent");
assert.strictEqual(ctxInput.value, "64000", "préremplissage de la valeur serveur");
assert.strictEqual(badge.textContent, "détecté", "badge = détecté pour une source auto");

// Une valeur modifiée devient « manuel » …
ctxInput.value = "32000";
ctxInput.dispatchEvent(new window.Event("input", { bubbles: true }));
assert.strictEqual(badge.textContent, "manuel", "valeur modifiée → badge manuel");

// … et un champ vidé revient à l'automatique (source inconnue tant que non reçue).
ctxInput.value = "";
ctxInput.dispatchEvent(new window.Event("input", { bubbles: true }));
assert.strictEqual(badge.textContent, "? inconnu", "champ vidé → badge inconnu (auto)");
ok("badge de source réactif : détecté → manuel → inconnu");

// 3c. Bouton Détecter — succès (proposition d'application).
const detectBtn = buttons.find((b) => b.textContent === "Détecter");
assert.ok(detectBtn, "bouton Détecter présent");
confirmAnswer = true;
detectImpl = async () => jsonResponse({ detected_length: 64000, source: "family", probe: "models", status: "ok", detail: "" });
const getsBeforeDetect = presetGetCalls;
detectBtn.click();
await flush(); await flush();
assert.ok(confirmMessage && confirmMessage.includes("64 000"), "succès : la valeur détectée est proposée");
assert.ok(confirmMessage.includes("estimation"), "succès : la source (≈ estimation) est reportée");
assert.strictEqual(ctxInput.value, "64000", "succès + acceptation : valeur appliquée au champ");
assert.strictEqual(badge.textContent, "manuel", "valeur appliquée puis sauvegardée ⇒ manuel");
assert.strictEqual(presetGetCalls, getsBeforeDetect + 1,
    "détection réussie : la liste des presets est rechargée (GET /presets)");
ok("Détecter (succès) : chargement → valeur proposée → appliquée + liste rechargée");

// 3d. Bouton Détecter — 401.
alertMessage = null;
detectImpl = async () => jsonResponse({ error: "unauthorized" }, 401);
detectBtn.click();
await flush(); await flush();
assert.ok(alertMessage && alertMessage.includes("401"), "401 : message d'accès refusé explicite");
assert.strictEqual(ctxInput.disabled, false, "la saisie manuelle n'est jamais bloquée après un 401");
ok("Détecter (401) : message d'accès refusé, saisie manuelle préservée");

// 3e. Bouton Détecter — injoignable (réseau).
alertMessage = null;
detectImpl = async () => { throw new Error("network down"); };
detectBtn.click();
await flush(); await flush();
assert.ok(alertMessage && alertMessage.includes("injoignable"), "injoignable : message réseau explicite");
assert.strictEqual(ctxInput.disabled, false, "saisie manuelle toujours possible");
ok("Détecter (injoignable) : message réseau, saisie manuelle préservée");

// 3f. Bouton Détecter — champ absent (not_found).
alertMessage = null;
detectImpl = async () => jsonResponse({ detected_length: null, source: null, probe: "models", status: "not_found", detail: "no context field" });
detectBtn.click();
await flush(); await flush();
assert.ok(alertMessage && alertMessage.includes("n'expose pas"), "not_found : message « champ absent »");
ok("Détecter (champ absent) : message dédié");

// 3g. Bouton Détecter — bloqué SSRF.
alertMessage = null;
detectImpl = async () => jsonResponse({ detected_length: null, source: null, probe: "blocked", status: "blocked", detail: "private ip" });
detectBtn.click();
await flush(); await flush();
assert.ok(alertMessage && alertMessage.includes("SSRF"), "blocked : message SSRF explicite");
ok("Détecter (SSRF bloqué) : message dédié");

// 3h. Détecter sur un nouveau preset (sans id) ne fait aucune requête : invite à sauver.
alertMessage = null;
const cancelBtn = buttons.find((b) => b.textContent === "Annuler");
assert.ok(cancelBtn, "bouton Annuler présent (reset form)");
cancelBtn.click();
await flush();
detectBtn.click();
await flush(); await flush();
assert.ok(alertMessage && alertMessage.includes("Enregistre"), "nouveau preset : invite à enregistrer d'abord");
ok("Détecter (nouveau preset) : invite à sauvegarder avant détection");

/* ══════════════════ 4. Aucun repli 4096 dans les sources ══════════════ */
console.log("4. Sources sans repli inventé");
const blobbySrc = readFileSync(new URL("./blobby_companion.js", import.meta.url), "utf8");
const menuSrc = readFileSync(new URL("./aih_menu.js", import.meta.url), "utf8");
assert.ok(!/4096/.test(blobbySrc), "blobby_companion.js ne contient plus AUCUN 4096");
assert.ok(!/parseInt\([^)]*dataset\.maxCtx[^)]*\)\s*\|\|/.test(blobbySrc), "plus de repli parseInt(dataset.maxCtx) || …");
assert.ok(!/4096/.test(menuSrc), "aih_menu.js ne contient aucun 4096");
assert.ok(/data\.max_context/.test(blobbySrc) && /data\.context_source/.test(blobbySrc),
    "llm-process alimente bien max_context + context_source");
ok("aucun repli 4096 ; max_context/context_source consommés");

/* ══════════════════ 5. Parité i18n FR/EN ═════════════════════════════ */
console.log("5. i18n FR/EN");
const frKeys = Object.keys(captured.fr || {});
const enKeys = Object.keys(captured.en || {});
const onlyFr = frKeys.filter((k) => !(k in (captured.en || {})));
const onlyEn = enKeys.filter((k) => !(k in (captured.fr || {})));
assert.deepStrictEqual(onlyFr, [], `clés FR absentes en EN : ${onlyFr.join(", ")}`);
assert.deepStrictEqual(onlyEn, [], `clés EN absentes en FR : ${onlyEn.join(", ")}`);
assert.ok(frKeys.length > 0 && frKeys.length === enKeys.length, `FR=${frKeys.length} EN=${enKeys.length}`);
const ctxKeys = frKeys.filter((k) => k.startsWith("menu.ctx") || k.startsWith("bl.ctx"));
assert.ok(ctxKeys.length >= 20, `clés de contexte présentes (${ctxKeys.length})`);
assert.ok(ctxKeys.every((k) => k in (captured.en || {})), "chaque clé de contexte existe en FR ET EN");
// Durcissement : AUCUNE valeur EN vide (une traduction manquante = "" passe
// sinon inaperçue). Le cas intentionnel menu.ctxPlaceholder = "auto" des deux
// côtés reste valide (valeur NON vide, identique FR/EN).
const enEmpty = enKeys.filter((k) => String(captured.en[k]).trim() === "");
assert.deepStrictEqual(enEmpty, [], `valeurs EN vides : ${enEmpty.join(", ")}`);
// Contrôle du cas intentionnel (placeholder identique FR/EN, non vide).
assert.strictEqual(captured.fr["menu.ctxPlaceholder"], "auto");
assert.strictEqual(captured.en["menu.ctxPlaceholder"], "auto");
ok(`parité FR/EN OK (${frKeys.length} clés, 0 valeur EN vide) ; ${ctxKeys.length} clés de contexte FR+EN`);

console.log(`\n✅ Fenêtre de contexte LLM : TOUS LES TESTS PASSENT (${n} assertions de groupe)`);
