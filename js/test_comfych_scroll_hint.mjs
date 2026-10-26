// ─────────────────────────────────────────────────────────────────────────
// ComfyCH — pied de l'étape « Build » + indicateur « il y a du contenu plus bas ».
//
// Deux ajustements d'UI, chacun verrouillé par un test ET par ses mutants :
//   §1 le bouton « ♻️ Redémarrer le worker » vit dans le PIED de l'étape 1
//      (zone non défilante, toujours visible) — il n'est PLUS dans le corps
//      défilant, l'`id` est conservé et il n'existe qu'UNE fois dans le
//      document. MUTANT M1 « bouton laissé dans le corps » → ROUGE ;
//   §2 ce bouton se désactive TOUJOURS pendant une opération
//      (`OP_BUTTON_IDS['restart-worker']`) et garde sa confirmation si un rendu
//      tourne (fail-closed) ;
//   §3 l'indicateur de débordement (`attachScrollHint`) est GÉNÉRIQUE :
//      affiché seulement si le contenu dépasse et qu'on n'est pas en bas,
//      masqué à la fin, de retour en haut — MUTANT M2 « toujours affiché » et
//      MUTANT M3 « jamais affiché » → ROUGE ;
//   §4 il se remet à jour au défilement, au redimensionnement de la fenêtre ET
//      quand le CONTENU change — MUTANT M5 « pas de mise à jour au changement
//      de contenu » → ROUGE ;
//   §5 il n'intercepte JAMAIS un clic (`pointer-events: none`) — MUTANT M4
//      « indicateur qui capte les clics » → ROUGE ;
//   §6 forme : chevron `chevron-down` de la façade js/aih_icons.js (aucun
//      emoji), dégradé, `prefers-reduced-motion` respecté, aucune couleur en
//      dur (tokens du pack seulement) ;
//   §7 câblage réel dans la modale : les 3 corps d'étape + le panneau défilant
//      portent l'indicateur, détruit à la fermeture (aucun écouteur orphelin).
//
// Usage : node js/test_comfych_scroll_hint.mjs
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

const JSDOM = await loadJsdomOrSkip("test_comfych_scroll_hint");
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
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
// jsdom fournit MutationObserver (pas ResizeObserver) : c'est lui qui détecte un
// changement de CONTENU — on l'expose comme en navigateur.
globalThis.MutationObserver = domWindow.MutationObserver;
try { globalThis.navigator = domWindow.navigator; } catch { /* déjà fourni */ }
domWindow.matchMedia = domWindow.matchMedia
    || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));

localStorage.setItem("aih_locale", "fr");

/* ══════════════ Harnais réseau minimal (la modale ne touche que l'API) ══════════════ */

const restartCalls = [];

function jsonResponse(body, status) {
    return {
        ok: (status || 200) < 400,
        status: status || 200,
        headers: { get: () => "application/json" },
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

/** Rendu cloud volontairement EN COURS (POST /generate qui ne résout jamais). */
const generateDeferred = { resolve: null };
const pendingGenerate = new Promise((res) => { generateDeferred.resolve = res; });
const generateCalls = [];

globalThis.fetch = async (url, opts) => {
    const target = String(url);
    if (target.includes("/generate")) {
        generateCalls.push({ url: target, body: JSON.parse((opts && opts.body) || "{}") });
        return pendingGenerate;
    }
    if (target.includes("/api/modal/restart-worker")) {
        restartCalls.push({ body: JSON.parse((opts && opts.body) || "null") });
        return jsonResponse({ ok: true, sequence: ["sync", "restart"] });
    }
    if (target.includes("/api/modal/config")) {
        return jsonResponse({ api_url: "https://gw.modal.run", api_key_set: true, render_mode_forced: "" });
    }
    if (target.includes("/api/modal/")) return jsonResponse({});
    return jsonResponse({});
};

class FakeEventSource {
    constructor(url) { this.url = url; this.closed = false; }
    addEventListener() {}
    close() { this.closed = true; }
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
assert.strictEqual(typeof host().scrollHint, "function",
    "scrollHint() exposé par le pont (primitive d'UI générique, aussi observable en test)");

/* ══════════════ Accès à la modale ══════════════ */

const overlay = () => document.getElementById("modal-settings-overlay");
const styleEl = () => document.getElementById("modal-settings-styles");
const cs = (el) => getComputedStyle(el);
const step1 = () => overlay().querySelectorAll(".modal-step")[0];
const bodyOf = (frame) => frame.querySelector(".modal-step-body");
const footOf = (frame) => frame.querySelector(".modal-step-foot");
const restartBtns = () => Array.from(document.querySelectorAll("#cfg-run-restart-worker"));

/** Ouvre la modale de réglages et renvoie son overlay. */
async function openSettings(ms) {
    host().openSettings();
    await tick(ms || 150);
    const el = overlay();
    assert.ok(el, "la modale de réglages est ouverte");
    return el;
}

/** Ferme la modale par son bouton réel (il remet aussi le verrou à zéro). */
function closeSettings() {
    const el = overlay();
    if (!el) return;
    const btn = el.querySelector(".modal-settings-close");
    if (btn) btn.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
    if (overlay()) overlay().remove();
    window._modalSettingsOpen = false;
}

/**
 * Simule une géométrie de défilement (jsdom ne fait AUCUNE mise en page).
 * @param {HTMLElement} el
 * @param {{content:number, view:number, top?:number}} geo
 */
function stubGeometry(el, geo) {
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => geo.content });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => geo.view });
    Object.defineProperty(el, "scrollTop", {
        configurable: true,
        get: () => geo.top || 0,
        set: (v) => { geo.top = v; },
    });
    return geo;
}

const isVisible = (hint) => hint.classList.contains("is-visible");

/* ═════════ 1. Le bouton « Redémarrer le worker » est dans le PIED ═════════ */
console.log("1. Bouton « ♻️ Redémarrer le worker » : pied de l'étape Build (plus dans le corps)");

await openSettings();
{
    const frame = step1();
    const foot = footOf(frame);
    const body = bodyOf(frame);
    assert.ok(foot && body, "l'étape 1 a bien un corps ET un pied");

    // (a) présence dans le PIED, à côté de Déployer / Sync user settings.
    const inFoot = Array.from(foot.querySelectorAll("button")).map((b) => b.id);
    assert.ok(inFoot.includes("cfg-run-restart-worker"),
        `le bouton de redémarrage est dans le pied de l'étape 1 — boutons trouvés : ${JSON.stringify(inFoot)}`);
    assert.ok(inFoot.includes("cfg-run-deploy") && inFoot.includes("cfg-sync-user"),
        "il est bien à côté de « Déployer » et « Sync user settings »");

    // (b) MUTANT M1 : plus dans le corps défilant (sous la ligne de flottaison).
    assert.strictEqual(body.querySelector("#cfg-run-restart-worker"), null,
        "MUTANT M1 : le bouton n'est PLUS dans le corps défilant (il était invisible)");
    assert.strictEqual(body.querySelector(".modal-row .val button#cfg-run-restart-worker"), null,
        "MUTANT M1 : l'ancienne ligne « ♻️ Worker Modal [♻️ Redémarrer] » a été retirée du corps");

    // (c) id conservé et UNIQUE dans tout le document (aucun doublon).
    assert.strictEqual(restartBtns().length, 1,
        `MUTANT M1 : l'id « cfg-run-restart-worker » n'existe qu'UNE fois dans le document (trouvé ${restartBtns().length})`);
    assert.strictEqual(restartBtns()[0].closest(".modal-step-foot"), foot,
        "le seul bouton portant cet id est celui du pied");

    // (d) libellé explicite + infobulle qui explique l'ordre sync → restart.
    const label = restartBtns()[0].textContent.trim();
    assert.ok(/Redémarrer le worker/.test(label),
        `le libellé est explicite (« ♻️ Redémarrer le worker ») — trouvé « ${label} »`);
    assert.ok(/Synchronise/.test(restartBtns()[0].title || ""),
        "l'infobulle rappelle que le bouton synchronise PUIS redémarre");

    // (e) style des boutons du pied (mêmes classes) : jamais de débordement.
    const cls = restartBtns()[0].classList;
    assert.ok(cls.contains("modal-btn"), "le bouton porte les classes de bouton de la modale (.modal-btn)");
    assert.ok(cls.contains("modal-btn--wide"),
        "pleine largeur comme ses voisins → il ne peut pas déborder de la colonne (même en fenêtre étroite)");
    assert.strictEqual(cs(foot).flexShrink, "0",
        "le pied n'est pas compressible : les 3 actions restent visibles en permanence");
    assert.strictEqual(cs(body).overflowY, "auto",
        "le corps reste la SEULE zone défilante (le pied ne défile pas)");
    ok("bouton dans le pied (Déployer / Sync user settings / Redémarrer), id unique, libellé explicite");
}

/* ═════════ 2. Désactivation pendant une opération + confirmation ═════════ */
console.log("2. Le bouton du pied se désactive pendant une opération (OP_BUTTON_IDS)");

{
    const btn = restartBtns()[0];
    assert.strictEqual(btn.disabled, false, "au repos, le bouton est actif");

    // Un rendu tourne : la confirmation est indispensable (fail-closed).
    // Aucun rendu ici (RenderQueue vide) → l'opération part directement.
    void host().restartWorker();
    await tick(60);
    assert.strictEqual(restartCalls.length, 1,
        "l'opération est bien déclenchée depuis le bouton du pied");
    assert.strictEqual(btn.disabled, true,
        "MUTANT (id/OP_BUTTON_IDS) : le bouton du pied est DÉSACTIVÉ pendant l'opération");
    assert.strictEqual(btn.textContent.trim(), "⏳ En cours...",
        "son libellé d'origine est remplacé par l'état en cours (originalLabel mémorisé)");
    assert.deepStrictEqual(restartCalls[0].body, { render_in_progress: false, confirm: false },
        "le corps envoyé au serveur porte l'état du rendu et la confirmation");
    ok("désactivation pendant l'opération + corps {render_in_progress, confirm} inchangé");
}

console.log("2b. Confirmation conservée : rendu en cours → le bouton du pied demande d'abord");

{
    // Un rendu cloud est lancé (mode modal)<gpu> : RenderQueue passe en « processing ».
    localStorage.setItem("modal-gateway-mode", "modal:h100");
    const controls = host().buildControls();
    assert.ok(controls, "contrôles ComfyCH construits (sélecteur GPU)");
    document.body.appendChild(controls);
    const gpuSelect = document.getElementById("modal-gpu-selector");
    gpuSelect.value = "modal:h100";
    gpuSelect.dispatchEvent(new domWindow.Event("change"));
    fakeApi.queuePrompt(1, { nodes: [] }, {}).catch(() => { /* rendu jamais conclu (test) */ });
    await tick(120);
    assert.strictEqual(generateCalls.length, 1, "le rendu cloud est bien parti (POST /generate en attente)");
    assert.strictEqual(host().runState().running, true, "un rendu est en cours de suivi");

    const btn = restartBtns()[0];
    let confirmCalls = 0;
    domWindow.AIH.confirm = () => { confirmCalls++; return Promise.resolve(false); };

    // (a) confirmation REFUSÉE → aucun redémarrage (le rendu n'est pas tué).
    restartCalls.length = 0;
    btn.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
    await tick(80);
    assert.strictEqual(confirmCalls, 1,
        "un rendu tourne : le CLIC sur le bouton du pied demande confirmation (handler conservé)");
    assert.strictEqual(restartCalls.length, 0,
        "MUTANT (confirmation) : refus = AUCUN redémarrage envoyé au serveur");

    // (b) confirmation ACCEPTÉE → POST avec les deux drapeaux.
    domWindow.AIH.confirm = () => { confirmCalls++; return Promise.resolve(true); };
    btn.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
    await tick(100);
    assert.strictEqual(restartCalls.length, 1, "accepté : le redémarrage est demandé");
    assert.deepStrictEqual(restartCalls[0].body, { render_in_progress: true, confirm: true },
        "le serveur reçoit l'état du rendu ET la confirmation (il peut refuser sinon)");

    // Nettoyage : le rendu se conclut, le mode revient à « local ».
    generateDeferred.resolve(jsonResponse({ images: [] }));
    await tick(150);
    localStorage.removeItem("modal-gateway-mode");
    gpuSelect.value = "local";
    gpuSelect.dispatchEvent(new domWindow.Event("change"));
    await tick(60);
    ok("bouton du pied : confirmation fail-closed pendant un rendu, drapeaux inchangés");
}

closeSettings();
await tick(20);
assert.strictEqual(overlay(), null, "modale fermée (les indicateurs doivent avoir été détruits)");
assert.strictEqual(document.querySelectorAll(".modal-scroll-hint").length, 0,
    "aucun indicateur résiduel après fermeture");

/* ═════════ 3-5. Indicateur générique de débordement ═════════ */
console.log("3. Indicateur « il y a du contenu plus bas » : visible / masqué selon le défilement");

/** Fabrique un conteneur défilant de test + son indicateur. */
function makeScroller(geo) {
    const box = document.createElement("div");
    box.className = "modal-step-body";
    document.body.appendChild(box);
    stubGeometry(box, geo);
    const ctl = host().scrollHint(box);
    assert.ok(ctl && ctl.el, "scrollHint() retourne un contrôleur");
    return { box, ctl, hint: ctl.el, geo };
}

{
    const { box, ctl, hint, geo } = makeScroller({ content: 400, view: 100, top: 0 });

    // (a) contenu qui déborde → indicateur VISIBLE.
    assert.strictEqual(isVisible(hint), true,
        "MUTANT M3 : contenu plus haut que la zone visible → indicateur AFFICHÉ");
    assert.strictEqual(cs(hint).display, "flex",
        "l'état visible est bien rendu (display: flex via .is-visible)");
    assert.strictEqual(box.lastElementChild, hint.parentNode,
        "l'ancre de l'indicateur est le DERNIER enfant du conteneur (rien n'est déplacé)");

    // (b) défilement jusqu'en bas → MASQUÉ.
    geo.top = 300;
    box.dispatchEvent(new domWindow.Event("scroll"));
    assert.strictEqual(isVisible(hint), false,
        "MUTANT M2 : arrivé en bas, l'indicateur DISPARAÎT (plus rien à signaler)");
    assert.strictEqual(cs(hint).display, "none", "l'état masqué est bien rendu (display: none)");

    // (c) retour en haut → VISIBLE de nouveau.
    geo.top = 0;
    box.dispatchEvent(new domWindow.Event("scroll"));
    assert.strictEqual(isVisible(hint), true,
        "en remontant, l'indicateur RÉAPPARAÎT (du contenu est de nouveau en dessous)");

    // (d) milieu de course : encore du contenu en dessous → visible.
    geo.top = 100;
    box.dispatchEvent(new domWindow.Event("scroll"));
    assert.strictEqual(isVisible(hint), true, "au milieu du défilement, il reste affiché");
    ok("visible (débordement) → masqué (en bas) → visible (remonté) — bascule sur « scroll »");

    // (e) plus de débordement (contenu rétréci / zone agrandie) → jamais affiché.
    geo.top = 0;
    geo.view = geo.content;
    window.dispatchEvent(new domWindow.Event("resize"));
    assert.strictEqual(isVisible(hint), false,
        "MUTANT M2 : sans débordement, l'indicateur n'est JAMAIS affiché");
    box.dispatchEvent(new domWindow.Event("scroll"));
    assert.strictEqual(isVisible(hint), false, "un défilement ne le fait pas apparaître sans débordement");

    ctl.destroy();
    assert.ok(!hint.isConnected, "destroy() retire l'indicateur du DOM");
    box.remove();
    ok("aucun débordement → jamais affiché ; destroy() nettoie le DOM");
}

console.log("4. Mise à jour au redimensionnement ET au changement de CONTENU");

{
    const { box, hint, geo } = makeScroller({ content: 400, view: 400, top: 0 });
    assert.strictEqual(isVisible(hint), false, "au départ, la zone contient tout le contenu");
    assert.strictEqual(box.__aihScrollHint !== undefined, true,
        "le contrôleur est mémorisé sur le conteneur (idempotence de scrollHint)");
    assert.strictEqual(host().scrollHint(box).el, hint,
        "rappeler scrollHint() sur le même conteneur rend le MÊME indicateur (pas de doublon)");
    assert.strictEqual(box.querySelectorAll(".modal-scroll-hint").length, 1,
        "jamais deux indicateurs dans le même conteneur");

    // (a) changement de TAILLE de la zone (fenêtre redimensionnée / zoom).
    geo.view = 100;
    window.dispatchEvent(new domWindow.Event("resize"));
    assert.strictEqual(isVisible(hint), true,
        "un redimensionnement de la fenêtre recalcule l'indicateur (plus de contenu caché)");

    // (b) retour à une zone qui contient tout, puis AJOUT DE CONTENU.
    geo.view = 400;
    window.dispatchEvent(new domWindow.Event("resize"));
    assert.strictEqual(isVisible(hint), false, "zone assez haute → indicateur masqué");
    geo.content = 900; // le contenu vient d'être ajouté (statut, log, liste re-rendue)
    box.appendChild(document.createElement("p"));
    await tick(30);
    assert.strictEqual(isVisible(hint), true,
        "MUTANT M5 : après AJOUT DE CONTENU, l'indicateur se met à jour (MutationObserver) — sans scroll ni resize");

    // (c) le contenu est remplacé (re-render complet) : toujours à jour.
    geo.content = 400;
    box.innerHTML = "<p>re-render</p>";
    await tick(30);
    assert.strictEqual(isVisible(hint), false,
        "un re-render du contenu (innerHTML) est aussi pris en compte (recalcul)");
    ok("recalcul sur resize et sur changement de contenu (ajout ET remplacement)");

    box.__aihScrollHint.destroy();
    box.remove();
}

console.log("5. L'indicateur ne capte JAMAIS un clic (pointer-events: none)");

{
    const { box, hint } = makeScroller({ content: 400, view: 100, top: 0 });
    assert.strictEqual(cs(hint).pointerEvents, "none",
        "MUTANT M4 : pointer-events: none sur l'indicateur — il n'intercepte aucun clic");
    assert.strictEqual(cs(hint.parentNode).pointerEvents, "none",
        "l'ancre qui le porte est elle aussi transparente aux événements");

    // Contre-épreuve : un clic traversant l'indicateur atteint bien le conteneur.
    let clicks = 0;
    box.addEventListener("click", () => { clicks++; });
    hint.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(clicks, 1, "un clic sur l'indicateur remonte au conteneur (rien n'est bloqué)");

    box.__aihScrollHint.destroy();
    box.remove();
    ok("pointer-events: none vérifié (styles calculés + contre-épreuve de clic)");
}

console.log("6. Forme : chevron de la façade, dégradé, reduced-motion, tokens du pack");

{
    const { box, hint } = makeScroller({ content: 400, view: 100, top: 0 });

    // (a) chevron de la FAÇADE js/aih_icons.js (jamais d'emoji).
    const svg = hint.querySelector("svg");
    assert.ok(svg, "l'indicateur porte une icône SVG (façade aih_icons)");
    assert.strictEqual(svg.getAttribute("aria-hidden"), "true",
        "l'icône est décorative (aria-hidden) : le sens n'est pas porté par l'image");
    assert.strictEqual(svg.getAttribute("focusable"), "false", "elle ne prend pas le focus clavier");
    assert.strictEqual(hint.getAttribute("data-aih-icon"), "chevron-down",
        "c'est bien le chevron « vers le bas » de la façade");
    assert.ok((svg.getAttribute("viewBox") || "").includes("24 24"),
        "le SVG vient de la brique d'icônes (viewBox 24×24)");
    assert.strictEqual(svg.getAttribute("stroke"), "currentColor",
        "la couleur du tracé suit currentColor (aucune couleur en dur dans l'icône)");
    assert.strictEqual(svg.getAttribute("fill"), "none", "le chevron est un tracé, pas un aplat");
    assert.strictEqual(/[\u2190-\u2BFF\uD800-\uDFFF]/.test(hint.textContent),
        false, "aucun emoji ni glyphe texte dans l'indicateur (icône uniquement)");
    assert.strictEqual(hint.getAttribute("aria-hidden"), "true",
        "l'indicateur entier est décoratif — il n'annonce rien au lecteur d'écran");

    // (b) CSS du pack : dégradé + état + reduced-motion + aucune couleur en dur.
    box.__aihScrollHint.destroy();
    box.remove();

    const cssText = styleEl().textContent;
    const ruleOf = (selector) => {
        const i = cssText.indexOf(selector + " {");
        assert.ok(i > 0, `règle ${selector} présente dans la feuille du module`);
        return cssText.slice(i, cssText.indexOf("}", i) + 1);
    };
    const hintRule = ruleOf(".modal-scroll-hint");
    assert.ok(/background: linear-gradient\(to bottom,/.test(hintRule),
        "le bas du conteneur porte un dégradé subtil (linear-gradient vers le bas)");
    assert.strictEqual(/display: none;/.test(hintRule), true,
        "MUTANT M2 : masqué par DÉFAUT — seule la classe d'état .is-visible l'affiche");
    assert.ok(/pointer-events: none;/.test(hintRule),
        "MUTANT M4 : pointer-events: none déclaré dans la règle de l'indicateur");
    assert.ok(cssText.includes(".modal-scroll-hint.is-visible { display: flex; }"),
        "un état explicite (.is-visible) porte l'affichage, pas une astuce de fond CSS");

    // Aucune couleur EN DUR : chaque couleur passe par un token var(--…).
    const stripped = hintRule.replace(/var\([^)]*\)/g, "TOKEN");
    assert.strictEqual(/#[0-9a-fA-F]{3,8}/.test(stripped), false,
        `MUTANT (tokens) : aucune couleur hexadécimale en dur dans la règle — ${JSON.stringify(stripped)}`);
    assert.strictEqual(/rgba?\(/.test(stripped), false,
        "MUTANT (tokens) : aucune couleur rgba() en dehors d'un repli var(--…)");
    assert.ok(/color: var\(--/.test(hintRule), "la couleur du chevron vient d'un token du pack");

    const anchorRule = ruleOf(".modal-scroll-hint-anchor");
    assert.ok(/position: sticky; bottom: 0;/.test(anchorRule),
        "l'ancre est collante en bas : le dégradé ne défile pas avec le contenu");
    assert.ok(/height: 0;/.test(anchorRule),
        "l'ancre n'ajoute AUCUNE hauteur au contenu défilable (rien n'est décalé)");

    // (c) prefers-reduced-motion : animation seulement si elle est acceptée.
    const iNoPref = cssText.indexOf("@media (prefers-reduced-motion: no-preference)");
    const iReduce = cssText.indexOf("@media (prefers-reduced-motion: reduce)");
    assert.ok(iNoPref > 0, "l'animation est conditionnée à prefers-reduced-motion: no-preference");
    assert.ok(iReduce > iNoPref, "un bloc prefers-reduced-motion: reduce la désactive");
    const reduceBlock = cssText.slice(iReduce, cssText.indexOf("}", cssText.indexOf("{", iReduce)) + 1);
    assert.ok(/animation: none;/.test(reduceBlock),
        "désactivé (aucune animation) si l'utilisateur refuse les animations");
    ok("chevron de la façade, dégradé, état explicite, tokens uniquement, reduced-motion respecté");
}

/* ═════════ 7. Câblage réel dans la modale ═════════ */
console.log("7. Câblage : les 3 corps d'étape + le panneau portent l'indicateur");

await openSettings();
{
    const bodies = Array.from(overlay().querySelectorAll(".modal-step-body"));
    assert.strictEqual(bodies.length, 3, "3 corps d'étape (Build / Nodes / Modèles)");
    for (const [i, body] of bodies.entries()) {
        const ctl = body.__aihScrollHint;
        assert.ok(ctl && ctl.el, `corps ${i + 1} : indicateur branché`);
        assert.strictEqual(body.querySelectorAll(".modal-scroll-hint").length, 1,
            `corps ${i + 1} : un seul indicateur`);
        assert.strictEqual(body.lastElementChild, ctl.el.parentNode,
            `corps ${i + 1} : l'ancre est le dernier enfant (aucun contenu déplacé)`);
        assert.strictEqual(cs(ctl.el.parentNode).height, "0px",
            `corps ${i + 1} : l'ancre est de hauteur nulle (le défilement n'est pas faussé)`);
        // jsdom ne met pas en page : clientHeight vaut 0 → rien à signaler.
        assert.strictEqual(isVisible(ctl.el), false,
            `corps ${i + 1} : pas d'indicateur quand la zone n'est pas encore mesurée`);
    }

    // Le panneau lui-même (dernier recours quand la hauteur choisie ne suffit plus).
    const panel = overlay().querySelector(".modal-settings-panel");
    assert.ok(panel.__aihScrollHint, "le panneau défilant porte aussi l'indicateur");
    assert.ok(Array.from(panel.children).some((c) => c.classList.contains("modal-scroll-hint-anchor")),
        "l'ancre du panneau est un enfant DIRECT du panneau (aucun wrapper, la mise en page ne bouge pas)");
    assert.strictEqual(panel.querySelector(".modal-step").__aihScrollHint, undefined,
        "les cadres d'étape eux-mêmes ne portent pas d'indicateur (seuls les corps défilent)");

    // Bascule réelle sur un corps d'étape (géométrie simulée).
    const body = bodies[0];
    const geo = stubGeometry(body, { content: 600, view: 240, top: 0 });
    body.__aihScrollHint.update();
    assert.strictEqual(isVisible(body.__aihScrollHint.el), true,
        "corps 1 : contenu plus long que la zone → indicateur affiché");
    geo.top = 360;
    body.dispatchEvent(new domWindow.Event("scroll"));
    assert.strictEqual(isVisible(body.__aihScrollHint.el), false,
        "corps 1 : en bas de la zone → indicateur masqué");

    // L'indicateur ne capte pas le clic qui doit atteindre le corps.
    let clicks = 0;
    body.addEventListener("click", () => { clicks++; });
    body.__aihScrollHint.el.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(clicks, 1, "corps 1 : un clic traversant l'indicateur atteint le corps");
    ok("indicateurs branchés sur les 3 corps + le panneau, bascule réelle vérifiée");
}

closeSettings();
await tick(20);
{
    assert.strictEqual(document.querySelectorAll(".modal-scroll-hint").length, 0,
        "fermer la modale retire TOUS les indicateurs");
    assert.strictEqual(document.querySelectorAll(".modal-scroll-hint-anchor").length, 0,
        "…et leurs ancres (aucun élément orphelin)");
    // Aucun écouteur orphelin : un resize après fermeture ne doit rien casser.
    window.dispatchEvent(new domWindow.Event("resize"));
    await tick(10);
    ok("fermeture : indicateurs, ancres et écouteurs retirés");
}

/* ═════════ 8. Contrôles négatifs par mutation ═════════ */
console.log("8. Mutants : bouton dans le corps, indicateur toujours/jamais affiché, clics, non mis à jour");

{
    const SRC = readFileSync(MODULE_PATH, "utf8");

    for (const f of readdirSync(COMFYCH_DIR)) {
        if (/^\.__mut_hint_\d+\.js$/.test(f)) rmSync(join(COMFYCH_DIR, f), { force: true });
    }

    let seq = 0;
    /**
     * Importe un MUTANT du module. Le fichier est écrit DANS js/comfych/ pour
     * que les imports relatifs (`../aih_icons.js`) résolvent comme en production.
     * La feuille de styles est retirée avant, sinon injectModalStyles() garderait
     * celle du module sain (garde sur #modal-settings-styles).
     */
    async function loadMutant(label, mutate) {
        const mutated = mutate(SRC);
        assert.notStrictEqual(mutated, SRC, `mutation « ${label} » sans effet (ancre introuvable)`);
        const file = join(COMFYCH_DIR, `.__mut_hint_${++seq}.js`);
        writeFileSync(file, mutated, "utf8");
        closeSettings();
        styleEl()?.remove();
        delete domWindow.AIHComfyCHHost;
        await import("file://" + file + "?m=" + seq);
        await tick(950); // interception de queuePrompt (800 ms) + config
        const mutantHost = domWindow.AIHComfyCHHost;
        assert.ok(mutantHost, `mutation « ${label} » : pont du module absent`);
        mutantHost.openSettings();
        await tick(150);
        assert.ok(overlay(), `mutation « ${label} » : modale de réglages ouverte`);
        return { bridge: mutantHost, file };
    }

    function cleanupMutant(handle) {
        closeSettings();
        styleEl()?.remove();
        delete domWindow.AIHComfyCHHost;
        rmSync(handle.file, { force: true });
    }

    // M1 — le bouton de redémarrage RESTE dans le corps défilant (ancien emplacement).
    {
        const handle = await loadMutant(
            "bouton laissé dans le corps défilant",
            (s) => {
                // 1. le bouton du pied perd l'id (il n'est plus « celui du pied »).
                let out = s.replace(
                    'id="cfg-run-restart-worker" class="modal-btn modal-btn--wide modal-btn--sm"',
                    'id="cfg-run-restart-worker-foot" class="modal-btn modal-btn--wide modal-btn--sm"'
                );
                // 2. l'ancienne ligne du corps est réintroduite avec le vrai id.
                const anchor = `'        <div class="modal-row"><span>🖥️ Logs du worker (ComfyUI)</span>`;
                assert.ok(out.includes(anchor), "ancre du corps (logs worker) introuvable");
                out = out.replace(anchor,
                    `'        <div class="modal-row"><span>♻️ Worker Modal</span><span class="val">` +
                    `<button id="cfg-run-restart-worker" class="modal-btn modal-btn--sm">♻️ Redémarrer le worker</button>` +
                    `</span></div>',\n            ` + anchor);
                return out;
            }
        );
        try {
            const frame = step1();
            assert.strictEqual(footOf(frame).querySelector("#cfg-run-restart-worker"), null,
                "MUTANT M1 : plus aucun bouton de redémarrage dans le pied → l'assertion (1a) serait ROUGE");
            assert.ok(bodyOf(frame).querySelector("#cfg-run-restart-worker"),
                "MUTANT M1 : le bouton est revenu dans le corps défilant (sous la ligne de flottaison)");
        } finally {
            cleanupMutant(handle);
        }
        ok("M1 bouton dans le corps → l'assertion « dans le pied » devient ROUGE");
    }

    // M2 — l'indicateur est TOUJOURS affiché (état de fin ignoré).
    {
        const handle = await loadMutant(
            "indicateur toujours affiché",
            (s) => s.replace("var visible = overflowing && !atEnd;", "var visible = true;")
        );
        try {
            const box = document.createElement("div");
            box.className = "modal-step-body";
            document.body.appendChild(box);
            const geo = stubGeometry(box, { content: 400, view: 100, top: 300 }); // déjà en bas
            const hint = handle.bridge.scrollHint(box).el;
            assert.strictEqual(isVisible(hint), true,
                "MUTANT M2 : affiché alors qu'on est DÉJÀ en bas → l'assertion (3b) serait ROUGE");
            geo.content = 100; // aucun débordement
            box.dispatchEvent(new domWindow.Event("scroll"));
            assert.strictEqual(isVisible(hint), true,
                "MUTANT M2 : affiché sans aucun débordement → l'assertion (3e) serait ROUGE");
            box.__aihScrollHint.destroy();
            box.remove();
        } finally {
            cleanupMutant(handle);
        }
        ok("M2 toujours affiché → les assertions « masqué en bas / sans débordement » deviennent ROUGES");
    }

    // M3 — l'indicateur n'est JAMAIS affiché.
    {
        const handle = await loadMutant(
            "indicateur jamais affiché",
            (s) => s.replace("var visible = overflowing && !atEnd;", "var visible = false;")
        );
        try {
            const box = document.createElement("div");
            box.className = "modal-step-body";
            document.body.appendChild(box);
            stubGeometry(box, { content: 400, view: 100, top: 0 });
            const hint = handle.bridge.scrollHint(box).el;
            assert.strictEqual(isVisible(hint), false,
                "MUTANT M3 : jamais affiché malgré un contenu qui déborde → l'assertion (3a) serait ROUGE");
            box.dispatchEvent(new domWindow.Event("scroll"));
            assert.strictEqual(isVisible(hint), false,
                "MUTANT M3 : toujours masqué, même en haut de la zone");
            box.__aihScrollHint.destroy();
            box.remove();
        } finally {
            cleanupMutant(handle);
        }
        ok("M3 jamais affiché → l'assertion « contenu qui déborde = visible » devient ROUGE");
    }

    // M4 — l'indicateur capte les clics (pointer-events retiré).
    {
        const handle = await loadMutant(
            "indicateur qui capte les clics",
            (s) => {
                // Les DEUX déclarations : l'indicateur ET l'ancre qui le porte
                // (pointer-events s'hérite — sinon le mutant resterait inerte).
                let out = s.replace(
                    "'  pointer-events: none; user-select: none; cursor: default;',",
                    "'  user-select: none; cursor: default;',"
                );
                out = out.replace(
                    "'  flex: 0 0 auto; height: 0;',\n            '  pointer-events: none;',",
                    "'  flex: 0 0 auto; height: 0;',"
                );
                return out;
            }
        );
        try {
            const box = document.createElement("div");
            box.className = "modal-step-body";
            document.body.appendChild(box);
            stubGeometry(box, { content: 400, view: 100, top: 0 });
            const hint = handle.bridge.scrollHint(box).el;
            assert.notStrictEqual(cs(hint).pointerEvents, "none",
                `MUTANT M4 : l'indicateur capte de nouveau les clics (pointer-events = « ${cs(hint).pointerEvents} ») → l'assertion (5) serait ROUGE`);
            box.__aihScrollHint.destroy();
            box.remove();
        } finally {
            cleanupMutant(handle);
        }
        ok("M4 pointer-events retiré → l'assertion « ne capte aucun clic » devient ROUGE");
    }

    // M5 — aucune mise à jour quand le CONTENU change (observateur retiré).
    {
        const handle = await loadMutant(
            "pas de mise à jour au changement de contenu",
            (s) => s.replace("mo.observe(scroller, { childList: true, subtree: true, characterData: true });",
                "void 0; /* observateur retiré */")
        );
        try {
            const box = document.createElement("div");
            box.className = "modal-step-body";
            document.body.appendChild(box);
            const geo = stubGeometry(box, { content: 100, view: 400, top: 0 });
            const hint = handle.bridge.scrollHint(box).el;
            assert.strictEqual(isVisible(hint), false, "au départ : rien à signaler");
            geo.content = 900; // du contenu est ajouté…
            box.appendChild(document.createElement("p"));
            await tick(40);
            assert.strictEqual(isVisible(hint), false,
                "MUTANT M5 : le contenu ajouté n'est PAS pris en compte (indicateur absent) → l'assertion (4b) serait ROUGE");
            box.__aihScrollHint.destroy();
            box.remove();
        } finally {
            cleanupMutant(handle);
        }
        ok("M5 sans observateur de contenu → l'assertion « se met à jour après ajout » devient ROUGE");
    }

    assert.strictEqual(readFileSync(MODULE_PATH, "utf8"), SRC,
        "source intacte après les mutations (aucune modification laissée sur disque)");
    assert.strictEqual(
        readdirSync(COMFYCH_DIR).filter((f) => /^\.__mut_hint_\d+\.js$/.test(f)).length,
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
    assert.strictEqual(typeof domWindow.AIHComfyCHHost.scrollHint, "function",
        "le pont expose de nouveau scrollHint()");
}

console.log(`\n✅ ComfyCH — pied de l'étape Build + indicateur de débordement : TOUS LES TESTS PASSENT (${n} groupes)`);
process.exit(0);
