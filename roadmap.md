# Roadmap & Rapport de Bugs — ComfyUI-Holaf-Utils

**Dernière mise à jour :** 2026-09-12  
**Version du projet :** Schema v13, éditeur d'images schéma `.edt` v2 (contrôles à plages), sauvegarde automatique

> **Fusion** : ce fichier unique remplace l'ancien couple `ROADMAP.md` (vision produit app mobile) + `roadmap.md` (rapport de bugs/statut), afin d'éviter toute collision de casse sur les filesystems insensibles à la casse (Windows/macOS). Il contient deux volets :
>
> 1. **Roadmap produit — App mobile Android**
> 2. **Rapport de bugs & statut du projet**

---

## Roadmap produit — App mobile Android

**Statut :** Proposition — non démarrée  
**Périmètre :** Nouvelle direction produit : app Android + serveur externe relais pour piloter ComfyUI à distance.

---

### Vision

App Android connectée à un serveur externe relais permettant de :

* parcourir sa galerie d'images générées,
* lancer des générations à distance avec des interfaces personnalisées construites depuis des nodes ComfyUI dédiées,
* comparer des images en temps réel sur mobile.

**Objectif UX : aucune configuration réseau pour l'utilisateur final.**

---

### Architecture cible

* **Serveur externe (relais)** : comptes utilisateurs/auth, routage des messages entre apps Android et instances ComfyUI.
* **Connexions SORTANTES uniquement** (WebSocket) côté ComfyUI et côté app → pas de port forwarding, pas d'IP fixe requise chez l'utilisateur.
* **Pack de nodes compagnon côté ComfyUI (« bridge »)** : connexion au serveur, envoi des événements/images/miniatures, réception des jobs de génération.
* **App Android** : les 3 modules ci-dessous.

---

### Module 1 — Galerie simplifiée

* Grille de miniatures, navigation par dates/dossiers/filtres simples, vue plein écran.
* S'appuie sur la logique du visualiseur existant (miniatures, filtres, pagination par index de positions).
* Flux : ComfyUI → serveur → app ; images pleine résolution à la demande uniquement.

### Module 2 — Génération à distance

* Nodes d'entrée standard dans ComfyUI qui déclarent un **schéma de contrôle** (textbox, slider, dropdown de modèles, seed, upload d'image…).
* Le workflow exporte une « spécification de formulaire » JSON qui pilote l'interface rendue nativement sur le téléphone.
* Outil dans ComfyUI : prévisualisation du rendu mobile + éditeur de mise en page (réorganiser, customiser).
* Widgets de base v1 : texte, texte multiligne, nombre/slider, dropdown (listes de modèles dynamiques), seed, toggle, image picker. Extensible au fur et à mesure.
* Exécution : l'app soumet les valeurs → relais serveur → ComfyUI exécute le workflow → progression temps réel (WS) → résultat visible dans la galerie.

### Module 3 — Comparer remote

* Reprise de la node comparer existante (`HolafRemoteComparer`), adaptée mobile :
  * comparaison A/B par geste slide/swipe,
  * mise à jour temps réel quand une nouvelle génération arrive.

---

### Phasage proposé

0. **Design du protocole serveur** (auth, WS, format des messages) + POC chaîne complète ComfyUI ↔ serveur ↔ app.
1. **Bridge ComfyUI + génération minimale** (un prompt texte → image résultat affichée dans l'app).
2. **Module galerie.**
3. **Spécification de formulaires + prévisualisation + éditeur de layout** (le plus lourd : volontairement tardif).
4. **Comparer remote.**

---

### Questions ouvertes / risques

* **Confidentialité** : les images transitent par le serveur → politique de rétention/cache/stream-through à décider.
* **Bande passante et coût serveur** : les générations produisent de gros fichiers.
* **Sécurité multi-tenant** : isolation stricte entre comptes utilisateurs.
* **Versioning des specs de formulaires** : survivre aux modifications de workflow (migration ou invalidation propre des layouts sauvegardés).
* **Choix technologique Android** (natif Kotlin vs Flutter vs React Native) : à trancher tôt car il impacte tout le projet.

---

## Rapport de bugs & statut du projet

### ÉTAT GÉNÉRAL DU PROJET

Le projet a subi une session de debug/optimisation/fonctionnalités complète. Tous les bugs critiques et importants sont corrigés. Le projet est stable et utilisable au quotidien.

---

### SUIVI DU PROJET

#### 🔀 Fusion — Phase 0 terminée

Branche `fusion/consolidation-aih` mergée dans **main** en fast-forward (**→ `2637dd7`**) — cf. `PLAN_FUSION.md` :

* **Licences** — LICENSE GPLv3 intégrale + THIRD-PARTY-NOTICES.md pour xterm.js (`629028c`)
* **Assets** — dé-hardcodage des chemins d'assets via helper dynamique `js/holaf_ext_base.js` (`438008a`)
* **Migration automatique des données Zones A/B** (dossier d'extension / répertoires utilisateur) via `holaf_migration.py`, validée 6/6 scénarios (`95e477d`)
* **Rename repo → ComfyUI-AI-Helper** — reporté à plus tard (opérations manuelles utilisateur)

#### 🔀 Fusion — Phase 1 terminée

Branche `fusion/consolidation-aih` mergée dans **main** en fast-forward (**→ `f31a734`**) — cf. `PLAN_FUSION.md` :

* **Nodes** — intégration des 24 nodes CUI-Holaf en clés `AIH*` avec alias legacy compatibles anciens workflows (`e544d36`)
* **Requirements** — ajout de `spandrel` / `av` / `numpy` (`23c1e11`)
* **Widgets JS** — matching dual-forme `AIH*`/`Holaf*` et ids `registerExtension` normalisés (`2ce784b`)
* **Validation** — simulation loader : 50 mappings résolus ; `py_compile` : 26 fichiers OK ; `node --check` : 5/5 JS OK

#### 🔀 Fusion — Fix menu

Branche `fusion/consolidation-aih` mergée dans **main** en merge `--no-ff` (**→ `b55d3c7`**) :

* **Cause** — `WEB_DIRECTORY` monté directement sous `/extensions/<pack>/` sans segment `js/` → l'ancien helper produisait des URL en 404 (CSS/xterm), menu sans style (`45fd9d8`)
* **Correctif** — helper `holaf_ext_base.js` durci par chaîne de fallbacks + terminal aligné, simulation 47/47 (`45fd9d8`)

#### 🔀 Fusion — Phase 2 terminée

Chantier principal réalisé directement sur **main** en commits conventionnels fins et révertibles (**25a921d → `c775f0c`**) — cf. `PLAN_FUSION.md` :

* **Socle backend partagé `aih/`** — port de `store` (miroir SQLite), `sync_engine`, `embedding_engine`, `local_source`, `credentials`, `llm_helper` derrière un bootstrap sys.path unique ; chargement exotique d'origine (pré-enregistrement `sys.modules` + importlib par chemin) éliminé (chantier A, commits 25a921d…1c7bf4b)
* **Nodes AIH** — intégration des 8 nodes (Elements Picker, Prompt Enhancer, Ideogram 4 Builder, Keywords, Ref Image Prep, LMStudio Settings, OpenAI Settings, Music) aux noms de fichiers d'origine : clés canoniques `AIH<PascalCase>` + alias legacy, catégories AIH/Prompting & AIH/Media, imports redirigés vers le socle `aih/` ; templates Music rapatriés dans `aih/templates/` (chantier B, commits e9cd5ef…c65841f)
* **Routes HTTP** — les 43 routes AIH vivent dans `aih/routes.py` (`register(server_routes)` appelé après bootstrap) : `/api/aih/models/*` SFTP chunked + fingerprint, mode local miroirs/embeddings/recherche sémantique/sync, frontend local servi sous `/aih/local/`, blobby exec sécurisé derrière l'auth du terminal Holaf (fail-closed 503 si garde absente), POST `/aih/update` sans auto-restart (redémarrage délégué au restart sécurisé d'Utils) ; WebSocket non authentifié du terminal AIH volontairement non porté — terminal unique Utils (chantier C, commits d34100a…09f54ee)
* **Widgets JS transverses** — Elements, Keywords, Enhance, Workflow Share, Model Browser, Modal v2, Blobby aux noms de fichiers d'origine avec loaders ordonnés `00_`–`04_` (helpers partagés déclarés avant leurs consommateurs) et matching dual-forme des clés renommées (chantier D, commit `fb0ca38`)
* **Menu principal** — boutons « AIH Update » et « AIH Restart » dans le menu Holaf Utilities, redémarrage via le restart sécurisé existant (chantier D, commit `4b9660e`)
* **Validation** — `py_compile` complet du pack ; harnais hors-ComfyUI store/sync 53/53 ; inventaire routes 43/43 vs source avec exécution réelle des handlers clés (traversal bloqué, auth blobby 401/fail-closed, update sur repos jetables) ; simulation loader ordonnée des widgets ; `node --check` ×11 JS OK ; matching dual-forme 28/28

#### 🔀 Fusion — Menu AI Helper restauré

Clôture du chantier réalisée directement sur **main** en commits conventionnels fins et révertibles (**`9b92cc8` + `4ac4cb7`**) — cf. `PLAN_FUSION.md` :

* **Bibliothèque menu AIH** — port des helpers du menu original en `js/aih_menu.js` (`window.AIHMenu`, pattern merge sûr, aucun bouton propre : l'intégration visuelle est déléguée au dropdown Holaf Utilities) (`9b92cc8`)
* **Réintégration dropdown** — toutes les entrées du menu original regroupées dans le dropdown orange Holaf Utilities (`js/holaf_main.js`), sans nouveau registerExtension ni bouton indigo recréé : 🌐 Open Webpage, 📤 Workflows, 📦 Models, 👥 Membres (modale draggable, tri admin→kw_editor→membres, avatars Discord) et ⚙️ Paramètres unifiés à deux onglets (« Compte » via `/aih/credentials`, « Provider LLM » avec CRUD presets distant + mode Client-side navigateur) (`9b92cc8` + `4ac4cb7`)
* **Toggle Blobby + Chat conditionnel** — lignes dédiées avec pastille ON verte/OFF grise dynamique, Chat visible uniquement quand Blobby est actif, aucune fermeture du menu au clic (`4ac4cb7`)
* **AIH Update enrichi** — modale d'origine restaurée : spinner + log git complet de `POST /aih/update`, puis proposition de redémarrage via le restart sécurisé `/holaf/utilities/restart` avec boucle de reconnexion automatique ; ancien flux toast conservé en fallback si le module est absent (`9b92cc8` + `4ac4cb7`)
* **Pied de statut serveur 4 états** — 🟢 connecté / 🟢 en ligne / 🟡 HTTP x / 🔴 hors ligne via `/api/stats` + `/api/auth/me` en parallèle (timeout 5 s Bearer) (`9b92cc8`)
* **Validation** — simulation du flux Update hors ComfyUI 11/11 ; `node --check` OK sur les JS touchés

#### 🔀 Fusion — Ajustements menu & paramètres

Quatre ajustements post-fusion réalisés directement sur **main** en commits conventionnels fins et révertibles (**`558e127` → `f4facb1`**) :

* **Settings Holaf à onglets** — la fenêtre Settings intègre désormais les paramètres AIH : General + AIH · Compte + AIH · Provider LLM ; l'entrée « Paramètres » séparée est supprimée du menu (`558e127`)
* **Retour à un seul bouton restart** — une unique entrée de redémarrage dans le menu, via le restart sécurisé existant (`657e03e`)
* **Purge kw.holaf.fr** — suppression complète des références codées en dur `kw.holaf.fr` (15 fichiers), remplacées par la configuration serveur avec dégradation propre et invitation à configurer (`62ed5c8`)
* **Blobby / Chat en WIP** — entrées Blobby et Chat déplacées dans le groupe WIP, masquées par défaut (`f4facb1`)

---

#### 🔀 Fusion — Unification UI complète (theming, dialogues, i18n, zoom)

Grand chantier d'unification réalisé après la Phase 2, pour faire disparaître l'origine multi-packs :

* **Thème en 4 axes orthogonaux** — MODE (`aih-mode-dark/light`, fenêtres grises) · ACCENT (`aih-accent-orange/blue/green/purple`, avec variante par mode pour la lisibilité) · HALO (lueur, case + **slider d'intensité** via `color-mix`) · HIGHLIGHT (contour coloré, case + **slider d'intensité**, indépendant du halo). Variables `--aih-*` = source de vérité, aliassées vers `--holaf-*` (panneaux). `AIH.Theme` : setMode/setAccent/setHalo/setHighlight + intensités, persistées (`AIH_Mode`, `AIH_Accent`, `AIH_Halo`, `AIH_Halo_Intensity`, `AIH_Highlight`, `AIH_Highlight_Intensity`).
* **Système de dialogues unifié `AIH.Dialog`** (`js/aih_dialog.js`) — open/alert/confirm/prompt/choose/busy ; garde keep-open ; autorité z-index ; wrappers de compat (`aihOpenModalV2` = shim fin vers AIH.Dialog ; `HolafModal` et `createDialog` conservés). Famille 3 (login/GitHub-search nodes manager) **volontairement non migrée** (createDialog insuffisant).
* **`aihWindowManager`** (holaf_window_utils.js) — autorité UNIQUE de z-index + état actif/halo partagée entre dialogues AIH et panneaux holaf (plus deux groupes séparés). Helpers partagés : `makeDraggable/makeResizable/makeContentZoomable/saveWindowRect/loadWindowRect`.
* **i18n complet** — `js/aih_i18n.js` (AIH.I18n : t/setLocale/addDict, FR défaut + EN) + dictionnaire central **`js/aih_strings.js`** (~1000 clés FR/EN, tous les modules migrés) + **sélecteur de langue** dans Settings ▸ General. Pattern : `import "./aih_strings.js"` + `t(k,p)` fallback clé brute. ⚠️ Pièges : i18n dans un template literal (backticks) = interpolation `${t(...)}`, PAS de concat `' + t(...) + '` (s'affiche littéralement).
* **Persistance unifiée** des positions/tailles (store `aih_window_rects` + migration legacy) ; dialogues transitoires (confirm/alert) restent centrés.
* **Zoom unifié** — variable canonique `--aih-zoom-factor` (contenu seul, header fixe, pattern Nodes Manager), boutons +/− standard dans TOUTES les barres de titre, persistance par fenêtre (`aih_zoom_levels`).
* **Renommage AIH** — tous les textes visibles « Holaf » → « AIH » (Model Manager, Nodes Manager, Image Viewer, Settings, Profiler, Terminal → AIH Terminal). Identifiants techniques (fichiers `holaf_*.js`, `registerExtension "Holaf.*"`, classes `holaf-*`, alias legacy de nodes) volontairement CONSERVÉS.

---

### GUIDE DE REPRISE (nouvelle session — conventions & architecture)

**Workflow :** tout travail DIRECTEMENT sur `main` ; l'utilisateur commit/push lui-même via son outil (les sessions ne font JAMAIS de `git commit`) ; l'outil de push ne détecte que les fichiers modifiés déjà suivis — penser à `git add` les fichiers NEUFS (ex. `aih_strings.js` avait été raté).

**Architecture UI (à connaître absolument) :**
* `AIH.Dialog` (js/aih_dialog.js) : système unique de dialogues + `AIH.Theme` (4 axes + intensités) + wrappers compat.
* `aihWindowManager` (holaf_window_utils.js) : z-index unique, fenêtre active unique (halo), drag/resize partagés, zoom (`--aih-zoom-factor`).
* `holaf_window_utils.js` : helpers de fenêtre + `saveWindowRect/loadWindowRect` (store `aih_window_rects`, clamps viewport).
* Thème : variables `--aih-*` sur `:root` (défauts dark) + classes body `aih-mode-*` / `aih-accent-*` / `aih-halo-off` / `aih-highlight-off` ; les panneaux holaf consomment les alias `--holaf-*`. Intensités halo/contour via `color-mix`.
* i18n : `AIH.I18n` + dictionnaire `js/aih_strings.js` (préfixes menu./settings./mb./wf./bl./nm./term./iv./mmu./mma./pr./rc./sc./lt./el./kw./en.). Langue persistée `aih_locale`, défaut FR.
* ⚠️ **WEB_DIRECTORY "js" est monté DIRECTEMENT à /extensions/<pack>/** : jamais de segment `js/` dans les URLs (cause du bug MIME historique). Les imports relatifs entre fichiers js/ racine fonctionnent ; le profiler (route alias `/holaf/profiler/app.js`) doit utiliser des imports DYNAMIQUES via `holafPackUrl`/`HOLAF_EXT_BASE` (les imports statiques relatifs y cassent le MIME).
* ⚠️ Les widgets AIH ont été **convertis en modules ES** (ils importent `aih_dialog.js`/`aih_strings.js`) ; l'ordre de chargement passe par le graphe d'imports.
* ⚠️ Firefox (utilisateur sur Floorp) applique strictement le MIME des modules et parse différemment : toujours valider avec `node --check --input-type=module`.

**Reste à faire (fusion & infra)** :
1. **Rename repo GitHub → ComfyUI-Ai-Helper** — EN COURS (l'utilisateur le fait maintenant) ; ensuite `git remote set-url origin <nouvelle URL>` + réinstallation des utilisateurs.
2. Désinstaller les anciens packs séparés (CUI-Holaf, AIH_Tools) chez les utilisateurs finaux.
3. Tests terrain restants : SFTP models, `/aih/local/`, auth Blobby (401 → invite login terminal).
4. `pip show spandrel` au déploiement (confirmer licence, MIT attendu).
5. Famille 3 (dialogues login/GitHub-search nodes manager) : non migrés vers AIH.Dialog — createDialog insuffisant, refonte dédiée si un jour nécessaire.
6. i18n : ajouter d'autres langues = un simple `addDict` par langue.

**Infra connue** : le proxy sd.holaf.fr a des soucis MIME sur certains chemins (.js imbriqués/404 → octet-stream) ; Authentik SSO protège pi.holaf.fr (hors scope pack) ; l'instance ComfyUI tourne sur 10.10.0.5:9001 (Python 3.14).

---

### FONCTIONNALITÉS IMPLÉMENTÉES

#### 🎨 Éditeur d'images — refonte « un slider par plage » (schéma `.edt` v2)

> Doc de planification historique : `image_editor_plan.md` (phases 1 & 3 terminées ; sa « Phase 2 » est désormais couverte ci-dessous).

**État : LIVRÉ et testé** — 23 tests pytest + 10 tests JS verts (2026-09-12).

**Schéma `.edt` v2 — contrôles tonaux par plage, effets spatiaux globaux**
- **Contrôles tonaux** (luminosité, contraste, saturation, teinte) portent désormais leurs valeurs **par bande** `{all, shadows, midtones, highlights}` — neutres `1/1/1/0` (gains à 1, teinte à 0), **clé absente = neutre**, ordre d'application **all → shadows → midtones → highlights** (séquentiel sur le résultat courant). Plusieurs contrôles du même type restent autorisés.
- **Effets SPATIAUX** (flou, pixeliser, vignettage, netteté) et **masques** conservent une valeur globale unique `value` (pas de bandes).
- **Raison** — les plages proposées pour les effets spatiaux n'étaient **JAMAIS appliquées** (bug latent front + back : badge affiché, effet global) → l'UI de plage est supprimée pour ces effets.
- **Migration v1 → v2** — à la lecture, **idempotente**, **SANS PERTE** : range `'all'` → `zones.all`, une bande → sa clé, range inconnu / vide / non-string → `'all'` (aligné sur le backend) ; champ `"v": 2` écrit au save. Preuve de non-régression **pixel-à-pixel** contre une copie figée du code pré-refonte (`tests/test_edit_schema_v2.py`).
- **Vidéo** — politique documentée : valeur plate = `zones.all` si non neutre, sinon contrôle ignoré (FFmpeg ne sait pas masquer par luminance).

**Picker « Ajouter un contrôle » — master-detail V4 (maquette validée)**
- Familles à gauche **avec compteur**, contrôles à droite, **icônes SVG** (fin des emojis), largeur **430px**, catégorie active orange.
- **MONO-ÉTAPE** (plus de choix de plage), **mémorisation de la dernière famille** + navigation clavier (**↑↓**, **↵**, **Échap**).

**Lignes de contrôle**
- **4 sliders par contrôle tonal** (pastille de teinte par bande) ; ligne **repliée = pastilles des SEULES bandes ≠ défaut**.
- **Double-clic** = reset du slider ciblé.
- **Libellés courts dédiés** (`iv.zoneShort*`) car « Tons moyens » / « Hautes lumières » étaient tronqués dans la colonne de 58px (formes longues conservées en **tooltip**).

**Base v1 conservée (toujours active)**
- **Sauvegarde automatique** — 500 ms après le dernier changement (plus de Save/Cancel) ; **Reset** supprime tous les réglages + le fichier `.edt`.
- **Compare mode** — overlay canvas original (gauche) / édité (droite) via `ctx.clip()`, suit la souris, compatible zoom/pan.
- **Aperçu temps réel** — CSS filter (GPU) quand tous les ranges sont `all`, sinon canvas pixel processing (downscale 1920px max + optimisations).
- **Transition plein écran fluide** — la miniature sert de placeholder pendant le chargement pleine taille (blur + spinner si > 1 s).
- **Suppression optimiste** — delete en zoom/éditeur → retrait immédiat de la galerie + navigation vers la suivante, rollback si échec.

**Fichiers touchés**
- **Backend** — `holaf_image_viewer_backend/logic.py`, `holaf_image_viewer_backend/routes/edit_routes.py`, `tests/test_edit_schema_v2.py` (nouveau), `tests/test_crop_standalone.py` (étendu).
- **Frontend** — `js/image_viewer/image_viewer_editor_model.js` (nouveau module modèle pur), `js/image_viewer/image_viewer_editor.js`, `js/css/holaf_image_viewer.css`, `js/aih_strings.js`, `js/test_iv_editor_v2.mjs` + `js/test_iv_editor_dom.mjs` (nouveaux).

**Déjà documenté / acté avant la refonte (rappel)**
- Crop appliqué **EN DERNIER** (insensible au mask, normalisé 0-1).
- Masques **multi-couches** (un masque remplace la zone active pour les contrôles suivants).
- Brique `holaf-viewport` pour zoom/pan.
- `AIH.Dialog` = système de fenêtres unique.

**Bugs corrigés dans la foulée**
- **Menu du pack passant SOUS la galerie** — cause : z-index inline `10005` du dropdown écrasant le `100000` du CSS, sous l'overlay plein écran du viewer (`10999`), alors qu'il passait au-dessus des modales. Fix : bandes de couches uniques `AIH_POPUP_Z=50000` (menu) / `AIH_MODAL_Z=90000` (modales), panneaux plafonnés sous le menu, `bringToFront` par bande. Ordre final : **panneaux < overlay viewer < menu < modales < picker < toasts**. Test `test_aih_zlayers.mjs` + preuves headless.
- **Sliders d'effets incohérents (zones + vignettage)** — cause : la preview repartait du canvas **DÉJÀ modifié** au lieu de l'image d'origine (bug **PRÉ-EXISTANT**, prouvé identique dans le code d'avant la refonte) → application cumulative à chaque re-rendu. Fix : base reconstruite depuis `_originalImgData` (rendu idempotent, monotone dans les deux sens) ; mesures avant/après au banc chromium.

**RESTE À FAIRE — prochain chantier déclaré**
- **Phase 2** — refonte de la **ZONE D'EFFETS EMPILÉS** (les lignes de contrôle) ; inclut la correction du **débordement de la ligne MASQUE** (grid `80px 65px 1fr auto` + 5 boutons ≈ 313px fixes pour 300px dispo → slider écrasé, ~1px de débordement mesuré).
- **Option** — intégrer le **banc de repro chromium** (accumulation zones/vignette) comme test permanent ; le runner JS du pack est en **node**.
- **Limites connues documentées** — parité preview↔export approximative par conception (rampes JS `/128` vs LUT backend `/64`-`/127`, vignette gradient radial vs falloff numpy) ; perf preview **O(l×h×passes)** avec canvas plafonné 1920px ; race possible au premier rendu (repli sur le fast-path CSS) ; défauts appliqués dès l'ajout d'un contrôle (vignette 0.5, flou 8, pixelise 12).
- **Candidats évoqués** — brique viewport v0.2 (pinch/touch), slideshow, gestion des fichiers corrompus, panneau de log de session.

**DETTES / DÉCISIONS OUVERTES (issues des reviews, non bloquantes)**
- Brique `holaf-modal` re-vendue en **0.4.0** mais **NON consommée** : décision à prendre (la retirer ou la garder alignée).
- Variables locales `t` masquant le helper i18n `t()` dans 4 fichiers (`aih_workflow_share.js`, `holaf_panel_manager.js`, `blobby_companion.js`, `profiler/holaf_profiler.js`) : foot-gun → renommage préventif ou règle lint `no-shadow`.
- `p.id` non encodé (`encodeURIComponent`) dans 2 URLs d'API de presets (`aih_menu.js`).
- `run_tests.sh` sort `0` quand node est absent (exit code « vert » en CI malgré une ligne finale honnête).
- Route dédiée pour servir `manifest.json` en `application/json` (micro-tâche).

#### 🧩 Autres chantiers de la session (pour mémoire)

- **Sonde de redémarrage fiabilisée** derrière Authentik (`GET /system_stats`, credentials `include` + `redirect: manual` + validation de shape) ; bouton « Actualiser » désactivé jusqu'au retour réel.
- **Toasts déplacés en bas-centré** (brique `holaf-toast` v0.5.0, positions configurables ; vendu == lib).
- **Couleur d'accent/highlight appliquée globalement** (purge des classes legacy sur `body`).
- **Suppression d'un membre** implémentée côté pack (route `DELETE /api/admin/users/{id}`) + feedback d'erreur sur la page admin web.
- **Corrections de sécurité de la review** (échappement HTML généralisé dans `aih_menu.js`, fix XSS pré-existant de l'onglet Provider LLM) ; suite JS enfin branchée dans `run_tests.sh` avec récap PASS/FAIL/SKIP non trompeur.

#### 🖼️ Galerie
- **Scrolling virtualisé** — Seuls les éléments visibles sont rendus dans le DOM
- **Object pool** — Les placeholders DOM sont recyclés (pas de createElement à chaque scroll)
- **LRU cache** — 2000 thumbnails en cache mémoire
- **Tri** — Toujours les plus récents en premier (`ORDER BY mtime DESC`)
- **Filtres** — Dossiers (top_level_subfolder), formats (uniquement ceux présents), dates, tags, recherche textuelle
- **Chargement optimiste** — Les images supprimées disparaissent immédiatement
- **Polling updates** — Détection des nouvelles images toutes les 5s (skip pendant le scroll)

#### 🖥️ Performance
- **Thumbnail worker** — File d'attente prioritaire (visible > pending), 6 concurrents, retry avec backoff
- **Watcher filesystem** — Auto-restart en cas de crash, fallback poller scandir incrémental si inotify saturé
- **Sync périodique** — Toutes les 30s (filet de sécurité, cf. fix watcher ; était 120s après les 10 fixes). Supprime les thumbnails orphelins
- **Folder metadata** — Incrémental (était full rebuild par image)
- **Worker DB connection** — Persistante pendant l'idle (pas de connect/déconnect toutes les 5s)
- **Thumbnail cleanup** — Orphelins supprimés pendant le sync (pas seulement manuellement)
- **Galerie** — `_doKick` limité à 20 cache hits/tick, `textContent` pour bulk DOM removal
- **Éditeur** — Downscale à 1920px max pour le canvas preview, contrôles 'all' séparés des ranged, pas de closures dans la boucle pixel

#### ⚡ Performance galerie — commité/poussé (10 fixes, f9975fa + 89174e1)

- **Backend — arrêt du refresh perpétuel** (`holaf_image_viewer_backend/logic.py`) — `sync_image_database_blocking()` ne bump `LAST_DB_UPDATE_TIME` que si un pass détecte des changements (compteurs added/deleted/changed). Avant : bump inconditionnel toutes les 30s → le frontend re-fetchait les 30k images toutes les 30s en boucle. Cause racine du refresh lent après une nouvelle image, des freezes d'onglet et des placeholders gris
- **Backend — sync allégé** (`logic.py` + `__init__.py`) — Intervalle de sync 30s → 120s ; `_update_folder_metadata_cache_blocking` (DELETE + rebuild complet) ne tourne que si des changements sont détectés
- **Backend — génération de thumbnails bornée** (`routes/thumbnail_routes.py` + `logic.py`) — Génération inline capée via `threading.Semaphore(2)` ; si occupée, la route renvoie 202 + `Retry-After: 2` + no-store au lieu d'une génération PIL illimitée (jusqu'à ~20 threads concurrents saturant le CPU) ; `optimize=False` dans `_create_thumbnail_blocking` (~30-50% plus rapide) ; thumbnails servis via `web.FileResponse` avec `Cache-Control: max-age=31536000, immutable`
- **Backend — nouvelle route image pleine taille** (`routes/image_routes.py`, enregistrée dans `__init__.py`) — `GET /holaf/images/full?path_canon=...&mtime=...` streame le fichier ORIGINAL avec `Cache-Control: max-age=31536000, immutable` (ETag depuis mtime/thumb_hash), même whitelist de chemins que les thumbnails. Le plein écran ne dépend plus de la route ComfyUI `/view`
- **Backend — liste incrémentale** (`routes/image_routes.py`) — `POST /holaf/images/list` accepte un `min_mtime` optionnel → ne retourne que les images avec `mtime > min_mtime` (mêmes champs, `mtime DESC`) ; sans lui, liste complète comme avant
- **Frontend — refresh incrémental** (`js/holaf_image_viewer.js`) — `checkForUpdates` calcule le top mtime depuis le state et ne fetch que le delta via `min_mtime` ; 0 item → rien à faire ; N items → fusionnés en haut du state (dédupe par `path_canon`) ; DOM des filtres reconstruit seulement si la signature dossier/formats change (`_filterSignatureChanged`) ; premier load = fetch complet ; early-return sur `folder_filters` vide préservé
- **Frontend — insertion de delta** (`js/image_viewer/image_viewer_gallery.js`) — `insertImagesAtTop()` ajoute les nouvelles thumbnails en haut via le `renderVisibleItems` virtualisé existant (réutilise les placeholders, ne crée du DOM que pour le delta) — chemin du load initial 30k (syncGallery rebuild complet + force rebuild liste vide) intact. Pas de pagination, pas de création différée — contraintes utilisateur respectées
- **Frontend — priorisation des thumbnails visibles** (`image_viewer_gallery.js`) — `renderVisibleItems` collecte les chemins visibles non cachés → `POST /holaf/images/prioritize-thumbnails` (debounce 300ms, flush 1000, fire-and-forget). Active la file de priorité backend jusque-là morte (`thumbnail_status=1`)
- **Frontend — route cache image pleine taille** (`js/image_viewer/image_viewer_navigation.js`) — `getFullImageUrl` pointe vers `/holaf/images/full` avec cache-buster mtime au lieu de ComfyUI `/view`
- **Frontend — gestion du 202 en attente** (`image_viewer_gallery.js`) — fetch thumbnail 202 → placeholder gris conservé, retry programmé après `Retry-After` (2s par défaut) via la map dédiée `pendingThumbnailRetries` (aucune collision avec `idleRestartTimer`) ; prefetch early-return aussi sur 202
- **Code mort activé** — le flag `viewer_is_active` (`worker.py:40`, set par `utility_routes.py:28`) et l'endpoint `/holaf/images/prioritize-thumbnails` existaient mais n'étaient jamais utilisés par le frontend — désormais câblés

#### 👁️ Fix watcher — scandir poller (`worker.py` + `__init__.py`, working tree — à pousser)

- **Cause racine** — Limite de watches inotify atteinte (`[Errno 28] ENOSPC`) sur le Docker de l'utilisateur avec 32k images → fallback watchdog `PollingObserver` qui n'émet JAMAIS d'événements sur le FS du conteneur (snapshot full-tree de 32k fichiers trop lent à diff) → les nouvelles images n'étaient détectées que par le sync périodique (120s) → la galerie prenait jusqu'à 2 min à afficher une nouvelle image
- **Fix** — `PollingObserver` remplacé par un poller incrémental custom basé sur `scandir` (`worker.py`) : détection add/delete par nom avec cache en mémoire, intervalle de scan ~2.5s, pas de `stat` par fichier pour les fichiers inchangés (léger même avec 32k fichiers), warm-up du baseline sans émettre d'événements, print par événement ("Detected creation/deletion")
- **Sync 120s → 30s** — Filet de sécurité pour les content updates/renames ; le sync ne bump le timestamp DB que sur de vrais changements → pas de refreshes fantômes
- **COUNT skip (commité 89174e1)** — La requête COUNT (~900ms) n'est plus exécutée sur les requêtes de liste incrémentale (`min_mtime`) (`image_routes.py`) → elle ne tourne plus à chaque check delta de 5s

#### ⌨️ Fix terminal — PTY session lifecycle (`holaf_terminal.py`, commit `994a27a` — ✅ validé production)

- **Ctrl+D → session morte après re-login** — Durcissement du cycle de vie des sessions PTY (« harden PTY session lifecycle ») : reconnexion propre après Ctrl+D, une nouvelle session est créée au re-login au lieu d'hériter d'une session morte
- **Validation terrain** — Corrigé et VALIDÉ par l'utilisateur en conditions réelles après déploiement (`994a27a` + compléments côté lifecycle)

---

### CORRECTIONS DE BUGS

#### 🔴 Critiques (3)

| # | Fichier | Problème | Correctif |
|---|---------|----------|-----------|
| 1 | `edit_routes.py` | Fuite mémoire `_video_processing_locks` | Restructuration du return |
| 2 | `holaf_terminal.py` | Deadlock déconnexion client | `asyncio.wait(FIRST_COMPLETED)` + terminate PTY |
| 3 | `holaf_profiler_engine.py` | Thread monitor en doublon | Toujours créer nouveau thread + join |

#### 🟠 Importants (3)

| # | Fichier | Problème | Correctif |
|---|---------|----------|-----------|
| 4 | `logic.py` | `UnidentifiedImageError` → boucle infinie | `thumbnail_status = 3` |
| 5 | `dependency_manager.py` | RIFE supprimé avant move → perte données | Backup avant suppression |
| 6 | `holaf_terminal.py` | Variables potentiellement unbound dans `finally` | `try/except NameError` |

#### 🟡 Modérés (3)

| # | Fichier | Problème | Correctif |
|---|---------|----------|-----------|
| 7 | `logic.py` | `ImageFont` non importé globalement | Ajout à l'import PIL |
| 8 | `logic.py` | Import `uuid` mort | Supprimé |
| 9 | `worker.py` | Watcher filesystem mourait silencieusement | Auto-restart avec retry 10s |

#### ⚪ Mineurs / Frontend (6)

| # | Fichier | Problème | Correctif |
|---|---------|----------|-----------|
| 11 | `image_viewer_infopane.js` | Ctrl+A sélectionnait toute la page | Event listener `capture: true` |
| 12 | `holaf_image_viewer.css` | Boutons "All/None/Invert" défilent | `position: sticky; top: 0` |
| 13 | `image_viewer_actions.js` | Balise `</div>` orpheline → boutons hors dialog | Wrappé le `<span>` dans un `<div>` |
| 14 | `holaf_image_viewer.css` | Export dialog sans max-height | `max-height: 90%` + flex column |
| 15 | `holaf_shared_panel.css` | `createDialog`/`HolafModal` sans max-height | Même pattern appliqué |

#### 🔧 Harmonisation modales (3)

- `createDialog` étendu : `messageElement` (DOM custom) + close-on-overlay-click + `min-height: 0`
- `HolafModal` → `createDialog` pour "Not Implemented". Reste uniquement pour le restart
- CSS unifié : `max-height: 90vh` + `overflow: hidden` + content scrollable + footer fixe

#### 🔒 Code review fixes (5)

| # | Problème | Correctif |
|---|----------|-----------|
| 1 | `_rangedPreviewPending` jamais mis à `true` | Set avant async, clear dans `finally` |
| 2 | Event listener leak dans `_toggleCompareMode` | Cleanup `_compareCleanups` avant re-création |
| 3 | Hue dropped quand ranged controls actifs | Ajout RGB→HSV→RGB dans canvas pixel loop |
| 4 | `_compareRefresh` faisait full teardown | `_compareFilterDirty` flag |
| 5 | `_cancelEdits` + `_hide` sans cleanup | Ajouté les cleanups |

#### ⚡ Performance (4)

| # | Fichier | Changement |
|---|---------|------------|
| 1 | `__init__.py` | Sync périodique 300s → 30s |
| 2 | `image_viewer_gallery.js` | `_doKick` limité à 20 cache hits/tick |
| 3 | `holaf_image_viewer.js` | `checkForUpdates` skip pendant le scroll |
| 4 | `image_viewer_gallery.js` | `textContent` au lieu de `removeChild` en boucle |

#### 🎨 Refonte éditeur (12 changements)

- Système de contrôles empilables (add/remove/duplicate)
- Format `.edt` nouveau avec migration automatique
- Range masking (All/Shadows/Midtones/Highlights)
- Hue en canvas (RGB→HSV→RGB)
- Compare mode (canvas overlay avec `ctx.clip()`)
- Compare + ranged (rechargement de `editImg`)
- Compare caché pour les vidéos
- Preview CSS filter (GPU) si tous 'all', canvas sinon
- Debounce 16ms + anti-concurrence `_rangedPending`
- Cache anti-cascade basé sur `dataset.originalSrc`
- Sauvegarde automatique 500ms (plus de Save/Cancel)
- Auto-save tokenisé + sérialisé (pas de sauvegardes concurrentes)

---

### BUGS RESTANTS CONNUS

| Bug | Sévérité | Statut |
|-----|----------|--------|
| Freeze onglet au lancement (jaune = JS) | 🟠 | Grandement réduit — cause racine identifiée et supprimée (boucle de refresh perpétuelle). Risques restants : décodage fullscreen, build initial des 30k éléments DOM. |
| Bouton "Copy Prompt" cassé | 🟡 | Déjà corrigé par l'utilisateur |
| Bouton "Load Workflow" standalone | 🟡 | Déjà corrigé par l'utilisateur |
| CSS dupliqué dans templates HTML | ⚪ | Cosmétique |

---

### FICHIERS SUPPRIMÉS

| Fichier | Raison |
|---------|--------|
| `GEMINI.md` | Artefact de l'IA génératrice. Référençait des fichiers inexistants. |

---

*39 corrections au total. Projet stable et fonctionnel.*
