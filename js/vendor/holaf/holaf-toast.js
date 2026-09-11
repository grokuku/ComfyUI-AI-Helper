/* ═══════════════════════════════════════════════════════════════════════════
 * Holaf UI — Brique HolafToast · version 0.5.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Notifications flottantes (toasts) autonomes, zéro dépendance runtime :
 * 4 types (info/success/warning/error) avec icône, empilement par position
 * (6 positions, conteneur créé à la demande, max 5 visibles), auto-dismiss
 * avec barre de progression animée en temps réel, PAUSE au survol (timer ET
 * barre), bouton ✕, actions cliquables, aria-live (polite / assertive pour
 * error), mobile pleine largeur en bas, prefers-reduced-motion respecté.
 *
 * v0.5.0 — position CONFIGURABLE : configure({ position }) accepte les 6
 * presets (top/right/center/left × top/bottom). En valeur inconnue (ou absente)
 * on rebat SÛREMENT sur top-right (défaut historique). Empilement adapté à la
 * position : pour les positions bottom-*, le toast le plus RÉCENT reste collé
 * au bord bas (la pile grimpe vers le haut), quel que soit newestFirst (un
 * prepend placerait le plus récent en HAUT, à l'opposé du bord). Animations
 * d'entrée/sortie PAR POSITION (slide depuis le côté du bord auquel colle le
 * conteneur, sortie en fondu du même côté) — keyframes homonymes conservés
 * comme base (top-center), variantes ajoutées (right/left/up/down), toujours
 * sans fill-mode d'entrée (le to{opacity:1} garantit l'état final).
 * Rétrocompatible : sans configuration, comportement historique identique.
 *
 * v0.4.0 — fond teinté PAR TYPE (info/success/warning/error) avec fallback :
 * nouvelles variables de thème OPTIONNELLES --ht-bg-info, --ht-bg-success,
 * --ht-bg-warning, --ht-bg-error. Chaque type a sa règle CSS, ex. :
 *   .holaf-toast--success { background: var(--ht-bg-success, var(--ht-bg)); }
 * Var de type absente (thèmes existants, hôtes anciens) → fond global
 * --ht-bg (rétrocompatibilité totale) ; --ht-bg posé en inline (override par
 * toast) l'emporte dans la chaîne de fallback ; --ht-bg-<type> posé en inline
 * (par toast ou via theme.vars) gagne sur tout. Les presets dark/light/
 * midnight/slate définissent des teintes harmonisées (~15 % de l'accent du
 * type mélangé dans --ht-bg, hex calculés à la main) pour success/warning/
 * error ; le type info reste neutre (aucune var --ht-bg-info dans les
 * presets). Rétrocompatible.
 *
 * v0.2.1 — correction barre de progression : elle reste désormais ANIMÉE en
 * temps réel (la durée est calée sur le timer d'auto-dismiss), au lieu d'un
 * scaleX figé qui n'avançait jamais. Pause au survol via animation-play-state
 * (classe paused) au lieu d'un scaleX inline. Rétrocompatible.
 *
 * v0.2.0 — thèmes (registre + presets dark/light/midnight/slate, miroir de
 * HolafModal), positions alternatives (top/bottom-center), configure() pour
 * les défauts globaux (position, durée, thème). Rétrocompatible : sans
 * configuration, le comportement historique est strictement inchangé.
 *
 * Fichier DUAL : module ES (export) + global window.HolafToast — se
 * charge via <script type="module"> ou `import { HolafToast }`.
 *
 * Bonnes idées piquées à ComfyCH (web/modal_gateway.js, section toasts) :
 * conteneur fixe par zone créé une seule fois, entrée animée (slide-in),
 * sortie en fondu (fade-out), empilement vertical simple sans dépendance.
 * ═════════════════════════════════════════════════════════════════════════ */

const HolafToast = (function () {
    "use strict";

    const VERSION = "0.5.0";

    // ─── Constantes du module ────────────────────────────────────────────────
    const CSS_ID = "holaf-toast-style";
    const MAX_VISIBLE = 5; // nb max de toasts visibles par position
    const DEFAULT_DURATION = 4000; // ms ; 0 = persistant
    const VALID_TYPES = ["info", "success", "warning", "error"];
    const VALID_POSITIONS = [
        "top-right", "top-left", "bottom-right", "bottom-left",
        "top-center", "bottom-center",
    ];
    // Icônes par type (texte simple, aucune dépendance à une fonte d'icônes).
    const ICONS = { info: "ℹ", success: "✓", warning: "⚠", error: "✕" };

    // Conteneurs par position, créés paresseusement une seule fois.
    // { "top-right": { el, toasts: [ { el, timer, remaining, start, close, ... } ] } }
    const containers = {};

    // Registre id métier → toast (v0.3.0) : show({ id }) / update(id) / hide(id).
    // Un toast vivant portant déjà cet id est MIS À JOUR au lieu d'en créer un
    // nouveau. Le registre est nettoyé à la fermeture du toast.
    const idRegistry = Object.create(null);

    function str(v, fallback) {
        return v === undefined || v === null ? (fallback || "") : String(v);
    }

    // ─── Bibliothèque de thèmes ───────────────────────────────────────────────
    // Un thème = un objet de variables CSS --ht-* (les mêmes clés que l'option
    // `theme` de show()). Registre en mémoire + préréglages génériques
    // enregistrés au chargement (dark / light / midnight / slate). Palettes
    // volontairement NEUTRES : aucune couleur de projet en dur — la brique sert
    // plusieurs projets, qui peuvent aussi déclarer leurs thèmes via
    // HolafToast.themes.register. Miroir de la philosophie de HolafModal.
    const themeRegistry = Object.create(null);

    // Noms de thèmes inconnus DÉJÀ avertis : chaque nom inconnu ne déclenche
    // qu'UN SEUL console.warn, même si la résolution échoue à chaque show().
    // Le Set est réinitialisé quand le nom redevient valide (themes.register)
    // ou par clearTheme().
    const warnedUnknownThemes = new Set();

    // Avertit pour un nom de thème inconnu — une seule fois par nom.
    function warnUnknownThemeOnce(name, message) {
        if (warnedUnknownThemes.has(name)) return;
        warnedUnknownThemes.add(name);
        console.warn(message);
    }

    // Ne conserve que les clés commençant par « -- » ; valeurs stringifiées.
    function filterVars(vars) {
        const out = {};
        if (!vars || typeof vars !== "object") return out;
        Object.keys(vars).forEach((k) => {
            if (k.indexOf("--") === 0) out[k] = String(vars[k]);
        });
        return out;
    }

    // Applique des surcharges de variables CSS (--ht-*) sur un élément.
    function applyVars(el, vars) {
        if (!vars) return;
        Object.keys(vars).forEach((k) => {
            if (k.indexOf("--") === 0) el.style.setProperty(k, String(vars[k]));
        });
    }

    // Enregistre (ou REMPLACE) un thème. Retourne une COPIE protégée (comme
    // themes.get) : muter le retour ne corrompt pas le registre.
    function themesRegister(name, vars) {
        if (typeof name !== "string" || !name.trim()) {
            console.error("[HolafToast] themes.register : nom de thème invalide (chaîne non vide attendue).");
            return null;
        }
        themeRegistry[name] = filterVars(vars);
        warnedUnknownThemes.delete(name); // redevient valide → on oublie l'avertissement émis
        return Object.assign({}, themeRegistry[name]);
    }

    // Copie des variables du thème (le registre est protégé des mutations), null si inconnu.
    function themesGet(name) {
        const t = themeRegistry[name];
        return t ? Object.assign({}, t) : null;
    }

    // Met à jour / FUSIONNE les variables d'un thème enregistré (v0.3.0).
    // Utile pour un hôte qui recalcule ses vars (ex. thème dynamique). Les
    // clés fournies écrasent celles du thème existant ; les autres restent.
    // Si le thème n'existe pas, il est enregistré (avec un avertissement).
    // Retourne une copie protégée du thème résultant.
    function themesUpdate(name, vars) {
        if (typeof name !== "string" || !name.trim()) {
            console.error("[HolafToast] themes.update : nom de thème invalide (chaîne non vide attendue).");
            return null;
        }
        const existing = themeRegistry[name];
        if (!existing) {
            console.warn('[HolafToast] themes.update : thème inconnu "' + name + '" — enregistré à la place.');
            return themesRegister(name, vars);
        }
        const merged = Object.assign({}, existing, filterVars(vars));
        themeRegistry[name] = merged;
        warnedUnknownThemes.delete(name);
        return Object.assign({}, merged);
    }

    // Noms des thèmes enregistrés (préréglages + customs).
    function themesList() {
        return Object.keys(themeRegistry);
    }

    // Résout une spécification de thème — option `theme` de show() OU argument
    // de setTheme — en objet de variables prêt pour applyVars :
    //   - null/undefined/"" → aucun thème, SANS warning (opt-out silencieux) ;
    //   - string           → nom d'un thème enregistré (warn si inconnu) ;
    //   - objet --ht-*     → utilisé tel quel (comportement historique) ;
    //   - { preset, vars } → thème enregistré + surcharges (vars gagnent sur le
    //                        preset, qui gagne sur les défauts de la brique).
    //                        Les clés --ht-* posées à la RACINE du spec (à côté
    //                        de preset) sont fusionnées dans les surcharges ; en
    //                        cas de doublon, vars (champ officiel) garde la
    //                        priorité.
    function resolveThemeVars(spec) {
        if (spec === null || spec === undefined || spec === "") return null;
        let base = null;
        let overrides = null;
        if (typeof spec === "string") {
            base = themesGet(spec);
            if (!base) {
                warnUnknownThemeOnce(
                    spec,
                    '[HolafToast] thème inconnu : "' + spec + '" — thèmes disponibles : ' +
                    (themesList().join(", ") || "(aucun)")
                );
                return null; // repli gracieux : défauts CSS
            }
        } else if (spec && typeof spec === "object") {
            if (typeof spec.preset === "string") {
                base = themesGet(spec.preset);
                if (!base) {
                    console.warn(
                        '[HolafToast] thème prédéfini inconnu : "' + spec.preset +
                        '" — thèmes disponibles : ' + (themesList().join(", ") || "(aucun)")
                    );
                    // pas de base : on continue avec les seules surcharges
                }
                const rootVars = filterVars(spec);
                overrides = (spec.vars && typeof spec.vars === "object")
                    ? Object.assign(rootVars, spec.vars)
                    : (Object.keys(rootVars).length > 0 ? rootVars : null);
            } else {
                return spec; // objet de variables brut — comportement historique
            }
        } else {
            return null; // valeur exotique (nombre, booléen…) : aucun thème
        }
        if (!base) return overrides ? filterVars(overrides) : null;
        if (!overrides) return base;
        return Object.assign(base, overrides); // base = copie → fusion sûre
    }

    // ─── Préréglages génériques (enregistrés au chargement de la brique) ────
    // Contraste des textes ≥ 4.5:1. PAS de --ht-width dans un preset : la
    // largeur reste gouvernée par la brique (un thème ne doit pas pouvoir
    // casser le responsive mobile).
    // v0.4.0 : chaque preset définit aussi des fonds teintés PAR TYPE
    // (--ht-bg-success/warning/error : ~15 % de l'accent du type mélangé dans
    // --ht-bg, hex calculés à la main — pas de color-mix(), compat maximum).
    // PAS de --ht-bg-info : le type info reste neutre (fond --ht-bg via le
    // fallback du CSS). SANS thème, les défauts CSS restent sans teinte.
    // dark : reprend les valeurs par défaut du CSS injecté pour les vars
    // communes (theme:"dark" ≡ défauts historiques) — il y ajoute les teintes
    // par type ci-dessous.
    themesRegister("dark", {
        "--ht-bg": "#2b2b2b",
        "--ht-bg-success": "#303f35",
        "--ht-bg-warning": "#463d2c",
        "--ht-bg-error": "#463131",
        "--ht-fg": "#f0f0f0",
        "--ht-border": "#4a4a4a",
        "--ht-accent-info": "#4aa3ff",
        "--ht-accent-success": "#4caf6d",
        "--ht-accent-warning": "#e0a030",
        "--ht-accent-error": "#e05555",
        "--ht-shadow": "0 6px 24px rgba(0, 0, 0, 0.35)",
        "--ht-radius": "10px",
    });
    // light : clair zinc, accents plus foncés pour garder le contraste ≥ 4.5:1.
    themesRegister("light", {
        "--ht-bg": "#ffffff",
        "--ht-bg-success": "#dcece2",
        "--ht-bg-warning": "#f4e5da",
        "--ht-bg-error": "#fadede",
        "--ht-fg": "#18181b",
        "--ht-border": "#d4d4d8",
        "--ht-accent-info": "#2563eb",
        "--ht-accent-success": "#15803d",
        "--ht-accent-warning": "#b45309",
        "--ht-accent-error": "#dc2626",
        "--ht-shadow": "0 6px 24px rgba(24, 24, 27, 0.18)",
        "--ht-radius": "10px",
    });
    // midnight : bleu nuit profond « layered », accents doux et lumineux.
    themesRegister("midnight", {
        "--ht-bg": "#10111d",
        "--ht-bg-success": "#152e30",
        "--ht-bg-warning": "#332b1e",
        "--ht-bg-error": "#331f2a",
        "--ht-fg": "#e2e4f0",
        "--ht-border": "#272a44",
        "--ht-accent-info": "#60a5fa",
        "--ht-accent-success": "#34d399",
        "--ht-accent-warning": "#fbbf24",
        "--ht-accent-error": "#f87171",
        "--ht-shadow": "0 6px 24px rgba(0, 0, 0, 0.6)",
        "--ht-radius": "10px",
    });
    // slate : gris ardoise neutre, accents gris-bleu doux — le plus polyvalent.
    themesRegister("slate", {
        "--ht-bg": "#1f232b",
        "--ht-bg-success": "#2b4040",
        "--ht-bg-warning": "#403d30",
        "--ht-bg-error": "#40373d",
        "--ht-fg": "#e6e9ee",
        "--ht-border": "#3a4150",
        "--ht-accent-info": "#93c5fd",
        "--ht-accent-success": "#6ee7b7",
        "--ht-accent-warning": "#fcd34d",
        "--ht-accent-error": "#fca5a5",
        "--ht-shadow": "0 6px 24px rgba(0, 0, 0, 0.5)",
        "--ht-radius": "10px",
    });

    // ─── Thème global par défaut (VOLATIL — aucune persistance) ─────────────
    // HolafToast.setTheme(...) s'applique à tous les toasts qui ne passent PAS
    // d'option `theme` à show(). Résolution : show.theme (string | objet |
    // { preset, vars }) > setTheme > défauts CSS. Chaque projet le règle une
    // fois à l'init ; rien n'est écrit en localStorage.
    let globalThemeSpec = null;

    function setTheme(spec) {
        if (spec === null || spec === undefined) {
            globalThemeSpec = null;
            return;
        }
        if (typeof spec === "string") {
            if (!themeRegistry[spec]) {
                warnUnknownThemeOnce(
                    spec,
                    '[HolafToast] setTheme : thème inconnu "' + spec + '" — thèmes disponibles : ' +
                    (themesList().join(", ") || "(aucun)") +
                    " (enregistrable via HolafToast.themes.register)"
                );
            }
            globalThemeSpec = spec;
            return;
        }
        if (typeof spec !== "object") {
            console.error("[HolafToast] setTheme : attendu un nom de thème, un objet --ht-* ou { preset, vars }.");
            return;
        }
        const copy = Object.assign({}, spec);
        if (spec.vars && typeof spec.vars === "object") copy.vars = Object.assign({}, spec.vars);
        globalThemeSpec = copy;
    }

    function clearTheme() {
        globalThemeSpec = null;
        warnedUnknownThemes.clear(); // contexte global effacé → on re-avertira au besoin
    }

    // ─── Défauts globaux (configure) ─────────────────────────────────────────
    // Valeurs par défaut historiques : position top-right, durée 4000 ms,
    // aucun thème. configure() les remplace pour TOUS les toasts qui ne
    // passent pas d'option explicite. Volatil, en mémoire uniquement.
    let defaultPosition = "top-right";
    let defaultDuration = DEFAULT_DURATION;
    // v0.3.0 : si true, les nouveaux toasts s'insèrent EN PREMIER dans le
    // conteneur (prepend) au lieu d'ajouter à la fin (append, défaut historique).
    let newestFirst = false;

    function configure(opts) {
        opts = opts || {};
        if (opts.position !== undefined) {
            if (VALID_POSITIONS.indexOf(opts.position) >= 0) {
                defaultPosition = opts.position;
            } else {
                // v0.5.0 : position inconnue → repli SÛR sur top-right (défaut
                // historique), au lieu de conserver un éventuel défaut précédent.
                console.warn(
                    '[HolafToast] configure : position inconnue "' + opts.position +
                    '" — repli sur "top-right" ; positions disponibles : ' +
                    VALID_POSITIONS.join(", ")
                );
                defaultPosition = "top-right";
            }
        }
        if (opts.duration !== undefined) {
            defaultDuration = Math.max(0, Number(opts.duration) || 0);
        }
        if (opts.theme !== undefined) {
            setTheme(opts.theme);
        }
        if (opts.newestFirst !== undefined) {
            newestFirst = !!opts.newestFirst;
        }
    }

    // ─── CSS auto-injecté (une seule fois) ───────────────────────────────────
    // Classes scoppées .holaf-toast-* ; variables --ht-* déclarées sur la
    // RACINE du conteneur (.holaf-toast-container), jamais sur :root, pour
    // ne rien imposer au document hôte et permettre la surcharge par brique.
    const CSS_TEXT = `
.holaf-toast-container {
    position: fixed;
    z-index: 200000;
    display: flex;
    flex-direction: column;
    gap: 10px;
    pointer-events: none;
    max-width: calc(100vw - 24px);
    --ht-bg: #2b2b2b;
    --ht-fg: #f0f0f0;
    --ht-border: #4a4a4a;
    --ht-accent-info: #4aa3ff;
    --ht-accent-success: #4caf6d;
    --ht-accent-warning: #e0a030;
    --ht-accent-error: #e05555;
    --ht-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
    --ht-radius: 10px;
    --ht-width: 340px;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}
.holaf-toast-container--top-right    { top: 16px; right: 16px; align-items: flex-end; }
.holaf-toast-container--top-left     { top: 16px; left: 16px; align-items: flex-start; }
.holaf-toast-container--bottom-right { bottom: 16px; right: 16px; align-items: flex-end; }
.holaf-toast-container--bottom-left  { bottom: 16px; left: 16px; align-items: flex-start; }
.holaf-toast-container--top-center   { top: 16px; left: 50%; transform: translateX(-50%); align-items: center; }
.holaf-toast-container--bottom-center { bottom: 16px; left: 50%; transform: translateX(-50%); align-items: center; }

.holaf-toast {
    pointer-events: auto;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: var(--ht-width);
    max-width: 100%;
    padding: 12px 14px;
    background: var(--ht-bg);
    color: var(--ht-fg);
    border: 1px solid var(--ht-border);
    border-left: 4px solid var(--ht-accent, var(--ht-accent-info));
    border-radius: var(--ht-radius);
    box-shadow: var(--ht-shadow);
    position: relative;
    overflow: hidden;
    cursor: default;
    animation: holaf-toast-slide-in 0.25s ease-out;
}
/* v0.5.0 : animation d'entrée ADAPTÉE à la position — le slide part du côté
 * du bord auquel colle le conteneur. La règle de base .holaf-toast garde
 * holaf-toast-slide-in (glisse DEPUIS le haut, couvre top-center) ; les
 * variantes ci-dessous ne surchargent que les autres positions (même nom de
 * keyframe homonyme conservé comme base). PAS de fill-mode d'entrée : la cible
 * to du keyframe (opacity:1 + transform) garantit l'état final (bug
 * historique évité — sans fill-mode, un toast interrompu retombait opacity:0). */
.holaf-toast-container--top-right .holaf-toast,
.holaf-toast-container--bottom-right .holaf-toast { animation: holaf-toast-slide-in-right 0.25s ease-out; }
.holaf-toast-container--top-left .holaf-toast,
.holaf-toast-container--bottom-left .holaf-toast { animation: holaf-toast-slide-in-left 0.25s ease-out; }
.holaf-toast-container--bottom-center .holaf-toast { animation: holaf-toast-slide-in-up 0.25s ease-out; }
/* v0.4.0 : fond teinté PAR TYPE avec fallback rétro-compatible. La règle de
 * base ci-dessus pose background:var(--ht-bg) ; chaque type la raffine avec
 * SA var optionnelle : si --ht-bg-<type> n'est pas définie (thèmes existants,
 * hôtes anciens), le fond global --ht-bg s'applique. La substitution des
 * custom properties se fait sur l'élément lui-même : un --ht-bg posé en
 * inline (override par toast) l'emporte dans la chaîne de fallback, et un
 * --ht-bg-<type> en inline (par toast ou via theme.vars) gagne sur tout. */
.holaf-toast--info    { --ht-accent: var(--ht-accent-info);    background: var(--ht-bg-info, var(--ht-bg)); }
.holaf-toast--success { --ht-accent: var(--ht-accent-success); background: var(--ht-bg-success, var(--ht-bg)); }
.holaf-toast--warning { --ht-accent: var(--ht-accent-warning); background: var(--ht-bg-warning, var(--ht-bg)); }
.holaf-toast--error   { --ht-accent: var(--ht-accent-error);   background: var(--ht-bg-error, var(--ht-bg)); }

.holaf-toast--closing {
    animation: holaf-toast-fade-out 0.2s ease-in forwards;
}
/* v0.5.0 : sortie en fondu ADAPTÉE à la position — le toast part du même côté
 * que son entrée. Base holaf-toast-fade-out (vers le haut, top-center) ;
 * variantes pour les autres positions. forwards conservé (état final tenu). */
.holaf-toast-container--top-right .holaf-toast--closing,
.holaf-toast-container--bottom-right .holaf-toast--closing { animation: holaf-toast-fade-out-right 0.2s ease-in forwards; }
.holaf-toast-container--top-left .holaf-toast--closing,
.holaf-toast-container--bottom-left .holaf-toast--closing { animation: holaf-toast-fade-out-left 0.2s ease-in forwards; }
.holaf-toast-container--bottom-center .holaf-toast--closing { animation: holaf-toast-fade-out-down 0.2s ease-in forwards; }

.holaf-toast__icon {
    flex: none;
    font-weight: 700;
    color: var(--ht-accent);
    line-height: 1.4;
}
.holaf-toast__body { flex: 1 1 auto; min-width: 0; }
.holaf-toast__title {
    font-weight: 650;
    margin-bottom: 2px;
    font-size: 14px;
}
.holaf-toast__message {
    font-size: 13px;
    line-height: 1.45;
    overflow-wrap: break-word;
}
.holaf-toast__actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
    flex-wrap: wrap;
}
.holaf-toast__action {
    font: inherit;
    font-size: 12px;
    padding: 4px 10px;
    border-radius: 6px;
    border: 1px solid var(--ht-border);
    background: transparent;
    color: var(--ht-fg);
    cursor: pointer;
}
.holaf-toast__action:hover { border-color: var(--ht-accent); color: var(--ht-accent); }

.holaf-toast__close {
    flex: none;
    border: none;
    background: transparent;
    color: var(--ht-fg);
    font-size: 14px;
    line-height: 1;
    padding: 2px 4px;
    cursor: pointer;
    opacity: 0.7;
}
.holaf-toast__close:hover { opacity: 1; }

.holaf-toast__progress {
    position: absolute;
    left: 0;
    bottom: 0;
    height: 3px;
    width: 100%;
    background: var(--ht-accent);
    transform-origin: left center;
    transform: scaleX(1);
    opacity: 0.85;
    /* Barre ANIMÉE en temps réel : la durée est posée inline (ms) par le JS,
     * la barre part pleine (scaleX(1)) et se vide (scaleX(0)) en duration.
     * animation gère le nom + la courbe temporelle ; la durée vient du style
     * inline (prioritaire) pour rester synchro avec le timer d'auto-dismiss. */
    animation: holaf-toast-progress linear;
}
/* Au survol, on gèle la barre à sa position courante via play-state:paused
 * (l'animation CSS se met naturellement en pause, contrairement à l'ancien
 * scaleX inline figé — temps de barre et timer restant restent synchrones). */
.holaf-toast__progress--paused {
    animation-play-state: paused;
}
/* Progression MANUELLE (v0.3.0) : show({ progress: 'manual' }) → barre visible
 * (largeur 0) pilotée par update({ progress: 0-100 }) ; pas d'animation, pas
 * de timer de fermeture auto. La largeur est posée inline (N%). */
.holaf-toast__progress--manual {
    animation: none;
    transform: none;
    width: 0%;
}
@keyframes holaf-toast-progress {
    from { transform: scaleX(1); }
    to   { transform: scaleX(0); }
}

/* Animations (désactivées si prefers-reduced-motion). */
/* prefers-reduced-motion : la barre reste VISIBLE mais statique (pleine, sans
 * animation) — le timer en JS ferme toujours le toast ; seule l'illusion de
 * mouvements est supprimée. On garde un repère visuel stable et non animé. */
@keyframes holaf-toast-slide-in {
    from { opacity: 0; transform: translateY(-10px); }
    to   { opacity: 1; transform: translateY(0); }
}
/* v0.5.0 : variantes d'entrée par position (homonyme de base conservé). */
@keyframes holaf-toast-slide-in-right {
    from { opacity: 0; transform: translateX(24px); }
    to   { opacity: 1; transform: translateX(0); }
}
@keyframes holaf-toast-slide-in-left {
    from { opacity: 0; transform: translateX(-24px); }
    to   { opacity: 1; transform: translateX(0); }
}
@keyframes holaf-toast-slide-in-up {
    from { opacity: 0; transform: translateY(14px); }
    to   { opacity: 1; transform: translateY(0); }
}
@keyframes holaf-toast-fade-out {
    from { opacity: 1; }
    to   { opacity: 0; transform: translateY(-6px); }
}
/* v0.5.0 : variantes de sortie par position (homonyme de base conservé). */
@keyframes holaf-toast-fade-out-right {
    from { opacity: 1; }
    to   { opacity: 0; transform: translateX(24px); }
}
@keyframes holaf-toast-fade-out-left {
    from { opacity: 1; }
    to   { opacity: 0; transform: translateX(-24px); }
}
@keyframes holaf-toast-fade-out-down {
    from { opacity: 1; }
    to   { opacity: 0; transform: translateY(8px); }
}
@media (prefers-reduced-motion: reduce) {
    .holaf-toast, .holaf-toast--closing { animation: none; }
    .holaf-toast__progress { animation: none; }
}

/* Mobile : pleine largeur en bas (les 6 positions convergent). */
@media (max-width: 600px) {
    .holaf-toast-container {
        left: 8px !important;
        right: 8px !important;
        top: auto !important;
        bottom: 8px !important;
        transform: none !important;
        align-items: stretch;
        --ht-width: 100%;
    }
}
`;

    function ensureStyle() {
        if (typeof document === "undefined") return;
        if (document.getElementById(CSS_ID)) return;
        const style = document.createElement("style");
        style.id = CSS_ID;
        style.textContent = CSS_TEXT;
        document.head.appendChild(style);
    }

    // ─── Conteneurs par position ─────────────────────────────────────────────
    function getContainer(position) {
        const pos = VALID_POSITIONS.indexOf(position) >= 0 ? position : "top-right";
        if (containers[pos]) {
            const c = containers[pos];
            // Le conteneur a pu être retiré du DOM depuis (page rechargée,
            // tests, vidage de body) : on purge les toasts orphelins AVANT
            // de rattacher (sinon ils redeviennent connectés avec lui).
            if (!c.el.isConnected) {
                c.toasts = c.toasts.filter((t) => {
                    if (t.el.isConnected) return true;
                    t.closed = true;
                    if (t.el.parentNode) t.el.parentNode.removeChild(t.el);
                    return false;
                });
                // Filet de sécurité : un toast fermé mais jamais retiré (timer
                // de fin d'animation perdu) ne doit pas réapparaître.
                const kept = new Set(c.toasts.map((t) => t.el));
                Array.from(c.el.querySelectorAll(".holaf-toast")).forEach((el) => {
                    if (!kept.has(el)) c.el.removeChild(el);
                });
                document.body.appendChild(c.el);
            }
            return c;
        }
        const el = document.createElement("div");
        el.className = "holaf-toast-container holaf-toast-container--" + pos;
        // Les conteneurs vivent à la fin du body pour rester au-dessus.
        document.body.appendChild(el);
        containers[pos] = { el, toasts: [] };
        return containers[pos];
    }

    function removeContainerIfEmpty(pos) {
        const c = containers[pos];
        if (c && c.toasts.length === 0 && c.el.parentNode) {
            c.el.parentNode.removeChild(c.el);
            delete containers[pos];
        }
    }

    // v0.5.0 : une position « bas de l'écran » (bottom-*) a son bord de
    // référence EN BAS. L'insertion (et donc l'empilement) en dépend : le toast
    // le plus récent doit rester collé au bord bas, la pile grimpe vers le haut.
    function isBottomPosition(pos) {
        return pos.indexOf("bottom") === 0;
    }

    // ─── Cœur : show() ───────────────────────────────────────────────────────
    function show(opts) {
        opts = opts || {};
        if (typeof document === "undefined") {
            throw new Error("[HolafToast] DOM requis (show() appelé hors navigateur).");
        }
        ensureStyle();

        // ── id métier (v0.3.0) : un toast vivant portant déjà cet id est MIS
        // À JOUR au lieu d'en créer un nouveau. Retourne le contrôleur existant.
        if (typeof opts.id === "string" && opts.id) {
            const existing = idRegistry[opts.id];
            if (existing && !existing.closed) {
                existing.ctrl.update({
                    message: opts.message,
                    title: opts.title,
                    type: opts.type,
                    html: opts.html,
                });
                return existing.ctrl;
            }
        }

        const type = VALID_TYPES.indexOf(opts.type) >= 0 ? opts.type : "info";
        const position = VALID_POSITIONS.indexOf(opts.position) >= 0
            ? opts.position
            : (VALID_POSITIONS.indexOf(defaultPosition) >= 0 ? defaultPosition : "top-right");
        const duration = opts.duration === undefined ? defaultDuration : Math.max(0, Number(opts.duration) || 0);
        const closeOnClick = !!opts.closeOnClick;
        const onShow = typeof opts.onShow === "function" ? opts.onShow : null;
        const onClose = typeof opts.onClose === "function" ? opts.onClose : null;

        const container = getContainer(position);

        // ── Élément ──
        const el = document.createElement("div");
        el.className = "holaf-toast holaf-toast--" + type;
        el.setAttribute("role", type === "error" ? "alert" : "status");
        el.setAttribute("aria-live", type === "error" ? "assertive" : "polite");

        // ── Thème de CETTE instance ──
        // Résolution : show.theme (string | objet --ht-* | { preset, vars })
        //   > thème global (setTheme / configure.theme) > défauts CSS.
        // `theme: null` (ou "") : aucun thème pour ce toast, même si un thème
        // global est posé (opt-out explicite).
        let themeSpec = opts.theme;
        if (themeSpec === undefined) themeSpec = globalThemeSpec;
        const themeVars = resolveThemeVars(themeSpec);
        if (themeVars) applyVars(el, themeVars);

        const iconEl = document.createElement("span");
        iconEl.className = "holaf-toast__icon";
        iconEl.setAttribute("aria-hidden", "true");
        iconEl.textContent = ICONS[type];
        el.appendChild(iconEl);

        const bodyEl = document.createElement("div");
        bodyEl.className = "holaf-toast__body";
        el.appendChild(bodyEl);

        let titleEl = null;
        if (opts.title) {
            titleEl = document.createElement("div");
            titleEl.className = "holaf-toast__title";
            titleEl.textContent = str(opts.title);
            bodyEl.appendChild(titleEl);
        }

        const messageEl = document.createElement("div");
        messageEl.className = "holaf-toast__message";
        // v0.3.0 : html:true → innerHTML (contenu de confiance) ; défaut textContent.
        if (opts.html) messageEl.innerHTML = str(opts.message);
        else messageEl.textContent = str(opts.message);
        bodyEl.appendChild(messageEl);

        // ── Actions ──
        const actionsEl = document.createElement("div");
        actionsEl.className = "holaf-toast__actions";
        let hasActions = false;
        (Array.isArray(opts.actions) ? opts.actions : []).forEach((a) => {
            if (!a || typeof a.label === "undefined") return;
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "holaf-toast__action";
            btn.textContent = str(a.label);
            btn.addEventListener("click", (ev) => {
                ev.stopPropagation();
                if (typeof a.onClick === "function") a.onClick(ctrl);
                if (a.close !== false) close("click"); // close:true par défaut
            });
            actionsEl.appendChild(btn);
            hasActions = true;
        });
        if (hasActions) bodyEl.appendChild(actionsEl);

        // ── Bouton ✕ ──
        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "holaf-toast__close";
        closeBtn.setAttribute("aria-label", "Fermer la notification");
        closeBtn.textContent = "✕";
        closeBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            close("click");
        });
        el.appendChild(closeBtn);

        // ── Barre de progression ──
        // Mode TEMPOREL (défaut) : animation CSS pilotée par le temps, la barre
        // se vide de scaleX(1) → scaleX(0) sur `duration` ; duration 0 = pas de
        // barre. Mode MANUEL (v0.3.0, progress:'manual') : barre VISIBLE (largeur
        // 0) même avec duration:0, pilotée par update({ progress: 0-100 }), et
        // AUCUN timer de fermeture auto.
        const manualProgress = opts.progress === "manual";
        let progressEl = null;
        if (duration > 0 || manualProgress) {
            progressEl = document.createElement("div");
            progressEl.className = "holaf-toast__progress" + (manualProgress ? " holaf-toast__progress--manual" : "");
            if (manualProgress) progressEl.style.width = "0%";
            else progressEl.style.animationDuration = duration + "ms";
            el.appendChild(progressEl);
        }

        // ── Timer d'auto-dismiss avec pause au survol ──
        // On gère nous-mêmes le temps restant (remaining) plutôt qu'une
        // animation CSS seule : au survol on annule le timer ET on gèle la
        // barre (classe paused → animation-play-state, position conservée),
        // au départ on réarme pour le reste et on relance l'animation.
        const toast = { el, timer: null, remaining: duration, startedAt: 0, closed: false, manualProgress };

        function clearTimer() {
            if (toast.timer !== null) {
                clearTimeout(toast.timer);
                toast.timer = null;
            }
        }

        function armTimer() {
            // Mode manuel : PAS de timer de fermeture auto.
            if (toast.manualProgress || duration <= 0 || toast.closed) return;
            toast.startedAt = Date.now();
            toast.timer = setTimeout(() => close("timeout"), toast.remaining);
        }

        function pause() {
            if (duration <= 0 || toast.closed || toast.timer === null) return;
            clearTimer();
            toast.remaining -= Date.now() - toast.startedAt;
            if (toast.remaining < 0) toast.remaining = 0;
            // Gel de la barre à sa position courante (l'animation reprend au
            // même point au mouseleave, en synchro avec le timer ré-armé).
            if (progressEl) progressEl.classList.add("holaf-toast__progress--paused");
        }

        function resume() {
            if (duration <= 0 || toast.closed) return;
            if (progressEl) progressEl.classList.remove("holaf-toast__progress--paused");
            armTimer();
        }

        el.addEventListener("mouseenter", pause);
        el.addEventListener("mouseleave", resume);

        if (closeOnClick) {
            el.style.cursor = "pointer";
            el.addEventListener("click", () => close("click"));
        }

        function close(reason) {
            if (toast.closed) return;
            toast.closed = true;
            clearTimer();
            // Nettoyage du registre id métier (v0.3.0).
            if (typeof opts.id === "string" && opts.id && idRegistry[opts.id] === toast) {
                delete idRegistry[opts.id];
            }
            const idx = container.toasts.indexOf(toast);
            if (idx >= 0) container.toasts.splice(idx, 1);
            // Sortie en fondu ; suppression à la fin d'animation (ou après un
            // court repli si animations désactivées).
            el.classList.add("holaf-toast--closing");
            const remove = () => {
                if (el.parentNode) el.parentNode.removeChild(el);
                removeContainerIfEmpty(position);
            };
            let removed = false;
            const removeOnce = () => {
                if (!removed) { removed = true; remove(); }
            };
            el.addEventListener("animationend", removeOnce, { once: true });
            setTimeout(removeOnce, 250); // filet de sécurité (reduced-motion, jsdom)
            if (onClose) onClose(reason || "manual");
        }

        // ── API retournée ──
        const ctrl = {
            el,
            close: () => close("manual"),
            update(patch) {
                patch = patch || {};
                if (patch.message !== undefined) {
                    if (patch.html) messageEl.innerHTML = str(patch.message);
                    else messageEl.textContent = str(patch.message);
                }
                if (patch.title !== undefined) {
                    if (patch.title === null || patch.title === "") {
                        if (titleEl) { titleEl.remove(); titleEl = null; }
                    } else {
                        if (!titleEl) {
                            titleEl = document.createElement("div");
                            titleEl.className = "holaf-toast__title";
                            bodyEl.insertBefore(titleEl, messageEl);
                        }
                        titleEl.textContent = str(patch.title);
                    }
                }
                if (patch.type !== undefined && VALID_TYPES.indexOf(patch.type) >= 0) {
                    el.classList.remove(...VALID_TYPES.map((t) => "holaf-toast--" + t));
                    el.classList.add("holaf-toast--" + patch.type);
                    iconEl.textContent = ICONS[patch.type];
                    const isErr = patch.type === "error";
                    el.setAttribute("role", isErr ? "alert" : "status");
                    el.setAttribute("aria-live", isErr ? "assertive" : "polite");
                    toast.type = patch.type;
                }
                // Progression manuelle (v0.3.0) : largeur de la barre = N%.
                if (patch.progress !== undefined && progressEl && toast.manualProgress) {
                    const p = Math.max(0, Math.min(100, Number(patch.progress) || 0));
                    progressEl.style.width = p + "%";
                }
            },
        };
        toast.type = type;
        toast.ctrl = ctrl;

        // ── Stack : max MAX_VISIBLE visibles — le plus ancien saute ──
        toast.closeWithReason = close; // interne : fermeture « replaced »
        container.toasts.push(toast);
        // v0.3.0 : newestFirst → prepend (en premier) au lieu d'append (défaut).
        // v0.5.0 : pour les positions bottom-*, le plus récent doit rester COLLÉ
        // au bord bas (la pile grimpe vers le haut). Le DOM est en flex column :
        // le DERNIER enfant est collé au bord bas. On force donc TOUJOURS
        // l'append pour les bottom-*, même avec newestFirst (un prepend poserait
        // le plus récent EN HAUT, à l'opposé du bord de référence). newestFirst
        // ne vaut donc que pour les positions top-* (comportement historique).
        const prependNewest = newestFirst && !isBottomPosition(position);
        if (prependNewest) container.el.insertBefore(el, container.el.firstChild);
        else container.el.appendChild(el);
        while (container.toasts.length > MAX_VISIBLE) {
            const oldest = container.toasts.shift();
            oldest.closeWithReason("replaced");
        }

        // Enregistrement du registre id métier (v0.3.0).
        if (typeof opts.id === "string" && opts.id) {
            idRegistry[opts.id] = toast;
        }

        armTimer();
        if (onShow) onShow(ctrl);
        return ctrl;
    }

    // ─── Helpers courts ──────────────────────────────────────────────────────
    function helper(type) {
        return function (message, opts) {
            return show(Object.assign({}, opts, { message, type }));
        };
    }

    // ─── Résolution id métier / référence ctrl (v0.3.0) ─────────────────────
    // update(idOrCtrl, opts) et hide(idOrCtrl) acceptent un id string (résolu
    // via le registre) OU la référence ctrl retournée par show().
    function findToastByCtrl(ctrl) {
        for (const pos in containers) {
            const c = containers[pos];
            for (let i = 0; i < c.toasts.length; i++) {
                if (c.toasts[i].ctrl === ctrl) return c.toasts[i];
            }
        }
        return null;
    }

    function resolveToast(idOrCtrl) {
        if (typeof idOrCtrl === "string") return idRegistry[idOrCtrl] || null;
        if (idOrCtrl && typeof idOrCtrl === "object") return findToastByCtrl(idOrCtrl);
        return null;
    }

    // Met à jour un toast par id métier OU par référence ctrl. Retourne le
    // contrôleur mis à jour (ou null si introuvable).
    function update(idOrCtrl, opts) {
        const toast = resolveToast(idOrCtrl);
        if (toast && !toast.closed) toast.ctrl.update(opts || {});
        return toast ? toast.ctrl : null;
    }

    // Ferme un toast par id métier OU par référence ctrl.
    function hide(idOrCtrl) {
        const toast = resolveToast(idOrCtrl);
        if (toast && !toast.closed) toast.ctrl.close();
        return !!toast;
    }

    return {
        version: VERSION,
        show,
        success: helper("success"),
        error: helper("error"),
        warning: helper("warning"),
        info: helper("info"),
        // v0.3.0 : update/hide par id métier OU référence ctrl.
        update: update,
        hide: hide,
        // Thème global par défaut (volatil) : s'applique aux toasts qui ne
        // passent pas d'option `theme` — voir README section « Thèmes ».
        setTheme: setTheme,
        clearTheme: clearTheme,
        // Défauts globaux (position, durée, thème, newestFirst) — voir README.
        configure: configure,
        // Registre de thèmes (préréglages + customs) :
        //   themes.register(name, vars) — enregistre/remplace (retourne une copie protégée)
        //   themes.get(name)            — copie des variables ou null
        //   themes.list()               — noms enregistrés
        //   themes.update(name, vars)   — fusionne les vars d'un thème enregistré (v0.3.0)
        themes: {
            register: themesRegister,
            get: themesGet,
            list: themesList,
            update: themesUpdate,
        },
    };
})();

// Exposition globale (scripts classiques de la page).
if (typeof window !== "undefined") {
    window.HolafToast = HolafToast;
}

// Export ESM (import { HolafToast } from "./holaf-toast.js").
export { HolafToast };
