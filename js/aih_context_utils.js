/*
 * Copyright (C) 2026 Holaf
 * AIH — Fenêtre de contexte LLM : helpers PURS (aucun DOM, aucun accès réseau).
 * ----------------------------------------------------------------------------
 * Source UNIQUE de vérité pour l'affichage de la fenêtre de contexte, partagée
 * par :
 *   - l'onglet « AIH · Provider LLM » (js/aih_menu.js) : badge de source, champ
 *     manuel, message d'échec du bouton « Détecter », résumé dans la liste ;
 *   - la barre de contexte du chat Blobby (js/blobby_companion.js) : texte +
 *     coloration seuil.
 *
 * Règle cardinale : JAMAIS de chiffre inventé. Sans valeur connue (> 0), la
 * fenêtre de contexte est « inconnue » et rendue « ? max » — aucun repli
 * numérique arbitraire (l'ancien repli chiffré en dur est banni).
 *
 * Le module ne dépend PAS de l'i18n : il renvoie des CLÉS de traduction ; les
 * consommateurs traduisent via le helper central t(). Les fonctions acceptant
 * `t` ne font que l'appeler (aucun effet de bord hors DOM ciblé).
 */

/** Sources de contexte reconnues (contrat backend gelé). */
export const CONTEXT_SOURCES = ["manual", "auto", "family", "unknown"];

/**
 * Normalise une source serveur. Toute valeur absente/inconnue → "unknown".
 * @param {*} source
 * @returns {"manual"|"auto"|"family"|"unknown"}
 */
export function normalizeContextSource(source) {
    const s = typeof source === "string" ? source.trim().toLowerCase() : "";
    return CONTEXT_SOURCES.indexOf(s) !== -1 ? s : "unknown";
}

/**
 * true si la valeur est un entier strictement positif exploitable.
 * Rejette null, undefined, "", NaN, 0, négatifs (et "0"/"-1" textuels).
 * @param {*} value
 * @returns {boolean}
 */
export function hasContextLength(value) {
    if (value === null || value === undefined || value === "") return false;
    const n = Number(value);
    return Number.isFinite(n) && n > 0;
}

/**
 * Formate un entier avec séparateur de milliers (espace, indépendant de la
 * locale du navigateur pour un rendu déterministe) : 64000 → "64 000".
 * @param {*} value
 * @returns {string}
 */
export function formatContextCount(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "";
    const digits = String(Math.abs(Math.trunc(n)));
    const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    return (n < 0 ? "-" : "") + grouped;
}

/**
 * Décrit honnêtement une barre de contexte.
 * @param {number} estTokens estimation de tokens du fil (~chars/4).
 * @param {*} maxContext  valeur de fenêtre (int|null|"" → inconnue).
 * @param {*} contextSource source serveur.
 * @returns {{tokens:number,max:number|null,source:string,known:boolean,
 *            estimated:boolean,unknown:boolean,ratio:number|null}}
 */
export function formatContextBar(estTokens, maxContext, contextSource) {
    const known = hasContextLength(maxContext);
    const source = known ? normalizeContextSource(contextSource) : "unknown";
    const max = known ? Number(maxContext) : null;
    const tokensRaw = Number(estTokens);
    const tokens = Number.isFinite(tokensRaw) && tokensRaw > 0 ? Math.round(tokensRaw) : 0;
    return {
        tokens,
        max,
        source,
        known,
        estimated: known && source === "family",
        unknown: !known,
        // ratio uniquement si valeur connue : sinon impossible (jamais inventé).
        ratio: known && max > 0 ? tokens / max : null,
    };
}

/**
 * Couleur de seuil cohérente : rouge > 75 %, jaune > 50 %, sinon neutre.
 * Ratio inconnu (null/NaN) → neutre (jamais d'alerte rouge sur une valeur
 * inventée).
 * @param {number|null} ratio
 * @returns {string}
 */
export function contextBarColor(ratio) {
    if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "#555";
    return ratio > 0.75 ? "#f87171" : (ratio > 0.5 ? "#facc15" : "#555");
}

/**
 * Texte de la barre : `~N tokens | 64 000 max`, `≈ 64 000` (estimation),
 * `?` (inconnu). Jamais de repli chiffré.
 * @param {{tokens:number,max:number|null,estimated:boolean,unknown:boolean}} info
 * @param {(key:string, params?:object)=>string} t
 * @returns {string}
 */
export function contextBarText(info, t) {
    const maxLabel = info.unknown
        ? "?"
        : (info.estimated ? "≈ " + formatContextCount(info.max) : formatContextCount(info.max));
    return t("bl.ctxBar", { tokens: info.tokens, max: maxLabel });
}

/**
 * Applique le rendu (texte + couleur + tooltip + curseur) à un élément.
 * @param {HTMLElement} el
 * @param {object} info résultat de formatContextBar.
 * @param {(key:string, params?:object)=>string} t
 */
export function applyContextBar(el, info, t) {
    if (!el) return;
    el.textContent = contextBarText(info, t);
    el.style.color = info.unknown ? "#555" : contextBarColor(info.ratio);
    const actionable = info.unknown || info.estimated;
    el.title = info.unknown
        ? t("bl.ctxUnknownTitle")
        : (info.estimated ? t("bl.ctxEstimatedTitle") : "");
    el.style.cursor = actionable ? "pointer" : "default";
}

/** Clé i18n du badge de source (onglet Provider LLM). */
export function contextBadgeKey(source) {
    switch (normalizeContextSource(source)) {
        case "manual": return "menu.ctxBadgeManual";
        case "auto": return "menu.ctxBadgeAuto";
        case "family": return "menu.ctxBadgeFamily";
        default: return "menu.ctxBadgeUnknown";
    }
}

/** Clé i18n du tooltip du badge de source. */
export function contextBadgeTitleKey(source) {
    switch (normalizeContextSource(source)) {
        case "manual": return "menu.ctxBadgeManualTitle";
        case "auto": return "menu.ctxBadgeAutoTitle";
        case "family": return "menu.ctxBadgeFamilyTitle";
        default: return "menu.ctxBadgeUnknownTitle";
    }
}

/** Clé i18n du résumé de contexte dans la liste des presets. */
export function contextSummaryKey(source) {
    switch (normalizeContextSource(source)) {
        case "manual": return "menu.ctxSummaryManual";
        case "auto": return "menu.ctxSummaryAuto";
        case "family": return "menu.ctxSummaryFamily";
        default: return "menu.ctxSummaryUnknown";
    }
}

/**
 * Résumé traduit d'un preset : "64 000 tokens (manuel)", "≈ 64 000 tokens
 * (estimation)" ou "? contexte inconnu". Un contexte chiffré mais de source
 * inconnue est signalé comme tel (jamais assimilé à une source devinée).
 * @param {*} maxContext
 * @param {*} contextSource
 * @param {(key:string, params?:object)=>string} t
 * @returns {string}
 */
export function contextSummaryText(maxContext, contextSource, t) {
    const info = formatContextBar(0, maxContext, contextSource);
    if (info.unknown) return t("menu.ctxSummaryUnknown");
    const value = formatContextCount(info.max);
    switch (info.source) {
        case "manual": return t("menu.ctxSummaryManual", { value });
        case "auto": return t("menu.ctxSummaryAuto", { value });
        case "family": return t("menu.ctxSummaryFamily", { value });
        default: return t("menu.ctxSummaryUnknownSource", { value });
    }
}

/**
 * Clé i18n du message d'échec du bouton « Détecter » selon le `status` renvoyé
 * par POST /api/presets/<id>/detect-context. `null` pour "ok" (succès).
 * @param {*} status
 * @returns {string|null}
 */
export function contextDetectStatusKey(status) {
    switch (String(status === null || status === undefined ? "" : status).trim().toLowerCase()) {
        case "unauthorized": return "menu.ctxDetectUnauthorized";
        case "unreachable": return "menu.ctxDetectUnreachable";
        case "not_found": return "menu.ctxDetectNotFound";
        case "blocked": return "menu.ctxDetectBlocked";
        case "ok": return null;
        default: return "menu.ctxDetectFailed";
    }
}
