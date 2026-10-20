// ─────────────────────────────────────────────────────────────────────────
// Elements Picker — ORDRE DES CONTRÔLES dans chaque ligne du widget.
//
// Contrat verrouillé (js/aih_elements_widget.js `renderList()`) :
//
//   ⠿ poignée → 👁 on/off → 🧠 LLM → 🔗🎲🔒 graine (→ champ de valeur en
//   mode fixe) → 📝🔽 type → contenu de la ligne (champ texte / nom du filtre)
//
// Le type reste JUSTE AVANT le contenu (il identifie la ligne) et la poignée
// reste le PREMIER enfant (elle porte le `pointerdown` du drag).
//
// Ce qui est vérifié ici :
//   1. ordre explicite, par CLASSE (jamais par glyphe), sur un cas TEXTE, un
//      cas FILTRE et un cas GRAINE FIXE (le champ numérique doit apparaître
//      APRÈS le cerveau et AVANT le type) ;
//   2. structure : un seul contrôle de chaque rôle, appendé directement dans la
//      ligne ; le champ de valeur est bien DANS le contrôle de graine ;
//   3. la position n'a pas changé la mise en page : la seule marge directionnelle
//      (`marginRight` de la poignée) reste portée par la poignée, qui reste en
//      tête → même hauteur de ligne, aucun débordement supplémentaire ;
//   4. AUCUN comportement modifié : drag (`pointerdown` → placeholders),
//      bascule œil (`onclick`), bascule cerveau (`onclick` + filtre grayscale),
//      cycle de graine (`onclick` → mode suivant) et saisie de la valeur fixe
//      (validation, bordure d'erreur, pas de re-rendu) ;
//   5. CONTRÔLES NÉGATIFS PAR MUTATION : ancien ordre, contrôle dupliqué,
//      contrôle manquant, champ de graine inséré avant le cerveau → tous ROUGES.
//
// Usage : node js/test_aih_elements_row_order.mjs
// Code de sortie : 0 = PASS, 2 = SKIP (jsdom absent), 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HERE, "..");
const WIDGET = "js/aih_elements_widget.js";
const read = (rel) => readFileSync(join(PACKAGE_DIR, rel), "utf8");

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

const JSDOM = await loadJsdomOrSkip("test_aih_elements_row_order");
const dom = new JSDOM(`<!doctype html><html><head></head><body></body></html>`, {
    pretendToBeVisual: true,
    url: "http://localhost/",
});
const { window } = dom;

/* ══ 0. Boot « comme ComfyUI » sous jsdom ══════════════════════════════ */
const GLOBALS = [
    "window", "document", "HTMLElement", "Element", "Node", "localStorage",
    "getComputedStyle", "Event", "MouseEvent", "CustomEvent", "MutationObserver",
    "requestAnimationFrame", "cancelAnimationFrame", "KeyboardEvent", "DOMParser",
];
for (const key of GLOBALS) {
    if (window[key] !== undefined) globalThis[key] = window[key];
}
globalThis.window = window;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.ResizeObserver = globalThis.ResizeObserver;
window.HTMLCanvasElement.prototype.getContext = () => null;
const noFetch = () => Promise.reject(new Error("réseau interdit en test"));
globalThis.fetch = noFetch;
window.fetch = noFetch;

const registered = [];
const fakeApp = {
    graph: { _nodes: [], extra: {}, getNodeById() { return null; } },
    canvas: { ds: { offset: [0, 0], scale: 1 } },
    registerExtension(ext) { registered.push(ext); },
    extensions: [],
};
window.app = fakeApp;
window.comfyAPI = {
    app: { app: fakeApp },
    api: {
        api: {
            api_base: "",
            apiURL: (p) => p,
            addEventListener() {},
            fetchApi: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
        },
    },
};

localStorage.setItem("aih_locale", "fr");
await import("./aih_i18n.js");
window.AIH.I18n.setLocale("fr");
globalThis.AIH = window.AIH;
await import("./aih_dialog.js");
await import("./aih_strings.js");
const I18n = window.AIH.I18n;

const clearBody = () => { window.document.body.innerHTML = ""; };

/** Monte le widget du vrai module (ou d'un MUTANT) et restaure des éléments. */
async function boot(moduleUrl, elements) {
    clearBody();
    await import(moduleUrl);
    const ext = registered.filter((e) => e && e.name === "AIH.Elements").pop();
    assert.ok(ext, "extension AIH.Elements enregistrée");
    const NodeType = function () {};
    await ext.beforeRegisterNodeDef(NodeType, { name: "AIHElementsPicker" });
    const node = {
        id: 1,
        type: "AIHElementsPicker",
        size: [420, 400],
        widgets: [{ name: "_elements_json", value: "" }],
        findInputSlot() { return -1; },
        removeInput() {},
        setSize() {},
        onResize: null,
        _aihElements: [],
        addDOMWidget(name, type, el) { this._el = el; window.document.body.appendChild(el); return {}; },
    };
    NodeType.prototype.onNodeCreated.call(node);
    node.widgets[0].value = JSON.stringify({ elements });
    assert.strictEqual(node._aihRestore(), true, "restauration du workflow effectuée");
    const rows = () => [...node._el.querySelectorAll(".aih-element-row")];
    assert.ok(rows().length > 0, "au moins une ligne rendue");
    return { node, rows };
}

/* ══ 1. Contrat d'ordre (identifié par CLASSE, jamais par glyphe) ═══════ */
// Rôles exposés par renderList() : repères stables `.aih-el-*` (plus le
// `.aih-seed-ctl` / `.aih-seed-value` du module de graine, inchangé).
const ROLE_CLASS = {
    grip: "aih-el-grip",
    eye: "aih-el-eye",
    brain: "aih-el-brain",
    seed: "aih-seed-ctl",
    "seed-value": "aih-seed-value",
    type: "aih-el-type",
};
const CONTROL_SELECTOR = Object.values(ROLE_CLASS).map((c) => "." + c).join(", ");
const EXPECTED = {
    // Mode hérité / random : la graine est un simple bouton (pas de champ).
    plain: ["grip", "eye", "brain", "seed", "type"],
    // Mode fixe : le champ numérique apparaît APRÈS le cerveau, AVANT le type.
    fixed: ["grip", "eye", "brain", "seed", "seed-value", "type"],
};

function roleOf(el) {
    for (const [role, cls] of Object.entries(ROLE_CLASS)) {
        if (el.classList.contains(cls)) return role;
    }
    return "?";
}
/** Rôles des contrôles d'une ligne, dans l'ORDRE DU DOCUMENT. */
function rowControls(row) {
    return [...row.querySelectorAll(CONTROL_SELECTOR)].map(roleOf);
}

/**
 * Garde anti-régression de l'ordre. `kind` ∈ {plain, fixed}.
 * Lève si l'ordre, la cardinalité ou la structure d'imbrication dévie.
 */
function assertRowOrder(row, kind, ctx) {
    const controls = rowControls(row);
    assert.deepStrictEqual(controls, EXPECTED[kind],
        `${ctx} : ordre des contrôles ${JSON.stringify(controls)} ≠ ${JSON.stringify(EXPECTED[kind])}`);
    // Un SEUL contrôle de chaque rôle attendu (ni doublon, ni manquant).
    for (const role of new Set(EXPECTED[kind])) {
        const found = [...row.querySelectorAll("." + ROLE_CLASS[role])];
        assert.strictEqual(found.length, 1,
            `${ctx} : ${found.length} contrôle(s) « ${role} » (1 attendu)`);
        if (role === "seed-value") {
            assert.ok(found[0].parentElement.classList.contains(ROLE_CLASS.seed),
                `${ctx} : le champ de valeur doit rester DANS le contrôle de graine`);
        } else {
            assert.strictEqual(found[0].parentElement, row,
                `${ctx} : le contrôle « ${role} » doit être un enfant direct de la ligne`);
        }
    }
    // La poignée reste le PREMIER élément (drag) et le type le DERNIER contrôle.
    assert.ok(row.firstElementChild.classList.contains(ROLE_CLASS.grip),
        `${ctx} : la poignée de drag n'est plus le premier enfant de la ligne`);
    assert.strictEqual(controls[controls.length - 1], "type",
        `${ctx} : le type n'est plus le dernier contrôle (il identifie la ligne)`);
    return controls;
}

/** Contenu juste après le type : le champ texte ou le nom du filtre. */
function typeFollowedByField(row, ctx) {
    const typeEl = row.querySelector("." + ROLE_CLASS.type);
    const next = typeEl.nextElementSibling;
    assert.ok(next, `${ctx} : aucun contenu après le type`);
    assert.strictEqual(next.tagName, "INPUT", `${ctx} : le type doit précéder le champ texte`);
    assert.strictEqual(next.type, "text", `${ctx} : champ texte attendu après le type`);
    assert.strictEqual(next.placeholder, I18n.t("el.textPlaceholder"),
        `${ctx} : le champ qui suit le type n'est pas le champ de l'élément`);
}

/* ══ 2. Cas TEXTE : ⠿ → 👁 → 🧠 → 🔗 → 📝 → champ ═════════════════════ */
console.log("2. Ligne TEXTE : ⠿ → 👁 → 🧠 → 🔗🎲🔒 → 📝 → champ");
{
    const { node, rows } = await boot("./aih_elements_widget.js?case=text",
        [{ type: "raw", text: "aaa", visible: true }]);
    const row = rows()[0];
    assertRowOrder(row, "plain", "ligne texte");
    typeFollowedByField(row, "ligne texte");
    // Le type reste bien l'emoji sémantique de type (non migré) — il a seulement bougé.
    assert.strictEqual(row.querySelector("." + ROLE_CLASS.type).textContent, "📝",
        "type d'une ligne texte : 📝 conservé (emoji sémantique, déplacé uniquement)");
    assert.strictEqual(row.querySelector("." + ROLE_CLASS.brain).textContent, "🧠",
        "cerveau : 🧠 conservé (emoji sémantique, déplacé uniquement)");
    // Styles directionnels : la seule marge de la ligne appartient à la poignée,
    // qui reste en TÊTE → aucun espacement ne dépend de l'ancienne position.
    const grip = row.querySelector("." + ROLE_CLASS.grip);
    assert.strictEqual(grip.style.marginRight, "2px", "poignée : marge de séparation conservée (2 px)");
    assert.strictEqual(node._aihElements.length, 1, "modèle inchangé");
    ok("ligne texte : ordre [grip, eye, brain, seed, type], type juste avant le champ, 1 seul de chaque");
}

/* ══ 3. Cas FILTRE : même ordre, type 🔽 avant le nom ══════════════════ */
console.log("3. Ligne FILTRE : même ordre, 🔽 juste avant le nom");
{
    const { rows } = await boot("./aih_elements_widget.js?case=filter",
        [{ type: "filter", id: "f1", name: "mon_filtre", author: "?", is_public: false, visible: true }]);
    const row = rows()[0];
    assertRowOrder(row, "plain", "ligne filtre");
    const typeEl = row.querySelector("." + ROLE_CLASS.type);
    assert.strictEqual(typeEl.textContent, "🔽",
        "type d'une ligne filtre : 🔽 conservé (emoji sémantique, déplacé uniquement)");
    const next = typeEl.nextElementSibling;
    assert.ok(next && next.tagName === "SPAN", "ligne filtre : le nom suit immédiatement le type");
    assert.strictEqual(next.textContent, "mon_filtre", "ligne filtre : nom du filtre juste après le type");
    ok("ligne filtre : ordre identique, 🔽 immédiatement suivi du nom du filtre");
}

/* ══ 4. Cas GRAINE FIXE : le champ numérique après 🧠 et avant le type ══ */
console.log("4. Ligne GRAINE FIXE : champ numérique après 🧠, avant le type");
{
    const { node, rows } = await boot("./aih_elements_widget.js?case=fixed",
        [{ type: "raw", text: "bbb", visible: true, seed_mode: "fixed", seed_value: 7 }]);
    const row = rows()[0];
    const controls = assertRowOrder(row, "fixed", "ligne graine fixe");
    const pos = (role) => controls.indexOf(role);
    assert.ok(pos("seed-value") > pos("brain"),
        `champ de graine (${pos("seed-value")}) doit venir APRÈS le cerveau (${pos("brain")})`);
    assert.ok(pos("seed-value") < pos("type"),
        `champ de graine (${pos("seed-value")}) doit venir AVANT le type (${pos("type")})`);
    const value = row.querySelector("." + ROLE_CLASS["seed-value"]);
    assert.strictEqual(value.value, "7", "champ de graine prérempli avec la valeur de l'élément");
    assert.strictEqual(value.getAttribute("inputmode") || value.inputMode, "numeric",
        "champ de graine : saisie numérique (comportement inchangé)");
    assert.strictEqual(node._aihElements[0].seed_mode, "fixed", "mode fixe persisté");
    ok("graine fixe : 🔒 + champ numérique dans le contrôle de graine, après 🧠 et avant 📝");
}

/* ══ 5. Aucun comportement modifié (drag / œil / cerveau / graine) ══════ */
console.log("5. Comportements intacts (déplacement PUR)");
{
    // 5.a Poignée : pointerdown → startDrag, jamais de clic. Deux éléments :
    //     le drag exige une liste d'au moins 2 lignes (comportement d'origine).
    const dragCase = await boot("./aih_elements_widget.js?case=drag",
        [{ type: "raw", text: "aaa", visible: true }, { type: "raw", text: "bbb", visible: true }]);
    const dragRow = dragCase.rows()[0];
    const grip = dragRow.querySelector("." + ROLE_CLASS.grip);
    assert.strictEqual(typeof grip.onpointerdown, "function", "poignée : pointerdown branché");
    assert.strictEqual(grip.onclick, null, "poignée : aucun onclick");
    assert.strictEqual(grip.style.cursor, "grab", "poignée : cursor:grab");
    assert.strictEqual(grip.style.userSelect, "none", "poignée : user-select:none");
    assert.strictEqual(grip.style.touchAction, "none", "poignée : touch-action:none");
    assert.strictEqual(grip.title, I18n.t("el.dragTitle"), "poignée : nom accessible conservé");
    const container = dragCase.node._el;
    const pd = typeof window.PointerEvent === "function"
        ? new window.PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 10, clientY: 10, pointerId: 1 })
        : Object.assign(new window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }), { pointerId: 1 });
    grip.dispatchEvent(pd);
    assert.ok(container.querySelector(".aih-drag-placeholder"),
        "poignée : le drag démarre toujours (placeholder inséré) malgré la nouvelle position");
    const ghost = [...window.document.body.children]
        .find((el) => el !== container && el.style && el.style.position === "fixed");
    assert.ok(ghost, "poignée : fantôme de drag créé dans le body");
    assert.ok(ghost.querySelector("." + ROLE_CLASS.grip), "poignée : le fantôme conserve sa poignée en tête");
    window.document.dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true, clientX: 10, clientY: 400 }));
    assert.ok(!container.querySelector(".aih-drag-placeholder"), "poignée : le pointerup termine le drag");
    ok("poignée : styles de drag + pointerdown → fantôme/placeholder/drop (drag opérationnel)");

    // 5.b Œil / cerveau / graine : une seule ligne, re-rendue à chaque bascule.
    const { node, rows } = await boot("./aih_elements_widget.js?case=behaviour",
        [{ type: "raw", text: "aaa", visible: true, brain: false }]);
    const row = () => rows()[0];
    const eye = () => row().querySelector("." + ROLE_CLASS.eye);
    const brain = () => row().querySelector("." + ROLE_CLASS.brain);
    const seedBtn = () => row().querySelector("." + ROLE_CLASS.seed + " button.aih-seed-mode");

    // Œil : onclick direct → item.visible, title recalculé, ordre préservé.
    const eye0 = eye();
    assert.strictEqual(typeof eye0.onclick, "function", "œil : onclick direct");
    assert.strictEqual(eye0.onpointerdown, null, "œil : aucun pointerdown (synthèse du clic)");
    assert.strictEqual(node._aihElements[0].visible, true, "œil : état initial visible");
    eye0.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(node._aihElements[0].visible, false, "œil : clic → entrée masquée");
    assertRowOrder(row(), "plain", "après bascule œil");
    assert.strictEqual(eye().title, I18n.t("el.eyeShow"), "œil : title recalculé après bascule");
    eye().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(node._aihElements[0].visible, true, "œil : second clic → de nouveau visible");
    ok("œil : bascule aller-retour + title recalculé, ordre inchangé après re-rendu");

    // 5.c Cerveau : onclick → item.brain + filtre grayscale (déplacé, pas modifié).
    const brain0 = brain();
    assert.strictEqual(typeof brain0.onclick, "function", "cerveau : onclick direct");
    assert.ok(/grayscale/.test(brain0.style.filter), `cerveau inactif : grayscale conservé (${brain0.style.filter})`);
    brain0.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(node._aihElements[0].brain, true, "cerveau : clic → item.brain = true");
    assertRowOrder(row(), "plain", "après bascule cerveau");
    assert.strictEqual(brain().style.filter, "none", "cerveau actif : plus de grayscale");
    assert.strictEqual(brain().title, I18n.t("el.brainOn"), "cerveau : title recalculé");
    brain().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(node._aihElements[0].brain, false, "cerveau : second clic → désactivé");
    ok("cerveau : bascule + grayscale/title recalculés, ordre inchangé après re-rendu");

    // 5.d Graine : cycle de mode + saisie de la valeur fixe (après le cerveau).
    assert.strictEqual(seedBtn().dataset.seedMode, "node", "graine : mode hérité initial");
    seedBtn().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(node._aihElements[0].seed_mode, "random", "graine : clic → random");
    assert.strictEqual(seedBtn().dataset.seedMode, "random", "graine : bouton re-rendu en random");
    assertRowOrder(row(), "plain", "après cycle vers random");
    seedBtn().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(node._aihElements[0].seed_mode, "fixed", "graine : clic → fixe");
    assertRowOrder(row(), "fixed", "après cycle vers fixe");
    assert.ok(Number(node._aihElements[0].seed_value) > 0,
        "graine : valeur par défaut proposée en mode fixe (jamais 0/néant)");

    const value = () => row().querySelector("." + ROLE_CLASS["seed-value"]);
    assert.ok(value(), "graine fixe : champ de valeur révélé dans la ligne");
    const before = value();
    const otherSeed = node._aihElements[0].seed_value;
    before.value = String(otherSeed);
    before.dispatchEvent(new window.Event("input"));
    assert.strictEqual(Number(node._aihElements[0].seed_value), Number(otherSeed),
        "saisie valide : valeur persistée");
    assert.strictEqual(value(), before, "saisie valide : AUCUN re-rendu de la ligne (focus conservé)");
    assertRowOrder(row(), "fixed", "après saisie valide");

    before.value = "abc";
    before.dispatchEvent(new window.Event("input"));
    assert.strictEqual(Number(node._aihElements[0].seed_value), Number(otherSeed),
        "saisie invalide : aucune valeur parasite persistée");
    assert.strictEqual(before.getAttribute("aria-invalid"), "true", "saisie invalide : champ signalé");
    assert.ok(/248,\s*113,\s*113|f87171/i.test(before.style.borderColor),
        `saisie invalide : bordure rouge (${before.style.borderColor})`);
    before.dispatchEvent(new window.Event("change"));
    assert.strictEqual(before.value, String(otherSeed), "saisie invalide : valeur canonique restaurée");
    assert.strictEqual(before.getAttribute("aria-invalid"), null, "saisie invalide : erreur effacée");

    seedBtn().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(node._aihElements[0].seed_mode, "node", "graine : fixe → hérité");
    assert.strictEqual(value(), null, "graine héritée : champ de valeur retiré (ligne non élargie)");
    assertRowOrder(row(), "plain", "après retour au mode hérité");
    ok("graine : cycle 3 modes + validation de la valeur fixe + ordre inchangé à chaque re-rendu");
}

/* ══ 6. Contrôles négatifs PAR MUTATION ════════════════════════════════ */
console.log("6. contrôles négatifs par mutation (ordre, doublon, manquant, champ avant 🧠)");
{
    // Nettoyage d'un éventuel résidu d'une exécution interrompue.
    for (const f of readdirSync(HERE)) {
        if (/^\.__mut5_\d+_elements_widget\.mjs$/.test(f)) rmSync(join(HERE, f), { force: true });
    }

    let seq = 0;
    /** Écrit un mutant de js/aih_elements_widget.js dans js/, exécute `check`, puis nettoie. */
    async function mutant(label, mutate, check) {
        const src = read(WIDGET);
        const mutated = mutate(src);
        assert.notStrictEqual(mutated, src, `mutation « ${label} » sans effet (ancre introuvable)`);
        const file = join(HERE, `.__mut5_${++seq}_elements_widget.mjs`);
        writeFileSync(file, mutated, "utf8");
        let failure = null;
        try {
            await check("file://" + file + "?m=" + seq);
        } catch (e) {
            failure = e;
        } finally {
            rmSync(file, { force: true });
            clearBody();
        }
        assert.ok(failure, `mutation « ${label} » NON détectée (le contrat d'ordre reste vert) → contrôle négatif vacant`);
        return failure.message;
    }

    const ORDER_BLOCK = [
        "                        row.appendChild(grip);",
        "                        row.appendChild(eyeBtn);",
        "                        row.appendChild(brainBtn);",
        "                        if (seedCtl) row.appendChild(seedCtl);",
    ].join("\n");

    // (a) Ordre revenu à l'ANCIENNE position (graine avant l'œil).
    const msgOld = await mutant("ancien ordre (graine avant l'œil)",
        (s) => s.replace(ORDER_BLOCK, [
            "                        row.appendChild(grip);",
            "                        if (seedCtl) row.appendChild(seedCtl);",
            "                        row.appendChild(eyeBtn);",
            "                        row.appendChild(brainBtn);",
        ].join("\n")),
        async (url) => {
            const { rows } = await boot(url, [{ type: "raw", text: "aaa", visible: true }]);
            assertRowOrder(rows()[0], "plain", "mutant ancien ordre");
        }
    );
    ok(`ancien ordre → ROUGE (${msgOld.split("\n")[0].slice(0, 70)})`);

    // (b) Contrôle DUPLIQUÉ (deux boutons œil dans la ligne). `cloneNode` :
    //     appender deux fois le MÊME nœud ne ferait que le déplacer.
    const msgDup = await mutant("œil dupliqué",
        (s) => s.replace(
            "                        row.appendChild(eyeBtn);\n                        row.appendChild(brainBtn);",
            "                        row.appendChild(eyeBtn);\n                        row.appendChild(eyeBtn.cloneNode(true));\n                        row.appendChild(brainBtn);"),
        async (url) => {
            const { rows } = await boot(url, [{ type: "raw", text: "aaa", visible: true }]);
            assertRowOrder(rows()[0], "plain", "mutant œil dupliqué");
        }
    );
    ok(`contrôle dupliqué → ROUGE (${msgDup.split("\n")[0].slice(0, 70)})`);

    // (c) Contrôle MANQUANT (le contrôle de graine n'est plus appendé).
    const msgMissing = await mutant("graine manquante",
        (s) => s.replace("                        if (seedCtl) row.appendChild(seedCtl);",
            "                        if (seedCtl) { /* contrôle perdu */ }"),
        async (url) => {
            const { rows } = await boot(url, [{ type: "raw", text: "aaa", visible: true }]);
            assertRowOrder(rows()[0], "plain", "mutant graine manquante");
        }
    );
    ok(`contrôle manquant → ROUGE (${msgMissing.split("\n")[0].slice(0, 70)})`);

    // (d) Champ de graine inséré AVANT le cerveau (ordre interne au contrôle cassé).
    const msgInput = await mutant("champ de graine avant le cerveau",
        (s) => s.replace(
            "                        row.appendChild(eyeBtn);\n                        row.appendChild(brainBtn);",
            "                        row.appendChild(eyeBtn);\n" +
            "                        if (seedCtl) { const _early = seedCtl.querySelector(\"input.aih-seed-value\"); if (_early) row.appendChild(_early); }\n" +
            "                        row.appendChild(brainBtn);"),
        async (url) => {
            const { rows } = await boot(url,
                [{ type: "raw", text: "bbb", visible: true, seed_mode: "fixed", seed_value: 7 }]);
            assertRowOrder(rows()[0], "fixed", "mutant champ de graine avant le cerveau");
        }
    );
    ok(`champ de graine avant 🧠 → ROUGE (${msgInput.split("\n")[0].slice(0, 70)})`);

    // Aucun mutant résiduel et source intacte après les mutations.
    const residuels = readdirSync(HERE).filter((f) => f.startsWith(".__mut5_"));
    assert.deepStrictEqual(residuels, [], "mutants résiduels : " + residuels.join(", "));
    assert.ok(/row\.appendChild\(grip\);\s*\n\s*row\.appendChild\(eyeBtn\);\s*\n\s*row\.appendChild\(brainBtn\);\s*\n\s*if \(seedCtl\) row\.appendChild\(seedCtl\);/m.test(read(WIDGET)),
        "source restaurée : l'ordre grip → eye → brain → seed est bien celui du dépôt");
    ok("source intacte après mutations, aucun mutant résiduel");
}

console.log(`\n✅ Elements Picker — ordre des contrôles : TOUS LES TESTS PASSENT (${n} groupes)`);
