/*
 * Copyright (C) 2026 Holaf
 * Holaf Utilities - Global Settings Manager
 *
 * This script creates and manages the main settings panel for Holaf utilities.
 *
 * Since the AIH UI fusion, the panel is tabbed:
 *   - "General"             : native Holaf settings (theme, per-app WIP toggles).
 *   - "AIH · Compte"        : AIH account (server URL + API key), rendered by
 *                             window.AIHMenu.renderAccountTab() (js/aih_menu.js).
 *   - "AIH · Provider LLM"  : AIH LLM presets CRUD, rendered by
 *                             window.AIHMenu.renderProviderTab().
 * The AIH tabs delegate 100% of their logic to js/aih_menu.js — no duplication.
 */

import { app } from "./holaf_api_compat.js";
import { HolafPanelManager } from "./holaf_panel_manager.js";
import "./aih_strings.js";
import {
    AIH_ACCENTS,
    applyThemeState,
    loadThemeState,
    saveThemeState,
} from "./holaf_themes.js";
import { HolafWipManager, WIP_FEATURES } from "./holaf_wip_settings.js";
import { saveWindowRect, loadWindowRect } from "./holaf_window_utils.js";

const SETTINGS_RECT_KEY = "aih:settings-panel";

// Helper i18n central : traduit via AIH.I18n (clé brute si absente).
const t = (key, params) => {
    const I = window.AIH && window.AIH.I18n;
    return I && typeof I.t === "function" ? I.t(key, params) : key;
};

// Traduit le label/description d'une feature WIP (holaf_wip_settings.js).
const wipLabel = (id, what) => t(`wip.${id}${what ? `.${what}` : ""}`);

const HolafSettingsManager = {
    name: "Holaf.SettingsManager",
    panelEl: null,
    contentEl: null,
    activeTab: "general",

    TABS: [
        { id: "general", label: "settings.general" },
        { id: "aih-account", label: "settings.aihAccount" },
        { id: "aih-providers", label: "settings.aihProviders" },
    ],

    init() {
        // The panel is created on-demand.
    },

    /**
     * Show the settings window.
     * @param {object} [options] - { tab?: string } activates the given tab id.
     */
    show(options = {}) {
        if (options.tab && this.TABS.some(t => t.id === options.tab)) {
            this.activeTab = options.tab;
        }
        if (!this.TABS.some(t => t.id === this.activeTab)) {
            this.activeTab = "general";
        }

        if (this.panelEl && document.body.contains(this.panelEl)) {
            this.panelEl.style.display = 'flex';
            HolafPanelManager.bringToFront(this.panelEl);
            this.renderActiveTab();
            return;
        }

        this.createPanel();
        this.populatePanel();
    },

    createPanel() {
        const { panelEl, contentEl } = HolafPanelManager.createPanel({
            id: "holaf-settings-panel",
            title: t("settings.panelTitle"),
            defaultSize: { width: 560, height: 480 }, // Roomy enough for the AIH tabs
            // Persistance position/taille via le store unifié (clamp viewport).
            onStateChange: (rect) => {
                saveWindowRect(SETTINGS_RECT_KEY, {
                    left: rect.x,
                    top: rect.y,
                    width: rect.width,
                    height: rect.height,
                });
            },
            onClose: () => {
                this.panelEl = null;
                this.contentEl = null;
            }
        });

        this.panelEl = panelEl;
        this.contentEl = contentEl;

        // Restaure la position/taille persistée (avec clamp au viewport).
        const saved = loadWindowRect(SETTINGS_RECT_KEY);
        if (saved) {
            panelEl.style.transform = "none";
            panelEl.style.left = saved.left + "px";
            panelEl.style.top = saved.top + "px";
            panelEl.style.width = saved.width + "px";
            panelEl.style.height = saved.height + "px";
        }

        // Ensure the panel itself has the correct theme class initially
        // (NEW 3-axes system) : le body porte mode/accent/halo et les panels
        // héritent des variables via CSS — pas besoin de classe par panel.
        applyThemeState(this.panelEl, loadThemeState());
    },

    populatePanel() {
        // Tab bar + shared content container. Tab contents are re-rendered on
        // every switch (renderActiveTab), so state never goes stale.
        this.contentEl.innerHTML = "";

        const tabsBar = document.createElement("div");
        tabsBar.className = "holaf-settings-tabs";

        this.TABS.forEach(tab => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.id = `holaf-settings-tab-${tab.id}`;
            btn.className = "holaf-settings-tab-btn";
            btn.textContent = t(tab.label);
            btn.addEventListener("click", () => {
                this.activeTab = tab.id;
                this.renderActiveTab();
            });
            tabsBar.appendChild(btn);
        });

        const tabContent = document.createElement("div");
        tabContent.className = "holaf-settings-tab-content";
        tabContent.id = "holaf-settings-tab-content";

        this.contentEl.style.display = "flex";
        this.contentEl.style.flexDirection = "column";
        this.contentEl.append(tabsBar, tabContent);

        this.renderActiveTab();
    },

    renderActiveTab() {
        if (!this.contentEl) return;
        const container = this.contentEl.querySelector("#holaf-settings-tab-content");
        if (!container) return;

        // Reflect active state on the tab buttons
        this.TABS.forEach(tab => {
            const btn = this.contentEl.querySelector(`#holaf-settings-tab-${tab.id}`);
            if (btn) btn.classList.toggle("active", tab.id === this.activeTab);
        });

        if (this.activeTab === "general") {
            this.renderGeneralTab(container);
        } else if (this.activeTab === "aih-account") {
            this.renderAihTab(container, "renderAccountTab", t("settings.accountTab"));
        } else if (this.activeTab === "aih-providers") {
            this.renderAihTab(container, "renderProviderTab", t("settings.providerTab"));
        }
    },

    /**
     * Delegate an AIH tab to window.AIHMenu (js/aih_menu.js), with a graceful
     * message when the AIH menu helpers are not loaded yet.
     */
    renderAihTab(container, fnName, label) {
        container.innerHTML = "";
        const renderFn = window.AIHMenu?.[fnName];
        if (typeof renderFn === "function") {
            try {
                renderFn(container);
                return;
            } catch (err) {
                const errorP = document.createElement("p");
                errorP.style.cssText = "color: var(--holaf-error-color, #F44336); font-size: 12px;";
                errorP.textContent = t("settings.aihError", { label, error: err?.message || err });
                container.appendChild(errorP);
                return;
            }
        }
        const infoP = document.createElement("p");
        infoP.style.cssText = "color: var(--holaf-text-secondary, #888); font-size: 12px; line-height: 1.5;";
        infoP.textContent = t("settings.aihNotLoaded", { label });
        container.appendChild(infoP);
    },

    // ── Native Holaf tab (theme + WIP modules) ──

    renderGeneralTab(container) {
        const state = loadThemeState();

        // Labels du sélecteur d'accent (couleur de marque).
        const accentButtonsHtml = Object.keys(AIH_ACCENTS).map(key => {
            const acc = AIH_ACCENTS[key];
            const isActive = state.accent === key;
            return `<button type="button" class="holaf-settings-accent-btn ${isActive ? "active" : ""}" data-accent="${key}" title="${acc.label}"><span class="holaf-settings-accent-swatch aih-accent-${key}"></span>${acc.label}</button>`;
        }).join('');

        // Build the per-feature WIP checkboxes.
        const wipRowsHtml = HolafWipManager.getFeatureList().map(feature => {
            const isChecked = HolafWipManager.isEnabled(feature.id) ? "checked" : "";
            const featureLabel = wipLabel(feature.id);
            const featureDesc = wipLabel(feature.id, "desc");
            const parentNote = feature.parent
                ? `<span class="holaf-settings-field-description" style="display:block;margin-left:26px;font-size:11px;opacity:.75;">${t("settings.wipRequires", { label: WIP_FEATURES[feature.parent]?.label ?? feature.parent })}</span>`
                : "";
            return `
                <div class="holaf-settings-field" style="display:flex;align-items:flex-start;gap:10px;margin-top:6px;">
                    <input type="checkbox" id="holaf-wip-${feature.id}" data-wip-feature="${feature.id}" ${isChecked} style="cursor:pointer;width:16px;height:16px;margin-top:1px;">
                    <div style="display:flex;flex-direction:column;gap:1px;">
                        <label for="holaf-wip-${feature.id}" style="font-size:12px;cursor:pointer;">${featureLabel}</label>
                        ${featureDesc !== `wip.${feature.id}.desc` ? `<span class="holaf-settings-field-description" style="font-size:11px;opacity:.8;">${featureDesc}</span>` : ""}
                        ${parentNote}
                    </div>
                </div>`;
        }).join('');

        // Langue actuelle (défaut FR) pour le sélecteur.
        const curLocale = (window.AIH && window.AIH.I18n && window.AIH.I18n.getLocale()) || "fr";

        container.innerHTML = `
            <div class="holaf-settings-container" style="padding: 15px; gap: 20px;">

                <!-- Appearance : MODE + ACCENT + HALO + HIGHLIGHT (4 axes orthogonaux) -->
                <div class="holaf-settings-group">
                    <h3 style="margin-top: 0; margin-bottom: 10px; font-size: 14px;">${t("settings.appearance")}</h3>

                    <!-- Axe 1 : MODE (clair / foncé, fenêtres grises) -->
                    <div class="holaf-settings-field" style="display:flex;flex-direction:column;gap:6px;">
                        <label style="font-size:12px;">${t("settings.mode")}</label>
                        <div style="display:flex;gap:8px;" id="holaf-mode-toggle">
                            <button type="button" class="holaf-settings-mode-btn ${state.mode === 'dark' ? 'active' : ''}" data-mode="dark">${t("settings.dark")}</button>
                            <button type="button" class="holaf-settings-mode-btn ${state.mode === 'light' ? 'active' : ''}" data-mode="light">${t("settings.light")}</button>
                        </div>
                        <span class="holaf-settings-field-description" style="font-size:11px;">${t("settings.modeDesc")}</span>
                    </div>

                    <!-- Axe 2 : ACCENT (couleur de marque, adaptée au mode) -->
                    <div class="holaf-settings-field" style="display:flex;flex-direction:column;gap:6px;">
                        <label style="font-size:12px;">${t("settings.accent")}</label>
                        <div style="display:flex;flex-wrap:wrap;gap:6px;" id="holaf-accent-picker">
                            ${accentButtonsHtml}
                        </div>
                        <span class="holaf-settings-field-description" style="font-size:11px;">${t("settings.accentDesc")}</span>
                    </div>

                    <!-- Axe 3 : HALO (lueur des fenêtres actives) -->
                    <div class="holaf-settings-field" style="display:flex;align-items:center;gap:8px;">
                        <input type="checkbox" id="holaf-halo-toggle" ${state.halo ? "checked" : ""} style="cursor:pointer;width:15px;height:15px;accent-color:var(--holaf-accent-color);">
                        <label for="holaf-halo-toggle" style="font-size:12px;cursor:pointer;">${t("settings.halo")}</label>
                    </div>
                    <div style="display:flex; align-items:center; gap:8px; margin:4px 0 10px 23px;">
                        <input type="range" id="holaf-halo-intensity" min="0" max="100" step="5" value="${state.haloIntensity ?? 50}" style="flex:1; cursor:pointer; accent-color:var(--holaf-accent-color);">
                        <span id="holaf-halo-intensity-val" style="font-size:11px; color:var(--holaf-text-secondary); min-width:34px; text-align:right;">${state.haloIntensity ?? 50}%</span>
                    </div>

                    <!-- Axe 4 : HIGHLIGHT (contour coloré des fenêtres actives, indépendant du halo) -->
                    <div class="holaf-settings-field" style="display:flex;align-items:center;gap:8px;">
                        <input type="checkbox" id="holaf-highlight-toggle" ${state.highlight ? "checked" : ""} style="cursor:pointer;width:15px;height:15px;accent-color:var(--holaf-accent-color);">
                        <label for="holaf-highlight-toggle" style="font-size:12px;cursor:pointer;">${t("settings.highlight")}</label>
                    </div>
                    <div style="display:flex; align-items:center; gap:8px; margin:4px 0 10px 23px;">
                        <input type="range" id="holaf-highlight-intensity" min="0" max="100" step="5" value="${state.highlightIntensity ?? 100}" style="flex:1; cursor:pointer; accent-color:var(--holaf-accent-color);">
                        <span id="holaf-highlight-intensity-val" style="font-size:11px; color:var(--holaf-text-secondary); min-width:34px; text-align:right;">${state.highlightIntensity ?? 100}%</span>
                    </div>

                    <!-- LANGUE : sélecteur FR / EN, appliqué immédiatement -->
                    <div class="holaf-settings-field" style="display:flex;flex-direction:column;gap:6px;">
                        <label style="font-size:12px;">${t("settings.language")}</label>
                        <div style="display:flex;gap:8px;" id="holaf-locale-toggle">
                            <button type="button" class="holaf-settings-mode-btn ${curLocale === 'fr' ? 'active' : ''}" data-locale="fr">FR</button>
                            <button type="button" class="holaf-settings-mode-btn ${curLocale === 'en' ? 'active' : ''}" data-locale="en">EN</button>
                        </div>
                        <span class="holaf-settings-field-description" style="font-size:11px;">${t("settings.languageDesc")}</span>
                    </div>
                </div>

                <!-- Applications WIP -->
                <div class="holaf-settings-group">
                    <div style="display:flex;align-items:center;justify-content:space-between;">
                        <h3 style="margin: 0 0 10px 0; font-size: 14px;">${t("settings.wip")}</h3>
                        <button type="button" id="holaf-wip-reset" style="font-size:11px;padding:2px 8px;cursor:pointer;background:transparent;border:1px solid var(--holaf-accent-color,#ff8c00);color:var(--holaf-accent-color,#ff8c00);border-radius:4px;">${t("settings.wipReset")}</button>
                    </div>
                    <div class="holaf-settings-field" style="font-size:12px;">
                        ${t("settings.wipDesc")}
                    </div>
                    ${wipRowsHtml}
                </div>

            </div>
        `;

        // --- Event Listeners ---

        // Helper : applique l'état sur body + ré-applique aux panels ouverts.
        const applyTheme = (nextState) => {
            applyThemeState(document.body, nextState);
            saveThemeState(nextState);
            // Ré-applique le thème à chaque panel déjà ouvert (héritage direct).
            document.querySelectorAll(".holaf-utility-panel, .aih-dialog-root").forEach((p) => {
                applyThemeState(p, nextState);
            });
            if (this.panelEl) applyThemeState(this.panelEl, nextState);
        };

        // 1. MODE : bascule light/dark.
        container.querySelectorAll("#holaf-mode-toggle .holaf-settings-mode-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const mode = btn.dataset.mode;
                const st = loadThemeState();
                st.mode = mode;
                applyTheme(st);
                this.renderActiveTab(); // rafraîchit l'état actif des boutons
            });
        });

        // 2. ACCENT : choix de la couleur de marque.
        container.querySelectorAll("#holaf-accent-picker .holaf-settings-accent-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const accent = btn.dataset.accent;
                const st = loadThemeState();
                st.accent = accent;
                applyTheme(st);
                this.renderActiveTab();
            });
        });

        // 3. HALO : case activable.
        const haloSlider = container.querySelector("#holaf-halo-intensity");
        haloSlider.addEventListener("input", (e) => {
            const val = parseInt(e.target.value, 10) || 0;
            const st = loadThemeState(); // repart de l'état persisté (évite d'écraser les autres axes)
            st.haloIntensity = val;
            const lbl = container.querySelector("#holaf-halo-intensity-val");
            if (lbl) lbl.textContent = val + "%";
            applyThemeState(document.body, st);
            saveThemeState(st);
        });
        const highlightSlider = container.querySelector("#holaf-highlight-intensity");
        highlightSlider.addEventListener("input", (e) => {
            const val = parseInt(e.target.value, 10) || 0;
            const st = loadThemeState(); // repart de l'état persisté (axes halo/mode/accent conservés)
            st.highlightIntensity = val;
            const lbl = container.querySelector("#holaf-highlight-intensity-val");
            if (lbl) lbl.textContent = val + "%";
            applyThemeState(document.body, st);
            saveThemeState(st);
        });
        const haloToggle = container.querySelector("#holaf-halo-toggle");
        haloToggle.addEventListener("change", (e) => {
            const st = loadThemeState();
            st.halo = e.target.checked;
            st.haloIntensity = state.haloIntensity ?? 50;
            applyTheme(st);
        });

        // 3bis. HIGHLIGHT : case activable (contour coloré, indépendante du halo).
        const highlightToggle = container.querySelector("#holaf-highlight-toggle");
        highlightToggle.addEventListener("change", (e) => {
            const st = loadThemeState();
            st.highlight = e.target.checked;
            st.highlightIntensity = state.highlightIntensity ?? 100;
            applyTheme(st);
        });

        // LANGUE : sélecteur FR / EN, appliqué immédiatement (re-rendu Settings + menu).
        container.querySelectorAll("#holaf-locale-toggle .holaf-settings-mode-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                this.applyLocale(btn.dataset.locale);
            });
        });

        // 4. Per-feature WIP checkboxes: persist each choice independently.
        const applyWipChange = (checkbox) => {
            const featureId = checkbox.dataset.wipFeature;
            if (!featureId) return;
            HolafWipManager.setEnabled(featureId, checkbox.checked);

            // Dynamically rebuild the main menu to show/hide items.
            if (window.holaf && typeof window.holaf.rebuildMenu === "function") {
                window.holaf.rebuildMenu();
            }
        };
        container.querySelectorAll("input[data-wip-feature]").forEach(cb => {
            cb.addEventListener("change", (e) => applyWipChange(e.target));
        });

        // 5. Reset: re-enable every WIP feature and refresh the panel + menu.
        const resetBtn = container.querySelector("#holaf-wip-reset");
        resetBtn.addEventListener("click", () => {
            HolafWipManager.resetAll();
            this.renderActiveTab();
            if (window.holaf && typeof window.holaf.rebuildMenu === "function") {
                window.holaf.rebuildMenu();
            }
        });
    },

    /**
     * Applique une langue (setLocale + persistance) et re-rend immédiatement
     * les textes visibles : titre & onglets Settings, onglet actif et menu.
     * @param {string} locale - "fr" ou "en".
     */
    applyLocale(locale) {
        const I = window.AIH && window.AIH.I18n;
        if (I && typeof I.setLocale === "function") I.setLocale(locale);

        if (this.panelEl) {
            const titleSpan = this.panelEl.querySelector(".holaf-utility-header span");
            if (titleSpan) titleSpan.textContent = t("settings.panelTitle");
        }
        if (this.contentEl) this.populatePanel();
        if (window.holaf && typeof window.holaf.rebuildMenu === "function") {
            window.holaf.rebuildMenu();
        }
    }
};

app.registerExtension({
    name: HolafSettingsManager.name,
    init() {
        HolafSettingsManager.init();
    },
    setup() {
        app.holafSettingsManager = HolafSettingsManager;
    }
});
