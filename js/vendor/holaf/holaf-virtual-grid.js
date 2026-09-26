/* ═══════════════════════════════════════════════════════════════════════════
 * Holaf UI — Brique HolafGrid · version 0.1.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Grille VIRTUALISÉE en DOM, GÉNÉRIQUE et INSTANCIABLE (zéro état de module
 * hors le <style> partagé). Elle ne connaît QUE :
 *   - la SOURCE de données (une collection injectée, ou un simple tableau) ;
 *   - le RENDERER de cellule injecté (cell.create/update/release) + des slots ;
 *   - une clé métier getId(item).
 * Aucune notion métier (ComfyUI, path_canon, endpoint, cache réseau…) n'entre
 * ici : tout ce qui est spécifique passe par les adaptateurs/slots de l'hôte.
 *
 * Elle absorbe, sans régression, la logique historique de la galerie du node :
 *   - layout (sizer + surface en position absolue, colonnes/largeur/hauteur
 *     d'item, gap lu via getComputedStyle, buffer × viewport, translate) ;
 *   - rendu virtualisé (fenêtre visible + buffer, pool d'éléments recyclés,
 *     squelettes pour les trous de la source creuse) ;
 *   - resize (ResizeObserver + ancrage du scroll sur la même rangée) ;
 *   - sélection mono/multi (shift = plage, ctrl/cmd = toggle, sinon mono ;
 *     ancre ; Set d'ids O(1)) avec délégation d'événements click/dblclick ;
 *   - navigation clavier de grille (←/→ ±1, ↑/↓ ±colonnes, Home/End,
 *     PageUp/PageDown, Espace = sélection, Entrée = activation) via
 *     selection.handleKey(e) — le garde-fou reste côté hôte (canHandleKey) ;
 *   - scroll/alignement (scrollToIndex align start/center/end/nearest,
 *     ensureVisible) et refresh(id), markPending(id).
 *
 * Zéro dépendance runtime, aucun import croisé (cette brique n'importe ni
 * holaf-collection ni holaf-thumbcache : la source et le cache sont injectés).
 *
 * CSS-INJECTANTE : getCss() expose le CSS complet ; l'option
 * { css: { injectStyles:false, nonce } } (ou HolafGrid.configure/
 * setStyleNonce) contrôle l'injection. CSS scopé sous .holaf-grid-* et
 * variables --hl-* posées sur la racine de la grille, JAMAIS sur :root.
 *
 * Fichier DUAL : classe ES (export) + global window.HolafGrid — se charge via
 * <script type="module"> ou `import { HolafGrid }`.
 *
 * VOLONTAIREMENT ABSENT (briques suivantes) : lightbox (HolafLightbox),
 * volet d'informations (HolafInfoPane), chargement des vignettes (cache =
 * holaf-thumbcache), gestion du clavier global de la PAGE (l'hôte branche
 * selection.handleKey sur son propre listener et garde ses garde-fous).
 * ═════════════════════════════════════════════════════════════════════════ */

const VERSION = "0.1.0";

const HolafGrid = (function () {
    "use strict";

    const CSS_ID = "holaf-grid-style";

    // ─── CSS auto-injecté (une seule fois pour tout le module) ──────────────
    // Classes scopées .holaf-grid-* ; variables --hl-* posées sur la RACINE de
    // chaque grille (.holaf-grid-root), jamais sur :root, pour ne rien imposer
    // au document hôte et permettre une surcharge par instance.
    // Les classes --selected/--active/--pending sont des HOOKS : elles sont
    // posées par la brique mais leur rendu visuel final reste à l'hôte (la
    // galerie du pack garde ses propres styles .active / checkbox :checked).
    const CSS = `
.holaf-grid-root {
    position: relative;
    width: 100%;
    box-sizing: border-box;
    --hl-gap: 8px;
    --hl-item-size: 150px;
    --hl-radius: 4px;
    --hl-accent: #6366f1;
}
.holaf-grid-sizer { position: relative; width: 100%; height: 0; pointer-events: none; }
.holaf-grid-surface { position: absolute; top: 0; left: 0; width: 100%; }
.holaf-grid-cell { position: absolute; top: 0; left: 0; box-sizing: border-box; will-change: transform; }
.holaf-grid-skeleton {
    border-radius: var(--hl-radius);
    background-color: rgba(128, 128, 128, 0.25);
    animation: holaf-grid-skeleton-pulse 1.2s ease-in-out infinite;
    pointer-events: none;
}
@keyframes holaf-grid-skeleton-pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 0.9; } }
@media (prefers-reduced-motion: reduce) { .holaf-grid-skeleton { animation: none; } }
`;

    // ─── Nonce CSP (OPTIONNEL) ───────────────────────────────────────────────
    let styleNonce = null;
    // Nombre d'instances VIVANTES ayant demandé l'injection : le <style> n'est
    // retiré qu'à la destruction de la DERNIÈRE (les instances partagent l'id).
    let liveInstances = 0;
    // Défaut global d'injection (configure).
    let injectStylesGlobal = true;

    function normalizeNonce(value) {
        if (value === null || value === undefined || value === "") return null;
        return String(value);
    }
    function readNonce(el) {
        if (typeof el.nonce === "string") return normalizeNonce(el.nonce);
        return normalizeNonce(el.getAttribute("nonce"));
    }
    function setStyleNonce(nonce) { styleNonce = normalizeNonce(nonce); }

    function ensureCss(nonceOpt) {
        if (typeof document === "undefined") return;
        const effective = nonceOpt === undefined ? styleNonce : normalizeNonce(nonceOpt);
        let style = document.getElementById(CSS_ID);
        const current = style ? readNonce(style) : null;
        if (style && current === effective) return;
        if (style && style.parentNode) style.parentNode.removeChild(style);
        style = document.createElement("style");
        style.id = CSS_ID;
        if (effective) style.setAttribute("nonce", effective);
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    function removeCss() {
        if (typeof document === "undefined") return;
        const style = document.getElementById(CSS_ID);
        if (style && style.parentNode) style.parentNode.removeChild(style);
    }

    // CSS COMPLET — à servir comme fichier .css quand injectStyles:false.
    function getCss() { return CSS; }

    // Réglages globaux (volatils, en mémoire).
    function configure(opts) {
        opts = opts || {};
        if (opts.injectStyles !== undefined) injectStylesGlobal = opts.injectStyles !== false;
        if (opts.nonce !== undefined) setStyleNonce(opts.nonce);
    }

    // ─── Utilitaires ─────────────────────────────────────────────────────────
    function toNum(v, fallback) {
        const n = typeof v === "number" ? v : parseFloat(v);
        return Number.isFinite(n) ? n : fallback;
    }

    function defaultGetId(item) {
        if (!item) return null;
        if (item.id !== undefined && item.id !== null) return item.id;
        if (item.path_canon !== undefined) return item.path_canon;
        return null;
    }

    // Résout l'option itemSize :
    //   - number                       → la valeur, bornée à > 0 ;
    //   - fonction                     → appelée à chaque relayout (taille
    //                                    dynamique pilotée par l'hôte) ;
    //   - ['--hl-item-size', 150]      → lit la variable CSS sur le conteneur
    //                                    (repli explicite si absente/invalide).
    function resolveItemSize(spec, el) {
        if (typeof spec === "function") {
            const v = toNum(spec(), NaN);
            return Number.isFinite(v) && v > 0 ? v : 150;
        }
        if (Array.isArray(spec)) {
            const varName = spec[0];
            const fallback = toNum(spec[1], 150);
            let raw = "";
            if (el && typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
                raw = window.getComputedStyle(el).getPropertyValue(varName);
            }
            const v = toNum(raw, NaN);
            return Number.isFinite(v) && v > 0 ? v : (fallback > 0 ? fallback : 150);
        }
        const v = toNum(spec, NaN);
        return Number.isFinite(v) && v > 0 ? v : 150;
    }

    const DEFAULT_LABELS = {
        grid: "Grid",
        cell: "Item",
        selected: "selected",
    };

    // ─── Classe Grid ─────────────────────────────────────────────────────────
    class Grid {
        constructor(container, options) {
            if (!container || container.nodeType !== 1) {
                throw new Error("[HolafGrid] un conteneur DOM est requis.");
            }
            const o = options || {};
            this._container = container;
            this._opts = o;
            this._getId = typeof o.getId === "function" ? o.getId : defaultGetId;
            this._itemSizeSpec = (o.itemSize === undefined) ? 150 : o.itemSize;
            this._gapOpt = (o.gap === undefined) ? "auto" : o.gap;
            this._bufferFactor = toNum(o.bufferFactor, 1.5);
            this._aspect = toNum(o.aspect, 1);
            if (!(this._aspect > 0)) this._aspect = 1;

            this._cell = (o.cell && typeof o.cell === "object") ? o.cell : null;
            this._slots = o.slots || {};
            this._selectable = o.selectable !== false;
            this._multi = o.multi !== false;
            this._keyboard = o.keyboard !== false;
            this._activateOnClick = o.activateOnClick === true;
            this._labels = Object.assign({}, DEFAULT_LABELS, o.labels || {});

            this._onActivate = (typeof o.onActivate === "function") ? o.onActivate : null;
            this._onSelectionChange = (typeof o.onSelectionChange === "function") ? o.onSelectionChange : null;
            this._onVisibleRange = (typeof o.onVisibleRange === "function") ? o.onVisibleRange : null;
            this._onAction = (typeof o.onAction === "function") ? o.onAction : null;
            this._onNavigate = (typeof o.onNavigate === "function") ? o.onNavigate : null;
            this._canHandleKey = (typeof o.canHandleKey === "function") ? o.canHandleKey : null;

            // Layout.
            this._colCount = 0;
            this._itemWidth = 0;
            this._itemHeight = 0;
            this._gap = 8;
            this._total = 0;
            this._layoutVersion = 0;

            // Cellules rendues : id → { el, index }.
            this._cells = new Map();
            this._cellPool = [];
            this._cellPoolMax = toNum(o.poolSize, 200) || 200;
            // Squelettes (trous de source creuse) : index → el.
            this._skels = new Map();
            this._skelPool = [];

            // Sélection + ancre (index) + index actif (clavier).
            this._selIds = new Set();
            this._anchorIndex = -1;
            this._activeIndex = -1;
            this._pending = new Set();
            this._pendingTimers = new Map();

            // Source : soit un adaptateur {getAt,total,forEachLoaded}, soit un
            // tableau simple (_items).
            this._source = null;
            this._items = null;

            // Listeners / cycle de vie.
            this._listeners = new Map();
            this._rafId = null;
            this._destroyed = false;
            this._resizeObserver = null;

            this._raf = (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function")
                ? window.requestAnimationFrame.bind(window)
                : (cb) => setTimeout(cb, 16);

            // CSS : injecté sauf si { css: { injectStyles:false } } ou global.
            const cssOpts = o.css || {};
            const inject = (cssOpts.injectStyles !== undefined) ? (cssOpts.injectStyles !== false) : injectStylesGlobal;
            if (inject) {
                ensureCss(cssOpts.nonce);
                this._ownsCss = true;
                liveInstances += 1;
            } else {
                this._ownsCss = false;
            }

            this._buildDom();
            this._bindEvents();
        }

        // ── DOM : racine + sizer + surface ───────────────────────────────────
        _buildDom() {
            const root = document.createElement("div");
            root.className = "holaf-grid-root";
            root.setAttribute("role", "grid");
            root.setAttribute("aria-label", this._labels.grid);
            root.style.setProperty("--hl-gap", "8px");

            const sizer = document.createElement("div");
            sizer.className = "holaf-grid-sizer";

            const surface = document.createElement("div");
            surface.className = "holaf-grid-surface";
            surface.setAttribute("role", "rowgroup");

            root.appendChild(sizer);
            root.appendChild(surface);
            this._container.appendChild(root);

            this.root = root;
            this.sizer = sizer;
            this.surface = surface;
        }

        // ── Observers + listeners ────────────────────────────────────────────
        _bindEvents() {
            this._onScroll = () => { this._scheduleRender(); };
            this._onClick = (e) => { this._handleClick(e); };
            this._onDblClick = (e) => { this._handleDblClick(e); };
            this._onKey = (e) => { this._handleKey(e); };

            this._container.addEventListener("scroll", this._onScroll, { passive: true });
            this._container.addEventListener("click", this._onClick);
            this._container.addEventListener("dblclick", this._onDblClick);
            if (this._keyboard) {
                this._container.addEventListener("keydown", this._onKey);
            }

            if (typeof window !== "undefined" && typeof window.ResizeObserver === "function") {
                this._resizeObserver = new window.ResizeObserver(() => { this._handleResize(); });
                this._resizeObserver.observe(this._container);
            }
        }

        // ── Source de données ────────────────────────────────────────────────
        /**
         * Branche une COLLECTION générique : { at/getAt(index), total|length,
         * forEachLoaded(cb) }. Compatible holaf-collection (at/total).
         */
        setSource(collection) {
            if (!collection || typeof collection !== "object") {
                this._source = null;
                this._items = null;
                this._total = 0;
                this.render(true);
                return this;
            }
            const getAt = (typeof collection.getAt === "function")
                ? collection.getAt.bind(collection)
                : (typeof collection.at === "function" ? collection.at.bind(collection) : () => null);
            const total = (typeof collection.total === "function")
                ? collection.total.bind(collection)
                : (() => {
                    if (typeof collection.total === "number") return collection.total;
                    return collection.length || 0;
                });
            const forEachLoaded = (typeof collection.forEachLoaded === "function")
                ? collection.forEachLoaded.bind(collection)
                : null;
            this._source = { getAt, total, forEachLoaded };
            this._items = null;
            this._total = this._getTotal();
            this.render(true);
            return this;
        }

        /** Source = tableau simple (les trous — indices absents — donnent des squelettes). */
        setItems(items) {
            this._source = null;
            this._items = Array.isArray(items) ? items : [];
            this._total = this._items.length;
            this.render(true);
            return this;
        }

        /** Source creuse réduite à un compte (trous → squelettes). */
        setCount(n) {
            this._total = Math.max(0, Math.floor(toNum(n, 0)) || 0);
            this.render(true);
            return this;
        }

        _getTotal() {
            if (this._source) return Math.max(0, Math.floor(toNum(this._source.total(), 0)) || 0);
            if (this._items) return this._items.length;
            return this._total;
        }

        _getAt(index) {
            if (this._source) return this._source.getAt(index);
            if (this._items) return this._items[index] !== undefined ? this._items[index] : null;
            return null;
        }

        // ── Layout ───────────────────────────────────────────────────────────
        _readGap() {
            if (this._gapOpt === "auto") {
                const el = this.surface || this._container;
                let raw = "";
                if (el && typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
                    raw = window.getComputedStyle(el).getPropertyValue("gap");
                }
                return toNum(raw, 8) || 0;
            }
            return toNum(this._gapOpt, 8) || 0;
        }

        _relayout(itemSizeOverride) {
            const width = (this._container.clientWidth)
                || (typeof this._container.getBoundingClientRect === "function" ? this._container.getBoundingClientRect().width : 0)
                || 0;
            const target = (itemSizeOverride !== undefined && itemSizeOverride !== null)
                ? resolveItemSize(itemSizeOverride, this._container)
                : resolveItemSize(this._itemSizeSpec, this._container);

            this._gap = this._readGap();
            const gap = this._gap;
            const size = Math.max(1, target);
            this._colCount = Math.max(1, Math.floor((width + gap) / (size + gap)));
            const totalGapWidth = (this._colCount - 1) * gap;
            this._itemWidth = Math.max(1, (width - totalGapWidth) / this._colCount);
            this._itemHeight = this._itemWidth / this._aspect;
            this._total = this._getTotal();

            const rowCount = Math.ceil(this._total / this._colCount);
            const totalHeight = rowCount * (this._itemHeight + gap);
            this.sizer.style.height = totalHeight + "px";

            // Mémorise la taille d'item effective si elle a changé (pour les
            // relectures host via getItemSize()).
            this._effectiveItemSize = size;
            this._layoutVersion += 1;
        }

        /** Recalcule le layout et ré-affiche (override optionnel de la taille). */
        relayout(itemSize) {
            if (this._destroyed) return this;
            this._relayout(itemSize);
            this._renderRange();
            return this;
        }

        getColumnCount() { return this._colCount; }

        /** Métriques de layout courantes (lecture seule pour l'hôte). */
        getMetrics() {
            return {
                columns: this._colCount,
                itemWidth: this._itemWidth,
                itemHeight: this._itemHeight,
                gap: this._gap,
                itemSize: this._effectiveItemSize,
            };
        }

        // ── Rendu virtualisé ─────────────────────────────────────────────────
        _scheduleRender() {
            if (this._destroyed || this._rafId) return;
            this._rafId = this._raf(() => {
                this._rafId = null;
                this._renderRange();
            });
        }

        /** render(force) : force=true → layout + reconstruction complète du pool. */
        render(force) {
            if (this._destroyed) return this;
            if (this._rafId) {
                if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
                    window.cancelAnimationFrame(this._rafId);
                } else {
                    clearTimeout(this._rafId);
                }
                this._rafId = null;
            }
            if (force) {
                this._relayout();
                this._resetCells();
            } else if (this._colCount === 0 || this._layoutVersion === 0) {
                this._relayout();
            }
            this._renderRange();
            return this;
        }

        _resetCells() {
            for (const entry of this._cells.values()) {
                if (this._cell && typeof this._cell.release === "function") {
                    try { this._cell.release(entry.el); } catch (e) { console.error("[HolafGrid] cell.release :", e); }
                }
                entry.el._holafBoundId = null;
                if (entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
                this._poolCell(entry.el);
            }
            this._cells.clear();
            for (const sk of this._skels.values()) {
                if (sk.parentNode) sk.parentNode.removeChild(sk);
                this._poolSkel(sk);
            }
            this._skels.clear();
        }

        _renderRange() {
            if (this._destroyed) return;
            if (this._colCount === 0) return;

            const total = this._getTotal();
            this._total = total;

            if (!total) {
                this._resetCells();
                this.sizer.style.height = "0px";
                this._emitVisible(0, -1, []);
                return;
            }

            const viewportHeight = this._container.clientHeight || 0;
            const scrollTop = this._container.scrollTop || 0;
            const rowH = this._itemHeight + this._gap;

            const buffer = viewportHeight * this._bufferFactor;
            const areaStart = Math.max(0, scrollTop - buffer);
            const areaEnd = scrollTop + viewportHeight + buffer;

            const startRow = Math.max(0, Math.floor(areaStart / rowH));
            const endRow = Math.ceil(areaEnd / rowH);
            const startIndex = startRow * this._colCount;
            const endIndex = Math.min(total - 1, (endRow * this._colCount) + this._colCount - 1);

            // Fenêtre à rendre : [startIndex, endIndex].
            const windowEntries = [];
            const requiredIds = new Set();
            const requiredSkelIndices = new Set();
            for (let i = startIndex; i <= endIndex; i++) {
                const item = this._getAt(i);
                if (item) {
                    const id = this._getId(item);
                    requiredIds.add(id);
                    windowEntries.push({ i, item, id });
                } else {
                    requiredSkelIndices.add(i);
                    windowEntries.push({ i, item: null, id: null });
                }
            }

            // 1) Évincer AVANT de créer : les cellules/squelettes sortis de la
            // fenêtre retournent au pool, qui resservira dans la passe 2 — un
            // gros saut de scroll réutilise donc les éléments existants.
            for (const [id, entry] of this._cells) {
                if (requiredIds.has(id)) continue;
                if (this._cell && typeof this._cell.release === "function") {
                    try { this._cell.release(entry.el); } catch (e) { console.error("[HolafGrid] cell.release :", e); }
                }
                entry.el._holafBoundId = null;
                if (entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
                this._poolCell(entry.el);
                this._cells.delete(id);
            }
            for (const [skIndex, sk] of this._skels) {
                if (requiredSkelIndices.has(skIndex)) continue;
                if (sk.parentNode) sk.parentNode.removeChild(sk);
                this._poolSkel(sk);
                this._skels.delete(skIndex);
            }

            // 2) Rendre la fenêtre (réutilisation pool / MAJ in-place).
            const nextCells = new Map();
            const nextSkels = new Map();
            const fragment = document.createDocumentFragment();

            for (const desc of windowEntries) {
                const i = desc.i;
                const row = Math.floor(i / this._colCount);
                const col = i % this._colCount;
                const top = row * rowH;
                const left = col * (this._itemWidth + this._gap);
                const transform = "translate(" + left + "px, " + top + "px)";

                if (!desc.item) {
                    // Trou de source creuse → squelette recyclé par index.
                    let sk = this._skels.get(i);
                    const wasInDom = !!sk && sk.parentNode === this.surface;
                    if (!sk) sk = this._acquireSkel();
                    if (!wasInDom) fragment.appendChild(sk);
                    if (sk.style.transform !== transform) sk.style.transform = transform;
                    sk.style.width = this._itemWidth + "px";
                    sk.style.height = this._itemHeight + "px";
                    sk.dataset.holafIndex = i;
                    nextSkels.set(i, sk);
                    continue;
                }

                const id = desc.id;
                const entry = this._cells.get(id);
                let el;
                if (entry) {
                    el = entry.el;
                } else {
                    el = this._acquireCell({ item: desc.item, index: i, id });
                    fragment.appendChild(el);
                }

                this._updateCell(el, desc.item, i, id, false);
                nextCells.set(id, { el, index: i });
            }

            if (fragment.childElementCount > 0) {
                this.surface.appendChild(fragment);
            }
            this._cells = nextCells;
            this._skels = nextSkels;

            // Fenêtre STRICTEMENT visible (sans buffer) → priorisation hôte.
            const visStartRow = Math.max(0, Math.floor(scrollTop / rowH));
            const visEndRow = Math.ceil((scrollTop + viewportHeight) / rowH);
            const visStart = visStartRow * this._colCount;
            const visEnd = Math.min(total - 1, (visEndRow * this._colCount) + this._colCount - 1);
            const visIds = [];
            for (let i = visStart; i <= visEnd; i++) {
                const it = this._getAt(i);
                if (it) visIds.push(this._getId(it));
            }
            this._emitVisible(visStart, visEnd, visIds);
        }

        _updateCell(el, item, index, id, refresh) {
            if (!el.classList.contains("holaf-grid-cell")) el.classList.add("holaf-grid-cell");
            const row = Math.floor(index / this._colCount);
            const col = index % this._colCount;
            const rowH = this._itemHeight + this._gap;
            const transform = "translate(" + (col * (this._itemWidth + this._gap)) + "px, " + (row * rowH) + "px)";
            if (el.style.transform !== transform) el.style.transform = transform;
            el.style.width = this._itemWidth + "px";
            el.style.height = this._itemHeight + "px";
            el.dataset.holafIndex = index;
            el.dataset.index = index; // compat : sélecteurs hôtes [data-index]
            el.dataset.holafId = String(id);

            if (el._holafBoundId !== id || refresh) {
                el._holafBoundId = id;
                this._applyCell(el, item, index, id, refresh);
            }

            // États gérés par la brique (indépendants du renderer hôte).
            el.classList.toggle("holaf-grid-cell--selected", this._selIds.has(id));
            el.classList.toggle("holaf-grid-cell--active", this._activeIndex === index);
            el.classList.toggle("holaf-grid-cell--pending", this._pending.has(id));
            const cb = el.querySelector ? el.querySelector('input[type="checkbox"]') : null;
            if (cb) cb.checked = this._selIds.has(id);
        }

        // ── Renderer de cellule (injecté) + slots ────────────────────────────
        _makeCtx(item, index, id, refresh) {
            return {
                grid: this,
                item,
                index,
                id,
                refresh: !!refresh,
                columns: this._colCount,
                itemWidth: this._itemWidth,
                itemHeight: this._itemHeight,
                gap: this._gap,
                selected: this._selIds.has(id),
                active: this._activeIndex === index,
                pending: this._pending.has(id),
                labels: this._labels,
            };
        }

        _applyCell(el, item, index, id, refresh) {
            if (this._cell && typeof this._cell.update === "function") {
                try {
                    this._cell.update(el, item, this._makeCtx(item, index, id, refresh));
                } catch (e) {
                    console.error("[HolafGrid] cell.update :", e);
                }
            }
        }

        _acquireCell(ctx) {
            let el;
            if (this._cellPool.length > 0) {
                el = this._cellPool.pop();
            } else if (this._cell && typeof this._cell.create === "function") {
                try {
                    el = this._cell.create(this._makeCtx(ctx.item, ctx.index, ctx.id, false));
                } catch (e) {
                    console.error("[HolafGrid] cell.create :", e);
                }
            }
            if (!el) el = document.createElement("div");
            if (!el.classList.contains("holaf-grid-cell")) el.classList.add("holaf-grid-cell");
            return el;
        }

        _poolCell(el) {
            if (this._cellPool.length < this._cellPoolMax) this._cellPool.push(el);
        }

        _acquireSkel() {
            let sk;
            if (this._skelPool.length > 0) {
                sk = this._skelPool.pop();
            } else {
                sk = document.createElement("div");
            }
            sk.className = "holaf-grid-cell holaf-grid-skeleton";
            return sk;
        }

        _poolSkel(sk) {
            this._skelPool.push(sk);
        }

        // ── Resize : conserve la rangée du haut ──────────────────────────────
        _handleResize() {
            if (this._destroyed || !this._colCount) return;
            const oldRowH = this._itemHeight + this._gap;
            const topIndex = oldRowH > 0 ? Math.floor((this._container.scrollTop || 0) / oldRowH) * this._colCount : 0;

            this._relayout();
            if (topIndex > 0 && this._colCount > 0) {
                const newRow = Math.floor(topIndex / this._colCount);
                this._container.scrollTop = newRow * (this._itemHeight + this._gap);
            }
            this._renderRange();
        }

        // ── Événements souris (délégation) ───────────────────────────────────
        _cellIndexFromEvent(e) {
            const target = e.target;
            if (!target || typeof target.closest !== "function") return -1;
            const cellEl = target.closest("[data-holaf-index]");
            if (!cellEl || !this.surface.contains(cellEl)) return -1;
            const idx = parseInt(cellEl.dataset.holafIndex, 10);
            return Number.isFinite(idx) ? idx : -1;
        }

        _handleClick(e) {
            if (this._destroyed) return;
            const target = e.target;
            if (!target || typeof target.closest !== "function") return;

            const idx = this._cellIndexFromEvent(e);
            if (idx < 0) return;
            const item = this._getAt(idx);

            // Action déléguée (icône ✎/🎥/🎵, plein écran…) : l'hôte décide.
            const actionEl = target.closest("[data-holaf-action]");
            if (actionEl) {
                const actionId = actionEl.getAttribute("data-holaf-action");
                if (this._onAction) {
                    try { this._onAction(actionId, item, idx, e); } catch (err) { console.error("[HolafGrid] onAction :", err); }
                }
                this._emit("action", { actionId, item, index: idx, event: e });
                return;
            }

            if (this._activateOnClick && item) {
                if (this._onActivate) {
                    try { this._onActivate(item, idx, "click"); } catch (err) { console.error("[HolafGrid] onActivate :", err); }
                }
                this._emit("activate", { item, index: idx, kind: "click" });
            }

            if (!this._selectable || !item) return;
            const id = this._getId(item);
            const isCheckbox = target.tagName === "INPUT";
            this._applyClickSelection(idx, id, item, {
                shift: !!e.shiftKey,
                toggle: !!(e.ctrlKey || e.metaKey || isCheckbox),
            });
        }

        _handleDblClick(e) {
            if (this._destroyed) return;
            const target = e.target;
            if (!target || typeof target.closest !== "function") return;
            if (target.closest("[data-holaf-action], input")) return;
            const idx = this._cellIndexFromEvent(e);
            if (idx < 0) return;
            const item = this._getAt(idx);
            if (!item) return;
            if (this._onActivate) {
                try { this._onActivate(item, idx, "dblclick"); } catch (err) { console.error("[HolafGrid] onActivate :", err); }
            }
            this._emit("activate", { item, index: idx, kind: "dblclick" });
        }

        _handleKey(e) {
            if (this._destroyed) return;
            if (this._canHandleKey && !this._canHandleKey(e)) return;
            this._selectionHandleKey(e);
        }

        // ── Sélection ────────────────────────────────────────────────────────
        _applyClickSelection(index, id, item, mods) {
            if (mods.shift && this._multi && this._anchorIndex >= 0) {
                if (!mods.toggle) this._selIds.clear();
                const a = Math.min(this._anchorIndex, index);
                const b = Math.max(this._anchorIndex, index);
                for (let i = a; i <= b; i++) {
                    const it = this._getAt(i);
                    if (it) this._selIds.add(this._getId(it));
                }
            } else if (mods.toggle && this._multi) {
                if (this._selIds.has(id)) this._selIds.delete(id);
                else this._selIds.add(id);
                this._anchorIndex = index;
            } else {
                this._selIds.clear();
                this._selIds.add(id);
                this._anchorIndex = index;
            }
            this._activeIndex = index;
            this._syncSelectionDom();
            this._emitSelection();
        }

        _toggleAt(index) {
            const item = this._getAt(index);
            if (!item) return;
            const id = this._getId(item);
            if (this._selIds.has(id)) this._selIds.delete(id);
            else this._selIds.add(id);
            this._anchorIndex = index;
            this._activeIndex = index;
            this._syncSelectionDom();
            this._emitSelection();
        }

        _setActive(index, scroll) {
            if (index < 0 || index >= this._getTotal()) return;
            this._activeIndex = index;
            this._anchorIndex = index;
            if (scroll) this.scrollToIndex(index, { align: "nearest" });
            this._syncSelectionDom();
            const item = this._getAt(index);
            this._emit("navigate", { item, index });
            if (this._onNavigate) {
                try { this._onNavigate(item, index); } catch (e) { console.error("[HolafGrid] onNavigate :", e); }
            }
        }

        _syncSelectionDom() {
            for (const [id, entry] of this._cells) {
                const el = entry.el;
                el.classList.toggle("holaf-grid-cell--selected", this._selIds.has(id));
                el.classList.toggle("holaf-grid-cell--active", this._activeIndex === entry.index);
                const cb = el.querySelector ? el.querySelector('input[type="checkbox"]') : null;
                if (cb) cb.checked = this._selIds.has(id);
            }
        }

        _resolveSelectedItems() {
            const out = [];
            const sel = this._selIds;
            if (this._source && typeof this._source.forEachLoaded === "function") {
                this._source.forEachLoaded((item) => {
                    if (item && sel.has(this._getId(item))) out.push(item);
                });
            } else if (this._items) {
                for (const item of this._items) {
                    if (item && sel.has(this._getId(item))) out.push(item);
                }
            }
            return out;
        }

        _emitSelection() {
            const ids = Array.from(this._selIds);
            const items = this._resolveSelectedItems();
            const payload = { ids, items };
            this._emit("selectionchange", payload);
            if (this._onSelectionChange) {
                try { this._onSelectionChange(ids, items); } catch (e) { console.error("[HolafGrid] onSelectionChange :", e); }
            }
        }

        _pageStep() {
            const rowH = this._itemHeight + this._gap;
            const rows = Math.max(1, Math.floor((this._container.clientHeight || 0) / (rowH || 1)));
            return rows * Math.max(1, this._colCount);
        }

        // Navigation clavier GÉNÉRIQUE (←/→ ±1, ↑/↓ ±colonnes, Home/End,
        // PageUp/PageDown = une page, Espace = toggle sélection du curseur,
        // Entrée = activation). Retourne true si la touche a été consommée.
        _selectionHandleKey(e) {
            const total = this._getTotal();
            if (!total) return false;
            const cols = Math.max(1, this._colCount);
            const idx = this._activeIndex;
            const cols0 = (i) => (i < 0 ? 0 : i);

            switch (e.key) {
                case "ArrowRight":
                    e.preventDefault();
                    this._setActive(Math.min(total - 1, cols0(idx) + 1), true);
                    return true;
                case "ArrowLeft":
                    e.preventDefault();
                    this._setActive(Math.max(0, cols0(idx) - 1), true);
                    return true;
                case "ArrowDown":
                    e.preventDefault();
                    this._setActive(Math.min(total - 1, cols0(idx) + cols), true);
                    return true;
                case "ArrowUp":
                    e.preventDefault();
                    this._setActive(Math.max(0, cols0(idx) - cols), true);
                    return true;
                case "Home":
                    e.preventDefault();
                    this._setActive(0, true);
                    return true;
                case "End":
                    e.preventDefault();
                    this._setActive(total - 1, true);
                    return true;
                case "PageDown":
                    e.preventDefault();
                    this._setActive(Math.min(total - 1, cols0(idx) + this._pageStep()), true);
                    return true;
                case "PageUp":
                    e.preventDefault();
                    this._setActive(Math.max(0, cols0(idx) - this._pageStep()), true);
                    return true;
                case " ":
                case "Spacebar":
                    if (idx < 0) return false;
                    e.preventDefault();
                    this._toggleAt(idx);
                    return true;
                case "Enter": {
                    if (idx < 0) return false;
                    e.preventDefault();
                    const item = this._getAt(idx);
                    if (item && this._onActivate) {
                        try { this._onActivate(item, idx, "activate"); } catch (err) { console.error("[HolafGrid] onActivate :", err); }
                    }
                    this._emit("activate", { item, index: idx, kind: "activate" });
                    return true;
                }
                default:
                    return false;
            }
        }

        // Vue `selection` exposée à l'hôte.
        get selection() {
            const grid = this;
            return {
                ids() { return Array.from(grid._selIds); },
                items() { return grid._resolveSelectedItems(); },
                anchor() { return grid._anchorIndex; },
                setAnchor(indexOrId) {
                    if (typeof indexOrId === "number") {
                        grid._anchorIndex = indexOrId;
                    } else {
                        for (let i = 0; i < grid._getTotal(); i++) {
                            const it = grid._getAt(i);
                            if (it && grid._getId(it) === indexOrId) { grid._anchorIndex = i; break; }
                        }
                    }
                    return grid._anchorIndex;
                },
                clear() {
                    grid._selIds.clear();
                    grid._syncSelectionDom();
                    grid._emitSelection();
                    return grid;
                },
                toggle(id) {
                    if (grid._selIds.has(id)) grid._selIds.delete(id);
                    else grid._selIds.add(id);
                    grid._syncSelectionDom();
                    grid._emitSelection();
                    return grid;
                },
                set(ids, opts) {
                    grid._selIds = new Set(Array.isArray(ids) ? ids : []);
                    grid._syncSelectionDom();
                    if (!(opts && opts.silent)) grid._emitSelection();
                    return grid;
                },
                handleKey(e) { return grid._selectionHandleKey(e); },
            };
        }

        // ── Scroll / alignement ──────────────────────────────────────────────
        scrollToIndex(index, opts) {
            const align = (opts && opts.align) || "nearest";
            const total = this._getTotal();
            if (index < 0 || index >= total) return this;
            if (!this._colCount) this._relayout();

            const i = Math.floor(index);
            const row = Math.floor(i / this._colCount);
            const rowH = this._itemHeight + this._gap;
            const itemTop = row * rowH;
            const itemBottom = itemTop + this._itemHeight;
            const viewTop = this._container.scrollTop || 0;
            const viewH = this._container.clientHeight || 0;

            let next = viewTop;
            if (align === "start") {
                next = itemTop;
            } else if (align === "end") {
                next = itemBottom - viewH;
            } else if (align === "center") {
                next = itemTop - (viewH - this._itemHeight) / 2;
            } else { // nearest
                if (itemTop < viewTop) next = itemTop;
                else if (itemBottom > viewTop + viewH) next = itemBottom - viewH;
            }
            if (opts && opts.smooth && typeof this._container.scrollTo === "function") {
                try { this._container.scrollTo({ top: Math.max(0, next), behavior: "smooth" }); } catch (e) { /* ignore */ }
            } else {
                this._container.scrollTop = Math.max(0, next);
            }
            this.render();
            return this;
        }

        ensureVisible(index) { return this.scrollToIndex(index, { align: "nearest" }); }

        // ── Refresh / pending ────────────────────────────────────────────────
        refresh(id) {
            if (this._destroyed) return this;
            const entry = this._cells.get(id);
            if (!entry) return this;
            const item = this._getAt(entry.index);
            if (!item) return this;
            this._applyCell(entry.el, item, entry.index, id, true);
            return this;
        }

        markPending(id, ms) {
            this._pending.add(id);
            const entry = this._cells.get(id);
            if (entry) entry.el.classList.add("holaf-grid-cell--pending");
            if (this._pendingTimers.has(id)) {
                clearTimeout(this._pendingTimers.get(id));
                this._pendingTimers.delete(id);
            }
            if (typeof ms === "number" && ms >= 0) {
                const timer = setTimeout(() => {
                    this._pendingTimers.delete(id);
                    this._pending.delete(id);
                    const e = this._cells.get(id);
                    if (e) e.el.classList.remove("holaf-grid-cell--pending");
                }, ms);
                this._pendingTimers.set(id, timer);
            }
            return this;
        }

        // ── Événements ───────────────────────────────────────────────────────
        on(evt, cb) {
            if (typeof cb !== "function") return () => {};
            if (!this._listeners.has(evt)) this._listeners.set(evt, new Set());
            this._listeners.get(evt).add(cb);
            return () => this.off(evt, cb);
        }

        off(evt, cb) {
            const set = this._listeners.get(evt);
            if (set) set.delete(cb);
            return this;
        }

        _emit(evt, payload) {
            const set = this._listeners.get(evt);
            if (!set || set.size === 0) return;
            for (const cb of Array.from(set)) {
                try { cb(payload, this); } catch (e) { console.error("[HolafGrid] listener " + evt + " :", e); }
            }
        }

        _emitVisible(start, end, ids) {
            const payload = { start, end, ids };
            this._emit("visible", payload);
            if (this._onVisibleRange) {
                try { this._onVisibleRange(start, end, ids); } catch (e) { console.error("[HolafGrid] onVisibleRange :", e); }
            }
        }

        // ── Cycle de vie ─────────────────────────────────────────────────────
        destroy() {
            if (this._destroyed) return;
            this._destroyed = true;

            if (this._rafId) {
                if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
                    window.cancelAnimationFrame(this._rafId);
                } else {
                    clearTimeout(this._rafId);
                }
                this._rafId = null;
            }
            for (const timer of this._pendingTimers.values()) clearTimeout(timer);
            this._pendingTimers.clear();
            this._pending.clear();

            this._container.removeEventListener("scroll", this._onScroll);
            this._container.removeEventListener("click", this._onClick);
            this._container.removeEventListener("dblclick", this._onDblClick);
            if (this._keyboard) this._container.removeEventListener("keydown", this._onKey);
            if (this._resizeObserver) {
                try { this._resizeObserver.disconnect(); } catch (e) { /* ignore */ }
                this._resizeObserver = null;
            }

            this._resetCells();
            this._cellPool.length = 0;
            this._skelPool.length = 0;
            this._listeners.clear();

            if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);

            if (this._ownsCss) {
                liveInstances = Math.max(0, liveInstances - 1);
                if (liveInstances === 0) removeCss();
            }
        }
    }

    function create(container, options) {
        return new Grid(container, options);
    }

    return {
        version: VERSION,
        create,
        getCss,
        configure,
        setStyleNonce,
    };
})();

// Exposition globale (scripts classiques de la page).
if (typeof window !== "undefined") {
    window.HolafGrid = HolafGrid;
}

// Export ESM (import { HolafGrid } from "./holaf-virtual-grid.js").
export { HolafGrid, VERSION };
