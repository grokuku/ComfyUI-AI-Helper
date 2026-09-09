/*
 * Copyright (C) 2026 Holaf
 * AIH Toast Bridge — pont vers la brique HolafToast (js/vendor/holaf/holaf-toast.js).
 *
 * Point d'entrée UNIQUE pour toutes les notifications de l'extension. Il :
 *   - importe la brique HolafToast (auto-injecte son CSS, zéro dépendance) ;
 *   - calcule un thème 'aih' à partir des variables CSS du <body> (--aih-* /
 *     --holaf-*) et l'enregistre dans le registre de thèmes de la brique ;
 *   - expose showToast / updateToast / hideToast qui synchronisent le thème
 *     à CHAQUE show (robuste, sans dépendance aux événements de thème) puis
 *     délèguent à HolafToast.
 *
 * Le module est self-contained : il suffit de l'importer pour que les toasts
 * fonctionnent (même en mode standalone, sans holaf_main.js).
 */

import { HolafToast } from "./vendor/holaf/holaf-toast.js";

const THEME_NAME = "aih";

// Lit une variable CSS depuis le style calculé du <body> (hérite de :root).
function cssVar(name, fallback) {
    try {
        const el = (typeof document !== "undefined" && document.body) || document.documentElement;
        const cs = getComputedStyle(el);
        const v = cs.getPropertyValue(name).trim();
        return v || fallback || "";
    } catch (e) {
        return fallback || "";
    }
}

// Mélange un fond avec un accent (lerp RGB à `ratio`, ~15 %) → hex #rrggbb.
// Tolère #rgb / #rrggbb. Retourne null si l'accent (ou le fond) est absent ou
// illisible : dans ce cas la clé n'est PAS émise et la brique retombe sur
// --ht-bg (rétrocompatibilité).
function mixBg(bg, accent, ratio) {
    const parse = (hex) => {
        if (typeof hex !== "string") return null;
        let h = hex.trim().replace(/^#/, "");
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
        return [
            parseInt(h.slice(0, 2), 16),
            parseInt(h.slice(2, 4), 16),
            parseInt(h.slice(4, 6), 16),
        ];
    };
    const b = parse(bg);
    const a = parse(accent);
    if (!b || !a) return null;
    const to2 = (n) => n.toString(16).padStart(2, "0");
    const r = Math.round(b[0] + (a[0] - b[0]) * ratio);
    const g = Math.round(b[1] + (a[1] - b[1]) * ratio);
    const bl = Math.round(b[2] + (a[2] - b[2]) * ratio);
    return "#" + to2(r) + to2(g) + to2(bl);
}

// Calcule les variables --ht-* de la brique depuis les vars du thème AIH.
function computeThemeVars() {
    const accent = cssVar("--aih-accent", cssVar("--holaf-accent-color", "#4682B4"));
    const bg = cssVar("--aih-bg", cssVar("--holaf-background-primary", "#1C2024"));
    const fg = cssVar("--aih-text", cssVar("--holaf-text-primary", "#D0D8E0"));
    const border = cssVar("--aih-border", cssVar("--holaf-border-color", "#36404A"));
    const success = cssVar("--aih-success", cssVar("--holaf-success-color", "#4CAF50"));
    const danger = cssVar("--aih-danger", cssVar("--holaf-error-color", "#F44336"));
    const warning = cssVar("--aih-warning", cssVar("--holaf-warning-color", ""));
    const shadow = cssVar("--aih-shadow", cssVar("--holaf-box-shadow", "0 6px 24px rgba(0, 0, 0, 0.5)"));
    const radius = cssVar("--aih-radius", "10px");

    const vars = {
        "--ht-bg": bg,
        "--ht-fg": fg,
        "--ht-border": border,
        "--ht-accent-info": accent,
        "--ht-accent-success": success,
        "--ht-accent-warning": accent,
        "--ht-accent-error": danger,
        "--ht-shadow": shadow,
        "--ht-radius": radius,
    };

    // Fonds teintés PAR TYPE (brique v0.4.0) : ~15 % de l'accent du type
    // mélangé dans --ht-bg. Source des teintes : vars sémantiques du pack
    // (--aih-success / --aih-danger / --aih-warning, définies par mode dark/
    // light dans holaf_themes.css). PAS de --ht-bg-info : le type info reste
    // neutre (fond --ht-bg via le fallback du CSS). Échappatoire : un hôte
    // peut overrider par toast via theme.vars (--ht-bg-<type> posé en inline
    // gagne sur tout dans la chaîne de fallback de la brique).
    const tint = (accentColor) => mixBg(bg, accentColor, 0.15);
    const tinted = {
        "--ht-bg-success": tint(success),
        "--ht-bg-error": tint(danger),
        "--ht-bg-warning": tint(warning),
    };
    for (const key in tinted) {
        if (tinted[key]) vars[key] = tinted[key];
    }
    return vars;
}

// Enregistre / met à jour le thème 'aih' dans le registre de la brique.
function syncTheme() {
    try {
        HolafToast.themes.update(THEME_NAME, computeThemeVars());
    } catch (e) { /* silencieux : repli sur les défauts CSS de la brique */ }
}

// Affiche un toast. Synchronise le thème 'aih' puis délègue à HolafToast.
function showToast(opts) {
    syncTheme();
    const o = Object.assign({}, opts);
    if (o.theme === undefined) o.theme = THEME_NAME;
    return HolafToast.show(o);
}

// Met à jour un toast existant (par id métier ou référence ctrl).
function updateToast(id, opts) {
    return HolafToast.update(id, opts);
}

// Ferme un toast existant (par id métier ou référence ctrl).
function hideToast(id) {
    return HolafToast.hide(id);
}

// Exposition globale (scripts classiques / contexte non-module).
if (typeof window !== "undefined") {
    window.AIHToast = {
        show: showToast,
        update: updateToast,
        hide: hideToast,
        syncTheme: syncTheme,
    };
}

export { showToast, updateToast, hideToast, syncTheme, HolafToast };
