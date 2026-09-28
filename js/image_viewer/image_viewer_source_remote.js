/*
 * Copyright (C) 2025 Holaf
 * Holaf Utilities — Image Viewer SOURCE « remote » (SQUELETTE — ÉTAPE 2)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CE FICHIER N'EST PAS BRANCHÉ. Il n'est importé par AUCUN module et ne
 * s'enregistre PAS dans GallerySource : `GallerySource.active()` reste 'local'.
 * Il matérialise le contrat (mêmes champs/méthodes que le provider local, cf.
 * image_viewer_source.js) pour l'étape 2, qui ajoutera le provider serveur.
 *
 * Chaque méthode lève `not implemented` : toute activation prématurée est donc
 * détectée immédiatement (fail-fast) plutôt que de renvoyer des données vides.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const _notImplemented = (name) => () => {
    throw new Error(`[GallerySource:remote] « ${name} » non implémenté (étape 2).`);
};

/**
 * Factory du provider serveur (étape 2). NON enregistré, NON appelé.
 * @param {object} config
 * @returns {object} provider respectant le contrat de image_viewer_source.js
 */
export function createRemoteSource(config = {}) {
    return {
        id: 'remote',
        label: 'Server',
        capabilities: {
            edit: false,
            trash: false,
            export: false,
            extractInject: false,
            favorite: true,
            serverDownload: true,
            pollDelta: false,
        },
        pageSize: config.pageSize || 500,
        mode: 'window',
        itemKey: (item) => (item && (item.id != null ? String(item.id) : item.path_canon)) || null,
        sortKey: (item) => (item && item.mtime) || 0,

        createCollection: _notImplemented('createCollection'),
        fetchPage: _notImplemented('fetchPage'),
        fetchDelta: _notImplemented('fetchDelta'),
        fetchFilterOptions: _notImplemented('fetchFilterOptions'),
        fetchLastUpdateTime: _notImplemented('fetchLastUpdateTime'),
        fetchThumbnailStats: _notImplemented('fetchThumbnailStats'),
        reportViewerActivity: _notImplemented('reportViewerActivity'),
        loadEdits: _notImplemented('loadEdits'),
        buildThumbnailUrl: _notImplemented('buildThumbnailUrl'),
        loadThumbnail: _notImplemented('loadThumbnail'),
        createThumbCache: _notImplemented('createThumbCache'),
        prioritizeThumbnails: _notImplemented('prioritizeThumbnails'),
        resolveMediaUrl: _notImplemented('resolveMediaUrl'),
        resolveInfo: _notImplemented('resolveInfo'),
        deleteImages: null,
        restoreImages: null,
        runMetadataOperation: null,
        extractMetadata: null,
        injectMetadata: null,
        prepareExport: null,
        exportChunkUrl: _notImplemented('exportChunkUrl'),
        fetchExportChunk: _notImplemented('fetchExportChunk'),
        emptyTrashcan: null,
        favorite: _notImplemented('favorite'),
        download: _notImplemented('download'),
    };
}

export default createRemoteSource;
