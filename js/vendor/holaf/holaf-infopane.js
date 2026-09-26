/* ═══════════════════════════════════════════════════════════════════════════
 * Holaf UI — Brique HolafInfoPane · version 0.1.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Panneau d'informations média GÉNÉRIQUE et INSTANCIABLE (zéro état de module
 * hors le <style> partagé). Il ne connaît QUE :
 *   - une SOURCE asynchrone injectée `resolve(item, { signal })` -> Promise<{
 *       title?, fields?, blocks?, error? }> — c'est ELLE qui sait d'où viennent
 *       les données (endpoint HTTP, cache, objet item…) ;
 *   - une source SYNCHRONE OPTIONNELLE `preview(item)` (même forme, sans
 *       asynchrone) affichée IMMÉDIATEMENT le temps que `resolve` réponde —
 *       les hôtes qui affichent des champs déjà connus (nom, taille, date)
 *       gardent ainsi l'affichage instantané historique ;
 *   - des `labels` (défauts neutres, surchargeables — l'hôte garde SON i18n) ;
 *   - des `actions` de bloc et des `actions` globales de panneau (optionnelles).
 *
 * Elle absorbe, SANS RÉGRESSION, la mécanique générique du volet d'infos de la
 * galerie du node :
 *   - ANNULEMENT de la requête précédente via AbortSignal quand l'item change,
 *     à `clear()`, à `refresh()` et à `destroy()` (les résolutions périmées
 *     sont ignorées : garde de séquence + signal) ;
 *   - COPIE : `execCommand('copy')` puis repli `navigator.clipboard.writeText`,
 *     libellé de confirmation (« Copié ! ») puis RETOUR au libellé d'origine ;
 *   - CHAMPS formatés label/valeur (mode « empilé » = label puis retour ligne) ;
 *   - BLOCS de texte copiables : <textarea> readOnly auto-redimensionnée à la
 *     hauteur du contenu (bornée par `max-height`), bouton copier avant ou
 *     après le texte (désactivable via `copyDisabled`), actions propres au
 *     bloc (ex. « Charger le workflow ») avec CONFIRMATION INJECTABLE
 *     (`confirm(req)`) ;
 *   - ÉTATS : vide (aucun item), chargement, erreur (échec de `resolve` ou
 *     champ `error` du résultat) et prêt ;
 *   - TEXTE ÉCHAPPÉ par défaut : jamais d'injection HTML brute. `html: true`
 *     permet d'utiliser les champs `raw` déjà fiables fournis par l'hôte.
 *   - l'hôte fournit les libellés/l'endpoint/les boutons métier ; la brique ne
 *     connaît AUCUN métier (pas de ComfyUI, pas d'URL, pas de bridge).
 *
 * Zéro dépendance runtime, aucun import croisé.
 *
 * CSS-INJECTANTE : getCss() expose le CSS complet ; l'option
 * { css: { injectStyles:false, nonce } } (ou HolafInfoPane.configure/
 * setStyleNonce) contrôle l'injection. CSS scopé sous .holaf-infopane-* et
 * variables --hl-* posées sur la racine du panneau (.holaf-infopane), JAMAIS
 * sur :root. L'hôte théme la brique en surchargeant les variables --hl-*.
 *
 * Fichier DUAL : classe ES (export) + global window.HolafInfoPane — se charge
 * via <script type="module"> ou `import { HolafInfoPane }`.
 *
 * VOLONTAIREMENT ABSENT (reste à l'hôte) : l'endpoint/l'URL des données, la
 * connaissance des sources (PNG/JSON…), les boutons métier (ex. charger un
 * workflow), le rendu du HTML riche, le Ctrl+A global de la page.
 * ═════════════════════════════════════════════════════════════════════════ */

const VERSION = "0.1.0";

const HolafInfoPane = (function () {
    "use strict";

    const CSS_ID = "holaf-infopane-style";

    // ─── CSS auto-injecté (une seule fois pour tout le module) ──────────────
    // Classes scopées .holaf-infopane-* ; variables --hl-* posées sur la RACINE
    // de chaque panneau (.holaf-infopane), jamais sur :root. L'hôte peut
    // redéfinir ces variables sous une règle plus spécifique pour thémer.
    const CSS = `
.holaf-infopane {
    box-sizing: border-box;
    width: 100%;
    font-size: 13px;
    color: var(--hl-infopane-text, #a8adbd);
    word-break: break-word;
    --hl-infopane-text: #a8adbd;
    --hl-infopane-strong: #e8eaf0;
    --hl-infopane-border: rgba(128, 128, 128, 0.4);
    --hl-infopane-input-bg: rgba(128, 128, 128, 0.12);
    --hl-infopane-accent: #6366f1;
    --hl-infopane-button-text: #ffffff;
    --hl-infopane-danger: #e5484d;
}
.holaf-infopane-title {
    margin: 0 0 8px 0;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--hl-infopane-border);
    font-size: 13px;
    font-weight: 600;
    color: var(--hl-infopane-strong);
}
.holaf-infopane-field {
    margin: 0 0 5px 0;
    font-size: 13px;
    color: var(--hl-infopane-text);
    word-break: break-all;
}
.holaf-infopane-field-label {
    font-weight: bold;
    color: var(--hl-infopane-strong);
}
.holaf-infopane-field-value { color: inherit; }
.holaf-infopane-message {
    box-sizing: border-box;
    width: 100%;
    margin: 0 0 5px 0;
    padding: 20px;
    text-align: center;
    font-style: italic;
    color: var(--hl-infopane-text);
}
.holaf-infopane-message--error { color: var(--hl-infopane-danger); }
.holaf-infopane-divider {
    border: none;
    border-top: 1px solid var(--hl-infopane-border);
    opacity: 0.5;
    margin: 10px 0;
}
.holaf-infopane-block { margin: 0; }
.holaf-infopane-block + .holaf-infopane-block { margin-top: 15px; }
.holaf-infopane-block-head { margin: 0 0 5px 0; font-size: 13px; }
.holaf-infopane-block-label {
    font-weight: bold;
    color: var(--hl-infopane-strong);
}
.holaf-infopane-block-source {
    font-size: 0.85em;
    font-style: italic;
    color: var(--hl-infopane-text);
    margin-left: 5px;
}
.holaf-infopane-actions {
    display: flex;
    gap: 8px;
    margin-top: 5px;
    margin-bottom: 10px;
}
.holaf-infopane-actions--footer { margin-top: 15px; }
.holaf-infopane-button {
    flex: 1;
    background-color: var(--hl-infopane-input-bg);
    border: 1px solid var(--hl-infopane-border);
    color: var(--hl-infopane-text);
    border-radius: 3px;
    padding: 4px 8px;
    font-size: 11px;
    cursor: pointer;
    text-align: center;
    transition: background-color 0.2s, border-color 0.2s, color 0.2s;
}
.holaf-infopane-button:hover:not(:disabled) {
    background-color: var(--hl-infopane-accent);
    border-color: var(--hl-infopane-accent);
    color: var(--hl-infopane-button-text);
}
.holaf-infopane-button:disabled { opacity: 0.4; cursor: not-allowed; }
textarea.holaf-infopane-text {
    display: block;
    background-color: var(--hl-infopane-input-bg);
    border: 1px solid var(--hl-infopane-border);
    border-radius: 4px;
    padding: 8px;
    font-size: 11px;
    font-family: inherit;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 140px;
    overflow-y: auto;
    color: var(--hl-infopane-strong);
    resize: none;
    width: 100%;
    box-sizing: border-box;
    line-height: 1.4;
    min-height: 48px;
    height: auto;
}
textarea.holaf-infopane-text:focus {
    outline: 1px solid var(--hl-infopane-accent);
    outline-offset: -1px;
}
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

    function configure(opts) {
        opts = opts || {};
        if (opts.injectStyles !== undefined) injectStylesGlobal = opts.injectStyles !== false;
        if (opts.nonce !== undefined) setStyleNonce(opts.nonce);
    }

    // ─── Utilitaires ─────────────────────────────────────────────────────────
    const DEFAULT_LABELS = {
        copy: "Copy",
        copied: "Copied!",
        copyFailed: "Copy failed",
        loading: "Loading...",
        selectItem: "Select an item to see details.",
        notAvailable: "Not available.",
        error: "Error",
    };

    function isNode(obj) { return !!(obj && typeof obj === "object" && obj.nodeType === 1); }
    function fn(v) { return typeof v === "function" ? v : null; }

    function toDelay(value, fallback) {
        const n = typeof value === "number" ? value : parseFloat(value);
        return Number.isFinite(n) && n >= 0 ? n : fallback;
    }

    function defaultConfirm(req) {
        if (typeof window !== "undefined" && typeof window.confirm === "function") {
            return !!window.confirm(req.message || req.title || "");
        }
        return true;
    }

    /**
     * Redimensionne une <textarea> à la hauteur de son contenu, bornée par son
     * `max-height` calculé (défaut 140px si absent/invalide).
     */
    function autoResizeTextarea(textarea) {
        if (!textarea || typeof getComputedStyle !== "function") return;
        textarea.style.height = "auto";
        let maxH = 140;
        try {
            const computed = getComputedStyle(textarea);
            const parsed = parseFloat(computed.maxHeight);
            if (Number.isFinite(parsed) && parsed > 0) maxH = parsed;
        } catch (e) { /* computed style indisponible : bornes par défaut */ }
        const scrollH = textarea.scrollHeight;
        textarea.style.height = Math.min(scrollH, maxH) + "px";
    }

    /**
     * Copie un texte : d'abord `execCommand('copy')` (geste utilisateur), puis
     * repli `navigator.clipboard.writeText` si indisponible/en échec.
     * @returns {Promise<void>}
     */
    function copyTextToClipboard(text) {
        const value = text === null || text === undefined ? "" : String(text);
        return new Promise((resolve, reject) => {
            const clipboardFallback = (err) => {
                const nav = (typeof navigator !== "undefined") ? navigator : null;
                if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
                    nav.clipboard.writeText(value).then(resolve, reject);
                } else if (err) {
                    reject(err);
                } else {
                    reject(new Error("Copy not supported"));
                }
            };

            if (typeof document === "undefined" || !document.body) {
                clipboardFallback(null);
                return;
            }

            const textarea = document.createElement("textarea");
            textarea.value = value;
            textarea.style.position = "fixed";
            textarea.style.left = "0";
            textarea.style.top = "0";
            textarea.style.opacity = "0";
            textarea.style.pointerEvents = "none";
            textarea.style.width = "1px";
            textarea.style.height = "1px";
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();

            try {
                const success = typeof document.execCommand === "function"
                    ? document.execCommand("copy")
                    : false;
                if (success) resolve();
                else clipboardFallback(null);
            } catch (err) {
                clipboardFallback(err);
            } finally {
                if (textarea.parentNode) textarea.parentNode.removeChild(textarea);
            }
        });
    }

    // ─── Classe InfoPane ─────────────────────────────────────────────────────
    class InfoPane {
        constructor(container, options) {
            if (!isNode(container)) {
                throw new Error("[HolafInfoPane] un conteneur DOM est requis.");
            }
            const o = options || {};
            this._opts = o;
            this._container = container;

            this._labels = Object.assign({}, DEFAULT_LABELS, o.labels || {});
            this._resolve = fn(o.resolve) || (() => ({ fields: [] }));
            this._preview = fn(o.preview);
            this._confirm = fn(o.confirm);
            this._html = o.html === true;
            this._actions = Array.isArray(o.actions) ? o.actions.slice() : [];
            this._copyRevertDelay = toDelay(o.copyRevertDelay, 1500);
            this._copyFailRevertDelay = toDelay(o.copyFailRevertDelay, 2000);

            this._listeners = new Map();
            this._timers = new Set();
            this._item = null;
            this._seq = 0;
            this._controller = null;
            this._destroyed = false;
            this._rendered = false;

            // CSS : injecté sauf si { css: { injectStyles:false } } ou global.
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

            // Racine DOM PROPRE À L'INSTANCE (plusieurs panneaux possibles,
            // y compris dans un même conteneur ; destroy() la retire).
            this._root = document.createElement("div");
            this._root.className = "holaf-infopane";
            container.appendChild(this._root);

            this._renderEmpty();
        }

        // ── API publique ─────────────────────────────────────────────────────
        /**
         * Fusionne des libellés (l'hôte peut rappeler setLabels avant show()
         * pour suivre un changement de langue).
         */
        setLabels(labels) {
            if (labels && typeof labels === "object") {
                Object.assign(this._labels, labels);
            }
            return this;
        }

        /** Item courant (null si aucun). */
        current() { return this._item; }

        /** Racine DOM du panneau (pour la thématisation/l'ancrage de l'hôte). */
        element() { return this._root; }

        /**
         * Affiche l'item : préview synchrone (si fournie) ou état de chargement
         * immédiat, puis remplacement par le résultat de `resolve(item)`.
         * `show(null)` équivaut à clear().
         * @returns {Promise<void>} résolue quand l'affichage est à jour.
         */
        show(item) {
            if (this._destroyed) return Promise.resolve();
            this._item = item || null;
            if (!this._item) {
                this.clear();
                return Promise.resolve();
            }
            return this._load(this._item, { showLoading: true });
        }

        /** Vide le panneau (état « sélectionnez un item ») et annule la requête. */
        clear() {
            if (this._destroyed) return this;
            this._abort();
            this._seq += 1;
            this._item = null;
            this._renderEmpty();
            return this;
        }

        /**
         * Recharge l'item courant (annule la requête en cours). Le contenu
         * affiché est conservé pendant la requête, sauf s'il n'y a rien à
         * montrer (état vide/chargement).
         * @returns {Promise<void>}
         */
        refresh() {
            if (this._destroyed) return Promise.resolve();
            if (!this._item) {
                this.clear();
                return Promise.resolve();
            }
            return this._load(this._item, { showLoading: !this._rendered });
        }

        /** S'abonne à un évènement ('action'). Retourne la fonction de retrait. */
        on(evt, cb) {
            if (typeof cb !== "function") return () => {};
            if (!this._listeners.has(evt)) this._listeners.set(evt, new Set());
            this._listeners.get(evt).add(cb);
            return () => this.off(evt, cb);
        }

        off(evt, cb) {
            const set = this._listeners.get(evt);
            if (set) set.delete(cb);
        }

        /** Annule la requête en cours, retire le DOM/les listeners/les timers. */
        destroy() {
            if (this._destroyed) return;
            this._destroyed = true;
            this._abort();
            this._seq += 1;
            this._timers.forEach((id) => clearTimeout(id));
            this._timers.clear();
            this._listeners.clear();
            if (this._root && this._root.parentNode) {
                this._root.parentNode.removeChild(this._root);
            }
            this._root = null;
            if (this._ownsCss) {
                liveInstances = Math.max(0, liveInstances - 1);
                if (liveInstances === 0) removeCss();
            }
        }

        // ── Chargement ───────────────────────────────────────────────────────
        _abort() {
            if (this._controller) {
                try { this._controller.abort(); } catch (e) { /* ignore */ }
                this._controller = null;
            }
        }

        _load(item, opts) {
            opts = opts || {};
            this._abort();
            const seq = ++this._seq;
            const controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
            this._controller = controller;
            const signal = controller ? controller.signal : { aborted: false };
            const ctx = { signal, pane: this, item };

            let preview = null;
            if (this._preview) {
                try { preview = this._preview(item, ctx); } catch (e) { preview = null; }
            }
            if (opts.showLoading !== false) {
                if (preview) this._renderData(preview, { loading: true });
                else this._renderLoading();
            }

            let promise;
            try {
                promise = this._resolve(item, ctx);
            } catch (err) {
                promise = Promise.reject(err);
            }

            return Promise.resolve(promise).then(
                (data) => {
                    if (this._destroyed || seq !== this._seq || signal.aborted) return;
                    this._renderData(data || {}, {});
                },
                (err) => {
                    if (this._destroyed || seq !== this._seq || signal.aborted) return;
                    if (err && err.name === "AbortError") return;
                    if (preview) this._renderData(preview, { error: err });
                    else this._renderError(err);
                }
            );
        }

        // ── Évènements ───────────────────────────────────────────────────────
        _emit(evt, payload) {
            const set = this._listeners.get(evt);
            if (!set) return;
            set.forEach((cb) => {
                try { cb(payload); } catch (e) {
                    console.error("[HolafInfoPane] listener " + evt + " :", e);
                }
            });
        }

        // ── Rendu : états ────────────────────────────────────────────────────
        _clearRoot() {
            const root = this._root;
            if (!root) return;
            while (root.firstChild) root.removeChild(root.firstChild);
        }

        _makeMessage(text, modifier) {
            const p = document.createElement("p");
            p.className = "holaf-infopane-message" + (modifier ? " " + modifier : "");
            const em = document.createElement("em");
            em.textContent = text === null || text === undefined ? "" : String(text);
            p.appendChild(em);
            return p;
        }

        _appendMessage(text, modifier) {
            const p = this._makeMessage(text, modifier);
            if (this._root) this._root.appendChild(p);
            return p;
        }

        /** Message d'erreur générique : « <strong>label erreur</strong> détail ». */
        _appendErrorMessage(detail) {
            if (!this._root) return null;
            const p = document.createElement("p");
            p.className = "holaf-infopane-message holaf-infopane-message--error";
            const strong = document.createElement("strong");
            strong.textContent = this._labels.error;
            p.appendChild(strong);
            if (detail) {
                p.appendChild(document.createTextNode(" "));
                p.appendChild(document.createTextNode(String(detail)));
            }
            this._root.appendChild(p);
            return p;
        }

        _renderEmpty() {
            this._clearRoot();
            this._rendered = false;
            if (!this._root) return;
            this._root.setAttribute("data-state", "empty");
            this._appendMessage(this._labels.selectItem);
        }

        _renderLoading() {
            this._clearRoot();
            this._rendered = false;
            if (!this._root) return;
            this._root.setAttribute("data-state", "loading");
            this._appendMessage(this._labels.loading);
        }

        _renderError(err) {
            this._clearRoot();
            this._rendered = false;
            if (!this._root) return;
            this._root.setAttribute("data-state", "error");
            const detail = (err && err.message) ? String(err.message) : "";
            this._appendErrorMessage(detail);
        }

        // ── Rendu : données ──────────────────────────────────────────────────
        _renderField(field) {
            const value = field.value;
            const raw = (this._html && typeof field.raw === "string" && field.raw !== "")
                ? field.raw
                : null;
            if (raw === null && (value === null || value === undefined || value === "")) {
                return false;
            }
            const p = document.createElement("p");
            p.className = "holaf-infopane-field" + (field.stacked ? " holaf-infopane-field--stacked" : "");
            const strong = document.createElement("strong");
            strong.className = "holaf-infopane-field-label";
            strong.textContent = field.label === null || field.label === undefined ? "" : String(field.label);
            p.appendChild(strong);
            if (field.stacked) p.appendChild(document.createElement("br"));
            else p.appendChild(document.createTextNode(" "));
            const span = document.createElement("span");
            span.className = "holaf-infopane-field-value";
            if (raw !== null) span.innerHTML = raw;
            else span.textContent = String(value);
            p.appendChild(span);
            this._root.appendChild(p);
            return true;
        }

        _renderData(data, opts) {
            if (!this._root) return;
            opts = opts || {};
            this._clearRoot();
            this._rendered = true;

            const errorDetail = opts.error
                ? ((opts.error && opts.error.message) ? String(opts.error.message) : "")
                : (data.error ? String(data.error) : "");
            const blocks = Array.isArray(data.blocks) ? data.blocks.slice() : [];
            const hasError = !!opts.error || !!data.error;

            this._root.setAttribute("data-state", hasError ? "error" : (opts.loading ? "loading" : "ready"));

            if (data.title) {
                const title = document.createElement("div");
                title.className = "holaf-infopane-title";
                title.textContent = String(data.title);
                this._root.appendChild(title);
            }

            const fields = Array.isArray(data.fields) ? data.fields : [];
            let fieldCount = 0;
            fields.forEach((field) => {
                if (!field || typeof field !== "object") return;
                if (this._renderField(field)) fieldCount += 1;
            });

            if (fieldCount > 0 && (blocks.length > 0 || hasError)) {
                const hr = document.createElement("hr");
                hr.className = "holaf-infopane-divider";
                this._root.appendChild(hr);
            }

            if (hasError) this._appendErrorMessage(errorDetail);

            blocks.forEach((block) => this._renderBlock(block));

            this._renderFooterActions();

            if (opts.loading) this._appendMessage(this._labels.loading);
        }

        // ── Rendu : blocs ────────────────────────────────────────────────────
        _makeActionsRow(buttons) {
            const row = document.createElement("div");
            row.className = "holaf-infopane-actions";
            buttons.forEach((btn) => row.appendChild(btn));
            return row;
        }

        _makeActionButton(action, block) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "holaf-infopane-button";
            btn.textContent = action.label === null || action.label === undefined ? "" : String(action.label);
            const enabled = this._isEnabled(action, block);
            btn.disabled = !enabled;
            if (enabled) {
                btn.addEventListener("click", () => this._runBlockAction(action, block));
            }
            return btn;
        }

        _makeCopyButton(block, getTextarea) {
            const copyLabel = (block.copyLabel !== null && block.copyLabel !== undefined)
                ? String(block.copyLabel)
                : this._labels.copy;
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "holaf-infopane-button holaf-infopane-copy-button";
            btn.textContent = copyLabel;
            const enabled = block.copyDisabled !== true;
            btn.disabled = !enabled;
            if (!enabled) return btn;
            btn.addEventListener("click", () => {
                const textarea = getTextarea ? getTextarea() : null;
                if (textarea && typeof textarea.focus === "function") {
                    try { textarea.focus(); textarea.select(); } catch (e) { /* ignore */ }
                }
                copyTextToClipboard(block.text).then(() => {
                    this._emit("action", { kind: "copy", id: block.id, block, item: this._item, pane: this, ok: true });
                    this._flashButton(btn, copyLabel, this._labels.copied, this._copyRevertDelay);
                }).catch((err) => {
                    console.error("[HolafInfoPane] copy :", err);
                    this._emit("action", { kind: "copy", id: block.id, block, item: this._item, pane: this, ok: false });
                    this._flashButton(btn, copyLabel, this._labels.copyFailed, this._copyFailRevertDelay);
                });
            });
            return btn;
        }

        _flashButton(btn, original, temporary, delay) {
            btn.textContent = temporary;
            const id = setTimeout(() => {
                this._timers.delete(id);
                if (!this._destroyed && btn) btn.textContent = original;
            }, delay);
            this._timers.add(id);
        }

        _scheduleAutoResize(textarea) {
            const raf = (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function")
                ? window.requestAnimationFrame.bind(window)
                : (cb) => setTimeout(cb, 0);
            raf(() => {
                if (this._destroyed) return;
                autoResizeTextarea(textarea);
            });
        }

        _renderBlock(block) {
            if (!block || typeof block !== "object" || !this._root) return;
            const section = document.createElement("section");
            section.className = "holaf-infopane-block";
            if (block.id !== undefined && block.id !== null) {
                section.setAttribute("data-block-id", String(block.id));
            }

            const head = document.createElement("p");
            head.className = "holaf-infopane-block-head";
            const labelEl = document.createElement("span");
            labelEl.className = "holaf-infopane-block-label";
            labelEl.textContent = block.label === null || block.label === undefined ? "" : String(block.label);
            head.appendChild(labelEl);
            if (block.source) {
                const sourceEl = document.createElement("span");
                sourceEl.className = "holaf-infopane-block-source";
                sourceEl.textContent = String(block.source);
                head.appendChild(sourceEl);
            }
            section.appendChild(head);

            const copyPlacementBefore = block.copyPlacement === "before" || block.copyBefore === true;
            const buttons = [];
            const explicitActions = Array.isArray(block.actions) ? block.actions : [];
            explicitActions.forEach((action) => {
                if (action) buttons.push(this._makeActionButton(action, block));
            });

            let textarea = null;
            if (block.text !== null && block.text !== undefined && block.text !== "") {
                textarea = document.createElement("textarea");
                textarea.className = "holaf-infopane-text";
                textarea.readOnly = true;
                textarea.spellcheck = false;
                textarea.value = String(block.text);
            }

            if (block.copyable && copyPlacementBefore) {
                buttons.push(this._makeCopyButton(block, () => textarea));
            }
            if (buttons.length) section.appendChild(this._makeActionsRow(buttons));

            if (block.error) {
                section.appendChild(this._makeMessage(String(block.error), "holaf-infopane-message--error"));
            } else if (textarea) {
                section.appendChild(textarea);
                this._scheduleAutoResize(textarea);
            } else {
                const empty = (block.empty !== null && block.empty !== undefined)
                    ? String(block.empty)
                    : this._labels.notAvailable;
                section.appendChild(this._makeMessage(empty, null));
            }

            if (block.copyable && !copyPlacementBefore) {
                section.appendChild(this._makeActionsRow([this._makeCopyButton(block, () => textarea)]));
            }

            this._root.appendChild(section);
        }

        // ── Rendu : actions globales du panneau ──────────────────────────────
        _isEnabled(action, block) {
            if (action.disabled === true) return false;
            if (typeof action.isEnabled === "function") {
                try {
                    return !!action.isEnabled(this._item, { pane: this, block: block || null });
                } catch (e) {
                    return false;
                }
            }
            return true;
        }

        _renderFooterActions() {
            if (!this._root || !this._actions.length) return;
            const row = document.createElement("div");
            row.className = "holaf-infopane-actions holaf-infopane-actions--footer";
            this._actions.forEach((action) => {
                if (!action) return;
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = "holaf-infopane-button";
                btn.textContent = action.label === null || action.label === undefined ? "" : String(action.label);
                const enabled = this._isEnabled(action, null);
                btn.disabled = !enabled;
                if (enabled) {
                    btn.addEventListener("click", () => this._runPaneAction(action));
                }
                row.appendChild(btn);
            });
            this._root.appendChild(row);
        }

        async _runPaneAction(action) {
            if (this._destroyed) return;
            if (action.disabled === true) return;
            if (typeof action.isEnabled === "function" && !this._isEnabled(action, null)) return;
            if (action.confirm) {
                const ok = await this._askConfirm(action, null);
                if (!ok) return;
            }
            if (this._destroyed) return;
            this._emit("action", { kind: "pane", id: action.id, action, block: null, item: this._item, pane: this });
            if (typeof action.run === "function") {
                try {
                    await action.run(this._item, { pane: this, emit: (evt, payload) => this._emit(evt, payload) });
                } catch (e) {
                    console.error("[HolafInfoPane] action " + (action.id || "?") + " :", e);
                }
            }
        }

        async _runBlockAction(action, block) {
            if (this._destroyed) return;
            if (action.disabled === true) return;
            if (typeof action.isEnabled === "function" && !this._isEnabled(action, block)) return;
            if (action.confirm) {
                const ok = await this._askConfirm(action, block);
                if (!ok) return;
            }
            if (this._destroyed) return;
            this._emit("action", { kind: "block", id: action.id, action, block, item: this._item, pane: this });
            if (typeof action.onClick === "function") {
                try {
                    await action.onClick({ item: this._item, block, action, pane: this });
                } catch (e) {
                    console.error("[HolafInfoPane] action " + (action.id || (block && block.id) || "?") + " :", e);
                }
            }
        }

        // ── Confirmation injectable ──────────────────────────────────────────
        async _askConfirm(action, block) {
            const c = action.confirm;
            let title = "";
            let message = "";
            if (typeof c === "string") {
                message = c;
            } else if (c && typeof c === "object") {
                title = c.title === null || c.title === undefined ? "" : String(c.title);
                message = c.message === null || c.message === undefined ? "" : String(c.message);
            } else if (c === true) {
                title = action.label === null || action.label === undefined ? "" : String(action.label);
            }
            const req = { title, message, action, block: block || null, item: this._item, pane: this };
            let result;
            try {
                result = this._confirm ? this._confirm(req) : defaultConfirm(req);
            } catch (e) {
                console.error("[HolafInfoPane] confirm :", e);
                return false;
            }
            try {
                return !!(await result);
            } catch (e) {
                return false;
            }
        }
    }

    function create(container, options) {
        return new InfoPane(container, options);
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
    window.HolafInfoPane = HolafInfoPane;
}

// Export ESM (import { HolafInfoPane } from "./holaf-infopane.js").
export { HolafInfoPane, VERSION };
