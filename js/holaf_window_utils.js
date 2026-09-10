/*
 * Copyright (C) 2025 Holaf
 * Holaf Utilities - Shared Window Utils
 *
 * Generic drag & resize helpers for floating windows/panels.
 * Consolidates duplicated logic previously inlined across several window
 * systems (AIH modals, picker, workflow share, panel manager, remote
 * comparer, shortcuts, layout tools).
 *
 * Both helpers support two anchoring modes:
 *   - 'left-top'   (default): position is driven by `left`/`top` styles.
 *   - 'right-bottom'        : position is driven by `right`/`bottom` styles
 *                             (used by remote_comparer & shortcuts).
 *
 * Optional persistence is supported via a `storageKey` (localStorage) or a
 * custom `saveState` callback.
 */

// ─── Persistance unifiée position / taille ──────────────────────────────────────
// UN SEUL store localStorage `aih_window_rects` (schéma { [storageKey]:
// {left, top, width, height} }). Centralise aussi le clamp au viewport pour la
// restauration. Migration : à la première lecture, si `aih_window_rects` est
// vide, on lit les anciens stores `aih_modal_rects` et `aih_dialog_rects` et on
// les reporte dans le store unifié.

const WINDOW_RECTS_KEY = "aih_window_rects";
const LEGACY_RECT_KEYS = ["aih_modal_rects", "aih_dialog_rects"];
let _rectsMigrated = false;

function _readRectsStore() {
    try {
        return JSON.parse(localStorage.getItem(WINDOW_RECTS_KEY) || "{}");
    } catch (e) {
        return {};
    }
}

function _writeRectsStore(store) {
    try {
        localStorage.setItem(WINDOW_RECTS_KEY, JSON.stringify(store));
    } catch (e) {
        /* localStorage indisponible — silencieux */
    }
}

// Migration one-shot : ne se déclenche que si le store unifié est vide.
function _ensureRectMigration() {
    if (_rectsMigrated) return;
    _rectsMigrated = true;
    try {
        const unified = _readRectsStore();
        if (Object.keys(unified).length > 0) return;
        const merged = {};
        for (const legacyKey of LEGACY_RECT_KEYS) {
            try {
                const raw = localStorage.getItem(legacyKey);
                if (raw) Object.assign(merged, JSON.parse(raw));
            } catch (e) { /* silencieux */ }
        }
        if (Object.keys(merged).length > 0) {
            _writeRectsStore(merged);
        }
    } catch (e) { /* silencieux */ }
}

/**
 * Clampe un rect {left, top, width, height} dans le viewport.
 * @param {object} rect
 * @param {number} [margin=20]
 * @returns {object|null} rect clamppé (left/top arrondis) ou null.
 */
export function clampWindowRect(rect, margin = 20) {
    if (!rect) return null;
    if (typeof rect.left !== "number" || typeof rect.top !== "number") return rect;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = rect.width || 0;
    const h = rect.height || 0;
    let left = rect.left;
    let top = rect.top;
    if (w <= vw - margin * 2) {
        left = Math.max(margin, Math.min(left, vw - w - margin));
    } else {
        left = margin;
    }
    if (h <= vh - margin * 2) {
        top = Math.max(margin, Math.min(top, vh - h - margin));
    } else {
        top = margin;
    }
    return { left: Math.round(left), top: Math.round(top), width: w, height: h };
}

/**
 * Charge un rect persisté (clampé au viewport) depuis le store unifié.
 * @param {string} storageKey
 * @returns {object|null} {left, top, width, height} clamppé ou null.
 */
export function loadWindowRect(storageKey, margin = 20) {
    if (!storageKey) return null;
    _ensureRectMigration();
    const store = _readRectsStore();
    const raw = store[storageKey];
    if (!raw) return null;
    return clampWindowRect({
        left: raw.left,
        top: raw.top,
        width: raw.width,
        height: raw.height,
    }, margin);
}

/**
 * Sauvegarde un rect {left, top, width, height} dans le store unifié.
 * @param {string} storageKey
 * @param {object} rect
 */
export function saveWindowRect(storageKey, rect) {
    if (!storageKey || !rect) return;
    _ensureRectMigration();
    const store = _readRectsStore();
    store[storageKey] = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
    };
    _writeRectsStore(store);
}

// ─── makeDraggable ────────────────────────────────────────────────────────────
/**
 * Makes an element draggable by a handle.
 *
 * @param {HTMLElement} el - The element to move.
 * @param {object} opts
 * @param {HTMLElement} [opts.handle=el] - The drag handle.
 * @param {'left-top'|'right-bottom'} [opts.anchor='left-top'] - Anchoring mode.
 * @param {string} [opts.storageKey] - localStorage key for persistence.
 * @param {Function} [opts.onStateChange] - Called on drag end with {x,y,width,height}.
 * @param {Function} [opts.onDragStart] - Called on mousedown.
 * @param {Function} [opts.onDragMove] - Called on mousemove.
 * @param {Function} [opts.onDragEnd] - Called on mouseup.
 * @param {boolean} [opts.clamp=true] - Clamp to viewport.
 * @param {number} [opts.margin=10] - Viewport margin when clamping.
 * @param {string} [opts.ignore] - Selector of targets that cancel the drag.
 * @param {Function} [opts.isIgnored] - (e)=>bool, extra ignore predicate.
 * @param {Function} [opts.bringToFront] - Called on mousedown.
 * @param {Function} [opts.bakeTransform] - Called on mousedown to bake transform.
 * @param {object} [opts.state] - Mutable state object (right-bottom mode).
 * @param {Function} [opts.updateVisualPosition] - (right-bottom mode) refresh position.
 * @param {Function} [opts.saveState] - Persistence callback on drag end.
 * @param {string} [opts.cursor] - Cursor to set on the handle during drag.
 * @param {string} [opts.cursorRestore=''] - Cursor to restore on drag end.
 */
export function makeDraggable(el, opts = {}) {
    const {
        handle = el,
        anchor = 'left-top',
        storageKey = null,
        onStateChange = null,
        onDragStart = null,
        onDragMove = null,
        onDragEnd = null,
        clamp = true,
        margin = 10,
        ignore = 'button, input, select, textarea, a',
        isIgnored = null,
        bringToFront = null,
        bakeTransform = null,
        state = null,
        updateVisualPosition = null,
        saveState = null,
        cursor = null,
        cursorRestore = '',
    } = opts;

    const persist = (rect) => {
        if (storageKey) {
            try {
                localStorage.setItem(storageKey, JSON.stringify(rect));
            } catch (e) { /* localStorage unavailable — silent */ }
        }
        if (saveState) saveState(rect);
    };

    handle.addEventListener('mousedown', (e) => {
        if (el.classList.contains('holaf-panel-fullscreen')) return;
        if (ignore && e.target.closest(ignore)) return;
        if (isIgnored && isIgnored(e)) return;
        e.preventDefault();

        if (bringToFront) bringToFront(el);
        if (bakeTransform) bakeTransform(el);
        if (cursor) handle.style.cursor = cursor;
        if (onDragStart) onDragStart(e);

        if (anchor === 'right-bottom') {
            const rect = el.getBoundingClientRect();
            const startRight = window.innerWidth - rect.right;
            const startBottom = window.innerHeight - rect.bottom;
            const startX = e.clientX;
            const startY = e.clientY;

            const onMove = (ev) => {
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                if (state) {
                    state.right = startRight - dx;
                    state.bottom = startBottom - dy;
                }
                if (updateVisualPosition) updateVisualPosition();
                if (onDragMove) onDragMove(dx, dy);
            };

            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                if (cursor) handle.style.cursor = cursorRestore;
                if (onStateChange) {
                    onStateChange({
                        right: state ? state.right : 0,
                        bottom: state ? state.bottom : 0,
                        width: el.offsetWidth,
                        height: el.offsetHeight,
                    });
                }
                persist(null);
                if (onDragEnd) onDragEnd();
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            return;
        }

        // left-top mode
        const offsetX = e.clientX - el.offsetLeft;
        const offsetY = e.clientY - el.offsetTop;

        const onMove = (moveEvent) => {
            let newLeft = moveEvent.clientX - offsetX;
            let newTop = moveEvent.clientY - offsetY;
            if (clamp) {
                const panelRect = el.getBoundingClientRect();
                if (newTop < margin) newTop = margin;
                if (newLeft < margin) newLeft = margin;
                if (newLeft + panelRect.width > window.innerWidth - margin) newLeft = window.innerWidth - panelRect.width - margin;
                if (newTop + panelRect.height > window.innerHeight - margin) newTop = window.innerHeight - panelRect.height - margin;
            }
            el.style.left = `${newLeft}px`;
            el.style.top = `${newTop}px`;
            if (onDragMove) onDragMove(newLeft, newTop);
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            if (cursor) handle.style.cursor = cursorRestore;
            if (onStateChange) {
                onStateChange({ x: el.offsetLeft, y: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight });
            }
            persist({ left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight });
            if (onDragEnd) onDragEnd();
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

// ─── makeResizable ───────────────────────────────────────────────────────────
/**
 * Makes an element resizable via directional handles.
 *
 * @param {HTMLElement} el - The element to resize.
 * @param {object} opts
 * @param {NodeList|Array} [opts.handles] - Resize handles (default: .holaf-resize-handle).
 * @param {'left-top'|'right-bottom'} [opts.anchor='left-top'] - Anchoring mode.
 * @param {string} [opts.storageKey] - localStorage key for persistence.
 * @param {Function} [opts.onStateChange] - Called on resize end.
 * @param {Function} [opts.onResize] - Called on each resize move.
 * @param {number} [opts.minWidth=100] - Minimum width.
 * @param {number} [opts.minHeight=50] - Minimum height.
 * @param {number} [opts.maxWidth] - Maximum width (optional).
 * @param {number} [opts.maxHeight] - Maximum height (optional).
 * @param {Function} [opts.bringToFront] - Called on mousedown.
 * @param {Function} [opts.bakeTransform] - Called on mousedown.
 * @param {object} [opts.state] - Mutable state object (right-bottom mode).
 * @param {Function} [opts.updateVisualPosition] - (right-bottom mode) refresh position.
 * @param {Function} [opts.saveState] - Persistence callback on resize end.
 * @param {Function} [opts.isIgnored] - (e)=>bool, cancel the resize.
 */
export function makeResizable(el, opts = {}) {
    const {
        handles = el.querySelectorAll('.holaf-resize-handle'),
        anchor = 'left-top',
        storageKey = null,
        onStateChange = null,
        onResize = null,
        minWidth = 100,
        minHeight = 50,
        maxWidth = null,
        maxHeight = null,
        bringToFront = null,
        bakeTransform = null,
        state = null,
        updateVisualPosition = null,
        saveState = null,
        isIgnored = null,
    } = opts;

    const persist = (rect) => {
        if (storageKey) {
            try {
                localStorage.setItem(storageKey, JSON.stringify(rect));
            } catch (e) { /* localStorage unavailable — silent */ }
        }
        if (saveState) saveState(rect);
    };

    handles.forEach(handle => {
        handle.addEventListener('mousedown', (e) => {
            if (isIgnored && isIgnored(e)) return;
            e.preventDefault();
            e.stopPropagation();

            const dir = handle.dataset.dir;
            const resizeN = dir.includes('n');
            const resizeS = dir.includes('s');
            const resizeE = dir.includes('e');
            const resizeW = dir.includes('w');

            if (bringToFront) bringToFront(el);
            if (bakeTransform) bakeTransform(el);

            const startX = e.clientX;
            const startY = e.clientY;

            if (anchor === 'right-bottom') {
                const rect = el.getBoundingClientRect();
                const startW = rect.width;
                const startH = rect.height;
                const startRight = window.innerWidth - rect.right;
                const startBottom = window.innerHeight - rect.bottom;

                const onMove = (ev) => {
                    const dx = ev.clientX - startX;
                    const dy = ev.clientY - startY;
                    let newW = startW;
                    let newH = startH;
                    let newRight = startRight;
                    let newBottom = startBottom;

                    if (resizeE) { newW = Math.max(minWidth, startW + dx); newRight = startRight - (newW - startW); }
                    if (resizeW) { newW = Math.max(minWidth, startW - dx); }
                    if (resizeS) { newH = Math.max(minHeight, startH + dy); newBottom = startBottom - (newH - startH); }
                    if (resizeN) { newH = Math.max(minHeight, startH - dy); }

                    if (state) {
                        state.width = newW;
                        state.height = newH;
                        state.right = newRight;
                        state.bottom = newBottom;
                    }
                    if (updateVisualPosition) updateVisualPosition();
                    if (onResize) onResize(newW, newH);
                };

                const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    if (onStateChange) {
                        onStateChange({
                            width: state ? state.width : el.offsetWidth,
                            height: state ? state.height : el.offsetHeight,
                            right: state ? state.right : 0,
                            bottom: state ? state.bottom : 0,
                        });
                    }
                    persist(null);
                };

                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
                return;
            }

            // left-top mode
            const initialWidth = el.offsetWidth;
            const initialHeight = el.offsetHeight;
            const initialLeft = el.offsetLeft;
            const initialTop = el.offsetTop;

            const onMove = (moveEvent) => {
                const deltaX = moveEvent.clientX - startX;
                const deltaY = moveEvent.clientY - startY;

                let newWidth = initialWidth;
                let newHeight = initialHeight;
                let newLeft = initialLeft;
                let newTop = initialTop;

                if (resizeE) newWidth = Math.max(minWidth, initialWidth + deltaX);
                if (resizeW) { newWidth = Math.max(minWidth, initialWidth - deltaX); newLeft = initialLeft + initialWidth - newWidth; }
                if (resizeS) newHeight = Math.max(minHeight, initialHeight + deltaY);
                if (resizeN) { newHeight = Math.max(minHeight, initialHeight - deltaY); newTop = initialTop + initialHeight - newHeight; }

                if (maxWidth != null && newWidth > maxWidth) {
                    if (resizeW) newLeft = initialLeft + initialWidth - maxWidth;
                    newWidth = maxWidth;
                }
                if (maxHeight != null && newHeight > maxHeight) {
                    if (resizeN) newTop = initialTop + initialHeight - maxHeight;
                    newHeight = maxHeight;
                }

                el.style.width = `${newWidth}px`;
                el.style.height = `${newHeight}px`;
                el.style.left = `${newLeft}px`;
                el.style.top = `${newTop}px`;
                if (onResize) onResize(newWidth, newHeight);
            };

            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                if (onStateChange) {
                    onStateChange({ x: el.offsetLeft, y: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight });
                }
                persist({ left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight });
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    });
}


// ─── Zoom unifié (taille du CONTENU) ────────────────────────────────────────
// UN SEUL mécanisme de zoom : une variable canonique `--aih-zoom-factor`
// (défaut 1.0) appliquée sur un CONTENEUR DE CONTENU qui exclut le header.
// Le header et les boutons restent à taille fixe ; seul le contenu (body) est
// mis à l'échelle via `calc(n * var(--aih-zoom-factor))` ou transform scale.
//
// Persistance : un store localStorage dédié `aih_zoom_levels` indexé par
// id/storageKey de la fenêtre ({ [key]: level }).

const ZOOM_FACTOR_VAR = "--aih-zoom-factor";
const ZOOM_LEVELS_KEY = "aih_zoom_levels";

export const ZOOM_DEFAULTS = Object.freeze({ min: 0.5, max: 2.5, step: 0.1 });

function _readZoomStore() {
    try {
        return JSON.parse(localStorage.getItem(ZOOM_LEVELS_KEY) || "{}");
    } catch (e) {
        return {};
    }
}

function _writeZoomStore(store) {
    try {
        localStorage.setItem(ZOOM_LEVELS_KEY, JSON.stringify(store));
    } catch (e) { /* localStorage indisponible — silencieux */ }
}

/**
 * Charge le niveau de zoom persisté pour une clé de fenêtre.
 * @param {string} key - id / storageKey de la fenêtre.
 * @returns {number|null} niveau persisté ou null.
 */
export function loadZoomLevel(key) {
    if (!key) return null;
    const store = _readZoomStore();
    const v = store[key];
    return (v !== undefined && v !== null && Number.isFinite(Number(v))) ? Number(v) : null;
}

/**
 * Sauvegarde le niveau de zoom d'une fenêtre dans le store unifié.
 * @param {string} key
 * @param {number} level
 */
export function saveZoomLevel(key, level) {
    if (!key) return;
    const store = _readZoomStore();
    store[key] = level;
    _writeZoomStore(store);
}

/**
 * Clampe un niveau de zoom dans [min, max] et l'arrondit au pas (step).
 * @param {number} level
 * @param {object} [opts]
 * @param {number} [opts.min=0.5]
 * @param {number} [opts.max=2.5]
 * @param {number} [opts.step=0.1]
 * @returns {number}
 */
export function clampZoom(level, opts = {}) {
    const min = (opts.min !== undefined && opts.min !== null) ? opts.min : ZOOM_DEFAULTS.min;
    const max = (opts.max !== undefined && opts.max !== null) ? opts.max : ZOOM_DEFAULTS.max;
    const step = (opts.step !== undefined && opts.step !== null) ? opts.step : ZOOM_DEFAULTS.step;
    let v = Number.isFinite(Number(level)) ? Number(level) : 1;
    v = Math.max(min, Math.min(max, v));
    if (step > 0) {
        v = min + Math.round((v - min) / step) * step;
    }
    v = Math.min(max, Math.max(min, v));
    return Math.round(v * 100) / 100;
}

/**
 * Applique un niveau de zoom sur un conteneur de CONTENU via la variable
 * canonique `--aih-zoom-factor`. Le header (hors de ce conteneur) n'est pas
 * touché : il reste à taille fixe.
 * @param {HTMLElement} contentEl - conteneur de contenu (exclut le header).
 * @param {number} level
 * @returns {number} niveau finalement appliqué (clamppé).
 */
export function applyContentZoom(contentEl, level) {
    if (!contentEl) return level;
    const v = clampZoom(level);
    contentEl.style.setProperty(ZOOM_FACTOR_VAR, String(v));
    return v;
}

/**
 * Crée les boutons zoom standard − / + (classe uniforme `aih-dialog-zoom`,
 * titre Zoom Out/In) et les câble sur un conteneur de CONTENU.
 *
 * @param {HTMLElement} contentEl - conteneur de contenu à zoomer (exclut header).
 * @param {object} [opts]
 * @param {string} [opts.key] - clé de persistance (id/storageKey). Si fournie,
 *   le niveau est restauré à l'appel et persisté à chaque changement.
 * @param {HTMLElement} [opts.container=contentEl] - élément recevant la var.
 * @param {Function} [opts.getLevel] - ()=>niveau courant (défaut: store key).
 * @param {Function} [opts.setLevel] - hook appelé après application/persistance.
 * @param {number} [opts.min]
 * @param {number} [opts.max]
 * @param {number} [opts.step]
 * @returns {HTMLElement} le groupe de boutons (à insérer dans le header).
 * VAGUE 9 : PAS migré vers la brique HolafViewport — ici le zoom est piloté par
 * boutons +/− avec niveau persisté (panels de fenêtres), pas une surface image
 * wheel/pan : interaction et contrat différents.
 */
export function makeContentZoomable(contentEl, opts = {}) {
    const {
        key = null,
        container = contentEl,
        getLevel = null,
        setLevel = null,
        min, max, step,
    } = opts;

    // Traduit via AIH.I18n si disponible (clé brute sinon).
    const zt = (k) => {
        const I = window.AIH && window.AIH.I18n;
        return I && typeof I.t === "function" ? I.t(k) : k;
    };

    const config = { min, max, step };

    const current = () => {
        if (typeof getLevel === "function") return clampZoom(getLevel(), config);
        const persisted = key ? loadZoomLevel(key) : null;
        return clampZoom(persisted !== null ? persisted : 1, config);
    };

    const apply = (level) => {
        const v = clampZoom(level, config);
        applyContentZoom(container, v);
        if (key) saveZoomLevel(key, v);
        if (typeof setLevel === "function") setLevel(v);
        return v;
    };

    const stepVal = (step !== undefined && step !== null) ? step : ZOOM_DEFAULTS.step;

    const group = document.createElement("span");
    group.className = "aih-zoom-controls";
    group.setAttribute("role", "group");

    const outBtn = document.createElement("button");
    outBtn.type = "button";
    outBtn.className = "aih-dialog-zoom aih-zoom-out";
    outBtn.title = zt("window.zoomOut");
    outBtn.setAttribute("aria-label", zt("window.zoomOut"));
    outBtn.innerHTML = "−";
    outBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        apply(current() - stepVal);
    });

    const inBtn = document.createElement("button");
    inBtn.type = "button";
    inBtn.className = "aih-dialog-zoom aih-zoom-in";
    inBtn.title = zt("window.zoomIn");
    inBtn.setAttribute("aria-label", zt("window.zoomIn"));
    inBtn.innerHTML = "+";
    inBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        apply(current() + stepVal);
    });

    group.append(outBtn, inBtn);

    // Restauration à l'ouverture : applique le niveau persisté (clamppé selon
    // la config de la fenêtre) sur le conteneur de contenu.
    const restored = key ? loadZoomLevel(key) : null;
    if (restored != null) applyContentZoom(container, clampZoom(restored, config));

    return group;
}


// ─── Autorité de z-index / actif / halo UNIQUE (systèmes partagés) ──────────
// Auparavant, AIH.Dialog (base 90000 + compteur _aihDialogZCounter) et
// HolafPanelManager (base 1000 + normalisation >1100) géraient chacun leur
// propre échelle de z-index et leur propre classe `.active` (halo). Résultat :
// on pouvait avoir un halo sur une fenêtre de chaque groupe en même temps, et
// cliquer une fenêtre d'un groupe ne la passait pas devant celles de l'autre.
//
// Ce gestionnaire centralise TOUTES les fenêtres (dialogues AIH ET panneaux
// holaf) sur UNE SEULE échelle de z-index continue (compteur global monotone)
// et UN SEUL état actif/halo partagé. `bringToFront` monte la fenêtre au-dessus
// de toutes les autres (max+1 global) et ne laisse qu'une seule `.active` à la
// fois, indépendamment du système d'origine.

const WINDOW_BASE_Z = 1000;      // échelle continue unique (plus de 90000/1000)
const WINDOW_MAX_Z = 1000000;    // seuil de renormalisation (évite croissance ∞)
const _windows = new Set();
let _zCounter = 0;

function _globalMaxZ() {
    let max = WINDOW_BASE_Z;
    _windows.forEach((w) => {
        const z = parseInt(w.style.zIndex, 10);
        if (!isNaN(z) && z > max) max = z;
    });
    return max;
}

// Renormalise toutes les fenêtres enregistrées sur une plage contiguë
// [WINDOW_BASE_Z+1 .. WINDOW_BASE_Z+n]. La fenêtre active garde le halo.
function _renormalize() {
    const sorted = [..._windows].sort((a, b) =>
        (parseInt(a.style.zIndex, 10) || WINDOW_BASE_Z) - (parseInt(b.style.zIndex, 10) || WINDOW_BASE_Z)
    );
    sorted.forEach((w, i) => { w.style.zIndex = String(WINDOW_BASE_Z + i + 1); });
    _zCounter = sorted.length;
}

/**
 * Gestionnaire partagé de fenêtres (AIH.Dialog + HolafPanelManager).
 * Instance unique : le module ESM garantit que toutes les fenêtres partagent
 * le même compteur et le même état actif/halo.
 */
export function aihWindowManager() {
    return {
        /** Enregistre une fenêtre (dialogue AIH ou panneau holaf). */
        register(el) {
            if (el && !_windows.has(el)) _windows.add(el);
        },

        /** Désenregistre une fenêtre (fermeture). */
        unregister(el) {
            _windows.delete(el);
        },

        /**
         * Met `el` au-dessus de TOUTES les fenêtres enregistrées : z-index =
         * max global + 1 (échelle continue partagée), ajoute `.active` à el et
         * la RETIRE de toutes les autres (halo unique).
         * @returns {number} le z-index attribué.
         */
        bringToFront(el) {
            if (!el) return 0;
            _windows.add(el);
            _windows.forEach((w) => { if (w !== el) w.classList.remove("active"); });
            el.classList.add("active");
            const next = Math.max(_globalMaxZ() + 1, WINDOW_BASE_Z + _zCounter + 1);
            _zCounter = next - WINDOW_BASE_Z;
            el.style.zIndex = String(next);
            if (next > WINDOW_BASE_Z + WINDOW_MAX_Z) _renormalize();
            return next;
        },

        /**
         * Marque `el` comme la fenêtre ACTIVE (halo) sans bouger le z-index.
         * Retire `.active` de toutes les autres fenêtres enregistrées.
         */
        markActive(el) {
            if (!el) return;
            _windows.add(el);
            _windows.forEach((w) => { if (w !== el) w.classList.remove("active"); });
            el.classList.add("active");
        },

        /** Retire l'état actif/halo de `el`. */
        markInactive(el) {
            if (el) el.classList.remove("active");
        },

        /** Compteur global courant (diagnostic / tests). */
        get counter() { return _zCounter; },

        /** Nombre de fenêtres enregistrées (diagnostic / tests). */
        get size() { return _windows.size; },
    };
}
