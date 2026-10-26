# ComfyCH — génération distante sur Modal (intégré au pack)

ComfyCH (extension ComfyUI historique « Modal Gateway ») est **une partie
intégrante** de ce pack : son code vit dans [`tools/comfych/`](../tools/comfych)
et il est **toujours chargé** au démarrage. Seule sa **visibilité** est pilotée
par le registre WIP existant (`js/holaf_wip_settings.js` → feature `comfych`,
masquée par défaut, mémorisée dans `localStorage`).

Il apporte :

- un **sélecteur de GPU** (Local / L4 / L40S / A100 / H100) et un bouton **⚙**
  de réglages, dans le menu **`AI Helper ▾` → Outils & Dev → ComfyCH** ;
- des routes `/api/modal/*` (sync des modèles, déploiement, **redémarrage du
  worker**, logs, réglages…) ;
- l'**interception du bouton Queue** : quand un GPU cloud est choisi, les
  workflows partent sur Modal au lieu de la machine locale ;
- une **fenêtre de suivi de run non bloquante** (infos, logs du worker en
  direct, erreur copiable) — voir « Suivi de run » plus bas.

---

## Où vivent les données (hors du pack)

Comme toutes les données de l'utilisateur du pack (chantier
`holaf_user_paths`), les fichiers de ComfyCH sont **hors de `custom_nodes/`** :

| Donnée | Emplacement |
|---|---|
| Réglages (URL de l'API, clé, listes de nodes/modèles…) | `<ComfyUI>/user/default/AI-Helper/config/comfych.json` |
| Journaux d'opération (`last_operation.log`, `.status`) | `<ComfyUI>/user/default/AI-Helper/logs/comfych/` |

⚠️ `comfych.json` contient la **clé API** en clair : il n'est **jamais**
journalisé ni renvoyé par l'API (`api_key` masquée, seul `api_key_set` est
exposé). Il ne doit pas être partagé/sauvegardé en clair.

Chemins historiques (encore lus tant que la migration n'a pas eu lieu) :
`tools/comfych/config.json` et `tools/comfych/logs/`.

---

## Résolution des dossiers ComfyUI (dont `user/`) hors ComfyUI

`comfych_paths.py` est le **seul** endroit qui sait où vivent `user/`,
`models/`, `output/` et `custom_nodes/`. Chaque dossier est résolu par une liste
**ordonnée de candidats** dont on ne retient que le **premier qui existe
réellement** :

1. env explicite `AIH_COMFY_USER_DIR` (dossier `user/` seulement — pour une
   disposition particulière ou un `--user-directory` exotique) ;
2. `folder_paths` — **uniquement s'il est importable** (donc dans le processus
   de ComfyUI) : `get_user_directory()`, `get_output_directory()`,
   `get_folder_paths("custom_nodes")`, dossier parent de `checkpoints` ;
3. **walk-up** depuis le dossier du code : le dossier cherché est un **frère**
   de `custom_nodes` (`…/ComfyUI/{user,models,output}` à côté de
   `…/ComfyUI/custom_nodes`) ;
4. `holaf_user_paths.get_comfy_user_dir()` (même référence que le reste du
   pack), puis `~/.config/comfyui` — **dernier recours accepté seulement s'il
   existe**.

⚠️ **Ne jamais réintroduire un repli non vérifié.** `modal run sync.py` (et tout
script du module) tourne dans un **processus séparé** de ComfyUI, où
`folder_paths` n'est pas importable : la version précédente y retombait sur
`~/.config/comfyui` **sans vérifier son existence**, annonçait « local user/
directory not found », puis affichait quand même `✅ Sync terminée !` et sortait
en **code 0** — le gateway croyait la sync réussie et redémarrait le worker sur
un volume inchangé.

Aujourd'hui, un dossier introuvable produit un **échec bruyant** :
`first_existing_or_raise()` lève `ComfyPathNotFound`, `sync.py` affiche le
message (avec **tous** les chemins essayés et le remède `AIH_COMFY_USER_DIR`)
puis `sys.exit(1)`. Le code de retour non nul est lu par le gateway
(`_run_sequence_inner`), qui **annule** les étapes suivantes : le redémarrage du
worker n'a donc pas lieu. Verrouillé par
`tests/test_comfych_user_dir_resolution.py` (4 mutants).

---

## Import automatique de l'ancienne configuration

Au démarrage, **si la cible est absente** et qu'un ancien `config.json` de
ComfyCH est trouvé, il est **copié** vers
`<ComfyUI>/user/default/AI-Helper/config/comfych.json` puis **renommé
`config.json.migrated`** (jamais supprimé).

Emplacements cherchés, **dans cet ordre** (`tools/comfych/comfych_store.py`,
`iter_legacy_config_candidates`) :

1. `<pack>/tools/comfych/config.json` — là où ComfyCH écrivait avant
   l'intégration (ancien nom du fichier : `config.json`) ;
2. `<custom_nodes>/ComfyCH/config.json` puis
   `<custom_nodes>/modal_gateway/config.json` (anciens noms du dossier) ;
3. `<custom_nodes>/*/config.json` — **retenu seulement si le contenu ressemble
   à du ComfyCH** (au moins deux clés parmi `api_url`, `api_key`,
   `models_to_sync`, `custom_nodes_ext`) : le `config.json` d'une autre
   extension n'est jamais pris ;
4. `~/.comfych/config.json`.

Comportement en cas de **conflit** (les deux fichiers existent) : **rien n'est
écrasé**. Un avertissement indique les deux chemins ; pour importer l'ancien,
renommer/supprimer la cible puis redémarrer ComfyUI.

Aucun ancien fichier trouvé : une configuration **vide** est créée et un
message liste les emplacements où déposer l'ancien fichier. Hors ComfyUI
(aucune arborescence utilisateur adoptée), **aucun fichier n'est créé**.

L'import est **idempotent par processus** (`import_legacy_config_once`).

---

## Mode de rendu forcé à « local » au démarrage

Quand ComfyCH est **masqué** (feature WIP désactivée), l'interception du bouton
Queue **reste en place** — l'activer/désactiver dynamiquement serait bancal —
mais le mode de rendu est **forcé à `local`** à chaque démarrage : l'interception
ne fait simplement rien.

Le forçage est **en mémoire uniquement** (`FORCED_RENDER_MODE`, exposé par
`GET /api/modal/config` → `render_mode_forced`) :

- le fichier `comfych.json` **n'est jamais modifié** (URL, clé, GPU préféré,
  listes restent intacts) ;
- la préférence de GPU enregistrée par l'utilisateur (`localStorage`,
  `modal-gateway-mode`) **n'est pas réécrite** ;
- les jobs **déjà lancés** sur Modal ne sont **pas annulés**.

Pour « mémoriser » un mode cloud par défaut plus tard, il suffira de retirer ce
forçage : aucun réglage utilisateur n'aura été écrasé entre-temps.

---

## Dépendance optionnelle : `modal`

Le paquet pip **`modal` n'est PAS dans `requirements.txt`** (volontairement : il
tirerait ~15 dépendances pour tous les utilisateurs, alors que la partie locale
de ComfyCH n'utilise que la stdlib + `aiohttp` de ComfyUI). Il n'est nécessaire
que pour lancer réellement un sync/déploiement ou exécuter un workflow sur
Modal :

```bash
pip install modal      # dans l'interpréteur Python de ComfyUI
modal token new        # authentification (une seule fois)
```

Sans `modal`, le pack démarre normalement ; les opérations échouent proprement
avec un message dans les journaux d'opération.

---

## Modules locaux dans l'image : la liste `add_local_python_source` est un CONTRAT

`modal run sync.py` monte **`/root/sync.py`** dans le container, mais **pas ses
modules frères**. Tout module local importé par un fichier d'app doit donc être
**déclaré explicitement** :

```python
# tools/comfych/sync.py
IMAGE_LOCAL_PYTHON_SOURCES = ("comfych_paths", "helpers", "models")
...
_sync_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("aria2")                      # installations D'ABORD
    .pip_install("huggingface_hub")
    .add_local_python_source(*IMAGE_LOCAL_PYTHON_SOURCES, copy=True)  # CODE EN DERNIER
)
```

Deux règles, chacune verrouillée par un test :

1. **Un module oublié = retry infini.** L'oubli de `comfych_paths` (après le
déplacement de la résolution des chemins ComfyUI dans ce module) a produit, en
production :

   ```
   File "/root/sync.py", line 36, in <module>
       from comfych_paths import (...)
   ModuleNotFoundError: No module named 'comfych_paths'
   Runner failed with exception …
   … toujours en cours (66s) (76s) (86s) (96s) (108s) (118s)
   ```

   Modal relance le container en boucle (temps GPU brûlé) et **toutes** les
   fonctions distantes sont inutilisables. `tests/test_comfych_image_modules.py`
   compare, par **analyse AST**, les imports locaux réels de `sync.py` à
   `IMAGE_LOCAL_PYTHON_SOURCES` : la récidive est impossible. En complément,
   `sync.py` exécute `_preflight_image_modules()` **avant tout appel distant** et
   sort en code 1 avec le nom du module manquant.

2. **Le code local se déclare APRÈS les installations.** `add_local_python_source`
   en tête de chaîne change le hash des couches suivantes : chaque édition d'un
   module du pack faisait rejouer `apt install` + `pip install` (et, dans
   `image.py`, `comfy install --nvidia` : plusieurs minutes). Il est donc placé
   en **dernier**, avant l'empreinte `COMFYCH_DEPLOY_STAMP`.

Les imports **sous `try:`** (`comfych_store`) sont *optionnels* : le script se
charge sans eux (repli prévu) et ils ne sont pas exigés dans l'image.

---

## Une seule source de vérité pour le pack : le VOLUME (code) + l'IMAGE (deps)

Répartition **imposée** (cf. `base_worker._sync_custom_nodes_from_volume`) :

| Quoi | Où | Pourquoi |
|---|---|---|
| **Code des nodes** du pack (`__init__.py`, `aih/`, `nodes/`, `js/`…) | **Volume** `comfy-custom-nodes` (archive des custom nodes) | c'est ce que le worker lie dans `ComfyUI/custom_nodes` au démarrage ; une correction de code ne demande **aucun** redéploiement |
| **Dépendances pip** du pack (`requirements.txt` : `watchdog`, `aiohttp`, `av`…) | **Image** Modal (build) | payées une fois, persistantes ; les installs runtime ne survivent pas au snapshot |
| **Code du gateway** (`tools/comfych/` : `sync.py`, `image.py`, `apps/`, `workers/`) | **Image** Modal (`add_local_python_source`) | inutile côté worker, et il contient la configuration locale (clé API) |

Conséquences **à ne pas inverser** :

- Le pack **n'est plus exclu** de l'archive. L'ancien message
  `⊘ ComfyUI-AI-Helper exclu (gateway ComfyCH (code déjà présent dans l'image))`
  était **faux** : l'image ne contient que ses `requirements.txt`, jamais son
  code → le pack n'existait **ni dans l'image, ni sur le volume**, et ses nodes
  étaient introuvables sur le worker (`AIH Prompt Enhancer not found`).
- `tools/comfych` (code du gateway) est **élagué** de l'archive, par **chemin**
  (pas par nom) : jamais deux copies, et la `config.json` locale (clé API) ne
  part jamais dans un volume. Le log l'affiche :
  `⊘ comfych/ exclu (code du gateway : embarqué dans l'image)`.
- **Jamais les deux** pour la même chose : deux copies d'un même pack dans
  `custom_nodes/` se neutralisent (piège historique). Sur le worker, le gateway
  absent affiche une ligne **informative** (`ℹ️ gateway absent de cette
  installation`), pas une erreur.
- **Un dossier de `custom_nodes/` sans `__init__.py` n'est pas un custom node**
  (ComfyUI ne le charge pas) : il est exclu du packaging avec sa raison
  (`⊘ ComfyCH exclu (pas de __init__.py — pas un custom node)`), de même qu'un
  dossier désactivé par suffixe (`.disabled`, `.bak`, `.off`).

---

## Swap du volume `custom_nodes` : jamais destructif

`extract_custom_nodes_from_volume` suit un ordre strict, et **rien n'est
supprimé avant que le remplacement soit complet** :

1. extraction + validation de l'archive dans `.staging` (liens, `..` et
   échappements refusés **avant** toute écriture ; archive vide ou tronquée →
   refus immédiat, **volume intact**) ;
2. l'ancien contenu est **renommé** dans `.backup` (renommage = instantané,
   aucun octet copié) puis marqué complet (`.backup/.complete`) ;
3. les entrées du staging sont installées à la place ;
4. **si l'installation échoue** : l'installation partielle est retirée et
   l'ancien contenu est **restauré** depuis `.backup` avant que l'erreur ne
   remonte (volume inchangé, `commit()` jamais appelé) ;
5. **si elle réussit** : le manifeste `.nodes_manifest.json` est écrit, le
   volume est commité, et la génération précédente reste dans `.backup` (une
   seule génération, remplacée au swap suivant).

L'ancien code **supprimait tout** (`shutil.rmtree`) avant d'installer : un échec
au milieu (quota, container tué) laissait le volume **vide ou partiel**, et
Modal persiste l'état à l'arrêt du container → perte définitive (symptôme vécu :
« ComfyCH n'existe plus »). Une sauvegarde `.backup` **incomplète** (swap
interrompu) n'est jamais écrasée : le swap suivant refuse de démarrer plutôt que
de détruire le seul exemplaire restant.

Espace : `.backup` double la taille des nodes. Pour le libérer :

```bash
modal volume rm comfy-custom-nodes /.backup --recursive
```

---

## Anti-retry-infini côté gateway (échec rapide et clair)

Un container qui plante **à l'import** est relancé en boucle par le superviseur
Modal. Le gateway compte les `Runner failed with exception` du flux de logs :
au-delà de `_RETRY_ABORT_THRESHOLD` (3), il **tue le subprocess** et sort en
échec avec un message qui dit quoi corriger (cause déterministe, module à
déclarer), au lieu d'attendre le timeout global de 30 min
(`_OP_TIMEOUT_SECONDS`) et de brûler du temps GPU.

---

## Ce qui a été repris de ComfyCH (et ce qui ne l'a pas été)

Repris dans `tools/comfych/` : `__init__.py` (routes + opérations),
`sync.py`, `image.py`, `helpers.py`, `auth.py`, `gateway_router.py`, `models.py`,
`plugins.py`, `apps/`, `workers/`, `vendor_nodes/`, `config.example.json`,
`requirements_comfy.txt`, la documentation d'origine.

- **`tests/` du dépôt ComfyCH : non repris.** Ils testent le pipeline Modal
  standalone avec des stubs internes de `modal`/`fastapi` (absents du venv de
  développement) ; la couverture utile ici est apportée par
  `tests/test_comfych_integration.py`, `tests/test_comfych_restart_worker.py`
  (pack) et `js/test_comfych_menu.mjs` / `js/test_comfych_run_monitor.mjs`.
  Le dépôt `/projects/ComfyCH` reste la référence de ces tests.
- **`.git`/`__pycache__` : non repris** (bruit).
- **`web/modal_gateway.js` : déplacé vers `js/comfych/modal_gateway.js`**, car
  un sous-dossier d'extension n'a pas de `WEB_DIRECTORY` pris en charge par
  ComfyUI. Il est importé par le point d'entrée `js/comfych_gateway.js`.
  Modifications apportées (le reste est inchangé) : sélecteur **hébergé** par le
  menu AIH (`window.AIHComfyCHHost`) — **plus d'injection dans la barre d'outils
  de ComfyUI** —, mode de rendu forcé en mémoire, mode lu depuis un **état en
  mémoire** et non depuis le DOM (le menu peut être fermé).

### Arbitrage d'interface : ligne inline plutôt que panneau volant

La ligne **« ComfyCH »** du menu `AI Helper ▾` porte **en ligne** ses contrôles
(sélecteur GPU à droite du libellé, bouton ⚙ ensuite) plutôt que dans un
sous-panneau volant imbriqué. Raisons : un seul niveau de menu (rien ne peut se
refermer au passage), fermeture **Échap / clic extérieur** et navigation clavier
identiques au reste du menu (déjà testées), et contrôles atteignables au clavier
dans le menu. Le menu ne se ferme pas quand on manipule ces contrôles.

**Clic sur le libellé « ComfyCH » = ouverture de la modale de réglages ComfyCH**
(même action que le bouton ⚙). Décision : la ligne n'est pas une simple ligne de
contrôles inerte — un clic sur son libellé doit faire quelque chose de visible.
Un clic **dans** les contrôles (sélecteur GPU, ⚙, badge de file) garde son
comportement propre et n'ouvre jamais la modale par ricochet ; le menu reste
ouvert dans tous les cas.

### Cadres d'étapes à hauteur fixe (mise en page stable)

Les trois cadres d'étape de la modale de réglages (`.modal-step` : Build,
Nodes, Modèles) ont une **hauteur fixe et identique** (420 px en disposition
large, 260 px quand les étapes s'empilent sous 900 px de fenêtre). Le CSS est
**injecté par le module** (`injectModalStyles()`, `js/comfych/modal_gateway.js`),
il n'y a pas de feuille dédiée.

**Ce qui faisait sauter la mise en page** : la zone des étapes était en
`flex: 0 1 auto` et la grille se dimensionnait sur son contenu. Déplier
« Connexion », agrandir la zone de logs ou réduire le panneau **comprimait** les
cadres (mesuré : 385 px → 255 px), et le contenu était coupé au milieu d'une
ligne.

**Arbitrage — hauteur FIXE plutôt que `min-height`** : chaque cadre contient
déjà une tête et un pied non compressibles (`flex-shrink: 0`) et un **corps
défilable** (`.modal-step-body`, `flex: 1`, `min-height: 0`,
`overflow-y: auto`) — rien ne peut donc être écrasé. Un `min-height` aurait au
contraire laissé la grille se dimensionner sur le contenu (hauteurs différentes
d'une étape à l'autre, exactement le défaut à corriger). Le contenu trop long
(aide, listes, bandeau d'erreur, log) défile **dans** le cadre.

**Conséquence assumée** : les cadres ne se comprimant plus, c'est le **panneau**
qui devient défilable (`overflow-y: auto`) quand il est trop court. Agrandir la
modale profite toujours aux logs (`flex: 1 1 auto`, plancher 150 px).

**Ne pas réintroduire** : `height: auto` sur `.modal-step`, un `min-height`
variable sur les cadres, `flex: 0 1 auto` sur `.modal-steps`, ou un corps sans
`min-height: 0` / `overflow-y: auto`. Verrouillé par
`js/test_comfych_step_frames.mjs` (4 états × 4 mutants) ; les valeurs de la
grille (`grid-auto-rows`) et des cadres doivent rester **égales**.

### Pièges corrigés dans le menu (ne pas les réintroduire)

1. **`li.querySelector('div')` dans `mainButton.onclick`** (`js/holaf_main.js`) :
   cette boucle rafraîchit l'état des cases à cocher des entrées à bascule en
   prenant le **premier `<div>`** de chaque ligne. La ligne ComfyCH en contient
   un (le conteneur des contrôles, `#modal-gateway-container`) : elle était donc
   prise pour une case à cocher et **vidée** (`innerHTML = ""`) dès la première
   ouverture du menu — sélecteur GPU et ⚙ disparaissaient. La cible est
   désormais explicite : `.holaf-menu-check`.
2. **Mesure du popup avant affichage** (`showDropdown()`, même fichier) :
   `offsetWidth` vaut 0 tant que le menu est en `display:none` ; l'ancien code
   retombait sur `min-width` (150 px) et positionnait le menu comme s'il faisait
   150 px, si bien qu'un contenu plus large **débordait à droite de la fenêtre**
   (bouton « AI Helper » dans la barre d'outils, à droite). Le menu est
   maintenant mesuré après passage en `display:block` (`visibility:hidden`, donc
   sans flash) et son bord droit est **clampé** dans la fenêtre.
3. **Ordre de chargement** : `js/holaf_main.js` importe explicitement
   `js/comfych_gateway.js`, pour que le pont `window.AIHComfyCHHost` soit présent
   **avant** le premier rendu du menu (ComfyUI importe les `.js` du
   `WEB_DIRECTORY` en parallèle). La reprise périodique du montage reste en place
   comme filet de sécurité, avec un message explicite si le module manque.

### Note : nom de dossier `tools/`

`tools/` n'a pas de `__init__.py` : c'est un **paquet d'espace de noms**
implicite, résolvable parce que le pack ajoute sa racine à `sys.path`. Le module
ComfyCH est chargé sous le nom **unique** `holaf_comfych` (jamais `tools` ni
`comfych`), donc aucune collision d'import interne. Le seul risque théorique
reste un paquet tiers nommé `tools` installé dans l'interpréteur de ComfyUI (le
pack étant en tête de `sys.path`) : vérifié absent du venv de référence
(`importlib.util.find_spec("tools")` → `None`).

---

## Suivi de run : fenêtre NON bloquante (remplace l'overlay de chargement)

Pendant un rendu cloud, l'ancien `#modal-loading-overlay`
(`js/comfych/modal_gateway.js`) affichait **une ligne d'info dans une bulle
centrée** sur un fond `position: fixed` plein écran : la bulle était en
`pointer-events: auto` **au milieu de ComfyUI** et rien n'était consultable
(progression, logs, erreur).

Le suivi est désormais une **fenêtre `AIH.Dialog` en `modal: false`** (la
primitive de fenêtre du pack — aucun second système de modale) :

- **non bloquante** : aucun overlay n'est créé, ComfyUI reste utilisable ; la
  fenêtre se déplace, se redimensionne (position mémorisée) et se **ferme sans
  annuler le run** (aucun `AbortController` touché) ;
- **rouvrable** : l'état (lignes, statut, erreur) vit dans le module, pas dans le
  DOM. Point d'entrée : le **badge « File : N »** du sous-menu
  `AI Helper ▾ → ComfyCH` (aussi indicateur discret du run en cours), et
  `window.AIHComfyCHHost.openRunMonitor()` ;
- **infos du run** : identifiant, état (transfert / génération / tentative /
  terminé / échec / annulé), GPU, **durée** (tick 1 s), file d'attente,
  activité du log. Il n'existe **pas** de pourcentage de progression côté
  gateway (`POST /generate` est une requête unique) : la progression affichée
  est donc l'état + la durée + l'activité du log, jamais un faux pourcentage ;
- **logs en direct** : polling de la route **existante**
  `GET /api/modal/worker-logs?lines=400&gpu=…` (tail du `comfyui.log` du worker
  Modal, lu par une fonction **CPU** : aucun réveil GPU). Seul le **delta** est
  ajouté (ancrage sur la dernière ligne connue ; ancre introuvable = log
  réinitialisé, signalé) ;
- **plafond** : `RUN_LOG_MAX_LINES = 800` lignes conservées au maximum, le
  nombre de lignes masquées est **affiché** (jamais 100 000 lignes en mémoire) ;
- **défilement** : suivi automatique du bas, **pause** dès que l'utilisateur
  remonte (on ne lui arrache pas sa lecture) + bouton « Aller à la fin » ;
- **à la fin** : log complet, bloc d'erreur mis en évidence, boutons **Copier le
  log**, **Copier l'erreur** (`navigator.clipboard` + repli `execCommand`) et
  **Télécharger .txt** (Blob local).

Fermer la fenêtre n'annule pas le run ; l'annulation reste **explicite**
(« Annuler la file » : rendus *en attente* uniquement, état `cancelled` distinct
de `failed`).

---

## Redémarrer le worker Modal (sync PUIS redémarrage)

**Pourquoi un ordre imposé.** Le worker recopie le volume `/user-settings` dans
`ComfyUI/user` **uniquement au démarrage du container**
(`tools/comfych/workers/base_worker.py`, `_sync_user_settings_from_volume`,
appelé depuis `start_checkpoint` **et** `start_restore` ; aucun `reload`
pendant la vie du container). Redémarrer **avant** la synchronisation ferait
donc relire l'**ancien volume** par le container neuf : la sync serait perdue
en silence.

`POST /api/modal/restart-worker` exécute donc, dans cet ordre :

1. `modal run sync.py` (fichiers locaux → volume) — si cette étape échoue, la
   séquence **s'arrête** (« étapes suivantes ANNULÉES ») et le worker n'est pas
   redémarré ;
2. `modal container list --app <app> --json` puis `modal container stop <id>`
   pour chaque container (repli en sortie texte si la CLI n'accepte pas
   `--json`). **Aucun container actif n'est pas un échec** (« rien à arrêter »),
   mais une CLI **incapable de lister** est un **échec explicite** : l'UI
   n'affiche jamais un faux « redémarré ». Le nom de l'app vient de
   `worker_app_name` (config), défaut `modal-comfy-gateway`.

**Garde-fous.** Opération déjà en cours (sync, deploy…) → `409` explicite
(`_op_busy_response`) et rien n'est lancé. Rendu en cours → le serveur ne peut
pas le savoir (les rendus vont du navigateur au gateway) : c'est le client qui
l'annonce (`render_in_progress`) et il ne le fait qu'après **confirmation de
l'utilisateur** (`confirm: true`) ; sans confirmation, le serveur refuse (`409`,
`needs_confirm`).

**Où.** Modale de réglages ComfyCH, étape **Build** : ligne
« ♻️ Worker Modal → ♻️ Redémarrer », avec un rappel de l'ordre. Les logs de
l'opération s'affichent dans le panneau de logs **existant** (SSE
`/api/modal/logs/stream`).

---

## Dépendances des custom nodes et « Deployment skipped »

**Les dépendances des custom nodes sont installées dans l'image au build.** Le
build scanne le dossier `custom_nodes` **local** (celui de la machine qui lance
`modal deploy`) et installe, dans cet ordre :

1. le `requirements.txt` **du pack AI-Helper** — toujours, en priorité (`watchdog`,
   `aiohttp`, `av`, `psutil`… : sans eux le pack ne s'importe pas du tout sur le
   worker et **tous** ses nodes disparaissent de ComfyUI) ;
2. le `requirements.txt` de **chaque** custom node détecté (`cv2`, `gguf`, `pywt`,
   `dlib`…) ;
3. les `extra_pip_packages` de la configuration.

Une dépendance en échec **n'arrête jamais le build** (le node échouera au
chargement), mais laisse une ligne `❌ ÉCHEC des dépendances de <node>` dans le
log de déploiement : le nom du node fautif y est lisible, plus besoin de traquer
un `ModuleNotFoundError` opaque dans le log du worker. Le dossier est résolu par
`$COMFYCH_CUSTOM_NODES_DIR`, sinon par la position du pack (`custom_nodes/…`) ;
s'il est introuvable, le build le dit explicitement.

**Le code, lui, ne vient PAS de l'image** : les nodes sont liés depuis le volume
`comfy-custom-nodes` au démarrage du worker (voir « Une seule source de
vérité »). Un `pip` manquant côté worker = `requirements.txt` incomplet sur la
machine locale, puis redéploiement ; un node absent = sync des custom nodes.

**« ✓ Deployment skipped: no changes detected! ⏭️ »** : `modal deploy` n'a
**aucun flag `--force`**. Si la définition de l'app n'a pas changé, la CLI saute
le déploiement et l'image n'est **pas** reconstruite — les dépendances ajoutées
ne sont donc jamais installées. L'image porte pour cela une **empreinte de
déploiement** (`COMFYCH_DEPLOY_STAMP` : contenu des `requirements.txt`, liste des
nodes détectés, `extra_pip_packages`) : toute modification de dépendances change
l'empreinte, donc l'image, donc le déploiement n'est plus sauté.

Pour forcer malgré tout (cache douteux, image à rafraîchir) :

- bouton **« 🔨 Forcer le déploiement »** (étape **Build** de la modale, sous
  « 🚀 Déployer ») ;
- ou `POST /api/modal/deploy` avec `{"force": true}`.

Les deux posent `COMFYCH_DEPLOY_FORCE_TOKEN` sur le subprocess `modal deploy`,
qui régénère l'empreinte. C'est une couche `ENV` posée **en dernier** : aucune
couche `pip` déjà en cache n'est réexécutée.

---

## Erreurs fréquentes du worker (configuration, pas bugs)

Ces messages apparaissent dans le log du rendu cloud. Aucun n'est un bug du
pack : ce sont des **écarts entre la machine locale et l'image du worker**.
Ils sont documentés ici pour être traités en une minute.

### `ModuleNotFoundError: No module named 'sageattention'` (comfyui-kjnodes)

Le node `comfyui-kjnodes` importe **optionnellement** `sageattention` ; l'image
du worker ne l'installe pas. Selon la version du node, l'import est toléré
(performance moindre) ou fait échouer **ce node-là** (les autres continuent).

**Marche à suivre** — ajouter le paquet à l'image :
1. `tools/comfych/config.json` → clé **`extra_pip_packages`** (liste de
   paquets pip ajoutés à l'image `image.py`) ;
2. y ajouter `"sageattention"` — ou, si aucune roue précompilée ne correspond à
   la version de torch/CUDA de l'image, `"sageattention>=2"` ;
3. relancer **`modal deploy apps/all_in_one.py`** (l'image est reconstruite :
   les couches suivantes sont rejouées, c'est normal).

Si le paquet reste introuvable pour la plateforme, l'alternative est de
**retirer** `comfyui-kjnodes` de `custom_nodes_ext` (ou de désactiver les nodes
du pack qui en dépendent) : le reste du graphe rend sans lui.

### `AIHUpscale: Value not in list: model_name: '4x-AnimeSharp.pth' not in [...]`

Le workflow référence un modèle d'upscale **absent du volume du worker**. La
liste affichée entre crochets est celle réellement montée : c'est la preuve que
le fichier n'a jamais été synchronisé (il n'existe pas localement au bon
endroit, ou il a été ajouté après la dernière sync).

**Marche à suivre** :
1. vérifier la présence **locale** du fichier dans
   `ComfyUI/models/upscale_models/` (le pack synchronise ce dossier, pas un
   chemin arbitraire) ;
2. l'ajouter à la liste **`models_to_sync`** de `tools/comfych/models.py` s'il
   vit dans un sous-dossier ou vient de HuggingFace / d'une URL externe ;
3. relancer la sync des modèles (`modal run sync.py`), puis **redémarrer le
   worker** (les modèles sont liés au démarrage par
   `_link_models_from_manifest`).

### `ComfyUI-Manager: InvalidChannel https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main`

**Bruit.** ComfyUI-Manager publie ses catalogues depuis une branche qui n'existe
plus sous ce nom ; la version embarquée dans l'image tente l'ancienne URL et
affiche cette erreur **une fois par tentative de rafraîchissement**. Cela
n'affecte ni le chargement des nodes ni le rendu. Rien à corriger côté pack :
mettre à jour `ComfyUI-Manager` dans `custom_nodes_ext` fait disparaître le
message.

### `base_path '…' resolves outside allowed directory '…'. Falling back.`

**Informatif (une seule fois par chemin).** Le widget `base_path` contient un
chemin **de la machine locale** (ex. `/config/outputs/ComfyUI/`) ; le worker le
refuse par sécurité et écrit dans **son** dossier de sortie. Le garde-fou reste
actif ; le message n'est plus répété à chaque image (voir
`nodes/holaf_node_helpers.py`, `_warn_path_fallback_once`). Corriger le widget
(chemin relatif au dossier de sortie) fait disparaître l'avertissement.

### `[AIH sync] credentials incomplets (api_key ou server_url manquant)`

Voir la section suivante : la sync pousse désormais le fichier **même s'il
existe déjà** sur le volume, et deux lignes de diagnostic disent précisément où
ça casse (côté sync, puis au démarrage du worker).

### Vérifier ce que le worker a réellement lu (credentials)

1. **Log de la sync** (`modal run sync.py`) :
   `📁 user/ : N fichier(s), credentials.json présent=oui (default/AI-Helper/config/credentials.json), server_url=renseignée, api_key=renseignée`
   — si `présent=non`, le fichier n'est pas dans le dossier `user/`
   effectivement synchronisé (résolution de `user/`, ou réglages enregistrés
   ailleurs) ; si `vide`, l'UI n'a rien écrit là que la sync lit.
   La valeur de la clé n'est **jamais** affichée (seulement sa présence).
2. **Log du worker** (démarrage) :
   `🔵 [Holaf-AIH] credentials: server_url=renseignée api_key=renseignée (source: fichier /root/comfy/ComfyUI/user/default/…/credentials.json)`
   — `ABSENT` ou `vide` = le volume n'a pas la bonne version : relancer la sync
   **puis** redémarrer le worker (il ne relit le volume qu'au démarrage).

---

## Vérifier après un redémarrage

1. `AI Helper ▾` → **Settings → Applications WIP** → activer **ComfyCH**.
2. Rouvrir `AI Helper ▾` : la section **Outils & Dev** contient la ligne
   **ComfyCH** avec le sélecteur GPU et le bouton ⚙.
3. La **barre d'outils** de ComfyUI ne doit **plus** contenir l'ancien
   sélecteur de GPU.
4. Console du navigateur : `Modal Gateway: mode de rendu forcé par le serveur =
   local (forçage EN MÉMOIRE …)`.
5. Journal serveur : `🔵 [Holaf-ComfyCH] mode rendu forcé à « local » au
   démarrage (config intacte : aucun fichier modifié).`
