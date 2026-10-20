// ─────────────────────────────────────────────────────────────────────────
// PHASE 2c de la migration d'icônes : MENUS ET BOUTONS D'ACTIONS
// + AMÉLIORATION D'ACCESSIBILITÉ du badge plein écran de la galerie.
//
// Fichiers du lot (source unique de vérité : test_helpers/icon_perimeter.mjs,
// PHASES["2c"]) :
//   js/aih_menu.js                    🗑 supprimer un membre · 👤 avatar ·
//                                     🖥️ client-side · ✗ erreur de mise à jour
//   js/holaf_main.js                  ✓ des cases à cocher du menu principal
//   js/holaf_resolution_preset_v2.js  libellé MÊLÉ « 🔗 Use Image Ratio : ON »
//   js/holaf_load_image_video.js      libellé MÊLÉ « 📤 Upload Image/Video »
//   js/aih_repair_workflow.js         ▸/▾ chevrons de dépliage
//   js/aih_workflow_share.js          ACTIONS seulement (❌ statuts intacts)
//
// Ce qui est verrouillé ici :
//   1. SOURCE : chaque emplacement appelle la façade, le glyphe a disparu du
//      CODE (les commentaires qui CITENT un glyphe sont ignorés — lexer
//      `stripComments`, même contrat que la phase 2b), aucun import direct de
//      la brique vendorisée.
//   2. NON-DÉBORDEMENT : les glyphes de STATUT de aih_workflow_share.js
//      (⏳ ♻️ ✅ ⏭ ❌ ✓) et le dot 🟢 de aih_menu.js restent du TEXTE — ils sont
//      pilotés par le code et assertés par d'autres tests.
//   3. RUNTIME (vrais modules) :
//      - aih_menu : corbeille de la table des membres (icône `trash`, `title`
//        intact, handler réel → confirmation puis DELETE) ; indicateur
//        client-side (`monitor` + role=img/aria-label/title) VS aucun indicateur.
//      - holaf_resolution_preset_v2 : libellé mêlé « icône + texte EXACT »
//        (OFF → clic → ON), widget réel piloté, aucune couleur en dur.
//      - holaf_load_image_video : libellé « icône + texte EXACT » ; l'état
//        d'attente « ⏳ Uploading... » reste du TEXTE (statut piloté par le
//        code) et le libellé est RESTAURÉ en sortie.
//      - aih_repair_workflow : chevron-right → clic → chevron-down, état
//        déplié/replié + aria-expanded + title/aria-label.
//      - galerie : badge plein écran accessible (role/tabindex/aria-label),
//        Entrée ET Espace déclenchent l'action déléguée, Espace est
//        preventDefault, focus visible scopé dans le CSS de l'onglet.
//   4. PÉRIMÈTRE par phases : `PHASES["2c"]` consommé réellement, 2a/2b
//      toujours consommateurs, aucun hors-liste, 3 interdits inchangés.
//   5. CONTRÔLES NÉGATIFS PAR MUTATION (le vérificateur mord) : 🗑 réintroduit,
//      `title` retiré d'un bouton-icône, badge sans tabindex, badge sans
//      activation clavier, statut ✅ de aih_workflow_share migré par erreur,
//      libellé mêlé amputé, clé i18n retirée en EN, consommation hors liste.
//
// Usage : node js/test_aih_icons_phase2c.mjs
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom absent), 1 = FAIL.
import assert from "node:assert";
import { readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { register } from "node:module";

import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";
import {
    PHASES,
    PHASE_2A_CONSUMERS,
    PHASE_2B_CONSUMERS,
    PHASE_2C_CONSUMERS,
    ALLOWED_CONSUMERS,
    FORBIDDEN_CONSUMERS,
    CURRENT_PHASE,
    checkIconPerimetre,
    checkPhaseDisjointness,
} from "./test_helpers/icon_perimeter.mjs";
import { HolafIcons } from "./vendor/holaf/holaf-icons.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HERE, "..");

const JSDOM = await loadJsdomOrSkip("test_aih_icons_phase2c");

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };
const read = (rel) => readFileSync(join(PACKAGE_DIR, rel), "utf8");

/* ══ 0. Contrat de SOURCE du lot (réutilisé par les mutants) ═════════════ */
/**
 * Retire commentaires // … et /* … *​/ pour ne chercher les glyphes que dans le
 * CODE : plusieurs commentaires CITENT volontairement un glyphe (historique de
 * la migration, ou glyphe d'un AUTRE fichier hors lot).
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
 * Contrat de source du lot 2c. `reader` est injectable pour rejouer la garde
 * sur un MUTANT (fichier temporaire) et vérifier qu'elle mord.
 * @param {(rel: string) => string} reader
 */
function assertLotSource(reader) {
    const LOT = [
        {
            file: "js/aih_menu.js",
            must: [
                [/import\s*\{\s*aihIconSvg\s*\}\s*from\s*["']\.\/aih_icons\.js["']/, "import de la façade"],
                // Corbeille d'un membre : icône + nom accessible conservé.
                [/aihIconSvg\(\s*"trash"\s*,\s*\{\s*size:\s*13\s*\}\s*\)/, "corbeille de suppression d'un membre"],
                [/title="\$\{t\("menu\.del"\)\}"/, "nom accessible du bouton supprimer (menu.del)"],
                [/class="aih-member-del"\s+data-id="\$\{escapeHtml\(m\.id\)\}"\s+data-name="\$\{safeName\}"/,
                    "data-id / data-name du bouton conservés"],
                // Avatar de repli.
                [/aihIconSvg\("user"\s*,\s*\{\s*size:\s*12\s*\}\)/, "avatar de repli"],
                // Indicateur client-side : icône + nom accessible.
                [/aihIconSvg\("monitor"\s*,\s*\{\s*size:\s*12\s*\}\)/, "indicateur client-side"],
                [/const clientLabel = t\("menu\.clientSide"\)/, "clé i18n de l'indicateur client-side"],
                [/role="img" aria-label="\$\{escapeHtml\(clientLabel\)\}" title="\$\{escapeHtml\(clientLabel\)\}"/,
                    "indicateur : role=img + aria-label + title"],
                // Marque d'erreur de la mise à jour.
                [/aihIconSvg\("x"\s*,\s*\{\s*size:\s*13\s*\}\)/, "marque d'erreur de la mise à jour"],
                // Handler destructif + anti-XSS : INCHANGÉS.
                [/btn\.addEventListener\("click", async \(\) => \{/, "handler de suppression d'un membre conservé"],
                [/window\.aihShowConfirm\(t\("dialog\.delete"\), t\("menu\.delMemberConfirm", \{ name: escapeHtml\(name\) \}\)\)/,
                    "confirmation destructive + échappement du nom conservés"],
                [/\/api\/admin\/users\/\$\{encodeURIComponent\(id\)\}/, "route DELETE réelle conservée"],
                // STATUT : le dot 🟢 reste un TEXTE (asserté par test_aih_account_url).
                [/dot\.textContent = "🟢"/, "dot de statut 🟢 laissé en texte (jamais une icône)"],
            ],
            glyphes: ["🗑", "👤", "🖥", "✗"],
        },
        {
            file: "js/holaf_main.js",
            must: [
                [/import\s*\{\s*aihIconSvg\s*\}\s*from\s*["']\.\/aih_icons\.js["']/, "import de la façade"],
                // Les DEUX coches (ouverture du menu + construction des items).
                [/check\.innerHTML = isActive \? aihIconSvg\("check", \{ size: 10 \}\) : "";/, "coche à l'ouverture du menu"],
                [/checkbox\.innerHTML = isActive \? aihIconSvg\("check", \{ size: 10 \}\) : "";/, "coche d'un item à bascule"],
                // Sémantique de case conservée : toujours un DIV, jamais un <button>.
                [/checkbox = document\.createElement\("div"\);/, "la case reste un <div> (pas transformée en bouton)"],
                [/check\.style\.borderColor = isActive \?/, "état visuel (borderColor) conservé — ouverture"],
                [/checkbox\.style\.borderColor = isActive \?/, "état visuel (borderColor) conservé — item"],
                [/setTimeout\(updateCheckboxUI, 50\);/, "rafraîchissement différé de la case conservé"],
                // Identité Blobby : emoji INCHANGÉ (hors périmètre).
                [/icon\.textContent = "🧡";/, "identité Blobby 🧡 laissée telle quelle"],
            ],
            glyphes: ["✓"],
        },
        {
            file: "js/holaf_resolution_preset_v2.js",
            must: [
                [/import\s*\{\s*aihIconSvg\s*\}\s*from\s*["']\.\/aih_icons\.js["']/, "import de la façade"],
                [/aihIconSvg\("link"\s*,\s*\{\s*size:\s*11\s*\}\)/, "icône du libellé mêlé Image Ratio"],
                [/"Use Image Ratio : ON"/, "texte ON exact conservé"],
                [/"Use Image Ratio : OFF"/, "texte OFF exact conservé"],
                [/ratioButton\.innerHTML = ratioIconLabel\(useImageRatio\);/, "libellé mêlé réappliqué à chaque updateUI"],
                [/ratioButton\.addEventListener\("click", \(\) => \{/, "handler du toggle conservé"],
                [/setWidgetValue\(widgets\.use_image_ratio, !widgets\.use_image_ratio\.value\);/, "bascule du widget réel conservée"],
            ],
            glyphes: ["🔗"],
        },
        {
            file: "js/holaf_load_image_video.js",
            must: [
                [/import\s*\{\s*aihIconSvg\s*\}\s*from\s*["']\.\/aih_icons\.js["']/, "import de la façade"],
                [/aihIconSvg\("upload"\s*,\s*\{\s*size:\s*13\s*\}\)/, "icône du libellé mêlé d'upload"],
                [/const UPLOAD_LABEL = "Upload Image\/Video";/, "texte exact du bouton conservé"],
                [/uploadButton\.innerHTML = uploadButtonLabel\(\);/, "libellé mêlé posé à la création"],
                [/if \(uploadButton\) uploadButton\.innerHTML = uploadButtonLabel\(\);/, "libellé RESTAURÉ après l'upload"],
                // État d'attente : statut piloté par le code → reste du TEXTE.
                [/if \(uploadButton\) uploadButton\.textContent = "⏳ Uploading\.\.\.";/, "état d'attente ⏳ laissé en texte (statut)"],
                [/uploadButton\.onclick = \(\) => \{ fileInput\.click\(\); \};/, "handler d'ouverture du sélecteur conservé"],
                [/await uploadFileAndSetWidget\(node, fileInput\.files\[0\], uploadButton\);/, "upload réel conservé"],
            ],
            glyphes: ["📤"],
        },
        {
            file: "js/aih_repair_workflow.js",
            must: [
                [/import\s*\{\s*aihIconSvg\s*\}\s*from\s*["']\.\/aih_icons\.js["']/, "import de la façade"],
                [/aihIconSvg\(expanded \? "chevron-down" : "chevron-right", \{ size: 12 \}\)/, "chevrons déplié / replié"],
                [/toggle\.setAttribute\("aria-expanded", expanded \? "true" : "false"\);/, "état annoncé (aria-expanded)"],
                [/const name = tr\(expanded \? "rw\.detail\.hide" : "rw\.detail\.show"\);/, "nom accessible via clés i18n"],
                [/toggle\.title = name;/, "infobulle = nom accessible"],
                [/toggle\.setAttribute\("aria-label", name\);/, "aria-label du bouton-icône"],
                [/details\.style\.display = shown \? "none" : "block";/, "toggle déplié/replié conservé"],
                [/setToggleState\(!shown\);/, "l'état du chevron suit le toggle"],
            ],
            glyphes: ["▸", "▾"],
        },
        {
            file: "js/aih_workflow_share.js",
            must: [
                [/import\s*\{\s*aihIconSvg\s*\}\s*from\s*["']\.\/aih_icons\.js["']/, "import de la façade"],
                [/aihIconSvg\(name, \{ size: size \}\)/, "slot d'icône (façade)"],
                [/iconSlot\("trash", 13, 0\)/, "corbeille d'un workflow (action)"],
                [/iconSlot\("upload", 20, 0\)/, "vignette de repli (action d'upload)"],
                [/iconSlot\("heart", 12\)/, "compteur de likes (icône)"],
                [/iconSlot\("download", 12\)/, "compteur de téléchargements (icône)"],
                [/aihIconSvg\("link", \{ size: 12 \}\)/, "lien git d'un node (action)"],
                [/iconSlot\("folder", 13\)/, "dossier du conflit de fichiers"],
                // Actions réelles : INCHANGÉES.
                [/window\._wfDeleteWorkflow = async function\(btn\)/, "action de suppression conservée"],
                [/var confirmed = await aihShowConfirm\(t\("dialog\.delete"\), t\("wf\.deleteConfirm", \{ name: name \}\)\);/,
                    "confirmation destructive conservée"],
                [/var data = await remoteDelete\(getApiUrl\(\) \+ "\/workflows\/" \+ id\);/, "requête DELETE conservée"],
                [/esc\(t\('wf\.openNodeRepo'\)\)/, "nom accessible du lien (clé i18n)"],
                // STATUTS : intacts (preuve qu'on n'a pas débordé).
                [/statusEl\.textContent = "⏳";/, "statut ⏳ en texte"],
                [/r\.status\.textContent = status === "overwritten" \? "♻️" : "✅";/, "statuts ♻️/✅ en texte"],
                [/r\.status\.textContent = "⏭";/, "statut ⏭ en texte"],
                [/r\.status\.textContent = "❌";/, "statut ❌ en texte"],
                [/✓ ' \+ esc\(pk\.url\)/, "marque ✓ du lien git en texte"],
                // Second panneau (téléchargement) : mêmes statuts, en échappements.
                [/r\.status\.textContent = "\\u23ed";/, "statut ⏭ (panneau de téléchargement) en texte"],
                [/r\.status\.textContent = "\\u2705";/, "statut ✅ (panneau de téléchargement) en texte"],
                [/r\.status\.textContent = "\\u274c";/, "statut ❌ (panneau de téléchargement) en texte"],
            ],
            glyphes: ["🗑", "📤", "📥", "❤", "🔗", "📁"],
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
    return LOT;
}

/* ══ 1. Source : façade partout, glyphes d'ACTION éliminés ═══════════════ */
console.log("1. source : façade appelée, glyphes d'action disparus (6 fichiers)");
{
    const LOT = assertLotSource(read);
    const total = LOT.reduce((a, s) => a + s.glyphes.length, 0);
    ok(`6 fichiers du lot : façade appelée (une seule voie), ${total} emplacements de glyphes nettoyés`);

    // Preuve de NON-DÉBORDEMENT : les statuts de aih_workflow_share sont dans le
    // CODE (pas seulement en commentaire) et pilotes toujours l'UI.
    const shareCode = stripComments(read("js/aih_workflow_share.js"));
    for (const st of ["⏳", "♻️", "✅", "⏭", "❌", "✓"]) {
        assert.ok(shareCode.includes(st), `statut « ${st} » toujours présent en TEXTE dans le code`);
    }
    // …et le module continue de les écrire dans un <span> de statut.
    assert.strictEqual((shareCode.match(/r\.status\.textContent = /g) || []).length, 6,
        "les 6 écritures de statut (4 littérales + 3 en échappement) sont intactes");
    ok("statuts ⏳ ♻️ ✅ ⏭ ❌ ✓ de aih_workflow_share.js inchangés (aucun débordement)");

    // Clés i18n AJOUTÉES : présentes et NON VIDES dans les DEUX langues.
    const dict = read("js/aih_strings.js");
    for (const key of ["rw.detail.show", "rw.detail.hide", "wf.openNodeRepo"]) {
        const rx = new RegExp(`"${key.replace(/\./g, "\\.")}"\\s*:\\s*"([^"]+)"`, "g");
        const hits = [...dict.matchAll(rx)].map((m) => m[1]);
        assert.strictEqual(hits.length, 2, `clé « ${key} » attendue en FR ET en EN (reçu ${hits.length})`);
        assert.ok(hits.every((v) => v.trim().length > 0), `clé « ${key} » non vide dans les deux langues`);
        assert.notStrictEqual(hits[0], hits[1], `clé « ${key} » : EN distincte du FR (vraie traduction)`);
    }
    ok("clés i18n ajoutées (rw.detail.show/hide, wf.openNodeRepo) : parité FR/EN stricte");
}

/* ══ 2. Périmètre PAR PHASES ═════════════════════════════════════════════ */
console.log("2. périmètre par phases : lot 2c branché, 2a/2b toujours consommateurs, listes disjointes");
{
    // Le lot 2c n'est plus le lot COURANT (2d est arrivé) mais reste une phase
    // LIVÉE et pleinement branchée. `CURRENT_PHASE` ne doit jamais RECULER : il
    // désigne toujours le dernier lot livré.
    assert.deepStrictEqual(Object.keys(PHASES).slice(0, 3), ["2a", "2b", "2c"],
        "les phases 2a, 2b et 2c restent livrées dans cet ordre (jamais fusionnées)");
    assert.strictEqual(CURRENT_PHASE, Object.keys(PHASES).slice(-1)[0],
        "CURRENT_PHASE = dernier lot livré (aucun recul de périmètre)");
    assert.ok(!PHASE_2C_CONSUMERS.includes("js/aih_enhance_widget.js"),
        "le fichier du lot 2d n'est PAS inscrit en 2c (un fichier = un lot)");
    assert.strictEqual(PHASE_2C_CONSUMERS.length, 6, "la phase 2c couvre 6 fichiers");

    const r = checkIconPerimetre(PACKAGE_DIR, "2c");
    assert.deepStrictEqual(r.interdits, [], "fichier(s) interdit(s) consommant la façade : " + r.interdits.join(", "));
    assert.deepStrictEqual(r.horsListe, [], "consommateur(s) hors périmètre : " + r.horsListe.join(", "));
    assert.deepStrictEqual(r.manquants, [],
        "fichier(s) du lot 2c ne consommant pas la façade : " + r.manquants.join(", "));
    assert.deepStrictEqual(r.manquantsToutesPhases, [],
        "fichier(s) d'une phase livrée ne consommant plus la façade : " + r.manquantsToutesPhases.join(", "));

    // CUMUL : 2a et 2b restent consommateurs, et l'union couvre les 3 phases.
    assert.deepStrictEqual(ALLOWED_CONSUMERS, [...new Set(Object.values(PHASES).flat())].sort(),
        "ALLOWED_CONSUMERS = union triée de TOUTES les phases");
    for (const rel of [...PHASE_2A_CONSUMERS, ...PHASE_2B_CONSUMERS]) {
        assert.ok(r.offenders.includes(rel), `${rel} (phase antérieure) n'est plus consommateur`);
    }
    assert.deepStrictEqual(r.offenders, ALLOWED_CONSUMERS,
        "les consommateurs détectés sont EXACTEMENT les fichiers des phases livrées");

    const disjoint = checkPhaseDisjointness();
    assert.deepStrictEqual(disjoint.croisements, [], "fichier(s) à la fois autorisé(s) et interdit(s)");
    assert.deepStrictEqual(disjoint.doublonsPhases, [], "fichier(s) présent(s) dans deux phases");
    assert.deepStrictEqual(FORBIDDEN_CONSUMERS, [
        "js/blobby_companion.js", "js/aih_elements_seed.js", "js/aih_keywords_widget.js",
    ], "les 3 fichiers interdits sémantiques sont inchangés");
    ok(`périmètre : ${r.offenders.length} consommateurs = 2a (${PHASE_2A_CONSUMERS.length}) + ` +
        `2b (${PHASE_2B_CONSUMERS.length}) + 2c (${PHASE_2C_CONSUMERS.length}), aucun hors liste, 3 interdits`);
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
    "KeyboardEvent", "DOMParser", "FormData", "File",
];
for (const key of GLOBALS) {
    if (window[key] !== undefined) globalThis[key] = window[key];
}
globalThis.window = window;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });

// jsdom n'implémente ni canvas 2D ni ResizeObserver ni la lecture média.
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.ResizeObserver = globalThis.ResizeObserver;
window.HTMLCanvasElement.prototype.getContext = () => null;
window.HTMLMediaElement.prototype.play = function () {};
window.HTMLMediaElement.prototype.pause = function () {};
window.HTMLMediaElement.prototype.load = function () {};
window.LiteGraph = { NODE_TITLE_HEIGHT: 24, vueNodesMode: false };
globalThis.LiteGraph = window.LiteGraph;

// Aucune requête réseau réelle : `fetch` est mocké par section.
const noFetch = () => Promise.reject(new Error("réseau interdit en test"));
globalThis.fetch = noFetch;
window.fetch = noFetch;

// ComfyUI factice : `app.registerExtension` collecte les extensions, et les
// modules qui importent `../../scripts/app.js` reçoivent CE MÊME objet via le
// hook de résolution js/test_helpers/nodes2_resolve.mjs.
const registered = [];
const fakeApp = {
    graph: { _nodes: [], extra: {}, setDirtyCanvas() {}, getNodeById() { return null; } },
    canvas: { ds: { offset: [0, 0], scale: 1 }, setDirtyCanvas() {}, centerOnNode() {} },
    registerExtension(ext) { registered.push(ext); },
    extensions: [],
    ui: { settings: {} },
};
globalThis.__aihNodes2TestApp = fakeApp;
globalThis.__aihNodes2TestApi = {
    api_base: "",
    apiURL: (p) => p,
    addEventListener() {},
    fetchApi: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
};
window.app = fakeApp;
globalThis.app = fakeApp;
window.comfyAPI = {
    app: { app: fakeApp },
    api: { api: globalThis.__aihNodes2TestApi },
};
register(new URL("./test_helpers/nodes2_resolve.mjs", import.meta.url), import.meta.url);

localStorage.setItem("aih_locale", "fr");
await import("./aih_i18n.js");
window.AIH = window.AIH || {};
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
    assert.strictEqual(svgEl.getAttribute("aria-hidden"), "true", `${ctx} : icône décorative (aria-hidden)`);
    assert.strictEqual(svgEl.getAttribute("focusable"), "false", `${ctx} : focusable=false`);
    assert.strictEqual(svgEl.innerHTML, brickBody(expectedName),
        `${ctx} : tracés différents de l'icône « ${expectedName} »`);
    assert.ok(!/#[0-9a-fA-F]{3,8}\b|\brgb\(|\bhsl\(/.test(svgEl.outerHTML),
        `${ctx} : couleur codée en dur dans le SVG (attendu : currentColor)`);
    return svgEl;
}
const clearBody = () => { window.document.body.innerHTML = ""; };

// Les noms d'icônes utilisés par le lot EXISTENT dans la brique.
{
    const disponibles = icons.aihIconNames();
    const utilises = ["trash", "user", "monitor", "x", "check", "link", "upload",
        "chevron-right", "chevron-down", "download", "heart", "folder"];
    const inconnus = utilises.filter((name) => !disponibles.includes(name));
    assert.deepStrictEqual(inconnus, [],
        `nom(s) absent(s) des ${disponibles.length} de la brique : ` + inconnus.join(", "));
    ok(`${utilises.length} noms d'icônes du lot tous présents dans les ${disponibles.length} de la brique`);
}

/* ══ 4. aih_menu : membres (corbeille + avatar) et client-side ═════════ */
console.log("4. aih_menu : corbeille « trash », avatar « user », client-side « monitor »");
{
    clearBody();
    localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "https://aih.test", apiKey: "k" }));

    const MALE_NAME = "<img src=x onerror=alert(1)>"; // valeur serveur hostile
    const MEMBERS = [
        { id: "u-admin", role: "admin", display_name: "Alice", filter_count: 1, prompt_count: 2 },
        { id: "u-user", role: "user", display_name: "Bob", filter_count: 3, prompt_count: 4 },
        { id: "u-bad", role: "user", display_name: MALE_NAME, filter_count: 0, prompt_count: 0 },
    ];
    const PRESETS = [
        { id: "p1", name: "Locale", is_global: 0, is_client_side: false, model: "m", base_url: "http://x" },
        { id: "p2", name: "Client", is_global: 0, is_client_side: true, model: "m", base_url: "http://x" },
    ];

    const requests = [];
    const jsonResponse = (data, status = 200) => ({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
        json: async () => data,
        text: async () => JSON.stringify(data),
    });
    window.fetch = globalThis.fetch = async (url, init) => {
        const u = String(url);
        const method = ((init && init.method) || "GET").toUpperCase();
        requests.push([method, u]);
        if (/\/api\/members$/.test(u)) return jsonResponse(MEMBERS);
        if (/\/api\/auth\/me$/.test(u)) return jsonResponse({ id: "u-admin", role: "admin" });
        if (/\/api\/presets$/.test(u) && method === "GET") return jsonResponse(PRESETS);
        if (/\/api\/admin\/users\/[^/]+$/.test(u) && method === "DELETE") return jsonResponse({ status: "ok" });
        return jsonResponse({ error: "not found" }, 404);
    };

    await import("./aih_menu.js");

    // (a) Table des membres : corbeille = icône `trash` 13 px + title conservé.
    const modalBody = window.document.createElement("div");
    window.document.body.appendChild(modalBody);
    window.aihOpenModalV2 = () => ({ body: modalBody, close() {} });
    let confirmTitle = null;
    let confirmMessage = null;
    window.aihShowConfirm = (title, message) => {
        confirmTitle = title;
        confirmMessage = message;
        return Promise.resolve(true); // accepte : on vérifie le handler COMPLET
    };
    window.aihShowAlert = () => Promise.resolve();
    window.aihShowPrompt = () => Promise.resolve(null);

    await window.AIHMenu.openMembers();
    const delBtns = [...modalBody.querySelectorAll(".aih-member-del")];
    assert.strictEqual(delBtns.length, 2,
        "2 boutons de suppression : jamais celui de l'utilisateur courant (règle inchangée)");
    const bobBtn = delBtns.find((b) => b.getAttribute("data-name") === "Bob");
    assert.ok(bobBtn, "bouton du membre « Bob » présent (data-name conservé)");
    assert.strictEqual(bobBtn.getAttribute("data-id"), "u-user", "data-id conservé");
    assert.strictEqual(bobBtn.title, I18n.t("menu.del"), "title (menu.del) conservé");
    assertIconSvg(bobBtn.querySelector("svg"), "trash", 13, "corbeille d'un membre");
    assert.ok(!bobBtn.textContent.includes("🗑"), "le glyphe « 🗑 » a disparu du bouton");
    assert.ok(!/font-family/.test(bobBtn.getAttribute("style") || ""), "aucun CSS global ajouté au bouton");

    // Avatar de repli (aucune URL) : icône `user` décorative dans la pastille.
    const avatarSpan = [...modalBody.querySelectorAll("td:first-child span")]
        .find((s) => s.querySelector("svg") && s.style.borderRadius === "50%");
    assert.ok(avatarSpan, "pastille d'avatar de repli présente");
    assertIconSvg(avatarSpan.querySelector("svg"), "user", 12, "avatar de repli");

    // Le clic réel déclenche TOUTE la chaîne : confirmation échappée → DELETE.
    bobBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(confirmTitle, I18n.t("dialog.delete"), "titre de confirmation inchangé");
    assert.ok(String(confirmMessage).includes("Bob"), "le message de confirmation nomme le membre");
    assert.ok(requests.some(([m, u]) => m === "DELETE" && /\/api\/admin\/users\/u-user$/.test(u)),
        "handler intact : DELETE /api/admin/users/<id> réellement émis après confirmation");

    // (b) Anti-XSS non régressé : le nom hostile reste échappé dans le message.
    const badBtn = delBtns.find((b) => b.getAttribute("data-name") === MALE_NAME);
    assert.ok(badBtn, "bouton du membre au nom hostile présent");
    badBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(String(confirmMessage).includes("&lt;img") && !String(confirmMessage).includes("<img"),
        "le nom reste ÉCHAPPÉ dans la confirmation (innerHTML)");
    ok("membres : icône « trash » 13 px + title/data-* conservés, clic → confirmation → DELETE réel");

    // (c) Presets : indicateur client-side = icône `monitor` nommée, et RIEN
    //     pour un preset local (l'emoji a disparu dans les deux cas).
    const prov = window.document.createElement("div");
    window.document.body.appendChild(prov);
    await window.AIHMenu.renderProvidersTab(prov);

    const rows = [...prov.querySelectorAll("strong")].map((s) => s.closest("div"));
    const clientRow = rows.find((d) => (d.textContent || "").includes("Client"));
    const localRow = rows.find((d) => (d.textContent || "").includes("Locale"));
    assert.ok(clientRow && localRow, "les deux presets sont rendus");

    const badges = [...prov.querySelectorAll('span[role="img"]')];
    assert.strictEqual(badges.length, 1, "un seul indicateur client-side (aucun sur le preset local)");
    const badge = badges[0];
    assert.ok(clientRow.contains(badge), "l'indicateur est sur la ligne du preset client-side");
    assert.strictEqual(badge.getAttribute("aria-label"), I18n.t("menu.clientSide"),
        "aria-label = clé i18n menu.clientSide");
    assert.strictEqual(badge.getAttribute("title"), I18n.t("menu.clientSide"),
        "title ajouté (absent du temps de l'emoji)");
    assertIconSvg(badge.querySelector("svg"), "monitor", 12, "indicateur client-side");
    assert.ok(!prov.textContent.includes("🖥"), "le glyphe « 🖥️ » a disparu du rendu des presets");
    assert.deepStrictEqual([...localRow.querySelectorAll("svg")].length, 0,
        "preset local : aucune icône parasite");
    ok("client-side : icône « monitor » + role=img/aria-label/title ; preset local sans icône");
}

/* ══ 5. holaf_main : la case à cocher reste une CASE ════════════════════ */
console.log("5. holaf_main : coche = icône « check » 10 px, sémantique et état de case conservés");
{
    // Ce module monte l'ensemble du menu (12 sous-modules, timers DOM) : le
    // contrat est vérifié sur la SOURCE (section 0), l'ÉTAT est vérifié ici en
    // rejouant la fonction de rafraîchissement RÉELLE, extraite du fichier.
    const src = read("js/holaf_main.js");
    const body = src.match(/const updateCheckboxUI = \(\) => \{[\s\S]*?\n            \};/);
    assert.ok(body, "updateCheckboxUI introuvable dans holaf_main.js");

    const makeBox = () => {
        const div = window.document.createElement("div");
        div.style.borderColor = "var(--border-color, #888)";
        return div;
    };
    const state = { active: false };
    const run = new Function(
        "aihIconSvg", "window", "app", "itemInfo", "checkbox", "this_", `
        ${body[0]}
        updateCheckboxUI();
        return () => updateCheckboxUI();
        `
    );

    // Item « toggle_layout_tools » : l'état lu est `window.holaf.layoutTools.isVisible`.
    window.holaf = { layoutTools: { isVisible: false } };
    const box = makeBox();
    const refresh = run(icons.aihIconSvg, window, fakeApp, { special: "toggle_layout_tools" }, box, {});
    assert.strictEqual(box.innerHTML, "", "état INACTIF : aucune coche (chaîne vide)");
    assert.strictEqual(box.style.borderColor, "var(--border-color, #888)", "état inactif : bordure neutre");

    window.holaf.layoutTools.isVisible = true;
    refresh();
    assertIconSvg(box.querySelector("svg"), "check", 10, "coche d'un item actif");
    assert.strictEqual(box.style.borderColor, "var(--holaf-accent-color, #ff8c00)",
        "état ACTIF : bordure accentuée (aucune couleur codée en dur)");

    window.holaf.layoutTools.isVisible = false;
    refresh();
    assert.strictEqual(box.innerHTML, "", "retour à l'état INACTIF : coche retirée (bascule aller-retour)");
    ok("holaf_main : coche « check » 10 px, état actif/inactif + borderColor pilotés par le code inchangé");
}

/* ══ 6. holaf_resolution_preset_v2 : libellé mêlé (runtime réel) ════════ */
console.log("6. holaf_resolution_preset_v2 : « icône link + Use Image Ratio : ON/OFF » exact");
{
    clearBody();
    const ext = registered.find((e) => e && e.name === "AIH.ResolutionPresetV2")
        || (await import("./holaf_resolution_preset_v2.js"), registered.find((e) => e.name === "AIH.ResolutionPresetV2"));
    assert.ok(ext, "extension AIH.ResolutionPresetV2 enregistrée");

    function FakeNode() {}
    FakeNode.prototype = { widgets: [], size: [320, 240], inputs: [] };
    await ext.beforeRegisterNodeDef(FakeNode, { name: "AIHResolutionPresetV2" }, fakeApp);

    const node = Object.assign(new FakeNode(), {
        widgets: [
            { name: "model_type", value: "SDXL" },
            { name: "use_hd", value: true },
            { name: "megapixels", value: 2.5 },
            { name: "multiple_of", value: 16 },
            { name: "aspect_ratio", value: "1:1" },
            { name: "orientation", value: false },
            { name: "use_image_ratio", value: false },
        ],
        addDOMWidget(name, type, el) { this.widgets.push({ name, type, el }); return this.widgets.length - 1; },
        setSize(s) { this.size = s; },
    });
    node.onNodeCreated();
    const container = node.widgets.find((w) => w.name === "holaf_v2_ui").el;
    assert.ok(container, "conteneur DOM du node créé");
    window.document.body.appendChild(container);

    const ratioBtn = [...container.querySelectorAll("button")]
        .find((b) => (b.textContent || "").includes("Use Image Ratio"));
    assert.ok(ratioBtn, "bouton du toggle Image Ratio présent");

    // État OFF : icône `link` 11 px + texte EXACT (aucun texte dans le <svg>).
    assertIconSvg(ratioBtn.querySelector("svg"), "link", 11, "libellé mêlé Image Ratio (OFF)");
    assert.strictEqual(ratioBtn.textContent, "Use Image Ratio : OFF",
        "texte EXACT conservé (l'icône n'ajoute aucun caractère)");
    assert.ok(!ratioBtn.textContent.includes("🔗"), "le glyphe « 🔗 » a disparu");
    assert.strictEqual(ratioBtn.querySelectorAll("svg").length, 1, "une seule icône dans le libellé");
    assert.strictEqual(node.widgets.find((w) => w.name === "use_image_ratio").value, false,
        "état initial du widget réel conservé");

    // Clic → widget réel basculé + libellé réécrit sans perdre l'icône.
    ratioBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(node.widgets.find((w) => w.name === "use_image_ratio").value, true,
        "handler intact : le widget use_image_ratio passe à true");
    assert.strictEqual(ratioBtn.textContent, "Use Image Ratio : ON", "texte ON exact après bascule");
    assertIconSvg(ratioBtn.querySelector("svg"), "link", 11, "libellé mêlé Image Ratio (ON)");
    // Le texte est identique en FR et en EN (libellé anglais en dur, aucune clé i18n).
    for (const loc of ["fr", "en"]) {
        I18n.setLocale(loc);
        ratioBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        assert.strictEqual(ratioBtn.textContent,
            node.widgets.find((w) => w.name === "use_image_ratio").value
                ? "Use Image Ratio : ON" : "Use Image Ratio : OFF",
            `libellé mêlé correct en ${loc.toUpperCase()} (clé i18n non en jeu)`);
        assertIconSvg(ratioBtn.querySelector("svg"), "link", 11, `libellé mêlé Image Ratio (${loc})`);
    }
    I18n.setLocale("fr");
    ok("resolution_preset_v2 : icône « link » 11 px + texte exact OFF/ON, widget réel piloté (FR et EN)");
}

/* ══ 7. holaf_load_image_video : libellé mêlé + statut ⏳ intact ════════ */
console.log("7. holaf_load_image_video : « icône upload + Upload Image/Video », attente ⏳ en texte");
{
    clearBody();
    const ext = registered.find((e) => e && e.name === "AIH.LoadImageVideo")
        || (await import("./holaf_load_image_video.js"), registered.find((e) => e.name === "AIH.LoadImageVideo"));
    assert.ok(ext, "extension AIH.LoadImageVideo enregistrée");

    function FakeNode() {}
    FakeNode.prototype = { widgets: [], size: [320, 240], inputs: [] };
    await ext.beforeRegisterNodeDef(FakeNode, { name: "AIHLoadImageVideo" }, fakeApp);

    const mediaWidget = { name: "media_file", value: "", options: { values: [] }, callback: null };
    const node = Object.assign(new FakeNode(), {
        widgets: [mediaWidget],
        size: [320, 240],
        findInputSlot() { return -1; },
        addDOMWidget(name, type, el) { this.widgets.push({ name, type, el }); return this.widgets.length - 1; },
        setSize(s) { this.size = s; },
    });
    node.onNodeCreated();
    const container = node.widgets.find((w) => w.name === "holaf_media_loader").el;
    window.document.body.appendChild(container);
    const uploadBtn = container.querySelector("button");
    assert.ok(uploadBtn, "bouton d'upload présent");

    // Libellé mêlé au repos.
    assertIconSvg(uploadBtn.querySelector("svg"), "upload", 13, "libellé mêlé d'upload");
    assert.strictEqual(uploadBtn.textContent, "Upload Image/Video",
        "texte EXACT conservé (l'icône n'ajoute aucun caractère)");
    assert.ok(!uploadBtn.textContent.includes("📤"), "le glyphe « 📤 » a disparu");
    assert.strictEqual(uploadBtn.querySelectorAll("svg").length, 1, "une seule icône dans le libellé");

    // Upload réel : l'état d'attente reste le TEXTE « ⏳ Uploading... » (statut
    // piloté par le code) puis le libellé mêlé est RESTAURÉ.
    let duringUpload = null;
    globalThis.__aihNodes2TestApi.fetchApi = async (url) => {
        duringUpload = { text: uploadBtn.textContent, hasIcon: !!uploadBtn.querySelector("svg") };
        return { ok: true, status: 200, json: async () => ({ name: "photo.png" }) };
    };
    const fileInput = node._holaf_file_input;
    assert.ok(fileInput, "sélecteur de fichier monté");
    Object.defineProperty(fileInput, "files", {
        value: [new window.File(["x"], "photo.png", { type: "image/png" })],
        configurable: true,
    });
    await fileInput.onchange();
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(duringUpload, "l'upload a bien été déclenché");
    assert.strictEqual(duringUpload.text, "⏳ Uploading...",
        "pendant l'upload : le statut reste le TEXTE « ⏳ Uploading... » (jamais une icône)");
    assert.strictEqual(duringUpload.hasIcon, false, "pendant l'upload : aucune icône (état de statut)");
    assert.strictEqual(uploadBtn.textContent, "Upload Image/Video",
        "après l'upload : libellé mêlé restauré à l'identique");
    assertIconSvg(uploadBtn.querySelector("svg"), "upload", 13, "libellé restauré après upload");
    assert.strictEqual(mediaWidget.value, "photo.png", "le widget réel est renseigné (handler intact)");
    ok("load_image_video : icône « upload » 13 px, statut ⏳ en texte, libellé restauré, widget renseigné");
}

/* ══ 8. aih_repair_workflow : chevrons de dépliage (runtime réel) ═══════ */
console.log("8. aih_repair_workflow : chevron-right → chevron-down, état et toggle conservés");
{
    clearBody();
    await import("./aih_repair_workflow.js");
    const RW = window.AIHRepairWorkflow;
    assert.ok(RW && typeof RW.mountRepairUI === "function", "window.AIHRepairWorkflow exposé");

    const container = window.document.createElement("div");
    window.document.body.appendChild(container);
    const calls = [];
    const problem = {
        id: "missing_node_type|HolafRemoteComparer|AIHRemoteComparer",
        kind: "missing_node_type",
        old_type: "HolafRemoteComparer",
        new_type: "AIHRemoteComparer",
        count: 3,
        checkable: true,
        occurrences: [
            { scope: "root", node_id: 1 },
            { scope: "root", node_id: 2 },
            { scope: "root", node_id: 3 },
        ],
    };
    const ctrl = RW.mountRepairUI(container, {
        document: window.document,
        t: (k, params) => I18n.t(k, params),
        api: {
            listWorkflows: async () => ({ workflows: [] }),
            analyze: async () => ({ problems: [problem] }),
            apply: async (p) => { calls.push(["apply", p]); return { files: [] }; },
        },
        confirm: () => Promise.resolve(true),
        prompt: () => Promise.resolve(null),
        notify: () => {},
        copyText: async () => {},
    });
    ctrl.setPasted("{}");
    await ctrl.analyze();
    await new Promise((r) => setTimeout(r, 20));

    const row = container.querySelector(".rw-problem");
    assert.ok(row, "ligne de problème rendue");
    const toggle = row.querySelector(".rw-problem-toggle");
    const details = row.querySelector(".rw-problem-details");
    assert.ok(toggle && details, "bouton de dépliage + bloc de détail présents");

    // État REPLIÉ par défaut : chevron-right + aria-expanded=false + nom accessible.
    assert.strictEqual(details.style.display, "none", "détail replié par défaut (comportement inchangé)");
    assertIconSvg(toggle.querySelector("svg"), "chevron-right", 12, "chevron replié");
    assert.strictEqual(toggle.getAttribute("aria-expanded"), "false", "état annoncé : replié");
    assert.strictEqual(toggle.title, I18n.t("rw.detail.show"), "title = rw.detail.show");
    assert.strictEqual(toggle.getAttribute("aria-label"), I18n.t("rw.detail.show"),
        "aria-label du bouton-icône (il ne contient plus de texte)");
    assert.ok(!toggle.textContent.includes("▸"), "le glyphe « ▸ » a disparu du bouton");

    // Clic → déplié : chevron-down + aria-expanded=true (aucun texte résiduel).
    toggle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.notStrictEqual(details.style.display, "none", "clic → détail déplié");
    assertIconSvg(toggle.querySelector("svg"), "chevron-down", 12, "chevron déplié");
    assert.strictEqual(toggle.getAttribute("aria-expanded"), "true", "état annoncé : déplié");
    assert.strictEqual(toggle.title, I18n.t("rw.detail.hide"), "title = rw.detail.hide");
    assert.ok(!toggle.textContent.includes("▾"), "le glyphe « ▾ » a disparu du bouton");

    // Second clic → replié (bascule aller-retour).
    toggle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(details.style.display, "none", "second clic → replié");
    assertIconSvg(toggle.querySelector("svg"), "chevron-right", 12, "chevron replié (retour)");
    assert.strictEqual(toggle.getAttribute("aria-expanded"), "false", "état annoncé : replié (retour)");
    // Le compteur d'occurrences n'a pas bougé.
    assert.ok(row.querySelector(".rw-problem-count").textContent.includes("3"),
        "compteur d'occurrences inchangé");
    ok("repair_workflow : chevrons 12 px, replié/déplié + aria-expanded + title/aria-label, compteur intact");
}

/* ══ 9. Galerie : badge plein écran accessible au clavier ═══════════════ */
console.log("9. galerie : badge plein écran = bouton exposé (role/tabindex/aria-label, Entrée & Espace)");
{
    clearBody();
    const galSrc = read("js/image_viewer/image_viewer_gallery.js");

    // (a) Rendu : on rejoue la VRAIE fonction du module (extraite) avec la
    //     vraie façade, comme la phase 2b (la grille n'est pas montée ici).
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

    // Sémantique de bouton + nom accessible.
    assert.strictEqual(badge.getAttribute("role"), "button", "role=button (le div devient un bouton exposé)");
    assert.strictEqual(badge.getAttribute("tabindex"), "0", "tabindex=0 (atteignable au clavier)");
    assert.strictEqual(badge.getAttribute("aria-label"), I18n.t("iv.viewFullscreen"),
        "aria-label = nom accessible (clé iv.viewFullscreen)");
    assert.strictEqual(badge.title, I18n.t("iv.viewFullscreen"), "title conservé (phase 2b)");
    assert.strictEqual(badge.getAttribute("data-holaf-action"), "fullscreen",
        "action déléguée conservée");
    // L'icône reste décorative : le nom est porté par le badge, pas doublé.
    assertIconSvg(badge.querySelector("svg"), "maximize", 16, "badge plein écran");

    // (b) Entrée et Espace déclenchent l'action — via la MÊME délégation que la
    //     souris (on compte les clics qui REMONTENT jusqu'à un ancêtre).
    const seen = [];
    placeholder.addEventListener("click", (e) => {
        const action = e.target.closest && e.target.closest("[data-holaf-action]");
        if (action) seen.push(action.getAttribute("data-holaf-action"));
    });
    const press = (key) => {
        const ev = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        badge.dispatchEvent(ev);
        return ev;
    };
    press("a"); // touche quelconque : aucun effet
    assert.deepStrictEqual(seen, [], "une touche quelconque ne déclenche rien");

    const enterEv = press("Enter");
    assert.deepStrictEqual(seen, ["fullscreen"], "Entrée déclenche l'action « fullscreen » (clic délégué)");
    assert.strictEqual(enterEv.defaultPrevented, false, "Entrée n'a pas besoin d'être annulée");

    const spaceEv = press(" ");
    assert.deepStrictEqual(seen, ["fullscreen", "fullscreen"], "Espace déclenche l'action « fullscreen »");
    assert.strictEqual(spaceEv.defaultPrevented, true,
        "Espace est annulé (preventDefault) : la grille ne défile pas");

    // (c) Le clic SOURIS continue de fonctionner exactement comme avant.
    badge.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(seen.length, 3, "clic souris : action toujours déléguée (comportement inchangé)");

    // (d) Indicateur de focus VISIBLE, scopé au fichier CSS de l'onglet.
    const css = read("js/css/holaf_image_viewer.css");
    const rule = css.match(/\.holaf-viewer-fullscreen-icon:focus-visible\s*\{([\s\S]*?)\}/);
    assert.ok(rule, "règle :focus-visible scopée au badge attendue dans holaf_image_viewer.css");
    assert.ok(/opacity:\s*1/.test(rule[1]),
        "le badge (opacity:0 au repos) devient VISIBLE quand il a le focus clavier");
    assert.ok(/outline:\s*2px solid var\(--aih-accent-active/.test(rule[1]),
        "anneau de focus de l'accent (aucune couleur codée en dur), même style que le pack");
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(rule[1]), "aucune couleur hexadécimale dans la règle de focus");
    ok("galerie : role/tabindex/aria-label + Entrée & Espace (Espace annulé) + focus visible scopé");
}

/* ══ 10. Contrôles négatifs PAR MUTATION ═══════════════════════════════ */
console.log("10. contrôles négatifs par mutation (glyphe, title, clavier, statut, libellé mêlé, périmètre)");
{
    for (const f of readdirSync(HERE)) {
        if (/^\.__mut5_\d+_[a-z_]+\.mjs$/.test(f)) rmSync(join(HERE, f), { force: true });
    }

    let seq = 0;
    /** Écrit un mutant de `rel` dans js/, exécute `check`, puis le supprime. */
    async function mutant(rel, label, mutate, check) {
        const src = read(rel);
        const mutated = mutate(src);
        assert.notStrictEqual(mutated, src, `mutation « ${label} » sans effet (ancre introuvable)`);
        const file = join(HERE, `.__mut5_${++seq}_${rel.split("/").pop().replace(/\.js$/, "")}.mjs`);
        writeFileSync(file, mutated, "utf8");
        let failure = null;
        try {
            await check(file, mutated);
        } catch (e) {
            failure = e;
        } finally {
            rmSync(file, { force: true });
            clearBody();
        }
        assert.ok(failure, `mutation « ${label} » NON détectée (le contrat reste vert) → contrôle négatif vacant`);
        return failure.message;
    }

    /* (a) 🗑 réintroduit dans la corbeille d'un membre (au lieu de l'icône). */
    const msgTrash = await mutant("js/aih_menu.js", "« 🗑 » réintroduit dans la corbeille",
        (s) => s.replace(
            'padding:2px 4px;display:inline-flex;align-items:center;justify-content:center;">${aihIconSvg("trash", { size: 13 })}</button>',
            'padding:2px 4px;">🗑</button>'
        ),
        async (file) => {
            const mutantSrc = readFileSync(file, "utf8");
            assert.ok(!stripComments(mutantSrc).includes("🗑"),
                "mutant : le glyphe « 🗑 » est réapparu dans le code");
            assertLotSource((rel) => (rel === "js/aih_menu.js" ? mutantSrc : read(rel)));
        }
    );
    ok(`« 🗑 » réintroduit → ROUGE (${msgTrash.split("\n")[0].slice(0, 70)})`);

    /* (b) `title` retiré du bouton-icône de suppression d'un membre. */
    const msgTitle = await mutant("js/aih_menu.js", "title du bouton supprimer retiré",
        (s) => s.replace(' title="${t("menu.del")}"', ""),
        async (file) => {
            assertLotSource((rel) => (rel === "js/aih_menu.js" ? readFileSync(file, "utf8") : read(rel)));
        }
    );
    ok(`title retiré d'un bouton-icône → ROUGE (${msgTitle.split("\n")[0].slice(0, 70)})`);

    /* (c) aria-label retiré de l'indicateur client-side (et de l'erreur). */
    const msgAria = await mutant("js/aih_menu.js", "aria-label de l'indicateur client-side retiré",
        (s) => s.replace('role="img" aria-label="${escapeHtml(clientLabel)}" title="${escapeHtml(clientLabel)}"',
            'title="${escapeHtml(clientLabel)}"'),
        async (file) => {
            assertLotSource((rel) => (rel === "js/aih_menu.js" ? readFileSync(file, "utf8") : read(rel)));
        }
    );
    ok(`aria-label retiré (rôle de l'icône) → ROUGE (${msgAria.split("\n")[0].slice(0, 70)})`);

    /* (d) Badge plein écran sans `tabindex` (plus atteignable au clavier). */
    const msgTab = await mutant("js/image_viewer/image_viewer_gallery.js", "badge sans tabindex",
        (s) => s.replace("fsIcon.setAttribute('tabindex', '0');", ""),
        async (file) => {
            const src = readFileSync(file, "utf8");
            const addSrc = src.match(/function addFullscreenIcon\([\s\S]*?\n\}/)[0];
            const add = new Function("aihIconSvg", "t", `${addSrc}\nreturn addFullscreenIcon;`)(
                icons.aihIconSvg, (k) => I18n.t(k));
            const ph = window.document.createElement("div");
            window.document.body.appendChild(ph);
            add(ph, { path_canon: "m" });
            const b = ph.querySelector(".holaf-viewer-fullscreen-icon");
            assert.strictEqual(b.getAttribute("tabindex"), "0",
                "mutant : le badge n'est plus atteignable au clavier (tabindex absent)");
        }
    );
    ok(`badge sans tabindex → ROUGE (${msgTab.split("\n")[0].slice(0, 70)})`);

    /* (e) Badge privé de son activation clavier. */
    const msgKey = await mutant("js/image_viewer/image_viewer_gallery.js", "badge sans activation clavier",
        (s) => s.replace(
            "            if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;",
            "            return;"
        ),
        async (file) => {
            const src = readFileSync(file, "utf8");
            const addSrc = src.match(/function addFullscreenIcon\([\s\S]*?\n\}/)[0];
            const add = new Function("aihIconSvg", "t", `${addSrc}\nreturn addFullscreenIcon;`)(
                icons.aihIconSvg, (k) => I18n.t(k));
            const ph = window.document.createElement("div");
            window.document.body.appendChild(ph);
            add(ph, { path_canon: "m" });
            const b = ph.querySelector(".holaf-viewer-fullscreen-icon");
            const seen = [];
            ph.addEventListener("click", () => seen.push(1));
            b.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
            assert.deepStrictEqual(seen, [1],
                "mutant : Entrée n'active plus le badge (aucun clic délégué) → la garde clavier est vacante");
        }
    );
    ok(`badge sans activation clavier → ROUGE (${msgKey.split("\n")[0].slice(0, 70)})`);

    /* (f) STATUT de aih_workflow_share migré par erreur (✅ → icône). */
    const msgStatus = await mutant("js/aih_workflow_share.js", "statut ✅ remplacé par une icône",
        (s) => s.replace('r.status.textContent = status === "overwritten" ? "♻️" : "✅";',
            'r.status.innerHTML = status === "overwritten" ? "♻️" : iconSlot("check", 12);'),
        async (file) => {
            assertLotSource((rel) => (rel === "js/aih_workflow_share.js" ? readFileSync(file, "utf8") : read(rel)));
        }
    );
    ok(`statut ✅ migré par erreur → ROUGE (${msgStatus.split("\n")[0].slice(0, 70)})`);

    /* (g) Libellé mêlé AMPUTÉ (texte modifié). */
    const msgLabel = await mutant("js/holaf_resolution_preset_v2.js", "libellé mêlé amputé",
        (s) => s.replace('on: "Use Image Ratio : ON"', 'on: "Image Ratio : ON"'),
        async (file) => {
            assertLotSource((rel) => (rel === "js/holaf_resolution_preset_v2.js" ? readFileSync(file, "utf8") : read(rel)));
        }
    );
    ok(`libellé mêlé amputé → ROUGE (${msgLabel.split("\n")[0].slice(0, 70)})`);

    /* (h) Clé i18n retirée en EN (parité cassée) — contrôle direct du contrat. */
    {
        const dict = read("js/aih_strings.js");
        const mutated = dict.replace(/\n\s*"rw\.detail\.show": "[^"]+",/, "\n");
        assert.notStrictEqual(mutated, dict, "mutation « clé EN retirée » sans effet");
        const count = (src, key) => [...src.matchAll(new RegExp(`"${key}"\\s*:`, "g"))].length;
        assert.strictEqual(count(mutated, "rw.detail.show"), 1,
            "mutant : la clé rw.detail.show n'existe plus qu'en FR (la garde de parité doit mordre)");
        let caught = null;
        try {
            for (const key of ["rw.detail.show", "rw.detail.hide", "wf.openNodeRepo"]) {
                const hits = [...mutated.matchAll(new RegExp(`"${key.replace(/\./g, "\\.")}"\\s*:\\s*"([^"]+)"`, "g"))];
                assert.strictEqual(hits.length, 2, `clé « ${key} » absente dans une des deux langues`);
            }
        } catch (e) {
            caught = e;
        }
        assert.ok(caught, "parité FR/EN cassée NON détectée → garde vacante");
        ok(`clé i18n EN retirée → ROUGE (${caught.message.split("\n")[0].slice(0, 70)})`);
    }

    /* (i) Consommation de la façade hors liste blanche. */
    {
        const probe = join(HERE, ".__mut5_forbidden_consumer.js");
        writeFileSync(probe,
            '// mutant : consommation hors périmètre (fichier hors phases)\n' +
            'import { aihIconSvg } from "./aih_icons.js";\n' +
            'export const x = aihIconSvg("info");\n', "utf8");
        let caught = null;
        try {
            const r = checkIconPerimetre(PACKAGE_DIR, "2c");
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

    // Aucun mutant résiduel, fichiers du lot intacts.
    assert.deepStrictEqual(readdirSync(HERE).filter((f) => f.startsWith(".__mut5_")), [],
        "aucun mutant ne doit rester sur le disque");
    for (const rel of PHASE_2C_CONSUMERS) {
        assert.ok(read(rel).includes("aihIconSvg"), `${rel} : la façade est toujours appelée après les mutants`);
    }
    ok("fichiers du lot intacts, aucun mutant résiduel");
}

console.log(`\n✅ test_aih_icons_phase2c : ${n} groupes PASSENT`);
process.exit(0);
