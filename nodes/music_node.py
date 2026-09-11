# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""
AIH Music Node — Node ComfyUI "AIH Music" (MiniMax Music3 caption rewriter).

3 sorties : caption (STRING), lyrics (STRING), duration_seconds (INT).
2 entrées wires-only : musique, lyrics (+ llm_config en forceInput).

Deux modes :
  - MODE CLOUD (défaut) : si llm_config non connecté -> POST /api/music3/generate
    et le backend orchestre le pipeline en 5 étapes.
  - MODE LOCAL : si llm_config connecté -> la node exécute elle-même les 5 étapes
    via llm_helper.call_llm, en miroir exact du pipeline backend. Les system
    prompts des 5 étapes sont importés depuis aih.music_prompts (⚠️ mirror,
    socle partagé du pack fusionné).

DOM widget : web/js/aih_music_widget.js.

Prompts maîtres de référence du pipeline (miroirs documentaires des presets
MiniMax Music 3.0 côté backend) : aih/templates/minimax_music3_*.txt.
"""

import json
import logging
import re

# Socle AIH partagé (bootstrap sys.path fait par le __init__.py racine du pack).
from aih import credentials, llm_helper, music_prompts


# ── Helpers parsing (mirroir des helpers backend) ──────────────────────

def _strip_code_fences(text):
    """Retire les code fences markdown autour d'un bloc JSON. Retourne le texte nu."""
    if not text:
        return text
    s = text.strip()
    m = re.search(r'```(?:json)?\s*([\s\S]+?)\s*```', s)
    if m:
        s = m.group(1).strip()
    return s


def _parse_json_strip(text):
    """Parse un JSON en retirant les code fences. dict|None."""
    if not text:
        return None
    try:
        data = json.loads(_strip_code_fences(text))
        return data if isinstance(data, dict) else None
    except Exception:
        logging.warning("[AIH Music] JSON parse failed")
        return None


def _parse_duration(text):
    """Parse une durée en secondes depuis un texte. 0 si invalide (mirror backend).

    Accepte 'DURATION: N', 'duration: N', ou un simple entier isolé 30..900.
    """
    if not text:
        return 0
    m = re.search(r'DURATION\s*[:=]\s*(\d+)', text, re.IGNORECASE)
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            return 0
    m2 = re.search(r'\bduration\s*[:=]\s*(\d+)', text, re.IGNORECASE)
    if m2:
        try:
            return int(m2.group(1))
        except ValueError:
            return 0
    m3 = re.search(r'(?<!\d)(\d{2,3})(?!\d)', text)
    if m3:
        try:
            val = int(m3.group(1))
        except ValueError:
            return 0
        if 30 <= val <= 900:
            return val
    return 0


def _split_lines(content):
    """Retourne la liste des lignes non vides d'un texte."""
    if not content:
        return []
    return [ln.strip() for ln in content.splitlines() if ln.strip()]


def _is_instrumental(brief, musique=""):
    """Détecte si le morceau est instrumental (pas de voix/chant).

    Sources : description texte, brief (champ vocal / instrumental).
    """
    if musique and re.search(r'\binstrumental\b|no\s+vocal|no\s+sing|instrumental-only|sans\s+voix', musique, re.IGNORECASE):
        return True
    if isinstance(brief, dict):
        if brief.get("instrumental") is True:
            return True
        v = str(brief.get("vocal") or "").lower()
        if v in ("instrumental", "none", "no vocals", "none (instrumental)", "n/a", "absent", "aucune"):
            return True
    return False


class AIHMusicNode:
    CATEGORY = "AIH/Media"
    FUNCTION = "generate"
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # Widget natif seed — reproductibilité (même seed -> même sortie).
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff,
                                    "control_after_generate": "randomize"}),
                # Preset IA backend — sélectionne le model LLM cloud côté serveur.
                # Ne s'applique qu'au MODE CLOUD (llm_config non connecté). En
                # MODE LOCAL, le model vient de llm_config et preset_id est ignoré.
                "preset_id": ("INT", {"default": 0, "min": 0}),
            },
            "optional": {
                # WIRES uniquement — tout est optionnel.
                # PAS de multiline sur les forceInput : comme elements_input, ça
                # force un socket propre et évite le textarea qui chevauche le
                # widget natif seed.
                "musique": ("STRING", {"forceInput": True, "default": ""}),
                "lyrics": ("STRING", {"forceInput": True, "default": ""}),
                "llm_config": ("STRING", {"forceInput": True}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING", "INT")
    RETURN_NAMES = ("caption", "lyrics", "duration_seconds")

    def generate(self, seed=0, preset_id=0, musique="", lyrics="", llm_config=None):
        # api_url / api_key lus depuis le fichier de credentials local
        api_url = credentials.get_api_url()
        api_key = credentials.get_api_key()

        if llm_config:
            return self._generate_local(seed, preset_id, musique, lyrics, llm_config, api_url, api_key)
        return self._generate_cloud(seed, preset_id, musique, lyrics, api_url, api_key)

    # ── MODE CLOUD ──────────────────────────────────────────────────────
    def _generate_cloud(self, seed, preset_id, musique, lyrics, api_url, api_key):
        """Délègue l'orchestration au backend (POST /api/music3/generate).

        preset_id sélectionne le model backend cloud. Ignoré si <=0.
        """
        payload = {"musique": musique or "", "lyrics": lyrics or ""}
        if seed and seed > 0:
            payload["seed"] = int(seed)
        if preset_id and int(preset_id) > 0:
            payload["preset_id"] = int(preset_id)
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        def _err(msg):
            return {
                "ui": {"caption": [msg], "lyrics": [""], "duration": [0]},
                "result": (msg, "", 0),
            }

        try:
            import requests
            r = requests.post(f"{api_url}/music3/generate", json=payload,
                              headers=headers, timeout=(10, 180))
            r.raise_for_status()
            data = r.json()
            c = data.get("caption") or ""
            l = data.get("lyrics") or ""
            try:
                d = int(data.get("duration_seconds") or 0)
            except (TypeError, ValueError):
                d = 0
            return {
                "ui": {"caption": [c], "lyrics": [l], "duration": [d]},
                "result": (c, l, d),
            }
        except ImportError:
            return _err("Erreur: module 'requests' manquant. pip install requests")
        except Exception as e:
            msg = str(e)
            if "401" in msg:
                msg = "Erreur : clé API invalide ou manquante."
            elif "429" in msg:
                msg = "Erreur : rate limit atteint. Attendez un instant."
            else:
                msg = f"Erreur API : {msg}"
            return _err(msg)

    # ── MODE LOCAL ──────────────────────────────────────────────────────
    def _generate_local(self, seed, preset_id, musique, lyrics, llm_config, api_url, api_key):
        """Orchestrateur LOCAL : miroir du pipeline backend (5 étapes).

        preset_id n'est PAS utilisé ici : en mode local le model vient de
        llm_config. Il n'est conservé que pour la cohérence de signature.
        """
        brief = {}
        caption = ""
        final_lyrics = ""
        duration_seconds = 0

        # Etape 1 : brief
        try:
            brief = self._step1_brief(musique, lyrics, llm_config, seed)
        except Exception:
            logging.warning("[AIH Music] step1 (brief) failed")
            brief = {}

        # Etapes 2-4 : routage + sélection + caption
        try:
            router = self._fetch_ref(api_url, api_key, "genre-router.md")
            if router:
                familles = self._step2_route(brief, router, llm_config, seed)
                if familles:
                    index_parts = []
                    for fam in familles:
                        idx = self._fetch_ref(api_url, api_key, f"families/{fam}/index.md")
                        if idx:
                            index_parts.append(f"--- {fam} ---\n{idx}")
                    combined_index = "\n\n".join(index_parts)
                    if combined_index:
                        selected = self._step3_select(brief, combined_index, llm_config, seed)
                        template_parts = []
                        for rel in selected:
                            if not rel:
                                continue
                            t = self._fetch_ref(api_url, api_key, rel)
                            if t:
                                template_parts.append(f"--- {rel} ---\n{t}")
                        templates_text = "\n\n".join(template_parts)
                        caption = self._step4_caption(brief, templates_text, llm_config, seed)
        except Exception:
            logging.exception("[AIH LOCAL] routing pipeline failed, falling back to direct caption")

        # Fallback : pas de routage -> caption direct sans routage
        if not caption:
            try:
                fallback = self._build_fallback_caption(api_url, api_key)
                caption = self._step4_caption(brief, fallback, llm_config, seed)
            except Exception:
                logging.exception("[AIH LOCAL] fallback caption failed")
                caption = ""

        # Etape 5 : durée + paroles
        try:
            duration_seconds, final_lyrics = self._step5_duration_lyrics(
                brief, caption, lyrics, musique, llm_config, seed
            )
        except Exception:
            logging.exception("[AIH LOCAL] step5 (duration/lyrics) failed")
            duration_seconds = 0
            final_lyrics = lyrics if lyrics and lyrics.strip() else ""

        return {
            "ui": {"caption": [caption], "lyrics": [final_lyrics], "duration": [duration_seconds]},
            "result": (caption, final_lyrics, duration_seconds),
        }

    def _fetch_ref(self, api_url, api_key, relpath):
        """GET {api_url}/music3/reference/{relpath} — retourne le texte ou ''.

        Fallback local : si le GET backend échoue (backend down), lit le
        fichier .md depuis le cache local syncé (local_source.read_music_ref_local),
        pour que le mode LOCAL de la node fonctionne offline.
        """
        try:
            import requests
            headers = {}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            r = requests.get(f"{api_url}/music3/reference/{relpath}",
                             headers=headers, timeout=15)
            if r.ok:
                return r.text
        except Exception as e:
            logging.warning(f"[AIH Music] reference fetch failed ({relpath}): {e}")
        # Fallback local (offline) : import try/except, str|None.
        try:
            from aih import local_source
        except Exception:
            local_source = None
        if local_source is not None:
            try:
                content = local_source.read_music_ref_local(relpath)
                if content:
                    return content
            except Exception as e:
                logging.warning(f"[AIH Music] local reference read failed ({relpath}): {e}")
        return ""

    def _call_llm(self, llm_config, system_prompt, user_prompt, seed=0):
        """Wrapper autour de llm_helper.call_llm avec seed contrôlé."""
        return llm_helper.call_llm(
            llm_config, system_prompt, user_prompt,
            seed=seed if seed and seed > 0 else None,
        )

    # Étape 1 — brief structuré
    def _step1_brief(self, musique, lyrics, llm_config, seed=0):
        content = self._call_llm(
            llm_config,
            music_prompts.STEP1_SYSTEM_PROMPT,
            music_prompts.build_step1_user(musique, lyrics),
            seed=seed,
        )
        data = _parse_json_strip(content)
        return data if isinstance(data, dict) else {}

    # Étape 2 — routage vers 1-2 familles
    def _step2_route(self, brief, genre_router_text, llm_config, seed=0):
        content = self._call_llm(
            llm_config,
            music_prompts.build_step2_system(genre_router_text),
            music_prompts.build_step2_user(brief),
            seed=seed,
        )
        return _split_lines(content)

    # Étape 3 — sélection <=3 templates
    def _step3_select(self, brief, family_index_text, llm_config, seed=0):
        content = self._call_llm(
            llm_config,
            music_prompts.STEP3_SYSTEM_PROMPT,
            music_prompts.build_step3_user(brief, family_index_text),
            seed=seed,
        )
        return _split_lines(content)[:3]

    # Étape 4 — caption text (temp basse)
    def _step4_caption(self, brief, templates_text, llm_config, seed=0):
        # appel direct LLM avec temperature plus basse via config max conservé
        content = llm_helper.call_llm(
            llm_config,
            music_prompts.build_step4_system(templates_text),
            music_prompts.build_step4_user(brief),
            seed=seed if seed and seed > 0 else None,
        )
        return content or ""

    # Étape 5 — durée + paroles
    def _step5_duration_lyrics(self, brief, caption, user_lyrics, musique, llm_config, seed=0):
        duration = 0
        lyrics = ""
        user = music_prompts.build_step5_user(brief, caption)
        instrumental = _is_instrumental(brief, musique)
        # Toujours estimer la durée via un appel LLM dédié (brief + caption).
        try:
            dur_content = self._call_llm(
                llm_config, music_prompts.STEP5_DURATION_SYSTEM_PROMPT, user, seed=seed
            ) or ""
            duration = _parse_duration(dur_content)
        except Exception:
            logging.warning("[AIH LOCAL] step5 duration estimation failed")
            duration = 0
        # Paroles : si instrumental, on génère une structure sans sections vocales.
        if instrumental:
            try:
                content = self._call_llm(
                    llm_config,
                    music_prompts.STEP5_INSTRUMENTAL_LYRICS_SYSTEM_PROMPT,
                    user,
                    seed=seed,
                ) or ""
                lyrics = content.strip()
            except Exception:
                logging.warning("[AIH LOCAL] step5 instrumental lyrics failed")
                lyrics = "[Instrumental]"
        elif user_lyrics and user_lyrics.strip():
            # Paroles fournies : on les conserve telles quelles.
            lyrics = user_lyrics
        else:
            try:
                content = self._call_llm(
                    llm_config, music_prompts.STEP5_LYRICS_SYSTEM_PROMPT, user, seed=seed
                ) or ""
                content = re.sub(
                    r'^DURATION\s*[:=]\s*\d+.*$', '', content,
                    flags=re.MULTILINE | re.IGNORECASE,
                ).strip()
                lyrics = content
            except Exception:
                logging.warning("[AIH LOCAL] step5 lyrics generation failed")
                lyrics = ""
        return duration, lyrics

    # Fallback sans routage : liste les fichiers du cache comme templates.
    def _build_fallback_caption(self, api_url, api_key):
        files = self._fetch_manifest(api_url, api_key)
        if not files:
            return "No reference templates available in cache."
        lines = ["# Available reference templates", ""]
        for f in files[:10]:
            content = self._fetch_ref(api_url, api_key, f)
            if content:
                lines.append(f"## {f}\n{content[:2000]}")
        return "\n\n".join(lines)

    def _fetch_manifest(self, api_url, api_key):
        """GET /api/music3/manifest — retourne la liste des fichiers .md."""
        try:
            import requests
            headers = {}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            r = requests.get(f"{api_url}/music3/manifest", headers=headers, timeout=15)
            if r.ok:
                data = r.json()
                if isinstance(data, dict):
                    return data.get("files") or []
        except Exception as e:
            logging.warning(f"[AIH Music] manifest fetch failed: {e}")
        return []


# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix);
# the legacy pre-fusion key stays as an alias pointing to the SAME class so
# existing workflows keep loading. Legacy aliases are never purged.
NODE_CLASS_MAPPINGS = {
    "AIHMusic": AIHMusicNode,
    # Legacy alias - never purge.
    "AIHMusicNode": AIHMusicNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHMusic": "AIH Music",
    "AIHMusicNode": "AIH Music",
}
