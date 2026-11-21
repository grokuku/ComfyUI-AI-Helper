# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Node UPSCALE (`AIHUpscale`, nodes/holaf_upscale_image.py) — deux contrats
# verrouillés ici, sans torch ni ComfyUI (le VRAI source du node est exécuté
# après extraction AST de sa classe, comme tests/test_crop_standalone.py) :
#
#   1. PLAFOND du widget `megapixels` : 64.00, ALIGNÉ sur la Resolution Preset
#      v2 (16.00 avant ce chantier). Défaut/min/pas INCHANGÉS, et le calcul des
#      dimensions pour une demande ≤ 16 MP est STRICTEMENT identique à
#      l'implémentation d'avant (oracle recopié ci-dessous).
#      Ce que 64 MP veut dire ICI : `megapixels` est un BUDGET de pixels
#      (target_pixels = megapixels × 1048576), PAS un facteur d'upscale — le
#      facteur natif du modèle n'est que l'étape 1, l'étape 2 (Stage 2) redimensionne
#      vers les dimensions cibles. 64 MP = 8192×8192 en 1:1.
#      Il n'y a AUCUN garde-fou par côté (pas de min(dim, 16384) comme la v2) :
#      seul le ratio de l'image d'entrée borne les côtés.
#
#   2. FAUX MODÈLE `"none"` : le COMBO `model_name` doit toujours le proposer en
#      TÊTE pour utiliser le node en REDIMENSIONNEMENT PUR (aucun fichier de
#      modèle ouvert, aucun poids chargé). Les valeurs de COMBO ComfyUI sont
#      sérialisées PAR NOM dans `widgets_values` (preuve : aih/repair_workflow.py
#      `remap_widget_values` remappe PAR NOM, js/aih_workflow_share.js mappe des
#      noms de fichiers dans `widgets_values`), donc insérer en tête ne décale
#      AUCUN workflow existant. Le DÉFAUT reste le premier modèle RÉEL ; la
#      sentinelle historique "None" (majuscule = passthrough) reste honorée.
#
# Contrôles négatifs (mutants) : /tmp/mutate_upscale.sh — plafond rabaissé,
# défaut/min modifiés, "none" qui charge quand même un modèle, "none" qui renvoie
# l'image non redimensionnée, "none" qui décale/écrase les modèles réels, miroir
# DOM désaligné.
#
# Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh

import ast
import re
import sys
import types
from pathlib import Path

import pytest

PACK_DIR = Path(__file__).resolve().parent.parent
NODES_DIR = PACK_DIR / "nodes"
# Le test d'alignement importe la VRAIE v2 (`nodes.holaf_resolution_preset_v2`) :
# même convention que tests/test_resolution_preset_highres.py.
for _path in (PACK_DIR, NODES_DIR):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))
UPSCALE_PY = NODES_DIR / "holaf_upscale_image.py"
CLASS_NAME = "UpscaleImageHolaf"
MEGAPIXELS = "megapixels"
CAP = 64.0            # plafond attendu (aligné sur la v2)
OLD_CAP = 16.0        # plafond d'avant ce chantier
BINARY_MP = 1048576.0  # 1 MP = 1024×1024 px (convention du node ET de la v2)


# ════════════════════ Faux objets : exécution sans torch ════════════════════

class _RecordingLogger:
    """Logger factice : garde une trace texte de tout ce qui est journalisé."""

    def __init__(self):
        self.records = []

    def _log(self, level, msg, *args):
        try:
            rendered = msg % args if args else msg
        except Exception:  # pragma: no cover - jamais attendu
            rendered = str(msg)
        self.records.append((level, rendered))

    def info(self, msg, *args):
        self._log("info", msg, *args)

    def warning(self, msg, *args):
        self._log("warning", msg, *args)

    def debug(self, msg, *args):  # pragma: no cover
        self._log("debug", msg, *args)

    def error(self, msg, *args):  # pragma: no cover
        self._log("error", msg, *args)

    def text(self):
        return "\n".join(message for _level, message in self.records)


class _FakeTensor:
    """Tenseur NHWC minimal : seuls `shape`, `float()` et `movedim` sont lus."""

    def __init__(self, shape):
        self.shape = tuple(shape)
        self.movedim_calls = []

    def float(self):
        return _FakeTensor(self.shape)

    def movedim(self, *args):
        self.movedim_calls.append(args)  # ne doit JAMAIS arriver en mode "none"
        raise AssertionError("movedim() appelé : le mode sans modèle doit être sauté")


class _FakeFolderPaths:
    """`folder_paths` factice : liste de modèles pilotée par le test."""

    def __init__(self, models, raises=False):
        self.models = list(models)
        self.raises = raises
        self.get_full_path_calls = []

    def get_filename_list(self, kind):
        assert kind == "upscale_models", kind
        if self.raises:
            raise RuntimeError("dossier upscale_models inaccessible")
        return list(self.models)

    def get_full_path(self, kind, name):
        self.get_full_path_calls.append(name)
        return f"/models/{name}"


class _FakeComfy:
    """`comfy` factice : charger/tuiler un modèle est une ERREUR de test."""

    def __init__(self):
        self.calls = []
        self.model_management = types.SimpleNamespace(
            soft_empty_cache=lambda: self.calls.append("soft_empty_cache"),
            get_torch_device=lambda: "cpu",
        )
        self.utils = types.SimpleNamespace(
            load_torch_file=self._forbidden("load_torch_file"),
            tiled_scale=self._forbidden("tiled_scale"),
        )

    @staticmethod
    def _forbidden(name):
        def _fail(*_args, **_kwargs):
            raise AssertionError(f"{name}() appelé alors qu'aucun modèle ne doit être chargé")
        return _fail


class _FakeModelLoader:
    """`spandrel.ModelLoader` factice : toute tentative de chargement échoue."""

    def load_from_state_dict(self, _sd):
        raise AssertionError("ModelLoader.load_from_state_dict() : aucun modèle ne doit être chargé")


class _FakeImageScale:
    """Remplace `nodes.ImageScale` : enregistre la cible passée au resize."""

    def __init__(self, calls):
        self.calls = calls

    def upscale(self, image, method, width, height, crop):
        self.calls.append({
            "method": method, "width": width, "height": height,
            "crop": crop, "input_shape": tuple(image.shape),
        })
        return (_FakeTensor((image.shape[0], height, width, image.shape[3])),)


def _load_node(models=("4x-UltraSharp.pth", "RealESRGAN_x4.pth"), raises=False):
    """Exécute la VRAIE classe du node (AST) dans un namespace de fakes.

    Retourne ``(classe, env)`` où ``env`` expose les fakes pour les assertions :
    journal, dossier de modèles, appels au resize.
    """
    source = UPSCALE_PY.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(UPSCALE_PY))
    classdef = next(
        (_node for _node in tree.body
         if isinstance(_node, ast.ClassDef) and _node.name == CLASS_NAME),
        None)
    assert classdef is not None, f"classe {CLASS_NAME} absente de {UPSCALE_PY.name}"

    logger = _RecordingLogger()
    folder_paths = _FakeFolderPaths(models, raises=raises)
    comfy = _FakeComfy()
    resizer_calls = []
    env = {
        "logger": logger,
        "folder_paths": folder_paths,
        "comfy": comfy,
        "ModelLoader": _FakeModelLoader,
        "ImageScale": lambda: _FakeImageScale(resizer_calls),
        "torch": types.SimpleNamespace(no_grad=lambda: None),
        "F": types.SimpleNamespace(interpolate=lambda *_a, **_k: None),
        "math": __import__("math"),
        "resizer_calls": resizer_calls,
    }
    exec(compile(ast.Module(body=[classdef], type_ignores=[]), str(UPSCALE_PY), "exec"), env)
    return env[CLASS_NAME], env


def _widget(node=None):
    node = node or _load_node()[0]
    return node.INPUT_TYPES()["required"][MEGAPIXELS]


def _v2_megapixels_cap():
    """Plafond `megapixels` de la Resolution Preset v2 (module RÉEL).

    Le venv de dev n'a pas torch : stub MINIMAL posé le temps de l'import puis
    RETIRÉ (même précaution que tests/test_is_changed_signature.py).
    """
    added = "torch" not in sys.modules
    if added:
        stub = types.ModuleType("torch")
        stub.Tensor = type("_StubTensor", (), {})
        sys.modules["torch"] = stub
    try:
        from nodes import holaf_resolution_preset_v2 as V2

        return V2.HolafResolutionPresetV2.INPUT_TYPES()["required"][MEGAPIXELS][1]["max"]
    finally:
        if added:
            sys.modules.pop("torch", None)


def _legacy_dimensions(width, height, megapixels, multiple):
    """ORACLE : formule exacte d'AVANT ce chantier (recopiée de git HEAD).

    Sert de référence de non-régression : le node doit produire exactement les
    mêmes dimensions pour toute demande ≤ 16 MP (ancien plafond).
    """
    original_pixels = height * width
    target_pixels = megapixels * 1048576.0
    if target_pixels <= 0:
        raise ValueError("Megapixels must be positive.")
    if original_pixels <= 0:
        return (0, 0)
    scale_factor = (target_pixels / original_pixels) ** 0.5
    target_width = max(1, int(width * scale_factor))
    target_height = max(1, int(height * scale_factor))
    if multiple != "None":
        step = int(multiple)
        target_width = max(step, round(target_width / step) * step)
        target_height = max(step, round(target_height / step) * step)
    return (target_width, target_height)


# ═══════════════ 1. Plafond du widget `megapixels` (64 MP) ══════════════════

class TestMegapixelsCap:
    """Le plafond EFFECTIF du node = le `max` du widget (`min(dim, N)` n'existe pas)."""

    def test_widget_is_a_float_with_cap_64(self):
        spec = _widget()
        assert spec[0] == "FLOAT"
        assert spec[1]["max"] == CAP, (
            f"plafond megapixels {spec[1]['max']} ≠ {CAP} : alignement v2 perdu")

    def test_cap_allows_at_least_32_mpx(self):
        assert _widget()[1]["max"] >= 32.0

    def test_cap_leaves_room_to_actually_reach_32_mpx(self):
        """`max` STRICTEMENT > 32 : l'arrondi au multiple peut coûter quelques
        %, donc un plafond à 32,00 interdirait de facto d'atteindre 32 Mpx."""
        assert _widget()[1]["max"] > 32.0

    def test_cap_is_aligned_with_the_resolution_preset_v2(self):
        """MÊME plafond que la Resolution Preset v2 (source de la décision)."""
        assert _widget()[1]["max"] == _v2_megapixels_cap() == CAP

    def test_other_widget_bounds_unchanged(self):
        """Non-régression : défaut/min/pas INCHANGÉS, aucun `round` ajouté."""
        bounds = _widget()[1]
        assert bounds["default"] == 2.00
        assert bounds["min"] == 0.01
        assert bounds["step"] == 0.01
        assert "round" not in bounds
        assert set(bounds) == {"default", "min", "max", "step"}

    def test_cap_really_left_the_old_ceiling(self):
        assert _widget()[1]["max"] > OLD_CAP


class TestNoDomMirrorDrifts:
    """Pas de miroir DOM pour ce node : widgets ComfyUI NATIFS.

    Le garde-fou reste utile : si une extension DOM apparaît un jour avec un
    champ `megapixels`, son `.max` ne doit pas être plus bas que le backend.
    """

    def test_no_dom_widget_extension_exists_for_this_node(self):
        offenders = sorted(
            path.name
            for path in (PACK_DIR / "js").rglob("*.js")
            if "node_modules" not in path.parts
            and "AIHUpscale" in path.read_text(encoding="utf-8", errors="ignore")
        )
        # Seul le mapping de partage de workflow mentionne le type du node.
        assert offenders == ["aih_workflow_share.js"], offenders

    def test_any_megapixels_dom_max_is_not_below_the_backend_cap(self):
        cap = _widget()[1]["max"]
        for path in sorted((PACK_DIR / "js").rglob("*.js")):
            if "node_modules" in path.parts:
                continue
            source = path.read_text(encoding="utf-8", errors="ignore")
            for match in re.finditer(r'(\w*[mM]egapixels\w*)\.max\s*=\s*"([0-9.]+)"', source):
                assert float(match.group(2)) >= cap, (
                    f"{path.name} : {match.group(1)}.max={match.group(2)} < plafond backend {cap}")


# ═════════ 2. Sémantique du budget : ce que 64 MP veut dire ici ═════════════

class TestBudgetSemantics:
    """`megapixels` = BUDGET de pixels, pas un facteur d'upscale."""

    def test_64_mpx_is_8192_square(self):
        node, _env = _load_node()
        assert node.compute_target_dimensions(1024, 1024, 64.0, "None") == (8192, 8192)
        assert node.compute_target_dimensions(1024, 1024, 64.0, "8") == (8192, 8192)

    @pytest.mark.parametrize("megapixels", [33.2, 34.0, 40.0, 64.0])
    def test_high_budgets_actually_reach_32_mpx(self, megapixels):
        node, _env = _load_node()
        for width, height in ((1024, 1024), (3000, 1000), (800, 1200)):
            target = node.compute_target_dimensions(width, height, megapixels, "16")
            assert target[0] * target[1] >= 32 * BINARY_MP, f"{megapixels} MP → {target}"

    def test_budget_is_rounded_not_hard_capped(self):
        """Différence ASSUMÉE avec la v2 : ici pas de boucle « ne dépasse pas »,
        l'arrondi au plus proche multiple peut dépasser le budget de < 1 pas."""
        node, _env = _load_node()
        width, height = node.compute_target_dimensions(1024, 1024, 33.5, "64")
        assert (width, height) == (5952, 5952)
        assert width * height > 33.5 * BINARY_MP  # dépassement documenté (< 1 %)

    def test_no_per_side_guard_contradicts_the_v2(self):
        """⚠️ Contrairement à la v2 (min(dim, 16384)), ce node n'a AUCUN
        garde-fou par côté : un ratio d'entrée extrême produit un côté énorme.
        Test de CARACTÉRISATION (documente le risque, ne le « corrige » pas)."""
        node, _env = _load_node()
        width, height = node.compute_target_dimensions(8000, 80, 64.0, "8")
        assert max(width, height) > 16384
        assert width * height <= 64.5 * BINARY_MP  # le budget, lui, est tenu

    def test_non_positive_budget_raises(self):
        node, _env = _load_node()
        with pytest.raises(ValueError):
            node.compute_target_dimensions(100, 100, 0, "None")

    def test_degenerate_image_returns_sentinel(self):
        node, _env = _load_node()
        assert node.compute_target_dimensions(0, 100, 2.0, "None") == (0, 0)


class TestBelowOldCapIsUnchanged:
    """NON-RÉGRESSION : pour toute demande ≤ 16 MP (ancien plafond), le calcul
    est STRICTEMENT celui d'avant (oracle `_legacy_dimensions`)."""

    @pytest.mark.parametrize("megapixels", [0.01, 0.25, 1.0, 2.0, 2.5, 4.0, 8.0, 16.0])
    @pytest.mark.parametrize("multiple", ["None", "8", "16", "32", "64"])
    def test_dimensions_identical_to_the_legacy_formula(self, megapixels, multiple):
        node, _env = _load_node()
        for width, height in ((1024, 1024), (1920, 1080), (512, 768), (8000, 80), (7, 3)):
            assert node.compute_target_dimensions(width, height, megapixels, multiple) == \
                _legacy_dimensions(width, height, megapixels, multiple), (
                    f"{width}x{height} @ {megapixels} MP / multiple {multiple}")

    def test_default_value_still_maps_to_the_same_dimensions(self):
        """Le défaut 2.00 (inchangé) donne les dimensions historiques."""
        node, _env = _load_node()
        assert node.compute_target_dimensions(1024, 1024, 2.0, "64") == (1472, 1472)


# ══════════ 3. Faux modèle "none" : redimensionnement pur, zéro modèle ══════

class TestFakeModelNoneInTheCombo:
    """Le COMBO `model_name` propose toujours "none", défaut = 1er modèle réel."""

    @staticmethod
    def _options(node):
        return node.INPUT_TYPES()["required"]["model_name"]

    def test_none_is_offered_first_and_real_models_keep_their_order(self):
        options, opts = self._options(_load_node(models=("a.pth", "b.pth"))[0])
        assert options[0] == "none"
        # Aucun modèle réel perdu/réordonné/dupliqué par l'insertion.
        assert options[1:] == ["a.pth", "b.pth"]
        assert opts["default"] == "a.pth", "le défaut doit rester le 1er modèle RÉEL"

    def test_combo_values_are_strings_so_inserting_does_not_shift_workflows(self):
        """Un COMBO ComfyUI sérialise la VALEUR (chaîne), jamais l'index :
        preuve dans le pack — le remappage des `widgets_values` se fait PAR NOM."""
        options, opts = self._options(_load_node(models=("a.pth", "b.pth"))[0])
        assert isinstance(options, list) and all(isinstance(v, str) for v in options)
        assert opts["default"] in options
        repair = (PACK_DIR / "aih" / "repair_workflow.py").read_text(encoding="utf-8")
        assert "POSITIONNELS par NOM" in repair
        share = (PACK_DIR / "js" / "aih_workflow_share.js").read_text(encoding="utf-8")
        assert "widgets_values" in share and "typeof val !== 'string'" in share

    def test_none_is_offered_even_without_any_model(self):
        """Dossier vide/inaccessible : "none" reste disponible, et la liste
        retombe EXACTEMENT sur l'ancienne (["None"], défaut "None" = passthrough)."""
        options, opts = self._options(_load_node(models=())[0])
        assert options == ["none", "None"]
        assert opts["default"] == "None"

    def test_none_is_offered_when_the_folder_raises(self):
        node, env = _load_node(raises=True)
        options, opts = self._options(node)
        assert options == ["none", "None"]
        assert opts["default"] == "None"
        assert "Could not access upscale_models folder." in env["logger"].text()


class TestNoneResamplesWithoutLoadingAModel:
    """Mode "none" : Stage 2 fait tout, aucun fichier modèle n'est ouvert."""

    @staticmethod
    def _run(model_name="none", megapixels=2.0, multiple="None", method="lanczos",
             resize_mode="stretch", shape=(1, 256, 512, 3)):
        node, env = _load_node()
        image = _FakeTensor(shape)
        result = node().upscale(image, model_name, method, megapixels, multiple,
                                resize_mode, False)
        return node, env, image, result

    def test_no_model_file_is_opened(self):
        _node, env, _image, _result = self._run()
        assert env["folder_paths"].get_full_path_calls == []
        # …et aucun appel de chargement/tuilage n'a eu lieu (fakes « interdits »).
        assert "soft_empty_cache" in env["comfy"].calls  # vidage de cache, oui

    def test_target_dimensions_are_honoured(self):
        node, env, image, result = self._run(megapixels=2.0, method="lanczos")
        expected = node.compute_target_dimensions(image.shape[2], image.shape[1], 2.0, "None")
        assert len(env["resizer_calls"]) == 1
        call = env["resizer_calls"][0]
        assert (call["width"], call["height"]) == expected
        assert call["method"] == "lanczos"
        assert call["crop"] == "disabled"
        assert result[0].shape == (1, expected[1], expected[0], 3)

    def test_multiple_constraint_still_applies(self):
        node, env, image, _result = self._run(megapixels=64.0, multiple="64")
        width, height = env["resizer_calls"][0]["width"], env["resizer_calls"][0]["height"]
        assert width % 64 == 0 and height % 64 == 0
        assert (width, height) == node.compute_target_dimensions(
            image.shape[2], image.shape[1], 64.0, "64")

    def test_resample_is_logged(self):
        _node, env, _image, _result = self._run(method="bicubic")
        assert "[AIH-Upscale] no upscale model selected → pure resample (bicubic)" \
            in env["logger"].text()

    def test_output_model_name_is_the_fake_model(self):
        _node, _env, _image, result = self._run()
        assert result[1] == "none"


class TestRealModelPathUnchanged:
    """Avec un vrai modèle : comportement strictement identique (Stage 1 + Stage 2)."""

    @staticmethod
    def _run_with_recorder(model_name="4x-UltraSharp.pth", megapixels=2.0, shape=(1, 256, 512, 3)):
        node, env = _load_node()
        calls = []

        def _fake_model_stage(instance, image, name):  # remplace _upscale_with_model
            calls.append((name, tuple(image.shape)))
            return _FakeTensor(shape)  # le modèle « 4× » aurait produit plus grand

        node._upscale_with_model = _fake_model_stage
        image = _FakeTensor(shape)
        result = node().upscale(image, model_name, "lanczos", megapixels, "None", "stretch", False)
        return node, env, calls, result

    def test_model_stage_is_used_for_a_real_model(self):
        _node, env, calls, _result = self._run_with_recorder()
        assert calls == [("4x-UltraSharp.pth", (1, 256, 512, 3))], (
            "un vrai modèle doit passer par _upscale_with_model")
        assert env["folder_paths"].get_full_path_calls == []  # …fait DANS la méthode

    def test_none_must_not_be_routed_through_the_model_stage(self):
        node, _env = _load_node()
        calls = []
        node._upscale_with_model = lambda inst, image, name: calls.append(name)
        node().upscale(_FakeTensor((1, 256, 512, 3)), "none", "lanczos", 2.0, "None", "stretch", False)
        assert calls == []

    def test_stage_two_dimensions_are_the_same_as_before(self):
        node, env, _calls, _result = self._run_with_recorder(megapixels=2.0)
        expected = node.compute_target_dimensions(512, 256, 2.0, "None")
        assert tuple(env["resizer_calls"][0][k] for k in ("width", "height")) == expected


class TestLegacyPassthroughUntouched:
    """Sentinelle historique "None" (majuscule) : image renvoyée INCHANGÉE."""

    @pytest.mark.parametrize("model_name", ["None", ""])
    def test_legacy_value_returns_the_image_as_is(self, model_name):
        node, env = _load_node()
        image = _FakeTensor((1, 64, 64, 3))
        result = node().upscale(image, model_name, "lanczos", 64.0, "None", "stretch", False)
        assert result[0] is image, "passthrough : le MÊME objet, pas une copie"
        assert result[1] == "None"
        assert env["resizer_calls"] == []
        assert env["folder_paths"].get_full_path_calls == []

    def test_legacy_value_is_not_confused_with_the_fake_model(self):
        """La comparaison est EXACTE (pas de `.lower()`) : "None" historique et
        "none" sont deux entrées distinctes, avec deux comportements distincts."""
        node, _env = _load_node()
        assert node.NO_MODEL == "none"
        assert node.LEGACY_PASSTHROUGH == "None"
        source = UPSCALE_PY.read_text(encoding="utf-8")
        assert ".lower()" not in source, (
            "une comparaison insensible à la casse confondrait 'None' (passthrough) "
            "et 'none' (redimensionnement pur)")
