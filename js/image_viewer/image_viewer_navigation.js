/*
 * Copyright (C) 2025 Holaf
 * Holaf Utilities - Image Viewer Navigation Module
 *
 * This module handles all user navigation, including keyboard controls,
 * zoomed view, fullscreen view, and pan/zoom interactions.
 * FIX: Removed DOM cloning which caused "parentNode is null" errors.
 * FIX: Added safety checks for missing video elements.
 *
 * VAGUE 4 (brique holaf-lightbox) : la logique de visionneuse (machine à états
 * inline/zoom/fullscreen + restauration de la vue source, navigation ‹/› et
 * grille ↑/↓, préchargement, garde de stale-load, clavier de visionneuse,
 * délégation zoom/pan) est désormais portée par la brique vendue
 * HolafLightbox. Ce module devient l'ADAPTATEUR : il fournit à la brique la
 * SOURCE d'items (via imageViewerState), le RENDERER média (l'ancien
 * _updateMediaSource : img/vidéo/audio + spinner + hooks éditeur), les
 * CONTENEURS (les vues zoom/fullscreen existantes — l'éditeur requête leurs
 * sélecteurs), le VIEWPORT (HolafViewport) et le garde-fou clavier.
 */

import { imageViewerState } from './image_viewer_state.js';
import { handleDeletion } from './image_viewer_actions.js';
import { dialogState } from '../holaf_panel_manager.js';
import { getThumbnailUrl } from './image_viewer_gallery.js';
import { getImageAt } from './image_viewer_data.js';
// Brique vendue : visionneuse générique (machine à états, nav, préchargement,
// clavier, délégation viewport). L'hôte ne garde que les adaptateurs.
import { HolafLightbox } from '../vendor/holaf/holaf-lightbox.js';
// La géométrie + interactions zoom/pan restent dans la brique HolafViewport
// (vendored), INJECTÉE dans HolafLightbox (zéro import croisé côté brique).
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
    // Délégation à la brique. En mode content, le fit = scale 1
    // (l'object-fit:contain a déjà cadré) → reset() reproduit exactement
    // l'ancien translate(0,0) scale(1). Signature conservée : l'éditeur
    // (image_viewer_editor.js) l'appelle encore (ouverture mask/crop).
    state.viewport.reset();
    element.style.cursor = 'grab';
}

// --- Média : types reconnus (préchargement + rendu) ---
const VIDEO_FORMATS = ['MP4', 'WEBM', 'MKV', 'AVI', 'MOV', 'M4V'];
const AUDIO_FORMATS = ['WAV', 'MP3', 'OGG', 'FLAC', 'AAC', 'M4A'];

function _isVideoFormat(image) { return !!image && VIDEO_FORMATS.includes(image.format); }
function _isAudioFormat(image) { return !!image && AUDIO_FORMATS.includes(image.format); }

function _isMediaImage(image) {
    return image && !_isVideoFormat(image) && !_isAudioFormat(image);
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
 * when navigating rapidly. VAGUE 4 : ce renderer est INJECTÉ dans HolafLightbox
 * (renderMedia) — il retourne { el, destroy } et signale la disponibilité via
 * onReady({width,height}) (la brique pose alors setImageSize sur le viewport).
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

function _updateMediaSource(viewer, image, container, imgEl, videoEl, state, immediate, signal, onReady) {
    // Cancel any pending delayed full-size load
    if (_loadDelayTimer) {
        clearTimeout(_loadDelayTimer);
        _loadDelayTimer = null;
    }
    // Cancel any pending loading spinner (single global instance)
    _clearLoadingUI();

    const notifyReady = (payload) => {
        if (typeof onReady === 'function') onReady(payload || {});
    };

    // destroy() : appelé par la brique avant le rendu suivant et à la fermeture.
    // Il invalide les callbacks en vol (serial++), coupe le spinner et met la
    // vidéo en pause (équivalent de l'ancien nettoyage à la fermeture de vue).
    const destroy = () => {
        _loadSerial++;
        if (_loadDelayTimer) { clearTimeout(_loadDelayTimer); _loadDelayTimer = null; }
        _clearLoadingUI();
        if (videoEl) {
            try { videoEl.pause(); } catch (e) { /* ignore */ }
            videoEl.onloadedmetadata = null;
        }
    };
    if (signal) {
        if (signal.aborted) { destroy(); return { el: null, destroy }; }
        try { signal.addEventListener('abort', destroy, { once: true }); } catch (e) { /* ignore */ }
    }

    const serial = ++_loadSerial; // Each call gets a unique serial
    const isVideo = _isVideoFormat(image);
    const isAudio = _isAudioFormat(image);
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
            resetTransform(state, videoEl);

            // Audio-specific styling: smaller centered element
            videoEl.style.width = '80%';
            videoEl.style.maxWidth = '400px';
            videoEl.style.height = 'auto';
            videoEl.style.margin = 'auto';
            videoEl.style.border = '1px solid var(--holaf-border-color)';
            videoEl.style.borderRadius = 'var(--holaf-border-radius)';

            // Le lecteur audio n'est pas une surface zoomable — force l'identité
            // exacte (l'ancien resetTransform écrivait ce transform).
            videoEl.style.transform = 'translate(0px, 0px) scale(1)';

            videoEl.play().catch(() => {});
        }

        // Show a waveform/audio icon behind the player
        _applyEditorPreview(viewer, null);
        return { el: hasVideoEl ? videoEl : null, destroy };

    } else if (isVideo && hasVideoEl) {
        if (imgEl) {
            imgEl.style.display = 'none';
            imgEl.src = '';
        }

        // Reset any audio-specific styling
        videoEl.style.width = '';
        videoEl.style.maxWidth = '';
        videoEl.style.height = '';
        videoEl.style.margin = '';
        videoEl.style.border = '';
        videoEl.style.borderRadius = '';

        videoEl.style.display = 'block';
        videoEl.src = url;
        resetTransform(state, videoEl);

        // Pose les dimensions de la vidéo sur la brique dès que la metadata est
        // décodée (letterbox/clamp/getImageRect précis) — setImageSize() refait
        // le fit, ce qui reproduit le reset d'ouverture.
        videoEl.onloadedmetadata = () => {
            if (serial !== _loadSerial) return; // Chargement périmé — ignore
            notifyReady({ width: videoEl.videoWidth, height: videoEl.videoHeight });
        };

        _applyEditorPreview(viewer, videoEl);

        // Attempt autoplay
        videoEl.play().catch(() => {});
        return { el: videoEl, destroy };

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
                resetTransform(state, imgEl);
            }

            // Pre-load full image — guard against stale callbacks from rapid navigation
            const doLoad = () => {
                const loader = new Image();
                loader.onload = () => {
                    if (serial !== _loadSerial) return; // Stale callback — ignore
                    _clearLoadingUI();
                    resetTransform(state, imgEl);
                    imgEl.src = url;
                    imgEl.style.filter = '';
                    // Pose les dimensions naturelles de l'image sur la brique
                    // (letterbox/clamp/getImageRect précis).
                    notifyReady({ width: loader.naturalWidth, height: loader.naturalHeight });
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
        return { el: imgEl, destroy };
    }
}

// Renderer média injecté dans HolafLightbox : mappe (mode → éléments) puis
// délègue à _updateMediaSource.
function _renderMedia(viewer, ctx) {
    const { container, item, mode, onReady, signal, immediate } = ctx;
    const imgEl = container.querySelector('img');
    const videoEl = container.querySelector('video');
    const state = (mode === 'zoom') ? viewer.zoomViewState : viewer.fullscreenViewState;
    const result = _updateMediaSource(viewer, item, container, imgEl, videoEl, state, immediate, signal, onReady);
    if (result && result.el) _bindViewElement(viewer, mode, result.el);
    return result;
}

// ── Adaptateurs HolafLightbox ───────────────────────────────────────────────
// Le lightbox est per-viewer (aucun état de module partagé entre viewers).
const LIGHTBOXES = new WeakMap();
// Vues (conteneurs) déclarées par l'hôte via setupZoomAndPan AVANT la création
// du lightbox : state → { mode, container }.
const _pendingViews = new Map();

function _modeForContainer(container) {
    if (!container || !container.id) return null;
    if (container.id === 'holaf-viewer-fullscreen-overlay') return 'fullscreen';
    if (container.id === 'holaf-viewer-zoom-view') return 'zoom';
    return null;
}

function _shouldHandleKey(viewer, e) {
    if (dialogState.isOpen) return false;
    if (!viewer.panelElements?.panelEl || viewer.panelElements.panelEl.style.display === 'none') return false;
    const tag = e && e.target && e.target.tagName ? e.target.tagName.toLowerCase() : '';
    const isInputFocused = ['input', 'textarea', 'select'].includes(tag);
    if (isInputFocused && e.key !== 'Escape' && e.key !== 'Delete') return false;
    return true;
}

function _viewportOptions(viewer, mode, container, element) {
    return {
        content: element,   // mode content : <img>/<video> object-fit:contain remplissant la vue
        minZoom: 'fit',     // ↔ ancien clamp bas : 1 (en mode content, fit = scale 1)
        maxZoom: 30,        // ↔ ancien clamp haut
        zoomFactor: 1.1,    // ↔ ancien pas de wheel
        panClamp: true,     // l'image ne quitte jamais la vue
        // Pas de zoom dblclick sur la vue zoomée : l'img y porte déjà
        // ondblclick → fullscreen (image_viewer_ui.js). La vue fullscreen n'a
        // pas de handler dblclick → zoom brique activé.
        doubleClickZoom: container.id !== 'holaf-viewer-zoom-view',
        drag: true,
        dragButton: 0,
        dragTarget: element,
        // Le pan ne démarre JAMAIS depuis un overlay de dessin (crop/masque).
        canDrag: (e) => !(e.target && e.target.closest &&
            e.target.closest('#holaf-crop-overlay-wrap, #holaf-mask-overlay-wrap')),
        // Overlay mask de l'éditeur : ré-enregistré comme follower à chaque
        // changement (idempotent — cf. _syncMaskOverlay).
        onChange: (vp) => { _syncMaskOverlay(element, vp); },
    };
}

function _ensureLightbox(viewer) {
    let lb = LIGHTBOXES.get(viewer);
    if (lb) return lb;

    lb = HolafLightbox.create({
        host: document.body,
        zIndex: 10999, // bande z actuelle de l'overlay plein écran du pack
        getId: (item) => (item ? item.path_canon : null),
        urlFor: (item) => getFullImageUrl(item),
        renderMedia: (ctx) => _renderMedia(viewer, ctx),
        shouldPreload: _isMediaImage,
        preload: 10,
        preloadDebounce: 400,
        getColumnCount: () => (viewer.gallery && typeof viewer.gallery.getColumnCount === 'function')
            ? viewer.gallery.getColumnCount() : 1,
        getIndex: () => imageViewerState.getState().currentNavIndex,
        shouldHandleKey: (e) => _shouldHandleKey(viewer, e),
        beforeNavigate: () => _handleUnsavedChanges(viewer),
        viewport: HolafViewport,
        viewportOptions: (mode, container, element) => _viewportOptions(viewer, mode, container, element),
        onViewport: (mode, vp) => {
            // L'éditeur lit state.viewport (resetTransform) → on le tient à jour.
            const st = (mode === 'zoom') ? viewer.zoomViewState : viewer.fullscreenViewState;
            if (st) st.viewport = vp || undefined;
        },
        onOpen: (mode) => _onLightboxOpen(viewer, mode),
        onClose: (mode) => _onLightboxClose(viewer, mode),
        onNavigate: (dir, item, index) => _onLightboxNavigate(viewer, dir, item, index),
        onResume: (mode, item) => _onLightboxResume(viewer, mode, item),
    });

    // Enregistre les vues déjà déclarées par setupZoomAndPan.
    const zv = _pendingViews.get(viewer.zoomViewState);
    if (zv && zv.container) lb.addView('zoom', { container: zv.container, display: 'flex' });
    const fv = _pendingViews.get(viewer.fullscreenViewState);
    if (fv && fv.container) lb.addView('fullscreen', { container: fv.container, display: 'flex' });
    if (viewer.zoomViewState) _stateViewer.set(viewer.zoomViewState, viewer);
    if (viewer.fullscreenViewState) _stateViewer.set(viewer.fullscreenViewState, viewer);

    // Source d'items : total + résolution (async via la galerie) + lecture
    // synchrone (cache de fenêtres) pour le préchargement.
    lb.setSource({
        total: () => _getTotalCount(imageViewerState.getState()),
        getAt: (index) => _ensureImageLoaded(viewer, index),
        getAtSync: (index) => getImageAt(imageViewerState.getState(), index) || null,
    });

    LIGHTBOXES.set(viewer, lb);
    return lb;
}

function _onLightboxOpen(viewer, mode) {
    if (mode === 'zoom') {
        const galleryEl = document.getElementById('holaf-viewer-gallery');
        if (galleryEl) galleryEl.style.display = 'none';
    }
    imageViewerState.setState({ ui: { view_mode: mode } });
}

function _onLightboxClose(viewer, mode) {
    const lb = LIGHTBOXES.get(viewer);
    if (lb && lb.isOpen()) return; // une vue sous-jacente reste affichée

    imageViewerState.setState({ ui: { view_mode: 'gallery' } });
    const galleryEl = document.getElementById('holaf-viewer-gallery');
    if (galleryEl) galleryEl.style.display = 'flex';

    // Restore scroll position alignment
    const { currentNavIndex } = imageViewerState.getState();
    if (currentNavIndex !== -1 && viewer.gallery?.alignImageOnExit) {
        viewer.gallery.alignImageOnExit(currentNavIndex);
    }
}

function _onLightboxNavigate(viewer, dir, item, index) {
    if (!item) return;
    imageViewerState.setState({ currentNavIndex: index, activeImage: item });
    if (viewer.gallery?.render) viewer.gallery.render();

    const lb = LIGHTBOXES.get(viewer);
    if (lb && !lb.isOpen()) {
        if (viewer.gallery?.ensureImageVisible) viewer.gallery.ensureImageVisible(index);
    }
}

function _onLightboxResume(viewer, mode, item) {
    if (mode !== 'zoom') return;
    // Retour à la vue zoom (vue source du fullscreen) : on rétablit le mode.
    imageViewerState.setState({ ui: { view_mode: mode } });
    const zoomView = document.getElementById('holaf-viewer-zoom-view');
    const imgEl = zoomView ? zoomView.querySelector('img') : null;
    const videoEl = viewer.elements ? viewer.elements.zoomVideo : null;

    // Re-apply preview to the correct element (whichever is visible)
    if (videoEl && videoEl.style.display !== 'none') {
        _applyEditorPreview(viewer, videoEl);
        videoEl.play().catch(() => { });
    } else if (imgEl) {
        _applyEditorPreview(viewer, imgEl);
    }
}

// ── Façade (appelée par holaf_image_viewer.js / image_viewer_ui.js / gallery) ─
export function stopPlayback(viewer) {
    if (viewer.elements?.zoomVideo) viewer.elements.zoomVideo.pause();
    if (viewer.fullscreenElements?.video) viewer.fullscreenElements.video.pause();
}

export function showZoomedView(viewer, image) {
    const lb = _ensureLightbox(viewer);
    return lb.openZoom(image);
}

export async function hideZoomedView(viewer) {
    const action = await _handleUnsavedChanges(viewer);
    if (action === 'cancel') return;

    const lb = _ensureLightbox(viewer);
    while (lb.isOpen()) lb.back();
    await Promise.resolve();
}

export function showFullscreenView(viewer, image) {
    if (!image) return;
    viewer._fullscreenSourceView = imageViewerState.getState().ui.view_mode;
    const lb = _ensureLightbox(viewer);
    return lb.openFullscreen(image);
}

export function hideFullscreenView(viewer) {
    const lb = LIGHTBOXES.get(viewer);
    if (!lb) return viewer._fullscreenSourceView || 'gallery';
    lb.back();
    return lb.mode() || 'gallery';
}

export async function navigate(viewer, direction) {
    const lb = _ensureLightbox(viewer);
    return lb.navigate(direction);
}

export async function navigateGrid(viewer, direction) {
    if (!viewer.gallery) return;
    const lb = _ensureLightbox(viewer);
    return lb.navigateGrid(direction);
}

export async function handleEscape(viewer) {
    const lb = _ensureLightbox(viewer);
    lb.back();
}

export async function handleKeyDown(viewer, e) {
    if (dialogState.isOpen) return;
    if (!viewer.panelElements?.panelEl || viewer.panelElements.panelEl.style.display === 'none') return;

    const isInputFocused = ['input', 'textarea', 'select'].includes(e.target.tagName.toLowerCase());
    if (isInputFocused && e.key !== 'Escape' && e.key !== 'Delete') return;

    // Les touches de VISIONNEUSE (flèches, Entrée, Ctrl+Entrée, Échap, +/-, 0)
    // sont absorbées par la brique (avec son propre garde-fou shouldHandleKey).
    const lb = _ensureLightbox(viewer);
    if (lb.handleKey(e)) return;

    // Touches de GALERIE restantes.
    const state = imageViewerState.getState();
    const currentMode = state.ui.view_mode;
    const total = _getTotalCount(state);
    const galleryEl = document.getElementById('holaf-viewer-gallery');

    switch (e.key) {
        case ' ': {
            if (currentMode !== 'gallery' || !state.activeImage) break;
            e.preventDefault();

            // La galerie délègue la sélection à la brique HolafGrid ; son
            // onSelectionChange rebranche state.selectedPaths/selectedImages et
            // les boutons d'action. Repli historique si la brique est absente.
            const sel = viewer.gallery && viewer.gallery.selection;
            if (sel && typeof sel.toggle === 'function' && state.activeImage.path_canon) {
                sel.toggle(state.activeImage.path_canon);
            } else {
                const currentSelection = new Set(state.selectedImages); // Copy for mutation
                if (currentSelection.has(state.activeImage)) {
                    currentSelection.delete(state.activeImage);
                } else {
                    currentSelection.add(state.activeImage);
                }

                imageViewerState.setState({ selectedImages: currentSelection });
                if (viewer.gallery?.render) viewer.gallery.render();
                viewer._updateActionButtonsState();
            }
            break;
        }
        case 'Delete': {
            e.preventDefault();
            const isPermanent = e.shiftKey;

            if (currentMode !== 'gallery' && state.activeImage) {
                // Delete from edit/fullscreen — handleDeletion shows the confirmation.
                const success = await handleDeletion(viewer, isPermanent, [state.activeImage]);
                if (success) {
                    const lb2 = LIGHTBOXES.get(viewer);
                    if (lb2 && lb2.isOpen()) lb2.close();
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
    }
}

// ── Zoom/pan : délégation à la brique HolafViewport (INJECTÉE dans HolafLightbox) ─
// Toute la logique wheel→zoom, drag→pan, clamps et transitions vit dans
// js/vendor/holaf/holaf-viewport.js, instanciée par HolafLightbox (une instance
// par vue, recréée quand l'élément média change). setupZoomAndPan ne fait plus
// que DÉCLARER la vue (conteneur) à la brique ; la garde de compatibilité est
// conservée (appelée à l'init de l'UI et à la création de l'overlay fullscreen).

// Synchronise l'overlay mask (posé par l'éditeur dans le zoom view) sur le
// transform courant de l'élément média. L'overlay est un FOLLOWER du viewport
// (addFollower) : il reçoit le même transform inline que l'img (même string,
// même moment, même transition) → latence zéro. addFollower est idempotent.
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

export function setupZoomAndPan(state, container, element) {
    if (!state || !container) return;
    const mode = _modeForContainer(container);
    if (!mode) return;

    _pendingViews.set(state, { mode, container });

    // La brique crée elle-même le viewport (une instance par vue). L'hôte garde
    // le feedback curseur et l'anti-ghost <img>, que la brique ne gère pas.
    if (element) {
        element.style.transformOrigin = '0 0'; // la brique le ré-applique à chaque applyTransform
        element.ondragstart = (e) => e.preventDefault();
        _bindCursorFeedback(state, element);
    }

    // Si le lightbox existe déjà (vue déclarée tardivement), on enregistre la vue.
    const viewer = _viewerForState(state);
    if (viewer) {
        const lb = LIGHTBOXES.get(viewer);
        if (lb) lb.addView(mode, { container, display: 'flex' });
    }
}

// Retrouve le viewer propriétaire d'un state déjà mappé par un lightbox.
const _stateViewer = new WeakMap();
function _viewerForState(state) {
    return _stateViewer.get(state) || null;
}

// Exposé pour le renderer média : (re)branche le curseur + l'anti-ghost sur
// l'élément courant de chaque vue.
function _bindViewElement(viewer, mode, element) {
    const state = (mode === 'zoom') ? viewer.zoomViewState : viewer.fullscreenViewState;
    if (!state || !element) return;
    element.style.transformOrigin = '0 0';
    element.ondragstart = (e) => e.preventDefault();
    _bindCursorFeedback(state, element);
}
