// ─────────────────────────────────────────────────────────────────────────
// Compatibilité Nodes 2.0 (rendu Vue) — Remote / ToText, PREUVE DOUBLE MODE.
//
// Contexte : l'utilisateur n'a PAS basculé en Nodes 2.0 (le rendu classique est
// son mode de production). Il a seulement constaté, lors d'un essai, que « les
// remote ne marchent plus correctement ». Faits vérifiés dans la source ComfyUI
// de référence (1.47.11) :
//   - en vueNodesMode, LGraphCanvas.drawNode retourne tôt → node.onDrawForeground
//     n'est JAMAIS appelé ;
//   - processMouseMove met `node = null` → node.onMouseEnter/… n'est JAMAIS appelé ;
//   - EN REVANCHE canvas.onDrawForeground (niveau canvas) survit dans les deux modes.
//
// Ce test charge les VRAIS modules du pack (résolution `../../scripts/app.js`
// redirigée vers des stubs, cf. test_helpers/nodes2_resolve.mjs) et exige :
//
//   CLASSIC (vueNodesMode=false, mode de PRODUCTION) — doit être STRICTEMENT
//   non régressé / identique :
//     1. le combo `comfy_group` se rafraîchit toujours via node.onMouseEnter ;
//     2. le hook canvas-level est un NO-OP TOTAL (il ne rafraîchit RIEN) ;
//     3. ToText attache son <div> riche via node.onDrawForeground ;
//     4. SimpleBypasser : le widget `active` est masqué (widget.hidden=true).
//
//   VUE (vueNodesMode=true) — doit fonctionner APRÈS correctif :
//     5. SimpleBypasser : `active` masqué par les DEUX canaux (hidden + options.hidden) ;
//     6. contrôle négatif : SANS le hook canvas-level (onDrawForeground node-level
//        simulé non appelé, comme le fait Vue), ToText n'attache RIEN ;
//     7. AVEC le hook canvas-level, ToText attache son <div> et le combo
//        `comfy_group` se rafraîchit (groupes créés après le node).
//
// Usage : node js/test_nodes2_compat.mjs
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom absent), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { register } from "node:module";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_nodes2_compat");

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
globalThis.Event = window.Event;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame?.bind(window) || ((cb) => setTimeout(cb, 0));
globalThis.cancelAnimationFrame = window.cancelAnimationFrame?.bind(window) || clearTimeout;

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

// ── Faux app ComfyUI (canvas + graph) fourni aux stubs AVANT tout import ────
const registered = [];
const fakeCanvas = { onDrawForeground: undefined };
const fakeApp = {
    registerExtension(ext) { registered.push(ext); },
    canvas: fakeCanvas,
    graph: {
        _groups: [{ title: "Alpha" }, { title: "Beta" }],
        _nodes: [],
        change() {},
    },
};
globalThis.__aihNodes2TestApp = fakeApp;
globalThis.__aihNodes2TestApi = { addEventListener() {}, apiURL: (p) => p };
// ComfyWidgets.STRING (comme le vrai : un DOM widget avec un <textarea>).
globalThis.__aihNodes2TestComfyWidgets = {
    STRING(node, name) {
        const holder = document.createElement("div");
        const inputEl = document.createElement("textarea");
        holder.appendChild(inputEl);
        document.body.appendChild(holder);
        const w = { name, type: "customtext", value: "", inputEl, element: inputEl, options: {} };
        node.widgets.push(w);
        return w;
    },
};
// Le flag global lu par isVueNodesMode().
window.LiteGraph = { vueNodesMode: false, NODE_WIDGET_HEIGHT: 20 };

// Redirige ../../scripts/{app,api,widgets}.js vers les stubs, puis charge les
// VRAIS modules du pack comme ComfyUI.
register(new URL("./test_helpers/nodes2_resolve.mjs", import.meta.url), import.meta.url);
const compat = await import("./holaf_nodes2_compat.js");
await import("./holaf_remote_control.js");
await import("./holaf_to_text.js");

const remoteExt = registered.find((e) => e.name === "AIH.RemoteControl");
const toTextExt = registered.find((e) => e.name === "AIH.ToText");
assert.ok(remoteExt, "extension AIH.RemoteControl enregistrée");
assert.ok(toTextExt, "extension AIH.ToText enregistrée");

// ── Fabrique de faux nodes (API LiteGraph minimale utilisée par le pack) ────
function makeWidgets(seed) {
    return (seed || []).map((w) => ({ ...w, options: w.options ? { ...w.options } : {} }));
}
function makeNode(type, widgetSeeds) {
    return {
        type,
        widgets: makeWidgets(widgetSeeds),
        inputs: [], outputs: [], size: [320, 240], properties: {},
        removed: false,
        setDirtyCanvas() {},
        onMouseEnter: undefined,
    };
}
async function build(ext, nodeDataName, node) {
    function FakeNode() {}
    FakeNode.prototype = { widgets: [], inputs: [], size: [320, 240], properties: {} };
    // ComfyUI appelle TOUJOURS beforeRegisterNodeDef(nodeType, nodeData, app) ;
    // le 3ᵉ argument `app` shadow le module import et est capturé par les closures.
    await ext.beforeRegisterNodeDef(FakeNode, { name: nodeDataName }, fakeApp);
    const inst = Object.assign(new FakeNode(), node);
    if (typeof inst.onNodeCreated === "function") inst.onNodeCreated();
    return inst;
}
const groupCombo = (node) => node.widgets.find((w) => w.name === "comfy_group");
const activeWidget = (node) => node.widgets.find((w) => w.name === "active");

const GROUP_WIDGETS = [
    { name: "group_name", value: "G" },
    { name: "active", value: true },
    { name: "comfy_group", value: "None", options: { values: [] } },
    { name: "bypass_mode", value: "Bypass" },
];
const SIMPLE_WIDGETS = [
    { name: "group_name", value: "G" },
    { name: "invert", value: false },
    { name: "active", value: false },
];

/* ════════════════════════ 1. MODE CLASSIQUE (production) ═══════════════════ */
console.log("1. Mode CLASSIQUE (vueNodesMode=false) — non-régressé");
window.LiteGraph.vueNodesMode = false;
assert.strictEqual(compat.isVueNodesMode(), false, "isVueNodesMode()=false en classique");

const gbClassic = await build(remoteExt, "AIHGroupBypasser", makeNode("AIHGroupBypasser", GROUP_WIDGETS));
assert.deepStrictEqual(groupCombo(gbClassic).options.values, ["None", "Alpha", "Beta"],
    "combo comfy_group initialisé à la création (classique)");
// Un groupe est créé APRÈS le node : le rafraîchissement node-level (survol) le capte.
fakeApp.graph._groups.push({ title: "Gamma" });
gbClassic.onMouseEnter();
assert.deepStrictEqual(groupCombo(gbClassic).options.values, ["None", "Alpha", "Beta", "Gamma"],
    "node.onMouseEnter rafraîchit les groupes (chemin classique INCHANGÉ)");
ok("classique : le combo comfy_group se rafraîchit via node.onMouseEnter");

// Le hook canvas-level doit être STRICTEMENT inactif en classique.
fakeApp.graph._groups.pop(); // retire « Gamma »
assert.ok(groupCombo(gbClassic).options.values.includes("Gamma"),
    "pré-condition : la liste est encore périmée (Gamma présent)");
assert.strictEqual(typeof fakeCanvas.onDrawForeground, "function",
    "le hook canvas-level a bien été installé (une seule fois)");
fakeCanvas.onDrawForeground();
assert.deepStrictEqual(groupCombo(gbClassic).options.values, ["None", "Alpha", "Beta", "Gamma"],
    "en CLASSIQUE le hook canvas-level est un NO-OP TOTAL (liste NON rafraîchie)");
ok("classique : le hook canvas-level est un no-op strict (comportement identique à avant)");

// ToText classique : attachement via node.onDrawForeground.
const ttClassic = await build(toTextExt, "AIHToText", makeNode("AIHToText", []));
const ttWidgetClassic = ttClassic.widgets.find((w) => w.name === "display_text");
assert.ok(ttWidgetClassic && ttWidgetClassic.inputEl, "display_text est un DOM widget (inputEl)");
assert.strictEqual(ttClassic.custom_widget_el, null, "avant draw : aucun <div> riche");
ttClassic.onDrawForeground({});
assert.ok(ttClassic.custom_widget_el, "ToText : <div> riche attaché via node.onDrawForeground (classique)");
assert.strictEqual(ttWidgetClassic.inputEl.style.display, "none", "textarea d'origine masqué");
ok("classique : ToText attache son rendu riche via node.onDrawForeground");

// SimpleBypasser classique : widget active masqué (canal canvas : widget.hidden).
const sbClassic = await build(remoteExt, "AIHSimpleBypasser", makeNode("AIHSimpleBypasser", SIMPLE_WIDGETS));
assert.strictEqual(activeWidget(sbClassic).hidden, true, "classique : widget active masqué (widget.hidden)");
assert.strictEqual(activeWidget(sbClassic).options.hidden, true, "classique : options.hidden posé aussi (Vue)");
ok("classique : SimpleBypasser masque le widget active (hidden + options.hidden)");

/* ════════════════════════ 2. MODE VUE (Nodes 2.0) ══════════════════════════ */
console.log("2. Mode VUE (vueNodesMode=true) — après correctif");
window.LiteGraph.vueNodesMode = true;
assert.strictEqual(compat.isVueNodesMode(), true, "isVueNodesMode()=true en Vue");

const gbVue = await build(remoteExt, "AIHGroupBypasser", makeNode("AIHGroupBypasser", GROUP_WIDGETS));
const ttVue = await build(toTextExt, "AIHToText", makeNode("AIHToText", []));
const sbVue = await build(remoteExt, "AIHSimpleBypasser", makeNode("AIHSimpleBypasser", SIMPLE_WIDGETS));

// SimpleBypasser : masquage honoré par le renderer Vue (options.hidden).
assert.strictEqual(activeWidget(sbVue).options.hidden, true,
    "Vue : le widget active porte options.hidden (lu par le rendu Vue)");
ok("Vue : SimpleBypasser masque le widget active via options.hidden");

// Vue SAUTE node.onDrawForeground : on ne l'appelle donc PAS (fidèle au renderer).
assert.strictEqual(ttVue.custom_widget_el, null,
    "contrôle négatif : sans le hook canvas-level, ToText n'attache RIEN en Vue");
ok("Vue : contrôle négatif — le chemin node-level seul ne suffit pas (rien attaché)");

// Un groupe est créé APRÈS le node : Vue n'appelle pas onMouseEnter.
fakeApp.graph._groups.push({ title: "Delta" });

// Le hook canvas-level (survivant en Vue) exécute l'entretien (Vue uniquement).
fakeCanvas.onDrawForeground();

assert.ok(ttVue.custom_widget_el,
    "Vue : ToText attache son <div> riche via le hook canvas-level");
assert.strictEqual(ttVue.widgets.find((w) => w.name === "display_text").inputEl.style.display, "none",
    "Vue : textarea d'origine masqué");
ok("Vue : ToText attache son rendu riche via le hook canvas-level");

assert.ok(groupCombo(gbVue).options.values.includes("Delta"),
    "Vue : le combo comfy_group capte le groupe créé après le node (hook canvas-level)");
ok("Vue : le combo comfy_group se rafraîchit via le hook canvas-level");

console.log(`\n✅ Nodes 2.0 — Remote / ToText : double mode prouvé (${n} assertions)`);
