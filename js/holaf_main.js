/*
 * Copyright (C) 2026 Holaf
 * Holaf Utilities - Main Menu Initializer
 */

import { app } from "./holaf_api_compat.js";
import { holafExtUrl } from "./holaf_ext_base.js";
import { showToast, updateToast, hideToast } from "./aih_toast_bridge.js";
import { HolafFetch, HolafFetchError } from "./vendor/holaf/holaf-fetch.js";
import { HolafPanelManager } from "./holaf_panel_manager.js";
import { applyPersistedTheme } from "./holaf_themes.js";
import { holafComfyHealthCheck } from "./holaf_restart_health.js";

import "./holaf_themes.js";
import "./aih_dialog.js";
import "./aih_strings.js";
import "./holaf_terminal.js";
import "./holaf_model_manager.js";
import "./holaf_nodes_manager.js";
import "./holaf_image_viewer.js";
import "./holaf_settings_manager.js";
import "./holaf_wip_settings.js";
import "./holaf_layout_tools.js";
import "./holaf_shortcuts.js";
import "./holaf_remote_comparer.js";

// Helper i18n central : traduit via AIH.I18n (clé brute si absente).
const t = (key, params) => {
    const I = window.AIH && window.AIH.I18n;
    return I && typeof I.t === "function" ? I.t(key, params) : key;
};

const HolafUtilitiesMenu = {
    dropdownMenuEl: null,
    isCompactMode: false,
    styleEl: null,
    startupEnforcerInterval: null,
    _compactObserver: null,
    _compactWatchdog: null,

    init() {
        try {
            console.info("[AIH] Menu init starting…");
            this.loadSharedCss();
            this.initBridgeListener();
            this.injectCompactCSS();

            this.isCompactMode = localStorage.getItem("Holaf_CompactMenu") === "true";
            if (this.isCompactMode) {
                this.waitForUIAndApplyCompact();
                this.startCompactWatchdog();
            }

            if (!document.body.className.includes("holaf-theme-")) {
                document.body.classList.add("holaf-theme-graphite-orange");
            }

            // THEMING 4-axes (mode/accent/halo/highlight) : applique l'état persisté
            // sur <body>. Les panneaux et dialogues héritent des variables via CSS.
            try { applyPersistedTheme(document.body); } catch (e) { console.warn("[AIH] applyPersistedTheme failed:", e); }

            if (!window.holaf) {
                window.holaf = {};
            }
            // Pont toasts : la brique HolafToast (via aih_toast_bridge.js) est
            // désormais la source unique. On garde window.holaf.toastManager
            // comme shim de rétrocompatibilité qui délègue au pont.
            window.holaf.toastManager = { show: showToast, update: updateToast, hide: hideToast };

            window.holaf.rebuildMenu = () => this.buildMenu();
            // Expose le flux de redémarrage partagé (compteur à rebours) pour que
            // js/aih_menu.js (chargé AVANT holaf_main.js) puisse le réutiliser pour
            // le redémarrage post-update. Accessible via window.holaf.startRestartFlow.
            window.holaf.startRestartFlow = () => this.startRestartFlow();

            let menuContainer = document.getElementById("holaf-utilities-menu-container");
            if (menuContainer) {
                return;
            }

            menuContainer = document.createElement("div");
            menuContainer.id = "holaf-utilities-menu-container";
            menuContainer.style.position = "relative";
            menuContainer.style.display = "inline-block";
            menuContainer.style.margin = "0 4px";

            const mainButton = document.createElement("button");
            mainButton.id = "holaf-utilities-menu-button";
            mainButton.textContent = t("menu.title");

            this.dropdownMenuEl = document.createElement("ul");
        this.dropdownMenuEl.id = "holaf-utilities-dropdown-menu";
        this.dropdownMenuEl.style.display = 'none';
        this.dropdownMenuEl.style.zIndex = '10005';

        this.buildMenu(); 

        document.body.appendChild(this.dropdownMenuEl);

        mainButton.onclick = (e) => {
            e.stopPropagation();
            if (this.dropdownMenuEl.style.display === "block") {
                this.hideDropdown();
            } else {
                this.showDropdown(mainButton);
                this.dropdownMenuEl.querySelectorAll('li').forEach(li => {
                    const check = li.querySelector('div');
                    const text = li.textContent;
                    if (check) {
                        let isActive = false;
                        if (text.includes("Layout Tools")) isActive = window.holaf?.layoutTools?.isVisible;
                        else if (text.includes("Shortcuts")) isActive = app.holafShortcuts?.isVisible;
                        else if (text.includes("Remote Comparer")) isActive = app.holafRemoteComparer?.isOpen; 
                        else if (text.includes("Compact Menu")) isActive = this.isCompactMode;

                        check.innerHTML = isActive ? "✓" : "";
                        check.style.borderColor = isActive ? "var(--holaf-accent-color, #ff8c00)" : "var(--border-color, #888)";
                    }
                });

                // Entrées AIH dynamiques : pastille Blobby, visibilité Chat et
                // statut serveur du pied de menu rafraîchis à chaque ouverture.
                this.updateAihDynamicItems();
            }
        };

        document.addEventListener('click', (e) => {
            if (this.dropdownMenuEl && this.dropdownMenuEl.style.display === "block") {
                if (e.target !== mainButton && !this.dropdownMenuEl.contains(e.target)) {
                    this.hideDropdown();
                }
            }
        });

        menuContainer.appendChild(mainButton);

        const settingsButton = app.menu?.settingsGroup?.element;
        if (settingsButton) {
            settingsButton.before(menuContainer);
            // Nouveau frontend Vue : settingsGroup.element peut être un noeud
            // DETACHE du DOM au moment de l'injection (monte plus tard par le
            // composant TopMenuSection). Si on insère dans un noeud détaché,
            // le bouton existe mais n'est jamais visible. On vérifie donc la
            // connexion réelle au document et on retente jusqu'à attachement.
            if (!menuContainer.isConnected) {
                let attempts = 0;
                const maxAttempts = 60; // ~30 s à 500 ms
                const reattachTimer = setInterval(() => {
                    attempts++;
                    try {
                        settingsButton.before(menuContainer);
                    } catch (e) {
                        console.warn("[AIH] Menu re-injection failed:", e);
                    }
                    if (menuContainer.isConnected || attempts >= maxAttempts) {
                        clearInterval(reattachTimer);
                        if (menuContainer.isConnected) {
                            console.info("[AIH] Menu button attached to the ComfyUI toolbar.");
                        } else {
                            console.warn("[AIH] Could not attach menu button after " + attempts + " attempts.");
                        }
                    }
                }, 500);
            }
        } else {
            const comfyMenu = document.querySelector(".comfy-menu");
            if (comfyMenu) {
                comfyMenu.append(menuContainer);
            } else {
                document.body.prepend(menuContainer);
            }
        }
        } catch (err) {
            console.error("[AIH] Menu init FAILED — the menu button will not appear:", err);
            return;
        }
    },

    buildMenu() {
        if (!this.dropdownMenuEl) return;
        this.dropdownMenuEl.innerHTML = '';

        // A WIP item is shown if and only if its own feature is enabled. The
        // Chat feature is independent of Blobby's activation state.
        const isWipItemVisible = (item) => {
            if (!item.wipFeature) return true;
            const wipMgr = window.holaf?.wipManager;
            if (!wipMgr || typeof wipMgr.isEnabled !== 'function') return false;
            return wipMgr.isEnabled(item.wipFeature);
        };

        // ── Structure du menu, regroupée en sections logiques lisibles. ──
        // Chaque entrée WIP porte un identifiant de feature stable (wipFeature)
        // piloté individuellement dans Settings → Applications WIP.
        const menuItems = [
            // Groupe « Galerie & Visualisation »
            { type: 'subtitle', label: t('menu.sectionGallery') },
            { label: t("menu.imageViewer"), handlerName: "holafImageViewer" },

            // Groupe « AIH / Distant »
            { type: 'subtitle', label: t('menu.sectionAIH') },
            { label: t("menu.openWebpage"), special: 'aih_webpage' },
            { label: t("menu.workflows"), special: 'aih_workflows' },
            { label: t("menu.models"), special: 'aih_models' },
            { label: t("menu.members"), special: 'aih_members' },

            // Groupe « Outils & Dev » (items WIP pilotés individuellement)
            { type: 'subtitle', label: t('menu.sectionTools') },
            { label: t("menu.modelManager"), handlerName: "holafModelManager", wipFeature: 'model_manager' },
            { label: t("menu.nodesManager"), handlerName: "holafNodesManager", wipFeature: 'custom_nodes_manager' },
            { label: t("menu.workflowProfiler"), special: "profiler_standalone", wipFeature: 'workflow_profiler' },
            { special: 'aih_blobby_toggle', wipFeature: 'blobby' },
            { label: t("menu.chat"), special: 'aih_chat', wipFeature: 'chat' },

            // Groupe « Utilitaires »
            { type: 'subtitle', label: t('menu.sectionUtils') },
            { label: t("menu.terminal"), handlerName: "holafTerminal" },
            { label: t("menu.compactMenu"), special: "toggle_compact_menu" },
            { label: t("menu.layoutTools"), special: "toggle_layout_tools" },
            { label: t("menu.shortcuts"), special: "toggle_shortcuts" },
            { label: t("menu.remoteComparer"), special: "toggle_remote_comparer" },

            // Groupe « Système »
            { type: 'subtitle', label: t('menu.sectionSystem') },
            { label: t("menu.settings"), handlerName: "holafSettingsManager" },
            { label: t("menu.aihUpdate"), special: 'aih_update' },
            { label: t("menu.restart"), special: 'restart' }
        ];

        // Regroupe les entrées consécutives en sections : chaque sous-titre
        // ouvre une nouvelle section. Une section dont AUCUN item n'est
        // visible après le filtrage WIP/conditions est entièrement omise
        // (sous-titre ET items) pour éviter un intitulé orphelin.
        const sections = [];
        let currentSection = null;
        menuItems.forEach(itemInfo => {
            if (itemInfo.type === 'subtitle') {
                currentSection = { subtitle: itemInfo, items: [] };
                sections.push(currentSection);
            } else {
                if (!currentSection) {
                    currentSection = { subtitle: null, items: [] };
                    sections.push(currentSection);
                }
                currentSection.items.push(itemInfo);
            }
        });

        sections.forEach(section => {
            const visibleItems = section.items.filter(isWipItemVisible);

            // Section avec sous-titre mais AUCUN item visible → rien à rendre.
            if (section.subtitle && visibleItems.length === 0) {
                return;
            }

            if (section.subtitle) {
                const subtitle = document.createElement("li");
                subtitle.className = "holaf-menu-subtitle";
                subtitle.textContent = section.subtitle.label;
                Object.assign(subtitle.style, {
                    margin: "10px 0 2px 0",
                    padding: "2px 6px",
                    fontSize: "10px",
                    fontWeight: "700",
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "var(--holaf-accent-color, #ff8c00)",
                    borderBottom: "1px solid var(--holaf-border-color, #3F3F3F)",
                    cursor: "default",
                    pointerEvents: "none"
                });
                this.dropdownMenuEl.appendChild(subtitle);
            }

            visibleItems.forEach(itemInfo => {
            if (itemInfo.type === 'separator') {
                const separator = document.createElement("li");
                separator.style.height = "1px";
                separator.style.backgroundColor = "var(--holaf-border-color, #3F3F3F)";
                separator.style.margin = "5px 0";
                separator.style.padding = "0";
                this.dropdownMenuEl.appendChild(separator);
                return;
            }

            // Ligne Blobby toggle : structure dédiée (icône + libellé dynamique
            // + pastille ON/OFF), ne ferme pas le menu au clic.
            if (itemInfo.special === 'aih_blobby_toggle') {
                this.dropdownMenuEl.appendChild(this.buildAihBlobbyToggleItem());
                return;
            }

            const menuItem = document.createElement("li");
            menuItem.style.display = "flex";
            menuItem.style.justifyContent = "space-between";
            menuItem.style.alignItems = "center";

            const labelSpan = document.createElement("span");
            labelSpan.textContent = itemInfo.label;
            menuItem.appendChild(labelSpan);

            // « 💬 Chat » : identifié pour updateAihDynamicItems (indépendant
            // de l'état d'activation de Blobby ; sa visibilité est pilotée par
            // sa propre feature WIP via isWipItemVisible).
            if (itemInfo.special === 'aih_chat') {
                menuItem.id = "holaf-menu-aih-chat";
            }

            let checkbox = null;
            if (["toggle_layout_tools", "toggle_shortcuts", "toggle_compact_menu", "toggle_remote_comparer"].includes(itemInfo.special)) {
                checkbox = document.createElement("div");
                Object.assign(checkbox.style, {
                    width: "12px",
                    height: "12px",
                    border: "1px solid var(--border-color, #888)",
                    borderRadius: "3px",
                    backgroundColor: "rgba(0,0,0,0.2)",
                    marginLeft: "15px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "10px",
                    color: "var(--holaf-accent-color, #ff8c00)"
                });
                menuItem.appendChild(checkbox);
            }

            const updateCheckboxUI = () => {
                if (!checkbox) return;
                let isActive = false;
                if (itemInfo.special === "toggle_layout_tools") {
                    isActive = window.holaf?.layoutTools?.isVisible;
                } else if (itemInfo.special === "toggle_shortcuts") {
                    isActive = app.holafShortcuts?.isVisible;
                } else if (itemInfo.special === "toggle_remote_comparer") {
                    isActive = app.holafRemoteComparer?.isOpen;
                } else if (itemInfo.special === "toggle_compact_menu") {
                    isActive = this.isCompactMode;
                }
                checkbox.innerHTML = isActive ? "✓" : "";
                checkbox.style.borderColor = isActive ? "var(--holaf-accent-color, #ff8c00)" : "var(--border-color, #888)";
            };

            setTimeout(updateCheckboxUI, 50);

            menuItem.onclick = (e) => {
                if (itemInfo.special === 'restart') {
                    this.startRestartFlow();
                }
                else if (itemInfo.special === "toggle_layout_tools") {
                    if (window.holaf && window.holaf.layoutTools) {
                        window.holaf.layoutTools.toggle();
                        updateCheckboxUI();
                    }
                }
                else if (itemInfo.special === "toggle_shortcuts") {
                    if (app.holafShortcuts && typeof app.holafShortcuts.toggle === "function") {
                        app.holafShortcuts.toggle();
                        updateCheckboxUI();
                    }
                }
                else if (itemInfo.special === "toggle_remote_comparer") {
                    if (app.holafRemoteComparer && typeof app.holafRemoteComparer.toggle === "function") {
                        app.holafRemoteComparer.toggle();
                        updateCheckboxUI();
                    }
                }
                else if (itemInfo.special === "toggle_compact_menu") {
                    const newState = !this.isCompactMode;
                    this.isCompactMode = newState;
                    localStorage.setItem("Holaf_CompactMenu", newState);

                    this.hideDropdown();
                    this.toggleCompactMode(newState);
                    updateCheckboxUI();
                    return;
                }
                else if (itemInfo.special === "profiler_standalone") {
                    window.open('/holaf/profiler/view', '_blank');
                }
                else if (itemInfo.special === 'aih_chat') {
                    // Ouvre le chat indépendamment de l'état d'activation de
                    // Blobby ; ne ferme pas le menu.
                    if (window.AIHMenu && typeof window.AIHMenu.openChat === "function") {
                        window.AIHMenu.openChat();
                    }
                }
                else if (itemInfo.special === 'aih_update') {
                    // Modale enrichie portée de la source (spinner + log git +
                    // proposition de redémarrage). Fallback : ancien flux toast
                    // si js/aih_menu.js n'est pas encore chargé.
                    if (window.AIHMenu && typeof window.AIHMenu.openUpdate === "function") {
                        window.AIHMenu.openUpdate();
                    } else {
                        this.checkForAIHUpdate();
                    }
                }
                else if (itemInfo.special && itemInfo.special.startsWith('aih_')) {
                    this.callAihMenuFn(itemInfo.special);
                }
                else {
                    const handler = app[itemInfo.handlerName];
                    if (handler && typeof handler.show === 'function') {
                        handler.show();
                    } else {
                        AIH.ask({ title: t("main.notImplemented"), message: t("main.panelNotAvailable", { label: itemInfo.label }), buttons: [{ text: t("dialog.ok"), value: true }] });
                    }
                }

                // Le toggle Blobby et le Chat ne ferment pas le menu
                // (comportement de la source aih_menu.js).
                if (!checkbox && itemInfo.special !== 'aih_chat') {
                    this.hideDropdown();
                }
            };
            this.dropdownMenuEl.appendChild(menuItem);
            });
        });

        // Pied de menu : statut du serveur AIH distant. Ligne passive,
        // rafraîchie à chaque ouverture du menu (voir updateAihDynamicItems).
        const statusLi = document.createElement("li");
        statusLi.id = "holaf-menu-aih-status";
        statusLi.textContent = t("menu.statusChecking");
        Object.assign(statusLi.style, {
            borderTop: "1px solid var(--holaf-border-color, #3F3F3F)",
            marginTop: "5px",
            paddingTop: "8px",
            paddingBottom: "8px",
            fontSize: "11px",
            cursor: "default",
            pointerEvents: "none"
        });
        this.dropdownMenuEl.appendChild(statusLi);
        this.aihStatusEl = statusLi;

        // État dynamique initial (pastille/libellé Blobby + sonde serveur).
        setTimeout(() => this.updateAihDynamicItems(), 50);
    },

    // ── Groupe AIH ──
    // Délègue aux helpers portés dans js/aih_menu.js (window.AIHMenu).
    // NB : plus d'entrée « Paramètres » — les onglets AIH (Compte / Provider
    // LLM) vivent dans la fenêtre Settings Holaf (holaf_settings_manager.js),
    // et window.AIHMenu.openSettings() ouvre simplement cette fenêtre.
    callAihMenuFn(special) {
        const map = {
            aih_webpage: "openWebpage",
            aih_workflows: "openWorkflows",
            aih_models: "openModels",
            aih_members: "openMembers"
        };
        const fnName = map[special];
        if (fnName && window.AIHMenu && typeof window.AIHMenu[fnName] === "function") {
            window.AIHMenu[fnName]();
        } else {
            AIH.ask({ title: t("menu.sectionAIH"), message: t("main.aihEntryNotAvailable", { special }), buttons: [{ text: t("dialog.ok"), value: true }] });
        }
    },

    // Ligne « 🧡 Activer Blobby ↔ Blobby (test) » avec pastille ON/OFF.
    // Le clic appelle window.BlobbyCompanion.toggle() via AIHMenu et NE
    // ferme PAS le menu (comportement de la source).
    buildAihBlobbyToggleItem() {
        const li = document.createElement("li");
        li.id = "holaf-menu-aih-blobby";
        li.style.display = "flex";
        li.style.alignItems = "center";
        li.style.gap = "8px";

        const icon = document.createElement("span");
        icon.textContent = "🧡";
        const labelSpan = document.createElement("span");
        labelSpan.className = "holaf-aih-blobby-label";
        labelSpan.style.flex = "1";
        const pill = document.createElement("span");
        pill.className = "holaf-aih-blobby-pill";
        Object.assign(pill.style, {
            fontSize: "10px",
            padding: "1px 6px",
            borderRadius: "4px",
            fontWeight: "600"
        });

        li.appendChild(icon);
        li.appendChild(labelSpan);
        li.appendChild(pill);

        li.onclick = () => {
            if (window.AIHMenu && typeof window.AIHMenu.toggleBlobby === "function") {
                window.AIHMenu.toggleBlobby();
                this.updateAihDynamicItems();
            }
            // Pas de hideDropdown() ici
        };
        return li;
    },

    // État dynamique des entrées AIH : libellé/pastille Blobby et sonde de
    // statut serveur pour le pied de menu. La visibilité de « 💬 Chat » est
    // indépendante de l'état de Blobby (pilotée par sa feature WIP dans
    // buildMenu). Appelé à chaque construction ET ouverture du menu.
    updateAihDynamicItems() {
        const blobbyLi = document.getElementById("holaf-menu-aih-blobby");
        let active = false;
        try {
            active = !!(window.AIHMenu && window.AIHMenu.getBlobbyState && window.AIHMenu.getBlobbyState());
        } catch (e) {
            active = false;
        }

        if (blobbyLi) {
            const labelSpan = blobbyLi.querySelector(".holaf-aih-blobby-label");
            const pill = blobbyLi.querySelector(".holaf-aih-blobby-pill");
            if (labelSpan) labelSpan.textContent = active ? t("menu.blobbyActive") : t("menu.blobbyActivate");
            if (pill) {
                pill.textContent = active ? t("menu.blobbyOn") : t("menu.blobbyOff");
                pill.style.background = active ? "#166534" : "#555";
                pill.style.color = active ? "#86efac" : "#aaa";
            }
        }

        if (this.aihStatusEl && window.AIHMenu && typeof window.AIHMenu.checkServerStatus === "function") {
            window.AIHMenu.checkServerStatus(this.aihStatusEl);
        }
    },

    // ── AIH Update ──
    // POST /aih/update applies the update on disk and answers {updated: bool}
    // (never restarts by itself). When something changed, propose the restart
    // via the shared Utils mechanism POST /holaf/utilities/restart.
    checkForAIHUpdate() {
        const waitId = showToast({ message: t("main.checkingUpdate"), type: "info", duration: 0 });
        // Update = git fetch + reset --hard côté serveur : potentiellement long
        // → timeout désactivé (l'ancien fetch natif n'en avait pas).
        HolafFetch.post("/aih/update", { timeout: 0 })
            .then(data => {
                if (waitId) hideToast(waitId);
                if (data.updated) {
                    AIH.choose(t("main.updateTitle"), t("main.updateInstalled"), [
                        { text: t("main.later"), value: "later", type: "cancel" },
                        { text: t("main.restart"), value: "restart", type: "primary" }
                    ]).then((choice) => {
                        if (choice === "restart") this.startRestartFlow();
                    });
                } else if (data.status === "error") {
                    showToast({ message: t("main.updateFailed") + (data.message || "unknown error"), type: "error" });
                } else {
                    showToast({ message: t("main.alreadyUpToDate"), type: "success" });
                }
            })
            .catch(err => {
                if (waitId) hideToast(waitId);
                // HolafFetch lève sur non-2xx : le backend renvoie alors
                // {status: "error", message} → même message utilisateur que
                // la branche 2xx d'avant la migration.
                if (err instanceof HolafFetchError && err.data && err.data.status === "error") {
                    showToast({ message: t("main.updateFailed") + (err.data.message || "unknown error"), type: "error" });
                } else {
                    showToast({ message: t("main.updateCheckFailed") + (err.message || "network error"), type: "error" });
                }
            });
    },

    // ── Shared restart flow (used by "Restart ComfyUI" — the only restart
    //    entry, the separate AIH one having been removed — and by the
    //    post-update prompt) ──
    startRestartFlow() {
        const restartDiv = document.createElement("div");
        const restartMsg = document.createElement("p");
        restartMsg.id = "holaf-restart-message";
        restartMsg.textContent = t("main.restartConfirm");
        restartDiv.appendChild(restartMsg);
        const restartTimerLine = document.createElement("p");
        restartTimerLine.id = "holaf-restart-timer-line";
        restartTimerLine.style.cssText = "visibility: hidden; margin-top: 10px; height: 1.2em;";
        restartTimerLine.appendChild(document.createTextNode(t("main.timeElapsed")));
        const restartTimerSpan = document.createElement("span");
        restartTimerSpan.id = "holaf-restart-timer";
        restartTimerSpan.textContent = "0";
        restartTimerLine.appendChild(restartTimerSpan);
        restartTimerLine.appendChild(document.createTextNode("s"));
        restartDiv.appendChild(restartTimerLine);

        // Pied de confirmation (délégué à AIH.Dialog.open — conservé ouvert
        // pendant la phase de redémarrage pour afficher le suivi en direct).
        const footerEl = document.createElement("div");
        footerEl.className = "aih-dialog-footer";
        const confirmCancelBtn = document.createElement("button");
        confirmCancelBtn.className = "aih-dialog-btn aih-dialog-btn-cancel";
        confirmCancelBtn.textContent = t("dialog.cancel");
        const confirmGoBtn = document.createElement("button");
        confirmGoBtn.className = "aih-dialog-btn aih-dialog-btn-primary";
        confirmGoBtn.textContent = t("dialog.confirm");
        footerEl.appendChild(confirmCancelBtn);
        footerEl.appendChild(confirmGoBtn);
        restartDiv.appendChild(footerEl);

        // Nettoyage des timers quand le dialogue se ferme (bouton Fermer,
        // fond, Échap) — même sémantique que l'ancienne modale locale.
        const clearIntervals = () => {
            if (window.holaf.restartMonitorInterval) clearInterval(window.holaf.restartMonitorInterval);
            if (window.holaf.restartTimerInterval) clearInterval(window.holaf.restartTimerInterval);
            delete window.holaf.restartMonitorInterval;
            delete window.holaf.restartTimerInterval;
        };

        const dialog = AIH.Dialog.open({
            title: t("menu.restart"),
            modal: true,
            resizable: false,
            draggable: true,
            content: restartDiv,
            onClose: clearIntervals
        });

        confirmCancelBtn.addEventListener("click", () => dialog.close());

        confirmGoBtn.addEventListener("click", () => {
            const messageEl = document.getElementById("holaf-restart-message");
            const timerLineEl = document.getElementById("holaf-restart-timer-line");

            dialog.setTitle(t("main.restartingTitle"));
            messageEl.textContent = t("main.sendingRestart");
            timerLineEl.style.visibility = "visible";

            const restartCloseBtn = document.createElement("button");
            restartCloseBtn.id = "holaf-restart-close-btn";
            restartCloseBtn.className = "aih-dialog-btn aih-dialog-btn-cancel";
            restartCloseBtn.textContent = t("main.close");
            const restartRefreshBtn = document.createElement("button");
            restartRefreshBtn.id = "holaf-restart-refresh-btn";
            restartRefreshBtn.className = "aih-dialog-btn aih-dialog-btn-primary";
            restartRefreshBtn.disabled = true;
            restartRefreshBtn.textContent = t("main.refresh");
            footerEl.replaceChildren(restartCloseBtn, restartRefreshBtn);
            restartCloseBtn.addEventListener("click", () => dialog.close());

            // POST migré vers HolafFetch (la route répond immédiatement — le
            // redémarrage est planifié dans un thread) : timeout défaut conservé.
            // Suivi /system_stats toutes les 2 s (GET léger, credentials:'include',
            // redirect:'manual') via holaf_restart_health.js.
            HolafFetch.post("/holaf/utilities/restart")
                .then(data => {
                    if (data.status !== "ok") throw new Error(data.message || 'Unknown server error');

                    const timerEl = document.getElementById("holaf-restart-timer");
                    const refreshBtn = document.getElementById("holaf-restart-refresh-btn");
                    if (!messageEl || !timerEl || !refreshBtn) return;

                    messageEl.textContent = t("main.serverRestarting");

                    let seconds = 0;
                    window.holaf.restartTimerInterval = setInterval(() => {
                        seconds++;
                        if (timerEl) timerEl.textContent = seconds;
                    }, 1000);

                    let serverIsDown = false;
                    // Check robuste : interroge /system_stats (VRAI endpoint ComfyUI)
                    // avec credentials:'include' + redirect:'manual'. Un 302 Authentik
                    // (réponse opaque) ou un 502 Caddy ne sont PAS considérés comme
                    // « serveur revenu » : seul un 200 + JSON /system_stats de ComfyUI
                    // active le bouton « Actualiser ». (holaf_restart_health.js)
                    const checkServerStatus = async () => {
                        const { ready } = await holafComfyHealthCheck();
                        if (ready) {
                            clearInterval(window.holaf.restartMonitorInterval);
                            clearInterval(window.holaf.restartTimerInterval);
                            delete window.holaf.restartMonitorInterval;
                            delete window.holaf.restartTimerInterval;

                            if (!messageEl || !refreshBtn) return;

                            messageEl.textContent = t("main.serverRebooted", { seconds });
                            if (timerLineEl) timerLineEl.style.visibility = "hidden";
                            refreshBtn.textContent = t("main.refreshPage");
                            refreshBtn.disabled = false;
                            refreshBtn.onclick = () => location.reload();
                            refreshBtn.focus();
                        } else if (!serverIsDown) {
                            if (messageEl) messageEl.textContent = t("main.serverOffline");
                            serverIsDown = true;
                        }
                    };

                    window.holaf.restartMonitorInterval = setInterval(checkServerStatus, 2000);
                })
                .catch(err => {
                    const errorP = document.createElement('p');
                    errorP.style.color = 'var(--aih-danger, #F44336)';
                    errorP.textContent = t("main.restartFailed") + (err.message || "Unknown error") + ".";
                    const rb = document.getElementById("holaf-restart-refresh-btn");
                    if (rb) rb.disabled = true;
                    if (messageEl) messageEl.replaceChildren(errorP);
                    if (timerLineEl) timerLineEl.style.display = "none";
                });
        });
    },

    injectCompactCSS() {
        if (document.getElementById("holaf-compact-style-override")) return;
        
        this.styleEl = document.createElement("style");
        this.styleEl.id = "holaf-compact-style-override";
        this.styleEl.innerHTML = `
            /* MODE COMPACT (nouvelle topbar Vue/Tailwind).
               La carte d'actions est marquée .holaf-compact-card par maintainCompactParent()
               et remontée en haut à droite, dans la même rangée que les onglets. */

            body.holaf-compact-active [data-testid="topbar-workflow-tabs"] {
                padding-right: var(--holaf-compact-card-width, 480px) !important;
                box-sizing: border-box !important;
                width: 100% !important;
                max-width: 100% !important;
            }

            body.holaf-compact-active .holaf-compact-card {
                position: fixed !important;
                top: 0 !important;
                right: 0 !important;
                height: var(--workflow-tabs-height, 38px) !important;
                min-height: 0 !important;
                flex-direction: row !important;
                align-items: center !important;
                flex-wrap: nowrap !important;
                z-index: 1005 !important;
                margin: 0 !important;
                padding: 0 8px !important;
                border-radius: 0 !important;
                box-shadow: -4px 0 8px rgba(0,0,0,0.3) !important;
                background: var(--comfy-menu-bg, #202020) !important;
            }

            body.holaf-compact-active .holaf-compact-card > * {
                flex-shrink: 0 !important;
            }
        `;
        document.head.appendChild(this.styleEl);
    },

    maintainCompactParent() {
        if (!this.isCompactMode) return;
        const ac = document.querySelector('.actionbar-container');
        if (!ac) return;
        const card = ac.parentElement;
        if (!card) return;

        // Marque la carte d'actions avec notre propre classe stable. La classe
        // native .action-bar-card n'est pas fiable (elle apparaît/disparaît).
        card.classList.add('holaf-compact-card');

        // Mesure la largeur réelle de la carte et la communique au CSS pour que
        // le padding-right des onglets corresponde exactement à la barre.
        const width = Math.round(card.getBoundingClientRect().width);
        document.documentElement.style.setProperty('--holaf-compact-card-width', width + 'px');
    },

    startCompactWatchdog() {
        // Filet de sécurité : la topbar Vue de ComfyUI est montée de façon
        // asynchrone (parfois bien après le chargement initial, ou re-rendue
        // plus tard). Ce watchdog basse fréquence ré-applique le mode compact
        // tant qu'il est actif, même si waitForUIAndApplyCompact a échoué ou
        // expiré après son timeout de 10 s.
        if (this._compactWatchdog) return;
        this._compactWatchdog = setInterval(() => {
            if (!this.isCompactMode) return;
            const tabs = document.querySelector('.workflow-tabs-container');
            const bar = document.querySelector('.actionbar-container');
            if (!tabs || !bar) return;
            if (!document.body.classList.contains("holaf-compact-active") || !this._compactObserver) {
                this.toggleCompactMode(true);
            } else {
                this.maintainCompactParent();
            }
        }, 2000);
    },

    waitForUIAndApplyCompact() {
        const checkAndApply = () => {
            const tabs = document.querySelector('.workflow-tabs-container');
            const bar = document.querySelector('.actionbar-container');
            if (tabs && bar) {
                this.toggleCompactMode(true);
                return true;
            }
            return false;
        };

        if (checkAndApply()) return;

        const observer = new MutationObserver(() => {
            if (checkAndApply()) {
                observer.disconnect();
                clearTimeout(timeoutId);
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
        const timeoutId = setTimeout(() => observer.disconnect(), 10000);
    },

    initBridgeListener() {
        const bc = new BroadcastChannel('holaf_channel');
        bc.onmessage = async (event) => {
            const { command, data } = event.data;
            if (command === 'get_workflow_for_profiler') {
                try {
                    const visualGraph = app.graph.serialize();
                    await HolafFetch.post('/holaf/profiler/context', { body: visualGraph });
                    showToast({ message: t("main.workflowSynced"), type: "success" });
                } catch (e) {
                    showToast({ message: t("main.workflowSyncError"), type: "error" });
                }
            }
        };
    },

    toggleCompactMode(active) {
        if (active) {
            document.body.classList.add("holaf-compact-active");
            this.maintainCompactParent();
            this.startCompactWatchdog();

            // Clean up any previous enforcer
            if (this.startupEnforcerInterval) clearInterval(this.startupEnforcerInterval);
            if (this._compactObserver) this._compactObserver.disconnect();

            // Short burst enforcer for initial setup (handles late DOM insertions)
            let ticks = 0;
            this.startupEnforcerInterval = setInterval(() => {
                this.maintainCompactParent();
                ticks++;
                // Increased to 10s (was 5s) because some ComfyUI extensions inject the action bar
            // asynchronously well after initial page load, causing compact mode to miss it.
            if (ticks > 20) {
                    clearInterval(this.startupEnforcerInterval);
                    this.startupEnforcerInterval = null;
                }
            }, 500);

            // Long-term observer: re-apply when ComfyUI moves/replaces the action bar.
            // Debounced to avoid excessive calls on busy pages with frequent DOM mutations.
            let _compactDebounce = null;
            this._compactObserver = new MutationObserver(() => {
                clearTimeout(_compactDebounce);
                _compactDebounce = setTimeout(() => {
                    if (this.isCompactMode) this.maintainCompactParent();
                }, 50);
            });
            this._compactObserver.observe(document.body, { childList: true, subtree: true });

        } else {
            document.body.classList.remove("holaf-compact-active");
            if (this.startupEnforcerInterval) {
                clearInterval(this.startupEnforcerInterval);
                this.startupEnforcerInterval = null;
            }
            if (this._compactObserver) {
                this._compactObserver.disconnect();
                this._compactObserver = null;
            }
            if (this._compactWatchdog) {
                clearInterval(this._compactWatchdog);
                this._compactWatchdog = null;
            }
            
            document.querySelectorAll('.holaf-compact-parent, .holaf-compact-card').forEach(el => {
                el.classList.remove('holaf-compact-parent', 'holaf-compact-card');
            });
            document.documentElement.style.removeProperty('--holaf-compact-card-width');
        }
    },

    showDropdown(buttonElement) {
        if (!this.dropdownMenuEl) return;
        if (this.dropdownMenuEl.parentElement !== document.body) {
            document.body.appendChild(this.dropdownMenuEl);
        }

        const rect = buttonElement.getBoundingClientRect();
        this.dropdownMenuEl.style.top = `${rect.bottom + 2}px`;

        const computedStyle = getComputedStyle(this.dropdownMenuEl);
        const dropdownWidth = this.dropdownMenuEl.offsetWidth || parseFloat(computedStyle.minWidth) || 140;

        let leftPosition = rect.right - dropdownWidth;
        if (leftPosition < 5) leftPosition = 5;

        this.dropdownMenuEl.style.left = `${leftPosition}px`;
        this.dropdownMenuEl.style.display = "block";
    },

    hideDropdown() {
        if (!this.dropdownMenuEl) return;
        this.dropdownMenuEl.style.display = "none";
    },

    loadSharedCss() {
        const cssFiles =[
            "holaf_themes.css",
            "holaf_shared_panel.css",
            "holaf_main_button.css",
            "holaf_model_manager_styles.css",
            "holaf_terminal_styles.css",
            "holaf_nodes_manager_styles.css",
            "holaf_settings_panel_styles.css",
            "holaf_profiler.css",
            "holaf_layout_tools.css",
            "holaf_remote_comparer_styles.css",
            "holaf_shortcuts_styles.css"
        ];
        cssFiles.forEach(fileName => {
            const cssId = `holaf-css-${fileName.replace('.css', '')}`;
            if (!document.getElementById(cssId)) {
                const link = document.createElement("link");
                link.id = cssId;
                link.rel = "stylesheet";
                link.type = "text/css";
                link.href = holafExtUrl(`css/${fileName}`);
                document.head.appendChild(link);
            }
        });
    }
};

app.registerExtension({
    name: "Holaf.Utilities.Menu",
    async setup() {
        setTimeout(() => HolafUtilitiesMenu.init(), 10);
    }
});