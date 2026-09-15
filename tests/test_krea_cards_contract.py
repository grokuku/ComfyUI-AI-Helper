# ─────────────────────────────────────────────────────────────────────────
# Tests de CONTRAT des packets des cartes AIH Krea (étape 1/2, côté Python).
#
# Objectif : garantir que les deux cartes émettent un packet conforme, sans
# dépendre de ComfyUI. Les modules nodes/aih_guide_card.py et
# nodes/aih_slider_card.py n'importent que la stdlib, ils sont donc chargés
# directement par chemin via importlib (le dossier du pack contient un tiret
# et son __init__.py racine importe `server`).
#
# Ce que l'on vérifie :
#   - l'ensemble EXACT des clés émises ;
#   - aucune valeur None sur les clés resolved_* ;
#   - resolved_layer_pull = 12 floats ;
#   - les clés minimales exigées par l'encodeur (image, strength / description,
#     value) ;
#   - la validité des enums (erreur lisible, pas de no-op silencieux) ;
#   - chaque intention produit un packet complet.
#
# Usage : ./run_tests.sh   (ou pytest tests/test_krea_cards_contract.py)
# ─────────────────────────────────────────────────────────────────────────
import importlib.util
import logging
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
NODES_DIR = REPO_ROOT / "nodes"


def _load_node_module(module_name, filename):
    """Charge un fichier node autonome par chemin, sans package ni ComfyUI."""
    spec = importlib.util.spec_from_file_location(module_name, NODES_DIR / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


guide = _load_node_module("aih_guide_card", "aih_guide_card.py")
slider = _load_node_module("aih_slider_card", "aih_slider_card.py")

# ── Contrats de clés (gelés : append-only) ────────────────────────────────
GUIDE_PACKET_KEYS = {
    "source_version",
    "image",
    "strength",
    "requested_strength",
    "purpose",
    "prepare_image_by",
    "study_this_image_at",
    "frame_this_reference_by",
    "subject_copying",
    "color_kept",
    "detail_kept",
    "shape_copied",
    "overall_style_reach",
    "manual_controls_active",
    "quick_recipe",
    # Clés résolues.
    "resolved_role",
    "resolved_treatment",
    "resolved_color_keep",
    "resolved_detail",
    "resolved_reference_resolution",
    "resolved_reference_fit",
    "resolved_subject_policy",
    "resolved_early_multiplier",
    "resolved_late_multiplier",
    "resolved_shape_pull",
    "resolved_global_pull",
    "resolved_layer_pull",
    "resolved_direction",
    "resolved_timing",
    "resolved_focus",
    # Compatibilité krea.
    "v9_blank_surface_guard",
    "v9_strength_cap",
    "guide_direction",
    "when_this_card_guides",
    "structure_layers_pull",
    "finish_layers_pull",
    # Clés de repli sans préfixe.
    "preset",
    "role",
    "treatment",
    "color_keep",
    "detail",
    "reference_resolution",
    "reference_fit",
    "subject_policy",
    "early_multiplier",
    "late_multiplier",
    "shape_pull",
    "global_pull",
    "layer_pull",
    "strength_cap",
    "direction",
    "timing",
    "focus",
}

SLIDER_PACKET_KEYS = {
    "kg_slider_version",
    "description",
    "value",
    "increase_text",
    "decrease_text",
}

# Sous-ensemble minimal consommé par les encodeurs krea installés à côté.
GUIDE_ENCODER_MINIMAL_KEYS = {
    "image",
    "strength",
    "resolved_role",
    "resolved_treatment",
    "resolved_color_keep",
    "resolved_detail",
    "resolved_reference_resolution",
    "resolved_reference_fit",
    "resolved_subject_policy",
    "resolved_early_multiplier",
    "resolved_late_multiplier",
    "resolved_shape_pull",
    "resolved_global_pull",
    "resolved_layer_pull",
    "resolved_focus",
}

FAKE_IMAGE = object()


@pytest.fixture()
def guide_node():
    return guide.AIHGuideCard()


@pytest.fixture()
def slider_node():
    return slider.AIHSliderCard()


# ── Guide Card ─────────────────────────────────────────────────────────────


def test_guide_packet_has_exact_key_set(guide_node):
    packet = guide_node.build(image=FAKE_IMAGE)[0]
    assert set(packet) == GUIDE_PACKET_KEYS
    assert packet["source_version"] == "aih-card-1"


def test_guide_packet_has_no_none_resolved_keys(guide_node):
    for intention in guide.INTENTION_LABELS:
        packet = guide_node.build(image=FAKE_IMAGE, intention=intention)[0]
        for key, value in packet.items():
            if key.startswith("resolved_"):
                assert value is not None, f"{intention}: resolved_* None sur {key}"


def test_guide_layer_pull_is_twelve_floats(guide_node):
    for intention in guide.INTENTION_LABELS:
        packet = guide_node.build(image=FAKE_IMAGE, intention=intention)[0]
        layer_pull = packet["resolved_layer_pull"]
        assert len(layer_pull) == 12, f"{intention}: layer_pull={len(layer_pull)}"
        assert all(isinstance(v, float) for v in layer_pull), intention
        # Les clés de repli sont identiques.
        assert len(packet["layer_pull"]) == 12


def test_guide_packet_exposes_encoder_minimal_keys(guide_node):
    packet = guide_node.build(image=FAKE_IMAGE)[0]
    assert GUIDE_ENCODER_MINIMAL_KEYS <= set(packet)
    assert packet["image"] is FAKE_IMAGE


def test_each_intention_produces_a_complete_packet(guide_node):
    seen_roles = set()
    for intention in guide.INTENTION_LABELS:
        packet = guide_node.build(image=FAKE_IMAGE, intention=intention)[0]
        # Packet complet : toutes les clés de contrat présentes, aucune None
        # résolue, direction/timing/focus résolus.
        assert set(packet) == GUIDE_PACKET_KEYS
        assert packet["purpose"] == intention
        assert packet["resolved_timing"] == "recipe"
        assert packet["resolved_direction"] in ("toward", "away")
        assert isinstance(packet["resolved_focus"], str)
        assert packet["quick_recipe"] == guide.INTENTION_RECIPES[intention]["recipe"]
        seen_roles.add(packet["resolved_role"])
    # Les 8 intentions se résolvent bien en 8 rôles distincts.
    assert len(seen_roles) == len(guide.INTENTION_LABELS)


def test_guide_default_intention_is_balanced_recipe(guide_node):
    packet = guide_node.build(image=FAKE_IMAGE)[0]
    assert packet["purpose"] == guide.DEFAULT_INTENTION
    assert packet["resolved_role"] == "balanced"
    assert packet["resolved_treatment"] == "normal"
    assert packet["resolved_layer_pull"] == guide.EVEN_LAYER_PULL
    # Sans override manuel, aucun réglage n'est signalé comme actif.
    assert packet["manual_controls_active"] is False


def test_guide_manual_override_wins_over_recipe(guide_node):
    packet = guide_node.build(
        image=FAKE_IMAGE,
        intention="Équilibré",
        preparation="Lavage de palette",
        detail_conserve=0.2,
        couleur_conservee=0.5,
        phase_debut=2.0,
        structure=0.5,
    )[0]
    assert packet["resolved_treatment"] == "palette wash"
    assert packet["resolved_detail"] == pytest.approx(0.2)
    assert packet["resolved_color_keep"] == pytest.approx(0.5)
    assert packet["resolved_early_multiplier"] == pytest.approx(2.0)
    # Molette structure : 6 premières couches ×0.5.
    assert packet["resolved_layer_pull"][0] == pytest.approx(0.5)
    assert packet["resolved_layer_pull"][-1] == pytest.approx(1.0)
    assert packet["manual_controls_active"] is True


def test_guide_away_direction_forces_avoid_subject(guide_node):
    packet = guide_node.build(image=FAKE_IMAGE, intention="Garder le sujet", direction="à l'opposé")[0]
    assert packet["resolved_direction"] == "away"
    assert packet["resolved_subject_policy"] == "avoid"


def test_guide_force_capped_by_recipe(guide_node):
    packet = guide_node.build(image=FAKE_IMAGE, intention="Éviter texte/logos", force=3.0)[0]
    assert packet["v9_strength_cap"] == pytest.approx(0.03)
    assert packet["strength"] == pytest.approx(0.03)
    assert packet["requested_strength"] == pytest.approx(3.0)
    # Le garde blank-surface clampe en dernier.
    assert packet["v9_blank_surface_guard"] is True
    assert packet["resolved_treatment"] == "shape wash"
    assert packet["resolved_late_multiplier"] == pytest.approx(0.0)
    assert max(packet["resolved_layer_pull"]) <= 0.15


@pytest.mark.parametrize(
    "widget, bad_value",
    [
        ("intention", "Intention imaginaire"),
        ("direction", "sideways"),
        ("preparation", "nope"),
        ("etude", "ultra"),
        ("cadrage", "diagonal"),
    ],
)
def test_guide_invalid_enum_raises_readable_error(guide_node, widget, bad_value):
    with pytest.raises(ValueError) as excinfo:
        guide_node.build(image=FAKE_IMAGE, **{widget: bad_value})
    assert widget in str(excinfo.value)


def test_guide_warns_when_image_missing(guide_node, caplog):
    with caplog.at_level(logging.WARNING, logger="aih_guide_card"):
        packet = guide_node.build()[0]
    assert any("aucune image" in record.message for record in caplog.records)
    assert packet["image"] is None
    # image n'est pas une clé resolved_* : None reste autorisé ici.
    assert all(value is not None for key, value in packet.items() if key.startswith("resolved_"))


# ── Slider Card ────────────────────────────────────────────────────────────


def test_slider_packet_has_exact_key_set(slider_node):
    packet = slider_node.build(image=FAKE_IMAGE)[0]
    assert set(packet) == SLIDER_PACKET_KEYS
    assert packet["kg_slider_version"] == 1


def test_slider_defaults(slider_node):
    packet = slider_node.build(image=FAKE_IMAGE)[0]
    assert packet["description"] == "brightness"
    assert packet["value"] == pytest.approx(0.0)
    assert packet["increase_text"] == ""
    assert packet["decrease_text"] == ""


def test_slider_value_is_clamped_to_range(slider_node):
    high = slider_node.build(image=FAKE_IMAGE, valeur=99.0)[0]
    low = slider_node.build(image=FAKE_IMAGE, valeur=-99.0)[0]
    assert high["value"] == pytest.approx(slider.SLIDER_RANGE)
    assert low["value"] == pytest.approx(-slider.SLIDER_RANGE)
    assert isinstance(high["value"], float)


def test_slider_poles_are_stripped(slider_node):
    packet = slider_node.build(
        image=FAKE_IMAGE,
        attribut="  warmth  ",
        valeur=3.5,
        pole_positif="  golden hour  ",
        pole_negatif="  cold blue  ",
    )[0]
    assert packet["description"] == "warmth"
    assert packet["value"] == pytest.approx(3.5)
    assert packet["increase_text"] == "golden hour"
    assert packet["decrease_text"] == "cold blue"


def test_slider_warns_when_image_missing(slider_node, caplog):
    with caplog.at_level(logging.WARNING, logger="aih_slider_card"):
        packet = slider_node.build()[0]
    assert any("aucune image" in record.message for record in caplog.records)
    assert set(packet) == SLIDER_PACKET_KEYS
