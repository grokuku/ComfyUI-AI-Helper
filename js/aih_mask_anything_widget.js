/*
 * Copyright (C) Holaf — ComfyUI-AI-Helper.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * AIH Mask Anything — widget du dropdown « Preset IA » (node expérimentale).
 *
 * RÔLE : la liste des presets vient du SERVEUR AIH (comme le Prompt Enhancer
 * et le Elements Picker : GET /api/presets). Le DOM widget ne fait QUE piloter
 * le widget natif `preset_id` (INT déclaré en required côté Python) :
 *   - sérialisation : c'est `preset_id` qui part dans `widgets_values` → la
 *     sélection survit au rechargement du workflow, même sans JS ;
 *   - serveur injoignable : le <select> garde son placeholder, un message
 *     explicite s'affiche sous le menu, AUCUNE exception ;
 *   - à l'exécution : `ui.status` (succès ou échec) est affiché sous le menu
 *     et recopié dans la console du navigateur — c'est le canal « honnête »
 *     de la node (masque vide + message quand le LLM échoue).
 *
 * Compatibilité : `addDOMWidget` fonctionne en mode CLASSIQUE (LiteGraph, la
 * production de l'utilisateur) et en Nodes 2.0. Aucune brique vendor/holaf
 * n'est modifiée ; les valeurs du serveur sont posées en `textContent`
 * (jamais en innerHTML) → pas d'injection possible.
 */

import "./aih_strings.js";
import { remoteGet } from "./aih_fetch_bridge.js";

// Helper i18n central (clé brute si le dictionnaire n'est pas encore chargé).
const t = (key, params) => {
    const I = window.AIH && window.AIH.I18n;
    return I && typeof I.t === "function" ? I.t(key, params) : key;
};

(function () {
    "use strict";

    // Clé d'enregistrement Python (nodes/holaf_mask_anything.py). Une seule,
    // aucun alias : un type absent ne s'attacherait JAMAIS (UI générique).
    const NODE_TYPES = ["AIHMaskAnything"];
    const EXTENSION_NAME = "AIH.MaskAnything";
    const DOM_WIDGET_NAME = "mask_anything_ui";
    const PRESETS_TTL = 15000;

    function aihBoot() {
        // Les extensions du pack ne sont pas chargées dans un ordre garanti :
        // attendre que 03_aih_shared.js ait défini window.AIH.
        if (!window.AIH || !window.AIH.waitForApp) { setTimeout(aihBoot, 50); return; }
        window.AIH.waitForApp(function (app) {
            app.registerExtension({
                name: EXTENSION_NAME,

                async beforeRegisterNodeDef(nodeType, nodeData) {
                    if (!NODE_TYPES.includes(nodeData.name)) return;

                    const onNodeCreated = nodeType.prototype.onNodeCreated;
                    nodeType.prototype.onNodeCreated = function () {
                        const result = onNodeCreated?.apply(this, arguments);
                        const node = this;

                        // ── Widget natif `preset_id` : masqué, mais SÉRIALISÉ ──
                        const presetWidget = node.widgets?.find((w) => w.name === "preset_id");
                        hideWidget(node, "preset_id");

                        // ── Conteneur (une ligne : menu + libellé d'état) ──
                        const container = document.createElement("div");
                        Object.assign(container.style, {
                            width: "100%", height: "100%", boxSizing: "border-box",
                            padding: "4px 6px", background: "#2a2a2e", borderRadius: "6px",
                            display: "flex", flexDirection: "column", gap: "3px",
                            fontSize: "11px", color: "#ccc", overflow: "hidden",
                        });

                        const presetSelect = document.createElement("select");
                        Object.assign(presetSelect.style, {
                            width: "100%", padding: "3px 6px", borderRadius: "4px",
                            border: "1px solid #555", background: "#3a3a3e", color: "#ccc",
                            fontSize: "11px", cursor: "pointer",
                        });
                        presetSelect.innerHTML = "";
                        presetSelect.appendChild(mkOption(t("ma.presetPlaceholder"), "0"));
                        presetSelect.dataset.pendingId = String(
                            parseInt(presetWidget?.value, 10) || 0
                        );

                        const statusLine = document.createElement("div");
                        Object.assign(statusLine.style, {
                            fontSize: "10px", color: "#888", lineHeight: "1.25",
                            whiteSpace: "normal", overflowWrap: "anywhere",
                        });
                        statusLine.textContent = t("ma.statusIdle");

                        container.appendChild(presetSelect);
                        container.appendChild(statusLine);

                        // ── Ajout du DOM widget ──
                        // serialize=false ×2 : la valeur du DOM widget ne doit
                        // PAS atterrir dans widgets_values (elle décalerait le
                        // mapping positionnel des widgets natifs).
                        const widget = node.addDOMWidget(DOM_WIDGET_NAME, "div", container, {
                            serialize: false,
                            hideOnZoom: false,
                            getMinHeight: () => 52,
                        });
                        widget.serialize = false;
                        widget.options.serialize = false;

                        // ── Lecture de la liste des presets (serveur AIH) ──
                        const setStatus = (text) => { statusLine.textContent = text; };

                        async function populatePresets() {
                            const previous = presetSelect.value;
                            const pending = presetSelect.dataset.pendingId;
                            try {
                                const items = await remoteGet("presets");
                                if (!Array.isArray(items)) throw new Error("format inattendu");
                                presetSelect.innerHTML = "";
                                presetSelect.appendChild(mkOption(t("ma.presetPlaceholder"), "0"));
                                items
                                    .slice()
                                    .sort((a, b) => String(a.name || "").toLowerCase()
                                        .localeCompare(String(b.name || "").toLowerCase()))
                                    .forEach((item) => {
                                        // textContent (via mkOption) : aucun HTML interprété.
                                        presetSelect.appendChild(
                                            mkOption(String(item.name || `#${item.id}`), String(item.id))
                                        );
                                    });
                                if (items.length === 0) setStatus(t("ma.noPresets"));
                                else if (statusLine.dataset.error === "1") setStatus(t("ma.statusIdle"));
                                statusLine.dataset.error = "";
                                restoreFromNativeWidget(pending || previous);
                            } catch (err) {
                                // Serveur injoignable / non configuré : le menu
                                // reste utilisable (placeholder), l'erreur est DITE.
                                statusLine.dataset.error = "1";
                                setStatus(t("ma.serverUnavailable"));
                                console.warn("[AIH Mask Anything] presets indisponibles :", err);
                            }
                        }

                        /** Recale le menu sur la valeur du widget natif restauré. */
                        function restoreFromNativeWidget(preferred) {
                            const target = String(parseInt(presetWidget?.value, 10) || 0);
                            const has = (value) => [...presetSelect.options].some((o) => o.value === value);
                            const candidate = preferred && preferred !== "0" ? preferred : target;
                            if (candidate && candidate !== "0" && has(candidate)) {
                                presetSelect.value = candidate;
                                delete presetSelect.dataset.pendingId;
                                syncNativeWidget();
                                return true;
                            }
                            if (target !== "0" && has(target)) {
                                presetSelect.value = target;
                                return true;
                            }
                            presetSelect.value = "0";
                            return false;
                        }

                        /** Le menu pilote le widget natif (source de persistance). */
                        function syncNativeWidget() {
                            if (!presetWidget) return;
                            const value = parseInt(presetSelect.value, 10) || 0;
                            if (presetWidget.value !== value) {
                                presetWidget.value = value;
                                if (typeof presetWidget.callback === "function") presetWidget.callback(value);
                            }
                        }

                        presetSelect.addEventListener("change", syncNativeWidget);

                        // Rafraîchissement paresseux (comme les autres widgets du
                        // pack : TTL partagé, jamais d'appel réseau par clic).
                        let lastFetch = 0;
                        presetSelect.addEventListener("mousedown", () => {
                            const now = Date.now();
                            if (now - lastFetch < PRESETS_TTL) return;
                            lastFetch = now;
                            populatePresets();
                        });

                        // ── Restauration au chargement d'un workflow ──
                        // configure() peut restaurer widgets_values APRÈS ce hook :
                        // on retente quelques fois (même approche que l'enhancer).
                        node._aihMaskAnythingRestore = () => {
                            let tries = 0;
                            const retry = () => {
                                const ok = restoreFromNativeWidget();
                                if (!ok && ++tries < 20) setTimeout(retry, 150);
                            };
                            retry();
                        };

                        // ── Message visible à l'exécution (succès ET échec) ──
                        const previousExecuted = node.onExecuted;
                        node.onExecuted = function (output) {
                            if (typeof previousExecuted === "function") {
                                previousExecuted.call(this, output);
                            }
                            const status = output?.status;
                            if (!Array.isArray(status) || status.length === 0) return;
                            const message = String(status[0] ?? "");
                            setStatus(message);
                            if (message.includes("⚠️")) {
                                console.warn("[AIH Mask Anything]", message);
                            } else {
                                console.log("[AIH Mask Anything]", message);
                            }
                        };

                        // Premier peuplement (asynchrone, non bloquant).
                        populatePresets();
                        restoreFromNativeWidget();

                        return result;
                    };
                },

                // Appelé par ComfyUI APRÈS la restauration des workflows.
                loadedGraphNode(node) {
                    if (node && typeof node._aihMaskAnythingRestore === "function") {
                        setTimeout(() => node._aihMaskAnythingRestore(), 0);
                    }
                },
            });
        });
    }

    /** <option> construite au DOM (aucun HTML interprété, pas de `Option` global). */
    function mkOption(text, value) {
        const option = document.createElement("option");
        option.value = String(value);
        option.textContent = String(text);
        return option;
    }

    /**
     * Masque un widget natif sans le laisser capter les clics.
     *
     * DEUX flags sont nécessaires (source de référence 1.47.11) :
     *   - `widget.hidden` : lu par le canvas CLASSIQUE (`LGraphNode.getLayoutWidgets`);
     *   - `widget.options.hidden` : lu par le rendu VUE / Nodes 2.0
     *     (`useProcessedWidgets.isWidgetVisible` → `options.hidden`).
     * `display:none` seul laisserait le conteneur Vue intercepter les clics.
     */
    function hideWidget(node, name) {
        const widget = node.widgets?.find((w) => w.name === name);
        if (!widget) return;
        widget.options = widget.options || {};
        widget.hidden = true;
        widget.options.hidden = true;
        widget.computeSize = () => [0, -4];
        if (widget.element) widget.element.style.display = "none";
        if (widget.inputEl) widget.inputEl.style.display = "none";
        if (widget.parentEl) widget.parentEl.style.display = "none";
    }

    aihBoot();
})();
