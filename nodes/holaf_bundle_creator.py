# nodes/holaf_bundle_creator.py

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


class HolafBundleCreator:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        # Generate 20 optional inputs
        optional_inputs = {}
        for i in range(1, 21):
            optional_inputs[f"input_{i:02}"] = (ANY_TYPE, )

        return {
            "required": {},
            "optional": optional_inputs
        }

    RETURN_TYPES = ("HOLAF_BUNDLE_DATA",)
    RETURN_NAMES = ("bundle",)
    FUNCTION = "do_bundle"
    CATEGORY = "AIH/Bundles"
    
    def do_bundle(self, **kwargs):
        """
        Collects all provided inputs into a single dictionary (bundle).
        """
        # kwargs contains all inputs that were actually connected and sent data.
        # We simply return this dictionary as the bundle.
        return (kwargs,)

# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix).
# Legacy alias keys were removed (user decision): /api/object_info exposes
# one entry PER KEY, so a second alias key made every node appear TWICE in
# the Add Node search. Old workflows referencing the removed keys must be
# redone.
NODE_CLASS_MAPPINGS = {
    "AIHBundleCreator": HolafBundleCreator,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHBundleCreator": "AIH Bundle Creator",
}
