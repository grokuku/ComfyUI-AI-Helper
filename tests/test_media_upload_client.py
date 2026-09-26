"""Tests standalone du client d'upload média (aih/media_upload.py).

Couvre :
  1. sanitization / construction du chemin serveur (miroir du backend) ;
  2. le protocole chunké du node : init → chunk(s) → complete (requests stubbé) ;
  3. l'ÉCHEC DUR (refus de sauvegarde serveur) : serveur non configuré,
     init/chunk/complete en erreur → MediaUploadError (aucun repli local) ;
  4. l'ORDRE du widget `save_to_server` avant `base_path` dans INPUT_TYPES
     (contrat de placement confirmé côté node).

aih/media_upload.py n'a que des imports légers au niveau module (os/re/logging ;
requests est importé paresseusement), donc on le charge directement via
importlib (le dossier du pack contient un tiret, il n'est pas importable comme
package).

Usage :
  pytest tests/test_media_upload_client.py
  python3 tests/test_media_upload_client.py
"""

import importlib.util
import re
import sys
from pathlib import Path

import pytest

PACK_DIR = Path(__file__).resolve().parent.parent
MEDIA_UPLOAD_PATH = PACK_DIR / "aih" / "media_upload.py"
NODE_PATH = PACK_DIR / "nodes" / "holaf_save_media.py"


def _load_media_upload():
    spec = importlib.util.spec_from_file_location("aih_media_upload_under_test", MEDIA_UPLOAD_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


mu = _load_media_upload()


# ── Stub requests ──────────────────────────────────────────────────────

class _FakeResp:
    def __init__(self, status_code=200, json_data=None, text=""):
        self.status_code = status_code
        self.ok = 200 <= status_code < 300
        self._json = json_data
        self.text = text

    def json(self):
        if self._json is None:
            raise ValueError("no json")
        return self._json


class _FakeRequests:
    """Capture les appels post() et renvoie des réponses scriptées."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if not self._responses:
            raise AssertionError(f"appel post() inattendu : {url}")
        return self._responses.pop(0)


@pytest.fixture()
def fake_requests(monkeypatch):
    def _install(responses):
        stub = _FakeRequests(responses)
        monkeypatch.setitem(sys.modules, "requests", stub)
        return stub

    return _install


@pytest.fixture(autouse=True)
def _configured(monkeypatch):
    """Par défaut, credentials configurés (surchargé dans les tests dédiés)."""
    monkeypatch.setattr(mu, "_get_credentials", lambda: ("https://aih.test/api", "secret-key"))


# ── 1. Sanitization / chemin ───────────────────────────────────────────

def test_sanitize_subfolder():
    assert mu.sanitize_subfolder("2025-01-01") == "2025-01-01"
    assert mu.sanitize_subfolder("a/b") == "a/b"
    assert mu.sanitize_subfolder("../../etc") == "etc"
    assert mu.sanitize_subfolder("a/../b") == "a/b"
    assert mu.sanitize_subfolder("..\\..\\x") == "x"
    assert mu.sanitize_subfolder("") == ""


def test_sanitize_base_filename():
    assert mu.sanitize_base_filename("clip") == "clip"
    assert mu.sanitize_base_filename("..\\..\\evil") == "evil"
    assert mu.sanitize_base_filename("a/b") == "a_b"
    assert mu.sanitize_base_filename("") == "untitled"


def test_build_remote_path_confines():
    p = mu.build_remote_path("../../u", "../../s", "..\\..\\n", ".png")
    assert ".." not in p
    assert "\\" not in p
    assert p.startswith("media/")
    assert p.endswith("/n.png")


def test_normalize_kind_and_ext():
    assert mu.normalize_kind("IMAGE") == "image"
    with pytest.raises(mu.MediaUploadError):
        mu.normalize_kind("exe")
    assert mu.normalize_ext("PNG") == ".png"
    assert mu.normalize_ext(".webp") == ".webp"
    mu.validate_ext("image", ".png")
    with pytest.raises(mu.MediaUploadError):
        mu.validate_ext("image", ".mp4")


# ── 2. Protocole chunké (requests stubbé) ──────────────────────────────

def test_upload_media_chunked_sequence(tmp_path, fake_requests):
    media = tmp_path / "clip.png"
    media.write_bytes(b"abcdefgh")  # 8 octets → 2 chunks de 4

    stub = fake_requests([
        _FakeResp(200, {"upload_id": "u1", "chunk_size": 4, "total_chunks": 2}),
        _FakeResp(200, {"received": 0}),
        _FakeResp(200, {"received": 1}),
        _FakeResp(200, {"id": 7, "path": "media/u/sub/clip.png", "filename": "clip.png"}),
    ])

    progress = []
    result = mu.upload_media(
        str(media), subfolder="sub", filename_base="clip", ext=".png", kind="image",
        prompt="a cat", workflow='{"nodes": []}', on_progress=lambda a, b: progress.append((a, b)),
    )

    assert result["success"] is True
    assert result["path"] == "media/u/sub/clip.png"
    assert progress == [(1, 2), (2, 2)]

    urls = [u for u, _ in stub.calls]
    assert urls[0].endswith("/media/init")
    assert urls[1].endswith("/media/chunk") and urls[2].endswith("/media/chunk")
    assert urls[3].endswith("/media/complete")

    init_kwargs = stub.calls[0][1]
    assert init_kwargs["json"]["prompt"] == "a cat"
    assert init_kwargs["json"]["workflow"] == '{"nodes": []}'
    assert init_kwargs["headers"]["Authorization"] == "Bearer secret-key"


# ── 3. Échec DUR ───────────────────────────────────────────────────────

def test_upload_raises_when_server_not_configured(tmp_path, monkeypatch):
    monkeypatch.setattr(mu, "_get_credentials", lambda: ("", ""))
    media = tmp_path / "x.png"
    media.write_bytes(b"abc")
    with pytest.raises(mu.MediaUploadError):
        mu.upload_media(str(media), subfolder="", filename_base="x", ext=".png", kind="image")


def test_upload_raises_when_api_key_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(mu, "_get_credentials", lambda: ("https://aih.test/api", ""))
    media = tmp_path / "x.png"
    media.write_bytes(b"abc")
    with pytest.raises(mu.MediaUploadError):
        mu.upload_media(str(media), subfolder="", filename_base="x", ext=".png", kind="image")


def test_upload_raises_on_init_error(tmp_path, fake_requests):
    media = tmp_path / "x.png"
    media.write_bytes(b"abc")
    fake_requests([_FakeResp(500, {"error": "boom"})])
    with pytest.raises(mu.MediaUploadError):
        mu.upload_media(str(media), subfolder="", filename_base="x", ext=".png", kind="image")


def test_upload_raises_on_chunk_error_and_skips_complete(tmp_path, fake_requests):
    media = tmp_path / "x.png"
    media.write_bytes(b"abcdefgh")
    stub = fake_requests([
        _FakeResp(200, {"upload_id": "u1", "chunk_size": 4, "total_chunks": 2}),
        _FakeResp(500, {"error": "chunk refusé"}),
    ])
    with pytest.raises(mu.MediaUploadError):
        mu.upload_media(str(media), subfolder="", filename_base="x", ext=".png", kind="image")
    assert not any(u.endswith("/media/complete") for u, _ in stub.calls)


# ── 4. Ordre du widget dans INPUT_TYPES ────────────────────────────────

def test_save_to_server_before_base_path():
    src = NODE_PATH.read_text(encoding="utf-8")
    i_toggle = src.find('"save_to_server": ("BOOLEAN"')
    i_base = src.find('"base_path": ("STRING"')
    assert i_toggle != -1 and i_base != -1
    assert i_toggle < i_base, "save_to_server doit être déclaré avant base_path"
    assert re.search(r'"save_to_server": \("BOOLEAN", \{"default": False\}\)', src)
