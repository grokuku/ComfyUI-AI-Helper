"""Détection d'un pack legacy ENCORE chargé par ComfyUI (double import front).

Contexte (bug « le bouton Transferts et la fenêtre n'apparaissent pas ») : la
migration ne supprime JAMAIS le dossier legacy ``ComfyUI-Holaf-Utilities``.
Or ComfyUI charge TOUT dossier de ``custom_nodes/`` exposant ``WEB_DIRECTORY``.
Si le dossier legacy existe encore, ses anciens scripts ``js/`` sont servis
sous un SECOND préfixe ``/extensions/ComfyUI-Holaf-Utilities/`` et importés EN
PARALLÈLE des nouveaux : deux copies de ``02_aih_model_browser.js`` coexistent
dans la même page, et une copie périmée peut écraser ``window.openModelBrowser``
(UI ancienne sans bouton « Transferts » ni fenêtre de transferts, alors que le
fichier servi et ``window.AIH_MB.build`` sont à jour).

``find_legacy_extension_double_load`` est la détection pure verrouillée ici ;
``_warn_legacy_double_load`` la rend BRUYANTE à chaque démarrage.

Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
"""

import sys
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

from holaf_migration import (  # noqa: E402  (après le bootstrap sys.path)
    LEGACY_EXTENSION_DIR_NAME,
    _warn_legacy_double_load,
    find_legacy_extension_double_load,
)


def _make_pack(root: Path, name: str, loadable: bool = True) -> Path:
    pack = root / name
    pack.mkdir(parents=True)
    if loadable:
        (pack / "__init__.py").write_text("# pack\n", encoding="utf-8")
        (pack / "js").mkdir()
    return pack


def test_legacy_folder_with_init_is_detected(tmp_path):
    current = _make_pack(tmp_path, "ComfyUI-AI-Helper")
    legacy = _make_pack(tmp_path, LEGACY_EXTENSION_DIR_NAME)
    assert find_legacy_extension_double_load(current) == str(legacy)


def test_legacy_folder_without_init_is_not_loadable(tmp_path):
    current = _make_pack(tmp_path, "ComfyUI-AI-Helper")
    legacy = tmp_path / LEGACY_EXTENSION_DIR_NAME
    legacy.mkdir()
    # Sans __init__.py, ComfyUI ne charge PAS le dossier : aucune alerte.
    assert find_legacy_extension_double_load(current) is None


def test_no_legacy_folder_is_silent(tmp_path):
    current = _make_pack(tmp_path, "ComfyUI-AI-Helper")
    assert find_legacy_extension_double_load(current) is None


def test_current_folder_named_legacy_is_not_self_flagged(tmp_path):
    # Cas « extension encore exécutée depuis son dossier legacy » : current
    # porte lui-même le nom legacy → pas de faux positif.
    current = _make_pack(tmp_path, LEGACY_EXTENSION_DIR_NAME)
    assert find_legacy_extension_double_load(current) is None


def test_missing_current_dir_never_raises(tmp_path):
    assert find_legacy_extension_double_load(tmp_path / "absent") is None


def test_warning_is_loud_and_actionable(tmp_path, capsys):
    current = _make_pack(tmp_path, "ComfyUI-AI-Helper")
    _make_pack(tmp_path, LEGACY_EXTENSION_DIR_NAME)
    _warn_legacy_double_load(current)
    out = capsys.readouterr().out
    assert "DOUBLE CHARGEMENT" in out
    assert LEGACY_EXTENSION_DIR_NAME in out
    assert "openModelBrowser" in out  # explique le symptôme réel
    assert "supprimer" in out  # remède actionnable


def test_warning_silent_without_legacy(tmp_path, capsys):
    current = _make_pack(tmp_path, "ComfyUI-AI-Helper")
    _warn_legacy_double_load(current)
    assert capsys.readouterr().out == ""


if __name__ == "__main__":  # pragma: no cover
    sys.exit(pytest.main([__file__, "-q"]))
