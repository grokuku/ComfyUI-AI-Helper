/* ═══════════════════════════════════════════════════════════════════════════
 * Holaf UI — Brique HolafCollection · version 0.1.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Cœur de DONNÉES PUR (sans DOM, sans CSS) pour une liste paginée
 * virtualisée : tableau creux (« sparse ») + cache de fenêtres alignées sur la
 * taille de page + réconciliation incrémentale.
 *
 * La brique ne fait AUCUN rendu : elle modélise « quels items sont chargés »,
 * « quelles pages restent à demander » et « comment appliquer un delta (ajout
 * en tête / suppression) sans invalider les fenêtres déjà chargées ». L'hôte
 * (galerie web, galerie d'un node, etc.) fournit la fonction de récupération
 * `fetchPage` et lit le modèle via at/has/ids/forEachLoaded.
 *
 * Zéro dépendance runtime, aucun import croisé : le fichier s'utilise seul.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MODÈLE
 * ─────────────────────────────────────────────────────────────────────────────
 *   - `_images`      : tableau creux, index → item (ou `undefined` = trou).
 *   - `pageSize`     : taille de fenêtre. Une « fenêtre » commence à un offset
 *                      aligné (0, pageSize, 2·pageSize, …).
 *   - `_loaded`      : Set des offsets de fenêtres ENTIÈREMENT résolues.
 *   - `_loading`     : Map offset → AbortController (fenêtres en vol).
 *   - `_loadingPromises` : Map offset → Promise (dédup des fetch concurrents).
 *   - `_total`       : nombre total d'items côté source (peut dépasser length).
 *   - `length`       : nombre de cases du tableau creux (images.length).
 *
 * mode « window » (défaut) : accès aléatoire par fenêtres (offset/pages) — le
 *   pack (galerie d'images) saute d'une fenêtre à l'autre au scroll et peut
 *   combler des trous.
 * mode « append » : scroll infini séquentiel (web) — on n'ajoute que vers
 *   l'avant : `missingStarts` ne remonte jamais sous la frontière déjà chargée.
 *
 * RÉCONCILIATION INCRÉMENTALE
 *   insertTop(items)  : préfixe N items puis RÉ-ANCRE les fenêtres chargées
 *                       (chaque index glisse de +N) sans perdre les données.
 *   removeByIds(ids)  : retire des items CONNUS puis ré-ancre ; renvoie `false`
 *                       si un id demandé n'est pas en mémoire (math d'index
 *                       ambiguë → l'hôte doit recharger).
 *   applyDelta(delta) : orchestre insert/remove ; au-delà de
 *                       MASS_REMOVAL_THRESHOLD suppressions (ou en cas de
 *                       retrait irréconciliable) renvoie
 *                       { mode:'full-reload', reason } — c'est à l'hôte de
 *                       recharger.
 *
 * CONTRAT fetchPage
 *   fetchPage({ offset, limit, page, filters, signal }) -> Promise<{items,total}>
 *     offset : offset de la fenêtre ; limit : pageSize ;
 *     page   : Math.floor(offset / pageSize) (0-indexé) ;
 *     signal : AbortSignal annulé à reset()/ré-ancrage.
 *
 * ÉVÉNEMENTS (on(evt, cb) → fonction de désabonnement)
 *   'load'  : { start, count }              fenêtre résolue.
 *   'patch' : { mode, inserted, removed }   delta appliqué en place.
 *   'error' : { start, error }              fetchPage a échoué (non annulé).
 *   'total' : number                        le total a changé.
 *
 * Fichier DUAL : classe ES (export) + global window.HolafCollection — se
 * charge via <script type="module"> ou `import { HolafCollection }`.
 * ═════════════════════════════════════════════════════════════════════════ */

const VERSION = "0.1.0";

/**
 * Au-delà de ce nombre de suppressions dans un delta, ré-ancrer les index
 * n'en vaut plus la peine (signature d'un « vider la corbeille ») → l'hôte
 * reçoit { mode:'full-reload', reason:'mass-removal' }.
 */
const MASS_REMOVAL_THRESHOLD = 100;

class HolafCollection {
    /**
     * Fabrique l'instance (sucre : `new HolafCollection(opts)` équivalent).
     * @param {object} [options]
     * @returns {HolafCollection}
     */
    static create(options) {
        return new HolafCollection(options);
    }

    /**
     * Orchestration PURE d'un delta, avec injecteurs (utilisée par le shim du
     * pack qui garde sa propre mécanique de reload). Ne touche à aucun état :
     * appelle `deps.insertTop(items)` / `deps.removeByIds(ids)`.
     *
     * @param {{items?: Array, removedIds?: Array}} delta
     * @param {{insertTop?: Function, removeByIds?: Function}} deps
     * @returns {{mode:string, inserted?:number, removed?:number, reason?:string}}
     */
    static applyDelta(delta, deps) {
        const items = (delta && delta.items) || [];
        const removedIds = (delta && delta.removedIds) || [];
        const d = deps || {};

        if (removedIds.length >= MASS_REMOVAL_THRESHOLD) {
            return { mode: 'full-reload', reason: 'mass-removal' };
        }

        let inserted = 0;
        if (items.length > 0 && typeof d.insertTop === 'function') {
            inserted = d.insertTop(items) || 0;
        }

        let removed = 0;
        if (removedIds.length > 0) {
            const result = (typeof d.removeByIds === 'function') ? d.removeByIds(removedIds) : 0;
            if (result === false) {
                return { mode: 'full-reload', reason: 'unreconcilable-removal' };
            }
            removed = result || 0;
        }

        return { mode: 'patched', inserted, removed };
    }

    /**
     * @param {object} [options]
     * @param {number} [options.pageSize=200] taille de fenêtre.
     * @param {'window'|'append'} [options.mode='window']
     * @param {function} [options.getId] clé métier d'un item (défaut : item.id).
     * @param {function} [options.sortKey] clé de tri DESC pour insertTop
     *        (défaut : item.sortKey). Plus récent = plus grand.
     * @param {function} [options.fetchPage] chargeur de fenêtre (voir contrat).
     * @param {function} [options.fetchDelta] chargeur optionnel de delta
     *        ({ since }) -> Promise<{items, removedIds, total}>.
     * @param {*} [options.filters] filtres transmis à fetchPage.
     * @param {*} [options.since] curseur initial pour fetchDelta (refresh()).
     */
    constructor(options) {
        const o = options || {};
        const ps = Number(o.pageSize);
        this._pageSize = (Number.isFinite(ps) && ps > 0) ? Math.floor(ps) : 200;
        this._mode = (o.mode === 'append') ? 'append' : 'window';
        this._getId = (typeof o.getId === 'function') ? o.getId : ((item) => item && item.id);
        this._sortKey = (typeof o.sortKey === 'function') ? o.sortKey : ((item) => (item && item.sortKey) || 0);
        this._fetchPage = (typeof o.fetchPage === 'function') ? o.fetchPage : null;
        this._fetchDelta = (typeof o.fetchDelta === 'function') ? o.fetchDelta : null;
        this._filters = (o.filters !== undefined) ? o.filters : null;
        this._since = (o.since !== undefined) ? o.since : null;

        this._images = [];
        this._total = (typeof o.total === 'number' && o.total >= 0) ? o.total : 0;

        this._loaded = new Set();          // starts de fenêtres chargées
        this._loading = new Map();         // start -> AbortController
        this._loadingPromises = new Map(); // start -> Promise
        this._listeners = new Map();       // evt -> Set<fn>
    }

    // ── Accesseurs ──────────────────────────────────────────────────────────
    /** Version de la brique. */
    get version() { return VERSION; }
    /** Taille de fenêtre (ex. 500 côté pack, 60 côté web). */
    get pageSize() { return this._pageSize; }
    /** 'window' (offset/pages) ou 'append' (scroll infini). */
    get mode() { return this._mode; }
    /** Nombre total d'items côté source. */
    get total() { return this._total; }
    /** Nombre de cases occupées/allouées dans le tableau creux. */
    get length() { return this._images.length; }

    // ── Lecture ─────────────────────────────────────────────────────────────
    /** Offset aligné de la fenêtre contenant `index`. */
    windowStart(index) {
        const i = Number(index);
        if (!Number.isFinite(i) || i <= 0) return 0;
        return Math.floor(i / this._pageSize) * this._pageSize;
    }

    /** Item à l'index (ou `undefined` si trou / hors bornes). */
    at(index) { return this._images[index]; }

    /** L'index i est-il résolu (item présent) ? */
    has(index) { return this._images[index] !== undefined; }

    /**
     * Ids des items résolus dans [start, end[ (end exclu ; défaut : tout).
     * @returns {Array}
     */
    ids(start, end) {
        const from = (typeof start === 'number' && start > 0) ? Math.floor(start) : 0;
        const stop = (typeof end === 'number') ? Math.floor(end) : this._images.length;
        const out = [];
        const limit = Math.min(stop, this._images.length);
        for (let i = from; i < limit; i++) {
            const item = this._images[i];
            if (item !== undefined) out.push(this._getId(item));
        }
        return out;
    }

    /**
     * Parcourt les items résolus, fenêtres chargées par ordre croissant.
     * @param {function} cb cb(item, index)
     */
    forEachLoaded(cb) {
        const starts = [...this._loaded].sort((a, b) => a - b);
        for (const start of starts) {
            const stop = Math.min(this._images.length, start + this._pageSize);
            for (let i = start; i < stop; i++) {
                const item = this._images[i];
                if (item !== undefined) cb(item, i);
            }
        }
    }

    // ── Cache de fenêtres ───────────────────────────────────────────────────
    /** Fenêtre chargée ? */
    isWindowLoaded(start) { return this._loaded.has(start); }
    /** Fenêtre en cours de chargement ? */
    isWindowLoading(start) { return this._loading.has(start); }
    /** Promise de chargement d'une fenêtre (ou null). */
    getLoadingPromise(start) { return this._loadingPromises.get(start) || null; }

    /** Enregistre une fenêtre en vol (offset → controller/promise). */
    registerLoading(start, controller, promise) {
        this._loading.set(start, controller);
        this._loadingPromises.set(start, promise);
        return this;
    }

    /** Retire une fenêtre de l'état « en vol ». */
    unregisterLoading(start) {
        this._loading.delete(start);
        this._loadingPromises.delete(start);
        return this;
    }

    /** Écrit `items` à partir de `start` et marque la fenêtre chargée. */
    setWindow(start, items) {
        const list = items || [];
        const from = Number(start) || 0;
        for (let i = 0; i < list.length; i++) this._images[from + i] = list[i];
        this._images.length = Math.max(this._images.length, from + list.length);
        this._loaded.add(from);
        return this;
    }

    /**
     * Adopte un état externe `{ images, totalCount }` (intégration « apportez
     * votre store »). Le tableau `images` est utilisé PAR RÉFÉRENCE (mutations
     * en place visibles par l'hôte). Renvoie l'instance.
     */
    bindState(state) {
        if (!state || typeof state !== 'object') return this;
        if (!Array.isArray(state.images)) state.images = [];
        this._images = state.images;
        if (typeof state.totalCount === 'number') this._total = state.totalCount;
        return this;
    }

    // ── Planification des fenêtres ──────────────────────────────────────────
    /** Fenêtres alignées balayant [start, end] (bornées par total/append). */
    _rangeStarts(start, end) {
        const ps = this._pageSize;
        let from = this.windowStart(start);
        if (this._mode === 'append') {
            const boundary = this.windowStart(this._images.length);
            if (boundary > from) from = boundary;
        }
        const to = this.windowStart(end);
        const out = [];
        for (let w = from; w <= to; w += ps) {
            if (this._total > 0 && w >= this._total) break;
            out.push(w);
        }
        return out;
    }

    /** Offsets de fenêtres à demander dans [start, end] (ni chargées ni en vol). */
    missingStarts(start, end) {
        return this._rangeStarts(start, end)
            .filter((w) => !this._loaded.has(w) && !this._loadingPromises.has(w));
    }

    /** Garantit que les fenêtres couvrant [start, end] sont chargées. */
    ensureRange(start, end) {
        return Promise.all(this._rangeStarts(start, end).map((w) => this._fetchWindow(w)));
    }

    /**
     * Garantit que la fenêtre contenant `index` est chargée.
     * @returns {Promise<*>} l'item une fois disponible (ou `undefined`).
     */
    ensureIndex(index) {
        const start = this.windowStart(index);
        if (this._loaded.has(start)) return Promise.resolve(this.at(index));
        if (this._total > 0 && start >= this._total) return Promise.resolve(undefined);
        return this._fetchWindow(start).then(() => this.at(index));
    }

    /** Charge une fenêtre (dédup) sans jamais rejeter : émet 'error' si échec. */
    _fetchWindow(start) {
        if (this._loaded.has(start)) return Promise.resolve(undefined);
        if (this._loadingPromises.has(start)) return this._loadingPromises.get(start);
        if (typeof this._fetchPage !== 'function') return Promise.resolve(undefined);
        if (this._total > 0 && start >= this._total) return Promise.resolve(undefined);

        const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const signal = controller ? controller.signal : undefined;
        const page = Math.floor(start / this._pageSize);

        const promise = (async () => {
            try {
                const res = await this._fetchPage({
                    offset: start,
                    limit: this._pageSize,
                    page,
                    filters: this._filters,
                    signal,
                });
                const items = (res && res.items) || [];
                this.setWindow(start, items);
                if (res && typeof res.total === 'number') this._setTotal(res.total);
                this._emit('load', { start, count: items.length });
                return items;
            } catch (error) {
                if (!(signal && signal.aborted)) this._emit('error', { start, error });
                return undefined;
            } finally {
                this.unregisterLoading(start);
            }
        })();

        this.registerLoading(start, controller, promise);
        return promise;
    }

    // ── Réconciliation incrémentale ─────────────────────────────────────────
    /**
     * Ré-ancrage : reconstruit les fenêtres chargées à partir du tableau creux
     * fraîchement assemblé. Une fenêtre n'est « chargée » que si TOUTES ses
     * cases existantes sont définies ; celles à cheval sur un trou sont
     * oubliées et redemandées à la volée.
     */
    _rebuildLoadedRanges(images, total) {
        this._loaded.clear();
        const ps = this._pageSize;
        for (let w = 0; w < total; w += ps) {
            const end = Math.min(w + ps, total);
            let full = true;
            for (let i = w; i < end; i++) {
                if (images[i] === undefined) { full = false; break; }
            }
            if (full) this._loaded.add(w);
        }
    }

    /** Annule et oublie toutes les fenêtres en vol. */
    _abortInFlight(reason) {
        for (const controller of this._loading.values()) {
            try {
                if (controller && typeof controller.abort === 'function') controller.abort(reason);
            } catch (e) { /* abort best-effort */ }
        }
        this._loading.clear();
        this._loadingPromises.clear();
        return this;
    }

    _setTotal(value) {
        if (value !== this._total) {
            this._total = value;
            this._emit('total', value);
        }
        return this;
    }

    /**
     * Insère des items EN TÊTE sans jeter les fenêtres chargées : chaque index
     * glisse de +N, les données chargées sont ré-empilées dans le nouvel
     * alignement et seules les fenêtres de bord (à cheval sur un trou) tombent.
     * @param {Array} items
     * @returns {number} nombre d'items réellement insérés (doublons ignorés)
     */
    insertTop(items) {
        if (!Array.isArray(items) || items.length === 0) return 0;
        const getId = this._getId;

        const loadedIds = new Set();
        this.forEachLoaded((img) => loadedIds.add(getId(img)));

        const toInsert = items
            .filter((it) => it && getId(it) !== undefined && getId(it) !== null && !loadedIds.has(getId(it)))
            .sort((a, b) => (this._sortKey(b) || 0) - (this._sortKey(a) || 0));
        if (toInsert.length === 0) return 0;

        const n = toInsert.length;
        const oldImages = this._images;
        const oldTotal = (this._total > 0) ? this._total : oldImages.length;
        const newTotal = oldTotal + n;

        // Instantané des fenêtres chargées avant décalage.
        const snapshots = [];
        for (const start of [...this._loaded]) {
            const imgs = [];
            for (let i = start; i < start + this._pageSize; i++) imgs.push(oldImages[i]);
            snapshots.push({ start, imgs });
        }

        // Les fetch en vol ciblaient des offsets qui viennent de bouger → annulés.
        this._abortInFlight('reindex');

        const shifted = new Array(newTotal);
        for (let i = 0; i < n; i++) shifted[i] = toInsert[i];
        for (const { start, imgs } of snapshots) {
            for (let k = 0; k < imgs.length; k++) {
                if (imgs[k] !== undefined) shifted[start + n + k] = imgs[k];
            }
        }

        this._rebuildLoadedRanges(shifted, newTotal);

        // Copie EN PLACE (l'hôte garde la référence du tableau).
        oldImages.length = newTotal;
        for (let i = 0; i < newTotal; i++) oldImages[i] = shifted[i];

        this._setTotal(newTotal);
        return n;
    }

    /**
     * Retire des items par id en gardant les fenêtres cohérentes.
     * @param {Array} ids
     * @returns {number|false} nombre retiré, ou `false` si un id demandé n'est
     *          pas en mémoire (ré-ancrage impossible → l'hôte doit recharger).
     */
    removeByIds(ids) {
        const getId = this._getId;
        const remove = new Set((ids || []).filter((x) => x !== undefined && x !== null && x !== ''));

        if (remove.size === 0) return 0;
        if (!Array.isArray(this._images)) return 0;

        const oldImages = this._images;
        const removedIndices = [];
        const found = new Set();
        this.forEachLoaded((img, idx) => {
            const id = getId(img);
            if (remove.has(id)) { found.add(id); removedIndices.push(idx); }
        });
        if (found.size !== remove.size) return false; // id hors mémoire → ambigu

        const oldTotal = (this._total > 0) ? this._total : oldImages.length;
        const newTotal = Math.max(0, oldTotal - remove.size);
        const removedSorted = removedIndices.slice().sort((a, b) => a - b);
        const removedSet = new Set(removedSorted);
        const removedBefore = (i) => {
            let c = 0;
            for (const r of removedSorted) { if (r < i) c++; else break; }
            return c;
        };

        this._abortInFlight('reindex');

        const next = new Array(newTotal);
        this.forEachLoaded((img, i) => {
            if (removedSet.has(i)) return;
            next[i - removedBefore(i)] = img;
        });

        this._rebuildLoadedRanges(next, newTotal);

        oldImages.length = newTotal;
        for (let i = 0; i < newTotal; i++) oldImages[i] = next[i];

        this._setTotal(newTotal);
        return remove.size;
    }

    /**
     * Applique un delta en place.
     * @param {{items?:Array, removedIds?:Array}} delta
     * @returns {{mode:string, inserted?:number, removed?:number, reason?:string}}
     *          `{mode:'patched'}` si réconcilié, sinon
     *          `{mode:'full-reload', reason}` (à l'hôte de recharger).
     */
    applyDelta(delta) {
        const result = HolafCollection.applyDelta(delta, {
            insertTop: (items) => this.insertTop(items),
            removeByIds: (ids) => this.removeByIds(ids),
        });
        if (result.mode === 'patched') this._emit('patch', result);
        return result;
    }

    /**
     * Polling optionnel : appelle `fetchDelta({ since })` puis applique le
     * delta. Sans `fetchDelta`, renvoie `{ mode:'skipped' }`.
     */
    async refresh() {
        if (typeof this._fetchDelta !== 'function') return { mode: 'skipped' };
        const delta = (await this._fetchDelta({ since: this._since })) || {};
        if (delta.since !== undefined) this._since = delta.since;
        const result = this.applyDelta(delta);
        // Le total renvoyé par le delta est AUTORITAIRE : il est posé APRÈS
        // l'ajustement local (sinon insert/remove le compteraient deux fois).
        if (typeof delta.total === 'number') this._setTotal(delta.total);
        return result;
    }

    // ── Cycle de vie ────────────────────────────────────────────────────────
    /** Vide le cache de fenêtres (annule les fetch en vol) SANS toucher aux données. */
    resetWindowCache() {
        this._abortInFlight('window-reset');
        this._loaded.clear();
        return this;
    }

    /** Réinitialise le modèle : données + caches + fetch en vol. */
    reset() {
        this.resetWindowCache();
        this._images.length = 0;
        this._setTotal(0);
        return this;
    }

    /** Change les filtres et réinitialise (à re-remplir via ensureRange). */
    setFilters(filters) {
        this._filters = (filters === undefined) ? null : filters;
        this.reset();
        return this;
    }

    // ── Événements ──────────────────────────────────────────────────────────
    /**
     * S'abonne à un événement ('load'|'patch'|'error'|'total').
     * @returns {function} fonction de désabonnement.
     */
    on(evt, cb) {
        if (typeof cb !== 'function') return () => {};
        let set = this._listeners.get(evt);
        if (!set) { set = new Set(); this._listeners.set(evt, set); }
        set.add(cb);
        return () => this.off(evt, cb);
    }

    /** Se désabonne. */
    off(evt, cb) {
        const set = this._listeners.get(evt);
        if (set) set.delete(cb);
        return this;
    }

    _emit(evt, payload) {
        const set = this._listeners.get(evt);
        if (!set || set.size === 0) return;
        for (const cb of set) {
            try { cb(payload, this); } catch (e) { /* un listener qui casse ne casse pas le modèle */ }
        }
    }
}

HolafCollection.VERSION = VERSION;
HolafCollection.MASS_REMOVAL_THRESHOLD = MASS_REMOVAL_THRESHOLD;

// Exposition globale (scripts classiques de la page) — pattern du kit.
if (typeof window !== "undefined") {
    window.HolafCollection = HolafCollection;
}

// Export ESM (import { HolafCollection } from "./holaf-collection.js").
export { HolafCollection, MASS_REMOVAL_THRESHOLD, VERSION };
