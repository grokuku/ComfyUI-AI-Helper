// ─────────────────────────────────────────────────────────────────────────
// PHASE 2d de la migration d'icônes : LIBELLÉS i18n CONTENANT UN EMOJI.
//
// Principe (inverse des lots 2a/2b/2c, qui nettoyaient des glyphes écrits en
// dur dans le code) : ici le glyphe vivait dans le DICTIONNAIRE. On le retire
// du TEXTE (FR ET EN, parité stricte) et on sépare l'icône au POINT D'APPEL :
// un slot décoratif dans son PROPRE élément, placé AVANT un nœud de texte pur.
// Conséquence vérifiée ici : `textContent` du contrôle reste EXACTEMENT le
// libellé — aucun emoji, aucun espace parasite, aucune icône en double.
//
// Fichiers touchés par le lot :
//   js/aih_strings.js                 dictionnaires FR/EN (texte seul)
//   js/holaf_main.js                  entrées de menu (phase 2c — fichier déjà
//                                     attribué : on n'élargit AUCUNE liste)
//   js/aih_workflow_share.js          onglets Partager/Parcourir, bouton
//                                     Publier/Mettre à jour, dépendances
//   js/aih_repair_workflow.js         boutons Copier / Enregistrer sous
//   js/aih_enhance_widget.js          NOUVEAU consommateur → PHASES["2d"]
//
// Ce qui est verrouillé ici :
//   1. DICTIONNAIRES : les clés migrées portent le texte EXACT, sans emoji ni
//      espace résiduel, dans les DEUX langues ; parité stricte (mêmes clés,
//      aucune valeur vide) ; le runtime sert bien ces valeurs.
//   2. NON-DÉBORDEMENT : les emoji de STATUT (✅ ⏳ ❌ ♻️ ⏭ …) et de MESSAGE
//      (🎉 …) restent dans les dictionnaires, et les clés volontairement NON
//      migrées (titres de fenêtre, placeholder, `<option>`) gardent leur
//      glyphe — preuve qu'on n'a pas « nettoyé » au-delà de la catégorie (a).
//   3. RENDU : pour CHAQUE libellé migré, icône + texte exact, en FR ET en EN,
//      exactement une icône, `textContent` propre, slot décoratif.
//   4. PÉRIMÈTRE : PHASES["2d"] consommé réellement, listes disjointes, les
//      3 fichiers interdits inchangés, aucun consommateur hors liste.
//   5. CONTRÔLES NÉGATIFS PAR MUTATION (le vérificateur mord) : emoji
//      réintroduit, clé retirée d'une seule langue, icône manquante au point
//      d'appel, clé de STATUT migrée par erreur, espace parasite, icône en
//      double.
//
// Usage : node js/test_aih_icons_phase2d.mjs
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom absent), 1 = FAIL.
import assert from "node:assert";
import { readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";
import {
    PHASES,
    PHASE_2D_CONSUMERS,
    ALLOWED_CONSUMERS,
    FORBIDDEN_CONSUMERS,
    CURRENT_PHASE,
    checkIconPerimetre,
    checkPhaseDisjointness,
} from "./test_helpers/icon_perimeter.mjs";
import { HolafIcons } from "./vendor/holaf/holaf-icons.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HERE, "..");

const JSDOM = await loadJsdomOrSkip("test_aih_icons_phase2d");

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };
const read = (rel) => readFileSync(join(PACKAGE_DIR, rel), "utf8");

/* ══ Table de référence du lot ═══════════════════════════════════════════ */

/**
 * Libellés d'interface MIGRÉS (catégorie (a)) : clé i18n, textes EXACTS des
 * deux langues, icône de la brique, taille, fichier consommateur.
 * `call` = expression attendue AU POINT D'APPEL (icône immédiatement suivie du
 * libellé) — c'est ce motif qui garantit « icône séparée, texte seul ».
 */
const MIGRATED = [
    // ── Menu principal (js/holaf_main.js) ──────────────────────────────────
    { key: "menu.openWebpage", fr: "Open Webpage", en: "Open Webpage", icon: "globe", size: 13, file: "js/holaf_main.js", was: "🌐" },
    { key: "menu.workflows", fr: "Workflows", en: "Workflows", icon: "upload", size: 13, file: "js/holaf_main.js", was: "📤" },
    { key: "menu.models", fr: "Models", en: "Models", icon: "package", size: 13, file: "js/holaf_main.js", was: "📦" },
    { key: "menu.members", fr: "Membres", en: "Members", icon: "users", size: 13, file: "js/holaf_main.js", was: "👥" },
    { key: "menu.repairWorkflow", fr: "Réparer un workflow", en: "Repair a workflow", icon: "wrench", size: 13, file: "js/holaf_main.js", was: "🛠" },
    // Entrée NOUVELLE (intégration ComfyCH) : icône de la brique dès l'origine,
    // donc aucun emoji remplacé — `was` documente l'absence d'antériorité.
    { key: "menu.comfych", fr: "ComfyCH", en: "ComfyCH", icon: "cloud", size: 13, file: "js/holaf_main.js", was: "— (nouvelle entrée)" },
    { key: "menu.chat", fr: "Chat", en: "Chat", icon: "message-square", size: 13, file: "js/holaf_main.js", was: "💬" },
    { key: "menu.aihUpdate", fr: "AIH Update", en: "AIH Update", icon: "refresh", size: 13, file: "js/holaf_main.js", was: "🔄" },
    // ── Workflows : onglets et actions (js/aih_workflow_share.js) ──────────
    { key: "wf.tabShare", fr: "Partager", en: "Share", icon: "upload", size: 13, file: "js/aih_workflow_share.js", was: "📤" },
    { key: "wf.tabBrowse", fr: "Parcourir", en: "Browse", icon: "globe", size: 13, file: "js/aih_workflow_share.js", was: "🌐" },
    { key: "wf.publish", fr: "Publier", en: "Publish", icon: "upload", size: 13, file: "js/aih_workflow_share.js", was: "📤" },
    {
        key: "wf.update", fr: "Mettre à jour (v{version})", en: "Update (v{version})",
        icon: "refresh", size: 13, file: "js/aih_workflow_share.js", was: "🔄",
        call: /iconSlot\("refresh", 13\) \+ esc\(t\("wf\.update"/,
    },
    {
        key: "wf.customNodes", fr: "Custom nodes", en: "Custom nodes",
        icon: "package", size: 12, file: "js/aih_workflow_share.js", was: "📦",
        call: /iconSlot\("package", 12\) \+ t\('wf\.customNodes'\)/,
    },
    {
        key: "wf.customNodesHeader", fr: "Custom nodes", en: "Custom nodes",
        icon: "package", size: 11, file: "js/aih_workflow_share.js", was: "📦",
        call: /iconSlot\("package", 11\) \+ t\('wf\.customNodesHeader'\)/,
    },
    {
        key: "wf.loras", fr: "LoRAs", en: "LoRAs",
        icon: "palette", size: 12, file: "js/aih_workflow_share.js", was: "🎨",
        call: /iconSlot\("palette", 12\) \+ t\('wf\.loras'\)/,
    },
    {
        key: "wf.loadWorkflow", fr: "Charger le workflow", en: "Load workflow",
        icon: "download", size: 13, file: "js/aih_workflow_share.js", was: "📥",
        call: /iconSlot\("download", 13\) \+ t\('wf\.loadWorkflow'\)/,
    },
    {
        key: "wf.install", fr: "Installer", en: "Install",
        icon: "download", size: 11, file: "js/aih_workflow_share.js", was: "📥",
        call: /iconSlot\("download", 11\) \+ t\('wf\.install'\)/,
    },
    {
        key: "wf.suffix", fr: "Télécharger avec un autre nom", en: "Download with another name",
        icon: "plus", size: 13, file: "js/aih_workflow_share.js", was: "➕",
        call: /iconSlot\("plus", 13\) \+ t\('wf\.suffix'\)/,
    },
    {
        key: "wf.keep", fr: "Garder le modèle local (skip)", en: "Keep the local model (skip)",
        icon: "search", size: 13, file: "js/aih_workflow_share.js", was: "🔍",
        call: /iconSlot\("search", 13\) \+ t\('wf\.keep'\)/,
    },
    // ── Réparation de workflow (js/aih_repair_workflow.js) ─────────────────
    {
        key: "rw.copy", fr: "Copier", en: "Copy",
        icon: "copy", size: 13, file: "js/aih_repair_workflow.js", was: "📋",
        call: /setButtonLabelWithIcon\(doc, el\("button", "rw-btn"\), "copy", tr\("rw\.copy"\)\)/,
    },
    {
        key: "rw.saveAs", fr: "Enregistrer sous…", en: "Save as…",
        icon: "save", size: 13, file: "js/aih_repair_workflow.js", was: "💾",
        call: /setButtonLabelWithIcon\(doc, el\("button", "rw-btn"\), "save", tr\("rw\.saveAs"\)\)/,
    },
    // ── Prompt Enhancer (js/aih_enhance_widget.js) — NOUVEAU lot 2d ────────
    {
        key: "en.testEnhance", fr: "Test enhance", en: "Test enhance",
        icon: "test-tube", size: 12, file: "js/aih_enhance_widget.js", was: "🔄",
    },
];

/**
 * Clés NON migrées alors qu'elles portent un emoji : elles doivent GARDER leur
 * glyphe. C'est la preuve du non-débordement (statut, message, titre de
 * fenêtre, placeholder, contenu d'`<option>`…).
 */
const KEPT = [
    // Statuts pilotés par le code.
    { key: "wf.installed", emoji: "✅", why: "statut (installation réussie)" },
    { key: "wf.overwrite", emoji: "✅", why: "statut (remplacement du fichier local)" },
    { key: "rw.overwrite", emoji: "♻️", why: "statut (écrasement destructif de l'original)" },
    { key: "bl.done", emoji: "✅", why: "statut Blobby" },
    { key: "bl.error", emoji: "❌", why: "statut Blobby" },
    { key: "bl.llmIdle", emoji: "⏳", why: "statut d'attente LLM (phrase)" },
    { key: "bl.toolAct.changeNodeTypeNoop", emoji: "⏭️", why: "statut d'action (aucun changement)" },
    { key: "mb.dlwTitle", emoji: "⬇️", why: "TITRE de fenêtre (pas un contrôle)" },
    // Chiffres / libellés de section porteurs de sens (hors catégorie (a)).
    { key: "wf.models", emoji: "🧠", why: "emoji SÉMANTIQUE exclu (modèles)" },
    // Messages / phrases.
    { key: "rw.results.empty", emoji: "🎉", why: "message (aucun problème détecté)" },
    { key: "bl.analyzing", emoji: "🔄", why: "message d'état Blobby (phrase)" },
    { key: "bl.toolAct.closeSubgraph", emoji: "📂", why: "message d'action (phrase)" },
    // Contextes SANS contrôle capable de porter une icône.
    { key: "menu.membersTitle", emoji: "👥", why: "TITRE de modale" },
    { key: "menu.updateTitle", emoji: "🔄", why: "TITRE de modale" },
    { key: "wf.title", emoji: "📤", why: "TITRE de fenêtre" },
    { key: "wf.detailTitle", emoji: "📥", why: "TITRE de fenêtre" },
    { key: "wf.searchPlaceholder", emoji: "🔍", why: "attribut placeholder (texte seul)" },
    { key: "wf.sortDl", emoji: "📥", why: "contenu d'un <option> (texte seul)" },
    { key: "wf.sortLikes", emoji: "❤️", why: "contenu d'un <option> (texte seul)" },
    { key: "wf.sortDate", emoji: "📅", why: "contenu d'un <option> (texte seul)" },
    { key: "iv.processingVideo", emoji: "⏳", why: "statut du viewer (phase antérieure)" },
];

/* ══ 0. Dictionnaires : lecture + contrats (rejouables sur un mutant) ═════ */

const EMOJI_RX = /\p{Extended_Pictographic}/u;
const hasEmoji = (s) => EMOJI_RX.test(String(s));
const LINE_RX = /^\s*("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*$/;

/**
 * Extrait les deux dictionnaires du SOURCE de js/aih_strings.js (aucune
 * exécution : la garde doit pouvoir mordre sur un mutant, fichier temporaire).
 * @param {string} source
 * @returns {{fr: Record<string,string>, en: Record<string,string>}}
 */
function parseDicts(source) {
    const iFr = source.indexOf("const FR = {");
    const iEn = source.indexOf("const EN = {");
    assert.ok(iFr >= 0 && iEn > iFr, "dictionnaires FR/EN introuvables dans js/aih_strings.js");
    const parse = (block) => {
        const out = {};
        for (const line of block.split("\n")) {
            const m = LINE_RX.exec(line);
            if (!m) continue;
            out[JSON.parse(m[1])] = JSON.parse(m[2]);
        }
        return out;
    };
    return { fr: parse(source.slice(iFr, iEn)), en: parse(source.slice(iEn)) };
}

/**
 * Contrat des dictionnaires : parité stricte, textes exacts des clés migrées,
 * aucune espace résiduelle, et emoji de statut/message préservés.
 * @param {(rel: string) => string} reader
 */
function assertDictContract(reader) {
    const { fr, en } = parseDicts(reader("js/aih_strings.js"));

    // 1. Parité stricte : mêmes clés des deux côtés.
    assert.deepStrictEqual(Object.keys(fr).sort(), Object.keys(en).sort(),
        "parité FR/EN cassée : jeux de clés différents");

    // 2. Aucune valeur vide (une traduction manquante ne doit pas passer).
    for (const [k, v] of Object.entries(fr)) {
        assert.ok(String(v).trim().length > 0, `clé « ${k} » vide en FR`);
    }
    for (const [k, v] of Object.entries(en)) {
        assert.ok(String(v).trim().length > 0, `clé « ${k} » vide en EN`);
    }

    // 3. Clés MIGRÉES : texte exact, sans emoji, sans espace parasite.
    for (const m of MIGRATED) {
        for (const [loc, val] of [["FR", fr[m.key]], ["EN", en[m.key]]]) {
            assert.ok(!hasEmoji(val), `${loc} « ${m.key} » : emoji encore présent (${val})`);
            assert.ok(!hasEmoji(val.replace(/\{[a-z]+\}/g, "")),
                `${loc} « ${m.key} » : emoji résiduel`);
            assert.strictEqual(val, val.trim(), `${loc} « ${m.key} » : espace parasite en bord`);
            assert.strictEqual(val, val.replace(/\s{2,}/g, " "),
                `${loc} « ${m.key} » : double espace résiduel`);
        }
        assert.strictEqual(fr[m.key], m.fr, `FR « ${m.key} » : texte exact attendu`);
        assert.strictEqual(en[m.key], m.en, `EN « ${m.key} » : texte exact attendu`);
    }

    // 4. Non-débordement : les emoji de statut / message / titre restent.
    for (const k of KEPT) {
        for (const [loc, dict] of [["FR", fr], ["EN", en]]) {
            assert.ok(Object.prototype.hasOwnProperty.call(dict, k.key), `clé « ${k.key} » absente en ${loc}`);
            assert.ok(String(dict[k.key]).includes(k.emoji),
                `${loc} « ${k.key} » : l'emoji ${k.emoji} a été retiré par erreur (${k.why})`);
        }
    }
    return { fr, en };
}

/* ══ 1. Boot jsdom (I18n + dictionnaires + façade) ═══════════════════════ */

const dom = new JSDOM(`<!doctype html><html><head></head><body></body></html>`, {
    pretendToBeVisual: true,
    url: "http://localhost/",
});
const { window } = dom;
const DOC = window.document;

for (const key of ["window", "document", "HTMLElement", "Element", "Node", "localStorage",
    "getComputedStyle", "Event", "MouseEvent", "CustomEvent", "Image"]) {
    if (window[key] !== undefined) globalThis[key] = window[key];
}
globalThis.window = window;
window.ResizeObserver = globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.HTMLCanvasElement.prototype.getContext = () => null;
window.HTMLMediaElement.prototype.play = function () {};
window.HTMLMediaElement.prototype.pause = function () {};
window.HTMLMediaElement.prototype.load = function () {};
window.LiteGraph = globalThis.LiteGraph = { NODE_TITLE_HEIGHT: 24, vueNodesMode: false };
globalThis.app = window.app = { ui: { settings: {} }, graph: { _nodes: [] }, extensions: [] };
const noFetch = () => Promise.reject(new Error("réseau interdit en test"));
globalThis.fetch = window.fetch = noFetch;

localStorage.setItem("aih_locale", "fr");
await import("./aih_i18n.js");
window.AIH = window.AIH || {};
window.AIH.I18n.setLocale("fr");
globalThis.AIH = window.AIH;
await import("./aih_strings.js");
const icons = await import("./aih_icons.js");
const I18n = window.AIH.I18n;

/* Utilitaires d'inspection d'une icône rendue (même contrat que les lots 2a-2c). */
function brickBody(name) {
    const rendered = HolafIcons.render(name, { size: 24 });
    return rendered.slice(rendered.indexOf(">") + 1, rendered.lastIndexOf("</svg>"));
}
function assertOneIcon(container, expectedName, expectedSize, ctx) {
    const svgs = container.querySelectorAll("svg");
    assert.strictEqual(svgs.length, 1, `${ctx} : une seule icône attendue (reçu ${svgs.length})`);
    const svg = svgs[0];
    assert.strictEqual(svg.getAttribute("viewBox"), "0 0 24 24", `${ctx} : viewBox 24×24`);
    assert.strictEqual(svg.getAttribute("stroke"), "currentColor", `${ctx} : stroke=currentColor`);
    assert.strictEqual(svg.getAttribute("fill"), "none", `${ctx} : fill=none`);
    assert.strictEqual(svg.getAttribute("width"), String(expectedSize), `${ctx} : largeur ${expectedSize}`);
    assert.strictEqual(svg.getAttribute("height"), String(expectedSize), `${ctx} : hauteur ${expectedSize}`);
    assert.strictEqual(svg.getAttribute("aria-hidden"), "true", `${ctx} : icône décorative (aria-hidden)`);
    assert.strictEqual(svg.getAttribute("focusable"), "false", `${ctx} : focusable=false`);
    assert.strictEqual(svg.innerHTML, brickBody(expectedName),
        `${ctx} : tracés différents de l'icône « ${expectedName} »`);
    assert.ok(!/#[0-9a-fA-F]{3,8}\b|\brgb\(|\bhsl\(/.test(svg.outerHTML),
        `${ctx} : couleur codée en dur (attendu : currentColor)`);
    return svg;
}
/** `textContent` propre : texte exact, sans emoji, sans espace en bord. */
function assertCleanText(container, expected, ctx) {
    assert.strictEqual(container.textContent, expected, `${ctx} : texte EXACT attendu (« ${expected} »)`);
    assert.ok(!hasEmoji(container.textContent), `${ctx} : emoji encore présent dans le texte rendu`);
    assert.strictEqual(container.textContent, container.textContent.trim(), `${ctx} : espace parasite`);
}

/* ══ 2. Contrats de source, rejouables sur un mutant ═════════════════════ */

/** Motif du bloc de libellé du menu (js/holaf_main.js). */
const MENU_BLOCK_RX = /const labelSpan = document\.createElement\("span"\);[\s\S]*?menuItem\.appendChild\(labelSpan\);/;
/** Motif des entrées de menu déclarant une icône. */
const MENU_ICON_ENTRY_RX = /label: t\("(menu\.[A-Za-z]+)"\), icon: "([a-z-]+)"/g;

/**
 * Rend RÉELLEMENT le libellé d'une entrée de menu, avec le bloc extrait du
 * source (le bloc testé est donc bien celui qui tourne en production).
 * @param {(rel: string) => string} reader
 * @param {{label: string, icon?: string}} item
 * @returns {HTMLElement} le span de libellé inséré dans un <li>.
 */
function renderMenuLabel(reader, item) {
    const src = reader("js/holaf_main.js");
    const block = MENU_BLOCK_RX.exec(src);
    assert.ok(block, "js/holaf_main.js : bloc de construction du libellé introuvable");
    const build = new Function("itemInfo", "document", "aihIconSvg", "menuItem",
        block[0] + "\nreturn labelSpan;");
    const menuItem = DOC.createElement("li");
    const span = build(item, DOC, icons.aihIconSvg, menuItem);
    DOC.body.appendChild(menuItem);
    return span;
}

/**
 * Contrat du MENU : chaque entrée à icône déclarée rend « icône + texte exact »
 * (FR et EN), une seule icône, `textContent` propre.
 * @param {(rel: string) => string} reader
 * @param {Record<string,string>} fr
 * @param {Record<string,string>} en
 */
function assertMenuLabels(reader, fr, en) {
    const src = reader("js/holaf_main.js");
    const declared = [...src.matchAll(MENU_ICON_ENTRY_RX)].map((m) => ({ key: m[1], icon: m[2] }));
    const expectedKeys = MIGRATED.filter((m) => m.file === "js/holaf_main.js").map((m) => m.key);
    assert.deepStrictEqual(declared.map((d) => d.key).sort(), expectedKeys.sort(),
        "les entrées de menu portant une icône ne sont pas celles du lot (ajout/retrait non prévu)");

    for (const m of MIGRATED.filter((x) => x.file === "js/holaf_main.js")) {
        for (const [loc, text] of [["fr", fr[m.key]], ["en", en[m.key]]]) {
            const span = renderMenuLabel(reader, { label: text, icon: m.icon });
            const ctx = `menu ${m.key} (${loc.toUpperCase()})`;
            assertCleanText(span, text, ctx);
            assertOneIcon(span, m.icon, m.size, ctx);
            assert.strictEqual(span.querySelectorAll("svg").length, 1, `${ctx} : pas d'icône en double`);
            // L'icône est un ÉLÉMENT à part : elle précède un nœud de TEXTE pur.
            assert.strictEqual(span.lastChild.nodeType, 3, `${ctx} : le texte doit être un nœud de texte`);
            assert.strictEqual(span.lastChild.nodeValue, text, `${ctx} : nœud de texte = libellé exact`);
            DOC.body.textContent = "";
        }
    }
    return declared;
}

/** Motif du bloc du bouton « Test enhance » (js/aih_enhance_widget.js). */
const ENHANCE_BLOCK_RX = /const enhanceBtn = document\.createElement\("button"\);[\s\S]*?enhanceBtn\.appendChild\(document\.createTextNode\(t\("en\.testEnhance"\)\)\);/;

/** Contrat du bouton du Prompt Enhancer (icône + texte exact, FR et EN). */
function assertEnhanceLabel(reader, fr, en) {
    const src = reader("js/aih_enhance_widget.js");
    assert.ok(/import\s*\{\s*aihIconSvg\s*\}\s*from\s*["']\.\/aih_icons\.js["']/.test(src),
        "js/aih_enhance_widget.js : import de la façade absent");
    const block = ENHANCE_BLOCK_RX.exec(src);
    assert.ok(block, "js/aih_enhance_widget.js : bloc du bouton « Test enhance » introuvable");
    for (const [loc, text] of [["fr", fr["en.testEnhance"]], ["en", en["en.testEnhance"]]]) {
        const build = new Function("document", "aihIconSvg", "t", block[0] + "\nreturn enhanceBtn;");
        const btn = build(DOC, icons.aihIconSvg, () => text);
        const ctx = `enhance en.testEnhance (${loc.toUpperCase()})`;
        assertCleanText(btn, text, ctx);
        assertOneIcon(btn, "test-tube", 12, ctx);
    }
    // Contrôle négatif de périmètre local : le message « serveur non configuré »
    // n'est PAS un libellé d'interface → jamais d'icône ajoutée dans le textarea.
    assert.ok(/resultTextarea\.value = t\("en\.notConfigured"\)/.test(src),
        "le message en.notConfigured reste affecté au textarea (aucune icône dans un message)");
}

/** Contrat de la réparation : boutons Copier / Enregistrer sous. */
function assertRepairLabels(reader, fr, en) {
    const src = reader("js/aih_repair_workflow.js");
    assert.ok(/import\s*\{\s*aihIconSvg\s*\}\s*from\s*["']\.\/aih_icons\.js["']/.test(src),
        "js/aih_repair_workflow.js : import de la façade absent");
    for (const m of MIGRATED.filter((x) => x.file === "js/aih_repair_workflow.js")) {
        assert.ok(m.call.test(src), `js/aih_repair_workflow.js : appel du lot introuvable (${m.call})`);
    }
    const helper = /function setButtonLabelWithIcon\(doc, node, iconName, text\) \{[\s\S]*?\n    \}/.exec(src);
    assert.ok(helper, "js/aih_repair_workflow.js : helper setButtonLabelWithIcon introuvable");
    for (const m of MIGRATED.filter((x) => x.file === "js/aih_repair_workflow.js")) {
        for (const [loc, text] of [["fr", fr[m.key]], ["en", en[m.key]]]) {
            const build = new Function("aihIconSvg", `${helper[0]}\nreturn setButtonLabelWithIcon;`)(icons.aihIconSvg);
            const btn = build(DOC, DOC.createElement("button"), m.icon, text);
            const ctx = `repair ${m.key} (${loc.toUpperCase()})`;
            assertCleanText(btn, text, ctx);
            assertOneIcon(btn, m.icon, m.size, ctx);
        }
    }
    // L'écrasement destructif garde son glyphe de STATUT (non migré).
    assert.ok(/el\("button", "rw-btn rw-btn-danger", tr\("rw\.overwrite"\)\)/.test(src),
        "bouton « Écraser » : libellé de statut laissé tel quel (aucune icône)");
}

/** Extrait une expression du source et l'évalue (rendu réel du libellé). */
function renderExpression(reader, file, rx, params, label) {
    const src = reader(file);
    const m = rx.exec(src);
    assert.ok(m, `${file} : expression « ${label} » introuvable (${rx})`);
    return m[0];
}

/* ══ 3. Vérifications (vert) ═════════════════════════════════════════════ */

console.log("1. dictionnaires : clés migrées (texte exact FR/EN), parité stricte, non-débordement");
{
    const { fr, en } = assertDictContract(read);
    assert.ok(Object.keys(fr).length > 1000, `dictionnaires lus (${Object.keys(fr).length} clés)`);
    ok(`${MIGRATED.length} clés migrées : texte exact, sans emoji ni espace parasite, en FR et en EN`);
    ok(`parité FR/EN intacte (${Object.keys(fr).length} clés, aucune valeur vide)`);
    ok(`${KEPT.length} clés de statut/message/titre/placeholder : emoji PRÉSERVÉS (aucun débordement)`);

    // Le runtime sert bien les valeurs auditées (les dictionnaires sont bien
    // ceux enregistrés par AIH.I18n, pas une copie morte).
    for (const m of MIGRATED) {
        I18n.setLocale("fr");
        assert.strictEqual(I18n.t(m.key), m.fr, `runtime FR « ${m.key} » : valeur divergente`);
        I18n.setLocale("en");
        assert.strictEqual(I18n.t(m.key), m.en, `runtime EN « ${m.key} » : valeur divergente`);
    }
    I18n.setLocale("fr");
    ok("runtime AIH.I18n : les clés migrées servent exactement le texte audité (FR et EN)");

    // Les noms d'icônes du lot EXISTENT tous dans la brique.
    const dispo = icons.aihIconNames();
    const utilises = [...new Set(MIGRATED.map((m) => m.icon))];
    assert.deepStrictEqual(utilises.filter((x) => !dispo.includes(x)), [],
        "nom(s) d'icône absent(s) des " + dispo.length + " de la brique");
    ok(`${utilises.length} noms d'icônes du lot tous présents dans les ${dispo.length} de la brique`);
}

console.log("2. menu principal : « icône + texte exact », FR et EN, une seule icône");
{
    const { fr, en } = parseDicts(read("js/aih_strings.js"));
    const declared = assertMenuLabels(read, fr, en);
    ok(`${declared.length} entrées de menu : icône séparée + texte exact (FR et EN), textContent propre`);
}

console.log("3. workflows : onglets et bouton Publier rendus depuis le source réel");
{
    const { fr, en } = parseDicts(read("js/aih_strings.js"));
    const src = read("js/aih_workflow_share.js");
    // `iconSlot` RÉEL du module (jamais une copie dans le test).
    const slotSrc = /var iconSlot = function \(name, size, gap\) \{[\s\S]*?\n  \};/.exec(src);
    assert.ok(slotSrc, "js/aih_workflow_share.js : helper iconSlot introuvable");
    const iconSlot = new Function("aihIconSvg", `${slotSrc[0]}\nreturn iconSlot;`)(icons.aihIconSvg);
    assert.ok(/import\s*\{\s*aihIconSvg\s*\}\s*from\s*["']\.\/aih_icons\.js["']/.test(src),
        "js/aih_workflow_share.js : import de la façade absent");

    const CASES = [
        { key: "wf.tabShare", icon: "upload", rx: /'<button id="wf-tab-share"[\s\S]*?\+ t\('wf\.tabShare'\) \+ '<\/button>'/ },
        { key: "wf.tabBrowse", icon: "globe", rx: /'<button id="wf-tab-browse"[\s\S]*?\+ t\('wf\.tabBrowse'\) \+ '<\/button>'/ },
        { key: "wf.publish", icon: "upload", rx: /'<button id="wf-publish-btn"[\s\S]*?\+ t\('wf\.publish'\) \+ '<\/button>'/ },
    ];
    for (const c of CASES) {
        for (const [loc, text] of [["fr", fr[c.key]], ["en", en[c.key]]]) {
            const expr = renderExpression(read, "js/aih_workflow_share.js", c.rx, null, c.key);
            const html = new Function("currentTab", "iconSlot", "t", "return " + expr)
                (c.key === "wf.tabBrowse" ? "browse" : "share", iconSlot, () => text);
            const holder = DOC.createElement("div");
            holder.innerHTML = html;
            const ctx = `${c.key} (${loc.toUpperCase()})`;
            assertCleanText(holder, text, ctx);
            assertOneIcon(holder, c.icon, 13, ctx);
        }
    }
    // Les autres libellés du lot : l'icône est collée au libellé AU POINT D'APPEL.
    for (const m of MIGRATED.filter((x) => x.file === "js/aih_workflow_share.js" && x.call)) {
        assert.ok(m.call.test(src), `js/aih_workflow_share.js : motif d'appel absent pour « ${m.key} »`);
    }
    // Rendu de l'icône partagée : décorative, currentColor, taille demandée.
    for (const m of MIGRATED.filter((x) => x.file === "js/aih_workflow_share.js")) {
        const holder = DOC.createElement("div");
        holder.innerHTML = iconSlot(m.icon, m.size, 3);
        assertOneIcon(holder, m.icon, m.size, `iconSlot ${m.key}`);
        assert.ok(holder.textContent === "", `iconSlot ${m.key} : le slot n'ajoute aucun caractère`);
    }
    ok("onglets Partager/Parcourir + bouton Publier : expressions RÉELLES rendues (icône + texte exact, FR et EN)");
    ok("autres libellés workflows : icône collée au libellé au point d'appel, slot sans caractère parasite");
    // Statuts du module : toujours du TEXTE (non-débordement).
    for (const st of ["⏳", "♻️", "✅", "⏭", "❌"]) {
        assert.ok(src.includes(st), `statut « ${st} » de aih_workflow_share.js toujours présent en texte`);
    }
    ok("statuts ⏳ ♻️ ✅ ⏭ ❌ de aih_workflow_share.js inchangés (toujours du texte)");
}

console.log("4. réparation de workflow : module RÉEL monté, boutons Copier / Enregistrer sous");
{
    await import("./aih_dialog.js");
    await import("./aih_repair_workflow.js");
    const RW = window.AIHRepairWorkflow;
    assert.ok(RW && typeof RW.mountRepairUI === "function", "window.AIHRepairWorkflow exposé");

    for (const loc of ["fr", "en"]) {
        I18n.setLocale(loc);
        const container = DOC.createElement("div");
        DOC.body.appendChild(container);
        const ctrl = RW.mountRepairUI(container, {
            document: DOC,
            t: (k, p) => I18n.t(k, p),
            api: {
                listWorkflows: async () => ({ workflows: [] }),
                analyze: async () => ({ problems: [] }),
                apply: async () => ({ files: [] }),
            },
            confirm: () => Promise.resolve(true),
            prompt: () => Promise.resolve(null),
            notify: () => {},
            copyText: async () => {},
        });
        ctrl.setPasted("{}");
        await ctrl.analyze();
        await new Promise((r) => setTimeout(r, 20));

        for (const [sel, key, icon] of [
            ["[data-rw-copy]", "rw.copy", "copy"],
            ["[data-rw-saveas]", "rw.saveAs", "save"],
        ]) {
            const btn = container.querySelector(sel);
            assert.ok(btn, `${sel} : bouton présent (${loc.toUpperCase()})`);
            const ctx = `${key} (${loc.toUpperCase()})`;
            assertCleanText(btn, I18n.t(key), ctx);
            assertOneIcon(btn, icon, 13, ctx);
            // Classes et data-* de production conservés.
            assert.ok(btn.classList.contains("rw-btn"), `${ctx} : classe rw-btn conservée`);
            assert.strictEqual(btn.getAttribute(sel.slice(1, -1).replace("data-", "data-")), "1",
                `${ctx} : data-* conservé`);
        }
        DOC.body.textContent = "";
    }
    I18n.setLocale("fr");
    ok("rw.copy / rw.saveAs : module réel, icône + texte exact en FR et EN, data-*/classes intacts");
}

console.log("5. prompt enhancer : bouton « Test enhance » (NOUVEAU consommateur du lot 2d)");
{
    const { fr, en } = parseDicts(read("js/aih_strings.js"));
    assertEnhanceLabel(read, fr, en);
    ok("enhance : icône test-tube + texte exact (FR et EN), message en.notConfigured sans icône");
    // Le texte de la clé est identique en FR et en EN (libellé anglais assumé).
    assert.strictEqual(fr["en.testEnhance"], en["en.testEnhance"]);
}

console.log("6. périmètre par phases : lot 2d branché, listes disjointes, interdits inchangés");
{
    assert.strictEqual(CURRENT_PHASE, "2e",
        "le lot en cours est la phase 2e (la 2d reste livrée et branchée)");
    assert.deepStrictEqual(Object.keys(PHASES), ["2a", "2b", "2c", "2d", "2e"],
        "les lots 2a → 2e sont livrés, dans l'ordre (aucun recul de périmètre)");
    assert.strictEqual(PHASE_2D_CONSUMERS.length, 1, "la phase 2d couvre 1 nouveau fichier");

    const r = checkIconPerimetre(PACKAGE_DIR, "2d");
    assert.deepStrictEqual(r.interdits, [], "fichier(s) interdit(s) consommant la façade : " + r.interdits.join(", "));
    assert.deepStrictEqual(r.horsListe, [], "consommateur(s) hors périmètre : " + r.horsListe.join(", "));
    assert.deepStrictEqual(r.manquants, [],
        "fichier(s) du lot 2d ne consommant pas la façade : " + r.manquants.join(", "));
    assert.deepStrictEqual(r.manquantsToutesPhases, [],
        "fichier(s) d'une phase livrée ne consommant plus la façade : " + r.manquantsToutesPhases.join(", "));
    assert.deepStrictEqual(r.offenders, ALLOWED_CONSUMERS,
        "les consommateurs détectés sont EXACTEMENT les fichiers des phases livrées");

    const disjoint = checkPhaseDisjointness();
    assert.deepStrictEqual(disjoint.croisements, [], "fichier(s) à la fois autorisé(s) et interdit(s)");
    assert.deepStrictEqual(disjoint.doublonsPhases, [],
        "fichier(s) présent(s) dans deux phases : " + disjoint.doublonsPhases.join(", "));
    assert.deepStrictEqual(FORBIDDEN_CONSUMERS, [
        "js/blobby_companion.js", "js/aih_elements_seed.js", "js/aih_keywords_widget.js",
    ], "les 3 fichiers interdits sémantiques sont inchangés");
    ok(`périmètre : ${r.offenders.length} consommateurs (dont ${PHASE_2D_CONSUMERS.length} en 2d), ` +
        "aucun hors liste, aucune double inscription, 3 interdits inchangés");
}

/* ══ 7. Contrôles négatifs PAR MUTATION ══════════════════════════════════ */

console.log("7. contrôles négatifs par mutation (emoji, parité, icône, statut, espace, doublon)");
{
    for (const f of readdirSync(HERE)) {
        if (/^\.__mut6_\d+_[a-z_]+\.(mjs|js)$/.test(f)) rmSync(join(HERE, f), { force: true });
    }

    let seq = 0;
    /**
     * Écrit un mutant de `rel` dans js/, exécute `check(reader)` avec un reader
     * qui substitue le mutant, puis supprime le fichier.
     */
    async function mutant(rel, label, mutate, check) {
        const src = read(rel);
        const mutated = mutate(src);
        assert.notStrictEqual(mutated, src, `mutation « ${label} » sans effet (ancre introuvable)`);
        const file = join(HERE, `.__mut6_${++seq}_${rel.split("/").pop().replace(/\.(js|mjs)$/, "")}.js`);
        writeFileSync(file, mutated, "utf8");
        const reader = (r) => (r === rel ? mutated : read(r));
        let failure = null;
        try {
            await check(reader);
        } catch (e) {
            failure = e;
        } finally {
            rmSync(file, { force: true });
            DOC.body.textContent = "";
        }
        assert.ok(failure, `mutation « ${label} » NON détectée (le contrat reste vert) → contrôle négatif vacant`);
        return failure.message;
    }

    /* (a) Emoji réintroduit dans une clé migrée (FR). */
    const msgEmoji = await mutant("js/aih_strings.js", "emoji réintroduit dans wf.publish",
        (s) => s.replace('"wf.publish": "Publier"', '"wf.publish": "📤 Publier"'),
        (reader) => assertDictContract(reader)
    );
    ok(`emoji réintroduit dans une clé → ROUGE (${msgEmoji.split("\n")[0].slice(0, 70)})`);

    /* (b) Clé retirée d'UNE SEULE langue (parité cassée). */
    const msgParity = await mutant("js/aih_strings.js", "clé EN de wf.publish retirée",
        (s) => s.replace('        "wf.publish": "Publish",\n', ""),
        (reader) => assertDictContract(reader)
    );
    ok(`clé retirée d'une seule langue → ROUGE (${msgParity.split("\n")[0].slice(0, 70)})`);

    /* (c) Icône manquante au point d'appel (entrée de menu sans icône). */
    const msgNoIcon = await mutant("js/holaf_main.js", "icône retirée de l'entrée « Workflows »",
        (s) => s.replace('{ label: t("menu.workflows"), icon: "upload", special: \'aih_workflows\' },',
            '{ label: t("menu.workflows"), special: \'aih_workflows\' },'),
        (reader) => {
            const { fr, en } = parseDicts(read("js/aih_strings.js"));
            assertMenuLabels(reader, fr, en);
        }
    );
    ok(`icône manquante au point d'appel → ROUGE (${msgNoIcon.split("\n")[0].slice(0, 70)})`);

    /* (d) Clé de STATUT migrée par erreur (✅ retiré de wf.installed). */
    const msgStatus = await mutant("js/aih_strings.js", "statut wf.installed migré par erreur",
        (s) => s.replace('"wf.installed": "✅ Installé"', '"wf.installed": "Installé"'),
        (reader) => assertDictContract(reader)
    );
    ok(`clé de statut migrée par erreur → ROUGE (${msgStatus.split("\n")[0].slice(0, 70)})`);

    /* (e) Espace parasite résiduel dans un libellé migré. */
    const msgSpace = await mutant("js/aih_strings.js", "espace parasite dans rw.copy",
        (s) => s.replace('"rw.copy": "Copier"', '"rw.copy": " Copier"'),
        (reader) => assertDictContract(reader)
    );
    ok(`espace parasite dans le libellé → ROUGE (${msgSpace.split("\n")[0].slice(0, 70)})`);

    /* (f) Icône en DOUBLE (menu). */
    const msgDouble = await mutant("js/holaf_main.js", "icône du menu ajoutée deux fois",
        // Un `appendChild` du MÊME nœud le déplace (pas de doublon) : le
        // mutant doit cloner pour produire une seconde icône réelle.
        (s) => s.replace("                labelSpan.appendChild(iconEl);",
            "                labelSpan.appendChild(iconEl);\n                labelSpan.appendChild(iconEl.cloneNode(true));"),
        (reader) => {
            const { fr, en } = parseDicts(read("js/aih_strings.js"));
            assertMenuLabels(reader, fr, en);
        }
    );
    ok(`icône en double → ROUGE (${msgDouble.split("\n")[0].slice(0, 70)})`);

    /* (g) Icône en DOUBLE dans le helper des boutons de réparation. */
    const msgDoubleBtn = await mutant("js/aih_repair_workflow.js", "slot dupliqué dans Copier",
        (s) => s.replace("        node.appendChild(slot);",
            "        node.appendChild(slot);\n        node.appendChild(slot.cloneNode(true));"),
        (reader) => {
            const { fr, en } = parseDicts(read("js/aih_strings.js"));
            assertRepairLabels(reader, fr, en);
        }
    );
    ok(`icône en double dans un bouton → ROUGE (${msgDoubleBtn.split("\n")[0].slice(0, 70)})`);

    /* (h) Libellé mêlé qui perd son icône (workflows). */
    const msgWfNoIcon = await mutant("js/aih_workflow_share.js", "icône retirée du bouton Installer",
        (s) => s.replace('iconSlot("download", 11) + t(\'wf.install\')', 't(\'wf.install\')'),
        (reader) => {
            const src = reader("js/aih_workflow_share.js");
            const m = MIGRATED.find((x) => x.key === "wf.install");
            assert.ok(m.call.test(src), "js/aih_workflow_share.js : icône absente au point d'appel");
        }
    );
    ok(`icône retirée d'un libellé de bouton → ROUGE (${msgWfNoIcon.split("\n")[0].slice(0, 70)})`);

    /* (i) Consommation hors liste (fichier non déclaré dans une phase). */
    const forbiddenFile = join(HERE, ".__mut6_forbidden_consumer.js");
    writeFileSync(forbiddenFile, 'import { aihIconSvg } from "./aih_icons.js";\n', "utf8");
    let perimeterFailure = null;
    try {
        const r = checkIconPerimetre(PACKAGE_DIR, "2d");
        assert.deepStrictEqual(r.horsListe, [], "consommateur(s) hors périmètre : " + r.horsListe.join(", "));
    } catch (e) {
        perimeterFailure = e;
    } finally {
        rmSync(forbiddenFile, { force: true });
    }
    assert.ok(perimeterFailure, "mutation « consommateur hors liste » NON détectée");
    ok(`consommation hors liste → ROUGE (${perimeterFailure.message.split("\n")[0].slice(0, 70)})`);

    // Aucun mutant résiduel.
    const leftovers = readdirSync(HERE).filter((f) => /^\.__mut6_/.test(f));
    assert.deepStrictEqual(leftovers, [], "mutant(s) résiduel(s) : " + leftovers.join(", "));
    ok("fichiers du lot intacts, aucun mutant résiduel");
}

console.log("");
console.log(`✅ test_aih_icons_phase2d : ${n} groupes PASSENT (${MIGRATED.length} libellés migrés, ${KEPT.length} clés préservées)`);
