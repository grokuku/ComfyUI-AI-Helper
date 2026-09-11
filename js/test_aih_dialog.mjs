// Simulation légère de AIH.Dialog (Vague 0) avec un fake DOM minimal.
// Usage : node test_aih_dialog.mjs
//
// Le faux DOM est fourni par le helper PARTAGÉ js/test_helpers/fake_dom.mjs
// (importé EXPLICITEMENT : plus aucun découpage par marqueur texte, donc plus
// de risque d'import complet silencieux si un commentaire change).
import assert from "node:assert";
import { fakeDocument } from "./test_helpers/fake_dom.mjs";

/* ─────────────────────────── Import du module ─────────────────────────── */
await import("./aih_i18n.js"); // charge AIH.I18n (fondation) avant le dialogue
const AIH = (await import("./aih_dialog.js")).default ?? globalThis.window.AIH;
const D = globalThis.window.AIH.Dialog;
const Theme = globalThis.window.AIH.Theme;

assert.ok(D && typeof D.open === "function", "AIH.Dialog.open existe");
assert.ok(Theme && typeof Theme.setTheme === "function", "AIH.Theme.setTheme existe");
assert.ok(globalThis.window.AIH.alert && globalThis.window.AIH.confirm, "helpers existent");
assert.ok(typeof globalThis.window.aihOpenModalV2 === "function", "wrapper aihOpenModalV2 existe");
assert.ok(typeof globalThis.window.aihShowAlert === "function", "wrapper aihShowAlert existe");
assert.ok(typeof globalThis.window.HolafModal?.show === "function", "wrapper HolafModal.show existe");

/* ── 1. Ouverture + close ───────────────────────────────────────────────── */
let opened = false;
const ctrl = D.open({ title: "Titre", content: "<p>hello</p>", width: "320px", onOpen: () => { opened = true; } });
assert.ok(opened, "onOpen appelé");
assert.ok(ctrl.el.classList.contains("aih-dialog-theme"), "racine thème");
assert.ok(ctrl.el.classList.contains("aih-dialog-root"), "racine dialog");
assert.ok(ctrl.body && ctrl.header, "body/header exposés");
assert.ok(typeof ctrl.close === "function", "close exposé");
assert.ok(ctrl.modal === ctrl.el, "alias modal");
assert.ok(typeof ctrl.setBody === "function" && typeof ctrl.setContent === "function", "setBody/setContent");
// z-index
const z = parseInt(ctrl.el.style.zIndex, 10);
assert.ok(z >= 1000, "z-index >= 1000 (échelle unifiée), got " + z);

// setTitle / setContent
ctrl.setTitle("Nouveau");
ctrl.setContent("<span>content</span>");
assert.ok(ctrl.header.querySelector(".aih-dialog-title").textContent === "Nouveau", "setTitle OK");

// bringToFront
const ctrl2 = D.open({ title: "Second" });
ctrl.bringToFront();
assert.ok(parseInt(ctrl.el.style.zIndex) >= parseInt(ctrl2.el.style.zIndex), "bringToFront monte le z");

// close
ctrl.close("valeur");
assert.ok(ctrl.el.parentNode === null, "élément retiré après close");

/* ── 2. Garde (guard) ───────────────────────────────────────────────────── */
let resolveVal = "pending";
const gctrl = D.open({
    title: "Garde",
    buttons: [{ text: "OK", value: 42, type: "primary" }],
    _onResolve: (v) => { resolveVal = v; },
});
const okBtn = gctrl.footer ? gctrl.footer.querySelector(".aih-dialog-btn") : gctrl.el.querySelector(".aih-dialog-btn");
okBtn.dispatch("click", { preventDefault() {}, stopPropagation() {} });
// resolve est synchrone via _onResolve
assert.strictEqual(resolveVal, 42, "close(value) résout la valeur");
gctrl.close();

/* ── 3. Busy ────────────────────────────────────────────────────────────── */
const b = globalThis.window.AIH.busy("Traitement", "Merci d'attendre");
assert.ok(typeof b.close === "function" && typeof b.set === "function", "busy API");
b.set("Presque fini");
b.close();

/* ── 4. Helpers (alert/confirm/prompt/choose) ───────────────────────────── */
// alert
const alertP = globalThis.window.AIH.alert("Info", "msg", "info");
const alertOk = fakeDocument.body._allDescendants([]).find((n) => "data-aih-ok" in n._attrs);
assert.ok(alertOk, "bouton OK de l'alert présent");
alertOk.dispatch("click", { preventDefault() {}, stopPropagation() {} });
assert.strictEqual(await alertP, null, "alert résolue après OK");

// confirm
const confirmP = globalThis.window.AIH.confirm("Confirmer", "Continuer ?");
const confOk = fakeDocument.body._allDescendants([]).find((n) => "data-aih-ok" in n._attrs);
confOk.dispatch("click", { preventDefault() {}, stopPropagation() {} });
assert.strictEqual(await confirmP, true, "confirm OK → true");

// prompt
const promptP = globalThis.window.AIH.prompt("Saisir", "Entrez", "ph");
const input = fakeDocument.body._allDescendants([]).find((n) => n.tagName === "INPUT");
assert.ok(input, "input présent dans prompt");
const pOk = fakeDocument.body._allDescendants([]).find((n) => "data-aih-ok" in n._attrs);
pOk.dispatch("click", { preventDefault() {}, stopPropagation() {} });
assert.strictEqual(await promptP, null, "prompt vide → null");

// choose
const chooseP = globalThis.window.AIH.choose("Choisir", "Que faire ?", [
    { text: "A", value: "a" },
    { text: "B", value: "b", type: "danger" },
]);
const footerBtns = fakeDocument.body._allDescendants([]).filter((n) => n.tagName === "BUTTON" && n.classList.contains("aih-dialog-btn"));
const dangerBtn = footerBtns.find((b) => b.classList.contains("aih-dialog-btn-danger"));
assert.ok(dangerBtn, "bouton danger choisi");
dangerBtn.dispatch("click", { preventDefault() {}, stopPropagation() {} });
assert.strictEqual(await chooseP, "b", "choose résout la valeur du bouton");

/* ── 4b. Les dialogs transitoires sont DRAGGABLES (makeDraggable attaché) ── */
// ré-ouvre un choose : son header doit porter un listener mousedown (drag)
const chooseDrag = globalThis.window.AIH.choose("Drag", "Test drag", [{ text: "OK", value: 1 }]);
const dragEl = fakeDocument.body._allDescendants([]).find((n) => n.classList.contains("aih-dialog-root"));
assert.ok(dragEl, "dialog AIH créé");
const dragHeader = dragEl.children.find((c) => c.classList.contains("aih-dialog-header"));
assert.ok(dragHeader, "header AIH trouvé");
assert.ok(
    Array.isArray(dragHeader._listeners.mousedown) && dragHeader._listeners.mousedown.length > 0,
    "makeDraggable attaché sur le header (draggable: true)"
);
// position initiale : left/top en px (centrage) → un drag déplace l'élément
assert.ok(parseInt(dragEl.style.left, 10) > 0 && parseInt(dragEl.style.top, 10) > 0, "dialog positionné en px");

/* ── 4c. Le drag fonctionne (mousedown header → mousemove → déplacement) ── */
const beforeLeft = parseInt(dragEl.style.left, 10);
const beforeTop = parseInt(dragEl.style.top, 10);
dragHeader.dispatch("mousedown", { clientX: 100, clientY: 100, target: dragHeader, preventDefault() {} });
fakeDocument.dispatch("mousemove", { clientX: 230, clientY: 170 });
const midLeft = parseInt(dragEl.style.left, 10);
const midTop = parseInt(dragEl.style.top, 10);
assert.notStrictEqual(midLeft, beforeLeft, "left modifié pendant le drag");
assert.notStrictEqual(midTop, beforeTop, "top modifié pendant le drag");
fakeDocument.dispatch("mouseup", { clientX: 230, clientY: 170 });

// Relâcher sur le fond ne ferme PAS le dialog (wasDragged) ; le dialog existe encore
const overlayEl = fakeDocument.body._allDescendants([]).find((n) => n.classList.contains("aih-dialog-overlay"));
assert.ok(overlayEl, "overlay présent");
overlayEl.dispatch("click", { target: overlayEl });
assert.ok(fakeDocument.body._allDescendants([]).some((n) => n.classList.contains("aih-dialog-root")), "dialog pas fermé après drag (clic fond ignoré)");

// Fermer proprement pour ne pas polluer les tests suivants
const closeBtn = dragEl._allDescendants([]).find((n) => n.classList && n.classList.contains("aih-dialog-close") || (n._attrs && "data-aih-close" in n._attrs));
if (closeBtn) closeBtn.dispatch("click", { preventDefault() {}, stopPropagation() {} });


/* ── 4b. Libellés i18n (FR par défaut, puis EN) ───────────────────────── */
function btnText(btn) {
    if (!btn) return "";
    return btn.children.map((c) => c.textContent || "").join("").trim();
}
assert.ok(globalThis.window.AIH.I18n && typeof globalThis.window.AIH.I18n.t === "function", "AIH.I18n.t existe");
assert.strictEqual(globalThis.window.AIH.I18n.getLocale(), "fr", "locale par défaut = fr");
assert.deepStrictEqual(globalThis.window.AIH.I18n.getAvailableLocales().slice().sort(), ["en", "fr"], "fr + en dispo");

// Confirm en FR → boutons "Confirmer"/"Annuler"
const frConfP = globalThis.window.AIH.confirm("T", "C");
const frOk = fakeDocument.body._allDescendants([]).find((n) => "data-aih-ok" in n._attrs);
const frCancel = fakeDocument.body._allDescendants([]).find((n) => "data-aih-cancel" in n._attrs);
assert.strictEqual(btnText(frOk), "Confirmer", "FR confirm = Confirmer");
assert.strictEqual(btnText(frCancel), "Annuler", "FR cancel = Annuler");
frOk.dispatch("click", { preventDefault() {}, stopPropagation() {} });
assert.strictEqual(await frConfP, true, "confirm FR résolue");

// Bascule EN → libellés traduits
const savedLocale = globalThis.window.AIH.I18n.getLocale();
globalThis.window.AIH.I18n.setLocale("en");
const enConfP = globalThis.window.AIH.confirm("T", "C");
const enOk = fakeDocument.body._allDescendants([]).find((n) => "data-aih-ok" in n._attrs);
const enCancel = fakeDocument.body._allDescendants([]).find((n) => "data-aih-cancel" in n._attrs);
assert.strictEqual(btnText(enOk), "Confirm", "EN confirm = Confirm");
assert.strictEqual(btnText(enCancel), "Cancel", "EN cancel = Cancel");
enOk.dispatch("click", { preventDefault() {}, stopPropagation() {} });
assert.strictEqual(await enConfP, true, "confirm EN résolue");
globalThis.window.AIH.I18n.setLocale(savedLocale);

/* ── 5. Thème ───────────────────────────────────────────────────────────── */
const before = Theme.getTheme();
Theme.setTheme({ "--aih-accent": "#123456" });
assert.strictEqual(Theme.getTheme()["--aih-accent"], "#123456", "setTheme applique");
Theme.resetTheme();
assert.strictEqual(fakeDocument.documentElement.style.getPropertyValue("--aih-accent"), "", "resetTheme vide la var");

/* ── 6. Wrappers aihOpenModalV2 ─────────────────────────────────────────── */
const v2 = globalThis.window.aihOpenModalV2({ title: "V2", content: "x", width: "300px" });
assert.ok(v2.modal === v2.el, "v2 wrapper modal");
assert.ok(typeof v2.setBody === "function", "v2 setBody");
v2.close();

/* ── 6b. zIndex 210000 (login) + garde keep-open ───────────────────────── */
const loginCtrl = D.open({ title: "Login", zIndex: 210000 });
assert.ok(parseInt(loginCtrl.el.style.zIndex, 10) >= 210000, "zIndex paramétrable 210000");
loginCtrl.close();

let keepResolved = false;
const gkeep = D.open({
    title: "G",
    buttons: [{ text: "Save", value: 1 }],
    guard: async () => { throw { keepOpen: true }; },
    _onResolve: () => { keepResolved = true; },
});
const gkeepBtn = gkeep.el.querySelector(".aih-dialog-btn");
gkeepBtn.dispatch("click", { preventDefault() {}, stopPropagation() {} });
await new Promise((r) => setTimeout(r, 0));
assert.ok(!keepResolved, "garde keepOpen → pas de résolution");
assert.ok(gkeep.el.parentNode !== null, "garde keepOpen → dialogue reste ouvert");
gkeep.close();

/* ── 7. AIH.ask : API unifiée de dialog (options style) ──────────────────── */
const askP = globalThis.window.AIH.ask({ title: "T", message: "M", buttons: [{ text: "OK", value: true }] });
// single OK → alert → après click OK
const cdOk = fakeDocument.body._allDescendants([]).find((n) => "data-aih-ok" in n._attrs);
assert.ok(cdOk, "AIH.ask single OK → alert");
cdOk.dispatch("click", { preventDefault() {}, stopPropagation() {} });
assert.strictEqual(await askP, true, "AIH.ask résout true");

// multi-boutons → choose (résout la valeur du bouton cliqué)
const askMulti = globalThis.window.AIH.ask({
    title: "T2", message: "M2",
    buttons: [{ text: "Annuler", value: false, type: "cancel" }, { text: "Suppr", value: true, type: "danger" }],
    maxWidth: 420,
});
const dangerBtn2 = fakeDocument.body._allDescendants([]).find((n) => n.tagName === "BUTTON" && n.classList.contains("aih-dialog-btn-danger"));
assert.ok(dangerBtn2, "AIH.ask multi → bouton danger présent");
dangerBtn2.dispatch("click", { preventDefault() {}, stopPropagation() {} });
assert.strictEqual(await askMulti, true, "AIH.ask multi résout la valeur du bouton");

/* ── 8. Auto-injection CSS (contexte standalone, CSS absente) ───────────── */
// aih_dialog.js doit être auto-suffisant : quand aih_dialog.css n'est pas déjà
// chargée (page standalone / profiler), le module injecte sa propre feuille.
function findInHead(id) {
    return fakeDocument.head.children.find((n) => n.id === id) || null;
}
const injLink = findInHead("aih-dialog-css");
assert.ok(injLink, "feuille de style injectée dans <head> (id aih-dialog-css)");
assert.strictEqual(injLink.rel, "stylesheet", "<link rel=stylesheet>");
assert.ok(/aih_dialog\.css$/.test(injLink.href || ""), "href pointe sur css/aih_dialog.css : " + injLink.href);
// NB: dans ce banc de test l'URL est file:// (dossier réel nommé "js") ; en
// navigateur, holaf_ext_base.js sert sous /extensions/<pack>/ et retire le
// segment "js/" (WEB_DIRECTORY monté directement) — voir holaf_ext_base.js.

// Fallback inline : si on retire le <link> puis qu'un échec est simulé via
// onerror, le <style> inline garantissant le rendu est injecté.
const fakeLink = injLink;
if (typeof fakeLink.onerror === "function") fakeLink.onerror();
const injInline = findInHead("aih-dialog-css-inline");
assert.ok(injInline, "fallback inline <style> injecté sur onerror");
assert.ok(injInline._attrs && injInline._attrs["data-aih-dialog"] === "1", "style fallback marqué data-aih-dialog");
const cssText = injInline.textContent || "";
assert.ok(/position:\s*fixed/.test(cssText), "fallback : position fixed (centrage)");
assert.ok(/inset:\s*0/.test(cssText), "fallback : overlay inset:0");
assert.ok(/--aih-accent/.test(cssText), "fallback : variables --aih-* présentes");
assert.ok(/\.aih-dialog-overlay/.test(cssText), "fallback : classe .aih-dialog-overlay");
assert.ok(/\.aih-dialog-header/.test(cssText) && /\.aih-dialog-body/.test(cssText) && /\.aih-dialog-footer/.test(cssText), "fallback : header/body/footer");

/* ── 9. Anti-doublon : fenêtre à id stable déjà ouverte → bringToFront ── */
const dupId = "aih-test-dup-window";
const dup1 = D.open({ id: dupId, title: "Dup", width: "300px" });
assert.ok(dup1.el.id === dupId, "première ouverture : id posé");
const dupZ1 = parseInt(dup1.el.style.zIndex, 10);

// Deuxième ouverture avec le même id → on réutilise la même fenêtre.
const dup2 = D.open({ id: dupId, title: "Dup", width: "300px" });
assert.strictEqual(dup2, dup1, "même id → même contrôleur réutilisé (pas de doublon)");
const dupCount = fakeDocument.body._allDescendants([]).filter((n) => n.id === dupId).length;
assert.strictEqual(dupCount, 1, "une seule fenêtre avec cet id dans le DOM");
assert.ok(parseInt(dup1.el.style.zIndex, 10) >= dupZ1, "fenêtre réutilisée ramenée au premier plan");

// Sans id → pas de garde (deux fenêtres distinctes autorisées).
const noId1 = D.open({ title: "Sans id A" });
const noId2 = D.open({ title: "Sans id B" });
assert.notStrictEqual(noId1, noId2, "sans id → deux fenêtres distinctes (pas de garde)");
noId1.close(); noId2.close(); dup1.close();

console.log("✅ Simulation AIH.Dialog : TOUS LES TESTS PASSENT");
