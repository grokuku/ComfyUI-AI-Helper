export const PAGE_SIZE = 500;

const loadedRanges = new Set();      // starts de fenêtres chargées
const loadingRanges = new Map();     // start -> AbortController
const loadingPromises = new Map();   // start -> Promise

export function getWindowStart(index) {
    return Math.floor(index / PAGE_SIZE) * PAGE_SIZE;
}
export function isWindowLoaded(start) { return loadedRanges.has(start); }
export function isWindowLoading(start) { return loadingRanges.has(start); }
export function getLoadingPromise(start) { return loadingPromises.get(start) || null; }
export function registerLoading(start, controller, promise) {
    loadingRanges.set(start, controller);
    loadingPromises.set(start, promise);
}
export function unregisterLoading(start) {
    loadingRanges.delete(start);
    loadingPromises.delete(start);
}
export function setWindowLoaded(state, start, images) {
    for (let i = 0; i < images.length; i++) {
        state.images[start + i] = images[i];
    }
    state.images.length = Math.max(state.images.length, start + images.length);
    loadedRanges.add(start);
}
export function resetWindowCache() {
    for (const controller of loadingRanges.values()) controller.abort('window-reset');
    loadingRanges.clear();
    loadingPromises.clear();
    loadedRanges.clear();
}
export function getImageAt(state, index) {
    return state.images ? state.images[index] : undefined;
}
export function getMissingWindowStarts(startIndex, endIndex) {
    const starts = [];
    for (let w = getWindowStart(startIndex); w <= getWindowStart(endIndex); w += PAGE_SIZE) {
        if (!loadedRanges.has(w) && !loadingRanges.has(w)) starts.push(w);
    }
    return starts;
}
export function forEachLoadedImage(state, cb) {
    for (const start of [...loadedRanges].sort((a, b) => a - b)) {
        for (let i = start; i < Math.min(state.images.length, start + PAGE_SIZE); i++) {
            const img = state.images[i];
            if (img !== undefined) cb(img, i);
        }
    }
}

// ── Incremental delta reconciliation ────────────────────────────────────────
// The periodic refresh can receive a small delta (new images at the top,
// removed images) instead of the whole list. Patching state.images in place is
// only correct if we re-align the window cache, otherwise every index (and thus
// every visible thumbnail) would be invalidated — the exact bug this fixes.

function _abortInFlightWindowFetches() {
    for (const controller of loadingRanges.values()) controller.abort('reindex');
    loadingRanges.clear();
    loadingPromises.clear();
}

/**
 * Rebuild loadedRanges (PAGE_SIZE-aligned) from the freshly built sparse array.
 * A window is considered loaded only when ALL of its existing slots are defined
 * (i.e. backed by data we already have). Windows straddling an unknown region
 * are dropped and fetched lazily on scroll.
 */
function _rebuildLoadedRanges(images, total) {
    loadedRanges.clear();
    for (let w = 0; w < total; w += PAGE_SIZE) {
        const end = Math.min(w + PAGE_SIZE, total);
        let full = true;
        for (let i = w; i < end; i++) {
            if (images[i] === undefined) { full = false; break; }
        }
        if (full) loadedRanges.add(w);
    }
}

/**
 * Insert new images at the top of the current (possibly sparse) image array
 * WITHOUT discarding already loaded scroll windows.
 *
 * Prepending N images shifts every existing index by +N, so the previously
 * loaded windows no longer align to the new PAGE_SIZE boundaries. Instead of a
 * full reset (which would re-fetch every visible thumbnail), the loaded data is
 * re-bucketed into the new alignment and only the boundary windows that would
 * straddle an unknown region are dropped. The image array is mutated IN PLACE
 * (callers hold the singleton array reference), so no state plumbing is needed.
 *
 * @param {object} state - viewer state (exposes .images and .totalCount)
 * @param {Array<object>} newImages - images newer than the current top
 * @returns {number} number of images actually inserted (duplicates skipped)
 */
export function insertImagesAtTop(state, newImages) {
    if (!Array.isArray(newImages) || newImages.length === 0) return 0;
    if (!Array.isArray(state.images)) state.images = [];

    // Never double-insert a path we already hold in memory (loaded windows).
    const loadedPaths = new Set();
    forEachLoadedImage(state, (img) => loadedPaths.add(img.path_canon));
    const toInsert = newImages
        .filter((img) => img && img.path_canon && !loadedPaths.has(img.path_canon))
        .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    if (toInsert.length === 0) return 0;

    const n = toInsert.length;
    const oldImages = state.images;
    const oldTotal = (state.totalCount && state.totalCount > 0) ? state.totalCount : oldImages.length;
    const newTotal = oldTotal + n;

    // Snapshot the currently loaded windows (aligned starts) before rebuilding.
    const snapshots = [];
    for (const start of [...loadedRanges]) {
        const imgs = [];
        for (let i = start; i < start + PAGE_SIZE; i++) imgs.push(oldImages[i]);
        snapshots.push({ start, imgs });
    }

    // In-flight window fetches target offsets that just shifted → abort them;
    // they will be re-requested lazily if still needed.
    _abortInFlightWindowFetches();

    const shifted = new Array(newTotal);
    for (let i = 0; i < n; i++) shifted[i] = toInsert[i];
    for (const { start, imgs } of snapshots) {
        for (let k = 0; k < imgs.length; k++) {
            if (imgs[k] !== undefined) shifted[start + n + k] = imgs[k];
        }
    }

    _rebuildLoadedRanges(shifted, newTotal);

    // Copy back into the singleton's array reference (in place).
    oldImages.length = newTotal;
    for (let i = 0; i < newTotal; i++) oldImages[i] = shifted[i];

    return n;
}

/**
 * Remove images by path_canon, keeping loaded windows coherent.
 *
 * Only paths that are currently loaded can be removed safely (their index is
 * known). Returns false when a requested path is not loaded, so the caller can
 * fall back to a full reload (index math would be ambiguous otherwise).
 *
 * @returns {number|false} removed count, or false when a full reload is needed
 */
export function removeImagesByPaths(state, paths) {
    const remove = new Set((paths || []).filter(Boolean));
    if (remove.size === 0) return 0;
    if (!Array.isArray(state.images)) return 0;

    const removedIndices = [];
    const found = new Set();
    forEachLoadedImage(state, (img, idx) => {
        if (remove.has(img.path_canon)) { found.add(img.path_canon); removedIndices.push(idx); }
    });
    if (found.size !== remove.size) return false; // some path not in memory → ambiguous

    const oldImages = state.images;
    const oldTotal = (state.totalCount && state.totalCount > 0) ? state.totalCount : oldImages.length;
    const newTotal = Math.max(0, oldTotal - remove.size);
    const removedSorted = removedIndices.slice().sort((a, b) => a - b);
    const removedSet = new Set(removedSorted);
    const removedBefore = (i) => {
        let c = 0;
        for (const r of removedSorted) { if (r < i) c++; else break; }
        return c;
    };

    _abortInFlightWindowFetches();

    const next = new Array(newTotal);
    forEachLoadedImage(state, (img, i) => {
        if (removedSet.has(i)) return;
        next[i - removedBefore(i)] = img;
    });

    _rebuildLoadedRanges(next, newTotal);

    oldImages.length = newTotal;
    for (let i = 0; i < newTotal; i++) oldImages[i] = next[i];

    return remove.size;
}
