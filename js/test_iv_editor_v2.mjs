// Tests PURS (sans DOM) du modèle d'édition v2 + picker V4 master-detail.
// Usage : node js/test_iv_editor_v2.mjs
//
// Couvre le contrat de schéma v2 :
//   1. migration v1 → v2 (types zonaux all/shadows, spatial avec range, mask) ;
//   2. idempotence + conservation des champs inconnus ;
//   3. JSON v2 produit au save ;
//   4. passes de bandes non neutres + fast-path CSS ;
//   5. picker V4 (familles + compteurs + contrôles + AUCUNE étape « plage ») ;
//   6. parité FR/EN des dictionnaires i18n (aucune clé manquante d'un côté).
import assert from "node:assert";
import {
    SCHEMA_VERSION,
    ZONE_KEYS,
    CONTROL_CATEGORIES,
    CONTROL_TYPES,
    migrateControlV2,
    migrateControlsV2,
    normalizeStateV2,
    buildSaveEdits,
    isZonalType,
    neutralZones,
    zonesFromControl,
    zoneValue,
    controlZonePasses,
    hasRangedZones,
    buildCssFilterFromControls,
    buildControlPickerFamilies,
    buildPickerHTML,
    buildPickerItemsHTML,
    buildPickerFamiliesHTML,
    escapeHtml,
} from "./image_viewer/image_viewer_editor_model.js";

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

/* ─── 1. Migration v1 → v2 ─────────────────────────────────────────────── */
console.log("1. Migration v1 → v2");

const mAll = migrateControlV2({ id: "c_1", type: "brightness", value: 1.2, range: "all" });
assert.deepStrictEqual(mAll, {
    id: "c_1", type: "brightness",
    zones: { all: 1.2, shadows: 1, midtones: 1, highlights: 1 },
}, "v1 all → zones.all (autres neutres = 1)");
assert.ok(!("value" in mAll) && !("range" in mAll), "value/range retirés");
ok("cas 'all' : {value:1.2, range:'all'} → zones {all:1.2, …}");

const mShadows = migrateControlV2({ id: "c_2", type: "contrast", value: 1.5, range: "shadows" });
assert.deepStrictEqual(mShadows.zones, { all: 1, shadows: 1.5, midtones: 1, highlights: 1 }, "v1 shadows");
ok("cas 'shadows' : zones.shadows = value, le reste neutre");

const mHue = migrateControlV2({ id: "c_4", type: "hue", value: 30, range: "highlights" });
assert.deepStrictEqual(mHue.zones, { all: 0, shadows: 0, midtones: 0, highlights: 30 }, "v1 hue highlights (neutre hue = 0)");
ok("cas hue : neutre 0, zone ciblée = value");

const mSpatial = migrateControlV2({ id: "c_3", type: "blur", value: 8, range: "shadows" });
assert.deepStrictEqual(mSpatial, { id: "c_3", type: "blur", value: 8 }, "spatial : value conservée, range retiré");
ok("cas spatial avec range : {value:8, range:'shadows'} → {value:8}");

const mMask = migrateControlV2({ id: "m_1", type: "mask", value: 12, range: "all" });
assert.deepStrictEqual(mMask, { id: "m_1", type: "mask", value: 12 }, "mask : value conservée, range retiré");
ok("cas mask : value conservée, range retiré");

// D1 : un `range` inconnu, vide ou non-string retombe sur 'all' (parité stricte
// avec le backend logic.py) — la valeur ne doit JAMAIS être perdue.
const mRangeUnknown = migrateControlV2({ id: "c_7", type: "brightness", value: 1.7, range: "SHADOWS" });
assert.deepStrictEqual(mRangeUnknown.zones, { all: 1.7, shadows: 1, midtones: 1, highlights: 1 }, "range inconnu → 'all'");
const mRangeEmpty = migrateControlV2({ id: "c_8", type: "contrast", value: 1.4, range: "" });
assert.deepStrictEqual(mRangeEmpty.zones, { all: 1.4, shadows: 1, midtones: 1, highlights: 1 }, "range vide → 'all'");
const mRangeNum = migrateControlV2({ id: "c_9", type: "brightness", value: 0.6, range: 42 });
assert.deepStrictEqual(mRangeNum.zones, { all: 0.6, shadows: 1, midtones: 1, highlights: 1 }, "range non-string → 'all'");
// La valeur est conservée dans « all » (aucune zone ne la perd).
const mRangeMids = migrateControlV2({ id: "c_10", type: "hue", value: 45, range: "mids" });
assert.deepStrictEqual(mRangeMids.zones, { all: 45, shadows: 0, midtones: 0, highlights: 0 }, "range 'mids' inconnu → 'all' (hue neutre 0)");
// zonesFromControl directement (utilisé par le rendu, pas seulement la migration).
assert.deepStrictEqual(zonesFromControl({ type: "contrast", value: 1.9, range: "HIGHLIGHTS" }), { all: 1.9, shadows: 1, midtones: 1, highlights: 1 }, "zonesFromControl : range inconnu → 'all'");
assert.deepStrictEqual(zonesFromControl({ type: "brightness", value: 2, range: "" }), { all: 2, shadows: 1, midtones: 1, highlights: 1 }, "zonesFromControl : range vide → 'all'");
assert.deepStrictEqual(zonesFromControl({ type: "brightness", value: 2, range: 42 }), { all: 2, shadows: 1, midtones: 1, highlights: 1 }, "zonesFromControl : range non-string → 'all'");
ok("D1 : range inconnu/vide/non-string → 'all' (valeur jamais perdue)");

/* ─── 2. Idempotence + champs inconnus ─────────────────────────────────── */
console.log("2. Idempotence + champs inconnus");

const v1Unknown = { id: "c_5", type: "saturation", value: 0.8, range: "midtones", foo: "bar", enabled: true };
const once = migrateControlV2(v1Unknown);
const twice = migrateControlV2(once);
assert.deepStrictEqual(twice, once, "migration idempotente");
assert.strictEqual(once.foo, "bar");
assert.strictEqual(once.enabled, true);
ok("migration idempotente + champs inconnus (foo/enabled) conservés");

// Un contrôle DÉJÀ v2 reste inchangé (zones exactes).
const alreadyV2 = { id: "c_6", type: "brightness", zones: { all: 1.2, shadows: 1.5, midtones: 1.1, highlights: 1.3 } };
assert.deepStrictEqual(migrateControlV2(alreadyV2), alreadyV2, "v2 déjà migré inchangé");
ok("contrôle déjà v2 : aucune réécriture");

// Clé de zone absente = neutre.
assert.strictEqual(zoneValue({ all: 1.2 }, "brightness", "shadows"), 1, "zone absente → neutre (brightness)");
assert.strictEqual(zoneValue({ all: 30 }, "hue", "highlights"), 0, "zone absente → neutre (hue)");
ok("clé de zone absente = neutre");

/* ─── 3. JSON v2 produit au save ───────────────────────────────────────── */
console.log("3. JSON v2 au save");

const state = {
    controls: [
        { id: "c_1", type: "brightness", value: 1.2, range: "all" },
        { id: "c_2", type: "blur", value: 8, range: "shadows" },
        { id: "m_1", type: "mask", value: 12, file: "edit/x_mask_m_1.png" },
    ],
    targetFps: 30, playbackRate: 1.0, interpolate: false, crop: { x: 0, y: 0, w: 1, h: 1 },
    customUnknown: { keep: true },
};
const saved = buildSaveEdits(state);
assert.strictEqual(saved.v, SCHEMA_VERSION, "v:2 posé");
assert.strictEqual(saved.customUnknown.keep, true, "champ inconnu top-level conservé");
assert.deepStrictEqual(saved.controls[0], { id: "c_1", type: "brightness", zones: { all: 1.2, shadows: 1, midtones: 1, highlights: 1 } });
assert.deepStrictEqual(saved.controls[1], { id: "c_2", type: "blur", value: 8 });
assert.deepStrictEqual(saved.controls[2], { id: "m_1", type: "mask", value: 12, file: "edit/x_mask_m_1.png" });
assert.deepStrictEqual(state.controls[0], { id: "c_1", type: "brightness", value: 1.2, range: "all" }, "l'état source n'est pas muté");
ok("buildSaveEdits → {v:2, controls:[zones/value/…]} sans muter la source");

// normalizeStateV2 idempotent sur une liste vide.
assert.deepStrictEqual(normalizeStateV2({ controls: [] }).controls, [], "controls[] conservé");
ok("normalizeStateV2 : liste vide → []");

/* ─── 4. Passes de bandes + fast-path CSS ──────────────────────────────── */
console.log("4. Passes zonales + fast-path CSS");

assert.strictEqual(isZonalType("brightness"), true);
assert.strictEqual(isZonalType("blur"), false);
assert.strictEqual(isZonalType("mask"), false);
ok("isZonalType : brightness/contrast/saturation/hue zonaux ; blur/mask non");

const ctrlZones = { id: "c_1", type: "brightness", zones: { all: 1.2, shadows: 1.5, midtones: 1, highlights: 1 } };
assert.deepStrictEqual(controlZonePasses(ctrlZones), [
    { zone: "all", value: 1.2 },
    { zone: "shadows", value: 1.5 },
], "passes = bandes ≠ neutre, dans l'ordre all→shadows→midtones→highlights");
ok("controlZonePasses : 2 passes non neutres, ordre respecté");

assert.strictEqual(controlZonePasses({ type: "brightness", zones: neutralZones("brightness") }).length, 0, "aucune passe si neutre");
ok("contrôle neutre : aucune passe");

// Fast-path CSS conservé pour un contrôle migré en « all » uniquement.
const migratedAll = [{ id: "c_1", type: "brightness", zones: { all: 1.2, shadows: 1, midtones: 1, highlights: 1 } }];
assert.strictEqual(hasRangedZones(migratedAll), false, "migré all → fast-path CSS possible");
assert.strictEqual(hasRangedZones([ctrlZones]), true, "zone shadows → rendu canvas requis");
assert.strictEqual(hasRangedZones([{ id: "c_2", type: "blur", value: 8 }]), false, "spatial n'exige pas le canvas via les zones");
ok("hasRangedZones : false pour un edit migré « all », true pour une bande ≠ all");

const f = buildCssFilterFromControls(migratedAll);
assert.strictEqual(f, "brightness(1.2) contrast(1) saturate(1) hue-rotate(0deg)", "filtre CSS depuis la bande all");
ok("buildCssFilterFromControls : brightness(1.2) … (fast-path)");

// Un ancien contrôle v1 (non migré) est toléré par les helpers.
const legacy = [{ id: "c_1", type: "brightness", value: 1.4, range: "all" }];
assert.strictEqual(hasRangedZones(legacy), false, "v1 all toléré (fast-path)");
assert.match(buildCssFilterFromControls(legacy), /brightness\(1\.4\)/, "v1 all toléré par le filtre");
ok("helpers tolèrent un contrôle v1 non migré");

/* ─── 5. Picker V4 master-detail ───────────────────────────────────────── */
console.log("5. Picker V4 master-detail");

const labelFor = (id) => `L_${id}`;
const translate = (key) => `T_${key}`;
const families = buildControlPickerFamilies(labelFor, translate);

assert.deepStrictEqual(families.map((f) => f.id), ["geometry", "basic", "color", "effects", "mask"], "familles dans l'ordre");
ok(`familles = ${families.map((f) => f.id).join(", ")}`);

const byId = Object.fromEntries(families.map((fam) => [fam.id, fam]));
assert.strictEqual(byId.geometry.items.length, 1, "géométrie = 1 (Crop)");
assert.strictEqual(byId.geometry.items[0].id, "crop");
assert.strictEqual(byId.basic.items.length, 2, "basic = 2 (brightness, contrast)");
assert.strictEqual(byId.color.items.length, 2, "color = 2 (saturation, hue)");
assert.strictEqual(byId.effects.items.length, 4, "effects = 4");
assert.strictEqual(byId.mask.items.length, 1, "mask = 1");
ok("compteurs par famille corrects (1/2/2/4/1)");

const html = buildPickerHTML(families, "basic");
assert.match(html, /class="aih-picker-families"/);
assert.match(html, /class="aih-picker-controls"/);
assert.match(html, /data-family="basic"/);
assert.match(html, /aih-picker-family active"[^>]*data-family="basic"|data-family="basic"[^>]*aria-selected="true"/, "famille active marquée");
assert.match(html, /data-pick="brightness"/);
assert.match(html, /data-pick="contrast"/);
// Le compteur de la famille basic doit être affiché.
assert.match(html, /aria-selected="true"[\s\S]*?<span class="aih-picker-family-count">2<\/span>/);
ok("picker HTML : deux colonnes + data-pick + compteur");

// AUCUNE étape « plage » : les items de plage ne sont plus des choix de picker.
for (const rangeId of ["all", "shadows", "midtones", "highlights"]) {
    assert.ok(!html.includes(`data-pick="${rangeId}"`), `pas de data-pick="${rangeId}" (plus d'étape plage)`);
}
assert.ok(!/rangeTitle/.test(html));
ok("aucune étape « plage » dans le picker (pas de data-pick all/shadows/…)");

// Icônes SVG inline (fin des emojis).
assert.match(html, /<svg /, "icônes SVG inline");
assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html), "aucun emoji dans le picker");
ok("icônes SVG inline, aucun emoji");

// Basculer de famille ne montre que ses items.
const itemsColor = buildPickerItemsHTML(byId.color);
assert.match(itemsColor, /data-pick="saturation"/);
assert.match(itemsColor, /data-pick="hue"/);
assert.ok(!itemsColor.includes('data-pick="brightness"'), "items filtrés par famille");
const famHtml = buildPickerFamiliesHTML(families, "color");
assert.match(famHtml, /data-family="color"[^>]*aria-selected="true"|aria-selected="true"[^>]*data-family="color"/);
ok("buildPickerItemsHTML/FamiliesHTML : filtrage + famille active");

// Échappement HTML des libellés.
assert.strictEqual(escapeHtml(`<b>"x"&'y'</b>`), "&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/b&gt;");
const evil = buildPickerHTML([{ id: "x", label: "<img src=x onerror=alert(1)>", items: [{ id: "i", label: "<b>pwn</b>" }] }], "x");
assert.ok(!evil.includes("<img"), "libellé échappé");
ok("échappement HTML des libellés du picker");

/* ─── 6. Contrat de types (schéma v2) ──────────────────────────────────── */
console.log("6. Contrat de types");

const zonalIds = CONTROL_TYPES.filter((c) => c.zonal).map((c) => c.id);
assert.deepStrictEqual(zonalIds, ["brightness", "contrast", "saturation", "hue"], "types zonaux exacts");
assert.deepStrictEqual(ZONE_KEYS, ["all", "shadows", "midtones", "highlights"], "4 clés de zones");
assert.deepStrictEqual(CONTROL_CATEGORIES.map((c) => c.id), ["geometry", "basic", "color", "effects"], "catégories");
for (const ct of CONTROL_TYPES.filter((c) => c.zonal)) {
    assert.deepStrictEqual(neutralZones(ct.id), { all: ct.default, shadows: ct.default, midtones: ct.default, highlights: ct.default });
}
ok("brightness/contrast/saturation/hue zonaux ; neutres = default (1 sauf hue=0)");

/* ─── 7. i18n : parité FR/EN ───────────────────────────────────────────── */
console.log("7. i18n FR/EN");

const store = {};
globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
};
globalThis.window = { localStorage: globalThis.localStorage, navigator: { language: "fr-FR" } };
await import("./aih_i18n.js");
const I18n = globalThis.window.AIH.I18n;
const captured = {};
const origAddDict = I18n.addDict.bind(I18n);
I18n.addDict = (lang, entries) => {
    captured[lang] = Object.assign(captured[lang] || {}, entries);
    return origAddDict(lang, entries);
};
await import("./aih_strings.js");

const frKeys = Object.keys(captured.fr || {});
const enKeys = Object.keys(captured.en || {});
const onlyFr = frKeys.filter((k) => !(k in (captured.en || {})));
const onlyEn = enKeys.filter((k) => !(k in (captured.fr || {})));
assert.deepStrictEqual(onlyFr, [], `clés FR absentes en EN : ${onlyFr.join(", ")}`);
assert.deepStrictEqual(onlyEn, [], `clés EN absentes en FR : ${onlyEn.join(", ")}`);
assert.ok(frKeys.length > 0 && frKeys.length === enKeys.length, `FR=${frKeys.length} EN=${enKeys.length}`);
assert.ok(!("iv.rangeTitle" in (captured.fr || {})), "iv.rangeTitle supprimée (FR)");
assert.ok(!("iv.rangeTitle" in (captured.en || {})), "iv.rangeTitle supprimée (EN)");
for (const k of ["iv.shadows", "iv.midtones", "iv.highlights", "iv.all"]) {
    assert.ok(k in (captured.fr || {}) && k in (captured.en || {}), `labels de bandes ${k} présents FR+EN`);
}
ok(`parité FR/EN OK (${frKeys.length} clés) ; iv.rangeTitle supprimée ; labels de bandes conservés`);

console.log(`\n✅ Test modèle éditeur v2 + picker V4 : TOUS LES TESTS PASSENT (${n} assertions de groupe)`);
