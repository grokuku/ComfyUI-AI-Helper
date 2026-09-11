// Test de régression Vague 11 — flux export galerie + brique HolafFetch.
// Usage : node js/test_iv_export_fetch.mjs
//
// Reproduit le backend réel (routes/export_routes.py) avec un fetch mocké :
//   - GET export-chunk → 200 + application/octet-stream (manifest ET chunks
//     binaires : c'est le content-type que le serveur aiohttp renvoie pour
//     TOUS les fichiers servis par download_export_chunk_route) ;
//   - POST prepare-export → 200 JSON, éventuellement LONG à répondre
//     (transcodes ffmpeg traités AVANT la réponse).
//
// 1. BUG PRIMAIRE : en mode JSON la brique refusait le content-type
//    application/octet-stream du manifest → HolafFetchError « réponse
//    non-JSON » sur un export pourtant sain → aucun export ne démarrait.
//    Fix : raw:true + .json() explicite (comme l'ancien fetch).
// 2. BUG SECONDAIRE : le défaut 30 s de la brique coupait prepare-export
//    (l'ancien fetch n'avait AUCUN timeout). Fix : timeout: 0.
// 3. Les chunks binaires (raw:true + .ok + .arrayBuffer()) restent corrects.
import assert from "node:assert";
import { HolafFetch, HolafFetchError } from "./vendor/holaf/holaf-fetch.js";

// ── Fetch mocké : simule aiohttp (aiohttp ne force PAS application/json) ──
// Le mock HONORE le signal d'AbortController comme le vrai fetch navigateur
// (sinon le timer de la brique n'a aucun effet observable).
let fetchCalls = [];
function mockFetch(handler) {
    globalThis.fetch = (url, init = {}) => new Promise((resolve, reject) => {
        fetchCalls.push({ url: String(url), init });
        const signal = init.signal;
        const onAbort = () => reject(new DOMException("This operation was aborted", "AbortError"));
        if (signal?.aborted) { onAbort(); return; }
        signal?.addEventListener("abort", onAbort, { once: true });
        Promise.resolve(handler(url, init)).then(
            (res) => { signal?.removeEventListener("abort", onAbort); resolve(res); },
            (err) => { signal?.removeEventListener("abort", onAbort); reject(err); }
        );
    });
}

const MANIFEST_JSON = JSON.stringify([{ path: "ComfyUI_00001_.png", size: 12345 }]);

function octetStreamResponse(body, status = 200) {
    return new Response(body, { status, headers: { "content-type": "application/octet-stream" } });
}
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

// ── 1. BUG PRIMAIRE : manifest en mode JSON (comportement d'avant le fix) ──
mockFetch(() => octetStreamResponse(MANIFEST_JSON));
await assert.rejects(
    HolafFetch.get("/holaf/images/export-chunk?file_path=manifest.json"),
    (e) => {
        assert.ok(e instanceof HolafFetchError);
        assert.match(e.message, /réponse non-JSON/);
        assert.strictEqual(e.status, 200); // réponse pourtant Saine !
        return true;
    },
    "La brique doit refuser un manifest octet-stream en mode JSON (bug d'origine)"
);
console.log("✅ Bug primaire reproduit : mode JSON + octet-stream → throw « réponse non-JSON (statut 200) »");

// ── 2. FIX PRIMAIRE : manifest en raw:true + .ok + .json() ──
mockFetch(() => octetStreamResponse(MANIFEST_JSON));
const manifestResponse = await HolafFetch.get("/holaf/images/export-chunk?file_path=manifest.json", { raw: true });
assert.strictEqual(manifestResponse.ok, true);
const manifest = await manifestResponse.json();
assert.deepStrictEqual(manifest, [{ path: "ComfyUI_00001_.png", size: 12345 }]);
console.log("✅ Fix primaire validé : raw:true → le manifest octet-stream est parsé");

// Erreur HTTP sur le manifest : détectée via .ok (l'ancien code l'avalait).
mockFetch(() => octetStreamResponse("Export file not found.", 404));
const res404 = await HolafFetch.get("/holaf/images/export-chunk?file_path=manifest.json", { raw: true });
assert.strictEqual(res404.ok, false);
assert.strictEqual(res404.status, 404);
console.log("✅ Manifest 404 : détecté via .ok → throw « HTTP error 404 (manifest) » (toast d'échec)");

// ── 3. BUG SECONDAIRE : prepare-export long vs timeout de la brique ──
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
mockFetch(async () => { await delay(120); return jsonResponse({ status: "ok", export_id: "uuid-1", errors: [] }); });

// Défaut (30 s) simulé par un timeout court : l'appel est ABORTÉ alors que le
// serveur finissait par répondre — c'est ce que subissait prepare-export.
await assert.rejects(
    HolafFetch.post("/holaf/images/prepare-export", { body: {}, timeout: 50 }),
    (e) => e instanceof HolafFetchError && e.status === 0 && e.message === "timeout",
    "Brique : timeout → HolafFetchError(status 0)"
);
console.log("✅ Bug secondaire reproduit : timeout court → HolafFetchError « timeout » sur un serveur pourtant OK");

// FIX : timeout: 0 → aucun abort, la réponse (tardive) est bien reçue.
const prepared = await HolafFetch.post("/holaf/images/prepare-export", { body: {}, timeout: 0 });
assert.deepStrictEqual(prepared, { status: "ok", export_id: "uuid-1", errors: [] });
console.log("✅ Fix secondaire validé : timeout: 0 → la réponse tardive est reçue (ancien comportement fetch)");

// ── 4. Chunk binaire (inchangé, raw:true + .arrayBuffer()) ──
const BIN = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
mockFetch(() => octetStreamResponse(BIN));
const chunkResponse = await HolafFetch.get("/holaf/images/export-chunk?file_path=ComfyUI_00001_.png", { raw: true });
assert.strictEqual(chunkResponse.ok, true);
const buf = new Uint8Array(await chunkResponse.arrayBuffer());
assert.deepStrictEqual([...buf], [...BIN]);
console.log("✅ Chunks binaires : raw:true + .arrayBuffer() inchangés et fonctionnels");

// ── 5. Le corps JSON du POST est bien sérialisé par la brique ──
mockFetch((url, init) => {
    assert.strictEqual(init.headers["Content-Type"], "application/json");
    const body = JSON.parse(init.body);
    assert.ok(Array.isArray(body.paths_canon));
    return jsonResponse({ status: "ok", export_id: "uuid-2", errors: [] });
});
await HolafFetch.post("/holaf/images/prepare-export", { body: { paths_canon: ["a.png"] }, timeout: 0 });
console.log("✅ POST prepare-export : body sérialisé + Content-Type JSON (payload inchangé)");

console.log("\n✅ Test export galerie (HolafFetch) : TOUS LES TESTS PASSENT");