# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""
AIH Keywords — Node ComfyUI pour construire des filtres de mots-clés.

IN (caché, géré par le widget JS) :
  _keywords_config : STRING (JSON) contenant la config du filtre + les keywords

OUT :
  random_keyword : STRING — un mot-clé choisi aléatoirement (déterministe selon seed)
  keywords_list  : STRING — liste des mots-clés séparés par des virgules

Le widget JS (aih_keywords_widget.js) s'occupe de :
- Charger les sections/sous-sections depuis l'API
- Faire les appels API pour récupérer les keywords filtrés
- Mettre à jour le widget caché _keywords_config
"""

import json
import random


class AIHKeywordsNode:
    CATEGORY = "AIH/Prompting"
    FUNCTION = "process"
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # Seed caché côté JS via hideWidget(node, "seed").
                # Sert uniquement à forcer ComfyUI à réexécuter la node
                # à chaque run du workflow (control_after_generate).
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
            },
            "optional": {
                # JSON mis à jour par le widget JS via les appels API
                # Masqué dans l'UI ComfyUI
                "_keywords_config": ("STRING", {"default": "{}", "multiline": True}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("random_keyword", "keywords_list")

    def process(self, seed, _keywords_config="{}"):
        """
        _keywords_config est un JSON string mis à jour par le widget JS.
        Format attendu :
        {
          "keywords_text": "mot1, mot2, mot3",
          "keywords": [{"id": 1, "keyword": "mot1", ...}, ...],
          "total": 3,
          "config": {...}
        }

        random_keyword est choisi de façon déterministe selon le seed :
        un même seed + même liste → même mot-clé.
        """
        try:
            data = json.loads(_keywords_config) if isinstance(_keywords_config, str) else _keywords_config
        except (json.JSONDecodeError, TypeError):
            data = {}

        keywords = data.get("keywords", [])
        keywords_list = data.get("keywords_text", "")

        if keywords:
            rng = random.Random(seed)
            chosen = rng.choice(keywords)
            random_keyword = chosen.get("keyword", "") if isinstance(chosen, dict) else str(chosen)
        else:
            random_keyword = ""

        return (random_keyword, keywords_list)


# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix);
# the legacy pre-fusion key stays as an alias pointing to the SAME class so
# existing workflows keep loading. Legacy aliases are never purged.
NODE_CLASS_MAPPINGS = {
    "AIHKeywords": AIHKeywordsNode,
    # Legacy alias - never purge.
    "AIHKeywordsNode": AIHKeywordsNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHKeywords": "AIH Keywords",
    "AIHKeywordsNode": "AIH Keywords",
}
