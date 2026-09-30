// Test de RÉGRESSION — « Source serveur non disponible dans cette version. »
// Usage : node js/test_iv_remote_registration.mjs
//
// Verrouille le correctif du signalement : dans la galerie du pack, cliquer
// sur « serveur » affichait le toast iv.sourceRemoteUnavailable alors que le
// serveur était configuré et connecté.
//
//   CAUSE : le provider 'remote' ne s'enregistrait QU'À l'évaluation du module
//   distant (au démarrage de ComfyUI). Une config enregistrée APRÈS le
//   démarrage — ou une clé masquée blanchie à la lecture (garde anti-masque)
//   — laissait `configured:true` / `hasProvider:false` → reason
//   'not-implemented' → toast trompeur.
//
//   1. i18n : clé iv.sourceRemoteMaskedKey présente FR/EN et explicite ;
//   2. import à froid SANS config → puis config valide → le provider
//      s'enregistre à la demande (sans redémarrer ComfyUI) et la bascule est
//      acceptée ;
//   3. clé masquée : jamais utilisable, jamais d'enregistrement, reason
//      'masked-key' + message précis (ressaisir la clé), aucun Bearer émis ;
//   4. cycle de configuration (valide → masque → valide) : le provider revient,
//      l'enregistrement est idempotent ;
//   5. échec d'enregistrement simulé : jamais d'exception propagée, refus
//      'not-implemented' propre.
//
// CONTRÔLES NÉGATIFS PAR MUTATION (le test doit passer au ROUGE si le
// correctif est retiré) :
//   M1 - supprimer l'appel refreshRemoteSourceRegistration() de getRemoteStatus
//        → la section 2 échoue (« hasProvider » reste false après config) ;
//   M2 - ne plus blanchir la clé masquée dans resolveConfig (affaiblir le
//        garde-fou anti-masque) → la section 3 échoue (clé non blanchie,
//        provider enregistré avec un masque, Bearer émis) ;
//   M3 - retirer le try/catch de refreshRemoteSourceRegistration → la
//        section 5 plante (exception non gérée du register simulé).
//
// jsdom est résolu par le loader partagé ; introuvable = SKIP bruyant (exit 2).
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_iv_remote_registration");

const dom = new JSDOM(`<!doctype html><html><body></body></html>`, {
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

// ── fetch factice : AUCUN réseau réel, compté pour prouver l'absence de Bearer.
let fetchCalls = 0;
globalThis.fetch = async (url, init = {}) => {
    fetchCalls++;
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
};
window.fetch = globalThis.fetch;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

const MASKED_KEY = "Clé masquée — clique sur « Régénérer » pour en afficher une nouvelle.";
const VALID = { serverUrl: "https://aih.example.com:8443", apiKey: "vraie-cle-utilisable-123" };
const setCfg = (cfg) => window.localStorage.setItem("AIH_config", JSON.stringify(cfg));

/* ─── 1. i18n : message précis anti-masque ─────────────────────────────── */
console.log("1. i18n");
await import("./aih_i18n.js");
await import("./aih_strings.js");
const I18n = window.AIH.I18n;
I18n.setLocale("fr");
const maskedMsgFr = I18n.t("iv.sourceRemoteMaskedKey");
assert.notStrictEqual(maskedMsgFr, "iv.sourceRemoteMaskedKey", "clé FR iv.sourceRemoteMaskedKey présente");
assert.ok(maskedMsgFr.includes("ressaisissez"), "FR : invite à ressaisir la clé");
assert.notStrictEqual(maskedMsgFr, I18n.t("iv.sourceRemoteUnavailable"), "message distinct du trompeur « non disponible »");
I18n.setLocale("en");
const maskedMsgEn = I18n.t("iv.sourceRemoteMaskedKey");
assert.notStrictEqual(maskedMsgEn, "iv.sourceRemoteMaskedKey", "clé EN présente");
assert.ok(maskedMsgEn.includes("re-enter"), "EN : invite à ressaisir la clé");
I18n.setLocale("fr");
ok("iv.sourceRemoteMaskedKey FR/EN, précis et distinct de iv.sourceRemoteUnavailable");

/* ─── 2. Import à froid (sans config) → config valide → rattrapage ─────── */
console.log("2. Enregistrement paresseux après configuration");
assert.strictEqual(window.localStorage.getItem("AIH_config"), null, "démarrage à froid : aucune config");

// L'import du module EST le moment « démarrage » (le provider tentait de
// s'enregistrer une seule fois, ici).
const remoteMod = await import("./image_viewer/image_viewer_source_remote.js");
const switchMod = await import("./image_viewer/image_viewer_source_switch.js");
const { GallerySource } = await import("./image_viewer/image_viewer_source.js");
const { getRemoteConfig, remoteRequest } = await import("./aih_fetch_bridge.js");

assert.strictEqual(remoteMod.isRemoteConfigured(), false, "au chargement : pas de config → non configuré");
assert.strictEqual(switchMod.getRemoteStatus().hasProvider, false, "au chargement : provider absent");
assert.strictEqual(remoteMod.ensureRemoteSourceRegistered(), false, "ensure refuse sans config");

// Config enregistrée APRÈS le démarrage (flux réel : Settings ▸ AIH · Compte).
setCfg(VALID);
const status = switchMod.getRemoteStatus();
assert.strictEqual(status.configured, true, "config valide → configured");
assert.strictEqual(status.hasProvider, true, "provider 'remote' enregistré à la demande (M1)");
assert.strictEqual(status.apiKeyMasked, false, "clé utilisable → pas de drapeau masque");
const decision = switchMod.evaluateSourceSwitch("remote");
assert.deepStrictEqual(decision, { ok: true, id: "remote", reason: null },
    "bascule acceptée immédiatement (avant correctif : 'not-implemented' + toast)");
assert.strictEqual(switchMod.refreshRemoteSourceRegistration(), true, "ré-enregistrement idempotent");
ok("import à froid + config après démarrage → provider enregistré, bascule acceptée");

/* ─── 3. Clé masquée : garde-fou intact + message précis ───────────────── */
console.log("3. Clé masquée (garde anti-masque, aucun affaiblissement)");
GallerySource.unregister("remote");
setCfg({ serverUrl: VALID.serverUrl, apiKey: MASKED_KEY });

const cfg = getRemoteConfig();
assert.strictEqual(cfg.apiKey, "", "la clé masquée est BLANCHIE (jamais retournée comme clé) (M2)");
assert.strictEqual(cfg.apiKeyMasked, true, "le drapeau apiKeyMasked est exposé");
const maskedStatus = switchMod.getRemoteStatus();
assert.strictEqual(maskedStatus.hasApiKey, false, "clé masquée ≠ clé utilisable");
assert.strictEqual(maskedStatus.configured, false, "clé masquée → non configuré");
assert.strictEqual(maskedStatus.hasProvider, false, "AUCUN provider enregistré avec une clé masquée (M2)");
assert.strictEqual(switchMod.refreshRemoteSourceRegistration(), false, "ensure refuse une clé masquée");
assert.deepStrictEqual(switchMod.evaluateSourceSwitch("remote"),
    { ok: false, id: "remote", reason: "masked-key" },
    "refus PRÉCIS 'masked-key' (et non 'not-implemented' / iv.sourceRemoteUnavailable)");

// Aucun Bearer ne doit partir avec un texte de masquage.
fetchCalls = 0;
await assert.rejects(
    () => remoteRequest("media"),
    (err) => {
        assert.strictEqual(err.name, "HolafFetchError");
        assert.strictEqual(err.status, 0);
        assert.strictEqual(err.data && err.data.code, "API_KEY_MASKED", "code d'erreur stable");
        return true;
    },
    "remoteRequest lève API_KEY_MASKED",
);
assert.strictEqual(fetchCalls, 0, "AUCUNE requête émise avec un masque (pas de Bearer) (M2)");
ok("clé masquée : blanchie, provider non enregistré, refus 'masked-key', zéro requête");

/* ─── 4. Cycle de configuration : idempotence du rattrapage ────────────── */
console.log("4. Cycle valide → masque → valide");
setCfg(VALID);
assert.strictEqual(switchMod.getRemoteStatus().hasProvider, true, "valide → provider de retour");
assert.strictEqual(switchMod.evaluateSourceSwitch("remote").ok, true, "bascule acceptée après retour au valide");
GallerySource.unregister("remote");
setCfg({ serverUrl: VALID.serverUrl, apiKey: MASKED_KEY });
assert.strictEqual(switchMod.getRemoteStatus().hasProvider, false, "masque → provider NON recréé");
setCfg(VALID);
assert.strictEqual(switchMod.getRemoteStatus().hasProvider, true, "valide → provider recréé");
assert.strictEqual(switchMod.evaluateSourceSwitch("remote").ok, true);
ok("cycle de configuration : le provider suit la clé utilisable (idempotent)");

/* ─── 5. Échec d'enregistrement simulé : jamais d'exception ────────────── */
console.log("5. Échec d'enregistrement (contrôle négatif M3)");
const originalRegister = GallerySource.register;
GallerySource.register = () => { throw new Error("register boom (simulation)"); };
try {
    GallerySource.unregister("remote");
    setCfg(VALID);
    let failingStatus;
    assert.doesNotThrow(() => { failingStatus = switchMod.getRemoteStatus(); },
        "un échec d'enregistrement ne doit jamais être propagé (M3)");
    assert.strictEqual(failingStatus.configured, true, "config toujours valide");
    assert.strictEqual(failingStatus.hasProvider, false, "provider absent après échec simulé");
    assert.strictEqual(switchMod.refreshRemoteSourceRegistration(), false, "refresh ne lève jamais");
    assert.strictEqual(switchMod.evaluateSourceSwitch("remote").reason, "not-implemented",
        "cas résiduel 'not-implemented' (échec d'enregistrement, plus « étape absente »)");
} finally {
    GallerySource.register = originalRegister;
}
// Récupération : l'enregistrement redevient possible sans redémarrage.
assert.strictEqual(GallerySource.has("remote"), false, "toujours absent après restauration");
assert.strictEqual(switchMod.refreshRemoteSourceRegistration(), true, "récupération immédiate");
assert.strictEqual(switchMod.evaluateSourceSwitch("remote").ok, true);
ok("échec simulé propre (catch) + récupération sans redémarrage");

/* ─── 6. Écoute « aih-credentials-changed » (galerie sans redémarrage) ─── */
console.log("6. Écoute de l'événement post-sauvegarde (holaf_image_viewer.js)");
// Stub comfyAPI : évite le poll de holaf_api_compat.js et enregistre l'ext.
window.comfyAPI = {
    app: { app: { registerExtension() {} } },
    api: { api: { api_base: "/" } },
};
await import("./holaf_image_viewer.js"); // effet de bord : pose l'écouteur document
globalThis.CustomEvent = window.CustomEvent;

GallerySource.unregister("remote");
setCfg(VALID);
assert.strictEqual(GallerySource.has("remote"), false, "provider retiré avant l'événement");
document.dispatchEvent(new window.CustomEvent("aih-credentials-changed", {
    detail: { serverUrl: VALID.serverUrl, hasUsableKey: true },
}));
assert.strictEqual(GallerySource.has("remote"), true,
    "sauvegarde de config → provider ré-enregistré immédiatement (sans redémarrage)");
assert.strictEqual(switchMod.evaluateSourceSwitch("remote").ok, true, "bascule de nouveau autorisée");
ok("événement aih-credentials-changed → source serveur de nouveau disponible");

await sleep(0);
console.log(`\n✅ Test régression enregistrement source serveur : ${n} groupes PASSENT`);

// jsdom (pretendToBeVisual) entretient une boucle rAF : terminer franchement.
dom.window.close();
process.exit(0);
