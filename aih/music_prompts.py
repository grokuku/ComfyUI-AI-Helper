# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""
music_prompts — System prompts & builders du pipeline "AIH Music" (5 étapes).

Centralise le MIRROR entre le node ComfyUI (mode LOCAL) et le backend
(backend/routes/music3.py, mode CLOUD). Les 5 system prompts ci-dessous
DOIVENT être identiques aux constantes du backend pour que les deux modes
produisent le même résultat.

⚠️ mirror: routes/music3.py
"""

import json

# ⚠️ mirror: routes/music3.py — STEP1_SYSTEM_PROMPT
STEP1_SYSTEM_PROMPT = (
    "parse a music description and optional lyrics into a structured brief JSON "
    "with keys: macro_genre, mood, tempo, vocal, instruments, sections, exclusions"
)

# ⚠️ mirror: routes/music3.py — STEP2_SYSTEM_PROMPT
STEP2_SYSTEM_PROMPT = (
    "select 1-2 style family names from the router. "
    "Return ONLY the family names, one per line."
)

# ⚠️ mirror: routes/music3.py — STEP3_SYSTEM_PROMPT
STEP3_SYSTEM_PROMPT = (
    "given the family index, select up to 3 template files with distinct roles "
    "(e.g. one for vocals, one for arrangement, one for production). "
    "Return ONLY relative file paths, one per line."
)

# ⚠️ mirror: routes/music3.py — STEP4_SYSTEM_PROMPT
STEP4_SYSTEM_PROMPT = (
    "Write a 'Music 3.0 Structured Caption' for the given music brief, using the "
    "provided reference templates as style guidance. The caption MUST have exactly "
    "3 sections:\n"
    "1. Global Metadata (genre, subgenre, tempo, emotional progression, production profile)\n"
    "2. Vocal Details (lead, timbre, register, delivery, harmony/backing)\n"
    "3. Arrangement (section-by-section timeline, instrument lifecycles, transitions)\n"
    "Return only the structured caption."
)

# ⚠️ mirror: routes/music3.py — STEP5_LYRICS_SYSTEM_PROMPT
STEP5_LYRICS_SYSTEM_PROMPT = (
    "You are a lyricist. Write original structured song lyrics matching the given "
    "music brief and caption.\n"
    "RULES:\n"
    "- Use ONLY the recognized MiniMax section tags: [Intro], [Verse], [Pre-Chorus], "
    "[Chorus], [Bridge], [Outro].\n"
    "- Output ONLY the section tags and the sung lyric lines. Do NOT include any "
    "bracketed annotations such as [Vocal: ...], [Arrangement: ...], [Mood: ...], "
    "[Break: ...]. All vocal/arrangement/mood details already live in the caption.\n"
    "- Each section tag goes on its own line, followed by the sung lines for that "
    "section.\n"
    "- Return only the lyrics."
)

# ⚠️ mirror: routes/music3.py — STEP5_DURATION_SYSTEM_PROMPT
STEP5_DURATION_SYSTEM_PROMPT = (
    "You are a music producer estimating song length. Given the music brief and the "
    "structured caption (tempo, number of sections, arrangement complexity), estimate "
    "the total duration in seconds. A standard pop song is 150-240s, an instrumental or "
    "ambient piece may be 120-300s, an EDM build 200-300s, a short jingle 30-60s.\n"
    "Return ONLY an integer number of seconds (e.g. 180). No other text."
)

# ⚠️ mirror: routes/music3.py — STEP5_INSTRUMENTAL_LYRICS_SYSTEM_PROMPT
# Structure lyrics pour un morceau INSTRUMENTAL : uniquement des tags [Instrumental],
# AUCUN [Verse]/[Chorus] (sections vocales qui feraient chanter MiniMax).
STEP5_INSTRUMENTAL_LYRICS_SYSTEM_PROMPT = (
    "You are structuring the lyrics field for a fully INSTRUMENTAL MiniMax Music 3.0 "
    "track (no vocals at all). Use ONLY the section tags [Intro], [Instrumental], and "
    "[Outro]. Do NOT use [Verse], [Pre-Chorus], [Chorus], [Bridge], or any vocal-only "
    "section tag. Do NOT write any sung text.\n"
    "Output only the bracketed structure, one tag per line. Put an [Instrumental] tag "
    "for each musical section implied by the brief/caption (typically 4-8 sections). "
    "Begin with [Intro] and end with [Outro]."
)


# ── Builders (construction des prompts identiques au backend) ──────────
# Les prompts system/user assemblés par ces builders répliquent exactement la
# construction côté backend (routes/music3.py). Chaque étape du mode LOCAL
# appelle le builder correspondant avant de faire son appel llm_helper.call_llm.

def build_step1_user(musique, lyrics):
    """User prompt étape 1 : description + lyrics (si fournie)."""
    user = musique
    if lyrics and lyrics.strip():
        user = f"{musique}\n\nLyrics:\n{lyrics}"
    return user


def build_step2_system(genre_router_text):
    """System prompt étape 2 : genre-router.md + sélection de familles."""
    return f"{genre_router_text}\n\n{STEP2_SYSTEM_PROMPT}"


def build_step2_user(brief):
    """User prompt étape 2 : brief sérialisé."""
    return json.dumps(brief, ensure_ascii=False)


def build_step3_user(brief, family_index_text):
    """User prompt étape 3 : brief + index de famille."""
    return (
        f"Brief:\n{json.dumps(brief, ensure_ascii=False)}\n\n"
        f"Family index:\n{family_index_text}"
    )


def build_step4_system(templates_text):
    """System prompt étape 4 : templates de référence injectés."""
    return f"{STEP4_SYSTEM_PROMPT}\n\nReference templates:\n{templates_text}"


def build_step4_user(brief):
    """User prompt étape 4 : brief sérialisé."""
    return json.dumps(brief, ensure_ascii=False)


def build_step5_user(brief, caption):
    """User prompt étape 5 : brief + caption pour génération des paroles."""
    return (
        f"Brief:\n{json.dumps(brief, ensure_ascii=False)}\n\n"
        f"Caption:\n{caption}"
    )
