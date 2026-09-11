// Repro Vague 13 — bouton « Actualiser » de la modale de redémarrage.
// Valide que le check robuste (/system_stats, credentials:'include',
// redirect:'manual') n'active le bouton QU'après un 200 + JSON ComfyUI, et
// JAMAIS sur un 302 Authentik (réponse opaque 0) ou un 502 Caddy.
// Usage : node js/test_aih_restart_poll.mjs
import assert from "node:assert";
import { holafComfyHealthCheck } from "./holaf_restart_health.js";

const ORIGIN = "https://sd.holaf.fr";

function makeResponse(status, ct = "", body = "") {
    return {
        status,
        headers: { get: (k) => (k.toLowerCase() === "content-type" ? ct : null) },
        json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    };
}

const COMFY_OK = JSON.stringify({
    system: { comfyui_version: "v0.3.30", python_version: "3.11", pytorch_version: "2.5.1" },
    devices: [{ name: "cuda:0" }],
    memory: { devices: [{ torch_free: 1 }] },
});

// Séquences simulées : [réponse au 1er poll, 2e, ...]
let call = 0;
const sequence = [
    { status: 502, ct: "text/plain", body: "502 Bad Gateway" },   // ComfyUI down (Caddy)
    { status: 502, ct: "text/plain", body: "502 Bad Gateway" },   // toujours down
    { status: 302, ct: "text/html", body: "" },                   // Authentik authorize (opaque en redirect:manual → le moteur renverrait status 0)
    { status: 200, ct: "text/html", body: "<html>Authentik login</html>" }, // page login 200 (proxy)
    { status: 200, ct: "application/json", body: COMFY_OK },       // VRAI retour ComfyUI
];

async function sequenceFetch() {
    const s = sequence[Math.min(call, sequence.length - 1)];
    call++;
    // Un 302 en redirect:'manual' se matérialise en réponse opaque status 0.
    if (s.status === 302) return makeResponse(0, "", "");
    return makeResponse(s.status, s.ct, s.body);
}

async function run() {
    // ——— 1. Séquence complète : le check ne doit être prêt qu'au dernier (200 JSON) —
    call = 0;
    const results = [];
    for (let i = 0; i < sequence.length; i++) {
        results.push(await holafComfyHealthCheck({ fetchImpl: sequenceFetch, origin: ORIGIN }));
    }
    assert.deepStrictEqual(
        results.map((r) => r.ready),
        [false, false, false, false, true],
        "ready UNIQUEMENT après le 200 JSON ComfyUI : " + JSON.stringify(results)
    );

    // 502 → source http ; login HTML 200 → not-json ; JSON mauvais shape → shape
    assert.strictEqual(results[0].source, "http", "502 → source http");
    assert.strictEqual(results[3].source, "not-json", "login HTML 200 → not-json");

    // ——— 2. Le 302 Authentik ne doit JAMAIS être pris pour « prêt » même isolé —
    call = 0;
    const solo = await holafComfyHealthCheck({
        fetchImpl: async () => makeResponse(0, "", ""), // opaque redirect
        origin: ORIGIN,
    });
    assert.strictEqual(solo.ready, false, "réponse opaque (302) → pas prêt");
    assert.strictEqual(solo.status, 0, "status opaque 0");

    // ——— 3. JSON non-ComfyUI (ex. un 200 arbitraire du proxy) → pas prêt —
    const notComfy = await holafComfyHealthCheck({
        fetchImpl: async () => makeResponse(200, "application/json", JSON.stringify({ hello: "world" })),
        origin: ORIGIN,
    });
    assert.strictEqual(notComfy.ready, false, "JSON sans shape /system_stats → pas prêt");
    assert.strictEqual(notComfy.source, "shape", "200 JSON non-ComfyUI → shape");

    // ——— 4. Réseau (throw) → pas prêt, non-bloquant —
    const net = await holafComfyHealthCheck({
        fetchImpl: async () => { throw new Error("network down"); },
        origin: ORIGIN,
    });
    assert.strictEqual(net.ready, false, "jeton fetch → pas prêt");
    assert.strictEqual(net.source, "network", "erreur réseau → source network");

    // ——— 5. L'URL cible est bien /system_stats sur l'origine, creds + redirect —
    let captured = null;
    await holafComfyHealthCheck({
        fetchImpl: async (_url, init) => { captured = { _url, init }; return makeResponse(200, "application/json", COMFY_OK); },
        origin: ORIGIN,
    });
    assert.ok(captured, "fetch appelé");
    assert.strictEqual(captured._url, ORIGIN + "/system_stats", "URL /system_stats sur l'origine");
    assert.strictEqual(captured.init.credentials, "include", "credentials: 'include' (cookie Authentik)");
    assert.strictEqual(captured.init.redirect, "manual", "redirect: 'manual' (ne suit pas le 302 Authentik)");
    assert.strictEqual(captured.init.method, "GET", "GET léger");

    console.log("✅ Repro poll redémarrage : le bouton ne s'active QUE sur le 200 JSON ComfyUI");
}

run().catch((e) => { console.error(e); process.exit(1); });
