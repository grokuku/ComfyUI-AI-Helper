"""Repli silencieux (une fois) du ``base_path`` hors du dossier autorisé.

CONTEXTE RÉEL (log du worker Modal, à CHAQUE sauvegarde) :

    base_path '/config/outputs/ComfyUI/' resolves outside allowed directory
    '/root/comfy/ComfyUI/output'. Falling back.

Ce ``base_path`` vient d'une configuration conçue pour la machine LOCALE : le
worker le refuse (garde-fou de sécurité) et retombe sur son propre dossier de
sortie. Le repli est CORRECT — c'est sa répétition qui noie les vraies erreurs
(un rendu de 200 images produisait 200 lignes identiques).

Contrat verrouillé ici :
  1. le GARDE-FOU reste intact : un chemin hors zone n'est jamais retourné ;
  2. le WARNING complet n'est émis qu'UNE fois par chemin (ensuite DEBUG) ;
  3. un chemin DIFFÉRENT est bien signalé à son tour (on ne confond pas
     « déjà vu » et « tout taire ») ;
  4. idem pour ``validate_subfolder`` ;
  5. ``reset_path_fallback_warnings()`` réarme le premier avertissement.

MUTANT M1 : revenir à un ``logger.warning`` inconditionnel ⇒ §2 ROUGE.
MUTANT M2 : retourner ``base_path`` au lieu du repli ⇒ §1 ROUGE.

Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
"""

import logging
import sys
from pathlib import Path

import pytest

PACK_DIR = Path(__file__).resolve().parent.parent
if str(PACK_DIR) not in sys.path:
    sys.path.insert(0, str(PACK_DIR))

# ── torch / folder_paths : absents du venv de dev (import HORS ComfyUI) ────
# Ces tests importent le VRAI module du pack. Le venv de dev n'a ni torch ni
# folder_paths : on pose des stubs MINIMAUX le temps de l'import, puis on les
# RETIRE de sys.modules (sinon les autres fichiers de tests hériteraient d'un
# faux `torch` — `torch.nn` casserait, par exemple).
_STUBBED = []


def _load_helpers():
    """Importe ``nodes/holaf_node_helpers`` avec des stubs JETABLES."""
    if "holaf_node_helpers" in sys.modules:
        return sys.modules["holaf_node_helpers"]
    import importlib
    import types

    for name in ("torch", "folder_paths"):
        if name in sys.modules:
            continue
        try:
            __import__(name)
            continue
        except ImportError:
            pass
        if name == "torch":
            stub = types.ModuleType("torch")

            class _StubTensor:  # seuls `shape` / `ndim` sont lus par les nodes
                pass

            stub.Tensor = _StubTensor
        else:
            stub = types.ModuleType("folder_paths")
            stub.get_output_directory = lambda: "/root/comfy/ComfyUI/output"
            stub.base_path = "/root/comfy/ComfyUI"
        sys.modules[name] = stub
        _STUBBED.append(name)
    try:
        return importlib.import_module("nodes.holaf_node_helpers")
    finally:
        for name in _STUBBED:
            sys.modules.pop(name, None)
        _STUBBED.clear()

ALLOWED = "/root/comfy/ComfyUI/output"
OUTSIDE = "/config/outputs/ComfyUI/"


@pytest.fixture(scope="module")
def H():
    """Le VRAI module du pack (stubs torch/folder_paths limités à son import)."""
    return _load_helpers()


@pytest.fixture(autouse=True)
def _fresh_warnings(H):
    """Chaque test part d'un état vierge (le registre est global au process)."""
    H.reset_path_fallback_warnings()
    yield
    H.reset_path_fallback_warnings()


class _Capture(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.records = []

    def emit(self, record):
        self.records.append(record)

    def messages(self, level):
        return [r.getMessage() for r in self.records if r.levelname == level]


@pytest.fixture
def captured(H):
    handler = _Capture()
    H.logger.addHandler(handler)
    previous = H.logger.level
    H.logger.setLevel(logging.DEBUG)
    try:
        yield handler
    finally:
        H.logger.removeHandler(handler)
        H.logger.setLevel(previous)


# ═══════════════ 1. Le garde-fou de sécurité reste EN PLACE ═════════════════


def test_outside_path_still_falls_back(H):
    """MUTANT M2 : rendre le chemin hors zone ⇒ ce test devient ROUGE."""
    assert H.validate_base_path(OUTSIDE, ALLOWED) == ALLOWED


def test_inside_path_is_returned_unchanged(H):
    assert H.validate_base_path("/root/comfy/ComfyUI/output/sub", ALLOWED) == \
        "/root/comfy/ComfyUI/output/sub"
    assert H.validate_base_path(ALLOWED, ALLOWED) == ALLOWED


def test_subfolder_escape_is_still_discarded(H):
    assert H.validate_subfolder("/root/comfy/ComfyUI/output", "../secret", ALLOWED) == ""
    assert H.validate_subfolder("/root/comfy/ComfyUI/output", "ok/sub", ALLOWED) == "ok/sub"


# ══════════════ 2. Un seul WARNING, même chemin, plusieurs sauvegardes ══════


def test_warning_is_emitted_once_only(H, captured):
    """MUTANT M1 : warning inconditionnel ⇒ 5 lignes au lieu d'une ⇒ ROUGE."""
    for _ in range(5):
        assert H.validate_base_path(OUTSIDE, ALLOWED) == ALLOWED

    warnings = captured.messages("WARNING")
    assert len(warnings) == 1, f"attendu 1 WARNING, obtenu {len(warnings)} : {warnings}"
    assert OUTSIDE in warnings[0]
    assert ALLOWED in warnings[0], "le repli appliqué est cité"
    assert "une seule fois" in warnings[0], "l'utilisateur sait pourquoi il ne le revoit plus"

    # Les appels suivants restent observables en DEBUG (aucune perte d'info).
    debug = captured.messages("DEBUG")
    assert len(debug) == 4, f"les replis suivants doivent passer en DEBUG : {debug}"


def test_a_different_path_gets_its_own_warning(H, captured):
    H.validate_base_path(OUTSIDE, ALLOWED)
    H.validate_base_path("/autre/chemin/absolu/", ALLOWED)

    warnings = captured.messages("WARNING")
    assert len(warnings) == 2, "un autre chemin est une autre anomalie"


def test_subfolder_warning_is_also_emitted_once(H, captured):
    for _ in range(3):
        H.validate_subfolder(ALLOWED, "../../etc", ALLOWED)

    warnings = captured.messages("WARNING")
    assert len(warnings) == 1
    assert "subfolder" in warnings[0]
    assert captured.messages("DEBUG"), "les répétitions restent en DEBUG"


def test_reset_rearms_the_warning(H, captured):
    H.validate_base_path(OUTSIDE, ALLOWED)
    H.reset_path_fallback_warnings()
    H.validate_base_path(OUTSIDE, ALLOWED)

    assert len(captured.messages("WARNING")) == 2
