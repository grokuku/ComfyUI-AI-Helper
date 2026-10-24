# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# SORTIE « ratio » (STRING) des deux nodes de résolution — tests PURS (sans torch).
#
# Contrat verrouillé ici :
#   1. `AIHResolutionPreset` et `AIHResolutionPresetV2` exposent une 3e sortie
#      STRING nommée `ratio`, AJOUTÉE EN DERNIER : `width` et `height` gardent
#      leur index (slot 0/1) et leurs VALEURS (non-régression stricte, table
#      figée ci-dessous, indépendante du module) ;
#   2. le texte suit le format UNIQUE du pack `<w:h> (<orientation>)` —
#      `"16:9 (landscape)"`, `"1:1 (square)"`, `"2.39:1 (landscape)"` — dans
#      TOUS les modes : ratio du widget, ratio DÉDUIT de l'image
#      (`use_image_ratio`), tirage `Random` (donc calculé APRÈS le tirage) et
#      combinaison `aspect_ratio` + `orientation` de la v2 ;
#   3. en mode mégapixels, le ratio décrit l'INTENTION et non le rapport exact
#      des pixels arrondis au multiple (1344×768 = « 16:9 » alors que 1344/768
#      vaut 1.75) ;
#   4. le texte se branche tel quel sur l'entrée `ratio` du Prompt Enhancer :
#      `enhance_node._ratio_instruction` en tire la consigne anglaise.
#
# Contrôles négatifs par mutation : /projects/.aih_tmp/ratio_mutate/mutate.py
#   (ratio pris sur le widget brut, ratio calculé AVANT le tirage Random,
#   sorties width/height décalées par la 3e sortie, ratio de la v2 figé sur la
#   forme portrait, information absente du prompt backend, `ratio=""` qui
#   modifie quand même le prompt).
#
# Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh

import random
import sys
import types
from pathlib import Path

import pytest

PACK_DIR = Path(__file__).resolve().parent.parent
NODES_DIR = PACK_DIR / "nodes"
for _path in (PACK_DIR, NODES_DIR):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))


# ═══════════════════════ torch : vrai si présent, sinon stub ════════════════
# Le venv de dev n'a pas torch ; les nodes de résolution n'utilisent le tensor
# que pour lire `shape`/`ndim` (ratio déduit de l'image). ATTENTION : un autre
# fichier de tests du pack installe un STUB `torch` dans sys.modules (pour que
# `isinstance(image, torch.Tensor)` du node voie la MÊME classe) — un stub ne
# sait pas créer de tenseurs (`torch.zeros` absent), d'où le double test.
try:  # pragma: no cover - dépend de l'environnement
    import torch as _candidate

    _HAS_REAL_TORCH = hasattr(_candidate, "zeros")
    _TORCH = _candidate
    if not _HAS_REAL_TORCH:
        sys.modules["torch"] = _TORCH  # stub déjà installé : on le réutilise tel quel
except ImportError:  # venv de dev : pas de torch du tout
    _HAS_REAL_TORCH = False
    _TORCH = sys.modules.get("torch")
    if _TORCH is None:
        _TORCH = types.ModuleType("torch")

        class _StubTensor:
            """Tenseur factice : seuls `shape` et `ndim` sont lus par les nodes."""

        _TORCH.Tensor = _StubTensor
        sys.modules["torch"] = _TORCH


def _image(height, width):
    """IMAGE ComfyUI factice ``[1, H, W, 3]`` (vrai torch si disponible)."""
    if _HAS_REAL_TORCH:  # pragma: no cover - vrai torch
        return _TORCH.zeros((1, height, width, 3), dtype=_TORCH.float32)
    tensor = _TORCH.Tensor()
    tensor.shape = (1, height, width, 3)
    tensor.ndim = 4
    return tensor


from nodes import holaf_resolution_preset as V1  # noqa: E402
from nodes import holaf_resolution_preset_v2 as V2  # noqa: E402
from nodes import enhance_node as ENHANCE  # noqa: E402

RATIO_TEXT = "ratio"


# ═══════════════════════════ 1. Format du texte ═════════════════════════════

class TestFormatRatioLabel:
    """Le formateur UNIQUE (partagé par les deux nodes) : `<w:h> (<orientation>)`."""

    @pytest.mark.parametrize("key,expected", [
        ("9:16 Portrait (Mobile Video)", "9:16 (portrait)"),
        ("2:3 Portrait (35mm Photo)", "2:3 (portrait)"),
        ("1:1 Square (Instagram-Medium Format)", "1:1 (square)"),
        ("4:3 Landscape (Classic Monitor-Photo)", "4:3 (landscape)"),
        ("16:9 Landscape (HD Video-Widescreen)", "16:9 (landscape)"),
        # Le « ~ » de l'anamorphique n'est pas un ratio : il est retiré.
        ("~2.39:1 Landscape (Anamorphic Cinema)", "2.39:1 (landscape)"),
    ])
    def test_known_keys(self, key, expected):
        assert V1.format_ratio_label(key) == expected

    @pytest.mark.parametrize("key", ["", None, "Random", "banane", "16:9"])
    def test_unknown_key_returns_it_unchanged(self, key):
        """Jamais d'exception : une sortie de node ne doit pas casser un graphe."""
        result = V1.format_ratio_label(key)
        assert isinstance(result, str)
        assert result == str(key or "").strip()

    def test_v2_uses_the_v1_formatter(self):
        """Format IDENTIQUE obligatoire : la v2 produit les MÊMES textes que la v1.

        (Deux instances du module coexistent : le loader ComfyUI charge chaque
        fichier de node séparément — on compare donc les TEXTES, pas l'objet
        fonction.)
        """
        for key in V1.ASPECT_RATIOS:
            assert V2.format_ratio_label(key) == V1.format_ratio_label(key)
        assert V2.format_ratio_label.__module__ == "holaf_resolution_preset"


# ═════════════════════ 2. AIHResolutionPreset (v1) ══════════════════════════

V1_BASELINE = [
    # (ratio du widget, width, height, texte `ratio` attendu) — valeurs FIGÉES
    # (table MASTER_RESOLUTIONS de SDXL, relevées AVANT l'ajout de la sortie).
    ("9:16 Portrait (Mobile Video)", 768, 1344, "9:16 (portrait)"),
    ("2:3 Portrait (35mm Photo)", 832, 1216, "2:3 (portrait)"),
    ("3:4 Portrait (Classic Monitor-Photo)", 896, 1152, "3:4 (portrait)"),
    ("4:5 Portrait (Large Format Photo)", 896, 1120, "4:5 (portrait)"),
    ("1:1 Square (Instagram-Medium Format)", 1024, 1024, "1:1 (square)"),
    ("5:4 Landscape (Large Format Photo)", 1120, 896, "5:4 (landscape)"),
    ("4:3 Landscape (Classic Monitor-Photo)", 1152, 864, "4:3 (landscape)"),
    ("3:2 Landscape (35mm Photo)", 1216, 832, "3:2 (landscape)"),
    ("16:9 Landscape (HD Video-Widescreen)", 1344, 768, "16:9 (landscape)"),
    ("~2.39:1 Landscape (Anamorphic Cinema)", 1536, 640, "2.39:1 (landscape)"),
]


class TestV1Contract:
    def test_ratio_output_is_appended_last(self):
        node = V1.HolafResolutionPreset
        assert node.RETURN_TYPES == ("INT", "INT", "STRING")
        assert node.RETURN_NAMES == ("width", "height", RATIO_TEXT)

    def test_inputs_unchanged(self):
        """Aucune entrée ajoutée/modifiée : les `widgets_values` restent valides."""
        inputs = V1.HolafResolutionPreset.INPUT_TYPES()
        assert list(inputs["required"]) == ["model_type", "aspect_ratio", "use_image_ratio"]
        assert list(inputs["optional"]) == ["image"]
        assert inputs["required"]["aspect_ratio"][0][0] == "Random"

    @pytest.mark.parametrize("ratio_key,width,height,label", V1_BASELINE)
    def test_table_mode_ratio_and_dimensions_frozen(self, ratio_key, width, height, label):
        result = V1.HolafResolutionPreset().get_resolution("SDXL", ratio_key, False)
        assert result == (width, height, label)
        assert isinstance(result[2], str)

    def test_dimensions_of_slot_0_and_1_unchanged_across_models(self):
        """NON-RÉGRESSION : les anciennes valeurs (sans `ratio`) sont identiques."""
        node = V1.HolafResolutionPreset()
        for model_type, ratio_key, expected in [
            ("FLUX (Speed)", "4:3 Landscape (Classic Monitor-Photo)", (1152, 896)),
            ("Qwen-Image", "4:5 Portrait (Large Format Photo)", (1328, 1660)),
            ("Ideogram4", "16:9 Landscape (HD Video-Widescreen)", (1920, 1088)),
            ("SD1.5", "9:16 Portrait (Mobile Video)", (512, 912)),
        ]:
            width, height = V1.MASTER_RESOLUTIONS[model_type][ratio_key]
            assert (width, height) == expected  # (table figée, indépendante du node)
            result = node.get_resolution(model_type, ratio_key, False)
            assert result[:2] == expected
            assert result[2] == V1.format_ratio_label(ratio_key)

    def test_invalid_ratio_falls_back_to_1_1_and_reports_it(self):
        """Le repli 1:1 est le ratio EFFECTIF : c'est lui qui doit sortir."""
        width, height, label = V1.HolafResolutionPreset().get_resolution(
            "SDXL", "banane", False)
        assert (width, height) == (1024, 1024)
        assert label == "1:1 (square)"


class TestV1ImageRatioMode:
    def test_landscape_image_reports_16_9(self):
        result = V1.HolafResolutionPreset().get_resolution(
            "SDXL", "3:4 Portrait (Classic Monitor-Photo)", True, _image(1080, 1920))
        assert result == (1344, 768, "16:9 (landscape)")

    def test_portrait_image_reports_9_16(self):
        """Le ratio de l'IMAGE prime sur le widget, dans les deux sens."""
        result = V1.HolafResolutionPreset().get_resolution(
            "SDXL", "16:9 Landscape (HD Video-Widescreen)", True, _image(1920, 1080))
        assert result == (768, 1344, "9:16 (portrait)")

    def test_3_4_image_reports_3_4(self):
        result = V1.HolafResolutionPreset().get_resolution(
            "SDXL", "1:1 Square (Instagram-Medium Format)", True, _image(800, 600))
        assert result == (896, 1152, "3:4 (portrait)")

    def test_invalid_image_dims_keep_the_widget_ratio(self):
        result = V1.HolafResolutionPreset().get_resolution(
            "SDXL", "16:9 Landscape (HD Video-Widescreen)", True, _image(0, 1920))
        assert result == (1344, 768, "16:9 (landscape)")

    def test_use_image_ratio_disabled_ignores_the_image(self):
        result = V1.HolafResolutionPreset().get_resolution(
            "SDXL", "1:1 Square (Instagram-Medium Format)", False, _image(1080, 1920))
        assert result == (1024, 1024, "1:1 (square)")


class TestV1RandomMode:
    """`Random` : le ratio sorti est celui TIRÉ (donc calculé après le tirage)."""

    def test_seeded_draw_is_reported(self):
        seed = 20260220
        random.seed(seed)
        drawn = random.choice(list(V1.ASPECT_RATIOS.keys()))

        random.seed(seed)
        width, height, label = V1.HolafResolutionPreset().get_resolution(
            "SDXL", "Random", False)

        assert label == V1.format_ratio_label(drawn)
        assert (width, height) == V1.MASTER_RESOLUTIONS["SDXL"][drawn]

    def test_ratio_is_never_the_widget_token(self):
        """CONTRE-ÉPREUVE : « Random » (widget brut) ne doit JAMAIS sortir."""
        random.seed(1)
        label = V1.HolafResolutionPreset().get_resolution("SDXL", "Random", False)[2]
        assert label != "Random"
        assert label in {V1.format_ratio_label(key) for key in V1.ASPECT_RATIOS}

    def test_every_drawn_ratio_is_a_known_label(self):
        node = V1.HolafResolutionPreset()
        known = {V1.format_ratio_label(key) for key in V1.ASPECT_RATIOS}
        for seed in range(25):
            random.seed(seed)
            assert node.get_resolution("SDXL", "Random", False)[2] in known


# ═══════════════════ 3. AIHResolutionPresetV2 (v2) ══════════════════════════

# (aspect_ratio, orientation) → (width, height, label) pour SDXL, valeurs FIGÉES.
V2_BASELINE = [
    ("9:16", False, 768, 1344, "9:16 (portrait)"),
    ("2:3", False, 832, 1216, "2:3 (portrait)"),
    ("3:4", False, 896, 1152, "3:4 (portrait)"),
    ("4:5", False, 896, 1120, "4:5 (portrait)"),
    ("1:1", False, 1024, 1024, "1:1 (square)"),
    ("9:16", True, 1344, 768, "16:9 (landscape)"),
    ("2:3", True, 1216, 832, "3:2 (landscape)"),
    ("3:4", True, 1152, 864, "4:3 (landscape)"),
    ("4:5", True, 1120, 896, "5:4 (landscape)"),
    ("1:1", True, 1024, 1024, "1:1 (square)"),
]


class TestV2Contract:
    def test_ratio_output_is_appended_last(self):
        node = V2.HolafResolutionPresetV2
        assert node.RETURN_TYPES == ("INT", "INT", "STRING")
        assert node.RETURN_NAMES == ("width", "height", RATIO_TEXT)

    def test_inputs_unchanged(self):
        inputs = V2.HolafResolutionPresetV2.INPUT_TYPES()
        assert list(inputs["required"]) == [
            "model_type", "use_hd", "megapixels", "multiple_of",
            "aspect_ratio", "orientation", "use_image_ratio",
        ]
        assert list(inputs["optional"]) == ["image"]

    @pytest.mark.parametrize("short,orientation,width,height,label", V2_BASELINE)
    def test_orientation_combination_is_reported(self, short, orientation, width, height, label):
        result = V2.HolafResolutionPresetV2().get_resolution(
            "SDXL", False, 2.5, 16, short, orientation, False)
        assert result == (width, height, label)

    def test_hd_variant_keeps_both_dimensions_and_ratio(self):
        width, height, label = V2.HolafResolutionPresetV2().get_resolution(
            "FLUX", True, 2.5, 16, "3:4", True, False)
        assert (width, height) == (1664, 1216)  # FLUX (Quality)
        assert label == "4:3 (landscape)"

    def test_both_nodes_agree_on_the_same_effective_ratio(self):
        """Cohérence v1 ↔ v2 : même couple effectif ⇒ mêmes dims ET même texte."""
        v1 = V1.HolafResolutionPreset().get_resolution(
            "SDXL", "4:3 Landscape (Classic Monitor-Photo)", False)
        v2 = V2.HolafResolutionPresetV2().get_resolution(
            "SDXL", False, 2.5, 16, "3:4", True, False)
        assert v1 == v2

    def test_master_resolution_reports_the_effective_key(self):
        width, height, key = V2.HolafResolutionPresetV2()._master_resolution(
            "SDXL", False, "3:4", False)
        assert (width, height) == (896, 1152)
        assert key == "3:4 Portrait (Classic Monitor-Photo)"


class TestV2MegapixelsMode:
    def test_ratio_is_the_intent_not_the_rounded_pixel_ratio(self):
        """1344×768 est ARRONDI au multiple : « 16:9 » décrit l'intention."""
        width, height, label = V2.HolafResolutionPresetV2().get_resolution(
            "Megapixels", False, 1.0, 64, "9:16", True, False)
        assert (width, height) == (1344, 768)
        assert label == "16:9 (landscape)"
        assert abs(width / height - 16 / 9) > 0.02  # 1.75 ≠ 1.7778 : c'est voulu

    @pytest.mark.parametrize("megapixels,multiple,short,orientation,expected", [
        (2.5, 8, "9:16", True, (2152, 1216, "16:9 (landscape)")),
        (2.5, 16, "9:16", True, (2144, 1216, "16:9 (landscape)")),
        (1.0, 64, "1:1", False, (1024, 1024, "1:1 (square)")),
        (0.25, 8, "9:16", True, (680, 384, "16:9 (landscape)")),
    ])
    def test_dimensions_frozen(self, megapixels, multiple, short, orientation, expected):
        assert V2.HolafResolutionPresetV2().get_resolution(
            "Megapixels", False, megapixels, multiple, short, orientation, False) == expected


class TestV2ImageRatioMode:
    def test_landscape_image_overrides_ui_orientation(self):
        result = V2.HolafResolutionPresetV2().get_resolution(
            "SDXL", False, 2.5, 16, "3:4", False, True, _image(1080, 1920))
        assert result == (1344, 768, "16:9 (landscape)")

    def test_portrait_image_overrides_ui_orientation(self):
        result = V2.HolafResolutionPresetV2().get_resolution(
            "SDXL", False, 2.5, 16, "16:9", True, True, _image(1920, 1080))
        # Le widget « aspect_ratio » de la v2 n'a pas de 16:9 : seul compte le ratio
        # déduit de l'image (9:16 portrait).
        assert result == (768, 1344, "9:16 (portrait)")

    def test_image_ratio_in_megapixels_mode(self):
        width, height, label = V2.HolafResolutionPresetV2().get_resolution(
            "Megapixels", False, 1.0, 64, "1:1", False, True, _image(1080, 1920))
        assert label == "16:9 (landscape)"
        assert (width, height) == (1344, 768)

    def test_invalid_image_dims_keep_the_ui_selection(self):
        result = V2.HolafResolutionPresetV2().get_resolution(
            "SDXL", False, 2.5, 16, "3:4", False, True, _image(0, 1920))
        assert result == (896, 1152, "3:4 (portrait)")


class TestV2RandomMode:
    def test_seeded_draw_is_reported(self):
        seed = 424242
        random.seed(seed)
        drawn = random.choice(V2.FIVE_RATIOS)

        random.seed(seed)
        width, height, label = V2.HolafResolutionPresetV2().get_resolution(
            "SDXL", False, 2.5, 16, "Random", False, False)

        assert label == V1.format_ratio_label(V2.RATIO_KEY_MAP[drawn][0])
        assert (width, height) == V2.MASTER_RESOLUTIONS["SDXL"][V2.RATIO_KEY_MAP[drawn][0]]

    def test_drawn_ratio_with_orientation(self):
        """Le tirage porte sur la forme portrait, l'orientation s'applique après."""
        seed = 99
        random.seed(seed)
        drawn = random.choice(V2.FIVE_RATIOS)

        random.seed(seed)
        _, _, label = V2.HolafResolutionPresetV2().get_resolution(
            "SDXL", False, 2.5, 16, "Random", True, False)

        assert label == V1.format_ratio_label(V2.RATIO_KEY_MAP[drawn][1])

    def test_ratio_is_never_the_widget_token(self):
        known = {V1.format_ratio_label(key) for key in V1.ASPECT_RATIOS}
        node = V2.HolafResolutionPresetV2()
        for seed in range(25):
            random.seed(seed)
            assert node.get_resolution(
                "SDXL", False, 2.5, 16, "Random", False, False)[2] in known


# ════════ 4. Interopérabilité avec le Prompt Enhancer (entrée `ratio`) ══════

class TestPromptEnhancerInterop:
    def test_resolution_output_feeds_the_enhancer_instruction(self):
        """La sortie `ratio` est utilisable TELLE QUELLE comme entrée `ratio`."""
        for model_type, ratio_key in [
            ("SDXL", "16:9 Landscape (HD Video-Widescreen)"),
            ("SDXL", "9:16 Portrait (Mobile Video)"),
            ("SDXL", "1:1 Square (Instagram-Medium Format)"),
        ]:
            ratio_out = V1.HolafResolutionPreset().get_resolution(
                model_type, ratio_key, False)[2]
            instruction = ENHANCE._ratio_instruction(ratio_out)
            assert ratio_out in instruction
            assert instruction.startswith("Target aspect ratio: ")
            assert instruction == (
                f"Target aspect ratio: {ratio_out} — compose for a "
                f"{'wide' if 'landscape' in ratio_out else 'tall' if 'portrait' in ratio_out else 'square'}"
                " frame."
            )

    def test_v2_output_is_wired_the_same_way(self):
        ratio_out = V2.HolafResolutionPresetV2().get_resolution(
            "SDXL", False, 2.5, 16, "3:4", True, False)[2]
        assert ratio_out == "4:3 (landscape)"
        assert ENHANCE._ratio_instruction(ratio_out) == (
            "Target aspect ratio: 4:3 (landscape) — compose for a wide frame.")
