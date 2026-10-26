"""Node AIH Prompt Enhancer — DÉGRADER au lieu de PLANTER (backend injoignable).

BUG RÉEL (worker Modal, log utilisateur) : sans ``server_url``, le node levait

    ValueError: template_id requis en mode cloud — définissez un template (widget)

et cassait TOUT le prompt du workflow — y compris la partie locale
(base_prompt + éléments) qui n'a besoin d'aucun serveur. Le même rendu affichait
``Invalid URL '/styles': No scheme supplied`` (fetch de style voué à l'échec).

Contrat verrouillé ici :

  1. backend NON configuré (``api_url`` vide) ou cloud sans template ⇒ la node
     N'ÉCHOUE PAS : elle renvoie la concaténation LOCALE des éléments
     (exactement le résultat de ``use_llm=False``) ;
  2. la RAISON est remontée dans ``ui["warning"]`` (affichée par
     ``js/aih_enhance_widget.js``) et écrite dans le log — une vraie erreur de
     configuration reste donc VISIBLE et explicite, pas masquée ;
  3. la sortie ``prompt`` (qui part vers CLIP) n'est JAMAIS polluée par le
     message de dégradation ;
  4. aucun appel réseau n'est tenté vers une URL relative (pas de bruit
     « Invalid URL » à répétition) ;
  5. le comportement normal (backend configuré + template) est INCHANGÉ.

Mutants (assertions qui deviennent ROUGES) :
  M1 rétablir ``raise ValueError(...)`` ⇒ §1/§2 rouges ;
  M2 mettre le message dans ``result[0]`` au lieu de ``ui["warning"]`` ⇒ §3 rouge ;
  M3 appeler quand même le backend à URL vide ⇒ §4 rouge (le faux ``requests``
     enregistre l'appel).

Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
"""

import json
import sys
from pathlib import Path

import pytest

PACK_DIR = Path(__file__).resolve().parent.parent
if str(PACK_DIR) not in sys.path:
    sys.path.insert(0, str(PACK_DIR))

from nodes import enhance_node as E  # noqa: E402

LOCAL_CONFIG = json.dumps({"type": "openai", "base_url": "http://llm.test/v1",
                           "model": "test-model"})


class _FakeStreamResponse:
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
def calls(monkeypatch):
    """Capture POST backends + LLM local, sans toucher au réseau."""
    state = {"backend": [], "local": []}

    def fake_post(url, **kwargs):
        state["backend"].append({"url": url, "json": kwargs.get("json")})
        return _FakeStreamResponse()

    def fake_call_llm(config, system_prompt, user_prompt, seed=None,
                      image_base64=None, image_hint=None):
        state["local"].append({"user": user_prompt})
        return "ENHANCED BY LOCAL LLM"

    monkeypatch.setattr("requests.post", fake_post)
    monkeypatch.setattr(E.llm_helper, "call_llm", fake_call_llm)
    return state


def _run(**kwargs):
    params = dict(
        use_llm=True, seed=0, base_prompt="a cat on a sofa", template_id=0,
        preset_id=0, output_format="rich", style_id=0, style_shortlist="[]",
        special_instructions="", elements="a hat, a cape", llm_config=None,
        image=None,
    )
    params.update(kwargs)
    return E.AIHEnhanceNode().enhance(**params)


# ═════════════ 1. Backend non configuré : on DÉGRADE, on ne plante pas ══════


class TestNoServerDegrades:
    def test_does_not_raise_and_produces_local_prompt(self, monkeypatch, calls):
        """MUTANT M1 : ``raise ValueError`` ici ⇒ ce test devient ROUGE."""
        monkeypatch.setattr(E.credentials, "get_api_url", lambda: "")
        monkeypatch.setattr(E.credentials, "get_api_key", lambda: "")

        out = _run()  # ne doit PAS lever

        assert out["result"][0], "la sortie `prompt` doit rester utile au workflow"
        assert out["result"][0] == "a cat on a sofa, a hat, a cape", \
            "le mode dégradé produit la MÊME concaténation locale que use_llm=False"

    def test_warning_explains_why_in_ui(self, monkeypatch, calls):
        monkeypatch.setattr(E.credentials, "get_api_url", lambda: "")
        monkeypatch.setattr(E.credentials, "get_api_key", lambda: "")

        out = _run()

        warnings = out["ui"].get("warning")
        assert warnings, "MUTANT M1 : la raison doit être remontée dans ui['warning']"
        message = warnings[0]
        assert "dégradé" in message
        assert "server_url vide" in message, "le message doit nommer la CAUSE"
        assert "AIH · Compte" in message, "et l'endroit où la corriger"

    def test_ui_warning_does_not_pollute_the_prompt(self, monkeypatch, calls):
        """MUTANT M2 : message dans `prompt` ⇒ ce test devient ROUGE."""
        monkeypatch.setattr(E.credentials, "get_api_url", lambda: "")
        monkeypatch.setattr(E.credentials, "get_api_key", lambda: "")

        out = _run()

        assert "dégradé" not in out["result"][0]
        assert "⚠" not in out["result"][0]
        assert "dégradé" not in out["ui"]["prompt"][0], \
            "ui['prompt'] reflète la SORTIE réelle (le widget l'affiche)"

    def test_no_relative_url_request_is_attempted(self, monkeypatch, calls):
        """MUTANT M3 : POST vers '/enhance' ⇒ ce test devient ROUGE."""
        monkeypatch.setattr(E.credentials, "get_api_url", lambda: "")
        monkeypatch.setattr(E.credentials, "get_api_key", lambda: "")

        _run(template_id=0)

        assert calls["backend"] == [], \
            "aucune requête vers une URL relative ('Invalid URL … No scheme supplied')"

    def test_style_fetch_is_not_attempted_without_server(self, monkeypatch):
        """Le fetch de style s'arrête AVANT toute requête (pas de « Invalid URL »)."""
        monkeypatch.setattr(E.credentials, "get_api_url", lambda: "")
        monkeypatch.setattr(E.credentials, "get_api_key", lambda: "")

        def boom(*_a, **_k):  # pragma: no cover - ne doit jamais être appelé
            raise AssertionError("requête réseau tentée sans serveur configuré")
        monkeypatch.setattr("requests.get", boom)

        out = _run(style_id=3)

        assert out["result"][0] == "a cat on a sofa, a hat, a cape"
        assert "negative_prompt" in out["ui"]

    def test_random_style_does_not_hit_the_network(self, monkeypatch, calls):
        monkeypatch.setattr(E.credentials, "get_api_url", lambda: "")
        monkeypatch.setattr(E.credentials, "get_api_key", lambda: "")

        _run(style_id=-1)

        assert calls["backend"] == []

    def test_log_carries_the_reason(self, monkeypatch, calls, caplog):
        monkeypatch.setattr(E.credentials, "get_api_url", lambda: "")
        monkeypatch.setattr(E.credentials, "get_api_key", lambda: "")

        with caplog.at_level("WARNING"):
            _run()

        assert "mode dégradé" in caplog.text


# ══════════ 2. Cloud SANS template mais serveur configuré : dégradé aussi ═══


class TestMissingTemplateDegrades:
    def test_template_required_is_no_longer_fatal(self, monkeypatch, calls):
        monkeypatch.setattr(E.credentials, "get_api_url", lambda: "http://aih.test/api")
        monkeypatch.setattr(E.credentials, "get_api_key", lambda: "k")

        out = _run(template_id=0)  # plus de ValueError

        assert out["result"][0] == "a cat on a sofa, a hat, a cape"
        message = out["ui"]["warning"][0]
        assert "template_id requis" in message, "l'erreur de configuration reste NOMMÉE"
        assert calls["backend"] == [], "inutile d'appeler un backend qui refusera (400)"

    def test_real_key_is_not_masked_by_the_degradation(self, monkeypatch, calls):
        """Contrôle négatif : une erreur réelle n'est pas avalée en silence."""
        monkeypatch.setattr(E.credentials, "get_api_url", lambda: "http://aih.test/api")
        monkeypatch.setattr(E.credentials, "get_api_key", lambda: "k")

        out = _run(template_id=0)

        assert out["ui"]["warning"][0].startswith("[AIH Enhance] mode dégradé")


# ═══════════════ 3. Chemins NORMAUX : aucun changement de comportement ══════


class TestNormalPathsUnchanged:
    def test_backend_path_still_used_when_configured(self, monkeypatch, calls):
        monkeypatch.setattr(E.credentials, "get_api_url", lambda: "http://aih.test/api")
        monkeypatch.setattr(E.credentials, "get_api_key", lambda: "k")
        monkeypatch.setattr(E, "_fetch_template", lambda *_a, **_k: {"system_prompt": "S"})

        out = _run(template_id=7)

        assert out["result"][0] == "ENHANCED BY BACKEND"
        assert "warning" not in out["ui"]
        assert calls["backend"][0]["url"] == "http://aih.test/api/enhance"

    def test_concat_mode_has_no_warning(self, monkeypatch, calls):
        monkeypatch.setattr(E.credentials, "get_api_url", lambda: "")
        monkeypatch.setattr(E.credentials, "get_api_key", lambda: "")

        out = _run(use_llm=False)

        assert out["result"][0] == "a cat on a sofa, a hat, a cape"
        assert "warning" not in out["ui"], \
            "use_llm=False est un choix explicite : ce n'est pas un dégradé"

    def test_local_llm_works_without_server(self, monkeypatch, calls):
        monkeypatch.setattr(E.credentials, "get_api_url", lambda: "")
        monkeypatch.setattr(E.credentials, "get_api_key", lambda: "")

        out = _run(llm_config=LOCAL_CONFIG)

        assert out["result"][0] == "ENHANCED BY LOCAL LLM"
        assert "warning" not in out["ui"]

    def test_local_llm_failure_without_server_degrades_locally(self, monkeypatch, calls):
        monkeypatch.setattr(E.credentials, "get_api_url", lambda: "")
        monkeypatch.setattr(E.credentials, "get_api_key", lambda: "")
        monkeypatch.setattr(E.llm_helper, "call_llm",
                            lambda *_a, **_k: None)  # LLM local en échec

        out = _run(llm_config=LOCAL_CONFIG)

        assert out["result"][0] == "a cat on a sofa, a hat, a cape"
        assert "LLM local indisponible" in out["ui"]["warning"][0]
        assert calls["backend"] == [], "aucun POST vers '/enhance' sans serveur"
