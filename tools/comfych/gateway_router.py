"""Routeur FastAPI partagé pour les apps Modal Gateway (all_in_one*, lite, l4).

Factorise le code de routage dupliqué entre ``apps/all_in_one*.py`` et ajoute
l'**idempotence** sur ``/generate`` :

- le client envoie un ``request_id`` dans le corps de la requête ;
- si un job avec ce ``request_id`` a déjà été exécuté, le routeur retourne le
  résultat **en cache** sans relancer le workflow (évite la double facturation
  quand un retry réseau renvoie la requête après que le job a terminé) ;
- si un job identique est **en cours**, le second appel attend le même job
  au lieu de le relancer.

Le cache est en mémoire (TTL 1h, max 10 entrées) — suffisant pour le cas
d'usage d'un gateway mono-utilisateur. Les clients sans ``request_id``
continuent de fonctionner (comportement d'origine).
"""

from __future__ import annotations

import asyncio
import base64
import time
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

import auth

# ─── Idempotence ────────────────────────────────────────────────────────────

_IDEMPOTENCY_TTL_SECONDS = 3600  # 1 heure
_IDEMPOTENCY_MAX_ENTRIES = 10

# Budget de polling du leader (secondes). Le résultat doit rester disponible
# pour les followers un peu plus longtemps que ce budget, le temps que le
# leader termine de récupérer les images (/view) et les sideloads.
_MAX_POLL_ATTEMPTS = 600  # 600 * 1s = 10 minutes
# Marge de 30 s au-dessus du poll, mais toujours sous le timeout navigateur
# (660 s) : le serveur peut ainsi répondre un 504 propre avant l'abandon client.
_FOLLOWER_WAIT_TIMEOUT_SECONDS = _MAX_POLL_ATTEMPTS + 30  # 630s

# Timeout côté navigateur (web/modal_gateway.js) : 660 000 ms (11 min).
# Le serveur doit rester en dessous pour pouvoir répondre une erreur propre
# (504) avant que le client n'abandonne la requête.

# request_id -> (timestamp, result)
_idempotency_cache: dict[str, tuple[float, dict]] = {}
# request_id -> {"event": asyncio.Event, "result": dict | None, "error": Response | None}
_idempotency_inflight: dict[str, dict] = {}
_idempotency_lock = asyncio.Lock()


def _idempotency_get(request_id: str) -> dict | None:
    entry = _idempotency_cache.get(request_id)
    if entry is None:
        return None
    ts, result = entry
    if time.time() - ts > _IDEMPOTENCY_TTL_SECONDS:
        _idempotency_cache.pop(request_id, None)
        return None
    return result


def _idempotency_put(request_id: str, result: dict) -> None:
    _idempotency_cache[request_id] = (time.time(), result)
    if len(_idempotency_cache) > _IDEMPOTENCY_MAX_ENTRIES:
        # Éviction FIFO : retirer l'entrée la plus ancienne
        oldest = min(_idempotency_cache, key=lambda k: _idempotency_cache[k][0])
        _idempotency_cache.pop(oldest, None)


def _idempotency_finish(request_id: str, entry: dict | None, result, error):
    """Clôture un job idempotent : met en cache, réveille les suiveurs, retourne.

    *result* est un dict (succès) ; *error* une Response (échec). Un seul des
    deux est non-None.
    """
    if request_id and entry is not None:
        if result is not None:
            _idempotency_put(request_id, result)
            entry["result"] = result
        elif error is not None:
            entry["error"] = error
        # set() sur un Event déjà levé est un no-op : l'appel reste idempotent.
        entry["event"].set()
        # Pop défensif : ne retirer que si l'entrée est toujours celle en vol
        # (un follower peut avoir nettoyé puis remplacé l'entrée après timeout).
        if _idempotency_inflight.get(request_id) is entry:
            _idempotency_inflight.pop(request_id, None)
    return result if result is not None else error


# ─── Modèle de requête ──────────────────────────────────────────────────────


class GenerateRequest(BaseModel):
    workflow: dict
    gpu: str = "L4"
    request_id: str = ""  # idempotence : même request_id → pas de double exécution


# ─── Métadonnées GPU ────────────────────────────────────────────────────────

GPU_INFO = {
    "L4": {"name": "NVIDIA L4", "vram": "24 GB", "price_per_hour": "$0.80"},
    "L40S": {"name": "NVIDIA L40S", "vram": "48 GB", "price_per_hour": "$1.95"},
    "A100": {"name": "NVIDIA A100 80GB", "vram": "80 GB", "price_per_hour": "$2.50"},
    "H100": {"name": "NVIDIA H100", "vram": "80 GB", "price_per_hour": "$3.95"},
}


def build_router(
    worker_map: dict[str, type],
    cors_origins: list[str],
    title: str,
    logs_reader=None,
) -> FastAPI:
    """Construit le routeur FastAPI public pour une app Modal Gateway.

    ``worker_map`` associe un nom de GPU (``"L4"``, ``"L40S"``…) à la classe
    Modal worker correspondante (``apps/all_in_one*.py``).

    ``logs_reader`` est la **fonction CPU** de l'app qui lit le log ComfyUI
    persisté sur le volume (``read_worker_logs``). Quand elle est fournie,
    ``GET /logs`` l'appelle au lieu de réveiller un container GPU : un cold
    start GPU dure 1 à 3 minutes, alors qu'un log doit s'afficher tout de
    suite. ``None`` conserve l'ancien chemin (``worker.logs_tail``, coûteux).
    """
    web_app = FastAPI(title=title)

    web_app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Dernier GPU utilisé par session (fallback pour upload/view/history)
    last_gpu: dict[str, str] = {}

    # ─── POST /generate ────────────────────────────────────────────────────

    @web_app.post("/generate", dependencies=[Depends(auth.require_api_key)])
    async def generate(req: GenerateRequest):
        """Dispatch un workflow vers le worker GPU, attend le résultat, et
        retourne les images générées en base64.

        Idempotent : si ``request_id`` est fourni et que le job est déjà
        terminé (cache) ou en cours, il n'est pas relancé.
        """
        worker_cls = worker_map.get(req.gpu)
        if not worker_cls:
            return JSONResponse(
                {
                    "error": f"GPU '{req.gpu}' not supported. Use: {list(worker_map.keys())}"
                },
                status_code=400,
            )
        # Stocke le GPU utilisé par défaut pour les appels suivants
        last_gpu["default"] = req.gpu

        request_id = (req.request_id or "").strip()

        # ── Idempotence : déjà terminé ? ──────────────────────────────────
        if request_id:
            cached = _idempotency_get(request_id)
            if cached is not None:
                print(f"[Gateway] Idempotence: réponse en cache pour {request_id} — pas de re-exécution")
                return cached

        # ── Idempotence : leader ou suiveur ? ─────────────────────────────
        entry = None
        is_leader = True
        if request_id:
            async with _idempotency_lock:
                entry = _idempotency_inflight.get(request_id)
                if entry is None:
                    entry = {"event": asyncio.Event(), "result": None, "error": None}
                    _idempotency_inflight[request_id] = entry
                else:
                    is_leader = False

            if not is_leader:
                # Un appel identique est déjà en cours → attendre sa conclusion.
                # Le wait est borné : si le leader meurt sans clôturer l'entrée
                # (déconnexion client, crash container, redéploiement), on ne
                # bloque pas les followers à vie et on nettoie l'entrée.
                print(f"[Gateway] Idempotence: job déjà en cours pour {request_id} — attente du résultat")
                try:
                    await asyncio.wait_for(
                        entry["event"].wait(),
                        timeout=_FOLLOWER_WAIT_TIMEOUT_SECONDS,
                    )
                except asyncio.TimeoutError:
                    print(
                        f"[Gateway] Idempotence: timeout en attente du leader pour {request_id} "
                        f"({_FOLLOWER_WAIT_TIMEOUT_SECONDS}s) — nettoyage de l'entrée"
                    )
                    async with _idempotency_lock:
                        if _idempotency_inflight.get(request_id) is entry:
                            _idempotency_inflight.pop(request_id, None)
                    entry["event"].set()  # libère d'éventuels autres followers
                    return JSONResponse(
                        {
                            "error": (
                                "Le job précédent n'a pas abouti "
                                "(timeout en attente du résultat)"
                            )
                        },
                        status_code=504,
                    )
                if entry["result"] is not None:
                    return entry["result"]
                if entry["error"] is not None:
                    return entry["error"]
                # Cas défensif : entrée clôturée sans résultat ni erreur.
                return JSONResponse(
                    {"error": "Le job précédent s'est terminé sans résultat"},
                    status_code=503,
                )

        try:
            # Instanciation dans le try : toute exception (ou annulation) est
            # capturée par les handlers ci-dessous et clôture l'entrée.
            worker = worker_cls()

            # ── 1. Envoyer le workflow et récupérer le prompt_id ──────────
            prompt_result = await worker.prompt.remote.aio(req.workflow)
            print(f"[Gateway] prompt_result = {prompt_result}")
            if prompt_result.get("error"):
                return _idempotency_finish(
                    request_id, entry, None,
                    JSONResponse({"error": prompt_result["error"]}, status_code=500),
                )
            prompt_id = prompt_result.get("prompt_id")
            print(f"[Gateway] prompt_id = {prompt_id}")
            if not prompt_id:
                return _idempotency_finish(
                    request_id, entry, None,
                    JSONResponse({"error": "No prompt_id returned by worker"}, status_code=500),
                )

            # ── 2. Poller l'historique jusqu'à complétion (timeout: 10 min) ──
            max_attempts = _MAX_POLL_ATTEMPTS  # 600 * 1s = 10 minutes
            outputs = None
            for attempt in range(max_attempts):
                await asyncio.sleep(1)
                try:
                    history = await worker.history.remote.aio(prompt_id)
                    print(f"[Gateway] attempt {attempt}: history keys = {list(history.keys()) if isinstance(history, dict) else type(history)}")
                    if isinstance(history, dict) and history.get("error"):
                        return _idempotency_finish(
                            request_id, entry, None,
                            JSONResponse({"error": history["error"]}, status_code=500),
                        )
                    if isinstance(history, dict) and prompt_id in history:
                        history_data = history[prompt_id]
                        outputs = history_data.get("outputs", {})
                        print(f"[Gateway] Found in history. outputs = {outputs}")
                        break
                except Exception:
                    # Le job n'est pas encore dans l'historique — on continue
                    pass
            else:
                return _idempotency_finish(
                    request_id, entry, None,
                    JSONResponse({"error": "Timeout waiting for generation to complete"}, status_code=504),
                )

            # ── 3. Récupérer les images de sortie via /view ──────────────
            images = []
            print(f"[Gateway] Processing outputs: {len(outputs)} nodes")
            for node_id, node_outputs in outputs.items():
                for output_key, output_data in node_outputs.items():
                    if isinstance(output_data, list):
                        for item in output_data:
                            if isinstance(item, dict) and "filename" in item:
                                filename = item["filename"]
                                subfolder = item.get("subfolder", "")
                                image_type = item.get("type", "output")
                                print(f"[Gateway] Found image: filename={filename}, subfolder={subfolder}, type={image_type}")
                                try:
                                    img_data = await worker.view.remote.aio(
                                        filename, subfolder, image_type
                                    )
                                    if img_data and img_data.get("error"):
                                        return _idempotency_finish(
                                            request_id, entry, None,
                                            JSONResponse({"error": img_data["error"]}, status_code=500),
                                        )
                                    print(f"[Gateway] img_data keys = {list(img_data.keys()) if isinstance(img_data, dict) else type(img_data)}")
                                    if img_data and "data" in img_data:
                                        images.append({
                                            "filename": filename,
                                            "subfolder": subfolder,
                                            "type": image_type,
                                            "data": img_data["data"],
                                        })
                                except Exception as e:
                                    print(
                                        f"[Modal Gateway] Error fetching image {filename}: {e}"
                                    )

            # ── 3b. Récupérer les fichiers sideload (.txt, .json) ──────
            sideload_exts = [".txt", ".json"]
            sideload_files = []
            for img in images:
                base_name = Path(img["filename"]).stem
                subfolder = img.get("subfolder", "")
                for ext in sideload_exts:
                    side_name = base_name + ext
                    try:
                        file_data = await worker.view.remote.aio(side_name, subfolder, "output")
                        if file_data and not file_data.get("error") and file_data.get("data"):
                            sideload_files.append({
                                "filename": side_name,
                                "subfolder": subfolder,
                                "type": "output",
                                "data": file_data["data"],
                                "content_type": file_data.get("content_type", "application/octet-stream"),
                                "is_sideload": True,
                            })
                            print(f"[Gateway] Sideload fetched: {side_name}")
                    except Exception:
                        pass  # File doesn't exist, skip silently

            images.extend(sideload_files)

            # ── 4. Retourner le résultat formaté pour l'extension JS ─────
            print(f"[Gateway] Total images collected: {len(images)}")
            print(f"[Gateway] Returning: {len(images)} images, job_id={prompt_id}")
            return _idempotency_finish(
                request_id, entry,
                {"images": images, "job_id": prompt_id, "gpu": req.gpu},
                None,
            )

        except asyncio.CancelledError:
            # Annulation (déconnexion client, redéploiement, arrêt du serveur) :
            # clôturer coûte que coûte pour réveiller les followers et éviter
            # une entrée inflight fantôme, puis propager l'annulation.
            print(f"[Modal Gateway] Generate annulé pour {request_id or '(sans id)'}")
            _idempotency_finish(
                request_id, entry, None,
                JSONResponse(
                    {"error": "Job interrompu (déconnexion client ou redéploiement)"},
                    status_code=503,
                ),
            )
            raise
        except Exception as e:
            print(f"[Modal Gateway] Error in generate: {e}")
            return _idempotency_finish(
                request_id, entry, None,
                JSONResponse({"error": str(e)}, status_code=500),
            )
        except BaseException as e:
            # Filet de sécurité (SystemExit, KeyboardInterrupt…) : clôturer
            # l'entrée avant de propager, sinon les followers attendraient à vie.
            _idempotency_finish(
                request_id, entry, None,
                JSONResponse({"error": f"Job interrompu: {e}"}, status_code=500),
            )
            raise

    # ─── POST /upload/image ────────────────────────────────────────────────

    @web_app.post("/upload/image", dependencies=[Depends(auth.require_api_key)])
    async def upload_image(request: Request):
        """Proxy l'upload d'image vers le worker GPU cible.

        Le GPU est soit passé en query param (?gpu=L40S), soit déduit
        du dernier appel à /generate.
        """
        gpu = request.query_params.get("gpu") or last_gpu.get("default", "L4")
        worker_cls = worker_map.get(gpu)
        if not worker_cls:
            return JSONResponse({"error": f"Unknown GPU: {gpu}"}, status_code=400)

        worker = worker_cls()
        form = await request.form()
        file = form.get("image")
        if not file:
            return JSONResponse({"error": "No image file"}, status_code=400)

        content = await file.read()
        result = await worker.upload_image.remote.aio(content)
        return result

    # ─── GET /view ─────────────────────────────────────────────────────────

    @web_app.get("/view", dependencies=[Depends(auth.require_api_key)])
    async def view_image(
        filename: str,
        subfolder: str = "",
        view_type: str = "output",
        gpu: str | None = None,
    ):
        """Récupère une image générée depuis le worker GPU.

        Le worker ``view()`` retourne un dict avec ``data`` (base64),
        ``content_type`` et ``filename``. On le convertit en réponse
        binaire pour le navigateur.
        """
        gpu = gpu or last_gpu.get("default", "L4")
        worker_cls = worker_map.get(gpu)
        if not worker_cls:
            return JSONResponse({"error": f"Unknown GPU: {gpu}"}, status_code=400)

        worker = worker_cls()
        result = await worker.view.remote.aio(filename, subfolder, view_type)
        binary = base64.b64decode(result["data"])
        media_type = result.get("content_type", "image/png")
        return Response(content=binary, media_type=media_type)

    # ─── GET /history/{job_id} ─────────────────────────────────────────────

    @web_app.get("/history/{job_id}", dependencies=[Depends(auth.require_api_key)])
    async def get_history(job_id: str, gpu: str | None = None):
        """Statut d'un job via l'historique ComfyUI."""
        gpu = gpu or last_gpu.get("default", "L4")
        worker_cls = worker_map.get(gpu)
        if not worker_cls:
            return JSONResponse({"error": f"Unknown GPU: {gpu}"}, status_code=400)

        worker = worker_cls()
        result = await worker.history.remote.aio(job_id)
        return result

    # ─── GET /logs ──────────────────────────────────────────────

    @web_app.get("/logs", dependencies=[Depends(auth.require_api_key)])
    async def worker_logs(gpu: str | None = None, lines: int = 200):
        """Retourne les dernières lignes du log ComfyUI du worker choisi.

        Permet de diagnostiquer les erreurs d'import/installation des custom
        nodes (tracebacks, dépendances manquantes, erreurs réseau d'un node),
        invisibles depuis le client. Le GPU est soit passé en query param
        (``?gpu=L40S``), soit déduit du dernier appel à /generate.

        Le log est lu par la fonction **CPU** ``logs_reader`` quand elle est
        fournie : aucun container GPU n'est réveillé (pas de cold start). Le
        repli ``worker.logs_tail`` reste disponible pour les anciens déploiements.
        """
        gpu = gpu or last_gpu.get("default", "L4")
        worker_cls = worker_map.get(gpu)
        if not worker_cls:
            return JSONResponse({"error": f"Unknown GPU: {gpu}"}, status_code=400)

        try:
            if logs_reader is not None:
                result = await logs_reader.remote.aio(lines)
            else:
                worker = worker_cls()
                result = await worker.logs_tail.remote.aio(lines)
        except Exception as e:
            return JSONResponse(
                {"error": f"Worker logs unavailable: {e}"}, status_code=500
            )
        return result

    # ─── GET /gpus (public — pas de coût ni de donnée sensible) ────────────

    @web_app.get("/gpus")
    async def list_gpus():
        """Liste les GPUs disponibles avec leurs caractéristiques"""
        return [
            {"id": gpu_id, **GPU_INFO[gpu_id]}
            for gpu_id in worker_map
            if gpu_id in GPU_INFO
        ]

    # ─── GET /health (public) ───────────────────────────────────────────────

    @web_app.get("/health")
    async def health():
        return {"status": "ok"}

    return web_app
