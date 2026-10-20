// ─────────────────────────────────────────────────────────────────────────
// AIHRemoteComparer — MODE FONDU (case à cocher) vs VOLET historique.
//
// Le comparateur a deux modes de comparaison A/B :
//   * VOLET (défaut, historique) : ligne de partage qu'on déplace → `draw()`
//     clippe B sur `rect(0, 0, mouseX, baseH)` (espace IMAGE) puis trace la
//     ligne ; le seul état qui compte est `mouseX` (vp.screenToImage).
//   * FONDU (nouveau, case à cocher) : composition ALPHA de B sur A
//     (`globalAlpha`), sans clip ni ligne de partage ; l'alpha suit la position
//     HORIZONTALE du pointeur (px CSS), GELÉ pendant un glissement (pan) et
//     reprise sans saut au relâchement (recalage qui s'efface).
//
// Vérifie, en chargeant le VRAI module du pack sous jsdom (canvas 2D remplacé
// par un enregistreur d'opérations, images « prêtes » simulées) :
//   (a) case DÉCOCHÉE → volet STRICTEMENT identique (clip + ligne, alpha = 1) ;
//   (b) case COCHÉE → fondu actif (2 compositions alpha) et volet DÉSACTIVÉ ;
//   (c) mapping position → alpha : exact, monotone, borné 0..1 ;
//   (d) gel pendant un pan puis reprise SANS SAUT, recalage qui s'efface ;
//   (e) zoom (molette) et pan toujours fonctionnels en mode fondu, et le fondu
//       respecte le transform du viewport (cadrage) + le devicePixelRatio ;
//   (f) persistance du réglage (rechargement simulé) + défaut désactivé ;
//   (g) une seule des deux images → pas de crash (et volet : parité) ;
//   (h) option chemin `/holaf/comparer/file?path=` non régressée.
//   (i) i18n FR/EN à parité STRICTE pour le libellé et l'infobulle.
//   (j) contrôles négatifs par MUTATION (5 mutants → chaque garde mord).
//
// Usage : node js/test_remote_comparer_fade.mjs
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom absent), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const JSDOM = await loadJsdomOrSkip("test_remote_comparer_fade");

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

/* ── Canvas 2D ENREGISTREUR : jsdom n'implémente pas le canvas. ───────────
 * Chaque opération de dessin est mémorisée AVEC l'état qui compte pour ce
 * test : `globalAlpha` (composition du fondu) et le transform courant
 * (translate/scale = cadrage du viewport). `save`/`restore` restaurent l'état
 * comme le vrai contexte, ce qui permet de vérifier qu'aucun alpha ne fuit. */
function makeCtx() {
    const ops = [];
    const stack = [];
    const KEYS = ["globalAlpha", "fillStyle", "strokeStyle", "font", "textAlign",
        "textBaseline", "lineWidth", "globalCompositeOperation", "tx", "ty", "sx", "sy"];
    const ctx = {
        ops,
        globalAlpha: 1,
        fillStyle: "#000000",
        strokeStyle: "#000000",
        font: "10px sans-serif",
        textAlign: "left",
        textBaseline: "alphabetic",
        lineWidth: 1,
        globalCompositeOperation: "source-over",
        tx: 0, ty: 0, sx: 1, sy: 1,
        setTransform() { ctx.tx = 0; ctx.ty = 0; ctx.sx = 1; ctx.sy = 1; ops.push({ op: "setTransform" }); },
        clearRect() { ops.push({ op: "clearRect" }); },
        translate(x, y) { ctx.tx += x; ctx.ty += y; },
        scale(x, y) { ctx.sx *= x; ctx.sy *= y; },
        save() { stack.push(Object.fromEntries(KEYS.map((k) => [k, ctx[k]]))); ops.push({ op: "save" }); },
        restore() { const s = stack.pop(); if (s) Object.assign(ctx, s); ops.push({ op: "restore" }); },
        beginPath() { ops.push({ op: "beginPath" }); },
        rect(x, y, w, h) { ops.push({ op: "rect", x, y, w, h }); },
        clip() { ops.push({ op: "clip" }); },
        fillRect(x, y, w, h) { ops.push({ op: "fillRect", x, y, w, h, alpha: ctx.globalAlpha }); },
        fillText(text, x, y) { ops.push({ op: "fillText", text, x, y }); },
        drawImage(media, x, y, w, h) {
            ops.push({ op: "drawImage", media, x, y, w, h, alpha: ctx.globalAlpha, tx: ctx.tx, ty: ctx.ty, sx: ctx.sx, sy: ctx.sy });
        },
        moveTo() { ops.push({ op: "moveTo" }); },
        lineTo() { ops.push({ op: "lineTo" }); },
        stroke() { ops.push({ op: "stroke", composite: ctx.globalCompositeOperation }); },
        measureText() { return { width: 0 }; },
    };
    return ctx;
}

const ctxByCanvas = new WeakMap();
window.HTMLCanvasElement.prototype.getContext = function (kind) {
    if (kind !== "2d") return null;
    let c = ctxByCanvas.get(this);
    if (!c) { c = makeCtx(); ctxByCanvas.set(this, c); }
    return c;
};

/* ── Médias : jsdom ne charge rien → images « prêtes » (1280×720). ───────── */
Object.defineProperty(window.HTMLImageElement.prototype, "naturalWidth", {
    configurable: true, get() { return this.__nw ?? 1280; },
});
Object.defineProperty(window.HTMLImageElement.prototype, "naturalHeight", {
    configurable: true, get() { return this.__nh ?? 720; },
});
Object.defineProperty(window.HTMLImageElement.prototype, "complete", {
    configurable: true, get() { return this.__complete ?? true; },
});
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

/* ── BroadcastChannel : le comparer en ouvre UN par instance de module
 * (`new BroadcastChannel('holaf_comparer_bridge')`). Sous Node/jsdom, un canal
 * ouvert retient le process : sans `close()`, `node` ne rend JAMAIS la main
 * après le PASS et `js/run_js_tests.sh` se figerait. On les enregistre ici
 * (avant tout import du comparer, y compris les mutants) pour les fermer à la
 * fin — sortie naturelle, sans `process.exit` qui tronquerait stdout. */
const openChannels = [];
{
    const RealBroadcastChannel = globalThis.BroadcastChannel;
    if (typeof RealBroadcastChannel === "function") {
        globalThis.BroadcastChannel = class TrackedBroadcastChannel extends RealBroadcastChannel {
            constructor(name) { super(name); openChannels.push(this); }
        };
    }
}

/* Filet de sécurité : si un handle résiduel survivait malgré la fermeture des
 * canaux (version de Node sans BroadcastChannel global, boucle RAF oubliée…),
 * le process se figerait et la suite JS entière avec lui. Un minuteur NON
 * référencé ne retient pas le process : il ne se déclenche donc que si quelque
 * chose d'autre le retient, et force alors une sortie EXPLICITE — 0 si les
 * assertions sont déjà passées, 1 (échec visible) si le test était encore en
 * cours. Jamais de gel silencieux de js/run_js_tests.sh. */
const HARD_TIMEOUT_MS = 120000;
let finished = false;
setTimeout(() => {
    if (finished) process.exit(0);
    console.error(`❌ Remote Comparer — mode fondu : test FIGÉ (> ${HARD_TIMEOUT_MS / 1000}s)`);
    process.exit(1);
}, HARD_TIMEOUT_MS).unref();

await import("./aih_strings.js");
window.AIH.I18n.setLocale("fr");
await import("./holaf_remote_comparer.js");

const STORAGE_KEY = "holaf_remote_comparer_state_v2"; // = STORAGE_KEY du comparer
const readState = () => JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
const tr = (key) => window.AIH.I18n.t(key);

const ext = registered.find((e) => e.name === "Holaf.RemoteComparer");
assert.ok(ext, "extension Holaf.RemoteComparer enregistrée");
await ext.setup();
const comparer = fakeApp.holafRemoteComparer;
assert.ok(comparer, "comparer exposé sous app.holafRemoteComparer");

/* ═══════════════════════════ Helpers de scénario ════════════════════════ */

/** jsdom : getBoundingClientRect() renvoie 0 → on pose une vraie géométrie. */
function stubGeometry(cmp, w = 800, h = 600) {
    const rect = () => ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0 });
    cmp.canvasEl.getBoundingClientRect = rect;
    cmp.contentElement.getBoundingClientRect = rect;
    Object.defineProperty(cmp.contentElement, "clientWidth", { configurable: true, get: () => w });
    Object.defineProperty(cmp.contentElement, "clientHeight", { configurable: true, get: () => h });
    cmp.canvasEl.width = w;
    cmp.canvasEl.height = h;
}

const IMG_A = { filename: "a.png", format: "image", direct: true, path: "/tmp/out/a.png" };
const IMG_B = { filename: "b.png", format: "image", direct: true, path: "/tmp/out/b.png" };

/** Charge des métas et déclenche la « disponibilité » (jsdom ne charge pas). */
async function loadAndFire(cmp, metas, durations = {}) {
    const p = cmp.loadMedia(metas);
    cmp.images.forEach((el, i) => {
        if (!el || el._holafGenre === "other") return;
        el.__dur = durations[i] ?? 10;
        if (typeof el.onloadeddata === "function") el.onloadeddata();
        else if (typeof el.onload === "function") el.onload();
    });
    await p;
    cmp.stopAnimation(); // pas de boucle RAF résiduelle dans les tests
}

const enter = (cmp) => cmp.contentElement.dispatchEvent(new window.MouseEvent("mouseenter"));
// Comme dans un navigateur, un `mousemove` implique que le pointeur est SUR le
// canvas (mouseenter a donc déjà eu lieu) : l'attribut `isMouseOver` du volet en
// dépend.
const move = (cmp, clientX, clientY = 300) => {
    if (!cmp.isMouseOver) enter(cmp);
    return cmp.contentElement.dispatchEvent(
        new window.MouseEvent("mousemove", { clientX, clientY, bubbles: true }));
};
const down = (cmp, clientX, clientY = 300) => cmp.canvasEl.dispatchEvent(
    new window.MouseEvent("mousedown", { clientX, clientY, bubbles: true, button: 0, buttons: 1 }));
const up = () => window.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
const wheel = (cmp, deltaY, clientX = 400, clientY = 300) => cmp.canvasEl.dispatchEvent(
    new window.WheelEvent("wheel", { deltaY, clientX, clientY, bubbles: true, cancelable: true }));

/** État de départ commun : géométrie, fenêtre visible, mode, deux images. */
async function prepare(cmp, { fadeOn }) {
    stubGeometry(cmp);
    cmp.show();
    cmp.fadeAlpha = 0.5;      // valeur neutre connue (le défaut est testé à part)
    cmp._fadeOffset = 0;
    cmp._fadeLastX = null;
    cmp.setFadeMode(fadeOn);
    await loadAndFire(cmp, [IMG_A, IMG_B]);
    cmp.vp.fit();
    cmp.ctx.ops.length = 0;
}

const opsBetween = (cmp, from) => cmp.ctx.ops.slice(from);
const pick = (ops, kind) => ops.filter((o) => o.op === kind);

/* ═════════════ (1) La case à cocher : présente, libellée, désactivée ════ */
console.log("(1) Case à cocher « mode fondu » : place, type, libellé, défaut");

const snapshotCheckbox = (cmp) => {
    const settings = cmp.sidebarBottomContainer.querySelector(".holaf-rc-settings-container");
    const cb = settings ? settings.querySelector('input[type="checkbox"]') : null;
    const lbl = cb ? settings.querySelector(`label[for="${cb.id}"]`) : null;
    return {
        hasSettings: !!settings,
        isCheckbox: !!cb && cb.tagName === "INPUT" && cb.type === "checkbox",
        checked: cb ? cb.checked : null,
        id: cb ? cb.id : null,
        labelFor: lbl ? lbl.htmlFor : null,
        labelText: lbl ? String(lbl.textContent || "") : "",
        title: cb ? String(cb.title || "") : "",
        ariaLabel: cb ? String(cb.getAttribute("aria-label") || "") : "",
        // La case vit dans la zone de contrôles (barre latérale), pas dans le titre.
        inSidebar: !!settings && cmp.sidebarBottomContainer.contains(settings),
        inHeader: !!cmp.rootElement.querySelector(".holaf-utility-header input"),
        fadeMode: cmp.fadeMode,
    };
};

const cbSnap = snapshotCheckbox(comparer);
assert.strictEqual(cbSnap.hasSettings, true, "zone de réglages de la barre latérale présente");
assert.strictEqual(cbSnap.isCheckbox, true, "(1) VRAIE <input type=checkbox> (jamais un bouton déguisé)");
assert.strictEqual(cbSnap.checked, false, "(1) valeur par DÉFAUT = désactivé (volet historique)");
assert.strictEqual(cbSnap.fadeMode, false, "(1) état interne par défaut = volet");
assert.strictEqual(cbSnap.labelFor, cbSnap.id, "(1) libellé associé à la case (`label[for]`)");
assert.ok(cbSnap.labelText.trim().length > 0, "(1) libellé non vide");
assert.ok(cbSnap.title.trim().length > 0, "(1) infobulle (title) présente");
assert.strictEqual(cbSnap.ariaLabel, tr("rc.fadeMode"), "(1) aria-label = libellé i18n");
assert.strictEqual(cbSnap.inSidebar, true, "(1) la case est dans la zone de contrôles existante");
assert.strictEqual(cbSnap.inHeader, false, "(1) pas dans la barre de titre (un seul bouton y reste)");
ok("(1) case à cocher réelle, libellée, aria/title propres, désactivée par défaut");

/* ══════════ (a) Case DÉCOCHÉE → volet strictement identique ════════════ */
console.log("(a) Case décochée : le volet historique est intact");

async function splitSnapshot(cmp, mouseXCss = 200) {
    await prepare(cmp, { fadeOn: false });
    const expectedClip = cmp.vp.screenToImage(mouseXCss, 300).x;
    const from = cmp.ctx.ops.length;
    move(cmp, mouseXCss, 300);
    const ops = opsBetween(cmp, from);
    const imgs = pick(ops, "drawImage");
    return {
        fadeMode: cmp.fadeMode,
        clips: pick(ops, "clip").length,
        rects: pick(ops, "rect"),
        strokes: pick(ops, "stroke").length,
        alphas: imgs.map((o) => o.alpha),
        order: imgs.map((o) => (o.media === cmp.images[0] ? "A" : "B")),
        expectedClip,
        bIndex: imgs.findIndex((o) => o.media === cmp.images[1]),
        clippedBeforeB: (() => {
            const i = imgs.findIndex((o) => o.media === cmp.images[1]);
            if (i < 0) return false;
            const upto = ops.slice(0, ops.indexOf(imgs[i]));
            return pick(upto, "clip").length > 0;
        })(),
    };
}

function assertSplitIntact(s) {
    assert.strictEqual(s.fadeMode, false, "volet : le mode fondu est bien désactivé");
    assert.strictEqual(s.clips, 1, "volet : B est clippée (exactement 1 clip)");
    assert.strictEqual(s.rects.length, 1, "volet : exactement 1 rectangle de clip");
    assert.ok(Math.abs(s.rects[0].w - s.expectedClip) < 1e-9,
        `volet : largeur de clip = position souris en espace image (${s.rects[0].w} ≠ ${s.expectedClip})`);
    assert.strictEqual(s.strokes, 1, "volet : la ligne de partage est tracée");
    assert.strictEqual(s.alphas.length, 2, "volet : A puis B dessinées");
    assert.deepStrictEqual(s.order, ["A", "B"], "volet : ordre de dessin A puis B inchangé");
    assert.strictEqual(s.clippedBeforeB, true, "volet : le clip précède le dessin de B");
    assert.ok(s.alphas.every((a) => a === 1), "volet : aucune composition alpha (alpha = 1 partout)");
}

const split = await splitSnapshot(comparer);
assertSplitIntact(split);
ok(`(a) volet identique : clip=${split.rects[0].w}px (espace image) + ligne + alpha=1`);

/* ═════════ (b) Case COCHÉE → fondu actif, volet DÉSACTIVÉ ══════════════ */
console.log("(b) Case cochée : fondu alpha, aucun volet");

async function fadeSnapshot(cmp, mouseXCss = 200, width = 800) {
    await prepare(cmp, { fadeOn: true });
    const fromIdle = cmp.ctx.ops.length;
    cmp.draw(); // sans déplacement : valeur neutre
    const idleImgs = pick(opsBetween(cmp, fromIdle), "drawImage");

    const from = cmp.ctx.ops.length;
    move(cmp, mouseXCss, 300);
    const ops = opsBetween(cmp, from);
    const imgs = pick(ops, "drawImage");
    return {
        fadeMode: cmp.fadeMode,
        clips: pick(ops, "clip").length,
        strokes: pick(ops, "stroke").length,
        idleAlphas: idleImgs.map((o) => o.alpha),
        alphas: imgs.map((o) => o.alpha),
        order: imgs.map((o) => (o.media === cmp.images[0] ? "A" : "B")),
        expected: 1 - mouseXCss / width,
        fadeAlpha: cmp._fadeAlphaB(),
        leak: (() => {
            // Après restore, l'alpha du contexte doit être revenu à 1 (aucune fuite
            // sur le HUD audio ni sur les frames suivantes).
            cmp.ctx.ops.length = 0;
            cmp.draw();
            return pick(cmp.ctx.ops, "drawImage").map((o) => o.alpha);
        })(),
    };
}

function assertFadeActive(s) {
    assert.strictEqual(s.fadeMode, true, "fondu : la case cochée active bien le mode");
    assert.strictEqual(s.clips, 0, "fondu : AUCUN clip (le volet ne doit plus être dessiné)");
    assert.strictEqual(s.strokes, 0, "fondu : AUCUNE ligne de partage");
    assert.strictEqual(s.alphas.length, 2, "fondu : A puis B composées");
    assert.deepStrictEqual(s.order, ["A", "B"], "fondu : ordre de dessin A puis B");
    assert.strictEqual(s.alphas[0], 1, "fondu : A est dessinée pleinement (fond)");
    assert.ok(Math.abs(s.alphas[1] - s.expected) < 1e-9,
        `fondu : alpha de B = 1 − x/largeur (${s.alphas[1]} ≠ ${s.expected})`);
    assert.ok(s.alphas[1] > 0 && s.alphas[1] < 1, "fondu : composition réellement intermédiaire");
    assert.strictEqual(s.idleAlphas[1], 0.5, "fondu : valeur neutre (50 %) sans position connue");
    assert.ok(s.leak.every((a) => a === 1 || Math.abs(a - s.expected) < 1e-9),
        "fondu : aucun alpha ne fuit après restauration du contexte");
}

const fade = await fadeSnapshot(comparer);
assertFadeActive(fade);
ok(`(b) fondu : alpha B = ${fade.alphas[1]} pour x=200 (volet : 0 clip, 0 ligne)`);

/* ══════════ (c) Mapping position → alpha : exact, monotone, borné ═══════ */
console.log("(c) Mapping souris → alpha : valeurs exactes, monotone, borné 0..1");

const mappingCases = [
    [0, 800, 1],
    [200, 800, 0.75],
    [400, 800, 0.5],
    [600, 800, 0.25],
    [800, 800, 0],
    [-50, 800, 1],   // hors canvas à gauche → borné
    [900, 800, 0],   // hors canvas à droite → borné
    [0, 0, 0.5],     // géométrie inconnue → neutre (jamais NaN)
    [NaN, 800, 0.5], // position inconnue → neutre (jamais NaN)
];
for (const [x, w, expected] of mappingCases) {
    assert.strictEqual(comparer._fadeAlpha(x, w), expected,
        `(c) _fadeAlpha(${x}, ${w}) doit valoir ${expected}`);
}
// Monotonie stricte décroissante + bornes sur un balayage complet.
let prev = Infinity;
let min = Infinity;
let max = -Infinity;
for (let x = -100; x <= 900; x += 1) {
    const a = comparer._fadeAlpha(x, 800);
    assert.ok(Number.isFinite(a), `(c) alpha fini pour x=${x}`);
    assert.ok(a >= 0 && a <= 1, `(c) alpha borné 0..1 pour x=${x} (${a})`);
    assert.ok(a <= prev, `(c) monotone décroissant (rupture à x=${x})`);
    prev = a;
    min = Math.min(min, a);
    max = Math.max(max, a);
}
assert.strictEqual(max, 1, "(c) alpha maximum = 1 (bord gauche)");
assert.strictEqual(min, 0, "(c) alpha minimum = 0 (bord droit)");
// Le dessin utilise TOUJOURS la valeur bornée, même si l'état interne est corrompu.
comparer.fadeAlpha = 42;
assert.strictEqual(comparer._fadeAlphaB(), 1, "(c) état corrompu → alpha borné à 1");
comparer.fadeAlpha = -3;
assert.strictEqual(comparer._fadeAlphaB(), 0, "(c) état corrompu → alpha borné à 0");
comparer.fadeAlpha = 0.5;
ok("(c) mapping exact, monotone décroissant, borné 0..1 (9 cas + balayage 1001 points)");

/* ════════ (d) Gel pendant un pan, reprise sans saut, recalage ══════════ */
console.log("(d) Glissement (pan) : fondu gelé, reprise sans saut");

async function panFreezeSnapshot(cmp, width = 800) {
    await prepare(cmp, { fadeOn: true });
    cmp.vp.setScale(cmp.vp.getFitScale() * 2, 400, 300); // zoom → pan possible
    move(cmp, 600, 300);                                  // alpha = 1 − 600/800
    const alphaBefore = cmp._fadeAlphaB();
    const t0 = cmp.vp.getTransform();

    down(cmp, 600, 300);
    move(cmp, 700, 300);
    const alphaDuring1 = cmp._fadeAlphaB();
    move(cmp, 780, 300);
    const alphaDuring2 = cmp._fadeAlphaB();
    const t1 = cmp.vp.getTransform();
    up();
    const alphaAtRelease = cmp._fadeAlphaB();
    const offsetAtRelease = cmp._fadeOffset;

    move(cmp, 781, 300);
    const alphaAfter1 = cmp._fadeAlphaB();

    // Balayage : le recalage doit s'effacer (retour au mapping absolu).
    for (let x = 781; x >= 21; x -= 40) move(cmp, x, 300);
    for (let x = 21; x <= 400; x += 40) move(cmp, x, 300);
    move(cmp, 400, 300);
    const alphaSettled = cmp._fadeAlphaB();
    const offsetSettled = cmp._fadeOffset;

    return {
        width, alphaBefore, alphaDuring1, alphaDuring2, alphaAtRelease, offsetAtRelease,
        alphaAfter1, alphaSettled, offsetSettled,
        isPanning: cmp.isPanning,
        dtx: t1.tx - t0.tx, dty: t1.ty - t0.ty,
        absoluteAt400: cmp._fadeAlpha(400, width),
    };
}

function assertPanFreeze(s) {
    assert.strictEqual(s.isPanning, false, "le glissement est bien terminé");
    assert.strictEqual(s.alphaDuring1, s.alphaBefore, "fondu GELÉ pendant le glissement (1er mouvement)");
    assert.strictEqual(s.alphaDuring2, s.alphaBefore, "fondu GELÉ pendant le glissement (2e mouvement)");
    assert.strictEqual(s.alphaAtRelease, s.alphaBefore, "aucun saut au relâchement de la souris");
    assert.ok(Math.abs(s.alphaAfter1 - s.alphaAtRelease) <= 1 / s.width + 1e-9,
        `reprise SANS SAUT : 1 px de pointeur → au plus 1/${s.width} d'alpha (${s.alphaAfter1} vs ${s.alphaAtRelease})`);
    assert.ok(Math.abs(s.dtx) > 1 || Math.abs(s.dty) > 1, "le glissement a réellement déplacé l'image (pan)");
    assert.ok(Math.abs(s.offsetSettled) < Math.abs(s.offsetAtRelease),
        "le recalage s'efface avec le déplacement");
    assert.ok(Math.abs(s.alphaSettled - s.absoluteAt400) < 0.06,
        `retour au mapping absolu (${s.alphaSettled} vs ${s.absoluteAt400})`);
}

const freeze = await panFreezeSnapshot(comparer);
assertPanFreeze(freeze);
ok(`(d) gel (${freeze.alphaBefore}) pendant le pan → reprise ${freeze.alphaAfter1} → recalage effacé`);

/* ══════ (e) Zoom/pan en mode fondu + cadrage viewport respecté ═════════ */
console.log("(e) Zoom (molette) et pan fonctionnels en mode fondu ; cadrage respecté");

async function zoomPanFadeSnapshot(cmp, mouseXCss = 460) {
    await prepare(cmp, { fadeOn: true });
    const fit = cmp.vp.getFitScale();
    const scale0 = cmp.vp.getScale();
    move(cmp, mouseXCss, 330);
    const alphaAtFit = cmp._fadeAlphaB();
    wheel(cmp, -100, 400, 300);
    const afterUp = cmp.vp.getScale();
    wheel(cmp, +100, 400, 300);
    const afterDown = cmp.vp.getScale();

    cmp.vp.setScale(fit * 2, 400, 300);
    const t0 = cmp.vp.getTransform();
    down(cmp, 400, 300);
    move(cmp, 460, 330);
    up();
    const t1 = cmp.vp.getTransform();

    // On neutralise le recalage issu du glissement pour ne comparer QUE le
    // mapping absolu avant/après zoom (l'alpha ne doit pas dépendre du cadrage).
    cmp._fadeOffset = 0;
    cmp._fadeLastX = null;
    move(cmp, mouseXCss, 330);
    const alphaAfterZoom = cmp._fadeAlphaB();
    cmp.ctx.ops.length = 0;
    cmp.draw();
    const imgs = pick(cmp.ctx.ops, "drawImage");

    // devicePixelRatio ≠ 1 : le mapping reste en px CSS (aucun décalage).
    const dpr = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    cmp.ctx.ops.length = 0;
    move(cmp, mouseXCss, 330);
    const imgsHiDpi = pick(cmp.ctx.ops, "drawImage");
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: dpr });

    cmp.resetZoom();
    return {
        fit, scale0, afterUp, afterDown,
        dtx: t1.tx - t0.tx, dty: t1.ty - t0.ty,
        transform: t1,
        alphaAtFit, alphaAfterZoom,
        imgs: imgs.map((o) => ({ alpha: o.alpha, tx: o.tx, ty: o.ty, sx: o.sx })),
        imgsHiDpi: imgsHiDpi.map((o) => o.alpha),
        expected: 1 - mouseXCss / 800,
        afterReset: cmp.vp.getScale(),
        fadeMode: cmp.fadeMode,
    };
}

function assertZoomPanInFade(s) {
    assert.strictEqual(s.fadeMode, true, "on mesure bien en mode fondu");
    assert.ok(s.fit > 0, "fit de la brique calculé (géométrie disponible)");
    assert.ok(Math.abs(s.afterUp - s.scale0 * 1.1) < 1e-6, "molette avant : zoom ×1.1 conservé en mode fondu");
    assert.ok(Math.abs(s.afterDown - s.scale0) < 1e-6, "molette arrière : retour exact au fit");
    assert.ok(Math.abs(s.dtx) > 1 || Math.abs(s.dty) > 1, "pan opérationnel en mode fondu");
    assert.strictEqual(s.imgs.length, 2, "fondu : A + B dessinées avec le cadrage courant");
    assert.ok(Math.abs(s.imgs[1].alpha - s.expected) < 1e-9, "fondu : alpha de B = 1 − x/largeur après zoom");
    assert.ok(Math.abs(s.alphaAtFit - s.expected) < 1e-9 && Math.abs(s.alphaAfterZoom - s.expected) < 1e-9,
        "fondu : alpha INDÉPENDANT du zoom/pan (même position → même alpha)");
    assert.ok(Math.abs(s.imgs[0].tx - s.transform.tx) < 1e-9 && Math.abs(s.imgs[0].ty - s.transform.ty) < 1e-9,
        "fondu : le dessin suit EXACTEMENT le transform du viewport (tx/ty)");
    assert.ok(Math.abs(s.imgs[0].sx - s.transform.scale) < 1e-9,
        "fondu : le dessin suit EXACTEMENT le scale du viewport");
    assert.ok(Math.abs(s.imgsHiDpi[1] - s.expected) < 1e-9,
        "fondu : devicePixelRatio ≠ 1 n'introduit aucun décalage du mapping");
    assert.ok(Math.abs(s.afterReset - s.fit) < 1e-6, "resetZoom() toujours fonctionnel en mode fondu");
}

const zoomPan = await zoomPanFadeSnapshot(comparer);
assertZoomPanInFade(zoomPan);
ok(`(e) zoom ×1.1 + pan + reset OK en fondu (tx=${zoomPan.imgs[0].tx.toFixed(1)}, scale=${zoomPan.imgs[0].sx.toFixed(3)})`);

/* ══════════════ (f) Persistance du réglage (rechargement simulé) ═══════ */
console.log("(f) Persistance avec les réglages de la fenêtre + défaut désactivé");

comparer.setFadeMode(false);
move(comparer, 400, 300);
assert.strictEqual(readState().fadeMode, false, "(f) case décochée → état persisté fadeMode=false");

const cbEl = comparer.sidebarBottomContainer.querySelector('input[type="checkbox"]');
cbEl.checked = true;
cbEl.dispatchEvent(new window.Event("change", { bubbles: true }));
assert.strictEqual(comparer.fadeMode, true, "(f) cocher la case active le mode");
assert.strictEqual(readState().fadeMode, true, "(f) le réglage est persisté dans STORAGE_KEY");
assert.ok(JSON.stringify(readState()).includes("fadeMode"), "(f) clé `fadeMode` bien sérialisée");
// Le réglage de VUE ne part jamais au backend (le node ne le connaît pas).
assert.strictEqual("fadeMode" in comparer.globalSettings, false,
    "(f) fadeMode hors de `globalSettings` (jamais envoyé à /holaf/comparer/settings)");

// Rechargement simulé : nouveau module (état neuf) → réglage restauré.
await import("./holaf_remote_comparer.js?fresh=1");
const freshExt = registered.filter((e) => e && e.name === "Holaf.RemoteComparer").pop();
await freshExt.setup();
const fresh = fakeApp.holafRemoteComparer;
const freshCb = fresh.sidebarBottomContainer.querySelector('input[type="checkbox"]');
assert.strictEqual(fresh.fadeMode, true, "(f) après rechargement : mode fondu restauré");
assert.strictEqual(freshCb.checked, true, "(f) après rechargement : la case est cochée");
assert.strictEqual(fresh.fadeAlpha, 0.5, "(f) valeur de fondu initiale neutre (50 %)");

// État LEGACY (aucune clé fadeMode) → défaut DÉSACTIVÉ.
window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ right: 50, bottom: 50, width: 850, height: 500 }));
fresh.restoreState();
assert.strictEqual(fresh.fadeMode, false, "(f) état legacy sans clé → volet (défaut désactivé)");
fresh.setFadeMode(true);
ok("(f) persistance OK (case + rechargement) et défaut désactivé (même sur état legacy)");

/* ══════════ (g) Une seule des deux images → aucun crash ════════════════ */
console.log("(g) Une seule image disponible : pas de crash, celle qui existe s'affiche");

async function singleImageSnapshot(cmp) {
    await prepare(cmp, { fadeOn: true });
    const readyB = cmp.images[1];
    const readyA = cmp.images[0];

    // A absente, B présente, mode fondu.
    cmp.images = [null, readyB];
    cmp.ctx.ops.length = 0;
    let threw = null;
    try { cmp.draw(); } catch (e) { threw = e; }
    const fadeOps = cmp.ctx.ops.slice();
    const fadeAlphas = pick(fadeOps, "drawImage").map((o) => o.alpha);

    // Même situation en mode VOLET → parité historique : rien n'est dessiné.
    cmp.setFadeMode(false);
    cmp.images = [null, readyB];
    cmp.ctx.ops.length = 0;
    cmp.draw();
    const splitOps = cmp.ctx.ops.slice();

    // A seule (B absente), mode fondu.
    cmp.setFadeMode(true);
    cmp.images = [readyA];
    cmp.ctx.ops.length = 0;
    cmp.draw();
    const onlyAOps = cmp.ctx.ops.slice();

    return {
        threw,
        fadeImgs: pick(fadeOps, "drawImage").length,
        fadeAlphas,
        fadeClips: pick(fadeOps, "clip").length,
        splitImgs: pick(splitOps, "drawImage").length,
        onlyAImgs: pick(onlyAOps, "drawImage").length,
        onlyAClips: pick(onlyAOps, "clip").length,
    };
}

function assertSingleImageSafe(s) {
    assert.strictEqual(s.threw, null, "aucune exception avec une seule image");
    assert.strictEqual(s.fadeImgs, 1, "fondu, A absente : B est affichée (une seule composition)");
    assert.deepStrictEqual(s.fadeAlphas, [1], "fondu, A absente : B pleinement visible (rien à mélanger)");
    assert.strictEqual(s.fadeClips, 0, "fondu, A absente : aucun clip");
    assert.strictEqual(s.splitImgs, 0, "volet, A absente : parité stricte (rien n'est dessiné)");
    assert.strictEqual(s.onlyAImgs, 1, "fondu, B absente : A reste affichée");
    assert.strictEqual(s.onlyAClips, 0, "fondu, B absente : aucun clip, aucune ligne");
}

const single = await singleImageSnapshot(comparer);
assertSingleImageSafe(single);
ok("(g) une seule image : pas de crash, celle qui existe s'affiche (volet : parité)");

/* ══════════ (h) Option chemin `/holaf/comparer/file` non régressée ═════ */
console.log("(h) Option chemin de fichier + vidéo/audio + tensor /view");

await prepare(comparer, { fadeOn: true });
assert.ok(comparer.images[0].src.includes("/holaf/comparer/file?path="), "(h) A servie par la route directe");
assert.ok(comparer.images[0].src.includes(encodeURIComponent("/tmp/out/a.png")), "(h) chemin encodé");
assert.ok(comparer.images[1].src.includes("/holaf/comparer/file?path="), "(h) B servie par la route directe");
assert.ok(!comparer.images[0].src.includes("/view?"), "(h) jamais /view pour un fichier direct");

await loadAndFire(comparer, [{ filename: "clip.mp4", format: "video", direct: true, path: "/tmp/out/clip.mp4" }]);
assert.ok(comparer.images[0] instanceof window.HTMLVideoElement, "(h) vidéo directe -> <video>");
comparer.uiControls.timeline.value = "500";
comparer.uiControls.timeline.oninput({ target: comparer.uiControls.timeline });
assert.strictEqual(comparer.images[0].currentTime, 5, "(h) seek (Range) toujours fonctionnel");

await loadAndFire(comparer, [{ filename: "track.wav", format: "audio", direct: true, path: "/tmp/out/track.wav" }]);
assert.ok(comparer.images[0] instanceof window.HTMLAudioElement, "(h) audio direct -> <audio>");

await loadAndFire(comparer, [{ filename: "legacy.png", type: "output", subfolder: "", format: "image" }]);
assert.ok(comparer.images[0].src.includes("/view?filename=legacy.png"), "(h) tensor IMAGE -> /view (inchangé)");
ok("(h) chemin direct, vidéo/audio, seek et route /view : intacts en mode fondu");

/* ══════════ (i) i18n FR/EN : clés présentes, parité stricte ════════════ */
console.log("(i) i18n FR/EN : libellé + infobulle, parité stricte");

const LINE_RX = /^\s*("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*$/;
function parseDicts(src) {
    const iFr = src.indexOf("const FR = {");
    const iEn = src.indexOf("const EN = {");
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
    return { fr: parse(src.slice(iFr, iEn)), en: parse(src.slice(iEn)) };
}

const { fr, en } = parseDicts(readFileSync(join(HERE, "aih_strings.js"), "utf8"));
assert.deepStrictEqual(Object.keys(fr).sort(), Object.keys(en).sort(),
    "(i) parité FR/EN cassée : jeux de clés différents");
for (const key of ["rc.fadeMode", "rc.fadeModeHint"]) {
    assert.ok(key in fr && key in en, `(i) clé « ${key} » absente d'un dictionnaire`);
    assert.ok(String(fr[key]).trim().length > 0, `(i) « ${key} » vide en FR`);
    assert.ok(String(en[key]).trim().length > 0, `(i) « ${key} » vide en EN`);
    assert.strictEqual(fr[key], fr[key].trim(), `(i) « ${key} » : espace parasite en FR`);
    assert.strictEqual(en[key], en[key].trim(), `(i) « ${key} » : espace parasite en EN`);
}
assert.strictEqual(tr("rc.fadeMode"), fr["rc.fadeMode"], "(i) le libellé rendu vient du dictionnaire FR");
window.AIH.I18n.setLocale("en");
assert.strictEqual(tr("rc.fadeMode"), en["rc.fadeMode"], "(i) le libellé suit la locale EN");
assert.strictEqual(tr("rc.fadeModeHint"), en["rc.fadeModeHint"], "(i) l'infobulle suit la locale EN");
window.AIH.I18n.setLocale("fr");
assert.strictEqual(fr["rc.fadeMode"], "Mode fondu", "(i) texte FR exact");
assert.strictEqual(en["rc.fadeMode"], "Fade mode", "(i) texte EN exact");
ok(`(i) 2 clés FR+EN, parité stricte (${Object.keys(fr).length} clés)`);

/* ══════════ (j) Contrôles négatifs par MUTATION (5 mutants) ════════════ */
console.log("(j) Contrôles négatifs par mutation");

const SRC = readFileSync(join(HERE, "holaf_remote_comparer.js"), "utf8");

// Nettoyage d'un éventuel résidu d'une exécution interrompue.
for (const f of readdirSync(HERE)) {
    if (/^\.__mutrcfade_\d+_/.test(f)) rmSync(join(HERE, f), { force: true });
}

let seq = 0;
/** Boote un mutant du comparer (module réel réécrit) et renvoie son instance. */
async function bootMutant(label, mutate) {
    const mutated = mutate(SRC);
    assert.notStrictEqual(mutated, SRC, `mutation « ${label} » sans effet (ancre introuvable)`);
    const file = join(HERE, `.__mutrcfade_${++seq}_comparer.mjs`);
    writeFileSync(file, mutated, "utf8");
    await import("file://" + file + `?m=${seq}`);
    const mutExt = registered.filter((e) => e && e.name === "Holaf.RemoteComparer").pop();
    assert.ok(mutExt && mutExt !== ext, `mutation « ${label} » : extension du mutant non enregistrée`);
    await mutExt.setup();
    return { cmp: fakeApp.holafRemoteComparer, file };
}

// M1 — alpha NON BORNÉ → (c) rouge.
{
    const { cmp, file } = await bootMutant("alpha non borné", (s) => s.replace(
        "        const ratio = Math.min(1, Math.max(0, px / w)); // borne la POSITION\n        return 1 - ratio;",
        "        return 1 - px / w;"));
    try {
        assert.ok(cmp._fadeAlpha(-100, 800) > 1, "mutant M1 : alpha > 1 possible (mutant valide)");
        assert.throws(() => {
            assert.strictEqual(cmp._fadeAlpha(-50, 800), 1, "(c) alpha borné à gauche");
        }, /borné/, "mutant M1 : (c) devient ROUGE — alpha non borné");
        assert.throws(() => {
            for (let x = -100; x <= 900; x += 1) {
                const a = cmp._fadeAlpha(x, 800);
                assert.ok(a >= 0 && a <= 1, "(c) alpha borné 0..1");
            }
        }, /borné/, "mutant M1 : (c) devient ROUGE au balayage");
    } finally {
        rmSync(file, { force: true });
    }
    ok("M1 alpha non borné → (c) ROUGE");
}

// M2 — le VOLET est encore dessiné en mode fondu → (b) rouge.
{
    const { cmp, file } = await bootMutant("volet encore dessiné en fondu", (s) => s.replace(
        "        } else if ((this.isMouseOver || this.isPanning) && this.mouseX !== null) {",
        "        }\n        if ((this.isMouseOver || this.isPanning) && this.mouseX !== null) {"));
    try {
        const snap = await fadeSnapshot(cmp);
        assert.strictEqual(snap.clips, 1, "mutant M2 : un clip est de nouveau présent (mutant valide)");
        assert.throws(() => assertFadeActive(snap), /AUCUN clip/,
            "mutant M2 : (b) devient ROUGE — le volet est encore dessiné en mode fondu");
    } finally {
        rmSync(file, { force: true });
    }
    ok("M2 volet encore dessiné en fondu → (b) ROUGE");
}

// M3 — le FONDU casse le PAN (drag désactivé) → (e) rouge.
{
    const { cmp, file } = await bootMutant("fondu cassant le pan", (s) => s.replace(
        "            drag: true,", "            drag: false,"));
    try {
        const snap = await zoomPanFadeSnapshot(cmp);
        assert.ok(Math.abs(snap.dtx) < 1e-9 && Math.abs(snap.dty) < 1e-9,
            "mutant M3 : le glissement ne déplace plus rien (mutant valide)");
        assert.throws(() => assertZoomPanInFade(snap), /pan opérationnel/,
            "mutant M3 : (e) devient ROUGE — le mode fondu casse le pan");
    } finally {
        rmSync(file, { force: true });
    }
    ok("M3 fondu cassant le pan → (e) ROUGE");
}

// M3b — le fondu n'est plus GELÉ pendant le glissement → (d) rouge.
{
    const { cmp, file } = await bootMutant("gel du fondu supprimé", (s) => s.replace(
        "            if (!this.isPanning) this._updateFadeFromPointer(this.rawMouseX);",
        "            this._updateFadeFromPointer(this.rawMouseX);"));
    try {
        const snap = await panFreezeSnapshot(cmp);
        assert.notStrictEqual(snap.alphaDuring1, snap.alphaBefore,
            "mutant M3b : le fondu suit la souris pendant le glissement (mutant valide)");
        assert.throws(() => assertPanFreeze(snap), /GELÉ/,
            "mutant M3b : (d) devient ROUGE — le fondu n'est plus gelé pendant un pan");
    } finally {
        rmSync(file, { force: true });
    }
    ok("M3b gel du fondu supprimé → (d) ROUGE");
}

// M4 — réglage NON PERSISTÉ → (f) rouge.
{
    const { cmp, file } = await bootMutant("réglage non persisté", (s) => s.replace(
        "            fadeMode: this.fadeMode === true,\n", ""));
    try {
        cmp.setFadeMode(true);
        assert.notStrictEqual(readState().fadeMode, true,
            "mutant M4 : le réglage n'est plus persisté (mutant valide)");
        assert.throws(() => {
            assert.strictEqual(readState().fadeMode, true, "(f) le réglage est persisté");
        }, /persisté/, "mutant M4 : (f) devient ROUGE — réglage non persisté");
    } finally {
        rmSync(file, { force: true });
    }
    ok("M4 réglage non persisté → (f) ROUGE");
}

// M5 — le VOLET est perdu quand la case est décochée → (a) rouge.
{
    const { cmp, file } = await bootMutant("volet perdu case décochée", (s) => s.replace(
        "        } else if ((this.isMouseOver || this.isPanning) && this.mouseX !== null) {",
        "        } else if (false && (this.isMouseOver || this.isPanning) && this.mouseX !== null) {"));
    try {
        const snap = await splitSnapshot(cmp);
        assert.strictEqual(snap.clips, 0, "mutant M5 : plus aucun clip en mode volet (mutant valide)");
        assert.throws(() => assertSplitIntact(snap), /1 clip/,
            "mutant M5 : (a) devient ROUGE — le volet est perdu quand la case est décochée");
    } finally {
        rmSync(file, { force: true });
    }
    ok("M5 volet perdu case décochée → (a) ROUGE");
}

// Aucun mutant résiduel.
assert.deepStrictEqual(readdirSync(HERE).filter((f) => /^\.__mutrcfade_\d+_/.test(f)), [],
    "aucun mutant résiduel dans js/");
assert.strictEqual(readFileSync(join(HERE, "holaf_remote_comparer.js"), "utf8"), SRC,
    "source du comparer intacte après les mutations");

// ── Sortie propre : arrêt des boucles RAF connues + fermeture des canaux ──
for (const inst of [comparer, fakeApp.holafRemoteComparer]) {
    try { inst.stopAnimation(); } catch { /* instance remplacée par un mutant */ }
}
for (const ch of openChannels) {
    try { ch.close(); } catch { /* déjà fermé */ }
}
finished = true;

console.log(`\n✅ Remote Comparer — mode fondu : TOUS LES TESTS PASSENT (${n} étapes)`);
