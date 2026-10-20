# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""
AIH Mask Anything (EXPÉRIMENTAL) — IMAGE + description → MASK.

Principe : on demande à un modèle MULTIMODAL les coordonnées de un ou plusieurs
rectangles englobant les éléments décrits dans le texte, puis on RASTÉRISE ces
rectangles en masque binaire à la résolution de l'image d'entrée.

Aucun modèle de segmentation n'est utilisé : la précision est celle des
« boîtes » renvoyées par le LLM (voir les limites honnêtes en fin de docstring).

Transport vision — RÉUTILISÉ, pas réinventé (même mécanisme que le Prompt
Enhancer, ``nodes/enhance_node.py``) :
  - encodage : ``aih.llm_helper.image_tensor_to_base64`` (1re image du lot,
    PNG base64, réduction <= 1 Mpx en conservant le ratio) ;
  - chemin LOCAL (``llm_config`` connecté) : ``llm_helper.call_llm(..., image_base64=...)``
    → ``POST {base_url}/chat/completions`` avec un contenu ``user`` multipart
    ``[{type:text}, {type:image_url}]`` (``llm_helper.build_image_content``) ;
  - chemin SERVEUR (dropdown « Preset IA », sans ``llm_config``) :
    ``llm_helper.call_backend_preset`` → ``POST {server}/api/keywords/llm-process``
    avec la même conversation pré-construite (clé ``messages``, relayée VERBATIM
    au provider par la route existante) — donc AUCUNE route backend ajoutée,
    même auth Bearer (fichier credentials) et même politique SSRF (base_url
    issue d'un preset validé par ``backend/security/llm_url.py``).

Réponse exigée du modèle — un seul objet JSON, coordonnées NORMALISÉES 0-1 :
    {"boxes":[{"x1":0.1,"y1":0.2,"x2":0.4,"y2":0.5,"label":"cat"}]}
Le parsing est TOLÉRANT (voir ``parse_boxes``) : JSON noyé dans du texte ou des
``` accepté, plusieurs formats (objet ``boxes``, liste de listes, ``box_2d``
[y1,x1,y2,x2] sur grille 0-1000, pixels), unités détectées, clamping, boîtes
inversées/dégénérées corrigées ou rejetées, doublons fusionnés.

Échec = PAS de crash : masque de zéros + message VISIBLE (``ui.status``, affiché
par le widget JS ``js/aih_mask_anything_widget.js``) + log console préfixé
``[AIH Mask Anything]`` qui distingue les causes (pas de réponse / non JSON /
JSON sans boîte / boîtes invalides).

RAFFINEMENT SAM3 (PHASE 1 — mode ``per_box``) — OPTIONNEL, entrée
``sam3_model`` = le MODEL sorti d'un ``CheckpointLoaderSimple`` chargé avec
``models/checkpoints/sam3.1_multiplex_fp16.safetensors`` (la node ne charge
AUCUN checkpoint, elle ne fait que consommer le MODEL branché) :
  1. le LLM donne des boîtes APPROXIMATIVES (souvent mal calées) ;
  2. chaque boîte est ÉLARGIE de ``expand_px`` pixels (clampée à l'image) —
     SAM3 ne propose un masque que DANS la fenêtre de la boîte, une petite
     marge évite de lui couper l'objet ;
  3. ``unet.forward_segment(img1008, box_inputs=[1,2,2])`` est appelé UNE fois
     PAR BOÎTE : l'association masque ↔ boîte est DÉTERMINISTE (les masques
     sortent dans l'ordre des boîtes). Le chemin TEXTE du détecteur est écarté :
     il trie par score et tronque à ``max_det`` (= 1 par défaut) ;
  4. le masque est BINARISÉ (``> 0`` : les sorties de SAM3 sont des LOGITS, pas
     des probabilités), remis à la taille de l'image, puis VALIDÉ (vide / trop
     petit / débordant → voir ``should_fallback``) ;
  5. si SAM3 ne trouve rien d'exploitable, on GARDE la boîte du LLM (repli) ;
  6. dédoublonnage des FORMES à l'IoU ≥ 0.85 (SAM3 n'a pas de NMS) ;
     ``mask_mode`` décide de la sortie : ``shape`` = union des formes, ``bbox``
     = rectangles (boîte SERRÉE calculée sur le masque, meilleure que celle du
     LLM). ``feather`` s'applique APRÈS, dans les deux modes.

RAFFINEMENT SAM3 (PHASE 2 — mode « région » + batching) — réglages AJOUTÉS :
  - ``sam_crop`` (défaut True) : au lieu d'envoyer l'IMAGE ENTIÈRE étirée à
    1008², on recadre une FENÊTRE autour de la boîte (``crop_window``), on
    l'étire à 1008², et on y exprime la boîte-prompt dans le repère du crop
    (``box_to_crop_1008``). Le masque obtenu est RECOLLÉ à la position de la
    fenêtre (``paste_mask``). La fenêtre fournit le CONTEXTE, la boîte fournit
    la CIBLE (envoyer la fenêtre comme prompt ferait détourer « le bouton +
    la chemise ») ;
  - gain : un objet de 60 px dans une image de 1920 px n'occupe que ~31 px
    d'échantillonnage en mode plein, contre ~600 px recadré — c'est la réponse
    au « il ne détecte pas tous les boutons » ;
  - ``crop_margin`` (% de la TAILLE DE LA BOÎTE), ``min_crop_px`` (plancher de
    la fenêtre, recentrée si le plancher s'applique, clampée à l'image) ;
  - ``sam_batch`` : N crops (tous 1008² → empilables en ``[N,3,1008,1008]``)
    et ``box_inputs [N,2,2]`` en UNE passe. Le batching n'est PAS exercé par la
    node native : si la passe lotée lève, on REJOUE en boucle (comme la phase 1),
    on le compte dans le statut, et on POURSUIT ;
  - ``sam_crop=False`` reproduit EXACTEMENT la phase 1 (fenêtre = image
    entière, donc slicing identité et ``box_to_1008``).

DÉCOUVERTE (PHASE 3 — « trouver les N boutons ») — réglages AJOUTÉS :
  - PROBLÈME : le crop gagne en résolution, mais si le LLM ne donne qu'UNE boîte
    de chemise, une boîte ⇒ UNE forme SAM3. On ne peut pas trouver 12 boutons
    avec 1 prompt de boîte. Le seul chemin qui rend N instances est le TEXTE ;
  - ``discover`` (défaut False) + ``sam3_clip`` (CLIP OPTIONNEL, celui du MÊME
    ``CheckpointLoaderSimple`` que ``sam3_model``) : pour chaque élément (ou la
    région ``union`` de ses boîtes), on recadre (même fenêtre qu'en phase 2), on
    étire à 1008², on encode le texte ``"<concept>:<discover_count>"`` et on
    lance le DÉTECTEUR sur ce crop → N masques, recollés (``paste_mask``) ;
  - le texte doit être ANGLAIS (l'encodeur SAM3 est un CLIP anglais, 49408
    tokens, aucun multilingue) : le champ OPTIONNEL ``concept`` est demandé au
    LLM (groupe nominal anglais court, ex. ``shirt button``) ; à défaut on
    retombe sur ``label``, puis sur le texte de l'utilisateur ;
  - ``"<concept>:N"`` : côté ComfyUI, ``:N`` est lu par le tokenizer SAM3
    (``comfy/text_encoders/sam3_clip.py:61-75``), qui tokenise alors le texte
    NETTOYÉ (``:N`` retiré) et transmet ``max_detections=N``. Piège vérifié :
    avec ``:1`` (ou sans ``:N``) le tokenizer retombe sur le texte BRUT, donc
    les caractères « :1 » deviennent des tokens parasites → ``discovery_prompt``
    ne produit JAMAIS ``:1`` (concept nu quand N ≤ 1) ;
  - SAM3 n'a AUCUN NMS dans le chemin image : les doublons sont fusionnés par
    notre ``dedupe_masks`` (IoU ≥ 0.85) ;
  - DÉCISION : la découverte S'AJOUTE (union) aux formes par boîte, elle ne les
    remplace PAS. Si la découverte ne trouve rien, le résultat de la phase 2 est
    intact ; si elle trouve autre chose, on garde les deux. Un remplacement
    ferait perdre la cible du LLM au moindre faux positif ;
  - DÉCISION : ``discover`` exige ``sam_refine=True`` (c'est la même passe de
    modèle, et la découverte se fusionne DANS le plan raffiné) ; sinon message
    ``ui`` et masque depuis les boîtes, comme avant ;
  - ``discover_scope`` : ``per_box`` = une passe par boîte (fenêtre serrée =
    meilleure résolution, N passes) ; ``union`` = une passe par CONCEPT sur la
    boîte englobante (1 passe, moins de résolution) ;
  - coût : le détecteur ne cache pas son trunk (comme ``forward_segment``) → une
    passe ViTDet par groupe, plafonnée par ``max_boxes``.

CHEMIN PUBLIC UTILISÉ pour le texte (aucune copie de logique interne) :
``clip.tokenize(text)`` puis ``clip.encode_from_tokens_scheduled(tokens)``
(``comfy/sd.py:328`` et ``:341`` — exactement ce que fait ``CLIPTextEncode``),
d'où l'on ne lit QUE ``cond[0][0]`` (embedding) et la clé STANDARD
``attention_mask`` ; puis l'appel PUBLIC du détecteur
``unet(img1008, text_embeddings=…, text_mask=…, threshold=…, orig_size=(h, w))``
(``comfy/ldm/sam3/detector.py:472`` via ``:520``) — le même appel que la node
native ``SAM3_Detect`` (``comfy_extras/nodes_sam3.py:198-200``). Les masques
SONT DEMANDÉS à la taille de la fenêtre (``orig_size``), mais on ne fait JAMAIS
confiance à la taille RENDUE : ``fit_mask_to_window`` les ramène TOUJOURS à la
fenêtre avant ``paste_mask`` (un détecteur qui rend sa résolution interne
1008×1008 collait sinon un masque minuscule dans le coin supérieur gauche), et
un masque impossible à remettre à l'échelle est COMPTÉ + dit dans le statut
``ui`` (jamais un masque faux en silence).

Garde de CAPACITÉ (jamais un test de version) : ``sam3_model.get_model_object
("diffusion_model")`` puis ``hasattr(unet, "forward_segment")``. MODEL absent,
non-ModelPatcher, ou ComfyUI sans SAM3 → raffinement DÉSACTIVÉ, masque depuis
les boîtes du LLM (comportement d'avant), message ``ui`` explicite, zéro crash.
Même principe pour la découverte : ``sam3_clip`` absent, sans ``tokenize``/
``encode_from_tokens_scheduled``, ou CLIP qui n'est pas celui de SAM3
(``clip_name != "sam3_clip"``) → découverte DÉSACTIVÉE avec message, reste
inchangé.

Contraintes DURES de SAM3 (vérifiées sur ComfyUI ≥ v0.20.1, PR #13408) :
  - l'entrée du trunk doit faire EXACTEMENT 1008×1008 (rope figée) → upscale
    ANISOTROPE ``common_upscale(..., 1008, 1008, "bilinear", crop="disabled")`` ;
  - les coordonnées de boîte sont en espace 1008×1008 : ``x / W * 1008`` ;
  - objet absent ⇒ SAM3 écrase les logits à ``NO_OBJ_SCORE = -1024`` ⇒ le
    masque binarisé ``> 0`` est VIDE : c'est le signal de repli, gratuit.

LIMITES HONNÊTES (à lire avant de juger) :
  - précision : sans SAM3 branché, une boîte englobante, pas un détourage.
    Attendez-vous à ±2-10 % de la taille pour un bon modèle vision sur des
    objets nets, et à des boîtes franchement fausses sur des petites cibles, des
    objets occultés ou des scènes encombrées ; avec SAM3, la forme est propre
    mais reste bornée par la boîte élargie (objet à moitié dans la boîte ⇒
    moitié du masque) ;
  - coût SAM3 : ``forward_segment`` ne met PAS le trunk ViTDet en cache → une
    passe de trunk PAR PASSE (une par boîte avec ``sam_batch=1``, une par lot
    sinon), plafonné par ``max_boxes`` (défaut 16) ; la découverte ajoute une
    passe de DÉTECTEUR (plus lourde : 200 requêtes) par groupe, même plafond ;
  - le crop n'ajoute AUCUNE passe (une passe par boîte dans les deux modes) :
    il ne fait que gagner en résolution. La seule optimisation de coût réelle
    est ``sam_batch``, qui n'est pas garanti par l'API native (repli en boucle
    automatique, compté dans le statut) ;
  - le crop ne peut voir que ce que la FENÊTRE contient : si le LLM rate
    complètement l'objet (boîte à côté), le recadrage ne le rattrape pas ;
  - découverte : elle ne peut trouver que ce que son CROP contient. Avec
    ``per_box``, la fenêtre est celle de la boîte du LLM : un bouton oublié par
    le LLM est HORS fenêtre, donc hors de portée. ``union`` élargit la zone mais
    dilue la résolution. Pour couvrir toute l'image il faut une boîte qui
    l'occupe (ou ``sam_crop=False``, qui fait la découverte sur l'image entière,
    au prix de la résolution) ;
  - découverte et concepts : le regroupement se fait par concept (insensible à
    la casse). Un LLM qui donne 12 boîtes de boutons avec le MÊME concept →
    ``union`` fait UNE passe ; 12 concepts différents → 12 passes ;
  - découverte : le compteur ``discover_count`` est une DEMANDE, pas une
    garantie. SAM3 rend au plus N instances (tri par score décroissant) ; il
    peut en rendre moins (jamais plus), et un score sous
    ``discover_threshold`` est écarté avant comptage ;
  - découverte : les masques découverts ne sont pas VALIDÉS par
    ``should_fallback`` (il n'y a pas de boîte de référence par instance) : un
    masque vide est écarté, le reste est gardé puis dédupliqué ;
  - résolution envoyée : l'image est réduite à <= 1 Mpx (≈1024×1024) avant
    l'envoi ; les boîtes restent exprimées en coordonnées relatives, donc le
    masque est rendu à la résolution PLEINE de l'entrée ;
  - coût/latence : un appel LLM par exécution (1 à 30 s selon le provider) ;
    la node est mise en cache par ComfyUI comme toute node (mêmes entrées →
    même exécution) — le widget ``seed`` (control_after_generate) sert à forcer
    une nouvelle tentative ;
  - modèle : il DOIT être multimodal. Un modèle texte seul renvoie une erreur
    du provider (affichée telle quelle) ou une réponse vide ;
  - si un preset serveur pointe sur Ollama, la taille de contexte n'est pas
    transmise par /api/keywords/llm-process (contrairement à /api/enhance) :
    préférez ``llm_config`` (local) dans ce cas.
"""

import json
import logging
import math
import re

# Socle AIH partagé (bootstrap sys.path fait par le __init__.py racine du pack).
from aih import credentials, llm_helper

# Logger dédié (préfixe repris dans chaque message pour un grep immédiat dans
# la console ComfyUI).
LOGGER = logging.getLogger(__name__)

try:
    import torch
except ImportError:  # venv de dev sans torch : les tests purs restent exécutables
    torch = None


# Préfixe UNIQUE de tous les logs de la node (facilite le grep dans la console).
LOG_PREFIX = "[AIH Mask Anything]"

# ── Prompt ──────────────────────────────────────────────────────────────────
# Consigne en anglais (convention du pack). On demande UNIQUEMENT du JSON, des
# coordonnées normalisées 0-1 (indépendantes de la résolution envoyée), une
# boîte par élément DISTINCT et un cadrage serré.
SYSTEM_PROMPT = (
    "You are a precise visual grounding assistant. You receive ONE image and a "
    "description of the elements to locate in it.\n"
    "Return ONLY a JSON object with this exact shape:\n"
    '{"boxes":[{"x1":0.0,"y1":0.0,"x2":0.0,"y2":0.0,"label":"short label",'
    '"concept":"short english noun"}]}\n'
    "Rules:\n"
    "- Coordinates are NORMALIZED to the range 0.0-1.0 (never pixels).\n"
    "- Origin (0,0) is the TOP-LEFT corner: x grows to the right, y grows down.\n"
    "- x1,y1 = top-left corner of the box; x2,y2 = bottom-right corner "
    "(x2 > x1 and y2 > y1).\n"
    "- One box per DISTINCT element described. Several boxes are allowed, even "
    "with the same label (e.g. three cats = three boxes).\n"
    "- Each box must TIGHTLY enclose its element: fully inside, nothing else.\n"
    "- \"label\" is a short free-form label in the user's language.\n"
    "- \"concept\" is OPTIONAL but recommended: the SAME element as a SHORT "
    "ENGLISH noun phrase naming the kind of object (e.g. \"shirt button\", "
    "\"car wheel\"), no article, no verb, no count. It is used by an "
    "English-only segmentation model.\n"
    '- If no element matches the description, return {"boxes":[]}.\n'
    "- Output ONLY the JSON object: no explanation, no markdown, no code fence."
)

# Phrase de contexte ajoutée au prompt user quand l'image est jointe (remplace
# la phrase « prompt enhancer » par défaut de llm_helper).
IMAGE_HINT = "[The image is attached. Ground the boxes on its actual content.]"

# ── Unités / géométrie ──────────────────────────────────────────────────────
# Au-delà de cette valeur, une coordonnée n'est plus « normalisée 0-1 ».
UNIT_TOLERANCE = 1.5
# Taille minimale d'une boîte, en fraction d'image (0,002 = 2 px sur 1000 px).
# En dessous : boîte dégénérée (bruit d'arrondi ou artefact du modèle).
MIN_BOX_SIZE = 0.002
# Échelle du format « box_2d » (grille 0-1000, type Gemini).
GRID_SCALE = 1000.0
# Deux boîtes dont l'IoU dépasse ce seuil sont considérées comme un doublon.
DUP_IOU = 0.95

# ── SAM3 (raffinement des boîtes) ───────────────────────────────────────────
# Résolution d'entrée IMPOSÉE du trunk ViTDet (rope figée) : ni plus, ni moins.
SAM3_SIZE = 1008
# Modes de sortie : forme du masque, ou rectangle (boîte serrée sur la forme).
MASK_MODE_SHAPE = "shape"
MASK_MODE_BBOX = "bbox"
MASK_MODES = (MASK_MODE_SHAPE, MASK_MODE_BBOX)
# Défauts des widgets SAM3 (reproduisent le comportement d'AVANT quand aucun
# MODEL n'est branché : sans SAM3, aucune marge n'est appliquée, cf. ``mask()``).
DEFAULT_EXPAND_PX = 8
MAX_EXPAND_PX = 256
DEFAULT_MIN_AREA_PCT = 3
DEFAULT_SAM_REFINE = True
DEFAULT_MAX_BOXES = 16
MAX_MAX_BOXES = 64
# ── Phase 2 : raffinement par CROP (mode « région ») + batching ──
# Par défaut on recadre autour de la boîte : un objet de 60 px dans une image
# de 1920 px n'occupe que ~31 px d'échantillonnage quand SAM3 voit l'image
# entière (étirée à 1008²), contre ~600 px si on recadre. C'est LE levier
# contre « SAM3 ne voit pas les petits objets ».
DEFAULT_SAM_CROP = True
DEFAULT_CROP_MARGIN = 30
MAX_CROP_MARGIN = 100
DEFAULT_SAM_BATCH = 1
MAX_SAM_BATCH = 16
# Plancher de la fenêtre de crop : agrandir un bouton de 10 px depuis 10 px de
# contexte ne donne rien de plus qu'un flou.
DEFAULT_MIN_CROP_PX = 128
MIN_MIN_CROP_PX = 32
MAX_MIN_CROP_PX = 1024
# ── Phase 3 : DÉCOUVERTE de N instances par le TEXTE ("bouton:8") ──
# Le crop de la phase 2 gagne en RÉSOLUTION, mais une boîte du LLM ⇒ une seule
# forme SAM3. Pour trouver les 12 boutons d'une chemise quand le LLM n'en donne
# qu'une boîte, il faut passer par le chemin TEXTE du détecteur : un prompt
# "<concept>:N" rend jusqu'à N instances (200 requêtes internes, triées par
# score, tronquées à N). Désactivé par défaut : coût d'une passe de détecteur.
DEFAULT_DISCOVER = False
DEFAULT_DISCOVER_COUNT = 8
MIN_DISCOVER_COUNT = 1
MAX_DISCOVER_COUNT = 32
DISCOVER_SCOPE_PER_BOX = "per_box"
DISCOVER_SCOPE_UNION = "union"
DISCOVER_SCOPES = (DISCOVER_SCOPE_PER_BOX, DISCOVER_SCOPE_UNION)
DEFAULT_DISCOVER_SCOPE = DISCOVER_SCOPE_PER_BOX
DEFAULT_DISCOVER_THRESHOLD = 0.4
MIN_DISCOVER_THRESHOLD = 0.0
MAX_DISCOVER_THRESHOLD = 1.0
# Nom du CLIP SAM3 côté ComfyUI (``SAM3ClipModelWrapper(name="sam3_clip")``,
# comfy/text_encoders/sam3_clip.py:74) : sert de garde de capacité, jamais de
# test de version.
SAM3_CLIP_NAME = "sam3_clip"
# Longueur maximale d'un concept : l'encodeur tronque à 32 tokens, inutile
# d'envoyer une phrase (et un groupe nominal court score mieux).
CONCEPT_MAX_LEN = 48
# Messages de la découverte (jamais un crash).
DISCOVER_NEEDS_MODEL_NOTE = "découverte désactivée : SAM3 non connecté"
DISCOVER_NEEDS_REFINE_NOTE = "découverte désactivée : sam_refine=False"
DISCOVER_NO_CONCEPT_NOTE = "découverte désactivée : aucun concept exploitable"
# Un masque qui couvre plus de N fois l'aire de sa boîte est DÉBORDANT : signe
# d'un masque qui a fui sur le fond. On le CLIPPE à la fenêtre de la boîte
# (au lieu de le jeter : il contient souvent le bon objet au milieu du bruit).
MASK_OVERFLOW_RATIO = 4.0
# Deux FORMES dont l'IoU dépasse ce seuil sont fusionnées (SAM3 n'a pas de NMS).
MASK_DUP_IOU = 0.85
# Verdicts de ``should_fallback`` (règles de validation d'un masque SAM3).
VERDICT_KEEP = "keep"       # masque plausible → on le garde
VERDICT_EMPTY = "empty"     # masque vide (objet absent) → repli sur la boîte
VERDICT_SMALL = "small"     # aire < min_area_pct % de la boîte → repli
VERDICT_CLIP = "clip"       # masque débordant → on le clippe à la boîte
# Message affiché quand le raffinement est indisponible (jamais un crash).
SAM3_UNAVAILABLE_NOTE = (
    "SAM3 non connecté ou MODEL non-SAM3 → masque depuis les boîtes"
)


class MaskGeometryError(RuntimeError):
    """Masque du détecteur impossible à ramener à la taille de la FENÊTRE.

    Erreur de GÉOMÉTRIE, jamais de modèle : elle sert de signal de repli
    explicite (compteur + message ``ui``) pour qu'un masque mal mis à l'échelle
    ne sorte jamais en silence.
    """

# Causes d'échec de parsing (distinctes pour l'utilisateur).
REASON_EMPTY = "empty"        # aucune réponse / réponse vide
REASON_NOT_JSON = "not_json"  # réponse présente mais aucun JSON exploitable
REASON_NO_BOXES = "noboxes"   # JSON valide, aucune boîte dedans
REASON_INVALID = "invalid"    # boîtes présentes mais toutes inutilisables

# Clés de dicts acceptées pour une boîte (ordre = priorité).
_BOX_KEYSETS = (
    ("x1", "y1", "x2", "y2"),
    ("xmin", "ymin", "xmax", "ymax"),
    ("left", "top", "right", "bottom"),
    ("x0", "y0", "x1", "y1"),
)
# Clés « conteneur » éventuelles d'une réponse riche.
_CONTAINER_KEYS = (
    "boxes", "box", "bbox", "bboxes", "objects", "detections", "predictions",
    "results", "result", "items", "data", "elements",
)
# Clés portant une séquence de 4 nombres (formats « 2d » : ordre y,x,y,x).
_2D_KEYS = ("box_2d", "box2d", "bbox_2d", "box_2d_normalized")
_LABEL_KEYS = ("label", "name", "text", "element", "description", "object")
# Clés portant le GROUPE NOMINAL ANGLAIS à envoyer à l'encodeur texte de SAM3
# (champ OPTIONNEL du schéma JSON : son absence ne doit jamais faire échouer le
# parsing, ni changer le comportement d'un LLM qui ne le renvoie pas).
_CONCEPT_KEYS = ("concept", "concept_en", "english_label", "noun", "category")


# === Parsing (PUR, sans torch) =============================================

def _to_float(value):
    """float depuis int/float/chaîne numérique, sinon None (jamais d'exception).

    Tolère la virgule décimale et les chaînes avec unité parasite (« 0.25 »,
    « 12,5 ». « +3 »). Les booléens sont refusés (True n'est pas une coordonnée).
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        text = value.strip().replace(",", ".")
        match = re.search(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", text)
        if not match:
            return None
        try:
            number = float(match.group(0))
        except ValueError:
            return None
    else:
        return None
    if math.isnan(number) or math.isinf(number):
        return None
    return number


def _coords_from_sequence(sequence):
    """4 nombres depuis une séquence plate, sinon None."""
    if not isinstance(sequence, (list, tuple)) or len(sequence) != 4:
        return None
    numbers = [_to_float(item) for item in sequence]
    if any(number is None for number in numbers):
        return None
    return numbers


def _label_from_dict(entry):
    """Libellé court d'une boîte (jamais None)."""
    for key in _LABEL_KEYS:
        value = entry.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:60]
    return ""


def _concept_from_dict(entry):
    """Groupe nominal ANGLAIS d'une boîte (champ OPTIONNEL), sinon "".

    Le schéma JSON demandé au LLM contient ``concept`` depuis la phase 3, mais
    un modèle peut l'ignorer, l'écrire autrement, ou être un ancien preset :
    on accepte plusieurs clés et on renvoie une chaîne VIDE quand il n'y a rien
    (jamais None, jamais d'exception) — ``parse_boxes`` reste donc rétro-
    compatible avec un LLM qui ne renvoie que ``label``.
    """
    if not isinstance(entry, dict):
        return ""
    for key in _CONCEPT_KEYS:
        value = entry.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:60]
    return ""


def _coords_from_dict(entry):
    """(coords, schéma) depuis un dict « boîte », sinon (None, None).

    Schémas : ``"xy"`` = ordre x1,y1,x2,y2 ; ``"2d"`` = ordre y1,x1,y2,x2
    (format ``box_2d`` à grille 0-1000).
    """
    if not isinstance(entry, dict):
        return None, None
    for keys in _BOX_KEYSETS:
        numbers = [_to_float(entry.get(key)) for key in keys]
        if all(number is not None for number in numbers):
            return numbers, "xy"
    for key in _2D_KEYS:
        numbers = _coords_from_sequence(entry.get(key))
        if numbers is not None:
            return numbers, "2d"
    for key in ("box", "bbox", "rect", "rectangle", "coordinates", "coords"):
        numbers = _coords_from_sequence(entry.get(key))
        if numbers is not None:
            return numbers, "xy"
    return None, None


def _iter_raw_boxes(payload, depth=0):
    """Énumère ``(coords, label, schéma, concept)`` depuis toutes les formes connues.

    Accepte (récursivement, profondeur bornée) :
      - ``{"boxes": [...]}`` / ``{"objects": ...}`` / ``{"result": ...}`` … ;
      - un dict « boîte » direct (``x1/y1/x2/y2``, ``xmin/…``, ``box_2d``) ;
      - une liste de listes ``[x1,y1,x2,y2]`` ou une liste de dicts ;
      - une boîte seule ``[x1,y1,x2,y2]`` à la racine.

    ``concept`` = groupe nominal anglais OPTIONNEL (phase 3), "" si absent.
    """
    found = []
    if payload is None or depth > 4:
        return found
    if isinstance(payload, dict):
        for key in _CONTAINER_KEYS:
            value = payload.get(key)
            if isinstance(value, (list, dict)):
                found.extend(_iter_raw_boxes(value, depth + 1))
        if found:
            return found
        coords, scheme = _coords_from_dict(payload)
        if coords is not None:
            found.append((coords, _label_from_dict(payload), scheme,
                          _concept_from_dict(payload)))
        return found
    if isinstance(payload, (list, tuple)):
        coords = _coords_from_sequence(payload)
        if coords is not None:
            found.append((coords, "", "xy", ""))
            return found
        for item in payload:
            found.extend(_iter_raw_boxes(item, depth + 1))
    return found


def _looks_like_json(text):
    """Vrai si le texte contient au moins une accolade/crochet (pré-filtre rapide)."""
    return "{" in text or "[" in text


def _iter_json_snippets(text):
    """Sous-chaînes équilibrées candidates (``{...}`` ou ``[...]``), dans l'ordre.

    Ne fait AUCUN ``json.loads`` : sert à extraire le JSON noyé dans du texte,
    y compris dans un bloc ``` (les fences sont simplement ignorées puisque
    seuls les délimiteurs comptent).
    """
    for opening, closing in (("{", "}"), ("[", "]")):
        start = text.find(opening)
        while start != -1:
            depth = 0
            in_string = False
            escaped = False
            for index in range(start, len(text)):
                char = text[index]
                if in_string:
                    if escaped:
                        escaped = False
                    elif char == "\\":
                        escaped = True
                    elif char == '"':
                        in_string = False
                    continue
                if char == '"':
                    in_string = True
                elif char == opening:
                    depth += 1
                elif char == closing:
                    depth -= 1
                    if depth == 0:
                        yield text[start:index + 1]
                        break
            start = text.find(opening, start + 1)


def _loads_tolerant(snippet):
    """``json.loads`` tolérant : répare les virgules traînantes, sinon None."""
    try:
        return json.loads(snippet)
    except (ValueError, TypeError):
        pass
    repaired = re.sub(r",\s*([}\]])", r"\1", snippet)
    try:
        return json.loads(repaired)
    except (ValueError, TypeError):
        return None


def extract_json(payload_text):
    """Objet JSON extrait d'une réponse LLM (noyée, fencée, sale), sinon None."""
    if not isinstance(payload_text, str) or not payload_text.strip():
        return None
    if not _looks_like_json(payload_text):
        return None
    for snippet in _iter_json_snippets(payload_text):
        parsed = _loads_tolerant(snippet)
        if parsed is not None:
            return parsed
    return None


def _detect_unit(values, width, height):
    """Unité probable d'un jeu de 4 coordonnées : ``"norm"``, ``"grid"`` ou ``"px"``.

    - toutes les valeurs <= 1,5 → normalisées 0-1 (le cas attendu) ;
    - une valeur dépasse la dimension de l'image → impossible en pixels, donc
      grille 0-1000 ;
    - sinon → pixels (une coordonnée en pixels ne dépasse jamais l'image).
    """
    biggest = max(abs(value) for value in values)
    if biggest <= UNIT_TOLERANCE:
        return "norm"
    if biggest > max(width, height):
        return "grid"
    return "px"


def normalize_box(coords, scheme, width, height):
    """Boîte normalisée ``{"x1","y1","x2","y2","label"}`` ou None si inutilisable.

    Étapes : remise en ordre du schéma ``2d`` (y,x,y,x), détection d'unité,
    mise à l'échelle, correction des coins inversés, clamping dans l'image,
    rejet des boîtes dégénérées (< ``MIN_BOX_SIZE``).
    """
    if not coords or len(coords) != 4 or width <= 0 or height <= 0:
        return None
    if scheme == "2d":
        y1, x1, y2, x2 = coords
    else:
        x1, y1, x2, y2 = coords
    numbers = (x1, y1, x2, y2)
    unit = _detect_unit(numbers, width, height)
    if unit == "norm":
        scale_x = scale_y = 1.0
    elif unit == "grid":
        scale_x = scale_y = 1.0 / GRID_SCALE
    else:
        scale_x = 1.0 / float(width)
        scale_y = 1.0 / float(height)

    nx1, nx2 = x1 * scale_x, x2 * scale_x
    ny1, ny2 = y1 * scale_y, y2 * scale_y
    # Coins inversés : le modèle a donné (bas-droite, haut-gauche) → on remet
    # dans l'ordre au lieu de jeter une boîte par ailleurs exploitable.
    if nx1 > nx2:
        nx1, nx2 = nx2, nx1
    if ny1 > ny2:
        ny1, ny2 = ny2, ny1
    # Clamping : une boîte qui déborde est ramenée DANS l'image.
    nx1 = min(max(nx1, 0.0), 1.0)
    nx2 = min(max(nx2, 0.0), 1.0)
    ny1 = min(max(ny1, 0.0), 1.0)
    ny2 = min(max(ny2, 0.0), 1.0)
    if (nx2 - nx1) < MIN_BOX_SIZE or (ny2 - ny1) < MIN_BOX_SIZE:
        return None
    return {"x1": nx1, "y1": ny1, "x2": nx2, "y2": ny2}


def box_iou(first, second):
    """Intersection over Union de deux boîtes normalisées (0 si disjointes)."""
    inter_w = min(first["x2"], second["x2"]) - max(first["x1"], second["x1"])
    inter_h = min(first["y2"], second["y2"]) - max(first["y1"], second["y1"])
    if inter_w <= 0 or inter_h <= 0:
        return 0.0
    inter = inter_w * inter_h
    area_first = (first["x2"] - first["x1"]) * (first["y2"] - first["y1"])
    area_second = (second["x2"] - second["x1"]) * (second["y2"] - second["y1"])
    union = area_first + area_second - inter
    return inter / union if union > 0 else 0.0


def dedupe_boxes(boxes):
    """Retire les boîtes quasi identiques (IoU >= ``DUP_IOU``), ordre préservé."""
    kept = []
    for box in boxes:
        if any(box_iou(box, kept_box) >= DUP_IOU for kept_box in kept):
            continue
        kept.append(box)
    return kept


def _has_non_empty_container(payload):
    """Vrai si le JSON contient un conteneur de boîtes NON VIDE.

    Sert à distinguer deux échecs que l'utilisateur ne doit pas confondre :
    « le modèle a répondu au bon format mais ses entrées sont inutilisables »
    (``REASON_INVALID``) et « le modèle n'a rien trouvé » (``REASON_NO_BOXES``).
    """
    if isinstance(payload, dict):
        return any(payload.get(key) for key in _CONTAINER_KEYS)
    if isinstance(payload, (list, tuple)):
        return len(payload) > 0
    return False


def parse_boxes(payload_text, width, height):
    """Réponse LLM → ``(boîtes_normalisées, raison)``.

    ``raison`` vaut None en cas de succès, sinon l'une des constantes
    ``REASON_*`` (cause distincte pour l'utilisateur). Ne lève JAMAIS.
    """
    if not isinstance(payload_text, str) or not payload_text.strip():
        return [], REASON_EMPTY
    payload = extract_json(payload_text)
    if payload is None:
        return [], REASON_NOT_JSON
    entries = _iter_raw_boxes(payload)
    if not entries:
        # Conteneur « boxes » non vide mais aucune entrée exploitable → au bon
        # format, contenu inutilisable : cause DISTINCTE de « rien trouvé ».
        return [], (REASON_INVALID if _has_non_empty_container(payload) else REASON_NO_BOXES)
    boxes = []
    for coords, label, scheme, concept in entries:
        box = normalize_box(coords, scheme, width, height)
        if box is None:
            continue
        box["label"] = label
        box["concept"] = concept
        boxes.append(box)
    if not boxes:
        return [], REASON_INVALID
    return dedupe_boxes(boxes), None


def build_user_prompt(text, width, height):
    """Message user : description de l'utilisateur + dimensions de l'image."""
    return (
        f"Image size: {int(width)}x{int(height)} pixels (width x height).\n"
        f"Elements to locate: {text}\n"
        "Return the JSON object now."
    )


# === Widgets : lecture DÉFENSIVE (aucun ancien workflow ne doit planter) ====
# ComfyUI remplit les widgets absents de ``widgets_values`` avec les défauts
# déclarés dans ``INPUT_TYPES``, mais un workflow édité à la main (ou un appel
# API partiel) peut fournir None, une chaîne ou une valeur hors bornes. Ces
# trois fonctions ramènent TOUJOURS une valeur exploitable — jamais d'exception.

def coerce_int(value, default, minimum, maximum):
    """Entier borné ``minimum..maximum`` ; valeur illisible → ``default``."""
    number = _to_float(value)
    if number is None:
        number = float(default)
    return int(min(max(round(number), minimum), maximum))


def coerce_float(value, default, minimum, maximum):
    """Flottant borné ``minimum..maximum`` ; valeur illisible → ``default``.

    Même contrat défensif que ``coerce_int`` : un workflow édité à la main peut
    envoyer ``None``, une chaîne (``"0.4"``) ou une valeur hors bornes.
    """
    number = _to_float(value)
    if number is None:
        number = float(default)
    return float(min(max(number, float(minimum)), float(maximum)))


def coerce_bool(value, default):
    """Booléen depuis un widget / une chaîne / un JSON ; illisible → ``default``."""
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, str):
        text = value.strip().lower()
        if text in ("1", "true", "yes", "on"):
            return True
        if text in ("0", "false", "no", "off", ""):
            return False
        return default
    try:
        return bool(value)
    except Exception:  # noqa: BLE001 — valeur exotique : on garde le défaut
        return default


def coerce_choice(value, allowed, default):
    """Valeur d'énumération (casse/espaces ignorés) ; inconnue → ``default``."""
    if isinstance(value, str):
        text = value.strip().lower()
        if text in allowed:
            return text
    return default


# === Logique PURE du raffinement SAM3 (testable sans torch) ================

def expand_box(box, expand_px, width, height):
    """Boîte ÉLARGIE de ``expand_px`` pixels de chaque côté, CLAMPÉE à l'image.

    - la marge est convertie SÉPARÉMENT en x et en y (sur une image non carrée,
      la même marge en pixels ne fait pas la même fraction) ;
    - après clampage, la boîte reste TOUJOURS dans ``[0,1]`` : aucune coordonnée
      hors image n'atteint SAM3, qui n'aime pas les boîtes négatives ;
    - ``expand_px <= 0`` (ou dimensions inconnues) → copie INCHANGÉE ;
    - le libellé est conservé (les labels survivent au raffinement).

    Aucune exception : une boîte mal formée est renvoyée telle quelle.
    """
    try:
        grown = {
            "x1": float(box["x1"]), "y1": float(box["y1"]),
            "x2": float(box["x2"]), "y2": float(box["y2"]),
        }
    except (KeyError, TypeError, ValueError):
        return box
    if box.get("label"):
        grown["label"] = box["label"]
    # Le CONCEPT (phase 3) doit survivre à l'élargissement : c'est lui qui part
    # dans l'encodeur texte de la découverte.
    if box.get("concept"):
        grown["concept"] = box["concept"]
    if expand_px <= 0 or width <= 0 or height <= 0:
        return grown
    margin_x = float(expand_px) / float(width)
    margin_y = float(expand_px) / float(height)
    grown["x1"] = min(max(grown["x1"] - margin_x, 0.0), 1.0)
    grown["y1"] = min(max(grown["y1"] - margin_y, 0.0), 1.0)
    grown["x2"] = min(max(grown["x2"] + margin_x, 0.0), 1.0)
    grown["y2"] = min(max(grown["y2"] + margin_y, 0.0), 1.0)
    return grown


def box_to_1008(box):
    """Coins de la boîte en espace SAM3 1008×1008 : ``(x1, y1, x2, y2)``.

    Les boîtes de la node sont NORMALISÉES (0-1) ; SAM3 attend des pixels dans
    SON repère 1008×1008 (indépendant de la taille de l'image d'entrée) :
    ``x_1008 = x_norm * 1008``. Aucun arrondi : le décodeur accepte des floats.
    """
    return (
        box["x1"] * SAM3_SIZE, box["y1"] * SAM3_SIZE,
        box["x2"] * SAM3_SIZE, box["y2"] * SAM3_SIZE,
    )


def box_window_px(box, width, height):
    """Fenêtre PIXELS entière ``(x0, y0, x1, y1)`` de la boîte, max EXCLUSIF.

    Même convention que les slices (``mask[y0:y1, x0:x1]``) : c'est la fenêtre
    utilisée pour l'aire de référence de la validation et pour le clip.
    Bornée à l'image, jamais inversée (``x0 <= x1``).
    """
    x0 = max(0, min(round(box["x1"] * width), width))
    y0 = max(0, min(round(box["y1"] * height), height))
    x1 = max(0, min(round(box["x2"] * width), width))
    y1 = max(0, min(round(box["y2"] * height), height))
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


def box_area_px(window):
    """Aire en pixels d'une fenêtre ``(x0, y0, x1, y1)`` (0 si dégénérée)."""
    x0, y0, x1, y1 = window
    return max(0, int(x1) - int(x0)) * max(0, int(y1) - int(y0))


def _fit_span(start, size, total):
    """Place une fenêtre de ``size`` dans ``[0, total]``, décalée si nécessaire.

    Renvoie ``(start, end)`` en flottants. Trois règles :
      - ``size`` est PLAFONNÉE à ``total`` (on ne peut pas recadrer plus grand
        que l'image) ;
      - fenêtre qui commencerait avant 0 → collée à 0 (on ne DÉPLACE pas, on
        rogne : le contexte manquant est simplement absent) ;
      - fenêtre qui dépasserait ``total`` → DÉCALÉE vers la gauche juste assez
        pour tenir entière (c'est ce qui garde ``min_crop_px`` utile près des
        bords : sans ce décalage, la fenêtre serait rognée à 40 px).
    """
    total = float(total)
    if total <= 0:
        return (0.0, 0.0)
    size = min(max(float(size), 1.0), total)
    start = max(start, 0.0)
    if start + size > total:
        start = total - size
    return (start, start + size)


def crop_window(box, width, height, margin_pct=DEFAULT_CROP_MARGIN,
                min_px=DEFAULT_MIN_CROP_PX):
    """FENÊTRE de crop ``(x0, y0, x1, y1)`` en pixels (max EXCLUSIF).

    La fenêtre fournit le CONTEXTE à SAM3, la boîte fournit la CIBLE :
      - marge = ``margin_pct`` % de la taille de la BOÎTE (et non de l'image),
        donc un petit objet reçoit peu de contexte en pixels mais beaucoup en
        proportion — c'est exactement ce qu'on veut ;
      - plancher ``min_px`` : une boîte de 10 px donnerait une fenêtre de 16 px,
        illisible même étirée à 1008² ; on impose ``min_px`` de côté ;
      - la fenêtre est ensuite CENTRÉE sur la boîte quand le plancher s'applique
        (sinon le plancher pousserait la boîte dans un coin) ;
      - décalage/clampage à l'image par ``_fit_span`` (jamais de fenêtre hors
        image, jamais de fenêtre plus grande que l'image) ;
      - résultat TOUJOURS ``x1 > x0`` et ``y1 > y0`` sur une image non vide.

    Boîte illisible ou image dégénérée → fenêtre de l'image ENTIÈRE (repli
    sûr : on retombe sur le comportement de la phase 1).
    """
    width, height = int(width), int(height)
    if width <= 0 or height <= 0:
        return (0, 0, 0, 0)
    try:
        bx1 = min(max(float(box["x1"]), 0.0), 1.0)
        by1 = min(max(float(box["y1"]), 0.0), 1.0)
        bx2 = min(max(float(box["x2"]), 0.0), 1.0)
        by2 = min(max(float(box["y2"]), 0.0), 1.0)
    except (KeyError, TypeError, ValueError):
        return (0, 0, width, height)

    margin = min(max(float(margin_pct), 0.0), float(MAX_CROP_MARGIN)) / 100.0
    floor_px = max(1.0, float(min_px))

    x0, x1 = bx1 * width, bx2 * width
    y0, y1 = by1 * height, by2 * height
    for axis, (low, high, total) in enumerate(
            ((x0, x1, width), (y0, y1, height))):
        span = max(high - low, 0.0)
        pad = span * margin
        start = low - pad
        size = span + 2.0 * pad
        if size < floor_px:
            # plancher : on REMPLIT autour de la boîte, en la gardant centrée
            size = floor_px
            start = (low + high) / 2.0 - size / 2.0
        start, end = _fit_span(start, size, total)
        start_i, end_i = round(start), round(end)
        start_i = max(0, min(start_i, total - 1))
        end_i = max(0, min(end_i, total))
        if end_i <= start_i:  # arrondi coinceur : on élargit d'un pixel
            end_i = min(start_i + 1, total)
            start_i = max(0, end_i - 1)
        if axis == 0:
            wx0, wx1 = start_i, end_i
        else:
            wy0, wy1 = start_i, end_i
    return (wx0, wy0, wx1, wy1)


def box_to_crop_1008(box, window, width, height):
    """Boîte NORMALISÉE → espace 1008×1008 du CROP : ``(x1, y1, x2, y2)``.

    C'est la seule formule qui compte du mode crop : la boîte-prompt doit être
    exprimée dans le repère du RECADRAGE, pas de l'image. En pixels :
    ``x_px = box.x * width`` puis ``x_1008 = (x_px - window.x0) / window_largeur
    * 1008`` (idem en y, avec la hauteur de la fenêtre).

    Piège : une fenêtre de 1 px (image minuscule) → division par 1, pas par 0.
    Le résultat est borné à ``[0, 1008]`` : la boîte est toujours DANS la
    fenêtre (``crop_window`` la contient), le clampage n'est qu'une ceinture.
    """
    x0, y0, x1, y1 = (float(value) for value in window)
    span_x = max(x1 - x0, 1.0)
    span_y = max(y1 - y0, 1.0)
    px1 = (float(box["x1"]) * float(width) - x0) / span_x * SAM3_SIZE
    py1 = (float(box["y1"]) * float(height) - y0) / span_y * SAM3_SIZE
    px2 = (float(box["x2"]) * float(width) - x0) / span_x * SAM3_SIZE
    py2 = (float(box["y2"]) * float(height) - y0) / span_y * SAM3_SIZE
    def bounded(value):
        return min(max(value, 0.0), float(SAM3_SIZE))

    return (bounded(px1), bounded(py1), bounded(px2), bounded(py2))


def paste_slices(window, mask_w, mask_h, width, height):
    """Découpe de RECOLLAGE d'un masque de fenêtre dans le masque plein format.

    Renvoie ``(dst_x0, dst_y0, dst_x1, dst_y1, src_x0, src_y0, src_x1, src_y1)``
    ou None si le recollage est vide (fenêtre hors image). ``dst_*`` = indices
    dans le masque plein format, ``src_*`` = indices dans le masque du crop
    (même échelle que la fenêtre). Les deux rectangles sont BORNÉS : une
    fenêtre qui déborderait (impossible via ``crop_window``, mais un appel API
    peut tout envoyer) est ROGNÉE des deux côtés en même temps, jamais décalée.
    """
    x0, y0, x1, y1 = (int(value) for value in window)
    width, height = int(width), int(height)
    mask_w, mask_h = int(mask_w), int(mask_h)
    if width <= 0 or height <= 0 or mask_w <= 0 or mask_h <= 0:
        return None
    dst_x0 = max(0, min(x0, width))
    dst_x1 = max(0, min(x1, width))
    dst_y0 = max(0, min(y0, height))
    dst_y1 = max(0, min(y1, height))
    if dst_x1 <= dst_x0 or dst_y1 <= dst_y0:
        return None
    span_x = max(x1 - x0, 1)
    span_y = max(y1 - y0, 1)

    def project(value, origin, span, limit):
        scaled = round((value - origin) * limit / float(span))
        return max(0, min(scaled, limit))

    src_x0 = project(dst_x0, x0, span_x, mask_w)
    src_x1 = project(dst_x1, x0, span_x, mask_w)
    src_y0 = project(dst_y0, y0, span_y, mask_h)
    src_y1 = project(dst_y1, y0, span_y, mask_h)
    if src_x1 <= src_x0 or src_y1 <= src_y0:
        return None
    return (dst_x0, dst_y0, dst_x1, dst_y1, src_x0, src_y0, src_x1, src_y1)


def chunk_boxes(items, size):
    """Groupe ``items`` par paquets de ``size`` (ordre préservé).

    ``size <= 1`` → un paquet par élément (comportement phase 1 : une passe par
    boîte). Un groupe peut être plus petit que ``size`` en fin de liste : c'est
    volontaire, on ne complète jamais avec un doublon (le masque en trop serait
    recollé au hasard).
    """
    packed = max(1, int(size))
    values = list(items)
    return [values[index:index + packed]
            for index in range(0, len(values), packed)]


def mask_area_ratio(mask_px, box_px):
    """Rapport d'aire masque / boîte (0.0 si la boîte est dégénérée).

    1.0 = le masque remplit exactement sa boîte ; < 0.03 = timbre-poste perdu
    dans la boîte ; > 4.0 = le masque a fui sur le fond.
    """
    if box_px is None or box_px <= 0:
        return 0.0
    return float(mask_px) / float(box_px)


def should_fallback(mask_px, box_px, min_area_pct, overflow_ratio=MASK_OVERFLOW_RATIO):
    """RÈGLES CHIFFRÉES de validation d'un masque SAM3 → verdict.

    - ``VERDICT_EMPTY`` : ``mask_px <= 0`` — SAM3 n'a rien trouvé (objet absent,
      logits écrasés à ``NO_OBJ_SCORE``) → repli sur la boîte du LLM ;
    - ``VERDICT_SMALL`` : ``mask_px / box_px < min_area_pct / 100`` (ou boîte
      dégénérée en pixels) — un timbre-poste dans une grande boîte n'est pas
      l'élément décrit (fond, reflet, bruit) → repli ;
    - ``VERDICT_CLIP`` : ``mask_px / box_px > overflow_ratio`` (défaut 4) — le
      masque a fui hors de la boîte → on le CLIPPE (il contient le bon objet) ;
    - ``VERDICT_KEEP`` : tout le reste.

    Bornes INCLUSES côté keep : exactement ``min_area_pct`` % → gardé, exactement
    ``overflow_ratio`` → gardé (on ne clippe que STRICTEMENT au-delà).
    """
    if mask_px is None or mask_px <= 0:
        return VERDICT_EMPTY
    if box_px is None or box_px <= 0:
        return VERDICT_SMALL
    ratio = mask_area_ratio(mask_px, box_px)
    if ratio < float(min_area_pct) / 100.0:
        return VERDICT_SMALL
    if ratio > float(overflow_ratio):
        return VERDICT_CLIP
    return VERDICT_KEEP


def tight_box_from_mask(bounds, width, height):
    """Boîte normalisée SERRÉE autour d'un masque, ou None si rien à cadrer.

    ``bounds`` = ``(x0, y0, x1, y1)`` en PIXELS, max EXCLUSIF (convention slice),
    tel que le fournit ``mask_bounds`` (extraction torch, hors de cette fonction
    pour rester testable sans torch).

    Rendue normalisée + clampée : c'est la boîte « propre » du mode ``bbox``,
    meilleure que celle du LLM puisqu'elle épouse la forme trouvée par SAM3.
    None = masque vide ou fenêtre dégénérée → l'appelant garde la boîte du LLM.
    """
    if not bounds or width <= 0 or height <= 0:
        return None
    x0, y0, x1, y1 = (int(value) for value in bounds)
    if x1 <= x0 or y1 <= y0:
        return None
    return {
        "x1": min(max(float(x0) / width, 0.0), 1.0),
        "y1": min(max(float(y0) / height, 0.0), 1.0),
        "x2": min(max(float(x1) / width, 0.0), 1.0),
        "y2": min(max(float(y1) / height, 0.0), 1.0),
    }


def clip_mask_to_window(mask, window, width, height):
    """Met à ZÉRO tout ce qui sort de la fenêtre de boîte ``(x0,y0,x1,y1)``.

    Utilisé quand le masque DÉBORDE (``VERDICT_CLIP``) : on garde la partie qui
    est dans la boîte élargie, on jette la fuite. ``mask`` accepte deux formes :
      - un tenseur torch (production : masque booléen ``[H,W]``, aplati par la
        fonction elle-même) ;
      - une séquence PLATE de 0/1 de longueur ``width * height`` (tests purs).
    Un tenseur est CLONÉ (jamais modifié sur place) ; le type d'entrée est
    conservé en sortie.
    """
    x0, y0, x1, y1 = (int(value) for value in window)
    width, height = int(width), int(height)
    clipped = mask.clone() if hasattr(mask, "clone") else list(mask)
    is_tensor = hasattr(clipped, "reshape")
    flat = clipped.reshape(-1) if is_tensor else clipped

    def zero(start, stop):
        if stop <= start:
            return
        flat[start:stop] = 0 if is_tensor else [0] * (stop - start)

    for row in range(height):
        start = row * width
        if row < y0 or row >= y1:
            zero(start, start + width)
            continue
        zero(start, start + min(max(x0, 0), width))
        zero(start + min(max(x1, 0), width), start + width)
    return clipped


def _mask_active(mask):
    """Nombre de pixels actifs : ``sum()`` d'un tenseur, ``len()`` d'un ensemble."""
    total = mask.sum() if hasattr(mask, "sum") else None
    if total is None:
        return len(mask)
    return int(total)


def dedupe_masks(masks, iou_threshold=MASK_DUP_IOU):
    """Fusionne (union) les masques dont l'IoU ≥ ``iou_threshold``.

    SAM3 n'a AUCUN NMS : deux boîtes voisines du LLM peuvent produire le MÊME
    objet, donc deux fois le même masque. On fusionne les doublons au lieu de
    les empiler (union = idempotente pour le rendu, et le mode ``bbox`` ne
    dessine pas deux rectangles superposés). Ordre préservé, premier gardé.

    ``masks`` : objets opérables par ``&`` / ``|`` et dénombrables — tenseurs
    torch (production, vectorisé) ou ENSEMBLES de pixels (tests purs, sans torch).
    """
    kept = []
    for mask in masks:
        active = _mask_active(mask)
        merged = False
        for index, kept_mask in enumerate(kept):
            intersection = _mask_active(mask & kept_mask)
            union = active + _mask_active(kept_mask) - intersection
            if union > 0 and intersection / union >= iou_threshold:
                kept[index] = kept_mask | mask
                merged = True
                break
        if not merged:
            kept.append(mask)
    return kept


def pair_boxes_masks(boxes, masks):
    """Apparie DÉTERMINISTEMENT boîtes et masques (même index), sinon None.

    L'association masque ↔ boîte de SAM3 est POSITIONNELLE : elle n'est valide
    que si les deux listes ont la même longueur. Un décalage poserait le masque
    de l'objet A sur la boîte de l'objet B — invisible et destructeur — donc on
    préfère renvoyer None (repli global) au moindre soupçon.

    ``masks`` peut contenir None (repli par boîte) : c'est une valeur légitime,
    seul l'ALIGNEMENT compte.
    """
    if masks is None or len(boxes) != len(masks):
        return None
    return list(zip(boxes, masks))


# === Découverte (phase 3) : logique PURE du TEXTE (sans torch) =============

def sanitize_concept(value):
    """Nettoie un concept pour qu'il soit UNE seule catégorie propre pour SAM3.

    Le texte part dans ``clip.tokenize`` → ``SAM3TokenizerWrapper`` (ComfyUI),
    dont le parsing (``comfy/text_encoders/sam3_clip.py:30-44``) a trois pièges
    VÉRIFIÉS, tous traités ici :
      - ``:`` ouvre une syntaxe ``:N`` : on COUPE au premier ``:`` (un LLM qui
        écrit « button: 4 » ne doit pas produire un ``:N`` implicite) ;
      - ``,`` SÉPARE les catégories : une virgule créerait deux prompts (et le
        second serait ignoré) → remplacée par une espace ;
      - parenthèses/crochets sont SUPPRIMÉS par le tokenizer (weighting
        désactivé) → remplacés par une espace pour ne pas coller deux mots.

    Résultat : espaces compactés, longueur bornée à ``CONCEPT_MAX_LEN``, "" si
    plus rien d'exploitable.
    """
    if not isinstance(value, str):
        return ""
    text = value.split(":", 1)[0]
    for char in (",", ";", "(", ")", "[", "]", "{", "}", '"', "|", "\n", "\r", "\t"):
        text = text.replace(char, " ")
    text = " ".join(text.split())
    return text[:CONCEPT_MAX_LEN].strip()


def discovery_prompt(concept, count):
    """Texte envoyé au tokenizer SAM3 pour demander ``count`` instances.

    ``"<concept>:<count>"`` — et JAMAIS ``:1`` (ni un ``:N`` sur un concept
    vide) : avec ``:1`` ou sans ``:N``, ``SAM3TokenizerWrapper``
    (``comfy/text_encoders/sam3_clip.py:61-75``) retombe sur le texte BRUT et
    les caractères « :1 » deviennent des tokens parasites. Pour ``count <= 1``
    on renvoie donc le concept NU — même effet, ``max_detections`` vaut 1 par
    défaut côté tokenizer.

    Concept vide après nettoyage → "" (l'appelant désactive la découverte).
    """
    text = sanitize_concept(concept)
    if not text:
        return ""
    number = coerce_int(count, 1, 1, MAX_DISCOVER_COUNT)
    if number <= 1:
        return text
    return f"{text}:{number}"


def discovery_concept(box, fallback_text=""):
    """Concept ANGLAIS à envoyer à SAM3 pour une boîte ("" si rien d'utilisable).

    Ordre de repli imposé (aucun n'est obligatoire) :
      1. ``concept`` — le champ demandé au LLM (nominal anglais court) ;
      2. ``label`` — le libellé, souvent déjà en anglais dans la pratique ;
      3. ``fallback_text`` — la description brute de l'utilisateur (dernier
         recours, potentiellement en français : l'encodeur SAM3 est ANGLAIS,
         donc le résultat sera moins bon, mais jamais un crash).
    """
    entry = box if isinstance(box, dict) else {}
    for candidate in (entry.get("concept"), entry.get("label"), fallback_text):
        cleaned = sanitize_concept(candidate)
        if cleaned:
            return cleaned
    return ""


def union_box(boxes):
    """Boîte NORMALISÉE englobant toutes les boîtes (None si aucune exploitable).

    Bornée à ``[0,1]`` comme les entrées ; une boîte illisible est IGNORÉE
    (jamais une exception, jamais une enveloppe faussée par un champ manquant).
    """
    x1 = y1 = float("inf")
    x2 = y2 = float("-inf")
    found = False
    for box in boxes or ():
        try:
            bx1, by1 = float(box["x1"]), float(box["y1"])
            bx2, by2 = float(box["x2"]), float(box["y2"])
        except (KeyError, TypeError, ValueError):
            continue
        x1, y1 = min(x1, bx1), min(y1, by1)
        x2, y2 = max(x2, bx2), max(y2, by2)
        found = True
    if not found or x2 <= x1 or y2 <= y1:
        return None
    return {
        "x1": min(max(x1, 0.0), 1.0), "y1": min(max(y1, 0.0), 1.0),
        "x2": min(max(x2, 0.0), 1.0), "y2": min(max(y2, 0.0), 1.0),
    }


def discovery_groups(boxes, scope, fallback_text=""):
    """Groupes à envoyer au détecteur : ``[{"concept", "box", "boxes"}]``.

    Le CONCEPT est la clé de regroupement (insensible à la casse/espaces) :
    deux boîtes de « bouton » ne font qu'un groupe en mode ``union``.

      - ``per_box`` : un groupe par boîte — fenêtre SERRÉE (meilleure
        résolution, le levier de la phase 2), au prix d'une passe par boîte ;
      - ``union`` : un groupe par concept, dont la boîte est l'ENVELOPPE de
        toutes les boîtes de ce concept — une seule passe, moins de résolution
        mais une zone plus large (utile quand le LLM rate des occurrences).

    Une boîte sans concept exploitable (ni ``concept``, ni ``label``, ni
    ``fallback_text``) est IGNORÉE : on ne peut pas la demander par le texte.
    Ordre d'apparition préservé (statut stable et testable).
    """
    mode = coerce_choice(scope, DISCOVER_SCOPES, DEFAULT_DISCOVER_SCOPE)
    groups = []
    index = {}
    for box in boxes or ():
        concept = discovery_concept(box, fallback_text)
        if not concept:
            continue
        key = concept.lower()
        if mode == DISCOVER_SCOPE_UNION and key in index:
            groups[index[key]]["boxes"].append(box)
            continue
        index.setdefault(key, len(groups))
        groups.append({"concept": concept, "box": box, "boxes": [box]})
    if mode == DISCOVER_SCOPE_UNION:
        for group in groups:
            envelope = union_box(group["boxes"])
            if envelope is not None:
                group["box"] = envelope
    return groups


# === Géométrie du masque / debug (torch) ===================================

def image_dimensions(image):
    """``(largeur, hauteur, batch)`` d'un IMAGE ComfyUI ``[B,H,W,C]``.

    Tolère ``[H,W,C]`` (batch implicite de 1). Lève ValueError sinon : une
    entrée mal formée n'est pas un échec du LLM, c'est une erreur de graphe.
    """
    shape = tuple(getattr(image, "shape", ()) or ())
    if len(shape) == 4:
        return shape[2], shape[1], shape[0]
    if len(shape) == 3:
        return shape[1], shape[0], 1
    raise ValueError(
        f"IMAGE attendue en [B,H,W,C] (reçu shape={shape})"
    )


def boxes_to_mask(boxes, width, height, feather=0):
    """Rastérise l'UNION des boîtes en masque ``[H,W]`` float 0..1.

    - boîte normalisée → pixels par ``round`` puis découpe ``[y1:y2, x1:x2]`` ;
    - toutes les boîtes sont cumulées (union) ;
    - ``feather`` > 0 : flou de moyenne (rayon en pixels) pour adoucir les bords,
      borné pour ne jamais déborder de l'image ni dégénérer (petites images) ;
    - ``feather`` == 0 : masque STRICTEMENT binaire (0/1).
    """
    if torch is None:
        raise RuntimeError("torch est requis pour produire un MASK")
    mask = torch.zeros((height, width), dtype=torch.float32)
    for box in boxes:
        x1 = round(box["x1"] * width)
        x2 = round(box["x2"] * width)
        y1 = round(box["y1"] * height)
        y2 = round(box["y2"] * height)
        x1 = max(0, min(x1, width))
        x2 = max(0, min(x2, width))
        y1 = max(0, min(y1, height))
        y2 = max(0, min(y2, height))
        if x2 <= x1 or y2 <= y1:
            continue
        mask[y1:y2, x1:x2] = 1.0
    if feather and feather > 0:
        mask = feather_mask(mask, feather)
    return mask


def feather_mask(mask, radius):
    """Adoucit un masque binaire par moyenne glissante (rayon en pixels).

    Le noyau est borné à la moitié de la plus petite dimension : aucun
    débordement possible, et un rayon absurde (128 sur une image de 64 px) ne
    fait pas échouer ``avg_pool2d``. En cas d'échec inattendu, on renvoie le
    masque binaire d'origine (jamais d'exception pour un réglage cosmétique).
    """
    if torch is None or radius <= 0:
        return mask
    height, width = mask.shape[0], mask.shape[1]
    if height < 3 or width < 3:
        return mask
    radius = int(min(radius, max(1, (min(height, width) - 1) // 2)))
    if radius <= 0:
        return mask
    kernel = 2 * radius + 1
    try:
        batched = mask.reshape(1, 1, height, width)
        blurred = torch.nn.functional.avg_pool2d(
            batched, kernel_size=kernel, stride=1, padding=radius, count_include_pad=True
        )
        return blurred.reshape(height, width).clamp(0.0, 1.0)
    except Exception as exc:  # noqa: BLE001 — réglage cosmétique : jamais bloquant
        LOGGER.warning(f"{LOG_PREFIX} feather échoué (rayon={radius}) : {exc}")
        return mask


def draw_boxes(image, boxes):
    """Copie de l'IMAGE avec les boîtes dessinées en ROUGE (sortie debug).

    Le tracé est fait au tensor (aucune dépendance Pillow) : bordure de
    ``thickness`` pixels sur les 4 côtés de chaque boîte (rouge 1.0/0.1/0.1).
    L'IMAGE d'entrée n'est jamais modifiée (clone).
    """
    if torch is None:
        raise RuntimeError("torch est requis pour produire une IMAGE")
    debug = image.clone()
    if debug.dim() == 3:
        debug = debug.unsqueeze(0)
    batch, height, width = debug.shape[0], debug.shape[1], debug.shape[2]
    thickness = max(1, min(height, width) // 200)
    red = torch.tensor([1.0, 0.1, 0.1, 1.0], dtype=debug.dtype, device=debug.device)
    red = red[:debug.shape[3]]
    for box in boxes:
        x1 = max(0, min(round(box["x1"] * width), width - 1))
        x2 = max(0, min(round(box["x2"] * width), width - 1))
        y1 = max(0, min(round(box["y1"] * height), height - 1))
        y2 = max(0, min(round(box["y2"] * height), height - 1))
        for start in range(batch):
            debug[start, y1:min(y1 + thickness, height), x1:x2 + 1] = red
            debug[start, max(y2 - thickness + 1, 0):y2 + 1, x1:x2 + 1] = red
            debug[start, y1:y2 + 1, x1:min(x1 + thickness, width)] = red
            debug[start, y1:y2 + 1, max(x2 - thickness + 1, 0):x2 + 1] = red
    return debug.clamp(0.0, 1.0)


def window_size(window):
    """Taille ``(hauteur, largeur)`` d'une fenêtre ``(x0, y0, x1, y1)``.

    Convention des slices (``mask[y0:y1, x0:x1]``) : max EXCLUSIF. Jamais 0 ni
    négatif (une fenêtre dégénérée vaut 1 px, comme ``paste_slices``).
    """
    x0, y0, x1, y1 = (int(value) for value in window)
    return (max(1, y1 - y0), max(1, x1 - x0))


def fit_mask_to_window(mask, window):
    """Masque du détecteur → masque BOOLÉEN ``[win_h, win_w]`` de la FENÊTRE.

    POURQUOI cette fonction existe : le détecteur SAM3 travaille en interne en
    1008×1008 et n'est censé rendre ses masques à la taille demandée
    (``orig_size``) que par un ``interpolate`` interne. Si ce rééchantillonnage
    manque (version de ComfyUI, chemin ``forward_from_trunk``, sortie native du
    détecteur), le masque recollé tel quel sort à l'échelle du DÉTECTEUR : le
    motif est correct mais MINUSCULE et collé dans le coin de l'image — c'est le
    bug « les fleurs détectées mais masque quasi noir, fragments dans le coin
    supérieur gauche ». On ne fait donc JAMAIS confiance à la taille rendue.

    Règles (aucune exception silencieuse) :
      - la cible est TOUJOURS ``window_size(window)``, jamais la taille du
        détecteur ;
      - masque DÉJÀ à la bonne taille → renvoyé tel quel : les pixels du
        détecteur ne sont pas réinventés par un rééchantillonnage inutile ;
      - LOGITS flottants → ``interpolate`` BILINÉAIRE (le mode du détecteur)
        puis binarisation ``> 0`` (SAM3 écrase les logits à ``NO_OBJ_SCORE``
        = -1024 quand l'objet est absent : ``> 0`` = dans l'objet) ;
      - masque booléen/entier → ``interpolate`` NEAREST (pas de valeur
        intermédiaire à inventer, donc aucun seuil arbitraire) ;
      - un SEUL plan admis : ``[H, W]``, ``[1, H, W]`` et ``[1, 1, H, W]``
        acceptés ; plusieurs plans (``Q > 1``) refusés — on ne devine pas
        lequel garder (c'est l'appelant qui apparie, positionnellement).

    Lève ``MaskGeometryError`` si le masque est inutilisable ou ambigu.
    """
    if torch is None:
        raise MaskGeometryError(
            "torch est requis pour mettre un masque à l'échelle")
    win_h, win_w = window_size(window)
    shape = tuple(getattr(mask, "shape", ()) or ())
    if len(shape) < 2:
        raise MaskGeometryError(f"masque inutilisable (shape={shape})")
    height, width = int(shape[-2]), int(shape[-1])
    if height <= 0 or width <= 0:
        raise MaskGeometryError(f"masque dégénéré (shape={shape})")
    # GARDE « UN SEUL PLAN » AVANT le raccourci « déjà à la bonne taille » :
    # un masque ``[Q>1, win_h, win_w]`` passerait sinon pour un plan unique, et
    # ``reshape(win_h, win_w)`` lèverait un ``RuntimeError`` brut — que les
    # appelants ne rattrapent PAS (ils n'attrapent que ``MaskGeometryError``) :
    # crash au lieu du repli promis.
    planes = mask.reshape(-1, height, width)
    count = int(planes.shape[0])
    if count != 1:
        raise MaskGeometryError(
            f"masque ambigu : {count} plans (shape={shape})")
    if (height, width) == (win_h, win_w):
        plane = mask.reshape(height, width)
    else:
        nearest = not bool(getattr(planes, "is_floating_point", lambda: False)())
        # ``F.interpolate`` n'accepte QUE du 4D ``[N,C,H,W]`` (un ``[C,H,W]``
        # serait lu comme une séquence temporelle 3D) : on ajoute donc l'axe
        # canal, puis on le retire. Le plan unique est déjà garanti ci-dessus.
        # ``align_corners`` n'est valide QUE pour les modes interpolants : le
        # passer à ``nearest`` lève (ValueError) sur torch récent.
        resized = torch.nn.functional.interpolate(
            planes.float().unsqueeze(1), size=(win_h, win_w),
            mode="nearest" if nearest else "bilinear",
            **({} if nearest else {"align_corners": False}),
        )
        plane = resized[0, 0]
    # Binarisation UNIQUE du module : booléen → identité, logits → ``> 0``.
    return plane > 0


def paste_mask(crop_mask, window, width, height):
    """Recolle un masque du CROP dans ``[H, W]`` booléen, à la bonne ÉCHELLE.

    Le masque est d'abord RAMENÉ À LA TAILLE DE LA FENÊTRE
    (``fit_mask_to_window``) : un détecteur qui rend 1008×1008 (sa résolution
    interne) ne peut plus être collé tel quel, ce qui produisait un masque
    minuscule dans le coin supérieur gauche de l'image. C'est le SEUL point de
    passage du recollage : tout appelant est protégé, présent ou futur.

    Une fenêtre débordante est rognée (voir ``paste_slices``) ; un recollage
    impossible (masque inutilisable, ou taille finale incohérente avec la
    fenêtre) rend un masque VIDE et un avertissement console — signe de repli,
    jamais d'exception et jamais un masque faux en silence.
    """
    if torch is None:
        raise RuntimeError("torch est requis pour recoller un masque")
    width, height = int(width), int(height)
    full = torch.zeros((height, width), dtype=torch.bool)
    # PAS de pré-garde « rang < 2 » ici : ``fit_mask_to_window`` refuse déjà ce
    # cas (``MaskGeometryError``) et l'``except`` ci-dessous est le SEUL chemin
    # de refus LOGGÉ. Court-circuiter avant lui rendait un masque vide en
    # SILENCE — exactement ce que ce module promet de ne jamais faire.
    win_h, win_w = window_size(window)
    try:
        fitted = fit_mask_to_window(crop_mask, window)
    except MaskGeometryError as exc:
        LOGGER.warning(f"{LOG_PREFIX} masque non recollable : {exc}")
        return full
    # POST-CONDITION : la taille du masque recollé doit égaler celle de la
    # fenêtre. Elle est garantie par le helper ; on la VÉRIFIE quand même, pour
    # qu'un futur changement de helper rende un repli visible au lieu d'un
    # masque mal calé.
    if tuple(fitted.shape) != (win_h, win_w):
        LOGGER.warning(
            f"{LOG_PREFIX} masque non recollable : {tuple(fitted.shape)} "
            f"≠ fenêtre {(win_h, win_w)} → masque vide (repli)"
        )
        return full
    spans = paste_slices(window, win_w, win_h, width, height)
    if spans is None:
        LOGGER.warning(
            f"{LOG_PREFIX} masque non recollable : fenêtre {window} hors de "
            f"l'image {width}×{height} → masque vide (repli)"
        )
        return full
    dst_x0, dst_y0, dst_x1, dst_y1, src_x0, src_y0, src_x1, src_y1 = spans
    # Même taille des DEUX côtés : sinon torch lèverait (ou diffuserait) et le
    # masque serait décalé sans le dire.
    if ((dst_y1 - dst_y0, dst_x1 - dst_x0)
            != (src_y1 - src_y0, src_x1 - src_x0)):
        LOGGER.warning(
            f"{LOG_PREFIX} masque non recollable : recollage incohérent "
            f"(fenêtre {(win_h, win_w)}, masque {tuple(fitted.shape)}) "
            "→ masque vide (repli)"
        )
        return full
    full[dst_y0:dst_y1, dst_x0:dst_x1] = fitted[src_y0:src_y1, src_x0:src_x1]
    return full


def mask_bounds(mask):
    """Bornes pixels ``(x0, y0, x1, y1)`` d'un masque booléen ``[H,W]``.

    Max EXCLUSIF (convention slice), prêt pour ``tight_box_from_mask``. Renvoie
    None si le masque est vide — ce qui est le signal « SAM3 n'a rien trouvé ».
    """
    if torch is None:
        raise RuntimeError("torch est requis pour lire un masque")
    rows = torch.any(mask, dim=1).nonzero().flatten()
    if int(rows.numel()) == 0:
        return None
    cols = torch.any(mask, dim=0).nonzero().flatten()
    return (int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1)


def draw_mask_outline(image, mask, color=(0.1, 0.9, 0.25)):
    """Copie de l'IMAGE avec le CONTOUR (1 px) d'un masque ``[H,W]``.

    Rend visible ce que SAM3 a réellement détouré, en vert, PAR-DESSUS les
    rectangles rouges : sans ça, un masque en mode ``shape`` serait invisible
    dans la preview. Coût : 4 comparaisons de tenseurs (aucune convolution).
    L'IMAGE d'entrée n'est jamais modifiée (clone).
    """
    if torch is None:
        raise RuntimeError("torch est requis pour produire une IMAGE")
    debug = image.clone()
    if debug.dim() == 3:
        debug = debug.unsqueeze(0)
    filled = mask > 0
    if not bool(filled.any()):
        return debug.clamp(0.0, 1.0)
    edge = torch.zeros_like(filled)
    edge[1:, :] |= filled[1:, :] != filled[:-1, :]
    edge[:-1, :] |= filled[:-1, :] != filled[1:, :]
    edge[:, 1:] |= filled[:, 1:] != filled[:, :-1]
    edge[:, :-1] |= filled[:, :-1] != filled[:, 1:]
    channels = min(len(color), debug.shape[3])
    for start in range(debug.shape[0]):
        for channel in range(channels):
            band = debug[start, :, :, channel]
            band[edge] = float(color[channel])
    return debug.clamp(0.0, 1.0)


# === SAM3 : capacité, device/dtype, image 1008 (torch) =====================

def _runtime_device_dtype(model):
    """``(device, dtype)`` du MODEL : ceux de ComfyUI, sinon CPU/float32.

    Le repli n'est pas une compatibilité descendante : il permet d'exécuter les
    tests de la logique tensorielle HORS de ComfyUI (venv de dev sans ``comfy``).
    En production, ``load_model_gpu`` garantit que le modèle est sur le device
    courant avant l'appel (sinon SAM3 recevrait un tenseur sur un autre device).
    """
    device = None
    dtype = None
    try:
        from comfy import model_management

        model_management.load_model_gpu(model)
        device = model_management.get_torch_device()
    except Exception:  # noqa: BLE001 — comfy absent (tests) ou MODEL non chargeable
        device = None
    try:
        dtype = model.model.get_dtype()
    except Exception:  # noqa: BLE001 — objet MODEL sans dtype : float32 suffit
        dtype = None
    return (device if device is not None else torch.device("cpu"),
            dtype if dtype is not None else torch.float32)


def resolve_sam3(model):
    """GARDE DE CAPACITÉ : ``(unet, device, dtype)``, sinon ``(None, raison)``.

    Aucun test de VERSION (pas de « ComfyUI ≥ 0.20.1 » codé en dur) : si le
    MODEL branché ne sait pas segmenter, on le dit et on continue avec les
    boîtes du LLM. Trois causes distinctes :
      - MODEL absent (entrée optionnelle non connectée) ;
      - entrée qui n'est pas un ModelPatcher (pas de ``get_model_object``) ;
      - modèle non-SAM3 (pas de ``forward_segment``).
    """
    if model is None:
        return None, "sam3_model non connecté"
    if torch is None:
        return None, "torch indisponible"
    getter = getattr(model, "get_model_object", None)
    if not callable(getter):
        return None, "l'entrée sam3_model n'est pas un MODEL ComfyUI (ModelPatcher)"
    try:
        unet = getter("diffusion_model")
    except Exception as exc:  # noqa: BLE001 — MODEL exotique : on continue sans SAM3
        return None, f"MODEL illisible ({exc})"
    if unet is None or not hasattr(unet, "forward_segment"):
        return None, "MODEL non-SAM3 (pas de forward_segment)"
    device, dtype = _runtime_device_dtype(model)
    return (unet, device, dtype), None


def prepare_sam3_image(frame, device, dtype):
    """``[1,H,W,C]`` → ``[1,3,1008,1008]`` ANISOTROPE, sur le device du modèle.

    Le trunk ViTDet a une rope FIGÉE sur 1008×1008 : tout autre format est au
    mieux non testé, au pire un plantage. On étire donc l'image (crop
    ``disabled`` : surtout aucun rognage, sinon les boîtes ne correspondent
    plus). ``comfy.utils.common_upscale`` est utilisé quand il est disponible
    (même chemin que ``SAM3_Detect``) ; hors ComfyUI (tests), le repli
    ``interpolate`` bilinéaire est EXACTEMENT ce que fait ``common_upscale``
    pour ``crop != "center"``.
    """
    if torch is None:
        raise RuntimeError("torch est requis pour préparer l'image SAM3")
    frames = frame[..., :3].movedim(-1, 1)
    try:
        from comfy.utils import common_upscale
    except ImportError:  # hors ComfyUI (tests unitaires) : repli ÉQUIVALENT
        common_upscale = None
    if common_upscale is not None:
        upscaled = common_upscale(frames, SAM3_SIZE, SAM3_SIZE, "bilinear", crop="disabled")
    else:
        upscaled = torch.nn.functional.interpolate(
            frames, size=(SAM3_SIZE, SAM3_SIZE), mode="bilinear"
        )
    return upscaled.to(device=device, dtype=dtype)


def prepare_sam3_crop(frame, window, device, dtype):
    """``[1,H,W,C]`` + fenêtre → ``[1,3,1008,1008]`` ANISOTROPE du RECADRAGE.

    Même chemin que ``prepare_sam3_image`` (c'est elle qui est appelée) : on se
    contente de découper la fenêtre AVANT l'upscale. Conséquence importante :
    avec la fenêtre de l'image entière, le résultat est EXACTEMENT celui de la
    phase 1 (slicing identité + même upscale) — c'est ce qui garantit
    ``sam_crop=False`` ≡ phase 1.
    """
    x0, y0, x1, y1 = (int(value) for value in window)
    # ``frame`` est [B,H,W,C] : on coupe H puis W (jamais les canaux).
    return prepare_sam3_image(frame[:, y0:y1, x0:x1, :], device, dtype)


def can_detect_text(unet):
    """Le modèle sait-il lancé une DÉTECTION TEXTE (chemin ``detector``) ?

    ``forward_segment`` (phase 1/2) et la détection texte sont deux chemins
    DISTINCTS de ``SAM3Model`` : ``forward_segment`` est une méthode dédiée,
    la détection texte passe par ``__call__`` → ``detector``. Un MODEL qui
    n'est pas appelable ne peut donc pas faire de découverte, même s'il sait
    segmenter par boîte → on le dit au lieu de planter.
    """
    return callable(unet)


def resolve_sam3_clip(clip):
    """GARDE DE CAPACITÉ du CLIP de découverte → ``(clip, None)`` sinon ``(None, raison)``.

    Aucun test de version. Trois refus distincts, tous NON bloquants :
      - entrée absente (socket non connectée) ;
      - objet sans ``tokenize`` / ``encode_from_tokens_scheduled`` (pas un CLIP
        ComfyUI) ;
      - CLIP d'un AUTRE modèle : l'encodeur texte de SAM3 est EMBARQUÉ dans le
        checkpoint SAM3 (``clip_name == "sam3_clip"``, cf.
        ``comfy/text_encoders/sam3_clip.py:74``) ; un ``clip_l`` séparé rendrait
        des embeddings que le resizer de SAM3 ne sait pas interpréter (résultat
        silencieusement faux, donc pire qu'un refus). Un objet sans
        ``clip_name`` lisible est ACCEPTÉ (on ne peut pas juger, et refuser
        casserait des implémentations exotiques).
    """
    if clip is None:
        return None, 'sam3_clip non connecté'
    if torch is None:
        return None, "torch indisponible"
    for method in ("tokenize", "encode_from_tokens_scheduled"):
        if not callable(getattr(clip, method, None)):
            return None, f"CLIP sans {method}() (CLIP ComfyUI attendu)"
    name = getattr(getattr(clip, "tokenizer", None), "clip_name", None)
    if not isinstance(name, str) or not name:
        name = getattr(getattr(clip, "cond_stage_model", None), "clip_name", None)
    if isinstance(name, str) and name and name != SAM3_CLIP_NAME:
        return None, f"CLIP '{name}' : encodeur texte SAM3 attendu (même checkpoint)"
    return clip, None


def encode_sam3_text(clip, prompt):
    """Encode un prompt SAM3 via l'API PUBLIQUE de ComfyUI → ``(embeddings, mask)``.

    Chemin EXACT de ``CLIPTextEncode`` (aucune logique interne recopiée) :
      - ``clip.tokenize(text)`` (``comfy/sd.py:328``) → ``SAM3TokenizerWrapper``,
        qui lit ``:N`` et tokenise le texte NETTOYÉ ;
      - ``clip.encode_from_tokens_scheduled(tokens)`` (``comfy/sd.py:341``) →
        liste ``[[tenseur, métadonnées]]``.
    On ne lit QUE l'embedding (``cond[0][0]``, forme ``[B, 32, 1024]``) et la clé
    STANDARD ``attention_mask`` — jamais la clé interne ``sam3_multi_cond`` :
    c'est ce qui garde la node indépendante des détails d'implémentation.

    Lève si la CLIP ne produit pas une conditioning exploitable : l'appelant
    transforme l'échec en message ``ui``, jamais en crash.
    """
    tokens = clip.tokenize(prompt)
    conditioning = clip.encode_from_tokens_scheduled(tokens)
    if not conditioning:
        raise RuntimeError("conditioning vide")
    entry = conditioning[0]
    if not isinstance(entry, (list, tuple)) or not entry:
        raise RuntimeError(
            "conditioning SAM3 inattendu (attendu [[embedding, métadonnées]])")
    embeddings = entry[0]
    meta = entry[1] if len(entry) > 1 else {}
    attention_mask = meta.get("attention_mask") if isinstance(meta, dict) else None
    shape = tuple(getattr(embeddings, "shape", ()) or ())
    if len(shape) != 3:
        raise RuntimeError(f"embedding SAM3 inattendu (shape={shape})")
    return embeddings, attention_mask


def detect_sam3_text(unet, image1008, embeddings, attention_mask,
                     threshold, max_detections, size):
    """UNE passe du DÉTECTEUR SAM3 par le TEXTE sur une image 1008² → masques.

    C'est l'appel PUBLIC de la node native (``comfy_extras/nodes_sam3.py:198-200``) :
    ``sam3_model(frame, text_embeddings=…, text_mask=…, threshold=…, orig_size=…)``
    → dict ``{"boxes", "scores", "masks"}``. ``masks`` sont des LOGITS
    ``[1, Q, h, w]`` qui DEVRAIENT déjà être rééchantillonnés à ``orig_size``
    (``detector.py:483-486``) ; on ne le SUPPOSE pas : la taille rendue est
    ramenée à la fenêtre juste après l'appel (``fit_mask_to_window``), car un
    détecteur qui rend sa résolution interne (1008×1008) produisait un masque
    minuscule collé dans le coin de l'image.

    Le SEUILLAGE et la TRONCATURE sont refaits ici, comme le fait la node native
    hors du détecteur (``nodes_sam3.py:216-224``) : le paramètre ``threshold`` du
    détecteur n'est pas utilisé en interne (``detector.py:472``). Règle :
    ``sigmoid(score) > threshold``, tri par score DÉCROISSANT, ``max_detections``
    gardés. Aucun NMS : la déduplication est à la charge de l'appelant.

    ``size`` = ``(hauteur, largeur)`` de la fenêtre (repère de ``orig_size``).
    Renvoie une liste de masques BOOLÉENS ``[h, w]`` (``> 0`` = objet : SAM3
    écrase les logits à -1024 quand l'objet est absent, donc « rien trouvé » se
    voit gratuitement) — à la taille RENDUE par le détecteur, que l'appelant
    doit ramener à celle de la fenêtre (``fit_mask_to_window``). Lève si la
    sortie du détecteur est inexploitable.
    """
    if torch is None:
        raise RuntimeError("torch est requis pour la découverte SAM3")
    height, width = int(size[0]), int(size[1])
    outputs = unet(
        image1008, text_embeddings=embeddings, text_mask=attention_mask,
        threshold=float(threshold), orig_size=(height, width),
    )
    if not isinstance(outputs, dict):
        raise TypeError(f"détecteur SAM3 : sortie inattendue ({type(outputs).__name__})")
    scores = outputs.get("scores")
    masks = outputs.get("masks")
    if scores is None or masks is None:
        raise RuntimeError("détecteur SAM3 : scores/masques absents de la sortie")
    scores = scores[0].flatten().to(dtype=torch.float32)
    masks = masks[0]
    shape = tuple(getattr(masks, "shape", ()) or ())
    if len(shape) != 3 or shape[0] != int(scores.numel()):
        raise RuntimeError(
            f"détecteur SAM3 : masques {shape} incohérents avec "
            f"{int(scores.numel())} score(s)"
        )
    probs = scores.sigmoid()
    keep = probs > float(threshold)
    selected = masks[keep]
    kept_probs = probs[keep]
    limit = max(1, int(max_detections))
    if int(kept_probs.numel()) > limit:
        selected = selected[kept_probs.argsort(descending=True)[:limit]]
    # LOGITS, pas des probabilités : ``> 0`` = dans l'objet (même règle que la
    # phase 1, cf. NO_OBJ_SCORE = -1024).
    return [selected[index] > 0 for index in range(int(selected.shape[0]))]


# === Node ==================================================================

class AIHMaskAnythingNode:
    """IMAGE + texte → MASK (boîtes d'un modèle multimodal) + IMAGE debug."""

    CATEGORY = "AIH/Masking"
    FUNCTION = "mask"
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "text": ("STRING", {
                    "default": "",
                    "multiline": True,
                }),
                # Preset IA du SERVEUR : widget INT piloté par le dropdown du
                # widget JS (js/aih_mask_anything_widget.js). Déclaré en
                # REQUIRED pour être sérialisé dans widgets_values (les
                # optionnels ne le sont plus) → la valeur survit au workflow.
                "preset_id": ("INT", {"default": 0, "min": 0, "max": 0x7FFFFFFF}),
                # Adoucissement des bords (pixels). 0 = masque binaire strict.
                "feather": ("INT", {"default": 0, "min": 0, "max": 128, "step": 1}),
                # Seed : sert au LLM LOCAL et, surtout, à forcer une nouvelle
                # exécution (ComfyUI met les nodes en cache).
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff,
                                 "control_after_generate": "randomize"}),
                # ── Widgets SAM3 : ajoutés APRÈS seed pour ne pas décaler les
                # widgets_values des workflows existants (les valeurs absentes
                # reprennent ces défauts). Les défauts REPRODUISENT le
                # comportement d'avant : sans MODEL branché, aucune marge n'est
                # appliquée et le mode shape/bbox rend la même chose.
                "mask_mode": (list(MASK_MODES), {
                    "default": MASK_MODE_SHAPE,
                    "tooltip": "shape = masque de la forme détourée par SAM3 ; "
                               "bbox = rectangle (boîte serrée calculée sur la forme SAM3, "
                               "plus juste que celle du LLM). Sans SAM3 : rectangles du LLM."}),
                "expand_px": ("INT", {
                    "default": DEFAULT_EXPAND_PX, "min": 0, "max": MAX_EXPAND_PX, "step": 1,
                    "tooltip": "Marge en pixels ajoutée à chaque boîte du LLM AVANT SAM3 "
                               "(clampée à l'image). SAM3 ne propose un masque que dans la "
                               "boîte : une petite marge évite de couper l'objet."}),
                "min_area_pct": ("INT", {
                    "default": DEFAULT_MIN_AREA_PCT, "min": 0, "max": 100, "step": 1,
                    "tooltip": "Un masque SAM3 couvrant moins que ce pourcentage de l'aire de "
                               "sa boîte est jugé hors-sujet (fond, reflet) → repli sur la "
                               "boîte du LLM."}),
                "sam_refine": ("BOOLEAN", {
                    "default": DEFAULT_SAM_REFINE,
                    "tooltip": "Active le raffinement SAM3. false = masque depuis les boîtes "
                               "du LLM uniquement (aucune passe de modèle)."}),
                "max_boxes": ("INT", {
                    "default": DEFAULT_MAX_BOXES, "min": 1, "max": MAX_MAX_BOXES, "step": 1,
                    "tooltip": "Plafond de boîtes RAFFINÉES : SAM3 ne cache pas son trunk, "
                               "donc une passe ViTDet par boîte. Les boîtes au-delà sont "
                               "ignorées (et signalées dans le statut)."}),
                # ── Widgets PHASE 2 : ajoutés APRÈS ceux de la phase 1 (donc
                # après max_boxes) pour ne pas décaler les widgets_values des
                # workflows existants. Les défauts sont ceux qui corrigent le
                # problème « il ne détecte pas tous les boutons ».
                "sam_crop": ("BOOLEAN", {
                    "default": DEFAULT_SAM_CROP,
                    "tooltip": "Recadre autour de chaque boîte avant SAM3 (mode « région ») : "
                               "un petit objet occupe alors toute la résolution 1008² au "
                               "lieu de quelques pixels. false = image entière (phase 1)."}),
                "crop_margin": ("INT", {
                    "default": DEFAULT_CROP_MARGIN, "min": 0, "max": MAX_CROP_MARGIN,
                    "step": 1,
                    "tooltip": "Contexte ajouté autour de la boîte, en % de la taille de la "
                               "boîte (pas de l'image). 0 = crop collé à la boîte."}),
                "sam_batch": ("INT", {
                    "default": DEFAULT_SAM_BATCH, "min": 1, "max": MAX_SAM_BATCH, "step": 1,
                    "tooltip": "Nombre de boîtes/crops envoyés en UNE passe (1 = une passe par "
                               "boîte, comme la phase 1). En cas d'échec du lot, la node "
                               "rejoue automatiquement en boucle."}),
                "min_crop_px": ("INT", {
                    "default": DEFAULT_MIN_CROP_PX, "min": MIN_MIN_CROP_PX,
                    "max": MAX_MIN_CROP_PX, "step": 1,
                    "tooltip": "Taille PLANCHER du recadrage (côté, en pixels) : évite "
                               "d'agrandir un bouton de 10 px depuis 10 px de contexte."}),
                # ── Widgets PHASE 3 : DÉCOUVERTE, ajoutés APRÈS tous les
                # précédents (donc après min_crop_px) pour ne pas décaler les
                # widgets_values des workflows existants. Défaut = DÉSACTIVÉ :
                # sans ces réglages, la node se comporte exactement comme en
                # phase 2 (aucune passe de détecteur en plus).
                "discover": ("BOOLEAN", {
                    "default": DEFAULT_DISCOVER,
                    "tooltip": "Cherche N instances par le TEXTE (\"concept:N\") dans le "
                               "crop, pour trouver TOUS les objets quand le LLM n'en donne "
                               "qu'une boîte (ex. les boutons d'une chemise). Exige "
                               "sam3_model ET sam3_clip branchés. Coût : 1 passe de "
                               "détecteur par groupe."}),
                "discover_count": ("INT", {
                    "default": DEFAULT_DISCOVER_COUNT, "min": MIN_DISCOVER_COUNT,
                    "max": MAX_DISCOVER_COUNT, "step": 1,
                    "tooltip": "Nombre d'instances DEMANDÉ à SAM3 par concept (\"bouton:8\"). "
                               "SAM3 peut en rendre moins, jamais plus."}),
                "discover_scope": (list(DISCOVER_SCOPES), {
                    "default": DEFAULT_DISCOVER_SCOPE,
                    "tooltip": "per_box = une passe par boîte (fenêtre serrée, meilleure "
                               "résolution) ; union = une passe par concept sur la boîte "
                               "englobante (moins de passes, moins de résolution)."}),
                "discover_threshold": ("FLOAT", {
                    "default": DEFAULT_DISCOVER_THRESHOLD,
                    "min": MIN_DISCOVER_THRESHOLD, "max": MAX_DISCOVER_THRESHOLD,
                    "step": 0.01,
                    "tooltip": "Seuil de score (probabilité) des instances découvertes : "
                               "monter = moins de fausses instances, descendre = plus de "
                               "rappels."}),
            },
            "optional": {
                # Même convention que le node Elements : JSON du node
                # OpenAI/LM Studio Settings, forceInput (socket).
                "llm_config": ("STRING", {"default": "", "forceInput": True}),
                # MODEL du CheckpointLoaderSimple chargé avec
                # sam3.1_multiplex_fp16.safetensors. La node ne CHARGE RIEN :
                # elle consomme le MODEL branché, et se désactive proprement si
                # ce n'est pas un SAM3 (garde de capacité, pas de test de version).
                "sam3_model": ("MODEL", {
                    "tooltip": "MODEL d'un CheckpointLoaderSimple chargé avec "
                               "sam3.1_multiplex_fp16.safetensors : raffine chaque boîte "
                               "en forme propre. Absent ou non-SAM3 → masque depuis les "
                               "boîtes (aucun crash)."}),
                # CLIP du MÊME CheckpointLoaderSimple que sam3_model : l'encodeur
                # texte de SAM3 est EMBARQUÉ dans le checkpoint (clip_name
                # "sam3_clip"). La node ne charge rien, elle encode elle-même le
                # prompt de découverte via l'API publique de ComfyUI.
                "sam3_clip": ("CLIP", {
                    "tooltip": "CLIP du MÊME CheckpointLoaderSimple que sam3_model : "
                               "sert à encoder le texte anglais de la découverte. "
                               "Absent → discover désactivé avec message (le reste "
                               "fonctionne)."}),
            },
        }

    RETURN_TYPES = ("MASK", "IMAGE")
    RETURN_NAMES = ("mask", "boxes_preview")
    DESCRIPTION = (
        "Expérimental : demande à un modèle multimodal les boîtes englobant les "
        "éléments décrits, puis les rastérise en masque. Si un MODEL SAM3 est "
        "branché (sam3_model), chaque boîte élargie est détourée par SAM3 "
        "(mask_mode shape/bbox), recadrée autour de la boîte (sam_crop) et "
        "lotée (sam_batch) ; avec sam3_clip, discover demande en plus à SAM3 N "
        "instances par le texte dans ce crop (pour trouver TOUS les boutons, "
        "pas seulement celui de la boîte). Sinon les boîtes du LLM sont "
        f"utilisées telles quelles. Voir la console ({LOG_PREFIX}) et le "
        "message de la node."
    )

    # ── Points d'entrée ────────────────────────────────────────────────────

    def mask(self, image, text, preset_id=0, feather=0, seed=0,
             mask_mode=MASK_MODE_SHAPE, expand_px=DEFAULT_EXPAND_PX,
             min_area_pct=DEFAULT_MIN_AREA_PCT, sam_refine=DEFAULT_SAM_REFINE,
             max_boxes=DEFAULT_MAX_BOXES, sam_crop=DEFAULT_SAM_CROP,
             crop_margin=DEFAULT_CROP_MARGIN, sam_batch=DEFAULT_SAM_BATCH,
             min_crop_px=DEFAULT_MIN_CROP_PX,
             discover=DEFAULT_DISCOVER, discover_count=DEFAULT_DISCOVER_COUNT,
             discover_scope=DEFAULT_DISCOVER_SCOPE,
             discover_threshold=DEFAULT_DISCOVER_THRESHOLD,
             llm_config=None, sam3_model=None, sam3_clip=None):
        if torch is None:
            # Erreur d'ENVIRONNEMENT (pas un échec du LLM) : message explicite.
            raise RuntimeError(
                "torch est requis pour AIH Mask Anything (MASK/IMAGE) — "
                "installe les dépendances de ComfyUI"
            )
        width, height, batch = image_dimensions(image)
        # Lecture DÉFENSIVE : un ancien workflow n'a pas ces widgets, un appel
        # API peut envoyer None ou une chaîne → on retombe sur les défauts.
        mode = coerce_choice(mask_mode, MASK_MODES, MASK_MODE_SHAPE)
        margin = coerce_int(expand_px, DEFAULT_EXPAND_PX, 0, MAX_EXPAND_PX)
        min_pct = coerce_int(min_area_pct, DEFAULT_MIN_AREA_PCT, 0, 100)
        wants_refine = coerce_bool(sam_refine, DEFAULT_SAM_REFINE)
        cap = coerce_int(max_boxes, DEFAULT_MAX_BOXES, 1, MAX_MAX_BOXES)
        wants_crop = coerce_bool(sam_crop, DEFAULT_SAM_CROP)
        crop_pct = coerce_int(crop_margin, DEFAULT_CROP_MARGIN, 0, MAX_CROP_MARGIN)
        batch_size = coerce_int(sam_batch, DEFAULT_SAM_BATCH, 1, MAX_SAM_BATCH)
        crop_floor = coerce_int(min_crop_px, DEFAULT_MIN_CROP_PX,
                                MIN_MIN_CROP_PX, MAX_MIN_CROP_PX)
        wants_discover = coerce_bool(discover, DEFAULT_DISCOVER)
        discover_n = coerce_int(discover_count, DEFAULT_DISCOVER_COUNT,
                                MIN_DISCOVER_COUNT, MAX_DISCOVER_COUNT)
        discover_mode = coerce_choice(discover_scope, DISCOVER_SCOPES,
                                      DEFAULT_DISCOVER_SCOPE)
        discover_thr = coerce_float(discover_threshold, DEFAULT_DISCOVER_THRESHOLD,
                                    MIN_DISCOVER_THRESHOLD, MAX_DISCOVER_THRESHOLD)

        description = (text or "").strip()
        if not description:
            return self._fail(
                image, batch, height, width,
                "texte vide : décris les éléments à trouver (ex. « le chat, le lampadaire »)",
            )

        try:
            image_base64 = llm_helper.image_tensor_to_base64(image)
        except Exception as exc:  # noqa: BLE001 — encodeur : message clair, pas de crash
            return self._fail(
                image, batch, height, width,
                f"encodage de l'image impossible ({exc})",
            )

        user_prompt = build_user_prompt(description, width, height)
        output, error = self._ask_model(
            llm_config, preset_id, seed, user_prompt, image_base64
        )
        if error:
            return self._fail(image, batch, height, width, error)

        LOGGER.info(f"{LOG_PREFIX} réponse brute ({len(output)} cars) : {output[:500]!r}")
        boxes, reason = parse_boxes(output, width, height)
        if reason:
            return self._fail(
                image, batch, height, width, self._reason_message(reason, output)
            )

        labels = ", ".join(box["label"] for box in boxes if box.get("label"))[:120]

        # ── Raffinement SAM3 (facultatif, jamais bloquant) ──
        plan = None
        note = None
        runtime = None
        if wants_refine:
            runtime, why = resolve_sam3(sam3_model)
            if runtime is None:
                note = SAM3_UNAVAILABLE_NOTE
                LOGGER.info(f"{LOG_PREFIX} raffinement désactivé : {why}")
            else:
                try:
                    plan = self._refine_plan(
                        runtime, image, boxes, width, height,
                        margin, min_pct, cap, mode,
                        sam_crop=wants_crop, crop_margin=crop_pct,
                        sam_batch=batch_size, min_crop_px=crop_floor,
                    )
                except Exception as exc:  # noqa: BLE001 — SAM3 est un CONFORT : jamais bloquant
                    LOGGER.warning(
                        f"{LOG_PREFIX} raffinement SAM3 interrompu : {exc} → "
                        "masque depuis les boîtes"
                    )
                    note = f"{SAM3_UNAVAILABLE_NOTE} ({exc})"
        else:
            note = "SAM3 désactivé (sam_refine=False) → masque depuis les boîtes"

        # ── DÉCOUVERTE (phase 3) : N instances par le TEXTE dans le crop ──
        if wants_discover:
            plan, discover_note = self._apply_discovery(
                plan, runtime, sam3_clip, image, boxes, width, height,
                expand_px=margin, count=discover_n, scope=discover_mode,
                threshold=discover_thr, mask_mode=mode, cap=cap,
                wants_refine=wants_refine, sam_crop=wants_crop,
                crop_margin=crop_pct, min_crop_px=crop_floor,
                description=description,
            )
            if discover_note:
                note = f"{note} · {discover_note}" if note else discover_note

        if plan is not None:
            # Formes raffinées : union des formes (mode shape) ou rectangles
            # resserrés (mode bbox), feather appliqué APRÈS comme avant.
            shape = plan["mask"]
            if feather and feather > 0:
                shape = feather_mask(shape, feather)
            masks = torch.stack([shape for _ in range(batch)])
            preview = draw_boxes(image, plan["boxes"])
            if plan["outline"] is not None:
                preview = draw_mask_outline(preview, plan["outline"])
            status = self._refine_status(plan, width, height, labels)
        else:
            # Comportement HISTORIQUE, inchangé : boîtes du LLM telles quelles
            # (aucune marge, aucun appel de modèle).
            masks = torch.stack(
                [boxes_to_mask(boxes, width, height, feather) for _ in range(batch)]
            )
            preview = draw_boxes(image, boxes)
            status = f"{len(boxes)} boîte(s) → masque {width}×{height}"
            if labels:
                status += f" · {labels}"
            if note:
                status += f" · {note}"
        LOGGER.info(f"{LOG_PREFIX} {status}")
        return {"ui": {"status": [status]}, "result": (masks, preview)}

    # ── Raffinement SAM3 (phase 2 : crop par boîte + passe lotée) ──────────

    def _refine_plan(self, runtime, image, boxes, width, height,
                     expand_px, min_area_pct, max_boxes, mask_mode,
                     sam_crop=DEFAULT_SAM_CROP,
                     crop_margin=DEFAULT_CROP_MARGIN,
                     sam_batch=DEFAULT_SAM_BATCH,
                     min_crop_px=DEFAULT_MIN_CROP_PX):
        """Applique SAM3 → plan de sortie (jamais None).

        Deux réglages orthogonaux, qui se composent :
          - ``sam_crop`` : chaque boîte est détourée dans un RECADRAGE agrandi
            (fenêtre ``crop_window``) puis recollée à sa position ;
            ``sam_crop=False`` envoie l'image ENTIÈRE (géométrie de la phase 1);
          - ``sam_batch`` : groupes de ``N`` boîtes envoyés en UNE passe ; si la
            passe lotée est refusée (le batching n'est pas exercé par la node
            native), on REJOUE en boucle, une boîte à la fois.

        Renvoie un dict ``{"mask", "boxes", "outline", "refined", "fallback",
        "clipped", "merged", "dropped", "error", "crop", "passes",
        "batch", "batch_fallbacks"}`` :
          - ``mask`` : masque ``[H,W]`` flottant 0/1 (SANS feather) ;
          - ``boxes`` : boîtes à dessiner en preview (finales en mode bbox,
            élargies sinon) ;
          - ``outline`` : forme à contourner en preview (None en mode bbox, où
            les rectangles suffisent) ;
          - ``refined`` / ``fallback`` / ``clipped`` / ``merged`` : compteurs ;
          - ``dropped`` : boîtes au-delà de ``max_boxes`` (ignorées) ;
          - ``error`` : message d'échec GLOBAL de SAM3 (sinon None) ;
          - ``crop`` / ``passes`` / ``batch`` / ``batch_fallbacks`` : mode
            utilisé et compteurs de passes (statut ``ui``).
        """
        unet, device, dtype = runtime
        limited = boxes[:max_boxes]
        dropped = len(boxes) - len(limited)
        expanded = [expand_box(box, expand_px, width, height) for box in limited]
        batch_size = max(1, int(sam_batch))
        if dropped:
            LOGGER.info(
                f"{LOG_PREFIX} plafond max_boxes={max_boxes} : "
                f"{dropped} boîte(s) ignorée(s) (1 passe ViTDet par boîte)"
            )

        # 1) Géométrie par boîte : FENÊTRE de contexte + boîte-prompt exprimée
        #    dans le repère de cette fenêtre. En mode plein format la fenêtre
        #    est l'image entière et la boîte-prompt garde ``box_to_1008`` :
        #    c'est exactement la phase 1.
        full_window = (0, 0, int(width), int(height))
        entries = []
        for box in expanded:
            if sam_crop:
                window = crop_window(box, width, height, crop_margin, min_crop_px)
                prompt = box_to_crop_1008(box, window, width, height)
            else:
                window = full_window
                prompt = box_to_1008(box)
            entries.append({"box": box, "window": window,
                            "prompt": prompt, "img": None})

        # 2) Images 1008² : UNE seule en mode plein (elle ne dépend pas de la
        #    boîte), une PAR FENÊTRE en mode crop — préparées par LOT pour que
        #    la mémoire reste bornée à ``sam_batch`` crops (12 Mio chacun).
        global_error = None
        shared = None
        frame = None
        try:
            frame = image[0:1] if image.dim() == 4 else image.unsqueeze(0)
        except Exception as exc:  # noqa: BLE001 — IMAGE exotique : repli global
            global_error = f"préparation d'image SAM3 impossible ({exc})"
        if frame is not None and not sam_crop:
            try:
                shared = prepare_sam3_image(frame, device, dtype)
            except Exception as exc:  # noqa: BLE001 — SAM3 KO : repli global
                global_error = f"préparation d'image SAM3 impossible ({exc})"
                LOGGER.warning(f"{LOG_PREFIX} {global_error} → repli sur les boîtes")

        # 3) Passes de modèle : par GROUPES de ``sam_batch``. L'appariement
        #    reste POSITIONNEL (ordre des entrées), y compris après un repli en
        #    boucle : chaque masque retrouve son entrée d'origine.
        masks_by_box = []
        fallback = clipped = unscaled = 0
        passes = 0
        batch_fallbacks = 0
        for group in chunk_boxes(entries, batch_size):
            logits_by_pos = [None] * len(group)
            pending = []
            # Images du lot : calculées ICI (et oubliées après) pour ne jamais
            # garder ``max_boxes`` crops de 12 Mio en mémoire.
            for pos, entry in enumerate(group):
                if global_error is not None:
                    break
                try:
                    if shared is not None:
                        entry["img"] = shared
                    else:
                        entry["img"] = prepare_sam3_crop(
                            frame, entry["window"], device, dtype)
                except Exception as exc:  # noqa: BLE001 — crop KO : repli propre
                    global_error = f"préparation d'image SAM3 impossible ({exc})"
                    LOGGER.warning(
                        f"{LOG_PREFIX} {global_error} → repli sur les boîtes")
                    break
                pending.append((pos, entry))
            if pending:
                passes += 1
                try:
                    produced = self._segment_group(
                        unet, [entry["img"] for _, entry in pending],
                        [entry["prompt"] for _, entry in pending], device, dtype)
                except Exception as exc:  # noqa: BLE001 — SAM3/OOM : jamais bloquant
                    produced = None
                    if len(pending) > 1:
                        batch_fallbacks += 1
                        LOGGER.info(
                            f"{LOG_PREFIX} passe lotée ({len(pending)} boîte(s)) "
                            f"refusée ({exc}) → repli en boucle, une boîte à la fois")
                    else:
                        LOGGER.warning(
                            f"{LOG_PREFIX} forward_segment a échoué : {exc}")
                if produced is None and len(pending) > 1:
                    # FILET : on rejoue exactement comme en phase 1 (une passe
                    # par boîte) et on POURSUIT — jamais de crash.
                    produced = []
                    for _, entry in pending:
                        passes += 1
                        try:
                            produced.append(self._segment_group(
                                unet, [entry["img"]], [entry["prompt"]],
                                device, dtype)[0])
                        except Exception as exc:  # noqa: BLE001 — cette boîte seule
                            LOGGER.warning(
                                f"{LOG_PREFIX} forward_segment a échoué : {exc}")
                            produced.append(None)
                if produced is None:
                    # échec d'une passe à UNE boîte : cette boîte part en repli
                    produced = [None] * len(pending)
                for (pos, _), item in zip(pending, produced):
                    logits_by_pos[pos] = item
                for _, entry in pending:  # libère les crops du lot
                    entry["img"] = None

            for entry, logits in zip(group, logits_by_pos):
                mask = None
                if logits is not None:
                    try:
                        mask = self._finish_mask(
                            logits, entry["window"], width, height)
                    except MaskGeometryError as exc:
                        # Géométrie refusée : repli COMPTÉ et visible (jamais un
                        # masque mal mis à l'échelle en silence).
                        unscaled += 1
                        LOGGER.warning(
                            f"{LOG_PREFIX} masque SAM3 non remis à l'échelle : {exc}")
                        mask = None
                    except Exception as exc:  # noqa: BLE001 — logits exotiques
                        LOGGER.warning(
                            f"{LOG_PREFIX} masque SAM3 illisible : {exc}")
                        mask = None
                box_window = box_window_px(entry["box"], width, height)
                box_px = box_area_px(box_window)
                if mask is not None:
                    verdict = should_fallback(int(mask.sum()), box_px, min_area_pct)
                    if verdict == VERDICT_CLIP:
                        mask = clip_mask_to_window(mask, box_window, width, height)
                        clipped += 1
                        verdict = should_fallback(int(mask.sum()), box_px, min_area_pct)
                    if verdict != VERDICT_KEEP:
                        mask = None
                if mask is None:
                    fallback += 1
                masks_by_box.append(mask)

        pairs = pair_boxes_masks(expanded, masks_by_box)
        if pairs is None:  # garde-fou : association 1:1 exigée
            LOGGER.warning(
                f"{LOG_PREFIX} association masque/boîte incohérente "
                f"({len(masks_by_box)} masque(s) pour {len(expanded)} boîte(s)) "
                "→ repli global sur les boîtes"
            )
            return self._fallback_plan(
                expanded, width, height, dropped, "association masque/boîte incohérente",
                crop=sam_crop,
            )

        refined_masks = [mask for _, mask in pairs if mask is not None]
        merged_masks = dedupe_masks(refined_masks)
        merged_away = len(refined_masks) - len(merged_masks)
        fallback_boxes = [box for box, mask in pairs if mask is None]

        if mask_mode == MASK_MODE_BBOX:
            # Boîte SERRÉE calculée sur la forme SAM3 : c'est tout l'intérêt du
            # mode bbox (la boîte du LLM est mal calée, celle du masque ne l'est
            # pas). Repli : la boîte élargie du LLM.
            out_boxes = []
            for mask in merged_masks:
                tight = tight_box_from_mask(mask_bounds(mask), width, height)
                if tight is not None:
                    out_boxes.append(tight)
            out_boxes = dedupe_boxes(out_boxes + fallback_boxes)
            shape = boxes_to_mask(out_boxes, width, height, 0)
            outline = None
        else:
            shape = boxes_to_mask(fallback_boxes, width, height, 0)
            for mask in merged_masks:
                shape = torch.maximum(shape, mask.to(shape.dtype))
            out_boxes = [box for box, _ in pairs]
            outline = shape

        refined = len(merged_masks)
        plan = {
            "mask": shape.clamp(0.0, 1.0),
            "boxes": out_boxes,
            "outline": outline,
            "refined": refined,
            "fallback": fallback,
            "unscaled": unscaled,
            "clipped": clipped,
            "merged": merged_away,
            "dropped": dropped,
            "error": global_error,
            "crop": bool(sam_crop),
            "passes": passes,
            "batch": batch_size,
            "batch_fallbacks": batch_fallbacks,
        }
        LOGGER.info(
            f"{LOG_PREFIX} SAM3 {'crop' if sam_crop else 'plein'} : "
            f"{refined} forme(s) raffinée(s), "
            f"{fallback} repli(s), {unscaled} masque(s) non remis à l'échelle, "
            f"{clipped} clippé(s), {merged_away} fusion(s), "
            f"{passes} passe(s) (lot {batch_size}, "
            f"{batch_fallbacks} repli(s) de batching)"
        )
        return plan

    def _fallback_plan(self, expanded, width, height, dropped, error, crop=False):
        """Plan de REPLI GLOBAL : rectangles des boîtes élargies, zéro crash."""
        return {
            "mask": boxes_to_mask(expanded, width, height, 0),
            "boxes": list(expanded),
            "outline": None,
            "refined": 0,
            "fallback": len(expanded),
            "unscaled": 0,
            "clipped": 0,
            "merged": 0,
            "dropped": dropped,
            "error": error,
            "crop": bool(crop),
            "passes": 0,
            "batch": 1,
            "batch_fallbacks": 0,
        }

    # ── DÉCOUVERTE (phase 3) : N instances par le TEXTE dans le crop ────────

    def _apply_discovery(self, plan, runtime, clip, image, boxes, width, height,
                         expand_px=DEFAULT_EXPAND_PX, count=DEFAULT_DISCOVER_COUNT,
                         scope=DEFAULT_DISCOVER_SCOPE,
                         threshold=DEFAULT_DISCOVER_THRESHOLD,
                         mask_mode=MASK_MODE_SHAPE, cap=DEFAULT_MAX_BOXES,
                         wants_refine=True, sam_crop=DEFAULT_SAM_CROP,
                         crop_margin=DEFAULT_CROP_MARGIN,
                         min_crop_px=DEFAULT_MIN_CROP_PX, description=""):
        """Rend le plan COMPOSÉ avec les formes découvertes → ``(plan, note)``.

        N'est appelée que si ``discover=True``. Trois issues, aucune bloquante :
          - pas de plan (SAM3 absent / ``sam_refine=False``) → ``(plan, note)`` :
            la note part dans le statut du chemin « boîtes du LLM » ;
          - garde de capacité (``sam3_clip`` absent / CLIP non-SAM3 / MODEL sans
            chemin texte / aucun concept) → plan INCHANGÉ + ``discover_note`` ;
          - sinon → ``_discover_shapes`` puis ``_merge_discovery`` (union).

        Une exception imprévue de la découverte est attrapée ICI et rend le plan
        de la phase 2 intact : la découverte est un CONFORT, jamais une panne.
        """
        if plan is None:
            note = (DISCOVER_NEEDS_REFINE_NOTE if not wants_refine
                    else DISCOVER_NEEDS_MODEL_NOTE)
            LOGGER.info(f"{LOG_PREFIX} {note}")
            return None, note

        usable = None
        if runtime is None:
            disabled = DISCOVER_NEEDS_MODEL_NOTE
        elif not can_detect_text(runtime[0]):
            disabled = "découverte désactivée : MODEL sans détection texte"
        else:
            usable, why = resolve_sam3_clip(clip)
            disabled = (None if usable is not None
                        else f"découverte désactivée : {why}")
        groups = []
        if disabled is None:
            # Mêmes boîtes que ``_refine_plan`` (même marge, même plafond) : la
            # découverte explore EXACTEMENT les zones déjà raffinées.
            expanded = [expand_box(box, expand_px, width, height)
                        for box in boxes[:cap]]
            groups = discovery_groups(expanded, scope, description)
            if not groups:
                disabled = DISCOVER_NO_CONCEPT_NOTE
        if disabled:
            LOGGER.info(f"{LOG_PREFIX} {disabled}")
            merged = dict(plan)
            merged["discover_note"] = disabled
            return merged, None

        try:
            report = self._discover_shapes(
                runtime, usable, image, groups, width, height,
                count=count, threshold=threshold, sam_crop=sam_crop,
                crop_margin=crop_margin, min_crop_px=min_crop_px, cap=cap,
            )
        except Exception as exc:  # noqa: BLE001 — confort : jamais bloquant
            LOGGER.warning(
                f"{LOG_PREFIX} découverte interrompue : {exc} → "
                "formes par boîte conservées"
            )
            merged = dict(plan)
            merged["discover_note"] = f"découverte interrompue ({exc})"
            return merged, None
        return self._merge_discovery(plan, report, width, height, mask_mode), None

    def _discover_shapes(self, runtime, clip, image, groups, width, height,
                         count=DEFAULT_DISCOVER_COUNT,
                         threshold=DEFAULT_DISCOVER_THRESHOLD,
                         sam_crop=DEFAULT_SAM_CROP,
                         crop_margin=DEFAULT_CROP_MARGIN,
                         min_crop_px=DEFAULT_MIN_CROP_PX, cap=DEFAULT_MAX_BOXES):
        """Interroge SAM3 par le TEXTE sur chaque groupe → masques PLEIN FORMAT.

        Pipeline par groupe (identique à la phase 2 pour la géométrie) :
        fenêtre ``crop_window`` → ``prepare_sam3_crop`` (1008² ANISOTROPE) →
        conditionnement ``"<concept>:<count>"`` → ``detect_sam3_text`` (seuil +
        troncature côté nous) → N masques DANS LE REPÈRE DU CROP → ``paste_mask``.
        Puis dédoublonnage (``dedupe_masks`` : SAM3 n'a aucun NMS dans le chemin
        image — les doublons sont à notre charge) et PLAFOND à ``cap`` formes.

        ``sam_crop=False`` → fenêtre = image entière : la découverte porte sur
        toute l'image (moins de résolution, mais une seule image 1008² partagée).

        Renvoie un RAPPORT (jamais d'exception pour un groupe isolé) :
        ``{"masks", "groups", "passes", "empty", "merged", "dropped",
        "error", "prompt"}``. ``empty`` = groupes sans aucune instance.
        """
        unet, device, dtype = runtime
        report = {"masks": [], "groups": 0, "passes": 0, "empty": 0,
                  "merged": 0, "dropped": 0, "unscaled": 0,
                  "error": None, "prompt": ""}
        limit = max(1, int(cap))
        groups = list(groups)[:limit]
        if not groups:
            report["error"] = "aucun groupe à explorer"
            return report
        try:
            frame = image[0:1] if image.dim() == 4 else image.unsqueeze(0)
            shared = (None if sam_crop
                      else prepare_sam3_image(frame, device, dtype))
        except Exception as exc:  # noqa: BLE001 — image exotique : repli propre
            report["error"] = f"préparation d'image SAM3 impossible ({exc})"
            LOGGER.warning(
                f"{LOG_PREFIX} {report['error']} → formes par boîte conservées")
            return report

        cache = {}
        collected = []
        for group in groups:
            prompt = discovery_prompt(group["concept"], count)
            if not prompt:
                continue
            report["prompt"] = prompt
            if sam_crop:
                window = crop_window(group["box"], width, height,
                                     crop_margin, min_crop_px)
            else:
                window = (0, 0, int(width), int(height))
            win_w = max(1, int(window[2]) - int(window[0]))
            win_h = max(1, int(window[3]) - int(window[1]))
            report["groups"] += 1
            report["passes"] += 1
            try:
                crop = shared if shared is not None else prepare_sam3_crop(
                    frame, window, device, dtype)
                embeddings, attention_mask = self._sam3_prompt(
                    clip, prompt, device, dtype, cache)
                shapes = detect_sam3_text(
                    unet, crop, embeddings, attention_mask, threshold, count,
                    (win_h, win_w),
                )
            except Exception as exc:  # noqa: BLE001 — un groupe KO, pas la node
                report["error"] = f"détection SAM3 impossible ({exc})"
                LOGGER.warning(
                    f"{LOG_PREFIX} {report['error']} (groupe {prompt!r}) → "
                    "formes par boîte conservées"
                )
                report["empty"] += 1
                continue
            if not shapes:
                report["empty"] += 1
                continue
            for crop_mask in shapes:
                # Le détecteur a pu rendre sa résolution INTERNE (1008×1008) :
                # on ramène le masque à la taille de la fenêtre AVANT le
                # recollage, et un échec de géométrie est COMPTÉ + dit dans le
                # statut ``ui`` (jamais un masque minuscule dans le coin).
                try:
                    crop_mask = fit_mask_to_window(crop_mask, window)
                except MaskGeometryError as exc:
                    report["unscaled"] += 1
                    report["error"] = f"masque découvert non remis à l'échelle ({exc})"
                    LOGGER.warning(
                        f"{LOG_PREFIX} {report['error']} (groupe {prompt!r})")
                    continue
                collected.append(paste_mask(crop_mask, window, width, height))
            if len(collected) >= limit:
                break

        deduped = dedupe_masks(collected)
        report["merged"] = len(collected) - len(deduped)
        if len(deduped) > limit:
            report["dropped"] = len(deduped) - limit
            deduped = deduped[:limit]
        report["masks"] = deduped
        LOGGER.info(
            f"{LOG_PREFIX} découverte {report['prompt']!r} : "
            f"{len(deduped)} forme(s) sur {report['groups']} groupe(s) "
            f"({report['merged']} doublon(s) fusionné(s), "
            f"{report['empty']} groupe(s) vide(s))"
        )
        return report

    @staticmethod
    def _sam3_prompt(clip, prompt, device, dtype, cache):
        """``(embeddings, attention_mask)`` pour ``prompt``, sur le DEVICE du modèle.

        Encodage MUTUALISÉ (``cache``) : dix boîtes de « bouton » ne doivent pas
        encoder dix fois le même texte. La conversion ``to(device, dtype)`` est
        celle que fait la node native sur la conditioning reçue
        (``comfy_extras/nodes_sam3.py:26``) : l'embedding sort de la CLIP sur son
        propre device, le détecteur le veut sur le sien.
        """
        if prompt not in cache:
            embeddings, attention_mask = encode_sam3_text(clip, prompt)
            embeddings = embeddings.to(device=device, dtype=dtype)
            if attention_mask is not None:
                attention_mask = attention_mask.to(device)
            cache[prompt] = (embeddings, attention_mask)
        return cache[prompt]

    @staticmethod
    def _merge_discovery(plan, report, width, height, mask_mode):
        """Compose plan de phase 2 + formes découvertes (UNION, jamais remplacement).

        DÉCISION documentée : les formes découvertes S'AJOUTENT. Remplacer le
        résultat par boîte ferait perdre la cible du LLM au premier faux positif
        (SAM3 peut détourer un bouton voisin ou un reflet) ; en union, le pire
        cas est une forme en trop, jamais une cible manquante. Si la découverte
        ne trouve rien, le plan de la phase 2 est rendu INCHANGÉ (mêmes pixels).

        ``mask_mode=bbox`` : chaque forme découverte donne sa boîte SERRÉE, puis
        on déduplique les rectangles (IoU ≥ 0.95) et on rastérise.
        """
        masks = list(report.get("masks") or [])
        merged = dict(plan)
        merged.update({
            "discover": True,
            "discovered": len(masks),
            "discover_groups": report.get("groups", 0),
            "discover_passes": report.get("passes", 0),
            "discover_empty": report.get("empty", 0),
            "discover_merged": report.get("merged", 0),
            "discover_dropped": report.get("dropped", 0),
            "discover_unscaled": report.get("unscaled", 0),
            "discover_prompt": report.get("prompt", ""),
            "discover_error": report.get("error"),
        })
        if not masks:
            return merged
        if mask_mode == MASK_MODE_BBOX:
            out_boxes = list(plan["boxes"])
            for mask in masks:
                tight = tight_box_from_mask(mask_bounds(mask), width, height)
                if tight is not None:
                    out_boxes.append(tight)
            out_boxes = dedupe_boxes(out_boxes)
            merged["boxes"] = out_boxes
            merged["mask"] = boxes_to_mask(out_boxes, width, height, 0).clamp(0.0, 1.0)
            merged["outline"] = None
            return merged
        shape = plan["mask"]
        for mask in masks:
            shape = torch.maximum(shape, mask.to(dtype=shape.dtype))
        merged["mask"] = shape.clamp(0.0, 1.0)
        merged["outline"] = merged["mask"]
        return merged

    @staticmethod
    def _segment_group(unet, imgs, prompts, device, dtype):
        """UNE passe pour ``N`` prompts : liste de logits ``[1,1,1008,1008]``.

        ``imgs`` = une image 1008² par prompt (toutes de même forme → empilables
        en ``[N,3,1008,1008]``), ``prompts`` = coins ``(x1,y1,x2,y2)`` DÉJÀ dans
        le repère 1008² de leur image (espace crop en mode région). C'est le
        seul chemin DÉTERMINISTE (N prompts → N masques, dans l'ordre d'entrée).
        Le chemin texte du détecteur est volontairement écarté : il trie par
        score et tronque à ``max_det``.

        LÈVE au moindre doute (exception du modèle, sortie de forme inattendue,
        nombre de masques différent du nombre de prompts) : l'appelant décide de
        rejouer en boucle ou de passer la boîte en repli — jamais de masque
        décalé silencieusement.
        """
        box_inputs = torch.tensor(
            [[[float(prompt[0]), float(prompt[1])],
              [float(prompt[2]), float(prompt[3])]] for prompt in prompts],
            dtype=dtype, device=device,
        )
        images = imgs[0] if len(imgs) == 1 else torch.cat(imgs, dim=0)
        logits = unet.forward_segment(images, box_inputs=box_inputs)
        shape = tuple(getattr(logits, "shape", ()) or ())
        expected = (len(prompts), 1, SAM3_SIZE, SAM3_SIZE)
        if len(shape) != 4 or shape[0] != expected[0] or shape[1] != 1:
            raise RuntimeError(
                f"forward_segment a renvoyé shape={shape} (attendu {expected})"
            )
        return [logits[index:index + 1] for index in range(len(prompts))]

    @staticmethod
    def _finish_mask(logits, window, width, height):
        """Logits du détecteur → masque booléen PLEIN FORMAT ``[H,W]``.

        Deux étapes, dans cet ordre (c'est tout le remap du crop) :
          1. rééchantillonnage à la taille de la FENÊTRE (le masque est produit
             dans le repère du crop) — par ``fit_mask_to_window``, qui ne fait
             JAMAIS confiance à la taille rendue par le détecteur (1008×1008
             natif ⇒ masque minuscule dans le coin) ;
          2. binarisation ``> 0`` (SAM3 sort des LOGITS, pas des probabilités :
             objet absent ⇒ logits écrasés à -1024 ⇒ masque vide) PUIS
             RECOLLAGE à la position de la fenêtre dans l'image.
        """
        fitted = fit_mask_to_window(logits, window)
        return paste_mask(fitted, window, width, height)

    @staticmethod
    def _refine_status(plan, width, height, labels):
        """Statut ``ui`` du chemin raffiné : compteurs, mode, plafond, labels."""
        parts = [
            f"{plan['refined']} forme(s) raffinée(s), {plan['fallback']} repli(s)"
        ]
        # Mode + passes : on AJOUTE (les messages existants ne sont pas réécrits).
        mode = "crop" if plan["crop"] else "plein"
        passes = f"mode {mode} · {plan['passes']} passe(s)"
        if plan.get("batch", 1) > 1:
            passes += f" (lot {plan['batch']})"
        if plan.get("batch_fallbacks"):
            passes += f" · {plan['batch_fallbacks']} repli(s) de batching"
        parts.append(passes)
        if plan["clipped"]:
            parts.append(f"{plan['clipped']} clippé(s)")
        if plan.get("unscaled"):
            parts.append(f"{plan['unscaled']} masque(s) non remis à l'échelle")
        if plan["merged"]:
            parts.append(f"{plan['merged']} doublon(s) fusionné(s)")
        parts.append(f"masque {width}×{height}")
        if plan["dropped"]:
            parts.append(f"plafond max_boxes atteint ({plan['dropped']} ignorée(s))")
        # ── Découverte (phase 3) : compteurs AJOUTÉS, messages existants intacts.
        if plan.get("discover"):
            discover = f"découverte « {plan.get('discover_prompt') or '?'} » : " \
                       f"{plan.get('discovered', 0)} forme(s)"
            if plan.get("discover_groups"):
                discover += f" sur {plan['discover_groups']} groupe(s)"
            if plan.get("discover_merged"):
                discover += f", {plan['discover_merged']} doublon(s) fusionné(s)"
            if plan.get("discover_dropped"):
                discover += f", plafond atteint ({plan['discover_dropped']} ignorée(s))"
            if plan.get("discover_empty"):
                discover += f", {plan['discover_empty']} groupe(s) sans instance"
            if plan.get("discover_unscaled"):
                discover += (f", {plan['discover_unscaled']} masque(s) non "
                             "remis à l'échelle")
            if not plan.get("discovered"):
                discover += " → formes par boîte conservées"
            parts.append(discover)
            if plan.get("discover_error"):
                parts.append(f"découverte partielle ({plan['discover_error']})")
        elif plan.get("discover_note"):
            parts.append(plan["discover_note"])
        if plan["error"]:
            parts.append(f"{SAM3_UNAVAILABLE_NOTE} ({plan['error']})")
        status = " · ".join(parts)
        if labels:
            status += f" · {labels}"
        return status

    def _ask_model(self, llm_config, preset_id, seed, user_prompt, image_base64):
        """Appelle le LLM (local via llm_config, sinon preset serveur).

        Returns:
            ``(output, error)`` — exactement un des deux est non vide.
        """
        config = llm_config
        if isinstance(config, str):
            config = config.strip() or None

        if config:
            # ── Chemin LOCAL : même mécanisme que le Prompt Enhancer ──
            try:
                output = llm_helper.call_llm(
                    config, SYSTEM_PROMPT, user_prompt,
                    seed=seed, image_base64=image_base64, image_hint=IMAGE_HINT,
                )
            except Exception as exc:  # noqa: BLE001 — provider local : message affiché
                return None, f"LLM local injoignable ({exc})"
            if not isinstance(output, str) or not output.strip():
                return None, (
                    "réponse vide du LLM local (llm_config illisible, modèle "
                    "non multimodal, ou serveur local éteint)"
                )
            return output, None

        # ── Chemin SERVEUR : preset du dropdown via /api/keywords/llm-process ──
        try:
            selected = int(preset_id or 0)
        except (TypeError, ValueError):
            selected = 0
        if selected <= 0:
            return None, (
                "aucun preset IA sélectionné : choisis-en un dans le menu de la "
                "node, ou connecte une entrée llm_config"
            )

        api_url = credentials.get_api_url()
        api_key = credentials.get_api_key()
        if not api_url:
            return None, "serveur AIH non configuré (Settings ▸ AIH · Compte)"

        vision_content = llm_helper.build_image_content(
            user_prompt + "\n\n" + IMAGE_HINT, image_base64
        )
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": vision_content},
        ]
        return llm_helper.call_backend_preset(
            api_url, api_key, selected, messages=messages, timeout=180
        )

    @staticmethod
    def _reason_message(reason, raw_output):
        """Message utilisateur SPÉCIFIQUE à la cause d'échec du parsing."""
        preview = (raw_output or "").strip().replace("\n", " ")[:160]
        if reason == REASON_EMPTY:
            return "réponse vide du modèle (aucun texte renvoyé)"
        if reason == REASON_NOT_JSON:
            return f"réponse non JSON — le modèle n'a pas suivi le format demandé : {preview!r}"
        if reason == REASON_NO_BOXES:
            return (
                "aucune boîte dans la réponse : le modèle n'a rien trouvé qui "
                f"corresponde à la description ({preview!r})"
            )
        return (
            "boîtes invalides (hors image, inversées ou dégénérées) : rien "
            f"n'a pu être rastérisé ({preview!r})"
        )

    @staticmethod
    def _fail(image, batch, height, width, message):
        """Échec HONNÊTE : masque vide (zéros) + message visible + log console."""
        LOGGER.warning(f"{LOG_PREFIX} {message}")
        empty = torch.zeros((batch, height, width), dtype=torch.float32)
        return {"ui": {"status": [f"⚠️ {message}"]}, "result": (empty, image)}


# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix).
# UNE seule clé : aucun alias (tests/test_node_registration_unique.py).
NODE_CLASS_MAPPINGS = {
    "AIHMaskAnything": AIHMaskAnythingNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHMaskAnything": "AIH Mask Anything",
}
