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

import math
import random
import logging
import torch

# --- Shared-module bootstrap ------------------------------------------------
# Nodes in this pack are loaded one-file-at-a-time by the extension's dynamic
# loader (importlib.util.spec_from_file_location), which registers each file
# under a synthetic "<package>.nodes.<stem>" name WITHOUT importing any parent
# package: package-relative imports therefore cannot work here. Instead we put
# this directory on sys.path and import the shared module absolutely, so every
# node resolves the SAME module instance (one ANY_TYPE singleton pack-wide).
import os as _os
import sys as _sys

_NODE_DIR = _os.path.dirname(_os.path.abspath(__file__))
if _NODE_DIR not in _sys.path:
    _sys.path.insert(0, _NODE_DIR)

# MASTER_RESOLUTIONS / ASPECT_RATIOS are read-only imports from the v1 node.
from holaf_resolution_preset import MASTER_RESOLUTIONS, ASPECT_RATIOS  # noqa: E402  (requires _NODE_DIR above)

logger = logging.getLogger("Holaf.ResolutionPresetV2")

# Model options exposed in the UI dropdown. "Qwen" collapses the
# "Qwen-Image" / "Qwen-Edit" variants into a single entry; "Megapixels" is a
# special mode that computes a resolution from a target megapixel budget.
MODEL_OPTIONS = ["SD1.5", "SDXL", "FLUX", "Z-Image", "Ideogram4", "Krea2 Turbo", "Nucleus-Image", "Qwen", "Megapixels"]

# Models that expose an HD (quality) variant in MASTER_RESOLUTIONS.
# Maps: model option -> (non-HD master key, HD master key)
HD_MAP = {
    "FLUX": ("FLUX (Speed)", "FLUX (Quality)"),
    "Z-Image": ("Z-Image (Balanced)", "Z-Image (Quality)"),
    "Ideogram4": ("Ideogram4", "Ideogram4 (Quality)"),
    "Krea2 Turbo": ("Krea2 Turbo", "Krea2 Turbo (Quality)"),
}

# Models without an HD variant; use_hd is silently ignored for these.
NO_HD_MODELS = {"SD1.5", "SDXL", "Nucleus-Image", "Qwen"}

# The five ratios selectable in the UI (portrait form).
FIVE_RATIOS = ["9:16", "2:3", "3:4", "4:5", "1:1"]

# Maps a short ratio to the (portrait key, landscape key) pair of
# MASTER_RESOLUTIONS / ASPECT_RATIOS. "1:1" shares the same key for both.
RATIO_KEY_MAP = {
    "9:16": ("9:16 Portrait (Mobile Video)", "16:9 Landscape (HD Video-Widescreen)"),
    "2:3": ("2:3 Portrait (35mm Photo)", "3:2 Landscape (35mm Photo)"),
    "3:4": ("3:4 Portrait (Classic Monitor-Photo)", "4:3 Landscape (Classic Monitor-Photo)"),
    "4:5": ("4:5 Portrait (Large Format Photo)", "5:4 Landscape (Large Format Photo)"),
    "1:1": ("1:1 Square (Instagram-Medium Format)", "1:1 Square (Instagram-Medium Format)"),
}

# The 9 oriented ratio values used to match an input image, as
# (exact ratio, short label, is_landscape). Portrait and landscape forms are
# kept separate so a matched image derives its orientation automatically.
# "1:1" appears only once because portrait and landscape share the same 1.0.
RATIO_VALUES_ORIENTED = [
    (9/16, "9:16", False),
    (2/3, "2:3", False),
    (3/4, "3:4", False),
    (4/5, "4:5", False),
    (1.0, "1:1", False),
    (5/4, "5:4", True),
    (4/3, "4:3", True),
    (3/2, "3:2", True),
    (16/9, "16:9", True),
]

# RATIO_KEY_MAP keys use the portrait short form (e.g. "9:16"), while the
# landscape entries of RATIO_VALUES_ORIENTED use the reciprocal form
# (e.g. "16:9"). Normalize any image-derived short back to a RATIO_KEY_MAP key.
_LANDSCAPE_TO_BASE = {
    "5:4": "4:5",
    "4:3": "3:4",
    "3:2": "2:3",
    "16:9": "9:16",
}

# MODEL_OPTIONS exposes a single "Qwen" entry, but MASTER_RESOLUTIONS stores
# the variants under "Qwen-Image" / "Qwen-Edit". Map to the base entry.
_SHORT_TO_MASTER = {
    "Qwen": "Qwen-Image",
}

# Validated with the user: 1 MP = 1024*1024 = 1_048_576 px, so at ratio 1:1
# one megapixel yields exactly 1024x1024.
PIXELS_PER_MP = 1_048_576

# Default multiple for the megapixels mode (UI combo default).
DEFAULT_MULTIPLE = 16


class HolafResolutionPresetV2:
    """
    Temporary v2 replacement for HolafResolutionPreset.

    Keeps the deterministic MASTER_RESOLUTIONS lookup of the v1 node for the
    known models, and extends it with:
      - an HD (quality) variant toggle for models that ship one,
      - a "Megapixels" mode that computes a resolution from a pixel budget,
      - an orientation-aware ratio selection (portrait vs landscape),
      - optional image-ratio matching across the 9 oriented values.
    """
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model_type": (MODEL_OPTIONS, {"default": "SDXL"}),
                "use_hd": ("BOOLEAN", {"default": False}),
                "megapixels": ("FLOAT", {"default": 2.50, "min": 0.25, "max": 16.00, "step": 0.01, "round": 0.01}),
                "multiple_of": ([8, 16, 32, 64], {"default": DEFAULT_MULTIPLE}),
                "aspect_ratio": (FIVE_RATIOS + ["Random"], {"default": "3:4"}),
                # False = Portrait, True = Landscape.
                "orientation": ("BOOLEAN", {"default": False}),
                "use_image_ratio": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "image": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("width", "height")
    FUNCTION = "get_resolution"
    CATEGORY = "AIH/Image"

    def IS_CHANGED(self, model_type, use_hd, megapixels, multiple_of, aspect_ratio, orientation, use_image_ratio, image=None):
        # Random selection must always be treated as changed.
        if aspect_ratio == "Random":
            return random.random()

        parts = [
            str(model_type), str(use_hd), str(megapixels), str(multiple_of),
            str(aspect_ratio), str(orientation), str(use_image_ratio),
        ]
        if use_image_ratio and image is not None and isinstance(image, torch.Tensor):
            parts.append(str(image.shape))
        return "-".join(parts)

    def get_resolution(self, model_type, use_hd, megapixels, multiple_of, aspect_ratio, orientation, use_image_ratio, image=None):
        # 1. Resolve the oriented ratio pair (short, orientation).
        if use_image_ratio and image is not None and isinstance(image, torch.Tensor) and image.ndim == 4:
            img_height, img_width = int(image.shape[1]), int(image.shape[2])
            if img_height > 0 and img_width > 0:
                image_ratio = img_width / img_height
                # Match against the 9 oriented values; the closest one also
                # carries the orientation, so the UI orientation is ignored here.
                _, short, orientation = min(
                    RATIO_VALUES_ORIENTED,
                    key=lambda entry: abs(entry[0] - image_ratio),
                )
                logger.info(
                    "Image ratio ~%.3f matched to '%s' (%s).",
                    image_ratio, short, "landscape" if orientation else "portrait",
                )
            else:
                # Invalid image dims: fall back to the UI-driven selection.
                short = random.choice(FIVE_RATIOS) if aspect_ratio == "Random" else aspect_ratio
        else:
            short = random.choice(FIVE_RATIOS) if aspect_ratio == "Random" else aspect_ratio

        # Landscape shorts from image matching are reciprocal forms; normalize
        # them back to the RATIO_KEY_MAP base short (no-op for UI shorts).
        if orientation:
            short = _LANDSCAPE_TO_BASE.get(short, short)

        # 2. Megapixels mode: compute an optimal resolution from the budget.
        if model_type == "Megapixels":
            width, height = self._megapixels_resolution(short, orientation, megapixels, multiple_of)
            logger.info("Megapixels mode: %.2f MP @ %s -> %dx%d", megapixels, RATIO_KEY_MAP[short][1 if orientation else 0], width, height)
            return (width, height)

        # 3. Master table mode: deterministic lookup in MASTER_RESOLUTIONS.
        width, height = self._master_resolution(model_type, use_hd, short, orientation)
        logger.info("Selected: %s%s @ %s -> %dx%d", model_type, " (HD)" if use_hd else "", RATIO_KEY_MAP[short][1 if orientation else 0], width, height)
        return (width, height)

    def _master_resolution(self, model_type, use_hd, short, orientation):
        """Deterministic lookup in MASTER_RESOLUTIONS (mirrors the v1 node)."""
        if model_type in HD_MAP:
            master_key = HD_MAP[model_type][1 if use_hd else 0]
        else:
            master_key = _SHORT_TO_MASTER.get(model_type, model_type)
            if use_hd and model_type in NO_HD_MODELS:
                logger.debug("HD ignored for model '%s': no HD variant in MASTER_RESOLUTIONS.", model_type)

        full_key = RATIO_KEY_MAP[short][1 if orientation else 0]

        # Defensive guard: never crash the graph on an unknown model key.
        if master_key not in MASTER_RESOLUTIONS:
            logger.warning("Model '%s' not found in MASTER_RESOLUTIONS. Defaulting to 'SDXL'.", master_key)
            master_key = "SDXL"

        # Same fallback as the v1 node: missing ratio -> 1:1.
        if full_key not in MASTER_RESOLUTIONS[master_key]:
            logger.warning("Ratio '%s' not found for model '%s'. Defaulting to 1:1.", full_key, master_key)
            full_key = "1:1 Square (Instagram-Medium Format)"

        width, height = MASTER_RESOLUTIONS[master_key][full_key]
        return (int(width), int(height))

    def _megapixels_resolution(self, short, orientation, megapixels, multiple_of):
        """Compute a resolution from a megapixel budget and the oriented ratio."""
        full_key = RATIO_KEY_MAP[short][1 if orientation else 0]
        ratio = ASPECT_RATIOS[full_key]

        total = megapixels * PIXELS_PER_MP

        # width/height == ratio  =>  w = sqrt(total * ratio), h = total / w.
        w_ideal = math.sqrt(total * ratio)
        h_ideal = total / w_ideal

        # Snap each dimension to the nearest multiple of `multiple_of`.
        width = int(round(w_ideal / multiple_of) * multiple_of)
        height = int(round(h_ideal / multiple_of) * multiple_of)

        # Stay at or below the requested megapixel budget: shrink the longest
        # side by one multiple at a time until w*h <= total.
        while width * height > total:
            if width > height:
                width -= multiple_of
            else:
                height -= multiple_of

        # Clamp: each side is at least multiple_of (and 64) and at most 16384.
        min_side = max(multiple_of, 64)
        width = max(min_side, min(width, 16384))
        height = max(min_side, min(height, 16384))

        return (int(width), int(height))


# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix).
# Legacy alias keys were removed (user decision): /api/object_info exposes
# one entry PER KEY, so a second alias key made every node appear TWICE in
# the Add Node search. Old workflows referencing the removed keys must be
# redone.
NODE_CLASS_MAPPINGS = {
    "AIHResolutionPresetV2": HolafResolutionPresetV2,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHResolutionPresetV2": "AIH Resolution Preset v2",
}
