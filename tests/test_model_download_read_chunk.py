# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Download de modèle : la boucle de lecture HTTP doit rendre la main SOUVENT.
#
# Contexte (capture utilisateur) : débit 1,3 Mo/s affiché mais progression de la
# fenêtre de transferts figée entre deux mises à jour et annulation inopérante
# pendant de longues secondes. Cause : la boucle réutilisait ``CHUNK_SIZE``
# (25 Mo, taille d'UPLOAD) comme ``chunk_size`` de ``iter_content`` — à faible
# débit, un morceau de 25 Mo = ~19 s sans mise à jour (au-delà du seuil
# « serveur muet » de 15 s) et sans point d'annulation.
#
# Correctif verrouillé ici : ``DOWNLOAD_READ_CHUNK`` (1 Mo) est utilisé pour la
# lecture de la réponse de download, jamais ``CHUNK_SIZE``.
#
# Contrôles négatifs par mutation (chacun DOIT faire rougir ce fichier) :
#   M1  remettre ``chunk_size=CHUNK_SIZE`` (25 Mo)   → chunk demandé ≠ 1 Mo et
#       la 1re mise à jour de progression arrive en fin de fichier → rouge ;
#   M2  descendre ``DOWNLOAD_READ_CHUNK`` à 4 Ko     → borne basse → rouge ;
#   M3  monter ``DOWNLOAD_READ_CHUNK`` à 8 Mo        → borne haute → rouge.
#
# Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh

import sys
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

requests_mod = pytest.importorskip("requests")

from aih import model_manager as mm  # noqa: E402

API = "https://aih.test/api"
UID = "uid-chunk"


class _JsonResponse:
    def __init__(self, data=None, status_code=200):
        self._data = data if data is not None else {}
        self.status_code = status_code
        self.ok = 200 <= status_code < 300
        self.text = ""

    def json(self):
        return self._data


class _RecordingResponse:
    """Réponse /download qui enregistre la ``chunk_size`` DEMANDÉE.

    Elle yield par morceaux de ``chunk_size`` (comme un vrai serveur qui ne
    peut pas forcer la main au client) et fige la progression APRÈS chaque
    morceau consommé.
    """

    def __init__(self, payload):
        self.payload = payload
        self.headers = {"Content-Length": str(len(payload))}
        self.status_code = 200
        self.ok = True
        self.text = ""
        self.requested_chunk_sizes = []
        self.samples = []
        self.closed = False

    def iter_content(self, chunk_size=1024 * 1024):
        self.requested_chunk_sizes.append(chunk_size)
        pos = 0
        while pos < len(self.payload):
            chunk = self.payload[pos:pos + chunk_size]
            pos += len(chunk)
            yield chunk
            self.samples.append(dict(mm._download_progress.get(UID, {})))

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


def _download():
    return mm.download_model_from_server(UID, "model.safetensors", "unet")


def _fake_get(response):
    def fake_get(url, headers=None, stream=False, timeout=None, **kw):
        if url.endswith("/health"):
            return _JsonResponse({
                "ok": True,
                "features": {"download_streaming": True},
            })
        if url.endswith("/download-info"):
            return _JsonResponse({
                "filename": "model.safetensors",
                "size": len(response.payload),
                "file_path": "models/model.safetensors",
            })
        if url.endswith("/download"):
            return response
        raise AssertionError(f"appel inattendu : {url}")
    return fake_get


# ── 1. Morceau de lecture 1 Mo + progression dès le 1er morceau ───────


def test_chunk_de_lecture_1mo_et_progression_par_morceau(monkeypatch, tmp_path):
    payload = bytes(range(256)) * 4096 * 6  # 6 Mo → 6 morceaux d'1 Mo
    resp = _RecordingResponse(payload)
    _patch(monkeypatch, tmp_path, _fake_get(resp))

    res = _download()

    assert res["success"] is True, res
    assert resp.requested_chunk_sizes == [mm.DOWNLOAD_READ_CHUNK], (
        "la lecture du download doit demander DOWNLOAD_READ_CHUNK — pas "
        f"CHUNK_SIZE ({mm.CHUNK_SIZE}) : {resp.requested_chunk_sizes}")
    assert mm.DOWNLOAD_READ_CHUNK >= 1024 * 1024, (
        f"DOWNLOAD_READ_CHUNK={mm.DOWNLOAD_READ_CHUNK} : trop petit, des frais "
        "par morceau s'ajoutent au transfert")
    assert mm.DOWNLOAD_READ_CHUNK <= 4 * 1024 * 1024, (
        f"DOWNLOAD_READ_CHUNK={mm.DOWNLOAD_READ_CHUNK} : trop gros, la "
        "progression et l'annulation se figent entre deux morceaux")
    assert len(resp.samples) >= 6, (
        f"{len(resp.samples)} mise(s) à jour de progression pour 6 Mo : la "
        "fenêtre de transferts resterait muette pendant des secondes")
    first = resp.samples[0]
    assert 0 < first.get("bytes_recv", 0) < len(payload), (
        "la 1re mise à jour de progression doit arriver après le 1er MORCEAU, "
        f"pas en fin de fichier : {first}")
    assert resp.samples[-1]["bytes_recv"] == len(payload), resp.samples[-1]

    dest = Path(tmp_path / "unet" / "model.safetensors")
    assert dest.read_bytes() == payload, "fichier final complet"
    assert not Path(str(dest) + ".part").exists(), "partiel nettoyé après succès"


# ── 2. Le chemin de lecture reste celui du streaming HTTP ─────────────


def test_download_utilise_le_flux_http_stream(monkeypatch, tmp_path):
    payload = b"\x5a" * (2 * 1024 * 1024)
    resp = _RecordingResponse(payload)
    seen = {}

    def fake_get(url, headers=None, stream=False, timeout=None, **kw):
        if url.endswith("/health"):
            return _JsonResponse({"ok": True, "features": {"download_streaming": True}})
        if url.endswith("/download-info"):
            return _JsonResponse({"filename": "model.safetensors",
                                  "size": len(payload), "file_path": "models/x"})
        if url.endswith("/download"):
            seen["stream"] = stream
            return resp
        raise AssertionError(url)

    _patch(monkeypatch, tmp_path, fake_get)
    res = _download()

    assert res["success"] is True, res
    assert seen.get("stream") is True, (
        "le download doit lire la réponse en streaming (pas de préchargement "
        "complet en mémoire)")
    assert not (tmp_path / "unet" / "model.safetensors.part").exists()
