/*
    * Copyright (C) 2026 Holaf
    * Holaf Utilities - Remote Comparer
    *
    * Provides a floating UI overlay to compare two images, videos, or audio tracks.
    * Features: Drag, Resize, Fullscreen, Pop-out, Pan & Zoom, Audio Crossfader.
    * Node Preview: Hidden in graph, visible only in Remote Comparer.
    * Universal Media: Handles AnyType (*) input with isolated Holaf Payload.
    */

import { app, api } from "./holaf_api_compat.js";
import { makeDraggable, makeResizable, makeContentZoomable, aihWindowManager } from "./holaf_window_utils.js";
import { HolafFetch } from "./vendor/holaf/holaf-fetch.js";
import { HolafViewport } from "./vendor/holaf/holaf-viewport.js";

// Helper i18n central : traduit via AIH.I18n (clé brute si absente).
const t = (key, params) => {
    const I = window.AIH && window.AIH.I18n;
    return I && typeof I.t === "function" ? I.t(key, params) : key;
};

const COMPARER_CHANNEL = 'holaf_comparer_bridge';
const COMPARER_STANDALONE_HEARTBEAT_MS = 2500;
const COMPARER_STANDALONE_TIMEOUT_MS = 10000;
const COMPARER_STANDALONE_HEARTBEAT_KEY = 'holaf_comparer_standalone_heartbeat';

const HolafRemoteComparer = {
    name: "Holaf.RemoteComparer",
    isOpen: false,
    isFullscreen: false,
    isPoppedOut: false,
    isStandalone: false,
    isSidebarOpen: true,
    _standaloneOpen: false,
    _standaloneTimeout: null,
    _standaloneHeartbeatInterval: null,
    _bridge: null,
    _popupTab: null,

    // --- DOM Elements ---
    rootElement: null,
    mainContainer: null,
    sidebarElement: null,
    sidebarHistoryContainer: null,
    sidebarBottomContainer: null,
    contentElement: null,
    canvasEl: null,
    ctx: null,
    statusTextEl: null,
    popupWindow: null,
    floatingSidebarBtn: null,
    floatingPopoutBtn: null,
    floatingPopinBtn: null,

    // UI Control Elements
    uiControls: {
        container: null,
        playBtn: null,
        timeline: null,
        frameCount: null,
        fpsSlider: null,
        fpsInput: null,
        settingsForm: {}
    },

    // --- Comparison & History State ---
    history: [], 
    latestImagesMeta: [],
    currentImagesMeta: [], 
    currentViewName: "latest",
    images: [], // Holds HTMLImageElement, HTMLVideoElement, or HTMLAudioElement
    mouseX: null,      // Scaled mouse X (for image pan/zoom clipping)
    rawMouseX: null,   // Raw canvas mouse X (for audio volume crossfading)
    isMouseOver: false,
    rafId: null,

    // --- Player State ---
    playbackState: {
        isPlaying: true,
        fps: 24,
        maxDuration: 0
    },
    isDraggingTimeline: false,

    // --- Global Settings Bridge ---
    globalSettings: {
        video_res: "0",
        video_speed: "ultrafast",
        image_format: "WEBP"
    },

    // --- Pan & Zoom State ---
    // VAGUE 8 : la géométrie (fit/zoom/pan) vit dans la brique HolafViewport
    // (mode headless). `vp` est l'instance ; `zoomState` maison est supprimé.
    vp: null,
    isPanning: false,

    // --- Window State ---
    storedPos: {
        right: 50, bottom: 50, width: 850, height: 500
    },
    STORAGE_KEY: "holaf_remote_comparer_state_v2",

    init() {
        this.isStandalone = window.location.pathname === '/holaf/comparer';

        this.restoreState();

        // --- BroadcastChannel bridge ---
        this._bridge = new BroadcastChannel(COMPARER_CHANNEL);

        if (this.isStandalone) {
            // Standalone tab: listen for payloads from the main ComfyUI tab
            this._bridge.onmessage = (event) => {
                const { type, payload } = event.data;
                if (type === 'COMPARER_PAYLOAD') {
                    const compName = payload.comparison_name || t("rc.unnamed");
                    const mediaMeta = payload.media || [];
                    if (mediaMeta.length === 0) return;
                    this.latestImagesMeta = mediaMeta;
                    this.history = this.history.filter(h => h.name !== compName);
                    this.history.unshift({ name: compName, imagesMeta: mediaMeta });
                    this.renderSidebarHistory();
                    this.statusTextEl.style.display = "none";
                    if (!this.isOpen) this.show();
                    this.resetZoom();
                    this.loadMedia(mediaMeta).then(() => this.draw());
                }
                if (type === 'COMPARER_HISTORY') {
                    this.history = payload.history || [];
                    this.latestImagesMeta = payload.latestImagesMeta || [];
                    this.renderSidebarHistory();
                }
                if (type === 'COMPARER_SETTINGS') {
                    this.globalSettings = { ...this.globalSettings, ...payload };
                    this.syncSettingsToBackend();
                }
            };
        } else {
            // Main tab: detect an already-running standalone comparer via heartbeat
            const lastHeartbeat = parseInt(localStorage.getItem(COMPARER_STANDALONE_HEARTBEAT_KEY) || "0", 10);
            if (lastHeartbeat && Date.now() - lastHeartbeat < COMPARER_STANDALONE_TIMEOUT_MS) {
                this._markStandaloneOpen();
            }

            // Main tab: relay executed events to the standalone comparer tab
            api.addEventListener("executed", (e) => this.handleNodeExecution(e));

            this._bridge.onmessage = (event) => {
                const { type } = event.data;
                // If standalone tab requests current state, send it
                if (type === 'COMPARER_REQUEST_STATE') {
                    this._markStandaloneOpen();
                    this._bridge.postMessage({
                        type: 'COMPARER_HISTORY',
                        payload: {
                            history: this.history,
                            latestImagesMeta: this.latestImagesMeta
                        }
                    });
                }
                // Standalone heartbeat keeps the detached state alive
                if (type === 'COMPARER_STANDALONE_OPEN') {
                    this._markStandaloneOpen();
                }
                // If standalone tab closed, restore the in-page comparer only if still open
                if (type === 'COMPARER_STANDALONE_CLOSED') {
                    this._standaloneOpen = false;
                    this.isPoppedOut = false;
                    if (this._standaloneTimeout) {
                        clearTimeout(this._standaloneTimeout);
                        this._standaloneTimeout = null;
                    }
                    this._popupTab = null;
                    this.floatingPopoutBtn.style.display = "flex";
                    this.floatingPopinBtn.style.display = "none";
                    if (this.isOpen) {
                        this.rootElement.style.display = "flex";
                        this.updateVisualPosition();
                    }
                }
            };
        }

        this.buildUI();

        window.addEventListener("resize", () => {
            if (!this.isFullscreen && !this.isPoppedOut && !this.isStandalone) {
                this.updateVisualPosition();
            }
        });

        // Sync initial settings to backend
        this.syncSettingsToBackend();

        if (this.isStandalone) {
            // In standalone mode, show immediately and request state from main tab
            this.show();
            this._bridge.postMessage({ type: 'COMPARER_REQUEST_STATE' });
        } else if (this.isOpen) {
            setTimeout(() => this.show(), 300);
        }
        console.log("[Holaf Remote Comparer] Initialized." + (this.isStandalone ? " (Standalone mode)" : ""));
    },

    // --- SETTINGS BRIDGE LOGIC ---

    syncSettingsToBackend() {
        // Ne PAS extraire api.fetchApi dans une variable : c'est une méthode qui
        // utilise `this` (ex. this.user) → this serait perdu (undefined).
        // On l'appelle toujours en tant que méthode de `api` pour préserver le contexte.
        // Vague 4 : seule la branche de repli (fetch natif) migre vers HolafFetch
        // (sérialisation/erreurs blindées) ; api.fetchApi reste prioritaire —
        // c'est LA référence quand l'API ComfyUI est présente (contexte this.user).
        // Le body stringifié passe tel quel dans les deux branches (corps brut
        // pour HolafFetch, format natif pour api.fetchApi).
        const doFetch = (url, opts) => (api.fetchApi ? api.fetchApi(url, opts) : HolafFetch.post(url, opts));
        doFetch("/holaf/comparer/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(this.globalSettings)
        }).catch(e => console.error("[Holaf Remote Comparer] Settings sync failed:", e));
    },

    updateSetting(key, value) {
        this.globalSettings[key] = value;
        this.saveState();
        this.syncSettingsToBackend();
    },

    // --- UI CONSTRUCTION ---

    buildUI() {
        if (this.rootElement) return;

        if (this.isStandalone) {
            document.body.classList.add('holaf-standalone-comparer');
        }

        this.rootElement = document.createElement("div");
        this.rootElement.id = "holaf-remote-comparer-root";
        this.rootElement.classList.add("holaf-floating-window");
        Object.assign(this.rootElement.style, {
            display: "none", position: "fixed", zIndex: "1000",
            fontFamily: "sans-serif", boxSizing: "border-box", overflow: "hidden",
            flexDirection: "column",
            transition: "border-radius 0.2s ease"
        });

        // Header
        const header = document.createElement("div");
        header.className = "holaf-utility-header";
        header.style.cursor = "move";
        header.style.boxSizing = "border-box";

        const title = document.createElement("span");
        title.innerText = t("rc.title");
        Object.assign(title.style, { flex: "1", fontWeight: "bold", fontSize: "12px", userSelect: "none", pointerEvents: "none" });

        const btnContainer = document.createElement("div");
        Object.assign(btnContainer.style, { display: "flex", gap: "12px" });

        const closeBtn = document.createElement("button");
        closeBtn.innerText = "✕";
        closeBtn.title = t("dialog.close");
        closeBtn.className = "holaf-utility-close-button";
        // Hover handled by CSS
        closeBtn.onmousedown = (e) => e.stopPropagation();
        closeBtn.onclick = () => this.hide();
        if (this.isStandalone) closeBtn.style.display = "none";

        btnContainer.appendChild(closeBtn);
        header.appendChild(title);
        header.appendChild(btnContainer);

        header.addEventListener('dblclick', (e) => {
            if (e.target.tagName === "BUTTON" || e.target.closest("button")) return;
            this.toggleFullscreen();
        });

        // Main Container
        this.mainContainer = document.createElement("div");
        this.mainContainer.classList.add("holaf-zoom-content");
        Object.assign(this.mainContainer.style, {
            flex: "1", display: "flex", flexDirection: "row", overflow: "hidden", width: "100%", height: "100%"
        });

        // Sidebar
        this.sidebarElement = document.createElement("div");
        this.sidebarElement.className = "holaf-rc-sidebar";
        Object.assign(this.sidebarElement.style, {
            display: "flex", flexDirection: "column",
            overflow: "hidden", flexShrink: "0", transition: "width 0.2s ease", userSelect: "none"
        });

        this.sidebarHistoryContainer = document.createElement("div");
        this.sidebarHistoryContainer.className = "holaf-rc-sidebar-history";
        Object.assign(this.sidebarHistoryContainer.style, { flex: "1", overflowY: "auto", overflowX: "hidden" });

        this.sidebarBottomContainer = document.createElement("div");
        this.sidebarBottomContainer.className = "holaf-rc-sidebar-bottom";
        Object.assign(this.sidebarBottomContainer.style, {
            flexShrink: "0", display: "flex", flexDirection: "column", boxSizing: "border-box"
        });

        this.sidebarElement.appendChild(this.sidebarHistoryContainer);
        this.sidebarElement.appendChild(this.sidebarBottomContainer);

        // Content Area
        this.contentElement = document.createElement("div");
        this.contentElement.className = "holaf-rc-content";
        Object.assign(this.contentElement.style, {
            flex: "1", position: "relative", display: "flex",
            justifyContent: "center", alignItems: "center", overflow: "hidden", height: "100%"
        });

        // Floating Buttons
        this.floatingSidebarBtn = document.createElement("button");
        this.floatingSidebarBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3 3h18v18H3V3zm16 16V5H9v14h10z"/></svg>`;
        this.floatingSidebarBtn.className = "holaf-rc-float-btn";
        Object.assign(this.floatingSidebarBtn.style, {
            position: "absolute", top: "10px", left: "10px", zIndex: "100",
            display: "flex", alignItems: "center", justifyContent: "center"
        });
        this.floatingSidebarBtn.onclick = () => this.toggleSidebar();

        this.floatingPopoutBtn = document.createElement("button");
        this.floatingPopoutBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 19H5V5h7V3H5a2 2 0 00-2 2v14a2 2 0 002 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>`;
        this.floatingPopoutBtn.className = "holaf-rc-float-btn";
        Object.assign(this.floatingPopoutBtn.style, {
            position: "absolute", top: "10px", right: "10px", zIndex: "100",
            display: this.isStandalone ? "none" : "flex", alignItems: "center", justifyContent: "center"
        });
        this.floatingPopoutBtn.onclick = () => this.popOut();

        this.floatingPopinBtn = document.createElement("button");
        this.floatingPopinBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>`;
        this.floatingPopinBtn.className = "holaf-rc-float-btn";
        Object.assign(this.floatingPopinBtn.style, {
            position: "absolute", top: "10px", right: "10px", zIndex: "100",
            display: "none", alignItems: "center", justifyContent: "center"
        });
        this.floatingPopinBtn.onclick = () => this.popIn();

        this.statusTextEl = document.createElement("div");
        this.statusTextEl.className = "holaf-rc-status-text";
        Object.assign(this.statusTextEl.style, {
            position: "absolute", pointerEvents: "none", userSelect: "none", zIndex: "10"
        });
        this.statusTextEl.innerText = t("rc.waiting");

        this.canvasEl = document.createElement("canvas");
        Object.assign(this.canvasEl.style, {
            display: "block", cursor: "crosshair", width: "100%", height: "100%", transformOrigin: "0 0"
        });
        this.ctx = this.canvasEl.getContext("2d");

        this.contentElement.appendChild(this.floatingSidebarBtn);
        this.contentElement.appendChild(this.floatingPopoutBtn);
        this.contentElement.appendChild(this.floatingPopinBtn);
        this.contentElement.appendChild(this.statusTextEl);
        this.contentElement.appendChild(this.canvasEl);

        this.mainContainer.appendChild(this.sidebarElement);
        this.mainContainer.appendChild(this.contentElement);

        // Boutons zoom standard (− / +) : appliqués au contenu (hors header),
        // persistés sous la clé de fenêtre du comparateur.
        const zoomGroup = makeContentZoomable(this.mainContainer, { key: this.STORAGE_KEY });
        header.insertBefore(zoomGroup, btnContainer);

        this.createResizeHandles();
        if (this.isStandalone) this.setResizeHandlesVisible(false);
        this.buildBottomSidebar();

        this.rootElement.appendChild(header);
        this.rootElement.appendChild(this.mainContainer);
        // Resize handles are already appended inside createResizeHandles()

        document.body.appendChild(this.rootElement);

        // VAGUE 8 : délégation à la brique HolafViewport (mode HEADLESS).
        // Le canvas est le conteneur (PAS de content) : la brique ne fait que la
        // géométrie (fit/zoom/pan), l'hôte dessine via getTransform(). Le fit est
        // DANS le transform (scale absolu = containScale). La taille image est posée
        // par setImageSize() au chargement des médias (voir loadMedia).
        this.vp = HolafViewport.create(this.canvasEl, {
            minZoom: 'fit',        // clamp bas = fit (containScale), ↔ ancien min 1
            maxZoom: 30,           // ↔ ancien clamp haut
            zoomFactor: 1.1,       // ↔ ancien pas de wheel
            panClamp: true,        // l'image ne quitte jamais la vue
            // dblclick maison (parité : zoom-to-natural-size clamp [2,30] ou reset),
            // PAS le ×1.21 par défaut de la brique → on le désactive ici.
            doubleClickZoom: false,
            drag: true,
            dragButton: 0,         // ↔ ancien : clic gauche uniquement
            // canDrag : pas de pan au fit (parité avec l'ancien `scale <= 1 → return`)
            // et jamais depuis un bouton flottant.
            canDrag: (e) => {
                if (e.target && e.target.closest && e.target.closest("button")) return false;
                return this.vp.getScale() > this.vp.getFitScale() + 1e-6;
            },
        });

        this.enableWindowDragging(header);
        this.attachCanvasListeners();
        this.renderSidebarHistory();
        this.updateVisualPosition();

        const resizeObserver = new ResizeObserver(() => this.resizeCanvas());
        resizeObserver.observe(this.contentElement);
    },

    buildBottomSidebar() {
        // 0. Settings Bridge Encart
        const settingsContainer = document.createElement("div");
        settingsContainer.className = "holaf-rc-settings-container";
        Object.assign(settingsContainer.style, {
            display: "flex", flexDirection: "column", gap: "6px", padding: "8px 10px",
            fontSize: "10px"
        });

        const createSelect = (label, key, options) => {
            const row = document.createElement("div");
            Object.assign(row.style, { display: "flex", justifyContent: "space-between", alignItems: "center" });
            
            const lbl = document.createElement("span");
            lbl.innerText = label;
            
            const sel = document.createElement("select");
            sel.className = "holaf-rc-settings-select";
            Object.assign(sel.style, { 
                fontSize: "10px", padding: "2px", width: "70px"
            });
            
            options.forEach(opt => {
                const o = document.createElement("option");
                o.value = opt.value; o.innerText = opt.text;
                if (this.globalSettings[key] === opt.value) o.selected = true;
                sel.appendChild(o);
            });

            sel.onchange = (e) => this.updateSetting(key, e.target.value);
            
            row.appendChild(lbl);
            row.appendChild(sel);
            return row;
        };

        settingsContainer.appendChild(createSelect(t("rc.imageFormat"), "image_format", [
            {value: "WEBP", text: "WEBP"}, {value: "PNG", text: "PNG"}, {value: "JPEG", text: "JPEG"}
        ]));
        settingsContainer.appendChild(createSelect(t("rc.videoRes"), "video_res", [
            {value: "0", text: t("rc.original")}, {value: "1024", text: "1024px"}, {value: "720", text: "720px"}, {value: "512", text: "512px"}
        ]));
        settingsContainer.appendChild(createSelect(t("rc.videoSpeed"), "video_speed", [
            {value: "ultrafast", text: t("rc.ultrafast")}, {value: "fast", text: t("rc.fast")}, {value: "medium", text: t("rc.medium")}
        ]));

        this.sidebarBottomContainer.appendChild(settingsContainer);

        // 1. Playback Controls Container
        const controls = document.createElement("div");
        controls.className = "holaf-rc-controls";
        Object.assign(controls.style, {
            display: "none", boxSizing: "border-box"
        });
        this.uiControls.container = controls;

        const row1 = document.createElement("div");
        Object.assign(row1.style, { display: "flex", alignItems: "center", gap: "6px", width: "100%" });

        const playBtn = document.createElement("button");
        playBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
        playBtn.className = "holaf-rc-play-btn";
        playBtn.onclick = () => {
            const mediaEls = this.images.filter(m => m instanceof HTMLMediaElement);
            const isPlaying = mediaEls.some(m => !m.paused);
            mediaEls.forEach(m => isPlaying ? m.pause() : m.play());
        };
        this.uiControls.playBtn = playBtn;

        const timeline = document.createElement("input");
        timeline.type = "range"; timeline.min = 0; timeline.max = 1000; timeline.value = 0;
        Object.assign(timeline.style, { flex: "1", cursor: "pointer", minWidth: "0", width: "100%" });
        
        timeline.oninput = (e) => {
            this.isDraggingTimeline = true;
            const percent = parseInt(e.target.value, 10) / 1000;
            this.images.forEach(m => {
                if (m instanceof HTMLMediaElement && m.duration) {
                    m.currentTime = percent * this.playbackState.maxDuration;
                }
            });
            this.draw();
        };
        timeline.onchange = () => this.isDraggingTimeline = false;
        this.uiControls.timeline = timeline;

        const frameCount = document.createElement("span");
        frameCount.className = "holaf-rc-frame-count";
        Object.assign(frameCount.style, { width: "35px", textAlign: "right", flexShrink: "0" });
        frameCount.innerText = "0:00";
        this.uiControls.frameCount = frameCount;

        row1.appendChild(playBtn);
        row1.appendChild(timeline);
        row1.appendChild(frameCount);
        controls.appendChild(row1);
        this.sidebarBottomContainer.appendChild(controls);

        // 2. Actions Container
        const actionsContainer = document.createElement("div");
        actionsContainer.className = "holaf-rc-actions";

        const baseBtnStyle = {
            padding: "8px", cursor: "pointer", textAlign: "center", fontSize: "12px", fontWeight: "bold", 
            backgroundColor: "color-mix(in srgb, var(--holaf-background-secondary) 50%, transparent)", transition: "background-color 0.1s ease", display: "flex",
            alignItems: "center", justifyContent: "center", borderRadius: "2px"
        };

        const clearBtn = document.createElement("div");
        clearBtn.innerText = t("rc.clear");
        clearBtn.className = "holaf-rc-action-btn holaf-rc-clear-btn";
        Object.assign(clearBtn.style, { flex: "1" });
        clearBtn.onclick = () => this.clearHistory();

        const createSaveBtn = (label, index) => {
            const btn = document.createElement("div");
            btn.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style="margin-right:4px"><path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg>${label}`;
            btn.className = "holaf-rc-action-btn holaf-rc-save-btn";
            Object.assign(btn.style, { width: "35px" });
            btn.onclick = () => this.saveImage(index);
            return btn;
        };

        actionsContainer.appendChild(clearBtn);
        actionsContainer.appendChild(createSaveBtn("2", 1));
        actionsContainer.appendChild(createSaveBtn("1", 0));
        this.sidebarBottomContainer.appendChild(actionsContainer);
    },

    // --- STATE & DATA LOGIC ---

    saveState() {
        if (!this.rootElement) return;
        const state = {
            ...this.storedPos,
            isOpen: this.isOpen,
            isSidebarOpen: this.isSidebarOpen,
            settings: this.globalSettings
        };
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(state));
    },

    restoreState() {
        try {
            const saved = localStorage.getItem(this.STORAGE_KEY);
            if (saved) {
                const state = JSON.parse(saved);
                this.storedPos.right = state.right ?? 50;
                this.storedPos.bottom = state.bottom ?? 50;
                this.storedPos.width = state.width ?? 850;
                this.storedPos.height = state.height ?? 500;
                this.isOpen = !!state.isOpen;
                this.isSidebarOpen = state.isSidebarOpen ?? true;
                if (state.settings) {
                    this.globalSettings = { ...this.globalSettings, ...state.settings };
                }
            }
        } catch (e) { }
    },

    isComparerDetached() {
        return this.isPoppedOut || this._standaloneOpen;
    },

    _markStandaloneOpen() {
        this._standaloneOpen = true;
        if (this._standaloneTimeout) {
            clearTimeout(this._standaloneTimeout);
            this._standaloneTimeout = null;
        }
        this._standaloneTimeout = setTimeout(() => {
            this._standaloneTimeout = null;
            this._standaloneOpen = false;
        }, COMPARER_STANDALONE_TIMEOUT_MS);
    },

    _stopStandaloneHeartbeat() {
        if (this._standaloneHeartbeatInterval) {
            clearInterval(this._standaloneHeartbeatInterval);
            this._standaloneHeartbeatInterval = null;
        }
        localStorage.removeItem(COMPARER_STANDALONE_HEARTBEAT_KEY);
    },

    // --- CROSSFADER & INTERACTION ---

    updateVolumes() {
        if (this.images.length === 0) return;
        const width = this.canvasEl ? this.canvasEl.width : 1;
        
        // Default to 0.0 when mouse leaves (Show/Hear ONLY Track A)
        let ratio = 0.0; 
        if (this.rawMouseX !== null && this.isMouseOver) {
            ratio = this.rawMouseX / width;
        }

        // Crossfader Math: Center (0.5) is 1.0 for both. Sides fade opposite track.
        const volA = Math.max(0, Math.min(1, (1 - ratio) * 2));
        const volB = Math.max(0, Math.min(1, ratio * 2));

        if (this.images[0] instanceof HTMLMediaElement) {
            this.images[0].volume = this.images.length > 1 ? volA : 1.0;
        }
        if (this.images.length > 1 && this.images[1] instanceof HTMLMediaElement) {
            this.images[1].volume = volB;
        }
    },

    attachCanvasListeners() {
        // dblclick maison (parité) : zoom-to-natural-size clamp [2,30] au point
        // sous le curseur, ou reset si déjà zoomé. La brique a doubleClickZoom:false.
        this.contentElement.addEventListener("dblclick", (e) => {
            if (e.target.tagName === "BUTTON" || e.target.closest("button")) return;
            if (this.images.length === 0) return;
            const imgA = this.images[0];
            if (!this.isMediaReady(imgA)) return;

            const sizeA = this.getMediaSize(imgA);
            if (sizeA.width === 0) return;

            const { scale } = this.vp.getTransform();
            if (scale > this.vp.getFitScale() + 1e-6) {
                this.vp.fit();
            } else {
                const width = this.canvasEl.width;
                const height = this.canvasEl.height;
                const imgAspect = sizeA.width / sizeA.height;
                const canvasAspect = width / height;
                let drawWidth = imgAspect > canvasAspect ? width : height * imgAspect;

                // Parité : cible RELATIVE au fit (ancien scale=1), clamp [2,30],
                // convertie en échelle ABSOLUE (fitScale × relatif) pour la brique.
                const relTarget = Math.min(Math.max(sizeA.width / drawWidth, 2), 30);
                const absTarget = this.vp.getFitScale() * relTarget;
                this.vp.setScale(absTarget, e.clientX, e.clientY);
            }
            this.draw();
        });

        this.contentElement.addEventListener("mousemove", (e) => {
            const rect = this.contentElement.getBoundingClientRect();
            this.rawMouseX = e.clientX - rect.left;
            // mouseX image (espace image, origine 0,0) via la brique — la barre de
            // séparation et le clip vivent dans le transform de la brique.
            const imgPt = this.vp.screenToImage(e.clientX, e.clientY);
            this.mouseX = imgPt.x;

            this.updateVolumes();
            if (this.isOpen || this.isPoppedOut) this.draw();
        });

        this.contentElement.addEventListener("mouseenter", () => {
            this.isMouseOver = true;
        });

        this.contentElement.addEventListener("mouseleave", () => {
            this.isMouseOver = false;
            this.mouseX = null;
            this.rawMouseX = null;
            this.updateVolumes();
            if (this.isOpen || this.isPoppedOut) this.draw();
        });

        // isPanning : la brique gère le pan (drag) ; on ne garde ici que le flag
        // (affichage de la barre de séparation pendant un drag) + le curseur.
        this.canvasEl.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return;
            if (e.target.tagName === "BUTTON" || e.target.closest("button")) return;
            if (this.vp.getScale() <= this.vp.getFitScale() + 1e-6) return;
            this.isPanning = true;
            this.canvasEl.style.cursor = 'grabbing';
        });
        window.addEventListener("mouseup", () => {
            if (this.isPanning) {
                this.isPanning = false;
                this.canvasEl.style.cursor = 'crosshair';
            }
        });
    },

    // --- ISOLATED EXECUTION HANDLING ---

    async handleNodeExecution(event) {
        const detail = event.detail;
        if (!detail || !detail.node || !detail.output) return;

        // STRICT ISOLATION: We ONLY process "holaf_payload"
        const payloads = detail.output.ui?.holaf_payload || detail.output.holaf_payload;
        if (!payloads || payloads.length === 0) return;

        const payload = payloads[0];
        const compName = payload.comparison_name || t("rc.unnamed");
        const mediaMeta = payload.media || [];

        if (mediaMeta.length === 0) return;

        // Relay to standalone comparer tab if detached (popped out or standalone open)
        if (this.isComparerDetached()) {
            this._bridge.postMessage({
                type: 'COMPARER_PAYLOAD',
                payload: payload
            });
        }

        this.latestImagesMeta = mediaMeta;
        this.history = this.history.filter(h => h.name !== compName);
        this.history.unshift({ name: compName, imagesMeta: mediaMeta });

        const shouldReload = (this.currentViewName === "latest" || this.currentViewName === compName);
        this.renderSidebarHistory();

        if (shouldReload) {
            this.statusTextEl.style.display = "none";
            if (!this.isOpen && !this.isComparerDetached()) {
                this.show();
                this.saveState();
            }
            this.resetZoom();
            await this.loadMedia(mediaMeta);
            this.draw();
        }
    },

    // --- UNIVERSAL MEDIA LOADER ---

    loadMedia(imagesMeta) {
        return new Promise((resolve) => {
            this.currentImagesMeta = imagesMeta;
            this.stopAnimation();

            // Cleanup
            this.images.forEach(media => {
                if (media instanceof HTMLMediaElement) {
                    media.pause(); media.removeAttribute('src'); media.load();
                }
            });
            this.images = [];
            this.playbackState.maxDuration = 0;
            
            let loadedCount = 0;
            const targetCount = Math.min(imagesMeta.length, 2);

            if (targetCount === 0) {
                this.uiControls.container.style.display = "none";
                resolve();
                return;
            }

            let hasTimelineMedia = false;

            for (let i = 0; i < targetCount; i++) {
                const meta = imagesMeta[i];
                let mediaEl;

                const onMediaReady = () => {
                    loadedCount++;
                    // VAGUE 8 : la taille image (fit) est pilotée par A (index 0).
                    if (i === 0) this.setViewportImageSize(mediaEl);
                    if (mediaEl.duration && mediaEl.duration > this.playbackState.maxDuration) {
                        this.playbackState.maxDuration = mediaEl.duration;
                    }
                    
                    if (loadedCount === targetCount) {
                        if (hasTimelineMedia) {
                            this.uiControls.container.style.display = "flex";
                            this.syncVideos();
                        } else {
                            this.uiControls.container.style.display = "none";
                        }
                        this.checkAndStartAnimation();
                        this.updateVolumes();
                        resolve();
                    }
                };

                const onMediaError = () => {
                    console.error("[Holaf Remote Comparer] Failed to load media:", meta.filename);
                    loadedCount++;
                    if (loadedCount === targetCount) {
                        if (hasTimelineMedia) this.uiControls.container.style.display = "flex";
                        this.checkAndStartAnimation();
                        resolve();
                    }
                };

                if (meta.format === 'video' || meta.format === 'audio') {
                    hasTimelineMedia = true;
                    mediaEl = meta.format === 'video' ? document.createElement("video") : new Audio();
                    mediaEl.autoplay = true;
                    mediaEl.loop = true;
                    mediaEl.playsInline = true;
                    mediaEl.onloadeddata = onMediaReady;
                    mediaEl.onerror = onMediaError;

                    // Timeline Sync (Bind to the first timeline media)
                    if (!this.images.some(m => m instanceof HTMLMediaElement)) {
                        mediaEl.addEventListener('timeupdate', () => {
                            if (!this.isDraggingTimeline && this.playbackState.maxDuration > 0) {
                                this.uiControls.timeline.value = (mediaEl.currentTime / this.playbackState.maxDuration) * 1000;
                                const formatTime = (t) => {
                                    const m = Math.floor(t / 60);
                                    const s = Math.floor(t % 60).toString().padStart(2, '0');
                                    return `${m}:${s}`;
                                };
                                this.uiControls.frameCount.innerText = `${formatTime(mediaEl.currentTime)} / ${formatTime(this.playbackState.maxDuration)}`;
                            }
                        });
                        mediaEl.addEventListener('play', () => this.updatePlaybackUI(true));
                        mediaEl.addEventListener('pause', () => this.updatePlaybackUI(false));
                    }
                } else {
                    mediaEl = new Image();
                    mediaEl.onload = onMediaReady;
                    mediaEl.onerror = onMediaError;
                }

                const params = new URLSearchParams({ filename: meta.filename, type: meta.type, subfolder: meta.subfolder || "" });
                // VAGUE 10 : cache-buster (_t) pour ne jamais servir une version
                // périmée en cache quand le même fichier est régénéré (ex. après
                // un crop qui réécrit le même nom de sortie).
                params.set("_t", String(Date.now()));
                // Use api.apiURL if available, otherwise fallback to a direct URL
                const viewUrl = api.apiURL ? api.apiURL(`/view?${params.toString()}`) : `/view?${params.toString()}`;
                mediaEl.src = viewUrl;

                // Tag the element for rendering logic
                mediaEl._holafFormat = meta.format;
                mediaEl._holafName = meta.filename;
                
                this.images.push(mediaEl);
            }
        });
    },

    // --- RENDER ENGINE ---

    drawMediaItem(ctx, media, x, y, w, h, isA) {
        if (media instanceof HTMLImageElement || media instanceof HTMLVideoElement) {
            ctx.drawImage(media, x, y, w, h);
        } else if (media instanceof window.HTMLAudioElement) {
            // Simplified Audio Canvas Background
            ctx.fillStyle = isA ? "#1a1005" : "#05101a"; 
            ctx.fillRect(x, y, w, h);
            
            ctx.fillStyle = isA ? "rgba(255, 140, 0, 0.2)" : "rgba(0, 168, 255, 0.2)";
            ctx.font = "bold 40px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(`🎵 ${t("rc.audio")} ${isA ? 'A' : 'B'}`, x + w/2, y + h/2);
        }
    },

    drawAudioHUD(ctx, width, height) {
        if (this.images.length === 0) return;
        const imgA = this.images[0];
        const imgB = this.images.length > 1 ? this.images[1] : null;

        const isAudioA = imgA instanceof window.HTMLAudioElement;
        const isAudioB = imgB instanceof window.HTMLAudioElement;

        if (!isAudioA && !isAudioB) return;

        // Reset transform to draw HUD fixed on the screen (immune to zoom/pan/clip)
        ctx.setTransform(1, 0, 0, 1, 0, 0);

        const volA = isAudioA ? (imgA.volume || 0) : 0;
        const volB = isAudioB ? (imgB.volume || 0) : 0;

        const colorA = volA >= volB ? "#ff8c00" : "#888888";
        const colorB = volB >= volA ? "#00a8ff" : "#888888";

        ctx.textBaseline = "top";

        // Track A HUD (Top Left)
        if (isAudioA) {
            ctx.fillStyle = "rgba(15, 15, 15, 0.9)";
            ctx.fillRect(20, 20, 240, 60);
            
            ctx.fillStyle = colorA;
            ctx.textAlign = "left";
            ctx.font = "bold 13px sans-serif";
            const nameA = imgA._holafName ? imgA._holafName.replace(/^holaf_remote_cmp_[AB]_.*?_/, '') : t("rc.unknownTrack");
            ctx.fillText(`🎵 A: ${nameA}`, 35, 30);
            
            ctx.fillStyle = "#333";
            ctx.fillRect(35, 55, 180, 8);
            ctx.fillStyle = colorA;
            ctx.fillRect(35, 55, 180 * volA, 8);
            
            ctx.fillStyle = "#fff";
            ctx.font = "10px monospace";
            ctx.fillText(`${Math.round(volA * 100)}%`, 225, 53);
        }

        // Track B HUD (Top Right)
        if (isAudioB) {
            ctx.fillStyle = "rgba(15, 15, 15, 0.9)";
            ctx.fillRect(width - 260, 20, 240, 60);
            
            ctx.fillStyle = colorB;
            ctx.textAlign = "right";
            ctx.font = "bold 13px sans-serif";
            const nameB = imgB._holafName ? imgB._holafName.replace(/^holaf_remote_cmp_[AB]_.*?_/, '') : t("rc.unknownTrack");
            ctx.fillText(`🎵 B: ${nameB}`, width - 35, 30);
            
            ctx.fillStyle = "#333";
            ctx.fillRect(width - 215, 55, 180, 8);
            ctx.fillStyle = colorB;
            ctx.fillRect(width - 35 - (180 * volB), 55, 180 * volB, 8); // Draw right to left
            
            ctx.fillStyle = "#fff";
            ctx.font = "10px monospace";
            ctx.fillText(`${Math.round(volB * 100)}%`, width - 225, 53);
        }
    },

    draw() {
        if (!this.ctx || !this.canvasEl) return;
        const width = this.canvasEl.width;
        const height = this.canvasEl.height;

        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.clearRect(0, 0, width, height);

        if (this.images.length === 0) return;

        const imgA = this.images[0];
        const imgB = this.images.length > 1 ? this.images[1] : null;

        if (!this.isMediaReady(imgA)) return;
        const sizeA = this.getMediaSize(imgA);
        
        // Audio has no intrinsic size, force a virtual 16:9 canvas
        const baseW = sizeA.width > 0 ? sizeA.width : 1280;
        const baseH = sizeA.height > 0 ? sizeA.height : 720;

        // VAGUE 8 : le fit vit DANS le transform de la brique (headless, scale
        // absolu = containScale). On applique exactement getTransform() — A et B
        // partagent le MÊME transform (fit commun, parité avec l'ancien draw qui
        // dessinait les deux médias dans la même boîte contain de A).
        const { scale, tx, ty } = this.vp.getTransform();
        this.ctx.translate(tx, ty);
        this.ctx.scale(scale, scale);

        // Draw Background (A) — boîte image complète (0,0,baseW,baseH)
        this.drawMediaItem(this.ctx, imgA, 0, 0, baseW, baseH, true);

        if (!imgB || !this.isMediaReady(imgB)) {
            this.drawAudioHUD(this.ctx, width, height);
            return;
        }

        // VAGUE 10 : B est letterboxé (contain centré) dans la boîte commune de
        // A. L'ancien code (et la migration vague 8) dessinait B étiré dans la
        // boîte de A → quand A et B ont des ratios différents (ex. une des deux
        // versions a été cropée), B était étiré. Chaque média garde son aspect.
        const sizeB = this.getMediaSize(imgB);
        const bRect = this._containRect(sizeB.width, sizeB.height, 0, 0, baseW, baseH);

        // Draw Foreground Split (B)
        if ((this.isMouseOver || this.isPanning) && this.mouseX !== null) {
            this.ctx.save();
            this.ctx.beginPath();

            const clipWidth = Math.max(0, this.mouseX);
            this.ctx.rect(0, 0, clipWidth, baseH);
            this.ctx.clip();

            this.drawMediaItem(this.ctx, imgB, bRect.x, bRect.y, bRect.w, bRect.h, false);
            this.ctx.restore();

            // Split Line
            if (this.mouseX >= 0 && this.mouseX <= baseW) {
                this.ctx.beginPath();
                this.ctx.moveTo(this.mouseX, 0);
                this.ctx.lineTo(this.mouseX, baseH);
                this.ctx.lineWidth = 1 / (scale || 1);
                this.ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
                this.ctx.globalCompositeOperation = "difference";
                this.ctx.stroke();
                this.ctx.globalCompositeOperation = "source-over";
            }
        }

        // Draw Unclipped Audio HUD on top of everything
        this.drawAudioHUD(this.ctx, width, height);
    },

    // --- UTILS & BOILERPLATE ---
    
    getMediaSize(media) {
        if (media instanceof HTMLVideoElement) return { width: media.videoWidth || 0, height: media.videoHeight || 0 };
        if (media instanceof HTMLImageElement) return { width: media.naturalWidth || 0, height: media.naturalHeight || 0 };
        return { width: 0, height: 0 }; // Audio
    },

    // VAGUE 10 : rect « contain » (letterbox centré) d'un média de taille
    // (iw,ih) dans une boîte commune (ox,oy,dw,dh). Préserve l'aspect de
    // CHAQUE média — aucun étirement quand les ratios diffèrent (ex. crop).
    _containRect(iw, ih, ox, oy, dw, dh) {
        const w = iw > 0 ? iw : 1;
        const h = ih > 0 ? ih : 1;
        const s = Math.min(dw / w, dh / h);
        const cw = w * s;
        const ch = h * s;
        return { x: ox + (dw - cw) / 2, y: oy + (dh - ch) / 2, w: cw, h: ch };
    },

    // VAGUE 8 : pose la taille image de la brique (headless). Le fit est un
    // contain de A (parité avec l'ancien draw qui dessinait A et B dans la même
    // boîte contain de A). Audio → taille virtuelle 16:9 (1280×720).
    setViewportImageSize(media) {
        if (!this.vp) return;
        const size = this.getMediaSize(media);
        const baseW = size.width > 0 ? size.width : 1280;
        const baseH = size.height > 0 ? size.height : 720;
        this.vp.setImageSize(baseW, baseH);
    },

    isMediaReady(media) {
        if (!media) return false;
        if (media instanceof HTMLMediaElement) return media.readyState >= 1; // Metadata loaded is enough
        return media.complete && media.naturalWidth > 0;
    },

    checkAndStartAnimation() {
        this.stopAnimation();
        const needsLoop = this.images.some(el => el instanceof HTMLMediaElement);
        if (needsLoop) {
            const loop = () => {
                if (this.isOpen || this.isPoppedOut) this.draw();
                this.rafId = requestAnimationFrame(loop);
            };
            this.rafId = requestAnimationFrame(loop);
        }
    },

    stopAnimation() {
        if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    },

    syncVideos() {
        const mediaEls = this.images.filter(el => el instanceof HTMLMediaElement);
        if (mediaEls.length > 1) mediaEls.forEach(v => v.currentTime = 0);
    },

    resetZoom() {
        if (this.vp) this.vp.fit();
        this.draw();
    },

    updatePlaybackUI(isPlaying) {
        const playIcon = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
        const pauseIcon = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
        this.uiControls.playBtn.innerHTML = isPlaying ? pauseIcon : playIcon;
    },

    toggleSidebar() {
        this.isSidebarOpen = !this.isSidebarOpen;
        this.renderSidebarHistory();
        this.saveState();
    },

    renderSidebarHistory() {
        if (!this.sidebarHistoryContainer) return;
        this.sidebarHistoryContainer.innerHTML = "";

        if (!this.isSidebarOpen) {
            this.sidebarElement.style.width = "0px";
            this.sidebarElement.style.borderRight = "none";  // already handled
            return;
        }
        
        this.sidebarElement.style.width = "180px";
        this.sidebarElement.style.borderRight = "1px solid var(--holaf-border-color, #444)";

        const createItem = (label, nameId, isSpecial = false) => {
            const el = document.createElement("div");
            el.innerText = label; el.title = label;
            const isSelected = (this.currentViewName === nameId);
            el.className = isSelected ? "holaf-rc-history-item selected" : "holaf-rc-history-item";
            if (isSpecial) el.style.fontWeight = "bold";
            Object.assign(el.style, {
                overflow: "hidden", textOverflow: "ellipsis"
            });
            el.onclick = () => this.selectView(nameId);
            return el;
        };

        this.sidebarHistoryContainer.appendChild(createItem(t("rc.latest"), "latest", true));
        if (this.history.length > 0) {
            const sep1 = document.createElement("div");
            sep1.className = "holaf-rc-history-separator";
            Object.assign(sep1.style, { height: "4px" });
            this.sidebarHistoryContainer.appendChild(sep1);
            this.history.forEach(item => this.sidebarHistoryContainer.appendChild(createItem(item.name, item.name)));
        }
    },

    async selectView(nameId) {
        this.currentViewName = nameId;
        this.renderSidebarHistory();
        let targetMeta = nameId === "latest" ? this.latestImagesMeta : (this.history.find(h => h.name === nameId)?.imagesMeta || []);

        if (targetMeta.length > 0) {
            this.statusTextEl.style.display = "none";
            this.resetZoom();
            await this.loadMedia(targetMeta);
            this.draw();
        } else {
            this.clearHistory();
        }
    },

    clearHistory() {
        this.stopAnimation();
        this.history = []; this.latestImagesMeta = []; this.currentImagesMeta = []; this.currentViewName = "latest";
        this.images.forEach(m => { if (m instanceof HTMLMediaElement) m.pause(); });
        this.images = [];
        this.uiControls.container.style.display = "none";
        this.statusTextEl.style.display = "block";
        this.statusTextEl.innerText = t("rc.waiting");
        this.renderSidebarHistory();
        this.resetZoom();
    },

    saveImage(index) {
        if (!this.images || this.images.length <= index) return;
        const media = this.images[index];
        const meta = this.currentImagesMeta[index];
        
        const isVideo = media instanceof HTMLVideoElement;
        const isAudio = media instanceof window.HTMLAudioElement;
        const ext = isVideo ? "mp4" : isAudio ? "wav" : "png";
        
        let filename = `comparer_media_${index + 1}.${ext}`;
        if (meta && meta.filename) {
            filename = meta.filename.replace('holaf_remote_cmp_', 'saved_cmp_').replace(/\.[^/.]+$/, `.${ext}`);
        }

        fetch(media.src).then(res => res.blob()).then(blob => {
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none'; a.href = url; a.download = filename;
            document.body.appendChild(a); a.click();
            // Delay cleanup to let the browser start the download before revoking the blob URL
            setTimeout(() => {
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);
            }, 250);
        }).catch(err => console.error("[Holaf Remote Comparer] Save failed:", err));
    },

    // --- FULLSCREEN & POPOUT ---
    toggleFullscreen() {
        this.isFullscreen = !this.isFullscreen;
        if (this.isFullscreen) {
            Object.assign(this.rootElement.style, { width: "100vw", height: "100vh", right: "0px", bottom: "0px", borderRadius: "0px" });
            this.setResizeHandlesVisible(false);
        } else {
            this.rootElement.style.borderRadius = "8px";
            this.setResizeHandlesVisible(true);
            this.updateVisualPosition();
        }
    },

    popOut() {
        if (this.isPoppedOut || this.isStandalone) return;
        this.isPoppedOut = true;
        this.isOpen = false;
        this.rootElement.style.display = "none";
        this.images.forEach(m => { if (m instanceof HTMLMediaElement) m.pause(); });
        if (this.isFullscreen) this.toggleFullscreen();

        // Hide the in-page panel (the standalone tab will handle display)
        this.floatingPopoutBtn.style.display = "none";
        this.floatingPopinBtn.style.display = "flex";
        this.saveState();

        // Open in a new browser tab instead of a popup window
        this._popupTab = window.open('/holaf/comparer', '_blank');
    },

    popIn() {
        if (!this.isPoppedOut) return;
        this.isPoppedOut = false;
        this.floatingPopoutBtn.style.display = "flex";
        this.floatingPopinBtn.style.display = "none";

        if (this._popupTab && !this._popupTab.closed) {
            this._popupTab.close();
        }
        this._popupTab = null;
        if (this.isOpen) { this.rootElement.style.display = "flex"; this.updateVisualPosition(); }
    },

    updateVisualPosition() {
        if (!this.rootElement || this.isFullscreen || this.isPoppedOut || this.isStandalone) return;
        this.rootElement.style.width = this.storedPos.width + "px";
        this.rootElement.style.height = this.storedPos.height + "px";
        const visualRight = Math.max(0, Math.min(this.storedPos.right, window.innerWidth - this.storedPos.width));
        const visualBottom = Math.max(0, Math.min(this.storedPos.bottom, window.innerHeight - this.storedPos.height));
        Object.assign(this.rootElement.style, { left: "auto", top: "auto", right: visualRight + "px", bottom: visualBottom + "px" });
    },

    enableWindowDragging(dragTarget) {
        makeDraggable(this.rootElement, {
            handle: dragTarget,
            anchor: 'right-bottom',
            ignore: 'button',
            isIgnored: () => this.isFullscreen,
            state: this.storedPos,
            updateVisualPosition: () => this.updateVisualPosition(),
            saveState: () => this.saveState(),
            onDragStart: () => { this.rootElement.style.cursor = "move"; },
            onDragEnd: () => { this.rootElement.style.cursor = "default"; },
        });
    },

    createResizeHandles() {
        const directions = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
        directions.forEach(dir => {
            const handle = document.createElement("div");
            handle.className = `holaf-resize-handle holaf-resize-${dir}`;
            handle.dataset.dir = dir;
            this.rootElement.appendChild(handle);
        });

        makeResizable(this.rootElement, {
            anchor: 'right-bottom',
            minWidth: 300,
            minHeight: 200,
            isIgnored: () => this.isFullscreen,
            state: this.storedPos,
            updateVisualPosition: () => this.updateVisualPosition(),
            saveState: () => this.saveState(),
        });
    },

    setResizeHandlesVisible(visible) {
        const handles = this.rootElement.querySelectorAll('.holaf-resize-handle');
        handles.forEach(h => h.style.display = visible ? '' : 'none');
    },

    resizeCanvas() {
        if (!this.canvasEl || !this.contentElement) return;
        this.canvasEl.width = this.contentElement.clientWidth;
        this.canvasEl.height = this.contentElement.clientHeight;
        this.draw();
    },

    toggle() {
        this.isOpen = !this.isOpen;
        this.isOpen ? this.show() : this.hide();
        this.saveState();
        return this.isOpen;
    },

    show() {
        if (!this.rootElement) this.buildUI();
        this.isOpen = true;
        if (this.rootElement) aihWindowManager().bringToFront(this.rootElement);

        if (this.isStandalone) {
            // In standalone mode, the panel fills the entire viewport
            this.rootElement.style.display = "flex";
            this.rootElement.style.inset = "0";
            // Remove inline width/height so it fills viewport
            this.rootElement.style.width = "100vw";
            this.rootElement.style.height = "100vh";
            this.rootElement.style.right = "auto";
            this.rootElement.style.bottom = "auto";
        } else if (!this.isComparerDetached()) {
            this.rootElement.style.display = "flex";
            if (!this.isFullscreen) this.updateVisualPosition();
        }
        this.resizeCanvas();
        this.images.forEach(m => { if (m instanceof HTMLMediaElement) m.play(); });
    },

    hide() {
        this.isOpen = false;
        if (this.isPoppedOut) this.popIn();
        if (this.rootElement) {
            aihWindowManager().unregister(this.rootElement);
            this.rootElement.style.display = "none";
        }
        this.images.forEach(m => { if (m instanceof HTMLMediaElement) m.pause(); });
        this.saveState();
    },
};

// --- Standalone Initialization ---
// Called from /holaf/comparer page
export function initStandaloneComparer() {
    console.log("[Holaf Remote Comparer] Initializing Standalone mode...");
    HolafRemoteComparer.init();

    // Heartbeat: keep the main tab aware that this standalone comparer is alive
    HolafRemoteComparer._standaloneHeartbeatInterval = setInterval(() => {
        HolafRemoteComparer._bridge.postMessage({ type: 'COMPARER_STANDALONE_OPEN' });
        localStorage.setItem(COMPARER_STANDALONE_HEARTBEAT_KEY, String(Date.now()));
    }, COMPARER_STANDALONE_HEARTBEAT_MS);

    // Notify the main tab when this standalone tab closes
    window.addEventListener('beforeunload', () => {
        HolafRemoteComparer._stopStandaloneHeartbeat();
        HolafRemoteComparer._bridge.postMessage({ type: 'COMPARER_STANDALONE_CLOSED' });
    });
}

// Only register as ComfyUI extension when not in standalone mode
if (window.location.pathname !== '/holaf/comparer') {
    app.registerExtension({
        name: HolafRemoteComparer.name,
        async setup() {
            HolafRemoteComparer.init();
            app.holafRemoteComparer = HolafRemoteComparer;
        }
    });
}