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

from holaf_node_helpers import ANY_TYPE  # noqa: E402  (requires _NODE_DIR above)

class HolafGroupBypasser:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                # CRITICAL CHANGE:
                # Switched from (["None"],) to ("STRING", ...)
                # This makes the input a free-text field for the Python validator,
                # accepting any group name ("Step 1", "Step 2", etc.).
                # The JavaScript will render it as a dropdown.
                "comfy_group": ("STRING", {"default": "None"}), 
                "group_name": ("STRING", {"default": "Group A"}),
                "active": ("BOOLEAN", {"default": True, "label_on": "ON", "label_off": "OFF"}),
                "bypass_mode": (["Bypass", "Mute"],),
            },
            "optional": {
                "original": (ANY_TYPE,),
                "alternative": (ANY_TYPE,),
            }
        }

    RETURN_TYPES = (ANY_TYPE,)
    RETURN_NAMES = ("output",)
    FUNCTION = "process"
    CATEGORY = "AIH/Flow Control"

    # Keep VALIDATE_INPUTS for safety
    @classmethod
    def VALIDATE_INPUTS(s, **kwargs):
        return True

    def check_lazy_status(self, comfy_group, group_name, active, bypass_mode, original=None, alternative=None, **kwargs):
        """Manages lazy evaluation to prevent 'Missing Input' errors
        when the source group is bypassed.
        """
        if active:
            return ["original"]
        else:
            return ["alternative"]

    def process(self, comfy_group, group_name, active, bypass_mode, original=None, alternative=None, **kwargs):
        if active:
            return (original,)
        else:
            return (alternative,)

# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix).
# Legacy alias keys were removed (user decision): /api/object_info exposes
# one entry PER KEY, so a second alias key made every node appear TWICE in
# the Add Node search. Old workflows referencing the removed keys must be
# redone.
NODE_CLASS_MAPPINGS = {
    "AIHGroupBypasser": HolafGroupBypasser,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHGroupBypasser": "AIH Group Bypasser",
}
