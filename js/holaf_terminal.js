/* === Documentation ===
 * Developer: Gemini (AI Assistant), under the direction of Holaf
 * Date: 2025-05-23 (Final)
 *
 * MODIFIED: Added delayed fitTerminal on initial socket open for better initial sizing.
 * MODIFIED: Unified theme management using HOLAF_THEMES from holaf_themes.js.
 * MODIFIED: Added fullscreen state management (double-click on header).
 * CORRECTION: Removed dynamic menu registration. Added object to `app` for static menu access.
 * CORRECTION: Re-integrated critical CSS for terminal container layout.
 * FIX(lifecycle): Full session lifecycle rework:
 *   - The server sends {"type":"session-ended"} (TEXT control frame) when the
 *     shell exits (Ctrl+D / exit / crash). On receipt we tear down the socket
 *     AND the xterm instance, then show the reconnect screen. The next
 *     connect creates a brand-new WebSocket + fresh PTY-bound terminal
 *     instead of resurrecting a dead session.
 *   - Every connection disposes the previous xterm and opens a pristine one.
 *   - All handlers are guarded against stale events from a replaced socket
 *     (late onclose/onerror of the old socket used to null out the NEW socket,
 *     leaving a live-looking but dead terminal).
 *   - Keyboard input is sent as BINARY frames; TEXT frames are reserved for
 *     JSON control messages (resize / session-ended), so keystrokes that look
 *     like JSON can no longer be swallowed by the control parser.
 *
 * SECURITY NOTE: The terminal executes shell commands on the ComfyUI host.
 *   The pack ships NO application authentication; access to this shell is
 *   restricted by the reverse-proxy in front of ComfyUI (Caddy basic_auth or
 *   Authentik forward-auth). NEVER expose the ComfyUI port (8188) directly,
 *   and use HTTPS/WSS in remote deployments.
 * === End Documentation ===
 */
import "./aih_dialog.js";
import "./aih_strings.js";
import { app } from "./holaf_api_compat.js";
import { HolafPanelManager } from "./holaf_panel_manager.js";
import { holafExtUrl } from "./holaf_ext_base.js";
// CORRECTED IMPORT: No longer depends on panel_manager for themes.
import { HOLAF_THEMES } from "./holaf_themes.js";
import { HolafFetch, HolafFetchError } from "./vendor/holaf/holaf-fetch.js";

// Helper i18n central : traduit via AIH.I18n (clé brute si absente).
const t = (key, params) => {
    const I = window.AIH && window.AIH.I18n;
    return I && typeof I.t === "function" ? I.t(key, params) : key;
};

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const existingScript = document.querySelector(`script[src="${src}"]`);
        if (existingScript && existingScript.dataset.loaded) {
            resolve();
            return;
        }
        if (existingScript && !existingScript.dataset.loaded) {
            // Script tag exists but may not have fired its load event yet.
            // Attach listeners, but also check readyState as a fallback
            // for scripts that finished loading before listeners were attached.
            let resolved = false;
            const handleLoad = () => {
                if (!resolved) {
                    existingScript.dataset.loaded = true;
                    resolved = true;
                    resolve();
                }
            };
            const handleError = () => {
                if (!resolved) {
                    console.error(`[Holaf Terminal] Failed to load script (event): ${src}`);
                    resolved = true;
                    reject(new Error(`Failed to load script: ${src}`));
                }
            };
            existingScript.addEventListener('load', handleLoad);
            existingScript.addEventListener('error', handleError);

            // readyState fallback for scripts that completed loading
            // before our listeners were attached (IE/old Edge)
            if (existingScript.readyState === 'loaded' || existingScript.readyState === 'complete') {
                // Defer to allow the browser to finish firing its events
                setTimeout(() => {
                    if (!existingScript.dataset.loaded && !resolved) {
                        existingScript.dataset.loaded = true;
                        resolved = true;
                        resolve();
                    }
                }, 0);
            }
            return;
        }

        const script = document.createElement("script");
        script.src = src;
        script.onload = () => {
            script.dataset.loaded = true;
            resolve();
        };
        script.onerror = () => {
            console.error(`[Holaf Terminal] Failed to load script: ${src}`);
            reject(new Error(`Failed to load script: ${src}`));
        };
        document.head.appendChild(script);
    });
}

const holafTerminal = {
    panelElements: null,
    terminal: null,
    fitAddon: null,
    socket: null,
    isInitialized: false,
    scriptsLoaded: false,
    settings: {
        fontSize: 14,
        theme: HOLAF_THEMES[0].name,
        panel_x: null,
        panel_y: null,
        panel_width: 600,
        panel_height: 400,
        panel_is_fullscreen: false,
    },
    saveTimeout: null,

    async ensureScriptsLoaded() {
        if (this.scriptsLoaded && window.Terminal && window.FitAddon) return true;
        try {
            if (!window.Terminal) {
                // WEB_DIRECTORY is mounted at the extension root: xterm.js is
                // served at <base>/xterm.js (no "js/" segment in browser URLs).
                await loadScript(holafExtUrl("xterm.js"));
                // Verify the global is now available (guard against race conditions)
                if (!window.Terminal) {
                    await new Promise(r => setTimeout(r, 100));
                }
            }
            if (!window.FitAddon) {
                await loadScript(holafExtUrl("xterm-addon-fit.js"));
                if (!window.FitAddon) {
                    await new Promise(r => setTimeout(r, 100));
                }
            }
            this.scriptsLoaded = true;
            return true;
        } catch (error) {
            console.error("Holaf Utilities: Critical error loading xterm scripts", error);
            if (this.panelElements && this.panelElements.contentEl) {
                const loadingView = this.panelElements.contentEl.querySelector('.holaf-terminal-non-terminal-view');
                if (loadingView) loadingView.textContent = t("term.componentsLoadError");
            }
            this.scriptsLoaded = false;
            return false;
        }
    },

    init() {
        // Initialization is minimal as the menu is handled centrally.
    },

    async createPanel() {
        if (this.panelElements && this.panelElements.panelEl) {
            return;
        }

        const terminalHeaderControlsGroup = document.createElement("div");
        terminalHeaderControlsGroup.className = "holaf-header-button-group";

        const themeButtonContainer = document.createElement("div");
        themeButtonContainer.style.position = 'relative';
        const themeButton = document.createElement("button");
        themeButton.className = "holaf-header-button";
        themeButton.title = t("term.theme");
        themeButton.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 12.55a9.42 9.42 0 0 1-9.45 9.45 9.42 9.42 0 0 1-9.45-9.45 9.42 9.42 0 0 1 9.45-9.45 2.5 2.5 0 0 1 2.5 2.5 2.5 2.5 0 0 0 2.5 2.5 2.5 2.5 0 0 1 0 5 2.5 2.5 0 0 0-2.5 2.5 2.5 2.5 0 0 1-2.5 2.5Z"/></svg>`;
        const themeMenu = this.createThemeMenu();
        themeButton.onclick = (e) => {
            e.stopPropagation();
            themeMenu.style.display = themeMenu.style.display === 'block' ? 'none' : 'block';
        };
        document.addEventListener('click', () => { if (themeMenu) themeMenu.style.display = 'none' });
        themeButtonContainer.append(themeButton, themeMenu);

        const fontDecButton = document.createElement("button");
        fontDecButton.className = "holaf-header-button";
        fontDecButton.title = t("term.fontDec");
        fontDecButton.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>`;
        fontDecButton.onclick = () => this.decreaseFontSize();

        const fontIncButton = document.createElement("button");
        fontIncButton.className = "holaf-header-button";
        fontIncButton.title = t("term.fontInc");
        fontIncButton.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>`;
        fontIncButton.onclick = () => this.increaseFontSize();

        terminalHeaderControlsGroup.append(themeButtonContainer, fontDecButton, fontIncButton);

        try {
            this.panelElements = HolafPanelManager.createPanel({
                // CRITIQUE : l'id `holaf-terminal-panel` est requis — tout le CSS
                // terminal (holaf_terminal_styles.css) est scopé sous cet id.
                id: "holaf-terminal-panel",
                title: (() => { const f = document.createDocumentFragment(); const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("width", "18"); svg.setAttribute("height", "18"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("fill", "none"); svg.style.verticalAlign = "-3px"; svg.style.marginRight = "6px"; const p1 = document.createElementNS("http://www.w3.org/2000/svg", "path"); p1.setAttribute("d", "M5 7L10 12L5 17"); p1.setAttribute("stroke", "currentColor"); p1.setAttribute("stroke-width", "2.5"); p1.setAttribute("stroke-linecap", "round"); p1.setAttribute("stroke-linejoin", "round"); svg.appendChild(p1); const p2 = document.createElementNS("http://www.w3.org/2000/svg", "path"); p2.setAttribute("d", "M12 17H19"); p2.setAttribute("stroke", "currentColor"); p2.setAttribute("stroke-width", "2.5"); p2.setAttribute("stroke-linecap", "round"); svg.appendChild(p2); f.appendChild(svg); f.appendChild(document.createTextNode(t("term.panelTitle"))); return f; })(),
                headerContent: terminalHeaderControlsGroup,
                zoom: {
                    key: "holaf-terminal-panel",
                    min: 0.5,
                    max: 2.0,
                    step: 0.1,
                    setLevel: () => {
                        // Standard zoom de contenu (var --aih-zoom-factor) ;
                        // les boutons fontSize gèrent la taille de police xterm.
                        if (this.fitTerminal) setTimeout(() => this.fitTerminal(), 0);
                    },
                },
                defaultSize: { width: this.settings.panel_width, height: this.settings.panel_height },
                defaultPosition: { x: this.settings.panel_x, y: this.settings.panel_y },
                onClose: () => { },
                onStateChange: (newState) => {
                    if (!this.settings.panel_is_fullscreen) {
                        this.saveSettings({
                            panel_x: newState.x, panel_y: newState.y,
                            panel_width: newState.width, panel_height: newState.height,
                        });
                    }
                },
                onResize: () => {
                    this.fitTerminal();
                },
                onFullscreenToggle: (isFullscreen) => {
                    this.settings.panel_is_fullscreen = isFullscreen;
                    this.saveSettings({ panel_is_fullscreen: isFullscreen });
                    setTimeout(() => this.fitTerminal(), 210);
                }
            });
        } catch (e) {
            console.error("[Holaf Terminal] Error during HolafPanelManager.createPanel:", e);
            await window.AIH.alert("[AIH Terminal]", t("term.createPanelError"), "error");
            return;
        }

        // --- CORRECTION : Ce bloc CSS est essentiel pour le redimensionnement ---
        // Terminal-specific header button ordering is now in holaf_terminal_styles.css

        this.contentContainer = this.panelElements.contentEl;
        this.terminalContainer = this.createTerminalView();
        this.loadingView = this.createLoadingView();
        this.reconnectView = this.createReconnectView();

        this.contentContainer.append(
            this.loadingView, this.reconnectView, this.terminalContainer
        );
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
                if (menu) menu.style.display = 'none';
            };
            menu.appendChild(item);
        });
        return menu;
    },
    async show() {
        if (!this.panelElements || !this.panelElements.panelEl) {
            await this.createPanel();
            if (!this.panelElements || !this.panelElements.panelEl) {
                console.error("[Holaf Terminal] Panel creation FAILED in show(). Aborting.");
                return;
            }
        }

        const panelIsVisible = this.panelElements.panelEl.style.display === "flex";
        if (panelIsVisible) {
            this.panelElements.panelEl.style.display = "none";
            return;
        }

        this.panelElements.panelEl.style.display = "flex";
        HolafPanelManager.bringToFront(this.panelElements.panelEl);

        const scriptsReady = await this.ensureScriptsLoaded();
        if (!scriptsReady) {
            this.showView('loading');
            if (this.loadingView) this.loadingView.textContent = t("term.scriptsLoadError");
            return;
        }

        if (!this.isInitialized || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
            this.checkServerStatus();
            this.isInitialized = true;
        } else if (this.terminal) {
            this.showView('terminal');
            requestAnimationFrame(() => {
                if (this.terminal) { this.terminal.focus(); this.fitTerminal(); }
            });
        }
    },
    applySettings(themeJustSet = false) {
        if (this.panelElements && this.panelElements.panelEl) {
            if (this.settings.panel_is_fullscreen) {
                if (!this.panelElements.panelEl.classList.contains("holaf-panel-fullscreen")) {
                    this.panelElements.panelEl.classList.add("holaf-panel-fullscreen");
                }
            } else {
                if (this.panelElements.panelEl.classList.contains("holaf-panel-fullscreen")) {
                    this.panelElements.panelEl.classList.remove("holaf-panel-fullscreen");
                }
            }

            this.panelElements.panelEl.style.width = `${this.settings.panel_width}px`;
            this.panelElements.panelEl.style.height = `${this.settings.panel_height}px`;

            if (this.settings.panel_x !== null && this.settings.panel_y !== null) {
                this.panelElements.panelEl.style.left = `${this.settings.panel_x}px`;
                this.panelElements.panelEl.style.top = `${this.settings.panel_y}px`;
                this.panelElements.panelEl.style.transform = 'none';
            } else {
                this.panelElements.panelEl.style.left = `50%`;
                this.panelElements.panelEl.style.top = `50%`;
                this.panelElements.panelEl.style.transform = 'translate(-50%, -50%)';
            }
        }
        if (!themeJustSet) {
            this.setTheme(this.settings.theme, false);
        }
        if (this.terminal) {
            this.terminal.options.fontSize = this.settings.fontSize;
            this.fitTerminal();
        }
    },
    saveSettings(newSettings) {
        if (newSettings && typeof newSettings === 'object') {
            Object.assign(this.settings, newSettings);
        }
        clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(async () => {
            try {
                const settingsToSave = {
                    theme: this.settings.theme,
                    font_size: this.settings.fontSize,
                    panel_x: this.settings.panel_x, panel_y: this.settings.panel_y,
                    panel_width: this.settings.panel_width, panel_height: this.settings.panel_height,
                    panel_is_fullscreen: this.settings.panel_is_fullscreen
                };
                // HolafFetch lève sur non-2xx (→ catch ci-dessous).
                await HolafFetch.post('/holaf/terminal/save-settings', { body: settingsToSave });
            } catch (e) {
                const status = e instanceof HolafFetchError ? e.status : "network";
                const msg = (e instanceof HolafFetchError && e.data && e.data.message) ? e.data.message : e.message;
                console.error("[Holaf Terminal] Failed to save settings. Status:", status, "Msg:", msg);
            }
        }, 750);
    },
    createTerminalView() {
        const wrapper = document.createElement("div");
        wrapper.className = "holaf-terminal-view-wrapper";
        this._xterm_container = document.createElement("div");
        wrapper.appendChild(this._xterm_container);
        return wrapper;
    },
    createLoadingView() {
        const v = document.createElement("div");
        v.className = "holaf-terminal-non-terminal-view";
        v.textContent = t("term.checkingStatus");
        return v;
    },
    createReconnectView() {
        const view = document.createElement("div");
        view.className = "holaf-terminal-non-terminal-view";
        this.reconnectStatusMessage = document.createElement("p");
        this.reconnectStatusMessage.className = "holaf-terminal-status-message";
        this.reconnectStatusMessage.style.marginBottom = "10px";
        const connectButton = document.createElement("button");
        connectButton.textContent = t("term.connect");
        connectButton.className = "comfy-button";
        connectButton.addEventListener("click", () => this.connect());
        view.append(this.reconnectStatusMessage, connectButton);
        return view;
    },
    // No application auth: the terminal opens directly (access is enforced by
    // the reverse-proxy in front of ComfyUI).
    async connect() {
        this.connectWebSocket();
    },
    showView(viewName) {
        if (!this.contentContainer) { console.error("[Holaf Terminal] showView: contentContainer is null!"); return; }
        const views = {
            loading: this.loadingView, reconnect: this.reconnectView,
            terminal: this.terminalContainer
        };
        for (const vName in views) {
            if (views[vName]) {
                views[vName].style.display = (vName === viewName) ? (viewName === 'terminal' ? 'flex' : 'block') : 'none';
            }
        }
        if (viewName === 'terminal') {
            requestAnimationFrame(() => this.fitTerminal());
        }
    },
    async checkServerStatus() {
        this.showView('loading');
        try {
            // HolafFetch lève sur non-2xx (→ catch : « cantContactServer »).
            const d = await HolafFetch.get("/holaf/utilities/settings");
            if (d.TerminalUI) {
                const validTheme = HOLAF_THEMES.find(t => t.name === d.TerminalUI.theme);
                this.settings.theme = validTheme ? d.TerminalUI.theme : HOLAF_THEMES[0].name;

                this.settings.fontSize = d.TerminalUI.font_size || this.settings.fontSize;
                this.settings.panel_x = d.TerminalUI.panel_x;
                this.settings.panel_y = d.TerminalUI.panel_y;
                this.settings.panel_width = d.TerminalUI.panel_width || this.settings.panel_width;
                this.settings.panel_height = d.TerminalUI.panel_height || this.settings.panel_height;
                this.settings.panel_is_fullscreen = !!d.TerminalUI.panel_is_fullscreen;

                this.applySettings();
            }
            this.connect();
        } catch (e) {
            console.error("[Holaf Terminal] Error checking server status:", e);
            if (this.loadingView) this.loadingView.textContent = t("term.cantContactServer");
        }
    },

    // --- Session lifecycle helpers -----------------------------------------
    // Tear down the current xterm instance so the next connection gets a
    // pristine terminal bound to the fresh PTY (never a stale buffer).
    disposeTerminal() {
        if (this.terminal) {
            try { this.terminal.dispose(); } catch (e) { }
            this.terminal = null;
        }
        this.fitAddon = null;
        if (this._xterm_container) {
            try { this._xterm_container.innerHTML = ""; } catch (e) { }
        }
    },
    // Detach every handler BEFORE closing/replacing a socket: late onclose /
    // onerror events from a dying socket used to run against the NEW socket's
    // state and null it out, leaving a live-looking but dead terminal.
    closeSocket() {
        const s = this.socket;
        this.socket = null;
        if (!s) return;
        s.onopen = null; s.onmessage = null; s.onclose = null; s.onerror = null;
        if (s.readyState !== WebSocket.CLOSED) {
            try { s.close(); } catch (e) { }
        }
    },
    // The server told us the shell exited (Ctrl+D / 'exit' / crash) or the
    // socket dropped. Reset all session state and show the reconnect screen;
    // the next connect opens a brand-new WebSocket + fresh PTY.
    handleSessionEnded() {
        this.closeSocket();
        this.disposeTerminal();
        if (this.panelElements && this.panelElements.panelEl.style.display === 'flex') {
            if (this.reconnectStatusMessage) this.reconnectStatusMessage.textContent = t("term.sessionEnded");
            this.showView('reconnect');
        }
    },
    // ------------------------------------------------------------------------

    async connectWebSocket() {
        const scriptsReady = await this.ensureScriptsLoaded();
        if (!scriptsReady) {
            this.showView('loading');
            if (this.loadingView) this.loadingView.textContent = t("term.wsScriptsLoadError");
            return;
        }

        try {
            const currentThemeConfig = HOLAF_THEMES.find(t => t.name === this.settings.theme) || HOLAF_THEMES[0];

            if (!window.Terminal || !window.FitAddon) {
                console.error("[Holaf Terminal] xterm.js or FitAddon not loaded!");
                if (this.loadingView) this.loadingView.textContent = t("term.terminalLibNotLoaded");
                this.showView('loading'); return;
            }

            // Always start from a pristine xterm: the previous instance was
            // attached to a PTY that may be gone, and its buffer holds the old
            // session. Reusing it after a reconnect is what produced "dead"
            // terminals full of leftover output.
            this.disposeTerminal();
            this.terminal = new window.Terminal({
                cursorBlink: true, fontSize: this.settings.fontSize,
                theme: {
                    background: currentThemeConfig.colors.backgroundPrimary,
                    foreground: currentThemeConfig.colors.textPrimary,
                    cursor: currentThemeConfig.colors.cursor,
                    selectionBackground: currentThemeConfig.colors.selectionBackground
                },
                fontFamily: "monospace", rows: 24,
            });
            this.fitAddon = new window.FitAddon.FitAddon();
            this.terminal.loadAddon(this.fitAddon);

            if (!this._xterm_container || !this._xterm_container.isConnected) {
                console.error("[Holaf Terminal] _xterm_container is not ready for terminal.open().");
                if (this.loadingView) this.loadingView.textContent = t("term.terminalContainerNotReady");
                this.showView('loading'); return;
            }
            this.terminal.open(this._xterm_container);
            // Keyboard input travels as BINARY frames; TEXT frames are reserved
            // for JSON control messages ({resize} / {type:'session-ended'}). This
            // prevents keystrokes that happen to parse as JSON from being
            // swallowed by the server-side control parser.
            const encoder = new TextEncoder();
            this.terminal.onData(data => { if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.send(encoder.encode(data)); });
            this.terminal.attachCustomKeyEventHandler(e => { if (e.ctrlKey && (e.key === 'c' || e.key === 'C') && e.type === 'keydown') { if (this.terminal.hasSelection()) { try { navigator.clipboard.writeText(this.terminal.getSelection()); } catch (err) { } return false; } } if (e.ctrlKey && (e.key === 'v' || e.key === 'V') && e.type === 'keydown') { try { navigator.clipboard.readText().then(text => { if (text && this.terminal) this.terminal.paste(text); }); } catch (err) { } return false; } return true; });
        } catch (e) {
            console.error("Holaf Utilities: Terminal component instantiation error", e);
            if (this.loadingView) this.loadingView.textContent = t("term.terminalCreationFailed");
            this.showView('loading'); return;
        }

        await new Promise(resolve => requestAnimationFrame(resolve));
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${protocol}//${window.location.host}/holaf/terminal`;

        this.closeSocket(); // Detach + drop any previous socket first.
        // Per-connection flag: set when the server explicitly announced the end
        // of the session ('session-ended' TEXT control frame). onclose uses it
        // to tell a clean end-of-session apart from a bare network drop.
        let sessionEndedReceived = false;
        const socket = new WebSocket(url);
        this.socket = socket;
        socket.binaryType = 'arraybuffer';

        // Every handler below starts with a stale-event guard: if `this.socket`
        // no longer points at THIS socket, the event belongs to a connection
        // that was replaced and must be ignored entirely.
        socket.onopen = () => {
            if (this.socket !== socket) return;
            this.showView('terminal');
            requestAnimationFrame(() => {
                if (this.socket !== socket || !this.terminal) return;
                this.fitTerminal();
                this.terminal.focus();
                setTimeout(() => {
                    if (this.socket !== socket || !this.terminal) return;
                    if (this.panelElements.panelEl.style.display === 'flex') {
                        this.fitTerminal();
                    }
                }, 100);
            });
        };
        socket.onmessage = (event) => {
            if (this.socket !== socket || !this.terminal) return;
            try {
                if (typeof event.data === 'string') {
                    // TEXT = control channel only.
                    let msg = null;
                    try { msg = JSON.parse(event.data); } catch (e) { msg = null; }
                    if (msg && msg.type === 'session-ended') {
                        sessionEndedReceived = true;
                        this.handleSessionEnded();
                        return;
                    }
                    // Unknown control message: ignore (never printed into the shell).
                    return;
                }
                this.terminal.write(new Uint8Array(event.data));
            } catch (e) { console.warn("[Holaf Terminal] Error writing to terminal:", e); }
        };
        socket.onclose = (event) => {
            if (this.socket !== socket) return; // Stale event (replaced/session-ended)
            this.socket = null;
            if (!sessionEndedReceived) {
                // FIX: no 'session-ended' control frame arrived (network drop,
                // server restart, proxy timeout...). Reset to a pristine
                // reconnect view instead of leaving a dead terminal bound to a
                // gone PTY: the leftover writeln used to produce "dead"
                // terminals that a reconnect could not revive.
                console.warn("[Holaf Terminal] WebSocket closed without 'session-ended'; resetting session.");
                this.handleSessionEnded();
            }
        };
        socket.onerror = (event) => {
            if (this.socket !== socket) return;
            console.error("Holaf Utilities: Terminal WebSocket error.", event);
            if (this.terminal) { try { this.terminal.writeln("\r\n\r\n" + t("term.connectionError")); } catch (e) { } }
            // No reset here: the close event always follows and performs it.
        };
    },

    fitTerminal() {
        if (this.terminal && this.fitAddon &&
            this.panelElements && this.panelElements.panelEl.style.display === 'flex' &&
            this._xterm_container && this._xterm_container.offsetWidth > 10 && this._xterm_container.offsetHeight > 10 &&
            this._xterm_container.isConnected) {
            try {
                this.fitAddon.fit();
                const dims = this.fitAddon.proposeDimensions();
                if (dims && this.socket && this.socket.readyState === WebSocket.OPEN) {
                    this.socket.send(JSON.stringify({ resize: [dims.rows, dims.cols] }));
                }
            } catch (e) {
                console.error("[Holaf Terminal FIT] Error during fitAddon.fit():", e);
            }
        }
    },
    setTheme(themeName, doSave = true) {
        const themeConfig = HOLAF_THEMES.find(t => t.name === themeName);
        if (!themeConfig) {
            console.warn(`[Holaf Terminal] Theme '${themeName}' not found. Defaulting to ${HOLAF_THEMES[0].name}`);
            this.setTheme(HOLAF_THEMES[0].name, doSave);
            return;
        }

        this.settings.theme = themeName;

        if (this.terminal) {
            this.terminal.options.theme = {
                background: themeConfig.colors.backgroundPrimary,
                foreground: themeConfig.colors.textPrimary,
                cursor: themeConfig.colors.cursor,
                selectionBackground: themeConfig.colors.selectionBackground,
            };
        }

        if (this.panelElements && this.panelElements.panelEl) {
            HOLAF_THEMES.forEach(t => {
                if (this.panelElements.panelEl.classList.contains(t.className)) {
                    this.panelElements.panelEl.classList.remove(t.className);
                }
            });
            this.panelElements.panelEl.classList.add(themeConfig.className);
        }

        if (doSave) this.saveSettings({ theme: themeName });
    },
    increaseFontSize() {
        if (this.settings.fontSize < 30) {
            this.settings.fontSize++;
            if (this.terminal) this.terminal.options.fontSize = this.settings.fontSize;
            this.fitTerminal();
            this.saveSettings({ font_size: this.settings.fontSize });
        }
    },
    decreaseFontSize() {
        if (this.settings.fontSize > 6) {
            this.settings.fontSize--;
            if (this.terminal) this.terminal.options.fontSize = this.settings.fontSize;
            this.fitTerminal();
            this.saveSettings({ font_size: this.settings.fontSize });
        }
    },
};

// Expose the object on the app for the static menu to find
app.holafTerminal = holafTerminal;

app.registerExtension({
    name: "Holaf.Terminal.Panel",
    async setup() {
        holafTerminal.init();
    }
});