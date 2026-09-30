"""Progression de téléchargement : contrat ``phase`` + ``elapsed_s``.

Contexte (signalement « aucune fenêtre pour suivre la progression ») : la
fenêtre dédiée (js/aih_download_window.js) doit distinguer explicitement la
PHASE SERVEUR (« préparation côté serveur… », aucun octet — phase qui durait
des dizaines de minutes avec l'ancien backend qui préchargeait 13,5 Go du
stockage vers un temp) de la PHASE DE TRANSFERT (%, MB/s). Le contrat de
``/api/aih/models/download/progress`` expose donc ``phase`` et ``elapsed_s``.

Contrôles négatifs (mutation) intégrés :
  - retirer ``phase``            → test_phase_preparing rouge (KeyError) ;
  - forcer ``phase='transferring'`` → test_phase_preparing rouge ;
  - calculer le pourcentage sur des octets négatifs/absents → tests rouges.

Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
"""

import sys
import time
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent.parent
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

import pytest  # noqa: E402

from aih import model_manager as mm  # noqa: E402


@pytest.fixture(autouse=True)
def _cleanup_progress():
    yield
    mm._download_progress.pop("dl-progress-uid", None)


def _seed(bytes_recv, bytes_total, elapsed=5.0, speed=0.0):
    now = time.time()
    mm._download_progress["dl-progress-uid"] = {
        "bytes_recv": bytes_recv,
        "bytes_total": bytes_total,
        "speed_mbs": speed,
        "start": now - elapsed,
        "last_time": now,
    }


def test_phase_preparing_quand_aucun_octet():
    """Aucun octet reçu → ``preparing`` (l'UI affiche « préparation serveur »).

    Mutation : retirer la clé ``phase`` ou la forcer à ``transferring`` rougit.
    """
    _seed(0, 13500000000)
    p = mm.get_download_progress("dl-progress-uid")
    assert p is not None
    assert p["phase"] == "preparing", f"0 octet doit être 'preparing', obtenu {p['phase']}"
    assert p["percent"] == 0
    assert p["elapsed_s"] >= 5.0, "elapsed_s doit refléter le temps écoulé (ETA côté UI)"


def test_phase_transferring_des_premiers_octets():
    _seed(5000000000, 13500000000, elapsed=10.0, speed=12.5)
    p = mm.get_download_progress("dl-progress-uid")
    assert p["phase"] == "transferring"
    assert 37.0 <= p["percent"] <= 37.1, p["percent"]
    assert p["bytes_recv"] == 5000000000
    assert p["bytes_total"] == 13500000000
    assert p["speed_mbs"] == 12.5
    assert p["elapsed_s"] >= 10.0


def test_progress_absent_renvoie_none():
    """Upload inconnu : ``None`` (l'UI garde la phase locale « préparation »)."""
    assert mm.get_download_progress("uid-inexistant") is None


def test_bytes_total_nul_ne_divise_pas_par_zero():
    """``bytes_total`` inconnu (en-tête absent) : 0 % sans crash."""
    _seed(1024, 0)
    p = mm.get_download_progress("dl-progress-uid")
    assert p["percent"] == 0.0
    assert p["phase"] == "transferring"  # des octets circulent déjà
