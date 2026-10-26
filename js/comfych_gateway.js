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

import "./comfych/modal_gateway.js";

export const AIH_COMFYCH_FRONTEND = {
    /** Chemin servi (relatif au WEB_DIRECTORY du pack). */
    entry: "comfych/modal_gateway.js",

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
