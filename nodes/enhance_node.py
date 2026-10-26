# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""
AIH Prompt Enhancer Node — Optimise un prompt via LLM ou concatène directement.
DOM widget + connexion aux éléments du Elements Picker.

Option use_llm :
  - True  : Génération intelligente via LLM (System prompt + User prompt)
  - False : Concaténation directe (base_prompt + elements + style) sans LLM

Transport MULTIMODAL : l'image est encodée par
``aih.llm_helper.image_tensor_to_base64`` (source UNIQUE du pack) puis envoyée
soit au LLM local (``llm_helper.call_llm(..., image_base64=...)``), soit au
backend (``payload['image_base64']`` de /api/enhance).

Option ``ratio`` : entrée STRING optionnelle (socket seul, ajoutée EN DERNIER
pour ne décaler aucun widget) prévue pour recevoir la sortie ``ratio`` des nodes
``AIHResolutionPreset`` / ``AIHResolutionPresetV2`` (format ``"16:9 (landscape)"``).
Elle est traduite en consigne ANGLAISE (``_ratio_instruction``) ajoutée au
texte USER — donc présente dans les DEUX chemins LLM (local et /api/enhance) —
jamais dans le ``negative_prompt`` ni en mode concaténation. Vide = inchangé.
"""

import json
import logging
import re

# Socle AIH partagé (bootstrap sys.path fait par le __init__.py racine du pack).
from aih import credentials, llm_helper


def _tensor_to_base64(tensor, max_pixels=llm_helper.VISION_MAX_PIXELS):
    """Convert ComfyUI IMAGE tensor [B,H,W,C] to base64 PNG string.

    DÉLÉGUÉ à ``aih.llm_helper.image_tensor_to_base64`` : l'encodage vision
    (1re image du lot, réduction <= 1 Mpx en conservant le ratio, PNG et non
    JPEG) est le MÊME que celui de la node expérimentale Mask Anything. Ce code
    n'existe donc qu'à UN seul endroit dans le pack ; le comportement de cette
    node (chemin local ET payload backend) est inchangé.
    """
    return llm_helper.image_tensor_to_base64(tensor, max_pixels=max_pixels)


def _clean_output(text, output_format="rich"):
    """Nettoie la sortie LLM selon le format choisi.
    
    rich: garde markdown, JSON, retours à la ligne. Nettoie seulement:
      - code fences en début/fin
      - marqueurs [PRIORITE ...]
      - doubles virgules
    
    basic: aplatit tout en une seule ligne comma-separated:
      - remplace \n par ', '
      - supprime markdown (*, _, #, `, ~)
      - nettoie doubles virgules
    """
    if not text:
        return ""
    
    # --- Nettoyage commun aux deux modes ---
    # Code fences en début/fin
    if text.startswith('```'):
        lines = text.split('\n')
        if lines and lines[0].startswith('```'):
            lines = lines[1:]
        if lines and lines[-1].strip() == '```':
            lines = lines[:-1]
        text = '\n'.join(lines).strip()
    
    # Marqueurs [PRIORITE ...]
    text = re.sub(r'\[PRIORITE\s+(HAUTE|MOYENNE|BASSE)\]', '', text, flags=re.IGNORECASE)
    
    if output_format == "basic":
        # Aplatir en une seule ligne
        text = text.replace('\n', ', ')
        # Supprimer le markdown
        text = re.sub(r'[\*\_\#\`\~]', '', text)
    
    # Nettoyage des virgules (commun aux deux modes)
    text = re.sub(r'\s*,\s*', ', ', text)
    text = re.sub(r',+', ',', text).strip(' ,')
    
    return text


# Role fixe approuvé — identique dans le node ComfyUI et le backend
_FIXED_ROLE = (
    "You are an expert prompt engineer for image generation.\n"
    "Your task is to enhance and expand the user's prompt.\n"
    "Preserve the style provided in the user message. Remove duplicates.\n"
    "Follow the format rules provided.\n"
    "Output only the enhanced prompt — no explanations, no comments."
)


def _backend_configured(api_url):
    """Le backend AIH est-il configuré (server_url renseignée) ?

    Une ``server_url`` vide donne une ``api_url`` vide : les URL relatives
    (``"/styles"``, ``"/enhance"``…) échouent alors avec
    ``Invalid URL '/styles': No scheme supplied``. Ce n'est PAS un bug : c'est
    une configuration absente (Settings ▸ onglet « AIH · Compte »). On le
    constate UNE fois, sans bruit réseau inutile.
    """
    return bool((api_url or "").strip())


def _fetch_template(api_url, api_key, template_id):
    """Fetch un template par ID depuis le backend (GET /api/prompts/templates, filtre par ID)."""
    if not _backend_configured(api_url):
        return None
    try:
        import requests as _req
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        resp = _req.get(f"{api_url}/prompts/templates", headers=headers, timeout=10)
        if resp.ok:
            templates = resp.json()
            for t in templates:
                if t.get("id") == template_id:
                    return t
    except Exception as e:
        logging.warning(f"[AIH Enhance] Template fetch failed: {e}")
    return None


def _fetch_style(api_url, api_key, style_id):
    """Fetch un style par ID depuis le backend (GET /api/styles, filtre par ID)."""
    if not _backend_configured(api_url):
        return None
    try:
        import requests as _req
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        resp = _req.get(f"{api_url}/styles", headers=headers, timeout=10)
        if resp.ok:
            styles = resp.json()
            for s in styles:
                if s.get("id") == style_id:
                    return s
    except Exception as e:
        logging.warning(f"[AIH Enhance] Style fetch failed: {e}")
    return None


# Ratio « largeur:hauteur » accepté en tête de la valeur (ex. "16:9", "16:9
# (landscape)", "~2.39:1"). Sert UNIQUEMENT à déduire la forme de cadre.
_RATIO_VALUE_RE = re.compile(r"^~?(\d+(?:[.,]\d+)?)\s*:\s*(\d+(?:[.,]\d+)?)")


def _ratio_instruction(ratio):
    """Consigne ANGLAISE injectée dans le message USER envoyé au LLM.

    ``ratio`` vient (en général) de la sortie ``ratio`` d'un node de résolution
    (``AIHResolutionPreset`` / ``AIHResolutionPresetV2``), au format du pack :
    ``"16:9 (landscape)"``. Une valeur saisie à la main (``"16:9"``,
    ``"1:1"``…) est acceptée telle quelle.

    Règles (volontairement simples et vérifiables) :
      - vide / absente (``""``, ``None``) → ``""`` ⇒ AUCUNE modification du
        prompt (comportement historique strictement inchangé) ;
      - valeur parsable ``w:h`` → phrase avec la forme de cadre déduite
        (``wide`` si w > h, ``tall`` si w < h, ``square`` si w == h) ;
      - valeur non parsable (``"banane"``) → transmise TELLE QUELLE, sans forme
        de cadre déduite : on ne devine pas, mais on ne perd pas l'information
        et on ne lève JAMAIS d'exception (une entrée de node ne doit pas casser
        un graphe).

    La consigne n'est jamais ajoutée au ``negative_prompt`` ni au mode
    concaténation (``use_llm=False``) : ce n'est pas du contenu de prompt, mais
    une instruction de composition pour le LLM.

    Examples:
        >>> _ratio_instruction("16:9 (landscape)")
        'Target aspect ratio: 16:9 (landscape) — compose for a wide frame.'
        >>> _ratio_instruction("")
        ''
        >>> _ratio_instruction("banane")
        'Target aspect ratio: banane.'
    """
    if ratio is None:
        return ""
    # Une seule ligne : les retours à la ligne d'un widget multiligne casseraient
    # la lecture de la consigne (et l'assertion de test sur une ligne unique).
    value = " ".join(str(ratio).split())
    if not value:
        return ""

    frame = ""
    match = _RATIO_VALUE_RE.match(value)
    if match:
        try:
            ratio_w = float(match.group(1).replace(",", "."))
            ratio_h = float(match.group(2).replace(",", "."))
        except ValueError:  # pragma: no cover — regex déjà numérique
            ratio_w = ratio_h = 0.0
        if ratio_w > 0 and ratio_h > 0:
            if ratio_w > ratio_h:
                frame = "wide"
            elif ratio_w < ratio_h:
                frame = "tall"
            else:
                frame = "square"

    if frame:
        return f"Target aspect ratio: {value} — compose for a {frame} frame."
    return f"Target aspect ratio: {value}."


def _parse_style_shortlist(raw):
    """Parse la shortlist JSON (ex: '["1","2"]') en liste d'IDs normalisés string.

    La shortlist est le widget STRING 'style_shortlist', sérialisé dans le workflow.
    Il contient les IDs des styles sélectionnés par l'utilisateur dans la node
    (sélection multiple via le ⚙️ du dropdown). Retourne [] si invalide/vide.
    """
    if not raw:
        return []
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []
    return [str(x) for x in parsed if str(x).strip()]


def _filter_styles_by_shortlist(styles, selected):
    """Restreint une pool de styles aux IDs présents dans la shortlist sélectionnée."""
    if not styles or not selected:
        return []
    wanted = set(selected)
    return [s for s in styles if isinstance(s, dict) and str(s.get("id")) in wanted]


def _build_system_prompt_unified(template, special_instructions):
    """Construit le system prompt unifié : role fixe + template + examples + special_instructions.

    Args:
        template (dict|None): template récupéré depuis la BDD (ou None si fetch échoué).
        special_instructions (str): instructions spéciales (peut être '').

    Returns:
        str: le system prompt assemblé.
    """
    parts = [_FIXED_ROLE]

    template_system_prompt = (template or {}).get("system_prompt", "")
    if template_system_prompt and template_system_prompt.strip():
        parts.append(template_system_prompt.strip())

    # Examples
    examples = (template or {}).get("examples", [])
    if isinstance(examples, str):
        try:
            examples = json.loads(examples)
        except (json.JSONDecodeError, TypeError):
            examples = []
    if examples:
        ex_list = '\n'.join(f'- {ex}' for ex in examples)
        parts.append(
            "## Examples\n"
            "Here are well-structured examples for reference — study them but do NOT copy verbatim:\n"
            f"{ex_list}"
        )

    if special_instructions and special_instructions.strip():
        parts.append(f"Additional instructions: {special_instructions.strip()}")

    return '\n\n'.join(parts)


def _build_user_prompt_unified(base_prompt, elements_text, style_text):
    """Construit le user prompt unifié : base_prompt + elements + style_text.

    Args:
        base_prompt (str): l'input de la node.
        elements_text (str): les éléments formatés (ou '').
        style_text (str): le texte du style (ou '').

    Returns:
        str: le user prompt assemblé.
    """
    parts = [p for p in [base_prompt, elements_text, style_text] if p and p.strip()]
    return '\n\n'.join(parts)


class AIHEnhanceNode:
    CATEGORY = "AIH/Prompting"
    FUNCTION = "enhance"
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "use_llm": ("BOOLEAN", {"default": True}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "base_prompt": ("STRING", {"multiline": True, "default": ""}),
                "template_id": ("INT", {"default": 0, "min": 0}),
                "preset_id": ("INT", {"default": 0, "min": 0}),
                "output_format": (["rich", "basic"], {"default": "rich"}),
                "style_id": ("INT", {"default": 0, "min": -1}),
                "style_shortlist": ("STRING", {"default": "[]"}),  # frontend-only (filtre dropdown), pas envoyé à l'API
                "special_instructions": ("STRING", {"default": ""}),
            },
            "optional": {
                # Image optionnelle pour le mode multimodal (LLM vision uniquement)
                "image": ("IMAGE",),
                # JSON sérialisé des éléments (connecté à la sortie elements_json du Elements Picker)
                "elements": ("STRING", {"forceInput": True, "multiline": True, "default": "[]"}),
                "llm_config": ("STRING", {"forceInput": True}),
                # Ratio cible (optionnel), typiquement la sortie « ratio » d'un
                # node AIHResolutionPreset / AIHResolutionPresetV2 (même type
                # STRING → branchement direct). Socket seul (pas de widget),
                # comme `elements` / `llm_config` : les widgets existants et
                # donc les `widgets_values` des workflows enregistrés ne sont pas
                # décalés. Vide/absent → comportement historique inchangé.
                "ratio": ("STRING", {"forceInput": True, "default": ""}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("prompt", "negative_prompt", "llm_config")

    def enhance(self, use_llm=True, seed=0, base_prompt="", template_id=0,
                preset_id=0, output_format="rich", style_id=0, style_shortlist="[]",
                special_instructions="", elements="[]", llm_config=None, image=None,
                ratio=""):
        # api_key et api_url lus depuis le fichier de credentials
        api_url = credentials.get_api_url()
        api_key = credentials.get_api_key()

        # ── Conversion image tensor → base64 (si fournie et mode LLM) ──
        # En mode concaténation (use_llm=False), on ignore l'image.
        image_base64 = None
        if image is not None and use_llm:
            try:
                image_base64 = _tensor_to_base64(image)
            except Exception as e:
                logging.warning(f"[AIH Enhance] Image conversion failed: {e}")
                image_base64 = None

        # Defensive : ComfyUI peut envoyer une string vide pour un INT
        try:
            template_id = int(template_id) if template_id != "" else 0
        except (ValueError, TypeError):
            template_id = 0

        # ── DÉGRADATION EXPLICITE (jamais une exception) ─────────────────
        # Ce chemin est atteint quand le backend est INJOIGNABLE ou NON
        # CONFIGURÉ (server_url vide → toutes les URL relatives échouent :
        # « Invalid URL '/styles': No scheme supplied »). Lever une ValueError
        # ici cassait TOUT le prompt du workflow — y compris la partie locale
        # (base_prompt + éléments) qui n'a besoin d'aucun serveur. On dégrade :
        #   - la sortie `prompt` reste UTILE (concaténation locale des éléments,
        #     exactement le résultat de use_llm=false) ;
        #   - la RAISON est remontée dans `ui["warning"]` (affichée comme toast
        #     par js/aih_enhance_widget.js) et écrite dans le log ;
        #   - une vraie erreur de configuration n'est PAS masquée : le message
        #     dit précisément ce qu'il faut renseigner.
        degrade_reasons = []
        if use_llm and not llm_config:
            if not _backend_configured(api_url):
                degrade_reasons.append(
                    "serveur AIH non configuré (server_url vide) — "
                    "Settings ▸ onglet « AIH · Compte »"
                )
            if template_id == 0:
                degrade_reasons.append(
                    "template_id requis en mode cloud — définissez un template (widget)"
                )
        degrade_notice = ""
        if degrade_reasons:
            degrade_notice = (
                "[AIH Enhance] mode dégradé : " + " ; ".join(degrade_reasons)
                + " → concaténation locale des éléments (aucun appel LLM)."
            )
            logging.warning(degrade_notice)
        try:
            preset_id = int(preset_id) if preset_id != "" else 0
        except (ValueError, TypeError):
            preset_id = 0
        try:
            style_id = int(style_id) if style_id != "" else 0
        except (ValueError, TypeError):
            style_id = 0

        # Si style_id == -1 (mode random), piocher un style au hasard.
        # VAGUE 12 : le tirage doit se faire PARMI les styles SÉLECTIONNÉS dans
        # la node (widget STRING 'style_shortlist'), pas dans toute la base.
        # Edge cases :
        #   - shortlist vide → fallback comportement historique : tirage parmi TOUS
        #   - shortlist à 1 seul style → toujours lui
        #   - shortlist non vide mais IDs introuvables côté backend → fallback tous
        if style_id == -1:
            if not _backend_configured(api_url):
                # Aucun serveur : pas de tirage aléatoire possible, pas de bruit réseau.
                style_id = 0
            else:
                try:
                    import requests as _req
                    resp = _req.get(
                        f"{api_url}/styles",
                        headers={"Authorization": f"Bearer {api_key}"},
                        timeout=10
                    )
                    if resp.ok:
                        styles = resp.json()
                        selected = _parse_style_shortlist(style_shortlist)
                        pool = styles
                        if selected:
                            narrowed = _filter_styles_by_shortlist(styles, selected)
                            if narrowed:
                                pool = narrowed
                        if pool:
                            import random as _rand
                            chosen = _rand.choice(pool)
                            style_id = chosen.get("id", 0) if isinstance(chosen, dict) else 0
                except Exception as e:
                    logging.warning(f"[AIH Enhance] Random style fetch failed: {e}")
                    style_id = 0

        # Parse elements JSON (soit un tableau direct, soit l'objet _elements_json complet)
        elems = []
        elems_raw = ""
        try:
            elems_parsed = json.loads(elements) if elements else []
            if isinstance(elems_parsed, dict):
                elems = elems_parsed.get("elements", [])
            elif isinstance(elems_parsed, list):
                elems = elems_parsed
        except (json.JSONDecodeError, TypeError):
            elems_raw = elements or ""

        # _fmt_elems : formatte une liste d'éléments structurés (JSON) en texte.
        # Conservée pour une utilisation future : si une node connectée à l'input
        # 'elements' sort du JSON structuré (ex: [{"type": "filter", "name": "..."}]),
        # cette fonction le convertirait en texte lisible.
        # Actuellement, l'Elements Picker sort du texte simple (pas du JSON), donc
        # elems est toujours vide et cette fonction retourne "". Le vrai contenu
        # passe par elems_raw.
        def _fmt_elems(elist):
            lines = []
            for e in elist:
                if e.get("type") == "filter":
                    name = e.get("name") or f"ID {e.get('id', '?')}"
                    lines.append(f"[Filtre: {name}]")
                elif e.get("type") in ("text", "raw"):
                    hint = (e.get("hint") or "").strip()
                    text = e.get("text", "")
                    # Le hint est un préfixe de résolution : aucun « : » si vide.
                    lines.append(f"[Recherche: {hint + ': ' + text if hint else text}]")
                elif e.get("type") == "random":
                    lines.append("[Éléments aléatoires]")
            return "\n".join(lines)

        elems_text = _fmt_elems(elems)
        # Ordre unifié : base_prompt + elements (elems_text + elems_raw)
        parts = [p for p in [base_prompt, elems_text, elems_raw] if p]
        combined_text = "\n\n".join(parts)

        # ── Ratio cible (optionnel) ──
        # Injecté dans le TEXTE USER, et à un SEUL endroit : `combined_text`
        # alimente (a) le message user du LLM local et (b) `payload['text']` du
        # backend /api/enhance (qui le recompose en `merged_text` → message user
        # réellement envoyé au modèle). Les deux chemins portent donc la même
        # consigne, au même endroit, sans toucher au system prompt ni au
        # negative_prompt. Vide → aucune modification du prompt (comparaison
        # exacte verrouillée par tests/test_enhance_ratio.py).
        # Position résultante IDENTIQUE des deux côtés : la consigne suit le
        # texte (base_prompt + éléments) et précède le texte de style, car le
        # backend concatène `text`, EP, random puis style (`_build_merged_text`).
        ratio_instruction = _ratio_instruction(ratio)
        if ratio_instruction:
            combined_text = "\n\n".join(p for p in (combined_text, ratio_instruction) if p)

        # Fetch style depuis le backend (style_id déjà résolu si -1 random)
        # Déplacé AVANT la séparation LLM/concaténation pour que style_text
        # et negative_prompt soient disponibles dans les deux modes.
        style_text = ""
        negative_prompt = ""
        if style_id and style_id > 0:
            style_obj = _fetch_style(api_url, api_key, style_id)
            if style_obj:
                style_text = style_obj.get("style_text", "")
                negative_prompt = style_obj.get("negative_prompt", "")

        # --- Mode concaténation (use_llm = False) ET mode DÉGRADÉ ---
        # On combine directement les éléments sans passer par le LLM.
        # Le mode dégradé (backend non configuré / injoignable, voir
        # `degrade_notice`) emprunte EXACTEMENT le même chemin : le prompt
        # produit reste utile au workflow, seule la raison est ajoutée dans
        # `ui["warning"]` (jamais dans la sortie `prompt`, qui part vers CLIP).
        def _concat_result(notice=""):
            """Résultat LOCAL (aucun LLM) : base_prompt + éléments + style."""
            raw_parts = [
                p for p in [base_prompt, elems_text, elems_raw, style_text]
                if p and p.strip()
            ]
            local_prompt = _clean_output(", ".join(raw_parts), output_format)
            ui = {"prompt": [local_prompt], "negative_prompt": [negative_prompt]}
            if notice:
                ui["warning"] = [notice]
            return {
                "ui": ui,
                "result": (local_prompt, negative_prompt, llm_config)
            }

        if not use_llm or degrade_notice:
            return _concat_result(degrade_notice)

        # Construire le payload pour /api/enhance
        payload = {
            "text": combined_text,
            "seed": seed if seed > 0 else None,
            "template_id": template_id if template_id > 0 else None,
            "preset_id": preset_id if preset_id > 0 else None,
            "style_id": style_id if style_id > 0 else None,
            "special_instructions": special_instructions,
            "output_format": output_format,
        }
        if image_base64:
            payload["image_base64"] = image_base64

        # num_ctx (taille de la fenêtre de contexte, spécifique Ollama) —
        # passthrough vers le backend depuis le llm_config (JSON du node
        # OpenAI/LM Studio Settings). Le backend ne l'envoie au LLM que si
        # le preset pointe vers Ollama.
        num_ctx = 0
        if llm_config:
            try:
                _cfg = json.loads(llm_config) if isinstance(llm_config, str) else llm_config
                if isinstance(_cfg, dict):
                    num_ctx = int(_cfg.get("num_ctx", 0) or 0)
            except (json.JSONDecodeError, TypeError, ValueError):
                num_ctx = 0
        if num_ctx > 0:
            payload["num_ctx"] = num_ctx

        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        # --- Mode LLM local (llm_config) ---
        # Le node construit lui-même le system prompt et le user prompt (unifiés avec le backend),
        # fetch le template depuis le backend, puis appelle le LLM local.
        if llm_config:
            # Fetch template depuis le backend
            template = None
            if template_id and template_id > 0:
                template = _fetch_template(api_url, api_key, template_id)

            # Construire les prompts unifiés
            system_prompt = _build_system_prompt_unified(template, special_instructions)
            user_prompt = _build_user_prompt_unified(combined_text, "", style_text)

            # Instruction contextuelle quand une image est fournie (mode local LLM)
            if image_base64:
                user_prompt += "\n\n[An image is provided as visual reference. Incorporate relevant visual elements from the image into the enhanced prompt.]"

            enhanced = llm_helper.call_llm(llm_config, system_prompt, user_prompt, seed=seed, image_base64=image_base64)
            if enhanced:
                enhanced = _clean_output(enhanced, output_format)
                return {
                    "ui": {"prompt": [enhanced], "negative_prompt": [negative_prompt]},
                    "result": (enhanced, negative_prompt, llm_config)
                }
            # Fallback sur le backend si le LLM local échoue

        # Mode cloud (defaut) : appel streaming vers /api/enhance
        if not _backend_configured(api_url):
            # Filet de sécurité : le LLM local (`llm_config`) a échoué alors
            # qu'aucun serveur n'est configuré. Un POST vers "/enhance" ne
            # peut pas aboutir (`Invalid URL`) : on rend le résultat LOCAL
            # avec la raison, au lieu d'un prompt « Erreur API : … ».
            notice = (
                "[AIH Enhance] mode dégradé : serveur AIH non configuré "
                "(server_url vide) et LLM local indisponible — "
                "Settings ▸ onglet « AIH · Compte » → concaténation locale des éléments."
            )
            logging.warning(notice)
            return _concat_result(notice)
        try:
            import requests
            r = requests.post(f"{api_url}/enhance",
                              json=payload, headers=headers, stream=True, timeout=(10, 180))
            r.raise_for_status()
            prompt = ""
            neg_prompt = ""
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
                    neg_prompt = chunk.get("negative_prompt", "")
                    break
                elif status == "error":
                    return {
                        "ui": {"prompt": [f"Erreur: {chunk.get('error', '')[:200]}"], "negative_prompt": [""]},
                        "result": (f"Erreur: {chunk.get('error', '')[:200]}", "", llm_config)
                    }
            return {
                "ui": {"prompt": [prompt], "negative_prompt": [neg_prompt]},
                "result": (prompt, neg_prompt, llm_config)
            }
        except ImportError:
            msg = "Erreur: module 'requests' manquant. pip install requests"
            return {
                "ui": {"prompt": [msg], "negative_prompt": [""]},
                "result": (msg, "", llm_config)
            }
        except Exception as e:
            msg = str(e)
            if "401" in msg:
                msg = "Erreur : clé API invalide ou manquante."
            elif "429" in msg:
                msg = "Erreur : rate limit atteint. Attendez un instant."
            else:
                msg = f"Erreur API : {msg}"
            return {
                "ui": {"prompt": [msg], "negative_prompt": [""]},
                "result": (msg, "", llm_config)
            }


# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix).
# Legacy alias keys were removed (user decision): /api/object_info exposes
# one entry PER KEY, so a second alias key made every node appear TWICE in
# the Add Node search. Old workflows referencing the removed keys must be
# redone.
NODE_CLASS_MAPPINGS = {
    "AIHPromptEnhancer": AIHEnhanceNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHPromptEnhancer": "AIH Prompt Enhancer",
}
