// Test — APERÇU VIDÉO AU SURVOL en source SERVEUR (même principe que le local).
// Usage : node js/test_iv_remote_video_preview.mjs
//
// Verrouille la demande « reproduire le principe d'animation au survol de la
// galerie locale » pour la galerie SERVEUR du pack, SANS appels réseau réels :
//   1. la source serveur (et locale) déclarent capabilities.videoPreview ;
//   2. resolvePreviewMediaUrl(vidéo) → blob via /download (Bearer) + objectURL ;
//   3. CACHE LOCAL borné : un 2e survol du MÊME média réutilise l'objectURL
//      (AUCUN nouveau fetch) ; clearPreviewCache() révoque et vide ;
//   4. image → délègue à resolveMediaUrl (plein média) ; local → chaîne URL ;
//   5. NON-RÉGRESSION : resolveMediaUrl(vidéo) REFUSE toujours (plein écran) ;
//   6. annulation (signal) → AbortError, aucun fetch.
//
// Contrôles négatifs par mutation (l'assertion échoue si on retire la logique) :
//   M1 retirer le cache → le 2e survol refetch (assert de compteur) ;
//   M2 retirer l'autorisation vidéo → le test 2 échoue ;
//   M3 ne pas révoquer au clear → revokedUrls ne grandit pas.
//
// jsdom est résolu par le loader partagé ; introuvable = SKIP bruyant (exit 2).
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_iv_remote_video_preview");

const dom = new JSDOM(`<!doctype html><html><body></body></html>`, {
    url: "http://localhost/",
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.localStorage = window.localStorage;

// jsdom n'implémente pas createObjectURL → stub + compteurs (fuite).
const createdUrls = [];
const revokedUrls = [];
globalThis.URL.createObjectURL = () => {
    const u = `blob:mock-${createdUrls.length + 1}`;
    createdUrls.push(u);
    return u;
};
globalThis.URL.revokeObjectURL = (u) => { revokedUrls.push(u); };

const SERVER_URL = "https://aih.example.com:8443";
localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: SERVER_URL, apiKey: "tok-999" }));

// Fetch factice : compte les téléchargements, renvoie un binaire.
const downloads = [];
globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/download")) {
        downloads.push({ url: u, auth: (init.headers && (init.headers.Authorization || init.headers.authorization)) || "" });
        return new Response(new Blob([new Uint8Array([1, 2, 3, 4, 5, 6])]), { status: 200, headers: { "content-type": "video/mp4" } });
    }
    throw new Error(`Unexpected fetch: ${u}`);
};

const remoteMod = await import("./image_viewer/image_viewer_source_remote.js");
const { GallerySource } = await import("./image_viewer/image_viewer_source.js");

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

function mediaItem(over = {}) {
    return remoteMod.normalizeItem({
        id: 1, filename: "srv1.mp4", subfolder: "dossier", size: 2097152,
        created_at: "2024-05-01T10:00:00Z", kind: "video", favorite: false,
        tags: [], has_prompt: false, has_workflow: false, status: "complete", trashed: false, ...over,
    });
}

/* ── 1. Capacités ───────────────────────────────────────────────────────── */
console.log("1. capabilities.videoPreview");
const provider = remoteMod.createRemoteSource();
assert.strictEqual(provider.capabilities.videoPreview, true, "remote : videoPreview activé");
assert.strictEqual(provider.capabilities.mediaPlayback, false, "remote : plein média vidéo toujours refusé");
assert.strictEqual(GallerySource.active().capabilities.videoPreview, true, "local : videoPreview activé");
ok("videoPreview déclaré par les deux sources (mediaPlayback serveur inchangé)");

/* ── 2. resolvePreviewMediaUrl (vidéo) ──────────────────────────────────── */
console.log("2. resolvePreviewMediaUrl(vidéo) → blob Bearer + objectURL");
const vid = mediaItem();
const res1 = await provider.resolvePreviewMediaUrl(vid);
assert.ok(res1 && res1.url && res1.url.startsWith("blob:"), "URL objectURL renvoyée");
assert.strictEqual(typeof res1.revoke, "function", "revoke fourni");
assert.strictEqual(downloads.length, 1, "un téléchargement /download");
assert.ok(downloads[0].url.includes("/api/media/1/download"), "bon endpoint");
assert.strictEqual(downloads[0].auth, "Bearer tok-999", "Bearer injecté (comme le plein écran image)");
ok("vidéo serveur : aperçu résolu par blob authentifié");

/* ── 3. Cache LOCAL borné ───────────────────────────────────────────────── */
console.log("3. Cache local : 2e survol sans re-téléchargement");
const res2 = await provider.resolvePreviewMediaUrl(vid);
assert.strictEqual(res2.url, res1.url, "même objectURL (cache) — M1");
assert.strictEqual(downloads.length, 1, "AUCUN nouveau fetch au 2e survol — M1");
const before = revokedUrls.length;
res1.revoke(); // no-op sur une entrée cachée
assert.strictEqual(revokedUrls.length, before, "revoke() no-op tant que l'entrée est en cache");
provider.clearPreviewCache();
assert.ok(revokedUrls.includes(res1.url), "clearPreviewCache révoque l'objectURL — M3");
await provider.resolvePreviewMediaUrl(vid);
assert.strictEqual(downloads.length, 2, "après clear, le média est re-téléchargé");
ok("cache LRU d'aperçus : réutilisation, révocation au clear, rechargement après clear");

/* ── 4. Image → resolveMediaUrl ; local → chaîne ────────────────────────── */
console.log("4. Image (serveur) et source locale");
const img = mediaItem({ id: 2, kind: "image", filename: "srv2.png" });
const imgRes = await provider.resolvePreviewMediaUrl(img);
assert.ok(imgRes.url.startsWith("blob:"), "image : objectURL (plein média)");
assert.strictEqual(typeof imgRes.revoke, "function", "image : revoke réel");
imgRes.revoke();
assert.ok(revokedUrls.includes(imgRes.url), "revoke image effectif (pas de cache aperçu pour les images)");
const localStr = GallerySource.active().resolvePreviewMediaUrl({ path_canon: "a/b.mp4", filename: "b.mp4", mtime: 5 });
assert.strictEqual(typeof localStr, "string", "local : URL synchrone (chaîne)");
assert.ok(localStr.includes("/holaf/images/full"), "local : endpoint /holaf/images/full");
ok("image serveur = plein média ; local = URL same-origin");

/* ── 5. Non-régression : plein média vidéo TOUJOURS refusé ──────────────── */
console.log("5. resolveMediaUrl(vidéo) refuse (plein écran) — non-régression");
let refused = false;
try {
    await provider.resolveMediaUrl(mediaItem({ id: 7 }));
} catch (e) {
    refused = true;
}
assert.strictEqual(refused, true, "M2 : le plein média vidéo reste indisponible en serveur");
ok("le plein écran vidéo serveur reste refusé (mediaPlayback:false)");

/* ── 6. Annulation (signal) ─────────────────────────────────────────────── */
console.log("6. Annulation par signal");
const ac = new AbortController();
ac.abort();
let aborted = false;
try {
    await provider.resolvePreviewMediaUrl(mediaItem({ id: 9 }), { signal: ac.signal });
} catch (e) {
    aborted = (e && e.name === "AbortError");
}
assert.strictEqual(aborted, true, "signal déjà annulé → AbortError");
ok("annulation propre (le hover peut annuler un téléchargement en vol)");

console.log(`\n${n} vérifications — PASS`);
