/*
 * Copyright (C) 2025 Holaf
 * Holaf Utilities — Image Viewer SOURCE registry (ÉTAPE 0)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RÔLE
 * ─────────────────────────────────────────────────────────────────────────────
 * Ce module introduit un CADRE « source » (registre de providers) qui servira à
 * afficher, dans la galerie du pack, soit les médias LOCAUX (dossier output du
 * serveur ComfyUI, comportement historique), soit ceux du serveur web (étape 2).
 * À l'étape 0, UNE SEULE source est enregistrée et active : 'local'. Le
 * provider local déplace/encapsule la logique existante SANS la modifier : les
 * modules hôtes l'appellent au lieu de coder les endpoints en dur. AUCUN
 * changement de comportement observable, AUCUN switch UI (étape 1).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRAT D'INTERFACE D'UN PROVIDER
 * ─────────────────────────────────────────────────────────────────────────────
 * Un provider est un objet simple (pas de classe requise). Champs/méthodes :
 *
 *   id            : string — identifiant unique ('local', plus tard 'remote').
 *   label         : string — libellé affichable (étape 1 : UI du switch).
 *   capabilities  : { edit, trash, export, extractInject, favorite,
 *                     serverDownload, pollDelta } — booléens descriptifs.
 *                   Les actions absentes (favorite/serverDownload en local) sont
 *                   exposées à `null` et l'étape 1 masquera les boutons.
 *   pageSize      : number — taille de fenêtre du tableau creux.
 *   mode          : string — mode de la collection vendue ('window').
 *   itemKey(item) : string|null — clé métier stable (path_canon en local).
 *   sortKey(item) : number — clé de tri (mtime en local).
 *
 *   createCollection()            → instance HolafCollection configurée.
 *   fetchPage({offset, limit,     → Promise<{images, total_count, ...}>.
 *              filters, signal,
 *              skipCount})
 *   fetchDelta({filters,          → Promise<{images, removed_path_canons, ...}>.
 *               minMtime, signal})
 *   fetchFilterOptions({signal})  → Promise<options filtres (subfolders…)>.
 *   fetchLastUpdateTime({signal}) → Promise<{last_update}> (poll).
 *   fetchThumbnailStats({signal}) → Promise<{generated_thumbnails_count,…}>.
 *   reportViewerActivity(active)  → Promise (heartbeat fire-and-forget).
 *   loadEdits(pathCanon, {signal})→ Promise<edits>.
 *
 *   buildThumbnailUrl(image, opts)          → string (URL de vignette).
 *   loadThumbnail(image, {signal, priority})→ Promise<Response> (raw, 202 géré
 *                                             par la brique HolafThumbCache).
 *   createThumbCache(hooks)                 → instance HolafThumbCache dédiée.
 *   prioritizeThumbnails(paths)             → Promise (fire-and-forget).
 *
 *   resolveMediaUrl(item, {signal}) → string — URL du média plein écran.
 *                                     Synchrone en local (signal ignoré : c'est
 *                                     le comportement historique). Une source
 *                                     distante pourra renvoyer une Promise.
 *   resolveInfo(item, {signal})     → Promise<métadonnées brutes>.
 *
 *   deleteImages(paths, {permanent})    → Promise<résultat> (nullable si !trash).
 *   restoreImages(paths)                → Promise<résultat> (nullable si !trash).
 *   runMetadataOperation(op, paths, {force})
 *   extractMetadata(paths, {force})     → Promise<résultat> (nullable si !extractInject).
 *   injectMetadata(paths, {force})      → Promise<résultat>.
 *   prepareExport(payload, {timeout})   → Promise<résultat> (nullable si !export).
 *   exportChunkUrl({exportId, filePath, chunkIndex, chunkSize}) → URL.
 *   fetchExportChunk({…})               → Promise<Response> (raw).
 *   emptyTrashcan()                     → Promise<résultat> (nullable si !trash).
 *
 *   favorite(paths)  → Promise (nullable : non supporté en local).
 *   download(paths)  → Promise (nullable : non supporté en local).
 *
 * ACCÈS
 *   GallerySource.active()      → provider actif (défaut 'local').
 *   GallerySource.setActive(id) → bascule (PRÉSENT mais NON appelé par l'UI à
 *                                 l'étape 0 : le switch est l'étape 1).
 *   GallerySource.register(id, provider) / has(id) / list() / unregister(id).
 */

import { HolafFetch } from '../vendor/holaf/holaf-fetch.js';
import { HolafThumbCache } from '../vendor/holaf/holaf-thumbcache.js';
import { HolafCollection } from '../vendor/holaf/holaf-collection.js';

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINTS DE LA SOURCE LOCALE
// SEUL endroit du module image_viewer/* (hors éditeur/UI, cf. note de fin) qui
// connaît les URL /holaf/images/*. Aucun autre module ne doit les coder en dur.
// ─────────────────────────────────────────────────────────────────────────────
export const LOCAL_ENDPOINTS = Object.freeze({
    list: '/holaf/images/list',
    filterOptions: '/holaf/images/filter-options',
    lastUpdateTime: '/holaf/images/last-update-time',
    thumbnailStats: '/holaf/images/thumbnail-stats',
    viewerActivity: '/holaf/images/viewer-activity',
    thumbnail: '/holaf/images/thumbnail',
    prioritizeThumbnails: '/holaf/images/prioritize-thumbnails',
    full: '/holaf/images/full',
    metadata: '/holaf/images/metadata',
    loadEdits: '/holaf/images/load-edits',
    delete: '/holaf/images/delete',
    deletePermanently: '/holaf/images/delete-permanently',
    restore: '/holaf/images/restore',
    extractMetadata: '/holaf/images/extract-metadata',
    injectMetadata: '/holaf/images/inject-metadata',
    prepareExport: '/holaf/images/prepare-export',
    exportChunk: '/holaf/images/export-chunk',
    emptyTrashcan: '/holaf/images/empty-trashcan',
});

// Paramètres historiques de la galerie locale (inchangés).
export const LOCAL_PAGE_SIZE = 500;
const LOCAL_THUMB_CACHE_CAPACITY = 2000;
const LOCAL_THUMB_TIMEOUT_MS = 30000;
const LOCAL_THUMB_MAX_TIMEOUT_RETRIES = 4;

// Cache-buster du benchmark interne (dev). Historiquement un `let` du module
// gallery ; il vit désormais dans la source (seule propriétaire de l'URL de
// vignette) et est piloté par window.holaf.runBenchmark.
let _thumbnailCacheBuster = '';

// Les filtres « internes » (état d'UI, non reconnus par le backend) ne partent
// jamais dans le corps de /holaf/images/list.
function _requestFilters(filters) {
    const payload = { ...(filters || {}) };
    delete payload.locked_folders;
    return payload;
}

// URL de vignette : /holaf/images/thumbnail?filename&subfolder&path_canon&mtime.
// mtime = thumb_hash prioritaire (cache-buster), sinon mtime de l'item.
function _buildThumbnailUrl(image, { forceReload = false, cacheBuster } = {}) {
    const imageUrl = new URL(window.location.origin);
    imageUrl.pathname = LOCAL_ENDPOINTS.thumbnail;
    let buster = image.thumb_hash ? image.thumb_hash : (image.mtime || '');
    const extra = (cacheBuster !== undefined) ? cacheBuster : _thumbnailCacheBuster;
    if (extra) buster += `_${extra}`;
    const params = {
        filename: image.filename,
        subfolder: image.subfolder,
        path_canon: image.path_canon,
        mtime: buster,
    };
    if (forceReload) params.t = new Date().getTime();
    imageUrl.search = new URLSearchParams(params);
    return imageUrl.href;
}

// URL du média plein écran : /holaf/images/full (fichier ORIGINAL, path_canon
// préféré ; filename/subfolder/type conservé en repli). mtime = cache-buster.
function _buildFullImageUrl(image) {
    if (!image) return '';
    const url = new URL(window.location.origin);
    url.pathname = LOCAL_ENDPOINTS.full;
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

// URL d'un chunk d'export : /holaf/images/export-chunk?export_id&file_path…
function _buildExportChunkUrl({ exportId, filePath, chunkIndex, chunkSize }) {
    const url = new URL(window.location.origin);
    url.pathname = LOCAL_ENDPOINTS.exportChunk;
    url.search = new URLSearchParams({
        export_id: exportId,
        file_path: filePath,
        chunk_index: chunkIndex,
        chunk_size: chunkSize,
    });
    return url;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROVIDER 'local' — reproduit À L'IDENTIQUE le comportement historique.
// ─────────────────────────────────────────────────────────────────────────────
const localSource = {
    id: 'local',
    label: 'Local',
    capabilities: Object.freeze({
        edit: true,
        trash: true,
        export: true,
        extractInject: true,
        favorite: false,        // pas de favori côté serveur local
        serverDownload: false,  // pas de téléchargement serveur en local
        pollDelta: true,
    }),
    pageSize: LOCAL_PAGE_SIZE,
    mode: 'window',
    itemKey: (item) => (item && item.path_canon) || null,
    sortKey: (item) => (item && item.mtime) || 0,

    // — Collection (tableau creux + fenêtres) configurée pour le local —
    createCollection() {
        return HolafCollection.create({
            pageSize: LOCAL_PAGE_SIZE,
            mode: 'window',
            getId: this.itemKey,
            sortKey: this.sortKey,
        });
    },

    // — Données —
    fetchPage({ offset = 0, limit = null, filters = null, signal = undefined, skipCount = false } = {}) {
        const payload = _requestFilters(filters);
        if (limit != null) {
            payload.limit = limit;
            payload.offset = offset;
        }
        if (skipCount) payload.skip_count = true;
        return HolafFetch.post(LOCAL_ENDPOINTS.list, { body: payload, signal });
    },

    fetchDelta({ filters = null, minMtime = 0, signal = undefined } = {}) {
        const payload = _requestFilters(filters);
        payload.min_mtime = minMtime;
        return HolafFetch.post(LOCAL_ENDPOINTS.list, { body: payload, signal });
    },

    fetchFilterOptions({ signal = undefined } = {}) {
        return HolafFetch.get(LOCAL_ENDPOINTS.filterOptions, { cache: 'no-store', signal });
    },

    fetchLastUpdateTime({ signal = undefined } = {}) {
        return HolafFetch.get(LOCAL_ENDPOINTS.lastUpdateTime, { cache: 'no-store', signal });
    },

    fetchThumbnailStats({ signal = undefined } = {}) {
        return HolafFetch.get(LOCAL_ENDPOINTS.thumbnailStats, { signal });
    },

    reportViewerActivity(isActive) {
        return HolafFetch.post(LOCAL_ENDPOINTS.viewerActivity, { body: { active: isActive } });
    },

    loadEdits(pathCanon, { signal = undefined } = {}) {
        return HolafFetch.get(
            `${LOCAL_ENDPOINTS.loadEdits}?path_canon=${encodeURIComponent(pathCanon)}`,
            { signal },
        );
    },

    // — Vignettes —
    buildThumbnailUrl(image, opts) {
        return _buildThumbnailUrl(image, opts);
    },

    // raw:true → la brique HolafThumbCache gère 202 + Retry-After + blob ;
    // timeout:0 → un seul garde-temps (relais du signal de l'appelant).
    loadThumbnail(image, { signal = undefined, priority = undefined } = {}) {
        return HolafFetch.get(
            _buildThumbnailUrl(image, { forceReload: !!image._forceReload }),
            {
                raw: true,
                signal,
                timeout: 0,
                priority: priority >= HolafThumbCache.PRIORITY_HIGH ? 'high' : 'low',
            },
        );
    },

    // Factory : l'instance est dédiée à la source active ; les hooks dépendants
    // du DOM de l'hôte (onPending → grille, etc.) sont injectés par l'appelant.
    createThumbCache(hooks = {}) {
        const provider = this;
        return HolafThumbCache.create({
            capacity: LOCAL_THUMB_CACHE_CAPACITY,
            strategy: 'blob',
            getId: (image) => (image && image.path_canon) || null,
            load: (image, opts) => provider.loadThumbnail(image, opts),
            retry: { max: LOCAL_THUMB_MAX_TIMEOUT_RETRIES, delayMs: 3000 },
            timeoutMs: LOCAL_THUMB_TIMEOUT_MS,
            onError: () => {},
            // Priorisation backend : la brique absorbe débounce + flush anticipé,
            // la source ne garde que le transport (POST fire-and-forget).
            onPrioritize: (paths) => { provider.prioritizeThumbnails(paths); },
            ...hooks,
        });
    },

    prioritizeThumbnails(paths) {
        return HolafFetch.post(LOCAL_ENDPOINTS.prioritizeThumbnails, { body: { paths_canon: paths } })
            .catch(() => {});
    },

    // Benchmark interne : force des URL de vignette uniques (bypass cache navigateur).
    setThumbnailCacheBuster(value) {
        _thumbnailCacheBuster = value || '';
    },

    // — Média / infos (métier) —
    resolveMediaUrl(image /*, { signal } */) {
        return _buildFullImageUrl(image);
    },

    resolveInfo(image, { signal = undefined } = {}) {
        const url = new URL(window.location.origin);
        url.pathname = LOCAL_ENDPOINTS.metadata;
        url.search = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '' });
        return HolafFetch.get(url.href, { signal, cache: 'no-store' });
    },

    // — Actions (toutes présentes en local) —
    deleteImages(paths, { permanent = false } = {}) {
        const endpoint = permanent ? LOCAL_ENDPOINTS.deletePermanently : LOCAL_ENDPOINTS.delete;
        return HolafFetch.post(endpoint, { body: { paths_canon: paths } });
    },

    restoreImages(paths) {
        return HolafFetch.post(LOCAL_ENDPOINTS.restore, { body: { paths_canon: paths } });
    },

    runMetadataOperation(operation, paths, { force = false } = {}) {
        const endpoint = operation === 'inject' ? LOCAL_ENDPOINTS.injectMetadata : LOCAL_ENDPOINTS.extractMetadata;
        return HolafFetch.post(endpoint, { body: { paths_canon: paths, force: !!force } });
    },

    extractMetadata(paths, opts) {
        return this.runMetadataOperation('extract', paths, opts);
    },

    injectMetadata(paths, opts) {
        return this.runMetadataOperation('inject', paths, opts);
    },

    prepareExport(payload, { timeout = 0 } = {}) {
        return HolafFetch.post(LOCAL_ENDPOINTS.prepareExport, { body: payload, timeout });
    },

    exportChunkUrl(opts) {
        return _buildExportChunkUrl(opts);
    },

    fetchExportChunk(opts) {
        return HolafFetch.get(_buildExportChunkUrl(opts), { raw: true });
    },

    emptyTrashcan() {
        return HolafFetch.post(LOCAL_ENDPOINTS.emptyTrashcan);
    },

    // Non supportées en local (l'UI de l'étape 1 les masquera).
    favorite: null,
    download: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRE
// ─────────────────────────────────────────────────────────────────────────────
const _sources = new Map();
let _activeId = 'local';

export const GallerySource = {
    register(id, provider) {
        if (!id || typeof id !== 'string') {
            throw new Error('GallerySource.register: id requis (string non vide)');
        }
        if (!provider || typeof provider !== 'object') {
            throw new Error('GallerySource.register: provider requis (objet)');
        }
        _sources.set(id, provider);
        return provider;
    },

    has(id) { return _sources.has(id); },

    list() { return Array.from(_sources.keys()); },

    activeId() { return _activeId; },

    active() {
        const provider = _sources.get(_activeId);
        if (!provider) {
            throw new Error(`GallerySource: source active inconnue « ${_activeId} »`);
        }
        return provider;
    },

    // Présent dès l'étape 0 (contrat), mais NON appelé par l'UI tant que le
    // switch local ↔ serveur (étape 1) n'existe pas.
    setActive(id) {
        if (!_sources.has(id)) {
            throw new Error(`GallerySource: source inconnue « ${id} »`);
        }
        _activeId = id;
        return _sources.get(id);
    },

    unregister(id) {
        return _sources.delete(id);
    },
};

// Enregistrement de la source locale (défaut).
GallerySource.register('local', localSource);

export { localSource };
export default GallerySource;

/*
 * NOTE (hors provider, à trancher à l'étape suivante) :
 *   - image_viewer_editor.js garde ses endpoints d'ÉDITION
 *     (/holaf/images/load-edits|save-edits|delete-edits|rollback-video|
 *      process-video) : l'édition n'est pas dans le contrat d'actions de
 *     l'étape 0 (delete/restore/favorite/download) et le module éditeur n'est
 *     pas dans le périmètre. À déplacer dans une capacité `edit` si l'étape 1
 *     l'exige.
 *   - image_viewer_ui.js garde /holaf/images/maintenance/clean-thumbnails et
 *     /holaf/images/regenerate-failed (bouton « Regenerate thumbnails ») :
 *     maintenance technique, indépendante de la source de données affichée.
 *   - l'aperçu d'édition au survol (image_viewer_gallery.js) utilise désormais
 *     GallerySource.active().loadEdits() ; image_viewer_editor.js conserve le
 *     même endpoint en propre (édition hors périmètre, cf. ci-dessus).
 */
