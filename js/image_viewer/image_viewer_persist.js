/*
 * Copyright (C) 2025 Holaf
 * Holaf Utilities — Image Viewer PERSISTANCE DE L'ÉTAT DE TRAVAIL (brique pack)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RÔLE
 * ─────────────────────────────────────────────────────────────────────────────
 * Mémorise de façon DURABLE (localStorage) l'état de TRAVAIL de la galerie du
 * pack — celui qui, sinon, est perdu à la fermeture / au rechargement de la
 * page : POSITION DE DÉFILEMENT + ÉLÉMENT ACTIF (et index de navigation).
 *
 * Ce qui est DÉJÀ persisté côté backend ComfyUI (via
 * `/holaf/image-viewer/save-settings`, image_viewer_settings.js) et n'est donc
 * PAS dupliqué ici : source active (`gallery_source`), filtres LOCAUX
 * (folder_filters/format_filters/dates/recherche), filtres SERVEUR (remote_*),
 * tri serveur (remote_sort), taille de vignette (thumbnail_size), mode
 * d'affichage (view_mode) et géométrie du panneau.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PORTÉE PAR SOURCE (local ↔ serveur)
 * ─────────────────────────────────────────────────────────────────────────────
 * Le défilement et l'élément actif n'ont de sens que pour la source qui les a
 * produits : la clé de stockage est un OBJET indexé par `GallerySource.activeId()`
 * ('local' | 'remote'). Basculer de source puis revenir restaure donc la vue
 * PROPRE à chaque source — jamais la position de l'une appliquée à l'autre.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DÉGRADATION PROPRE
 * ─────────────────────────────────────────────────────────────────────────────
 * Toute valeur invalide/obsolète est NORMALISÉE à la lecture (jamais de throw) :
 *   - scrollTop non fini/négatif → 0 (la galerie repart en haut) ;
 *   - navIndex non entier/négatif → -1 ;
 *   - activePath non-chaîne/vide → null (aucun élément actif) ;
 *   - un activePath qui n'existe plus dans la liste courante (dossier/​média
 *     supprimé) est simplement ignoré → aucun élément actif, pas d'erreur.
 *
 * Le module est PUR côté stockage (il accepte un `storage` injectable) pour
 * être testé sans DOM ; capture/restore touchent le DOM/state de l'hôte.
 */

import { imageViewerState } from './image_viewer_state.js';
import { GallerySource } from './image_viewer_source.js';

const STORAGE_KEY = 'holaf.imageViewer.galleryView.v1';
const GALLERY_EL_ID = 'holaf-viewer-gallery';

/** localStorage, ou null si indisponible (mode privé strict, iframe…). */
function _defaultStorage() {
    try {
        return (typeof window !== 'undefined' && window.localStorage) ? window.localStorage : null;
    } catch (e) {
        return null;
    }
}

/** Lecture tolérante de l'objet racine : {} si absent/corrompu/illisible. */
function _readRaw(storage) {
    const s = storage || _defaultStorage();
    if (!s) return {};
    let text = null;
    try { text = s.getItem(STORAGE_KEY); } catch (e) { return {}; }
    if (!text) return {};
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { return {}; }
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
}

function _writeRaw(storage, obj) {
    const s = storage || _defaultStorage();
    if (!s) return false;
    try { s.setItem(STORAGE_KEY, JSON.stringify(obj)); return true; }
    catch (e) { return false; } // quota/private-mode : jamais fatal
}

/**
 * Normalise une entrée (source donnée) en valeurs sûres. Exporté pour les tests.
 * @param {*} raw
 * @returns {{scrollTop:number, activePath:(string|null), navIndex:number}}
 */
export function normalizePersistedView(raw) {
    const d = (raw && typeof raw === 'object') ? raw : {};
    const scrollTop = Number(d.scrollTop);
    const navIndex = Number(d.navIndex);
    return {
        scrollTop: (Number.isFinite(scrollTop) && scrollTop > 0) ? Math.floor(scrollTop) : 0,
        activePath: (typeof d.activePath === 'string' && d.activePath) ? d.activePath : null,
        navIndex: (Number.isInteger(navIndex) && navIndex >= 0) ? navIndex : -1,
    };
}

/**
 * Vue persistée pour une source, normalisée, ou null si rien de mémorisé.
 * @param {string} sourceId 'local' | 'remote' (toute chaîne non vide)
 * @param {Storage} [storage] injectable (tests)
 */
export function loadGalleryView(sourceId, storage) {
    if (!sourceId) return null;
    const all = _readRaw(storage);
    if (!Object.prototype.hasOwnProperty.call(all, sourceId)) return null;
    return normalizePersistedView(all[sourceId]);
}

/**
 * Écrit la vue d'une source. Un état « vide » (aucun scroll, aucun élément
 * actif) SUPPRIME l'entrée au lieu de figer un état inutile.
 * @param {string} sourceId
 * @param {{scrollTop?:number, activePath?:(string|null), navIndex?:number}} view
 * @param {Storage} [storage]
 */
export function saveGalleryView(sourceId, view, storage) {
    if (!sourceId) return false;
    const entry = normalizePersistedView(view);
    const all = _readRaw(storage);
    if (entry.scrollTop === 0 && entry.activePath === null && entry.navIndex < 0) {
        if (Object.prototype.hasOwnProperty.call(all, sourceId)) {
            delete all[sourceId];
            _writeRaw(storage, all);
        }
        return false;
    }
    all[sourceId] = entry;
    return _writeRaw(storage, all);
}

/** Oublie la vue d'une source (ex. source devenue indisponible). */
export function clearGalleryView(sourceId, storage) {
    if (!sourceId) return false;
    const all = _readRaw(storage);
    if (!Object.prototype.hasOwnProperty.call(all, sourceId)) return false;
    delete all[sourceId];
    return _writeRaw(storage, all);
}

/**
 * Capture l'état de travail courant de la galerie (DOM + state) pour la source
 * ACTIVE. Appelé à la fermeture du panneau, à la bascule de source, au
 * défilement (débouncé) et à la fermeture de la page.
 */
export function captureGalleryView() {
    try {
        const el = (typeof document !== 'undefined') ? document.getElementById(GALLERY_EL_ID) : null;
        const st = imageViewerState.getState();
        const active = st.activeImage;
        saveGalleryView(GallerySource.activeId(), {
            scrollTop: el ? el.scrollTop : 0,
            activePath: (active && active.path_canon) ? String(active.path_canon) : null,
            navIndex: st.currentNavIndex,
        });
    } catch (e) {
        /* la persistance ne doit jamais casser la galerie */
    }
}

/**
 * Restaure l'état de travail de la source ACTIVE (défilement + élément actif).
 * À appeler APRÈS le rendu de la grille (le sizer doit connaître le total pour
 * que `scrollTop` soit applicable). Dégradation propre : sans entrée, sans
 * élément retrouvé, ou sans DOM, c'est un no-op.
 */
export function restoreGalleryView() {
    try {
        const saved = loadGalleryView(GallerySource.activeId());
        if (!saved) return;
        const el = (typeof document !== 'undefined') ? document.getElementById(GALLERY_EL_ID) : null;
        if (el && saved.scrollTop > 0) el.scrollTop = saved.scrollTop;
        if (saved.activePath) {
            const images = imageViewerState.getState().images || [];
            let found = null;
            for (let i = 0; i < images.length; i++) {
                const img = images[i];
                if (img && img.path_canon === saved.activePath) { found = img; break; }
            }
            if (found) {
                imageViewerState.setState({
                    activeImage: found,
                    currentNavIndex: saved.navIndex,
                });
            }
        }
    } catch (e) {
        /* restauration best-effort */
    }
}

export { STORAGE_KEY, GALLERY_EL_ID };
