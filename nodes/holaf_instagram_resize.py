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
from PIL import Image, ImageColor
import numpy as np

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

class HolafInstagramResize:
    """
    Resizes an image to the nearest Instagram aspect ratio (1:1, 4:5, 16:9)
    by adding colored bars (letterboxing/pillarboxing) instead of cropping.
    """
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("IMAGE",),
                # The color for the background bars (e.g., "black", "#FF0000").
                "fill_color": ("STRING", {"default": "black"}),
                # If True, automatically determines the fill color from the image's edges.
                "auto_color": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "resize_image"
    CATEGORY = "AIH/Image"

    def resize_image(self, image, fill_color, auto_color):
        # Convert the input tensor (Batch, H, W, C) to PIL Images and process all frames.
        results = []
        for b in range(image.shape[0]):
            img = tensor_to_pil(image[b])

            width, height = img.size
            aspect_ratio = width / height

            # Define the target Instagram-compatible ratios.
            ratios = {
                "1:1": 1.0,
                "4:5": 0.8,
                "16:9": 1.7777777777777777,
            }

            # Find the closest target ratio to the image's current ratio.
            closest_ratio_name = min(ratios, key=lambda k: abs(ratios[k] - aspect_ratio))
            closest_ratio = ratios[closest_ratio_name]

            # Calculate the final canvas dimensions.
            if aspect_ratio > closest_ratio:
                final_width = width
                final_height = int(round(width / closest_ratio))
            elif aspect_ratio < closest_ratio:
                final_width = int(round(height * closest_ratio))
                final_height = height
            else:
                 final_width = width
                 final_height = height

            # Determine the fill color.
            if auto_color:
                fill_color = self.get_dominant_edge_color(img)
                if fill_color is None:
                    fill_color = "black"

            # Parse the color string and fall back to black if the color name is invalid.
            try:
                fill_color_rgb = ImageColor.getcolor(fill_color, "RGB")
            except ValueError:
                fill_color_rgb = (0, 0, 0)

            # Create a new blank canvas with the final dimensions and fill color.
            resized_img = Image.new("RGB", (final_width, final_height), fill_color_rgb)

            # Calculate offsets to center the original image on the new canvas.
            x_offset = (final_width - width) // 2
            y_offset = (final_height - height) // 2

            # Paste the original image onto the canvas.
            resized_img.paste(img, (x_offset, y_offset))

            # Convert the final PIL Image back to a torch tensor for ComfyUI.
            results.append(pil_to_tensor(resized_img))

        final_tensor = torch.cat(results, dim=0).float()
        return (final_tensor,)

    def get_dominant_edge_color(self, image):
        """
        Analyzes the image edges to find the average color.
        """
        # Extract edge rows/columns via numpy (no full-image copy)
        arr = np.array(image)
        pixels_top = arr[0, :, :]        # shape (W, 3)
        pixels_bottom = arr[-1, :, :]   # shape (W, 3)
        pixels_left = arr[:, 0, :]      # shape (H, 3)
        pixels_right = arr[:, -1, :]     # shape (H, 3)
        all_edge_pixels = np.concatenate([pixels_top, pixels_bottom, pixels_left, pixels_right], axis=0)

        # Calculate the average R, G, B values.
        avg = all_edge_pixels.mean(axis=0)
        average_r = int(avg[0])
        average_g = int(avg[1])
        average_b = int(avg[2])

        # Return the color as an "rgb(r,g,b)" string.
        return f"rgb({average_r}, {average_g}, {average_b})"

# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix).
# Legacy alias keys were removed (user decision): /api/object_info exposes
# one entry PER KEY, so a second alias key made every node appear TWICE in
# the Add Node search. Old workflows referencing the removed keys must be
# redone.
NODE_CLASS_MAPPINGS = {
    "AIHInstagramResize": HolafInstagramResize,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHInstagramResize": "AIH Instagram Resize",
}
