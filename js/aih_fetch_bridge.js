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
 *   - L'URL du serveur saisie par l'utilisateur est NORMALISÉE (voir
 *     normalizeServerUrl) : schéma implicite, slash final et suffixe "/api"
 *     sont corrigés, sinon le widget fabriquait une URL cassée et la
 *     connexion échouait silencieusement (« Serveur hors ligne »).
 *
 * Pour les appels SAME-ORIGIN sans auth (routes /aih/*, /api/aih/*…), on passe
 * DIRECTEMENT par HolafFetch / HolafFetch.request (pas par remoteRequest),
 * sans auth : voir les wrappers migrés (aih_elements_widget, aih_workflow_share,
 * blobby_companion…).
 */

import { HolafFetch, HolafFetchError } from "./vendor/holaf/holaf-fetch.js";

// ─── Normalisation de l'URL du serveur saisie par l'utilisateur ─────────────
// L'URL stockée est TOUJOURS la RACINE du serveur AI-Helper (ex.
// "https://aih.holaf.fr") : c'est le bridge qui ajoute le segment "/api" des
// chemins relatifs. Une saisie courante et pourtant cassante était :
//   - "aih.holaf.fr"        → requête RELATIVE à l'origine ComfyUI → 404 ;
//   - "https://aih.holaf.fr/api" → double "/api/api" → 404 ;
//   - slash final            → gérait déjà.
// Cette fonction corrige ces trois cas de façon idempotente. Un schéma
// manquant est deviné : hôte PUBLIC → https (serveur AI-Helper derrière
// Caddy), hôte LOCAL/privé → schéma de la PAGE (http en LAN, pour ne jamais
// forcer https sur un serveur local en clair).

/** Vrai pour un hôte local/privé (loopback, RFC1918, .local). */
function _isLocalHost(hostPort) {
    const host = String(hostPort).split("/")[0].replace(/^\[|\]$/g, "").split(":")[0];
    return (
        host === "localhost" || host === "::1" || host === "0.0.0.0" ||
        /^127\./.test(host) || /^10\./.test(host) ||
        /^192\.168\./.test(host) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) ||
        /\.local$/i.test(host)
    );
}

/**
 * Normalise une URL de serveur AIH saisie librement.
 * @param {string} raw valeur brute (peut être vide/null).
 * @returns {string} racine normalisée, ou "" si aucune valeur exploitable.
 */
export function normalizeServerUrl(raw) {
    let s = String(raw == null ? "" : raw).trim();
    if (!s) return "";
    // Schéma absent → deviner (hôte public : https ; hôte local : page).
    if (!/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(s)) {
        const withoutSlashes = s.replace(/^\/+/, "");
        const pageProto = (typeof window !== "undefined" && window.location && window.location.protocol)
            ? window.location.protocol // "http:" | "https:"
            : null;
        const proto = _isLocalHost(withoutSlashes)
            ? (pageProto || "http:")
            : "https:";
        s = proto + "//" + withoutSlashes;
    }
    // Retirer le slash final PUIS un éventuel suffixe "/api" (le bridge
    // l'ajoute lui-même pour les chemins relatifs) puis re-nettoyer le slash.
    s = s.replace(/\/+$/, "");
    s = s.replace(/\/api$/i, "");
    return s.replace(/\/+$/, "");
}

// ─── Garde-fou anti-masque (texte d'état ≠ clé API) ─────────────────────────
// Bug réel corrigé : le masquage d'affichage mettait un TEXTE (« Clé masquée —
// clique sur « Régénérer » pour en afficher une nouvelle. ») dans la VALEUR du
// champ ; le bouton « Copier » recopiait ce texte, l'utilisateur l'a collé comme
// clé API sur une autre instance → 401 incompréhensible. Toute valeur qui
// ressemble à un libellé de masquage / placeholder / message d'état est donc
// traitée comme ABSENTE : jamais affichée en valeur, jamais copiée, jamais
// enregistrée, jamais envoyée en Authorization: Bearer.
const API_KEY_MASK_RE = /(masqu|r[ée]g[ée]n[ée]r|\bhidden\b|\bplaceholder\b|\b(chargement|loading)\b|\b(indisponible|unavailable)\b|\b(pas de token|no token)\b|\b(erreur|error)\b)/i;

/**
 * Vrai si la valeur ressemble à un libellé de masquage / message d'état
 * (et non à une vraie clé API). Une valeur vide n'est PAS un masque : elle est
 * simplement absente (voir isUsableApiKey).
 * @param {*} value valeur à tester.
 * @returns {boolean}
 */
export function isMaskedApiKey(value) {
    const s = String(value == null ? "" : value).trim();
    return s.length > 0 && API_KEY_MASK_RE.test(s);
}

/**
 * Vrai si la valeur peut être utilisée comme clé API : non vide ET pas un
 * texte de masquage / placeholder.
 * @param {*} value valeur à tester.
 * @returns {boolean}
 */
export function isUsableApiKey(value) {
    const s = String(value == null ? "" : value).trim();
    return s.length > 0 && !isMaskedApiKey(s);
}

// ─── Résolution LAZY de la config (serverUrl + apiKey) ──────────────────────
// Lue depuis localStorage "AIH_config" (même clé que les wrappers historiques).
// La source canonique window.AIH (03_aih_shared.js) est préférée quand elle
// est disponible : elle lit la même clé et reste la référence la plus à jour.
function resolveConfig() {
    const cfg = { serverUrl: "", apiKey: "", apiKeyMasked: false };
    try {
        const raw = JSON.parse(localStorage.getItem("AIH_config") || "{}");
        cfg.serverUrl = normalizeServerUrl(raw.serverUrl);
        cfg.apiKey = raw.apiKey || "";
    } catch { /* config illisible → valeurs vides */ }

    if (typeof window !== "undefined" && window.AIH) {
        try {
            const s = typeof window.AIH.getServerUrl === "function" ? window.AIH.getServerUrl() : "";
            if (s) cfg.serverUrl = normalizeServerUrl(s);
        } catch { /* ignore */ }
        try {
            const k = typeof window.AIH.getApiKey === "function" ? window.AIH.getApiKey() : "";
            if (k) cfg.apiKey = k;
        } catch { /* ignore */ }
    }

    // Rattrapage : une clé DÉJÀ ENREGISTRÉE qui est en réalité un texte de
    // masquage est ignorée (aucun Bearer émis) et signalée par un drapeau pour
    // que l'UI (onglet Compte) affiche un avertissement clair.
    if (isMaskedApiKey(cfg.apiKey)) {
        cfg.apiKeyMasked = true;
        cfg.apiKey = "";
    }
    return cfg;
}

/**
 * Lecture seule de la config serveur courante (serverUrl + apiKey), SANS
 * requête réseau. Utilisé par le garde-fou du switch de source galerie
 * (image_viewer_source_switch.js) pour savoir si le serveur est configuré.
 * `apiKeyMasked` est un DRAPEAU (jamais la valeur masquée) : une clé enregistrée
 * qui est en réalité un texte de masquage est blanchie par resolveConfig et
 * seul ce drapeau la signale, pour que l'appelant affiche un message précis.
 * @returns {{serverUrl: string, apiKey: string, apiKeyMasked: boolean}} valeurs
 *   résolues (serverUrl normalisée, sans slash final ni suffixe "/api").
 */
export function getRemoteConfig() {
    const cfg = resolveConfig();
    return { serverUrl: cfg.serverUrl, apiKey: cfg.apiKey, apiKeyMasked: cfg.apiKeyMasked === true };
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
    // Clé enregistrée = texte de masquage : ne JAMAIS partir en Bearer avec ce
    // texte (401 incompréhensible). Erreur locale explicite : l'utilisateur
    // ressaisit la vraie clé dans Settings ▸ AIH · Compte.
    if (cfg.apiKeyMasked) {
        throw new HolafFetchError(
            "clé API enregistrée invalide (texte de masquage) — ressaisis la vraie clé dans Settings ▸ AIH · Compte",
            { status: 0, data: { code: "API_KEY_MASKED" } }
        );
    }
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
        getRemoteConfig,
        normalizeServerUrl,
        isMaskedApiKey,
        isUsableApiKey,
    };
}

export { HolafFetch, HolafFetchError };
