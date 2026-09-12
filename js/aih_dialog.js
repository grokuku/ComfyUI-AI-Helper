/*
 * Copyright (C) 2026 Holaf
 * AIH Dialog — Système unifié de dialogues (FONDATIONS / Vague 0)
 * ----------------------------------------------------------------------------
 * S'ajoute SANS régression : aucun consommateur existant n'est modifié à cette
 * étape. Le module expose un contrat d'API unifié sous window.AIH.Dialog et
 * window.AIH.Theme, puis rebranche les API historiques comme wrappers :
 *   - aihOpenModalV2 / aihShowAlert / aihShowConfirm / aihShowPrompt
 *   - AIH.ask (options style)
 *   - window.HolafModal.show (forward-compatible)
 *
 * Le drag / resize réutilise js/holaf_window_utils.js (makeDraggable /
 * makeResizable). Autorité de z-index unique (compteur partagé).
 *
 * Dépendances : holaf_window_utils.js (drag/resize),
 *               holaf_panel_manager.js (wrapper createDialog),
 *               holaf_ext_base.js (résolution du chemin d'assets / base CSS).
 * CSS : js/css/aih_dialog.css (thème centralisé --aih-*). AUTO-SUFFISANT : le
 *       module injecte sa propre feuille de style (via holafExtUrl, chemin
 *       /extensions/<pack>/css/aih_dialog.css SANS préfixe js/) quand elle est
 *       absente, + fallback inline, afin que les modales soient stylées et
 *       centrées dans TOUT contexte (dont pages standalone servies via route
 *       alias comme le profiler, où aih_dialog.css n'est pas auto-chargé).
 */

import "./aih_i18n.js";
import { makeDraggable, makeResizable, saveWindowRect, loadWindowRect, makeContentZoomable, applyContentZoom, loadZoomLevel, saveZoomLevel, aihWindowManager, AIH_MODAL_Z } from "./holaf_window_utils.js";
import { holafExtUrl } from "./holaf_ext_base.js";
import {
    AIH_MODES,
    AIH_ACCENTS,
    AIH_THEME_DEFAULT,
    applyThemeState,
    loadThemeState,
    saveThemeState,
    applyPersistedTheme,
} from "./holaf_themes.js";

(function () {
    "use strict";

    const AIH = (window.AIH = window.AIH || {});

    // ─── Z-index / actif / halo : autorité UNIQUE partagée ──────────────────
    // Délégation au gestionnaire commun `aihWindowManager` (holaf_window_utils),
    // qui regroupe dialogues AIH ET panneaux holaf sur une seule échelle de
    // z-index et un seul état actif/halo (classe .active).
    const windowManager = aihWindowManager();

    // ─── Utilitaires ─────────────────────────────────────────────────────────
    function isNode(obj) {
        return obj && typeof obj === "object" && obj.nodeType === 1;
    }

    function toPx(val) {
        if (val === undefined || val === null || val === "") return undefined;
        if (typeof val === "number") return val + "px";
        return String(val);
    }

    function parseLen(val, viewportDim) {
        if (typeof val !== "string") return parseInt(val, 10) || 0;
        const s = val.trim();
        if (s.endsWith("px")) return parseFloat(s);
        if (s.endsWith("vw")) return (parseFloat(s) / 100) * window.innerWidth;
        if (s.endsWith("vh")) return (parseFloat(s) / 100) * window.innerHeight;
        if (s.endsWith("%")) return (parseFloat(s) / 100) * viewportDim;
        return parseFloat(s) || 0;
    }

    function clamp(val, min, max) {
        return Math.max(min, Math.min(max, val));
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function slugifyTitle(str) {
        const s = String(str || "")
            .trim()
            .toLowerCase()
            .replace(/<[^>]*>/g, "")
            .replace(/&[a-z0-9#]+;/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
        return s || "window";
    }

    // ─── Auto-injection CSS (module auto-suffisant) ──────────────────────────
    // Un import JS n'importe JAMAIS son CSS. Dans une page standalone servie via
    // route alias (ex. profiler : aih_dialog.js est chargé dynamiquement depuis
    // /extensions/<pack>/), la feuille js/css/aih_dialog.css n'est pas injectée
    // par ComfyUI ; sans elle la modale tombait dans le flux de la page (en bas,
    // sans overlay ni positionnement centré). Ce module s'auto-suffit donc : il
    // injecte sa propre feuille de style dès que celle-ci est absente, dans TOUT
    // contexte. Le chemin d'URL est correct (base des extensions, SANS préfixe
    // "js/" — WEB_DIRECTORY monté directement) via holaf_ext_base.js /
    // window.HOLAF_EXT_BASE. Un fallback inline garantit le rendu même si le
    // <link> échoue (404).
    const DIALOG_CSS_ID = "aih-dialog-css";
    const DIALOG_CSS_INLINE_ID = "aih-dialog-css-inline";
    const DIALOG_CSS_HREF = "css/aih_dialog.css";

    // Fallback inline : garantit centrage (position:fixed), overlay, thème
    // (variables --aih-*) et classes .aih-dialog-* même en cas de 404 du lien.
    // IMPORTANT : les variables sont définies sur :root UNIQUEMENT (jamais sur
    // .aih-dialog-theme au niveau élément) pour que `.aih-halo-off` posé sur un
    // ancêtre (body) puisse neutraliser --aih-halo par héritage.
    const FALLBACK_DIALOG_CSS = `
:root {
    --aih-accent: #D8700D; --aih-accent-hover: #F08020; --aih-accent-light: #B45A08; --aih-accent-light-hover: #9A4D06; --aih-accent-text: #FFFFFF;
    --aih-accent-active: var(--aih-accent); --aih-accent-hover-active: var(--aih-accent-hover);
    --aih-halo-intensity: 50; --aih-highlight-intensity: 100;
    --aih-halo-color: color-mix(in srgb, var(--aih-accent) calc(var(--aih-halo-intensity) * 1%), transparent);
    --aih-halo: 0 0 0 1px var(--aih-halo-color), 0 0 22px 2px var(--aih-halo-color);
    --aih-highlight: color-mix(in srgb, var(--aih-accent-active) calc(var(--aih-highlight-intensity) * 1%), transparent);
    --aih-bg: #1E1E1E; --aih-bg-secondary: #2B2B2B; --aih-bg-input: #1A1A1A; --aih-bg-hover: #353535;
    --aih-text: #E0E0E0; --aih-text-secondary: #A0A0A0;
    --aih-border: #3F3F3F; --aih-border-strong: #555555;
    --aih-danger: #F44336; --aih-danger-hover: #E53935; --aih-danger-text: #FFFFFF; --aih-success: #4CAF50;
    --aih-radius: 10px; --aih-radius-footer: 8px;
    --aih-shadow: 0 16px 48px rgba(0,0,0,0.6); --aih-shadow-active: var(--aih-halo);
    --aih-overlay-bg: rgba(0,0,0,0.55); --aih-busy-bg: rgba(30,30,30,0.72);
    --aih-font-size: 13px; --aih-title-size: 14px; --aih-title-weight: 600;
    --aih-btn-bg: #3A3A3E; --aih-btn-bg-hover: #4A4A4E; --aih-btn-border: #555555;
    --aih-close-color: #999999; --aih-close-hover: #F87171; --aih-input-focus: #D8700D;
    --aih-resize-handle: #555555; --aih-resize-handle-active: var(--aih-accent-active);
}
.aih-dialog-root { position: fixed; display: flex; flex-direction: column; background: var(--aih-bg); border: 1px solid var(--aih-border); border-radius: var(--aih-radius); box-shadow: var(--aih-shadow); overflow: hidden; min-width: 280px; min-height: 120px; color: var(--aih-text); font-size: var(--aih-font-size); line-height: 1.5; box-sizing: border-box; }
.aih-halo-off { --aih-halo: 0 0 0 0 transparent; --aih-shadow-active: var(--aih-shadow); }
.aih-highlight-off { --aih-highlight: transparent; }
.aih-dialog-root.active { border-color: var(--aih-highlight); box-shadow: var(--aih-shadow-active); }
.aih-dialog-overlay { position: fixed; inset: 0; background: var(--aih-overlay-bg); z-index: 90000; }
.aih-dialog-header { display: flex; align-items: center; padding: 10px 16px; cursor: grab; user-select: none; border-bottom: 1px solid var(--aih-border); background: var(--aih-bg-secondary); flex-shrink: 0; }
.aih-dialog-title { flex: 1; font-size: var(--aih-title-size); font-weight: var(--aih-title-weight); color: var(--aih-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aih-dialog-header-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; margin-left: auto; }
.aih-dialog-close { background: none; border: none; color: var(--aih-close-color); cursor: pointer; font-size: 16px; padding: 0 4px; line-height: 1; flex-shrink: 0; transition: color 0.15s; }
.aih-dialog-close:hover { color: var(--aih-close-hover); }
.aih-zoom-controls { display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; margin-right: 4px; }
.aih-dialog-zoom { background: none; border: 1px solid var(--aih-border); color: var(--aih-close-color); cursor: pointer; font-size: 14px; line-height: 1; width: 22px; height: 22px; padding: 0; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.aih-dialog-zoom:hover { color: var(--aih-text); border-color: var(--aih-accent-active); }
.aih-dialog-body { flex: 1; padding: 16px; overflow-y: auto; overflow-x: hidden; color: var(--aih-text); font-size: var(--aih-font-size); }
.aih-dialog-footer { display: flex; justify-content: flex-end; align-items: center; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--aih-border); background: var(--aih-bg-secondary); border-radius: 0 0 var(--aih-radius-footer) var(--aih-radius-footer); flex-shrink: 0; }
.aih-dialog-btn { padding: 6px 16px; border-radius: 6px; border: 1px solid var(--aih-btn-border); background: var(--aih-btn-bg); color: var(--aih-text); cursor: pointer; font-size: var(--aih-font-size); transition: background 0.15s, border-color 0.15s; }
.aih-dialog-btn:hover { background: var(--aih-btn-bg-hover); border-color: var(--aih-border-strong); }
.aih-dialog-btn-primary { background: var(--aih-accent-active); border-color: var(--aih-accent-active); color: var(--aih-accent-text); }
.aih-dialog-btn-primary:hover { background: var(--aih-accent-hover-active); border-color: var(--aih-accent-hover-active); }
.aih-dialog-btn-danger { background: var(--aih-danger); border-color: var(--aih-danger); color: var(--aih-danger-text); }
.aih-dialog-btn-danger:hover { background: var(--aih-danger-hover); border-color: var(--aih-danger-hover); }
.aih-dialog-btn-cancel { background: var(--aih-btn-bg); border-color: var(--aih-btn-border); color: var(--aih-text); }
.aih-dialog-btn-cancel:hover { background: var(--aih-btn-bg-hover); border-color: var(--aih-border-strong); }
.aih-dialog-btn:disabled { opacity: 0.45; cursor: not-allowed; filter: grayscale(0.35); background: var(--aih-btn-bg); border-color: var(--aih-btn-border); color: var(--aih-text-secondary); }
.aih-dialog-input { width: 100%; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--aih-border); background: var(--aih-bg-input); color: var(--aih-text); font-size: var(--aih-font-size); outline: none; box-sizing: border-box; margin-top: 8px; }
.aih-dialog-input:focus { border-color: var(--aih-input-focus); }
.aih-dialog-message { color: var(--aih-text-secondary); font-size: var(--aih-font-size); line-height: 1.5; }
.aih-dialog-icon { font-size: 24px; margin-bottom: 8px; text-align: center; }
.aih-dialog-icon-info { color: var(--aih-accent-active); } .aih-dialog-icon-success { color: var(--aih-success); } .aih-dialog-icon-error { color: var(--aih-danger); } .aih-dialog-icon-warning { color: var(--aih-accent-hover-active); }
.aih-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.aih-dialog-busy { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; background: var(--aih-busy-bg); color: var(--aih-text); font-size: var(--aih-font-size); z-index: 4; text-align: center; padding: 16px; }
.aih-dialog-spinner { width: 28px; height: 28px; border: 3px solid var(--aih-border-strong); border-top-color: var(--aih-accent-active); border-radius: 50%; animation: aih-dialog-spin 0.8s linear infinite; }
@keyframes aih-dialog-spin { to { transform: rotate(360deg); } }
.aih-dialog-resize-handle { position: absolute; z-index: 3; }
.aih-dialog-resize-nw { top: -4px; left: -4px; width: 12px; height: 12px; cursor: nw-resize; }
.aih-dialog-resize-ne { top: -4px; right: -4px; width: 12px; height: 12px; cursor: ne-resize; }
.aih-dialog-resize-sw { bottom: -4px; left: -4px; width: 12px; height: 12px; cursor: sw-resize; }
.aih-dialog-resize-se { bottom: 0; right: 0; width: 14px; height: 14px; cursor: nwse-resize; background: linear-gradient(135deg, transparent 50%, var(--aih-resize-handle) 50%); border-radius: 0 0 var(--aih-radius-footer) 0; }
.aih-dialog-resize-n { top: -4px; left: 8px; right: 8px; height: 8px; cursor: n-resize; }
.aih-dialog-resize-s { bottom: -4px; left: 8px; right: 8px; height: 8px; cursor: s-resize; }
.aih-dialog-resize-e { top: 8px; right: -4px; bottom: 8px; width: 8px; cursor: e-resize; }
.aih-dialog-resize-w { top: 8px; left: -4px; bottom: 8px; width: 8px; cursor: w-resize; }
`;

    function dialogCssPresent() {
        if (typeof document === "undefined") return true;
        if (document.getElementById(DIALOG_CSS_ID)) return true;
        if (document.getElementById(DIALOG_CSS_INLINE_ID)) return true;
        // Lien déjà injecté par une autre source / balise CSS équivalente.
        if (document.querySelector('link[href*="aih_dialog.css"], style[data-aih-dialog]')) return true;
        // Classe de test : si la variable de thème est déjà définie sur :root,
        // la CSS (ou une copie) est présente.
        try {
            if (getComputedStyle(document.documentElement).getPropertyValue("--aih-accent").trim()) return true;
        } catch (e) { /* silencieux */ }
        return false;
    }

    function injectInlineDialogCss() {
        if (typeof document === "undefined") return;
        if (document.getElementById(DIALOG_CSS_INLINE_ID)) return;
        const style = document.createElement("style");
        style.id = DIALOG_CSS_INLINE_ID;
        style.setAttribute("data-aih-dialog", "1");
        style.textContent = FALLBACK_DIALOG_CSS;
        document.head.appendChild(style);
    }

    function ensureDialogCss() {
        if (typeof document === "undefined") return;
        if (dialogCssPresent()) return;
        const link = document.createElement("link");
        link.id = DIALOG_CSS_ID;
        link.rel = "stylesheet";
        link.type = "text/css";
        link.href = holafExtUrl(DIALOG_CSS_HREF);
        // Sécurité : si le <link> ne charge pas (404/chemin inattendu), on bascule
        // sur la copie inline qui garantit centrage + overlay + thème partout.
        link.onerror = () => injectInlineDialogCss();
        document.head.appendChild(link);
    }

    // ─── I18n helper ──────────────────────────────────────────────────────────
    // Traduit une clé via AIH.I18n (si disponible) et retombe sur un libellé
    // littéral quand la couche i18n est absente ou ne fournit pas la clé. Les
    // libellés explicites fournis par l'appelant prennent toujours le dessus.
    function L(key, params, fallback) {
        if (AIH.I18n && typeof AIH.I18n.t === "function") {
            const v = AIH.I18n.t(key, params);
            if (v !== undefined && v !== null && v !== key) return v;
        }
        return fallback;
    }

    // ─── Persistance position / taille (store unifié `aih_window_rects`) ────
    let _saveTimer = null;

    function saveRect(key, rect) {
        if (!key) return;
        if (_saveTimer) clearTimeout(_saveTimer);
        _saveTimer = setTimeout(() => {
            _saveTimer = null;
            saveWindowRect(key, rect);
        }, 300);
    }

    function loadRect(key) {
        return loadWindowRect(key);
    }

    // ─── Thème (AIH.Theme) ───────────────────────────────────────────────────
    const THEME_VARS = [
        "--aih-accent", "--aih-accent-hover", "--aih-accent-text",
        "--aih-bg", "--aih-bg-secondary", "--aih-bg-input", "--aih-bg-hover",
        "--aih-text", "--aih-text-secondary",
        "--aih-border", "--aih-border-strong",
        "--aih-danger", "--aih-danger-hover", "--aih-danger-text", "--aih-success",
        "--aih-radius", "--aih-radius-footer",
        "--aih-shadow", "--aih-shadow-active", "--aih-overlay-bg", "--aih-busy-bg",
        "--aih-font-size", "--aih-title-size", "--aih-title-weight",
        "--aih-btn-bg", "--aih-btn-bg-hover", "--aih-btn-border",
        "--aih-close-color", "--aih-close-hover", "--aih-input-focus",
        "--aih-resize-handle", "--aih-resize-handle-active",
    ];

    const THEME_STORAGE_KEY = "aih_theme_overrides";

    function defaultTarget() {
        return document.documentElement;
    }

    // Applique des surcharges de thème sur un élément (sans persistance globale).
    function applyVars(el, overrides) {
        if (!overrides) return;
        Object.keys(overrides).forEach((k) => {
            if (k.indexOf("--aih-") === 0) {
                el.style.setProperty(k, String(overrides[k]));
            }
        });
    }

    const Theme = {
        _target: null,

        get target() {
            return this._target || defaultTarget();
        },

        setTheme(overrides, target) {
            // Support du nouvel état 4-axes {mode, accent, halo, highlight}.
            if (overrides && (overrides.mode !== undefined || overrides.accent !== undefined || overrides.halo !== undefined || overrides.highlight !== undefined)) {
                const el = target || document.body;
                const merged = this.applyState(overrides, el);
                if (overrides.mode !== undefined || overrides.accent !== undefined || overrides.halo !== undefined || overrides.highlight !== undefined) {
                    saveThemeState(overrides);
                }
                return merged;
            }

            // Comportement historique : surcharges de variables --aih-*.
            const el = target || this.target;
            const merged = {};
            const current = this.getTheme(el);
            Object.assign(merged, current, overrides || {});
            applyVars(el, merged);
            if (overrides) {
                try {
                    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(merged));
                } catch (e) { /* silencieux */ }
            }
            return merged;
        },

        // État courant {mode, accent, halo, highlight}.
        getState(target) {
            const el = target || (typeof document !== "undefined" ? document.body : null);
            let mode = AIH_THEME_DEFAULT.mode;
            let accent = AIH_THEME_DEFAULT.accent;
            let halo = true;
            let highlight = true;
            let haloIntensity = AIH_THEME_DEFAULT.haloIntensity;
            let highlightIntensity = AIH_THEME_DEFAULT.highlightIntensity;
            if (el) {
                if (el.classList.contains(AIH_MODES.light.className)) mode = "light";
                else mode = "dark";
                Object.keys(AIH_ACCENTS).forEach((k) => {
                    if (el.classList.contains(AIH_ACCENTS[k].className)) accent = k;
                });
                halo = !el.classList.contains("aih-halo-off");
                highlight = !el.classList.contains("aih-highlight-off");
                haloIntensity = Math.max(0, Math.min(100, parseInt(el.style.getPropertyValue("--aih-halo-intensity") || AIH_THEME_DEFAULT.haloIntensity, 10) || 0));
                highlightIntensity = Math.max(0, Math.min(100, parseInt(el.style.getPropertyValue("--aih-highlight-intensity") || AIH_THEME_DEFAULT.highlightIntensity, 10) || 0));
            }
            return { mode, accent, halo, haloIntensity, highlight, highlightIntensity };
        },

        // Applique {mode, accent, halo, highlight} sur un élément (souvent body).
        applyState(state, target) {
            const el = target || (typeof document !== "undefined" ? document.body : null);
            return applyThemeState(el, state);
        },

        setMode(mode, target) {
            const el = target || (typeof document !== "undefined" ? document.body : null);
            const state = this.getState(el);
            const m = (mode && AIH_MODES[mode]) ? mode : AIH_THEME_DEFAULT.mode;
            const applied = applyThemeState(el, { mode: m, accent: state.accent, halo: state.halo, haloIntensity: state.haloIntensity, highlight: state.highlight, highlightIntensity: state.highlightIntensity });
            saveThemeState({ mode: m });
            return applied;
        },

        setAccent(accent, target) {
            const el = target || (typeof document !== "undefined" ? document.body : null);
            const state = this.getState(el);
            const a = (accent && AIH_ACCENTS[accent]) ? accent : AIH_THEME_DEFAULT.accent;
            const applied = applyThemeState(el, { mode: state.mode, accent: a, halo: state.halo, haloIntensity: state.haloIntensity, highlight: state.highlight, highlightIntensity: state.highlightIntensity });
            saveThemeState({ accent: a });
            return applied;
        },

        setHalo(on, target) {
            const el = target || (typeof document !== "undefined" ? document.body : null);
            const state = this.getState(el);
            const applied = applyThemeState(el, { mode: state.mode, accent: state.accent, halo: !!on, haloIntensity: state.haloIntensity, highlight: state.highlight, highlightIntensity: state.highlightIntensity });
            saveThemeState({ halo: !!on });
            return applied;
        },

        setHighlight(on, target) {
            const el = target || (typeof document !== "undefined" ? document.body : null);
            const state = this.getState(el);
            const applied = applyThemeState(el, { mode: state.mode, accent: state.accent, halo: state.halo, haloIntensity: state.haloIntensity, highlight: !!on, highlightIntensity: state.highlightIntensity });
            saveThemeState({ highlight: !!on });
            return applied;
        },

        getTheme(target) {
            const el = target || this.target;
            const cs = getComputedStyle(el);
            const out = {};
            THEME_VARS.forEach((k) => {
                const v = cs.getPropertyValue(k).trim();
                out[k] = v || "";
            });
            return out;
        },

        resetTheme(target) {
            const el = target || this.target;
            THEME_VARS.forEach((k) => el.style.removeProperty(k));
            try {
                localStorage.removeItem(THEME_STORAGE_KEY);
            } catch (e) { /* silencieux */ }
        },

        // Restaure des surcharges persistées (appelé une fois au chargement).
        _restorePersisted() {
            try {
                const raw = localStorage.getItem(THEME_STORAGE_KEY);
                if (raw) applyVars(defaultTarget(), JSON.parse(raw));
            } catch (e) { /* silencieux */ }
        },

        // Restaure le thème 4-axes persisté (mode/accent/halo/highlight) sur <body>.
        _restoreAxis() {
            try {
                applyPersistedTheme(document.body);
            } catch (e) { /* silencieux */ }
        },
    };

    AIH.Theme = Theme;

    // ─── Noyau : AIH.Dialog.open ─────────────────────────────────────────────
    function open(opts) {
        opts = opts || {};

        // ── Anti-doublon générique (fenêtres non-modales à id stable) ────────
        // Si une fenêtre portant le même id est déjà ouverte, on la ramène au
        // premier plan (bringToFront) au lieu d'en créer une nouvelle. Évite
        // les fenêtres de config/paramètres en double après un multi-clic.
        if (opts.id) {
            const existing = document.getElementById(opts.id);
            if (existing && existing.classList && existing.classList.contains("aih-dialog-root")) {
                windowManager.bringToFront(existing);
                if (typeof opts.onOpen === "function") {
                    try { opts.onOpen(existing._aihController); } catch (e) { /* silencieux */ }
                }
                return existing._aihController;
            }
        }

        // Auto-injection de la feuille de style au premier open() (idempotent).
        ensureDialogCss();

        const modal = !!opts.modal;
        const resizable = opts.resizable !== undefined ? !!opts.resizable : !modal;
        const draggable = opts.draggable !== undefined ? !!opts.draggable : !modal;
        const closeOnEscape = opts.closeOnEscape !== false;
        const closeOnOverlay = opts.closeOnOverlay !== false;
        const focusTrap = opts.focusTrap !== undefined ? !!opts.focusTrap : modal;
        const bringToFrontOnClick = opts.bringToFrontOnClick !== false;
        const busy = !!opts.busy;

        const width = toPx(opts.width) || "400px";
        const height = toPx(opts.height);
        const minWidth = toPx(opts.minWidth || opts.min) || "280px";
        const minHeight = toPx(opts.minHeight || opts.min) || "120px";
        const maxWidth = toPx(opts.maxWidth || opts.max) || "90vw";
        const maxHeight = toPx(opts.maxHeight || opts.max) || "85vh";

        let storageKey = opts.storageKey === undefined ? null : opts.storageKey;
        let persistSize = opts.persistSize;
        let persistPos = opts.persistPos;

        // ── Persistance par défaut pour les vraies fenêtres ───────────────────
        // Quand le dialogue est draggable ET/OU resizable ET non-modal, et qu'un
        // id ou un title est fourni, on dérive une clé stable et on active
        // persistPos/persistSize par défaut (sauf opt-out explicite `false`).
        // Les helpers transitoires (alert/confirm/prompt/choose/busy) sont
        // modaux et non draggable → exclus (restent centrés, non persistés).
        const isRealWindow = (draggable || resizable) && !modal && (opts.id || opts.title);
        if (isRealWindow && storageKey === null) {
            storageKey = opts.id ? ("aih:" + opts.id) : ("aih:" + slugifyTitle(opts.title));
            if (persistSize !== false) persistSize = true;
            if (persistPos !== false) persistPos = true;
        }

        // ── Overlay (mode modal) ────────────────────────────────────────────
        let overlay = null;
        if (modal) {
            overlay = document.createElement("div");
            overlay.className = "aih-dialog-overlay";
            document.body.appendChild(overlay);
        }

        // ── Racine ──────────────────────────────────────────────────────────
        const el = document.createElement("div");
        el.className = "aih-dialog-theme aih-dialog-root" + (opts.className ? " " + opts.className : "");
        if (opts.id) el.id = opts.id;

        // Applique un thème spécifique au dialogue (inline, sans persistance).
        if (opts.theme) applyVars(el, opts.theme);

        // ── Z-index initial via l'autorité partagée ────────────────────────
        // Enregistre la fenêtre dans le gestionnaire commun (partage la même
        // échelle que les panneaux holaf). Sauf z-index explicite (ex. login
        // 210000), on passe au premier plan immédiatement : el devient l'unique
        // fenêtre `.active` (halo) et monte au-dessus de toutes les autres.
        // Les dialogues MODAUX sont placés dans la bande `AIH_MODAL_Z` : ils
        // restent ainsi au-dessus de la couche « popup » (menu du pack), qui
        // elle-même surplombe les panneaux et l'overlay plein écran du viewer.
        windowManager.register(el);
        if (overlay) windowManager.register(overlay);
        let z;
        if (typeof opts.zIndex === "number") {
            z = opts.zIndex;
            el.style.zIndex = String(z);
            if (overlay) overlay.style.zIndex = String(z);
            windowManager.markActive(el);
        } else {
            z = windowManager.bringToFront(el, modal ? { minZ: AIH_MODAL_Z } : undefined);
            if (overlay) overlay.style.zIndex = String(z);
        }

        el.style.width = width;
        if (height) el.style.height = height;
        el.style.minWidth = minWidth;
        el.style.minHeight = minHeight;
        el.style.maxWidth = maxWidth;
        el.style.maxHeight = maxHeight;

        // ── Header ──────────────────────────────────────────────────────────
        const header = document.createElement("div");
        header.className = "aih-dialog-header";

        const titleEl = document.createElement("span");
        titleEl.className = "aih-dialog-title";
        titleEl.textContent = opts.title || "";

        const closeBtn = document.createElement("button");
        closeBtn.className = "aih-dialog-close";
        closeBtn.textContent = "✕";
        closeBtn.title = L("dialog.close", null, "Close");
        closeBtn.style.display = busy ? "none" : "";

        // Ordre DOM : [titre (flex:1)] [contrôles à droite : customs, zoom, ✕].
        // Le groupe `.aih-dialog-header-right` est le point d'extension stable
        // (ex. blobby chat y ajoute ses boutons ⚙️/🧹/…).
        header.appendChild(titleEl);
        const headerRight = document.createElement("div");
        headerRight.className = "aih-dialog-header-right";
        header.appendChild(headerRight);
        if (!busy) headerRight.appendChild(closeBtn);

        el.appendChild(header);

        // ── Body ────────────────────────────────────────────────────────────
        const body = document.createElement("div");
        body.className = "aih-dialog-body";

        function renderContent(target) {
            const c = opts.content;
            if (typeof c === "function") {
                const r = c(target);
                if (isNode(r)) target.appendChild(r);
                else if (typeof r === "string") target.innerHTML = r;
            } else if (isNode(c)) {
                target.appendChild(c);
            } else if (c !== undefined && c !== null) {
                target.innerHTML = String(c);
            }
        }
        renderContent(body);
        el.appendChild(body);

        // ── Zoom standard dans la barre de titre (taille du contenu) ────────
        // Boutons − / + appliqués sur le body (exclut le header) via la
        // variable canonique --aih-zoom-factor, mémorisés par fenêtre dans le
        // store unifié `aih_zoom_levels` (clé = storageKey). On les insère à
        // droite avant le bouton fermer. Les dialogues transitoires (alert,
        // confirm, prompt, choose, busy) gardent aussi les boutons mais sans
        // persistance (pas de storageKey) — sauf busy (fermé, pas de header).
        if (!busy) {
            const zoomKey = storageKey || (opts.id ? ("aih:" + opts.id) : null);
            const zoomControls = makeContentZoomable(body, {
                key: zoomKey || undefined,
                getLevel: () => {
                    const v = loadZoomLevel(zoomKey);
                    return v !== null ? v : 1;
                },
                setLevel: (level) => {
                    applyContentZoom(body, level);
                    if (zoomKey) saveZoomLevel(zoomKey, level);
                },
            });
            headerRight.insertBefore(zoomControls, closeBtn);
        }

        // ── Footer / boutons ────────────────────────────────────────────────
        let footer = null;
        const buttons = opts.buttons || [];
        if (buttons.length > 0 && !busy) {
            footer = document.createElement("div");
            footer.className = "aih-dialog-footer";
            el.appendChild(footer);
        }

        // ── Resize handles ──────────────────────────────────────────────────
        const resizeHandles = [];
        const handleDirs = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
        handleDirs.forEach((dir) => {
            const h = document.createElement("div");
            h.className = "aih-dialog-resize-handle aih-dialog-resize-" + dir;
            h.dataset.dir = dir;
            el.appendChild(h);
            resizeHandles.push(h);
        });
        if (!resizable) {
            resizeHandles.forEach((h) => { h.style.display = "none"; });
        }

        // ── Insertion dans le DOM (el après overlay → même z, au-dessus) ───
        document.body.appendChild(el);

        // ── Position par défaut / restaurée ────────────────────────────────
        let positioned = false;
        if (storageKey) {
            const saved = loadRect(storageKey);
            if (saved) {
                const w = saved.width || parseInt(width, 10);
                const h = saved.height || parseInt(height, 10);
                if (persistSize) {
                    el.style.width = w + "px";
                    el.style.height = h + "px";
                }
                if (persistPos) {
                    const vw = window.innerWidth;
                    const vh = window.innerHeight;
                    const m = 20;
                    const left = clamp(saved.left, m, vw - w - m);
                    const top = clamp(saved.top, m, vh - h - m);
                    el.style.left = left + "px";
                    el.style.top = top + "px";
                    positioned = true;
                }
            }
        }
        if (!positioned) {
            const pw = parseInt(el.style.width, 10) || 400;
            const ph = parseInt(el.style.height, 10) || 300;
            el.style.left = Math.max(20, (window.innerWidth - pw) / 2) + "px";
            el.style.top = Math.max(20, (window.innerHeight - ph) / 2) + "px";
        }

        // ── Busy overlay (spinner) ──────────────────────────────────────────
        let busyEl = null;
        function setBusy(b, msg) {
            if (!busyEl && b) {
                busyEl = document.createElement("div");
                busyEl.className = "aih-dialog-busy";
                const spin = document.createElement("span");
                spin.className = "aih-dialog-spinner";
                const lbl = document.createElement("div");
                lbl.className = "aih-dialog-busy-msg";
                lbl.textContent = msg || "";
                busyEl.appendChild(spin);
                busyEl.appendChild(lbl);
                el.appendChild(busyEl);
            }
            if (busyEl) busyEl.style.display = b ? "flex" : "none";
        }

        // ── Bring to front (délégué à l'autorité partagée) ─────────────────
        function bringToFront() {
            const newZ = windowManager.bringToFront(el, modal ? { minZ: AIH_MODAL_Z } : undefined);
            if (overlay) overlay.style.zIndex = String(newZ);
        }

        if (bringToFrontOnClick) {
            el.addEventListener("mousedown", () => {
                if (!el.classList.contains("active")) {
                    bringToFront();
                }
            });
        }

        // ── Fermeture ───────────────────────────────────────────────────────
        let closed = false;
        let _result = null;
        let _keyHandler = null;

        function cleanup() {
            if (overlay && overlay.parentNode) overlay.remove();
            if (_keyHandler) document.removeEventListener("keydown", _keyHandler);
        }

        function close(value) {
            if (closed) return;
            closed = true;
            _result = value !== undefined ? value : null;
            if (storageKey && (persistSize || persistPos)) {
                saveRect(storageKey, {
                    left: el.offsetLeft,
                    top: el.offsetTop,
                    width: el.offsetWidth,
                    height: el.offsetHeight,
                });
            }
            cleanup();
            el.remove();
            windowManager.unregister(el);
            if (overlay) windowManager.unregister(overlay);
            if (typeof opts.onClose === "function") {
                try { opts.onClose(_result); } catch (e) { /* silencieux */ }
            }
            if (typeof _onResolve === "function") {
                try { _onResolve(_result); } catch (e) { /* silencieux */ }
            }
        }

        // ── Clavier (Escape + focus trap) — un seul écouteur, supprimé à la fermeture ─
        if ((closeOnEscape || focusTrap) && !busy) {
            _keyHandler = (e) => {
                if (e.key === "Escape" && closeOnEscape && !closed) {
                    close();
                    return;
                }
                if (e.key === "Tab" && focusTrap) {
                    const focusable = el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
                    if (focusable.length === 0) return;
                    const first = focusable[0];
                    const last = focusable[focusable.length - 1];
                    if (e.shiftKey && document.activeElement === first) {
                        e.preventDefault();
                        last.focus();
                    } else if (!e.shiftKey && document.activeElement === last) {
                        e.preventDefault();
                        first.focus();
                    }
                }
            };
            document.addEventListener("keydown", _keyHandler);
        }

        // ── closeBtn click ──────────────────────────────────────────────────
        if (!busy) closeBtn.addEventListener("click", () => close());

        // ── Overlay click (modal) ───────────────────────────────────────────
        // Un drag qui se termine sur le fond ne doit pas fermer le dialog :
        // on retient qu'un drag a eu lieu (flag posé au mousedown du header)
        // et on ignore le clic de relâchement consécutif.
        let wasDragged = false;
        if (overlay && closeOnOverlay && !busy) {
            overlay.addEventListener("click", (e) => {
                if (wasDragged) { wasDragged = false; return; }
                if (e.target === overlay) close();
            });
        }

        // ── Drag ────────────────────────────────────────────────────────────
        if (draggable) {
            makeDraggable(el, {
                handle: header,
                anchor: "left-top",
                clamp: true,
                margin: 10,
                ignore: "button, input, select, textarea, a",
                bringToFront: () => bringToFront(),
                onDragStart: () => { wasDragged = true; },
                cursor: "grabbing",
                cursorRestore: "",
                saveState: (rect) => {
                    if (storageKey && persistPos) saveRect(storageKey, rect);
                },
            });
        }

        // ── Resize ──────────────────────────────────────────────────────────
        if (resizable) {
            const minW = parseLen(minWidth, window.innerWidth) || 280;
            const minH = parseLen(minHeight, window.innerHeight) || 120;
            const maxW = parseLen(maxWidth, window.innerWidth) || Math.round(window.innerWidth * 0.9);
            const maxH = parseLen(maxHeight, window.innerHeight) || Math.round(window.innerHeight * 0.85);
            makeResizable(el, {
                handles: resizeHandles,
                anchor: "left-top",
                minWidth: minW,
                minHeight: minH,
                maxWidth: maxW,
                maxHeight: maxH,
                bringToFront: () => bringToFront(),
                onResize: (w, h) => {
                    if (typeof opts.onResize === "function") {
                        try { opts.onResize(w, h); } catch (e) { /* silencieux */ }
                    }
                },
                saveState: (rect) => {
                    if (storageKey && (persistSize || persistPos)) saveRect(storageKey, rect);
                },
            });
        }

        // ── Boutons du footer ───────────────────────────────────────────────
        if (footer) {
            buttons.forEach((btn) => {
                const b = document.createElement("button");
                b.className = "aih-dialog-btn";
                const t = btn.type || "primary";
                if (t === "danger") b.classList.add("aih-dialog-btn-danger");
                else if (t === "cancel") b.classList.add("aih-dialog-btn-cancel");
                else b.classList.add("aih-dialog-btn-primary");
                b.textContent = btn.text !== undefined ? btn.text : L("dialog.ok", null, "OK");
                b.addEventListener("click", async () => {
                    if (typeof btn.onClick === "function") {
                        try { btn.onClick(_controller); } catch (e) { /* silencieux */ }
                    }
                    if (typeof opts.guard === "function") {
                        setBusy(true);
                        let keepOpen = false;
                        try {
                            const r = await opts.guard(btn.value, _controller);
                            if (r === false) keepOpen = true;
                        } catch (err) {
                            if (err && err.keepOpen) keepOpen = true;
                            else console.error("[AIH.Dialog] guard error:", err);
                        }
                        setBusy(false);
                        if (keepOpen) return;
                    }
                    close(btn.value);
                });
                footer.appendChild(b);
            });
        }

        // ── setTitle / setContent / setBusy ─────────────────────────────────
        function setTitle(str) {
            titleEl.textContent = str;
        }
        function setContent(c) {
            body.innerHTML = "";
            opts.content = c;
            renderContent(body);
        }

        // ── Controller ──────────────────────────────────────────────────────
        let _onResolve = opts._onResolve || null;
        const _controller = {
            el: el,
            body: body,
            header: header,
            headerRight: headerRight,
            close: close,
            setTitle: setTitle,
            setContent: setContent,
            setBusy: setBusy,
            bringToFront: bringToFront,
            // alias de compatibilité v2
            modal: el,
            setBody: setContent,
        };

        if (busy) {
            _controller._busyMessage = titleEl;
        }

        // ── onOpen ──────────────────────────────────────────────────────────
        if (typeof opts.onOpen === "function") {
            try { opts.onOpen(_controller); } catch (e) { /* silencieux */ }
        }

        // Référence le contrôleur sur l'élément pour le garde anti-doublon
        // (reuse d'une fenêtre déjà ouverte par son id).
        el._aihController = _controller;

        return _controller;
    }

    AIH.Dialog = { open: open };

    // ─── Helper : alert ──────────────────────────────────────────────────────
    function alert(title, message, type) {
        type = type || "info";
        const icons = {
            info: "ℹ️",
            success: "✅",
            error: "❌",
            warning: "⚠️",
        };
        return new Promise((resolve) => {
            const content = [
                '<div class="aih-dialog-icon aih-dialog-icon-' + type + '">' + (icons[type] || "ℹ️") + '</div>',
                '<div class="aih-dialog-message">' + (message || "") + '</div>',
                '<div class="aih-dialog-actions">',
                '<button class="aih-dialog-btn aih-dialog-btn-primary" data-aih-ok>' + escapeHtml(L("dialog.ok", null, "OK")) + '</button>',
                '</div>',
            ].join("");
            const ctrl = open({
                title: title || L("dialog.alert_title", null, ""),
                width: "auto",
                modal: true,
                resizable: false,
                draggable: true,
                content: content,
                _onResolve: (v) => resolve(v),
            });
            ctrl.el.querySelector("[data-aih-ok]").addEventListener("click", () => ctrl.close());
        });
    }

    // ─── Helper : confirm ────────────────────────────────────────────────────
    function confirm(title, message, opts) {
        opts = opts || {};
        const confirmText = opts.confirmText || L("dialog.confirm", null, "Confirmer");
        const cancelText = opts.cancelText || L("dialog.cancel", null, "Annuler");
        return new Promise((resolve) => {
            const content = [
                '<div class="aih-dialog-message">' + (message || "") + '</div>',
                '<div class="aih-dialog-actions">',
                '<button class="aih-dialog-btn aih-dialog-btn-cancel" data-aih-cancel>' + escapeHtml(cancelText) + '</button>',
                '<button class="aih-dialog-btn ' + (opts.danger ? "aih-dialog-btn-danger" : "aih-dialog-btn-primary") + '" data-aih-ok>' + escapeHtml(confirmText) + '</button>',
                '</div>',
            ].join("");
            const ctrl = open({
                title: title || L("dialog.confirm_title", null, ""),
                width: "360px",
                modal: true,
                resizable: false,
                draggable: true,
                guard: opts.guard,
                content: content,
                _onResolve: (v) => resolve(v === true),
            });
            ctrl.el.querySelector("[data-aih-cancel]").addEventListener("click", () => ctrl.close(false));
            ctrl.el.querySelector("[data-aih-ok]").addEventListener("click", async () => {
                if (typeof opts.guard === "function") {
                    ctrl.setBusy(true);
                    let keep = false;
                    try {
                        const r = await opts.guard(true);
                        if (r === false) keep = true;
                    } catch (e) {
                        if (e && e.keepOpen) keep = true;
                    }
                    ctrl.setBusy(false);
                    if (keep) return;
                }
                ctrl.close(true);
            });
        });
    }

    // ─── Helper : prompt ─────────────────────────────────────────────────────
    function prompt(title, message, placeholder, opts) {
        opts = opts || {};
        placeholder = placeholder || "";
        return new Promise((resolve) => {
            const uid = "_aih_prompt_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
            const content = [
                '<div class="aih-dialog-message">' + (message || "") + '</div>',
                '<input class="aih-dialog-input" id="' + uid + '" type="text" placeholder="' + escapeHtml(placeholder) + '" />',
                '<div class="aih-dialog-actions">',
                '<button class="aih-dialog-btn aih-dialog-btn-cancel" data-aih-cancel>' + escapeHtml(opts.cancelText || L("dialog.cancel", null, "Annuler")) + '</button>',
                '<button class="aih-dialog-btn aih-dialog-btn-primary" data-aih-ok>' + escapeHtml(opts.confirmText || L("dialog.ok", null, "OK")) + '</button>',
                '</div>',
            ].join("");
            const ctrl = open({
                title: title || L("dialog.prompt_title", null, ""),
                width: "360px",
                modal: true,
                resizable: false,
                draggable: true,
                content: content,
                _onResolve: (v) => resolve(v),
            });
            const input = ctrl.el.querySelector("#" + uid);
            const submit = () => {
                const val = input.value.trim();
                ctrl.close(val || null);
            };
            ctrl.el.querySelector("[data-aih-cancel]").addEventListener("click", () => ctrl.close(null));
            ctrl.el.querySelector("[data-aih-ok]").addEventListener("click", submit);
            input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
            setTimeout(() => input.focus(), 50);
        });
    }

    // ─── Helper : choose ─────────────────────────────────────────────────────
    function choose(title, message, buttons, opts) {
        opts = opts || {};
        buttons = (buttons && buttons.length) ? buttons : [{ text: L("dialog.ok", null, "OK"), value: true, type: "primary" }];
        return new Promise((resolve) => {
            const content = [];
            if (isNode(message)) {
                // géré via content function ci-dessous
            } else {
                content.push('<div class="aih-dialog-message">' + (message || "") + '</div>');
            }
            const ctrl = open({
                title: title || "",
                width: opts.width || "auto",
                modal: true,
                resizable: opts.resizable !== undefined ? opts.resizable : false,
                draggable: opts.draggable !== undefined ? opts.draggable : true,
                guard: opts.guard,
                className: opts.className,
                content: (body) => {
                    if (isNode(message)) body.appendChild(message);
                    else body.innerHTML = content.join("");
                },
                buttons: buttons.map((b) => ({
                    text: b.text,
                    value: b.value,
                    type: b.type || "primary",
                    onClick: b.onClick,
                })),
                _onResolve: (v) => resolve(v),
            });
        });
    }

    // ─── Helper : busy ───────────────────────────────────────────────────────
    function busy(title, message) {
        let msgEl = null;
        const ctrl = open({
            title: title || L("dialog.progress_title", null, ""),
            width: "320px",
            modal: true,
            resizable: false,
            draggable: false,
            busy: true,
            closeOnEscape: false,
            closeOnOverlay: false,
            content: (body) => {
                const wrap = document.createElement("div");
                wrap.className = "aih-dialog-busy";
                const spin = document.createElement("span");
                spin.className = "aih-dialog-spinner";
                msgEl = document.createElement("div");
                msgEl.className = "aih-dialog-busy-msg";
                msgEl.textContent = message || "";
                wrap.appendChild(spin);
                wrap.appendChild(msgEl);
                body.appendChild(wrap);
            },
        });
        return {
            close: () => ctrl.close(),
            set: (m) => { if (msgEl) msgEl.textContent = m; },
        };
    }

    AIH.alert = alert;
    AIH.confirm = confirm;
    AIH.prompt = prompt;
    AIH.choose = choose;
    AIH.busy = busy;

    // Restaure les surcharges de thème persistées au chargement.
    try { Theme._restorePersisted(); } catch (e) { /* silencieux */ }

    // Restaure le thème 4-axes (mode/accent/halo/highlight) persisté sur <body>.
    try { Theme._restoreAxis(); } catch (e) { /* silencieux */ }

    // Auto-injection de la feuille de style au chargement du module (idempotent).
    ensureDialogCss();

    // ══════════════════════════════════════════════════════════════════════
    // WRAPPERS DE COMPATIBILITÉ (aucun consommateur ne change)
    // ══════════════════════════════════════════════════════════════════════

    // ── Adapter controller AIH.Dialog → API v2 (modal/setBody) ──────────────
    function toV2Controller(ctrl) {
        return {
            modal: ctrl.el,
            el: ctrl.el,
            body: ctrl.body,
            header: ctrl.header,
            headerRight: ctrl.headerRight,
            close: () => ctrl.close(),
            setTitle: ctrl.setTitle,
            setBody: ctrl.setContent,
            setContent: ctrl.setContent,
            bringToFront: ctrl.bringToFront,
        };
    }

    // aihOpenModalV2 → AIH.Dialog.open (retour compatible)
    window.aihOpenModalV2 = function (options) {
        options = options || {};
        const ctrl = open({
            title: options.title,
            content: options.content,
            width: options.width,
            height: options.height,
            minWidth: options.minWidth || options.min,
            minHeight: options.minHeight || options.min,
            maxWidth: options.maxWidth || options.max,
            maxHeight: options.maxHeight || options.max,
            resizable: options.resizable,
            draggable: options.draggable,
            modal: options.modal,
            closeOnEscape: options.closeOnEscape,
            storageKey: options.storageKey,
            persistSize: options.persistSize,
            persistPos: options.persistPos,
            className: options.className,
            onClose: options.onClose,
            onOpen: options.onOpen,
            onResize: options.onResize,
            bringToFrontOnClick: options.bringToFrontOnClick,
            zIndex: options.zIndex,
        });
        return toV2Controller(ctrl);
    };

    // aihShowAlert / aihShowConfirm / aihShowPrompt → AIH helpers
    window.aihShowAlert = function (title, message, type) {
        return alert(title, message, type);
    };
    window.aihShowConfirm = function (title, message) {
        return confirm(title, message);
    };
    window.aihShowPrompt = function (title, message, placeholder) {
        return prompt(title, message, placeholder);
    };

    // ── AIH.ask : API « style options » des dialogs (unifiée) ───────────────
    // Forme : AIH.ask({ title, message, messageElement?, buttons?, width? })
    //   - un seul bouton affirmatif  → alert()   (résout true)
    //   - plusieurs boutons           → choose()  (résout la valeur du bouton)
    // C'est l'API unique pour les confirmations/boîtes simples de TOUTE
    // l'extension (image viewer, nodes manager, model manager…).
    AIH.ask = function (options) {
        options = options || {};
        const buttons = (options.buttons && options.buttons.length)
            ? options.buttons
            : [{ text: L("dialog.ok", null, "OK"), value: true, type: "confirm" }];
        const message = isNode(options.messageElement) ? options.messageElement : (options.message || "");
        const title = options.title || L("dialog.confirm_title", null, "Confirmation");
        const opts = { width: options.width || options.maxWidth };

        // Cas simple : un seul bouton affirmatif → alert-style, résout true.
        if (buttons.length === 1 && buttons[0].value === true) {
            return alert(title, message).then(() => true);
        }

        const mapped = buttons.map((b) => {
            let type = "primary";
            if (b.type === "danger") type = "danger";
            else if (b.type === "cancel") type = "cancel";
            return { text: b.text, value: b.value, type: type, onClick: b.onClick };
        });
        return choose(title, message, mapped, opts);
    };

    // ── window.HolafModal.show → AIH.choose (forward-compatible) ────────────
    // Semantique conservée : onConfirm() === false → garde ouvert (keep-open).
    // NB : le const HolafModal de holaf_main.js est module-local (inaccessible
    // sans modification). Ce wrapper est exposé globalement comme chemin
    // unifié pour tout futur consommateur ; les consommateurs actuels de
    // holaf_main.js utilisent leur const local et ne sont PAS modifiés.
    if (typeof window.HolafModal === "undefined") {
        window.HolafModal = {
            show(title, messageOrElement, onConfirm, confirmText, cancelText) {
                confirmText = confirmText || L("dialog.confirm", null, "Confirm");
                cancelText = cancelText || L("dialog.cancel", null, "Cancel");
                return choose(title, messageOrElement, [
                    { text: cancelText, value: false, type: "cancel" },
                    { text: confirmText, value: true, type: "primary" },
                ], {
                    guard: async (value) => {
                        if (value === true && typeof onConfirm === "function") {
                            // Retour false → garder ouvert (keep-open).
                            if (onConfirm() === false) return { keepOpen: true };
                        }
                        return true;
                    },
                }).then((ok) => ok === true);
            },
        };
    }

    // (aucune implémentation « d'origine » à conserver : createDialog a été
    // unifié sur AIH.Dialog — voir le pont ci-dessus)
})();
