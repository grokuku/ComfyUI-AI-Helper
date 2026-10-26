// ─────────────────────────────────────────────────────────────────────────
// ComfyCH — les CADRES D'ÉTAPES de la modale de réglages ont une hauteur
// verticale FIXE et IDENTIQUE : la mise en page ne saute plus quand l'état ou
// le message d'une étape change.
//
// Ce que ce fichier verrouille (chaque point a son mutant) :
//   §1 structure : 3 cadres `.modal-step` (tête / corps / pied) dans la grille
//      `.modal-steps` ;
//   §2 hauteur FIXE : la grille impose une hauteur définie (grid-auto-rows) et
//      chaque cadre la reprend explicitement → les 3 cadres ont la MÊME hauteur
//      déclarée, en px, jamais `auto` — MUTANT M1 « hauteur laissée en auto »
//      → ROUGE ;
//   §3 la zone des étapes n'est ni compressible ni extensible (flex 0 0 auto) :
//      déplier « Connexion », agrandir les logs ou réduire le panneau ne change
//      plus la hauteur des cadres — MUTANT M2 « zone compressible » → ROUGE ;
//   §4 le contenu (aide, listes, bandeau d'erreur, log) ne peut PAS étirer le
//      cadre : corps unique zone souple (flex 1 + min-height 0 + overflow auto)
//      — MUTANT M3 « message long qui étire le cadre » → ROUGE ;
//      MUTANT M4 « hauteur fixe qui écrase le log » (corps non souple) → ROUGE ;
//   §5 les 4 ÉTATS (attente, en cours, succès, erreur) donnent exactement le
//      même instantané de hauteurs, y compris avec un message très long ;
//   §6 dispositions ÉTROITES : même hauteur fixe pour chaque cadre empilé
//      (contrôle textuel : jsdom n'évalue pas les media queries) ;
//   §7 suite « Connexion » dépliée / panneau court : le panneau reste
//      défilable, les cadres jamais comprimés.
//
// Usage : node js/test_comfych_step_frames.mjs
//   jsdom résolu par js/test_helpers/jsdom_loader.mjs ; absent = SKIP (exit 2).
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMFYCH_DIR = join(HERE, "comfych");
const MODULE_PATH = join(COMFYCH_DIR, "modal_gateway.js");

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 20));

/** Hauteur attendue des cadres, en px (grille large / étapes empilées). */
const FRAME_H_WIDE = "420px";
const FRAME_H_STACKED = "260px";

const JSDOM = await loadJsdomOrSkip("test_comfych_step_frames");
const dom = new JSDOM(
    `<!doctype html><html><head></head><body>
       <div id="comfy-canvas"></div>
       <span id="modal-log-count"></span>
       <span id="modal-log-progress"></span>
       <pre id="modal-log-output"></pre>
     </body></html>`,
    { pretendToBeVisual: true, url: "http://localhost/" }
);
const { window: domWindow } = dom;
globalThis.window = domWindow;
globalThis.document = domWindow.document;
globalThis.localStorage = domWindow.localStorage;
globalThis.getComputedStyle = domWindow.getComputedStyle.bind(domWindow);
globalThis.HTMLElement = domWindow.HTMLElement;
globalThis.Node = domWindow.Node;
globalThis.Blob = domWindow.Blob;
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
try { globalThis.navigator = domWindow.navigator; } catch { /* déjà fourni */ }
domWindow.matchMedia = domWindow.matchMedia
    || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));

localStorage.setItem("aih_locale", "fr");

/* ══════════════ Harnais réseau minimal (la modale ne touche que l'API) ══════════════ */

function jsonResponse(body) {
    return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("/api/modal/config")) {
        return jsonResponse({ api_url: "https://gw.modal.run", api_key_set: true, render_mode_forced: "" });
    }
    if (target.includes("/api/modal/status")) return jsonResponse({});
    if (target.includes("/api/modal/")) return jsonResponse({});
    return jsonResponse({});
};

class FakeEventSource {
    constructor(url) { this.url = url; }
    addEventListener() {}
    close() {}
}
globalThis.EventSource = FakeEventSource;
domWindow.EventSource = FakeEventSource;

const fakeApi = { queuePrompt() { return Promise.resolve({}); } };
const app = {
    graph: { nodes: [] },
    canvas: {},
    ui: {},
    api: fakeApi,
    extensions: [],
    menu: { settingsGroup: { element: document.getElementById("comfy-canvas") } },
    registerExtension(ext) { app.extensions.push(ext); },
};
globalThis.window.app = app;
domWindow.app = app;
globalThis.app = app;
domWindow.api = fakeApi;
domWindow.comfyAPI = { app: { app } };

/* ══════════════ Chargement du module (chemin réel du pack) ══════════════ */
await import("./comfych_gateway.js");
await import("./comfych/modal_gateway.js");
await tick(1000); // interception de queuePrompt (800 ms) + config

const host = () => domWindow.AIHComfyCHHost;
assert.ok(host(), "pont window.AIHComfyCHHost exposé");
assert.strictEqual(typeof host().openSettings, "function", "openSettings() exposé");

/* ══════════════ Accès aux cadres d'étapes ══════════════ */

const overlay = () => document.getElementById("modal-settings-overlay");
const styleEl = () => document.getElementById("modal-settings-styles");
const stepsGrid = () => overlay().querySelector(".modal-steps");
const frames = () => Array.from(overlay().querySelectorAll(".modal-step"));
const cs = (el) => getComputedStyle(el);
const bodyOf = (frame) => frame.querySelector(".modal-step-body");

/** Ouvre la modale de réglages et renvoie son overlay. */
async function openSettings(ms) {
    host().openSettings();
    await tick(ms || 120);
    const el = overlay();
    assert.ok(el, "la modale de réglages est ouverte");
    return el;
}

/** Ferme la modale (bouton réel : il remet aussi le verrou d'ouverture à zéro). */
function closeSettings() {
    const el = overlay();
    if (!el) return;
    el.querySelector(".modal-settings-close").dispatchEvent(
        new domWindow.MouseEvent("click", { bubbles: true })
    );
    el.remove();
    window._modalSettingsOpen = false;
}

/**
 * Instantané des hauteurs déclarées : tout ce qui décide de la hauteur des
 * cadres (grille + cadres + corps souple).
 */
function snapshot() {
    const gcs = cs(stepsGrid());
    return {
        grille: {
            height: gcs.height,
            gridAutoRows: gcs.gridAutoRows,
            flexGrow: gcs.flexGrow,
            flexShrink: gcs.flexShrink,
        },
        cadres: frames().map((frame) => {
            const fcs = cs(frame);
            const bcs = cs(bodyOf(frame));
            const hcs = cs(frame.querySelector(".modal-step-head"));
            const pcs = cs(frame.querySelector(".modal-step-foot"));
            return {
                height: fcs.height,
                minHeight: fcs.minHeight,
                boxSizing: fcs.boxSizing,
                overflow: fcs.overflow,
                corps: { overflowY: bcs.overflowY, minHeight: bcs.minHeight, flexGrow: bcs.flexGrow },
                tetePied: { head: hcs.flexShrink, foot: pcs.flexShrink },
            };
        }),
    };
}

/** Vérifie l'invariant « hauteur fixe et identique » sur un instantané. */
function assertFixedFrames(snap, attendu, where) {
    assert.strictEqual(snap.grille.gridAutoRows, attendu,
        `${where} : la grille impose une hauteur de ligne définie (${attendu}) — trouvé « ${snap.grille.gridAutoRows} »`);
    assert.strictEqual(snap.grille.flexGrow, "0",
        `${where} : la zone des étapes ne s'étire pas avec la place libre`);
    assert.strictEqual(snap.grille.flexShrink, "0",
        `${where} : la zone des étapes ne se laisse pas comprimer (Connexion, logs, panneau)`);
    const hauteurs = new Set(snap.cadres.map((c) => c.height));
    assert.strictEqual(hauteurs.size, 1,
        `${where} : les cadres n'ont pas tous la même hauteur — ${JSON.stringify([...hauteurs])}`);
    assert.strictEqual([...hauteurs][0], attendu,
        `${where} : hauteur des cadres fixe et définie (${attendu}) — trouvé « ${[...hauteurs][0]} »`);
    for (const [i, c] of snap.cadres.entries()) {
        assert.strictEqual(c.minHeight, "0px", `${where} : cadre ${i + 1} — min-height: 0 (le corps peut se réduire)`);
        assert.strictEqual(c.boxSizing, "border-box", `${where} : cadre ${i + 1} — les bordures ne dépassent pas la hauteur`);
        assert.strictEqual(c.overflow, "hidden", `${where} : cadre ${i + 1} — rien ne s'échappe du cadre`);
        // Le corps est la seule zone souple : il absorbe le contenu et défile.
        assert.strictEqual(c.corps.flexGrow, "1",
            `${where} : cadre ${i + 1} — le corps prend la place restante (log non écrasé)`);
        assert.strictEqual(c.corps.minHeight, "0px",
            `${where} : cadre ${i + 1} — le corps ne peut pas imposer sa hauteur au cadre`);
        assert.strictEqual(c.corps.overflowY, "auto",
            `${where} : cadre ${i + 1} — le contenu long défile au lieu d'étirer le cadre`);
        // Tête et pied ne se compriment pas : le cadre ne « mange » pas les boutons.
        assert.strictEqual(c.tetePied.head, "0", `${where} : cadre ${i + 1} — la tête ne se comprime pas`);
        assert.strictEqual(c.tetePied.foot, "0", `${where} : cadre ${i + 1} — le pied (boutons) ne se comprime pas`);
    }
}

/* ═════════ 1. Structure des cadres d'étapes ═════════ */
console.log("1. Structure : 3 cadres d'étape (tête / corps / pied) dans la grille");

await openSettings();
{
    const grille = stepsGrid();
    assert.ok(grille, "la grille des étapes (.modal-steps) existe dans la modale");
    assert.strictEqual(frames().length, 3, "il y a 3 cadres d'étape (Build / Nodes / Modèles)");
    for (const [i, frame] of frames().entries()) {
        assert.ok(frame.querySelector(".modal-step-head"), `cadre ${i + 1} : tête présente`);
        assert.ok(bodyOf(frame), `cadre ${i + 1} : corps présent`);
        assert.ok(frame.querySelector(".modal-step-foot"), `cadre ${i + 1} : pied (boutons) présent`);
        assert.ok(bodyOf(frame).children.length > 0, `cadre ${i + 1} : le corps porte bien du contenu`);
    }
    assert.ok(styleEl(), "le CSS du module est injecté (#modal-settings-styles)");
    ok("3 cadres complets dans .modal-steps, CSS injecté par le module");
}

/* ═════════ 2-4. Hauteur fixe, identique, contenu contenu ═════════ */
console.log("2. Hauteur FIXE et IDENTIQUE des cadres (jamais auto, jamais compressible)");

const baseline = snapshot();
assertFixedFrames(baseline, FRAME_H_WIDE, "état initial");
ok(`les 3 cadres déclarent la même hauteur fixe (${FRAME_H_WIDE}), contenu contenu (overflow auto)`);

/* ═════════ 5. Les 4 états donnent exactement le même instantané ═════════ */
console.log("3. États attente / en cours / succès / erreur : hauteurs inchangées");

const LONG_HINT = Array.from({ length: 40 }, (_, i) =>
    `ligne ${i + 1} : un message d'aide très long (nodes détectés, dépendances manquantes, redeploy nécessaire)`
).join("\n");

function fillList(id, count) {
    const list = document.getElementById(id);
    list.style.display = "block";
    list.innerHTML = Array.from({ length: count }, (_, i) =>
        `<div class="modal-item"><input type="checkbox"><div class="modal-item-main">` +
        `<div class="modal-item-name">node_${i}</div><div class="modal-item-sub">dépôt git</div></div></div>`
    ).join("");
}

function setBadges(cls, text) {
    overlay().querySelectorAll(".modal-step-badge").forEach((b) => {
        b.className = `modal-step-badge ${cls}`;
        b.textContent = text;
    });
    overlay().querySelectorAll(".modal-step-num").forEach((num) => {
        num.className = `modal-step-num ${cls === "ok" ? "done" : "active"}`;
    });
}

const ETATS = [
    ["attente", () => {
        setBadges("", "⏳");
    }],
    ["en cours", () => {
        setBadges("", "⏳");
        const progress = document.getElementById("modal-log-progress");
        progress.style.display = "inline-flex";
        progress.textContent = "sync en cours — 12 s";
    }],
    ["succès", () => {
        setBadges("ok", "OK");
        document.getElementById("modal-log-progress").style.display = "none";
        fillList("modal-plugins-list", 60);
        fillList("modal-models-list", 60);
    }],
    ["erreur", () => {
        setBadges("warn", "KO");
        // Message d'erreur très long + bandeau + listes : c'est l'état qui
        // poussait le plus la mise en page avant le correctif.
        document.getElementById("modal-auth-warning").style.display = "block";
        const hint = document.getElementById("step2-sync-hint");
        hint.style.display = "block";
        hint.textContent = LONG_HINT;
        document.getElementById("modal-log-output").textContent = Array.from(
            { length: 400 }, (_, i) => `ERROR ligne de log ${i}`
        ).join("\n");
    }],
];

for (const [label, apply] of ETATS) {
    apply();
    const snap = snapshot();
    assert.deepStrictEqual(snap, baseline,
        `état « ${label} » : les hauteurs déclarées doivent être identiques à l'état initial`);
    assertFixedFrames(snap, FRAME_H_WIDE, `état « ${label} »`);
    ok(`état « ${label} » : instantané de hauteurs identique (cadres ${FRAME_H_WIDE})`);
}

// Preuve directe : un message long ne fait pas grandir le cadre, il défile.
{
    const hint = document.getElementById("step2-sync-hint");
    hint.textContent = LONG_HINT + LONG_HINT + LONG_HINT;
    const snap = snapshot();
    assert.deepStrictEqual(snap, baseline,
        "MUTANT M3 : un message très long ne doit RIEN changer à la hauteur déclarée des cadres");
    assert.strictEqual(frames()[1].querySelectorAll(".modal-hint").length >= 1, true,
        "le message long est bien dans le corps de l'étape 2");
    ok("message 3× plus long : hauteurs inchangées, le corps défile (overflow-y: auto)");
}

/* ═════════ 6. Dispositions étroites : même hauteur fixe ═════════ */
console.log("4. Étapes empilées (fenêtre étroite) : même hauteur fixe par cadre");

{
    // jsdom n'évalue PAS les media queries : on contrôle le texte du CSS réel.
    const cssText = styleEl().textContent;
    const iMedia = cssText.indexOf("@media (max-width: 900px)");
    assert.ok(iMedia > 0, "le bloc média « fenêtre étroite » existe");
    let depth = 0;
    let j = cssText.indexOf("{", iMedia);
    const start = j;
    for (; j < cssText.length; j++) {
        if (cssText[j] === "{") depth++;
        else if (cssText[j] === "}") { depth--; if (depth === 0) break; }
    }
    const mediaBlock = cssText.slice(start, j + 1);
    assert.ok(mediaBlock.includes(`grid-auto-rows: ${FRAME_H_STACKED};`),
        `étapes empilées : la grille impose ${FRAME_H_STACKED} par cadre`);
    assert.ok(/\.modal-step \{ height: 260px; \}/.test(mediaBlock),
        `étapes empilées : chaque cadre déclare height: ${FRAME_H_STACKED} (et non un min-height variable)`);
    assert.ok(!/\.modal-step \{[^}]*min-height:/.test(mediaBlock),
        "MUTANT M1 : aucune hauteur de cadre laissée à un min-height (hauteur variable selon le contenu)");

    // Cohérence grille ⇄ cadre dans la disposition LARGE (déjà mesurée au §2).
    const iLarge = cssText.indexOf(".modal-steps {");
    assert.ok(iLarge > 0, "règle .modal-steps de la disposition large présente");
    const largeBlock = cssText.slice(iLarge, cssText.indexOf("}", iLarge));
    assert.ok(largeBlock.includes(`grid-auto-rows: ${FRAME_H_WIDE};`),
        `disposition large : grid-auto-rows: ${FRAME_H_WIDE}`);
    ok("dispositions large et étroite : hauteur fixe par cadre, valeurs grille ⇄ cadre cohérentes");
}

/* ═════════ 7. « Connexion » dépliée / panneau court : panneau défilable ═════════ */
console.log("5. Connexion dépliée et panneau réduit : cadres intacts, panneau défilable");

{
    const panel = overlay().querySelector(".modal-settings-panel");
    const pcs = cs(panel);
    assert.ok(/auto|scroll/.test(pcs.overflowY),
        "le panneau reste défilable (overflow-y: auto) quand les cadres à hauteur fixe ne tiennent pas");

    document.getElementById("modal-prereq").classList.add("open");
    const snapOpen = snapshot();
    assert.deepStrictEqual(snapOpen, baseline,
        "déplier « Connexion » ne change pas la hauteur des cadres");
    assertFixedFrames(snapOpen, FRAME_H_WIDE, "Connexion dépliée");

    panel.style.height = "480px";
    const snapSmall = snapshot();
    assert.deepStrictEqual(snapSmall, baseline,
        "MUTANT M2 : réduire le panneau ne comprime plus les cadres (c'est le panneau qui défile)");
    assertFixedFrames(snapSmall, FRAME_H_WIDE, "panneau réduit à 480 px");

    panel.style.height = "";
    document.getElementById("modal-prereq").classList.remove("open");
    ok("Connexion dépliée / panneau 480 px : cadres identiques, panneau défilable");
}

closeSettings();

/* ═════════ 8. Contrôles négatifs par mutation ═════════ */
console.log("6. Mutants : hauteur auto, zone compressible, message qui étire, log écrasé");

{
    const SRC = readFileSync(MODULE_PATH, "utf8");

    for (const f of readdirSync(COMFYCH_DIR)) {
        if (/^\.__mut_stepframes_\d+\.js$/.test(f)) rmSync(join(COMFYCH_DIR, f), { force: true });
    }

    let seq = 0;
    /**
     * Importe un MUTANT du module. Le fichier est écrit DANS js/comfych/ pour
     * que les imports relatifs (`../aih_icons.js`) résolvent comme en production.
     * Le CSS injecté est retiré avant, sinon injectModalStyles() garderait la
     * feuille du module sain (garde sur #modal-settings-styles).
     */
    async function loadMutant(label, mutate) {
        const mutated = mutate(SRC);
        assert.notStrictEqual(mutated, SRC, `mutation « ${label} » sans effet (ancre introuvable)`);
        const file = join(COMFYCH_DIR, `.__mut_stepframes_${++seq}.js`);
        writeFileSync(file, mutated, "utf8");
        closeSettings();
        styleEl()?.remove();
        delete domWindow.AIHComfyCHHost;
        await import("file://" + file + "?m=" + seq);
        await tick(950); // interception de queuePrompt (800 ms) + config
        const mutantHost = domWindow.AIHComfyCHHost;
        assert.ok(mutantHost, `mutation « ${label} » : pont du module absent`);
        mutantHost.openSettings();
        await tick(120);
        assert.ok(overlay(), `mutation « ${label} » : modale de réglages ouverte`);
        return { bridge: mutantHost, file };
    }

    function cleanupMutant(handle) {
        closeSettings();
        styleEl()?.remove();
        delete domWindow.AIHComfyCHHost;
        rmSync(handle.file, { force: true });
    }

    // M1 — hauteur des cadres laissée en `auto` : ils suivent leur contenu.
    {
        const handle = await loadMutant(
            "hauteur des cadres laissée en auto",
            (s) => s.replace(
                "'  height: 420px; box-sizing: border-box; overflow: hidden;',",
                "'  height: auto; box-sizing: border-box; overflow: hidden;',"
            )
        );
        try {
            const snap = snapshot();
            assert.notStrictEqual(snap.cadres[0].height, FRAME_H_WIDE,
                "mutant M1 : la hauteur des cadres redevient « auto » → l'assertion (2) serait ROUGE");
            assert.throws(() => assertFixedFrames(snap, FRAME_H_WIDE, "mutant M1"),
                "mutant M1 : assertFixedFrames() doit échouer (cadres non figés)");
        } finally {
            cleanupMutant(handle);
        }
        ok("M1 hauteur auto → cadres dépendants du contenu, l'assertion (2) devient ROUGE");
    }

    // M2 — zone des étapes compressible par le panneau / les logs.
    {
        const handle = await loadMutant(
            "zone des étapes compressible",
            (s) => s.replace(
                "'  flex: 0 0 auto;',\n            '  grid-auto-rows: 420px;',",
                "'  flex: 0 1 auto;',\n            '  grid-auto-rows: 420px;',"
            )
        );
        try {
            const snap = snapshot();
            assert.strictEqual(snap.grille.flexShrink, "1",
                "mutant M2 : la zone des étapes redevient compressible → l'assertion (3) serait ROUGE");
            assert.throws(() => assertFixedFrames(snap, FRAME_H_WIDE, "mutant M2"),
                "mutant M2 : assertFixedFrames() doit échouer (hauteur non constante)");
        } finally {
            cleanupMutant(handle);
        }
        ok("M2 zone compressible → hauteur qui varie avec le panneau, l'assertion (3) devient ROUGE");
    }

    // M3 — un message long étire le cadre (corps sans min-height ni défilement).
    {
        const handle = await loadMutant(
            "message long qui étire le cadre",
            (s) => s.replace(
                "'  flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;',",
                "'  flex: 1; overflow-y: visible;',"
            )
        );
        try {
            const snap = snapshot();
            assert.strictEqual(snap.cadres[0].corps.overflowY, "visible",
                "mutant M3 : le corps ne défile plus → l'assertion (4) serait ROUGE");
            assert.notStrictEqual(snap.cadres[0].corps.minHeight, "0px",
                "mutant M3 : le corps peut imposer sa hauteur (min-height revenu à auto)");
            assert.throws(() => assertFixedFrames(snap, FRAME_H_WIDE, "mutant M3"),
                "mutant M3 : assertFixedFrames() doit échouer (contenu qui étire le cadre)");
        } finally {
            cleanupMutant(handle);
        }
        ok("M3 message qui étire → contenu non contenu, l'assertion (4) devient ROUGE");
    }

    // M4 — hauteur fixe mais corps non souple : le log est écrasé.
    {
        const handle = await loadMutant(
            "hauteur fixe qui écrase le log",
            (s) => s.replace(
                "'  flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;',",
                "'  flex: 0 0 auto; min-height: 0; overflow-y: auto;',"
            )
        );
        try {
            const snap = snapshot();
            assert.strictEqual(snap.cadres[0].corps.flexGrow, "0",
                "mutant M4 : le corps ne prend plus la place restante → l'assertion (4) serait ROUGE");
            assert.throws(() => assertFixedFrames(snap, FRAME_H_WIDE, "mutant M4"),
                "mutant M4 : assertFixedFrames() doit échouer (log écrasé dans la hauteur fixe)");
        } finally {
            cleanupMutant(handle);
        }
        ok("M4 corps non souple → log écrasé par la hauteur fixe, l'assertion (4) devient ROUGE");
    }

    assert.strictEqual(readFileSync(MODULE_PATH, "utf8"), SRC,
        "source intacte après les mutations (aucune modification laissée sur disque)");
    assert.strictEqual(
        readdirSync(COMFYCH_DIR).filter((f) => /^\.__mut_stepframes_\d+\.js$/.test(f)).length,
        0,
        "aucun fichier mutant résiduel dans js/comfych/"
    );
    ok("source intacte, aucun mutant résiduel");
}

// Le module sain est rechargé pour laisser le DOM dans son état normal.
{
    styleEl()?.remove();
    await import("./comfych/modal_gateway.js?fresh=1");
    await tick(950);
    assert.ok(domWindow.AIHComfyCHHost, "module sain rechargé après les mutations");
}

console.log(`\n✅ ComfyCH — cadres d'étapes à hauteur fixe : TOUS LES TESTS PASSENT (${n} groupes)`);
process.exit(0);
