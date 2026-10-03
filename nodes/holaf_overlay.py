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

import torch
import numpy as np
import logging
from PIL import Image, ImageOps, ImageChops

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

from holaf_node_helpers import tensor_to_pil, pil_to_tensor  # noqa: E402  (requires _NODE_DIR above)

logger = logging.getLogger("Holaf.Overlay")

class HolafOverlayNode:
    """
    Overlays one image onto another with controls for size, position, opacity,
    and masking. Supports batch operations.
    """
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "background_image": ("IMAGE",),
                "overlay_image": ("IMAGE",),
                "vertical_align": (["top", "bottom"], {"default": "bottom"}),
                "horizontal_align": (["left", "right"], {"default": "left"}),
                "offset_percent": ("INT", {"default": 1, "min": 0, "max": 100, "step": 1}),
                "size_percent": ("INT", {"default": 5, "min": 1, "max": 1000, "step": 1}),
                "opacity": ("INT", {"default": 50, "min": 0, "max": 100, "step": 1}),
            },
            "optional": {
                 "mask": ("MASK",),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "overlay"
    CATEGORY = "AIH/Image"

    def overlay(self, background_image, overlay_image, horizontal_align, vertical_align, offset_percent, size_percent, opacity, mask=None):
        if not isinstance(background_image, torch.Tensor) or not isinstance(overlay_image, torch.Tensor):
            raise TypeError("Inputs must be torch.Tensor")

        # --- Batch Handling ---
        batch_size_bg = background_image.shape[0]
        batch_size_ov = overlay_image.shape[0]
        batch_size = batch_size_bg

        if batch_size_bg != batch_size_ov:
            if batch_size_ov == 1 and batch_size_bg > 1:
                overlay_image = overlay_image.repeat(batch_size_bg, 1, 1, 1)
                if mask is not None and mask.shape[0] == 1:
                    mask = mask.repeat(batch_size_bg, 1, 1)
            elif batch_size_bg == 1 and batch_size_ov > 1:
                background_image = background_image.repeat(batch_size_ov, 1, 1, 1)
                batch_size = batch_size_ov
            else:
                batch_size = min(batch_size_bg, batch_size_ov)
                logger.warning(f"Batch size mismatch between background ({batch_size_bg}) and overlay ({batch_size_ov}). "
                      f"Only the first {batch_size} frame(s) will be processed; the remaining frames are silently discarded.")

        results = []
        for i in range(batch_size):
            bg_pil = tensor_to_pil(background_image[i]).convert("RGBA")
            ov_pil = tensor_to_pil(overlay_image[i]).convert("RGBA")
            bg_width, bg_height = bg_pil.size
            ov_orig_width, ov_orig_height = ov_pil.size

            # --- Mask Creation ---
            if mask is not None:
                mask_tensor_slice = mask[i % mask.shape[0]]
                mask_np_scaled = mask_tensor_slice.cpu().float().mul(255).clamp(0, 255).byte().numpy()
                base_mask_pil = ImageOps.invert(Image.fromarray(mask_np_scaled, mode='L'))
            elif overlay_image.shape[-1] == 4:
                alpha_tensor = overlay_image[i, :, :, 3]
                alpha_np_scaled = alpha_tensor.cpu().float().mul(255).clamp(0, 255).byte().numpy()
                base_mask_pil = ImageOps.invert(Image.fromarray(alpha_np_scaled, mode='L'))
            else:
                base_mask_pil = Image.new('L', (ov_orig_width, ov_orig_height), 255)

            # --- Size Calculation ---
            target_bg_dim = max(bg_width, bg_height)
            target_ov_dim = int(target_bg_dim * (size_percent / 100.0))
            ov_aspect_ratio = ov_orig_width / ov_orig_height if ov_orig_height != 0 else 1

            if ov_orig_width >= ov_orig_height:
                new_ov_width = target_ov_dim
                new_ov_height = int(new_ov_width / ov_aspect_ratio)
            else:
                new_ov_height = target_ov_dim
                new_ov_width = int(new_ov_height * ov_aspect_ratio)

            new_ov_width = min(max(1, new_ov_width), bg_width)
            new_ov_height = min(max(1, new_ov_height), bg_height)

            # Resize overlay and mask — preserve alpha channel
            ov_pil = ov_pil.resize((new_ov_width, new_ov_height), Image.Resampling.LANCZOS)
            base_mask_pil = base_mask_pil.resize((new_ov_width, new_ov_height), Image.Resampling.LANCZOS)

            # --- Opacity ---
            if opacity < 100:
                # Scale alpha and mask together to preserve anti-aliasing
                alpha = ov_pil.split()[3]  # Extract alpha before modifying
                reduced_alpha = alpha.point(lambda p: int(p * opacity / 100))
                ov_pil = ov_pil.convert("RGBA")
                ov_pil.putalpha(reduced_alpha)
                # Also reduce the mask (which is inverted: black=apply, white=skip)
                base_mask_pil = base_mask_pil.point(lambda p: min(255, p + int((255 - p) * (100 - opacity) / 100)))

            # --- Positioning ---
            offset_pixels = int(min(bg_width, bg_height) * (offset_percent / 100.0))
            paste_x = offset_pixels if horizontal_align == "left" else bg_width - new_ov_width - offset_pixels
            paste_y = offset_pixels if vertical_align == "top" else bg_height - new_ov_height - offset_pixels
            
            paste_x = max(0, min(paste_x, bg_width - new_ov_width))
            paste_y = max(0, min(paste_y, bg_height - new_ov_height))
            
            # --- Compositing ---
            result_pil = bg_pil.copy()
            # Combine user mask with overlay alpha channel
            final_mask = ImageChops.multiply(base_mask_pil, ov_pil.split()[3])
            result_pil.paste(ov_pil, (paste_x, paste_y), final_mask)
            
            results.append(pil_to_tensor(result_pil))

        if not results:
            return (background_image,)

        result_tensor_batch = torch.cat(results, dim=0)
        return (result_tensor_batch,)

# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix).
# Legacy alias keys were removed (user decision): /api/object_info exposes
# one entry PER KEY, so a second alias key made every node appear TWICE in
# the Add Node search. Old workflows referencing the removed keys must be
# redone.
NODE_CLASS_MAPPINGS = {
    "AIHOverlay": HolafOverlayNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHOverlay": "AIH Overlay",
}
