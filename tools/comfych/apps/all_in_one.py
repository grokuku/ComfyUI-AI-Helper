"""
Modal Gateway — Single App with 4 GPU workers + public router.

Deploy::

    modal deploy apps/all_in_one.py

Replace l'ancienne commande ``modal deploy comfyui.py``.

Le routeur FastAPI (routes, idempotence, auth) est défini dans
``gateway_router.py`` — seul le mapping GPU -> worker change ici.
"""

from __future__ import annotations

import modal

import auth
from gateway_router import build_router
from image import image
from workers.base_worker import COMFY_LOG_PATH, read_log_tail
from workers.l4_worker import L4Worker
from workers.l40s_worker import L40SWorker
from workers.a100_worker import A100Worker
from workers.h100_worker import H100Worker

app = modal.App(
    name="modal-comfy-gateway",
    image=image,
    secrets=auth.get_modal_secrets(),
)

# ─── Volumes partagés ───

MODELS_VOLUME = modal.Volume.from_name("comfy-models", create_if_missing=True)
"""Volume des modèles — porte aussi le log ComfyUI (``/cache/logs/comfyui.log``).

Le même volume est monté par les workers GPU **et** par la fonction CPU
``read_worker_logs`` : c'est ce qui permet de lire les logs sans réveiller
de GPU.
"""

VOLUMES = {
    "/cache": MODELS_VOLUME,
    "/user-settings": modal.Volume.from_name("comfy-user-settings", create_if_missing=True),
    "/custom_nodes": modal.Volume.from_name("comfy-custom-nodes", create_if_missing=True),
}
"""Montages communs aux workers (``/cache`` = modèles + logs persistés)."""


# ─── Déclaration des 4 workers comme classes Modal ───


@app.cls(
    gpu=L4Worker.gpu_type,
    volumes=dict(VOLUMES),
    scaledown_window=L4Worker.scaledown_window,
    # Snapshot mémoire : il fige le process ComfyUI lancé par start_checkpoint.
    # Un snapshot GPU peut survivre à un redéploiement et servir l'ANCIEN code :
    # il est donc invalidé par l'empreinte WORKER_BUILD_ID (workers/base_worker.py),
    # qui force start_restore à tuer le process restauré et à relancer ComfyUI.
    # En cas de comportement étrange, désactiver enable_memory_snapshot /
    # experimental_options est le premier levier (ComfyUI redémarre alors à froid).
    enable_memory_snapshot=True,
    experimental_options={"enable_gpu_snapshot": True},
)
class L4(L4Worker):
    pass


@app.cls(
    gpu=L40SWorker.gpu_type,
    volumes=dict(VOLUMES),
    scaledown_window=L40SWorker.scaledown_window,
    # Snapshot mémoire : il fige le process ComfyUI lancé par start_checkpoint.
    # Un snapshot GPU peut survivre à un redéploiement et servir l'ANCIEN code :
    # il est donc invalidé par l'empreinte WORKER_BUILD_ID (workers/base_worker.py),
    # qui force start_restore à tuer le process restauré et à relancer ComfyUI.
    # En cas de comportement étrange, désactiver enable_memory_snapshot /
    # experimental_options est le premier levier (ComfyUI redémarre alors à froid).
    enable_memory_snapshot=True,
    experimental_options={"enable_gpu_snapshot": True},
)
class L40S(L40SWorker):
    pass


@app.cls(
    gpu=A100Worker.gpu_type,
    volumes=dict(VOLUMES),
    scaledown_window=A100Worker.scaledown_window,
    # Snapshot mémoire : il fige le process ComfyUI lancé par start_checkpoint.
    # Un snapshot GPU peut survivre à un redéploiement et servir l'ANCIEN code :
    # il est donc invalidé par l'empreinte WORKER_BUILD_ID (workers/base_worker.py),
    # qui force start_restore à tuer le process restauré et à relancer ComfyUI.
    # En cas de comportement étrange, désactiver enable_memory_snapshot /
    # experimental_options est le premier levier (ComfyUI redémarre alors à froid).
    enable_memory_snapshot=True,
    experimental_options={"enable_gpu_snapshot": True},
)
class A100(A100Worker):
    pass


@app.cls(
    gpu=H100Worker.gpu_type,
    volumes=dict(VOLUMES),
    scaledown_window=H100Worker.scaledown_window,
    # Snapshot mémoire : il fige le process ComfyUI lancé par start_checkpoint.
    # Un snapshot GPU peut survivre à un redéploiement et servir l'ANCIEN code :
    # il est donc invalidé par l'empreinte WORKER_BUILD_ID (workers/base_worker.py),
    # qui force start_restore à tuer le process restauré et à relancer ComfyUI.
    # En cas de comportement étrange, désactiver enable_memory_snapshot /
    # experimental_options est le premier levier (ComfyUI redémarre alors à froid).
    enable_memory_snapshot=True,
    experimental_options={"enable_gpu_snapshot": True},
)
class H100(H100Worker):
    pass


# ─── Lecture des logs sans GPU ───


@app.function(
    volumes={"/cache": MODELS_VOLUME},
    cpu=1,
    memory=512,
    timeout=60,
)
def read_worker_logs(lines: int = 200) -> dict:
    """Lit les dernières lignes du log ComfyUI persistant sur le volume.

    Fonction CPU volontairement séparée : consulter les logs ne doit PAS
    réveiller un container GPU (cold start 1-3 min, alors que le timeout
    côté extension est de 60 s). Le log est écrit par ``ComfyWorker`` dans
    ``COMFY_LOG_PATH`` (``/cache/logs/comfyui.log``) ; ce container-ci se
    contente de le lire après un ``reload()`` du volume.

    Le retour de ``read_log_tail`` est renvoyé tel quel : il porte
    ``mtime``/``age_seconds``, qui permettent au client de voir que le
    log est périmé (aucun container n'a redémarré depuis le déploiement).
    """
    try:
        MODELS_VOLUME.reload()  # rend visibles les écritures des autres containers
    except Exception:  # noqa: BLE001 — reload best effort (volume non monté)
        pass

    result = read_log_tail(COMFY_LOG_PATH, lines)
    if result.get("error") == "log file not found":
        result["error"] = "log file not found — le worker n'a pas encore démarré"
    return result


# ─── Routeur FastAPI public ───

WORKER_MAP = {
    "L4": L4,
    "L40S": L40S,
    "A100": A100,
    "H100": H100,
}

web_app = build_router(
    worker_map=WORKER_MAP,
    cors_origins=["*"],
    title="Modal ComfyUI Gateway",
    logs_reader=read_worker_logs,
)


# Point d'entrée Modal — expose le routeur FastAPI
@app.function()
@modal.concurrent(max_inputs=20)
@modal.asgi_app(label="gateway")
def gateway():
    return web_app
