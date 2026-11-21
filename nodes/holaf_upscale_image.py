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

    # Faux modèle « aucun modèle » : REDIMENSIONNEMENT PUR (interpolation via
    # `upscale_method`), sans charger un seul fichier de modèle. Minuscules
    # VOLONTAIRES : "None" (majuscule) est l'ANCIENNE sentinelle « pas de
    # modèle » qui renvoyait l'image INCHANGÉE en ignorant le budget MP ; elle
    # reste honorée telle quelle pour les workflows déjà enregistrés (cf.
    # `upscale`, branche LEGACY_PASSTHROUGH).
    NO_MODEL = "none"
    LEGACY_PASSTHROUGH = "None"

    @classmethod
    def INPUT_TYPES(s):
        # Dynamically populates the `model_name` dropdown with files from the
        # `upscale_models` folder. The FAKE model `NO_MODEL` ("none") is always
        # offered so the node stays usable as a pure resampler.
        try:
            upscale_model_list = list(folder_paths.get_filename_list("upscale_models") or [])
        except Exception:
            upscale_model_list = []
            logger.warning("Could not access upscale_models folder.")

        # « none » est placé EN TÊTE : c'est SANS RISQUE pour les workflows
        # existants parce qu'un COMBO ComfyUI sérialise la VALEUR (le nom du
        # fichier — une CHAÎNE), jamais l'index : cf. js/aih_workflow_share.js
        # (applyNameMap itère `widgets_values` et remappe des NOMS de fichiers
        # dans des entrées `typeof val === 'string'`), et
        # aih/repair_workflow.py (remap_widget_values remappe PAR NOM). Décaler
        # les entrées ne change donc aucune valeur enregistrée.
        # Le DÉFAUT reste le premier modèle RÉEL (comportement historique) : il
        # faut le forcer explicitement puisque « none » occupe l'index 0. Sans
        # aucun modèle réel, la liste redevient EXACTEMENT l'ancienne
        # (["None"], défaut "None" = passthrough) avec « none » en plus.
        model_options = [s.NO_MODEL] + upscale_model_list
        if upscale_model_list:
            default_model = upscale_model_list[0]
        else:
            model_options.append(s.LEGACY_PASSTHROUGH)
            default_model = s.LEGACY_PASSTHROUGH

        return {
            "required": {
                "image": ("IMAGE",),
                "model_name": (model_options, {"default": default_model}),
                "upscale_method": (s.upscale_methods,),
                # The target output size, expressed in megapixels (PIXEL BUDGET,
                # not a scale factor: see compute_target_dimensions below).
                # Plafond HAUTE RÉSOLUTION : 64 MP (et non 16), ALIGNÉ sur le
                # widget "megapixels" de la Resolution Preset v2
                # (holaf_resolution_preset_v2.py). Rappel de sémantique : le
                # budget est converti en dimensions cibles (target_pixels =
                # megapixels × 1048576) puis le redimensionnement final (Stage 2)
                # y ramène l'image — le facteur natif du modèle n'est que
                # l'étape intermédiaire. 64 MP = 8192×8192 en 1:1.
                # DEFAULT / MIN / STEP INCHANGÉS : seul le plafond bouge.
                # Verrouillé par tests/test_upscale_megapixels_cap.py.
                "megapixels": ("FLOAT", {"default": 2.00, "min": 0.01, "max": 64.00, "step": 0.01}),
                "force_multiple_of": (s.multiples, {"default": "None"}),
                "resize_mode": (s.resize_modes, {"default": "stretch"}),
                "clean_vram": ("BOOLEAN", {"default": False}),
            }
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("IMAGE", "MODEL_NAME_TEXT")
    FUNCTION = "upscale"
    CATEGORY = "AIH/Image"

    # 1 MP = 1024×1024 px (mégapixel BINAIRE) — MÊME convention que la
    # Resolution Preset v2 (PIXELS_PER_MP), pour que « 32 MP » veuille dire la
    # même chose dans les deux nodes.
    PIXELS_PER_MP = 1048576.0

    @classmethod
    def compute_target_dimensions(cls, original_width, original_height,
                                  megapixels, force_multiple_of="None"):
        """Budget en MP → dimensions cibles (PURE : ni tensor, ni modèle).

        Logique extraite de `upscale` pour être testable HORS ComfyUI/torch ;
        l'algorithme est inchangé (mêmes arrondis, même ordre d'opérations).

        Sémantique du budget ici : « viser » N MP, PAS « ne jamais dépasser ».
        Contrairement à la v2 (qui rogne tant que width×height > total), ce node
        arrondit chaque côté au plus proche multiple de `force_multiple_of` : le
        résultat peut donc dépasser le budget de moins d'un pas de multiple par
        côté (ex. 33.5 MP @ multiple 64 en 1:1 → 5952² = 33,79 MP).
        `force_multiple_of == "None"` conserve l'arrondi entier simple (troncature).

        Renvoie ``(0, 0)`` si l'image d'entrée est dégénérée (un côté ≤ 0) :
        l'appelant se contente alors de renvoyer l'image telle quelle.
        Lève ``ValueError`` si le budget n'est pas strictement positif.
        """
        target_pixels = megapixels * cls.PIXELS_PER_MP
        if target_pixels <= 0:
            raise ValueError("Megapixels must be positive.")

        original_pixels = original_height * original_width
        if original_pixels <= 0:
            return (0, 0)

        # The scale factor is the square root of the ratio of target pixels to
        # original pixels.
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

        return (target_width, target_height)

    def upscale(self, image, model_name, upscale_method, megapixels, force_multiple_of, resize_mode, clean_vram):
        # Optionally clear VRAM to free up memory before the main operation.
        if clean_vram:
            comfy.model_management.soft_empty_cache()

        # LEGACY : aucune sélection ("None" historique ou valeur vide) → l'image
        # est renvoyée INCHANGÉE, budget MP ignoré. Comportement conservé à
        # l'identique pour les workflows enregistrés.
        if model_name == self.LEGACY_PASSTHROUGH or not model_name:
                return (image, "None")

        # --- Target Dimension Calculation ---
        # Dimensions cibles à partir du budget MP (logique pure, cf. la
        # classmethod compute_target_dimensions). (0, 0) = image dégénérée.
        # Calculé AVANT toute ouverture de modèle : le mode sans modèle n'en a
        # pas besoin, et le résultat ne dépend que de la forme de l'image.
        _, original_height, original_width, _ = image.shape
        target_width, target_height = self.compute_target_dimensions(
            original_width, original_height, megapixels, force_multiple_of)
        if target_width <= 0 or target_height <= 0:
            return (image, model_name)

        # --- Stage 1 (« Two-Stage Upscaling ») ---
        # `NO_MODEL` = redimensionnement PUR : on saute entièrement le chargement
        # du modèle (aucun fichier ouvert, aucun poids en VRAM) et la Stage 2
        # ci-dessous fait tout le travail avec `upscale_method`.
        if model_name == self.NO_MODEL:
            logger.info(
                "[AIH-Upscale] no upscale model selected → pure resample (%s)",
                upscale_method)
            upscaled_image = image.float()
        else:
            upscaled_image = self._upscale_with_model(image, model_name)

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
        # Le modèle (s'il y en avait un) a été libéré à la sortie de
        # _upscale_with_model ; on vide le cache comme avant. En mode « none »
        # rien n'a été chargé : l'appel est inoffensif.
        comfy.model_management.soft_empty_cache()

        return (upscaled_image, model_name)

    def _upscale_with_model(self, image, model_name):
        """Stage 1 : upscale par le MODÈLE (facteur natif) → image NHWC float32.

        Bloc extrait TEL QUEL de `upscale` (mêmes appels, même ordre) pour que
        le faux modèle `NO_MODEL` puisse le sauter entièrement. Le descripteur
        Spandrel est libéré en sortant de cette méthode.
        """
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

        return scaled_img.movedim(1, -1) # Permute back to NHWC

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
