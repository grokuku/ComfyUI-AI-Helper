"""Node AIH Elements Picker — dégradé COHÉRENT et VISIBLE (jamais muet).

CONTEXTE RÉEL (worker Modal) : quatre ``[AIH Elements] LLM call failed: Invalid
URL '/keywords/llm-process': No scheme supplied`` puis une liste vide, sans
explication dans l'UI. Le node ne plantait pas — mais l'utilisateur n'avait
aucun moyen de savoir que le backend n'était pas configuré.

Contrat verrouillé ici :
  1. sans ``server_url``, AUCUNE requête n'est tentée (plus de bruit
     « Invalid URL » répété) ;
  2. le node ne lève jamais : il renvoie le prompt construit LOCALEMENT ;
  3. la RAISON est remontée dans ``ui["warning"]`` (toast côté
     js/aih_elements_widget.js) et le premier échec est journalisé en WARNING ;
  4. la sortie ``elements`` (le prompt) n'est JAMAIS polluée par le message ;
  5. si TOUS les éléments LLM ont été retirés faute de réponse, le message
     d'UI nomme la VRAIE cause (et plus « Aucun filtre sélectionné ») ;
  6. backend /api/generate injoignable ⇒ repli local + ``ui["warning"]``
     (l'ancien « fallback silencieux » ne l'est plus).

Mutants (assertions ROUGES) :
  M1 retirer ``ui["warning"]`` ⇒ §3/§5/§6 rouges ;
  M2 concaténer le message dans la sortie ``elements`` ⇒ §4 rouge ;
  M3 retenter l'appel HTTP à URL vide ⇒ §1 rouge ;
  M4 rendre le repli final muet ⇒ §6 rouge.

Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
"""

import json
import sys
from pathlib import Path

import pytest

PACK_DIR = Path(__file__).resolve().parent.parent
if str(PACK_DIR) not in sys.path:
    sys.path.insert(0, str(PACK_DIR))

from nodes import elements_node as N  # noqa: E402


class _Resp:
    def __init__(self, payload=None, ok=True):
        self._payload = payload if payload is not None else {}
        self.ok = ok

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


@pytest.fixture
def no_server(monkeypatch):
    """Backend NON configuré + espion des requêtes (aucune ne doit partir)."""
    calls = []
    monkeypatch.setattr(N.credentials, "get_api_url", lambda: "")
    monkeypatch.setattr(N.credentials, "get_api_key", lambda: "")

    def spy(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("requête HTTP tentée sans serveur configuré")

    monkeypatch.setattr("requests.post", spy)
    monkeypatch.setattr("requests.get", spy)
    return calls


def _elements_json(elements, **extra):
    payload = {"elements": elements}
    payload.update(extra)
    return json.dumps(payload)


def _run(**kwargs):
    params = dict(seed=1, _elements_json="{}", elements_input="", llm_config=None)
    params.update(kwargs)
    return N.AIHElementsNode().generate(**params)


# ═════════════ 1. Backend non configuré : dégradé visible, sans bruit ═══════


class TestNoServer:
    def test_llm_list_is_skipped_without_network(self, no_server):
        cfg = _elements_json(
            [{"type": "text", "text": "||color", "visible": True, "seed_mode": "inherit"}],
            preset_id=12,
        )

        out = _run(_elements_json=cfg)

        assert no_server == [], "MUTANT M3 : aucune requête vers une URL relative"
        assert out["result"][0] == "", "aucun élément généré : sortie vide, pas d'exception"

    def test_reason_is_visible_in_ui(self, no_server):
        cfg = _elements_json(
            [{"type": "text", "text": "||color", "visible": True, "seed_mode": "inherit"}],
            preset_id=12,
        )

        out = _run(_elements_json=cfg)

        warning = out["ui"].get("warning")
        assert warning, "MUTANT M1 : la raison doit être visible dans l'UI"
        message = warning[0]
        assert "LLM indisponible" in message
        assert "server_url vide" in message, "la CAUSE est nommée"
        assert "AIH · Compte" in message, "et l'endroit où la renseigner"

    def test_empty_prompt_message_names_the_real_cause(self, no_server):
        """§5 : « Aucun filtre sélectionné » serait un mensonge ici."""
        cfg = _elements_json(
            [{"type": "text", "text": "||color", "visible": True, "seed_mode": "inherit"}],
            preset_id=12,
        )

        out = _run(_elements_json=cfg)

        message = out["ui"]["elements"][0]
        assert "Aucun filtre sélectionné" not in message
        assert "LLM indisponible" in message

    def test_prompt_output_is_not_polluted(self, no_server):
        """MUTANT M2 : message dans la sortie ⇒ ce test devient ROUGE."""
        cfg = _elements_json(
            [{"type": "text", "text": "a red car", "visible": True, "seed_mode": "inherit"},
             {"type": "text", "text": "||color", "visible": True, "seed_mode": "inherit"}],
            preset_id=12,
        )

        out = _run(_elements_json=cfg)

        assert out["result"][0] == "a red car", "le texte littéral reste utilisé"
        assert "⚠" not in out["result"][0]
        assert "⚠" not in out["ui"]["elements"][0]

    def test_generate_call_is_skipped_no_relative_url(self, no_server):
        """Le node ne fabrique pas d'URL relative « /generate » sans serveur.

        MUTANT : retirer le garde-fou `if not api_url` avant l'appel ⇒ le POST
        part vers une URL relative (et l'espion `requests.post` lève).
        """
        cfg = _elements_json(
            [{"type": "text", "text": "a red car", "visible": True, "seed_mode": "inherit"}]
        )

        out = _run(_elements_json=cfg)

        assert no_server == [], "aucune requête /api/generate tentée sans serveur"
        assert out["result"][0] == "a red car", "le prompt local est bien produit"
        assert "server_url vide" in out["ui"]["warning"][0]

    def test_first_failure_is_a_warning_then_debug(self, no_server, caplog):
        cfg = _elements_json(
            [{"type": "text", "text": "||color", "visible": True, "seed_mode": "inherit"},
             {"type": "text", "text": "||shape", "visible": True, "seed_mode": "inherit"},
             {"type": "text", "text": "||size", "visible": True, "seed_mode": "inherit"}],
            preset_id=12,
        )

        with caplog.at_level("DEBUG"):
            _run(_elements_json=cfg)

        warnings = [r for r in caplog.records if r.levelname == "WARNING"]
        assert len(warnings) == 1, \
            "un backend injoignable ne doit pas produire 3 WARNING identiques"
        assert "server_url vide" in warnings[0].getMessage()


# ═══════════════ 2. Backend injoignable au /generate : repli visible ════════


class TestGenerateFallback:
    def test_local_prompt_with_visible_warning(self, monkeypatch):
        """MUTANT M4 : repli muet ⇒ ce test devient ROUGE."""
        monkeypatch.setattr(N.credentials, "get_api_url", lambda: "http://aih.test/api")
        monkeypatch.setattr(N.credentials, "get_api_key", lambda: "k")

        def boom(*_a, **_k):
            raise OSError("backend injoignable")

        monkeypatch.setattr("requests.post", boom)

        cfg = _elements_json(
            [{"type": "text", "text": "a red car", "visible": True, "seed_mode": "inherit"}]
        )
        out = _run(_elements_json=cfg)

        assert out["result"][0] == "a red car", "le prompt local reste produit"
        assert "ui" in out and out["ui"]["warning"], "plus de repli silencieux"
        assert "injoignable" in out["ui"]["warning"][0]

    def test_backend_answer_wins_when_available(self, monkeypatch):
        monkeypatch.setattr(N.credentials, "get_api_url", lambda: "http://aih.test/api")
        monkeypatch.setattr(N.credentials, "get_api_key", lambda: "k")
        monkeypatch.setattr(
            "requests.post",
            lambda *_a, **_k: _Resp({"prompt": "SERVER PROMPT"}),
        )

        cfg = _elements_json(
            [{"type": "text", "text": "a red car", "visible": True, "seed_mode": "inherit"}]
        )
        out = _run(_elements_json=cfg)

        assert out["result"][0] == "SERVER PROMPT"
        assert "warning" not in out["ui"], "aucun dégradé quand le backend répond"


# ═══════════════ 3. Cas nominal inchangé (aucun warning parasite) ═══════════


class TestNominalUnchanged:
    def test_plain_elements_carry_no_warning(self, monkeypatch):
        monkeypatch.setattr(N.credentials, "get_api_url", lambda: "http://aih.test/api")
        monkeypatch.setattr(N.credentials, "get_api_key", lambda: "k")
        monkeypatch.setattr(
            "requests.post",
            lambda *_a, **_k: _Resp({"prompt": "SERVER PROMPT"}),
        )

        cfg = _elements_json(
            [{"type": "text", "text": "a red car", "visible": True, "seed_mode": "inherit"}]
        )

        out = _run(_elements_json=cfg)

        assert "warning" not in out["ui"]

    def test_llm_error_helper_returns_none_without_errors(self):
        assert N._llm_warning_message([], 0) is None

    def test_llm_error_helper_summarises(self):
        message = N._llm_warning_message(["Invalid URL '/keywords/llm-process'"], 2)
        assert message.startswith("⚠️ LLM indisponible")
        assert "2 élément(s) ignoré(s)" in message
        assert "repli local" in message
