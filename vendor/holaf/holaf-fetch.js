/* ═══════════════════════════════════════════════════════════════════════════
 * Holaf UI — Brique HolafFetch · version 0.2.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Wrapper HTTP maison, purement LOGIQUE : aucun DOM, aucun CSS. Il remplace
 * les apiFetch maison des projets (AiKore, CaddyPanel, airunner, Kinoscribe,
 * PEH, ComfyUI-AI-Helper…) avec un comportement blindé et homogène.
 *
 * Le SEL de la brique : l'authentification est ENFICHABLE et configurée par
 * l'hôte — la brique ne se couple à AUCUN serveur. Les auth divergent par
 * projet (bearer, CSRF cookie, JWT, rien) : on passe `opts.auth` et la brique
 * applique la stratégie demandée, sans rien hardcoder côté serveur.
 *
 * Points clés :
 *   - JSON blindé : vérifie le Content-Type AVANT res.json() ; une réponse
 *     non-JSON (page HTML de login / 502 proxy) lève une erreur claire, avec
 *     détection de page de login (authentik/outpost/sign-in) → « session
 *     expirée ». (Inspiré du parseJsonResponse de Pi-Web, mais autonome.)
 *   - Erreurs typées : HolafFetchError extends Error avec { status, data,
 *     body } — les appelants réagissent au code (ex. err.data.code ===
 *     "GIT_AUTH_REQUIRED"). Message automatique : body.error d'abord
 *     (convention maison), sinon body.detail (convention FastAPI).
 *   - Timeout : AbortController (défaut 30 s, 0 = aucun) → erreur « timeout ».
 *     Le timer couvre la réponse INITIALE (headers + corps en mode JSON) et
 *     est nettoyé au succès : en raw:true, un flux long n'est PAS aborté
 *     après coup (la combinaison signal+timeout reste opérante).
 *   - Retry : exponentiel avec petit jitter, SEULEMENT sur erreur
 *     réseau/timeout/5xx (jamais sur 4xx).
 *   - opts.raw: true → renvoie la Response brute (blob/stream).
 *
 * Fichier DUAL : module ES (export) + global window.HolafFetch — se charge
 * via <script type="module"> ou `import { HolafFetch }`.
 * ═════════════════════════════════════════════════════════════════════════ */

const HolafFetch = (function () {
    "use strict";

    const VERSION = "0.2.0";

    // ─── Constantes du module ────────────────────────────────────────────────
    const DEFAULT_TIMEOUT = 30000; // ms ; 0 = aucun timeout
    // Options NATIVES du fetch à forwarder telles quelles (v0.2.0). Les options
    // gérées par la brique (method, headers, body, signal, auth, timeout,
    // retry, on, raw) ne sont JAMAIS forwardées — elles pilotent le wrapper.
    const NATIVE_OPTIONS = [
        "cache", "priority", "mode", "redirect", "credentials",
        "integrity", "referrer", "referrerPolicy", "keepalive", "duplex",
    ];

    // ─── Défauts globaux (configure) ────────────────────────────────────────
    // Volatils, en mémoire uniquement. request() résout :
    //   opts.timeout ?? config.timeout ?? DEFAULT_TIMEOUT
    //   opts.retry   ?? config.retry
    // configure() les remplace pour TOUTES les requêtes qui ne passent pas
    // d'option explicite. Une option explicite dans request() prime toujours.
    const config = {
        timeout: undefined, // undefined → DEFAULT_TIMEOUT
        retry: null,       // null → aucun retry par défaut
    };

    // Configure les défauts globaux (timeout, retry). Retourne la config
    // courante (copie) : { timeout, retry }.
    function configure(opts) {
        opts = opts || {};
        if (opts.timeout !== undefined) {
            config.timeout = opts.timeout === null ? undefined : (Number(opts.timeout) || 0);
        }
        if (opts.retry !== undefined) {
            config.retry = opts.retry === null ? null : opts.retry;
        }
        return {
            timeout: config.timeout === undefined ? DEFAULT_TIMEOUT : config.timeout,
            retry: config.retry ? Object.assign({}, config.retry) : null,
        };
    }
    // Traces d'une page de login SSO (Authentik / outpost) dans le HTML reçu.
    const LOGIN_PAGE_MARKERS = ["authentik", "outpost", "sign-in"];

    // ─── Erreur typée ─────────────────────────────────────────────────────────
    // Les appelants peuvent réagir au statut HTTP (err.status) et au corps
    // structuré (err.data / err.body), ex. err.data.code === "GIT_AUTH_REQUIRED".
    class HolafFetchError extends Error {
        constructor(message, opts) {
            super(message);
            this.name = "HolafFetchError";
            opts = opts || {};
            this.status = opts.status; // statut HTTP (0 = réseau/timeout)
            this.data = opts.data;     // corps JSON parsé (si JSON)
            this.body = opts.body;     // corps brut (texte) si non-JSON
        }
    }

    // ─── Lecture d'un cookie (pour l'auth CSRF) ──────────────────────────────
    // La brique ne touche PAS au DOM pour afficher, mais lit document.cookie
    // quand l'hôte choisit l'auth 'csrf' — c'est le seul accès au navigateur.
    function getCookie(name) {
        if (typeof document === "undefined") return null;
        const prefix = name + "=";
        const parts = document.cookie.split(";");
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i].trim();
            if (part.indexOf(prefix) === 0) return part.slice(prefix.length);
        }
        return null;
    }

    // ─── Auth ENFICHABLE ─────────────────────────────────────────────────────
    // Aucun type de serveur hardcodé : l'hôte choisit la stratégie via
    // opts.auth. La fonction token() est rappelée à CHAQUE requête (token
    // frais). Retourne un objet d'en-têtes à fusionner.
    function buildAuthHeaders(auth) {
        if (!auth) return {};
        if (auth.type === "bearer") {
            const token = typeof auth.token === "function" ? auth.token() : auth.token;
            if (token) return { Authorization: "Bearer " + token };
            return {};
        }
        if (auth.type === "csrf") {
            const name = auth.cookieName || "csrftoken";
            const value = getCookie(name);
            if (value) return { "X-CSRF-Token": value };
            return {};
        }
        if (auth.type === "custom") {
            const h = typeof auth.headers === "function" ? auth.headers() : (auth.headers || {});
            return h || {};
        }
        return {};
    }

    // ─── Corps « bruts » à ne PAS sérialiser en JSON ─────────────────────────
    // string, FormData, Blob, ArrayBuffer, URLSearchParams… passent tels quels.
    function isRawBody(b) {
        if (typeof b === "string") return true;
        if (typeof FormData !== "undefined" && b instanceof FormData) return true;
        if (typeof Blob !== "undefined" && b instanceof Blob) return true;
        if (typeof ArrayBuffer !== "undefined" && b instanceof ArrayBuffer) return true;
        if (typeof URLSearchParams !== "undefined" && b instanceof URLSearchParams) return true;
        return false;
    }

    // ─── Parsing blindé de la réponse ───────────────────────────────────────
    // Vérifie le Content-Type AVANT res.json() ; si la réponse n'est pas du
    // JSON (page HTML de login, 502 proxy…), lit le texte et lève une erreur
    // claire. Détecte une page de login SSO → « session expirée ».
    async function parseResponse(res, raw) {
        if (raw) return res; // mode brut : l'appelant gère blob/stream

        const contentType = res.headers.get("content-type") || "";

        // ── Réponse non-JSON : probablement du HTML (login SSO, proxy…) ──
        if (!contentType.includes("application/json")) {
            const text = await res.text().catch(() => "");
            const lower = text.toLowerCase();
            if (LOGIN_PAGE_MARKERS.some((m) => lower.includes(m))) {
                // Page de login Authentik : la session a été invalidée.
                throw new HolafFetchError("session expirée", { status: res.status, body: text });
            }
            throw new HolafFetchError(
                "réponse non-JSON (statut " + res.status + ")",
                { status: res.status, body: text }
            );
        }

        // ── Réponse JSON : parse classique ──
        let data;
        try {
            data = await res.json();
        } catch (e) {
            // Content-Type JSON mais corps illisible (réponse tronquée…)
            throw new HolafFetchError(
                "réponse JSON illisible (statut " + res.status + ")",
                { status: res.status }
            );
        }

        // ── Erreur métier renvoyée en JSON : { error: "…" } / { detail: "…" } ──
        if (!res.ok) {
            const body = data || {};
            // Message automatique : `error` d'abord (convention maison, projets
            // Holaf), sinon `detail` (convention FastAPI/DRF). Si les deux sont
            // présents, `error` GAGNE — c'est le champ que les projets
            // remplissent intentionnellement ; `detail` reste accessible via
            // err.data.detail. Un `detail` non-string (ex. tableau de
            // validation FastAPI) ne devient pas le message : il reste dans
            // err.data.
            let message = "erreur serveur (statut " + res.status + ")";
            if (typeof body.error === "string" && body.error.length > 0) {
                message = body.error;
            } else if (typeof body.detail === "string" && body.detail.length > 0) {
                message = body.detail;
            }
            // Corps complet attaché à l'erreur (codes structurés côté appelant).
            throw new HolafFetchError(message, { status: res.status, data, body });
        }

        return data;
    }

    // ─── Backoff exponentiel + petit jitter ─────────────────────────────────
    function backoff(base, attempt) {
        const exp = base * Math.pow(2, attempt);
        const jitter = Math.random() * exp * 0.2; // ±10 % de bruit
        return Math.round(exp + jitter);
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // ─── Cœur : request() ────────────────────────────────────────────────────
    async function request(url, opts) {
        opts = opts || {};
        const method = (opts.method || "GET").toUpperCase();
        // Résolution des défauts globaux (configure) : une option explicite
        // dans opts prime ; sinon le défaut global ; sinon la valeur historique.
        const timeoutRaw = (opts.timeout !== undefined && opts.timeout !== null)
            ? opts.timeout
            : (config.timeout !== undefined && config.timeout !== null ? config.timeout : DEFAULT_TIMEOUT);
        const timeout = Number(timeoutRaw) || 0;
        const retry = (opts.retry !== undefined && opts.retry !== null) ? opts.retry : config.retry;
        const attempts = retry && retry.attempts ? Math.max(1, retry.attempts) : 1;
        const backoffMs = retry && retry.backoffMs ? (Number(retry.backoffMs) || 0) : 0;

        // ── En-têtes : ceux de l'hôte + ceux de l'auth enfichable ──
        const headers = Object.assign({}, opts.headers || {});
        Object.assign(headers, buildAuthHeaders(opts.auth));

        // ── Corps : sérialisation JSON automatique (sauf corps bruts) ──
        let body = opts.body;
        if (body !== undefined && body !== null && !isRawBody(body)) {
            body = JSON.stringify(body);
            if (!headers["Content-Type"] && !headers["content-type"]) {
                headers["Content-Type"] = "application/json";
            }
        }

        let lastError = null;

        for (let attempt = 0; attempt < attempts; attempt++) {
            const controller = new AbortController();
            const externalSignal = opts.signal || null;
            let timeoutId = null;
            let abortedByTimeout = false;

            // Relaie l'annulation externe (signal de l'appelant) vers notre
            // controller, pour combiner timeout + signal sans conflit.
            const onExternalAbort = () => controller.abort();
            if (externalSignal) {
                if (externalSignal.aborted) controller.abort();
                else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
            }

            if (timeout > 0) {
                timeoutId = setTimeout(() => {
                    abortedByTimeout = true;
                    controller.abort();
                }, timeout);
            }

            try {
                // Options natives forwardées telles quelles (v0.2.0) : cache,
                // priority, mode, redirect, credentials, integrity, referrer,
                // referrerPolicy, keepalive, duplex. Les options réservées
                // (method, headers, body, signal, auth, timeout, retry, on,
                // raw) ne sont jamais forwardées — elles pilotent le wrapper.
                const init = { method, headers, body, signal: controller.signal };
                for (let i = 0; i < NATIVE_OPTIONS.length; i++) {
                    const k = NATIVE_OPTIONS[i];
                    if (opts[k] !== undefined) init[k] = opts[k];
                }
                const res = await fetch(url, init);

                // Hook de statut (ex. on: { status: (code) => … }).
                if (opts.on && typeof opts.on.status === "function") {
                    opts.on.status(res.status);
                }

                const parsed = await parseResponse(res, opts.raw);

                // Succès : on désarme le timer AUSSI ici (il n'était nettoyé
                // que dans le catch). Le timeout couvre la réponse initiale
                // (headers, et corps en mode JSON), PAS la durée de vie du
                // stream : en raw:true, la Response est rendue à l'appelant
                // et son flux doit pouvoir vivre au-delà du timeout au lieu
                // d'être aborté après coup. La combinaison signal+timeout
                // reste opérante : l'écouteur d'annulation externe (plus bas)
                // n'est PAS retiré, un abort du signal de l'appelant peut
                // toujours couper un flux raw en cours.
                if (timeoutId) clearTimeout(timeoutId);
                return parsed;
            } catch (err) {
                if (timeoutId) clearTimeout(timeoutId);
                if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);

                // ── Timeout ──
                if (abortedByTimeout) {
                    lastError = new HolafFetchError("timeout", { status: 0 });
                    if (attempt < attempts - 1) {
                        await sleep(backoff(backoffMs, attempt));
                        continue;
                    }
                    throw lastError;
                }

                // ── Erreur HTTP typée (HolafFetchError) ──
                if (err instanceof HolafFetchError) {
                    // Retry SEULEMENT sur 5xx (jamais sur 4xx).
                    if (err.status >= 500 && attempt < attempts - 1) {
                        lastError = err;
                        await sleep(backoff(backoffMs, attempt));
                        continue;
                    }
                    throw err;
                }

                // ── Erreur réseau (fetch a rejeté) ──
                lastError = new HolafFetchError("erreur réseau", { status: 0 });
                if (attempt < attempts - 1) {
                    await sleep(backoff(backoffMs, attempt));
                    continue;
                }
            }
        }

        throw lastError;
    }

    // ─── Méthodes raccourcies ────────────────────────────────────────────────
    // get passe les opts SANS body (une requête GET n'a pas de corps).
    function get(url, opts) {
        const o = Object.assign({}, opts);
        delete o.body;
        return request(url, Object.assign(o, { method: "GET" }));
    }
    function post(url, opts) { return request(url, Object.assign({}, opts, { method: "POST" })); }
    function put(url, opts) { return request(url, Object.assign({}, opts, { method: "PUT" })); }
    function patch(url, opts) { return request(url, Object.assign({}, opts, { method: "PATCH" })); }
    function del(url, opts) { return request(url, Object.assign({}, opts, { method: "DELETE" })); }

    return {
        version: VERSION,
        request,
        get,
        post,
        put,
        patch,
        delete: del,
        // Défauts globaux (timeout, retry) — voir README.
        configure: configure,
        HolafFetchError,
    };
})();

// Exposition globale (scripts classiques de la page).
if (typeof window !== "undefined") {
    window.HolafFetch = HolafFetch;
}

// Export ESM (import { HolafFetch } from "./holaf-fetch.js").
const HolafFetchError = HolafFetch.HolafFetchError;
export { HolafFetch, HolafFetchError };
