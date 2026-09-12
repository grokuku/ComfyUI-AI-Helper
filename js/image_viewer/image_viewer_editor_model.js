/*
 * Copyright (C) 2026 Holaf
 * Holaf Utilities - Image Viewer Editor — Modèle de données (schéma v2)
 *
 * Module PUR (aucun accès DOM, aucune dépendance i18n) : il décrit les types de
 * contrôles, la migration v1 → v2 du fichier .edt et les helpers de rendu
 * (filtre CSS, passes de zones) ainsi que le HTML du picker master-detail.
 *
 * Contrat de schéma v2 :
 *   {
 *     "v": 2,
 *     "controls": [
 *       {"id":"c_1","type":"brightness","zones":{"all":1.2,"shadows":1.5,"midtones":1.1,"highlights":1.3}},
 *       {"id":"c_2","type":"blur","value":8},
 *       {"id":"m_1","type":"mask","value":12,"file":"edit/<base>_mask_m_1.png"}
 *     ],
 *     "targetFps":30,"playbackRate":1.0,"interpolate":false,"crop":{...}
 *   }
 *   - Types ZONAUX (zones) : brightness, contrast, saturation, hue.
 *     Neutres : 1 pour brightness/contrast/saturation, 0 pour hue.
 *     Clé de zone absente = neutre.
 *   - Types NON ZONAUX (value globale) : blur, pixelate, vignette, sharpen, mask.
 *   - Migration idempotente ; champ "v" absent = version 1.
 */

export const SCHEMA_VERSION = 2;

export const ZONE_KEYS = ['all', 'shadows', 'midtones', 'highlights'];

// Clés i18n des libellés de bandes (réutilisées par les sliders zonaux).
export const ZONE_LABEL_KEYS = {
    all: 'iv.all',
    shadows: 'iv.shadows',
    midtones: 'iv.midtones',
    highlights: 'iv.highlights',
};

// Clés i18n des libellés COURTS de bandes (colonne d'étiquettes étroite des
// sliders zonaux). Les formes LONGUES (ZONE_LABEL_KEYS) restent utilisées pour
// les pastilles repliées et le `title` (tooltip) des lignes dépliées.
export const ZONE_SHORT_LABEL_KEYS = {
    all: 'iv.zoneShortAll',
    shadows: 'iv.zoneShortShadows',
    midtones: 'iv.zoneShortMidtones',
    highlights: 'iv.zoneShortHighlights',
};

// Classes CSS de teinte par bande (dégradé sombre → clair).
export const ZONE_TINT_CLASS = {
    all: 'holaf-zone-dot--all',
    shadows: 'holaf-zone-dot--shadows',
    midtones: 'holaf-zone-dot--midtones',
    highlights: 'holaf-zone-dot--highlights',
};

// Catégories des contrôles d'édition (rangement « dossier » du picker V4).
export const CONTROL_CATEGORIES = [
    { id: 'geometry', labelKey: 'iv.catGeometry' },
    { id: 'basic',    labelKey: 'iv.catBasic' },
    { id: 'color',    labelKey: 'iv.catColor' },
    { id: 'effects',  labelKey: 'iv.catEffects' },
];

// Modèle de valeur :
//   - zonal : `zones` porte 4 valeurs de bande ; `default` = valeur neutre.
//   - non zonal : `value` est utilisée telle quelle (px, %, ratio).
//   - `raw: true` : la valeur slider == la valeur modèle (degrés hue, px).
//   - `unit` : suffixe d'affichage ('px', '%', '°').
export const CONTROL_TYPES = [
    { id: 'brightness', category: 'basic',   default: 1, min: 0, max: 200, step: 1, zonal: true },
    { id: 'contrast',   category: 'basic',   default: 1, min: 0, max: 200, step: 1, zonal: true },
    { id: 'saturation', category: 'color',   default: 1, min: 0, max: 200, step: 1, zonal: true },
    { id: 'hue',        category: 'color',   default: 0, min: -180, max: 180, step: 1, raw: true, zonal: true },
    { id: 'blur',       category: 'effects', default: 8, min: 0, max: 50, step: 0.5, raw: true, unit: 'px' },
    { id: 'pixelate',   category: 'effects', default: 12, min: 2, max: 64, step: 1, raw: true, unit: 'px' },
    { id: 'vignette',   category: 'effects', default: 0.5, min: 0, max: 100, step: 1, unit: '%' },
    { id: 'sharpen',    category: 'effects', default: 1, min: 0, max: 300, step: 5, unit: '%' },
];

/** Icônes SVG inline (fin des emojis) — `currentColor` pour suivre le thème. */
const _svg = (inner) =>
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" '
    + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

export const CATEGORY_ICONS = {
    geometry: _svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/>'),
    basic:    _svg('<path d="M4 6h9M18 6h2M4 12h2M11 12h9M4 18h7M16 18h4"/><circle cx="15.5" cy="6" r="2.2"/><circle cx="8.5" cy="12" r="2.2"/><circle cx="13.5" cy="18" r="2.2"/>'),
    color:    _svg('<path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.2 0-1 .8-1.6 1.8-1.6H17a4 4 0 0 0 4-4c0-4.4-4-7.9-9-7.9z"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16.5" cy="11" r="1"/>'),
    effects:  _svg('<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z"/>'),
};

export const CONTROL_ICONS = {
    brightness: _svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    contrast:   _svg('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none"/>'),
    saturation: _svg('<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>'),
    hue:        _svg('<circle cx="12" cy="12" r="9"/><path d="M12 3v18M3 12h18" opacity=".55"/><circle cx="12" cy="12" r="3.2"/>'),
    blur:       _svg('<circle cx="12" cy="12" r="9" opacity=".3"/><circle cx="12" cy="12" r="5.2" opacity=".55"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/>'),
    pixelate:   _svg('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>'),
    vignette:   _svg('<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="12" r="4.5"/>'),
    sharpen:    _svg('<path d="M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>'),
    crop:       _svg('<path d="M6 2v16h16"/><path d="M2 6h16v16"/>'),
    mask:       _svg('<path d="M12 3l7 4v6c0 4-3 6.5-7 8-4-1.5-7-4-7-8V7z"/><path d="M9 12l2 2 4-4"/>'),
};

/** Échappe une chaîne pour une interpolation HTML sûre. */
export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => {
        switch (ch) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#39;';
            default: return ch;
        }
    });
}

/** Retrouve la définition d'un type de contrôle (undefined pour 'mask'). */
export function findControlDef(typeId) {
    return CONTROL_TYPES.find((c) => c.id === typeId);
}

/** Vrai si le type est zonaux (brightness/contrast/saturation/hue). */
export function isZonalType(typeId) {
    const def = findControlDef(typeId);
    return !!(def && def.zonal);
}

/** Zones neutres d'un type zonaux ({all,shadows,midtones,highlights}). */
export function neutralZones(typeId) {
    const def = findControlDef(typeId);
    const n = def ? def.default : 0;
    return { all: n, shadows: n, midtones: n, highlights: n };
}

function _isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

/** Valeur d'une zone en tenant compte des clés absentes (= neutre). */
export function zoneValue(zones, typeId, zone) {
    const neutral = neutralZones(typeId)[zone];
    const v = zones ? zones[zone] : undefined;
    return _isNum(v) ? v : neutral;
}

/**
 * Résout les 4 zones d'un contrôle zonal, en tolérant le format v1
 * ({value, range}) si `zones` est absent.
 */
export function zonesFromControl(ctrl) {
    const neutral = neutralZones(ctrl && ctrl.type);
    const src = ctrl && ctrl.zones && typeof ctrl.zones === 'object' ? ctrl.zones : null;
    if (src) {
        const out = { ...src };
        for (const k of ZONE_KEYS) out[k] = _isNum(src[k]) ? src[k] : neutral[k];
        return out;
    }
    // v1 : {value, range} → zones[range||'all'] = value, le reste neutre.
    // Un `range` inconnu, vide ou non-string retombe sur 'all' (parité stricte
    // avec le backend, holaf_image_viewer_backend/logic.py) : la valeur n'est
    // JAMAIS perdue (sinon toutes les zones restent neutres = donnée détruite).
    const out = { ...neutral };
    const range = (ctrl && typeof ctrl.range === 'string' && ZONE_KEYS.includes(ctrl.range))
        ? ctrl.range
        : 'all';
    if (_isNum(ctrl && ctrl.value)) out[range] = ctrl.value;
    return out;
}

/**
 * Liste les passes non neutres d'un contrôle zonal (ordre ZONE_KEYS).
 * @returns {Array<{zone:string, value:number}>}
 */
export function controlZonePasses(ctrl) {
    if (!ctrl || !isZonalType(ctrl.type)) return [];
    const zones = zonesFromControl(ctrl);
    const neutral = neutralZones(ctrl.type);
    const passes = [];
    for (const k of ZONE_KEYS) {
        if (Math.abs(zones[k] - neutral[k]) > 1e-9) passes.push({ zone: k, value: zones[k] });
    }
    return passes;
}

/** Vrai si le contrôle a un réglage zonaux hors « all » (exige le canvas). */
export function controlHasRangedZone(ctrl) {
    return controlZonePasses(ctrl).some((p) => p.zone !== 'all');
}

/** Vrai si AU MOINS un contrôle exige le rendu canvas (zone ≠ « all »). */
export function hasRangedZones(controls) {
    return (controls || []).some(controlHasRangedZone);
}

/**
 * Filtre CSS rapide agrégé depuis la zone « all » des contrôles zonaux.
 * Ne doit être utilisé que quand `hasRangedZones()` est faux (ou en repli).
 */
export function buildCssFilterFromControls(controls) {
    let b = 1, c = 1, s = 1, h = 0;
    for (const ctrl of controls || []) {
        if (!isZonalType(ctrl.type)) continue;
        const v = zoneValue(zonesFromControl(ctrl), ctrl.type, 'all');
        if (ctrl.type === 'brightness') b = v;
        if (ctrl.type === 'contrast') c = v;
        if (ctrl.type === 'saturation') s = v;
        if (ctrl.type === 'hue') h = v;
    }
    return `brightness(${b}) contrast(${c}) saturate(${s}) hue-rotate(${h}deg)`;
}

/**
 * Migration d'un contrôle v1 → v2 (idempotente, conserve les champs inconnus).
 *   - zonaux : construit `zones` puis retire `value`/`range`.
 *   - non zonaux (blur/pixelate/vignette/sharpen/mask) : garde `value`, retire `range`.
 */
export function migrateControlV2(ctrl) {
    if (!ctrl || typeof ctrl !== 'object') return ctrl;
    const def = findControlDef(ctrl.type);
    const out = { ...ctrl };
    if (def && def.zonal) {
        const existing = (out.zones && typeof out.zones === 'object') ? out.zones : {};
        out.zones = { ...existing, ...zonesFromControl(out) };
        delete out.value;
        delete out.range;
    } else {
        delete out.range;
        if (out.value === undefined && def) out.value = def.default;
    }
    return out;
}

/** Migration d'une liste de contrôles (retourne un nouveau tableau). */
export function migrateControlsV2(controls) {
    return (Array.isArray(controls) ? controls : []).map(migrateControlV2);
}

/**
 * Migration d'un état d'édition complet (v1 → v2), idempotente.
 * Pose `v: 2` et migre les contrôles ; conserve tous les autres champs.
 */
export function normalizeStateV2(state) {
    if (!state || typeof state !== 'object') return state;
    return {
        ...state,
        v: SCHEMA_VERSION,
        controls: migrateControlsV2(state.controls),
    };
}

/**
 * Construit l'état `edits` envoyé au serveur : version + contrôles migrés.
 * (Le serveur reste seul décideur du stockage des masks PNG.)
 */
export function buildSaveEdits(state) {
    return normalizeStateV2(state);
}

// ── Picker V4 master-detail (HTML pur, labels déjà résolus) ─────────────────

/**
 * @typedef {{id:string,label:string,icon?:string}} PickerItem
 * @typedef {{id:string,label:string,icon?:string,items:PickerItem[]}} PickerFamily
 */

function _familyHtml(f, activeId) {
    const active = f.id === activeId;
    return `<div class="aih-picker-family${active ? ' active' : ''}" data-family="${escapeHtml(f.id)}" `
        + `role="tab" tabindex="0" aria-selected="${active ? 'true' : 'false'}">`
        + `<span class="aih-picker-family-icon">${f.icon || ''}</span>`
        + `<span class="aih-picker-family-name">${escapeHtml(f.label)}</span>`
        + `<span class="aih-picker-family-count">${f.items.length}</span>`
        + '</div>';
}

function _itemHtml(it) {
    return `<div class="aih-picker-item" data-pick="${escapeHtml(it.id)}" role="button" tabindex="0">`
        + `<span class="aih-picker-item-icon">${it.icon || ''}</span>`
        + `<span class="aih-picker-item-name">${escapeHtml(it.label)}</span>`
        + '<span class="aih-picker-item-plus">＋</span>'
        + '</div>';
}

/** Colonne gauche : familles + compteur. */
export function buildPickerFamiliesHTML(families, activeId) {
    return (families || []).map((f) => _familyHtml(f, activeId)).join('');
}

/** Colonne droite : contrôles de la famille active. */
export function buildPickerItemsHTML(family) {
    return family && family.items ? family.items.map(_itemHtml).join('') : '';
}

/** Picker complet (deux colonnes) pour la famille active. */
export function buildPickerHTML(families, activeId) {
    const list = families || [];
    const active = list.find((f) => f.id === activeId) || list[0] || null;
    return '<div class="aih-picker-v4">'
        + '<div class="aih-picker-families" role="tablist">'
        + buildPickerFamiliesHTML(list, active ? active.id : null)
        + '</div>'
        + '<div class="aih-picker-controls" role="listbox">'
        + buildPickerItemsHTML(active)
        + '</div>'
        + '</div>';
}

/**
 * Construit les familles du picker depuis CONTROL_CATEGORIES/CONTROL_TYPES.
 * @param {(id:string)=>string} labelFor libellé d'un type de contrôle
 * @param {(key:string, params?:object)=>string} translate traducteur i18n
 * @returns {PickerFamily[]}
 */
export function buildControlPickerFamilies(labelFor, translate) {
    const families = CONTROL_CATEGORIES.map((cat) => {
        const items = CONTROL_TYPES
            .filter((ct) => ct.category === cat.id)
            .map((ct) => ({ id: ct.id, label: labelFor(ct.id), icon: CONTROL_ICONS[ct.id] }));
        if (cat.id === 'geometry') {
            items.push({ id: 'crop', label: translate('iv.cropItem'), icon: CONTROL_ICONS.crop });
        }
        return { id: cat.id, label: translate(cat.labelKey), icon: CATEGORY_ICONS[cat.id], items };
    }).filter((f) => f.items.length > 0);
    families.push({
        id: 'mask',
        label: translate('iv.maskGroup'),
        icon: CONTROL_ICONS.mask,
        items: [{ id: 'mask', label: translate('iv.createMask'), icon: CONTROL_ICONS.mask }],
    });
    return families;
}
