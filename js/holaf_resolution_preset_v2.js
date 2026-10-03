/*
 * Copyright (C) 2025 Holaf
 * Compact custom UI for the AIH Resolution Preset v2 node (ComfyUI key:
 * "AIHResolutionPresetV2", see NODE_TYPES).
 *
 * The 7 real Python widgets stay in this.widgets (never destroyed): they
 * carry the workflow serialization. A single DOM widget (serialize:false)
 * mirrors them with a compact 3-row layout and pushes every change back to
 * the real widgets.
 */

import { app } from "../../scripts/app.js";

// ComfyUI class key of this node. The legacy pre-rename alias was removed
// from the Python registry (user decision): one key per node — old workflows
// referencing it must be redone.
const NODE_TYPES = ["AIHResolutionPresetV2"];

// Options mirrored from the Python INPUT_TYPES.
const MODEL_OPTIONS = ["SD1.5", "SDXL", "FLUX", "Z-Image", "Ideogram4", "Krea2 Turbo", "Nucleus-Image", "Qwen", "Megapixels"];
const ASPECT_OPTIONS = ["9:16", "2:3", "3:4", "4:5", "1:1", "Random"];
const MULTIPLE_OPTIONS = [8, 16, 32, 64];

// Map d'affichage landscape : seul le textContent de l'option change,
// la value interne reste le short de base ("9:16" etc.).
const LANDSCAPE_LABELS = { "9:16": "16:9", "2:3": "3:2", "3:4": "4:3", "4:5": "5:4", "1:1": "1:1", "Random": "Random" };

const DEFAULT_MEGAPIXELS = 2.50;
const DEFAULT_MULTIPLE = 16;

// Models without an HD (quality) variant: the HD checkbox is visible but disabled.
const NO_HD_MODELS = new Set(["SD1.5", "SDXL", "Nucleus-Image", "Qwen"]);

// Compact height (px) of the DOM widget area (3 rows + gaps + padding).
const DOM_WIDGET_HEIGHT = 96;

// --- Helpers ---

// Crée un <select> peuplé depuis une liste d'options.
function buildSelect(options) {
    const select = document.createElement("select");
    for (const opt of options) {
        const option = document.createElement("option");
        option.value = String(opt);
        option.textContent = String(opt);
        select.appendChild(option);
    }
    return select;
}

// Met à jour le texte affiché des options d'un <select> aspect_ratio selon
// le mode orientation. Seul option.textContent est réécrit — la value
// interne reste le short de base ("9:16" etc.) pour préserver la sérialisation.
function updateAspectLabels(select, isLandscape) {
    for (const option of select.options) {
        const base = option.value;
        const mapped = isLandscape ? (LANDSCAPE_LABELS[base] || base) : base;
        option.textContent = mapped;
    }
}

// Masque un widget réel sans le détruire (il reste la source de sérialisation).
function hideRealWidget(w) {
    if (!w) return;
    // ComfyUI récent : la propriété `hidden` retire le widget du layout ET du
    // dessin, tout en conservant sa sérialisation normale (type non modifié).
    w.hidden = true;
    // Fallback anciennes versions : on force une taille de hauteur nulle pour
    // que le widget n'occupe plus d'espace dans la node.
    if (!w._holaf_v2_hidden_fallback) {
        w._holaf_v2_hidden_fallback = true;
        w.computeSize = function () { return [0, -4]; };
    }
}

app.registerExtension({
    name: "AIH.ResolutionPresetV2",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (!NODE_TYPES.includes(nodeData.name)) return;

        // --- SETUP ON CREATION ---
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onNodeCreated) onNodeCreated.apply(this, arguments);

            const node = this;

            // --- Anti-double-init / anti-clone ---
            // UID unique par instance (et non node.id) : pendant la phase
            // configure() d'un clonage, le clone peut temporairement partager
            // le node.id de l'original. Même pattern que holaf_load_image_video.js.
            node._holaf_v2_uid = node._holaf_v2_uid || ('hrv2_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));

            // Garde anti double construction : le clonage de LiteGraph peut
            // rappeler onNodeCreated sur un même objet.
            if (node._holaf_v2_built || (node.widgets && node.widgets.some(w => w.name === 'holaf_v2_ui'))) return;

            // --- Récupération des 7 widgets réels (jamais détruits) ---
            const widgets = {};
            for (const w of node.widgets || []) widgets[w.name] = w;

            const required = ["model_type", "use_hd", "megapixels", "multiple_of", "aspect_ratio", "orientation", "use_image_ratio"];
            const missing = required.find(name => !widgets[name]);
            if (missing) {
                console.warn(`[AIH.ResolutionPresetV2] Widget '${missing}' introuvable — UI custom désactivée.`);
                return;
            }
            node._holaf_v2_built = true;

            // --- Masquage des widgets réels (sérialisation préservée) ---
            for (const name of required) hideRealWidget(widgets[name]);

            // --- Construction du DOM (3 lignes) ---
            // Conteneur principal : pointer-events none pour que le clic droit
            // (menu contextuel standard de ComfyUI) traverse vers le canvas.
            const mainContainer = document.createElement("div");
            Object.assign(mainContainer.style, {
                width: "100%",
                height: DOM_WIDGET_HEIGHT + "px",
                display: "flex",
                flexDirection: "column",
                gap: "4px",
                padding: "4px",
                boxSizing: "border-box",
                pointerEvents: "none"
            });

            // --- Ligne 1 : model_type + hd_area (HD | Megapixels) ---
            const row1 = document.createElement("div");
            Object.assign(row1.style, {
                display: "flex",
                gap: "4px",
                alignItems: "center",
                flex: "0 0 auto"
            });

            const modelSelect = buildSelect(MODEL_OPTIONS);
            Object.assign(modelSelect.style, {
                flex: "1 1 auto",
                minWidth: "0",
                fontSize: "11px",
                padding: "1px 2px",
                pointerEvents: "auto"
            });

            // hd_area : contient SOIT le checkbox HD, SOIT (mode Megapixels)
            // le champ megapixels + le select multiple_of.
            const hdArea = document.createElement("div");
            Object.assign(hdArea.style, {
                display: "flex",
                gap: "4px",
                alignItems: "center",
                flexShrink: "0"
            });

            // Mode normal : checkbox HD
            const hdLabel = document.createElement("label");
            Object.assign(hdLabel.style, {
                display: "inline-flex",
                alignItems: "center",
                gap: "3px",
                fontSize: "11px",
                whiteSpace: "nowrap",
                color: "#ddd",
                cursor: "pointer",
                pointerEvents: "auto",
                userSelect: "none"
            });
            const hdCheckbox = document.createElement("input");
            hdCheckbox.type = "checkbox";
            hdLabel.appendChild(hdCheckbox);
            hdLabel.appendChild(document.createTextNode("HD Version"));

            // Mode Megapixels : budget en MP + multiple
            const megapixelsInput = document.createElement("input");
            megapixelsInput.type = "number";
            megapixelsInput.step = "0.01";
            megapixelsInput.min = "0.25";
            megapixelsInput.max = "16";
            megapixelsInput.value = String(DEFAULT_MEGAPIXELS);
            Object.assign(megapixelsInput.style, {
                width: "52px",
                fontSize: "11px",
                padding: "1px 2px",
                pointerEvents: "auto",
                display: "none"
            });

            const multipleSelect = buildSelect(MULTIPLE_OPTIONS);
            Object.assign(multipleSelect.style, {
                width: "52px",
                fontSize: "11px",
                padding: "1px 2px",
                pointerEvents: "auto",
                display: "none"
            });

            hdArea.appendChild(hdLabel);
            hdArea.appendChild(megapixelsInput);
            hdArea.appendChild(multipleSelect);

            row1.appendChild(modelSelect);
            row1.appendChild(hdArea);

            // --- Ligne 2 : aspect_ratio + orientation ---
            const row2 = document.createElement("div");
            Object.assign(row2.style, {
                display: "flex",
                gap: "4px",
                alignItems: "center",
                flex: "0 0 auto"
            });

            const aspectSelect = buildSelect(ASPECT_OPTIONS);
            Object.assign(aspectSelect.style, {
                flex: "1 1 auto",
                minWidth: "0",
                fontSize: "11px",
                padding: "1px 2px",
                pointerEvents: "auto"
            });

            const orientationButton = document.createElement("button");
            Object.assign(orientationButton.style, {
                flexShrink: "0",
                fontSize: "11px",
                padding: "2px 6px",
                backgroundColor: "#333",
                color: "#fff",
                border: "1px solid #555",
                borderRadius: "3px",
                cursor: "pointer",
                pointerEvents: "auto"
            });

            row2.appendChild(aspectSelect);
            row2.appendChild(orientationButton);

            // --- Ligne 3 : use_image_ratio toggle ON/OFF ---
            const ratioButton = document.createElement("button");
            Object.assign(ratioButton.style, {
                width: "100%",
                flex: "0 0 auto",
                fontSize: "11px",
                padding: "2px 6px",
                backgroundColor: "#333",
                color: "#fff",
                border: "1px solid #555",
                borderRadius: "3px",
                cursor: "pointer",
                pointerEvents: "auto"
            });

            mainContainer.appendChild(row1);
            mainContainer.appendChild(row2);
            mainContainer.appendChild(ratioButton);

            // --- Widget DOM (serialize: false : ne porte aucune sérialisation) ---
            const domWidgetIdx = node.addDOMWidget("holaf_v2_ui", "div", mainContainer, {
                serialize: false,
                hideOnZoom: false
            });
            const domWidget = (typeof domWidgetIdx === 'number')
                ? node.widgets[domWidgetIdx]
                : node.widgets.find(w => w.name === "holaf_v2_ui");

            // Force une hauteur compacte et déterministe pour le widget DOM.
            if (domWidget) {
                domWidget.computeSize = function (width) {
                    const w = width || (node.size && node.size[0]) || 240;
                    return [w, DOM_WIDGET_HEIGHT];
                };
            }

            // Le wrapper créé par addDOMWidget DOIT aussi être en pointer-events
            // none sinon il bloque le menu contextuel LiteGraph.
            requestAnimationFrame(() => {
                const wrapper = mainContainer.parentElement;
                if (wrapper) wrapper.style.pointerEvents = "none";
            });

            // --- Sync widget réel -> DOM ---
            const setWidgetValue = (widget, value) => {
                if (!widget) return;
                widget.value = value;
                if (typeof widget.callback === "function") widget.callback(value);
                app.graph.setDirtyCanvas(true, true);
            };

            // Règle l'état visuel / désactivé des contrôles (règles dynamiques).
            const updateUI = () => {
                const model = modelSelect.value;
                const isMegapixels = model === "Megapixels";
                const useImageRatio = !!widgets.use_image_ratio.value;
                const aspect = aspectSelect.value;

                // Ligne 1 — HD vs Megapixels
                const showHd = !isMegapixels;
                hdLabel.style.display = showHd ? "inline-flex" : "none";
                megapixelsInput.style.display = isMegapixels ? "inline-block" : "none";
                multipleSelect.style.display = isMegapixels ? "inline-block" : "none";

                // Modèles sans variante HD : case visible mais désactivée.
                hdCheckbox.disabled = isMegapixels || NO_HD_MODELS.has(model);

                // Ligne 2 — aspect_ratio / orientation
                aspectSelect.disabled = useImageRatio;
                aspectSelect.style.opacity = useImageRatio ? "0.45" : "1";

                const orientationDisabled = useImageRatio || aspect === "Random";
                orientationButton.disabled = orientationDisabled;
                orientationButton.style.opacity = orientationDisabled ? "0.45" : "1";
                orientationButton.textContent = widgets.orientation.value ? "⇄ Landscape" : "⇄ Portrait";

                // Ligne 2b — libellés landscape des options aspect_ratio
                const isLandscape = !!widgets.orientation.value;
                updateAspectLabels(aspectSelect, isLandscape);

                // Ligne 3 — toggle Image Ratio
                ratioButton.textContent = useImageRatio ? "🔗 Use Image Ratio : ON" : "🔗 Use Image Ratio : OFF";
            };

            // Relit les widgets réels (valeurs restaurées au chargement) vers le DOM.
            const syncDomFromWidgets = () => {
                modelSelect.value = String(widgets.model_type.value);
                hdCheckbox.checked = !!widgets.use_hd.value;
                const mp = parseFloat(widgets.megapixels.value);
                megapixelsInput.value = Number.isFinite(mp) ? String(mp) : String(DEFAULT_MEGAPIXELS);
                multipleSelect.value = String(widgets.multiple_of.value ?? DEFAULT_MULTIPLE);
                aspectSelect.value = String(widgets.aspect_ratio.value);
                updateUI();
            };
            node._holaf_v2_sync = syncDomFromWidgets;

            // --- Événements DOM -> widget réel ---
            modelSelect.addEventListener("change", () => {
                setWidgetValue(widgets.model_type, modelSelect.value);
                updateUI();
            });

            hdCheckbox.addEventListener("change", () => {
                setWidgetValue(widgets.use_hd, hdCheckbox.checked);
                updateUI();
            });

            megapixelsInput.addEventListener("input", () => {
                const v = parseFloat(megapixelsInput.value);
                if (Number.isFinite(v)) setWidgetValue(widgets.megapixels, v);
            });
            megapixelsInput.addEventListener("change", () => {
                const v = parseFloat(megapixelsInput.value);
                if (Number.isFinite(v)) setWidgetValue(widgets.megapixels, v);
            });

            multipleSelect.addEventListener("change", () => {
                setWidgetValue(widgets.multiple_of, parseInt(multipleSelect.value, 10));
                updateUI();
            });

            aspectSelect.addEventListener("change", () => {
                setWidgetValue(widgets.aspect_ratio, aspectSelect.value);
                updateUI();
            });

            orientationButton.addEventListener("click", () => {
                setWidgetValue(widgets.orientation, !widgets.orientation.value);
                updateUI();
            });

            ratioButton.addEventListener("click", () => {
                setWidgetValue(widgets.use_image_ratio, !widgets.use_image_ratio.value);
                updateUI();
            });

            // --- Taille compacte par défaut ---
            const titleHeight = (typeof LiteGraph !== "undefined" && LiteGraph.NODE_TITLE_HEIGHT) || 30;
            node._holaf_v2_min_height = titleHeight + DOM_WIDGET_HEIGHT;
            const width = Math.max((node.size && node.size[0]) || 0, 250);
            if (typeof node.setSize === "function") {
                node.setSize([width, node._holaf_v2_min_height]);
            } else {
                node.size = [width, node._holaf_v2_min_height];
            }

            // Sync initiale (valeurs par défaut des widgets réels).
            syncDomFromWidgets();
        };

        // --- UPDATE ON LOAD ---
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            if (onConfigure) onConfigure.apply(this, arguments);

            // Après désérialisation : relire les valeurs des widgets réels
            // (restaurées par configure) vers le DOM puis rafraîchir l'UI.
            setTimeout(() => {
                this._holaf_v2_sync?.();

                // Garantit une hauteur minimale compacte après chargement.
                const minH = this._holaf_v2_min_height || ((typeof LiteGraph !== "undefined" && LiteGraph.NODE_TITLE_HEIGHT) || 30) + DOM_WIDGET_HEIGHT;
                if (this.size && this.size[1] < minH) {
                    if (typeof this.setSize === "function") this.setSize([this.size[0], minH]);
                    else this.size[1] = minH;
                }
            }, 0);
        };
    }
});
