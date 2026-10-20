// ─────────────────────────────────────────────────────────────────────────
// PHASE 2a de la migration d'icônes : les emoji COSMÉTIQUES des dialogues, des
// boutons « fermer », du plein écran et de la poignée de drag sont remplacés
// par les icônes de la brique `holaf-icons` — consommées UNIQUEMENT via la
// façade js/aih_icons.js.
//
// Ce qui est verrouillé ici (charge les VRAIS modules du pack sous jsdom) :
//   1. SOURCE : chaque emplacement du lot appelle la façade et n'a PLUS son
//      emoji (aucun glyphe résiduel, aucun import direct de la brique
//      vendorisée — passer par la façade est la seule voie autorisée).
//   2. ALERTES (aih_dialog) : la sémantique du TYPE est conservée
//      (info→info, success→check-circle, error→ban, warning→alert-triangle),
//      la classe `aih-dialog-icon-<type>` (couleur de l'hôte) aussi, l'icône est
//      DÉCORATIVE (aria-hidden) et sa couleur vient de `currentColor` — aucune
//      couleur codée en dur dans le SVG.
//   3. BOUTONS « FERMER » : chacun contient l'icône `x` ET garde un nom
//      accessible (`title` non vide) — jamais un bouton muet.
//   4. POIGNÉE DE DRAG (holaf_layout_tools) : icône `grip-vertical`, `cursor`
//      grab + `user-select:none` + `touch-action:none` conservés et le DRAG
//      FONCTIONNE encore (mousedown sur la poignée → mousemove → la barre bouge).
//   5. PLEIN ÉCRAN (holaf_image_viewer, image_viewer_ui) : croix et icône
//      « maximize » en place, titres conservés.
//   6. PÉRIMÈTRE : les 7 fichiers du lot sont ceux autorisés par
//      test_helpers/icon_perimeter.mjs, aucun fichier interdit ne consomme la
//      façade.
//   7. CONTRÔLES NÉGATIFS PAR MUTATION (le vérificateur mord) : emoji
//      réintroduit → ROUGE ; poignée perdant son drag → ROUGE ; bouton fermer
//      perdant son `title` → ROUGE ; consommation dans un fichier interdit →
//      ROUGE. Les mutants sont écrits en fichier temporaire de js/, importés,
//      puis supprimés.
//
// Usage : node js/test_aih_icons_phase2a.mjs
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom absent), 1 = FAIL.
import assert from "node:assert";
import { readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";
import { PHASE_2A_CONSUMERS, checkIconPerimetre } from "./test_helpers/icon_perimeter.mjs";
import { HolafIcons } from "./vendor/holaf/holaf-icons.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HERE, "..");

const JSDOM = await loadJsdomOrSkip("test_aih_icons_phase2a");

/* ══ 0. Boot « comme ComfyUI » sous jsdom ════════════════════════════════ */
const dom = new JSDOM(`<!doctype html><html><head></head><body></body></html>`, {
    pretendToBeVisual: true,
    url: "http://localhost/",
});
const { window } = dom;

// Le pack lit window/document comme globals (modules chargés depuis js/) : on
// installe un pont complet, sinon les modules qui touchent document à l'import
// (holaf_panel_manager, etc.) lèveraient un ReferenceError.
const GLOBALS = [
    "window", "document", "HTMLElement", "Element", "Node", "localStorage",
    "getComputedStyle", "Event", "MouseEvent", "CustomEvent", "MutationObserver",
    "requestAnimationFrame", "cancelAnimationFrame", "Image", "Audio",
    "HTMLMediaElement", "HTMLImageElement", "HTMLVideoElement", "HTMLAudioElement",
];
for (const key of GLOBALS) {
    if (window[key] !== undefined) globalThis[key] = window[key];
}
globalThis.window = window;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });

// jsdom n'implémente ni canvas 2D ni ResizeObserver ni la lecture média : on
// neutralise (comme test_remote_comparer_path.mjs) pour ne tester que le DOM.
globalThis.ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
};
window.HTMLCanvasElement.prototype.getContext = () => null;
window.HTMLMediaElement.prototype.play = function () {};
window.HTMLMediaElement.prototype.pause = function () {};
window.HTMLMediaElement.prototype.load = function () {};

// ComfyUI factice : les modules qui appellent app.registerExtension à l'import
// enregistrent leur extension, et `setup()` peut être rejoué par les tests.
const registered = [];
const fakeApp = { registerExtension(ext) { registered.push(ext); } };
window.comfyAPI = {
    app: { app: fakeApp },
    api: {
        api: {
            api_base: "",
            apiURL: (p) => p,
            addEventListener() {},
            fetchApi: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
        },
    },
};

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

const read = (rel) => readFileSync(join(PACKAGE_DIR, rel), "utf8");

/* ══ 1. Source : chaque emplacement appelle la façade, aucun emoji ═══════ */
console.log("1. source : façade appelée, emoji cosmétiques disparus (7 fichiers)");
{
    // `must` : fragments indispensables (appel de façade + nom d'icône + garde
    //          accessibilité) ; `glyphes` : emoji qui ne doivent PLUS apparaître.
    //          Aucun glyphe n'est laissé dans les commentaires : une simple
    //          recherche de caractère suffit donc, sans analyse de code.
    const LOT = [
        {
            file: "js/aih_dialog.js",
            must: [
                [/import\s*\{\s*aihIconSvg\s*\}\s*from\s*["']\.\/aih_icons\.js["']/, "import de la façade"],
                [/aihIconSvg\(\s*["']x["']/, "croix du bouton fermer"],
                [/info:\s*["']info["']/, "type info"],
                [/success:\s*["']check-circle["']/, "type success"],
                [/error:\s*["']ban["']/, "type error"],
                [/warning:\s*["']alert-triangle["']/, "type warning"],
                [/aih-dialog-icon-/, "classe de type conservée (couleur de l'hôte)"],
                [/aria-hidden="true"/, "icône d'alerte décorative"],
            ],
            glyphes: ["✕", "ℹ️", "✅", "❌", "⚠️"],
        },
        {
            file: "js/holaf_panel_manager.js",
            must: [
                [/import\s*\{\s*aihIconSvg\s*\}\s*from\s*["']\.\/aih_icons\.js["']/, "import de la façade"],
                [/closeButton\.innerHTML\s*=\s*aihIconSvg\(\s*["']x["']/, "croix du bouton fermer"],
                [/closeButton\.title\s*=/, "nom accessible du bouton"],
            ],
            glyphes: ["✕"],
        },
        {
            file: "js/holaf_remote_comparer.js",
            must: [
                [/import\s*\{\s*aihIconSvg\s*\}\s*from\s*["']\.\/aih_icons\.js["']/, "import de la façade"],
                [/closeBtn\.innerHTML\s*=\s*aihIconSvg\(\s*["']x["']/, "croix du bouton fermer"],
                [/closeBtn\.title\s*=/, "nom accessible du bouton"],
            ],
            glyphes: ["✕"],
        },
        {
            file: "js/holaf_layout_tools.js",
            must: [
                [/import\s*\{\s*aihIconSvg\s*\}\s*from\s*["']\.\/aih_icons\.js["']/, "import de la façade"],
                [/grip\.innerHTML\s*=\s*aihIconSvg\(\s*["']grip-vertical["']/, "poignée de drag"],
                [/grip\.style\.cursor\s*=\s*["']grab["']/, "curseur grab conservé"],
                [/grip\.style\.userSelect\s*=\s*["']none["']/, "user-select:none conservé"],
                [/grip\.style\.touchAction\s*=\s*["']none["']/, "touch-action:none"],
                [/this\.enableWindowDragging\(grip\)/, "drag branché sur la poignée"],
                [/closeBtn\.innerHTML\s*=\s*aihIconSvg\(\s*["']x["']/, "croix du bouton fermer"],
            ],
            glyphes: ["⠿", "✕"],
        },
        {
            file: "js/holaf_image_viewer.js",
            must: [
                [/import\s*\{\s*aihIconSvg\s*\}\s*from\s*["']\.\/aih_icons\.js["']/, "import de la façade"],
                [/aihIconSvg\(\s*["']x["']/, "croix du plein écran"],
                [/class="holaf-viewer-fs-close"[^>]*title=/, "nom accessible du bouton"],
            ],
            glyphes: ["✖"],
        },
        {
            file: "js/image_viewer/image_viewer_ui.js",
            must: [
                [/import\s*\{\s*aihIconSvg\s*\}\s*from\s*["']\.\.\/aih_icons\.js["']/, "import de la façade"],
                [/aihIconSvg\(\s*["']x["']/, "croix du zoom"],
                [/aihIconSvg\(\s*["']maximize["']/, "icône plein écran"],
                [/class="holaf-viewer-zoom-close"[^>]*title=/, "nom accessible (zoom)"],
                [/class="holaf-viewer-zoom-fullscreen-icon"[^>]*title=/, "nom accessible (plein écran)"],
            ],
            glyphes: ["✖", "⛶"],
        },
        {
            file: "js/model_manager/model_manager_ui.js",
            must: [
                [/import\s*\{\s*aihIconSvg\s*\}\s*from\s*["']\.\.\/aih_icons\.js["']/, "import de la façade"],
                [/aihIconSvg\(\s*["']x["']/, "croix de la modale d'upload"],
                [/holaf-utility-close-button"\s+title=/, "nom accessible du bouton"],
            ],
            glyphes: ["✖"],
        },
    ];

    for (const spec of LOT) {
        const text = read(spec.file);
        for (const [rx, label] of spec.must) {
            assert.ok(rx.test(text), `${spec.file} : ${label} introuvable (${rx})`);
        }
        for (const glyph of spec.glyphes) {
            assert.ok(!text.includes(glyph), `${spec.file} : emoji ${glyph} encore présent`);
        }
        // « Uniquement la façade » : aucun import direct de la brique vendorisée.
        assert.ok(!/holaf-icons\.js/.test(text),
            `${spec.file} : import direct de la brique vendorisée interdit (passer par aih_icons.js)`);
    }
    ok(`7 fichiers : façade appelée (une seule voie), ${LOT.reduce((a, s) => a + s.glyphes.length, 0)} emoji éliminés`);

    // La liste blanche du périmètre est bien celle de ce lot (source unique de
    // vérité test_helpers/icon_perimeter.mjs) : aucun fichier interdit ne consomme.
    // ⚠️ Depuis la PHASE 2b la liste autorisée est CUMULATIVE : on vérifie le lot
    // 2a (`manquants`) sans exiger qu'il soit l'UNIQUE consommateur du pack.
    const perimeter = checkIconPerimetre(PACKAGE_DIR, "2a");
    assert.deepStrictEqual(perimeter.interdits, [],
        "fichier(s) interdit(s) consommant la façade : " + perimeter.interdits.join(", "));
    assert.deepStrictEqual(perimeter.horsListe, [],
        "consommateur(s) hors périmètre : " + perimeter.horsListe.join(", "));
    assert.deepStrictEqual(perimeter.manquants, [],
        "fichier(s) du lot 2a ne consommant pas la façade : " + perimeter.manquants.join(", "));
    assert.deepStrictEqual(perimeter.manquantsToutesPhases, [],
        "fichier(s) de TOUTES les phases ne consommant pas la façade : " +
        perimeter.manquantsToutesPhases.join(", "));
    for (const rel of PHASE_2A_CONSUMERS) {
        assert.ok(perimeter.offenders.includes(rel),
            `${rel} : fichier du lot 2a absent des consommateurs détectés`);
    }
    ok(`périmètre : ${perimeter.offenders.length} consommateur(s) détecté(s), ` +
        `les ${PHASE_2A_CONSUMERS.length} du lot 2a présents, aucun interdit`);
}

/* ══ Modules réels du pack (chargés une seule fois) ══════════════════════ */
const icons = await import("./aih_icons.js");
await import("./aih_i18n.js");
await import("./aih_dialog.js");
const { HolafPanelManager } = await import("./holaf_panel_manager.js");
const { UI: imageViewerUI } = await import("./image_viewer/image_viewer_ui.js");
const modelManagerUI = await import("./model_manager/model_manager_ui.js");
const imageViewer = (await import("./holaf_image_viewer.js")).default;
await import("./holaf_remote_comparer.js");
await import("./holaf_layout_tools.js");

// Les noms d'icônes utilisés par le lot EXISTENT dans la brique (aucun nom
// inventé : un nom inconnu ne lèverait pas — la façade rendrait un vide inerte —
// d'où ce contrôle explicite sur aihIconNames()).
{
    const disponibles = icons.aihIconNames();
    const utilises = ["x", "info", "check-circle", "ban", "alert-triangle", "grip-vertical", "maximize"];
    const inconnus = utilises.filter((name) => !disponibles.includes(name));
    assert.deepStrictEqual(inconnus, [], "nom(s) d'icône(s) absent(s) des 114 de la brique : " + inconnus.join(", "));
    ok(`${utilises.length} noms d'icônes du lot tous présents dans les ${disponibles.length} de la brique`);
}

/* Utilitaires d'inspection d'une icône rendue. */
function assertIconSvg(svgEl, expectedName, expectedSize, ctx) {
    assert.ok(svgEl, `${ctx} : aucun <svg>`);
    assert.strictEqual(svgEl.tagName.toLowerCase(), "svg", `${ctx} : <svg> attendu`);
    assert.strictEqual(svgEl.getAttribute("viewBox"), "0 0 24 24", `${ctx} : viewBox 24×24`);
    assert.strictEqual(svgEl.getAttribute("stroke"), "currentColor", `${ctx} : stroke=currentColor`);
    assert.strictEqual(svgEl.getAttribute("fill"), "none", `${ctx} : fill=none`);
    assert.strictEqual(svgEl.getAttribute("width"), String(expectedSize), `${ctx} : taille ${expectedSize}`);
    assert.strictEqual(svgEl.getAttribute("height"), String(expectedSize), `${ctx} : hauteur ${expectedSize}`);
    // Corps identique au rendu de la BRIQUE via la façade → l'icône est bien
    // celle annoncée (un nom erroné changerait les tracés).
    assert.strictEqual(svgEl.innerHTML, brickBody(expectedName),
        `${ctx} : tracés différents de l'icône « ${expectedName} »`);
    // Aucune couleur codée en dur : la teinte vient du CSS de l'hôte.
    assert.ok(!/#[0-9a-fA-F]{3,8}\b|\brgb\(|\bhsl\(/.test(svgEl.outerHTML),
        `${ctx} : couleur codée en dur dans le SVG (attendu : currentColor)`);
}
// Corps SVG (tracés) de la brique, sans le wrapper (comparaison exacte).
function brickBody(name) {
    const rendered = HolafIcons.render(name, { size: 24 });
    const open = rendered.indexOf(">");
    const close = rendered.lastIndexOf("</svg>");
    return rendered.slice(open + 1, close);
}
// Nettoyage de l'icône d'un élément avant réutilisation (jsdom partagé).
function clearBody() { window.document.body.innerHTML = ""; }

/** Monte la barre d'outils de la DERNIÈRE extension Holaf.Layout.Tools chargée
 *  (le module réel en section 5, puis chaque mutant) et renvoie ses éléments.
 *  `init()` (via setup()) installe window.holaf.layoutTools. */
function bootLayoutTools() {
    clearBody();
    const ext = registered.filter((e) => e.name === "Holaf.Layout.Tools").pop();
    assert.ok(ext, "extension Holaf.Layout.Tools enregistrée");
    ext.setup();
    const tools = window.holaf && window.holaf.layoutTools;
    assert.ok(tools, "window.holaf.layoutTools exposé par setup()");
    tools.createFloatingToolbar();
    const container = window.document.getElementById("holaf-layout-toolbar");
    assert.ok(container, "barre d'outils créée");
    return {
        tools,
        container,
        grip: container.firstElementChild,
        closeBtn: container.querySelector("button.holaf-header-button"),
    };
}

/* ══ 2. ALERTES : sémantique du type + couleur de l'hôte + aria ══════════ */
console.log("2. aih_dialog : alertes info/success/error/warning (icône du type, couleur hôte)");
{
    const ATTENDU = {
        info: "info",
        success: "check-circle",
        error: "ban",
        warning: "alert-triangle",
    };
    assert.deepStrictEqual(Object.keys(ATTENDU).sort(), ["error", "info", "success", "warning"],
        "les 4 types d'alerte sont couverts");

    for (const [type, iconName] of Object.entries(ATTENDU)) {
        clearBody();
        const p = window.AIH.alert(`Titre ${type}`, "Message", type);
        const iconDiv = window.document.querySelector(".aih-dialog-icon");
        assert.ok(iconDiv, `alerte ${type} : div d'icône présent`);
        // Typage d'alerte CONSERVÉ : c'est cette classe qui porte la couleur
        // (--aih-accent-active / success / danger / accent-hover-active).
        assert.deepStrictEqual(iconDiv.className.split(/\s+/).sort(),
            ["aih-dialog-icon", `aih-dialog-icon-${type}`].sort(),
            `alerte ${type} : classe de type`);
        // Icône DÉCORATIVE (le sens est porté par le titre + le message).
        assert.strictEqual(iconDiv.getAttribute("aria-hidden"), "true",
            `alerte ${type} : icône décorative (aria-hidden)`);
        assertIconSvg(iconDiv.querySelector("svg"), iconName, 24, `alerte ${type}`);
        window.document.querySelector("[data-aih-ok]").click();
        await p;
    }
    ok("alertes : info→info, success→check-circle, error→ban, warning→alert-triangle (24 px, currentColor, aria-hidden)");

    // Type inconnu : l'icône retombe sur info, la CLASSE garde le type demandé
    // (comportement historique : pas de règle de couleur → couleur héritée).
    clearBody();
    const pUnknown = window.AIH.alert("T", "M", "danger");
    const divUnknown = window.document.querySelector(".aih-dialog-icon");
    assert.ok(divUnknown.className.split(/\s+/).includes("aih-dialog-icon-danger"),
        "type inconnu : la classe de type d'origine est conservée");
    assertIconSvg(divUnknown.querySelector("svg"), "info", 24, "type inconnu");
    window.document.querySelector("[data-aih-ok]").click();
    await pUnknown;
    ok("type inconnu : icône de repli « info », classe d'origine conservée (aucune couleur inventée)");

    // Bouton fermer des dialogues : icône `x` + nom accessible intact.
    clearBody();
    const ctrl = window.AIH.Dialog.open({ title: "Fermeture" });
    const closeBtn = ctrl.el.querySelector(".aih-dialog-close");
    assert.ok(closeBtn, "bouton fermer présent");
    assertIconSvg(closeBtn.querySelector("svg"), "x", 14, "fermeture dialogue");
    assert.ok((closeBtn.title || "").trim(), "bouton fermer : nom accessible (title) conservé");
    assert.strictEqual(closeBtn.style.display, "inline-flex", "bouton fermer : centrage inline-flex (sans CSS global)");
    ctrl.close();
    ok("dialogues : croix « x » 14 px dans le bouton fermer, title conservé, aucune feuille de style ajoutée");
}

/* ══ 3. Boutons « fermer » des panneaux et des modales ═══════════════════ */
console.log("3. panneaux / image viewer / model manager : croix « x » + nom accessible");
{
    // (a) Panneau générique (holaf_panel_manager).
    clearBody();
    const { panelEl } = HolafPanelManager.createPanel({ id: "probe-panel", title: "Panneau" });
    const panelClose = panelEl.querySelector(".holaf-utility-close-button");
    assertIconSvg(panelClose.querySelector("svg"), "x", 14, "fermeture de panneau");
    assert.ok((panelClose.title || "").trim(), "panneau : nom accessible (title) du bouton fermer");
    panelClose.click();
    assert.strictEqual(panelEl.style.display, "none", "panneau : le clic ferme toujours (comportement inchangé)");
    ok("panneau : croix 14 px, title conservé, clic → fermeture effective");

    // (b) Image viewer : bouton du zoom + bouton plein écran.
    clearBody();
    const pane = imageViewerUI._createCenterPane();
    const zoomClose = pane.querySelector(".holaf-viewer-zoom-close");
    assertIconSvg(zoomClose.querySelector("svg"), "x", 18, "fermeture du zoom");
    assert.ok((zoomClose.title || "").trim(), "zoom : nom accessible du bouton fermer");
    const fullscreenBtn = pane.querySelector(".holaf-viewer-zoom-fullscreen-icon");
    assertIconSvg(fullscreenBtn.querySelector("svg"), "maximize", 18, "bouton plein écran");
    assert.ok((fullscreenBtn.title || "").trim(), "plein écran : nom accessible du bouton");
    ok("image viewer : croix 18 px + icône « maximize » 18 px, titres conservés");

    // (c) Plein écran de la visionneuse (overlay dédié).
    clearBody();
    imageViewer._createFullscreenOverlay();
    const fsClose = window.document.querySelector("#holaf-viewer-fs-close");
    assertIconSvg(fsClose.querySelector("svg"), "x", 22, "fermeture du plein écran");
    assert.ok((fsClose.title || "").trim(), "plein écran : nom accessible du bouton fermer");
    assert.strictEqual(typeof imageViewer.fullscreenElements.closeBtn.onclick, "function",
        "plein écran : le handler de fermeture est toujours branché");
    ok("plein écran : croix 22 px, title conservé, onclick toujours branché");

    // (d) Modale d'upload du gestionnaire de modèles.
    clearBody();
    modelManagerUI.createUploadDialog({ uploadDialog: null });
    const uploadClose = window.document.querySelector("#holaf-manager-upload-dialog .holaf-utility-close-button");
    assert.ok(uploadClose, "modale d'upload : bouton fermer présent");
    assertIconSvg(uploadClose.querySelector("svg"), "x", 14, "fermeture de la modale d'upload");
    assert.ok((uploadClose.title || "").trim(),
        "modale d'upload : nom accessible AJOUTÉ (l'ancien glyphe ✖ n'en donnait aucun de fiable)");
    ok("modale d'upload : croix 14 px + title (bouton désormais nommé pour les lecteurs d'écran)");
}

/* ══ 4. Comparer distant : croix du bandeau ══════════════════════════════ */
console.log("4. holaf_remote_comparer : croix « x » du bandeau + handlers conservés");
{
    clearBody();
    const ext = registered.find((e) => e.name === "Holaf.RemoteComparer");
    assert.ok(ext, "extension Holaf.RemoteComparer enregistrée");
    await ext.setup();
    const comparer = fakeApp.holafRemoteComparer;
    assert.ok(comparer && comparer.rootElement, "comparer instancié");
    const rcClose = comparer.rootElement.querySelector(".holaf-utility-close-button");
    assert.ok(rcClose, "comparer : bouton fermer présent");
    assertIconSvg(rcClose.querySelector("svg"), "x", 14, "fermeture du comparer");
    assert.ok((rcClose.title || "").trim(), "comparer : nom accessible du bouton fermer");
    assert.strictEqual(typeof rcClose.onclick, "function", "comparer : onclick de fermeture branché");
    assert.strictEqual(typeof rcClose.onmousedown, "function",
        "comparer : onmousedown stopPropagation conservé (sinon le drag du bandeau partirait)");
    ok("comparer : croix 14 px, title + onclick + onmousedown conservés");
}

/* ══ 5. Poignée de drag : icône + comportement de drag intact ════════════ */
console.log("5. holaf_layout_tools : poignée « grip-vertical » et drag toujours fonctionnel");
{
    const { container, grip, closeBtn } = bootLayoutTools();
    assert.ok(grip && grip.querySelector("svg"), "poignée : icône SVG présente");

    assertIconSvg(grip.querySelector("svg"), "grip-vertical", 14, "poignée de drag");
    assert.strictEqual(grip.style.cursor, "grab", "poignée : curseur grab conservé");
    assert.strictEqual(grip.style.cursor === "grabbing", false, "poignée : curseur au repos = grab");
    assert.strictEqual(grip.style.userSelect, "none", "poignée : user-select none conservé (pas de sélection au drag)");
    assert.strictEqual(grip.style.touchAction, "none", "poignée : touch-action none (le geste tactile draine le drag, pas le scroll)");
    assert.ok((grip.title || "").trim(), "poignée : infobulle/nom accessible conservé");

    // DRAG RÉEL : mousedown sur la poignée → mousemove document → la barre bouge.
    const rightAvant = container.style.right;
    const bottomAvant = container.style.bottom;
    grip.dispatchEvent(new window.MouseEvent("mousedown", { clientX: 200, clientY: 200, bubbles: true }));
    assert.strictEqual(grip.style.cursor, "grabbing", "poignée : curseur grabbing PENDANT le drag");
    window.document.dispatchEvent(new window.MouseEvent("mousemove", { clientX: 170, clientY: 180, bubbles: true }));
    assert.notStrictEqual(container.style.right, rightAvant,
        "poignée : le drag déplace la barre (right) — makeDraggable toujours branché");
    assert.notStrictEqual(container.style.bottom, bottomAvant,
        "poignée : le drag déplace la barre (bottom)");
    window.document.dispatchEvent(new window.MouseEvent("mouseup", { clientX: 170, clientY: 180, bubbles: true }));
    assert.strictEqual(grip.style.cursor, "grab", "poignée : curseur restauré en grab après le drag");

    // Bouton de fermeture de la barre.
    assert.ok(closeBtn, "barre d'outils : bouton fermer présent");
    assertIconSvg(closeBtn.querySelector("svg"), "x", 14, "fermeture de la barre d'outils");
    assert.ok((closeBtn.title || "").trim(), "barre d'outils : nom accessible du bouton fermer");
    closeBtn.click();
    ok("poignée : icône grip-vertical, cursor/us/selection touch-action conservés, drag mousedown→mousemove vérifié");
}

/* ══ 6. Contrôles négatifs PAR MUTATION ══════════════════════════════════ */
console.log("6. contrôles négatifs par mutation (emoji, drag, title, périmètre)");
{
    // Nettoyage d'un éventuel résidu d'une exécution interrompue.
    for (const f of readdirSync(HERE)) {
        if (/^\.__mut2_\d+_[a-z_]+\.mjs$/.test(f)) rmSync(join(HERE, f), { force: true });
    }

    let seq = 0;
    /** Écrit un mutant de `rel` dans js/, exécute `check`, puis supprime. */
    async function mutant(rel, label, mutate, check) {
        const src = read(rel);
        const mutated = mutate(src);
        assert.notStrictEqual(mutated, src, `mutation « ${label} » sans effet (ancre introuvable)`);
        const file = join(HERE, `.__mut2_${++seq}_${rel.split("/").pop().replace(/\.js$/, "")}.mjs`);
        writeFileSync(file, mutated, "utf8");
        let failure = null;
        try {
            await check("file://" + file + "?m=" + seq);
        } catch (e) {
            failure = e;
        } finally {
            rmSync(file, { force: true });
            clearBody();
        }
        assert.ok(failure, `mutation « ${label} » NON détectée (le contrat reste vert) → contrôle négatif vacant`);
        return failure.message;
    }

    /* (a) Emoji réintroduit : la croix texte revient sur le bouton fermer. */
    const msgGlyphe = await mutant("js/holaf_layout_tools.js", "croix texte réintroduite",
        (s) => s.replace(
            'closeBtn.innerHTML = aihIconSvg("x", { size: 14 });',
            'closeBtn.textContent = "✕";'
        ),
        async (url) => {
            await import(url);
            const { closeBtn } = bootLayoutTools();
            assert.ok(closeBtn.querySelector("svg"),
                "mutant : le bouton fermer n'a plus d'icône SVG (emoji texte réintroduit)");
        }
    );
    ok(`emoji réintroduit → ROUGE (${msgGlyphe.split("\n")[0].slice(0, 70)})`);

    /* (b) Poignée de drag perdant son branchement : plus aucun mousedown. */
    const msgDrag = await mutant("js/holaf_layout_tools.js", "drag débranché de la poignée",
        (s) => s.replace("            this.enableWindowDragging(grip);\n", ""),
        async (url) => {
            await import(url);
            const { container, grip } = bootLayoutTools();
            const rightAvant = container.style.right;
            grip.dispatchEvent(new window.MouseEvent("mousedown", { clientX: 200, clientY: 200, bubbles: true }));
            window.document.dispatchEvent(new window.MouseEvent("mousemove", { clientX: 150, clientY: 150, bubbles: true }));
            window.document.dispatchEvent(new window.MouseEvent("mouseup", { clientX: 150, clientY: 150, bubbles: true }));
            assert.notStrictEqual(container.style.right, rightAvant,
                "mutant : la poignée ne déplace plus la barre (drag débranché)");
        }
    );
    ok(`poignée sans drag → ROUGE (${msgDrag.split("\n")[0].slice(0, 70)})`);

    /* (c) Bouton fermer perdant son nom accessible (`title` retiré). */
    const msgTitle = await mutant("js/holaf_panel_manager.js", "title du bouton fermer retiré",
        (s) => s.replace('closeButton.title = t("dialog.close");', ""),
        async (url) => {
            const mod = await import(url);
            const { panelEl } = mod.HolafPanelManager.createPanel({ id: "mut-panel", title: "M" });
            const btn = panelEl.querySelector(".holaf-utility-close-button");
            assert.ok((btn.title || "").trim(),
                "mutant : bouton fermer sans nom accessible (title absent)");
        }
    );
    ok(`bouton fermer sans title → ROUGE (${msgTitle.split("\n")[0].slice(0, 70)})`);

    /* (d) Aire d'alerte perdant son typage (classe de type) : la couleur de
          l'hôte ne s'appliquerait plus. */
    const msgType = await mutant("js/aih_dialog.js", "classe de type d'alerte retirée",
        (s) => s.replace("aih-dialog-icon-' + escapeHtml(type) + '\"", "' + '\""),
        async (url) => {
            await import(url);
            const p = window.AIH.alert("T", "M", "error");
            const div = window.document.querySelector(".aih-dialog-icon");
            assert.ok(div.className.split(/\s+/).includes("aih-dialog-icon-error"),
                "mutant : classe de type d'alerte perdue (plus de couleur par type)");
            window.document.querySelector("[data-aih-ok]").click();
            await p;
        }
    );
    ok(`classe de type d'alerte perdue → ROUGE (${msgType.split("\n")[0].slice(0, 70)})`);

    /* (e) Consommation dans un fichier INTERDIT (blobby_companion, ici simulé
           par un fichier hors liste blanche) : la garde de périmètre mord. */
    {
        const probe = join(HERE, ".__mut2_forbidden_consumer.js");
        writeFileSync(probe,
            '// mutant : consommation interdite (équivalent blobby_companion)\n' +
            'import { aihIconSvg } from "./aih_icons.js";\n' +
            'export const x = aihIconSvg("info");\n', "utf8");
        let caught = null;
        try {
            const r = checkIconPerimetre(PACKAGE_DIR);
            assert.deepStrictEqual(r.horsListe, [], "consommateur hors périmètre : " + r.horsListe.join(", "));
        } catch (e) {
            caught = e;
        } finally {
            rmSync(probe, { force: true });
        }
        assert.ok(caught, "consommation dans un fichier interdit NON détectée → garde vacante");
        assert.ok(/forbidden_consumer/.test(caught.message), "le rouge doit nommer le fichier fautif");
        ok(`consommation dans un fichier interdit → ROUGE (${caught.message.split("\n")[0].slice(0, 70)})`);
    }

    // Aucun mutant résiduel.
    assert.deepStrictEqual(
        readdirSync(HERE).filter((f) => f.startsWith(".__mut2_")), [],
        "aucun mutant ne doit rester sur le disque"
    );
    // Les fichiers du lot n'ont pas bougé.
    for (const rel of PHASE_2A_CONSUMERS) {
        assert.ok(read(rel).includes("aihIconSvg"), `${rel} : la façade est toujours appelée après les mutants`);
    }
    ok("fichiers du lot intacts, aucun mutant résiduel");
}

console.log(`\n✅ test_aih_icons_phase2a : ${n} groupes PASSENT`);
process.exit(0);
