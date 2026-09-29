/* ═══════════════════════════════════════════════════════════════════════════
 * Holaf UI — Brique HolafLightbox · version 0.2.0
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
 * CAPACITÉS OPT-IN (défaut = comportement 0.1.0 STRICTEMENT inchangé) :
 *   - DIAPORAMA (`slideshow: true | { duration, transition, random, loop,
 *     keyboard }`) : startSlideshow/stopSlideshow/toggleSlideshow/
 *     pauseSlideshow/resumeSlideshow/isSlideshow/isSlideshowPaused +
 *     événements `slideshowstart`/`slideshowstop`/`slideshowtick`
 *     (`slideshowpause`/`slideshowresume` en plus) ; barre d'espace en plein
 *     écran = démarre puis play/pause ; une flèche change l'image
 *     IMMÉDIATEMENT et réarme le minuteur ; `random` sans répétition
 *     consécutive ; `loop` ou arrêt en fin ;
 *   - CROSSFADE (`transition: ms`, défaut 0) : fondu enchaîné avec VRAIE
 *     superposition de deux couches (la sortante est conservée jusqu'à la fin
 *     du fondu) ; la brique gère les couches, le contrat renderMedia ne change
 *     pas (chaque rendu reçoit une couche fraîche comme `container`) ;
 *   - CHROME DISCRET (`chrome: { icons, autoHide, idleDelay, fadeDuration }`) :
 *     icônes seules (aucun libellé visible), masquage après inactivité de la
 *     souris (idleDelay, défaut 3000 ms — même curseur posé sur un icône),
 *     réapparition au moindre mouvement, transitions d'opacité douces.
 *
 * CLIC SIMPLE = PLEIN ÉCRAN : la brique expose `openFullscreen(item)` ; côté
 * grille, l'hôte active `activateOnClick` + `onActivate` (cf. README §8) ou
 * branche son propre clic sur ses vignettes.
 *
 * VOLONTAIREMENT ABSENT (reste à l'hôte) : édition d'image (crop/masque), la
 * source réseau concrète (URLs, cache), la grille elle-même (HolafGrid), la
 * visibilité de la galerie.
 * ═════════════════════════════════════════════════════════════════════════ */

const VERSION = "0.2.0";

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
/* Couches CROSSFADE (opt-in) : chaque rendu vit dans sa propre couche, ce qui
   permet une vraie superposition sortant/entrant pendant le fondu. */
.holaf-lightbox-layer {
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
}
/* Chrome discret (opt-in) : masquage/affichage par opacité, jamais de pop.
   Le conteneur porte .holaf-lightbox-chrome-auto ; la classe
   .holaf-lightbox-chrome-hidden est basculée par la brique après inactivité.
   Les contrôles hôtes qui veulent participer utilisent .holaf-lightbox-nav. */
.holaf-lightbox-chrome-auto .holaf-lightbox-nav {
    opacity: 1;
    transition: opacity var(--hl-chrome-fade, 300ms) ease;
}
.holaf-lightbox-chrome-auto.holaf-lightbox-chrome-hidden .holaf-lightbox-nav {
    opacity: 0;
    pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
    .holaf-lightbox-spinner { animation: none; }
    .holaf-lightbox-content--image { transition: none; }
    .holaf-lightbox-chrome-auto .holaf-lightbox-nav { transition: none; }
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

    // Glyphes par défaut du chrome « icônes seules » (opt-in chrome.icons).
    const ICON_GLYPHS = { prev: "‹", next: "›", close: "✖" };

    // Défauts des capacités opt-in.
    const DEFAULT_SLIDESHOW_DURATION = 4000; // ms entre deux images
    const DEFAULT_CHROME_IDLE_DELAY = 3000;  // ms d'inactivité souris
    const DEFAULT_CHROME_FADE = 300;         // ms de transition d'opacité
    const CROSSFADE_READY_FALLBACK = 1000;   // ms avant fondu sans onReady

    function timeMs(value, fallback) {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) return fallback;
        return Math.round(n);
    }

    // `slideshow: true | { duration, transition, random, loop, keyboard }`.
    // Absent/false/null → null (aucune capacité diaporama).
    function normalizeSlideshow(value) {
        if (value === undefined || value === null || value === false) return null;
        const v = (value && typeof value === "object") ? value : {};
        return {
            duration: timeMs(v.duration, DEFAULT_SLIDESHOW_DURATION),
            // transition null = hérite (instance `transition`, sinon 0).
            transition: (v.transition === undefined || v.transition === null)
                ? null : timeMs(v.transition, 0),
            random: v.random === true,
            loop: v.loop === true,
            keyboard: v.keyboard !== false,
        };
    }

    // Défauts neutres du chrome : sans option, RIEN de nouveau (libellés texte,
    // chrome toujours visible).
    function normalizeChrome(value) {
        const cfg = {
            icons: false,
            autoHide: false,
            idleDelay: DEFAULT_CHROME_IDLE_DELAY,
            fadeDuration: DEFAULT_CHROME_FADE,
        };
        if (!value || typeof value !== "object") return cfg;
        if (value.icons !== undefined) cfg.icons = value.icons === true;
        if (value.autoHide !== undefined) cfg.autoHide = value.autoHide === true;
        if (value.idleDelay !== undefined) cfg.idleDelay = timeMs(value.idleDelay, DEFAULT_CHROME_IDLE_DELAY);
        if (value.fadeDuration !== undefined) cfg.fadeDuration = timeMs(value.fadeDuration, DEFAULT_CHROME_FADE);
        return cfg;
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

            // Diaporama (OPT-IN) : `slideshow: true | { duration, transition,
            // random, loop, keyboard }`. Absent → aucune capacité (comportement
            // strictement identique à la 0.1.0).
            this._slideshowCfg = normalizeSlideshow(o.slideshow);
            this._slideshow = {
                active: false,
                paused: false,
                cfg: null,
                timer: null,
                token: 0,
            };

            // Crossfade (OPT-IN) : durée en ms ; 0 (défaut) = coupe franche.
            this._transition = timeMs(o.transition, 0);

            // Chrome discret (OPT-IN) : défauts neutres (aucun effet).
            this._chromeDefaults = normalizeChrome(o.chrome);

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
                slideshowstart: fn(o.onSlideshowStart),
                slideshowstop: fn(o.onSlideshowStop),
                slideshowtick: fn(o.onSlideshowTick),
                slideshowpause: fn(o.onSlideshowPause),
                slideshowresume: fn(o.onSlideshowResume),
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
                // Crossfade (opt-in) : couche courante + sortante en fondu.
                layer: null,
                outgoing: null,
                fadeMs: 0,
                fadeTimer: null,
                fadeStartTimer: null,
                fadeStarted: false,
                readySeq: 0,
                // Chrome discret (opt-in).
                chromeCfg: null,
                chromeAuto: false,
                chromeHidden: false,
                chromeTimer: null,
                chromeMoveHandler: null,
            };
            // Chrome : `chrome` = booléen (construire ou non) ou objet
            // { build, icons, autoHide, idleDelay, fadeDuration } (OPT-IN —
            // sans option, libellés texte et chrome toujours visible).
            const chromeOpts = (cfg.chrome && typeof cfg.chrome === "object") ? cfg.chrome : null;
            const wantChrome = (cfg.chrome === undefined)
                ? !provided
                : ((typeof cfg.chrome === "boolean") ? cfg.chrome : (chromeOpts.build !== false));
            const chromeCfg = {
                icons: this._chromeDefaults.icons,
                autoHide: this._chromeDefaults.autoHide,
                idleDelay: this._chromeDefaults.idleDelay,
                fadeDuration: this._chromeDefaults.fadeDuration,
            };
            if (chromeOpts) {
                if (chromeOpts.icons !== undefined) chromeCfg.icons = chromeOpts.icons === true;
                if (chromeOpts.autoHide !== undefined) chromeCfg.autoHide = chromeOpts.autoHide === true;
                if (chromeOpts.idleDelay !== undefined) chromeCfg.idleDelay = timeMs(chromeOpts.idleDelay, chromeCfg.idleDelay);
                if (chromeOpts.fadeDuration !== undefined) chromeCfg.fadeDuration = timeMs(chromeOpts.fadeDuration, chromeCfg.fadeDuration);
            }
            view.chromeCfg = chromeCfg;
            if (wantChrome) this._buildChrome(view);
            if (view.chromeCfg.autoHide) this._installChromeAutoHide(view);
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
            const icons = !!(view.chromeCfg && view.chromeCfg.icons);
            const make = (cls, key, handler) => {
                const label = labels[key];
                const b = document.createElement("button");
                b.type = "button";
                b.className = "holaf-lightbox-nav " + cls;
                // Mode icônes (opt-in) : aucun libellé VISIBLE ; le libellé
                // reste accessible (title + aria-label).
                b.textContent = icons ? (ICON_GLYPHS[key] || label) : label;
                b.title = label;
                b.setAttribute("aria-label", label);
                b.addEventListener("click", (e) => { e.stopPropagation(); handler(); });
                return b;
            };
            view.nav = {
                prev: make("holaf-lightbox-nav--prev", "prev", () => this.navigate(-1)),
                next: make("holaf-lightbox-nav--next", "next", () => this.navigate(1)),
                close: make("holaf-lightbox-nav--close", "close", () => this.back()),
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

        // ── Chrome discret (OPT-IN) ─────────────────────────────────────────
        // Auto-masquage après `idleDelay` ms d'immobilité (même curseur posé sur
        // un icône) et réapparition au moindre mouvement. Les contrôles hôtes
        // qui portent .holaf-lightbox-nav dans le conteneur participent aussi.
        _installChromeAutoHide(view) {
            const container = view.container;
            if (!container || !container.classList || typeof container.addEventListener !== "function") return;
            view.chromeAuto = true;
            view.chromeHidden = false;
            container.classList.add("holaf-lightbox-chrome-auto");
            if (container.style && typeof container.style.setProperty === "function") {
                container.style.setProperty("--hl-chrome-fade", view.chromeCfg.fadeDuration + "ms");
            }
            const onMove = () => this._pokeChrome(view);
            view.chromeMoveHandler = onMove;
            container.addEventListener("mousemove", onMove);
            container.addEventListener("mouseenter", onMove);
            container.addEventListener("touchstart", onMove, { passive: true });
        }

        _teardownChromeAutoHide(view) {
            const container = view.container;
            if (view.chromeTimer) { clearTimeout(view.chromeTimer); view.chromeTimer = null; }
            if (view.chromeMoveHandler && container && typeof container.removeEventListener === "function") {
                container.removeEventListener("mousemove", view.chromeMoveHandler);
                container.removeEventListener("mouseenter", view.chromeMoveHandler);
                container.removeEventListener("touchstart", view.chromeMoveHandler);
            }
            view.chromeMoveHandler = null;
            if (container && container.classList) {
                container.classList.remove("holaf-lightbox-chrome-auto", "holaf-lightbox-chrome-hidden");
            }
            view.chromeAuto = false;
            view.chromeHidden = false;
        }

        _pokeChrome(view) {
            if (!view.chromeAuto) return;
            this._setChromeHidden(view, false);
            this._armChromeTimer(view);
        }

        _setChromeHidden(view, hidden) {
            if (!view.chromeAuto || !view.container || !view.container.classList) return;
            if (view.chromeHidden === hidden) return;
            view.chromeHidden = hidden;
            view.container.classList.toggle("holaf-lightbox-chrome-hidden", hidden);
        }

        _armChromeTimer(view) {
            if (!view.chromeAuto || view.chromeCfg.idleDelay <= 0) return;
            if (view.chromeTimer) clearTimeout(view.chromeTimer);
            view.chromeTimer = setTimeout(() => {
                view.chromeTimer = null;
                if (view.chromeAuto) this._setChromeHidden(view, true);
            }, view.chromeCfg.idleDelay);
        }

        _showView(view) {
            if (view.container) view.container.style.display = view.display;
            if (view.chromeAuto) {
                this._setChromeHidden(view, false);
                this._armChromeTimer(view);
            }
        }
        _hideView(view) {
            if (view.container) view.container.style.display = "none";
            if (view.chromeTimer) { clearTimeout(view.chromeTimer); view.chromeTimer = null; }
        }

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
            // Fermer la vue au sommet termine le diaporama (raison exposée).
            if (this._slideshow.active) this.stopSlideshow("close");
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
            // Navigation MANUELLE pendant un diaporama : l'image change
            // immédiatement et le minuteur est RÉARMÉ (flèche = accélérer /
            // revenir en arrière). L'avance automatique passe `slideshow:true`
            // et réarme elle-même. En pause, on ne réarme pas.
            if (!opts.slideshow && this._slideshow.active && !this._slideshow.paused) {
                this._armSlideshowTimer();
            }
            return true;
        }

        // ── Rendu média (renderer injecté) + garde serial ────────────────────
        // Durée de fondu effective du rendu : le diaporama actif prime (s'il a
        // une transition), puis la config de vue, puis l'option `transition`.
        _renderFadeMs(view) {
            const s = this._slideshow;
            if (s.active && s.cfg && s.cfg.transition !== null && s.cfg.transition !== undefined) {
                return s.cfg.transition;
            }
            if (view.config && view.config.transition !== undefined) {
                return timeMs(view.config.transition, this._transition);
            }
            return this._transition;
        }

        async _renderView(view, item, opts) {
            if (this._destroyed) return;
            opts = opts || {};
            const seq = ++view.renderSeq;
            const fadeMs = this._renderFadeMs(view);
            view.fadeMs = fadeMs;
            view.fadeStarted = false;

            // Annule l'appel précédent (et le signal associé). En CROSSFADE
            // (opt-in), l'ancien rendu est CONSERVÉ comme couche sortante
            // jusqu'à la fin du fondu ; sinon il est détruit immédiatement
            // (comportement 0.1.0 strictement inchangé).
            const prevAbort = view.abort;
            const prevResult = view.renderResult;
            if (fadeMs > 0) {
                this._flushCrossfade(view);
            } else {
                // Pas de fondu pour CE rendu : on termine un éventuel fondu en
                // cours et on détruit le rendu précédent immédiatement
                // (comportement 0.1.0 strictement inchangé).
                this._flushCrossfade(view);
                if (prevAbort) { try { prevAbort.abort(); } catch (e) { /* ignore */ } }
                if (prevResult && typeof prevResult.destroy === "function") {
                    try { prevResult.destroy(); } catch (e) { console.error("[HolafLightbox] destroy :", e); }
                }
                // Une couche résiduelle (transition désactivée en cours de route)
                // ne doit jamais rester orpheline dans la surface.
                this._discardLayer(view.layer);
                view.layer = null;
            }
            view.renderResult = null;

            // En CROSSFADE, chaque rendu reçoit une couche fraîche comme
            // `container` (contrat renderMedia inchangé : signature identique)
            // — c'est la brique qui gère les couches.
            let container = view.surface;
            if (fadeMs > 0) {
                container = document.createElement("div");
                container.className = "holaf-lightbox-layer";
                container.style.opacity = "0";
                view.surface.appendChild(container);
            }

            const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
            view.abort = ctrl;
            const signal = ctrl ? ctrl.signal : undefined;

            if (view.spinner) this._showSpinner(view);

            const onReady = (payload) => {
                if (seq !== view.renderSeq) return; // callback périmé — ignoré
                view.readySeq = seq;
                this._hideSpinner(view);
                this._readyView(view, item, payload);
                if (view.fadeMs > 0) this._beginCrossfade(view, seq);
            };

            let result;
            try {
                result = await this._renderMedia({
                    container,
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
                    if (fadeMs > 0) {
                        // Le rendu entrant a échoué : on jette sa couche et
                        // l'ancien rendu (conservé pour le fondu) reste affiché.
                        this._discardLayer(container);
                        view.renderResult = prevResult;
                    }
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
                if (fadeMs > 0) this._discardLayer(container);
                return;
            }

            if (fadeMs > 0) {
                // Promotion : l'ancien rendu (s'il existe) devient la couche
                // sortante — son abort/destroy ne partent qu'à la fin du fondu.
                // S'il a été rendu SANS fondu (transition activée en cours de
                // route), son élément est emballé dans une couche à la volée.
                if (prevResult && !view.layer) {
                    const prevEl = (prevResult.el) || (prevResult.elements && prevResult.elements[0]) || null;
                    if (prevEl && isNode(prevEl) && prevEl.parentNode === view.surface) {
                        const wrap = document.createElement("div");
                        wrap.className = "holaf-lightbox-layer";
                        view.surface.appendChild(wrap);
                        wrap.appendChild(prevEl);
                        view.layer = wrap;
                    }
                }
                if (prevResult && view.layer) {
                    view.outgoing = { layer: view.layer, result: prevResult, abort: prevAbort };
                } else if (prevResult) {
                    // Rien à croiser (rendu sans élément) → libération immédiate.
                    if (prevAbort) { try { prevAbort.abort(); } catch (e) { /* ignore */ } }
                    if (typeof prevResult.destroy === "function") {
                        try { prevResult.destroy(); } catch (e) { /* ignore */ }
                    }
                }
                view.layer = container;
                view.renderResult = result || null;
                const el = (result && result.el) || (result && result.elements && result.elements[0]) || null;
                if (el && isNode(el)) {
                    view.element = el;
                    this._ensureViewport(view, el);
                }
                if (!view.outgoing) {
                    // Premier rendu de la vue : rien à croiser → affichage direct.
                    container.style.opacity = "1";
                } else if (view.readySeq === seq) {
                    // onReady a déjà été appelé pendant renderMedia (hôte synchrone)
                    // → le fondu peut démarrer tout de suite.
                    this._beginCrossfade(view, seq);
                } else {
                    // Le fondu démarre à onReady (média prêt) avec un repli borné
                    // si l'hôte ne signale jamais la disponibilité.
                    if (view.fadeStartTimer) clearTimeout(view.fadeStartTimer);
                    view.fadeStartTimer = setTimeout(() => {
                        view.fadeStartTimer = null;
                        this._beginCrossfade(view, seq);
                    }, Math.max(CROSSFADE_READY_FALLBACK, fadeMs));
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

        // ── Crossfade (OPT-IN) : deux couches superposées pendant le fondu ────
        _discardLayer(layer) {
            if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
        }

        _destroyOutgoing(outgoing) {
            if (!outgoing) return;
            if (outgoing.abort) { try { outgoing.abort.abort(); } catch (e) { /* ignore */ } }
            if (outgoing.result && typeof outgoing.result.destroy === "function") {
                try { outgoing.result.destroy(); } catch (e) { console.error("[HolafLightbox] destroy :", e); }
            }
            this._discardLayer(outgoing.layer);
        }

        // Termine immédiatement tout fondu en cours (rendu suivant, fermeture) :
        // aucune couche orpheline, aucun timer vivant.
        _flushCrossfade(view) {
            if (view.fadeStartTimer) { clearTimeout(view.fadeStartTimer); view.fadeStartTimer = null; }
            if (view.fadeTimer) { clearTimeout(view.fadeTimer); view.fadeTimer = null; }
            const outgoing = view.outgoing;
            view.outgoing = null;
            if (outgoing) this._destroyOutgoing(outgoing);
            if (view.layer && view.layer.style) view.layer.style.opacity = "1";
        }

        _beginCrossfade(view, seq) {
            if (this._destroyed || seq !== view.renderSeq) return;
            if (view.fadeStarted) return;
            if (!view.outgoing || !view.layer) return;
            view.fadeStarted = true;
            if (view.fadeStartTimer) { clearTimeout(view.fadeStartTimer); view.fadeStartTimer = null; }
            const ms = Math.max(1, Math.round(view.fadeMs));
            const prevLayer = view.outgoing.layer;
            const inLayer = view.layer;
            const easing = "opacity " + ms + "ms ease";
            if (prevLayer && prevLayer.style) {
                prevLayer.style.transition = easing;
                prevLayer.style.opacity = "1";
            }
            if (inLayer && inLayer.style) {
                inLayer.style.transition = easing;
                inLayer.style.opacity = "0";
                // Force un reflow pour que la transition parte bien de 0 (sinon
                // le navigateur peut appliquer les deux états dans la même frame).
                void inLayer.offsetWidth;
                inLayer.style.opacity = "1";
                if (prevLayer && prevLayer.style) prevLayer.style.opacity = "0";
            }
            view.fadeTimer = setTimeout(() => {
                view.fadeTimer = null;
                const outgoing = view.outgoing;
                view.outgoing = null;
                if (outgoing) this._destroyOutgoing(outgoing);
            }, ms + 60);
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

        // ── Diaporama (OPT-IN) ───────────────────────────────────────────────
        // Sans l'option `slideshow`, aucune de ces méthodes n'a d'effet : elles
        // renvoient false et la barre d'espace reste libre (comportement 0.1.0).

        /**
         * Démarre (ou relance) le diaporama. `opts` écrase la configuration
         * d'instance : { duration, transition, random, loop }.
         */
        startSlideshow(opts) {
            if (this._destroyed || !this._slideshowCfg) return false;
            if (!this._stack.length) return false;
            const base = this._slideshowCfg;
            const o = opts || {};
            const cfg = {
                duration: timeMs(o.duration, base.duration),
                transition: (o.transition !== undefined && o.transition !== null)
                    ? timeMs(o.transition, 0)
                    : base.transition,
                random: (o.random === undefined) ? base.random : (o.random === true),
                loop: (o.loop === undefined) ? base.loop : (o.loop === true),
            };
            const s = this._slideshow;
            const wasActive = s.active;
            s.active = true;
            s.paused = false;
            s.cfg = cfg;
            this._armSlideshowTimer();
            if (!wasActive) {
                const payload = {
                    duration: cfg.duration,
                    transition: (cfg.transition === null) ? this._transition : cfg.transition,
                    random: cfg.random,
                    loop: cfg.loop,
                    index: this._currentIndex(),
                    item: this.current(),
                };
                this._emit("slideshowstart", payload);
                this._h("slideshowstart", payload);
            }
            return true;
        }

        /** Arrête le diaporama. `reason` : 'manual' (défaut), 'end', 'close',
         * 'destroy'. */
        stopSlideshow(reason) {
            const s = this._slideshow;
            if (!s.active) return false;
            s.active = false;
            s.paused = false;
            s.cfg = null;
            this._clearSlideshowTimer();
            const payload = {
                reason: (typeof reason === "string" && reason) ? reason : "manual",
                index: this._currentIndex(),
                item: this.current(),
            };
            this._emit("slideshowstop", payload);
            this._h("slideshowstop", payload);
            return true;
        }

        pauseSlideshow() {
            const s = this._slideshow;
            if (!s.active || s.paused) return false;
            s.paused = true;
            this._clearSlideshowTimer();
            const payload = { index: this._currentIndex(), item: this.current() };
            this._emit("slideshowpause", payload);
            this._h("slideshowpause", payload);
            return true;
        }

        resumeSlideshow() {
            const s = this._slideshow;
            if (!s.active || !s.paused) return false;
            s.paused = false;
            this._armSlideshowTimer();
            const payload = { index: this._currentIndex(), item: this.current() };
            this._emit("slideshowresume", payload);
            this._h("slideshowresume", payload);
            return true;
        }

        /** Play/pause : démarre si arrêté, sinon bascule pause/reprise. */
        toggleSlideshow(opts) {
            const s = this._slideshow;
            if (!s.active) return this.startSlideshow(opts);
            return s.paused ? this.resumeSlideshow() : this.pauseSlideshow();
        }

        isSlideshow() { return this._slideshow.active; }

        isSlideshowPaused() { return this._slideshow.active && this._slideshow.paused; }

        _clearSlideshowTimer() {
            const s = this._slideshow;
            s.token += 1;
            if (s.timer) { clearTimeout(s.timer); s.timer = null; }
        }

        _armSlideshowTimer(delay) {
            const s = this._slideshow;
            if (!s.active || s.paused) return;
            const ms = timeMs(delay, s.cfg ? s.cfg.duration : 0);
            if (ms <= 0) return;
            this._clearSlideshowTimer();
            const token = s.token;
            s.timer = setTimeout(() => {
                s.timer = null;
                if (token !== s.token || !s.active || s.paused) return;
                this._slideshowAdvance();
            }, ms);
        }

        async _slideshowAdvance() {
            const s = this._slideshow;
            if (!s.active || s.paused) return;
            const total = this._getTotal();
            if (total <= 0) { this._armSlideshowTimer(); return; }
            const cur = this._currentIndex();
            let next;
            let dir;
            if (s.cfg.random) {
                if (total <= 1) { this._armSlideshowTimer(); return; }
                next = cur;
                for (let i = 0; i < 10 && next === cur; i++) {
                    next = Math.floor(Math.random() * total);
                }
                if (next === cur || !Number.isFinite(next)) next = (cur + 1) % total;
                dir = next > cur ? 1 : -1;
            } else {
                next = cur + 1;
                if (next >= total) {
                    if (!s.cfg.loop) { this.stopSlideshow("end"); return; }
                    next = 0;
                }
                dir = 1;
            }
            const payload = { index: cur, item: this.current(), nextIndex: next, direction: dir };
            this._emit("slideshowtick", payload);
            this._h("slideshowtick", payload);
            const ok = await this._goTo(next, dir, { slideshow: true });
            if (!s.active || s.paused) return;
            if (!ok) { this.stopSlideshow("end"); return; }
            this._armSlideshowTimer();
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
                case " ":
                case "Spacebar":
                    // Diaporama (OPT-IN) : espace EN PLEIN ÉCRAN démarre le
                    // diaporama puis fait play/pause. Sans l'option, la touche
                    // n'est PAS consommée (comportement 0.1.0 inchangé).
                    if (!this._slideshowCfg || this._slideshowCfg.keyboard === false) return false;
                    if (this._topMode() !== "fullscreen") return false;
                    e.preventDefault();
                    this.toggleSlideshow();
                    return true;
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
            // Fin immédiate d'un éventuel fondu : couche sortante détruite,
            // timers coupés — aucune couche orpheline.
            this._flushCrossfade(view);
            if (view.abort) { try { view.abort.abort(); } catch (e) { /* ignore */ } view.abort = null; }
            if (view.renderResult && typeof view.renderResult.destroy === "function") {
                try { view.renderResult.destroy(); } catch (e) { /* ignore */ }
            }
            view.renderResult = null;
            view.element = null;
            this._discardLayer(view.layer);
            view.layer = null;
            if (view.viewport) this._destroyViewport(view);
            this._hideSpinner(view);
            this._hideView(view);
        }

        _teardownView(view) {
            this._destroyView(view);
            this._teardownChromeAutoHide(view);
            if (view.ownsContainer && view.container && view.container.parentNode) {
                view.container.parentNode.removeChild(view.container);
            }
            view.container = null;
            view.surface = null;
        }

        destroy() {
            if (this._destroyed) return;
            this._destroyed = true;

            this.stopSlideshow("destroy");
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
