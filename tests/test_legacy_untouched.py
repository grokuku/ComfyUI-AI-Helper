# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# INVARIANT (correction utilisateur) : les dossiers ``ComfyUI-Holaf-Utilities``,
# ``ComfyUI-Holaf`` et ``ComfyUI-Holaf-Utils`` ne sont PAS spéciaux. L'utilisateur
# peut un jour recréer un pack légitime sous ces noms : ce pack ne doit donc
# JAMAIS les bloquer, ni créer/écrire/déplacer/renommer/quarantiner quoi que ce
# soit dans un de ces dossiers.
#
# Ce fichier verrouille :
#   - le démarrage (``run_startup_checks``) ne crée ni ne modifie AUCUN dossier
#     (photo avant/après octet à octet, y compris la base SQL et le __init__.py) ;
#   - l'installation via Workflow Share (``aih``) est NORMALE pour ces noms
#     (le clone est réellement lancé, plus aucun refus) ;
#   - l'installation ET la mise à jour via le Nodes Manager (``nodes``) sont
#     NORMALES pour ces noms.
#
# Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh

import hashlib
import importlib.util
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

import holaf_startup_checks  # noqa: E402

LEGACY_NAMES = (
    "ComfyUI-Holaf-Utilities",
    "ComfyUI-Holaf",
    "ComfyUI-Holaf-Utils",
)

_PKG = "holaf_legacy_untouched_pkg"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _snapshot(root: Path) -> dict:
    """Photo récursive d'un dossier : relpath → contenu ou '<dir>'."""
    out = {}
    for path in sorted(root.rglob("*")):
        rel = str(path.relative_to(root))
        if path.is_dir():
            out[rel] = "<dir>"
        else:
            out[rel] = hashlib.sha256(path.read_bytes()).hexdigest()
    return out


def _make_legacy_sibling(parent: Path, name: str) -> Path:
    """Un faux « ancien pack » complet : __init__, js/ ancien (sans marqueur), base SQL."""
    legacy = parent / name
    (legacy / "js").mkdir(parents=True)
    (legacy / "__init__.py").write_text("WEB_DIRECTORY = 'js'\n", encoding="utf-8")
    (legacy / "js" / "02_aih_model_browser.js").write_text(
        "/* stale copy, no build marker */\n"
        "(function () { window.openModelBrowser = function () {}; })();\n",
        encoding="utf-8",
    )
    (legacy / "holaf_utilities.sqlite").write_bytes(b"SQLite format 3\x00LEGACY-DATA")
    return legacy


def _load_module(module_name: str, file_path: Path):
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _load_cnm():
    """Charge ``aih/custom_nodes_manager.py`` comme sous-module d'un package factice."""
    if _PKG not in sys.modules:
        pkg = types.ModuleType(_PKG)
        pkg.__path__ = [str(PACKAGE_DIR)]
        sys.modules[_PKG] = pkg
    name = f"{_PKG}.custom_nodes_manager"
    spec = importlib.util.spec_from_file_location(name, PACKAGE_DIR / "aih" / "custom_nodes_manager.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _load_nodes_manager(tmp_path, monkeypatch, module_name):
    monkeypatch.setitem(sys.modules, "folder_paths",
                        SimpleNamespace(base_path=str(tmp_path)))
    return _load_module(module_name, PACKAGE_DIR / "nodes" / "holaf_nodes_manager.py")


# ---------------------------------------------------------------------------
# 1. Le démarrage ne crée ni ne touche rien (photo avant/après)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("name", LEGACY_NAMES)
def test_startup_checks_never_touch_a_legacy_named_folder(tmp_path, name):
    pack = tmp_path / "ComfyUI-AI-Helper"
    pack.mkdir()
    legacy = _make_legacy_sibling(tmp_path, name)
    before = _snapshot(legacy)

    holaf_startup_checks.run_startup_checks(str(pack))

    assert _snapshot(legacy) == before, \
        f"run_startup_checks ne doit RIEN modifier dans le dossier '{name}'"
    assert not (legacy / ".aih_quarantine").exists(), "aucune quarantaine ne doit être créée"
    assert (legacy / "__init__.py").is_file(), "le __init__.py du pack doit rester en place"
    assert (legacy / "holaf_utilities.sqlite").read_bytes() == b"SQLite format 3\x00LEGACY-DATA", \
        "la base SQL du dossier voisin ne doit jamais être déplacée ni modifiée"


def test_startup_checks_create_no_legacy_folder_when_absent(tmp_path):
    pack = tmp_path / "ComfyUI-AI-Helper"
    pack.mkdir()

    holaf_startup_checks.run_startup_checks(str(pack))

    assert sorted(p.name for p in tmp_path.iterdir()) == ["ComfyUI-AI-Helper"]


def test_startup_checks_are_silent_and_never_raise_without_siblings(tmp_path, capsys):
    pack = tmp_path / "ComfyUI-AI-Helper"
    pack.mkdir()

    assert holaf_startup_checks.run_startup_checks(str(pack)) == []
    assert capsys.readouterr().out == ""


# ---------------------------------------------------------------------------
# 2. Workflow Share (aih) : l'installation d'un nom historique est NORMALE
# ---------------------------------------------------------------------------

def test_workflow_share_install_allows_legacy_name(tmp_path, monkeypatch):
    cnm = _load_cnm()
    monkeypatch.setattr(cnm, "_CUSTOM_NODES_DIR", str(tmp_path))

    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(list(cmd))
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(cnm.subprocess, "run", fake_run)

    result = cnm._install_custom_node(
        "https://github.com/Holaf/ComfyUI-Holaf-Utilities", "ComfyUI-Holaf-Utilities"
    )

    assert result["success"] is True, result
    assert [str(tmp_path / "ComfyUI-Holaf-Utilities")] == [c[-1] for c in calls], \
        "git clone doit réellement être lancé vers le dossier demandé"
    assert "Refused" not in result["message"]


def test_workflow_share_install_allows_legacy_url_only(tmp_path, monkeypatch):
    """Le nom de dossier déduit de l'URL historique n'est plus un motif de refus."""
    cnm = _load_cnm()
    monkeypatch.setattr(cnm, "_CUSTOM_NODES_DIR", str(tmp_path))

    calls = []
    monkeypatch.setattr(cnm.subprocess, "run",
                        lambda cmd, **kwargs: (calls.append(list(cmd))
                                               or SimpleNamespace(returncode=0, stdout="", stderr="")))

    result = cnm._install_custom_node("https://github.com/Holaf/ComfyUI-Holaf", "")

    assert result["success"] is True, result
    assert [str(tmp_path / "ComfyUI-Holaf")] == [c[-1] for c in calls]


def test_workflow_share_install_allows_current_pack_name(tmp_path, monkeypatch):
    """Contrôle : le nom courant continue évidemment de fonctionner."""
    cnm = _load_cnm()
    monkeypatch.setattr(cnm, "_CUSTOM_NODES_DIR", str(tmp_path))
    monkeypatch.setattr(cnm.subprocess, "run",
                        lambda cmd, **kwargs: SimpleNamespace(returncode=0, stdout="", stderr=""))

    result = cnm._install_custom_node("https://github.com/grokuku/ComfyUI-AI-Helper", "")
    assert result["success"] is True, result


# ---------------------------------------------------------------------------
# 3. Nodes Manager (nodes) : install ET update d'un nom historique sont NORMAUX
# ---------------------------------------------------------------------------

def test_nodes_manager_install_allows_legacy(tmp_path, monkeypatch):
    mod = _load_nodes_manager(tmp_path, monkeypatch, "holaf_nodes_manager_install_ok_test")

    calls = []
    monkeypatch.setattr(mod.subprocess, "run",
                        lambda cmd, **kwargs: (calls.append(list(cmd))
                                               or SimpleNamespace(returncode=0, stdout="", stderr="")))

    result = mod.install_custom_node("https://github.com/Holaf/ComfyUI-Holaf-Utilities")

    assert result["status"] == "success", result
    expected = str(tmp_path / "custom_nodes" / "ComfyUI-Holaf-Utilities")
    assert expected in [c[-1] for c in calls], "git clone doit réellement viser le dossier historique"


def test_nodes_manager_update_allows_legacy(tmp_path, monkeypatch):
    """Un dossier historique avec .git doit être mis à jour normalement (fetch + reset)."""
    mod = _load_nodes_manager(tmp_path, monkeypatch, "holaf_nodes_manager_update_ok_test")

    legacy = tmp_path / "custom_nodes" / "ComfyUI-Holaf-Utilities"
    (legacy / ".git").mkdir(parents=True)

    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(list(cmd))
        if list(cmd[:2]) == ["git", "config"]:
            return SimpleNamespace(
                returncode=0,
                stdout="https://github.com/Holaf/ComfyUI-Holaf-Utilities\n",
                stderr="",
            )
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(mod.subprocess, "run", fake_run)

    result = mod.update_node_from_git("ComfyUI-Holaf-Utilities")

    assert result["status"] == "success", result
    assert "Refused" not in result["message"]
    assert any(c[:3] == ["git", "fetch", "origin"] for c in calls), "git fetch doit être exécuté"
    assert any(c[:2] == ["git", "reset"] for c in calls), "git reset --hard doit être exécuté"


# ---------------------------------------------------------------------------
# 4. Preuve « chemins de données » : notre base et nos données utilisateur sont
#    TOUJOURS dans NOTRE dossier / sous AI-Helper — jamais dérivées d'un
#    dossier nommé ComfyUI-Holaf*.
# ---------------------------------------------------------------------------

def test_our_database_lives_in_our_own_pack_folder():
    module = _load_module("holaf_database_path_proof", PACKAGE_DIR / "holaf_database.py")
    assert Path(module.DB_DIR).resolve() == PACKAGE_DIR.resolve()
    assert Path(module.DB_PATH).resolve() == (PACKAGE_DIR / "holaf_utilities.sqlite").resolve()


def test_user_data_root_is_ai_helper_never_legacy(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "folder_paths", SimpleNamespace(base_path=str(tmp_path)))
    module = _load_module("holaf_user_data_manager_path_proof",
                          PACKAGE_DIR / "holaf_user_data_manager.py")

    root = Path(module.UserDataManager.get_root_path())

    assert root == tmp_path / "user" / "default" / "AI-Helper"


def test_aih_store_lives_under_user_aih_never_legacy(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "folder_paths", SimpleNamespace(base_path=str(tmp_path)))
    module = _load_module("aih_store_path_proof", PACKAGE_DIR / "aih" / "store.py")

    assert Path(module.get_store_path()) == \
        tmp_path / "user" / "default" / "aih" / "data" / "aihelper.db"


if __name__ == "__main__":  # pragma: no cover
    sys.exit(pytest.main([__file__, "-q"]))
