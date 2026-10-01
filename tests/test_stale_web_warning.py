# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Avertissement de démarrage (NON bloquant) : une ancienne copie de NOS scripts
# web (``js/02_aih_model_browser.js`` sans marqueur de build ``AIH_MB_BUILD``)
# servie par un AUTRE dossier chargeable de ``custom_nodes/`` peut écraser
# ``window.openModelBrowser`` (UI ancienne sans bouton « Transferts »).
#
# La détection doit être basée sur la PREUVE (contenu du fichier : marqueur
# d'appartenance ``openModelBrowser`` présent, marqueur de build absent) et
# JAMAIS sur le nom du dossier — un futur pack légitime nommé
# ``ComfyUI-Holaf*`` avec un fichier à jour doit rester totalement silencieux.
#
# Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh

import hashlib
import sys
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

from holaf_startup_checks import (  # noqa: E402
    find_stale_own_web_copies,
    run_startup_checks,
)

CURRENT_JS = (
    'var AIH_MB_BUILD = "mb-transfers-2026-09-30-r7";\n'
    "(function () { window.openModelBrowser = function () {}; })();\n"
)
STALE_JS = (
    "/* copy made before build markers existed */\n"
    "(function () { window.openModelBrowser = function () {}; })();\n"
)
NOT_OURS_JS = "/* some unrelated pack */\nwindow.somethingElse = function () {};\n"


def _make_sibling(parent: Path, name: str, js_text=STALE_JS, with_init=True):
    sibling = parent / name
    (sibling / "js").mkdir(parents=True)
    if with_init:
        (sibling / "__init__.py").write_text("# pack\n", encoding="utf-8")
    (sibling / "js" / "02_aih_model_browser.js").write_text(js_text, encoding="utf-8")
    return sibling


def _snapshot(root: Path) -> dict:
    out = {}
    for path in sorted(root.rglob("*")):
        rel = str(path.relative_to(root))
        out[rel] = "<dir>" if path.is_dir() else hashlib.sha256(path.read_bytes()).hexdigest()
    return out


@pytest.mark.parametrize("name", [
    "ComfyUI-Holaf-Utilities",
    "ComfyUI-Holaf",
    "ComfyUI-Holaf-Utils",
    "Totally-Other-Pack",
])
def test_stale_copy_flagged_by_content_not_by_name(tmp_path, name):
    current = tmp_path / "ComfyUI-AI-Helper"
    current.mkdir()
    sibling = _make_sibling(tmp_path, name, STALE_JS)

    found = find_stale_own_web_copies(str(current))

    assert found == [str(sibling / "js" / "02_aih_model_browser.js")], \
        "la preuve est le contenu (openModelBrowser sans marqueur), pas le nom du dossier"


@pytest.mark.parametrize("name", ["ComfyUI-Holaf-Utilities", "ComfyUI-Holaf", "Totally-Other-Pack"])
def test_current_file_in_legacy_named_folder_is_silent(tmp_path, name):
    current = tmp_path / "ComfyUI-AI-Helper"
    current.mkdir()
    _make_sibling(tmp_path, name, CURRENT_JS)

    assert find_stale_own_web_copies(str(current)) == [], \
        "un pack (même historique) dont le JS est à jour ne doit produire AUCUN bruit"


def test_file_that_is_not_one_of_ours_is_ignored(tmp_path):
    current = tmp_path / "ComfyUI-AI-Helper"
    current.mkdir()
    _make_sibling(tmp_path, "Some-Pack", NOT_OURS_JS)

    assert find_stale_own_web_copies(str(current)) == []


def test_not_loadable_sibling_is_ignored(tmp_path):
    """Sans __init__.py, ComfyUI ne charge pas le dossier : aucun risque de double import."""
    current = tmp_path / "ComfyUI-AI-Helper"
    current.mkdir()
    _make_sibling(tmp_path, "ComfyUI-Holaf-Utilities", STALE_JS, with_init=False)

    assert find_stale_own_web_copies(str(current)) == []


def test_current_folder_is_never_self_flagged(tmp_path):
    current = _make_sibling(tmp_path, "ComfyUI-Holaf-Utilities", STALE_JS, with_init=True)

    assert find_stale_own_web_copies(str(current)) == []


def test_warning_is_loud_actionable_and_read_only(tmp_path, capsys):
    current = tmp_path / "ComfyUI-AI-Helper"
    current.mkdir()
    sibling = _make_sibling(tmp_path, "ComfyUI-Holaf-Utilities", STALE_JS)
    before = _snapshot(sibling)

    run_startup_checks(str(current))

    out = capsys.readouterr().out
    assert "ANCIENNE COPIE" in out
    assert str(sibling / "js" / "02_aih_model_browser.js") in out
    assert "openModelBrowser" in out           # explique le symptôme réel
    assert "AUCUN fichier n'a été modifié" in out  # prouve que rien n'est touché
    assert _snapshot(sibling) == before, "l'avertissement ne doit RIEN modifier"
    assert not (sibling / ".aih_quarantine").exists()
    assert (sibling / "__init__.py").is_file()


def test_warning_silent_when_nothing_proven(tmp_path, capsys):
    current = tmp_path / "ComfyUI-AI-Helper"
    current.mkdir()
    _make_sibling(tmp_path, "ComfyUI-Holaf-Utilities", CURRENT_JS)

    assert run_startup_checks(str(current)) == []
    assert capsys.readouterr().out == ""


def test_no_output_when_no_sibling(tmp_path, capsys):
    current = tmp_path / "ComfyUI-AI-Helper"
    current.mkdir()
    run_startup_checks(str(current))
    assert capsys.readouterr().out == ""


def test_current_pack_model_browser_carries_the_build_marker():
    """Contrat du marqueur : le fichier RÉEL du pack en a un (sinon la détection
    crierait en permanence sur notre propre fichier)."""
    text = (PACKAGE_DIR / "js" / "02_aih_model_browser.js").read_text(encoding="utf-8")
    assert "AIH_MB_BUILD" in text
    assert "openModelBrowser" in text


if __name__ == "__main__":  # pragma: no cover
    sys.exit(pytest.main([__file__, "-q"]))
