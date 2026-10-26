/*
 * Copyright (C) 2026 Holaf
 * AI Helper — Chargeur du frontend ComfyCH (générateur distant Modal)
 *
 * ComfyUI ne liste que les .js de la RACINE du WEB_DIRECTORY du pack : un
 * module placé dans un sous-dossier (js/comfych/) n'est pas chargé tout seul.
 * Ce fichier de la racine l'importe donc pour effet de bord — c'est aussi le
 * point d'entrée qui « possède » le module devant le pack.
 *
 * Le module lui-même (js/comfych/modal_gateway.js) est une copie INTÉGRÉE de
 * l'extension ComfyCH : il n'est pas vendorisé (pas de mise à jour par
 * `scripts/holaf`), il est modifié avec le pack (voir docs/COMFYCH.md).
 *
 * Si le fichier est chargé DEUX fois (frontend qui listerait aussi les
 * sous-dossiers), le graphe de modules ES déduplique par URL : une seule
 * exécution, donc un seul jeu de contrôles.
 */

import "./aih_i18n.js";
import "./aih_strings.js";
import "./aih_dialog.js";
import "./comfych/modal_gateway.js";

export const AIH_COMFYCH_FRONTEND = {
    /** Chemin servi (relatif au WEB_DIRECTORY du pack). */
    entry: "comfych/modal_gateway.js",

    /**
     * Dépendances de la fenêtre de suivi de run.
     *
     * ComfyCH n'invente AUCUN système de fenêtre : le suivi de run est un
     * AIH.Dialog non modal (js/aih_dialog.js) et ses libellés viennent des
     * dictionnaires du pack (js/aih_strings.js). Ces imports garantissent
     * l'ordre de chargement (ComfyUI importe les modules du WEB_DIRECTORY en
     * PARALLÈLE) : sans eux, la première ouverture pourrait tomber avant que
     * ces briques ne soient disponibles.
     */
    dependencies: ["aih_i18n.js", "aih_strings.js", "aih_dialog.js"],

    /**
     * Le pont est-il disponible ? (le module s'exécute dès son import)
     * @returns {boolean}
     */
    isAvailable() {
        return typeof window !== "undefined"
            && !!window.AIHComfyCHHost
            && typeof window.AIHComfyCHHost.buildControls === "function";
    },
};

if (typeof window !== "undefined") {
    window.AIHComfyCH = AIH_COMFYCH_FRONTEND;
}
