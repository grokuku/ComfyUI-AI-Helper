# Copyright (C) 2026 Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# AIHRemoteComparer — branche « chaîne -> chemin de fichier » + non-régression.
#
# Contrat vérifié ici :
#   * UNE SEULE branche ajoutée : si A/B reçoit une CHAÎNE désignant un fichier
#     EXISTANT -> affichage du fichier (sans copie ni ré-encodage) ; TOUT LE
#     RESTE (tensor IMAGE, dict AUDIO {waveform, sample_rate}, dicts/objets
#     d'autres nodes) passe par le chemin existant, STRICTEMENT inchangé.
#   * Route GET /holaf/comparer/file : fichier servi TEL QUEL (Range + MIME),
#     refus (dossier / absent / chemin invalide) journalisés, jamais de listing.
#
# Le node n'est pas importable avec le venv de test (torch absent) : on injecte
# des stubs légers (torch / folder_paths / server) puis on charge le VRAI module
# du pack. C'est ce qui permet des contrôles négatifs par mutation qui MORDENT
# (casser la branche IMAGE, AUDIO, la détection de chemin, etc.).
#
# Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh

import asyncio
import importlib.util
import os
import sys
import types
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("aiohttp")
from aiohttp import ClientSession, web

PACK_DIR = Path(__file__).resolve().parent.parent
NODES_DIR = PACK_DIR / "nodes"
if str(NODES_DIR) not in sys.path:
    sys.path.insert(0, str(NODES_DIR))

ROUTE_PATH = "/holaf/comparer/file"


# ═══════════════════════════ Harnais de chargement ═══════════════════════════

class _FakeRoutes:
    """Shim décorateur : collecte les VRAIS handlers enregistrés au chargement."""

    def __init__(self):
        self.registered = []

    def _deco(self, method):
        def factory(path):
            def deco(handler):
                self.registered.append((method, path, handler))
                return handler
            return deco
        return factory

    def get(self, path):
        return self._deco("GET")(path)

    def post(self, path):
        return self._deco("POST")(path)


class _FakePromptServer:
    def __init__(self):
        self.routes = _FakeRoutes()


class _FakeFolderPaths(types.ModuleType):
    """folder_paths minimal : dossiers connus configurables par les tests."""

    def get_output_directory(self):
        return self.dirs.get("output")

    def get_input_directory(self):
        return self.dirs.get("input")

    def get_temp_directory(self):
        return self.dirs.get("temp")


_FAKE_SERVER = _FakePromptServer()
_FP = _FakeFolderPaths("folder_paths")
_FP.dirs = {}

_torch = types.ModuleType("torch")


class _TorchTensor:
    pass


_torch.Tensor = _TorchTensor
_server = types.ModuleType("server")
_server.PromptServer = _FakePromptServer
_server.PromptServer.instance = _FAKE_SERVER

# torch absent du venv de test : on l'audite via try/except. S'il est présent
# (environnement ComfyUI réel), nos faux tenseurs ne seraient pas de vrais
# torch.Tensor -> les tests tensor sont alors ignorés (jamais un faux PASS).
try:
    import torch as _real_torch  # noqa: F401
    _HAS_REAL_TORCH = True
except ImportError:
    _HAS_REAL_TORCH = False

sys.modules.setdefault("torch", _torch)
sys.modules.setdefault("folder_paths", _FP)
sys.modules.setdefault("server", _server)

_MODULE_NAME = "aih_remote_comparer_under_test"
if _MODULE_NAME in sys.modules:
    _NODE = sys.modules[_MODULE_NAME]
else:
    _spec = importlib.util.spec_from_file_location(_MODULE_NAME, NODES_DIR / "holaf_remote_comparer.py")
    _NODE = importlib.util.module_from_spec(_spec)
    sys.modules[_MODULE_NAME] = _NODE
    _spec.loader.exec_module(_NODE)

import holaf_comparer_paths as paths


def _route_handler(method="GET", path=ROUTE_PATH):
    for m, p, h in _FAKE_SERVER.routes.registered:
        if m == method and p == path:
            return h
    raise AssertionError(f"route {method} {path} non enregistrée")


# ═══════════════════════════ Stubs de tenseurs AUDIO/IMAGE ═══════════════════

class _ImageTensor(_TorchTensor):
    """Faux tensor IMAGE (chaîne .cpu().float()... factice, numpy() réel)."""

    def __init__(self, arr):
        self._arr = arr
        self.shape = arr.shape

    def __getitem__(self, i):
        return _ImageTensor(self._arr[i])

    def cpu(self):
        return self

    def float(self):
        return self

    def mul(self, *a):
        return self

    def clamp(self, *a):
        return self

    def byte(self):
        return self

    def numpy(self):
        return self._arr


class _Waveform:
    """Faux waveform audio (numpy() réel -> vrai WAV écrit)."""

    def __init__(self, arr):
        self._arr = arr

    def cpu(self):
        return self

    def float(self):
        return self

    def numpy(self):
        return self._arr


@pytest.fixture()
def env(tmp_path):
    """Dossiers connus (output/input/temp) pointés sur un tmp_path jetable."""
    out = tmp_path / "output"
    inp = tmp_path / "input"
    tmp = tmp_path / "temp"
    for d in (out, inp, tmp):
        d.mkdir()
    _FP.dirs = {"output": str(out), "input": str(inp), "temp": str(tmp)}
    return {"output": out, "input": inp, "temp": tmp, "root": tmp_path}


def _write(path: Path, data: bytes = b"x" * 256) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def _compare(**kwargs):
    node = _NODE.HolafRemoteComparerNode()
    res = node.compare(**kwargs)
    return res["ui"]["holaf_payload"][0]


# ═══════════════════════ 1. Branche « chaîne -> chemin » (nouveau) ═══════════

def test_string_path_to_image_is_direct(env):
    img = _write(env["output"] / "saved.png")
    payload = _compare(input_1=str(img))
    assert payload["media"][0]["direct"] is True
    assert payload["media"][0]["format"] == "image"
    assert payload["media"][0]["path"] == str(img)
    assert payload["media"][0]["filename"] == "saved.png"
    assert "errors" not in payload


def test_string_path_to_video_is_direct(env):
    vid = _write(env["output"] / "clip.mp4")
    payload = _compare(input_1=str(vid))
    assert payload["media"][0]["direct"] is True
    assert payload["media"][0]["format"] == "video"
    assert payload["media"][0]["path"] == str(vid)


def test_string_path_to_audio_is_direct(env):
    aud = _write(env["output"] / "track.flac")
    payload = _compare(input_1=str(aud))
    assert payload["media"][0]["direct"] is True
    assert payload["media"][0]["format"] == "audio"


def test_relative_filename_resolved_against_output(env):
    _write(env["output"] / "rel.webm")
    payload = _compare(input_1="rel.webm")
    assert payload["media"][0]["direct"] is True
    assert payload["media"][0]["format"] == "video"
    assert payload["media"][0]["path"].endswith(os.path.join("output", "rel.webm"))


def test_other_genre_is_direct_with_fallback_genre(env):
    """Fichier existant non média -> genre 'other' (repli explicite côté JS)."""
    txt = _write(env["output"] / "notes.txt")
    payload = _compare(input_1=str(txt))
    assert payload["media"][0]["direct"] is True
    assert payload["media"][0]["format"] == "other"


def test_non_path_string_is_ignored_silently(env):
    """Contrôle négatif : un mot/prompt n'est PAS traité comme un chemin."""
    payload = _compare(input_1="hello world / not a file")
    assert payload["media"] == []
    assert "errors" not in payload


def test_missing_media_path_is_explicit_error(env):
    """Contrôle négatif : un fichier absent n'est JAMAIS silencieux."""
    payload = _compare(input_1=str(env["output"] / "ghost.mp4"))
    assert payload["media"] == []
    assert payload["errors"][0]["code"] == "not_found"


def test_directory_path_is_refused(env):
    payload = _compare(input_1=str(env["output"]))
    assert payload["media"] == []
    assert payload["errors"][0]["code"] == "not_a_file"


def test_empty_string_is_ignored(env):
    payload = _compare(input_1="", input_2="   ")
    assert payload["media"] == []
    assert "errors" not in payload


# ═══════════════════════ 2. NON-RÉGRESSION des types existants ═══════════════

@pytest.mark.skipif(_HAS_REAL_TORCH, reason="faux tenseurs : nécessite le stub torch")
def test_tensor_image_still_encoded_as_before(env):
    """Un tensor IMAGE doit suivre le chemin tensor (copie temp), pas le chemin."""
    arr = np.zeros((1, 8, 8, 3), dtype=np.uint8)
    arr[..., 0] = 200
    payload = _compare(input_1=_ImageTensor(arr))
    meta = payload["media"][0]
    assert meta.get("direct") is not True
    assert meta["format"] == "image"
    assert meta["type"] == "temp"
    assert os.path.isfile(os.path.join(env["temp"], meta["filename"]))


def test_audio_dict_still_encoded_as_before(env):
    """Le dict AUDIO {waveform, sample_rate} reste STRICTEMENT inchangé."""
    wave_arr = np.zeros((1, 1000), dtype=np.float32)
    payload = _compare(input_1={"waveform": _Waveform(wave_arr), "sample_rate": 44100})
    meta = payload["media"][0]
    assert meta.get("direct") is not True
    assert meta["format"] == "audio"
    assert meta["type"] == "temp"
    assert meta["filename"].endswith(".wav")
    assert os.path.getsize(os.path.join(env["temp"], meta["filename"])) > 0


def test_other_node_dict_passthrough_unchanged(env):
    """Type « autre » constaté : dict VHS {"file": [path]} -> passthrough inchangé."""
    vid = _write(env["output"] / "vhs.mp4")
    payload = _compare(input_1={"file": [str(vid)]})
    meta = payload["media"][0]
    assert meta.get("direct") is not True
    assert meta["format"] == "video"
    assert meta["type"] == "temp"
    # Copie de passthrough créée (comportement historique conservé).
    assert os.path.isfile(os.path.join(env["temp"], meta["filename"]))


@pytest.mark.skipif(_HAS_REAL_TORCH, reason="faux tenseurs : nécessite le stub torch")
def test_tensor_and_string_coexist(env):
    """A = tensor IMAGE (inchangé), B = chaîne-chemin (nouveau)."""
    arr = np.zeros((1, 4, 4, 3), dtype=np.uint8)
    vid = _write(env["output"] / "b.mp4")
    payload = _compare(input_1=_ImageTensor(arr), input_2=str(vid))
    assert len(payload["media"]) == 2
    assert payload["media"][0]["format"] == "image"
    assert payload["media"][0].get("direct") is not True
    assert payload["media"][1]["direct"] is True
    assert payload["media"][1]["format"] == "video"


# ═══════════════════ 3. Analyse pure (analyse_input_string) ═════════════════

@pytest.mark.parametrize("name,genre", [
    ("a.png", "image"), ("a.jpg", "image"), ("a.webp", "image"),
    ("a.mp4", "video"), ("a.webm", "video"), ("a.mkv", "video"),
    ("a.wav", "audio"), ("a.mp3", "audio"), ("a.flac", "audio"),
])
def test_guess_genre(env, name, genre):
    p = _write(env["output"] / name)
    assert paths.guess_genre(str(p)) == genre


def test_guess_genre_unknown(env):
    p = _write(env["output"] / "a.txt")
    assert paths.guess_genre(str(p)) == "other"


def test_analyze_ignores_non_string(env):
    assert paths.analyze_input_string(None)[0] == "ignore"
    assert paths.analyze_input_string(123)[0] == "ignore"


def test_analyze_strips_quotes(env):
    p = _write(env["output"] / "q.mp4")
    kind, info = paths.analyze_input_string(f'"{p}"')
    assert kind == "media"
    assert info["path"] == str(p)


# ═══════════════════════ 4. Route : service TEL QUEL (Range/MIME) ═══════════

async def _http_get(handler, query="", headers=None):
    app = web.Application()
    app.router.add_get(ROUTE_PATH, handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    try:
        async with ClientSession() as session:
            async with session.get(f"http://127.0.0.1:{port}{ROUTE_PATH}{query}", headers=headers or {}) as resp:
                return resp.status, dict(resp.headers), await resp.read()
    finally:
        await runner.cleanup()


def test_route_serves_file_with_mime_and_range(env):
    body = bytes(range(256)) * 8
    vid = _write(env["output"] / "movie.mp4", body)
    handler = _route_handler()

    status, headers, data = asyncio.run(_http_get(handler, f"?path={vid}"))
    assert status == 200
    assert headers["Content-Type"].startswith("video/mp4")
    assert headers.get("Accept-Ranges") == "bytes"
    # AUCUN ré-encodage : les octets servis sont EXACTEMENT ceux du fichier.
    assert data == body

    status, headers, data = asyncio.run(_http_get(handler, f"?path={vid}", {"Range": "bytes=10-19"}))
    assert status == 206
    assert headers.get("Content-Range") == f"bytes 10-19/{len(body)}"
    assert data == body[10:20]


def test_route_image_and_audio_mime(env):
    png = _write(env["output"] / "pic.png", b"\x89PNG\r\n\x1a\n" + b"0" * 64)
    wav = _write(env["output"] / "s.wav", b"RIFF0000WAVE")
    handler = _route_handler()

    status, headers, _ = asyncio.run(_http_get(handler, f"?path={png}"))
    assert status == 200 and headers["Content-Type"].startswith("image/png")
    status, headers, _ = asyncio.run(_http_get(handler, f"?path={wav}"))
    assert status == 200 and headers["Content-Type"].startswith("audio/")


def test_route_missing_file_is_404(env):
    handler = _route_handler()
    status, _, body = asyncio.run(_http_get(handler, f"?path={env['output'] / 'nope.mp4'}"))
    assert status == 404
    assert b"not_found" in body


def test_route_directory_is_refused(env):
    handler = _route_handler()
    status, _, _ = asyncio.run(_http_get(handler, f"?path={env['output']}"))
    assert status == 415


def test_route_empty_path_is_400(env):
    handler = _route_handler()
    status, _, _ = asyncio.run(_http_get(handler))
    assert status == 400


def test_route_registered_on_prompt_server():
    assert _route_handler("GET", ROUTE_PATH) is not None
