// ─────────────────────────────────────────────────────────────────────────
// BALAYAGE STATIQUE — le pack ComfyUI-AI-Helper n'a AUCUNE authentification
// applicative (« zéro mot de passe », décision produit : la sécurité est
// assurée par le reverse-proxy Caddy + Authentik devant ComfyUI).
//
// Ce test remplace les anciens garde-fous d'auth (js/test_holaf_auth.mjs et
// js/test_protected_routes_auth_guard.mjs) et prouve l'INVERSE :
//   - le module front d'invite js/holaf_auth.js n'existe plus ;
//   - AUCUN fichier du front (hors briques vendor/) ne référence l'auth
//     résiduelle (holaf_auth, ensureAuthenticated, authFetch, /holaf/auth…) ;
//   - les clés i18n d'auth ont disparu de js/aih_strings.js ;
//   Un contrôle NÉGATIF synthétique prouve que le scanner DÉTECTE bien une
//   référence d'auth (sinon le test serait vert à tort car il ne scannerait rien).
//
// Usage : node js/test_no_app_auth.mjs
// Code de sortie : 0 = PASS, 1 = FAIL. (Pas de jsdom requis.)
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// Jetons d'auth applicative INTERDITS dans le code front (hors commentaires
// justificatifs éventuels — ici on est strict : aucune occurrence du tout).
const AUTH_TOKENS = [
    "holaf_auth.js",
    "ensureAuthenticated",
    "withAuthRetry",
    "authFetch",
    "postAuthenticated",
    "HolafAuth",
    "expireSession",
    "isUnauthorized",
    "holaf_session",
    "password_configured",
    "min_password_length",
    "password_is_set",
    "/holaf/auth",
];

/** Retourne la liste des jetons d'auth trouvés dans `src` (contrôle testable). */
export function scanForAuthTokens(src) {
    return AUTH_TOKENS.filter((tok) => src.includes(tok));
}

// Fichiers front (js/**/*.js), hors briques vendor/, helpers de test et node_modules.
function collectFrontFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "vendor" || entry.name === "test_helpers" || entry.name === "node_modules" || entry.name === "css") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...collectFrontFiles(full));
        else if (entry.name.endsWith(".js") && !entry.name.startsWith("test_")) out.push(full);
    }
    return out;
}

let n = 0;
const ok = (m) => { n++; console.log("  ✓ " + m); };

console.log("1. Le module d'auth front a disparu");
assert.strictEqual(existsSync(join(HERE, "holaf_auth.js")), false, "js/holaf_auth.js ne doit plus exister");
ok("js/holaf_auth.js absent");

console.log("2. Contrôle NÉGATIF : le scanner détecte bien une référence d'auth");
{
    const bad = `import { authFetch } from "./holaf_auth.js";\nawait authFetch("/holaf/auth/status");\n`;
    const found = scanForAuthTokens(bad);
    assert.ok(found.includes("holaf_auth.js"), "le scanner doit voir holaf_auth.js");
    assert.ok(found.includes("authFetch"), "le scanner doit voir authFetch");
    assert.ok(found.includes("/holaf/auth"), "le scanner doit voir /holaf/auth");
    ok("un source synthétique d'auth est bien signalé (scanner non vide)");
}

console.log("3. Balayage EXHAUSTIF du front (hors vendor/)");
{
    const files = collectFrontFiles(HERE);
    assert.ok(files.length > 20, `trop peu de fichiers front analysés : ${files.length}`);
    const violations = [];
    for (const f of files) {
        const src = readFileSync(f, "utf8");
        const found = scanForAuthTokens(src);
        if (found.length) violations.push({ file: relative(HERE, f), tokens: found });
    }
    for (const v of violations) console.error(`   ✗ ${v.file}: ${v.tokens.join(", ")}`);
    assert.deepStrictEqual(violations, [], `${violations.length} fichier(s) front référencent encore l'auth`);
    ok(`${files.length} fichiers front analysés — ZÉRO référence d'auth`);
}

console.log("4. Les clés i18n d'auth ont disparu (FR + EN)");
{
    const strings = readFileSync(join(HERE, "aih_strings.js"), "utf8");
    const forbiddenKeys = [
        '"auth.', '"settings.security"', '"settings.change',
        '"term.authRequired"', '"bl.sessionRequired"',
        '"mma.sessionRequired"', '"mma.authCancelled"', '"mma.authRefused"',
        '"nm.auth', '"nm.sessionExpired"',
    ];
    for (const key of forbiddenKeys) {
        assert.ok(!strings.includes(key), `clé i18n d'auth résiduelle : ${key}`);
    }
    // Contrôle de non-régression : des clés légitimes subsistent.
    assert.ok(strings.includes('"term.connect"'), "les clés Terminal légitimes restent présentes");
    assert.ok(strings.includes('"mma.chunkFailed"'), "les clés d'upload légitimes restent présentes");
    ok("aucune clé i18n d'auth résiduelle ; les clés métier restent");
}

console.log("5. Aucun appel front vers une route d'auth locale");
{
    const files = collectFrontFiles(HERE);
    const hits = [];
    for (const f of files) {
        const src = readFileSync(f, "utf8");
        if (/["'`]\/holaf\/auth\//.test(src)) hits.push(relative(HERE, f));
    }
    assert.deepStrictEqual(hits, [], `appels /holaf/auth/* détectés : ${hits.join(", ")}`);
    ok("zéro point d'appel /holaf/auth/* dans le front");
}

console.log(`\n✅ test_no_app_auth : ${n} groupes PASSENT`);
