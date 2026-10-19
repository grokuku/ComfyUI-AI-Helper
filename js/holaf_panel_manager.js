/*
 * Copyright (C) 2025 Holaf
 * Holaf Utilities - Panel Manager
 *
 * This script provides a generic manager for creating, dragging,
 * and resizing floating panels within the ComfyUI interface.
 * REFACTORED: Removed pop-out logic and theme exports for a cleaner, more stable base.
 * MODIFIED: Added a generic, promise-based `createDialog` function for custom modals.
 * MODIFIED: Added `bringToFront` on any panel mousedown, not just header.
 * MODIFIED: Added fullscreen toggling on header double-click.
 * MODIFICATION: Added dialog keyboard navigation and global state.
 * CRITICAL FIX: Removed unused import of 'app' which caused crashes in standalone mode.
 */

import { HOLAF_THEMES } from "./holaf_themes.js";
import { aihIconSvg } from "./aih_icons.js";
import "./aih_strings.js";
import { makeDraggable, makeResizable, makeContentZoomable, applyContentZoom, loadZoomLevel, saveZoomLevel, aihWindowManager } from "./holaf_window_utils.js";

// Helper i18n central : traduit via AIH.I18n (clé brute si absente).
const t = (key, params) => {
    const I = window.AIH && window.AIH.I18n;
    return I && typeof I.t === "function" ? I.t(key, params) : key;
};

// MODIFICATION: Track open dialog count instead of boolean for proper stacking
export const dialogState = {
    openCount: 0,
    get isOpen() { return this.openCount > 0; }
};

const openPanels = new Set();

export const HolafPanelManager = {
    createPanel(options) {
        const panel = document.createElement("div");
        panel.id = options.id;
        panel.className = "holaf-utility-panel holaf-floating-window";

        if (options.defaultSize) {
            panel.style.width = `${options.defaultSize.width}px`;
            panel.style.height = `${options.defaultSize.height}px`;
        }

        if (options.defaultPosition && options.defaultPosition.x !== null && options.defaultPosition.y !== null) {
            panel.style.left = `${options.defaultPosition.x}px`;
            panel.style.top = `${options.defaultPosition.y}px`;
            panel.style.transform = 'none';
        } else {
            panel.style.left = '50%';
            panel.style.top = '50%';
            panel.style.transform = 'translate(-50%, -50%)';
        }

        openPanels.add(panel);

        const header = document.createElement("div");
        header.className = "holaf-utility-header";

        const title = document.createElement("span");
        // Accept safe types: HTMLElement or DocumentFragment (for SVG icons), or string (rendered as text)
        if (options.title instanceof Node) {
            title.appendChild(options.title);
        } else {
            title.textContent = options.title || "";
        }
        title.style.flexGrow = "1";
        title.style.overflow = "hidden";
        title.style.textOverflow = "ellipsis";
        title.style.whiteSpace = "nowrap";
        header.appendChild(title);

        if (options.headerContent) {
            const headerControlsWrapper = document.createElement("div");
            headerControlsWrapper.style.display = "flex";
            headerControlsWrapper.style.alignItems = "center";
            headerControlsWrapper.appendChild(options.headerContent);
            header.appendChild(headerControlsWrapper);
        }

        const content = document.createElement("div");
        content.style.flexGrow = "1";
        content.style.display = "flex";
        content.style.flexDirection = "column";
        content.style.overflow = "hidden";
        content.style.position = "relative";

        // ─── Boutons zoom standard ─ / + (taille du contenu) ────────────────
        // Insérés dans la barre de titre (après headerContent, avant le bouton
        // fermer). Appliquent la variable canonique --aih-zoom-factor sur le
        // conteneur de CONTENU (exclut le header). Le comportement est piloté
        // par `options.zoom` : `{ key, getLevel, setLevel, min, max, step }`.
        // Sans config, on applique sur `content` et on persiste sous options.id.
        const zoomGroup = (options.zoom !== false)
            ? makeContentZoomable(options.zoom && options.zoom.container ? options.zoom.container : content, {
                key: (options.zoom && options.zoom.key) || options.id || undefined,
                getLevel: (options.zoom && options.zoom.getLevel) || (() => {
                    const k = (options.zoom && options.zoom.key) || options.id;
                    const v = k ? loadZoomLevel(k) : null;
                    return v !== null ? v : 1;
                }),
                setLevel: (level) => {
                    const target = options.zoom && options.zoom.container ? options.zoom.container : content;
                    applyContentZoom(target, level);
                    const k = (options.zoom && options.zoom.key) || options.id;
                    if (k) saveZoomLevel(k, level);
                    if (options.zoom && typeof options.zoom.setLevel === "function") options.zoom.setLevel(level);
                },
                min: options.zoom && options.zoom.min,
                max: options.zoom && options.zoom.max,
                step: options.zoom && options.zoom.step,
            })
            : null;

        const closeButton = document.createElement("button");
        closeButton.className = "holaf-utility-close-button";
        // Icône « x » de la brique (trait, stroke=currentColor → la couleur reste
        // celle de `.holaf-utility-close-button` / son :hover). Nom accessible porté
        // par `title` → icône décorative.
        closeButton.innerHTML = aihIconSvg("x", { size: 14 });
        closeButton.title = t("dialog.close");
        closeButton.style.display = "inline-flex";
        closeButton.style.alignItems = "center";
        closeButton.style.marginLeft = "auto";
        if (options.headerContent) {
            closeButton.style.marginLeft = "10px";
        }

        closeButton.onclick = (e) => {
            e.stopPropagation();
            panel.style.display = "none";
            panel.classList.remove("active");
            openPanels.delete(panel);
            aihWindowManager().unregister(panel);
            if (options.onClose) options.onClose();
        };
        if (zoomGroup) header.appendChild(zoomGroup);
        header.appendChild(closeButton);

        // Create 8 directional resize handles (N, S, E, W, NE, NW, SE, SW)
        const directions = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
        directions.forEach(dir => {
            const handle = document.createElement("div");
            handle.className = `holaf-resize-handle holaf-resize-${dir}`;
            handle.dataset.dir = dir;
            panel.appendChild(handle);
        });

        panel.append(header, content);
        document.body.appendChild(panel);

        this.makeDraggable(panel, header, options.onStateChange);
        this.makeResizable(panel, options.onStateChange, options.onResize);
        this.setupFullscreenToggle(panel, header, options.onFullscreenToggle);

        this.bringToFront(panel);

        return { panelEl: panel, contentEl: content, headerEl: header };
    },

    bringToFront(panelEl) {
        if (!panelEl) return;
        // Auto-cleanup: remove stale references (elements no longer in the DOM)
        if (openPanels.size > 0 && openPanels.size % 10 === 0) {
            for (const p of openPanels) {
                if (!p.isConnected) openPanels.delete(p);
            }
        }

        // Track any element, not just createPanel ones
        if (!openPanels.has(panelEl)) {
            openPanels.add(panelEl);
        }

        // Autorité partagée unique : z-index = max global + 1 sur la même
        // échelle que les dialogues AIH, et une seule fenêtre `.active` (halo)
        // à la fois — la classe est retirée de toutes les autres, y compris
        // les dialogues AIH, indépendamment du système d'origine.
        aihWindowManager().bringToFront(panelEl);
    },

    unregister(panelEl) {
        openPanels.delete(panelEl);
        aihWindowManager().unregister(panelEl);
    },

    _bakePosition(panel) {
        // Utilise la valeur calculée (getComputedStyle) et pas seulement le
        // style inline : le transform peut venir d'une CSS (ex: centrage via
        // translate sur les fenêtres). Au premier drag, on convertit la position
        // centrée en left/top explicites, sinon le drag déraille de la moitié
        // de la taille de la fenêtre.
        const t = getComputedStyle(panel).transform;
        if (t && t !== 'none') {
            const rect = panel.getBoundingClientRect();
            panel.style.top = `${rect.top}px`;
            panel.style.left = `${rect.left}px`;
            panel.style.transform = 'none';
        }
    },

    makeDraggable(panel, handle, onStateChange) {
        makeDraggable(panel, {
            handle,
            anchor: 'left-top',
            clamp: true,
            margin: 10,
            ignore: 'button, input, select, textarea, a',
            bringToFront: (el) => this.bringToFront(el),
            bakeTransform: (el) => this._bakePosition(el),
            onStateChange,
        });
    },

    makeResizable(panel, onStateChange, onResize) {
        const minWidth = parseInt(getComputedStyle(panel).minWidth) || 100;
        const minHeight = parseInt(getComputedStyle(panel).minHeight) || 50;
        makeResizable(panel, {
            anchor: 'left-top',
            minWidth,
            minHeight,
            bringToFront: (el) => this.bringToFront(el),
            bakeTransform: (el) => this._bakePosition(el),
            onStateChange,
            onResize: () => { if (onResize) onResize(); },
        });
    },

    setupFullscreenToggle(panel, handle, onFullscreenToggle) {
        handle.addEventListener("dblclick", (e) => {
            if (e.target.closest("button, input, select, textarea, a")) return;
            this.toggleFullscreen(panel, onFullscreenToggle);
        });
    },

    toggleFullscreen(panel, onFullscreenToggle) {
        const isFullscreen = panel.classList.toggle("holaf-panel-fullscreen");
        if (onFullscreenToggle) {
            onFullscreenToggle(isFullscreen);
        }
    }

    /*
     * NOTE — les dialogs (confirmations, erreurs…) utilisent l'API unifiée
     * AIH.ask (options style) ou AIH.Dialog (alert/confirm/prompt/choose),
     * implémentée dans aih_dialog.js. Ce module ne fournit QUE les fenêtres
     * réelles (createPanel) : il n'existe plus de createDialog ici.
     * (Historique : deux systèmes coexistaient après la fusion de packs ;
     *  l'implémentation dupliquée a été supprimée au profit d'AIH.)
     */
};

// Global capture-phase listener: any click on a Holaf floating window brings it to front.
// Placed after HolafPanelManager definition so the reference is valid.
// Uses capture phase (true) to fire before any child element handlers.
document.addEventListener('mousedown', (e) => {
    const panel = e.target.closest('.holaf-floating-window');
    if (panel) {
        HolafPanelManager.bringToFront(panel);
    }
}, true);