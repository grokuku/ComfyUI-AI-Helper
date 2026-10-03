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


class HolafAutoSelectX2:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {},
            "optional": {
                "input_1": (ANY_TYPE,),
                "input_2": (ANY_TYPE,),
            }
        }

    RETURN_TYPES = (ANY_TYPE,)
    RETURN_NAMES = ("selected",)
    FUNCTION = "select"
    CATEGORY = "AIH/Flow Control"

    def select(self, input_1=None, input_2=None):
        # Priority to input_1
        if input_1 is not None:
            return (input_1,)
        if input_2 is not None:
            return (input_2,)
        
        # If no input is provided, return None
        return (None,)

# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix).
# Legacy alias keys were removed (user decision): /api/object_info exposes
# one entry PER KEY, so a second alias key made every node appear TWICE in
# the Add Node search. Old workflows referencing the removed keys must be
# redone.
NODE_CLASS_MAPPINGS = {
    "AIHAutoSelectX2": HolafAutoSelectX2,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHAutoSelectX2": "AIH Auto Select x2",
}
