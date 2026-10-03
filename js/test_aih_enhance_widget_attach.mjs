// ─────────────────────────────────────────────────────────────────────────
// Attachement du widget JS du Prompt Enhancer (node canonique AIHPromptEnhancer).
//
// Régression couverte (signalée utilisateur) : « le prompt enhancer a son
// affichage cassé (il n'y a plus la partie JS) ». Un widget JS qui cible un
// type de node inexistant ne s'attache JAMAIS — silencieusement (aucune
// erreur, rendu ComfyUI générique à la place). Le suspect était la
// suppression des alias legacy : si `NODE_TYPES` conservait l'ancienne clé
// (`AIHEnhanceNode`) au lieu de la clé réellement enregistrée côté Python
// (`AIHPromptEnhancer`, cf. nodes/enhance_node.py), l'UI disparaîtrait.
//
// Ce test charge les VRAIS modules du pack comme ComfyUI (loaders 03/04/00 +
// aih_strings), enregistre l'extension via le chemin réel (AIH.waitForApp),
// puis exécute beforeRegisterNodeDef + onNodeCreated et exige :
//   1. l'extension « AIH.Enhance » est bien enregistrée ;
//   2. pour nodeData.name = "AIHPromptEnhancer" → DOM widget « AIH_Enhance » ;
//   3. pour nodeData.name = "AIHEnhanceNode" (alias retiré) → AUCUN widget
//      (contrôle négatif : garantit que le test ne passe pas à vide) ;
//   4. le widget custom apporte bien son contenu DOM (selects, bouton…).
//
// Usages : node js/test_aih_enhance_widget_attach.mjs
// Code de sortie : 0 = PASS, 1 = FAIL, 2 = SKIP (jsdom absent).
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_aih_enhance_widget_attach");

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

// Faux app ComfyUI : window.comfyAPI.app.app (posé par le plugin Vite) +
// app.graph (posé par app.setup) → condition d'AIH.waitForApp.
const registered = [];
const fakeApp = {
    graph: {},
    registerExtension(ext) { registered.push(ext); },
};
window.comfyAPI = { app: { app: fakeApp } };

// Charge les VRAIS loaders/helpers du pack (ordre logique, pas l'ordre
// alphabétique : le pack ne doit dépendre d'AUCUN ordre — c'est justement ce
// que le polling d'aihBoot doit absorber).
for (const f of [
    "js/03_aih_shared.js",
    "js/04_aih_widget_base.js",
    "js/00_aih_picker_config.js",
    "js/aih_strings.js",
]) {
    await import(new URL("./" + f.replace(/^js\//, ""), import.meta.url).href);
}
// En navigateur window === globalThis : AIH.PickerConfig / AIH.waitForApp
// posés sur window sont accessibles en référence globale `AIH`.
globalThis.AIH = window.AIH;

// Charge le widget enhancer.
await import(new URL("./aih_enhance_widget.js", import.meta.url).href);

// L'extension s'enregistre via AIH.waitForApp (polling ~100 ms).
const deadline = Date.now() + 3000;
while (registered.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
}

console.log("1. Enregistrement de l'extension");
assert.strictEqual(registered.length, 1, "l'extension enhancer doit s'enregistrer");
assert.strictEqual(registered[0].name, "AIH.Enhance");
ok("extension « AIH.Enhance » enregistrée via le chemin réel (AIH.waitForApp)");

const ext = registered[0];

/** Node factice reproduisant l'API utilisée par le widget. */
function makeNode() {
    const node = {
        widgets: ["use_llm", "seed", "base_prompt", "template_id", "preset_id", "output_format",
                  "style_id", "style_shortlist", "special_instructions"].map((name) => ({
            name,
            value: typeof name === "string" && /prompt|style_shortlist|special_instructions/.test(name) ? "" : 0,
        })),
        inputs: [{ name: "elements" }, { name: "image" }],
        size: [360, 260],
        findInputSlot() { return -1; },
        removeInput() {},
        addDOMWidget(name, type, element, options) {
            const w = { name, type, element, options: options || {} };
            this.widgets.push(w);
            this._domWidgets = (this._domWidgets || 0) + 1;
            return w;
        },
    };
    return node;
}

/** Exécute beforeRegisterNodeDef + onNodeCreated pour un nodeData.name donné. */
async function attachFor(nodeDataName) {
    function FakeNode() {}
    FakeNode.prototype = { widgets: [], inputs: [], size: [360, 260] };
    await ext.beforeRegisterNodeDef(FakeNode, { name: nodeDataName });
    // Comme ComfyUI : le node est une instance du prototype enregistré (les
    // hooks posés par beforeRegisterNodeDef vivent sur FakeNode.prototype).
    const node = Object.assign(new FakeNode(), makeNode());
    if (typeof node.onNodeCreated === "function") node.onNodeCreated.call(node);
    return node;
}

console.log("2. nodeData.name = AIHPromptEnhancer (clé Python) → UI custom");
const good = await attachFor("AIHPromptEnhancer");
const domWidget = (good.widgets || []).find((w) => w.name === "AIH_Enhance");
assert.ok(domWidget, "le DOM widget « AIH_Enhance » doit être ajouté à AIHPromptEnhancer");
assert.ok(good._domWidgets === 1, "un seul DOM widget ajouté");
assert.deepStrictEqual(domWidget.options.getMinHeight(), 248, "hauteur min du DOM widget");
const domNodes = domWidget.element.querySelectorAll("*").length;
assert.ok(domNodes >= 10, `contenu DOM du widget présent (${domNodes} éléments)`);
ok(`AIHPromptEnhancer : DOM widget « AIH_Enhance » + ${domNodes} éléments DOM`);

console.log("3. Contrôle négatif : alias retiré AIHEnhanceNode → AUCUN widget");
const alias = await attachFor("AIHEnhanceNode");
assert.ok(!(alias.widgets || []).some((w) => w.name === "AIH_Enhance"),
    "l'ancien alias retiré AIHEnhanceNode ne doit PAS recevoir le widget");
ok("AIHEnhanceNode (alias supprimé) : aucun widget custom (matching strict)");

console.log("4. Contrôle négatif : type non lié → AUCUN widget");
const other = await attachFor("AIHKeywords");
assert.ok(!(other.widgets || []).some((w) => w.name === "AIH_Enhance"));
ok("un autre type de node n'est pas affecté par l'extension enhancer");

console.log(`\n✅ Prompt Enhancer — widget JS attaché : TOUS LES TESTS PASSENT (${n} assertions)`);
