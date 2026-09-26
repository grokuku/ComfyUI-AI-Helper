/*
 * Copyright (C) 2025 Holaf
 * Holaf Utilities - Image Viewer data core (SHIM).
 *
 * Le cœur « données » (tableau creux + cache de fenêtres PAGE_SIZE-alignées +
 * réconciliation incrémentale) est désormais la brique VENDUE
 * js/vendor/holaf/holaf-collection.js (HolafCollection). Ce fichier n'est plus
 * qu'un ADAPTATEUR : il conserve À L'IDENTIQUE l'API publique historique
 * (PAGE_SIZE + les fonctions ci-dessous) pour ne toucher à AUCUN call-site
 * (holaf_image_viewer.js, image_viewer_gallery.js, image_viewer_navigation.js).
 *
 * La brique est générique : ici on la configure pour la galerie locale
 *   - pageSize : PAGE_SIZE (500)
 *   - mode     : 'window' (accès aléatoire par fenêtres)
 *   - getId    : item.path_canon (clé métier)
 *   - sortKey  : item.mtime (tri DESC pour l'insertion en tête)
 *
 * NOTE IMPORTANTE : les fonctions historiques reçoivent `state` (l'état de la
 * galerie, `{ images, totalCount }`) et mutent `state.images` PAR RÉFÉRENCE.
 * On ré-ancre donc la brique sur ce tableau à chaque appel via bindState() :
 * les mutations restent visibles côté hôte, et le cache de fenêtres partagé
 * (singleton) est préservé entre les appels, exactement comme avant.
 *
 * RÈGLE : ce fichier ne doit PAS contenir de logique de données propre — toute
 * correction se fait dans holaf-lib puis se re-vend via `scripts/holaf`.
 */

import { HolafCollection } from '../vendor/holaf/holaf-collection.js';

export const PAGE_SIZE = 500;

const collection = HolafCollection.create({
    pageSize: PAGE_SIZE,
    mode: 'window',
    getId: (item) => item && item.path_canon,
    sortKey: (item) => (item && item.mtime) || 0,
});

// Ré-ancre la brique sur l'état de l'hôte (tableau images par référence).
function _bind(state) {
    collection.bindState(state);
    return collection;
}

export function getWindowStart(index) {
    return collection.windowStart(index);
}

export function isWindowLoaded(start) { return collection.isWindowLoaded(start); }
export function isWindowLoading(start) { return collection.isWindowLoading(start); }
export function getLoadingPromise(start) { return collection.getLoadingPromise(start); }

export function registerLoading(start, controller, promise) {
    collection.registerLoading(start, controller, promise);
}
export function unregisterLoading(start) {
    collection.unregisterLoading(start);
}

export function setWindowLoaded(state, start, images) {
    _bind(state).setWindow(start, images);
}

export function resetWindowCache() {
    collection.resetWindowCache();
}

export function getImageAt(state, index) {
    return _bind(state).at(index);
}

export function getMissingWindowStarts(startIndex, endIndex) {
    return collection.missingStarts(startIndex, endIndex);
}

export function forEachLoadedImage(state, cb) {
    _bind(state).forEachLoaded(cb);
}

export function insertImagesAtTop(state, newImages) {
    return _bind(state).insertTop(newImages);
}

export function removeImagesByPaths(state, paths) {
    return _bind(state).removeByIds(paths);
}
