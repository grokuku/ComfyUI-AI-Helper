import { app, api } from "./holaf_api_compat.js";
import { makeDraggable, makeResizable, makeContentZoomable, aihWindowManager } from "./holaf_window_utils.js";
import { escapeHtml } from "./holaf_dom_utils.js";

// Helper i18n central : traduit via AIH.I18n (clé brute si absente).
const t = (key, params) => {
    const I = window.AIH && window.AIH.I18n;
    return I && typeof I.t === "function" ? I.t(key, params) : key;
};

/**
 * Confirmation DESTRUCTIVE avant suppression d'un raccourci persistant.
 * Réutilise le système de fenêtres UNIFIÉ du pack (AIH.Dialog via AIH.confirm),
 * JAMAIS window.confirm : bouton « Supprimer » en ROUGE (danger), « Annuler » par
 * défaut. Échap / clic sur le fond / « Annuler » → false : AUCUNE suppression
 * (ni état en mémoire, ni persistance graph.extra). Fail-closed : sans UI de
 * confirmation disponible, on ne supprime PAS (Promise.resolve(false)).
 */
function _confirmDeleteShortcut(name) {
    const I = window.AIH && window.AIH.I18n;
    const tr = (key, fallback, params) => {
        const v = (I && typeof I.t === "function") ? I.t(key, params) : "";
        return (v && v !== key) ? v : fallback;
    };
    const title = tr("sc.deleteTitle", "Delete shortcut");
    // Le nom est une donnée utilisateur (renommable) : échappé AVANT
    // interpolation, car AIH.confirm insère le message en innerHTML (anti-XSS).
    const message = tr("sc.deleteConfirm", "", { name: escapeHtml(name || "") });
    const dangerLabel = tr("sc.deleteConfirmAction", "Delete");
    const cancelLabel = tr("dialog.cancel", "Cancel");
    const A = window.AIH;
    if (A && typeof A.confirm === "function") {
        return A.confirm(title, message, { danger: true, confirmText: dangerLabel, cancelText: cancelLabel });
    }
    // Repli : helper unifié aihShowConfirm (mêmes garanties : Promise<boolean>).
    if (typeof window.aihShowConfirm === "function") {
        return window.aihShowConfirm(title, message);
    }
    return Promise.resolve(false);
}

const HolafShortcuts = {
    name: "Holaf.Shortcuts",
    isVisible: false,
    rootElement: null,
    listElement: null,
    
    // --- Data State ---
    shortcuts: [], // Array of { id, name, x, y, zoom, path }

    // --- Window State ---
    storedPos: {
        right: 20,
        bottom: 300, 
        width: 200,
        height: 250
    },
    STORAGE_KEY: "holaf_shortcuts_state_v1",
    GRAPH_EXTRA_KEY: "holaf_shortcuts",

    init() {
        this.restoreState();
        this.createHostElement();
        
        window.addEventListener("resize", () => this.updateVisualPosition());

        if (this.isVisible) {
            setTimeout(() => this.show(), 300);
        }
    },

    // --- SUBGRAPH NAVIGATION LOGIC ---

    /**
     * Recherche récursive pour trouver le chemin d'un graphe.
     */
    findPathToGraph(targetGraph, currentGraph, currentPath = []) {
        if (targetGraph === currentGraph) return currentPath;
        if (!currentGraph || !currentGraph._nodes) return null;

        for (const node of currentGraph._nodes) {
            if (node.subgraph) {
                const foundPath = this.findPathToGraph(targetGraph, node.subgraph, [...currentPath, node.id]);
                if (foundPath) return foundPath;
            }
        }
        return null;
    },

    getCurrentGraphPath() {
        const currentGraph = app.canvas.graph;
        if (!currentGraph || currentGraph === app.graph) {
            return [];
        }
        // On cherche récursivement le chemin depuis la racine
        return this.findPathToGraph(currentGraph, app.graph) || [];
    },

    /**
     * Navigue vers le chemin cible (supporte n niveaux).
     */
    navigateToPath(targetPath) {
        const isTargetRoot = !targetPath || targetPath.length === 0;
        const currentGraph = app.canvas.graph;

        if (isTargetRoot) {
            if (currentGraph !== app.graph) {
                app.canvas.setGraph(app.graph);
                return true;
            }
            return false;
        }

        // On descend dans la hiérarchie pour trouver le graphe final
        let targetLevelGraph = app.graph;
        for (const nodeId of targetPath) {
            const node = targetLevelGraph.getNodeById(nodeId);
            if (node && node.subgraph) {
                targetLevelGraph = node.subgraph;
            } else {
                // Chemin cassé
                return false;
            }
        }

        if (currentGraph !== targetLevelGraph) {
            app.canvas.setGraph(targetLevelGraph);
            return true;
        }
        
        return false;
    },

    applyShortcut(id) {
        const item = this.shortcuts.find(s => s.id === id);
        if (!item || !app.canvas || !app.canvas.ds) return;

        // Délai pour éviter les conflits d'événements souris
        setTimeout(() => {
            const switched = this.navigateToPath(item.path);

            // Positionnement
            setTimeout(() => {
                app.canvas.ds.offset[0] = item.x;
                app.canvas.ds.offset[1] = item.y;
                app.canvas.ds.scale = item.zoom;
                app.canvas.setDirty(true, true);
            }, switched ? 100 : 0);
        }, 0);
    },

    // --- DATA LOGIC ---

    loadFromGraph() {
        if (app.graph && app.graph.extra && app.graph.extra[this.GRAPH_EXTRA_KEY]) {
            this.shortcuts = structuredClone(app.graph.extra[this.GRAPH_EXTRA_KEY]);
        } else {
            this.shortcuts = [];
        }
        this.renderList();
    },

    syncToGraph() {
        if (!app.graph) return;
        if (!app.graph.extra) app.graph.extra = {};
        app.graph.extra[this.GRAPH_EXTRA_KEY] = structuredClone(this.shortcuts);
    },

    addShortcut() {
        if (!app.canvas || !app.canvas.ds) return;
        
        const newId = Date.now().toString(36);
        const name = t("sc.defaultView", { count: this.shortcuts.length + 1 });
        const path = this.getCurrentGraphPath();

        this.shortcuts.push({
            id: newId,
            name,
            x: app.canvas.ds.offset[0],
            y: app.canvas.ds.offset[1],
            zoom: app.canvas.ds.scale,
            path: path
        });
        
        this.syncToGraph();
        this.renderList();
    },

    updateShortcut(id) {
        const index = this.shortcuts.findIndex(s => s.id === id);
        if (index === -1) return;

        this.shortcuts[index].path = this.getCurrentGraphPath();
        this.shortcuts[index].x = app.canvas.ds.offset[0];
        this.shortcuts[index].y = app.canvas.ds.offset[1];
        this.shortcuts[index].zoom = app.canvas.ds.scale;
        
        this.syncToGraph();
        
        const btn = this.listElement.querySelector(`[data-id="${id}"] .update-btn`);
        if (btn) {
            const originalText = btn.innerHTML;
            btn.innerHTML = "✓";
            setTimeout(() => btn.innerHTML = originalText, 1000);
        }
    },

    async deleteShortcut(id) {
        const item = this.shortcuts.find(s => s.id === id);
        if (!item) return false;
        // Confirmation DESTRUCTIVE avant tout effet : Annuler / Échap / clic sur
        // le fond → ok=false → AUCUNE suppression, AUCUNE écriture de persistance.
        const ok = await _confirmDeleteShortcut(item.name);
        if (!ok) return false;
        // L'état a pu changer pendant l'attente de la modale : on ne retire que
        // si le raccourci est encore présent (évite une écriture inutile).
        if (!this.shortcuts.some(s => s.id === id)) return false;
        this.shortcuts = this.shortcuts.filter(s => s.id !== id);
        this.syncToGraph();
        this.renderList();
        return true;
    },

    renameShortcut(id, newName) {
        const item = this.shortcuts.find(s => s.id === id);
        if (item) {
            item.name = newName;
            this.syncToGraph();
        }
    },

    // --- UI CONSTRUCTION ---

    createHostElement() {
        if (this.rootElement) return;

        this.rootElement = document.createElement("div");
        this.rootElement.id = "holaf-shortcuts-root";
        this.rootElement.classList.add("holaf-floating-window");
        Object.assign(this.rootElement.style, {
            display: "none",
            position: "fixed",
            zIndex: "1000",
            fontFamily: "sans-serif",
            boxSizing: "border-box",
            overflow: "hidden",
            flexDirection: "column"
        });

        const header = document.createElement("div");
        header.className = "holaf-utility-header";
        header.style.cursor = "move";
        
        const title = document.createElement("span");
        title.innerText = t("sc.title");
        // Title style handled by .holaf-utility-header CSS
        
        const addBtn = document.createElement("button");
        addBtn.innerText = "+";
        addBtn.className = "holaf-header-button";
        addBtn.style.fontSize = "14px";
        addBtn.style.padding = "0 6px";
        addBtn.onmousedown = (e) => e.stopPropagation(); 
        addBtn.onclick = () => this.addShortcut();

        const closeBtn = document.createElement("button");
        closeBtn.className = "holaf-utility-close-button";
        closeBtn.textContent = "✕";
        closeBtn.title = t("dialog.close");
        closeBtn.onmousedown = (e) => e.stopPropagation();
        closeBtn.onclick = () => this.hide();

        header.appendChild(title);
        header.appendChild(addBtn);
        header.appendChild(closeBtn);

        this.listElement = document.createElement("div");
        this.listElement.classList.add("holaf-zoom-content");
        Object.assign(this.listElement.style, {
            flex: "1",
            overflowY: "auto",
            padding: "5px"
        });

        this.createResizeHandles();

        // Boutons zoom standard (− / +) : appliqués au contenu (liste, hors
        // header), persistés sous la clé de fenêtre des raccourcis.
        const zoomGroup = makeContentZoomable(this.listElement, { key: this.STORAGE_KEY });
        header.insertBefore(zoomGroup, closeBtn);

        this.rootElement.appendChild(header);
        this.rootElement.appendChild(this.listElement);
        // Resize handles are already appended inside createResizeHandles()
        
        document.body.appendChild(this.rootElement);

        this.enableWindowDragging(header);
        this.updateVisualPosition();
    },

    renderList() {
        if (!this.listElement) return;
        this.listElement.innerHTML = "";

        if (this.shortcuts.length === 0) {
            this.listElement.innerHTML = `<div style="text-align:center; font-size:11px; margin-top:10px; color:var(--holaf-text-secondary);">${t("sc.noShortcuts")}</div>`;
            return;
        }

        this.shortcuts.forEach(s => {
            const row = document.createElement("div");
            row.className = "holaf-shortcut-row";
            row.setAttribute("data-id", s.id);

            const nameLabel = document.createElement("div");
            nameLabel.className = "holaf-shortcut-name";
            nameLabel.innerText = s.name;
            
            const isDeep = s.path && s.path.length > 0;
            if (isDeep) {
                nameLabel.title = t("sc.subgraphView", { count: s.path.length });
                nameLabel.innerText = ""; // Clear before appending DOM nodes
                const small = document.createElement("small");
                small.style.color = "var(--holaf-accent-color)";
                small.style.marginRight = "4px";
                small.textContent = "\uD83D\uDCC2"; // folder icon
                nameLabel.appendChild(small);
                nameLabel.appendChild(document.createTextNode(s.name));
            }

            nameLabel.onclick = () => this.applyShortcut(s.id);
            
            nameLabel.ondblclick = () => {
                nameLabel.contentEditable = true;
                nameLabel.focus();
                const range = document.createRange();
                    range.selectNodeContents(nameLabel);
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                
                const finishEdit = () => {
                    nameLabel.contentEditable = false;
                    this.renameShortcut(s.id, nameLabel.innerText);
                };
                nameLabel.onblur = finishEdit;
                nameLabel.onkeydown = (e) => {
                    if (e.key === "Enter") { e.preventDefault(); nameLabel.blur(); }
                };
            };

            const updateBtn = document.createElement("button");
            updateBtn.innerHTML = "\U0001f4be"; 
            updateBtn.title = t("sc.update");
            updateBtn.className = "holaf-shortcut-btn update-btn";
            updateBtn.onclick = (e) => { e.stopPropagation(); this.updateShortcut(s.id); };

            const delBtn = document.createElement("button");
            delBtn.innerHTML = "✕";
            delBtn.title = t("sc.delete");
            delBtn.className = "holaf-shortcut-btn";
            delBtn.onmouseenter = () => delBtn.style.color = "#ff5555";
            delBtn.onmouseleave = () => delBtn.style.color = "var(--holaf-text-secondary)";
            delBtn.onclick = (e) => { e.stopPropagation(); this.deleteShortcut(s.id).catch(() => {}); };

            row.appendChild(nameLabel);
            row.appendChild(updateBtn);
            row.appendChild(delBtn);
            this.listElement.appendChild(row);
        });
    },

    updateVisualPosition() {
        if (!this.rootElement) return;

        this.rootElement.style.width = this.storedPos.width + "px";
        this.rootElement.style.height = this.storedPos.height + "px";

        const maxRight = window.innerWidth - this.storedPos.width;
        const maxBottom = window.innerHeight - this.storedPos.height;

        const visualRight = Math.max(0, Math.min(this.storedPos.right, maxRight));
        const visualBottom = Math.max(0, Math.min(this.storedPos.bottom, maxBottom));

        Object.assign(this.rootElement.style, {
            left: "auto", top: "auto",
            right: visualRight + "px",
            bottom: visualBottom + "px"
        });
    },

    enableWindowDragging(dragTarget) {
        makeDraggable(this.rootElement, {
            handle: dragTarget,
            anchor: 'right-bottom',
            ignore: 'button',
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
            minWidth: 150,
            minHeight: 100,
            state: this.storedPos,
            updateVisualPosition: () => this.updateVisualPosition(),
            saveState: () => this.saveState(),
        });
    },

    saveState() {
        if (!this.rootElement) return;
        const state = { 
            ...this.storedPos,
            isVisible: this.isVisible
        };
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(state));
    },

    restoreState() {
        try {
            const saved = localStorage.getItem(this.STORAGE_KEY);
            if (saved) {
                const state = JSON.parse(saved);
                this.storedPos.right = state.right ?? 20;
                this.storedPos.bottom = state.bottom ?? 300;
                this.storedPos.width = state.width ?? 200;
                this.storedPos.height = state.height ?? 250;
                this.isVisible = !!state.isVisible;
            }
        } catch (e) {}
    },

    toggle() {
        this.isVisible = !this.isVisible;
        this.isVisible ? this.show() : this.hide();
        this.saveState();
        return this.isVisible;
    },

    show() {
        if (!this.rootElement) this.createHostElement();
        this.rootElement.style.display = "flex";
        this.isVisible = true;
        aihWindowManager().bringToFront(this.rootElement);
        this.updateVisualPosition();
        this.renderList();
    },

    hide() {
        if (this.rootElement) {
            aihWindowManager().unregister(this.rootElement);
            this.rootElement.style.display = "none";
        }
        this.isVisible = false;
    }
};

app.registerExtension({
    name: HolafShortcuts.name,
    async setup() {
        HolafShortcuts.init();
        app.holafShortcuts = HolafShortcuts;
        
        api.addEventListener("graph-cleared", () => {
            HolafShortcuts.shortcuts = [];
            HolafShortcuts.renderList();
        });
    },
    async afterConfigureGraph() {
        HolafShortcuts.loadFromGraph();
    }
});