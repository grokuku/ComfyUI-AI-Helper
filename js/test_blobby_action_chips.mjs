// ─────────────────────────────────────────────────────────────────────────
// Chat Blobby — PUCES D'OUTILS EN FLUX (une seule rangée, retour automatique).
//
// Avant : chaque ligne d'action (⚡ list_nodes, ⚡ get_object_info…) était un
// .blobby-msg pleine largeur, enfant direct de #blobby-chat-msgs
// (display:flex; flex-direction:column) → une puce par ligne, centrée,
// gaspillage vertical. Après : les actions CONSÉCUTIVES vivent dans UN seul
// conteneur .blobby-action-row (display:flex; flex-wrap:wrap) → côte à côte et
// passage à la ligne automatique quand la largeur manque.
//
// Couverture :
//   (a) 5 puces consécutives → UN SEUL .blobby-action-row, 5 enfants, AUCUNE
//       puce enfant direct du conteneur colonne (pas de bloc pleine largeur) ;
//   (b) la règle CSS .blobby-action-row est bien un flux (display:flex +
//       flex-wrap:wrap) et borne la largeur (max-width:100%, min-width:0) ;
//   (c) une ligne non-action interrompt la rangée (action, blobby, action →
//       2 rangées) : l'ordre du fil est préservé ;
//   (d) noms longs : max-width par puce borné (<= 100 %) + word-break, la
//       puce reste dans la rangée (pas de débordement horizontal) ;
//   (e) 18 puces distinctes : toujours UNE rangée capable de wrapper (flex-wrap) ;
//   (f) streaming : une bulle transitoire reste enfant direct et n'est PAS
//       transformée en rangée ; les puces suivantes repartent sur une rangée
//       propre → aucun saut de mise en page intempestif ;
//   (g) restauration d'historique : les actions consécutives sont regroupées
//       au rechargement (même invariant que le live).
//   (h) CONTRÔLES NÉGATIFS PAR MUTATION : (1) remettre un bloc par puce est
//       détecté par l'invariant « 0 puce enfant direct » ; (2) retirer
//       flex-wrap fait échouer la vérification CSS.
//
// Usage : node js/test_blobby_action_chips.mjs
//   jsdom résolu par js/test_helpers/jsdom_loader.mjs ; absent = SKIP (exit 2).
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const JSDOM = await loadJsdomOrSkip("test_blobby_action_chips");
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
});
const { window: domWindow } = dom;
globalThis.window = domWindow;
globalThis.document = domWindow.document;
globalThis.localStorage = domWindow.localStorage;
globalThis.getComputedStyle = domWindow.getComputedStyle.bind(domWindow);
globalThis.HTMLElement = domWindow.HTMLElement;
globalThis.Node = domWindow.Node;
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
try { globalThis.navigator = domWindow.navigator; } catch { /* Node fournit déjà un navigator */ }
domWindow.matchMedia = domWindow.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));

localStorage.setItem("aih_locale", "fr");
localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "http://aih.test", apiKey: "k", blobbyPreset: "3" }));

// ── Fake fetch global (aucun réseau) ──
function jsonResponse(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) },
        json: async () => data,
        text: async () => JSON.stringify(data),
    };
}
globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/keywords/llm-process")) return jsonResponse({ output: "..." });
    if (u.includes("/api/blobby/memory")) return jsonResponse({ results: [] });
    if (u.includes("/api/presets")) return jsonResponse([]);
    if (u.includes("/api/settings")) return jsonResponse({});
    return jsonResponse({});
};

// ── Faux app ComfyUI minimal (waitForApp s'y enregistre à l'import) ──
globalThis.window.app = {
    graph: { nodes: [], setDirtyCanvas() {}, getNodeById() { return null; } },
    canvas: { setDirtyCanvas() {}, centerOnNode() {} },
    registerExtension() {},
    extensions: [],
};

// ── Mock de la modale AIH v2 (renvoie un DOM réel portant blobby-chat-modal) ──
let modalSeq = 0;
function mockOpenModal(opts) {
    modalSeq++;
    const modal = document.createElement("div");
    modal.className = "aih-dialog-root " + (opts.className || "");
    const header = document.createElement("div");
    header.className = "aih-dialog-header";
    const title = document.createElement("span");
    title.className = "aih-dialog-title";
    header.appendChild(title);
    const headerRight = document.createElement("div");
    headerRight.className = "aih-dialog-header-right";
    header.appendChild(headerRight);
    const body = document.createElement("div");
    body.className = "aih-dialog-body";
    if (opts.content) body.appendChild(opts.content);
    modal.appendChild(header);
    modal.appendChild(body);
    document.body.appendChild(modal);
    return { modal, el: modal, body, header, headerRight, close() { modal.remove(); } };
}

// ── Import des modules (mock POSÉ APRÈS import : aih_dialog.js écrase le global) ──
await import("./aih_i18n.js");
const I18n = domWindow.AIH.I18n;
I18n.setLocale("fr");
await import("./blobby_companion.js");
domWindow.aihOpenModalV2 = mockOpenModal;

const Blobby = domWindow.Blobby;
assert.ok(Blobby && typeof Blobby._addChatMessage === "function", "Blobby exposé (window.Blobby) avec _addChatMessage");
assert.ok(typeof Blobby._openChatModal === "function", "Blobby._openChatModal exposé");

// ── Helpers de vérification (porteurs des invariants) ──
/** Puces d'action ENFANTS DIRECTS du conteneur colonne (le bug d'empilement). */
const directActionChildren = (c) => [...c.children].filter(
    (el) => el.classList && el.classList.contains("blobby-msg") && el.dataset.role === "action");
/** Rangées d'action enfants directs. */
const actionRows = (c) => [...c.children].filter((el) => el.classList.contains("blobby-action-row"));
/** La règle CSS .blobby-action-row (bloc de base) décrit-elle un flux qui wrap ? */
function flowRuleOk(css) {
    const m = css.match(/\.blobby-action-row\s*\{([^}]*)\}/);
    return !!m && /display:\s*flex/.test(m[1]) && /flex-wrap:\s*wrap/.test(m[1]);
}
const chipEls = (row) => [...row.querySelectorAll('.blobby-msg[data-role="action"]')];

Blobby._initMode();
Blobby._openChatModal();
const chat = document.getElementById("blobby-chat-msgs");
assert.ok(chat, "#blobby-chat-msgs présent");
const cssText = document.getElementById("blobby-chat-css")?.textContent || "";
assert.ok(cssText.includes(".blobby-action-row"), "CSS du chat injectée (règle .blobby-action-row)");

/* ══════════════════ (a) 5 puces consécutives → UNE seule rangée ═══════════ */
console.log("(a) 5 puces consécutives : UNE rangée en flux, aucune puce pleine largeur");

chat.innerHTML = "";
["describe_workflow", "list_nodes", "get_object_info", "get_node_by_id", "get_execution_status"]
    .forEach((name) => Blobby._addChatMessage(chat, "action", name));

const rows = actionRows(chat);
assert.strictEqual(rows.length, 1, "5 actions consécutives → exactement UNE .blobby-action-row");
assert.strictEqual(rows[0].parentElement, chat, "la rangée est enfant direct de #blobby-chat-msgs");
assert.strictEqual(chipEls(rows[0]).length, 5, "les 5 puces sont regroupées dans la rangée");
assert.strictEqual(directActionChildren(chat).length, 0, "AUCUNE puce d'action n'est enfant direct du conteneur colonne (pas de bloc pleine largeur)");
assert.ok(rows[0].textContent.includes("describe_workflow") && rows[0].textContent.includes("get_execution_status"), "toutes les puces présentes dans la rangée");
assert.ok(rows[0].textContent.indexOf("describe_workflow") < rows[0].textContent.indexOf("list_nodes"), "ordre des puces préservé");
ok("(a) 5 puces dans UNE rangée, 0 puce enfant direct (fin de l'empilement 1 par ligne)");

/* ══════════════════ (b) La règle CSS est un flux borné ═════════════════════ */
console.log("(b) Règle CSS .blobby-action-row : flux + wrap + largeur bornée");

assert.ok(flowRuleOk(cssText), ".blobby-action-row : display:flex + flex-wrap:wrap (retour automatique)");
const baseRule = cssText.match(/\.blobby-action-row\s*\{([^}]*)\}/)[1];
assert.ok(/max-width:\s*100%/.test(baseRule), "largeur bornée à la zone (max-width:100%) → pas de débordement horizontal");
assert.ok(/min-width:\s*0/.test(baseRule), "min-width:0 : la rangée peut se contraindre à la largeur disponible");
assert.ok(/gap:\s*\d+px/.test(baseRule), "espacement lisible entre puces (gap)");
const chipRule = (cssText.match(/\.blobby-action-row\s*>\s*\.blobby-msg\[data-role="action"\]\s*\{([^}]*)\}/) || [])[1] || "";
assert.ok(/max-width:\s*100%/.test(chipRule), "max-width par puce (dans la rangée)");
assert.ok(/min-width:\s*0/.test(chipRule), "min-width:0 par puce (peut se rétrécir/wrapper au lieu de déborder)");
ok("(b) rangée en flux (flex-wrap) + largeur bornée : 1 puce = inline, N puces = côte à côte puis retour auto");

/* ══════════════════ (c) Une ligne non-action interrompt la rangée ═════════ */
console.log("(c) Interruption : action, blobby, action → 2 rangées (ordre du fil)");

chat.innerHTML = "";
Blobby._addChatMessage(chat, "action", "list_nodes");
Blobby._addChatMessage(chat, "blobby", "voici le résultat");
Blobby._addChatMessage(chat, "action", "get_object_info");

const rows2 = actionRows(chat);
assert.strictEqual(rows2.length, 2, "une ligne intercalée ouvre une NOUVELLE rangée (2 rangées)");
assert.strictEqual(chipEls(rows2[0]).length, 1, "rangée 1 : 1 puce");
assert.strictEqual(chipEls(rows2[1]).length, 1, "rangée 2 : 1 puce");
// Ordre DOM : rangée1 → bulle blobby → rangée2.
const orderedChildren = [...chat.children];
assert.ok(orderedChildren.indexOf(rows2[0]) < orderedChildren.findIndex((el) => el.dataset.role === "blobby"), "rangée 1 avant la bulle");
assert.ok(orderedChildren.findIndex((el) => el.dataset.role === "blobby") < orderedChildren.indexOf(rows2[1]), "bulle avant rangée 2 (ordre du fil préservé)");
assert.strictEqual(directActionChildren(chat).length, 0, "toujours 0 puce enfant direct");
ok("(c) une ligne non-action coupe la rangée ; l'ordre du fil reste strictement préservé");

/* ══════════════════ (d) Noms longs : bornés, pas de débordement ═══════════ */
console.log("(d) Noms longs : max-width par puce + word-break, reste dans la rangée");

chat.innerHTML = "";
const longName = "🖥️ un_outil_au_nom_vraiment_vraiment_tres_long_qui_pourrait_deborder_si_non_borne";
Blobby._addChatMessage(chat, "action", longName);
const longRows = actionRows(chat);
assert.strictEqual(longRows.length, 1, "nom long : la puce est bien dans une rangée (pas en bloc direct)");
const longChip = chipEls(longRows[0])[0];
assert.ok(longChip, "puce présente");
const mw = parseFloat(longChip.style.maxWidth);
assert.ok(Number.isFinite(mw) && mw > 0 && mw <= 100, `max-width par puce borné (${longChip.style.maxWidth} <= 100%)`);
assert.ok(/break-word|break-all/.test(longChip.style.wordBreak), "word-break posé : un nom long se replie au lieu de déborder");
assert.strictEqual(directActionChildren(chat).length, 0, "aucune puce en bloc direct");
ok("(d) nom long borné par max-width + word-break : pas de débordement horizontal");

/* ══════════════════ (e) 18 puces DISTINCTES : UNE rangée qui peut wrapper ═ */
// (Les appels identiques consécutifs sont désormais regroupés ⚡ nom ×N — voir
// js/test_blobby_action_grouping.mjs — on utilise donc 18 libellés distincts
// pour continuer à éprouver le retour à la ligne de la rangée.)
console.log("(e) 18 puces distinctes (cas capture) : UNE rangée capable de wrapper");

chat.innerHTML = "";
for (let i = 0; i < 18; i++) Blobby._addChatMessage(chat, "action", "get_object_info " + i);
const bigRows = actionRows(chat);
assert.strictEqual(bigRows.length, 1, "18 puces consécutives → UNE seule rangée");
assert.strictEqual(chipEls(bigRows[0]).length, 18, "les 18 puces sont dans la rangée");
assert.ok(flowRuleOk(cssText), "la rangée wrappe (flex-wrap) : les 18 puces passent à la ligne automatiquement");
assert.strictEqual(directActionChildren(chat).length, 0, "0 puce pleine largeur (18 lignes évitées)");
ok("(e) 18 puces compactées dans une rangée à retour automatique");

/* ══════════════════ (f) Streaming : bulle transitoire non transformée ═════ */
console.log("(f) Streaming : bulle transitoire reste enfant direct, pas de saut de layout");

chat.innerHTML = "";
// Reproduit la bulle temporaire du renderer de flux (classe + dataset réels).
const stream = document.createElement("div");
stream.className = "blobby-msg blobby-msg-streaming";
stream.dataset.role = "blobby";
stream.dataset.streaming = "1";
chat.appendChild(stream);
Blobby._addChatMessage(chat, "action", "list_nodes");
Blobby._addChatMessage(chat, "action", "get_node_by_id");
assert.strictEqual(stream.parentElement, chat, "la bulle de streaming n'est PAS absorbée dans une rangée d'actions");
assert.strictEqual(actionRows(chat).length, 1, "les puces après la bulle forment UNE rangée");
assert.strictEqual(chipEls(actionRows(chat)[0]).length, 2, "les 2 puces sont groupées");
assert.strictEqual(directActionChildren(chat).length, 0, "aucune puce en bloc direct pendant le streaming");
// Fin de tour : la bulle est retirée (onDelta(null)) → les puces restent groupées.
stream.remove();
assert.strictEqual(actionRows(chat).length, 1, "après retrait de la bulle, la rangée subsiste (pas de re-layout parasite)");
assert.strictEqual(chipEls(actionRows(chat)[0]).length, 2, "puces intactes après fin de streaming");
ok("(f) streaming : bulle transitoire isolée, puces groupées, aucun saut de layout");

/* ══════════════════ (g) Restauration d'historique : même regroupement ════ */
console.log("(g) Restauration : les actions consécutives sont regroupées au reload");

const cfg = JSON.parse(localStorage.getItem("AIH_config"));
cfg.blobbyData = Object.assign(cfg.blobbyData || {}, {
    chatHistory: [
        { role: "action", text: "list_nodes" },
        { role: "action", text: "get_object_info" },
        { role: "blobby", text: "<p>ok</p>" },
        { role: "action", text: "describe_workflow" },
    ],
});
localStorage.setItem("AIH_config", JSON.stringify(cfg));
document.querySelector(".blobby-chat-modal").remove();
Blobby._openChatModal();
const chat2 = document.getElementById("blobby-chat-msgs");
const restoredRows = actionRows(chat2);
assert.strictEqual(restoredRows.length, 2, "historique : 2 rangées (2 actions consécutives, coupure, 1 action)");
assert.strictEqual(chipEls(restoredRows[0]).length, 2, "rangée restaurée 1 : 2 puces");
assert.strictEqual(chipEls(restoredRows[1]).length, 1, "rangée restaurée 2 : 1 puce");
assert.strictEqual(directActionChildren(chat2).length, 0, "historique : aucune puce en bloc direct");
ok("(g) restauration : regroupement identique au live (2 rangées)");

/* ══════════════════ (h) CONTRÔLES NÉGATIFS PAR MUTATION ══════════════════ */
console.log("(h) Contrôles négatifs : mutation « bloc par puce » et « sans wrap » détectées");

// (h1) Régression simulée : chaque puce en bloc pleine largeur, enfant direct.
const broken = document.createElement("div");
broken.style.cssText = "display:flex;flex-direction:column";
["a", "b", "c"].forEach((x) => {
    const d = document.createElement("div");
    d.className = "blobby-msg";
    d.dataset.role = "action";
    d.textContent = x;
    broken.appendChild(d);
});
assert.strictEqual(directActionChildren(broken).length, 3, "contrôle négatif (bloc par puce) : les 3 puces pleine largeur sont détectées par l'invariant");
assert.strictEqual(directActionChildren(chat2).length, 0, "et l'invariant réel reste 0 (assertion non vide)");
// Mutation plus fidèle : forcer l'ancien rendu sur le VRAI conteneur puis vérifier.
const savedChildren = [...chat2.children];
chat2.appendChild(chipEls(restoredRows[0])[0]); // déplace 1 puce hors rangée
assert.strictEqual(directActionChildren(chat2).length, 1, "contrôle négatif : une puce sortie de la rangée est immédiatement détectée");
chat2.innerHTML = "";
savedChildren.forEach((el) => chat2.appendChild(el));
assert.strictEqual(directActionChildren(chat2).length, 0, "régression annulée : invariante restaurée");
ok("(h1) mutation « bloc par puce » détectée → le test rougirait si le rendu régressait");

// (h2) Mutation CSS : retirer le wrap fait échouer la vérification de flux.
const stripped = cssText.replace("flex-wrap: wrap", "flex-wrap: nowrap");
assert.ok(flowRuleOk(cssText), "CSS réelle : flux qui wrappe (OK)");
assert.ok(!flowRuleOk(stripped), "contrôle négatif (sans wrap) : la vérification échoue → assertion non vide");
ok("(h2) mutation « retirer le wrap » détectée → le test rougirait sans retour automatique");

console.log(`\n✅ Puces d'outils Blobby en flux : TOUS LES TESTS PASSENT (${n} groupes d'assertions)`);
process.exit(0);
