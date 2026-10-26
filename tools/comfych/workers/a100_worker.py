"""A100-80GB GPU worker — hérite de ``ComfyWorker`` avec un GPU A100-80GB et un scaledown de 60s."""

from __future__ import annotations

from .base_worker import ComfyWorker


class A100Worker(ComfyWorker):
    """Worker spécialisé pour GPU A100-80GB (NVIDIA Ampere)."""

    gpu_type: str = "A100-80GB"
    scaledown_window: int = 60
