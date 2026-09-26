/*
 * Copyright (C) 2025 Holaf
 * Holaf Utilities - Image Viewer incremental delta reconciliation (SHIM).
 *
 * Historiquement extrait de holaf_image_viewer.js#checkForUpdates pour rendre
 * le chemin « nouvelles / images supprimées » testable sans démarrer tout le
 * panneau. La logique vit désormais dans la brique VENDUE
 * js/vendor/holaf/holaf-collection.js (HolafCollection.applyDelta) : ce fichier
 * n'est plus qu'un ADAPTATEUR qui conserve À L'IDENTIQUE l'API publique
 * (MASS_REMOVAL_THRESHOLD + applyIncrementalDelta(delta, deps)) sans modifier
 * les call-sites.
 *
 * RÈGLE MÉTIER (inchangée) : un petit delta ne doit PAS déclencher un
 * loadFilteredImages() complet (qui reset le cache de fenêtres et redemande
 * chaque vignette). Seuls les deltas irréconciliables en place — suppression de
 * masse, ou retrait d'une image absente de la mémoire — retombent sur un
 * rechargement complet (deps.loadFilteredImages).
 */

import { HolafCollection } from '../vendor/holaf/holaf-collection.js';

// Ré-export : la brique est la source de vérité du seuil.
export const MASS_REMOVAL_THRESHOLD = HolafCollection.MASS_REMOVAL_THRESHOLD;

/**
 * Applique un delta incrémental sans réinitialiser le cache de fenêtres.
 *
 * @param {{images?: Array, removed_path_canons?: Array}} delta
 * @param {object} deps
 * @param {Function} deps.getState
 * @param {Function} deps.insertImagesAtTop
 * @param {Function} deps.removeImagesByPaths
 * @param {Function} deps.loadFilteredImages - utilisé UNIQUEMENT en fallback.
 * @returns {Promise<{mode: string, inserted?: number, removed?: number, reason?: string}>}
 */
export async function applyIncrementalDelta(delta, deps) {
    // Adapte le delta spécifique à la galerie vers le delta générique de la brique.
    const generic = {
        items: (delta && delta.images) || [],
        removedIds: (delta && delta.removed_path_canons) || [],
    };

    // La brique orchestre (seuil de masse, patch vs irréconciliable). On lui
    // injecte les callbacks historiques pour préserver l'injection de deps.
    const result = HolafCollection.applyDelta(generic, {
        insertTop: (items) => deps.insertImagesAtTop(deps.getState(), items),
        removeByIds: (ids) => deps.removeImagesByPaths(deps.getState(), ids),
    });

    if (result.mode === 'full-reload') {
        await deps.loadFilteredImages();
    }
    return result;
}
