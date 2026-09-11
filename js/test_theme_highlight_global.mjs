// ─────────────────────────────────────────────────────────────────────────
// VAGUE 14 — Repro jsdom : « la couleur (accent → highlight) choisie dans la
// modale des réglages doit thématiser TOUTE l'UI, pas seulement la modale ».
//
// Usage : JSDOM_DIR=/chemin/vers/dossier/avec/jsdom node test_theme_highlight_global.mjs
//         (jsdom est un banc de test : cherché dans JSDOM_DIR, ./node_modules,
//          puis /tmp/repro-v14 — jamais requis au runtime du pack.)
//
// Ce que le test verrouille (avec le CSS RÉEL js/css/holaf_themes.css + le
// module RÉEL holaf_themes.js) :
//   1. Le réglage pose la var sur <body> (--aih-accent) et l'alias global
//      --holaf-accent-color (lu par menu/boutons/panneaux) résout vers l'accent
//      choisi — y compris si une classe legacy `.holaf-theme-*` traîne sur
//      <body> (purge applyThemeState).
//   2. Un consommateur HORS modale (élément menu descendant de body) lit la
//      couleur choisie ; le highlight (--aih-highlight, color-mix sur
//      --aih-accent-active) la suit aussi.
//   3. La lecture du bridge toast (getComputedStyle(body).getPropertyValue)
//      renvoie l'accent choisi.
//   4. Un changement de mode dark/light ne perd ni le highlight ni
//      l'intensité posée en inline (var --aih-highlight-intensity).
//   5. La persistance (saveThemeState/loadThemeState) rejoue l'état au
//      chargement (applyPersistedTheme) — re-application au reload.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = fileURLToPath(new URL(".", import.meta.url));

async function loadJsdom() {
    const dirs = [
        process.env.JSDOM_DIR,
        HERE.replace(/\/$/, ""),
        "/tmp/repro-v14",
    ].filter(Boolean);
    for (const dir of dirs) {
        try {
            const resolved = require.resolve("jsdom", { paths: [dir] });
            const mod = await import(resolved);
            return mod.JSDOM || mod.default?.JSDOM;
        } catch { /* candidat suivant */ }
    }
    return null;
}

const JSDOM = await loadJsdom();
if (!JSDOM) {
    console.info("⚠️  jsdom indisponible (JSDOM_DIR=… ou npm i jsdom) → test ignoré");
    process.exit(0);
}

const PACK = fileURLToPath(new URL("..", import.meta.url));
const css = readFileSync(`${PACK}/js/css/holaf_themes.css`, "utf8");

const dom = new JSDOM(`<!doctype html><html><head><style>${css}</style></head>
<body>
  <div id="holaf-utilities-menu-button"></div>
  <ul id="holaf-utilities-dropdown-menu"><li id="menu-item"></li></ul>
</body></html>`, { pretendToBeVisual: true, url: "http://localhost/" });

const { window } = dom;
const { document } = window;
globalThis.document = document;
globalThis.window = window;
globalThis.localStorage = window.localStorage;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);

const themes = await import("./holaf_themes.js");
const cs = (el) => window.getComputedStyle(el);

// Substitue les var() d'un token à l'usage, comme le navigateur sur l'élément
// (jsdom cascade les custom properties mais ne résout pas var() à l'usage).
function resolveVar(el, name, seen = new Set()) {
    if (seen.has(name)) return `<cycle:${name}>`;
    seen.add(name);
    let v = cs(el).getPropertyValue(name).trim();
    let guard = 0;
    while (v.includes("var(") && guard++ < 10) {
        v = v.replace(/var\((--[\w-]+)(?:\s*,\s*([^()]*))?\)/g, (m, vn, fb) => {
            const val = cs(el).getPropertyValue(vn).trim();
            if (val) return val.includes("var(") ? resolveVar(el, vn, new Set(seen)) : val;
            return fb !== undefined ? fb : m;
        });
    }
    return v;
}

const BLUE = "#4682B4";

// ── 1. Chargement : une classe legacy résiduelle peut traîner sur <body>
// (état réel : anciens builds posaient .holaf-theme-graphite-orange sur body),
// puis applyPersistedTheme(document.body) rejoue l'état persisté.
document.body.classList.add("holaf-theme-graphite-orange");
themes.saveThemeState({ mode: "dark", accent: "blue", halo: true, haloIntensity: 50, highlight: true, highlightIntensity: 100 });
const restored = themes.applyPersistedTheme(document.body);
assert.strictEqual(restored.accent, "blue", "applyPersistedTheme rejoue l'accent persisté");
assert.strictEqual(restored.mode, "dark", "applyPersistedTheme rejoue le mode persisté");

// ── 2. La var est visible sur body (getComputedStyle) ──
assert.strictEqual(cs(document.body).getPropertyValue("--aih-accent").trim(), BLUE,
    "var posée sur body : --aih-accent = accent choisi");
assert.strictEqual(document.body.className.includes("holaf-theme-"), false,
    "purge legacy : plus de classe .holaf-theme-* sur <body> (elle figeait --holaf-*)");
// La chaîne du highlight est définie (token) et substituable.
const highlightToken = cs(document.body).getPropertyValue("--aih-highlight");
assert.ok(/--aih-accent-active/.test(highlightToken), "--aih-highlight dérive de --aih-accent-active");

// ── 3. Un consommateur HORS modale la lit (menu, bouton) ──
const menuItem = document.getElementById("menu-item");
const menuBtn = document.getElementById("holaf-utilities-menu-button");
assert.strictEqual(resolveVar(menuItem, "--holaf-accent-color").toLowerCase(), BLUE.toLowerCase(),
    "menu (hors modale) lit --holaf-accent-color = accent choisi");
assert.strictEqual(resolveVar(menuBtn, "--holaf-button-background").toLowerCase(), BLUE.toLowerCase(),
    "bouton principal (hors modale) suit l'accent via --holaf-button-background");
assert.strictEqual(resolveVar(document.body, "--aih-highlight").replace(/\s+/g, "").toLowerCase(),
    `color-mix(insrgb,${BLUE.toLowerCase()}calc(100*1%),transparent)`,
    "highlight (contour coloré) résout vers l'accent choisi");

// ── 4. Lecture du bridge toast (cssVar au computed style du body) ──
assert.strictEqual(cs(document.body).getPropertyValue("--aih-accent").trim(), BLUE,
    "aih_toast_bridge.cssVar('--aih-accent') = accent choisi");

// ── 5. La modale porte la classe accent DIRECTEMENT (applyThemeState sur
// panelEl) — elle doit aussi résoudre vers l'accent (parité body/panel).
const modal = document.createElement("div");
themes.applyThemeState(modal, restored);
document.body.appendChild(modal);
assert.strictEqual(resolveVar(modal, "--holaf-accent-color").toLowerCase(), BLUE.toLowerCase(),
    "modale des réglages suit l'accent (comportement attendu, inchangé)");

// ── 5bis. Les thèmes legacy PAR-PANEL ne sont pas purgés : une fenêtre peut
// conserver son propre thème (ex. nodes manager « Midnight Purple »).
const themedPanel = document.createElement("div");
themedPanel.className = "holaf-theme-midnight-purple";
document.body.appendChild(themedPanel);
themes.applyThemeState(themedPanel, restored);
assert.ok(themedPanel.classList.contains("holaf-theme-midnight-purple"),
    "thème legacy par-panel conservé (la purge ne concerne que <body>)");
assert.strictEqual(window.getComputedStyle(themedPanel).getPropertyValue("--holaf-accent-color").trim(), "#8A2BE2",
    "le panel garde sa palette legacy par-panel (--holaf-accent-color en dur)");

// ── 6. Intensité du highlight posée puis changement de mode : PAS de perte ──
themes.applyThemeState(document.body, { mode: "dark", accent: "blue", halo: true, haloIntensity: 50, highlight: true, highlightIntensity: 80 });
assert.strictEqual(document.body.style.getPropertyValue("--aih-highlight-intensity"), "80",
    "intensité du highlight posée en inline sur body");
themes.applyThemeState(document.body, { mode: "light", accent: "blue", halo: true, haloIntensity: 50, highlight: true, highlightIntensity: 80 });
assert.strictEqual(document.body.style.getPropertyValue("--aih-highlight-intensity"), "80",
    "changement de mode light : l'intensité inline du highlight est ré-appliquée (pas perdue)");
assert.ok(document.body.classList.contains("aih-mode-light") && document.body.classList.contains("aih-accent-blue"),
    "mode light + accent conservés après la bascule");
// L'alias global suit toujours en mode light (variante light de l'accent :
// settings.accentDesc = "une variante par mode", pas une couleur figée legacy).
assert.strictEqual(resolveVar(menuItem, "--holaf-accent-color").toLowerCase(), "#2f6b96",
    "menu suit l'accent en mode light (variante light du bleu, pas la palette legacy)");

// ── 7. Toggle highlight OFF puis ON ──
themes.applyThemeState(document.body, { mode: "dark", accent: "blue", halo: true, haloIntensity: 50, highlight: false, highlightIntensity: 80 });
assert.strictEqual(cs(document.body).getPropertyValue("--aih-highlight").trim(), "transparent",
    ".aih-highlight-off neutralise le contour");
themes.applyThemeState(document.body, { mode: "dark", accent: "blue", halo: true, haloIntensity: 50, highlight: true, highlightIntensity: 80 });
assert.ok(resolveVar(document.body, "--aih-highlight").toLowerCase().includes(BLUE.toLowerCase()),
    "réactivation : le highlight revient avec la couleur d'accent");

// ── 8. Persistance rejouée au « rechargement » (nouveau DOM) ──
const dom2 = new JSDOM(`<!doctype html><html><head><style>${css}</style></head><body></body></html>`, {
    pretendToBeVisual: true, url: "http://localhost/",
});
const saved = themes.loadThemeState();
assert.strictEqual(saved.accent, "blue", "loadThemeState rejoue l'accent persisté (localStorage)");
themes.applyPersistedTheme(dom2.window.document.body);
assert.strictEqual(dom2.window.getComputedStyle(dom2.window.document.body).getPropertyValue("--aih-accent").trim(), BLUE,
    "au rechargement, l'accent choisi est ré-appliqué sur body (persistant, global)");

console.log("✅ VAGUE 14 — couleur accent→highlight globale : TOUS LES TESTS PASSENT");