/**
 * AIH Shared Helpers — Fonctions partagées entre les widgets ComfyUI.
 *
 * Chargé automatiquement par ComfyUI (WEB_DIRECTORY = "js" du pack).
 * Pas d'ESM : attache les helpers à l'objet global window.AIH.
 *
 * Les fichiers widget délèguent à ces helpers pour éviter la duplication.
 */
(function () {
    "use strict";

    const AIH = (window.AIH = window.AIH || {});

    /**
     * Récupère la clé API AIH depuis localStorage ("AIH_config").
     * @returns {string} La clé API, ou "" si absente / illisible.
     */
    AIH.getApiKey = function getApiKey() {
        try {
            return JSON.parse(localStorage.getItem("AIH_config") || "{}").apiKey || "";
        } catch {
            return "";
        }
    };

    /**
     * Récupère l'URL du serveur AIH depuis localStorage ("AIH_config").
     * @returns {string} L'URL de base sans slash final, ou "" si non
     *   configurée (aucune URL par défaut codée en dur : les appelants doivent
     *   adopter un comportement dégradé, cf. AIH.isServerConfigured()).
     */
    AIH.getServerUrl = function getServerUrl() {
        try {
            const url = JSON.parse(localStorage.getItem("AIH_config") || "{}").serverUrl || "";
            return url.replace(/\/+$/, "");
        } catch {
            return "";
        }
    };

    /**
     * Indique si l'URL du serveur AIH est configurée.
     * @returns {boolean} true si une URL non vide est présente dans la config.
     */
    AIH.isServerConfigured = function isServerConfigured() {
        return !!AIH.getServerUrl();
    };
})();