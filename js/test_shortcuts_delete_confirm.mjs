// ─────────────────────────────────────────────────────────────────────────
// SHORTCUTS — CONFIRMATION DESTRUCTIVE avant la suppression d'un raccourci,
// et ICÔNES du lot PHASE 2b (fermer / cocher / supprimer une ligne).
//
// Existant (avant correctif) : clic sur la croix → suppression IMMÉDIATE et
//   IRRÉVERSIBLE de `HolafShortcuts.shortcuts` + écriture de persistance
//   (`app.graph.extra.holaf_shortcuts`), sans aucune demande de confirmation.
//
// Depuis la PHASE 2b, la croix est une ICÔNE de la brique (via la façade
//   js/aih_icons.js) et non plus le caractère « ✕ ». Ce test ne s'appuie donc
//   PLUS sur la valeur textuelle du bouton : il l'identifie par sa STRUCTURE
//   (nom accessible `title` = clé i18n `sc.delete`) et vérifie que l'icône est
//   bien celle de la brique (`x`), décorative, sans couleur codée en dur.
//
// Couverture (vraie AIH.Dialog, aucun stub de dialogue) :
//   (0) ICÔNES : bouton de fermeture de l'en-tête (icône `x` 14 px + `title`),
//       croix de suppression de ligne (icône `x` 12 px + `title`), et retour
//       visuel « enregistré » (icône `check` 12 px puis restauration du glyphe
//       d'origine) — sans jamais dépendre d'un caractère ;
//   (a) clic sur la croix → la modale de confirmation du système UNIFIÉ s'ouvre
//       (AIH.Dialog) ; le bouton destructif porte la classe
//       `aih-dialog-btn-danger` et le libellé i18n « Supprimer » ; le message
//       nomme le raccourci et annonce le caractère définitif ; RIEN n'est
//       supprimé tant que la modale est ouverte ;
//   (b) bouton « Annuler » → AUCUNE suppression : état en mémoire intact,
//       AUCUNE écriture de persistance (graph.extra inchangé) ;
//   (c) Échap → annule (idem Annuler) ;
//   (d) clic sur le fond (overlay) → annule (fail-safe) ;
//   (e) « Supprimer » → suppression EXACTEMENT comme avant (retrait + sync) ;
//   (f) anti-XSS : un nom contenant du HTML est échappé (AIH.confirm insère le
//       message en innerHTML) — vérifié sur le TEXTE et sur le HTML produit ;
//   (g) parité i18n FR/EN stricte des nouvelles clés ;
//   (h) CONTRÔLES NÉGATIFS PAR MUTATION : `escapeHtml` retiré → le nom est
//       réellement injecté (assertion (f) rouge) ; confirmation retirée → la
//       suppression devient immédiate (assertion (a) rouge). Les mutants sont
//       écrits dans js/, importés, puis supprimés.
//
// Usage : node js/test_shortcuts_delete_confirm.mjs
//   jsdom résolu par js/test_helpers/jsdom_loader.mjs ; absent = SKIP (exit 2).
// Code de sortie : 0 = PASS, 2 = SKIP, 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";
import { HolafIcons } from "./vendor/holaf/holaf-icons.js";

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const HERE = dirname(fileURLToPath(import.meta.url));

const JSDOM = await loadJsdomOrSkip("test_shortcuts_delete_confirm");
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

// Interdit formellement window.confirm : si le code y recourt, le test échoue.
domWindow.confirm = () => { throw new Error("window.confirm() INTERDIT — utiliser AIH.confirm"); };

localStorage.setItem("aih_locale", "fr");

// ── Faux app / api ComfyUI (avant import : la couche compat s'y accroche). ──
domWindow.app = {
    graph: { extra: {}, _nodes: [], getNodeById() { return null; } },
    canvas: { graph: null, setGraph() {}, ds: { offset: [0, 0], scale: 1 }, setDirty() {} },
    registerExtension(ext) { this.extensions.push(ext); },
    extensions: [],
};
domWindow.app.canvas.graph = domWindow.app.graph;
domWindow.api = { api_base: "", addEventListener() {} };

await import("./aih_i18n.js");
const I18n = domWindow.AIH.I18n;
const captured = {};
const origAddDict = I18n.addDict.bind(I18n);
I18n.addDict = (lang, entries) => {
    captured[lang] = Object.assign(captured[lang] || {}, entries);
    return origAddDict(lang, entries);
};
I18n.setLocale("fr");
await import("./aih_dialog.js");
await import("./aih_strings.js");
await import("./holaf_shortcuts.js");

assert.strictEqual(typeof domWindow.AIH.Dialog.open, "function", "VRAI AIH.Dialog disponible (aucun stub)");
assert.strictEqual(typeof domWindow.AIH.confirm, "function", "AIH.confirm (dialogue unifié) disponible");

const ext = domWindow.app.extensions.find((e) => e && e.name === "Holaf.Shortcuts");
assert.ok(ext && typeof ext.setup === "function", "extension Holaf.Shortcuts enregistrée");
await ext.setup();
const HS = domWindow.app.holafShortcuts;
assert.ok(HS && typeof HS.deleteShortcut === "function", "HolafShortcuts exposé (app.holafShortcuts)");

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const dialogOf = () => [...document.querySelectorAll(".aih-dialog-root")].find((r) => r.querySelector("[data-aih-ok]"));

/* ── Utilitaires d'inspection STRUCTURELLE (plus aucun caractère asserté) ── */

/** Corps (tracés) d'une icône telle que la BRIQUE la rend : comparer les tracés
 *  garantit que le bouton porte bien l'icône annoncée, pas un autre dessin. */
function brickBody(name) {
    const rendered = HolafIcons.render(name, { size: 24 });
    return rendered.slice(rendered.indexOf(">") + 1, rendered.lastIndexOf("</svg>"));
}

/** Assertions communes d'une icône rendue par la façade dans un bouton. */
function assertFacadeIcon(host, name, size, ctx) {
    const svg = host.querySelector("svg");
    assert.ok(svg, `${ctx} : aucun <svg> (la façade d'icônes n'est pas utilisée)`);
    assert.strictEqual(svg.tagName.toLowerCase(), "svg", `${ctx} : <svg> attendu`);
    assert.strictEqual(svg.getAttribute("viewBox"), "0 0 24 24", `${ctx} : viewBox 24×24`);
    assert.strictEqual(svg.getAttribute("stroke"), "currentColor",
        `${ctx} : stroke=currentColor (aucune couleur codée en dur)`);
    assert.strictEqual(svg.getAttribute("fill"), "none", `${ctx} : fill=none`);
    assert.strictEqual(svg.getAttribute("width"), String(size), `${ctx} : largeur ${size} px`);
    assert.strictEqual(svg.getAttribute("height"), String(size), `${ctx} : hauteur ${size} px`);
    assert.strictEqual(svg.innerHTML, brickBody(name),
        `${ctx} : tracés différents de l'icône « ${name} » de la brique`);
    assert.ok(!/#[0-9a-fA-F]{3,8}\b|\brgb\(|\bhsl\(/.test(svg.outerHTML),
        `${ctx} : couleur codée en dur dans le SVG (attendu : currentColor)`);
    // Icône DÉCORATIVE : le sens est porté par le `title` du bouton, le SVG ne
    // doit donc pas s'annoncer lui-même (pas de role="img"/<title> interne).
    assert.strictEqual(svg.getAttribute("role"), null, `${ctx} : le SVG ne doit pas porter role="img"`);
    assert.ok(!svg.querySelector("title"), `${ctx} : le SVG ne doit pas porter de <title> interne`);
    return svg;
}

const GRAPH_KEY = HS.GRAPH_EXTRA_KEY;
const setShortcut = (id, name, hs = HS) => {
    hs.shortcuts = [{ id, name, x: 0, y: 0, zoom: 1, path: [] }];
    hs.renderList();
};
/** Bouton de suppression d'une ligne, identifié par sa STRUCTURE (nom
 *  accessible = clé i18n `sc.delete`) et non par le caractère « ✕ ». */
const delBtnOf = (id, hs = HS) => {
    const row = hs.listElement.querySelector(`[data-id="${id}"]`);
    assert.ok(row, `ligne du raccourci ${id} présente`);
    const btn = [...row.querySelectorAll("button")]
        .find((b) => (b.title || "") === I18n.t("sc.delete"));
    assert.ok(btn, `bouton de suppression (title = « ${I18n.t("sc.delete")} ») présent dans la ligne ${id}`);
    return btn;
};

// Espion de persistance : compte les appels à syncToGraph.
let syncCount = 0;
const origSync = HS.syncToGraph.bind(HS);
HS.syncToGraph = function () { syncCount++; return origSync(); };

/* ══════════════════ (0) Icônes du lot 2b : structure, pas de caractère ══ */
console.log("(0) Icônes PHASE 2b : croix de fermeture, croix de suppression, coche « enregistré »");

// (0.a) Bouton de fermeture de l'en-tête.
{
    const closeBtn = HS.rootElement.querySelector(".holaf-utility-close-button");
    assert.ok(closeBtn, "bouton de fermeture de l'en-tête présent");
    assertFacadeIcon(closeBtn, "x", 14, "fermeture de la fenêtre des raccourcis");
    assert.strictEqual(closeBtn.title, I18n.t("dialog.close"), "fermeture : nom accessible conservé (title = dialog.close)");
    assert.strictEqual(closeBtn.textContent.trim(), "", "fermeture : plus aucun glyphe texte dans le bouton");
    assert.strictEqual(typeof closeBtn.onclick, "function", "fermeture : onclick toujours branché");
    assert.strictEqual(closeBtn.style.display, "inline-flex", "fermeture : centrage inline-flex (sans CSS global ajouté)");
    assert.strictEqual(typeof closeBtn.onmousedown, "function", "fermeture : onmousedown stopPropagation conservé (drag du bandeau)");
    closeBtn.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(HS.rootElement.style.display, "none", "fermeture : le clic ferme toujours la fenêtre");
    HS.show();
    assert.strictEqual(HS.rootElement.style.display, "flex", "réouverture : show() toujours fonctionnel");
    ok("(0.a) fermeture : icône « x » 14 px (tracés de la brique), title conservé, clic → fermeture effective");
}

// (0.b) Croix de suppression d'une ligne + retour visuel « enregistré ».
{
    setShortcut("a", "Alpha");
    const row = HS.listElement.querySelector('[data-id="a"]');
    assert.ok(!row.textContent.includes("✕"), "la ligne ne contient plus AUCUN glyphe « ✕ »");
    const delBtn = delBtnOf("a");
    assertFacadeIcon(delBtn, "x", 12, "suppression d'un raccourci");
    assert.strictEqual(delBtn.title, I18n.t("sc.delete"), "suppression : nom accessible conservé (title = sc.delete)");
    assert.strictEqual(delBtn.className, "holaf-shortcut-btn", "suppression : classes du bouton inchangées");
    assert.strictEqual(typeof delBtn.onclick, "function", "suppression : onclick direct toujours branché");
    assert.strictEqual(typeof delBtn.onmouseenter, "function", "suppression : survol rouge (onmouseenter) conservé");
    assert.strictEqual(delBtn.style.display, "inline-flex", "suppression : centrage inline-flex de l'icône");
    ok("(0.b) suppression : icône « x » 12 px (tracés de la brique), title + onclick + survol conservés");

    // Retour visuel après enregistrement de la position : coche de la brique.
    syncCount = 0;
    const updBtn = row.querySelector(".update-btn");
    assert.ok(updBtn, "bouton « mise à jour de la position » présent");
    const glypheOrigine = updBtn.innerHTML;
    updBtn.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(syncCount, 1, "mise à jour : la position est persistée (syncToGraph)");
    assertFacadeIcon(updBtn, "check", 12, "retour visuel « enregistré »");
    assert.ok(!updBtn.textContent.includes("✓"), "le glyphe « ✓ » a disparu du bouton");
    assert.strictEqual(updBtn.title, I18n.t("sc.update"), "mise à jour : nom accessible conservé");
    await tick(1150); // la coche est restaurée après 1 s
    assert.strictEqual(updBtn.innerHTML, glypheOrigine,
        "après 1 s le glyphe d'origine du bouton est restauré (comportement inchangé)");
    assert.ok(!updBtn.querySelector("svg"), "la coche a bien été retirée après la temporisation");
    ok("(0.c) « enregistré » : coche « check » 12 px pendant 1 s puis restauration du glyphe d'origine");
}

/* ══════════════════ (a) Clic sur la croix → modale de confirmation ══════ */
console.log("(a) Clic sur la croix → modale de confirmation (AIH.Dialog) ouverte, bouton destructif rouge");

setShortcut("a", "Alpha");
domWindow.app.graph.extra = {};   // aucune persistance initiale
syncCount = 0;
const delBtn = delBtnOf("a");
assert.ok(delBtn, "bouton de suppression présent");
delBtn.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick();
const confirmRoot = dialogOf();
assert.ok(confirmRoot, "la modale de confirmation est OUVERTE (racine AIH.Dialog avec [data-aih-ok])");
const okBtn = confirmRoot.querySelector("[data-aih-ok]");
const cancelBtn = confirmRoot.querySelector("[data-aih-cancel]");
assert.ok(okBtn && cancelBtn, "deux actions : Annuler + action de confirmation");
assert.ok(okBtn.classList.contains("aih-dialog-btn-danger"), "action de confirmation en ROUGE (aih-dialog-btn-danger)");
assert.strictEqual(okBtn.textContent.trim(), I18n.t("sc.deleteConfirmAction"), `libellé destructif i18n : « ${okBtn.textContent.trim()} »`);
assert.strictEqual(cancelBtn.textContent.trim(), I18n.t("dialog.cancel"), "libellé Annuler i18n");
const confirmMsg = (confirmRoot.querySelector(".aih-dialog-message") || {}).textContent || "";
assert.strictEqual(confirmMsg.trim(), I18n.t("sc.deleteConfirm", { name: "Alpha" }), "message = clé i18n sc.deleteConfirm interpolée avec le nom");
assert.ok(/définitiv|irréversible/i.test(confirmMsg), "le message annonce le caractère DÉFINITIF/irréversible");
assert.ok(confirmMsg.includes("Alpha"), "le message NOMME le raccourci concerné");
assert.strictEqual(confirmRoot.querySelector(".aih-dialog-title").textContent.trim(), I18n.t("sc.deleteTitle"), "titre i18n de la confirmation");
// Tant que la modale est ouverte : RIEN n'a été supprimé ni persisté.
assert.strictEqual(HS.shortcuts.length, 1, "tant que la modale est ouverte, le raccourci est intact (mémoire)");
assert.strictEqual(syncCount, 0, "tant que la modale est ouverte, AUCUNE écriture de persistance");
assert.ok(!(GRAPH_KEY in domWindow.app.graph.extra), "tant que la modale est ouverte, graph.extra ne contient pas de raccourcis");
ok("(a) croix → modale unifiée avec bouton rouge « Supprimer », aucun effet immédiat");

/* ══════════════════ (b) Annuler → AUCUNE suppression ════════════════════ */
console.log("(b) Annuler → raccourci intact, aucune écriture de persistance");

cancelBtn.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick();
assert.ok(!document.body.contains(confirmRoot), "la modale de confirmation est fermée après Annuler");
assert.strictEqual(HS.shortcuts.length, 1, "Annuler : le raccourci est TOUJOURS présent (mémoire)");
assert.strictEqual(HS.shortcuts[0].id, "a", "Annuler : c'est bien le même raccourci conservé");
assert.strictEqual(syncCount, 0, "Annuler : AUCUNE écriture de persistance (syncToGraph jamais appelé)");
assert.ok(!(GRAPH_KEY in domWindow.app.graph.extra), "Annuler : graph.extra inchangé (aucune persistance écrite)");
ok("(b) Annuler : aucune suppression, ni état ni persistance modifiés");

/* ══════════════════ (c) Échap → annule ═════════════════════════════════ */
console.log("(c) Échap → annule (aucune suppression)");

delBtnOf("a").dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick();
const confirmEsc = dialogOf();
assert.ok(confirmEsc, "modale réouverte pour le test Échap");
document.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await tick();
assert.ok(!document.body.contains(confirmEsc), "Échap ferme la modale de confirmation");
assert.strictEqual(HS.shortcuts.length, 1, "Échap : le raccourci est intact");
assert.strictEqual(syncCount, 0, "Échap : AUCUNE écriture de persistance");
ok("(c) Échap = Annuler : fermeture sans suppression");

/* ══════════════════ (d) Clic sur le fond → annule ══════════════════════ */
console.log("(d) Clic sur le fond (overlay) → annule");

delBtnOf("a").dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick();
const confirmOverlay = dialogOf();
assert.ok(confirmOverlay, "modale réouverte pour le test clic sur le fond");
const overlay = document.querySelector(".aih-dialog-overlay");
assert.ok(overlay, "overlay de modale présent");
overlay.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick();
assert.ok(!document.body.contains(confirmOverlay), "clic sur le fond ferme la modale");
assert.strictEqual(HS.shortcuts.length, 1, "clic sur le fond : le raccourci est intact");
assert.strictEqual(syncCount, 0, "clic sur le fond : AUCUNE écriture de persistance");
ok("(d) clic sur le fond = Annuler : fermeture sans suppression");

/* ══════════════════ (e) Supprimer → suppression comme avant ════════════ */
console.log("(e) Supprimer → suppression effective, identique à l'existant");

delBtnOf("a").dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick();
const confirmDel = dialogOf();
assert.ok(confirmDel, "modale réouverte pour le test Supprimer");
confirmDel.querySelector("[data-aih-ok]").dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick();
assert.ok(!document.body.contains(confirmDel), "la modale est fermée après Supprimer");
assert.strictEqual(HS.shortcuts.length, 0, "Supprimer : le raccourci est SUPPRIMÉ (comportement d'origine)");
assert.strictEqual(syncCount, 1, "Supprimer : la persistance est écrite (syncToGraph appelé une fois)");
assert.ok(GRAPH_KEY in domWindow.app.graph.extra, "Supprimer : graph.extra contient la clé de raccourcis");
assert.deepStrictEqual(domWindow.app.graph.extra[GRAPH_KEY], [], "Supprimer : la persistance reflète la liste vide");
assert.ok(!HS.listElement.querySelector('[data-id="a"]'), "Supprimer : la liste est re-rendue (plus de ligne)");
ok("(e) Supprimer : suppression effective + persistance, comportement d'origine conservé");

/* ══════════════════ (f) Anti-XSS : nom échappé ════════════════════════ */
console.log("(f) Anti-XSS : un nom contenant du HTML est échappé dans la modale");

const EVIL = '<img src=x onerror="window.__xss=1">';
domWindow.__xss = undefined;
setShortcut("x", EVIL);
syncCount = 0;
delBtnOf("x").dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick();
const xssRoot = dialogOf();
assert.ok(xssRoot, "modale ouverte pour le nom piégé");
const xssMsgEl = xssRoot.querySelector(".aih-dialog-message");
const xssMsg = (xssMsgEl || {}).textContent || "";
assert.ok(!xssRoot.querySelector(".aih-dialog-message img"), "aucune balise <img> injectée (nom échappé)");
assert.ok(xssMsg.includes("<img"), "le nom est rendu LITTÉRALEMENT (échappé) dans le message");
// Preuve STRUCTURELLE de l'échappement : le HTML du message porte &lt;img, pas <img.
assert.ok(/&lt;img/.test(xssMsgEl.innerHTML), "le nom est bien passé par escapeHtml avant innerHTML (&lt;img)");
assert.strictEqual(domWindow.__xss, undefined, "aucun script exécuté");
xssRoot.querySelector("[data-aih-cancel]").dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
await tick();
assert.strictEqual(HS.shortcuts.length, 1, "Annuler sur le nom piégé : raccourci intact");
ok("(f) anti-XSS : nom échappé (escapeHtml) avant interpolation dans AIH.confirm");

/* ══════════════════ (g) Parité i18n FR/EN ═════════════════════════════ */
console.log("(g) Parité i18n FR/EN des nouvelles clés");

const NEW_KEYS = ["sc.deleteTitle", "sc.deleteConfirm", "sc.deleteConfirmAction"];
for (const k of NEW_KEYS) {
    assert.ok(k in (captured.fr || {}), `clé FR présente : ${k}`);
    assert.ok(k in (captured.en || {}), `clé EN présente : ${k}`);
    assert.ok(String(captured.fr[k]).trim() !== "", `clé FR non vide : ${k}`);
    assert.ok(String(captured.en[k]).trim() !== "", `clé EN non vide : ${k}`);
}
assert.notStrictEqual(captured.fr["sc.deleteConfirm"], captured.en["sc.deleteConfirm"], "le message FR et EN diffèrent (vraie traduction)");
assert.ok(String(captured.fr["sc.deleteConfirm"]).includes("{name}"), "la clé FR conserve le placeholder {name}");
assert.ok(String(captured.en["sc.deleteConfirm"]).includes("{name}"), "la clé EN conserve le placeholder {name}");
// Clé de dialogue partagée.
const savedLocale = I18n.getLocale();
I18n.setLocale("fr");
const frCancel = I18n.t("dialog.cancel");
I18n.setLocale("en");
const enCancel = I18n.t("dialog.cancel");
I18n.setLocale(savedLocale);
assert.ok(frCancel.trim() !== "" && enCancel.trim() !== "", "clé dialogue partagée non vide FR/EN : dialog.cancel");
ok(`(g) parité FR/EN OK : ${NEW_KEYS.length} nouvelles clés présentes et non vides`);

/* ══════════════════ (h) Contrôles négatifs par MUTATION ════════════════ */
console.log("(h) contrôles négatifs par mutation (escapeHtml retiré, confirmation retirée)");
{
    const SRC = readFileSync(join(HERE, "holaf_shortcuts.js"), "utf8");

    // Nettoyage d'un éventuel résidu d'une exécution interrompue.
    for (const f of readdirSync(HERE)) {
        if (/^\.__mut3_\d+_shortcuts\.mjs$/.test(f)) rmSync(join(HERE, f), { force: true });
    }

    let seq = 0;
    /** Écrit un mutant de holaf_shortcuts.js, l'importe, rejoue son setup() et
     *  renvoie l'instance HolafShortcuts du mutant. */
    async function loadMutant(label, mutate) {
        const mutated = mutate(SRC);
        assert.notStrictEqual(mutated, SRC, `mutation « ${label} » sans effet (ancre introuvable)`);
        const file = join(HERE, `.__mut3_${++seq}_shortcuts.mjs`);
        writeFileSync(file, mutated, "utf8");
        await import("file://" + file + "?m=" + seq);
        const mutantExt = domWindow.app.extensions.filter((e) => e && e.name === "Holaf.Shortcuts").pop();
        assert.ok(mutantExt && mutantExt !== ext, `mutation « ${label} » : extension du mutant non enregistrée`);
        await mutantExt.setup();
        return { hs: domWindow.app.holafShortcuts, file };
    }

    // M1 — escapeHtml retiré : l'assertion anti-XSS (f) doit devenir ROUGE.
    {
        const { hs, file } = await loadMutant("escapeHtml retiré",
            (s) => s.replace('escapeHtml(name || "")', '(name || "")'));
        try {
            setShortcut("m1", EVIL, hs);
            delBtnOf("m1", hs).dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
            await tick();
            const root = dialogOf();
            assert.ok(root, "mutant M1 : modale ouverte");
            const msgEl = root.querySelector(".aih-dialog-message");
            assert.ok(msgEl.querySelector("img"),
                "mutant M1 : le nom N'EST PLUS échappé → un vrai <img> est injecté (l'assertion (f) serait ROUGE)");
            root.querySelector("[data-aih-cancel]").dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
            await tick();
            assert.ok(!document.body.contains(root), "mutant M1 : modale refermée (nettoyage)");
        } finally {
            rmSync(file, { force: true });
        }
        ok("M1 escapeHtml retiré → l'anti-XSS (f) devient ROUGE (balise <img> réellement injectée)");
    }

    // M2 — confirmation retirée : la suppression devient IMMÉDIATE → (a) rouge.
    {
        const { hs, file } = await loadMutant("confirmation retirée",
            (s) => s.replace("const ok = await _confirmDeleteShortcut(item.name);", "const ok = true;"));
        try {
            setShortcut("m2", "Beta", hs);
            const before = document.querySelectorAll(".aih-dialog-root").length;
            delBtnOf("m2", hs).dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
            await tick();
            assert.strictEqual(document.querySelectorAll(".aih-dialog-root").length, before,
                "mutant M2 : AUCUNE modale de confirmation ouverte");
            assert.strictEqual(hs.shortcuts.length, 0,
                "mutant M2 : suppression IMMÉDIATE et irréversible → l'assertion (a) serait ROUGE");
        } finally {
            rmSync(file, { force: true });
        }
        ok("M2 confirmation retirée → l'assertion (a) devient ROUGE (suppression sans modale)");
    }

    assert.strictEqual(readFileSync(join(HERE, "holaf_shortcuts.js"), "utf8"), SRC,
        "le source des raccourcis n'a pas été modifié par les mutants");
    assert.deepStrictEqual(readdirSync(HERE).filter((f) => f.startsWith(".__mut3_")), [],
        "aucun mutant ne doit rester sur le disque");
    ok("source intact, aucun mutant résiduel");
}

console.log(`\n✅ Confirmation de suppression d'un raccourci + icônes 2b : TOUS LES TESTS PASSENT (${n} assertions)`);
process.exit(0);
