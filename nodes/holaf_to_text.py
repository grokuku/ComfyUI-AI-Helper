import torch
import json

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

MAX_JSON_CHARS = 10000


class TensorEncoder(json.JSONEncoder):
    """Custom JSON encoder that safely handles torch.Tensor and other non-serializable types."""
    def default(self, obj):
        if isinstance(obj, torch.Tensor):
            return f"<Tensor shape={list(obj.shape)} dtype={obj.dtype}>"
        if isinstance(obj, type):
            return obj.__name__
        try:
            return super().default(obj)
        except TypeError:
            return f"<{type(obj).__name__}>"


class HolafToText:
    """
    Accepts any input, converts it to string, and provides formatting hints
    for the custom Markdown/HTML renderer.
    """
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "any_input": (ANY_TYPE,),
                "display_mode": (["Auto", "Plain", "JSON", "Markdown"], {"default": "Auto"}),
            },
        }

    RETURN_TYPES = (ANY_TYPE, "STRING")
    RETURN_NAMES = ("original", "text")
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "AIH/Text"

    def _format_tensor(self, tensor):
        """Format tensor info with semantic type detection and statistics."""
        shape = list(tensor.shape) if hasattr(tensor, 'shape') else "unknown"
        device = str(tensor.device) if hasattr(tensor, 'device') else "unknown"
        dt = str(tensor.dtype) if hasattr(tensor, 'dtype') else "unknown"

        # Detect semantic type
        semantic = "Tensor"
        extra_lines = []
        if tensor.ndim == 4:
            B, H, W, C = shape
            if C == 1:
                semantic = "Mask"
            elif C == 3:
                semantic = "Image (RGB)"
            elif C == 4:
                semantic = "Image (RGBA)"
            else:
                semantic = f"4D Tensor (C={C})"
            if C in (1, 3, 4):
                extra_lines.append(f"- **Resolution**: `{W}x{H}`")
                if B > 1:
                    extra_lines.append(f"- **Batch**: `{B}`")
        elif tensor.ndim == 3:
            C, H, W = shape
            semantic = f"Latent (C={C}, ~{W*8}x{H*8}px)"
            if H > 1 and W > 1:
                extra_lines.append(f"- **Latent size**: `{W}x{H}`")
        elif tensor.ndim == 2:
            semantic = f"2D Matrix ({shape[0]}x{shape[1]})"
        elif tensor.ndim == 1:
            semantic = f"1D Vector ({shape[0]})"

        lines = [f"### {semantic}",
                 f"- **Shape**: `{shape}`",
                 f"- **Device**: `{device}`",
                 f"- **Dtype**: `{dt}`"]

        # Statistics
        try:
            fmin = float(tensor.min())
            fmax = float(tensor.max())
            fmean = float(tensor.mean())
            lines.append(f"- **Range**: `[{fmin:.4f}, {fmax:.4f}]`")
            lines.append(f"- **Mean**: `{fmean:.4f}`")
        except Exception:
            pass

        lines.extend(extra_lines)
        return "\n".join(lines), "Markdown"

    def _detect_comfyui_type(self, data):
        """Detect common ComfyUI data types from dict keys."""
        if not isinstance(data, dict):
            return None

        if "samples" in data and torch.is_tensor(data["samples"]):
            samples = data["samples"]
            shape = list(samples.shape)
            lines = [f"### LATENT",
                     f"- **Shape**: `{shape}`",
                     f"- **Dtype**: `{samples.dtype}`"]
            try:
                lines.append(f"- **Range**: `[{float(samples.min()):.4f}, {float(samples.max()):.4f}]`")
            except Exception:
                pass
            # Show other keys
            other_keys = [k for k in data.keys() if k != "samples"]
            if other_keys:
                lines.append(f"- **Other keys**: `{other_keys}`")
            return "\n".join(lines), "Markdown"

        if "waveform" in data and "sample_rate" in data:
            wf = data["waveform"]
            sr = data["sample_rate"]
            lines = [f"### AUDIO",
                     f"- **Sample Rate**: `{sr}`"]
            if torch.is_tensor(wf):
                lines.append(f"- **Waveform Shape**: `{list(wf.shape)}`")
                lines.append(f"- **Dtype**: `{wf.dtype}`")
                try:
                    duration = wf.shape[-1] / sr if sr > 0 else 0
                    lines.append(f"- **Duration**: `{duration:.2f}s`")
                except Exception:
                    pass
            else:
                lines.append(f"- **Waveform**: `{type(wf).__name__}`")
            return "\n".join(lines), "Markdown"

        return None

    def run(self, any_input, display_mode):
        text_val = ""
        detected_mode = display_mode

        try:
            if isinstance(any_input, torch.Tensor):
                text_val, auto_mode = self._format_tensor(any_input)
                if detected_mode == "Auto":
                    detected_mode = auto_mode

            elif isinstance(any_input, (dict, list)):
                # Try ComfyUI type detection first
                comfy_info = self._detect_comfyui_type(any_input) if isinstance(any_input, dict) else None
                if comfy_info:
                    text_val, auto_mode = comfy_info
                    if detected_mode == "Auto":
                        detected_mode = auto_mode
                else:
                    text_val = json.dumps(any_input, indent=4, ensure_ascii=False, cls=TensorEncoder)
                    if len(text_val) > MAX_JSON_CHARS:
                        text_val = text_val[:MAX_JSON_CHARS] + "\n\n... (truncated)"
                    if detected_mode == "Auto":
                        detected_mode = "JSON"

            else:
                text_val = str(any_input)
                # Auto-detect markdown in plain strings
                if detected_mode == "Auto" and text_val.strip().startswith(("#", "- ", "**", "###")):
                    detected_mode = "Markdown"

        except Exception as e:
            text_val = f"**Error**: `{type(e).__name__}: {str(e)}`"
            if detected_mode == "Auto":
                detected_mode = "Markdown"

        if detected_mode == "Auto":
            if text_val.strip().startswith(("#", "- ", "**", "###")):
                detected_mode = "Markdown"
            else:
                detected_mode = "Plain"

        return {
            "ui": {"text": [text_val], "mode": [detected_mode]},
            "result": (any_input, text_val)
        }

# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix).
# Legacy alias keys were removed (user decision): /api/object_info exposes
# one entry PER KEY, so a second alias key made every node appear TWICE in
# the Add Node search. Old workflows referencing the removed keys must be
# redone.
NODE_CLASS_MAPPINGS = {
    "AIHToText": HolafToText,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHToText": "AIH To Text",
}
