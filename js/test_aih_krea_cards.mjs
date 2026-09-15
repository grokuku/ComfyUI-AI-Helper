// ─────────────────────────────────────────────────────────────────────────
// Tests JS — habillage DOM des cartes AIH Krea (Guide Card / Slider Card).
//
// Usage : node js/test_aih_krea_cards.mjs
//         jsdom est résolu par le helper partagé js/test_helpers/jsdom_loader.mjs
//         (JSDOM_DIR → ./node_modules → ../holaf-lib/node_modules →
//          /projects/holaf-lib/node_modules) ; introuvable = SKIP bruyant (exit 2).
//
// Ce que le test verrouille :
//   1. Enregistrement de l'extension (beforeRegisterNodeDef) et installation des
//      hooks sur les deux types de node.
//   2. Masquage des widgets NATIFS SANS casser leur sérialisation
//      (hidden=true, serialize inchangé) + widget DOM exclu du workflow/prompt.
//   3. Structure DOM de la Guide Card (badge 1/12, sections, 10 lignes denses,
//      ligne grisée overall_style_reach avec note « inactif sur Krea 2 »).
//   4. Pilotage des widgets natifs (source de vérité) : DOM → natif.
//   5. Aller-retour save/load RÉEL : sérialisation (widgets_values + instantané
//      nommé) puis restauration, y compris avec des widgets_values CORROMPUS
//      (preuve que la restauration par NOM prévaut sur l'index).
//   6. Slider Card : ligne unique, badge 1/8, ⚙ qui déplie les pôles,
//      graduations pilotées par les pôles.
//   7. computePosition (badge dynamique).
// ─────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { loadJsdomOrSkip } from "./test_helpers/jsdom_loader.mjs";

const JSDOM = await loadJsdomOrSkip("test_aih_krea_cards");

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.Event = window.Event;
globalThis.HTMLElement = window.HTMLElement;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);

// Le module enregistre l'extension dès que window.app est disponible : on le
// fournit AVANT l'import pour éviter tout setTimeout résiduel dans le test.
let capturedExt = null;
window.app = {
    registerExtension(ext) {
        capturedExt = ext;
    },
};

await import("./aih_krea_cards.js");

const K = window.AIH && window.AIH.KreaCards;
assert.ok(K, "AIH.KreaCards est exposé");
assert.ok(capturedExt, "l'extension s'enregistre auprès de window.app");
assert.strictEqual(capturedExt.name, "AIH.KreaCards", "nom d'extension stable");

// ── Fabrique de nodes simulés ────────────────────────────────────────────
const GUIDE_DEFAULTS = {
    intention: "Équilibré",
    direction: "vers l'image",
    force: 0.2,
    preparation: "Image telle quelle",
    formes_copiees: 1.0,
    detail_conserve: 1.0,
    couleur_conservee: 1.0,
    structure: 1.0,
    finition: 1.0,
    phase_debut: 1.0,
    phase_fin: 1.0,
    etude: "Réglage de la pile",
    cadrage: "Réglage de la pile",
    overall_style_reach: 1.0,
};
const SLIDER_DEFAULTS = {
    attribut: "brightness",
    valeur: 0.0,
    pole_positif: "",
    pole_negatif: "",
};

function nativeWidgets(defaults) {
    return Object.keys(defaults).map((name) => ({
        name,
        value: defaults[name],
        type: typeof defaults[name] === "number" ? "FLOAT" : "STRING",
        hidden: false,
        options: {},
        callback: null,
    }));
}

function makeProto() {
    function Proto() {}
    return Proto;
}

function makeNode(proto, kind, graph) {
    const node = Object.create(proto.prototype);
    node.type = kind === "guide" ? "AIHGuideCard" : "AIHSliderCard";
    node.comfyClass = node.type;
    node.widgets = nativeWidgets(kind === "guide" ? GUIDE_DEFAULTS : SLIDER_DEFAULTS);
    node.inputs = [{ name: "image", link: null }];
    node.outputs = [{ name: kind, links: [] }];
    node.size = [210, 80];
    node.graph = graph || null;
    node.setSize = function (size) {
        this.size = size.slice();
    };
    node.computeSize = function () {
        return [this.size[0], this.size[1]];
    };
    node.findInputSlot = () => -1;
    node.addDOMWidget = function (name, type, element, options) {
        const w = {
            name,
            type,
            element,
            options: options || {},
            value: element,
            serialize: true,
            hidden: false,
            callback: null,
        };
        this.widgets.push(w);
        return w;
    };
    return node;
}

function qa(root, sel) {
    return Array.from(root.querySelectorAll(sel));
}
function rowByLabel(root, label) {
    return qa(root, ".aih-krc-row").find((r) => {
        const l = r.querySelector(".aih-krc-rowlabel");
        return l && l.textContent.trim() === label;
    });
}
function fire(el, type) {
    el.dispatchEvent(new window.Event(type));
}
function val(node, name) {
    const w = node.widgets.find((x) => x.name === name);
    return w ? w.value : undefined;
}

// Installe les hooks sur les deux types (comme le ferait ComfyUI).
const guideProto = makeProto();
const sliderProto = makeProto();
capturedExt.beforeRegisterNodeDef(guideProto, { name: "AIHGuideCard" });
capturedExt.beforeRegisterNodeDef(sliderProto, { name: "AIHSliderCard" });
assert.strictEqual(typeof guideProto.prototype.onNodeCreated, "function", "hook Guide installé");
assert.strictEqual(typeof sliderProto.prototype.onConfigure, "function", "hook Slider installé");

/* ══════════════════ 1. Guide Card — structure ══════════════════ */
const gNode = makeNode(guideProto, "guide");
gNode.onNodeCreated();
const gCard = gNode._aihKrc;
const gRoot = gCard.root;
assert.ok(gCard, "Guide Card construite");
assert.strictEqual(gRoot.className.includes("aih-krc-guide"), true, "classe guide");

// Badge 1/12 (une seule carte dans le graphe → position 1).
assert.strictEqual(gRoot.querySelector(".aih-krc-badge").textContent, "1/12", "badge guide 1/12");

// Sections.
const sections = qa(gRoot, ".aih-krc-section").map((s) => s.textContent.trim());
assert.ok(sections.includes("Intention"), "section INTENTION");
assert.ok(sections.some((s) => s.startsWith("Réglages manuels")), "section RÉGLAGES MANUELS");

// 10 lignes denses.
assert.strictEqual(qa(gRoot, ".aih-krc-rowlabel-text").length, 10, "10 lignes denses");

// Direction : segmented control 2 états.
assert.strictEqual(qa(gRoot, ".aih-krc-seg button").length, 2, "segmented control 2 états");

// overall_style_reach grisé + note, widget natif conservé.
const reachRow = qa(gRoot, ".aih-krc-row.is-disabled")[0];
assert.ok(reachRow, "ligne overall_style_reach grisée");
assert.strictEqual(reachRow.querySelector(".aih-krc-note").textContent, "inactif sur Krea 2", "note reach");
const reachNative = gNode.widgets.find((w) => w.name === "overall_style_reach");
assert.ok(reachNative && reachNative.serialize !== false, "widget reach toujours sérialisable");

// Widgets natifs masqués (hidden) SANS serialize=false.
for (const name of K.GUIDE_ORDER) {
    const w = gNode.widgets.find((x) => x.name === name);
    assert.strictEqual(w.hidden, true, "natif masqué: " + name);
    assert.notStrictEqual(w.serialize, false, "natif serialisable: " + name);
    assert.notStrictEqual(w.options.serialize, false, "natif présent au prompt: " + name);
}
assert.strictEqual(gNode.widgets_start_y, 30, "widgets_start_y posé (anti-croissance)");

// Widget DOM : exclu du workflow ET du prompt.
assert.strictEqual(gNode._aihKrcDomWidget.serialize, false, "DOM widget hors workflow");
assert.strictEqual(gNode._aihKrcDomWidget.options.serialize, false, "DOM widget hors prompt");

/* ══════════════════ 2. Guide Card — DOM pilote le natif ══════════════════ */
const intentionSel = gRoot.querySelector(".aih-krc-select-full");
intentionSel.value = "Copier le style";
fire(intentionSel, "change");
assert.strictEqual(val(gNode, "intention"), "Copier le style", "intention → natif");

const segButtons = qa(gRoot, ".aih-krc-seg button");
segButtons[1].dispatchEvent(new window.Event("click"));
assert.strictEqual(val(gNode, "direction"), "à l'opposé", "direction → natif");
assert.ok(segButtons[1].className.includes("active"), "bouton direction actif");

const forceRange = rowByLabel(gRoot, "Force").querySelector("input[type=range]");
forceRange.value = "1.5";
fire(forceRange, "input");
assert.strictEqual(val(gNode, "force"), 1.5, "force → natif");
assert.strictEqual(rowByLabel(gRoot, "Force").querySelector(".aih-krc-val").textContent, "1.50", "force affichée");

const formesRow = rowByLabel(gRoot, "Formes");
const formesRange = formesRow.querySelector("input[type=range]");
formesRange.value = "0.5";
fire(formesRange, "input");
assert.strictEqual(val(gNode, "formes_copiees"), 0.5, "formes_copiees → natif");
assert.ok(formesRow.className.includes("is-override"), "override signalé");
assert.ok(gRoot.querySelector(".aih-krc-modcount").textContent.includes("1 modif"), "compteur d'overrides");

// Intention → les réglages manuels NE sont PAS écrasés (pas d'auto-fill).
assert.strictEqual(val(gNode, "formes_copiees"), 0.5, "override manuel conservé après changement d'intention");

// Synchro inverse (natif → DOM) : un changement natif externe (callback,
// ex. autre extension / exécution) se reflète dans le DOM.
const detailW = gNode.widgets.find((w) => w.name === "detail_conserve");
detailW.value = 0.1;
detailW.callback(0.1);
assert.strictEqual(rowByLabel(gRoot, "Détail").querySelector(".aih-krc-val").textContent, "0.10", "natif → DOM (callback)");
assert.ok(rowByLabel(gRoot, "Détail").className.includes("is-override"), "override natif reflété");

/* ══════════════════ 3. Aller-retour save/load (sérialisation) ══════════════════ */
// Reproduit la sémantique de LGraphNode.serialize/configure (frontend Vue) :
//   - serialize() : tableau indexé par widget, les widgets serialize===false
//     laissent un trou (→ null au JSON).
//   - configure() : restaure par index, en sautant serialize===false.
function serializeNode(node) {
    const out = {};
    const arr = [];
    node.widgets.forEach((w, i) => {
        if (w.serialize === false) return;
        const v = w.value;
        arr[i] = v !== null && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v ?? null;
    });
    out.widgets_values = JSON.parse(JSON.stringify(arr)); // trous → null
    if (node.onSerialize) node.onSerialize(out);
    return out;
}
function configureNode(node, data) {
    if (Array.isArray(data.widgets_values)) {
        let i = 0;
        for (const w of node.widgets) {
            if (w.serialize === false) continue;
            if (i >= data.widgets_values.length) break;
            w.value = data.widgets_values[i++];
        }
    }
    if (node.onConfigure) node.onConfigure(data);
}

const data = serializeNode(gNode);
assert.ok(data.aih_krea_widgets, "instantané nommé écrit dans le workflow");
assert.strictEqual(data.aih_krea_widgets.intention, "Copier le style", "instantané nommé: intention");
assert.strictEqual(data.aih_krea_widgets.formes_copiees, 0.5, "instantané nommé: formes_copiees");
// Le widget DOM est en dernier et porte serialize=false : il n'étend pas la
// table (pas de null traînant). ComfyUI sérialise donc exactement les 14 natifs.
assert.strictEqual(data.widgets_values.length, K.GUIDE_ORDER.length, "table = 14 widgets natifs");

// A. Restauration nominale (widgets_values valides).
const gReload = makeNode(guideProto, "guide");
gReload.onNodeCreated();
configureNode(gReload, JSON.parse(JSON.stringify(data)));
assert.strictEqual(val(gReload, "intention"), "Copier le style", "load: intention");
assert.strictEqual(val(gReload, "direction"), "à l'opposé", "load: direction");
assert.strictEqual(val(gReload, "force"), 1.5, "load: force");
assert.strictEqual(val(gReload, "formes_copiees"), 0.5, "load: formes_copiees");
assert.strictEqual(val(gReload, "overall_style_reach"), 1.0, "load: reach (widget natif restauré)");
// Le DOM reflète les natifs restaurés.
assert.strictEqual(gReload._aihKrc.root.querySelector(".aih-krc-select-full").value, "Copier le style", "DOM resynchro après load");
assert.ok(gReload._aihKrc.root.querySelector(".aih-krc-seg button.active").textContent === "à l'opposé", "DOM direction resynchro");

// B. Preuve CONTENU > INDEX : on corrompt widgets_values (inversé). La
// restauration par NOM doit rétablir les bonnes valeurs malgré tout.
const corrupted = JSON.parse(JSON.stringify(data));
corrupted.widgets_values = corrupted.widgets_values.slice().reverse();
const gCorrupt = makeNode(guideProto, "guide");
gCorrupt.onNodeCreated();
configureNode(gCorrupt, corrupted);
assert.strictEqual(val(gCorrupt, "intention"), "Copier le style", "contenu > index: intention");
assert.strictEqual(val(gCorrupt, "formes_copiees"), 0.5, "contenu > index: formes_copiees");
assert.strictEqual(val(gCorrupt, "force"), 1.5, "contenu > index: force");

// C. Repli positionnel si l'instantané nommé est absent mais la table cohérente.
const positional = { widgets_values: data.widgets_values };
const gPos = makeNode(guideProto, "guide");
gPos.onNodeCreated();
configureNode(gPos, positional);
assert.strictEqual(val(gPos, "intention"), "Copier le style", "repli positionnel: intention");
assert.strictEqual(val(gPos, "force"), 1.5, "repli positionnel: force");

// D. Garde-fou : table trop courte (compaction) → repli refusé.
const gShort = makeNode(guideProto, "guide");
gShort.onNodeCreated();
assert.strictEqual(
    K._internal.applyPositional(gShort, K.GUIDE_ORDER, [1, 2, 3]),
    false,
    "repli positionnel refusé si table incohérente",
);

/* ══════════════════ 4. Slider Card ══════════════════ */
const sNode = makeNode(sliderProto, "slider");
sNode.onNodeCreated();
const sRoot = sNode._aihKrc.root;
assert.strictEqual(sRoot.querySelector(".aih-krc-badge").textContent, "1/8", "badge slider 1/8");
const slineChildren = sRoot.querySelector(".aih-krc-sline").children;
assert.strictEqual(slineChildren.length, 4, "ligne unique: attribut | cadran | valeur | ⚙");
assert.strictEqual(slineChildren[0].placeholder, "brightness", "input attribut");

// ⚙ déplie les pôles.
const poles = sRoot.querySelector(".aih-krc-poles");
const gear = sRoot.querySelector(".aih-krc-gear");
assert.strictEqual(poles.hidden, true, "pôles repliés par défaut");
gear.dispatchEvent(new window.Event("click"));
assert.strictEqual(poles.hidden, false, "⚙ déplie les pôles");
assert.ok(gear.className.includes("active"), "⚙ actif");
assert.ok(sRoot.querySelector(".aih-krc-hint").textContent.includes("déduit automatiquement"), "hint pôles");

// Cadran → natif + valeur affichée.
const sRange = sRoot.querySelector(".aih-krc-sliderrange");
sRange.value = "3";
fire(sRange, "input");
assert.strictEqual(val(sNode, "valeur"), 3, "valeur → natif");
assert.strictEqual(sRoot.querySelector(".aih-krc-sliderval").textContent, "+3.0", "affichage +3.0");

// Attribut.
const attrInput = sRoot.querySelector(".aih-krc-attr");
attrInput.value = "warmth";
fire(attrInput, "input");
assert.strictEqual(val(sNode, "attribut"), "warmth", "attribut → natif");

// Pôles → natif + graduations.
const poleNeg = sRoot.querySelector(".aih-krc-pole-neg");
const polePos = sRoot.querySelector(".aih-krc-pole-pos");
poleNeg.value = "cold blue";
fire(poleNeg, "input");
fire(poleNeg, "change");
polePos.value = "golden hour";
fire(polePos, "input");
fire(polePos, "change");
assert.strictEqual(val(sNode, "pole_negatif"), "cold blue", "pole_negatif → natif");
assert.strictEqual(val(sNode, "pole_positif"), "golden hour", "pole_positif → natif");
assert.strictEqual(sRoot.querySelector(".aih-krc-grad-neg").textContent, "cold blue", "graduation − = pôle négatif");
assert.strictEqual(sRoot.querySelector(".aih-krc-grad-pos").textContent, "golden hour", "graduation + = pôle positif");

// Aller-retour slider.
const sData = serializeNode(sNode);
const sReload = makeNode(sliderProto, "slider");
sReload.onNodeCreated();
configureNode(sReload, JSON.parse(JSON.stringify(sData)));
assert.strictEqual(val(sReload, "attribut"), "warmth", "slider load: attribut");
assert.strictEqual(val(sReload, "valeur"), 3, "slider load: valeur");
assert.strictEqual(val(sReload, "pole_negatif"), "cold blue", "slider load: pole_negatif");
assert.strictEqual(sReload._aihKrc.root.querySelector(".aih-krc-sliderval").textContent, "+3.0", "slider DOM resynchro");

/* ══════════════════ 5. computePosition ══════════════════ */
function graphOf(nodes) {
    return {
        _nodes: nodes,
        getNodeById(id) {
            return nodes.find((n) => n.id === id) || null;
        },
        getLink(id) {
            return this._links ? this._links[id] : null;
        },
    };
}
// Une seule carte → 1.
assert.strictEqual(K._internal.computePosition(gNode, "guide"), 1, "position par défaut 1");
// Deux cartes : la seconde → 2.
const n1 = { id: 1, type: "AIHGuideCard" };
const n2 = { id: 2, type: "AIHGuideCard" };
const g2 = graphOf([n1, n2]);
n2.inputs = [{ name: "image", link: null }];
n2.graph = g2;
assert.strictEqual(K._internal.computePosition(n2, "guide"), 2, "position = index dans la famille");
// Entrée connectée à une sortie multiple → index de sortie.
const upstream = { id: 10, type: "AIHGuideCard", outputs: [{}, {}] };
const n3 = { id: 3, type: "AIHGuideCard", inputs: [{ name: "image", link: 5 }] };
const g3 = graphOf([upstream, n3]);
g3._links = { 5: { origin_id: 10, origin_slot: 1 } };
n3.graph = g3;
assert.strictEqual(K._internal.computePosition(n3, "guide"), 2, "position = index de la sortie connectée");

console.log("✅ test_aih_krea_cards : tous les cas passent.");
