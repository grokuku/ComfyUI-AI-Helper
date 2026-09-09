/*
 * Copyright (C) 2026 Holaf
 * AIH Fetch Bridge — pont vers la brique HolafFetch (js/vendor/holaf/holaf-fetch.js).
 *
 * Point d'entrée UNIQUE pour tous les appels vers le SERVEUR DISTANT Holaf
 * (composant [R]) de l'extension. Il :
 *   - importe la brique HolafFetch (sérialisation JSON auto, vérification
 *     du Content-Type avant res.json(), erreurs typées HolafFetchError) ;
 *   - résout serverUrl + apiKey LAZYMENT à chaque appel, depuis la même
 *     source que les wrappers historiques : localStorage "AIH_config",
 *     avec prise en compte de la source canonique window.AIH
 *     (getServerUrl / getApiKey de 03_aih_shared.js) quand elle existe ;
 *   - injecte automatiquement l'auth Bearer sur chaque requête distante ;
 *   - expose un mode brut (raw) pour les téléchargements blob / stream.
 *
 * Gestion des URL :
 *   - chemin relatif (ex. "elements-presets") → préfixé par `${serverUrl}/api/`.
 *   - URL absolue (http:// / https://) → utilisée telle quelle (aucun préfixe),
 *     l'auth Bearer reste appliquée.
 *
 * Pour les appels SAME-ORIGIN sans auth (routes /aih/*, /api/aih/*…), on passe
 * DIRECTEMENT par HolafFetch / HolafFetch.request (pas par remoteRequest),
 * sans auth : voir les wrappers migrés (aih_elements_widget, aih_workflow_share,
 * blobby_companion…).
 */

import { HolafFetch, HolafFetchError } from "./vendor/holaf/holaf-fetch.js";

// ─── Résolution LAZY de la config (serverUrl + apiKey) ──────────────────────
// Lue depuis localStorage "AIH_config" (même clé que les wrappers historiques).
// La source canonique window.AIH (03_aih_shared.js) est préférée quand elle
// est disponible : elle lit la même clé et reste la référence la plus à jour.
function resolveConfig() {
    const cfg = { serverUrl: "", apiKey: "" };
    try {
        const raw = JSON.parse(localStorage.getItem("AIH_config") || "{}");
        cfg.serverUrl = (raw.serverUrl || "").replace(/\/+$/, "");
        cfg.apiKey = raw.apiKey || "";
    } catch { /* config illisible → valeurs vides */ }

    if (typeof window !== "undefined" && window.AIH) {
        try {
            const s = typeof window.AIH.getServerUrl === "function" ? window.AIH.getServerUrl() : "";
            if (s) cfg.serverUrl = String(s).replace(/\/+$/, "");
        } catch { /* ignore */ }
        try {
            const k = typeof window.AIH.getApiKey === "function" ? window.AIH.getApiKey() : "";
            if (k) cfg.apiKey = k;
        } catch { /* ignore */ }
    }
    return cfg;
}

/**
 * Requête vers le serveur distant Holaf.
 * @param {string} path  Chemin relatif (préfixé par /api/) ou URL absolue.
 * @param {object} opts  Options forwardées à HolafFetch.request :
 *   method, body (sérialisé en JSON sauf FormData/Blob/ArrayBuffer/string),
 *   timeout, retry, signal, raw, headers, options natives, etc.
 * @returns {Promise<any|Response>} JSON parsé (ou Response si opts.raw).
 */
export async function remoteRequest(path, opts = {}) {
    const cfg = resolveConfig();
    let url = path;
    const isAbsolute = /^https?:\/\//i.test(path || "");
    if (!isAbsolute) {
        if (!cfg.serverUrl) {
            throw new HolafFetchError("serveur AIH non configuré", { status: 0, data: null });
        }
        url = cfg.serverUrl + "/api/" + String(path).replace(/^\/+/, "");
    }
    // Auth Bearer enfichable, résolue à chaque appel (token frais).
    const reqOpts = Object.assign(
        { auth: { type: "bearer", token: () => cfg.apiKey } },
        opts || {}
    );
    return HolafFetch.request(url, reqOpts);
}

/** GET distant (retourne le JSON parsé, ou Response si opts.raw). */
export const remoteGet = (path, opts = {}) =>
    remoteRequest(path, Object.assign({ method: "GET" }, opts));

/** POST distant (retourne le JSON parsé, ou Response si opts.raw). */
export const remotePost = (path, body, opts = {}) =>
    remoteRequest(path, Object.assign({ method: "POST", body }, opts));

/** DELETE distant (retourne le JSON parsé, ou Response si opts.raw). */
export const remoteDelete = (path, opts = {}) =>
    remoteRequest(path, Object.assign({ method: "DELETE" }, opts));

// Exposition globale (scripts classiques / contexte non-module).
if (typeof window !== "undefined") {
    window.AIHFetchBridge = {
        remoteGet,
        remotePost,
        remoteDelete,
        remoteRequest,
    };
}

export { HolafFetch, HolafFetchError };
