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
                import os, json
                # Utiliser folder_paths pour trouver le dossier utilisateur
                keys_path = None
                try:
                    import folder_paths
                    user_dir = folder_paths.get_user_directory()
                    if user_dir:
                        keys_path = os.path.join(user_dir, "default", "aih", "openai_keys.json")
                except Exception:
                    pass
                if keys_path is None:
                    # Fallback sûr : la racine ComfyUI (folder_paths.base_path), JAMAIS custom_nodes
                    try:
                        comfy_base = getattr(folder_paths, "base_path", None)
                        if comfy_base:
                            keys_path = os.path.join(comfy_base, "user", "default", "aih", "openai_keys.json")
                    except Exception:
                        pass
                if keys_path is None:
                    # Dernier recours : DANS le pack lui-même (jamais custom_nodes/)
                    keys_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "user_data", "aih", "openai_keys.json")
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
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix);
# the legacy pre-fusion key stays as an alias pointing to the SAME class so
# existing workflows keep loading. Legacy aliases are never purged.
NODE_CLASS_MAPPINGS = {
    "AIHOpenAISettings": AIHOpenAISettingsNode,
    # Legacy alias - never purge.
    "AIHOpenAISettingsNode": AIHOpenAISettingsNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHOpenAISettings": "AIH OpenAI Settings",
    "AIHOpenAISettingsNode": "AIH OpenAI Settings",
}
