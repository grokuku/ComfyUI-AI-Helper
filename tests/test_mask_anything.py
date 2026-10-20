# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Node expérimentale « AIH Mask Anything » : IMAGE + description → MASK.
#
# Quatre étages de tests, volontairement séparés :
#   1. LOGIQUE PURE (aucun torch) : extraction du JSON noyé, formats acceptés
#      (objet boxes, liste de listes, box_2d [y1,x1,y2,x2] 0-1000, pixels),
#      détection d'unités, clamping, boîtes inversées/dégénérées, doublons,
#      réponses sales qui ne doivent JAMAIS lever ;
#   1bis. RAFFINEMENT SAM3 — LOGIQUE PURE (aucun torch) : marge bornée, remap
#      en espace 1008, règles de repli aux bornes, boîte serrée, clip, dédup de
#      formes, appariement masque ↔ boîte, lecture défensive des widgets ;
#   2. llm_helper : transport multimodal + appel preset serveur ;
#   3. NODE avec torch (``pytest.importorskip``) : forme du masque, union de
#      plusieurs boîtes, feather (valeurs intermédiaires, jamais hors bornes),
#      masque VIDE + message visible sur échec, non-régression du batch,
#      et PREUVE du transport multimodal (l'image part bien dans le message
#      user sous forme de data-URL ``image_url``) ;
#   4. RAFFINEMENT SAM3 avec torch : un FAUX ``forward_segment`` renvoie des
#      logits CHOISIS (aucun poids, aucun GPU) et permet de vérifier le contrat
#      réel de SAM3 — association masque ↔ boîte, repli sur masque vide / trop
#      petit, clip du débordement, modes shape vs bbox, ``max_boxes``, garde de
#      capacité, et « sans SAM3, comportement STRICTEMENT identique ».
#   5. PHASE 2 (crop + batching) : une fenêtre autour de la boîte, un masque
#      recollé à SA position, un lot = une passe, repli en boucle ;
#   6. PHASE 3 (DÉCOUVERTE) — logique PURE puis torch : le prompt
#      ``"<concept>:N"`` ne produit JAMAIS ``:1``, regroupement par portée
#      (``per_box`` / ``union``), texte ANGLAIS (``concept`` optionnel du LLM),
#      masques découverts REMAPPÉS à la fenêtre, dédoublonnage, plafond
#      ``max_boxes``, et « sans ``sam3_clip`` / ``discover=False`` : pixels
#      STRICTEMENT identiques à la phase 2 ».
#
# Contrôles négatifs par mutation : harnais hors dépôt
#   - /projects/.aih_tmp/mask_anything_mutate/mutate.py (8 mutants : parsing,
#     unités, clamping, échec honnête, transport multimodal) ;
#   - /projects/.aih_tmp/mask_anything_sam3_mutate/mutate.py (12 mutants :
#     marge non clampée, masque vide accepté, masque ↔ boîte désassociés, mode
#     bbox rendant la forme, ``sam3_model=None`` qui plante, garde de capacité
#     retirée, marge appliquée sans SAM3, ``max_boxes`` ignoré, débordement non
#     clippé, boîte en pixels d'origine, dédup de formes coupée, logits lus comme
#     des probabilités).
#   - /projects/.aih_tmp/mask_anything_crop_mutate/mutate.py (15 mutants crop +
#     batching) et /projects/.aih_tmp/mask_anything_discover_mutate/mutate.py
#     (phase 3 : prompt sans ``:N``, ``:1`` généré, masques non remappés, dédup
#     coupée, ``discover=False`` qui change le résultat, ``sam3_clip`` absent qui
#     plante, plafond ignoré, seuil ignoré, concept non anglais non utilisé).
#   Chaque mutant doit faire ROUGIR cette suite (restauration + sha256 vérifiés).
#
# Usage :
#   PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh -k mask_anything
#   (torch absent du venv de dev : les tests 3 et 4 sont alors SKIPPED, jamais
#   verts ; pour les exécuter vraiment, cf. le torch CPU hors dépôt)

import sys
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

from aih import llm_helper  # bootstrap sys.path ci-dessus
from nodes import holaf_mask_anything as M

# === 1. Logique pure =======================================================

class TestExtractJson:
    def test_plain_json_object(self):
        payload = M.extract_json('{"boxes":[{"x1":0.1,"y1":0.2,"x2":0.3,"y2":0.4}]}')
        assert payload == {"boxes": [{"x1": 0.1, "y1": 0.2, "x2": 0.3, "y2": 0.4}]}

    def test_json_inside_fence_and_prose(self):
        raw = (
            "Here are the boxes you asked for:\n"
            "```json\n"
            '{"boxes":[{"x1":0.1,"y1":0.2,"x2":0.3,"y2":0.4,"label":"cat"}]}\n'
            "```\n"
            "Let me know if you need more."
        )
        payload = M.extract_json(raw)
        assert payload["boxes"][0]["label"] == "cat"

    def test_json_array_at_root(self):
        assert M.extract_json("[[0.1, 0.2, 0.3, 0.4]]") == [[0.1, 0.2, 0.3, 0.4]]

    def test_trailing_commas_are_repaired(self):
        payload = M.extract_json('{"boxes":[{"x1":0.1,"y1":0.2,"x2":0.3,"y2":0.4},]}')
        assert payload is not None and len(payload["boxes"]) == 1

    def test_json_with_braces_inside_strings(self):
        raw = '{"boxes":[{"label":"a } b","x1":0.1,"y1":0.2,"x2":0.3,"y2":0.4}]}'
        payload = M.extract_json(raw)
        assert payload["boxes"][0]["label"] == "a } b"

    def test_no_json_returns_none(self):
        assert M.extract_json("I cannot see any cat in this image.") is None
        assert M.extract_json("") is None
        assert M.extract_json(None) is None
        assert M.extract_json("{ this is not json ]") is None


class TestToFloat:
    @pytest.mark.parametrize("raw,expected", [
        (0.25, 0.25), (3, 3.0), ("0.5", 0.5), ("12,5", 12.5),
        (" 0.75 ", 0.75), ("x=0.3", 0.3), ("+4", 4.0),
    ])
    def test_numeric_inputs(self, raw, expected):
        assert M._to_float(raw) == pytest.approx(expected)

    @pytest.mark.parametrize("raw", [None, True, False, "", "abc", [], {}, float("nan"), float("inf")])
    def test_non_numeric_inputs(self, raw):
        assert M._to_float(raw) is None


class TestFormats:
    """Toutes les formes de réponse courantes doivent produire la même boîte."""

    def test_boxes_dict_normalized(self):
        boxes, reason = M.parse_boxes(
            '{"boxes":[{"x1":0.1,"y1":0.2,"x2":0.4,"y2":0.5,"label":"cat"}]}', 640, 480)
        assert reason is None and len(boxes) == 1
        box = boxes[0]
        assert (box["x1"], box["y1"], box["x2"], box["y2"]) == pytest.approx((0.1, 0.2, 0.4, 0.5))
        assert box["label"] == "cat"

    def test_list_of_lists(self):
        boxes, reason = M.parse_boxes('[[0.1, 0.2, 0.4, 0.5]]', 640, 480)
        assert reason is None and len(boxes) == 1
        assert boxes[0]["x1"] == pytest.approx(0.1)

    def test_single_bare_box(self):
        boxes, reason = M.parse_boxes('[0.1, 0.2, 0.4, 0.5]', 640, 480)
        assert reason is None and len(boxes) == 1

    def test_box_2d_grid_is_yxyx(self):
        """box_2d = [y1, x1, y2, x2] sur une grille 0-1000 (format Gemini)."""
        boxes, reason = M.parse_boxes('[{"box_2d": [200, 100, 500, 400]}]', 1000, 1000)
        assert reason is None and len(boxes) == 1
        box = boxes[0]
        assert (box["x1"], box["y1"], box["x2"], box["y2"]) == pytest.approx((0.1, 0.2, 0.4, 0.5))

    def test_box_2d_is_not_read_as_normalized(self):
        """CONTRE-ÉPREUVE : 0-1000 ne doit JAMAIS être lu comme du 0-1."""
        boxes, _ = M.parse_boxes('[{"box_2d": [500, 500, 1000, 1000]}]', 1000, 1000)
        assert boxes[0]["x1"] == pytest.approx(0.5)
        assert boxes[0]["y1"] == pytest.approx(0.5)

    def test_pixels(self):
        boxes, reason = M.parse_boxes('{"boxes":[{"x1":64,"y1":96,"x2":256,"y2":240}]}', 640, 480)
        assert reason is None
        box = boxes[0]
        assert (box["x1"], box["y1"], box["x2"], box["y2"]) == pytest.approx((0.1, 0.2, 0.4, 0.5))

    def test_alt_key_names(self):
        for raw in (
            '{"boxes":[{"xmin":0.1,"ymin":0.2,"xmax":0.4,"ymax":0.5}]}',
            '{"boxes":[{"left":0.1,"top":0.2,"right":0.4,"bottom":0.5}]}',
            '{"boxes":[{"box":[0.1,0.2,0.4,0.5]}]}',
            '{"objects":[{"bbox":[0.1,0.2,0.4,0.5],"name":"cat"}]}',
            '{"result":{"boxes":[{"coordinates":[0.1,0.2,0.4,0.5]}]}}',
        ):
            boxes, reason = M.parse_boxes(raw, 640, 480)
            assert reason is None, raw
            assert boxes[0]["x1"] == pytest.approx(0.1), raw

    def test_string_numbers(self):
        boxes, reason = M.parse_boxes(
            '{"boxes":[{"x1":"0.1","y1":"0,2","x2":"0.4","y2":"0.5"}]}', 640, 480)
        assert reason is None and boxes[0]["y1"] == pytest.approx(0.2)


class TestUnits:
    def test_detect_unit_normalized(self):
        assert M._detect_unit([0.1, 0.2, 0.4, 0.5], 1024, 1024) == "norm"

    def test_detect_unit_pixels_inside_image(self):
        assert M._detect_unit([10, 20, 40, 50], 1024, 1024) == "px"

    def test_detect_unit_grid_when_exceeding_image(self):
        # 900 dépasse 512×512 → impossible en pixels → grille 0-1000
        assert M._detect_unit([100, 200, 800, 900], 512, 512) == "grid"

    def test_slightly_above_one_is_not_normalized(self):
        # Règle documentée : au-delà de 1,5 une coordonnée n'est plus 0-1.
        assert M._detect_unit([1.2, 1.4, 1.6, 1.4], 1024, 1024) == "px"
        assert M._detect_unit([1.0, 1.0, 1.5, 1.5], 1024, 1024) == "norm"

    def test_grid_interpretation_when_coords_exceed_image(self):
        boxes, _ = M.parse_boxes('{"boxes":[{"x1":100,"y1":200,"x2":400,"y2":500}]}', 256, 256)
        assert (boxes[0]["x1"], boxes[0]["x2"]) == pytest.approx((0.1, 0.4))


class TestClamping:
    def test_out_of_range_is_clamped(self):
        boxes, reason = M.parse_boxes(
            '{"boxes":[{"x1":0.2,"y1":0.2,"x2":1.4,"y2":1.5}]}', 640, 480)
        assert reason is None
        assert (boxes[0]["x2"], boxes[0]["y2"]) == pytest.approx((1.0, 1.0))

    def test_negative_is_clamped(self):
        boxes, reason = M.parse_boxes(
            '{"boxes":[{"x1":-0.5,"y1":-0.3,"x2":0.5,"y2":0.5}]}', 640, 480)
        assert reason is None
        assert (boxes[0]["x1"], boxes[0]["y1"]) == pytest.approx((0.0, 0.0))

    def test_fully_outside_is_rejected(self):
        boxes, reason = M.parse_boxes(
            '{"boxes":[{"x1":1.2,"y1":1.2,"x2":1.6,"y2":1.6}]}', 640, 480)
        assert boxes == [] and reason == M.REASON_INVALID


class TestDegenerateAndDuplicates:
    def test_zero_size_box_rejected(self):
        boxes, reason = M.parse_boxes(
            '{"boxes":[{"x1":0.5,"y1":0.5,"x2":0.5,"y2":0.5}]}', 640, 480)
        assert boxes == [] and reason == M.REASON_INVALID

    def test_reversed_corners_are_fixed(self):
        boxes, reason = M.parse_boxes(
            '{"boxes":[{"x1":0.4,"y1":0.5,"x2":0.1,"y2":0.2}]}', 640, 480)
        assert reason is None
        assert (boxes[0]["x1"], boxes[0]["y1"], boxes[0]["x2"], boxes[0]["y2"]) == pytest.approx(
            (0.1, 0.2, 0.4, 0.5))

    def test_duplicates_are_merged(self):
        raw = '{"boxes":[{"x1":0.1,"y1":0.2,"x2":0.4,"y2":0.5},' \
              '{"x1":0.101,"y1":0.201,"x2":0.401,"y2":0.501},' \
              '{"x1":0.6,"y1":0.6,"x2":0.9,"y2":0.9}]}'
        boxes, reason = M.parse_boxes(raw, 640, 480)
        assert reason is None
        assert len(boxes) == 2, "les deux boîtes quasi identiques doivent fusionner"

    def test_distinct_boxes_are_kept(self):
        raw = '{"boxes":[{"x1":0.0,"y1":0.0,"x2":0.2,"y2":0.2},{"x1":0.5,"y1":0.5,"x2":0.7,"y2":0.7}]}'
        boxes, _ = M.parse_boxes(raw, 640, 480)
        assert len(boxes) == 2

    def test_iou(self):
        a = {"x1": 0.0, "y1": 0.0, "x2": 0.5, "y2": 0.5}
        assert M.box_iou(a, a) == pytest.approx(1.0)
        assert M.box_iou(a, {"x1": 0.5, "y1": 0.5, "x2": 1.0, "y2": 1.0}) == 0.0
        assert M.box_iou(a, {"x1": 0.25, "y1": 0.25, "x2": 0.75, "y2": 0.75}) == pytest.approx(1 / 7)


class TestReasons:
    """Les 4 causes d'échec doivent être DISTINCTES (l'utilisateur doit comprendre)."""

    def test_empty_response(self):
        assert M.parse_boxes("", 640, 480) == ([], M.REASON_EMPTY)
        assert M.parse_boxes(None, 640, 480) == ([], M.REASON_EMPTY)
        assert M.parse_boxes("   \n ", 640, 480) == ([], M.REASON_EMPTY)

    def test_not_json(self):
        assert M.parse_boxes("Sorry, I can't see that.", 640, 480) == ([], M.REASON_NOT_JSON)

    def test_no_boxes(self):
        assert M.parse_boxes('{"boxes":[]}', 640, 480) == ([], M.REASON_NO_BOXES)
        assert M.parse_boxes('{"note":"nothing found"}', 640, 480) == ([], M.REASON_NO_BOXES)

    def test_invalid_boxes(self):
        assert M.parse_boxes('{"boxes":[{"x1":0.5,"y1":0.5,"x2":0.5,"y2":0.5}]}',
                             640, 480) == ([], M.REASON_INVALID)
        assert M.parse_boxes('{"boxes":["cat"]}', 640, 480) == ([], M.REASON_INVALID)

    def test_reason_messages_are_distinct(self):
        messages = {
            M.AIHMaskAnythingNode._reason_message(reason, "raw")
            for reason in (M.REASON_EMPTY, M.REASON_NOT_JSON, M.REASON_NO_BOXES, M.REASON_INVALID)
        }
        assert len(messages) == 4, "chaque cause doit avoir un message propre"

    def test_dirty_responses_never_raise(self):
        dirty = [
            "null", "[]", "{}", "{{{{", "]]]]", '{"boxes":null}', '{"boxes":"nope"}',
            '{"boxes":[null, 1, "x"]}', '{"boxes":[{"x1":"a","y1":"b","x2":"c","y2":"d"}]}',
            '{"boxes":[{"x1":1e400,"y1":0.1,"x2":1e400,"y2":0.2}]}',
            '{"boxes":[[0.1,0.2]]}', "\x00\x01 impossible", "boxes: 0.1 0.2 0.3 0.4",
        ]
        for raw in dirty:
            boxes, reason = M.parse_boxes(raw, 640, 480)
            assert isinstance(boxes, list)
            assert reason is None or reason in (
                M.REASON_EMPTY, M.REASON_NOT_JSON, M.REASON_NO_BOXES, M.REASON_INVALID)


class TestUserPrompt:
    def test_prompt_carries_description_and_size(self):
        prompt = M.build_user_prompt("le chat noir et la lampe", 1024, 768)
        assert "le chat noir et la lampe" in prompt
        assert "1024x768" in prompt

    def test_system_prompt_demands_only_json_and_normalized_coords(self):
        assert "ONLY a JSON object" in M.SYSTEM_PROMPT
        assert "NORMALIZED" in M.SYSTEM_PROMPT
        assert '"boxes"' in M.SYSTEM_PROMPT

    def test_system_prompt_asks_for_an_optional_english_concept(self):
        """Le schéma JSON demande ``concept`` (anglais) SANS casser ``label``.

        L'encodeur texte de SAM3 est un CLIP anglais : le concept doit être un
        groupe nominal anglais court. Le champ reste OPTIONNEL (le prompt le dit
        explicitement) pour ne pas casser un LLM qui ne le renvoie pas.
        """
        assert '"concept"' in M.SYSTEM_PROMPT
        assert '"label"' in M.SYSTEM_PROMPT
        assert "OPTIONAL" in M.SYSTEM_PROMPT
        assert "ENGLISH" in M.SYSTEM_PROMPT


class TestNodeContract:
    def test_single_registration_key(self):
        assert list(M.NODE_CLASS_MAPPINGS) == ["AIHMaskAnything"]
        assert M.NODE_DISPLAY_NAME_MAPPINGS == {"AIHMaskAnything": "AIH Mask Anything"}

    def test_inputs_and_outputs(self):
        types = M.AIHMaskAnythingNode.INPUT_TYPES()
        assert types["required"]["image"] == ("IMAGE",)
        assert types["required"]["text"][0] == "STRING"
        assert types["required"]["text"][1]["multiline"] is True
        assert types["required"]["preset_id"][0] == "INT"
        assert types["optional"]["llm_config"][1]["forceInput"] is True
        assert M.AIHMaskAnythingNode.RETURN_TYPES == ("MASK", "IMAGE")
        assert M.AIHMaskAnythingNode.RETURN_NAMES == ("mask", "boxes_preview")
        assert M.AIHMaskAnythingNode.CATEGORY == "AIH/Masking"

    def test_sam3_widgets_come_after_seed(self):
        """Ordre des widgets : les nouveaux passent APRÈS seed.

        Un widget inséré AVANT décalerait les ``widgets_values`` des workflows
        existants (feather/seed retrouveraient la valeur du voisin).
        """
        required = list(M.AIHMaskAnythingNode.INPUT_TYPES()["required"])
        assert required[:5] == ["image", "text", "preset_id", "feather", "seed"]
        assert required[5:] == ["mask_mode", "expand_px", "min_area_pct",
                                "sam_refine", "max_boxes",
                                "sam_crop", "crop_margin", "sam_batch",
                                "min_crop_px",
                                "discover", "discover_count", "discover_scope",
                                "discover_threshold"]

    def test_phase2_widgets_are_appended_after_phase1(self):
        """Les 4 widgets de la phase 2 viennent APRÈS les 5 de la phase 1.

        MUTANT : un widget inséré avant ``max_boxes`` décalerait les
        ``widgets_values`` des workflows déjà enregistrés.
        """
        required = list(M.AIHMaskAnythingNode.INPUT_TYPES()["required"])
        phase1 = ["mask_mode", "expand_px", "min_area_pct", "sam_refine", "max_boxes"]
        phase2 = ["sam_crop", "crop_margin", "sam_batch", "min_crop_px"]
        assert required[5:10] == phase1
        assert required[10:14] == phase2

    def test_phase3_widgets_are_appended_after_phase2(self):
        """Les 4 widgets de la phase 3 viennent APRÈS ``min_crop_px``.

        MUTANT : un widget de découverte inséré avant ``min_crop_px`` décalerait
        les ``widgets_values`` des workflows de la phase 2 déjà enregistrés.
        """
        required = list(M.AIHMaskAnythingNode.INPUT_TYPES()["required"])
        assert required[14:] == ["discover", "discover_count",
                                 "discover_scope", "discover_threshold"]
        assert required.index("discover") > required.index("min_crop_px")

    def test_phase3_defaults(self):
        """Défauts de la découverte : DÉSACTIVÉE, donc comportement inchangé."""
        types = M.AIHMaskAnythingNode.INPUT_TYPES()
        discover = types["required"]["discover"]
        assert discover[0] == "BOOLEAN" and discover[1]["default"] is False
        count = types["required"]["discover_count"]
        assert count[0] == "INT" and count[1]["default"] == 8
        assert (count[1]["min"], count[1]["max"]) == (1, 32)
        scope = types["required"]["discover_scope"]
        assert scope[0] == ["per_box", "union"]
        assert scope[1]["default"] == "per_box"
        threshold = types["required"]["discover_threshold"]
        assert threshold[0] == "FLOAT" and threshold[1]["default"] == 0.4
        assert (threshold[1]["min"], threshold[1]["max"]) == (0.0, 1.0)

    def test_sam3_clip_is_an_optional_clip_socket(self):
        """``sam3_clip`` est un socket CLIP OPTIONNEL (la node ne charge rien)."""
        optional = M.AIHMaskAnythingNode.INPUT_TYPES()["optional"]
        assert optional["sam3_clip"][0] == "CLIP"
        assert "sam3_clip" not in M.AIHMaskAnythingNode.INPUT_TYPES()["required"]

    def test_phase2_defaults(self):
        types = M.AIHMaskAnythingNode.INPUT_TYPES()
        crop = types["required"]["sam_crop"]
        assert crop[0] == "BOOLEAN" and crop[1]["default"] is True
        margin = types["required"]["crop_margin"]
        assert margin[0] == "INT" and margin[1]["default"] == 30
        assert (margin[1]["min"], margin[1]["max"]) == (0, 100)
        batch = types["required"]["sam_batch"]
        assert batch[0] == "INT" and batch[1]["default"] == 1
        assert (batch[1]["min"], batch[1]["max"]) == (1, 16)
        floor = types["required"]["min_crop_px"]
        assert floor[0] == "INT" and floor[1]["default"] == 128
        assert (floor[1]["min"], floor[1]["max"]) == (32, 1024)

    def test_sam3_defaults_keep_the_previous_behaviour(self):
        types = M.AIHMaskAnythingNode.INPUT_TYPES()
        assert types["required"]["mask_mode"][0] == ["shape", "bbox"]
        assert types["required"]["mask_mode"][1]["default"] == "shape"
        assert types["required"]["expand_px"][1]["default"] == 8
        assert types["required"]["expand_px"][1]["min"] == 0
        assert types["required"]["expand_px"][1]["max"] == 256
        assert types["required"]["min_area_pct"][1]["default"] == 3
        assert types["required"]["min_area_pct"][1]["max"] == 100
        assert types["required"]["sam_refine"][1]["default"] is True
        assert types["required"]["max_boxes"][1]["default"] == 16
        assert types["required"]["max_boxes"][1]["min"] == 1
        assert types["required"]["max_boxes"][1]["max"] == 64

    def test_sam3_model_is_an_optional_model_socket(self):
        optional = M.AIHMaskAnythingNode.INPUT_TYPES()["optional"]
        assert optional["sam3_model"][0] == "MODEL"
        # … et il n'est PAS requis : sans lui la node fonctionne comme avant.
        assert "sam3_model" not in M.AIHMaskAnythingNode.INPUT_TYPES()["required"]


# === 1bis. Raffinement SAM3 : logique PURE (sans torch) ====================


class TestWidgetCoercion:
    """Anciens workflows / appels API partiels : jamais de plantage."""

    @pytest.mark.parametrize("raw,expected", [
        (None, 8), ("12", 12), (12.4, 12), ("abc", 8), (999, 256), (-5, 0),
    ])
    def test_coerce_int_clamps_and_defaults(self, raw, expected):
        assert M.coerce_int(raw, 8, 0, 256) == expected

    @pytest.mark.parametrize("raw,expected", [
        (None, True), (True, True), (False, False), ("false", False),
        ("true", True), ("0", False), ("1", True), (0, False), ("bof", True),
    ])
    def test_coerce_bool(self, raw, expected):
        assert M.coerce_bool(raw, True) is expected

    def test_coerce_choice(self):
        assert M.coerce_choice("bbox", M.MASK_MODES, "shape") == "bbox"
        assert M.coerce_choice(" BBOX ", M.MASK_MODES, "shape") == "bbox"
        assert M.coerce_choice(None, M.MASK_MODES, "shape") == "shape"
        assert M.coerce_choice("nawak", M.MASK_MODES, "shape") == "shape"


class TestExpandBox:
    def test_margin_is_applied_on_both_axes_separately(self):
        """Sur une image non carrée la même marge en pixels ≠ même fraction."""
        box = {"x1": 0.4, "y1": 0.4, "x2": 0.6, "y2": 0.6}
        grown = M.expand_box(box, 10, 100, 200)
        assert grown["x1"] == pytest.approx(0.4 - 10 / 100)
        assert grown["x2"] == pytest.approx(0.6 + 10 / 100)
        assert grown["y1"] == pytest.approx(0.4 - 10 / 200)
        assert grown["y2"] == pytest.approx(0.6 + 10 / 200)

    def test_margin_is_clamped_to_the_image(self):
        """MUTANT : marge non clampée → coordonnées négatives / > 1."""
        grown = M.expand_box({"x1": 0.01, "y1": 0.01, "x2": 0.02, "y2": 0.02},
                             64, 100, 100)
        assert grown["x1"] == 0.0 and grown["y1"] == 0.0
        grown = M.expand_box({"x1": 0.98, "y1": 0.98, "x2": 0.99, "y2": 0.99},
                             64, 100, 100)
        assert grown["x2"] == 1.0 and grown["y2"] == 1.0

    def test_zero_margin_is_identity(self):
        box = {"x1": 0.1, "y1": 0.2, "x2": 0.3, "y2": 0.4, "label": "chat"}
        grown = M.expand_box(box, 0, 640, 480)
        assert grown == box
        assert grown is not box, "copie : la boîte d'origine n'est pas modifiée"

    def test_label_survives(self):
        grown = M.expand_box({"x1": 0.1, "y1": 0.1, "x2": 0.2, "y2": 0.2,
                              "label": "lamp"}, 8, 640, 480)
        assert grown["label"] == "lamp"

    def test_malformed_box_is_returned_untouched(self):
        assert M.expand_box({"x1": 0.1}, 8, 640, 480) == {"x1": 0.1}
        assert M.expand_box(None, 8, 640, 480) is None


class TestSam3Space:
    def test_box_to_1008_scales_both_axes(self):
        assert M.box_to_1008({"x1": 0.0, "y1": 0.5, "x2": 1.0, "y2": 0.75}) == (
            0.0, 504.0, 1008.0, 756.0)

    def test_box_to_1008_does_not_mix_width_and_height(self):
        """MUTANT : x mis à l'échelle par la hauteur (piège classique)."""
        px1, py1, px2, py2 = M.box_to_1008({"x1": 0.25, "y1": 0.25,
                                            "x2": 0.75, "y2": 0.75})
        assert (px1, px2) == pytest.approx((252.0, 756.0))
        assert (py1, py2) == pytest.approx((252.0, 756.0))

    def test_box_window_px_is_bounded_and_ordered(self):
        assert M.box_window_px({"x1": 0.0, "y1": 0.0, "x2": 0.5, "y2": 0.5},
                               100, 100) == (0, 0, 50, 50)
        assert M.box_window_px({"x1": -1.0, "y1": -1.0, "x2": 2.0, "y2": 2.0},
                               100, 100) == (0, 0, 100, 100)

    def test_box_area_px(self):
        assert M.box_area_px((10, 5, 30, 25)) == 400
        assert M.box_area_px((10, 5, 10, 25)) == 0


class TestValidationRules:
    """Les 3 règles chiffrées de repli (bornes INCLUSES côté « gardé »)."""

    def test_mask_area_ratio(self):
        assert M.mask_area_ratio(50, 100) == pytest.approx(0.5)
        assert M.mask_area_ratio(10, 0) == 0.0, "boîte dégénérée → 0, jamais ZeroDivision"

    def test_empty_mask_falls_back(self):
        """MUTANT : repli qui accepte un masque vide → plus aucun garde-fou."""
        assert M.should_fallback(0, 100, 3) == M.VERDICT_EMPTY

    def test_too_small_mask_falls_back(self):
        assert M.should_fallback(2, 100, 3) == M.VERDICT_SMALL
        assert M.should_fallback(2, 100, 3) != M.VERDICT_KEEP

    def test_exact_min_area_is_kept(self):
        assert M.should_fallback(3, 100, 3) == M.VERDICT_KEEP
        assert M.should_fallback(29, 1000, 3) == M.VERDICT_SMALL

    def test_overflow_is_clipped_and_borderline_kept(self):
        assert M.should_fallback(400, 100, 3) == M.VERDICT_KEEP
        assert M.should_fallback(401, 100, 3) == M.VERDICT_CLIP
        assert M.should_fallback(1000, 100, 3) == M.VERDICT_CLIP

    def test_degenerate_box_falls_back(self):
        assert M.should_fallback(10, 0, 3) == M.VERDICT_SMALL

    def test_min_area_zero_keeps_any_non_empty_mask(self):
        assert M.should_fallback(1, 10000, 0) == M.VERDICT_KEEP


class TestTightBox:
    def test_tight_box_from_bounds(self):
        assert M.tight_box_from_mask((10, 20, 60, 40), 100, 200) == {
            "x1": 0.1, "y1": 0.1, "x2": 0.6, "y2": 0.2}

    def test_empty_or_degenerate_bounds_have_no_box(self):
        assert M.tight_box_from_mask(None, 100, 100) is None
        assert M.tight_box_from_mask((10, 10, 10, 40), 100, 100) is None
        assert M.tight_box_from_mask((10, 10, 40, 10), 100, 100) is None
        assert M.tight_box_from_mask((10, 10, 40, 40), 0, 100) is None

    def test_tight_box_is_clamped(self):
        box = M.tight_box_from_mask((-10, -10, 200, 200), 100, 100)
        assert (box["x1"], box["y1"], box["x2"], box["y2"]) == (0.0, 0.0, 1.0, 1.0)


class TestClipMask:
    """``clip_mask_to_window`` : fonctionne sur une LISTE plate (ici, sans torch)."""

    def _grid(self, width, height, off_rows=()):
        return [0 if row in off_rows else 1 for row in range(height) for _ in range(width)]

    def test_outside_the_window_is_zeroed(self):
        cells = self._grid(4, 4)
        clipped = M.clip_mask_to_window(cells, (1, 1, 3, 3), 4, 4)
        rows = [clipped[index * 4:(index + 1) * 4] for index in range(4)]
        assert rows[0] == [0, 0, 0, 0]
        assert rows[1] == [0, 1, 1, 0]
        assert rows[2] == [0, 1, 1, 0]
        assert rows[3] == [0, 0, 0, 0]

    def test_input_is_not_modified(self):
        cells = [1] * 16
        M.clip_mask_to_window(cells, (1, 1, 3, 3), 4, 4)
        assert cells == [1] * 16, "masque d'entrée cloné, jamais modifié sur place"

    def test_full_window_keeps_everything(self):
        cells = [1] * 16
        assert M.clip_mask_to_window(cells, (0, 0, 4, 4), 4, 4) == cells

    def test_empty_window_zeroes_everything(self):
        assert M.clip_mask_to_window([1] * 16, (2, 2, 2, 2), 4, 4) == [0] * 16


class TestDedupeMasks:
    """``dedupe_masks`` : sur des ENSEMBLES de pixels (aucun torch)."""

    def test_identical_masks_are_merged(self):
        merged = M.dedupe_masks([{1, 2, 3}, {1, 2, 3}])
        assert merged == [{1, 2, 3}]

    def test_distinct_masks_are_kept_in_order(self):
        merged = M.dedupe_masks([{1, 2}, {3, 4}, {9}])
        assert merged == [{1, 2}, {3, 4}, {9}]

    def test_threshold_is_085(self):
        # IoU = 9/11 ≈ 0.818 < 0.85 → conservés
        assert len(M.dedupe_masks([set(range(10)), set(range(1, 11))])) == 2
        # IoU = 12/14 ≈ 0.857 ≥ 0.85 → fusionnés
        assert len(M.dedupe_masks([set(range(13)), set(range(1, 14))])) == 1

    def test_overlapping_masks_are_unioned(self):
        # IoU = 6/7 ≈ 0.857 ≥ 0.85 → union des deux
        merged = M.dedupe_masks([{0, 1, 2, 3, 4, 5}, {0, 1, 2, 3, 4, 5, 6}])
        assert merged == [{0, 1, 2, 3, 4, 5, 6}]

    def test_single_mask_is_untouched(self):
        assert M.dedupe_masks([{7}]) == [{7}]
        assert M.dedupe_masks([]) == []


class TestPairBoxesMasks:
    """L'association masque ↔ boîte est POSITIONNELLE : 1:1 ou rien."""

    def test_positional_pairing(self):
        pairs = M.pair_boxes_masks(["a", "b"], ["mask_a", None])
        assert pairs == [("a", "mask_a"), ("b", None)]

    def test_length_mismatch_is_refused(self):
        """MUTANT : ``zip`` nu (troncature silencieuse) → décalage possible."""
        assert M.pair_boxes_masks(["a", "b"], ["mask_a"]) is None
        assert M.pair_boxes_masks(["a"], None) is None

    def test_empty_lists_are_valid(self):
        assert M.pair_boxes_masks([], []) == []


# === 2. llm_helper : transport multimodal + appel preset serveur ============

class _FakeResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self.ok = 200 <= status_code < 300
        self._payload = payload
        self.text = text

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


class TestBackendPresetCall:
    """``call_backend_preset`` : messages relayés, échecs rendus (jamais levés)."""

    def test_messages_and_image_reach_the_provider(self, monkeypatch):
        captured = {}

        def fake_post(url, json=None, headers=None, timeout=None):
            captured.update(url=url, body=json, headers=headers or {})
            return _FakeResponse(payload={"output": '{"boxes":[]}'})

        monkeypatch.setattr(llm_helper.requests, "post", fake_post)
        content = llm_helper.build_image_content("locate", "QUJD")
        messages = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": content},
        ]
        output, error = llm_helper.call_backend_preset(
            "https://aih.example/api", "KEY", 7, messages=messages)

        assert error is None and output == '{"boxes":[]}'
        assert captured["url"] == "https://aih.example/api/keywords/llm-process"
        assert captured["headers"]["Authorization"] == "Bearer KEY"
        assert captured["body"]["preset_id"] == 7
        assert captured["body"]["messages"] == messages
        image_part = captured["body"]["messages"][1]["content"][1]
        assert image_part["type"] == "image_url"
        assert image_part["image_url"]["url"] == "data:image/png;base64,QUJD"

    def test_no_messages_uses_instruction(self, monkeypatch):
        captured = {}

        def fake_post(url, json=None, headers=None, timeout=None):
            captured.update(body=json)
            return _FakeResponse(payload={"output": "ok"})

        monkeypatch.setattr(llm_helper.requests, "post", fake_post)
        llm_helper.call_backend_preset("https://x/api", "", 3, instruction="do it", input_text="txt")
        assert captured["body"] == {"preset_id": 3, "instruction": "do it", "input_text": "txt"}

    def test_network_error_is_returned_not_raised(self, monkeypatch):
        def boom(*args, **kwargs):
            raise OSError("connection refused")

        monkeypatch.setattr(llm_helper.requests, "post", boom)
        output, error = llm_helper.call_backend_preset("https://x/api", "K", 1, instruction="i")
        assert output is None and "injoignable" in error

    def test_http_error_detail_is_returned(self, monkeypatch):
        monkeypatch.setattr(
            llm_helper.requests, "post",
            lambda *a, **k: _FakeResponse(400, {"error": "Ce preset n'est pas visuel"}))
        output, error = llm_helper.call_backend_preset("https://x/api", "K", 1, instruction="i")
        assert output is None and "400" in error and "visuel" in error

    def test_empty_output_is_an_error(self, monkeypatch):
        monkeypatch.setattr(llm_helper.requests, "post",
                            lambda *a, **k: _FakeResponse(payload={"output": "  "}))
        output, error = llm_helper.call_backend_preset("https://x/api", "K", 1, instruction="i")
        assert output is None and "vide" in error

    def test_missing_server_url(self):
        output, error = llm_helper.call_backend_preset("", "K", 1, instruction="i")
        assert output is None and "non configuré" in error


class TestImageContent:
    def test_build_image_content_shape(self):
        content = llm_helper.build_image_content("hello", "QUJD")
        assert content[0] == {"type": "text", "text": "hello"}
        assert content[1]["image_url"]["url"].startswith("data:image/png;base64,")

    def test_image_hint_is_opt_in(self):
        """Le hint « prompt enhancer » ne doit PAS polluer une autre tâche."""
        default = llm_helper._build_user_content("p", "QUJD")
        assert llm_helper.IMAGE_REFERENCE_HINT in default[0]["text"]
        custom = llm_helper._build_user_content("p", "QUJD", image_hint="")
        assert custom[0]["text"] == "p"
        assert llm_helper._build_user_content("p", None) == "p"


# === 3. Node avec torch ====================================================
# torch est ABSENT du venv de dev : chaque test qui en dépend passe par
# ``_torch()`` (``pytest.importorskip``) → SKIPPED explicite, jamais un faux vert,
# et les tests de logique pure ci-dessus restent exécutés.

def _torch():
    """VRAI torch ou SKIP explicite (la logique pure reste exécutée sans lui).

    Double garde : le venv de dev n'a pas torch ET un autre fichier de tests du
    pack injecte un STUB ``torch`` dans sys.modules (test_remote_comparer_path).
    Un stub ne sait pas créer de tenseurs → on SKIPPE au lieu de tester à vide.
    """
    module = pytest.importorskip("torch", reason="MASK/IMAGE : torch absent du venv de dev")
    if not hasattr(module, "rand"):
        pytest.skip("stub torch (venv de dev) : MASK/IMAGE nécessite le vrai torch")
    return module


_requires_torch = pytest.mark.usefixtures("torch_fixture")


@pytest.fixture
def torch_fixture():
    return _torch()


BOXES_JSON = (
    '{"boxes":[{"x1":0.1,"y1":0.2,"x2":0.4,"y2":0.5,"label":"cat"},'
    '{"x1":0.6,"y1":0.6,"x2":0.8,"y2":0.9,"label":"lamp"}]}'
)


def _image(batch=1, height=64, width=96):
    torch = _torch()
    return torch.rand((batch, height, width, 3), dtype=torch.float32)


@pytest.fixture
def node():
    return M.AIHMaskAnythingNode()


@pytest.fixture
def server_env(monkeypatch):
    """Serveur AIH configuré + réponse LLM programmable."""
    monkeypatch.setattr(M.credentials, "get_api_url", lambda: "https://aih.example/api")
    monkeypatch.setattr(M.credentials, "get_api_key", lambda: "KEY")
    calls = {}

    def fake_backend(api_url, api_key, preset_id, **kwargs):
        calls.update(api_url=api_url, api_key=api_key, preset_id=preset_id, kwargs=kwargs)
        return calls.get("output"), calls.get("error")

    monkeypatch.setattr(M.llm_helper, "call_backend_preset", fake_backend)
    return calls


@_requires_torch
class TestMaskGeneration:
    def test_mask_shape_and_binary(self, node, server_env):
        server_env["output"] = BOXES_JSON
        result = node.mask(_image(), "the cat and the lamp", preset_id=3, feather=0)
        masks, preview = result["result"]
        assert masks.shape == (1, 64, 96)
        assert masks.dtype == _torch().float32
        assert set(masks.unique().tolist()) == {0.0, 1.0}, "masque strictement 0/1 sans feather"
        assert preview.shape == (1, 64, 96, 3)
        assert "2 boîte(s)" in result["ui"]["status"][0]

    def test_union_of_boxes(self, node, server_env):
        server_env["output"] = BOXES_JSON
        masks, _ = node.mask(_image(), "d", preset_id=3)["result"]
        mask = masks[0]
        # centre des deux boîtes = blanc, hors boîtes = noir
        assert mask[round(0.35 * 64), round(0.25 * 96)].item() == 1.0
        assert mask[round(0.75 * 64), round(0.70 * 96)].item() == 1.0
        assert mask[2, 2].item() == 0.0
        assert mask[63, 95].item() == 0.0

    def test_single_box_pixels_are_converted(self, node, server_env):
        server_env["output"] = '{"boxes":[{"x1":9,"y1":6,"x2":48,"y2":32}]}'
        masks, _ = node.mask(_image(), "d", preset_id=1)["result"]
        mask = masks[0]
        assert mask[6:32, 9:48].min().item() == 1.0
        assert mask[0:5, :].max().item() == 0.0

    def test_feather_softens_edges(self, node, server_env):
        server_env["output"] = BOXES_JSON
        masks, _ = node.mask(_image(), "d", preset_id=3, feather=3)["result"]
        values = masks.unique()
        assert values.min().item() >= 0.0 and values.max().item() <= 1.0
        assert ((values > 0.0) & (values < 1.0)).any().item(), "le feather doit créer des valeurs intermédiaires"
        assert masks[0].max().item() == pytest.approx(1.0, abs=1e-2)

    def test_feather_does_not_overflow_on_tiny_image(self, node, server_env):
        server_env["output"] = BOXES_JSON
        masks, _ = node.mask(_image(height=8, width=8), "d", preset_id=3, feather=128)["result"]
        assert masks.shape == (1, 8, 8)
        assert masks.min().item() >= 0.0 and masks.max().item() <= 1.0

    def test_batch_is_preserved(self, node, server_env):
        server_env["output"] = BOXES_JSON
        masks, preview = node.mask(_image(batch=3), "d", preset_id=3)["result"]
        assert masks.shape == (3, 64, 96)
        assert preview.shape[0] == 3
        torch = _torch()
        assert torch.equal(masks[0], masks[1]) and torch.equal(masks[1], masks[2])

    def test_preview_draws_red_border(self, node, server_env):
        server_env["output"] = '{"boxes":[{"x1":0.0,"y1":0.0,"x2":0.5,"y2":0.5}]}'
        torch = _torch()
        image = torch.ones((1, 64, 96, 3), dtype=torch.float32)
        _, preview = node.mask(image, "d", preset_id=3)["result"]
        assert torch.equal(image, torch.ones_like(image)), "l'image d'entrée ne doit pas être modifiée"
        assert preview[0, 0, 0, 0].item() == pytest.approx(1.0)
        assert preview[0, 0, 0, 1].item() < 0.5, "bordure rouge attendue sur le coin de la boîte"

    def test_multimodal_message_is_sent(self, node, server_env):
        """PREUVE : l'image part dans le message user (data-URL image_url)."""
        server_env["output"] = BOXES_JSON
        node.mask(_image(), "the cat", preset_id=5)
        messages = server_env["kwargs"]["messages"]
        assert messages[0]["role"] == "system"
        assert messages[0]["content"] == M.SYSTEM_PROMPT
        parts = messages[1]["content"]
        assert parts[0]["type"] == "text" and "the cat" in parts[0]["text"]
        assert parts[1]["type"] == "image_url"
        assert parts[1]["image_url"]["url"].startswith("data:image/png;base64,")
        assert server_env["preset_id"] == 5


@_requires_torch
class TestLocalConfigPath:
    def test_llm_config_uses_local_helper_with_image(self, node, monkeypatch):
        captured = {}

        def fake_call_llm(config, system_prompt, user_prompt, seed=None,
                          image_base64=None, image_hint=None):
            captured.update(config=config, system=system_prompt, user=user_prompt,
                            seed=seed, image=image_base64, hint=image_hint)
            return BOXES_JSON

        monkeypatch.setattr(M.llm_helper, "call_llm", fake_call_llm)
        masks, _ = node.mask(_image(), "the cat", preset_id=0, seed=42,
                             llm_config='{"type":"openai","base_url":"http://x","model":"m"}')["result"]
        assert masks.shape == (1, 64, 96)
        assert captured["seed"] == 42
        assert captured["image"], "l'image doit être encodée en base64"
        assert captured["hint"] == M.IMAGE_HINT
        assert "the cat" in captured["user"]

    def test_local_llm_failure_is_reported(self, node, monkeypatch):
        def boom(*args, **kwargs):
            raise OSError("LM Studio éteint")

        monkeypatch.setattr(M.llm_helper, "call_llm", boom)
        result = node.mask(_image(), "the cat", llm_config='{"type":"lmstudio"}')
        masks, _ = result["result"]
        assert masks.abs().sum().item() == 0.0
        assert "LLM local injoignable" in result["ui"]["status"][0]


@_requires_torch
class TestHonestFailures:
    """Aucun échec ne doit crasher : masque vide + message VISIBLE + cause."""

    def _assert_empty(self, result, batch=1, height=64, width=96):
        masks, preview = result["result"]
        assert masks.shape == (batch, height, width)
        assert masks.abs().sum().item() == 0.0, "échec → masque de ZÉROS"
        assert preview.shape[0] == batch
        assert result["ui"]["status"], "un message doit être visible"
        assert result["ui"]["status"][0].startswith("⚠️")

    def test_empty_text(self, node, server_env):
        result = node.mask(_image(), "   ", preset_id=3)
        self._assert_empty(result)
        assert "texte vide" in result["ui"]["status"][0]

    def test_no_preset_selected(self, node, server_env):
        result = node.mask(_image(), "the cat", preset_id=0)
        self._assert_empty(result)
        assert "aucun preset IA" in result["ui"]["status"][0]
        assert server_env.get("kwargs") is None, "aucun appel réseau sans preset"

    def test_server_unreachable(self, node, server_env):
        server_env["error"] = "serveur LLM injoignable (connection refused)"
        result = node.mask(_image(), "the cat", preset_id=3)
        self._assert_empty(result)
        assert "injoignable" in result["ui"]["status"][0]

    def test_model_returns_prose(self, node, server_env):
        server_env["output"] = "I see a cat on the left side of the image."
        result = node.mask(_image(), "the cat", preset_id=3)
        self._assert_empty(result)
        assert "non JSON" in result["ui"]["status"][0]

    def test_model_returns_no_boxes(self, node, server_env):
        server_env["output"] = '{"boxes":[]}'
        result = node.mask(_image(), "a dragon", preset_id=3)
        self._assert_empty(result)
        assert "aucune boîte" in result["ui"]["status"][0]

    def test_model_returns_degenerate_box(self, node, server_env):
        server_env["output"] = '{"boxes":[{"x1":0.5,"y1":0.5,"x2":0.5,"y2":0.5}]}'
        result = node.mask(_image(), "the cat", preset_id=3)
        self._assert_empty(result)
        assert "invalides" in result["ui"]["status"][0]

    def test_failure_keeps_batch(self, node, server_env):
        server_env["error"] = "boum"
        self._assert_empty(node.mask(_image(batch=4), "the cat", preset_id=3), batch=4)

    def test_failure_logs_with_prefix(self, node, server_env, caplog):
        server_env["error"] = "boum"
        with caplog.at_level("WARNING"):
            node.mask(_image(), "the cat", preset_id=3)
        assert any(M.LOG_PREFIX in record.message for record in caplog.records)

    def test_invalid_image_shape_raises_clearly(self, node):
        with pytest.raises(ValueError, match="IMAGE attendue"):
            node.mask(_torch().zeros((2, 2)), "the cat", preset_id=3)


@_requires_torch
class TestImageEncoding:
    def test_encoder_returns_png_base64(self):
        encoded = llm_helper.image_tensor_to_base64(_image())
        assert isinstance(encoded, str) and encoded.startswith("iVBORw0KGgo"), "signature PNG"

    def test_encoder_downscales_above_one_megapixel(self):
        import base64

        from PIL import Image
        encoded = llm_helper.image_tensor_to_base64(_torch().zeros((1, 1200, 1600, 3)))
        buffer = __import__("io").BytesIO(base64.b64decode(encoded))
        with Image.open(buffer) as opened:
            assert opened.size[0] * opened.size[1] <= llm_helper.VISION_MAX_PIXELS
            assert opened.size[0] > opened.size[1], "ratio conservé"


# === 4. Raffinement SAM3 (faux ``forward_segment``) ========================
# Aucun checkpoint, aucun GPU : un FAUX ``diffusion_model`` renvoie des logits
# CHOISIS. C'est le seul moyen de vérifier le contrat réel de SAM3
# (``forward_segment(images, box_inputs=[1,2,2])`` → logits ``[1,1,1008,1008]``,
# ``> 0`` = dans l'objet) sans télécharger 1,6 Gio de poids.
#
# Les masques de référence sont exprimés en rectangles NORMALISÉS (0-1) de
# l'image d'entrée : le faux modèle les reprojette en espace 1008×1008, comme
# le fait le vrai (les logits sont ensuite rééchantillonnés à la taille image).

SAM3_W, SAM3_H = 96, 64


class _FakeUnet:
    """Faux ``diffusion_model`` : 1 appel = 1 boîte = 1 rectangle (ou None = vide)."""

    def __init__(self, shapes=None, error=None, out_shape=None):
        # shapes[i] = liste de rectangles normalisés pour le i-ème appel
        #             (None ou [] = objet absent → logits tous négatifs)
        self.shapes = list(shapes or [])
        self.error = error
        self.out_shape = out_shape
        self.calls = []

    def forward_segment(self, image, point_inputs=None, box_inputs=None, mask_inputs=None):
        self.calls.append({
            "image_shape": tuple(image.shape),
            "box_shape": None if box_inputs is None else tuple(box_inputs.shape),
            "box": None if box_inputs is None else box_inputs.tolist(),
            "points": point_inputs,
            "masks": mask_inputs,
        })
        if self.error is not None:
            raise self.error
        torch = _torch()
        if self.out_shape is not None:
            return torch.zeros(self.out_shape)
        logits = torch.full((1, 1, M.SAM3_SIZE, M.SAM3_SIZE), -1.0)
        index = min(len(self.calls) - 1, len(self.shapes) - 1)
        for rect in self.shapes[index] or []:
            x1, y1, x2, y2 = (round(value * M.SAM3_SIZE) for value in rect)
            # +0,3 : SAM3 sort des LOGITS (pas des probabilités). Une valeur
            # strictement positive mais < 0,5 est « dans l'objet » pour SAM3 et
            # ne l'est pas pour un seuil de probabilité → détecte la confusion.
            logits[0, 0, y1:y2, x1:x2] = 0.3
        return logits


class _FakeModel:
    """Faux MODEL ComfyUI : ``get_model_object`` est le SEUL point d'entrée utilisé."""

    def __init__(self, unet):
        self.unet = unet
        self.requested = []

    def get_model_object(self, name):
        self.requested.append(name)
        return self.unet


def _sam3(shapes=None, **kwargs):
    """MODEL factice + son faux unet (pour inspecter les appels)."""
    unet = _FakeUnet(shapes, **kwargs)
    return _FakeModel(unet), unet


def _black(batch=1):
    return _torch().zeros((batch, SAM3_H, SAM3_W, 3), dtype=_torch().float32)


BOXES_2 = (
    '{"boxes":[{"x1":0.02,"y1":0.02,"x2":0.45,"y2":0.45,"label":"a"},'
    '{"x1":0.55,"y1":0.55,"x2":0.95,"y2":0.95,"label":"b"}]}'
)
# Rectangles détourés par le faux SAM3 : bien À L'INTÉRIEUR des deux boîtes,
# et assez grands pour dépasser le seuil de 3 % d'aire de la boîte.
SHAPE_A = (0.10, 0.10, 0.20, 0.20)
SHAPE_B = (0.70, 0.70, 0.80, 0.80)


@_requires_torch
class TestSam3Association:
    """Le point le plus fragile du montage : QUEL masque va sur QUELLE boîte."""

    def test_each_mask_is_attached_to_its_own_box(self, node, server_env):
        server_env["output"] = BOXES_2
        model, _ = _sam3([[SHAPE_A], [SHAPE_B]])
        masks = node.mask(_black(), "d", preset_id=3, sam3_model=model)["result"][0]
        mask = masks[0]
        torch = _torch()
        # intérieur de CHAQUE forme raffinée → 1
        assert mask[round(0.15 * SAM3_H), round(0.15 * SAM3_W)].item() == 1.0
        assert mask[round(0.75 * SAM3_H), round(0.75 * SAM3_W)].item() == 1.0
        # intérieur des BOÎTES mais hors des formes → 0 (aucun masque décalé)
        assert mask[round(0.35 * SAM3_H), round(0.35 * SAM3_W)].item() == 0.0
        assert mask[round(0.60 * SAM3_H), round(0.60 * SAM3_W)].item() == 0.0
        assert torch.equal(mask, masks[0])

    def test_fallback_rectangle_belongs_to_the_empty_box(self, node, server_env):
        """MUTANT : masques appariés à l'envers → le repli tombe sur la mauvaise boîte.

        Avec deux boîtes dont UNE seule produit un masque, l'union des formes est
        identique dans les deux sens : seul le RECTANGLE DE REPLI (et la fenêtre
        de clip) dépend de l'appariement. C'est donc là qu'il faut regarder.
        """
        server_env["output"] = BOXES_2
        model, _ = _sam3([[SHAPE_A], None])  # boîte A raffinée, boîte B en repli
        result = node.mask(_black(), "d", preset_id=3, sam3_model=model, expand_px=0)
        mask = result["result"][0][0]
        # la forme de la boîte A est bien là
        assert mask[round(0.15 * SAM3_H), round(0.15 * SAM3_W)].item() == 1.0
        # la boîte A n'est PAS en repli : hors de la forme → 0
        assert mask[round(0.35 * SAM3_H), round(0.35 * SAM3_W)].item() == 0.0
        # la boîte B est en repli : son rectangle est PLEIN (hors forme B)
        assert mask[round(0.90 * SAM3_H), round(0.60 * SAM3_W)].item() == 1.0
        assert "1 forme(s) raffinée(s), 1 repli(s)" in result["ui"]["status"][0]

    def test_one_pass_per_box_with_1x2x2_boxes(self, node, server_env):
        server_env["output"] = BOXES_2
        model, unet = _sam3([[SHAPE_A], [SHAPE_B]])
        node.mask(_black(), "d", preset_id=3, sam3_model=model)
        assert len(unet.calls) == 2, "une passe de trunk par boîte (pas de cache)"
        for call in unet.calls:
            assert call["box_shape"] == (1, 2, 2), "box_inputs attendu en [1,2,2]"
            assert call["points"] is None and call["masks"] is None
            assert call["image_shape"] == (1, 3, M.SAM3_SIZE, M.SAM3_SIZE)
        assert model.requested == ["diffusion_model", "diffusion_model"] or \
            model.requested == ["diffusion_model"], model.requested

    def test_box_is_expanded_then_scaled_to_1008(self, node, server_env):
        server_env["output"] = '{"boxes":[{"x1":0.10,"y1":0.10,"x2":0.30,"y2":0.30}]}'
        model, unet = _sam3([])
        node.mask(_black(), "d", preset_id=3, sam3_model=model, expand_px=8)
        box = unet.calls[0]["box"][0]
        expected = (
            (0.10 - 8 / SAM3_W) * M.SAM3_SIZE,
            max(0.10 - 8 / SAM3_H, 0.0) * M.SAM3_SIZE,  # marge clampée en haut
            (0.30 + 8 / SAM3_W) * M.SAM3_SIZE,
            (0.30 + 8 / SAM3_H) * M.SAM3_SIZE,
        )
        assert [box[0][0], box[0][1], box[1][0], box[1][1]] == pytest.approx(expected)

    def test_expansion_is_clamped_to_the_image(self, node, server_env):
        server_env["output"] = '{"boxes":[{"x1":0.0,"y1":0.0,"x2":0.2,"y2":0.2}]}'
        model, unet = _sam3([])
        node.mask(_black(), "d", preset_id=3, sam3_model=model, expand_px=64)
        box = unet.calls[0]["box"][0]
        assert box[0][0] == pytest.approx(0.0) and box[0][1] == pytest.approx(0.0)


@_requires_torch
class TestSam3Validation:
    """Règles de repli : masque vide, trop petit, débordant (bornes vérifiées)."""

    def _result(self, node, server_env, shapes, box=(0.10, 0.10, 0.60, 0.60), **kwargs):
        x1, y1, x2, y2 = box
        server_env["output"] = (
            f'{{"boxes":[{{"x1":{x1},"y1":{y1},"x2":{x2},"y2":{y2}}}]}}')
        model, unet = _sam3(shapes)
        result = node.mask(_black(), "d", preset_id=3, sam3_model=model, **kwargs)
        return result, unet

    def test_empty_mask_falls_back_to_the_llm_box(self, node, server_env):
        result, _ = self._result(node, server_env, [None], expand_px=0)
        mask = result["result"][0][0]
        expected = M.boxes_to_mask(
            [{"x1": 0.10, "y1": 0.10, "x2": 0.60, "y2": 0.60}], SAM3_W, SAM3_H, 0)
        assert _torch().equal(mask, expected), "masque vide → rectangle de la boîte"
        assert "0 forme(s) raffinée(s), 1 repli(s)" in result["ui"]["status"][0]

    def test_too_small_mask_falls_back(self, node, server_env):
        result, _ = self._result(node, server_env, [[(0.30, 0.30, 0.31, 0.31)]], expand_px=0)
        mask = result["result"][0][0]
        assert int(mask.sum()) == M.box_area_px(
            M.box_window_px({"x1": 0.10, "y1": 0.10, "x2": 0.60, "y2": 0.60},
                            SAM3_W, SAM3_H))
        assert "1 repli(s)" in result["ui"]["status"][0]

    def test_overflowing_mask_is_clipped_to_the_window(self, node, server_env):
        # une petite boîte et un masque qui couvre TOUTE l'image : ratio 25 > 4
        result, _ = self._result(node, server_env, [[(0.0, 0.0, 1.0, 1.0)]],
                                 box=(0.20, 0.20, 0.40, 0.40), expand_px=0)
        mask = result["result"][0][0]
        window = M.box_window_px({"x1": 0.20, "y1": 0.20, "x2": 0.40, "y2": 0.40},
                                 SAM3_W, SAM3_H)
        x0, y0, x1, y1 = window
        assert int(mask.sum()) == M.box_area_px(window), "masque clippé à la fenêtre"
        assert mask[y0:y1, x0:x1].min().item() == 1.0
        assert mask[:y0, :].max().item() == 0.0
        assert mask[:, :x0].max().item() == 0.0
        status = result["ui"]["status"][0]
        assert "1 clippé(s)" in status and "1 forme(s) raffinée(s)" in status

    def test_below_threshold_but_not_empty_is_kept(self, node, server_env):
        # 40 % de l'aire de la boîte : très au-dessus de 3 %, pas de repli
        result, _ = self._result(node, server_env, [[(0.20, 0.20, 0.39, 0.39)]], expand_px=0)
        mask = result["result"][0][0]
        assert 0 < int(mask.sum()) < M.box_area_px((10, 6, 58, 39))
        assert "1 forme(s) raffinée(s), 0 repli(s)" in result["ui"]["status"][0]

    def test_min_area_pct_is_honoured(self, node, server_env):
        shapes = [[(0.30, 0.30, 0.40, 0.40)]]  # ~5 % de la boîte
        kept, _ = self._result(node, server_env, shapes, expand_px=0, min_area_pct=3)
        dropped, _ = self._result(node, server_env, shapes, expand_px=0, min_area_pct=20)
        assert "1 forme(s) raffinée(s)" in kept["ui"]["status"][0]
        assert "1 repli(s)" in dropped["ui"]["status"][0]


# Forme en L : le rectangle englobant est bien plus GROS que la forme elle-même.
L_SHAPE = [(0.10, 0.10, 0.40, 0.15), (0.10, 0.10, 0.15, 0.40)]


@_requires_torch
class TestSam3Masks:
    """Mode ``shape`` vs mode ``bbox`` : ce que chacun produit réellement."""

    def _run(self, node, server_env, mask_mode, expand_px=0, shapes=None):
        server_env["output"] = '{"boxes":[{"x1":0.10,"y1":0.10,"x2":0.40,"y2":0.40,"label":"L"}]}'
        model, _ = _sam3([L_SHAPE if shapes is None else shapes])
        result = node.mask(_black(), "d", preset_id=3, sam3_model=model,
                           mask_mode=mask_mode, expand_px=expand_px)
        return result, result["result"][0][0]

    def test_shape_mode_renders_the_outline_shape(self, node, server_env):
        _, mask = self._run(node, server_env, "shape")
        thin_bar = mask[round(0.12 * SAM3_H), round(0.30 * SAM3_W)].item()
        body = mask[round(0.30 * SAM3_H), round(0.30 * SAM3_W)].item()
        assert thin_bar == 1.0, "barre horizontale du L"
        assert body == 0.0, "le L n'est PAS un rectangle plein"

    def test_bbox_mode_renders_the_tight_box_of_the_mask(self, node, server_env):
        _, shape_mask = self._run(node, server_env, "shape")
        _, bbox_mask = self._run(node, server_env, "bbox")
        assert int(bbox_mask.sum()) > int(shape_mask.sum()) * 2, \
            "le rectangle englobant du L est bien plus grand que la forme"
        # le rectangle est PLEIN : son coin « creux » est rempli
        assert bbox_mask[round(0.30 * SAM3_H), round(0.30 * SAM3_W)].item() == 1.0

    def test_bbox_mode_does_not_return_the_llm_box(self, node, server_env):
        """MUTANT : mode bbox qui rend la boîte du LLM au lieu de la boîte serrée."""
        _, bbox_mask = self._run(node, server_env, "bbox", expand_px=8)
        # la marge de 8 px du LLM ne doit PAS apparaître dans le masque
        assert bbox_mask[0, :].max().item() == 0.0
        assert bbox_mask[:, 0].max().item() == 0.0
        window = M.box_window_px({"x1": 0.10 - 8 / SAM3_W, "y1": 0.10 - 8 / SAM3_H,
                                  "x2": 0.40 + 8 / SAM3_W, "y2": 0.40 + 8 / SAM3_H},
                                 SAM3_W, SAM3_H)
        assert int(bbox_mask.sum()) < M.box_area_px(window)

    def test_duplicate_shapes_are_merged(self, node, server_env):
        server_env["output"] = (
            '{"boxes":[{"x1":0.10,"y1":0.10,"x2":0.40,"y2":0.40},'
            '{"x1":0.10,"y1":0.10,"x2":0.42,"y2":0.42}]}')
        model, unet = _sam3([[(0.11, 0.11, 0.30, 0.30)], [(0.11, 0.11, 0.30, 0.30)]])
        status = node.mask(_black(), "d", preset_id=3, sam3_model=model)["ui"]["status"][0]
        assert len(unet.calls) == 2
        assert "1 doublon(s) fusionné(s)" in status
        assert "1 forme(s) raffinée(s)" in status

    def test_feather_is_applied_after_refinement(self, node, server_env):
        server_env["output"] = '{"boxes":[{"x1":0.10,"y1":0.10,"x2":0.80,"y2":0.80}]}'
        model, _ = _sam3([[(0.15, 0.15, 0.75, 0.75)]])
        sharp = node.mask(_black(), "d", preset_id=3, sam3_model=model,
                          mask_mode="shape", feather=0)["result"][0]
        soft = node.mask(_black(), "d", preset_id=3, sam3_model=model,
                         mask_mode="shape", feather=2)["result"][0]
        assert set(sharp.unique().tolist()) == {0.0, 1.0}, "sans feather : binaire strict"
        values = soft.unique()
        assert ((values > 0.0) & (values < 1.0)).any().item(), "feather APRÈS le raffinement"
        assert soft.max().item() == pytest.approx(1.0, abs=1e-2)

    def test_batch_is_preserved(self, node, server_env):
        server_env["output"] = '{"boxes":[{"x1":0.10,"y1":0.10,"x2":0.40,"y2":0.40}]}'
        model, _ = _sam3([L_SHAPE])
        masks, preview = node.mask(_black(batch=3), "d", preset_id=3,
                                   sam3_model=model)["result"]
        assert masks.shape == (3, SAM3_H, SAM3_W)
        assert preview.shape == (3, SAM3_H, SAM3_W, 3)
        assert _torch().equal(masks[0], masks[2])

    def test_preview_draws_boxes_and_shape_outline(self, node, server_env):
        server_env["output"] = '{"boxes":[{"x1":0.10,"y1":0.10,"x2":0.40,"y2":0.40}]}'
        image = _torch().zeros((1, SAM3_H, SAM3_W, 3), dtype=_torch().float32)
        model, _ = _sam3([L_SHAPE])
        preview = node.mask(image, "d", preset_id=3, sam3_model=model)["result"][1]
        assert image.abs().sum().item() == 0.0, "l'image d'entrée n'est pas modifiée"
        red = (preview[0, ..., 0] > 0.5) & (preview[0, ..., 1] < 0.5)
        green = (preview[0, ..., 1] > 0.5) & (preview[0, ..., 0] < 0.5)
        assert red.any().item(), "boîtes du LLM en rouge"
        assert green.any().item(), "contour de la forme SAM3 en vert"


@_requires_torch
class TestSam3CapacityGuard:
    """Aucun MODEL / MODEL non-SAM3 / modèle cassé → repli propre, jamais un crash."""

    def _status_mask(self, node, server_env, sam3_model, **kwargs):
        server_env["output"] = BOXES_2
        result = node.mask(_black(), "d", preset_id=3,
                           sam3_model=sam3_model, **kwargs)
        return result["ui"]["status"][0], result["result"][0]

    def test_no_sam3_model_is_strictly_unchanged(self, node, server_env):
        """MUTANT : ``sam3_model=None`` qui plante / qui élargit les boîtes."""
        status, masks = self._status_mask(node, server_env, None)
        boxes, _ = M.parse_boxes(BOXES_2, SAM3_W, SAM3_H)
        expected = _torch().stack([M.boxes_to_mask(boxes, SAM3_W, SAM3_H, 0)])
        assert _torch().equal(masks, expected)
        assert _torch().equal(node.mask(_black(), "d", preset_id=3)["result"][1],
                              M.draw_boxes(_black(), boxes))
        assert "2 boîte(s)" in status
        assert M.SAM3_UNAVAILABLE_NOTE in status

    def test_sam_refine_false_is_strictly_unchanged(self, node, server_env):
        model, unet = _sam3([[SHAPE_A], [SHAPE_B]])
        status, masks = self._status_mask(node, server_env, model, sam_refine=False)
        boxes, _ = M.parse_boxes(BOXES_2, SAM3_W, SAM3_H)
        assert unet.calls == [], "aucune passe de modèle quand sam_refine=False"
        assert _torch().equal(masks, _torch().stack(
            [M.boxes_to_mask(boxes, SAM3_W, SAM3_H, 0)]))
        assert "sam_refine=False" in status

    def test_object_without_forward_segment_falls_back(self, node, server_env):
        """MUTANT : garde de capacité retirée → les boîtes seraient élargies."""
        model = _FakeModel(object())
        status, masks = self._status_mask(node, server_env, model)
        boxes, _ = M.parse_boxes(BOXES_2, SAM3_W, SAM3_H)
        assert _torch().equal(masks, _torch().stack(
            [M.boxes_to_mask(boxes, SAM3_W, SAM3_H, 0)]))
        assert M.SAM3_UNAVAILABLE_NOTE in status

    def test_not_a_model_patcher_is_reported(self, node, server_env):
        status, _ = self._status_mask(node, server_env, "pas un model")
        assert M.SAM3_UNAVAILABLE_NOTE in status
        status, _ = self._status_mask(node, server_env, object())
        assert M.SAM3_UNAVAILABLE_NOTE in status

    def test_forward_segment_error_falls_back_per_box(self, node, server_env):
        model, unet = _sam3([[SHAPE_A]], error=RuntimeError("CUDA out of memory"))
        status, masks = self._status_mask(node, server_env, model)
        boxes, _ = M.parse_boxes(BOXES_2, SAM3_W, SAM3_H)
        assert _torch().equal(masks, _torch().stack(
            [M.boxes_to_mask(M.dedupe_boxes([M.expand_box(box, 8, SAM3_W, SAM3_H)
                                             for box in boxes]), SAM3_W, SAM3_H, 0)]))
        assert "0 forme(s) raffinée(s), 2 repli(s)" in status
        assert len(unet.calls) == 2, "une erreur par boîte n'arrête pas la boucle"

    def test_unexpected_logits_shape_falls_back(self, node, server_env):
        model, _ = _sam3([[SHAPE_A]], out_shape=(1, 2, M.SAM3_SIZE, M.SAM3_SIZE))
        status, _ = self._status_mask(node, server_env, model)
        assert "0 forme(s) raffinée(s), 2 repli(s)" in status

    def test_image_preparation_failure_falls_back(self, node, server_env, monkeypatch):
        def boom(*args, **kwargs):
            raise RuntimeError("impossible d'étirer l'image")

        monkeypatch.setattr(M, "prepare_sam3_image", boom)
        model, unet = _sam3([[SHAPE_A], [SHAPE_B]])
        status, masks = self._status_mask(node, server_env, model)
        assert unet.calls == [], "aucun appel SAM3 si l'image 1008 est impossible"
        assert "0 forme(s) raffinée(s), 2 repli(s)" in status
        assert M.SAM3_UNAVAILABLE_NOTE in status
        assert int(masks.sum()) > 0, "repli sur les boîtes élargies, pas un masque vide"

    def test_unexpected_refine_crash_is_caught(self, node, server_env, monkeypatch):
        """SAM3 est un CONFORT : même un bug inattendu ne casse pas la node."""

        def boom(*args, **kwargs):
            raise RuntimeError("bug inattendu du raffinement")

        monkeypatch.setattr(node, "_refine_plan", boom)
        model, _ = _sam3([[SHAPE_A], [SHAPE_B]])
        status, masks = self._status_mask(node, server_env, model)
        boxes, _ = M.parse_boxes(BOXES_2, SAM3_W, SAM3_H)
        assert _torch().equal(masks, _torch().stack(
            [M.boxes_to_mask(boxes, SAM3_W, SAM3_H, 0)]))
        assert M.SAM3_UNAVAILABLE_NOTE in status
        assert "bug inattendu du raffinement" in status

    def test_max_boxes_caps_the_number_of_passes(self, node, server_env):
        server_env["output"] = (
            '{"boxes":[{"x1":0.02,"y1":0.02,"x2":0.45,"y2":0.45},'
            '{"x1":0.55,"y1":0.55,"x2":0.95,"y2":0.95}]}')
        model, unet = _sam3([[SHAPE_A], [SHAPE_B]])
        status = node.mask(_black(), "d", preset_id=3, sam3_model=model,
                           max_boxes=1)["ui"]["status"][0]
        assert len(unet.calls) == 1, "plafond respecté : 1 passe, pas 2"
        assert "plafond max_boxes atteint (1 ignorée(s))" in status

    def test_widgets_read_defensively_on_old_workflows(self, node, server_env):
        model, unet = _sam3([[SHAPE_A], [SHAPE_B]])
        server_env["output"] = BOXES_2
        result = node.mask(_black(), "d", preset_id=3, sam3_model=model,
                           mask_mode=None, expand_px="12", min_area_pct=None,
                           sam_refine=None, max_boxes=None)
        assert result["result"][0].shape == (1, SAM3_H, SAM3_W)
        assert len(unet.calls) == 2
        box = unet.calls[0]["box"][0]
        assert box[0][0] == pytest.approx(max(0.02 - 12 / SAM3_W, 0.0) * M.SAM3_SIZE)


# === 5. PHASE 2 : raffinement par CROP + batching =========================
# Deux questions distinctes, donc deux faux modèles :
#   - ``_EchoUnet`` DESSINE la boîte-prompt reçue → tout décalage de repère
#     (fenêtre de crop, recollage) se voit immédiatement sur les pixels ;
#   - ``_BatchUnet`` rend des rectangles CHOISIS par position dans la requête →
#     c'est le seul moyen de voir un appariement masque↔boîte cassé par un lot.

SAM3_AREA = SAM3_W * SAM3_H
BOX_ONE = {"x1": 0.10, "y1": 0.10, "x2": 0.40, "y2": 0.40}
ONE_BOX = '{"boxes":[{"x1":0.10,"y1":0.10,"x2":0.40,"y2":0.40,"label":"btn"}]}'
FOUR_BOXES = (
    '{"boxes":[{"x1":0.02,"y1":0.10,"x2":0.22,"y2":0.40},'
    '{"x1":0.28,"y1":0.10,"x2":0.48,"y2":0.40},'
    '{"x1":0.54,"y1":0.10,"x2":0.74,"y2":0.40},'
    '{"x1":0.80,"y1":0.10,"x2":0.98,"y2":0.40}]}'
)
TWO_CLOSE = (
    '{"boxes":[{"x1":0.05,"y1":0.10,"x2":0.20,"y2":0.40},'
    '{"x1":0.30,"y1":0.10,"x2":0.45,"y2":0.40}]}'
)


class TestCropWindow:
    """Fenêtre de recadrage : marges, plancher, clampage, recentrage."""

    def test_margin_is_a_percentage_of_the_box_size(self):
        """MUTANT : marge prise en % de l'IMAGE (ou en pixels fixes)."""
        box = {"x1": 0.40, "y1": 0.40, "x2": 0.60, "y2": 0.60}  # 20x20 px sur 100
        window = M.crop_window(box, 100, 100, 30, 1)
        # 30 % de 20 px = 6 px de contexte de chaque côté → 32 px de fenêtre
        assert M.box_area_px(window) == 32 * 32
        assert window == (34, 34, 66, 66)

    def test_zero_margin_gives_the_box_itself(self):
        box = {"x1": 0.20, "y1": 0.20, "x2": 0.40, "y2": 0.40}
        assert M.crop_window(box, 100, 100, 0, 1) == (20, 20, 40, 40)

    def test_floor_is_applied_and_recentred(self):
        """MUTANT : plancher ``min_crop_px`` ignoré → fenêtre de 6 px."""
        box = {"x1": 0.48, "y1": 0.48, "x2": 0.52, "y2": 0.52}  # 4x4 px
        window = M.crop_window(box, 100, 100, 0, 40)
        assert window == (30, 30, 70, 70), "plancher 40 px, CENTRÉ sur la boîte"
        assert M.box_area_px(window) == 40 * 40

    def test_floor_is_clamped_to_the_image(self):
        """Un plancher plus grand que l'image ne sort pas de l'image."""
        box = {"x1": 0.90, "y1": 0.90, "x2": 0.95, "y2": 0.95}
        window = M.crop_window(box, 64, 48, 0, 1024)
        assert window == (0, 0, 64, 48)

    def test_box_glued_to_the_border_is_recentred_inside_the_image(self):
        """Bords : la fenêtre reste DANS l'image, quitte à glisser du côté libre."""
        box = {"x1": 0.0, "y1": 0.0, "x2": 0.10, "y2": 0.10}
        window = M.crop_window(box, 100, 100, 30, 64)
        assert window[0] == 0 and window[1] == 0
        assert M.box_area_px(window) == 64 * 64, "le plancher tient malgré le bord"
        box = {"x1": 0.90, "y1": 0.90, "x2": 1.0, "y2": 1.0}
        window = M.crop_window(box, 100, 100, 30, 64)
        assert window[2] == 100 and window[3] == 100
        assert M.box_area_px(window) == 64 * 64

    def test_window_always_contains_the_box(self):
        """Invariant : la fenêtre contient la boîte (sinon le prompt la tronque)."""
        for box in ({"x1": 0.0, "y1": 0.0, "x2": 0.02, "y2": 0.02},
                    {"x1": 0.98, "y1": 0.97, "x2": 1.0, "y2": 1.0},
                    {"x1": 0.45, "y1": 0.45, "x2": 0.55, "y2": 0.55}):
            x0, y0, x1, y1 = M.crop_window(box, SAM3_W, SAM3_H, 30, 32)
            assert x0 <= box["x1"] * SAM3_W and y0 <= box["y1"] * SAM3_H
            assert x1 >= box["x2"] * SAM3_W and y1 >= box["y2"] * SAM3_H

    def test_never_larger_than_the_image(self):
        box = {"x1": 0.0, "y1": 0.0, "x2": 1.0, "y2": 1.0}
        assert M.crop_window(box, SAM3_W, SAM3_H, 100, 1024) == (0, 0, SAM3_W, SAM3_H)

    def test_degenerate_inputs_fall_back_to_the_whole_image(self):
        assert M.crop_window(None, 100, 50, 30, 32) == (0, 0, 100, 50)
        assert M.crop_window({"x1": 0.1}, 100, 50, 30, 32) == (0, 0, 100, 50)
        assert M.crop_window(BOX_ONE, 0, 0, 30, 32) == (0, 0, 0, 0)

    def test_margin_is_capped_at_one_hundred_percent(self):
        box = {"x1": 0.40, "y1": 0.40, "x2": 0.60, "y2": 0.60}
        assert M.crop_window(box, 1000, 1000, 300, 1) == \
            M.crop_window(box, 1000, 1000, M.MAX_CROP_MARGIN, 1)


class TestBoxToCrop1008:
    """Formules EXACTES du remap entre repère image et repère du crop."""

    def test_formula_uses_the_window_origin_and_span(self):
        window = (10, 20, 60, 80)  # 50 x 60 pixels
        box = {"x1": 10 / 100, "y1": 20 / 100, "x2": 35 / 100, "y2": 50 / 100}
        px1, py1, px2, py2 = M.box_to_crop_1008(box, window, 100, 100)
        assert (px1, py1) == pytest.approx((0.0, 0.0)), "coin haut-gauche du crop"
        assert (px2, py2) == pytest.approx(
            (25 / 50 * M.SAM3_SIZE, 30 / 60 * M.SAM3_SIZE))

    def test_one_pixel_window_does_not_divide_by_zero(self):
        """Fenêtre de 1 px : on divise par 1, jamais par 0."""
        window = (5, 7, 6, 8)
        box = {"x1": 5 / 96, "y1": 7 / 64, "x2": 6 / 96, "y2": 8 / 64}
        assert M.box_to_crop_1008(box, window, 96, 64) == pytest.approx(
            (0.0, 0.0, float(M.SAM3_SIZE), float(M.SAM3_SIZE)))

    def test_result_differs_from_the_image_space_box(self):
        """MUTANT : boîte-prompt restée en espace IMAGE alors qu'on recadre."""
        window = (5, 10, 55, 70)
        box = {"x1": 0.20, "y1": 0.30, "x2": 0.40, "y2": 0.50}
        crop_space = M.box_to_crop_1008(box, window, 100, 100)
        image_space = M.box_to_1008(box)
        assert crop_space[0] != pytest.approx(image_space[0])
        assert crop_space == pytest.approx(
            ((0.20 * 100 - 5) / 50 * M.SAM3_SIZE,
             (0.30 * 100 - 10) / 60 * M.SAM3_SIZE,
             (0.40 * 100 - 5) / 50 * M.SAM3_SIZE,
             (0.50 * 100 - 10) / 60 * M.SAM3_SIZE))

    def test_result_is_bounded_to_the_sam3_grid(self):
        values = M.box_to_crop_1008({"x1": 0.9, "y1": 0.9, "x2": 1.0, "y2": 1.0},
                                    (0, 0, 40, 40), 100, 100)
        assert all(0.0 <= value <= M.SAM3_SIZE for value in values)


class TestPaste:
    """Recollage du masque de crop dans le masque plein format."""

    def test_paste_slices_cover_the_whole_mask_inside_the_window(self):
        spans = M.paste_slices((10, 20, 60, 80), 50, 60, 100, 100)
        assert spans == (10, 20, 60, 80, 0, 0, 50, 60)

    def test_paste_slices_clip_a_window_that_overflows(self):
        """Fenêtre débordante : les DEUX rectangles sont rognés ensemble."""
        spans = M.paste_slices((-10, -10, 10, 10), 20, 20, 100, 100)
        assert spans == (0, 0, 10, 10, 10, 10, 20, 20)

    def test_paste_slices_none_outside_the_image(self):
        assert M.paste_slices((200, 200, 210, 210), 10, 10, 100, 100) is None
        assert M.paste_slices((0, 0, 0, 0), 0, 0, 100, 100) is None
        assert M.paste_slices((0, 0, 10, 10), 10, 10, 0, 0) is None

    def test_paste_scales_the_mask_to_the_window(self):
        """Le masque de crop peut arriver à une autre échelle que la fenêtre."""
        spans = M.paste_slices((10, 10, 60, 60), 100, 100, 100, 100)
        assert spans == (10, 10, 60, 60, 0, 0, 100, 100)


class TestChunkBoxes:
    def test_groups_of_the_requested_size(self):
        assert M.chunk_boxes([0, 1, 2, 3, 4], 2) == [[0, 1], [2, 3], [4]]

    def test_exact_multiple_has_no_empty_tail(self):
        assert M.chunk_boxes([0, 1, 2, 3], 2) == [[0, 1], [2, 3]]

    def test_size_one_is_one_group_per_item(self):
        """Comportement phase 1 : une passe par boîte."""
        assert M.chunk_boxes([0, 1, 2], 1) == [[0], [1], [2]]
        assert M.chunk_boxes([0, 1], 0) == [[0], [1]]

    def test_empty_and_oversized(self):
        assert M.chunk_boxes([], 4) == []
        assert M.chunk_boxes([0, 1], 16) == [[0, 1]]

    def test_size_larger_than_the_list_keeps_the_order(self):
        assert M.chunk_boxes(["a", "b", "c"], 99) == [["a", "b", "c"]]


def _rect_logits_mask(rects, width, height):
    """Masque ``>0`` des rectangles (normalisés 0-1) vus par le faux SAM3 — 1 boîte."""
    torch = _torch()
    logits = torch.full((1, 1, M.SAM3_SIZE, M.SAM3_SIZE), -1.0)
    for rect in rects or []:
        x1, y1, x2, y2 = (round(value * M.SAM3_SIZE) for value in rect)
        logits[0, 0, y1:y2, x1:x2] = 0.3
    resized = torch.nn.functional.interpolate(
        logits.float(), size=(height, width), mode="bilinear", align_corners=False)
    return resized[0, 0] > 0


def _phase1_oracle(rect_lists, width, height):
    """ORACLE de la phase 1 : une passe par boîte sur l'image ENTIÈRE, union."""
    torch = _torch()
    union = torch.zeros((height, width), dtype=torch.bool)
    for rects in rect_lists:
        union |= _rect_logits_mask(rects, width, height)
    return union


def _window_from_prompt(prompt, box, width, height):
    """Décode la FENÊTRE réellement utilisée depuis la boîte-prompt envoyée.

    Inverse exactement ``box_to_crop_1008`` : c'est une mesure INDÉPENDANTE de
    la fenêtre que la node a choisie (taille + origine), donc le seul moyen de
    voir « plancher ignoré » ou « fenêtre hors image » depuis un appel.
    Renvoie ``(x0, y0, largeur, hauteur)`` en pixels (flottants).
    """
    px1, py1, px2, py2 = prompt
    bx1, bx2 = box["x1"] * width, box["x2"] * width
    by1, by2 = box["y1"] * height, box["y2"] * height
    span_x = (bx2 - bx1) * M.SAM3_SIZE / (px2 - px1)
    span_y = (by2 - by1) * M.SAM3_SIZE / (py2 - py1)
    return (bx1 - px1 * span_x / M.SAM3_SIZE, by1 - py1 * span_y / M.SAM3_SIZE,
            span_x, span_y)


class _EchoUnet:
    """Faux ``diffusion_model`` qui DESSINE la boîte-prompt reçue (inset 10 %).

    Le masque recollé doit donc se retrouver PILE sur la boîte, quelle que soit
    la fenêtre : un repère mélangé (boîte en espace image alors qu'on recadre)
    ou un recollage décalé déplace le masque de façon visible.
    """

    def __init__(self, inset=0.1, fail_batch=False):
        self.inset = inset
        self.fail_batch = fail_batch
        self.calls = []

    def forward_segment(self, image, point_inputs=None, box_inputs=None,
                        mask_inputs=None):
        torch = _torch()
        count = int(box_inputs.shape[0])
        self.calls.append({
            "n": count,
            "images": tuple(image.shape),
            "image": image.detach().clone(),
            "boxes": box_inputs.tolist(),
        })
        if self.fail_batch and count > 1:
            raise RuntimeError("le batching n'est pas exercé par la node native")
        logits = torch.full((count, 1, M.SAM3_SIZE, M.SAM3_SIZE), -1.0)
        for index in range(count):
            (px1, py1), (px2, py2) = box_inputs[index].tolist()
            dx = (px2 - px1) * self.inset
            dy = (py2 - py1) * self.inset
            x1, x2 = round(px1 + dx), round(px2 - dx)
            y1, y2 = round(py1 + dy), round(py2 - dy)
            if x2 > x1 and y2 > y1:
                logits[index, 0, y1:y2, x1:x2] = 0.5
        return logits


class _BatchUnet:
    """Faux modèle LOT-AWARE : ``shapes[call][k]`` = rectangles du k-ième prompt.

    Seul moyen de détecter un APPARIEMENT cassé : les rectangles ne dépendent
    pas de la boîte reçue mais de leur POSITION dans la requête.
    """

    def __init__(self, shapes=None, fail_batch=False):
        self.shapes = list(shapes or [])
        self.fail_batch = fail_batch
        self.calls = []

    def forward_segment(self, image, point_inputs=None, box_inputs=None,
                        mask_inputs=None):
        torch = _torch()
        count = int(box_inputs.shape[0])
        self.calls.append({
            "n": count,
            "images": tuple(image.shape),
            "boxes": box_inputs.tolist(),
        })
        if self.fail_batch and count > 1:
            raise RuntimeError("le batching n'est pas exercé par la node native")
        index = min(len(self.calls) - 1, len(self.shapes) - 1)
        per_call = self.shapes[index] if self.shapes else []
        logits = torch.full((count, 1, M.SAM3_SIZE, M.SAM3_SIZE), -1.0)
        for position in range(count):
            rects = per_call[position] if position < len(per_call) else None
            for rect in rects or []:
                x1, y1, x2, y2 = (round(value * M.SAM3_SIZE) for value in rect)
                logits[position, 0, y1:y2, x1:x2] = 0.3
        return logits


def _echo(**kwargs):
    unet = _EchoUnet(**kwargs)
    return _FakeModel(unet), unet


def _batched(shapes=None, **kwargs):
    unet = _BatchUnet(shapes, **kwargs)
    return _FakeModel(unet), unet


def _echo_bounds(prompt, window, inset=0.1):
    """Bornes pixels attendues du masque recollé, déduites de la géométrie seule."""
    px1, py1, px2, py2 = prompt
    x0, y0, x1, y1 = (float(value) for value in window)
    span_x, span_y = max(x1 - x0, 1.0), max(y1 - y0, 1.0)

    def project(low, high, origin, span):
        start = low + (high - low) * inset
        stop = high - (high - low) * inset
        return (origin + start / M.SAM3_SIZE * span,
                origin + stop / M.SAM3_SIZE * span)

    ex0, ex1 = project(px1, px2, x0, span_x)
    ey0, ey1 = project(py1, py2, y0, span_y)
    return (ex0, ey0, ex1, ey1)


@_requires_torch
class TestSam3Crop:
    """Mode « région » : ce que SAM3 reçoit et où le masque atterrit."""

    def _run(self, node, server_env, output=ONE_BOX, **kwargs):
        server_env["output"] = output
        model, unet = _echo()
        result = node.mask(_black(), "d", preset_id=3, sam3_model=model, **kwargs)
        return result, unet

    def test_sam3_receives_a_1008_square_and_a_crop_space_box(self, node, server_env):
        """MUTANT : boîte-prompt envoyée en espace IMAGE alors qu'on recadre."""
        result, unet = self._run(node, server_env, expand_px=0, min_crop_px=32)
        call = unet.calls[0]
        assert call["images"] == (1, 3, M.SAM3_SIZE, M.SAM3_SIZE)
        assert len(call["boxes"]) == 1, "un prompt par boîte"
        window = M.crop_window(BOX_ONE, SAM3_W, SAM3_H, 30, 32)
        expected = M.box_to_crop_1008(BOX_ONE, window, SAM3_W, SAM3_H)
        got = call["boxes"][0]
        assert [got[0][0], got[0][1], got[1][0], got[1][1]] == pytest.approx(expected)
        image_space = M.box_to_1008(BOX_ONE)
        assert got[0][0] != pytest.approx(image_space[0])
        assert "mode crop" in result["ui"]["status"][0]

    def test_mask_is_pasted_at_the_window_position(self, node, server_env):
        """MUTANT : masque recollé à (0,0) ou à la taille de l'image."""
        result, _unet = self._run(node, server_env, expand_px=0, min_crop_px=32)
        mask = result["result"][0][0]
        window = M.crop_window(BOX_ONE, SAM3_W, SAM3_H, 30, 32)
        prompt = M.box_to_crop_1008(BOX_ONE, window, SAM3_W, SAM3_H)
        assert M.mask_bounds(mask) == pytest.approx(
            _echo_bounds(prompt, window), abs=2.0)
        x0, y0, x1, y1 = window
        outside = mask.clone()
        outside[y0:y1, x0:x1] = False
        assert int(outside.sum()) == 0, "rien en dehors de la fenêtre de crop"

    def test_crop_receives_the_cropped_region_not_the_whole_image(self, node, server_env):
        torch = _torch()
        image = torch.zeros((1, SAM3_H, SAM3_W, 3), dtype=torch.float32)
        image[:, :, : SAM3_W // 2] = 1.0
        server_env["output"] = ONE_BOX
        model, unet = _echo()
        node.mask(image, "d", preset_id=3, sam3_model=model,
                  expand_px=0, min_crop_px=32)
        crop = unet.calls[0]["image"][0]
        assert tuple(crop.shape) == (3, M.SAM3_SIZE, M.SAM3_SIZE)
        assert crop.min().item() > 0.99, "fenêtre entièrement dans la zone blanche"
        model_full, unet_full = _echo()
        node.mask(image, "d", preset_id=3, sam3_model=model_full,
                  sam_crop=False, expand_px=0)
        assert unet_full.calls[0]["image"].min().item() == 0.0, \
            "en mode plein l'image est bien vue en entier"

    def test_two_close_boxes_give_two_distinct_shapes(self, node, server_env):
        result, unet = self._run(node, server_env, output=TWO_CLOSE,
                                 expand_px=0, min_crop_px=32)
        mask = result["result"][0][0]
        assert len(unet.calls) == 2
        assert mask[16, 12].item() == 1.0
        assert mask[16, 36].item() == 1.0
        assert mask[16, 24].item() == 0.0, "les deux formes restent distinctes"

    def test_min_crop_px_floor_is_honoured(self, node, server_env):
        """MUTANT : plancher ignoré → fenêtre de ~6 px au lieu de 32."""
        tiny = '{"boxes":[{"x1":0.20,"y1":0.20,"x2":0.25,"y2":0.30}]}'
        box = {"x1": 0.20, "y1": 0.20, "x2": 0.25, "y2": 0.30}
        for floor in (32, 64):
            result, unet = self._run(node, server_env, output=tiny,
                                     expand_px=0, crop_margin=0, min_crop_px=floor)
            corners = unet.calls[0]["boxes"][0]
            x0, y0, span_x, span_y = _window_from_prompt(
                [corners[0][0], corners[0][1], corners[1][0], corners[1][1]],
                box, SAM3_W, SAM3_H)
            assert span_x == pytest.approx(floor, abs=1.0), "plancher en x"
            assert span_y == pytest.approx(floor, abs=1.0), "plancher en y"
            assert x0 >= -0.5 and y0 >= -0.5
            assert x0 + span_x <= SAM3_W + 1 and y0 + span_y <= SAM3_H + 1
            assert result["result"][0].shape == (1, SAM3_H, SAM3_W)

    def test_image_sized_floor_is_bit_identical_to_full_mode(self, node, server_env):
        """Équivalence CROP ↔ PLEIN : plancher ≥ image ⇒ fenêtre = image entière."""
        server_env["output"] = BOXES_2
        model_crop, unet_crop = _echo()
        cropped = node.mask(_black(), "d", preset_id=3, sam3_model=model_crop,
                            min_crop_px=M.MAX_MIN_CROP_PX)["result"]
        model_full, unet_full = _echo()
        full = node.mask(_black(), "d", preset_id=3, sam3_model=model_full,
                         sam_crop=False)["result"]
        torch = _torch()
        assert torch.equal(cropped[0], full[0]), "masques identiques"
        assert torch.equal(cropped[1], full[1]), "preview identique"
        prompt_crop = [value for corner in unet_crop.calls[0]["boxes"][0]
                       for value in corner]
        prompt_full = [value for corner in unet_full.calls[0]["boxes"][0]
                       for value in corner]
        assert prompt_crop == pytest.approx(prompt_full)

    def test_sam_crop_false_reproduces_the_phase1_pipeline(self, node, server_env):
        """MUTANT : ``sam_crop=False`` qui ne refait plus exactement la phase 1."""
        server_env["output"] = BOXES_2
        model, unet = _sam3([[SHAPE_A], [SHAPE_B]])
        # min_crop_px petit + marge : si la node recadrait malgré sam_crop=False,
        # la boîte-prompt NE serait plus celle de l'espace image.
        mask = node.mask(_black(), "d", preset_id=3, sam3_model=model,
                         sam_crop=False, expand_px=8, crop_margin=10,
                         min_crop_px=32)["result"][0][0]
        expected = _phase1_oracle([[SHAPE_A], [SHAPE_B]], SAM3_W, SAM3_H)
        assert _torch().equal(mask, expected)
        assert len(unet.calls) == 2, "une passe par boîte, comme en phase 1"
        boxes, _ = M.parse_boxes(BOXES_2, SAM3_W, SAM3_H)
        for call, box in zip(unet.calls, boxes):
            assert call["box_shape"] == (1, 2, 2)
            assert call["image_shape"] == (1, 3, M.SAM3_SIZE, M.SAM3_SIZE)
            corners = [value for corner in call["box"][0] for value in corner]
            assert corners == pytest.approx(
                list(M.box_to_1008(M.expand_box(box, 8, SAM3_W, SAM3_H)))), \
                "boîte-prompt = espace IMAGE (aucun recadrage)"

    def test_crop_mode_status_reports_the_mode_and_passes(self, node, server_env):
        result, _ = self._run(node, server_env, expand_px=0, min_crop_px=32)
        status = result["ui"]["status"][0]
        assert "mode crop · 1 passe(s)" in status
        assert "forme(s) raffinée(s)" in status

    def test_full_mode_status_reports_the_mode(self, node, server_env):
        result, _ = self._run(node, server_env, sam_crop=False)
        assert "mode plein · 1 passe(s)" in result["ui"]["status"][0]

    def test_phase2_widgets_are_read_defensively(self, node, server_env):
        """Workflow d'avant la phase 2 : champs absents / None / hors bornes."""
        result, unet = self._run(node, server_env, expand_px=0,
                                 sam_crop=None, crop_margin="nawak",
                                 sam_batch=None, min_crop_px=None)
        assert result["result"][0].shape == (1, SAM3_H, SAM3_W)
        assert len(unet.calls) == 1
        corners = unet.calls[0]["boxes"][0]
        x0, _y0, span_x, _span_y = _window_from_prompt(
            [corners[0][0], corners[0][1], corners[1][0], corners[1][1]],
            BOX_ONE, SAM3_W, SAM3_H)
        assert x0 == pytest.approx(0.0, abs=1.0)
        assert span_x == pytest.approx(SAM3_W, abs=1.0), \
            "min_crop_px par défaut (128) sur une image de 96 px → image entière"


@_requires_torch
class TestSam3Batching:
    """Passe lotée : moins d'appels, mêmes masques, et repli si le lot échoue."""

    def _run(self, node, server_env, unet_factory=_echo, output=FOUR_BOXES, **kwargs):
        server_env["output"] = output
        model, unet = unet_factory()
        result = node.mask(_black(), "d", preset_id=3, sam3_model=model, **kwargs)
        return result, unet

    def test_one_call_for_several_boxes(self, node, server_env):
        loop_result, loop_unet = self._run(node, server_env, sam_batch=1, min_crop_px=32)
        batch_result, batch_unet = self._run(node, server_env, sam_batch=4,
                                             min_crop_px=32)
        assert len(loop_unet.calls) == 4
        assert len(batch_unet.calls) == 1, "une seule passe pour 4 boîtes"
        call = batch_unet.calls[0]
        assert call["n"] == 4
        assert call["boxes"] != [] and len(call["boxes"]) == 4
        assert call["images"] == (4, 3, M.SAM3_SIZE, M.SAM3_SIZE), \
            "les crops 1008² sont EMPILÉS"
        assert _torch().equal(loop_result["result"][0], batch_result["result"][0]), \
            "mêmes masques qu'en boucle"
        status = batch_result["ui"]["status"][0]
        assert "1 passe(s)" in status and "lot 4" in status

    def test_partial_batch_uses_the_remaining_boxes(self, node, server_env):
        result, unet = self._run(node, server_env, sam_batch=3, min_crop_px=32)
        assert [call["n"] for call in unet.calls] == [3, 1]
        assert "2 passe(s)" in result["ui"]["status"][0]

    def test_batch_failure_replays_in_a_loop(self, node, server_env):
        """MUTANT : repli de batching qui plante, ou qui perd des masques."""
        reference, _ = self._run(node, server_env, sam_batch=1, min_crop_px=32)
        result, unet = self._run(
            node, server_env,
            unet_factory=lambda: _echo(fail_batch=True), sam_batch=4,
            min_crop_px=32)
        assert [call["n"] for call in unet.calls] == [4, 1, 1, 1, 1], \
            "lot refusé puis une passe par boîte"
        assert _torch().equal(result["result"][0], reference["result"][0]), \
            "résultat identique à la boucle, pas de crash"
        status = result["ui"]["status"][0]
        assert "1 repli(s) de batching" in status
        assert "5 passe(s)" in status

    def test_batch_keeps_the_positional_pairing(self, node, server_env):
        """MUTANT : appariement masque↔boîte cassé par le lot (décalage)."""
        model, unet = _batched([[[SHAPE_A], None]])
        server_env["output"] = BOXES_2
        result = node.mask(_black(), "d", preset_id=3, sam3_model=model,
                           sam_batch=2, sam_crop=False, expand_px=0)
        mask = result["result"][0][0]
        assert unet.calls[0]["n"] == 2
        # A a reçu SA forme : le reste de sa boîte est vide…
        assert mask[round(0.15 * SAM3_H), round(0.15 * SAM3_W)].item() == 1.0
        assert mask[round(0.40 * SAM3_H), round(0.40 * SAM3_W)].item() == 0.0
        # … et B, sans forme, est en repli : son rectangle est PLEIN.
        assert mask[round(0.90 * SAM3_H), round(0.60 * SAM3_W)].item() == 1.0
        assert "1 forme(s) raffinée(s), 1 repli(s)" in result["ui"]["status"][0]

    def test_single_box_batch_is_the_phase1_call_shape(self, node, server_env):
        result, unet = self._run(node, server_env, output=ONE_BOX, sam_batch=8,
                                 sam_crop=False)
        assert len(unet.calls) == 1
        assert unet.calls[0]["n"] == 1
        assert unet.calls[0]["images"] == (1, 3, M.SAM3_SIZE, M.SAM3_SIZE)
        assert "lot 8" in result["ui"]["status"][0]


# === 6. PHASE 3 : DÉCOUVERTE — logique PURE (sans torch) ==================
# La découverte demande à SAM3 « N instances de ce concept » par le TEXTE, dans
# un crop. Ce qui est vérifié ici est ce qui peut casser SILENCIEUSEMENT :
#   - le texte envoyé au tokenizer (``:N`` bien formé, jamais ``:1`` qui
#     retomberait sur le texte brut, virgule = séparateur de catégories) ;
#   - le choix du concept (anglais d'abord, repli label puis texte) ;
#   - le regroupement (une passe par boîte ou une par concept).

def _box(x1, y1, x2, y2, label="", concept=""):
    box = {"x1": x1, "y1": y1, "x2": x2, "y2": y2, "label": label}
    if concept:
        box["concept"] = concept
    return box


class TestConceptParsing:
    """``concept`` est un champ OPTIONNEL : son absence ne doit RIEN casser."""

    def test_concept_is_exposed_when_present(self):
        boxes, reason = M.parse_boxes(
            '{"boxes":[{"x1":0.1,"y1":0.1,"x2":0.4,"y2":0.4,'
            '"label":"bouton","concept":"shirt button"}]}', 640, 480)
        assert reason is None
        assert boxes[0]["concept"] == "shirt button"
        assert boxes[0]["label"] == "bouton"

    def test_concept_is_empty_string_when_absent(self):
        """RÉTRO-COMPAT : un LLM d'avant la phase 3 ne renvoie pas ``concept``."""
        boxes, reason = M.parse_boxes(BOXES_JSON, 640, 480)
        assert reason is None
        assert [box["concept"] for box in boxes] == ["", ""]
        assert [box["label"] for box in boxes] == ["cat", "lamp"]

    @pytest.mark.parametrize("key", ["concept", "concept_en", "noun", "category",
                                     "english_label"])
    def test_alternate_keys_are_accepted(self, key):
        boxes, _ = M.parse_boxes(
            f'{{"boxes":[{{"x1":0.1,"y1":0.1,"x2":0.4,"y2":0.4,"{key}":"car wheel"}}]}}',
            640, 480)
        assert boxes[0]["concept"] == "car wheel"

    def test_non_string_concept_is_ignored(self):
        boxes, _ = M.parse_boxes(
            '{"boxes":[{"x1":0.1,"y1":0.1,"x2":0.4,"y2":0.4,"concept":42}]}',
            640, 480)
        assert boxes[0]["concept"] == ""

    def test_flat_list_entries_have_an_empty_concept(self):
        boxes, _ = M.parse_boxes('[[0.1,0.2,0.4,0.5]]', 640, 480)
        assert boxes[0]["concept"] == ""

    def test_concept_survives_the_box_expansion(self):
        """MUTANT : ``expand_box`` qui perd ``concept`` → découverte sans texte."""
        grown = M.expand_box(_box(0.2, 0.2, 0.4, 0.4, "b", "shirt button"),
                             8, 640, 480)
        assert grown["concept"] == "shirt button"
        assert grown["label"] == "b"


class TestDiscoveryPrompt:
    """Construction du prompt SAM3 : ``"<concept>:<count>"``, jamais ``:1``."""

    def test_count_is_appended(self):
        assert M.discovery_prompt("shirt button", 8) == "shirt button:8"

    @pytest.mark.parametrize("count", [1, 0, -3, 0.4])
    def test_never_emits_colon_one(self, count):
        """MUTANT : ``:1`` généré → le tokenizer retombe sur le texte BRUT.

        Avec ``:1`` (comme sans ``:N``) ``SAM3TokenizerWrapper`` ne nettoie pas
        le texte : les caractères « :1 » deviennent des tokens parasites.
        Règle : pour ``count <= 1``, le prompt est le concept NU (aucun « : »).
        """
        prompt = M.discovery_prompt("shirt button", count)
        assert prompt == "shirt button"
        assert ":" not in prompt

    def test_count_is_clamped_to_the_widget_range(self):
        assert M.discovery_prompt("button", 999) == f"button:{M.MAX_DISCOVER_COUNT}"
        assert M.discovery_prompt("button", "6") == "button:6"
        assert M.discovery_prompt("button", None) == "button"

    def test_empty_concept_yields_no_prompt(self):
        assert M.discovery_prompt("", 8) == ""
        assert M.discovery_prompt("   \n ", 8) == ""
        assert M.discovery_prompt(None, 8) == ""

    def test_commas_are_neutralised(self):
        """Une virgule SÉPARE les catégories côté tokenizer SAM3."""
        prompt = M.discovery_prompt("shirt button, red", 4)
        assert "," not in prompt
        assert prompt == "shirt button red:4"

    def test_parentheses_are_neutralised(self):
        """Les parenthèses sont SUPPRIMÉES par le tokenizer (weighting inactif)."""
        prompt = M.discovery_prompt("(shirt) [button]", 2)
        assert "(" not in prompt and ")" not in prompt
        assert "[" not in prompt and "]" not in prompt
        assert prompt == "shirt button:2"

    def test_an_llm_side_colon_is_not_trusted(self):
        """Un LLM qui écrit « button: 4 » ne doit pas piloter ``max_det``."""
        assert M.discovery_prompt("button: 4", 3) == "button:3"
        assert M.discovery_prompt("button:12", 1) == "button"

    def test_newlines_and_quotes_are_flattened(self):
        prompt = M.discovery_prompt('shirt\n"button"', 5)
        assert prompt == "shirt button:5"

    def test_concept_length_is_bounded(self):
        prompt = M.discovery_prompt("a" * 500, 2)
        assert prompt.startswith("a" * M.CONCEPT_MAX_LEN)
        assert prompt.endswith(":2")


class TestDiscoveryConcept:
    """Choix du texte : ``concept`` d'abord, puis ``label``, puis le texte brut."""

    def test_concept_wins_over_label(self):
        assert M.discovery_concept(_box(0, 0, 1, 1, "bouton", "shirt button")) == \
            "shirt button"

    def test_label_is_the_fallback(self):
        assert M.discovery_concept(_box(0, 0, 1, 1, "button")) == "button"

    def test_raw_text_is_the_last_resort(self):
        assert M.discovery_concept(_box(0, 0, 1, 1), "les boutons de la chemise") == \
            "les boutons de la chemise"

    def test_nothing_usable_yields_empty(self):
        assert M.discovery_concept(_box(0, 0, 1, 1)) == ""
        assert M.discovery_concept({}, "") == ""
        assert M.discovery_concept(None, None) == ""

    def test_a_blank_concept_does_not_hide_a_valid_label(self):
        assert M.discovery_concept(
            {"x1": 0, "y1": 0, "x2": 1, "y2": 1, "concept": "  ", "label": "wheel"}
        ) == "wheel"


class TestUnionBox:
    def test_envelope_of_several_boxes(self):
        union = M.union_box([_box(0.2, 0.1, 0.4, 0.3), _box(0.1, 0.2, 0.9, 0.5)])
        assert (union["x1"], union["y1"]) == (0.1, 0.1)
        assert (union["x2"], union["y2"]) == (0.9, 0.5)

    def test_single_box_is_its_own_envelope(self):
        union = M.union_box([_box(0.2, 0.2, 0.4, 0.4)])
        assert (union["x1"], union["y1"], union["x2"], union["y2"]) == \
            (0.2, 0.2, 0.4, 0.4)

    def test_empty_or_unusable_yields_none(self):
        assert M.union_box([]) is None
        assert M.union_box([{}, {"x1": "a"}]) is None
        assert M.union_box([_box(0.4, 0.4, 0.2, 0.2)]) is None, "enveloppe dégénérée"

    def test_a_broken_box_is_ignored_not_fatal(self):
        union = M.union_box([_box(0.2, 0.2, 0.4, 0.4), {"x1": None}])
        assert (union["x1"], union["y1"], union["x2"], union["y2"]) == \
            (0.2, 0.2, 0.4, 0.4)


class TestDiscoveryGroups:
    """Portée ``per_box`` (résolution) vs ``union`` (une passe par concept)."""

    def test_per_box_makes_one_group_per_box(self):
        boxes = [_box(0.1, 0.1, 0.2, 0.2, "bouton"), _box(0.5, 0.5, 0.6, 0.6, "bouton")]
        groups = M.discovery_groups(boxes, "per_box")
        assert len(groups) == 2
        assert all(group["concept"] == "bouton" for group in groups)
        assert groups[0]["box"] == boxes[0]

    def test_union_merges_boxes_of_the_same_concept(self):
        boxes = [_box(0.1, 0.1, 0.2, 0.2, "", "shirt button"),
                 _box(0.5, 0.5, 0.6, 0.6, "", "Shirt  Button")]
        groups = M.discovery_groups(boxes, "union")
        assert len(groups) == 1, "même concept (casse/espaces ignorés) = 1 groupe"
        assert groups[0]["concept"] == "shirt button"
        assert groups[0]["box"] == {"x1": 0.1, "y1": 0.1, "x2": 0.6, "y2": 0.6}
        assert len(groups[0]["boxes"]) == 2

    def test_union_keeps_distinct_concepts_apart(self):
        boxes = [_box(0.1, 0.1, 0.2, 0.2, "", "button"),
                 _box(0.5, 0.5, 0.6, 0.6, "", "collar")]
        groups = M.discovery_groups(boxes, "union")
        assert [group["concept"] for group in groups] == ["button", "collar"]

    def test_scope_order_is_preserved(self):
        boxes = [_box(0, 0, 0.1, 0.1, "b"), _box(0.1, 0.1, 0.2, 0.2, "a"),
                 _box(0.2, 0.2, 0.3, 0.3, "b")]
        groups = M.discovery_groups(boxes, "union")
        assert [group["concept"] for group in groups] == ["b", "a"]
        assert len(groups[0]["boxes"]) == 2

    def test_a_box_without_any_concept_is_skipped(self):
        """MUTANT : garder ces boîtes → prompt vide donc passe inutile."""
        groups = M.discovery_groups([_box(0, 0, 1, 1), _box(0, 0, 1, 1, "x")], "per_box")
        assert len(groups) == 1
        assert groups[0]["concept"] == "x"

    def test_unknown_scope_falls_back_to_per_box(self):
        groups = M.discovery_groups([_box(0, 0, 0.1, 0.1, "a"),
                                     _box(0.5, 0.5, 0.6, 0.6, "a")], "n_importe_quoi")
        assert len(groups) == 2

    def test_the_raw_text_is_the_fallback_concept(self):
        groups = M.discovery_groups([_box(0, 0, 0.1, 0.1)], "per_box", "des boutons")
        assert groups[0]["concept"] == "des boutons"


class TestDiscoveryWidgets:
    """Lecture DÉFENSIVE des 4 widgets de la phase 3."""

    @pytest.mark.parametrize("raw,expected", [
        (None, 0.4), ("0.7", 0.7), (0.25, 0.25), ("abc", 0.4), (9, 1.0), (-2, 0.0),
    ])
    def test_coerce_float_clamps_and_defaults(self, raw, expected):
        assert M.coerce_float(raw, 0.4, 0.0, 1.0) == pytest.approx(expected)

    def test_coerce_float_handles_decimal_comma(self):
        assert M.coerce_float("0,35", 0.4, 0.0, 1.0) == pytest.approx(0.35)


# === 7. PHASE 3 : DÉCOUVERTE — torch (faux détecteur texte + faux CLIP) ====
# Le chemin TEXTE de SAM3 n'est pas ``forward_segment`` : c'est ``unet(...)``
# (``SAM3Model.forward`` → détecteur) avec des embeddings. Deux doublures :
#   - ``_FakeClip`` reproduit l'API PUBLIQUE (``tokenize`` +
#     ``encode_from_tokens_scheduled``) et TAGUE l'embedding avec l'index du
#     prompt encodé → on peut PROUVER quel texte le détecteur a reçu ;
#   - ``_DetectUnet`` étend ``_FakeUnet`` (chemin boîte conservé) et répond au
#     chemin TEXTE par des candidats NORMALISÉS DANS LE CROP, avec des scores
#     CHOISIS → on prouve le remap, le seuil, la troncature et le plafond.

# Boîte CENTRÉE : sa fenêtre de crop (marge 30 %, plancher 32) vaut
# (32, 16, 64, 48) sur une image 96×64 — donc son origine est LOIN de (0,0),
# ce qui rend visible un masque découvert non recollé.
BOX_MID = ('{"boxes":[{"x1":0.40,"y1":0.35,"x2":0.60,"y2":0.65,'
           '"label":"chemise","concept":"shirt button"}]}')
BOX_MID_WINDOW = (32, 16, 64, 48)
# Forme rendue par le chemin BOÎTE (repère du crop) : ne touche pas les coins.
BOX_MID_SHAPE = (0.30, 0.30, 0.50, 0.50)
# Instances découvertes, en coordonnées NORMALISÉES DU CROP.
CORNER_SHAPE = (0.00, 0.00, 0.25, 0.25)
CENTRE_SHAPE = (0.60, 0.10, 0.85, 0.35)
THIRD_SHAPE = (0.10, 0.60, 0.35, 0.85)


class _FakeTokenizer:
    """Porte ``clip_name`` : la garde de capacité de la découverte le lit."""

    def __init__(self, clip_name="sam3_clip"):
        self.clip_name = clip_name


class _FakeClip:
    """Faux CLIP SAM3 : API PUBLIQUE seulement, embedding TAGUÉ par prompt."""

    def __init__(self, clip_name="sam3_clip", error=None):
        self.tokenizer = _FakeTokenizer(clip_name)
        self.error = error
        self.tokenized = []
        self.encoded = []
        self.calls = 0

    def tokenize(self, text):
        self.tokenized.append(text)
        return {"prompt": text}

    def encode_from_tokens_scheduled(self, tokens):
        if self.error is not None:
            raise self.error
        torch = _torch()
        text = tokens["prompt"]
        self.calls += 1
        self.encoded.append(text)
        embeddings = torch.zeros((1, 32, 1024), dtype=torch.float32)
        # Le tag (index du prompt) permet au faux détecteur de dire QUEL texte
        # il a reçu, sans jamais reconstruire une chaîne depuis un tenseur.
        embeddings[0, 0, 0] = float(len(self.encoded) - 1)
        attention_mask = torch.ones((1, 32), dtype=torch.long)
        return [[embeddings, {"attention_mask": attention_mask}]]


def _probs_to_scores(probs):
    """Probabilités → logits (le détecteur sort des scores, le seuil est sigmoïde)."""
    import math

    torch = _torch()
    scores = []
    for prob in probs:
        prob = min(max(float(prob), 1e-6), 1 - 1e-6)
        scores.append(math.log(prob / (1.0 - prob)))
    return torch.tensor([scores], dtype=torch.float32)


class _DetectUnet(_FakeUnet):
    """Faux ``diffusion_model`` : chemin BOÎTE (hérité) + chemin TEXTE (détecteur).

    ``candidates`` = liste d'appels, chaque appel = liste de rectangles normalisés
    DANS LE CROP (comme les 200 requêtes du vrai détecteur, triées par score côté
    node). ``probs`` = probabilité de chaque candidat (convertie en logit).
    """

    def __init__(self, shapes=None, candidates=None, probs=None, error=None,
                 text_error=None):
        super().__init__(shapes, error=None)
        self.candidates = list(candidates or [])
        self.probs = list(probs or [])
        self.text_error = text_error
        self.text_calls = []

    def __call__(self, image, text_embeddings=None, text_mask=None,
                 threshold=None, orig_size=None, **kwargs):
        torch = _torch()
        height, width = orig_size if orig_size else (M.SAM3_SIZE, M.SAM3_SIZE)
        tag = None
        if text_embeddings is not None:
            tag = round(float(text_embeddings[0, 0, 0].item()))
        self.text_calls.append({
            "image": tuple(image.shape),
            "tag": tag,
            "text_shape": tuple(text_embeddings.shape),
            "mask_shape": None if text_mask is None else tuple(text_mask.shape),
            "threshold": threshold,
            "orig_size": (height, width),
            "kwargs": sorted(kwargs),
        })
        if self.text_error is not None:
            raise self.text_error
        index = min(len(self.text_calls) - 1, max(len(self.candidates) - 1, 0))
        per_call = self.candidates[index] if self.candidates else []
        logits = torch.full((1, len(per_call), M.SAM3_SIZE, M.SAM3_SIZE), -1.0)
        for position, rect in enumerate(per_call):
            x1, y1, x2, y2 = (round(value * M.SAM3_SIZE) for value in rect)
            logits[0, position, y1:y2, x1:x2] = 0.5
        resized = torch.nn.functional.interpolate(
            logits, size=(height, width), mode="bilinear", align_corners=False)
        probs = self.probs[:len(per_call)]
        while len(probs) < len(per_call):
            probs.append(0.9)
        return {"boxes": None, "scores": _probs_to_scores(probs), "masks": resized}


def _detect(**kwargs):
    unet = _DetectUnet(**kwargs)
    return _FakeModel(unet), unet


def _clip(**kwargs):
    return _FakeClip(**kwargs)


def _full_shape(rect, window, width=SAM3_W, height=SAM3_H):
    """ORACLE : masque PLEIN FORMAT d'un rectangle exprimé dans le crop."""
    win_w = max(1, int(window[2]) - int(window[0]))
    win_h = max(1, int(window[3]) - int(window[1]))
    crop_mask = _rect_logits_mask([rect], win_w, win_h)
    return M.paste_mask(crop_mask, window, width, height)


@_requires_torch
class TestDiscoveryPipeline:
    """Crop → 1008² → texte ``concept:N`` → N masques REMAPPÉS → union."""

    def _run(self, node, server_env, *, unet_factory=None, clip_factory=None,
             output=BOX_MID, **kwargs):
        server_env["output"] = output
        model, unet = (unet_factory or _detect)(**({} if unet_factory else {
            "shapes": [[BOX_MID_SHAPE]],
            "candidates": [[CORNER_SHAPE]],
        }))
        clip = (clip_factory or _clip)()
        settings = {"preset_id": 3, "sam3_model": model, "sam3_clip": clip,
                    "discover": True, "discover_count": 8,
                    "discover_threshold": 0.4, "expand_px": 0,
                    "crop_margin": 30, "min_crop_px": 32}
        settings.update(kwargs)
        result = node.mask(_black(), "les boutons de la chemise", **settings)
        return result, unet, clip

    def test_the_detector_receives_a_1008_crop_and_the_english_prompt(
            self, node, server_env):
        """MUTANT : prompt sans ``:N`` → ``clip.encoded`` ne finit pas par ``:8``."""
        _, unet, clip = self._run(node, server_env)
        assert len(unet.text_calls) == 1
        call = unet.text_calls[0]
        assert call["image"] == (1, 3, M.SAM3_SIZE, M.SAM3_SIZE), "crop → 1008²"
        assert call["text_shape"] == (1, 32, 1024)
        assert call["mask_shape"] == (1, 32)
        assert call["threshold"] == pytest.approx(0.4)
        assert call["orig_size"] == (32, 32), "masques demandés à la taille de la fenêtre"
        assert clip.encoded[call["tag"]] == "shirt button:8"

    def test_the_prompt_uses_the_label_language_fallback(self, node, server_env):
        """Sans ``concept``, c'est ``label`` qui part (jamais le texte brut)."""
        output = ('{"boxes":[{"x1":0.40,"y1":0.35,"x2":0.60,"y2":0.65,'
                  '"label":"button"}]}')
        _, unet, clip = self._run(node, server_env, output=output)
        assert clip.encoded[unet.text_calls[0]["tag"]] == "button:8"

    def test_discovered_masks_are_pasted_at_the_window_position(
            self, node, server_env):
        """MUTANT : masques non remappés → la forme atterrit en (0,0) de l'image."""
        result, _, _ = self._run(node, server_env)
        mask = result["result"][0][0]
        expected = _full_shape(CORNER_SHAPE, BOX_MID_WINDOW)
        covered = _torch().nonzero(expected)
        assert int(covered.shape[0]) > 0, "l'oracle doit couvrir des pixels"
        row, col = (int(value) for value in covered[0])
        assert mask[row, col].item() == 1.0, "forme découverte recollée à SA position"
        # Le coin (0,0) de l'image est HORS de la fenêtre (32,16) : rien.
        assert mask[4, 4].item() == 0.0

    def test_discovery_adds_to_the_per_box_shapes(self, node, server_env):
        """DÉCISION : union, jamais remplacement — les deux formes coexistent."""
        result, _, _ = self._run(node, server_env)
        mask = result["result"][0][0]
        box_shape = _full_shape(BOX_MID_SHAPE, BOX_MID_WINDOW)
        row, col = (int(value) for value in _torch().nonzero(box_shape)[0])
        assert mask[row, col].item() == 1.0, "forme par boîte CONSERVÉE"
        discovered = _full_shape(CORNER_SHAPE, BOX_MID_WINDOW)
        row, col = (int(value) for value in _torch().nonzero(discovered)[0])
        assert mask[row, col].item() == 1.0, "forme découverte AJOUTÉE"

    def test_duplicates_are_merged(self, node, server_env):
        """MUTANT : dédup coupée → 3 formes comptées au lieu d'1.

        Les doublons étant UNIS (comme la phase 2), l'effet n'est pas visible
        dans les pixels : il l'est dans les compteurs ``ui``, qui sont la seule
        trace observable — et c'est sur eux qu'on s'appuie.
        """
        result, _, _ = self._run(
            node, server_env,
            unet_factory=lambda **kw: _detect(
                shapes=[[BOX_MID_SHAPE]],
                candidates=[[CORNER_SHAPE, CORNER_SHAPE, CORNER_SHAPE]]))
        status = result["ui"]["status"][0]
        assert "découverte « shirt button:8 » : 1 forme(s)" in status
        assert "2 doublon(s) fusionné(s)" in status

    def test_threshold_filters_before_counting(self, node, server_env):
        """MUTANT : seuil ignoré → 3 formes au lieu de 2."""
        result, _, _ = self._run(
            node, server_env,
            unet_factory=lambda **kw: _detect(
                shapes=[[BOX_MID_SHAPE]],
                candidates=[[CORNER_SHAPE, CENTRE_SHAPE, (0.1, 0.6, 0.35, 0.85)]],
                probs=[0.9, 0.45, 0.2]))
        assert "2 forme(s)" in result["ui"]["status"][0]

    def test_count_limits_the_instances(self, node, server_env):
        """MUTANT : ``discover_count`` ignoré → 3 formes au lieu de 2.

        Trois candidats au-dessus du seuil et ``discover_count=2`` : la
        troncature doit garder les DEUX MEILLEURS SCORES (SAM3 trie par score
        décroissant), pas les deux premiers arrivés — c'est ce que vérifie le
        pixel de la troisième instance.
        """
        result, _, clip = self._run(
            node, server_env, discover_count=2,
            unet_factory=lambda **kw: _detect(
                shapes=[[BOX_MID_SHAPE]],
                candidates=[[CORNER_SHAPE, CENTRE_SHAPE, THIRD_SHAPE]],
                probs=[0.9, 0.8, 0.7]))
        assert "2 forme(s)" in result["ui"]["status"][0]
        assert clip.encoded[0] == "shirt button:2"
        mask = result["result"][0][0]
        row, col = (int(value) for value in
                    _torch().nonzero(_full_shape(CORNER_SHAPE, BOX_MID_WINDOW))[0])
        assert mask[row, col].item() == 1.0, "meilleur score conservé"
        row, col = (int(value) for value in
                    _torch().nonzero(_full_shape(THIRD_SHAPE, BOX_MID_WINDOW))[0])
        assert mask[row, col].item() == 0.0, "score le plus faible écarté"

    def test_max_boxes_caps_the_total_number_of_shapes(self, node, server_env):
        """MUTANT : plafond ignoré → les formes en trop seraient recollées."""
        result, _, _ = self._run(
            node, server_env, max_boxes=1, discover_count=2,
            unet_factory=lambda **kw: _detect(
                shapes=[[BOX_MID_SHAPE]],
                candidates=[[CORNER_SHAPE, CENTRE_SHAPE, THIRD_SHAPE]],
                probs=[0.9, 0.8, 0.7]))
        status = result["ui"]["status"][0]
        assert "1 forme(s)" in status
        assert "plafond atteint (1 ignorée(s))" in status
        mask = result["result"][0][0]
        # La forme du meilleur score est gardée…
        row, col = (int(value) for value in
                    _torch().nonzero(_full_shape(CORNER_SHAPE, BOX_MID_WINDOW))[0])
        assert mask[row, col].item() == 1.0
        # … et celle qui suit est IGNORÉE.
        row, col = (int(value) for value in
                    _torch().nonzero(_full_shape(CENTRE_SHAPE, BOX_MID_WINDOW))[0])
        assert mask[row, col].item() == 0.0

    def test_unexpected_discovery_crash_is_caught(self, node, server_env,
                                                  monkeypatch):
        """MUTANT : filet de l'appelant retiré → la node plante.

        Un bug inattendu de la découverte ne doit PAS casser la node : le plan
        de la phase 2 est rendu intact et le statut le dit.
        """
        def boom(*args, **kwargs):
            raise RuntimeError("bug inattendu de la découverte")

        reference, _, _ = self._run(
            node, server_env, discover=False,
            unet_factory=lambda **kw: _detect(
                shapes=[[BOX_MID_SHAPE]], candidates=[[]]))
        monkeypatch.setattr(node, "_discover_shapes", boom)
        result = node.mask(
            _black(), "d", preset_id=3, discover=True, expand_px=0,
            min_crop_px=32,
            sam3_model=_FakeModel(_DetectUnet(shapes=[[BOX_MID_SHAPE]])),
            sam3_clip=_clip())
        assert _torch().equal(result["result"][0], reference["result"][0])
        status = result["ui"]["status"][0]
        assert "découverte interrompue" in status
        assert "bug inattendu de la découverte" in status

    def test_nothing_found_keeps_the_per_box_result(self, node, server_env):
        """REPLI : la découverte ne trouve rien → pixels de la phase 2 intacts."""
        reference, _, _ = self._run(
            node, server_env, discover=False,
            unet_factory=lambda **kw: _detect(
                shapes=[[BOX_MID_SHAPE]], candidates=[[]]))
        result, _, _ = self._run(
            node, server_env,
            unet_factory=lambda **kw: _detect(
                shapes=[[BOX_MID_SHAPE]],
                candidates=[[CORNER_SHAPE]], probs=[0.1]))
        assert _torch().equal(result["result"][0], reference["result"][0])
        assert "0 forme(s)" in result["ui"]["status"][0]
        assert "formes par boîte conservées" in result["ui"]["status"][0]

    def test_a_detector_crash_keeps_the_per_box_result(self, node, server_env):
        """MUTANT : exception du détecteur qui remonte → crash de la node."""
        reference, _, _ = self._run(
            node, server_env, discover=False,
            unet_factory=lambda **kw: _detect(
                shapes=[[BOX_MID_SHAPE]], candidates=[[]]))
        result, _, _ = self._run(
            node, server_env,
            unet_factory=lambda **kw: _detect(
                shapes=[[BOX_MID_SHAPE]], text_error=RuntimeError("CUDA OOM")))
        assert _torch().equal(result["result"][0], reference["result"][0])
        status = result["ui"]["status"][0]
        assert "découverte partielle" in status and "CUDA OOM" in status

    def test_a_clip_crash_keeps_the_per_box_result(self, node, server_env):
        reference, _, _ = self._run(
            node, server_env, discover=False,
            unet_factory=lambda **kw: _detect(
                shapes=[[BOX_MID_SHAPE]], candidates=[[]]))
        result, unet, _ = self._run(
            node, server_env, clip_factory=lambda: _clip(error=RuntimeError("CLIP KO")),
            unet_factory=lambda **kw: _detect(
                shapes=[[BOX_MID_SHAPE]], candidates=[[CORNER_SHAPE]]))
        assert unet.text_calls == [], "aucun appel du détecteur sans embedding"
        assert _torch().equal(result["result"][0], reference["result"][0])
        assert "découverte partielle" in result["ui"]["status"][0]

    def test_the_prompt_is_encoded_once_per_concept(self, node, server_env):
        """MUTANT : cache d'encodage retiré → 2 encodages pour le même texte."""
        output = ('{"boxes":[{"x1":0.10,"y1":0.10,"x2":0.40,"y2":0.40,'
                  '"label":"","concept":"shirt button"},'
                  '{"x1":0.55,"y1":0.55,"x2":0.90,"y2":0.90,'
                  '"label":"","concept":"shirt button"}]}')
        _, unet, clip = self._run(node, server_env, output=output)
        assert len(unet.text_calls) == 2, "une passe par boîte (scope per_box)"
        assert clip.calls == 1, "même texte → un seul encodage"
        assert {call["tag"] for call in unet.text_calls} == {0}


@_requires_torch
class TestDiscoveryScope:
    """``per_box`` (résolution) vs ``union`` (une passe par concept)."""

    def test_per_box_makes_one_pass_per_box(self, node, server_env):
        server_env["output"] = BOXES_2  # labels "a" et "b" → concepts distincts
        model, unet = _detect(shapes=[[SHAPE_A], [SHAPE_B]],
                              candidates=[[CORNER_SHAPE], [CORNER_SHAPE]])
        result = node.mask(_black(), "d", preset_id=3, sam3_model=model,
                           sam3_clip=_clip(), discover=True, discover_scope="per_box",
                           expand_px=0, min_crop_px=32)
        assert len(unet.text_calls) == 2
        assert "sur 2 groupe(s)" in result["ui"]["status"][0]

    def test_union_makes_one_pass_per_concept(self, node, server_env):
        server_env["output"] = (
            '{"boxes":[{"x1":0.02,"y1":0.02,"x2":0.45,"y2":0.45,"label":"button"},'
            '{"x1":0.55,"y1":0.55,"x2":0.95,"y2":0.95,"label":"Button"}]}')
        model, unet = _detect(shapes=[[SHAPE_A], [SHAPE_B]],
                              candidates=[[CORNER_SHAPE]])
        result = node.mask(_black(), "d", preset_id=3, sam3_model=model,
                           sam3_clip=_clip(), discover=True, discover_scope="union",
                           expand_px=0, min_crop_px=32)
        assert len(unet.text_calls) == 1, "même concept = une seule passe"
        assert "sur 1 groupe(s)" in result["ui"]["status"][0]

    def test_sam_crop_false_discovers_on_the_whole_image(self, node, server_env):
        """``sam_crop=False`` → fenêtre = image entière (documenté)."""
        result, unet, _ = TestDiscoveryPipeline()._run(
            node, server_env, sam_crop=False)
        assert unet.text_calls[0]["orig_size"] == (SAM3_H, SAM3_W)
        expected = _full_shape((0.10, 0.10, 0.20, 0.20),
                               (0, 0, SAM3_W, SAM3_H))
        row, col = (int(value) for value in _torch().nonzero(expected)[0])
        assert result["result"][0][0][row, col].item() == 1.0


@_requires_torch
class TestDiscoveryCapacityGuard:
    """Sans CLIP / CLIP non-SAM3 / MODEL sans chemin texte : repli + message."""

    def _pair(self, node, server_env, clip_value=None, **kwargs):
        """Deux exécutions DANS LES MÊMES CONDITIONS : ``sam3_clip=None`` vs CLIP."""
        server_env["output"] = BOX_MID
        model, unet = _detect(shapes=[[BOX_MID_SHAPE]],
                              candidates=[[CORNER_SHAPE]])
        settings = {"preset_id": 3, "sam3_model": model, "discover": True,
                    "expand_px": 0, "min_crop_px": 32}
        settings.update(kwargs)
        reference = node.mask(_black(), "d", sam3_clip=None, **settings)
        result = node.mask(_black(), "d", sam3_clip=clip_value, **settings)
        return reference, result, unet

    def test_no_clip_disables_discovery_and_keeps_the_pixels(
            self, node, server_env):
        """MUTANT : ``sam3_clip=None`` qui plante, ou qui change le résultat."""
        reference, result, unet = self._pair(node, server_env)
        assert unet.text_calls == [], "aucune passe de détecteur sans CLIP"
        assert _torch().equal(result["result"][0], reference["result"][0])
        assert "découverte désactivée" in result["ui"]["status"][0]
        assert "sam3_clip non connecté" in result["ui"]["status"][0]

    def test_a_non_sam3_clip_is_refused(self, node, server_env):
        """Un ``clip_l`` séparé produirait des embeddings silencieusement faux."""
        reference, result, unet = self._pair(
            node, server_env, clip_value=_clip(clip_name="l"))
        assert unet.text_calls == []
        assert _torch().equal(result["result"][0], reference["result"][0])
        assert "encodeur texte SAM3 attendu" in result["ui"]["status"][0]

    def test_an_object_without_the_public_api_is_refused(self, node, server_env):
        reference, result, unet = self._pair(node, server_env,
                                            clip_value=object())
        assert unet.text_calls == []
        assert _torch().equal(result["result"][0], reference["result"][0])
        assert "CLIP sans tokenize()" in result["ui"]["status"][0]

    def test_a_model_without_a_text_path_is_refused(self, node, server_env):
        """Un faux SAM3 non appelable : la découverte est dite indisponible."""
        server_env["output"] = BOX_MID
        model, unet = _sam3([[BOX_MID_SHAPE]])  # ``forward_segment`` seul
        result = node.mask(_black(), "d", preset_id=3, sam3_model=model,
                           sam3_clip=_clip(), discover=True, expand_px=0,
                           min_crop_px=32)
        assert "découverte désactivée" in result["ui"]["status"][0]
        assert "1 forme(s) raffinée(s)" in result["ui"]["status"][0]
        assert len(unet.calls) == 1, "seul le chemin boîte a tourné"

    def test_discover_without_sam3_is_reported(self, node, server_env):
        server_env["output"] = BOX_MID
        result = node.mask(_black(), "d", preset_id=3, discover=True,
                           sam3_clip=_clip())
        assert M.DISCOVER_NEEDS_MODEL_NOTE in result["ui"]["status"][0]
        assert _torch().equal(result["result"][0], _torch().stack(
            [M.boxes_to_mask(M.parse_boxes(BOX_MID, SAM3_W, SAM3_H)[0],
                             SAM3_W, SAM3_H, 0)]))

    def test_discover_without_sam_refine_is_reported(self, node, server_env):
        server_env["output"] = BOX_MID
        model, unet = _detect(shapes=[[BOX_MID_SHAPE]],
                              candidates=[[CORNER_SHAPE]])
        result = node.mask(_black(), "d", preset_id=3, sam3_model=model,
                           sam3_clip=_clip(), discover=True, sam_refine=False)
        assert M.DISCOVER_NEEDS_REFINE_NOTE in result["ui"]["status"][0]
        assert unet.calls == [] and unet.text_calls == []

    def test_discover_false_is_bit_identical_to_phase_two(self, node, server_env):
        """MUTANT : ``discover=False`` qui déclenche quand même une découverte."""
        server_env["output"] = BOX_MID
        model, unet = _detect(shapes=[[BOX_MID_SHAPE]],
                              candidates=[[CORNER_SHAPE]])
        clip = _clip()
        reference = node.mask(_black(), "d", preset_id=3, sam3_model=model,
                              expand_px=0, min_crop_px=32)
        result = node.mask(_black(), "d", preset_id=3, sam3_model=model,
                           sam3_clip=clip, discover=False, expand_px=0,
                           min_crop_px=32)
        assert unet.text_calls == [], "aucune passe texte sans discover=True"
        assert clip.calls == 0, "aucun encodage sans discover=True"
        assert _torch().equal(result["result"][0], reference["result"][0])
        assert _torch().equal(result["result"][1], reference["result"][1])


@_requires_torch
class TestDiscoveryInteractions:
    """Mode ``bbox``, ``feather`` et lecture défensive des widgets."""

    def test_bbox_mode_uses_the_discovered_shapes(self, node, server_env):
        server_env["output"] = BOX_MID
        model, _ = _detect(shapes=[[BOX_MID_SHAPE]],
                           candidates=[[CORNER_SHAPE]])
        result = node.mask(_black(), "d", preset_id=3, sam3_model=model,
                           sam3_clip=_clip(), discover=True, mask_mode="bbox",
                           expand_px=0, min_crop_px=32)
        mask = result["result"][0][0]
        expected = _full_shape(CORNER_SHAPE, BOX_MID_WINDOW)
        row, col = (int(value) for value in _torch().nonzero(expected)[0])
        assert mask[row, col].item() == 1.0, "la forme découverte donne sa boîte"
        # Hors des formes (et hors boîte serrée), le rectangle du LLM ne compte
        # plus en mode bbox : la zone est vide.
        assert mask[BOX_MID_WINDOW[1] + 1, BOX_MID_WINDOW[0] + 30].item() == 0.0

    def test_feather_is_applied_after_discovery(self, node, server_env):
        server_env["output"] = BOX_MID
        model, _ = _detect(shapes=[[BOX_MID_SHAPE]],
                           candidates=[[CORNER_SHAPE]])
        result = node.mask(_black(), "d", preset_id=3, sam3_model=model,
                           sam3_clip=_clip(), discover=True, feather=2,
                           expand_px=0, min_crop_px=32)
        mask = result["result"][0][0]
        assert mask.max().item() <= 1.0
        assert mask.min().item() >= 0.0
        assert torch_has_intermediate(mask), "feather appliqué APRÈS la découverte"

    def test_widgets_are_read_defensively(self, node, server_env):
        """Ancien workflow / appel API partiel : None, chaînes, hors bornes."""
        server_env["output"] = BOX_MID
        model, unet = _detect(shapes=[[BOX_MID_SHAPE]],
                              candidates=[[CORNER_SHAPE]])
        clip = _clip()
        result = node.mask(_black(), "d", preset_id=3, sam3_model=model,
                           sam3_clip=clip, discover="true", discover_count=999,
                           discover_scope=None, discover_threshold="0.25",
                           expand_px=0, min_crop_px=32)
        assert result["result"][0].shape == (1, SAM3_H, SAM3_W)
        assert clip.encoded == [f"shirt button:{M.MAX_DISCOVER_COUNT}"]
        assert unet.text_calls[0]["threshold"] == pytest.approx(0.25)
        assert unet.text_calls[0]["orig_size"] == (32, 32), "scope → per_box"


def torch_has_intermediate(mask):
    """Vrai si le masque contient au moins une valeur ni 0 ni 1 (bord adouci)."""
    return bool(((mask > 0.0) & (mask < 1.0)).any().item())
