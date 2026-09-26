/*
 * Copyright (C) 2025 Holaf
 * Holaf Utilities - Image Viewer Gallery Module
 *
 * MAJOR REFACTOR: Implements high-performance virtualized scrolling with NETWORK CANCELLATION.
 * INCLUDES: Built-in Benchmark Tool to test concurrency limits.
 * FIX: Added strict 30s TIMEOUT to prevent queue deadlocks on stalled requests.
 * UPDATE: Added video click handler.
 * UPDATE: Added Video Hover Preview logic with Soft Edit support.
 * UPDATE (Optim): Integrated LRU Cache to prevent re-fetching recent thumbnails.
 * UPDATE (Optim): Standard concurrency limit (6) restored thanks to In-Memory Stats.
 * FIX: Removed JS-forced object-fit for images (let CSS handle it).
 * FIX: Video preview now inherits object-fit from the underlying image via getComputedStyle.
 * FIX: Playback Rate applied to hover preview video.
 * FIX: Active video edit indicator.
 * FIX: Corrected API endpoint for hover edits.
 * FIX: Gallery disappearing thumbnails — robust load queue with generation counter,
 *       deduplication of activeThumbnailLoads decrements, and idle-restart mechanism.
 * UPDATE (brique): Le cache LRU, la file bornée, la dédup in-flight, le prefetch,
 *       le timeout + retries bornés, le protocole 202 + Retry-After et la
 *       priorisation des vignettes visibles sont délégués à la brique PUR-JS
 *       vendor/holaf/holaf-thumbcache.js ; ce module ne garde que l'adaptateur
 *       (URL + HolafFetch) et le rendu DOM (placeholder -> <img>).
 * UPDATE (brique): Le layout virtualisé (sizer + surface absolus, colonnes/gap/
 *       buffer), le pool de cellules recyclées + squelettes, le resize avec
 *       ancrage de rangée, la sélection mono/multi (shift/ctrl) et le
 *       scroll/alignement sont délégués à la brique DOM GÉNÉRIQUE
 *       vendor/holaf/holaf-virtual-grid.js (HolafGrid). Ce module devient un
 *       ADAPTATEUR : il fournit à la grille la source de données (via
 *       image_viewer_data.js), le renderer de cellule (icônes ✎/🎥/🎵,
 *       checkbox, hover vidéo, vignette) et rebranche ses call-sites
 *       historiques via la façade viewer.gallery.*. La navigation clavier
 *       reste tenue par image_viewer_navigation.js (le clavier de la grille est
 *       désactivé ici : keyboard:false).
 */

import "../aih_strings.js";
import { imageViewerState } from "./image_viewer_state.js";
import { HolafFetch } from "../vendor/holaf/holaf-fetch.js";
import { HolafThumbCache } from "../vendor/holaf/holaf-thumbcache.js";
import { HolafGrid } from "../vendor/holaf/holaf-virtual-grid.js";
import { showToast } from "../aih_toast_bridge.js";
import { showFullscreenView, getFullImageUrl } from './image_viewer_navigation.js';
import {
    PAGE_SIZE, getWindowStart, isWindowLoaded, isWindowLoading,
    getLoadingPromise, registerLoading, unregisterLoading,
    setWindowLoaded, resetWindowCache, getImageAt, getMissingWindowStarts,
    forEachLoadedImage
} from './image_viewer_data.js';

// Helper i18n central : traduit via AIH.I18n (clé brute si absente).
const t = (key, params) => {
    const I = window.AIH && window.AIH.I18n;
    return I && typeof I.t === "function" ? I.t(key, params) : key;
};

// --- Configuration ---
const FETCH_TIMEOUT_MS = 30000; // 30 seconds timeout per image
const HOVER_DELAY_MS = 100; // Slight delay before playing video to prevent crazy flashing when moving mouse fast

// Debounce for backend thumbnail prioritization (rapid scrolling must not spam it)
const PRIORITIZE_DEBOUNCE_MS = 300;
// Flush early when the pending path set grows too large during a long scroll
const PRIORITIZE_FLUSH_THRESHOLD = 1000;

// Standard browser limit is 6. With the new backend architecture (In-Memory Stats),
// we can safely use the full pipe without fearing DB locks.
let currentConcurrencyLimit = 6;
const PREFETCH_ROWS = 8; // Number of rows ahead of viewport to prefetch thumbnails for
let benchmarkCacheBuster = ''; // Used to bypass browser cache during tests
let benchmarkStartTime = 0;
let benchmarkTotalItems = 0;
let isBenchmarking = false;

const VIDEO_FORMATS = ['MP4', 'WEBM', 'MKV', 'AVI', 'MOV', 'M4V'];
const AUDIO_FORMATS = ['WAV', 'MP3', 'OGG', 'FLAC', 'AAC', 'M4A'];

// --- HOLAF THUMB CACHE (brique holaf-thumbcache) ---
// Le cache LRU, la file bornée, la dédup in-flight, le prefetch, le timeout +
// retries bornés, le protocole 202 + Retry-After et la priorisation des
// vignettes visibles sont gérés par la brique PUR-JS holaf-thumbcache.
// gallery.js ne garde QUE l'adaptateur (construction d'URL + HolafFetch) et le
// rendu DOM (placeholder -> <img>, overlay d'erreur).
const THUMBNAIL_CACHE_CAPACITY = 2000;
// Bound consecutive timeouts per thumbnail: transient server-side DB contention
// must not leave a permanent "Timeout" overlay on an otherwise valid item.
const MAX_THUMBNAIL_TIMEOUT_RETRIES = 4;

function buildThumbnailUrl(image, { forceReload = false } = {}) {
    const imageUrl = new URL(window.location.origin);
    imageUrl.pathname = '/holaf/images/thumbnail';
    let cacheBuster = image.thumb_hash ? image.thumb_hash : (image.mtime || '');
    if (benchmarkCacheBuster) cacheBuster += `_${benchmarkCacheBuster}`;
    const params = {
        filename: image.filename,
        subfolder: image.subfolder,
        path_canon: image.path_canon,
        mtime: cacheBuster,
    };
    if (forceReload) params.t = new Date().getTime();
    imageUrl.search = new URLSearchParams(params);
    return imageUrl.href;
}

const thumbCache = HolafThumbCache.create({
    capacity: THUMBNAIL_CACHE_CAPACITY,
    concurrency: currentConcurrencyLimit,
    strategy: 'blob', // createObjectURL + revoke à l'éviction/clear/destroy
    getId: (image) => image && image.path_canon,
    // raw:true → Response brute : statut 202 + Retry-After + blob gérés par la
    // brique ; signal + priority forwardés. timeout:0 → un seul garde-temps,
    // tenu par la brique (retries bornés homogènes).
    load: (image, { signal, priority }) =>
        HolafFetch.get(buildThumbnailUrl(image, { forceReload: !!image._forceReload }), {
            raw: true,
            signal,
            timeout: 0,
            priority: priority >= HolafThumbCache.PRIORITY_HIGH ? 'high' : 'low',
        }),
    retry: { max: MAX_THUMBNAIL_TIMEOUT_RETRIES, delayMs: 3000 },
    timeoutMs: FETCH_TIMEOUT_MS,
    // 202 : marquer la cellule "pending" (placeholder gris) au lieu d'une image cassée.
    onPending: (image) => {
        if (grid) grid.markPending(image.path_canon);
    },
    // Les échecs terminaux sont gérés PAR REQUÊTE (overlay sur la cellule) dans
    // loadThumbnail() ; onError n'est qu'un filet de sécurité.
    onError: () => {},
    // Priorisation backend : la brique absorbe le débounce + le flush anticipé,
    // on ne garde que le transport (POST fire-and-forget).
    onPrioritize: (paths) => {
        HolafFetch.post('/holaf/images/prioritize-thumbnails', { body: { paths_canon: paths } }).catch(() => {});
    },
    visibleDebounceMs: PRIORITIZE_DEBOUNCE_MS,
    visibleFlushThreshold: PRIORITIZE_FLUSH_THRESHOLD,
});

// Shim de compatibilité : les call-sites historiques lisent `thumbnailCache`.
const thumbnailCache = {
    has: (pathCanon) => thumbCache.has(pathCanon),
    // get historique = lecture QUI rafraîchit la récence (touch).
    get: (pathCanon) => thumbCache.touch(pathCanon),
    clear: () => thumbCache.clear(),
};

// --- Module-level state ---
let viewerInstance = null;
let galleryEl = null;
let grid = null;                     // instance HolafGrid (une galerie = une grille)
let windowFetchDebounceTimer = null;
const WINDOW_FETCH_DEBOUNCE_MS = 200;
let lastPrefetchEnd = -1;

// Track hover timeouts for video preview race condition prevention
const hoverTimeouts = new Map();

// --- EXPOSED BENCHMARK TOOL ---
if (!window.holaf) window.holaf = {};

window.holaf.runBenchmark = (concurrency = 6) => {
    console.clear();
    console.log(`🚀 STARTING BENCHMARK with Concurrency: ${concurrency}`);

    // 1. Setup Benchmark Environment
    currentConcurrencyLimit = concurrency;
    thumbCache.setConcurrency(concurrency);
    benchmarkCacheBuster = `bench_${Date.now()}`; // Unique ID to bypass browser cache
    isBenchmarking = true;
    thumbnailCache.clear(); // Clear cache for fair test

    // 2. Reset Gallery
    if (viewerInstance && grid) {
        // Cancel everything current
        thumbCache.abort();

        // Full rebuild to force re-loading from scratch (cache was cleared).
        grid.render(true);

        // 3. Start Timer and Trigger Render
        setTimeout(() => {
            const visibleCount = getVisibleItemCount();
            console.log(`📸 Target: Loading ${visibleCount} visible images from scratch...`);
            benchmarkTotalItems = visibleCount;
            benchmarkStartTime = performance.now();

            // Force re-layout and load
            grid.render(true);
        }, 100);
    } else {
        console.error("Gallery not initialized. Open the Image Viewer first.");
    }
};

function getVisibleItemCount() {
    if (!galleryEl || !grid) return 0;
    const m = grid.getMetrics();
    const viewportHeight = galleryEl.clientHeight;
    const itemHeightWithGap = m.itemHeight + m.gap;
    if (itemHeightWithGap <= 0) return 0;
    const rowsVisible = Math.ceil(viewportHeight / itemHeightWithGap) + 1; // +1 buffer
    return Math.min(rowsVisible * Math.max(1, m.columns), imageViewerState.getState().images.length);
}

function checkBenchmarkCompletion() {
    if (!isBenchmarking || !grid) return;

    // Rien en vol / en file / planifié → benchmark terminé
    if (thumbCache.stats().pending === 0) {
        // Double check: are all visible placeholders actually loaded?
        const visiblePlaceholders = Array.from(grid.surface.querySelectorAll('.holaf-viewer-thumbnail-placeholder'));
        const allLoaded = visiblePlaceholders.every(p => p.dataset.thumbnailLoadingOrLoaded === 'true' || p.dataset.thumbnailLoadingOrLoaded === 'error');

        if (allLoaded) {
            const endTime = performance.now();
            const duration = (endTime - benchmarkStartTime) / 1000; // seconds
            const speed = (benchmarkTotalItems / duration).toFixed(2);

            console.log(`🏁 BENCHMARK COMPLETE`);
            console.log(`-----------------------------------`);
            console.log(`threads:  ${currentConcurrencyLimit}`);
            console.log(`time:     ${duration.toFixed(3)}s`);
            console.log(`speed:    ${speed} images/sec`);
            console.log(`-----------------------------------`);

            // Reset benchmark state
            isBenchmarking = false;
            benchmarkCacheBuster = '';

            showToast({
                message: t('iv.benchmarkResult', { threads: currentConcurrencyLimit, speed, time: duration.toFixed(2) }),
                type: 'success',
                html: true
            });
        }
    }
}

// --- Internal Functions ---

function getThumbSize() {
    const s = imageViewerState.getState();
    return (s.ui && s.ui.thumbnail_size) ? s.ui.thumbnail_size : 150;
}

// --- Cell renderer (injecté dans la grille) ---
// La brique HolafGrid ne connaît AUCUNE notion métier : elle délègue au module
// la construction/rafraîchissement/nettoyage des cellules, les slots (checkbox)
// et les actions (icône zoom / plein écran).
function createCell() {
    const placeholder = document.createElement('div');
    placeholder.className = 'holaf-viewer-thumbnail-placeholder';
    placeholder.style.position = 'absolute';

    const actionIcon = document.createElement('div');
    actionIcon.className = 'holaf-viewer-edit-icon';
    actionIcon.setAttribute('data-holaf-action', 'zoom');
    placeholder._actionIcon = actionIcon;
    placeholder.appendChild(actionIcon);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'holaf-viewer-thumb-checkbox';
    checkbox.title = t('iv.selectImage');
    placeholder._checkbox = checkbox;
    placeholder.appendChild(checkbox);

    return placeholder;
}

// Nettoie les enfants dynamiques + les écouteurs spécifiques AVANT (re)liaison
// ou mise au pool : la cellule est recyclée par la brique.
function cleanupCell(el) {
    if (el._hoverCleanup) {
        el._hoverCleanup();
        el._hoverCleanup = null;
    }
    const path = el.dataset.pathCanon;
    if (path && hoverTimeouts.has(path)) {
        clearTimeout(hoverTimeouts.get(path));
        hoverTimeouts.delete(path);
    }
    const oldImg = el.querySelector('img');
    if (oldImg) oldImg.remove();
    const oldVideo = el.querySelector('video.holaf-hover-preview');
    if (oldVideo) { oldVideo.pause(); oldVideo.src = ""; oldVideo.remove(); }
    const oldError = el.querySelector('.holaf-viewer-error-overlay');
    if (oldError) oldError.remove();
    const oldFsIcon = el.querySelector('.holaf-viewer-fullscreen-icon');
    if (oldFsIcon) oldFsIcon.remove();
    el._hoverGeneration = 0;
}

function updateCell(el, image, ctx) {
    const id = image.path_canon;
    cleanupCell(el);
    el.dataset.pathCanon = id;
    el.classList.remove('active', 'error');

    const isVideo = VIDEO_FORMATS.includes(image.format);
    const isAudio = AUDIO_FORMATS.includes(image.format);
    const actionIcon = el._actionIcon;
    actionIcon.classList.remove('active');
    if (isVideo) {
        actionIcon.innerHTML = '🎥';
        actionIcon.title = t('iv.playVideo');
        if (image.has_edit_file) actionIcon.classList.add('active');
        el._hoverCleanup = attachVideoHoverListeners(el, image);
    } else if (isAudio) {
        actionIcon.innerHTML = '\uD83C\uDFB5';
        actionIcon.title = t('iv.playAudio');
        if (image.has_edit_file) actionIcon.classList.add('active');
    } else {
        actionIcon.innerHTML = '✎';
        actionIcon.title = t('iv.editImage');
        if (image.has_edit_file) actionIcon.classList.add('active');
    }
    if (ctx && ctx.refresh) actionIcon.classList.add('active');

    delete el.dataset.thumbnailLoadingOrLoaded;
    loadThumbnail(el, image, !!(ctx && ctx.refresh));

    const active = imageViewerState.getState().activeImage;
    el.classList.toggle('active', !!(active && active.path_canon === id));
}

function releaseCell(el) {
    cleanupCell(el);
    const path = el.dataset.pathCanon;
    if (path) thumbCache.cancel(path);
    el.classList.remove('active', 'error', 'holaf-grid-cell--pending');
    delete el.dataset.thumbnailLoadingOrLoaded;
}

// --- Thumbnail render (adaptateur brique → DOM) ---
// La brique holaf-thumbcache tient le cache, la concurrence, la dédup in-flight,
// le timeout + retries bornés et le protocole 202 + Retry-After. Ici on ne fait
// que : demander la vignette (request haute priorité), dessiner le <img> au
// succès, poser l'overlay d'erreur à l'échec terminal, nettoyer sur annulation.
function isAbortError(err) {
    return !!err && (err.name === 'AbortError' || err.aborted === true);
}

function loadThumbnail(el, image, forceReload = false) {
    const pathCanon = image.path_canon;

    // Force reload (édition d'image) : purge la valeur cachée puis recharge (le
    // paramètre `t` est ajouté par buildThumbnailUrl via `_forceReload`).
    if (forceReload) {
        thumbCache.invalidate(pathCanon);
        const oldImg = el.querySelector('img');
        if (oldImg) oldImg.remove();
    } else if (el.dataset.thumbnailLoadingOrLoaded === 'true') {
        return;
    }

    // Cache-hit : dessin immédiat (touch = rafraîchit la récence LRU).
    const cachedUrl = thumbnailCache.get(pathCanon);
    if (!forceReload && cachedUrl) {
        drawThumbnail(el, cachedUrl, image);
        return;
    }

    // Visual feedback for loading (optional: could be a spinner)
    el.dataset.thumbnailLoadingOrLoaded = "loading";
    el.classList.remove('error');
    const existingError = el.querySelector('.holaf-viewer-error-overlay');
    if (existingError) existingError.remove();

    const item = forceReload ? { ...image, _forceReload: true } : image;

    return thumbCache.request(item, HolafThumbCache.PRIORITY_HIGH).then((objectURL) => {
        if (!el.isConnected) {
            // Cellule évincée : la vignette est en cache, le prochain rendu la
            // reprendra via le cache-hit. Rien à dessiner ici.
            return;
        }
        drawThumbnail(el, objectURL, image);
    }).catch((err) => {
        if (isAbortError(err)) {
            // Annulation (syncGallery) : le blob n'est pas caché ; on rend l'item
            // à la file pour qu'il soit rechargé quand il revient à l'écran.
            if (el.isConnected) delete el.dataset.thumbnailLoadingOrLoaded;
            return;
        }
        // Échec terminal (timeout après retries bornés, HTTP non-2xx, réseau).
        if (!el.isConnected) return;
        el.classList.add('error');
        el.dataset.thumbnailLoadingOrLoaded = "error";
        const errorDiv = document.createElement('div');
        errorDiv.className = 'holaf-viewer-error-overlay';
        errorDiv.textContent = (err && err.timedOut) ? t('iv.timeout') : t('iv.err');
        el.appendChild(errorDiv);
    }).finally(() => {
        if (isBenchmarking) checkBenchmarkCompletion();
    });
}

function drawThumbnail(el, url, image) {
    const img = document.createElement('img');
    img.className = "holaf-image-viewer-thumbnail";
    img.src = url;
    // --- FIX: REMOVED forced JS style for images. CSS classes handle it. ---
    img.style.objectFit = '';
    img.onload = () => {
        addFullscreenIcon(el, image);
    };

    const oldImg = el.querySelector('img');
    if (oldImg) oldImg.remove();

    el.prepend(img);
    el.dataset.thumbnailLoadingOrLoaded = "true";
}

function addFullscreenIcon(placeholder, image) {
    if (!placeholder.querySelector('.holaf-viewer-fullscreen-icon')) {
        const fsIcon = document.createElement('div');
        fsIcon.className = 'holaf-viewer-fullscreen-icon';
        fsIcon.setAttribute('data-holaf-action', 'fullscreen');
        fsIcon.innerHTML = '⛶';
        fsIcon.title = t('iv.viewFullscreen');
        // Click handled via delegation on the grid surface
        placeholder.appendChild(fsIcon);
    }
}

// --- Sélection / activation / actions (rebranchées sur la grille) ---
function handleSelectionChange(ids, items) {
    // Source de vérité métier : state.selectedPaths (Set d'ids) + selectedImages.
    imageViewerState.setState({
        selectedPaths: new Set(ids),
        selectedImages: new Set(items),
    });
    applyActiveClass();
    if (viewerInstance && typeof viewerInstance._updateActionButtonsState === 'function') {
        viewerInstance._updateActionButtonsState();
    }
}

function handleActivate(image, index, kind) {
    if (!image) return;
    imageViewerState.setState({ activeImage: image, currentNavIndex: index });
    applyActiveClass();
    if (kind === 'dblclick') {
        viewerInstance._showZoomedView(image);
    }
}

function handleCellAction(actionId, image, index) {
    if (!image) return;
    imageViewerState.setState({ activeImage: image, currentNavIndex: index });
    if (actionId === 'fullscreen') {
        showFullscreenView(viewerInstance, image);
    } else {
        viewerInstance._showZoomedView(image);
    }
}

// Reflète l'image active (state.métier) sur la bordure `.active` des cellules.
// La brique ne connaît pas « active » (métier) : l'hôte le pilote.
function applyActiveClass() {
    if (!grid) return;
    const active = imageViewerState.getState().activeImage;
    const activePath = active ? active.path_canon : null;
    const cells = grid.surface.children;
    for (let i = 0; i < cells.length; i++) {
        const el = cells[i];
        if (el.dataset.pathCanon === undefined) continue;
        el.classList.toggle('active', el.dataset.pathCanon === activePath);
    }
}

// --- Priorisation visible + fenêtres + prefetch (rebranchés sur la grille) ---
function handleVisibleRange(start, end) {
    const state = imageViewerState.getState();
    const total = (state.totalCount != null && state.totalCount > 0) ? state.totalCount : (state.images ? state.images.length : 0);
    if (!total) return;

    // Priorisation backend : uniquement les vignettes visibles non cachées /
    // non en vol (débounce + flush tenus par la brique holaf-thumbcache).
    const visibleIds = [];
    for (let i = start; i <= end; i++) {
        const img = getImageAt(state, i);
        if (!img) continue;
        const pathCanon = img.path_canon;
        if (!thumbCache.has(pathCanon) && !thumbCache.isLoading(pathCanon)) {
            visibleIds.push(pathCanon);
        }
    }
    if (visibleIds.length > 0) thumbCache.onVisible(visibleIds);

    // Fetch any not-yet-loaded window visible in the current range.
    scheduleEnsureRange(start, end);

    // Prefetch ahead of the viewport (no DOM) — hors fenêtre rendue.
    prefetchAhead(end, total);
}

function prefetchAhead(endIndex, total) {
    if (!grid) return;
    const m = grid.getMetrics();
    if (m.itemHeight === 0) return;
    const cols = Math.max(1, m.columns);
    const endRow = Math.floor(endIndex / cols);
    const start = (endRow + 1) * cols;
    if (start === lastPrefetchEnd) return;
    lastPrefetchEnd = start;
    const stop = Math.min(total - 1, start + (PREFETCH_ROWS * cols) - 1);
    if (start > stop) return;

    let slots = currentConcurrencyLimit - thumbCache.stats().active;
    const toPrefetch = [];
    const state = imageViewerState.getState();
    for (let i = start; i <= stop && slots > 0; i++) {
        const image = getImageAt(state, i);
        if (!image) continue;
        const pathCanon = image.path_canon;
        if (thumbCache.has(pathCanon)) continue;
        if (thumbCache.isLoading(pathCanon)) continue;
        toPrefetch.push(image);
        slots--;
    }
    if (toPrefetch.length > 0) {
        thumbCache.prefetch(toPrefetch).then(() => {
            if (isBenchmarking) checkBenchmarkCompletion();
        });
    }
}

function scheduleEnsureRange(startIndex, endIndex) {
    clearTimeout(windowFetchDebounceTimer);
    windowFetchDebounceTimer = setTimeout(() => {
        windowFetchDebounceTimer = null;
        fetchMissingWindows(startIndex, endIndex);
    }, WINDOW_FETCH_DEBOUNCE_MS);
}

async function fetchMissingWindows(startIndex, endIndex) {
    const starts = getMissingWindowStarts(startIndex, endIndex);
    for (const start of starts) {
        await fetchWindow(start);
    }
    renderVisibleItems();
}

async function fetchWindow(start) {
    const existing = getLoadingPromise(start);
    if (existing) return existing;
    const state = imageViewerState.getState();
    const filters = { ...state.filters };
    delete filters.locked_folders;
    const controller = new AbortController();
    const promise = (async () => {
        try {
            const tStart = performance.now();
            // POST JSON + parse gérés par la brique (lève sur non-2xx → catch).
            const data = await HolafFetch.post('/holaf/images/list', {
                body: { ...filters, limit: PAGE_SIZE, offset: start, skip_count: true },
                signal: controller.signal
            });
            const tFetch = performance.now();
            const tParse = tFetch; // parse JSON inclus dans l'attente de la brique
            const totalMs = tParse - tStart;
            if (totalMs > 100) {
                console.log("[Holaf Perf] fetchWindow offset=" + start + " fetch_ms=" + (tFetch - tStart).toFixed(1) + " parse_ms=" + (tParse - tFetch).toFixed(1) + " total_ms=" + totalMs.toFixed(1));
            }
            setWindowLoaded(imageViewerState.getState(), start, data.images || []);
        } catch (err) {
            console.warn('[Holaf ImageViewer] Window fetch failed', err);
        } finally {
            unregisterLoading(start);
        }
    })();
    registerLoading(start, controller, promise);
    return promise;
}

// --- Video Hover Preview (extracted for reuse with pooled placeholders) ---
function attachVideoHoverListeners(placeholder, image) {
    const mouseenterHandler = async () => {
        const generation = (placeholder._hoverGeneration || 0) + 1;
        placeholder._hoverGeneration = generation;

        if (hoverTimeouts.has(image.path_canon)) {
            clearTimeout(hoverTimeouts.get(image.path_canon));
            hoverTimeouts.delete(image.path_canon);
        }

        let editData = null;
        if (image.has_edit_file) {
            try {
                // La brique lève sur non-2xx → catch identique (warning console).
                const result = await HolafFetch.get(`/holaf/images/load-edits?path_canon=${encodeURIComponent(image.path_canon)}`);
                if (!placeholder.isConnected || placeholder._hoverGeneration !== generation) return;
                if (result.status === 'ok') editData = result.edits;
            } catch (e) {
                if (!placeholder.isConnected || placeholder._hoverGeneration !== generation) return;
                console.warn("Failed to load hover edits", e);
            }
        }

        if (!placeholder.isConnected || placeholder._hoverGeneration !== generation) return;

        const timeoutId = setTimeout(() => {
            hoverTimeouts.delete(image.path_canon);
            if (!placeholder.isConnected || placeholder._hoverGeneration !== generation) return;

            const existingVideo = placeholder.querySelector('video.holaf-hover-preview');
            if (existingVideo) return;

            const videoUrl = getFullImageUrl(image);
            const vid = document.createElement('video');
            vid.className = 'holaf-hover-preview';
            vid.src = videoUrl;
            vid.muted = true;
            vid.loop = true;
            vid.autoplay = true;
            vid.playsInline = true;

            let filterStr = "";
            if (editData) {
                if (editData.brightness) filterStr += `brightness(${editData.brightness}) `;
                if (editData.contrast) filterStr += `contrast(${editData.contrast}) `;
                if (editData.saturation) filterStr += `saturate(${editData.saturation}) `;
                if (editData.hue && parseFloat(editData.hue) !== 0) filterStr += `hue-rotate(${editData.hue}deg) `;

                if (editData.playbackRate) {
                    vid.playbackRate = parseFloat(editData.playbackRate);
                }
            }

            const img = placeholder.querySelector('img.holaf-image-viewer-thumbnail');
            let fitMode = 'cover';
            if (img) {
                fitMode = getComputedStyle(img).objectFit || 'cover';
            }

            vid.style.cssText = `
                position: absolute; top: 0; left: 0; width: 100%; height: 100%;
                object-fit: ${fitMode}; z-index: 2; pointer-events: none;
                filter: ${filterStr};
            `;

            vid.onerror = () => { vid.remove(); };
            placeholder.appendChild(vid);
        }, HOVER_DELAY_MS);

        hoverTimeouts.set(image.path_canon, timeoutId);
    };

    const mouseleaveHandler = () => {
        placeholder._hoverGeneration = (placeholder._hoverGeneration || 0) + 1;
        if (hoverTimeouts.has(image.path_canon)) {
            clearTimeout(hoverTimeouts.get(image.path_canon));
            hoverTimeouts.delete(image.path_canon);
        }
        const vid = placeholder.querySelector('video.holaf-hover-preview');
        if (vid) {
            vid.pause();
            vid.src = "";
            vid.remove();
        }
    };

    placeholder.addEventListener('mouseenter', mouseenterHandler);
    placeholder.addEventListener('mouseleave', mouseleaveHandler);

    // Return cleanup function to remove listeners
    return () => {
        placeholder.removeEventListener('mouseenter', mouseenterHandler);
        placeholder.removeEventListener('mouseleave', mouseleaveHandler);
    };
}

// --- Source de données injectée dans la grille ---
// `getAt` est creux : les fenêtres non chargées renvoient null → squelettes.
function makeGridSource() {
    return {
        getAt: (index) => getImageAt(imageViewerState.getState(), index),
        total: () => {
            const s = imageViewerState.getState();
            return (s.totalCount != null && s.totalCount > 0) ? s.totalCount : (s.images ? s.images.length : 0);
        },
        forEachLoaded: (cb) => forEachLoadedImage(imageViewerState.getState(), cb),
    };
}

// --- Functions to be exported ---

function initGallery(viewer) {
    viewerInstance = viewer;
    galleryEl = document.getElementById("holaf-viewer-gallery");

    document.addEventListener('holaf-refresh-thumbnail', (e) => {
        const { path_canon } = e.detail;
        if (path_canon) refreshThumbnailInGallery(path_canon);
    });

    // La grille virtualisée possède désormais sizer/surface/cellules/pool,
    // les listeners scroll + ResizeObserver et la sélection. Le clavier reste
    // tenu par image_viewer_navigation.js (keyboard:false).
    grid = HolafGrid.create(galleryEl, {
        itemSize: () => getThumbSize(),
        gap: 'auto',
        bufferFactor: 1.5,
        aspect: 1,
        getId: (image) => image && image.path_canon,
        selectable: true,
        multi: true,
        keyboard: false,
        activateOnClick: true,
        cell: { create: createCell, update: updateCell, release: releaseCell },
        onSelectionChange: handleSelectionChange,
        onVisibleRange: handleVisibleRange,
        onActivate: handleActivate,
        onAction: handleCellAction,
    });
    // Source de données creuse (tableau d'images + fenêtres chargées à la demande).
    grid.setSource(makeGridSource());

    viewer.gallery = {
        ensureImageVisible,
        alignImageOnExit,
        refreshThumbnail: refreshThumbnailInGallery,
        render: renderVisibleItems,
        getColumnCount: () => grid.getColumnCount(),
        jumpToOldest,
        jumpToNewest,
        ensureImageLoaded,
        selection: grid.selection,
    };
}

// Ré-affiche la fenêtre visible de la grille. Re-synchronise la sélection de la
// brique depuis l'état métier (au cas où un module tiers — navigation clavier —
// l'a modifiée) et reflète l'image active.
function renderVisibleItems() {
    if (!grid) return;
    const st = imageViewerState.getState();
    grid.selection.set(Array.from(st.selectedPaths || []), { silent: true });
    // Re-ancre la sélection sur l'index de navigation courant (le clavier de
    // PAGE tenu par image_viewer_navigation.js met à jour currentNavIndex) :
    // shift+clic s'étend depuis cet index, comme l'ancien code.
    if (typeof st.currentNavIndex === 'number' && st.currentNavIndex >= 0) {
        grid.selection.setAnchor(st.currentNavIndex);
    }
    grid.render();
    applyActiveClass();
}

function syncGallery(viewer, images) {
    if (!galleryEl) initGallery(viewer);

    viewerInstance = viewer;

    // --- FIX: Incremental update instead of destroy-and-rebuild ---
    // Only do full teardown when the image list has actually changed.
    const oldImages = imageViewerState.getState().images;
    const oldPaths = new Set(oldImages.map(img => img.path_canon));
    const newPaths = new Set(images.map(img => img.path_canon));

    // Check if the lists differ — force rebuild when target list is empty
    // (the DOM might have stale placeholders from a previous non-empty load)
    let needsFullRebuild = false;
    if (images.length === 0) {
        needsFullRebuild = true;
    } else if (oldPaths.size !== newPaths.size) {
        needsFullRebuild = true;
    } else {
        for (const p of newPaths) {
            if (!oldPaths.has(p)) { needsFullRebuild = true; break; }
        }
    }

    if (!needsFullRebuild) {
        // Same images, maybe just metadata changed — just re-render without destroying cache.
        // IMPORTANT: loadFilteredImages updates state.images BEFORE calling syncGallery, so the
        // diff above sees no change and skips the full rebuild that normally clears the grid.
        // That leaves the "no images match" placeholder stuck under the thumbnails when we go
        // from an empty result back to a populated one. Remove it explicitly here.
        const emptyMsg = grid.surface.querySelector('.holaf-viewer-empty-message');
        if (emptyMsg) emptyMsg.remove();
        grid.relayout();
        applyActiveClass();
        return;
    }

    // Full rebuild (image list actually changed)
    // Stoppe les chargements en vol + les retries planifiés (la brique rejette
    // les promesses concernées ; loadThumbnail nettoie l'état des cellules).
    thumbCache.abort();
    lastPrefetchEnd = -1;
    resetWindowCache();

    // Keep LRU Cache alive! Don't clear it — thumbnails are still valid.
    // thumbnailCache.clear();

    const messageEl = galleryEl.querySelector('.holaf-viewer-message');
    if (messageEl) messageEl.remove();

    if (images && images.length > 0) {
        galleryEl.scrollTop = 0;
        grid.render(true);
        applyActiveClass();
    } else {
        grid.render(true);
        grid.sizer.style.height = '300px';
        const placeholder = document.createElement('div');
        placeholder.className = 'holaf-viewer-thumbnail-placeholder holaf-viewer-empty-message';
        placeholder.style.cssText = `position: absolute; top: 8px; left: 8px; right: 8px; height: 200px; display: flex; align-items: center; justify-content: center; text-align: center; padding: 20px; box-sizing: border-box; border: 2px dashed var(--holaf-border-color); border-radius: var(--holaf-border-radius); color: var(--holaf-text-color-secondary);`;
        placeholder.textContent = t('iv.noImagesMatch');
        grid.surface.appendChild(placeholder);
    }
}

// Re-render after an incremental delta (insert at top / remove) WITHOUT
// resetting the window cache: the loaded windows and their thumbnails survive.
// Only used by the periodic-refresh delta path; full rebuilds still go through
// syncGallery().
function refreshAfterIncremental(viewer) {
    viewerInstance = viewer;
    // Nothing to render if the gallery panel was never opened. The next full
    // load (panel open / filter change) rebuilds everything from state anyway.
    if (!galleryEl || !grid) return;

    const state = imageViewerState.getState();
    const total = (state.totalCount != null && state.totalCount > 0)
        ? state.totalCount
        : (state.images ? state.images.length : 0);
    if (!total) return;

    // Going from an empty result back to a populated one must drop the placeholder.
    const emptyMsg = grid.surface.querySelector('.holaf-viewer-empty-message');
    if (emptyMsg) emptyMsg.remove();

    grid.relayout();
    applyActiveClass();
}

function refreshThumbnailInGallery(path_canon) {
    if (!grid) return;
    const allImages = imageViewerState.getState().images;
    const image = allImages.find(img => img.path_canon === path_canon);
    if (!image) return;
    // La brique retrouve la cellule par id et rappelle updateCell(refresh:true),
    // qui force le rechargement de la vignette et marque l'icône d'édition.
    grid.refresh(path_canon);
}

function ensureImageVisible(imageIndex) {
    if (!grid || imageIndex < 0) return;
    // La brique gère l'alignement (scroll smooth) ; nearest = no-op si visible.
    grid.scrollToIndex(imageIndex, { align: 'nearest', smooth: true });
}

function alignImageOnExit(imageIndex) {
    if (!grid || imageIndex < 0) return;
    grid.scrollToIndex(imageIndex, { align: 'nearest', smooth: true });
}

function jumpToOldest() {
    if (!grid) return;
    const state = imageViewerState.getState();
    const total = (state.totalCount != null && state.totalCount > 0) ? state.totalCount : state.images.length;
    if (!total) return;
    grid.scrollToIndex(total - 1, { align: 'end' });
}

function jumpToNewest() {
    if (!grid) return;
    grid.scrollToIndex(0, { align: 'start' });
}

async function ensureImageLoaded(index) {
    const state = imageViewerState.getState();
    const image = getImageAt(state, index);
    if (image) return image;
    const start = getWindowStart(index);
    if (isWindowLoading(start)) {
        const p = getLoadingPromise(start);
        if (p) await p;
    } else if (!isWindowLoaded(start)) {
        await fetchWindow(start);
    }
    return getImageAt(imageViewerState.getState(), index) || null;
}

function forceRelayout(newSize) {
    if (!grid) return;
    grid.relayout(newSize);
}

export {
    initGallery,
    syncGallery,
    ensureImageVisible,
    alignImageOnExit,
    refreshThumbnailInGallery,
    refreshAfterIncremental,
    forceRelayout,
    getThumbnailUrl
};

function getThumbnailUrl(pathCanon) {
    return thumbnailCache.get(pathCanon);
}
