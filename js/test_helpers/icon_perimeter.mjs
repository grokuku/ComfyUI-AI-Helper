/*
 * Périmètre de consommation de la FAÇADE d'icônes (js/aih_icons.js) — source
 * unique de vérité partagée par les tests de la migration d'icônes.
 *
 * Pourquoi ce fichier existe : la migration remplace des emoji cosmétiques par
 * des icônes de la brique `holaf-icons`, fichier par fichier, lot par lot. Il
 * faut une garde qui empêche la consommation de DÉBORDER du lot en cours (c'est
 * la seule garantie mécanique que le périmètre annoncé est respecté). La liste
 * des fichiers autorisés vit ici, et nulle part ailleurs : les tests
 * (test_aih_icons.mjs pour le socle, test_aih_icons_phase2a.mjs et
 * test_aih_icons_phase2b.mjs pour les lots) interrogent les MÊMES constantes.
 *
 * Structure PAR PHASE : `PHASES` associe un numéro de lot à la liste des
 * fichiers d'UI qu'il a migrés. Le périmètre AUTORISÉ est l'UNION de toutes les
 * phases déjà livrées (`ALLOWED_CONSUMERS`) ; `CURRENT_PHASE` désigne le lot en
 * cours (celui dont on exige que les fichiers consomment RÉELLEMENT la façade).
 * Ajouter une phase = ajouter une clé, jamais élargir une liste existante.
 *
 * Convention : un fichier « consomme » la façade s'il la mentionne (import ou
 * appel `aihIconSvg` / `aihIconEl` / `aihIconNames` / `AIH_ICON_DEFAULT_SIZE`).
 *
 * Usage :
 *   import { checkIconPerimetre, PHASES } from "./test_helpers/icon_perimeter.mjs";
 *   const r = checkIconPerimetre(PACKAGE_DIR);            // phase courante
 *   const r2a = checkIconPerimetre(PACKAGE_DIR, "2a");    // lot 2a seulement
 *   assert.deepStrictEqual(r.horsListe, [], "…");
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Phases de la migration, chacune avec les fichiers d'UI qu'elle a migrés.
 * Chemins relatifs à la racine du pack, séparateur « / ».
 * Ajouter un fichier ici = étendre explicitement le périmètre du lot.
 */
export const PHASES = Object.freeze({
    /**
     * PHASE 2a — dialogues, boutons « fermer », plein écran, poignée de drag.
     */
    "2a": Object.freeze([
        "js/aih_dialog.js",                       // alertes (info/success/error/warning) + fermeture
        "js/holaf_panel_manager.js",              // fermeture des panneaux
        "js/holaf_remote_comparer.js",            // fermeture du comparer
        "js/holaf_layout_tools.js",               // poignée de drag + fermeture
        "js/holaf_image_viewer.js",               // fermeture du plein écran
        "js/image_viewer/image_viewer_ui.js",     // fermeture du zoom + plein écran
        "js/model_manager/model_manager_ui.js",   // fermeture de la modale d'upload
    ]),
    /**
     * PHASE 2b — même famille (fermer / cocher / plein écran / supprimer une
     * ligne) : raccourcis, badge plein écran de la galerie, suppression d'un
     * contrôle de l'éditeur, suppression d'un modèle distant, et la ligne du
     * widget Elements (poignée + œil + suppression).
     */
    "2b": Object.freeze([
        "js/holaf_shortcuts.js",                  // coche « enregistré » + fermeture + suppression d'un raccourci
        "js/image_viewer/image_viewer_gallery.js",// badge plein écran d'une vignette de la grille
        "js/image_viewer/image_viewer_editor.js", // suppression d'un contrôle (ligne de la liste)
        "js/02_aih_model_browser.js",             // suppression d'un modèle distant (admin, par ligne)
        "js/aih_elements_widget.js",              // poignée de drag + œil (visibilité) + suppression d'une ligne
    ]),
});

/** Lot en cours (celui dont les fichiers doivent consommer réellement). */
export const CURRENT_PHASE = "2b";

/** Alias historique : la phase 2a reste adressable sous son ancien nom. */
export const PHASE_2A_CONSUMERS = PHASES["2a"];

/** Alias explicite de la phase 2b. */
export const PHASE_2B_CONSUMERS = PHASES["2b"];

/** Union de TOUS les fichiers autorisés (toutes phases livrées confondues). */
export const ALLOWED_CONSUMERS = Object.freeze(
    [...new Set(Object.values(PHASES).flat())].sort()
);

/**
 * Fichiers d'UI qui ne doivent JAMAIS consommer la façade — soit parce qu'ils
 * appartiennent à un lot ULTÉRIEUR (dont les emoji sont assertés par des tests
 * existants qu'il faut adapter en même temps), soit parce que leurs emoji sont
 * SÉMANTIQUES (jamais remplaçables par une icône).
 *
 * ⚠️ `js/holaf_shortcuts.js` a QUITTÉ cette liste en PHASE 2b : il est désormais
 * un consommateur autorisé (et son test de confirmation destructive a été
 * réécrit en assertions structurelles). Ceux qui restent sont SÉMANTIQUES.
 */
export const FORBIDDEN_CONSUMERS = Object.freeze([
    // Emoji de protocole/sentinelle assertés (éclair de puce, sablier de placeholder, ⏹/➤).
    "js/blobby_companion.js",
    // Cadenas / lien / dé = clés de mode assertées par les tests de seed.
    "js/aih_elements_seed.js",
    // Triangle d'alerte = statut coloré des mots-clés (sens = état, pas décoration).
    "js/aih_keywords_widget.js",
]);

/** Motif qui trahit une consommation de la façade. */
const CONSUME_RX = /aih_icons|AIH_ICON_DEFAULT_SIZE|aihIcon(?:Svg|El|Names)/;

/** Dossiers jamais explorés (copie pinnée, helpers de test, caches). */
const SKIP_DIRS = new Set(["vendor", "test_helpers", "__pycache__", "node_modules"]);

/**
 * Liste les fichiers d'UI qui consomment la façade (js/ + aih_frontend/js,
 * hors vendor, helpers de test, harnais `test_*` et façade elle-même).
 * @param {string} packageDir racine du pack.
 * @returns {string[]} chemins relatifs (séparateur « / »), triés.
 */
export function scanIconConsumers(packageDir) {
    const offenders = [];
    const facadePath = join(packageDir, "js", "aih_icons.js");
    const roots = [join(packageDir, "js"), join(packageDir, "aih_frontend", "js")];

    const walk = (dir) => {
        let entries;
        try {
            entries = readdirSync(dir);
        } catch {
            return; // dossier absent : rien à scanner
        }
        for (const entry of entries) {
            const p = join(dir, entry);
            let st;
            try {
                st = statSync(p);
            } catch {
                continue;
            }
            if (st.isDirectory()) {
                if (!SKIP_DIRS.has(entry)) walk(p);
                continue;
            }
            if (!p.endsWith(".js")) continue;
            if (entry.startsWith("test_")) continue;   // harnais de test
            if (p === facadePath) continue;            // la façade elle-même
            if (CONSUME_RX.test(readFileSync(p, "utf8"))) {
                offenders.push(relative(packageDir, p).split("\\").join("/"));
            }
        }
    };
    for (const root of roots) walk(root);
    return offenders.sort();
}

/**
 * Vérifie le périmètre et renvoie le détail (aucune assertion ici : les tests
 * choisissent quelles listes doivent être vides, pour des messages parlants).
 * @param {string} packageDir racine du pack.
 * @param {string} [phase] lot dont on exige la consommation effective
 *   (défaut : `CURRENT_PHASE`).
 * @returns {{phase: string, offenders: string[], horsListe: string[], interdits: string[],
 *            manquants: string[], manquantsToutesPhases: string[], autorises: string[], attendus: string[]}}
 */
export function checkIconPerimetre(packageDir, phase = CURRENT_PHASE) {
    const offenders = scanIconConsumers(packageDir);
    const lot = PHASES[phase] || [];
    return {
        phase,
        offenders,
        // Consommateurs hors liste blanche → débordement de périmètre.
        // (La liste blanche est CUMULATIVE : toutes les phases livrées.)
        horsListe: offenders.filter((f) => !ALLOWED_CONSUMERS.includes(f)),
        // Consommateurs explicitement interdits → la faute la plus grave.
        interdits: offenders.filter((f) => FORBIDDEN_CONSUMERS.includes(f)),
        // Fichiers du lot demandé qui ne consomment plus rien → la liste blanche
        // serait vide de sens (garde vacante) : on exige que le lot soit
        // réellement branché.
        manquants: lot.filter((f) => !offenders.includes(f)),
        // Idem, mais sur TOUTES les phases (aucune phase ne doit se dé-brancher).
        manquantsToutesPhases: ALLOWED_CONSUMERS.filter((f) => !offenders.includes(f)),
        // Rappel des listes pour les messages d'erreur.
        autorises: ALLOWED_CONSUMERS.slice(),
        attendus: lot.slice(),
    };
}

/**
 * Cohérence des listes elles-mêmes (indépendante du disque) :
 *   - aucune liste de phase ne recoupe `FORBIDDEN_CONSUMERS` ;
 *   - aucun fichier n'apparaît dans deux phases (un fichier = un lot).
 * @returns {{croisements: string[], doublonsPhases: string[]}}
 */
export function checkPhaseDisjointness() {
    const croisements = [];
    const doublonsPhases = [];
    const vus = new Map();
    for (const [phase, files] of Object.entries(PHASES)) {
        for (const f of files) {
            if (FORBIDDEN_CONSUMERS.includes(f)) croisements.push(`${phase}:${f}`);
            if (vus.has(f)) doublonsPhases.push(`${f} (${vus.get(f)} + ${phase})`);
            else vus.set(f, phase);
        }
    }
    return { croisements, doublonsPhases };
}
