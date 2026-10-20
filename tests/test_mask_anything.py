# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Node expérimentale « AIH Mask Anything » : IMAGE + description → MASK.
#
# Deux étages de tests, volontairement séparés :
#   1. LOGIQUE PURE (aucun torch) : extraction du JSON noyé, formats acceptés
#      (objet boxes, liste de listes, box_2d [y1,x1,y2,x2] 0-1000, pixels),
#      détection d'unités, clamping, boîtes inversées/dégénérées, doublons,
#      réponses sales qui ne doivent JAMAIS lever ;
#   2. NODE avec torch (``pytest.importorskip``) : forme du masque, union de
#      plusieurs boîtes, feather (valeurs intermédiaires, jamais hors bornes),
#      masque VIDE + message visible sur échec, non-régression du batch,
#      et PREUVE du transport multimodal (l'image part bien dans le message
#      user sous forme de data-URL ``image_url``).
#
# Contrôles négatifs par mutation : harnais hors dépôt
# /projects/.aih_tmp/mask_anything_mutate/mutate.py (restauration + sha256),
# voir le livrable. Au moins : « 0-1000 accepté comme normalisé », « clamping
# retiré », « boîte dégénérée → masque plein », « échec qui crashe », « masque
# non 0/1 » doivent faire ROUGIR cette suite.
#
# Usage :
#   PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh -k mask_anything
#   (torch absent du venv de dev : les tests 2 sont alors SKIPPED, jamais verts)

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
