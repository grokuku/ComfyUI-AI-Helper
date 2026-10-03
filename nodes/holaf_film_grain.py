# Copyright (C) 2025 Holaf
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.

"""AIH Film Grain — grain de pellicule paramétrique, rapide sur grandes images.

Clean-room : réimplémentation PyTorch du modèle paramétrique de synthèse de
grain AV1 (spec AV1 §7.18.3.3 ; idées des implémentations de référence dav1d /
libaom, BSD-2-Clause) — AUCUN code copié, aucune dépendance tierce.

Pourquoi c'est rapide (conception) :
  · un gabarit de bruit ~64×64 est généré UNE fois par exécution (bruit blanc
    filtré par un modèle autorégressif lag 0..3 qui fixe la taille du grain) ;
  · chaque bloc 32×32 de l'image prend un crop aléatoire de ce gabarit : le RNG
    ne tire que les offsets de blocs (~un tirage pour 1024 pixels) ;
  · la réponse luminance est une LUT (512 bins) indexée par la valeur du pixel ;
  · grain_size > 2 px ⇒ champ généré à résolution réduite puis rééchantillonné
    bilinéairement : le coût par pixel reste O(1), indépendant de la finesse ;
  · tout est fp32 et memory-bound (gather + quelques opérations élémentaires),
    avec découpage optionnel en tranches de lignes pour borner la VRAM.
"""

import logging
import math
import time

import torch
import torch.nn.functional as F

logger = logging.getLogger("Holaf.FilmGrain")

# ---------------------------------------------------------------------------
# Constantes du modèle
# ---------------------------------------------------------------------------
TEMPLATE_SIZE = 64          # gabarit de bruit (px)
BLOCK_SIZE = 32             # taille de bloc / crop aléatoire (px)
LUT_BINS = 512              # résolution de la LUT de réponse luminance
BASE_GRAIN_SIGMA = 0.025    # écart-type du grain à intensity=100 %, f(Y)=1
AUTO_PIXEL_BUDGET = 4_000_000   # budget pixels/tranche quand vram_rows == 0

# Réponse « Filmic » : atténuation des ombres (sf) et hautes lumières (hf).
FILMIC_SHADOWS = 45.0
FILMIC_HIGHLIGHTS = 65.0
SHADOW_DEFAULT = 40.0
HIGHLIGHT_DEFAULT = 60.0

# Coefficients YCbCr (BT.601) pour l'ajout du grain chroma : les deltas Cb/Cr
# sont convertis en deltas RGB.
_CR_TO_R = 1.402
_CB_TO_G = 0.344136
_CR_TO_G = 0.714136
_CB_TO_B = 1.772


# ---------------------------------------------------------------------------
# Noyau de mise en forme AR (Yule-Walker + réponse impulsionnelle), mis en cache
# ---------------------------------------------------------------------------
_KERNEL_CACHE = {}


def _sigma_for_half_width(half_width):
    """σ tel que la covariance gaussienne exp(−d²/(2σ²)) vaut 0.5 en d = half_width."""
    return half_width / math.sqrt(2.0 * math.log(2.0))


def _lag_for(half_width):
    """Lag autorégressif (0..3) porteur d'assez de support pour la finesse demandée."""
    if half_width < 0.5:
        return 0
    if half_width < 1.0:
        return 1
    if half_width < 1.6:
        return 2
    return 3


def _causal_offsets(lag):
    """Voisinage causal (dy < 0, ou dy == 0 et dx < 0) du filtre AR."""
    offsets = []
    for dy in range(-lag, 1):
        for dx in range(-lag, lag + 1):
            if dy == 0 and dx >= 0:
                continue
            offsets.append((dy, dx))
    return offsets


def _yule_walker(offsets, sigma):
    """a = R_NN⁻¹ r : meilleur prédicteur linéaire causal (covariance cible gaussienne)."""
    count = len(offsets)
    matrix = torch.empty((count, count), dtype=torch.float64)
    rhs = torch.empty(count, dtype=torch.float64)
    variance = 2.0 * sigma * sigma
    for i, (dy, dx) in enumerate(offsets):
        rhs[i] = math.exp(-(dy * dy + dx * dx) / variance)
        for j, (dy2, dx2) in enumerate(offsets):
            dist2 = (dy - dy2) ** 2 + (dx - dx2) ** 2
            matrix[i, j] = math.exp(-dist2 / variance)
    matrix[torch.arange(count), torch.arange(count)] += 1e-9
    return torch.linalg.solve(matrix, rhs).tolist()


def _impulse_response(offsets, coefficients, extent):
    """Réponse impulsionnelle de la récursion AR (équivaut à appliquer la récursion)."""
    kernel = [[0.0] * extent for _ in range(extent)]
    kernel[0][0] = 1.0
    for y in range(extent):
        for x in range(extent):
            if y == 0 and x == 0:
                continue
            total = 0.0
            for (dy, dx), coefficient in zip(offsets, coefficients):
                yy = y + dy
                xx = x + dx
                if 0 <= yy < extent and 0 <= xx < extent:
                    total += coefficient * kernel[yy][xx]
            kernel[y][x] = total
    return kernel


def _trim_kernel(kernel, threshold=1e-4):
    """Réduit le noyau à sa zone significative (bords négligeables)."""
    rows = [y for y, row in enumerate(kernel) if any(abs(v) > threshold for v in row)]
    cols = [x for x in range(len(kernel[0]))
            if any(abs(kernel[y][x]) > threshold for y in range(len(kernel)))]
    if not rows or not cols:
        return [[1.0]]
    return [[kernel[y][x] for x in range(cols[0], cols[-1] + 1)] for y in range(rows[0], rows[-1] + 1)]


def _shaping_kernel(half_width):
    """Noyau de convolution normalisé [1,1,e,e] (gabarit ← bruit blanc), mis en cache."""
    half_width = min(max(float(half_width), 0.5), 2.0)
    lag = _lag_for(half_width)
    key = (lag, round(half_width, 2))
    cached = _KERNEL_CACHE.get(key)
    if cached is not None:
        return cached
    if lag == 0:
        values = [[1.0]]
    else:
        sigma = _sigma_for_half_width(half_width)
        offsets = _causal_offsets(lag)
        coefficients = _yule_walker(offsets, sigma)
        values = _trim_kernel(_impulse_response(offsets, coefficients, 6 * lag + 3))
    kernel = torch.tensor(values, dtype=torch.float32)
    kernel = kernel / kernel.square().sum().sqrt()
    # F.conv2d calcule une corrélation croisée : retourner le noyau donne bien
    # field = bruit ∗ réponse impulsionnelle (même convention que la référence).
    kernel = kernel.flip(0, 1).reshape(1, 1, kernel.shape[0], kernel.shape[1])
    _KERNEL_CACHE[key] = kernel
    return kernel


# ---------------------------------------------------------------------------
# Gabarit de bruit et offsets de blocs (RNG uniquement sur CPU ⇒ reproductible)
# ---------------------------------------------------------------------------
def _make_template(generator, correlation):
    """Gabarit aplati TEMPLATE_SIZE², normalisé (moyenne 0, écart-type 1)."""
    weight = _shaping_kernel(correlation)
    extent = weight.shape[-1]
    size = TEMPLATE_SIZE + extent - 1
    noise = torch.randn((size, size), generator=generator, dtype=torch.float32)
    field = F.conv2d(noise.reshape(1, 1, size, size), weight)[0, 0]
    std = field.std()
    if float(std) > 1e-12:
        field = (field - field.mean()) / std
    return field.reshape(-1)


def _block_offsets(generator, nby, nbx):
    """[2, nby, nbx] : coin haut-gauche (oy, ox) du crop 32×32 dans le gabarit."""
    high = TEMPLATE_SIZE - BLOCK_SIZE + 1
    # int64 : les index avancés sont garantis sur CPU ET CUDA (pas de surprise au
    # premier passage sur GPU). Le coût mémoire reste borné par le découpage.
    return torch.randint(0, high, (2, nby, nbx), generator=generator, dtype=torch.int64)


# ---------------------------------------------------------------------------
# Réponse luminance (LUT) — équivalent des « scaling points » AV1
# ---------------------------------------------------------------------------
def _build_lut(response, shadows_falloff, highlights_falloff):
    """LUT [LUT_BINS] : f(Y), pic dans les tons moyens, atténué si falloffs."""
    centers = (torch.arange(LUT_BINS, dtype=torch.float32) + 0.5) / LUT_BINS
    if response == "Neutral":
        return torch.ones(LUT_BINS, dtype=torch.float32)
    if response == "Filmic":
        shadows, highlights = FILMIC_SHADOWS / 100.0, FILMIC_HIGHLIGHTS / 100.0
    else:  # Custom
        shadows = min(max(float(shadows_falloff), 0.0), 100.0) / 100.0
        highlights = min(max(float(highlights_falloff), 0.0), 100.0) / 100.0
    return (1.0 - shadows * (1.0 - centers) ** 2) * (1.0 - highlights * centers ** 2)


# ---------------------------------------------------------------------------
# Champs de grain : gather des crops depuis les gabarits
# ---------------------------------------------------------------------------
def _gather_field(templates_flat, offsets, first_row, last_row, field_width):
    """Champ [F, last_row−first_row, field_width] gatheré depuis les gabarits aplatis."""
    device = offsets.device
    rows = torch.arange(first_row, last_row, device=device, dtype=torch.int64)
    cols = torch.arange(field_width, device=device, dtype=torch.int64)
    block_rows = torch.div(rows, BLOCK_SIZE, rounding_mode="floor")
    inner_rows = rows - block_rows * BLOCK_SIZE
    block_cols = torch.div(cols, BLOCK_SIZE, rounding_mode="floor")
    inner_cols = cols - block_cols * BLOCK_SIZE
    offset_y = offsets[:, 0][:, block_rows][:, :, block_cols]
    offset_x = offsets[:, 1][:, block_rows][:, :, block_cols]
    flat = (offset_y + inner_rows[None, :, None]) * TEMPLATE_SIZE + (offset_x + inner_cols[None, None, :])
    frame_count = offsets.shape[0]
    frame_offset = (torch.arange(frame_count, device=device, dtype=flat.dtype)
                    * (TEMPLATE_SIZE * TEMPLATE_SIZE)).reshape(-1, 1, 1)
    return templates_flat.reshape(-1)[flat + frame_offset]


def _sample_chunk(templates_flat, offsets, y0, y1, scale, field_height, field_width, width):
    """Champ au niveau image pour les lignes [y0, y1).

    scale == 1 : gather direct dans le gabarit. scale > 1 : le champ est généré
    à résolution réduite puis rééchantillonné bilinéairement ; chaque ligne de
    sortie ne dépend que de sa position globale, donc un découpage en tranches
    donne EXACTEMENT le même résultat.
    """
    if scale == 1.0:
        return _gather_field(templates_flat, offsets, y0, y1, field_width)

    device = offsets.device
    rows = torch.arange(y0, y1, device=device, dtype=torch.float32)
    source_y = (rows + 0.5) / scale - 0.5
    floor_y = torch.floor(source_y)
    weight_y = (source_y - floor_y).clamp_(0.0, 1.0)
    index_y0 = floor_y.to(torch.int64).clamp_(0, field_height - 1)
    index_y1 = (index_y0 + 1).clamp_(max=field_height - 1)

    cols = torch.arange(width, device=device, dtype=torch.float32)
    source_x = (cols + 0.5) / scale - 0.5
    floor_x = torch.floor(source_x)
    weight_x = (source_x - floor_x).clamp_(0.0, 1.0)
    index_x0 = floor_x.to(torch.int64).clamp_(0, field_width - 1)
    index_x1 = (index_x0 + 1).clamp_(max=field_width - 1)

    first = int(torch.minimum(index_y0.min(), index_y1.min()).item())
    last = int(torch.maximum(index_y0.max(), index_y1.max()).item())
    coarse = _gather_field(templates_flat, offsets, first, last + 1, field_width)

    def resample_x(field):
        return (field[:, :, index_x0] * (1.0 - weight_x)[None, None, :]
                + field[:, :, index_x1] * weight_x[None, None, :])

    top = resample_x(coarse[:, index_y0 - first])
    bottom = resample_x(coarse[:, index_y1 - first])
    return top * (1.0 - weight_y[None, :, None]) + bottom * weight_y[None, :, None]


# ---------------------------------------------------------------------------
# Masque
# ---------------------------------------------------------------------------
def _prepare_mask(mask, batch, height, width, device, dtype):
    """MASK [H,W] ou [B,H,W] (ou [B,H,W,1]) → [B,H,W] clampé [0,1] sur le device."""
    value = mask.to(device=device, dtype=dtype)
    if value.ndim == 2:
        value = value.unsqueeze(0)
    elif value.ndim == 4 and value.shape[-1] == 1:
        value = value[..., 0]
    if value.ndim != 3:
        raise ValueError(
            f"[AIH Film Grain] mask attendu [H,W] ou [B,H,W], reçu {tuple(value.shape)}")
    if value.shape[0] == 1 and batch > 1:
        value = value.expand(batch, value.shape[1], value.shape[2])
    if tuple(value.shape) != (batch, height, width):
        raise ValueError(
            f"[AIH Film Grain] mask {tuple(value.shape)} incompatible avec l'image "
            f"(B,H,W)=({batch},{height},{width})")
    return value.clamp(0.0, 1.0)


# ---------------------------------------------------------------------------
# Cœur de l'algorithme
# ---------------------------------------------------------------------------
def _apply_film_grain(image, intensity, grain_size, response, shadows_falloff,
                      highlights_falloff, chroma_grain, seed, mask, animated, vram_rows):
    """Applique le grain. image float32 [B,H,W,3|4] (0..1) → même forme, fp32.

    Garanties : intensity == 0 ⇒ copie bit-à-bit de l'entrée (aucun tirage RNG) ;
    mask == 0 ⇒ identité ; alpha préservé ; entrée jamais mutée.
    """
    if not torch.is_tensor(image):
        raise TypeError(f"[AIH Film Grain] 'image' doit être un tenseur, reçu {type(image).__name__}")
    intensity = min(max(float(intensity), 0.0), 200.0)
    if intensity == 0.0:
        # Contrôle négatif contractuel : intensité nulle ⇒ sortie identique à
        # l'entrée, bit-à-bit, sans même consommer de hasard.
        return image.detach().float().clone()

    img = image.detach().float()
    if img.ndim != 4 or img.shape[-1] not in (3, 4):
        raise ValueError(f"[AIH Film Grain] image attendue [B,H,W,3|4], reçu {tuple(image.shape)}")
    batch, height, width, channels = img.shape
    if batch == 0 or height == 0 or width == 0:
        return img.clone()

    device = img.device
    rgb = img[..., :3]
    alpha = img[..., 3:] if channels == 4 else None

    grain_size = min(max(float(grain_size), 0.5), 4.0)
    correlation = min(grain_size, 2.0)
    scale = 1.0 if grain_size <= 2.0 else grain_size / 2.0
    field_height = int(math.ceil(height / scale))
    field_width = int(math.ceil(width / scale))
    block_rows = int(math.ceil(field_height / BLOCK_SIZE))
    block_cols = int(math.ceil(field_width / BLOCK_SIZE))

    # Tirages (CPU ⇒ reproductible) : [gabarit luma, offsets, gabarit chroma].
    # L'ordre garantit que chroma_grain ne modifie PAS le grain de luminance.
    frames = batch if animated else 1
    seed = int(seed) & 0x7FFFFFFFFFFFFFFF
    use_chroma = float(chroma_grain) > 0.0
    templates, offsets_list, chroma_list = [], [], []
    for frame in range(frames):
        generator = torch.Generator(device="cpu").manual_seed((seed + frame) & 0x7FFFFFFFFFFFFFFF)
        templates.append(_make_template(generator, correlation))
        offsets_list.append(_block_offsets(generator, block_rows, block_cols))
        if use_chroma:
            chroma = _make_template(generator, correlation)
            # Deux textures indépendantes (gabarit miroir) pour Cb et Cr.
            chroma_list.append(torch.stack([chroma, chroma.flip(0)]))
    templates = torch.stack(templates).to(device)           # [F, T²]
    offsets = torch.stack(offsets_list).to(device)          # [F, 2, nby, nbx]
    if chroma_list:
        chroma_templates = torch.cat(chroma_list).to(device)  # [2F, T²]
        chroma_offsets = offsets.repeat_interleave(2, dim=0)
    else:
        chroma_templates = None
        chroma_offsets = None

    lut = _build_lut(response, shadows_falloff, highlights_falloff).to(device=device, dtype=img.dtype)
    strength = intensity / 100.0 * BASE_GRAIN_SIGMA
    chroma_fraction = min(max(float(chroma_grain), 0.0), 100.0) / 100.0
    mask_value = _prepare_mask(mask, batch, height, width, device, img.dtype) if mask is not None else None

    rows_per_chunk = (int(vram_rows) if vram_rows and int(vram_rows) > 0
                      else max(32, AUTO_PIXEL_BUDGET // max(1, width * frames)))

    out = rgb.clone()
    for y0 in range(0, height, rows_per_chunk):
        y1 = min(height, y0 + rows_per_chunk)
        field_luma = _sample_chunk(templates, offsets, y0, y1, scale,
                                   field_height, field_width, width)
        if chroma_templates is not None:
            field_chroma = _sample_chunk(chroma_templates, chroma_offsets, y0, y1, scale,
                                         field_height, field_width, width)

        for index in range(batch):
            frame = index if animated else 0
            chunk = out[index, y0:y1]
            bins = (chunk * LUT_BINS).to(torch.long).clamp_(0, LUT_BINS - 1)
            response_map = lut[bins]                       # [R, W, 3]
            weight = torch.full((y1 - y0, width), strength, device=device, dtype=img.dtype)
            if mask_value is not None:
                weight = weight * mask_value[index, y0:y1]
            delta_luma = response_map * (field_luma[frame][..., None] * weight[..., None])
            if chroma_templates is not None:
                chroma_weight = (weight * chroma_fraction)[..., None]
                delta_cb = (response_map * (field_chroma[2 * frame][..., None] * chroma_weight))[..., 0]
                delta_cr = (response_map * (field_chroma[2 * frame + 1][..., None] * chroma_weight))[..., 0]
                delta = torch.stack([
                    delta_luma[..., 0] + _CR_TO_R * delta_cr,
                    delta_luma[..., 1] - _CB_TO_G * delta_cb - _CR_TO_G * delta_cr,
                    delta_luma[..., 2] + _CB_TO_B * delta_cb,
                ], dim=-1)
            else:
                delta = delta_luma
            chunk += delta                               # écriture dans notre clone

    out.clamp_(0.0, 1.0)
    if alpha is not None:
        out = torch.cat([out, alpha], dim=-1)
    return out


# ---------------------------------------------------------------------------
# Node ComfyUI
# ---------------------------------------------------------------------------
class HolafFilmGrain:
    """Grain de pellicule paramétrique (modèle AV1 réimplémenté), rapide sur grandes images."""

    DESCRIPTION = (
        "Realistic yet very fast film grain for large images: a clean-room "
        "reimplementation of the AV1 parametric grain model in PyTorch. A small "
        "filtered noise template is generated once and reused through random "
        "32x32 block crops, so the per-pixel cost stays O(1) whatever the grain "
        "size. Luminance-dependent response (Neutral / Filmic / Custom falloffs), "
        "optional colored chroma grain, deterministic seed, per-frame video mode, "
        "optional mask and row slicing to bound VRAM. Intensity 0 returns the "
        "input bit-for-bit."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {
                    "tooltip": "Images [B,H,W,C] (0..1). Le grain s'applique au RGB ; "
                               "l'alpha est préservé et l'entrée n'est jamais modifiée."}),
                "model": (["Parametric (AV1)"], {
                    "tooltip": "Modèle de grain. v1 : paramétrique AV1 (gabarit + AR + LUT "
                               "luminance). Le mode « Plate (scanned) » viendra en v2."}),
                "intensity": ("FLOAT", {
                    "default": 100.0, "min": 0.0, "max": 200.0, "step": 1.0,
                    "tooltip": "Force du grain. 0 ⇒ sortie strictement identique à l'entrée "
                               "(bit-à-bit, aucun tirage aléatoire)."}),
                "grain_size": ("FLOAT", {
                    "default": 1.2, "min": 0.5, "max": 4.0, "step": 0.1,
                    "tooltip": "Finesse du grain en pixels (demi-largeur de corrélation). "
                               "> 2 px ⇒ champ généré à résolution réduite puis rééchantillonné "
                               "(le coût par pixel reste constant)."}),
                "response": (["Neutral", "Filmic", "Custom"], {
                    "default": "Filmic",
                    "tooltip": "Réponse du grain à la luminance : Neutral = uniforme ; "
                               "Filmic = pic dans les tons moyens, atténuation des ombres et "
                               "des hautes lumières ; Custom = réglages ci-dessous."}),
                "shadows_falloff": ("FLOAT", {
                    "default": SHADOW_DEFAULT, "min": 0.0, "max": 100.0, "step": 1.0,
                    "tooltip": "Custom uniquement : atténuation du grain dans les ombres (%) ; "
                               "100 = grain nul dans les noirs."}),
                "highlights_falloff": ("FLOAT", {
                    "default": HIGHLIGHT_DEFAULT, "min": 0.0, "max": 100.0, "step": 1.0,
                    "tooltip": "Custom uniquement : atténuation du grain dans les hautes "
                               "lumières (%) ; 100 = grain nul dans les blancs."}),
                "chroma_grain": ("FLOAT", {
                    "default": 15.0, "min": 0.0, "max": 100.0, "step": 1.0,
                    "tooltip": "Part de grain coloré (Cb/Cr indépendants, convertis en RGB). "
                               "0 = grain monochrome (identique sur R, G et B)."}),
                "seed": ("INT", {
                    "default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF,
                    "control_after_generate": True,
                    "tooltip": "Graine reproductible. Photo (animated=false) : grain identique "
                               "pour tout le batch ; vidéo (animated=true) : seed + index de frame."}),
            },
            "optional": {
                "mask": ("MASK", {
                    "tooltip": "Masque optionnel [H,W] ou [B,H,W] : module localement le grain. "
                               "Un masque à 0 laisse l'image strictement intacte à cet endroit."}),
                "animated": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "false = photo (grain identique sur tout le batch) ; "
                               "true = vidéo (grain stable et différent par frame : seed + index)."}),
                "vram_rows": ("INT", {
                    "default": 0, "min": 0, "max": 8192, "step": 16,
                    "tooltip": "Traitement par tranches de lignes pour plafonner la VRAM. "
                               "0 = automatique. Le résultat est bit-à-bit celui d'un seul bloc."}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "add_grain"
    CATEGORY = "AIH/Image"

    def add_grain(self, image, model, intensity, grain_size, response,
                  shadows_falloff, highlights_falloff, chroma_grain, seed,
                  mask=None, animated=False, vram_rows=0):
        # v1 : le sélecteur « model » ne propose que « Parametric (AV1) » ; le mode
        # « Plate (scanned) » est prévu en v2 (le paramètre est déjà dans le contrat).
        started = time.perf_counter()
        result = _apply_film_grain(
            image, intensity, grain_size, response, shadows_falloff,
            highlights_falloff, chroma_grain, seed, mask, animated, vram_rows)
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        # Une seule ligne par exécution : visible dans la console, en complément
        # du profiler générique du pack (aucun réglage requis).
        if logger.isEnabledFor(logging.INFO):
            shape = tuple(image.shape)
            size = f"{shape[2]}x{shape[1]}" if len(shape) >= 3 else "?"
            logger.info("[AIH Film Grain] %s px x%d — %.1f ms", size, shape[0], elapsed_ms)
        return (result,)


# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix).
# Legacy alias keys were removed (user decision): /api/object_info exposes
# one entry PER KEY, so a second alias key made every node appear TWICE in
# the Add Node search. Old workflows referencing the removed keys must be
# redone.
NODE_CLASS_MAPPINGS = {
    "AIHFilmGrain": HolafFilmGrain,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHFilmGrain": "AIH Film Grain",
}
