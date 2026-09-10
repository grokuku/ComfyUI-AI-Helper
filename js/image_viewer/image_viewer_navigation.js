/*
 * Copyright (C) 2025 Holaf
 * Holaf Utilities - Image Viewer Navigation Module
 *
 * This module handles all user navigation, including keyboard controls,
 * zoomed view, fullscreen view, and pan/zoom interactions.
 * FIX: Removed DOM cloning which caused "parentNode is null" errors.
 * FIX: Added safety checks for missing video elements.
 */

import { imageViewerState } from './image_viewer_state.js';
import { handleDeletion } from './image_viewer_actions.js';
import { dialogState } from '../holaf_panel_manager.js';
import { getThumbnailUrl } from './image_viewer_gallery.js';
import { getImageAt } from './image_viewer_data.js';
// VAGUE 2 : la géométrie + les interactions zoom/pan sont déléguées à la brique
// HolafViewport (vendored). L'hôte ne garde que le branchement, la synchro de
// l'overlay mask de l'éditeur et le feedback curseur.
import { HolafViewport } from '../vendor/holaf/holaf-viewport.js';

function _applyEditorPreview(viewer, element) {
    if (viewer && viewer.editor && typeof viewer.editor.applyPreview === 'function') {
        viewer.editor.applyPreview();
    }
}

async function _handleUnsavedChanges(viewer) {
    if (!viewer.editor) return 'proceed';

    // Flush any pending debounced save so it fires with the current image state
    if (viewer.editor._saveTimer) {
        clearTimeout(viewer.editor._saveTimer);
        viewer.editor._saveTimer = null;
        viewer.editor._doAutoSave(viewer.editor._saveToken);
    }

    if (viewer.editor.saveInProgress) {
        for (let i = 0; i < 100; i++) {
            await new Promise(r => setTimeout(r, 100));
            if (!viewer.editor.saveInProgress) return 'proceed';
        }
        console.warn('[Holaf] Save still in progress after 10s — navigating anyway.');
    }
    return 'proceed';
}


export function resetTransform(state, element) {
    if (!element || !state.viewport) return;
    // VAGUE 2 : délégation à la brique. En mode content, le fit = scale 1
    // (l'object-fit:contain a déjà cadré) → reset() reproduit exactement
    // l'ancien translate(0,0) scale(1). Signature conservée : l'éditeur
    // (image_viewer_editor.js) l'appelle encore (ouverture mask/crop).
    // VAGUE 9 : le fallback legacy « state.viewport inexistant » est supprimé —
    // l'instance est créée de façon synchrone à l'init du viewer pour les deux
    // states (UI._setupEventListeners → zoom, _createFullscreenOverlay →
    // fullscreen), donc AVANT tout appel à resetTransform.
    state.viewport.reset();
    element.style.cursor = 'grab';
}

// --- Batch preload: load N images ahead when user stops navigating ---
const _preloadJobs = new Set();
let _preloadDebounceTimer = null;
const PRELOAD_BATCH_SIZE = 10;

function _isMediaImage(image) {
    return image && !['MP4', 'WEBM', 'MKV', 'AVI', 'MOV', 'M4V'].includes(image.format)
        && !['WAV', 'MP3', 'OGG', 'FLAC', 'AAC', 'M4A'].includes(image.format);
}

function _getTotalCount(state) {
    const total = state.totalCount;
    if (typeof total === 'number' && total >= 0) return total;
    return state.images ? state.images.length : 0;
}

async function _ensureImageLoaded(viewer, index) {
    if (viewer.gallery && typeof viewer.gallery.ensureImageLoaded === 'function') {
        return viewer.gallery.ensureImageLoaded(index);
    }
    return getImageAt(imageViewerState.getState(), index) || null;
}

function _cancelPreloads() {
    for (const img of [..._preloadJobs]) {
        img.src = '';
    }
    _preloadJobs.clear();
}

function _preloadBatch(viewer) {
    const state = imageViewerState.getState();
    if (state.currentNavIndex < 0) return;

    // Cancel stale batch preloads
    _cancelPreloads();

    const total = _getTotalCount(state);
    const start = Math.max(0, state.currentNavIndex + 1);
    const end = Math.min(total - 1, state.currentNavIndex + PRELOAD_BATCH_SIZE);

    for (let i = start; i <= end; i++) {
        const img = getImageAt(state, i);
        if (_isMediaImage(img)) {
            const preloader = new Image();
            _preloadJobs.add(preloader);
            preloader.onload = preloader.onerror = () => _preloadJobs.delete(preloader);
            preloader.src = getFullImageUrl(img);
        }
    }
}

function preloadNextImage(viewer) {
    const state = imageViewerState.getState();
    const total = _getTotalCount(state);
    if (state.currentNavIndex < 0 || (state.currentNavIndex + 1) >= total) return;

    // Immediately preload just the next image (instant response on next arrow press)
    const nextImage = getImageAt(state, state.currentNavIndex + 1);
    if (_isMediaImage(nextImage)) {
        const preloader = new Image();
        _preloadJobs.add(preloader);
        preloader.onload = preloader.onerror = () => _preloadJobs.delete(preloader);
        preloader.src = getFullImageUrl(nextImage);
    }

    // Batch preload debounced — fires after user stops navigating for 400ms
    clearTimeout(_preloadDebounceTimer);
    _preloadDebounceTimer = setTimeout(() => {
        _preloadBatch(viewer);
    }, 400);
}

export function getFullImageUrl(image) {
    if (!image) return "";
    // Use the dedicated /holaf/images/full route (streams the ORIGINAL file with
    // immutable cache headers). path_canon is preferred (matches the DB key and is
    // security-checked server-side); filename/subfolder/type is kept as a fallback.
    // mtime is included as a cache-buster so the immutable cache stays correct when
    // the file changes.
    const url = new URL(window.location.origin);
    url.pathname = '/holaf/images/full';
    const params = { mtime: image.mtime || image.thumb_hash || '' };
    if (image.path_canon) {
        params.path_canon = image.path_canon;
    } else {
        params.filename = image.filename;
        params.subfolder = image.subfolder || '';
        params.type = 'output';
    }
    url.search = new URLSearchParams(params);
    return url.href;
}

/**
 * Updates the container to show either the Image or Video element based on the file type.
 * Uses a load serial to prevent stale callbacks from overwriting the current image
 * when navigating rapidly.
 */
let _loadSerial = 0;
let _loadDelayTimer = null;
let _loadingTimer = null;     // Single global loading timer (not one per call)
let _spinnerEl = null;       // Single global spinner element

function _clearLoadingUI() {
    if (_loadingTimer) {
        clearTimeout(_loadingTimer);
        _loadingTimer = null;
    }
    if (_spinnerEl) {
        _spinnerEl.remove();
        _spinnerEl = null;
    }
}

function _showSpinner(container) {
    _spinnerEl = document.createElement('div');
    _spinnerEl.className = 'holaf-viewer-loading-spinner';
    _spinnerEl.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:100;pointer-events:none;font-size:24px;color:rgba(255,255,255,0.7);text-shadow:0 0 8px rgba(0,0,0,0.8);';
    _spinnerEl.innerHTML = '\u23F3';
    container.appendChild(_spinnerEl);
}

function _updateMediaSource(viewer, image, container, imgEl, videoEl, transformState, immediate) {
    // Cancel any pending delayed full-size load
    if (_loadDelayTimer) {
        clearTimeout(_loadDelayTimer);
        _loadDelayTimer = null;
    }
    // Cancel any pending loading spinner (single global instance)
    _clearLoadingUI();

    const serial = ++_loadSerial; // Each call gets a unique serial
    const isVideo = ['MP4', 'WEBM', 'MKV', 'AVI', 'MOV', 'M4V'].includes(image.format);
    const isAudio = ['WAV', 'MP3', 'OGG', 'FLAC', 'AAC', 'M4A'].includes(image.format);
    const url = getFullImageUrl(image);

    // Safety check: ensure videoEl exists (it might be missing if UI didn't initialize correctly)
    const hasVideoEl = !!videoEl;

    if (isAudio) {
        // Audio: Hide image, show video element as an audio player
        if (imgEl) {
            imgEl.style.display = 'none';
            imgEl.src = '';
        }

        // Use the video element for audio playback
        if (hasVideoEl) {
            videoEl.style.display = 'block';
            videoEl.src = url;
            resetTransform(transformState, videoEl);
            
            // Audio-specific styling: smaller centered element
            videoEl.style.width = '80%';
            videoEl.style.maxWidth = '400px';
            videoEl.style.height = 'auto';
            videoEl.style.margin = 'auto';
            videoEl.style.border = '1px solid var(--holaf-border-color)';
            videoEl.style.borderRadius = 'var(--holaf-border-radius)';

            // VAGUE 2 : le lecteur audio n'est pas une surface zoomable — force
            // l'identité exacte (l'ancien resetTransform écrivait ce transform).
            videoEl.style.transform = 'translate(0px, 0px) scale(1)';

            videoEl.play().catch(() => {});
        }
        
        // Show a waveform/audio icon behind the player
        _applyEditorPreview(viewer, null);
        
    } else if (isVideo && hasVideoEl) {
        if (imgEl) {
            imgEl.style.display = 'none';
            imgEl.src = '';
        }

        // Reset any audio-specific styling
        if (hasVideoEl) {
            videoEl.style.width = '';
            videoEl.style.maxWidth = '';
            videoEl.style.height = '';
            videoEl.style.margin = '';
            videoEl.style.border = '';
            videoEl.style.borderRadius = '';
        }

        videoEl.style.display = 'block';
        videoEl.src = url;
        resetTransform(transformState, videoEl);

        // Re-attach pan/zoom logic to the video element
        setupZoomAndPan(transformState, container, videoEl);

        // VAGUE 2 : pose les dimensions de la vidéo sur la brique dès que la
        // metadata est décodée (letterbox/clamp/getImageRect précis) —
        // setImageSize() refait le fit, ce qui reproduit le reset d'ouverture.
        const vp = transformState.viewport || null;
        videoEl.onloadedmetadata = () => {
            if (serial !== _loadSerial) return; // Chargement périmé — ignore
            if (!vp || transformState.viewport !== vp) return; // Instance remplacée depuis
            vp.setImageSize(videoEl.videoWidth, videoEl.videoHeight);
        };

        _applyEditorPreview(viewer, videoEl);

        // Attempt autoplay
        videoEl.play().catch(() => {});

    } else {
        // Reset any audio-specific styling on video element
        if (hasVideoEl) {
            videoEl.style.width = '';
            videoEl.style.maxWidth = '';
            videoEl.style.height = '';
            videoEl.style.margin = '';
            videoEl.style.border = '';
            videoEl.style.borderRadius = '';
            videoEl.pause();
            videoEl.style.display = 'none';
            videoEl.src = '';
        }

        if (imgEl) {
            imgEl.style.display = 'block';

            // Show thumbnail placeholder immediately if available in cache
            const thumbUrl = getThumbnailUrl(image.path_canon);
            if (thumbUrl) {
                imgEl.src = thumbUrl;
                imgEl.style.filter = 'blur(4px)';
                resetTransform(transformState, imgEl);
            }

            // Pre-load full image — guard against stale callbacks from rapid navigation
            const doLoad = () => {
                const loader = new Image();
                loader.onload = () => {
                    if (serial !== _loadSerial) return; // Stale callback — ignore
                    _clearLoadingUI();
                    resetTransform(transformState, imgEl);
                    imgEl.src = url;
                    imgEl.style.filter = '';
                    setupZoomAndPan(transformState, container, imgEl);
                    // VAGUE 2 : pose les dimensions naturelles de l'image sur la
                    // brique (letterbox/clamp/getImageRect précis) — setImageSize()
                    // refait le fit, ce qui reproduit le resetTransform d'ouverture.
                    if (transformState.viewport) {
                        transformState.viewport.setImageSize(loader.naturalWidth, loader.naturalHeight);
                    }
                    _applyEditorPreview(viewer, imgEl);
                };
                loader.onerror = () => {
                    if (serial !== _loadSerial) return; // Stale callback — ignore
                    _clearLoadingUI();
                    imgEl.style.filter = '';
                };
                // Start spinner 1s after load begins
                _loadingTimer = setTimeout(() => _showSpinner(container), 1000);
                loader.src = url;
            };
            // Delay full-size load when navigating (arrow keys), load immediately when entering view
            if (immediate) {
                doLoad();
            } else {
                _loadDelayTimer = setTimeout(() => {
                    _loadDelayTimer = null;
                    if (serial === _loadSerial) doLoad();
                }, 200);
            }
        }
    }
}

export function stopPlayback(viewer) {
    if (viewer.elements?.zoomVideo) viewer.elements.zoomVideo.pause();
    if (viewer.fullscreenElements?.video) viewer.fullscreenElements.video.pause();
}

export function showZoomedView(viewer, image) {
    imageViewerState.setState({ ui: { view_mode: 'zoom' } });

    const view = document.getElementById('holaf-viewer-zoom-view');
    const imgEl = view.querySelector('img');
    const videoEl = viewer.elements ? viewer.elements.zoomVideo : null;

    view.style.display = 'flex';
    const galleryEl = document.getElementById('holaf-viewer-gallery');
    if (galleryEl) galleryEl.style.display = 'none';

    _updateMediaSource(viewer, image, view, imgEl, videoEl, viewer.zoomViewState, true);

    preloadNextImage(viewer);
}

export async function hideZoomedView(viewer) {
    const action = await _handleUnsavedChanges(viewer);
    if (action === 'cancel') return;

    // Pause video
    if (viewer.elements && viewer.elements.zoomVideo) viewer.elements.zoomVideo.pause();

    imageViewerState.setState({ ui: { view_mode: 'gallery' } });

    const zoomView = document.getElementById('holaf-viewer-zoom-view');
    if (zoomView) zoomView.style.display = 'none';

    const galleryEl = document.getElementById('holaf-viewer-gallery');
    if (galleryEl) galleryEl.style.display = 'flex';

    // Restore scroll position alignment
    const { currentNavIndex } = imageViewerState.getState();
    if (currentNavIndex !== -1 && viewer.gallery?.alignImageOnExit) {
        viewer.gallery.alignImageOnExit(currentNavIndex);
    }
}

export function showFullscreenView(viewer, image) {
    if (!image) return;

    viewer._fullscreenSourceView = imageViewerState.getState().ui.view_mode;
    imageViewerState.setState({ ui: { view_mode: 'fullscreen' } });

    if (viewer._fullscreenSourceView === 'zoom') {
        const zoomView = document.getElementById('holaf-viewer-zoom-view');
        if (zoomView) zoomView.style.display = 'none';
        // Pause zoom video while in fullscreen
        if (viewer.elements && viewer.elements.zoomVideo) viewer.elements.zoomVideo.pause();
    }

    const { overlay, img: imgEl, video: videoEl } = viewer.fullscreenElements;
    overlay.style.display = 'flex';

    _updateMediaSource(viewer, image, overlay, imgEl, videoEl, viewer.fullscreenViewState, true);

    preloadNextImage(viewer);
}

export function hideFullscreenView(viewer) {
    if (viewer.fullscreenElements && viewer.fullscreenElements.overlay) {
        viewer.fullscreenElements.overlay.style.display = 'none';
    }

    // Pause fullscreen video
    if (viewer.fullscreenElements && viewer.fullscreenElements.video) {
        viewer.fullscreenElements.video.pause();
    }

    return viewer._fullscreenSourceView;
}

export async function navigate(viewer, direction) {
    const action = await _handleUnsavedChanges(viewer);
    if (action === 'cancel') return;

    const state = imageViewerState.getState();
    const total = _getTotalCount(state);
    if (total === 0) return;

    let newIndex = (state.currentNavIndex === -1) ? 0 : state.currentNavIndex + direction;

    if (newIndex < 0) {
        newIndex = total - 1;
    } else if (newIndex >= total) {
        newIndex = 0;
    }

    const newActiveImage = await _ensureImageLoaded(viewer, newIndex);
    if (!newActiveImage) return;

    imageViewerState.setState({ currentNavIndex: newIndex, activeImage: newActiveImage });

    if (viewer.gallery?.render) viewer.gallery.render();

    preloadNextImage(viewer);

    const currentViewMode = imageViewerState.getState().ui.view_mode;

    if (currentViewMode === 'gallery') {
        if (viewer.gallery?.ensureImageVisible) {
            viewer.gallery.ensureImageVisible(newIndex);
        }
    } else if (currentViewMode === 'zoom') {
        const view = document.getElementById('holaf-viewer-zoom-view');
        const imgEl = view.querySelector('img');
        const videoEl = viewer.elements ? viewer.elements.zoomVideo : null;
        _updateMediaSource(viewer, newActiveImage, view, imgEl, videoEl, viewer.zoomViewState);
    } else if (currentViewMode === 'fullscreen') {
        const { overlay, img, video } = viewer.fullscreenElements;
        _updateMediaSource(viewer, newActiveImage, overlay, img, video, viewer.fullscreenViewState);
    }
}

export async function navigateGrid(viewer, direction) {
    const state = imageViewerState.getState();
    const total = _getTotalCount(state);
    if (total === 0 || !viewer.gallery) return;

    const columnCount = viewer.gallery.getColumnCount();
    if (columnCount <= 0) return;

    const currentIndex = state.currentNavIndex;
    if (currentIndex === -1) {
        const newActiveImage = await _ensureImageLoaded(viewer, 0);
        if (!newActiveImage) return;
        imageViewerState.setState({ currentNavIndex: 0, activeImage: newActiveImage });
        if (viewer.gallery?.render) viewer.gallery.render();
        if (viewer.gallery?.ensureImageVisible) {
            viewer.gallery.ensureImageVisible(0);
        }
        return;
    }

    const newIndex = currentIndex + (direction * columnCount);

    if (newIndex < 0 || newIndex >= total) {
        return;
    }

    const newActiveImage = await _ensureImageLoaded(viewer, newIndex);
    if (!newActiveImage) return;

    imageViewerState.setState({ currentNavIndex: newIndex, activeImage: newActiveImage });

    if (viewer.gallery?.render) viewer.gallery.render();

    if (viewer.gallery?.ensureImageVisible) {
        viewer.gallery.ensureImageVisible(newIndex);
    }
}

export async function handleEscape(viewer) {
    const state = imageViewerState.getState();
    const currentMode = state.ui.view_mode;

    if (currentMode === 'fullscreen') {
        const sourceView = hideFullscreenView(viewer);
        const targetMode = sourceView === 'zoom' ? 'zoom' : 'gallery';
        imageViewerState.setState({ ui: { view_mode: targetMode } });

        if (targetMode === 'zoom') {
            document.getElementById('holaf-viewer-zoom-view').style.display = 'flex';
            const imgEl = document.querySelector('#holaf-viewer-zoom-view img');
            const videoEl = viewer.elements ? viewer.elements.zoomVideo : null;

            // Re-apply preview to the correct element (whichever is visible)
            if (videoEl && videoEl.style.display !== 'none') {
                _applyEditorPreview(viewer, videoEl);
                videoEl.play().catch(() => { });
            } else if (imgEl) {
                _applyEditorPreview(viewer, imgEl);
            }

        } else {
            const { currentNavIndex } = imageViewerState.getState();
            if (currentNavIndex !== -1 && viewer.gallery?.alignImageOnExit) {
                viewer.gallery.alignImageOnExit(currentNavIndex);
            }
        }
    } else if (currentMode === 'zoom') {
        await hideZoomedView(viewer);
    }
}

export async function handleKeyDown(viewer, e) {
    if (dialogState.isOpen) return;
    if (!viewer.panelElements?.panelEl || viewer.panelElements.panelEl.style.display === 'none') return;

    const isInputFocused = ['input', 'textarea', 'select'].includes(e.target.tagName.toLowerCase());
    if (isInputFocused && e.key !== 'Escape' && e.key !== 'Delete') return;

    const state = imageViewerState.getState();
    const currentMode = state.ui.view_mode;
    const total = _getTotalCount(state);
    const galleryEl = document.getElementById('holaf-viewer-gallery');

    switch (e.key) {
        case ' ': {
            if (currentMode !== 'gallery' || !state.activeImage) break;
            e.preventDefault();

            const currentSelection = new Set(state.selectedImages); // Copy for mutation
            if (currentSelection.has(state.activeImage)) {
                currentSelection.delete(state.activeImage);
            } else {
                currentSelection.add(state.activeImage);
            }

            imageViewerState.setState({ selectedImages: currentSelection });
            if (viewer.gallery?.render) viewer.gallery.render();
            viewer._updateActionButtonsState();
            break;
        }
        case 'Delete': {
            e.preventDefault();
            const isPermanent = e.shiftKey;

            if (currentMode !== 'gallery' && state.activeImage) {
                // Delete from edit/fullscreen — handleDeletion shows the confirmation.
                const success = await handleDeletion(viewer, isPermanent, [state.activeImage]);
                if (success) {
                    if (currentMode === 'fullscreen') {
                        hideFullscreenView(viewer);
                    } else if (currentMode === 'zoom') {
                        if (viewer.elements?.zoomVideo) viewer.elements.zoomVideo.pause();
                        const zoomView = document.getElementById('holaf-viewer-zoom-view');
                        if (zoomView) zoomView.style.display = 'none';
                        const galleryView = document.getElementById('holaf-viewer-gallery');
                        if (galleryView) galleryView.style.display = 'flex';
                    }
                    imageViewerState.setState({
                        selectedImages: new Set(),
                        activeImage: null,
                        currentNavIndex: -1,
                        ui: { view_mode: 'gallery' }
                    });
                    await viewer.loadFilteredImages();
                }
            } else if (state.selectedPaths.size > 0) {
                const success = await handleDeletion(viewer, isPermanent, null);
                if (success) {
                    imageViewerState.setState({ selectedImages: new Set(), activeImage: null, currentNavIndex: -1 });
                    await viewer.loadFilteredImages();
                }
            }
            break;
        }
        case 'PageUp':
        case 'PageDown':
            // FIX: Always prevent default to stop page scrolling, regardless of mode
            e.preventDefault();
            if (currentMode === 'gallery' && galleryEl) {
                galleryEl.scrollBy({ top: (e.key === 'PageDown' ? 1 : -1) * galleryEl.clientHeight * 0.9, behavior: 'smooth' });
            }
            break;
        case 'Home':
        case 'End':
            if (currentMode === 'gallery' && total > 0) {
                e.preventDefault();
                const targetIndex = e.key === 'Home' ? 0 : total - 1;
                const newActiveImage = await _ensureImageLoaded(viewer, targetIndex);
                if (!newActiveImage) break;
                imageViewerState.setState({ currentNavIndex: targetIndex, activeImage: newActiveImage });
                if (viewer.gallery?.render) viewer.gallery.render();
                if (viewer.gallery?.ensureImageVisible) {
                    viewer.gallery.ensureImageVisible(targetIndex);
                }
            }
            break;
        case 'Enter':
            e.preventDefault();
            const { currentNavIndex, activeImage } = state;
            let targetImage = activeImage;

            if (currentNavIndex === -1 && total > 0) {
                targetImage = await _ensureImageLoaded(viewer, 0);
                if (targetImage) {
                    imageViewerState.setState({ activeImage: targetImage, currentNavIndex: 0 });
                }
            }

            if (targetImage) {
                if (e.ctrlKey) {
                    showFullscreenView(viewer, targetImage);
                } else {
                    showZoomedView(viewer, targetImage);
                }
            }
            break;
        case 'ArrowRight':
        case 'ArrowLeft':
            e.preventDefault();
            await navigate(viewer, e.key === 'ArrowRight' ? 1 : -1);
            break;
        case 'ArrowUp':
        case 'ArrowDown':
            if (currentMode === 'gallery') {
                e.preventDefault();
                await navigateGrid(viewer, e.key === 'ArrowDown' ? 1 : -1);
            }
            break;
        case 'Escape':
            e.preventDefault();
            await handleEscape(viewer);
            break;
    }
}

// ── VAGUE 2 : délégation à la brique HolafViewport ──────────────────────
// Toute la logique wheel→zoom (zoom-to-cursor ×1.1 clamp [1,30]), drag→pan,
// clamps et transitions (none pendant le drag / .2s ease-out après) vit
// désormais dans js/vendor/holaf/holaf-viewport.js. L'hôte ne conserve que :
//   - la création/réutilisation de l'instance (un state = une instance,
//     exposée sur state.viewport pour l'éditeur, image_viewer_editor.js) ;
//   - la synchro de l'overlay mask de l'éditeur (via onChange) ;
//   - le feedback curseur et l'anti-ghost <img> (dragstart), que la brique
//     ne gère pas.

// Synchronise l'overlay mask (posé par l'éditeur dans le zoom view) sur le
// transform courant de l'élément média. VAGUE 4 : l'overlay est désormais un
// FOLLOWER de la brique (addFollower) — il reçoit le même transform inline que
// l'img (même string, même moment, même transition) → latence zéro, plus de
// copie manuelle du transform. addFollower est idempotent (Set) : appelé à
// chaque onChange, il ne fait rien si l'overlay suit déjà.
// VAGUE 5 : le mask vit dans un WRAPPER follower (boîte de repos = boîte de
// l'élément img, letterbox À L'INTÉRIEUR). C'est le WRAPPER qui suit le
// viewport, PAS le canvas (sinon double transform).
// VAGUE 7 : le viewport est PASSÉ en argument (au lieu de la ref lecture
// `state.viewport` non résolue ici) — l'overlay passif du mask doit être
// ré-enregistré comme follower de l'INSTANCE qui pilote réellement l'img
// (celle de `viewer.zoomViewState`, fournie par setupZoomAndPan). L'ancienne
// ref pointait une variable hors portée → ReferenceError silencieusement
// avalée par la brique → le passif ne se re-synchronisait jamais au zoom.
// addFollower est idempotent (Set) : rappelé à chaque onChange, sans effet
// si l'overlay suit déjà.
function _syncMaskOverlay(element, vp) {
    const maskOv = document.getElementById('holaf-mask-overlay');
    if (!maskOv) return;
    if (!vp) return;
    const wrapper = (maskOv.parentNode && maskOv.parentNode.id === 'holaf-mask-overlay-wrap')
        ? maskOv.parentNode : maskOv;
    vp.addFollower(wrapper);
}

// Parité UX : la brique ne gère pas le curseur. grabbing pendant un drag
// effectif (scale > fit), grab sinon. Display-only : aucune logique de pan ici.
const _cursorBoundElements = new WeakSet();
function _bindCursorFeedback(state, element) {
    if (_cursorBoundElements.has(element)) return;
    _cursorBoundElements.add(element);
    element.addEventListener('mousedown', () => {
        const vp = state.viewport;
        if (vp && vp.getScale() > vp.getFitScale() + 1e-9) element.style.cursor = 'grabbing';
    });
    window.addEventListener('mouseup', () => {
        if (element.style.cursor === 'grabbing') element.style.cursor = 'grab';
    });
}

// Contenu (élément média) porté par l'instance viewport de chaque state.
const _viewportContents = new WeakMap();

export function setupZoomAndPan(state, container, element) {
    if (!element || !container) return;

    // Un state = une instance. Si l'élément média change (bascule img ↔ vidéo),
    // l'instance précédente est détruite (elle restaure les styles inline de
    // son contenu et décroche ses listeners) puis recrée sur le nouvel élément.
    if (state.viewport && _viewportContents.get(state) !== element) {
        state.viewport.destroy();
        state.viewport = null;
        _viewportContents.delete(state);
    }

    if (!state.viewport) {
        state.viewport = HolafViewport.create(container, {
            content: element,   // mode content : <img>/<video> object-fit:contain remplissant la vue
            minZoom: 'fit',     // ↔ ancien clamp bas : 1 (en mode content, fit = scale 1)
            maxZoom: 30,        // ↔ ancien clamp haut
            zoomFactor: 1.1,    // ↔ ancien pas de wheel
            panClamp: true,     // l'image ne quitte jamais la vue (l'ancien drag pan était libre)
            // Pas de zoom dblclick sur la vue zoomée : l'img y porte déjà
            // ondblclick → fullscreen (image_viewer_ui.js, hors périmètre) —
            // déclencher AUSSI le zoom brique serait une régression. La vue
            // fullscreen n'a pas de handler dblclick → zoom brique activé.
            doubleClickZoom: container.id !== 'holaf-viewer-zoom-view',
            drag: true,
            dragButton: 0,      // ↔ ancien : clic gauche uniquement
            dragTarget: element, // ↔ ancien : drag posé sur l'élément, pas le container
            // VAGUE 6 : le pan ne démarre JAMAIS depuis un overlay de dessin
            // (crop/masque). Le canvas d'édition (pointer-events:auto) est au-dessus
            // de l'img → il intercepte le pointerdown pour le dessin ; ce garde-fou
            // garantit qu'un pointerdown sur l'overlay (canvas OU wrapper) ne déclenche
            // jamais le pan du viewport, sur les DEUX vues (zoom + fullscreen).
            canDrag: (e) => !(e.target && e.target.closest &&
                e.target.closest('#holaf-crop-overlay-wrap, #holaf-mask-overlay-wrap')),
            onChange: () => {
                // Overlay mask de l'éditeur : ré-enregistré comme follower à
                // chaque changement (idempotent — cf. _syncMaskOverlay).
                _syncMaskOverlay(element, state.viewport);
            },
        });
        _viewportContents.set(state, element);
        element.style.transformOrigin = '0 0'; // la brique le ré-applique à chaque applyTransform
        _bindCursorFeedback(state, element);
    }

    // Anti-ghost : la brique ne neutralise pas le dragstart natif des <img> —
    // conservé côté hôte (parité avec l'ancien code).
    element.ondragstart = (e) => e.preventDefault();
}