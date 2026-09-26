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

import os
import re
import json
import time
import shutil
import tempfile
import datetime
import logging
import torch
import numpy as np
from PIL import Image
import folder_paths
import av
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

from holaf_node_helpers import validate_base_path, validate_subfolder  # noqa: E402  (requires _NODE_DIR above)
from aih import media_upload  # noqa: E402  (pack root on sys.path via extension __init__)

logger = logging.getLogger("Holaf.SaveMedia")

class HolafSaveMedia:
    """
    Unified node to save Images, Videos, and Audio.
    Supports optional inputs and multiplexing audio into video files.
    """
    def __init__(self):
        self.output_dir = folder_paths.get_output_directory()
        self.type = "output"

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "mode": (["image", "video", "audio"], {"default": "image"}),

                "--- GENERIC SETTINGS ---": (["-----------------"],),
                "save_to_server": ("BOOLEAN", {"default": False}),
                "base_path": ("STRING", {"default": folder_paths.get_output_directory()}),
                "subfolder": ("STRING", {"default": "%Y-%m-%d"}),
                "filename": ("STRING", {"default": "%Y-%m-%d-%Hh%Mm%Ss"}),
                "save_prompt": ("BOOLEAN", {"default": True}),
                "save_workflow": ("BOOLEAN", {"default": True}),
                "temp_dir": ("STRING", {"default": ""}),

                "--- IMAGE FORMAT ---": (["-----------------"],),
                "image_format": (["png", "jpg", "webp"], {"default": "png"}),
                "image_compression": ("INT", {"default": 4, "min": 1, "max": 9, "step": 1}), # PNG comp
                "image_quality": ("INT", {"default": 90, "min": 1, "max": 100, "step": 1}),  # JPG/WEBP

                "--- VIDEO FORMAT ---": (["-----------------"],),
                "video_container": (["mp4", "webm", "gif"], {"default": "mp4"}),
                "video_codec": (["auto", "h264", "h265", "vp9", "av1", "h264_nvenc", "hevc_nvenc"], {"default": "auto"}),
                "video_fps": ("INT", {"default": 24, "min": 1, "max": 120, "step": 1}),
                "video_quality": ("INT", {"default": 23, "min": 0, "max": 63, "step": 1}),

                "--- AUDIO FORMAT ---": (["-----------------"],),
                "audio_format": (["wav", "mp3", "flac"], {"default": "wav"}),
                "audio_bitrate_kbps": ("INT", {"default": 192, "min": 64, "max": 320, "step": 32}),
            },
            "optional": {
                "image": ("IMAGE",),
                "audio": ("AUDIO",),
                "prompt": ("STRING", {"forceInput": True}),
            },
            "hidden": {
                "prompt_hidden": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO"
            },
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "STRING", "STRING", "STRING",)
    RETURN_NAMES = ("image", "audio", "filepath", "prompt", "workflow_json",)
    FUNCTION = "save_media"
    OUTPUT_NODE = True
    CATEGORY = "AIH/IO"

    @staticmethod
    def _validate_output_path(base_path, allowed_base=None):
        """Prevent path traversal by ensuring the resolved path stays within allowed_base.

        Delegates to :func:`holaf_utils.validate_base_path` for the canonical
        implementation. Kept for backward compatibility.
        """
        return validate_base_path(base_path, allowed_base)

    @staticmethod
    def _validate_subfolder(base_path, subfolder, allowed_base=None):
        """Prevent path traversal via subfolder by ensuring the full resolved path stays within allowed_base.

        Delegates to :func:`holaf_utils.validate_subfolder` for the canonical
        implementation. Kept for backward compatibility.
        """
        return validate_subfolder(base_path, subfolder, allowed_base)

    @staticmethod
    def _sanitize_base_filename(name):
        """Sanitize a base filename to prevent path traversal.

        The ``filename`` widget is a free-form STRING passed through
        ``now.strftime()`` and then joined into the output path. Unlike
        ``subfolder`` (validated by ``validate_subfolder``) and ``base_path``
        (validated by ``validate_base_path``), the filename was never checked,
        so a value like ``"../secret"`` or ``"..\\secret"`` could write
        outside the output directory.

        This removes path separators ('/' and '\\') and any '..' component so
        the formatted name cannot escape the output directory, while keeping
        legitimate characters (spaces, accents, dashes, underscores).
        """
        if not name:
            return "untitled"
        name = str(name)
        # Block path separators (both platforms) — they would allow traversal.
        name = name.replace('/', '_').replace('\\', '_')
        # Remove any '..' path-traversal component.
        name = name.replace('..', '')
        # Strip leading/trailing separators and whitespace.
        name = name.strip(' /\\')
        # Remove characters illegal on common filesystems.
        name = re.sub(r'[<>:"|?*\x00-\x1f]', '', name)
        if not name:
            return "untitled"
        return name

    @staticmethod
    def _is_within_directory(directory, path):
        """Return True if ``path`` resolves inside ``directory``.

        Uses ``os.path.realpath`` + ``os.path.commonpath`` so symlinks and
        '..' components are resolved before the containment check.
        """
        try:
            real_dir = os.path.realpath(directory)
            real_path = os.path.realpath(path)
            return os.path.commonpath([real_dir, real_path]) == real_dir
        except (ValueError, OSError):
            return False

    def get_unique_filepath(self, directory, base_filename, ext):
        filepath = os.path.join(directory, f"{base_filename}{ext}")
        # Security: ensure the resolved path stays within the output directory.
        if not self._is_within_directory(directory, filepath):
            raise ValueError(f"Resolved output path escapes the output directory: {filepath}")
        counter = 1
        while os.path.exists(filepath):
            filepath = os.path.join(directory, f"{base_filename}_{counter:04d}{ext}")
            if not self._is_within_directory(directory, filepath):
                raise ValueError(f"Resolved output path escapes the output directory: {filepath}")
            counter += 1
        return filepath, os.path.basename(filepath)

    def _prepare_output_paths(self, output_path, base_name_str, ext):
        """Resolve a unique output filepath and derive the base name.
        Returns (file_path, final_filename, base_name)."""
        file_path, final_filename = self.get_unique_filepath(output_path, base_name_str, ext)
        base_name = os.path.splitext(final_filename)[0]
        return file_path, final_filename, base_name

    def _create_temp_file(self, temp_dir, ext, prefix, output_path, formatted_filename_base, ts, log_temp_dir=True):
        """Create a temp file and resolve the final output path.
        Returns (temp_path, final_path, final_filename, base_name).
        If temp creation fails, writes directly to output (temp_path == final_path)."""
        try:
            tmp_fd, temp_path = tempfile.mkstemp(suffix=ext, prefix=prefix, dir=temp_dir)
            os.close(tmp_fd)
        except Exception as e:
            if log_temp_dir:
                logger.warning(f"{ts()} Temp file FAILED ({temp_dir}): {e}. Writing directly to output.")
            else:
                logger.warning(f"{ts()} Temp file FAILED: {e}. Writing directly.")
            final_path, final_filename, base_name = self._prepare_output_paths(output_path, formatted_filename_base, ext)
            return final_path, final_path, final_filename, base_name
        final_path, final_filename, base_name = self._prepare_output_paths(output_path, formatted_filename_base, ext)
        return temp_path, final_path, final_filename, base_name

    @staticmethod
    def _safe_move(temp_path, final_path, ts):
        """Move temp file to final destination, logging the transfer.
        Only moves if temp_path != final_path."""
        if temp_path != final_path:
            t0 = time.time()
            try:
                os.rename(temp_path, final_path)
            except OSError:
                shutil.move(temp_path, final_path)
            mb = os.path.getsize(final_path) / (1024 * 1024)
            logger.info(f"{ts()} File transfer: {mb:.1f} MB in {time.time()-t0:.2f}s")

    @staticmethod
    def _cleanup_temp(temp_path, final_path):
        """Remove a leftover temp file if it differs from the final path."""
        if temp_path and temp_path != final_path and os.path.exists(temp_path):
            try:
                os.unlink(temp_path)
            except OSError:
                pass

    @staticmethod
    def _build_workflow_json(extra_pnginfo):
        """Sérialise le graphe UI (extra_pnginfo['workflow']) en JSON.

        Retourne une chaîne vide si le workflow n'est pas disponible. Ne
        retombe JAMAIS sur le prompt API (prompt_hidden) : cela écrirait le
        prompt comme s'il s'agissait du workflow (perte de données).
        """
        workflow_data = None
        if extra_pnginfo and isinstance(extra_pnginfo, dict):
            workflow_data = extra_pnginfo.get('workflow')
        if not workflow_data:
            return ""
        try:
            return json.dumps(workflow_data, indent=2)
        except Exception as e:
            return json.dumps({"error": f"Failed to serialize workflow: {e}"})

    def _save_metadata(self, output_path, base_name, prompt, save_prompt, save_workflow, prompt_hidden, extra_pnginfo):
        workflow_json = ""

        # Save Prompt
        if save_prompt and prompt:
            prompt_path = os.path.join(output_path, f"{base_name}.txt")
            try:
                with open(prompt_path, 'w', encoding='utf-8') as f:
                    f.write(prompt)
            except Exception as e:
                logger.error(f"Error saving prompt: {e}")

        # Save Workflow
        # Only use the actual workflow graph from extra_pnginfo.
        # Never fall back to prompt_hidden (which is the API prompt, not the
        # UI workflow) — that would silently write the prompt as if it were
        # the workflow and cause data loss for the user.
        workflow_json = self._build_workflow_json(extra_pnginfo)
        if not workflow_json and save_workflow:
            logger.warning("Workflow not available in extra_pnginfo; skipping workflow JSON save.")

        if save_workflow and workflow_json:
            workflow_path = os.path.join(output_path, f"{base_name}.json")
            try:
                with open(workflow_path, 'w', encoding='utf-8') as f:
                    f.write(workflow_json)
            except Exception as e:
                logger.error(f"Error saving workflow: {e}")

        return workflow_json

    # ── Server mode (sauvegarde sur le backend AIH) ──────────────────────

    def _unique_temp_name(self, directory, base_name, ext):
        """Retourne (filepath, filename) unique dans ``directory``."""
        counter = 1
        name = f"{base_name}{ext}"
        path = os.path.join(directory, name)
        while os.path.exists(path):
            name = f"{base_name}_{counter:04d}{ext}"
            path = os.path.join(directory, name)
            counter += 1
        return path, name

    def _make_preview_entry(self, src_path, base_name, ext, ts):
        """Copie le média produit dans le dossier temp ComfyUI pour la vignette.

        Le node est un OUTPUT_NODE : le résultat UI pointe vers un fichier de
        type ``temp`` pour que la vignette native s'affiche sans être comptée
        comme une sauvegarde locale. Échec best-effort (log warning, pas de
        rupture : le média est déjà sauvegardé sur le serveur).
        """
        if not src_path or not os.path.isfile(src_path):
            return None
        try:
            temp_root = folder_paths.get_temp_directory()
            os.makedirs(temp_root, exist_ok=True)
            preview_path, preview_name = self._unique_temp_name(temp_root, f"aih_srv_{base_name}", ext)
            shutil.copy2(src_path, preview_path)
            return {"filename": preview_name, "subfolder": "", "type": "temp"}
        except Exception as e:
            logger.warning(f"{ts()} Preview copy failed: {e}")
            return None

    def _upload_media_file(self, temp_path, formatted_subfolder, filename_base, ext,
                           kind, prompt_meta, workflow_meta, ts):
        """Upload chunké d'un média vers le serveur (ÉCHEC DUR).

        Lève :class:`aih.media_upload.MediaUploadError` si le serveur n'est pas
        configuré/injoignable ou refuse l'upload : le node passe en erreur, sans
        aucun repli local.
        """
        t0 = time.time()
        result = media_upload.upload_media(
            temp_path,
            subfolder=formatted_subfolder,
            filename_base=filename_base,
            ext=ext,
            kind=kind,
            prompt=prompt_meta,
            workflow=workflow_meta,
        )
        logger.info(f"{ts()} Server upload OK ({kind}): {result.get('path')} in {time.time()-t0:.2f}s")
        return result

    def _cleanup_staged(self, path):
        """Supprime un fichier de staging après upload (best-effort)."""
        if path and os.path.isfile(path):
            try:
                os.unlink(path)
            except OSError:
                pass

    def _write_audio_to_stream(self, container, audio_stream, audio_np, sample_rate):
        """Safely writes a numpy audio array to a PyAV stream."""
        channels, samples = audio_np.shape
        layout = 'stereo' if channels == 2 else 'mono'

        frame = av.AudioFrame.from_ndarray(audio_np, format='fltp', layout=layout)
        frame.sample_rate = sample_rate
        frame.pts = None # PyAV computes PTS automatically when None

        resampler = av.AudioResampler(
            format=audio_stream.format,
            layout=audio_stream.layout,
            rate=audio_stream.rate
        )

        fifo = av.AudioFifo()

        for resampled_frame in resampler.resample(frame):
            fifo.write(resampled_frame)
        for resampled_frame in resampler.resample(None): # Flush
            fifo.write(resampled_frame)

        frame_size = audio_stream.frame_size or 1024

        while fifo.samples >= frame_size:
            out_frame = fifo.read(frame_size)
            out_frame.pts = None
            for packet in audio_stream.encode(out_frame):
                container.mux(packet)

        if fifo.samples > 0:
            out_frame = fifo.read(fifo.samples)
            out_frame.pts = None
            for packet in audio_stream.encode(out_frame):
                container.mux(packet)

        # Flush encoder
        for packet in audio_stream.encode(None):
            container.mux(packet)

    @staticmethod
    def _detect_temp_dir():
        """Auto-detect the best temporary directory for encoding.
        Priority: /dev/shm (RAM disk) > system temp directory."""
        shm = "/dev/shm"
        if os.path.isdir(shm) and os.access(shm, os.W_OK):
            return shm
        return tempfile.gettempdir()

    @staticmethod
    def _validate_temp_dir(temp_dir):
        """Ensure user-supplied temp_dir stays within an allowed safe directory.
        Allowed bases: ComfyUI temp directory, system temp directory, /dev/shm.
        Returns the validated temp_dir, or None if it is outside allowed areas."""
        allowed_bases = []
        try:
            allowed_bases.append(os.path.abspath(folder_paths.get_temp_directory()))
        except Exception:
            pass
        allowed_bases.append(os.path.abspath(tempfile.gettempdir()))
        allowed_bases.append(os.path.abspath("/dev/shm"))

        abs_dir = os.path.abspath(os.path.expanduser(temp_dir))
        for allowed in allowed_bases:
            if abs_dir == allowed or abs_dir.startswith(allowed + os.sep):
                return temp_dir
        return None

    @staticmethod
    def _is_codec_available(codec_name):
        """Check if a codec is available in PyAV/FFmpeg."""
        try:
            av.codec.Codec(codec_name, 'w')
            return True
        except ValueError:
            return False

    def _resolve_video_codec(self, container, codec_opt):
        """Resolve a user-friendly codec option to an internal FFmpeg codec name.
        Handles NVENC fallback gracefully."""
        if container == "gif":
            return "gif"

        if codec_opt in ("h264_nvenc", "hevc_nvenc"):
            if container != "mp4":
                logger.warning(f"NVENC only works with MP4 container, falling back to auto for {container}.")
                return self._resolve_video_codec(container, "auto")
            if self._is_codec_available(codec_opt):
                return codec_opt
            fallback = "libx264" if codec_opt == "h264_nvenc" else "libx265"
            logger.warning(f"{codec_opt} not available in PyAV, falling back to {fallback}.")
            return fallback

        if container == "mp4":
            if codec_opt in ("auto", "h264"):
                return "libx264"
            elif codec_opt == "h265":
                return "libx265"
            return "libx264"
        elif container == "webm":
            if codec_opt in ("auto", "vp9"):
                return "libvpx-vp9"
            elif codec_opt == "av1":
                return "libaom-av1"
            return "libvpx-vp9"
        return "libx264"

    def save_media(self, mode, **kwargs):
        t_total_start = time.time()

        def ts():
            """Return elapsed time since save started, formatted as [+X.XXs]."""
            return f"[+{time.time()-t_total_start:.2f}s]"

        # 1. Parse Common Arguments
        base_path_raw = kwargs.get("base_path", folder_paths.get_output_directory())
        base_path = self._validate_output_path(base_path_raw)
        subfolder = kwargs.get("subfolder", "%Y-%m-%d")
        filename = kwargs.get("filename", "%Y-%m-%d-%Hh%Mm%Ss")
        save_prompt = kwargs.get("save_prompt", True)
        save_workflow = kwargs.get("save_workflow", True)
        save_to_server = bool(kwargs.get("save_to_server", False))
        temp_dir_setting = kwargs.get("temp_dir", "")

        prompt = kwargs.get("prompt", "")
        prompt_hidden = kwargs.get("prompt_hidden", None)
        extra_pnginfo = kwargs.get("extra_pnginfo", None)

        image_tensor = kwargs.get("image", None)
        audio_data = kwargs.get("audio", None)

        # 2. Prepare Path
        now = datetime.datetime.now()
        try:
            formatted_subfolder = now.strftime(subfolder)
        except Exception:
            formatted_subfolder = now.strftime('%Y-%m-%d')
        if save_to_server:
            # base_path est ignoré : le sous-dossier part tel quel vers le
            # serveur (sanitizé ici, re-sanitizé côté backend).
            formatted_subfolder = media_upload.sanitize_subfolder(formatted_subfolder)
        else:
            formatted_subfolder = self._validate_subfolder(base_path, formatted_subfolder)
        try:
            formatted_filename_base = now.strftime(filename)
        except Exception:
            formatted_filename_base = now.strftime('%Y-%m-%d-%Hh%Mm%Ss')
        # Security: sanitize the formatted base filename so it cannot contain
        # path separators or '..' components (path-traversal protection).
        formatted_filename_base = self._sanitize_base_filename(formatted_filename_base)

        # Resolve temp directory for fast encoding
        if temp_dir_setting and temp_dir_setting.strip():
            temp_dir = temp_dir_setting.strip()
            # Security: restrict user-supplied temp_dir to allowed safe directories
            validated = self._validate_temp_dir(temp_dir)
            if validated is None:
                logger.warning(f"{ts()} temp_dir '{temp_dir}' resolves outside allowed directories; ignoring and auto-detecting.")
                temp_dir = self._detect_temp_dir()
            elif not (os.path.isdir(temp_dir) and os.access(temp_dir, os.W_OK)):
                logger.warning(f"{ts()} temp_dir '{temp_dir}' not writable, auto-detecting.")
                temp_dir = self._detect_temp_dir()
        else:
            temp_dir = self._detect_temp_dir()

        if save_to_server:
            # Staging serveur : le média est encodé dans un dossier temporaire,
            # uploadé, puis supprimé. Aucune écriture dans le dossier de sortie
            # (base_path totalement ignoré) — aucune sauvegarde locale.
            output_path = temp_dir
        else:
            output_path = os.path.join(base_path, formatted_subfolder)
            os.makedirs(output_path, exist_ok=True)
        logger.info(f"{ts()} Mode: {mode} | Temp: {temp_dir} | Output: {output_path}")

        # Métadonnées serveur (prompt + workflow), envoyées avec le média.
        prompt_meta = ""
        workflow_meta = ""
        if save_to_server:
            prompt_meta = prompt if save_prompt else ""
            workflow_meta = self._build_workflow_json(extra_pnginfo) if save_workflow else ""

        # 3. ROUTING LOGIC
        if mode == "image":
            if image_tensor is None:
                logger.warning(f"{ts()} Warning: Mode is 'image' but no image provided.")
                image_tensor = torch.zeros((1, 8, 8, 3))
                return {"ui": {"text": ["No image provided"]}, "result": (image_tensor, audio_data, "", "", "")}

            t0 = time.time()
            img_format = kwargs.get("image_format", "png")
            # Normalise legacy "jpeg" to "jpg" so old workflows still work
            if img_format == "jpeg":
                img_format = "jpg"
            ext = f".{img_format}"
            img_cpu = image_tensor.cpu()
            img_array = img_cpu.float().mul(255).clamp(0, 255).byte().numpy()
            logger.info(f"{ts()} Tensor→numpy: {time.time()-t0:.2f}s")

            results = []
            workflow_json = ""
            final_path = ""

            total = img_array.shape[0]
            for i in range(total):
                t_img = time.time()
                file_path, final_filename, base_name = self._prepare_output_paths(output_path, formatted_filename_base, ext)

                img = Image.fromarray(img_array[i])
                try:
                    if img_format == "png":
                        img.save(file_path, compress_level=kwargs.get("image_compression", 4))
                    else:
                        img.save(file_path, quality=kwargs.get("image_quality", 90))

                    if save_to_server:
                        # ÉCHEC DUR : toute exception (save ou upload) remonte.
                        server_result = self._upload_media_file(
                            file_path, formatted_subfolder, base_name, ext,
                            "image", prompt_meta, workflow_meta, ts)
                        final_path = server_result.get("path", "")
                        entry = self._make_preview_entry(file_path, base_name, ext, ts)
                        if entry:
                            results.append(entry)
                        self._cleanup_staged(file_path)
                    else:
                        # Only update final_path after a successful save so we
                        # never return a path to a file that doesn't exist (A14).
                        final_path = file_path
                        results.append({"filename": final_filename, "subfolder": formatted_subfolder, "type": self.type})
                except Exception as e:
                    if save_to_server:
                        # Échec dur : on nettoie le staging avant de propager.
                        self._cleanup_staged(file_path)
                        raise
                    logger.error(f"{ts()} Error saving image {i}: {e}")

                if i == 0:
                    if save_to_server:
                        workflow_json = workflow_meta
                    else:
                        workflow_json = self._save_metadata(output_path, base_name, prompt, save_prompt, save_workflow, prompt_hidden, extra_pnginfo)

                if total <= 10 or (i + 1) % 10 == 0:
                    logger.info(f"{ts()} Image {i+1}/{total} saved in {time.time()-t_img:.2f}s")

            t_total = time.time() - t_total_start
            logger.info(f"{ts()} ═══ IMAGE DONE ═══ {t_total:.2f}s total | {total} images")
            return {"ui": {"images": results}, "result": (image_tensor, audio_data, final_path, prompt, workflow_json)}


        elif mode == "video":
            if image_tensor is None:
                logger.warning(f"{ts()} Warning: Mode is 'video' but no image provided.")
                image_tensor = torch.zeros((1, 8, 8, 3))
                return {"ui": {"text": ["No image provided"]}, "result": (image_tensor, audio_data, "", "", "")}

            v_container = kwargs.get("video_container", "mp4")
            v_codec_opt = kwargs.get("video_codec", "auto")
            v_fps = kwargs.get("video_fps", 24)
            v_quality = kwargs.get("video_quality", 23)

            # Resolve codec (with NVENC support)
            v_codec = self._resolve_video_codec(v_container, v_codec_opt)
            is_nvenc = v_codec in ("h264_nvenc", "hevc_nvenc")
            enc_type = "GPU" if is_nvenc else "CPU"
            logger.info(f"{ts()} Codec: {v_codec} ({enc_type}) | {v_container} | {v_fps}fps | quality={v_quality}")

            ext = f".{v_container}"

            # Convert tensor using PyTorch CPU (SIMD-optimized) instead of numpy float16 (scalar-only)
            t0 = time.time()
            img_cpu = image_tensor.cpu()
            logger.info(f"{ts()} .cpu() transfer: {time.time()-t0:.3f}s")
            t0 = time.time()
            img_array = img_cpu.float().mul(255).clamp(0, 255).byte().numpy()
            batch_size, height, width, channels = img_array.shape
            logger.info(f"{ts()} torch→numpy: {time.time()-t0:.3f}s | {batch_size} frames, {width}x{height}")

            input_pixel_format = 'rgba' if channels == 4 else 'gray' if channels == 1 else 'rgb24'

            # --- CREATE TEMP FILE ---
            temp_video_path = None
            video_path = None
            try:
                temp_video_path, video_path, final_video_filename, base_name = self._create_temp_file(
                    temp_dir, ext, 'holaf_video_', output_path, formatted_filename_base, ts, log_temp_dir=True)
                if temp_video_path != video_path:
                    logger.info(f"{ts()} Temp file: {temp_video_path}")

                # --- OPEN CONTAINER ---
                t0 = time.time()
                try:
                    container = av.open(temp_video_path, mode='w')
                except Exception as e:
                    if is_nvenc:
                        logger.warning(f"{ts()} NVENC open FAILED: {e}. Fallback to CPU.")
                        v_codec = "libx264" if v_container == "mp4" else "libvpx-vp9"
                        is_nvenc = False
                        enc_type = "CPU"
                    else:
                        v_codec = 'libx264' if v_container == 'mp4' else 'libvpx-vp9'
                    container = av.open(temp_video_path, mode='w')
                logger.info(f"{ts()} Container opened ({v_codec}) in {time.time()-t0:.2f}s")

                # --- SETUP STREAMS ---
                t0 = time.time()
                v_stream = container.add_stream(v_codec, rate=v_fps)
                v_stream.width = width
                v_stream.height = height

                if v_codec == 'gif':
                    v_stream.pix_fmt = 'rgb24'
                else:
                    v_stream.pix_fmt = 'yuv420p'
                    if is_nvenc:
                        # NVENC 'cq' valid range is 0–51; clamp to avoid encode errors
                        v_stream.options = {'preset': 'p4', 'cq': str(min(v_quality, 51))}
                    else:
                        v_stream.options = {'crf': str(v_quality)}

                a_stream = None
                audio_np_truncated = None
                sample_rate = 44100

                if audio_data is not None and v_codec != 'gif':
                    audio_tensor = audio_data.get("waveform")
                    if audio_tensor is not None and audio_tensor.dim() >= 3:
                        sample_rate = audio_data.get("sample_rate", 44100)
                        audio_np_truncated = audio_tensor[0].cpu().numpy().astype(np.float32)

                        if audio_np_truncated.size > 0:
                            video_duration_sec = batch_size / v_fps
                            max_samples = int(video_duration_sec * sample_rate)
                            if audio_np_truncated.shape[1] > max_samples:
                                audio_np_truncated = audio_np_truncated[:, :max_samples]

                            a_codec = 'aac' if v_container == 'mp4' else 'libopus'
                            a_stream = container.add_stream(a_codec, rate=sample_rate)
                            a_bitrate = kwargs.get("audio_bitrate_kbps", 192) * 1000
                            a_stream.bit_rate = a_bitrate
                logger.info(f"{ts()} Streams setup: {time.time()-t0:.2f}s | audio={'yes' if a_stream else 'no'}")

                # --- WRITE VIDEO FRAMES ---
                t0 = time.time()
                t_last_report = t0
                for i in range(batch_size):
                    frame_data = img_array[i]
                    frame = av.VideoFrame.from_ndarray(frame_data, format=input_pixel_format)
                    for packet in v_stream.encode(frame):
                        container.mux(packet)

                    # Report timing every 10 frames
                    if (i + 1) % 10 == 0 or i == batch_size - 1:
                        now2 = time.time()
                        elapsed_segment = now2 - t_last_report
                        fps_segment = 10.0 / elapsed_segment if elapsed_segment > 0 else 0
                        logger.info(f"{ts()} Frames {max(1,i-8)}-{i+1}/{batch_size} | {elapsed_segment:.2f}s for 10 frames ({fps_segment:.1f} fps)")
                        t_last_report = now2

                for packet in v_stream.encode():
                    container.mux(packet)
                t_encode = time.time() - t0
                logger.info(f"{ts()} VIDEO ENCODE DONE: {t_encode:.2f}s total | avg {batch_size/t_encode:.1f} fps")

                # --- WRITE AUDIO ---
                if a_stream is not None and audio_np_truncated is not None:
                    t0 = time.time()
                    self._write_audio_to_stream(container, a_stream, audio_np_truncated, sample_rate)
                    logger.info(f"{ts()} Audio encode: {time.time()-t0:.2f}s")

                # --- CLOSE ---
                t0 = time.time()
                container.close()
                logger.info(f"{ts()} Container close: {time.time()-t0:.2f}s")

                # --- MOVE FROM TEMP TO FINAL ---
                self._safe_move(temp_video_path, video_path, ts)

                if save_to_server:
                    # ÉCHEC DUR : l'upload remonte toute erreur (pas de repli local).
                    server_result = self._upload_media_file(
                        video_path, formatted_subfolder, base_name, ext,
                        "video", prompt_meta, workflow_meta, ts)
                    final_output_path = server_result.get("path", "")
                    entry = self._make_preview_entry(video_path, base_name, ext, ts)
                    results = [entry] if entry else []
                    workflow_json = workflow_meta
                else:
                    # --- SAVE METADATA ---
                    t0 = time.time()
                    workflow_json = self._save_metadata(output_path, base_name, prompt, save_prompt, save_workflow, prompt_hidden, extra_pnginfo)
                    logger.info(f"{ts()} Metadata saved: {time.time()-t0:.2f}s")
                    final_output_path = video_path
                    results = [{"filename": final_video_filename, "subfolder": formatted_subfolder, "type": self.type}]

                t_total = time.time() - t_total_start
                logger.info(f"{ts()} ═══ VIDEO DONE ═══ {t_total:.2f}s total | {final_video_filename}")
                ui_key = "gifs" if v_container == "gif" else "videos"
            finally:
                self._cleanup_temp(temp_video_path, video_path)
                if save_to_server:
                    # Supprime le staging après upload + aperçu (ou en cas d'échec).
                    self._cleanup_staged(video_path)
            return {"ui": {ui_key: results}, "result": (image_tensor, audio_data, final_output_path, prompt, workflow_json)}


        elif mode == "audio":
            if audio_data is None:
                logger.warning(f"{ts()} Warning: Mode is 'audio' but no audio provided.")
                return {"ui": {"text": ["No audio provided"]}, "result": (image_tensor, audio_data, "", "", "")}

            a_format = kwargs.get("audio_format", "wav")
            ext = f".{a_format}"

            audio_tensor = audio_data.get("waveform")
            sample_rate = audio_data.get("sample_rate", 44100)

            t0 = time.time()
            if audio_tensor is not None and audio_tensor.dim() >= 3:
                audio_np = audio_tensor[0].cpu().numpy().astype(np.float32)
            else:
                audio_np = None
            logger.info(f"{ts()} Tensor→numpy: {time.time()-t0:.2f}s")

            temp_audio_path = None
            audio_path = None
            final_audio_filename = ""
            base_name = ""
            workflow_json = ""

            if audio_np is not None and audio_np.size > 0:
                try:
                    temp_audio_path, audio_path, final_audio_filename, base_name = self._create_temp_file(
                        temp_dir, ext, 'holaf_audio_', output_path, formatted_filename_base, ts, log_temp_dir=False)

                    t0 = time.time()
                    container = av.open(temp_audio_path, mode='w')
                    
                    if a_format == "wav":
                        a_codec = "pcm_s16le"
                    elif a_format == "mp3":
                        a_codec = "libmp3lame"
                    else:
                        a_codec = "flac"
                        
                    a_stream = container.add_stream(a_codec, rate=sample_rate)
                    
                    if a_format != "wav":
                        a_stream.bit_rate = kwargs.get("audio_bitrate_kbps", 192) * 1000

                    self._write_audio_to_stream(container, a_stream, audio_np, sample_rate)
                    container.close()
                    logger.info(f"{ts()} Audio encode: {time.time()-t0:.2f}s")

                    self._safe_move(temp_audio_path, audio_path, ts)
                finally:
                    self._cleanup_temp(temp_audio_path, audio_path)
            else:
                audio_path = ""
                final_audio_filename = ""
                base_name = ""

            # Le staging (audio_path) est uploadé puis supprimé en mode serveur.
            final_output_path = audio_path or ""
            results = []
            if save_to_server:
                if audio_path and os.path.isfile(audio_path):
                    try:
                        # ÉCHEC DUR : l'upload remonte toute erreur (pas de repli local).
                        server_result = self._upload_media_file(
                            audio_path, formatted_subfolder, base_name, ext,
                            "audio", prompt_meta, workflow_meta, ts)
                        final_output_path = server_result.get("path", "")
                        entry = self._make_preview_entry(audio_path, base_name, ext, ts)
                        if entry:
                            results.append(entry)
                    finally:
                        # Supprime le staging après succès ou échec.
                        self._cleanup_staged(audio_path)
                workflow_json = workflow_meta
            else:
                t0 = time.time()
                workflow_json = self._save_metadata(output_path, base_name, prompt, save_prompt, save_workflow, prompt_hidden, extra_pnginfo)
                logger.info(f"{ts()} Metadata saved: {time.time()-t0:.2f}s")
                results = [{"filename": final_audio_filename, "subfolder": formatted_subfolder, "type": self.type}]

            t_total = time.time() - t_total_start
            logger.info(f"{ts()} ═══ AUDIO DONE ═══ {t_total:.2f}s total | {final_audio_filename}")
            return {"ui": {"audios": results}, "result": (image_tensor, audio_data, final_output_path, prompt, workflow_json)}

        logger.info(f"{ts()} ═══ NOTHING SAVED ═══ {time.time()-t_total_start:.2f}s total")
        return {"ui": {}, "result": (image_tensor, audio_data, "", "", "")}

# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical keys
# follow the AIH naming convention (AIH<PascalCase>, no Node suffix);
# legacy pre-fusion keys stay as aliases pointing to the SAME class so
# existing workflows keep loading. Legacy aliases are never purged.
NODE_CLASS_MAPPINGS = {
    "AIHSaveMedia": HolafSaveMedia,
    # Legacy alias - never purge.
    "HolafSaveMedia": HolafSaveMedia,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHSaveMedia": "AIH Save Media",
    "HolafSaveMedia": "AIH Save Media",
}
