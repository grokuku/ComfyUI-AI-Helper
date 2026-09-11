/*
 * Copyright (C) 2025 Holaf
 * Holaf Utilities - Shared Themes
 *
 * This file centralizes the theme definitions to be used across multiple
 * UI components, preventing circular dependencies.
 */

export const HOLAF_THEMES = [
    {
        name: "Graphite Orange",
        className: "holaf-theme-graphite-orange",
        base: "dark",
        colors: {
            accent: "#D8700D",
            backgroundPrimary: "#1E1E1E",
            backgroundSecondary: "#2B2B2B",
            textPrimary: "#E0E0E0",
            textSecondary: "#A0A0A0",
            border: "#3F3F3F",
            selectionBackground: "#555555",
            cursor: "#D8700D",
            buttonBackground: "#D8700D",
            buttonText: "#FFFFFF",
            inputBackground: "#1A1A1A",
            tagBackground: "#4F4F4F",
            tagText: "#DADADA"
        }
    },
    {
        name: "Midnight Purple",
        className: "holaf-theme-midnight-purple",
        base: "dark",
        colors: {
            accent: "#8A2BE2",
            backgroundPrimary: "#1C1C2E",
            backgroundSecondary: "#2A2A40",
            textPrimary: "#E0D8F0",
            textSecondary: "#9890B0",
            border: "#383850",
            selectionBackground: "#4A3A5E",
            cursor: "#8A2BE2",
            buttonBackground: "#8A2BE2",
            buttonText: "#FFFFFF",
            inputBackground: "#181828",
            tagBackground: "#4A3A5E",
            tagText: "#E0D8F0"
        }
    },
    {
        name: "Forest Green",
        className: "holaf-theme-forest-green",
        base: "dark",
        colors: {
            accent: "#228B22",
            backgroundPrimary: "#1A241A",
            backgroundSecondary: "#283A28",
            textPrimary: "#D0E0D0",
            textSecondary: "#809080",
            border: "#304830",
            selectionBackground: "#3A5E3A",
            cursor: "#228B22",
            buttonBackground: "#228B22",
            buttonText: "#FFFFFF",
            inputBackground: "#162016",
            tagBackground: "#3A5E3A",
            tagText: "#D0E0D0"
        }
    },
    {
        name: "Steel Blue",
        className: "holaf-theme-steel-blue",
        base: "dark",
        colors: {
            accent: "#4682B4",
            backgroundPrimary: "#1C2024",
            backgroundSecondary: "#2A3038",
            textPrimary: "#D0D8E0",
            textSecondary: "#808890",
            border: "#36404A",
            selectionBackground: "#3A4E5E",
            cursor: "#4682B4",
            buttonBackground: "#4682B4",
            buttonText: "#FFFFFF",
            inputBackground: "#181C20",
            tagBackground: "#3A4E5E",
            tagText: "#D0D8E0"
        }
    },
    {
        name: "Ashy Light",
        className: "holaf-theme-ashy-light",
        base: "light",
        colors: {
            accent: "#607D8B",
            backgroundPrimary: "#EAEAEA",
            backgroundSecondary: "#F0F0F0",
            textPrimary: "#263238",
            textSecondary: "#546E7A",
            border: "#CDCDCD",
            selectionBackground: "#CFD8DC",
            cursor: "#455A64",
            buttonBackground: "#607D8B",
            buttonText: "#FFFFFF",
            inputBackground: "#FFFFFF",
            tagBackground: "#E0E0E0",
            tagText: "#37474F"
        }
    }
];

/* ════════════════════════════════════════════════════════════════════════
   THEMING 4 AXES orthogonaux : MODE / ACCENT / HALO / HIGHLIGHT
   Source de vérité partagée (CSS holaf_themes.css + API JS).
   ════════════════════════════════════════════════════════════════════════ */

// AXE 1 — MODE (clair/foncé, fenêtres GRISES)
export const AIH_MODES = {
    dark:  { className: "aih-mode-dark",  label: "Dark",  base: "dark"  },
    light: { className: "aih-mode-light", label: "Light", base: "light" },
};

export const AIH_DEFAULT_MODE = "dark";

// AXE 2 — ACCENT (couleur de marque, adaptée au mode)
export const AIH_ACCENTS = {
    orange: { className: "aih-accent-orange", label: "Orange" },
    blue:   { className: "aih-accent-blue",   label: "Blue"   },
    green:  { className: "aih-accent-green",  label: "Green"  },
    purple: { className: "aih-accent-purple", label: "Purple" },
};

export const AIH_DEFAULT_ACCENT = "orange";

// Clés de persistance (localStorage)
export const THEME_STORAGE = {
    mode: "AIH_Mode",
    accent: "AIH_Accent",
    halo: "AIH_Halo",
    highlight: "AIH_Highlight",
    haloIntensity: "AIH_Halo_Intensity",
    highlightIntensity: "AIH_Highlight_Intensity",
};

// Migration depuis l'ancienne clé combinée `Holaf_Theme` (désormais obsolète).
const LEGACY_THEME_MAP = {
    "holaf-theme-graphite-orange":  { mode: "dark",  accent: "orange" },
    "holaf-theme-midnight-purple":  { mode: "dark",  accent: "purple" },
    "holaf-theme-forest-green":     { mode: "dark",  accent: "green"  },
    "holaf-theme-steel-blue":       { mode: "dark",  accent: "blue"   },
    "holaf-theme-ashy-light":       { mode: "light", accent: "blue"   },
};

export const AIH_THEME_DEFAULT = { mode: AIH_DEFAULT_MODE, accent: AIH_DEFAULT_ACCENT, halo: true, haloIntensity: 50, highlight: true, highlightIntensity: 100 };

/**
 * Applique l'état {mode, accent, halo, highlight} sur un élément cible
 * (généralement <body>). Retire les classes d'axes précédentes puis ajoute les
 * nouvelles. Les panneaux et dialogues descendants héritent des variables via CSS.
 */
export function applyThemeState(target, state) {
    const el = target || (typeof document !== "undefined" ? document.body : null);
    if (!el) return state || AIH_THEME_DEFAULT;
    const s = state || {};

    // Purge LÉGACY sur la racine globale (<body>) : les anciennes classes
    // combinées `.holaf-theme-*` redéfinissent des variables --holaf-* en dur
    // PLUS BAS dans holaf_themes.css que les règles `.aih-mode-*` /
    // `.aih-accent-*` (même spécificité → la règle la plus basse gagne) et
    // écrasaient donc l'accent/mode 4-axes posés sur <body> : l'alias global
    // `--holaf-accent-color` restait figé à la palette legacy et la couleur
    // choisie dans les réglages ne s'appliquait qu'aux éléments portant la
    // classe accent DIRECTEMENT (ex. la modale des réglages). Les thèmes
    // legacy par-panel (classe posée sur la fenêtre elle-même par les widgets,
    // ex. nodes manager / terminal / image viewer) ne sont PAS touchés : cette
    // purge ne concerne que la source de vérité globale <body>.
    if (el === (typeof document !== "undefined" ? document.body : null)) {
        HOLAF_THEMES.forEach((legacy) => el.classList.remove(legacy.className));
    }

    const mode = (s.mode && AIH_MODES[s.mode]) ? s.mode : AIH_DEFAULT_MODE;
    const accent = (s.accent && AIH_ACCENTS[s.accent]) ? s.accent : AIH_DEFAULT_ACCENT;
    const halo = s.halo !== false;
    const highlight = s.highlight !== false;

    // Mode : retire les deux classes, garde celle active.
    Object.keys(AIH_MODES).forEach((k) => el.classList.remove(AIH_MODES[k].className));
    el.classList.add(AIH_MODES[mode].className);

    // Accent : idem.
    Object.keys(AIH_ACCENTS).forEach((k) => el.classList.remove(AIH_ACCENTS[k].className));
    el.classList.add(AIH_ACCENTS[accent].className);

    // Halo : classe neutralisante toggle.
    el.classList.toggle("aih-halo-off", !halo);

    // Highlight : classe neutralisante toggle (indépendante du halo).
    el.classList.toggle("aih-highlight-off", !highlight);

    // Intensités (0-100) : posées en inline style sur la cible, héritées par
    // les panneaux et dialogues descendants. Clampées pour éviter les abus.
    const haloIntensity = Math.max(0, Math.min(100, parseInt(s.haloIntensity ?? 50, 10) || 0));
    const highlightIntensity = Math.max(0, Math.min(100, parseInt(s.highlightIntensity ?? 100, 10) || 0));
    el.style.setProperty("--aih-halo-intensity", String(haloIntensity));
    el.style.setProperty("--aih-highlight-intensity", String(highlightIntensity));

    return { mode, accent, halo, haloIntensity, highlight, highlightIntensity };
}

/**
 * Lit l'état persisté depuis localStorage, avec migration depuis l'ancienne
 * clé Holaf_Theme le cas échéant.
 */
export function loadThemeState() {
    let mode = AIH_DEFAULT_MODE;
    let accent = AIH_DEFAULT_ACCENT;
    let halo = true;
    let highlight = true;
    let haloIntensity = 50;
    let highlightIntensity = 100;

    try {
        const m = localStorage.getItem(THEME_STORAGE.mode);
        if (m && AIH_MODES[m]) mode = m;
        const a = localStorage.getItem(THEME_STORAGE.accent);
        if (a && AIH_ACCENTS[a]) accent = a;
        const h = localStorage.getItem(THEME_STORAGE.halo);
        if (h !== null) halo = h !== "0" && h !== "false";
        const hl = localStorage.getItem(THEME_STORAGE.highlight);
        if (hl !== null) highlight = hl !== "0" && hl !== "false";
        const hi = localStorage.getItem(THEME_STORAGE.haloIntensity);
        if (hi !== null) haloIntensity = Math.max(0, Math.min(100, parseInt(hi, 10) || 0));
        const hli = localStorage.getItem(THEME_STORAGE.highlightIntensity);
        if (hli !== null) highlightIntensity = Math.max(0, Math.min(100, parseInt(hli, 10) || 0));
    } catch (e) { /* silencieux */ }

    // Migration d'une ancienne clé Holaf_Theme (si rien n'est encore persisté).
    try {
        const hasNew = localStorage.getItem(THEME_STORAGE.mode) !== null ||
            localStorage.getItem(THEME_STORAGE.accent) !== null;
        if (!hasNew) {
            const legacy = localStorage.getItem("Holaf_Theme");
            const mapped = legacy && LEGACY_THEME_MAP[legacy];
            if (mapped) {
                mode = mapped.mode;
                accent = mapped.accent;
            }
        }
    } catch (e) { /* silencieux */ }

    return { mode, accent, halo, haloIntensity, highlight, highlightIntensity };
}

/**
 * Persiste l'état {mode, accent, halo, highlight}.
 */
export function saveThemeState(state) {
    const s = state || {};
    try {
        if (s.mode !== undefined) localStorage.setItem(THEME_STORAGE.mode, s.mode);
        if (s.accent !== undefined) localStorage.setItem(THEME_STORAGE.accent, s.accent);
        if (s.halo !== undefined) localStorage.setItem(THEME_STORAGE.halo, s.halo ? "1" : "0");
        if (s.highlight !== undefined) localStorage.setItem(THEME_STORAGE.highlight, s.highlight ? "1" : "0");
        if (s.haloIntensity !== undefined) localStorage.setItem(THEME_STORAGE.haloIntensity, String(Math.max(0, Math.min(100, parseInt(s.haloIntensity, 10) || 0))));
        if (s.highlightIntensity !== undefined) localStorage.setItem(THEME_STORAGE.highlightIntensity, String(Math.max(0, Math.min(100, parseInt(s.highlightIntensity, 10) || 0))));
    } catch (e) { /* silencieux */ }
}

/**
 * Applique l'état persisté sur <body> (appelé au chargement).
 */
export function applyPersistedTheme(target) {
    const el = target || (typeof document !== "undefined" ? document.body : null);
    const state = loadThemeState();
    applyThemeState(el, state);
    return state;
}