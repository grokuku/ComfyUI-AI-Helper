# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""
LLM Helper — Appels LLM unifiés pour les nodes AIH.
Supporte LM Studio (SDK local) et OpenAI-compatible (HTTP).

Porté depuis le monorepo AI-Helper dans le sous-package
aih/ de CUI-Holaf-Utils (fusion PLAN_FUSION.md, Phase 2 chantier A) ;
promu 'aih.llm_helper' car il est partagé par plusieurs nodes et futures
routes /aih/*.

Aucun chemin de données, aucune dépendance au loader d'origine : les imports
lmstudio/requests sont optionnels et dégradés proprement (None + erreur
explicite à l'appel), conformément au requirements.txt du pack (requests
fourni ; lmstudio reste optionnel côté utilisateur).
"""
import base64
import concurrent.futures
import io
import json
import logging
import random
import re
import threading

# Dépendances de l'encodage VISION (tensor ComfyUI → PNG base64). Toutes
# optionnelles : sans elles, `image_tensor_to_base64` lève un message explicite
# et les chemins TEXTE SEUL continuent de fonctionner à l'identique.
try:
    import lmstudio as lms
except Exception:
    lms = None

try:
    import requests
except Exception:
    requests = None

try:
    from PIL import Image as PILImage
except ImportError:
    PILImage = None

try:
    import numpy as np
except ImportError:
    np = None

try:
    import torch
except ImportError:
    torch = None

# Plafond de l'image envoyée au modèle de vision : 1 Mpx (≈ 1024×1024).
# Au-delà, l'image est réduite en conservant le ratio (qualité LANCZOS).
VISION_MAX_PIXELS = 1_000_000

# Logger du module : les appels LLM sont déjà journalisés par leurs appelants
# (nodes) sous leur propre préfixe ; ici on ne trace que les échecs du helper.
LOGGER = logging.getLogger(__name__)


# Phrase contextuelle ajoutée au prompt user quand une image accompagne l'appel.
# Historiquement écrite pour le Prompt Enhancer ; les AUTRES appelants (grounding
# de boîtes de Mask Anything) passent leur propre `image_hint`.
IMAGE_REFERENCE_HINT = (
    "[An image is provided as visual reference. Incorporate relevant visual "
    "elements from the image into the enhanced prompt.]"
)


def call_llm(config, system_prompt, user_prompt, seed=None, image_base64=None,
             image_hint=IMAGE_REFERENCE_HINT):
    """
    Appelle un LLM selon le type de config.
    
    Args:
        config: dict avec "type" = "lmstudio" ou "openai", ou None (fallback)
        system_prompt: str
        user_prompt: str
        seed: int ou None
        image_base64: str ou None — image encodée en base64 PNG (multimodal)
        image_hint: phrase ajoutée au prompt user quand une image est jointe ;
            "" pour n'en ajouter aucune (tâche qui n'est pas une amélioration
            de prompt). Défaut = comportement historique du Prompt Enhancer.
    
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
        return _call_lmstudio(config, system_prompt, user_prompt, seed, image_base64, image_hint)
    elif llm_type == "openai":
        return _call_openai(config, system_prompt, user_prompt, seed, image_base64, image_hint)
    else:
        logging.warning(f"[AIH LLM] Unknown config type: {llm_type}")
        return None


def _call_lmstudio(config, system_prompt, user_prompt, seed=None, image_base64=None,
                   image_hint=IMAGE_REFERENCE_HINT):
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
        return _call_openai(http_config, system_prompt, user_prompt, seed, image_base64, image_hint)

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


def image_tensor_to_base64(tensor, max_pixels=VISION_MAX_PIXELS):
    """IMAGE ComfyUI ``[B,H,W,C]`` (float 0..1) → base64 PNG (1re image du lot).

    Sépare l'encodage de l'appel : c'est LE point unique du pack où un tensor
    devient une image envoyable à un modèle multimodal. Réutilisé par
    l'encodeur du Prompt Enhancer (``nodes/enhance_node.py``) et par la node
    expérimentale Mask Anything — aucune duplication du resize/PNG.

    - 1re image du lot uniquement (les modèles vision ne prennent qu'une image) ;
    - réduction proportionnelle si ``W*H > max_pixels`` (LANCZOS) ;
    - PNG et non JPEG : certains modèles vision (Ollama Cloud) refusent le JPEG.

    Lève une exception explicite si Pillow/torch/numpy manquent.
    """
    if PILImage is None or torch is None or np is None:
        raise RuntimeError("PIL (Pillow), torch, and numpy are required for image input support")
    img_array = (tensor[0].cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
    pil_img = PILImage.fromarray(img_array)
    w, h = pil_img.size
    if max_pixels and w * h > max_pixels:
        ratio = (max_pixels / (w * h)) ** 0.5
        new_w = max(1, int(w * ratio))
        new_h = max(1, int(h * ratio))
        pil_img = pil_img.resize((new_w, new_h), PILImage.LANCZOS)
    buf = io.BytesIO()
    pil_img.save(buf, format='PNG')
    return base64.b64encode(buf.getvalue()).decode('utf-8')


def build_image_content(user_prompt, image_base64):
    """Contenu ``user`` OpenAI-compatible : texte + image (data URL PNG base64).

    Forme UNIQUE du transport multimodal du pack, partagée par :
      - le chemin LOCAL (``_build_user_content`` → ``call_llm`` → /chat/completions) ;
      - le chemin SERVEUR (node Mask Anything → ``call_backend_preset`` avec
        ``messages`` pré-construits, relayés VERBATIM par /keywords/llm-process).

    Aucun préfixe ``data:`` n'est ajouté par l'appelant : la chaîne
    ``image_base64`` doit être le base64 NU (voir ``image_tensor_to_base64``).
    """
    return [
        {"type": "text", "text": user_prompt},
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_base64}"}},
    ]


def call_backend_preset(api_url, api_key, preset_id, instruction="", input_text="",
                        messages=None, timeout=180):
    """Appelle ``POST {api_url}/keywords/llm-process`` (preset du serveur AIH).

    Route GÉNÉRIQUE du backend pour « preset + prompt libre ». Deux modes :
      - ``messages`` fourni (liste OpenAI pré-construite) : relayée VERBATIM au
        provider. C'est le mode MULTIMODAL — un contenu ``user`` construit par
        ``build_image_content`` (texte + image_url base64) traverse la route
        telle quelle, sans aucune modification du backend ;
      - sinon ``instruction`` + ``input_text`` (comportement historique texte).

    Auth : Bearer ``api_key`` (jamais dans le workflow — fichier credentials).
    SSRF : ``base_url`` vient de la table ``ai_presets``, validée à la création
    du preset (``backend/security/llm_url.py``) — la route ne réinjecte aucune
    URL fournie par l'appelant.

    Returns:
        ``(output, error)`` : ``output`` = texte du modèle (jamais vide), ou
        ``None`` + ``error`` = message court prêt à afficher (réseau, HTTP,
        réponse vide/illisible). NE LÈVE JAMAIS : l'appelant décide du repli.
    """
    if requests is None:
        return None, "module 'requests' indisponible côté ComfyUI"
    api_url = (api_url or "").strip().rstrip('/')
    if not api_url:
        return None, "serveur AIH non configuré (Settings ▸ AIH · Compte)"

    body = {"preset_id": preset_id}
    if messages is not None:
        body["messages"] = messages
    else:
        body["instruction"] = instruction
        if input_text:
            body["input_text"] = input_text

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    try:
        resp = requests.post(
            f"{api_url}/keywords/llm-process", json=body, headers=headers, timeout=timeout
        )
    except Exception as exc:  # noqa: BLE001 — réseau/DNS/timeout : tout est un échec d'appel
        LOGGER.warning("[AIH LLM] backend preset call failed: %s", exc)
        return None, f"serveur LLM injoignable ({exc})"

    if not resp.ok:
        detail = ""
        try:
            payload = resp.json()
            if isinstance(payload, dict):
                detail = str(payload.get("error") or "")
        except Exception:  # noqa: BLE001 — corps non JSON : on retombe sur le texte brut
            detail = ""
        if not detail:
            try:
                detail = (resp.text or "")[:200]
            except Exception:  # noqa: BLE001 — corps illisible : pas de détail
                detail = ""
        LOGGER.warning("[AIH LLM] backend preset HTTP %s: %s", resp.status_code, detail)
        return None, f"erreur HTTP {resp.status_code} : {detail or 'sans détail'}"

    try:
        data = resp.json()
    except ValueError:
        return None, "réponse serveur illisible (JSON invalide)"
    if not isinstance(data, dict):
        return None, "réponse serveur illisible (format inattendu)"

    output = data.get("output") or ""
    if isinstance(output, str) and output.strip():
        return output, None
    return None, "réponse vide du modèle"


def _build_user_content(user_prompt, image_base64, image_hint=IMAGE_REFERENCE_HINT):
    """Construit le contenu du message user : string simple ou multipart avec image.

    Si une image est fournie, ajoute l'éventuelle instruction contextuelle au
    text part (si elle n'est pas déjà présente et si `image_hint` n'est pas vide).
    """
    if image_base64:
        if image_hint and image_hint not in user_prompt:
            user_prompt = user_prompt + "\n\n" + image_hint
        return build_image_content(user_prompt, image_base64)
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


def _call_openai(config, system_prompt, user_prompt, seed=None, image_base64=None,
                 image_hint=IMAGE_REFERENCE_HINT):
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
    
    user_content = _build_user_content(user_prompt, image_base64, image_hint)
    
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