/*
 * Périmètre de consommation de la FAÇADE d'icônes (js/aih_icons.js) — source
 * unique de vérité partagée par les tests de la migration d'icônes.
 *
 * Pourquoi ce fichier existe : la migration remplace des emoji cosmétiques par
 * des icônes de la brique `holaf-icons`, fichier par fichier, lot par lot. Il
 * faut une garde qui empêche la consommation de DÉBORDER du lot en cours (c'est
 * la seule garantie mécanique que le périmètre annoncé est respecté). La liste
 * des fichiers autorisés vit ici, et nulle part ailleurs : les tests
 * (test_aih_icons.mjs pour le socle, test_aih_icons_phase2a.mjs pour le lot)
 * interrogent les MÊMES constantes.
 *
 * Convention : un fichier « consomme » la façade s'il la mentionne (import ou
 * appel `aihIconSvg` / `aihIconEl` / `aihIconNames` / `AIH_ICON_DEFAULT_SIZE`).
 *
 * Usage :
 *   import { checkIconPerimeter } from "./test_helpers/icon_perimeter.mjs";
 *   const r = checkIconPerimetre(PACKAGE_DIR);
 *   assert.deepStrictEqual(r.horsListe, [], "…");
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Fichiers d'UI AUTORISÉS à consommer la façade au terme de la PHASE 2a
 * (dialogues, boutons « fermer », plein écran, poignée de drag).
 * Chemins relatifs à la racine du pack, séparateur « / ».
 * Ajouter un fichier ici = étendre explicitement le périmètre du lot.
 */
export const PHASE_2A_CONSUMERS = Object.freeze([
    "js/aih_dialog.js",                       // alertes (info/success/error/warning) + fermeture
    "js/holaf_panel_manager.js",              // fermeture des panneaux
    "js/holaf_remote_comparer.js",            // fermeture du comparer
    "js/holaf_layout_tools.js",               // poignée de drag + fermeture
    "js/holaf_image_viewer.js",               // fermeture du plein écran
    "js/image_viewer/image_viewer_ui.js",     // fermeture du zoom + plein écran
    "js/model_manager/model_manager_ui.js",   // fermeture de la modale d'upload
]);

/**
 * Fichiers d'UI qui ne doivent JAMAIS consommer la façade — soit parce qu'ils
 * appartiennent à un lot ULTÉRIEUR (dont les emoji sont assertés par des tests
 * existants qu'il faut adapter en même temps), soit parce que leurs emoji sont
 * SÉMANTIQUES (jamais remplaçables par une icône).
 */
export const FORBIDDEN_CONSUMERS = Object.freeze([
    // Lot suivant : la croix de suppression est assertée par test_shortcuts_delete_confirm.mjs.
    "js/holaf_shortcuts.js",
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
 * @returns {{offenders: string[], horsListe: string[], interdits: string[], manquants: string[]}}
 */
export function checkIconPerimetre(packageDir) {
    const offenders = scanIconConsumers(packageDir);
    return {
        offenders,
        // Consommateurs hors liste blanche → débordement de périmètre.
        horsListe: offenders.filter((f) => !PHASE_2A_CONSUMERS.includes(f)),
        // Consommateurs explicitement interdits → la faute la plus grave.
        interdits: offenders.filter((f) => FORBIDDEN_CONSUMERS.includes(f)),
        // Fichiers du lot qui ne consomment plus rien → la liste blanche serait
        // vide de sens (garde vacante) : on exige que le lot soit réellement branché.
        manquants: PHASE_2A_CONSUMERS.filter((f) => !offenders.includes(f)),
    };
}
