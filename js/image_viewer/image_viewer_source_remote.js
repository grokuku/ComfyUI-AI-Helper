/*
 * Copyright (C) 2026 Holaf
 * Holaf Utilities — Image Viewer SOURCE « remote » (ÉTAPE 2)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RÔLE
 * ─────────────────────────────────────────────────────────────────────────────
 * Provider de la source « serveur AIH » : affiche dans la galerie du pack les
 * médias du serveur web AI-Helper (GET /api/media/*), au lieu du dossier output
 * local. Il respecte À L'IDENTIQUE le contrat d'interface documenté en tête de
 * image_viewer_source.js (mêmes champs/méthodes que le provider 'local'), afin
 * que TOUS les modules hôtes (holaf_image_viewer.js, image_viewer_data/
 * gallery/navigation/infopane/actions.js) fonctionnent sans branchement.
 *
 * Périmètre ÉTAPES 2 + 4 : DONNÉES + VIGNETTES (étape 2 : liste paginée,
 * options de filtres, normalisation d'item, URL/chargement de vignette) et
 * PLEIN ÉCRAN + MÉTADONNÉES (étape 4 : resolveMediaUrl pour les IMAGES,
 * resolveInfo pour le panneau d'infos). Les filtres UI dédiés = étape 5 ; le
 * poll/delta = étape 6.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CANAL SERVEUR
 * ─────────────────────────────────────────────────────────────────────────────
 * Toutes les requêtes passent par js/aih_fetch_bridge.js (remoteGet/remotePost)
 * qui résout serverUrl + apiKey (localStorage 'AIH_config' / window.AIH) et
 * injecte le Bearer à chaque appel. Un `<img src>` ne peut PAS porter le Bearer :
 * les vignettes passent donc par remoteGet(..., {raw:true}) + blob (stratégie
 * 'blob' de la brique HolafThumbCache, qui gère déjà 202 → pending et >=400 →
 * erreur typée err.status).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MAPPING D'ITEM (local → serveur)
 * ─────────────────────────────────────────────────────────────────────────────
 * Le serveur renvoie des items `_media_json` (id, path, filename, subfolder,
 * size, created_at, kind, favorite, tags, status, trashed, has_prompt,
 * has_workflow). On les NORMALISE vers le schéma d'item local attendu par
 * l'hôte, en gardant `path_canon` comme clé métier universelle :
 *
 *   | item local (clé)    | item serveur (source)                       |
 *   |---------------------|---------------------------------------------|
 *   | path_canon          | "srv:<id>" (clé synthétique stable)         |
 *   | (nouveau) server_id | <id>                                        |
 *   | filename            | filename                                    |
 *   | subfolder           | subfolder                                   |
 *   | format              | extension de filename → MAJUSCULES           |
 *   | mtime               | Date.parse(created_at) / 1000               |
 *   | size_bytes          | size                                        |
 *   | is_trashed          | trashed                                     |
 *   | has_edit_file       | false (pas d'édition serveur)               |
 *   | kind                | kind (image|video|audio)                     |
 *   | favorite            | favorite                                     |
 *   | tags                | tags (liste de chaînes)                      |
 *   | has_prompt / _workflow | has_prompt / has_workflow                 |
 *   | width/height        | null (absents de la liste — dispo /metadata) |
 *   | duration_ms/codec   | null (absents de la liste — dispo /metadata) |
 *   | created_at          | created_at                                   |
 *   | server_status       | status (complete|trashed)                    |
 *
 * `path_canon = "srv:<id>"` permet à TOUT le code existant (getId, sélection,
 * dataset, lightbox, infopane, delta) de continuer de fonctionner : la clé est
 * juste une chaîne opaque. `format` MAJUSCULE est nécessaire aux tests
 * VIDEO_FORMATS / AUDIO_FORMATS de image_viewer_gallery.js.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ENREGISTREMENT (garde-fou cohérent avec l'étape 1)
 * ─────────────────────────────────────────────────────────────────────────────
 * Le provider n'est enregistré QUE si le serveur est configuré (serverUrl +
 * token). Au chargement de ce module, `ensureRemoteSourceRegistered()` tente
 * l'enregistrement ; c'est aussi la fonction appelée par les tests. Sans config,
 * le provider reste absent du registre : le garde-fou de l'étape 1 (image_viewer
 * _source_switch.js → evaluateSourceSwitch) refuse alors la bascule avec
 * `reason: 'not-implemented'` (ou 'not-configured' si le token manque).
 * Conséquence : l'option « Serveur » ne s'active qu'avec une config complète.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PLEIN ÉCRAN (étape 4)
 * ─────────────────────────────────────────────────────────────────────────────
 * resolveMediaUrl(image, {signal}) implémente la résolution du média PLEIN
 * ÉCRAN. Pour une IMAGE, il télécharge le BINAIRE ORIGINAL via le bridge
 * (remoteGet('media/<id>/download', {raw:true, signal})) — un `<img src>` ne
 * peut pas porter le Bearer, donc on récupère un blob puis on renvoie un
 * objectURL `{ url, revoke }`. L'hôte (image_viewer_navigation.js) appelle
 * revoke() à chaque changement d'image et à la fermeture de la visionneuse.
 *
 *   Endpoint choisi : /download (binaire ORIGINAL) et NON la grande vignette.
 *   Justification : la vignette serveur est plafonnée à 512 px (inadaptée au
 *   plein écran) ; le mode LOCAL charge déjà l'original via /holaf/images/full,
 *   donc la parité de fidélité est conservée. Conséquence : pour une très
 *   grande image le blob + objectURL restent en mémoire jusqu'à la révocation
 *   (faite au changement/fermeture), et le téléchargement est annulable via
 *   signal.
 *
 *   Pour un média VIDÉO/AUDIO : lecture DÉSACTIVÉE en phase 1 (décision
 *   validée : vignette seulement). resolveMediaUrl REFUSE alors AVANT tout
 *   fetch (aucun binaire complet téléchargé) ; l'hôte affiche la vignette + un
 *   message. capability `mediaPlayback:false` porte cette règle.
 *
 * PANNEAU D'INFOS (étape 4)
 * ─────────────────────────────────────────────────────────────────────────────
 * resolveInfo(image, {signal}) appelle GET /api/media/<id>/metadata et NORMALISE
 * la réponse vers le MÊME schéma que la source locale ({prompt, prompt_source,
 * workflow, workflow_source, width, height, ratio}) afin que
 * image_viewer_infopane.js (buildFields/buildBlocks) fonctionne SANS branchement.
 * Spécificité serveur : `workflow` est une CHAÎNE JSON (`workflow_json`) →
 * mapRemoteMetadata la PARSE en objet (le bouton « Load workflow » l'exige) ;
 * une chaîne corrompue devient `{error:'Corrupt workflow JSON'}` (parité locale).
 * duration/duration_ms/codec sont transmis pour affichage si présents.
 *
 * CE QUI N'EST PAS ENCORE SUPPORTÉ (documenté, fail-fast ou no-op explicite)
 * ─────────────────────────────────────────────────────────────────────────────
 *   - fetchLastUpdateTime  → null  (poll par tête de page 1 = étape 6) ;
 *   - fetchThumbnailStats  → null  (pas de stats/priorisation côté serveur) ;
 *   - reportViewerActivity → no-op (pas de heartbeat serveur) ;
 *   - fetchDelta           → delta VIDE (squelette ; poll = étape 6) ;
 *   - loadEdits            → null  (pas d'édition serveur) ;
 *   - prioritizeThumbnails → no-op (pas de priorisation serveur) ;
 *   - filters UI (formats, prompt/workflow, corbeille) = étape 5 ;
 *   - delete/restore/extract/inject/export → null (non supportés).
 * `favorite` et `download` SONT supportés par le serveur et implémentés
 * (capabilities favorite/serverDownload = true), même si l'UI du pack ne les
 * consomme pas encore.
 */

import { HolafThumbCache } from '../vendor/holaf/holaf-thumbcache.js';
import { HolafCollection } from '../vendor/holaf/holaf-collection.js';
import { remoteGet, remotePost, getRemoteConfig, HolafFetchError } from '../aih_fetch_bridge.js';
import { GallerySource } from './image_viewer_source.js';
import { imageViewerState } from './image_viewer_state.js';

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINTS & PARAMÈTRES DE LA SOURCE SERVEUR
// ─────────────────────────────────────────────────────────────────────────────
export const REMOTE_SOURCE_ID = 'remote';
export const REMOTE_ENDPOINTS = Object.freeze({
    list: 'media',
    folders: 'media/folders',
    tags: 'media/tags',
    favorite: 'media/favorite',
    download: (id) => `media/${id}/download`,
    thumbnail: (id) => `media/${id}/thumbnail`,
    metadata: (id) => `media/${id}/metadata`,
});

// Le serveur borne la pagination à 200 (route GET /api/media) → mode 'window'.
export const REMOTE_PAGE_SIZE = 200;
// Tailles de vignette autorisées côté serveur (snap vers le HAUT côté pack :
// la taille d'affichage du pack va de 80 à 300 px, cf. image_viewer_ui.js).
export const REMOTE_THUMB_SIZES = Object.freeze([128, 256, 512]);
const REMOTE_THUMB_DEFAULT_SIZE = 150; // taille d'affichage par défaut du pack
const REMOTE_THUMB_CACHE_CAPACITY = 1000;
const REMOTE_THUMB_TIMEOUT_MS = 30000;
const REMOTE_THUMB_RETRY = Object.freeze({ max: 2, delayMs: 3000 });
const REMOTE_THUMB_CONCURRENCY = 6;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS PURS (exportés pour les tests)
// ─────────────────────────────────────────────────────────────────────────────

/** Extension de `filename` (sans point), '' si absente. */
export function extOfFilename(filename) {
    const name = String(filename || '');
    const dot = name.lastIndexOf('.');
    if (dot <= 0 || dot === name.length - 1) return '';
    return name.slice(dot + 1);
}

/** created_at (ISO-8601) → secondes epoch (0 si illisible). */
export function mtimeFromCreatedAt(createdAt) {
    const ms = Date.parse(String(createdAt || ''));
    return Number.isFinite(ms) ? ms / 1000 : 0;
}

/**
 * Taille de vignette serveur : snap vers le HAUT dans {128,256,512}.
 *  80→128, 129→256, 257→512, 300→512 ; 0/absent→256 ; >512→512.
 * (Règle de la galerie web ; le serveur, lui, snappe à la plus PROCHE.)
 */
export function snapThumbSize(size) {
    const n = Number(size);
    if (!Number.isFinite(n) || n <= 0) return 256;
    for (const allowed of REMOTE_THUMB_SIZES) {
        if (n <= allowed) return allowed;
    }
    return REMOTE_THUMB_SIZES[REMOTE_THUMB_SIZES.length - 1];
}

/** "srv:<id>" → <id> (entier, ou null si non exploitable). */
export function serverIdFromPath(pathCanon) {
    const m = /^srv:(\d+)$/.exec(String(pathCanon || ''));
    return m ? Number(m[1]) : null;
}

// Formats vidéo/audio reconnus (mêmes listes que image_viewer_navigation.js).
// Sert à décider si resolveMediaUrl peut télécharger le binaire (IMAGE) ou
// refuser (VIDÉO/AUDIO : lecture désactivée en phase 1).
const REMOTE_VIDEO_FORMATS = ['MP4', 'WEBM', 'MKV', 'AVI', 'MOV', 'M4V'];
const REMOTE_AUDIO_FORMATS = ['WAV', 'MP3', 'OGG', 'FLAC', 'AAC', 'M4A'];

/**
 * L'item est-il une IMAGE (donc affichable en plein écran) ? On se fie d'abord
 * à `kind` (fourni par le serveur), sinon au format MAJUSCULE.
 * @param {object} image
 * @returns {boolean}
 */
export function isPlayableImage(image) {
    if (!image) return false;
    if (image.kind) return image.kind === 'image';
    const fmt = String(image.format || '').toUpperCase();
    return !REMOTE_VIDEO_FORMATS.includes(fmt) && !REMOTE_AUDIO_FORMATS.includes(fmt);
}

/** Erreur d'annulation (AbortError), sans dépendre de DOMException. */
function _abortError() {
    try { return new DOMException('aborted', 'AbortError'); }
    catch (e) { const err = new Error('aborted'); err.name = 'AbortError'; return err; }
}

/**
 * Erreur typée de chargement du média, porteuse du statut HTTP (lue par l'hôte
 * pour choisir le message : 401/403 → jeton, 404 → introuvable, sinon générique).
 */
function _mediaError(status) {
    if (status === 401 || status === 403) return new HolafFetchError('jeton invalide ou expiré', { status });
    if (status === 404) return new HolafFetchError('média introuvable', { status });
    return new HolafFetchError('échec du chargement du média', { status });
}

/**
 * Normalise les métadonnées serveur (/api/media/<id>/metadata) vers le schéma
 * attendu par image_viewer_infopane.js (parité avec /holaf/images/metadata).
 * `workflow` (chaîne JSON côté serveur) est PARSÉ en objet ; une chaîne
 * corrompue devient `{error:'Corrupt workflow JSON'}` (parité locale).
 * Exporté pour les tests.
 * @param {object} data réponse JSON de /metadata
 * @returns {object}
 */
export function mapRemoteMetadata(data) {
    const d = data || {};
    let workflow = null;
    const raw = d.workflow;
    if (typeof raw === 'string') {
        const s = raw.trim();
        if (s) {
            try { workflow = JSON.parse(s); }
            catch (e) { workflow = { error: 'Corrupt workflow JSON' }; }
        }
    } else if (raw && typeof raw === 'object') {
        workflow = raw;
    }
    return {
        prompt: d.prompt || '',
        prompt_source: '',   // le serveur n'expose pas la provenance du prompt
        workflow,
        workflow_source: '', // ni celle du workflow
        width: (d.width != null) ? d.width : null,
        height: (d.height != null) ? d.height : null,
        ratio: (d.ratio != null && d.ratio !== '') ? String(d.ratio) : null,
        duration: (d.duration != null) ? d.duration : null,
        duration_ms: (d.duration_ms != null) ? d.duration_ms : null,
        codec: d.codec || null,
    };
}

/**
 * Normalise un item `_media_json` serveur vers le schéma d'item local.
 * Cf. TABLEAU DE MAPPING en tête de fichier.
 * @param {object} raw
 * @returns {object}
 */
export function normalizeItem(raw) {
    const src = raw || {};
    const id = src.id;
    const filename = src.filename || '';
    return {
        path_canon: `srv:${id}`,
        server_id: id,
        filename,
        subfolder: src.subfolder || '',
        format: extOfFilename(filename).toUpperCase(),
        mtime: mtimeFromCreatedAt(src.created_at),
        size_bytes: Number(src.size) || 0,
        is_trashed: !!src.trashed,
        has_edit_file: false,
        kind: src.kind || '',
        favorite: !!src.favorite,
        tags: Array.isArray(src.tags) ? src.tags : [],
        has_prompt: !!src.has_prompt,
        has_workflow: !!src.has_workflow,
        width: null,
        height: null,
        duration_ms: null,
        codec: null,
        created_at: src.created_at || '',
        server_status: src.status || '',
    };
}

/**
 * Mappe l'état de filtres de l'hôte (state.filters) + les clés génériques vers
 * les paramètres de GET /api/media. Clés acceptées (générique → hôte) :
 *   subfolders/subfolder ← folder_filters ( 'root' → '' ; 'trashcan' → status )
 *   kind, tags ← tags_filter, q ← filename_search, from ← startDate,
 *   to ← endDate, status, favorite, sort.
 * Les filtres NON supportés (formats, prompt/workflow, bool_filters) sont
 * volontairement ignorés (filtres UI dédiés = étape 5).
 * @param {object|null} filters
 * @returns {URLSearchParams}
 */
export function buildMediaListQuery(filters) {
    const f = filters || {};
    const params = new URLSearchParams();

    // Dossiers : folder_filters (hôte) ou subfolders (générique). 'root' → ''
    // (racine serveur) ; 'trashcan' → bascule le statut sur 'trashed'.
    let status = f.status || null;
    const folders = Array.isArray(f.folder_filters) ? f.folder_filters
        : (Array.isArray(f.subfolders) ? f.subfolders : null);
    if (folders) {
        for (const folder of folders) {
            if (folder === 'trashcan') { status = status || 'trashed'; continue; }
            params.append('subfolders', folder === 'root' ? '' : String(folder));
        }
    } else if (typeof f.subfolder === 'string' && f.subfolder !== '') {
        params.append('subfolder', f.subfolder === 'root' ? '' : f.subfolder);
    }

    if (f.kind) params.append('kind', String(f.kind));

    const tags = Array.isArray(f.tags_filter) ? f.tags_filter
        : (Array.isArray(f.tags) ? f.tags : null);
    if (tags) for (const tag of tags) params.append('tags', String(tag));

    const q = (f.filename_search != null) ? f.filename_search : f.q;
    if (q) params.append('q', String(q));

    const from = (f.startDate != null && f.startDate !== '') ? f.startDate : f.from;
    if (from) params.append('from', String(from));
    const to = (f.endDate != null && f.endDate !== '') ? f.endDate : f.to;
    if (to) params.append('to', String(to));

    if (f.favorite === true || f.favorite === 1 || f.favorite === '1') params.append('favorite', '1');
    else if (f.favorite === false || f.favorite === 0 || f.favorite === '0') params.append('favorite', '0');

    if (status) params.append('status', String(status));
    if (f.sort) params.append('sort', String(f.sort));

    return params;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROVIDER
// ─────────────────────────────────────────────────────────────────────────────

/** Taille d'affichage de vignette courante (state.ui.thumbnail_size). */
function currentThumbSize() {
    try {
        const ui = imageViewerState.getState().ui;
        return (ui && ui.thumbnail_size) ? ui.thumbnail_size : REMOTE_THUMB_DEFAULT_SIZE;
    } catch (e) {
        return REMOTE_THUMB_DEFAULT_SIZE;
    }
}

/**
 * Factory du provider serveur (étape 2).
 * @param {object} [overrides] — surcharge de config pour les tests
 *        (serverUrl, apiKey, pageSize, thumbSize…). Par défaut, la config est
 *        lue via getRemoteConfig() (localStorage 'AIH_config' / window.AIH).
 * @returns {object} provider respectant le contrat de image_viewer_source.js
 */
export function createRemoteSource(overrides = {}) {
    // Cache-buster des vignettes (benchmark interne / rechargement forcé).
    let _thumbnailCacheBuster = '';

    function serverUrl() {
        if (overrides.serverUrl != null) return String(overrides.serverUrl).replace(/\/+$/, '');
        try { return (getRemoteConfig().serverUrl || '').replace(/\/+$/, ''); } catch (e) { return ''; }
    }

    function thumbSize(opts) {
        if (opts && opts.size != null) return opts.size;
        if (overrides.thumbSize != null) return overrides.thumbSize;
        return currentThumbSize();
    }

    const provider = {
        id: REMOTE_SOURCE_ID,
        label: 'Server',
        capabilities: Object.freeze({
            edit: false,          // pas d'édition serveur (l'éditeur reste fermé)
            trash: false,         // corbeille UI = étape 5
            export: false,        // export non supporté
            extractInject: false, // pas d'extract/inject serveur
            favorite: true,       // POST /api/media/favorite (bulk)
            serverDownload: true, // GET /api/media/<id>/download
            pollDelta: true,      // poll prévu (tête de page 1, étape 6)
            // Lecture plein média (vidéo/audio) DÉSACTIVÉE en phase 1 : vignette
            // seulement. L'hôte n'appelle jamais resolveMediaUrl pour du
            // vidéo/audio et affiche un message (cf. navigation.js).
            mediaPlayback: false,
            // Préchargement du plein média via <img src> impossible : le Bearer
            // ne peut pas être porté par un élément. L'hôte saute le preload
            // plein (le plein écran passe par le bridge + objectURL).
            preloadFull: false,
        }),
        pageSize: overrides.pageSize || REMOTE_PAGE_SIZE,
        mode: 'window',

        itemKey: (item) => (item && (item.path_canon || (item.id != null ? `srv:${item.id}` : null))) || null,
        sortKey: (item) => (item && item.mtime) || 0,

        createCollection() {
            return HolafCollection.create({
                pageSize: provider.pageSize,
                mode: 'window',
                getId: provider.itemKey,
                sortKey: provider.sortKey,
            });
        },

        // ── Données ───────────────────────────────────────────────────────
        /**
         * Page paginée. Le serveur pagine par `page` (1-indexée) ; on la calcule
         * depuis `offset` (aligné sur pageSize). `limit` est borné à 200.
         * Retourne la structure consommée par l'hôte (holaf_image_viewer.js /
         * image_viewer_gallery.js) : { images, total_count, total_db_count,
         * filtered_count, generated_thumbnails_count, page, limit }.
         */
        async fetchPage({ offset = 0, limit = null, filters = null, signal = undefined } = {}) {
            const lim = Math.min(Math.max(Number.isFinite(limit) ? Math.floor(limit) : provider.pageSize, 1), REMOTE_PAGE_SIZE);
            const off = Math.max(0, Math.floor(Number(offset) || 0));
            const page = Math.floor(off / lim) + 1;

            const params = new URLSearchParams();
            params.set('page', String(page));
            params.set('limit', String(lim));
            for (const [k, v] of buildMediaListQuery(filters)) params.append(k, v);

            const data = await remoteGet(`${REMOTE_ENDPOINTS.list}?${params.toString()}`, { signal });
            const rawItems = (data && Array.isArray(data.items)) ? data.items : [];
            const images = rawItems.map(normalizeItem);
            const total = (data && Number.isFinite(Number(data.total))) ? Number(data.total) : images.length;
            return {
                images,
                total_count: total,
                total_db_count: total,
                filtered_count: total,
                // Pas de stats ni de génération anticipée côté serveur : on
                // déclare tout « généré » pour éviter le poll de stats local.
                generated_thumbnails_count: total,
                page: (data && data.page) || page,
                limit: (data && data.limit) || lim,
            };
        },

        /**
         * Delta incrémental : SQUELETTE (étape 6). Le poll serveur passera par
         * la tête de page 1 + comparaison de mtime ; ici on renvoie un delta
         * vide (aucune régression : fetchLastUpdateTime() renvoie null, donc
         * checkForUpdates ne sollicite jamais fetchDelta).
         */
        fetchDelta(/* { filters, minMtime, signal } */) {
            return Promise.resolve({ images: [], removed_path_canons: [], total_count: null, last_update: 0 });
        },

        /**
         * Options des filtres pour l'UI existante. Mapping minimal :
         *   - dossiers : GET /api/media/folders → [{path, count}] ('' → 'root') ;
         *   - tags     : GET /api/media/tags     → [tag, …] ;
         *   - formats  : [] (pas d'endpoint ; filtres UI = étape 5) ;
         *   - last_update_time : 0 (non supporté).
         */
        async fetchFilterOptions({ signal = undefined } = {}) {
            const [folders, tags] = await Promise.all([
                remoteGet(REMOTE_ENDPOINTS.folders, { signal }),
                remoteGet(REMOTE_ENDPOINTS.tags, { signal }),
            ]);
            return {
                subfolders: ((folders && folders.folders) || []).map((f) => ({
                    path: (f.subfolder === '' || f.subfolder == null) ? 'root' : f.subfolder,
                    count: f.count,
                })),
                formats: [],
                tags: ((tags && tags.tags) || []).map((x) => x.tag),
                last_update_time: 0,
                total: (folders && folders.total) || 0,
            };
        },

        // Non supportés (documentés) : null / no-op explicites.
        fetchLastUpdateTime() { return Promise.resolve(null); },
        fetchThumbnailStats() { return Promise.resolve(null); },
        reportViewerActivity() { return Promise.resolve(null); },
        loadEdits: null,

        // ── Vignettes ─────────────────────────────────────────────────────
        /**
         * URL absolue de la vignette serveur (snap vers le HAUT + cache-buster).
         * `size` : opts.size, sinon la taille d'affichage courante du pack.
         * Note : un `<img src>` ne peut pas porter le Bearer — cette URL sert de
         * repère ; le chargement réel passe par loadThumbnail() (fetch + blob).
         */
        buildThumbnailUrl(image, opts = {}) {
            const id = (image && image.server_id != null) ? image.server_id : serverIdFromPath(image && image.path_canon);
            const size = snapThumbSize(thumbSize(opts));
            const url = new URL(`${serverUrl()}/api/${REMOTE_ENDPOINTS.thumbnail(id)}`);
            url.searchParams.set('size', String(size));
            const buster = (opts.cacheBuster !== undefined) ? opts.cacheBuster : _thumbnailCacheBuster;
            if (buster) url.searchParams.set('v', String(buster));
            return url.href;
        },

        /**
         * Charge la vignette : remoteGet(..., {raw:true}) → Response. La brique
         * HolafThumbCache gère 202 (pending/retry), >=400 (erreur typée
         * err.status) et le blob → objectURL. `priority` ignoré (pas de
         * priorisation serveur) — conservé pour le contrat.
         */
        loadThumbnail(image, { signal = undefined, priority = undefined, size = undefined } = {}) {
            const id = (image && image.server_id != null) ? image.server_id : serverIdFromPath(image && image.path_canon);
            let path = `${REMOTE_ENDPOINTS.thumbnail(id)}?size=${snapThumbSize(thumbSize({ size }))}`;
            if (_thumbnailCacheBuster) path += `&v=${encodeURIComponent(_thumbnailCacheBuster)}`;
            return remoteGet(path, { raw: true, signal });
        },

        /**
         * Cache de vignettes dédié à la source serveur : stratégie 'blob'
         * (Bearer obligatoire), capacité 1000, concurrence 4-6, retries bornés.
         * Les hooks dépendants du DOM (onPending → placeholder, onError →
         * overlay) sont injectés par l'hôte.
         */
        createThumbCache(hooks = {}) {
            return HolafThumbCache.create({
                capacity: REMOTE_THUMB_CACHE_CAPACITY,
                strategy: 'blob',
                concurrency: REMOTE_THUMB_CONCURRENCY,
                getId: (image) => provider.itemKey(image),
                load: (image, opts) => provider.loadThumbnail(image, opts),
                retry: { ...REMOTE_THUMB_RETRY },
                timeoutMs: REMOTE_THUMB_TIMEOUT_MS,
                onError: () => {},   // filet de sécurité ; l'hôte pose l'overlay
                onPending: () => {}, // 202 : l'hôte pose le placeholder
                ...hooks,
            });
        },

        /** Pas de priorisation serveur : no-op explicite. */
        prioritizeThumbnails() { return Promise.resolve(null); },

        /** Force des URL de vignette uniques (bypass cache navigateur/blob). */
        setThumbnailCacheBuster(value) { _thumbnailCacheBuster = value || ''; },

        // ── Média / infos (étape 4) ───────────────────────────────────────
        /**
         * URL du média plein écran. Pour une IMAGE, récupère le binaire ORIGINAL
         * via le bridge (Bearer) et renvoie `{ url, revoke }` : `url` = objectURL,
         * `revoke()` libère l'objectURL (à appeler au changement d'image / à la
         * fermeture par l'hôte). Pour un VIDÉO/AUDIO, REFUSE avant tout fetch
         * (lecture désactivée en phase 1) — l'hôte ne l'appelle d'ailleurs jamais
         * pour ces formats (capability mediaPlayback:false).
         *
         * Erreurs typées (HolafFetchError) : status 401/403 (jeton), 404
         * (introuvable), 0 (réseau) ; annulation = AbortError (signal).
         * @param {object} image item normalisé (server_id / path_canon)
         * @param {{signal?: AbortSignal}} [opts]
         * @returns {Promise<{url: string, revoke: Function}>}
         */
        async resolveMediaUrl(image, { signal = undefined } = {}) {
            const id = (image && image.server_id != null) ? image.server_id : serverIdFromPath(image && image.path_canon);
            if (id == null) throw _mediaError(404);
            if (!isPlayableImage(image)) {
                // Vidéo/audio : AUCUN téléchargement du binaire complet.
                throw new HolafFetchError('lecture vidéo/audio indisponible en mode serveur', { status: -1 });
            }
            if (signal && signal.aborted) throw _abortError();

            let resp;
            try {
                resp = await remoteGet(REMOTE_ENDPOINTS.download(id), { raw: true, signal });
            } catch (err) {
                if (signal && signal.aborted) throw _abortError();
                throw err;
            }
            if (signal && signal.aborted) throw _abortError();
            if (!resp || resp.ok === false) throw _mediaError(resp ? resp.status : 0);

            let blob;
            try {
                blob = await resp.blob();
            } catch (err) {
                if (signal && signal.aborted) throw _abortError();
                throw _mediaError(0);
            }
            if (signal && signal.aborted) throw _abortError();

            const url = URL.createObjectURL(blob);
            return { url, revoke: () => { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } } };
        },

        /**
         * Métadonnées détaillées pour le panneau d'infos : GET
         * /api/media/<id>/metadata → mapRemoteMetadata() (schéma local).
         * `workflow` (chaîne JSON) est parsé pour que « Load workflow » marche.
         * @param {object} image item normalisé
         * @param {{signal?: AbortSignal}} [opts]
         * @returns {Promise<object|null>}
         */
        async resolveInfo(image, { signal = undefined } = {}) {
            const id = (image && image.server_id != null) ? image.server_id : serverIdFromPath(image && image.path_canon);
            if (id == null) throw _mediaError(404);
            const data = await remoteGet(REMOTE_ENDPOINTS.metadata(id), { signal });
            if (signal && signal.aborted) return null;
            return mapRemoteMetadata(data);
        },

        // ── Actions ───────────────────────────────────────────────────────
        // Favorite : endpoint GROUPÉ serveur POST /api/media/favorite {ids, favorite}.
        favorite(paths, { favorite = true } = {}) {
            const ids = (Array.isArray(paths) ? paths : [paths])
                .map(serverIdFromPath).filter((id) => id != null);
            return remotePost(REMOTE_ENDPOINTS.favorite, { ids, favorite: !!favorite });
        },

        // Download : URLs absolues par média (le pack ne déclenche pas encore de
        // téléchargement ; le fetch Bearer+blob sera le rôle de l'UI web/étape 4).
        download(paths) {
            const list = Array.isArray(paths) ? paths : [paths];
            return Promise.resolve(list.map((path) => {
                const id = serverIdFromPath(path);
                return { path_canon: path, server_id: id, url: `${serverUrl()}/api/${REMOTE_ENDPOINTS.download(id)}` };
            }));
        },

        // Non supportés à l'étape 2 : null (l'hôte gère les capacités).
        deleteImages: null,
        restoreImages: null,
        runMetadataOperation: null,
        extractMetadata: null,
        injectMetadata: null,
        prepareExport: null,
        exportChunkUrl: null,
        fetchExportChunk: null,
        emptyTrashcan: null,
    };

    return provider;
}

// ─────────────────────────────────────────────────────────────────────────────
// ENREGISTREMENT CONDITIONNEL
// ─────────────────────────────────────────────────────────────────────────────

/** Le serveur est-il configuré (serverUrl + token) ? (aucun appel réseau). */
export function isRemoteConfigured() {
    try {
        const cfg = getRemoteConfig();
        return !!(cfg.serverUrl && cfg.apiKey);
    } catch (e) {
        return false;
    }
}

/**
 * Enregistre le provider 'remote' SI (et seulement si) le serveur est
 * configuré. Idempotent. C'est le garde-fou de l'étape 1 (`hasProvider`) qui
 * décide ensuite d'ouvrir ou non la bascule.
 * @returns {boolean} true si le provider est (désormais) enregistré.
 */
export function ensureRemoteSourceRegistered() {
    if (!isRemoteConfigured()) return false;
    if (!GallerySource.has(REMOTE_SOURCE_ID)) {
        GallerySource.register(REMOTE_SOURCE_ID, createRemoteSource());
    }
    return true;
}

// Enregistrement au chargement (la config est lue depuis localStorage/AIH).
ensureRemoteSourceRegistered();

export default createRemoteSource;
