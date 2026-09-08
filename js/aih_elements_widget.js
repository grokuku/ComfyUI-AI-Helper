import "./aih_dialog.js";
import "./aih_strings.js";
import { showToast as bridgeShowToast } from "./aih_toast_bridge.js";

// Helper i18n central : traduit via AIH.I18n (clé brute si absente)
const t = (key, params) => {
    const I = window.AIH && window.AIH.I18n;
    return I && typeof I.t === "function" ? I.t(key, params) : key;
};

/**
 * AIH Elements Picker — Custom widget for ComfyUI node.
 *
 * Flux de données :
 *   - "Test generation" : JS appelle l'API → aperçu instantané dans le textarea
 *   - "Run" (workflow) : Python lit _elements_json + _api_config, appelle l'API
 *     lui-même avec le seed → résultat déterministe affiché via onExecuted
 *
 * Les widgets _elements_json et _api_config sont masqués dans l'UI ComfyUI
 * mais sérialisés dans le workflow pour que Python y ait accès.
 */

const STORAGE_KEY = "AIH_config";

// Accepted ComfyUI class keys for this node: canonical post-rename key plus
// the legacy pre-rename alias. The Python side registers BOTH (legacy alias
// kept so old workflows — node.type = "AIHElementsNode" — still load), and
// beforeRegisterNodeDef fires once per definition, so both must match.
const NODE_TYPES = ["AIHElementsPicker", "AIHElementsNode"];

function getConfig() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
    catch { return {}; }
}

function getApiUrl() {
    // Aucune URL par défaut codée en dur : chaîne vide si non configuré
    // (apiCall renvoie alors une erreur explicite).
    try {
        const cfg = JSON.parse(localStorage.getItem("AIH_config") || "{}");
        const base = (cfg.serverUrl || "").replace(/\/+$/, "");
        return base ? base + "/api" : "";
    } catch {
        return "";
    }
}

function getApiKey() { return window.AIH.getApiKey(); }

function apiHeaders() {
    const h = { "Content-Type": "application/json" };
    const key = getApiKey();
    if (key) h["Authorization"] = `Bearer ${key}`;
    return h;
}

async function apiCall(method, path, body) {
    const baseUrl = getApiUrl();
    if (!baseUrl) {
        throw new Error(t("aih.notConfiguredError"));
    }
    const opts = { method, headers: apiHeaders() };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(`${baseUrl}/${path.replace(/^\//, "")}`, opts);
    if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}: ${txt.substring(0, 200)}`);
    }
    return resp.json();
}

// Cacher un widget ComfyUI : reste dans node.widgets (sérialisé) mais invisible dans l'UI.
// IMPORTANT : ne PAS changer widget.type en "hidden" car ComfyUI le
// désérialiserait à vide. On n'utilise PAS non plus le flag hidden du widget
// car la nouvelle frontend Vue exclut les widgets hidden de widgets_values
// au chargement (données perdues). On passe par le CSS + computeSize.
function hideWidget(node, name) {
    const w = node.widgets?.find(x => x.name === name);
    if (w) {
        // hidden=true : la frontend Vue ne rend PAS le widget (ni textarea,
        // ni conteneur). display:none seul laisse le conteneur Vue capturer
        // les clics (zone invisible). hidden=true est sûr car serialize()
        // ne vérifie que serialize===false (pas hidden), donc le widget
        // reste sérialisé et restauré normalement.
        w.hidden = true;
        w.computeSize = () => [0, -4];
        if (w.element) w.element.style.display = "none";
        if (w.inputEl) w.inputEl.style.display = "none";
        if (w.parentEl) w.parentEl.style.display = "none";
        return w;
    }
    return null;
}

// Parse la syntaxe ||concept[:count][;hint[:count]] utilisée dans le
// test button de l'Elements Picker.  Retourne {concept, count, hint} ou null.
function _parseConceptSyntax(text, defaultCount) {
    if (!text || !text.startsWith('||')) return null;
    var body = text.substring(2).trim();
    if (!body) return null;

    // Split par premier ;
    var semiIdx = body.indexOf(';');
    var conceptPart, hintPart;
    if (semiIdx >= 0) {
        conceptPart = body.substring(0, semiIdx);
        hintPart = body.substring(semiIdx + 1);
    } else {
        conceptPart = body;
        hintPart = null;
    }

    // Parse concept[:count]
    var concept = conceptPart.trim();
    var count = null;
    var colonIdx = conceptPart.lastIndexOf(':');
    if (colonIdx >= 0) {
        var afterColon = conceptPart.substring(colonIdx + 1).trim();
        if (/^\d+$/.test(afterColon)) {
            concept = conceptPart.substring(0, colonIdx).trim();
            count = parseInt(afterColon);
        }
    }

    // Parse hint[:count]
    var hint = null;
    if (hintPart) {
        hint = hintPart.trim();
        var hintColonIdx = hintPart.lastIndexOf(':');
        if (hintColonIdx >= 0) {
            var afterHintColon = hintPart.substring(hintColonIdx + 1).trim();
            if (/^\d+$/.test(afterHintColon)) {
                hint = hintPart.substring(0, hintColonIdx).trim();
                if (count === null) count = parseInt(afterHintColon);
            }
        }
    }

    if (count === null) count = defaultCount;
    return { concept: concept, count: count, hint: hint };
}

// Polling auto-contenu pour attendre window.app (évite la dépendance
// à AIH.waitForApp qui peut charger après ce fichier)
(function aihBoot() {
    var app = window.app || (window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app);
    if (!app || !app.graph) {
        setTimeout(aihBoot, 100);
        return;
    }

    app.registerExtension({
        name: "AIH.Elements",
        // TODO: Refactor to use AIH.registerWidget (see aih_widget_base.js)
        async beforeRegisterNodeDef(nodeType, nodeData) {
            if (!NODE_TYPES.includes(nodeData.name)) return; // TODO: this guard could be part of AIH.registerWidget config

            // ---- Restauration par contenu (pattern AGENTS.md) ----
            // La frontend Vue exclut les widgets cachés (display:none) du mapping
            // positionnel de widgets_values. _elements_json étant caché, on le
            // restaure en cherchant sa valeur PAR CONTENU dans data.widgets_values.
            const origOnConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function(data) {
                const result = origOnConfigure ? origOnConfigure.call(this, data) : undefined;
                if (data && data.widgets_values) {
                    for (var i = 0; i < data.widgets_values.length; i++) {
                        var val = data.widgets_values[i];
                        if (typeof val === 'string' && val.indexOf('"elements"') >= 0) {
                            this._pendingElementsJson = val;
                            var ej = this.widgets?.find(w => w.name === "_elements_json");
                            if (ej) {
                                ej.value = val;
                            } else {
                            }
                            break;
                        }
                    }
                } else {
                }
                return result;
            };

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated?.apply(this, arguments);
                const node = this;

                // ---- Debug : état initial des widgets au moment de la création ----

                // ---- Masquer le widget sérialisé _elements_json ----
                // (plus de _api_config : api_key/url sont lus cote Python depuis
                // le fichier de credentials)
                hideWidget(node, "_elements_json");

                // Empêcher le feedback loop de hauteur : sans widgets_start_y, la
                // frontend fait size[1] += widgets_height à chaque computeSize
                // (cumulatif → node qui grandit indéfiniment, zone invisible de
                // ~1300px qui bloque les clics). Avec widgets_start_y, le calcul
                // devient Math.max(size[1], widgets_height + widgets_start_y).
                node.widgets_start_y = 52;

                // ---- Supprimer la socket d'entrée de _elements_json ----
                {
                    const slot = node.findInputSlot?.("_elements_json");
                    if (slot !== undefined && slot !== -1) {
                        node.removeInput(slot);
                    }
                }

                // Le widget seed est géré nativement par ComfyUI.

                // Stockage local des éléments
                if (!node._aihElements) node._aihElements = [];
                node._aihDirty = false;
                node._aihLoadedPresetName = null;
                // Flag de restauration : false tant que la vraie valeur du workflow
                // n'a pas été lue depuis _elements_json. Évite que syncElementsWidget
                // écrase la valeur sérialisée par {"elements":[]} au chargement.
                // Ne PAS confondre avec node._aihRestore (la fonction hook, ligne ~1518).
                let _aihRestored = false;

                // ---- Sync les widgets sérialisés ----
                function syncElementsWidget(force) {
                    if (!_aihRestored && !force) {
                        return;  // ne pas écraser avant la restauration
                    }
                    const w = node.widgets?.find(x => x.name === "_elements_json");
                    if (!w) {
                        return;
                    }
                    w.value = JSON.stringify({
                        elements: node._aihElements.map(e => {
                            const base = { visible: e.visible !== false };
                            if (e.type === "filter") {
                                return { ...base, type: "filter", id: e.id, name: e.name || "", author: e.author || "", is_public: !!e.is_public, hint: e.hint || "" };
                            }
                            if (e.type === "text") {
                                // "raw" est le format attendu par le backend /api/generate
                                return { ...base, type: "raw", text: e.text };
                            }
                            return { ...base, ...e };
                        }),
                        random_count: randCb.checked ? (parseInt(randN.value) || 3) : 0,
                        random_sfw: sfwCb.checked,
                        random_nsfw: nsfwCb.checked,
                        preset_id: parseInt(presetSelect.value) || 0,
                        llm_default_count: parseInt(llmCountInput.value) || 10,
                        brain_toggles: node._aihElements.map(e => !!e.brain),
                    });
                }

                function syncApiConfigWidget() {
                    // No-op: _api_config supprime, api_key/url lus depuis le
                    // fichier de credentials cote Python.
                }

                // ---- Preset IA dropdown + llm_default_count (en haut du widget) ----
                // Pattern identique au enhance widget : cache 15s, refresh sur mousedown.
                const _presetCache = (window.__AIH_cache = window.__AIH_cache || { presets: 0, styles: 0, tmpl: 0 });
                const PRESET_CACHE_TTL = 15000;

                const presetRow = document.createElement("div");
                Object.assign(presetRow.style, {
                    display: "flex", gap: "4px", alignItems: "center", marginBottom: "8px",
                    flex: "0 0 auto",
                });

                const presetSelect = document.createElement("select");
                presetSelect.innerHTML = '<option value="0">' + t("el.presetPlaceholder") + '</option>';
                Object.assign(presetSelect.style, {
                    flex: "1", padding: "3px 6px", borderRadius: "4px",
                    border: "1px solid #555", background: "#3a3a3e",
                    color: "#ccc", fontSize: "11px", cursor: "pointer",
                });

                const llmCountLabel = document.createElement("span");
                llmCountLabel.textContent = "||N:";
                llmCountLabel.title = t("el.llmCountTitle");
                Object.assign(llmCountLabel.style, {
                    fontSize: "10px", color: "#888", whiteSpace: "nowrap", flexShrink: "0",
                });

                const llmCountInput = document.createElement("input");
                llmCountInput.type = "number";
                llmCountInput.value = "10";
                llmCountInput.min = 1;
                llmCountInput.max = 999;
                Object.assign(llmCountInput.style, {
                    width: "40px", padding: "2px 4px", borderRadius: "4px",
                    border: "1px solid #555", background: "#1a1a1e",
                    color: "#fff", fontSize: "11px", textAlign: "center", flexShrink: "0",
                });

                presetRow.appendChild(presetSelect);
                presetRow.appendChild(llmCountLabel);
                presetRow.appendChild(llmCountInput);

                // ---- EP Preset row (save/load presets locaux) ----
                const epPresetRow = document.createElement("div");
                Object.assign(epPresetRow.style, {
                    display: "flex", gap: "4px", alignItems: "center", marginBottom: "8px",
                    flex: "0 0 auto",
                });

                const epPresetSelect = document.createElement("select");
                epPresetSelect.innerHTML = '<option value="">' + t("el.epPresetPlaceholder") + '</option>';
                Object.assign(epPresetSelect.style, {
                    flex: "1", padding: "3px 6px", borderRadius: "4px",
                    border: "1px solid #555", background: "#3a3a3e",
                    color: "#ccc", fontSize: "11px", cursor: "pointer",
                });

                const epPresetSaveBtn = document.createElement("button");
                epPresetSaveBtn.textContent = t("el.save");
                Object.assign(epPresetSaveBtn.style, {
                    padding: "3px 10px", borderRadius: "4px",
                    border: "1px solid #555", background: "#3a3a3e",
                    color: "#ccc", fontSize: "11px",
                    flexShrink: "0", opacity: "0.4", cursor: "not-allowed",
                });

                epPresetRow.appendChild(epPresetSelect);
                epPresetRow.appendChild(epPresetSaveBtn);

                // ---- Dirty flag management ----
                function markDirty() {
                    node._aihDirty = true;
                    epPresetSaveBtn.style.opacity = "1";
                    epPresetSaveBtn.style.cursor = "pointer";
                    epPresetSaveBtn.dataset.active = "1";
                }

                function clearDirty() {
                    node._aihDirty = false;
                    epPresetSaveBtn.style.opacity = "0.4";
                    epPresetSaveBtn.style.cursor = "not-allowed";
                    delete epPresetSaveBtn.dataset.active;
                }

                // ---- EP preset list (distant backend via apiCall) ----
                let _epPresetNames = [];

                /**
                 * Migration automatique des presets locaux (ancien fichier
                 * ComfyUI/user/default/aih/aih_elements_presets.json) vers le
                 * backend distant.  Ne s'exécute qu'une seule fois grâce à un
                 * flag localStorage.
                 */
                async function migrateLocalPresets() {
                    if (localStorage.getItem("AIH_elements_presets_migrated") === "1") return;
                    try {
                        // Vérifier si l'ancienne route locale répond (= fichier local existe)
                        var resp = await fetch("/aih/elements/presets");
                        if (!resp.ok) {
                            // Route absente → rien à migrer, marquer comme fait
                            localStorage.setItem("AIH_elements_presets_migrated", "1");
                            return;
                        }
                        var data = await resp.json();
                        var localPresets = (data && data.presets) ? data.presets : [];
                        if (!Array.isArray(localPresets) || localPresets.length === 0) {
                            // Fichier vide ou inexistant → marquer comme fait
                            localStorage.setItem("AIH_elements_presets_migrated", "1");
                            return;
                        }

                        console.log("[AIH Elements] Migrating " + localPresets.length + " local preset(s) to backend…");
                        var migrated = 0;
                        var failed = 0;
                        for (var i = 0; i < localPresets.length; i++) {
                            var p = localPresets[i];
                            try {
                                // p.data peut être une chaîne JSON (valeur brute du widget)
                                // ou un objet.  On l'envoie telle quelle : le backend
                                // gère maintenant les deux cas (parsing automatique).
                                await apiCall("POST", "elements-presets", {
                                    name: p.name,
                                    data: p.data
                                });
                                migrated++;
                                console.log("[AIH Elements] Migrated preset: " + p.name);
                            } catch (e) {
                                failed++;
                                console.error("[AIH Elements] Failed to migrate preset " + (p.name || "#" + i) + ":", e);
                            }
                        }

                        // ── Ne nettoyer le fichier local QUE si tous les presets
                        //    ont été migrés avec succès.  Sinon on risque de perdre
                        //    les presets qui n'ont pas pu être envoyés au backend.
                        if (failed === 0) {
                            try {
                                await fetch("/aih/elements/presets", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ action: "cleanup" })
                                });
                            } catch (e) {
                                /* non bloquant */
                            }
                            localStorage.setItem("AIH_elements_presets_migrated", "1");
                            console.log("[AIH Elements] Local presets migration complete (" + migrated + "/" + localPresets.length + " migrated).");
                        } else {
                            // Au moins un preset a échoué : on NE supprime PAS le
                            // fichier local et on NE marque PAS la migration comme
                            // terminée, pour permettre une nouvelle tentative au
                            // prochain chargement.
                            console.warn("[AIH Elements] Migration incomplete (" + migrated + "/" + localPresets.length + " succeeded, " + failed + " failed). Local file preserved, will retry next time.");
                        }
                    } catch (e) {
                        // Erreur inattendue (route locale inexistante, réseau, etc.)
                        // Ne PAS marquer comme migré : on réessaiera au prochain
                        // chargement.  Si la route locale n'existe vraiment pas,
                        // le fetch échouera à nouveau rapidement (non bloquant).
                        console.warn("[AIH Elements] Migration deferred (will retry):", e);
                    }
                }

                async function populateEpPresets() {
                    try {
                        // ── Migration des presets locaux (une seule fois) ──
                        await migrateLocalPresets();

                        // apiCall retourne déjà le JSON parsé (un tableau)
                        const presets = await apiCall("GET", "elements-presets");
                        if (!Array.isArray(presets)) return;
                        // Trier par ordre alphabétique
                        presets.sort(function(a, b) {
                            var nameA = (a.name || a.title || a.text || a).toString().toLowerCase();
                            var nameB = (b.name || b.title || b.text || b).toString().toLowerCase();
                            return nameA.localeCompare(nameB);
                        });
                        _epPresetNames = presets.map(p => p.name);
                        const oldVal = epPresetSelect.value;
                        epPresetSelect.innerHTML = '<option value="">' + t("el.epPresetPlaceholder") + '</option>';
                        presets.forEach(p => {
                            const o = document.createElement("option");
                            o.value = p.name;
                            o.textContent = p.name;
                            epPresetSelect.appendChild(o);
                        });
                        if (oldVal && [...epPresetSelect.options].some(o => o.value === oldVal)) {
                            epPresetSelect.value = oldVal;
                        }
                    } catch (err) {
                        console.error("[AIH] populateEpPresets failed:", err);
                    }
                }

                epPresetSelect.addEventListener("mousedown", () => populateEpPresets());

                function loadEpPreset(presetDataRaw) {
                    try {
                        const data = typeof presetDataRaw === "string" ? JSON.parse(presetDataRaw) : presetDataRaw;
                        // Appliquer les éléments
                        if (data.elements && Array.isArray(data.elements)) {
                            node._aihElements = data.elements.map(e => {
                                const visible = e.visible !== false;
                                if (e.type === "filter") {
                                    return {
                                        type: "filter", id: e.id, name: e.name || t("el.filterLabel", { id: e.id }),
                                        author: e.author || "?", is_public: !!e.is_public, hint: e.hint || "", visible,
                                    };
                                }
                                if (e.type === "text" || e.type === "raw") {
                                    return { type: "text", text: e.text || "", visible };
                                }
                                return { ...e, visible };
                            });
                        }
                        // Restaurer random checkboxes
                        if (data.random_sfw !== undefined) sfwCb.checked = !!data.random_sfw;
                        if (data.random_nsfw !== undefined) nsfwCb.checked = !!data.random_nsfw;
                        if (data.random_count > 0) {
                            randCb.checked = true;
                            randN.value = data.random_count;
                        } else {
                            randCb.checked = false;
                        }
                        // Restaurer preset_id (dropdown LLM)
                        if (data.preset_id !== undefined) {
                            const pid = String(data.preset_id);
                            if (pid !== "0" && [...presetSelect.options].some(o => o.value === pid)) {
                                presetSelect.value = pid;
                            } else if (pid !== "0") {
                                presetSelect.dataset.pendingId = pid;
                            } else {
                                presetSelect.value = "0";
                            }
                        }
                        // Restaurer llm_default_count
                        if (data.llm_default_count !== undefined) {
                            llmCountInput.value = String(data.llm_default_count);
                        }
                        // Restaurer brain_toggles
                        if (data.brain_toggles && Array.isArray(data.brain_toggles)) {
                            data.brain_toggles.forEach((brain, i) => {
                                if (node._aihElements[i]) {
                                    node._aihElements[i].brain = !!brain;
                                }
                            });
                        }
                        renderList();
                        syncElementsWidget(true);
                        clearDirty();
                        node._aihLoadedPresetName = epPresetSelect.value;
                    } catch (err) {
                        showToast("error", t("el.loadPresetFailed", { error: err.message }));
                    }
                }

                epPresetSelect.onchange = async () => {
                    const name = epPresetSelect.value;
                    if (!name) return;
                    try {
                        const presets = await apiCall("GET", "elements-presets");
                        const preset = presets.find(p => p.name === name);
                        if (!preset || !preset.data) return;
                        loadEpPreset(preset.data);
                    } catch (err) {
                        console.error("[AIH] EP preset load failed:", err);
                    }
                };

                epPresetSaveBtn.onclick = () => {
                    if (!node._aihDirty) return;
                    syncElementsWidget(true); // s'assurer que _elements_json est à jour
                    const datalistOptions = _epPresetNames.map(n => '<option value="' + esc(n) + '">').join("");
                    const presetName = node._aihLoadedPresetName || "";

                    const html = '<div style="display:flex;flex-direction:column;gap:12px;padding:12px;">' +
                        '<label style="font-size:12px;color:#aaa;">' + t("el.presetNameLabel") + '</label>' +
                        '<input list="ep-preset-names" id="ep-preset-input" ' +
                        'style="padding:6px 8px;border-radius:4px;border:1px solid #555;background:#1a1a1e;color:#fff;font-size:12px;" ' +
                        'placeholder="' + t("el.presetNamePlaceholder") + '" value="' + esc(presetName) + '" />' +
                        '<datalist id="ep-preset-names">' + datalistOptions + '</datalist>' +
                        '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
                        '<button id="ep-preset-delete" style="padding:6px 12px;border-radius:4px;border:1px solid #f87171;background:transparent;color:#f87171;font-size:11px;cursor:pointer;">' + t("el.delete") + '</button>' +
                        '<button id="ep-preset-cancel" style="padding:6px 12px;border-radius:4px;border:1px solid #555;background:#3a3a3e;color:#ccc;font-size:11px;cursor:pointer;">' + t("el.cancel") + '</button>' +
                        '<button id="ep-preset-save" style="padding:6px 12px;border-radius:4px;border:none;background:var(--aih-accent, #D8700D);color:white;font-size:11px;cursor:pointer;font-weight:600;">' + t("el.save") + '</button>' +
                        '</div></div>';

                    var m = aihOpenModalV2({
                        title: t("el.saveTitle"),
                        content: html,
                        width: "360px",
                        height: "auto",
                        resizable: false,
                        storageKey: null,
                    });

                    const input = m.modal.querySelector("#ep-preset-input");
                    const saveBtn = m.modal.querySelector("#ep-preset-save");
                    const cancelBtn = m.modal.querySelector("#ep-preset-cancel");
                    const deleteBtn = m.modal.querySelector("#ep-preset-delete");

                    function updateDeleteBtn() {
                        const name = input.value.trim();
                        if (name && _epPresetNames.includes(name)) {
                            deleteBtn.style.display = "";
                        } else {
                            deleteBtn.style.display = "none";
                        }
                    }
                    input.addEventListener("input", updateDeleteBtn);
                    updateDeleteBtn();
                    input.focus();
                    input.select();

                    cancelBtn.onclick = () => m.close();

                    saveBtn.onclick = async () => {
                        const name = input.value.trim();
                        if (!name) return;
                        const ej = node.widgets?.find(w => w.name === "_elements_json");
                        // ej.value est une chaîne JSON (valeur brute du widget).
                        // La parser en objet pour que le backend la stocke correctement
                        // sans double-encodage.
                        let presetData = {};
                        if (ej && ej.value) {
                            try { presetData = JSON.parse(ej.value); }
                            catch (_) { presetData = ej.value; /* fallback: envoyer la chaîne */ }
                        }
                        try {
                            await apiCall("POST", "elements-presets", { name: name, data: presetData });
                            node._aihLoadedPresetName = name;
                            clearDirty();
                            await populateEpPresets();
                            epPresetSelect.value = name;
                            m.close();
                        } catch (err) {
                            showToast("error", t("el.saveFailed", { error: err.message }));
                        }
                    };

                    deleteBtn.onclick = async () => {
                        const name = input.value.trim();
                        if (!name || !_epPresetNames.includes(name)) return;
                        if (!(await window.AIH.confirm(t("el.deletePresetConfirm", { name: name })))) return;
                        try {
                            await apiCall("DELETE", "elements-presets/" + encodeURIComponent(name));
                            _epPresetNames = _epPresetNames.filter(n => n !== name);
                            await populateEpPresets();
                            if (node._aihLoadedPresetName === name) {
                                node._aihLoadedPresetName = null;
                                epPresetSelect.value = "";
                            }
                            updateDeleteBtn();
                            showToast("info", t("el.presetDeleted", { name: name }));
                        } catch (err) {
                            showToast("error", t("el.deleteFailed", { error: err.message }));
                        }
                    };

                    input.addEventListener("keydown", (e) => {
                        if (e.key === "Enter") { e.preventDefault(); saveBtn.click(); }
                        if (e.key === "Escape") { e.preventDefault(); m.close(); }
                    });
                };

                // Peuplement initial
                populateEpPresets();

                presetSelect.onchange = () => { syncElementsWidget(true); markDirty(); };
                llmCountInput.onchange = () => { syncElementsWidget(true); markDirty(); };
                llmCountInput.oninput = () => { syncElementsWidget(true); markDirty(); };

                // ---- Peupler le dropdown preset depuis /api/presets ----
                async function populatePresets() {
                    try {
                        const items = await apiCall("GET", "presets");
                        if (!Array.isArray(items)) return;
                        const oldVal = presetSelect.value;
                        const pendingId = presetSelect.dataset.pendingId;
                        presetSelect.innerHTML = '<option value="0">' + t("el.presetPlaceholder") + '</option>';
                        // Trier par ordre alphabétique
                        items.sort(function(a, b) {
                            var nameA = (a.name || a.title || a.text || a).toString().toLowerCase();
                            var nameB = (b.name || b.title || b.text || b).toString().toLowerCase();
                            return nameA.localeCompare(nameB);
                        });
                        items.forEach(item => {
                            const o = document.createElement("option");
                            o.value = item.id;
                            o.textContent = item.name;
                            presetSelect.appendChild(o);
                        });
                        // Restaurer l'ancienne valeur ou la valeur en attente (workflow reload)
                        const restoreVal = pendingId || oldVal;
                        if (restoreVal && restoreVal !== "0" && [...presetSelect.options].some(o => o.value === String(restoreVal))) {
                            presetSelect.value = String(restoreVal);
                            delete presetSelect.dataset.pendingId;
                            syncElementsWidget();
                        } else if (oldVal && [...presetSelect.options].some(o => o.value === oldVal)) {
                            presetSelect.value = oldVal;
                        }
                    } catch (err) {
                        // Silencieux : le dropdown reste avec le placeholder
                    }
                }

                async function refreshPresetsIfStale() {
                    const now = Date.now();
                    if (now - (_presetCache.presets || 0) < PRESET_CACHE_TTL) return;
                    _presetCache.presets = now;
                    await populatePresets();
                }

                presetSelect.addEventListener("mousedown", () => refreshPresetsIfStale());

                // Peuplement initial
                populatePresets();

                // Sync initial
                syncApiConfigWidget();

                // ========================================
                // LAYOUT : flex column, la liste s'étend,
                // le résultat est fixé en bas
                // ========================================

                const container = document.createElement("div");
                Object.assign(container.style, {
                    width: "100%",
                    height: "100%",         // Remplit l'espace alloué par ComfyUI
                    background: "#2a2a2e",
                    borderRadius: "8px",
                    padding: "8px",
                    boxSizing: "border-box",
                    fontSize: "12px",
                    color: "#ccc",
                    display: "flex",
                    flexDirection: "column",
                    overflow: "hidden",
                });

                // ---- Toolbar (hauteur fixe) ----
                const tb = document.createElement("div");
                Object.assign(tb.style, {
                    display: "flex", gap: "4px", marginBottom: "8px",
                    flex: "0 0 auto",
                });

                const mkBtn = (text, primary) => {
                    const b = document.createElement("button");
                    b.textContent = text;
                    Object.assign(b.style, {
                        flex: "1", padding: "4px 8px", borderRadius: "4px",
                        border: primary ? "none" : "1px solid #555",
                        fontSize: "11px", cursor: "pointer",
                        background: primary ? "var(--aih-accent, #D8700D)" : "#3a3a3e",
                        color: primary ? "white" : "#ccc",
                        fontWeight: primary ? "600" : "normal",
                    });
                    b.onmouseenter = () => {
                        if (primary) b.style.background = "var(--aih-accent-hover, #F08020)";
                        else b.style.background = "#4a4a4e";
                    };
                    b.onmouseleave = () => {
                        if (primary) b.style.background = "var(--aih-accent, #D8700D)";
                        else b.style.background = "#3a3a3e";
                    };
                    return b;
                };

                const addFilterBtn = mkBtn(t("el.addFilter"));
                const addTextBtn = mkBtn(t("el.addText"));

                tb.appendChild(addFilterBtn);
                tb.appendChild(addTextBtn);

                // ---- Liste des éléments (flex: grow, absorbe l'espace) ----
                const listEl = document.createElement("div");
                Object.assign(listEl.style, {
                    flex: "1 1 0",           // Prend tout l'espace dispo
                    minHeight: "40px",       // Hauteur mini pour être utilisable
                    overflowY: "auto",
                    marginBottom: "8px",
                    border: "1px dashed #555",
                    borderRadius: "4px",
                    padding: "4px",
                    fontSize: "11px",
                    color: "#666",
                });

                function renderList() {
                    const items = node._aihElements || [];
                    if (items.length === 0) {
                        listEl.innerHTML = t("el.emptyList");
                        listEl.style.color = "#666";
                        return;
                    }
                    listEl.style.color = "#ccc";
                    listEl.innerHTML = "";
                    items.forEach((item, idx) => {
                        const row = document.createElement("div");
                        Object.assign(row.style, {
                            display: "flex", alignItems: "center", gap: "4px",
                            padding: "3px 4px", borderRadius: "3px", marginBottom: "2px",
                            background: item.type === "filter" ? "#2d3748" : "#1a365d",
                            border: "1px solid #555",
                        });

                        row.className = "aih-element-row";
                        const isHidden = item.visible === false;
                        if (isHidden) {
                            row.style.opacity = "0.45";
                            row.style.background = "#252836";
                            row.style.border = "1px solid #444";
                        }

                        // Poignée de drag (⠿)
                        const grip = document.createElement("span");
                        grip.textContent = "⠿";
                        Object.assign(grip.style, {
                            cursor: "grab", color: "#666", fontSize: "10px", flexShrink: "0",
                            userSelect: "none", marginRight: "2px", touchAction: "none",
                        });
                        grip.title = t("el.dragTitle");
                        grip.onpointerdown = (e) => startDrag(e, idx, row);

                        // Icône œil (visible / masqué)
                        // Meme pattern que la croix de suppression (del.onclick) :
                        // un simple <button> avec onclick direct. Les tentatives
                        // avec mousedown/pointerdown empechaient le click de se
                        // synthetiser correctement dans le DOM widget ComfyUI.
                        const eyeBtn = document.createElement("button");
                        eyeBtn.type = "button";
                        eyeBtn.textContent = isHidden ? "🙈" : "👁";
                        Object.assign(eyeBtn.style, {
                            background: "none", border: "none", color: "#ccc",
                            cursor: "pointer", fontSize: "12px", padding: "0 2px", flexShrink: "0",
                        });
                        eyeBtn.title = isHidden ? t("el.eyeShow") : t("el.eyeHide");
                        eyeBtn.onclick = () => {
                            // Toggle : visible (true ou undefined) → false, false → true
                            if (item.visible === false) {
                                item.visible = true;
                            } else {
                                item.visible = false;
                            }
                            markDirty();
                            renderList();
                            syncElementsWidget(true);
                        };

                        row.appendChild(grip);
                        row.appendChild(eyeBtn);

                        // Icône cerveau (toggle LLM intelligent par liste)
                        const brainBtn = document.createElement("button");
                        brainBtn.type = "button";
                        const brainOn = !!item.brain;
                        brainBtn.textContent = "🧠";
                        Object.assign(brainBtn.style, {
                            background: "none", border: "none",
                            cursor: "pointer", fontSize: "12px", padding: "0 2px",
                            flexShrink: "0",
                            filter: brainOn ? "none" : "grayscale(1) opacity(0.4)",
                            color: brainOn ? "var(--aih-accent, #D8700D)" : "#666",
                        });
                        brainBtn.title = brainOn ? t("el.brainOn") : t("el.brainOff");
                        brainBtn.onclick = () => {
                            item.brain = !item.brain;
                            markDirty();
                            renderList();
                            syncElementsWidget(true);
                        };
                        row.appendChild(brainBtn);

                        const iconSpan = document.createElement("span");
                        iconSpan.style.cssText = "flex-shrink:0;";
                        iconSpan.textContent = item.type === "filter" ? "🔽" : "📝";
                        row.appendChild(iconSpan);

                        // Contenu : input texte pour "text", label pour "filter"
                        if (item.type === "text") {
                            const textInput = document.createElement("input");
                            textInput.type = "text";
                            textInput.value = item.text || "";
                            textInput.placeholder = t("el.textPlaceholder");
                            Object.assign(textInput.style, {
                                flex: "1", minWidth: "0",
                                padding: "2px 6px", borderRadius: "3px",
                                border: "1px solid #555", background: "#1a1a1e",
                                color: "#fff", fontSize: "11px",
                            });
                            // Badge montrant le nombre de choix par bloc {}
                            const choiceBadge = document.createElement("span");
                            Object.assign(choiceBadge.style, {
                                fontSize: "9px", color: "var(--aih-accent, #D8700D)", whiteSpace: "nowrap",
                                flexShrink: "0", padding: "0 2px",
                            });
                            function updateChoiceBadge() {
                                const blocks = parseChoiceBlocks(textInput.value);
                                if (blocks.length === 0) {
                                    choiceBadge.textContent = "";
                                    choiceBadge.title = "";
                                } else {
                                    const counts = blocks.map(b => b.length);
                                    choiceBadge.textContent = "🔀" + counts.join("·");
                                    choiceBadge.title = t("el.choiceBadgeTitle", {
                                        count: blocks.length,
                                        blocks: blocks.map(b => "{" + b.join("::") + "}").join(" "),
                                    });
                                }
                            }
                            textInput.oninput = () => {
                                item.text = textInput.value;
                                updateChoiceBadge();
                                markDirty();
                                syncElementsWidget(true);
                            };
                            row.appendChild(textInput);
                            row.appendChild(choiceBadge);
                            updateChoiceBadge();
                        } else {
                            // Filtre : nom + meta
                            const label = document.createElement("span");
                            label.style.cssText = "flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
                            label.textContent = item.name || t("el.filterLabel", { id: item.id });
                            row.appendChild(label);

                            // Hint input optionnel (à côté du nom du filtre)
                            var hintInput = document.createElement("input");
                            hintInput.type = "text";
                            hintInput.placeholder = t("el.hintPlaceholder");
                            hintInput.value = item.hint || "";
                            hintInput.style.cssText = "flex:1; min-width:60px; background:#1a1a1e; border:1px solid #444; color:#ccc; border-radius:3px; padding:2px 6px; font-size:11px;";
                            hintInput.oninput = function() {
                                item.hint = this.value;
                                markDirty();
                                syncElementsWidget(true);
                            };
                            row.appendChild(hintInput);

                            if (item.author) {
                                const meta = document.createElement("span");
                                meta.style.cssText = "font-size:10px;color:#999;white-space:nowrap;flex-shrink:0;";
                                meta.textContent = `${item.author} ${item.is_public ? "🌐" : "🔒"}`;
                                row.appendChild(meta);
                            } else if (item.is_public !== undefined) {
                                const vis = document.createElement("span");
                                vis.style.cssText = "flex-shrink:0;";
                                vis.textContent = item.is_public ? "🌐" : "🔒";
                                row.appendChild(vis);
                            }
                        }

                        // Bouton supprimer
                        const del = document.createElement("button");
                        del.textContent = "✕";
                        Object.assign(del.style, {
                            background: "none", border: "none", color: "#f87171",
                            cursor: "pointer", fontSize: "11px", padding: "0 2px", flexShrink: "0",
                        });
                        del.onclick = () => {
                            items.splice(idx, 1);
                            markDirty();
                            renderList();
                            syncElementsWidget(true);
                        };
                        row.appendChild(del);
                        listEl.appendChild(row);
                    });
                }

                // ---- Drag & drop reorder (pointer events) ----
                // Le handle ⠿ de chaque ligne declenche un drag fluide :
                // - clone fantome qui suit le curseur, a taille identique aux autres lignes
                // - placeholder reduit (fine barre) indiquant l'emplacement de drop
                // - les elements glissent avec une petite animation FLIP quand le
                //   placeholder change de position
                // - reordonnancement deterministe de node._aihElements
                let dragState = null;

                function startDrag(e, startIdx, row) {
                    e.preventDefault();
                    e.stopPropagation();

                    const items = node._aihElements || [];
                    if (items.length < 2) return;

                    const rect = row.getBoundingClientRect();
                    const ghost = row.cloneNode(true);
                    Object.assign(ghost.style, {
                        position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`,
                        width: `${rect.width}px`, opacity: "0.92", pointerEvents: "none",
                        zIndex: "10000",
                        // Ombre tres legere, pas de scale : le fantome a exactement
                        // la meme taille que les autres elements.
                        boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
                    });
                    document.body.appendChild(ghost);

                    // Extraire la ligne reelle du DOM.

                    // Placeholder en cadre pointille bleu, hauteur reduite (moitie
                    // d'une ligne), pour bien marquer l'emplacement de drop.
                    const rowHeight = row.getBoundingClientRect().height;
                    const placeholder = document.createElement("div");
                    placeholder.className = "aih-drag-placeholder";
                    Object.assign(placeholder.style, {
                        height: `${rowHeight / 2}px`,
                        border: "2px dashed var(--aih-accent, #D8700D)", borderRadius: "4px",
                        background: "rgba(216,112,13,0.10)",
                        marginBottom: "2px", pointerEvents: "none",
                        transition: "transform 0.12s ease-out",
                    });

                    listEl.insertBefore(placeholder, row.nextSibling);
                    row.remove();

                    // Activer les transitions sur toutes les lignes restantes.
                    listEl.querySelectorAll(".aih-element-row").forEach(r => {
                        r.style.transition = "transform 0.15s ease-out";
                    });

                    const gripInGhost = ghost.querySelector("span");
                    if (gripInGhost) gripInGhost.style.color = "#fff";

                    dragState = {
                        startIdx,
                        currentIdx: startIdx,
                        ghost,
                        row,
                        draggedEls: { row },
                        offsetY: e.clientY - rect.top,
                    };

                    document.addEventListener("pointermove", onPointerMove);
                    document.addEventListener("pointerup", onPointerUp);
                    document.addEventListener("pointercancel", onPointerUp);
                    try {
                        grip.setPointerCapture(e.pointerId);
                    } catch (_) {}
                }

                // Drapeau anti-clignotement : pendant qu'une animation FLIP est
                // en cours, les getBoundingClientRect() des lignes renvoient des
                // positions intermediaires, ce qui peut faire osciller le calcul
                // de targetIdx. On bloque la detection jusqu'a la fin de la
                // transition.
                let isAnimating = false;

                function onPointerMove(e) {
                    if (!dragState) return;
                    e.preventDefault();
                    const { ghost, offsetY } = dragState;
                    ghost.style.top = `${e.clientY - offsetY}px`;

                    // Pendant l'animation, ne pas recalculer la position cible.
                    if (isAnimating) return;

                    const rows = Array.from(listEl.querySelectorAll(".aih-element-row"));
                    let targetIdx = rows.length;
                    for (let i = 0; i < rows.length; i++) {
                        const rc = rows[i].getBoundingClientRect();
                        const mid = rc.top + rc.height / 2;
                        if (e.clientY < mid) {
                            targetIdx = i;
                            break;
                        }
                    }

                    if (targetIdx !== dragState.currentIdx) {
                        const placeholder = listEl.querySelector(".aih-drag-placeholder");
                        if (placeholder) {
                            flipMovePlaceholder(targetIdx, placeholder);
                        }
                        dragState.currentIdx = targetIdx;
                    }
                }

                // Deplace le placeholder dans le DOM en animant les autres lignes
                // via la technique FLIP (First/Last/Invert/Play).
                function flipMovePlaceholder(targetIdx, placeholder) {
                    isAnimating = true;
                    const rows = Array.from(listEl.querySelectorAll(".aih-element-row"));

                    // 1. First : positions avant le deplacement.
                    const before = rows.map(r => r.getBoundingClientRect().top);

                    // 2. Last : deplacer le placeholder dans le DOM.
                    if (targetIdx >= rows.length) {
                        listEl.appendChild(placeholder);
                    } else {
                        listEl.insertBefore(placeholder, rows[targetIdx]);
                    }

                    // 3. Invert : calculer le delta pour chaque ligne et appliquer
                    //    un transform qui l'amene a sa position d'origine.
                    rows.forEach((r, i) => {
                        const after = r.getBoundingClientRect().top;
                        const delta = before[i] - after;
                        if (delta !== 0) {
                            r.style.transition = "none";
                            r.style.transform = `translateY(${delta}px)`;
                        }
                    });

                    // 4. Play : forcer un reflow puis retirer le transform pour
                    //    declencher la transition.
                    listEl.offsetHeight; // force reflow
                    rows.forEach((r) => {
                        r.style.transition = "transform 0.15s ease-out";
                        r.style.transform = "";
                    });

                    // Liberer le drapeau quand la transition est terminee.
                    // On ecoute la derniere ligne (forcement animee) ; fallback
                    // timeout au cas ou transitionend ne fire pas.
                    let released = false;
                    const release = () => {
                        if (released) return;
                        released = true;
                        isAnimating = false;
                    };
                    const lastRow = rows[rows.length - 1];
                    if (lastRow) {
                        lastRow.addEventListener("transitionend", release, { once: true });
                    }
                    setTimeout(release, 180);
                }

                function onPointerUp(e) {
                    if (!dragState) return;
                    document.removeEventListener("pointermove", onPointerMove);
                    document.removeEventListener("pointerup", onPointerUp);
                    document.removeEventListener("pointercancel", onPointerUp);

                    const { startIdx, currentIdx, ghost, row, draggedEls } = dragState;
                    ghost.remove();
                    const placeholder = listEl.querySelector(".aih-drag-placeholder");

                    const items = node._aihElements || [];
                    if (currentIdx !== startIdx && currentIdx >= 0 && currentIdx <= items.length) {
                        // currentIdx est déjà calculé sur le DOM réduit (l'élément dragged
                        // a été retiré). Donc c'est le bon index direct dans le tableau
                        // après splice(startIdx, 1) — aucun ajustement nécessaire.
                        const [moved] = items.splice(startIdx, 1);
                        items.splice(currentIdx, 0, moved);
                    }

                    // Nettoyer les transitions forcees sur les lignes restantes.
                    listEl.querySelectorAll(".aih-element-row").forEach(r => {
                        r.style.transition = "";
                        r.style.transform = "";
                    });

                    // Replacer la ligne reelle a la position du placeholder
                    if (placeholder) {
                        listEl.insertBefore(draggedEls.row, placeholder);
                        placeholder.remove();
                    } else {
                        listEl.appendChild(draggedEls.row);
                    }
                    dragState = null;
                    if (currentIdx !== startIdx) markDirty();
                    syncElementsWidget(true);
                }


                // ---- Add saved filter ----
                addFilterBtn.onclick = async () => {
                    try {
                        const [filters, me] = await Promise.all([
                            apiCall("GET", "filters"),
                            apiCall("GET", "auth/me").catch(() => null),
                        ]);
                        const currentUserId = me?.id || null;
                        showFilterPicker(filters, currentUserId, (filter) => {
                            node._aihElements.push({
                                type: "filter",
                                id: filter.id,
                                name: filter.name,
                                author: filter.user_id === currentUserId ? t("el.filterAuthorYou") : (filter.owner_name || filter.user_id?.substring(0,6) || "?"),
                                is_public: !!filter.is_public,
                            });
                            markDirty();
                            renderList();
                            syncElementsWidget(true);
                        });
                    } catch (err) {
                        showToast("error", t("el.loadFiltersFailed", { error: err.message }));
                    }
                };

                // ---- Add custom text ----
                addTextBtn.onclick = () => {
                    node._aihElements.push({ type: "text", text: "" });
                    markDirty();
                    renderList();
                    syncElementsWidget(true);
                    // Focus le dernier input texte
                    setTimeout(() => {
                        const inputs = listEl.querySelectorAll("input[type='text']");
                        const last = inputs[inputs.length - 1];
                        if (last) last.focus();
                    }, 0);
                };

                // ---- Random + SFW/NSFW row (hauteur fixe) ----
                const randRow = document.createElement("div");
                Object.assign(randRow.style, {
                    display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", marginBottom: "4px",
                    flex: "0 0 auto",
                });

                const randCb = document.createElement("input");
                randCb.type = "checkbox";
                randCb.checked = false;
                randCb.id = "aih-rand-" + node.id;

                const randN = document.createElement("input");
                randN.type = "number";
                randN.value = "3";
                Object.assign(randN.style, {
                    width: "40px", padding: "2px 4px", borderRadius: "4px",
                    border: "1px solid #555", background: "1a1a1e",
                    color: "#fff", fontSize: "11px", textAlign: "center",
                });
                randN.min = 1;
                randN.max = 20;

                const randLabel = document.createElement("label");
                randLabel.style.fontSize = "11px";
                randLabel.htmlFor = randCb.id;
                randLabel.textContent = t("el.addRandom");

                // Séparateur visuel
                const randSep = document.createElement("span");
                randSep.textContent = "|";
                Object.assign(randSep.style, { color: "#555", fontSize: "11px" });

                // ---- SFW / NSFW checkboxes ----
                const sfwCb = document.createElement("input");
                sfwCb.type = "checkbox";
                sfwCb.checked = true;
                sfwCb.id = "aih-sfw-" + node.id;
                const sfwLabel = document.createElement("label");
                sfwLabel.style.fontSize = "11px";
                sfwLabel.htmlFor = sfwCb.id;
                sfwLabel.textContent = "SFW";
                sfwLabel.style.color = "#4ade80";

                const nsfwCb = document.createElement("input");
                nsfwCb.type = "checkbox";
                nsfwCb.checked = false;
                nsfwCb.id = "aih-nsfw-" + node.id;
                const nsfwLabel = document.createElement("label");
                nsfwLabel.style.fontSize = "11px";
                nsfwLabel.htmlFor = nsfwCb.id;
                nsfwLabel.textContent = "NSFW";
                nsfwLabel.style.color = "#f87171";

                randRow.appendChild(randCb);
                randRow.appendChild(randLabel);
                randRow.appendChild(document.createTextNode(" N:"));
                randRow.appendChild(randN);
                randRow.appendChild(randSep);
                randRow.appendChild(sfwCb);
                randRow.appendChild(sfwLabel);
                randRow.appendChild(nsfwCb);
                randRow.appendChild(nsfwLabel);

                // Validation : au moins un des deux doit être coché
                function validateNsfwCheckboxes() {
                    if (!sfwCb.checked && !nsfwCb.checked) {
                        sfwCb.checked = true; // Forcer au moins SFW
                    }
                }
                sfwCb.onchange = () => { validateNsfwCheckboxes(); syncElementsWidget(true); markDirty(); };
                nsfwCb.onchange = () => { validateNsfwCheckboxes(); syncElementsWidget(true); markDirty(); };
                randCb.onchange = () => { syncElementsWidget(true); markDirty(); };
                randN.onchange = () => { syncElementsWidget(true); markDirty(); };
                randN.oninput = () => { syncElementsWidget(true); markDirty(); };

                // ---- Test generation button (hauteur fixe) ----
                const genBtn = mkBtn(t("el.testGeneration"), true);
                genBtn.style.width = "100%";
                genBtn.style.padding = "6px";
                genBtn.style.marginBottom = "8px";
                genBtn.style.flex = "0 0 auto";

                genBtn.onclick = () => triggerGenerate(node);

                // ---- Hash deterministe (pour le random par seed) ----
                // 32-bit FNV-1a : simple, rapide, distribue raisonnablement.
                function hash32(str) {
                    let h = 0x811c9dc5;
                    for (let i = 0; i < str.length; i++) {
                        h ^= str.charCodeAt(i);
                        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
                    }
                    return h >>> 0;
                }

                // Parser les blocs de choix {A::B::C} dans un texte.
                // Retourne un tableau de tableaux : [[alt1, alt2, ...], ...]
                // Un bloc vide ou avec 0 alternatives est ignoré.
                // Si aucun bloc {}, retourne [] (texte littéral).
                function parseChoiceBlocks(rawText) {
                    if (!rawText) return [];
                    const blocks = [];
                    const re = /\{([^}]+)\}/g;
                    let m;
                    while ((m = re.exec(rawText)) !== null) {
                        const alts = m[1].split("::").map(s => s.trim()).filter(Boolean);
                        if (alts.length > 0) blocks.push(alts);
                    }
                    return blocks;
                }

                // Résout les blocs de choix {A::B::C} dans un texte :
                // - Chaque bloc {} est remplacé par 1 alternative au hasard.
                // - Le texte hors {} est conservé tel quel (templates supportés).
                // - Sans bloc {}, le texte est littéral (retourné tel quel).
                // Deterministe : meme (seed, index, texte) => meme choix.
                // Si seed == 0 (pas de seed), random non-deterministe.
                function pickAlternative(rawText, seed, elementIndex) {
                    if (!rawText) return "";
                    if (!/\{[^}]+\}/.test(rawText)) return rawText;
                    let blockIdx = 0;
                    return rawText.replace(/\{([^}]+)\}/g, (_fullMatch, inner) => {
                        const alts = inner.split("::").map(s => s.trim()).filter(Boolean);
                        if (alts.length === 0) return "";
                        if (alts.length === 1) return alts[0];
                        let chosen;
                        if (seed <= 0) {
                            // Pas de seed : random classique
                            chosen = alts[Math.floor(Math.random() * alts.length)];
                        } else {
                            // Hash du triplet (seed, index, blockIdx, inner) pour
                            // eviter les collisions entre blocs ayant les memes alternatives
                            const h = hash32(`${seed}|${elementIndex}|${blockIdx}|${inner}`);
                            chosen = alts[h % alts.length];
                        }
                        blockIdx++;
                        return chosen;
                    });
                }

                // ---- triggerGenerate ----
                // Reproduit le flux du Python generate() : traite les éléments
                // séquentiellement, résout ||concept et 🧠 via appels LLM réels,
                // puis envoie le tout à /api/generate.
                async function triggerGenerate(n) {
                    const allElements = n._aihElements || [];
                    const visibleElements = allElements.filter(e => e.visible !== false);

                    if (visibleElements.length === 0 && !randCb.checked) {
                        result.value = t("el.emptyVisible");
                        return;
                    }

                    // 1. Préparer les éléments (copie pour ne pas modifier l'original)
                    var elements = visibleElements.map(e => ({ ...e }));
                    var presetId = parseInt(presetSelect.value) || 0;
                    var llmDefaultCount = parseInt(llmCountInput.value) || 10;
                    var brainToggles = allElements.map(e => !!e.brain);
                    var context = [];

                    // Indiquer que la génération est en cours
                    var originalBtnText = genBtn.textContent;
                    genBtn.textContent = t("el.generating");
                    genBtn.disabled = true;
                    result.value = t("el.generating");

                    // 2. Traiter chaque élément séquentiellement
                    for (var i = 0; i < elements.length; i++) {
                        var el = elements[i];
                        var brainOn = brainToggles[i] || false;
                        var rawText = el.text || "";

                        // Détecter ||concept[:count][;hint[:count]]
                        var parsed = _parseConceptSyntax(rawText, llmDefaultCount);
                        if (parsed && presetId > 0) {
                            var concept = parsed.concept;
                            var count = parsed.count;
                            var hint = parsed.hint;
                            var instruction = brainOn && context.length > 0
                                ? t("el.llmInstructionCtx", { count: count, concept: concept })
                                : t("el.llmInstruction", { count: count, concept: concept });
                            var inputText = brainOn && context.length > 0 ? t("el.contextPrefix", { context: context.join(", ") }) : "";

                            try {
                                var resp = await apiCall("POST", "keywords/llm-process", {
                                    preset_id: presetId,
                                    instruction: instruction,
                                    input_text: inputText
                                });
                                var llmList = (resp.output || "").split(/[,\n]/).map(function(s) { return s.trim(); }).filter(Boolean);
                                if (llmList.length > 0) {
                                    var chosen = llmList[Math.floor(Math.random() * llmList.length)];
                                    if (hint) {
                                        chosen = hint + ": " + chosen;
                                    }
                                    el.text = chosen;
                                    context.push(chosen);
                                }
                            } catch (e) { console.error("LLM generate failed:", e); }
                            continue;
                        }

                        // Détecter les blocs {a::b::c} avec brain ON
                        if (brainOn && presetId > 0 && el.type !== "filter") {
                            var blocks = rawText.match(/\{([^}]+)\}/g);
                            if (blocks && blocks.length > 0) {
                                var allChoices = [];
                                blocks.forEach(function(b) {
                                    var choices = b.replace(/[{}]/g, "").split("::").map(function(s) { return s.trim(); }).filter(Boolean);
                                    allChoices = allChoices.concat(choices);
                                });
                                if (allChoices.length > 0 && context.length > 0) {
                                    try {
                                        var resp2 = await apiCall("POST", "keywords/llm-process", {
                                            preset_id: presetId,
                                            instruction: t("el.llmFilterInstruction"),
                                            input_text: t("el.llmFilterInput", { context: context.join(", "), list: allChoices.join(", ") })
                                        });
                                        var filtered = (resp2.output || "").split(/[,\n]/).map(function(s) { return s.trim(); }).filter(Boolean);
                                        if (filtered.length > 0) {
                                            // Résoudre les blocs avec les choix filtrés
                                            var resolved = rawText.replace(/\{([^}]+)\}/g, function(match) {
                                                var choices = match.replace(/[{}]/g, "").split("::").map(function(s) { return s.trim(); });
                                                var valid = choices.filter(function(c) { return filtered.indexOf(c) >= 0; });
                                                if (valid.length > 0) return valid[Math.floor(Math.random() * valid.length)];
                                                return choices[Math.floor(Math.random() * choices.length)];
                                            });
                                            el.text = resolved;
                                            context.push(resolved);
                                            continue;
                                        }
                                    } catch (e) { console.error("LLM filter failed:", e); }
                                }
                            }
                        }

                        // Résolution normale des blocs {} (sans LLM)
                        if (el.type !== "filter" && rawText.indexOf("{") >= 0) {
                            el.text = rawText.replace(/\{([^}]+)\}/g, function(match) {
                                var choices = match.replace(/[{}]/g, "").split("::").map(function(s) { return s.trim(); }).filter(Boolean);
                                return choices.length > 0 ? choices[Math.floor(Math.random() * choices.length)] : match;
                            });
                        }

                        // Ajouter au contexte
                        if (el.type === "filter") {
                            // Le filtre sera résolu par le backend, ajouter juste le nom au contexte
                            context.push(el.name || "");
                        } else if (el.text) {
                            context.push(el.text);
                        }
                    }

                    // 3. Envoyer à /api/generate
                    // Lire le seed depuis le widget ComfyUI
                    const sw = n.widgets?.find(w => w.name === "seed");
                    const seed = sw ? parseInt(sw.value) || 0 : 0;

                    var payload = {
                        elements: elements.map(function(e) {
                            if (e.type === "filter") return { type: "filter", id: e.id, name: e.name, hint: e.hint || "" };
                            if (e.type === "text") return { type: "raw", text: e.text };
                            return e;
                        }),
                    };
                    if (seed > 0) payload.seed = seed;
                    if (randCb.checked) {
                        payload.random_count = parseInt(randN.value) || 3;
                        payload.random_sfw = sfwCb.checked;
                        payload.random_nsfw = nsfwCb.checked;
                    }

                    try {
                        var data = await apiCall("POST", "generate", payload);
                        var prompt = data.prompt || data.output || "";
                        if (n._resultArea) n._resultArea.value = prompt;
                        syncElementsWidget(true);
                        syncApiConfigWidget();
                    } catch (err) {
                        if (n._resultArea) n._resultArea.value = t("el.resultError", { error: err.message });
                    } finally {
                        genBtn.textContent = originalBtnText;
                        genBtn.disabled = false;
                    }
                }

                // ---- Result area (hauteur fixe, calée en bas, pas de resize) ----
                const result = document.createElement("textarea");
                Object.assign(result.style, {
                    width: "100%",
                    height: "54px",            // Hauteur fixe
                    minHeight: "54px",
                    maxHeight: "54px",
                    borderRadius: "4px",
                    border: "1px solid #555",
                    padding: "4px",
                    background: "#1a1a1e",
                    color: "#fff",
                    fontSize: "11px",
                    resize: "none",            // PAS de resize
                    boxSizing: "border-box",
                    flex: "0 0 auto",          // Ne s'étend pas, fixé en bas
                });
                result.placeholder = t("el.resultPlaceholder");
                result.readOnly = true;

                // ---- Assemble ----
                container.appendChild(epPresetRow); // EP Preset (save/load, tout en haut)
                container.appendChild(presetRow); // fixe (Preset IA + ||N, en haut)
                container.appendChild(tb);        // fixe
                container.appendChild(listEl);    // flex: grow
                container.appendChild(randRow);   // fixe
                container.appendChild(genBtn);    // fixe
                container.appendChild(result);     // fixe en bas

                // Intégrer dans le layout ComfyUI via addDOMWidget
                const domWidget = node.addDOMWidget("elements_ui", "custom", container, {
                    serialize: false,
                    getValue: () => "",
                    setValue: (v) => {},
                    getMinHeight: () => 280,  // ← minHeight pour computeLayoutSize (widget "growable")
                });
                domWidget.serialize = false;          // persistance workflow (widgets_values)
                domWidget.options = domWidget.options || {};
                domWidget.options.serialize = false;  // prompt API

                // ---- Constantes de hauteur (conservées pour référence) ----
                // La hauteur du DOM widget est désormais gérée nativement par la frontend
                // via getMinHeight / computeLayoutSize. Ces constantes ne sont plus utilisées
                // dans computeSize/onResize/rAF mais conservées pour d'éventuels usages futurs.
                const DOM_WIDGET_HEIGHT = 280;
                const CHROME = 70; // titre node + padding
                // Somme des hauteurs des widgets natifs visibles (utilise computeSize de chaque widget)
                function fixedWidgetsHeight() {
                    let h = 0;
                    for (const w of node.widgets) {
                        if (w === domWidget) continue;
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
                // ---- Taille minimum de la node ----
                const MIN_WIDTH = 360;

                // Intercepter le resize pour imposer un minimum de largeur seulement.
                // La hauteur du container est gérée nativement par la frontend (computeLayoutSize)
                // via getMinHeight → le widget est "growable" et grandit avec la node.
                const origOnResize = node.onResize;
                node.onResize = function (size) {
                    if (origOnResize) origOnResize.call(this, size);
                    if (size[0] < MIN_WIDTH) size[0] = MIN_WIDTH;
                    container.style.width = (size[0] - 20) + "px";
                };

                // Appliquer la taille initiale
                requestAnimationFrame(function() {
                    if (node.size && node.size[0] < MIN_WIDTH) {
                        node.setSize([MIN_WIDTH, node.size[1]]);
                    }
                    container.style.width = (node.size[0] - 20) + "px";
                });

                // ---- Persistance workflow (sauvegarde/chargement) ----
                // ComfyUI charge les valeurs des widgets APRÈS onNodeCreated.
                // On stocke la fonction de restauration sur l'instance du node
                // pour pouvoir l'appeler depuis loadedGraphNode ou afterConfigureGraph.
                // En fallback, on tente aussi périodiquement.

                function restoreFromWidgets(n) {
                    // Appliquer la valeur stockée par onConfigure si elle existe
                    // (le widget _elements_json peut ne pas exister au moment de onConfigure)
                    if (n._pendingElementsJson) {
                        var ej2 = n.widgets?.find(w => w.name === "_elements_json");
                        if (ej2) {
                            ej2.value = n._pendingElementsJson;
                            n._pendingElementsJson = null;  // consommé
                        }
                    }
                    const _ejDebug = n.widgets?.find(w => w.name === "_elements_json");
                    const ej = n.widgets?.find(w => w.name === "_elements_json");
                    if (!ej || !ej.value || ej.value === "{}" || ej.value === "") {
                        return false;
                    }
                    try {
                        const data = JSON.parse(ej.value);
                        if (data.elements && Array.isArray(data.elements) && data.elements.length > 0 && n._aihElements.length === 0) {
                            n._aihElements = data.elements.map(e => {
                                const visible = e.visible !== false;
                                if (e.type === "filter") {
                                    return {
                                        type: "filter",
                                        id: e.id,
                                        name: e.name || t("el.filterLabel", { id: e.id }),
                                        author: e.author || "?",
                                        is_public: !!e.is_public,
                                        hint: e.hint || "",
                                        visible,
                                    };
                                }
                                if (e.type === "text" || e.type === "raw") {
                                    // Format interne = "text" pour l'affichage
                                    return { type: "text", text: e.text || "", visible };
                                }
                                return { ...e, visible };
                            });
                            renderList();
                        }
                        if (data.random_sfw !== undefined) sfwCb.checked = !!data.random_sfw;
                        if (data.random_nsfw !== undefined) nsfwCb.checked = !!data.random_nsfw;
                        if (data.random_count > 0) {
                            randCb.checked = true;
                            randN.value = data.random_count;
                        }
                        // Restaurer le preset IA sélectionné
                        if (data.preset_id !== undefined) {
                            const pid = String(data.preset_id);
                            if (pid !== "0" && [...presetSelect.options].some(o => o.value === pid)) {
                                presetSelect.value = pid;
                            } else if (pid !== "0") {
                                // Options pas encore chargées : mémoriser pour populatePresets()
                                presetSelect.dataset.pendingId = pid;
                            } else {
                                presetSelect.value = "0";
                            }
                        }
                        // Restaurer le nombre par défaut pour ||
                        if (data.llm_default_count !== undefined) {
                            llmCountInput.value = String(data.llm_default_count);
                        }
                        // Restaurer les brain_toggles (un booléen par liste)
                        if (data.brain_toggles && Array.isArray(data.brain_toggles)) {
                            let brainChanged = false;
                            data.brain_toggles.forEach((brain, i) => {
                                if (n._aihElements[i]) {
                                    const newBrain = !!brain;
                                    if (!!n._aihElements[i].brain !== newBrain) {
                                        n._aihElements[i].brain = newBrain;
                                        brainChanged = true;
                                    }
                                }
                            });
                            if (brainChanged) renderList();
                        }
                        // Si aucun élément n'a été restauré (liste vide), on retourne false
                        // pour que delayedRestore continue de retenter (la vraie valeur du
                        // workflow peut arriver APRÈS, appliquée par la frontend).
                        if (!data.elements || !Array.isArray(data.elements) || data.elements.length === 0) {
                            return false;
                        }
                        // Restauration réussie : autoriser syncElementsWidget à écrire désormais.
                        _aihRestored = true;
                        return true; // Succès
                    } catch (err) {
                        console.warn("[AIH] Impossible de restaurer les éléments :", err);
                        return false;
                    }
                }

                // Stocker sur l'instance pour que les hooks d'extension puissent l'appeler
                node._aihRestore = restoreFromWidgets.bind(null, node);

                // Fallback : tente de restaurer périodiquement (pour F5 et cas où les hooks ne marchent pas)
                let restoreAttempts = 0;
                function delayedRestore() {
                    if (restoreFromWidgets(node)) {
                        return;
                    }
                    restoreAttempts++;
                    if (restoreAttempts < 20) {
                        setTimeout(delayedRestore, 300);
                    } else {
                    }
                }
                setTimeout(delayedRestore, 100);

                // Stocker les refs
                node._resultArea = result;
                node._domWidget = domWidget;

                // ---- onExecuted SUR L'INSTANCE (pas le prototype !) ----
                // LiteGraph met this.onExecuted = null dans son constructeur,
                // ce qui MASQUE tout override sur nodeType.prototype.
                // On doit donc écraser la propriété directement sur l'instance.
                const origExec = node.onExecuted; // null (mis par le constructeur)
                node.onExecuted = function (output) {
                    if (origExec) origExec.call(this, output);

                    // ComfyUI passe le résultat differemment selon la version :
                    //   Nouveau frontend : detail.output = { elements: ["text"] }
                    //   Ancien frontend : output = { elements: "text" } ou ["text"]
                    let text = null;
                    if (output && typeof output === 'object') {
                        if (output.output !== undefined) {
                            const out = output.output;
                            if (typeof out === 'object' && !Array.isArray(out) && out.elements !== undefined) text = out.elements;
                            else if (Array.isArray(out) && out.length > 0) text = out[0];
                            else if (typeof out === 'string') text = out;
                        }
                        if (text === null && output.elements !== undefined) text = output.elements;
                        if (text === null && Array.isArray(output) && output.length > 0) text = output[0];
                        // ComfyUI sérialise souvent les sorties avec des clés numériques : {"0": "text"}
                        if (text === null) {
                            for (const key of Object.keys(output)) {
                                if (/^\d+$/.test(key)) { text = output[key]; break; }
                            }
                        }
                    }
                    if (text === null && typeof output === 'string') text = output;

                    if (text !== null && text !== undefined) {
                        const str = Array.isArray(text) ? text.join("") : String(text);
                        console.log("[AIH] onExecuted result:", str.substring(0, 80));
                        if (node._resultArea) {
                            node._resultArea.value = str;
                        }
                    } else if (output) {
                        console.log("[AIH] onExecuted: format inconnu:", JSON.stringify(output).substring(0, 200));
                    }
                };

                // Sync initial — on NE synchronise PAS _elements_json ici : au
                // chargement la valeur sérialisée du workflow n'est pas encore
                // appliquée (la frontend la pose APRÈS onNodeCreated). Écrire ici
                // écraserait la vraie valeur par {"elements":[]}. Le flag
                // _aihRestored garde syncElementsWidget inerte jusqu'à la
                // restauration réussie (voir restoreFromWidgets).
                syncApiConfigWidget();

                return r;
            };
        },

        // Hook appelé APRÈS que ComfyUI a restauré les widgets depuis le workflow
        async loadedGraphNode(node) {
            if (node._aihRestore) {
                setTimeout(() => node._aihRestore(), 0);
            }
        },

        // Écouteur d'événements API global (la méthode la plus fiable)
        async setup() {
            // API singleton : ancien frontend (window.app.api) ou nouveau
            // (window.comfyAPI.api.api = instance ComfyApi). window.comfyAPI.api
            // est le namespace { api, api_base } qui n'a PAS addEventListener.
            const api = window.app?.api || window.comfyAPI?.api?.api || window.api;
            if (!api) return;

            api.addEventListener("executed", ({ detail }) => {
                if (!detail?.node || !detail?.output) return;
                
                // Trouver le nœud dans le graph
                const node = window.app?.graph?.getNodeById(detail.node);
                if (!node || !NODE_TYPES.includes(node.type) || !node._resultArea) return;

                const output = detail.output;
                let text = null;

                // Extraction robuste du texte
                if (output.elements !== undefined) text = output.elements;
                else if (Array.isArray(output) && output.length > 0) text = output[0];
                else if (typeof output === 'string') text = output;
                else if (output.output) { // Format nested
                    const o = output.output;
                    if (o.elements !== undefined) text = o.elements;
                    else if (Array.isArray(o) && o.length > 0) text = o[0];
                }
                // ComfyUI sérialise souvent avec clés numériques : {"0": "text"}
                if (text === null && typeof output === 'object') {
                    for (const key of Object.keys(output)) {
                        if (/^\d+$/.test(key)) { text = output[key]; break; }
                    }
                }

                if (text !== null && text !== undefined) {
                    const str = Array.isArray(text) ? text.join("") : String(text);
                    node._resultArea.value = str;
                    console.log("[AIH] WebSocket executed update:", str.substring(0, 50));
                }
            });
        }
    });
})();

// ========================
// Utilitaires : modales et toots
// ========================

/** Escaping HTML pour injection sécurisée dans innerHTML */
function esc(str) {
    if (typeof str !== "string") return "";
    var d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
}

function showFilterPicker(filters, currentUserId, onSelect) {
    var mine = currentUserId
        ? filters.filter(function(f) { return f.user_id === currentUserId && !f.is_public; })
        : filters.filter(function(f) { return f.user_id && !f.is_public; });
    var pub = filters.filter(function(f) { return f.is_public; });

    var html = '<div style="max-height:50vh;overflow-y:auto;">';

    if (mine.length > 0) {
        html += '<p style="margin:8px 0 4px;font-size:11px;color:#888;">' + t("el.myFilters") + '</p>';
        mine.forEach(function(f) {
            html += '<div class="aih-filter-item" data-id="' + f.id + '" style="padding:6px 8px;cursor:pointer;border-radius:4px;font-size:12px;color:#ccc;background:#3a3a3e;margin-bottom:2px;">' +
                esc(f.name) + (f.nsfw ? ' 🔞' : '') + '</div>';
        });
    }
    if (pub.length > 0) {
        html += '<p style="margin:8px 0 4px;font-size:11px;color:#888;">' + t("el.publicFilters") + '</p>';
        pub.forEach(function(f) {
            html += '<div class="aih-filter-item" data-id="' + f.id + '" style="padding:6px 8px;cursor:pointer;border-radius:4px;font-size:12px;color:#ccc;background:#3a3a3e;margin-bottom:2px;">' +
                esc(f.name) + (f.nsfw ? ' 🔞' : '') + ' <span style="color:#888;font-size:10px;">' + t("el.by") + esc(f.user_id ? f.user_id.substring(0,6) : '?') + '</span></div>';
        });
    }
    if (filters.length === 0) {
        html += '<p style="font-size:12px;color:#666;">' + t("el.noFilter") + '</p>';
    }
    html += '</div>';

    var m = aihOpenModalV2({
        title: t("el.filterPickerTitle"),
        content: html,
        width: "380px",
        height: "auto",
        minHeight: "150px",
        maxHeight: "70vh",
        resizable: false,
        storageKey: "aih:elements-filter",
        persistPos: true,
        persistSize: true
    });

    // Attacher les événements aux items
    m.modal.querySelectorAll(".aih-filter-item").forEach(function(el) {
        el.onclick = function() {
            var id = parseInt(el.dataset.id);
            var f = filters.find(function(x) { return x.id === id; });
            if (f && onSelect) onSelect(f);
            m.close();
        };
        el.onmouseenter = function() { el.style.background = '#4a4a4e'; };
        el.onmouseleave = function() { el.style.background = '#3a3a3e'; };
    });
}

function showPrompt(title, msg, placeholder, cb) {
    aihShowPrompt(title, msg, placeholder).then(function(value) {
        if (cb) cb(value);
    });
}

function showToast(type, msg) {
    bridgeShowToast({ message: msg, type: type, duration: 4000 });
}