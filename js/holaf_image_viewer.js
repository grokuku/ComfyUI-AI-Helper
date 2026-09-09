/*
 * Copyright (C) 2025 Holaf
 * Holaf Utilities - Image Viewer UI
 *
 * MODIFIED: Added Debounce logic to prevent UI freeze on rapid filter changes.
 */

// Global variable for the ComfyUI App instance (only populated in main tab)
// Uses the compatibility layer via holaf_api_compat.js
import "./aih_strings.js";
import { app as comfyApp, api as comfyApi } from "./holaf_api_compat.js";
import { showToast, updateToast, hideToast } from "./aih_toast_bridge.js";
let app = comfyApp;

// Helper i18n central : traduit via AIH.I18n (clé brute si absente).
const t = (key, params) => {
    const I = window.AIH && window.AIH.I18n;
    return I && typeof I.t === "function" ? I.t(key, params) : key;
};

import { HolafPanelManager } from "./holaf_panel_manager.js";
import { HolafComfyBridge, holafBridge } from "./holaf_comfy_bridge.js";
import { HolafFetch, HolafFetchError } from "./vendor/holaf/holaf-fetch.js";
import { holafExtUrl } from './holaf_ext_base.js';
import * as Settings from './image_viewer/image_viewer_settings.js';
import { UI, createThemeMenu } from './image_viewer/image_viewer_ui.js';
import { initGallery, syncGallery, refreshThumbnailInGallery, forceRelayout } from './image_viewer/image_viewer_gallery.js';
import { PAGE_SIZE, setWindowLoaded, resetWindowCache, forEachLoadedImage } from './image_viewer/image_viewer_data.js';
import * as Actions from './image_viewer/image_viewer_actions.js';
import * as InfoPane from './image_viewer/image_viewer_infopane.js';
import * as Navigation from './image_viewer/image_viewer_navigation.js';
import { ImageEditor } from './image_viewer/image_viewer_editor.js';
import { imageViewerState } from './image_viewer/image_viewer_state.js';

const STATS_REFRESH_INTERVAL_MS = 2000;
const DOWNLOAD_CHUNK_SIZE = 5 * 1024 * 1024;
const FILTER_REFRESH_INTERVAL_MS = 2000;
// [NEW] Delay before reloading gallery after a filter click
const FILTER_DEBOUNCE_DELAY_MS = 300; 

// SVG icons for folder locks for better compatibility than emojis
const ICONS = {
    locked: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`,
    unlocked: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>`
};

const holafImageViewer = {
    // --- State & Properties ---
    editor: null,
    panelElements: null,
    elements: null, 
    isInitialized: false,
    areSettingsLoaded: false,
    settings: {},
    fullscreenElements: null,
    _fullscreenSourceView: null,
    _lastFolderFilterState: null,
    _lastFilterSignature: null,
    filterRefreshIntervalId: null,
    zoomViewState: { scale: 1, tx: 0, ty: 0 },
    fullscreenViewState: { scale: 1, tx: 0, ty: 0 },
    statsRefreshIntervalId: null,
    exportStatusRaf: null,
    _showCheckTimer: null,
    _statsDeferTimer: null,
    _statsDeferralScheduled: false,

    // --- Robust Filtering State ---
    isLoading: false,
    isDirty: false,
    filterDebounceTimer: null, // [NEW] Timer reference

    // --- Initialization & Core Lifecycle ---

    async init() {
        if (this.isInitialized) return;
        this.isInitialized = true;

        if (window.location.pathname === '/holaf/view') {
            document.body.classList.add('holaf-standalone-mode');
        }

        if (!window.holaf) window.holaf = {};
        // Toasts : la brique HolafToast (via aih_toast_bridge.js) est
        // self-contained (auto-injecte son CSS) et fonctionne aussi en mode
        // standalone — plus besoin du polyfill inline.

        document.addEventListener("keydown", (e) => this._handleKeyDown(e));
        const cssId = "holaf-image-viewer-css";
        if (!document.getElementById(cssId)) {
            const link = document.createElement("link");
            link.id = cssId;
            link.rel = "stylesheet";
            link.type = "text/css";
            link.href = holafExtUrl("css/holaf_image_viewer.css");
            document.head.appendChild(link);
        }

        await this.loadSettings();
        await this.loadAndPopulateFilters(true);
    },

    async show() {
        if (!this.panelElements) {
            this.createPanel();
            await this.loadAndPopulateFilters(false, true);
        }

        const panelIsVisible = this.panelElements?.panelEl && this.panelElements.panelEl.style.display === "flex";
        if (panelIsVisible) {
            if (window.location.pathname === '/holaf/view') {
            } else {
                this.hide();
                return;
            }
        }

        if (this.panelElements?.panelEl) {
            this.applyPanelSettings();
            this.panelElements.panelEl.style.display = "flex";
            HolafPanelManager.bringToFront(this.panelElements.panelEl);



            // Immediate load on show, no debounce needed here
            this.triggerFilterChange(true); 

            if (!this.filterRefreshIntervalId) {
                this.filterRefreshIntervalId = setInterval(() => this.checkForUpdates(), FILTER_REFRESH_INTERVAL_MS);
            }

            // Refresh as soon as a ComfyUI workflow execution finishes: new images
            // are written to the output folder and the gallery should pick them up
            // immediately instead of waiting for the next poll tick.
            if (!this._executionRefreshBound) {
                this._executionRefreshBound = true;
                const onExecutionFinished = () => {
                    if (this.panelElements?.panelEl && this.panelElements.panelEl.style.display !== "none") {
                        this.checkForUpdates();
                    }
                };
                comfyApi.addEventListener("execution_success", onExecutionFinished);
                comfyApi.addEventListener("execution_error", onExecutionFinished);
            }

            // Track gallery scrolling to skip update checks during active scroll
            const galleryEl = document.getElementById('holaf-viewer-gallery');
            if (galleryEl && !this._scrollTrackerSetup) {
                this._scrollTrackerSetup = true;
                let scrollStopTimer = null;
                galleryEl.addEventListener('scroll', () => {
                    this._isGalleryScrolling = true;
                    clearTimeout(scrollStopTimer);
                    scrollStopTimer = setTimeout(() => { this._isGalleryScrolling = false; }, 500);
                }, { passive: true });
            }

            this._updateViewerActivity(true);
            // Defer initial checkForUpdates to let the UI breathe (offset from 5s interval)
            if (this._showCheckTimer) clearTimeout(this._showCheckTimer);
            this._showCheckTimer = setTimeout(() => {
                this._showCheckTimer = null;
                this.checkForUpdates();
            }, FILTER_REFRESH_INTERVAL_MS + 3000);
        }
    },

    hide() {
        if (this.panelElements?.panelEl) {
            this.panelElements.panelEl.style.display = "none";
            if (this.statsRefreshIntervalId) {
                clearInterval(this.statsRefreshIntervalId);
                this.statsRefreshIntervalId = null;
            }
            if (this.filterRefreshIntervalId) {
                clearInterval(this.filterRefreshIntervalId);
                this.filterRefreshIntervalId = null;
            }
            if (this._showCheckTimer) {
                clearTimeout(this._showCheckTimer);
                this._showCheckTimer = null;
            }
            if (this._statsDeferTimer) {
                clearTimeout(this._statsDeferTimer);
                this._statsDeferTimer = null;
            }
            if (this._resyncDebounceTimer) {
                clearTimeout(this._resyncDebounceTimer);
                this._resyncDebounceTimer = null;
            }
            this._statsDeferralScheduled = false;
            this._updateViewerActivity(false);
            Navigation.stopPlayback(this);
        }
    },

    closePanel() {
        if (this.panelElements?.panelEl) {
            HolafPanelManager.unregister(this.panelElements.panelEl);
            this.hide();
        }
    },

    detachToStandalone() {
        window.open('/holaf/view', '_blank');
        this.closePanel();
    },

    loadSettings: function () { return Settings.loadSettings(this); },
    saveSettings: function (newSettings) { return Settings.saveSettings(this, newSettings); },
    setTheme: function (themeName, doSave = true) { return Settings.setTheme(this, themeName, doSave); },
    applyPanelSettings: function () { return Settings.applyPanelSettings(this); },
    _applyThumbnailFit: function () { return Settings.applyThumbnailFit(imageViewerState.getState().ui.thumbnail_fit); },

    _applyThumbnailSize: function (size) {
        if (size === undefined || !this.panelElements) return;
        Settings.applyThumbnailSize(size);
        forceRelayout(size);
    },

    _createFullscreenOverlay() {
        if (document.getElementById('holaf-viewer-fullscreen-overlay')) return;
        const overlay = document.createElement('div');
        overlay.id = 'holaf-viewer-fullscreen-overlay';
        overlay.style.display = 'none';
        overlay.innerHTML = `
            <button id="holaf-viewer-fs-close" class="holaf-viewer-fs-close" title="${t('iv.fsClose')}">✖</button>
            <button id="holaf-viewer-fs-prev" class="holaf-viewer-fs-nav" title="${t('iv.fsPrev')}">‹</button>
            <img src="" draggable="false" />
            <video controls loop id="holaf-viewer-fs-video" style="display: none;"></video>
            <button id="holaf-viewer-fs-next" class="holaf-viewer-fs-nav" title="${t('iv.fsNext')}">›</button>
        `;
        document.body.appendChild(overlay);

        this.fullscreenElements = {
            overlay,
            img: overlay.querySelector('img'),
            video: overlay.querySelector('video'),
            closeBtn: overlay.querySelector('#holaf-viewer-fs-close'),
            prevBtn: overlay.querySelector('#holaf-viewer-fs-prev'),
            nextBtn: overlay.querySelector('#holaf-viewer-fs-next')
        };
        this.fullscreenElements.closeBtn.onclick = () => this._handleEscape();
        this.fullscreenElements.prevBtn.onclick = () => this._navigate(-1);
        this.fullscreenElements.nextBtn.onclick = () => this._navigate(1);
        Navigation.setupZoomAndPan(this.fullscreenViewState, overlay, this.fullscreenElements.img);
    },

    createPanel() {
        if (this.panelElements && this.panelElements.panelEl) return;

        const state = imageViewerState.getState();
        const headerControls = document.createElement("div");
        headerControls.className = "holaf-header-button-group";

        if (window.location.pathname !== '/holaf/view') {
            const popOutButton = document.createElement("button");
            popOutButton.className = "holaf-header-button";
            popOutButton.title = t("iv.popOutTitle");
            popOutButton.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
            popOutButton.onclick = (e) => {
                e.stopPropagation();
                this.detachToStandalone();
            };
            headerControls.append(popOutButton);
        }

        const themeButtonContainer = document.createElement("div");
        themeButtonContainer.style.position = 'relative';
        const themeButton = document.createElement("button");
        themeButton.className = "holaf-header-button";
        themeButton.title = t("iv.theme");
        themeButton.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 12.55a9.42 9.42 0 0 1-9.45 9.45 9.42 9.42 0 0 1-9.45-9.45 9.42 9.42 0 0 1 9.45-9.45 2.5 2.5 0 0 1 2.5 2.5 2.5 2.5 0 0 0 2.5 2.5 2.5 2.5 0 0 1 0 5 2.5 2.5 0 0 0-2.5 2.5 2.5 2.5 0 0 1-2.5 2.5Z"/></svg>`;

        const themeMenu = createThemeMenu((themeName) => this.setTheme(themeName));
        themeButton.onclick = (e) => {
            e.stopPropagation();
            themeMenu.style.display = themeMenu.style.display === 'block' ? 'none' : 'block';
        };
        document.addEventListener('click', () => {
            if (themeMenu) themeMenu.style.display = 'none'
        });

        themeButtonContainer.append(themeButton, themeMenu);
        headerControls.append(themeButtonContainer);

        try {
            this.panelElements = HolafPanelManager.createPanel({
                id: "holaf-viewer-panel",
                title: t("iv.panelTitle"),
                headerContent: headerControls,
                defaultSize: { width: state.panel_width, height: state.panel_height },
                defaultPosition: { x: state.panel_x, y: state.panel_y },
                onClose: () => this.hide(),
                onStateChange: (newState) => this.saveSettings(newState),
                onFullscreenToggle: (isFullscreen) => this.saveSettings({ panel_is_fullscreen: isFullscreen }),
            });

            const typesToKeepFocus = ['text', 'search', 'number', 'password', 'url', 'email'];
            this.panelElements.panelEl.addEventListener('click', (e) => {
                const target = e.target;
                if (target.tagName === 'INPUT' && !typesToKeepFocus.includes(target.type)) {
                    target.blur();
                }
            });

            this.populatePanelContent();
            this.applyPanelSettings();
            this._createFullscreenOverlay();
            this._attachActionListeners();

            InfoPane.setupInfoPane();
            this.editor = new ImageEditor(this);
            this.editor.init();
            initGallery(this);

        } catch (e) {
            console.error("[Holaf ImageViewer] Error creating panel:", e);
            AIH.ask({ title: t("iv.panelError"), message: t("iv.panelErrorMsg") });
        }
    },

    populatePanelContent() {
        const contentEl = this.panelElements.contentEl;
        UI.init(contentEl, {
            getViewer: () => this,
            onFilterChange: (immediate) => this.triggerFilterChange(immediate),
            onResetFilters: () => this._resetFilters(),
        });
        this.elements = UI.elements;
        this._updateActionButtonsState();
    },

    _attachActionListeners: function () { return Actions.attachActionListeners(this); },
    _updateActionButtonsState: function () { return Actions.updateActionButtonsState(this); },
    handleDelete: function () { return Actions.handleDelete(this); },
    handleRestore: function () { return Actions.handleRestore(this); },
    handleExport: function () { return Actions.handleExport(this); },
    handleExtractMetadata: function () { return Actions.handleExtractMetadata(this); },
    handleInjectMetadata: function () { return Actions.handleInjectMetadata(this); },

    async _handleEmptyTrash() {
        if (await AIH.ask({
            title: t("iv.confirmEmptyTrashTitle"),
            message: t("iv.confirmEmptyTrashMsg"),
            buttons: [
                { text: t("iv.cancel"), value: false, type: "cancel" },
                { text: t("iv.permanentlyDelete"), value: true, type: "danger" }
            ]
        })) {
            try {
                // La brique lève sur non-2xx → catch (même écran que l'ancien else).
                const result = await HolafFetch.post("/holaf/images/empty-trashcan");

                AIH.ask({
                    title: t("iv.trashEmptiedTitle"),
                    message: result.message || t("iv.trashEmptiedMsg"),
                    buttons: [{ text: t("iv.ok"), value: true }]
                });
                this.loadAndPopulateFilters();
            } catch (error) {
                console.error("[Holaf ImageViewer] Error calling empty-trashcan API:", error);
                if (error instanceof HolafFetchError && error.status >= 400) {
                    // Non-2xx : même écran que l'ancienne branche else.
                    AIH.ask({
                        title: t("iv.error"),
                        message: t("iv.emptyTrashFailed", { message: error.data?.message || t("iv.unknownServerError") }),
                        buttons: [{ text: t("iv.ok"), value: true }]
                    });
                } else {
                    AIH.ask({
                        title: t("iv.apiError"),
                        message: t("iv.apiErrorMsg", { message: error.message }),
                        buttons: [{ text: t("iv.ok"), value: true }]
                    });
                }
            }
        }
    },

    // --- CRITICAL FIX: Debounced Filter Trigger ---
    triggerFilterChange(immediate = false) {
        this._saveCurrentFilterState();
        
        // Clear any pending triggers
        if (this.filterDebounceTimer) {
            clearTimeout(this.filterDebounceTimer);
            this.filterDebounceTimer = null;
        }

        if (immediate) {
            if (this.isLoading) {
                this.isDirty = true;
            } else {
                this._executeLoad();
            }
            return;
        }

        // If a load is already in progress, we mark dirty and wait.
        // The previous load's finally block will handle re-triggering,
        // but we still debounce the marking to avoid UI flicker.
        this.filterDebounceTimer = setTimeout(() => {
            if (this.isLoading) {
                this.isDirty = true;
                return;
            }
            this._executeLoad();
        }, FILTER_DEBOUNCE_DELAY_MS);
    },

    _executeLoad() {
        // Reset dirty flag immediately when starting a load
        this.isDirty = false; 
        this.loadFilteredImages();
    },

    async checkForUpdates() {
        if (this.isLoading) return;
        // Skip update check if user is actively scrolling the gallery
        // to avoid JSON.parse of large payloads blocking the main thread
        if (this._isGalleryScrolling) {
            return;
        }
        const tStart = performance.now();
        try {
            // La brique lève sur non-2xx/non-JSON. Poll toutes les 2 s : on
            // garde l'ancien retour silencieux sur échec HTTP (pas de spam console).
            const data = await HolafFetch.get('/holaf/images/last-update-time', { cache: 'no-store' })
                .catch((e) => {
                    if (e instanceof HolafFetchError && e.status >= 400) return null;
                    throw e;
                });
            if (!data) return;

            const state = imageViewerState.getState();
            if (data.last_update <= state.status.lastDbUpdateTime) return;

            console.log("[Holaf ImageViewer] New data detected on server.");
            imageViewerState.setState({ status: { lastDbUpdateTime: data.last_update } });

            // Keep the existing empty-folder_filters early-return behavior exactly as-is:
            // nothing to display → just refresh the filter options (and loadFilteredImages'
            // own early-return clears the gallery, matching the pre-existing flow).
            const { folder_filters } = imageViewerState.getState().filters;
            if (Array.isArray(folder_filters) && folder_filters.length === 0) {
                await this.loadAndPopulateFilters(false, true);
                await this.loadFilteredImages();
                return;
            }

            // If the folder/format signature changed (new folder, new format, ...), fall
            // back to the original full refresh so the new folders/images are picked up.
            // Identical signatures skip the filter DOM rebuild entirely.
            // Ancien comportement : !filterResponse.ok → vérification de signature
            // simplement sautée (le poll continue) ; erreur réseau → catch global.
            const filterData = await HolafFetch.get('/holaf/images/filter-options', { cache: 'no-store' })
                .catch((e) => {
                    if (e instanceof HolafFetchError && e.status >= 400) return null;
                    throw e;
                });
            if (filterData && this._filterSignatureChanged(filterData)) {
                console.log("[Holaf ImageViewer] Folder/format signature changed — full refresh.");
                await this.loadAndPopulateFilters(false, true);
                await this.loadFilteredImages();
                return;
            }

            // Incremental refresh: only fetch images newer than the current top mtime.
            const currentImages = imageViewerState.getState().images;
            if (!currentImages || currentImages.length === 0) {
                // First load / no top mtime → full fetch as today.
                await this.loadFilteredImages();
                return;
            }

            let topMtime = 0;
            forEachLoadedImage(imageViewerState.getState(), (img) => {
                if (img.mtime && img.mtime > topMtime) topMtime = img.mtime;
            });
            if (topMtime <= 0) {
                // No usable mtime — fall back to a full fetch.
                await this.loadFilteredImages();
                return;
            }

            const delta = await this._fetchIncrementalImages(topMtime);
            if (delta && delta.generated_thumbnails_count !== undefined) {
                imageViewerState.setState({ status: { generatedThumbnailsCount: delta.generated_thumbnails_count } });
            }

            const newImages = (delta && delta.images) || [];
            if (newImages.length > 0) {
                const g = document.getElementById('holaf-viewer-gallery');
                const isAtTop = g ? (g.scrollTop < g.clientHeight) : true;
                if (isAtTop) {
                    // Debounce: coalesce les rafales de "new data" (batch de génération) en un
                    // seul rechargement, pour éviter de refaire COUNT + fetch + rebuild en boucle.
                    if (this._resyncDebounceTimer) clearTimeout(this._resyncDebounceTimer);
                    this._resyncDebounceTimer = setTimeout(() => {
                        this._resyncDebounceTimer = null;
                        this.loadFilteredImages();
                    }, 1200);
                } else {
                    imageViewerState.setState({ status: { pendingNewImages: true } });
                    showToast({ message: t("iv.newImagesDetected"), type: "info" });
                }
            } else if (delta && delta.total_db_count !== undefined) {
                // Nothing changed for the current filter — just keep the counter fresh.
                this.updateStatusBar(currentImages.length, delta.total_db_count);
            }
        } catch (e) {
            console.error("[Holaf ImageViewer] Error checking for updates:", e);
        } finally {
            const totalMs = performance.now() - tStart;
            if (totalMs > 100) {
                console.log("[Holaf Perf] checkForUpdates total_ms=" + totalMs.toFixed(1));
            }
        }
    },

    _performFullReset(resetLocks) {
        const newFilters = {
            filename_search: '',
            prompt_search: '',
            workflow_search: '',
            startDate: '',
            endDate: '',
            tags_filter: [],
            bool_filters: { has_workflow: null, has_prompt: null, has_edits: null, has_tags: null },
        };

        if (resetLocks) {
            newFilters.locked_folders = [];
        } else {
            newFilters.locked_folders = imageViewerState.getState().filters.locked_folders;
        }

        this.saveSettings(newFilters);

        document.querySelectorAll('#holaf-viewer-folders-filter input[type="checkbox"]').forEach(cb => {
            const item = cb.closest('.holaf-viewer-filter-item');
            const folderId = item ? item.dataset.folderId : null;
            const isLocked = !resetLocks && folderId && newFilters.locked_folders.includes(folderId);
            if (!isLocked) {
                cb.checked = true;
            }
        });
        document.querySelectorAll('#holaf-viewer-formats-filter input[type="checkbox"]').forEach(cb => cb.checked = true);

        if (resetLocks) {
            document.querySelectorAll('.holaf-folder-lock-icon.locked').forEach(icon => {
                icon.classList.remove('locked');
                icon.innerHTML = ICONS.unlocked;
                icon.title = 'Lock this folder (prevents changes from All/None/Invert)';
            });
        }

        const trashCheckbox = document.getElementById('folder-filter-trashcan');
        if (trashCheckbox) trashCheckbox.checked = false;

        this.triggerFilterChange(true); // Reset is typically deliberate, so immediate
    },

    async _resetFilters() {
        const { locked_folders } = imageViewerState.getState().filters;
        if (locked_folders.length === 0) {
            this._performFullReset(true);
            return;
        }

        const choice = await AIH.ask({
            title: t("iv.resetFiltersConfirmTitle"),
            message: t("iv.resetFiltersConfirmMsg"),
            buttons: [
                { text: t("iv.cancel"), value: "cancel", type: "cancel" },
                { text: t("iv.resetKeepLocks"), value: "reset_keep_locks" },
                { text: t("iv.unlockAndReset"), value: "unlock_and_reset", type: "confirm" }
            ]
        });

        switch (choice) {
            case "unlock_and_reset": this._performFullReset(true); break;
            case "reset_keep_locks": this._performFullReset(false); break;
            case "cancel": default: return;
        }
    },

    _saveCurrentFilterState() {
        if (!this.panelElements) return;

        const selectedFolders = [...document.querySelectorAll('#holaf-viewer-folders-filter input:checked')].map(cb => cb.id.replace('folder-filter-', ''));
        const selectedFormats = [...document.querySelectorAll('#holaf-viewer-formats-filter input:checked')].map(cb => cb.id.replace('format-filter-', ''));
        const currentFilters = imageViewerState.getState().filters;

        const settingsToSave = {
            folder_filters: selectedFolders,
            format_filters: selectedFormats,
            startDate: UI.elements.dateStart ? UI.elements.dateStart.value : '',
            endDate: UI.elements.dateEnd ? UI.elements.dateEnd.value : '',
            filename_search: currentFilters.filename_search,
            prompt_search: currentFilters.prompt_search,
            workflow_search: currentFilters.workflow_search,
        };

        this.saveSettings(settingsToSave);
    },

    async loadAndPopulateFilters(isInitialLoad = false, isUpdate = false) {
        try {
            // La brique lève sur non-2xx/non-JSON → catch : message d'erreur
            // dans le panneau des filtres (comportement inchangé).
            const data = await HolafFetch.get('/holaf/images/filter-options', { cache: 'no-store' });

            const state = imageViewerState.getState();
            imageViewerState.setState({ status: { lastDbUpdateTime: data.last_update_time || state.status.lastDbUpdateTime } });

            // Remember the current folder/format signature so checkForUpdates can detect
            // structural changes (new folder/format) without rebuilding the filter DOM
            // on every detection pass.
            this._lastFilterSignature = {
                subfolders: (data.subfolders || []).map(f => f.path).sort().join('\u0000'),
                formats: (data.formats || []).slice().sort().join('\u0000')
            };

            if (this.panelElements) {
                const tagSuggestionsEl = document.getElementById('holaf-viewer-tag-suggestions');
                if (tagSuggestionsEl) {
                    tagSuggestionsEl.innerHTML = '';
                    (data.tags || []).forEach(tag => {
                        const option = document.createElement('option');
                        option.value = tag;
                        tagSuggestionsEl.appendChild(option);
                    });
                }

                const foldersEl = document.getElementById('holaf-viewer-folders-filter');
                const formatsEl = document.getElementById('holaf-viewer-formats-filter');

                if (foldersEl) foldersEl.innerHTML = '';
                if (formatsEl) formatsEl.innerHTML = '';

                const onFilterChange = () => this.triggerFilterChange();

                const { folder_filters, format_filters } = state.filters;
                const hasSavedFolderFilters = folder_filters !== null;
                const hasSavedFormatFilters = format_filters !== null;

                const allFolderData = data.subfolders.filter(f => f.path !== 'trashcan');
                const trashData = data.subfolders.find(f => f.path === 'trashcan');

                if (foldersEl) {
                    allFolderData.forEach(folderData => {
                        const id = folderData.path;
                        const isChecked = !hasSavedFolderFilters || folder_filters.includes(id);
                        const label = id === 'root' ? `(root) (${folderData.count})` : `${id} (${folderData.count})`;
                        foldersEl.appendChild(this.createFilterItem(`folder-filter-${id}`, label, isChecked, onFilterChange, id));
                    });

                    if (trashData) {
                        const separator = document.createElement('div');
                        separator.className = 'holaf-viewer-trash-separator';
                        foldersEl.appendChild(separator);

                        const isTrashChecked = hasSavedFolderFilters && folder_filters.includes('trashcan');

                        const trashCheckboxItem = this.createFilterItem('folder-filter-trashcan', t('iv.trashcan'), isTrashChecked, (e) => {
                            const otherFolderCheckboxes = foldersEl.querySelectorAll('input[type="checkbox"]:not(#folder-filter-trashcan)');
                            if (e.target.checked) {
                                this._lastFolderFilterState = [...otherFolderCheckboxes].filter(cb => cb.checked).map(cb => cb.id);
                                otherFolderCheckboxes.forEach(cb => { cb.checked = false; cb.disabled = true; });
                            } else {
                                otherFolderCheckboxes.forEach(cb => {
                                    cb.disabled = false;
                                    if (this._lastFolderFilterState && this._lastFolderFilterState.includes(cb.id)) {
                                        cb.checked = true;
                                    }
                                });
                            }
                            onFilterChange();
                        });

                        const trashContainer = trashCheckboxItem;
                        trashContainer.style.display = 'flex';
                        trashContainer.style.justifyContent = 'space-between';
                        trashContainer.style.alignItems = 'center';

                        const emptyTrashBtn = document.createElement('button');
                        emptyTrashBtn.textContent = t('iv.empty');
                        emptyTrashBtn.title = t('iv.emptyTrashTitle');
                        emptyTrashBtn.style.cssText = 'font-size: 10px; padding: 2px 6px; margin-left: 10px; background-color: var(--holaf-error-color, #802020); color: var(--holaf-button-text, white); border: 1px solid var(--holaf-border-color, #c03030); cursor: pointer; border-radius: 4px;';
                        emptyTrashBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); this._handleEmptyTrash(); };
                        trashContainer.appendChild(emptyTrashBtn);
                        foldersEl.appendChild(trashContainer);

                        if (trashCheckboxItem && trashCheckboxItem.querySelector('input').checked) {
                            foldersEl.querySelectorAll('input[type="checkbox"]:not(#folder-filter-trashcan)').forEach(cb => cb.disabled = true);
                        }
                    }
                }

                if (formatsEl) {
                    data.formats.forEach(format => {
                        const isChecked = !hasSavedFormatFilters || format_filters.includes(format);
                        formatsEl.appendChild(this.createFilterItem(`format-filter-${format}`, format, isChecked, onFilterChange));
                    });
                }
            }

            if (!isUpdate) {
                await this.loadFilteredImages(isInitialLoad);
            }
        } catch (e) {
            console.error("[Holaf ImageViewer] Failed to load filter options:", e);
            if (this.panelElements && document.getElementById('holaf-viewer-folders-filter')) {
                document.getElementById('holaf-viewer-folders-filter').innerHTML = `<p class="holaf-viewer-message error">${t('iv.errorLoadingFilters')}</p>`;
            }
        }
    },

    async _fetchFilteredImages(limit = null, offset = 0) {
        console.time('BE Fetch & Parse');
        const { filters } = imageViewerState.getState();
        const payload = { ...filters };
        delete payload.locked_folders;

        if (limit != null) {
            payload.limit = limit;
            payload.offset = offset;
        }

        // POST JSON + parse gérés par la brique (lève sur non-2xx/non-JSON).
        const data = await HolafFetch.post('/holaf/images/list', { body: payload })
            .catch((e) => {
                // Message historique conservé : « HTTP error <status> » est
                // affiché dans la zone de chargement par loadFilteredImages().
                if (e instanceof HolafFetchError && e.status >= 400) {
                    throw new Error(`HTTP error ${e.status}`);
                }
                throw e;
            });

        console.timeEnd('BE Fetch & Parse');
        return data;
    },

    /**
     * Fetch ONLY images with mtime > minMtime (same filters as the current view).
     * The backend returns them already ordered by mtime DESC, so they are newer
     * than everything currently in state.images.
     */
    async _fetchIncrementalImages(minMtime) {
        const { filters } = imageViewerState.getState();
        const payload = { ...filters };
        delete payload.locked_folders;
        payload.min_mtime = minMtime;
        // POST JSON + parse gérés par la brique (lève sur non-2xx/non-JSON →
        // catch de checkForUpdates, trace console inchangée).
        return HolafFetch.post('/holaf/images/list', { body: payload });
    },

    /**
     * Compares the folder/format signature of a fresh filter-options payload with the
     * last one we rendered. Returns true when the list of folders or formats changed.
     * The cached signature is always refreshed so the next comparison uses the latest.
     */
    _filterSignatureChanged(filterData) {
        const next = {
            subfolders: (filterData.subfolders || []).map(f => f.path).sort().join('\u0000'),
            formats: (filterData.formats || []).slice().sort().join('\u0000')
        };
        const previous = this._lastFilterSignature;
        const changed = !previous || previous.subfolders !== next.subfolders || previous.formats !== next.formats;
        this._lastFilterSignature = next;
        return changed;
    },

    async loadFilteredImages(isInitialLoad = false) {
        if (this.isLoading) return; 
        
        this.isLoading = true;
        this._loadingMore = false;
        
        console.log("%c[Holaf Perf] Starting filter process...", "color: lightblue; font-weight: bold;");
        console.time('Total Filter to Render Time');

        try {
            const { filters } = imageViewerState.getState();
            // An explicitly empty folder_filters array means the user deselected ALL
            // folders → show zero images (placeholder). A null/undefined value means
            // "no folder filter" → keep the normal (all folders) behaviour.
            if (Array.isArray(filters.folder_filters) && filters.folder_filters.length === 0) {
                resetWindowCache();
                imageViewerState.setState({
                    images: [],
                    totalCount: 0,
                    selectedImages: new Set(),
                    activeImage: null,
                    currentNavIndex: -1,
                    status: { pendingNewImages: false, isLoading: false, error: null }
                });
                this.syncGallery([]);
                this.updateStatusBar(0, imageViewerState.getState().status.totalImageCount);
                this._updateActionButtonsState();
                this.isLoading = false;
                console.timeEnd('Total Filter to Render Time');
                if (this.isDirty) { this._executeLoad(); }
                return;
            }

            if (isInitialLoad && this.panelElements) {
                this.setLoadingState(t("iv.applyingFilters"));
            }

            const currentState = imageViewerState.getState();
            const currentSelectedPaths = new Set(currentState.selectedPaths);
            const activeImageCanonPath = currentState.activeImage ? currentState.activeImage.path_canon : null;

            resetWindowCache();
            imageViewerState.setState({ selectedImages: new Set() });

            const data = await this._fetchFilteredImages(PAGE_SIZE, 0);
            const windowImages = data.images || [];
            const totalCount = (data.total_count != null) ? data.total_count : (data.filtered_count ?? 0);
            const sparse = new Array(totalCount);

            const newSelectedImages = new Set();
            if (currentSelectedPaths.size > 0) {
                windowImages.forEach(img => {
                    if (currentSelectedPaths.has(img.path_canon)) {
                        newSelectedImages.add(img);
                    }
                });
            }

            let newActiveImage = null;
            let newNavIndex = -1;

            if (activeImageCanonPath) {
                newNavIndex = windowImages.findIndex(img => img.path_canon === activeImageCanonPath);
                if (newNavIndex > -1) {
                    newActiveImage = windowImages[newNavIndex];
                }
            }

            console.time('State Update & Gallery Sync');
            const currentStatus = imageViewerState.getState().status;
            imageViewerState.setState({
                images: sparse,
                totalCount,
                selectedImages: newSelectedImages,
                activeImage: newActiveImage,
                currentNavIndex: newNavIndex,
                status: { ...currentStatus, pendingNewImages: false, isLoading: false, error: null }
            });

            setWindowLoaded(imageViewerState.getState(), 0, windowImages);

            this.syncGallery(sparse);
            console.timeEnd('State Update & Gallery Sync');

            this.updateStatusBar(totalCount, data.total_db_count);


            const allThumbsGenerated = data.total_db_count > 0 && data.generated_thumbnails_count >= data.total_db_count;
            imageViewerState.setState({
                status: {
                    allThumbnailsGenerated: allThumbsGenerated,
                    generatedThumbnailsCount: data.generated_thumbnails_count || 0,
                }
            });

            if (!allThumbsGenerated && !this.statsRefreshIntervalId) {
                // Defer stats refresh only once to avoid starvation on rapid filter changes
                if (!this._statsDeferralScheduled) {
                    this._statsDeferralScheduled = true;
                    if (this._statsDeferTimer) clearTimeout(this._statsDeferTimer);
                    this._statsDeferTimer = setTimeout(() => {
                        this._statsDeferTimer = null;
                        if (!this.statsRefreshIntervalId) {
                            this.statsRefreshIntervalId = setInterval(() => this.fetchAndUpdateThumbnailStats(), STATS_REFRESH_INTERVAL_MS);
                        }
                    }, 3000);
                }
            } else if (allThumbsGenerated && this.statsRefreshIntervalId) {
                clearInterval(this.statsRefreshIntervalId); this.statsRefreshIntervalId = null;
            }

        } catch (e) {
            console.error("[Holaf ImageViewer] Failed to load images:", e);
            if (this.panelElements) this.setLoadingState(`Error: ${e.message}`);
            imageViewerState.setState({ images: [], totalCount: 0, activeImage: null, currentNavIndex: -1, status: { error: e.message } });
        } finally {
            this.isLoading = false;
            if (this.isDirty) {
                setTimeout(() => this._executeLoad(), 0);
            }
            this._updateActionButtonsState();
            console.timeEnd('Total Filter to Render Time');
        }
    },



    syncGallery: function (images) {
        if (this.panelElements) { 
            syncGallery(this, images);
        }
    },
    refreshSingleThumbnail: function (path_canon) { return refreshThumbnailInGallery(path_canon); },

    _handleKeyDown: function (e) { return Navigation.handleKeyDown(this, e); },
    _navigate: function (direction) { return Navigation.navigate(this, direction); },
    _navigateGrid: function (direction) { return Navigation.navigateGrid(this, direction); },
    _handleEscape: function () { return Navigation.handleEscape(this); },
    _showZoomedView: function (image) {
        if (image) Navigation.showZoomedView(this, image);
    },
    _hideZoomedView: function () { return Navigation.hideZoomedView(this); },
    _showFullscreenView: function () {
        const { activeImage } = imageViewerState.getState();
        if (activeImage) Navigation.showFullscreenView(this, activeImage);
    },
    _hideFullscreenView: function () { return Navigation.hideFullscreenView(this); },

    _startStatusAnimation() {
        if (this.exportStatusRaf) return;
        const loop = () => {
            this.updateStatusBar();
            this.exportStatusRaf = requestAnimationFrame(loop);
        };
        this.exportStatusRaf = requestAnimationFrame(loop);
    },

    _stopStatusAnimation() {
        if (this.exportStatusRaf) {
            cancelAnimationFrame(this.exportStatusRaf);
            this.exportStatusRaf = null;
        }
    },

    async processExportDownloadQueue() {
        let state = imageViewerState.getState();
        if (state.exporting.queue.length === 0) {
            this._stopStatusAnimation();

            const newExportStats = { totalFiles: 0, completedFiles: 0, currentFileName: '', currentFileProgress: 0 };
            imageViewerState.setState({
                status: { isExporting: false },
                exporting: { stats: newExportStats, activeToastId: null }
            });

            if (state.exporting.activeToastId && state.exporting.stats.completedFiles > 0) {
                updateToast(state.exporting.activeToastId, {
                    message: t("iv.exportQueueComplete", { count: state.exporting.stats.completedFiles }),
                    type: 'success',
                    progress: 100,
                    html: true
                });
                setTimeout(() => hideToast(state.exporting.activeToastId), 5000);
            } else if (state.exporting.activeToastId) {
                hideToast(state.exporting.activeToastId);
            }
            this.updateStatusBar();
            return;
        }

        this._startStatusAnimation();

        const newQueue = [...state.exporting.queue];
        const fileToDownload = newQueue.shift();
        const { export_id, path, size } = fileToDownload;
        const filename = path.split('/').pop();

        imageViewerState.setState({
            exporting: {
                queue: newQueue,
                stats: { ...state.exporting.stats, currentFileName: filename, currentFileProgress: 0 }
            }
        });

        state = imageViewerState.getState();

        let receivedBytes = 0;
        const chunks = [];
        const totalChunks = Math.ceil(size / DOWNLOAD_CHUNK_SIZE);

        try {
            for (let i = 0; i < totalChunks; i++) {
                const url = new URL(window.location.origin);
                url.pathname = '/holaf/images/export-chunk';
                url.search = new URLSearchParams({
                    export_id: export_id,
                    file_path: path,
                    chunk_index: i,
                    chunk_size: DOWNLOAD_CHUNK_SIZE
                });

                // raw:true → Response brute : lecture arrayBuffer() inchangée.
                // (En mode brut la brique ne lève pas sur non-2xx → test .ok conservé.)
                const response = await HolafFetch.get(url, { raw: true });
                if (!response.ok) throw new Error(`HTTP error ${response.status} for chunk ${i}`);

                const chunk = await response.arrayBuffer();
                chunks.push(chunk);
                receivedBytes += chunk.byteLength;

                imageViewerState.setState({
                    exporting: {
                        stats: {
                            ...imageViewerState.getState().exporting.stats,
                            currentFileProgress: (receivedBytes / size) * 100
                        }
                    }
                });
            }

            const blob = new Blob(chunks);
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);

            const currentCompleted = imageViewerState.getState().exporting.stats.completedFiles;
            imageViewerState.setState({ exporting: { stats: { completedFiles: currentCompleted + 1 } } });

            setTimeout(() => this.processExportDownloadQueue(), 100);

        } catch (error) {
            console.error(`[Holaf ImageViewer] Failed to download file ${filename}:`, error);
            const activeToastId = imageViewerState.getState().exporting.activeToastId;
            if (activeToastId) {
                updateToast(activeToastId, {
                    message: t("iv.downloadFailed", { filename, error: error.message }),
                    type: 'error',
                    progress: 100,
                    html: true
                });
            }
            this._stopStatusAnimation();
            imageViewerState.setState({ status: { isExporting: false }, exporting: { activeToastId: null } });
            this.updateStatusBar();
        }
    },

    _updateActiveThumbnail(navIndex) {
    },

    async fetchAndUpdateThumbnailStats() {
        if (this.isLoading) return; 
        const state = imageViewerState.getState();
        if (state.status.allThumbnailsGenerated && this.statsRefreshIntervalId) {
            clearInterval(this.statsRefreshIntervalId); this.statsRefreshIntervalId = null; return;
        }
        try {
            // La brique lève sur non-2xx → catch vide historique (poll silencieux).
            const stats = await HolafFetch.get('/holaf/images/thumbnail-stats');

            const allGenerated = stats.generated_thumbnails_count >= stats.total_db_count;
            imageViewerState.setState({
                status: {
                    allThumbnailsGenerated: allGenerated,
                    generatedThumbnailsCount: stats.generated_thumbnails_count,
                    totalImageCount: stats.total_db_count
                }
            });

            this.updateStatusBar();

            if (allGenerated && this.statsRefreshIntervalId) {
                clearInterval(this.statsRefreshIntervalId); this.statsRefreshIntervalId = null;
            }
        } catch (e) { }
    },

    updateStatusBar(filteredCount, totalCount) {
        const statusBarEl = document.getElementById('holaf-viewer-statusbar');
        if (!statusBarEl) return;
        const state = imageViewerState.getState();

        if (state.status.isExporting) {
            const progress = state.exporting.stats.currentFileProgress.toFixed(1);
            const text = t("iv.exportingStatus", { done: state.exporting.stats.completedFiles + 1, total: state.exporting.stats.totalFiles, name: state.exporting.stats.currentFileName });
            statusBarEl.textContent = `${text} [${progress}%]`;

            if (state.exporting.activeToastId) {
                updateToast(state.exporting.activeToastId, {
                    message: text,
                    progress: state.exporting.stats.currentFileProgress
                });
            }
            return;
        }

        const currentFilteredCount = filteredCount !== undefined ? filteredCount : state.status.filteredImageCount;
        const currentTotalDbCount = totalCount !== undefined ? totalCount : state.status.totalImageCount;

        if (filteredCount !== undefined) imageViewerState.setState({ status: { filteredImageCount: filteredCount } });
        if (totalCount !== undefined) imageViewerState.setState({ status: { totalImageCount: totalCount } });

        let statusText = t("iv.displaying", { filtered: currentFilteredCount, total: currentTotalDbCount });

        if (state.exporting.queue.length > 0) {
            statusText += t("iv.exportQueueStatus", { count: state.exporting.queue.length });
        } else if (currentTotalDbCount > 0 && !state.status.allThumbnailsGenerated) {
            const percentage = ((state.status.generatedThumbnailsCount / currentTotalDbCount) * 100).toFixed(1);
            statusText += t("iv.thumbnailsStatus", { done: state.status.generatedThumbnailsCount, total: currentTotalDbCount, percentage });
        } else if (currentTotalDbCount === 0) {
            statusText += t("iv.thumbnailsNA");
        }

        const selectedCount = imageViewerState.getState().selectedPaths.size;
        if (selectedCount > 0) {
            statusText += t("iv.selectedStatus", { count: selectedCount });
        }
        statusBarEl.textContent = statusText;
    },

    createFilterItem(id, label, isChecked, onChange, folderId = null) {
        const container = document.createElement('div');
        container.className = 'holaf-viewer-filter-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = id;
        checkbox.checked = isChecked;
        checkbox.onchange = onChange;

        const labelEl = document.createElement('label');
        labelEl.htmlFor = id;
        labelEl.textContent = label;

        const elementsToAppend = [];

        if (folderId) {
            container.dataset.folderId = folderId;
            const lockIcon = document.createElement('a');
            lockIcon.href = '#';
            lockIcon.className = 'holaf-folder-lock-icon';

            const { locked_folders } = imageViewerState.getState().filters;
            const isLocked = locked_folders.includes(folderId);

            lockIcon.innerHTML = isLocked ? ICONS.locked : ICONS.unlocked;
            lockIcon.title = isLocked ? t('iv.unlockFolderTitle') : t('iv.lockFolderTitle');
            lockIcon.classList.toggle('locked', isLocked);

            lockIcon.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();

                const currentState = imageViewerState.getState();
                let currentLocked = [...currentState.filters.locked_folders];
                const isCurrentlyLocked = currentLocked.includes(folderId);

                if (isCurrentlyLocked) {
                    currentLocked = currentLocked.filter(f => f !== folderId);
                } else {
                    currentLocked.push(folderId);
                }

                this.saveSettings({ locked_folders: currentLocked });

                lockIcon.innerHTML = !isCurrentlyLocked ? ICONS.locked : ICONS.unlocked;
                lockIcon.title = !isCurrentlyLocked ? t('iv.unlockFolderTitle') : t('iv.lockFolderTitle');
                lockIcon.classList.toggle('locked', !isCurrentlyLocked);
            };
            elementsToAppend.push(lockIcon);
        }

        elementsToAppend.push(checkbox, labelEl);
        container.append(...elementsToAppend);

        return container;
    },

    setLoadingState(message) {
        if (this.panelElements) {
            const g = document.getElementById("holaf-viewer-gallery");
            if (g) g.innerHTML = `<p class="holaf-viewer-message">${message}</p>`;
        }
    },

    async _updateViewerActivity(isActive) {
        // Fire-and-forget (heartbeat) : la brique lève sur non-2xx → .catch()
        // vide pour éviter toute unhandled rejection.
        HolafFetch.post('/holaf/images/viewer-activity', { body: { active: isActive } })
            .catch(() => {});
    },
};

(async () => {
    const isStandalone = window.location.pathname.startsWith('/holaf/view');

    if (isStandalone) {
        console.log("[Holaf] Standalone mode detected. Skipping ComfyUI app import.");
        return;
    }

    try {
        // app is already available via compat layer (window.comfyAPI or legacy import)
        app = comfyApp;

        if (app) {
            app.holafImageViewer = holafImageViewer;

            app.registerExtension({
                name: "Holaf.ImageViewer.Panel",
                async setup() {
                    await holafImageViewer.init();

                    holafBridge.listen((data) => {
                        if (data.type === 'LOAD_WORKFLOW') {
                            console.log("[Holaf Bridge] Received workflow from standalone gallery.");
                            try {
                                app.loadGraphData(data.payload);
                                showToast({ message: t("iv.workflowLoadedFromGallery"), type: "success" });
                            } catch (e) {
                                console.error("Failed to load workflow from bridge:", e);
                            }
                        }
                    });

                    const injectButton = () => {
                        const menu = document.querySelector(".comfy-menu");
                        if (!menu) return false;

                        if (menu.querySelector("#holaf-standalone-btn")) return true;

                        const buttons = Array.from(menu.querySelectorAll('button'));
                        const mainButton = buttons.find(b => b.textContent && b.textContent.includes("AIH Image Viewer"));

                        if (mainButton) {
                            const standaloneLink = document.createElement("button");
                            standaloneLink.id = "holaf-standalone-btn"; 
                            standaloneLink.textContent = t("iv.viewerNewTab");
                            standaloneLink.style.fontSize = "0.8em";
                            standaloneLink.style.opacity = "0.8";
                            standaloneLink.style.marginTop = "-5px";
                            standaloneLink.onclick = () => {
                                holafImageViewer.detachToStandalone();
                            };
                            mainButton.parentNode.insertBefore(standaloneLink, mainButton.nextSibling);
                            return true;
                        }
                        return false;
                    };

                    let attempts = 0;
                    const interval = setInterval(() => {
                        if (injectButton() || attempts > 20) {
                            clearInterval(interval);
                        }
                        attempts++;
                    }, 500);
                }
            });
        }
    } catch (e) {
        console.log("[Holaf] Error setting up ImageViewer (possibly standalone or unexpected error):", e);
    }
})();

export function initStandaloneGallery() {
    console.log("[Holaf] Initializing Standalone Gallery...");
    holafImageViewer.init().then(() => {
        holafImageViewer.show();
    });
}

export default holafImageViewer;