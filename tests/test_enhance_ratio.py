# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# ENTRÉE OPTIONNELLE `ratio` du node AIHPromptEnhancer — tests PURS (sans torch).
#
# Contrat verrouillé ici :
#   1. `ratio` est une entrée STRING optionnelle AJOUTÉE EN DERNIER (socket
#      seul, `forceInput`) : l'ordre des widgets existants ne bouge pas, donc
#      les `widgets_values` des workflows enregistrés restent valides ;
#   2. `ratio=""` (ou absent) ⇒ prompt STRICTEMENT identique à l'avant-chantier
#      (comparaison EXACTE du texte envoyé au LLM, chemin local ET payload
#      backend) ;
#   3. `ratio="16:9 (landscape)"` ⇒ la consigne anglaise
#      `Target aspect ratio: 16:9 (landscape) — compose for a wide frame.`
#      est présente dans le TEXTE USER réellement envoyé au modèle, dans les
#      DEUX chemins :
#        - LLM local : `user_prompt` passé à `llm_helper.call_llm` ;
#        - backend `/api/enhance` : `payload['text']` (le backend en fait son
#          `merged_text`, c'est-à-dire le message user) ;
#   4. elle n'est JAMAIS dans le `negative_prompt` ni dans le mode
#      concaténation (`use_llm=False`) ;
#   5. une valeur exotique (`"banane"`) ou multiligne ne casse rien : elle est
#      transmise telle quelle (une seule ligne, sans forme de cadre déduite).
#
# Contrôles négatifs par mutation : /projects/.aih_tmp/ratio_mutate/mutate.py
#
# Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh

import json
import sys
from pathlib import Path

import pytest

PACK_DIR = Path(__file__).resolve().parent.parent
if str(PACK_DIR) not in sys.path:
    sys.path.insert(0, str(PACK_DIR))

from nodes import enhance_node as E  # noqa: E402

WIDE_HINT = "Target aspect ratio: 16:9 (landscape) — compose for a wide frame."


# ═══════════════════════════════ Faux serveur / faux LLM ════════════════════

class _FakeStreamResponse:
    """Réponse streaming minimale de `requests.post` (une ligne `done`)."""

    def __init__(self, output="ENHANCED BY BACKEND", negative="", status_code=200):
        self._output = output
        self._negative = negative
        self.status_code = status_code
        self.ok = True

    def raise_for_status(self):
        return None

    def iter_lines(self):
        yield json.dumps({"status": "done", "output": self._output,
                          "negative_prompt": self._negative}).encode("utf-8")


@pytest.fixture
def wired(monkeypatch):
    """Neutralise les I/O (credentials, templates, styles) et capture les appels."""
    state = {"local": [], "backend": [], "style": 0}

    monkeypatch.setattr(E.credentials, "get_api_url", lambda: "http://aih.test/api")
    monkeypatch.setattr(E.credentials, "get_api_key", lambda: "test-key")
    monkeypatch.setattr(E, "_fetch_template",
                        lambda *a, **k: {"system_prompt": "TEMPLATE SYSTEM RULES",
                                         "examples": ["a red barn at dusk"]})
    monkeypatch.setattr(E, "_fetch_style",
                        lambda *a, **k: {"style_text": "oil painting, textured",
                                         "negative_prompt": "blurry, lowres"})

    def fake_call_llm(config, system_prompt, user_prompt, seed=None, image_base64=None,
                      image_hint=None):
        state["local"].append({"system": system_prompt, "user": user_prompt,
                               "config": config, "seed": seed})
        return "ENHANCED PROMPT"

    monkeypatch.setattr(E.llm_helper, "call_llm", fake_call_llm)

    def fake_post(url, **kwargs):
        state["backend"].append({"url": url, "json": kwargs.get("json")})
        return _FakeStreamResponse(negative="blurry, lowres")

    monkeypatch.setattr("requests.post", fake_post)
    return state


LOCAL_CONFIG = json.dumps({"type": "openai", "base_url": "http://llm.test/v1",
                           "model": "test-model"})


def _run_local(**kwargs):
    """Chemin LLM LOCAL (llm_config fourni) → dict UI/result renvoyé par la node.

    Le system/user prompt réellement envoyés au LLM sont capturés dans
    ``wired["local"][-1]``.
    """
    params = dict(use_llm=True, seed=0, base_prompt="a cat on a sofa", template_id=1,
                  preset_id=0, output_format="rich", style_id=3, style_shortlist="[]",
                  special_instructions="", elements="[]", llm_config=LOCAL_CONFIG,
                  image=None)
    params.update(kwargs)
    return E.AIHEnhanceNode().enhance(**params)


def _run_backend(**kwargs):
    """Chemin BACKEND `/api/enhance` (pas de llm_config) → dict UI/result.

    Le payload JSON posté est capturé dans ``wired["backend"][-1]["json"]``.
    """
    params = dict(use_llm=True, seed=0, base_prompt="a cat on a sofa", template_id=1,
                  preset_id=0, output_format="rich", style_id=3, style_shortlist="[]",
                  special_instructions="", elements="[]", llm_config=None,
                  image=None)
    params.update(kwargs)
    return E.AIHEnhanceNode().enhance(**params)


# ══════════════════════ 1. Déclaration de l'entrée `ratio` ══════════════════

class TestInputDeclaration:
    def test_ratio_is_the_last_optional_input(self):
        inputs = E.AIHEnhanceNode.INPUT_TYPES()
        assert list(inputs["optional"]) == ["image", "elements", "llm_config", "ratio"]

    def test_ratio_is_a_string_socket_without_widget(self):
        spec = E.AIHEnhanceNode.INPUT_TYPES()["optional"]["ratio"]
        assert spec[0] == "STRING"
        assert spec[1]["forceInput"] is True
        # Pas de widget ⇒ aucun `widgets_values` décalé dans les workflows.
        assert spec[1]["default"] == ""

    def test_required_widgets_unchanged(self):
        """Aucun widget déplacé : l'ordre des entrées REQUISES est figé."""
        assert list(E.AIHEnhanceNode.INPUT_TYPES()["required"]) == [
            "use_llm", "seed", "base_prompt", "template_id", "preset_id",
            "output_format", "style_id", "style_shortlist", "special_instructions",
        ]

    def test_outputs_unchanged(self):
        assert E.AIHEnhanceNode.RETURN_TYPES == ("STRING", "STRING", "STRING")
        assert E.AIHEnhanceNode.RETURN_NAMES == ("prompt", "negative_prompt", "llm_config")


# ═══════════════════════ 2. Texte de la consigne (unité) ════════════════════

class TestRatioInstruction:
    @pytest.mark.parametrize("ratio,expected", [
        ("", ""),
        (None, ""),
        ("   ", ""),
        ("16:9 (landscape)", WIDE_HINT),
        ("16:9", "Target aspect ratio: 16:9 — compose for a wide frame."),
        ("9:16 (portrait)", "Target aspect ratio: 9:16 (portrait) — compose for a tall frame."),
        ("1:1 (square)", "Target aspect ratio: 1:1 (square) — compose for a square frame."),
        ("2.39:1 (landscape)",
         "Target aspect ratio: 2.39:1 (landscape) — compose for a wide frame."),
        ("banane", "Target aspect ratio: banane."),
        # Multiligne : aplati sur UNE ligne (la consigne reste lisible).
        (" 16:9 \n (landscape) ", WIDE_HINT),
    ])
    def test_instruction(self, ratio, expected):
        assert E._ratio_instruction(ratio) == expected

    def test_never_raises_on_exotic_inputs(self):
        for value in [0, 1.5, [], {}, True, "16:9:extra", "::"]:
            assert isinstance(E._ratio_instruction(value), str)


# ═══════════════ 3. Chemin LLM LOCAL (llm_helper.call_llm) ══════════════════

class TestLocalLlmPath:
    def test_empty_ratio_leaves_the_prompt_exactly_as_before(self, wired):
        baseline = _run_local()  # `ratio` totalement absent de l'appel
        with_empty = _run_local(ratio="")
        with_blank = _run_local(ratio="   ")

        assert wired["local"][0]["user"] == "a cat on a sofa\n\noil painting, textured"
        assert wired["local"][1]["user"] == wired["local"][0]["user"]
        assert wired["local"][2]["user"] == wired["local"][0]["user"]
        assert with_empty == baseline and with_blank == baseline
        for call in wired["local"]:
            assert "Target aspect ratio" not in call["user"]

    def test_ratio_is_injected_in_the_user_message(self, wired):
        _run_local(ratio="16:9 (landscape)")
        user = wired["local"][-1]["user"]
        # La consigne est ajoutée à la fin du TEXTE (base_prompt + éléments),
        # donc juste avant le texte de style — exactement comme dans le backend
        # (`_build_merged_text` : text, EP, random, style).
        assert user == f"a cat on a sofa\n\n{WIDE_HINT}\n\noil painting, textured"
        assert WIDE_HINT in user

    def test_ratio_is_not_in_the_system_prompt(self, wired):
        _run_local(ratio="16:9 (landscape)")
        system = wired["local"][-1]["system"]
        assert "Target aspect ratio" not in system
        assert "TEMPLATE SYSTEM RULES" in system

    def test_negative_prompt_is_untouched(self, wired):
        result = _run_local(ratio="16:9 (landscape)")
        assert result["result"][1] == "blurry, lowres"
        assert "Target aspect ratio" not in result["result"][1]
        assert "16:9" not in result["result"][1]

    def test_elements_and_ratio_coexist(self, wired):
        _run_local(
            ratio="9:16 (portrait)",
            elements=json.dumps([{"type": "text", "text": "golden light"}]),
        )
        assert wired["local"][-1]["user"] == (
            "a cat on a sofa\n\n[Recherche: golden light]\n\n"
            "Target aspect ratio: 9:16 (portrait) — compose for a tall frame.\n\n"
            "oil painting, textured"
        )

    def test_malformed_ratio_does_not_crash(self, wired):
        result = _run_local(ratio="banane")
        assert "Target aspect ratio: banane." in wired["local"][-1]["user"]
        assert result["result"][0] == "ENHANCED PROMPT"


# ═════════════════ 4. Chemin BACKEND `/api/enhance` (payload) ═══════════════

class TestBackendPath:
    def test_empty_ratio_leaves_the_payload_exactly_as_before(self, wired):
        baseline = _run_backend()
        with_empty = _run_backend(ratio="")

        assert wired["backend"][0]["json"]["text"] == "a cat on a sofa"
        assert wired["backend"][1]["json"]["text"] == "a cat on a sofa"
        assert with_empty == baseline
        for call in wired["backend"]:
            assert "Target aspect ratio" not in json.dumps(call["json"])

    def test_ratio_is_sent_in_the_user_text(self, wired):
        _run_backend(ratio="16:9 (landscape)")
        payload = wired["backend"][0]["json"]
        # `text` devient le `merged_text` du backend, donc le message user.
        assert payload["text"] == f"a cat on a sofa\n\n{WIDE_HINT}"
        assert payload["special_instructions"] == ""
        assert "ratio" not in payload  # jamais un champ ignoré par le backend

    def test_negative_prompt_from_backend_is_untouched(self, wired):
        result = _run_backend(ratio="16:9 (landscape)")
        assert result["result"][1] == "blurry, lowres"
        assert "Target aspect ratio" not in result["result"][1]

    def test_malformed_ratio_is_transmitted_as_is(self, wired):
        _run_backend(ratio="banane")
        assert "Target aspect ratio: banane." in wired["backend"][0]["json"]["text"]


# ══════════════ 5. Mode concaténation (use_llm=False) inchangé ══════════════

class TestConcatMode:
    def test_ratio_is_not_prompt_content(self, wired):
        """La consigne est une instruction LLM, pas du contenu de prompt."""
        baseline = _run_local(use_llm=False, ratio="")
        with_ratio = _run_local(use_llm=False, ratio="16:9 (landscape)")
        assert with_ratio == baseline
        assert with_ratio["result"][0] == "a cat on a sofa, oil painting, textured"
        assert "Target aspect ratio" not in with_ratio["result"][0]
        assert wired["local"] == []  # aucun appel LLM en mode concaténation
