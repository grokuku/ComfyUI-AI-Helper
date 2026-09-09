/*
 * Copyright (C) 2025 Holaf
 * Holaf Utilities - Image Viewer Settings Module
 *
 * This module manages loading, saving, and applying user settings for the image viewer.
 * REFACTOR: Simplified to robustly map between flat server settings and structured state.
 */

import { HolafPanelManager } from "../holaf_panel_manager.js";
import { HOLAF_THEMES } from "../holaf_themes.js";
import { HolafFetch } from "../vendor/holaf/holaf-fetch.js";
import { imageViewerState } from "./image_viewer_state.js";

let saveTimeout;
const DEBOUNCE_DELAY = 750;

/**
 * Collecte les données de l'état, les aplatit et les envoie au serveur.
 * @private
 */
function _debouncedSave() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        const state = imageViewerState.getState();

        // Aplatir l'état structuré en un objet simple pour le backend
        const settingsToSave = {
            ...state.filters,
            ...state.ui,
            panel_x: state.panel_x,
            panel_y: state.panel_y,
            panel_width: state.panel_width,
            panel_height: state.panel_height,
            panel_is_fullscreen: state.panel_is_fullscreen,
        };

        // Fire-and-forget : la brique lève sur non-2xx → .catch() (trace console).
        HolafFetch.post("/holaf/image-viewer/save-settings", { body: settingsToSave })
            .catch(error => console.error("[Holaf ImageViewer] Error saving settings:", error));
    }, DEBOUNCE_DELAY);
}

/**
 * Charge les paramètres du serveur et initialise l'état.
 * @param {object} viewer - The main image viewer instance (for compatibility).
 */
export async function loadSettings(viewer) {
    try {
        // La brique lève sur non-2xx/non-JSON → catch : réglages par défaut,
        // areSettingsLoaded positionné (comportement inchangé).
        const allSettings = await HolafFetch.get('/holaf/utilities/settings');
        const fetchedSettings = allSettings.ImageViewerUI || {};

        // Fonctions de validation
        const toBoolean = (val, def) => val !== undefined ? String(val).toLowerCase() === 'true' : def;
        
        // CORRECTIF : Rendre la conversion en tableau plus robuste.
        // Elle gère maintenant les tableaux natifs et les chaînes JSON.
        const toArray = (val, def) => {
            if (Array.isArray(val)) return val;
            if (typeof val === 'string' && val.startsWith('[') && val.endsWith(']')) {
                try {
                    const parsed = JSON.parse(val);
                    return Array.isArray(parsed) ? parsed : def;
                } catch(e) { return def; }
            }
            return def;
        };

        const toString = (val, def) => val !== undefined ? String(val) : def;
        const toNumber = (val, def) => !isNaN(parseInt(val)) ? parseInt(val) : def;
        
        const validTheme = HOLAF_THEMES.find(t => t.name === fetchedSettings.theme);
        
        // Mettre à jour l'état centralisé avec les données validées
        imageViewerState.setState({
            filters: {
                folder_filters: toArray(fetchedSettings.folder_filters, null),
                format_filters: toArray(fetchedSettings.format_filters, null),
                locked_folders: toArray(fetchedSettings.locked_folders, []),
                search_text: toString(fetchedSettings.search_text, ''),
                startDate: toString(fetchedSettings.startDate, ''),
                endDate: toString(fetchedSettings.endDate, ''),
                search_scope_name: toBoolean(fetchedSettings.search_scope_name, true),
                search_scope_prompt: toBoolean(fetchedSettings.search_scope_prompt, true),
                search_scope_workflow: toBoolean(fetchedSettings.search_scope_workflow, true),
                workflow_filter_internal: toBoolean(fetchedSettings.workflow_filter_internal, true),
                workflow_filter_external: toBoolean(fetchedSettings.workflow_filter_external, true),
                // --- FIX : La clé manquante est ajoutée ici ---
                workflow_filter_none: toBoolean(fetchedSettings.workflow_filter_none, true),
            },
            ui: {
                theme: validTheme ? fetchedSettings.theme : HOLAF_THEMES[0].name,
                thumbnail_fit: toString(fetchedSettings.thumbnail_fit, 'cover'),
                thumbnail_size: toNumber(fetchedSettings.thumbnail_size, 150),
                export_format: toString(fetchedSettings.export_format, 'png'),
                export_include_meta: toBoolean(fetchedSettings.export_include_meta, true),
                export_meta_method: toString(fetchedSettings.export_meta_method, 'embed'),
            },
            panel_x: fetchedSettings.panel_x,
            panel_y: fetchedSettings.panel_y,
            panel_width: toNumber(fetchedSettings.panel_width, 1200),
            panel_height: toNumber(fetchedSettings.panel_height, 800),
            panel_is_fullscreen: toBoolean(fetchedSettings.panel_is_fullscreen, false)
        });
        
        // Synchronisation temporaire de l'ancien objet `viewer.settings`
        Object.assign(viewer.settings, fetchedSettings);

    } catch (e) {
        console.error("[Holaf ImageViewer] Could not load settings:", e);
    }
    viewer.areSettingsLoaded = true;
}

/**
 * Met à jour l'état et déclenche une sauvegarde (avec debounce).
 * @param {object} viewer - The main image viewer instance (for compatibility).
 * @param {object} newSettings - The new settings to merge and save.
 */
export function saveSettings(viewer, newSettings) {
    const stateUpdate = {};
    const filtersUpdate = {};
    const uiUpdate = {};
    const panelUpdate = {};

    const currentState = imageViewerState.getState();

    for (const key in newSettings) {
        // --- FIX : Vérifier que la clé existe bien dans l'état ---
        if (key in currentState.filters) {
            filtersUpdate[key] = newSettings[key];
        } else if (key in currentState.ui) {
            uiUpdate[key] = newSettings[key];
        } else if (['x', 'y', 'width', 'height', 'panel_is_fullscreen'].includes(key) || 
                   ['panel_x', 'panel_y', 'panel_width', 'panel_height'].includes(key)) {
            if (key === 'x') panelUpdate.panel_x = newSettings.x;
            else if (key === 'y') panelUpdate.panel_y = newSettings.y;
            else if (key === 'width') panelUpdate.panel_width = newSettings.width;
            else if (key === 'height') panelUpdate.panel_height = newSettings.height;
            else panelUpdate[key] = newSettings[key];
        }
    }
    
    if (Object.keys(filtersUpdate).length > 0) stateUpdate.filters = filtersUpdate;
    if (Object.keys(uiUpdate).length > 0) stateUpdate.ui = uiUpdate;
    if (Object.keys(panelUpdate).length > 0) Object.assign(stateUpdate, panelUpdate);

    if (Object.keys(stateUpdate).length > 0) {
        imageViewerState.setState(stateUpdate);
        _debouncedSave();
    }
    
    // Synchronisation temporaire
    Object.assign(viewer.settings, newSettings);
}

/**
 * Applique un thème au panneau.
 * @param {object} viewer - The main image viewer instance.
 * @param {string} themeName - The name of the theme to apply.
 * @param {boolean} [doSave=true] - Whether to save the setting change.
 */
export function setTheme(viewer, themeName, doSave = true) {
    const themeConfig = HOLAF_THEMES.find(t => t.name === themeName);
    if (!themeConfig) {
        console.warn(`[Holaf ImageViewer] Theme '${themeName}' not found.`);
        return;
    }

    if (doSave) {
        saveSettings(viewer, { theme: themeName });
    } else {
        imageViewerState.setState({ ui: { theme: themeName } });
        viewer.settings.theme = themeName;
    }

    if (viewer.panelElements && viewer.panelElements.panelEl) {
        HOLAF_THEMES.forEach(t => viewer.panelElements.panelEl.classList.remove(t.className));
        viewer.panelElements.panelEl.classList.add(themeConfig.className);
    }
}

/**
 * Applies all stored panel settings (size, position, theme, fullscreen state).
 * @param {object} viewer - The main image viewer instance.
 */
export function applyPanelSettings(viewer) {
    if (!viewer.panelElements || !viewer.panelElements.panelEl) return;
    
    const state = imageViewerState.getState();

    setTheme(viewer, state.ui.theme, false);

    const isFullscreen = state.panel_is_fullscreen;
    const panelIsFullscreen = viewer.panelElements.panelEl.classList.contains("holaf-panel-fullscreen");

    if (isFullscreen !== panelIsFullscreen) {
        HolafPanelManager.toggleFullscreen(viewer.panelElements.panelEl, (isFs) => saveSettings(viewer, { panel_is_fullscreen: isFs }));
    }

    if (!state.panel_is_fullscreen) {
        viewer.panelElements.panelEl.style.width = `${state.panel_width}px`;
        viewer.panelElements.panelEl.style.height = `${state.panel_height}px`;

        if (state.panel_x !== null && state.panel_y !== null) {
            viewer.panelElements.panelEl.style.left = `${state.panel_x}px`;
            viewer.panelElements.panelEl.style.top = `${state.panel_y}px`;
            viewer.panelElements.panelEl.style.transform = 'none';
        } else {
            viewer.panelElements.panelEl.style.left = '50%';
            viewer.panelElements.panelEl.style.top = '50%';
            viewer.panelElements.panelEl.style.transform = 'translate(-50%, -50%)';
        }
    }

    applyThumbnailFit(state.ui.thumbnail_fit);
    applyThumbnailSize(state.ui.thumbnail_size);
}

/**
 * Applies the 'fit' style (cover/contain) to the gallery.
 * @param {string} fitMode - 'cover' or 'contain'.
 */
export function applyThumbnailFit(fitMode) {
    const el = document.getElementById("holaf-viewer-gallery");
    if (el) el.classList.toggle('contain-thumbnails', fitMode === 'contain');
}

/**
 * Applies the thumbnail size CSS variable to the gallery.
 * @param {number} size - The size in pixels.
 */
export function applyThumbnailSize(size) {
    const el = document.getElementById("holaf-viewer-gallery");
    if (el) el.style.setProperty('--holaf-thumbnail-size', `${size}px`);
}