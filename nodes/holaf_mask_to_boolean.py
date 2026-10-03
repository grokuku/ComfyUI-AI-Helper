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

class HolafMaskToBoolean:
    """
    A utility node that checks if an input mask is empty (all black).
    If the mask contains no white pixels (all values are 0), it outputs True.
    Otherwise, it outputs False. This is useful for creating a bypass signal
    for other nodes when a mask is not generated.
    """
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "mask": ("MASK",),
            },
        }

    RETURN_TYPES = ("BOOLEAN",)
    RETURN_NAMES = ("bypass",)
    FUNCTION = "check_mask_is_empty"
    CATEGORY = "AIH/Masking"

    def check_mask_is_empty(self, mask: torch.Tensor):
        """
        Checks if the mask tensor is composed entirely of zeros.
        
        A mask is considered "empty" for bypass purposes if no part of it is active.
        In ComfyUI, an active mask area has values > 0 (typically 1.0 for white).
        An inactive mask area has a value of 0 (black).
        
        torch.all(mask == 0) efficiently checks if every element in the tensor is 0.
        .item() extracts the Python boolean value from the resulting tensor.
        """
        if mask is None or mask.numel() == 0:
            # If there's no mask or it's an empty tensor, consider it empty and bypass.
            return (True,)

        # If all pixels in the mask are 0, it's empty. Return True to bypass.
        is_empty = torch.all(mask == 0).item()
        
        return (is_empty,)

# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix).
# Legacy alias keys were removed (user decision): /api/object_info exposes
# one entry PER KEY, so a second alias key made every node appear TWICE in
# the Add Node search. Old workflows referencing the removed keys must be
# redone.
NODE_CLASS_MAPPINGS = {
    "AIHMaskToBoolean": HolafMaskToBoolean,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHMaskToBoolean": "AIH Mask to Boolean",
}
