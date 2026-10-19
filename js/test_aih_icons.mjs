// Test de la FAÇADE d'icônes du pack (js/aih_icons.js) au-dessus de la brique
// vendorisée js/vendor/holaf/holaf-icons.js (holaf-lib v0.1.7).
// Usage : node js/test_aih_icons.mjs   (jsdom résolu par test_helpers/jsdom_loader.mjs ;
//         introuvable = SKIP bruyant, exit 2 — jamais compté PASS)
//
// Ce qui est verrouillé ici (PHASE 1 de la migration d'icônes : le socle, sans
// AUCUN changement visuel) :
//   1. VENDORISATION : la brique est bien une copie pinnée de holaf-lib 0.1.7
//      (fichier présent + manifest vendorisé + version de l'en-tête), et
//      `list()` est non vide et contient les 21 icônes ajoutées en 0.1.7.
//   2. CHAÎNE : `aihIconSvg` produit un SVG 24×24 valide (viewBox, fill none,
//      stroke currentColor, stroke-width 2), applique `size` et `class`, et
//      reste STRUCTURELLEMENT identique au rendu de la brique (aucune copie
//      locale du contrat : attributs et tracés viennent de la brique).
//   3. DOM : `aihIconEl` produit <span class="aih-icon"> + un `<svg>` enfant ;
//      DÉCORATIF par défaut (aria-hidden, pas de role) et LABELLISÉ avec
//      `label` (role=img + aria-label, sans aria-hidden) ; aucune feuille de
//      style injectée, aucun style inline.
//   4. CACHE : le corps SVG n'est extrait QU'UNE fois par nom (espion sur
//      HolafIcons.get) — le parse n'est pas refait à chaque rendu.
//   5. DÉGRADATION SÛRE : nom inconnu → AUCUNE exception, chaîne vide pour le
//      rendu texte, span VIDE et inerte pour le rendu DOM, un seul
//      avertissement par nom (console.warn dédupliqué).
//   6. CHARGEMENT EN MODULE sans DOM : le module s'importe et rend des chaînes
//      en Node ; `aihIconEl` y échoue avec un message clair (jamais un
//      ReferenceError opaque).
//   7. PÉRIMÈTRE DE CONSOMMATION : la façade n'est branchée QUE dans les
//      fichiers explicitement autorisés (liste blanche de
//      test_helpers/icon_perimeter.mjs). Toute consommation hors liste — et
//      plus encore dans un fichier INTERDIT (blobby_companion, elements_seed,
//      keywords_widget, holaf_shortcuts) — est ROUGE. ⚠️ Ce garde-fou a été
//      introduit en PHASE 1 (liste vide) puis élargi en PHASE 2a aux 7
//      fichiers du lot : c'est son rôle, et il se met à jour EN MÊME TEMPS que
//      le branchement, jamais après.
//   8. CONTRÔLES NÉGATIFS PAR MUTATION (le vérificateur n'est pas vacant) :
//      wrapper cassé → ROUGE, attribut aria inversé → ROUGE, throw non rattrapé
//      → ROUGE, cache retiré → ROUGE, consommateur hors liste → ROUGE. Les
//      mutants sont écrits dans un fichier temporaire de js/ (imports relatifs
//      valides), importés, puis supprimés.
//
// Code de sortie : 0 = PASS, 2 = SKIP, 1 = FAIL.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";
import {
    PHASE_2A_CONSUMERS,
    FORBIDDEN_CONSUMERS,
    checkIconPerimetre,
} from "./test_helpers/icon_perimeter.mjs";
import { HolafIcons } from "./vendor/holaf/holaf-icons.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HERE, "..");

const JSDOM = await loadJsdomOrSkip("test_aih_icons");

const dom = new JSDOM(`<!doctype html><html><head></head><body></body></html>`, {
    pretendToBeVisual: true,
    url: "http://localhost/",
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;

const parser = new window.DOMParser();
const icons = await import("./aih_icons.js");

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

// Parse un SVG en document SVG (parsererror détecté = XML invalide).
function parseSvg(svgText) {
    return parser.parseFromString(String(svgText || ""), "image/svg+xml");
}
function assertValidSvg(svgText, ctx) {
    const doc = parseSvg(svgText);
    assert.strictEqual(
        doc.getElementsByTagName("parsererror").length, 0,
        `${ctx} : SVG non valide → ${String(svgText).slice(0, 120)}`
    );
    const root = doc.documentElement;
    assert.strictEqual(root.tagName.toLowerCase(), "svg", `${ctx} : racine <svg> attendue`);
    return root;
}
// Dictionnaire d'attributs (comparaison insensible à l'ORDRE des attributs).
function attrMap(el) {
    const m = {};
    for (const a of Array.from(el.attributes)) m[a.name] = a.value;
    return m;
}

/* ══ 1. Vendorisation : copie pinnée de holaf-lib 0.1.7 ══════════════════ */
console.log("1. vendorisation de la brique (holaf-lib 0.1.7)");
{
    const brickPath = join(HERE, "vendor", "holaf", "holaf-icons.js");
    const brickSrc = readFileSync(brickPath, "utf8");
    assert.ok(/HolafIcons · version 0\.1\.7/.test(brickSrc),
        "en-tête de la brique vendorisée : version 0.1.7 attendue");
    assert.strictEqual(HolafIcons.version, "0.1.7", "version exposée par la brique");

    const manifestPath = join(HERE, "vendor", "holaf", "holaf-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.strictEqual(manifest.icons, "0.1.7", "manifest vendorisé : icons doit être en 0.1.7");
    assert.strictEqual(Object.keys(manifest).length, 10,
        "le manifest doit lister les 10 briques (9 historiques + icons)");
    ok("brique + manifest vendorisés en 0.1.7 (10 briques au manifest)");

    const names = icons.aihIconNames();
    assert.ok(Array.isArray(names) && names.length > 0, "aihIconNames() ne doit pas être vide");
    assert.strictEqual(names.length, 114, `114 icônes attendues, reçu ${names.length}`);
    assert.strictEqual(names.length, HolafIcons.list().length, "aihIconNames() doit refléter la brique");
    assert.notStrictEqual(names, HolafIcons.list(), "aihIconNames() doit renvoyer une COPIE");

    // Les 21 icônes ajoutées en 0.1.7 (migration d'icônes d'AI-Helper).
    const NOUVELLES_071 = [
        "lock", "lock-open", "ban", "users", "message-square", "heart", "monitor",
        "video", "filter", "tag", "shuffle", "dices", "crosshair", "circle",
        "grip-vertical", "eraser", "loader", "skip-forward", "syringe", "recycle",
        "scaling",
    ];
    assert.strictEqual(NOUVELLES_071.length, 21, "la liste de contrôle doit contenir 21 noms");
    const manquantes = NOUVELLES_071.filter((x) => !names.includes(x));
    assert.deepStrictEqual(manquantes, [], "icônes 0.1.7 manquantes : " + manquantes.join(", "));
    ok(`aihIconNames() : ${names.length} icônes, les 21 ajouts de 0.1.7 présents`);
}

/* ══ 2. aihIconSvg : contrat du SVG (chaîne) ═════════════════════════════ */
console.log("2. aihIconSvg — SVG 24×24 valide, size/class, fidèle à la brique");
{
    const svg = icons.aihIconSvg("search");
    const root = assertValidSvg(svg, "aihIconSvg(search)");
    assert.strictEqual(root.getAttribute("viewBox"), "0 0 24 24", "viewBox 0 0 24 24");
    assert.strictEqual(root.getAttribute("fill"), "none", 'fill="none"');
    assert.strictEqual(root.getAttribute("stroke"), "currentColor", 'stroke="currentColor"');
    assert.strictEqual(root.getAttribute("stroke-width"), "2", 'stroke-width="2"');
    assert.strictEqual(root.getAttribute("stroke-linecap"), "round", 'stroke-linecap="round"');
    assert.strictEqual(root.getAttribute("stroke-linejoin"), "round", 'stroke-linejoin="round"');
    assert.strictEqual(root.getAttribute("xmlns"), "http://www.w3.org/2000/svg", "xmlns SVG");
    assert.ok(root.childNodes.length > 0, "le corps (tracés) ne doit pas être vide");
    // Taille par défaut = AIH_ICON_DEFAULT_SIZE (16), pas 24.
    assert.strictEqual(root.getAttribute("width"), String(icons.AIH_ICON_DEFAULT_SIZE), "width par défaut");
    assert.strictEqual(root.getAttribute("height"), String(icons.AIH_ICON_DEFAULT_SIZE), "height par défaut");
    assert.strictEqual(icons.AIH_ICON_DEFAULT_SIZE, 16, "taille par défaut = 16 px");
    assert.strictEqual(root.getAttribute("class"), null, "aucune classe si non fournie");
    ok("SVG valide : 24×24, fill none, stroke currentColor, stroke-width 2, 16 px par défaut");

    // size + class appliqués (class → attribut du <svg>, comme la brique).
    const big = assertValidSvg(icons.aihIconSvg("search", { size: 24, class: "aih-ic aih-ic--lg" }), "size/class");
    assert.strictEqual(big.getAttribute("width"), "24", "width = size");
    assert.strictEqual(big.getAttribute("height"), "24", "height = size");
    assert.strictEqual(big.getAttribute("class"), "aih-ic aih-ic--lg", "class transmise au <svg>");
    ok("size et class appliqués (width/height = size, class sur le <svg>)");

    // Taille invalide → défaut (jamais NaN / 0 / négatif dans le DOM).
    for (const bad of [0, -5, NaN, "abc", null, undefined, Infinity]) {
        const r = assertValidSvg(icons.aihIconSvg("search", { size: bad }), `size=${String(bad)}`);
        assert.strictEqual(r.getAttribute("width"), "16", `size=${String(bad)} doit retomber sur 16`);
    }
    ok("size invalide (0, négatif, NaN, texte, Infinity) → repli sur 16");

    // FIDÉLITÉ : mêmes attributs (hors width/height/class) et même corps que la brique.
    for (const name of ["search", "lock", "recycle", "sparkles"]) {
        const facade = attrMap(assertValidSvg(icons.aihIconSvg(name, { size: 20 }), name));
        const brick = attrMap(assertValidSvg(HolafIcons.render(name, { size: 20 }), name));
        const strip = (m) => { const c = { ...m }; delete c.width; delete c.height; delete c.class; return c; };
        assert.deepStrictEqual(strip(facade), strip(brick), `attributs divergents pour « ${name} »`);
        const facadeRoot = parseSvg(icons.aihIconSvg(name, { size: 20 })).documentElement;
        const brickRoot = parseSvg(HolafIcons.render(name, { size: 20 })).documentElement;
        assert.strictEqual(facadeRoot.innerHTML, brickRoot.innerHTML, `tracés divergents pour « ${name} »`);
    }
    ok("attributs et tracés identiques au rendu de la brique (4 icônes, dont 2 de la vague 0.1.7)");
}

/* ══ 3. aihIconEl : élément DOM + aria + zéro CSS ════════════════════════ */
console.log("3. aihIconEl — <span class=aih-icon> + aria (décoratif / labellisé)");
{
    const stylesBefore = document.querySelectorAll("style").length;

    const deco = icons.aihIconEl("search");
    assert.strictEqual(deco.tagName, "SPAN", "un <span> est attendu");
    assert.ok(deco.classList.contains("aih-icon"), 'classe « aih-icon » attendue');
    assert.strictEqual(deco.getAttribute("aria-hidden"), "true", "icône décorative : aria-hidden=true");
    assert.strictEqual(deco.getAttribute("role"), null, "icône décorative : pas de role");
    assert.strictEqual(deco.getAttribute("aria-label"), null, "icône décorative : pas d'aria-label");
    assert.strictEqual(deco.childNodes.length, 1, "un seul enfant : le <svg>");
    const svgEl = deco.firstElementChild;
    assert.strictEqual(svgEl.tagName.toLowerCase(), "svg", "l'enfant doit être un <svg> (namespace SVG)");
    assert.strictEqual(svgEl.namespaceURI, "http://www.w3.org/2000/svg", "namespace SVG");
    assert.strictEqual(svgEl.getAttribute("viewBox"), "0 0 24 24", "viewBox du <svg> enfant");
    assert.strictEqual(svgEl.getAttribute("stroke"), "currentColor", "stroke currentColor");
    assert.strictEqual(svgEl.getAttribute("width"), "16", "width par défaut");
    assert.ok(svgEl.childNodes.length > 0, "tracés présents dans le <svg>");
    assert.strictEqual(svgEl.getAttribute("aria-hidden"), "true", "le <svg> est décoratif dans les 2 cas");
    assert.strictEqual(svgEl.getAttribute("focusable"), "false", "le <svg> n'est pas focusable");
    assert.strictEqual(deco.getAttribute("data-aih-icon"), "search", "data-aih-icon = nom demandé");
    ok("décoratif : span aria-hidden, sans role, un <svg> décoratif à l'intérieur");

    const lab = icons.aihIconEl("search", { label: "Rechercher", title: "Rechercher dans la liste" });
    assert.strictEqual(lab.getAttribute("role"), "img", 'labellisé : role="img"');
    assert.strictEqual(lab.getAttribute("aria-label"), "Rechercher", "labellisé : aria-label = label");
    assert.strictEqual(lab.getAttribute("aria-hidden"), null, "labellisé : PAS d'aria-hidden");
    assert.strictEqual(lab.getAttribute("title"), "Rechercher dans la liste", "title = infobulle native");
    assert.strictEqual(lab.children.length, 1, "labellisé : le <svg> reste présent");
    assert.strictEqual(lab.firstElementChild.getAttribute("aria-hidden"), "true",
        "le <svg> interne reste décoratif (le sens est porté par le span)");
    // label vide / espaces → décoratif (pas de role=img vide, interdit).
    for (const empty of ["", "   ", null, undefined]) {
        const e = icons.aihIconEl("search", { label: empty });
        assert.strictEqual(e.getAttribute("role"), null, "label vide → décoratif");
        assert.strictEqual(e.getAttribute("aria-hidden"), "true", "label vide → aria-hidden");
    }
    ok('labellisé : role="img" + aria-label, sans aria-hidden ; label vide → décoratif');

    const sized = icons.aihIconEl("lock", { size: 22, class: "aih-ic--lock" });
    const sizedSvg = sized.firstElementChild;
    assert.strictEqual(sizedSvg.getAttribute("width"), "22", "width = size");
    assert.strictEqual(sizedSvg.getAttribute("height"), "22", "height = size");
    assert.strictEqual(sizedSvg.getAttribute("class"), "aih-ic--lock", "class transmise au <svg>");
    ok("size et class appliqués au <svg> de l'élément");

    // AUCUN CSS injecté, aucun style inline (la couleur vient de currentColor).
    assert.strictEqual(document.querySelectorAll("style").length, stylesBefore,
        "la façade ne doit injecter AUCUNE feuille de style");
    for (const el of [deco, lab, sized, deco.firstElementChild, sized.firstElementChild]) {
        assert.strictEqual(el.getAttribute("style"), null, "aucun style inline injecté");
    }
    ok("aucun <style> injecté, aucun style inline (couleur via currentColor)");
}

/* ══ 4. Cache : le corps SVG n'est extrait qu'une fois par nom ═══════════ */
console.log("4. cache des corps SVG (un seul parse par nom)");
{
    // Nom JAMAIS rendu plus haut → cache vierge pour lui dans ce module.
    const NAME = "syringe";
    const realGet = HolafIcons.get;
    let calls = 0;
    HolafIcons.get = function (name) { calls++; return realGet.call(this, name); };
    let first, second, el1, el2;
    try {
        first = icons.aihIconSvg(NAME);
        second = icons.aihIconSvg(NAME, { size: 32, class: "x" }); // autre taille/classe
        el1 = icons.aihIconEl(NAME);
        el2 = icons.aihIconEl(NAME, { label: "Recycler" });
    } finally {
        HolafIcons.get = realGet;
    }
    assert.strictEqual(calls, 1, `4 rendus du même nom doivent coûter UN parse, reçu ${calls}`);
    assert.ok(first && second && el1.children.length === 1 && el2.children.length === 1,
        "les 4 rendus doivent produire un SVG");
    // Le cache survit à la restauration de l'espion (jamais invalidé).
    let after = 0;
    HolafIcons.get = function (name) { after++; return realGet.call(this, name); };
    try { icons.aihIconSvg(NAME); icons.aihIconEl(NAME); } finally { HolafIcons.get = realGet; }
    assert.strictEqual(after, 0, "le cache doit être permanent (table d'icônes statique)");
    ok("1 seul appel à la brique pour 4 rendus (tailles/classes/aria différents) puis 0 (cache permanent)");
}

/* ══ 5. Dégradation sûre : nom inconnu ═══════════════════════════════════ */
console.log("5. dégradation sûre sur nom inconnu (jamais de throw dans l'UI)");
{
    const origWarn = console.warn;
    const warns = [];
    console.warn = (...a) => { warns.push(a.join(" ")); };
    let svgText, inert;
    try {
        svgText = icons.aihIconSvg("pas-une-icone-xyz");   // la brique lèverait ici
        inert = icons.aihIconEl("pas-une-icone-xyz");
    } finally {
        console.warn = origWarn;
    }
    assert.strictEqual(svgText, "", "nom inconnu → chaîne VIDE (pas de throw)");
    assert.strictEqual(inert.tagName, "SPAN", "nom inconnu → le <span> existe quand même");
    assert.ok(inert.classList.contains("aih-icon"), "nom inconnu → conteneur stable « aih-icon »");
    assert.strictEqual(inert.childNodes.length, 0, "nom inconnu → span VIDE (aucune icône)");
    assert.strictEqual(inert.getAttribute("aria-hidden"), "true", "nom inconnu → décoratif");
    assert.strictEqual(inert.getAttribute("data-aih-icon"), "pas-une-icone-xyz", "nom demandé conservé");
    assert.strictEqual(warns.length, 1, `un seul avertissement attendu (dédupliqué), reçu ${warns.length}`);
    assert.ok(/^\[aih_icons\].*pas-une-icone-xyz/.test(warns[0]), "avertissement explicite : " + warns[0]);
    assert.ok(warns[0].length < 400, "l'avertissement ne doit pas déverser les 114 noms");
    ok("nom inconnu : chaîne vide + span vide inerte + 1 avertissement dédupliqué et borné");

    // Nom vide / non-chaîne : même dégradation, sans throw.
    // (Avertissements déjà couverts ci-dessus : on les tait pour un journal lisible.)
    const warnBak = console.warn;
    console.warn = () => {};
    try {
        for (const bad of ["", "   ", null, undefined, 42, {}]) {
            assert.strictEqual(icons.aihIconSvg(bad), "", `nom ${String(bad)} → ""`);
            assert.strictEqual(icons.aihIconEl(bad).childNodes.length, 0, `nom ${String(bad)} → span vide`);
        }
    } finally {
        console.warn = warnBak;
    }
    ok("nom vide / null / non-chaîne : rendu inerte, aucune exception");
}

/* ══ 6. Chargement en MODULE, sans DOM (Node) ════════════════════════════ */
console.log("6. import ESM sans DOM (Node) : chaînes OK, aihIconEl échoue clairement");
{
    const code = `
        import("./aih_icons.js").then((m) => {
            const svg = m.aihIconSvg("search", { size: 18 });
            if (!/viewBox="0 0 24 24"/.test(svg)) { console.log("KO no-viewbox"); process.exit(3); }
            if (m.aihIconNames().length !== 114) { console.log("KO names"); process.exit(3); }
            let msg = "";
            try { m.aihIconEl("search"); } catch (e) { msg = String(e && e.message || e); }
            if (!/DOM/.test(msg)) { console.log("KO no-dom-error:" + msg); process.exit(3); }
            console.log("OK");
        });
    `;
    const out = execFileSync(process.execPath, ["-e", code], { cwd: HERE, encoding: "utf8" }).trim();
    assert.strictEqual(out, "OK", "import sans DOM : " + out);
    ok("module importable sans DOM (SVG en chaîne) ; aihIconEl y échoue avec un message explicite");
}

/* ══ 7. Périmètre : la façade n'est consommée QUE là où c'est décidé ═════ */
console.log("7. périmètre de consommation (phase 2a) : liste blanche stricte");
{
    const r = checkIconPerimetre(PACKAGE_DIR);

    // (a) Aucun fichier INTERDIT ne consomme la façade — la faute la plus grave
    //     (emoji sémantiques / lot suivant déjà asserté par un test).
    assert.deepStrictEqual(r.interdits, [],
        "fichier(s) INTERDIT(S) consommant la façade : " + r.interdits.join(", "));

    // (b) Aucune consommation hors de la liste blanche du lot en cours.
    assert.deepStrictEqual(r.horsListe, [],
        "consommateur(s) hors périmètre (phase 2a) : " + r.horsListe.join(", "));

    // (c) Les fichiers du lot consomment RÉELLEMENT la façade (sinon la liste
    //     blanche ne prouverait rien : une garde vide est une garde vacante).
    assert.deepStrictEqual(r.manquants, [],
        "fichier(s) du lot ne consommant pas la façade : " + r.manquants.join(", "));

    // (d) La liste blanche et la liste interdite ne se recoupent pas.
    const recoupement = PHASE_2A_CONSUMERS.filter((f) => FORBIDDEN_CONSUMERS.includes(f));
    assert.deepStrictEqual(recoupement, [],
        "fichier(s) à la fois autorisés et interdits : " + recoupement.join(", "));

    ok(`périmètre respecté : ${r.offenders.length} consommateur(s) = les ${PHASE_2A_CONSUMERS.length} du lot, ` +
        `aucun interdit (${FORBIDDEN_CONSUMERS.length} surveillés)`);
    assert.ok(readFileSync(join(HERE, "aih_icons.js"), "utf8").length > 0, "façade lisible");
}

/* ══ 8. Contrôles négatifs PAR MUTATION (le vérificateur mord) ════════════ */
console.log("8. contrôles négatifs par mutation (wrapper, aria, throw, cache, périmètre)");
{
    const SRC = readFileSync(join(HERE, "aih_icons.js"), "utf8");

    // Contrat minimal rejoué sur chaque mutant : si le mutant le satisfait
    // encore, la mutation n'a pas été détectée → le vérificateur est vacant.
    async function contractOf(mod) {
        const svgText = mod.aihIconSvg("search", { size: 20, class: "ic-x" });
        const root = parseSvg(svgText).documentElement;
        assert.strictEqual(parseSvg(svgText).getElementsByTagName("parsererror").length, 0,
            "mutant : SVG non valide (wrapper cassé)");
        assert.strictEqual(root.tagName.toLowerCase(), "svg", "mutant : racine <svg>");
        assert.strictEqual(root.getAttribute("viewBox"), "0 0 24 24", "mutant : viewBox");
        assert.strictEqual(root.getAttribute("width"), "20", "mutant : width");
        assert.strictEqual(root.getAttribute("class"), "ic-x", "mutant : class");
        assert.ok(root.childNodes.length > 0, "mutant : corps vide");

        const deco = mod.aihIconEl("search");
        assert.strictEqual(deco.getAttribute("aria-hidden"), "true", "mutant : décoratif sans aria-hidden");
        assert.strictEqual(deco.getAttribute("role"), null, "mutant : décoratif avec role");

        const lab = mod.aihIconEl("search", { label: "Rechercher" });
        assert.strictEqual(lab.getAttribute("role"), "img", "mutant : labellisé sans role=img");
        assert.strictEqual(lab.getAttribute("aria-label"), "Rechercher", "mutant : aria-label");
        assert.strictEqual(lab.getAttribute("aria-hidden"), null, "mutant : labellisé aria-hidden");

        assert.strictEqual(mod.aihIconSvg("nope-mutant-zzz"), "", "mutant : nom inconnu non dégradé");
        assert.strictEqual(mod.aihIconEl("nope-mutant-zzz").childNodes.length, 0,
            "mutant : span non vide sur nom inconnu");

        const realGet = HolafIcons.get;
        let calls = 0;
        HolafIcons.get = function (name) { calls++; return realGet.call(this, name); };
        try {
            mod.aihIconSvg("shield");
            mod.aihIconSvg("shield", { size: 40 });
            mod.aihIconEl("shield");
        } finally {
            HolafIcons.get = realGet;
        }
        assert.strictEqual(calls, 1, `mutant : cache inopérant (${calls} parses)`);
    }

    // Nettoyage d'un éventuel résidu d'une exécution interrompue.
    for (const f of readdirSync(HERE)) {
        if (/^\.__mut_\d+_aih_icons\.mjs$/.test(f)) rmSync(join(HERE, f), { force: true });
    }

    let seq = 0;
    async function expectMutantRed(label, mutate) {
        const mutated = mutate(SRC);
        assert.notStrictEqual(mutated, SRC, `mutation « ${label} » sans effet (ancre introuvable)`);
        const file = join(HERE, `.__mut_${++seq}_aih_icons.mjs`);
        writeFileSync(file, mutated, "utf8");
        let failure = null;
        const origWarn = console.warn;
        console.warn = () => {};
        try {
            const mod = await import("file://" + file + "?m=" + seq);
            await contractOf(mod);
        } catch (e) {
            failure = e;
        } finally {
            console.warn = origWarn;
            rmSync(file, { force: true });
        }
        assert.ok(failure,
            `mutation « ${label} » NON détectée (le contrat reste vert) → contrôle négatif vacant`);
        return failure.message;
    }

    const msgWrapper = await expectMutantRed("wrapper cassé", (s) =>
        s.replace("</svg>`;", "`;")                       // oublie la fermeture </svg>
    );
    ok(`wrapper cassé → ROUGE (${msgWrapper.split("\n")[0].slice(0, 70)})`);

    const msgAria = await expectMutantRed("aria inversé", (s) =>
        s.replace("if (label) {", "if (!label) {")        // décoratif ↔ labellisé inversés
    );
    ok(`aria inversé → ROUGE (${msgAria.split("\n")[0].slice(0, 70)})`);

    const msgThrow = await expectMutantRed("throw non rattrapé", (s) =>
        s.replace('_warn(key, (err && err.message) || "nom inconnu");', "throw err;")
    );
    ok(`throw non rattrapé → ROUGE (${msgThrow.split("\n")[0].slice(0, 70)})`);

    const msgCache = await expectMutantRed("cache retiré", (s) =>
        s.replace("const hit = _cache.get(key);", "const hit = null;")
    );
    ok(`cache retiré → ROUGE (${msgCache.split("\n")[0].slice(0, 70)})`);

    // Périmètre : un fichier d'UI HORS liste blanche (ici l'équivalent d'un
    // fichier interdit comme blobby_companion) qui consomme la façade doit
    // faire ROUGE. Sinon la liste blanche de la section 7 serait vacante.
    {
        const probe = join(HERE, ".__mut_forbidden_consumer.js");
        writeFileSync(probe,
            '// mutant : consommation interdite de la façade\n' +
            'import { aihIconSvg } from "./aih_icons.js";\n' +
            'export const x = aihIconSvg("info");\n', "utf8");
        let caught = null;
        try {
            const r = checkIconPerimetre(PACKAGE_DIR);
            assert.deepStrictEqual(r.horsListe, [],
                "consommateur hors périmètre : " + r.horsListe.join(", "));
        } catch (e) {
            caught = e;
        } finally {
            rmSync(probe, { force: true });
        }
        assert.ok(caught, "consommation hors liste blanche NON détectée → garde vacante");
        assert.ok(/__mut_forbidden_consumer/.test(caught.message),
            "le rouge doit nommer le fichier fautif : " + caught.message.split("\n")[0]);
        ok(`consommation hors liste blanche → ROUGE (${caught.message.split("\n")[0].slice(0, 70)})`);
    }

    // Le fichier source n'a évidemment pas bougé.
    assert.strictEqual(readFileSync(join(HERE, "aih_icons.js"), "utf8"), SRC,
        "le source de la façade ne doit pas être modifié par les mutants");
    assert.deepStrictEqual(
        readdirSync(HERE).filter((f) => f.startsWith(".__mut_")), [],
        "aucun mutant ne doit rester sur le disque"
    );
    ok("façade intacte, aucun fichier mutant résiduel");
}

console.log(`\n✅ test_aih_icons : ${n} groupes PASSENT`);
process.exit(0);
