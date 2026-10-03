import os
import random
import string
import torch
import numpy as np
from PIL import Image
import folder_paths
import subprocess
import shutil
import wave
from server import PromptServer
from aiohttp import web

# --- 1. SETTINGS BRIDGE (Global Configuration) ---
GLOBAL_SETTINGS = {
    "video_res": 0,          # 0 = Original resolution
    "video_speed": "ultrafast", # ultrafast, fast, medium
    "image_format": "WEBP",     # PNG, WEBP, JPEG
    "audio_format": "wav"
}

@PromptServer.instance.routes.post("/holaf/comparer/settings")
async def update_comparer_settings(request):
    """API endpoint to receive UI settings updates"""
    try:
        data = await request.json()
        global GLOBAL_SETTINGS
        for key, value in data.items():
            if key in GLOBAL_SETTINGS:
                GLOBAL_SETTINGS[key] = value
        return web.json_response({"status": "success", "settings": GLOBAL_SETTINGS})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)})

# --- 2. UNIVERSAL TYPE DEFINITION ---
# AnyType is shared pack-wide via nodes/holaf_node_helpers.py since the fusion
# (the former local duplicate class was removed; see PLAN_FUSION.md §3.1).
# The helper's implementation overrides both __eq__ and __ne__, which is a
# strict superset of the old local behaviour under ComfyUI type checking.
import os as _os
import sys as _sys

_NODE_DIR = _os.path.dirname(_os.path.abspath(__file__))
if _NODE_DIR not in _sys.path:
    _sys.path.insert(0, _NODE_DIR)

from holaf_node_helpers import ANY_TYPE as ANY  # noqa: E402  (requires _NODE_DIR above)

# --- 3. FFMPEG CACHE ---
def get_ffmpeg_encoder():
    """Checks for GPU nvenc once, then caches the result to avoid lags."""
    if hasattr(get_ffmpeg_encoder, "cached"):
        return get_ffmpeg_encoder.cached
    try:
        res = subprocess.run(['ffmpeg', '-encoders'], capture_output=True, text=True, timeout=2)
        if 'h264_nvenc' in res.stdout:
            get_ffmpeg_encoder.cached = 'h264_nvenc'
            return 'h264_nvenc'
    except Exception:
        pass
    get_ffmpeg_encoder.cached = 'libx264'
    return get_ffmpeg_encoder.cached

# --- 4. MAIN NODE LOGIC ---
class HolafRemoteComparerNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "comparison_name": ("STRING", {"default": "Comparison 1", "multiline": False}),
            },
            "optional": {
                "input_1": (ANY,),
                "input_2": (ANY,),
            }
        }

    RETURN_TYPES = (ANY, ANY)
    RETURN_NAMES = ("input_1", "input_2")
    FUNCTION = "compare"
    CATEGORY = "AIH/View"
    OUTPUT_NODE = True # Forces execution

    def compare(self, comparison_name="Comparison 1", input_1=None, input_2=None):
        media_list = []
        
        def save_passthrough(file_path, prefix, media_type):
            """Directly copies existing files (Audio/Video/Images) without re-encoding."""
            if not file_path or not os.path.exists(file_path):
                return None
            
            temp_dir = folder_paths.get_temp_directory()
            random_id = ''.join(random.choices(string.ascii_letters + string.digits, k=8))
            ext = os.path.splitext(file_path)[1]
            filename = f"holaf_remote_cmp_{prefix}_{random_id}{ext}"
            dest_path = os.path.join(temp_dir, filename)
            
            try:
                shutil.copy2(file_path, dest_path)
                return {
                    "filename": filename,
                    "subfolder": "",
                    "type": "temp",
                    "format": media_type
                }
            except Exception as e:
                print(f"[HolafRemoteComparer] Passthrough copy failed: {e}")
                return None

        def process_input(data, prefix):
            if data is None:
                return None
                
            temp_dir = folder_paths.get_temp_directory()
            random_id = ''.join(random.choices(string.ascii_letters + string.digits, k=8))
            
            # CASE A: RAW TENSOR (Image or Video Sequence)
            if isinstance(data, torch.Tensor) and len(data.shape) == 4:
                B, H, W, C = data.shape
                
                if B == 1:
                    # SINGLE IMAGE
                    fmt = GLOBAL_SETTINGS["image_format"].lower()
                    ext = "jpg" if fmt == "jpeg" else fmt
                    filename = f"holaf_remote_cmp_{prefix}_{random_id}.{ext}"
                    filepath = os.path.join(temp_dir, filename)
                    
                    image = data[0]
                    img = Image.fromarray(image.cpu().float().mul(255).clamp(0, 255).byte().numpy())
                    
                    # JPEG cannot handle alpha channel (RGBA), convert to RGB
                    if fmt in ["jpeg", "jpg"] and img.mode == "RGBA":
                        img = img.convert("RGB")
                    
                    save_kwargs = {}
                    if fmt in ["jpeg", "webp"]:
                        save_kwargs["quality"] = 90
                    else:
                        save_kwargs["compress_level"] = 1
                        
                    img.save(filepath, **save_kwargs)
                    return {"filename": filename, "subfolder": "", "type": "temp", "format": "image"}
                
                else:
                    # VIDEO SEQUENCE (High-Speed Encoding)
                    filename = f"holaf_remote_cmp_{prefix}_{random_id}.mp4"
                    filepath = os.path.join(temp_dir, filename)
                    
                    encoder = get_ffmpeg_encoder()
                    res = int(GLOBAL_SETTINGS["video_res"])
                    speed = GLOBAL_SETTINGS["video_speed"]
                    
                    vf_params = []
                    if res > 0:
                        vf_params.append(f"scale='min({res},iw)':-2") # Dynamic Resize
                    vf_params.append("pad=ceil(iw/2)*2:ceil(ih/2)*2") # H264 safe padding
                    vf_string = ",".join(vf_params)
                    
                    cmd = [
                        'ffmpeg', '-y', '-f', 'rawvideo', '-vcodec', 'rawvideo',
                        '-s', f"{W}x{H}", '-pix_fmt', 'rgb24', '-r', '24',
                        '-i', '-', '-vf', vf_string
                    ]
                    
                    if encoder == 'h264_nvenc':
                        preset = 'p4' if speed == 'medium' else 'p1' # p1 is fastest for NVENC
                        cmd.extend(['-c:v', 'h264_nvenc', '-preset', preset, '-cq', '20', '-b:v', '0'])
                    else:
                        cmd.extend(['-c:v', 'libx264', '-preset', speed, '-crf', '20'])
                        
                    cmd.extend(['-pix_fmt', 'yuv420p', filepath])
                    
                    frames = data.cpu().float().mul(255).clamp(0, 255).byte().numpy()
                    
                    try:
                        process = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                        process.communicate(input=frames.tobytes(), timeout=120)
                        return {"filename": filename, "subfolder": "", "type": "temp", "format": "video"}
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.communicate()
                        print(f"[HolafRemoteComparer] FFmpeg encoding timed out. Fallback to image.")
                        img = Image.fromarray(frames[0])
                        filename_fb = f"holaf_remote_cmp_{prefix}_{random_id}_fb.png"
                        filepath_fb = os.path.join(temp_dir, filename_fb)
                        img.save(filepath_fb, compress_level=1)
                        return {"filename": filename_fb, "subfolder": "", "type": "temp", "format": "image"}
            
            # CASE B: COMFYUI NATIVE AUDIO (Dict with waveform)
            elif isinstance(data, dict) and "waveform" in data and "sample_rate" in data:
                try:
                    filename = f"holaf_remote_cmp_{prefix}_{random_id}.wav"
                    filepath = os.path.join(temp_dir, filename)
                    
                    # CPU push and numpy conversion
                    waveform = data["waveform"].cpu().float().numpy()
                    
                    # Handle shape [Batch, Channels, Length] -> [Channels, Length]
                    if len(waveform.shape) == 3: 
                        waveform = waveform[0]
                    if len(waveform.shape) == 1: 
                        waveform = waveform.reshape(1, -1)
                    
                    sample_rate = int(data["sample_rate"])
                    channels = waveform.shape[0]
                    
                    # Convert float32 [-1.0, 1.0] to int16 PCM
                    waveform_int16 = np.int16(np.clip(waveform, -1.0, 1.0) * 32767)
                    
                    # Interleave channels for stereo (e.g., [2, N] -> [N, 2])
                    if channels > 1:
                        audio_data = waveform_int16.T.flatten()
                    else:
                        audio_data = waveform_int16.flatten()
                        
                    # Write native WAV file
                    with wave.open(filepath, "w") as wav_file:
                        wav_file.setnchannels(channels)
                        wav_file.setsampwidth(2) # 2 bytes = 16 bit
                        wav_file.setframerate(sample_rate)
                        wav_file.writeframes(audio_data.tobytes())
                        
                    return {"filename": filename, "subfolder": "", "type": "temp", "format": "audio"}
                except Exception as e:
                    print(f"[HolafRemoteComparer] Native Audio extraction failed: {e}")
                    return None

            # CASE C: PASSTHROUGH DICT (External nodes like Video Helper Suite)
            elif isinstance(data, dict):
                file_path = None
                if "file" in data and isinstance(data["file"], list) and len(data["file"]) > 0:
                    file_path = data["file"][0] # VHS output style
                elif "video" in data:
                    file_path = data["video"]
                elif "audio" in data:
                    file_path = data["audio"]
                
                if file_path and isinstance(file_path, str) and os.path.exists(file_path):
                    ext = file_path.lower()
                    m_type = "video" if ext.endswith(('.mp4', '.webm', '.mkv', '.avi', '.mov')) else "audio" if ext.endswith(('.wav', '.mp3', '.flac', '.ogg')) else "image"
                    return save_passthrough(file_path, prefix, m_type)

            # CASE D: NEW COMFYUI OBJECTS SCANNER (VideoFromFile, etc.)
            elif hasattr(data, '__class__') and not isinstance(data, str):
                # Smart attribute probing
                file_path = getattr(data, "path", getattr(data, "video_path", getattr(data, "file_path", None)))
                
                if file_path is None and hasattr(data, "__dict__"):
                    # Aggressive fallback: probe all strings in the object properties
                    for val in data.__dict__.values():
                        if isinstance(val, str) and os.path.exists(val):
                            file_path = val
                            break
                
                if file_path and isinstance(file_path, str) and os.path.exists(file_path):
                    ext = file_path.lower()
                    m_type = "video" if ext.endswith(('.mp4', '.webm', '.mkv', '.avi', '.mov')) else "audio" if ext.endswith(('.wav', '.mp3', '.flac', '.ogg')) else "image"
                    return save_passthrough(file_path, prefix, m_type)

            # CASE E: PASSTHROUGH STRING (Direct file path)
            elif isinstance(data, str) and os.path.exists(data):
                ext = data.lower()
                m_type = "video" if ext.endswith(('.mp4', '.webm', '.mkv', '.avi', '.mov')) else "audio" if ext.endswith(('.wav', '.mp3', '.flac', '.ogg')) else "image"
                return save_passthrough(data, prefix, m_type)
            
            return None

        m1 = process_input(input_1, "A")
        if m1: media_list.append(m1)
            
        m2 = process_input(input_2, "B")
        if m2: media_list.append(m2)

        # Isolated Payload Structure
        payload = {
            "comparison_name": comparison_name,
            "media": media_list
        }

        return {"ui": {"holaf_payload": [payload]}, "result": (input_1, input_2)}

# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix).
# Legacy alias keys were removed (user decision): /api/object_info exposes
# one entry PER KEY, so a second alias key made every node appear TWICE in
# the Add Node search. Old workflows referencing the removed keys must be
# redone.
NODE_CLASS_MAPPINGS = {
    "AIHRemoteComparer": HolafRemoteComparerNode,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHRemoteComparer": "AIH Remote Comparer",
}
