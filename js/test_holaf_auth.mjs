// Invite d'authentification UNIFIÉE (js/holaf_auth.js) avec le fake DOM partagé
// et un fetch stubbé : node test_holaf_auth.mjs
//
// Ce que ce test verrouille :
//   1. UN SEUL dialogue partagé : deux outils qui appellent ensureAuthenticated()
//      en même temps partagent la même invite (aucun doublon) ;
//   2. APRÈS authentification, un second outil ne redemande RIEN (aucune
//      requête, aucun dialogue) — session mémorisée pour la page ;
//   3. setup : minimum 8 caractères (7 refusé côté client SANS requête, 8 accepté) ;
//   4. mot de passe incorrect : erreur affichée, dialogue maintenu ouvert ;
//   5. withAuthRetry : session expirée (401) → invite partagée UNE fois → retry ;
//   6. parité i18n FR/EN stricte (dictionnaires complets) + clés auth.* ;
//   7. les outils (terminal, Nodes Manager, Blobby) délèguent au module partagé
//      et ne recréent AUCUN champ/modal de mot de passe (pas de duplication).
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fakeDocument } from "./test_helpers/fake_dom.mjs";
import { HolafFetchError } from "./vendor/holaf/holaf-fetch.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, label) {
    for (let i = 0; i < 100; i++) {
        if (cond()) return;
        await sleep(5);
    }
    throw new Error("waitFor timeout: " + label);
}
const ok = (msg) => console.log("  ✅ " + msg);

/* ── i18n : capture des dictionnaires AVANT enregistrement ─────────────── */
await import("./aih_i18n.js");
const I18n = globalThis.window.AIH.I18n;
const captured = {};
const origAddDict = I18n.addDict.bind(I18n);
I18n.addDict = (lang, entries) => {
    captured[lang] = Object.assign(captured[lang] || {}, entries);
    return origAddDict(lang, entries);
};
await import("./aih_strings.js");
I18n.setLocale("fr");

/* ── Stub réseau : /holaf/auth/{status,login,setup} ────────────────────── */
const calls = [];
let statusResponse = { status: 200, data: { authenticated: false, password_configured: true, min_password_length: 8 } };
let loginResponse = { status: 200, data: { success: true } };
const setupResponse = { status: 200, data: { status: "ok" } };

function jsonResponse(status, data) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    const method = init.method || "GET";
    let body = null;
    if (typeof init.body === "string") {
        try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ path, method, body });
    if (path.includes("/holaf/auth/status")) return jsonResponse(statusResponse.status, statusResponse.data);
    if (path.includes("/holaf/auth/login")) return jsonResponse(loginResponse.status, loginResponse.data);
    if (path.includes("/holaf/auth/setup")) return jsonResponse(setupResponse.status, setupResponse.data);
    throw new Error("unexpected fetch: " + path);
};

/* ── Module sous test ───────────────────────────────────────────────────── */
const authMod = await import("./holaf_auth.js");
const HolafAuth = globalThis.window.HolafAuth;
assert.ok(authMod.ensureAuthenticated && authMod.withAuthRetry, "exports ESM présents");
assert.ok(HolafAuth && HolafAuth.ensureAuthenticated, "window.HolafAuth exposé");
assert.strictEqual(HolafAuth.MIN_PASSWORD_LENGTH, 8, "minimum de secours = 8");

/* ── Helpers DOM ────────────────────────────────────────────────────────── */
const dialogRoots = () => fakeDocument.body._allDescendants([]).filter((n) => n.classList.contains("aih-dialog-root"));
const passwordInputs = (root) => root.querySelectorAll("input").filter((i) => i.type === "password");
const statusText = (root) => {
    const el = root.querySelector(".aih-dialog-auth-status");
    return el ? el.textContent : "";
};
const clickPrimary = (root) => {
    const btn = root.querySelector(".aih-dialog-btn-primary");
    assert.ok(btn, "bouton primaire du dialogue présent");
    btn.dispatch("click", { preventDefault() {}, stopPropagation() {} });
};
const loginCalls = () => calls.filter((c) => c.path.includes("/holaf/auth/login"));
const setupCalls = () => calls.filter((c) => c.path.includes("/holaf/auth/setup"));

/* ════════ 1. UNE seule invite partagée + aucune redemande après auth ════ */
console.log("1. Invite unique partagée + session réutilisée");
authMod.resetAuthState();
calls.length = 0;
statusResponse = { status: 200, data: { authenticated: false, password_configured: true, min_password_length: 8 } };
loginResponse = { status: 200, data: { success: true } };

const pTerminal = authMod.ensureAuthenticated("terminal");
const pNodes = authMod.ensureAuthenticated("nodes manager");
await waitFor(() => dialogRoots().length === 1, "invite unique");
assert.strictEqual(dialogRoots().length, 1, "deux outils simultanés → UN SEUL dialogue");
assert.strictEqual(passwordInputs(dialogRoots()[0]).length, 1, "mode login : un champ mot de passe");
ok("deux appels simultanés partagent le même dialogue (anti-doublon)");

passwordInputs(dialogRoots()[0])[0].value = "password-8";
clickPrimary(dialogRoots()[0]);
assert.strictEqual(await pTerminal, true, "le terminal obtient la session");
assert.strictEqual(await pNodes, true, "le Nodes Manager obtient la même session");
assert.strictEqual(dialogRoots().length, 0, "dialogue fermé après succès");
assert.strictEqual(loginCalls().length, 1, "une seule requête de login pour les deux outils");
ok("les deux outils résolvent true avec un seul login");

const callsAfterAuth = calls.length;
assert.strictEqual(await authMod.ensureAuthenticated("blobby"), true, "session encore valide");
assert.strictEqual(dialogRoots().length, 0, "AUCUN nouveau dialogue après authentification");
assert.strictEqual(calls.length, callsAfterAuth, "AUCUNE requête supplémentaire (session mémorisée)");
ok("après authentification, un second outil ne redemande pas");

/* ════════ 2. Setup : minimum 8 (7 refusé, 8 accepté) ════════════════════ */
console.log("2. Setup : minimum 8 caractères");
authMod.resetAuthState();
calls.length = 0;
statusResponse = { status: 200, data: { authenticated: false, password_configured: false, min_password_length: 8 } };

const pSetup = authMod.ensureAuthenticated("setup tool");
await waitFor(() => dialogRoots().length === 1, "dialogue de setup");
const setupRoot = dialogRoots()[0];
const setupInputs = passwordInputs(setupRoot);
assert.strictEqual(setupInputs.length, 2, "mode setup : mot de passe + confirmation");

setupInputs[0].value = "1234567";
setupInputs[1].value = "1234567";
clickPrimary(setupRoot);
await waitFor(() => statusText(setupRoot) !== "", "message min 8");
assert.strictEqual(dialogRoots().length, 1, "7 caractères : le dialogue reste ouvert");
assert.strictEqual(statusText(setupRoot), I18n.t("auth.passTooShort", { min: 8 }), "message minimum 8");
assert.strictEqual(setupCalls().length, 0, "7 caractères : AUCUNE requête setup");
ok("7 caractères refusé côté client (aucune requête)");

setupInputs[0].value = "12345678";
setupInputs[1].value = "12345678";
clickPrimary(setupRoot);
assert.strictEqual(await pSetup, true, "8 caractères acceptés");
assert.strictEqual(setupCalls().length, 1, "une requête setup");
assert.strictEqual(setupCalls()[0].body.password.length, 8, "le mot de passe de 8 est envoyé");
ok("8 caractères accepté et envoyé à /holaf/auth/setup");

/* ════════ 3. Mot de passe incorrect : erreur propre, dialogue ouvert ════ */
console.log("3. Mot de passe incorrect");
authMod.resetAuthState();
calls.length = 0;
statusResponse = { status: 200, data: { authenticated: false, password_configured: true, min_password_length: 8 } };
loginResponse = { status: 401, data: { success: false, error: "Invalid credentials." } };

const pWrong = authMod.ensureAuthenticated("tool");
await waitFor(() => dialogRoots().length === 1, "dialogue login");
const wrongRoot = dialogRoots()[0];
// Le 401 intentionnel loggue une erreur : silence pour une sortie de test propre.
const consoleError = console.error;
console.error = () => {};
passwordInputs(wrongRoot)[0].value = "wrong-password";
clickPrimary(wrongRoot);
await waitFor(
    () => statusText(wrongRoot) === I18n.t("auth.invalidPassword"),
    "message d'erreur"
);
console.error = consoleError;
assert.strictEqual(dialogRoots().length, 1, "dialogue maintenu ouvert après 401");
assert.strictEqual(statusText(wrongRoot), I18n.t("auth.invalidPassword"), "mot de passe incorrect signalé");
ok("401 → erreur affichée, dialogue maintenu ouvert");

loginResponse = { status: 200, data: { success: true } };
passwordInputs(wrongRoot)[0].value = "password-8";
clickPrimary(wrongRoot);
assert.strictEqual(await pWrong, true, "réessai avec le bon mot de passe");
assert.strictEqual(dialogRoots().length, 0, "dialogue fermé après le succès");
ok("réessai réussi sans rouvrir un second dialogue");

/* ════════ 4. withAuthRetry : 401 tardif → invite partagée puis retry ════ */
console.log("4. withAuthRetry (session expirée)");
authMod.resetAuthState();
calls.length = 0;
statusResponse = { status: 200, data: { authenticated: true, password_configured: true, min_password_length: 8 } };
loginResponse = { status: 200, data: { success: true } };

assert.strictEqual(await authMod.ensureAuthenticated("first tool"), true, "session initiale");
// Session invalidée côté serveur (logout ailleurs / cookie disparu) : le prochain statut redira false.
statusResponse = { status: 200, data: { authenticated: false, password_configured: true, min_password_length: 8 } };
let attempts = 0;
const retryP = authMod.withAuthRetry(async () => {
    attempts++;
    if (attempts === 1) throw new HolafFetchError("unauthorized", { status: 401 });
    return "ok";
}, "retry tool");
await waitFor(() => dialogRoots().length === 1, "dialogue après 401");
passwordInputs(dialogRoots()[0])[0].value = "password-8";
clickPrimary(dialogRoots()[0]);
assert.strictEqual(await retryP, "ok", "l'appel est rejoué après ré-authentification");
assert.strictEqual(attempts, 2, "exactement un retry");
assert.strictEqual(loginCalls().length, 1, "une invite/ré-auth pour le retry");
ok("401 tardif → invite partagée → un seul retry");

/* ════════ 5. i18n FR/EN : parité stricte + clés auth.* ══════════════════ */
console.log("5. i18n FR/EN");
const frKeys = Object.keys(captured.fr || {}).sort();
const enKeys = Object.keys(captured.en || {}).sort();
assert.deepStrictEqual(frKeys, enKeys, "parité stricte FR/EN (dictionnaires complets)");
const authKeys = frKeys.filter((k) => k.startsWith("auth."));
assert.ok(authKeys.length >= 20, `clés auth.* présentes (${authKeys.length})`);
for (const k of authKeys) {
    assert.ok(captured.fr[k] && captured.fr[k] !== k, `FR ${k} non vide`);
    assert.ok(captured.en[k] && captured.en[k] !== k, `EN ${k} non vide`);
}
assert.ok(captured.fr["auth.setupMessage"].includes("{min}"), "FR setupMessage porte {min}");
assert.ok(captured.en["auth.setupMessage"].includes("{min}"), "EN setupMessage porte {min}");
ok(`parité FR/EN OK (${frKeys.length} clés, ${authKeys.length} clés auth.*)`);

/* ════════ 6. Les outils délèguent au module partagé (pas de duplication) */
console.log("6. Outils branchés sur l'invite partagée");
const sharedSrc = readFileSync(new URL("./holaf_auth.js", import.meta.url), "utf8");
assert.ok(sharedSrc.includes("AIH.Dialog"), "l'invite partagée utilise AIH.Dialog");
for (const file of ["holaf_terminal.js", "holaf_nodes_manager.js", "blobby_companion.js"]) {
    const src = readFileSync(new URL("./" + file, import.meta.url), "utf8");
    assert.ok(src.includes("holaf_auth.js"), `${file} importe holaf_auth.js`);
    assert.ok(!/type\s*=\s*"password"/.test(src), `${file} ne crée aucun champ mot de passe`);
    assert.ok(!src.includes("/holaf/auth/login"), `${file} n'appelle pas le login en direct`);
}
ok("terminal + Nodes Manager + Blobby délèguent à HolafAuth (0 duplication)");

/* ════════ 7. Changement de mot de passe (paramètres) ══════════════════ */
console.log("7. Changement de mot de passe (valider + route)");
const validate = authMod.validatePasswordChange;
assert.ok(typeof validate === "function", "validatePasswordChange exporté");
assert.strictEqual(validate("cur-pass", "1234567", "1234567", 8).reason, "too-short", "7 refusé");
assert.strictEqual(validate("cur-pass", "12345678", "12345678", 8).ok, true, "8 accepté");
assert.strictEqual(validate("", "12345678", "12345678", 8).reason, "current-missing", "actuel exigé");
assert.strictEqual(validate("cur-pass", "", "", 8).reason, "new-missing", "nouveau exigé");
assert.strictEqual(validate("cur-pass", "12345678", "87654321", 8).reason, "mismatch", "confirmation exigée");
ok("min 8 + mot de passe actuel + confirmation validés côté client");

authMod.resetAuthState();
calls.length = 0;
setupResponse.status = 200;
setupResponse.data = { status: "ok" };
assert.strictEqual(await authMod.changePassword("old-pass", "new-pass"), true, "changePassword réussit");
const changeCall = setupCalls().find((c) => c.body && c.body.current_password === "old-pass");
assert.ok(changeCall, "la requête porte current_password");
assert.strictEqual(changeCall.body.password, "new-pass", "la requête porte le nouveau mot de passe");
ok("changePassword → POST /holaf/auth/setup {current_password, password}");

setupResponse.status = 403;
setupResponse.data = { status: "error", message: "Current password is incorrect." };
const consoleErrorChange = console.error;
console.error = () => {};
let changeThrew = false;
try { await authMod.changePassword("wrong-pass", "new-pass"); } catch (e) { changeThrew = e.status === 403; }
console.error = consoleErrorChange;
assert.strictEqual(changeThrew, true, "mot de passe actuel incorrect → 403 remonté");
ok("mauvais mot de passe actuel refusé (403)");

console.log("✅ Simulation HolafAuth : TOUS LES TESTS PASSENT");
