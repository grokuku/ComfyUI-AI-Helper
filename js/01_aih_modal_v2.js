/**
 * AIH Modal v2 — SHIM de compatibilité (délègue à AIH.Dialog)
 * ----------------------------------------------------------------------------
 * Préfixé 01_ pour être chargé avant les autres aih_*.js (ordre alphabétique
 * du WEB_DIRECTORY ComfyUI). Ce fichier n'est PLUS un système autonome : il
 * est un pont FIN qui rebranche l'ancienne API publique `aihOpenModalV2` /
 * `aihShowAlert` / `aihShowConfirm` / `aihShowPrompt` sur le système unifié
 * AIH.Dialog (js/aih_dialog.js, thème orange --aih-*).
 *
 * Tout le rendu, le drag/resize, la persistance position/taille et le halo
 * viennent de AIH.Dialog (aih_dialog.js + holaf_window_utils.js + aih_dialog.css).
 * Le halo bleu indigo (#6366f1 / rgba(99,102,241,…)) et le CSS inline de
 * l'ancienne modale sont SUPPRIMÉS ici.
 *
 * IMPORTANT — Résolution du cycle d'import (choix documenté) :
 *   aih_dialog.js n'importe PAS 01_aih_modal_v2.js (il déclare lui-même les
 *   wrappers `aihOpenModalV2`/`aihShow*`). Donc 01_aih_modal_v2.js peut
 *   importer aih_dialog.js SANS créer de cycle : la dépendance est
 *   unidirectionnelle aih_dialog ← 01_aih_modal_v2.
 *
 *   Par surcroît de robustesse, le shim accède à AIH.Dialog au moment de
 *   l'APPEL (déréféré via window.AIH), pas au moment de l'init : ainsi un
 *   aihOpenModalV2() invoqué tôt (avant que le module aih_dialog soit fini
 *   d'exécuter) trouve toujours le moteur prêt.
 *
 * Migration depuis aihOpenModal (v1) :
 *   var m = aihOpenModal("Titre", "<p>HTML</p>", "440px");
 *   → var m = aihOpenModalV2({ title: "Titre", content: "<p>HTML</p>", width: "440px" });
 *
 * API publique préservée (retour compatible) :
 *   aihOpenModalV2(options) → { modal/el, body, header, close(), setTitle,
 *                               setBody, setContent, bringToFront }
 *   aihShowAlert(title, msg, type)  → Promise<void>
 *   aihShowConfirm(title, msg)      → Promise<boolean>
 *   aihShowPrompt(title, msg, ph)   → Promise<string|null>
 *
 * Dépendances : js/aih_dialog.js (AIH.Dialog, AIH.alert/confirm/prompt).
 */
import "./aih_dialog.js";

(function () {
    "use strict";

    // ─── Résolveur AIH différé ──────────────────────────────────────────────
    // Lit window.AIH.Dialog à l'exécution (et non à l'init) pour rester robuste
    // à toute variante d'ordre de chargement. (aih_dialog.js importé ci-dessus
    // remplit window.AIH dès son évaluation, mais on ne fige jamais la réf.)
    function dialog() {
        return (window.AIH && window.AIH.Dialog) || null;
    }

    // ─── aihOpenModalV2 → AIH.Dialog.open (options + retour v2) ────────────
    // Mappe les options v2 vers le contrat AIH.Dialog. AIH.Dialog gère déjà
    // drag/resize, persistance (persistSize/persistPos), overlay/modal, focus
    // trap, closeOnEscape, boutons et z-index.
    function _aihOpenModalV2(options) {
        options = options || {};
        const D = dialog();
        if (!D || typeof D.open !== "function") {
            throw new Error(
                "[aihOpenModalV2] AIH.Dialog indisponible (aih_dialog.js non chargé)."
            );
        }

        const ctrl = D.open({
            // `id` / `theme` transmis (sinon perte de l'identifiant DOM et du
            // garde anti-doublon — voir aih_dialog.js).
            id: options.id,
            theme: options.theme,
            title: options.title,
            content: options.content,
            width: options.width,
            height: options.height,
            minWidth: options.minWidth || options.min,
            minHeight: options.minHeight || options.min,
            maxWidth: options.maxWidth || options.max,
            maxHeight: options.maxHeight || options.max,
            resizable: options.resizable,
            draggable: options.draggable,
            modal: options.modal,
            closeOnEscape: options.closeOnEscape,
            storageKey: options.storageKey,
            persistSize: options.persistSize,
            persistPos: options.persistPos,
            className: options.className,
            bringToFrontOnClick: options.bringToFrontOnClick,
            onClose: options.onClose,
            onOpen: options.onOpen,
            onResize: options.onResize,
            zIndex: options.zIndex,
        });

        // Adapte le controller AIH.Dialog → API v2 (modal/body/setBody).
        return {
            modal: ctrl.el,
            el: ctrl.el,
            body: ctrl.body,
            header: ctrl.header,
            headerRight: ctrl.headerRight,
            close: function () { ctrl.close(); },
            setTitle: ctrl.setTitle,
            setContent: ctrl.setContent,
            setBody: ctrl.setContent, // alias v2 historique
            bringToFront: ctrl.bringToFront,
        };
    }

    window.aihOpenModalV2 = _aihOpenModalV2;

    // ─── aihShowAlert / aihShowConfirm / aihShowPrompt → AIH helpers ────────
    // Délégation directe aux helpers unifiés (Promise) — même sémantique que
    // l'ancienne API : alert→void, confirm→boolean, prompt→string|null.
    window.aihShowAlert = function (title, message, type) {
        const D = (window.AIH && window.AIH.alert) || null;
        if (typeof D === "function") return D(title, message, type);
        return Promise.resolve();
    };

    window.aihShowConfirm = function (title, message) {
        const D = (window.AIH && window.AIH.confirm) || null;
        if (typeof D === "function") return D(title, message);
        return Promise.resolve(false);
    };

    window.aihShowPrompt = function (title, message, placeholder) {
        const D = (window.AIH && window.AIH.prompt) || null;
        if (typeof D === "function") return D(title, message, placeholder);
        return Promise.resolve(null);
    };
})();
