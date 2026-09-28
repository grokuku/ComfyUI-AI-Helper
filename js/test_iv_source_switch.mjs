// Test de l'ÉTAPE 1 — switch de source de la galerie « Local | Serveur ».
// Usage : node js/test_iv_source_switch.mjs
//
// Verrouille, SANS implémenter le provider serveur :
//   1. i18n FR/EN : parité stricte + libellés du switch présents des 2 côtés ;
//   2. persistance : défaut 'local', clé absente → 'local', clé invalide →
//      'local', 'remote' chargé tel quel ; save-settings POSTe gallery_source ;
//   3. module de bascule (image_viewer_source_switch.js) : normalisation,
//      garde-fou « serveur non configuré » ('not-configured'), refus temporaire
//      « provider remote absent » ('not-implemented'), exécution réelle avec un
//      provider factice (arrêt du poll, reset état/sélection, setActive +
//      ré-ancrage collection, persistance, rechargement), no-op sans effet ;
//   4. UI (jsdom) : groupe « Source » EN TÊTE du pane gauche, sélection par
//      défaut = Local, option Serveur GRISÉE sans serveur configuré (+ guidage
//      AIH), clic refusé proprement avec message quand le serveur est configuré
//      mais l'étape 2 absente, indice de l'hôte serveur si source = remote ;
//   5. contrôles négatifs : apply('remote') sans provider → aucun état modifié
//      (activeId, gallery_source) ; reconcilier une valeur persistée 'remote'
//      indisponible → repli 'local' persisté.
//
// jsdom est résolu par le loader partagé ; introuvable = SKIP bruyant (exit 2).
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_iv_source_switch");

const dom = new JSDOM(`<!doctype html><html><body><div id="iv-ui-root"></div></body></html>`, {
    pretendToBeVisual: true,
    url: "http://localhost/",
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Event = window.Event;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.MouseEvent = window.MouseEvent;

// ── fetch factice : capture (url, init) et renvoie du JSON ────────────────
const requests = [];
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
let settingsPayload = {};
globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).includes("/holaf/utilities/settings")) {
        return jsonResponse({ ImageViewerUI: settingsPayload });
    }
    return jsonResponse({ ok: true });
};
window.fetch = globalThis.fetch;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

/* ─── 1. i18n : capture AVANT tout import d'aih_strings.js ─────────────── */
console.log("1. i18n FR/EN");
await import("./aih_i18n.js");
const I18n = window.AIH.I18n;
I18n.setLocale("fr"); // jsdom navigator.language = en-US → FR explicite pour le test
const captured = {};
const origAddDict = I18n.addDict.bind(I18n);
I18n.addDict = (lang, entries) => {
    captured[lang] = Object.assign(captured[lang] || {}, entries);
    return origAddDict(lang, entries);
};
await import("./aih_strings.js");

const SOURCE_KEYS = [
    "iv.source", "iv.sourceLocal", "iv.sourceRemote", "iv.sourceRemoteTitle",
    "iv.sourceRemoteDisabled", "iv.sourceRemoteUnavailable", "iv.sourceRemoteHost",
    "iv.sourceSwitchError",
];
for (const key of SOURCE_KEYS) {
    assert.ok(captured.fr && key in captured.fr, `clé ${key} absente en FR`);
    assert.ok(captured.en && key in captured.en, `clé ${key} absente en EN`);
}
assert.strictEqual(captured.fr["iv.sourceLocal"], "Local");
assert.strictEqual(captured.fr["iv.sourceRemote"], "Serveur");
assert.strictEqual(captured.en["iv.sourceRemote"], "Server");
assert.ok(captured.fr["iv.sourceRemoteHost"].includes("{host}"), "placeholder {host} FR");
assert.ok(captured.en["iv.sourceRemoteHost"].includes("{host}"), "placeholder {host} EN");
assert.ok(captured.fr["iv.sourceSwitchError"].includes("{message}"), "placeholder {message} FR");
assert.ok(captured.en["iv.sourceSwitchError"].includes("{message}"), "placeholder {message} EN");

const frKeys = Object.keys(captured.fr || {});
const enKeys = Object.keys(captured.en || {});
const onlyFr = frKeys.filter((k) => !(k in (captured.en || {})));
const onlyEn = enKeys.filter((k) => !(k in (captured.fr || {})));
assert.deepStrictEqual(onlyFr, [], `clés FR absentes en EN : ${onlyFr.join(", ")}`);
assert.deepStrictEqual(onlyEn, [], `clés EN absentes en FR : ${onlyEn.join(", ")}`);
assert.strictEqual(frKeys.length, enKeys.length, `FR=${frKeys.length} EN=${enKeys.length}`);
ok(`libellés du switch FR+EN + parité stricte (${frKeys.length} clés)`);

/* ─── 2. Persistance (settings) ────────────────────────────────────────── */
console.log("2. Persistance gallery_source");
const { loadSettings, saveSettings } = await import("./image_viewer/image_viewer_settings.js");
const { imageViewerState } = await import("./image_viewer/image_viewer_state.js");
const { GallerySource } = await import("./image_viewer/image_viewer_source.js");
const switchMod = await import("./image_viewer/image_viewer_source_switch.js");

const fakeViewer = {
    settings: {},
    zoomViewState: {},
    gallery: null,
    savedSettings: [],
    reloadCalls: 0,
    saveSettings(s) { this.savedSettings.push(s); },
    async loadAndPopulateFilters() { this.reloadCalls++; },
    _applyThumbnailFit() {},
    _applyThumbnailSize() {},
    _hideZoomedView() {},
    _showFullscreenView() {},
};

assert.strictEqual(imageViewerState.getState().ui.gallery_source, "local", "défaut état = 'local'");

settingsPayload = {};
await loadSettings(fakeViewer);
assert.strictEqual(imageViewerState.getState().ui.gallery_source, "local", "clé absente → 'local'");

settingsPayload = { gallery_source: "remote" };
await loadSettings(fakeViewer);
assert.strictEqual(imageViewerState.getState().ui.gallery_source, "remote", "'remote' chargé");

settingsPayload = { gallery_source: "n'importe quoi" };
await loadSettings(fakeViewer);
assert.strictEqual(imageViewerState.getState().ui.gallery_source, "local", "valeur invalide → 'local'");

// Enregistrement : le POST save-settings doit contenir gallery_source.
requests.length = 0;
saveSettings(fakeViewer, { gallery_source: "local" });
await sleep(900); // debounce interne = 750 ms
const savePost = requests.find((r) => r.url.includes("/holaf/image-viewer/save-settings"));
assert.ok(savePost, "POST /holaf/image-viewer/save-settings émis");
assert.strictEqual(JSON.parse(savePost.init.body).gallery_source, "local", "gallery_source envoyé au backend");
assert.strictEqual(imageViewerState.getState().ui.gallery_source, "local", "état mis à jour par saveSettings");
ok("load (absent/invalide → local, remote préservé) + save POSTe gallery_source");

/* ─── 3. Module de bascule : normalisation + garde-fous ────────────────── */
console.log("3. Garde-fous du switch");
assert.strictEqual(switchMod.normalizeSourceId(undefined), "local");
assert.strictEqual(switchMod.normalizeSourceId(""), "local");
assert.strictEqual(switchMod.normalizeSourceId("bogus"), "local");
assert.strictEqual(switchMod.normalizeSourceId("remote"), "remote");
assert.strictEqual(switchMod.normalizeSourceId("local"), "local");

window.localStorage.removeItem("AIH_config");
let remote = switchMod.getRemoteStatus();
assert.strictEqual(remote.configured, false, "sans config → non configuré");
assert.strictEqual(remote.hasProvider, false, "provider remote non enregistré (étape 1)");
let decision = switchMod.evaluateSourceSwitch("remote");
assert.strictEqual(decision.ok, false);
assert.strictEqual(decision.reason, "not-configured", "refus : serveur non configuré");
assert.strictEqual(switchMod.evaluateSourceSwitch("local").ok, true, "local toujours autorisé");

// serverUrl sans token → considéré non configuré (token requis).
window.localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "https://aih.example.com:8443", apiKey: "" }));
assert.strictEqual(switchMod.getRemoteStatus().configured, false, "serverUrl sans token → non configuré");

// serverUrl + token → configuré, mais provider absent (étape 2 non livrée).
window.localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "https://aih.example.com:8443", apiKey: "tok" }));
assert.strictEqual(switchMod.getRemoteStatus().configured, true, "serverUrl + token → configuré");
decision = switchMod.evaluateSourceSwitch("remote");
assert.strictEqual(decision.ok, false);
assert.strictEqual(decision.reason, "not-implemented", "refus temporaire : provider remote absent");
ok("normalisation + 'not-configured' (sans token) + 'not-implemented' (étape 2 absente)");

// Indice d'hôte (affichage).
assert.strictEqual(switchMod.describeRemoteHost("https://aih.example.com:8443/"), "aih.example.com:8443");
assert.strictEqual(switchMod.describeRemoteHost(""), "");
const longHost = switchMod.describeRemoteHost("https://" + "a".repeat(80) + ".com");
assert.ok(longHost.endsWith("…") && longHost.length <= 40, "hôte long tronqué");
ok("describeRemoteHost (protocole retiré, troncature)");

/* ─── 4. applySourceSwitch avec un provider factice ────────────────────── */
console.log("4. Exécution de la bascule (provider factice)");
let dummyCreates = 0;
GallerySource.register("remote", {
    id: "remote",
    label: "Server",
    createCollection() {
        dummyCreates++;
        return {
            bindState() {}, resetWindowCache() {}, windowStart() { return 0; },
            isWindowLoaded() { return false; }, isWindowLoading() { return false; },
            getLoadingPromise() { return null; }, registerLoading() {}, unregisterLoading() {},
            at() { return null; }, forEachLoaded() {}, insertTop() { return []; },
            removeByIds() { return []; }, missingStarts() { return []; }, setWindow() {},
        };
    },
});
assert.strictEqual(switchMod.getRemoteStatus().hasProvider, true, "provider factice visible du garde-fou");

fakeViewer.filterRefreshIntervalId = 111;
fakeViewer.statsRefreshIntervalId = 222;
fakeViewer.filterDebounceTimer = 333;
fakeViewer._showCheckTimer = 444;
fakeViewer._statsDeferTimer = 555;
fakeViewer._resyncDebounceTimer = 666;
fakeViewer._statsDeferralScheduled = true;
imageViewerState.setState({
    images: [{}], totalCount: 5,
    selectedImages: new Set([{ path_canon: "a" }]),
    activeImage: {}, currentNavIndex: 2,
    status: { lastDbUpdateTime: 42 },
});

const applied = await switchMod.applySourceSwitch(fakeViewer, "remote");
assert.strictEqual(applied.ok, true, "bascule acceptée avec provider");
assert.strictEqual(applied.id, "remote");
assert.strictEqual(GallerySource.activeId(), "remote", "registre basculé");
assert.strictEqual(dummyCreates, 1, "collection ré-ancrée sur le nouveau provider");
assert.strictEqual(fakeViewer.filterRefreshIntervalId, null, "poll arrêté");
assert.strictEqual(fakeViewer.statsRefreshIntervalId, null, "poll stats arrêté");
assert.strictEqual(fakeViewer.filterDebounceTimer, null);
assert.strictEqual(fakeViewer._showCheckTimer, null);
assert.strictEqual(fakeViewer._statsDeferTimer, null);
assert.strictEqual(fakeViewer._resyncDebounceTimer, null);
assert.strictEqual(fakeViewer._statsDeferralScheduled, false);
const appliedState = imageViewerState.getState();
assert.strictEqual(appliedState.images.length, 0, "images vidées");
assert.strictEqual(appliedState.totalCount, 0);
assert.strictEqual(appliedState.selectedImages.length, 0, "sélection reset");
assert.strictEqual(appliedState.activeImage, null);
assert.strictEqual(appliedState.currentNavIndex, -1);
assert.strictEqual(appliedState.status.lastDbUpdateTime, 0, "baseline poll reset");
assert.strictEqual(appliedState.ui.gallery_source, "remote", "état source mis à jour");
assert.strictEqual(fakeViewer.savedSettings.at(-1).gallery_source, "remote", "persistance demandée");
assert.strictEqual(fakeViewer.reloadCalls, 1, "filtres + liste rechargés");

// Déjà sur la source cible → no-op STRICT (aucun effet de bord).
const savedCount = fakeViewer.savedSettings.length;
const reloadCount = fakeViewer.reloadCalls;
const creations = dummyCreates;
const noop = await switchMod.applySourceSwitch(fakeViewer, "remote");
assert.strictEqual(noop.ok, true);
assert.strictEqual(noop.noop, true);
assert.strictEqual(fakeViewer.savedSettings.length, savedCount, "no-op ne sauvegarde pas");
assert.strictEqual(fakeViewer.reloadCalls, reloadCount, "no-op ne recharge pas");
assert.strictEqual(dummyCreates, creations, "no-op ne recrée pas la collection");

// Retour local (provider réel) → registre + état cohérents.
const back = await switchMod.applySourceSwitch(fakeViewer, "local");
assert.strictEqual(back.ok, true);
assert.strictEqual(GallerySource.activeId(), "local");
assert.strictEqual(imageViewerState.getState().ui.gallery_source, "local");
ok("bascule complète (poll/état/sélection/collection/persistance/reload) + no-op + retour local");

// Contrôle négatif : refus 'not-implemented' → AUCUNE modification d'état.
GallerySource.unregister("remote");
imageViewerState.setState({ ui: { gallery_source: "local" }, images: [{}], selectedImages: new Set([{ path_canon: "x" }]) });
const refused = await switchMod.applySourceSwitch(fakeViewer, "remote");
assert.strictEqual(refused.ok, false);
assert.strictEqual(refused.reason, "not-implemented");
assert.strictEqual(GallerySource.activeId(), "local", "registre inchangé après refus");
assert.strictEqual(imageViewerState.getState().ui.gallery_source, "local", "état inchangé après refus");
assert.strictEqual(imageViewerState.getState().selectedImages.length, 1, "sélection préservée après refus");
ok("refus propre de la bascule 'remote' sans provider (aucun état modifié)");

/* ─── 5. reconcileStoredSource (valeur persistée au démarrage) ─────────── */
console.log("5. Réconciliation au démarrage");
let rec = await switchMod.reconcileStoredSource(fakeViewer);
assert.strictEqual(rec.noop, true, "source locale → no-op");

imageViewerState.setState({ ui: { gallery_source: "remote" } });
window.localStorage.removeItem("AIH_config");
fakeViewer.savedSettings.length = 0;
rec = await switchMod.reconcileStoredSource(fakeViewer);
assert.strictEqual(rec.fallback, true, "'remote' indisponible → repli");
assert.strictEqual(rec.reason, "not-configured");
assert.strictEqual(rec.id, "local");
assert.strictEqual(imageViewerState.getState().ui.gallery_source, "local", "état replié sur local");
assert.strictEqual(fakeViewer.savedSettings.at(-1).gallery_source, "local", "repli persisté");
ok("'remote' persisté indisponible → repli 'local' + persistance du repli");

/* ─── 6. UI : groupe Source EN TÊTE + garde-fou + refus + indice ───────── */
console.log("6. UI (pane gauche)");
window.localStorage.removeItem("AIH_config");
imageViewerState.setState({ ui: { gallery_source: "local" } });

const { UI } = await import("./image_viewer/image_viewer_ui.js");
const { HolafToast } = await import("./vendor/holaf/holaf-toast.js");
const toasts = [];
HolafToast.show = (opts) => { toasts.push(opts); return { dismiss() {} }; };

// Le pane est construit une fois (libellés statiques figés à la création,
// comme les autres libellés du pane) : on le reconstruit pour tester EN.
function buildUI() {
    UI.init(document.getElementById("iv-ui-root"), {
        getViewer: () => fakeViewer,
        onFilterChange: () => {},
        onResetFilters: () => {},
    });
    return {
        leftPane: document.getElementById("holaf-viewer-left-pane"),
        title: document.getElementById("holaf-viewer-source-title"),
        local: document.getElementById("holaf-viewer-source-local"),
        remote: document.getElementById("holaf-viewer-source-remote"),
        note: document.getElementById("holaf-viewer-source-note"),
    };
}

let el = buildUI();
assert.ok(el.leftPane, "pane gauche créé");
assert.strictEqual(el.leftPane.firstElementChild.id, "holaf-viewer-source-group",
    "le groupe Source est EN TÊTE du pane gauche (avant la recherche)");
assert.strictEqual(el.title.textContent, "Source", "titre FR");
assert.strictEqual(el.local.textContent, "Local");
assert.strictEqual(el.remote.textContent, "Serveur");

// Défaut = local, option Serveur DÉSACTIVÉE (serveur non configuré) + guidage AIH.
assert.ok(el.local.classList.contains("active"), "Local sélectionné par défaut");
assert.ok(!el.remote.classList.contains("active"), "Serveur non sélectionné");
assert.strictEqual(el.remote.disabled, true, "option Serveur grisée sans config");
assert.strictEqual(el.remote.title, I18n.t("iv.sourceRemoteDisabled"), "tooltip guidage AIH");
assert.strictEqual(el.note.textContent, I18n.t("iv.sourceRemoteDisabled"), "note guidage AIH visible");
ok("groupe Source en tête, défaut Local, Serveur désactivé + guidage AIH");

// i18n : panneau reconstruit en EN → libellés + guidage suivent la locale.
I18n.setLocale("en");
el = buildUI();
assert.strictEqual(el.remote.textContent, "Server", "libellé EN");
assert.strictEqual(el.note.textContent, I18n.t("iv.sourceRemoteDisabled"), "guidage EN");
assert.ok(el.note.textContent.includes("Server not configured"), "guidage EN réel");
I18n.setLocale("fr");
el = buildUI();
ok("libellés/guidage i18n : panneau reconstruit FR → EN → FR");

// Serveur configuré mais étape 2 absente : option activée, clic → refus + message.
window.localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "https://aih.example.com:8443", apiKey: "tok" }));
UI._render(imageViewerState.getState());
assert.strictEqual(el.remote.disabled, false, "serveur configuré → option activée");
assert.strictEqual(el.note.textContent, I18n.t("iv.sourceRemoteUnavailable"), "note étape 2 absente");
toasts.length = 0;
el.remote.click();
await sleep(20);
assert.strictEqual(toasts.length, 1, "un message de refus affiché");
assert.strictEqual(toasts[0].message, I18n.t("iv.sourceRemoteUnavailable"), "message de refus explicite");
assert.strictEqual(toasts[0].type, "warning");
assert.strictEqual(imageViewerState.getState().ui.gallery_source, "local", "état reste local après refus");
assert.strictEqual(GallerySource.activeId(), "local", "registre reste local après refus");
assert.ok(el.local.classList.contains("active"), "contrôle resynchronisé sur Local");
ok("clic Serveur (configuré, étape 2 absente) → toast de refus + état inchangé");

// Cas limite : tentative programmée sans config (UI périmée) → refus 'not-configured'.
window.localStorage.removeItem("AIH_config");
toasts.length = 0;
const stale = await switchMod.applySourceSwitch(fakeViewer, "remote");
assert.strictEqual(stale.ok, false);
assert.strictEqual(stale.reason, "not-configured");
assert.strictEqual(GallerySource.activeId(), "local");
assert.strictEqual(toasts.length, 0, "applySourceSwitch ne notifie pas (l'UI porte le message)");
ok("cas limite : bascule programmée sans config → refus, aucun crash");

// Indice de l'hôte serveur quand la source active est 'remote'.
GallerySource.register("remote", { id: "remote", label: "Server", createCollection() { return { bindState() {} }; } });
imageViewerState.setState({ ui: { gallery_source: "remote" } });
window.localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "https://aih.example.com:8443", apiKey: "tok" }));
UI._render(imageViewerState.getState());
assert.ok(el.remote.classList.contains("active"), "Serveur actif affiché");
assert.strictEqual(el.note.textContent, I18n.t("iv.sourceRemoteHost", { host: "aih.example.com:8443" }),
    "indice d'hôte serveur affiché");
assert.ok(el.note.textContent.includes("aih.example.com:8443"));
GallerySource.unregister("remote");
imageViewerState.setState({ ui: { gallery_source: "local" } });
UI._render(imageViewerState.getState());
ok("indice discret de l'hôte serveur quand la source active est remote");

console.log(`\n✅ Test switch de source galerie (étape 1) : ${n} groupes PASSENT`);
