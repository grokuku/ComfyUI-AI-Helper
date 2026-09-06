/*
 * Copyright (C) 2025 Holaf
 * Holaf Utilities - Model Manager (Refactored)
 *
 * This is the main orchestrator script for the Model Manager. It initializes the component,
 * manages its state (queues, models, settings), and delegates UI, actions, and rendering
 * to specialized modules.
 */

import { app } from "./holaf_api_compat.js";
import { HOLAF_THEMES } from "./holaf_themes.js";
import { initializeSettings, saveSettings } from "./model_manager/model_manager_settings.js";
import { createPanel, createUploadDialog, applyZoom, setTheme, applySettingsToPanel } from "./model_manager/model_manager_ui.js";
import { renderModels, filterAndSortModels, updateActionButtonsState, updateStatusBarText } from "./model_manager/model_manager_view.js";
import { addFilesToUploadQueue, addSelectedToDownloadQueue, addSelectedToScanQueue, performDelete, processDownloadQueue, processScanQueue, processUploadQueue } from "./model_manager/model_manager_actions.js";

const holafModelManager = {
    // Core state
    panelElements: null,
    uploadDialog: null,
    isInitialized: false,
    areSettingsLoaded: false,
    isLoading: false, // For blocking operations like initial load or delete

    // Operation states
    isUploading: false,
    isDownloading: false,
    isDeepScanning: false,

    // Data and Queues
    models: [],
    modelTypesConfig: [],
    modelCountsPerDisplayType: {},
    selectedModelPaths: new Set(),
    
    uploadQueue: [],
    activeUploads: 0,
    uploadStats: { history: [], currentSpeed: 0, totalBytes: 0, totalSentBytes: 0 },
    refreshAfterUpload: false,

    downloadQueue: [],
    activeDownloads: 0,
    downloadStats: { history: [], currentSpeed: 0, totalBytes: 0, totalReceivedBytes: 0 },

    scanQueue: [],

    // UI and Settings State
    statusUpdateRaf: null,
    saveSettingsTimeout: null,
    currentSort: { column: 'name', order: 'asc' },
    settings: {
        theme: HOLAF_THEMES[0].name,
        panel_x: null,
        panel_y: null,
        panel_width: 800,
        panel_height: 550,
        panel_is_fullscreen: false,
        filter_type: "All",
        filter_search_text: "",
        sort_column: 'name',
        sort_order: 'asc',
        zoom_level: 1.0,
    },

    // Constants
    MIN_ZOOM: 0.7,
    MAX_ZOOM: 1.5,
    ZOOM_STEP: 0.1,
    MAX_CONCURRENT_UPLOADS: 1,
    MAX_CONCURRENT_DOWNLOADS: 1,
    MAX_CONCURRENT_CHUNKS: 4,
    UPLOAD_CHUNK_SIZE: 5 * 1024 * 1024,
    DOWNLOAD_CHUNK_SIZE: 5 * 1024 * 1024,
    
    // --- Method Delegation ---
    
    // Settings
    loadModelConfigAndSettings: function() { return initializeSettings(this); },
    saveSettings: function() { return saveSettings(this); },
    
    // UI
    createPanel: function() { return createPanel(this); },
    createUploadDialog: function() { return createUploadDialog(this); },
    setTheme: function(themeName) { return setTheme(this, themeName); },
    applyZoom: function() { return applyZoom(this); },
    applySettingsToPanel: function() { return applySettingsToPanel(this); },
    increaseZoom: function() {
        const newZoom = parseFloat((this.settings.zoom_level + this.ZOOM_STEP).toFixed(2));
        if (newZoom <= this.MAX_ZOOM) {
            this.settings.zoom_level = newZoom;
            this.applyZoom();
            this.saveSettings();
        }
    },
    decreaseZoom: function() {
        const newZoom = parseFloat((this.settings.zoom_level - this.ZOOM_STEP).toFixed(2));
        if (newZoom >= this.MIN_ZOOM) {
            this.settings.zoom_level = newZoom;
            this.applyZoom();
            this.saveSettings();
        }
    },
    
    // View
    renderModels: function(modelsToRender) { return renderModels(this, modelsToRender); },
    filterModels: function() { return filterAndSortModels(this); }, // Combined filter and sort
    updateActionButtonsState: function() { return updateActionButtonsState(this); },
    updateStatusBarText: function() { return updateStatusBarText(this); },

    // Actions
    addFilesToUploadQueue: function() { return addFilesToUploadQueue(this); },
    processUploadQueue: function() { return processUploadQueue(this); },
    addSelectedToDownloadQueue: function() { return addSelectedToDownloadQueue(this); },
    processDownloadQueue: function() { return processDownloadQueue(this); },
    addSelectedToScanQueue: function() { return addSelectedToScanQueue(this); },
    processScanQueue: function() { return processScanQueue(this); },
    performDelete: function() { return performDelete(this); },

    // Initialization
    init: function() {
        this.loadModelConfigAndSettings();
    },
    
    // Main show/hide toggle
    // FIX lenteur + anti-doublon : on crée le panneau IMMÉDIATEMENT (avec les
    // réglages par défaut) puis on charge les réglages serveur en async et on
    // les ré-applique une fois prêts (pattern skeleton). Avant, on attendait le
    // fetch réseau AVANT d'afficher la fenêtre, et un multi-clic pendant
    // l'attente créait plusieurs panneaux en double (panelElements encore null).
    show: async function() {
        if (!this.panelElements || !this.panelElements.panelEl) {
            this.createPanel();
            if (!this.areSettingsLoaded) {
                this.loadModelConfigAndSettings().then(() => {
                    if (this.panelElements && this.panelElements.panelEl) {
                        this.applySettingsToPanel();
                    }
                });
            }
        }

        const panelIsVisible = this.panelElements.panelEl.style.display === "flex";

        if (panelIsVisible) {
            this.panelElements.panelEl.style.display = "none";
            if (this.uploadDialog && this.uploadDialog.dialogEl) {
                this.uploadDialog.dialogEl.style.display = 'none';
            }
        } else {
            this.panelElements.panelEl.style.display = "flex";
            if (!this.isInitialized) {
                this.filterModels(); // This will also trigger the initial load
                this.isInitialized = true;
            } else {
                this.filterModels();
            }
            this.updateActionButtonsState();
        }
    },
};

// --- ComfyUI Extension Registration ---
app.holafModelManager = holafModelManager;

app.registerExtension({
    name: "Holaf.ModelManager.Panel",
    async setup() {
        holafModelManager.init();
    },
});

export default holafModelManager;