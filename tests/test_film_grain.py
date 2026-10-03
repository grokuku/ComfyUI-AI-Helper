# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Tests de la node « AIH Film Grain » (nodes/holaf_film_grain.py).
#
# Ce que ce fichier verrouille :
#   1. enregistrement ComfyUI (clé unique AIHFilmGrain, label, catégorie,
#      DESCRIPTION, tooltips, seed avec control_after_generate) ;
#   2. contrat d'image : forme [B,H,W,3|4] fp32, sortie bornée [0,1], sans NaN,
#      entrée JAMAIS mutée ;
#   3. identité bit-à-bit à intensity=0 (contrôle négatif contractuel) et
#      identité à mask=0 ;
#   4. déterminisme (même seed ⇒ mêmes bits ; seeds différents ⇒ sorties
#      différentes) ;
#   5. alpha préservé bit-à-bit (le grain ne touche que le RGB) ;
#   6. batch : animated=false ⇒ grain identique sur tout le batch ;
#      animated=true ⇒ grain stable par frame mais différent d'une frame à
#      l'autre (seed + index de frame) ;
#   7. grain_size > 2 px : champ à résolution réduite + rééchantillonnage
#      (grains plus larges, même amplitude, pas d'artefact) ;
#   8. réponses Neutral / Filmic / Custom (atténuation ombres/hautes lumières) ;
#   9. chroma_grain=0 ⇒ grain monochrome (R=G=B) ; >0 ⇒ grain coloré, et le
#      grain de luminance ne change pas avec chroma_grain ;
#  10. vram_rows : traitement par tranches == traitement d'un bloc, bit-à-bit ;
#  11. amplitude du grain (σ de référence à 100 %) et linéarité de l'intensité.
#
# Le venv de dev du pack n'a pas torch : pytest.importorskip("torch") fait
# SKIPPER proprement tout le fichier (aucune erreur de collecte). Le vrai run
# torch se fait dans l'environnement ComfyUI de l'utilisateur.
#
# Contrôles négatifs par mutation : /projects/.aih_tmp/film_grain_bench/mutate.sh
# (7 mutations réelles du source → chaque test ciblé devient ROUGE, puis source
# restaurée et vérifiée par sha256).
#
# Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh

import importlib.util
import math
import sys
from pathlib import Path

import pytest

torch = pytest.importorskip("torch")

PACKAGE_DIR = Path(__file__).resolve().parent.parent
NODE_PATH = PACKAGE_DIR / "nodes" / "holaf_film_grain.py"


def _load_node_module():
    """Charge le fichier de node par chemin (comme le loader dynamique du pack)."""
    spec = importlib.util.spec_from_file_location("holaf_film_grain_under_test", NODE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


NODE_MODULE = _load_node_module()
NODE = NODE_MODULE.HolafFilmGrain()

# Paramètres « par défaut » réutilisés partout (mêmes valeurs que la node).
DEFAULTS = dict(model="Parametric (AV1)", intensity=100.0, grain_size=1.2,
                response="Filmic", shadows_falloff=40.0, highlights_falloff=60.0,
                chroma_grain=15.0, seed=42)


def run(image, **overrides):
    """Appelle la node avec les défauts du contrat + surcharges explicites."""
    kwargs = dict(DEFAULTS)
    kwargs.update(overrides)
    node_kwargs = dict(image=image, model=kwargs.pop("model"),
                       intensity=kwargs.pop("intensity"), grain_size=kwargs.pop("grain_size"),
                       response=kwargs.pop("response"), shadows_falloff=kwargs.pop("shadows_falloff"),
                       highlights_falloff=kwargs.pop("highlights_falloff"),
                       chroma_grain=kwargs.pop("chroma_grain"), seed=kwargs.pop("seed"))
    node_kwargs.update(kwargs)  # mask / animated / vram_rows
    return NODE.add_grain(**node_kwargs)[0]


def bits(tensor):
    """Empreinte bit-à-bit (fp32) pour comparer deux tenseurs sans tolérance."""
    return tensor.detach().contiguous().view(torch.int32).cpu().numpy().tobytes()


def rand_image(batch, height, width, channels=3, seed=1):
    generator = torch.Generator().manual_seed(seed)
    return torch.rand((batch, height, width, channels), generator=generator)


# ---------------------------------------------------------------------------
# 1. Enregistrement et métadonnées
# ---------------------------------------------------------------------------

def test_registration_key_is_unique_and_metadata_is_present():
    assert list(NODE_MODULE.NODE_CLASS_MAPPINGS) == ["AIHFilmGrain"]
    assert NODE_MODULE.NODE_CLASS_MAPPINGS["AIHFilmGrain"] is NODE_MODULE.HolafFilmGrain
    assert NODE_MODULE.NODE_DISPLAY_NAME_MAPPINGS == {"AIHFilmGrain": "AIH Film Grain"}
    assert NODE_MODULE.HolafFilmGrain.CATEGORY == "AIH/Image"
    assert NODE_MODULE.HolafFilmGrain.RETURN_TYPES == ("IMAGE",)
    assert NODE_MODULE.HolafFilmGrain.FUNCTION == "add_grain"
    assert isinstance(NODE_MODULE.HolafFilmGrain.DESCRIPTION, str)
    assert len(NODE_MODULE.HolafFilmGrain.DESCRIPTION) > 40


def test_input_contract_matches_validated_design():
    spec = NODE_MODULE.HolafFilmGrain.INPUT_TYPES()
    required = spec["required"]
    optional = spec["optional"]
    assert set(required) == {"image", "model", "intensity", "grain_size", "response",
                             "shadows_falloff", "highlights_falloff", "chroma_grain", "seed"}
    assert set(optional) == {"mask", "animated", "vram_rows"}
    assert required["model"][0] == ["Parametric (AV1)"]
    assert required["intensity"][1]["min"] == 0.0 and required["intensity"][1]["max"] == 200.0
    assert required["grain_size"][1]["min"] == 0.5 and required["grain_size"][1]["max"] == 4.0
    assert required["response"][0] == ["Neutral", "Filmic", "Custom"]
    assert required["chroma_grain"][1]["min"] == 0.0 and required["chroma_grain"][1]["max"] == 100.0
    assert required["seed"][1].get("control_after_generate") is True
    assert optional["animated"][1]["default"] is False
    assert optional["vram_rows"][1]["default"] == 0
    # Tous les widgets portent un tooltip exploité par le frontend de référence.
    for name, entry in list(required.items()) + list(optional.items()):
        options = entry[1] if len(entry) > 1 else {}
        assert isinstance(options.get("tooltip"), str) and options["tooltip"], name


# ---------------------------------------------------------------------------
# 2. Forme / dtype / plage / NaN / entrée non mutée
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("batch", [1, 4])
def test_output_shape_dtype_bounds_and_input_untouched(batch):
    image = rand_image(batch, 96, 128)
    snapshot = bits(image)
    out = run(image)
    assert out.shape == image.shape and out.dtype == torch.float32
    assert torch.isfinite(out).all()
    assert float(out.min()) >= 0.0 and float(out.max()) <= 1.0
    assert bits(image) == snapshot, "l'entrée ne doit jamais être mutée"
    assert not torch.equal(out, image), "le grain doit modifier l'image"


def test_channel_count_four_is_supported():
    image = rand_image(1, 64, 64, channels=4, seed=3)
    out = run(image)
    assert out.shape == (1, 64, 64, 4)


def test_empty_batch_is_returned_unchanged():
    image = torch.zeros((0, 32, 32, 3))
    out = run(image)
    assert out.shape == image.shape


# ---------------------------------------------------------------------------
# 3. Contrat négatif : intensity=0 ⇒ identité bit-à-bit ; mask=0 ⇒ identité
# ---------------------------------------------------------------------------

def test_intensity_zero_is_bit_identical():
    image = rand_image(2, 96, 128)
    out = run(image, intensity=0.0)
    assert bits(out) == bits(image)
    # Et avec un masque fourni : toujours identique, aucun tirage consommé.
    out_masked = run(image, intensity=0.0, mask=torch.zeros(96, 128))
    assert bits(out_masked) == bits(image)


def test_mask_zero_is_identity_and_partial_mask_is_localized():
    image = rand_image(1, 96, 128)
    out_zero = run(image, mask=torch.zeros(96, 128))
    assert bits(out_zero) == bits(image)

    half = torch.zeros(96, 128)
    half[:64, :] = 1.0  # grain uniquement sur la moitié haute
    out_half = run(image, mask=half)
    assert bits(out_half[:, 64:, :]) == bits(image[:, 64:, :]), "masque 0 : image intacte"
    assert not torch.equal(out_half[:, :64, :], image[:, :64, :]), "masque 1 : grain présent"

    # Un masque plein donne EXACTEMENT le résultat sans masque (mêmes tirages).
    out_full = run(image, mask=torch.ones(96, 128))
    assert bits(out_full) == bits(run(image))


def test_mask_broadcast_shapes_and_errors():
    image = rand_image(2, 64, 80)
    mask_2d = torch.rand((64, 80), generator=torch.Generator().manual_seed(5))
    mask_3d = mask_2d.unsqueeze(0).expand(2, 64, 80)
    mask_4d = mask_2d.unsqueeze(0).unsqueeze(-1)
    assert bits(run(image, mask=mask_2d)) == bits(run(image, mask=mask_3d))
    assert bits(run(image, mask=mask_2d)) == bits(run(image, mask=mask_4d))
    with pytest.raises(ValueError):
        run(image, mask=torch.zeros(32, 80))


# ---------------------------------------------------------------------------
# 4. Déterminisme
# ---------------------------------------------------------------------------

def test_same_seed_is_deterministic_and_different_seeds_differ():
    image = rand_image(1, 96, 128)
    first = run(image, seed=1234)
    second = run(image, seed=1234)
    other = run(image, seed=1235)
    assert bits(first) == bits(second), "même seed ⇒ mêmes bits"
    assert not torch.equal(first, other), "seed différent ⇒ sortie différente"


# ---------------------------------------------------------------------------
# 5. Alpha préservé
# ---------------------------------------------------------------------------

def test_alpha_is_preserved_bit_for_bit():
    image = rand_image(2, 64, 96, channels=4, seed=6)
    out = run(image)
    assert bits(out[..., 3:]) == bits(image[..., 3:]), "alpha inchangé"
    assert not torch.equal(out[..., :3], image[..., :3]), "RGB grainé"


# ---------------------------------------------------------------------------
# 6. Batch : photo (grain identique) vs vidéo (par frame)
# ---------------------------------------------------------------------------

def test_animated_false_gives_identical_grain_across_batch():
    frame = rand_image(1, 64, 96, seed=8)
    batch = frame.repeat(4, 1, 1, 1)
    out = run(batch, animated=False)
    for index in range(1, 4):
        assert bits(out[0]) == bits(out[index]), "photo : grain identique pour tout le batch"


def test_animated_true_gives_stable_per_frame_grain():
    frame = rand_image(1, 64, 96, seed=8)
    batch = frame.repeat(4, 1, 1, 1)
    first = run(batch, animated=True)
    second = run(batch, animated=True)
    assert bits(first) == bits(second), "vidéo : reproductible à seed égale"
    assert not torch.equal(first[0], first[1]), "vidéo : grain différent d'une frame à l'autre"
    assert not torch.equal(first[1], first[2])


# ---------------------------------------------------------------------------
# 7. grain_size > 2 px : champ réduit + rééchantillonnage
# ---------------------------------------------------------------------------

def _grain_field(flat_image, grain_size, intensity=100.0, response="Neutral",
                 chroma_grain=0.0, seed=42):
    out = run(flat_image, grain_size=grain_size, intensity=intensity, response=response,
              chroma_grain=chroma_grain, seed=seed)
    return out[0, :, :, 0] - flat_image[0, :, :, 0]


def test_grain_size_above_two_is_smooth_but_same_amplitude():
    image = torch.full((1, 256, 256, 3), 0.5)
    fine = _grain_field(image, 1.2)
    coarse = _grain_field(image, 4.0)
    fine_step = float((fine[:, 1:] - fine[:, :-1]).abs().mean())
    coarse_step = float((coarse[:, 1:] - coarse[:, :-1]).abs().mean())
    assert coarse_step < fine_step * 0.6, "grain 4 px : champ plus lisse (rééchantillonné)"
    assert abs(float(fine.std()) - float(coarse.std())) < 0.15 * float(fine.std()), "même amplitude"
    assert not torch.equal(fine, coarse)


@pytest.mark.parametrize("grain_size", [0.5, 2.0, 2.5, 4.0])
def test_all_grain_sizes_are_clean(grain_size):
    image = rand_image(1, 80, 96, seed=11)
    out = run(image, grain_size=grain_size)
    assert torch.isfinite(out).all()
    assert float(out.min()) >= 0.0 and float(out.max()) <= 1.0
    assert not torch.equal(out, image)


# ---------------------------------------------------------------------------
# 8. Réponses Neutral / Filmic / Custom
# ---------------------------------------------------------------------------

def _amplitude(level, **overrides):
    image = torch.full((1, 96, 96, 3), level)
    out = run(image, chroma_grain=0.0, **overrides)
    return float((out - level).abs().mean())


def test_neutral_equals_custom_without_falloffs():
    image = rand_image(1, 64, 96, seed=12)
    neutral = run(image, response="Neutral", chroma_grain=0.0)
    custom_zero = run(image, response="Custom", shadows_falloff=0.0,
                      highlights_falloff=0.0, chroma_grain=0.0)
    assert bits(neutral) == bits(custom_zero)


def test_filmic_attenuates_shadows_and_highlights():
    dark_neutral = _amplitude(0.05, response="Neutral")
    dark_filmic = _amplitude(0.05, response="Filmic")
    bright_neutral = _amplitude(0.95, response="Neutral")
    bright_filmic = _amplitude(0.95, response="Filmic")
    mid_neutral = _amplitude(0.5, response="Neutral")
    mid_filmic = _amplitude(0.5, response="Filmic")
    assert dark_filmic < dark_neutral
    assert bright_filmic < bright_neutral
    assert mid_filmic < mid_neutral * 1.05  # pic conservé dans les tons moyens


def test_custom_falloffs_only_apply_to_custom_response():
    dark_zero = _amplitude(0.05, response="Custom", shadows_falloff=0.0, highlights_falloff=0.0)
    dark_full = _amplitude(0.05, response="Custom", shadows_falloff=100.0, highlights_falloff=100.0)
    assert dark_full < dark_zero * 0.2, "shadows_falloff=100 ⇒ grain quasi nul dans les noirs"
    # Hors Custom, les deux réglages sont ignorés : sorties identiques.
    filmic_a = run(rand_image(1, 48, 48, seed=13), response="Filmic",
                   shadows_falloff=0.0, highlights_falloff=0.0)
    filmic_b = run(rand_image(1, 48, 48, seed=13), response="Filmic",
                   shadows_falloff=100.0, highlights_falloff=100.0)
    assert bits(filmic_a) == bits(filmic_b)


def test_filmic_is_default_response():
    spec = NODE_MODULE.HolafFilmGrain.INPUT_TYPES()
    assert spec["required"]["response"][1]["default"] == "Filmic"


# ---------------------------------------------------------------------------
# 9. Chroma
# ---------------------------------------------------------------------------

def test_chroma_zero_is_monochrome_grain():
    image = torch.full((1, 96, 96, 3), 0.5)
    out = run(image, chroma_grain=0.0)
    assert bits(out[..., 0]) == bits(out[..., 1]) == bits(out[..., 2]), "grain monochrome"


def test_chroma_grain_adds_color_without_touching_luma():
    image = torch.full((1, 96, 96, 3), 0.5)
    mono = run(image, chroma_grain=0.0)
    colored = run(image, chroma_grain=30.0)
    assert not torch.equal(colored[..., 0], colored[..., 1]), "grain coloré attendu"
    weights = torch.tensor([0.299, 0.587, 0.114])
    luma_mono = ((mono[0] - 0.5) * weights).sum(-1)
    luma_colored = ((colored[0] - 0.5) * weights).sum(-1)
    assert float((luma_mono - luma_colored).abs().max()) < 1e-4, \
        "chroma_grain ne doit pas modifier le grain de luminance"


# ---------------------------------------------------------------------------
# 10. vram_rows : découpage == traitement d'un bloc (bit-à-bit)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("grain_size", [1.2, 3.0])
@pytest.mark.parametrize("rows", [1, 37])
def test_vram_rows_slicing_is_bit_identical(grain_size, rows):
    image = rand_image(1, 300, 200, seed=14)
    whole = run(image, grain_size=grain_size, vram_rows=0)
    sliced = run(image, grain_size=grain_size, vram_rows=rows)
    assert bits(whole) == bits(sliced)


def test_vram_rows_also_slices_the_animated_path():
    batch = rand_image(4, 128, 96, seed=15)
    whole = run(batch, animated=True, grain_size=3.0, vram_rows=0)
    sliced = run(batch, animated=True, grain_size=3.0, vram_rows=13)
    assert bits(whole) == bits(sliced)


# ---------------------------------------------------------------------------
# 11. Amplitude et linéarité de l'intensité
# ---------------------------------------------------------------------------

def test_grain_amplitude_and_intensity_linearity():
    image = torch.full((1, 128, 128, 3), 0.5)
    field = run(image, response="Neutral", chroma_grain=0.0, seed=7)[0, :, :, 0] - 0.5
    sigma = float(field.std())
    assert 0.021 < sigma < 0.029, f"σ de grain ≈ 0.025 attendu à 100 %, obtenu {sigma:.4f}"
    doubled = run(image, intensity=200.0, response="Neutral", chroma_grain=0.0, seed=7)[0, :, :, 0] - 0.5
    ratio = float(doubled.std()) / sigma
    assert 1.9 < ratio < 2.1, f"intensity=200 % ⇒ grain ≈ 2× (obtenu {ratio:.2f}×)"
