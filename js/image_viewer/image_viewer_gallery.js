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
 */

import "../aih_strings.js";
import { imageViewerState } from "./image_viewer_state.js";
import { HolafFetch } from "../vendor/holaf/holaf-fetch.js";
import { HolafThumbCache } from "../vendor/holaf/holaf-thumbcache.js";
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
const SCROLLBAR_DEBOUNCE_MS = 50;
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
    // 202 : garder le placeholder gris (state "pending") au lieu d'une image cassée.
    onPending: (image) => {
        const ph = renderedPlaceholders.get(image.path_canon);
        if (ph && ph.isConnected) ph.dataset.thumbnailLoadingOrLoaded = "pending";
    },
    // Les échecs terminaux sont gérés PAR REQUÊTE (overlay sur le placeholder)
    // dans fetchThumbnail() ; onError n'est qu'un filet de sécurité.
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
let gallerySizerEl = null;
let galleryGridEl = null;
let resizeObserver = null;
let renderedPlaceholders = new Map(); // path_canon -> DOM Element
let scrollbarDebounceTimeout = null;
let renderedSkeletons = new Map();   // index -> DOM skeleton
const skeletonPool = [];
const SKELETON_POOL_MAX = 200;
let windowFetchDebounceTimer = null;
const WINDOW_FETCH_DEBOUNCE_MS = 200;

// Track hover timeouts for video preview race condition prevention
const hoverTimeouts = new Map();

let isWheelScrolling = false;
let wheelScrollTimeout = null;

// --- UNLOADED TRACKING: O(1) lookup for next thumbnail to fetch ---
const unloadedVisiblePaths = new Set(); // path_canon of visible items not yet loaded

// --- LOAD QUEUE ---
// Simple kick-based scheduler : on enfile les vignettes visibles unloaded et on
// laisse la brique holaf-thumbcache faire le reste (concurrence/dédup/retries).
let kickQueued = false;
let idleRestartTimer = null;

let columnCount = 0;
let itemWidth = 0;
let itemHeight = 0;
let gap = 0;
let renderRequestID = null;

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
    if (viewerInstance) {
        // Cancel everything current
        thumbCache.abort();
        unloadedVisiblePaths.clear();

        // Clear DOM to force re-render
        galleryGridEl.innerHTML = '';
        placeholderPool.length = 0; // Clear pool on benchmark reset
        renderedPlaceholders.clear();

        // 3. Start Timer and Trigger Render
        setTimeout(() => {
            const visibleCount = getVisibleItemCount();
            console.log(`📸 Target: Loading ${visibleCount} visible images from scratch...`);
            benchmarkTotalItems = visibleCount;
            benchmarkStartTime = performance.now();

            // Force re-layout and load
            renderVisibleItems();
        }, 100);
    } else {
        console.error("Gallery not initialized. Open the Image Viewer first.");
    }
};

function getVisibleItemCount() {
    if (!galleryEl) return 0;
    const viewportHeight = galleryEl.clientHeight;
    // Estimate based on layout
    const itemHeightWithGap = itemHeight + gap;
    const rowsVisible = Math.ceil(viewportHeight / itemHeightWithGap) + 1; // +1 buffer
    return Math.min(rowsVisible * columnCount, imageViewerState.getState().images.length);
}

function checkBenchmarkCompletion() {
    if (!isBenchmarking) return;

    // Rien en vol / en file / planifié → benchmark terminé
    if (thumbCache.stats().pending === 0) {
        // Double check: are all visible placeholders actually loaded?
        const visiblePlaceholders = Array.from(galleryGridEl.children);
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

function handleResize() {
    const { images } = imageViewerState.getState();
    if (!images || images.length === 0 || !galleryEl) return;

    const oldItemHeightWithGap = itemHeight + gap;

    let topVisibleIndex = 0;
    if (oldItemHeightWithGap > 0 && columnCount > 0) {
        const topRow = Math.floor(galleryEl.scrollTop / oldItemHeightWithGap);
        topVisibleIndex = topRow * columnCount;
    }

    updateLayout(false);

    if (topVisibleIndex > 0 && columnCount > 0) {
        const newTopRow = Math.floor(topVisibleIndex / columnCount);
        const newScrollTop = newTopRow * (itemHeight + gap);
        galleryEl.scrollTop = newScrollTop;
    }

    renderVisibleItems(true);
}

function updateLayout(renderAfter = true, overrideThumbSize = null) {
    if (!galleryEl || !viewerInstance) return;

    const targetThumbSize = overrideThumbSize !== null ? overrideThumbSize : imageViewerState.getState().ui.thumbnail_size;

    const containerWidth = galleryEl.clientWidth;
    const style = window.getComputedStyle(galleryGridEl);
    gap = parseFloat(style.getPropertyValue('gap')) || 8;

    columnCount = Math.max(1, Math.floor((containerWidth + gap) / (targetThumbSize + gap)));
    const totalGapWidth = (columnCount - 1) * gap;
    itemWidth = (containerWidth - totalGapWidth) / columnCount;
    itemHeight = itemWidth;

    const state = imageViewerState.getState();
    const totalCount = (state.totalCount != null && state.totalCount > 0) ? state.totalCount : (state.images ? state.images.length : 0);
    const rowCount = Math.ceil(totalCount / columnCount);
    const totalHeight = rowCount * (itemHeight + gap);
    gallerySizerEl.style.height = `${totalHeight}px`;

    if (renderAfter) {
        renderVisibleItems(true);
    }
}

function renderVisibleItems() {
    if (renderRequestID) {
        cancelAnimationFrame(renderRequestID);
    }

    renderRequestID = requestAnimationFrame(() => {
        renderRequestID = null;

        if (columnCount === 0) return;
        const state = imageViewerState.getState();
        const { images, activeImage, selectedPaths } = state;
        const totalCount = (state.totalCount != null && state.totalCount > 0) ? state.totalCount : (images ? images.length : 0);

        if (!totalCount || !galleryEl || !galleryGridEl || itemHeight === 0) {
            return;
        }

        const viewportHeight = galleryEl.clientHeight;
        const scrollTop = galleryEl.scrollTop;

        // Increased buffer to smooth out fast scrolling
        const buffer = viewportHeight * 1.5;
        const visibleAreaStart = Math.max(0, scrollTop - buffer);
        const visibleAreaEnd = scrollTop + viewportHeight + buffer;

        const itemHeightWithGap = itemHeight + gap;
        const startRow = Math.max(0, Math.floor(visibleAreaStart / itemHeightWithGap));
        const endRow = Math.ceil(visibleAreaEnd / itemHeightWithGap);

        const startIndex = startRow * columnCount;
        const endIndex = Math.min(totalCount - 1, (endRow * columnCount) + columnCount - 1);

        const newPlaceholdersToRender = new Map();
        const newSkeletons = new Map();
        const fragment = document.createDocumentFragment();
        const renderStart = performance.now();

        for (let i = startIndex; i <= endIndex; i++) {
            const image = getImageAt(state, i);
            if (!image) {
                let sk;
                if (renderedSkeletons.has(i)) {
                    sk = renderedSkeletons.get(i);
                    renderedSkeletons.delete(i);
                } else {
                    sk = acquireSkeleton(i);
                    fragment.appendChild(sk);
                }

                const row = Math.floor(i / columnCount);
                const col = i % columnCount;
                const top = row * itemHeightWithGap;
                const left = col * (itemWidth + gap);

                const transformVal = `translate(${left}px, ${top}px)`;
                if (sk.style.transform !== transformVal) {
                    sk.style.transform = transformVal;
                }
                sk.style.width = `${itemWidth}px`;
                sk.style.height = `${itemHeight}px`;

                newSkeletons.set(i, sk);
                continue;
            }

            const path = image.path_canon;
            let placeholder;

            if (renderedPlaceholders.has(path)) {
                placeholder = renderedPlaceholders.get(path);
                // FIX: Update index in case the images array order changed (e.g. after filter)
                placeholder.dataset.index = i;
                renderedPlaceholders.delete(path);
            } else {
                placeholder = acquirePlaceholder(viewerInstance, image, i);
                fragment.appendChild(placeholder);
                // Try to load immediately from Cache
                applyCachedThumbnail(placeholder, path);
            }

            const row = Math.floor(i / columnCount);
            const col = i % columnCount;
            const top = row * itemHeightWithGap;
            const left = col * (itemWidth + gap);

            const transformVal = `translate(${left}px, ${top}px)`;
            if (placeholder.style.transform !== transformVal) {
                placeholder.style.transform = transformVal;
            }

            placeholder.style.width = `${itemWidth}px`;
            placeholder.style.height = `${itemHeight}px`;

            placeholder.classList.toggle('active', activeImage && activeImage.path_canon === path);
            const isSelected = selectedPaths.has(path);
            placeholder._checkbox.checked = isSelected;

            newPlaceholdersToRender.set(path, placeholder);

            // Track unloaded thumbnails for O(1) queue lookup
            if (!placeholder.dataset.thumbnailLoadingOrLoaded) {
                unloadedVisiblePaths.add(path);
            }
        }

        // Cleanup: remove placeholders leaving the viewport
        // Do NOT abort in-flight fetches — let them complete and cache (LRU).
        for (const [path, element] of renderedPlaceholders) {
            if (hoverTimeouts.has(path)) {
                clearTimeout(hoverTimeouts.get(path));
                hoverTimeouts.delete(path);
            }
            releasePlaceholder(element);
            unloadedVisiblePaths.delete(path);
        }

        // Cleanup: remove skeletons leaving the viewport
        for (const sk of renderedSkeletons.values()) {
            releaseSkeleton(sk);
        }

        if (fragment.childElementCount > 0) {
            galleryGridEl.appendChild(fragment);
        }

        renderedPlaceholders = newPlaceholdersToRender;
        renderedSkeletons = newSkeletons;

        // --- Backend priority queue: collect currently VISIBLE thumbnails ---
        // (debounced ~300ms, fire-and-forget). This tells the backend to generate
        // these thumbnails first (thumbnail_status=1). Only uncached, not-in-flight
        // items are queued so we don't waste the request. Le débounce + le flush
        // anticipé sont tenus par la brique (onVisible).
        {
            const viewportStartRow = Math.max(0, Math.floor(scrollTop / itemHeightWithGap));
            const viewportEndRow = Math.ceil((scrollTop + viewportHeight) / itemHeightWithGap);
            const priorityStart = viewportStartRow * columnCount;
            const priorityEnd = Math.min(totalCount - 1, (viewportEndRow * columnCount) + columnCount - 1);
            const visibleIds = [];
            for (let i = priorityStart; i <= priorityEnd; i++) {
                const img = getImageAt(state, i);
                if (!img) continue;
                const pathCanon = img.path_canon;
                if (!thumbCache.has(pathCanon) && !thumbCache.isLoading(pathCanon)) {
                    visibleIds.push(pathCanon);
                }
            }
            if (visibleIds.length > 0) thumbCache.onVisible(visibleIds);
        }

        // Fetch any not-yet-loaded window visible in the current range
        scheduleEnsureRange(startIndex, endIndex);

        // Kick off loading immediately — don't debounce on render frame
        // (debounced for trackpad scrolling)
        debouncedKickLoadQueue();

        const renderMs = performance.now() - renderStart;
        if (renderMs > 100) {
            console.log("[Holaf Perf] renderVisibleItems total_ms=" + renderMs.toFixed(1));
        }
    });
}

function applyCachedThumbnail(placeholder, pathCanon) {
    const cachedUrl = thumbnailCache.get(pathCanon);
    if (cachedUrl) {
        const img = document.createElement('img');
        img.className = "holaf-image-viewer-thumbnail";
        img.src = cachedUrl;

        // --- FIX: REMOVED forced JS style for images. CSS classes handle it. ---
        img.style.objectFit = '';

        img.onload = () => {
            addFullscreenIcon(placeholder, imageViewerState.getState().images[parseInt(placeholder.dataset.index)]);
        };

        const oldImg = placeholder.querySelector('img');
        if (oldImg) oldImg.remove();

        placeholder.prepend(img);
        placeholder.dataset.thumbnailLoadingOrLoaded = "true";
        unloadedVisiblePaths.delete(pathCanon);
        return true;
    }
    return false;
}

function addFullscreenIcon(placeholder, image) {
    if (!placeholder.querySelector('.holaf-viewer-fullscreen-icon')) {
        const fsIcon = document.createElement('div');
        fsIcon.className = 'holaf-viewer-fullscreen-icon';
        fsIcon.innerHTML = '⛶';
        fsIcon.title = t('iv.viewFullscreen');
        // Click handled via delegation on galleryGridEl
        placeholder.appendChild(fsIcon);
    }
}

function kickLoadQueue() {
    if (kickQueued) return;
    kickQueued = true;
    queueMicrotask(_doKick);
}

function _doKick() {
    kickQueued = false;
    clearTimeout(idleRestartTimer);

    // Phase 1: enqueue les vignettes VISIBLES non chargées. La concurrence, la
    // dédup in-flight, le yield des cache-hits, le timeout/retries et le
    // protocole 202 sont tenus par la brique holaf-thumbcache. On borne juste le
    // nombre de placeholders traités par tick (chaque hit cache fait un
    // createElement + prepend) pour ne pas figer l'UI en cas de gros lot.
    const MAX_PER_TICK = 40;
    let processed = 0;

    for (const pathCanon of [...unloadedVisiblePaths]) {
        const placeholder = renderedPlaceholders.get(pathCanon);
        if (!placeholder || !placeholder.isConnected) {
            unloadedVisiblePaths.delete(pathCanon);
            continue;
        }
        if (placeholder.dataset.thumbnailLoadingOrLoaded) continue;

        const imageIndex = parseInt(placeholder.dataset.index, 10);
        const image = imageViewerState.getState().images[imageIndex];
        if (!image) continue;

        fetchThumbnail(placeholder, image, false);
        processed++;
        if (processed >= MAX_PER_TICK) {
            // Yield to main thread, resume on next tick.
            setTimeout(kickLoadQueue, 0);
            break;
        }
    }

    // Phase 2: Prefetch thumbnails ahead of viewport into cache (no DOM)
    _prefetchAhead();

    // Safety net : des placeholders peuvent rester sans état après une
    // annulation (syncGallery) ; re-kick une fois la file au repos.
    if (thumbCache.stats().active === 0 && unloadedVisiblePaths.size > 0) {
        idleRestartTimer = setTimeout(() => {
            const children = galleryGridEl.children;
            for (let i = 0; i < children.length; i++) {
                if (!children[i].dataset.thumbnailLoadingOrLoaded) {
                    kickLoadQueue();
                    return;
                }
            }
        }, 200);
    }
}

function _prefetchAhead() {
    if (!galleryEl || !galleryGridEl || columnCount === 0 || itemHeight === 0) return;

    const { images } = imageViewerState.getState();
    if (!images || !images.length) return;

    const viewportHeight = galleryEl.clientHeight;
    const scrollTop = galleryEl.scrollTop;
    const itemHeightWithGap = itemHeight + gap;

    // Calculate visible range
    const buffer = viewportHeight * 1.5;
    const visibleAreaEnd = scrollTop + viewportHeight + buffer;
    const endRow = Math.ceil(visibleAreaEnd / itemHeightWithGap);

    // Prefetch zone: PREFETCH_ROWS beyond visible
    const prefetchStartIndex = endRow * columnCount;
    const prefetchEndIndex = Math.min(images.length - 1, prefetchStartIndex + (PREFETCH_ROWS * columnCount) - 1);

    // On n'enfile le prefetch que s'il reste des slots libres (même throttle que
    // l'ancien code) ; la brique ordonne de toute façon le prefetch APRÈS le visible.
    let slots = currentConcurrencyLimit - thumbCache.stats().active;
    const toPrefetch = [];
    for (let i = prefetchStartIndex; i <= prefetchEndIndex && slots > 0; i++) {
        const image = images[i];
        if (!image) continue;
        const pathCanon = image.path_canon;

        // Skip if already cached, loading, or handled by the visible queue
        if (thumbCache.has(pathCanon)) continue;
        if (thumbCache.isLoading(pathCanon)) continue;
        if (renderedPlaceholders.has(pathCanon)) continue;

        toPrefetch.push(image);
        slots--;
    }
    if (toPrefetch.length > 0) {
        thumbCache.prefetch(toPrefetch).then(() => {
            if (isBenchmarking) checkBenchmarkCompletion();
        });
    }
}

function debouncedKickLoadQueue() {
    clearTimeout(scrollbarDebounceTimeout);
    scrollbarDebounceTimeout = setTimeout(kickLoadQueue, isBenchmarking ? 5 : 30);
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

// --- Thumbnail render (adaptateur brique → DOM) ---
// La brique holaf-thumbcache tient le cache, la concurrence, la dédup in-flight,
// le timeout + retries bornés et le protocole 202 + Retry-After. Ici on ne fait
// que : demander la vignette (request haute priorité), dessiner le <img> au
// succès, poser l'overlay d'erreur à l'échec terminal, nettoyer sur annulation.
function isAbortError(err) {
    return !!err && (err.name === 'AbortError' || err.aborted === true);
}


function fetchThumbnail(placeholder, image, forceReload = false) {
    const pathCanon = image.path_canon;

    // Force reload (édition d'image) : purge la valeur cachée puis recharge (le
    // paramètre `t` est ajouté par buildThumbnailUrl via `_forceReload`).
    if (forceReload) thumbCache.invalidate(pathCanon);

    // Flag as loading to prevent duplicate queueing
    placeholder.dataset.thumbnailLoadingOrLoaded = "loading";

    // Visual feedback for loading (optional: could be a spinner)
    placeholder.classList.remove('error');
    const existingError = placeholder.querySelector('.holaf-viewer-error-overlay');
    if (existingError) existingError.remove();

    const item = forceReload ? { ...image, _forceReload: true } : image;

    return thumbCache.request(item, HolafThumbCache.PRIORITY_HIGH).then((objectURL) => {
        if (!placeholder.isConnected) {
            // Placeholder évincé : la vignette est en cache, le prochain rendu la
            // reprendra via applyCachedThumbnail. Rien à dessiner ici.
            return;
        }
        const img = document.createElement('img');
        img.className = "holaf-image-viewer-thumbnail";
        img.src = objectURL;
        // --- FIX: REMOVED forced JS style for images. CSS classes handle it. ---
        img.style.objectFit = '';

        img.onload = () => {
            addFullscreenIcon(placeholder, image);
        };

        const oldImg = placeholder.querySelector('img');
        if (oldImg) oldImg.remove();

        // If a video preview is currently playing, we put the img behind it or hide it
        // But simplified logic: just prepend.
        placeholder.prepend(img);
        placeholder.dataset.thumbnailLoadingOrLoaded = "true";
        unloadedVisiblePaths.delete(pathCanon);
    }).catch((err) => {
        if (isAbortError(err)) {
            // Annulation (syncGallery) : le blob n'est pas caché ; on rend l'item
            // à la file pour qu'il soit rechargé quand il revient à l'écran.
            if (placeholder.isConnected) delete placeholder.dataset.thumbnailLoadingOrLoaded;
            return;
        }
        // Échec terminal (timeout après retries bornés, HTTP non-2xx, réseau).
        if (!placeholder.isConnected) return;
        placeholder.classList.add('error');
        placeholder.dataset.thumbnailLoadingOrLoaded = "error";
        unloadedVisiblePaths.delete(pathCanon);
        const errorDiv = document.createElement('div');
        errorDiv.className = 'holaf-viewer-error-overlay';
        errorDiv.textContent = (err && err.timedOut) ? t('iv.timeout') : t('iv.err');
        placeholder.appendChild(errorDiv);
    }).finally(() => {
        if (isBenchmarking) checkBenchmarkCompletion();
    });
}

// --- Placeholder Object Pool ---
// Reuse placeholder divs instead of creating/destroying on every scroll.
// This avoids createElement/GC overhead and keeps the checkbox ref cached.
const placeholderPool = [];
const POOL_MAX_SIZE = 200;

function acquirePlaceholder(viewer, image, index) {
    let placeholder;
    const isVideo = ['MP4', 'WEBM', 'MKV', 'AVI', 'MOV', 'M4V'].includes(image.format);
    const isAudio = ['WAV', 'MP3', 'OGG', 'FLAC', 'AAC', 'M4A'].includes(image.format);

    if (placeholderPool.length > 0) {
        // Recycle from pool
        placeholder = placeholderPool.pop();

        // Update data attributes
        placeholder.dataset.index = index;
        placeholder.dataset.pathCanon = image.path_canon;

        // Reset visual state
        placeholder.classList.remove('active', 'error');
        placeholder._checkbox.checked = false;
        placeholder._hoverGeneration = 0;

        // Remove leftover dynamic children (img, video, error overlays)
        const oldImg = placeholder.querySelector('img');
        if (oldImg) oldImg.remove();
        const oldVideo = placeholder.querySelector('video.holaf-hover-preview');
        if (oldVideo) { oldVideo.pause(); oldVideo.src = ""; oldVideo.remove(); }
        const oldError = placeholder.querySelector('.holaf-viewer-error-overlay');
        if (oldError) oldError.remove();
        const oldFsIcon = placeholder.querySelector('.holaf-viewer-fullscreen-icon');
        if (oldFsIcon) oldFsIcon.remove();

        // Reset thumbnail loading state
        delete placeholder.dataset.thumbnailLoadingOrLoaded;

        // Update action icon
        const actionIcon = placeholder._actionIcon;
        actionIcon.classList.remove('active');
        if (isVideo) {
            actionIcon.innerHTML = '🎥';
            actionIcon.title = t('iv.playVideo');
            if (image.has_edit_file) actionIcon.classList.add('active');
        } else if (isAudio) {
            actionIcon.innerHTML = '\uD83C\uDFB5';
            actionIcon.title = t('iv.playAudio');
            if (image.has_edit_file) actionIcon.classList.add('active');
        } else {
            actionIcon.innerHTML = '✎';
            actionIcon.title = t('iv.editImage');
            if (image.has_edit_file) actionIcon.classList.add('active');
        }

        // Remove old hover listeners if this was a video placeholder
        if (placeholder._hoverCleanup) {
            placeholder._hoverCleanup();
            placeholder._hoverCleanup = null;
        }

        // Add new hover listeners for videos
        if (isVideo) {
            placeholder._hoverCleanup = attachVideoHoverListeners(placeholder, image);
        }

    } else {
        // Create new placeholder
        placeholder = document.createElement('div');
        placeholder.className = 'holaf-viewer-thumbnail-placeholder';
        placeholder.style.position = 'absolute';
        placeholder.dataset.index = index;
        placeholder.dataset.pathCanon = image.path_canon;

        const actionIcon = document.createElement('div');
        actionIcon.className = 'holaf-viewer-edit-icon';
        placeholder._actionIcon = actionIcon;

        if (isVideo) {
            actionIcon.innerHTML = '🎥';
            actionIcon.title = t('iv.playVideo');
            if (image.has_edit_file) actionIcon.classList.add('active');
            placeholder._hoverCleanup = attachVideoHoverListeners(placeholder, image);
        } else if (isAudio) {
            actionIcon.innerHTML = '\uD83C\uDFB5';
            actionIcon.title = t('iv.playAudio');
            if (image.has_edit_file) actionIcon.classList.add('active');
        } else {
            actionIcon.innerHTML = '✎';
            actionIcon.title = t('iv.editImage');
            if (image.has_edit_file) actionIcon.classList.add('active');
        }
        placeholder.appendChild(actionIcon);

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'holaf-viewer-thumb-checkbox';
        checkbox.title = t('iv.selectImage');
        placeholder._checkbox = checkbox;
        placeholder.appendChild(checkbox);
    }

    return placeholder;
}

function releasePlaceholder(placeholder) {
    // Clean up hover listeners for videos
    if (placeholder._hoverCleanup) {
        placeholder._hoverCleanup();
        placeholder._hoverCleanup = null;
    }

    // Stoppe un éventuel retry « pending » (202) : inutile de continuer à
    // réclamer une vignette qui vient de quitter la vue. Un chargement DÉJÀ en
    // vol n'est pas interrompu — il aboutira et remplira le cache.
    const releasedPath = placeholder.dataset.pathCanon;
    if (releasedPath) thumbCache.cancel(releasedPath);

    // Remove from DOM
    if (placeholder.parentNode) {
        placeholder.parentNode.removeChild(placeholder);
    }

    // Return to pool if not too large
    if (placeholderPool.length < POOL_MAX_SIZE) {
        // Clean up dynamic children for pool hygiene
        const img = placeholder.querySelector('img');
        if (img) img.remove();
        const vid = placeholder.querySelector('video.holaf-hover-preview');
        if (vid) { vid.pause(); vid.src = ""; vid.remove(); }
        const err = placeholder.querySelector('.holaf-viewer-error-overlay');
        if (err) err.remove();
        const fs = placeholder.querySelector('.holaf-viewer-fullscreen-icon');
        if (fs) fs.remove();

        // Reset state
        placeholder.classList.remove('active', 'error');
        placeholder._checkbox.checked = false;
        placeholder._hoverGeneration = 0;
        delete placeholder.dataset.thumbnailLoadingOrLoaded;

        placeholderPool.push(placeholder);
    } else {
        // Pool is full, let GC collect
    }
}

function acquireSkeleton(index) {
    let sk;
    if (skeletonPool.length > 0) sk = skeletonPool.pop();
    else {
        sk = document.createElement('div');
        sk.className = 'holaf-viewer-thumbnail-placeholder holaf-viewer-skeleton';
        sk.style.position = 'absolute';
    }
    sk.dataset.index = index;
    return sk;
}

function releaseSkeleton(sk) {
    if (sk.parentNode) sk.parentNode.removeChild(sk);
    if (skeletonPool.length < SKELETON_POOL_MAX) skeletonPool.push(sk);
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
// --- Functions to be exported ---

function initGallery(viewer) {
    viewerInstance = viewer;
    galleryEl = document.getElementById("holaf-viewer-gallery");

    document.addEventListener('holaf-refresh-thumbnail', (e) => {
        const { path_canon } = e.detail;
        if (path_canon) refreshThumbnailInGallery(path_canon);
    });

    galleryEl.innerHTML = `
        <div id="holaf-gallery-sizer" style="position: relative; width: 100%; height: 0; pointer-events: none;"></div>
        <div id="holaf-gallery-grid" style="position: absolute; top: 0; left: 0; width: 100%;"></div>
    `;
    gallerySizerEl = document.getElementById("holaf-gallery-sizer");
    galleryGridEl = document.getElementById("holaf-gallery-grid");

    // --- Event Delegation: single listeners on galleryGridEl instead of per-item ---
    galleryGridEl.addEventListener('click', (e) => {
        const placeholder = e.target.closest('.holaf-viewer-thumbnail-placeholder');
        if (!placeholder) return;

        const idx = parseInt(placeholder.dataset.index, 10);
        const img = imageViewerState.getState().images[idx];

        // Fullscreen icon delegates to fullscreen view
        if (e.target.closest('.holaf-viewer-fullscreen-icon')) {
            e.stopPropagation();
            if (img) {
                imageViewerState.setState({ activeImage: img, currentNavIndex: idx });
                showFullscreenView(viewerInstance, img);
            }
            return;
        }

        // Edit icon delegates to zoomed view
        if (e.target.closest('.holaf-viewer-edit-icon')) {
            e.stopPropagation();
            if (img) {
                imageViewerState.setState({ activeImage: img, currentNavIndex: idx });
                viewerInstance._showZoomedView(img);
            }
            return;
        }

        const state = imageViewerState.getState();
        const clickedIndex = parseInt(placeholder.dataset.index, 10);
        if (isNaN(clickedIndex)) return;
        const clickedImageData = getImageAt(state, clickedIndex);
        if (!clickedImageData) return;
        const anchorIndex = state.currentNavIndex > -1 ? state.currentNavIndex : clickedIndex;
        const selectedPaths = new Set(state.selectedPaths); // Copy for mutation
        if (e.shiftKey) {
            if (!e.ctrlKey) selectedPaths.clear();
            const start = Math.min(anchorIndex, clickedIndex);
            const end = Math.max(anchorIndex, clickedIndex);
            for (let i = start; i <= end; i++) {
                const img = getImageAt(state, i);
                if (img) selectedPaths.add(img.path_canon);
            }
        } else if (e.ctrlKey || e.target.tagName === 'INPUT') {
            if (selectedPaths.has(clickedImageData.path_canon)) {
                selectedPaths.delete(clickedImageData.path_canon);
            } else {
                selectedPaths.add(clickedImageData.path_canon);
            }
        } else {
            selectedPaths.clear();
            selectedPaths.add(clickedImageData.path_canon);
        }
        const newSelectedImages = new Set();
        forEachLoadedImage(state, (img) => {
            if (selectedPaths.has(img.path_canon)) newSelectedImages.add(img);
        });
        imageViewerState.setState({ selectedImages: newSelectedImages, activeImage: clickedImageData, currentNavIndex: clickedIndex });
        renderVisibleItems();
        viewerInstance._updateActionButtonsState();
    });

    galleryGridEl.addEventListener('dblclick', (e) => {
        if (e.target.closest('.holaf-viewer-edit-icon, .holaf-viewer-fullscreen-icon, .holaf-viewer-thumb-checkbox')) return;
        const placeholder = e.target.closest('.holaf-viewer-thumbnail-placeholder');
        if (!placeholder) return;
        const idx = parseInt(placeholder.dataset.index, 10);
        const img = imageViewerState.getState().images[idx];
        if (img) {
            imageViewerState.setState({ activeImage: img, currentNavIndex: idx });
            viewerInstance._showZoomedView(img);
        }
    });

    resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(galleryEl);

    galleryEl.addEventListener('wheel', () => {
        isWheelScrolling = true;
        clearTimeout(wheelScrollTimeout);
        wheelScrollTimeout = setTimeout(() => { isWheelScrolling = false; }, 300);
    }, { passive: true });

    galleryEl.addEventListener('scroll', () => {
        renderVisibleItems();
        if (isWheelScrolling) {
            kickLoadQueue();
        } else {
            debouncedKickLoadQueue();
        }


    }, { passive: true });

    viewer.gallery = {
        ensureImageVisible,
        alignImageOnExit,
        refreshThumbnail: refreshThumbnailInGallery,
        render: renderVisibleItems,
        getColumnCount: () => columnCount,
        jumpToOldest,
        jumpToNewest,
        ensureImageLoaded
    };
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
        const emptyMsg = galleryGridEl.querySelector('.holaf-viewer-empty-message');
        if (emptyMsg) emptyMsg.remove();
        updateLayout(true);
        return;
    }

    // Full rebuild (image list actually changed)
    // Stoppe les chargements en vol + les retries planifiés (la brique rejette
    // les promesses concernées ; fetchThumbnail nettoie l'état des placeholders).
    thumbCache.abort();
    unloadedVisiblePaths.clear();
    resetWindowCache();

    // Keep LRU Cache alive! Don't clear it — thumbnails are still valid.
    // thumbnailCache.clear();

    if (galleryGridEl) {
        // Use textContent instead of removeChild loop for faster bulk removal
        galleryGridEl.textContent = '';
    }
    renderedPlaceholders.clear();
    placeholderPool.length = 0; // Clear pool on full rebuild

    const messageEl = galleryEl.querySelector('.holaf-viewer-message');
    if (messageEl) messageEl.remove();

    if (images && images.length > 0) {
        galleryEl.scrollTop = 0;
        updateLayout(true);
    } else {
        gallerySizerEl.style.height = '300px';
        const placeholder = document.createElement('div');
        placeholder.className = 'holaf-viewer-thumbnail-placeholder holaf-viewer-empty-message';
        placeholder.style.cssText = `position: absolute; top: 8px; left: 8px; right: 8px; height: 200px; display: flex; align-items: center; justify-content: center; text-align: center; padding: 20px; box-sizing: border-box; border: 2px dashed var(--holaf-border-color); border-radius: var(--holaf-border-radius); color: var(--holaf-text-color-secondary);`;
        placeholder.textContent = t('iv.noImagesMatch');
        galleryGridEl.appendChild(placeholder);
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
    if (!galleryEl || !galleryGridEl) return;

    const state = imageViewerState.getState();
    const total = (state.totalCount != null && state.totalCount > 0)
        ? state.totalCount
        : (state.images ? state.images.length : 0);
    if (!total || !galleryGridEl) return;

    // Going from an empty result back to a populated one must drop the placeholder.
    const emptyMsg = galleryGridEl.querySelector('.holaf-viewer-empty-message');
    if (emptyMsg) emptyMsg.remove();

    updateLayout(true);
}

function refreshThumbnailInGallery(path_canon) {
    const placeholder = renderedPlaceholders.get(path_canon);
    if (!placeholder) return;
    const allImages = imageViewerState.getState().images;
    const image = allImages.find(img => img.path_canon === path_canon);
    if (!image) return;

    const editIcon = placeholder.querySelector('.holaf-viewer-edit-icon');
    if (editIcon) editIcon.classList.add('active');

    fetchThumbnail(placeholder, image, true);
}

function ensureImageVisible(imageIndex) {
    if (!galleryEl || imageIndex < 0) return;
    renderVisibleItems();
    setTimeout(() => {
        const targetElement = galleryGridEl.querySelector(`[data-index="${imageIndex}"]`);
        if (targetElement) {
            targetElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else {
            if (columnCount <= 0 || itemHeight === 0) return;
            const targetRow = Math.floor(imageIndex / columnCount);
            galleryEl.scrollTop = targetRow * (itemHeight + gap);
            renderVisibleItems();
        }
    }, 50);
}

function alignImageOnExit(imageIndex) {
    if (!galleryEl || imageIndex < 0) return;
    renderVisibleItems();
    setTimeout(() => {
        const targetElement = galleryGridEl.querySelector(`[data-index="${imageIndex}"]`);
        if (targetElement) {
            const rect = targetElement.getBoundingClientRect();
            const galleryRect = galleryEl.getBoundingClientRect();
            const isVisible = rect.top >= galleryRect.top && rect.bottom <= galleryRect.bottom;
            if (isVisible) return;
            if (rect.top < galleryRect.top) targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
            else targetElement.scrollIntoView({ behavior: 'smooth', block: 'end' });
        } else {
            if (columnCount <= 0 || itemHeight === 0) return;
            const targetRow = Math.floor(imageIndex / columnCount);
            galleryEl.scrollTop = targetRow * (itemHeight + gap);
            renderVisibleItems();
        }
    }, 50);
}

function jumpToOldest() {
    if (!galleryEl || columnCount <= 0 || itemHeight === 0) return;
    const state = imageViewerState.getState();
    const total = (state.totalCount != null && state.totalCount > 0) ? state.totalCount : state.images.length;
    const rowCount = Math.ceil(total / columnCount);
    galleryEl.scrollTop = rowCount * (itemHeight + gap);
    renderVisibleItems();
}

function jumpToNewest() {
    if (!galleryEl) return;
    galleryEl.scrollTop = 0;
    renderVisibleItems();
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
    if (!galleryEl) return;
    updateLayout(true, newSize);
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