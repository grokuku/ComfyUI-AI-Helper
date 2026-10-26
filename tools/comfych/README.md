# ComfyCH — Modal Gateway pour ComfyUI

> **Intégré au pack ComfyUI-AI-Helper** : ce dossier n'est PAS une extension à
> poser dans `custom_nodes/`. Le code vit ici (`tools/comfych/`) et le pack le
> charge toujours ; les données (config, logs) et l'interface (menu `AI Helper ▾`)
> sont gérées par le pack. Documentation d'intégration :
> [`docs/COMFYCH.md`](../../docs/COMFYCH.md) — les chemins `web/modal_gateway.js`
> et `config.json` cités ci-dessous sont ceux de la version autonome : ici le
> frontend est dans `js/comfych/` et la config dans l'arborescence utilisateur.

Déporte sélectivement les rendus GPU lourds (FLUX, Wan2.2, gros batches) de votre
ComfyUI local vers le cloud **Modal** (L4 / L40S / A100 / H100), via un simple
dropdown dans la barre d'outils. Le local reste gratuit et réactif pour l'édition ;
le cloud ne sert que pour les rendus ponctuels (paiement à la seconde).

## Architecture

```
┌── Machine locale (ComfyUI) ──────────────┐     ┌── ☁️ Modal ──────────────────────────────┐
│  __init__.py  → routes /api/modal/*      │     │  Volume "comfy-models" (modèles partagés)  │
│  web/modal_gateway.js → dropdown + queue │────▶│  Routeur FastAPI (gateway_router.py)       │
│  Interception de Queue Prompt            │ HTTP │  ├─ /generate  (idempotent, auth X-API-Key) │
└──────────────────────────────────────────┘     │  └─ /upload/image, /view, /history        │
                                                 │  Workers GPU headless (workers/base_worker)│
                                                 │  sync.py (CPU ~5¢/h) → remplit le volume   │
                                                 └───────────────────────────────────────────┘
```

## Composants

| Fichier | Rôle |
|---|---|
| `__init__.py` | Extension ComfyUI : routes API (config, sync, deploy, logs SSE, détection modèles/plugins, save-local) |
| `web/modal_gateway.js` | Extension JS : dropdown GPU, file d'attente, modale de configuration |
| `gateway_router.py` | Routeur FastAPI partagé (auth `X-API-Key`, idempotence, /generate, /upload/image, /view, /history) |
| `auth.py` | Auth du gateway (Secret Modal `comfy-gateway-secret`) |
| `workers/` | `ComfyWorker` de base + sous-classes par GPU (L4, L40S, A100, H100) |
| `apps/all_in_one*.py` | Apps Modal déployables (4 / 3 / 1 workers) |
| `sync.py` | Sync CPU des modèles locaux + HuggingFace vers le volume ; upload chunké des modèles locaux (100 Mo) directement dans le volume (plus de rebuild d'image) ; sync des custom nodes par tar.gz vers le volume dédié `comfy-custom-nodes` |
| `image.py` | Image Docker partagée des workers |
| `models.py` / `plugins.py` | Listes de modèles / custom nodes |

## Mise en route

1. **Installer l'extension** : copier ce dossier dans `ComfyUI/custom_nodes/ComfyCH`
   et redémarrer ComfyUI. Un sélecteur 🎮 apparaît dans la barre d'outils.
2. **Configurer la connexion** : ⚙️ Paramètres → « Connexion API Modal » →
   renseigner l'URL du gateway (`https://xxx.modal.run`) et la clé API.
3. **Clé API du gateway** : `modal secret create comfy-gateway-secret API_KEY=<clé>`
   (ou Dashboard Modal → Secrets), puis déployer. La même clé va dans les paramètres.
4. **Token Modal** (optionnel, remplace `modal token set`) : ⚙️ Paramètres →
   « Token Modal (compte) » → coller Token ID + Token Secret du site Modal.
5. **Déployer** : `modal deploy apps/all_in_one.py` (ou via le bouton 🚀 Deploy API).
6. **Synchroniser les modèles** : détecter et sélectionner vos modèles locaux dans
   les paramètres, puis « 📥 Sync Models » (upload CPU vers le volume).

> 💡 Le worker monte désormais aussi le volume `comfy-custom-nodes` (créé
> automatiquement au premier déploiement) pour servir les custom nodes synchronisés.

## Utilisation

- Choisissez **Local** (gratuit) ou un GPU cloud dans le dropdown.
- En mode cloud, « Queue Prompt » intercepte le workflow, l'envoie à `/generate`
  et affiche les images reçues (sauvegardées aussi dans `ComfyUI/output/`).
- La file d'attente (badge 🎮) gère les rendus un par un ; le `request_id`
  d'idempotence évite la double facturation lors des retries réseau.

### Synchronisation

- **Sync des modèles** : les modèles locaux sont streamés par **chunks de 100 Mo**
  directement dans le volume `comfy-models` — **plus de rebuild d'image** à chaque
  sync (bouton « 📥 Sync Models » de la modale).
- **Sync des custom nodes** : le bouton « 📦 Sync Custom Nodes » de la modale (ou
  `modal run sync.py --custom-nodes`) empaquette les custom nodes locaux en
  `tar.gz` (protection path traversal + swap atomique) et les pousse vers le
  volume `comfy-custom-nodes`. Les workers les **symlinkent au démarrage** —
  **sans redeploy** pour changer un node.

### Dépendances optionnelles des custom nodes

Certains custom nodes importent une dépendance **optionnelle** qu'ils ne
déclarent jamais dans leur `requirements.txt` : le node se charge, puis le rendu
échoue avec `ModuleNotFoundError` (`sageattention` pour comfyui-kjnodes /
`PatchSageAttention`, `mediapipe` pour comfyui_facetools, `ultralytics`…).

La modale (étape 1 « Build ») expose pour cela un champ **Paquets pip
supplémentaires** : une liste séparée par des virgules, par exemple

```
sageattention, mediapipe, ultralytics
```

Ces paquets sont installés **au build de l'image**, après les requirements des
nodes, en **best-effort** : un échec (`sageattention` a besoin d'un GPU/CUDA pour
se compiler, version incompatible, index injoignable) affiche un avertissement
dans le log du build et **n'empêche jamais** l'image d'être construite ni le
déploiement d'aboutir — seul le node concerné échouera à l'exécution. Il faut
redéployer (🚀 Déployer) pour que la liste prenne effet.

Les noms sont validés (liste blanche de caractères) : une entrée contenant un
métacaractère shell (`;`, `&`, `|`, `$`, espaces…) est ignorée à l'enregistrement
et au build.

## Sécurité

- Routes du gateway protégées par `X-API-Key` (fail-closed : 401 si mauvaise clé,
  503 si non configurée). Ne pas utiliser le token de compte Modal comme clé de gateway.
- `/api/modal/save-local` sanitisé contre le path traversal (résolution + vérification
  du chemin sous `output/`).

## Tests

```bash
python3 tests/test_gateway.py
```

Tests sans dépendances (stubs fastapi/modal) : idempotence de `/generate` et
sanitisation anti path traversal.

## Déploiement multi-variantes

- `apps/all_in_one.py` — L4 + L40S + A100 + H100
- `apps/all_in_one_lite.py` — sans H100
- `apps/all_in_one_l4.py` — L4 seul (plan Starter sans carte bancaire)
