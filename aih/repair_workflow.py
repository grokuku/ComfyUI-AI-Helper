# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""repair_workflow.py — Analyse & réparation de workflows ComfyUI AU NIVEAU JSON.

Pourquoi cette approche JSON plutôt que la manipulation du graphe vivant ?
----------------------------------------------------------------------------
ComfyUI rejoue, après un remplacement de type de node (``change_node_type``),
des hooks post-swap qui re-résolvent les connexions sur le graphe vivant :
des liens ont déjà été détruits par ce chemin. Travailler sur la sérialisation
JSON — le MÊME format que ``app.graph.serialize()`` / ``/userdata`` — est
déterministe, testable hors ligne et vérifiable AVANT écriture.

Ce module est PUR (aucune dépendance ComfyUI) : il ne fait que de la lecture /
mutation de structures Python. Les routes HTTP (``aih/routes.py``) l'appellent
avec le JSON lu sur disque ou collé par l'utilisateur.

Format JSON réel (frontend de référence 1.47.11)
-------------------------------------------------
Source de référence : ``/projects/AI-Helper/comfyui-frontend-src``.

- ``src/lib/litegraph/src/LGraph.ts`` :
  - ``serialize()`` (v0.4, déprécié) → ``links`` = **tableau de tableaux**
    ``[id, origin_id, origin_slot, target_id, target_slot, type]`` et les
    reroutes/parentIds vivent dans ``extra`` (``extra.reroutes``,
    ``extra.linkExtensions``) ; ``version === 0.4``.
  - ``asSerialisable()`` (schéma courant, ``version`` 0 ou 1) → ``links`` =
    **tableau d'objets** ``{id, origin_id, origin_slot, target_id,
    target_slot, type, parentId?}`` ; ``state``/``reroutes`` au niveau racine.
- ``src/lib/litegraph/src/LLink.ts`` : ``SerialisedLLinkArray`` (tableau,
  ligne 33) vs ``SerialisableLLink`` (objet, ligne ~495).
- ``src/lib/litegraph/src/types/serialisation.ts`` : ``definitions.subgraphs``
  = liste de ``ExportedSubgraph`` ; chaque subgraph a ses propres
  ``nodes``/``links``/``groups``/``inputs``/``outputs``/``widgets`` +
  ``inputNode``/``outputNode`` (slots virtuels, ids ``-10``/``-20`` par défaut,
  cf. ``src/lib/litegraph/src/constants.ts``) et peut contenir des
  ``definitions.subgraphs`` IMBRIQUÉS.
- ``src/lib/litegraph/src/subgraph/__fixtures__/testSubgraphs.json`` : preuve
  d'un ``links`` sous forme d'**objet** ``{}`` (ancien format) dans un subgraph.

→ En LECTURE ce module accepte donc : ``links`` tableau de tableaux, tableau
d'objets, ET objet indexé par id. En écriture, on conserve le format d'origine.

API des workflows sauvegardés
-----------------------------
Le frontend liste/lit/écrit via ``/api/userdata`` (``src/scripts/api.ts`` :
``getUserData`` ligne 1319, ``storeUserData`` ligne 1330,
``listUserDataFullInfo`` ligne 1392) sur le dossier ``workflows/``
(``src/platform/workflow/management/stores/comfyWorkflow.ts`` ligne 35 :
``basePath = 'workflows/'``). Côté disque cela correspond à
``<ComfyUI>/user/default/workflows/`` (même convention que le reste du pack :
``aih/routes.py::_get_aih_user_dir``). Les routes ``/aih/repair/*`` lisent et
écrivent CE dossier, ce qui permet de garantir en Python la sauvegarde
(``.bak``) et la validation AVANT écriture — ce que ``/api/userdata`` ne fait
pas.

Point d'extension (futurs types de problèmes)
---------------------------------------------
L'analyse est une LISTE DE DÉTECTEURS indépendants. Chaque détecteur est une
fonction ``(AnalyzeContext) -> Iterable[ProblemOccurrence]`` enregistrée dans
``DETECTORS``. ``analyze()`` agrège puis GROUPE les occurrences par
``(kind, key)``. Pour ajouter une vérification (lien pendant, valeur de widget
inconnue, node déprécié…) : écrire un détecteur qui émet des occurrences avec
un ``kind``/``key``/``action`` et l'ajouter à ``DETECTORS`` — rien d'autre à
changer (regroupement, cases à cocher, rapport et validation sont génériques).
"""

from __future__ import annotations

import copy
import json
import re
from typing import Any, Dict, Iterable, Iterator, List, Optional, Tuple

# ══════════════════════════════════════════════════════════════════════════
# TABLE DE REMPLACEMENT — 34 alias legacy supprimés
# ══════════════════════════════════════════════════════════════════════════
# Source de vérité : ``tests/test_node_registration_unique.py``
# (``REMOVED_LEGACY_ALIAS_KEYS``) et les clés canoniques des fichiers
# ``nodes/*.py`` (NODE_CLASS_MAPPINGS). Décision utilisateur (2026) : ces
# alias ont été SUPPRIMÉS — un workflow sauvegardé qui les référence est cassé
# et doit être réparé vers la clé canonique ``AIH*``.

LEGACY_ALIAS_REPLACEMENTS: Dict[str, str] = {
    # Anciennes clés « AIH…Node » / « AIH … » (avant la normalisation des clés)
    "AIH Ref Image Prep": "AIHRefImagePrep",
    "AIHElementsNode": "AIHElementsPicker",
    "AIHEnhanceNode": "AIHPromptEnhancer",
    "AIHIdeogram4Node": "AIHIdeogram4Builder",
    "AIHKeywordsNode": "AIHKeywords",
    "AIHLMStudioSettingsNode": "AIHLMStudioSettings",
    "AIHMusicNode": "AIHMusic",
    "AIHOpenAISettingsNode": "AIHOpenAISettings",
    # Anciennes clés « Holaf… »
    "HolafAutoSelectX2": "AIHAutoSelectX2",
    "HolafBundleCreator": "AIHBundleCreator",
    "HolafBundleExtractor": "AIHBundleExtractor",
    "HolafBypasser": "AIHBypasser",
    "HolafGroupBypasser": "AIHGroupBypasser",
    "HolafImageAdjustment": "AIHImageAdjustment",
    "HolafImageBatchSlice": "AIHImageBatchSlice",
    "HolafImageComparer": "AIHImageComparer",
    "HolafInstagramResize": "AIHInstagramResize",
    "HolafLoadImageVideo": "AIHLoadImageVideo",
    "HolafLutGenerator": "AIHLutGenerator",
    "HolafLutSaver": "AIHLutSaver",
    "HolafMaskToBoolean": "AIHMaskToBoolean",
    "HolafOverlayNode": "AIHOverlay",
    "HolafPinterestRandomImage": "AIHPinterestRandomImage",
    "HolafRemote": "AIHRemote",
    "HolafRemoteComparer": "AIHRemoteComparer",
    "HolafRemoteSelector": "AIHRemoteSelector",
    "HolafResolutionPreset": "AIHResolutionPreset",
    "HolafResolutionPresetV2": "AIHResolutionPresetV2",
    "HolafSaveMedia": "AIHSaveMedia",
    "HolafSimpleBypasser": "AIHSimpleBypasser",
    "HolafTextBox": "AIHTextBox",
    "HolafTiledKSampler": "AIHTiledKSampler",
    "HolafToText": "AIHToText",
    "UpscaleImageHolaf": "AIHUpscale",
}

assert len(LEGACY_ALIAS_REPLACEMENTS) == 34, "34 alias legacy supprimés (cf. test_node_registration_unique)"

# Slots virtuels des subgraphs (cf. src/lib/litegraph/src/constants.ts).
SUBGRAPH_INPUT_ID = -10
SUBGRAPH_OUTPUT_ID = -20

# Types connus du cœur LiteGraph qui n'apparaissent PAS dans NODE_CLASS_MAPPINGS
# mais sont valides dans un workflow (ne doivent jamais être signalés absents).
CORE_NODE_TYPES = frozenset({
    "Note",
    "MarkdownNote",
    "Reroute",
    "PrimitiveNode",
    "workflow",
    "subgraph/input",
    "subgraph/output",
})


# ══════════════════════════════════════════════════════════════════════════
# RÉFÉRENCES RÉSIDUELLES À L'ANCIEN PACK (détection + nettoyage)
# ══════════════════════════════════════════════════════════════════════════
# Le pack s'appelait avant « ComfyUI-Holaf-Utilities » (noms historiques :
# « ComfyUI-Holaf-Utilities » / « ComfyUI-Holaf-Utils » / « ComfyUI-Holaf »,
# cf. holaf_startup_checks.py). Ces noms ne sont PLUS son identité. Un workflow
# sauvegardé AVANT le renommage peut conserver des résidus :
#
#   1. ``nodes[].properties.cnr_id`` / ``properties.aux_id`` pointant sur
#      l'ancien pack. C'est CE que lit l'analyse de dépendances du Workflow
#      Share (js/aih_workflow_share.js:801-806) — il déclarait donc à tort
#      l'ancien pack comme dépendance, ce qui pouvait re-cloner la vieille copie
#      et écraser l'UI.
#   2. ``nodes[].inputs[].widget`` / ``nodes[].outputs[].widget`` =
#      ``{name: "holaf_…"}`` : références de slot vers des widgets du pack
#      historique SUPPRIMÉS (ex. ``holaf_terminal_widget`` — le node Terminal
#      est passé en fenêtre flottante ; les widgets DOM d'une valeur de
#      sérialisation portent leur NOM dans le slot, cf.
#      comfyui-frontend-src/src/lib/litegraph/src/node/slotUtils.ts:50-70 et
#      types/serialisation.ts:74/81). Inertes à l'exécution mais présentes.
#
# Décision utilisateur (2026) : nettoyer CES RÉSIDUS (jamais une vraie
# référence au pack courant ni un widget encore défini).
LEGACY_PACK_TOKENS = frozenset({
    "holafutilities",   # ComfyUI-Holaf-Utilities
    "holafutils",       # ComfyUI-Holaf-Utils
    "holaf",            # ComfyUI-Holaf
})

# Préfixe des widgets du pack historique. Un nom de widget de slot commençant
# par ce préfixe ET absent de la liste des widgets ENCORE fournis par le pack
# courant est un résidu (jamais nettoyé sinon : on ne casse pas une référence
# valide).
LEGACY_WIDGET_PREFIX = "holaf_"

# Widgets EXTENSION du pack courant (DOM/« custom », donc HORS INPUT_TYPES) :
# une référence de slot vers eux est VALIDE (à NE PAS nettoyer). Source de
# vérité : js/*.js (addDOMWidget / addCustomWidget).
CURRENT_EXTENSION_WIDGETS = frozenset({
    "holaf_comparer",       # js/holaf_image_comparer.js
    "holaf_media_loader",   # js/holaf_load_image_video.js
    "holaf_v2_ui",          # js/holaf_resolution_preset_v2.js
    "AIH_Enhance",          # js/aih_enhance_widget.js
    "elements_ui",          # js/aih_elements_widget.js
    "keywords_ui",          # js/aih_keywords_widget.js
})

_NON_ALNUM_RX = re.compile(r"[^a-z0-9]")


def normalize_pack_token(value: Any) -> str:
    """Réduit un identifiant de pack (cnr_id/aux_id/URL) à un jeton comparable.

    ``grokuku/ComfyUI-Holaf-Utilities`` , ``ComfyUI-Holaf-Utilities.git`` ,
    ``https://github.com/grokuku/ComfyUI-Holaf-Utilities`` et
    ``comfyui-holaf-utilities`` → tous ``holafutilities``. Le dernier segment de
    chemin est retenu, le préfixe ``comfyui[-_]`` et tout non-alphanumérique
    sont retirés (même convention que normalizeRepoName côté JS).
    """
    s = str(value if value is not None else "").strip().lower()
    if not s:
        return ""
    s = s.replace(".git", "")
    s = s.rstrip("/")
    s = s.split("/")[-1]
    if s.startswith("comfyui-"):
        s = s[len("comfyui-"):]
    elif s.startswith("comfyui_"):
        s = s[len("comfyui_"):]
    return _NON_ALNUM_RX.sub("", s)


def is_legacy_pack_reference(value: Any) -> bool:
    """True si l'identifiant référence l'ANCIEN pack (nom historique)."""
    token = normalize_pack_token(value)
    return bool(token) and token in LEGACY_PACK_TOKENS


def is_legacy_widget_reference(name: Any) -> bool:
    """True si le nom de widget de slot est un résidu du pack historique.

    Un widget ENCORE fourni par le pack courant (``holaf_media_loader`` …) n'est
    JAMAIS signalé : on ne retire pas une référence valide.
    """
    raw = str(name if name is not None else "").strip()
    if not raw or not raw.lower().startswith(LEGACY_WIDGET_PREFIX):
        return False
    return raw.lower() not in {w.lower() for w in CURRENT_EXTENSION_WIDGETS}


# ══════════════════════════════════════════════════════════════════════════
# Utilitaires de structure
# ══════════════════════════════════════════════════════════════════════════

def _id_key(value: Any) -> Optional[str]:
    """Clé de comparaison d'identifiant de node (int/str → str)."""
    if value is None:
        return None
    return str(value)


def _subgraph_defs(graph: Any) -> List[dict]:
    """Liste des définitions de subgraphs d'un graphe (jamais None)."""
    if not isinstance(graph, dict):
        return []
    defs = graph.get("definitions")
    if not isinstance(defs, dict):
        return []
    subs = defs.get("subgraphs")
    if not isinstance(subs, list):
        return []
    return [s for s in subs if isinstance(s, dict)]


def iter_graphs(workflow: Any) -> Iterator[Tuple[str, dict]]:
    """Itère (label, graphe) sur le graphe RACINE puis tous les subgraphs.

    Le label est un chemin lisible ET unique (index de définition inclus) :
    ``root``, ``root › Sub A [#0]``, ``root › Sub A [#0] › Nested [#0]``.
    L'unicité permet de relocaliser un node entre l'analyse et la réparation
    même si deux subgraphs portent le même nom.
    """
    if not isinstance(workflow, dict):
        return
    yield "root", workflow
    yield from _walk_subgraphs(workflow, "root")


def _walk_subgraphs(graph: dict, parent_label: str) -> Iterator[Tuple[str, dict]]:
    for index, sub in enumerate(_subgraph_defs(graph)):
        name = sub.get("name") or sub.get("id") or ("subgraph#%d" % index)
        label = "%s › %s [#%d]" % (parent_label, name, index)
        yield label, sub
        yield from _walk_subgraphs(sub, label)


def collect_subgraph_ids(workflow: Any) -> set:
    """Identifiants (UUID) de TOUTES les définitions de subgraphs (récursif)."""
    ids = set()
    for _label, graph in iter_graphs(workflow):
        for sub in _subgraph_defs(graph):
            sid = sub.get("id")
            if sid is not None:
                ids.add(_id_key(sid))
    return ids


def _norm_link(item: Any, fallback_id: Any = None) -> Optional[dict]:
    """Normalise un lien quel que soit le format vers un dict commun.

    Accepte : objet ``{id, origin_id, origin_slot, target_id, target_slot,
    type, parentId?}`` ; tableau ``[id, origin_id, origin_slot, target_id,
    target_slot, type]``. ``raw`` conserve l'élément d'origine (réécriture).
    """
    if isinstance(item, dict):
        lid = item.get("id", fallback_id)
        if lid is None:
            return None
        link = {
            "id": lid,
            "origin_id": item.get("origin_id"),
            "origin_slot": item.get("origin_slot"),
            "target_id": item.get("target_id"),
            "target_slot": item.get("target_slot"),
            "type": item.get("type"),
            "format": "object",
            "raw": item,
        }
        if "parentId" in item:
            link["parentId"] = item["parentId"]
        return link
    if isinstance(item, (list, tuple)) and len(item) >= 5:
        link = {
            "id": item[0],
            "origin_id": item[1],
            "origin_slot": item[2],
            "target_id": item[3],
            "target_slot": item[4],
            "type": item[5] if len(item) > 5 else None,
            "format": "array",
            "raw": item,
        }
        return link
    return None


def iter_links(graph: Any) -> Iterator[dict]:
    """Itère les liens normalisés d'un graphe (tableau OU objet)."""
    if not isinstance(graph, dict):
        return
    raw = graph.get("links")
    if isinstance(raw, list):
        for item in raw:
            link = _norm_link(item)
            if link is not None:
                yield link
    elif isinstance(raw, dict):
        # Ancien format « objet indexé par id » : {"1": [id, oid, oslot, tid, tslot, type]}.
        for key, item in raw.items():
            link = _norm_link(item, fallback_id=key)
            if link is not None:
                yield link


def index_graphs(workflow: Any) -> Dict[str, dict]:
    """{label de scope → graphe} (mêmes labels que ``iter_graphs``)."""
    return {label: graph for label, graph in iter_graphs(workflow)}


def _node_widget_names(node: dict) -> Optional[List[str]]:
    """Noms de widgets portés par le node sérialisé (rarement présents)."""
    raw = node.get("widget_names")
    if isinstance(raw, list):
        return [str(x) for x in raw]
    return None


# ══════════════════════════════════════════════════════════════════════════
# Définitions de classes → liste ORDONNÉE des noms de widgets
# ══════════════════════════════════════════════════════════════════════════

def _is_widget_input(spec: Any) -> bool:
    """Un entrée INPUT_TYPES est « widget » si elle n'est pas forcée en entrée.

    Convention ComfyUI : ``(type, options_dict)`` ; ``forceInput: True`` en fait
    un slot d'entrée (pas un widget). Les COMBO (liste de valeurs) sont des
    widgets. Voir ``comfy_execution`` / ``nodes.py`` du cœur ComfyUI.
    """
    if not isinstance(spec, (list, tuple)) or not spec:
        return False
    options = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
    if options.get("forceInput"):
        return False
    type_name = spec[0]
    if isinstance(type_name, (list, tuple)):
        return True  # COMBO
    if isinstance(type_name, str) and type_name:
        return True
    return False


def widget_names_from_input_types(input_types: Any) -> List[str]:
    """Liste ordonnée REQUIRED puis OPTIONAL des noms de widgets d'un node."""
    names: List[str] = []
    if not isinstance(input_types, dict):
        return names
    for group in ("required", "optional"):
        spec = input_types.get(group)
        if not isinstance(spec, dict):
            continue
        for name, cfg in spec.items():
            if _is_widget_input(cfg):
                names.append(str(name))
    return names


def build_class_defs_from_nodes(node_mappings: Any = None) -> Dict[str, dict]:
    """Construit ``{type: {"widgets": [noms]}}`` depuis NODE_CLASS_MAPPINGS.

    Pur : reçoit le mapping en argument (tests) ou, si None, tente d'importer
    ``nodes`` (module global ComfyUI). Retourne ``{}`` si indisponible — la
    détection des types inconnus est alors restreinte aux alias legacy connus
    (jamais de faux positif).
    """
    if node_mappings is None:
        try:  # pragma: no cover — ComfyUI global, non importable en test offline
            import nodes as _comfy_nodes  # type: ignore
            node_mappings = getattr(_comfy_nodes, "NODE_CLASS_MAPPINGS", None)
        except Exception:
            node_mappings = None
    if not isinstance(node_mappings, dict):
        return {}
    defs: Dict[str, dict] = {}
    for key, cls in node_mappings.items():
        try:
            input_types = cls.INPUT_TYPES()
        except Exception:
            input_types = None
        defs[str(key)] = {"widgets": widget_names_from_input_types(input_types)}
    return defs


# ══════════════════════════════════════════════════════════════════════════
# Remappage des widgets_values PAR NOM
# ══════════════════════════════════════════════════════════════════════════

def remap_widget_values(
    old_names: Optional[List[str]],
    values: Any,
    new_names: Optional[List[str]],
) -> Tuple[Any, List[dict], bool]:
    """Remappe des ``widgets_values`` POSITIONNELS par NOM de widget.

    Retourne ``(new_values, unmapped, remapped)`` :
      - ``new_values`` : liste réordonnée selon ``new_names`` ;
      - ``unmapped``   : valeurs qui n'ont pas pu être placées (nom inconnu du
        nouveau node, ou nom de l'ancien node inconnu) — signalées au rapport ;
      - ``remapped``   : True si un remappage par nom a réellement eu lieu.

    Si l'un des deux jeux de noms est inconnu, les valeurs sont conservées
    telles quelles (positionnel) et TOUTES sont signalées comme non
    remappables : mieux vaut une valeur possiblement décalée qu'une perte
    silencieuse, et l'utilisateur est prévenu.
    """
    if not isinstance(values, list):
        # widgets_values peut être un objet « array-like » custom (cf. commentaire
        # du frontend) : hors périmètre, on ne touche pas et on le signale.
        return values, [{"index": None, "name": None, "value": values}], False

    if not old_names or not new_names:
        unmapped = [
            {
                "index": i,
                "name": old_names[i] if old_names and i < len(old_names) else None,
                "value": v,
            }
            for i, v in enumerate(values)
        ]
        return list(values), unmapped, False

    new_index = {name: idx for idx, name in enumerate(new_names)}
    result: List[Any] = [None] * len(new_names)
    unmapped: List[dict] = []
    for i, val in enumerate(values):
        name = old_names[i] if i < len(old_names) else None
        if name is not None and name in new_index and result[new_index[name]] is None:
            result[new_index[name]] = val
        else:
            unmapped.append({"index": i, "name": name, "value": val})

    # Valeurs au-delà des noms connus (ex. widget compagnon). On les conserve en
    # queue plutôt que de les perdre, tout en les signalant.
    extra_start = len(old_names)
    for i in range(extra_start, len(values)):
        result.append(values[i])

    return result, unmapped, True


# ══════════════════════════════════════════════════════════════════════════
# Analyse — contextes, détecteurs, regroupement
# ══════════════════════════════════════════════════════════════════════════

class AnalyzeContext:
    """Contexte d'analyse passé à chaque détecteur (point d'extension)."""

    def __init__(self, workflow: Any, class_defs: Optional[Dict[str, dict]] = None,
                 alias_map: Optional[Dict[str, str]] = None):
        self.workflow = workflow
        self.graphs: List[Tuple[str, dict]] = list(iter_graphs(workflow))
        self.class_defs = class_defs or {}
        self.known_types = set(self.class_defs) if self.class_defs else None
        self.subgraph_ids = collect_subgraph_ids(workflow)
        self.alias_map = dict(LEGACY_ALIAS_REPLACEMENTS if alias_map is None else alias_map)


def detect_missing_node_types(ctx: AnalyzeContext) -> Iterator[dict]:
    """Occurrences de nodes dont le ``type`` n'existe plus.

    - type dans la table des 34 alias legacy → proposition de remplacement ;
    - type inconnu (hors classes enregistrées + ids de subgraph) → groupe
      « sans proposition » (aucune correspondance inventée) ;
    - si les définitions de classes sont indisponibles, seuls les alias legacy
      (certains) sont signalés — jamais de faux positif sur un type valide.
    """
    for scope, graph in ctx.graphs:
        nodes = graph.get("nodes")
        if not isinstance(nodes, list):
            continue
        for node in nodes:
            if not isinstance(node, dict):
                continue
            ntype = node.get("type")
            ntype_key = _id_key(ntype)
            if ntype_key is None or ntype_key in ctx.subgraph_ids:
                continue  # instance de subgraph : type = UUID d'une définition
            if ntype_key in CORE_NODE_TYPES:
                continue
            proposed: Optional[str] = None
            if ntype_key in ctx.alias_map:
                proposed = ctx.alias_map[ntype_key]
            elif ctx.known_types is not None and ntype_key not in ctx.known_types:
                proposed = None  # inconnu, sans proposition : on l'affiche quand même
            else:
                continue  # type valide
            action = (
                {"type": "replace_node_type", "from": ntype, "to": proposed}
                if proposed else None
            )
            yield {
                "kind": "missing_node_type",
                "key": (ntype_key, proposed),
                "old_type": ntype,
                "new_type": proposed,
                "checkable": proposed is not None,
                "action": action,
                "occurrence": {
                    "scope": scope,
                    "node_id": node.get("id"),
                    "title": node.get("title"),
                },
            }


def detect_legacy_references(ctx: AnalyzeContext) -> Iterator[dict]:
    """Occurrences de RÉSIDUS de l'ancien pack (pack obsolète / widget disparu).

    Deux familles, regroupées séparément par ``(kind, key)`` :
      - ``legacy_pack_reference``   : ``properties.cnr_id``/``aux_id`` désignant
        l'ancien pack → à RETIRER (sinon le Workflow Share le déclare requis) ;
      - ``legacy_widget_reference`` : slot ``{widget: {name: "holaf_…"}}`` vers
        un widget du pack historique supprimé → référence INERTE à RETIRER.

    Chaque occurrence porte l'emplacement exact (scope, node_id, slot/index ou
    property) pour la réparation ciblée. Le nettoyage n'affecte rien d'autre :
    aucune règle de validation ne s'applique à ces champs.
    """
    for scope, graph in ctx.graphs:
        nodes = graph.get("nodes")
        for node in (nodes if isinstance(nodes, list) else []):
            if not isinstance(node, dict):
                continue
            node_id = node.get("id")

            # (1) Propriétés de pack obsolète.
            props = node.get("properties")
            if isinstance(props, dict):
                for prop_key in ("cnr_id", "aux_id"):
                    value = props.get(prop_key)
                    if not is_legacy_pack_reference(value):
                        continue
                    yield {
                        "kind": "legacy_pack_reference",
                        "key": ("pack", prop_key, normalize_pack_token(value)),
                        "old_type": value,
                        "new_type": None,
                        "checkable": True,
                        "action": {
                            "type": "remove_legacy_reference",
                            "target": "property",
                            "property": prop_key,
                            "value": value,
                        },
                        "occurrence": {
                            "scope": scope,
                            "node_id": node_id,
                            "title": node.get("title"),
                            "property": prop_key,
                            "value": value,
                        },
                    }

            # (2) Références de slot vers un widget historique supprimé.
            for slot_key, slot_dir in (("inputs", "input"), ("outputs", "output")):
                slots = node.get(slot_key)
                if not isinstance(slots, list):
                    continue
                for index, slot in enumerate(slots):
                    if not isinstance(slot, dict):
                        continue
                    widget = slot.get("widget")
                    name = widget.get("name") if isinstance(widget, dict) else None
                    if not is_legacy_widget_reference(name):
                        continue
                    yield {
                        "kind": "legacy_widget_reference",
                        "key": ("widget", slot_dir, str(name)),
                        "old_type": name,
                        "new_type": None,
                        "checkable": True,
                        "action": {
                            "type": "remove_legacy_reference",
                            "target": "slot_widget",
                            "slot": slot_key,
                            "widget": name,
                        },
                        "occurrence": {
                            "scope": scope,
                            "node_id": node_id,
                            "title": node.get("title"),
                            "slot": slot_dir,
                            "index": index,
                            "widget": name,
                        },
                    }

        # (3) Widgets EXPOSÉS au niveau d'un subgraph : ``definitions.subgraphs[].
        # widgets`` = ``[{id: nodeId, name: "holaf_…"}]`` (cf. ExposedWidget,
        # comfyui-frontend-src/src/lib/litegraph/src/types/serialisation.ts:181).
        # Retirer l'entrée n'affecte AUCUN lien (simple mapping d'affichage).
        exposed = graph.get("widgets")
        if isinstance(exposed, list):
            for index, exp in enumerate(exposed):
                if not isinstance(exp, dict):
                    continue
                name = exp.get("name")
                if not is_legacy_widget_reference(name):
                    continue
                source_id = exp.get("id")
                yield {
                    "kind": "legacy_widget_reference",
                    "key": ("exposed_widget", str(name), _id_key(source_id)),
                    "old_type": name,
                    "new_type": None,
                    "checkable": True,
                    "action": {
                        "type": "remove_legacy_reference",
                        "target": "exposed_widget",
                        "widget": name,
                    },
                    "occurrence": {
                        "scope": scope,
                        "node_id": source_id,
                        "widget": name,
                        "index": index,
                        "source_id": source_id,
                    },
                }


# Registre des détecteurs : POINT D'EXTENSION. Ajouter une fonction pour couvrir
# un nouveau type de problème (liens pendants, valeurs de widgets inconnues,
# nodes dépréciées…). Le regroupement, la validation et le rapport sont génériques.
DETECTORS = (
    detect_missing_node_types,
    detect_legacy_references,
)


def make_problem_id(kind: str, key: Any) -> str:
    """Identifiant STABLE et lisible d'un problème groupé (analyze ↔ apply)."""
    if isinstance(key, (list, tuple)):
        tail = "|".join("" if k is None else str(k) for k in key)
    else:
        tail = "" if key is None else str(key)
    return "%s|%s" % (kind, tail)


def group_problem_occurrences(occurrences: Iterable[dict]) -> List[dict]:
    """GROUPE les occurrences par ``(kind, key)`` → une entrée par TYPE.

    C'est l'exigence explicite de l'utilisateur : une ligne par type de node
    (« HolafRemoteComparer → AIHRemoteComparer · 12 occurrences »), PAS 12
    lignes. Le détail des emplacements reste disponible dans ``occurrences``.
    """
    grouped: Dict[str, dict] = {}
    order: List[str] = []
    for occ in occurrences:
        pid = make_problem_id(occ["kind"], occ["key"])
        entry = grouped.get(pid)
        if entry is None:
            entry = {
                "id": pid,
                "kind": occ["kind"],
                "old_type": occ.get("old_type"),
                "new_type": occ.get("new_type"),
                "checkable": bool(occ.get("checkable", False)),
                "action": occ.get("action"),
                "occurrences": [],
            }
            grouped[pid] = entry
            order.append(pid)
        entry["occurrences"].append(occ["occurrence"])
    result = []
    for pid in order:
        entry = grouped[pid]
        entry["count"] = len(entry["occurrences"])
        result.append(entry)
    return result


def analyze_occurrences(workflow: Any, class_defs: Optional[Dict[str, dict]] = None,
                        alias_map: Optional[Dict[str, str]] = None) -> Tuple[AnalyzeContext, List[dict]]:
    """Occurrences BRUTES (non groupées) + contexte, pour un workflow."""
    ctx = AnalyzeContext(workflow, class_defs=class_defs, alias_map=alias_map)
    occurrences: List[dict] = []
    for detector in DETECTORS:
        occurrences.extend(detector(ctx))
    return ctx, occurrences


def _context_stats(ctx: AnalyzeContext, problems: List[dict]) -> dict:
    node_count = 0
    for _scope, graph in ctx.graphs:
        nodes = graph.get("nodes")
        if isinstance(nodes, list):
            node_count += sum(1 for n in nodes if isinstance(n, dict))
    missing_count = sum(p["count"] for p in problems if p["kind"] == "missing_node_type")
    legacy_count = sum(
        p["count"] for p in problems
        if p["kind"] in ("legacy_pack_reference", "legacy_widget_reference")
    )
    return {
        "node_count": node_count,
        "missing_count": missing_count,
        "legacy_reference_count": legacy_count,
        "known_types_available": bool(ctx.class_defs),
        "subgraph_count": len(ctx.subgraph_ids),
    }


def analyze(workflow: Any, class_defs: Optional[Dict[str, dict]] = None,
            alias_map: Optional[Dict[str, str]] = None) -> dict:
    """Analyse un workflow et retourne un rapport de problèmes GROUPÉS.

    Retour :
        {
          "problems": [ {id, kind, old_type, new_type, count, occurrences,
                         checkable, action}, … ],
          "stats": {"node_count": N, "missing_count": M,
                    "known_types_available": bool, "subgraph_count": S},
        }
    """
    ctx, occurrences = analyze_occurrences(workflow, class_defs=class_defs, alias_map=alias_map)
    problems = group_problem_occurrences(occurrences)
    return {"problems": problems, "stats": _context_stats(ctx, problems)}


def analyze_sources(sources: Iterable[dict], class_defs: Optional[Dict[str, dict]] = None,
                    alias_map: Optional[Dict[str, str]] = None) -> dict:
    """Analyse PLUSIEURS sources et regroupe les problèmes À TRAVERS elles.

    ``sources`` : itérable de ``{"id": str, "workflow": dict}``. Chaque
    occurrence porte ``source_id`` + ``source_name`` : l'UI peut ainsi afficher
    UNE ligne par type (total toutes sources confondues) tout en listant le
    détail repliable des emplacements.

    Retour : ``{"problems": [...], "sources": [...], "stats": {...}}``.
    """
    all_occ: List[dict] = []
    source_infos: List[dict] = []
    node_count = 0
    subgraph_ids = set()
    known_available = bool(class_defs)
    for src in sources:
        wid = src.get("id")
        wf = src.get("workflow")
        ctx, occurrences = analyze_occurrences(wf, class_defs=class_defs, alias_map=alias_map)
        for occ in occurrences:
            occurrence = dict(occ["occurrence"])
            occurrence["source_id"] = wid
            occurrence["source_name"] = src.get("name")
            all_occ.append({
                "kind": occ["kind"],
                "key": occ["key"],
                "old_type": occ.get("old_type"),
                "new_type": occ.get("new_type"),
                "checkable": occ.get("checkable", False),
                "action": occ.get("action"),
                "occurrence": occurrence,
            })
        stats = _context_stats(ctx, [])
        node_count += stats["node_count"]
        subgraph_ids |= ctx.subgraph_ids
        source_infos.append({
            "id": wid,
            "name": src.get("name"),
            "kind": src.get("kind"),
            "path": src.get("path"),
            "valid": src.get("valid", True),
            "validation_errors": src.get("validation_errors", []),
            "node_count": stats["node_count"],
            "subgraph_count": stats["subgraph_count"],
        })
    problems = group_problem_occurrences(all_occ)
    return {
        "problems": problems,
        "sources": source_infos,
        "stats": {
            "node_count": node_count,
            "missing_count": sum(p["count"] for p in problems if p["kind"] == "missing_node_type"),
            "known_types_available": known_available,
            "subgraph_count": len(subgraph_ids),
            "source_count": len(source_infos),
        },
    }


# ══════════════════════════════════════════════════════════════════════════
# Validation AVANT écriture
# ══════════════════════════════════════════════════════════════════════════

def _slot_count(node: dict, direction: str) -> Optional[int]:
    """Nombre de slots d'un node, ou None si l'info est absente du JSON."""
    slots = node.get(direction)
    if isinstance(slots, list):
        return len(slots)
    return None


def _validate_graph(scope: str, graph: dict) -> List[dict]:
    errors: List[dict] = []
    nodes = graph.get("nodes") if isinstance(graph, dict) else None
    if not isinstance(nodes, list):
        nodes = []

    node_map: Dict[str, dict] = {}
    for node in nodes:
        if isinstance(node, dict) and node.get("id") is not None:
            node_map[_id_key(node["id"])] = node

    boundary_ids = set()
    for key in ("inputNode", "outputNode"):
        b = graph.get(key)
        if isinstance(b, dict) and b.get("id") is not None:
            boundary_ids.add(_id_key(b["id"]))
    # Un subgraph sans inputNode/outputNode déclaré garde des slots virtuels
    # d'ids -10/-20 : ils sont valides.
    boundary_ids.discard(None)

    links = list(iter_links(graph))
    link_ids = set()
    for link in links:
        lid = _id_key(link["id"])
        link_ids.add(lid)
        oid = _id_key(link["origin_id"])
        tid = _id_key(link["target_id"])
        if oid not in node_map and oid not in boundary_ids and oid not in (_id_key(SUBGRAPH_INPUT_ID),):
            errors.append({
                "code": "link_origin_missing",
                "scope": scope,
                "link_id": link["id"],
                "node_id": link["origin_id"],
                "message": "lien %s : node d'origine %s introuvable" % (link["id"], link["origin_id"]),
            })
        elif oid in node_map:
            count = _slot_count(node_map[oid], "outputs")
            if count is not None and link["origin_slot"] is not None and int(link["origin_slot"]) >= count:
                errors.append({
                    "code": "link_origin_slot_missing",
                    "scope": scope,
                    "link_id": link["id"],
                    "node_id": link["origin_id"],
                    "slot": link["origin_slot"],
                    "message": "lien %s : slot de sortie %s hors limites pour node %s" % (
                        link["id"], link["origin_slot"], link["origin_id"]),
                })

        if tid not in node_map and tid not in boundary_ids and tid not in (_id_key(SUBGRAPH_OUTPUT_ID),):
            errors.append({
                "code": "link_target_missing",
                "scope": scope,
                "link_id": link["id"],
                "node_id": link["target_id"],
                "message": "lien %s : node de destination %s introuvable" % (link["id"], link["target_id"]),
            })
        elif tid in node_map:
            count = _slot_count(node_map[tid], "inputs")
            if count is not None and link["target_slot"] is not None and int(link["target_slot"]) >= count:
                errors.append({
                    "code": "link_target_slot_missing",
                    "scope": scope,
                    "link_id": link["id"],
                    "node_id": link["target_id"],
                    "slot": link["target_slot"],
                    "message": "lien %s : slot d'entrée %s hors limites pour node %s" % (
                        link["id"], link["target_slot"], link["target_id"]),
                })

    # Liens PENDANTS : un slot qui référence un lien inexistant.
    for node in nodes:
        if not isinstance(node, dict):
            continue
        for idx, inp in enumerate(node.get("inputs") or []):
            if not isinstance(inp, dict):
                continue
            ref = inp.get("link")
            if ref is not None and _id_key(ref) not in link_ids:
                errors.append({
                    "code": "input_link_missing",
                    "scope": scope,
                    "node_id": node.get("id"),
                    "slot": idx,
                    "link_id": ref,
                    "message": "node %s entrée %s référence le lien inexistant %s" % (
                        node.get("id"), idx, ref),
                })
        for idx, out in enumerate(node.get("outputs") or []):
            if not isinstance(out, dict):
                continue
            for ref in out.get("links") or []:
                if _id_key(ref) not in link_ids:
                    errors.append({
                        "code": "output_link_missing",
                        "scope": scope,
                        "node_id": node.get("id"),
                        "slot": idx,
                        "link_id": ref,
                        "message": "node %s sortie %s référence le lien inexistant %s" % (
                            node.get("id"), idx, ref),
                    })
    return errors


def validate_workflow(workflow: Any) -> List[dict]:
    """Vérifie la cohérence du JSON (racine ET subgraphs).

    Règle imposée : tout lien pointe sur un node + slot existants, aucun lien
    pendant. Retourne la liste des erreurs (vide = cohérent).
    """
    errors: List[dict] = []
    for scope, graph in iter_graphs(workflow):
        errors.extend(_validate_graph(scope, graph))
    return errors


def _error_signature(err: dict) -> tuple:
    return (
        err.get("code"), err.get("scope"), _id_key(err.get("node_id")),
        _id_key(err.get("link_id")), err.get("slot"),
    )


# ══════════════════════════════════════════════════════════════════════════
# Réparation
# ══════════════════════════════════════════════════════════════════════════

def _find_node(graph: dict, node_id: Any) -> Optional[dict]:
    if not isinstance(graph, dict):
        return None
    target = _id_key(node_id)
    for node in graph.get("nodes") or []:
        if isinstance(node, dict) and _id_key(node.get("id")) == target:
            return node
    return None


def _widget_names_for(node: dict, type_name: Any, class_defs: Dict[str, dict],
                      alias_map: Dict[str, str]) -> Optional[List[str]]:
    """Noms de widgets d'un type ; pour un alias legacy, = ceux du canonique.

    Un alias legacy partageait la MÊME classe que sa clé canonique : l'ordre
    des widgets est donc identique. Cela rend le remappage identité exact pour
    les 34 alias, sans définition d'ancienne classe (supprimée).
    """
    type_key = _id_key(type_name)
    if type_key in class_defs:
        return class_defs[type_key].get("widgets")
    proposed = alias_map.get(type_key)
    if proposed and proposed in class_defs:
        return class_defs[proposed].get("widgets")
    return None


def apply_type_replacement(node: dict, new_type: Any, old_type: Any,
                           class_defs: Optional[Dict[str, dict]] = None,
                           alias_map: Optional[Dict[str, str]] = None) -> dict:
    """Renomme le ``type`` d'un node et remappe ses ``widgets_values`` PAR NOM.

    Fonction unitaire utilisée par ``apply_repairs`` et directement testable.
    Retourne un compte-rendu ``{renamed, widget_values, remapped,
    unmapped, old_names, new_names}``.
    """
    class_defs = class_defs or {}
    alias_map = dict(LEGACY_ALIAS_REPLACEMENTS if alias_map is None else alias_map)
    node["type"] = new_type

    old_names = _node_widget_names(node) or _widget_names_for(node, old_type, class_defs, alias_map)
    new_names = _widget_names_for(node, new_type, class_defs, alias_map)
    unmapped_info: List[dict] = []
    remapped = False
    widget_count = 0
    values = node.get("widgets_values")
    if isinstance(values, list) and values:
        widget_count = len(values)
        new_values, unmapped_info, remapped = remap_widget_values(old_names, values, new_names)
        node["widgets_values"] = new_values
    return {
        "renamed": 1,
        "widget_values": widget_count,
        "remapped": bool(remapped),
        "unmapped": unmapped_info,
        "old_names": old_names,
        "new_names": new_names,
    }


def remove_legacy_property(node: dict, property_key: Any, expected_value: Any = None) -> int:
    """Retire une propriété de pack obsolète d'un node (``cnr_id``/``aux_id``).

    Garde-fou : si ``expected_value`` est fourni, la propriété n'est retirée que
    si sa valeur correspond EXACTEMENT — la réparation reste ciblée sur le résidu
    analysé (jamais une propriété qui aurait changé entre analyse et application).
    Retourne 1 si retirée, 0 sinon. Ne touche à AUCUN autre champ.
    """
    props = node.get("properties")
    if not isinstance(props, dict):
        return 0
    key = str(property_key)
    if key not in props:
        return 0
    if expected_value is not None and props.get(key) != expected_value:
        return 0
    del props[key]
    return 1


def remove_slot_widget_reference(node: dict, slot_key: Any, widget_name: Any,
                                 slot_index: Any = None) -> int:
    """Retire une référence de slot ``{widget: {name: …}}`` d'un node.

    Cible l'index EXACT quand il est connu (repli sur le nom si l'index a bougé),
    et ne retire QUE la clé ``widget`` du slot concerné (le slot, son nom, son
    type et son lien sont intacts). Retourne le nombre de références retirées.
    """
    slots = node.get(slot_key) if slot_key in ("inputs", "outputs") else None
    if not isinstance(slots, list):
        return 0
    target_name = str(widget_name if widget_name is not None else "")
    if isinstance(slot_index, int) and 0 <= slot_index < len(slots):
        candidates = [slots[slot_index]]
    else:
        candidates = list(slots)
    removed = 0
    for slot in candidates:
        if not isinstance(slot, dict):
            continue
        widget = slot.get("widget")
        if not isinstance(widget, dict):
            continue
        if str(widget.get("name")) != target_name:
            continue
        del slot["widget"]
        removed += 1
    return removed


def remove_exposed_widget_reference(graph: dict, widget_name: Any, source_id: Any = None) -> int:
    """Retire une entrée ``widgets[]`` d'un subgraph (widget exposé résiduel).

    Ne filtre que les entrées dont le ``name`` correspond (ET, si fourni, l'``id``
    du node source). Ne touche à AUCUN lien : c'est un simple mapping d'affichage.
    Retourne le nombre d'entrées retirées.
    """
    if not isinstance(graph, dict):
        return 0
    widgets = graph.get("widgets")
    if not isinstance(widgets, list):
        return 0
    target_name = str(widget_name if widget_name is not None else "")
    src_key = _id_key(source_id) if source_id is not None else None
    removed = 0
    kept: List[Any] = []
    for exp in widgets:
        match = isinstance(exp, dict) and str(exp.get("name")) == target_name
        if match and src_key is not None:
            match = _id_key(exp.get("id")) == src_key
        if match:
            removed += 1
        else:
            kept.append(exp)
    if removed:
        graph["widgets"] = kept
    return removed


def apply_repairs(
    workflow: Any,
    selected_ids: Iterable[str],
    class_defs: Optional[Dict[str, dict]] = None,
    alias_map: Optional[Dict[str, str]] = None,
) -> Tuple[Any, dict]:
    """Applique les réparations SÉLECTIONNÉES sur une COPIE du workflow.

    N'applique QUE les ``selected_ids``. Ne modifie jamais l'entrée. Retourne
    ``(repaired, report)`` où ``report`` détaille : problèmes appliqués,
    nodes renommés, widgets remappés/non remappables, erreurs de validation
    AVANT et APRÈS (seules les NOUVELLES erreurs bloquent l'écriture).
    """
    original = workflow
    report_analysis = analyze(original, class_defs=class_defs, alias_map=alias_map)
    selected = set(selected_ids or [])
    repaired = copy.deepcopy(original)

    problems_by_id = {p["id"]: p for p in report_analysis["problems"]}
    graphs = index_graphs(repaired)

    applied: List[dict] = []
    widget_report: List[dict] = []
    unmapped_report: List[dict] = []
    legacy_report: List[dict] = []
    unknown_selected: List[str] = []

    for pid in selected:
        problem = problems_by_id.get(pid)
        if problem is None:
            unknown_selected.append(pid)
            continue
        action = problem.get("action")
        if not action:
            # Problème sans action (type inconnu sans proposition) : rien à faire.
            continue
        action_type = action.get("type")

        if action_type == "remove_legacy_reference":
            # Nettoyage d'un RÉSIDU de l'ancien pack : propriété cnr_id/aux_id
            # ou référence de slot vers un widget historique supprimé.
            removed = 0
            target = action.get("target")
            for occ in problem["occurrences"]:
                graph = graphs.get(occ["scope"])
                if target == "exposed_widget":
                    # L'entrée visée est dans `graph["widgets"]`, pas dans un node :
                    # on opère directement sur le graphe (scope).
                    if graph is not None:
                        removed += remove_exposed_widget_reference(
                            graph, action.get("widget"), occ.get("source_id"))
                    continue
                node = _find_node(graph, occ["node_id"]) if graph is not None else None
                if node is None:
                    continue
                if target == "property":
                    removed += remove_legacy_property(
                        node, action.get("property"), action.get("value"))
                elif target == "slot_widget":
                    removed += remove_slot_widget_reference(
                        node, action.get("slot"), action.get("widget"), occ.get("index"))
            applied.append({
                "problem_id": pid,
                "kind": problem["kind"],
                "from": problem.get("old_type"),
                "to": None,
                "removed": removed,
            })
            legacy_report.append({
                "problem_id": pid,
                "kind": problem["kind"],
                "target": target,
                "reference": problem.get("old_type"),
                "removed": removed,
            })
            continue

        if action_type != "replace_node_type":
            continue

        old_type = action.get("from")
        new_type = action.get("to")
        renamed = 0
        widget_count = 0
        for occ in problem["occurrences"]:
            graph = graphs.get(occ["scope"])
            node = _find_node(graph, occ["node_id"]) if graph is not None else None
            if node is None:
                continue
            info = apply_type_replacement(
                node, new_type, old_type,
                class_defs=class_defs or {}, alias_map=alias_map,
            )
            renamed += info["renamed"]
            widget_count += info["widget_values"]
            for u in info["unmapped"]:
                unmapped_report.append({
                    "problem_id": pid,
                    "scope": occ["scope"],
                    "node_id": occ["node_id"],
                    "index": u.get("index"),
                    "name": u.get("name"),
                    "value": u.get("value"),
                })
            if info["widget_values"]:
                widget_report.append({
                    "scope": occ["scope"],
                    "node_id": occ["node_id"],
                    "from": old_type,
                    "to": new_type,
                    "remapped": info["remapped"],
                    "values": info["widget_values"],
                })
        applied.append({
            "problem_id": pid,
            "kind": problem["kind"],
            "from": old_type,
            "to": new_type,
            "nodes_renamed": renamed,
            "widget_values": widget_count,
        })

    before_errors = validate_workflow(original)
    after_errors = validate_workflow(repaired)
    before_sigs = {_error_signature(e) for e in before_errors}
    new_errors = [e for e in after_errors if _error_signature(e) not in before_sigs]

    report = {
        "applied": applied,
        "widgets": widget_report,
        "unmapped_widgets": unmapped_report,
        "legacy_references": legacy_report,
        "validation_before": before_errors,
        "validation_after": after_errors,
        "new_validation_errors": new_errors,
        "unknown_selected": unknown_selected,
    }
    return repaired, report


def repair_summary(report: dict) -> dict:
    """Résumé compact (compteurs) du rapport de réparation."""
    legacy_removed = sum(a.get("removed", 0) for a in report.get("applied", []))
    return {
        "nodes_renamed": sum(a.get("nodes_renamed", 0) for a in report.get("applied", [])),
        "widgets_remapped": sum(
            1 for w in report.get("widgets", []) if w.get("remapped")
        ),
        "widgets_unmapped": len(report.get("unmapped_widgets", [])),
        "legacy_references_removed": legacy_removed,
        "problems_applied": len(report.get("applied", [])),
        "new_validation_errors": len(report.get("new_validation_errors", [])),
        "pre_existing_validation_errors": len(report.get("validation_before", [])),
    }


def _slot_widget_name(node: dict, slot_key: str, index: int) -> Optional[str]:
    """Nom du widget référencé par un slot sérialisé (ou None)."""
    slots = node.get(slot_key)
    if not isinstance(slots, list) or index >= len(slots):
        return None
    slot = slots[index]
    if not isinstance(slot, dict):
        return None
    widget = slot.get("widget")
    if isinstance(widget, dict) and widget.get("name") is not None:
        return str(widget.get("name"))
    return None


def diff_workflows(before: Any, after: Any) -> List[dict]:
    """Diff minimal (lisible) entre workflow original et réparé.

    Une entrée par changement : ``type`` d'un node, ``widgets_values``, propriété
    retirée (``properties``) ou référence de slot à un widget retirée
    (``input_widget``/``output_widget``). Utile pour montrer EXACTEMENT ce qui a
    été nettoyé (résidus de l'ancien pack) comme pour un renommage d'alias.
    """
    index_before = {}
    for scope, graph in iter_graphs(before):
        for node in graph.get("nodes") or []:
            if isinstance(node, dict):
                index_before[(scope, _id_key(node.get("id")))] = node
    graphs_before = {scope: graph for scope, graph in iter_graphs(before)}

    changes: List[dict] = []
    for scope, graph in iter_graphs(after):
        for node in graph.get("nodes") or []:
            if not isinstance(node, dict):
                continue
            key = (scope, _id_key(node.get("id")))
            old = index_before.get(key)
            if old is None:
                continue
            if old.get("type") != node.get("type"):
                changes.append({
                    "scope": scope,
                    "node_id": node.get("id"),
                    "field": "type",
                    "before": old.get("type"),
                    "after": node.get("type"),
                })
            if old.get("widgets_values") != node.get("widgets_values"):
                changes.append({
                    "scope": scope,
                    "node_id": node.get("id"),
                    "field": "widgets_values",
                    "before": old.get("widgets_values"),
                    "after": node.get("widgets_values"),
                })
            # Propriétés retirées (cnr_id / aux_id d'un pack obsolète…).
            old_props = old.get("properties") if isinstance(old.get("properties"), dict) else {}
            new_props = node.get("properties") if isinstance(node.get("properties"), dict) else {}
            for prop_key in sorted(set(old_props) | set(new_props)):
                if old_props.get(prop_key) != new_props.get(prop_key):
                    changes.append({
                        "scope": scope,
                        "node_id": node.get("id"),
                        "field": "properties",
                        "property": prop_key,
                        "before": old_props.get(prop_key),
                        "after": new_props.get(prop_key),
                    })
            # Références de slot à un widget retirées.
            for slot_key in ("inputs", "outputs"):
                old_slots = old.get(slot_key) if isinstance(old.get(slot_key), list) else []
                new_slots = node.get(slot_key) if isinstance(node.get(slot_key), list) else []
                for index in range(max(len(old_slots), len(new_slots))):
                    old_name = _slot_widget_name(old, slot_key, index)
                    new_name = _slot_widget_name(node, slot_key, index)
                    if old_name != new_name:
                        changes.append({
                            "scope": scope,
                            "node_id": node.get("id"),
                            "field": "input_widget" if slot_key == "inputs" else "output_widget",
                            "slot": index,
                            "before": old_name,
                            "after": new_name,
                        })
        # Widgets exposés au niveau d'un subgraph (liste racine du graphe).
        old_graph = graphs_before.get(scope)
        old_widgets = old_graph.get("widgets") if isinstance(old_graph, dict) and isinstance(old_graph.get("widgets"), list) else []
        new_widgets = graph.get("widgets") if isinstance(graph.get("widgets"), list) else []
        old_names = [w.get("name") for w in old_widgets if isinstance(w, dict)]
        new_names = [w.get("name") for w in new_widgets if isinstance(w, dict)]
        if old_names != new_names:
            changes.append({
                "scope": scope,
                "node_id": None,
                "field": "exposed_widget",
                "before": old_names,
                "after": new_names,
            })
    return changes


def dumps(workflow: Any) -> str:
    """Sérialise un workflow (indenté, UTF-8 préservé)."""
    return json.dumps(workflow, indent=2, ensure_ascii=False)
