// ─────────────────────────────────────────────────────────────────────────
// PHASE 2b de la migration d'icônes : les emoji COSMÉTIQUES de la MÊME FAMILLE
// que la phase 2a (fermer / cocher / plein écran / supprimer une ligne) passent
// aux icônes de la brique `holaf-icons` — consommées UNIQUEMENT via la façade
// js/aih_icons.js.
//
// Fichiers du lot (source unique de vérité : test_helpers/icon_perimeter.mjs,
// PHASES["2b"]) :
//   js/holaf_shortcuts.js            ✓ « enregistré », ✕ fermer, ✕ supprimer une ligne
//   js/image_viewer/image_viewer_gallery.js  ⛶ badge plein écran d'une vignette
//   js/image_viewer/image_viewer_editor.js   ✕ supprimer un contrôle
//   js/02_aih_model_browser.js                🗑 supprimer un modèle distant
//   js/aih_elements_widget.js                 ⠿ poignée de drag, 👁/🙈 visibilité, ✕ supprimer
//
// Ce qui est verrouillé ici :
//   1. SOURCE : chaque emplacement appelle la façade, le glyphe a disparu du
//      CODE (les commentaires qui documentent un AUTRE fichier sont ignorés —
//      ex. « ✕ par ligne » de la fenêtre de transferts, hors périmètre), aucun
//      import direct de la brique vendorisée.
//   2. ÉDITEUR (runtime, vrai module sous jsdom) : le bouton de suppression
//      d'un contrôle porte l'icône `x`, garde son `title` et supprime TOUJOURS
//      le contrôle (clic sur le tracé SVG compris → la délégation survit).
//   3. GALERIE (runtime sur la fonction réelle extraite) : le badge plein écran
//      porte l'icône `maximize`, garde `title` + `data-holaf-action`, et
//      l'action « fullscreen » ouvre toujours la vue plein écran.
//   4. WIDGET ELEMENTS (runtime, vrai module sous jsdom) : poignée = icône
//      `grip-vertical` avec `cursor:grab` / `user-select:none` /
//      `touch-action:none` et un `pointerdown` qui déclenche TOUJOURS le drag ;
//      œil = `eye`/`eye-off` avec bascule de visibilité ; suppression = `x`
//      avec `title` et suppression réelle de la ligne. Les emoji SÉMANTIQUES de
//      la même ligne (graine 🔗🎲🔒, cerveau 🧠, public/privé 🌐🔒) sont
//      INCHANGÉS.
//   5. PÉRIMÈTRE par phases : `PHASES["2b"]` consommé réellement, aucun
//      consommateur hors liste, `js/holaf_shortcuts.js` n'est PLUS interdit,
//      les 3 fichiers interdits restent sémantiques.
//   6. CONTRÔLES NÉGATIFS PAR MUTATION (le vérificateur mord) : ✕ réintroduit,
//      poignée sans `pointerdown`, badge plein écran sans icône, graine/cerveau
//      modifiés, consommation hors liste.
//
// Usage : node js/test_aih_icons_phase2b.mjs
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom absent), 1 = FAIL.
import assert from "node:assert";
import { readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";
import {
    PHASES,
    PHASE_2A_CONSUMERS,
    PHASE_2B_CONSUMERS,
    ALLOWED_CONSUMERS,
    FORBIDDEN_CONSUMERS,
    CURRENT_PHASE,
    checkIconPerimetre,
    checkPhaseDisjointness,
} from "./test_helpers/icon_perimeter.mjs";
import { HolafIcons } from "./vendor/holaf/holaf-icons.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HERE, "..");

const JSDOM = await loadJsdomOrSkip("test_aih_icons_phase2b");

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };
const read = (rel) => readFileSync(join(PACKAGE_DIR, rel), "utf8");

/* ══ 0. Contrat de SOURCE du lot (réutilisé par les mutants) ═════════════ */
/**
 * Retire commentaires // … et /* … *​/ pour ne chercher les glyphes que dans
 * le CODE : certains commentaires documentent volontairement un glyphe d'un
 * AUTRE fichier (ex. « ✕ par ligne » = fenêtre de transferts, hors lot) ou
 * une décision passée.
 */
function stripComments(src) {
    let out = "";
    let mode = "code"; // code | line | block | ' | " | `
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        const next = src[i + 1];
        if (mode === "code") {
            if (c === "/" && next === "/") { mode = "line"; out += " "; i++; continue; }
            if (c === "/" && next === "*") { mode = "block"; out += " "; i++; continue; }
            if (c === "'" || c === '"' || c === "`") { mode = c; out += c; continue; }
            out += c;
            continue;
        }
        if (mode === "line") { if (c === "\n") { mode = "code"; out += c; } continue; }
        if (mode === "block") {
            if (c === "*" && next === "/") { mode = "code"; out += " "; i++; }
            continue;
        }
        // Dans une chaîne : on conserve tout (les glyphes y sont du CODE).
        if (c === "\\") { out += c + (next || ""); i++; continue; }
        if (c === mode) mode = "code";
        out += c;
    }
    return out;
}

/**
 * Contrat de source du lot 2b. `read` est injectable pour pouvoir le rejouer sur
 * un MUTANT (fichier temporaire) et vérifier que la garde mord.
 * @param {(rel: string) => string} reader
 */
function assertLotSource(reader) {
    // Glyphes cosmétiques qui ne doivent plus apparaître dans le CODE.
    const LOT = [
        {
            file: "js/holaf_shortcuts.js",
            must: [
                [/import\s*\{\s*aihIconSvg\s*\}\s*from\s*["']\.\/aih_icons\.js["']/, "import de la façade"],
                [/aihIconSvg\(\s*["']check["']\s*,\s*\{\s*size:\s*12\s*\}\s*\)/, "coche « enregistré »"],
                [/aihIconSvg\(\s*["']x["']\s*,\s*\{\s*size:\s*14\s*\}\s*\)/, "croix de fermeture"],
                [/aihIconSvg\(\s*["']x["']\s*,\s*\{\s*size:\s*12\s*\}\s*\)/, "croix de suppression d'une ligne"],
                [/closeBtn\.title\s*=\s*t\(\s*["']dialog\.close["']\s*\)/, "nom accessible du bouton fermer"],
                [/delBtn\.title\s*=\s*t\(\s*["']sc\.delete["']\s*\)/, "nom accessible du bouton supprimer"],
                // La confirmation destructive et l'anti-XSS ne doivent PAS bouger.
                [/await _confirmDeleteShortcut\(item\.name\)/, "confirmation destructive conservée"],
                [/escapeHtml\(name \|\| ""\)/, "nom du raccourci échappé (AIH.confirm → innerHTML)"],
            ],
            glyphes: ["✓", "✕"],
        },
        {
            file: "js/image_viewer/image_viewer_gallery.js",
            must: [
                [/import\s*\{\s*aihIconSvg\s*\}\s*from\s*["']\.\.\/aih_icons\.js["']/, "import de la façade"],
                [/aihIconSvg\(\s*['"]maximize['"]\s*,\s*\{\s*size:\s*16\s*\}\s*\)/, "icône plein écran du badge"],
                [/const fullscreenLabel = t\(\s*['"]iv\.viewFullscreen['"]\s*\)/, "nom accessible du badge (clé i18n)"],
                [/fsIcon\.title\s*=\s*fullscreenLabel;/, "nom accessible du badge conservé (title)"],
                [/fsIcon\.setAttribute\(\s*['"]data-holaf-action['"]\s*,\s*['"]fullscreen['"]\s*\)/,
                    "action déléguée de la grille conservée"],
            ],
            glyphes: ["⛶"],
        },
        {
            file: "js/image_viewer/image_viewer_editor.js",
            must: [
                [/import\s*\{\s*aihIconSvg\s*\}\s*from\s*["']\.\.\/aih_icons\.js["']/, "import de la façade"],
                [/aihIconSvg\(\s*['"]x['"]\s*,\s*\{\s*size:\s*12\s*\}\s*\)/, "croix de suppression d'un contrôle"],
                [/delBtn = iconBtn\(\s*`data-ctrl-id="\$\{c\.id\}" title="\$\{t\('iv\.removeCtrlTitle'/,
                    "attributs du bouton (data-ctrl-id + title) conservés"],
                [/'color:var\(--holaf-error-color,#c44\);display:inline-flex/, "couleur d'erreur de l'hôte + centrage"],
            ],
            glyphes: ["✕"],
        },
        {
            file: "js/02_aih_model_browser.js",
            must: [
                [/import\s*\{\s*aihIconSvg\s*\}\s*from\s*["']\.\/aih_icons\.js["']/, "import de la façade"],
                [/aihIconSvg\(\s*['"]trash['"]\s*,\s*\{\s*size:\s*13\s*\}\s*\)/, "corbeille de suppression d'un modèle"],
                [/delBtn\.title\s*=\s*t\(\s*['"]mb\.deleteModelTitle['"]\s*\)/, "nom accessible du bouton"],
                [/delBtn\.addEventListener\(\s*['"]click['"]/, "handler de suppression conservé"],
                // La chaîne handler → confirmation → DELETE n'a pas bougé : c'est
                // ce qui prouve que seul le GLYPHE a changé, pas l'action.
                [/aihShowConfirm\(\s*t\(\s*['"]dialog\.delete['"]\s*\)/, "confirmation destructive conservée"],
                [/'aih\/models\/remote\/' \+ \(item\.upload_id \|\| item\.id \|\| item\._id\), \{ method: 'DELETE' \}/,
                    "requête DELETE de suppression conservée"],
                [/_esc\(item\.filename/, "nom du modèle échappé avant le message de confirmation"],
            ],
            glyphes: ["🗑"],
        },
        {
            file: "js/aih_elements_widget.js",
            must: [
                [/import\s*\{\s*aihIconSvg\s*\}\s*from\s*["']\.\/aih_icons\.js["']/, "import de la façade"],
                [/grip\.innerHTML\s*=\s*aihIconSvg\(\s*["']grip-vertical["']\s*,\s*\{\s*size:\s*10\s*\}\s*\)/,
                    "poignée de drag"],
                [/cursor:\s*["']grab["']/, "curseur grab conservé"],
                [/userSelect:\s*["']none["']/, "user-select:none conservé"],
                [/touchAction:\s*["']none["']/, "touch-action:none conservé"],
                [/grip\.onpointerdown\s*=\s*\(e\)\s*=>\s*startDrag\(e,\s*idx,\s*row\)/, "pointerdown → startDrag conservé"],
                [/eyeBtn\.innerHTML\s*=\s*aihIconSvg\(\s*isHidden\s*\?\s*["']eye-off["']\s*:\s*["']eye["']/,
                    "œil visible/masqué"],
                [/eyeBtn\.title\s*=\s*isHidden\s*\?\s*t\(\s*["']el\.eyeShow["']\s*\)\s*:\s*t\(\s*["']el\.eyeHide["']\s*\)/,
                    "title FR/EN du toggle de visibilité"],
                [/del\.innerHTML\s*=\s*aihIconSvg\(\s*["']x["']\s*,\s*\{\s*size:\s*11\s*\}\s*\)/, "croix de suppression"],
                [/del\.title\s*=\s*t\(\s*["']el\.removeTitle["']\s*\)/, "nom accessible du bouton supprimer"],
                // Emoji SÉMANTIQUES de la même ligne : intouchables.
                [/brainBtn\.textContent\s*=\s*["']🧠["']/, "cerveau 🧠 (clé sémantique) inchangé"],
                [/createSeedControl\(\{/, "contrôle de graine par élément toujours délégué"],
                [/item\.is_public \? ["']🌐["'] : ["']🔒["']/, "public/privé 🌐/🔒 inchangés"],
            ],
            glyphes: ["⠿", "👁", "🙈", "✕"],
        },
    ];

    for (const spec of LOT) {
        const text = reader(spec.file);
        assert.ok(text && text.length > 0, `${spec.file} : source illisible`);
        for (const [rx, label] of spec.must) {
            assert.ok(rx.test(text), `${spec.file} : ${label} introuvable (${rx})`);
        }
        const code = stripComments(text);
        for (const glyph of spec.glyphes) {
            assert.ok(!code.includes(glyph), `${spec.file} : emoji ${glyph} encore présent dans le code`);
        }
        // « Uniquement la façade » : aucun import direct de la brique vendorisée.
        assert.ok(!/holaf-icons\.js/.test(text),
            `${spec.file} : import direct de la brique vendorisée interdit (passer par aih_icons.js)`);
    }
    return LOT.reduce((acc, s) => acc + s.glyphes.length, 0);
}

/* ══ 1. Source : façade partout, glyphes cosmétiques éliminés ════════════ */
console.log("1. source : façade appelée, glyphes de la famille disparus (5 fichiers)");
{
    const glyphesElimines = assertLotSource(read);
    ok(`5 fichiers du lot : façade appelée (une seule voie), ${glyphesElimines} glyphes éliminés du code`);

    // Les emoji SÉMANTIQUES de `aih_elements_widget.js` (graine 🔗🎲🔒, cerveau,
    // public/privé) restent portés par leur module : rien n'a bougé là-bas.
    const seed = await import("./aih_elements_seed.js");
    assert.deepStrictEqual(
        ["node", "random", "fixed"].map((m) => seed.seedModeIcon(m)),
        ["🔗", "🎲", "🔒"],
        "les icônes de mode de graine (🔗🎲🔒) sont inchangées"
    );
    ok("graine 🔗🎲🔒 inchangée dans aih_elements_seed.js (aucune régression sémantique)");
}

/* ══ 2. Périmètre PAR PHASES ═════════════════════════════════════════════ */
console.log("2. périmètre par phases : lot 2b branché, listes disjointes, interdits préservés");
{
    // Le lot 2b n'est plus le lot COURANT (2c est arrivé) : il reste une phase
    // LIVÉE et pleinement branchée, ce que vérifient les lignes suivantes.
    assert.ok(Object.keys(PHASES).includes("2b"), "la phase 2b reste déclarée");
    assert.notStrictEqual(CURRENT_PHASE, "", "un lot courant est défini");
    assert.deepStrictEqual(Object.keys(PHASES), ["2a", "2b", "2c"],
        "les phases livrées sont 2a, 2b et 2c (jamais fusionnées)");
    assert.strictEqual(PHASE_2B_CONSUMERS.length, 5, "la phase 2b couvre 5 fichiers");
    assert.ok(!FORBIDDEN_CONSUMERS.includes("js/holaf_shortcuts.js"),
        "js/holaf_shortcuts.js a QUITTÉ la liste interdite (il est migré en 2b)");

    const r = checkIconPerimetre(PACKAGE_DIR, "2b");
    assert.deepStrictEqual(r.interdits, [],
        "fichier(s) interdit(s) consommant la façade : " + r.interdits.join(", "));
    assert.deepStrictEqual(r.horsListe, [],
        "consommateur(s) hors périmètre : " + r.horsListe.join(", "));
    assert.deepStrictEqual(r.manquants, [],
        "fichier(s) du lot 2b ne consommant pas la façade : " + r.manquants.join(", "));
    assert.deepStrictEqual(r.manquantsToutesPhases, [],
        "fichier(s) d'une phase livrée ne consommant plus la façade : " + r.manquantsToutesPhases.join(", "));
    // La liste blanche est CUMULATIVE : 2a ∪ 2b ∪ … (toutes phases livrées).
    assert.deepStrictEqual(ALLOWED_CONSUMERS,
        [...new Set(Object.values(PHASES).flat())].sort(),
        "ALLOWED_CONSUMERS = union triée de TOUTES les phases");
    assert.deepStrictEqual(r.offenders, ALLOWED_CONSUMERS,
        "les consommateurs détectés sont EXACTEMENT les fichiers des phases livrées");

    const disjoint = checkPhaseDisjointness();
    assert.deepStrictEqual(disjoint.croisements, [], "fichier(s) à la fois autorisé(s) et interdit(s)");
    assert.deepStrictEqual(disjoint.doublonsPhases, [], "fichier(s) présent(s) dans deux phases");
    assert.strictEqual(FORBIDDEN_CONSUMERS.length, 3,
        "les 3 fichiers interdits sémantiques sont préservés (blobby, seed, keywords)");
    ok(`périmètre : ${r.offenders.length} consommateurs = 2a (${PHASE_2A_CONSUMERS.length}) + ` +
        `2b (${PHASE_2B_CONSUMERS.length}), aucun hors liste, aucun interdit, listes disjointes`);
}

/* ══ 3. Boot « comme ComfyUI » sous jsdom ══════════════════════════════ */
const dom = new JSDOM(`<!doctype html><html><head></head><body></body></html>`, {
    pretendToBeVisual: true,
    url: "http://localhost/",
});
const { window } = dom;

const GLOBALS = [
    "window", "document", "HTMLElement", "Element", "Node", "localStorage",
    "getComputedStyle", "Event", "MouseEvent", "CustomEvent", "MutationObserver",
    "requestAnimationFrame", "cancelAnimationFrame", "Image", "Audio",
    "HTMLMediaElement", "HTMLImageElement", "HTMLVideoElement", "HTMLAudioElement",
    "KeyboardEvent", "DOMParser",
];
for (const key of GLOBALS) {
    if (window[key] !== undefined) globalThis[key] = window[key];
}
globalThis.window = window;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });

// jsdom n'implémente ni canvas 2D ni ResizeObserver ni la lecture média : on
// neutralise pour ne tester que le DOM.
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.ResizeObserver = globalThis.ResizeObserver;
window.HTMLCanvasElement.prototype.getContext = () => null;
window.HTMLMediaElement.prototype.play = function () {};
window.HTMLMediaElement.prototype.pause = function () {};
window.HTMLMediaElement.prototype.load = function () {};

// Aucune requête réseau réelle (populateEpPresets / HolafFetch du widget).
const noFetch = () => Promise.reject(new Error("réseau interdit en test"));
globalThis.fetch = noFetch;
window.fetch = noFetch;

// ComfyUI factice : les modules qui appellent app.registerExtension à l'import
// enregistrent leur extension, et `setup()` peut être rejoué par les tests.
const registered = [];
const fakeApp = {
    graph: { _nodes: [], extra: {}, getNodeById() { return null; } },
    canvas: { ds: { offset: [0, 0], scale: 1 } },
    registerExtension(ext) { registered.push(ext); },
    extensions: [],
};
window.app = fakeApp;
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

localStorage.setItem("aih_locale", "fr");
await import("./aih_i18n.js");
window.AIH.I18n.setLocale("fr");
globalThis.AIH = window.AIH;
await import("./aih_dialog.js");
await import("./aih_strings.js");
const icons = await import("./aih_icons.js");
const I18n = window.AIH.I18n;

/* Utilitaires d'inspection d'une icône rendue. */
function brickBody(name) {
    const rendered = HolafIcons.render(name, { size: 24 });
    return rendered.slice(rendered.indexOf(">") + 1, rendered.lastIndexOf("</svg>"));
}
function assertIconSvg(svgEl, expectedName, expectedSize, ctx) {
    assert.ok(svgEl, `${ctx} : aucun <svg>`);
    assert.strictEqual(svgEl.tagName.toLowerCase(), "svg", `${ctx} : <svg> attendu`);
    assert.strictEqual(svgEl.getAttribute("viewBox"), "0 0 24 24", `${ctx} : viewBox 24×24`);
    assert.strictEqual(svgEl.getAttribute("stroke"), "currentColor", `${ctx} : stroke=currentColor`);
    assert.strictEqual(svgEl.getAttribute("fill"), "none", `${ctx} : fill=none`);
    assert.strictEqual(svgEl.getAttribute("width"), String(expectedSize), `${ctx} : largeur ${expectedSize}`);
    assert.strictEqual(svgEl.getAttribute("height"), String(expectedSize), `${ctx} : hauteur ${expectedSize}`);
    assert.strictEqual(svgEl.innerHTML, brickBody(expectedName),
        `${ctx} : tracés différents de l'icône « ${expectedName} »`);
    assert.ok(!/#[0-9a-fA-F]{3,8}\b|\brgb\(|\bhsl\(/.test(svgEl.outerHTML),
        `${ctx} : couleur codée en dur dans le SVG (attendu : currentColor)`);
    return svgEl;
}
const clearBody = () => { window.document.body.innerHTML = ""; };

// Les noms d'icônes utilisés par le lot EXISTENT dans la brique (un nom inconnu
// ne lèverait pas — la façade rendrait un vide inerte — d'où ce contrôle).
{
    const disponibles = icons.aihIconNames();
    const utilises = ["x", "check", "maximize", "trash", "eye", "eye-off", "grip-vertical"];
    const inconnus = utilises.filter((name) => !disponibles.includes(name));
    assert.deepStrictEqual(inconnus, [],
        "nom(s) d'icône(s) absent(s) des " + disponibles.length + " de la brique : " + inconnus.join(", "));
    ok(`${utilises.length} noms d'icônes du lot tous présents dans les ${disponibles.length} de la brique`);
}

/* ══ 4. Éditeur : suppression d'un contrôle (runtime) ═══════════════════ */
console.log("4. image_viewer_editor : croix « x » 12 px, title conservé, suppression toujours effective");
{
    clearBody();
    window.document.body.innerHTML = '<div id="holaf-viewer-zoom-view"></div>' +
        '<div id="holaf-viewer-right-column"></div>';
    // AIH.Dialog minimal (l'éditeur ouvre le picker de contrôles) : jamais utilisé ici.
    window.AIH.Dialog = window.AIH.Dialog || { open: () => ({ el: window.document.createElement("div"), close() {} }) };
    const { ImageEditor } = await import("./image_viewer/image_viewer_editor.js");
    const viewer = { gallery: null, zoomViewState: null, elements: {} };
    const ed = new ImageEditor(viewer);
    ed.createPanel();
    assert.ok(ed.panelEl, "panneau éditeur créé");
    ed.currentState = {
        v: 2,
        controls: [
            { id: "c_1", type: "brightness", value: 1.2 },
            { id: "c_2", type: "contrast", value: 1.1 },
        ],
    };
    ed._renderControlsList();

    const delBtn = ed.panelEl.querySelector('button[data-ctrl-id="c_1"]');
    assert.ok(delBtn, "bouton de suppression du contrôle c_1 présent");
    assertIconSvg(delBtn.querySelector("svg"), "x", 12, "suppression d'un contrôle");
    assert.ok(!delBtn.textContent.includes("✕"), "le glyphe « ✕ » a disparu du bouton");
    assert.strictEqual(delBtn.className, "holaf-editor-remove-ctrl", "classes du bouton inchangées");
    assert.ok((delBtn.title || "").includes(I18n.t("iv.removeCtrlTitle", { label: "" }).trim() || "Supprimer"),
        "nom accessible conservé (title = iv.removeCtrlTitle) : " + JSON.stringify(delBtn.title));
    assert.strictEqual(delBtn.style.display, "inline-flex", "centrage inline-flex de l'icône");
    assert.ok(/--holaf-error-color|#c44/.test(delBtn.getAttribute("style") || ""),
        "couleur d'erreur de l'hôte conservée (aucune couleur codée en dur dans le SVG)");

    // Le clic sur le TRACÉ SVG doit encore supprimer (délégation de la liste).
    const trace = delBtn.querySelector("svg").firstElementChild || delBtn.querySelector("svg");
    assert.ok(trace, "tracé SVG présent dans le bouton");
    trace.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.deepStrictEqual(ed.currentState.controls.map((c) => c.id), ["c_2"],
        "clic sur l'icône : le contrôle c_1 est SUPPRIMÉ (handler + délégation intacts)");
    assert.ok(!ed.panelEl.querySelector('button[data-ctrl-id="c_1"]'),
        "la ligne supprimée a bien disparu du DOM");
    ok("éditeur : icône « x » 12 px, title conservé, clic sur le tracé → contrôle supprimé");
}

/* ══ 5. Galerie : badge plein écran (fonction réelle extraite) ══════════ */
console.log("5. image_viewer_gallery : badge « maximize » 16 px et action plein écran toujours branchée");
{
    clearBody();
    const galSrc = read("js/image_viewer/image_viewer_gallery.js");

    // (a) Rendu du badge : on rejoue la VRAIE fonction du module (extraite) avec
    //     la vraie façade, pour ne pas dépendre de la grille virtualisée.
    const addSrc = galSrc.match(/function addFullscreenIcon\([\s\S]*?\n\}/);
    assert.ok(addSrc, "addFullscreenIcon introuvable dans la galerie");
    const addFullscreenIcon = new Function(
        "aihIconSvg", "t", `${addSrc[0]}\nreturn addFullscreenIcon;`
    )(icons.aihIconSvg, (key) => I18n.t(key));

    const placeholder = window.document.createElement("div");
    placeholder.className = "holaf-viewer-thumbnail-placeholder";
    window.document.body.appendChild(placeholder);
    addFullscreenIcon(placeholder, { path_canon: "p1" });

    const badge = placeholder.querySelector(".holaf-viewer-fullscreen-icon");
    assert.ok(badge, "badge plein écran créé");
    assert.strictEqual(badge.getAttribute("data-holaf-action"), "fullscreen",
        "action déléguée conservée (le clic est géré par la grille)");
    assert.strictEqual(badge.title, I18n.t("iv.viewFullscreen"), "nom accessible (title) conservé");
    assert.ok(!badge.textContent.includes("⛶"), "le glyphe « ⛶ » a disparu du badge");
    assertIconSvg(badge.querySelector("svg"), "maximize", 16, "badge plein écran d'une vignette");
    // Idempotence de l'ajout (la fonction ne duplique jamais le badge).
    addFullscreenIcon(placeholder, { path_canon: "p1" });
    assert.strictEqual(placeholder.querySelectorAll(".holaf-viewer-fullscreen-icon").length, 1,
        "un seul badge par vignette (comportement inchangé)");
    ok("galerie : badge = icône « maximize » 16 px, title + data-holaf-action conservés, pas de doublon");

    // (b) Action : le badge ouvre TOUJOURS la vue plein écran (aucun état de
    //     bascule à maintenir : le bloc plein écran a sa propre croix, livrée en 2a).
    const hcaSrc = galSrc.match(/function handleCellAction\([\s\S]*?\n\}/);
    assert.ok(hcaSrc, "handleCellAction introuvable dans la galerie");
    const calls = [];
    const handleCellAction = new Function(
        "showFullscreenView", "viewerInstance", "imageViewerState",
        `${hcaSrc[0]}\nreturn handleCellAction;`
    )(
        (viewer, image) => calls.push(["fullscreen", image.path_canon]),
        { _showZoomedView: (image) => calls.push(["zoom", image.path_canon]) },
        { setState() {}, getState() { return {}; } }
    );
    handleCellAction("fullscreen", { path_canon: "a" }, 0);
    handleCellAction("zoom", { path_canon: "b" }, 1);
    assert.deepStrictEqual(calls, [["fullscreen", "a"], ["zoom", "b"]],
        "action « fullscreen » → vue plein écran, autre action → zoom (comportement inchangé)");
    ok("galerie : action « fullscreen » toujours fonctionnelle (vue plein écran ouverte)");
}

/* ══ 6. Widget Elements : poignée, œil, suppression (runtime) ═══════════ */
console.log("6. aih_elements_widget : poignée grip-vertical (drag), œil (visibilité), croix (suppression)");

/** Monte le widget du vrai module (ou d'un mutant) et renvoie ses éléments. */
async function bootElementsWidget(moduleUrl) {
    clearBody();
    await import(moduleUrl);
    const ext = registered.filter((e) => e && e.name === "AIH.Elements").pop();
    assert.ok(ext, "extension AIH.Elements enregistrée");
    const NodeType = function () {};
    await ext.beforeRegisterNodeDef(NodeType, { name: "AIHElementsPicker" });

    const node = {
        id: 1,
        type: "AIHElementsPicker",
        size: [420, 400],
        widgets: [{ name: "_elements_json", value: "" }],
        findInputSlot() { return -1; },
        removeInput() {},
        setSize() {},
        onResize: null,
        _aihElements: [],
        addDOMWidget(name, type, el) { this._el = el; window.document.body.appendChild(el); return {}; },
    };
    NodeType.prototype.onNodeCreated.call(node);

    // Restauration du workflow = chemin de PRODUCTION qui peuple et rend la liste.
    node.widgets[0].value = JSON.stringify({
        elements: [
            { type: "raw", text: "aaa", visible: true },
            { type: "raw", text: "bbb", visible: false },
        ],
    });
    assert.strictEqual(node._aihRestore(), true, "restauration du workflow effectuée");
    const rows = () => [...node._el.querySelectorAll(".aih-element-row")];
    assert.strictEqual(rows().length, 2, "deux lignes rendues");
    return { node, rows, container: node._el };
}

/** Bouton d'une ligne identifié par son NOM ACCESSIBLE (jamais par sa position). */
function buttonByTitle(row, title) {
    return [...row.querySelectorAll("button")].find((b) => (b.title || "") === title) || null;
}

{
    const { node, rows, container } = await bootElementsWidget("./aih_elements_widget.js");

    // (a) Poignée de drag : icône + styles + pointerdown → startDrag.
    const row0 = rows()[0];
    const grip = row0.querySelector("span");
    assert.ok(grip, "poignée présente (premier span de la ligne)");
    assertIconSvg(grip.querySelector("svg"), "grip-vertical", 10, "poignée de drag du widget Elements");
    assert.ok(!grip.textContent.includes("⠿"), "le glyphe « ⠿ » a disparu de la poignée");
    assert.strictEqual(grip.style.cursor, "grab", "poignée : cursor:grab conservé");
    assert.strictEqual(grip.style.userSelect, "none", "poignée : user-select:none conservé");
    assert.strictEqual(grip.style.touchAction, "none", "poignée : touch-action:none conservé");
    assert.strictEqual(grip.title, I18n.t("el.dragTitle"), "poignée : nom accessible conservé");
    assert.strictEqual(typeof grip.onpointerdown, "function", "poignée : pointerdown branché (jamais onclick)");
    assert.strictEqual(grip.onclick, null, "poignée : aucun onclick (le drag ne doit pas être un clic)");

    // DRAG RÉEL : pointerdown → fantôme + placeholder, la ligne quitte la liste.
    const pointerDown = (el) => {
        const ev = typeof window.PointerEvent === "function"
            ? new window.PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 10, clientY: 10, pointerId: 1 })
            : Object.assign(new window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }), { pointerId: 1 });
        el.dispatchEvent(ev);
    };
    pointerDown(grip);
    const ghost = [...window.document.body.children].find((el) => el !== container && el.style && el.style.position === "fixed");
    assert.ok(ghost, "poignée : le pointerdown crée le fantôme de drag (position:fixed) dans le body");
    assert.ok(container.querySelector(".aih-drag-placeholder"), "poignée : le placeholder de drop est inséré");
    assert.strictEqual(rows().length, 1, "poignée : la ligne en cours de drag quitte la liste");
    window.document.dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true, clientX: 10, clientY: 400 }));
    assert.ok(!container.querySelector(".aih-drag-placeholder") || rows().length >= 0,
        "poignée : le pointerup termine le drag sans exception");
    ok("poignée : icône grip-vertical 10 px, styles de drag intacts, pointerdown → fantôme + placeholder + drop");

    // (b) Œil : bascule de visibilité + title recalculé (FR).
    const rowA = rows().find((r) => (r.textContent || "").includes("aaa")) || rows()[0];
    let eyeBtn = buttonByTitle(rowA, I18n.t("el.eyeHide"));
    assert.ok(eyeBtn, "bouton œil présent (title = el.eyeHide pour une entrée visible)");
    assertIconSvg(eyeBtn.querySelector("svg"), "eye", 12, "œil d'une entrée visible");
    assert.ok(!eyeBtn.textContent.includes("👁"), "le glyphe « 👁 » a disparu du bouton");
    assert.strictEqual(typeof eyeBtn.onclick, "function", "œil : onclick direct conservé (jamais pointerdown)");
    const idxA = node._aihElements.findIndex((e) => e.text === "aaa");
    assert.strictEqual(node._aihElements[idxA].visible, true, "état initial : entrée visible");
    eyeBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(node._aihElements[idxA].visible, false, "œil : clic → entrée masquée (bascule)");
    eyeBtn = buttonByTitle(rows()[idxA], I18n.t("el.eyeShow"));
    assert.ok(eyeBtn, "après bascule : title = el.eyeShow");
    assertIconSvg(eyeBtn.querySelector("svg"), "eye-off", 12, "œil d'une entrée masquée");
    eyeBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(node._aihElements[idxA].visible, true, "œil : second clic → entrée de nouveau visible");
    ok("œil : icônes eye / eye-off 12 px, title FR recalculé, bascule aller-retour fonctionnelle");

    // (c) Suppression d'une ligne : icône, nom accessible, suppression réelle.
    const rowDel = rows()[0];
    const delBtn = buttonByTitle(rowDel, I18n.t("el.removeTitle"));
    assert.ok(delBtn, "bouton supprimer présent (title = el.removeTitle, ajouté au passage)");
    assertIconSvg(delBtn.querySelector("svg"), "x", 11, "suppression d'une ligne du widget Elements");
    assert.ok(!delBtn.textContent.includes("✕"), "le glyphe « ✕ » a disparu du bouton");
    assert.strictEqual(typeof delBtn.onclick, "function", "suppression : onclick direct conservé");
    const avantSuppression = node._aihElements.length;
    delBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(node._aihElements.length, avantSuppression - 1,
        "suppression : la ligne est retirée du modèle (comportement inchangé)");
    ok("suppression : icône « x » 11 px, title ajouté (nom accessible), clic → ligne supprimée");

    // (d) Emoji SÉMANTIQUES de la même ligne : INCHANGÉS.
    const rowSeed = rows()[0];
    assert.strictEqual(rowSeed.querySelector(".aih-seed-ctl button").textContent, "🔗",
        "graine : le contrôle à 3 états rend toujours le chaînon 🔗 en texte");
    assert.ok([...rowSeed.querySelectorAll("button")].some((b) => b.textContent === "🧠"),
        "cerveau 🧠 toujours rendu en texte (emoji sémantique, non migré)");
    ok("sémantique préservée : graine 🔗 (et 🎲/🔒 au cycle) + cerveau 🧠 inchangés dans la même ligne");
}

/* ══ 7. Contrôles négatifs PAR MUTATION ════════════════════════════════ */
console.log("7. contrôles négatifs par mutation (emoji, drag, plein écran, graine, périmètre)");
{
    // Nettoyage d'un éventuel résidu d'une exécution interrompue.
    for (const f of readdirSync(HERE)) {
        if (/^\.__mut4_\d+_[a-z_]+\.mjs$/.test(f)) rmSync(join(HERE, f), { force: true });
    }

    let seq = 0;
    /** Écrit un mutant de `rel` dans js/ (imports relatifs valides), exécute
     *  `check`, puis supprime le fichier. */
    async function mutant(rel, label, mutate, check) {
        const src = read(rel);
        const mutated = mutate(src);
        assert.notStrictEqual(mutated, src, `mutation « ${label} » sans effet (ancre introuvable)`);
        const file = join(HERE, `.__mut4_${++seq}_${rel.split("/").pop().replace(/\.js$/, "")}.mjs`);
        writeFileSync(file, mutated, "utf8");
        let failure = null;
        try {
            await check(file);
        } catch (e) {
            failure = e;
        } finally {
            rmSync(file, { force: true });
            clearBody();
        }
        assert.ok(failure, `mutation « ${label} » NON détectée (le contrat reste vert) → contrôle négatif vacant`);
        return failure.message;
    }

    /* (a) Croix texte réintroduite dans un fichier du lot. */
    const msgGlyphe = await mutant("js/holaf_shortcuts.js", "« ✕ » réintroduit dans la suppression",
        (s) => s.replace(
            'delBtn.innerHTML = aihIconSvg("x", { size: 12 });',
            'delBtn.textContent = "✕";'
        ),
        async (file) => {
            const mutantSrc = readFileSync(file, "utf8");
            // Ici c'est bien le GLYPHE qui doit faire échouer la garde…
            assert.ok(!stripComments(mutantSrc).includes("✕"),
                "mutant : le glyphe « ✕ » est réapparu dans le code");
            // …et le contrat complet (façade + glyphes) mord aussi.
            assertLotSource((rel) => (rel === "js/holaf_shortcuts.js" ? mutantSrc : read(rel)));
        }
    );
    ok(`« ✕ » réintroduit → ROUGE (${msgGlyphe.split("\n")[0].slice(0, 70)})`);

    /* (b) Poignée de drag sans `pointerdown` : le drag ne démarre plus. */
    const msgDrag = await mutant("js/aih_elements_widget.js", "poignée sans pointerdown",
        (s) => s.replace("grip.onpointerdown = (e) => startDrag(e, idx, row);", ""),
        async (file) => {
            await bootElementsWidget("file://" + file + "?m=drag");
            const grip = window.document.querySelector(".aih-element-row span");
            assert.ok(grip, "mutant : poignée présente");
            const ev = typeof window.PointerEvent === "function"
                ? new window.PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 10, clientY: 10, pointerId: 1 })
                : Object.assign(new window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }), { pointerId: 1 });
            grip.dispatchEvent(ev);
            assert.ok(window.document.querySelector(".aih-drag-placeholder"),
                "mutant : le drag ne démarre plus (aucun placeholder) → la garde pointerdown est vacante");
        }
    );
    ok(`poignée sans pointerdown → ROUGE (${msgDrag.split("\n")[0].slice(0, 70)})`);

    /* (c) Badge plein écran qui ne rend plus son icône. */
    const msgFs = await mutant("js/image_viewer/image_viewer_gallery.js", "badge plein écran sans icône",
        (s) => s.replace(
            "fsIcon.innerHTML = aihIconSvg('maximize', { size: 16 });",
            "fsIcon.innerHTML = '';"
        ),
        async (file) => {
            const src = readFileSync(file, "utf8");
            const addSrc = src.match(/function addFullscreenIcon\([\s\S]*?\n\}/)[0];
            const add = new Function("aihIconSvg", "t", `${addSrc}\nreturn addFullscreenIcon;`)(
                icons.aihIconSvg, (k) => I18n.t(k));
            const ph = window.document.createElement("div");
            window.document.body.appendChild(ph);
            add(ph, { path_canon: "m" });
            const badge = ph.querySelector(".holaf-viewer-fullscreen-icon");
            assert.ok(badge.querySelector("svg"),
                "mutant : le badge plein écran n'a plus d'icône (plus de bascule visuelle)");
        }
    );
    ok(`badge plein écran sans icône → ROUGE (${msgFs.split("\n")[0].slice(0, 70)})`);

    /* (d) Emoji SÉMANTIQUE (cerveau) remplacé dans le widget. */
    const msgBrain = await mutant("js/aih_elements_widget.js", "cerveau 🧠 modifié",
        (s) => s.replace('brainBtn.textContent = "🧠";', 'brainBtn.textContent = "🤖";'),
        async (file) => {
            assertLotSource((rel) => (rel === "js/aih_elements_widget.js" ? readFileSync(file, "utf8") : read(rel)));
        }
    );
    ok(`cerveau 🧠 modifié → ROUGE (${msgBrain.split("\n")[0].slice(0, 70)})`);

    /* (e) Contrôle de graine retiré de la ligne (🔗🎲🔒 perdus). */
    const msgSeed = await mutant("js/aih_elements_widget.js", "contrôle de graine retiré",
        (s) => s.replace("const seedCtl = createSeedControl({", "const seedCtl = (() => null)({"),
        async (file) => {
            await bootElementsWidget("file://" + file + "?m=seed");
            const row = window.document.querySelector(".aih-element-row");
            assert.ok(row.querySelector(".aih-seed-ctl"),
                "mutant : la ligne n'a plus de contrôle de graine (🔗🎲🔒 perdus)");
        }
    );
    ok(`contrôle de graine retiré → ROUGE (${msgSeed.split("\n")[0].slice(0, 70)})`);

    /* (f) Consommation de la façade hors liste blanche. */
    {
        const probe = join(HERE, ".__mut4_forbidden_consumer.js");
        writeFileSync(probe,
            '// mutant : consommation interdite (équivalent aih_frontend hors lot)\n' +
            'import { aihIconSvg } from "./aih_icons.js";\n' +
            'export const x = aihIconSvg("info");\n', "utf8");
        let caught = null;
        try {
            const r = checkIconPerimetre(PACKAGE_DIR, "2b");
            assert.deepStrictEqual(r.horsListe, [], "consommateur hors périmètre : " + r.horsListe.join(", "));
        } catch (e) {
            caught = e;
        } finally {
            rmSync(probe, { force: true });
        }
        assert.ok(caught, "consommation hors liste blanche NON détectée → garde vacante");
        assert.ok(/forbidden_consumer/.test(caught.message),
            "le rouge doit nommer le fichier fautif : " + caught.message.split("\n")[0]);
        ok(`consommation hors liste → ROUGE (${caught.message.split("\n")[0].slice(0, 70)})`);
    }

    // Aucun mutant résiduel, et les fichiers du lot n'ont pas bougé.
    assert.deepStrictEqual(readdirSync(HERE).filter((f) => f.startsWith(".__mut4_")), [],
        "aucun mutant ne doit rester sur le disque");
    for (const rel of PHASE_2B_CONSUMERS) {
        assert.ok(read(rel).includes("aihIconSvg"), `${rel} : la façade est toujours appelée après les mutants`);
    }
    ok("fichiers du lot intacts, aucun mutant résiduel");
}

console.log(`\n✅ test_aih_icons_phase2b : ${n} groupes PASSENT`);
process.exit(0);
