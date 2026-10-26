"""Elements Picker — SEED PAR ÉLÉMENT : 3 modes et rétro-compatibilité stricte.

Réglage optionnel porté par l'UI (js/aih_elements_seed.js) et consommé par le
node lui-même (nodes/elements_node.py) :

  - « node »   (DÉFAUT) : le seed de la node, avec l'index `i` HISTORIQUE →
    comportement bit-à-bit identique à l'ancienne version (aucun tirage décalé) ;
  - « random » : tirage frais à CHAQUE exécution, indépendant du seed de la node
    et indépendant des autres éléments ;
  - « fixed »  : valeur propre à l'élément, stable d'une exécution à l'autre et
    quel que soit le seed de la node (0 → seed dérivé du texte).

Les tests exercent le VRAI `AIHElementsNode.generate()` (aucun réseau : la POST
vers /api/generate est interceptée) et vérifient aussi le payload serveur, qui
doit rester strictement inchangé pour les workflows existants.

Les contrôles négatifs par mutation ont été exécutés pendant le développement
(mode hérité n'utilisant plus le seed de la node, mode fixe sensible au seed de
la node, mode random devenu déterministe, ancien élément mal normalisé) : les
tests ci-dessous échouent bien dans ces quatre cas.

Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
"""

import json
import math
import sys
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

from nodes import elements_node as E  # bootstrap sys.path ci-dessus

# Dataset de référence : blocs {} imbriqués + texte littéral, sans virgule (le
# node normalise les virgules du prompt final).
DATASET = [
    {"type": "raw", "text": "a {x::y::z} b"},
    {"type": "text", "text": "{blond::brun} cheveux {long::court}"},
    {"type": "raw", "text": "{bleu::rouge::vert}"},
]

# Valeurs GOLDEN du comportement historique (avant l'ajout du seed par élément).
# Elles verrouillent les tirages : tout décalage d'index ou de seed casse ici.
GOLDEN = {
    1: "a z b, brun cheveux long, bleu",
    5: "a z b, brun cheveux long, vert",
    12: "a x b, brun cheveux long, vert",
}


class _FakeResponse:
    """Réponse vide de /api/generate → le node retombe sur le prompt local."""

    status_code = 200

    def raise_for_status(self):
        return None

    def json(self):
        return {}


@pytest.fixture
def run_node(monkeypatch):
    """Exécute le vrai generate() hors ligne ; renvoie (prompt, payload serveur).

    Le serveur AIH est SIMULÉ (credentials factices) : sans ``server_url`` le
    node ne tente plus aucune requête (URL relative impossible) et il n'y
    aurait aucun payload à observer — or ces tests verrouillent justement le
    seed envoyé au backend.
    """
    monkeypatch.setattr(E.credentials, "get_api_url", lambda: "http://aih.test/api")
    monkeypatch.setattr(E.credentials, "get_api_key", lambda: "test-key")

    posted = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        posted["url"] = url
        posted["payload"] = json
        posted["headers"] = headers
        return _FakeResponse()

    import requests

    monkeypatch.setattr(requests, "post", fake_post)

    def _run(elements, seed=0, **extra):
        cfg = {"elements": json.loads(json.dumps(elements))}
        cfg.update(extra)
        result = E.AIHElementsNode().generate(seed, json.dumps(cfg))
        return result["ui"]["elements"][0], posted["payload"]

    return _run


def _resolve_all(elements, seed):
    """Résolution de référence : helpers historiques, index de boucle inchangé."""
    return ", ".join(
        E._resolve_braces(el["text"], seed, i) for i, el in enumerate(elements)
    )


# ── 1. Mode hérité : bit-à-bit identique à l'ancienne version ───────────────


@pytest.mark.parametrize("seed", sorted(GOLDEN))
def test_inherited_mode_matches_golden_values(run_node, seed):
    """Sans champ de seed (anciens workflows), les tirages sont EXACTEMENT les mêmes."""
    prompt, _ = run_node(DATASET, seed=seed)
    assert prompt == GOLDEN[seed]


def test_inherited_mode_explicit_equals_implicit(run_node):
    """`seed_mode: "node"` explicite == absence de champ (même comportement)."""
    for seed in sorted(GOLDEN):
        implicit, _ = run_node(DATASET, seed=seed)
        explicit, _ = run_node([dict(el, seed_mode="node") for el in DATASET], seed=seed)
        assert explicit == implicit == GOLDEN[seed]


def test_inherited_mode_uses_node_seed(run_node):
    """Le mode hérité suit bien le seed de la node (sinon il n'hérite de rien)."""
    assert GOLDEN[1] != GOLDEN[5]
    assert E._resolve_element_seed({}, 4242) == 4242
    assert E._resolve_element_seed({"seed_mode": "node"}, 4242) == 4242
    assert E._resolve_element_seed({}, 0) == 0


# ── 2. Mode fixe : stable, indépendant du seed de la node ──────────────────


def test_fixed_mode_is_reproducible_whatever_the_node_seed(run_node):
    elements = [{
        "type": "raw", "text": "{bleu::rouge::vert::jaune}",
        "seed_mode": "fixed", "seed_value": 4242,
    }]
    prompts = {seed: run_node(elements, seed=seed)[0] for seed in (0, 1, 5, 12, 999999)}
    assert len(set(prompts.values())) == 1, f"le mode fixe ne doit pas dépendre du seed de la node : {prompts}"
    # … et correspond exactement au helper historique appelé avec le seed de l'élément.
    assert prompts[1] == E._resolve_braces("{bleu::rouge::vert::jaune}", 4242, 0) == "rouge"


def test_fixed_mode_differs_from_inherited_on_same_element(run_node):
    """La valeur fixe n'est pas ignorée : elle change réellement le tirage."""
    text = "{bleu::rouge::vert::jaune}"
    fixed, _ = run_node([{"type": "raw", "text": text, "seed_mode": "fixed", "seed_value": 7}], seed=4242)
    inherited, _ = run_node([{"type": "raw", "text": text}], seed=4242)
    assert fixed == E._resolve_braces(text, 7, 0) == "bleu"
    assert inherited == E._resolve_braces(text, 4242, 0) == "rouge"
    assert fixed != inherited


def test_fixed_zero_falls_back_to_stable_text_derived_seed(run_node):
    """Valeur 0 : repli STABLE dérivé du texte (jamais le chemin « aléatoire »)."""
    text = "{bleu::rouge::vert}"
    element = {"type": "raw", "text": text, "seed_mode": "fixed", "seed_value": 0}
    expected_seed = E._hash32(text)
    assert expected_seed != 0
    assert E._resolve_element_seed(element, 1) == expected_seed
    assert E._resolve_element_seed(element, 987654321) == expected_seed
    prompts = {run_node([element], seed=seed)[0] for seed in (1, 5, 12)}
    assert prompts == {E._resolve_braces(text, expected_seed, 0)}


def test_fixed_mode_accepts_string_and_big_integers(run_node):
    text = "{bleu::rouge::vert}"
    big = "18446744073709551615"
    element = {"type": "raw", "text": text, "seed_mode": "fixed", "seed_value": big}
    assert E._resolve_element_seed(element, 3) == 0xffffffffffffffff
    assert run_node([element], seed=3)[0] == E._resolve_braces(text, 0xffffffffffffffff, 0)


# ── 3. Mode random : re-tiré à chaque exécution, indépendant ────────────────


def test_random_mode_draws_once_per_element_and_run(monkeypatch):
    draws = []

    def fake_randint(low, high):
        draws.append((low, high))
        return 123456789

    monkeypatch.setattr(E.random, "randint", fake_randint)
    element = {"type": "raw", "text": "{a::b::c}", "seed_mode": "random"}
    assert E._resolve_element_seed(element, 42) == 123456789
    assert E._resolve_element_seed(element, 42) == 123456789
    assert draws == [(1, E._MAX_SEED), (1, E._MAX_SEED)], "un tirage par élément, non nul"


def test_random_mode_ignores_node_seed(run_node, monkeypatch):
    monkeypatch.setattr(E.random, "randint", lambda low, high: 777)
    element = {"type": "raw", "text": "{bleu::rouge::vert}", "seed_mode": "random"}
    prompts = {run_node([element], seed=seed)[0] for seed in (0, 1, 5, 12)}
    assert prompts == {E._resolve_braces("{bleu::rouge::vert}", 777, 0)}


def test_random_mode_two_elements_are_independent(run_node):
    """Deux éléments random ne tirent pas la même chose (tirages distincts)."""
    elements = [
        {"type": "raw", "text": "{a::b::c}", "seed_mode": "random"},
        {"type": "raw", "text": "{a::b::c}", "seed_mode": "random"},
    ]
    distinct = set()
    for _ in range(25):
        prompt, _ = run_node(elements, seed=7)
        first, second = [part.strip() for part in prompt.split(",")]
        assert first in "abc" and second in "abc"
        if first != second:
            distinct.add((first, second))
    assert distinct, "deux éléments random ne doivent pas tirer systématiquement la même valeur"


def test_random_mode_changes_between_runs(run_node):
    """Le mode random se re-tire d'une exécution à l'autre (même seed de node)."""
    element = {"type": "raw", "text": "{a::b::c}", "seed_mode": "random"}
    prompts = {run_node([element], seed=7)[0] for _ in range(30)}
    assert len(prompts) > 1, f"le mode random est devenu déterministe : {prompts}"


# ── 4. Modes mixtes dans la même liste ─────────────────────────────────────


def test_mixed_modes_in_the_same_list(run_node, monkeypatch):
    monkeypatch.setattr(E.random, "randint", lambda low, high: 777)
    elements = [
        {"type": "raw", "text": "a {x::y::z} b"},                                                # hérité
        {"type": "text", "text": "{blond::brun} cheveux {long::court}",
         "seed_mode": "fixed", "seed_value": 4242},                                             # fixe
        {"type": "raw", "text": "{bleu::rouge::vert}", "seed_mode": "random"},                  # random
    ]
    expected = ", ".join([
        E._resolve_braces("a {x::y::z} b", 12, 0),
        E._resolve_braces("{blond::brun} cheveux {long::court}", 4242, 1),
        E._resolve_braces("{bleu::rouge::vert}", 777, 2),
    ])
    prompt, _ = run_node(elements, seed=12)
    assert prompt == expected
    # Le seed de la node ne déplace que l'élément hérité.
    other, _ = run_node(elements, seed=1)
    assert other.split(", ")[0] == E._resolve_braces("a {x::y::z} b", 1, 0)
    assert other.split(", ")[1:] == prompt.split(", ")[1:]


def test_hidden_element_has_no_effect_on_indices(run_node, monkeypatch):
    """Un élément masqué est retiré AVANT la boucle : l'index des autres est inchangé."""
    monkeypatch.setattr(E.random, "randint", lambda low, high: 777)
    visible = [dict(el, seed_mode="fixed", seed_value=4242) for el in DATASET]
    with_hidden = [dict(visible[0]), dict(visible[1], visible=False), dict(visible[2])]
    assert run_node(visible, seed=3)[0] == ", ".join(
        E._resolve_braces(el["text"], 4242, i) for i, el in enumerate(visible)
    )
    # L'élément masqué étant retiré, il reste 2 éléments → indices 0 et 1.
    expected_hidden = ", ".join([
        E._resolve_braces(DATASET[0]["text"], 4242, 0),
        E._resolve_braces(DATASET[2]["text"], 4242, 1),
    ])
    assert run_node(with_hidden, seed=3)[0] == expected_hidden


# ── 5. Cache ComfyUI : IS_CHANGED ──────────────────────────────────────────


def _is_changed(elements, seed=1):
    return E.AIHElementsNode.IS_CHANGED(seed=seed, _elements_json=json.dumps({"elements": elements}))


def test_is_changed_is_deterministic_without_random_element():
    """Aucun élément random → constante : le cache actuel est préservé à l'identique."""
    first = _is_changed([{"type": "raw", "text": "{a::b}"}])
    second = _is_changed([{"type": "raw", "text": "{a::b}"}], seed=99)
    assert first == second == ""
    assert _is_changed([]) == ""
    assert _is_changed([{"type": "raw", "text": "x", "seed_mode": "fixed", "seed_value": 3}]) == ""
    assert _is_changed([{"type": "raw", "text": "x", "seed_mode": "node"}]) == ""


def test_is_changed_forces_rerun_when_an_element_is_random():
    value = _is_changed([{"type": "raw", "text": "{a::b}", "seed_mode": "random"}])
    assert isinstance(value, float) and math.isnan(value)
    # NaN != NaN → jamais de cache pour cette node.
    assert value != _is_changed([{"type": "raw", "text": "{a::b}", "seed_mode": "random"}])


def test_is_changed_ignores_hidden_random_element():
    assert _is_changed([{"type": "raw", "text": "{a::b}", "seed_mode": "random", "visible": False}]) == ""


def test_is_changed_tolerates_invalid_json():
    assert E.AIHElementsNode.IS_CHANGED(seed=1, _elements_json="not json") == ""
    assert E.AIHElementsNode.IS_CHANGED(seed=1, _elements_json="") == ""
    assert E.AIHElementsNode.IS_CHANGED(seed=1, _elements_json='{"elements": "nope"}') == ""
    assert E.AIHElementsNode.IS_CHANGED() == ""


# ── 6. Payload serveur : contrat inchangé ─────────────────────────────────


def test_payload_seed_unchanged(run_node):
    """Le payload ne porte que le seed global, et seulement s'il est > 0 (comme avant)."""
    _, payload_no_seed = run_node(DATASET, seed=0)
    assert "seed" not in payload_no_seed
    _, payload_seed = run_node(DATASET, seed=4242)
    assert payload_seed["seed"] == 4242
    # Les modes par élément ne modifient PAS le seed envoyé au serveur : les
    # entrées « filter » et le random_count restent résolus côté backend avec ce
    # seed global (limite documentée).
    elements = [
        {"type": "raw", "text": "{a::b}", "seed_mode": "fixed", "seed_value": 1},
        {"type": "raw", "text": "{a::b}", "seed_mode": "random"},
    ]
    _, payload_mixed = run_node(elements, seed=4242)
    assert payload_mixed["seed"] == 4242
    assert set(payload_mixed) == {"elements", "seed"}, "aucune nouvelle clé de payload"


# ── 7. Normalisation / bornes (helpers purs) ──────────────────────────────


@pytest.mark.parametrize("value,expected", [
    ("fixed", "fixed"),
    (" RANDOM ", "random"),
    ("Fixed", "fixed"),
    ("bogus", "node"),
    ("", "node"),
    (None, "node"),
    (42, "node"),
    ("node", "node"),
])
def test_normalize_seed_mode(value, expected):
    assert E._normalize_seed_mode({"seed_mode": value}) == expected


def test_normalize_seed_mode_without_element():
    assert E._normalize_seed_mode(None) == "node"
    assert E._normalize_seed_mode({}) == "node"
    assert E._normalize_seed_mode("pas un dict") == "node"


@pytest.mark.parametrize("value,expected", [
    (0, 0),
    (42, 42),
    (42.9, 42),
    ("42", 42),
    (" 42 ", 42),
    ("18446744073709551615", 0xffffffffffffffff),
    ("18446744073709551616", 0xffffffffffffffff),
    ("99999999999999999999999", 0xffffffffffffffff),
    (-3, 0),
    (True, 0),
    (None, 0),
    ("", 0),
    ("abc", 0),
    (float("nan"), 0),
    (float("inf"), 0),
])
def test_coerce_seed_value(value, expected):
    assert E._coerce_seed_value(value) == expected


def test_derived_element_seed_is_never_zero_and_text_based():
    assert E._derived_element_seed({"text": "abc"}) == E._hash32("abc") == 440920331
    assert E._derived_element_seed({"text": "abc"}) == E._derived_element_seed({"text": "abc"})
    assert E._derived_element_seed({"text": "abd"}) != E._derived_element_seed({"text": "abc"})
    # Texte absent : hash de la chaîne vide = base FNV-1a (jamais 0 grâce au garde `or 1`).
    assert E._derived_element_seed({}) == E._hash32("") == 0x811c9dc5
    assert E._derived_element_seed({}) == E._derived_element_seed(None) >= 1


# ── 8. Miroir JS : la table de hash est identique des deux côtés ──────────


MIRROR_TABLE = [
    ("a {x::y::z} b", 42, 0, "a y b"),
    ("{blond::brun} cheveux {long::court}", 7, 3, "brun cheveux long"),
    ("{bleu::rouge::vert}", 1234567890123456789, 1, "vert"),
    ("{A::B} et {A::B}", 99, 4, "A et A"),
    ("{seul}", 5, 0, "seul"),
    ("texte littéral", 5, 0, "texte littéral"),
    ("{a::b::c} {a::b::c}", 20260101, 2, "c c"),
    ("femme de {25::30::35::40} ans", 3503270066, 2, "femme de 30 ans"),
    ("{:://vide::}", 8, 1, "//vide"),
]


@pytest.mark.parametrize("text,seed,index,expected", MIRROR_TABLE)
def test_resolve_braces_mirror_table(text, seed, index, expected):
    """Mêmes valeurs que resolveBraceBlocks() (js/test_aih_elements_seed.mjs)."""
    assert E._resolve_braces(text, seed, index) == expected


# ── 9. Non-régression des comportements existants ─────────────────────────


def test_resolve_braces_without_seed_still_random(monkeypatch):
    """seed <= 0 : chemin aléatoire historique intact (mode hérité sans seed)."""
    monkeypatch.setattr(E.random, "choice", lambda items: items[-1])
    assert E._resolve_braces("{a::b::c}", 0, 0) == "c"
    assert E._resolve_braces_with_filtered("{a::b::c}", 0, 0, ["a", "b"]) == "b"
    assert E._pick_from_list(["a", "b"], 0, 0, "x") == "b"


def test_inherited_mode_consumes_no_extra_random_draw(run_node, monkeypatch):
    """Le mode hérité ne tire RIEN : le flux aléatoire historique est intact.

    Avec seed=0 le node retombe sur `random.choice` dans les helpers ; ajouter un
    tirage (même « inutilisé ») en amont décalerait la séquence globale des
    workflows existants.
    """

    def boom(low, high):
        raise AssertionError("le mode hérité ne doit consommer aucun tirage aléatoire")

    monkeypatch.setattr(E.random, "randint", boom)
    prompt, _ = run_node(DATASET, seed=0)
    assert isinstance(prompt, str) and prompt
    for element in DATASET:
        assert E._resolve_element_seed(element, 0) == 0
        assert E._resolve_element_seed(dict(element, seed_mode="node"), 7) == 7


def test_filtered_resolution_unchanged_with_element_seed(run_node):
    """Le fallback filtrage LLM utilise le seed de l'élément, index inchangé."""
    filtered = ["brun", "court"]
    assert E._resolve_braces_with_filtered(
        "{blond::brun} cheveux {long::court}", 4242, 1, filtered
    ) == E._resolve_braces_with_filtered(
        "{blond::brun} cheveux {long::court}", 4242, 1, filtered
    )


def test_node_source_consumes_only_the_element_seed():
    """Garde-fou de source : plus aucune consommation du seed BRUT dans la boucle."""
    source = (PACKAGE_DIR / "nodes" / "elements_node.py").read_text(encoding="utf-8")
    assert source.count("el_seed = _resolve_element_seed(el, seed)") == 1
    for forbidden in (
        "_resolve_braces(raw_text, seed, i)",
        "_resolve_braces_with_filtered(\n                    raw_text, seed, i",
        "_pick_from_list(items, seed, i, raw_text)",
        "input_text, seed=seed",
    ):
        assert forbidden not in source, f"consommation du seed global restante : {forbidden!r}"
    assert source.count("seed=el_seed") == 2, "les 2 appels LLM externes utilisent le seed de l'élément"
