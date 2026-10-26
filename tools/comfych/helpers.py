"""Shared helpers for model download and secret resolution.

Extracted from ``comfyui.py`` so that CPU-only sync scripts can reuse the
same logic without pulling in GPU dependencies.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import modal

COMFY_MODELS_ROOT = Path("/root/comfy/ComfyUI/models")


# ── path resolution ──────────────────────────────────────────────────────


def resolve_model_dir(model_dir: str) -> Path:
    """Resolve *model_dir* to an absolute :class:`Path`.

    Absolute paths are used as-is.  Relative paths are placed under
    ``/root/comfy/ComfyUI/models/`` — e.g. ``"checkpoints"`` becomes
    ``/root/comfy/ComfyUI/models/checkpoints``.
    """
    p = Path(model_dir)
    return p if p.is_absolute() else COMFY_MODELS_ROOT / p


# ── model downloads ──────────────────────────────────────────────────────


def hf_download(
    repo_id: str,
    filename: str,
    model_dir: str = "checkpoints",
):
    """Download a single model file from Hugging Face Hub via ``hf_hub_download``.

    The file is cached under ``/cache`` and symlinked into the resolved
    *model_dir*.
    """
    from huggingface_hub import hf_hub_download

    model = hf_hub_download(
        repo_id=repo_id,
        filename=filename,
        cache_dir="/cache",
        token=os.environ.get("HF_TOKEN"),
    )

    target_dir = resolve_model_dir(model_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    local_filename = Path(filename).name
    target_path = target_dir / local_filename
    if target_path.exists() or target_path.is_symlink():
        target_path.unlink()
    # Path-based symlink (no shell): *model* may contain spaces or quotes
    Path(target_path).symlink_to(model)
    print(f"Downloaded {repo_id}/{filename} to {target_path}")


def download_external_model(url: str, filename: str, model_dir: str):
    """Download an external model via ``aria2c`` and symlink it into *model_dir*.

    Requires ``aria2`` to be installed in the container.
    """
    cache_dir = "/cache"
    Path(cache_dir).mkdir(parents=True, exist_ok=True)

    cached_path = Path(cache_dir) / filename
    if not cached_path.exists():
        print(f"Downloading {filename} from {url}...")
        _ = subprocess.run(
            [
                "aria2c",
                "--console-log-level=error",
                "--summary-interval=0",
                "-x",
                "16",
                "-s",
                "16",
                "-o",
                filename,
                "-d",
                cache_dir,
                url,
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    target_dir = resolve_model_dir(model_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / filename

    if target_path.exists() or target_path.is_symlink():
        target_path.unlink()

    target_path.symlink_to(cached_path)
    print(f"Linked {filename} to {target_path}")


# ── secrets ──────────────────────────────────────────────────────────────


def get_hf_secrets() -> list[modal.Secret]:
    """Return a one-element list with the Hugging Face token Secret.

    Resolution order:
    1. Modal Secret ``huggingface-secret`` (preferred).
    2. ``HF_TOKEN`` environment variable (fallback).
    3. Empty token (public models still work, gated models will fail).

    When neither a Modal Secret nor a local env var is set a warning is
    printed to stderr.
    """
    try:
        s = modal.Secret.from_name("huggingface-secret")
        s.hydrate()  # from_name is lazy — force the existence check
        return [s]
    except modal.exception.NotFoundError:
        token = os.environ.get("HF_TOKEN", "")
        if not token:
            print(
                "Warning: no Modal Secret 'huggingface-secret' and no HF_TOKEN env. "
                "Public models will download with throttled bandwidth; "
                "gated models will fail."
            )
        return [modal.Secret.from_dict({"HF_TOKEN": token})]
