# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""
AIH OpenAI Settings — Node de configuration pour API compatible OpenAI.
Couvre Ollama, OpenAI, DeepSeek, Mistral, Groq, etc.
"""
import json
import logging
import os

# Emplacement des données utilisateur : UNE seule source de vérité
# (holaf_user_paths), avec repli sur l'ancien emplacement tant que rien n'a été
# migré (user/default/aih/openai_keys.json → config/openai_keys.json).
try:  # import relatif (pack importé comme extension ComfyUI)
    from .. import holaf_user_paths as _user_paths
except ImportError:  # chargé à plat (sys.path = racine du pack, tests par chemin)
    import holaf_user_paths as _user_paths

class AIHOpenAISettingsNode:
    CATEGORY = "AIH/Prompting"
    FUNCTION = "generate_config"
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "base_url": ("STRING", {
                    "default": "http://localhost:11434/v1",
                    "tooltip": "OpenAI-compatible API base URL. Examples: http://localhost:11434/v1 (Ollama), https://api.openai.com/v1, https://api.deepseek.com"
                }),
                "api_key": ("STRING", {
                    "default": "",
                    "tooltip": "API key. Leave empty for local servers (Ollama)."
                }),
                "model": ("STRING", {
                    "default": "",
                    "tooltip": "Model name. Examples: llama3:8b, gpt-4o, deepseek-chat"
                }),
                "max_tokens": ("INT", {"default": 0, "min": 0, "max": 4096, "step": 1, "tooltip": "Limite de réponse en tokens. 0 = pas de limite (défaut du modèle)."}),
                "temperature": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 2.0, "step": 0.01}),
                # num_ctx : taille de la fenêtre de contexte (spécifique Ollama).
                # 0 = auto-détection depuis l'API (recommandé, cache 1h) ; >0 = override manuel.
                "num_ctx": ("INT", {"default": 0, "min": 0, "max": 1048576, "step": 1024}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("llm_config",)

    def generate_config(self, base_url, api_key, model, max_tokens, temperature, num_ctx):
        base = base_url.strip().rstrip("/")

        # Lire la clé API depuis le fichier local si pas fournie dans le widget
        key = api_key.strip() if api_key else ""
        if not key:
            try:
                # Chemin résolu par holaf_user_paths (nouveau emplacement migré,
                # sinon l'ancien : aucune clé utilisateur perdue).
                keys_path = _user_paths.resolved_openai_keys()
                if os.path.isfile(keys_path):
                    with open(keys_path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    key = data.get(base, "")
            except Exception as e:
                logging.warning(f"[AIH OpenAI Settings] Failed to read API key: {e}")

        config = {
            "type": "openai",
            "base_url": base,
            "api_key": key,
            "model": model.strip() if model else "",
            "max_tokens": int(max_tokens),
            "temperature": float(temperature),
            "num_ctx": int(num_ctx or 0),
        }
        return (json.dumps(config),)

# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix).
# Legacy alias keys were removed (user decision): /api/object_info exposes
# one entry PER KEY, so a second alias key made every node appear TWICE in
# the Add Node search. Old workflows referencing the removed keys must be
# redone.
NODE_CLASS_MAPPINGS = {
    "AIHOpenAISettings": AIHOpenAISettingsNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHOpenAISettings": "AIH OpenAI Settings",
}
