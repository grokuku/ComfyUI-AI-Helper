/*
 * Developer: Gemini (AI Assistant), under the direction of Holaf
 * Date: 2025-05-24
 *
 * This script provides the client-side logic for the Holaf Custom Nodes Manager.
 *
 * MODIFIED: Added GitHub repository detection and fetching of remote READMEs.
 * MODIFIED: Added 'marked.js' via CDN for Markdown-to-HTML rendering.
 * MODIFIED: Updated UI to show Git status and link, and render HTML.
 * MODIFIED: Added GitHub search for manually installed nodes as a fallback.
 * CORRECTION: Improved README fetching logic to be more robust and provide clearer status messages.
 * MODIFIED: Added checkboxes for node selection and action buttons (Update, Delete, Install R.).
 * MODIFIED: Inverted order of icons (Requirements then Git/Manual).
 * MODIFIED: Connected action buttons to backend API endpoints. Added result display.
 * MODIFIED: Updated 'Update' logic to differentiate between local Git repos and found URLs in UI.
 * MODIFIED: Updated `_executeNodeAction` and `handleUpdateSelected` to send `node_payloads` with `repo_url_override`.
 * CORRECTION: Trigger GitHub URL search for manual nodes upon selection to correctly update button states.
 * CORRECTION: Ensure "In Progress" dialog is removed before showing results/error dialog.
 * MODIFIED: Use `new_status` from backend to update node state locally before full refresh.
 * CORRECTION: Removed dynamic menu registration. Menu is now built statically by holaf_main.js.
 * MODIFICATION: Added unified header controls (theme, zoom) for UI consistency and independent theme management.
 * CORRECTION: Called ensureScriptsLoaded() in show() to enable Markdown rendering.
 * MODIFICATION: Implemented zoom functionality with settings persistence.
 * CORRECTION: Isolated zoom effect to the content container, excluding the header.
 * MODIFICATION: Added name filter input to the Nodes Manager toolbar.
 * MODIFICATION: Implemented persistence for filterText.
 * CORRECTION: Ensured panel position is correctly loaded using x/y from settings if panel_x/panel_y are null.
 * CORRECTION: Ensured `init` awaits `loadSettings` for proper filter text loading on startup.
 * MODIFICATION: Added "Search GitHub" and "Install via URL" buttons with associated logic and UI dialogs.
 */

import "./aih_dialog.js";
import "./aih_strings.js";
import { app } from "./holaf_api_compat.js";
import { HolafPanelManager } from "./holaf_panel_manager.js";
import { HOLAF_THEMES } from "./holaf_themes.js";
import { escapeHtml, sanitizeMarkdownHtml, sanitizeUrl } from "./holaf_dom_utils.js";
import { HolafFetch, HolafFetchError } from "./vendor/holaf/holaf-fetch.js";

// Helper i18n central : traduit via AIH.I18n (clé brute si absente).
const t = (key, params) => {
    const I = window.AIH && window.AIH.I18n;
    return I && typeof I.t === "function" ? I.t(key, params) : key;
};

// Helper to load external scripts
function loadScript(src, id) {
    return new Promise((resolve, reject) => {
        if (document.getElementById(id)) {
            resolve();
            return;
        }
        const script = document.createElement("script");
        script.src = src;
        script.id = id;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
        document.head.appendChild(script);
    });
}

const holafNodesManager = {
    panelElements: null,
    isInitialized: false,
    scriptsLoaded: false,
    nodesList: [],
    currentlyDisplayedNode: null, // Node whose README is shown
    selectedNodes: new Set(), // For actions like update/delete
    isActionInProgress: false, // To disable buttons during an action
    settings: {
        theme: "Graphite Orange",
        panel_x: null,
        panel_y: null,
        panel_width: 900,
        panel_height: 600,
        panel_is_fullscreen: false,
        zoom_level: 1.0,
        filter_text: "",
        x: null,
        y: null
    },
    saveSettingsTimeout: null,
    filterText: "",

    async init() { // Made init async
        await this.loadSettings(); // Await loading of settings
    },

    async loadSettings() {
        try {
            // HolafFetch lève sur non-2xx (→ catch : log existant).
            const allSettings = await HolafFetch.get('/holaf/utilities/settings');
            if (allSettings.NodesManagerUI) {
                const fetchedSettings = allSettings.NodesManagerUI;
                const validTheme = HOLAF_THEMES.find(t => t.name === fetchedSettings.theme);
                this.settings = { ...this.settings, ...fetchedSettings };
                if (!validTheme) {
                    this.settings.theme = HOLAF_THEMES[0].name;
                }
                this.filterText = this.settings.filter_text || ""; // Initialize runtime filter from loaded settings
                // No need to set this.settings.filter_text here again, it's already set by the spread
            }
        } catch (e) {
            console.error("[Holaf NodesManager] Could not load settings:", e);
        }
    },

    saveSettings() {
        clearTimeout(this.saveSettingsTimeout);
        this.saveSettingsTimeout = setTimeout(async () => {
            this.settings.filter_text = this.filterText; // Ensure current runtime filter is in settings object
            try {
                const settingsToSave = {
                    theme: this.settings.theme,
                    panel_x: this.settings.panel_x,
                    panel_y: this.settings.panel_y,
                    panel_width: this.settings.panel_width,
                    panel_height: this.settings.panel_height,
                    panel_is_fullscreen: this.settings.panel_is_fullscreen,
                    zoom_level: this.settings.zoom_level,
                    filter_text: this.settings.filter_text
                };
                if (this.settings.panel_x === null && this.settings.x !== null) settingsToSave.x = this.settings.x;
                if (this.settings.panel_y === null && this.settings.y !== null) settingsToSave.y = this.settings.y;

                // HolafFetch lève sur non-2xx (→ catch : log existant).
                await HolafFetch.post('/holaf/utilities/save-all-settings', { body: { NodesManagerUI: settingsToSave } });
            } catch (e) {
                console.error("[Holaf NodesManager] Exception during saveSettings fetch:", e);
            }
        }, 1000);
    },

    async ensureScriptsLoaded() {
        if (this.scriptsLoaded) return true;
        try {
            await loadScript("https://cdn.jsdelivr.net/npm/marked/marked.min.js", "holaf-marked-script");
            this.scriptsLoaded = true;
            return true;
        } catch (error) {
            console.error("[Holaf NodesManager] Critical error loading marked.js script", error);
            AIH.ask({ title: t("nm.componentError"), message: t("nm.componentErrorMsg") });
            return false;
        }
    },

    createThemeMenu() {
        const menu = document.createElement("ul");
        menu.className = "holaf-theme-menu";
        HOLAF_THEMES.forEach(theme => {
            const item = document.createElement("li");
            item.textContent = theme.name;
            item.onclick = (e) => {
                e.stopPropagation();
                this.setTheme(theme.name);
                menu.style.display = 'none';
            };
            menu.appendChild(item);
        });
        return menu;
    },

    setTheme(themeName, doSave = true) {
        const themeConfig = HOLAF_THEMES.find(t => t.name === themeName);
        if (!themeConfig) {
            console.warn(`[Holaf NodesManager] Theme '${themeName}' not found.`);
            return;
        }
        this.settings.theme = themeName;
        if (this.panelElements && this.panelElements.panelEl) {
            HOLAF_THEMES.forEach(t => {
                this.panelElements.panelEl.classList.remove(t.className);
            });
            this.panelElements.panelEl.classList.add(themeConfig.className);
        }
        if (doSave) this.saveSettings();
    },

    setZoom(newZoom, doSave = true) {
        const zoomLevel = Math.max(0.5, Math.min(2.5, newZoom));
        this.settings.zoom_level = zoomLevel;

        // Applique la variable canonique --aih-zoom-factor sur le conteneur de
        // CONTENU (exclut le header) — pattern Nodes Manager.
        if (this.panelElements && this.panelElements.contentEl) {
            this.panelElements.contentEl.style.setProperty('--aih-zoom-factor', zoomLevel);
        }

        if (doSave) {
            this.saveSettings();
        }
    },

    createPanel() {
        if (this.panelElements && this.panelElements.panelEl) return;

        const headerControls = document.createElement("div");
        headerControls.className = "holaf-header-button-group";

        const themeButtonContainer = document.createElement("div");
        themeButtonContainer.style.position = 'relative';
        const themeButton = document.createElement("button");
        themeButton.className = "holaf-header-button";
        themeButton.title = t("nm.theme");
        themeButton.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 12.55a9.42 9.42 0 0 1-9.45 9.45 9.42 9.42 0 0 1-9.45-9.45 9.42 9.42 0 0 1 9.45-9.45 2.5 2.5 0 0 1 2.5 2.5 2.5 2.5 0 0 0 2.5 2.5 2.5 2.5 0 0 1 0 5 2.5 2.5 0 0 0-2.5 2.5 2.5 2.5 0 0 1-2.5 2.5Z"/></svg>`;
        const themeMenu = this.createThemeMenu();
        themeButton.onclick = (e) => {
            e.stopPropagation();
            themeMenu.style.display = themeMenu.style.display === 'block' ? 'none' : 'block';
        };
        document.addEventListener('click', () => { if (themeMenu) themeMenu.style.display = 'none' });
        themeButtonContainer.append(themeButton, themeMenu);

        // Boutons zoom standard gérés par HolafPanelManager.createPanel (options.zoom)
        headerControls.append(themeButtonContainer);

        try {
            this.panelElements = HolafPanelManager.createPanel({
                id: "holaf-nodes-manager-panel",
                title: t("nm.panelTitle"),
                headerContent: headerControls,
                zoom: {
                    key: "holaf-nodes-manager-panel",
                    min: 0.5,
                    max: 2.5,
                    step: 0.1,
                    getLevel: () => this.settings.zoom_level,
                    setLevel: (level) => {
                        this.settings.zoom_level = level;
                        this.setZoom(level, true);
                    },
                },
                defaultSize: {
                    width: this.settings.panel_width || this.settings.width || 900,
                    height: this.settings.panel_height || this.settings.height || 600
                },
                defaultPosition: {
                    x: this.settings.panel_x !== null && this.settings.panel_x !== undefined ? this.settings.panel_x : this.settings.x,
                    y: this.settings.panel_y !== null && this.settings.panel_y !== undefined ? this.settings.panel_y : this.settings.y
                },
                onClose: () => this.hide(),
                onStateChange: (newState) => {
                    if (!this.settings.panel_is_fullscreen) {
                        this.settings.panel_x = newState.x;
                        this.settings.panel_y = newState.y;
                        this.settings.panel_width = newState.width;
                        this.settings.panel_height = newState.height;
                        this.settings.x = newState.x;
                        this.settings.y = newState.y;
                        this.saveSettings();
                    }
                },
                onFullscreenToggle: (isFullscreen) => {
                    this.settings.panel_is_fullscreen = isFullscreen;
                    this.saveSettings();
                }
            });

            this.populatePanelContent();
            this.applyCurrentTheme();
            this.applyCurrentZoom();
        } catch (e) {
            console.error("[Holaf NodesManager] Error creating panel:", e);
            AIH.ask({ title: t("nm.panelError"), message: t("nm.panelErrorMsg") });
        }
    },

    populatePanelContent() {
        const contentEl = this.panelElements.contentEl;
        contentEl.innerHTML = `
            <div class="holaf-nodes-manager-container">
                <div id="holaf-nodes-manager-left-pane" class="holaf-nodes-manager-left-pane">
                    <div class="holaf-nodes-manager-toolbar">
                        <button id="holaf-nodes-manager-refresh-btn" class="comfy-button" title="${t("nm.refreshTitle")}">${t("nm.refresh")}</button>
                        <input type="text" id="holaf-nodes-manager-filter-input" class="holaf-nodes-manager-filter-input" placeholder="${t("nm.filterPlaceholder")}">
                        <input type="checkbox" id="holaf-nodes-manager-select-all-cb" title="${t("nm.selectAllTitle")}" style="margin-left: 10px; vertical-align: middle;">
                        <span id="holaf-nodes-manager-selected-count" style="margin-left: 5px; font-size: 0.9em; color: var(--holaf-text-secondary);">${t("nm.selectedCount", { count: 0 })}</span>
                    </div>
                    <div id="holaf-nodes-manager-list" class="holaf-nodes-manager-list">
                        <p class="holaf-manager-message">${t("nm.clickToScan")}</p>
                    </div>
                    <div class="holaf-nodes-manager-actions-toolbar" style="padding: 8px; border-top: 1px solid var(--holaf-border-color); display: flex; gap: 5px; flex-wrap: wrap; align-items: center;">
                        <button id="holaf-nodes-manager-update-btn" class="comfy-button" disabled title="${t("nm.updateTitle")}">${t("nm.update")}</button>
                        <button id="holaf-nodes-manager-req-btn" class="comfy-button" disabled title="${t("nm.installReqTitle")}">${t("nm.installReq")}</button>
                        <button id="holaf-nodes-manager-delete-btn" class="comfy-button" disabled title="${t("nm.deleteTitle")}" style="background-color: var(--holaf-error-color, #c0392b);">${t("nm.delete")}</button>
                        <div style="flex-grow: 1;"></div>
                        <button id="holaf-nodes-manager-install-url-btn" class="comfy-button" title="${t("nm.installUrlTitle")}" style="border: 1px solid var(--holaf-accent-color);">${t("nm.installUrl")}</button>
                        <button id="holaf-nodes-manager-search-github-btn" class="comfy-button" title="${t("nm.searchGithubTitle")}" style="background-color: var(--holaf-accent-color); color: white;">${t("nm.searchGithub")}</button>
                    </div>
                </div>
                <div id="holaf-nodes-manager-right-pane" class="holaf-nodes-manager-right-pane">
                    <div id="holaf-nodes-manager-readme-header" class="holaf-nodes-manager-readme-header">
                        ${t("nm.selectNodeDetails")}
                    </div>
                    <div id="holaf-nodes-manager-readme-content" class="holaf-nodes-manager-readme-content">
                        <!-- README content will be rendered here -->
                    </div>
                </div>
            </div>
        `;

        document.getElementById("holaf-nodes-manager-refresh-btn").onclick = () => this.refreshNodesList();

        const filterInputEl = document.getElementById("holaf-nodes-manager-filter-input");
        filterInputEl.value = this.filterText;
        filterInputEl.oninput = (e) => {
            this.filterText = e.target.value.toLowerCase();
            this.saveSettings();
            this.renderNodesList();
        };

        document.getElementById("holaf-nodes-manager-select-all-cb").onchange = (e) => this.toggleSelectAll(e.target.checked);

        document.getElementById("holaf-nodes-manager-update-btn").onclick = () => this.handleUpdateSelected();
        document.getElementById("holaf-nodes-manager-req-btn").onclick = () => this.handleInstallRequirementsSelected();
        document.getElementById("holaf-nodes-manager-delete-btn").onclick = () => this.handleDeleteSelected();
        document.getElementById("holaf-nodes-manager-install-url-btn").onclick = () => this.handleInstallViaUrl();
        document.getElementById("holaf-nodes-manager-search-github-btn").onclick = () => this.handleSearchGithub();

        this.updateActionButtonsState();
    },

    async refreshNodesList() {
        if (this.isActionInProgress) return;
        const listEl = document.getElementById("holaf-nodes-manager-list");
        const readmeHeaderEl = document.getElementById("holaf-nodes-manager-readme-header");
        const readmeContentEl = document.getElementById("holaf-nodes-manager-readme-content");
        if (!listEl || !readmeHeaderEl || !readmeContentEl) return;

        listEl.innerHTML = `<p class="holaf-manager-message">${t("nm.scanning")}</p>`;

        const oldSelectedNodeName = this.currentlyDisplayedNode ? this.currentlyDisplayedNode.name : null;

        try {
            // HolafFetch lève sur non-2xx avec le message serveur (body.error) →
            // même gestion d'erreur que l'ancien throw explicite.
            const data = await HolafFetch.get("/holaf/nodes/list");
            this.nodesList = data.nodes || [];
            this.renderNodesList();

            if (oldSelectedNodeName) {
                const stillExistsNode = this.nodesList.find(n => n.name === oldSelectedNodeName);
                if (stillExistsNode) {
                    this.displayReadmeForNode(stillExistsNode);
                } else {
                    readmeHeaderEl.textContent = t("nm.selectNodeDetails");
                    readmeContentEl.innerHTML = '';
                    this.currentlyDisplayedNode = null;
                }
            }
        } catch (e) {
            console.error("[Holaf NodesManager] Error fetching node list:", e);
            listEl.innerHTML = `<p class="holaf-manager-message error">${t("nm.loadError")}</p>`;
            readmeHeaderEl.textContent = t("nm.loadErrorTitle");
            readmeContentEl.innerHTML = '';
            this.currentlyDisplayedNode = null;
        }
        this.updateActionButtonsState();
    },

    getFilteredNodes() {
        if (!this.filterText) return this.nodesList;
        return this.nodesList.filter(node => node.name.toLowerCase().includes(this.filterText));
    },

    renderNodesList() {
        const listEl = document.getElementById("holaf-nodes-manager-list");
        if (!listEl) return;

        const filteredNodes = this.getFilteredNodes();

        if (filteredNodes.length === 0) {
            listEl.innerHTML = `<p class="holaf-manager-message">${this.nodesList.length === 0 ? t("nm.noNodes") : t("nm.noMatch")}</p>`;
            this.updateSelectAllCheckboxState();
            return;
        }

        listEl.innerHTML = '';
        filteredNodes.forEach(node => {
            const itemEl = document.createElement("div");
            itemEl.className = "holaf-nodes-manager-list-item";
            if (this.currentlyDisplayedNode && this.currentlyDisplayedNode.name === node.name) {
                itemEl.classList.add("selected-readme");
            }

            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.className = "holaf-nodes-manager-item-cb";
            checkbox.checked = this.selectedNodes.has(node.name);
            checkbox.dataset.nodeName = node.name;
            checkbox.style.marginRight = "8px";
            checkbox.style.verticalAlign = "middle";
            checkbox.onclick = (e) => {
                e.stopPropagation();
            };
            checkbox.onchange = async (e) => {
                const nodeName = e.target.dataset.nodeName;
                const nodeObj = this.nodesList.find(n => n.name === nodeName);

                if (e.target.checked) {
                    this.selectedNodes.add(nodeName);
                    if (nodeObj && !nodeObj.is_git_repo && !nodeObj.repo_url) {
                        try {
                            // Recherche d'arrière-plan : HolafFetch lève sur non-2xx
                            // (→ catch : simple console.warn, comme avant).
                            const searchData = await HolafFetch.get(`/holaf/nodes/search/github/${encodeURIComponent(nodeName)}`);
                            if (searchData.url) {
                                nodeObj.repo_url = searchData.url;
                                this.rerenderNodeItemIcons(nodeName, nodeObj);
                            }
                        } catch (searchError) {
                            console.warn(`[Holaf NodesManager] Background GitHub search for ${nodeName} failed:`, searchError);
                        }
                    }
                } else {
                    this.selectedNodes.delete(nodeName);
                }
                this.updateActionButtonsState();
                this.updateSelectAllCheckboxState();
            };
            itemEl.appendChild(checkbox);

            const nameSpan = document.createElement("span");
            nameSpan.textContent = node.name;
            nameSpan.style.cursor = "pointer";
            itemEl.appendChild(nameSpan);

            this._appendIconsToItem(itemEl, node);

            itemEl.onclick = (e) => {
                if (e.target.type === 'checkbox') return;
                this.displayReadmeForNode(node);
            };
            listEl.appendChild(itemEl);
        });
        this.updateSelectAllCheckboxState();
    },

    _appendIconsToItem(itemEl, nodeData) {
        const existingIconsContainer = itemEl.querySelector('span[data-holaf-icons="true"]');
        if (existingIconsContainer) {
            itemEl.removeChild(existingIconsContainer);
        }

        let iconsHTML = '';
        if (nodeData.has_requirements_txt) {
            iconsHTML += `<svg title="${t("nm.hasReq")}" class="holaf-nodes-manager-req-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="color: var(--holaf-text-secondary);"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm-1 9h-2v2H9v-2H7v-2h2V9h2v2h2v2zm4-10H5V2.5L13 2.5V3c0 .55.45 1 1 1h.5v.5z"/></svg>`;
        }

        if (nodeData.is_git_repo && nodeData.repo_url) {
            iconsHTML += `<svg title="${t("nm.localGitTitle", { url: nodeData.repo_url })}" class="holaf-nodes-manager-git-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0v1a6 6 0 0 0 6 6h1a5 5 0 0 0 5-5V8zm-6 6a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"/><path d="M12 14v6"/><path d="M15 17H9"/></svg>`;
        } else if (nodeData.repo_url) {
            iconsHTML += `<svg title="${t("nm.manualGitTitle", { url: nodeData.repo_url })}" class="holaf-nodes-manager-manual-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--holaf-accent-color)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M12 12v9"/><path d="m8 17 4 4 4-4"/></svg>`;
        } else {
            iconsHTML += `<svg title="${t("nm.manualInstalled")}" class="holaf-nodes-manager-manual-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M12 12v9"/><path d="m8 17 4 4 4-4"/></svg>`;
        }

        const iconsContainer = document.createElement('span');
        iconsContainer.dataset.holafIcons = "true";
        iconsContainer.innerHTML = iconsHTML;
        iconsContainer.style.marginLeft = 'auto';
        iconsContainer.style.display = 'flex';
        iconsContainer.style.alignItems = 'center';
        iconsContainer.style.gap = '4px';
        itemEl.appendChild(iconsContainer);
    },

    displayReadmeForNode(node) {
        if (this.currentlyDisplayedNode && this.currentlyDisplayedNode.name === node.name) {
            const readmeContentEl = document.getElementById("holaf-nodes-manager-readme-content");
            if (readmeContentEl && !readmeContentEl.innerHTML.includes(`<p class="holaf-manager-message">${t("nm.loading")}</p>`)) {
                const listEl = document.getElementById("holaf-nodes-manager-list");
                listEl.querySelectorAll(".holaf-nodes-manager-list-item").forEach(item => {
                    const nameSpan = Array.from(item.childNodes).find(cn => cn.nodeName === "SPAN" && cn.parentElement === item && !cn.dataset.holafIcons);
                    item.classList.toggle("selected-readme", nameSpan && nameSpan.textContent === node.name);
                });
                return;
            }
        }

        this.currentlyDisplayedNode = node;

        const listEl = document.getElementById("holaf-nodes-manager-list");
        listEl.querySelectorAll(".holaf-nodes-manager-list-item").forEach(item => {
            const nameSpan = Array.from(item.childNodes).find(cn => cn.nodeName === "SPAN" && cn.parentElement === item && !cn.dataset.holafIcons);
            if (nameSpan) {
                item.classList.toggle("selected-readme", nameSpan.textContent === node.name);
            }
        });
        this.fetchReadme(node);
    },

    toggleSelectAll(checked) {
        if (this.isActionInProgress) return;

        const filteredNodes = this.getFilteredNodes();
        filteredNodes.forEach(node => {
            if (checked) {
                this.selectedNodes.add(node.name);
            } else {
                this.selectedNodes.delete(node.name);
            }
        });

        const listEl = document.getElementById("holaf-nodes-manager-list");
        if (listEl) {
            listEl.querySelectorAll(".holaf-nodes-manager-item-cb").forEach(cb => {
                const nodeName = cb.dataset.nodeName;
                if (filteredNodes.some(n => n.name === nodeName)) {
                    cb.checked = checked;
                }
            });
        }
        this.updateActionButtonsState();
        this.updateSelectAllCheckboxState();
    },

    updateSelectAllCheckboxState() {
        const selectAllCb = document.getElementById("holaf-nodes-manager-select-all-cb");
        if (!selectAllCb) return;

        const filteredNodes = this.getFilteredNodes();
        if (filteredNodes.length === 0) {
            selectAllCb.checked = false;
            selectAllCb.indeterminate = false;
            return;
        }

        const allVisibleSelected = filteredNodes.every(node => this.selectedNodes.has(node.name));
        const noneVisibleSelected = filteredNodes.every(node => !this.selectedNodes.has(node.name));

        if (allVisibleSelected) {
            selectAllCb.checked = true;
            selectAllCb.indeterminate = false;
        } else if (noneVisibleSelected) {
            selectAllCb.checked = false;
            selectAllCb.indeterminate = false;
        } else {
            selectAllCb.checked = false;
            selectAllCb.indeterminate = true;
        }
    },

    updateActionButtonsState() {
        const selectedCount = this.selectedNodes.size;
        const selectedCountEl = document.getElementById("holaf-nodes-manager-selected-count");
        if (selectedCountEl) {
            selectedCountEl.textContent = t("nm.selectedCount", { count: selectedCount });
        }

        const updateBtn = document.getElementById("holaf-nodes-manager-update-btn");
        const reqBtn = document.getElementById("holaf-nodes-manager-req-btn");
        const deleteBtn = document.getElementById("holaf-nodes-manager-delete-btn");
        const refreshBtn = document.getElementById("holaf-nodes-manager-refresh-btn");
        const selectAllCb = document.getElementById("holaf-nodes-manager-select-all-cb");
        const filterInput = document.getElementById("holaf-nodes-manager-filter-input");
        const installUrlBtn = document.getElementById("holaf-nodes-manager-install-url-btn");
        const searchGithubBtn = document.getElementById("holaf-nodes-manager-search-github-btn");


        if (!updateBtn || !reqBtn || !deleteBtn || !refreshBtn || !selectAllCb || !filterInput) return;

        const baseDisabled = this.isActionInProgress;
        refreshBtn.disabled = baseDisabled;
        selectAllCb.disabled = baseDisabled;
        filterInput.disabled = baseDisabled;
        installUrlBtn.disabled = baseDisabled;
        searchGithubBtn.disabled = baseDisabled;

        if (baseDisabled) {
            updateBtn.disabled = true;
            reqBtn.disabled = true;
            deleteBtn.disabled = true;
            return;
        }

        if (selectedCount === 0) {
            updateBtn.disabled = true;
            reqBtn.disabled = true;
            deleteBtn.disabled = true;
            return;
        }

        deleteBtn.disabled = false;

        let canUpdateAny = false;
        let canInstallReqAny = false;

        for (const nodeName of this.selectedNodes) {
            const node = this.nodesList.find(n => n.name === nodeName);
            if (node) {
                if (node.is_git_repo || node.repo_url) {
                    canUpdateAny = true;
                }
                if (node.has_requirements_txt) {
                    canInstallReqAny = true;
                }
            }
        }
        updateBtn.disabled = !canUpdateAny;
        reqBtn.disabled = !canInstallReqAny;
    },

    async fetchReadme(node) {
        const headerEl = document.getElementById("holaf-nodes-manager-readme-header");
        const contentEl = document.getElementById("holaf-nodes-manager-readme-content");

        headerEl.innerHTML = `<h3>${escapeHtml(node.name)}</h3>`;
        contentEl.innerHTML = `<p class="holaf-manager-message">${t("nm.loading")}</p>`;

        let effectiveRepoUrl = node.repo_url;
        let readmeText = null;
        let source = 'local';
        let repoUrlWasFoundThisCall = false;

        if (!node.is_git_repo && !effectiveRepoUrl) {
            contentEl.innerHTML = `<p class="holaf-manager-message">${t("nm.searchingGithub", { name: escapeHtml(node.name) })}</p>`;
            try {
                // HolafFetch lève sur non-2xx (→ catch : console.warn, comme avant).
                const searchData = await HolafFetch.get(`/holaf/nodes/search/github/${encodeURIComponent(node.name)}`);
                if (searchData.url) {
                    effectiveRepoUrl = searchData.url;
                    repoUrlWasFoundThisCall = true;
                    node.repo_url = effectiveRepoUrl;
                    this.rerenderNodeItemIcons(node.name, node);
                }
            } catch (e) {
                console.warn(`[Holaf NodesManager] GitHub search failed for ${node.name}:`, e);
            }
        }

        let githubLinkText = t("nm.githubRepo");
        if (node.is_git_repo && node.repo_url) githubLinkText = t("nm.localGitSource");
        else if (repoUrlWasFoundThisCall) githubLinkText = t("nm.foundOnGithub");
        else if (node.repo_url) githubLinkText = t("nm.detectedRemote");

        if (effectiveRepoUrl) {
            const repoLink = `<a href="${escapeHtml(sanitizeUrl(effectiveRepoUrl))}" target="_blank" rel="noopener noreferrer" title="${t("nm.openOnGithub")}">${escapeHtml(githubLinkText)}</a>`;
            headerEl.innerHTML = `<h3>${escapeHtml(node.name)}</h3> ${repoLink}`;
            contentEl.innerHTML = `<p class="holaf-manager-message">${t("nm.fetchingReadme", { url: escapeHtml(effectiveRepoUrl) })}</p>`;
            const match = effectiveRepoUrl.match(/github\.com[/:]([^/]+\/[^/]+)/);
            if (match && match[1]) {
                const [owner, repoWithGit] = match[1].split('/');
                const repo = repoWithGit.replace(/\.git$/, '');
                try {
                    // README = texte brut (text/plain) → raw:true : la brique rend
                    // la Response brute SANS throw sur non-2xx, la logique de
                    // repli vers le README local reste identique.
                    const response = await HolafFetch.post('/holaf/nodes/readme/github', { body: { owner, repo }, raw: true });
                    if (response.ok) {
                        readmeText = await response.text();
                        source = node.is_git_repo ? t("nm.sourceLocalGit") : t("nm.sourceFoundRemote");
                    } else {
                        console.warn(`[Holaf NodesManager] GitHub README fetch non-OK for ${owner}/${repo}: ${response.status}`);
                    }
                } catch (e) {
                    console.error(`[Holaf NodesManager] Network error fetching GitHub README for ${owner}/${repo}:`, e);
                }
            }
        }

        if (readmeText === null) {
            if (effectiveRepoUrl) {
                contentEl.innerHTML = `<p class="holaf-manager-message">${t("nm.cantRetrieveReadme")}</p>`;
            } else {
                headerEl.innerHTML = `<h3>${escapeHtml(node.name)}</h3>`;
                contentEl.innerHTML = `<p class="holaf-manager-message">${t("nm.noRepoChecking")}</p>`;
            }
            try {
                // README local = texte brut → raw:true (pas de throw sur non-2xx).
                const response = await HolafFetch.get(`/holaf/nodes/readme/local/${encodeURIComponent(node.name)}`, { raw: true });
                if (response.ok) {
                    readmeText = await response.text();
                    source = t("nm.sourceLocalFile");
                }
            } catch (e) {
                console.error(`[Holaf NodesManager] Error fetching local README for ${node.name}:`, e);
            }
        }

        if (readmeText === null) {
            readmeText = t("nm.noReadme", { name: node.name });
            if (!effectiveRepoUrl) {
                headerEl.innerHTML = `<h3>${escapeHtml(node.name)}</h3>`;
            }
        }

        if (this.scriptsLoaded && window.marked) {
            contentEl.innerHTML = sanitizeMarkdownHtml(window.marked.parse(readmeText));
        } else {
            contentEl.textContent = readmeText;
        }

        const sourceTag = document.createElement('span');
        sourceTag.className = 'readme-source-tag';
        sourceTag.textContent = t("nm.source", { source });
        sourceTag.style.fontSize = '0.8em';
        sourceTag.style.marginLeft = '10px';
        sourceTag.style.color = 'var(--holaf-text-secondary)';
        headerEl.appendChild(sourceTag);
    },

    rerenderNodeItemIcons(nodeName, nodeData) {
        const listEl = document.getElementById("holaf-nodes-manager-list");
        if (!listEl) return;

        const items = listEl.querySelectorAll(".holaf-nodes-manager-list-item");
        for (const itemEl of items) {
            const checkbox = itemEl.querySelector('.holaf-nodes-manager-item-cb');
            if (checkbox && checkbox.dataset.nodeName === nodeName) {
                this._appendIconsToItem(itemEl, nodeData);
                break;
            }
        }
    },

    async _checkAuthStatus() {
        try {
            // HolafFetch lève sur non-2xx (→ catch : {false, false}, comme avant) ;
            // `cache` est une option native, forwardée telle quelle.
            const data = await HolafFetch.get('/holaf/auth/status', { cache: 'no-store' });
            return {
                authenticated: data.authenticated === true,
                passwordConfigured: data.password_configured === true
            };
        } catch (e) {
            console.warn("[Holaf NodesManager] Auth status check failed:", e);
            return { authenticated: false, passwordConfigured: false };
        }
    },

    _showLoginModal(message = t("nm.authRequiredMsg"), passwordNotConfigured = false) {
        return new Promise((resolve) => {
            const overlay = document.createElement("div");
            overlay.className = "holaf-dialog-overlay";
            overlay.style.zIndex = "210000";

            const dialog = document.createElement("div");
            dialog.className = "holaf-utility-panel holaf-dialog-inline";
            const themeClass = (this.panelElements && this.panelElements.panelEl
                ? this.panelElements.panelEl.className.match(/holaf-theme-\S+/)?.[0]
                : null) || HOLAF_THEMES[0].className;
            dialog.classList.add(themeClass);

            const header = document.createElement("div");
            header.className = "holaf-utility-header";
            header.style.cursor = "default";
            const title = document.createElement("span");
            title.textContent = passwordNotConfigured ? t("nm.passwordSetupRequired") : t("nm.authRequired");
            header.appendChild(title);

            const content = document.createElement("div");
            content.className = "holaf-dialog-content";
            content.style.whiteSpace = "normal";

            const info = document.createElement("p");
            info.textContent = passwordNotConfigured
                ? t("nm.noPasswordYet")
                : message;
            info.style.cssText = "margin:0 0 12px 0;color:var(--holaf-text-secondary);line-height:1.4;";

            const label = document.createElement("label");
            label.textContent = passwordNotConfigured ? t("nm.newPassword") : t("nm.password");
            label.style.cssText = "display:block;margin-bottom:5px;color:var(--holaf-text-primary);";

            const passwordInput = document.createElement("input");
            passwordInput.type = "password";
            passwordInput.autocomplete = passwordNotConfigured ? "new-password" : "current-password";
            passwordInput.style.cssText = "width:100%;padding:8px;box-sizing:border-box;background-color:var(--holaf-input-background);color:var(--holaf-text-primary);border:1px solid var(--holaf-border-color);border-radius:3px;outline:none;margin-bottom:10px;";

            const confirmLabel = document.createElement("label");
            const confirmInput = document.createElement("input");
            const manualContainer = document.createElement("div");

            if (passwordNotConfigured) {
                confirmLabel.textContent = t("nm.confirmPassword");
                confirmLabel.style.cssText = "display:block;margin-bottom:5px;color:var(--holaf-text-primary);";
                confirmInput.type = "password";
                confirmInput.autocomplete = "new-password";
                confirmInput.style.cssText = "width:100%;padding:8px;box-sizing:border-box;background-color:var(--holaf-input-background);color:var(--holaf-text-primary);border:1px solid var(--holaf-border-color);border-radius:3px;outline:none;margin-bottom:10px;";

                manualContainer.style.cssText = "display:none;margin-top:10px;padding:8px;border:1px dashed var(--holaf-border-color);border-radius:3px;";
                const manualTitle = document.createElement("p");
                manualTitle.textContent = t("nm.manualSetupRequired");
                manualTitle.style.cssText = "margin:0 0 6px 0;color:var(--holaf-text-secondary);";
                const manualSteps = document.createElement("p");
                manualSteps.textContent = t("nm.manualSteps");
                manualSteps.style.cssText = "margin:0 0 6px 0;color:var(--holaf-text-secondary);";
                const hashInput = document.createElement("input");
                hashInput.type = "text";
                hashInput.readOnly = true;
                hashInput.style.cssText = "width:100%;font-family:monospace;padding:6px;box-sizing:border-box;background-color:var(--holaf-input-background);color:var(--holaf-text-primary);border:1px solid var(--holaf-border-color);border-radius:3px;margin-bottom:6px;";
                const copyButton = document.createElement("button");
                copyButton.textContent = t("nm.copyHash");
                copyButton.className = "comfy-button";
                copyButton.addEventListener("click", () => {
                    if (hashInput.value) {
                        hashInput.select();
                        navigator.clipboard.writeText(hashInput.value).catch(() => document.execCommand("copy"));
                    }
                });
                manualContainer.append(manualTitle, manualSteps, hashInput, copyButton);
            }

            const statusMessage = document.createElement("p");
            statusMessage.style.cssText = "margin:0;color:var(--holaf-accent-color);font-size:0.9em;min-height:1.2em;";

            content.append(info, label, passwordInput);
            if (passwordNotConfigured) content.append(confirmLabel, confirmInput, manualContainer);
            content.append(statusMessage);

            const footer = document.createElement("div");
            footer.className = "holaf-dialog-footer";

            const cancelButton = document.createElement("button");
            cancelButton.textContent = t("nm.cancel");
            cancelButton.className = "comfy-button";
            cancelButton.style.backgroundColor = "var(--holaf-tag-background)";

            const actionButton = document.createElement("button");
            actionButton.textContent = passwordNotConfigured ? t("nm.createPassword") : t("nm.connect");
            actionButton.className = "comfy-button";
            actionButton.style.backgroundColor = "var(--holaf-accent-color)";
            actionButton.style.color = "white";

            footer.append(cancelButton, actionButton);
            dialog.append(header, content, footer);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            let resolved = false;

            const closeModal = (value) => {
                if (resolved) return;
                resolved = true;
                if (document.body.contains(overlay)) document.body.removeChild(overlay);
                resolve(value);
            };

            const submitLogin = async () => {
                const password = passwordInput.value;
                if (!password) {
                    statusMessage.textContent = t("nm.passEmpty");
                    passwordInput.focus();
                    return;
                }
                if (passwordNotConfigured) {
                    if (password.length < 4) {
                        statusMessage.textContent = t("nm.passTooShort");
                        passwordInput.focus();
                        return;
                    }
                    if (password !== confirmInput.value) {
                        statusMessage.textContent = t("nm.passMismatch");
                        confirmInput.focus();
                        return;
                    }
                }

                actionButton.disabled = true;
                cancelButton.disabled = true;
                passwordInput.disabled = true;
                if (confirmInput) confirmInput.disabled = true;
                statusMessage.textContent = passwordNotConfigured ? t("nm.creatingPassword") : t("nm.authenticating");

                try {
                    if (passwordNotConfigured) {
                        // HolafFetch lève sur non-2xx (→ catch partagé ci-dessous).
                        const setupData = await HolafFetch.post('/holaf/terminal/set-password', { body: { password } });

                        if (setupData.status === "manual_required" && setupData.hash) {
                            const hashInput = manualContainer.querySelector('input[readonly]');
                            if (hashInput) hashInput.value = `password_hash = ${setupData.hash}`;
                            manualContainer.style.display = "block";
                            statusMessage.textContent = "";
                            // Keep the modal open so the user can copy the hash;
                            // the action cannot proceed until a restart.
                            return;
                        }

                        if (!(setupData.status === "ok" && setupData.action === "reload")) {
                            statusMessage.textContent = `Error: ${setupData.message || t("nm.couldNotSetPassword")}`;
                            return;
                        }
                    }

                    // HolafFetch lève sur non-2xx (401 identifiée dans le catch).
                    const data = await HolafFetch.post('/holaf/auth/login', { body: { password } });

                    if (data.success === true) {
                        closeModal(true);
                        return;
                    }

                    // 2xx mais pas authentifié : même message que l'ancien else.
                    statusMessage.textContent = t("nm.passNotConfiguredOrWrong");
                } catch (e) {
                    console.error("[Holaf NodesManager] Login request failed:", e);
                    if (e instanceof HolafFetchError && e.status === 0) {
                        // Erreur réseau / timeout : le serveur n'a pas pu être joint.
                        statusMessage.textContent = t("nm.cantReachServer");
                    } else if (e instanceof HolafFetchError && e.status === 401) {
                        statusMessage.textContent = t("nm.passNotConfiguredOrWrong");
                    } else if (e instanceof HolafFetchError) {
                        const serverMessage = (e.data && (e.data.message || e.data.error)) || "";
                        statusMessage.textContent = serverMessage
                            ? `Error: ${serverMessage}`
                            : t("nm.passNotConfiguredOrWrong");
                    } else {
                        statusMessage.textContent = t("nm.cantReachServer");
                    }
                } finally {
                    passwordInput.value = "";
                    if (confirmInput) confirmInput.value = "";
                    actionButton.disabled = false;
                    cancelButton.disabled = false;
                    passwordInput.disabled = false;
                    if (confirmInput) confirmInput.disabled = false;
                    passwordInput.focus();
                }
            };

            actionButton.onclick = submitLogin;
            cancelButton.onclick = () => closeModal(false);
            passwordInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    submitLogin();
                }
            });
            if (confirmInput) {
                confirmInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        submitLogin();
                    }
                });
            }
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) closeModal(false);
            });

            passwordInput.focus();
        });
    },

    async _ensureAuthenticated(message = t("nm.authRequiredMsg")) {
        const status = await this._checkAuthStatus();
        if (status.authenticated) return true;
        return this._showLoginModal(message, !status.passwordConfigured);
    },

    async _executeNodeAction(actionPath, nodePayloads, actionName, confirmMessage, requiresAuth = false) {
        if (this.isActionInProgress) {
            AIH.ask({ title: t("nm.actionInProgress"), message: t("nm.actionInProgressMsg") });
            return;
        }
        if (!nodePayloads || nodePayloads.length === 0) {
            AIH.ask({ title: actionName, message: t("nm.noNodesSelected") });
            return;
        }

        if (requiresAuth) {
            const authenticated = await this._ensureAuthenticated();
            if (!authenticated) return;
        }

        const nodeNamesForDisplay = nodePayloads.map(p => p.name).join(', ');

        const confirm = await AIH.ask({
            title: t("nm.confirmAction", { action: actionName }),
            message: t("nm.nodesList", { confirmMessage, nodes: nodeNamesForDisplay }),
            buttons: [{ text: t("nm.cancel"), value: false, type: "cancel" }, { text: actionName, value: true, type: actionName === "Delete" ? "danger" : "confirm" }]
        });

        if (!confirm) return;

        this.isActionInProgress = true;
        this.updateActionButtonsState();

        let inProgressOverlayElement = null;

        const showInProgressDialog = () => {
            if (inProgressOverlayElement) return;

            inProgressOverlayElement = document.createElement("div");
            inProgressOverlayElement.style.cssText = `
                position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(0, 0, 0, 0.6); z-index: 200000; 
                display: flex; align-items: center; justify-content: center;
            `;

            const dialog = document.createElement("div");
            dialog.className = "holaf-utility-panel";
            dialog.classList.add(this.panelElements.panelEl.className.match(/holaf-theme-\S+/)?.[0] || HOLAF_THEMES[0].className);

            dialog.style.position = "relative";
            dialog.style.transform = "none";
            dialog.style.width = "auto";
            dialog.style.minWidth = "300px";
            dialog.style.maxWidth = "500px";
            dialog.style.height = "auto";
            dialog.style.top = "auto";
            dialog.style.left = "auto";
            dialog.style.boxShadow = "0 5px 20px rgba(0,0,0,0.7)";

            const header = document.createElement("div");
            header.className = "holaf-utility-header";
            header.innerHTML = `<span>${t("nm.actionInProgressTitle", { action: actionName })}</span>`;

            const contentDiv = document.createElement("div");
            contentDiv.innerHTML = `<p style="padding: 15px 20px; color: var(--holaf-text-primary); white-space: pre-wrap;">${t("nm.processingNodes", { count: nodePayloads.length })}</p>`;

            dialog.append(header, contentDiv);
            inProgressOverlayElement.appendChild(dialog);
            document.body.appendChild(inProgressOverlayElement);
        };

        const removeInProgressDialog = () => {
            if (inProgressOverlayElement && inProgressOverlayElement.parentNode) {
                inProgressOverlayElement.parentNode.removeChild(inProgressOverlayElement);
                inProgressOverlayElement = null;
            }
        };

        showInProgressDialog();

        // Install/update/delete batch : git + pip côté serveur → potentiellement
        // très long → timeout désactivé (l'ancien fetch natif n'en avait pas).
        const postAction = () => HolafFetch.post(actionPath, { body: { node_payloads: nodePayloads }, timeout: 0 });

        // Convertit une HolafFetchError non-2xx en « résultat » exploitable :
        // 400 (tout a échoué) renvoie les détails par nœud en JSON ; le fetch
        // natif ne levait pas sur ces réponses → le corps JSON reste LE résultat
        // affiché à l'utilisateur. NB : le 207 (succès partiels) est un 2xx →
        // la brique le renvoie directement parsé, sans throw. Hors JSON
        // exploitable (réseau/timeout) → re-throw vers le catch générique.
        const asResultOrThrow = (err) => {
            if (err instanceof HolafFetchError && err.data) return err.data;
            throw err;
        };

        try {
            let result;
            try {
                result = await postAction();
            } catch (err) {
                if (err instanceof HolafFetchError && err.status === 401) {
                    // Session expirée : ouverture du modal de login, puis UN retry.
                    removeInProgressDialog();
                    const reconnected = await this._showLoginModal(t("nm.sessionExpired"));
                    if (!reconnected) {
                        AIH.ask({ title: t("nm.actionCancelled", { action: actionName }), message: t("nm.authRequiredForAction") });
                        return;
                    }
                    showInProgressDialog();
                    try {
                        result = await postAction();
                    } catch (retryErr) {
                        if (retryErr instanceof HolafFetchError && retryErr.status === 401) {
                            removeInProgressDialog();
                            AIH.ask({ title: t("nm.actionError", { action: actionName }), message: t("nm.authFailedNotExecuted") });
                            return;
                        }
                        result = asResultOrThrow(retryErr);
                    }
                } else {
                    result = asResultOrThrow(err);
                }
            }

            removeInProgressDialog();

            let summaryMessage = t("nm.actionResults", { action: actionName });
            let refreshNeeded = false;

            if (result.details && Array.isArray(result.details)) {
                result.details.forEach(item => {
                    summaryMessage += t("nm.nodeStatus", { name: item.node_name, status: item.status, message: item.message || 'N/A' });
                    if (item.output) summaryMessage += t("nm.output", { output: item.output.substring(0, 300) }) + (item.output.length > 300 ? '...' : '') + '\n';
                    summaryMessage += t("nm.separator") + '\n';

                    if (item.status === 'success') {
                        if (actionName === "Delete" || actionName === "Update") {
                            refreshNeeded = true;
                        }
                        if (actionName === "Update" && item.new_status) {
                            const updatedNodeInList = this.nodesList.find(n => n.name === item.node_name);
                            if (updatedNodeInList) {
                                updatedNodeInList.is_git_repo = item.new_status.is_git_repo;
                                updatedNodeInList.repo_url = item.new_status.repo_url;
                            }
                        }
                    }
                });
            } else {
                summaryMessage += t("nm.serverResponse", { status: result.status || t("nm.unknown"), message: result.message || t("nm.noDetails") });
            }

            AIH.ask({ title: t("nm.actionComplete", { action: actionName }), message: summaryMessage });

            if (refreshNeeded) {
                await this.refreshNodesList();
            } else {
                let iconsChanged = false;
                if (result.details && Array.isArray(result.details)) {
                    result.details.forEach(item => {
                        if (item.status === 'success' && item.new_status) {
                            const nodeInFilteredList = this.getFilteredNodes().find(n => n.name === item.node_name);
                            if (nodeInFilteredList) iconsChanged = true;
                        }
                    });
                }
                if (iconsChanged) this.renderNodesList();

                this.updateActionButtonsState();
                this.updateSelectAllCheckboxState();
            }

        } catch (error) {
            removeInProgressDialog();
            console.error(`[Holaf NodesManager] Error during ${actionName}:`, error);
            AIH.ask({ title: t("nm.actionError", { action: actionName }), message: t("nm.errorOccurred", { message: error.message }) });
        } finally {
            removeInProgressDialog();
            this.isActionInProgress = false;
        }
    },

    async handleUpdateSelected() {
        const nodesToUpdatePayloads = Array.from(this.selectedNodes)
            .map(name => {
                const node = this.nodesList.find(n => n.name === name);
                if (node && (node.is_git_repo || node.repo_url)) {
                    return {
                        name: node.name,
                        repo_url_override: (!node.is_git_repo && node.repo_url) ? node.repo_url : null
                    };
                }
                return null;
            })
            .filter(payload => payload !== null);

        if (nodesToUpdatePayloads.length === 0) {
            AIH.ask({ title: t("nm.updateNodes"), message: t("nm.noUpdateNodes") });
            return;
        }

        const gitRepoNodes = nodesToUpdatePayloads.filter(p => {
            const node = this.nodesList.find(n => n.name === p.name);
            return node && node.is_git_repo;
        }).map(p => p.name);

        const manualNodesWithUrl = nodesToUpdatePayloads.filter(p => p.repo_url_override !== null).map(p => p.name);

        let message = t("nm.updateIntro");
        if (gitRepoNodes.length > 0) {
            message += t("nm.updateLocalGit", { names: gitRepoNodes.join(', ') });
        }
        if (manualNodesWithUrl.length > 0) {
            message += t("nm.updateManual", { names: manualNodesWithUrl.join(', ') });
        }
        message += t("nm.updateConfirm");

        await this._executeNodeAction(
            '/holaf/nodes/update',
            nodesToUpdatePayloads,
            "Update",
            message,
            true
        );
    },

    async handleDeleteSelected() {
        const nodesToDeletePayloads = Array.from(this.selectedNodes).map(name => ({ name: name, repo_url_override: null }));
        await this._executeNodeAction(
            '/holaf/nodes/delete',
            nodesToDeletePayloads,
            "Delete",
            t("nm.deleteWarning")
        );
    },

    async handleInstallRequirementsSelected() {
        const nodesForReqPayloads = Array.from(this.selectedNodes)
            .filter(name => {
                const node = this.nodesList.find(n => n.name === name);
                return node && node.has_requirements_txt;
            })
            .map(name => ({ name: name, repo_url_override: null }));

        await this._executeNodeAction(
            '/holaf/nodes/install-requirements',
            nodesForReqPayloads,
            t("nm.installRequirements"),
            t("nm.installRequirementsMsg"),
            true
        );
    },

    async handleInstallViaUrl() {
        if (this.isActionInProgress) return;

        // Simple prompt for now, could be improved with a custom dialog later
        let url = await window.AIH.prompt(t("nm.enterGitUrl"));
        if (!url) return;
        url = url.trim();
        if (!url.startsWith("http")) {
            await window.AIH.alert(t("nm.installViaUrl"), t("nm.invalidUrl"), "warning");
            return;
        }

        await this._performInstall(url);
    },

    async handleSearchGithub() {
        if (this.isActionInProgress) return;

        const dialog = document.createElement("div");
        dialog.className = "holaf-utility-panel";
        dialog.classList.add(this.panelElements.panelEl.className.match(/holaf-theme-\S+/)?.[0] || HOLAF_THEMES[0].className);
        dialog.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            width: 600px; max-width: 90vw; height: 500px;
            z-index: 10000; box-shadow: 0 5px 30px rgba(0,0,0,0.8);
            display: flex; flex-direction: column;
        `;

        const header = document.createElement("div");
        header.className = "holaf-utility-header";
        header.innerHTML = `
            <span>${t("nm.searchGithubTitle")}</span>
            <div class="holaf-window-controls">
                 <button class="holaf-window-control-btn close" title="${t("nm.close")}">×</button>
            </div>
        `;
        header.querySelector(".close").onclick = () => document.body.removeChild(overlay);

        const content = document.createElement("div");
        content.className = "holaf-utility-content";
        content.style.padding = "10px";
        content.style.display = "flex";
        content.style.flexDirection = "column";
        content.style.height = "100%";

        const searchBar = document.createElement("div");
        searchBar.style.display = "flex";
        searchBar.style.marginBottom = "10px";
        searchBar.innerHTML = `
            <input type="text" placeholder="${t("nm.searchPlaceholder")}" style="flex: 1; margin-right: 5px;" class="holaf-nodes-manager-filter-input">
            <button class="comfy-button">${t("nm.search")}</button>
        `;

        const resultsContainer = document.createElement("div");
        resultsContainer.style.flex = "1";
        resultsContainer.style.overflowY = "auto";
        resultsContainer.style.border = "1px solid var(--holaf-border-color)";
        resultsContainer.style.padding = "5px";

        content.append(searchBar, resultsContainer);
        dialog.append(header, content);

        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9999;";
        overlay.append(dialog);
        document.body.append(overlay);

        const input = searchBar.querySelector("input");
        const btn = searchBar.querySelector("button");

        const performSearch = async () => {
            const query = input.value.trim();
            if (!query) return;
            resultsContainer.innerHTML = `<p>${t("nm.searching")}</p>`;
            try {
                // HolafFetch lève sur non-2xx (→ catch : message serveur affiché).
                const data = await HolafFetch.post("/holaf/nodes/search", { body: { query } });

                resultsContainer.innerHTML = "";
                if (data.results && data.results.length > 0) {
                    data.results.forEach(r => {
                        const row = document.createElement("div");
                        row.style.cssText = "border-bottom: 1px solid var(--holaf-border-color); padding: 5px; display: flex; align-items: center; justify-content: space-between;";

                        const infoDiv = document.createElement('div');

                        const nameDiv = document.createElement('div');
                        nameDiv.style.fontWeight = 'bold';
                        nameDiv.textContent = r.name;

                        const descriptionDiv = document.createElement('div');
                        descriptionDiv.style.fontSize = '0.8em';
                        descriptionDiv.style.opacity = '0.7';
                        descriptionDiv.textContent = r.description || t("nm.noDescription");

                        const linkWrap = document.createElement('div');
                        linkWrap.style.fontSize = '0.7em';
                        linkWrap.style.opacity = '0.5';
                        const link = document.createElement('a');
                        link.href = sanitizeUrl(r.url);
                        link.target = '_blank';
                        link.rel = 'noopener noreferrer';
                        link.textContent = t("nm.viewOnGithub");
                        linkWrap.appendChild(link);

                        infoDiv.append(nameDiv, descriptionDiv, linkWrap);

                        const installButton = document.createElement('button');
                        installButton.className = 'comfy-button';
                        installButton.style.marginLeft = '10px';
                        installButton.textContent = t("nm.install");
                        installButton.onclick = () => {
                             document.body.removeChild(overlay);
                             this._performInstall(r.url);
                        };

                        row.append(infoDiv, installButton);
                        resultsContainer.appendChild(row);
                    });
                } else {
                    resultsContainer.innerHTML = `<p>${t("nm.noResults")}</p>`;
                }

            } catch (e) {
                resultsContainer.innerHTML = `<p style="color:red">${t("nm.errorPrefix", { message: escapeHtml(e.message) })}</p>`;
            }
        };

        btn.onclick = performSearch;
        input.onkeydown = (e) => { if (e.key === "Enter") performSearch(); };
        input.focus();
    },

    async _performInstall(url) {
        if (this.isActionInProgress) return;

        const authenticated = await this._ensureAuthenticated();
        if (!authenticated) return;

        this.isActionInProgress = true;
        this.updateActionButtonsState();

        let overlay = null;

        const showInstallOverlay = () => {
            if (overlay) return;

            overlay = document.createElement("div");
            overlay.style.cssText = `
                position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(0, 0, 0, 0.6); z-index: 200000; 
                display: flex; align-items: center; justify-content: center;
            `;
            const dialog = document.createElement("div");
            dialog.className = "holaf-utility-panel";
            dialog.classList.add((this.panelElements && this.panelElements.panelEl
                ? this.panelElements.panelEl.className.match(/holaf-theme-\S+/)?.[0]
                : null) || HOLAF_THEMES[0].className);
            dialog.style.cssText = "position:relative;width:auto;min-width:300px;padding:20px;background:var(--holaf-bg-secondary);border:1px solid var(--holaf-border-color);";
            dialog.innerHTML = `<h3>${t("nm.installing")}</h3><p>${t("nm.cloning", { url: escapeHtml(url) })}</p>`;
            overlay.append(dialog);
            document.body.append(overlay);
        };

        const removeInstallOverlay = () => {
            if (overlay && document.body.contains(overlay)) {
                document.body.removeChild(overlay);
                overlay = null;
            }
        };

        showInstallOverlay();

        // Install = git clone + pip côté serveur → potentiellement très long →
        // timeout désactivé (l'ancien fetch natif n'en avait pas).
        const postInstall = () => HolafFetch.post('/holaf/nodes/install', { body: { url: url }, timeout: 0 });

        try {
            let result;
            try {
                result = await postInstall();
            } catch (err) {
                if (!(err instanceof HolafFetchError && err.status === 401)) throw err;
                // Session expirée : ouverture du modal de login, puis UN retry.
                removeInstallOverlay();
                const reconnected = await this._showLoginModal(t("nm.sessionExpired"));
                if (!reconnected) {
                    AIH.ask({ title: t("nm.installCancelled"), message: t("nm.authRequiredInstall") });
                    return;
                }
                showInstallOverlay();
                try {
                    result = await postInstall();
                } catch (retryErr) {
                    if (retryErr instanceof HolafFetchError && retryErr.status === 401) {
                        removeInstallOverlay();
                        AIH.ask({ title: t("nm.installFailed"), message: t("nm.authFailedNotInstalled") });
                        return;
                    }
                    throw retryErr;
                }
            }

            removeInstallOverlay();

            // 2xx uniquement ici (HolafFetch a levé sur les non-2xx → catch).
            if (result.status === 'success') {
                AIH.ask({ title: t("nm.installComplete"), message: t("nm.installCompleteMsg", { url }) });
                this.refreshNodesList();
            } else {
                throw new Error(result.message || t("nm.unknownError"));
            }
        } catch (e) {
            removeInstallOverlay();
            // Non-2xx : privilégie le champ `message` du corps JSON serveur
            // (même message utilisateur que l'ancien `result.message`).
            const msg = (e instanceof HolafFetchError && e.data && e.data.message) ? e.data.message : e.message;
            AIH.ask({ title: t("nm.installFailed"), message: t("nm.installErrorMsg", { message: msg }) });
        } finally {
            removeInstallOverlay();
            this.isActionInProgress = false;
            this.updateActionButtonsState();
        }
    },


    applyCurrentTheme() {
        if (this.panelElements && this.panelElements.panelEl) {
            this.setTheme(this.settings.theme, false);
        }
    },

    applyCurrentZoom() {
        if (this.panelElements && this.panelElements.panelEl) {
            this.setZoom(this.settings.zoom_level, false);
        }
    },

    async show() {
        await this.ensureScriptsLoaded();

        if (!this.panelElements) {
            this.createPanel();
        } else {
            const filterInputEl = document.getElementById("holaf-nodes-manager-filter-input");
            if (filterInputEl) filterInputEl.value = this.filterText;
        }


        if (this.panelElements && this.panelElements.panelEl) {
            const isVisible = this.panelElements.panelEl.style.display === "flex";
            if (isVisible) {
                this.panelElements.panelEl.style.display = "none";
                return;
            }

            this.applyCurrentTheme();
            this.applyCurrentZoom();
            this.panelElements.panelEl.style.display = "flex";
            HolafPanelManager.bringToFront(this.panelElements.panelEl);

            // Ensure filter input reflects the loaded this.filterText state before rendering list
            const filterInputEl = document.getElementById("holaf-nodes-manager-filter-input");
            if (filterInputEl && filterInputEl.value !== this.filterText) {
                filterInputEl.value = this.filterText;
            }

            if (!this.isInitialized || this.nodesList.length === 0) {
                this.refreshNodesList();
                this.isInitialized = true;
            } else {
                this.renderNodesList();
                this.updateActionButtonsState();
            }
        }
    },

    hide() {
        if (this.panelElements && this.panelElements.panelEl) {
            this.panelElements.panelEl.style.display = "none";
        }
    }
};

app.holafNodesManager = holafNodesManager;

app.registerExtension({
    name: "Holaf.NodesManager.Panel",
    async setup() {
        await holafNodesManager.init(); // Ensure settings are loaded before any show() call
    },
});

export default holafNodesManager;