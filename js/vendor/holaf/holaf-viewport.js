/* ═══════════════════════════════════════════════════════════════════════════
 * Holaf UI — Brique HolafViewport · version 0.1.3
 * ─────────────────────────────────────────────────────────────────────────────
 * Géométrie + interactions de viewport image, SANS rendu. La brique calcule
 * le zoom / le pan / le fit et, en mode « content », applique le CSS transform
 * à un élément fourni (ex. une <img> object-fit:contain). En mode « headless »
 * (ex. canvas), elle ne fait que la géométrie : l'hôte dessine lui-même.
 *
 * Zéro dépendance runtime, zéro CSS injecté (brique sans style — l'hôte
 * fournit le conteneur et le contenu, la brique ne touche qu'au transform).
 *
 * Fichier DUAL : module ES (export) + global window.HolafViewport — se
 * charge via <script type="module"> ou `import { HolafViewport }`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MODÈLE MATHÉMATIQUE
 * ─────────────────────────────────────────────────────────────────────────────
 * Notations :
 *   cw, ch        taille du conteneur (getBoundingClientRect).
 *   iw, ih        taille NATURELLE de l'image (setImageSize / opts).
 *   s             zoom courant (échelle absolue).
 *   tx, ty        translation (pan) appliquée au contenu.
 *   originX/Y     content.offsetLeft/Top (mode content) sinon 0.
 *   containScale  min(contentW/iw, contentH/ih) — échelle « contain ».
 *   pixelScale    facteur image→écran dans la formule : containScale en mode
 *                 content, 1 en mode headless.
 *   dx, dy        offset de letterbox (à containScale) : (W − iw·containScale)/2
 *                 en mode content, 0 en headless.
 *
 * Point image (ix,iy) → écran LOCAL au conteneur :
 *   x = originX + tx + (dx + ix·pixelScale)·s        (idem y)
 *
 * Mode CONTENT (content fourni, ex. <img> object-fit:contain remplissant son
 * conteneur) : le letterbox est calculé à containScale (rendu intrinsèque de
 * l'élément), puis l'ensemble est mis à l'échelle par s. Le « fit » correspond
 * donc à s = 1 (object-fit:contain a déjà cadré l'image) → getFitScale() = 1.
 *
 * Mode HEADLESS (pas de content) : pas de letterbox, le centrage se fait par
 * tx/ty. Le « fit » correspond à s = containScale → getFitScale() = containScale.
 *
 * getImageRect() (rect À L'ÉCRAN du contenu image, coords locales conteneur) :
 *   x = originX + tx + dx·s ; width = iw·pixelScale·s   (idem y/height)
 *
 * Zoom-to-cursor (le point image sous le curseur RESTE fixe) :
 *   mx = clientX − containerRect.left
 *   tx' = (mx − originX) − (mx − originX − tx)·(s'/s)   (idem y)
 *   (en headless originX=0 → tx' = mx − (mx − tx)·(s'/s))
 *
 * Clamp du zoom : s' ∈ [minZoomEffectif, maxZoom], où minZoomEffectif =
 * getFitScale() si minZoom='fit' (défaut), sinon la valeur numérique.
 *
 * Clamp du pan (panClamp) : si le contenu ≤ la vue → centré ; sinon
 * tx ∈ [cw − w − originX − dx·s, −originX − dx·s] (le contenu ne quitte pas
 * la vue).
 *
 * Cohérence : screenToImage(imageToScreen(p)) === p (à rect.left=0 près).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRAT DES FOLLOWERS (addFollower/removeFollower)
 * ─────────────────────────────────────────────────────────────────────────────
 * Un follower reçoit EXACTEMENT le même transform inline que le content
 * (même string, même moment, même transition). Pour un tracking parfait à tout
 * zoom, la BOÎTE DE REPOS du follower doit être IDENTIQUE à celle du content :
 * même origine (offsetLeft/offsetTop) et même taille (offsetWidth/offsetHeight).
 * Le letterbox / l'offset (dx, dy, dispW, dispH) se gère À L'INTÉRIEUR du
 * follower (ex. un canvas enfant positionné à (dx, dy), taille dispW×dispH) —
 * jamais dans la position du follower lui-même. Sinon, à l'échelle s, le
 * letterbox (dans la boîte du content, donc multiplié par s au rendu) mais
 * positionné dans la position du follower (non scalé) dérive de dx×(1−s).
 * ═════════════════════════════════════════════════════════════════════════ */

const HolafViewport = (function () {
    "use strict";

    const VERSION = "0.1.3";

    const TRANSITION_REST = "transform .2s ease-out";

    function create(container, opts) {
        if (!container) {
            throw new Error("[HolafViewport] create : un conteneur (element) est requis.");
        }
        opts = opts || {};
        const content = opts.content || null;
        const minZoomOpt = opts.minZoom === undefined ? "fit" : opts.minZoom;
        const maxZoom = opts.maxZoom === undefined ? 30 : Number(opts.maxZoom);
        const zoomFactor = opts.zoomFactor === undefined ? 1.1 : Number(opts.zoomFactor);
        const panClamp = opts.panClamp !== false;
        const doubleClickZoom = opts.doubleClickZoom !== false;
        const wheel = opts.wheel !== false;
        const drag = opts.drag !== false;
        const dragButton = opts.dragButton === undefined ? 0 : opts.dragButton;
        const dragTarget = opts.dragTarget || (content || container);
        // canDrag(e) : garde-fou par événement, consulté AVANT d'amorcer un drag.
        // Défaut () => true (aucun filtre). L'hôte peut l'utiliser pour interdire
        // le pan depuis certaines cibles (ex. un overlay de dessin crop/masque).
        const canDrag = typeof opts.canDrag === 'function' ? opts.canDrag : () => true;
        const onChange = typeof opts.onChange === "function" ? opts.onChange : null;
        // Abonnés supplémentaires (multi-subscription) : appelés avec l'instance
        // après chaque changement de transform, EN PLUS de opts.onChange.
        const subscribers = new Set();
        // Followers : éléments qui reçoivent EXACTEMENT le même transform inline
        // que le content (même string, même moment, même transition). Utilisés
        // pour des overlays (canvas) qui doivent suivre l'image au pixel près.
        const followers = new Set();

        // ── État ──
        let iw = opts.imageWidth || 0;
        let ih = opts.imageHeight || 0;
        let scale = 1;
        let tx = 0;
        let ty = 0;
        let cw = 0;
        let ch = 0;
        let contentW = 0;
        let contentH = 0;
        let containScale = 1;
        let fitScale = 1;
        let originX = 0;
        let originY = 0;
        let dx = 0;
        let dy = 0;
        let pixelScale = 1;
        let destroyed = false;

        // Styles d'origine du contenu (restaurés à destroy()).
        const origTransform = content ? content.style.transform : null;
        const origTransition = content ? content.style.transition : null;
        const origTransformOrigin = content ? content.style.transformOrigin : null;

        // ── Mesure / géométrie ──
        function measure() {
            const r = container.getBoundingClientRect();
            cw = r.width;
            ch = r.height;
            if (content) {
                // Taille de LAYOUT (offsetWidth/Height), PAS getBoundingClientRect :
                // ce dernier est transform-aware et renverrait la taille déjà zoomée
                // après un zoom → un refit (resize) corromprait la géométrie.
                contentW = content.offsetWidth;
                contentH = content.offsetHeight;
                originX = content.offsetLeft;
                originY = content.offsetTop;
            } else {
                contentW = cw;
                contentH = ch;
                originX = 0;
                originY = 0;
            }
            if (iw > 0 && ih > 0) {
                containScale = Math.min(contentW / iw, contentH / ih);
            } else {
                containScale = 1;
            }
            if (content) {
                // Mode content : letterbox à containScale, fit = s=1.
                pixelScale = containScale;
                dx = (contentW - iw * containScale) / 2;
                dy = (contentH - ih * containScale) / 2;
                fitScale = 1;
            } else {
                // Mode headless : pas de letterbox, centrage par tx/ty, fit = containScale.
                pixelScale = 1;
                dx = 0;
                dy = 0;
                fitScale = containScale;
            }
        }

        function minZoomEffective() {
            return minZoomOpt === "fit" ? fitScale : (Number(minZoomOpt) || 1);
        }

        function clampScale(s) {
            return Math.max(minZoomEffective(), Math.min(maxZoom, s));
        }

        function imageRect() {
            return {
                x: originX + tx + dx * scale,
                y: originY + ty + dy * scale,
                width: iw * pixelScale * scale,
                height: ih * pixelScale * scale,
            };
        }

        function clampPan() {
            if (!panClamp) return;
            const r = imageRect();
            if (r.width <= cw) {
                tx = (cw - r.width) / 2 - originX - dx * scale;
            } else {
                const minX = cw - r.width - originX - dx * scale;
                const maxX = -originX - dx * scale;
                tx = Math.max(minX, Math.min(maxX, tx));
            }
            if (r.height <= ch) {
                ty = (ch - r.height) / 2 - originY - dy * scale;
            } else {
                const minY = ch - r.height - originY - dy * scale;
                const maxY = -originY - dy * scale;
                ty = Math.max(minY, Math.min(maxY, ty));
            }
        }

        function applyTransformTo(el, transition) {
            const t = transition === "none" ? "none" : TRANSITION_REST;
            el.style.transition = t;
            el.style.transformOrigin = "0 0";
            el.style.transform = "translate(" + tx + "px, " + ty + "px) scale(" + scale + ")";
        }

        function applyTransform(transition) {
            if (!content) return;
            applyTransformTo(content, transition);
            // Followers : même passage, même string, même transition que le content.
            followers.forEach((el) => applyTransformTo(el, transition));
        }

        function notify() {
            if (onChange) {
                try { onChange(instance); } catch (e) { /* un callback ne doit pas casser la brique */ }
            }
            subscribers.forEach((cb) => {
                try { cb(instance); } catch (e) { /* un abonné ne doit pas casser la brique */ }
            });
        }

        function setPan(nx, ny, dragOpts) {
            tx = nx;
            ty = ny;
            clampPan();
            applyTransform(dragOpts && dragOpts.transition);
            notify();
        }

        function setScaleInternal(s, clientX, clientY, transition) {
            const s2 = clampScale(s);
            let mx;
            let my;
            if (clientX !== undefined && clientX !== null) {
                const rect = container.getBoundingClientRect();
                mx = clientX - rect.left;
                my = clientY - rect.top;
            } else {
                mx = cw / 2;
                my = ch / 2;
            }
            const ratio = s2 / scale;
            tx = (mx - originX) - (mx - originX - tx) * ratio;
            ty = (my - originY) - (my - originY - ty) * ratio;
            scale = s2;
            clampPan();
            applyTransform(transition);
            notify();
        }

        function fit() {
            measure();
            scale = fitScale;
            if (content) {
                tx = 0;
                ty = 0;
            } else {
                tx = (cw - iw * containScale) / 2;
                ty = (ch - ih * containScale) / 2;
            }
            clampPan();
            applyTransform();
            notify();
        }

        // ── Événements ──
        function onWheel(e) {
            if (!wheel) return;
            e.preventDefault();
            const factor = e.deltaY < 0 ? zoomFactor : 1 / zoomFactor;
            setScaleInternal(scale * factor, e.clientX, e.clientY);
        }

        function onDblClick(e) {
            if (!doubleClickZoom) return;
            e.preventDefault();
            setScaleInternal(scale * zoomFactor * zoomFactor, e.clientX, e.clientY);
        }

        let dragging = false;
        let dragStartX = 0;
        let dragStartY = 0;
        let dragStartTx = 0;
        let dragStartTy = 0;

        function onMouseDown(e) {
            if (!drag) return;
            if (e.button !== dragButton) return;
            // Garde-fou par événement : si l'hôte refuse le drag depuis cette
            // cible (ex. pointerdown sur un overlay de dessin), on n'amorce PAS
            // le pan — le dessin (ou autre) garde la main.
            // Un canDrag qui jette est traité comme `true` (on autorise le pan,
            // comportement par défaut) : la brique ne doit jamais casser sur un
            // callback hôte défaillant.
            let allowed = true;
            try {
                allowed = canDrag(e);
            } catch (err) {
                allowed = true;
            }
            if (!allowed) return;
            dragging = true;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            dragStartTx = tx;
            dragStartTy = ty;
            applyTransform("none");
            window.addEventListener("mousemove", onMouseMove);
            window.addEventListener("mouseup", onMouseUp);
            e.preventDefault();
        }

        function onMouseMove(e) {
            if (!dragging) return;
            setPan(
                dragStartTx + (e.clientX - dragStartX),
                dragStartTy + (e.clientY - dragStartY),
                { transition: "none" }
            );
        }

        function onMouseUp() {
            if (!dragging) return;
            dragging = false;
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
            applyTransform();
        }

        function addListeners() {
            if (wheel) container.addEventListener("wheel", onWheel, { passive: false });
            if (doubleClickZoom) container.addEventListener("dblclick", onDblClick);
            if (drag) dragTarget.addEventListener("mousedown", onMouseDown);
        }

        function removeListeners() {
            if (wheel) container.removeEventListener("wheel", onWheel);
            if (doubleClickZoom) container.removeEventListener("dblclick", onDblClick);
            if (drag) dragTarget.removeEventListener("mousedown", onMouseDown);
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
        }

        // ── API ──
        const instance = {
            VERSION,

            setImageSize(w, h) {
                iw = w;
                ih = h;
                fit();
            },

            fit,

            getFitScale() {
                return fitScale;
            },

            getScale() {
                return scale;
            },

            getTransform() {
                return { scale, tx, ty };
            },

            zoomBy(factor, clientX, clientY) {
                setScaleInternal(scale * factor, clientX, clientY);
            },

            setScale(s, clientX, clientY) {
                setScaleInternal(s, clientX, clientY);
            },

            panBy(dx2, dy2) {
                setPan(tx + dx2, ty + dy2);
            },

            screenToImage(clientX, clientY) {
                const rect = container.getBoundingClientRect();
                const mx = clientX - rect.left;
                const my = clientY - rect.top;
                return {
                    x: (mx - originX - tx - dx * scale) / (pixelScale * scale),
                    y: (my - originY - ty - dy * scale) / (pixelScale * scale),
                };
            },

            imageToScreen(ix, iy) {
                return {
                    x: originX + tx + (dx + ix * pixelScale) * scale,
                    y: originY + ty + (dy + iy * pixelScale) * scale,
                };
            },

            getImageRect() {
                const r = imageRect();
                return { x: r.x, y: r.y, width: r.width, height: r.height };
            },

            // Multi-subscription : on(cb) / off(cb) — cb appelé avec l'instance
            // après chaque changement de transform (en plus de opts.onChange).
            on(cb) {
                if (typeof cb === "function") subscribers.add(cb);
                return instance;
            },

            off(cb) {
                subscribers.delete(cb);
                return instance;
            },

            // Followers : éléments qui reçoivent le même transform que le content.
            // addFollower protège contre les non-éléments et les doublons (Set).
            addFollower(el) {
                if (el && typeof el === "object" && el.nodeType === 1) {
                    followers.add(el);
                    // Applique immédiatement le transform courant (même string que
                    // le content) pour que le follower soit synchro dès l'ajout.
                    applyTransformTo(el);
                }
                return instance;
            },

            removeFollower(el) {
                followers.delete(el);
                return instance;
            },

            reset() {
                fit();
            },

            destroy() {
                if (destroyed) return;
                destroyed = true;
                removeListeners();
                if (ro) {
                    ro.disconnect();
                    ro = null;
                }
                if (content) {
                    content.style.transform = origTransform;
                    content.style.transition = origTransition;
                    content.style.transformOrigin = origTransformOrigin;
                }
                // Retire les refs followers (les éléments restent dans leur état).
                followers.clear();
            },

            refit() {
                const wasAtFit = Math.abs(scale - fitScale) < 1e-9;
                measure();
                if (wasAtFit) {
                    fit();
                } else {
                    clampPan();
                    applyTransform();
                    notify();
                }
            },
        };

        // ── ResizeObserver (si dispo) : refit si au fit, sinon re-clamp le pan ──
        let ro = null;
        if (typeof ResizeObserver !== "undefined") {
            ro = new ResizeObserver(() => {
                if (!destroyed) instance.refit();
            });
            ro.observe(container);
        }

        addListeners();
        fit();

        return instance;
    }

    return {
        version: VERSION,
        create,
    };
})();

// Exposition globale (scripts classiques de la page).
if (typeof window !== "undefined") {
    window.HolafViewport = HolafViewport;
}

// Export ESM (import { HolafViewport } from "./holaf-viewport.js").
export { HolafViewport };
