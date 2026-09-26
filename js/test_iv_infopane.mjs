// Test de NON-RÉGRESSION — volet d'infos de la galerie du node, délégué à la
// brique HolafInfoPane VENDUE (js/vendor/holaf/holaf-infopane.js).
// Usage : node js/test_iv_infopane.mjs
//
// image_viewer_infopane.js ne porte plus la mécanique générique (états, champs,
// blocs copiables, auto-resize, copie, annulation) : elle devient un ADAPTATEUR
// qui injecte dans la brique les libellés i18n, le preview synchrone, le
// resolve() métier (/holaf/images/metadata + sources) et la confirmation
// AIH.ask. Ce test rejoue le contrat d'adaptation et prouve la non-régression :
//   1. état vide initial (le message statique de l'UI est remplacé) ;
//   2. affichage immédiat du preview puis métadonnées (champs + résolution) ;
//   3. blocs prompt/workflow copiables (execCommand → « Copié ! ») ;
//   4. bouton « Load workflow » (AIH.ask puis comfyApp.loadGraphData) ;
//   5. erreur HTTP → « Erreur : <message du corps JSON> » ;
//   6. changement de sélection → abort de la requête précédente + nouvel
//      affichage (résolution périmée ignorée) ;
//   7. i18n FR → EN (les libellés injectés suivent la locale) ;
//   8. workflow absent → bouton désactivé + « Aucun workflow trouvé. » ;
//   9. mode déporté → holafBridge.send('LOAD_WORKFLOW', …).
//
// jsdom est résolu par le loader partagé ; introuvable = SKIP bruyant (exit 2).
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_iv_infopane");

const dom = new JSDOM(`<!doctype html><html><body>
  <div id="holaf-viewer-right-pane">
    <div id="holaf-viewer-info-content">
      <p class="holaf-viewer-message">placeholder UI</p>
    </div>
  </div>
</body></html>`, { pretendToBeVisual: true, url: "http://localhost/" });

const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;
globalThis.Element = window.Element;
globalThis.Event = window.Event;

// ─── AIH : seul ask() est stubé (les dictionnaires FR/EN réels sont
//     enregistrés par aih_strings.js, importé par le module testé). ───────
const askCalls = [];
let askResult = true;
window.AIH = {
    ask: async (opts) => { askCalls.push(opts); return askResult; },
};
globalThis.AIH = window.AIH;

// ─── ComfyUI app factice (chemin direct loadGraphData) ──────────────────────
const workflowLoads = [];
window.comfyAPI = {
    app: { app: { loadGraphData: (wf) => { workflowLoads.push(wf); } } },
    api: { api: {} },
};

// ─── fetch factice (HolafFetch utilise le fetch global) ─────────────────────
const fetchedUrls = [];
let fetchMode = "auto"; // "auto" = Response immédiate ; "pending" = promesses à résoudre
const pending = [];
let metadataByFile = {};
const metadataFor = (filename) => metadataByFile[filename] || {};

globalThis.fetch = (url, init) => {
    fetchedUrls.push({ url: String(url), signal: init && init.signal });
    if (fetchMode === "pending") {
        return new Promise((resolve, reject) => {
            pending.push({ url: String(url), init, resolve, reject });
            if (init && init.signal) {
                init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            }
        });
    }
    const filename = new URL(String(url)).searchParams.get("filename");
    const data = metadataFor(filename);
    if (data && data.__status) {
        return Promise.resolve(new Response(JSON.stringify(data.body || {}), {
            status: data.__status,
            headers: { "content-type": "application/json" },
        }));
    }
    return Promise.resolve(new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" },
    }));
};

// ─── Copie : execCommand capturé (la brique insère une textarea fixe) ───────
let copiedValue = null;
document.execCommand = () => {
    const fixed = Array.from(document.querySelectorAll("textarea")).filter((ta) => ta.style.position === "fixed");
    copiedValue = fixed.length ? fixed[fixed.length - 1].value : null;
    return true;
};

const infopane = await import("./image_viewer/image_viewer_infopane.js");
const { imageViewerState } = await import("./image_viewer/image_viewer_state.js");
const { holafBridge } = await import("./holaf_comfy_bridge.js");

// jsdom expose navigator.language = en-US → on force le FR (défaut du pack)
// pour la première partie du test ; la bascule EN est testée à l'étape 7.
window.AIH.I18n.setLocale("fr");

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };
const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 20; i++) await Promise.resolve();
};

// ─── Items + métadonnées ────────────────────────────────────────────────────
const items = [];
for (let i = 1; i <= 6; i++) {
    items.push({
        path_canon: "p" + i,
        filename: "f" + i + ".png",
        subfolder: "galerie",
        size_bytes: 1048576 * i,
        format: "PNG",
        mtime: 1700000000 + i,
    });
}
const wfFor = (i) => ({ nodes: [{ id: i, type: "KSampler" }], links: [] });
metadataByFile = {
    "f1.png": { width: 800, height: 600, ratio: "4:3", prompt: "un chat sur un tapis", prompt_source: "internal_png", workflow: wfFor(1), workflow_source: "internal_png" },
    "f2.png": { width: 640, height: 480, prompt: "erreur", prompt_source: "external_txt" },
    "f3.png": { width: 1024, height: 1024, prompt: "pending A", prompt_source: "external_json", workflow: wfFor(3), workflow_source: "external_json" },
    "f4.png": { width: 100, height: 100, prompt: "pending B", prompt_source: "internal_png", workflow: wfFor(4), workflow_source: "internal_png" },
    "f5.png": { width: 512, height: 512, prompt: "sans workflow", prompt_source: "internal_png" },
    "f6.png": { width: 256, height: 256 },
};

const container = document.getElementById("holaf-viewer-info-content");
const paneEl = () => container.querySelector(".holaf-infopane");
const textareas = () => Array.from(container.querySelectorAll("textarea.holaf-infopane-text"));
const buttons = () => Array.from(container.querySelectorAll("button"));

// ─── 1. État vide initial (message statique remplacé) ───────────────────────
infopane.setupInfoPane();
assert.equal(container.querySelectorAll(".holaf-viewer-message").length, 0, "message statique UI remplacé");
assert.ok(paneEl(), "racine de la brique créée");
assert.equal(paneEl().getAttribute("data-state"), "empty", "état vide");
assert.ok(container.textContent.includes("Sélectionnez une image"), "libellé FR vide");
ok("état vide initial (libellés injectés, message statique remplacé)");

// ─── 2. Preview immédiat + métadonnées résolues ─────────────────────────────
imageViewerState.setState({ activeImage: items[0] });
assert.ok(container.textContent.includes("f1.png"), "preview synchrone (nom du fichier)");
assert.ok(container.textContent.includes("1.00 MB"), "preview synchrone (taille)");
await flush();
{
    const url = fetchedUrls[fetchedUrls.length - 1].url;
    assert.ok(url.includes("/holaf/images/metadata"), "endpoint metadata appelé");
    assert.ok(url.includes("filename=f1.png"), "filename passé en query");
    assert.ok(url.includes("subfolder=galerie"), "subfolder passé en query");
    assert.ok(container.textContent.includes("Résolution"), "champ résolution");
    assert.ok(container.textContent.includes("800x600 px"), "valeur résolution");
    assert.ok(container.textContent.includes("Ratio"), "champ ratio");
    assert.equal(textareas().length, 2, "blocs prompt + workflow (2 textarea)");
    assert.equal(textareas()[0].value, "un chat sur un tapis", "texte du prompt");
    assert.equal(textareas()[1].value, JSON.stringify(wfFor(1), null, 2), "texte du workflow (JSON)");
    assert.ok(container.textContent.includes("(depuis PNG)"), "badge source");
    assert.ok(container.textContent.includes("Prompt"), "label prompt");
    ok("affichage infos : preview synchrone puis métadonnées (champs + blocs)");
}

// ─── 3. Copie du prompt et du workflow (confirmation « Copié ! ») ───────────
{
    const copyButtons = () => Array.from(container.querySelectorAll(".holaf-infopane-copy-button"));
    assert.ok(copyButtons()[0].textContent.includes("Copier le prompt"), "libellé copie prompt FR");
    copiedValue = null;
    copyButtons()[0].click();
    await flush();
    assert.equal(copiedValue, "un chat sur un tapis", "prompt copié via execCommand");
    assert.equal(copyButtons()[0].textContent, "Copié !", "confirmation copie");
    copiedValue = null;
    copyButtons()[1].click();
    await flush();
    assert.equal(copiedValue, JSON.stringify(wfFor(1), null, 2), "workflow copié");
    assert.equal(copyButtons()[1].textContent, "Copié !", "confirmation copie workflow");
    ok("copie prompt + workflow (execCommand → « Copié ! »)");
}

// ─── 4. Bouton « Load workflow » (AIH.ask puis loadGraphData) ───────────────
{
    const loadBtn = buttons().find((b) => b.textContent.includes("Charger le workflow"));
    assert.ok(loadBtn && !loadBtn.disabled, "bouton Load workflow activé");
    loadBtn.click();
    await flush();
    assert.equal(askCalls.length, 1, "AIH.ask appelé pour confirmer");
    assert.equal(askCalls[0].title, "Charger le workflow", "titre i18n de confirmation");
    assert.deepEqual(askCalls[0].buttons.map((b) => b.value), [false, true], "boutons Annuler/Charger");
    assert.equal(workflowLoads.length, 1, "loadGraphData appelé");
    assert.deepEqual(workflowLoads[0], wfFor(1), "workflow transmis intact");
    ok("bouton « Load workflow » (confirmation AIH.ask → comfyApp.loadGraphData)");
}

// ─── 5. Erreur HTTP → message du corps JSON ─────────────────────────────────
{
    metadataByFile["f2.png"] = { __status: 400, body: { error: "boom métier" } };
    imageViewerState.setState({ activeImage: items[1] });
    await flush();
    assert.equal(paneEl().getAttribute("data-state"), "error", "état erreur");
    assert.ok(container.textContent.includes("Erreur : boom métier"), "message d'erreur du corps JSON");
    ok("erreur HTTP → « Erreur : <message du corps JSON> »");
}

// ─── 6. Changement de sélection → abort + nouvel affichage ──────────────────
{
    fetchMode = "pending";
    pending.length = 0;
    imageViewerState.setState({ activeImage: items[2] }); // f3
    await flush();
    assert.equal(pending.length, 1, "requête f3 en vol");
    assert.equal(pending[0].init.signal.aborted, false, "signal f3 actif");
    assert.ok(container.textContent.includes("f3.png"), "preview f3 affiché");

    imageViewerState.setState({ activeImage: items[3] }); // f4
    await flush();
    assert.equal(pending[0].init.signal.aborted, true, "requête f3 abortée au changement d'item");
    assert.equal(pending.length, 2, "requête f4 en vol");
    assert.ok(container.textContent.includes("f4.png"), "preview f4 affiché");

    // f4 répond : le panneau affiche f4.
    pending[1].resolve(new Response(JSON.stringify(metadataFor("f4.png")), { status: 200, headers: { "content-type": "application/json" } }));
    await flush();
    assert.equal(textareas()[0].value, "pending B", "contenu f4 affiché");

    // f3 répond en retard : ignoré (résolution périmée).
    pending[0].resolve(new Response(JSON.stringify(metadataFor("f3.png")), { status: 200, headers: { "content-type": "application/json" } }));
    await flush();
    assert.equal(textareas()[0].value, "pending B", "résolution périmée ignorée");
    fetchMode = "auto";
    ok("changement de sélection → abort + nouvel affichage (périmé ignoré)");
}

// ─── 7. i18n : FR → EN (libellés injectés suivent la locale) ────────────────
{
    window.AIH.I18n.setLocale("en");
    imageViewerState.setState({ activeImage: items[4] }); // f5
    await flush();
    const copyBtn = container.querySelector(".holaf-infopane-copy-button");
    assert.ok(copyBtn.textContent.includes("Copy Prompt"), "libellé copie EN");
    assert.ok(container.textContent.includes("Resolution"), "champ résolution EN");
    window.AIH.I18n.setLocale("fr");
    ok("i18n FR/EN : libellés recalculés à la sélection suivante");
}

// ─── 8. Prompt et workflow absents → boutons désactivés + messages dédiés ──
{
    // Re-sélection en FR (f6 : ni prompt, ni workflow).
    imageViewerState.setState({ activeImage: items[5] });
    await flush();
    const loadBtn = buttons().find((b) => b.textContent.includes("Charger le workflow"));
    assert.ok(loadBtn && loadBtn.disabled, "bouton Load workflow désactivé");
    assert.ok(container.textContent.includes("Aucun workflow trouvé"), "message workflow absent");
    const copyBtn = container.querySelector(".holaf-infopane-copy-button");
    assert.ok(copyBtn && copyBtn.disabled, "bouton copie prompt désactivé (prompt vide)");
    assert.ok(container.textContent.includes("Indisponible."), "message prompt indisponible");
    ok("prompt/workflow absents → boutons désactivés + messages dédiés");
}

// ─── 9. Mode déporté → holafBridge.send('LOAD_WORKFLOW') ────────────────────
{
    const sent = [];
    holafBridge.send = (type, payload) => { sent.push({ type, payload }); };
    // Plus de loadGraphData : bascule sur le bridge (même objet comfyApp).
    delete window.comfyAPI.app.app.loadGraphData;
    imageViewerState.setState({ activeImage: items[0] }); // f1 (re-sélection)
    await flush();
    const loadBtn = buttons().find((b) => b.textContent.includes("Charger le workflow"));
    assert.ok(loadBtn && !loadBtn.disabled, "bouton réactivé pour f1");
    loadBtn.click();
    await flush();
    assert.equal(sent.length, 1, "message bridge envoyé");
    assert.equal(sent[0].type, "LOAD_WORKFLOW", "type LOAD_WORKFLOW");
    assert.deepEqual(sent[0].payload, wfFor(1), "workflow transmis au bridge");
    ok("mode déporté → holafBridge.send('LOAD_WORKFLOW')");
}

console.log(`\n✅ Test non-régression volet d'infos (HolafInfoPane) : ${n} groupes PASS`);
process.exit(0);
