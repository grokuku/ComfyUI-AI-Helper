// Test de régression — brique HolafThumbCache VENDÉE dans le pack.
// Usage : node js/test_iv_thumbcache.mjs
//
// Prouve que le protocole « 202 + Retry-After » et la priorisation des vignettes
// visibles, absorbés par la brique, sont bien RE-CÂBLÉS (non-régression UX) :
//   1. réponse 202 → onPending(item, Retry-After en ms) + re-tentative planifiée
//      puis succès (la promesse ne se résout PAS en image cassée) ;
//   2. contrôle négatif : une erreur HTTP NON-timeout (500) ne déclenche AUCUN
//      retry (comme l'ancien code : seul le timeout est retenté) ;
//   3. onVisible(ids) débounce puis transmet le lot à onPrioritize (le POST
//      /holaf/images/prioritize-thumbnails) ; sans onPrioritize c'est un no-op ;
//   4. un hit cache ne relance pas de requête (LRU).
//
// La brique est pure (sans DOM) : aucune dépendance jsdom nécessaire.
import assert from "node:assert";
import { HolafThumbCache } from "./vendor/holaf/holaf-thumbcache.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function response202(retryAfterSec) {
    return new Response(null, { status: 202, headers: { "Retry-After": String(retryAfterSec) } });
}
function response200(body = "IMG") {
    return new Response(body, { status: 200, headers: { "content-type": "application/octet-stream" } });
}
function response500() {
    return new Response("boom", { status: 500 });
}

// ── 1. 202 + Retry-After : pending → retry planifié → succès ──────────────
{
    let calls = 0;
    const pendingArgs = [];
    const cache = HolafThumbCache.create({
        strategy: "url", // pas de createObjectURL : la valeur passe telle quelle
        getId: (img) => img.path_canon,
        timeoutMs: 5000,
        load: async (img) => {
            calls++;
            // 1er essai : génération serveur en cours (202, retry dans 50 ms).
            if (calls === 1) return response202(0.05);
            return response200();
        },
        onPending: (img, retryAfterMs) => pendingArgs.push([img.path_canon, retryAfterMs]),
    });

    const p = cache.request({ path_canon: "a.png" }, HolafThumbCache.PRIORITY_HIGH);
    assert.strictEqual(cache.isPending("a.png"), false, "pas encore pending (appel async)");
    await delay(10); // laisse la 1re tentative se résoudre en 202
    assert.strictEqual(pendingArgs.length, 1, "202 → onPending appelé une fois");
    assert.strictEqual(pendingArgs[0][0], "a.png");
    assert.strictEqual(pendingArgs[0][1], 50, "Retry-After 0.05 s → 50 ms");
    assert.strictEqual(cache.isPending("a.png"), true, "état « pending » exposé (placeholder gris)");

    const handle = await p; // se résout APRÈS le retry, pas en erreur
    assert.strictEqual(calls, 2, "202 → une seule re-tentative puis succès");
    assert.ok(handle, "la promesse résout un handle (pas de miniatures cassées)");
    assert.strictEqual(cache.has("a.png"), true, "vignette mise en cache");
}
console.log("✅ 202 + Retry-After : onPending(ms) → retry planifié → succès (pas d'image cassée)");

// ── 2. Contrôle négatif : HTTP 500 ≠ timeout → AUCUN retry ────────────────
{
    let calls = 0;
    const cache = HolafThumbCache.create({
        strategy: "url",
        timeoutMs: 5000,
        retry: { max: 4, delayMs: 10 },
        load: async () => { calls++; return response500(); },
    });
    await assert.rejects(
        cache.request({ id: "err" }),
        (e) => /HTTP 500/.test(e.message),
        "500 → rejet (overlay d'erreur), comme avant"
    );
    await delay(30);
    assert.strictEqual(calls, 1, "un 500 n'est PAS retenté (seul le timeout l'est)");
}
console.log("✅ 500 : rejet immédiat, aucun retry (seul le timeout est retenté)");

// ── 3. Priorisation des vignettes visibles (onVisible débouncé) ────────────
{
    const batches = [];
    const cache = HolafThumbCache.create({
        strategy: "url",
        getId: (img) => img.path_canon,
        load: async () => response200(),
        onPrioritize: (ids) => batches.push(ids),
        visibleDebounceMs: 25,
        visibleFlushThreshold: 1000,
    });
    cache.onVisible(["a.png", "b.png"]);
    cache.onVisible(["c.png"]);
    assert.strictEqual(batches.length, 0, "onVisible est débouncé (pas de POST immédiat)");
    await delay(60);
    assert.strictEqual(batches.length, 1, "un seul lot après le débounce (pas de spam backend)");
    assert.deepStrictEqual([...batches[0]].sort(), ["a.png", "b.png", "c.png"]);

    // Sans onPrioritize → no-op silencieux (l'ancien code ne POST pas non plus).
    const bare = HolafThumbCache.create({ strategy: "url", load: async () => response200() });
    bare.onVisible(["x.png"]);
    await delay(30);
    assert.ok(true, "onVisible sans onPrioritize ne lève pas");
}
console.log("✅ Priorisation visible : onVisible → 1 lot débouncé → onPrioritize");

// ── 4. Hit cache : aucun nouveau chargement (LRU) ────────────────────────
{
    let calls = 0;
    const cache = HolafThumbCache.create({
        strategy: "url",
        getId: (img) => img.path_canon,
        load: async (img) => { calls++; return response200(); },
    });
    const h1 = await cache.request({ path_canon: "z.png" });
    const h2 = await cache.request({ path_canon: "z.png" });
    assert.strictEqual(h1, h2);
    assert.strictEqual(calls, 1, "le 2e request est un hit cache (dédup)");
}
console.log("✅ Hit cache : la 2e demande ne relance pas de requête");

console.log("\n✅ Test cache/ordonnanceur vignettes (HolafThumbCache vendue) : TOUS LES TESTS PASSENT");
