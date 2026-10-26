"""ComfyUI worker variants for Modal.

Each worker runs ComfyUI headless and exposes its REST API via
``@modal.web_endpoint``.  The base class in ``base_worker.py`` provides
common lifecycle management (startup, GPU snapshot, cleanup) and proxy
endpoints for the ComfyUI API.

Workers disponibles
-------------------
- ``L4Worker``      — GPU L4 (Ada Lovelace), scaledown 30s
- ``L40SWorker``    — GPU L40S (Ada Lovelace), scaledown 30s
- ``A100Worker``    — GPU A100-80GB (Ampere), scaledown 60s
- ``H100Worker``    — GPU H100 (Hopper), scaledown 60s
"""

from .base_worker import ComfyWorker
from .l4_worker import L4Worker
from .l40s_worker import L40SWorker
from .a100_worker import A100Worker
from .h100_worker import H100Worker

__all__ = [
    "ComfyWorker",
    "L4Worker",
    "L40SWorker",
    "A100Worker",
    "H100Worker",
]
