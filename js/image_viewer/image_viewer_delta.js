/*
 * Copyright (C) 2025 Holaf
 * Holaf Utilities - Image Viewer incremental delta reconciliation.
 *
 * Extracted from the periodic refresh (holaf_image_viewer.js#checkForUpdates) so
 * the "new / removed images" path is unit-testable without booting the whole
 * panel and its canvas/editor dependencies.
 *
 * RULE: a small delta must NOT trigger a full loadFilteredImages() (which calls
 * resetWindowCache and re-fetches every visible thumbnail). Only the deltas that
 * cannot be reconciled in place — a mass removal, or a removal of an image that
 * is not currently in memory — fall back to a full reload. Filter changes and
 * the initial load are handled by the caller and keep doing a full reload.
 */

// Above this many removals in a single delta, patching indices is not worth it
// (and is the signature of a bulk delete / trash empty) → full reload.
export const MASS_REMOVAL_THRESHOLD = 100;

/**
 * Apply an incremental delta without resetting the window cache.
 *
 * @param {{images?: Array, removed_path_canons?: Array}} delta
 * @param {object} deps
 * @param {Function} deps.getState
 * @param {Function} deps.insertImagesAtTop
 * @param {Function} deps.removeImagesByPaths
 * @param {Function} deps.loadFilteredImages - used ONLY for the fallback cases
 * @returns {Promise<{mode: string, inserted?: number, removed?: number, reason?: string}>}
 */
export async function applyIncrementalDelta(delta, deps) {
    const newImages = (delta && delta.images) || [];
    const removedPaths = (delta && delta.removed_path_canons) || [];

    if (removedPaths.length >= MASS_REMOVAL_THRESHOLD) {
        await deps.loadFilteredImages();
        return { mode: 'full-reload', reason: 'mass-removal' };
    }

    let inserted = 0;
    if (newImages.length > 0) {
        inserted = deps.insertImagesAtTop(deps.getState(), newImages);
    }

    let removed = 0;
    if (removedPaths.length > 0) {
        const result = deps.removeImagesByPaths(deps.getState(), removedPaths);
        if (result === false) {
            // Removal touched an image outside the loaded windows: its index is
            // unknown, so patching indices would corrupt the list.
            await deps.loadFilteredImages();
            return { mode: 'full-reload', reason: 'unreconcilable-removal' };
        }
        removed = result;
    }

    return { mode: 'patched', inserted, removed };
}
