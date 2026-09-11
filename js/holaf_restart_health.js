/*
 * Copyright (C) 2026 Holaf
 * Holaf Restart Health — détection fiable du retour de ComfyUI (Vague 13)
 * ----------------------------------------------------------------------------
 * Problème corrigé : le bouton « Actualiser » de la modale de redémarrage
 * s'activait trop tôt. L'ancien check faisait un HEAD vers window.location.origin
 * (méthode HEAD, redirect par défaut = follow). Dans l'infra sd.holaf.fr →
 * Caddy → Authentik (SSO) → ComfyUI, ce HEAD ne teste PAS ComfyUI lui-même :
 * il traverse Caddy+Authentik, donc un simple proxy « up » renvoyait un 200
 * (page de login Authentik suivie du redirect, ou shell de l'app servie pendant
 * que le backend ComfyUI redémarre encore) → faux positif « serveur revenu ».
 *
 * Fix : on interroge un VRAI endpoint ComfyUI (/system_stats) avec
 *   - credentials:'include'  → la cookie de session Authentik est envoyée : une
 *     requête non authentifiée est redirigée (302 authorize) par Authentik ;
 *   - redirect:'manual'      → toute redirection (302 Authentik / login) revient
 *     en réponse opaque (status 0) : JAMAIS considérée comme « prête » ;
 *   - 502 (Caddy: upstream down) → status 502 : pas prêt ;
 *   - 200 + JSON au format des stats ComfyUI ({system, devices:[...]}) → le seul
 *     signal fiable « ComfyUI est réellement revenu ».
 *
 * Le module est volontairement SANS dépendance lourde : il accepte une
 * implémentation de fetch et un origin injectables pour être testable en node
 * (et facilement stubbable en jsdom).
 */

"use strict";

// Timeout par défaut d'une sonde de santé (ms). STRICTEMENT INFÉRIEUR à
// l'intervalle de poll (setInterval(..., 2000) dans holaf_main.js) : c'est la
// condition pour ne PAS empiler des requêtes pendantes quand ComfyUI tombe /
// redémarre. Avec 3000 ms (> 2000), chaque tick lançait une nouvelle sonde
// avant l'annulation de la précédente. On garde une marge de 500 ms sous
// l'intervalle.
const DEFAULT_TIMEOUT_MS = 1500;

/**
 * Construit un signal d'annulation "timeout" de façon portable.
 *
 * - `AbortSignal.timeout(ms)` quand disponible (navigateurs modernes, Node ≥ 17.3).
 * - Repli `AbortController` + `setTimeout` sinon : même contrat
 *   (l'abort produit une AbortError), avec un `cancel()` pour nettoyer le timer.
 * - Aucun des deux → signal `undefined` (la sonde reste fonctionnelle, sans
 *   timeout) : jamais d'erreur à cause de la feature-détection.
 *
 * @param {number} ms
 * @returns {{signal: AbortSignal|undefined, cancel: (() => void)|null}}
 */
function makeTimeoutSignal(ms) {
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
        try {
            return { signal: AbortSignal.timeout(ms), cancel: null };
        } catch (e) {
            /* ms invalide → on tente le repli ci-dessous */
        }
    }
    if (typeof AbortController === "function") {
        const controller = new AbortController();
        const timer = setTimeout(() => {
            try { controller.abort(); } catch (e) { /* silencieux */ }
        }, ms);
        return {
            signal: controller.signal,
            cancel: () => clearTimeout(timer),
        };
    }
    return { signal: undefined, cancel: null };
}

/**
 * Interroge l'endpoint de stats ComfyUI et indique si le serveur ComfyUI est
 * réellement en ligne (200 + JSON au format /system_stats).
 *
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl=fetch] Implémentation de fetch (testable).
 * @param {string}   [opts.origin=window.location.origin] Base d'origine.
 * @param {number}   [opts.timeoutMs=1500] Délai avant annulation de la sonde
 *                   (défaut < intervalle de poll de 2000 ms pour ne pas empiler
 *                   les requêtes pendantes).
 * @returns {Promise<{ready:boolean,status:number,source:string,error?:Error}>}
 *   `error` est un champ ADDITIF présent uniquement sur les branches d'échec
 *   réseau/timeout : l'AbortError (source "timeout") ou l'erreur réseau
 *   (source "network") y est propagée pour le diagnostic appelant. Il est
 *   absent des retours normaux (http / not-json / json-parse / shape).
 */
export async function holafComfyHealthCheck(opts = {}) {
    const fetchImpl = opts.fetchImpl || (typeof fetch === "function" ? fetch : null);
    const origin = opts.origin || (typeof window !== "undefined" && window.location ? window.location.origin : "");
    if (!fetchImpl || !origin) {
        return { ready: false, status: 0, source: "no-fetch-or-origin" };
    }

    let url;
    try {
        url = new URL("/system_stats", origin).href;
    } catch (e) {
        return { ready: false, status: 0, source: "bad-origin" };
    }

    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    const timeout = makeTimeoutSignal(timeoutMs);

    let status = 0;
    try {
        const res = await fetchImpl(url, {
            method: "GET",
            credentials: "include",
            redirect: "manual",
            cache: "no-store",
            headers: { Accept: "application/json" },
            ...(timeout.signal ? { signal: timeout.signal } : {}),
        });

        status = res && typeof res.status === "number" ? res.status : 0;

        // Seul un status 200 est un signal candidat. Un 302 Authentik apparaît
        // en réponse opaque (status 0) avec redirect:'manual' ; un 502 Caddy
        // (upstream down) reste 502. Ni l'un ni l'autre n'est « prêt ».
        if (!res || res.status !== 200) {
            return { ready: false, status, source: "http" };
        }

        // Le 200 doit être du JSON ComfyUI, PAS une page de login / un shell
        // HTML servis par le proxy. On exige un content-type JSON.
        const ct = (res.headers && typeof res.headers.get === "function"
            ? res.headers.get("content-type")
            : "") || "";
        if (!/application\/json/i.test(ct)) {
            return { ready: false, status, source: "not-json" };
        }

        let data;
        try {
            data = await res.json();
        } catch (e) {
            return { ready: false, status, source: "json-parse" };
        }

        // Signature du payload /system_stats de ComfyUI ({system, devices:[...]}).
        // Garantit qu'on n'active JAMAIS sur un JSON arbitraire du proxy.
        const ready = !!data
            && typeof data === "object"
            && !!data.system
            && Array.isArray(data.devices);

        return { ready, status, source: ready ? "json" : "shape" };
    } catch (e) {
        return {
            ready: false,
            status,
            source: e && e.name === "AbortError" ? "timeout" : "network",
            error: e,
        };
    } finally {
        // Nettoie le timer du repli pour ne rien laisser pendre.
        if (timeout.cancel) timeout.cancel();
    }
}
