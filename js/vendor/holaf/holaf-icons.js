/* ═══════════════════════════════════════════════════════════════════════════
 * Holaf UI — Brique HolafIcons · version 0.1.7
 * ─────────────────────────────────────────────────────────────────────────────
 * Set d'icônes SVG en trait (style « feather »), ZÉRO CSS (aucune feuille
 * n'est injectée) : chaque icône utilise `stroke="currentColor"` et lèse à
 * l'hôte le soin de la colorer via son propre CSS (color / currentColor).
 *
 * Chaque icône est un trait 24×24 (`viewBox="0 0 24 24"`), `fill="none"`,
 * `stroke-width="2"`, lignes/arrondis dans le style Feather. La plupart des
 * tracés sont repris du jeu d'icônes **Feather Icons** (licence MIT — voir
 * `README-holaf-icons.md` pour le crédit complet) ; les icônes des vagues
 * v0.1.6 (fin de la migration Pi-Web) et v0.1.7 (migration AI-Helper) sont des
 * tracés **Lucide** (licence ISC) et certaines icônes ajoutées auparavant
 * (ex. `bar-chart`) reprennent le style Feather sans être des tracés Feather
 * littéraux.
 *
 * AJOUT D'ICÔNE : cherche d'abord l'icône sur icons0.dev — moteur de recherche
 * multi-collections, API JSON publique sans clé :
 * GET https://icons0.dev/api/icons?q=<prefix>:<nom> (le champ `body` est déjà
 * le SVG 24×24 en `currentColor`) ; vérifie la licence de la COLLECTION
 * D'ORIGINE avant de copier (seules les collections permissives sont admises).
 * Procédure complète : §6 de `README-holaf-icons.md`.
 *
 * API :
 *   HolafIcons.get(name)                          → string SVG (complet, 24px)
 *   HolafIcons.render(name, { size, class })      → string SVG (custom size/class)
 *   HolafIcons.list()                             → noms disponibles
 *   nom inconnu → throw clair listant les proches
 *
 * Fichier DUAL : module ES (export) + global window.HolafIcons — se charge
 * via <script type="module"> ou `import { HolafIcons }`.
 * ═════════════════════════════════════════════════════════════════════════ */

const HolafIcons = (function () {
    "use strict";

    const VERSION = "0.1.7";

    const NS = "http://www.w3.org/2000/svg";

    // ── Corpus des icônes : nom → corps SVG (traits internes, sans wrapper).
    // Style « feather » : 24×24, stroke currentColor, stroke-width 2, fill none.
    // Tracés : majoritairement le jeu Feather Icons (MIT) ; icônes ajoutées
    // (ex. bar-chart) dessinées dans le même style, non reprises de Feather.
    const ICONS = {
        // Graphique / stats (tracé propre au set, style Feather — pas Feather).
        "bar-chart":
            '<rect x="3" y="10" width="4" height="10" rx="1" ry="1"></rect>' +
            '<rect x="10" y="6" width="4" height="14" rx="1" ry="1"></rect>' +
            '<rect x="17" y="13" width="4" height="7" rx="1" ry="1"></rect>',

        // Bouclier / protection.
        shield:
            '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>',

        // Globe / monde.
        globe:
            '<circle cx="12" cy="12" r="10"></circle>' +
            '<line x1="2" y1="12" x2="22" y2="12"></line>' +
            '<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>',

        // Frame / layout (widgets Homy).

        layout:
            '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>' +
            '<line x1="3" y1="9" x2="21" y2="9"></line>' +
            '<line x1="9" y1="21" x2="9" y2="9"></line>',

        // Lien / URL (widget links, iframe, …).
        link:
            '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>' +
            '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>',

        // Horloge (widget clock).
        clock:
            '<circle cx="12" cy="12" r="10"></circle>' +
            '<polyline points="12 6 12 12 16 14"></polyline>',

        // Image (widget image / preview).
        image:
            '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>' +
            '<circle cx="8.5" cy="8.5" r="1.5"></circle>' +
            '<polyline points="21 15 16 10 5 21"></polyline>',

        // Signet.
        bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>',

        // Recherche (widget search).
        search:
            '<circle cx="11" cy="11" r="8"></circle>' +
            '<line x1="21" y1="21" x2="16.65" y2="16.65"></line>',

        // Note / édition de note (widget notes).
        edit:
            '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>',

        // Météo / nuage (widget weather).
        cloud: '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path>',

        // Fermer (×).
        x:
            '<line x1="18" y1="6" x2="6" y2="18"></line>' +
            '<line x1="6" y1="6" x2="18" y2="18"></line>',

        // Ajouter (+).
        plus:
            '<line x1="12" y1="5" x2="12" y2="19"></line>' +
            '<line x1="5" y1="12" x2="19" y2="12"></line>',

        // Corbeille.
        trash:
            '<polyline points="3 6 5 6 21 6"></polyline>' +
            '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>' +
            '<line x1="10" y1="11" x2="10" y2="17"></line>' +
            '<line x1="14" y1="11" x2="14" y2="17"></line>',

        // Crayon / stylo (édition).
        pencil:
            '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>' +
            '<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>',

        // Engrenage / réglages.
        gear:
            '<circle cx="12" cy="12" r="3"></circle>' +
            '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>',

        // Lecture / play.
        play: '<polygon points="5 3 19 12 5 21 5 3"></polygon>',

        // Pause.
        pause:
            '<rect x="6" y="4" width="4" height="16"></rect>' +
            '<rect x="14" y="4" width="4" height="16"></rect>',

        // Arrêt / stop (carré).
        stop:
            '<rect x="5" y="5" width="14" height="14" rx="2" ry="2"></rect>',

        // Flèche droite.
        "arrow-right":
            '<line x1="5" y1="12" x2="19" y2="12"></line>' +
            '<polyline points="12 5 19 12 12 19"></polyline>',

        // Œil (visible).
        eye:
            '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>' +
            '<circle cx="12" cy="12" r="3"></circle>',

        // Œil barré (masqué).
        "eye-off":
            '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>' +
            '<line x1="1" y1="1" x2="23" y2="23"></line>',

        // Chevrons directionnels.
        "chevron-down":  '<polyline points="6 9 12 15 18 9"></polyline>',
        "chevron-up":    '<polyline points="18 15 12 9 6 15"></polyline>',
        "chevron-left":  '<polyline points="15 18 9 12 15 6"></polyline>',
        "chevron-right": '<polyline points="9 18 15 12 9 6"></polyline>',

        // Validation.
        check: '<polyline points="20 6 9 17 4 12"></polyline>',

        // Alerte triangle.
        "alert-triangle":
            '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>' +
            '<line x1="12" y1="9" x2="12" y2="13"></line>' +
            '<line x1="12" y1="17" x2="12.01" y2="17"></line>',

        // Info.
        info:
            '<circle cx="12" cy="12" r="10"></circle>' +
            '<line x1="12" y1="16" x2="12" y2="12"></line>' +
            '<line x1="12" y1="8" x2="12.01" y2="8"></line>',

        // Téléchargement.
        download:
            '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>' +
            '<polyline points="7 10 12 15 17 10"></polyline>' +
            '<line x1="12" y1="15" x2="12" y2="3"></line>',

        // Envoi / upload.
        upload:
            '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>' +
            '<polyline points="17 8 12 3 7 8"></polyline>' +
            '<line x1="12" y1="3" x2="12" y2="15"></line>',

        // Copier.
        copy:
            '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>' +
            '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>',

        // Rafraîchir.
        refresh:
            '<polyline points="23 4 23 10 17 10"></polyline>' +
            '<polyline points="1 20 1 14 7 14"></polyline>' +
            '<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>',

        // Agrandir.
        maximize:
            '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path>',

        // Réduire.
        minimize:
            '<path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"></path>',

        // Dossier.
        folder:
            '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>',

        // Terminal / console.
        terminal:
            '<polyline points="4 17 10 11 4 5"></polyline>' +
            '<line x1="12" y1="19" x2="20" y2="19"></line>',

        // Branche git.
        "git-branch":
            '<line x1="6" y1="3" x2="6" y2="15"></line>' +
            '<circle cx="18" cy="6" r="3"></circle>' +
            '<circle cx="6" cy="18" r="3"></circle>' +
            '<path d="M18 9a9 9 0 0 1-9 9"></path>',

        // Soleil (mode clair).
        sun:
            '<circle cx="12" cy="12" r="5"></circle>' +
            '<line x1="12" y1="1" x2="12" y2="3"></line>' +
            '<line x1="12" y1="21" x2="12" y2="23"></line>' +
            '<line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>' +
            '<line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>' +
            '<line x1="1" y1="12" x2="3" y2="12"></line>' +
            '<line x1="21" y1="12" x2="23" y2="12"></line>' +
            '<line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>' +
            '<line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>',

        // Lune (mode sombre).
        moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>',

        // ── v0.1.4 : ajouts pour la migration d'icônes de Pi-Web ──────────────
        // Les 9 premières sont des tracés Feather littéraux (MIT, Cole Bemis).

        // Document / fichier texte.
        "file-text":
            '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>' +
            '<path d="M14 2v6h6m-4 5H8m8 4H8m2-8H8"></path>',

        // Lien externe (ouvrir ailleurs).
        "external-link":
            '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6m4-3h6v6m-11 5L21 3"></path>',

        // Flèche haut dans un cercle (mise à jour / upload).
        "arrow-up-circle":
            '<circle cx="12" cy="12" r="10"></circle>' +
            '<path d="m16 12l-4-4l-4 4m4 4V8"></path>',

        // Flèche haut (ex. git push).
        "arrow-up": '<path d="M12 19V5m-7 7l7-7l7 7"></path>',

        // Flèche bas (ex. git pull).
        "arrow-down": '<path d="M12 5v14m7-7l-7 7l-7-7"></path>',

        // Utilisateur (identité, compte).
        user:
            '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>' +
            '<circle cx="12" cy="7" r="4"></circle>',

        // Clé (clés API, secrets).
        key:
            '<path d="m21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778a5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path>',

        // Alimentation / activer (bouton power).
        power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10"></path>',

        // Étoile (favori / défaut).
        star: '<path d="m12 2l3.09 6.26L22 9.27l-5 4.87l1.18 6.88L12 17.77l-6.18 3.25L7 14.14L2 9.27l6.91-1.01z"></path>',

        // ── Tracés Tabler Icons (MIT) — Feather ne les fournit pas ────────────

        // Dossier ouvert.
        "folder-open":
            '<path d="m5 19l2.757-7.351A1 1 0 0 1 8.693 11H21a1 1 0 0 1 .986 1.164l-.996 5.211A2 2 0 0 1 19.026 19za2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v2"></path>',

        // Cerveau (mémoire / analyse).
        brain:
            '<path d="M15.5 13a3.5 3.5 0 0 0-3.5 3.5v1a3.5 3.5 0 0 0 7 0v-1.8M8.5 13a3.5 3.5 0 0 1 3.5 3.5v1a3.5 3.5 0 0 1-7 0v-1.8"></path>' +
            '<path d="M17.5 16a3.5 3.5 0 0 0 0-7H17"></path>' +
            '<path d="M19 9.3V6.5a3.5 3.5 0 0 0-7 0M6.5 16a3.5 3.5 0 0 1 0-7H7"></path>' +
            '<path d="M5 9.3V6.5a3.5 3.5 0 0 1 7 0v10"></path>',

        // ── v0.1.5 : ajouts pour la migration d'icônes de Yuki ───────────────
        // Tracés Feather littéraux (MIT, Cole Bemis), sourcés via icons0.dev
        // (GET /api/icons?q=feather:<nom>) — voir README-holaf-icons.md §6.

        // Flèche gauche (retour / navigation arrière) — miroir de `arrow-right`.
        "arrow-left":
            '<line x1="19" y1="12" x2="5" y2="12"></line>' +
            '<polyline points="12 19 5 12 12 5"></polyline>',

        // Volume actif (haut-parleur + ondes). Tracé Feather `volume-2` fourni
        // sous le nom court `volume` (la brique ne porte pas les variantes -1/-2).
        volume:
            '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>' +
            '<path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>',

        // Volume coupé (haut-parleur barré). Tracé Feather `volume-x`, nommé
        // `volume-off` (nom sémantique demandé par Yuki ; Feather dit `volume-x`).
        "volume-off":
            '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>' +
            '<line x1="23" y1="9" x2="17" y2="15"></line>' +
            '<line x1="17" y1="9" x2="23" y2="15"></line>',

        // ── v0.1.6 : fin de la migration d'icônes de Pi-Web ────────────────────
        // 39 tracés repris À L'IDENTIQUE de lucide-react v0.446.0 (licence ISC :
        // copyright Lucide Contributors 2022, portions Feather MIT de Cole Bemis
        // 2013-2022 — texte complet au §5 de README-holaf-icons.md). Parité de
        // rendu vérifiée (innerHTML identique au composant lucide-react installé
        // côté Pi-Web), afin qu'aucune icône migrée ne change d'aspect.

        // Fichiers / dossiers.
        file:
            '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path>' +
            '<path d="M14 2v4a2 2 0 0 0 2 2h4"></path>',
        "file-down":
            '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path>' +
            '<path d="M14 2v4a2 2 0 0 0 2 2h4"></path>' +
            '<path d="M12 18v-6"></path>' +
            '<path d="m9 15 3 3 3-3"></path>',
        "folder-plus":
            '<path d="M12 10v6"></path>' +
            '<path d="M9 13h6"></path>' +
            '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path>',
        "folder-x":
            '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path>' +
            '<path d="m9.5 10.5 5 5"></path>' +
            '<path d="m14.5 10.5-5 5"></path>',

        // Édition / actions.
        save:
            '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"></path>' +
            '<path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"></path>' +
            '<path d="M7 3v4a1 1 0 0 0 1 1h7"></path>',
        send:
            '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"></path>' +
            '<path d="m21.854 2.147-10.94 10.939"></path>',
        "undo-2":
            '<path d="M9 14 4 9l5-5"></path>' +
            '<path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"></path>',
        "redo-2":
            '<path d="m15 14 5-5-5-5"></path>' +
            '<path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"></path>',
        unlink:
            '<path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"></path>' +
            '<path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"></path>' +
            '<line x1="8" x2="8" y1="2" y2="5"></line>' +
            '<line x1="2" x2="5" y1="8" y2="8"></line>' +
            '<line x1="16" x2="16" y1="19" y2="22"></line>' +
            '<line x1="19" x2="22" y1="16" y2="16"></line>',
        "zoom-in":
            '<circle cx="11" cy="11" r="8"></circle>' +
            '<line x1="21" x2="16.65" y1="21" y2="16.65"></line>' +
            '<line x1="11" x2="11" y1="8" y2="14"></line>' +
            '<line x1="8" x2="14" y1="11" y2="11"></line>',
        "zoom-out":
            '<circle cx="11" cy="11" r="8"></circle>' +
            '<line x1="21" x2="16.65" y1="21" y2="16.65"></line>' +
            '<line x1="8" x2="14" y1="11" y2="11"></line>',
        "message-square-plus":
            '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>' +
            '<path d="M12 7v6"></path>' +
            '<path d="M9 10h6"></path>',

        // Validation / états.
        "check-check":
            '<path d="M18 6 7 17l-5-5"></path>' +
            '<path d="m22 10-7.5 7.5L13 16"></path>',
        "check-circle":
            '<path d="M21.801 10A10 10 0 1 1 17 3.335"></path>' +
            '<path d="m9 11 3 3L22 4"></path>',
        "check-square":
            '<path d="M21 10.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12.5"></path>' +
            '<path d="m9 11 3 3L22 4"></path>',
        "plus-square":
            '<rect width="18" height="18" x="3" y="3" rx="2"></rect>' +
            '<path d="M8 12h8"></path>' +
            '<path d="M12 8v8"></path>',
        square: '<rect width="18" height="18" x="3" y="3" rx="2"></rect>',
        "toggle-left":
            '<rect width="20" height="12" x="2" y="6" rx="6" ry="6"></rect>' +
            '<circle cx="8" cy="12" r="2"></circle>',
        "toggle-right":
            '<rect width="20" height="12" x="2" y="6" rx="6" ry="6"></rect>' +
            '<circle cx="16" cy="12" r="2"></circle>',

        // Développement / technique.
        code:
            '<polyline points="16 18 22 12 16 6"></polyline>' +
            '<polyline points="8 6 2 12 8 18"></polyline>',
        cpu:
            '<rect width="16" height="16" x="4" y="4" rx="2"></rect>' +
            '<rect width="6" height="6" x="9" y="9" rx="1"></rect>' +
            '<path d="M15 2v2"></path>' +
            '<path d="M15 20v2"></path>' +
            '<path d="M2 15h2"></path>' +
            '<path d="M2 9h2"></path>' +
            '<path d="M20 15h2"></path>' +
            '<path d="M20 9h2"></path>' +
            '<path d="M9 2v2"></path>' +
            '<path d="M9 20v2"></path>',
        "git-commit":
            '<circle cx="12" cy="12" r="3"></circle>' +
            '<line x1="3" x2="9" y1="12" y2="12"></line>' +
            '<line x1="15" x2="21" y1="12" y2="12"></line>',
        keyboard:
            '<path d="M10 8h.01"></path>' +
            '<path d="M12 12h.01"></path>' +
            '<path d="M14 8h.01"></path>' +
            '<path d="M16 12h.01"></path>' +
            '<path d="M18 8h.01"></path>' +
            '<path d="M6 8h.01"></path>' +
            '<path d="M7 16h10"></path>' +
            '<path d="M8 12h.01"></path>' +
            '<rect width="20" height="16" x="2" y="4" rx="2"></rect>',
        wifi:
            '<path d="M12 20h.01"></path>' +
            '<path d="M2 8.82a15 15 0 0 1 20 0"></path>' +
            '<path d="M5 12.859a10 10 0 0 1 14 0"></path>' +
            '<path d="M8.5 16.429a5 5 0 0 1 7 0"></path>',
        wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>',
        "test-tube":
            '<path d="M21 7 6.82 21.18a2.83 2.83 0 0 1-3.99-.01a2.83 2.83 0 0 1 0-4L17 3"></path>' +
            '<path d="m16 2 6 6"></path>' +
            '<path d="M12 16H4"></path>',

        // Données / mesures.
        calendar:
            '<path d="M8 2v4"></path>' +
            '<path d="M16 2v4"></path>' +
            '<rect width="18" height="18" x="3" y="4" rx="2"></rect>' +
            '<path d="M3 10h18"></path>',
        hash:
            '<line x1="4" x2="20" y1="9" y2="9"></line>' +
            '<line x1="4" x2="20" y1="15" y2="15"></line>' +
            '<line x1="10" x2="8" y1="3" y2="21"></line>' +
            '<line x1="16" x2="14" y1="3" y2="21"></line>',
        "pie-chart":
            '<path d="M21 12c.552 0 1.005-.449.95-.998a10 10 0 0 0-8.953-8.951c-.55-.055-.998.398-.998.95v8a1 1 0 0 0 1 1z"></path>' +
            '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"></path>',
        "trending-up":
            '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"></polyline>' +
            '<polyline points="16 7 22 7 22 13"></polyline>',
        gauge:
            '<path d="m12 14 4-4"></path>' +
            '<path d="M3.34 19a10 10 0 1 1 17.32 0"></path>',

        // Divers UI.
        package:
            '<path d="m7.5 4.27 9 5.15"></path>' +
            '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"></path>' +
            '<path d="m3.3 7 8.7 5 8.7-5"></path>' +
            '<path d="M12 22V12"></path>',
        palette:
            '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"></circle>' +
            '<circle cx="17.5" cy="10.5" r=".5" fill="currentColor"></circle>' +
            '<circle cx="8.5" cy="7.5" r=".5" fill="currentColor"></circle>' +
            '<circle cx="6.5" cy="12.5" r=".5" fill="currentColor"></circle>' +
            '<path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"></path>',
        puzzle: '<path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z"></path>',
        lightbulb:
            '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"></path>' +
            '<path d="M9 18h6"></path>' +
            '<path d="M10 22h4"></path>',
        sparkles:
            '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"></path>' +
            '<path d="M20 3v4"></path>' +
            '<path d="M22 5h-4"></path>' +
            '<path d="M4 17v2"></path>' +
            '<path d="M5 18H3"></path>',
        mail:
            '<rect width="20" height="16" x="2" y="4" rx="2"></rect>' +
            '<path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"></path>',
        paperclip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>',
        "image-off":
            '<line x1="2" x2="22" y1="2" y2="22"></line>' +
            '<path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"></path>' +
            '<line x1="13.5" x2="6" y1="13.5" y2="21"></line>' +
            '<line x1="18" x2="21" y1="12" y2="15"></line>' +
            '<path d="M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59"></path>' +
            '<path d="M21 15V5a2 2 0 0 0-2-2H9"></path>',

        // ── v0.1.7 : ajouts pour la migration d'icônes d'AI-Helper ─────────────
        // 21 tracés repris À L'IDENTIQUE de la collection **Lucide** (licence
        // ISC — copyright Lucide Contributors 2022, portions Feather MIT de Cole
        // Bemis 2013-2022 ; texte complet au §5 de README-holaf-icons.md),
        // sourcés via le moteur de recherche multi-collections icons0.dev :
        // GET /api/icons?q=lucide:<nom> → champ `body`. Seuls le groupe <g>
        // englobant et les attributs de présentation ont été retirés (buildSvg
        // les fournit) : AUCUNE géométrie n'est modifiée. Un seul alias de nom :
        // `loader` ← lucide:loader-circle (nom court demandé par AI-Helper).

        // Verrou (chiffrement, accès réservé) & état bloqué.
        lock:
            '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"></rect>' +
            '<path d="M7 11V7a5 5 0 0 1 10 0v4"></path>',
        "lock-open":
            '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"></rect>' +
            '<path d="M7 11V7a5 5 0 0 1 9.9-1"></path>',
        ban:
            '<circle cx="12" cy="12" r="10"></circle>' +
            '<path d="M4.929 4.929L19.07 19.071"></path>',

        // Personnes / messagerie / expression.
        users:
            '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3.128a4 4 0 0 1 0 7.744M22 21v-2a4 4 0 0 0-3-3.87"></path>' +
            '<circle cx="9" cy="7" r="4"></circle>',
        "message-square": '<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"></path>',
        heart: '<path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676a.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"></path>',

        // Affichage / médias.
        monitor:
            '<rect width="20" height="14" x="2" y="3" rx="2"></rect>' +
            '<path d="M8 21h8m-4-4v4"></path>',
        video:
            '<path d="m16 13l5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"></path>' +
            '<rect width="14" height="12" x="2" y="6" rx="2"></rect>',

        // Filtres / étiquettes / aléatoire (outils d'exploration).
        filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54z"></path>',
        tag:
            '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"></path>' +
            '<circle cx="7.5" cy="7.5" r=".5" fill="currentColor"></circle>',
        shuffle:
            '<path d="m18 14l4 4l-4 4m0-20l4 4l-4 4"></path>' +
            '<path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22M2 6h1.972a4 4 0 0 1 3.6 2.2M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45"></path>',
        dices:
            '<rect width="12" height="12" x="2" y="10" rx="2" ry="2"></rect>' +
            '<path d="m17.92 14l3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6M6 18h.01M10 14h.01M15 6h.01M18 9h.01"></path>',

        // Sélection / géométrie (canvas, poignées de glissement).
        crosshair:
            '<circle cx="12" cy="12" r="10"></circle>' +
            '<path d="M22 12h-4M6 12H2m10-6V2m0 20v-4"></path>',
        circle: '<circle cx="12" cy="12" r="10"></circle>',
        "grip-vertical":
            '<circle cx="9" cy="12" r="1"></circle>' +
            '<circle cx="9" cy="5" r="1"></circle>' +
            '<circle cx="9" cy="19" r="1"></circle>' +
            '<circle cx="15" cy="12" r="1"></circle>' +
            '<circle cx="15" cy="5" r="1"></circle>' +
            '<circle cx="15" cy="19" r="1"></circle>',

        // Édition / effacement.
        eraser: '<path d="M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21m-7.752-9.91l8.828 8.828"></path>',

        // Progression (lecteur vidéo, chargement).
        loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>',
        "skip-forward": '<path d="M21 4v16M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z"></path>',

        // Technique / écologie / mise à l'échelle.
        syringe: '<path d="m18 2l4 4m-5 1l3-3m-1 5L8.7 19.3c-1 1-2.5 1-3.4 0l-.6-.6c-1-1-1-2.5 0-3.4L15 5m-6 6l4 4m-8 4l-3 3M14 4l6 6"></path>',
        recycle:
            '<path d="M7 19H4.815a1.83 1.83 0 0 1-1.57-.881a1.79 1.79 0 0 1-.004-1.784L7.196 9.5M11 19h8.203a1.83 1.83 0 0 0 1.556-.89a1.78 1.78 0 0 0 0-1.775l-1.226-2.12"></path>' +
            '<path d="m14 16l-3 3l3 3m-5.707-8.404L7.196 9.5L3.1 10.598m6.244-4.787l1.093-1.892A1.83 1.83 0 0 1 11.985 3a1.78 1.78 0 0 1 1.546.888l3.943 6.843"></path>' +
            '<path d="m13.378 9.633l4.096 1.098l1.097-4.096"></path>',
        scaling:
            '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>' +
            '<path d="M14 15H9v-5m7-7h5v5m0-5L9 15"></path>',
    };

    // ── Helpers ─────────────────────────────────────────────────────────────
    // Distance de Levenshtein : permet de « proposer les proches » pour un nom
    // inconnu (fautes de frappe / orthographe approximative).
    function levenshtein(a, b) {
        const m = a.length;
        const n = b.length;
        const d = new Array(m + 1);
        for (let i = 0; i <= m; i++) d[i] = new Array(n + 1).fill(0);
        for (let i = 0; i <= m; i++) d[i][0] = i;
        for (let j = 0; j <= n; j++) d[0][j] = j;
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                d[i][j] = Math.min(
                    d[i - 1][j] + 1,
                    d[i][j - 1] + 1,
                    d[i - 1][j - 1] + cost
                );
            }
        }
        return d[m][n];
    }

    // Construction du SVG complet (wrapper + corps) avec taille/class.
    function buildSvg(body, size, className) {
        const s = Number.isFinite(size) && size > 0 ? size : 24;
        const cls = className ? ' class="' + className + '"' : "";
        return (
            '<svg xmlns="' + NS + '" viewBox="0 0 24 24" width="' + s + '" height="' + s +
            '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
            'stroke-linejoin="round"' + cls + '>' + body + "</svg>"
        );
    }

    // Récupération du corps, avec erreur claire listant les proches.
    function bodyOf(name) {
        if (typeof name !== "string" || name.length === 0) {
            throw new Error(
                "[HolafIcons] nom d'icône invalide. Voir list() pour les noms disponibles."
            );
        }
        const key = name.trim();
        if (Object.prototype.hasOwnProperty.call(ICONS, key)) return ICONS[key];

        // Nom inconnu → proposer les plus proches (distance de Levenshtein).
        const closest = Object.keys(ICONS)
            .map((n) => ({ name: n, d: levenshtein(key.toLowerCase(), n.toLowerCase()) }))
            .sort((a, b) => a.d - b.d)
            .filter((x, i) => i < 5)
            .map((x) => x.name + (x.d <= 2 ? " ←" : ""));
        throw new Error(
            "[HolafIcons] icône inconnue : '" + key + "'. " +
            "Disponibles : " + Object.keys(ICONS).join(", ") +
            ". Proches : " + closest.join(", ") + "."
        );
    }

    // ── API publique ─────────────────────────────────────────────────────────
    return {
        version: VERSION,

        list() {
            return Object.keys(ICONS);
        },

        get(name) {
            return buildSvg(bodyOf(name), 24, null);
        },

        render(name, opts) {
            const o = opts || {};
            const size =
                o.size !== undefined && o.size !== null
                    ? Number(o.size)
                    : 24;
            const cls = o.class || o.className || "";
            return buildSvg(bodyOf(name), size, cls);
        },
    };
})();

// Exposition globale (scripts classiques de la page).
if (typeof window !== "undefined") {
    window.HolafIcons = HolafIcons;
}

// Export ESM (import { HolafIcons } from "./holaf-icons.js").
export { HolafIcons };
