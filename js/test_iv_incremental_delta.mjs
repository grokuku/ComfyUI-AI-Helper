// Tests de régression — rafraîchissement INCRÉMENTAL de la galerie AIH Image Viewer.
// Usage : node js/test_iv_incremental_delta.mjs
//
// Bug visé : « la galerie recalcule régulièrement toutes les miniatures ».
// Le poll périodique (checkForUpdates) recevait un delta (nouvelles images) et
// relançait loadFilteredImages() → resetWindowCache() → toute la grille visible
// repassait en skeletons et chaque vignette visible était redemandée.
//
// Ce test couvre le CŒUR (sans DOM) extrait dans image_viewer_data.js et
// image_viewer_delta.js :
//   1. insertImagesAtTop() insère EN TÊTE et CONSERVE les fenêtres chargées
//      (si resetWindowCache était réintroduit, isWindowLoaded(0) deviendrait
//      false → test ROUGE = contrôle négatif).
//   2. dedupe par path_canon.
//   3. removeImagesByPaths() retire et ré-ancre les fenêtres chargées.
//   4. applyIncrementalDelta() : delta normal = patch SANS reload complet ;
//      suppression de masse / irréconciliable = reload complet (fallback).
import assert from "node:assert";
import {
    PAGE_SIZE, setWindowLoaded, isWindowLoaded,
    insertImagesAtTop, removeImagesByPaths, forEachLoadedImage,
} from "./image_viewer/image_viewer_data.js";
import { applyIncrementalDelta, MASS_REMOVAL_THRESHOLD } from "./image_viewer/image_viewer_delta.js";

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

function makeImages(prefix, count, startMtime) {
    const arr = [];
    for (let i = 0; i < count; i++) arr.push({ path_canon: `${prefix}${i}`, mtime: startMtime - i });
    return arr;
}

/* ─── 1. insertImagesAtTop : insertion en tête + fenêtres préservées ─────── */
console.log("1. insertImagesAtTop");
{
    const state = { images: [], totalCount: 1000 };
    const win0 = makeImages("old", PAGE_SIZE, 1000);
    setWindowLoaded(state, 0, win0);
    assert.strictEqual(isWindowLoaded(0), true, "arrangement : fenêtre 0 chargée");

    const oldFirst = state.images[0];
    const inserted = insertImagesAtTop(state, [
        { path_canon: "NEW_b", mtime: 9998 },
        { path_canon: "NEW_a", mtime: 9999 },
    ]);

    assert.strictEqual(inserted, 2, "2 images insérées");
    assert.strictEqual(state.images[0].path_canon, "NEW_a", "l'image la plus récente est en tête (tri mtime DESC)");
    assert.strictEqual(state.images[1].path_canon, "NEW_b");
    assert.strictEqual(state.images[2], oldFirst, "l'ancienne tête est décalée de +N, pas perdue");
    assert.strictEqual(state.images.length, 1002, "longueur = ancienne + N");

    // PREUVE PRINCIPALE : la fenêtre 0 est toujours chargée (pas de reset).
    // Si resetWindowCache() était réintroduit dans insertImagesAtTop, ceci
    // serait false → contrôle négatif.
    assert.strictEqual(isWindowLoaded(0), true, "fenêtre 0 conservée (aucun resetWindowCache)");
    assert.strictEqual(isWindowLoaded(PAGE_SIZE), false, "fenêtre hors couverture non marquée chargée");

    // Les données déjà chargées sont toujours accessibles via forEachLoadedImage.
    const seen = new Set();
    forEachLoadedImage(state, (img) => seen.add(img.path_canon));
    assert.ok(seen.has("NEW_a") && seen.has("NEW_b") && seen.has("old497"));
    ok("insertion en tête + fenêtre 0 conservée + données préservées");
}

/* ─── 2. dedupe par path_canon ───────────────────────────────────────────── */
console.log("2. dedupe");
{
    const state = { images: [], totalCount: 10 };
    setWindowLoaded(state, 0, makeImages("k", 10, 100));
    const inserted = insertImagesAtTop(state, [{ path_canon: "k3", mtime: 9999 }]);
    assert.strictEqual(inserted, 0, "un path déjà chargé n'est pas réinséré");
    assert.strictEqual(state.images.length, 10);
    ok("dedupe par path_canon");
}

/* ─── 3. removeImagesByPaths : retrait + ré-ancrage ──────────────────────── */
console.log("3. removeImagesByPaths");
{
    const state = { images: [], totalCount: 2 * PAGE_SIZE };
    setWindowLoaded(state, 0, makeImages("x", PAGE_SIZE, 1000));
    setWindowLoaded(state, PAGE_SIZE, makeImages("y", PAGE_SIZE, 500));
    assert.strictEqual(isWindowLoaded(0), true);
    assert.strictEqual(isWindowLoaded(PAGE_SIZE), true);

    const removed = removeImagesByPaths(state, ["x10"]);
    assert.strictEqual(removed, 1, "1 retrait");
    assert.strictEqual(state.images[10].path_canon, "x11", "les éléments suivants se décalent de -1");
    assert.strictEqual(state.images.length, 2 * PAGE_SIZE - 1);
    // Les deux fenêtres adjacentes étaient chargées → le décalage reste couvert.
    assert.strictEqual(isWindowLoaded(0), true, "fenêtre 0 toujours couverte");
    assert.strictEqual(isWindowLoaded(PAGE_SIZE), true, "fenêtre suivante toujours couverte");
    ok("retrait + ré-ancrage, fenêtres conservées");

    // Un path absent de la mémoire ne peut pas être réconcilié → reload demandé.
    assert.strictEqual(removeImagesByPaths(state, ["jamais_chargé"]), false);
    ok("retrait non réconciliable → false (fallback reload)");
}

/* ─── 4. applyIncrementalDelta : patch vs fallback reload ────────────────── */
console.log("4. applyIncrementalDelta");
{
    const calls = { load: 0, insert: 0, remove: 0 };
    const deps = {
        getState: () => ({ images: [], totalCount: 0 }),
        insertImagesAtTop: (s, imgs) => { calls.insert++; return imgs.length; },
        removeImagesByPaths: (s, paths) => { calls.remove++; return paths.length; },
        loadFilteredImages: async () => { calls.load++; },
    };

    // 4a. delta normal → patch, AUCUN reload complet
    calls.load = 0;
    let r = await applyIncrementalDelta({ images: [{ path_canon: "n1" }] }, deps);
    assert.strictEqual(r.mode, "patched");
    assert.strictEqual(calls.insert, 1);
    assert.strictEqual(calls.load, 0, "delta normal NE déclenche AUCUN loadFilteredImages");
    ok("delta normal → patch (insert), pas de reload complet");

    // 4b. suppression de masse → reload complet (cas légitime préservé)
    calls.load = 0;
    const many = Array.from({ length: MASS_REMOVAL_THRESHOLD }, (_, i) => "p" + i);
    r = await applyIncrementalDelta({ removed_path_canons: many }, deps);
    assert.strictEqual(r.mode, "full-reload");
    assert.strictEqual(r.reason, "mass-removal");
    assert.strictEqual(calls.load, 1, "suppression de masse → reload complet");
    ok("suppression de masse → reload complet (préservé)");

    // 4c. suppression irréconciliable → reload complet
    calls.load = 0;
    deps.removeImagesByPaths = () => false;
    r = await applyIncrementalDelta({ removed_path_canons: ["a"] }, deps);
    assert.strictEqual(r.mode, "full-reload");
    assert.strictEqual(r.reason, "unreconcilable-removal");
    assert.strictEqual(calls.load, 1);
    ok("suppression irréconciliable → reload complet");

    // 4d. suppression réconciliable → patch, pas de reload
    calls.load = 0;
    deps.removeImagesByPaths = (s, paths) => paths.length;
    r = await applyIncrementalDelta({ removed_path_canons: ["a"] }, deps);
    assert.strictEqual(r.mode, "patched");
    assert.strictEqual(calls.load, 0, "retrait réconciliable → pas de reload");
    ok("suppression réconciliable → patch, pas de reload");

    // 4e. delta vide → patch 0/0, pas de reload
    calls.load = 0;
    r = await applyIncrementalDelta({}, deps);
    assert.strictEqual(r.mode, "patched");
    assert.strictEqual(r.inserted, 0);
    assert.strictEqual(calls.load, 0);
    ok("delta vide → rien à faire");
}

console.log(`\n✅ Test delta incrémental : TOUS LES TESTS PASSENT (${n} étapes)`);
