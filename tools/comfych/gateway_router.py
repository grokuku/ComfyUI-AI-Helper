"""Routeur FastAPI partagé pour les apps Modal Gateway (all_in_one*, lite, l4).

Factorise le code de routage dupliqué entre ``apps/all_in_one*.py`` et sépare
**le lancement du rendu** de **la durée de la requête HTTP**.

Architecture (cf. ``docs/COMFYCH.md``)::

    navigateur --POST /generate (async)--> gateway --run_job.spawn()--> worker
         |                                    |                          |
         +----GET /job/<id> (polling court)---+--- volume /cache/jobs/<id>/+

Pourquoi ce découplage : un rendu dure plusieurs minutes alors qu'une requête
HTTP peut être coupée à tout instant (déconnexion du navigateur, timeout d'un
proxy, redéploiement, timeout de fonction Modal). Tant que le gateway attendait
le résultat **dans la même requête**, toute coupure :

1. arrêtait le suivi du rendu (donc, le conteneur n'ayant plus d'entrée,
   ``scaledown_window`` l'arrêtait en plein rendu) ;
2. faisait répondre au client un ``503 « Job interrompu »`` **alors que le
   rendu avait produit ses images** → l'UI affichait « Échec » à tort.

Désormais : le gateway **lance** le job (``.spawn()``, jamais annulé par une
déconnexion cliente), le résultat est **persisté sur le volume** par le worker,
et le client **suit un identifiant de job** par requêtes courtes. Le résultat
reste récupérable après n'importe quelle coupure (``GET /job/<id>``).
"""

from __future__ import annotations

import asyncio
import base64
import math
import os
import time
import uuid

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

import auth

# ─── Budgets et délais (configurables par variables d'environnement) ─────────

GATEWAY_TIMEOUT_ENV = "COMFYCH_GATEWAY_TIMEOUT_S"
"""Variable d'env. qui fixe le ``timeout`` des fonctions web Modal (secondes)."""

DEFAULT_GATEWAY_TIMEOUT_SECONDS = 3600
"""Timeout par défaut des fonctions web Modal (1 h).

Sans ``timeout=`` explicite, Modal applique **300 s** : toute requête plus
longue était tuée par Modal (entrée annulée → ``CancelledError`` → 503), ce qui
rendait par construction impossible tout rendu dépassant 5 minutes. Le rendu
n'est plus attendu dans une requête (soumission + polling), ce budget borne
donc seulement la durée d'UNE requête."""

MIN_GATEWAY_TIMEOUT_SECONDS = 120
"""Plancher du timeout web : en dessous, même le mode bloquant historique
(attente du résultat dans la requête) ne peut pas fonctionner."""

SYNC_WAIT_ENV = "COMFYCH_SYNC_WAIT_S"
"""Budget d'attente du mode bloquant historique (secondes)."""

DEFAULT_SYNC_WAIT_SECONDS = 900
"""Budget du mode bloquant (compatibilité) : au-delà, on répond un 504
**explicite** en indiquant comment reprendre (``GET /job/<id>``)."""

JOB_POLL_INTERVAL_ENV = "COMFYCH_JOB_POLL_INTERVAL_S"
"""Intervalle de lecture de l'état d'un job côté gateway (secondes)."""

DEFAULT_JOB_POLL_INTERVAL_SECONDS = 2.0

JOB_BUDGET_ENV = "COMFYCH_JOB_TIMEOUT_S"
"""Budget d'exécution d'un job (le **même** que celui lu par le worker)."""

DEFAULT_JOB_BUDGET_SECONDS = 3600
"""Budget après lequel un job encore « running » est déclaré perdu.

Un job dont le conteneur GPU a été arrêté sans écrire de résultat (préemption
sans relance) resterait sinon « running » à vie : au-delà de ce budget on
répond un échec **honnête** (« job sans résultat après N s ») plutôt que de
laisser le client attendre indéfiniment."""


def job_budget_seconds() -> float:
    """Budget d'un job (secondes) + marge de lecture, configurable par env."""
    return _env_number(JOB_BUDGET_ENV, DEFAULT_JOB_BUDGET_SECONDS, 30) + 60


JOB_TIMEOUT_FALLBACK_SECONDS = DEFAULT_JOB_BUDGET_SECONDS + 60
"""Repli quand le worker ne déclare pas son budget dans le manifeste."""

JOB_ID_MAX_LENGTH = 96

# ─── Idempotence / cache des résultats ──────────────────────────────────────

_IDEMPOTENCY_TTL_SECONDS = 3600  # 1 heure
_IDEMPOTENCY_MAX_ENTRIES = 10

# job_id -> (timestamp, result)
_idempotency_cache: dict[str, tuple[float, dict]] = {}
# job_id -> {"call": FunctionCall | None, "started_at": float, "gpu": str}
_jobs: dict[str, dict] = {}
_jobs_lock = asyncio.Lock()


def _env_number(name: str, default: float, minimum: float = 1.0) -> float:
    """Nombre lu dans l'environnement, borné ; *default* si absent/invalide."""
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return float(default)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        print(f"[Gateway] ⚠️ {name}={raw!r} invalide — valeur par défaut {default}")
        return float(default)
    if math.isnan(value) or value < minimum:
        return float(default)
    return value


def gateway_timeout_seconds() -> int:
    """``timeout`` des fonctions web Modal (voir ``GATEWAY_TIMEOUT_ENV``).

    Sert aussi d'invariant : ``sync_wait_seconds() < gateway_timeout_seconds()``
    pour que le mode bloquant puisse répondre un 504 **avant** que Modal ne tue
    la requête.
    """
    value = _env_number(
        GATEWAY_TIMEOUT_ENV,
        DEFAULT_GATEWAY_TIMEOUT_SECONDS,
        MIN_GATEWAY_TIMEOUT_SECONDS,
    )
    return int(value)


def gateway_startup_timeout_seconds() -> int:
    """``startup_timeout`` des fonctions web Modal (montée du conteneur)."""
    return max(300, gateway_timeout_seconds())


def sync_wait_seconds() -> float:
    """Budget du mode bloquant historique, toujours sous le timeout Modal.

    Plancher à **1 s** (et non à plusieurs minutes) : la valeur est un budget
    d'attente, pas une garantie — un utilisateur peut la réduire, et les tests
    l'abaissent pour vérifier le 504 de reprise sans attendre 15 minutes.
    """
    value = _env_number(SYNC_WAIT_ENV, DEFAULT_SYNC_WAIT_SECONDS, 1.0)
    ceiling = max(1.0, gateway_timeout_seconds() - 30)
    return float(min(value, ceiling))


def job_poll_interval_seconds() -> float:
    """Intervalle de lecture de l'état d'un job (secondes, ≥ 0,2)."""
    return max(0.2, _env_number(JOB_POLL_INTERVAL_ENV, DEFAULT_JOB_POLL_INTERVAL_SECONDS, 0.2))


def _idempotency_get(job_id: str) -> dict | None:
    entry = _idempotency_cache.get(job_id)
    if entry is None:
        return None
    ts, result = entry
    if time.time() - ts > _IDEMPOTENCY_TTL_SECONDS:
        _idempotency_cache.pop(job_id, None)
        return None
    return result


def _idempotency_put(job_id: str, result: dict) -> None:
    _idempotency_cache[job_id] = (time.time(), result)
    if len(_idempotency_cache) > _IDEMPOTENCY_MAX_ENTRIES:
        oldest = min(_idempotency_cache, key=lambda k: _idempotency_cache[k][0])
        _idempotency_cache.pop(oldest, None)


def resolve_job_id(request_id: str = "", job_id: str = "") -> str:
    """Identifiant de job stable : ``job_id`` puis ``request_id``, sinon aléatoire."""
    candidate = str(job_id or request_id or "").strip()
    if candidate and len(candidate) <= JOB_ID_MAX_LENGTH:
        safe = "".join(
            c for c in candidate if c.isalnum() or c in "-_."
        )
        if safe:
            return safe
    return "job-" + uuid.uuid4().hex[:12]



# ─── Modèle de requête ──────────────────────────────────────────────────────


class GenerateRequest(BaseModel):
    workflow: dict
    gpu: str = "L4"
    request_id: str = ""  # idempotence : même id → même job (jamais ré-exécuté)
    job_id: str = ""  # alias explicite de request_id
    async_mode: bool = False  # True = rendre la main tout de suite (recommandé)


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
    job_reader=None,
) -> FastAPI:
    """Construit le routeur FastAPI public pour une app Modal Gateway.

    ``worker_map`` associe un nom de GPU (``"L4"``, ``"L40S"``…) à la classe
    Modal worker correspondante (``apps/all_in_one*.py``).

    ``logs_reader`` est la **fonction CPU** de l'app qui lit le log ComfyUI
    persisté sur le volume (``read_worker_logs``). Quand elle est fournie,
    ``GET /logs`` l'appelle au lieu de réveiller un container GPU : un cold
    start GPU dure 1 à 3 minutes, alors qu'un log doit s'afficher tout de
    suite. ``None`` conserve l'ancien chemin (``worker.logs_tail``, coûteux).

    ``job_reader`` est la **fonction CPU** qui lit sur le volume l'état d'un job
    (``read_job_result``). C'est elle qui rend le résultat **récupérable** :
    elle fonctionne depuis n'importe quel conteneur du gateway, après une
    coupure réseau, un redémarrage du gateway ou même la mort du conteneur GPU
    (le worker persiste son résultat avant de répondre).
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

    async def _job_state_from_volume(job_id: str) -> dict | None:
        """État du job lu par la fonction CPU (volume) — source de vérité.

        Fonctionne même si ce conteneur du gateway n'a jamais vu le job (autre
        conteneur, redéploiement) ou si le conteneur GPU est mort : le worker
        écrit son résultat sur le volume **avant** de répondre.
        """
        if job_reader is None:
            return None
        try:
            state = await job_reader.remote.aio(job_id)
        except Exception as exc:  # noqa: BLE001 — le repli mémoire reste possible
            print(f"[Gateway] Job {job_id}: lecture volume impossible ({exc})")
            return None
        return state if isinstance(state, dict) else None

    def _public_result(state: dict, gpu: str) -> dict:
        """Réponse « succès » normalisée (identique à l'ancien format)."""
        return {
            "images": state.get("images") or [],
            "job_id": state.get("job_id") or state.get("prompt_id") or "",
            "prompt_id": state.get("prompt_id") or "",
            "gpu": gpu,
            "status": "done",
            "persisted": bool(state.get("images")),
        }

    async def _job_status(job_id: str):
        """Photographie de l'état d'un job (mémoire → volume → handle Modal).

        Returns
        -------
        tuple[dict, int]
            ``(payload, http_status)``. ``payload['status']`` vaut ``done``
            (résultat complet, images en base64), ``failed`` (erreur réelle du
            rendu), ``running`` (en cours) ou ``unknown`` (inconnu de ce
            déploiement).
        """
        cached = _idempotency_get(job_id)
        if cached is not None:
            return cached, 200

        state = await _job_state_from_volume(job_id)
        if state and state.get("status") == "done":
            result = _public_result(state, last_gpu.get("default", "L4"))
            _idempotency_put(job_id, result)
            return result, 200
        if state and state.get("status") == "failed":
            return {
                "status": "failed",
                "job_id": job_id,
                "prompt_id": state.get("prompt_id") or "",
                "error": state.get("error") or "rendu en échec",
                "images": [],
            }, 200

        record = _jobs.get(job_id)
        started_at = (state or {}).get("started_at") or (record or {}).get("started_at") or 0
        # Handle Modal encore en mémoire : interrogation non bloquante.
        if record and record.get("call") is not None:
            try:
                result = await record["call"].get.aio(timeout=0)
            except asyncio.TimeoutError:
                result = None
            except Exception as exc:  # noqa: BLE001 — input disparu (préemption…)
                print(f"[Gateway] Job {job_id}: handle indisponible ({exc})")
                result = None
            if isinstance(result, dict) and result.get("status") == "done":
                payload = _public_result(result, record.get("gpu", "L4"))
                _idempotency_put(job_id, payload)
                return payload, 200
            if isinstance(result, dict) and result.get("status") == "failed":
                return {
                    "status": "failed",
                    "job_id": job_id,
                    "prompt_id": result.get("prompt_id") or "",
                    "error": result.get("error") or "rendu en échec",
                    "images": [],
                }, 200

        if state and state.get("status") == "running":
            elapsed = time.time() - float(started_at or time.time())
            budget = float(state.get("budget") or job_budget_seconds())
            if elapsed > budget:
                # Le conteneur a disparu sans écrire de résultat : on le dit
                # franchement plutôt que de laisser tourner une attente infinie.
                return {
                    "status": "failed",
                    "job_id": job_id,
                    "prompt_id": state.get("prompt_id") or "",
                    "error": (
                        f"job sans résultat après {int(elapsed)}s "
                        "(conteneur arrêté ou rendu interrompu)"
                    ),
                    "images": [],
                }, 200
            return {
                "status": "running",
                "job_id": job_id,
                "prompt_id": state.get("prompt_id") or "",
                "elapsed": round(elapsed, 1),
            }, 200

        if record is not None:
            return {
                "status": "running",
                "job_id": job_id,
                "elapsed": round(time.time() - float(started_at or time.time()), 1),
            }, 200

        return {"status": "unknown", "job_id": job_id}, 404

    @web_app.post("/generate", dependencies=[Depends(auth.require_api_key)])
    async def generate(req: GenerateRequest):
        """Lance un rendu et le suit — sans lier la durée du rendu à la requête.

        Deux modes :

        - ``async_mode=True`` (recommandé, utilisé par l'extension) : la
          requête rend la main **immédiatement** avec ``{"status": ...,
          "job_id": ...}`` ; le client suit ensuite ``GET /job/<job_id>``. Un
          rendu de 20 minutes ne peut donc plus être coupé par un timeout HTTP.
        - mode bloquant historique (``async_mode=False``) : attend le résultat
          dans la requête, borné par ``sync_wait_seconds()`` et toujours **sous**
          le timeout de la fonction Modal.

        Idempotent sur ``job_id``/``request_id`` : si le job est déjà terminé,
        le résultat en cache (ou sur le volume) est renvoyé sans ré-exécution ;
        s'il tourne encore, l'appel **s'y rattache** au lieu de le relancer.
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

        job_id = resolve_job_id(req.request_id, req.job_id)

        # ── 1. Le job existe-t-il déjà (cache, volume, handle en mémoire) ? ──
        payload, _ = await _job_status(job_id)
        if payload.get("status") == "done":
            print(f"[Gateway] Job {job_id}: déjà terminé — résultat réutilisé")
            return payload
        if payload.get("status") == "failed":
            # Un échec n'est pas mis en cache : le client peut relancer.
            print(f"[Gateway] Job {job_id}: échec précédent — {payload.get('error')}")
            if req.async_mode:
                return JSONResponse(payload, status_code=200)
            return JSONResponse(payload, status_code=500)
        if payload.get("status") in {"running"}:
            print(f"[Gateway] Job {job_id}: déjà en cours — rattachement (aucune relance)")
            if req.async_mode:
                return JSONResponse(payload, status_code=202)
            return await _wait_for_job(job_id, req)

        # ── 2. Démarrage : `.spawn()` = entrée DÉTACHÉE de cette requête ─────
        # Une déconnexion du navigateur (ou un timeout de cette requête) ne
        # l'annule donc jamais : le rendu va au bout et son résultat est
        # persisté sur le volume par le worker.
        try:
            worker = worker_cls()
            call = await worker.run_job.spawn.aio(req.workflow, job_id)
        except Exception as exc:  # noqa: BLE001 — jamais de 503 trompeur
            print(f"[Gateway] Job {job_id}: lancement impossible ({exc})")
            return JSONResponse(
                {"status": "failed", "job_id": job_id, "error": f"lancement impossible : {exc}"},
                status_code=500,
            )

        async with _jobs_lock:
            _jobs[job_id] = {
                "call": call,
                "started_at": time.time(),
                "gpu": req.gpu,
            }
        print(f"[Gateway] Job {job_id}: lancé sur {req.gpu} (async_mode={req.async_mode})")

        if req.async_mode:
            return JSONResponse(
                {
                    "status": "running",
                    "job_id": job_id,
                    "gpu": req.gpu,
                    "object_id": getattr(call, "object_id", ""),
                },
                status_code=202,
            )
        return await _wait_for_job(job_id, req)

    async def _wait_for_job(job_id: str, req: GenerateRequest):
        """Attente borné du résultat (mode bloquant) — jamais de 503 trompeur.

        Si le budget est dépassé, on répond un ``504`` **explicite** qui donne
        l'identifiant du job : le rendu continue côté worker et le client peut
        le récupérer via ``GET /job/<job_id>``. C'est la correction du « faux
        échec » : une requête coupée ne dit plus que le job a échoué.
        """
        budget = sync_wait_seconds()
        interval = job_poll_interval_seconds()
        deadline = time.time() + budget
        while time.time() < deadline:
            payload, _ = await _job_status(job_id)
            if payload.get("status") == "done":
                return payload
            if payload.get("status") == "failed":
                return JSONResponse(payload, status_code=500)
            if payload.get("status") == "unknown":
                return JSONResponse(payload, status_code=404)
            await asyncio.sleep(interval)
        elapsed = int(budget)
        print(f"[Gateway] Job {job_id}: budget d'attente épuisé ({elapsed}s) — le job continue")
        return JSONResponse(
            {
                "status": "running",
                "job_id": job_id,
                "error": (
                    f"résultat non disponible après {elapsed}s : le rendu continue sur "
                    f"le worker, reprendre avec GET /job/{job_id}"
                ),
                "resume_url": f"/job/{job_id}",
            },
            status_code=504,
        )

    # ─── GET /job/{job_id} — suivi et RÉCUPÉRATION du résultat ─────────────

    @web_app.get("/job/{job_id}", dependencies=[Depends(auth.require_api_key)])
    async def job_status(job_id: str):
        """État d'un job (``running`` | ``done`` | ``failed`` | ``unknown``).

        Route de **reprise** : les images d'un job terminé sont toujours
        renvoyées (base64), même si :
        - la requête ``/generate`` a été coupée (déconnexion, timeout, proxy) ;
        - l'extension a été rechargée / la fenêtre de suivi fermée ;
        - le conteneur du gateway a redémarré entre-temps ;
        - le conteneur GPU s'est arrêté après avoir persisté son résultat.
        """
        payload, _ = await _job_status(job_id)
        if payload.get("status") == "unknown":
            return JSONResponse(
                {
                    "status": "unknown",
                    "job_id": job_id,
                    "error": "job inconnu (jamais lancé, ou store de résultats expiré)",
                },
                status_code=404,
            )
        if payload.get("status") == "failed":
            return JSONResponse(payload, status_code=200)
        return JSONResponse(payload, status_code=200)
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
