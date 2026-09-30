/*
 * Copyright (C) 2026 Holaf
 * HolafAuth — INVITE D'AUTHENTIFICATION UNIFIÉE (pack ComfyUI-AI-Helper)
 * ----------------------------------------------------------------------------
 * UN SEUL point de demande de mot de passe pour TOUTE l'extension :
 *   - le Terminal (js/holaf_terminal.js) ne possède plus ses propres vues
 *     login/setup : il appelle ensureAuthenticated() puis ouvre son WebSocket ;
 *   - le Nodes Manager (js/holaf_nodes_manager.js) n'a plus sa propre modale :
 *     il appelle ensureAuthenticated() avant les actions sensibles et retente
 *     une fois après un 401 via withAuthRetry() ;
 *   - le Blobby Companion (js/blobby_companion.js) déclenche la même invite sur
 *     le 401 de POST /aih/blobby/exec.
 *
 * SÉMANTIQUE DE SESSION (AUCUN timeout) :
 *   - Backend : cookie de SESSION `holaf_session` (aucun Max-Age/Expires → il
 *     meurt à la fermeture du navigateur) ; jeton signé SANS expiration serveur.
 *     Une session ne se termine QUE par un logout explicite ou la fermeture du
 *     navigateur — jamais à cause d'une opération longue.
 *   - Front : l'état est mémorisé en mémoire (state.authenticated). Une fois
 *     authentifié, AUCUN autre outil ne redemande : ensureAuthenticated()
 *     résout immédiatement true. Deux appels SIMULTANÉS partagent la MÊME
 *     promesse/dialogue (state.pending) : jamais deux invites en double.
 *   - Sur 401 tardif (session invalidée côté serveur, ex. logout dans un autre
 *     onglet), withAuthRetry() invalide l'état, rouvre l'invite partagée UNE
 *     fois, puis rejoue l'appel.
 *
 * Le dialogue est le système unifié AIH.Dialog (js/aih_dialog.js) : même look,
 * même thème, même z-index que le reste du pack. Le minimum de mot de passe
 * (8 par défaut) est lu depuis GET /holaf/auth/status (min_password_length).
 *
 * API : window.HolafAuth.{ensureAuthenticated, withAuthRetry, isAuthenticated}
 *       + exports ESM pour les modules du pack.
 * === End Documentation ===
 */
import "./aih_dialog.js";
import "./aih_strings.js";
import { HolafFetch, HolafFetchError } from "./vendor/holaf/holaf-fetch.js";

// Helper i18n central : traduit via AIH.I18n (clé brute si absente).
const t = (key, params) => {
    const I = window.AIH && window.AIH.I18n;
    return I && typeof I.t === "function" ? I.t(key, params) : key;
};

// Minimum de secours si le serveur n'expose pas min_password_length.
const DEFAULT_MIN_PASSWORD_LENGTH = 8;

/** État mémoire de session (volontairement NON persisté : session navigateur). */
const state = {
    authenticated: false,      // session constatée (cookie valide)
    statusChecked: false,      // GET /holaf/auth/status a déjà répondu
    passwordConfigured: null,  // null = inconnu, true/false sinon
    minPasswordLength: DEFAULT_MIN_PASSWORD_LENGTH,
    pending: null,             // promesse d'invite en cours (anti-doublon)
};

/** Vrai pour une réponse 401 levée par HolafFetch. */
export function isUnauthorized(err) {
    return err instanceof HolafFetchError && err.status === 401;
}

/** Invalide l'état mémoire (le prochain ensureAuthenticated re-vérifiera). */
export function expireSession() {
    state.authenticated = false;
    state.statusChecked = false;
}

/** Réinitialise complètement l'état — réservé aux tests. */
export function resetAuthState() {
    state.authenticated = false;
    state.statusChecked = false;
    state.passwordConfigured = null;
    state.minPasswordLength = DEFAULT_MIN_PASSWORD_LENGTH;
    state.pending = null;
}

/** Vrai si une session a déjà été constatée dans cette page. */
export function isAuthenticated() {
    return state.authenticated;
}

/** Interroge le statut serveur et met à jour l'état mémoire. */
async function fetchStatus() {
    const data = await HolafFetch.get("/holaf/auth/status", { cache: "no-store" });
    state.statusChecked = true;
    state.authenticated = data.authenticated === true;
    state.passwordConfigured = data.password_configured === true;
    const min = Number(data.min_password_length);
    if (Number.isFinite(min) && min > 0) state.minPasswordLength = min;
    return data;
}

function makeEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function makeInput(type, autocomplete) {
    const input = document.createElement("input");
    input.type = type;
    input.autocomplete = autocomplete;
    input.style.cssText = "width:100%;padding:8px;box-sizing:border-box;background-color:var(--holaf-input-background);color:var(--holaf-text-primary);border:1px solid var(--holaf-border-color);border-radius:3px;outline:none;margin-bottom:10px;";
    return input;
}

/**
 * Ouvre l'unique dialogue d'authentification et résout true si la session est
 * obtenue, false si l'utilisateur annule.
 * @param {string} [message] message contextuel du premier outil demandeur.
 * @param {{mode?: "login"|"setup"}} [opts]
 */
function openDialog(message, opts) {
    opts = opts || {};
    const mode = opts.mode === "setup" ? "setup" : "login";

    return new Promise((resolve) => {
        const dialogApi = window.AIH && window.AIH.Dialog;
        if (!dialogApi || typeof dialogApi.open !== "function") {
            console.error("[HolafAuth] AIH.Dialog indisponible : authentification impossible.");
            resolve(false);
            return;
        }

        const refs = { password: null, confirm: null, status: null, manual: null, manualInput: null };

        const ctrl = dialogApi.open({
            modal: true,
            draggable: true,
            width: "420px",
            minWidth: "320px",
            title: mode === "setup" ? t("auth.setupTitle") : t("auth.title"),
            content: (body) => {
                const info = makeEl(
                    "p", "aih-dialog-message",
                    mode === "setup"
                        ? t("auth.setupMessage", { min: state.minPasswordLength })
                        : (message || t("auth.message"))
                );
                info.style.cssText = "margin:0 0 12px 0;line-height:1.4;";

                const passLabel = makeEl(
                    "label",
                    null,
                    mode === "setup"
                        ? t("auth.newPassword", { min: state.minPasswordLength })
                        : t("auth.password")
                );
                passLabel.style.cssText = "display:block;margin-bottom:5px;";

                refs.password = makeInput(
                    "password",
                    mode === "setup" ? "new-password" : "current-password"
                );

                body.append(info, passLabel, refs.password);

                if (mode === "setup") {
                    const confirmLabel = makeEl("label", null, t("auth.confirmPassword"));
                    confirmLabel.style.cssText = "display:block;margin-bottom:5px;";
                    refs.confirm = makeInput("password", "new-password");
                    body.append(confirmLabel, refs.confirm);

                    // Fallback manuel : config.ini non inscriptible (permissions).
                    const manual = makeEl("div", "aih-dialog-manual-setup");
                    manual.style.cssText = "display:none;margin-top:10px;padding:8px;border:1px dashed var(--holaf-border-color);border-radius:3px;font-size:12px;";
                    const manualTitle = makeEl("p", null, t("auth.manualTitle"));
                    manualTitle.style.cssText = "margin:0 0 6px 0;font-weight:bold;";
                    const manualSteps = makeEl("p", null, t("auth.manualSteps"));
                    manualSteps.style.cssText = "margin:0 0 6px 0;";
                    refs.manualInput = document.createElement("input");
                    refs.manualInput.type = "text";
                    refs.manualInput.readOnly = true;
                    refs.manualInput.style.cssText = "width:100%;font-family:monospace;padding:6px;box-sizing:border-box;background-color:var(--holaf-input-background);color:var(--holaf-text-primary);border:1px solid var(--holaf-border-color);border-radius:3px;margin-bottom:6px;";
                    const copyButton = makeEl("button", "comfy-button", t("auth.copyHash"));
                    copyButton.addEventListener("click", () => {
                        try {
                            if (navigator.clipboard && navigator.clipboard.writeText) {
                                navigator.clipboard.writeText(refs.manualInput.value).catch(() => {});
                            }
                        } catch (e) { /* presse-papiers indisponible : l'utilisateur copie à la main */ }
                    });
                    manual.append(manualTitle, manualSteps, refs.manualInput, copyButton);
                    refs.manual = manual;
                    body.append(manual);
                }

                refs.status = makeEl("p", "aih-dialog-auth-status");
                refs.status.style.cssText = "margin:0;color:var(--holaf-accent-color);font-size:0.9em;min-height:1.2em;";
                body.append(refs.status);
            },
            buttons: [
                { text: t("auth.cancel"), value: "cancel", type: "cancel" },
                {
                    text: mode === "setup" ? t("auth.create") : t("auth.connect"),
                    value: "submit",
                    type: "primary",
                },
            ],
            onOpen: () => {
                setTimeout(() => {
                    if (refs.password && typeof refs.password.focus === "function") refs.password.focus();
                }, 50);
            },
            guard: (value) => {
                if (value !== "submit") return true; // Annuler → fermeture.
                return submitDialog(refs, mode);     // false → garder ouvert.
            },
            _onResolve: (value) => resolve(value === "submit"),
        });

        // Entrée valide le formulaire sans cliquer sur le bouton.
        const submitOnEnter = async (e) => {
            if (!e || e.key !== "Enter") return;
            if (e.preventDefault) e.preventDefault();
            const ok = await submitDialog(refs, mode);
            if (ok) ctrl.close("submit");
        };
        if (refs.password) refs.password.addEventListener("keydown", submitOnEnter);
        if (refs.confirm) refs.confirm.addEventListener("keydown", submitOnEnter);
    });
}

/**
 * Soumission du dialogue : valide côté client puis appelle /holaf/auth/setup
 * (définition/changement) ou /holaf/auth/login. Retourne true si authentifié
 * (le dialogue se ferme), false pour garder le dialogue ouvert (erreur ou
 * fallback manuel).
 */
async function submitDialog(refs, mode) {
    const setStatus = (text) => {
        if (refs.status) refs.status.textContent = text || "";
    };

    const password = refs.password ? refs.password.value : "";
    if (!password) {
        setStatus(t("auth.passwordEmpty"));
        if (refs.password && refs.password.focus) refs.password.focus();
        return false;
    }

    if (mode === "setup") {
        if (password.length < state.minPasswordLength) {
            setStatus(t("auth.passTooShort", { min: state.minPasswordLength }));
            return false;
        }
        if (refs.confirm && password !== refs.confirm.value) {
            setStatus(t("auth.passMismatch"));
            if (refs.confirm.focus) refs.confirm.focus();
            return false;
        }
    }

    setStatus(mode === "setup" ? t("auth.settingPassword") : t("auth.authenticating"));

    try {
        if (mode === "setup") {
            // HolafFetch lève sur non-2xx → catch ci-dessous.
            const data = await HolafFetch.post("/holaf/auth/setup", { body: { password } });

            if (data.status === "manual_required" && data.hash) {
                // config.ini non inscriptible : afficher le hash à coller à la main.
                if (refs.manualInput) refs.manualInput.value = `password_hash = ${data.hash}`;
                if (refs.manual) refs.manual.style.display = "block";
                setStatus("");
                return false;
            }
            if (data.status !== "ok") {
                setStatus(`Error: ${data.message || t("auth.unknownError")}`);
                return false;
            }
        } else {
            const data = await HolafFetch.post("/holaf/auth/login", { body: { password } });
            if (data.success !== true) {
                setStatus(t("auth.invalidPassword"));
                return false;
            }
        }

        // Succès : mémoriser la session (les autres outils ne redemanderont pas).
        state.authenticated = true;
        state.statusChecked = true;
        if (mode === "setup") state.passwordConfigured = true;
        setStatus("");
        return true;
    } catch (e) {
        console.error("[HolafAuth] Auth request failed:", e);
        if (e instanceof HolafFetchError) {
            if (e.status === 0) {
                setStatus(t("auth.cantReachServer"));
            } else if (e.status === 401) {
                setStatus(t("auth.invalidPassword"));
            } else {
                const serverMessage = (e.data && (e.data.message || e.data.error)) || "";
                setStatus(serverMessage ? `Error: ${serverMessage}` : t("auth.unknownError"));
            }
        } else {
            setStatus(t("auth.unknownError"));
        }
        return false;
    } finally {
        if (refs.password) refs.password.value = "";
        if (refs.confirm) refs.confirm.value = "";
    }
}

/**
 * Garantit une session authentifiée. UNE SEULE invite partagée à la fois ;
 * après succès, tout appel suivant résout true sans rien redemander.
 * @param {string} [message] message affiché par l'invite (1er outil demandeur).
 * @returns {Promise<boolean>} true si authentifié, false si annulé.
 */
export function ensureAuthenticated(message) {
    if (state.authenticated && state.statusChecked) return Promise.resolve(true);
    if (state.pending) return state.pending;

    state.pending = (async () => {
        if (!state.statusChecked) {
            try {
                await fetchStatus();
            } catch (e) {
                // Statut injoignable : on tente quand même l'invite (login).
                console.warn("[HolafAuth] Status check failed:", e);
            }
        }
        if (state.authenticated) return true;
        const mode = (state.statusChecked && state.passwordConfigured === false) ? "setup" : "login";
        return openDialog(message, { mode });
    })().finally(() => { state.pending = null; });

    return state.pending;
}

/**
 * Exécute *fn* ; sur 401, invalide la session, ouvre l'invite partagée UNE
 * fois puis rejoue *fn*. Les autres erreurs remontent inchangées.
 * @param {() => Promise<any>} fn
 * @param {string} [message]
 */
export async function withAuthRetry(fn, message) {
    try {
        return await fn();
    } catch (err) {
        if (!isUnauthorized(err)) throw err;
        expireSession();
        const ok = await ensureAuthenticated(message);
        if (!ok) throw err;
        return await fn();
    }
}

/**
 * Valide PUREMENT (sans réseau) un changement de mot de passe.
 * @param {string} currentPassword
 * @param {string} newPassword
 * @param {string} confirmPassword
 * @param {number} [minLength] minimum effectif (sinon celui constaté/par défaut)
 * @returns {{ok: true, min: number}|{ok: false, reason: string, min: number}}
 *   reason ∈ "current-missing" | "new-missing" | "too-short" | "mismatch".
 */
export function validatePasswordChange(currentPassword, newPassword, confirmPassword, minLength) {
    const min = (Number.isFinite(minLength) && minLength > 0)
        ? Math.floor(minLength)
        : state.minPasswordLength;
    if (!currentPassword) return { ok: false, reason: "current-missing", min };
    if (!newPassword) return { ok: false, reason: "new-missing", min };
    if (newPassword.length < min) return { ok: false, reason: "too-short", min };
    if (newPassword !== confirmPassword) return { ok: false, reason: "mismatch", min };
    return { ok: true, min };
}

/**
 * Change le mot de passe partagé (route EXISTANTE POST /holaf/auth/setup, qui
 * exige déjà le mot de passe courant). Sur succès, le serveur repose un cookie
 * de session (auto-login) : l'état mémoire est donc marqué authentifié.
 * Lève une HolafFetchError sur refus (403 = mot de passe actuel incorrect,
 * 400 = nouveau trop court) ; les autres erreurs remontent telles quelles.
 * @param {string} currentPassword
 * @param {string} newPassword
 * @returns {Promise<true>}
 */
export async function changePassword(currentPassword, newPassword) {
    const data = await HolafFetch.post("/holaf/auth/setup", {
        body: { current_password: currentPassword, password: newPassword },
    });
    if (!data || data.status !== "ok") {
        const err = new Error((data && (data.message || data.status)) || "unknown");
        err.reason = (data && data.status) || "unknown";
        throw err;
    }
    state.authenticated = true;
    state.statusChecked = true;
    return true;
}

/**
 * Minimum de mot de passe effectif (interroge le statut si nécessaire).
 * @returns {Promise<number>}
 */
export async function getMinPasswordLength() {
    if (!state.statusChecked) {
        try { await fetchStatus(); } catch (e) { /* repli sur la valeur par défaut */ }
    }
    return state.minPasswordLength;
}

if (typeof window !== "undefined") {
    window.HolafAuth = {
        ensureAuthenticated,
        withAuthRetry,
        isAuthenticated,
        expireSession,
        resetAuthState,
        validatePasswordChange,
        changePassword,
        getMinPasswordLength,
        MIN_PASSWORD_LENGTH: DEFAULT_MIN_PASSWORD_LENGTH,
    };
}
