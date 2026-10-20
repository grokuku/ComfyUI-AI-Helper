// ─────────────────────────────────────────────────────────────────────────
// AIHRemoteComparer — PLUS de zoom de CONTENU (boutons − / + retirés).
//
// Le comparateur est un AFFICHEUR (image / vidéo / audio) : son seul zoom est
// celui de la brique HolafViewport (molette + pan). Le zoom de CONTENU
// (`makeContentZoomable` → boutons − / + dans la barre de titre + variable
// canonique `--aih-zoom-factor` consommée par `.holaf-zoom-content`) appliquait
// un `zoom` CSS qui perturbait l'affichage de l'image : il est retiré POUR CETTE
// FENÊTRE UNIQUEMENT.
//
// Vérifie, en chargeant le VRAI module du pack sous jsdom :
//   (a) plus AUCUN contrôle de zoom de contenu dans la barre de titre (le seul
//       bouton restant est le bouton fermer) ;
//   (b) AUCUN scale de contenu appliqué (ni classe `holaf-zoom-content`, ni
//       `--aih-zoom-factor`), Y COMPRIS quand un niveau est déjà persisté dans
//       le store partagé `aih_zoom_levels` (niveau préexistant IGNORÉ et PURGÉ,
//       sans toucher aux entrées des autres fenêtres) ;
//   (c) le zoom d'IMAGE à la souris fonctionne toujours (wheel → échelle change,
//       dans les deux sens) et `resetZoom()` ramène au fit ;
//   (d) NON-RÉGRESSION de l'utilitaire PARTAGÉ : une fenêtre créée via
//       `HolafPanelManager.createPanel` garde ses boutons, restaure son niveau
//       persisté et persiste ses clics (comportement par défaut inchangé) ;
//   (e) NON-RÉGRESSION du comparateur : image / vidéo / audio, option chemin de
//       fichier (`/holaf/comparer/file` + `meta.direct`), seek, tensor `/view`,
//       bouton fermer ;
//   (f) contrôles négatifs par MUTATION : zoom de contenu réactivé, niveau
//       persisté réappliqué, zoom souris cassé, zoom retiré pour une autre
//       fenêtre → chaque assertion devient ROUGE.
//
// Usage : node js/test_remote_comparer_no_content_zoom.mjs
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom absent), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const JSDOM = await loadJsdomOrSkip("test_remote_comparer_no_content_zoom");

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
});
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.DocumentFragment = window.DocumentFragment;
globalThis.Event = window.Event;
globalThis.HTMLMediaElement = window.HTMLMediaElement;
globalThis.HTMLVideoElement = window.HTMLVideoElement;
globalThis.HTMLAudioElement = window.HTMLAudioElement;
globalThis.HTMLImageElement = window.HTMLImageElement;
globalThis.Image = window.Image;
globalThis.Audio = window.Audio;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame?.bind(window) || ((cb) => setTimeout(cb, 0));
globalThis.cancelAnimationFrame = window.cancelAnimationFrame?.bind(window) || clearTimeout;
globalThis.ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
};

// jsdom n'implémente ni le canvas 2D ni la lecture média : on neutralise pour ne
// tester que la géométrie (brique) et la LOGIQUE du comparateur.
window.HTMLCanvasElement.prototype.getContext = () => null;
Object.defineProperty(window.HTMLMediaElement.prototype, "currentTime", {
    configurable: true,
    get() { return this.__ct || 0; },
    set(v) { this.__ct = v; },
});
Object.defineProperty(window.HTMLMediaElement.prototype, "duration", {
    configurable: true,
    get() { return this.__dur ?? NaN; },
});
window.HTMLMediaElement.prototype.play = function () {};
window.HTMLMediaElement.prototype.pause = function () {};
window.HTMLMediaElement.prototype.load = function () {};

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ── Store de zoom partagé : on le pré-remplit AVANT tout import ─────────── */
const COMPARER_KEY = "holaf_remote_comparer_state_v2"; // = STORAGE_KEY du comparer
const OTHER_KEY = "no_zoom_test_other_window";
const ZOOM_STORE_KEY = "aih_zoom_levels";
const seedZoomStore = (obj) => window.localStorage.setItem(ZOOM_STORE_KEY, JSON.stringify(obj));
const readZoomStore = () => JSON.parse(window.localStorage.getItem(ZOOM_STORE_KEY) || "{}");

// Niveau mémorisé par un utilisateur AVANT le retrait (1.8 = image agrandie),
// plus une entrée sans rapport qui doit survivre intacte.
seedZoomStore({ [COMPARER_KEY]: 1.8, [OTHER_KEY]: 1.4, "unrelated_window": 0.9 });

/* ── Boot « comme ComfyUI » (window.comfyAPI) ────────────────────────────── */
const registered = [];
const fakeApp = {
    registerExtension(ext) { registered.push(ext); },
};
window.comfyAPI = {
    app: { app: fakeApp },
    api: {
        api: {
            api_base: "",
            apiURL: (p) => p,
            addEventListener() {},
            fetchApi: () => Promise.resolve({ ok: true }),
        },
    },
};

await import("./aih_strings.js");
window.AIH.I18n.setLocale("fr");
await import("./holaf_remote_comparer.js");
const { HolafPanelManager } = await import("./holaf_panel_manager.js");

const ext = registered.find((e) => e.name === "Holaf.RemoteComparer");
assert.ok(ext, "extension Holaf.RemoteComparer enregistrée");
await ext.setup();
const comparer = fakeApp.holafRemoteComparer;
assert.ok(comparer, "comparer exposé sous app.holafRemoteComparer");
assert.ok(comparer.rootElement, "buildUI exécuté au setup (rootElement présent)");

/* ═════════ (a)+(b) Aucun zoom de contenu, niveau persisté ignoré ════════ */
console.log("(a)+(b) Plus de contrôles de zoom de contenu + niveau persisté ignoré/purgé");

/** Photo STRUCTURELLE de l'état « zoom de contenu » d'une instance comparer. */
function contentZoomSnapshot(cmp) {
    const root = cmp.rootElement;
    const header = root.querySelector(".holaf-utility-header");
    const content = cmp.mainContainer;
    return {
        hasHeader: !!header,
        controls: header ? header.querySelectorAll(".aih-zoom-controls").length : -1,
        zoomButtons: header ? header.querySelectorAll(".aih-dialog-zoom").length : -1,
        buttons: header ? header.querySelectorAll("button").length : -1,
        closeButtons: header ? header.querySelectorAll(".holaf-utility-close-button").length : -1,
        // Un bouton dont le libellé/tooltip parle de zoom (i18n window.zoomIn/Out).
        zoomTitled: header
            ? Array.from(header.querySelectorAll("button")).filter((b) =>
                /zoom/i.test(`${b.title} ${b.getAttribute("aria-label") || ""}`)).length
            : -1,
        zoomClass: content.classList.contains("holaf-zoom-content"),
        factor: content.style.getPropertyValue("--aih-zoom-factor"),
        // Témoin : le titre est toujours là (on n'a pas vidé la barre de titre).
        // NB : jsdom n'implémente pas `innerText` — c'est une propriété simple
        // (le comparer écrit `title.innerText`), donc textContent reste vide.
        title: (() => {
            if (!header) return "";
            const titleEl = Array.from(header.children).find((el) => el.tagName === "SPAN");
            return String(titleEl ? (titleEl.innerText || titleEl.textContent || "") : "").trim();
        })(),
    };
}

/** Assertions (a)+(b) : jette si un zoom de CONTENU subsiste. */
function assertNoContentZoom(snap) {
    assert.strictEqual(snap.hasHeader, true, "barre de titre présente");
    assert.strictEqual(snap.controls, 0, "(a) AUCUN groupe `.aih-zoom-controls` dans la barre de titre");
    assert.strictEqual(snap.zoomButtons, 0, "(a) AUCUN bouton `.aih-dialog-zoom` (− / +)");
    assert.strictEqual(snap.zoomTitled, 0, "(a) AUCUN bouton dont le libellé parle de zoom");
    assert.strictEqual(snap.buttons, 1, "(a) un SEUL bouton dans la barre de titre (fermer)");
    assert.strictEqual(snap.closeButtons, 1, "le bouton fermer est toujours là");
    assert.strictEqual(snap.zoomClass, false, "(b) conteneur de contenu SANS classe `holaf-zoom-content`");
    assert.strictEqual(snap.factor, "", "(b) AUCUN `--aih-zoom-factor` posé sur le contenu (transform/zoom neutre)");
}

const snap = contentZoomSnapshot(comparer);
assertNoContentZoom(snap);
assert.ok(snap.title.length > 0, "le titre de la fenêtre est conservé (barre de titre non vidée)");

// Le niveau préexistant du comparer a été PURGÉ…
const storeAfter = readZoomStore();
assert.strictEqual(COMPARER_KEY in storeAfter, false,
    "(b) entrée de zoom du comparer PURGÉE du store partagé (un niveau 1.8 était mémorisé)");
// …sans toucher aux autres fenêtres.
assert.strictEqual(storeAfter[OTHER_KEY], 1.4, "entrée d'une AUTRE fenêtre intacte");
assert.strictEqual(storeAfter["unrelated_window"], 0.9, "entrée sans rapport intacte");
ok("(a)(b) aucun contrôle/scale de contenu, niveau persisté 1.8 ignoré et purgé (autres entrées intactes)");

/* ═══════════════ (c) Le zoom d'IMAGE à la souris fonctionne ══════════════ */
console.log("(c) Zoom d'image à la souris (wheel) + resetZoom");

/** jsdom : getBoundingClientRect() renvoie 0 partout → on pose une vraie géométrie. */
function stubCanvasRect(cmp, w = 800, h = 600) {
    cmp.canvasEl.getBoundingClientRect = () => ({
        left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0,
    });
}

function wheel(cmp, deltaY, clientX = 400, clientY = 300) {
    cmp.canvasEl.dispatchEvent(new window.WheelEvent("wheel", {
        deltaY, clientX, clientY, bubbles: true, cancelable: true,
    }));
}

/** Charge une méta et déclenche la « disponibilité » (jsdom ne charge pas). */
async function loadAndFire(cmp, metas, durations = {}) {
    const p = cmp.loadMedia(metas);
    cmp.images.forEach((el, i) => {
        if (!el || el._holafGenre === "other") return;
        el.__dur = durations[i] ?? 10;
        if (typeof el.onloadeddata === "function") el.onloadeddata();
        else if (typeof el.onload === "function") el.onload();
    });
    await p;
}

/** Photo de l'état du zoom d'IMAGE (brique) autour d'un wheel + d'un reset. */
async function imageZoomSnapshot(cmp) {
    stubCanvasRect(cmp);
    await loadAndFire(cmp, [{ filename: "pic.png", format: "image", direct: true, path: "/tmp/out/pic.png" }]);
    cmp.vp.fit();
    const out = {
        fit: cmp.vp.getFitScale(),
        before: cmp.vp.getScale(),
        afterUp: null,
        afterDown: null,
        afterReset: null,
        afterRepeatUp: null,
    };
    wheel(cmp, -100);                                   // molette vers l'avant
    out.afterUp = cmp.vp.getScale();
    wheel(cmp, +100);                                   // molette vers l'arrière
    out.afterDown = cmp.vp.getScale();
    wheel(cmp, -100); wheel(cmp, -100);
    out.afterRepeatUp = cmp.vp.getScale();
    cmp.resetZoom();                                    // reset (fit) toujours présent
    out.afterReset = cmp.vp.getScale();
    return out;
}

/** Assertions (c) : jette si le zoom souris / le reset ne répond plus. */
function assertImageZoomWorks(s) {
    assert.ok(s.fit > 0, "fit de la brique calculé (géométrie disponible)");
    assert.strictEqual(s.before, s.fit, "au repos, l'image est AU FIT");
    assert.ok(s.afterUp > s.before + 1e-9, "(c) wheel avant → l'échelle de l'IMAGE augmente");
    assert.ok(Math.abs(s.afterUp - s.before * 1.1) < 1e-6, "(c) facteur de la brique conservé (×1.1)");
    assert.ok(s.afterDown < s.afterUp - 1e-9, "(c) wheel arrière → l'échelle diminue (réversible)");
    assert.ok(Math.abs(s.afterDown - s.before) < 1e-6, "(c) retour exact au fit");
    assert.ok(s.afterRepeatUp > s.before + 1e-9, "zoom avant répété : toujours réactif");
    assert.ok(Math.abs(s.afterReset - s.fit) < 1e-6, "(c) resetZoom() ramène au fit (zoom d'image, PAS de contenu)");
}

const imageZoom = await imageZoomSnapshot(comparer);
assertImageZoomWorks(imageZoom);
ok(`(c) zoom souris OK : fit=${imageZoom.fit} → ${imageZoom.afterUp} → ${imageZoom.afterDown} → reset=${imageZoom.afterReset}`);

/* ══════════════════ (e) Non-régression du comparateur ═══════════════════ */
console.log("(e) Non-régression : image / vidéo / audio + option chemin");

await loadAndFire(comparer, [{ filename: "pic.png", format: "image", direct: true, path: "/tmp/out/pic.png" }]);
assert.ok(comparer.images[0] instanceof window.HTMLImageElement, "image directe -> <img>");
assert.ok(comparer.images[0].src.includes("/holaf/comparer/file?path="), "route directe du pack");
assert.ok(!comparer.images[0].src.includes("/view?"), "jamais /view pour un fichier direct");

await loadAndFire(comparer, [{ filename: "clip.mp4", format: "video", direct: true, path: "/tmp/out/clip.mp4" }]);
assert.ok(comparer.images[0] instanceof window.HTMLVideoElement, "vidéo directe -> <video>");
assert.strictEqual(comparer.uiControls.container.style.display, "flex", "contrôles de lecture affichés");
comparer.uiControls.timeline.value = "500";
comparer.uiControls.timeline.oninput({ target: comparer.uiControls.timeline });
assert.strictEqual(comparer.images[0].currentTime, 5, "seek (Range) toujours fonctionnel");

await loadAndFire(comparer, [{ filename: "track.wav", format: "audio", direct: true, path: "/tmp/out/track.wav" }]);
assert.ok(comparer.images[0] instanceof window.HTMLAudioElement, "audio direct -> <audio>");
assert.ok(comparer.images[0].src.includes("/holaf/comparer/file?path="), "audio servi par la route directe");

await loadAndFire(comparer, [{ filename: "legacy.png", type: "output", subfolder: "", format: "image" }]);
assert.ok(comparer.images[0].src.includes("/view?filename=legacy.png"), "tensor IMAGE -> /view (inchangé)");

// Bouton fermer toujours câblé (migré en icône `x` en phase 2a).
comparer.show();
const closeBtn = comparer.rootElement.querySelector(".holaf-utility-close-button");
closeBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
assert.strictEqual(comparer.rootElement.style.display, "none", "bouton fermer : la fenêtre se masque");
ok("(e) image/vidéo/audio + chemin + seek + /view + bouton fermer : intacts");

/* ═════════ (d) Les AUTRES fenêtres gardent leur zoom (non-régression) ════ */
console.log("(d) Autres fenêtres : zoom de contenu partagé inchangé");

/** Crée une fenêtre standard via le panel manager et mesure son zoom. */
function otherWindowZoom(PM, key = OTHER_KEY) {
    const store = readZoomStore();
    store[key] = 1.5;
    seedZoomStore(store);
    const { panelEl, contentEl, headerEl } = PM.createPanel({ id: key, title: "Autre fenêtre" });
    const group = headerEl.querySelector(".aih-zoom-controls");
    const snapOther = {
        hasGroup: !!group,
        buttonCount: group ? group.querySelectorAll("button").length : 0,
        restored: contentEl.style.getPropertyValue("--aih-zoom-factor"),
        plus: null,
        stored: null,
    };
    if (group) {
        group.querySelector(".aih-zoom-in")
            .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        snapOther.plus = contentEl.style.getPropertyValue("--aih-zoom-factor");
        snapOther.stored = readZoomStore()[key];
    }
    panelEl.remove();
    return snapOther;
}

/** Assertions (d) : jette si le zoom par défaut des autres fenêtres a bougé. */
function assertSharedWindowZoom(s) {
    assert.strictEqual(s.hasGroup, true, "(d) une fenêtre standard expose TOUJOURS `.aih-zoom-controls`");
    assert.strictEqual(s.buttonCount, 2, "(d) ses 2 boutons (− / +) sont présents");
    assert.strictEqual(s.restored, "1.5", "(d) son niveau PERSISTÉ est restauré (défaut inchangé)");
    assert.strictEqual(s.plus, "1.6", "(d) le bouton + augmente le facteur de SON contenu");
    assert.strictEqual(s.stored, 1.6, "(d) son niveau est persisté dans le store partagé");
}

const otherSnap = otherWindowZoom(HolafPanelManager);
assertSharedWindowZoom(otherSnap);
assert.strictEqual(COMPARER_KEY in readZoomStore(), false,
    "après usage d'une autre fenêtre, le comparer reste SANS niveau persisté");
ok("(d) autre fenêtre : boutons + restauration + persistance inchangés (défaut partagé intact)");

/* ════════════ (f) Contrôles négatifs par MUTATION (4 mutants) ═══════════ */
console.log("(f) contrôles négatifs par mutation");

const COMPARER_SRC = readFileSync(join(HERE, "holaf_remote_comparer.js"), "utf8");
const PANEL_SRC = readFileSync(join(HERE, "holaf_panel_manager.js"), "utf8");

// Nettoyage d'un éventuel résidu d'une exécution interrompue.
for (const f of readdirSync(HERE)) {
    if (/^\.__mutzoom_\d+_/.test(f)) rmSync(join(HERE, f), { force: true });
}

let seq = 0;
/** Écrit un mutant d'un module du pack, l'importe et renvoie son URL. */
async function writeMutant(label, base, src, mutate) {
    const mutated = mutate(src);
    assert.notStrictEqual(mutated, src, `mutation « ${label} » sans effet (ancre introuvable)`);
    const file = join(HERE, `.__mutzoom_${++seq}_${base}.mjs`);
    writeFileSync(file, mutated, "utf8");
    await import("file://" + file + `?m=${seq}`);
    return file;
}

/** Setup d'un mutant du comparer + photo (a)(b) de son état. */
async function bootComparerMutant(label, mutate) {
    // Le vrai module a purgé le niveau du comparer : on re-sème pour prouver
    // qu'un niveau PRÉEXISTANT ne s'applique pas malgré le retrait.
    seedZoomStore({ [COMPARER_KEY]: 1.8, [OTHER_KEY]: 1.4 });
    const file = await writeMutant(label, "comparer", COMPARER_SRC, mutate);
    const mutExt = registered.filter((e) => e && e.name === "Holaf.RemoteComparer").pop();
    assert.ok(mutExt && mutExt !== ext, `mutation « ${label} » : extension du mutant non enregistrée`);
    await mutExt.setup();
    return { cmp: fakeApp.holafRemoteComparer, file };
}

// M1 — zoom de contenu RÉACTIVÉ (classe + boutons − / +) → (a)/(b) rouges.
{
    const { cmp, file } = await bootComparerMutant("zoom de contenu réactivé", (s) => s
        .replace(
            'import { makeDraggable, makeResizable, clearZoomLevel, aihWindowManager } from "./holaf_window_utils.js";',
            'import { makeDraggable, makeResizable, makeContentZoomable, clearZoomLevel, aihWindowManager } from "./holaf_window_utils.js";')
        .replace(
            'this.mainContainer = document.createElement("div");',
            'this.mainContainer = document.createElement("div"); this.mainContainer.classList.add("holaf-zoom-content");')
        .replace(
            'this.createResizeHandles();',
            'const _zg = makeContentZoomable(this.mainContainer, { key: this.STORAGE_KEY }); header.insertBefore(_zg, btnContainer);\n        this.createResizeHandles();'));
    try {
        const ms = contentZoomSnapshot(cmp);
        assert.strictEqual(ms.controls, 1, "mutant M1 : le groupe de zoom est de retour (mutant valide)");
        assert.throws(() => assertNoContentZoom(ms), /AUCUN/,
            "mutant M1 : (a) devient ROUGE — les boutons de zoom de contenu sont réapparus");
    } finally {
        rmSync(file, { force: true });
    }
    ok("M1 zoom de contenu réactivé → (a) ROUGE (boutons − / + de retour dans le titre)");
}

// M2 — niveau persisté RÉAPPLIQUÉ au lieu d'être purgé → (b) rouge.
{
    const { cmp, file } = await bootComparerMutant("niveau persisté réappliqué", (s) => s
        .replace(
            'import { makeDraggable, makeResizable, clearZoomLevel, aihWindowManager } from "./holaf_window_utils.js";',
            'import { makeDraggable, makeResizable, clearZoomLevel, loadZoomLevel, applyContentZoom, aihWindowManager } from "./holaf_window_utils.js";')
        .replace(
            'clearZoomLevel(this.STORAGE_KEY);',
            'const _lvl = loadZoomLevel(this.STORAGE_KEY); if (_lvl != null) applyContentZoom(this.mainContainer, _lvl);'));
    try {
        const ms = contentZoomSnapshot(cmp);
        assert.strictEqual(ms.factor, "1.8", "mutant M2 : le niveau persisté 1.8 est réappliqué (mutant valide)");
        assert.throws(() => assertNoContentZoom(ms), /--aih-zoom-factor/,
            "mutant M2 : (b) devient ROUGE — un niveau persisté s'applique au contenu du comparer");
    } finally {
        rmSync(file, { force: true });
    }
    ok("M2 niveau persisté réappliqué → (b) ROUGE (image agrandie sans bouton pour revenir)");
}

// M3 — zoom SOURIS cassé (wheel désactivé sur la brique) → (c) rouge.
{
    seedZoomStore({ [COMPARER_KEY]: 1.8, [OTHER_KEY]: 1.4 });
    const file = await writeMutant("zoom souris cassé", "comparer", COMPARER_SRC, (s) => s
        .replace("doubleClickZoom: false,", "doubleClickZoom: false,\n            wheel: false,"));
    try {
        const mutExt = registered.filter((e) => e && e.name === "Holaf.RemoteComparer").pop();
        assert.ok(mutExt && mutExt !== ext, "mutation « zoom souris cassé » : extension du mutant non enregistrée");
        await mutExt.setup();
        const mutCmp = fakeApp.holafRemoteComparer;
        const ms = await imageZoomSnapshot(mutCmp);
        assert.strictEqual(ms.afterUp, ms.before, "mutant M3 : le wheel ne change plus l'échelle (mutant valide)");
        assert.throws(() => assertImageZoomWorks(ms), /wheel/,
            "mutant M3 : (c) devient ROUGE — le zoom à la souris est cassé");
    } finally {
        rmSync(file, { force: true });
    }
    ok("M3 zoom souris cassé → (c) ROUGE (wheel sans effet)");
}

// M4 — zoom de contenu retiré pour une AUTRE fenêtre (défaut partagé cassé) → (d) rouge.
{
    const file = await writeMutant("zoom retiré pour une autre fenêtre", "panel_manager", PANEL_SRC, (s) => s
        .replace("const zoomGroup = (options.zoom !== false)", "const zoomGroup = (false)"));
    try {
        const mutMod = await import("file://" + file + `?m=${seq}`);
        const ms = otherWindowZoom(mutMod.HolafPanelManager);
        assert.strictEqual(ms.hasGroup, false, "mutant M4 : plus aucun bouton de zoom (mutant valide)");
        assert.throws(() => assertSharedWindowZoom(ms), /\.aih-zoom-controls/,
            "mutant M4 : (d) devient ROUGE — une autre fenêtre a perdu son zoom");
    } finally {
        rmSync(file, { force: true });
    }
    ok("M4 zoom retiré pour une autre fenêtre → (d) ROUGE (défaut partagé cassé)");
}

assert.strictEqual(readFileSync(join(HERE, "holaf_remote_comparer.js"), "utf8"), COMPARER_SRC,
    "le source du comparer n'a pas été modifié par les mutants");
assert.strictEqual(readFileSync(join(HERE, "holaf_panel_manager.js"), "utf8"), PANEL_SRC,
    "le source du panel manager n'a pas été modifié par les mutants");
assert.deepStrictEqual(readdirSync(HERE).filter((f) => f.startsWith(".__mutzoom_")), [],
    "aucun mutant ne doit rester sur le disque");
ok("sources intactes, aucun mutant résiduel");

// Le comparer réel reste conforme après tous les mutants (aucune contamination).
assertNoContentZoom(contentZoomSnapshot(comparer));

await tick();
comparer.stopAnimation();
console.log(`\n✅ Remote Comparer — retrait du zoom de contenu : ${n} groupes d'assertions OK`);
process.exit(0);
