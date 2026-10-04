/*
 * Copyright (C) 2026 Holaf
 * Nodes 2.0 (rendu Vue) — passerelle de compatibilité pour les UI du pack.
 *
 * POURQUOI CE MODULE (faits vérifiés dans la source de référence ComfyUI
 * 1.47.11, /projects/AI-Helper/comfyui-frontend-src) :
 *
 *  1. Quand le réglage « Modern Node Design (Nodes 2.0) » est actif, ComfyUI
 *     rend les nodes en Vue au lieu du canvas LiteGraph. Dans ce mode,
 *     LGraphCanvas.drawNode retourne tôt (LGraphCanvas.ts ~5656) : le corps du
 *     node, ses widgets ET le hook node-level `node.onDrawForeground` /
 *     `node.onDrawBackground` sont SAUTÉS.
 *  2. LGraphCanvas.processMouseMove met `node = null` en vueNodesMode
 *     (LGraphCanvas.ts ~3339) : `node.onMouseDown/onMouseMove/onMouseEnter/
 *     onMouseLeave` ne sont PLUS appelés.
 *  3. EN REVANCHE le hook au niveau CANVAS `canvas.onDrawForeground`
 *     (LGraphCanvas.ts ~5203) est appelé DANS LES DEUX renderers.
 *
 * Ce module expose donc :
 *   - isVueNodesMode() : booléen fiable pour brancher explicitement.
 *   - onCanvasDraw(cb) : enregistre un callback « entretien » exécuté au plus
 *     ~4 fois/s depuis canvas.onDrawForeground, STRICTEMENT UNIQUEMENT en
 *     vueNodesMode. En mode classique le callback n'est JAMAIS appelé : le
 *     comportement du renderer classique (mode de production) est identique à
 *     avant — c'est un no-op total.
 *
 * Il n'impose aucun nouveau rendu : c'est le mécanisme documenté par ComfyUI
 * (hook canvas-level survivant). Voir docs/NODES2_COMPAT.md pour la note de
 * migration destinée aux futurs nodes du pack.
 */
import { app } from "../../scripts/app.js";

/** @returns {boolean} vrai si le rendu Vue (Nodes 2.0) est actif. */
export function isVueNodesMode() {
    try {
        const LG = (typeof window !== "undefined" && window.LiteGraph)
            || (typeof LiteGraph !== "undefined" ? LiteGraph : null);
        return !!(LG && LG.vueNodesMode);
    } catch (_) {
        return false;
    }
}

/** Intervalle minimal entre deux passes d'entretien (ms) — ~4 Hz. */
const MIN_INTERVAL_MS = 250;

/** @type {Set<() => void>} */
const _subscribers = new Set();
let _installed = false;
let _lastRun = 0;

function _install() {
    if (_installed) return true;
    const canvas = app && app.canvas;
    if (!canvas) return false;

    const prev = canvas.onDrawForeground;
    canvas.onDrawForeground = function () {
        if (typeof prev === "function") prev.apply(this, arguments);
        // No-op STRICT en mode classique : rien ne change pour le canvas.
        if (!isVueNodesMode()) return;
        if (_subscribers.size === 0) return;
        const now = Date.now();
        if (now - _lastRun < MIN_INTERVAL_MS) return;
        _lastRun = now;
        for (const cb of _subscribers) {
            try { cb(); } catch (e) { console.warn("[Holaf] onCanvasDraw subscriber error:", e); }
        }
    };
    _installed = true;
    return true;
}

function _ensureInstalled() {
    if (_install()) return;
    // `app.canvas` peut ne pas être prêt au moment de la création des nodes.
    let tries = 0;
    const retry = () => {
        if (_install() || ++tries > 60) return;
        setTimeout(retry, 100);
    };
    setTimeout(retry, 100);
}

/**
 * Enregistre un callback d'entretien Vue (jamais appelé en mode classique).
 * @param {() => void} cb
 * @returns {() => void} fonction de désinscription (idempotente).
 */
export function onCanvasDraw(cb) {
    if (typeof cb !== "function") return () => {};
    _subscribers.add(cb);
    _ensureInstalled();
    let off = () => { _subscribers.delete(cb); };
    return off;
}

/**
 * Helper de visibilité double-renderer : le canvas honore `widget.hidden`
 * (LGraphNode.ts ~3995/4004) alors que le rendu Vue lit `options.hidden`
 * (isWidgetVisible ← mergedOptions). Poser LES DEUX rend un widget réellement
 * masqué dans les deux moteurs.
 * @param {object} widget
 * @param {boolean} [hidden]
 */
export function setWidgetHidden(widget, hidden = true) {
    if (!widget) return;
    widget.hidden = hidden;                 // renderer classique (canvas)
    widget.options = widget.options || {};
    widget.options.hidden = hidden;         // renderer Vue
}
