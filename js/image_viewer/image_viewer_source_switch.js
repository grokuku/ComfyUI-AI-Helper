/*
 * Copyright (C) 2025 Holaf
 * Holaf Utilities — Image Viewer SOURCE SWITCH (ÉTAPE 1)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RÔLE
 * ─────────────────────────────────────────────────────────────────────────────
 * Ce module porte la LOGIQUE du switch « Source : Local | Serveur » :
 *   - normalisation de la valeur persistée (`gallery_source` : 'local'|'remote',
 *     défaut 'local' — une clé absente ou invalide retombe sur 'local') ;
 *   - GARDE-FOU : la source 'remote' n'est sélectionnable que si le serveur
 *     AIH est configuré (serverUrl + token, cf. aih_fetch_bridge.getRemoteConfig)
 *     ET si le provider 'remote' est enregistré dans le registre ;
 *   - DÉCISION de bascule (`evaluateSourceSwitch`) : pure, sans effet de bord,
 *     utilisable par l'UI comme par les tests ;
 *   - EXÉCUTION de la bascule (`applySourceSwitch`) : arrêt du poll, vidage de
 *     l'état/cache de la source quittée, reset sélection, GallerySource.setActive,
 *     ré-ancrage de la collection, persistance, rechargement filtres + liste
 *     (la grille est re-rendue par loadFilteredImages → syncGallery).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ÉTAT ÉTAPE 1 (temporaire, à lever à l'étape 2)
 * ─────────────────────────────────────────────────────────────────────────────
 * Le provider 'remote' (image_viewer_source_remote.js) n'est PAS enregistré.
 * Conséquence : même serveur configuré, `evaluateSourceSwitch('remote')` refuse
 * avec reason 'not-implemented' → l'UI affiche « source serveur non disponible
 * dans cette version » et NE BASCULE PAS. À l'étape 2 :
 *   1. enregistrer le provider dans GallerySource (`GallerySource.register('remote', …)`)
 *      au chargement de image_viewer_source_remote.js ;
 *   2. aucune autre modification n'est requise ici : le garde-fou `hasProvider`
 *      ouvre alors la bascule pour de vrai ;
 *   3. vérifier PAGE_SIZE / rebindSourceCollection côté image_viewer_data.js si
 *      le pageSize du serveur diffère (aujourd'hui 500 des deux côtés).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REASONS DE REFUS (contrat stable pour l'UI)
 * ─────────────────────────────────────────────────────────────────────────────
 *   'not-configured' : serveur/token absents → option « Serveur » grisée,
 *                      guidage « AIH ▸ Paramètres serveur ».
 *   'not-implemented': serveur configuré mais provider 'remote' non enregistré
 *                      (étape 2 pas encore livrée).
 *   'error'          : échec technique pendant la bascule (rollback effectué).
 */

import { GallerySource } from './image_viewer_source.js';
import { imageViewerState } from './image_viewer_state.js';
import { resetWindowCache, rebindSourceCollection } from './image_viewer_data.js';
import { getRemoteConfig } from '../aih_fetch_bridge.js';

export const SOURCE_LOCAL = 'local';
export const SOURCE_REMOTE = 'remote';

/** Valeur persistée valide → normalisée ; tout le reste → 'local'. */
export function normalizeSourceId(value) {
    return value === SOURCE_REMOTE ? SOURCE_REMOTE : SOURCE_LOCAL;
}

/**
 * État du serveur distant pour le garde-fou du switch.
 * `configured` exige serverUrl ET token : un serveur sans token ne peut rien
 * servir, l'option est donc grisée dans ce cas.
 * @returns {{configured: boolean, hasProvider: boolean, serverUrl: string, hasApiKey: boolean}}
 */
export function getRemoteStatus() {
    let cfg = { serverUrl: '', apiKey: '' };
    try {
        cfg = getRemoteConfig();
    } catch (e) {
        /* config illisible → traité comme non configuré */
    }
    const serverUrl = cfg.serverUrl || '';
    const hasApiKey = !!cfg.apiKey;
    return {
        configured: !!serverUrl && hasApiKey,
        hasProvider: GallerySource.has(SOURCE_REMOTE),
        serverUrl,
        hasApiKey,
    };
}

/**
 * Décision PURE de bascule (aucun effet de bord).
 * @param {string} targetId — 'local' | 'remote' (toute autre valeur → 'local').
 * @returns {{ok: boolean, id: string, reason: string|null}}
 */
export function evaluateSourceSwitch(targetId) {
    const id = normalizeSourceId(targetId);
    if (id === SOURCE_LOCAL) {
        return { ok: true, id, reason: null };
    }
    const remote = getRemoteStatus();
    if (!remote.configured) {
        return { ok: false, id, reason: 'not-configured' };
    }
    if (!remote.hasProvider) {
        return { ok: false, id, reason: 'not-implemented' };
    }
    return { ok: true, id, reason: null };
}

/**
 * Extrait affichable de l'hôte serveur (indice discret du switch).
 * Retire le protocole et la barre finale, tronque avec « … » si trop long.
 * @param {string} serverUrl
 * @param {number} [maxLength=40]
 * @returns {string}
 */
export function describeRemoteHost(serverUrl, maxLength = 40) {
    const raw = String(serverUrl || '')
        .replace(/^https?:\/\//i, '')
        .replace(/\/+$/, '');
    if (!raw) return '';
    if (raw.length <= maxLength) return raw;
    return raw.slice(0, Math.max(1, maxLength - 1)) + '…';
}

// ─────────────────────────────────────────────────────────────────────────────
// EXÉCUTION DE LA BASCULE
// ─────────────────────────────────────────────────────────────────────────────

/** Arrêt de tout le travail périodique/retardé de la source quittée. */
function _stopViewerActivity(viewer) {
    if (!viewer) return;
    const clearIntervalId = (key) => {
        if (viewer[key]) clearInterval(viewer[key]);
        viewer[key] = null;
    };
    const clearTimeoutId = (key) => {
        if (viewer[key]) clearTimeout(viewer[key]);
        viewer[key] = null;
    };
    clearIntervalId('filterRefreshIntervalId');
    clearIntervalId('statsRefreshIntervalId');
    clearTimeoutId('filterDebounceTimer');
    clearTimeoutId('_showCheckTimer');
    clearTimeoutId('_statsDeferTimer');
    clearTimeoutId('_resyncDebounceTimer');
    viewer._statsDeferralScheduled = false;
}

/** Reset complet de l'état galerie (images, sélection, compteurs, poll). */
function _resetGalleryState() {
    imageViewerState.setState({
        images: [],
        totalCount: 0,
        selectedImages: new Set(),
        activeImage: null,
        currentNavIndex: -1,
        status: {
            pendingNewImages: false,
            isLoading: false,
            error: null,
            lastDbUpdateTime: 0,
            totalImageCount: 0,
            filteredImageCount: 0,
            allThumbnailsGenerated: false,
            generatedThumbnailsCount: 0,
        },
    });
}

/**
 * Applique la bascule de source (évaluée en amont). Refus propre si la source
 * cible n'est pas sélectionnable : aucun état n'est modifié.
 *
 * Séquence (étape 2, quand 'remote' sera enregistré) : arrêt du poll → vidage
 * du cache de fenêtres de la source quittée → GallerySource.setActive(id) →
 * ré-ancrage de la collection sur le nouveau provider → reset sélection/état →
 * persistance (saveSettings) → loadAndPopulateFilters(true) (filtres + liste,
 * la grille est re-rendue via syncGallery).
 *
 * @param {object} viewer — instance holafImageViewer (méthodes optionnelles :
 *                          saveSettings, loadAndPopulateFilters).
 * @param {string} targetId
 * @returns {Promise<{ok: boolean, id: string, reason?: string|null, noop?: boolean, error?: Error, reloadError?: Error}>}
 */
export async function applySourceSwitch(viewer, targetId) {
    const decision = evaluateSourceSwitch(targetId);
    if (!decision.ok) return decision;

    // Déjà sur la source cible → AUCUN effet de bord (et pas de sauvegarde).
    if (GallerySource.activeId() === decision.id) {
        return { ok: true, id: decision.id, reason: null, noop: true };
    }

    const previousId = GallerySource.activeId();
    _stopViewerActivity(viewer);
    // Vide le cache de fenêtres de la collection SORTANTE avant le swap.
    resetWindowCache();

    try {
        GallerySource.setActive(decision.id);
        // La collection (image_viewer_data.js) est ancrée sur le provider ACTIF :
        // on la recrée pour la nouvelle source avant tout chargement.
        rebindSourceCollection();
    } catch (error) {
        // Rollback best-effort : ne jamais laisser le registre et la collection
        // désynchronisés si le provider cible refuse de s'instancier.
        try {
            GallerySource.setActive(previousId);
            rebindSourceCollection();
        } catch (_) { /* le pire cas est signalé par la reason 'error' */ }
        return { ok: false, id: previousId, requested: decision.id, reason: 'error', error };
    }

    _resetGalleryState();
    // Source courante portée par l'état (indépendamment du viewer injecté) :
    // l'UI re-rend le contrôle depuis l'état, la persistance suit ci-dessous.
    imageViewerState.setState({ ui: { gallery_source: decision.id } });

    if (viewer && typeof viewer.saveSettings === 'function') {
        viewer.saveSettings({ gallery_source: decision.id });
    }

    if (viewer && typeof viewer.loadAndPopulateFilters === 'function') {
        try {
            await viewer.loadAndPopulateFilters(true);
        } catch (error) {
            console.error('[GallerySourceSwitch] rechargement après bascule échoué :', error);
            return { ok: true, id: decision.id, reason: null, reloadError: error };
        }
    }

    return { ok: true, id: decision.id, reason: null };
}

/**
 * Réconcilie la valeur persistée au démarrage : si la source enregistrée n'est
 * pas sélectionnable (ex. 'remote' sans serveur configuré, ou provider absent),
 * repli propre sur 'local' + persistance du repli. Sinon, applique la bascule
 * si le registre n'est pas déjà sur la bonne source.
 * @param {object} viewer
 */
export async function reconcileStoredSource(viewer) {
    const stored = normalizeSourceId(imageViewerState.getState().ui.gallery_source);
    const decision = evaluateSourceSwitch(stored);

    if (!decision.ok) {
        imageViewerState.setState({ ui: { gallery_source: SOURCE_LOCAL } });
        console.warn(`[GallerySourceSwitch] source enregistrée « ${stored} » indisponible (${decision.reason}) → repli sur « local »`);
        if (viewer && typeof viewer.saveSettings === 'function') {
            viewer.saveSettings({ gallery_source: SOURCE_LOCAL });
        }
        return { ok: true, id: SOURCE_LOCAL, requested: stored, fallback: true, reason: decision.reason };
    }

    if (GallerySource.activeId() !== decision.id) {
        return applySourceSwitch(viewer, decision.id);
    }
    return { ok: true, id: decision.id, reason: null, noop: true };
}

export default {
    SOURCE_LOCAL,
    SOURCE_REMOTE,
    normalizeSourceId,
    getRemoteStatus,
    evaluateSourceSwitch,
    describeRemoteHost,
    applySourceSwitch,
    reconcileStoredSource,
};
