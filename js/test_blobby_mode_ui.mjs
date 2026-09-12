// ─────────────────────────────────────────────────────────────────────────
// ÉTAPE 3 — UI du dropdown de mode (barre de mode en tête du corps du chat)
// + conscience du mode dans le prompt LLM + persistance + i18n.
//
// Couverture :
//   (a) le <select> est initialisé sur l'état réel (read par défaut, active si
//       persisté) ; il vit en 1er enfant du corps, PAS dans le header ;
//   (b) changer la valeur appelle setMode(), met à jour la bordure/état et
//       affiche un message de bascule ; une valeur inconnue est rejetée et le
//       <select> se resynchronise sur l'état réel (aucune désynchronisation) ;
//   (c) persistance round-trip : setMode → _blobbySave('blobbyMode'), fermeture
//       puis réouverture → état restauré ;
//   (d) la consigne de mode est dans le prompt LLM des DEUX chemins (texte read
//       ET tool_calls active), avec le message de refus exact en Lecture seule ;
//   (e) CONTRÔLE NÉGATIF : sans l'injection du mode, le refus disparaît du
//       prompt, ET un <select> de mode réintroduit dans le header rompt
//       l'invariant d'unicité (preuve que l'assertion n'est pas vide) ;
//   (f) parité i18n FR/EN des clés bl.mode.* / bl.* ;
//   (g) les clés mode sont définies exactement 2x (FR+EN, 0 doublon) et
//       toutes référencées dans le code (0 clé morte).
//
// Usage : node js/test_blobby_mode_ui.mjs
//   jsdom résolu par js/test_helpers/jsdom_loader.mjs ; absent = SKIP (exit 2).
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const JSDOM = await loadJsdomOrSkip("test_blobby_mode_ui");
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

// Config : serveur + preset Blobby, locale FR déterministe.
localStorage.setItem("aih_locale", "fr");
localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "http://aih.test", apiKey: "k", blobbyPreset: "3" }));

// ── Fake fetch global ──
const httpCalls = [];
const llmQueue = [];
function jsonResponse(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) },
        json: async () => data,
        text: async () => JSON.stringify(data),
    };
}
globalThis.fetch = async (url, init) => {
    const u = String(url);
    let body = null;
    try { body = init && typeof init.body === "string" ? JSON.parse(init.body) : null; } catch { body = init?.body ?? null; }
    httpCalls.push({ url: u, method: (init && init.method) || "GET", body });

    if (u.includes("/api/keywords/llm-process")) {
        if (body && typeof body.instruction === "string" && body.instruction.includes("Personnalite actuelle")) {
            return jsonResponse({ output: "Blobby perso" });
        }
        if (llmQueue.length) {
            const item = llmQueue.shift();
            if (item && item.__status !== undefined) return jsonResponse(item.data, item.__status);
            return jsonResponse(item);
        }
        return jsonResponse({ output: "..." });
    }
    if (u.includes("/api/blobby/memory")) return jsonResponse({ results: [] });
    if (u.includes("/api/presets")) return jsonResponse([]);
    if (u.includes("/api/settings")) return jsonResponse({});
    return jsonResponse({});
};

// ── Faux app ComfyUI minimal (avant import : waitForApp s'y enregistre) ──
function freshApp() {
    const app = {
        graph: { nodes: [], setDirtyCanvas() {}, getNodeById() { return null; } },
        canvas: { setDirtyCanvas() {}, centerOnNode() {} },
        registerExtension(ext) { app.extensions.push(ext); },
        extensions: [],
    };
    return app;
}
globalThis.window.app = freshApp();

// ── Mock de la modale AIH v2 : renvoie un DOM réel, classe blobby-chat-modal
//    (pour que la détection « déjà ouverte » fonctionne comme en prod).
//    NOTE : aih_dialog.js (importé par blobby_companion.js) définit lui-même
//    window.aihOpenModalV2 ; on RÉASSIGNE notre mock APRÈS l'import (ci-dessous).
let modalSeq = 0;
function mockOpenModal(opts) {
    modalSeq++;
    const modal = document.createElement("div");
    modal.className = "aih-modal " + (opts.className || "");
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

// ── Import des modules (capture des dictionnaires AVANT enregistrement) ──
await import("./aih_i18n.js");
const I18n = domWindow.AIH.I18n;
const captured = {};
const origAddDict = I18n.addDict.bind(I18n);
I18n.addDict = (lang, entries) => {
    captured[lang] = Object.assign(captured[lang] || {}, entries);
    return origAddDict(lang, entries);
};
I18n.setLocale("fr");
await import("./blobby_companion.js");

// Réassignation APRÈS import : aih_dialog.js a pu écraser le global.
domWindow.aihOpenModalV2 = mockOpenModal;

const Blobby = domWindow.Blobby;
assert.ok(Blobby && typeof Blobby._openChatModal === "function", "Blobby exposé (window.Blobby) avec _openChatModal");
assert.ok(typeof Blobby._modeInstruction === "function", "Blobby._modeInstruction exposé (consigne de mode)");

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const llmPosts = () => httpCalls
    .filter((c) => c.url.includes("/api/keywords/llm-process"))
    .filter((c) => !(c.body && typeof c.body.instruction === "string" && c.body.instruction.includes("Personnalite actuelle")));

const REFUSAL = "Je suis en Lecture seule, je ne peux pas modifier le graphe — passe en mode Actif si tu veux que je m'en occupe.";
const READ_PROMPT = I18n.t("bl.mode.readPrompt");
const ACTIVE_PROMPT = I18n.t("bl.mode.activePrompt");
assert.ok(READ_PROMPT.includes(REFUSAL), "bl.mode.readPrompt reprend le refus mot pour mot");
assert.ok(ACTIVE_PROMPT.includes("outils fournis"), "bl.mode.activePrompt mentionne les outils fournis");

/* ══════════════════ (a) Ouverture : barre de mode en tête du corps ══════ */
console.log("(a) Ouverture du chat : barre de mode en 1er enfant du corps");

Blobby._initMode();
assert.strictEqual(Blobby.getMode(), "read", "état initial : read");
Blobby._openChatModal();

const modal = document.querySelector(".aih-modal.blobby-chat-modal");
assert.ok(modal, "modale ouverte (mock v2)");
const header = modal.querySelector(".aih-dialog-header");
const bar = document.getElementById("blobby-chat-modebar");
assert.ok(bar, "barre de mode présente (#blobby-chat-modebar)");
const bodyWrapper = bar.parentElement;
assert.strictEqual(bodyWrapper.firstChild, bar, "la barre de mode est le 1er enfant du corps");
assert.strictEqual(bar.children[0].textContent, "Mode", "libellé « Mode » (i18n)");
assert.strictEqual(bar.children[1].tagName, "SELECT", "un <select> suit le libellé");
const sel = bar.querySelector("#blobby-chat-mode-select");
assert.deepStrictEqual([...sel.options].map((o) => o.value), ["read", "active"], "2 options : read / active");
assert.strictEqual(sel.options[0].textContent, "🔵 Lecture seule", "option 1 FR");
assert.strictEqual(sel.options[1].textContent, "🟠 Actif", "option 2 FR");
assert.strictEqual(sel.value, "read", "état initial du <select> : read (défaut)");
assert.ok(bar.classList.contains("blobby-mode-read"), "classe de bordure bleue (read)");
assert.ok(!bar.classList.contains("blobby-mode-active"), "aucune classe active");
// ── Unicité STRICTE (design validé : UN seul contrôle, dans le corps) ──
// Exigence : exactement UNE barre + UN <select> de mode dans TOUT le document,
// et AUCUN <select> dans le header (déviation de l'agent B bannie).
assert.strictEqual(document.querySelectorAll("#blobby-chat-modebar").length, 1, "exactement UNE barre de mode dans le document");
assert.strictEqual(document.querySelectorAll("#blobby-chat-mode-select").length, 1, "exactement UN <select> de mode dans le document");
assert.strictEqual(document.querySelectorAll("#blobby-chat-mode-select")[0], sel, "le <select> unique est celui de la barre du corps");
assert.strictEqual(header.querySelectorAll("select").length, 0, "AUCUN <select> dans .aih-dialog-header");
assert.strictEqual(modal.querySelectorAll(".aih-dialog-header select").length, 0, "AUCUN <select> dans l'arbre du header");
assert.strictEqual(header.querySelector("#blobby-chat-mode-select"), null, "pas de <select> de mode dans le header");
assert.strictEqual(bar.closest(".aih-dialog-header"), null, "la barre n'est pas dans le header draggable");

// ── Contrôle négatif (unicité) : régression simulée — réintroduire le
//    <select> de mode dans le header (comme l'agent B) DOIT être détecté par
//    l'invariant ci-dessus. On l'injecte, on prouve que le compte passe à 2,
//    puis on restaure (état propre). Reste dans la suite : si la garde
//    d'unicité disparaissait du test, ce bloc échouerait.
const headerRightEl = header.querySelector(".aih-dialog-header-right");
const ghostSelect = document.createElement("select");
ghostSelect.id = "blobby-chat-mode-select";
headerRightEl.appendChild(ghostSelect);
assert.strictEqual(document.querySelectorAll("#blobby-chat-mode-select").length, 2, "contrôle négatif : un doublon header porterait le compte à 2 (détecté)");
assert.strictEqual(header.querySelectorAll("select").length, 1, "contrôle négatif : le header contiendrait alors un <select> (détecté)");
ghostSelect.remove();
assert.strictEqual(document.querySelectorAll("#blobby-chat-mode-select").length, 1, "régression annulée : retour à UN SEUL contrôle de mode");
assert.strictEqual(header.querySelectorAll("select").length, 0, "header de nouveau sans <select>");
ok("(a) barre de mode en tête du corps, 2 options, bordure bleue, AUCUN badge/header-select (unicité prouvée + contrôle négatif)");

/* ══════════════════ (b) Changement de mode via le <select> ═══════════════ */
console.log("(b) Changement de mode : setMode + bordure/état + resynchronisation");

const chat = document.getElementById("blobby-chat-msgs");
function resetChat() {
    chat.innerHTML = "";
    httpCalls.length = 0;
    llmQueue.length = 0;
    globalThis.window.app = freshApp();
}
const msgs = (role) => [...chat.querySelectorAll(".blobby-msg")].filter((el) => el.dataset.role === role);

sel.value = "active";
sel.dispatchEvent(new domWindow.Event("change", { bubbles: true }));
assert.strictEqual(Blobby.getMode(), "active", "setMode('active') appliqué");
assert.strictEqual(sel.value, "active", "le <select> affiche active");
assert.ok(bar.classList.contains("blobby-mode-active"), "classe de bordure orange (active)");
assert.ok(!bar.classList.contains("blobby-mode-read"), "classe read retirée");
assert.strictEqual(JSON.parse(localStorage.getItem("AIH_config")).blobbyData.blobbyMode, "active", "persisté (blobbyData.blobbyMode)");
const switchNotice = msgs("system").map((e) => e.textContent).join(" ");
assert.ok(switchNotice.includes("Actif"), `message de bascule affiché : ${switchNotice}`);
ok("(b) active : setMode appelé, bordure orange, persisté, message de bascule");

// Contrôle de désynchronisation : valeur inconnue injectée → rejetée + resync.
sel.value = "nonsense"; // aucune option → value devient ""
sel.dispatchEvent(new domWindow.Event("change", { bubbles: true }));
assert.strictEqual(Blobby.getMode(), "active", "valeur inconnue rejetée (setMode non contourné)");
assert.strictEqual(sel.value, "active", "le <select> se resynchronise sur l'état RÉEL (pas de désync)");
assert.ok(bar.classList.contains("blobby-mode-active"), "bordure toujours orange");
assert.strictEqual(JSON.parse(localStorage.getItem("AIH_config")).blobbyData.blobbyMode, "active", "persistance inchangée");
ok("(b) valeur inconnue : rejetée par setMode, <select> resynchronisé (aucune désync)");

/* ══════════════════ (c) Persistance round-trip ═══════════════════════════ */
console.log("(c) Persistance round-trip : setMode → save → fermeture/réouverture");

modal.remove(); // fermeture
assert.ok(!document.querySelector(".aih-modal.blobby-chat-modal"), "modale fermée");
Blobby._openChatModal();
const bar2 = document.getElementById("blobby-chat-modebar");
const sel2 = bar2.querySelector("#blobby-chat-mode-select");
assert.strictEqual(sel2.value, "active", "réouverture : <select> restauré sur active");
assert.ok(bar2.classList.contains("blobby-mode-active"), "réouverture : bordure orange restaurée");
assert.strictEqual(Blobby.getMode(), "active", "mode en mémoire conservé");

// Rechargement « à froid » : la valeur persistée pilote _initMode.
localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "http://aih.test", blobbyPreset: "3", blobbyData: { blobbyMode: "active" } }));
assert.strictEqual(Blobby._initMode(), "active", "_initMode lit la valeur persistée");
assert.strictEqual(Blobby.getMode(), "active", "mode restauré depuis la persistance");

// Retour à read via le <select> puis re-test.
document.querySelector(".aih-modal.blobby-chat-modal").remove();
sel2.value = "read"; // ancien noeud détaché → on rouvre
Blobby._openChatModal();
const sel3 = document.getElementById("blobby-chat-modebar").querySelector("#blobby-chat-mode-select");
sel3.value = "read";
sel3.dispatchEvent(new domWindow.Event("change", { bubbles: true }));
assert.strictEqual(Blobby.getMode(), "read", "retour read via le <select>");
document.querySelector(".aih-modal.blobby-chat-modal").remove();
Blobby._openChatModal();
const sel4 = document.getElementById("blobby-chat-modebar").querySelector("#blobby-chat-mode-select");
assert.strictEqual(sel4.value, "read", "réouverture : read restauré");
assert.ok(document.getElementById("blobby-chat-modebar").classList.contains("blobby-mode-read"), "bordure bleue restaurée");
ok("(c) round-trip : active et read persistés/restaurés à la réouverture");

/* ══════════════════ (d) Consigne de mode dans le prompt LLM ═════════════ */
console.log("(d) Consigne de mode dans le prompt (chemins read ET active)");

// ── chemin texte READ ──
resetChat();
Blobby.setMode("read");
llmQueue.push({ output: "d'accord" });
await Blobby._handleChatMessage(chat, "modifie les steps");
await tick();
let posts = llmPosts();
assert.strictEqual(posts.length, 1, "read : un seul tour texte");
const instrRead = posts[0].body.instruction;
assert.ok(typeof instrRead === "string", "read : POST historique avec instruction");
assert.ok(instrRead.includes(READ_PROMPT), "read : consigne de mode injectée (bl.mode.readPrompt)");
assert.ok(instrRead.includes(REFUSAL), "read : message de refus EXACT présent dans le prompt");
assert.ok(instrRead.includes("LECTURE SEULE"), "read : mention explicite du mode Lecture seule");
assert.ok(!instrRead.includes(ACTIVE_PROMPT), "read : PAS la consigne active");
ok("(d) chemin read : le prompt contient la consigne Lecture seule + le refus exact");

// ── chemin tool_calls ACTIVE ──
resetChat();
Blobby.setMode("active");
llmQueue.push({ output: "c'est fait" });
await Blobby._handleChatMessage(chat, "modifie les steps");
await tick();
posts = llmPosts();
assert.ok(posts.length >= 1, "active : au moins un POST");
const convoActive = posts[0].body.messages;
assert.ok(Array.isArray(convoActive), "active : contrat messages");
const instrActive = convoActive[convoActive.length - 1].content;
assert.ok(instrActive.includes(ACTIVE_PROMPT), "active : consigne de mode injectée (bl.mode.activePrompt)");
assert.ok(instrActive.includes("outils fournis"), "active : mention des outils fournis");
assert.ok(!instrActive.includes(REFUSAL), "active : PAS le message de refus");
ok("(d) chemin active : le prompt contient la consigne Actif (outils, sans confirmation)");

/* ══════════════════ (e) CONTRÔLE NÉGATIF ═════════════════════════════════ */
console.log("(e) Contrôle négatif : sans injection, le refus disparaît du prompt");

const realModeInstruction = Blobby._modeInstruction;
Blobby._modeInstruction = function () { return ""; };
resetChat();
Blobby.setMode("read");
llmQueue.push({ output: "x" });
await Blobby._handleChatMessage(chat, "fais une action");
await tick();
const instrNeg = llmPosts()[0].body.instruction;
assert.ok(!instrNeg.includes(REFUSAL), "contrôle négatif : le refus DISPARAÎT sans injection");
assert.ok(!instrNeg.includes("LECTURE SEULE"), "contrôle négatif : la mention du mode disparaît aussi");
Blobby._modeInstruction = realModeInstruction; // RESTAURATION

// Après restauration, la consigne revient (preuve que l'injection est bien la
// source du contenu testé en (d)).
resetChat();
llmQueue.push({ output: "ok" });
await Blobby._handleChatMessage(chat, "re-test");
await tick();
assert.ok(llmPosts()[0].body.instruction.includes(REFUSAL), "injection restaurée : le refus revient");
ok("(e) contrôle négatif prouvé : l'injection du mode est porteuse (patch → échec attendu → restauré)");

/* ══════════════════ (f) Parité i18n FR/EN ═══════════════════════════════ */
console.log("(f) Parité i18n FR/EN des clés bl.*");

const frKeys = Object.keys(captured.fr || {}).filter((k) => k.startsWith("bl."));
const missingEn = frKeys.filter((k) => !(k in (captured.en || {})));
const emptyEn = frKeys.filter((k) => String((captured.en || {})[k] ?? "").trim() === "");
assert.deepStrictEqual(missingEn, [], `clés bl.* sans traduction EN : ${missingEn.join(", ")}`);
assert.deepStrictEqual(emptyEn, [], `clés bl.* vides en EN : ${emptyEn.join(", ")}`);
for (const k of ["bl.mode.label", "bl.mode.read", "bl.mode.active", "bl.mode.tooltip", "bl.mode.switched", "bl.mode.readPrompt", "bl.mode.activePrompt"]) {
    assert.ok(k in (captured.fr || {}), `clé FR présente : ${k}`);
    assert.ok(k in (captured.en || {}), `clé EN présente : ${k}`);
}
ok(`(f) parité FR/EN OK : ${frKeys.length} clés bl.*, 0 manquante, 0 vide, clés mode présentes`);

/* ══════════════════ (g) Clés mode : ni doublon ni clé morte ════════════ */
console.log("(g) Clés mode : définitions uniques (FR+EN) et toutes référencées");

const here = path.dirname(fileURLToPath(import.meta.url));
const stringsSrc = fs.readFileSync(path.join(here, "aih_strings.js"), "utf8");
const companionSrc = fs.readFileSync(path.join(here, "blobby_companion.js"), "utf8");
const MODE_KEYS = ["bl.mode.label", "bl.mode.read", "bl.mode.active", "bl.mode.tooltip", "bl.mode.switched", "bl.mode.readPrompt", "bl.mode.activePrompt"];
for (const k of MODE_KEYS) {
    const esc = k.replace(/\./g, "\\.");
    const defs = (stringsSrc.match(new RegExp(`"${esc}"\\s*:`, "g")) || []).length;
    assert.strictEqual(defs, 2, `${k} : définie exactement 2x (FR+EN), aucun doublon`);
    const refs = (companionSrc.match(new RegExp(`["']${esc}["']`, "g")) || []).length;
    assert.ok(refs >= 1, `${k} : référencée dans blobby_companion.js (aucune clé morte)`);
}
ok("(g) 7 clés mode : 2 définitions FR/EN chacune (0 doublon), toutes référencées (0 clé morte)");

console.log(`\n✅ Étape 3 — mode UI + conscience du prompt : TOUS LES TESTS PASSENT (${n} groupes d'assertions)`);
process.exit(0);
