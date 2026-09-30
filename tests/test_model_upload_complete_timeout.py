"""Timeout de la FINALISATION d'upload (``/files/complete``) — bug « gros modèles ».

Contexte (bug réel, capture utilisateur) : à l'upload de gros modèles vers le
serveur AIH, la modale de pré-upload affichait

    Erreur: Complete failed: HTTPSConnectionPool(host='aih.holaf.fr', port=443):
    Read timed out. (read timeout=60)

pour ``Krea2-Turbo-int8-ConvRot.safetensors`` (13 477,5 Mo) et
``qwen3-vl-4b-heritic_int8.safetensors`` (4 612,9 Mo), alors que 447 Mo,
1 490 Mo, 242 Mo et 1,6 Mo passaient (statut « écrasé » ♻️).

CAUSE RACINE : ``upload_model_to_server`` (aih/model_manager.py) appelait
``POST /files/complete`` avec un timeout FIXE de 60 s. Or cette route est
SYNCHRONE côté backend : elle recopie le fichier temporaire COMPLET (reçu chunk
par chunk) vers le stockage réel (SFTPStorage.upload / LocalStorage.upload)
AVANT de répondre — le client ne reçoit donc aucun octet pendant toute la
durée, et le « read timeout » de requests s'applique à la DURÉE TOTALE. Au-delà
de ~60 s de finalisation (les gros fichiers, dès ~1,5-4,6 Go selon le débit),
la requête était coupée alors que le transfert des octets, lui, avait réussi.

CORRECTIF : le timeout est dimensionné SUR LA TAILLE du fichier
(``aih/model_manager.py::_server_side_timeout``, débit plancher 4 Mo/s) :
13,5 Go → ~56 min de budget, 4,6 Go → ~19 min, petit fichier → plancher 5 min.

Contrôles NÉGATIFS (mutation) intégrés — chacun DOIT rougir si le code régresse :
  - ``test_complete_uses_scaled_timeout_not_60`` : remettre ``timeout=60``
    (ou tout plafond fixe) à l'appel ``/files/complete`` → le timeout capturé
    n'est plus celui du helper → rouge ;
  - ``test_timeout_scales_with_size`` : revenir à un plafond constant → les
    assertions 13,5 Go / 4,6 Go > 60 s rougissent ;
  - ``test_complete_slow_server_explicit_error`` : si l'erreur redevenait un
    texte ambigu (« timeout » nu), l'assertion sur le message explicite rougit ;
  - ``test_progress_reports_finalizing_phase`` : si la finalisation longue
    n'était plus exposée, l'UI retomberait sur une barre figée muette → rouge.

Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
"""

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

MB = 1024 * 1024


# ── Faux ``requests`` (enregistre les timeouts réellement utilisés) ──

class _FakeResponse:
    def __init__(self, data, status=200):
        self._data = data
        self.status_code = status
        self.ok = 200 <= status < 300
        self.text = json.dumps(data)

    def json(self):
        return self._data


class _Recorder:
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


def _patch_requests(monkeypatch, mm, responses):
    requests_mod = pytest.importorskip("requests")
    rec = _Recorder(responses)
    monkeypatch.setattr(mm, "_get_aih_credentials",
                        lambda: ("https://aih.test/api", "k"))
    monkeypatch.setattr(requests_mod, "post", rec.post)
    return rec


# ── 1. Dimensionnement du timeout ────────────────────────────────────

def test_timeout_scales_with_size(model_manager):
    """Le budget de finalisation DOIT croître avec la taille.

    L'ancien plafond fixe de 60 s est exactement ce qui faisait échouer 4,6 Go
    et 13,5 Go : toute régression vers une constante est détectée ici.
    """
    small = model_manager._server_side_timeout(1 * MB)
    mid = model_manager._server_side_timeout(1490 * MB)
    failed_46 = model_manager._server_side_timeout(int(4612.9 * MB))
    failed_135 = model_manager._server_side_timeout(int(13477.5 * MB))

    # connect court + read croissant
    for size_label, t in (('1 Mo', small), ('1490 Mo', mid),
                          ('4,6 Go', failed_46), ('13,5 Go', failed_135)):
        assert isinstance(t, tuple) and len(t) == 2, f"{size_label} : (connect, read) attendu"
        assert t[0] <= 60, f"{size_label} : le connect timeout doit rester court"

    # Les deux tailles qui ÉCHOUAIENT doivent avoir un budget > 60 s (l'ancien
    # plafond fautif) — et largement, pas à la limite.
    assert failed_46[1] > 60, "4,6 Go : budget > 60 s (ancien plafond fautif)"
    assert failed_135[1] > 60, "13,5 Go : budget > 60 s (ancien plafond fautif)"
    assert failed_135[1] > failed_46[1] > mid[1] >= small[1], "budget monotone avec la taille"
    # Un petit fichier garde un plancher raisonnable (pas de timeout nul/absurde).
    assert small[1] >= model_manager._SERVER_SYNC_MIN_TIMEOUT


def test_timeout_never_returns_invalid_budget(model_manager):
    """Taille manquante/absurde → plancher, jamais de timeout nul (qui
    désactiverait toute borne) ni d'exception."""
    floor = model_manager._SERVER_SYNC_MIN_TIMEOUT
    for bad in (0, -5, None, 'abc', ''):
        t = model_manager._server_side_timeout(bad)
        assert t[1] == floor, f"taille {bad!r} → plancher {floor}s attendu"


# ── 2. Le timeout du helper est RÉELLEMENT utilisé à l'appel ─────────

def test_complete_uses_scaled_timeout_not_60(monkeypatch, model_manager, tmp_path):
    """``/files/complete`` doit recevoir le timeout dimensionné, jamais 60 s.

    Mutation : remettre ``timeout=60`` à l'appel → le timeout capturé n'est
    plus le sentinelle du helper → rouge.
    """
    sentinel = (7, 4242.0)
    seen = {}

    def fake_timeout(size):
        seen['size'] = size
        return sentinel

    monkeypatch.setattr(model_manager, "_server_side_timeout", fake_timeout)
    rec = _patch_requests(monkeypatch, model_manager, {
        '/files/check': _FakeResponse({'exists': False}),
        '/files/init': _FakeResponse({'upload_id': 'u-timeout',
                                      'chunk_size': 25 * MB, 'total_chunks': 1}),
        '/files/chunk': _FakeResponse({'received': 0}),
        '/files/complete': _FakeResponse({'upload_id': 'u-timeout',
                                          'file_path': 'workflows/models/u-timeout/x.bin'}),
    })
    model = tmp_path / "x.bin"
    model.write_bytes(b"x" * (2 * MB))

    result = model_manager.upload_model_to_server(str(model), "model", overwrite=True)
    assert result['success'] is True, result

    complete_calls = [c for c in rec.calls if c['url'].endswith('/files/complete')]
    assert len(complete_calls) == 1
    assert complete_calls[0]['timeout'] == sentinel, \
        "le timeout de /files/complete doit être celui du helper (dimensionné sur la taille)"
    assert complete_calls[0]['timeout'] != 60, "retour au plafond fautif de 60 s"
    assert seen['size'] == 2 * MB, "le helper doit recevoir la taille du fichier"

    # Les AUTRES étapes gardent leur propre budget (non régressées).
    chunk_calls = [c for c in rec.calls if c['url'].endswith('/files/chunk')]
    assert chunk_calls and chunk_calls[0]['timeout'] == 300, \
        "le timeout par chunk (300 s) ne doit pas être impacté"


def test_source_has_no_fixed_complete_timeout(model_manager):
    """Verrou statique : plus aucun ``timeout=60`` sur l'appel /files/complete."""
    src = (PACKAGE_DIR / "aih" / "model_manager.py").read_text(encoding="utf-8")
    # Appel réel (f-string) — pas la mention dans les commentaires de tête.
    idx = src.index('f"{api_url}/files/complete"')
    window = src[idx:idx + 400]
    assert "timeout=60" not in window, "plafond fixe de 60 s réintroduit (bug des gros modèles)"
    assert "timeout=timeout" in window, "l'appel doit passer le timeout dimensionné"


# ── 3. Preuve end-to-end : un serveur LENT est bien couvert ──────────

class _SlowCompleteHandler(BaseHTTPRequestHandler):
    """Faux backend AIH : ``/files/complete`` répond après ``delay`` secondes."""

    delay = 0.0
    paths = []

    def log_message(self, *a):  # silence
        pass

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        type(self).paths.append(self.path)
        length = int(self.headers.get('Content-Length') or 0)
        if length:
            self.rfile.read(length)  # consomme le corps (chunk / json)
        path = self.path.split('?')[0]
        if path.endswith('/files/check'):
            return self._json({'exists': False})
        if path.endswith('/files/init'):
            return self._json({'upload_id': 'slow-1', 'chunk_size': 25 * MB, 'total_chunks': 1})
        if path.endswith('/files/chunk'):
            return self._json({'received': 0})
        if path.endswith('/files/complete'):
            # SIMULE la recopie synchrone côté serveur : AUCUN octet renvoyé
            # avant la fin → c'est exactement ce qui déclenche le read timeout.
            time.sleep(type(self).delay)
            return self._json({'upload_id': 'slow-1',
                               'file_path': 'workflows/models/slow-1/x.bin'})
        return self._json({'error': 'not found'}, 404)


@pytest.fixture()
def slow_server():
    _SlowCompleteHandler.delay = 0.0
    _SlowCompleteHandler.paths = []
    srv = ThreadingHTTPServer(('127.0.0.1', 0), _SlowCompleteHandler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield srv
    srv.shutdown()
    srv.server_close()


def _patch_credentials_to(monkeypatch, mm, port):
    monkeypatch.setattr(mm, "_get_aih_credentials",
                        lambda: (f"http://127.0.0.1:{port}/api", "k"))


def test_complete_slow_server_times_out_with_explicit_error(monkeypatch, model_manager,
                                                            tmp_path, slow_server):
    """Un complete plus long que le budget → erreur EXPLICITE (étape, taille,
    budget), et surtout un message qui n'est plus un « timeout » ambigu.

    Preuve que le timeout est bien appliqué à la requête : le serveur dort
    au-delà du budget → requests lève réellement un ReadTimeout.
    """
    _SlowCompleteHandler.delay = 1.2
    # Budget volontairement minuscule pour ne pas dormir 5 min dans le test.
    monkeypatch.setattr(model_manager, "_server_side_timeout", lambda size: (2, 0.3))
    _patch_credentials_to(monkeypatch, model_manager, slow_server.server_address[1])

    model = tmp_path / "gros.safetensors"
    model.write_bytes(b"x" * 4096)

    result = model_manager.upload_model_to_server(str(model), "model", overwrite=True)

    assert result['success'] is False
    err = result['error']
    assert err.startswith('Complete failed'), err
    assert 'finalisation serveur' in err, f"étape non explicite : {err}"
    assert '4096 octets' in err, f"taille absente du message : {err}"
    assert 'timeout read 0s' in err, f"budget absent du message : {err}"
    # Aucun octet de résultat n'a été renvoyé avant la coupure → read timeout.
    assert 'timed out' in err.lower() or 'timeout' in err.lower(), err
    # Aucune entrée de progression résiduelle (pas de ligne fantôme « en cours »).
    assert model_manager.get_upload_progress(str(model)) is None


def test_complete_slow_server_succeeds_when_budget_covers_it(monkeypatch, model_manager,
                                                             tmp_path, slow_server):
    """Le MÊME serveur lent aboutit dès que le budget couvre la finalisation —
    c'est exactement ce que le correctif apporte aux gros fichiers (le transfert
    est long mais borné par la taille, plus par 60 s)."""
    _SlowCompleteHandler.delay = 0.6
    monkeypatch.setattr(model_manager, "_server_side_timeout", lambda size: (2, 30))
    _patch_credentials_to(monkeypatch, model_manager, slow_server.server_address[1])

    model = tmp_path / "gros.safetensors"
    model.write_bytes(b"x" * 4096)

    result = model_manager.upload_model_to_server(str(model), "model", overwrite=True)

    assert result['success'] is True, result
    assert result['upload_id'] == 'slow-1'
    assert any(p.endswith('/files/complete') for p in _SlowCompleteHandler.paths)
    assert model_manager.get_upload_progress(str(model)) is None, \
        "progression nettoyée après finalisation"


# ── 4. Progression : la finalisation n'est plus muette ───────────────

def test_progress_reports_finalizing_phase(monkeypatch, model_manager):
    """Pendant la finalisation, /upload/progress doit l'annoncer (phase
    ``finalizing`` + 100 %) au lieu de renvoyer None (barre figée muette)."""
    path = "/models/gros.safetensors"
    monkeypatch.setitem(model_manager._upload_progress, path, {
        'chunk': 540, 'total': 540, 'speed_mbs': 11.2,
        'start': time.time(), 'phase': 'finalizing',
    })
    p = model_manager.get_upload_progress(path)
    assert p is not None, "la finalisation ne doit PAS disparaître de l'UI"
    assert p['phase'] == 'finalizing'
    assert p['percent'] == 100.0
    assert p['speed_mbs'] == 11.2

    # Phase normale : inchangée (aucune régression du débit réel).
    monkeypatch.setitem(model_manager._upload_progress, path, {
        'chunk': 5, 'total': 10, 'speed_mbs': 9.9,
        'start': time.time(), 'phase': 'uploading',
    })
    p = model_manager.get_upload_progress(path)
    assert p['phase'] == 'uploading' and p['percent'] == 50.0 and p['speed_mbs'] == 9.9


def test_front_handles_finalizing_phase():
    """Verrou statique côté JS : le front affiche la finalisation (i18n FR/EN)
    et la note est retirée quand le résultat arrive."""
    js = (PACKAGE_DIR / "js" / "aih_workflow_share.js").read_text(encoding="utf-8")
    assert "p.phase === 'finalizing'" in js, "le front doit détecter la phase finalizing"
    assert 'wf.uploadFinalizing' in js, "libellé de finalisation manquant"
    assert 'r.finalizingNote.remove()' in js, "la note de finalisation doit être retirée au résultat"

    strings = (PACKAGE_DIR / "js" / "aih_strings.js").read_text(encoding="utf-8")
    en_idx = strings.index("const EN = {")
    token = '"wf.uploadFinalizing"'
    assert strings.index(token) < en_idx, "clé wf.uploadFinalizing absente du bloc FR"
    assert strings.index(token, en_idx) > 0, "clé wf.uploadFinalizing absente du bloc EN"


# ── 5. Le download est concerné par le MÊME piège (préchargement serveur) ──

def test_download_uses_scaled_timeout(model_manager):
    """Le download HTTP précharge TOUT le fichier côté serveur avant de
    streame : un timeout fixe (600 s) y reproduirait le même bug sur les gros
    fichiers. Il doit lui aussi être dimensionné sur la taille."""
    src = (PACKAGE_DIR / "aih" / "model_manager.py").read_text(encoding="utf-8")
    idx = src.index('f"{api_url}/files/{upload_id}/download"')
    window = src[idx:idx + 400]
    assert "timeout=600" not in window, "plafond fixe de 600 s réintroduit sur le download"
    assert "_server_side_timeout(" in window, "le download doit utiliser le budget dimensionné"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
