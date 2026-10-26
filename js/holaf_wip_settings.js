/*
 * Copyright (C) 2026 Holaf
 * Holaf Utilities - Per-feature WIP visibility manager
 *
 * The Holaf main menu contains "Work-In-Progress" (WIP) entries that used to be
 * shown/hidden by a single global checkbox (« Show WIP ») stored in localStorage
 * under "Holaf_ShowWIP". This module replaces that single global toggle with one
 * independent toggle per WIP feature.
 *
 * Storage: a single JSON object in localStorage under "Holaf_WIP_Features",
 * mapping a stable feature id to a boolean (true = shown in the menu).
 *
 * Migration: on first load after this refactor, the legacy "Holaf_ShowWIP" value
 * is read and applied to every WIP feature (so an old "Show WIP = on" user keeps
 * seeing all WIP entries), then the legacy key is removed.
 */

export const WIP_FEATURES = {
    model_manager: {
        id: "model_manager",
        label: "Model Manager",
        description: "Gestionnaire de modèles (navigation & recherche).",
    },
    custom_nodes_manager: {
        id: "custom_nodes_manager",
        label: "Custom Nodes Manager",
        description: "Gestion des nœuds personnalisés.",
    },
    workflow_profiler: {
        id: "workflow_profiler",
        label: "Workflow Profiler",
        description: "Profiler de performance des workflows.",
    },
    blobby: {
        id: "blobby",
        label: "Blobby",
        description: "Assistant IA (toggle Blobby Companion).",
    },
    chat: {
        id: "chat",
        label: "Chat",
        description: "Chat avec Blobby (indépendant de l'activation de Blobby).",
    },
    comfych: {
        id: "comfych",
        label: "ComfyCH",
        description: "Génération distante Modal : sélecteur de GPU + réglages dans le menu AIH.",
    },
};

const STORAGE_KEY = "Holaf_WIP_Features";
const LEGACY_KEY = "Holaf_ShowWIP";

export const HolafWipManager = {
    _cache: null,

    /**
     * Load (and lazily migrate) the per-feature visibility map.
     * @returns {Object<string, boolean>}
     */
    _load() {
        if (this._cache) return this._cache;

        let data = {};
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === "object") data = parsed;
            } catch (e) {
                data = {};
            }
        } else {
            // First run after this refactor (or completely fresh install).
            // Migrate from the legacy global checkbox if present.
            const legacy = localStorage.getItem(LEGACY_KEY);
            const defaultEnabled = legacy === "true";
            Object.keys(WIP_FEATURES).forEach(id => {
                data[id] = defaultEnabled;
            });
            localStorage.removeItem(LEGACY_KEY);
            this._persist(data);
        }

        // Normalise: any known feature missing from the map defaults to false.
        Object.keys(WIP_FEATURES).forEach(id => {
            if (typeof data[id] !== "boolean") data[id] = false;
        });

        this._cache = data;
        return data;
    },

    _persist(data) {
        this._cache = data;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            // localStorage unavailable (private mode / quota) — degrade silently.
        }
    },

    /**
     * Is the given WIP feature currently shown in the menu?
     * @param {string} featureId
     * @returns {boolean}
     */
    isEnabled(featureId) {
        const data = this._load();
        return !!data[featureId];
    },

    /**
     * Set the visibility of a WIP feature.
     * @param {string} featureId
     * @param {boolean} enabled
     */
    setEnabled(featureId, enabled) {
        const data = this._load();
        data[featureId] = !!enabled;
        this._persist(data);
    },

    /**
     * Re-enable every WIP feature at once.
     */
    resetAll() {
        const data = {};
        Object.keys(WIP_FEATURES).forEach(id => { data[id] = true; });
        this._persist(data);
    },

    /**
     * Ordered list of WIP features (as defined in WIP_FEATURES) for rendering
     * the settings section.
     * @returns {Array<{id:string,label:string,description?:string,parent?:string}>}
     */
    getFeatureList() {
        return Object.values(WIP_FEATURES);
    },
};

// Expose on window.holaf for cross-module access from anywhere.
if (typeof window !== "undefined") {
    window.holaf = window.holaf || {};
    window.holaf.wipManager = HolafWipManager;
}
