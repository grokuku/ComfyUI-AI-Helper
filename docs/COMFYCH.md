# ComfyCH — génération distante sur Modal (intégré au pack)

ComfyCH (extension ComfyUI historique « Modal Gateway ») est **une partie
intégrante** de ce pack : son code vit dans [`tools/comfych/`](../tools/comfych)
et il est **toujours chargé** au démarrage. Seule sa **visibilité** est pilotée
par le registre WIP existant (`js/holaf_wip_settings.js` → feature `comfych`,
masquée par défaut, mémorisée dans `localStorage`).

Il apporte :

- un **sélecteur de GPU** (Local / L4 / L40S / A100 / H100) et un bouton **⚙**
  de réglages, dans le menu **`AI Helper ▾` → Outils & Dev → ComfyCH** ;
- des routes `/api/modal/*` (sync des modèles, déploiement, logs, réglages…) ;
- l'**interception du bouton Queue** : quand un GPU cloud est choisi, les
  workflows partent sur Modal au lieu de la machine locale.

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

## Ce qui a été repris de ComfyCH (et ce qui ne l'a pas été)

Repris dans `tools/comfych/` : `__init__.py` (routes + opérations),
`sync.py`, `image.py`, `helpers.py`, `auth.py`, `gateway_router.py`, `models.py`,
`plugins.py`, `apps/`, `workers/`, `vendor_nodes/`, `config.example.json`,
`requirements_comfy.txt`, la documentation d'origine.

- **`tests/` du dépôt ComfyCH : non repris.** Ils testent le pipeline Modal
  standalone avec des stubs internes de `modal`/`fastapi` (absents du venv de
  développement) ; la couverture utile ici est apportée par
  `tests/test_comfych_integration.py` (pack) et `js/test_comfych_menu.mjs`.
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

### Note : nom de dossier `tools/`

`tools/` n'a pas de `__init__.py` : c'est un **paquet d'espace de noms**
implicite, résolvable parce que le pack ajoute sa racine à `sys.path`. Le module
ComfyCH est chargé sous le nom **unique** `holaf_comfych` (jamais `tools` ni
`comfych`), donc aucune collision d'import interne. Le seul risque théorique
reste un paquet tiers nommé `tools` installé dans l'interpréteur de ComfyUI (le
pack étant en tête de `sys.path`) : vérifié absent du venv de référence
(`importlib.util.find_spec("tools")` → `None`).

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
