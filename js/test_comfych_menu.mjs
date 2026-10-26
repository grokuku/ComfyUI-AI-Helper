// ─────────────────────────────────────────────────────────────────────────
// ComfyCH (intégration pack AI-Helper) — visibilité WIP et sous-menu.
//
// Ce que ce test verrouille :
//   (a) feature WIP « comfych » DÉSACTIVÉE → AUCUNE ligne ComfyCH dans le menu
//       AIH (contrôle négatif : c'est l'assertion qui devient rouge si la
//       condition WIP saute) ;
//   (b) feature ACTIVÉE → la ligne « ComfyCH » de la section « Outils & Dev »
//       porte le sélecteur GPU + le bouton ⚙ (fournis par le pont
//       window.AIHComfyCHHost) ;
//   (c) le sélecteur n'est JAMAIS injecté dans la barre d'outils ComfyUI
//       (l'ancien dropdown d'origine doit disparaître de la barre) ;
//   (d) Échap ET clic extérieur referment le menu, y compris depuis la ligne
//       ComfyCH ; un clic DANS la ligne (curseur de réglage) ne le referme pas ;
//   (e) mode de rendu forcé « local » au démarrage : la valeur affichée est
//       local SANS que la préférence enregistrée (localStorage) ne soit
//       réécrite, et l'interception de queuePrompt reste en place (elle délègue
//       simplement à l'implémentation d'origine) ;
//   (f) GÉOMÉTRIE : le popup est mesuré À L'OUVERTURE (et non menu fermé) et
//       son bord droit — contrôles ComfyCH compris — reste DANS la fenêtre.
//       Régression vécue : largeur mesurée 0 → repli sur min-width (150 px),
//       popup poussé hors écran à droite, sélecteur GPU et ⚙ invisibles ;
//   (g) CLIC : cliquer le libellé « ComfyCH » ouvre les réglages (openSettings
//       du pont) sans refermer le menu ; un clic DANS les contrôles (sélecteur)
//       ne déclenche pas la modale. Régression vécue : « cliquer ne fait rien » ;
//   (h) mutants : (1) action de clic retirée → (g) rouge ; (2) mesure faite
//       menu fermé → (f) rouge ; (3) retour au sélecteur générique
//       `li.querySelector('div')` (la ligne ComfyCH prise pour une case à
//       cocher) → contrôles écrasés à l'ouverture, (g) rouge.
//
// Cause première de la régression vécue (« aucun contrôle visible ») :
// js/holaf_main.js, boucle de rafraîchissement des cases à cocher dans
// mainButton.onclick — `li.querySelector('div')` y prenait le conteneur des
// contrôles ComfyCH (#modal-gateway-container) pour une case à cocher et lui
// appliquait `innerHTML = ""` à la PREMIÈRE ouverture du menu.
//
// Usage : node js/test_comfych_menu.mjs
//   jsdom résolu par js/test_helpers/jsdom_loader.mjs ; absent = SKIP (exit 2).
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const JSDOM = await loadJsdomOrSkip("test_comfych_menu");
const dom = new JSDOM(
    "<!doctype html><html><head></head><body><div id=\"comfy-toolbar\"></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" }
);
const { window: domWindow } = dom;
globalThis.window = domWindow;
globalThis.document = domWindow.document;
globalThis.localStorage = domWindow.localStorage;
globalThis.getComputedStyle = domWindow.getComputedStyle.bind(domWindow);
globalThis.HTMLElement = domWindow.HTMLElement;
globalThis.Node = domWindow.Node;
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
try { globalThis.navigator = domWindow.navigator; } catch { /* déjà fourni */ }
domWindow.matchMedia = domWindow.matchMedia
    || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));

localStorage.setItem("aih_locale", "fr");
// Préférence de GPU de l'utilisateur : elle doit RESTER intacte malgré le
// forçage « local » du démarrage (décision utilisateur).
localStorage.setItem("modal-gateway-mode", "modal:h100");

// Réponse de /api/modal/config : le serveur force le mode « local » en mémoire.
globalThis.fetch = async (url) => {
    const body = String(url).includes("/api/modal/config")
        ? { api_url: "", api_key_set: true, render_mode_forced: "local" }
        : {};
    return {
        ok: true, status: 200,
        headers: { get: () => "application/json" },
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
};

// Faux app ComfyUI : une « barre d'outils » contient le bouton Settings, et
// l'API expose queuePrompt (point d'interception de ComfyCH).
const toolbar = document.getElementById("comfy-toolbar");
const settingsButton = document.createElement("button");
settingsButton.id = "comfy-settings-button";
toolbar.appendChild(settingsButton);

let originalQueueCalls = 0;
const fakeApi = {
    queuePrompt(number, workflow, options) {
        originalQueueCalls++;
        return Promise.resolve({ number, workflow, options });
    },
};
// Référence AVANT tout import : ComfyCH installe son interception dès que
// l'API est visible, donc la capture doit précéder les imports.
const pristineQueuePrompt = fakeApi.queuePrompt;
const app = {
    graph: { nodes: [] },
    canvas: {},
    ui: {},
    api: fakeApi,
    extensions: [],
    menu: { settingsGroup: { element: settingsButton } },
    registerExtension(ext) { app.extensions.push(ext); if (!app.ext) app.ext = ext; },
};
globalThis.window.app = app;
domWindow.app = app;
globalThis.app = app;
domWindow.api = fakeApi;
domWindow.comfyAPI = { app: { app } };

/* ══════════════ 1. Le frontend ComfyCH se charge (pont) ══════════════ */
console.log("1. Chargement du module ComfyCH et de son pont");

await import("./comfych_gateway.js");
await import("./comfych/modal_gateway.js");

assert.ok(domWindow.AIHComfyCHHost, "pont window.AIHComfyCHHost exposé");
assert.strictEqual(typeof domWindow.AIHComfyCHHost.buildControls, "function", "buildControls() disponible");
assert.strictEqual(typeof domWindow.AIHComfyCHHost.openSettings, "function", "openSettings() disponible");
ok("pont ComfyCH disponible (buildControls/openSettings)");

/* ══════ 2. Mode de rendu forcé à local, sans écrire la préférence ══════ */
console.log("2. Mode de rendu forcé « local » (en mémoire)");

// Laisse la promesse fetch('/api/modal/config') se résoudre.
await new Promise((r) => setTimeout(r, 30));
assert.strictEqual(
    domWindow.AIHComfyCHHost.currentMode(), "local",
    "le mode effectif doit être « local » au démarrage (forçage serveur)"
);
assert.strictEqual(
    localStorage.getItem("modal-gateway-mode"), "modal:h100",
    "la préférence GPU enregistrée NE DOIT PAS être écrasée par le forçage"
);
ok("mode effectif = local ; préférence « modal:h100 » intacte dans localStorage");

const controls = domWindow.AIHComfyCHHost.buildControls();
assert.ok(controls, "buildControls() retourne un élément");
const gpuSelect = controls.querySelector("#modal-gpu-selector");
const gearButton = controls.querySelector("#modal-settings-btn");
assert.ok(gpuSelect, "sélecteur GPU présent dans les contrôles");
assert.ok(gearButton, "bouton ⚙ présent dans les contrôles");
assert.strictEqual(gpuSelect.value, "local", "le sélecteur affiche le mode forcé (local)");
assert.ok(
    [...gpuSelect.options].some((o) => o.value === "modal:h100"),
    "l'option cloud de l'utilisateur reste proposée (rien n'est supprimé)"
);
ok("contrôles : 🎮 + sélecteur GPU (local) + bouton ⚙");

/* ══════ 3. Aucune injection dans la barre d'outils de ComfyUI ══════ */
console.log("3. Le dropdown d'origine disparaît de la barre d'outils ComfyUI");

for (const ext of app.extensions) {
    if (typeof ext.setup === "function") await ext.setup();
}
await new Promise((r) => setTimeout(r, 120));
assert.strictEqual(
    toolbar.querySelector("#modal-gateway-container"), null,
    "MUTANT : la barre d'outils ne doit plus contenir le conteneur ComfyCH"
);
assert.strictEqual(
    document.getElementById("modal-gateway-container"), null,
    "aucun conteneur ComfyCH monté hors du menu AIH"
);
ok("barre d'outils ComfyUI allégée (aucun #modal-gateway-container)");

/* ══════ 4. Interception de queuePrompt toujours en place ══════ */
console.log("4. Interception du bouton Queue conservée, inactive en mode local");

// L'interception est retentée toutes les CONFIG.RETRY_INTERVAL (800 ms).
await new Promise((r) => setTimeout(r, 1000));
assert.notStrictEqual(
    fakeApi.queuePrompt, pristineQueuePrompt,
    "MUTANT : l'interception de queuePrompt doit rester installée (masqué ≠ désactivé)"
);
await fakeApi.queuePrompt(1, { nodes: [] }, {});
assert.strictEqual(originalQueueCalls, 1, "en mode local, l'implémentation d'origine est appelée");
ok("queuePrompt intercepté puis délégué (mode local = aucune action cloud)");

/* ══════════ 5. WIP désactivée → AUCUNE ligne ComfyCH dans le menu ══════ */
console.log("5. Feature WIP « comfych » désactivée → ligne absente");

await import("./aih_i18n.js");
domWindow.AIH.I18n.setLocale("fr");
await import("./holaf_main.js");

domWindow.holaf = domWindow.holaf || {};
domWindow.holaf.wipManager = { isEnabled: () => false }; // toutes les WIP off
if (typeof domWindow.holaf.rebuildMenu === "function") domWindow.holaf.rebuildMenu();

const menuExt = app.extensions.find((e) => e && e.name === "Holaf.Utilities.Menu");
assert.ok(menuExt, "extension du menu AIH enregistrée");
await menuExt.setup();
// setup() planifie init() via setTimeout(…, 10) : on laisse le tour de boucle.
await new Promise((r) => setTimeout(r, 150));

const mainButton = document.getElementById("holaf-utilities-menu-button");
const dropdown = document.getElementById("holaf-utilities-dropdown-menu");
assert.ok(mainButton, "bouton de menu AIH présent");
assert.ok(dropdown, "menu déroulant AIH présent");
assert.strictEqual(
    document.getElementById("holaf-menu-comfych"), null,
    "MUTANT : la ligne ComfyCH ne doit PAS apparaître quand la feature WIP est désactivée"
);
assert.strictEqual(
    document.querySelector("#holaf-menu-comfych-controls"), null,
    "aucun contrôle ComfyCH dans le menu quand la feature est masquée"
);
ok("feature WIP désactivée → menu sans ComfyCH");

/* ══════════ 6. WIP activée → ligne avec dropdown GPU + bouton ⚙ ══════ */
console.log("6. Feature WIP « comfych » activée → ligne avec contrôles");

domWindow.holaf.wipManager = { isEnabled: (id) => id === "comfych" };
domWindow.holaf.rebuildMenu();
await new Promise((r) => setTimeout(r, 80));

const comfychRow = document.getElementById("holaf-menu-comfych");
assert.ok(comfychRow, "ligne ComfyCH présente quand la feature est activée");
assert.ok(
    comfychRow.textContent.includes("ComfyCH"),
    "la ligne porte le libellé traduit « ComfyCH »"
);
const rowSelect = comfychRow.querySelector("#modal-gpu-selector");
const rowGear = comfychRow.querySelector("#modal-settings-btn");
assert.ok(rowSelect, "sélecteur GPU présent DANS la ligne du menu");
assert.ok(rowGear, "bouton ⚙ présent à droite de la ligne");
assert.ok(
    comfychRow.contains(rowSelect),
    "le sélecteur est bien monté dans la ligne (pas ailleurs)"
);
ok("sous-menu ComfyCH : libellé + sélecteur GPU + bouton ⚙");

// Espion sur l'action de la ligne : elle est câblée par holaf_main.js sur
// window.AIHComfyCHHost.openSettings (les sections 9 et 10 s'appuient dessus).
let openCalls = 0;
domWindow.AIHComfyCHHost.openSettings = () => { openCalls++; };

// Ouvrir le menu puis vérifier qu'un clic dans la ligne ne le referme pas
// (et qu'elle déclenche bien l'action attendue, cf. section 9).
mainButton.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
assert.strictEqual(dropdown.style.display, "block", "menu ouvert");
comfychRow.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
assert.strictEqual(dropdown.style.display, "block", "un clic dans la ligne ComfyCH ne ferme pas le menu");
const toolbarContainer = toolbar.querySelector("#modal-gateway-container");
assert.strictEqual(toolbarContainer, null, "MUTANT : la barre d'outils reste sans ComfyCH (menu ouvert)");
ok("la ligne reste utilisable sans fermer le menu ; barre d'outils toujours allégée");

/* ══════════ 7. Fermeture : Échap et clic extérieur ══════════ */
console.log("7. Fermeture au clavier (Échap) et au clic extérieur");

document.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
assert.strictEqual(dropdown.style.display, "none", "Échap ferme le menu");

mainButton.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
assert.strictEqual(dropdown.style.display, "block", "menu ré-ouvert");
document.body.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
assert.strictEqual(dropdown.style.display, "none", "un clic extérieur ferme le menu");
ok("fermeture Échap + clic extérieur opérationnelle");

/* ══════ 8. Géométrie du popup : les contrôles restent dans l'écran ══════ */
console.log("8. Popup mesuré À L'OUVERTURE et maintenu dans la fenêtre");

// jsdom ne calcule AUCUNE mise en page : on simule ce que ferait le navigateur
// (largeur nulle tant que le menu est en display:none, largeur réelle une fois
// affiché). C'est exactement le piège qui rendait les contrôles invisibles.
function stubGeometry(ul, btn, { right = 1400, width = 400 } = {}) {
    Object.defineProperty(ul, "offsetWidth", {
        configurable: true,
        get() { return this.style.display === "none" ? 0 : width; },
    });
    btn.getBoundingClientRect = () => ({
        right, left: right - width, top: 10, bottom: 40, width: 60, height: 30,
    });
    return { right, width };
}
// Fenêtre de test : 1440 px de large (bouton « AI Helper » contre le bord droit).
Object.defineProperty(domWindow, "innerWidth", { configurable: true, value: 1440 });

{
    const geo = stubGeometry(dropdown, mainButton);
    mainButton.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
    const popupLeft = parseInt(dropdown.style.left, 10);
    assert.strictEqual(dropdown.style.display, "block", "le menu est ouvert");
    assert.notStrictEqual(dropdown.style.visibility, "hidden",
        "la visibilité est restaurée après la mesure (aucun menu invisible résiduel)");
    assert.strictEqual(popupLeft, geo.right - geo.width,
        "MUTANT : position calculée sur la largeur RÉELLE (400 px), pas sur min-width (150 px)");
    assert.ok(popupLeft + geo.width <= 1440 - 5,
        "MUTANT : le bord droit du popup (bouton ⚙ compris) reste DANS la fenêtre");
    ok("popup 400 px ancré à droite : entièrement visible (bord droit ≤ fenêtre)");
    // Refermer proprement pour la suite.
    document.body.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(dropdown.style.display, "none", "menu refermé après le test de géométrie");
}

/* ══════ 9. Clic sur la ligne = ouvre les réglages ComfyCH ══════ */
console.log("9. Clic sur le libellé ComfyCH → réglages ; clic dans les contrôles → rien");

{
    mainButton.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
    const row = document.getElementById("holaf-menu-comfych");
    const label = row.firstElementChild;
    const select = row.querySelector("#modal-gpu-selector");
    assert.ok(label && select, "ligne ComfyCH avec libellé et sélecteur après ouverture du menu");

    // RÉGRESSION VÉCUE (cause première de « je ne vois aucun contrôle ») : à
    // CHAQUE ouverture, la boucle de rafraîchissement des cases à cocher de
    // mainButton.onclick prenait `li.querySelector('div')` — soit, dans cette
    // ligne, le conteneur des contrôles ComfyCH — et lui appliquait
    // `innerHTML = ""` : le sélecteur GPU et le bouton ⚙, montés à la
    // construction, DISPARAISSAIENT dès la première ouverture.
    assert.strictEqual(
        row.querySelectorAll("#modal-gateway-container > *").length, 4,
        "MUTANT : les 4 contrôles ComfyCH (🎮, sélecteur GPU, badge, ⚙) survivent à l'ouverture du menu"
    );
    assert.ok(row.querySelector("#modal-settings-btn"), "bouton ⚙ toujours présent après ouverture");
    assert.strictEqual(
        row.querySelector(".holaf-menu-check"), null,
        "le conteneur des contrôles n'est PAS traité comme une case à cocher"
    );
    // Non-régression : les 4 entrées à bascule gardent bien leur case à cocher
    // (c'est cette boucle qui la rafraîchit).
    assert.strictEqual(
        dropdown.querySelectorAll("li .holaf-menu-check").length, 4,
        "les 4 entrées à bascule conservent leur case à cocher (.holaf-menu-check)"
    );

    openCalls = 0;
    label.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(openCalls, 1,
        "MUTANT : cliquer le libellé ouvre les réglages ComfyCH (openSettings du pont)");
    assert.strictEqual(dropdown.style.display, "block", "le menu reste ouvert (contrôles utilisables)");

    select.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(openCalls, 1,
        "un clic DANS les contrôles (sélecteur GPU) n'ouvre pas la modale par ricochet");
    ok("clic libellé = réglages ComfyCH ; clic sélecteur = comportement propre (aucun ricochet)");
    document.body.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
}

/* ══════ 10. Contrôles négatifs par mutation ══════ */
console.log("10. Mutants : action de clic retirée, mesure faite menu fermé");

{
    const SRC = readFileSync(join(HERE, "holaf_main.js"), "utf8");

    // Nettoyage d'un éventuel résidu d'une exécution interrompue.
    for (const f of readdirSync(HERE)) {
        if (/^\.__mut_comfych_\d+_main\.mjs$/.test(f)) rmSync(join(HERE, f), { force: true });
    }

    let seq = 0;
    /** Écrit un mutant de holaf_main.js, laisse son extension monter le menu et
     *  renvoie les éléments du NOUVEAU menu (l'ancien est retiré du DOM, sinon
     *  init() sortirait immédiatement sur « conteneur déjà présent »). */
    async function loadMenuMutant(label, mutate) {
        const mutated = mutate(SRC);
        assert.notStrictEqual(mutated, SRC, `mutation « ${label} » sans effet (ancre introuvable)`);
        const file = join(HERE, `.__mut_comfych_${++seq}_main.mjs`);
        writeFileSync(file, mutated, "utf8");
        document.getElementById("holaf-utilities-menu-container")?.remove();
        document.getElementById("holaf-utilities-dropdown-menu")?.remove();
        const before = app.extensions.length;
        await import("file://" + file + "?m=" + seq);
        const ext = app.extensions.slice(before)
            .filter((e) => e && e.name === "Holaf.Utilities.Menu").pop();
        assert.ok(ext, `mutation « ${label} » : extension du menu non enregistrée`);
        await ext.setup();
        await new Promise((r) => setTimeout(r, 150));
        const ul = document.getElementById("holaf-utilities-dropdown-menu");
        const btn = document.getElementById("holaf-utilities-menu-button");
        const row = document.getElementById("holaf-menu-comfych");
        assert.ok(ul && btn, `mutation « ${label} » : menu AIH non monté`);
        assert.ok(row, `mutation « ${label} » : ligne ComfyCH absente (WIP comfych active)`);
        return { ul, btn, row, file };
    }

    // M1 — action de clic retirée : le clic sur le libellé n'ouvre PLUS rien → (9) rouge.
    {
        const { row, file } = await loadMenuMutant(
            "action de clic retirée",
            (s) => s.replace("host.openSettings();", "void 0;")
        );
        try {
            openCalls = 0;
            row.firstElementChild.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
            assert.strictEqual(openCalls, 0,
                "mutant M1 : le clic sur la ligne n'ouvre RIEN → l'assertion (9) serait ROUGE");
        } finally {
            rmSync(file, { force: true });
        }
        ok("M1 action de clic retirée → l'ouverture des réglages (9) devient ROUGE");
    }

    // M2 — mesure faite MENU FERMÉ (offsetWidth = 0) : repli sur min-width 150 px,
    //      le popup déborde à droite, les contrôles sortent de l'écran → (8) rouge.
    {
        const legacyMeasure = [
            "        const wasHidden = this.dropdownMenuEl.style.display !== \"block\";",
            "        if (wasHidden) {",
            "            this.dropdownMenuEl.style.visibility = \"hidden\";",
            "            this.dropdownMenuEl.style.display = \"block\";",
            "        }",
            "        const measuredWidth = this.dropdownMenuEl.offsetWidth;",
            "        if (wasHidden) {",
            "            this.dropdownMenuEl.style.display = \"none\";",
            "            this.dropdownMenuEl.style.visibility = \"\";",
            "        }",
        ].join("\n");
        const { ul, btn, file } = await loadMenuMutant(
            "mesure avant affichage",
            (s) => s.replace(legacyMeasure, "        const measuredWidth = 0;")
        );
        try {
            const geoM = stubGeometry(ul, btn);
            btn.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
            const popupLeft = parseInt(ul.style.left, 10);
            assert.ok(geoM.right - popupLeft < geoM.width,
                "mutant M2 : position calculée sur une largeur INFÉRIEURE à la largeur réelle (repli min-width)");
            assert.ok(popupLeft + geoM.width > 1440,
                "mutant M2 : le popup déborde de la fenêtre → les contrôles sortent de l'écran, l'assertion (8) serait ROUGE");
        } finally {
            rmSync(file, { force: true });
        }
        ok("M2 mesure faite menu fermé → contrôles hors écran, l'assertion (8) devient ROUGE");
    }

    // M3 — retour au sélecteur générique `li.querySelector('div')` : la ligne
    //      ComfyCH est prise pour une case à cocher et ses contrôles sont
    //      écrasés à la PREMIÈRE ouverture du menu → (9) rouge.
    {
        const { btn, row, file } = await loadMenuMutant(
            "contrôles écrasés à l'ouverture",
            (s) => s.replace("li.querySelector('.holaf-menu-check')", "li.querySelector('div')")
        );
        try {
            assert.strictEqual(row.querySelectorAll("#modal-gateway-container > *").length, 4,
                "mutant M3 : les contrôles sont montés à la construction");
            btn.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
            assert.strictEqual(row.querySelectorAll("#modal-gateway-container > *").length, 0,
                "mutant M3 : le conteneur des contrôles est vidé à l'ouverture → sélecteur GPU et ⚙ invisibles, l'assertion (9) serait ROUGE");
        } finally {
            rmSync(file, { force: true });
        }
        ok("M3 sélecteur générique rétabli → contrôles effacés à l'ouverture, l'assertion (9) devient ROUGE");
    }

    assert.strictEqual(readFileSync(join(HERE, "holaf_main.js"), "utf8"), SRC,
        "source intacte après les mutations (aucune modification laissée sur disque)");
    assert.strictEqual(readdirSync(HERE).filter((f) => /^\.__mut_comfych_\d+_main\.mjs$/.test(f)).length, 0,
        "aucun fichier mutant résiduel dans js/");
    ok("source intacte, aucun mutant résiduel");
}

/* ══════ 11. Scan ESM : chargement « comme ComfyUI » (imports parallèles) ══════ */
console.log("11. Scan ESM du WEB_DIRECTORY (chemin réel de ComfyUI)");

{
    const { loadAllExtensions } = await import("./test_helpers/ext_load.mjs");
    const results = await loadAllExtensions();
    const byFile = Object.fromEntries(results.map((r) => [r.file, r]));
    for (const f of ["comfych_gateway.js", "holaf_main.js", "comfych/modal_gateway.js"]) {
        // comfych/modal_gateway.js n'est pas listé par /api/extensions (sous-dossier) :
        // il arrive par l'import statique de comfych_gateway.js.
        if (!byFile[f]) continue;
        assert.strictEqual(byFile[f].ok, true,
            `${f} importé sans exception (erreur : ${byFile[f].error && byFile[f].error.message})`);
    }
    assert.strictEqual(byFile["comfych_gateway.js"].ok, true,
        "comfych_gateway.js (chargeur du frontend ComfyCH) s'importe sans exception");
    assert.strictEqual(byFile["holaf_main.js"].ok, true,
        "holaf_main.js s'importe sans exception (import statique ./comfych_gateway.js résolu)");
    ok("scan ESM : holaf_main.js + comfych_gateway.js importés par le chemin réel de ComfyUI");
}

console.log(`\n✅ ComfyCH — visibilité WIP et sous-menu : TOUS LES TESTS PASSENT (${n} groupes)`);
process.exit(0);
