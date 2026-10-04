# Compatibilité Nodes 2.0 (rendu Vue) — note de migration

Statut : **le mode classique (LiteGraph canvas) reste le mode de production de
l'utilisateur.** Toute UI du pack doit continuer de fonctionner *exactement*
comme avant en mode classique, ET fonctionner aussi quand le réglage
« Modern Node Design (Nodes 2.0) » est activé. Objectif = **double compatibilité**,
pas migration vers Vue.

## 1. Ce que le rendu Vue de ComfyUI saute (source de référence 1.47.11)

Fichier de référence : `/projects/AI-Helper/comfyui-frontend-src`.

| Hook | Sorte | En `vueNodesMode` | Preuve (source) |
|---|---|---|---|
| `node.onDrawForeground` / `node.onDrawBackground` | node | **SAUTÉ** | `LGraphCanvas.drawNode` retourne tôt (`LGraphCanvas.ts` ~5656) |
| `node.onMouseDown/Move/Enter/Leave` | node | **SAUTÉ** | `processMouseMove` met `node = null` (`LGraphCanvas.ts` ~3339) |
| `canvas.onDrawForeground` | **canvas** | **SURVIT** | appelé dans `drawFrontCanvas` (`LGraphCanvas.ts` ~5203) |
| `node.setSize/measure/move` (layout) | node | **INACTIF** | taille/position viennent du DOM (ResizeObserver → layoutStore) |
| `widget.hidden` | widget | non lu | canvas lit `widget.hidden` (`LGraphNode.ts` ~3995/4004) ; Vue lit `options.hidden` (`isWidgetVisible`) |
| `widget.draw()` (widget custom) | widget | **rendu** (monté par `WidgetLegacy.vue`) | `WidgetLegacy.vue` appelle `widgetInstance.draw(ctx,node,width,1,height)` |
| `widget.options.values` = **tableau** | widget | rendu (WidgetSelect lit `options.values`) | `WidgetSelectDefault.vue` |
| `widget.callback` | widget | **appelé** | `useProcessedWidgets.createWidgetUpdateHandler` |

## 2. Motifs à ÉVITER (cassent ou dégradent en Nodes 2.0)

- ❌ `nodeType.prototype.onDrawForeground = …` / `this.onDrawForeground = …`
  (le dessin node-level est sauté).
- ❌ `node.onMouseDown/Move/Enter/Leave = …` (jamais appelés en Vue).
- ❌ `nodeType.prototype.getCustomWidgets` (obsolète ; utiliser `addDOMWidget`).
- ❌ Compter sur `widget.hidden = true` seul (le canvas le lit, **pas** Vue).
- ❌ Compter sur `setSize/measure/move` pour la mise en page (inactifs en Vue).
- ❌ `options.values` sous forme de **fonction** : supportée mais dépréciée et
  elle désactive les flèches ± du combo en classique (`ComboWidget.canUseButton`).

## 3. Motifs à PRIVILÉGIER

- ✅ **Widget DOM** : `node.addDOMWidget(name, type, element, opts)` → monté par
  `WidgetDOM` en Vue et par l'overlay `DomWidgets.vue` (piloté par
  `canvas.onDrawForeground`) en classique. **Chemin éprouvé dans ce pack** :
  enhancer, elements, keywords, loader image/vidéo, resolution preset v2.
- ✅ **Masquer un widget** : poser `hidden` **ET** `options.hidden`
  (`import { setWidgetHidden } from "./holaf_nodes2_compat.js"`).
- ✅ **Entretien d'une UI canvas** (DOM à réinjecter, combo à rafraîchir) :
  utiliser le hook **canvas-level** survivant via `onCanvasDraw(cb)`
  (`js/holaf_nodes2_compat.js`). Le callback n'est appelé **qu'en vueNodesMode**
  → no-op strict en classique.
- ✅ `options.canvasOnly = true` seulement si l'UI est réellement dessinée hors
  du node (overlay propre) — sinon le widget disparaît en Vue.

## 4. Cas connus du pack

| Fichier | Node(s) | Statut Nodes 2.0 |
|---|---|---|
| `js/holaf_remote_control.js` | AIHRemote, AIHBypasser, AIHGroupBypasser, AIHSimpleBypasser, AIHRemoteSelector | ✅ Remote/Selector **fonctionnels** (widgets standard, callbacks). SimpleBypasser masqué via `options.hidden`. Combo `comfy_group` rafraîchi via `onCanvasDraw`. |
| `js/holaf_to_text.js` | AIHToText | ✅ Rendu riche entretenu via `onCanvasDraw` (chemins classique + Vue). |
| `js/holaf_image_comparer.js` | AIHImageComparer | ⚠️ **Dégradé** : le widget s'affiche (WidgetLegacy) mais l'interaction Slide/Click (survol A/B) repose sur `onMouse*` node-level non appelés en Vue. **Signal runtime** (`console.warn`) au node creation. |
| `js/holaf_remote_comparer.js` | AIHRemoteComparer | ✅ Fenêtre flottante DOM pilotée par `executed` — indépendante du renderer. |

## 5. Garde-fou

`tests/test_frontend_nodes2_compat.py` interdit tout nouveau hook node-level à
risque non justifié (allowlist explicite + preuve de bridge/ signal), avec
contrôles négatifs par mutation. Preuve double-mode :
`js/test_nodes2_compat.mjs` (harnais jsdom chargeant les vrais modules,
`vueNodesMode` simulé true et false).
