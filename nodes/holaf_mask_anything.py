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

LIMITES HONNÊTES (à lire avant de juger) :
  - précision : une boîte englobante, pas un détourage. Attendez-vous à ±2-10 %
    de la taille pour un bon modèle vision sur des objets nets, et à des boîtes
    franchement fausses sur des petites cibles, des objets occultés ou des
    scènes encombrées ;
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
    '{"boxes":[{"x1":0.0,"y1":0.0,"x2":0.0,"y2":0.0,"label":"short label"}]}\n'
    "Rules:\n"
    "- Coordinates are NORMALIZED to the range 0.0-1.0 (never pixels).\n"
    "- Origin (0,0) is the TOP-LEFT corner: x grows to the right, y grows down.\n"
    "- x1,y1 = top-left corner of the box; x2,y2 = bottom-right corner "
    "(x2 > x1 and y2 > y1).\n"
    "- One box per DISTINCT element described. Several boxes are allowed, even "
    "with the same label (e.g. three cats = three boxes).\n"
    "- Each box must TIGHTLY enclose its element: fully inside, nothing else.\n"
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
    """Énumère ``(coords, label, schéma)`` depuis toutes les formes connues.

    Accepte (récursivement, profondeur bornée) :
      - ``{"boxes": [...]}`` / ``{"objects": ...}`` / ``{"result": ...}`` … ;
      - un dict « boîte » direct (``x1/y1/x2/y2``, ``xmin/…``, ``box_2d``) ;
      - une liste de listes ``[x1,y1,x2,y2]`` ou une liste de dicts ;
      - une boîte seule ``[x1,y1,x2,y2]`` à la racine.
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
            found.append((coords, _label_from_dict(payload), scheme))
        return found
    if isinstance(payload, (list, tuple)):
        coords = _coords_from_sequence(payload)
        if coords is not None:
            found.append((coords, "", "xy"))
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
    for coords, label, scheme in entries:
        box = normalize_box(coords, scheme, width, height)
        if box is None:
            continue
        box["label"] = label
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
            },
            "optional": {
                # Même convention que le node Elements : JSON du node
                # OpenAI/LM Studio Settings, forceInput (socket).
                "llm_config": ("STRING", {"default": "", "forceInput": True}),
            },
        }

    RETURN_TYPES = ("MASK", "IMAGE")
    RETURN_NAMES = ("mask", "boxes_preview")
    DESCRIPTION = (
        "Expérimental : demande à un modèle multimodal les boîtes englobant les "
        "éléments décrits, puis les rastérise en masque. Voir la console "
        f"({LOG_PREFIX}) et le message de la node en cas d'échec."
    )

    # ── Points d'entrée ────────────────────────────────────────────────────

    def mask(self, image, text, preset_id=0, feather=0, seed=0, llm_config=None):
        if torch is None:
            # Erreur d'ENVIRONNEMENT (pas un échec du LLM) : message explicite.
            raise RuntimeError(
                "torch est requis pour AIH Mask Anything (MASK/IMAGE) — "
                "installe les dépendances de ComfyUI"
            )
        width, height, batch = image_dimensions(image)

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

        masks = torch.stack(
            [boxes_to_mask(boxes, width, height, feather) for _ in range(batch)]
        )
        preview = draw_boxes(image, boxes)
        labels = ", ".join(box["label"] for box in boxes if box.get("label"))[:120]
        status = f"{len(boxes)} boîte(s) → masque {width}×{height}"
        if labels:
            status += f" · {labels}"
        LOGGER.info(f"{LOG_PREFIX} {status}")
        return {"ui": {"status": [status]}, "result": (masks, preview)}

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
