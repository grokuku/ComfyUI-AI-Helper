# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>
#
# ---------------------------------------------------------------------------
# Contrat du packet copié à l'identique de « krea-reference »
# (© 2026 Kevin Gilper, MIT — https://github.com/kgilper/krea-reference),
# kg_krea_slider/slider_card.py + kg_krea_slider/constants.py. Le type de
# socket (KG_KREA_SLIDER) et la forme du packet sont conservés tels quels
# pour rester compatibles avec l'encodeur Krea Slider installé à côté.
# Voir THIRD-PARTY-NOTICES.md.
# ---------------------------------------------------------------------------

"""
AIH Slider Card — carte purement descriptive d'un slider d'attribut.

Entrée  : image (IMAGE, obligatoire ; sert à l'exécution / au preview, la
          valeur n'entre PAS dans le packet — contrat krea Slider V1)
Sortie  : slider (KG_KREA_SLIDER) = packet
          {"kg_slider_version", "description", "value", "increase_text",
           "decrease_text"}

La carte n'effectue aucun calcul : l'encodeur Krea Slider dérive l'axe
sémantique et pousse la valeur -6..+6.
"""

import logging

_log = logging.getLogger(__name__)

# Nom du type de socket : identique à kg_krea_slider/constants.py (frozen).
KG_KREA_SLIDER_TYPE = "KG_KREA_SLIDER"

# Plage du cadran, comme krea (SLIDER_RANGE = 6.0).
SLIDER_RANGE = 6.0

# Version du packet slider (contrat krea Slider V1).
KG_SLIDER_VERSION = 1


class AIHSliderCard:
    """
    KG Prefix: AIH Slider Card

    Décrit un slider d'attribut et émet un packet pour l'encodeur Krea Slider
    (socket KG_KREA_SLIDER).
    """

    CATEGORY = "AIH/reference"
    FUNCTION = "build"
    RETURN_TYPES = (KG_KREA_SLIDER_TYPE,)
    RETURN_NAMES = ("slider",)
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "attribut": ("STRING", {"default": "brightness", "multiline": False}),
                "valeur": ("FLOAT", {
                    "default": 0.0,
                    "min": -SLIDER_RANGE,
                    "max": SLIDER_RANGE,
                    "step": 0.05,
                    "display": "slider",
                }),
                # Pôles optionnels : si vides, l'encodeur dérive les phrases.
                "pole_positif": ("STRING", {"default": "", "multiline": False}),
                "pole_negatif": ("STRING", {"default": "", "multiline": False}),
            }
        }

    def build(self, **kwargs):
        image = kwargs.get("image")
        if image is None:
            _log.warning(
                "AIHSliderCard : aucune image n'est connectée. L'image n'entre "
                "pas dans le packet slider, mais connectez une entrée IMAGE "
                "pour exécuter la carte dans l'UI ComfyUI."
            )

        value = _clamp(kwargs.get("valeur", 0.0), -SLIDER_RANGE, SLIDER_RANGE)

        packet = {
            "kg_slider_version": KG_SLIDER_VERSION,
            "description": str(kwargs.get("attribut", "brightness") or "").strip(),
            "value": float(value),
            "increase_text": str(kwargs.get("pole_positif", "") or "").strip(),
            "decrease_text": str(kwargs.get("pole_negatif", "") or "").strip(),
        }
        return (packet,)


def _clamp(value, minimum, maximum):
    return min(max(float(value), float(minimum)), float(maximum))


# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix).
NODE_CLASS_MAPPINGS = {
    "AIHSliderCard": AIHSliderCard,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHSliderCard": "AIH Slider Card",
}
