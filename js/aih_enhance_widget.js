import "./aih_strings.js";
import { remoteGet, remotePost } from "./aih_fetch_bridge.js";

// Helper i18n central : traduit via AIH.I18n (clé brute si absente)
const t = (key, params) => {
    const I = window.AIH && window.AIH.I18n;
    return I && typeof I.t === "function" ? I.t(key, params) : key;
};

/**
 * AIH Prompt Enhancer — Custom DOM widget for ComfyUI node AIHEnhanceNode.
 *
 * Le DOM widget pilote les widgets natifs (template_id, preset_id, style_id)
 * qui sont serialises par ComfyUI. L'api_key est lue depuis
 * ComfyUI/user/default/aih_credentials.json cote Python.
 *
 * Le DOM widget :
 *   - Dropdown Preset IA (peuple depuis /api/presets) -> set widget preset_id
 *   - Dropdown Template (peuple depuis /api/prompts/templates) -> set widget template_id
 *   - Dropdown Style (peuple depuis /api/styles) -> set widget style_id
 *   - Bouton "Test enhance"
 *   - Textarea resultat
 */
(function() {
    // Accepted ComfyUI class keys for this node: canonical post-rename key plus
    // the legacy pre-rename alias. The Python side registers BOTH (legacy alias
    // kept so old workflows — node.type = "AIHEnhanceNode" — still load), and
    // beforeRegisterNodeDef fires once per definition, so both must match.
    const NODE_TYPES = ["AIHPromptEnhancer", "AIHEnhanceNode"];

    function aihBoot() {
        // Les fichiers d'extension ComfyUI ne sont pas chargés dans un ordre
        // garanti : attendre que 03_aih_shared.js / 04_aih_widget_base.js aient
        // défini window.AIH avant d'enregistrer l'extension.
        if (!window.AIH || !window.AIH.waitForApp) { setTimeout(aihBoot, 50); return; }
    window.AIH.waitForApp(function(app) {
        app.registerExtension({
        name: "AIH.Enhance",
        // TODO: Refactor to use AIH.registerWidget (see aih_widget_base.js)
        async beforeRegisterNodeDef(nodeType, nodeData) {
            if (!NODE_TYPES.includes(nodeData.name)) return; // TODO: this guard could be part of AIH.registerWidget config

            // ---- Debug : onConfigure (valeurs restaurées depuis le workflow) ----
            const origOnConfigureEnh = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function (data) {
                const result = origOnConfigureEnh ? origOnConfigureEnh.call(this, data) : undefined;
                if (data && data.widgets_values) {
                    // Associer les valeurs positionnelles aux noms de widgets (debug mapping)
                    var pairs = [];
                    var ws = this.widgets || [];
                    for (var i = 0; i < Math.max(ws.length, data.widgets_values.length); i++) {
                        var wname = ws[i] ? ws[i].name : '(index sans widget)';
                        var wval = data.widgets_values[i];
                        pairs.push(wname + ' = ' + (typeof wval === 'string' ? JSON.stringify(wval).substring(0, 60) : String(wval)));
                    }
                } else {
                }
                return result;
            };

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated?.apply(this, arguments);
                const node = this;
                let _aihRestored = false;

                // ---- Cacher les widgets natifs pilotés par le DOM ----
                const hideWidget = (n, name) => {
                    const w = n.widgets?.find(x => x.name === name);
                    if (w) {
                        // hidden=true : la frontend Vue ne rend PAS le widget (ni textarea, ni conteneur).
                        // display:none seul laisse le conteneur Vue capturer les clics (zone invisible).
                        w.hidden = true;
                        w.computeSize = () => [0, -4];  // 0 place visuelle (compressé)
                        if (w.element) w.element.style.display = "none";
                        if (w.inputEl) w.inputEl.style.display = "none";
                        if (w.parentEl) w.parentEl.style.display = "none";
                    }
                };
                ["template_id", "preset_id", "style_id", "style_shortlist", "output_format"].forEach(n => hideWidget(node, n));

                for (const inputName of ["template_id", "preset_id", "style_id"]) {
                    const slot = node.findInputSlot?.(inputName);
                    if (slot !== undefined && slot !== -1) {
                        node.removeInput(slot);
                    }
                }

                // Refs vers les widgets natifs
                const templateIdWidget = node.widgets?.find(x => x.name === "template_id");
                const presetIdWidget = node.widgets?.find(x => x.name === "preset_id");
                const styleIdWidget = node.widgets?.find(x => x.name === "style_id");

                // ---- Fixer la taille du textarea natif base_prompt ----
                const FIXED_TA_HEIGHT = 90;
                const basePromptWidget = node.widgets?.find(w => w.name === "base_prompt");
                if (basePromptWidget) {
                    const fixBasePrompt = () => {
                        if (basePromptWidget.inputEl) {
                            basePromptWidget.inputEl.style.height = FIXED_TA_HEIGHT + "px";
                            basePromptWidget.inputEl.style.minHeight = FIXED_TA_HEIGHT + "px";
                            basePromptWidget.inputEl.style.maxHeight = FIXED_TA_HEIGHT + "px";
                            basePromptWidget.inputEl.style.resize = "none";
                            basePromptWidget.inputEl.style.boxSizing = "border-box";
                        }
                    };
                    fixBasePrompt();
                    // Hauteur du wrapper = textarea (90px) + label (~20px) + padding (~8px) ≈ 118px
                    // Calcul explicite pour eviter les problemes de mesure asynchrone.
                    var textareaWrapperHeight = FIXED_TA_HEIGHT + 20;
                    basePromptWidget.computeSize = function() {
                        return [0, textareaWrapperHeight];
                    };
                }

                // ---- Helpers API ----
                const getApiUrl = () => {
                    // Aucune URL par défaut codée en dur : chaîne vide si non
                    // configuré (comportements dégradés ci-dessous).
                    try {
                        const cfg = JSON.parse(localStorage.getItem("AIH_config") || "{}");
                        const base = (cfg.serverUrl || "").replace(/\/+$/, "");
                        return base ? base + "/api" : "";
                    } catch {
                        return "";
                    }
                };
                const apiGet = async (path) => {
                    const baseUrl = getApiUrl();
                    if (!baseUrl) return []; // Serveur non configuré : listes vides
                    try {
                        return await remoteGet(`${baseUrl}/${path.replace(/^\//, "")}`);
                    } catch {
                        return [];
                    }
                };

                const _cache = (window.__AIH_cache = window.__AIH_cache || { presets: 0, styles: 0, tmpl: 0 });
                const CACHE_TTL = 15000;

                // ---- Populate generique ----
                async function populateSelect(select, apiPath, placeholder, cacheKey, valKey) {
                    select.innerHTML = `<option value="0">${placeholder}</option>`;
                    try {
                        const items = await apiGet(apiPath);
                        if (!Array.isArray(items)) return;
                        if (apiPath === "presets") {
                            try { node._aihPresets = items; } catch {}
                        }
                        // Trier par ordre alphabétique
                        items.sort(function(a, b) {
                            var nameA = (a.name || a.title || a.text || a).toString().toLowerCase();
                            var nameB = (b.name || b.title || b.text || b).toString().toLowerCase();
                            return nameA.localeCompare(nameB);
                        });
                        items.forEach(item => {
                            const o = document.createElement("option");
                            o.value = item[valKey || "id"];
                            o.textContent = item.name;
                            select.appendChild(o);
                        });
                    } catch {}
                }
                async function refreshIfStale(select, apiPath, cacheKey, placeholder, valKey) {
                    const now = Date.now();
                    if (now - (_cache[cacheKey] || 0) < CACHE_TTL) return;
                    _cache[cacheKey] = now;
                    const oldVal = select.value;
                    await populateSelect(select, apiPath, placeholder, cacheKey, valKey);
                    if ([...select.options].some(o => o.value === oldVal)) select.value = oldVal;
                }

                // ---- Container ----
                const container = document.createElement("div");
                Object.assign(container.style, {
                    width: "100%", height: "100%", padding: "8px", boxSizing: "border-box",
                    background: "#2a2a2e", borderRadius: "8px",
                    display: "flex", flexDirection: "column", gap: "6px",
                    fontSize: "12px", color: "#ccc", overflow: "hidden",
                });

                const mkLabel = (text) => {
                    const l = document.createElement("label");
                    l.textContent = text;
                    l.style.cssText = "font-size:10px;color:#888;display:block;margin-bottom:2px;";
                    return l;
                };

                // ---- Grille Template + Style (ligne 1) ----
                const tsRow = document.createElement("div");
                Object.assign(tsRow.style, { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" });

                const templateDiv = document.createElement("div");
                const templateSelect = document.createElement("select");
                Object.assign(templateSelect.style, { width: "100%", padding: "3px 6px", borderRadius: "4px", border: "1px solid #555", background: "#3a3a3e", color: "#ccc", fontSize: "11px", cursor: "pointer" });
                templateDiv.appendChild(mkLabel(t("en.template")));
                templateDiv.appendChild(templateSelect);
                tsRow.appendChild(templateDiv);

                const styleDiv = document.createElement("div");
                const styleRow = document.createElement("div");
                Object.assign(styleRow.style, { display: "flex", gap: "4px", alignItems: "center", width: "100%" });
                const styleSelect = document.createElement("select");
                Object.assign(styleSelect.style, { width: "100%", padding: "3px 6px", borderRadius: "4px", border: "1px solid #555", background: "#3a3a3e", color: "#ccc", fontSize: "11px", cursor: "pointer" });
                styleDiv.appendChild(mkLabel(t("en.style")));
                styleRow.appendChild(styleSelect);
                styleDiv.appendChild(styleRow);
                tsRow.appendChild(styleDiv);
                // Style picker avec config modal
                var stylePicker = AIH.PickerConfig.setup({
                    select: styleSelect,
                    node: node,
                    widgetName: 'style_id',
                    listWidgetName: 'style_shortlist',
                    apiPath: 'styles',
                    label: 'Style',
                    placeholder: t("en.stylePlaceholder"),
                    idField: 'id',
                    nameField: 'name',
                    authorField: 'owner_name',
                    descField: 'style_text',
                    fetchItems: apiGet,
                });
                container.appendChild(tsRow);

                // ---- Preset IA (ligne 2, full width) ----
                const presetDiv = document.createElement("div");
                const presetRow = document.createElement("div");
                Object.assign(presetRow.style, { display: "flex", gap: "4px", alignItems: "center" });
                const presetSelect = document.createElement("select");
                Object.assign(presetSelect.style, { width: "100%", padding: "3px 6px", borderRadius: "4px", border: "1px solid #555", background: "#3a3a3e", color: "#ccc", fontSize: "11px", cursor: "pointer" });
                presetSelect.style.flex = "1";
                presetDiv.appendChild(mkLabel(t("en.presetLabel")));
                presetRow.appendChild(presetSelect);

                // ---- Format (rich/basic) à côté du Preset IA ----
                const formatSelect = document.createElement("select");
                Object.assign(formatSelect.style, { width: "90px", padding: "3px 6px", borderRadius: "4px", border: "1px solid #555", background: "#3a3a3e", color: "#ccc", fontSize: "11px", cursor: "pointer" });
                const fmtRich = document.createElement("option");
                fmtRich.value = "rich";
                fmtRich.textContent = "rich";
                const fmtBasic = document.createElement("option");
                fmtBasic.value = "basic";
                fmtBasic.textContent = "basic";
                formatSelect.appendChild(fmtRich);
                formatSelect.appendChild(fmtBasic);
                presetRow.appendChild(formatSelect);

                presetDiv.appendChild(presetRow);
                container.appendChild(presetDiv);

                // ---- Bouton Test Enhance ----
                const enhanceBtn = document.createElement("button");
                enhanceBtn.textContent = t("en.testEnhance");
                Object.assign(enhanceBtn.style, {
                    width: "100%", padding: "6px", borderRadius: "4px",
                    border: "none", background: "var(--holaf-accent-color, #D8700D)", color: "white",
                    fontSize: "11px", fontWeight: "600", cursor: "pointer",
                });
                enhanceBtn.onmouseenter = () => enhanceBtn.style.background = "var(--holaf-accent-color, #D8700D)";
                enhanceBtn.onmouseleave = () => enhanceBtn.style.background = "var(--holaf-accent-color, #D8700D)";
                container.appendChild(enhanceBtn);

                // ---- Textarea resultat ----
                const resultTextarea = document.createElement("textarea");
                Object.assign(resultTextarea.style, {
                    width: "100%",
                    flex: "1", minHeight: "80px",
                    borderRadius: "4px", border: "1px solid #555",
                    padding: "4px", background: "#1a1a1e", color: "#fff",
                    fontSize: "11px", resize: "none", boxSizing: "border-box",
                });
                resultTextarea.placeholder = t("en.resultPlaceholder");
                resultTextarea.readOnly = true;
                container.appendChild(mkLabel(t("en.promptPositive")));
                container.appendChild(resultTextarea);

                // ---- Ajout au node ----
                const widget = node.addDOMWidget("AIH_Enhance", "div", container, {
                    serialize: false,
                    hideOnZoom: false,
                    getMinHeight: () => 248,  // ← minHeight pour computeLayoutSize (widget "growable")
                });
                // Sérialisation : poser LES DEUX flags.
                // widget.serialize contrôle la persistance workflow (LGraphNode.serialize/configure)
                // widget.options.serialize contrôle le prompt API (executionUtil)
                // Sans widget.serialize=false, le DOM widget est sérialisé dans widgets_values,
                // créant une valeur fantôme qui décale le mapping positionnel des autres widgets.
                widget.serialize = false;
                widget.options.serialize = false;
                // ---- Constantes de hauteur (conservées pour référence) ----
                // La hauteur du DOM widget est désormais gérée nativement par la frontend
                // via getMinHeight / computeLayoutSize. Ces constantes ne sont plus utilisées
                // dans computeSize/onResize/rAF mais conservées pour d'éventuels usages futurs.
                const DOM_WIDGET_HEIGHT = 248; // +8px: minimum node height increase
                const CHROME = 70; // titre node + padding
                // Somme des hauteurs des widgets natifs visibles (utilise computeSize de chaque widget)
                function fixedWidgetsHeight() {
                    let h = 0;
                    for (const w of node.widgets) {
                        if (w === widget) continue;
                        if (w.hidden) continue;
                        let wh = 26;
                        if (w.computeSize) {
                            try {
                                const s = w.computeSize();
                                if (Array.isArray(s) && s[1] !== undefined) wh = s[1];
                            } catch {}
                        }
                        // Widgets compressés (computeSize [0,-4], sans hidden=true) : 0 px
                        if (wh <= 0) continue;
                        h += wh;
                    }
                    return h;
                }

                // ---- Sync des widgets natifs ----
                function syncNativeWidgets(force) {
                    if (!_aihRestored && !force) {
                        return;
                    }
                    const set = (name, val) => {
                        const w = node.widgets?.find(x => x.name === name);
                        if (!w) return;
                        w.value = val;
                        if (w.callback) w.callback(val);
                    };
                    set("template_id", parseInt(templateSelect.value) || 0);
                    set("preset_id", parseInt(presetSelect.value) || 0);
                    set("output_format", formatSelect.value || "rich");
                    var sval;
                    if (styleSelect.value === '_random') {
                        sval = -1;  // sentinelle : random persistant
                    } else {
                        sval = parseInt(styleSelect.value) || 0;
                    }
                    set("style_id", sval);
                }

                templateSelect.onchange = () => syncNativeWidgets(true);
                presetSelect.onchange = () => syncNativeWidgets(true);
                styleSelect.onchange = () => syncNativeWidgets(true);
                formatSelect.onchange = () => syncNativeWidgets(true);

                // ---- Restoration depuis widgets natifs ----
                function restoreFromNativeWidgets() {
                    let restored = false;
                    if (templateIdWidget) {
                        const tid = parseInt(templateIdWidget.value) || 0;
                        const currentDropdownVal = parseInt(templateSelect.value) || 0;
                        if (currentDropdownVal > 0 && currentDropdownVal !== tid) {
                            // User has selected a different value in the dropdown — respect their choice
                            templateIdWidget.value = currentDropdownVal;
                            if (templateIdWidget.callback) templateIdWidget.callback(currentDropdownVal);
                            restored = true;
                        } else if (tid > 0 && [...templateSelect.options].some(o => o.value === String(tid))) {
                            templateSelect.value = String(tid);
                            restored = true;
                        } else if (tid === 0) {
                            templateSelect.value = "0";
                        } else {
                        }
                    }
                    if (presetIdWidget) {
                        const pid = parseInt(presetIdWidget.value) || 0;
                        const currentDropdownVal = parseInt(presetSelect.value) || 0;
                        if (currentDropdownVal > 0 && currentDropdownVal !== pid) {
                            // User has selected a different value in the dropdown — respect their choice
                            presetIdWidget.value = currentDropdownVal;
                            if (presetIdWidget.callback) presetIdWidget.callback(currentDropdownVal);
                            restored = true;
                        } else if (pid > 0 && [...presetSelect.options].some(o => o.value === String(pid))) {
                            presetSelect.value = String(pid);
                            restored = true;
                        } else if (pid === 0) {
                            presetSelect.value = "0";
                        } else {
                        }
                    }
                    if (styleIdWidget) {
                        const sid = parseInt(styleIdWidget.value);
                        const currentDropdownRaw = styleSelect.value;
                        const currentDropdownVal = currentDropdownRaw === '_random' ? -1 : (parseInt(currentDropdownRaw) || 0);
                        if (currentDropdownVal !== 0 && currentDropdownVal !== sid && !isNaN(currentDropdownVal)) {
                            // User has selected a different value in the dropdown — respect their choice
                            var syncVal = currentDropdownRaw === '_random' ? -1 : currentDropdownVal;
                            styleIdWidget.value = syncVal;
                            if (styleIdWidget.callback) styleIdWidget.callback(syncVal);
                            restored = true;
                        } else if (sid === -1 && [...styleSelect.options].some(o => o.value === '_random')) {
                            styleSelect.value = '_random';
                            restored = true;
                        } else if (sid > 0 && [...styleSelect.options].some(o => o.value === String(sid))) {
                            styleSelect.value = String(sid);
                            restored = true;
                        } else if (sid === 0 || isNaN(sid)) {
                            styleSelect.value = "0";
                        } else {
                        }
                    }
                    // Format (rich/basic) : restauration directe depuis le widget natif
                    const outputFormatWidget = node.widgets?.find(x => x.name === "output_format");
                    if (outputFormatWidget) {
                        const fmt = outputFormatWidget.value;
                        if (fmt === "rich" || fmt === "basic") {
                            formatSelect.value = fmt;
                        } else {
                            formatSelect.value = "rich";
                        }
                    }
                    _aihRestored = true;
                    return restored;
                }

                node._aihRestore = function () {
                    let ra = 0;
                    const retry = () => {
                        const restored = restoreFromNativeWidgets();
                        if (restored) syncNativeWidgets();
                        if (!restored && ++ra < 20) setTimeout(retry, 300);
                    };
                    retry();
                };

                // ---- Initialisation ----
                Promise.all([
                    stylePicker.init(),
                    populateSelect(templateSelect, "prompts/templates", t("en.templatePlaceholder"), "tmpl"),
                    populateSelect(presetSelect, "presets", t("en.presetPlaceholder"), "presets"),
                ]).then(() => {
                    const restored = restoreFromNativeWidgets();
                    if (restored) syncNativeWidgets();
                    else {
                        // Dropdown couldn't restore from native widget (option not found yet)
                        // Only update DOM display, DON'T overwrite native widget values
                        // (delayedRestore will retry and sync when dropdown is populated)
                        templateSelect.value = String(parseInt(templateIdWidget?.value) || 0);
                        presetSelect.value = String(parseInt(presetIdWidget?.value) || 0);
                        // Gérer la sentinelle -1 (random persistant)
                        var sval = parseInt(styleIdWidget?.value);
                        if (sval === -1 && [...styleSelect.options].some(o => o.value === '_random')) {
                            styleSelect.value = '_random';
                        } else {
                            styleSelect.value = String(sval || 0);
                        }
                        // NE PAS appeler syncNativeWidgets() ici — cela écraserait les valeurs
                        // natives restaurées par configure() avec 0 (dropdown non peuplé)
                    }
                    let ra = 0;
                    function delayedRestore() {
                        const r = restoreFromNativeWidgets();
                        if (r) syncNativeWidgets();
                        if (++ra < 20) setTimeout(delayedRestore, 300);
                    }
                    setTimeout(delayedRestore, 100);
                });

                // ---- mousedown : refresh cache ----
                templateSelect.addEventListener("mousedown", () => refreshIfStale(templateSelect, "prompts/templates", "tmpl", t("en.templatePlaceholder")));
                presetSelect.addEventListener("mousedown", () => refreshIfStale(presetSelect, "presets", "presets", t("en.presetPlaceholder")));

                // ---- Resize : largeur minimum seulement ----
                // La hauteur du container est gérée nativement par la frontend (computeLayoutSize)
                // via getMinHeight → le widget est "growable" et grandit avec la node.
                const onResize = node.onResize;
                node.onResize = function (size) {
                    const r = onResize?.apply(this, arguments);
                    container.style.width = (size[0] - 20) + "px";
                    tsRow.style.gridTemplateColumns = "1fr 1fr";
                    return r;
                };
                // Appliquer la taille initiale
                requestAnimationFrame(() => {
                    container.style.width = (node.size[0] - 20) + "px";
                });
                tsRow.style.gridTemplateColumns = "1fr 1fr";

                // ---- Test Enhance ----
                enhanceBtn.onclick = async () => {
                    const get = (name) => node.widgets?.find(w => w.name === name);
                    const basePrompt = (get("base_prompt")?.value || "").trim();
                    const specialInstructions = (get("special_instructions")?.value || "").trim();
                    const seedW = get("seed")?.value;
                    const elementsRaw = get("elements")?.value || "[]";

                    let elements = [];
                    try {
                        const parsed = JSON.parse(elementsRaw);
                        if (Array.isArray(parsed)) elements = parsed;
                        else if (parsed?.elements) elements = parsed.elements;
                    } catch {
                        // Texte brut
                    }

                    // NEW: Fallback sur le widget natif si le dropdown n'est pas encore peuplé
                    // (async fetch pas terminé au premier clic après reboot ComfyUI)
                    let templateId = parseInt(templateSelect.value) || 0;
                    if (templateId === 0 && templateIdWidget) {
                        templateId = parseInt(templateIdWidget.value) || 0;
                    }
                    let presetId = parseInt(presetSelect.value) || 0;
                    if (presetId === 0 && presetIdWidget) {
                        presetId = parseInt(presetIdWidget.value) || 0;
                    }
                    // Style: si le dropdown n'a que le placeholder, utiliser le widget natif
                    let styleId = parseInt(styleSelect.value) || null;
                    if (styleSelect.value === '_random' || styleId === -1) {
                        var realOptions = Array.from(styleSelect.options)
                            .filter(o => o.value !== '0' && o.value !== '_random' && o.value !== '')
                            .map(o => parseInt(o.value));
                        if (realOptions.length > 0) {
                            styleId = realOptions[Math.floor(Math.random() * realOptions.length)];
                        }
                    }
                    if ((styleId === null || styleId === 0) && styleIdWidget) {
                        const nativeStyleId = parseInt(styleIdWidget.value);
                        if (nativeStyleId === -1) {
                            // Random: need options to pick from, skip if not populated
                            var realOpts = Array.from(styleSelect.options)
                                .filter(o => o.value !== '0' && o.value !== '_random' && o.value !== '')
                                .map(o => parseInt(o.value));
                            if (realOpts.length > 0) {
                                styleId = realOpts[Math.floor(Math.random() * realOpts.length)];
                            }
                        } else if (nativeStyleId > 0) {
                            styleId = nativeStyleId;
                        }
                    }

                    const payload = {
                        text: basePrompt,
                        seed: seedW > 0 ? seedW : null,
                        template_id: templateId,
                        preset_id: presetId || null,
                        style_id: styleId,
                        output_format: formatSelect.value || "rich",
                        special_instructions: specialInstructions,
                    };
                    if (elements.length > 0) {
                        payload.ep_elements = elements;
                    } else if (elementsRaw.trim() && elementsRaw !== "[]") {
                        payload.text = (basePrompt + "\n\n" + elementsRaw).trim();
                    }

                    if (!payload.text && (!payload.ep_elements || payload.ep_elements.length === 0)) {
                        resultTextarea.value = t("en.needInput");
                        return;
                    }

                    // Vérifier si l'input image est connecté (ne peut pas être envoyé en mode Test)
                    const imageSlot = node.inputs?.find(i => i.name === "image");
                    if (imageSlot && imageSlot.link != null) {
                        resultTextarea.value = t("en.imageNote");
                    } else {
                        resultTextarea.value = t("en.enhancing");
                    }
                    // Comportement dégradé : sans serveur configuré, message
                    // explicite au lieu d'un POST vers une destination arbitraire.
                    if (!getApiUrl()) {
                        resultTextarea.value = t("en.notConfigured");
                        return;
                    }
                    try {
                        const resp = await remotePost(`${getApiUrl()}/enhance`, payload, { raw: true });
                        if (!resp.ok) {
                            const respText = await resp.text().catch(() => "");
                            throw new Error(`HTTP ${resp.status}: ${respText.substring(0, 200)}`);
                        }
                        const text = await resp.text();
                        let output = "";
                        for (const line of text.split("\n")) {
                            if (!line.trim()) continue;
                            try {
                                const chunk = JSON.parse(line);
                                if (chunk.status === "done") {
                                    output = chunk.output || "";
                                } else if (chunk.status === "error") {
                                    throw new Error(chunk.error || t("en.unknownError"));
                                }
                            } catch (e) {
                                if (e instanceof SyntaxError) continue;
                                throw e;
                            }
                        }
                        resultTextarea.value = output;
                        syncNativeWidgets();
                    } catch (err) {
                        resultTextarea.value = t("en.errorPrefix", { error: err.message });
                    }
                };

                // ---- onExecuted ----
                const origExec = node.onExecuted;
                node.onExecuted = function (output) {
                    if (origExec) origExec.call(this, output);
                    const arr = output?.prompt;
                    if (Array.isArray(arr) && arr.length > 0) {
                        resultTextarea.value = String(arr[0]);
                    }
                };

                return r;
            };
        },

        async loadedGraphNode(node) {
            if (node._aihRestore) {
                setTimeout(() => node._aihRestore(), 0);
            }
        },
    });
    });
    }
    aihBoot();
})();
