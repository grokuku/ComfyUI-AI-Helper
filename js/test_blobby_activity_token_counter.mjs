// ─────────────────────────────────────────────────────────────────────────
// Chat Blobby — COMPTEUR DE TOKENS SUR LA LIGNE D'ACTIVITÉ.
//
// Demande utilisateur : le compteur (`~N tokens | X max`) s'affichait en bas à
// droite de la zone de messages et semblait la recouvrir. Il doit désormais
// partager la MÊME ligne que l'indicateur d'activité (#blobby-chat-activity,
// barre HORS zone de défilement) : libellé d'activité à GAUCHE, compteur à
// DROITE — et rester TOUJOURS lisible (au repos comme pendant un tour).
//
// Couverture :
//   (A) LOCALISATION DOM : le compteur #blobby-chat-ctx est un ENFANT DIRECT de
//       la barre d'activité et N'EST PLUS dans le conteneur des messages ;
//       ni le compteur ni la zone de messages ne sont en position:absolute.
//   (B) AU REPOS : la barre reste affichée (display:flex, pas de classe .on →
//       points + libellé masqués), le compteur est lisible à droite ;
//   (C) PENDANT UN TOUR : libellé d'activité à gauche ET compteur à droite
//       cohabitent sur la même ligne ; après le tour, la barre reste affichée ;
//   (D) EXACTITUDE + RAFRAÎCHISSEMENT : le max réel (max_context du flux) est
//       appliqué, et l'estimation augmente quand un message est ajouté ;
//   (E) NON-RÉGRESSION : bouton ⏹ Stop + indicateur toujours pilotés par le
//       cycle de vie (abandon → .on retiré, barre + compteur toujours là) ;
//   (F) INVARIANTS STATIQUES : source unique de vérité (appendChild + CSS).
//   (G) i18n : aucune nouvelle clé (parité FR/EN de bl.ctxBar conservée).
//
// Contrôles négatifs PAR MUTATION : voir /projects/.aih_tmp/blobby_activity_token/
// mutate.sh (remettre le compteur dans les messages → rouge ; masquer la barre
// au repos → rouge ; casser la mise à jour de la valeur → rouge).
//
// Usage : node js/test_blobby_activity_token_counter.mjs
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom indisponible), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const JSDOM = await loadJsdomOrSkip("test_blobby_activity_token_counter");
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

// ── Fake fetch pilotable (flux NDJSON) ──────────────────────────────────
const httpCalls = [];
const streamPlans = [];
const ndjson = (obj) => JSON.stringify(obj) + "\n";
const _origSetTimeout = globalThis.setTimeout;

function jsonResponse(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) },
        json: async () => data,
        text: async () => JSON.stringify(data),
    };
}

// Vraie ReadableStream (lue via res.body.getReader()) ; `hold` garde le flux
// ouvert (tour « en cours ») tant qu'on ne l'abandonne pas.
function streamResponse(chunks, signal, hold) {
    const enc = new TextEncoder();
    let cancelled = false, finished = false, pendingRead = false;
    const realBody = new ReadableStream({
        start(controller) {
            if (signal) {
                signal.addEventListener("abort", () => {
                    if (finished || cancelled || !pendingRead) return;
                    try { controller.error(Object.assign(new Error("Aborted"), { name: "AbortError" })); } catch { /* ignore */ }
                }, { once: true });
            }
            (async () => {
                for (const ch of chunks) {
                    if (cancelled) return;
                    if (ch.wait) await new Promise((r) => _origSetTimeout(r, ch.wait));
                    if (cancelled) return;
                    pendingRead = false;
                    try { controller.enqueue(enc.encode(ch.text)); } catch { return; }
                }
                if (!cancelled && !hold) { finished = true; try { controller.close(); } catch { /* ignore */ } }
            })();
        },
        pull() { pendingRead = true; },
        cancel() { cancelled = true; },
    });
    return {
        ok: true,
        status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/x-ndjson" : null) },
        body: { getReader: () => realBody.getReader() },
        json: async () => ({}),
        text: async () => "",
    };
}

globalThis.fetch = async (url, init) => {
    const u = String(url);
    httpCalls.push({ url: u, method: (init && init.method) || "GET" });
    if (u.includes("/api/keywords/llm-process/stream")) {
        const plan = streamPlans.shift();
        assert.ok(plan, "un plan de flux NDJSON doit être armé avant l'appel");
        return streamResponse(plan.chunks, init && init.signal, plan.hold === true);
    }
    if (u.includes("/api/keywords/llm-process")) return jsonResponse({ output: "json-non-stream" });
    if (u.includes("/api/blobby/memory")) return jsonResponse({ results: [] });
    if (u.includes("/api/presets")) return jsonResponse([]);
    if (u.includes("/api/settings")) return jsonResponse({});
    return jsonResponse({});
};

// ── Faux app ComfyUI ────────────────────────────────────────────────────
function freshApp() {
    const app = { graph: { nodes: [], setDirtyCanvas() {}, getNodeById() { return null; } }, canvas: { setDirtyCanvas() {}, centerOnNode() {} } };
    app.registerExtension = function (ext) { app.extensions.push(ext); };
    app.extensions = [];
    return app;
}
globalThis.window.app = freshApp();

await import("./aih_i18n.js");
await import("./blobby_companion.js");
const Blobby = domWindow.Blobby;
assert.ok(Blobby && typeof Blobby._handleChatMessage === "function", "Blobby exposé (window.Blobby)");
const BlobbyTools = domWindow.BlobbyTools;

// Modale factice fidèle à la v2 (header + titre + headerRight + body).
function mockOpenModal(opts) {
    const modal = document.createElement("div");
    modal.className = "aih-dialog-root " + (opts.className || "");
    const header = document.createElement("div");
    header.className = "aih-dialog-header";
    const title = document.createElement("span");
    title.className = "aih-dialog-title";
    header.appendChild(title);
    const headerRight = document.createElement("div");
    headerRight.className = "aih-dialog-header-right";
    header.appendChild(headerRight);
    const body = document.createElement("div");
    body.className = "aih-dialog-body";
    if (opts.content) body.appendChild(opts.content);
    modal.appendChild(header);
    modal.appendChild(body);
    document.body.appendChild(modal);
    return { modal, el: modal, body, header, headerRight, close() { modal.remove(); } };
}
domWindow.aihOpenModalV2 = mockOpenModal;

const tick = (ms = 20) => new Promise((r) => _origSetTimeout(r, ms));
const withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise((_, rej) => _origSetTimeout(() => rej(new Error(`test timeout (${label})`)), ms)),
]);
const doneEvent = (output, maxContext, source) => ndjson({ status: "done", output, usage: {}, max_context: maxContext, context_source: source });

// ── Ouvre UNE fois la vraie modale de chat (DOM réel) ────────────────────
document.querySelectorAll(".aih-dialog-root").forEach((e) => e.remove());
Blobby._openChatModal();
await tick(30);
const modalRoot = document.querySelector(".blobby-chat-modal");
const msgs = document.getElementById("blobby-chat-msgs");
const ctx = document.getElementById("blobby-chat-ctx");
const act = document.getElementById("blobby-chat-activity");
const label = act && act.querySelector(".blobby-activity-label");
assert.ok(modalRoot && msgs && ctx && act && label, "modale + zone messages + compteur + barre d'activité présents");

const tokNum = () => { const m = ctx.textContent.match(/~(\d[\d\s]*) tokens/); return m ? parseInt(m[1].replace(/\s/g, ""), 10) : NaN; };

/* ══════════ (A) Localisation DOM : compteur DANS la ligne d'activité ═══ */
console.log("(A) Le compteur est un enfant de la ligne d'activité, plus des messages");
{
    assert.strictEqual(ctx.parentElement, act, "le compteur est un ENFANT DIRECT de #blobby-chat-activity");
    assert.ok(act.contains(ctx), "la barre d'activité contient le compteur");
    assert.ok(!msgs.contains(ctx), "le compteur N'EST PLUS dans le conteneur des messages");
    // Aucun positionnement absolu : ni sur la zone de messages, ni sur le compteur.
    assert.ok(!/absolute|fixed/.test(ctx.style.position || ""), "compteur non positionné en absolu/fixed");
    assert.ok(!/absolute|fixed/.test(msgs.style.position || ""), "zone de messages non positionnée en absolu/fixed");
    // Le compteur est poussé à DROITE (face au libellé à gauche).
    assert.strictEqual(ctx.style.marginLeft, "auto", "compteur aligné à droite (margin-left:auto)");
}
ok("(A) compteur enfant de la barre d'activité (hors zone de messages)");

/* ══════════ (B) AU REPOS : barre affichée + compteur lisible ═══════════ */
console.log("(B) Au repos : barre toujours affichée, compteur lisible à droite");
{
    assert.ok(act.style.display !== "none", "la barre d'activité n'est jamais display:none au repos");
    assert.strictEqual(getComputedStyle(act).display, "flex", "la barre d'activité est affichée au repos (CSS display:flex)");
    assert.ok(!act.classList.contains("on"), "au repos : pas de classe .on (points + libellé masqués)");
    assert.strictEqual(label.textContent, "", "au repos : libellé d'activité vide (gauche vide)");
    assert.ok(/tokens/.test(ctx.textContent), `au repos : compteur lisible (${ctx.textContent})`);
    assert.ok(act.contains(ctx), "au repos : le compteur est toujours dans la barre");
}
ok("(B) compteur visible au repos (barre conservée)");

/* ══════════ (C)(D) PENDANT UN TOUR + mise à jour exacte de la valeur ══ */
console.log("(C)(D) Pendant un tour : libellé à gauche + compteur à droite, valeur mise à jour");
{
    domWindow.AIH_BLOBBY_IDLE_TIMEOUT_MS = 5000;
    const before = tokNum();
    streamPlans.push({ chunks: [
        { text: ndjson({ status: "start" }) },
        { text: ndjson({ status: "delta", text: "Bon" }), wait: 200 },
        { text: doneEvent("Bonjour !", 8192, "manual") },
    ] });
    const p = withTimeout(Blobby._handleChatMessage(msgs, "salut"), 8000, "C");
    await tick(40);
    assert.ok(act.classList.contains("on"), "pendant un tour : classe .on présente");
    assert.ok(label.textContent.length > 0, `pendant un tour : libellé d'activité affiché (${label.textContent})`);
    assert.strictEqual(ctx.parentElement, act, "pendant un tour : le compteur reste sur la MÊME ligne");
    assert.ok(/tokens/.test(ctx.textContent), "pendant un tour : le compteur reste visible (jamais masqué)");
    await p;

    // Après le tour : la barre reste affichée, compteur toujours lisible.
    assert.ok(!act.classList.contains("on"), "après le tour : classe .on retirée (indicateur nettoyé)");
    assert.strictEqual(act.style.display, "flex", "après le tour : la barre reste affichée (compteur lisible)");
    assert.ok(act.contains(ctx) && /tokens/.test(ctx.textContent), "après le tour : compteur toujours visible");

    // (D) Le max RÉEL renvoyé par le flux est appliqué (exactitude).
    assert.strictEqual(ctx.dataset.maxCtx, "8192", "dataset.maxCtx = valeur réelle du flux");
    assert.strictEqual(ctx.dataset.ctxSource, "manual", "dataset.ctxSource = source réelle");
    assert.ok(ctx.textContent.includes("8 192"), `le compteur affiche le max réel formaté (${ctx.textContent})`);

    // Rafraîchissement : l'estimation augmente à l'ajout d'un message.
    const t0 = tokNum();
    Blobby._addChatMessage(msgs, "user", "x".repeat(4000));
    const t1 = tokNum();
    assert.ok(Number.isFinite(t0) && Number.isFinite(t1), "compteur numérique lisible avant/après");
    assert.ok(t1 - t0 >= 900 && t1 - t0 <= 1100, `le compteur se rafraîchit (+${t1 - t0} tokens ≈ 4000/4) — était ${t0}`);
    assert.ok(t1 > before, "le compteur a globalement augmenté avec le fil");
}
ok("(C)(D) cohabitation sur la même ligne + valeur exacte rafraîchie");

/* ══════════ (E) NON-RÉGRESSION : bouton ⏹ Stop + indicateur ═══════════ */
console.log("(E) Non-régression : bouton ⏹ Stop / indicateur, compteur toujours là");
{
    const btn = document.querySelector(".blobby-chat-send");
    assert.ok(btn, "bouton d'envoi présent");
    assert.ok(btn.textContent.includes("➤"), "au repos : bouton ➤");
    domWindow.AIH_BLOBBY_IDLE_TIMEOUT_MS = 5000;
    streamPlans.push({ hold: true, chunks: [{ text: ndjson({ status: "start" }) }] });
    const p = withTimeout(Blobby._handleChatMessage(msgs, "coucou"), 8000, "E");
    await tick(40);
    assert.ok(btn.textContent.includes("Stop"), `pendant le tour : bouton ⏹ Stop (${btn.textContent})`);
    assert.ok(btn.classList.contains("blobby-chat-stop"), "classe stop présente");
    assert.ok(act.classList.contains("on"), "pendant le tour : indicateur .on");
    assert.ok(act.contains(ctx) && /tokens/.test(ctx.textContent), "pendant le tour : compteur présent + lisible");
    btn.onclick({ stopPropagation() {} }); // clic = abandon
    await p;
    assert.ok(btn.textContent.includes("➤"), "après abandon : bouton revenu à ➤");
    assert.ok(!act.classList.contains("on"), "après abandon : indicateur nettoyé");
    assert.strictEqual(act.style.display, "flex", "après abandon : barre toujours affichée");
    assert.ok(act.contains(ctx) && /tokens/.test(ctx.textContent), "après abandon : compteur toujours visible");
    assert.ok(!Blobby._turnActive(), "aucun tour résiduel après abandon");
}
ok("(E) Stop/indicateur non régressés, compteur toujours visible");

/* ══════════ (F) Invariants STATIQUES (source unique de vérité) ═════════ */
console.log("(F) Invariants statiques de la source");
{
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, "blobby_companion.js"), "utf8");
    assert.ok(src.includes("activityBar.appendChild(ctxBar)"), "le compteur est ajouté à la barre d'activité");
    assert.ok(!src.includes("bodyWrapper.appendChild(ctxBar)"), "le compteur n'est PLUS ajouté au corps (à côté des messages)");
    // La barre reste TOUJOURS affichée (display:flex, jamais display:none).
    assert.ok(/\.blobby-chat-activity \{',\s*'  display: flex;/.test(src), "CSS : .blobby-chat-activity { display: flex }");
    assert.ok(!/\.blobby-chat-activity \{',\s*'  display: none;/.test(src), "CSS : la barre n'est plus masquée par display:none");
    assert.ok(/\.blobby-chat-activity\.on \.blobby-activity-dots/.test(src), "CSS : points visibles seulement en tour (.on)");
    assert.ok(/\.blobby-chat-activity\.on \.blobby-activity-label/.test(src), "CSS : libellé visible seulement en tour (.on)");
    // _blobbySetActivity ne masque plus la barre (le compteur doit rester lisible).
    const fn = (src.match(/function _blobbySetActivity\(container, text\)[\s\S]*?\n\}/) || [""])[0];
    assert.ok(fn.length > 0, "fonction _blobbySetActivity localisée");
    assert.ok(!fn.includes("el.style.display = 'none'"), "_blobbySetActivity ne masque plus la barre (display:none banni)");
    assert.ok(fn.includes("el.style.display = 'flex'"), "_blobbySetActivity garde la barre affichée (display:flex)");
}
ok("(F) invariants statiques respectés");

/* ══════════ (G) i18n : aucune nouvelle clé (parité FR/EN) ══════════════ */
console.log("(G) i18n : bl.ctxBar FR/EN (aucune clé ajoutée)");
{
    const here = path.dirname(fileURLToPath(import.meta.url));
    const stringsSrc = fs.readFileSync(path.join(here, "aih_strings.js"), "utf8");
    const re = /"bl\.ctxBar"\s*:/g;
    assert.strictEqual((stringsSrc.match(re) || []).length, 2, "bl.ctxBar définie exactement 2x (FR + EN)");
    assert.ok(/~\{tokens\} tokens \| \{max\} max/.test(stringsSrc), "gabarit du compteur inchangé");
}
ok("(G) parité FR/EN du compteur (aucune clé nouvelle)");

globalThis.setTimeout = _origSetTimeout;
console.log(`\n✅ Chat Blobby — compteur de tokens sur la ligne d'activité : ${n} groupes d'assertions PASSENT`);
