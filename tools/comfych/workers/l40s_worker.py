"""L40S GPU worker — hérite de ``ComfyWorker`` avec un GPU L40S et un scaledown de 30s."""

from __future__ import annotations

from .base_worker import ComfyWorker


class L40SWorker(ComfyWorker):
    """Worker spécialisé pour GPU L40S (NVIDIA Ada Lovelace)."""

    gpu_type: str = "L40S"
    scaledown_window: int = 30
