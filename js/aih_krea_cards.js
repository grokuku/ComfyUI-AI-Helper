/*
 * Copyright (C) Holaf — ComfyUI-AI-Helper.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * AIH Krea Cards — habillage DOM des nodes AIHGuideCard / AIHSliderCard.
 *
 * Conception (maquette validée) :
 *   - Guide Card  : carte « hybride » (~365 px) — en-tête (vignette de la
 *     référence + libellé + force compacte) + badge « n/12 », section
 *     INTENTION, ligne Direction (segmented control), ligne Force
 *     (slider + valeur), puis 10 lignes denses RÉGLAGES MANUELS et la ligne
 *     grisée `overall_style_reach` (inactive sur Krea 2).
 *   - Slider Card : ligne unique (~74 px) — attribut | cadran | valeur | ⚙,
 *     graduations ±, badge « n/8 ». Le bouton ⚙ déplie les 2 pôles.
 *
 * SOURCE DE VÉRITÉ : les widgets NATIFS du node (portés par ComfyUI). Le DOM
 * ne fait que les piloter (`w.value = …`) et les refléter.
 *
 * SÉRIALISATION / RESTAURATION (fiabilité prioritaire, cf. AGENTS.md) :
 *   - Les widgets natifs sont masqués via `hidden = true` mais JAMAIS avec
 *     `serialize = false` : ils restent donc sérialisés par ComfyUI.
 *     (Vérifié dans la frontend Vue `LGraphNode.serialize/configure` : seul
 *     `serialize === false` est filtré, `hidden` ne l'est pas ; idem pour
 *     `graphToPrompt` qui filtre sur `options.serialize`.)
 *   - Le widget DOM ajouté porte `serialize = false` ET
 *     `options.serialize = false` : il n'apparaît ni dans le workflow ni dans
 *     le prompt API, donc il ne décale pas la sérialisation positionnelle.
 *   - En plus, `onSerialize` écrit un instantané NOMMÉ (`aih_krea_widgets`) et
 *     `onConfigure` restaure PAR NOM en priorité (indépendant de l'index),
 *     avec repli positionnel sur `data.widgets_values` seulement si sa
 *     longueur est cohérente (jamais de boucle de retry / polling).
 */

import { holafExtUrl } from "./holaf_ext_base.js";

(function () {
    "use strict";

    if (typeof window === "undefined") return;

    const AIH = (window.AIH = window.AIH || {});

    // ── Identité / chemins ────────────────────────────────────────────────
    const EXT_NAME = "AIH.KreaCards";
    const GUIDE_TYPE = "AIHGuideCard";
    const SLIDER_TYPE = "AIHSliderCard";
    const CSS_ID = "aih-krc-css";
    const CSS_PATH = "css/aih_krea_cards.css";

    // ── Cartes ────────────────────────────────────────────────────────────
    const GUIDE_TOTAL = 12; // badge guide : n/12
    const SLIDER_TOTAL = 8; // badge slider : n/8
    const GUIDE_HEIGHT = 368; // hauteur cible ≈365 px (arrondi lisible)
    const SLIDER_HEIGHT = 74;
    const SLIDER_HEIGHT_EXPANDED = 148;
    const TITLE_BAND = 30; // widgets_start_y : sous la barre de titre litegraph

    // Ordre EXACT des widgets natifs (les sockets IMAGE ne sont pas des
    // widgets). Sert à l'instantané nommé et au repli positionnel.
    const GUIDE_ORDER = [
        "intention", "direction", "force", "preparation", "formes_copiees",
        "detail_conserve", "couleur_conservee", "structure", "finition",
        "phase_debut", "phase_fin", "etude", "cadrage", "overall_style_reach",
    ];
    const SLIDER_ORDER = ["attribut", "valeur", "pole_positif", "pole_negatif"];

    // Libellés EXACTS des enums Python (l'option DOM doit valoir la valeur du
    // widget natif, sans quoi la synchro sélection ↔ valeur casse).
    const GUIDE_INTENTIONS = [
        "Garder le sujet", "Équilibré", "Copier le style", "Copier la lumière",
        "Copier la pose", "Grandes formes", "Palette de couleurs", "Éviter texte/logos",
    ];
    const GUIDE_DIRECTIONS = ["vers l'image", "à l'opposé"];
    const GUIDE_PREPS = [
        "Image telle quelle", "Retirer la couleur", "Adoucir les détails",
        "Flouter texte et texture", "Lavage de palette", "Lavage de couleur",
        "Nettoyage formes seules", "Nettoyage formes fort",
    ];
    const GUIDE_STUDIES = [
        "Réglage de la pile", "Faible - idée libre (256)", "Moyen - défaut équilibré (384)",
        "Élevé - plus exact (512)", "Très élevé - le plus exact (768)",
    ];
    const GUIDE_FRAMINGS = [
        "Réglage de la pile", "Garder la forme complète",
        "Recadrer au centre (carré)", "Étirer en carré",
    ];

    const DEFAULT_INTENTION = "Équilibré";
    const DEFAULT_DIRECTION = "vers l'image";
    const DEFAULT_PREP = "Image telle quelle";
    const DEFAULT_STACK = "Réglage de la pile";
    const DEFAULT_FLOAT = 1.0;

    // 10 lignes denses de RÉGLAGES MANUELS (dans l'ordre du node Python).
    const GUIDE_MANUAL_ROWS = [
        { name: "preparation", label: "Préparation", title: "Préparation de l'image de référence", kind: "select", options: GUIDE_PREPS, def: DEFAULT_PREP },
        { name: "formes_copiees", label: "Formes", title: "Formes copiées (0–2)", kind: "range", min: 0, max: 2, step: 0.05, def: DEFAULT_FLOAT },
        { name: "detail_conserve", label: "Détail", title: "Détail conservé (0–1)", kind: "range", min: 0, max: 1, step: 0.05, def: DEFAULT_FLOAT },
        { name: "couleur_conservee", label: "Couleur", title: "Couleur conservée (0–1)", kind: "range", min: 0, max: 1, step: 0.05, def: DEFAULT_FLOAT },
        { name: "structure", label: "Structure", title: "Structure — couches 0–5 (0–2)", kind: "range", min: 0, max: 2, step: 0.05, def: DEFAULT_FLOAT },
        { name: "finition", label: "Finition", title: "Finition — couches 6–11 (0–2)", kind: "range", min: 0, max: 2, step: 0.05, def: DEFAULT_FLOAT },
        { name: "phase_debut", label: "Début", title: "Phase de début (0–5)", kind: "range", min: 0, max: 5, step: 0.05, def: DEFAULT_FLOAT },
        { name: "phase_fin", label: "Fin", title: "Phase de fin (0–5)", kind: "range", min: 0, max: 5, step: 0.05, def: DEFAULT_FLOAT },
        { name: "etude", label: "Étude", title: "Résolution d'étude de la référence", kind: "select", options: GUIDE_STUDIES, def: DEFAULT_STACK },
        { name: "cadrage", label: "Cadrage", title: "Cadrage de la référence", kind: "select", options: GUIDE_FRAMINGS, def: DEFAULT_STACK },
    ];

    // Réglage inactif sur Krea 2 : affiché grisé + note, mais le widget natif
    // reste sérialisable (on ne le retire jamais de node.widgets).
    const GUIDE_REACH = {
        name: "overall_style_reach",
        label: "Reach",
        title: "Portée de style globale — inactif sur Krea 2",
        kind: "range",
        min: 0, max: 3, step: 0.05, def: DEFAULT_FLOAT,
        note: "inactif sur Krea 2",
    };

    // Slider Card
    const SLIDER_ATTR_DEFAULT = "brightness";
    const SLIDER_RANGE = 6;
    const GRAD_FALLBACK_NEG = "plus sombre";
    const GRAD_FALLBACK_POS = "plus lumineux";
    const POLE_HINT = "Vide = déduit automatiquement de l'attribut";

    // ── Helpers génériques ────────────────────────────────────────────────
    function el(tag, cls, text) {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    function option(value, label) {
        const o = document.createElement("option");
        o.value = value;
        o.textContent = label;
        return o;
    }

    function getWidget(node, name) {
        return node && node.widgets ? node.widgets.find((w) => w && w.name === name) : undefined;
    }

    function clamp(value, lo, hi) {
        return Math.min(Math.max(value, lo), hi);
    }

    function format2(value) {
        const n = Number(value);
        return Number.isFinite(n) ? n.toFixed(2) : "0.00";
    }

    function formatSigned1(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return "0.0";
        return n > 0 ? "+" + n.toFixed(1) : n.toFixed(1);
    }

    /** Écrit la valeur dans le widget NATIF (source de vérité) + callback. */
    function setNative(node, name, value) {
        const w = getWidget(node, name);
        if (!w) return false;
        w.value = value;
        if (typeof w.callback === "function") {
            try {
                // Signature litegraph : (value, canvas, node, pos, event).
                const canvas = (window.app && window.app.canvas) || null;
                w.callback(value, canvas, node);
            } catch (err) {
                /* Un callback tiers défaillant ne doit pas casser la carte. */
                console.warn("[AIH.KreaCards] callback natif en erreur:", err);
            }
        }
        return true;
    }

    // ── CSS (auto-injection, idempotente) ─────────────────────────────────
    function ensureCss() {
        if (typeof document === "undefined" || !document.head) return;
        if (document.getElementById(CSS_ID)) return;
        const link = document.createElement("link");
        link.id = CSS_ID;
        link.rel = "stylesheet";
        link.type = "text/css";
        link.href = holafExtUrl(CSS_PATH);
        document.head.appendChild(link);
    }

    // ── Masquage des widgets natifs ───────────────────────────────────────
    // `hidden = true` empêche le rendu Vue ; on ne touche PAS `serialize`
    // (le natif doit rester sérialisé). Voir l'en-tête de fichier.
    function hideNativeWidget(node, name) {
        const w = getWidget(node, name);
        if (!w) return null;
        w.hidden = true;
        w.computeSize = () => [0, -4];
        if (w.element) w.element.style.display = "none";
        if (w.inputEl) w.inputEl.style.display = "none";
        if (w.parentEl) w.parentEl.style.display = "none";
        return w;
    }

    // ── Instantané / restauration nommés (sérialisation fiable) ───────────
    function snapshot(node, order) {
        const out = {};
        for (const name of order) {
            const w = getWidget(node, name);
            if (w) out[name] = w.value;
        }
        return out;
    }

    function applyNamed(node, order, map) {
        if (!map || typeof map !== "object") return false;
        let applied = false;
        for (const name of order) {
            if (!Object.prototype.hasOwnProperty.call(map, name)) continue;
            const w = getWidget(node, name);
            if (!w) continue;
            w.value = map[name];
            applied = true;
        }
        return applied;
    }

    // Repli positionnel UNIQUEMENT si la longueur est cohérente : un tableau
    // compacté (widgets masqués omis par une version de frontend plus stricte)
    // décalerait les index et corromprait les valeurs.
    function applyPositional(node, order, values) {
        if (!Array.isArray(values) || values.length < order.length) return false;
        let applied = false;
        for (let i = 0; i < order.length; i++) {
            const value = values[i];
            if (value === undefined || value === null) continue;
            const w = getWidget(node, order[i]);
            if (!w) continue;
            w.value = value;
            applied = true;
        }
        return applied;
    }

    function restore(node, data, order) {
        if (data) {
            const okNamed = applyNamed(node, order, data.aih_krea_widgets);
            if (!okNamed) applyPositional(node, order, data.widgets_values);
        }
        if (node._aihKrc && typeof node._aihKrc.refresh === "function") {
            node._aihKrc.refresh();
        }
    }

    // ── Position (badge) & vignette ───────────────────────────────────────
    function graphNodes(node) {
        const g = node && node.graph;
        if (!g) return [];
        return g._nodes || g.nodes || [];
    }

    function getImageLink(node) {
        const input = node && node.inputs ? node.inputs.find((i) => i && i.name === "image") : null;
        if (!input) return null;
        const raw = input.link;
        if (raw === undefined || raw === null) return null;
        if (typeof raw === "object") return raw; // nouveau frontend : objet lien direct
        const g = node.graph;
        if (!g) return null;
        if (typeof g.getLink === "function") {
            const l = g.getLink(raw);
            if (l) return l;
        }
        if (g.links) {
            if (typeof g.links.get === "function") {
                const l = g.links.get(raw);
                if (l) return l;
            }
            if (g.links[raw]) return g.links[raw];
        }
        if (g._links && typeof g._links.get === "function") {
            const l = g._links.get(raw);
            if (l) return l;
        }
        return null;
    }

    function findOrigin(node, link) {
        if (!link || link.origin_id === undefined || link.origin_id === null) return null;
        const g = node.graph;
        return g && typeof g.getNodeById === "function" ? g.getNodeById(link.origin_id) : null;
    }

    function findRefThumb(node) {
        const origin = findOrigin(node, getImageLink(node));
        if (!origin) return null;
        const media = origin.imgs || origin.images;
        if (!Array.isArray(media) || media.length === 0) return null;
        const first = media[0];
        if (typeof first === "string") return first;
        if (first && typeof first.src === "string") return first.src;
        return null;
    }

    /**
     * Position de la carte (numérateur du badge).
     *   1. index de l'entrée connectée si l'amont expose plusieurs sorties ;
     *   2. sinon index de cette carte parmi les cartes de la même famille ;
     *   3. sinon 1 (badge « 1/N » statique).
     */
    function computePosition(node, kind) {
        const total = kind === "guide" ? GUIDE_TOTAL : SLIDER_TOTAL;
        const type = kind === "guide" ? GUIDE_TYPE : SLIDER_TYPE;

        const link = getImageLink(node);
        const origin = findOrigin(node, link);
        if (origin && Array.isArray(origin.outputs) && origin.outputs.length > 1) {
            const idx = Number(link.origin_slot);
            if (Number.isFinite(idx)) return clamp(idx + 1, 1, total);
        }

        const family = graphNodes(node).filter((n) => n && (n.type === type || n.comfyClass === type));
        if (family.length > 1) {
            const idx = family.indexOf(node);
            if (idx >= 0) return clamp(idx + 1, 1, total);
        }
        return 1;
    }

    // ── Ajustement de la taille du node ───────────────────────────────────
    function resizeNodeHeight(node, minHeight) {
        if (!node || !Array.isArray(node.size) || typeof node.setSize !== "function") return;
        const current = node.size[1] || 0;
        if (minHeight > current) node.setSize([node.size[0], minHeight]);
    }

    function ensureMinWidth(node, minWidth) {
        if (!node || !Array.isArray(node.size) || typeof node.setSize !== "function") return;
        if ((node.size[0] || 0) < minWidth) node.setSize([minWidth, node.size[1]]);
    }

    // ═════════════════════════════════════════════════════════════════════
    //  GUIDE CARD
    // ═════════════════════════════════════════════════════════════════════
    function buildGuideCard(node) {
        const root = el("div", "aih-krc aih-krc-guide");

        // ── En-tête : vignette + libellé + badge + force compacte ──
        const head = el("div", "aih-krc-head");
        const thumb = el("div", "aih-krc-thumb", "🖼");
        thumb.title = "Référence (entrée IMAGE)";
        const info = el("div", "aih-krc-headinfo");
        const title = el("div", "aih-krc-title", "Guide Card");
        const sub = el("div", "aih-krc-sub", "Référence");
        info.append(title, sub);
        const badge = el("div", "aih-krc-badge", "1/" + GUIDE_TOTAL);
        const forceMini = el("div", "aih-krc-force-mini");
        const forceMiniVal = el("b", null, "0.20");
        forceMini.append("Force ", forceMiniVal);
        head.append(thumb, info, badge, forceMini);

        // ── Section INTENTION ──
        const sep1 = el("div", "aih-krc-sep");
        const secIntention = el("div", "aih-krc-section", "Intention");
        const intentionSel = el("select", "aih-krc-select aih-krc-select-full");
        GUIDE_INTENTIONS.forEach((opt) => intentionSel.appendChild(option(opt, opt)));

        // ── Ligne Direction (segmented control 2 états) ──
        const dirRow = el("div", "aih-krc-row");
        const dirLabel = el("span", "aih-krc-rowlabel", "Direction");
        dirLabel.title = "vers l'image = imiter la référence ; à l'opposé = s'en éloigner";
        const seg = el("div", "aih-krc-seg");
        const dirBtns = {};
        GUIDE_DIRECTIONS.forEach((value) => {
            const b = el("button", null, value);
            b.type = "button";
            b.title = value;
            b.addEventListener("click", () => {
                setNative(node, "direction", value);
                refresh();
            });
            seg.appendChild(b);
            dirBtns[value] = b;
        });
        dirRow.append(dirLabel, seg);

        // ── Ligne Force (slider + valeur) ──
        const forceRow = el("div", "aih-krc-row");
        const forceLabel = el("span", "aih-krc-rowlabel", "Force");
        forceLabel.title = "Force d'application de la carte (0–3)";
        const forceRange = el("input", "aih-krc-range");
        forceRange.type = "range";
        forceRange.min = "0";
        forceRange.max = "3";
        forceRange.step = "0.05";
        const forceVal = el("span", "aih-krc-val", "0.20");
        const forceControl = el("div", "aih-krc-control");
        forceControl.appendChild(forceRange);
        forceRow.append(forceLabel, forceControl, forceVal);

        forceRange.addEventListener("input", () => {
            const value = Number(forceRange.value);
            setNative(node, "force", value);
            forceVal.textContent = format2(value);
            forceMiniVal.textContent = format2(value);
        });

        // ── Section RÉGLAGES MANUELS (10 lignes denses) ──
        const sep2 = el("div", "aih-krc-sep");
        const secManual = el("div", "aih-krc-section");
        const secManualText = el("span", null, "Réglages manuels");
        const modCount = el("span", "aih-krc-modcount", "");
        secManual.append(secManualText, modCount);

        const refs = {};
        const denseRows = [];
        GUIDE_MANUAL_ROWS.forEach((cfg) => {
            const row = el("div", "aih-krc-row");
            const label = el("span", "aih-krc-rowlabel");
            label.title = cfg.title;
            const dot = el("span", "aih-krc-dot");
            const labelText = el("span", "aih-krc-rowlabel-text", cfg.label);
            label.append(dot, labelText);

            const control = el("div", "aih-krc-control");
            const val = el("span", "aih-krc-val", "");

            if (cfg.kind === "select") {
                const select = el("select", "aih-krc-select");
                cfg.options.forEach((opt) => select.appendChild(option(opt, opt)));
                select.addEventListener("change", () => {
                    setNative(node, cfg.name, select.value);
                    refreshOverrides();
                });
                control.appendChild(select);
                refs[cfg.name] = { row, control: select, val };
            } else {
                const range = el("input", "aih-krc-range");
                range.type = "range";
                range.min = String(cfg.min);
                range.max = String(cfg.max);
                range.step = String(cfg.step);
                range.addEventListener("input", () => {
                    const value = Number(range.value);
                    setNative(node, cfg.name, value);
                    val.textContent = format2(value);
                    refreshOverrides();
                });
                control.appendChild(range);
                val.textContent = format2(cfg.def);
                refs[cfg.name] = { row, control: range, val };
            }

            row.append(label, control, val);
            denseRows.push({ cfg, row });
        });

        // ── Ligne grisée : overall_style_reach (inactif sur Krea 2) ──
        const reachRow = el("div", "aih-krc-row is-disabled");
        const reachLabel = el("span", "aih-krc-rowlabel", GUIDE_REACH.label);
        reachLabel.title = GUIDE_REACH.title;
        const reachControl = el("div", "aih-krc-control");
        const reachRange = el("input", "aih-krc-range");
        reachRange.type = "range";
        reachRange.min = String(GUIDE_REACH.min);
        reachRange.max = String(GUIDE_REACH.max);
        reachRange.step = String(GUIDE_REACH.step);
        reachRange.disabled = true;
        reachControl.appendChild(reachRange);
        const reachVal = el("span", "aih-krc-val", format2(GUIDE_REACH.def));
        const reachNote = el("div", "aih-krc-note", GUIDE_REACH.note);
        reachNote.title = GUIDE_REACH.title;

        root.append(
            head, sep1, secIntention, intentionSel, dirRow, forceRow,
            sep2, secManual,
        );
        denseRows.forEach(({ row }) => root.appendChild(row));
        root.append(reachRow);
        reachRow.append(reachLabel, reachControl, reachVal, reachNote);

        // ── Synchro natives → DOM ──
        function refreshOverrides() {
            let mods = 0;
            Object.keys(refs).forEach((name) => {
                const cfg = GUIDE_MANUAL_ROWS.find((c) => c.name === name);
                const w = getWidget(node, name);
                const value = w ? w.value : cfg.def;
                const over = cfg.kind === "select"
                    ? String(value) !== String(cfg.def)
                    : Number(value) !== Number(cfg.def);
                refs[name].row.classList.toggle("is-override", over);
                if (over) mods++;
            });
            modCount.textContent = mods > 0 ? "· " + mods + (mods > 1 ? " modifs" : " modif") : "";
        }

        let lastThumbSrc = null;
        function updateThumb() {
            const src = findRefThumb(node);
            if (src === lastThumbSrc) return;
            lastThumbSrc = src;
            if (src) {
                thumb.innerHTML = "";
                const img = document.createElement("img");
                img.alt = "";
                img.src = src;
                thumb.appendChild(img);
                thumb.classList.add("has-ref");
            } else {
                thumb.innerHTML = "";
                thumb.textContent = "🖼";
                thumb.classList.remove("has-ref");
            }
        }

        function refresh() {
            const intentionW = getWidget(node, "intention");
            const intention = intentionW ? String(intentionW.value) : DEFAULT_INTENTION;
            intentionSel.value = intention;
            sub.textContent = intention;

            const directionW = getWidget(node, "direction");
            const direction = directionW ? String(directionW.value) : DEFAULT_DIRECTION;
            Object.keys(dirBtns).forEach((d) => dirBtns[d].classList.toggle("active", d === direction));

            const forceW = getWidget(node, "force");
            const force = forceW ? Number(forceW.value) : 0.2;
            forceRange.value = String(force);
            forceVal.textContent = format2(force);
            forceMiniVal.textContent = format2(force);

            GUIDE_MANUAL_ROWS.forEach((cfg) => {
                const ref = refs[cfg.name];
                const w = getWidget(node, cfg.name);
                const value = w ? w.value : cfg.def;
                if (cfg.kind === "select") {
                    ref.control.value = String(value);
                } else {
                    ref.control.value = String(Number(value));
                    ref.val.textContent = format2(value);
                }
            });
            refreshOverrides();

            const reachW = getWidget(node, GUIDE_REACH.name);
            const reach = reachW ? Number(reachW.value) : GUIDE_REACH.def;
            reachRange.value = String(reach);
            reachVal.textContent = format2(reach);

            badge.textContent = computePosition(node, "guide") + "/" + GUIDE_TOTAL;
            updateThumb();
        }

        intentionSel.addEventListener("change", () => {
            setNative(node, "intention", intentionSel.value);
            refresh();
        });

        // L'intention ne modifie PAS les réglages manuels (pas d'auto-fill) :
        // chaque réglage reste un override explicite côté Python. On se contente
        // de refléter l'état courant pour ne jamais casser l'override manuel.

        // Le libellé "Référence" reste synchronisé à la connexion.
        refresh();

        return {
            root,
            refresh,
            kind: "guide",
            _minH: GUIDE_HEIGHT,
        };
    }

    // ═════════════════════════════════════════════════════════════════════
    //  SLIDER CARD
    // ═════════════════════════════════════════════════════════════════════
    function buildSliderCard(node) {
        const root = el("div", "aih-krc aih-krc-slider");

        const head = el("div", "aih-krc-head");
        const title = el("div", "aih-krc-title", "Slider Card");
        const badge = el("div", "aih-krc-badge", "1/" + SLIDER_TOTAL);
        head.append(title, badge);

        // [attribut | cadran | valeur | ⚙]
        const sline = el("div", "aih-krc-sline");
        const attrInput = el("input", "aih-krc-input aih-krc-attr");
        attrInput.type = "text";
        attrInput.placeholder = SLIDER_ATTR_DEFAULT;
        attrInput.title = "Attribut poussé par le slider (ex. brightness, warmth…)";

        const range = el("input", "aih-krc-range aih-krc-sliderrange");
        range.type = "range";
        range.min = String(-SLIDER_RANGE);
        range.max = String(SLIDER_RANGE);
        range.step = "0.05";
        range.title = "Valeur du slider (−6 … +6)";

        const valueSpan = el("span", "aih-krc-sliderval", "0.0");
        const gear = el("button", "aih-krc-gear", "⚙");
        gear.type = "button";
        gear.title = "Pôles ± (texte des extrémités)";
        sline.append(attrInput, range, valueSpan, gear);

        // Graduations ±
        const grads = el("div", "aih-krc-grads");
        const gradNeg = el("span", "aih-krc-grad-neg", GRAD_FALLBACK_NEG);
        const gradZero = el("span", "aih-krc-grad-zero", "0");
        const gradPos = el("span", "aih-krc-grad-pos", GRAD_FALLBACK_POS);
        grads.append(gradNeg, gradZero, gradPos);

        // Panneau pôles (replié par défaut)
        const poles = el("div", "aih-krc-poles");
        poles.hidden = true;

        const poleNegRow = el("div", "aih-krc-pole");
        const poleNegLabel = el("label", null, "−");
        const poleNeg = el("input", "aih-krc-input aih-krc-pole-neg");
        poleNeg.type = "text";
        poleNeg.placeholder = "pôle négatif — ex. cold blue";
        poleNegRow.append(poleNegLabel, poleNeg);

        const polePosRow = el("div", "aih-krc-pole");
        const polePosLabel = el("label", null, "+");
        const polePos = el("input", "aih-krc-input aih-krc-pole-pos");
        polePos.type = "text";
        polePos.placeholder = "pôle positif — ex. golden hour";
        polePosRow.append(polePosLabel, polePos);

        const hint = el("div", "aih-krc-hint", POLE_HINT);
        poles.append(poleNegRow, polePosRow, hint);

        root.append(head, sline, grads, poles);

        function refreshGrads() {
            const negW = getWidget(node, "pole_negatif");
            const posW = getWidget(node, "pole_positif");
            const neg = negW && String(negW.value).trim() ? String(negW.value).trim() : GRAD_FALLBACK_NEG;
            const pos = posW && String(posW.value).trim() ? String(posW.value).trim() : GRAD_FALLBACK_POS;
            gradNeg.textContent = neg;
            gradNeg.title = neg;
            gradPos.textContent = pos;
            gradPos.title = pos;
        }

        function refresh() {
            const attrW = getWidget(node, "attribut");
            const attrValue = attrW ? String(attrW.value) : SLIDER_ATTR_DEFAULT;
            if (attrInput.value !== attrValue) attrInput.value = attrValue;

            const valueW = getWidget(node, "valeur");
            const value = valueW ? Number(valueW.value) : 0;
            range.value = String(value);
            valueSpan.textContent = formatSigned1(value);

            const negW = getWidget(node, "pole_negatif");
            const posW = getWidget(node, "pole_positif");
            const negValue = negW ? String(negW.value) : "";
            const posValue = posW ? String(posW.value) : "";
            if (poleNeg.value !== negValue) poleNeg.value = negValue;
            if (polePos.value !== posValue) polePos.value = posValue;
            refreshGrads();

            badge.textContent = computePosition(node, "slider") + "/" + SLIDER_TOTAL;
        }

        attrInput.addEventListener("input", () => {
            setNative(node, "attribut", attrInput.value);
        });
        attrInput.addEventListener("change", () => {
            const value = attrInput.value.trim();
            attrInput.value = value;
            setNative(node, "attribut", value);
        });

        range.addEventListener("input", () => {
            const value = Number(range.value);
            setNative(node, "valeur", value);
            valueSpan.textContent = formatSigned1(value);
        });

        poleNeg.addEventListener("input", () => setNative(node, "pole_negatif", poleNeg.value));
        polePos.addEventListener("input", () => setNative(node, "pole_positif", polePos.value));
        poleNeg.addEventListener("change", refreshGrads);
        polePos.addEventListener("change", refreshGrads);

        gear.addEventListener("click", () => {
            const expand = poles.hidden;
            poles.hidden = !expand;
            gear.classList.toggle("active", expand);
            const card = node._aihKrc;
            if (card) {
                card._minH = expand ? SLIDER_HEIGHT_EXPANDED : SLIDER_HEIGHT;
                if (Array.isArray(node.size) && typeof node.setSize === "function") {
                    const target = expand
                        ? Math.max(node.size[1] || 0, SLIDER_HEIGHT_EXPANDED)
                        : SLIDER_HEIGHT;
                    node.setSize([node.size[0], target]);
                }
            }
        });

        refresh();

        return {
            root,
            refresh,
            kind: "slider",
            _minH: SLIDER_HEIGHT,
        };
    }

    // ═════════════════════════════════════════════════════════════════════
    //  Installation / extension
    // ═════════════════════════════════════════════════════════════════════

    function setupCard(node, kind) {
        if (!node || node._aihKrcReady) return;

        const order = kind === "guide" ? GUIDE_ORDER : SLIDER_ORDER;
        for (const name of order) hideNativeWidget(node, name);

        // Synchro inverse (natif → DOM) : tout callback natif (chargement,
        // autre extension, exécution…) reflète la valeur dans le DOM. On chaîne
        // le callback existant sans le remplacer.
        for (const name of order) {
            const w = getWidget(node, name);
            if (!w) continue;
            const origCallback = w.callback;
            w.callback = function () {
                const r = typeof origCallback === "function" ? origCallback.apply(this, arguments) : undefined;
                try {
                    if (node._aihKrc && typeof node._aihKrc.refresh === "function") node._aihKrc.refresh();
                } catch (err) {
                    /* refresh non critique */
                }
                return r;
            };
        }

        ensureCss();

        const card = kind === "guide" ? buildGuideCard(node) : buildSliderCard(node);
        card._minH = kind === "guide" ? GUIDE_HEIGHT : SLIDER_HEIGHT;

        // Évite la croissance cumulative de la node (computeSize fait
        // size[1] += widgets_height sans widgets_start_y).
        if (node.widgets_start_y === undefined || node.widgets_start_y === null) {
            node.widgets_start_y = TITLE_BAND;
        }

        const domName = kind === "guide" ? "AIH_Guide_Card" : "AIH_Slider_Card";
        const domWidget = node.addDOMWidget(domName, "div", card.root, {
            serialize: false,
            hideOnZoom: false,
            getMinHeight: () => card._minH,
        });

        // Ne jamais persister / envoyer le widget DOM (workflow + prompt API).
        try {
            domWidget.serialize = false;
            domWidget.options = domWidget.options || {};
            domWidget.options.serialize = false;
        } catch (err) {
            console.warn("[AIH.KreaCards] flags de sérialisation du DOM widget:", err);
        }

        node._aihKrc = card;
        node._aihKrcDomWidget = domWidget;
        node._aihKrcReady = true;

        card.refresh();

        // Mesure la hauteur réelle du contenu (event-driven, pas de polling).
        if (typeof ResizeObserver === "function") {
            try {
                const observer = new ResizeObserver(() => {
                    const h = Math.ceil(card.root.scrollHeight || 0);
                    if (h > 0 && h < 2000 && Math.abs(h - card._minH) > 1) {
                        card._minH = h;
                        resizeNodeHeight(node, h);
                    }
                });
                observer.observe(card.root);
                node._aihKrcObserver = observer;
            } catch (err) {
                /* ResizeObserver optionnel : le getMinHeight suffit. */
            }
        }

        const applyInitialSize = () => {
            ensureMinWidth(node, kind === "guide" ? 300 : 320);
            resizeNodeHeight(node, card._minH);
        };
        if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(applyInitialSize);
        } else {
            applyInitialSize();
        }
    }

    function installNodeType(nodeType, kind) {
        if (!nodeType || !nodeType.prototype || nodeType.prototype.__aihKrcInstalled) return;
        nodeType.prototype.__aihKrcInstalled = true;
        const order = kind === "guide" ? GUIDE_ORDER : SLIDER_ORDER;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origCreated ? origCreated.apply(this, arguments) : undefined;
            try {
                setupCard(this, kind);
            } catch (err) {
                console.error("[AIH.KreaCards] setup de la carte:", err);
            }
            return r;
        };

        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (data) {
            const r = origConfigure ? origConfigure.apply(this, arguments) : undefined;
            try {
                restore(this, data, order);
            } catch (err) {
                console.error("[AIH.KreaCards] restauration:", err);
            }
            return r;
        };

        const origSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (out) {
            if (origSerialize) origSerialize.apply(this, arguments);
            try {
                if (out) out.aih_krea_widgets = snapshot(this, order);
            } catch (err) {
                console.warn("[AIH.KreaCards] instantané de sérialisation:", err);
            }
        };

        const origConnections = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function () {
            const r = origConnections ? origConnections.apply(this, arguments) : undefined;
            try {
                if (this._aihKrc && typeof this._aihKrc.refresh === "function") this._aihKrc.refresh();
            } catch (err) {
                /* refresh non critique */
            }
            return r;
        };

        const origRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            try {
                if (this._aihKrcObserver && typeof this._aihKrcObserver.disconnect === "function") {
                    this._aihKrcObserver.disconnect();
                }
            } catch (err) {
                /* observers optionnels */
            }
            return origRemoved ? origRemoved.apply(this, arguments) : undefined;
        };
    }

    function register(app) {
        if (!app || typeof app.registerExtension !== "function") return false;
        ensureCss();
        app.registerExtension({
            name: EXT_NAME,
            async beforeRegisterNodeDef(nodeType, nodeData) {
                if (!nodeData) return;
                if (nodeData.name === GUIDE_TYPE) installNodeType(nodeType, "guide");
                else if (nodeData.name === SLIDER_TYPE) installNodeType(nodeType, "slider");
            },
            loadedGraphNode(node) {
                try {
                    ensureCss();
                    if (node && node._aihKrc && typeof node._aihKrc.refresh === "function") {
                        node._aihKrc.refresh();
                    }
                } catch (err) {
                    /* refresh non critique */
                }
            },
        });
        return true;
    }

    // API exposée (tests + introspection).
    AIH.KreaCards = {
        name: EXT_NAME,
        GUIDE_TYPE,
        SLIDER_TYPE,
        GUIDE_TOTAL,
        SLIDER_TOTAL,
        GUIDE_ORDER,
        SLIDER_ORDER,
        GUIDE_MANUAL_ROWS,
        GUIDE_REACH,
        register,
        installNodeType,
        buildGuideCard,
        buildSliderCard,
        _internal: {
            setupCard,
            restore,
            snapshot,
            applyNamed,
            applyPositional,
            computePosition,
            hideNativeWidget,
            setNative,
            format2,
            formatSigned1,
            ensureCss,
        },
    };

    // Attente de window.app (pattern projet : aucun retry de restauration).
    let bootAttempts = 0;
    (function aihBoot() {
        const app = window.app || (window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app);
        if (!app || typeof app.registerExtension !== "function") {
            if (++bootAttempts < 300) setTimeout(aihBoot, 100);
            return;
        }
        register(app);
    })();
})();
