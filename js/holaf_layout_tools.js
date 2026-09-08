/* holaf_layout_tools.js */
    import { app } from "./holaf_api_compat.js";
    import { makeDraggable, makeContentZoomable, aihWindowManager } from "./holaf_window_utils.js";
    import { showToast } from "./aih_toast_bridge.js";

    // Helper i18n central : traduit via AIH.I18n (clé brute si absente).
    const t = (key, params) => {
        const I = window.AIH && window.AIH.I18n;
        return I && typeof I.t === "function" ? I.t(key, params) : key;
    };
    
    const HolafLayoutTools = {
        coordDisplay: null,
        container: null,
        isVisible: false,
        STORAGE_KEY: "holaf_layout_tools_pos_v4",
        VISIBILITY_KEY: "holaf_layout_tools_visible",
        
        // Internal state to keep track of the "ideal" position
        storedPos: { right: 360, bottom: 20 },
        
        init() {
            if (!window.holaf) window.holaf = {};
            window.holaf.layoutTools = this;
    
            // Load visibility state before initialization
            const savedVisibility = localStorage.getItem(this.VISIBILITY_KEY);
            this.isVisible = savedVisibility === "true";
    
            setTimeout(() => {
                this.createFloatingToolbar();
                this.startCoordinatePoller();
                
                // Re-evaluate visual position on resize without changing storedPos
                window.addEventListener("resize", () => this.updateVisualPosition());
            }, 500);
        },
    
        toggle() {
            this.isVisible = !this.isVisible;
            if (this.container) {
                this.container.style.display = this.isVisible ? "flex" : "none";
                if (this.isVisible) {
                    aihWindowManager().bringToFront(this.container);
                } else {
                    aihWindowManager().unregister(this.container);
                }
            }
            // Persist visibility state
            localStorage.setItem(this.VISIBILITY_KEY, this.isVisible);
            return this.isVisible;
        },

        hide() {
            this.isVisible = false;
            if (this.container) {
                aihWindowManager().unregister(this.container);
                this.container.style.display = "none";
            }
            localStorage.setItem(this.VISIBILITY_KEY, this.isVisible);
        },

        createFloatingToolbar() {
            if (document.getElementById("holaf-layout-toolbar")) return;

            this.container = document.createElement("div");
            this.container.id = "holaf-layout-toolbar";
            this.container.classList.add("holaf-floating-window");

            Object.assign(this.container.style, {
                position: "fixed",
                zIndex: "10000",
                display: this.isVisible ? "flex" : "none",
                flexDirection: "row",
                alignItems: "center",
                boxSizing: "border-box",
                overflow: "hidden",
                backgroundColor: "var(--comfy-menu-bg)",
                borderRadius: "8px",
                border: "1px solid var(--border-color)",
                boxShadow: "0 4px 6px rgba(0,0,0,0.3)",
                fontFamily: "monospace",
                fontSize: "12px",
                color: "var(--fg-color, #ccc)",
                userSelect: "none"
            });

            // Load reference position from storage
            const saved = localStorage.getItem(this.STORAGE_KEY);
            if (saved) {
                try {
                    const parsed = JSON.parse(saved);
                    this.storedPos.right = parseInt(parsed.right);
                    this.storedPos.bottom = parseInt(parsed.bottom);
                } catch (e) { console.warn("[Holaf Layout] Restore failed", e); }
            }

            document.body.appendChild(this.container);

            // ─── Forme compacte : poignée de drag + contenu + fermeture ──────
            // (toolbar minuscule : pas de barre de titre — drag via le grip)
            const grip = document.createElement("div");
            grip.title = t("lt.title");
            grip.style.cursor = "grab";
            grip.style.userSelect = "none";
            grip.style.padding = "0 4px";
            grip.style.color = "var(--descriptive-text, #888)";
            grip.style.fontSize = "14px";
            grip.textContent = "⠿";
            this.container.appendChild(grip);

            this.coordDisplay = document.createElement("div");
            this.coordDisplay.innerText = "X: 0 | Y: 0";
            this.coordDisplay.style.marginRight = "8px";
            this.coordDisplay.style.minWidth = "120px";
            this.coordDisplay.style.textAlign = "right";
            this.coordDisplay.style.pointerEvents = "none";
            this.container.appendChild(this.coordDisplay);

            const sep = document.createElement("div");
            Object.assign(sep.style, { width: "1px", height: "20px", backgroundColor: "var(--border-color)" });
            this.container.appendChild(sep);

            this.injectButtons(this.container);

            // Fermeture discrète en fin de barre
            const closeBtn = document.createElement("button");
            closeBtn.className = "holaf-header-button";
            closeBtn.textContent = "✕";
            closeBtn.title = t("dialog.close");
            Object.assign(closeBtn.style, { background: "transparent", border: "none", cursor: "pointer", padding: "2px 6px", color: "var(--fg-color, #ccc)" });
            closeBtn.onmousedown = (e) => e.stopPropagation();
            closeBtn.onclick = () => this.hide();
            this.container.appendChild(closeBtn);

            // Drag par la poignée (ancrage droite/bas persisté)
            this.enableWindowDragging(grip);

            // Enregistré dans l'autorité de fenêtres unifiée (halo/z-index cohérents)
            if (this.isVisible) aihWindowManager().register(this.container);

            // Initial visual application
            this.updateVisualPosition();
        },
    
        /**
         * Calculates the best visual position based on storedPos and current window size.
         * Does NOT modify storedPos.
         */
        updateVisualPosition() {
            if (!this.container) return;
            
            const rect = this.container.getBoundingClientRect();
            
            // Calculate maximum allowed values to keep the tool in the viewport
            // (Tool width/height are needed to avoid overflow on the left/top)
            const maxRightAllowed = window.innerWidth - rect.width;
            const maxBottomAllowed = window.innerHeight - rect.height;
    
            // Visual clamping: we show the stored position, but capped by the screen edges
            const visualRight = Math.max(0, Math.min(this.storedPos.right, maxRightAllowed));
            const visualBottom = Math.max(0, Math.min(this.storedPos.bottom, maxBottomAllowed));
    
            this.container.style.left = "auto";
            this.container.style.top = "auto";
            this.container.style.right = visualRight + "px";
            this.container.style.bottom = visualBottom + "px";
        },
    
        enableWindowDragging(header) {
            makeDraggable(this.container, {
                handle: header,
                anchor: 'right-bottom',
                ignore: 'button, input, select, textarea, a',
                state: this.storedPos,
                updateVisualPosition: () => this.updateVisualPosition(),
                saveState: () => {
                    try { localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.storedPos)); } catch (e) {}
                },
                cursor: 'grabbing',
                cursorRestore: 'grab',
            });
        },
    
        injectButtons(container) {
            const button = document.createElement("button");
            button.className = "holaf-layout-btn";
            button.title = t("lt.moveToOrigin");
            Object.assign(button.style, { width: "32px", height: "32px", cursor: "pointer", backgroundColor: "var(--comfy-input-bg)", border: "1px solid var(--border-color)", borderRadius: "4px", display: "flex", alignItems: "center", justifyContent: "center", padding: "4px" });
            button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:100%; height:100%; color: var(--fg-color, white);"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`;
            button.onclick = () => this.moveGraphToOrigin();
            container.appendChild(button);
        },
    
        startCoordinatePoller() {
            setInterval(() => {
                if (!this.coordDisplay || !this.isVisible || !app.canvas?.graph_mouse) return;
                this.coordDisplay.innerText = `X: ${Math.round(app.canvas.graph_mouse[0])} | Y: ${Math.round(app.canvas.graph_mouse[1])}`;
            }, 100);
        },
    
        moveGraphToOrigin() {
            const graph = app.canvas.graph;
            if (!graph) return;
    
            const allEntitiesSet = new Set();
            if (graph._nodes) graph._nodes.forEach(n => allEntitiesSet.add(n));
            if (graph._groups) graph._groups.forEach(g => allEntitiesSet.add(g));
    
            for (let key in graph) {
                const obj = graph[key];
                if (obj && typeof obj === 'object' && obj.pos && typeof obj.pos.length === 'number') {
                    allEntitiesSet.add(obj);
                }
            }
    
            const allEntities = Array.from(allEntitiesSet);
            if (allEntities.length === 0) return;
    
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            const getVal = (v) => (typeof v === 'number' && !isNaN(v)) ? v : 0;
    
            allEntities.forEach(item => {
                const x = getVal(item.pos[0]);
                const y = getVal(item.pos[1]);
                const w = (item.size && typeof item.size.length === 'number') ? getVal(item.size[0]) : 40;
                const h = (item.size && typeof item.size.length === 'number') ? getVal(item.size[1]) : 20;
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if ((x + w) > maxX) maxX = x + w;
                if ((y + h) > maxY) maxY = y + h;
            });
    
            if (minX === Infinity) return;
    
            const offsetX = -((minX + maxX) / 2);
            const offsetY = -((minY + maxY) / 2);
    
            allEntities.forEach(item => {
                item.pos[0] += offsetX;
                item.pos[1] += offsetY;
            });
    
            graph.setDirtyCanvas(true, true);
            if (app.canvas) {
                app.canvas.ds.offset = [app.canvas.canvas.width / 2, app.canvas.canvas.height / 2];
                app.canvas.setDirty(true, true);
            }
    
            showToast({ message: t("lt.recentered", { count: allEntities.length }), type: "success" });
        }
    };
    
    app.registerExtension({
        name: "Holaf.Layout.Tools",
        setup() { HolafLayoutTools.init(); }
    });