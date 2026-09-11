# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""
AIH Ideogram 4 Caption Builder — Construit un JSON caption Ideogram 4 via LLM.

Entrees :
  - seed (INT) : widget natif ComfyUI
  - width / height (INT) : widgets natifs, connectables
  - description (STRING multiligne) : widget natif ComfyUI
  - element_1..4 (STRING) : widget natif ComfyUI, connectables
  - _api_config (STRING, cache) : JSON interne

Sorties :
  - prompt (STRING), width (INT), height (INT), preview (IMAGE)
"""

import json
import logging

# Socle AIH partagé (bootstrap sys.path fait par le __init__.py racine du pack).
from aih import credentials, llm_helper


class AIHIdeogram4Node:
    CATEGORY = "AIH/Prompting"
    FUNCTION = "build_caption"
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "width": ("INT", {"default": 1024, "min": 64, "max": 4096, "step": 64}),
                "height": ("INT", {"default": 1024, "min": 64, "max": 4096, "step": 64}),
                "description": ("STRING", {"multiline": True, "default": ""}),
                "element_1": ("STRING", {"default": ""}),
                "element_2": ("STRING", {"default": ""}),
                "element_3": ("STRING", {"default": ""}),
                "element_4": ("STRING", {"default": ""}),
                "preset_id": ("INT", {"default": 0, "min": 0}),
                "style_id": ("INT", {"default": 0, "min": -1}),
                "style_shortlist": ("STRING", {"default": "[]"}),  # frontend-only (filtre dropdown), pas envoyé à l'API
                "template_id": ("INT", {"default": 0, "min": 0}),
                "validation_template_id": ("INT", {"default": 0, "min": 0}),
            },
            "optional": {
                "llm_config": ("STRING", {"forceInput": True}),
            },
        }

    RETURN_TYPES = ("STRING", "INT", "INT", "IMAGE", "STRING", "STRING")
    RETURN_NAMES = ("prompt", "width", "height", "preview", "debug", "llm_config")

    def build_caption(self, seed=0, width=1024, height=1024,
                      description="", element_1="", element_2="",
                      element_3="", element_4="",
                      preset_id=0, style_id=0, style_shortlist="[]",
                      template_id=0, validation_template_id=0, llm_config=None):
        import logging
        # Defensive : ComfyUI peut envoyer une string vide pour un INT
        try:
            template_id = int(template_id) if template_id != "" else 0
        except (ValueError, TypeError):
            template_id = 0
        try:
            preset_id = int(preset_id) if preset_id != "" else 0
        except (ValueError, TypeError):
            preset_id = 0
        try:
            style_id = int(style_id) if style_id != "" else 0
        except (ValueError, TypeError):
            style_id = 0
        logging.warning(f"[AIH Ideogram Builder] received template_id={template_id} style_id={style_id} preset_id={preset_id}")
        # api_key et api_url lus depuis le fichier de credentials
        api_url = credentials.get_api_url()
        api_key = credentials.get_api_key()

        # Si style_id == -1 (mode random), piocher un style au hasard
        if style_id == -1:
            try:
                import requests as _req
                resp = _req.get(
                    f"{api_url}/styles",
                    headers={"Authorization": f"Bearer {api_key}"},
                    timeout=10
                )
                if resp.ok:
                    styles = resp.json()
                    if styles:
                        import random as _rand
                        chosen = _rand.choice(styles)
                        style_id = chosen.get("id", 0) if isinstance(chosen, dict) else 0
            except Exception as e:
                logging.warning(f"[AIH Ideogram Builder] Random style fetch failed: {e}")
                style_id = 0

        ep_elements = []
        for el in [element_1, element_2, element_3, element_4]:
            if el and el.strip():
                ep_elements.append({"type": "text", "text": el.strip()})

        payload = {
            "text": description.strip(),
            "seed": seed if seed > 0 else None,
            "template_id": template_id if template_id > 0 else None,
            "validation_template_id": validation_template_id if validation_template_id > 0 else None,
            "width": width,
            "height": height,
            "ep_elements": ep_elements,
            "preset_id": preset_id if preset_id > 0 else None,
            "style_id": style_id if style_id > 0 else None,
        }
        if validation_template_id > 0:
            payload['validation_passes'] = 1

        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        # --- Mode LLM local (llm_config) ---
        if llm_config:
            system_prompt = (
                "You are an expert prompt engineer for Ideogram 4 image generation. "
                "Build a detailed caption JSON with compositional deconstruction, "
                "elements with bounding boxes, and background. Return only valid JSON."
            )
            user_prompt = description.strip()
            if ep_elements:
                user_prompt += "\n\nElements: " + ", ".join(e["text"] for e in ep_elements)
            enhanced = llm_helper.call_llm(llm_config, system_prompt, user_prompt, seed=seed)
            if enhanced:
                preview_tensor = _render_preview(enhanced, width, height)
                return {
                    "ui": {"prompt": [enhanced]},
                    "result": (enhanced, width, height, preview_tensor, "", llm_config)
                }
            # Fallback sur le backend si le LLM local échoue

        # Mode cloud (defaut) : streaming vers /api/enhance
        try:
            import requests
            r = requests.post(f"{api_url}/enhance",
                              json=payload, headers=headers, stream=True, timeout=(10, 180))
            r.raise_for_status()
            prompt = ""
            debug_md = ""
            for line in r.iter_lines():
                if not line:
                    continue
                try:
                    chunk = json.loads(line.decode('utf-8'))
                except Exception:
                    continue
                status = chunk.get("status", "")
                if status == "done":
                    prompt = chunk.get("output", "")
                    debug_md = chunk.get("debug_md", "")
                    break
                elif status == "error":
                    prompt = f"Erreur API : {chunk.get('error', 'inconnue')[:200]}"
                    break
        except ImportError:
            prompt = "Erreur: module 'requests' manquant. pip install requests"
        except Exception as e:
            msg = str(e)
            if "401" in msg:
                prompt = "Erreur : cle API invalide ou manquante."
            elif "429" in msg:
                prompt = "Erreur : rate limit atteint. Attendez un instant."
            else:
                prompt = f"Erreur API : {msg}"

        preview_tensor = _render_preview(prompt, width, height)

        return {
            "ui": {"prompt": [prompt]},
            "result": (prompt, width, height, preview_tensor, debug_md, llm_config)
        }

    def _build_caption_local_loop(self, api_url, api_key, preset_base_url, payload):
        """
        Boucle multi-passes en mode client-side (LLM local) pour Ideogram 4.
        Meme logique que _enhance_local_loop mais adapte au format de retour Ideogram
        (on retourne (prompt, debug_md) au lieu d'un dict).
        """
        import requests as _req
        backend_headers = {"Content-Type": "application/json"}
        if api_key:
            backend_headers["Authorization"] = f"Bearer {api_key}"

        # 1) prepare
        r = _req.post(f"{api_url}/enhance/prepare", json=payload,
                      headers=backend_headers, timeout=30)
        r.raise_for_status()
        prep = r.json()
        session_id = prep.get("session_id")
        llm_request = prep.get("llm_request")

        # 2) Boucle multi-passes
        pass_idx = 1
        while True:
            # 2a) Appel direct au LLM local
            llm_url = preset_base_url + "/chat/completions"
            llm_headers = {"Content-Type": "application/json"}
            r = _req.post(llm_url, json=llm_request, headers=llm_headers, timeout=180)
            r.raise_for_status()
            llm_response = r.json()

            # 2b) finish
            r = _req.post(
                f"{api_url}/enhance/finish",
                json={"session_id": session_id, "llm_response": llm_response, "pass": pass_idx},
                headers=backend_headers, timeout=60,
            )
            r.raise_for_status()
            fin = r.json()

            if fin.get("status") == "done":
                return fin.get("output", ""), fin.get("debug_md", "")
            if fin.get("status") == "awaiting_validation":
                llm_request = fin.get("llm_request")
                pass_idx = int(fin.get("pass", pass_idx + 1))
                continue
            # Statut inconnu
            raise RuntimeError(f"Statut inattendu du backend: {fin.get('status')}")


def _render_preview(prompt_text, width, height):
    import torch
    from PIL import Image, ImageDraw, ImageFont
    import re

    bg_color = (42, 42, 46)
    img = Image.new("RGB", (width, height), bg_color)
    draw = ImageDraw.Draw(img)

    caption = None
    if prompt_text and prompt_text.strip():
        try:
            s = prompt_text.strip()
            m = re.search(r"```(?:json)?\s*([\s\S]+?)\s*```", s)
            if m:
                s = m.group(1)
            caption = json.loads(s)
        except Exception:
            caption = None

    if not caption:
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", max(16, width // 40))
        except Exception:
            font = ImageFont.load_default()
        msg = "JSON invalide ou absent"
        try:
            tb = draw.textbbox((0, 0), msg, font=font)
            w, h = tb[2] - tb[0], tb[3] - tb[1]
        except Exception:
            w, h = len(msg) * 8, 16
        draw.text(((width - w) / 2, (height - h) / 2), msg, fill=(136, 136, 136), font=font)
        return _to_comfy_image(img)

    elements = (caption.get("compositional_deconstruction") or {}).get("elements") or []
    background = (caption.get("compositional_deconstruction") or {}).get("background") or ""
    if not isinstance(background, str):
        background = json.dumps(background, ensure_ascii=False) if isinstance(background, (dict, list)) else str(background)
    background = background.strip()

    if not elements and not background:
        # Sortie texte ou JSON sans structure Ideogram 4 : afficher le prompt brut
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", max(16, width // 40))
        except Exception:
            font = ImageFont.load_default()
        display_text = prompt_text.strip() if prompt_text else "No output"
        _wrap_text(draw, display_text, 12, 12, width - 24, font, max(18, width // 50), 20)
        return _to_comfy_image(img)

    try:
        font_pill = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", max(20, width // 40))
        font_desc = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", max(18, width // 50))
        font_bg = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf", max(16, width // 60))
    except Exception:
        font_pill = font_desc = font_bg = ImageFont.load_default()

    colors = [
        (34, 211, 238), (132, 204, 22), (168, 85, 247),
        (234, 179, 8), (249, 115, 22), (236, 72, 153), (6, 182, 212),
    ]

    # Pre-calculer les coordonnes de chaque bbox
    bbox_coords = []
    for idx, el in enumerate(elements):
        bbox = el.get("bbox")
        if not bbox or not isinstance(bbox, list) or len(bbox) != 4:
            bbox_coords.append(None)
            continue
        yMin, xMin, yMax, xMax = bbox
        x = int(xMin / 1000 * width)
        y = int(yMin / 1000 * height)
        bw = int((xMax - xMin) / 1000 * width)
        bh = int((yMax - yMin) / 1000 * height)
        if bw < 4 or bh < 4:
            bbox_coords.append(None)
            continue
        bbox_coords.append((x, y, bw, bh, idx))

    # PASSE 1 : fills (opaques, blendes avec le fond gris)
    alpha_fill = 80  # 0-255
    for coords in bbox_coords:
        if coords is None:
            continue
        x, y, bw, bh, idx = coords
        color = colors[idx % len(colors)]
        # Blender la couleur avec le fond : fill = color * alpha + bg * (1-alpha)
        fill = (
            color[0] * alpha_fill // 255 + bg_color[0] * (255 - alpha_fill) // 255,
            color[1] * alpha_fill // 255 + bg_color[1] * (255 - alpha_fill) // 255,
            color[2] * alpha_fill // 255 + bg_color[2] * (255 - alpha_fill) // 255,
        )
        draw.rectangle([x, y, x + bw, y + bh], fill=fill)

    # PASSE 2 : outlines + text (toujours par dessus)
    for coords in bbox_coords:
        if coords is None:
            continue
        x, y, bw, bh, idx = coords
        color = colors[idx % len(colors)]
        el = elements[idx]

        draw.rectangle([x, y, x + bw, y + bh], outline=color, width=3)

        idx_label = f"{idx + 1:02d}"
        pill_pad = 6
        try:
            pb = draw.textbbox((0, 0), idx_label, font=font_pill)
            pw = pb[2] - pb[0] + pill_pad * 2
            ph = pb[3] - pb[1] + 4
        except Exception:
            pw, ph = 28, 22
        pw = max(pw, 28)
        draw.rectangle([x, y, x + pw, y + ph], fill=color)
        draw.text((x + pw / 2, y + ph / 2), idx_label, fill=(0, 0, 0), font=font_pill, anchor="mm")

        text_y = y + ph + 6
        if el.get("type") == "text" and el.get("text"):
            txt = f'"{el["text"]}"'
            draw.text((x + 6, text_y), txt, fill=color, font=font_pill)
            if el.get("desc"):
                draw.text((x + 6, text_y + 22), el["desc"], fill=(255, 255, 255), font=font_desc)
        elif el.get("desc"):
            _wrap_text(draw, el["desc"], x + 6, text_y, bw - 12, font_desc, 18, 5)

    if background:
        bg_h = max(40, height // 20)
        draw.rectangle([0, height - bg_h, width, height], fill=(0, 0, 0))
        _wrap_text(draw, "BG: " + background, 6, height - bg_h + 4, width - 12, font_bg, 18, 3)

    return _to_comfy_image(img)


def _wrap_text(draw, text, x, y, max_w, font, line_h, max_lines):
    words = text.split()
    line = ""
    cur_y = y
    lines = 0
    for i, word in enumerate(words):
        test = (line + " " + word).strip() if line else word
        try:
            bbox = draw.textbbox((0, 0), test, font=font)
            w = bbox[2] - bbox[0]
        except Exception:
            w = len(test) * 7
        if w > max_w and line:
            draw.text((x, cur_y), line, fill=(255, 255, 255), font=font)
            line = word
            cur_y += line_h
            lines += 1
            if lines >= max_lines:
                draw.text((x, cur_y), line + ("..." if i < len(words) - 1 else ""), fill=(255, 255, 255), font=font)
                return
        else:
            line = test
    if line:
        draw.text((x, cur_y), line, fill=(255, 255, 255), font=font)


def _to_comfy_image(pil_img):
    import torch
    import numpy as np
    arr = np.array(pil_img).astype(np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)

# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix);
# the legacy pre-fusion key stays as an alias pointing to the SAME class so
# existing workflows keep loading. Legacy aliases are never purged.
NODE_CLASS_MAPPINGS = {
    "AIHIdeogram4Builder": AIHIdeogram4Node,
    # Legacy alias - never purge.
    "AIHIdeogram4Node": AIHIdeogram4Node,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHIdeogram4Builder": "AIH Ideogram 4 Builder",
    "AIHIdeogram4Node": "AIH Ideogram 4 Builder",
}
