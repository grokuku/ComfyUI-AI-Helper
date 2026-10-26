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

"""Shared helpers for the AIH (ex CUI-Holaf) custom nodes.

This module was formerly ``nodes/holaf_utils.py`` in the standalone CUI-Holaf
pack; it was renamed on import into ComfyUI-Holaf-Utils because the root
package already ships its own ``holaf_utils`` module. It hosts everything the
node files share: path validation, conditioning preparation, tensor/PIL
conversions and the pack-wide ``AnyType``/``ANY_TYPE`` implementation.

Nodes import it through an absolute import bootstrapped on ``sys.path`` (see
the bootstrap comment block in each node file) so that every module resolves
this same instance, keeping the ``ANY_TYPE`` singleton unique pack-wide.
"""

import os
import logging
import threading
import numpy as np
import torch
import folder_paths
from PIL import Image

logger = logging.getLogger("Holaf")

# ── Replis de chemin déjà signalés (UNE fois par process) ───────────────────
# Un `base_path` (ou un `subfolder`) hors du dossier autorisé est un cas
# NORMAL lorsqu'une configuration a été conçue sur une autre machine : sur le
# worker Modal, le `base_path` local `/config/outputs/ComfyUI/` tombe hors de
# `/root/comfy/ComfyUI/output` à CHAQUE sauvegarde. Répéter le WARNING noie les
# vraies erreurs dans les logs du worker ; il est donc émis UNE fois (texte
# complet, avec la marche à suivre), puis seulement en DEBUG. Le GARDE-FOU de
# sécurité, lui, n'est pas touché : le chemin hors zone reste REFUSÉ.
_WARNED_PATH_FALLBACKS = set()
_WARNED_PATH_FALLBACKS_LOCK = threading.Lock()


def _warn_path_fallback_once(key, message):
    """Émet *message* en WARNING une seule fois par *key* (DEBUG ensuite).

    Args:
        key: identité du repli (ex. ``("base_path", chemin_absolu)``).
        message: texte du premier avertissement (complet et informatif).
    """
    with _WARNED_PATH_FALLBACKS_LOCK:
        already = key in _WARNED_PATH_FALLBACKS
        if not already:
            _WARNED_PATH_FALLBACKS.add(key)
    if already:
        logger.debug("Repli de chemin déjà signalé : %s", message)
        return
    logger.warning(message)


def reset_path_fallback_warnings():
    """Oublie les replis déjà signalés (tests / nouvelle exécution explicite)."""
    with _WARNED_PATH_FALLBACKS_LOCK:
        _WARNED_PATH_FALLBACKS.clear()


def validate_base_path(base_path, allowed_base=None):
    """Prevent path traversal by ensuring the resolved path stays within allowed_base.

    Returns ``allowed_base`` (fallback) if ``base_path`` resolves outside the
    permitted directory, otherwise returns ``base_path`` unchanged.
    """
    if allowed_base is None:
        allowed_base = folder_paths.get_output_directory()
    abs_base = os.path.abspath(os.path.expanduser(base_path))
    abs_allowed = os.path.abspath(allowed_base)
    if not (abs_base == abs_allowed or abs_base.startswith(abs_allowed + os.sep)):
        _warn_path_fallback_once(
            ("base_path", abs_base, abs_allowed),
            f"base_path '{base_path}' resolves outside allowed directory '{allowed_base}'. "
            f"Falling back to '{allowed_base}' (chemin hors zone REFUSÉ — signalé une "
            f"seule fois ; corrigez le widget base_path ou la configuration du node).",
        )
        return allowed_base
    return base_path


def validate_subfolder(base_path, subfolder, allowed_base=None):
    """Prevent path traversal via subfolder by ensuring the full resolved path stays within allowed_base.

    Returns an empty string (discarding the subfolder) if the combined path
    resolves outside the permitted directory, otherwise returns ``subfolder``
    unchanged.
    """
    if allowed_base is None:
        allowed_base = folder_paths.get_output_directory()
    abs_allowed = os.path.abspath(allowed_base)
    full_path = os.path.join(base_path, subfolder)
    abs_full = os.path.abspath(full_path)
    if not (abs_full == abs_allowed or abs_full.startswith(abs_allowed + os.sep)):
        _warn_path_fallback_once(
            ("subfolder", abs_full, abs_allowed),
            f"subfolder '{subfolder}' resolves outside allowed directory '{allowed_base}'. "
            f"Discarding subfolder (contenu hors zone REFUSÉ — signalé une seule fois).",
        )
        return ""
    return subfolder


def prepare_cond_for_tile(original_cond_list, device):
    """Shallow copy + tensor clone (faster than deepcopy for large conditionings).

    Note: This uses a shallow dict copy. If any values in the conditioning dict
    are mutable nested objects, they will be shared between copies. This is
    acceptable for ComfyUI conditioning dicts which are not mutated in place.
    """
    if not isinstance(original_cond_list, list):
        return []
    cond_list_copy = []
    for item in original_cond_list:
        if isinstance(item, (list, tuple)) and len(item) >= 1:
            if torch.is_tensor(item[0]):
                cloned_tensor = item[0].clone().to(device)
                cond_dict = item[1].copy() if len(item) > 1 and isinstance(item[1], dict) else {}
                cond_list_copy.append([cloned_tensor, cond_dict])
            else:
                cond_list_copy.append(list(item))
        elif torch.is_tensor(item):
            cond_list_copy.append([item.clone().to(device), {}])
        else:
            cond_list_copy.append(item)
    return cond_list_copy


class AnyType(str):
    """A special type that can be any ComfyUI data type.

    Allows a node to accept any input type by overriding type checking.
    The str base class lets us pass type comparisons that expect a string.

    WARNING: __eq__ always returns True and __ne__ always returns False.
    Do NOT use this class in general comparison logic — it is designed
    exclusively for ComfyUI type coercion.
    """

    def __ne__(self, __value: object) -> bool:
        return False

    def __eq__(self, __value: object) -> bool:
        return True

    def __str__(self) -> str:
        return "*"


#: Shared singleton instance of :class:`AnyType` used across all Holaf nodes.
ANY_TYPE = AnyType("*")


def tensor_to_pil(tensor):
    """Convert a ComfyUI image tensor (BHWC or HWC, float [0,1]) to a PIL Image.

    Handles tensors with 1 (grayscale), 3 (RGB), or 4 (RGBA) channels.
    If a 4D (BHWC) tensor is passed, the first element of the batch is used.
    """
    if not isinstance(tensor, torch.Tensor):
        raise TypeError(f"Input must be a torch.Tensor, got {type(tensor)}")

    # Handle 4D (BHWC) — take first element
    if tensor.ndim == 4:
        tensor = tensor[0]

    if tensor.numel() == 0:
        return Image.new('RGB', (1, 1), color='black')

    # PyTorch SIMD conversion (avoids numpy float64 promotion)
    image_np = tensor.cpu().float().mul(255).clamp(0, 255).byte().numpy()

    if image_np.ndim == 3 and image_np.shape[2] in [1, 3, 4]:
        # Ambiguous case: both shape[0] and shape[2] could be channels.
        # ComfyUI always uses HWC, so we prefer that interpretation, but
        # warn when the tensor is small enough to be genuinely ambiguous.
        if image_np.shape[0] in [1, 3, 4] and image_np.shape[1] <= 4:
            logger.warning(f"Ambiguous tensor shape {image_np.shape} "
                  f"(both H and C look like channel counts). Assuming HWC "
                  f"(ComfyUI convention). If this is wrong, pre-squeeze your tensor.")
        pass  # Already HWC
    elif image_np.ndim == 3 and image_np.shape[0] in [1, 3, 4]:
        image_np = np.transpose(image_np, (1, 2, 0))  # CHW to HWC
    elif image_np.ndim == 0:
        return Image.new('RGB', (1, 1), color='black')

    if image_np.ndim == 3 and image_np.shape[2] == 1:
        image_np = image_np.squeeze(axis=2)

    try:
        return Image.fromarray(image_np)
    except Exception as e:
        logger.warning(f"Error creating PIL Image (shape: {image_np.shape}, dtype: {image_np.dtype}): {e}")
        return Image.new('RGB', (1, 1), color='red')


def pil_to_tensor(image):
    """Convert a PIL Image to a batched tensor in BHWC format [0,1].

    Grayscale images are expanded to 3-channel RGB. RGBA images that lost
    their alpha channel are re-expanded with a fully opaque alpha.
    """
    image_np = np.array(image).astype(np.float32) / 255.0
    if image.mode == 'RGBA' and image_np.shape[-1] == 3:
        alpha_channel = np.ones_like(image_np[..., :1])
        image_np = np.concatenate((image_np, alpha_channel), axis=-1)
    elif image_np.ndim == 2:
        image_np = np.stack((image_np,) * 3, axis=-1)

    return torch.from_numpy(image_np).unsqueeze(0)  # (1, H, W, C) = BHWC