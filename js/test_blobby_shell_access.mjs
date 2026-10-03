// ─────────────────────────────────────────────────────────────────────────
// ACCÈS SHELL BLOBBY — case à cocher « Autoriser l'accès au shell ».
//
// Couverture (front) :
//   (a) la case vit à côté du sélecteur de mode, libellé explicite + avertissement
//       (title), DÉCOCHÉE par défaut ;
//   (b) persistance EXACTEMENT comme le mode : localStorage
//       (blobbyData.blobbyShellAccess) + publication vers le pack
//       (POST /aih/blobby/save, clé blobbyShellAccess) pour la barrière serveur ;
//   (c) round-trip : toggle → fermeture/réouverture → état restauré ; lecture
//       « à froid » via _initShellAccess (aucun faux positif après rechargement) ;
//   (d) matrice mode × shell : read + coché ⇒ NON effectif ; active + coché ⇒ effectif ;
//   (e) barrière front : avec shell off, run_shell n'est PAS dans `tools` et un
//       tool_call run_shell est REFUSÉ sans aucune requête exec ;
//   (f) refus serveur (403 shell_forbidden) → message compréhensible, pas de
//       crash ni d'échec silencieux ;
//   (g) parité i18n FR/EN des clés bl.shell.* (0 manquante, 0 vide).
//
// Usage : node js/test_blobby_shell_access.mjs
//   jsdom résolu par js/test_helpers/jsdom_loader.mjs ; absent = SKIP (exit 2).
// Code de sortie : 0 = PASS, 2 = SKIP, 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const JSDOM = await loadJsdomOrSkip("test_blobby_shell_access");
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
});
const { window: domWindow } = dom;
globalThis.window = domWindow;
globalThis.document = domWindow.document;
globalThis.localStorage = domWindow.localStorage;
globalThis.getComputedStyle = domWindow.getComputedStyle.bind(domWindow);
globalThis.HTMLElement = domWindow.HTMLElement;
globalThis.Node = domWindow.Node;
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
try { globalThis.navigator = domWindow.navigator; } catch { /* Node fournit déjà un navigator */ }
domWindow.matchMedia = domWindow.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));

localStorage.setItem("aih_locale", "fr");
localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "http://aih.test", apiKey: "k", blobbyPreset: "3" }));

// ── Fake fetch global ──
const httpCalls = [];
const llmQueue = [];
function jsonResponse(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) },
        json: async () => data,
        text: async () => JSON.stringify(data),
    };
}
// Le serveur d'exécution refuse la commande "denied" (simule la barrière serveur).
const EXEC_DENIED = "denied";
globalThis.fetch = async (url, init) => {
    const u = String(url);
    let body = null;
    try { body = init && typeof init.body === "string" ? JSON.parse(init.body) : null; } catch { body = init?.body ?? null; }
    httpCalls.push({ url: u, method: (init && init.method) || "GET", body });

    if (u.includes("/api/keywords/llm-process")) {
        if (body && typeof body.instruction === "string" && body.instruction.includes("Personnalite actuelle")) {
            return jsonResponse({ output: "Blobby perso" });
        }
        if (llmQueue.length) return jsonResponse(llmQueue.shift());
        return jsonResponse({ output: "..." });
    }
    if (u.includes("/aih/blobby/exec")) {
        if (body && String(body.command || "").includes(EXEC_DENIED)) {
            return jsonResponse({ ok: false, error: "shell_forbidden", output: "⛔ refus serveur" }, 403);
        }
        return jsonResponse({ ok: true, output: "hello" });
    }
    if (u.includes("/api/blobby/memory")) return jsonResponse({ results: [] });
    if (u.includes("/api/presets")) return jsonResponse([]);
    if (u.includes("/api/settings")) return jsonResponse({});
    if (u.includes("/aih/blobby/save")) return jsonResponse({ status: "ok" });
    return jsonResponse({});
};

// ── Faux app ComfyUI (avant import : waitForApp s'y enregistre) ──
function freshApp() {
    const app = {
        graph: { nodes: [], setDirtyCanvas() {}, getNodeById() { return null; } },
        canvas: { setDirtyCanvas() {}, centerOnNode() {} },
        registerExtension(ext) { app.extensions.push(ext); },
        extensions: [],
    };
    return app;
}
globalThis.window.app = freshApp();

let modalSeq = 0;
function mockOpenModal(opts) {
    modalSeq++;
    const modal = document.createElement("div");
    modal.className = "aih-dialog-root " + (opts.className || "");
    const header = document.createElement("div");
    header.className = "aih-dialog-header";
    const body = document.createElement("div");
    body.className = "aih-dialog-body";
    if (opts.content) body.appendChild(opts.content);
    modal.appendChild(header);
    modal.appendChild(body);
    document.body.appendChild(modal);
    return { modal, el: modal, body, header, headerRight: header, close() { modal.remove(); } };
}

await import("./aih_i18n.js");
const I18n = domWindow.AIH.I18n;
const captured = {};
const origAddDict = I18n.addDict.bind(I18n);
I18n.addDict = (lang, entries) => {
    captured[lang] = Object.assign(captured[lang] || {}, entries);
    return origAddDict(lang, entries);
};
I18n.setLocale("fr");
await import("./blobby_companion.js");
domWindow.aihOpenModalV2 = mockOpenModal;

const Blobby = domWindow.Blobby;
assert.ok(Blobby && typeof Blobby._openChatModal === "function", "Blobby exposé (window.Blobby)");
assert.ok(typeof Blobby._initShellAccess === "function" && typeof Blobby.setShellAccess === "function", "API shell exposée");

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const saveCalls = () => httpCalls.filter((c) => c.url.includes("/aih/blobby/save"));
const execCalls = () => httpCalls.filter((c) => c.url.includes("/aih/blobby/exec"));
const msgs = (role) => [...(document.getElementById("blobby-chat-msgs") || { querySelectorAll: () => [] }).querySelectorAll(".blobby-msg")].filter((el) => el.dataset.role === role);

/* ══════════════════ (a) Case présente + défaut décoché ══════════════════ */
console.log("(a) Case « Autoriser l'accès au shell » : présence, libellé, défaut");

// Défaut sûr : rien en persistance → false.
Blobby.shellAccess = false;
Blobby._openChatModal();
const bar = document.getElementById("blobby-chat-modebar");
assert.ok(bar, "barre de mode présente");
const sel = bar.querySelector("#blobby-chat-mode-select");
const shellWrap = bar.querySelector("#blobby-chat-shell");
const shellCheck = bar.querySelector("#blobby-chat-shell-checkbox");
assert.ok(sel && shellWrap && shellCheck, "sélecteur de mode + case shell présents dans la même barre");
assert.strictEqual(shellWrap.tagName, "LABEL", "la case est un <label> (clic sur le texte = bascule)");
assert.strictEqual(shellCheck.type, "checkbox", "input type=checkbox");
assert.strictEqual(shellCheck.checked, false, "DÉCOCHÉE par défaut (sécurité)");
assert.strictEqual(shellWrap.textContent.trim(), I18n.t("bl.shell.label"), "libellé explicite (i18n)");
assert.ok((shellWrap.title || "").includes("ComfyUI"), `avertissement présent (title) : ${shellWrap.title}`);
assert.ok(bar.children[2] === shellWrap, "la case est le 3ᵉ contrôle, à côté du sélecteur (après Mode + select)");
assert.strictEqual(Blobby.isShellAllowed(), false, "autorisation effective nulle par défaut");
ok("(a) case à côté du mode, libellé + avertissement, décochée par défaut");

/* ══════════════════ (b) Toggle : persistance + publication pack ═════════ */
console.log("(b) Toggle : persistance blobbyData + publication /aih/blobby/save");

httpCalls.length = 0;
shellCheck.checked = true;
shellCheck.dispatchEvent(new domWindow.Event("change", { bubbles: true }));
assert.strictEqual(Blobby.getShellAccess(), true, "setShellAccess(true) appliqué");
assert.strictEqual(JSON.parse(localStorage.getItem("AIH_config")).blobbyData.blobbyShellAccess, true, "persisté (blobbyData.blobbyShellAccess)");
const pub = saveCalls().map((c) => c.body).filter((b) => b && b.key === "blobbyShellAccess");
assert.ok(pub.length >= 1 && pub[pub.length - 1].data === true, "publié vers le pack local (POST /aih/blobby/save, data=true)");

// Le mode read rend l'autorisation NON effective (le mode est la 1ʳᵉ barrière).
Blobby.setMode("read");
assert.strictEqual(Blobby.getShellAccess(), true, "la préférence reste stockée (cochée)");
assert.strictEqual(Blobby.isShellAllowed(), false, "read + coché ⇒ NON effectif");
assert.ok(document.getElementById("blobby-chat-shell").title.includes("Actif"), "title signale de passer en Actif");

shellCheck.checked = false;
shellCheck.dispatchEvent(new domWindow.Event("change", { bubbles: true }));
assert.strictEqual(Blobby.getShellAccess(), false, "setShellAccess(false) appliqué");
assert.strictEqual(JSON.parse(localStorage.getItem("AIH_config")).blobbyData.blobbyShellAccess, false, "décoché persisté");
ok("(b) toggle : persistance identique au mode + publication pack + mode prime en read");

/* ══════════════════ (c) Round-trip / lecture à froid ════════════════════ */
console.log("(c) Round-trip : réouverture et _initShellAccess");

Blobby.setShellAccess(true);
document.querySelector(".blobby-chat-modal").remove();
Blobby._openChatModal();
assert.strictEqual(document.getElementById("blobby-chat-shell-checkbox").checked, true, "réouverture : case restaurée cochée");

// Lecture « à froid » depuis la persistance.
localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "http://aih.test", blobbyPreset: "3", blobbyData: { blobbyShellAccess: true } }));
assert.strictEqual(Blobby._initShellAccess(), true, "_initShellAccess lit la valeur persistée (true)");
localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "http://aih.test", blobbyPreset: "3", blobbyData: {} }));
assert.strictEqual(Blobby._initShellAccess(), false, "_initShellAccess : absence de clé → false (défaut sûr)");
localStorage.setItem("AIH_config", JSON.stringify({ serverUrl: "http://aih.test", blobbyPreset: "3", blobbyData: { blobbyShellAccess: "nonsense" } }));
assert.strictEqual(Blobby._initShellAccess(), false, "valeur corrompue → false (fail-safe)");
ok("(c) round-trip : case restaurée + lecture à froid fiable (pas de faux positif)");

/* ══════════════════ (d)+(e)+(f) Chat : barrières front ══════════════════ */
console.log("(d)(e)(f) Chat : tools filtrés, refus sans exécution, refus serveur clair");

async function runChat(text, queue) {
    // Repart d'un état propre.
    httpCalls.length = 0;
    llmQueue.length = 0;
    const chat = document.getElementById("blobby-chat-msgs");
    chat.innerHTML = "";
    queue.forEach((item) => llmQueue.push(item));
    await Blobby._handleChatMessage(chat, text);
    await tick();
    return chat;
}
const llmPosts = () => httpCalls
    .filter((c) => c.url.includes("/api/keywords/llm-process"))
    .filter((c) => !(c.body && typeof c.body.instruction === "string" && c.body.instruction.includes("Personnalite actuelle")));

// (d/e) active + shell OFF : run_shell absent des tools, tool_call refusé sans exec.
Blobby.setMode("active");
Blobby.setShellAccess(false);
let chat = await runChat("test off", [{ output: "ok" }]);
let names = llmPosts()[0].body.tools.map((t) => t.function.name);
assert.ok(!names.includes("run_shell"), "shell off : run_shell absent de la liste envoyée au LLM");
chat = await runChat("tente", [
    { tool_calls: [{ id: "s1", type: "function", function: { name: "run_shell", arguments: '{"command":"ls"}' } }] },
    { output: "Je ne peux pas." },
]);
assert.strictEqual(execCalls().length, 0, "shell off : ZÉRO appel /aih/blobby/exec malgré le tool_call");
const toolMsg = llmPosts()[1].body.messages.find((m) => m.role === "tool");
assert.ok(toolMsg && /shell/i.test(toolMsg.content), "refus réinjecté au LLM (role:'tool')");
ok("(d)(e) shell off : run_shell retiré des tools + refus du dispatcher sans aucune exécution");

// (d) active + shell ON : run_shell présent + exécuté.
Blobby.setShellAccess(true);
chat = await runChat("test on", [{ output: "ok" }]);
names = llmPosts()[0].body.tools.map((t) => t.function.name);
assert.ok(names.includes("run_shell"), "shell on : run_shell présent dans les tools");
chat = await runChat("lance", [
    { tool_calls: [{ id: "s2", type: "function", function: { name: "run_shell", arguments: '{"command":"echo hello"}' } }] },
    { output: "Fait." },
]);
assert.strictEqual(execCalls().length, 1, "shell on : run_shell exécuté (1 appel)");
ok("(d) shell on : run_shell proposé puis exécuté (matrice mode × shell respectée)");

// (f) refus serveur 403 → message compréhensible, pas de crash silencieux.
chat = await runChat("lance denied", [
    { tool_calls: [{ id: "s3", type: "function", function: { name: "run_shell", arguments: `{"command":"${EXEC_DENIED} echo"}` } }] },
    { output: "Le serveur a refusé." },
]);
assert.strictEqual(execCalls().length, 1, "la commande est bien tentée (1 appel)");
assert.ok(!chat.textContent.includes("❌ Erreur"), "aucun crash");
const toolMsgDenied = llmPosts()[1].body.messages.find((m) => m.role === "tool");
assert.ok(toolMsgDenied && /refus/i.test(toolMsgDenied.content), `refus serveur remonté au LLM : ${toolMsgDenied && toolMsgDenied.content}`);
ok("(f) refus serveur (403) : erreur structurée remontée, jamais silencieuse ni fatale");

/* ══════════════════ (g) Parité i18n FR/EN ═══════════════════════════════ */
console.log("(g) Parité i18n FR/EN des clés bl.shell.*");

const SHELL_KEYS = ["bl.shell.label", "bl.shell.tooltip", "bl.shell.needsActive", "bl.shell.enabled", "bl.shell.disabled", "bl.shell.refused",
    "bl.toolErr.shellAccessDisabled", "bl.toolErr.shellForbidden", "bl.toolErr.shellFailed", "bl.toolErr.shellUnreachable", "bl.toolAct.runShell"];
for (const k of SHELL_KEYS) {
    assert.ok(k in (captured.fr || {}), `clé FR présente : ${k}`);
    assert.ok(k in (captured.en || {}), `clé EN présente : ${k}`);
    assert.ok(String(captured.fr[k]).trim() !== "" && String(captured.en[k]).trim() !== "", `clé non vide FR/EN : ${k}`);
}
const frShell = Object.keys(captured.fr || {}).filter((k) => k.startsWith("bl.shell") || k.startsWith("bl.toolErr.shell") || k === "bl.toolAct.runShell");
const missingEn = frShell.filter((k) => !(k in (captured.en || {})));
assert.deepStrictEqual(missingEn, [], `clés shell sans traduction EN : ${missingEn.join(", ")}`);
ok(`(g) parité FR/EN OK : ${SHELL_KEYS.length} clés shell présentes et non vides`);

console.log(`\n✅ Accès shell Blobby : TOUS LES TESTS PASSENT (${n} groupes d'assertions)`);
process.exit(0);
