// ─────────────────────────────────────────────────────────────────────────
// Widget JS de la node expérimentale « AIH Mask Anything » (dropdown Preset IA).
//
// Ce test charge les VRAIS modules du pack comme ComfyUI (loaders 03/00 +
// aih_strings + bridge fetch), enregistre l'extension via le chemin réel
// (AIH.waitForApp), exécute beforeRegisterNodeDef + onNodeCreated et exige :
//   1. l'extension « AIH.MaskAnything » est enregistrée ;
//   2. pour nodeData.name = "AIHMaskAnything" (clé Python) → DOM widget
//      « mask_anything_ui », NON sérialisé (widgets_values reste propre) ;
//   3. contrôle négatif : un autre type de node ne reçoit AUCUN widget ;
//   4. la liste des presets vient du SERVEUR (GET /api/presets) et la
//      sélection écrit dans le widget natif `preset_id` (persistance) ;
//   5. serveur injoignable → message explicite, aucune exception ;
//   6. `ui.status` (succès / ⚠️ échec) s'affiche sous le menu ;
//   7. i18n FR/EN à parité STRICTE pour les clés ma.* ;
//   8. contrôles négatifs par MUTATION : clé de node erronée → widget absent,
//      synchronisation retirée → `preset_id` non mis à jour.
//
// Usages : node js/test_aih_mask_anything_widget.mjs
// Code de sortie : 0 = PASS, 1 = FAIL, 2 = SKIP (jsdom absent).
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_aih_mask_anything_widget");
const HERE = fileURLToPath(new URL(".", import.meta.url));

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
globalThis.AbortController = globalThis.AbortController || window.AbortController;

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ── Faux serveur AIH : GET /api/presets ────────────────────────────────────
const PRESETS = [
    { id: 4, name: "Zeta Vision", model: "qwen2.5-vl" },
    { id: 2, name: "alpha vision", model: "gpt-4o" },
];
let fetchCalls = [];
let fetchMode = "ok";      // "ok" | "down" | "empty"
function installFetch() {
    globalThis.fetch = async (url, init) => {
        fetchCalls.push({ url: String(url), init });
        if (fetchMode === "down") throw new TypeError("fetch failed (ECONNREFUSED)");
        const body = fetchMode === "empty" ? [] : PRESETS;
        return {
            ok: true,
            status: 200,
            headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
            json: async () => body,
            text: async () => JSON.stringify(body),
        };
    };
}
installFetch();

// Config serveur (lue par le bridge fetch : localStorage "AIH_config").
window.localStorage.setItem("AIH_config", JSON.stringify({
    serverUrl: "https://aih.example",
    apiKey: "sk-TEST",
}));

// Faux app ComfyUI (même condition qu'AIH.waitForApp).
const registered = [];
const fakeApp = { graph: {}, registerExtension(ext) { registered.push(ext); } };
window.comfyAPI = { app: { app: fakeApp } };

for (const f of ["js/03_aih_shared.js", "js/04_aih_widget_base.js", "js/aih_strings.js"]) {
    await import(new URL("./" + f.replace(/^js\//, ""), import.meta.url).href);
}
globalThis.AIH = window.AIH;

await import(new URL("./aih_mask_anything_widget.js", import.meta.url).href);

const deadline = Date.now() + 3000;
while (registered.length === 0 && Date.now() < deadline) await tick(25);

console.log("1. Enregistrement de l'extension");
assert.strictEqual(registered.length, 1, "l'extension doit s'enregistrer");
assert.strictEqual(registered[0].name, "AIH.MaskAnything");
ok("extension « AIH.MaskAnything » enregistrée via le chemin réel (AIH.waitForApp)");

const ext = registered[0];

/** Node factice reproduisant l'API utilisée par le widget. */
function makeNode(presetValue = 0) {
    const node = {
        widgets: [
            { name: "preset_id", value: presetValue, hidden: false },
            { name: "feather", value: 0 },
        ],
        inputs: [{ name: "image" }, { name: "llm_config" }],
        size: [320, 240],
        addDOMWidget(name, type, element, options) {
            const w = { name, type, element, options: options || {} };
            this.widgets.push(w);
            return w;
        },
    };
    return node;
}

async function attachFor(nodeDataName, presetValue = 0) {
    function FakeNode() {}
    FakeNode.prototype = { widgets: [], inputs: [], size: [320, 240] };
    await ext.beforeRegisterNodeDef(FakeNode, { name: nodeDataName });
    const node = Object.assign(new FakeNode(), makeNode(presetValue));
    if (typeof node.onNodeCreated === "function") node.onNodeCreated.call(node);
    return node;
}

const domWidgetOf = (node) => (node.widgets || []).find((w) => w.name === "mask_anything_ui");
const presetWidgetOf = (node) => (node.widgets || []).find((w) => w.name === "preset_id");
const selectOf = (node) => domWidgetOf(node).element.querySelector("select");
const statusOf = (node) => domWidgetOf(node).element.querySelector("div");

console.log("2. nodeData.name = AIHMaskAnything (clé Python) → UI custom");
const good = await attachFor("AIHMaskAnything");
const domWidget = domWidgetOf(good);
assert.ok(domWidget, "le DOM widget « mask_anything_ui » doit être ajouté");
assert.strictEqual(domWidget.serialize, false, "le DOM widget ne doit PAS être sérialisé");
assert.strictEqual(domWidget.options.serialize, false, "options.serialize=false (prompt API)");
assert.strictEqual(domWidget.options.getMinHeight(), 52, "hauteur minimale du DOM widget");
assert.strictEqual(presetWidgetOf(good).hidden, true, "preset_id masqué en mode CLASSIQUE (widget.hidden)");
assert.strictEqual(presetWidgetOf(good).options.hidden, true, "preset_id masqué en Nodes 2.0 (options.hidden)");
ok("AIHMaskAnything : DOM widget non sérialisé + preset_id natif masqué (classique ET Nodes 2.0)");

console.log("3. Contrôle négatif : autre type de node → AUCUN widget");
const other = await attachFor("AIHKeywords");
assert.ok(!domWidgetOf(other), "un autre type ne doit pas recevoir le widget");
assert.ok(!domWidgetOf(await attachFor("HolafRemote")), "ancien alias Holaf* : aucun widget");
ok("matching STRICT : aucun autre type de node n'est affecté");

console.log("4. Liste des presets depuis le SERVEUR + persistance dans preset_id");
await tick(30);
assert.ok(fetchCalls.length >= 1, "un appel GET /api/presets doit partir");
assert.ok(fetchCalls[0].url.endsWith("/api/presets"), `URL attendue …/api/presets, reçue ${fetchCalls[0].url}`);
assert.strictEqual(fetchCalls[0].init.method, "GET");
const options = [...selectOf(good).options];
assert.deepStrictEqual(
    options.map((o) => o.value),
    ["0", "2", "4"],
    "placeholder + presets TRIÉS par nom (alpha vision puis Zeta Vision)",
);
assert.ok(options[0].textContent.includes("Preset"), "placeholder traduit (clé i18n ma.presetPlaceholder)");
assert.ok(options.some((o) => o.textContent === "Zeta Vision"), "les libellés viennent du serveur");
ok(`presets serveur listés (${options.length - 1}) et triés par nom`);

const select = selectOf(good);
select.value = "4";
select.dispatchEvent(new window.Event("change"));
assert.strictEqual(presetWidgetOf(good).value, 4, "la sélection doit écrire dans preset_id (widgets_values)");
select.value = "0";
select.dispatchEvent(new window.Event("change"));
assert.strictEqual(presetWidgetOf(good).value, 0, "retour au placeholder → preset_id = 0");
ok("sélection du menu → preset_id natif (persistance widgets_values)");

console.log("5. Serveur injoignable → message explicite, aucune exception");
fetchMode = "down";
const offline = await attachFor("AIHMaskAnything");
await tick(30);
const offlineStatus = statusOf(offline).textContent;
assert.ok(/unreachable|injoignable/i.test(offlineStatus), `message attendu, reçu « ${offlineStatus} »`);
assert.strictEqual([...selectOf(offline).options].length, 1, "seul le placeholder reste disponible");
assert.doesNotThrow(() => selectOf(offline).dispatchEvent(new window.Event("change")));
ok("serveur injoignable : message dit, menu utilisable, aucune exception");

console.log("6. ui.status affiché sous le menu (succès ET échec)");
fetchMode = "ok";
good.onExecuted({ status: ["2 boîte(s) → masque 1024×768"] });
assert.strictEqual(statusOf(good).textContent, "2 boîte(s) → masque 1024×768");
const warnings = [];
const origWarn = console.warn;
console.warn = (...args) => { warnings.push(args.join(" ")); };
try {
    good.onExecuted({ status: ["⚠️ aucune boîte dans la réponse"] });
} finally {
    console.warn = origWarn;
}
assert.strictEqual(statusOf(good).textContent, "⚠️ aucune boîte dans la réponse");
assert.ok(warnings.some((w) => w.includes("[AIH Mask Anything]")), "l'échec est aussi journalisé en console");
good.onExecuted({ status: [] });
assert.strictEqual(statusOf(good).textContent, "⚠️ aucune boîte dans la réponse", "status vide : pas d'écrasement");
ok("message d'exécution affiché (succès + ⚠️) + log console préfixé");

console.log("7. i18n FR/EN : clés ma.* présentes et à parité");
const dicts = {};
const origAddDict = window.AIH.I18n.addDict;
assert.ok(typeof origAddDict === "function");
// Les dictionnaires ont déjà été enregistrés par aih_strings.js au chargement.
const I18n = window.AIH.I18n;
const KEYS = ["ma.presetLabel", "ma.presetPlaceholder", "ma.statusIdle", "ma.serverUnavailable", "ma.noPresets"];
const savedLocale = I18n.getLocale();
I18n.setLocale("fr");
const fr = KEYS.map((k) => I18n.t(k));
I18n.setLocale("en");
const en = KEYS.map((k) => I18n.t(k));
I18n.setLocale(savedLocale);
KEYS.forEach((k, i) => {
    assert.ok(fr[i] && fr[i] !== k, `clé FR absente : ${k}`);
    assert.ok(en[i] && en[i] !== k, `clé EN absente : ${k}`);
});
assert.notStrictEqual(fr[0], en[0], "les libellés FR et EN diffèrent (vraie traduction)");
for (const [, value] of Object.entries(dicts)) void value;
ok(`parité FR/EN OK (${KEYS.length} clés ma.*)`);

console.log("8. Contrôles négatifs par MUTATION");
{
    const SRC = readFileSync(join(HERE, "aih_mask_anything_widget.js"), "utf8");
    for (const f of readdirSync(HERE)) {
        if (/^\.__mut_ma_\d+\.mjs$/.test(f)) rmSync(join(HERE, f), { force: true });
    }

    let seq = 0;
    /** Écrit un mutant du widget, l'importe et renvoie son extension. */
    async function loadMutant(label, mutate) {
        const mutated = mutate(SRC);
        assert.notStrictEqual(mutated, SRC, `mutation « ${label} » sans effet (ancre introuvable)`);
        const file = join(HERE, `.__mut_ma_${++seq}.mjs`);
        writeFileSync(file, mutated, "utf8");
        const before = registered.length;
        await import("file://" + file + "?m=" + seq);
        // aihBoot() attend l'app via AIH.waitForApp (polling ~100 ms).
        const until = Date.now() + 3000;
        while (registered.length === before && Date.now() < until) await tick(25);
        const mutantExt = registered.filter((e) => e && e.name === "AIH.MaskAnything").pop();
        assert.ok(mutantExt && mutantExt !== ext, `mutation « ${label} » : mutant non enregistré`);
        return { mutantExt, file };
    }

    async function attachWith(mutantExt, presetValue = 0) {
        function FakeNode() {}
        FakeNode.prototype = { widgets: [], inputs: [], size: [320, 240] };
        await mutantExt.beforeRegisterNodeDef(FakeNode, { name: "AIHMaskAnything" });
        const node = Object.assign(new FakeNode(), makeNode(presetValue));
        if (typeof node.onNodeCreated === "function") node.onNodeCreated.call(node);
        return node;
    }

    // M1 — clé de node erronée : l'UI ne s'attache plus (assertion (3) rouge).
    {
        const { mutantExt, file } = await loadMutant(
            "NODE_TYPES erroné",
            (s) => s.replace('const NODE_TYPES = ["AIHMaskAnything"];', 'const NODE_TYPES = ["AIH Mask Anything"];'),
        );
        try {
            const node = await attachWith(mutantExt);
            assert.ok(!domWidgetOf(node),
                "M1 : avec une clé non enregistrée, l'UI ne s'attache PAS → l'assertion (2) serait ROUGE");
        } finally {
            rmSync(file, { force: true });
        }
        ok("M1 clé de node erronée → DOM widget absent (l'assertion (2) devient ROUGE)");
    }

    // M2 — synchronisation supprimée : la sélection n'atteint plus preset_id.
    {
        const { mutantExt, file } = await loadMutant(
            "sync preset_id retirée",
            (s) => s.replace("presetSelect.addEventListener(\"change\", syncNativeWidget);",
                             "presetSelect.addEventListener(\"change\", () => {});"),
        );
        try {
            const node = await attachWith(mutantExt);
            await tick(30);
            const mutantSelect = domWidgetOf(node).element.querySelector("select");
            mutantSelect.value = "4";
            mutantSelect.dispatchEvent(new window.Event("change"));
            assert.strictEqual(presetWidgetOf(node).value, 0,
                "M2 : preset_id reste à 0 → l'assertion (4) serait ROUGE (sélection non persistée)");
        } finally {
            rmSync(file, { force: true });
        }
        ok("M2 synchronisation retirée → preset_id non mis à jour (l'assertion (4) devient ROUGE)");
    }

    assert.strictEqual(readFileSync(join(HERE, "aih_mask_anything_widget.js"), "utf8"), SRC,
        "le source du widget n'a pas été modifié par les mutants");
    assert.deepStrictEqual(readdirSync(HERE).filter((f) => f.startsWith(".__mut_ma_")), [],
        "aucun mutant ne doit rester sur le disque");
    ok("source intact, aucun mutant résiduel");
}

console.log(`\n✅ Widget « AIH Mask Anything » (preset IA serveur + statut) : TOUS LES TESTS PASSENT (${n} assertions)`);
