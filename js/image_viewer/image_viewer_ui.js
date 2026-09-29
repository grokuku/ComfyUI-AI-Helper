/*
 * Copyright (C) 2025 Holaf
 * Holaf Utilities - Image Viewer UI Module
 */

import "../aih_strings.js";
import { HOLAF_THEMES } from '../holaf_themes.js';
import { imageViewerState } from './image_viewer_state.js';
import * as Navigation from './image_viewer_navigation.js';
import { HolafFetch } from '../vendor/holaf/holaf-fetch.js';
import { showToast as bridgeShowToast } from '../aih_toast_bridge.js';
import {
    SOURCE_LOCAL,
    SOURCE_REMOTE,
    applySourceSwitch,
    getRemoteStatus,
    normalizeSourceId,
    describeRemoteHost,
} from './image_viewer_source_switch.js';

// Helper i18n central : traduit via AIH.I18n (clé brute si absente).
const t = (key, params) => {
    const I = window.AIH && window.AIH.I18n;
    return I && typeof I.t === "function" ? I.t(key, params) : key;
};

class ImageViewerUI {
    constructor() {
        this.elements = {};
        this.callbacks = {};
        this.isDraggingSlider = false;

        this.scopeState = {
            filename: true,
            prompt: false,
            workflow: false
        };
    }

    init(container, callbacks) {
        this.callbacks = callbacks;

        this.elements.container = container;
        this.elements.container.innerHTML = '';
        this.elements.container.style.display = 'flex';
        this.elements.container.style.flexDirection = 'column';
        this.elements.container.style.flexGrow = '1';

        const mainContent = document.createElement('div');
        mainContent.className = 'holaf-viewer-container';
        mainContent.style.flexGrow = '1';

        this.elements.leftPane = this._createLeftPane();
        this.elements.centerPane = this._createCenterPane();
        this.elements.rightColumn = this._createRightColumn();

        mainContent.append(this.elements.leftPane, this.elements.centerPane, this.elements.rightColumn);

        this.elements.statusBar = document.createElement('div');
        this.elements.statusBar.id = 'holaf-viewer-statusbar';
        this.elements.statusBar.style.cssText = 'text-align: left; padding: 5px 10px;';

        this.elements.container.append(mainContent, this.elements.statusBar);

        this._cacheElements();
        this._setupEventListeners();

        imageViewerState.subscribe(this._render.bind(this));
        this._render(imageViewerState.getState());

        // --- EVENT LISTENERS ---
        document.addEventListener('holaf-video-override', (e) => {
            this._handleVideoOverride(e.detail.url);
        });

        // [NEW] Processing Indicator Events
        document.addEventListener('holaf-video-processing-start', () => {
            if (this.elements.processingOverlay) this.elements.processingOverlay.style.display = 'flex';
        });

        document.addEventListener('holaf-video-processing-end', () => {
            if (this.elements.processingOverlay) this.elements.processingOverlay.style.display = 'none';
        });
    }

    _handleVideoOverride(url) {
        const videoEl = this.elements.zoomVideo;
        const indicatorEl = this.elements.centerPane.querySelector('#holaf-preview-indicator');

        if (url) {
            const cacheBustUrl = url + (url.includes('?') ? '&' : '?') + `t=${Date.now()}`;
            if (videoEl) {
                videoEl.src = cacheBustUrl;
                videoEl.load();
                // [NEW] Force Autoplay
                const playPromise = videoEl.play();
                if (playPromise !== undefined) {
                    playPromise.catch(error => {
                        console.log("Autoplay prevented by browser:", error);
                    });
                }
            }
            if (indicatorEl) indicatorEl.style.display = 'block';
        } else {
            if (indicatorEl) indicatorEl.style.display = 'none';
        }
    }

    _render(state) {
        const { filters, ui } = state;

        if (!this.elements.searchInput) return;

        // Bascule d'affichage local ↔ serveur (le DOM local reste en place).
        this._applySourceVisibility(state);
        this._renderRemoteFilters(state);

        this._renderSourceGroup(state);

        const currentText = filters.filename_search || filters.prompt_search || filters.workflow_search || '';

        if (this.elements.searchInput.value !== currentText && (currentText !== '' || this.elements.searchInput.value !== '')) {
            this.elements.searchInput.value = currentText;
        }

        if (filters.filename_search) this.scopeState.filename = true;
        if (filters.prompt_search) this.scopeState.prompt = true;
        if (filters.workflow_search) this.scopeState.workflow = true;

        this.elements.scopeButtons.filename.classList.toggle('active', this.scopeState.filename);
        this.elements.scopeButtons.prompt.classList.toggle('active', this.scopeState.prompt);
        this.elements.scopeButtons.workflow.classList.toggle('active', this.scopeState.workflow);

        this.elements.dateStart.value = filters.startDate || '';
        this.elements.dateEnd.value = filters.endDate || '';

        const sources = filters.workflow_sources || [];
        this.elements.workflowButtons.internal.classList.toggle('active', sources.includes('internal_png'));
        this.elements.workflowButtons.external.classList.toggle('active', sources.includes('external_json'));

        this._renderActiveTags(filters.tags_filter || []);

        if (this.elements.thumbFitToggle) {
            this.elements.thumbFitToggle.checked = ui.thumbnail_fit === 'contain';
        }
        if (this.elements.thumbSizeSlider) {
            if (!this.isDraggingSlider) {
                this.elements.thumbSizeSlider.value = ui.thumbnail_size;
            }
            if (this.elements.thumbSizeValue) {
                this.elements.thumbSizeValue.textContent = `${ui.thumbnail_size}px`;
            }
        }
    }

    _createLeftPane() {
        const pane = document.createElement('div');
        pane.id = 'holaf-viewer-left-pane';
        pane.className = 'holaf-viewer-pane';
        pane.innerHTML = `
            <div class="holaf-viewer-filter-group" id="holaf-viewer-source-group" data-src="both">
                <h4 id="holaf-viewer-source-title">${t('iv.source')}</h4>
                <div class="holaf-viewer-toggle-button-group" id="holaf-viewer-source-buttons" role="radiogroup" aria-labelledby="holaf-viewer-source-title">
                    <button type="button" role="radio" class="holaf-viewer-toggle-button" id="holaf-viewer-source-local">${t('iv.sourceLocal')}</button>
                    <button type="button" role="radio" class="holaf-viewer-toggle-button" id="holaf-viewer-source-remote">${t('iv.sourceRemote')}</button>
                </div>
                <div id="holaf-viewer-source-note" class="holaf-viewer-source-note"></div>
            </div>

            <!-- ═══ Filtres SERVEUR (étape 5) — classes .src-remote ═══
                 Convention : le DOM LOCAL reste en place ; ces groupes ne sont
                 affichés QUE si la source active est 'remote' (visibilité gérée
                 par _applySourceVisibility via l'attribut data-src du pane). -->
            <div class="holaf-viewer-filter-group" data-src="remote" id="holaf-viewer-remote-type-group">
                <h4>${t('iv.type')}</h4>
                <select id="holaf-viewer-remote-kind" class="holaf-viewer-select">
                    <option value="">${t('iv.kindAll')}</option>
                    <option value="image">${t('iv.kindImages')}</option>
                    <option value="video">${t('iv.kindVideos')}</option>
                    <option value="audio">${t('iv.kindAudio')}</option>
                </select>
            </div>

            <div class="holaf-viewer-filter-group" data-src="remote">
                <h4>${t('iv.uiSearch')}</h4>
                <input type="search" id="holaf-viewer-remote-search" placeholder="${t('iv.searchRemotePlaceholder')}" class="holaf-viewer-search-bar">
            </div>

            <div class="holaf-viewer-filter-group" data-src="remote">
                <h4>${t('iv.dateRange')}</h4>
                <div class="holaf-viewer-date-range-container">
                    <div class="holaf-viewer-date-input-group"><label for="holaf-viewer-remote-date-start">${t('iv.from')}</label><input type="date" id="holaf-viewer-remote-date-start"></div>
                    <div class="holaf-viewer-date-input-group"><label for="holaf-viewer-remote-date-end">${t('iv.to')}</label><input type="date" id="holaf-viewer-remote-date-end"></div>
                </div>
            </div>

            <div class="holaf-viewer-filter-group holaf-viewer-scrollable-section" data-src="remote">
                <div class="holaf-viewer-filter-header">
                    <h4>${t('iv.folders')}</h4>
                    <div class="holaf-viewer-folder-actions">
                        <a href="#" id="holaf-viewer-remote-folders-select-all">${t('iv.all')}</a><span class="holaf-folder-separator">/</span><a href="#" id="holaf-viewer-remote-folders-select-none">${t('iv.none')}</a>
                    </div>
                </div>
                <div id="holaf-viewer-remote-folders-filter" class="holaf-viewer-filter-list"><p class="holaf-viewer-message"><em>${t('iv.loading')}</em></p></div>
                <div class="holaf-viewer-trash-separator"></div>
                <div class="holaf-viewer-filter-item" id="holaf-viewer-remote-trash-item">
                    <input type="checkbox" id="holaf-viewer-remote-trash">
                    <label for="holaf-viewer-remote-trash">${t('iv.trashcanReadonly')}</label>
                </div>
            </div>

            <div class="holaf-viewer-filter-group" data-src="remote">
                <h4>${t('iv.tagsAny')}</h4>
                <div id="holaf-viewer-remote-tags-filter" class="holaf-viewer-filter-list"><p class="holaf-viewer-message"><em>${t('iv.loading')}</em></p></div>
            </div>

            <div class="holaf-viewer-filter-group" data-src="remote">
                <div class="holaf-viewer-filter-item">
                    <input type="checkbox" id="holaf-viewer-remote-favorite">
                    <label for="holaf-viewer-remote-favorite">${t('iv.favoritesOnly')}</label>
                </div>
            </div>

            <div class="holaf-viewer-filter-group" data-src="remote">
                <h4>${t('iv.sort')}</h4>
                <select id="holaf-viewer-remote-sort" class="holaf-viewer-select">
                    <option value="created_at_desc">${t('iv.sortNewest')}</option>
                    <option value="created_at_asc">${t('iv.sortOldest')}</option>
                    <option value="name_asc">${t('iv.sortNameAsc')}</option>
                    <option value="name_desc">${t('iv.sortNameDesc')}</option>
                    <option value="size_desc">${t('iv.sortSizeDesc')}</option>
                    <option value="size_asc">${t('iv.sortSizeAsc')}</option>
                </select>
            </div>

            <div class="holaf-viewer-filter-group" data-src="local">
                <h4>${t('iv.uiSearch')}</h4>
                <input type="search" id="holaf-viewer-search-input" placeholder="${t('iv.searchPlaceholder')}" class="holaf-viewer-search-bar">
                <div class="holaf-viewer-scope-buttons" style="display: flex; gap: 5px; margin-top: 8px;">
                    <button class="holaf-viewer-toggle-button" id="holaf-search-scope-filename" title="${t('iv.scopeNameTitle')}">${t('iv.scopeName')}</button>
                    <button class="holaf-viewer-toggle-button" id="holaf-search-scope-prompt" title="${t('iv.scopePromptTitle')}">${t('iv.scopePrompt')}</button>
                    <button class="holaf-viewer-toggle-button" id="holaf-search-scope-workflow" title="${t('iv.scopeWorkflowTitle')}">${t('iv.scopeWorkflow')}</button>
                </div>
            </div>
            
            <div class="holaf-viewer-filter-group" data-src="local">
                <h4>${t('iv.dateRange')}</h4>
                <div class="holaf-viewer-date-range-container">
                    <div class="holaf-viewer-date-input-group"><label for="holaf-viewer-date-start">${t('iv.from')}</label><input type="date" id="holaf-viewer-date-start"></div>
                    <div class="holaf-viewer-date-input-group"><label for="holaf-viewer-date-end">${t('iv.to')}</label><input type="date" id="holaf-viewer-date-end"></div>
                </div>
            </div>
            
            <div class="holaf-viewer-filter-group" data-src="local">
                <h4>${t('iv.workflowAvailability')}</h4>
                <div id="holaf-viewer-workflow-filters" class="holaf-viewer-button-grid" style="display: flex; gap: 5px;">
                    <button class="holaf-viewer-toggle-button" id="holaf-wf-filter-internal" data-source="internal_png">${t('iv.internal')}</button>
                    <button class="holaf-viewer-toggle-button" id="holaf-wf-filter-external" data-source="external_json">${t('iv.external')}</button>
                </div>
            </div>

            <div class="holaf-viewer-filter-group" data-src="local">
                <h4>${t('iv.tags')}</h4>
                <div id="holaf-viewer-tags-filter-container">
                    <div id="holaf-viewer-active-tags" class="holaf-viewer-active-tags-container"></div>
                    <input type="text" id="holaf-viewer-tag-input" list="holaf-viewer-tag-suggestions" placeholder="${t('iv.addTagPlaceholder')}" class="holaf-viewer-search-bar">
                    <datalist id="holaf-viewer-tag-suggestions"></datalist>
                </div>
            </div>
            
            <div class="holaf-viewer-filter-group holaf-viewer-scrollable-section" data-src="local">
                <div class="holaf-viewer-filter-header">
                    <h4>${t('iv.folders')}</h4>
                    <div class="holaf-viewer-folder-actions">
                        <a href="#" id="holaf-viewer-folders-select-all">${t('iv.all')}</a><span class="holaf-folder-separator">/</span><a href="#" id="holaf-viewer-folders-select-none">${t('iv.none')}</a><span class="holaf-folder-separator">/</span><a href="#" id="holaf-viewer-folders-select-invert">${t('iv.invert')}</a>
                    </div>
                </div>
                <div id="holaf-viewer-folders-filter" class="holaf-viewer-filter-list"><p class="holaf-viewer-message"><em>${t('iv.loading')}</em></p></div>
            </div>
            <div class="holaf-viewer-fixed-sections">
                <div class="holaf-viewer-filter-group" data-src="local">
                    <h4>${t('iv.formats')}</h4>
                    <div id="holaf-viewer-formats-filter" class="holaf-viewer-filter-list"></div>
                </div>
                <div class="holaf-viewer-actions-group" data-src="both">
                    <h4>${t('iv.actions')}</h4>
                    <div class="holaf-viewer-actions-buttons-container">
                         <div class="holaf-viewer-action-button-row">
                            <button id="holaf-viewer-btn-delete" class="holaf-viewer-action-button" disabled title="${t('iv.deleteTitle')}">${t('iv.delete')}</button>
                            <button id="holaf-viewer-btn-restore" class="holaf-viewer-action-button" disabled title="${t('iv.restoreTitle')}">${t('iv.restore')}</button>
                        </div>
                        <div class="holaf-viewer-action-button-row">
                            <button id="holaf-viewer-btn-extract" class="holaf-viewer-action-button" disabled title="${t('iv.extractTitle')}"> जाये ${t('iv.extract')}</button>
                            <button id="holaf-viewer-btn-inject" class="holaf-viewer-action-button" disabled title="${t('iv.injectTitle')}">${t('iv.inject')}</button>
                        </div>
                         <div class="holaf-viewer-action-button-row">
                            <button id="holaf-viewer-btn-export" class="holaf-viewer-action-button" disabled title="${t('iv.exportTitle')}">${t('iv.export')}</button>
                            <button id="holaf-viewer-btn-reset-filters" class="holaf-viewer-action-button" title="${t('iv.resetTitle')}">${t('iv.reset')}</button>
                        </div>
                        <div class="holaf-viewer-action-button-row">
                            <button id="holaf-viewer-btn-regen-thumbs" class="holaf-viewer-action-button" data-src="local" title="${t('iv.regenThumbsTitle')}">${t('iv.regenThumbs')}</button>
                        </div>
                    </div>
                </div>
                <div class="holaf-viewer-display-options" data-src="both">
                    <h4>${t('iv.displayOptions')}</h4>
                    <div class="holaf-viewer-filter-list">
                       <div class="holaf-viewer-filter-item"><input type="checkbox" id="holaf-viewer-thumb-fit-toggle"><label for="holaf-viewer-thumb-fit-toggle">${t('iv.contained')}</label></div>
                       <div class="holaf-viewer-slider-container"><label for="holaf-viewer-thumb-size-slider">${t('iv.size')}</label><input type="range" id="holaf-viewer-thumb-size-slider" min="80" max="300" step="10"><span id="holaf-viewer-thumb-size-value">150px</span></div>
                    </div>
                </div>
            </div>
        `;
        return pane;
    }

    _createCenterPane() {
        const pane = document.createElement('div');
        pane.id = 'holaf-viewer-center-pane';
        pane.className = 'holaf-viewer-pane';
        // [MODIFIED] Added Processing Overlay
        pane.innerHTML = `
            <div id="holaf-viewer-toolbar">
                <button id="holaf-viewer-jump-newest" class="holaf-viewer-toolbar-button" title="${t('iv.jumpNewestTitle')}">${t('iv.jumpNewest')}</button>
                <button id="holaf-viewer-jump-oldest" class="holaf-viewer-toolbar-button" title="${t('iv.jumpOldestTitle')}">${t('iv.jumpOldest')}</button>
            </div>
            <div id="holaf-viewer-gallery"><p class="holaf-viewer-message">${t('iv.loadingImages')}</p></div>
            <div id="holaf-viewer-zoom-view" style="display: none;">
                <div id="holaf-preview-indicator" style="display:none; position:absolute; bottom:15px; left:15px; color:rgba(255,255,255,0.7); font-size:0.8em; z-index:100; pointer-events:none; text-shadow: 1px 1px 2px black;">${t('iv.preview')}</div>
                <div id="holaf-processing-overlay" style="display:none; position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); background:rgba(0,0,0,0.6); color:white; padding:15px 25px; border-radius:8px; z-index:101; pointer-events:none; font-weight:bold; backdrop-filter:blur(2px);">
                    ${t('iv.processingVideo')}
                </div>
                <button class="holaf-viewer-zoom-close" title="${t('iv.zoomCloseTitle')}">✖</button>
                <img src="" draggable="false" />
                <video controls loop id="holaf-viewer-zoom-video" style="display: none; width: 100%; height: 100%; object-fit: contain;"></video>
                <button class="holaf-viewer-zoom-fullscreen-icon" title="${t('iv.enterFullscreen')}">⛶</button>
            </div>
        `;
        return pane;
    }

    _createRightColumn() {
        const col = document.createElement('div');
        col.id = 'holaf-viewer-right-column';
        col.innerHTML = `
            <div id="holaf-viewer-right-pane" class="holaf-viewer-pane">
                <h4>${t('iv.imageInfo')}</h4>
                <div id="holaf-viewer-info-content">
                    <p class="holaf-viewer-message">${t('iv.selectImageDetails')}</p>
                </div>
            </div>
        `;
        return col;
    }

    _cacheElements() {
        this.elements.searchInput = this.elements.leftPane.querySelector('#holaf-viewer-search-input');

        this.elements.sourceButtons = {
            local: this.elements.leftPane.querySelector('#holaf-viewer-source-local'),
            remote: this.elements.leftPane.querySelector('#holaf-viewer-source-remote'),
        };
        this.elements.sourceNote = this.elements.leftPane.querySelector('#holaf-viewer-source-note');

        this.elements.scopeButtons = {
            filename: this.elements.leftPane.querySelector('#holaf-search-scope-filename'),
            prompt: this.elements.leftPane.querySelector('#holaf-search-scope-prompt'),
            workflow: this.elements.leftPane.querySelector('#holaf-search-scope-workflow')
        };

        this.elements.dateStart = this.elements.leftPane.querySelector('#holaf-viewer-date-start');
        this.elements.dateEnd = this.elements.leftPane.querySelector('#holaf-viewer-date-end');
        this.elements.tagInput = this.elements.leftPane.querySelector('#holaf-viewer-tag-input');
        this.elements.activeTagsContainer = this.elements.leftPane.querySelector('#holaf-viewer-active-tags');

        // Filtres de la source SERVEUR (étape 5).
        this.elements.remoteKind = this.elements.leftPane.querySelector('#holaf-viewer-remote-kind');
        this.elements.remoteSearchInput = this.elements.leftPane.querySelector('#holaf-viewer-remote-search');
        this.elements.remoteDateStart = this.elements.leftPane.querySelector('#holaf-viewer-remote-date-start');
        this.elements.remoteDateEnd = this.elements.leftPane.querySelector('#holaf-viewer-remote-date-end');
        this.elements.remoteFoldersList = this.elements.leftPane.querySelector('#holaf-viewer-remote-folders-filter');
        this.elements.remoteTagsList = this.elements.leftPane.querySelector('#holaf-viewer-remote-tags-filter');
        this.elements.remoteTrash = this.elements.leftPane.querySelector('#holaf-viewer-remote-trash');
        this.elements.remoteFavorite = this.elements.leftPane.querySelector('#holaf-viewer-remote-favorite');
        this.elements.remoteSort = this.elements.leftPane.querySelector('#holaf-viewer-remote-sort');

        this.elements.workflowButtonsContainer = this.elements.leftPane.querySelector('#holaf-viewer-workflow-filters');
        this.elements.workflowButtons = {
            internal: this.elements.leftPane.querySelector('#holaf-wf-filter-internal'),
            external: this.elements.leftPane.querySelector('#holaf-wf-filter-external')
        };

        this.elements.thumbFitToggle = this.elements.leftPane.querySelector('#holaf-viewer-thumb-fit-toggle');
        this.elements.thumbSizeSlider = this.elements.leftPane.querySelector('#holaf-viewer-thumb-size-slider');
        this.elements.thumbSizeValue = this.elements.leftPane.querySelector('#holaf-viewer-thumb-size-value');

        this.elements.zoomVideo = this.elements.centerPane.querySelector('#holaf-viewer-zoom-video');
        // [NEW] Cache overlay
        this.elements.processingOverlay = this.elements.centerPane.querySelector('#holaf-processing-overlay');
    }

    _setupEventListeners() {
        const viewer = this.callbacks.getViewer();

        if (this.elements.sourceButtons) {
            this.elements.sourceButtons.local.onclick = () => this._handleSourceSelect(SOURCE_LOCAL);
            this.elements.sourceButtons.remote.onclick = () => this._handleSourceSelect(SOURCE_REMOTE);
        }

        const jumpNewestBtn = this.elements.centerPane.querySelector('#holaf-viewer-jump-newest');
        if (jumpNewestBtn) {
            jumpNewestBtn.onclick = () => {
                const state = imageViewerState.getState();
                if (state.status.pendingNewImages) {
                    viewer.loadFilteredImages();
                } else if (viewer.gallery) {
                    viewer.gallery.jumpToNewest();
                }
            };
        }

        const jumpOldestBtn = this.elements.centerPane.querySelector('#holaf-viewer-jump-oldest');
        if (jumpOldestBtn) {
            jumpOldestBtn.onclick = () => {
                if (viewer.gallery) viewer.gallery.jumpToOldest();
            };
        }

        this.elements.leftPane.querySelector('#holaf-viewer-btn-reset-filters').onclick = () => {
            // RESET limité à la source ACTIVE : le mode local conserve son
            // comportement (verrous, scopes) ; le serveur a son propre reset.
            const sourceId = normalizeSourceId(imageViewerState.getState().ui.gallery_source);
            if (sourceId === SOURCE_REMOTE) {
                this._resetRemoteFilters();
                return;
            }
            this.scopeState = { filename: true, prompt: false, workflow: false };
            this.callbacks.onResetFilters();
        };

        const regenThumbsBtn = this.elements.leftPane.querySelector('#holaf-viewer-btn-regen-thumbs');
        regenThumbsBtn.onclick = async () => {
            // Guard against double-clicks: disabled while the request is in flight.
            if (regenThumbsBtn.disabled) return;
            regenThumbsBtn.disabled = true;

            const originalLabel = regenThumbsBtn.textContent;
            const showToast = (message, type) => {
                bridgeShowToast({ message, type });
            };

            try {
                // Step 1: Full cleanup — validate every thumbnail on disk and
                // reset missing/corrupt ones so the worker regenerates them.
                regenThumbsBtn.textContent = t('iv.cleanupThumbs');
                showToast(t('iv.cleanupThumbsToast'), 'info');

                // La brique lève sur non-2xx → catch du bouton (même toast d'erreur).
                const cleanData = await HolafFetch.post('/holaf/images/maintenance/clean-thumbnails');

                // Step 2 (best-effort): reset permanent-failure thumbnails.
                // If this step fails, keep going so the user still sees the
                // clean results.
                regenThumbsBtn.textContent = t('iv.regenerating');
                let resetCount = 0;
                let regenFailed = false;
                try {
                    // La brique lève sur non-2xx → catch interne (étape best-effort).
                    const regenData = await HolafFetch.post('/holaf/images/regenerate-failed');
                    resetCount = (regenData && typeof regenData.reset_count === 'number') ? regenData.reset_count : 0;
                } catch (regenError) {
                    regenFailed = true;
                    console.error('[Holaf ImageViewer] Error during regenerate-failed step:', regenError);
                }

                // Build a combined message from whichever responses succeeded.
                const details = (cleanData && cleanData.details) || {};
                let message;
                if (typeof details.deleted_orphans === 'number' &&
                    typeof details.regenerated_missing === 'number' &&
                    typeof details.regenerated_corrupt === 'number') {
                    message = t('iv.cleanupResult', { orphans: details.deleted_orphans, missing: details.regenerated_missing, corrupt: details.regenerated_corrupt });
                    message += regenFailed
                        ? t('iv.regenerateStepFailed')
                        : t('iv.regeneratedFailed', { count: resetCount });
                } else {
                    message = t('iv.cleanupDone');
                }

                showToast(message, 'success');
                if (regenFailed) {
                    showToast(t('iv.regenerateError'), 'error');
                }
            } catch (error) {
                console.error('[Holaf ImageViewer] Error regenerating thumbnails:', error);
                showToast(t('iv.regenerateError'), 'error');
            } finally {
                // Refresh the gallery so thumbnails are reloaded.
                this.callbacks.onFilterChange(true);
                regenThumbsBtn.textContent = originalLabel;
                regenThumbsBtn.disabled = false;
            }
        };

        const dispatchSearch = () => {
            const searchText = this.elements.searchInput.value;
            const currentFilters = imageViewerState.getState().filters;
            const newFilters = {
                ...currentFilters,
                filename_search: this.scopeState.filename ? searchText : '',
                prompt_search: this.scopeState.prompt ? searchText : '',
                workflow_search: this.scopeState.workflow ? searchText : ''
            };
            imageViewerState.setState({ filters: newFilters });
            this.callbacks.onFilterChange();
        };

        this.elements.searchInput.oninput = () => {
            if (!this.scopeState.filename && !this.scopeState.prompt && !this.scopeState.workflow) {
                this.scopeState.filename = true;
                this.elements.scopeButtons.filename.classList.add('active');
            }
            dispatchSearch();
        };

        const toggleScope = (scopeKey) => {
            this.scopeState[scopeKey] = !this.scopeState[scopeKey];
            this.elements.scopeButtons[scopeKey].classList.toggle('active', this.scopeState[scopeKey]);
            dispatchSearch();
        };

        this.elements.scopeButtons.filename.onclick = () => toggleScope('filename');
        this.elements.scopeButtons.prompt.onclick = () => toggleScope('prompt');
        this.elements.scopeButtons.workflow.onclick = () => toggleScope('workflow');

        const onDateChange = () => this.callbacks.onFilterChange();
        this.elements.dateStart.onchange = onDateChange;
        this.elements.dateEnd.onchange = onDateChange;

        this.elements.workflowButtonsContainer.onclick = (e) => {
            if (e.target.matches('button')) {
                const source = e.target.dataset.source;
                const currentFilters = imageViewerState.getState().filters;
                const currentSources = currentFilters.workflow_sources || [];
                let newSources;

                if (currentSources.includes(source)) {
                    newSources = currentSources.filter(s => s !== source);
                } else {
                    newSources = [...currentSources, source];
                }

                imageViewerState.setState({ filters: { ...currentFilters, workflow_sources: newSources } });
                this.callbacks.onFilterChange();
            }
        };

        this.elements.tagInput.onkeydown = (e) => {
            if (e.key === 'Enter' && this.elements.tagInput.value.trim() !== '') {
                e.preventDefault();
                const newTag = this.elements.tagInput.value.trim();
                const currentFilters = imageViewerState.getState().filters;
                const currentTags = currentFilters.tags_filter || [];

                if (!currentTags.includes(newTag)) {
                    const newTags = [...currentTags, newTag];
                    imageViewerState.setState({ filters: { ...currentFilters, tags_filter: newTags } });
                    this.callbacks.onFilterChange();
                }
                this.elements.tagInput.value = '';
            }
        };

        this.elements.activeTagsContainer.onclick = (e) => {
            if (e.target.matches('.holaf-viewer-tag-remove')) {
                const tagToRemove = e.target.parentElement.dataset.tag;
                const currentFilters = imageViewerState.getState().filters;
                const newTags = (currentFilters.tags_filter || []).filter(t => t !== tagToRemove);

                imageViewerState.setState({ filters: { ...currentFilters, tags_filter: newTags } });
                this.callbacks.onFilterChange();
            }
        };

        this._setupRemoteFilterListeners();

        this.elements.leftPane.querySelector('#holaf-viewer-folders-select-all').onclick = (e) => {
            e.preventDefault();
            const { locked_folders } = imageViewerState.getState().filters;
            this.elements.leftPane.querySelectorAll('#holaf-viewer-folders-filter input[type="checkbox"]:not(#folder-filter-trashcan)').forEach(cb => {
                const folderId = cb.closest('.holaf-viewer-filter-item')?.dataset.folderId;
                if (!cb.disabled && !locked_folders.includes(folderId)) {
                    cb.checked = true;
                }
            });
            this.callbacks.onFilterChange();
        };
        this.elements.leftPane.querySelector('#holaf-viewer-folders-select-none').onclick = (e) => {
            e.preventDefault();
            // Uncheck ALL folders including trashcan to show empty gallery
            const { locked_folders } = imageViewerState.getState().filters;
            document.querySelectorAll('#holaf-viewer-folders-filter input[type="checkbox"]').forEach(cb => {
                const folderId = cb.closest('.holaf-viewer-filter-item')?.dataset.folderId;
                if (!cb.disabled && !locked_folders.includes(folderId)) {
                    cb.checked = false;
                }
            });
            this.callbacks.onFilterChange(true);
        };
        this.elements.leftPane.querySelector('#holaf-viewer-folders-select-invert').onclick = (e) => {
            e.preventDefault();
            const { locked_folders } = imageViewerState.getState().filters;
            this.elements.leftPane.querySelectorAll('#holaf-viewer-folders-filter input[type="checkbox"]:not(#folder-filter-trashcan)').forEach(cb => {
                const folderId = cb.closest('.holaf-viewer-filter-item')?.dataset.folderId;
                if (!cb.disabled && !locked_folders.includes(folderId)) {
                    cb.checked = !cb.checked;
                }
            });
            this.callbacks.onFilterChange();
        };

        this.elements.thumbFitToggle.onchange = (e) => {
            const newFit = e.target.checked ? 'contain' : 'cover';
            viewer.saveSettings({ thumbnail_fit: newFit });
            viewer._applyThumbnailFit();
        };

        this.elements.thumbSizeSlider.oninput = (e) => {
            this.isDraggingSlider = true;
            const newSize = parseInt(e.target.value);
            this.elements.thumbSizeValue.textContent = `${newSize}px`;
            viewer._applyThumbnailSize(newSize);
        };

        this.elements.thumbSizeSlider.onchange = (e) => {
            this.isDraggingSlider = false;
            const newSize = parseInt(e.target.value);
            viewer.saveSettings({ thumbnail_size: newSize });
        };

        const zoomView = this.elements.centerPane.querySelector('#holaf-viewer-zoom-view');
        const zoomImage = zoomView.querySelector('img');
        this.elements.centerPane.querySelector('.holaf-viewer-zoom-close').onclick = () => viewer._hideZoomedView();
        this.elements.centerPane.querySelector('.holaf-viewer-zoom-fullscreen-icon').onclick = () => viewer._showFullscreenView();
        zoomImage.ondblclick = () => viewer._showFullscreenView();
        zoomImage.onclick = (e) => e.stopPropagation();

        Navigation.setupZoomAndPan(viewer.zoomViewState, zoomView, zoomImage);
    }

    /**
     * Affiche/masque les groupes de filtres selon la source ACTIVE.
     * Chaque groupe porte `data-src` = 'local' | 'remote' | 'both'. On pose
     * l'attribut `data-source` sur le pane ET la classe `.holaf-src-hidden` sur
     * les éléments non pertinents (CSS : display:none!important). Le DOM local
     * n'est jamais retiré : en mode serveur il est simplement masqué.
     * @param {object} state - instantané d'imageViewerState.
     * @returns {string} source normalisée ('local' | 'remote').
     */
    _applySourceVisibility(state) {
        const sourceId = normalizeSourceId(state && state.ui ? state.ui.gallery_source : SOURCE_LOCAL);
        const root = this.elements.leftPane;
        if (root) {
            root.dataset.source = sourceId;
            root.querySelectorAll('[data-src]').forEach((el) => {
                const src = el.dataset.src;
                const show = (src === 'both' || src === sourceId);
                el.classList.toggle('holaf-src-hidden', !show);
            });
        }
        return sourceId;
    }

    /**
     * Répercute les filtres serveur persistés (state.ui.remote_*) sur les
     * contrôles du pane. Idempotent, sans effet de bord.
     * @param {object} state
     */
    _renderRemoteFilters(state) {
        const e = this.elements;
        const ui = (state && state.ui) || {};

        if (e.remoteKind) e.remoteKind.value = ui.remote_kind || '';
        if (e.remoteSort) e.remoteSort.value = ui.remote_sort || 'created_at_desc';
        if (e.remoteFavorite) e.remoteFavorite.checked = ui.remote_favorite === true;
        if (e.remoteTrash) e.remoteTrash.checked = ui.remote_status === 'trashed';
        if (e.remoteDateStart) e.remoteDateStart.value = ui.remote_from || '';
        if (e.remoteDateEnd) e.remoteDateEnd.value = ui.remote_to || '';
        if (e.remoteSearchInput) {
            const v = ui.remote_q || '';
            if (e.remoteSearchInput.value !== v) e.remoteSearchInput.value = v;
        }

        const folders = Array.isArray(ui.remote_subfolders) ? ui.remote_subfolders : [];
        if (e.remoteFoldersList) {
            e.remoteFoldersList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
                const item = cb.closest('.holaf-viewer-filter-item');
                cb.checked = !!(item && folders.includes(item.dataset.folderId));
            });
        }

        const tags = Array.isArray(ui.remote_tags) ? ui.remote_tags : [];
        if (e.remoteTagsList) {
            e.remoteTagsList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
                const item = cb.closest('.holaf-viewer-filter-item');
                cb.checked = !!(item && tags.includes(item.dataset.tag));
            });
        }

        this._syncRemoteTrashState();
    }

    /** Corbeille serveur active → dossiers en lecture seule (grisés). */
    _syncRemoteTrashState() {
        const e = this.elements;
        if (!e.remoteFoldersList || !e.remoteTrash) return;
        const trashed = e.remoteTrash.checked;
        e.remoteFoldersList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
            cb.disabled = trashed;
        });
    }

    /**
     * Remplit les listes de dossiers et de tags serveur (depuis
     * fetchFilterOptions du provider remote). Les comptes sont affichés.
     * @param {object} data - options renvoyées par le provider ('subfolders',
     *                        'tags', 'tags_detail', …).
     */
    populateRemoteFilterOptions(data) {
        const opts = data || {};

        const foldersEl = this.elements.remoteFoldersList;
        if (foldersEl) {
            foldersEl.innerHTML = '';
            const folders = Array.isArray(opts.subfolders) ? opts.subfolders : [];
            if (folders.length === 0) {
                foldersEl.innerHTML = `<p class="holaf-viewer-message"><em>${t('iv.noFolders')}</em></p>`;
            } else {
                folders.forEach((f) => {
                    const id = f.path;
                    const label = id === 'root' ? `(root) (${f.count})` : `${id} (${f.count})`;
                    foldersEl.appendChild(this._createRemoteCheckItem(`remote-folder-filter-${id}`, 'folderId', id, label));
                });
            }
        }

        const tagsEl = this.elements.remoteTagsList;
        if (tagsEl) {
            tagsEl.innerHTML = '';
            const details = Array.isArray(opts.tags_detail)
                ? opts.tags_detail
                : (Array.isArray(opts.tags) ? opts.tags.map((tag) => ({ tag, count: null })) : []);
            if (details.length === 0) {
                tagsEl.innerHTML = `<p class="holaf-viewer-message"><em>${t('iv.noTags')}</em></p>`;
            } else {
                details.forEach((x) => {
                    const label = (x.count != null) ? `${x.tag} (${x.count})` : x.tag;
                    tagsEl.appendChild(this._createRemoteCheckItem(`remote-tag-filter-${x.tag}`, 'tag', x.tag, label));
                });
            }
        }

        this._renderRemoteFilters(imageViewerState.getState());
    }

    /**
     * Crée un item à case à cocher pour une liste serveur (dossier/tag).
     * Le `change` est géré par DÉLÉGATION sur le conteneur (cf.
     * _setupRemoteFilterListeners) → pas de handler par case.
     * @param {string} id
     * @param {string} dataKey - 'folderId' | 'tag' (clé dataset lue au collect).
     * @param {string} value
     * @param {string} label
     */
    _createRemoteCheckItem(id, dataKey, value, label) {
        const container = document.createElement('div');
        container.className = 'holaf-viewer-filter-item';
        container.dataset[dataKey] = value;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = id;

        const labelEl = document.createElement('label');
        labelEl.htmlFor = id;
        labelEl.textContent = label;

        container.append(checkbox, labelEl);
        return container;
    }

    /**
     * Branche les contrôles de filtres serveur (état `state.ui.remote_*`).
     * Aucune interaction avec les filtres locaux (state.filters).
     */
    _setupRemoteFilterListeners() {
        const e = this.elements;
        if (e.remoteKind) e.remoteKind.onchange = () => this._saveRemoteFilters({ remote_kind: e.remoteKind.value });
        if (e.remoteSort) e.remoteSort.onchange = () => this._saveRemoteFilters({ remote_sort: e.remoteSort.value });
        if (e.remoteFavorite) e.remoteFavorite.onchange = () => this._saveRemoteFilters({ remote_favorite: e.remoteFavorite.checked });
        if (e.remoteSearchInput) e.remoteSearchInput.oninput = () => this._saveRemoteFilters({ remote_q: e.remoteSearchInput.value });
        if (e.remoteDateStart) e.remoteDateStart.onchange = () => this._saveRemoteFilters({ remote_from: e.remoteDateStart.value });
        if (e.remoteDateEnd) e.remoteDateEnd.onchange = () => this._saveRemoteFilters({ remote_to: e.remoteDateEnd.value });
        if (e.remoteTrash) {
            e.remoteTrash.onchange = () => {
                this._saveRemoteFilters({ remote_status: e.remoteTrash.checked ? 'trashed' : '' });
                this._syncRemoteTrashState();
            };
        }
        if (e.remoteFoldersList) e.remoteFoldersList.onchange = () => this._saveRemoteFolders();
        if (e.remoteTagsList) e.remoteTagsList.onchange = () => this._saveRemoteTags();

        const allLink = this.elements.leftPane.querySelector('#holaf-viewer-remote-folders-select-all');
        const noneLink = this.elements.leftPane.querySelector('#holaf-viewer-remote-folders-select-none');
        if (allLink) allLink.onclick = (ev) => { ev.preventDefault(); this._setRemoteFoldersAll(true); };
        if (noneLink) noneLink.onclick = (ev) => { ev.preventDefault(); this._setRemoteFoldersAll(false); };
    }

    /** Persiste un patch de filtres serveur + déclenche le rechargement. */
    _saveRemoteFilters(patch, immediate = false) {
        const viewer = this.callbacks.getViewer();
        if (viewer && typeof viewer.saveSettings === 'function') {
            viewer.saveSettings(patch);
        } else {
            imageViewerState.setState({ ui: patch });
        }
        this.callbacks.onFilterChange(immediate);
    }

    _collectRemoteFolders() {
        if (!this.elements.remoteFoldersList) return [];
        return Array.from(this.elements.remoteFoldersList.querySelectorAll('input[type="checkbox"]:checked'))
            .map((cb) => cb.closest('.holaf-viewer-filter-item')?.dataset.folderId)
            .filter((id) => id != null);
    }

    _saveRemoteFolders() {
        this._saveRemoteFilters({ remote_subfolders: this._collectRemoteFolders() });
    }

    _collectRemoteTags() {
        if (!this.elements.remoteTagsList) return [];
        return Array.from(this.elements.remoteTagsList.querySelectorAll('input[type="checkbox"]:checked'))
            .map((cb) => cb.closest('.holaf-viewer-filter-item')?.dataset.tag)
            .filter((tag) => tag != null);
    }

    _saveRemoteTags() {
        this._saveRemoteFilters({ remote_tags: this._collectRemoteTags() });
    }

    _setRemoteFoldersAll(checked) {
        if (!this.elements.remoteFoldersList) return;
        this.elements.remoteFoldersList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
            if (!cb.disabled) cb.checked = checked;
        });
        this._saveRemoteFolders();
    }

    /**
     * RESET des filtres SERVEUR uniquement (la source locale n'est PAS touchée).
     * Remet les clés remote_* à leurs défauts et déclenche un rechargement.
     */
    _resetRemoteFilters() {
        const patch = {
            remote_kind: '',
            remote_subfolders: [],
            remote_tags: [],
            remote_from: '',
            remote_to: '',
            remote_q: '',
            remote_favorite: false,
            remote_status: '',
            remote_sort: 'created_at_desc',
        };
        const viewer = this.callbacks.getViewer();
        if (viewer && typeof viewer.saveSettings === 'function') {
            viewer.saveSettings(patch);
        } else {
            imageViewerState.setState({ ui: patch });
        }
        if (this.elements.remoteSearchInput) this.elements.remoteSearchInput.value = '';
        this.callbacks.onFilterChange(true);
    }

    /**
     * Rend l'état du switch de source : sélection, garde-fou « serveur non
     * configuré » (option grisée + guidage AIH ▸ Paramètres serveur) et, si la
     * source active est 'remote', l'indice de l'hôte configuré.
     * @param {object} state — instantané d'imageViewerState.
     */
    _renderSourceGroup(state) {
        const buttons = this.elements.sourceButtons;
        if (!buttons || !buttons.local || !buttons.remote) return;

        const currentId = normalizeSourceId(state && state.ui ? state.ui.gallery_source : SOURCE_LOCAL);
        const remote = getRemoteStatus();

        buttons.local.classList.toggle('active', currentId === SOURCE_LOCAL);
        buttons.remote.classList.toggle('active', currentId === SOURCE_REMOTE);
        buttons.local.setAttribute('aria-checked', String(currentId === SOURCE_LOCAL));
        buttons.remote.setAttribute('aria-checked', String(currentId === SOURCE_REMOTE));

        // Garde-fou : pas de serveur/token → option Serveur désactivée (grisée)
        // avec guidage vers le menu AIH (titre + note visible).
        buttons.remote.disabled = !remote.configured;
        buttons.remote.title = remote.configured ? t('iv.sourceRemoteTitle') : t('iv.sourceRemoteDisabled');

        let note = '';
        if (!remote.configured) {
            note = t('iv.sourceRemoteDisabled');
        } else if (currentId === SOURCE_REMOTE) {
            note = t('iv.sourceRemoteHost', { host: describeRemoteHost(remote.serverUrl) });
        } else if (!remote.hasProvider) {
            // Étape 2 non livrée : provider 'remote' non enregistré.
            note = t('iv.sourceRemoteUnavailable');
        }
        if (this.elements.sourceNote) this.elements.sourceNote.textContent = note;
    }

    /**
     * Bascule demandée par l'utilisateur. Le refus est PROPRE : aucun état
     * modifié, message explicite (garde-fou non configuré ou étape 2 non livrée).
     * @param {string} targetId — SOURCE_LOCAL | SOURCE_REMOTE.
     */
    async _handleSourceSelect(targetId) {
        try {
            const viewer = this.callbacks.getViewer();
            const result = await applySourceSwitch(viewer, targetId);
            if (!result.ok) {
                const key = result.reason === 'not-configured'
                    ? 'iv.sourceRemoteDisabled'
                    : result.reason === 'not-implemented'
                        ? 'iv.sourceRemoteUnavailable'
                        : 'iv.sourceSwitchError';
                const message = key === 'iv.sourceSwitchError'
                    ? t(key, { message: (result.error && result.error.message) || '' })
                    : t(key);
                bridgeShowToast({ message, type: 'warning' });
            }
        } catch (error) {
            console.error('[Holaf ImageViewer] Source switch failed:', error);
            bridgeShowToast({ message: t('iv.sourceSwitchError', { message: error.message }), type: 'error' });
        }
        // Re-synchronise le contrôle sur l'état réel (refus → la sélection
        // affichée revient sur la source active).
        this._render(imageViewerState.getState());
    }

    _renderActiveTags(tags) {
        if (!this.elements.activeTagsContainer) return;
        this.elements.activeTagsContainer.innerHTML = '';
        tags.forEach(tag => {
            const tagEl = document.createElement('div');
            tagEl.className = 'holaf-viewer-active-tag';
            tagEl.dataset.tag = tag;

            const tagLabel = document.createElement('span');
            tagLabel.textContent = tag;

            const removeButton = document.createElement('button');
            removeButton.className = 'holaf-viewer-tag-remove';
            removeButton.title = t('iv.removeTag');
            removeButton.textContent = '×';

            tagEl.append(tagLabel, removeButton);
            this.elements.activeTagsContainer.appendChild(tagEl);
        });
    }
}

export function createThemeMenu(setThemeCallback) {
    const menu = document.createElement("ul");
    menu.className = "holaf-theme-menu";
    HOLAF_THEMES.forEach(theme => {
        const item = document.createElement("li");
        item.textContent = theme.name;
        item.onclick = (e) => {
            e.stopPropagation();
            setThemeCallback(theme.name);
            menu.style.display = 'none';
        };
        menu.appendChild(item);
    });
    return menu;
}

export const UI = new ImageViewerUI();