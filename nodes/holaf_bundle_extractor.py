# nodes/holaf_bundle_extractor.py

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


class HolafBundleExtractor:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "bundle": ("HOLAF_BUNDLE_DATA",),
            }
        }
    
    # We use ANY_TYPE for all 20 outputs so they can connect to anything (IMAGE, MODEL, etc.)
    RETURN_TYPES = tuple([ANY_TYPE] * 20)
    
    # Names corresponding to the creator inputs for clarity
    RETURN_NAMES = tuple([f"output_{i:02}" for i in range(1, 21)])
    
    FUNCTION = "do_extract"
    CATEGORY = "AIH/Bundles"

    def do_extract(self, bundle):
        """
        Extracts data from the bundle and maps it to the corresponding outputs.
        """
        results = []
        for i in range(1, 21):
            # Key used in the creator node
            key = f"input_{i:02}"
            
            # Retrieve data if present, else None
            val = bundle.get(key, None)
            results.append(val)
        
        return tuple(results)

# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix).
# Legacy alias keys were removed (user decision): /api/object_info exposes
# one entry PER KEY, so a second alias key made every node appear TWICE in
# the Add Node search. Old workflows referencing the removed keys must be
# redone.
NODE_CLASS_MAPPINGS = {
    "AIHBundleExtractor": HolafBundleExtractor,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHBundleExtractor": "AIH Bundle Extractor",
}
