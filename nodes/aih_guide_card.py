# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>
#
# ---------------------------------------------------------------------------
# Provenance des VALEURS de tuning : ce fichier reprend les tables de recettes
# et les valeurs numériques tunées de « krea-reference » (© 2026 Kevin Gilper,
# MIT — https://github.com/kgilper/krea-reference), en particulier :
#   - kg_krea_v10/recipes.py  (QUICK_RECIPES V10 + overrides des recettes V9,
#     tables de couches STYLE/PALETTE/LIGHTING/STYLE_TRANSFER/STRUCTURE_ONLY,
#     textes de focus STYLE_TRANSFER_FOCUS / LIGHTING_MOOD_FOCUS,
#     apply_layer_dials)
#   - kg_krea_v9/recipes.py   (recettes V9 : balanced, identity, composition,
#     lighting, text/logo safe, EVEN_LAYER_PULL)
#   - kg_krea_v9/guide_card.py (labels + résolution manuelle)
#   - kg_krea_v9/constants.py (nom du type de socket KG_KREA_REFERENCE)
# Adaptées pour les cartes AIH : les valeurs sont identiques, seuls le nom du
# node, la langue des libellés et l'emballage du packet changent. Voir
# THIRD-PARTY-NOTICES.md.
# ---------------------------------------------------------------------------

"""
AIH Guide Card — carte « hybride » décrivant une image de référence.

La carte est purement descriptive : elle n'évalue rien et n'émet qu'un dict
(« packet ») que l'encodeur Krea (V9/V10) installé à côté lit tel quel. Les
types de socket (`KG_KREA_REFERENCE`) sont conservés à l'identique pour rester
compatibles avec les encodeurs krea existants.

Entrée  : image (IMAGE, obligatoire)
Sortie  : guide_card (KG_KREA_REFERENCE) = dict packet

Widgets natifs = source de vérité (sérialisés par ComfyUI) :
  image, intention, direction, force, puis les 10 réglages manuels
  (preparation, formes_copiees, detail_conserve, couleur_conservee, structure,
  finition, phase_debut, phase_fin, etude, cadrage) et overall_style_reach.

Règle intention vs réglages manuels (design « hybride ») :
  - `intention` choisit une recette tunée complète (role, treatment, color,
    detail, study, framing, subject, early/late, cap, shape, global, layers,
    focus).
  - Chaque réglage manuel n'écrase le champ correspondant de la recette QUE
    lorsque sa valeur diffère de son défaut documenté. Ainsi une intention
    seule reproduit exactement la recette krea, et toute valeur déplacée par
    l'artiste devient un override explicite. (L'habillage JS de l'étape 2 peut
    en plus synchroniser les widgets sur la recette : le résultat est
    identique.)
"""

import logging

_log = logging.getLogger(__name__)

# Nom du type de socket : identique à kg_krea_v9/constants.py (frozen).
KG_KREA_REFERENCE_TYPE = "KG_KREA_REFERENCE"

# Version de la carte émise (nos cartes ne dépendent d'aucune version krea).
SOURCE_VERSION = "aih-card-1"

# ── Tables de couches (copiées de krea-reference, V10) ─────────────────────
# 12 gains sur les chunks de deepstack conditioning.
EVEN_LAYER_PULL = [1.0] * 12
STYLE_LAYER_PULL = [0.25, 0.35, 0.45, 0.6, 0.8, 1.0, 1.0, 2.5, 5.0, 1.1, 4.0, 1.2]
PALETTE_LAYER_PULL = [0.15, 0.2, 0.3, 0.45, 0.7, 1.0, 1.0, 2.8, 5.5, 1.3, 4.5, 1.2]
LIGHTING_LAYER_PULL = [0.2, 0.25, 0.35, 0.5, 0.8, 1.0, 1.0, 2.2, 4.5, 1.4, 4.0, 1.2]
STYLE_TRANSFER_LAYER_PULL = [0.062, 0.087, 0.113, 0.15, 0.2, 0.25, 1.25, 3.438, 6.875, 1.375, 5.5, 1.5]
STRUCTURE_ONLY_LAYER_PULL = [1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25]
TEXT_LOGO_LAYER_PULL = [0.15] * 12

# Textes `focus` copiés tels quels (render-tuned 2026-07-06, krea V10).
STYLE_TRANSFER_FOCUS = (
    "the artistic style: palette, medium, brushwork, art direction, and "
    "rendering finish - not the image's blurriness or soft focus, and not "
    "its subject or scene layout"
)
LIGHTING_MOOD_FOCUS = (
    "the lighting: light direction, contrast, mood, color cast, glow, and "
    "shadow behavior - not the place, objects, or scene layout"
)

# ── Libellés des widgets combo ─────────────────────────────────────────────
INTENTION_LABELS = (
    "Garder le sujet",
    "Équilibré",
    "Copier le style",
    "Copier la lumière",
    "Copier la pose",
    "Grandes formes",
    "Palette de couleurs",
    "Éviter texte/logos",
)

DIRECTION_LABELS = {
    "vers l'image": "toward",
    "à l'opposé": "away",
}

PREP_LABELS = {
    "Image telle quelle": "normal",
    "Retirer la couleur": "grayscale",
    "Adoucir les détails": "soft blur",
    "Flouter texte et texture": "strong blur",
    "Lavage de palette": "palette wash",
    "Lavage de couleur": "color wash",
    "Nettoyage formes seules": "grayscale blur",
    "Nettoyage formes fort": "shape wash",
}

STUDY_LABELS = {
    "Réglage de la pile": "stack",
    "Faible - idée libre (256)": "256",
    "Moyen - défaut équilibré (384)": "384",
    "Élevé - plus exact (512)": "512",
    "Très élevé - le plus exact (768)": "768",
}

FRAMING_LABELS = {
    "Réglage de la pile": "stack",
    "Garder la forme complète": "preserve aspect",
    "Recadrer au centre (carré)": "center crop square",
    "Étirer en carré": "stretch square",
}

# Défauts des réglages manuels (documentés, servis par ComfyUI).
DEFAULT_INTENTION = "Équilibré"
DEFAULT_DIRECTION = "vers l'image"
DEFAULT_PREP = "Image telle quelle"
DEFAULT_STUDY = "Réglage de la pile"
DEFAULT_FRAMING = "Réglage de la pile"
DEFAULT_FLOAT = 1.0

# ── Table « intention -> valeurs de packet » (recettes tunées krea V10) ────
# Bundle : role, treatment, color, detail, study, framing, subject, early,
# late, guard (blank-surface), cap (None = pas de cap), shape, global, layers,
# focus. Valeurs copiées à l'identique depuis kg_krea_v10/recipes.py.
INTENTION_RECIPES = {
    "Garder le sujet": {
        "recipe": "identity",
        "role": "identity",
        "treatment": "normal",
        "color": 1.0,
        "detail": 1.0,
        "study": "stack",
        "framing": "stack",
        "subject": "preserve",
        "early": 1.0,
        "late": 1.0,
        "guard": False,
        "cap": None,
        "shape": 1.0,
        "global": 1.0,
        "layers": EVEN_LAYER_PULL,
        "focus": "",
    },
    "Équilibré": {
        "recipe": "balanced",
        "role": "balanced",
        "treatment": "normal",
        "color": 1.0,
        "detail": 1.0,
        "study": "stack",
        "framing": "stack",
        "subject": "recipe",
        "early": 1.0,
        "late": 1.0,
        "guard": False,
        "cap": None,
        "shape": 1.0,
        "global": 1.0,
        "layers": EVEN_LAYER_PULL,
        "focus": "",
    },
    "Copier le style": {
        # V10 override de la recette V9 « style gentle » (strong blur, cap 0.65).
        "recipe": "style gentle",
        "role": "style",
        "treatment": "strong blur",
        "color": 1.0,
        "detail": 0.3,
        "study": "384",
        "framing": "stack",
        "subject": "avoid",
        "early": 0.85,
        "late": 0.85,
        "guard": False,
        "cap": 0.65,
        "shape": 0.85,
        "global": 1.85,
        "layers": STYLE_TRANSFER_LAYER_PULL,
        "focus": STYLE_TRANSFER_FOCUS,
    },
    "Copier la lumière": {
        # V10 override de la recette V9 « lighting » (strong blur + focus).
        "recipe": "lighting",
        "role": "lighting",
        "treatment": "strong blur",
        "color": 1.0,
        "detail": 0.15,
        "study": "256",
        "framing": "stack",
        "subject": "avoid",
        "early": 1.0,
        "late": 0.55,
        "guard": False,
        "cap": 1.25,
        "shape": 0.8,
        "global": 1.3,
        "layers": LIGHTING_LAYER_PULL,
        "focus": LIGHTING_MOOD_FOCUS,
    },
    "Copier la pose": {
        # Recette V9 « composition » (inchangée en V10).
        "recipe": "composition",
        "role": "composition",
        "treatment": "grayscale blur",
        "color": 0.0,
        "detail": 0.25,
        "study": "stack",
        "framing": "stack",
        "subject": "avoid",
        "early": 1.2,
        "late": 0.2,
        "guard": False,
        "cap": 1.25,
        "shape": 1.3,
        "global": 0.3,
        "layers": EVEN_LAYER_PULL,
        "focus": "",
    },
    "Grandes formes": {
        # V10 override de « shape only » (table structure-heavy).
        "recipe": "shape only",
        "role": "shape only",
        "treatment": "shape wash",
        "color": 0.0,
        "detail": 0.0,
        "study": "256",
        "framing": "stack",
        "subject": "avoid",
        "early": 1.1,
        "late": 0.0,
        "guard": False,
        "cap": 1.0,
        "shape": 1.2,
        "global": 0.05,
        "layers": STRUCTURE_ONLY_LAYER_PULL,
        "focus": "",
    },
    "Palette de couleurs": {
        # Recette V10 « palette only » (shape 0.7 render-tuned 2026-07-03).
        "recipe": "palette only",
        "role": "palette",
        "treatment": "palette wash",
        "color": 1.0,
        "detail": 0.0,
        "study": "256",
        "framing": "stack",
        "subject": "avoid",
        "early": 0.9,
        "late": 0.9,
        "guard": False,
        "cap": 0.9,
        "shape": 0.7,
        "global": 1.8,
        "layers": PALETTE_LAYER_PULL,
        "focus": "",
    },
    "Éviter texte/logos": {
        # Recette V9 « text/logo safe » (guard blank-surface).
        "recipe": "text/logo safe",
        "role": "text/logo safe",
        "treatment": "shape wash",
        "color": 0.0,
        "detail": 0.0,
        "study": "256",
        "framing": "stack",
        "subject": "avoid",
        "early": 0.75,
        "late": 0.0,
        "guard": True,
        "cap": 0.03,
        "shape": 0.08,
        "global": 0.0,
        "layers": TEXT_LOGO_LAYER_PULL,
        "focus": "",
    },
}

# Découpage des molettes manuelles de couches (krea V10 recipes.py).
STRUCTURE_LAYER_RANGE = range(6)  # couches 0-5 (structure)
FINISH_LAYER_RANGE = range(6, 12)  # couches 6-11 (finition)


def _clamp(value, minimum, maximum):
    return min(max(float(value), float(minimum)), float(maximum))


def apply_layer_dials(layer_pull, structure_dial, finish_dial):
    """Applique les molettes Structure/Finition à une table de 12 couches.

    Copié de kg_krea_v10/recipes.py::apply_layer_dials — les 6 premières
    couches (structure) sont multipliées par `structure_dial`, les 6 dernières
    (finition) par `finish_dial`. Renvoie toujours 12 floats.
    """
    structure_dial = max(0.0, float(structure_dial))
    finish_dial = max(0.0, float(finish_dial))
    scaled = list(layer_pull)
    for i in STRUCTURE_LAYER_RANGE:
        if i < len(scaled):
            scaled[i] = float(scaled[i]) * structure_dial
    for i in FINISH_LAYER_RANGE:
        if i < len(scaled):
            scaled[i] = float(scaled[i]) * finish_dial
    return scaled


class AIHGuideCard:
    """
    KG Prefix: AIH Guide Card

    Décrit une image de référence et émet un packet guide pour l'encodeur
    Krea (socket KG_KREA_REFERENCE). Aucun calcul lourd : la carte est
    purement descriptive.
    """

    CATEGORY = "AIH/reference"
    FUNCTION = "build"
    RETURN_TYPES = (KG_KREA_REFERENCE_TYPE,)
    RETURN_NAMES = ("guide_card",)
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "intention": (list(INTENTION_LABELS),),
                "direction": (list(DIRECTION_LABELS.keys()),),
                "force": ("FLOAT", {"default": 0.2, "min": 0.0, "max": 3.0, "step": 0.05}),
                "preparation": (list(PREP_LABELS.keys()),),
                "formes_copiees": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.05}),
                "detail_conserve": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05}),
                "couleur_conservee": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05}),
                "structure": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.05}),
                "finition": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.05}),
                "phase_debut": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 5.0, "step": 0.05}),
                "phase_fin": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 5.0, "step": 0.05}),
                "etude": (list(STUDY_LABELS.keys()),),
                "cadrage": (list(FRAMING_LABELS.keys()),),
                # Présent pour la compatibilité krea ; INACTIF sur Krea 2 (le
                # text encoder n'expose pas de pooled_output → l'axe global ne
                # produit rien). Affiché grisé/noté par le JS de l'étape 2.
                "overall_style_reach": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 3.0, "step": 0.05}),
            }
        }

    # ── Helpers de validation / résolution ────────────────────────────

    @staticmethod
    def _require_choice(name, value, choices):
        """Valide un enum ; lève une erreur lisible plutôt qu'un no-op muet."""
        choices = list(choices)
        if value not in choices:
            raise ValueError(
                f"AIHGuideCard : valeur invalide pour « {name} » : {value!r}. "
                f"Valeurs autorisées : {choices}"
            )
        return value

    @staticmethod
    def _manual_override(value, default, recipe_value):
        """Override explicite si l'artiste a déplacé le widget, sinon recette."""
        return value if value != default else recipe_value

    def build(self, **kwargs):
        image = kwargs.get("image")
        if image is None:
            _log.warning(
                "AIHGuideCard : aucune image n'est connectée — le packet sera "
                "émis sans image et l'encodeur ignorera cette carte. "
                "Connectez une entrée IMAGE."
            )

        intention = self._require_choice(
            "intention", kwargs.get("intention", DEFAULT_INTENTION), INTENTION_LABELS
        )
        direction_label = self._require_choice(
            "direction", kwargs.get("direction", DEFAULT_DIRECTION), DIRECTION_LABELS.keys()
        )
        prep_label = self._require_choice(
            "preparation", kwargs.get("preparation", DEFAULT_PREP), PREP_LABELS.keys()
        )
        study_label = self._require_choice(
            "etude", kwargs.get("etude", DEFAULT_STUDY), STUDY_LABELS.keys()
        )
        framing_label = self._require_choice(
            "cadrage", kwargs.get("cadrage", DEFAULT_FRAMING), FRAMING_LABELS.keys()
        )

        recipe = INTENTION_RECIPES[intention]

        # Réglages manuels (valeurs brutes, clampées à leur plage).
        shape_copied = _clamp(kwargs.get("formes_copiees", DEFAULT_FLOAT), 0.0, 2.0)
        detail_conserve = _clamp(kwargs.get("detail_conserve", DEFAULT_FLOAT), 0.0, 1.0)
        couleur_conservee = _clamp(kwargs.get("couleur_conservee", DEFAULT_FLOAT), 0.0, 1.0)
        structure = _clamp(kwargs.get("structure", DEFAULT_FLOAT), 0.0, 2.0)
        finition = _clamp(kwargs.get("finition", DEFAULT_FLOAT), 0.0, 2.0)
        phase_debut = _clamp(kwargs.get("phase_debut", DEFAULT_FLOAT), 0.0, 5.0)
        phase_fin = _clamp(kwargs.get("phase_fin", DEFAULT_FLOAT), 0.0, 5.0)
        overall_reach = _clamp(kwargs.get("overall_style_reach", DEFAULT_FLOAT), 0.0, 3.0)

        # Base = recette de l'intention, puis overrides manuels explicites.
        role = recipe["role"]
        treatment = self._manual_override(PREP_LABELS[prep_label], PREP_LABELS[DEFAULT_PREP], recipe["treatment"])
        color_keep = self._manual_override(couleur_conservee, DEFAULT_FLOAT, recipe["color"])
        detail = self._manual_override(detail_conserve, DEFAULT_FLOAT, recipe["detail"])
        reference_resolution = self._manual_override(STUDY_LABELS[study_label], STUDY_LABELS[DEFAULT_STUDY], recipe["study"])
        reference_fit = self._manual_override(FRAMING_LABELS[framing_label], FRAMING_LABELS[DEFAULT_FRAMING], recipe["framing"])
        subject_policy = recipe["subject"]
        early_multiplier = self._manual_override(phase_debut, DEFAULT_FLOAT, recipe["early"])
        late_multiplier = self._manual_override(phase_fin, DEFAULT_FLOAT, recipe["late"])
        layer_pull = apply_layer_dials(recipe["layers"], structure, finition)
        strength_cap = recipe["cap"]

        # Le reach global reste inactif sur Krea 2 : on l'applique quand même
        # (comme krea) pour préserver la sémantique du packet.
        shape_pull = _clamp(recipe["shape"] * shape_copied, 0.0, 3.0)
        global_pull = _clamp(recipe["global"] * overall_reach, 0.0, 4.0)

        blank_surface_guard = bool(recipe["guard"])
        if blank_surface_guard:
            # Règle krea : le garde texte/logo clampe en dernier et gagne.
            treatment = "shape wash"
            color_keep = 0.0
            detail = 0.0
            reference_resolution = "256"
            early_multiplier = min(float(early_multiplier), 0.75)
            late_multiplier = 0.0
            subject_policy = "avoid"
            strength_cap = 0.03
            shape_pull = min(shape_pull, 0.08)
            global_pull = 0.0
            layer_pull = [min(float(value), 0.15) for value in layer_pull]

        resolved_direction = DIRECTION_LABELS[direction_label]
        if resolved_direction == "away" and subject_policy != "avoid":
            # Un contre-exemple ne porte jamais son sujet dans le résultat.
            subject_policy = "avoid"

        # Force : plafonnée par le cap de la recette (comme krea).
        raw_strength = max(0.0, float(kwargs.get("force", 0.2)))
        strength = min(raw_strength, strength_cap) if strength_cap is not None else raw_strength
        if strength_cap is not None and raw_strength > strength_cap:
            _log.warning(
                "AIHGuideCard : force %.3f > cap %.3f pour l'intention « %s » — "
                "la force est plafonnée à %.3f.",
                raw_strength, strength_cap, intention, strength,
            )

        # Toujours 12 floats (garde-fou).
        layer_pull = [float(value) for value in layer_pull][:12]
        while len(layer_pull) < 12:
            layer_pull.append(1.0)

        manual_controls_active = (
            prep_label != DEFAULT_PREP
            or study_label != DEFAULT_STUDY
            or framing_label != DEFAULT_FRAMING
            or shape_copied != DEFAULT_FLOAT
            or detail_conserve != DEFAULT_FLOAT
            or couleur_conservee != DEFAULT_FLOAT
            or structure != DEFAULT_FLOAT
            or finition != DEFAULT_FLOAT
            or phase_debut != DEFAULT_FLOAT
            or phase_fin != DEFAULT_FLOAT
            or overall_reach != DEFAULT_FLOAT
        )

        focus = str(recipe["focus"] or "")
        timing = "recipe"

        card = {
            "source_version": SOURCE_VERSION,
            "image": image,
            "strength": strength,
            "requested_strength": raw_strength,
            "purpose": intention,
            "prepare_image_by": prep_label,
            "study_this_image_at": study_label,
            "frame_this_reference_by": framing_label,
            "subject_copying": subject_policy,
            "color_kept": couleur_conservee,
            "detail_kept": detail_conserve,
            "shape_copied": shape_copied,
            "overall_style_reach": overall_reach,
            "manual_controls_active": manual_controls_active,
            "quick_recipe": recipe["recipe"],
            # Clés résolues (jamais None).
            "resolved_role": role,
            "resolved_treatment": treatment,
            "resolved_color_keep": float(color_keep),
            "resolved_detail": float(detail),
            "resolved_reference_resolution": reference_resolution,
            "resolved_reference_fit": reference_fit,
            "resolved_subject_policy": subject_policy,
            "resolved_early_multiplier": float(early_multiplier),
            "resolved_late_multiplier": float(late_multiplier),
            "resolved_shape_pull": float(shape_pull),
            "resolved_global_pull": float(global_pull),
            "resolved_layer_pull": layer_pull,
            "resolved_direction": resolved_direction,
            "resolved_timing": timing,
            "resolved_focus": focus,
            # Compatibilité krea V9/V10.
            "v9_blank_surface_guard": blank_surface_guard,
            "v9_strength_cap": strength_cap,
            "guide_direction": direction_label,
            "when_this_card_guides": "recipe decides",
            "structure_layers_pull": structure,
            "finish_layers_pull": finition,
            # Clés de repli sans préfixe (lues par l'encodeur si resolved_ absent).
            "preset": "aih-guide-card",
            "role": role,
            "treatment": treatment,
            "color_keep": float(color_keep),
            "detail": float(detail),
            "reference_resolution": reference_resolution,
            "reference_fit": reference_fit,
            "subject_policy": subject_policy,
            "early_multiplier": float(early_multiplier),
            "late_multiplier": float(late_multiplier),
            "shape_pull": float(shape_pull),
            "global_pull": float(global_pull),
            "layer_pull": list(layer_pull),
            "strength_cap": strength_cap,
            "direction": resolved_direction,
            "timing": timing,
            "focus": focus,
        }
        return (card,)


# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix).
NODE_CLASS_MAPPINGS = {
    "AIHGuideCard": AIHGuideCard,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHGuideCard": "AIH Guide Card",
}
