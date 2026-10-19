/*
 * Copyright (C) 2026 Holaf
 * AIH — Elements Picker : seed PAR ÉLÉMENT (helpers).
 * ----------------------------------------------------------------------------
 * Source UNIQUE de vérité côté front pour le réglage « seed par élément » de la
 * node AIHElementsPicker. Trois modes :
 *
 *   "node"   (DÉFAUT, hérité) : l'élément suit le seed de la node — comportement
 *            historique, bit-à-bit identique (mêmes tirages, même index i).
 *   "random" : re-tiré à chaque exécution, indépendamment du seed de la node.
 *   "fixed"  : valeur propre à l'élément, stable d'une exécution à l'autre et
 *            quel que soit le seed de la node.
 *
 * MIROIR du Python (nodes/elements_node.py) : les fonctions de ce module
 * reproduisent `_normalize_seed_mode`, `_coerce_seed_value`,
 * `_derived_element_seed`, `_resolve_element_seed` et `_resolve_braces`. Toute
 * évolution doit être faite DES DEUX CÔTÉS (tests croisés : la table de
 * `resolveBraceBlocks` est vérifiée en JS ET en pytest).
 *
 * COMPATIBILITÉ ASCENDANTE : un élément sans `seed_mode` (ou avec une valeur
 * inconnue) est normalisé en mode hérité. `normalizeElementSeed()` ne renvoie
 * RIEN pour le mode hérité, donc les `_elements_json` des workflows et presets
 * existants sont réécrits au format d'origine (aucun champ parasite).
 *
 * Ce module ne dépend ni de l'i18n ni du thème : il renvoie des CLÉS de
 * traduction, les consommateurs traduisent via le helper central t().
 */

/** Mode par défaut (hérité) : identique au comportement historique. */
export const SEED_MODE_NODE = "node";
/** Mode aléatoire : re-tiré à chaque exécution. */
export const SEED_MODE_RANDOM = "random";
/** Mode fixe : valeur propre à l'élément. */
export const SEED_MODE_FIXED = "fixed";
/** Ordre du cycle de clic : hérité → random → fixe → hérité. */
export const SEED_MODES = [SEED_MODE_NODE, SEED_MODE_RANDOM, SEED_MODE_FIXED];

/** Borne haute identique au widget `seed` de ComfyUI (0xffffffffffffffff). */
export const MAX_SEED = 18446744073709551615n;
/** 2^64 : au-delà, un Number est déjà hors bornes (comparaison sûre). */
const MAX_SEED_AS_NUMBER = Number(MAX_SEED);
/** Au-delà, un Number perd des chiffres : on garde alors la chaîne de chiffres. */
const MAX_SAFE_DIGITS = 9007199254740991n; // Number.MAX_SAFE_INTEGER

/** Icône par mode (jeu explicite : chaînon / dé / cadenas). */
const SEED_MODE_ICONS = {
    [SEED_MODE_NODE]: "🔗",
    [SEED_MODE_RANDOM]: "🎲",
    [SEED_MODE_FIXED]: "🔒",
};

/** Couleur du contrôle par mode (le cadenas reprend l'accent de la node). */
const SEED_MODE_STYLES = {
    [SEED_MODE_NODE]: "filter:grayscale(1);opacity:0.55;",
    [SEED_MODE_RANDOM]: "opacity:0.9;",
    [SEED_MODE_FIXED]: "color:var(--aih-accent, #D8700D);",
};

/**
 * Normalise un mode de seed. Toute valeur absente/inconnue → mode hérité.
 * @param {*} value
 * @returns {"node"|"random"|"fixed"}
 */
export function normalizeSeedMode(value) {
    const s = typeof value === "string" ? value.trim().toLowerCase() : "";
    return s === SEED_MODE_RANDOM || s === SEED_MODE_FIXED ? s : SEED_MODE_NODE;
}

/**
 * Mode suivant du cycle de clic (hérité → random → fixe → hérité).
 * @param {*} mode
 * @returns {"node"|"random"|"fixed"}
 */
export function nextSeedMode(mode) {
    const m = normalizeSeedMode(mode);
    const i = SEED_MODES.indexOf(m);
    return SEED_MODES[(i + 1) % SEED_MODES.length];
}

/**
 * Icône du contrôle pour un mode.
 * @param {*} mode
 * @returns {string}
 */
export function seedModeIcon(mode) {
    return SEED_MODE_ICONS[normalizeSeedMode(mode)];
}

/**
 * Clé i18n du libellé d'un mode.
 * @param {*} mode
 * @returns {string}
 */
export function seedModeTitleKey(mode) {
    const m = normalizeSeedMode(mode);
    if (m === SEED_MODE_RANDOM) return "el.seedModeRandom";
    if (m === SEED_MODE_FIXED) return "el.seedModeFixed";
    return "el.seedModeNode";
}

/**
 * Analyse une valeur de seed saisie/utilisée.
 * Accepte un entier JS, une chaîne de chiffres (éventuellement très longue,
 * au-delà de 2^53) ; borne le résultat dans [0, 2^64-1].
 * @param {*} value
 * @returns {string|null} chiffres canoniques, ou null si la valeur n'est pas
 *   un entier exploitable (utile pour valider une saisie en cours de frappe).
 */
export function parseSeedDigits(value) {
    let digits = null;
    if (typeof value === "number") {
        if (!Number.isFinite(value) || value < 0) return null;
        // Un Number >= 2^64 n'est plus exactement représentable : on borne
        // directement à la limite du widget (1e30 ne doit pas être rejeté).
        if (value >= MAX_SEED_AS_NUMBER) return MAX_SEED.toString();
        digits = String(Math.trunc(value));
    } else if (typeof value === "string") {
        const s = value.trim();
        if (!/^\d+$/.test(s)) return null;
        digits = s.replace(/^0+(?=\d)/, ""); // « 007 » → « 7 » (mais « 0 » reste « 0 »)
    } else if (typeof value === "bigint") {
        if (value < 0n) return null;
        digits = value.toString();
    } else {
        return null;
    }
    let big;
    try {
        big = BigInt(digits);
    } catch {
        return null;
    }
    if (big < 0n) return "0";
    if (big > MAX_SEED) big = MAX_SEED;
    return big.toString();
}

/**
 * Représentation stockable du seed : Number tant qu'il est exact, chaîne de
 * chiffres au-delà (JSON ne sait pas transporter un entier 64 bits sans perte).
 * @param {*} value
 * @returns {number|string}
 */
export function normalizeSeedValue(value) {
    const digits = parseSeedDigits(value);
    if (digits === null) return 0;
    const big = BigInt(digits);
    return big <= MAX_SAFE_DIGITS ? Number(big) : digits;
}

/**
 * Chiffres canoniques d'un seed (affichage dans le champ, interpolation dans le
 * hash — identique à la représentation Python `f"{seed}|…"`).
 * @param {*} value
 * @returns {string}
 */
export function seedValueDigits(value) {
    const digits = parseSeedDigits(value);
    return digits === null ? "0" : digits;
}

/**
 * Champs à PERSISTER pour un élément.
 * Le mode hérité ne produit AUCUN champ : la sérialisation des workflows et
 * presets existants reste strictement identique à l'ancien format.
 * @param {{seed_mode?:string, seed_value?:*}} element
 * @returns {{seed_mode?:string, seed_value?:number|string}}
 */
export function normalizeElementSeed(element) {
    const mode = normalizeSeedMode(element && element.seed_mode);
    if (mode === SEED_MODE_NODE) return {};
    if (mode === SEED_MODE_FIXED) {
        return { seed_mode: mode, seed_value: normalizeSeedValue(element && element.seed_value) };
    }
    return { seed_mode: mode };
}

/** Alias explicite utilisé par la sérialisation (`_elements_json`). */
export const elementSeedFields = normalizeElementSeed;

/**
 * FNV-1a 32 bits (identique à `hash32()` du widget et à `_hash32()` Python).
 * @param {string} str
 * @returns {number} entier non signé 32 bits
 */
export function hash32(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
}

/**
 * Seed de repli du mode « fixe » quand la valeur vaut 0 : dérivé du TEXTE de
 * l'élément (stable d'une exécution à l'autre, indépendant du seed de la node,
 * jamais 0 → jamais le chemin « aléatoire » des helpers).
 * @param {{text?:string}|undefined|null} element
 * @returns {number} entier >= 1
 */
export function derivedElementSeed(element) {
    const text = String((element && element.text) || "");
    return hash32(text) || 1;
}

/**
 * Seed effectif d'un élément — MIROIR de `_resolve_element_seed()` Python.
 *
 *   hérité  → le seed de la node (comportement historique, index inchangé) ;
 *   fixe    → la valeur de l'élément (0 → seed dérivé du texte) ;
 *   random  → un tirage frais, non nul (donc jamais le seed de la node).
 *
 * @param {{seed_mode?:string, seed_value?:*, text?:string}} element
 * @param {number} nodeSeed seed courant de la node
 * @returns {number|string} seed effectif (0 possible UNIQUEMENT en mode hérité)
 */
export function effectiveElementSeed(element, nodeSeed) {
    const mode = normalizeSeedMode(element && element.seed_mode);
    if (mode === SEED_MODE_FIXED) {
        const digits = seedValueDigits(element && element.seed_value);
        if (digits !== "0") {
            const big = BigInt(digits);
            return big <= MAX_SAFE_DIGITS ? Number(big) : digits;
        }
        return derivedElementSeed(element);
    }
    if (mode === SEED_MODE_RANDOM) {
        // Aperçu uniquement : la vraie exécution tire côté Python.
        return 1 + Math.floor(Math.random() * 0xfffffffe);
    }
    const seed = Number(nodeSeed);
    return Number.isFinite(seed) && seed > 0 ? seed : 0;
}

/**
 * Résout les blocs {a::b::c} d'un texte — MIROIR de `_resolve_braces()` Python
 * (`seed|element_index|bloc`). Utilisé par l'aperçu « Test generation » pour
 * que les éléments en mode fixe affichent exactement ce que produira le Run.
 * @param {string} text
 * @param {number|string} seed
 * @param {number} elementIndex
 * @returns {string}
 */
export function resolveBraceBlocks(text, seed, elementIndex) {
    if (!text) return "";
    const re = /\{([^}]+)\}/g;
    const blocks = [];
    let m;
    while ((m = re.exec(text)) !== null) {
        const choices = m[1].split("::").map((s) => s.trim()).filter(Boolean);
        if (choices.length > 0) blocks.push({ full: m[0], choices: choices });
    }
    if (blocks.length === 0) return text;

    let result = text;
    for (const block of blocks) {
        if (block.choices.length === 1) {
            result = result.replace(block.full, block.choices[0]);
            continue;
        }
        const h = hash32(`${seed}|${elementIndex}|${block.full}`);
        result = result.replace(block.full, block.choices[h % block.choices.length]);
    }
    return result;
}

/**
 * Valeur de seed fixe proposée quand on bascule en mode fixe (ou quand la
 * valeur courante est inutilisable) : entier 32 bits non nul, écrit dans le
 * champ pour que l'utilisateur voie la valeur réellement utilisée.
 * @returns {number}
 */
export function defaultFixedSeed() {
    return 1 + Math.floor(Math.random() * 0xfffffffe);
}

/**
 * Infobulle (i18n) du contrôle : libellé du mode + rappel « clic = mode
 * suivant ». Le libellé du mode fixe affiche la valeur réellement utilisée.
 * @param {*} mode
 * @param {object} element
 * @param {(key:string, params?:object)=>string} t
 * @returns {string}
 */
export function seedModeTooltip(mode, element, t) {
    const tr = typeof t === "function" ? t : (k) => k;
    const m = normalizeSeedMode(mode);
    const label = m === SEED_MODE_FIXED
        ? tr("el.seedModeFixed", { value: seedValueDigits(element && element.seed_value) })
        : tr(seedModeTitleKey(m));
    return `${label} · ${tr("el.seedCycleHint")}`;
}

/**
 * Construit le contrôle compact à 3 états d'une ligne d'élément.
 *
 * PATTERN IMPÉRATIF (voir le commentaire de renderList dans
 * js/aih_elements_widget.js) : simple `<button>` avec `onclick` direct. Les
 * gestions mousedown/pointerdown empêchent la synthèse du clic dans les DOM
 * widgets ComfyUI → ne PAS en ajouter ici.
 *
 * @param {object} opts
 * @param {Document} opts.doc document cible (jsdom en test)
 * @param {object} opts.element élément interne (seed_mode / seed_value / text)
 * @param {(key:string, params?:object)=>string} [opts.t] helper i18n
 * @param {(mode:string, digits:number|string, kind:"mode"|"value")=>void} [opts.onChange]
 * @returns {HTMLElement|null}
 */
export function createSeedControl(opts) {
    const o = opts || {};
    const doc = o.doc || (typeof document !== "undefined" ? document : null);
    if (!doc) return null;
    const tr = typeof o.t === "function" ? o.t : (k) => k;
    const element = o.element || {};
    const onChange = typeof o.onChange === "function" ? o.onChange : () => {};
    const mode = normalizeSeedMode(element.seed_mode);

    const wrap = doc.createElement("span");
    wrap.className = "aih-seed-ctl";
    wrap.style.cssText = "display:flex;align-items:center;gap:2px;flex-shrink:0;";

    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "aih-seed-mode";
    btn.dataset.seedMode = mode;
    btn.textContent = seedModeIcon(mode);
    btn.title = seedModeTooltip(mode, element, tr);
    btn.setAttribute("aria-label", tr(seedModeTitleKey(mode)));
    btn.style.cssText =
        "background:none;border:none;cursor:pointer;font-size:12px;line-height:1;" +
        "padding:0 2px;flex-shrink:0;" + (SEED_MODE_STYLES[mode] || "");
    btn.onclick = () => {
        const next = nextSeedMode(mode);
        // Bascule vers « fixe » : proposer une valeur visible si aucune valeur
        // exploitable n'existe (jamais de champ vide ni de valeur magique).
        const value = next === SEED_MODE_FIXED
            ? (seedValueDigits(element.seed_value) !== "0"
                ? normalizeSeedValue(element.seed_value)
                : defaultFixedSeed())
            : undefined;
        onChange(next, value, "mode");
    };
    wrap.appendChild(btn);

    // Saisie de la valeur : révélée UNIQUEMENT en mode fixe (pas de modale).
    if (mode === SEED_MODE_FIXED) {
        const input = doc.createElement("input");
        input.type = "text";
        input.inputMode = "numeric";
        input.className = "aih-seed-value";
        input.value = seedValueDigits(element.seed_value);
        input.title = tr("el.seedFixedTitle");
        input.placeholder = tr("el.seedFixedPlaceholder");
        input.style.cssText =
            "width:74px;min-width:0;background:#1a1a1e;border:1px solid #444;color:#ccc;" +
            "border-radius:3px;padding:1px 4px;font-size:10px;text-align:center;";
        // Saisie en cours : on ne persiste QUE les entiers valides (aucune valeur
        // parasite), et on signale visuellement le refus (bordure rouge).
        input.oninput = () => {
            const digits = parseSeedDigits(input.value);
            if (digits === null) {
                input.style.borderColor = "#f87171";
                // Message d'aide i18n : aucune valeur parasite n'est persistée
                // tant que la saisie n'est pas un entier valide.
                input.title = tr("el.seedFixedInvalid");
                input.setAttribute("aria-invalid", "true");
                return;
            }
            input.style.borderColor = "#444";
            input.title = tr("el.seedFixedTitle");
            input.removeAttribute("aria-invalid");
            onChange(mode, normalizeSeedValue(digits), "value");
            // Le titre du bouton affiche la valeur réellement utilisée : on le
            // rafraîchit sans re-rendre la ligne (le focus reste dans le champ).
            btn.title = seedModeTooltip(mode, element, tr);
        };
        // Fin de saisie : on réécrit la valeur canonique (borne + nettoyage).
        input.onchange = () => {
            const digits = parseSeedDigits(input.value);
            input.value = digits === null ? seedValueDigits(element.seed_value) : digits;
            input.style.borderColor = "#444";
            input.title = tr("el.seedFixedTitle");
            input.removeAttribute("aria-invalid");
            onChange(mode, normalizeSeedValue(input.value), "value");
            btn.title = seedModeTooltip(mode, element, tr);
        };
        wrap.appendChild(input);
    }

    return wrap;
}
