# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""
AIH Elements Picker Node — Custom widget (JavaScript).
L'UI interactive est rendue par web/js/aih_elements_widget.js.

Au "Run" (workflow), Python appelle directement l'API /api/generate
avec le seed courant + les éléments sérialisés → résultat déterministe.
Au "Test generation", JS appelle l'API pour un aperçu instantané.

Mode "intelligent" LLM :
  - Syntaxe ||concept:N dans une liste → liste générée par LLM
  - 🧠 ON sur une liste manuelle → filtrage LLM par contexte
  - Appel POST /api/keywords/llm-process (preset_id, instruction, input_text)
  - Traitement séquentiel avec accumulation de contexte

Format des listes manuelles :
  - {bleu::rouge::vert} → un bloc de choix, random dedans
  - femme de {25::30::35::40} ans → template avec bloc inline
  - {blond::brun} cheveux {long::court} → multiples blocs indépendants
  - Texte hors {} = littéral, retourné tel quel
"""

import json
import logging
import random
import re

# Socle AIH partagé (bootstrap sys.path fait par le __init__.py racine du pack).
from aih import credentials, llm_helper


def _hash32(s):
    """FNV-1a 32-bit hash, identique a la fonction hash32() du widget JS."""
    h = 0x811c9dc5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xffffffff
    return h


def _parse_concept_syntax(text, default_count=10):
    """Parse ||concept[:count][;hint[:count]] syntax.
    Returns (concept, count, hint) or None if not a concept syntax.

    Supported forms:
        ||color                  → concept="color", count=default, hint=None
        ||color:20               → concept="color", count=20,    hint=None
        ||color;hair color       → concept="color", count=default, hint="hair color"
        ||color:20;hair color    → concept="color", count=20,    hint="hair color"
        ||color;hair color:20    → concept="color", count=20,    hint="hair color"
    """
    if not text or not text.startswith('||'):
        return None
    body = text[2:].strip()
    if not body:
        return None

    # Split by first ; to separate concept part from hint part
    if ';' in body:
        concept_part, hint_part = body.split(';', 1)
    else:
        concept_part, hint_part = body, None

    # Parse concept_part: concept[:count]
    concept = concept_part.strip()
    count = None
    if ':' in concept_part:
        parts = concept_part.rsplit(':', 1)
        if parts[1].strip().isdigit():
            concept = parts[0].strip()
            count = int(parts[1].strip())

    # Parse hint_part: hint[:count]
    hint = None
    if hint_part:
        hint = hint_part.strip()
        if ':' in hint_part:
            parts = hint_part.rsplit(':', 1)
            if parts[1].strip().isdigit():
                hint = parts[0].strip()
                if count is None:
                    count = int(parts[1].strip())

    if count is None:
        count = default_count

    return (concept, count, hint)


# Regex pour trouver les blocs {choix1::choix2::...}
_BRACE_BLOCK_RE = re.compile(r'\{([^}]+)\}')


def _extract_brace_blocks(text):
    """Extrait tous les blocs {a::b::c} du texte.

    Retourne une liste de tuples (match_obj, [choix1, choix2, ...]).
    Si aucun bloc {} n'est trouvé, retourne une liste vide.
    """
    blocks = []
    for m in _BRACE_BLOCK_RE.finditer(text):
        content = m.group(1)
        choices = [c.strip() for c in content.split("::") if c.strip()]
        blocks.append((m, choices))
    return blocks


def _resolve_braces(text, seed, element_index):
    """Résout tous les blocs {a::b::c} dans le texte.

    Pour chaque bloc, choisit une option (déterministe par seed si seed > 0,
    sinon aléatoire) et remplace le bloc par le choix dans le texte.
    Le texte hors {} est retourné littéral.
    Si aucun bloc {} trouvé, retourne le texte tel quel.
    """
    if not text:
        return ""

    blocks = _extract_brace_blocks(text)
    if not blocks:
        return text

    result = text
    for m, choices in blocks:
        if not choices:
            continue
        if len(choices) == 1:
            chosen = choices[0]
        elif seed <= 0:
            chosen = random.choice(choices)
        else:
            h = _hash32(f"{seed}|{element_index}|{m.group(0)}")
            chosen = choices[h % len(choices)]
        result = result.replace(m.group(0), chosen, 1)

    return result


def _resolve_braces_with_filtered(text, seed, element_index, filtered_choices):
    """Résout les blocs {} en utilisant uniquement les choix filtrés par le LLM.

    Pour chaque bloc, intersecte ses choix avec filtered_choices.
    Si l'intersection est non vide, pick dedans. Sinon, fallback random
    dans les choix originaux du bloc.
    """
    if not text:
        return ""

    blocks = _extract_brace_blocks(text)
    if not blocks:
        return text

    filtered_set = set(c.strip() for c in filtered_choices)
    result = text
    for m, choices in blocks:
        if not choices:
            continue
        # Intersection des choix du bloc avec les choix filtrés
        valid = [c for c in choices if c in filtered_set]
        if not valid:
            # Fallback: utiliser tous les choix originaux du bloc
            valid = choices
        if len(valid) == 1:
            chosen = valid[0]
        elif seed <= 0:
            chosen = random.choice(valid)
        else:
            h = _hash32(f"{seed}|{element_index}|{m.group(0)}")
            chosen = valid[h % len(valid)]
        result = result.replace(m.group(0), chosen, 1)

    return result


def _pick_from_list(items, seed, element_index, raw_text):
    """Choisit un élément dans une liste. Déterministe si seed > 0, sinon random."""
    if not items:
        return ""
    if seed <= 0:
        return random.choice(items)
    h = _hash32(f"{seed}|{element_index}|{raw_text}")
    return items[h % len(items)]


def _call_llm_process(api_url, api_key, preset_id, instruction, input_text=""):
    """Appelle POST /api/keywords/llm-process.

    Retourne le texte output (str) ou None si erreur/timeout/réponse vide.
    """
    try:
        import requests
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        }
        body = {
            "preset_id": preset_id,
            "instruction": instruction,
            "input_text": input_text,
        }
        r = requests.post(
            f"{api_url}/keywords/llm-process",
            json=body,
            headers=headers,
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        output = data.get("output", "")
        return output if output else None
    except Exception as e:
        logging.warning(f"[AIH Elements] LLM call failed: {e}")
        return None


def _parse_llm_list(output_text):
    """Parse une sortie LLM en liste d'éléments avec robustesse contre les murs de texte."""
    if not output_text:
        return []

    # 1. Remplacer tout séparateur (virgule, point-virgule, pipe) par des retours à la ligne
    cleaned = output_text.replace(',', '\n').replace(';', '\n').replace('|', '\n')

    # 2. Supprimer les listes numérotées ("1.", "2)") et les puces ("-", "*")
    cleaned = re.sub(r'\d+[\.)]\s*', '\n', cleaned)
    cleaned = re.sub(r'[-*•]\s+', '\n', cleaned)

    items = []
    for line in cleaned.split('\n'):
        item = line.strip()
        # Supprimer le Markdown résiduel
        item = re.sub(r'[\*\_\#\`\~"]', '', item).strip()

        if not item or item.isdigit():
            continue

        # 3. SECURITÉ : Si le modèle a recraché 50 mots à la suite séparés par de simples espaces,
        # la ligne sera très longue. On la découpe mot par mot de force.
        if item.count(' ') > 5 and len(item) > 40:
            words = [w.strip() for w in item.split(' ') if w.strip()]
            items.extend(words)
        else:
            items.append(item)

    return items


# Consignes explicites optimisées pour que les petits modèles fassent des listes verticales
STRICT_ENGLISH_FORMAT = (
    " Respond ONLY in English. Return EXACTLY one distinct short option per line. "
    "Do NOT include numbers, bullet points, or commas. Just the text, one per line."
)


class AIHElementsNode:
    CATEGORY = "AIH/Prompting"
    FUNCTION = "generate"
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff,
                 "control_after_generate": "randomize"}),
                # JSON sérialisé par le JS : elements + random_count
                # REQUIRED (APRÈS seed) : les widgets required sont sérialisés
                # dans widgets_values par la frontend (issue #3616), les optional
                # ne le sont plus → sans ça, les éléments seraient perdus à la sauvegarde.
                # Masqué dans l'UI ComfyUI
                "_elements_json": ("STRING", {"default": "{}", "multiline": True}),
            },
            "optional": {
                # PREMIER dans optional → socket EN HAUT (au-dessus de llm_config).
                # forceInput : permet de connecter un upstream (STRING). La valeur
                # peut être None si l'upstream renvoie une sortie vide → durci dans generate().
                "elements_input": ("STRING", {"default": "", "forceInput": True}),        # forceInput, PAS multiline
                "llm_config": ("STRING", {"default": "", "forceInput": True}),  # nom d'origine
            }
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("elements", "llm_config")

    def generate(self, seed, _elements_json="{}", elements_input="", llm_config=None):
        try:
            elems_cfg = json.loads(_elements_json) if _elements_json else {}
        except json.JSONDecodeError:
            msg = "Erreur : config JSON invalide"
            return {
                "ui": {"elements": [msg]},
                "result": ("", llm_config)
            }

        # api_key et api_url lus depuis le fichier de credentials
        api_url = credentials.get_api_url()
        api_key = credentials.get_api_key()

        # elements_input peut être None si un fil upstream renvoie une sortie vide/None
        elements_input = elements_input or ""

        elements = elems_cfg.get("elements", [])
        random_count = int(elems_cfg.get("random_count", 0))

        # --- Mode intelligent LLM ---
        preset_id = int(elems_cfg.get("preset_id", 0) or 0)
        llm_default_count = int(elems_cfg.get("llm_default_count", 10) or 10)
        brain_toggles = elems_cfg.get("brain_toggles", [])

        # Filtrer les entrees marquees visible=False (masquees depuis l'UI)
        elements = [el for el in elements if el.get("visible") is not False]

        # Resoudre les blocs {a::b::c} et les listes LLM "||" dans les textes raw/texte.
        # Traitement séquentiel : le contexte accumule les mots-clés choisis dans les
        # listes précédentes pour les appels LLM avec 🧠 ON.
        # Contexte initial pour le LLM (chaînage avec une autre node EP)
        context = []
        if elements_input and elements_input.strip():
            context.append(elements_input.strip())

        indices_to_skip = set()  # indices d'éléments LLM à skip (liste vide)

        for i, el in enumerate(elements):
            if el.get("type") not in ("raw", "text"):
                continue

            raw_text = el.get("text", "")
            if not raw_text:
                continue

            brain_on = (
                bool(brain_toggles[i])
                if isinstance(brain_toggles, list) and i < len(brain_toggles)
                else False
            )

            # --- Détection syntaxe ||concept[:count][;hint[:count]] ---
            parsed = _parse_concept_syntax(raw_text.strip(), llm_default_count)

            if parsed:
                concept, count, hint = parsed

                # preset_id == 0 → pas de LLM backend disponible
                # (sauf si llm_config externe fournie)
                if preset_id == 0 and not llm_config:
                    indices_to_skip.add(i)
                    continue

                # Construire instruction et input_text selon 🧠 ON/OFF
                if brain_on:
                    instruction = f"Generate {count} distinct options for '{concept}' matching the context." + STRICT_ENGLISH_FORMAT
                    input_text = (
                        f"Contexte: [{', '.join(context)}]" if context else ""
                    )
                else:
                    instruction = f"Generate {count} distinct options for '{concept}'." + STRICT_ENGLISH_FORMAT
                    input_text = ""

                if llm_config:
                    # Config LLM externe (LM Studio ou OpenAI)
                    output = llm_helper.call_llm(llm_config, instruction, input_text, seed=seed)
                    items = _parse_llm_list(output) if output else []
                else:
                    # Backend existant (comportement actuel)
                    output = _call_llm_process(
                        api_url, api_key, preset_id, instruction, input_text
                    )
                    items = _parse_llm_list(output) if output else []
                if items:
                    chosen_keyword = _pick_from_list(items, seed, i, raw_text)
                    if hint:
                        chosen_text = f"{hint}: {chosen_keyword}"
                    else:
                        chosen_text = chosen_keyword
                    el["text"] = chosen_text
                    context.append(chosen_text)
                else:
                    # Fallback LLM ||: skip (liste vide)
                    indices_to_skip.add(i)
                continue

            # --- Liste manuelle avec blocs {a::b::c} ou texte littéral ---
            blocks = _extract_brace_blocks(raw_text)
            has_braces = len(blocks) >= 1

            if has_braces and brain_on and (preset_id != 0 or llm_config):
                # 🧠 ON + liste manuelle avec {} → filtrage LLM par contexte
                # Concaténer tous les choix de tous les blocs
                all_choices = []
                for _, choices in blocks:
                    all_choices.extend(choices)

                instruction = "Filter this list to keep only elements consistent with the context." + STRICT_ENGLISH_FORMAT
                input_text = f"Context: [{', '.join(context)}]\nList: [{', '.join(all_choices)}]"

                if llm_config:
                    # Config LLM externe (LM Studio ou OpenAI)
                    output = llm_helper.call_llm(llm_config, instruction, input_text, seed=seed)
                    filtered = _parse_llm_list(output) if output else []
                else:
                    # Backend existant (comportement actuel)
                    output = _call_llm_process(
                        api_url, api_key, preset_id, instruction, input_text
                    )
                    filtered = _parse_llm_list(output) if output else []
                if filtered:
                    el["text"] = _resolve_braces_with_filtered(
                        raw_text, seed, i, filtered
                    )
                    context.append(el["text"])
                    continue
                else:
                    logging.warning(
                        "[AIH Elements] LLM filter returned empty or failed, "
                        "falling back to random"
                    )
                # Fallback: random dans les blocs d'origine
                el["text"] = _resolve_braces(raw_text, seed, i)
                context.append(el["text"])
            else:
                # Comportement standard (déterministe par seed)
                # Sans {} → texte littéral retourné tel quel
                el["text"] = _resolve_braces(raw_text, seed, i)
                if el["text"]:
                    context.append(el["text"])

        # Retirer les éléments LLM qui n'ont pas pu être générés (listes vides)
        if indices_to_skip:
            elements = [
                el for i, el in enumerate(elements) if i not in indices_to_skip
            ]

        # --- Injecter elements_input comme élément réel dans la payload ---
        # Bug #1 & #2 : elements_input était seulement dans le context LLM,
        # jamais dans le payload final. Il faut l'ajouter comme un élément raw
        # pour qu'il soit :
        #   - inclus dans la sortie finale (Bug #2 : contenu pas utilisé)
        #   - traité à une position fixe, sans décaler l'ordre des autres
        #     éléments via le context LLM (Bug #1 : ordre qui change quand vide)
        if elements_input and elements_input.strip():
            elements.insert(0, {
                "type": "raw",
                "text": elements_input.strip(),
                "visible": True,
            })

        # Vérifier qu'il y a du contenu à générer
        if not elements and random_count <= 0:
            return {
                "ui": {"elements": ["⚠️ Aucun filtre sélectionné. Ajoutez des filtres dans la liste."]},
                "result": ("", llm_config)
            }

        # Construire le payload pour /api/generate
        payload = {"elements": elements}
        if seed > 0:
            payload["seed"] = seed
        if random_count > 0:
            payload["random_count"] = random_count
            payload["random_sfw"] = bool(elems_cfg.get("random_sfw", True))
            payload["random_nsfw"] = bool(elems_cfg.get("random_nsfw", False))

        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        # Construire un prompt de secours depuis les éléments locaux (au cas où l'API échoue)
        final_list = [el.get("text", "").strip() for el in elements if el.get("text", "").strip()]
        final_prompt = ", ".join(final_list)
        final_prompt = re.sub(r'\s*,\s*', ', ', final_prompt)
        final_prompt = re.sub(r',+', ',', final_prompt).strip(' ,')

        try:
            import requests
            r = requests.post(f"{api_url}/generate", json=payload, headers=headers, timeout=30)
            r.raise_for_status()
            data = r.json()
            prompt = data.get("prompt", final_prompt)  # fallback à final_prompt si "prompt" absent

            if prompt:
                prompt = re.sub(r'\s*,\s*', ', ', prompt)
                prompt = re.sub(r',+', ',', prompt).strip(' ,')

            return {
                "ui": {"elements": [prompt]},
                "result": (prompt, llm_config)
            }
        except Exception:
            # Fallback silencieux : utiliser le prompt construit localement
            return {
                "ui": {"elements": [final_prompt]},
                "result": (final_prompt, llm_config)
            }

# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix);
# the legacy pre-fusion key stays as an alias pointing to the SAME class so
# existing workflows keep loading. Legacy aliases are never purged.
NODE_CLASS_MAPPINGS = {
    "AIHElementsPicker": AIHElementsNode,
    # Legacy alias - never purge.
    "AIHElementsNode": AIHElementsNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHElementsPicker": "AIH Elements Picker",
    "AIHElementsNode": "AIH Elements Picker",
}
