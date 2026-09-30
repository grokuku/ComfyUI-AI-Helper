# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Téléchargement de modèle (outil « Models ») : le serveur aiohttp du pack doit
# rester RÉACTIF pendant un transfert lent/volumineux, l'échec doit être PROPRE
# (fichier absent côté serveur → message clair, aucun gel), le fichier partiel
# doit être NETTOYÉ, la progression doit fonctionner et l'annulation doit être
# coopérative.
#
# Contexte (signalement « les modèles ne se téléchargent pas et ça fait même
# tout planter ») : l'hypothèse « le handler bloque l'event loop » est FALSIFIÉE
# ici AVEC MESURE — POST /api/aih/models/download passe par run_in_executor
# (aih/routes.py). Un CONTRÔLE PAR MUTATION (même travail appelé inline dans
# l'event loop) prouve que le détecteur de réactivité rougit bien si on revient
# au comportement bloquant.
#
# Les vrais défauts corrigés et verrouillés ici :
#   - écriture DIRECTE dans la destination → fichier 0 octet/tronqué laissé
#     après échec (et écrasement d'un fichier existant dès la 1re seconde) ;
#   - progression invisible dans le Model Browser (transfert de dizaines de
#     minutes à 0 %) ;
#   - aucune annulation (le transfert continue côté serveur même si l'UI a
#     abandonné) ;
#   - messages d'échec bruts (HTTP 404 sans explication) ;
#   - aucune vérification d'espace disque avant un fichier de 13,5 Go.
#
# Le handler est monté TEL QUEL (aih.routes._register_models_group) dans une app
# aiohttp et appelé par de VRAIES requêtes HTTP ; le backend distant est un stub
# contrôlé (débit, coupure, 404) qui suit le contrat réel (download-info sans
# clé ``sftp`` → chemin HTTP).
#
# Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
#         (sans aiohttp : test ignoré, jamais un faux PASS)

import asyncio
import sys
import threading
import time
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

pytest.importorskip("aiohttp")

from aiohttp import ClientSession, web  # noqa: E402

from aih import model_manager as mm  # noqa: E402
from aih import routes as aih_routes  # noqa: E402

MB = 1024 * 1024


class _Recorder:
    """Shim décorateur : collecte les VRAIS handlers de _register_models_group.

    aiohttp 3.14 exige le handler explicite (formes décorateurs retirées) : on
    monte les handlers nous-mêmes, sans en modifier aucun.
    """

    def __init__(self):
        self.routes = []

    def _deco(self, method):
        def factory(path):
            def deco(handler):
                self.routes.append((method, path, handler))
                return handler
            return deco
        return factory

    def get(self, path):
        return self._deco("GET")(path)

    def post(self, path):
        return self._deco("POST")(path)


def _register(app, blocking_download=False):
    """Monte les routes réelles ; ``blocking_download`` = mutation inline."""
    rec = _Recorder()
    aih_routes._register_models_group(rec)
    for method, path, handler in rec.routes:
        if (method, path) == ("POST", "/api/aih/models/download") and blocking_download:
            continue
        if method == "GET":
            app.router.add_get(path, handler)
        elif method == "POST":
            app.router.add_post(path, handler)

    if blocking_download:
        # MUTATION : la même fonction synchrone appelée DIRECTEMENT dans la
        # boucle d'événements (comportement bloquant que le correctif évite).
        async def mutated_sync(request):
            body = await request.json()
            result = mm.download_model_from_server(
                body.get("upload_id", ""), body.get("filename", ""),
                body.get("type", "model"), body.get("dest_path", None))
            return web.json_response(result, status=200 if result.get("success") else 400)
        app.router.add_post("/api/aih/models/download", mutated_sync)

    async def ping(request):
        return web.json_response({"pong": True})

    app.router.add_get("/ping", ping)


def _make_backend(known_ids, size, rate_bps, cut_after=None):
    """Stub backend AI-Helper : contrat réel, débit et coupure contrôlés."""

    async def info(request):
        uid = request.match_info["uid"]
        if uid not in known_ids:
            return web.json_response({"error": "Fichier introuvable"}, status=404)
        return web.json_response({
            "filename": "model.safetensors", "size": size,
            "file_path": "unet/model.safetensors",
        })

    async def download(request):
        uid = request.match_info["uid"]
        if uid not in known_ids:
            return web.json_response({"error": "Fichier introuvable"}, status=404)
        resp = web.StreamResponse(headers={"Content-Length": str(size)})
        await resp.prepare(request)
        sent = 0
        while sent < size:
            n = min(256 * 1024, size - sent)
            try:
                await resp.write(b"\x00" * n)
            except Exception:
                return resp
            sent += n
            if cut_after is not None and sent >= cut_after:
                # Coupure TCP réelle : le client voit un transfert incomplet.
                try:
                    request.transport.abort()
                except Exception:
                    pass
                return resp
            await asyncio.sleep(n / rate_bps)
        await resp.write_eof()
        return resp

    app = web.Application()
    app.router.add_get("/api/files/{uid}/download-info", info)
    app.router.add_get("/api/files/{uid}/download", download)
    return app


async def _start(app):
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    return runner, site._server.sockets[0].getsockname()[1]


def _patch_env(monkeypatch, tmp_path, backend_port):
    mm._get_aih_credentials = lambda: (f"http://127.0.0.1:{backend_port}/api", "k")
    dirs = {}
    for cat in ("unet", "clip", "checkpoints", "vae", "loras"):
        d = tmp_path / "models" / cat
        dirs[cat] = [str(d)]
    mm._get_model_dirs = lambda: dirs
    return dirs


async def _measure_latencies(port, duration_s, samples, interval=0.02):
    """Ping parallèle asynchrone (comblement de trous uniquement).

    Conservé pour les cas où la boucle mesurée est saine ; le détecteur de gel
    principal reste ``_ping_thread`` (thread indépendant de la boucle).
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + duration_s
    async with ClientSession() as session:
        while loop.time() < deadline:
            t0 = loop.time()
            try:
                async with session.get(f"http://127.0.0.1:{port}/ping") as r:
                    await r.json()
                samples.append(round(loop.time() - t0, 3))
            except Exception as e:  # pragma: no cover - réseau local
                samples.append({"error": str(e), "latency": round(loop.time() - t0, 3)})
            await asyncio.sleep(interval)


def _ping_thread(port, duration_s, samples, interval=0.02):
    """Ping GET /ping depuis un THREAD (indépendant de la boucle mesurée).

    Indispensable : un ping asyncio serait lui-même bloqué par la boucle gelée
    et ne mesurerait rien (la requête ne partirait qu'après le dégel).
    urllib (stdlib) plutôt que requests : le test de mutation monkeypatche
    ``requests.get`` et ne doit pas saboter sa propre sonde.
    """
    import urllib.request
    deadline = time.time() + duration_s
    while time.time() < deadline:
        t0 = time.time()
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/ping", timeout=30) as resp:
                resp.read()
            samples.append(round(time.time() - t0, 3))
        except Exception as e:  # pragma: no cover - réseau local
            samples.append({"error": str(e), "latency": round(time.time() - t0, 3)})
        time.sleep(interval)


async def _watch_gaps(duration_s, gaps, interval=0.02):
    """Watchdog de boucle : mesure les trous entre deux réveils de l'event loop.

    Pendant un gel, le `sleep` se réveille en retard → le trou vaut la durée du
    blocage. Complète le ping (qui mesure la réponse SERVEUR).
    """
    loop = asyncio.get_running_loop()
    start = loop.time()
    last = start
    while loop.time() - start < duration_s:
        await asyncio.sleep(interval)
        now = loop.time()
        gaps.append(round(now - last, 3))
        last = now


async def _download(port, payload, timeout=60):
    async with ClientSession() as session:
        t0 = time.time()
        async with session.post(f"http://127.0.0.1:{port}/api/aih/models/download",
                                json=payload, timeout=timeout) as resp:
            data = await resp.json()
            return resp.status, data, round(time.time() - t0, 2)


def _lat_values(samples):
    return [s["latency"] if isinstance(s, dict) else s for s in samples]


def _files(directory):
    return sorted(f for f in directory.iterdir())


# ─── 1. Réactivité + progression + succès (route RÉELLE) ─────────────────────

def test_download_keeps_server_responsive(monkeypatch, tmp_path):
    """Un transfert lent NE gèle PAS le serveur : ping parallèle servi."""
    size = 50 * MB
    rate = 25 * MB  # 2 s de transfert

    async def case():
        backend = _make_backend({"uid-ok"}, size, rate)
        brunner, bport = await _start(backend)
        dirs = _patch_env(monkeypatch, tmp_path, bport)
        app = web.Application()
        _register(app)
        runner, port = await _start(app)
        try:
            lat, gaps, progress = [], [], []
            loop = asyncio.get_running_loop()
            pings = threading.Thread(target=_ping_thread, args=(port, 2.6, lat), daemon=True)
            pings.start()

            async def polls():
                async with ClientSession() as s:
                    deadline = loop.time() + 2.6
                    while loop.time() < deadline:
                        async with s.get(
                            f"http://127.0.0.1:{port}/api/aih/models/download/progress?upload_id=uid-ok"
                        ) as r:
                            p = await r.json()
                        if p:
                            progress.append(p)
                        await asyncio.sleep(0.05)

            download_task = asyncio.create_task(_download(port, {
                "upload_id": "uid-ok", "filename": "Krea2.safetensors", "type": "unet"}))
            await asyncio.gather(polls(), _watch_gaps(2.6, gaps), download_task)
            await asyncio.to_thread(pings.join, 5)
            status, data, elapsed = download_task.result()

            values = _lat_values(lat)
            print(f"[reactivity] route réelle : {len(values)} pings, "
                  f"latence max {max(values) if values else 'n/a'} s, "
                  f"trou de boucle max {max(gaps)} s, transfert {elapsed} s", flush=True)
            assert status == 200 and data.get("success"), data
            assert len(values) >= 5, f"trop peu de pings mesurés: {len(values)}"
            assert max(values) < 0.25, (
                f"serveur GELÉ pendant le download : latence ping max {max(values)} s "
                f"(attendu < 0.25 s) — le handler ne doit pas bloquer la boucle")
            assert max(gaps) < 0.25, (
                f"boucle d'événements bloquée {max(gaps)} s pendant le transfert")
            assert elapsed >= 1.5, f"transfert trop rapide pour prouver quoi que ce soit: {elapsed}s"
            dest = Path(data["path"])
            assert dest.is_file() and dest.stat().st_size == size
            assert not list(Path(dirs["unet"][0]).glob("*.part")), "aucun .part ne doit rester"
            assert progress, "aucune progression publiée pendant le transfert"
            assert any(0 < p.get("percent", 0) < 100 for p in progress), (
                f"progression jamais intermédiaire: {[p.get('percent') for p in progress]}")
            assert all(p.get("bytes_total") == size for p in progress)
        finally:
            await runner.cleanup()
            await brunner.cleanup()

    asyncio.run(case())


# ─── 2. CONTRÔLE NÉGATIF PAR MUTATION : handler bloquant = test rouge ────────

class _FakeInfo:
    """Réponse download-info synthétique (pas de réseau)."""

    def __init__(self, size):
        self.ok = True
        self.status_code = 200
        self._size = size

    def json(self):
        return {"sftp": None, "size": self._size}


class _FakeStream:
    """Réponse /download synthétique : ``iter_content`` DORT réellement.

    Le sommeil est le point du contrôle : appelé inline dans l'event loop, il
    reproduit exactement le gel d'un transfert synchrone de ~1 s.
    """

    def __init__(self, size, duration_s=1.0, chunk=256 * 1024):
        self.ok = True
        self.status_code = 200
        self.headers = {"Content-Length": str(size)}
        self.text = ""
        self._size = size
        self._duration = duration_s
        self._chunk = chunk

    def iter_content(self, chunk_size=1024 * 1024):
        n_chunks = max(1, self._size // self._chunk)
        pause = self._duration / n_chunks
        sent = 0
        while sent < self._size:
            n = min(self._chunk, self._size - sent)
            time.sleep(pause)  # ← travail synchrone qui bloque l'event loop
            sent += n
            yield b"\x00" * n

    def close(self):
        pass


def test_mutation_blocking_handler_is_detected(monkeypatch, tmp_path):
    """Même travail appelé inline → le ping parallèle observe le gel réel.

    Sans ce contrôle, le test de réactivité ne prouverait rien : il doit être
    capable de détecter le comportement bloquant que l'hypothèse utilisateur
    décrit. Le faux ``requests.get`` ci-dessous streame ~1 s de façon
    SYNCHRONE : c'est le même code (download_model_from_server) mais inline.
    """
    size = 25 * MB  # 100 chunks × 10 ms ≈ 1 s de sommeil synchrone

    async def case():
        import requests as _requests

        def fake_get(url, headers=None, stream=False, timeout=None, **kw):
            if "download-info" in url:
                return _FakeInfo(size)
            return _FakeStream(size)

        monkeypatch.setattr(_requests, "get", fake_get)
        _patch_env(monkeypatch, tmp_path, 1)
        app = web.Application()
        _register(app, blocking_download=True)  # MUTATION
        runner, port = await _start(app)
        try:
            lat, gaps = [], []
            pings = threading.Thread(target=_ping_thread, args=(port, 1.8, lat), daemon=True)
            pings.start()
            await asyncio.sleep(0.1)  # laisse le ping démarrer
            download_task = asyncio.create_task(_download(port, {
                "upload_id": "uid-ok", "filename": "m.safetensors", "type": "unet"}))
            await asyncio.gather(_watch_gaps(1.8, gaps), download_task)
            await asyncio.to_thread(pings.join, 5)
            status, data, _ = download_task.result()
            assert status == 200 and data.get("success"), data
            values = _lat_values(lat)
            print(f"[mutation] handler inline : {len(values)} pings, "
                  f"latence max {max(values) if values else 'n/a'} s, "
                  f"trou de boucle max {max(gaps)} s", flush=True)
            assert max(values) >= 0.5 or max(gaps) >= 0.5, (
                "le détecteur est AVEUGLE : un handler bloquant d'1 s n'a produit "
                f"ni latence ping (max {max(values)} s) ni trou de boucle (max {max(gaps)} s)")
        finally:
            await runner.cleanup()

    asyncio.run(case())


# ─── 3. Échec PROPRE : fichier absent côté serveur ──────────────────────────

def test_missing_server_file_fails_cleanly(monkeypatch, tmp_path):
    """404 backend → message explicite, AUCUN fichier créé, serveur réactif."""
    async def case():
        backend = _make_backend({"uid-ok"}, 1024, 1024)  # uid-inconnu → 404
        brunner, bport = await _start(backend)
        dirs = _patch_env(monkeypatch, tmp_path, bport)
        app = web.Application()
        _register(app)
        runner, port = await _start(app)
        try:
            status, data, elapsed = await _download(port, {
                "upload_id": "uid-inconnu", "filename": "ghost.safetensors", "type": "unet"})
            assert status == 400 and data.get("success") is False
            assert "introuvable" in data.get("error", "").lower(), data
            assert _files(Path(dirs["unet"][0])) == [], "aucun fichier ne doit être créé"
            # Réactivité après l'échec (aucune tâche/timer orphelin qui bloque).
            loop = asyncio.get_running_loop()
            t0 = loop.time()
            async with ClientSession() as s:
                async with s.get(f"http://127.0.0.1:{port}/ping") as r:
                    await r.json()
            assert loop.time() - t0 < 0.25
        finally:
            await runner.cleanup()
            await brunner.cleanup()

    asyncio.run(case())


# ─── 4. Nettoyage du fichier partiel (coupure mi-transfert) ─────────────────

def test_partial_file_is_cleaned_on_cut(monkeypatch, tmp_path):
    """Transfert coupé → erreur remontée ET aucun partiel/tronqué dans models/.

    Avant le correctif, le fichier destination était créé dès la 1re seconde
    (0 octet) et restait après l'échec : un workflow pouvait charger ce faux
    modèle. Le .part doit disparaître et la destination ne doit pas exister.
    """
    size = 8 * MB

    async def case():
        backend = _make_backend({"uid-cut"}, size, 25 * MB, cut_after=2 * MB)
        brunner, bport = await _start(backend)
        dirs = _patch_env(monkeypatch, tmp_path, bport)
        app = web.Application()
        _register(app)
        runner, port = await _start(app)
        try:
            status, data, elapsed = await _download(port, {
                "upload_id": "uid-cut", "filename": "cut.safetensors", "type": "clip"})
            assert status == 400 and data.get("success") is False
            assert data.get("error"), "un échec sans message serait invisible pour l'utilisateur"
            left = _files(Path(dirs["clip"][0]))
            assert left == [], f"fichier partiel laissé dans models/ : {left}"
        finally:
            await runner.cleanup()
            await brunner.cleanup()

    asyncio.run(case())


# ─── 5. Annulation coopérative ──────────────────────────────────────────────

def test_cancel_aborts_download_and_cleans_partial(monkeypatch, tmp_path):
    """POST /download/cancel → transfert interrompu, partiel nettoyé, flag ôté."""
    size = 50 * MB
    rate = 25 * MB  # 2 s

    async def case():
        backend = _make_backend({"uid-cancel"}, size, rate)
        brunner, bport = await _start(backend)
        dirs = _patch_env(monkeypatch, tmp_path, bport)
        app = web.Application()
        _register(app)
        runner, port = await _start(app)
        try:
            download_task = asyncio.create_task(_download(port, {
                "upload_id": "uid-cancel", "filename": "big.safetensors", "type": "unet"}))
            await asyncio.sleep(0.3)
            async with ClientSession() as s:
                async with s.post(f"http://127.0.0.1:{port}/api/aih/models/download/cancel",
                                  json={"upload_id": "uid-cancel"}) as r:
                    assert r.status == 200 and (await r.json()).get("ok") is True
                # Idempotente : un id inconnu répond ok sans effet.
                async with s.post(f"http://127.0.0.1:{port}/api/aih/models/download/cancel",
                                  json={"upload_id": "uid-jamais-vu"}) as r2:
                    assert r2.status == 200 and (await r2.json()).get("ok") is True

            status, data, elapsed = await download_task
            assert status == 400 and data.get("cancelled") is True, data
            assert elapsed < 2.6, f"annulation trop lente ({elapsed}s) : le flag n'est pas consulté"
            assert _files(Path(dirs["unet"][0])) == [], "le partiel doit être nettoyé"
            # Progression purgée (aucune entrée fantôme qui ferait croire à un
            # transfert toujours en cours).
            async with ClientSession() as s:
                async with s.get(
                    f"http://127.0.0.1:{port}/api/aih/models/download/progress?upload_id=uid-cancel"
                ) as r:
                    assert await r.json() is None
            assert "uid-cancel" not in mm._download_cancel, "drapeau d'annulation non consommé"
        finally:
            await runner.cleanup()
            await brunner.cleanup()

    asyncio.run(case())


# ─── 6. Refus AVANT transfert : disque insuffisant ──────────────────────────

def test_disk_space_preflight_refuses_before_transfer(monkeypatch, tmp_path):
    """13,5 Go sur un disque trop petit → message clair, transfert non lancé."""
    size = 13500 * MB  # 13,5 Go, comme le modèle signalé

    async def case():
        backend = _make_backend({"uid-big"}, size, 25 * MB)
        brunner, bport = await _start(backend)
        dirs = _patch_env(monkeypatch, tmp_path, bport)

        usage = type("U", (), {"total": 200 * MB, "used": 180 * MB, "free": 20 * MB})()
        import shutil as _shutil
        monkeypatch.setattr(_shutil, "disk_usage", lambda path: usage)

        app = web.Application()
        _register(app)
        runner, port = await _start(app)
        try:
            status, data, elapsed = await _download(port, {
                "upload_id": "uid-big", "filename": "Krea2.safetensors", "type": "unet"})
            assert status == 400 and data.get("success") is False
            assert "espace disque" in data.get("error", "").lower(), data
            assert _files(Path(dirs["unet"][0])) == [], "aucun octet ne doit être écrit"
            assert elapsed < 1.0, "le refus doit être immédiat (aucun transfert)"
        finally:
            await runner.cleanup()
            await brunner.cleanup()

    asyncio.run(case())
