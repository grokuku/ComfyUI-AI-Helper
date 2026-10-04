// ─────────────────────────────────────────────────────────────────────────
// UI « Réparer un workflow » (js/aih_repair_workflow.js)
//
// Vérifie l'ERGONOMIE EXIGÉE PAR L'UTILISATEUR, côté UI :
//   • sélection MULTIPLE de workflows sauvegardés + zone de collage JSON ;
//   • bouton « Analyser » ;
//   • résultats GROUPÉS : UNE ligne par TYPE de node (avec le bon compte),
//     JAMAIS une ligne par occurrence (12 occurrences → 1 ligne) ;
//   • cases à cocher par ligne (+ tout cocher / tout décocher) ;
//   • « Réparer » n'applique QUE les actions cochées (payload `selected`) ;
//   • sortie : JSON collé → « Copier » / « Enregistrer sous » ;
//     fichiers → « Écraser » / « Enregistrer sous » ;
//   • helpers purs groupProblems / deriveSaveAs.
//
// CONTRÔLES NÉGATIFS PAR MUTATION : ne pas grouper → rouge ; réparer tout au
// lieu du coché → rouge.
//
// Usage : node js/test_aih_repair_workflow.mjs
//   jsdom résolu par js/test_helpers/jsdom_loader.mjs ; absent = SKIP (exit 2).
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

// ── Parité i18n FR/EN STRICTE (clés de l'outil, js/aih_strings.js) ────────
{
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "aih_strings.js"), "utf8");
    const frStart = src.indexOf("const FR = {");
    const enStart = src.indexOf("const EN = {");
    const tail = src.indexOf('I18n.addDict("fr"');
    const keyRe = /"((?:menu\.repairWorkflow|rw\.[A-Za-z.]+))"\s*:/g;
    const keysOf = (block) => new Set([...block.matchAll(keyRe)].map((m) => m[1]));
    const frKeys = keysOf(src.slice(frStart, enStart));
    const enKeys = keysOf(src.slice(enStart, tail));
    const onlyFr = [...frKeys].filter((k) => !enKeys.has(k));
    const onlyEn = [...enKeys].filter((k) => !frKeys.has(k));
    assert.strictEqual(onlyFr.length, 0, `clés FR sans EN : ${onlyFr}`);
    assert.strictEqual(onlyEn.length, 0, `clés EN sans FR : ${onlyEn}`);
    assert.ok(frKeys.size >= 40, `au moins 40 clés rw.* attendues, got ${frKeys.size}`);
    assert.ok(frKeys.has("menu.repairWorkflow") && frKeys.has("rw.title"));
    ok(`parité i18n FR/EN : ${frKeys.size} clés (rw.* + menu.repairWorkflow)`);
}

const JSDOM = await loadJsdomOrSkip("test_aih_repair_workflow");
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
});
const { window: domWindow } = dom;
globalThis.window = domWindow;
globalThis.document = domWindow.document;
globalThis.localStorage = domWindow.localStorage;
globalThis.getComputedStyle = domWindow.getComputedStyle.bind(domWindow);
globalThis.HTMLElement = domWindow.HTMLElement;
globalThis.Node = domWindow.Node;
globalThis.Event = domWindow.Event;
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
try { globalThis.navigator = domWindow.navigator; } catch { /* déjà fourni */ }
domWindow.matchMedia = domWindow.matchMedia || (() => ({
    matches: false, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
}));
localStorage.setItem("aih_locale", "fr");

// Faux app ComfyUI minimal (certains imports de fondation le consultent).
globalThis.window.app = {
    graph: { nodes: [], setDirtyCanvas() {}, getNodeById() { return null; } },
    canvas: { setDirtyCanvas() {}, centerOnNode() {} },
    registerExtension() {},
    extensions: [],
};

await import("./aih_i18n.js");
await import("./aih_repair_workflow.js");

const RW = domWindow.AIHRepairWorkflow;
assert.ok(RW && typeof RW.mountRepairUI === "function", "window.AIHRepairWorkflow.mountRepairUI exposé");
assert.ok(typeof RW.open === "function", "window.AIHRepairWorkflow.open exposé");

// ── Helpers de test ──────────────────────────────────────────────────────
const flush = () => new Promise((r) => setTimeout(r, 5));

function makeProblem(id, overrides = {}) {
    return {
        id,
        kind: "missing_node_type",
        old_type: "HolafRemoteComparer",
        new_type: "AIHRemoteComparer",
        count: 12,
        checkable: true,
        action: { type: "replace_node_type", from: "HolafRemoteComparer", to: "AIHRemoteComparer" },
        occurrences: Array.from({ length: 12 }, (_, i) => ({ scope: "root", node_id: i + 1 })),
        ...overrides,
    };
}

function makeApi(calls, { problems } = {}) {
    return {
        listWorkflows: async () => ({
            workflows: [
                { path: "a.json", name: "a.json" },
                { path: "sub/b.json", name: "b.json" },
                { path: "c.json", name: "c.json" },
            ],
        }),
        analyze: async (payload) => {
            calls.push(["analyze", payload]);
            return { problems: problems || [makeProblem("missing_node_type|HolafRemoteComparer|AIHRemoteComparer")] };
        },
        apply: async (payload) => {
            calls.push(["apply", payload]);
            return {
                mode: payload.mode,
                results: [{
                    id: "pasted",
                    kind: "pasted",
                    written: payload.mode !== "preview",
                    dest: payload.mode === "preview" ? undefined : "fixed.json",
                    backup: payload.mode === "overwrite" ? "a.json.bak" : null,
                    repaired: { nodes: [] },
                    summary: { nodes_renamed: 12, widgets_remapped: 12, widgets_unmapped: 0, pre_existing_validation_errors: 0 },
                    report: { new_validation_errors: [] },
                }],
                errors: [],
            };
        },
    };
}

function mount(api, extra = {}) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const notifications = [];
    const ctrl = RW.mountRepairUI(container, {
        document,
        t: RW._t,
        api,
        notify: (m, type) => notifications.push([m, type]),
        confirm: extra.confirm || (async () => true),
        prompt: extra.prompt || (async () => "fixed.json"),
        copyText: extra.copyText || (async () => {}),
    });
    return { container, ctrl, notifications };
}

// ═════════════════════════════════════════════════════════════════════════
// a) Helpers PURS
// ═════════════════════════════════════════════════════════════════════════
{
    // Regroupement : plusieurs entrées du MÊME problème → UNE seule.
    const merged = RW.groupProblems([
        { id: "x", count: 1, occurrences: [{}] },
        { id: "x", count: 1, occurrences: [{}] },
        { id: "x", count: 1, occurrences: [{}], checkable: true },
    ]);
    assert.strictEqual(merged.length, 0 + 1, "groupProblems fusionne par id");
    assert.strictEqual(merged[0].count, 3, "count = total des occurrences");
    ok("groupProblems : une entrée par type, count cumulé");

    // Contrôle négatif : SANS regroupement, il y aurait 3 entrées.
    const ungrouped = [
        { id: "x", occurrences: [{}] }, { id: "x", occurrences: [{}] }, { id: "x", occurrences: [{}] },
    ];
    assert.strictEqual(ungrouped.length, 3, "sans regroupement → 3 lignes (rouge)");

    assert.strictEqual(RW.ensureJsonExt("foo"), "foo.json");
    assert.strictEqual(RW.ensureJsonExt("foo.json"), "foo.json");
    assert.strictEqual(RW.deriveSaveAs("fixed.json", 0, 1), "fixed.json");
    assert.strictEqual(RW.deriveSaveAs("fixed", 1, 3), "fixed-2.json");
    ok("deriveSaveAs / ensureJsonExt");
}

// ═════════════════════════════════════════════════════════════════════════
// b) Chargement + multi-sélection des workflows sauvegardés
// ═════════════════════════════════════════════════════════════════════════
{
    const calls = [];
    const { container, ctrl } = mount(makeApi(calls));
    await flush();
    const rows = container.querySelectorAll(".rw-saved-check");
    assert.strictEqual(rows.length, 3, "3 workflows sauvegardés listés");
    // multi-sélection
    ctrl.setCheckedFiles(["a.json", "sub/b.json"]);
    const sources = ctrl.buildSources();
    assert.deepStrictEqual(
        sources.map((s) => s.kind),
        ["file", "file"],
        "2 fichiers sélectionnés"
    );
    assert.deepStrictEqual(sources.map((s) => s.path), ["a.json", "sub/b.json"]);
    ok("multi-sélection de workflows sauvegardés");
}

// ═════════════════════════════════════════════════════════════════════════
// c) Collage + Analyser + résultats GROUPÉS (une ligne par type)
// ═════════════════════════════════════════════════════════════════════════
{
    const calls = [];
    const problems = [
        makeProblem("missing_node_type|HolafRemoteComparer|AIHRemoteComparer", { count: 12 }),
        {
            id: "missing_node_type|TotallyUnknownNode|",
            kind: "missing_node_type",
            old_type: "TotallyUnknownNode",
            new_type: null,
            count: 1,
            checkable: false,
            action: null,
            occurrences: [{ scope: "root", node_id: 99 }],
        },
    ];
    const { container, ctrl } = mount(makeApi(calls, { problems }));
    await flush();
    ctrl.setPasted('{"nodes":[]}');
    await ctrl.analyze();
    await flush();

    // Le payload d'analyse contient la source collée.
    const analyzeCall = calls.find((c) => c[0] === "analyze");
    assert.ok(analyzeCall, "analyser a appelé l'API");
    assert.strictEqual(analyzeCall[1].sources[0].kind, "pasted");
    assert.strictEqual(analyzeCall[1].sources[0].content, '{"nodes":[]}');

    // UNE ligne par TYPE (2 problèmes) — surtout PAS 12 lignes.
    const rows = container.querySelectorAll(".rw-problem");
    assert.strictEqual(rows.length, 2, "2 lignes (une par type de problème)");
    assert.notStrictEqual(rows.length, 13, "jamais une ligne par occurrence");

    const first = container.querySelector('.rw-problem[data-problem-id="missing_node_type|HolafRemoteComparer|AIHRemoteComparer"]');
    assert.ok(first, "ligne HolafRemoteComparer présente");
    assert.strictEqual(first.getAttribute("data-count"), "12");
    assert.ok(first.querySelector(".rw-problem-count").textContent.includes("12"), "compte 12 affiché");
    assert.ok(first.querySelector(".rw-problem-label").textContent.includes("HolafRemoteComparer"));
    assert.ok(first.querySelector(".rw-problem-label").textContent.includes("AIHRemoteComparer"));

    // Type sans proposition : ligne affichée MAIS case désactivée.
    const unknown = container.querySelector('.rw-problem[data-problem-id="missing_node_type|TotallyUnknownNode|"]');
    assert.ok(unknown, "type sans proposition affiché");
    assert.ok(unknown.querySelector(".rw-problem-check").disabled, "case désactivée sans proposition");
    assert.ok(unknown.querySelector(".rw-problem-label").textContent.includes("TotallyUnknownNode"));

    // Détail repliable des emplacements.
    const toggle = first.querySelector(".rw-problem-toggle");
    const details = first.querySelector(".rw-problem-details");
    assert.strictEqual(details.style.display, "none");
    toggle.click();
    assert.notStrictEqual(details.style.display, "none", "détail repliable ouvert");
    ok("Analyser → lignes groupées (une par type) + détail repliable");
}

// ═════════════════════════════════════════════════════════════════════════
// d) Cases à cocher + tout cocher / tout décocher
// ═════════════════════════════════════════════════════════════════════════
{
    const calls = [];
    const problems = [
        makeProblem("p1"),
        makeProblem("p2", { old_type: "HolafRemote", new_type: "AIHRemote", occurrences: [{ scope: "root", node_id: 1 }], count: 1 }),
    ];
    const { container, ctrl } = mount(makeApi(calls, { problems }));
    await flush();
    ctrl.setPasted("{}");
    await ctrl.analyze();
    await flush();

    const boxes = [...container.querySelectorAll(".rw-problem-check")];
    assert.strictEqual(boxes.length, 2);
    assert.ok(boxes.every((b) => b.checked), "tout coché par défaut (propositions)");

    // Tout décocher.
    const uncheckBtn = [...container.querySelectorAll(".rw-btn")].find((b) => /décocher|uncheck/i.test(b.textContent));
    assert.ok(uncheckBtn, "bouton tout décocher");
    uncheckBtn.click();
    assert.ok(boxes.every((b) => !b.checked), "tout décoché");
    assert.strictEqual(ctrl.state.selected.size, 0);

    // Tout cocher.
    const checkBtn = [...container.querySelectorAll(".rw-btn")].find((b) => /cocher|check all/i.test(b.textContent));
    checkBtn.click();
    assert.ok(boxes.every((b) => b.checked), "tout coché");
    assert.strictEqual(ctrl.state.selected.size, 2);
    ok("cases à cocher + tout cocher / tout décocher");
}

// ═════════════════════════════════════════════════════════════════════════
// e) Réparer n'applique QUE le coché
// ═════════════════════════════════════════════════════════════════════════
{
    const calls = [];
    const problems = [
        makeProblem("p1"),
        makeProblem("p2", { old_type: "HolafRemote", new_type: "AIHRemote", occurrences: [{ scope: "root", node_id: 1 }], count: 1 }),
    ];
    const { container, ctrl } = mount(makeApi(calls, { problems }));
    await flush();
    ctrl.setPasted("{}");
    await ctrl.analyze();
    await flush();

    // On DÉCOCHE p2.
    ctrl.setProblemChecked(false);
    const p1Box = container.querySelector('.rw-problem-check[data-problem-id="p1"]');
    p1Box.checked = true;
    p1Box.dispatchEvent(new domWindow.Event("change"));
    assert.deepStrictEqual([...ctrl.state.selected], ["p1"]);

    await ctrl.repair();
    await flush();
    const applyPreview = calls.filter((c) => c[0] === "apply").pop();
    assert.strictEqual(applyPreview[1].mode, "preview");
    assert.deepStrictEqual(applyPreview[1].selected, ["p1"], "seul le coché est appliqué");
    // Contrôle négatif : ne PAS envoyer tout.
    assert.notDeepStrictEqual(applyPreview[1].selected, ["p1", "p2"]);
    ok("Réparer n'applique que les actions cochées");
}

// ═════════════════════════════════════════════════════════════════════════
// f) Sortie selon la source : collé → Copier ; fichiers → Écraser
// ═════════════════════════════════════════════════════════════════════════
{
    // (f1) Collé seul → Copier visible, Écraser caché.
    const calls1 = [];
    const m1 = mount(makeApi(calls1));
    await flush();
    m1.ctrl.setPasted("{}");
    await m1.ctrl.analyze();
    await flush();
    await m1.ctrl.repair();
    await flush();
    assert.strictEqual(m1.container.querySelector("[data-rw-copy]").style.display, "", "Copier visible (JSON collé)");
    assert.strictEqual(m1.container.querySelector("[data-rw-overwrite]").style.display, "none", "Écraser caché (collé)");
    assert.strictEqual(m1.container.querySelector("[data-rw-saveas]").style.display, "", "Enregistrer sous visible");
    ok("JSON collé → Copier / Enregistrer sous");

    // (f2) Fichiers seuls → Écraser visible, Copier caché.
    const calls2 = [];
    const m2 = mount(makeApi(calls2));
    await flush();
    m2.ctrl.setCheckedFiles(["a.json"]);
    await m2.ctrl.analyze();
    await flush();
    await m2.ctrl.repair();
    await flush();
    assert.strictEqual(m2.container.querySelector("[data-rw-overwrite]").style.display, "", "Écraser visible (fichiers)");
    assert.strictEqual(m2.container.querySelector("[data-rw-copy]").style.display, "none", "Copier caché (fichiers)");
    ok("Fichiers sélectionnés → Écraser / Enregistrer sous");
}

// ═════════════════════════════════════════════════════════════════════════
// g) Copier / Enregistrer sous / Écraser → appels API corrects
// ═════════════════════════════════════════════════════════════════════════
{
    const calls = [];
    let copied = null;
    const { container, ctrl } = mount(makeApi(calls), {
        copyText: async (text) => { copied = text; },
        prompt: async () => "fixed.json",
        confirm: async () => true,
    });
    await flush();
    ctrl.setPasted("{}");
    await ctrl.analyze();
    await flush();
    await ctrl.repair();
    await flush();

    // Copier.
    container.querySelector("[data-rw-copy]").click();
    await flush();
    assert.ok(typeof copied === "string" && copied.includes("nodes"), "JSON réparé copié");

    // Enregistrer sous.
    container.querySelector("[data-rw-saveas]").click();
    await flush();
    const saveAs = calls.filter((c) => c[0] === "apply").pop();
    assert.strictEqual(saveAs[1].mode, "save_as");
    assert.strictEqual(saveAs[1].sources[0].save_as, "fixed.json");

    // Écraser (source fichier) : nouveau montage pour éviter le mélange.
    const calls2 = [];
    const m2 = mount(makeApi(calls2), { confirm: async () => true });
    await flush();
    m2.ctrl.setCheckedFiles(["a.json"]);
    await m2.ctrl.analyze();
    await flush();
    await m2.ctrl.repair();
    await flush();
    m2.container.querySelector("[data-rw-overwrite]").click();
    await flush();
    const overwrite = calls2.filter((c) => c[0] === "apply").pop();
    assert.strictEqual(overwrite[1].mode, "overwrite");
    assert.strictEqual(overwrite[1].sources[0].kind, "file");
    ok("Copier / Enregistrer sous / Écraser déclenchent les bons appels");
}

// ═════════════════════════════════════════════════════════════════════════
// h) Garde-fous : aucune source / aucune sélection
// ═════════════════════════════════════════════════════════════════════════
{
    const calls = [];
    const { ctrl, notifications } = mount(makeApi(calls));
    await flush();
    await ctrl.analyze();
    assert.ok(notifications.some(([m]) => /Sélectionnez|Select/i.test(m)), "message si aucune source");
    assert.strictEqual(calls.filter((c) => c[0] === "analyze").length, 0, "pas d'appel sans source");

    ctrl.setPasted("{}");
    await ctrl.analyze();
    await flush();
    ctrl.setProblemChecked(false);
    await ctrl.repair();
    await flush();
    assert.ok(notifications.some(([m]) => /Cochez|Check/i.test(m)), "message si aucune sélection");
    assert.strictEqual(calls.filter((c) => c[0] === "apply").length, 0, "pas d'apply sans sélection");
    ok("garde-fous : source obligatoire / sélection obligatoire");
}

console.log(`\n✅ test_aih_repair_workflow : ${n} groupes OK`);
