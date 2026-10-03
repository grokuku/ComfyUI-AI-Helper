// ─────────────────────────────────────────────────────────────────────────
// BLOBBY — CONFIRMATION avant l'effacement de l'historique de chat (bouton 🗑).
//
// Existant (avant correctif) : clic sur 🗑 → suppression IMMÉDIATE et IRRÉVERSIBLE
//   (innerHTML vidé + persistance locale `blobbyData.chatHistory=[]` + sync
//   distante `/api/settings`), sans aucune demande de confirmation.
//
// Couverture :
//   (a) clic sur 🗑 → la modale de confirmation du système UNIFIÉ s'ouvre
//       (AIH.Dialog, vraie modale : aucun window.confirm) ; le bouton destructif
//       porte la classe `aih-dialog-btn-danger` et le libellé « Supprimer » ;
//       RIEN n'est encore supprimé tant que la modale est ouverte ;
//   (b) bouton « Annuler » → AUCUNE suppression : état local + DOM inchangés,
//       aucune écriture `AIH_config` (donc aucun armement de sync distante) ;
//   (c) Échap → annule (idem Annuler) ;
//   (d) « Supprimer » → suppression EXACTEMENT comme avant (ancien historique
//       effacé, message d'accueil ré-ajouté, sync distante effectuée) ;
//   (e) parité i18n FR/EN stricte des nouvelles clés (présentes, non vides).
//
// Usage : node js/test_blobby_clear_confirm.mjs
//   jsdom résolu par js/test_helpers/jsdom_loader.mjs ; absent = SKIP (exit 2).
// Code de sortie : 0 = PASS, 2 = SKIP, 1 = FAIL.
//
// Contrôles négatifs par mutation : /projects/.aih_tmp/blobby_clear_confirm/mutate.sh
//   M1 retire la confirmation (clic 🗑 = suppression directe) → ce test doit être
//   ROUGE ; M2 rend « Annuler » destructif → ce test doit être ROUGE.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const JSDOM = await loadJsdomOrSkip("test_blobby_clear_confirm");
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

// ── Espion d'écriture localStorage : « aucun appel de suppression » se prouve
//    par l'absence d'écriture de `AIH_config` (voie utilisée par _blobbySave). ──
const setItemCalls = [];
const origSetItem = domWindow.localStorage.setItem.bind(domWindow.localStorage);
domWindow.localStorage.setItem = (k, v) => { setItemCalls.push(String(k)); return origSetItem(k, v); };

// ── Fake fetch : enregistre les appels (sync locale/distance). ──
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
    if (String(url).includes("/api/presets")) return jsonResponse([]);
    if (String(url).includes("/api/settings")) return jsonResponse({});
    return jsonResponse({});
};

// ── Faux app ComfyUI (avant import : waitForApp s'y enregistre). ──
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

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const SETTINGS_POSTS = () => httpCalls.filter((c) => c.method === "POST" && c.url.includes("/api/settings"));
const histOf = () => {
    try { return (JSON.parse(localStorage.getItem("AIH_config")).blobbyData || {}).chatHistory || []; }
    catch { return []; }
};
const msgsOf = () => [...(document.getElementById("blobby-chat-msgs") || { querySelectorAll: () => [] }).querySelectorAll(".blobby-msg")];

const SENTINEL = "SENTINEL_OLD_HISTORY";

function openChat() {
    // Repart d'une modale de chat neuve (évite tout état résiduel entre groupes).
    const existing = document.querySelector(".blobby-chat-modal");
    if (existing) existing.remove();
    Blobby._openChatModal();
    return document.querySelector(".blobby-chat-modal");
}

/** Ouvre la modale de confirmation via un vrai clic sur 🗑 ; renvoie son root. */
async function clickTrashOpenConfirm() {
    const modal = document.querySelector(".blobby-chat-modal");
    const trash = [...modal.querySelectorAll("button")].find((b) => b.textContent === "🗑");
    assert.ok(trash, "bouton 🗑 présent dans l'en-tête du chat");
    trash.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
    await tick();
    return [...document.querySelectorAll(".aih-dialog-root")].find((r) => r !== modal && r.querySelector("[data-aih-ok]"));
}

/* ══════════════════ Mise en place d'un historique connu ══════════════════ */
const modal = openChat();
const msgs = document.getElementById("blobby-chat-msgs");
assert.ok(modal && msgs, "modale de chat + zone de messages présentes");
// Un message utilisateur (ajoute une bulle + déclenche une sauvegarde/sync).
Blobby._addChatMessage(msgs, "user", SENTINEL);
// Historique persistant de référence.
localStorage.setItem("AIH_config", JSON.stringify({
    serverUrl: "http://aih.test", apiKey: "k",
    blobbyData: { chatHistory: [{ role: "user", text: SENTINEL }] },
}));
// Laisse s'écouler les syncs armées par la mise en place, puis remet à zéro.
await tick(2200);
httpCalls.length = 0;
setItemCalls.length = 0;
const MSGS_BEFORE = msgsOf().length;
assert.ok(MSGS_BEFORE >= 2, `état initial : ${MSGS_BEFORE} bulles (accueil + sentinelle)`);
assert.ok(histOf().some((e) => e && String(e.text).includes(SENTINEL)), "historique initial contient la sentinelle");

/* ══════════════════ (a) Clic 🗑 → modale de confirmation ═════════════════ */
console.log("(a) Clic sur 🗑 → modale de confirmation (AIH.Dialog) ouverte, bouton destructif rouge");

const confirmRoot = await clickTrashOpenConfirm();
assert.ok(confirmRoot, "la modale de confirmation est OUVERTE (racine AIH.Dialog avec [data-aih-ok])");
assert.ok(!/\bwindow\.confirm\b/.test(String(domWindow.confirm || "")), "aucun window.confirm natif utilisé");
const okBtn = confirmRoot.querySelector("[data-aih-ok]");
const cancelBtn = confirmRoot.querySelector("[data-aih-cancel]");
assert.ok(okBtn && cancelBtn, "deux actions : Annuler + action de confirmation");
assert.ok(okBtn.classList.contains("aih-dialog-btn-danger"), "action de confirmation en ROUGE (aih-dialog-btn-danger)");
assert.strictEqual(okBtn.textContent.trim(), I18n.t("bl.clearConfirmAction"), `libellé destructif i18n : « ${okBtn.textContent.trim()} »`);
assert.strictEqual(cancelBtn.textContent.trim(), I18n.t("dialog.cancel"), "libellé Annuler i18n");
const confirmMsg = (confirmRoot.querySelector(".aih-dialog-message") || {}).textContent || "";
assert.strictEqual(confirmMsg.trim(), I18n.t("bl.clearConfirm"), "message = clé i18n bl.clearConfirm (clair et précis)");
assert.ok(/définitiv|irréversible/i.test(confirmMsg), "le message annonce le caractère DÉFINITIF/irréversible");
assert.strictEqual(confirmRoot.querySelector(".aih-dialog-title").textContent.trim(), I18n.t("bl.clearTitle"), "titre i18n de la confirmation");
// Tant que la modale est ouverte : RIEN n'a été supprimé ni sauvegardé.
assert.ok(histOf().some((e) => e && String(e.text).includes(SENTINEL)), "tant que la modale est ouverte, historique LOCAL intact");
assert.strictEqual(msgsOf().length, MSGS_BEFORE, "tant que la modale est ouverte, DOM intact");
assert.ok(!setItemCalls.includes("AIH_config"), "aucune écriture AIH_config à l'ouverture de la modale");
ok("(a) 🗑 → modale unifiée avec bouton rouge « Supprimer », aucun effet immédiat");

/* ══════════════════ (b) Annuler → AUCUNE suppression ════════════════════ */
console.log("(b) Annuler → historique intact (local + distant), aucune écriture");

httpCalls.length = 0;
setItemCalls.length = 0;
cancelBtn.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick();
assert.ok(!document.body.contains(confirmRoot), "la modale de confirmation est fermée après Annuler");
assert.ok(!setItemCalls.includes("AIH_config"), "Annuler : AUCUNE écriture AIH_config (aucun appel de suppression)");
assert.ok(histOf().some((e) => e && String(e.text).includes(SENTINEL)), "Annuler : historique LOCAL intact (sentinelle présente)");
assert.strictEqual(msgsOf().length, MSGS_BEFORE, "Annuler : DOM des messages intact");
// Aucune sync distante armée → aucune suppression côté serveur.
await tick(2200);
assert.strictEqual(SETTINGS_POSTS().length, 0, "Annuler : AUCUN POST /api/settings (aucune suppression distante)");
ok("(b) Annuler : ni locale ni distante, AUCUNE suppression, état inchangé");

/* ══════════════════ (c) Échap → annule ═════════════════════════════════ */
console.log("(c) Échap → annule (aucune suppression)");

setItemCalls.length = 0;
const confirmEsc = await clickTrashOpenConfirm();
assert.ok(confirmEsc, "modale réouverte pour le test Échap");
document.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await tick();
assert.ok(!document.body.contains(confirmEsc), "Échap ferme la modale de confirmation");
assert.ok(!setItemCalls.includes("AIH_config"), "Échap : AUCUNE écriture AIH_config");
assert.ok(histOf().some((e) => e && String(e.text).includes(SENTINEL)), "Échap : historique LOCAL intact");
assert.strictEqual(msgsOf().length, MSGS_BEFORE, "Échap : DOM des messages intact");
ok("(c) Échap = Annuler : fermeture sans effet de bord ni suppression");

/* ══════════════════ (d) Supprimer → suppression comme avant ════════════ */
console.log("(d) Supprimer → suppression effective, identique à l'existant");

httpCalls.length = 0;
const confirmDel = await clickTrashOpenConfirm();
assert.ok(confirmDel, "modale réouverte pour le test Supprimer");
confirmDel.querySelector("[data-aih-ok]").dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick();
assert.ok(!document.body.contains(confirmDel), "la modale est fermée après Supprimer");
assert.ok(!histOf().some((e) => e && String(e.text).includes(SENTINEL)), "Supprimer : l'ancien historique est EFFACÉ (local)");
const after = msgsOf();
assert.strictEqual(after.length, 1, "Supprimer : seul le message d'accueil est ré-ajouté (comportement d'origine)");
assert.strictEqual(after[0].dataset.role, "blobby", "le message ré-ajouté est bien l'accueil Blobby");
assert.ok(document.body.contains(confirmDel) === false, "aucune trace de la modale de confirmation");
// Sync distante : l'historique poussé ne contient plus la sentinelle.
await tick(2200);
const posts = SETTINGS_POSTS();
assert.ok(posts.length >= 1, "Supprimer : POST /api/settings effectué (sync distante)");
const pushed = posts[posts.length - 1].body && posts[posts.length - 1].body.blobbyData
    ? posts[posts.length - 1].body.blobbyData.chatHistory : null;
assert.ok(Array.isArray(pushed), "l'historique poussé au serveur est un tableau");
assert.ok(!pushed.some((e) => e && String(e.text).includes(SENTINEL)), "l'historique poussé au serveur ne contient plus l'ancien message");
ok("(d) Supprimer : suppression effective (local + distant), comportement d'origine conservé");

/* ══════════════════ (e) Parité i18n FR/EN ══════════════════════════════ */
console.log("(e) Parité i18n FR/EN des nouvelles clés");

const CLEAR_KEYS = ["bl.clearTitle", "bl.clearConfirm", "bl.clearConfirmAction"];
for (const k of CLEAR_KEYS) {
    assert.ok(k in (captured.fr || {}), `clé FR présente : ${k}`);
    assert.ok(k in (captured.en || {}), `clé EN présente : ${k}`);
    assert.ok(String(captured.fr[k]).trim() !== "", `clé FR non vide : ${k}`);
    assert.ok(String(captured.en[k]).trim() !== "", `clé EN non vide : ${k}`);
}
assert.notStrictEqual(captured.fr["bl.clearConfirm"], captured.en["bl.clearConfirm"], "le message FR et EN diffèrent (vraie traduction)");
// Libellés réutilisés du dialogue unifié : présents dans les deux langues.
const savedLocale = I18n.getLocale();
I18n.setLocale("fr");
const frCancel = I18n.t("dialog.cancel");
const frDelete = I18n.t("dialog.delete");
I18n.setLocale("en");
const enCancel = I18n.t("dialog.cancel");
const enDelete = I18n.t("dialog.delete");
I18n.setLocale(savedLocale);
assert.ok(frCancel.trim() !== "" && enCancel.trim() !== "", "clé dialogue partagée non vide FR/EN : dialog.cancel");
assert.ok(frDelete.trim() !== "" && enDelete.trim() !== "", "clé dialogue partagée non vide FR/EN : dialog.delete");
ok(`(e) parité FR/EN OK : ${CLEAR_KEYS.length} nouvelles clés présentes et non vides`);

console.log(`\n✅ Confirmation d'effacement du chat Blobby : TOUS LES TESTS PASSENT (${n} assertions)`);
process.exit(0);
