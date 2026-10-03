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
import math
import logging
import torch.nn.functional as F
import folder_paths

logger = logging.getLogger("Holaf.UpscaleImage")
import comfy.model_management
import comfy.utils
from spandrel import ModelLoader
from nodes import ImageScale

class UpscaleImageHolaf:
    """
    Upscales an image using a chosen model (e.g., ESRGAN) to a target
    megapixel count. This provides flexible size control, independent of the
    model's native scale factor (e.g., 4x).
    Now supports enforcing resolution multiples (8, 16, 32, 64) and fitting strategies (Stretch, Crop, Pad).
    """
    upscale_methods = ["nearest-exact", "bilinear", "area", "bicubic", "lanczos"]
    multiples = ["None", "8", "16", "32", "64"]
    resize_modes = ["stretch", "crop", "pad"]

    @classmethod
    def INPUT_TYPES(s):
        # Dynamically populates the `model_name` dropdown with files from the `upscale_models` folder.
        try:
            upscale_model_list = folder_paths.get_filename_list("upscale_models")
            if not upscale_model_list:
                upscale_model_list = ["None"]
        except Exception:
            upscale_model_list = ["None"]
            logger.warning("Could not access upscale_models folder.")

        return {
            "required": {
                "image": ("IMAGE",),
                "model_name": (upscale_model_list, ),
                "upscale_method": (s.upscale_methods,),
                # The target output size, expressed in megapixels.
                "megapixels": ("FLOAT", {"default": 2.00, "min": 0.01, "max": 16.00, "step": 0.01}),
                "force_multiple_of": (s.multiples, {"default": "None"}),
                "resize_mode": (s.resize_modes, {"default": "stretch"}),
                "clean_vram": ("BOOLEAN", {"default": False}),
            }
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("IMAGE", "MODEL_NAME_TEXT")
    FUNCTION = "upscale"
    CATEGORY = "AIH/Image"

    def upscale(self, image, model_name, upscale_method, megapixels, force_multiple_of, resize_mode, clean_vram):
        # Optionally clear VRAM to free up memory before the main operation.
        if clean_vram:
            comfy.model_management.soft_empty_cache()

        # If no model is selected, simply pass the image through without changes.
        if model_name == "None" or not model_name:
                return (image, "None")

        # --- Model Loading ---
        # Load the selected upscale model. Spandrel is used here for its broad
        # compatibility with various upscaler model architectures.
        model_path = folder_paths.get_full_path("upscale_models", model_name)
        if not model_path:
            raise FileNotFoundError(f"Upscale model not found: {model_name}")

        device = comfy.model_management.get_torch_device()
        try:
            sd = comfy.utils.load_torch_file(model_path, safe_load=True)
            upscale_model_descriptor = ModelLoader().load_from_state_dict(sd)
            # FIX: Keep the Spandrel descriptor to preserve padding logic for models like SwinIR/HAT
            upscale_model = upscale_model_descriptor
            upscale_model.eval()
        except Exception as e:
            raise RuntimeError(f"Failed to load upscale model '{model_name}': {e}") from e

        # --- Target Dimension Calculation ---
        # Calculate the target width and height to match the desired megapixel count
        # while preserving the original aspect ratio.
        _, original_height, original_width, _ = image.shape
        original_pixels = original_height * original_width
        target_pixels = megapixels * 1048576.0 # 1 MP = 1024*1024 pixels

        if target_pixels <= 0: raise ValueError("Megapixels must be positive.")
        if original_pixels <= 0: return (image, model_name)

        # The scale factor is the square root of the ratio of target pixels to original pixels.
        scale_factor = (target_pixels / original_pixels) ** 0.5
        target_width = max(1, int(original_width * scale_factor))
        target_height = max(1, int(original_height * scale_factor))

        # --- Apply Modulo Constraint ---
        if force_multiple_of != "None":
            multiple = int(force_multiple_of)
            target_width = round(target_width / multiple) * multiple
            target_height = round(target_height / multiple) * multiple
            target_width = max(multiple, target_width)
            target_height = max(multiple, target_height)

        # --- Two-Stage Upscaling ---
        # Explicitly cast the input tensor to float32 to prevent type mismatch errors.
        image = image.float()

        # Stage 1: Upscale using the loaded model's native scale factor.
        image_for_model = image.movedim(-1, 1) # Permute to NCHW for model input
        
        # FIX: Handle Alpha channel. Upscale models generally only accept 3 channels (RGB).
        if image_for_model.shape[1] > 3:
            rgb_image = image_for_model[:, 0:3, :, :]
            alpha_channel = image_for_model[:, 3:4, :, :]
        else:
            rgb_image = image_for_model
            alpha_channel = None

        try:
            with torch.no_grad():
                    upscale_model.to(device)
                    model_scale = upscale_model_descriptor.scale
                    scaled_rgb = comfy.utils.tiled_scale(
                        rgb_image,
                        lambda x: upscale_model(x.to(device)).cpu(),
                        tile_x=512, tile_y=512, overlap=64,
                        upscale_amount=model_scale
                    )
        except Exception as e:
                raise RuntimeError(f"Failed to upscale image with model '{model_name}': {e}") from e

        # Re-attach alpha channel if it existed
        if alpha_channel is not None:
            scaled_alpha = F.interpolate(alpha_channel, size=(scaled_rgb.shape[2], scaled_rgb.shape[3]), mode="bilinear")
            scaled_img = torch.cat([scaled_rgb, scaled_alpha], dim=1)
        else:
            scaled_img = scaled_rgb

        upscaled_image = scaled_img.movedim(1, -1) # Permute back to NHWC

        # Stage 2: Final Resize with Mode (Stretch/Crop/Pad)
        current_height, current_width = upscaled_image.shape[1:3]

        if current_width != target_width or current_height != target_height:
                resizer = ImageScale()

                if resize_mode == "stretch":
                    # Direct resize to target dimensions (ignoring aspect ratio changes)
                    upscaled_image = resizer.upscale(upscaled_image, upscale_method, target_width, target_height, "disabled")[0]

                elif resize_mode == "crop":
                    # Scale to cover target, then crop center
                    scale_w = target_width / current_width
                    scale_h = target_height / current_height
                    scale = max(scale_w, scale_h)

                    # FIX: Use math.ceil to prevent rounding issues leading to negative slice indices
                    temp_w = math.ceil(current_width * scale)
                    temp_h = math.ceil(current_height * scale)

                    # Upscale first
                    upscaled_image = resizer.upscale(upscaled_image, upscale_method, temp_w, temp_h, "disabled")[0]

                    # Then crop
                    x_start = max(0, (temp_w - target_width) // 2)
                    y_start = max(0, (temp_h - target_height) // 2)
                    upscaled_image = upscaled_image[:, y_start:y_start+target_height, x_start:x_start+target_width, :]

                elif resize_mode == "pad":
                    # Scale to fit inside target, then pad with black
                    scale_w = target_width / current_width
                    scale_h = target_height / current_height
                    scale = min(scale_w, scale_h)

                    temp_w = int(current_width * scale)
                    temp_h = int(current_height * scale)

                    # Upscale first
                    upscaled_image = resizer.upscale(upscaled_image, upscale_method, temp_w, temp_h, "disabled")[0]

                    # Then pad
                    new_image = torch.zeros((upscaled_image.shape[0], target_height, target_width, upscaled_image.shape[3]), dtype=upscaled_image.dtype, device=upscaled_image.device)
                    x_start = max(0, (target_width - temp_w) // 2)
                    y_start = max(0, (target_height - temp_h) // 2)
                    new_image[:, y_start:y_start+temp_h, x_start:x_start+temp_w, :] = upscaled_image
                    upscaled_image = new_image

        # --- Release upscale model from VRAM ---
        # The model was moved to GPU during tiled_scale; release it so VRAM is freed.
        del upscale_model, upscale_model_descriptor
        comfy.model_management.soft_empty_cache()

        return (upscaled_image, model_name)

# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix).
# Legacy alias keys were removed (user decision): /api/object_info exposes
# one entry PER KEY, so a second alias key made every node appear TWICE in
# the Add Node search. Old workflows referencing the removed keys must be
# redone.
NODE_CLASS_MAPPINGS = {
    "AIHUpscale": UpscaleImageHolaf,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHUpscale": "AIH Upscale",
}
