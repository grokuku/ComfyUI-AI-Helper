"""H100 GPU worker — hérite de ``ComfyWorker`` avec un GPU H100 et un scaledown de 60s."""

from __future__ import annotations

from .base_worker import ComfyWorker


class H100Worker(ComfyWorker):
    """Worker spécialisé pour GPU H100 (NVIDIA Hopper)."""

    gpu_type: str = "H100"
    scaledown_window: int = 60
