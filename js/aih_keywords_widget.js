import "./aih_dialog.js";
import "./aih_strings.js";
import { showToast as bridgeShowToast } from "./aih_toast_bridge.js";
import { remoteRequest } from "./aih_fetch_bridge.js";

// Helper i18n central : traduit via AIH.I18n (clé brute si absente)
const t = (key, params) => {
    const I = window.AIH && window.AIH.I18n;
    return I && typeof I.t === "function" ? I.t(key, params) : key;
};

/**
 * AIH Keywords Picker — Custom widget for ComfyUI node.
 *
 * UI de filtrage de mots-clés :
 *   - Section / Subsection / NSFW / Confidence / Include / Exclude / Semantic
 *   - Auto-update via debounce (500ms) → GET /api/keywords
 *   - Sauvegarde/Chargement de filtres (GET/POST /api/filters)
 *   - Liste scrollable des mots-clés résultants
 *
 * Widget caché _keywords_config : sérialisé dans le workflow pour persistance.
 *
 * NOTE : ce fichier utilise un polling auto-contenu pour attendre window.app
 * (et non AIH.waitForApp), afin d'éviter les problèmes de dépendance avec
 * aih_widget_base.js qui peut charger après ce fichier selon l'ordre
 * alphabétique du serveur de fichiers.
 */

// ========================
// Helpers partagés
// ========================

function getApiUrl() {
    // Délègue au helper partagé (aucune URL par défaut codée en dur :
    // chaîne vide si le serveur n'est pas configuré).
    try {
        const base = (window.AIH && window.AIH.getServerUrl
            ? window.AIH.getServerUrl()
            : "").replace(/\/+$/, "");
        return base ? base + "/api" : "";
    } catch {
        return "";
    }
}

async function apiCall(method, path, body) {
    const baseUrl = getApiUrl();
    if (!baseUrl) {
        throw new Error(t("aih.notConfiguredError"));
    }
    try {
        return await remoteRequest(`${baseUrl}/${path.replace(/^\//, "")}`, {
            method,
            body,
        });
    } catch (e) {
        // Reproduit le contrat historique : Error "HTTP <status>: <texte>".
        const raw = e && e.body !== undefined && typeof e.body === "object"
            ? JSON.stringify(e.body)
            : (e && e.body) || "";
        throw new Error(`HTTP ${e.status}: ${String(raw).substring(0, 200)}`);
    }
}

// ========================
// Cacher un widget ComfyUI
// ========================
function hideWidget(node, name) {
    const w = node.widgets?.find(x => x.name === name);
    if (w) {
        // hidden=true : la frontend Vue ne rend PAS le widget (ni textarea,
        // ni conteneur). display:none seul laisse le conteneur Vue capturer
        // les clics (zone invisible). hidden=true est sûr car serialize()
        // ne vérifie que serialize===false (pas hidden).
        w.hidden = true;
        w.computeSize = () => [0, -4];
        if (w.element) w.element.style.display = "none";
        if (w.inputEl) w.inputEl.style.display = "none";
        if (w.parentEl) w.parentEl.style.display = "none";
        return w;
    }
    return null;
}

// ========================
// Formatteur de liste de mots-clés
// ========================

/**
 * Formate un tableau de keywords selon le format choisi.
 * @param {Array} keywords - Tableau d'objets {keyword, description, ...} ou de strings
 * @param {string} format - "text", "json" ou "markdown"
 * @returns {string} La chaîne formatée
 */
function formatKeywordsList(keywords, format) {
    const items = keywords || [];
    const extract = kw => (kw && kw.keyword) ? kw.keyword : (typeof kw === "string" ? kw : "");

    if (format === "json") {
        return JSON.stringify(items.map(k => (typeof k === "string" ? { keyword: k } : k)));
    }

    if (format === "markdown") {
        return items.map(k => "- " + extract(k)).join("\n");
    }

    // format "text" (défaut) — CSV simple
    return items.map(k => extract(k)).join(", ");
}

// ========================
// Helpers UI
// ========================

/** Escaping HTML pour injection sécurisée dans innerHTML */
function esc(str) {
    if (typeof str !== "string") return "";
    var d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
}

function showToast(type, msg) {
    bridgeShowToast({ message: msg, type: type, duration: 4000 });
}

// ========================
// Debounce utilitaire
// ========================
function debounce(fn, delay) {
    let timer = null;
    return function () {
        const ctx = this, args = arguments;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            fn.apply(ctx, args);
        }, delay);
    };
}

// ========================
// Enregistrement du widget
// ========================

// Accepted ComfyUI class keys for this node: canonical post-rename key plus
// the legacy pre-rename alias. The Python side registers BOTH (legacy alias
// kept so old workflows — node.type = "AIHKeywordsNode" — still load), and
// beforeRegisterNodeDef fires once per definition, so both must match.
const NODE_TYPES = ["AIHKeywords", "AIHKeywordsNode"];

// Polling auto-contenu pour attendre window.app (évite la dépendance
// à AIH.waitForApp qui peut charger après ce fichier)
(function waitForApp() {
    const app = window.app || window.comfyAPI?.app?.app;
    if (!app || !app.graph) {
        setTimeout(waitForApp, 100);
        return;
    }

    app.registerExtension({
        name: "AIH.Keywords",
        async beforeRegisterNodeDef(nodeType, nodeData) {
            if (!NODE_TYPES.includes(nodeData.name)) return;

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated?.apply(this, arguments);
                const node = this;

                // ---- Masquer le widget sérialisé _keywords_config ----
                {
                    hideWidget(node, "_keywords_config");
                }

                // Empêcher le feedback loop de hauteur : sans widgets_start_y, la
                // frontend fait size[1] += widgets_height à chaque computeSize
                // (cumulatif → node qui grandit indéfiniment, zone invisible qui
                // bloque les clics). Avec widgets_start_y, le calcul devient
                // Math.max(size[1], widgets_height + widgets_start_y).
                node.widgets_start_y = 52;

                // ---- Masquer le widget seed (forçage de réexécution) ----
                // Le seed existe dans la node pour que ComfyUI le sérialise
                // et réexécute la node à chaque run, mais il n'est pas visible.
                {
                    hideWidget(node, "seed");

                    // ComfyUI ajoute automatiquement un widget control_after_generate
                    // à côté de tout widget nommé "seed" — on le cache aussi.
                    var cag = node.widgets?.find(w => w.name === "control_after_generate");
                    if (cag) {
                        // Ne PAS mettre hidden=true (même raison que hideWidget)
                        cag.computeSize = () => [0, -4];
                        if (cag.element) cag.element.style.display = "none";
                        if (cag.inputEl) cag.inputEl.style.display = "none";
                        if (cag.parentEl) cag.parentEl.style.display = "none";
                    }
                }

                // ---- Supprimer la socket d'entrée de _keywords_config ----
                {
                    const slot = node.findInputSlot?.("_keywords_config");
                    if (slot !== undefined && slot !== -1) {
                        node.removeInput(slot);
                    }
                }

                // ---- État local ----
                if (!node._aihKeywords) node._aihKeywords = [];
                if (!node._aihTotal) node._aihTotal = 0;

                // Config courante (pour le payload _keywords_config et les appels API)
                const config = {
                    section: "",
                    subsection: "",
                    include: "",
                    exclude: "",
                    semantic: "",
                    nsfw: "",
                    min_confidence: 0.5,
                    output_format: "text",
                };

                // ---- Sync _keywords_config ----
                function syncKeywordsConfig() {
                    const w = node.widgets?.find(x => x.name === "_keywords_config");
                    if (!w) return;
                    w.value = JSON.stringify({
                        keywords_text: formatKeywordsList(node._aihKeywords, config.output_format),
                        keywords: node._aihKeywords || [],
                        total: node._aihTotal || 0,
                        config: { ...config },
                    });
                }

                // ---- Appel API keywords avec debounce ----
                // Génération anti-course : seule la réponse du dernier fetch
                // est appliquée (évite qu'une réponse lente écrase un état plus récent)
                let _fetchGen = 0;

                async function fetchKeywords() {
                    const gen = ++_fetchGen;
                    console.log("[AIH.Keywords] fetchKeywords called, config:", JSON.stringify(config));
                    const params = new URLSearchParams();
                    if (config.section) params.set("section", config.section);
                    if (config.subsection) params.set("subsection", config.subsection);
                    if (config.include) params.set("q", config.include);
                    if (config.exclude) params.set("q_neg", config.exclude);
                    if (config.semantic) params.set("semantic", config.semantic);
                    if (config.nsfw !== "" && config.nsfw !== null && config.nsfw !== undefined) params.set("nsfw", config.nsfw);
                    if (config.min_confidence > 0) params.set("min_confidence", String(config.min_confidence));

                    const queryStr = params.toString();
                    const url = queryStr ? `keywords?${queryStr}` : "keywords";

                    try {
                        const data = await apiCall("GET", url);
                        if (gen !== _fetchGen) return; // réponse périmée
                        const list = data.keywords || data.results || data.data || (Array.isArray(data) ? data : []);
                        node._aihKeywords = list.map(k => {
                            if (typeof k === "string") return { id: null, keyword: k, description: "" };
                            return k;
                        });
                        node._aihTotal = data.total !== undefined ? data.total : node._aihKeywords.length;
                        renderKeywords();
                        syncKeywordsConfig();
                    } catch (err) {
                        console.warn("[AIH.Keywords] fetch error:", err.message);
                        if (gen !== _fetchGen) return;
                        // N'efface PAS la liste : affiche l'erreur pour que ce
                        // ne soit pas un échec silencieux (401, CORS, serveur down...)
                        node._aihKeywords = [];
                        node._aihTotal = 0;
                        renderKeywords(t("kw.apiErrorPrefix", { error: err.message }));
                        syncKeywordsConfig();
                    }
                }

                const _debouncedFetch = debounce(fetchKeywords, 500);
                function debouncedFetch() {
                    console.log("[AIH.Keywords] debouncedFetch scheduled, config:", JSON.stringify(config));
                    _debouncedFetch();
                }

                // ---- Met à jour la config et déclenche l'auto-update ----
                function updateConfigAndFetch(partial) {
                    console.log("[AIH.Keywords] updateConfigAndFetch called with:", JSON.stringify(partial));
                    Object.assign(config, partial);
                    debouncedFetch();
                }

                // ---- UI Container ----
                const container = document.createElement("div");
                Object.assign(container.style, {
                    width: "100%",
                    height: "100%",
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

                // ========================================
                // Row 1 : Section + Subsection
                // ========================================
                const row1 = document.createElement("div");
                Object.assign(row1.style, {
                    display: "flex", gap: "4px", marginBottom: "6px",
                    flex: "0 0 auto",
                });

                // Section dropdown
                const sectionSel = document.createElement("select");
                Object.assign(sectionSel.style, {
                    flex: "1", padding: "4px 6px", borderRadius: "4px",
                    border: "1px solid #555", background: "#1a1a1e",
                    color: "#fff", fontSize: "11px", cursor: "pointer",
                });
                sectionSel.innerHTML = '<option value="">' + t("kw.sectionPlaceholder") + '</option>';
                sectionSel.onchange = function () {
                    config.section = this.value;
                    config.subsection = ""; // Reset subsection quand section change
                    subsectionSel.innerHTML = '<option value="">' + t("kw.subsectionPlaceholder") + '</option>';
                    updateConfigAndFetch({ section: this.value, subsection: "" });
                    // Charger les sous-sections
                    if (this.value) loadSubsections(this.value);
                };

                // Subsection dropdown
                const subsectionSel = document.createElement("select");
                Object.assign(subsectionSel.style, {
                    flex: "1", padding: "4px 6px", borderRadius: "4px",
                    border: "1px solid #555", background: "#1a1a1e",
                    color: "#fff", fontSize: "11px", cursor: "pointer",
                });
                subsectionSel.innerHTML = '<option value="">' + t("kw.subsectionPlaceholder") + '</option>';
                subsectionSel.onchange = function () {
                    updateConfigAndFetch({ subsection: this.value });
                };

                row1.appendChild(sectionSel);
                row1.appendChild(subsectionSel);

                // ---- Chargement des sections ----
                async function loadSections() {
                    try {
                        const data = await apiCall("GET", "sections");
                        const sections = Array.isArray(data) ? data : (data.sections || data.data || []);
                        sectionSel.innerHTML = '<option value="">' + t("kw.sectionPlaceholder") + '</option>';
                        // Trier par ordre alphabétique
                        sections.sort(function(a, b) {
                            var nameA = (typeof a === "string" ? a : (a.section_title || a.title || a.name || String(a.section_id ?? a.id ?? ""))).toString().toLowerCase();
                            var nameB = (typeof b === "string" ? b : (b.section_title || b.title || b.name || String(b.section_id ?? b.id ?? ""))).toString().toLowerCase();
                            return nameA.localeCompare(nameB);
                        });
                        sections.forEach(function (s) {
                            const name = typeof s === "string" ? s : (s.section_title || s.title || s.name || String(s.section_id ?? s.id ?? ""));
                            const val = typeof s === "string" ? s : (s.section_id ?? s.id ?? s.name ?? s.section_title ?? s.title ?? "");
                            const opt = document.createElement("option");
                            opt.value = val;
                            opt.textContent = name;
                            sectionSel.appendChild(opt);
                        });
                    } catch (err) {
                        console.warn("[AIH.Keywords] loadSections error:", err.message);
                    }
                }

                async function loadSubsections(section) {
                    try {
                        const data = await apiCall("GET", `subsections?section=${encodeURIComponent(section)}`);
                        const subs = Array.isArray(data) ? data : (data.subsections || data.data || []);
                        subsectionSel.innerHTML = '<option value="">' + t("kw.subsectionPlaceholder") + '</option>';
                        // Trier par ordre alphabétique
                        subs.sort(function(a, b) {
                            var nameA = (typeof a === "string" ? a : (a.subsection_title || a.title || a.name || String(a.subsection_id ?? a.id ?? ""))).toString().toLowerCase();
                            var nameB = (typeof b === "string" ? b : (b.subsection_title || b.title || b.name || String(b.subsection_id ?? b.id ?? ""))).toString().toLowerCase();
                            return nameA.localeCompare(nameB);
                        });
                        subs.forEach(function (s) {
                            const name = typeof s === "string" ? s : (s.subsection_title || s.title || s.name || String(s.subsection_id ?? s.id ?? ""));
                            const val = typeof s === "string" ? s : (s.subsection_id ?? s.id ?? s.name ?? s.subsection_title ?? s.title ?? "");
                            const opt = document.createElement("option");
                            opt.value = val;
                            opt.textContent = name;
                            subsectionSel.appendChild(opt);
                        });
                    } catch (err) {
                        console.warn("[AIH.Keywords] loadSubsections error:", err.message);
                    }
                }

                // Flag pour savoir si le chargement initial des sections est terminé
                // (succès OU échec — sinon doSetSectionSub bouclera à l'infini)
                let _sectionsLoaded = false;

                // Surcouche loadSections qui met à jour le flag même en cas d'échec
                const origLoadSections = loadSections;
                loadSections = async function () {
                    try {
                        await origLoadSections();
                    } finally {
                        _sectionsLoaded = true;
                    }
                };

                loadSections();

                // ========================================
                // Row 2 : NSFW + Confidence slider
                // ========================================
                const row2 = document.createElement("div");
                Object.assign(row2.style, {
                    display: "flex", gap: "8px", marginBottom: "6px",
                    alignItems: "center", flex: "0 0 auto",
                });

                // NSFW dropdown
                const nsfwSel = document.createElement("select");
                Object.assign(nsfwSel.style, {
                    flex: "0 0 auto", width: "80px", padding: "4px 6px", borderRadius: "4px",
                    border: "1px solid #555", background: "#1a1a1e",
                    color: "#fff", fontSize: "11px", cursor: "pointer",
                });
                nsfwSel.innerHTML = '<option value="">' + t("kw.nsfwAll") + '</option><option value="0">SFW</option><option value="1">NSFW</option>';
                nsfwSel.onchange = function () {
                    updateConfigAndFetch({ nsfw: this.value });
                };

                // Confidence label
                const confLabel = document.createElement("span");
                confLabel.textContent = t("kw.confidence");
                confLabel.style.cssText = "font-size:11px;color:#aaa;white-space:nowrap;";

                // Confidence slider
                const confSlider = document.createElement("input");
                confSlider.type = "range";
                confSlider.min = "0";
                confSlider.max = "100";
                confSlider.value = "50";
                confSlider.step = "1";
                Object.assign(confSlider.style, {
                    flex: "1", minWidth: "60px", height: "16px",
                    cursor: "pointer", accentColor: "var(--aih-accent, #D8700D)",
                });

                // Confidence value display
                const confVal = document.createElement("span");
                confVal.textContent = "50%";
                confVal.style.cssText = "font-size:11px;color:#ccc;min-width:32px;text-align:right;";

                confSlider.oninput = function () {
                    const pct = parseInt(this.value) || 0;
                    confVal.textContent = pct + "%";
                };
                confSlider.onchange = function () {
                    const pct = parseInt(this.value) || 0;
                    updateConfigAndFetch({ min_confidence: pct / 100 });
                };

                // Confidence group (label + slider + value) — ~60% de la largeur
                const confGroup = document.createElement("div");
                Object.assign(confGroup.style, {
                    display: "flex", alignItems: "center", gap: "4px",
                    flex: "1", minWidth: "0",
                });
                confGroup.appendChild(confLabel);
                confGroup.appendChild(confSlider);
                confGroup.appendChild(confVal);

                // Format dropdown
                const formatSel = document.createElement("select");
                Object.assign(formatSel.style, {
                    flex: "0 0 auto", width: "78px", padding: "4px 6px", borderRadius: "4px",
                    border: "1px solid #555", background: "#1a1a1e",
                    color: "#fff", fontSize: "11px", cursor: "pointer",
                });
                formatSel.innerHTML = '<option value="text">' + t("kw.formatText") + '</option><option value="json">' + t("kw.formatJson") + '</option><option value="markdown">' + t("kw.formatMarkdown") + '</option>';
                formatSel.value = config.output_format || "text";
                formatSel.onchange = function () {
                    updateConfigAndFetch({ output_format: this.value });
                };

                row2.appendChild(nsfwSel);
                row2.appendChild(confGroup);
                row2.appendChild(formatSel);

                // ========================================
                // Row 3 : Include input
                // ========================================
                const row3 = document.createElement("div");
                Object.assign(row3.style, {
                    display: "flex", gap: "4px", marginBottom: "6px",
                    alignItems: "center", flex: "0 0 auto",
                });

                const includeLabel = document.createElement("span");
                includeLabel.textContent = t("kw.include");
                includeLabel.style.cssText = "font-size:11px;color:#aaa;white-space:nowrap;flex-shrink:0;";

                const includeInput = document.createElement("input");
                includeInput.type = "text";
                includeInput.placeholder = t("kw.includePlaceholder");
                Object.assign(includeInput.style, {
                    flex: "1", padding: "4px 6px", borderRadius: "4px",
                    border: "1px solid #555", background: "#1a1a1e",
                    color: "#fff", fontSize: "11px", minWidth: "0",
                });
                includeInput.oninput = function () {
                    updateConfigAndFetch({ include: this.value });
                };

                row3.appendChild(includeLabel);
                row3.appendChild(includeInput);

                // ========================================
                // Row 4 : Exclude input
                // ========================================
                const row4 = document.createElement("div");
                Object.assign(row4.style, {
                    display: "flex", gap: "4px", marginBottom: "6px",
                    alignItems: "center", flex: "0 0 auto",
                });

                const excludeLabel = document.createElement("span");
                excludeLabel.textContent = t("kw.exclude");
                excludeLabel.style.cssText = "font-size:11px;color:#aaa;white-space:nowrap;flex-shrink:0;";

                const excludeInput = document.createElement("input");
                excludeInput.type = "text";
                excludeInput.placeholder = t("kw.excludePlaceholder");
                Object.assign(excludeInput.style, {
                    flex: "1", padding: "4px 6px", borderRadius: "4px",
                    border: "1px solid #555", background: "#1a1a1e",
                    color: "#fff", fontSize: "11px", minWidth: "0",
                });
                excludeInput.oninput = function () {
                    updateConfigAndFetch({ exclude: this.value });
                };

                row4.appendChild(excludeLabel);
                row4.appendChild(excludeInput);

                // ========================================
                // Row 5 : Semantic input
                // ========================================
                const row5 = document.createElement("div");
                Object.assign(row5.style, {
                    display: "flex", gap: "4px", marginBottom: "6px",
                    alignItems: "center", flex: "0 0 auto",
                });

                const semanticLabel = document.createElement("span");
                semanticLabel.textContent = t("kw.semantic");
                semanticLabel.style.cssText = "font-size:11px;color:#aaa;white-space:nowrap;flex-shrink:0;";

                const semanticInput = document.createElement("input");
                semanticInput.type = "text";
                semanticInput.placeholder = t("kw.semanticPlaceholder");
                Object.assign(semanticInput.style, {
                    flex: "1", padding: "4px 6px", borderRadius: "4px",
                    border: "1px solid #555", background: "#1a1a1e",
                    color: "#fff", fontSize: "11px", minWidth: "0",
                });
                semanticInput.oninput = function () {
                    updateConfigAndFetch({ semantic: this.value });
                };

                row5.appendChild(semanticLabel);
                row5.appendChild(semanticInput);

                // ========================================
                // Row 6 : Load / Save buttons
                // ========================================
                const row6 = document.createElement("div");
                Object.assign(row6.style, {
                    display: "flex", gap: "4px", marginBottom: "6px",
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

                const loadBtn = mkBtn(t("kw.load"));
                const resetBtn = mkBtn(t("kw.reset"));
                const saveBtn = mkBtn(t("kw.save"), true);

                row6.appendChild(loadBtn);
                row6.appendChild(saveBtn);
                row6.appendChild(resetBtn);

                // ---- Load button : liste des filtres ----
                loadBtn.onclick = async () => {
                    try {
                        const filters = await apiCall("GET", "filters");
                        showFilterPicker(filters, (filter) => {
                            loadFilter(filter.id);
                        });
                    } catch (err) {
                        showToast("error", t("kw.loadFiltersFailed", { error: err.message }));
                    }
                };

                async function loadFilter(filterId) {
                    try {
                        const data = await apiCall("GET", `filters/${filterId}/preview`);
                        // data contient la config du filtre
                        const cfg = data.config || data.filter?.config || data;
                        if (cfg && typeof cfg === "object") {
                            // applyConfigToUI met à jour config + UI, puis
                            // déclenche fetchKeywords() (géré par doSetSectionSub)
                            applyConfigToUI(cfg);
                        } else {
                            showToast("error", t("kw.invalidFilterResponse"));
                        }
                    } catch (err) {
                        showToast("error", t("kw.loadFilterFailed", { error: err.message }));
                    }
                }

                // ---- Save button ----
                saveBtn.onclick = () => {
                    const promptFn = window.aihShowPrompt || function (title, message, placeholder) {
                        return window.AIH.prompt(title, message, placeholder);
                    };
                    promptFn(t("kw.saveFilterTitle"), t("kw.saveFilterPrompt"), "").then(function (name) {
                        if (!name) return;
                        const payload = {
                            name: name,
                            config: { ...config },
                        };
                        apiCall("POST", "filters", payload).then(() => {
                            showToast("success", t("kw.saved", { name: name }));
                        }).catch(err => {
                            showToast("error", t("kw.saveFailed", { error: err.message }));
                        });
                    });
                };

                // ---- Reset button ----
                resetBtn.onclick = function () {
                    // Reset Section
                    config.section = "";
                    sectionSel.value = "";

                    // Reset Subsection
                    config.subsection = "";
                    subsectionSel.innerHTML = '<option value="">' + t("kw.subsectionPlaceholder") + '</option>';

                    // Reset NSFW
                    config.nsfw = "";
                    nsfwSel.value = "";

                    // Reset Confidence
                    const pct = 50;
                    config.min_confidence = 0.5;
                    confSlider.value = "50";
                    confVal.textContent = "50%";

                    // Reset Include
                    config.include = "";
                    includeInput.value = "";

                    // Reset Exclude
                    config.exclude = "";
                    excludeInput.value = "";

                    // Reset Semantic
                    config.semantic = "";
                    semanticInput.value = "";

                    // Reset Format
                    config.output_format = "text";
                    if (formatSel) formatSel.value = "text";

                    // Vider la liste des mots-clés
                    node._aihKeywords = [];
                    node._aihTotal = 0;

                    // Relancer le fetch (retournera une liste vide ou par defaults)
                    fetchKeywords();
                };

                // ========================================
                // Keywords list (scrollable, flex grow)
                // ========================================
                const keywordsList = document.createElement("div");
                Object.assign(keywordsList.style, {
                    flex: "1 1 0",
                    minHeight: "40px",
                    overflowY: "auto",
                    border: "1px dashed #555",
                    borderRadius: "4px",
                    padding: "4px",
                    fontSize: "11px",
                    color: "#666",
                    marginBottom: "4px",
                });

                function renderKeywords(statusMsg) {
                    const items = node._aihKeywords || [];
                    if (items.length === 0) {
                        keywordsList.innerHTML = "";
                        const msgEl = document.createElement("span");
                        msgEl.textContent = statusMsg || t("kw.empty");
                        keywordsList.style.color = statusMsg && statusMsg.startsWith("⚠️") ? "#f87171" : "#666";
                        keywordsList.appendChild(msgEl);
                        return;
                    }
                    keywordsList.style.color = "#ccc";
                    keywordsList.innerHTML = "";

                    // En-tête : nombre de résultats
                    const header = document.createElement("div");
                    Object.assign(header.style, {
                        padding: "2px 4px", marginBottom: "4px",
                        fontSize: "10px", color: "#888",
                        borderBottom: "1px solid #444",
                    });
                    header.textContent = t("kw.totalCount", { count: node._aihTotal });
                    keywordsList.appendChild(header);

                    items.forEach(function (kw) {
                        const row = document.createElement("div");
                        Object.assign(row.style, {
                            display: "flex", alignItems: "center", gap: "4px",
                            padding: "3px 4px", borderRadius: "3px", marginBottom: "2px",
                            background: "#2d3748",
                            border: "1px solid #555",
                        });

                        // Icône
                        const icon = document.createElement("span");
                        icon.textContent = "🔑";
                        icon.style.cssText = "flex-shrink:0;font-size:10px;";

                        // Mot-clé
                        const kwText = document.createElement("span");
                        kwText.textContent = kw.keyword || (typeof kw === "string" ? kw : "");
                        kwText.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;";

                        // Description si présente
                        const desc = document.createElement("span");
                        if (kw.description) {
                            desc.textContent = kw.description;
                            desc.style.cssText = "font-size:10px;color:#999;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px;flex-shrink:1;";
                        } else {
                            desc.style.display = "none";
                        }

                        row.appendChild(icon);
                        row.appendChild(kwText);
                        if (kw.description) row.appendChild(desc);
                        keywordsList.appendChild(row);
                    });
                }

                // Initial render
                renderKeywords();

                // ========================================
                // Assemble le container
                // ========================================
                container.appendChild(row1);
                container.appendChild(row2);
                container.appendChild(row3);
                container.appendChild(row4);
                container.appendChild(row5);
                container.appendChild(row6);
                container.appendChild(keywordsList);

                // ---- Intégration DOM widget ----
                const domWidget = node.addDOMWidget("keywords_ui", "custom", container, {
                    serialize: false,
                    getValue: () => "",
                    setValue: (v) => {},
                    getMinHeight: () => 320,  // ← minHeight pour computeLayoutSize (widget "growable")
                });
                domWidget.serialize = false;          // persistance workflow (widgets_values)
                domWidget.options = domWidget.options || {};
                domWidget.options.serialize = false;  // prompt API

                // ---- Constantes de hauteur (conservées pour référence) ----
                // La hauteur du DOM widget est désormais gérée nativement par la frontend
                // via getMinHeight / computeLayoutSize. Ces constantes ne sont plus utilisées
                // dans computeSize/onResize/rAF mais conservées pour d'éventuels usages futurs.
                const DOM_WIDGET_HEIGHT = 320;
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

                // ---- Taille minimum ----
                const MIN_WIDTH = 340;

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
                requestAnimationFrame(() => {
                    if (node.size && node.size[0] < MIN_WIDTH) {
                        node.setSize([MIN_WIDTH, node.size[1]]);
                    }
                    container.style.width = (node.size[0] - 20) + "px";
                });

                // ---- Persistance workflow (restauration) ----

                /**
                 * Attend que les sections soient chargées (max ~10s), puis positionne
                 * sectionSel + charge les sous-sections, positionne subsectionSel,
                 * met à jour config.section/subsection, et lance fetchKeywords().
                 */
                function doSetSectionSub(section, subsection, attempt) {
                    attempt = attempt || 0;
                    if (!_sectionsLoaded) {
                        if (attempt < 100) {
                            setTimeout(function () { doSetSectionSub(section, subsection, attempt + 1); }, 100);
                        } else {
                            // Timeout : sections jamais chargées (API down / 401).
                            // On applique quand même la config et on fetch.
                            console.warn("[AIH.Keywords] doSetSectionSub: sections jamais chargées, on applique quand même.");
                            config.section = section || "";
                            config.subsection = subsection || "";
                            sectionSel.value = config.section;
                            subsectionSel.value = config.subsection;
                            fetchKeywords();
                        }
                        return;
                    }
                    // Sections disponibles → on peut positionner
                    config.section = section || "";
                    config.subsection = subsection || "";
                    sectionSel.value = config.section;
                    if (section) {
                        // Charger les sous-sections, puis positionner la subsection
                        loadSubsections(section).then(function () {
                            subsectionSel.value = config.subsection;
                            // Tout est positionné → lancer le fetch (pas debounce)
                            fetchKeywords();
                        }).catch(function () {
                            fetchKeywords();
                        });
                    } else {
                        // Pas de section → vider les sous-sections
                        subsectionSel.innerHTML = '<option value="">' + t("kw.subsectionPlaceholder") + '</option>';
                        fetchKeywords();
                    }
                }

                /**
                 * Applique une config (objet) sur l'état interne ET sur les champs UI,
                 * puis déclenche fetchKeywords() via doSetSectionSub.
                 * Utilisée par loadFilter et restoreFromWidgets.
                 */
                function applyConfigToUI(cfg) {
                    // Champs simples (sans dépendance async)
                    if (cfg.include !== undefined) {
                        config.include = cfg.include || "";
                        includeInput.value = config.include;
                    }
                    if (cfg.exclude !== undefined) {
                        config.exclude = cfg.exclude || "";
                        excludeInput.value = config.exclude;
                    }
                    if (cfg.semantic !== undefined) {
                        config.semantic = cfg.semantic || "";
                        semanticInput.value = config.semantic;
                    }
                    if (cfg.nsfw !== undefined) {
                        // String(null) === "null" → bug : filtrer explicitement
                        config.nsfw = (cfg.nsfw === null || cfg.nsfw === "") ? "" : String(cfg.nsfw);
                        nsfwSel.value = config.nsfw;
                    }
                    if (cfg.min_confidence !== undefined) {
                        const pct = Math.round((cfg.min_confidence || 0) * 100);
                        config.min_confidence = pct / 100;
                        confSlider.value = String(pct);
                        confVal.textContent = pct + "%";
                    }
                    if (cfg.output_format !== undefined) {
                        config.output_format = cfg.output_format || "text";
                        if (formatSel) formatSel.value = config.output_format;
                    }

                    // Section / Subsection (dépendent du chargement async des listes)
                    // → doSetSectionSub met config.section/subsection à jour ET fetch.
                    doSetSectionSub(cfg.section || "", cfg.subsection || "");
                }

                /**
                 * Restaure l'état complet du node depuis le widget caché _keywords_config.
                 * Retourne true si la restauration a réussi, false sinon.
                 */
                function restoreFromWidgets(n) {
                    const kwc = n.widgets?.find(w => w.name === "_keywords_config");
                    if (!kwc || !kwc.value || kwc.value === "{}" || kwc.value === "") {
                        return false;
                    }
                    try {
                        const data = JSON.parse(kwc.value);
                        if (!data.config) {
                            return false;
                        }

                        const cfg = data.config;

                        // 1. Config + champs UI (inclut section/subsection + fetch)
                        applyConfigToUI(cfg);

                        // 2. Mots-clés (état restauré immédiatement, le fetch
                        //    déclenché par applyConfigToUI rafraîchira ensuite)
                        if (data.keywords && Array.isArray(data.keywords)) {
                            node._aihKeywords = data.keywords;
                            node._aihTotal = data.total || data.keywords.length;
                            renderKeywords();
                        }

                        // 3. Synchroniser le widget caché avec l'état restauré
                        syncKeywordsConfig();
                        return true;
                    } catch (err) {
                        console.warn("[AIH.Keywords] restore error:", err);
                        return false;
                    }
                }

                node._aihKeywordsRestore = restoreFromWidgets.bind(null, node);

                // Fallback : tentative périodique de restauration
                let restoreAttempts = 0;
                function delayedRestore() {
                    if (restoreFromWidgets(node)) return;
                    restoreAttempts++;
                    if (restoreAttempts < 20) {
                        setTimeout(delayedRestore, 300);
                    }
                }
                setTimeout(delayedRestore, 100);

                // ---- Stockage refs ----
                node._keywordsList = keywordsList;
                node._domWidget = domWidget;

                // Sync initial — ne pas écraser les données chargées par configure()
                var _kc = node.widgets?.find(w => w.name === "_keywords_config");
                var _hasSaved = _kc && _kc.value && _kc.value !== "{}" && _kc.value !== "";
                if (!_hasSaved) {
                    // Nouveau node sans données : initialiser
                    if (_kc && (!_kc.value || _kc.value === "" || _kc.value === "{}")) {
                        _kc.value = "{}";
                    }
                    if (node._aihKeywords && node._aihKeywords.length > 0) {
                        syncKeywordsConfig();
                    }
                }

                return r;
            };
        },

        // Hook appelé APRÈS que ComfyUI a restauré les widgets
        async loadedGraphNode(node) {
            if (node._aihKeywordsRestore) {
                setTimeout(() => node._aihKeywordsRestore(), 0);
            }
        },
    });
})();

// ========================
// Filter picker modal
// ========================

function showFilterPicker(filters, onSelect) {
    var html = '<div style="max-height:50vh;overflow-y:auto;">';

    if (filters.length > 0) {
        filters.forEach(function(f) {
            html += '<div class="aih-filter-item" data-id="' + f.id + '" style="padding:6px 8px;cursor:pointer;border-radius:4px;font-size:12px;color:#ccc;background:#3a3a3e;margin-bottom:2px;">' +
                esc(f.name || f.filter_name || t("kw.filterLabel", { id: f.id })) + (f.nsfw ? ' 🔞' : '') +
                ' <span style="color:#888;font-size:10px;">' + (f.owner_name || f.user_id?.substring(0,6) || "") + '</span></div>';
        });
    } else {
        html += '<p style="font-size:12px;color:#666;">' + t("kw.noFilter") + '</p>';
    }
    html += '</div>';

    var modalFn = window.aihOpenModalV2 || function (opts) {
        // Fallback basique si la modal V2 n'est pas chargée
        var bg = document.createElement("div");
        Object.assign(bg.style, {
            position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
            background: "rgba(0,0,0,0.5)", zIndex: 99998,
            display: "flex", alignItems: "center", justifyContent: "center",
        });
        var box = document.createElement("div");
        Object.assign(box.style, {
            background: "#2a2a2e", borderRadius: "8px", padding: "16px",
            maxWidth: opts.width || "380px", width: "100%",
            maxHeight: opts.maxHeight || "70vh", overflow: "auto",
            border: "1px solid #555",
        });
        box.innerHTML = '<h3 style="margin:0 0 8px;font-size:14px;color:#fff;">' + (opts.title || "") + '</h3>' +
            (opts.content || "");
        bg.appendChild(box);
        document.body.appendChild(bg);
        return {
            modal: box,
            close: function () { bg.remove(); },
        };
    };

    var m = modalFn({
        title: t("kw.loadFilterTitle"),
        content: html,
        width: "380px",
        height: "auto",
        minHeight: "150px",
        maxHeight: "70vh",
        resizable: false,
        storageKey: "aih:keywords-filter",
        persistPos: true,
        persistSize: true,
    });

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
