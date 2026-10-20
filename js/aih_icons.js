/*
 * Copyright (C) 2026 Holaf
 * AIH Icons — façade locale de la brique HolafIcons (js/vendor/holaf/holaf-icons.js).
 *
 * ── Rôle ────────────────────────────────────────────────────────────────────
 * Même pattern que les autres briques du pack (fetch, toast, …) : la copie
 * vendorisée est INTOUCHABLE (jamais éditée à la main ; toute évolution passe
 * par holaf-lib puis `scripts/holaf upgrade`) et un petit ADAPTATEUR LOCAL
 * expose l'API dont l'UI du pack a besoin. L'adaptateur ne fait que quatre
 * choses :
 *
 *   1. CACHE. La brique rend des CHAÎNES complètes (`<svg …>tracés</svg>`).
 *      Le corps (les tracés, sans le wrapper) est extrait UNE fois par nom puis
 *      mémorisé, avec la liste des attributs du `<svg>` racine telle que la
 *      brique l'a produite. La table d'icônes de la brique est STATIQUE : le
 *      cache n'est jamais invalidé (aucun risque de périmé) et évite de
 *      reparser/rereconstruire à chaque rendu.
 *
 *   2. RENDU DOM. `aihIconEl` produit un élément `<span class="aih-icon">`
 *      possédant un `<svg>` créé par l'hôte (pas de innerHTML de chaîne
 *      complète chez les appelants, un seul point à corriger si la brique
 *      change de forme).
 *
 *   3. ACCESSIBILITÉ. Une icône est DÉCORATIVE par défaut : `aihIconSvg`
 *      marque le `<svg>` `aria-hidden="true"` + `focusable="false"` (une
 *      chaîne destinée à `innerHTML` ne peut pas porter de nom accessible),
 *      `aihIconEl` porte `aria-hidden="true"` sur le `<span>` et son `<svg>`.
 *      Si l'appelant fournit `label`, le sens est porté par le `<span>` :
 *      `role="img"` + `aria-label`, sans aria-hidden.
 *      `title` ajoute seulement l'infobulle native — il ne rend PAS l'icône
 *      annonçable (utiliser `label` pour cela).
 *
 *   4. DÉGRADATION SÛRE. La brique lève une exception sur un nom inconnu. Cette
 *      exception ne doit JAMAIS remonter dans l'UI : un nom inconnu (ou une
 *      forme SVG inattendue) produit un `console.warn` — UNE seule fois par nom,
 *      pour ne pas noyer la console d'un widget qui se redessine — et rend :
 *        - `aihIconSvg`  → chaîne VIDE ("") ;
 *        - `aihIconEl`   → `<span class="aih-icon" aria-hidden="true">` VIDE,
 *                          donc inerte (aucune icône, aucun texte, aucune
 *                          exception, mise en page stable : le span existe).
 *
 * ── Garanties ──────────────────────────────────────────────────────────────
 *   - AUCUN CSS n'est injecté : la couleur vient de `currentColor` de l'hôte
 *     (les tracés sont `stroke="currentColor"`, `fill="none"`,
 *     `stroke-width="2"`, 24×24), la taille vient de `size`.
 *   - Aucun accès au DOM à l'import : le module se charge aussi en Node (seul
 *     `aihIconEl` exige un `document`).
 *   - Import ESM RELATIF comme les autres briques (`./vendor/holaf/…`), pas de
 *     script global : le pack est chargé en module.
 *   - Les attributs racine du `<svg>` proviennent de la BRIQUE (aucune copie
 *     locale du contrat) : si la brique change `viewBox`/`stroke`, la façade
 *     suit sans modification.
 *
 * ── API ────────────────────────────────────────────────────────────────────
 *   aihIconSvg(name, { size, class })            → string SVG ("" si inconnu),
 *                                                décoratif (aria-hidden)
 *   aihIconEl(name, { size, class, title, label })
 *                                               → <span class="aih-icon">…</span>
 *   aihIconNames()                              → noms disponibles (copie)
 *   AIH_ICON_DEFAULT_SIZE                       → 16 (px)
 *
 *   size  : nombre > 0 (width/height du `<svg>`), défaut AIH_ICON_DEFAULT_SIZE.
 *   class : classes transmises au `<svg>` (même sémantique que la brique).
 *
 * ── État ────────────────────────────────────────────────────────────────────
 * PHASE 1 (socle) : façade disponible, aucun changement visuel.
 * PHASE 2a (lot « dialogues / fermer / plein écran / poignée de drag ») : les
 * emoji cosmétiques de 7 fichiers d'UI sont remplacés par ces icônes.
 * PHASE 2b (même famille : fermer / cocher / plein écran / supprimer une ligne)
 * : 5 fichiers de plus — js/holaf_shortcuts.js (coche « enregistré », croix de
 * fermeture et de suppression), js/image_viewer/image_viewer_gallery.js (badge
 * plein écran d'une vignette), js/image_viewer/image_viewer_editor.js
 * (suppression d'un contrôle), js/02_aih_model_browser.js (suppression d'un
 * modèle distant) et js/aih_elements_widget.js (poignée de drag, œil de
 * visibilité, suppression d'une ligne). Le périmètre exact est verrouillé par
 * test_helpers/icon_perimeter.mjs (structure PAR PHASE : PHASES / CURRENT_PHASE)
 * et par test_aih_icons_phase2a.mjs / test_aih_icons_phase2b.mjs ; les emoji
 * SÉMANTIQUES et les emoji assertés par un test existant restent en place (voir
 * la liste interdite du helper).
 * PHASE 2c (menus et boutons d'ACTIONS) : 6 fichiers de plus — js/aih_menu.js
 * (corbeille d'un membre, avatar, indicateur client-side, marque d'erreur),
 * js/holaf_main.js (coche des cases du menu), js/holaf_resolution_preset_v2.js
 * et js/holaf_load_image_video.js (libellés MÊLÉS icône + texte),
 * js/aih_repair_workflow.js (chevrons de dépliage) et js/aih_workflow_share.js
 * (actions de l'onglet Workflows SEULEMENT : ses glyphes de STATUT ⏳♻️✅⏭❌
 * restent du TEXTE, asserté par les tests du module).
 * PHASE 2d (libellés i18n contenant un emoji) : le glyphe était dans le
 * DICTIONNAIRE ; il en est retiré (FR ET EN, parité stricte) et l'icône est
 * séparée AU POINT D'APPEL — js/holaf_main.js (entrées de menu),
 * js/aih_workflow_share.js (onglets, boutons et en-têtes de dépendances),
 * js/aih_repair_workflow.js (Copier / Enregistrer sous) et
 * js/aih_enhance_widget.js (« Test enhance », nouvel entrant du lot). Les
 * emoji de STATUT / de MESSAGE et les contextes incapables de porter une
 * icône (titre de fenêtre, `placeholder`, `<option>`) restent en TEXTE.
 * Une seule voie d'accès : cette façade (jamais la brique vendorisée).
 */

import { HolafIcons } from "./vendor/holaf/holaf-icons.js";

/** Taille par défaut en px (alignée sur les icônes texte des widgets). */
export const AIH_ICON_DEFAULT_SIZE = 16;

const SVG_NS = "http://www.w3.org/2000/svg";

// Cache : nom → { attrs: [[cle, valeur], …], body: "tracés" }.
// Jamais invalidé : la table d'icônes de la brique est STATIQUE.
const _cache = new Map();

// Noms déjà signalés (un seul avertissement par nom).
const _warned = new Set();

/* ─── Utilitaires internes ────────────────────────────────────────────────── */

// Le message de la brique liste les 114 noms : on garde la tête (le nom fautif)
// et la queue (« Proches : … », la partie utile) pour une console lisible.
function _shorten(detail) {
    const s = String(detail);
    if (s.length <= 300) return s;
    return s.slice(0, 120) + " … " + s.slice(-170);
}

// Avertissement DÉDUPLIQUÉ : un widget qui se redessine ne doit pas spammer.
function _warn(name, detail) {
    const key = typeof name === "string" && name.trim() ? name.trim() : String(name);
    if (_warned.has(key)) return;
    _warned.add(key);
    const suffix = detail ? " — " + _shorten(detail) : "";
    console.warn(`[aih_icons] icône « ${key} » indisponible : rendu inerte${suffix}`);
}

// Taille exploitable : nombre fini > 0, sinon défaut (jamais NaN/0/négatif).
function _normalizeSize(size) {
    const n = Number(size);
    return Number.isFinite(n) && n > 0 ? n : AIH_ICON_DEFAULT_SIZE;
}

// Échappement des valeurs d'attributs (class fournie par l'hôte).
function _escapeAttr(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// Sépare le `<svg …>` racine de son corps : { attrs, body } ou null si la
// forme n'est pas celle attendue (dégradation sûre côté appelant).
function _splitSvg(svgText) {
    if (typeof svgText !== "string") return null;
    const open = svgText.indexOf("<svg");
    if (open < 0) return null;
    const openEnd = svgText.indexOf(">", open);
    const close = svgText.lastIndexOf("</svg>");
    if (openEnd < 0 || close <= openEnd) return null;

    const openTag = svgText.slice(open, openEnd + 1);
    const body = svgText.slice(openEnd + 1, close);

    const attrs = [];
    const rx = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = rx.exec(openTag)) !== null) {
        if (m[1] === "svg") continue;
        attrs.push([m[1], m[2]]);
    }
    if (attrs.length === 0) return null;
    return { attrs, body };
}

// Entrée de cache d'une icône ; null si le nom est inconnu/invalide.
// AUCUNE exception ne remonte : l'UI ne doit jamais casser sur une icône.
function _entry(name) {
    const key = typeof name === "string" ? name.trim() : "";
    if (!key) {
        _warn(name, "nom vide");
        return null;
    }
    const hit = _cache.get(key);
    if (hit) return hit;

    let rendered;
    try {
        // Lève si le nom est inconnu (message listant les noms + les proches).
        rendered = HolafIcons.get(key);
    } catch (err) {
        _warn(key, (err && err.message) || "nom inconnu");
        return null;
    }
    const parsed = _splitSvg(rendered);
    if (!parsed) {
        _warn(key, "forme SVG inattendue");
        return null;
    }
    _cache.set(key, parsed);
    return parsed;
}

// Attributs racine : ceux de la brique (moins width/height/class), puis la
// taille demandée et, si fournie, la classe de l'hôte.
function _rootAttrs(entry, size, cls) {
    const attrs = [];
    for (const [k, v] of entry.attrs) {
        if (k === "width" || k === "height" || k === "class") continue;
        attrs.push([k, v]);
    }
    attrs.push(["width", String(size)]);
    attrs.push(["height", String(size)]);
    if (cls) attrs.push(["class", String(cls)]);
    return attrs;
}

/* ─── API publique ──────────────────────────────────────────────────────── */

/**
 * Chaîne SVG d'une icône. Délègue le contenu à la brique, le wrapper est
 * reconstruit depuis le cache (aucun reparse).
 * @param {string} name nom d'icône (voir aihIconNames()).
 * @param {{size?: number, class?: string}} [opts]
 * @returns {string} SVG 24×24 (`stroke="currentColor"`) ou "" si nom inconnu.
 */
export function aihIconSvg(name, opts) {
    const o = opts || {};
    const entry = _entry(name);
    if (!entry) return ""; // dégradation sûre : chaîne vide, pas d'exception
    const cls = o.class || o.className || "";
    let attrs = "";
    for (const [k, v] of _rootAttrs(entry, _normalizeSize(o.size), cls)) {
        attrs += ` ${k}="${_escapeAttr(v)}"`;
    }
    // Une chaîne destinée à `innerHTML` ne peut pas porter de nom accessible :
    // le `<svg>` est donc décoratif par construction (même contrat que le
    // `<svg>` de `aihIconEl`). `focusable="false"` évite le piège de tabulation
    // historique des SVG inline hors navigateurs modernes.
    attrs += ` aria-hidden="true" focusable="false"`;
    return `<svg${attrs}>${entry.body}</svg>`;
}

/**
 * Élément DOM `<span class="aih-icon">` contenant le `<svg>` de l'icône.
 * Décoratif par défaut (span `aria-hidden="true"` + svg `aria-hidden="true"`) ;
 * avec `label` : `role="img"` + `aria-label` sur le span (le svg reste caché).
 * Nom inconnu : span VIDE et inerte (`aria-hidden="true"`), sans exception.
 * @param {string} name nom d'icône.
 * @param {{size?: number, class?: string, title?: string, label?: string}} [opts]
 * @returns {HTMLSpanElement} élément possédé par l'appelant.
 */
export function aihIconEl(name, opts) {
    const o = opts || {};
    if (typeof document === "undefined" || typeof document.createElement !== "function") {
        throw new Error(
            "[aih_icons] aihIconEl exige un DOM : hors navigateur, utiliser aihIconSvg()."
        );
    }

    const span = document.createElement("span");
    span.className = "aih-icon";
    if (typeof name === "string" && name.trim()) {
        span.setAttribute("data-aih-icon", name.trim());
    }

    // Sens porté par le span : labellisé (role=img) ou décoratif (aria-hidden).
    const label = typeof o.label === "string" ? o.label.trim() : "";
    if (label) {
        span.setAttribute("role", "img");
        span.setAttribute("aria-label", label);
    } else {
        span.setAttribute("aria-hidden", "true");
    }
    if (typeof o.title === "string" && o.title) {
        span.setAttribute("title", o.title); // infobulle native, sans effet aria
    }

    const entry = _entry(name);
    if (!entry) return span; // inerte : span vide, pas de throw

    const svg = document.createElementNS(SVG_NS, "svg");
    for (const [k, v] of _rootAttrs(entry, _normalizeSize(o.size), o.class || o.className || "")) {
        svg.setAttribute(k, v);
    }
    // Le svg est décoratif dans les deux cas : le sens est sur le span.
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    try {
        // Corps issu de la brique VENDORISÉE (statique, pas de donnée serveur).
        svg.innerHTML = entry.body;
    } catch (err) {
        _warn(name, "corps SVG non injectable");
        return span;
    }
    span.appendChild(svg);
    return span;
}

/**
 * Noms d'icônes disponibles (copie : l'appelant ne peut pas altérer la brique).
 * @returns {string[]}
 */
export function aihIconNames() {
    try {
        return HolafIcons.list().slice();
    } catch (err) {
        return [];
    }
}
