# PLAN DE FUSION — CUI-Holaf-Utils

> Fusion des trois extensions ComfyUI de l'auteur grokuku en un pack unique : **CUI-Holaf-Utils**, renommé ensuite **ComfyUI-AI-Helper** (marque AIH unifiée).
>
> | Repo | Rôle dans la fusion |
> |---|---|
> | `CUI-Holaf-Utils` (cible) | Pack fusionné final ; renommé `ComfyUI-AI-Helper` en fin de Phase 0 (cf. §3.11) |
> | `CUI-Holaf` | Source : pack GPL v3 de 27 nodes |
> | `AI-Helper` (extension ComfyUI de l'ancien monorepo) | Source : sous-dossier uniquement (backend Flask, site frontend et app Android **restent** dans le monorepo AI-Helper et ne sont **pas** fusionnés) |

---

## 1. Objectif et périmètre

### Objectif
Fusionner dans **CUI-Holaf-Utils** :
- les **24 nodes** conservées de CUI-Holaf ;
- les **8 nodes** conservées d'AIH ;
- leurs **widgets JS** associés ;
- l'**infrastructure AIH** listée plus bas.

Puis **renommer le repo `ComfyUI-AI-Helper`** : unification de la marque AIH, alignement avec l'écosystème AI Helper produit sans conflit de nom direct. Ce renommage est soumis au prérequis de dé-hardcodage décrit en §3.11 et intervient idéalement dès la fin de la Phase 0 ; les données existantes (zone « dossier d'extension » et zone « répertoires utilisateur ») sont quant à elles **migrées automatiquement** vers les nouveaux emplacements au premier démarrage suivant le renommage (cf. §3.11, « Migration automatique des données »).

### Hors périmètre (restent dans le monorepo AI-Helper)
- Backend Flask AIH distant (URL pilotée par la configuration, cf. §3.11 dé-hardcodage) ;
- Site frontend ;
- Application Android.

### Historique git
- **Aucune migration d'historique git** : fusion fraîche, sans préservation des commits des repos sources.

---

## 2. Inventaire des décisions

### 2.1 Nodes

| Origine | Node | Décision | Note |
|---|---|---|---|
| CUI-Holaf | Save Media | ✅ Gardée | |
| CUI-Holaf | Tiled KSampler | ✅ Gardée | |
| CUI-Holaf | Image Comparer | ✅ Gardée | |
| CUI-Holaf | Upscale | ✅ Gardée | |
| CUI-Holaf | Overlay | ✅ Gardée | |
| CUI-Holaf | Resolution Preset | ✅ Gardée | |
| CUI-Holaf | Resolution Preset v2 | ✅ Gardée | |
| CUI-Holaf | Instagram Resize | ✅ Gardée | |
| CUI-Holaf | LUT Generator | ✅ Gardée | |
| CUI-Holaf | LUT Saver | ✅ Gardée | |
| CUI-Holaf | Mask to Boolean | ✅ Gardée | |
| CUI-Holaf | Bypasser | ✅ Gardée | |
| CUI-Holaf | Group Bypasser | ✅ Gardée | |
| CUI-Holaf | Simple Bypasser | ✅ Gardée | |
| CUI-Holaf | Remote | ✅ Gardée | |
| CUI-Holaf | Remote Selector | ✅ Gardée | |
| CUI-Holaf | Load Image/Video | ✅ Gardée | |
| CUI-Holaf | Image Batch Slice | ✅ Gardée | |
| CUI-Holaf | Text Box | ✅ Gardée | |
| CUI-Holaf | To Text | ✅ Gardée | |
| CUI-Holaf | Image Adjustment | ✅ Gardée | |
| CUI-Holaf | Bundle Creator | ✅ Gardée | |
| CUI-Holaf | Bundle Extractor | ✅ Gardée | |
| CUI-Holaf | Auto Select x2 | ✅ Gardée | |
| CUI-Holaf | KSampler standard | ❌ Abandonnée | Cohérent avec l'exclusion de la stack diffusers |
| CUI-Holaf | Video Preview | ❌ Abandonnée | Cohérent avec l'exclusion de la stack diffusers |
| CUI-Holaf | Nucleus-Image | ❌ Abandonnée | Cohérent avec l'exclusion de la stack diffusers |
| AIH | Elements Picker | ✅ Gardée | |
| AIH | Prompt Enhancer | ✅ Gardée | |
| AIH | Ideogram 4 Builder | ✅ Gardée | |
| AIH | Keywords | ✅ Gardée | |
| AIH | Ref Image Prep | ✅ Gardée | Clé renommée : `"AIH Ref Image Prep"` (avec espaces) → `AIHRefImagePrep` (normalisation §3.7) ; l'ancienne clé reste servie par l'alias legacy |
| AIH | LMStudio Settings | ✅ Gardée | |
| AIH | OpenAI Settings | ✅ Gardée | |
| AIH | Music | ✅ Gardée | + `templates/` de prompts rapatriés |
| AIH | Diagnostic | ❌ Abandonnée | |
| AIH | Preview | ❌ Abandonnée | |

**Totaux : 24 nodes CUI-Holaf gardées / 3 abandonnées ; 8 nodes AIH gardées / 2 abandonnées.**
Zéro collision de noms constatée lors de l'analyse préalable (préfixes `Holaf*` vs `AIH*`).

### 2.2 Infrastructure

| Élément | Décision | Détail |
|---|---|---|
| Système `credentials.json` | ✅ Gardé | |
| `_llm_helper` (Ollama / OpenAI / vision) | ✅ Gardé | |
| Routes `/api/aih/models/*` | ✅ Gardées | SFTP chunked + fingerprint |
| Mode miroir local complet | ✅ Gardé | `store.py` + `sync_engine` + `embedding_engine` + `local_source` + routes `/aih/local/*` — fallback voulu si le site tombe |
| Blobby Companion | ✅ Gardé | |
| Widgets JS transverses | ✅ Gardés | Model Browser, Workflow Share, Modal v2 |
| Frontend local | ✅ Gardé | Servi via `/aih/local/*` |
| Bouton **Update** | ✅ Conservé (modifié) | `git pull` ; si une mise à jour est appliquée → propose le redémarrage ; s'appuie sur le mécanisme de restart sécurisé d'Utils |
| Bouton **Restart** | ✅ Conservé (modifié) | Autonome, indépendant du bouton Update |
| Anciennes routes `/aih/update` et `/aih/restart` | 🔁 Remplacées | Par la mécanique unifiée Update / Restart ci-dessus |
| Terminal | ✅ **Tranché : terminal unique Utils** | Ancien point ouvert « terminal hybride » clos : conservation du **seul terminal de CUI-Holaf-Utils** (authentifié par mot de passe hashé) ; le terminal AIH non authentifié est **supprimé lors de la fusion**, sans hybridation ; les dépendances xterm.js vendored sont déjà côté Utils (déduplication naturelle) |
| Reconnexion de session du terminal | ✅ **Implémentée et validée** | Correctif Ctrl+D → login → nouvelle session fraîche livré dans `holaf_terminal.py` + `js/holaf_terminal.js`, **validé en conditions réelles** ; à **préserver tel quel** pendant toutes les phases de fusion — aucune régression autorisée sur ces deux fichiers |

---

## 3. Dédoublements et adaptations techniques

| # | Sujet | Décision / action |
|---|---|---|
| 3.1 | **AnyType en doublon** (`nodes/holaf_utils.py` de CUI-Holaf vs copie locale dans `holaf_remote_comparer.py`) | **Unifier** : une seule implémentation partagée dans le pack fusionné. |
| 3.2 | **Homonymie `holaf_utils.py`** (racine d'Utils ≠ `nodes/holaf_utils.py` de CUI-Holaf) | **Renommer** celui venant de CUI-Holaf en `holaf_node_helpers.py`. |
| 3.3 | **Auto pip install au boot d'AIH** | **Supprimé.** Remplacé par un `requirements.txt` unique pour le pack fusionné : `numpy`, `Pillow`, `spandrel`, `av`, `paramiko`, `requests` + dépendances existantes d'Utils : `psutil`, `pywinpty`, `aiofiles`, `orjson`, `watchdog`, `python-xmp-toolkit`, `aiohttp`, `pynvml`. |
| 3.4 | **Enregistrement des nodes CUI-Holaf** | Utils charge dynamiquement chaque fichier de `nodes/` en lisant `module.NODE_CLASS_MAPPINGS` par fichier, alors que CUI-Holaf utilise un registre central dans son `__init__.py`. Deux options au choix de l'implémenteur : (a) adapter les 24 fichiers pour exposer chacun leur propre `NODE_CLASS_MAPPINGS`, ou (b) conserver/intégrer leur registre central. **Le choix retenu devra être documenté dans le code ou dans ce document.** |
| 3.5 | **`__init__.py` racine AIH (~1812 lignes)** | **Refactoring obligatoire** : suppression du chargement exotique via `sys.modules` pré-enregistrés (~35 routes HTTP inline), standardisation des imports, conservation du préfixe `/aih/*` des routes. |
| 3.6 | **Routes HTTP** | Disjointes après vérification : `/holaf/*` (Utils/CUI-Holaf) vs `/aih/*` (AIH). Aucun changement de namespace requis. |
| 3.7 | **Normalisation des noms de nodes** | Marque unique **AIH** : clés de mapping `AIH<PascalCase>`, labels préfixés « AIH », arbre de catégories racine `AIH/`, alias legacy obligatoires — détail complet ci-dessous. |
| 3.8 | **Dossiers web JS** | Différents entre les deux sources (aucun conflit). Utils hardcode `/extensions/ComfyUI-Holaf-Utilities/` dans son JS : valide uniquement tant que le dé-hardcodage (§3.11) n'est pas réalisé ; après dé-hardcodage, ces chemins deviennent dynamiques (dérivés de l'URL du script chargé) et survivent au renommage du dossier. |
| 3.9 | **Chemins de persistance** | Sans collision : `user/default/aih/` (AIH) vs `.cache/` (Utils). Aucune migration nécessaire. **Précision post-chantier A (Phase 2)** : après fusion, le pack écrit donc dans DEUX racines utilisateur distinctes — `user/default/aih/` pour tout le socle AIH (credentials.json, openai_keys.json, aih_elements_presets.json, data/aihelper.db — conservé tel quel pour compatibilité des données AI-Helper existantes, cf. `aih/store.py` / `aih/credentials.py`) et `user/default/AI-Helper/` pour les sous-systèmes Holaf (`holaf_user_data_manager`, ROOT_NAME="AI-Helper"). Noms distincts, aucune collision même sur filesystem insensible à la casse. ⚠️ Anomalie historique préservée : les refs music3 mirroirées par `sync_engine.sync_music3_local()` vivent sous `user/default/aihelper/data/music3/` (héritage de l'ancien layout pré-`aih/` d'AI-Helper), PAS sous `user/default/aih/` — ne pas « corriger » sans migration des données utilisateurs. Une unification éventuelle des deux racines est différée. |
| 3.10 | **Double installation** | Vérifier qu'après migration, aucun ancien repo (CUI-Holaf ou l'extension ComfyUI de l'ancien monorepo AI-Helper copiée séparément) ne reste installé en parallèle dans `custom_nodes/` → risque de double enregistrement des nodes/routes. |
| 3.11 | **Renommage du repo → `ComfyUI-AI-Helper`** | Marque AIH unifiée. **Prérequis bloquant** : dé-hardcodage des chemins `/extensions/ComfyUI-Holaf-Utilities/` + audit complet des occurrences du nom en Python/JS (classement : stockage utilisateur migré automatiquement vs assets à dynamiser). Timing : dé-hardcodage en Phase 0, rename possible dès la fin de la Phase 0 — détail ci-dessous. |

### 3.7 Normalisation des noms de nodes

Marque unique **AIH** : abandon du double branding `Holaf*` / `AIH*` au niveau du nommage visible dans ComfyUI (clés de mapping, labels affichés, catégories de menu).

#### Convention actée

| Aspect | Règle | Exemple |
|---|---|---|
| Clé de mapping | `AIH<PascalCase>`, sans suffixe `Node` | `AIHSaveMedia` (pas `AIHSaveMediaNode`) |
| Nom affiché (label ComfyUI) | Toujours préfixé `AIH ` | `AIH Save Media` |
| Catégories de menu | Arbre unique, racine `AIH/` | `AIH/Flow Control` |

Style menu : **couleur orange historique conservée**, mise en œuvre avec le **style de menu AI Helper** (décision D6).

Arbre de catégories unique, racine `AIH/` :

| Catégorie | Nodes |
|---|---|
| `AIH/Image` | Overlay, Upscale, Instagram Resize, Adjustment, Batch Slice, Resolution Presets |
| `AIH/IO` | Save Media, Load Image/Video |
| `AIH/Sampling` | Tiled KSampler |
| `AIH/Masking` | Mask to Boolean |
| `AIH/LUT` | Generator, Saver |
| `AIH/Flow Control` | Bypasser, Group Bypasser, Simple Bypasser, Auto Select x2, Remote, Remote Selector |
| `AIH/Text` | Text Box, To Text |
| `AIH/Bundles` | Creator, Extractor |
| `AIH/View` | Image Comparer, Remote Comparer |
| `AIH/Prompting` | Elements Picker, Prompt Enhancer, Ideogram 4 Builder, Keywords, LMStudio Settings, OpenAI Settings |
| `AIH/Media` | Ref Image Prep, Music |

#### Table de renommage complète (ancienne clé → nouvelle clé)

Nodes ex-CUI-Holaf :

| Ancienne clé | Nouvelle clé |
|---|---|
| `HolafSaveMedia` | `AIHSaveMedia` |
| `HolafTiledKSampler` | `AIHTiledKSampler` |
| `HolafImageComparer` | `AIHImageComparer` |
| `UpscaleImageHolaf` | `AIHUpscale` |
| `HolafOverlayNode` | `AIHOverlay` |
| `HolafResolutionPreset` | `AIHResolutionPreset` |
| `HolafResolutionPresetV2` | `AIHResolutionPresetV2` |
| `HolafInstagramResize` | `AIHInstagramResize` |
| `HolafLutGenerator` | `AIHLutGenerator` |
| `HolafLutSaver` | `AIHLutSaver` |
| `HolafMaskToBoolean` | `AIHMaskToBoolean` |
| `HolafBypasser` | `AIHBypasser` |
| `HolafGroupBypasser` | `AIHGroupBypasser` |
| `HolafSimpleBypasser` | `AIHSimpleBypasser` |
| `HolafRemote` | `AIHRemote` |
| `HolafRemoteSelector` | `AIHRemoteSelector` |
| `HolafLoadImageVideo` | `AIHLoadImageVideo` |
| `HolafImageBatchSlice` | `AIHImageBatchSlice` |
| `HolafTextBox` | `AIHTextBox` |
| `HolafToText` | `AIHToText` |
| `HolafImageAdjustment` | `AIHImageAdjustment` |
| `HolafBundleCreator` | `AIHBundleCreator` |
| `HolafBundleExtractor` | `AIHBundleExtractor` |
| `HolafAutoSelectX2` | `AIHAutoSelectX2` |
| `HolafRemoteComparer` | `AIHRemoteComparer` |

Nodes ex-AIH :

| Ancienne clé | Nouvelle clé |
|---|---|
| `AIHElementsNode` | `AIHElementsPicker` |
| `AIHEnhanceNode` | `AIHPromptEnhancer` |
| `AIHIdeogram4Node` | `AIHIdeogram4Builder` |
| `AIHKeywordsNode` | `AIHKeywords` |
| `"AIH Ref Image Prep"` (avec espaces) | `AIHRefImagePrep` |
| `AIHLMStudioSettingsNode` | `AIHLMStudioSettings` |
| `AIHOpenAISettingsNode` | `AIHOpenAISettings` |
| `AIHMusicNode` | `AIHMusic` |

#### Mécanisme d'alias legacy (obligatoire)

- Chaque ancienne clé doit **continuer d'exister dans `NODE_CLASS_MAPPINGS`** et pointer vers la **même classe** que sa nouvelle clé : les vieux workflows restent compatibles indéfiniment.
- La table d'alias **n'est jamais purgée**.
- Les nouveaux workflows sauvegardent les nouvelles clés.

#### Protections anti-casse

- Les fichiers internes Python/JS et les identifiants d'enregistrement des extensions JS **ne changent pas** : seul le nommage visible dans ComfyUI est rebrandé.
- Le nom du dossier d'extension reste inchangé **par défaut** ; il **POURRA changer** (via le renommage du repo en `ComfyUI-AI-Helper`, §3.11) **UNIQUEMENT après** l'accomplissement de l'item « Dé-hardcodage des chemins d'extension ». Tant que ce prérequis n'est pas satisfait, aucun changement de nom.
- Ne pas casser les chemins codés en dur `/extensions/ComfyUI-Holaf-Utilities/` tant que le dé-hardcodage n'est pas réalisé (cf. §3.8 / §3.11).

---

### 3.11 Renommage du repo → ComfyUI-AI-Helper

Décision : le repo cible `ComfyUI-Holaf-Utils` sera **renommé `ComfyUI-AI-Helper`** — marque AIH unifiée, alignement avec l'écosystème AI Helper produit sans conflit de nom direct.

#### Prérequis bloquant : dé-hardcodage des chemins d'extension

Le dossier d'extension changera de nom chez les utilisateurs (`custom_nodes/ComfyUI-Holaf-Utilities/` → `custom_nodes/ComfyUI-AI-Helper/`) → tous les chemins actuellement codés en dur `"/extensions/ComfyUI-Holaf-Utilities/"` présents dans le JS casseraient. À réaliser **AVANT tout renommage** :

1. **Rendre DYNAMIQUES tous les chemins JS codés en dur** `"/extensions/ComfyUI-Holaf-Utilities/"` : dérivation depuis l'URL du script chargé (ex. `import.meta.url`, ou lecture du `src` du tag `<script>`).
2. **Auditer TOUTES les occurrences** du nom `ComfyUI-Holaf-Utilities` dans le **Python et le JS** (grep complet du code), puis classer **chaque occurrence** :
   - **chemin de stockage utilisateur** (ex. `user/default/ComfyUI-Holaf-Utilities/profiler/`, base SQLite, config…) → couvert par la **migration automatique des données** (ci-dessous) ;
   - **chemin d'assets servi** (fichiers web exposés par le serveur, ex. `/extensions/…`) → **dynamiser** (dérivation depuis l'URL réelle).

#### Migration automatique des données

Au premier démarrage suivant le changement de nom du dossier d'extension, les données existantes sont **migrées automatiquement** vers les nouveaux emplacements aux noms AIH (dossier d'extension : `custom_nodes/ComfyUI-AI-Helper/` ; répertoires de données utilisateur : **`user/default/AI-Helper/`**, cf. Zone B ci-dessous). La migration est **idempotente** : elle ne s'exécute qu'une seule fois (déclenchée uniquement si l'ancien emplacement existe et que le nouveau est absent), puis reste un no-op lors des démarrages suivants.

Les données vivent dans **deux zones distinctes**, toutes deux à migrer :

**Zone A — dans le dossier de l'extension lui-même** (chemins relatifs à `__file__`) :

| Artefact | Contenu |
|---|---|
| `holaf_utilities.sqlite` | Index images (~32k entrées) + statuts miniatures |
| `.cache/thumbnails/` | Miniatures générées |
| `config.ini` | Configuration |
| `temp_uploads/` | Uploads temporaires |
| `temp_exports/` | Exports temporaires |

- **Détection** : si un dossier voisin `custom_nodes/ComfyUI-Holaf-Utilities/` existe encore avec ces artefacts, et que les équivalents sont absents du nouveau dossier `custom_nodes/ComfyUI-AI-Helper/`, alors les **déplacer** vers le nouveau dossier.
- **CRITIQUE** : sans cette migration, perte de l'index complet (~32k images) et régénération totale des miniatures.

**Zone B — répertoires utilisateur** :

- `ComfyUI/user/default/ComfyUI-Holaf-Utilities/` (profiler, etc.) → renommer en `user/default/AI-Helper/` au premier démarrage, si l'ancien répertoire existe et que le nouveau est absent.
- **Nom figé du nouveau répertoire de données utilisateur : `AI-Helper`** (`user/default/AI-Helper/`) — nom court cohérent avec le monorepo produit AI-Helper ; sans ambiguïté car namespacé sous `user/default/`.

**Règles de sécurité** :

- privilégier le **déplacement (rename)** plutôt que copie + suppression (atomique, pas de duplication d'espace disque) ;
- ne **JAMAIS écraser** des données nouvelles plus récentes déjà présentes aux nouveaux emplacements ;
- **journaliser clairement** chaque migration effectuée (artefact, source, destination) ;
- en cas de doute ou d'échec : **ne rien détruire**, laisser l'ancien dossier intact — un fallback manuel documenté permet à l'utilisateur de finaliser la migration à la main.

#### Opérations post-rename (manuelles, côté grokuku / utilisateurs)

| # | Action | Détail |
|---|---|---|
| 1 | Rename du repo sur GitHub | `ComfyUI-Holaf-Utils` → `ComfyUI-AI-Helper` ; GitHub redirige automatiquement les anciennes URLs |
| 2 | Mise à jour des remotes locaux | `git remote set-url …` sur chaque clone |
| 3 | Communication aux utilisateurs | Réinstaller l'extension sous le nouveau nom |

#### Timing recommandé

- **Dé-hardcodage : pendant la Phase 0.**
- **Rename : possible dès la fin de la Phase 0, AVANT les phases de fusion**, afin que tout le travail ultérieur (Phases 1 → 4) se fasse déjà dans le repo au nom final.

---

## 4. Licence

**Actée : GPLv3-or-later** pour le pack fusionné.
Justification : code CUI-Holaf déjà GPL, auteur unique des trois projets (= droit de choisir), cohérence avec ComfyUI (GPLv3).

### Checklist avant publication

| Statut | Action |
|---|---|
| ✅ | Ajouter un fichier `LICENSE` (texte GPLv3 intégral) à la racine de `CUI-Holaf-Utils`. *(Fait — commit 629028c.)* |
| ✅ | Créer `THIRD-PARTY-NOTICES.md` avec notice MIT + crédit xterm.js authors pour les builds vendored `xterm.js` / `xterm-addon-fit`. *(Fait — commit 629028c ; enrichi depuis des licences des dépendances pip.)* |
| ✅ | Conserver intacts le `LICENSE` et les en-têtes GPLv3 de CUI-Holaf ainsi que toutes notices Copyright. *(Vérifié lors de la revue de clôture puis re-vérifié à la passe finale : aucune mention Copyright retirée ni modifiée.)* |
| ✅ | Apposer des en-têtes GPLv3 sur les fichiers AIH fusionnés. *(Fait — passe finale : 20 fichiers Python portés en-têtés, soit les 12 modules `aih/*.py` + les 8 nodes AIH de `nodes/`, avec en-tête compact « Copyright (C) Holaf » + `SPDX-License-Identifier: GPL-3.0-or-later`. Scope raisonné : seuls les fichiers Python portés ; le frontend servi (`aih_frontend/`) reste hors scope — assets statiques servis, pas du code source distribué modifiable. Aucune mention Copyright préexistante n'existait dans ces fichiers (vérifié par grep avant apposition).)* |
| 🟡 | Confirmer la licence de spandrel avant release (`pip show spandrel`). *(Ouvert — à confirmer au déploiement via `pip show spandrel` : aucun dist-info/METADATA spandrel trouvé dans l'environnement de développement local. `THIRD-PARTY-NOTICES.md` le liste provisoirement comme MIT.)* |
| ✅ | Harmoniser copyright 2026 vs 2025 dans `js/holaf_main.js`. *(Fait — constaté lors de la revue de clôture : une seule mention « Copyright (C) 2026 Holaf », plus aucune occurrence 2025.)* |

*(🔴 bloquant · 🟠 important · 🟡 recommandé · ⚪ mineur — priorités d'origine ; seul l'item spandrel reste ouvert, dépendant du déploiement.)*

---

## 5. Phasage proposé

| Phase | Contenu | Niveau de risque |
|---|---|---|
| **Phase 0 — Préparation, dé-hardcodage & migration des données** | Branche dédiée, ajout `LICENSE`, création `THIRD-PARTY-NOTICES.md`, `requirements.txt` fusionné, dé-hardcodage des chemins JS + audit des occurrences `ComfyUI-Holaf-Utilities` (§3.11), **implémentation de la logique de migration automatique des données — Zones A et B (livrable de code, §3.11)**. Rename GitHub en `ComfyUI-AI-Helper` possible en fin de phase. | Faible |
| **Phase 1 — Intégration CUI-Holaf** | 24 nodes + widgets JS + adaptation du registre au loader d'Utils. Mécanique, faible risque. | Faible |
| **Phase 2 — Intégration AIH** | Refactoring du `__init__.py`, 8 nodes, infra locale (store/sync/embedding/local_source + routes `/aih/local/*`), widgets transverses, `templates/`. Chantier principal. | Élevé |
| **Phase 3 — Dédoublements** | Unification AnyType, renommage `holaf_node_helpers.py`, unification boutons Update/Restart, normalisation des noms de nodes (clés `AIH<PascalCase>`, labels « AIH », catégories `AIH/*`, alias legacy — §3.7). Terminal : suppression du terminal AIH et conservation du terminal Utils avec sa logique de session actuelle (point ouvert « terminal hybride » tranché — cf. §2.2 ; reconnexion de session validée à ne pas régresser). | Moyen |
| **Phase 4 — Validation** | Chargement ComfyUI sans erreur, workflows existants non cassés, routes `/holaf/*` et `/aih/*` fonctionnelles, checklist licence complète passée. | — |

> Le renommage du repo (§3.11) peut intervenir dès la fin de la Phase 0 : les Phases 1 à 4 se déroulent alors déjà dans `ComfyUI-AI-Helper`.

---

## 6. Risques et points de vigilance

- **Casse de workflows existants** si des clés de mapping changent.
  **Règle : les clés sont normalisées en `AIH<PascalCase>` (§3.7) mais chaque ancienne clé doit subsister dans `NODE_CLASS_MAPPINGS` comme alias pointant vers la même classe ; la table d'alias n'est jamais purgée.**
- **`sync_engine` dépendant du réseau vers le backend AIH distant** : prévoir un comportement dégradé propre si le serveur est injoignable (le mode miroir local existe précisément comme fallback).
- **Taille du refactoring du `__init__.py` AIH** (~1812 lignes, ~35 routes inline) : tester **incrémentalement route par route** plutôt qu'en big-bang.
- **Double installation temporaire** des anciens packs pendant la transition : risque de double enregistrement des nodes et des routes ; désactiver/supprimer les anciens dossiers dès que la version fusionnée est opérationnelle.

---

## Tableau de suivi

**FUSION TERMINÉE — validée en production par l'utilisateur le 26/08/2026.**

| Phase | Élément | Statut |
|---|---|---|
| 0 | Créer une branche dédiée à la fusion | ✅ Terminé (branche `fusion/consolidation-aih`, commit 629028c) |
| 0 | Ajouter `LICENSE` (texte GPLv3 intégral) à la racine | ✅ Terminé (commit 629028c) |
| 0 | Créer `THIRD-PARTY-NOTICES.md` (notice MIT + crédit xterm.js authors) | ✅ Terminé (commit 629028c) |
| 0 | Fusionner les `requirements.txt` (numpy, Pillow, spandrel, av, paramiko, requests + psutil, pywinpty, aiofiles, orjson, watchdog, python-xmp-toolkit, aiohttp, pynvml) | ✅ Terminé (complété par le commit 23c1e11 : spandrel/av/numpy + dédoublonnage) |
| 0 | Supprimer l'auto pip install au boot d'AIH | ✅ Terminé |
| 0 | Dé-hardcoder les chemins JS `/extensions/ComfyUI-Holaf-Utilities/` (dérivation dynamique depuis l'URL du script chargé : import.meta.url ou src du tag script) — prérequis bloquant du renommage (§3.11) | ✅ Terminé (commit 438008a) |
| 0 | Auditer toutes les occurrences de `ComfyUI-Holaf-Utilities` en Python/JS (grep complet) et classer chaque occurrence : stockage utilisateur (couvert par la migration automatique) vs assets servi (à dynamiser) | ✅ Terminé (couvert par le commit 438008a) |
| 0 | Dynamiser les chemins d'assets servis identifiés par l'audit (§3.11) | ✅ Terminé (commit 438008a) |
| 0 | Implémenter la logique de migration automatique des données (Zones A et B — §3.11) | ✅ Terminé (commit 95e477d) |
| 0+ (post-Phase 0) | Renommer le repo sur GitHub : `ComfyUI-Holaf-Utils` → `ComfyUI-AI-Helper` (redirections automatiques des anciennes URLs) | À faire — reporté (décision utilisateur : plus tard), cf. « Reste à faire (hors code) » |
| 0+ (post-Phase 0) | Mettre à jour les remotes git locaux vers le nouveau nom | À faire — reporté (décision utilisateur : plus tard), cf. « Reste à faire (hors code) » |
| 0+ (post-Phase 0) | Communiquer aux utilisateurs : réinstaller l'extension sous le nouveau nom (données migrées automatiquement au premier démarrage, §3.11) | À faire — reporté (décision utilisateur : plus tard), cf. « Reste à faire (hors code) » |
| 1 | Intégrer les 24 nodes CUI-Holaf dans `nodes/` | ✅ Terminé (commit e544d36 — clés `AIH*` canoniques + alias legacy) |
| 1 | Adapter l'enregistrement des nodes CUI-Holaf au loader par-fichier d'Utils (ou intégrer leur registre central — choix à documenter) | ✅ Terminé (couvert par le commit e544d36) |
| 1 | Intégrer les widgets JS associés aux 24 nodes | ✅ Terminé (commit 2ce784b — ids `registerExtension` `AIH.*`, matching dual-forme `AIH*`/legacy sur toutes les comparaisons de clés, fixes window.holaf clobbering + LogLevel) |
| 1 | Rapatrier `nodes/holaf_utils.py` de CUI-Holaf (futur `holaf_node_helpers.py`) | ✅ Terminé (commit e544d36 — renommé `holaf_node_helpers.py`, AnyType unifié, comparer renommée `AIHRemoteComparer`) |
| 1 | Vérifier le chargement des 24 nodes dans ComfyUI sans erreur | ✅ Terminé (validations : py_compile 26 fichiers, simulation réelle du loader — 50 entrées, 2 ordres de scan —, `node --check` 5/5, test unitaire du matching ; chargement ComfyUI en conditions réelles à confirmer avant merge, cf. note) |
| 2 | Refactorer le `__init__.py` AIH (~1812 lignes) : suppression du chargement via `sys.modules`, imports standardisés, préfixe `/aih/*` conservé | ✅ Terminé (chantier C, commit d34100a — toutes les routes inline vivent dans `aih/routes.py` exposant `register(server_routes, require_auth=None)` appelé depuis le `__init__.py` racine ; groupes indépendants, échec d'un groupe sans effet sur les autres) |
| 2 | Intégrer les 8 nodes AIH (Elements Picker, Prompt Enhancer, Ideogram 4 Builder, Keywords, Ref Image Prep, LMStudio Settings, OpenAI Settings, Music) | ✅ Terminé (chantier B, commits e9cd5ef, a9ad07b, be69437, fed19e4, 8bd7339, c73ee8d, bfaf337 — clés canoniques + alias legacy, catégories AIH/Prompting & AIH/Media, imports redirigés vers le socle `aih/`) |
| 2 | Renommer la clé `"AIH Ref Image Prep"` (avec espaces) en `AIHRefImagePrep` et créer son alias legacy | ✅ Terminé (chantier B, commit 8bd7339 — alias espacé conservé, jamais purgé) |
| 2 | Rapatrier `templates/` de prompts (node Music) | ✅ Terminé (chantier B, commit bfaf337 — prompts maîtres MiniMax Music 3.0 copiés vers `aih/templates/`, matériel de référence non lu au runtime ; module `music_prompts` porté dans le package `aih/`) |
| 2 | Intégrer le système `credentials.json` | ✅ Terminé (chantier A, commit d13c353 — socle `aih/credentials.py`, ex-nodes/_credentials.py ; API inchangée, chemin user/default/aih/ conservé) |
| 2 | Intégrer `_llm_helper` (Ollama/OpenAI/vision) | ✅ Terminé (chantier A, commit 45c84dc — socle `aih/llm_helper.py`) |
| 2 | Intégrer les routes `/api/aih/models/*` (SFTP chunked + fingerprint) | ✅ Terminé (chantier C, commits cfcc670 — managers portés en `aih/model_manager.py` + `aih/custom_nodes_manager.py`, contrats identiques, paramiko lazy ; auto pip install post-clone NON porté §3.3) |
| 2 | Intégrer le mode miroir local complet (`store.py`, `sync_engine`, `embedding_engine`, `local_source`, routes `/aih/local/*`) | ✅ Terminé (socle chantier A : package `aih/` + bootstrap sys.path — commits 25a921d/c6ec494/474e006/ad20a71 ; routes chantier C : commit c43370a — status/music3/search sémantique/embeddings/proxy miroirs/sync outbox-conflicts-retry + service statique frontend + démarrage du moteur de sync) |
| 2 | Prévoir le comportement dégradé de `sync_engine` si le backend distant est injoignable ou non configuré | ✅ Déjà en place dans la source (retours dict/liste d'erreur propres, jamais d'exception réseau remontée) et vérifié par harnais (serveur injoignable → erreurs propres) ; durci par le dé-hardcodage de l'URL serveur (cycle ignoré si `server_url` vide) |
| 2 | Intégrer Blobby Companion | ✅ Terminé (backend : chantier C, commit 8e1ded9 — `/aih/blobby/save|load` fidèles, `/aih/blobby/exec` sécurisé derrière l'auth terminal Holaf : cookie `holaf_session` vérifié par `holaf_auth.require_auth`, 401 sinon, fail-closed 503 si garde absente ; widget JS : chantier D, commit fb0ca38 — les deux sites d'appel exec affichent un message d'invitation au login terminal sur 401 au lieu d'une erreur muette ; la variante dev `blobby.js` du blobby companion de l'ancien monorepo AI-Helper, plus ancienne et sans mémoire/skills, n'est PAS portée — la version déployée fait foi) |
| 2 | Intégrer les widgets JS transverses (Model Browser, Workflow Share, Modal v2) | ✅ Terminé (chantier D, commit fb0ca38 — + loaders ordonnés 00_-04_, Elements/Keywords/Enhance widgets, matching dual-forme des clés renommées) |
| 2 | Servir le frontend local via `/aih/local/*` | ✅ Terminé (chantier C, commit c43370a — site copié dans `<pack>/aih_frontend/`, index.html réécrit à la volée `/css//js/` → `/aih/local/css//aih/local/js/`, même logique que la source ; anti path-traversal realpath containment) |
| 2 | Tester incrémentalement chaque route refactorée | ✅ Terminé (chantier C — harnais hors-ComfyUI : inventaire exact des 43 routes vs source, exécution réelle des handlers clés status/embeddings/outbox/conflicts/search/index+réécriture/traversal-bloqué/auth blobby 401+fail-closed, update_repo() sur repos jetables, py_compile 5 fichiers) |
| 3 | Unifier AnyType (une seule implémentation partagée) | ✅ Terminé (absorbé en Phase 1 — commit e544d36 : implémentation unique partagée dans `holaf_node_helpers.py`) |
| 3 | Renommer `holaf_utils.py` (venant de CUI-Holaf) en `holaf_node_helpers.py` et mettre à jour les imports | ✅ Terminé (absorbé en Phase 1 — commit e544d36 : fichier renommé, imports mis à jour) |
| 3 | Unifier les boutons Update et Restart (Update = git pull → proposition de redémarrage via restart sécurisé d'Utils ; Restart autonome) | ✅ Terminé (backend : chantier C, commit 8051c7d — POST `/aih/update` renvoie `{updated: bool, detail}` via fetch+reset --hard FETCH_HEAD SANS auto-execv ; redémarrage délégué à POST `/holaf/utilities/restart` existant ; boutons « AIH Update » / « AIH Restart » dans le menu principal Holaf Utilities (`js/holaf_main.js`) : chantier D, commit 4b9660e — flux restart existant extrait tel quel en `startRestartFlow()` partagé) |
| 3 | Remplacer les anciennes routes `/aih/update` et `/aih/restart` par la mécanique unifiée | ✅ Terminé côté backend (chantier C, commit 8051c7d — `/aih/update` nouvelle mécanique ; `/aih/restart` volontairement non recréée) |
| 3 | Supprimer le terminal AIH et conserver le terminal Utils avec sa logique de session actuelle (auth par mot de passe hashé ; reconnexion Ctrl+D → login → session fraîche déjà implémentée et validée — ne pas régresser sur `holaf_terminal.py` / `js/holaf_terminal.js`) | ✅ Terminé côté pack fusionné (chantier C — GET `/aih/terminal` WebSocket non authentifié volontairement NON porté, aucun résidu `.py/.js` ; seul GET `/holaf/terminal` existe ; terminal unique Utils confirmé, session Ctrl+D → login → session fraîche validée en conditions réelles — fixes 994a27a + 45fd9d8) |
| 3 | Normaliser les clés de mapping en `AIH<PascalCase>` sans suffixe `Node` (table de renommage §3.7) | ✅ Terminé (commits e544d36 + c65841f — clés canoniques appliquées aux 32 nodes gardées ; validé en production) |
| 3 | Préfixer tous les labels affichés par « AIH » | ✅ Terminé (commits e544d36 + c65841f — labels préfixés « AIH », style menu orange AI Helper conservé) |
| 3 | Réorganiser l'arbre de catégories sous la racine `AIH/` (couleur orange historique + style de menu AI Helper) | ✅ Terminé (commits e544d36 + c65841f — arbre unique racine `AIH/` conforme au tableau §3.7) |
| 3 | Mettre en place la table d'alias legacy dans `NODE_CLASS_MAPPINGS` (chaque ancienne clé → même classe, jamais purgée) | ✅ Terminé (commit e544d36 — alias legacy en place, table jamais purgée ; compatibilité vieux workflows validée par l'utilisateur en production) |
| 3 | Harmoniser copyright 2026 vs 2025 dans `js/holaf_main.js` | ✅ Terminé (constaté lors de la revue de clôture : le fichier courant ne contient plus qu'une seule mention « Copyright (C) 2026 Holaf », aucune occurrence 2025 restante) |
| 4 | Valider le chargement complet de ComfyUI sans erreur | ✅ Terminé (validé en production par l'utilisateur : nodes ex-CUI-Holaf visibles/fonctionnelles après Phase 1, nodes AIH présentes après Phase 2) |
| 4 | Valider que les workflows existants ne sont pas cassés (anciennes clés toutes résolues via les alias legacy) | ✅ Terminé (validé par l'utilisateur en production — anciennes clés toutes résolues via les alias legacy) |
| 4 | Valider les routes `/holaf/*` | ✅ Terminé (routes Utils historiques inchangées par la fusion ; terminal Utils, Update et Restart exercés en conditions réelles) |
| 4 | Valider les routes `/aih/*` | 🟠 Partiel — harnais hors-ComfyUI du chantier C (inventaire 43/43 routes, handlers clés exécutés réellement) ; restent à confirmer en conditions réelles : SFTP models (`/api/aih/models/*`), frontend local `/aih/local/*`, auth Blobby en prod (cf. « Reste à faire (hors code) ») |
| 4 | Vérifier l'absence de double installation des anciens packs | À faire (côté utilisateurs finaux — opération externe, cf. « Reste à faire (hors code) ») |
| 4 | Apposer les en-têtes GPLv3 sur les fichiers AIH fusionnés | ✅ Terminé (passe finale licence — 20 fichiers Python portés en-têtés : 12 modules `aih/*.py` + 8 nodes AIH de `nodes/` ; en-tête compact « Copyright (C) Holaf » + `SPDX-License-Identifier: GPL-3.0-or-later` ; py_compile 20/20 ; `aih_frontend/` hors scope, assets servis) |
| 4 | Vérifier que LICENSE/en-têtes/notices Copyright de CUI-Holaf sont intacts | ✅ Terminé (revue de clôture : en-têtes GPLv3 d'origine « Copyright (C) 2025 Holaf » intacts sur les nodes ex-CUI-Holaf échantillonnées ; `LICENSE` + `THIRD-PARTY-NOTICES.md` présents à la racine ; re-vérifié à la passe finale : aucune mention retirée par l'apposition des en-têtes AIH) |
| 4 | Confirmer la licence spandrel avant release (`pip show spandrel`) | 🟠 Ouvert — à confirmer au déploiement via `pip show spandrel` (aucun dist-info/METADATA spandrel dans l'env de dev local ; `THIRD-PARTY-NOTICES.md` le liste provisoirement MIT — cf. §4 Licence et « Reste à faire (hors code) ») |
| 4 | Checklist licence complète passée avant publication | 🟠 Presque — passe finale effectuée (§4 Licence) : tous les items ✅ sauf la confirmation spandrel, seule dépendance du déploiement restante |

> **Note — Phases 0 et 1** : réalisées sur la branche `fusion/consolidation-aih` (Phase 0 : commits 629028c, 438008a, 95e477d ; Phase 1 : commits e544d36 — chantier A nodes, 23c1e11 — chantier A requirements, 2ce784b — chantier B widgets JS), puis **intégrées à `main`** (merge complet, incluant le fix du menu).
>
> **Note — Évolution de workflow** : abandon du travail sur branche dédiée — **toutes les modifications se font désormais directement sur `main`**. La branche `fusion/consolidation-aih`, entièrement mergée, a été supprimée. La sécurité est assurée par des **commits conventionnels fins et révertibles** (chaque changement atomique peut être annulé individuellement via revert).
> Convention commits : toutes les validations (`git commit`) sont réalisées par l'utilisateur via son outil — les sessions de travail ne doivent jamais exécuter `git commit`, elles laissent les modifications en attente (le push utilisateur emportera le tout).
> **Note — Phase 2 chantier D (widgets JS transverses)** : les widgets AIH vivent dans `js/` aux noms de fichiers d'origine, nomenclature ordonnée des loaders préservée (`00_aih_picker_config`, `01_aih_modal_v2`, `02_aih_model_browser`, `03_aih_shared`, `04_aih_widget_base`) — ComfyUI charge les `.js` du WEB_DIRECTORY par ordre alphabétique, ce qui garantit que helpers partagés (window.AIH.*, aihOpenModalV2) se déclarent avant leurs consommateurs ; aucun fichier porté ne touche à `window.holaf` (pattern merge `|| {}` conservé pour window.AIH, namespace Holaf intact). Matching dual-forme partout où une clé renommée est comparée : `AIHElementsPicker`/`AIHElementsNode` (elements_widget, 2 sites dont le listener WebSocket de setup), `AIHPromptEnhancer`/`AIHEnhanceNode`, `AIHKeywords`/`AIHKeywordsNode`, et `MODEL_LOADERS` du workflow share accepte `AIHUpscale` + legacy `UpscaleImageHolaf`. Endpoints locaux vérifiés contre `aih/routes.py` (`/aih/elements/presets`, `/api/aih/models/*`, `/api/aih/custom-nodes*`, `/aih/blobby/exec`) ; appels distants `{cfg.serverUrl}/api` inchangés (contrat serveur ; URL depuis dé-hardcodée et pilotée par la config AIH_config / credentials.json) ; `/object_info/*` = routes core ComfyUI. Blobby exec : 401 affiché avec invitation au login terminal Holaf. Boutons « AIH Update » / « AIH Restart » intégrés au menu principal Holaf Utilities (`holaf_main.js`) : Update → POST `/aih/update` → si `updated:true` dialogue de confirmation puis POST `/holaf/utilities/restart`, sinon toast « déjà à jour » ; Restart → même mécanique après confirmation (flux extrait verbatim en `startRestartFlow()` partagé). **Exclusions** : `aih_terminal_widget.js` volontairement NON copié (aucun loader explicite n'existe côté source — ComfyUI liste le dossier web — l'exclusion propre est donc l'absence de fichier + zéro référence résiduelle dans le pack, vérifié par grep) ; xterm vendored d'AIH non dupliqués (Utils a les siens) ; `aih_menu.js` non porté car remplacé par le menu Holaf Utilities (boutons Update/Restart inclus). **Restent hors périmètre du chantier D** (widgets node-spécifiques/outils non listés, à porter ultérieurement si souhaité) : `aih_ideogram4_widget.js`, `aih_music_widget.js`, `aih_openai_settings_widget.js`, `aih_debug.js`, `aih_diagnostic.js`. Validations : node --check ×11 ; unicité des 21 ids registerExtension du pack ; simulation d'ordre des loaders (évaluation sandbox ordonnée des 10 fichiers + assertions dépendances/namespace/exclusion) ; test unitaire matching dual-key (28/28) ; cross-check endpoints locaux 9/9 pack + 2 core. Commits incrémentaux : fb0ca38 (widgets), 4b9660e (boutons menu).
>
> **Note — Phase 2 chantier C (routes HTTP AIH)** : les 45 routes sources (43 inline du `__init__.py` racine d'AI-Helper + 2 du Blobby companion) vivent désormais dans le module dédié `aih/routes.py`, exposant `register(server_routes, require_auth=None)` appelé une fois par le `__init__.py` racine après le bootstrap du package. **43 routes sont enregistrées** : credentials/clés/presets, POST `/aih/update` (fetch+reset --hard FETCH_HEAD, renvoie `{updated: bool}` — PAS d'auto-restart, redémarrage délégué à POST `/holaf/utilities/restart`), blobby save/load + exec SÉCURISÉ (même auth mot de passe que GET `/holaf/terminal` via cookie signé `holaf_session` ; fail-closed 503 si la garde n'est pas fournie), models SFTP chunked + fingerprint (`aih/model_manager.py`, paramiko lazy) et custom-nodes (`aih/custom_nodes_manager.py`, auto pip install retiré §3.3), mode miroir local complet + service statique du site (`aih_frontend/`) sous `/aih/local/*`. **Deux routes non portées volontairement** : GET `/aih/terminal` (terminal unique Utils) et POST `/aih/restart` (remplacée par `/holaf/utilities/restart`). Le frontend site est copié dans `<pack>/aih_frontend/`. Validations : py_compile (5 fichiers), harnais hors-ComfyUI (inventaire exact 43/43, handlers exécutés en réel sur store SQLite jetable, anti path-traversal, réécriture index.html, auth blobby 401/fail-closed, update_repo() sur repos git temporaires). Commits incrémentaux : d34100a (squelette+credentials), 8051c7d (update), 8e1ded9 (blobby), cfcc670 (models), c43370a (local+frontend). Incident noté pendant le chantier : un harnais ayant invoqué `update_repo()` sans cloisonnement a rewindé main vers origin (reset --hard FETCH_HEAD) ; récupéré par reflog sans perte, et `repo_root` paramétrable ajouté pour interdire ce scénario.
>
> **Note — Phase 2 chantier B (nodes)** : les 8 nodes AIH vivent dans `nodes/` aux noms de fichiers d'origine (`elements_node.py`, …), chacune exposant son propre `NODE_CLASS_MAPPINGS` + `NODE_DISPLAY_NAME_MAPPINGS` (clé canonique `AIH<PascalCase>` + alias legacy pointant vers la même classe), conformément au loader par-fichier d'Utils et au pattern des nodes Holaf (Phase 1). Tous les imports passent par le socle partagé (`from aih import credentials, llm_helper, …`) grâce au bootstrap sys.path du `__init__.py` racine ; le module `music_prompts` (miroir backend du pipeline Music) est porté dans le package `aih/` pour être importable indépendamment de l'ordre de chargement des fichiers de nodes, et les prompts maîtres MiniMax Music 3.0 sont rapatriés en `aih/templates/`. Nodes diagnostic et preview volontairement NON portées (abandonnées, §2.1). Validations : py_compile (11 fichiers), simulation du loader par-fichier (16 entrées de mapping, alias ≡ même classe, displays/catégories conformes, ordre de chargement inversé inclus), grep sans référence résiduelle à `_credentials`/`_llm_helper` ni au chargement exotique.
>
> **Note — Phase 2 chantier A (socle partagé)** : le socle backend AIH vit dans le sous-package `aih/` à la racine du pack (`store`, `sync_engine`, `embedding_engine`, `local_source`, `credentials`, `llm_helper`), importé par imports absolus standards grâce à un bootstrap unique du sys.path dans le `__init__.py` racine (ComfyUI ne met pas le dossier du pack sur sys.path). Le chargement exotique d'origine (pré-enregistrement `sys.modules` + chargement par chemin via importlib) est supprimé. `update_manager.py` n'est volontairement PAS porté à ce stade : il sera adapté au chantier C (boutons Update/Restart) depuis la source AI-Helper. Les nodes, routes `/aih/*` et `templates/` Music restent aux chantiers B/C.

---

## Reste à faire (hors code)

*Aucun chantier de code du plan initial ne reste ouvert. Ne figurent ici que les opérations externes et validations terrain pendantes.*

### 1. Renommage GitHub & communication — reportés volontairement
- Rename du repo sur GitHub : `ComfyUI-Holaf-Utils` → `ComfyUI-AI-Helper` (redirections automatiques des anciennes URLs).
- Mise à jour des remotes git locaux (`git remote set-url …`) sur chaque clone.
- Communication aux utilisateurs : réinstaller l'extension sous le nouveau nom (données migrées automatiquement au premier démarrage, §3.11).
- **Décision utilisateur : plus tard.** Aucun blocage technique — le dé-hardcodage (Phase 0, commit 438008a) rend le rename sûr à tout moment.

### 2. Désinstallation des anciens packs séparés chez les utilisateurs finaux
- `CUI-Holaf` et l'ancien pack AIH (`AIH_Tools` / extension ComfyUI de l'ancien monorepo AI-Helper) ne doivent plus rester installés en parallèle du pack fusionné dans `custom_nodes/` — risque de double enregistrement des nodes et des routes (§3.10, §6).

### 3. Confirmation en conditions réelles des derniers tests non couverts
Le harnais hors-ComfyUI du chantier C couvre déjà ces chemins théoriquement ; restent à confirmer en production :
- **Test SFTP models** : transfert chunked + fingerprint via `/api/aih/models/*` vers un serveur réel ;
- **Test frontend local** : navigation du site servi sous `/aih/local/*` dans un navigateur ;
- **Test auth Blobby** : en conditions réelles, appel exec sans session terminal → 401 + invitation au login.

### 4. Confirmation de la licence spandrel au déploiement
- **À confirmer au déploiement via `pip show spandrel`** : aucun dist-info/METADATA de spandrel n'est présent dans l'environnement de développement local, la vérification n'a donc pas pu être faite ici. `THIRD-PARTY-NOTICES.md` le liste provisoirement comme **MIT** — vérifier que la version effectivement installée porte bien cette licence (metadata `License:` / fichier `LICENSE` du paquet) et corriger la notice le cas échéant. Seul item restant ouvert de la checklist licence (§4).
