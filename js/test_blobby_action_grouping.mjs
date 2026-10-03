// ─────────────────────────────────────────────────────────────────────────
// Chat Blobby — REGROUPEMENT DES EXÉCUTIONS D'OUTILS IDENTIQUES ET CONSÉCUTIVES
// (⚡ nom ×N), avec RÈGLE DE SÉPARATION STRICTE (décision utilisateur) :
//
//   « si une exécution autre s'intercale au milieu il faut séparer. Par exemple
//     si j'ai 3 read_nodes suivis d'un get_object puis 5 read_nodes, je dois
//     avoir 3xread, 1xget, 5xread »
//
// Traduction verrouillée par ce test :
//   • deux appels de MÊME libellé ne fusionnent que s'ils sont IMMÉDIATEMENT
//     voisins (dernière puce de la rangée courante) → 3 + 5 ne font JAMAIS 8 ;
//   • toute action DIFFÉRENTE — ou toute autre ligne du fil — coupe le groupe ;
//   • un appel portant un undoId (mutation, bouton « Annuler ») n'est JAMAIS
//     fusionné : chaque mutation reste annulable individuellement ;
//   • compteur affiché SEULEMENT à partir de ×2 (un appel isolé reste une puce
//     normale sans compteur) ;
//   • mise à jour LIVE : la puce existante re-rend son libellé (même nœud DOM,
//     pas de clignotement) ;
//   • restauration d'historique IDEMPOTENTE : même regroupement, même compteur,
//     même séparation (y compris mutations marquées, jamais fusionnées) ;
//   • format i18n (`bl.actionCount`, présent FR + EN).
//
// CONTRÔLES NÉGATIFS PAR MUTATION (partie g) : les invariants du test doivent
// ROUGIR sur (1) un agrégat à distance, (2) une fusion avec undo, (3) une puce
// par appel, (4) un compteur ×1 affiché. (Preuve bout-en-bout supplémentaire :
// mutations réelles du code source exécutées hors dépôt, cf. rapport.)
//
// Usage : node js/test_blobby_action_grouping.mjs
//   jsdom résolu par js/test_helpers/jsdom_loader.mjs ; absent = SKIP (exit 2).
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const JSDOM = await loadJsdomOrSkip("test_blobby_action_grouping");
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
globalThis.fetch = async () => jsonResponse({});
domWindow.fetch = globalThis.fetch;

// ── Faux app ComfyUI minimal (waitForApp s'y enregistre à l'import) ──
globalThis.window.app = {
    graph: { nodes: [], setDirtyCanvas() {}, getNodeById() { return null; } },
    canvas: { setDirtyCanvas() {}, centerOnNode() {} },
    registerExtension() {},
    extensions: [],
};

// ── Mock de la modale AIH v2 (renvoie un DOM réel portant blobby-chat-modal) ──
function mockOpenModal(opts) {
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

// ── Helpers de vérification (porteurs des invariants) ──
const actionRows = (c) => [...c.children].filter((el) => el.classList && el.classList.contains("blobby-action-row"));
const chipEls = (row) => [...row.querySelectorAll('.blobby-msg[data-role="action"]')];
const chipTexts = (row) => chipEls(row).map((c) => c.textContent);
/** Texte du LIBELLÉ seul (le bouton « Annuler » éventuel n'en fait pas partie). */
const chipLabelTexts = (row) => chipEls(row).map((c) => c.querySelector(".blobby-action-label").textContent);
/** Libellé BRUT (sans ⚡ ni ×N) : base de comparaison du regroupement. */
const chipLabel = (c) => c.dataset.actionLabel;
/** La puce est-elle une mutation annulable (undo vivant OU marqueur restauré) ? */
const isUndoChip = (c) => !!(c.dataset.undoId || c.dataset.undo === "1" || c.querySelector("button[data-undo-id]"));
/** Signature « groupes dans l'ordre » : par rangée, liste [libellé, compteur]. */
const groupedSignature = (c) => actionRows(c).map((row) => chipEls(row).map((ch) => [chipLabel(ch), ch.dataset.actionCount || "1"]));

/**
 * Invariants STRUCTURELS du regroupement (mêmes règles que le code produit).
 * Lève si le DOM contient un état interdit :
 *   (1) compteur affiché < ×2 ; (2) compteur sur une puce undo ; (3) deux
 *   voisines de même libellé fusionnables restées séparées.
 * @returns {number} nombre de puces contrôlées (assertion non vide).
 */
function assertGroupingInvariants(container) {
    let checked = 0;
    for (const row of actionRows(container)) {
        const list = chipEls(row);
        for (let i = 0; i < list.length; i++) {
            const c = list[i];
            checked++;
            if (c.dataset.actionCount !== undefined) {
                const count = parseInt(c.dataset.actionCount, 10);
                assert.ok(Number.isFinite(count) && count >= 2,
                    `compteur affiché seulement à partir de ×2 (vu: ${c.dataset.actionCount})`);
            }
            if (isUndoChip(c)) {
                assert.strictEqual(c.dataset.actionCount, undefined, "une puce avec undo ne porte JAMAIS de compteur");
            }
            if (i > 0) {
                const p = list[i - 1];
                const same = chipLabel(p) === chipLabel(c);
                assert.ok(!(same && !isUndoChip(p) && !isUndoChip(c)),
                    "deux puces voisines de même libellé fusionnables n'auraient pas dû rester séparées");
            }
        }
    }
    return checked;
}

const savedHistory = () => (JSON.parse(localStorage.getItem("AIH_config")).blobbyData || {}).chatHistory || [];
/** Réinitialise l'historique persisté puis rouvre la modale (chemin restauration réel). */
function reopenWithHistory(entries) {
    const cfg = JSON.parse(localStorage.getItem("AIH_config"));
    cfg.blobbyData = Object.assign(cfg.blobbyData || {}, { chatHistory: entries });
    localStorage.setItem("AIH_config", JSON.stringify(cfg));
    const modal = document.querySelector(".blobby-chat-modal");
    if (modal) modal.remove();
    Blobby._openChatModal();
    return document.getElementById("blobby-chat-msgs");
}
/** Construit une puce d'action « cassée » à la main (contrôles négatifs). */
function buildMutantChip(label, count, undo) {
    const chip = document.createElement("div");
    chip.className = "blobby-msg";
    chip.dataset.role = "action";
    chip.dataset.actionLabel = label;
    if (count !== undefined) chip.dataset.actionCount = String(count);
    const span = document.createElement("span");
    span.className = "blobby-action-label";
    span.textContent = "⚡ " + label + (count >= 2 ? " ×" + count : "");
    chip.appendChild(span);
    if (undo) {
        const b = document.createElement("button");
        b.setAttribute("data-undo-btn", "1");
        b.setAttribute("data-undo-id", "mutant");
        b.textContent = "↩ Annuler";
        chip.appendChild(b);
    }
    return chip;
}
function buildMutantRow(chips) {
    const c = document.createElement("div");
    const row = document.createElement("div");
    row.className = "blobby-action-row";
    chips.forEach((ch) => row.appendChild(ch));
    c.appendChild(row);
    return c;
}

Blobby._initMode();
Blobby._openChatModal();
let chat = document.getElementById("blobby-chat-msgs");
assert.ok(chat, "#blobby-chat-msgs présent");

/* ══════════ (a) Scénario utilisateur : 3 read, 1 get, 5 read → ×3, ×1, ×5 ═ */
console.log("(a) Scénario utilisateur 3-1-5 : exactement 3 puces ×3, get, ×5 (ordre + séparation)");

chat.innerHTML = "";
for (let i = 0; i < 3; i++) Blobby._addChatMessage(chat, "action", "read_nodes");
Blobby._addChatMessage(chat, "action", "get_object_info");
for (let i = 0; i < 5; i++) Blobby._addChatMessage(chat, "action", "read_nodes");

assert.strictEqual(actionRows(chat).length, 1, "9 appels consécutifs → toujours UNE rangée en flux");
const userRow = actionRows(chat)[0];
assert.strictEqual(chipEls(userRow).length, 3, "9 appels → EXACTEMENT 3 puces (pas 9, pas 1)");
assert.deepStrictEqual(chipTexts(userRow), ["⚡ read_nodes ×3", "⚡ get_object_info", "⚡ read_nodes ×5"],
    "ordre et séparation stricts : « read ×3 » → « get » → « read ×5 »");
assert.deepStrictEqual([...userRow.children].map(chipLabel), ["read_nodes", "get_object_info", "read_nodes"],
    "ordre DOM des libellés bruts préservé");
assert.strictEqual(chipEls(userRow)[0].dataset.actionCount, "3", "premier groupe : compteur 3");
assert.strictEqual(chipEls(userRow)[1].dataset.actionCount, undefined, "appel isolé : AUCUN compteur (pas de ×1)");
assert.strictEqual(chipEls(userRow)[2].dataset.actionCount, "5", "second groupe : compteur 5 (JAMAIS 3+5=8 : pas d'agrégat à distance)");
assert.strictEqual(chat.querySelectorAll('.blobby-msg[data-role="action"]').length, 3, "3 nœuds DOM seulement pour 9 appels");
assert.strictEqual(assertGroupingInvariants(chat), 3, "invariants structurels respectés (3 puces contrôlées)");
ok("(a) 3xread → 1xget → 5xread : 3 puces « ×3, ×1(sans compteur), ×5 » dans l'ordre — le 2ᵉ groupe repart de ×5");

/* ══════════ (b) Une ligne non-action interrompt : ×2 | bulle | NOUVEAU ×1 ═ */
console.log("(b) Séparation stricte : action, action, bulle, action → 2 groupes (jamais de fusion par-dessus)");

chat.innerHTML = "";
Blobby._addChatMessage(chat, "action", "list_nodes");
Blobby._addChatMessage(chat, "action", "list_nodes");
Blobby._addChatMessage(chat, "blobby", "voici le résultat");
Blobby._addChatMessage(chat, "action", "list_nodes");

const rows2 = actionRows(chat);
assert.strictEqual(rows2.length, 2, "la bulle coupe le groupe → 2 rangées");
assert.deepStrictEqual(chipTexts(rows2[0]), ["⚡ list_nodes ×2"], "groupe avant la bulle : ×2");
assert.deepStrictEqual(chipTexts(rows2[1]), ["⚡ list_nodes"], "groupe APRÈS la bulle : nouvelle puce sans compteur (pas ×3)");
assert.strictEqual(chipEls(rows2[1])[0].dataset.actionCount, undefined, "le groupe d'après ne cumule JAMAIS avec celui d'avant");
const ordered = [...chat.children];
assert.ok(ordered.indexOf(rows2[0]) < ordered.findIndex((el) => el.dataset.role === "blobby"), "rangée 1 avant la bulle");
assert.ok(ordered.findIndex((el) => el.dataset.role === "blobby") < ordered.indexOf(rows2[1]), "bulle avant rangée 2 (ordre du fil)");
ok("(b) toute ligne intercalée coupe le groupe ; la même action repart en NOUVEAU groupe ×1");

/* ══════════ (c) UNDO : un appel portant un undoId n'est JAMAIS fusionné ═══ */
console.log("(c) Undo-safe : deux mutations identiques restent deux puces annulables");

chat.innerHTML = "";
Blobby._addChatMessage(chat, "action", "⚙️ KSampler · steps = 30", { undoId: "u1" });
Blobby._addChatMessage(chat, "action", "⚙️ KSampler · steps = 30", { undoId: "u2" });
const undoRow = actionRows(chat)[0];
assert.strictEqual(chipEls(undoRow).length, 2, "2 mutations identiques → 2 puces (jamais fusionnées)");
assert.deepStrictEqual(chipLabelTexts(undoRow), ["⚡ ⚙️ KSampler · steps = 30", "⚡ ⚙️ KSampler · steps = 30"],
    "aucune des deux ne porte de compteur");
assert.ok(chipEls(undoRow).every((c) => c.querySelector("button[data-undo-id]")), "chaque puce garde SON bouton Annuler");
assert.deepStrictEqual(chipEls(undoRow).map((c) => c.dataset.undoId), ["u1", "u2"], "chaque mutation garde son propre undoId");
assert.strictEqual(chipEls(undoRow).every((c) => c.dataset.actionCount === undefined), true, "compteur interdit sur une mutation");
// Un appel SANS undo ne doit pas non plus être absorbé par une puce undo précédente.
chat.innerHTML = "";
Blobby._addChatMessage(chat, "action", "M", { undoId: "u3" });
Blobby._addChatMessage(chat, "action", "M");
assert.strictEqual(chipEls(actionRows(chat)[0]).length, 2, "puce undo précédente : l'appel suivant n'est pas absorbé");
assert.strictEqual(chipEls(actionRows(chat)[0])[1].dataset.actionCount, undefined, "et la puce suivante reste ×1");
// Symétrique : un appel AVEC undo n'est pas absorbé non plus, et le groupe repart après lui.
chat.innerHTML = "";
Blobby._addChatMessage(chat, "action", "N");
Blobby._addChatMessage(chat, "action", "N", { undoId: "u4" });
Blobby._addChatMessage(chat, "action", "N");
Blobby._addChatMessage(chat, "action", "N");
const nRow = actionRows(chat)[0];
assert.deepStrictEqual(chipLabelTexts(nRow), ["⚡ N", "⚡ N", "⚡ N ×2"],
    "undo au milieu : les N d'avant et d'après ne fusionnent pas avec lui ; les N d'après se regroupent entre eux");
assert.ok(chipEls(nRow)[1].querySelector("button[data-undo-id]"), "la puce du milieu reste annulable individuellement");
ok("(c) une mutation (undoId) n'est jamais fusionnée — ni comme cible, ni comme source — et ne coupe pas le fil");

/* ══════════ (d) Incrément LIVE : même nœud DOM, ×2 puis ×3 ═══════════════ */
console.log("(d) Mise à jour live : la puce existante re-rend ×2 → ×3 sans nouveau nœud");

chat.innerHTML = "";
Blobby._addChatMessage(chat, "action", "get_object_info");
const liveRow = actionRows(chat)[0];
const liveChip = chipEls(liveRow)[0];
assert.strictEqual(liveChip.textContent, "⚡ get_object_info", "appel isolé : puce normale sans compteur");
assert.strictEqual(chat.querySelectorAll(".blobby-msg").length, 1, "1 nœud pour 1 appel");
Blobby._addChatMessage(chat, "action", "get_object_info");
assert.strictEqual(chipEls(actionRows(chat)[0])[0], liveChip, "×2 : MÊME nœud DOM (pas de création)");
assert.strictEqual(liveChip.textContent, "⚡ get_object_info ×2", "libellé re-rendu en place");
assert.strictEqual(chat.querySelectorAll(".blobby-msg").length, 1, "toujours 1 seul nœud après le 2ᵉ appel");
Blobby._addChatMessage(chat, "action", "get_object_info");
assert.strictEqual(chipEls(actionRows(chat)[0])[0], liveChip, "×3 : toujours le même nœud");
assert.strictEqual(liveChip.textContent, "⚡ get_object_info ×3");
assert.strictEqual(actionRows(chat).length, 1, "pas de nouvelle rangée");
assert.strictEqual(liveChip.querySelectorAll(".blobby-action-label").length, 1, "un seul span de libellé (re-rendu en place)");
assert.strictEqual(liveChip.dataset.actionCount, "3", "compteur porté par le dataset de la puce");
assert.strictEqual(assertGroupingInvariants(chat), 1, "invariants OK sur l'incrément live");
ok("(d) incrément live : ×2 puis ×3 sur le MÊME nœud DOM, aucun clignotement/nouvelle puce");

/* ══════════ (e) Persistance + restauration : regroupement idempotent ═════ */
console.log("(e) Restauration d'historique : mêmes puces, mêmes compteurs, même séparation");

chat.innerHTML = "";
for (let i = 0; i < 3; i++) Blobby._addChatMessage(chat, "action", "read_nodes");
Blobby._addChatMessage(chat, "action", "get_object_info");
for (let i = 0; i < 5; i++) Blobby._addChatMessage(chat, "action", "read_nodes");
const histLive = savedHistory();
assert.deepStrictEqual(histLive, [
    { role: "action", text: "read_nodes", count: 3 },
    { role: "action", text: "get_object_info" },
    { role: "action", text: "read_nodes", count: 5 },
], "historique persisté : libellé BRUT + compteur (pas le HTML rendu)");

chat = reopenWithHistory(histLive);
assert.deepStrictEqual(groupedSignature(chat), [[["read_nodes", "3"], ["get_object_info", "1"], ["read_nodes", "5"]]],
    "restauration : signature identique au live (×3, ×1, ×5)");
assert.deepStrictEqual(chipTexts(actionRows(chat)[0]), ["⚡ read_nodes ×3", "⚡ get_object_info", "⚡ read_nodes ×5"],
    "restauration : libellés affichés identiques au live");
Blobby._saveChatHistory();
assert.deepStrictEqual(savedHistory(), histLive, "re-save après restauration : historique IDENTIQUE (idempotent)");
ok("(e1) restauration : 3 puces « ×3, get, ×5 », re-save idempotent");

// Mutations : le marqueur undo survit à la restauration → JAMAIS fusionnées.
chat.innerHTML = "";
Blobby._addChatMessage(chat, "action", "🗑️ Nœud X supprimé", { undoId: "u9" });
Blobby._addChatMessage(chat, "action", "🗑️ Nœud X supprimé", { undoId: "u10" });
const histUndo = savedHistory();
assert.deepStrictEqual(histUndo, [
    { role: "action", text: "🗑️ Nœud X supprimé", undo: true },
    { role: "action", text: "🗑️ Nœud X supprimé", undo: true },
], "historique : mutations marquées undo (le snapshot, lui, n'est pas persisté)");
chat = reopenWithHistory(histUndo);
const restoredUndo = chipEls(actionRows(chat)[0]);
assert.strictEqual(restoredUndo.length, 2, "restauration : 2 mutations identiques restent 2 puces (jamais fusionnées)");
assert.strictEqual(restoredUndo[0].dataset.undo, "1", "marqueur de non-fusion restauré");
assert.strictEqual(restoredUndo[0].querySelector("button[data-undo-id]"), null, "pas de bouton mort : la pile undo n'est pas persistée");
assert.strictEqual(restoredUndo[0].dataset.actionCount, undefined, "aucun compteur sur une mutation restaurée");
Blobby._saveChatHistory();
assert.deepStrictEqual(savedHistory(), histUndo, "re-save : mutations restaurées toujours séparées et marquées");
ok("(e2) restauration undo-safe : les mutations ne fusionnent pas, avant comme après reload");

// Compatibilité : les historiques ANTÉRIEURS (texte rendu « ⚡ nom ») ne doublent pas le ⚡.
chat = reopenWithHistory([
    { role: "action", text: "⚡ list_nodes" },
    { role: "action", text: "⚡ list_nodes" },
    { role: "action", text: "get_object_info" },
]);
assert.deepStrictEqual(chipTexts(actionRows(chat)[0]), ["⚡ list_nodes ×2", "⚡ get_object_info"],
    "ancien format « ⚡ nom » normalisé (PAS de ⚡ ⚡) et regroupé");
ok("(e3) compatibilité : anciens historiques re-rendus sans double ⚡ et regroupés");

/* ══════════ (f) i18n du format : clé présente FR + EN ════════════════════ */
console.log("(f) i18n : le format « {label} ×{count} » vient du dictionnaire (FR + EN)");

I18n.setLocale("fr");
assert.strictEqual(I18n.t("bl.actionCount", { label: "⚡ x", count: 3 }), "⚡ x ×3", "FR : format paramétré");
I18n.setLocale("en");
const enFmt = I18n.t("bl.actionCount", { label: "⚡ x", count: 3 });
assert.notStrictEqual(enFmt, "bl.actionCount", "EN : clé présente dans le dictionnaire (pas de repli clé brute)");
assert.ok(enFmt.includes("×3") && enFmt.includes("⚡ x"), `EN : format rendu (${enFmt})`);
chat = document.getElementById("blobby-chat-msgs");
chat.innerHTML = "";
Blobby._addChatMessage(chat, "action", "tool_x");
Blobby._addChatMessage(chat, "action", "tool_x");
assert.ok(chipEls(actionRows(chat)[0])[0].textContent.includes("×2"), "en locale EN active, le compteur live suit le dictionnaire");
I18n.setLocale("fr");
ok("(f) format ×N i18n (FR/EN), appliqué par le rendu live");

/* ══════════ (g) CONTRÔLES NÉGATIFS PAR MUTATION ══════════════════════════ */
console.log("(g) Contrôles négatifs : les invariants ROUGISSENT sur les 3 mutations interdites");

// État de référence : scénario 3-1-5 réel.
chat.innerHTML = "";
for (let i = 0; i < 3; i++) Blobby._addChatMessage(chat, "action", "read_nodes");
Blobby._addChatMessage(chat, "action", "get_object_info");
for (let i = 0; i < 5; i++) Blobby._addChatMessage(chat, "action", "read_nodes");
const goodSig = groupedSignature(chat);
assert.deepStrictEqual(goodSig, [[["read_nodes", "3"], ["get_object_info", "1"], ["read_nodes", "5"]]], "état de référence (scénario réel)");
assert.strictEqual(assertGroupingInvariants(chat), 3, "invariants verts sur le DOM réel (assertion non vide)");

// (g1) MUTATION « fusionner des appels NON CONSÉCUTIFS » (agrégat 3+5=×8) :
// la signature attendue (3 puces) ne peut pas être produite par l'état mutant.
const distantMutant = buildMutantRow([
    buildMutantChip("read_nodes", 8, false),
    buildMutantChip("get_object_info", undefined, false),
]);
assert.deepStrictEqual(groupedSignature(distantMutant), [[["read_nodes", "8"], ["get_object_info", "1"]]],
    "le mutant « agrégat à distance » est bien détecté dans la signature (≠ état attendu)");
assert.notDeepStrictEqual(groupedSignature(distantMutant), goodSig,
    "contrôle négatif (g1) : une fusion par-dessus l'interruption NE produit PAS la signature attendue → le test rougirait");

// (g2) MUTATION « fusionner un appel avec undo » : invariant 2 (undo ⇒ pas de compteur).
const undoMutant = buildMutantRow([buildMutantChip("X", 2, true)]);
assert.throws(() => assertGroupingInvariants(undoMutant), /undo/,
    "contrôle négatif (g2) : une puce undo portant un compteur fait ROUGIR l'invariant");
assert.strictEqual(assertGroupingInvariants(chat), 3, "…et l'invariant reste vert sur le DOM réel");

// (g3) MUTATION « remettre une puce par appel » : invariant 3 (voisines identiques fusionnables).
const perCallMutant = buildMutantRow([
    buildMutantChip("read_nodes", undefined, false),
    buildMutantChip("read_nodes", undefined, false),
]);
assert.throws(() => assertGroupingInvariants(perCallMutant), /fusionn/,
    "contrôle négatif (g3) : deux puces voisines identiques non fusionnées font ROUGIR l'invariant");

// (g4) MUTATION « afficher le compteur dès ×1 » : invariant 1 (compteur ≥ ×2).
const xOneMutant = buildMutantRow([buildMutantChip("read_nodes", 1, false)]);
assert.throws(() => assertGroupingInvariants(xOneMutant), /compteur/,
    "contrôle négatif (g4) : un compteur ×1 affiché fait ROUGIR l'invariant");
ok("(g) mutations « agrégat à distance », « fusion avec undo », « une puce par appel », « ×1 affiché » détectées");

console.log(`\n✅ Regroupement des outils Blobby (⚡ nom ×N, séparation stricte, undo-safe) : TOUS LES TESTS PASSENT (${n} groupes d'assertions)`);
process.exit(0);
