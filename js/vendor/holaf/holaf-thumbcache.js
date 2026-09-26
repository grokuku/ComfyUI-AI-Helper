/* ═══════════════════════════════════════════════════════════════════════════
 * Holaf UI — Brique HolafThumbCache · version 0.1.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Cache + ordonnanceur de VIGNETTES, PUR (sans DOM, sans CSS, sans rendu).
 *
 * La brique modélise « quelles vignettes sont déjà chargées », « lesquelles
 * sont en cours », « dans quel ordre les charger » et « quoi faire quand le
 * serveur répond 202 (génération en cours) ou ne répond pas (timeout) ». Elle
 * ne rend RIEN : l'hôte fournit `load(item)` et dessine lui-même à partir de
 * la valeur renvoyée (`request()` / `prefetch()`), ou lit le cache via
 * `peek(item)`.
 *
 * Elle est extraite du cœur de la galerie d'images (pack ComfyUI-AI-Helper)
 * pour être partagée avec la future galerie web : même ordonnancement, même
 * dédup, même protocole 202 + Retry-After, mêmes retries bornés — seuls les
 * ADAPTATEURS changent (strategy 'blob' + POST/Bearer côté pack, strategy
 * 'url' + GET/cookie côté web).
 *
 * Zéro dépendance runtime, aucun import croisé : le fichier s'utilise seul.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MODÈLE
 * ─────────────────────────────────────────────────────────────────────────────
 *   - `_cache`   : Map<id, handle> — LRU. L'ordre d'insertion EST l'ordre de
 *                  récence (get/request « touchent » la clé en la réinsérant).
 *                  À l'éviction/clear/destroy, `strategy.release(handle)` est
 *                  appelé (revokeObjectURL en 'blob', no-op en 'url').
 *   - `_inflight`: Map<id, Request> — dédup : deux `request()` du même id
 *                  partagent LA MÊME promesse et un seul chargement.
 *   - `_queue`   : Requests en attente de slot (priorité desc, puis FIFO).
 *   - `_active`  : chargements en cours (borné par `concurrency`).
 *
 * STRATÉGIES
 *   'blob'  : la valeur chargée (Blob) devient un object URL via
 *             `URL.createObjectURL` ; `release` = `URL.revokeObjectURL`.
 *   'url'   : la valeur chargée (string) est stockée TELLE QUELLE ; la brique
 *             ne révoque JAMAIS rien (le navigateur cache l'URL). Zéro requête
 *             n'est faite par la brique : `load` renvoie l'URL directement.
 *   objet   : `{ get(id)?, put(id, value), release(handle) }` — adaptateur
 *             custom (store persistant, CDN, data-URL, etc.). `get` optionnel
 *             est consulté en amont comme source de hit supplémentaire.
 *
 * PROTOCOLE 202 + Retry-After
 *   Si `load` résout une `Response` de statut 202, la brique considère la
 *   vignette « en cours de génération côté serveur » : elle émet 'pending',
 *   appelle `onPending(item, retryAfterMs)` et RE-PLANIFIE un chargement après
 *   Retry-After (défaut 2 s). La promesse de `request()` reste en attente
 *   jusque-là (l'UX garde un placeholder gris au lieu d'une image cassée)
 *   puis résout au premier essai réussi. Les retries « pending » sont sans
 *   limite par défaut (`pendingMax` pour borner) : la génération serveur est
 *   bornée inline et finit toujours par produire (ou tomber en timeout).
 *
 * TIMEOUT + RETRIES BORNÉS
 *   Chaque tentative est bornée par `timeoutMs` (défaut 30 s). Un timeout est
 *   réputé TRANSIENT (contention serveur) : la brique retente jusqu'à
 *   `retry.max` fois (défaut 4) espacées de `retry.delayMs` (défaut 3 s), puis
 *   échoue ('error' + rejet). Un abort EXTERNE (signal de l'hôte / abort())
 *   n'est jamais retenté : la promesse rejette immédiatement une AbortError.
 *
 * ÉVÉNEMENTS (on(evt, cb) → fonction de désabonnement)
 *   'ready'   : { id, item, handle }             vignette chargée + cachée.
 *   'pending' : { id, item, retryAfterMs }       réponse 202, retry planifié.
 *   'error'   : { id, item, error }              échec définitif (hors abort).
 *
 * Fichier DUAL : classe ES (export) + global window.HolafThumbCache — se
 * charge via <script type="module"> ou `import { HolafThumbCache }`.
 * ═════════════════════════════════════════════════════════════════════════ */

const VERSION = "0.1.0";

/** Priorité basse (prefetch hors viewport). */
const PRIORITY_LOW = 0;
/** Priorité haute (vignettes visibles). */
const PRIORITY_HIGH = 1;

/** Vrai si `v` ressemble à une Response (duck-typing : jsdom n'en a pas). */
function isResponseLike(v) {
    return !!v
        && typeof v === "object"
        && typeof v.status === "number"
        && !!v.headers
        && typeof v.headers.get === "function"
        && typeof v.blob === "function";
}

/** Normalise une stratégie ('blob' | 'url' | objet) en { name, get, put, release }. */
function normalizeStrategy(strategy) {
    if (strategy === "url") {
        return {
            name: "url",
            get: null,
            put: (_id, value) => value,
            release: () => { /* un object URL du navigateur n'est jamais révoqué ici */ },
        };
    }
    if (strategy && typeof strategy === "object" && (strategy.get || strategy.put || strategy.release)) {
        return {
            name: "custom",
            get: typeof strategy.get === "function" ? strategy.get : null,
            put: typeof strategy.put === "function" ? strategy.put : ((_id, value) => value),
            release: typeof strategy.release === "function" ? strategy.release : (() => {}),
        };
    }
    // 'blob' (défaut)
    return {
        name: "blob",
        get: null,
        put: (_id, value) => {
            // Une string est déjà une URL (ex. data:) ; sinon on crée un object URL.
            if (typeof value === "string") return value;
            return URL.createObjectURL(value);
        },
        release: (handle) => {
            if (typeof handle === "string" && handle.indexOf("blob:") === 0) {
                URL.revokeObjectURL(handle);
            }
        },
    };
}

class HolafThumbCache {
    /**
     * Fabrique l'instance (sucre : `new HolafThumbCache(opts)` équivalent).
     * @param {object} [options]
     * @returns {HolafThumbCache}
     */
    static create(options) {
        return new HolafThumbCache(options);
    }

    /**
     * @param {object} [options]
     * @param {number}   [options.capacity=2000]   entrées max (éviction LRU).
     * @param {number}   [options.concurrency=6]   chargements simultanés max.
     * @param {string|object} [options.strategy='blob'] voir STRATÉGIES.
     * @param {function} [options.getId]           clé métier (défaut item.id).
     * @param {function} [options.load]            load(item,{signal,priority}) -> Promise<string|Response>|string.
     * @param {function} [options.release]         release(handle) appelé À LA PLACE de la stratégie (optionnel).
     * @param {{max:number,delayMs:number}} [options.retry] retries de timeout.
     * @param {number}   [options.timeoutMs=30000] timeout par tentative (0 = aucun).
     * @param {number}   [options.pendingMax=Infinity] borne des retries « pending ».
     * @param {function} [options.onPending]       onPending(item, retryAfterMs).
     * @param {function} [options.onError]         onError(item, error).
     * @param {function} [options.onPrioritize]    onPrioritize(ids) — cf. onVisible().
     * @param {number}   [options.visibleDebounceMs=300]    débounce de onVisible().
     * @param {number}   [options.visibleFlushThreshold=1000] flush anticipé de onVisible().
     */
    constructor(options) {
        const o = options || {};

        const cap = Number(o.capacity);
        this._capacity = (Number.isFinite(cap) && cap > 0) ? Math.floor(cap) : 2000;
        this._concurrency = this._normalizeConcurrency(o.concurrency);

        this._getId = (typeof o.getId === "function") ? o.getId : ((item) => item && item.id);
        this._load = (typeof o.load === "function") ? o.load : null;
        this._userRelease = (typeof o.release === "function") ? o.release : null;

        const retry = o.retry || {};
        const rmax = Number(retry.max);
        const rdelay = Number(retry.delayMs);
        this._retryMax = (Number.isFinite(rmax) && rmax >= 0) ? Math.floor(rmax) : 4;
        this._retryDelayMs = (Number.isFinite(rdelay) && rdelay >= 0) ? rdelay : 3000;

        const tmo = (o.timeoutMs === 0) ? 0 : Number(o.timeoutMs);
        this._timeoutMs = (o.timeoutMs === 0) ? 0 : ((Number.isFinite(tmo) && tmo > 0) ? tmo : 30000);

        const pmax = Number(o.pendingMax);
        this._pendingMax = (Number.isFinite(pmax) && pmax >= 0) ? Math.floor(pmax) : Infinity;

        this._onPending = (typeof o.onPending === "function") ? o.onPending : null;
        this._onError = (typeof o.onError === "function") ? o.onError : null;
        this._onPrioritize = (typeof o.onPrioritize === "function") ? o.onPrioritize : null;

        const vd = Number(o.visibleDebounceMs);
        this._visibleDebounceMs = (Number.isFinite(vd) && vd >= 0) ? vd : 300;
        const vf = Number(o.visibleFlushThreshold);
        this._visibleFlushThreshold = (Number.isFinite(vf) && vf > 0) ? Math.floor(vf) : 1000;

        this._strategy = normalizeStrategy(o.strategy);

        this._cache = new Map();      // id -> handle (ordre = récence)
        this._inflight = new Map();   // id -> Request
        this._queue = [];             // Request[] en attente de slot
        this._active = 0;
        this._seq = 0;
        this._destroyed = false;

        this._listeners = new Map();  // evt -> Set<fn>

        this._visiblePending = new Set();
        this._visibleTimer = null;

        // Compteurs (stats()).
        this._hits = 0;
        this._misses = 0;
        this._errors = 0;
        this._pendingCount = 0; // réponses 202 vues (cumul)
    }

    // ── Accesseurs ──────────────────────────────────────────────────────────
    /** Version de la brique. */
    get version() { return VERSION; }
    /** Capacité du cache. */
    get capacity() { return this._capacity; }
    /** Nombre d'entrées cachées. */
    get size() { return this._cache.size; }
    /** Concurrence courante. */
    get concurrency() { return this._concurrency; }
    /** Nom de la stratégie ('blob'|'url'|'custom'). */
    get strategyName() { return this._strategy.name; }

    _normalizeConcurrency(value) {
        const n = Number(value);
        return (Number.isFinite(n) && n > 0) ? Math.floor(n) : 6;
    }

    /**
     * Change la concurrence (ex. outil de benchmark de l'hôte) et relance la file.
     * @returns {HolafThumbCache}
     */
    setConcurrency(value) {
        this._concurrency = this._normalizeConcurrency(value);
        this._pump();
        return this;
    }

    // ── Cache : lecture ───────────────────────────────────────────────────
    /** Vraie si `id` est en cache (SANS rafraîchir la récence). */
    has(id) {
        return this._cache.has(id);
    }

    /**
     * Handle caché de `id`, ou `null` (NE rafraîchit PAS la récence : c'est un
     * « peek » ; `request()` rafraîchit la récence des hits).
     */
    peek(id) {
        return this._cache.has(id) ? this._cache.get(id) : null;
    }

    /**
     * Réinsère `id` en tête de récence (sans charger) et renvoie son handle
     * (ou `null` s'il est absent). Utile aux hôtes qui relisent le cache.
     */
    touch(id) {
        if (!this._cache.has(id)) return null;
        this._touch(id);
        return this._cache.get(id);
    }

    /** Vraie si `id` a une requête en cours (en file, en vol ou en attente de retry). */
    isLoading(id) {
        return this._inflight.has(id);
    }

    /** Vraie si `id` attend un retry « pending » (réponse 202). */
    isPending(id) {
        const req = this._inflight.get(id);
        return !!req && req.state === "pending-wait";
    }

    /** Réinsère `id` en tête de récence (appelé sur hit). */
    _touch(id) {
        if (!this._cache.has(id)) return;
        const val = this._cache.get(id);
        this._cache.delete(id);
        this._cache.set(id, val);
    }

    // ── Cache : écriture / libération ───────────────────────────────────────
    _releaseHandle(handle) {
        if (handle === undefined || handle === null) return;
        try {
            if (this._userRelease) this._userRelease(handle);
            else this._strategy.release(handle);
        } catch (e) { /* une release qui casse ne casse pas le cache */ }
    }

    /** Écrit `handle` pour `id`, libère l'ancien et évince le LRU si besoin. */
    _storeHandle(id, handle) {
        if (this._cache.has(id)) {
            const old = this._cache.get(id);
            this._cache.delete(id);
            if (old !== handle) this._releaseHandle(old);
        }
        while (this._cache.size >= this._capacity) {
            const oldestKey = this._cache.keys().next().value;
            const oldestVal = this._cache.get(oldestKey);
            this._cache.delete(oldestKey);
            this._releaseHandle(oldestVal);
        }
        this._cache.set(id, handle);
        return handle;
    }

    // ── File d'attente ──────────────────────────────────────────────────────
    _enqueue(req) {
        if (req.settled || req.inQueue) return;
        req.state = "queued";
        req.inQueue = true;
        this._queue.push(req);
    }

    /** Retire et renvoie la requête prioritaire (priorité desc, puis FIFO). */
    _dequeue() {
        let best = null;
        let bestIdx = -1;
        for (let i = 0; i < this._queue.length; i++) {
            const r = this._queue[i];
            if (r.settled) continue;
            if (!best
                || r.priority > best.priority
                || (r.priority === best.priority && r.seq < best.seq)) {
                best = r;
                bestIdx = i;
            }
        }
        if (bestIdx < 0) return null;
        this._queue.splice(bestIdx, 1);
        best.inQueue = false;
        return best;
    }

    _pump() {
        if (this._destroyed) return;
        while (this._active < this._concurrency) {
            const req = this._dequeue();
            if (!req) break;
            if (req.settled || req.externalAborted) continue;
            // _runAttempt incrémente _active de façon SYNCHRONE avant son 1er await.
            this._runAttempt(req);
        }
    }

    // ── API publique : request / prefetch ──────────────────────────────────
    /**
     * Demande la vignette de `item`. Renvoie une promesse de handle (object URL
     * en 'blob', URL en 'url', valeur custom sinon).
     *  - hit cache     → résout au microtask suivant (yield, jamais synchrone) ;
     *  - en vol        → renvoie LA MÊME promesse (dédup) ;
     *  - sinon         → met en file, ordonnée par `priority` (défaut HIGH).
     * @returns {Promise<string>}
     */
    request(item, priority) {
        const id = this._getItemId(item);
        if (id === undefined || id === null || id === "") {
            return Promise.reject(new Error("HolafThumbCache : item sans getId()"));
        }
        if (this._destroyed) {
            return Promise.reject(new Error("HolafThumbCache détruit"));
        }

        // 1) Hit cache (yield via microtask).
        if (this._cache.has(id)) {
            this._hits++;
            this._touch(id);
            const handle = this._cache.get(id);
            return Promise.resolve(handle);
        }

        // 2) Source optionnelle de la stratégie custom (hit externe).
        if (this._strategy.get) {
            let external;
            try { external = this._strategy.get(id); } catch (e) { external = undefined; }
            if (external !== undefined && external !== null) {
                this._hits++;
                this._storeHandle(id, external);
                return Promise.resolve(external);
            }
        }

        // 3) Dédup in-flight.
        if (this._inflight.has(id)) {
            return this._inflight.get(id).promise;
        }

        if (!this._load) {
            return Promise.reject(new Error("HolafThumbCache : option load() requise"));
        }

        // 4) Nouvelle requête.
        this._misses++;
        const req = {
            id,
            item,
            priority: (typeof priority === "number") ? priority : PRIORITY_HIGH,
            seq: this._seq++,
            state: "queued",
            inQueue: false,
            settled: false,
            externalAborted: false,
            controller: null,
            retryTimer: null,
            retryCount: 0,
            pendingCount: 0,
            resolve: null,
            reject: null,
            promise: null,
        };
        req.promise = new Promise((resolve, reject) => {
            req.resolve = resolve;
            req.reject = reject;
        });
        this._inflight.set(id, req);
        this._enqueue(req);
        this._pump();
        return req.promise;
    }

    /**
     * Précharge une liste d'items en priorité BASSE (dans le cache, sans hôte à
     * dessiner). Ignore les items déjà cachés ou en vol. Ne rejette jamais.
     * @param {Array} items
     * @returns {Promise<Array>} allSettled des chargements déclenchés.
     */
    prefetch(items) {
        const list = Array.isArray(items) ? items : [items];
        const promises = [];
        for (const item of list) {
            const id = this._getItemId(item);
            if (id === undefined || id === null || id === "") continue;
            if (this._cache.has(id) || this._inflight.has(id)) continue;
            promises.push(this.request(item, PRIORITY_LOW));
        }
        return Promise.allSettled(promises);
    }

    _getItemId(item) {
        try {
            const id = this._getId(item);
            return (id === undefined) ? (item && item.id) : id;
        } catch (e) {
            return item && item.id;
        }
    }

    // ── Ordonnancement d'une tentative ──────────────────────────────────────
    _runAttempt(req) {
        req.state = "loading";
        req.inQueue = false;
        this._active++;

        const controller = new AbortController();
        req.controller = controller;
        let timedOut = false;
        let timeoutId = null;

        if (this._timeoutMs > 0) {
            timeoutId = setTimeout(() => {
                timedOut = true;
                try { controller.abort("timeout"); } catch (e) { /* noop */ }
            }, this._timeoutMs);
        }

        const cleanup = () => {
            if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
        };

        (async () => {
            try {
                if (req.externalAborted) throw this._abortError();

                const raw = await this._load(req.item, {
                    signal: controller.signal,
                    priority: req.priority,
                });
                cleanup();
                req.controller = null;

                // Réponse 202 → génération serveur en cours.
                if (isResponseLike(raw) && raw.status === 202) {
                    this._handlePending(req, this._retryAfterMs(raw));
                    return;
                }

                let value = raw;
                if (isResponseLike(raw)) {
                    if (raw.status >= 400 || raw.status === 0) {
                        const err = new Error("HTTP " + raw.status);
                        err.status = raw.status;
                        throw err;
                    }
                    value = await raw.blob();
                }

                const handle = this._strategy.put(req.id, value, req.item);
                this._storeHandle(req.id, handle);
                req.retryCount = 0;
                req.pendingCount = 0;
                this._emit("ready", { id: req.id, item: req.item, handle });
                this._finalize(req, null, handle);
            } catch (err) {
                cleanup();
                req.controller = null;

                if (req.externalAborted) {
                    this._finalize(req, this._abortError(), null);
                    return;
                }
                if (timedOut || (err && err.timedOut === true)) {
                    this._handleTimeout(req, err);
                    return;
                }
                this._errors++;
                this._emit("error", { id: req.id, item: req.item, error: err });
                if (this._onError) {
                    try { this._onError(req.item, err); } catch (e) { /* noop */ }
                }
                this._finalize(req, err, null);
            } finally {
                this._active = Math.max(0, this._active - 1);
                this._pump();
            }
        })();
    }

    _retryAfterMs(raw) {
        let sec = NaN;
        try { sec = parseFloat(raw.headers.get("Retry-After")); } catch (e) { sec = NaN; }
        const seconds = (Number.isFinite(sec) && sec > 0) ? sec : 2;
        return seconds * 1000;
    }

    _handlePending(req, retryAfterMs) {
        req.pendingCount++;
        this._pendingCount++;
        this._emit("pending", { id: req.id, item: req.item, retryAfterMs });
        if (this._onPending) {
            try { this._onPending(req.item, retryAfterMs); } catch (e) { /* noop */ }
        }
        if (req.pendingCount > this._pendingMax) {
            const err = new Error("pending:max-retries");
            this._errors++;
            this._emit("error", { id: req.id, item: req.item, error: err });
            if (this._onError) {
                try { this._onError(req.item, err); } catch (e) { /* noop */ }
            }
            this._finalize(req, err, null);
            return;
        }
        this._scheduleRetry(req, retryAfterMs);
    }

    _handleTimeout(req, err) {
        req.retryCount++;
        if (req.retryCount <= this._retryMax) {
            this._scheduleRetry(req, this._retryDelayMs);
            return;
        }
        const out = new Error("timeout");
        out.name = "TimeoutError";
        out.timedOut = true;
        out.cause = err;
        this._errors++;
        this._emit("error", { id: req.id, item: req.item, error: out });
        if (this._onError) {
            try { this._onError(req.item, out); } catch (e) { /* noop */ }
        }
        this._finalize(req, out, null);
    }

    _scheduleRetry(req, delayMs) {
        req.state = "pending-wait";
        req.inQueue = false;
        if (req.retryTimer) clearTimeout(req.retryTimer);
        req.retryTimer = setTimeout(() => {
            req.retryTimer = null;
            if (this._destroyed || req.settled || req.externalAborted) return;
            req.state = "queued";
            this._enqueue(req);
            this._pump();
        }, delayMs);
    }

    _finalize(req, err, handle) {
        if (req.settled) return;
        req.settled = true;
        req.state = "settled";
        if (req.retryTimer) { clearTimeout(req.retryTimer); req.retryTimer = null; }
        if (this._inflight.get(req.id) === req) this._inflight.delete(req.id);
        if (err) req.reject(err);
        else req.resolve(handle);
    }

    _abortError() {
        const e = new Error("aborted");
        e.name = "AbortError";
        e.aborted = true;
        return e;
    }

    // ── Annulation / invalidation ───────────────────────────────────────────
    /** Rejette et oublie une requête (retire de la file + du suivi + timer). */
    _abortReq(req, settle = true) {
        if (!req || req.settled) return false;
        if (req.retryTimer) { clearTimeout(req.retryTimer); req.retryTimer = null; }
        req.inQueue = false;
        if (settle) this._finalize(req, this._abortError(), null);
        return true;
    }

    /**
     * Annule les chargements en vol / en file (et les retries planifiés).
     * SANS argument : tous. Avec une liste d'ids : ceux-là seulement.
     * Les promesses concernées rejettent une AbortError. Le CACHE n'est pas
     * vidé (cf. clear()).
     * @returns {HolafThumbCache}
     */
    abort(ids) {
        if (ids === undefined || ids === null) {
            for (const req of [...this._inflight.values()]) this._abortReq(req);
            this._queue.length = 0;
        } else {
            const set = (ids instanceof Set) ? ids : new Set(ids);
            for (const id of set) {
                const req = this._inflight.get(id);
                if (req) this._abortReq(req);
            }
        }
        return this;
    }

    /**
     * Annule les chargements d'un item et retire sa valeur du cache (libération
     * du handle). Le prochain `request()` déclenche un rechargement.
     * @returns {boolean} vrai si quelque chose a été retiré/annulé.
     */
    invalidate(id) {
        const req = this._inflight.get(id);
        let changed = false;
        if (req) changed = this._abortReq(req) || changed;
        if (this._cache.has(id)) {
            const h = this._cache.get(id);
            this._cache.delete(id);
            this._releaseHandle(h);
            changed = true;
        }
        return changed;
    }

    /**
     * Stoppe les retries « pending » d'un item SANS interrompre un chargement
     * en vol (qui doit aboutir et cacher). Sert quand un placeholder quitte la
     * vue : inutile de continuer à réclamer une vignette plus visible.
     * @returns {HolafThumbCache}
     */
    cancel(id) {
        const req = this._inflight.get(id);
        if (req && req.state === "pending-wait") this._abortReq(req);
        return this;
    }

    // ── Visibilité (priorisation backend) ──────────────────────────────────
    /**
     * Déclare `ids` comme visibles. Débouncé (visibleDebounceMs) et vidé en
     * avance si le lot dépasse visibleFlushThreshold ; le lot est transmis à
     * `onPrioritize(ids)` (fire-and-forget). Absorbe le POST
     * /prioritize-thumbnails côté pack et /api/media/prioritize côté web.
     * @param {Array<string>} ids
     * @returns {HolafThumbCache}
     */
    onVisible(ids) {
        if (!this._onPrioritize) return this;
        const list = Array.isArray(ids) ? ids : [ids];
        for (const id of list) {
            if (id !== undefined && id !== null && id !== "") this._visiblePending.add(id);
        }
        if (this._visiblePending.size === 0) return this;

        if (this._visibleTimer) { clearTimeout(this._visibleTimer); this._visibleTimer = null; }
        if (this._visiblePending.size >= this._visibleFlushThreshold) {
            this._flushVisible();
            return this;
        }
        this._visibleTimer = setTimeout(() => {
            this._visibleTimer = null;
            this._flushVisible();
        }, this._visibleDebounceMs);
        return this;
    }

    _flushVisible() {
        if (this._visiblePending.size === 0) return;
        const ids = [...this._visiblePending];
        this._visiblePending.clear();
        try { this._onPrioritize(ids, this); } catch (e) { /* noop */ }
    }

    // ── Stats ──────────────────────────────────────────────────────────────
    /**
     * Photographie de l'état : { size, capacity, active, queued, pending,
     * hits, misses, errors, pendingCount, hitsRatio, strategy, concurrency }.
     */
    stats() {
        return {
            size: this._cache.size,
            capacity: this._capacity,
            active: this._active,
            queued: this._queue.length,
            pending: this._inflight.size,
            hits: this._hits,
            misses: this._misses,
            errors: this._errors,
            pendingCount: this._pendingCount,
            hitsRatio: (this._hits + this._misses) > 0 ? (this._hits / (this._hits + this._misses)) : 0,
            strategy: this._strategy.name,
            concurrency: this._concurrency,
        };
    }

    // ── Cycle de vie ────────────────────────────────────────────────────────
    /**
     * Vide TOUT : annule les chargements, libère les handles cachés (revoke en
     * 'blob'), vide la file et les ids visibles en attente. L'instance reste
     * utilisable.
     * @returns {HolafThumbCache}
     */
    clear() {
        this.abort();
        for (const handle of this._cache.values()) this._releaseHandle(handle);
        this._cache.clear();
        this._visiblePending.clear();
        if (this._visibleTimer) { clearTimeout(this._visibleTimer); this._visibleTimer = null; }
        return this;
    }

    /**
     * Libère tout et rend l'instance inutilisable (les requêtes suivantes
     * rejettent). Retire aussi les listeners.
     * @returns {HolafThumbCache}
     */
    destroy() {
        this.clear();
        this._destroyed = true;
        this._listeners.clear();
        return this;
    }

    // ── Événements ──────────────────────────────────────────────────────────
    /**
     * S'abonne à un événement ('ready'|'pending'|'error').
     * @returns {function} fonction de désabonnement.
     */
    on(evt, cb) {
        if (typeof cb !== "function") return () => {};
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
            try { cb(payload, this); } catch (e) { /* un listener qui casse ne casse pas la brique */ }
        }
    }
}

HolafThumbCache.VERSION = VERSION;
HolafThumbCache.PRIORITY_LOW = PRIORITY_LOW;
HolafThumbCache.PRIORITY_HIGH = PRIORITY_HIGH;

// Exposition globale (scripts classiques de la page) — pattern du kit.
if (typeof window !== "undefined") {
    window.HolafThumbCache = HolafThumbCache;
}

// Export ESM (import { HolafThumbCache } from "./holaf-thumbcache.js").
export { HolafThumbCache, VERSION, PRIORITY_LOW, PRIORITY_HIGH };
