// ─────────────────────────────────────────────────────────────────────────
// BLOBBY — CONFIRMATION DESTRUCTIVE avant « Tout oublier » (bouton 🧹 mémoire).
//
// Existant (avant correctif) : clic sur 🧹 → confirmation GÉNÉRIQUE (bouton
//   « Confirmer » NON rouge, via aihShowConfirm/window) puis effacement de la
//   mémoire locale (localStorage `blobbyLocalMemories`) ET distante
//   (POST /api/blobby/memory/forget).
//
// Couverture (vraie AIH.Dialog, aucun stub de dialogue) :
//   (a) clic sur 🧹 → modale du système UNIFIÉ avec bouton destructif en ROUGE
//       (`aih-dialog-btn-danger`) ; RIEN n'est effacé tant qu'elle est ouverte ;
//   (b) « Annuler » → AUCUNE écriture locale et AUCUN POST
//       /api/blobby/memory/forget ;
//   (c) Échap → annule (idem Annuler) ;
//   (d) « Tout oublier » → comportement d'origine : local effacé + POST distant ;
//   (e) le chemin générique `aihShowConfirm` n'est PLUS utilisé ;
//   (f) parité i18n FR/EN stricte des clés (message mis à jour + libellé bouton).
//
// Usage : node js/test_blobby_forget_confirm.mjs
//   jsdom résolu par js/test_helpers/jsdom_loader.mjs ; absent = SKIP (exit 2).
// Code de sortie : 0 = PASS, 2 = SKIP, 1 = FAIL.
//
// Contrôles négatifs par mutation : /projects/.aih_tmp/blobby_forget_confirm/mutate.sh
//   M1 retire la confirmation (clic 🧹 = effacement direct) → ce test doit être
//   ROUGE ; M2 rend « Annuler » destructif → ce test doit être ROUGE.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const JSDOM = await loadJsdomOrSkip("test_blobby_forget_confirm");
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

// Mémoire LOCALE de référence (lue au chargement du module).
const MEM_KEY = "blobbyLocalMemories";
const SENTINEL = "SENTINEL_LOCAL_MEMORY";
localStorage.setItem(MEM_KEY, JSON.stringify([{ content: SENTINEL, type: "episode", importance: 3 }]));

// Interdit formellement window.confirm.
domWindow.confirm = () => { throw new Error("window.confirm() INTERDIT — utiliser AIH.confirm"); };

// ── Fake fetch : enregistre les appels (dont POST /api/blobby/memory/forget). ──
const httpCalls = [];
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
    let body = null;
    try { body = init && typeof init.body === "string" ? JSON.parse(init.body) : null; } catch { body = null; }
    httpCalls.push({ url: String(url), method: (init && init.method) || "GET", body });
    return jsonResponse({});
};

// ── Faux app ComfyUI (avant import). ──
domWindow.app = {
    graph: { nodes: [], setDirtyCanvas() {}, getNodeById() { return null; } },
    canvas: { setDirtyCanvas() {}, centerOnNode() {} },
    registerExtension(ext) { this.extensions.push(ext); },
    extensions: [],
};

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

const Blobby = domWindow.Blobby;
assert.ok(Blobby && typeof Blobby._openChatModal === "function", "Blobby exposé (window.Blobby)");
assert.strictEqual(typeof domWindow.AIH.Dialog.open, "function", "VRAI AIH.Dialog disponible (aucun stub)");
assert.strictEqual(typeof domWindow.AIH.confirm, "function", "AIH.confirm (dialogue unifié) disponible");

// Espion aihShowConfirm (chemin GÉNÉRIQUE historique) : doit rester INUTILISÉ.
const genericCalls = [];
domWindow.aihShowConfirm = function (...args) {
    genericCalls.push(args);
    // Reproduit le comportement d'un repli : résout false (annulation).
    return Promise.resolve(false);
};

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const FORGET_POSTS = () => httpCalls.filter((c) => c.method === "POST" && c.url.includes("/api/blobby/memory/forget"));
const localMem = () => localStorage.getItem(MEM_KEY);
const dialogOf = () => [...document.querySelectorAll(".aih-dialog-root")].find((r) => r.querySelector("[data-aih-ok]"));

function openChat() {
    const existing = document.querySelector(".blobby-chat-modal");
    if (existing) existing.remove();
    Blobby._openChatModal();
    return document.querySelector(".blobby-chat-modal");
}

/** Ouvre la modale de confirmation via un vrai clic sur 🧹 ; renvoie son root. */
async function clickForgetOpenConfirm() {
    const modal = document.querySelector(".blobby-chat-modal");
    const btn = [...modal.querySelectorAll("button")].find((b) => b.textContent === "🧹");
    assert.ok(btn, "bouton 🧹 présent dans l'en-tête du chat");
    btn.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
    await tick();
    return dialogOf();
}

/* ══════════════════ (a) Clic 🧹 → modale de confirmation ════════════════ */
console.log("(a) Clic sur 🧹 → modale de confirmation (AIH.Dialog) ouverte, bouton destructif rouge");

const chatModal = openChat();
assert.ok(chatModal, "modale de chat ouverte");
assert.strictEqual(localMem() !== null, true, "mémoire locale de référence présente avant le test");
await tick(200);
httpCalls.length = 0;

const confirmRoot = await clickForgetOpenConfirm();
assert.ok(confirmRoot, "la modale de confirmation est OUVERTE (racine AIH.Dialog avec [data-aih-ok])");
const okBtn = confirmRoot.querySelector("[data-aih-ok]");
const cancelBtn = confirmRoot.querySelector("[data-aih-cancel]");
assert.ok(okBtn && cancelBtn, "deux actions : Annuler + action de confirmation");
assert.ok(okBtn.classList.contains("aih-dialog-btn-danger"), "action de confirmation en ROUGE (aih-dialog-btn-danger)");
assert.strictEqual(okBtn.textContent.trim(), I18n.t("bl.forgetConfirmAction"), `libellé destructif i18n : « ${okBtn.textContent.trim()} »`);
assert.strictEqual(cancelBtn.textContent.trim(), I18n.t("dialog.cancel"), "libellé Annuler i18n");
const confirmMsg = (confirmRoot.querySelector(".aih-dialog-message") || {}).textContent || "";
assert.strictEqual(confirmMsg.trim(), I18n.t("bl.forgetConfirm"), "message = clé i18n bl.forgetConfirm (clair et précis)");
assert.ok(/définitiv|irréversible/i.test(confirmMsg), "le message annonce le caractère DÉFINITIF/irréversible");
assert.ok(/local|navigateur/i.test(confirmMsg) && /serveur|server/i.test(confirmMsg), "le message mentionne la mémoire LOCALE et SERVEUR");
assert.strictEqual(confirmRoot.querySelector(".aih-dialog-title").textContent.trim(), I18n.t("bl.forgetTitle"), "titre i18n de la confirmation");
// Tant que la modale est ouverte : RIEN n'a été effacé.
assert.strictEqual(localMem() !== null, true, "tant que la modale est ouverte, mémoire locale intacte");
assert.strictEqual(FORGET_POSTS().length, 0, "tant que la modale est ouverte, AUCUN POST /api/blobby/memory/forget");
assert.strictEqual(genericCalls.length, 0, "le chemin générique aihShowConfirm n'est PAS utilisé");
ok("(a) 🧹 → modale unifiée avec bouton rouge, aucun effet immédiat");

/* ══════════════════ (b) Annuler → AUCUN effacement ═════════════════════ */
console.log("(b) Annuler → aucune écriture locale, aucun POST");

httpCalls.length = 0;
cancelBtn.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick();
assert.ok(!document.body.contains(confirmRoot), "la modale de confirmation est fermée après Annuler");
assert.strictEqual(localMem() !== null, true, "Annuler : mémoire locale INTACTE (aucune écriture locale)");
assert.ok(localMem().includes(SENTINEL), "Annuler : la sentinelle locale est toujours là");
await tick(200);
assert.strictEqual(FORGET_POSTS().length, 0, "Annuler : AUCUN POST /api/blobby/memory/forget");
ok("(b) Annuler : aucune écriture locale, aucun POST distant");

/* ══════════════════ (c) Échap → annule ═════════════════════════════════ */
console.log("(c) Échap → annule (aucun effacement)");

httpCalls.length = 0;
const confirmEsc = await clickForgetOpenConfirm();
assert.ok(confirmEsc, "modale réouverte pour le test Échap");
document.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await tick();
assert.ok(!document.body.contains(confirmEsc), "Échap ferme la modale de confirmation");
assert.ok(localMem() !== null && localMem().includes(SENTINEL), "Échap : mémoire locale intacte");
await tick(200);
assert.strictEqual(FORGET_POSTS().length, 0, "Échap : AUCUN POST distant");
ok("(c) Échap = Annuler : fermeture sans effacement");

/* ══════════════════ (d) Tout oublier → effacement local + distant ══════ */
console.log("(d) Tout oublier → effacement effectif (local + distant), comportement d'origine");

httpCalls.length = 0;
const confirmDel = await clickForgetOpenConfirm();
assert.ok(confirmDel, "modale réouverte pour le test Tout oublier");
confirmDel.querySelector("[data-aih-ok]").dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick();
assert.ok(!document.body.contains(confirmDel), "la modale est fermée après Tout oublier");
assert.strictEqual(localMem(), null, "Tout oublier : la mémoire locale est EFFACÉE (localStorage supprimé)");
await tick(300);
const posts = FORGET_POSTS();
assert.strictEqual(posts.length, 1, "Tout oublier : UN POST /api/blobby/memory/forget effectué (mémoire distante)");
// Message système d'effacement ré-ajouté dans le chat.
const msgs = [...(document.getElementById("blobby-chat-msgs") || { querySelectorAll: () => [] }).querySelectorAll(".blobby-msg")];
assert.ok(msgs.some((m) => (m.textContent || "").includes("🧹")), "Tout oublier : message système « tout oublié » ajouté (comportement d'origine)");
ok("(d) Tout oublier : local + distant effacés, comportement d'origine conservé");

/* ══════════════════ (e) Parité i18n FR/EN ═════════════════════════════ */
console.log("(e) Parité i18n FR/EN des clés (message mis à jour + libellé bouton)");

const KEYS = ["bl.forgetConfirm", "bl.forgetConfirmAction", "bl.forgetTitle"];
for (const k of KEYS) {
    assert.ok(k in (captured.fr || {}), `clé FR présente : ${k}`);
    assert.ok(k in (captured.en || {}), `clé EN présente : ${k}`);
    assert.ok(String(captured.fr[k]).trim() !== "", `clé FR non vide : ${k}`);
    assert.ok(String(captured.en[k]).trim() !== "", `clé EN non vide : ${k}`);
}
assert.notStrictEqual(captured.fr["bl.forgetConfirm"], captured.en["bl.forgetConfirm"], "le message FR et EN diffèrent (vraie traduction)");
assert.ok(/définitiv/i.test(captured.fr["bl.forgetConfirm"]) && /permanently|irreversible/i.test(captured.en["bl.forgetConfirm"]), "les deux messages annoncent le caractère définitif");
ok(`(e) parité FR/EN OK : ${KEYS.length} clés présentes et non vides`);

console.log(`\n✅ Confirmation « Tout oublier » (mémoire Blobby) : TOUS LES TESTS PASSENT (${n} assertions)`);
process.exit(0);
