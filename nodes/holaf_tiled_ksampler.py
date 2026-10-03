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
import hashlib
import comfy.samplers
import comfy.utils
import comfy.model_management
from comfy.model_patcher import ModelPatcher
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

from holaf_node_helpers import prepare_cond_for_tile  # noqa: E402  (requires _NODE_DIR above)

logger = logging.getLogger("Holaf.TiledKSampler")

def _build_feather_mask_1d(size, overlap, device):
    """Create a 1D feather mask with cosine interpolation (vectorized)."""
    mask = torch.ones((size,), device=device)
    safe_overlap = min(overlap, size // 2)
    if safe_overlap > 0:
        t = torch.arange(1, safe_overlap + 1, device=device, dtype=torch.float32) / float(safe_overlap + 1)
        weights = 0.5 * (1.0 - torch.cos(math.pi * t))
        mask[:safe_overlap] = weights
        mask[-safe_overlap:] = torch.flip(weights, [0])
    return mask


class HolafTiledKSampler:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "model": ("MODEL",), 
                "positive": ("CONDITIONING",), 
                "negative": ("CONDITIONING",), 
                "vae": ("VAE",),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "steps": ("INT", {"default": 20, "min": 1, "max": 10000}),
                "cfg": ("FLOAT", {"default": 7.0, "min": 0.0, "max": 100.0, "step": 0.1, "round": 0.01}),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS,), 
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS,),
                "denoise": ("FLOAT", {"default": 1.00, "min": 0.0, "max": 1.0, "step": 0.01}),
                "input_type": (["latent", "image"], {"default": "latent"}),
                "max_tile_size": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "overlap_size": ("INT", {"default": 128, "min": 0, "max": 8192, "step": 8}),
                "vae_decode": ("BOOLEAN", {"default": True}),
                "clean_vram": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                 "latent_image": ("LATENT",), 
                 "image": ("IMAGE",),
            }
        }

    RETURN_TYPES = ("MODEL", "CONDITIONING", "CONDITIONING", "VAE", "LATENT", "IMAGE")
    RETURN_NAMES = ("model", "positive", "negative", "vae", "latent", "image")
    FUNCTION = "sample_tiled"
    CATEGORY = "AIH/Sampling"

    def calculate_tile_params(self, pixel_w, pixel_h, max_tile_size, overlap_size):
        overlap_size = min(overlap_size, max_tile_size - 8) if max_tile_size > 8 else 0
        tile_w_init = min(pixel_w, max_tile_size)
        tile_h_init = min(pixel_h, max_tile_size)
        step_w = tile_w_init - overlap_size
        step_h = tile_h_init - overlap_size
        x_slices = 1 if tile_w_init >= pixel_w or step_w <= 0 else 1 + math.ceil((pixel_w - tile_w_init) / step_w)
        y_slices = 1 if tile_h_init >= pixel_h or step_h <= 0 else 1 + math.ceil((pixel_h - tile_h_init) / step_h)
        final_tile_w = pixel_w if x_slices == 1 else math.ceil((pixel_w + (x_slices - 1) * overlap_size) / float(x_slices))
        final_tile_h = pixel_h if y_slices == 1 else math.ceil((pixel_h + (y_slices - 1) * overlap_size) / float(y_slices))
        final_tile_w = math.ceil(final_tile_w / 8.0) * 8
        final_tile_h = math.ceil(final_tile_h / 8.0) * 8
        overlap_size = math.ceil(overlap_size / 8.0) * 8
        step_w_final = final_tile_w - overlap_size
        step_h_final = final_tile_h - overlap_size
        x_slices = 1 if final_tile_w >= pixel_w or step_w_final <= 0 else 1 + math.ceil((pixel_w - final_tile_w) / step_w_final)
        y_slices = 1 if final_tile_h >= pixel_h or step_h_final <= 0 else 1 + math.ceil((pixel_h - final_tile_h) / step_h_final)
        return int(x_slices), int(y_slices), int(final_tile_w), int(final_tile_h), int(overlap_size)

    def _tiled_vae_encode(self, vae, image, tile_w_pixel, tile_h_pixel, overlap_pixel, x_slices, y_slices, height_latent, width_latent):
        """Tiled VAE encoding to prevent GPU OOM on large images.
        All tiles processed uniformly in the loop — no special first-tile logic.
        Uses latent-space coordinates to avoid pixel→latent rounding errors."""
        vae_device = comfy.model_management.vae_device()
        B, H, W, C = image.shape

        tile_w_latent = tile_w_pixel // 8
        tile_h_latent = tile_h_pixel // 8
        overlap_latent = overlap_pixel // 8
        step_x_latent = tile_w_latent - overlap_latent
        step_y_latent = tile_h_latent - overlap_latent

        # === DEBUG: log all tile params ===
        logger.debug("=== _tiled_vae_encode params ===")
        logger.debug("  image shape: B=%d H=%d W=%d C=%d", B, H, W, C)
        logger.debug("  tile_w_pixel=%d tile_h_pixel=%d overlap_pixel=%d", tile_w_pixel, tile_h_pixel, overlap_pixel)
        logger.debug("  tile_w_latent=%d tile_h_latent=%d overlap_latent=%d", tile_w_latent, tile_h_latent, overlap_latent)
        logger.debug("  step_x_latent=%d step_y_latent=%d", step_x_latent, step_y_latent)
        logger.debug("  height_latent=%d width_latent=%d", height_latent, width_latent)
        logger.debug("  x_slices=%d y_slices=%d", x_slices, y_slices)

        # Encode a small sample to determine the latent channel count.
        # This is necessary because the channel count (typically 4 for SD/SDXL) is not
        # exposed as a property on all VAE objects. The cost is minimal (one tiny tile).
        sample_tile = image[:1, :min(tile_h_pixel, H), :min(tile_w_pixel, W), :3].to(vae_device)
        sample_encoded = vae.encode(sample_tile).cpu()
        latent_channels = sample_encoded.shape[1]
        logger.debug("  sample VAE output shape: %s", list(sample_encoded.shape))
        del sample_tile, sample_encoded

        # Output buffers on CPU to save VRAM
        output_latent = torch.zeros((B, latent_channels, height_latent, width_latent), device="cpu")
        blend_mask = torch.zeros((B, 1, height_latent, width_latent), device="cpu")

        pbar = comfy.utils.ProgressBar(x_slices * y_slices)

        # Precompute feather mask for the expected full tile size
        # When overlap is zero, all tiles are blended with weight 1.0 (no feathering)
        if overlap_latent <= 0:
            feather_4d_full = None  # Will use torch.ones per-tile instead
        else:
            f_mask_x_full = _build_feather_mask_1d(tile_w_latent, overlap_latent, device="cpu")
            f_mask_y_full = _build_feather_mask_1d(tile_h_latent, overlap_latent, device="cpu")
            feather_2d_full = f_mask_y_full.unsqueeze(1) * f_mask_x_full.unsqueeze(0)  # (H, W)
            feather_4d_full = feather_2d_full.unsqueeze(0).unsqueeze(0)  # [1, 1, H, W]
            logger.debug("  feather_4d_full shape: %s", list(feather_4d_full.shape))

        for y in range(y_slices):
            for x in range(x_slices):
                # Latent-space coordinates (exact, no rounding)
                ly_start = y * step_y_latent
                lx_start = x * step_x_latent
                if ly_start + tile_h_latent > height_latent: ly_start = max(0, height_latent - tile_h_latent)
                if lx_start + tile_w_latent > width_latent: lx_start = max(0, width_latent - tile_w_latent)

                # Pixel coordinates (exact: latent * 8)
                py_start = ly_start * 8
                px_start = lx_start * 8
                # Clamp to actual image bounds (edge tiles may be smaller)
                py_end = min(py_start + tile_h_pixel, H)
                px_end = min(px_start + tile_w_pixel, W)

                tile_pixels = image[:, py_start:py_end, px_start:px_end, :3].to(vae_device)
                encoded_tile = vae.encode(tile_pixels).cpu()

                # Actual VAE output dimensions (may differ for edge tiles)
                eh = encoded_tile.shape[-2]
                ew = encoded_tile.shape[-1]

                # === DEBUG: log every tile ===
                logger.debug(
                    "  tile[%d,%d] ly=%d lx=%d py=%d:%d px=%d:%d | VAE out: %s | eh=%d ew=%d",
                    y, x, ly_start, lx_start, py_start, py_end, px_start, px_end,
                    list(encoded_tile.shape), eh, ew
                )

                # Clamp to output buffer bounds (safety: VAE padding could overshoot)
                eh_clamped = min(eh, height_latent - ly_start)
                ew_clamped = min(ew, width_latent - lx_start)
                if eh_clamped != eh or ew_clamped != ew:
                    logger.warning(
                        "  tile[%d,%d] clamped VAE output: (%d,%d) -> (%d,%d)",
                        y, x, eh, ew, eh_clamped, ew_clamped
                    )
                eh, ew = eh_clamped, ew_clamped

                if eh <= 0 or ew <= 0:
                    logger.warning("tile (%d,%d) has zero size after clamp (eh=%d, ew=%d). Skipping.", y, x, eh, ew)
                    pbar.update(1)
                    continue
                encoded_cropped = encoded_tile[:, :, :eh, :ew]

                # Reuse precomputed mask for full-size tiles; use ones when no overlap; rebuild only for edge tiles
                if overlap_latent <= 0:
                    feather_4d = torch.ones((1, 1, eh, ew), device="cpu")
                elif eh == tile_h_latent and ew == tile_w_latent:
                    feather_4d = feather_4d_full
                else:
                    logger.debug("  tile[%d,%d] rebuilding feather mask for size (%d,%d)", y, x, eh, ew)
                    f_mask_x = _build_feather_mask_1d(ew, overlap_latent, device="cpu")
                    f_mask_y = _build_feather_mask_1d(eh, overlap_latent, device="cpu")
                    feather_2d = f_mask_y.unsqueeze(1) * f_mask_x.unsqueeze(0)  # (H, W)
                    feather_4d = feather_2d.unsqueeze(0).unsqueeze(0)  # [1, 1, eh, ew]

                # Safety: ensure shapes match before multiply
                if encoded_cropped.shape[-2:] != feather_4d.shape[-2:]:
                    logger.error(
                        "  SHAPE MISMATCH tile[%d,%d]: encoded_cropped=%s feather_4d=%s — cropping both to minimum",
                        y, x, list(encoded_cropped.shape), list(feather_4d.shape)
                    )
                    min_h = min(encoded_cropped.shape[-2], feather_4d.shape[-2])
                    min_w = min(encoded_cropped.shape[-1], feather_4d.shape[-1])
                    encoded_cropped = encoded_cropped[:, :, :min_h, :min_w]
                    feather_4d = feather_4d[:, :, :min_h, :min_w]
                    eh, ew = min_h, min_w

                output_latent[:, :, ly_start:ly_start+eh, lx_start:lx_start+ew] += encoded_cropped * feather_4d
                blend_mask[:, :, ly_start:ly_start+eh, lx_start:lx_start+ew] += feather_4d
                pbar.update(1)

        blend_mask = torch.clamp(blend_mask, min=1e-6)
        return (output_latent / blend_mask)

    def sample_tiled(self, model: ModelPatcher, positive, negative, vae,
                     seed, steps, cfg, sampler_name, scheduler, denoise,
                     input_type, max_tile_size, overlap_size, vae_decode, clean_vram,
                     latent_image=None, image=None):
        
        if clean_vram: comfy.model_management.soft_empty_cache()
        
        # --- 1. DETERMINE LATENT DIMENSIONS ---
        if input_type == "latent":
            if latent_image is None: raise ValueError("Input type is 'latent', but no latent_image provided.")
            if "samples" not in latent_image or not torch.is_tensor(latent_image["samples"]): 
                raise TypeError("Latent input is not a valid 'samples' tensor.")
            latent_samples = latent_image["samples"]
            height_latent, width_latent = latent_samples.shape[-2], latent_samples.shape[-1]
        elif input_type == "image":
            if image is None: raise ValueError("Input type is 'image', but no image provided.")
            height_latent = math.ceil(image.shape[1] / 8)
            width_latent = math.ceil(image.shape[2] / 8)
        else: raise ValueError(f"Unknown input_type: {input_type}")

        height_pixel, width_pixel = height_latent * 8, width_latent * 8

        # --- 2. CALCULATE TILE PARAMS (before encode, so we can tile the encode too) ---
        x_slices, y_slices, tile_w_pixel, tile_h_pixel, overlap_pixel = self.calculate_tile_params(
            width_pixel, height_pixel, max_tile_size, overlap_size)
        tile_w_latent, tile_h_latent, overlap_latent = tile_w_pixel // 8, tile_h_pixel // 8, overlap_pixel // 8

        # --- 3. TILED VAE ENCODE (if image input) ---
        if input_type == "image":
            logger.info("HolafTiledKSampler: Tiled VAE encode (%d tiles)", x_slices * y_slices)
            latent_samples = self._tiled_vae_encode(
                vae, image, tile_w_pixel, tile_h_pixel, overlap_pixel, x_slices, y_slices,
                height_latent, width_latent)

        device = model.load_device
        latent_samples = latent_samples.to(device)

        # --- 4. TILED SAMPLING PASS ---
        # Output buffers on CPU to save VRAM during sampling
        output_latent = torch.zeros_like(latent_samples, device="cpu")
        blend_mask = torch.zeros_like(latent_samples, device="cpu")
        
        # Create latent feather masks (cosine interpolation, vectorized)
        # Use single-tile mask when there's no adjacent tile to blend with
        has_neighbor_x = x_slices > 1
        has_neighbor_y = y_slices > 1
        f_mask_x = _build_feather_mask_1d(tile_w_latent, overlap_latent, device="cpu") if has_neighbor_x else torch.ones((tile_w_latent,), device="cpu")
        f_mask_y = _build_feather_mask_1d(tile_h_latent, overlap_latent, device="cpu") if has_neighbor_y else torch.ones((tile_h_latent,), device="cpu")
        
        # Reshape 1D feather components for broadcast (used ONLY for base mask multiplication).
        # For 2D tile masks, use dimension-aware .view() with both H and W dims set instead.
        base_l_view_x = [1] * latent_samples.ndim
        base_l_view_x[-1] = tile_w_latent
        base_l_view_y = [1] * latent_samples.ndim
        base_l_view_y[-2] = tile_h_latent
        base_feather_mask_latent = f_mask_y.view(base_l_view_y) * f_mask_x.view(base_l_view_x)
        # Also keep a 2D version for the per-tile mask construction (tile_mask is 2D)
        base_mask_2d = base_feather_mask_latent.squeeze()  # (H, W)
        
        pbar = comfy.utils.ProgressBar(x_slices * y_slices)
        step_x_latent, step_y_latent = tile_w_latent - overlap_latent, tile_h_latent - overlap_latent
        
        logger.info("HolafTiledKSampler: Sampling %d tiles...", x_slices * y_slices)
        for y in range(y_slices):
            for x in range(x_slices):
                y_start, x_start = y * step_y_latent, x * step_x_latent
                if y_start + tile_h_latent > height_latent: y_start = height_latent - tile_h_latent
                if x_start + tile_w_latent > width_latent: x_start = width_latent - tile_w_latent
                y_end, x_end = y_start + tile_h_latent, x_start + tile_w_latent
                
                # Build per-tile feather mask: add gradient only where there's an adjacent tile
                tile_mask = torch.ones((tile_h_latent, tile_w_latent), device="cpu")
                if has_neighbor_x:
                    if x == 0:
                        tile_mask[:, tile_w_latent - overlap_latent:] = base_mask_2d[:, tile_w_latent - overlap_latent:]
                    elif x == x_slices - 1:
                        tile_mask[:, :overlap_latent] = base_mask_2d[:, :overlap_latent]
                    else:
                        tile_mask[:, :overlap_latent] = base_mask_2d[:, :overlap_latent]
                        tile_mask[:, tile_w_latent - overlap_latent:] = base_mask_2d[:, tile_w_latent - overlap_latent:]
                if has_neighbor_y:
                    if y == 0:
                        tile_mask[tile_h_latent - overlap_latent:, :] *= base_mask_2d[tile_h_latent - overlap_latent:, :]
                    elif y == y_slices - 1:
                        tile_mask[:overlap_latent, :] *= base_mask_2d[:overlap_latent, :]
                    else:
                        tile_mask[:overlap_latent, :] *= base_mask_2d[:overlap_latent, :]
                        tile_mask[tile_h_latent - overlap_latent:, :] *= base_mask_2d[tile_h_latent - overlap_latent:, :]
                
                # Dimension-aware view: works for both 4D [B,C,H,W] and 5D [B,F,C,H,W]
                l_mask_view = [1] * latent_samples.ndim
                l_mask_view[-2] = tile_h_latent
                l_mask_view[-1] = tile_w_latent
                tile_feather_mask_latent = tile_mask.view(l_mask_view).expand_as(latent_samples[..., y_start:y_end, x_start:x_end])
                
                tile_latent = latent_samples[..., y_start:y_end, x_start:x_end]
                
                # Hash-based tile seed for better decorrelation between adjacent tiles
                tile_seed = int(hashlib.sha256(f"{seed}-{y}-{x}".encode()).hexdigest(), 16) % (2**64)
                # Generate per-tile noise from tile_seed so each tile gets decorrelated noise.
                # (Previously the global noise was sliced per tile, which made tile_seed ineffective
                #  because comfy.sample.sample uses the provided noise as-is when disable_noise=False.)
                tile_noise = comfy.sample.prepare_noise(tile_latent, tile_seed, None).to(device)
                # Prepare fresh conditioning per tile to avoid in-place mutation issues
                # (some samplers modify conditioning in-place for pools/mask).
                tile_positive = prepare_cond_for_tile(positive, device)
                tile_negative = prepare_cond_for_tile(negative, device)
                sampled_output = comfy.sample.sample(model, tile_noise, steps, cfg, sampler_name, scheduler, 
                                                    tile_positive, tile_negative, tile_latent, denoise=denoise, 
                                                    disable_noise=False, callback=None, disable_pbar=True, seed=tile_seed)
                sampled_tile = sampled_output if torch.is_tensor(sampled_output) else sampled_output["samples"]
                
                output_latent[..., y_start:y_end, x_start:x_end] += sampled_tile.cpu() * tile_feather_mask_latent
                blend_mask[..., y_start:y_end, x_start:x_end] += tile_feather_mask_latent
                del sampled_output, sampled_tile, tile_feather_mask_latent, tile_positive, tile_negative
                if clean_vram:
                    comfy.model_management.soft_empty_cache()
                pbar.update(1)

        blend_mask = torch.clamp(blend_mask, min=1e-6)
        final_latent_samples = (output_latent / blend_mask).to(comfy.model_management.intermediate_device())
        final_latent = {"samples": final_latent_samples}
        
        # --- 5. TILED VAE DECODE ---
        if vae_decode:
            if clean_vram: comfy.model_management.soft_empty_cache()
            logger.info("HolafTiledKSampler: Decoding %d tiles via VAE...", x_slices * y_slices)
            
            vae_device = comfy.model_management.vae_device()
            
            # Decode first tile and USE it (no wasted decode)
            first_tile_latent = final_latent_samples[..., 0:tile_h_latent, 0:tile_w_latent].to(vae_device)
            first_decoded = vae.decode(first_tile_latent)
            
            out_shape = list(first_decoded.shape)
            out_shape[-3] = height_pixel
            out_shape[-2] = width_pixel
            
            image_out = torch.zeros(out_shape, device="cpu")
            image_blend_mask = torch.zeros(out_shape, device="cpu")
            
            # Create pixel feather masks (cosine interpolation, vectorized)
            # Same edge-aware logic as sampling masks
            has_neighbor_x = x_slices > 1
            has_neighbor_y = y_slices > 1
            pf_mask_x = _build_feather_mask_1d(tile_w_pixel, overlap_pixel, device="cpu") if has_neighbor_x else torch.ones((tile_w_pixel,), device="cpu")
            pf_mask_y = _build_feather_mask_1d(tile_h_pixel, overlap_pixel, device="cpu") if has_neighbor_y else torch.ones((tile_h_pixel,), device="cpu")
            
            # Reshape 1D feather components for broadcast (used ONLY for base mask multiplication).
            # For 2D tile masks, use dimension-aware .view() with H, W, and C dims set instead.
            base_p_view_x = [1] * first_decoded.ndim
            base_p_view_x[-2] = tile_w_pixel
            base_p_view_y = [1] * first_decoded.ndim
            base_p_view_y[-3] = tile_h_pixel
            base_feather_mask_pixel = pf_mask_y.view(base_p_view_y) * pf_mask_x.view(base_p_view_x)
            # Also keep a 2D version for per-tile mask construction (tile_pixel_mask is 2D)
            base_pixel_mask_2d = base_feather_mask_pixel.squeeze()  # (H, W)
            
            # Store first tile result
            # First tile is always at (0,0) — only fade right/bottom if neighbors exist
            first_tile_mask = torch.ones((tile_h_pixel, tile_w_pixel), device="cpu")
            if has_neighbor_x:
                first_tile_mask[:, tile_w_pixel - overlap_pixel:] = base_pixel_mask_2d[:, tile_w_pixel - overlap_pixel:]
            if has_neighbor_y:
                first_tile_mask[tile_h_pixel - overlap_pixel:, :] *= base_pixel_mask_2d[tile_h_pixel - overlap_pixel:, :]
            # Dimension-aware view: works for both 4D [B,H,W,C] and 5D [B,F,H,W,C]
            first_mask_view = [1] * first_decoded.ndim
            first_mask_view[-3] = tile_h_pixel
            first_mask_view[-2] = tile_w_pixel
            first_mask_view[-1] = 1
            first_tile_mask_expanded = first_tile_mask.view(first_mask_view).expand_as(first_decoded.cpu())
            
            image_out[..., 0:tile_h_pixel, 0:tile_w_pixel, :] += first_decoded.cpu() * first_tile_mask_expanded
            image_blend_mask[..., 0:tile_h_pixel, 0:tile_w_pixel, :] += first_tile_mask_expanded
            
            pbar_vae = comfy.utils.ProgressBar(x_slices * y_slices)
            pbar_vae.update(1)  # First tile already done
            
            for y in range(y_slices):
                for x in range(x_slices):
                    if y == 0 and x == 0:
                        continue  # Already processed and counted
                    ly_start, lx_start = y * step_y_latent, x * step_x_latent
                    if ly_start + tile_h_latent > height_latent: ly_start = height_latent - tile_h_latent
                    if lx_start + tile_w_latent > width_latent: lx_start = width_latent - tile_w_latent
                    ly_end, lx_end = ly_start + tile_h_latent, lx_start + tile_w_latent
                    
                    py_start, px_start = ly_start * 8, lx_start * 8
                    py_end, px_end = ly_end * 8, lx_end * 8
                    
                    # Build per-tile pixel feather mask
                    tile_pixel_mask = torch.ones((tile_h_pixel, tile_w_pixel), device="cpu")
                    if has_neighbor_x:
                        if x == 0:
                            tile_pixel_mask[:, tile_w_pixel - overlap_pixel:] = base_pixel_mask_2d[:, tile_w_pixel - overlap_pixel:]
                        elif x == x_slices - 1:
                            tile_pixel_mask[:, :overlap_pixel] = base_pixel_mask_2d[:, :overlap_pixel]
                        else:
                            tile_pixel_mask[:, :overlap_pixel] = base_pixel_mask_2d[:, :overlap_pixel]
                            tile_pixel_mask[:, tile_w_pixel - overlap_pixel:] = base_pixel_mask_2d[:, tile_w_pixel - overlap_pixel:]
                    if has_neighbor_y:
                        if y == 0:
                            tile_pixel_mask[tile_h_pixel - overlap_pixel:, :] *= base_pixel_mask_2d[tile_h_pixel - overlap_pixel:, :]
                        elif y == y_slices - 1:
                            tile_pixel_mask[:overlap_pixel, :] *= base_pixel_mask_2d[:overlap_pixel, :]
                        else:
                            tile_pixel_mask[:overlap_pixel, :] *= base_pixel_mask_2d[:overlap_pixel, :]
                            tile_pixel_mask[tile_h_pixel - overlap_pixel:, :] *= base_pixel_mask_2d[tile_h_pixel - overlap_pixel:, :]
                    
                    tile_latent_subset = final_latent_samples[..., ly_start:ly_end, lx_start:lx_end].to(vae_device)
                    decoded_tile = vae.decode(tile_latent_subset).cpu()
                    
                    # Dimension-aware view: works for both 4D [B,H,W,C] and 5D [B,F,H,W,C]
                    tile_mask_view = [1] * decoded_tile.ndim
                    tile_mask_view[-3] = tile_h_pixel
                    tile_mask_view[-2] = tile_w_pixel
                    tile_mask_view[-1] = 1
                    tile_mask_expanded = tile_pixel_mask.view(tile_mask_view).expand_as(decoded_tile)
                    
                    image_out[..., py_start:py_end, px_start:px_end, :] += decoded_tile * tile_mask_expanded
                    image_blend_mask[..., py_start:py_end, px_start:px_end, :] += tile_mask_expanded
                    del tile_latent_subset, decoded_tile, tile_mask_expanded
                    if clean_vram:
                        comfy.model_management.soft_empty_cache()
                    pbar_vae.update(1)
            
            image_blend_mask = torch.clamp(image_blend_mask, min=1e-6)
            image_out = (image_out / image_blend_mask).to(comfy.model_management.intermediate_device())
            
            # CRITICAL: Squeeze frame dimension if 5D with 1 frame for ComfyUI compatibility
            if image_out.ndim == 5 and image_out.shape[1] == 1:
                image_out = image_out.squeeze(1)
                
        else:
            logger.warning("HolafTiledKSampler: VAE Decode skipped (outputting dummy image).")
            image_out = torch.zeros((final_latent_samples.shape[0], 8, 8, 3))

        final_latent["samples"] = final_latent["samples"].cpu()
        return (model, positive, negative, vae, final_latent, image_out)

# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix).
# Legacy alias keys were removed (user decision): /api/object_info exposes
# one entry PER KEY, so a second alias key made every node appear TWICE in
# the Add Node search. Old workflows referencing the removed keys must be
# redone.
NODE_CLASS_MAPPINGS = {
    "AIHTiledKSampler": HolafTiledKSampler,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHTiledKSampler": "AIH Tiled KSampler",
}
