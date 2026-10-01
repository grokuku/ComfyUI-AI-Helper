# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Download de modèle : plus JAMAIS d'attente silencieuse INFINIE.
#
# Contexte (capture utilisateur) : fenêtre « Téléchargement des modèles » ouverte,
# « Préparation côté serveur… », 0 % / 0 B / — MB/s pendant 3 minutes et plus —
# aucun octet reçu. Deux causes possibles, indistinguables sans instrumentation :
#   (a) backend AI-Helper ANTÉRIEUR au correctif de streaming (service PYTHON
#       séparé de ComfyUI : le redémarrer, lui, n'a peut-être pas été fait) qui
#       précharge 13,5 Go avant le 1er octet ;
#   (b) flux de stockage réellement figé (lecture qui ne rend rien).
#
# Correctifs verrouillés ici :
#   1. PRÉFLIGHT : GET <api>/health est interrogé AVANT le transfert ; un
#      backend manifestement antérieur (404, ou 200 sans
#      ``features.download_streaming``) est REFUSÉ en « 5 secondes » avec la
#      marche à suivre — jamais une fenêtre bloquée à 0 octet ;
#   2. WATCHDOG : sans le moindre octet pendant ``DOWNLOAD_STALL_TIMEOUT``
#      (read timeout de la requête + thread de surveillance), le transfert est
#      abandonné (partiel nettoyé) avec un message EXPLICITE et ACTIONNABLE ;
#   3. la progression publie ``idle_s`` et ``backend_streaming`` (l'UI affiche
#      « Serveur muet depuis N s » au-delà du seuil, au lieu d'un 0 % muet).
#
# Contrôles négatifs par mutation (chacun DOIT faire rougir ce fichier) :
#   M1  retirer le préflight santé → test_backend_sans_health_* rouge (le
#       download-info serait appelé / la fenêtre resterait muette) ;
#   M2  retirer le watchdog (ni thread ni read timeout) → les tests de blocage
#       n'ont plus le message d'abandon → rouges ;
#   M3  abandonner la vérification ``watchdog.stalled`` / ReadTimeout → le
#       message redevient « Transfert interrompu : … » générique → rouge ;
#   M4  refuser un backend dont la sonde est indisponible (réseau) → le test
#       « sonde impossible : on ne bloque pas » rouge.
#
# Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh

import sys
import threading
import time
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

requests_mod = pytest.importorskip("requests")

from aih import model_manager as mm  # noqa: E402

API = "https://aih.test/api"


# ── Réponses factices (aucun réseau) ─────────────────────────────────


class _JsonResponse:
    """Réponse type /health ou /download-info."""

    def __init__(self, data=None, status_code=200):
        self._data = data if data is not None else {}
        self.status_code = status_code
        self.ok = 200 <= status_code < 300
        self.text = ""

    def json(self):
        return self._data


class _HealthOk(_JsonResponse):
    def __init__(self, streaming=True):
        super().__init__({
            "ok": True,
            "service": "ai-helper-backend",
            "build": "test",
            "features": ({"download_streaming": True} if streaming else {}),
        })


class _StallingResponse:
    """Réponse /download qui ne rend AUCUN octet tant qu'on ne la ferme pas.

    Reproduit une lecture de stockage qui PEND. ``stall_cap`` borne l'attente
    pour que la MUTATION (watchdog retiré) rougisse sans figer la suite.
    """

    def __init__(self, size, first_chunk=b"", stall_cap=4.0):
        self.headers = {"Content-Length": str(size)}
        self.status_code = 200
        self.ok = True
        self.text = ""
        self.closed = threading.Event()
        self._first_chunk = first_chunk
        self._stall_cap = stall_cap

    def iter_content(self, chunk_size=1024 * 1024):
        if self._first_chunk:
            yield self._first_chunk
        # Aucun octet ensuite : le watchdog doit fermer la réponse (→ ReadTimeout
        # comme le ferait requests sur une socket inactive). Sinon, cap dur.
        if not self.closed.wait(self._stall_cap):
            return
        raise requests_mod.exceptions.ReadTimeout("read timeout (flux muet)")

    def close(self):
        self.closed.set()


class _CutResponse:
    """Réponse /download coupée par le backend après quelques octets (flux tronqué)."""

    def __init__(self, size, first_chunk=b"y" * 64):
        self.headers = {"Content-Length": str(size)}
        self.status_code = 200
        self.ok = True
        self.text = ""
        self._first_chunk = first_chunk
        self.closed = False

    def iter_content(self, chunk_size=1024 * 1024):
        yield self._first_chunk
        raise requests_mod.exceptions.ChunkedEncodingError(
            "Connection broken: IncompleteRead(64 bytes read)")

    def close(self):
        self.closed = True


class _HealthyResponse:
    """Réponse /download saine : des octets arrivent tout de suite."""

    def __init__(self, size, chunks=None, probe=None):
        self.headers = {"Content-Length": str(size)}
        self.status_code = 200
        self.ok = True
        self.text = ""
        self._chunks = chunks if chunks is not None else [b"a" * 64, b"b" * 64]
        self._probe = probe
        self.closed = False

    def iter_content(self, chunk_size=1024 * 1024):
        for chunk in self._chunks:
            yield chunk
            if self._probe is not None:
                self._probe.append(dict(mm._download_progress.get("uid-ok", {})))

    def close(self):
        self.closed = True


def _dirs(tmp_path):
    out = {}
    for cat in ("unet", "checkpoints", "loras", "clip"):
        d = tmp_path / cat
        d.mkdir(parents=True, exist_ok=True)
        out[cat] = [str(d)]
    return out


def _patch(monkeypatch, tmp_path, fake_get):
    monkeypatch.setattr(mm, "_get_aih_credentials", lambda: (API, "k"))
    monkeypatch.setattr(mm, "_get_model_dirs", lambda: _dirs(tmp_path))
    monkeypatch.setattr(requests_mod, "get", fake_get)


def _download(upload_id="uid-ok"):
    return mm.download_model_from_server(upload_id, "model.safetensors", "unet")


# ── 1. Backend antérieur (pas de /api/health) → refus IMMÉDIAT ───────


def test_backend_sans_health_refuse_immediatement(monkeypatch, tmp_path):
    """404 sur /api/health → refus en < 1 s, AVANT tout autre appel réseau.

    MUTATION M1 (préflight retiré) : le fake lève AssertionError dès qu'un
    autre endpoint est appelé → rouge (et le vrai cas laisserait la fenêtre
    muette des minutes).
    """
    calls = []

    def fake_get(url, headers=None, stream=False, timeout=None, **kw):
        calls.append(url)
        if url.endswith("/health"):
            return _JsonResponse({"error": "Not Found"}, status_code=404)
        raise AssertionError(f"appel inattendu après un backend obsolète : {url}")

    _patch(monkeypatch, tmp_path, fake_get)

    t0 = time.monotonic()
    res = _download()
    elapsed = time.monotonic() - t0

    assert res["success"] is False, res
    assert res.get("backend_outdated") is True, res
    assert "obsolète" in res["error"].lower(), res["error"]
    assert "/health" in res["error"], (
        f"le message doit dire COMMENT vérifier (route /health) : {res['error']}")
    assert elapsed < 1.0, f"le refus a pris {elapsed:.2f} s (doit être immédiat)"
    assert calls == [f"{API}/health"], calls


def test_backend_sans_feature_streaming_refuse(monkeypatch, tmp_path):
    """200 mais sans features.download_streaming → refus explicite (M1 : rouge)."""
    def fake_get(url, headers=None, stream=False, timeout=None, **kw):
        if url.endswith("/health"):
            return _HealthOk(streaming=False)
        raise AssertionError(f"appel inattendu : {url}")

    _patch(monkeypatch, tmp_path, fake_get)
    res = _download()

    assert res["success"] is False and res.get("backend_outdated") is True, res
    assert "download_streaming" in res["error"], res["error"]


def test_sonde_health_impossible_ne_bloque_pas(monkeypatch, tmp_path):
    """Sonde KO (réseau) → verdict indéterminé : le download procède (M4 : rouge).

    Un proxy restrictif ne doit pas empêcher un backend moderne de fonctionner ;
    le watchdog du transfert reste la ceinture de sécurité.
    """
    def fake_get(url, headers=None, stream=False, timeout=None, **kw):
        if url.endswith("/health"):
            raise requests_mod.exceptions.ConnectionError("proxy KO")
        if "download-info" in url:
            return _JsonResponse({"sftp": None, "size": 128})
        return _HealthyResponse(128)

    _patch(monkeypatch, tmp_path, fake_get)
    res = _download()

    assert res["success"] is True, res
    assert Path(res["path"]).read_bytes() == b"a" * 64 + b"b" * 64


# ── 2. Flux figé : abandon BORNÉ + message actionnable ───────────────


def test_aucun_octet_abandon_ne_est_borne_et_message_clair(monkeypatch, tmp_path):
    """0 octet pendant DOWNLOAD_STALL_TIMEOUT → abandon borné, message explicite.

    MUTATIONS M2/M3 : sans watchdog, la réponse rend la main au cap dur (4 s)
    puis échoue avec « Transfert interrompu : Transfert incomplet… » (ou ne
    lève rien) → le test rougit.
    """
    stalling = _StallingResponse(13_500_000_000)

    def fake_get(url, headers=None, stream=False, timeout=None, **kw):
        if url.endswith("/health"):
            return _HealthOk()
        if "download-info" in url:
            return _JsonResponse({"sftp": None, "size": 13_500_000_000})
        assert "download" in url
        return stalling

    _patch(monkeypatch, tmp_path, fake_get)
    monkeypatch.setattr(mm, "DOWNLOAD_STALL_TIMEOUT", 0.4)
    # Disque factice suffisant : le préflight disque (13,5 Go) ne doit pas
    # court-circuiter le scénario testé (le disque du runner est petit).
    import shutil as _shutil
    usage = type("U", (), {"total": 100 << 30, "used": 0, "free": 99 << 30})()
    monkeypatch.setattr(_shutil, "disk_usage", lambda path: usage)

    t0 = time.monotonic()
    res = _download()
    elapsed = time.monotonic() - t0

    assert res["success"] is False, res
    assert res.get("stalled") is True, res
    assert "Aucun octet" in res["error"], res["error"]
    assert "/health" in res["error"], (
        f"le message doit être ACTIONNABLE (vérifier /health) : {res['error']}")
    assert elapsed < 2.5, (
        f"abandon après {elapsed:.2f} s malgré DOWNLOAD_STALL_TIMEOUT=0.4 s : "
        "l'attente n'est pas bornée")
    assert stalling.closed.is_set(), "la réponse doit être fermée par le watchdog"
    assert "uid-ok" not in mm._download_progress, "progression purgée après abandon"
    assert not list(Path(_dirs(tmp_path)["unet"][0]).glob("*.part")), (
        "aucun .part ne doit rester après l'abandon")


def test_flux_fige_apres_premiers_octets_message_specifique(monkeypatch, tmp_path):
    """Des octets puis plus rien → « Flux figé ou coupé … reçu X sur Y »."""
    stalling = _StallingResponse(1024, first_chunk=b"x" * 128)

    def fake_get(url, headers=None, stream=False, timeout=None, **kw):
        if url.endswith("/health"):
            return _HealthOk()
        if "download-info" in url:
            return _JsonResponse({"sftp": None, "size": 1024})
        return stalling

    _patch(monkeypatch, tmp_path, fake_get)
    monkeypatch.setattr(mm, "DOWNLOAD_STALL_TIMEOUT", 0.4)

    res = _download()

    assert res["success"] is False and res.get("stalled") is True, res
    assert "Flux figé" in res["error"], res["error"]
    assert "128" in res["error"], (
        f"le message doit chiffrer ce qui a déjà été reçu : {res['error']}")


def test_coupure_backend_en_plein_flux_message_explicite(monkeypatch, tmp_path):
    """Connexion coupée APRÈS des octets (backend qui abandonne un flux muet)
    → message explicite, jamais un « connection reset » brut.

    MUTATION : retirer la branche ChunkedEncodingError/ConnectionError avec
    ``received > 0`` → l'erreur redevient générique → rouge.
    """
    cut = _CutResponse(1024)

    def fake_get(url, headers=None, stream=False, timeout=None, **kw):
        if url.endswith("/health"):
            return _HealthOk()
        if "download-info" in url:
            return _JsonResponse({"sftp": None, "size": 1024})
        return cut

    _patch(monkeypatch, tmp_path, fake_get)

    res = _download()

    assert res["success"] is False and res.get("stalled") is True, res
    assert "Flux figé" in res["error"], res["error"]
    assert "64" in res["error"] and "/health" in res["error"], res["error"]


def test_connexion_impossible_message_actionnable(monkeypatch, tmp_path):
    """Backend injoignable → message qui nomme la connexion (pas un brut)."""
    def fake_get(url, headers=None, stream=False, timeout=None, **kw):
        if url.endswith("/health"):
            return _HealthOk()
        if "download-info" in url:
            return _JsonResponse({"sftp": None, "size": 1024})
        raise requests_mod.exceptions.ConnectTimeout("connexion expirée")

    _patch(monkeypatch, tmp_path, fake_get)

    res = _download()

    assert res["success"] is False, res
    assert "Connexion au backend" in res["error"], res["error"]


# ── 3. Pas de faux positif : flux sain, 1er octet immédiat + progression ──


def test_flux_sain_premier_octet_rapide_et_progression(monkeypatch, tmp_path):
    """Un backend qui streame finit normalement, vite, avec une progression réelle.

    Vérifie aussi le contrat publié à l'UI : ``bytes_recv`` > 0 dès le 1er
    morceau, ``idle_s`` faible, ``backend_streaming`` = True.
    """
    probe = []
    healthy = _HealthyResponse(128, probe=probe)

    def fake_get(url, headers=None, stream=False, timeout=None, **kw):
        if url.endswith("/health"):
            return _HealthOk()
        if "download-info" in url:
            return _JsonResponse({"sftp": None, "size": 128})
        return healthy

    _patch(monkeypatch, tmp_path, fake_get)

    t0 = time.monotonic()
    res = _download()
    elapsed = time.monotonic() - t0

    assert res["success"] is True, res
    assert elapsed < 1.0, f"transfert sain anormalement lent : {elapsed:.2f} s"
    assert Path(res["path"]).read_bytes() == b"a" * 64 + b"b" * 64
    assert probe, "aucune progression observée pendant le transfert"
    assert probe[0]["bytes_recv"] > 0, (
        f"bytes_recv doit être publié dès le 1er morceau : {probe[0]}")
    assert probe[0].get("backend_streaming") is True, (
        "le marqueur backend_streaming doit être publié à l'UI")
    assert isinstance(probe[0].get("last_activity"), float), (
        "last_activity est nécessaire pour calculer idle_s")


def test_progress_publie_idle_s_et_backend_streaming():
    """Contrat /progress : ``idle_s`` et ``backend_streaming`` sont exposés.

    MUTATION : retirer l'un des deux champs → rouge (l'UI retombe sur un 0 %
    muet, exactement le symptôme signalé).
    """
    now = time.time()
    mm._download_progress["uid-progress"] = {
        "bytes_recv": 0, "bytes_total": 13_500_000_000, "speed_mbs": 0.0,
        "start": now - 42, "last_time": now,
        "backend_streaming": True, "last_activity": time.monotonic() - 30,
    }
    try:
        p = mm.get_download_progress("uid-progress")
        assert p is not None
        assert p["phase"] == "preparing"
        assert p["idle_s"] >= 29.0, p["idle_s"]
        assert p["backend_streaming"] is True
    finally:
        mm._download_progress.pop("uid-progress", None)


def test_timeout_requests_applique_est_le_seuil_de_blocage(monkeypatch, tmp_path):
    """La requête /download reçoit un read timeout = DOWNLOAD_STALL_TIMEOUT.

    C'est ce timeout qui borne l'attente même si le backend ne ferme jamais la
    connexion (préchargement). MUTATION : revenir à ``_server_side_timeout``
    (~56 min pour 13,5 Go) → rouge.
    """
    seen = {}

    def fake_get(url, headers=None, stream=False, timeout=None, **kw):
        if url.endswith("/health"):
            return _HealthOk()
        if "download-info" in url:
            return _JsonResponse({"sftp": None, "size": 128})
        seen["timeout"] = timeout
        return _HealthyResponse(128)

    _patch(monkeypatch, tmp_path, fake_get)
    monkeypatch.setattr(mm, "DOWNLOAD_STALL_TIMEOUT", 42.0)

    res = _download()
    assert res["success"] is True, res
    connect_t, read_t = seen["timeout"]
    assert connect_t == mm._SERVER_SYNC_CONNECT_TIMEOUT
    assert read_t == 42.0, (
        f"read timeout {read_t} != seuil de blocage : l'attente ne serait pas "
        "bornée (cas préchargement 13,5 Go)")
