# Réparer un workflow (niveau JSON)

Outil du pack ComfyUI-AI-Helper pour **réparer des workflows ComfyUI au niveau
JSON**, plutôt que sur le graphe vivant. Motif : après un remplacement de type
de node, ComfyUI rejoue des hooks post-swap qui re-résolvent les connexions sur
le graphe vivant et ont déjà détruit des liens. La sérialisation JSON est
déterministe, testable hors ligne et vérifiable AVANT écriture.

## Architecture

- **Cœur métier : Python** — `aih/repair_workflow.py` (pur, sans dépendance
  ComfyUI) : analyse, regroupement, remappage des widgets, validation,
  réparation, diff. Testable offline.
- **Routes : Python** — `aih/routes.py::_register_repair_group` :
  - `GET  /aih/repair/workflows` — liste `user/default/workflows/**` (même
    arborescence que `/api/userdata` du frontend).
  - `POST /aih/repair/analyze` — rapport GROUPÉ (une entrée par type).
  - `POST /aih/repair/apply` — `mode=preview` (JSON réparé en mémoire),
    `overwrite` (écrase + sauvegarde `.bak`) ou `save_as` (copie). REFUSE
    d'écrire si de NOUVELLES incohérences apparaissent.
- **UI : JS** — `js/aih_repair_workflow.js` (fenêtre `AIH.Dialog`, i18n
  centralisée dans `js/aih_strings.js`). Le JS ne fait que l'UI et les appels.
- **Tests** — `tests/test_repair_workflow.py` (Python, 40 tests) et
  `js/test_aih_repair_workflow.mjs` (UI jsdom).

## Format JSON géré (frontend de référence 1.47.11)

- `links` : **tableau de tableaux** (schéma v0.4, `LLink.serialize`) OU
  **tableau d'objets** (`LLink.asSerialisable`) OU **objet indexé par id**
  (ancien). Les trois sont lus ; le format d'origine est conservé à l'écriture.
- `definitions.subgraphs` : chaque subgraph a ses propres
  `nodes`/`links`/`groups`/`inputs`/`outputs`/`widgets` et peut être imbriqué.
  Les nodes absentes DANS les subgraphs sont analysées et réparées aussi.
- Slots virtuels de subgraph : `inputNode`/`outputNode` (ids `-10`/`-20`).

## Point d'extension (futurs types de problèmes)

L'analyse est une liste de DÉTECTEURS indépendants — `DETECTORS` dans
`aih/repair_workflow.py`. Chaque détecteur est
`(AnalyzeContext) -> Iterable[ProblemOccurrence]` et émet des occurrences avec
un `kind`, une `key` (regroupement), une `occurrence` (scope + id) et une
`action` optionnelle. Le regroupement, l'affichage cochable, le rapport et la
validation sont GÉNÉRIQUES.

Pour ajouter une vérification (liens pendants, valeurs de widgets inconnues,
nodes dépréciées…) : écrire un détecteur et l'ajouter à `DETECTORS`. Côté UI,
aucun changement : `js/aih_repair_workflow.js` rend telle quelle la liste
renvoyée par le serveur.

## Table de remplacement

`LEGACY_ALIAS_REPLACEMENTS` (34 alias legacy supprimés `Holaf*`/anciennes clés
→ `AIH*`), alignée sur `tests/test_node_registration_unique.py`. Un type
inconnu SANS proposition est affiché dans un groupe « sans proposition »
(non cochable) — aucune correspondance n'est inventée.

## Remappage des widgets

`widgets_values` est POSITIONNEL : lors d'un remplacement, les valeurs sont
remappées PAR NOM de widget (`remap_widget_values`) à partir des définitions de
classes (`/object_info` → `build_class_defs_from_nodes`). Les valeurs non
remappables sont signalées dans le rapport (`unmapped_widgets`).
