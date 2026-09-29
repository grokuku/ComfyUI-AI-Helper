// Test d'INTÉGRATION du filtre « modèles du workflow » du Model Browser
// (02_aih_model_browser.js) — jsdom + fetch stubé, AUCUN appel réseau réel.
// Usage : node js/test_aih_model_browser_workflow.mjs
//
// Verrouille :
//   1. i18n FR/EN : clés du filtre workflow présentes + parité stricte ;
//   2. bouton présent, inactif par défaut, libellé avec le nombre de modèles ;
//   3. activation → les DEUX listes (locale ET distante) sont filtrées ;
//   4. cumul avec la recherche locale et avec les filtres de type ;
//   5. récapitulatif « local / distant / manquant » ;
//   6. désactivation → retour à toutes les listes ;
//   7. CONTRÔLES NÉGATIFS : workflow sans modèle → listes vides (pas « tout ») ;
//      aucune régression du filtre existant quand le filtre workflow est inactif.
//
// jsdom est résolu par le loader partagé ; introuvable = SKIP bruyant (exit 2).
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_aih_model_browser_workflow");

const dom = new JSDOM(`<!doctype html><html><body></body></html>`, {
    pretendToBeVisual: true,
    url: "http://localhost/",
});
const { window } = dom;
const { document } = window;
globalThis.window = window;
globalThis.document = document;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.MouseEvent = window.MouseEvent;
globalThis.Image = window.Image;
globalThis.requestAnimationFrame = window.requestAnimationFrame?.bind(window) || ((cb) => setTimeout(cb, 0));
globalThis.cancelAnimationFrame = window.cancelAnimationFrame?.bind(window) || clearTimeout;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.ResizeObserver = globalThis.ResizeObserver;
// Empêche holaf_api_compat.js de poller window.comfyAPI.
window.comfyAPI = { app: { app: { registerExtension() {} } }, api: { api: { api_base: "/" } } };
globalThis.URL.createObjectURL = () => "blob:mock";
globalThis.URL.revokeObjectURL = () => {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

/* ─── 1. i18n : capture AVANT l'import d'aih_strings.js ────────────────── */
console.log("1. i18n FR/EN");
await import("./aih_i18n.js");
const I18n = window.AIH.I18n;
I18n.setLocale("fr");
const dictionaries = {};
const origAddDict = I18n.addDict.bind(I18n);
I18n.addDict = (lang, entries) => {
    dictionaries[lang] = Object.assign(dictionaries[lang] || {}, entries);
    return origAddDict(lang, entries);
};
await import("./aih_strings.js");

const WF_KEYS = [
    "mb.workflowFilterCount", "mb.workflowFilterTitle",
    "mb.workflowEmpty", "mb.workflowNoMatch", "mb.workflowSummary",
    "mb.workflowCapped",
];
for (const key of WF_KEYS) {
    assert.ok(dictionaries.fr && key in dictionaries.fr, `clé ${key} absente en FR`);
    assert.ok(dictionaries.en && key in dictionaries.en, `clé ${key} absente en EN`);
}
{
    const frKeys = Object.keys(dictionaries.fr || {});
    const enKeys = Object.keys(dictionaries.en || {});
    const onlyFr = frKeys.filter((k) => !(k in (dictionaries.en || {})));
    const onlyEn = enKeys.filter((k) => !(k in (dictionaries.fr || {})));
    assert.deepStrictEqual(onlyFr, [], `clés FR absentes en EN : ${onlyFr.join(", ")}`);
    assert.deepStrictEqual(onlyEn, [], `clés EN absentes en FR : ${onlyEn.join(", ")}`);
}
ok(`clés du filtre workflow FR+EN + parité stricte (${WF_KEYS.length} clés)`);

/* ─── 2. Fetch factice + imports ───────────────────────────────────────── */
let localResponse = {};
let remoteResponse = {};
function jsonResponse(data) {
    return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}
globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/auth/me")) return jsonResponse({ role: "user" });
    if (u.includes("/models/local")) return jsonResponse({ items: localResponse, total: 0 });
    if (u.includes("/models/remote")) return jsonResponse(remoteResponse);
    return jsonResponse({});
};
window.fetch = globalThis.fetch;

window.localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "https://aih.example.com", apiKey: "tok" }));

await import("./02_aih_model_browser.js");
// Les helpers globaux du dialogue sont posés sur `window` (jsdom) mais le
// module les lit comme identifiants globaux → on les recopie sur globalThis.
for (const k of ["aihOpenModalV2", "aihShowAlert", "aihShowConfirm", "aihToast", "showConflictModal", "HolafModal"]) {
    if (typeof window[k] !== "undefined") globalThis[k] = window[k];
}
assert.strictEqual(typeof window.openModelBrowser, "function", "openModelBrowser exposé");

/* ─── 3. Jeu de données ────────────────────────────────────────────────── */
const WORKFLOW_GRAPH = { nodes: [
    { type: "CheckpointLoaderSimple", widgets: [{ name: "ckpt_name", value: "sdxl.safetensors" }] },
    { type: "LoraLoader", widgets: [{ name: "lora_name", value: "style.safetensors" }, { name: "strength", value: 0.7 }] },
    { type: "VAELoader", widgets: [{ name: "vae_name", value: "vae-missing.safetensors" }] },
    { type: "KSampler", widgets: [{ name: "seed", value: 7 }] },
] };
window.app = { graph: WORKFLOW_GRAPH };

localResponse = {
    checkpoints: [
        { name: "sdxl.safetensors", path: "checkpoints/sdxl.safetensors", size: 100 },
        { name: "extra.ckpt", path: "checkpoints/extra.ckpt", size: 200 },
    ],
    loras: [
        { name: "style.safetensors", path: "loras/style.safetensors", size: 50 },
        { name: "other.safetensors", path: "loras/other.safetensors", size: 60 },
    ],
};
remoteResponse = {
    items: [
        { name: "sdxl.safetensors", id: "1" },
        { name: "unused.safetensors", id: "2" },
        { name: "style.safetensors", id: "3" },
    ],
    total: 3, page: 1, limit: 50,
};

const btn = () => document.querySelector(".mb-filter-workflow");
const itemsLocal = () => document.querySelectorAll("#mb-local-list .mb-item");
const itemsRemote = () => document.querySelectorAll("#mb-remote-list .mb-item");
const summaryEl = () => document.querySelector(".mb-workflow-summary");

/* ─── 4. Ouverture : bouton inactif, listes complètes ──────────────────── */
console.log("2. Ouverture");
window.openModelBrowser();
await sleep(150);

assert.ok(btn(), "bouton « modèles du workflow » présent dans la barre de filtres");
assert.ok(!btn().classList.contains("active"), "bouton inactif par défaut");
assert.ok(/\(3\)/.test(btn().textContent), "libellé porte le nombre de modèles du workflow (" + btn().textContent.trim() + ")");
assert.strictEqual(itemsLocal().length, 4, "local : 4 items avant filtrage");
assert.strictEqual(itemsRemote().length, 3, "distant : 3 items avant filtrage");
assert.strictEqual(summaryEl().style.display, "none", "récapitulatif masqué quand inactif");
ok("ouverture : bouton inactif (compteur 3), les deux listes complètes, récap masqué");

/* ─── 5. Activation : les DEUX listes filtrées ─────────────────────────── */
console.log("3. Activation");
I18n.setLocale("en");
btn().click();
await sleep(150);

assert.ok(btn().classList.contains("active"), "bouton actif après clic");
assert.strictEqual(itemsLocal().length, 2, "local filtré : 2 modèles du workflow");
assert.strictEqual(itemsRemote().length, 2, "distant filtré : 2 modèles du workflow");
{
    const names = [...itemsLocal()].map((el) => el.querySelector(".mb-name").textContent).sort();
    assert.deepStrictEqual(names, ["sdxl.safetensors", "style.safetensors"], "noms locaux = modèles du workflow");
}
{
    const names = [...itemsRemote()].map((el) => el.querySelector(".mb-name").textContent).sort();
    assert.deepStrictEqual(names, ["sdxl.safetensors", "style.safetensors"], "noms distants = modèles du workflow");
}
ok("activation : listes locale ET distante restreintes aux modèles du workflow");

/* ─── 6. Récapitulatif présent local / distant / manquant ──────────────── */
console.log("4. Récapitulatif");
{
    const txt = summaryEl().textContent;
    assert.ok(summaryEl().style.display !== "none", "récapitulatif visible quand actif");
    assert.ok(/3 workflow model/.test(txt), "total du workflow = 3 (" + txt + ")");
    assert.ok(/local 2/.test(txt), "présents en local = 2");
    assert.ok(/remote 2/.test(txt), "présents en distant = 2");
    assert.ok(/missing remote: 1/.test(txt), "manquant en distant = 1");
}
ok("récapitulatif : 3 modèles · local 2 · distant 2 · manquant distant 1 (EN)");

/* ─── 7. Cumul avec la recherche locale ────────────────────────────────── */
console.log("5. Cumul recherche");
{
    const s = document.querySelector("#mb-search-local");
    s.value = "style";
    s.dispatchEvent(new window.Event("input"));
    await sleep(400);
    assert.strictEqual(itemsLocal().length, 1, "workflow + recherche « style » → 1");
    assert.strictEqual(itemsLocal()[0].querySelector(".mb-name").textContent, "style.safetensors", "le bon item");
    s.value = "";
    s.dispatchEvent(new window.Event("input"));
    await sleep(400);
    assert.strictEqual(itemsLocal().length, 2, "recherche vidée → 2");
}
ok("cumul : workflow + recherche locale (client)");

/* ─── 8. Cumul avec un filtre de type ──────────────────────────────────── */
console.log("6. Cumul type");
{
    // Désactive le type « lora » (label.dataset.type === "lora").
    const loraLabel = [...document.querySelectorAll(".mb-filter-checkbox")]
        .find((el) => el.dataset && el.dataset.type === "lora");
    assert.ok(loraLabel, "filtre de type lora trouvé");
    loraLabel.click();
    await sleep(120);
    assert.strictEqual(itemsLocal().length, 1, "workflow + sans lora → 1 (sdxl)");
    assert.strictEqual(itemsLocal()[0].querySelector(".mb-name").textContent, "sdxl.safetensors", "seul le checkpoint reste");
    // Réactive lora.
    loraLabel.click();
    await sleep(120);
    assert.strictEqual(itemsLocal().length, 2, "lora réactivé → 2");
}
ok("cumul : workflow + filtre de type (et le toggle workflow ne perturbe pas les types)");

/* ─── 9. Désactivation → listes complètes ──────────────────────────────── */
console.log("7. Désactivation");
btn().click();
await sleep(150);
assert.ok(!btn().classList.contains("active"), "bouton redevenu inactif");
assert.strictEqual(itemsLocal().length, 4, "local : 4 items restaurés");
assert.strictEqual(itemsRemote().length, 3, "distant : 3 items restaurés");
assert.strictEqual(summaryEl().style.display, "none", "récapitulatif masqué");
ok("désactivation : les deux listes retrouvent tous les items");

/* ─── 10. CONTRÔLE NÉGATIF : workflow sans modèle ──────────────────────── */
console.log("8. Contrôle négatif — workflow sans modèle");
{
    window.app = { graph: { nodes: [
        { type: "KSampler", widgets: [{ name: "seed", value: 1 }, { name: "steps", value: 20 }] },
        { type: "EmptyLatentImage", widgets: [{ name: "width", value: 1024 }] },
    ] } };
    btn().click(); // activation → recalcul (0 modèle)
    await sleep(150);
    assert.ok(btn().classList.contains("active"), "bouton actif");
    assert.ok(/\((0)\)/.test(btn().textContent), "compteur = 0 (" + btn().textContent.trim() + ")");
    assert.strictEqual(itemsLocal().length, 0, "local vide (PAS « tout afficher »)");
    assert.strictEqual(itemsRemote().length, 0, "distant vide (PAS « tout afficher »)");
    assert.ok(/No model detected in the workflow/.test(document.querySelector("#mb-local-list").textContent),
        "message dédié « aucun modèle détecté dans le workflow »");
}
ok("contrôle négatif : workflow sans modèle → listes vides + message dédié (aucun faux positif)");

/* ─── 11. CONTRÔLE NÉGATIF : filtres existants intacts (workflow inactif) ─ */
console.log("9. Contrôle négatif — non-régression des filtres existants");
{
    btn().click(); // désactivation
    await sleep(120);
    // Workflow inactif : la recherche locale doit toujours fonctionner seule.
    const s = document.querySelector("#mb-search-local");
    s.value = "extra";
    s.dispatchEvent(new window.Event("input"));
    await sleep(400);
    assert.strictEqual(itemsLocal().length, 1, "recherche seule (sans workflow) → 1");
    assert.strictEqual(itemsLocal()[0].querySelector(".mb-name").textContent, "extra.ckpt", "bon item");
    s.value = "";
    s.dispatchEvent(new window.Event("input"));
    await sleep(400);
    assert.strictEqual(itemsLocal().length, 4, "recherche vidée → 4");
}
ok("contrôle négatif : filtres existants inchangés quand le filtre workflow est inactif");

/* ─── 12. Pagination distante : match au-delà de la page 1 ─────────────── */
console.log("10. Auto-pagination distante");
{
    // Workflow dont le seul modèle n'existe QUE sur la 2e page distante.
    window.app = { graph: { nodes: [
        { type: "CheckpointLoaderSimple", widgets: [{ name: "ckpt_name", value: "deep.safetensors" }] },
    ] } };
    const page1 = Array.from({ length: 200 }, (_, i) => ({ name: "filler" + i + ".safetensors", id: "f" + i }));
    const page2 = [
        { name: "deep.safetensors", id: "deep" },
        { name: "tail.safetensors", id: "tail" },
    ];
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/auth/me")) return jsonResponse({ role: "user" });
        if (u.includes("/models/local")) return jsonResponse({ items: localResponse, total: 0 });
        if (u.includes("/models/remote")) {
            const p = parseInt(new URL(u, "http://x").searchParams.get("page") || "1", 10);
            return jsonResponse(p === 1 ? { items: page1, total: 202, page: 1, limit: 200 }
                                        : { items: page2, total: 202, page: 2, limit: 200 });
        }
        return jsonResponse({});
    };
    window.fetch = globalThis.fetch;

    btn().click(); // activation
    await sleep(400); // laisse le temps d'enchaîner page 1 puis page 2
    assert.ok(btn().classList.contains("active"), "bouton actif");
    assert.strictEqual(itemsRemote().length, 1, "distant filtré : 1 modèle (trouvé page 2)");
    assert.strictEqual(itemsRemote()[0].querySelector(".mb-name").textContent, "deep.safetensors",
        "le modèle de la page 2 est bien affiché (auto-pagination)");
    btn().click(); // désactivation (propreté)
    await sleep(120);
}
ok("auto-pagination : le filtre distant trouve un modèle situé au-delà de la page 1");

console.log(`\n✅ test_aih_model_browser_workflow : ${n} groupes PASSENT`);
