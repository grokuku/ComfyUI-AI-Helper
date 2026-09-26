/*
 * Copyright (C) 2026 Holaf
 * AIH Save Media — widget UI du node « AIH save media ».
 * ----------------------------------------------------------------------------
 * Rôle (strictement visuel, aucune logique métier) :
 *   - renommer le label du toggle `save_to_server` via l'i18n (`sm.saveToServer`) ;
 *   - GRISER / désactiver le widget `base_path` quand le toggle est ON
 *     (le base_path est ignoré en mode serveur — confort visuel).
 *
 * Le widget n'ajoute AUCUNE sérialisation : les valeurs restent des widgets
 * ComfyUI standard, donc les anciens workflows (sans la clé `save_to_server`)
 * continuent de charger avec le défaut Python False.
 *
 * Les helpers purs sont exposés sous `AIH.SaveMediaWidget` pour être testables
 * hors runtime ComfyUI (js/test_aih_save_media.mjs).
 */

import "./aih_strings.js";

(function () {
    "use strict";

    const AIH = (window.AIH = window.AIH || {});

    // Clés ComfyUI acceptées : clé canonique post-rename + alias hérité.
    // Les deux sont enregistrées côté Python, donc les deux doivent matcher.
    const NODE_TYPES = ["AIHSaveMedia", "HolafSaveMedia"];
    const TOGGLE_NAME = "save_to_server";
    const BASE_PATH_NAME = "base_path";

    /** Traduit une clé i18n, avec repli explicite si l'i18n n'est pas prête. */
    function t(key, fallback) {
        try {
            const I18n = AIH.I18n;
            if (I18n && typeof I18n.t === "function") {
                const val = I18n.t(key);
                if (val && val !== key) return val;
            }
        } catch (e) {
            /* i18n indisponible — repli */
        }
        return fallback || key;
    }

    /**
     * Désactive/grise un widget ComfyUI standard (valeur non éditable).
     * Tolérant : un widget sans DOM (test unitaire) ne casse rien.
     */
    function setWidgetDisabled(widget, disabled) {
        if (!widget) return;
        const on = !!disabled;
        widget.disabled = on;
        if (widget.options) widget.options.disabled = on;

        const el = widget.inputEl || widget.element;
        if (el && el.style) {
            if (el.disabled !== undefined) el.disabled = on;
            if (el.readOnly !== undefined) el.readOnly = on;
            el.style.opacity = on ? "0.45" : "1";
            el.style.pointerEvents = on ? "none" : "";
            if (on) {
                el.title = t("sm.basePathGreyed", "Ignored: media is saved on the server");
            } else if (el.removeAttribute) {
                el.removeAttribute("title");
            }
        }
    }

    /** Grise `base_path` si `save_to_server` est ON, le réactive sinon. */
    function applyBasePathState(node) {
        if (!node || !Array.isArray(node.widgets)) return;
        const toggle = node.widgets.find((w) => w && w.name === TOGGLE_NAME);
        const basePath = node.widgets.find((w) => w && w.name === BASE_PATH_NAME);
        if (!toggle || !basePath) return;
        setWidgetDisabled(basePath, !!toggle.value);
    }

    /** Renomme le toggle via l'i18n (aucun texte en dur côté consommateur). */
    function localize(node) {
        if (!node || !Array.isArray(node.widgets)) return;
        const toggle = node.widgets.find((w) => w && w.name === TOGGLE_NAME);
        if (toggle) toggle.label = t("sm.saveToServer", "Save to server");
    }

    // Helpers purs exposés (tests hors runtime ComfyUI).
    AIH.SaveMediaWidget = {
        NODE_TYPES: NODE_TYPES,
        TOGGLE_NAME: TOGGLE_NAME,
        BASE_PATH_NAME: BASE_PATH_NAME,
        setWidgetDisabled: setWidgetDisabled,
        applyBasePathState: applyBasePathState,
        localize: localize,
    };

    /** Branche les hooks sur le prototype du node. */
    function registerFor(app) {
        if (!app || typeof app.registerExtension !== "function") return;

        app.registerExtension({
            name: "AIH.SaveMedia",
            async beforeRegisterNodeDef(nodeType, nodeData) {
                if (!NODE_TYPES.includes(nodeData && nodeData.name)) return;

                const onNodeCreated = nodeType.prototype.onNodeCreated;
                nodeType.prototype.onNodeCreated = function () {
                    const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                    const node = this;
                    localize(node);
                    const toggle = node.widgets && node.widgets.find((w) => w.name === TOGGLE_NAME);
                    if (toggle) {
                        const origCb = toggle.callback;
                        toggle.callback = function () {
                            if (typeof origCb === "function") {
                                try {
                                    origCb.apply(this, arguments);
                                } catch (e) {
                                    /* le callback d'origine ne doit pas bloquer le grisage */
                                }
                            }
                            applyBasePathState(node);
                            if (app.graph && typeof app.graph.setDirtyCanvas === "function") {
                                app.graph.setDirtyCanvas(true, true);
                            }
                        };
                    }
                    applyBasePathState(node);
                    return r;
                };

                const onConfigure = nodeType.prototype.onConfigure;
                nodeType.prototype.onConfigure = function () {
                    const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
                    const node = this;
                    localize(node);
                    // Les valeurs des widgets sont posées APRÈS onConfigure :
                    // on relit l'état au tick suivant.
                    setTimeout(() => applyBasePathState(node), 0);
                    return r;
                };
            },
        });
    }

    // Polling borné (jamais infini) pour attendre window.app.
    (function waitForApp(attempt) {
        const n = attempt || 0;
        const app = window.app || (window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app);
        if (app && app.graph) {
            registerFor(app);
            return;
        }
        if (n < 100) setTimeout(() => waitForApp(n + 1), 100);
    })();
})();
