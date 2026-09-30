"""Check d'existence par lot + écrasement EXPLICITE — routes réelles du pack.

Contexte (bug réel) : l'onglet 📤 Partager sautait les fichiers déjà présents
(déduplication par fingerprint côté ``aih/model_manager.py``) en les affichant
comme des succès, avec des débits absurdes (« 140 391 MB/s »). Le correctif :

  1. POST /api/aih/models/check   → check PAR LOT AVANT upload
     (``model_manager.check_models_on_server``) ;
  2. POST /api/aih/models/upload  → accepte ``overwrite: true`` = écrasement
     explicite choisi par l'utilisateur → la déduplication est SAUTÉE (les
     octets sont réellement renvoyés) ; sans drapeau, un fichier déjà présent
     est ignoré et la réponse porte ``deduplicated: true``.

Contrôles NÉGATIFS (mutation) intégrés :
  - ``test_upload_overwrite_skips_dedup`` : si ``overwrite`` était ignoré, le
    POST /files/check serait appelé (ou l'upload serait sauté) → rouge ;
  - ``test_upload_route_forwards_overwrite`` : si la route oubliait de
    transmettre le drapeau, ``overwrite`` resterait False → rouge ;
  - ``test_check_route_forwards_items`` : items non transmis → payload vide.

Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
"""

import asyncio
import json
import sys
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

# ── Faux réponses HTTP (requests) ────────────────────────────────────

class _FakeResponse:
    def __init__(self, data, status=200):
        self._data = data
        self.status_code = status
        self.ok = 200 <= status < 300
        self.text = json.dumps(data)

    def json(self):
        return self._data


class _Recorder:
    """Remplace ``requests`` : enregistre les appels et répond par URL."""

    def __init__(self, responses=None):
        self.calls = []
        self.responses = responses or {}

    def post(self, url, json=None, headers=None, timeout=None, **kw):
        self.calls.append({'url': url, 'json': json, 'headers': headers or {}, 'timeout': timeout})
        for fragment, resp in self.responses.items():
            if fragment in url:
                return resp
        return _FakeResponse({}, 404)


@pytest.fixture()
def model_manager():
    from aih import model_manager as mm

    return mm


# ── 1. Route /api/aih/models/check ───────────────────────────────────


def _build_check_app(monkeypatch, model_manager, fake_check):
    """App aiohttp réelle : ``_register_models_group`` + patch de la fonction."""
    monkeypatch.setattr(model_manager, "check_models_on_server", fake_check)
    routes = web.RouteTableDef()
    from aih import routes as aih_routes

    aih_routes._register_models_group(routes)
    app = web.Application()
    app.add_routes(routes)
    return app


def test_check_route_forwards_items(monkeypatch, model_manager):
    seen = {}

    def fake(items):
        seen['items'] = items
        return {'ok': True, 'error': None, 'items': [
            {'path': items[0]['path'], 'name': 'm.safetensors', 'type': 'checkpoint',
             'size': 10, 'status': 'identical', 'remote': {'upload_id': 'srv-1'},
             'error': None},
        ]}

    app = _build_check_app(monkeypatch, model_manager, fake)

    async def scenario():
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            resp = await client.post("/api/aih/models/check", json={
                "items": [{"path": "/models/m.safetensors", "type": "checkpoint"}],
            })
            assert resp.status == 200, await resp.text()
            data = await resp.json()
            assert data['ok'] is True
            assert data['items'][0]['status'] == 'identical' and data['items'][0]['name'] == 'm.safetensors'
            assert seen['items'] == [{"path": "/models/m.safetensors", "type": "checkpoint"}], \
                "les items fournis par le front doivent être transmis tels quels"
        finally:
            await client.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("payload", [{}, {"items": []}, {"items": "x"}, {"items": [{}] * 201}])
def test_check_route_rejects_bad_payload(monkeypatch, model_manager, payload):
    app = _build_check_app(monkeypatch, model_manager, lambda items: {'ok': True, 'error': None, 'items': []})

    async def scenario():
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            resp = await client.post("/api/aih/models/check", json=payload)
            assert resp.status == 400, f"payload {payload!r} doit être refusé"
        finally:
            await client.close()

    asyncio.run(scenario())


# ── 2. Route /api/aih/models/upload : drapeau overwrite ──────────────


@pytest.mark.parametrize("body_flag,expected", [(None, False), (True, True), (False, False)])
def test_upload_route_forwards_overwrite(monkeypatch, model_manager, tmp_path, body_flag, expected):
    model_file = tmp_path / "m.safetensors"
    model_file.write_bytes(b"x" * 32)
    seen = {}

    def fake_upload(filepath, file_type="model", on_progress=None, overwrite=False):
        seen.update(filepath=filepath, file_type=file_type, overwrite=overwrite)
        return {'success': True, 'upload_id': 'u1', 'file_path': 'p', 'deduplicated': False}

    monkeypatch.setattr(model_manager, "upload_model_to_server", fake_upload)
    routes = web.RouteTableDef()
    from aih import routes as aih_routes

    aih_routes._register_models_group(routes)
    app = web.Application()
    app.add_routes(routes)

    async def scenario():
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            body = {"path": str(model_file), "type": "checkpoint"}
            if body_flag is not None:
                body["overwrite"] = body_flag
            resp = await client.post("/api/aih/models/upload", json=body)
            assert resp.status == 200, await resp.text()
            assert seen['overwrite'] is expected, \
                f"overwrite à transmettre au manager : attendu {expected}, vu {seen['overwrite']}"
            assert seen['file_type'] == 'checkpoint'
        finally:
            await client.close()

    asyncio.run(scenario())


# ── 3. check_models_on_server : fusion réponse serveur ───────────────


def test_check_models_on_server_maps_backend_answer(monkeypatch, model_manager, tmp_path):
    requests_mod = pytest.importorskip("requests")
    rec = _Recorder({
        '/files/check-batch': _FakeResponse({'items': [
            {'filename': 'a.safetensors', 'status': 'identical',
             'remote': {'upload_id': 'srv-a', 'filename': 'a.safetensors', 'size': 3,
                        'file_path': 'workflows/models/srv-a/a.safetensors',
                        'created_at': '2026-05-01 10:00:00'}},
            {'filename': 'b.safetensors', 'status': 'different',
             'remote': {'upload_id': 'srv-b', 'filename': 'b.safetensors', 'size': 99,
                        'file_path': 'workflows/models/srv-b/b.safetensors',
                        'created_at': '2026-05-02 10:00:00'}},
        ]}),
    })
    monkeypatch.setattr(model_manager, "_get_aih_credentials",
                        lambda: ("https://aih.test/api", "k"))
    monkeypatch.setattr(requests_mod, "post", rec.post)

    a = tmp_path / "a.safetensors"
    a.write_bytes(b"aaa")
    b = tmp_path / "b.safetensors"
    b.write_bytes(b"b" * 10)

    result = model_manager.check_models_on_server([
        {'path': str(a), 'type': 'checkpoint'},
        {'path': str(b), 'type': 'lora'},
        {'path': str(tmp_path / "absent-du-disque.safetensors"), 'type': 'vae'},
    ])

    assert result['ok'] is True
    items = {i['name']: i for i in result['items']}
    assert items['a.safetensors']['status'] == 'identical'
    assert items['a.safetensors']['remote']['upload_id'] == 'srv-a'
    assert items['b.safetensors']['status'] == 'different'
    assert items['b.safetensors']['remote']['size'] == 99
    assert items['absent-du-disque.safetensors']['status'] == 'unknown'
    assert 'introuvable' in items['absent-du-disque.safetensors']['error']
    # Le payload envoyé porte bien filename + empreinte (contrat backend).
    sent = rec.calls[0]['json']['items']
    assert {i['filename'] for i in sent} == {'a.safetensors', 'b.safetensors'}
    assert sent[0]['size'] == 3 and sent[0]['head'] and sent[0]['tail']
    assert rec.calls[0]['headers'].get('Authorization') == 'Bearer k'
    # Aucune fuite d'objet interne (_fp) dans la réponse publique.
    assert all('_fp' not in i for i in result['items'])


def test_check_models_on_server_degrades_without_config(monkeypatch, model_manager, tmp_path):
    monkeypatch.setattr(model_manager, "_get_aih_credentials", lambda: ("", ""))
    model = tmp_path / "c.safetensors"
    model.write_bytes(b"ccc")

    result = model_manager.check_models_on_server([{'path': str(model), 'type': 'checkpoint'}])
    assert result['ok'] is False, "serveur non configuré → ok=false (l'upload n'est PAS bloqué)"
    assert result['items'][0]['status'] == 'unknown'
    assert 'non configuré' in result['items'][0]['error']


def test_check_models_on_server_degrades_on_network_error(monkeypatch, model_manager, tmp_path):
    requests_mod = pytest.importorskip("requests")

    def boom(*a, **k):
        raise OSError("réseau indisponible")

    monkeypatch.setattr(model_manager, "_get_aih_credentials",
                        lambda: ("https://aih.test/api", "k"))
    monkeypatch.setattr(requests_mod, "post", boom)
    model = tmp_path / "d.safetensors"
    model.write_bytes(b"dddd")

    result = model_manager.check_models_on_server([{'path': str(model), 'type': 'lora'}])
    assert result['ok'] is False
    assert result['items'][0]['status'] == 'unknown'
    assert 'réseau' in result['items'][0]['error']


# ── 4. upload_model_to_server : overwrite saute la déduplication ─────


def _patch_upload_requests(monkeypatch, model_manager, responses):
    requests_mod = pytest.importorskip("requests")
    rec = _Recorder(responses)
    monkeypatch.setattr(model_manager, "_get_aih_credentials",
                        lambda: ("https://aih.test/api", "k"))
    monkeypatch.setattr(requests_mod, "post", rec.post)
    return rec


def test_upload_without_overwrite_dedup_skips(monkeypatch, model_manager, tmp_path):
    """Sans overwrite, un fichier déjà présent est IGNORÉ (aucun octet) — le
    résultat doit le DIRE (``deduplicated: true``) pour que l'UI n'affiche pas
    un faux succès de transfert."""
    rec = _patch_upload_requests(monkeypatch, model_manager, {
        '/files/check': _FakeResponse({'exists': True, 'upload_id': 'srv-old',
                                       'file_path': 'workflows/models/srv-old/x.bin'}),
    })
    model = tmp_path / "x.bin"
    model.write_bytes(b"x" * 64)

    result = model_manager.upload_model_to_server(str(model), "model")
    assert result['success'] is True and result['deduplicated'] is True
    assert result['upload_id'] == 'srv-old'
    assert not any('/files/init' in c['url'] for c in rec.calls), \
        "dédupliqué → AUCUN init d'upload (aucun octet ne doit partir)"


def test_upload_overwrite_skips_dedup(monkeypatch, model_manager, tmp_path):
    """overwrite=True : la déduplication est SAUTÉE — coché = réellement remplacé.

    Mutation : ignorer ``overwrite`` ferait renvoyer ``deduplicated: true``
    (ou un appel /files/check) → ce test rougit.
    """
    rec = _patch_upload_requests(monkeypatch, model_manager, {
        '/files/init': _FakeResponse({'upload_id': 'new-1', 'chunk_size': 25 * 1024 * 1024,
                                      'total_chunks': 1}),
        '/files/chunk': _FakeResponse({'received': 0}),
        '/files/complete': _FakeResponse({'upload_id': 'new-1', 'file_path': 'workflows/models/new-1/x.bin'}),
        '/files/check': _FakeResponse({'exists': True, 'upload_id': 'srv-old',
                                       'file_path': 'workflows/models/srv-old/x.bin'}),
    })
    model = tmp_path / "x.bin"
    model.write_bytes(b"x" * 64)

    result = model_manager.upload_model_to_server(str(model), "model", overwrite=True)
    assert result['success'] is True
    assert result.get('deduplicated') is not True, "overwrite ne doit PAS être dédupliqué"
    assert result['upload_id'] == 'new-1', "un NOUVEL upload remplace l'ancien"
    urls = [c['url'] for c in rec.calls]
    assert not any('/files/check' in u for u in urls), \
        "overwrite → la pré-vérification de dédup ne doit même pas être appelée"
    assert any('/files/init' in u for u in urls), "overwrite → nouvel upload réel"
    assert any('/files/chunk' in u for u in urls), "overwrite → les octets sont renvoyés"


def test_upload_without_overwrite_transfers_when_absent(monkeypatch, model_manager, tmp_path):
    rec = _patch_upload_requests(monkeypatch, model_manager, {
        '/files/check': _FakeResponse({'exists': False}),
        '/files/init': _FakeResponse({'upload_id': 'new-2', 'chunk_size': 25 * 1024 * 1024,
                                      'total_chunks': 1}),
        '/files/chunk': _FakeResponse({'received': 0}),
        '/files/complete': _FakeResponse({'upload_id': 'new-2', 'file_path': 'workflows/models/new-2/x.bin'}),
    })
    model = tmp_path / "x.bin"
    model.write_bytes(b"x" * 64)

    result = model_manager.upload_model_to_server(str(model), "model")
    assert result['success'] is True
    assert result.get('deduplicated') is False
    assert result['upload_id'] == 'new-2'
    urls = [c['url'] for c in rec.calls]
    assert any('/files/check' in u for u in urls), "sans overwrite, la dédup reste consultée"
    assert any('/files/complete' in u for u in urls)


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
