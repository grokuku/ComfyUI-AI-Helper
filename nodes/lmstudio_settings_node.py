# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""
AIH LMStudio Settings — Node de configuration pour LM Studio local.
"""
import json

class AIHLMStudioSettingsNode:
    CATEGORY = "AIH/Prompting"
    FUNCTION = "generate_config"
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model_identifier": ("STRING", {
                    "default": "",
                    "tooltip": "LM Studio model key. Leave empty for default/loaded model."
                }),
                "auto_unload": ("BOOLEAN", {"default": True}),
                "unload_delay": ("INT", {"default": 0, "min": 0, "max": 3600, "step": 1}),
                "max_tokens": ("INT", {"default": 0, "min": 0, "max": 4096, "step": 1, "tooltip": "Limite de réponse en tokens. 0 = pas de limite (défaut du modèle)."}),
                "temperature": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 2.0, "step": 0.01}),
                # num_ctx : taille de la fenêtre de contexte (spécifique Ollama).
                # Inoffensif pour LM Studio — seulement envoyé si le base_url pointe
                # vers Ollama (le SDK LM Studio l'ignore en mode texte).
                "num_ctx": ("INT", {"default": 32768, "min": 0, "max": 1048576, "step": 1024}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("llm_config",)

    def generate_config(self, model_identifier, auto_unload, unload_delay, max_tokens, temperature, num_ctx):
        config = {
            "type": "lmstudio",
            "model": model_identifier.strip() if model_identifier else "",
            "auto_unload": bool(auto_unload),
            "unload_delay": int(unload_delay),
            "max_tokens": int(max_tokens),
            "temperature": float(temperature),
            "num_ctx": int(num_ctx or 0),
        }
        return (json.dumps(config),)

# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix);
# the legacy pre-fusion key stays as an alias pointing to the SAME class so
# existing workflows keep loading. Legacy aliases are never purged.
NODE_CLASS_MAPPINGS = {
    "AIHLMStudioSettings": AIHLMStudioSettingsNode,
    # Legacy alias - never purge.
    "AIHLMStudioSettingsNode": AIHLMStudioSettingsNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHLMStudioSettings": "AIH LMStudio Settings",
    "AIHLMStudioSettingsNode": "AIH LMStudio Settings",
}
