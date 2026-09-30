"""Téléchargement d'un modèle : résolution type → dossier local ComfyUI.

Contexte (BUG A — capture « 8 modèles annoncés, 6 téléchargés », les 2 manquants
étant l'unet et le clip) : l'hypothèse (a) « un type non géré est sauté » a été
écartée AVEC PREUVE. Ce test verrouille la table ``type_to_cat`` de
``aih/model_manager.download_model_from_server`` pour les types en cause :

  - ``unet``  → dossier ``unet``       (ne retombe PAS sur ``checkpoints``) ;
  - ``clip``  → dossier ``clip``       (ne retombe PAS sur ``checkpoints``) ;
  - ``text_encoder``   → ``text_encoders`` ;
  - ``diffusion_model`` → ``diffusion_models`` ;
  - un type inconnu → ``checkpoints`` (fallback documenté).

Un test vérifie aussi qu'un ``dest_path`` portant un sous-dossier est créé sous
le dossier du type (le « bon emplacement »).

Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
"""

import os
import sys
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))


class _InfoResponse:
    """Réponse ``/files/<id>/download-info`` (pas de SFTP → chemin HTTP)."""

    def __init__(self, data):
        self._data = data
        self.ok = True
        self.status_code = 200

    def json(self):
        return self._data


class _StreamResponse:
    """Réponse ``/files/<id>/download`` en flux (corps + Content-Length)."""

    def __init__(self, payload=b""):
        self._payload = payload
        self.ok = True
        self.status_code = 200
        self.headers = {"Content-Length": str(len(payload))}
        self.text = ""

    def iter_content(self, chunk_size=1024 * 1024):
        for i in range(0, len(self._payload), chunk_size):
            yield self._payload[i:i + chunk_size]


def _patch(monkeypatch, model_manager, dirs, download_payload=b"payload-bytes"):
    """Patche creds, dossiers de modèles et ``requests.get`` (route par URL)."""
    requests_mod = pytest.importorskip("requests")
    monkeypatch.setattr(model_manager, "_get_aih_credentials", lambda: ("https://aih.test/api", "k"))
    monkeypatch.setattr(model_manager, "_get_model_dirs", lambda: dirs)
    calls = []

    def fake_get(url, headers=None, stream=False, timeout=None, **kw):
        calls.append(url)
        if "download-info" in url:
            return _InfoResponse({"sftp": None, "size": len(download_payload)})
        if "/download" in url:
            return _StreamResponse(download_payload)
        return _StreamResponse(b"")

    monkeypatch.setattr(requests_mod, "get", fake_get)
    return calls


def _dirs(tmp_path, *cats):
    out = {}
    for cat in cats:
        d = tmp_path / cat
        d.mkdir(parents=True, exist_ok=True)
        out[cat] = [str(d)]
    return out


@pytest.mark.parametrize("file_type,expected_cat", [
    # Types du BUG A : doivent aller dans LEUR dossier, pas checkpoints.
    ("unet", "unet"),
    ("clip", "clip"),
    ("upscale", "upscale_models"),
    ("vae", "vae"),
    # Types voisins (renommages ComfyUI) conservés.
    ("text_encoder", "text_encoders"),
    ("diffusion_model", "diffusion_models"),
    ("clip_vision", "clip_vision"),
    ("lora", "loras"),
    ("checkpoint", "checkpoints"),
    # Type inconnu → fallback documenté.
    ("inconnu-xyz", "checkpoints"),
])
def test_download_routes_type_to_local_folder(monkeypatch, tmp_path, file_type, expected_cat):
    from aih import model_manager as mm

    dirs = _dirs(tmp_path, "unet", "clip", "upscale_models", "vae",
                 "text_encoders", "diffusion_models", "clip_vision", "loras", "checkpoints")
    _patch(monkeypatch, mm, dirs)

    res = mm.download_model_from_server("uid-1", "model.safetensors", file_type)
    assert res["success"] is True, res
    expected_path = os.path.join(dirs[expected_cat][0], "model.safetensors")
    assert res["path"] == expected_path, (
        f"type '{file_type}' → attendu sous '{expected_cat}', obtenu {res['path']}")
    assert (tmp_path / expected_cat / "model.safetensors").read_bytes() == b"payload-bytes"


def test_download_creates_subdir_for_dest_path(monkeypatch, tmp_path):
    from aih import model_manager as mm

    dirs = _dirs(tmp_path, "unet")
    _patch(monkeypatch, mm, dirs)

    res = mm.download_model_from_server("uid-2", "orig.safetensors", "unet",
                                        dest_path="sub/dir/renamed.safetensors")
    assert res["success"] is True, res
    assert res["path"] == os.path.join(dirs["unet"][0], "sub", "dir", "renamed.safetensors")
    assert (tmp_path / "unet" / "sub" / "dir" / "renamed.safetensors").is_file()


def test_download_rejects_path_escape(monkeypatch, tmp_path):
    from aih import model_manager as mm

    dirs = _dirs(tmp_path, "unet")
    _patch(monkeypatch, mm, dirs)

    res = mm.download_model_from_server("uid-3", "x.safetensors", "unet",
                                        dest_path="../../escape.safetensors")
    assert res["success"] is False and "Invalid destination path" in res["error"]
    assert not (tmp_path.parent / "escape.safetensors").exists()


def test_download_no_dir_for_type_fails_clearly(monkeypatch, tmp_path):
    """Sans dossier pour le type demandé ET sans fallback : erreur explicite."""
    from aih import model_manager as mm

    # dirs SANS 'checkpoints' → le fallback n'existe pas.
    dirs = {"unet": [str(tmp_path / "unet")]}
    (tmp_path / "unet").mkdir()
    _patch(monkeypatch, mm, dirs)

    res = mm.download_model_from_server("uid-4", "x.safetensors", "checkpoint")
    assert res["success"] is False
    assert "No model directory" in res["error"]


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
