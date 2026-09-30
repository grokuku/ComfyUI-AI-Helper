// ─────────────────────────────────────────────────────────────────────────
// Helper de VISIBILITÉ RÉELLE pour les tests jsdom.
//
// Pourquoi : les tests historiques assertaient l'EXISTENCE (`assert.ok(el)`) et
// parfois `el.style.display !== 'none'` — insuffisant. Un élément peut exister
// dans le DOM tout en étant invisible (display:none / visibility:hidden /
// opacity:0 sur lui-même OU sur un ancêtre, ou détaché du document). C'est ce
// défaut de test qui a laissé passer le bug « fenêtre/bouton annoncés livrés
// mais invisibles ».
//
// jsdom n'implémente PAS la mise en page : `offsetParent` est toujours null et
// `getBoundingClientRect()` renvoie 0. On ne peut donc pas tester la géométrie.
// En revanche jsdom calcule correctement la CASCADE CSS (règles <style> +
// styles inline) : `getComputedStyle(el).display/visibility/opacity` sont
// fiables. On combine :
//   1. présence effective dans le document (`document.contains`) ;
//   2. cascade héritée : aucun ancêtre (ni l'élément) en display:none /
//      visibility:hidden / opacity:0 ;
//   3. ordre d'empilement si demandé (z-index inline de l'autorité de fenêtres).
//
// Un contrôle négatif (mutations) doit faire ÉCHOUER ces assertions.
// ─────────────────────────────────────────────────────────────────────────

/** Chaîne lisible : la raison d'invisibilité, ou null si visible. */
export function visibilityProblem(el, opts = {}) {
    const win = opts.window || globalThis.window;
    if (!el) return "élément absent (null)";
    const doc = (win && win.document) || globalThis.document;
    if (doc && !doc.contains(el)) return "élément détaché du document";
    const getCS = (win && win.getComputedStyle)
        ? win.getComputedStyle.bind(win)
        : globalThis.getComputedStyle;
    let node = el;
    while (node && node.nodeType === 1) {
        const cs = getCS(node);
        if (cs.display === "none") return "display:none sur <" + node.tagName.toLowerCase() +
            (node.className ? "." + String(node.className).trim().split(/\s+/).join(".") : "") + ">";
        if (cs.visibility === "hidden" || cs.visibility === "collapse") {
            return "visibility:" + cs.visibility + " sur <" + node.tagName.toLowerCase() + ">";
        }
        if (cs.opacity === "0") return "opacity:0 sur <" + node.tagName.toLowerCase() + ">";
        node = node.parentNode;
    }
    return null;
}

/** Assertion : l'élément est réellement visible (lève une Error sinon). */
export function assertVisible(assert, el, label, opts = {}) {
    const problem = visibilityProblem(el, opts);
    assert.ok(problem === null, (label || "élément") + " doit être VISIBLE — " + problem);
}

/** z-index effectif (inline prioritaire, sinon calculé). */
export function effectiveZ(el, win) {
    if (!el) return NaN;
    const inline = parseInt(el.style && el.style.zIndex, 10);
    if (!isNaN(inline)) return inline;
    const w = win || globalThis.window;
    const getCS = (w && w.getComputedStyle) ? w.getComputedStyle.bind(w) : globalThis.getComputedStyle;
    return parseInt(getCS(el).zIndex, 10);
}

/** Assertion : `top` est empilé AU-DESSUS de `bottom` (z-index supérieur). */
export function assertStackedAbove(assert, top, bottom, label, win) {
    const zt = effectiveZ(top, win);
    const zb = effectiveZ(bottom, win);
    assert.ok(!isNaN(zt) && !isNaN(zb) && zt > zb,
        (label || "fenêtre") + " doit être AU-DESSUS (z=" + zt + " > " + zb + ")");
}
