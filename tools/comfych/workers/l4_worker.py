"""L4 GPU worker — hérite de ``ComfyWorker`` avec un GPU L4 et un scaledown de 30s."""

from __future__ import annotations

from .base_worker import ComfyWorker


class L4Worker(ComfyWorker):
    """Worker spécialisé pour GPU L4 (NVIDIA Ada Lovelace)."""

    gpu_type: str = "L4"
    scaledown_window: int = 30
