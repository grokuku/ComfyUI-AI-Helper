// js/image_viewer/image_viewer_state.js

/**
 * Classe de gestion d'état centralisée pour l'Image Viewer.
 * Utilise un modèle simple de publication/abonnement (pub/sub).
 */
class ImageViewerState {
    constructor() {
        this.state = {
            // Données principales
            images: [],
            totalCount: 0,
            selectedImages: new Set(),
            selectedPaths: new Set(), // Derived from selectedImages for O(1) lookups
            activeImage: null,
            currentNavIndex: -1,

            // État des filtres aligné sur la nouvelle API backend
            filters: {
                folder_filters: [],
                format_filters: [],
                startDate: '',
                endDate: '',
                filename_search: '',
                prompt_search: '',
                workflow_search: '',
                tags_filter: [],
                workflow_sources: [],
                bool_filters: {
                    has_workflow: null, // null: indifférent, true: oui, false: non
                    has_prompt: null,
                    has_edits: null,
                    has_tags: null,
                },
                locked_folders: [], // État de l'UI, non envoyé au backend
            },

            // État de l'interface et des préférences
            ui: {
                theme: "Graphite Orange",
                // Source de la galerie : 'local' (dossier output ComfyUI) ou
                // 'remote' (serveur AIH, étape 2). Persistée via save-settings
                // (clé gallery_source, whitelist backend __init__.py).
                gallery_source: 'local',
                thumbnail_fit: 'cover',
                thumbnail_size: 150,
                export_format: 'png',
                export_include_meta: true,
                export_meta_method: 'embed',
                view_mode: 'gallery',
            },
            
            // Statut de l'application
            status: {
                isLoading: false,
                pendingNewImages: false,
                isExporting: false,
                lastDbUpdateTime: 0,
                error: null,
                totalImageCount: 0,
                filteredImageCount: 0,
                allThumbnailsGenerated: false,
                generatedThumbnailsCount: 0,
            },

            // État spécifique à l'exportation (processus en cours)
            exporting: {
                queue: [],
                stats: {
                    totalFiles: 0,
                    completedFiles: 0,
                    currentFileName: '',
                    currentFileProgress: 0,
                },
                activeToastId: null,
            },

            // Propriétés du panneau (gérées par HolafPanelManager, stockées ici pour la sauvegarde)
            panel_x: null,
            panel_y: null,
            panel_width: 1200,
            panel_height: 800,
            panel_is_fullscreen: false,
        };

        this.listeners = new Set();
    }

    /**
     * Permet aux composants de s'abonner aux changements d'état.
     * @param {function} listener - La fonction à appeler lors d'un changement.
     * @returns {function} Une fonction pour se désabonner.
     */
    subscribe(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Notifie tous les abonnés d'un changement d'état.
     * @private
     */
    _notify() {
        // La création de l'instantané est maintenant déléguée à getState() pour la robustesse.
        const stateSnapshot = this.getState(); 
        for (const listener of this.listeners) {
            listener(stateSnapshot);
        }
    }

    /**
     * Met à jour l'état de manière fusionnée et notifie les abonnés.
     * @param {object} partialState - Un objet contenant les clés/valeurs à mettre à jour.
     */
    setState(partialState) {
        for (const key in partialState) {
            if (Object.prototype.hasOwnProperty.call(partialState, key)) {
                // Fusionne les objets imbriqués au lieu de les remplacer
                if (typeof partialState[key] === 'object' && partialState[key] !== null && !Array.isArray(partialState[key]) && !(partialState[key] instanceof Set) && this.state[key]) {
                    this.state[key] = { ...this.state[key], ...partialState[key] };
                } else {
                    this.state[key] = partialState[key];
                }
            }
        }
        
        // Keep selectedPaths in sync with selectedImages for O(1) lookups in render loop
        if (partialState.selectedImages !== undefined) {
            this.state.selectedPaths = new Set([...this.state.selectedImages].map(img => img.path_canon));
        }

        this._notify();
    }

    /**
     * Retourne une copie profonde et fiable de l'état actuel.
     * Remplace l'implémentation JSON.stringify qui n'est pas fiable pour les Sets vides.
     * @returns {object} L'état actuel.
     */
    getState() {
        const state = this.state;
        const stateCopy = {
            // Copie de toutes les propriétés de premier niveau
            ...state,
            
            // OPTIMISATION CRITIQUE 1 : Retourne la référence directe au tableau d'images (gros volume).
            images: state.images,
            
            // FIX CRITIQUE 2 : Copie explicite des tableaux de filtres.
            filters: { 
                ...state.filters,
                folder_filters: [...(state.filters.folder_filters || [])],
                format_filters: [...(state.filters.format_filters || [])],
                tags_filter: [...(state.filters.tags_filter || [])],
                workflow_sources: [...(state.filters.workflow_sources || [])],
                locked_folders: [...(state.filters.locked_folders || [])],
                bool_filters: { ...state.filters.bool_filters } 
            },
            
            ui: { ...state.ui },
            status: { ...state.status },
            exporting: {
                ...state.exporting,
                queue: [...state.exporting.queue],
                stats: { ...state.exporting.stats }
            },

            // Conversion explicite et fiable du Set en Array
            selectedImages: Array.from(state.selectedImages),

            // OPTIMISATION: Direct reference for O(1) lookups in render loop
            selectedPaths: state.selectedPaths
        };
        return stateCopy;
    }
}

// Exporter une instance unique (Singleton) pour toute l'application
export const imageViewerState = new ImageViewerState();