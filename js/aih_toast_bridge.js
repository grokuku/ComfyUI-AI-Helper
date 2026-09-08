/*
 * Copyright (C) 2026 Holaf
 * AIH Toast Bridge — pont vers la brique HolafToast (vendor/holaf/holaf-toast.js).
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

import { HolafToast } from "../vendor/holaf/holaf-toast.js";

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

// Calcule les variables --ht-* de la brique depuis les vars du thème AIH.
function computeThemeVars() {
    const accent = cssVar("--aih-accent", cssVar("--holaf-accent-color", "#4682B4"));
    const bg = cssVar("--aih-bg", cssVar("--holaf-background-primary", "#1C2024"));
    const fg = cssVar("--aih-text", cssVar("--holaf-text-primary", "#D0D8E0"));
    const border = cssVar("--aih-border", cssVar("--holaf-border-color", "#36404A"));
    const success = cssVar("--aih-success", cssVar("--holaf-success-color", "#4CAF50"));
    const danger = cssVar("--aih-danger", cssVar("--holaf-error-color", "#F44336"));
    const shadow = cssVar("--aih-shadow", cssVar("--holaf-box-shadow", "0 6px 24px rgba(0, 0, 0, 0.5)"));
    const radius = cssVar("--aih-radius", "10px");
    return {
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
