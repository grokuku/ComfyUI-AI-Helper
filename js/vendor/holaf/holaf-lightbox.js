/* ═══════════════════════════════════════════════════════════════════════════
 * Holaf UI — Brique HolafLightbox · version 0.1.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Visionneuse plein écran / inline GÉNÉRIQUE et INSTANCIABLE (zéro état de
 * module hors le <style> partagé). Elle ne connaît QUE :
 *   - une SOURCE d'items (tableau ou collection injectée) + une clé getId ;
 *   - un RENDERER média injecté renderMedia({container,item,mode,onReady,signal})
 *     -> { el, destroy } — c'est LUI qui fabrique/actualise <img>/<video>/<audio>
 *     (ou l'éditeur d'une galerie). La brique n'impose aucun balisage média ;
 *   - un VIEWPORT de zoom/pan INJECTÉ (HolafViewport) — la brique ne l'importe
 *     jamais (zéro import croisé, cf. holaf-viewport).
 *
 * Elle absorbe, SANS RÉGRESSION, la logique historique de la visionneuse de la
 * galerie du node :
 *   - MACHINE À ÉTATS de vue : idle ⇄ zoom ⇄ fullscreen, avec RESTAURATION de
 *     la vue source (ouvrir fullscreen depuis zoom, puis Échap → retour zoom) ;
 *   - NAVIGATION item→item (‹/› + wrap-around) et navigation « grille »
 *     (↑/↓ = ±colonnes via getColumnCount de l'hôte) ;
 *   - PRÉCHARGEMENT des N items suivants (immédiat + lot débouncé) avec
 *     annulation des jobs périmés ;
 *   - GARDE DE STALE-LOAD (serial) : un renderMedia/onReady périmé (navigation
 *     rapide) est ignoré, et l'AbortSignal/`destroy` de l'appel précédent est
 *     déclenché avant le suivant ;
 *   - RACCOURCIS CLAVIER (‹/›, ↑/↓, Entrée, Ctrl+Entrée, Échap, +/-, 0) avec
 *     un garde-fou injectable shouldHandleKey(e) ;
 *   - DÉLÉGATION ZOOM/PAN à HolafViewport (instance créée par vue, options
 *     injectées via viewportOptions, instance restituée via onViewport) ;
 *   - CONTENEURS : si l'hôte ne fournit pas de conteneur, la brique crée son
 *     propre overlay (barre ‹ › ✖ + spinner, CSS scopé). L'hôte peut aussi
 *     fournir ses conteneurs (ex. la galerie du node, dont l'éditeur requête
 *     ses sélecteurs) — la brique gère alors l'état/visibilité/nav/spinner.
 *
 * Zéro dépendance runtime, aucun import croisé.
 *
 * CSS-INJECTANTE : getCss() expose le CSS complet ; l'option
 * { css: { injectStyles:false, nonce } } (ou HolafLightbox.configure/
 * setStyleNonce) contrôle l'injection. CSS scopé sous .holaf-lightbox-* et
 * variables --hl-* posées sur la racine de chaque overlay, JAMAIS sur :root.
 *
 * Fichier DUAL : classe ES (export) + global window.HolafLightbox — se charge
 * via <script type="module"> ou `import { HolafLightbox }`.
 *
 * VOLONTAIREMENT ABSENT (reste à l'hôte) : édition d'image (crop/masque), la
 * source réseau concrète (URLs, cache), la grille elle-même (HolafGrid), la
 * visibilité de la galerie.
 * ═════════════════════════════════════════════════════════════════════════ */

const VERSION = "0.1.0";

const HolafLightbox = (function () {
    "use strict";

    const CSS_ID = "holaf-lightbox-style";

    // ─── CSS auto-injecté (une seule fois pour tout le module) ──────────────
    // Classes scopées .holaf-lightbox-* ; variables --hl-* posées sur la racine
    // de chaque overlay (.holaf-lightbox-overlay), jamais sur :root.
    const CSS = `
.holaf-lightbox-overlay {
    position: fixed;
    top: 0; left: 0;
    width: 100vw; height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.9);
    overflow: hidden;
    margin: 0; padding: 0;
    box-sizing: border-box;
    --hl-bg: rgba(0, 0, 0, 0.9);
    --hl-nav-bg: rgba(30, 30, 30, 0.55);
    --hl-nav-bg-hover: rgba(60, 60, 60, 0.85);
    --hl-fg: #ffffff;
    --hl-accent: #6366f1;
}
.holaf-lightbox-surface {
    position: relative;
    width: 100%; height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
}
.holaf-lightbox-content {
    width: 100%; height: 100%;
    max-width: 100%; max-height: 100%;
    object-fit: contain;
    transform-origin: top left;
    display: block;
}
.holaf-lightbox-content--image { cursor: grab; transition: transform 0.2s ease-out; }
.holaf-lightbox-nav {
    position: absolute;
    z-index: 10;
    background: var(--hl-nav-bg);
    color: var(--hl-fg);
    border: 1px solid rgba(255, 255, 255, 0.25);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 28px;
    line-height: 1;
    padding: 0;
    user-select: none;
    touch-action: manipulation;
}
.holaf-lightbox-nav:hover { background: var(--hl-nav-bg-hover); }
.holaf-lightbox-nav--prev, .holaf-lightbox-nav--next {
    top: 50%;
    transform: translateY(-50%);
    width: 48px; height: 80px;
}
.holaf-lightbox-nav--prev { left: 15px; }
.holaf-lightbox-nav--next { right: 15px; }
.holaf-lightbox-nav--close {
    top: 20px; right: 20px;
    width: 40px; height: 40px;
    border-radius: 50%;
    font-size: 20px;
}
.holaf-lightbox-spinner {
    position: absolute;
    top: 50%; left: 50%;
    width: 32px; height: 32px;
    margin: -16px 0 0 -16px;
    border: 3px solid rgba(255, 255, 255, 0.35);
    border-top-color: var(--hl-fg);
    border-radius: 50%;
    animation: holaf-lightbox-spin 0.8s linear infinite;
    pointer-events: none;
    z-index: 100;
}
@keyframes holaf-lightbox-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
    .holaf-lightbox-spinner { animation: none; }
    .holaf-lightbox-content--image { transition: none; }
}
`;

    // ─── Nonce CSP (OPTIONNEL) ───────────────────────────────────────────────
    let styleNonce = null;
    // Nombre d'instances VIVANTES ayant demandé l'injection : le <style> n'est
    // retiré qu'à la destruction de la DERNIÈRE (les instances partagent l'id).
    let liveInstances = 0;
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

    function configure(opts) {
        opts = opts || {};
        if (opts.injectStyles !== undefined) injectStylesGlobal = opts.injectStyles !== false;
        if (opts.nonce !== undefined) setStyleNonce(opts.nonce);
    }

    // ─── Utilitaires ─────────────────────────────────────────────────────────
    const DEFAULT_LABELS = {
        prev: "Précédent",
        next: "Suivant",
        close: "Fermer",
        region: "Visionneuse",
    };

    function defaultGetId(item) {
        if (!item) return null;
        if (item.id !== undefined && item.id !== null) return item.id;
        if (item.path_canon !== undefined) return item.path_canon;
        return null;
    }

    function defaultUrlFor(item, size) {
        if (!item) return null;
        if (size === "thumb") {
            return item.thumb || item.thumbnail || item.thumbUrl || item.url || item.src || item.path || null;
        }
        return item.full || item.url || item.src || item.path || null;
    }

    function fn(v) { return typeof v === "function" ? v : null; }
    function isNode(obj) { return !!(obj && typeof obj === "object" && obj.nodeType === 1); }

    // ─── Classe Lightbox ─────────────────────────────────────────────────────
    class Lightbox {
        constructor(options) {
            const o = options || {};
            this._opts = o;

            this._host = o.host || (typeof document !== "undefined" ? document.body : null);
            this._zIndex = (o.zIndex === undefined || o.zIndex === null) ? 60000 : o.zIndex;
            this._getId = fn(o.getId) || defaultGetId;
            this._urlFor = fn(o.urlFor) || defaultUrlFor;

            this._preload = (o.preload === undefined) ? 10 : Math.max(0, Math.floor(Number(o.preload) || 0));
            this._preloadDebounce = (o.preloadDebounce === undefined) ? 400 : Math.max(0, Number(o.preloadDebounce) || 0);
            this._shouldPreload = fn(o.shouldPreload);
            this._modes = Array.isArray(o.modes) ? o.modes.slice() : ["zoom", "fullscreen"];
            this._labels = Object.assign({}, DEFAULT_LABELS, o.labels || {});
            this._shouldHandleKey = fn(o.shouldHandleKey) || (() => true);

            this._getColumnCount = fn(o.getColumnCount) || (() => (typeof o.columns === "number" ? o.columns : 1));
            this._getIndex = fn(o.getIndex);

            // Viewport injecté : soit une implémentation { create }, soit une
            // fabrique par vue. AUCUN import croisé — si rien n'est fourni, la
            // brique fonctionne sans zoom/pan (repli documenté).
            this._viewportImpl = o.viewport || (typeof window !== "undefined" ? window.HolafViewport : null) || null;
            this._viewportFactory = fn(o.viewportFactory);
            this._viewportOptions = (o.viewportOptions && (typeof o.viewportOptions === "function" || typeof o.viewportOptions === "object"))
                ? o.viewportOptions : {};

            // Renderer média injecté (défaut : <img> simple).
            this._renderMedia = fn(o.renderMedia) || ((ctx) => this._defaultRenderMedia(ctx));

            this._handlers = {
                open: fn(o.onOpen),
                close: fn(o.onClose),
                navigate: fn(o.onNavigate),
                ready: fn(o.onReady),
                error: fn(o.onError),
                resume: fn(o.onResume),
                beforeNavigate: fn(o.beforeNavigate),
                viewport: fn(o.onViewport),
            };

            // Source.
            this._items = null;
            this._source = null;

            // État.
            this._index = -1;
            this._currentItem = null;
            this._stack = [];      // modes ouverts, du bas vers le haut
            this._views = {};      // mode -> ViewState
            this._listeners = new Map();
            this._destroyed = false;

            // Préchargement.
            this._preloadJobs = new Set();
            this._preloadTimer = null;

            // CSS.
            const cssOpts = o.css || {};
            const inject = (cssOpts.injectStyles !== undefined)
                ? (cssOpts.injectStyles !== false)
                : injectStylesGlobal;
            if (inject) {
                ensureCss(cssOpts.nonce);
                this._ownsCss = true;
                liveInstances += 1;
            } else {
                this._ownsCss = false;
            }

            // Vues fournies à la construction.
            const viewCfgs = o.views || {};
            Object.keys(viewCfgs).forEach((mode) => {
                this.addView(mode, viewCfgs[mode] || {});
            });
        }

        // ── Source de données ────────────────────────────────────────────────
        setItems(items) {
            this._source = null;
            this._items = Array.isArray(items) ? items : [];
            return this;
        }

        /**
         * Branche une COLLECTION générique :
         *   { getAt(index) (sync|async), total()|total|length,
         *     getAtSync?(index) (sync, pour le préchargement) }.
         * Compatible holaf-collection (at/total).
         */
        setSource(collection) {
            if (!collection || typeof collection !== "object") {
                this._source = null;
                this._items = null;
                return this;
            }
            const getAt = (typeof collection.getAt === "function")
                ? collection.getAt.bind(collection)
                : (typeof collection.at === "function" ? collection.at.bind(collection) : () => null);
            const getAtSync = (typeof collection.getAtSync === "function")
                ? collection.getAtSync.bind(collection)
                : null;
            const total = (typeof collection.total === "function")
                ? collection.total.bind(collection)
                : (() => {
                    if (typeof collection.total === "number") return collection.total;
                    return collection.length || 0;
                });
            this._source = { getAt, getAtSync, total };
            this._items = null;
            return this;
        }

        _getTotal() {
            if (this._source) {
                const n = Number(this._source.total());
                return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
            }
            if (this._items) return this._items.length;
            return 0;
        }

        _getAtSync(index) {
            if (index < 0) return null;
            if (this._items) return this._items[index] !== undefined ? this._items[index] : null;
            if (this._source) {
                if (this._source.getAtSync) {
                    try { return this._source.getAtSync(index) || null; } catch (e) { return null; }
                }
                let r;
                try { r = this._source.getAt(index); } catch (e) { return null; }
                return (r && typeof r.then === "function") ? null : (r || null);
            }
            return null;
        }

        async _resolveItem(index) {
            if (index < 0) return null;
            if (this._source) {
                let r;
                try { r = this._source.getAt(index); } catch (e) { return null; }
                if (r && typeof r.then === "function") r = await r;
                return r || null;
            }
            if (this._items) return this._items[index] || null;
            return null;
        }

        _currentIndex() {
            if (this._getIndex) {
                const i = Number(this._getIndex());
                if (Number.isFinite(i)) return i;
            }
            return this._index;
        }

        // Index de l'item à ouvrir : index courant s'il correspond, sinon
        // recherche dans la source (tableau), sinon index courant.
        _resolveOpenIndex(item) {
            const cur = this._currentIndex();
            if (item === undefined || item === null) return cur;
            if (cur >= 0) {
                const at = this._getAtSync(cur);
                if (at === item) return cur;
                if (at && this._getId(at) === this._getId(item)) return cur;
            }
            if (this._items) {
                const i = this._items.indexOf(item);
                if (i >= 0) return i;
            }
            return cur;
        }

        current() {
            const i = this._currentIndex();
            if (i < 0) return null;
            if (this._index === i && this._currentItem) return this._currentItem;
            return this._getAtSync(i) || this._currentItem || null;
        }

        // ── Vues (conteneurs) ────────────────────────────────────────────────
        addView(mode, config) {
            if (this._destroyed) return false;
            if (this._modes.indexOf(mode) === -1) this._modes.push(mode);
            if (this._views[mode]) {
                this._teardownView(this._views[mode]);
            }
            this._views[mode] = this._createView(mode, config || {});
            return true;
        }

        _getView(mode) {
            if (this._views[mode]) return this._views[mode];
            if (this._modes.indexOf(mode) === -1) return null;
            const cfg = (this._opts.views && this._opts.views[mode]) || {};
            this._views[mode] = this._createView(mode, cfg);
            return this._views[mode];
        }

        _createView(mode, cfg) {
            const provided = isNode(cfg.container);
            const container = provided ? cfg.container : this._buildDefaultOverlay();
            let surface = container;
            if (!provided) {
                surface = container.querySelector(".holaf-lightbox-surface") || container;
            }
            const view = {
                mode,
                config: cfg,
                container,
                surface,
                display: cfg.display || "flex",
                element: null,
                renderResult: null,
                renderSeq: 0,
                abort: null,
                viewport: null,
                viewportElement: null,
                spinner: null,
                nav: null,
                ownsContainer: !provided,
            };
            const wantChrome = (cfg.chrome !== undefined) ? !!cfg.chrome : !provided;
            if (wantChrome) this._buildChrome(view);
            this._hideView(view);
            return view;
        }

        _buildDefaultOverlay() {
            const overlay = document.createElement("div");
            overlay.className = "holaf-lightbox-overlay";
            overlay.setAttribute("role", "dialog");
            overlay.setAttribute("aria-label", this._labels.region);
            if (this._zIndex !== null && this._zIndex !== undefined) {
                overlay.style.zIndex = String(this._zIndex);
            }
            const surface = document.createElement("div");
            surface.className = "holaf-lightbox-surface";
            overlay.appendChild(surface);
            if (this._host) this._host.appendChild(overlay);
            return overlay;
        }

        _buildChrome(view) {
            const parent = view.container;
            const labels = this._labels;
            const make = (cls, label, handler) => {
                const b = document.createElement("button");
                b.type = "button";
                b.className = "holaf-lightbox-nav " + cls;
                b.textContent = label;
                b.title = label;
                b.setAttribute("aria-label", label);
                b.addEventListener("click", (e) => { e.stopPropagation(); handler(); });
                return b;
            };
            view.nav = {
                prev: make("holaf-lightbox-nav--prev", labels.prev, () => this.navigate(-1)),
                next: make("holaf-lightbox-nav--next", labels.next, () => this.navigate(1)),
                close: make("holaf-lightbox-nav--close", labels.close, () => this.back()),
            };
            parent.appendChild(view.nav.prev);
            parent.appendChild(view.nav.next);
            parent.appendChild(view.nav.close);

            const spinner = document.createElement("div");
            spinner.className = "holaf-lightbox-spinner";
            spinner.setAttribute("aria-hidden", "true");
            parent.appendChild(spinner);
            view.spinner = spinner;
            this._hideSpinner(view);
        }

        _showView(view) { if (view.container) view.container.style.display = view.display; }
        _hideView(view) { if (view.container) view.container.style.display = "none"; }

        _showSpinner(view) { if (view.spinner) view.spinner.style.display = "block"; }
        _hideSpinner(view) { if (view.spinner) view.spinner.style.display = "none"; }

        _applyVisibility() {
            const top = this._topMode();
            for (const mode in this._views) {
                const v = this._views[mode];
                if (mode === top) this._showView(v);
                else this._hideView(v);
            }
        }

        // ── Machine à états de vue ───────────────────────────────────────────
        mode() { return this._topMode(); }
        isOpen() { return this._stack.length > 0; }
        _topMode() { return this._stack.length ? this._stack[this._stack.length - 1] : null; }
        _topView() { const m = this._topMode(); return m ? (this._views[m] || null) : null; }

        async openZoom(item, opts) { return this._open("zoom", item, opts); }
        async openFullscreen(item, opts) { return this._open("fullscreen", item, opts); }

        async _open(mode, item, opts) {
            if (this._destroyed) return false;
            const view = this._getView(mode);
            if (!view) return false;
            opts = opts || {};

            let idx = this._resolveOpenIndex(item);
            if (item === undefined || item === null) item = await this._resolveItem(idx);
            if (!item && idx < 0 && this._getTotal() > 0) {
                idx = 0;
                item = await this._resolveItem(0);
            }
            if (!item) return false;

            if (idx >= 0) this._index = idx;
            this._currentItem = item;

            const alreadyTop = (this._topMode() === mode);
            if (!alreadyTop) {
                if (mode === "fullscreen" && this._stack.indexOf("zoom") !== -1) {
                    // Ouverture plein écran DEPUIS la vue zoom : on empile (la vue
                    // zoom reste vivante, cachée) → Échap restaurera la vue source.
                    this._stack.push("fullscreen");
                } else {
                    // Nouvelle vue de base : on démonte silencieusement l'ancienne.
                    while (this._stack.length) this._closeTop({ silent: true });
                    this._stack = [mode];
                }
            }
            this._applyVisibility();

            if (!alreadyTop) {
                this._emit("open", { mode, item });
                this._h("open", mode, item);
            }
            await this._renderView(view, item, { immediate: true });
            this._preloadNext();
            return true;
        }

        back() {
            if (!this._stack.length) return false;
            return this._closeTop();
        }

        close() {
            if (!this._stack.length) return false;
            const top = this._topMode();
            while (this._stack.length) this._closeTop({ silent: true });
            this._emit("close", { mode: top });
            this._h("close", top);
            return true;
        }

        _closeTop(opts) {
            opts = opts || {};
            const mode = this._stack.pop();
            if (mode === undefined) return false;
            const view = this._views[mode];
            if (view) this._destroyView(view);
            this._applyVisibility();
            if (!opts.silent) {
                this._emit("close", { mode });
                this._h("close", mode);
            }
            const top = this._topMode();
            if (top && !opts.silent) {
                const item = this.current();
                this._emit("resume", { mode: top, item });
                this._h("resume", top, item);
            }
            return true;
        }

        // ── Navigation ───────────────────────────────────────────────────────
        async navigate(dir) {
            if (this._destroyed) return false;
            const total = this._getTotal();
            if (!total) return false;
            const cur = this._currentIndex();
            let next = (cur === -1) ? 0 : cur + dir;
            if (next < 0) next = total - 1;
            else if (next >= total) next = 0;
            return this._goTo(next, dir, {});
        }

        async navigateGrid(dir) {
            if (this._destroyed) return false;
            const total = this._getTotal();
            if (!total) return false;
            const cols = Math.max(1, Math.floor(Number(this._getColumnCount())) || 1);
            const cur = this._currentIndex();
            if (cur === -1) return this._goTo(0, dir, { grid: true, skipBefore: true });
            const next = cur + dir * cols;
            if (next < 0 || next >= total) return false;
            return this._goTo(next, dir, { grid: true, skipBefore: true });
        }

        async _goTo(index, dir, opts) {
            opts = opts || {};
            const before = this._handlers.beforeNavigate;
            if (before && !opts.skipBefore) {
                let ok = true;
                try { ok = await before(dir, this.current(), index); } catch (e) { ok = true; }
                if (ok === false || ok === "cancel") return false;
            }
            const item = await this._resolveItem(index);
            if (!item) return false;
            this._index = index;
            this._currentItem = item;

            this._emit("navigate", { dir, item, index, grid: !!opts.grid });
            this._h("navigate", dir, item, index, !!opts.grid);

            const top = this._topMode();
            if (top && this._views[top]) {
                await this._renderView(this._views[top], item, { immediate: false });
            }
            this._preloadNext();
            return true;
        }

        // ── Rendu média (renderer injecté) + garde serial ────────────────────
        async _renderView(view, item, opts) {
            if (this._destroyed) return;
            opts = opts || {};
            const seq = ++view.renderSeq;

            // Annule l'appel précédent (et le signal associé).
            if (view.abort) { try { view.abort.abort(); } catch (e) { /* ignore */ } }
            if (view.renderResult && typeof view.renderResult.destroy === "function") {
                try { view.renderResult.destroy(); } catch (e) { console.error("[HolafLightbox] destroy :", e); }
            }
            view.renderResult = null;

            const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
            view.abort = ctrl;
            const signal = ctrl ? ctrl.signal : undefined;

            if (view.spinner) this._showSpinner(view);

            const onReady = (payload) => {
                if (seq !== view.renderSeq) return; // callback périmé — ignoré
                this._hideSpinner(view);
                this._readyView(view, item, payload);
            };

            let result;
            try {
                result = await this._renderMedia({
                    container: view.surface,
                    item,
                    mode: view.mode,
                    onReady,
                    signal,
                    viewport: view.viewport,
                    lightbox: this,
                    immediate: !!opts.immediate,
                    index: this._currentIndex(),
                });
            } catch (err) {
                if (seq === view.renderSeq) {
                    this._hideSpinner(view);
                    this._emit("error", { mode: view.mode, item, error: err });
                    this._h("error", view.mode, item, err);
                }
                return;
            }

            // Résultat d'un rendu périmé entre-temps → on le détruit aussitôt.
            if (seq !== view.renderSeq) {
                if (result && typeof result.destroy === "function") {
                    try { result.destroy(); } catch (e) { /* ignore */ }
                }
                return;
            }

            view.renderResult = result || null;
            const el = (result && result.el) || (result && result.elements && result.elements[0]) || null;
            if (el && isNode(el)) {
                view.element = el;
                this._ensureViewport(view, el);
            }
        }

        _readyView(view, item, payload) {
            if (view.viewport && payload && (payload.width || payload.height)) {
                try { view.viewport.setImageSize(payload.width || 0, payload.height || 0); } catch (e) { /* ignore */ }
            } else if (view.viewport && payload && payload.fit && typeof view.viewport.fit === "function") {
                try { view.viewport.fit(); } catch (e) { /* ignore */ }
            }
            this._emit("ready", { mode: view.mode, item, payload: payload || {} });
            this._h("ready", view.mode, item, payload || {});
        }

        _defaultRenderMedia(ctx) {
            const img = document.createElement("img");
            img.className = "holaf-lightbox-content holaf-lightbox-content--image";
            img.draggable = false;
            img.alt = "";
            const url = this._urlForItem(ctx.item, "full");
            img.onload = () => ctx.onReady({ width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = () => ctx.onReady({});
            img.src = url || "";
            ctx.container.appendChild(img);
            return {
                el: img,
                destroy() {
                    img.onload = null;
                    img.onerror = null;
                    img.src = "";
                    if (img.parentNode) img.parentNode.removeChild(img);
                },
            };
        }

        _urlForItem(item, size) {
            try { return this._urlFor(item, size); } catch (e) { return null; }
        }

        // ── Viewport injecté (zoom/pan) ──────────────────────────────────────
        _resolveViewportOptions(view, element) {
            let base = {};
            if (typeof this._viewportOptions === "function") {
                base = this._viewportOptions(view.mode, view.container, element) || {};
            } else if (this._viewportOptions && typeof this._viewportOptions === "object") {
                base = this._viewportOptions;
            }
            const opts = Object.assign({}, base);
            if (opts.content === undefined) opts.content = element;
            if (opts.dragTarget === undefined) opts.dragTarget = element;
            return opts;
        }

        _ensureViewport(view, element) {
            if (view.config && view.config.viewport === false) return null;
            if (view.viewport && view.viewportElement === element) return view.viewport;
            if (view.viewport) this._destroyViewport(view);

            const impl = this._viewportFactory
                ? this._viewportFactory(view.mode, view.container, element)
                : this._viewportImpl;
            if (!impl || typeof impl.create !== "function") return null;

            let vp = null;
            try {
                vp = impl.create(view.container, this._resolveViewportOptions(view, element));
            } catch (e) {
                this._emit("error", { mode: view.mode, item: this.current(), error: e });
                this._h("error", view.mode, this.current(), e);
                return null;
            }
            view.viewport = vp;
            view.viewportElement = element;
            this._emit("viewport", { mode: view.mode, viewport: vp });
            this._h("viewport", view.mode, vp, element);
            return vp;
        }

        _destroyViewport(view) {
            if (!view.viewport) return;
            try { view.viewport.destroy(); } catch (e) { /* ignore */ }
            view.viewport = null;
            view.viewportElement = null;
            this._emit("viewport", { mode: view.mode, viewport: null });
            this._h("viewport", view.mode, null, null);
        }

        // ── Zoom programmatique (+/-, 0) ─────────────────────────────────────
        zoomBy(factor) {
            const v = this._topView();
            if (v && v.viewport && typeof v.viewport.zoomBy === "function") {
                v.viewport.zoomBy(factor);
                return true;
            }
            return false;
        }

        setZoom(scale, clientX, clientY) {
            const v = this._topView();
            if (v && v.viewport && typeof v.viewport.setScale === "function") {
                v.viewport.setScale(scale, clientX, clientY);
                return true;
            }
            return false;
        }

        resetZoom() {
            const v = this._topView();
            if (v && v.viewport && typeof v.viewport.reset === "function") {
                v.viewport.reset();
                return true;
            }
            return false;
        }

        // ── Préchargement ────────────────────────────────────────────────────
        preload() { return this._preload; }

        preloadAround(index) {
            const i = (typeof index === "number") ? index : this._currentIndex();
            this._preloadBatch(i);
        }

        _preloadNext() {
            const idx = this._currentIndex();
            const total = this._getTotal();
            if (idx < 0 || total <= 0) return;

            // Chargement immédiat du suivant (réponse instantanée au prochain ‹/›).
            if (idx + 1 < total) this._preloadOne(idx + 1);

            // Lot débouncé — part quand l'utilisateur a arrêté de naviguer.
            if (this._preloadTimer) clearTimeout(this._preloadTimer);
            if (this._preload <= 0) return;
            this._preloadTimer = setTimeout(() => {
                this._preloadTimer = null;
                this._preloadBatch(idx);
            }, this._preloadDebounce);
        }

        _preloadBatch(fromIndex) {
            // Annule le lot périmé.
            this._cancelPreloads();
            const total = this._getTotal();
            if (fromIndex < 0 || total <= 0) return;
            const start = Math.max(0, fromIndex + 1);
            const end = Math.min(total - 1, fromIndex + this._preload);
            for (let i = start; i <= end; i++) this._preloadOne(i);
        }

        _preloadOne(index) {
            const item = this._getAtSync(index);
            if (!item) return;
            if (this._shouldPreload) {
                let ok = true;
                try { ok = this._shouldPreload(item); } catch (e) { ok = true; }
                if (!ok) return;
            }
            const url = this._urlForItem(item, "full");
            if (!url) return;
            if (typeof Image === "undefined") return;
            const img = new Image();
            this._preloadJobs.add(img);
            const done = () => { this._preloadJobs.delete(img); };
            img.onload = done;
            img.onerror = done;
            img.src = url;
        }

        _cancelPreloads() {
            for (const img of Array.from(this._preloadJobs)) {
                try { img.src = ""; } catch (e) { /* ignore */ }
            }
            this._preloadJobs.clear();
        }

        // ── Clavier ──────────────────────────────────────────────────────────
        handleKey(e) {
            if (this._destroyed || !e || typeof e.key !== "string") return false;
            if (this._shouldHandleKey && !this._shouldHandleKey(e)) return false;

            switch (e.key) {
                case "Escape":
                    if (!this._stack.length) return false;
                    e.preventDefault();
                    this.back();
                    return true;
                case "Enter": {
                    e.preventDefault();
                    const fullscreen = !!(e.ctrlKey || e.metaKey);
                    const openCurrent = () => {
                        if (fullscreen) this.openFullscreen(this.current());
                        else this.openZoom(this.current());
                    };
                    // Aucun index courant mais des items : on résout d'abord
                    // l'index 0 (émet navigate → l'hôte met à jour son état),
                    // puis on ouvre — parité avec l'ancien Entrée depuis la
                    // galerie sans image active.
                    if (this._currentIndex() < 0 && this._getTotal() > 0) {
                        this._goTo(0, 0, {}).then((ok) => { if (ok) openCurrent(); });
                    } else {
                        openCurrent();
                    }
                    return true;
                }
                case "ArrowLeft":
                    e.preventDefault();
                    this.navigate(-1);
                    return true;
                case "ArrowRight":
                    e.preventDefault();
                    this.navigate(1);
                    return true;
                case "ArrowUp":
                    if (this._stack.length) return false;
                    e.preventDefault();
                    this.navigateGrid(-1);
                    return true;
                case "ArrowDown":
                    if (this._stack.length) return false;
                    e.preventDefault();
                    this.navigateGrid(1);
                    return true;
                case "+":
                case "=":
                case "Add":
                    e.preventDefault();
                    this.zoomBy(1.1);
                    return true;
                case "-":
                case "_":
                case "Subtract":
                    e.preventDefault();
                    this.zoomBy(1 / 1.1);
                    return true;
                case "0":
                    e.preventDefault();
                    this.resetZoom();
                    return true;
                default:
                    return false;
            }
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
                try { cb(payload, this); } catch (e) { console.error("[HolafLightbox] listener " + evt + " :", e); }
            }
        }

        _h(name, ...args) {
            const handler = this._handlers[name];
            if (typeof handler === "function") {
                try { handler(...args); } catch (e) { console.error("[HolafLightbox] handler " + name + " :", e); }
            }
        }

        // ── Cycle de vie ─────────────────────────────────────────────────────
        _destroyView(view) {
            view.renderSeq += 1;
            if (view.abort) { try { view.abort.abort(); } catch (e) { /* ignore */ } view.abort = null; }
            if (view.renderResult && typeof view.renderResult.destroy === "function") {
                try { view.renderResult.destroy(); } catch (e) { /* ignore */ }
            }
            view.renderResult = null;
            view.element = null;
            if (view.viewport) this._destroyViewport(view);
            this._hideSpinner(view);
            this._hideView(view);
        }

        _teardownView(view) {
            this._destroyView(view);
            if (view.ownsContainer && view.container && view.container.parentNode) {
                view.container.parentNode.removeChild(view.container);
            }
            view.container = null;
            view.surface = null;
        }

        destroy() {
            if (this._destroyed) return;
            this._destroyed = true;

            if (this._preloadTimer) { clearTimeout(this._preloadTimer); this._preloadTimer = null; }
            this._cancelPreloads();

            this._stack.length = 0;
            for (const mode in this._views) {
                this._teardownView(this._views[mode]);
            }
            this._views = {};
            this._listeners.clear();

            if (this._ownsCss) {
                liveInstances = Math.max(0, liveInstances - 1);
                if (liveInstances === 0) removeCss();
            }
        }
    }

    function create(options) {
        return new Lightbox(options);
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
    window.HolafLightbox = HolafLightbox;
}

// Export ESM (import { HolafLightbox } from "./holaf-lightbox.js").
export { HolafLightbox, VERSION };
