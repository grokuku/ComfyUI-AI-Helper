# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""
LLM Helper — Appels LLM unifiés pour les nodes AIH.
Supporte LM Studio (SDK local) et OpenAI-compatible (HTTP).

Porté depuis AI-Helper/AIH_ComfyUI/nodes/_llm_helper.py dans le sous-package
aih/ de CUI-Holaf-Utils (fusion PLAN_FUSION.md, Phase 2 chantier A) ;
promu 'aih.llm_helper' car il est partagé par plusieurs nodes et futures
routes /aih/*.

Aucun chemin de données, aucune dépendance au loader d'origine : les imports
lmstudio/requests sont optionnels et dégradés proprement (None + erreur
explicite à l'appel), conformément au requirements.txt du pack (requests
fourni ; lmstudio reste optionnel côté utilisateur).
"""
import json
import logging
import random
import re
import threading
import concurrent.futures

try:
    import lmstudio as lms
except Exception:
    lms = None

try:
    import requests
except Exception:
    requests = None


def call_llm(config, system_prompt, user_prompt, seed=None, image_base64=None):
    """
    Appelle un LLM selon le type de config.
    
    Args:
        config: dict avec "type" = "lmstudio" ou "openai", ou None (fallback)
        system_prompt: str
        user_prompt: str
        seed: int ou None
        image_base64: str ou None — image encodée en base64 JPEG (multimodal)
    
    Returns:
        str (le texte généré) ou None si pas de config (fallback backend)
    """
    if config is None:
        return None  # → l'appelant utilise le backend
    
    if not isinstance(config, dict):
        # Si c'est un string JSON, le parser
        try:
            config = json.loads(config) if isinstance(config, str) else config
        except (json.JSONDecodeError, TypeError):
            return None
    
    llm_type = config.get("type", "")
    
    if llm_type == "lmstudio":
        return _call_lmstudio(config, system_prompt, user_prompt, seed, image_base64)
    elif llm_type == "openai":
        return _call_openai(config, system_prompt, user_prompt, seed, image_base64)
    else:
        logging.warning(f"[AIH LLM] Unknown config type: {llm_type}")
        return None


def _call_lmstudio(config, system_prompt, user_prompt, seed=None, image_base64=None):
    """Appelle LM Studio via le SDK Python, ou via HTTP pour le multimodal."""
    # ── Multimodal : utiliser l'API HTTP OpenAI-compatible de LM Studio ──
    # Le SDK lmstudio ne supporte pas les messages multipart avec images.
    # LM Studio expose un endpoint OpenAI-compatible sur localhost:1234/v1.
    if image_base64:
        base_url = config.get("base_url", "").strip().rstrip("/")
        if not base_url:
            base_url = "http://localhost:1234/v1"
        http_config = {
            "base_url": base_url,
            "api_key": config.get("api_key", ""),
            "model": config.get("model", ""),
            # max_tokens passé tel quel à _call_openai qui l'omettra s'il est <= 0.
            "max_tokens": config.get("max_tokens", 0),
            "temperature": config.get("temperature", 0.7),
            # num_ctx (fenêtre de contexte) — passé à _call_openai qui ne
            # l'enverra QUE si le base_url pointe vers Ollama (spécifique Ollama).
            "num_ctx": config.get("num_ctx", 0),
        }
        return _call_openai(http_config, system_prompt, user_prompt, seed, image_base64)

    # ── Mode texte seul : utiliser le SDK lmstudio comme avant ──
    if lms is None:
        raise Exception("LM Studio SDK (lmstudio) is not installed. Run: pip install lmstudio")
    
    try:
        with lms.Client() as client:
            pass
    except Exception as e:
        raise Exception(f"Cannot connect to LM Studio: {e}")
    
    model_key = config.get("model", "").strip() or None
    max_tokens = int(config.get("max_tokens", 0) or 0)
    temperature = float(config.get("temperature", 0.7))
    auto_unload = config.get("auto_unload", True)
    unload_delay = int(config.get("unload_delay", 0))
    
    if seed is None or seed == -1:
        seed = random.randint(0, 0xFFFFFFFFFFFFFFFF)
    
    def _do_work():
        with lms.Client() as client:
            if model_key:
                if auto_unload and unload_delay > 0:
                    model = client.llm.model(model_key, ttl=unload_delay)
                else:
                    model = client.llm.model(model_key)
            else:
                model = client.llm.model()
            
            chat = lms.Chat(system_prompt)
            chat.add_user_message(user_prompt)
            
            respond_config = {
                "temperature": temperature,
                "seed": int(seed),
            }
            # maxTokens : limite de réponse explicite. 0/missing → omis pour que
            # le modèle utilise son propre défaut de sortie.
            if max_tokens > 0:
                respond_config["maxTokens"] = max_tokens
            result = model.respond(chat, config=respond_config)
            
            text = result.content or ""
            # Strip thinking tags
            text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL | re.IGNORECASE).strip()
            
            if auto_unload and unload_delay == 0:
                try:
                    model.unload()
                except Exception as e:
                    logging.warning(f"[AIH LLM] Failed to unload model: {e}")
            
            return text
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(_do_work)
        try:
            return future.result(timeout=300)
        except concurrent.futures.TimeoutError:
            raise Exception("LM Studio operation timed out after 300 seconds")


def _build_user_content(user_prompt, image_base64):
    """Construit le contenu du message user : string simple ou multipart avec image.

    Si une image est fournie, ajoute une instruction contextuelle au text part
    (si elle n'est pas déjà présente par l'appelant).
    """
    if image_base64:
        instruction = "[An image is provided as visual reference. Incorporate relevant visual elements from the image into the enhanced prompt.]"
        if instruction not in user_prompt:
            user_prompt = user_prompt + "\n\n" + instruction
        return [
            {"type": "text", "text": user_prompt},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_base64}"}},
        ]
    return user_prompt


def _is_vision_error(error_msg, has_image=False):
    """Détecte si une erreur LLM est liée à l'absence de support multimodal.

    Args:
        error_msg: le message d'erreur (string).
        has_image: si True, une image a été envoyée dans la requête.
                   Dans ce cas, des patterns génériques comme "500",
                   "bad request", "internal server error" sont aussi
                   considérés comme potentiellement liés au manque de
                   support multimodal.
    """
    msg_lower = error_msg.lower()
    # Patterns explicites — toujours pertinents
    indicators = [
        "image", "vision", "multimodal", "multimodal_capability",
        "content type", "unsupported content", "image_url",
        "does not support", "not support image", "not a vision model",
        "no vision", "can only process text",
    ]
    if any(ind in msg_lower for ind in indicators):
        return True
    # Patterns contextuels — uniquement si une image a été envoyée
    if has_image:
        generic_indicators = ["500", "bad request", "internal server error", "ollama"]
        if any(ind in msg_lower for ind in generic_indicators):
            return True
    return False


def _is_ollama_base_url(base_url):
    """Détecte si l'URL de base pointe vers Ollama (local ou cloud).

    num_ctx est un paramètre SPÉCIFIQUE à Ollama (taille de la fenêtre de
    contexte). On ne doit l'envoyer QUE si l'URL contient "ollama" ou le
    port 1143x d'Ollama (ex: http://localhost:11434/v1).
    """
    return "ollama" in (base_url or "").lower() or ":1143" in (base_url or "")


def _call_openai(config, system_prompt, user_prompt, seed=None, image_base64=None):
    """Appelle une API compatible OpenAI via HTTP."""
    if requests is None:
        raise Exception("requests is not installed")
    
    base_url = config.get("base_url", "").strip().rstrip("/")
    api_key = config.get("api_key", "").strip()
    model = config.get("model", "").strip()
    max_tokens = int(config.get("max_tokens", 0) or 0)
    temperature = float(config.get("temperature", 0.7))
    requested_num_ctx = int(config.get("num_ctx", 0) or 0)
    
    if not base_url:
        raise Exception("base_url is required for OpenAI config")
    if not model:
        raise Exception("model is required for OpenAI config")
    
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    
    user_content = _build_user_content(user_prompt, image_base64)
    
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "temperature": temperature,
    }
    # max_tokens : limite de réponse explicite. 0/missing → OMIS de la requête
    # pour que le modèle utilise son propre défaut (certaines APIs rejettent
    # max_tokens: 0).
    if max_tokens > 0:
        payload["max_tokens"] = max_tokens
    
    # Pas de repeat_penalty (problème avec DeepSeek etc)
    
    # num_ctx : uniquement si l'utilisateur l'a explicitement défini (> 0).
    # NE PAS auto-détecter : Ollama Cloud utilise déjà son contexte max par défaut,
    # et Ollama local le configure au niveau du modèle. L'auto-fetch peut renvoyer
    # une valeur plus petite et OVERRIDE le défaut, causant des débordements.
    if requested_num_ctx > 0 and _is_ollama_base_url(base_url):
        payload["num_ctx"] = requested_num_ctx

    url = f"{base_url}/chat/completions"
    resp = requests.post(url, headers=headers, json=payload, timeout=(10, 300))
    
    if not resp.ok:
        body = resp.text
        raise Exception(f"HTTP {resp.status_code}: {body[:500]}")
    
    data = resp.json()
    return data.get("choices", [{}])[0].get("message", {}).get("content", "")