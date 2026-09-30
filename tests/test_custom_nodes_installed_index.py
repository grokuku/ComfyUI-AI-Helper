# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Régression — FAUX NÉGATIF « custom node déjà installé » (Workflow Share).
#
# Cause racine : _get_installed_custom_nodes() n'ajoutait à la liste que les
# dossiers custom_nodes ayant un remote git (`if has_git or git_url:`). Un pack
# installé SANS `.git` (copie manuelle, gestionnaire sans remote…) était donc
# ABSENT de GET /api/aih/custom-nodes → l'index d'installation côté front
# n'avait aucune entrée pour lui → l'outil retentait une installation déjà
# présente → 400 « Node 'X' already installed » affiché à l'utilisateur.
#
# Ce test verrouille :
#   - TOUS les dossiers de premier niveau sont listés (y compris sans git) ;
#   - le remote git est réellement lu depuis `.git/config` (origin, puis repli
#     sur un autre remote) ;
#   - le message d'installation « already installed » (contrat du filet de
#     sécurité côté JS) reste inchangé ;
#   - la sécurité (HTTPS + hôtes autorisés) n'est pas relâchée.

import importlib.util
import sys
import types
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
_PKG = "holaf_cnm_pkg"


def _load_custom_nodes_manager():
    if _PKG not in sys.modules:
        pkg = types.ModuleType(_PKG)
        pkg.__path__ = [str(PACKAGE_DIR)]
        sys.modules[_PKG] = pkg
    spec = importlib.util.spec_from_file_location(
        f"{_PKG}.custom_nodes_manager", PACKAGE_DIR / "aih" / "custom_nodes_manager.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[f"{_PKG}.custom_nodes_manager"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def cnm(tmp_path):
    module = _load_custom_nodes_manager()
    module._CUSTOM_NODES_DIR = str(tmp_path)
    return module


def _git_dir(root: Path, name: str, remote_name: str = "origin", url: str = "") -> Path:
    d = root / name
    d.mkdir(parents=True)
    (d / "__init__.py").write_text(
        "NODE_CLASS_MAPPINGS = {'FakeNode': object}\n", encoding="utf-8"
    )
    if url:
        git = d / ".git"
        git.mkdir()
        (git / "config").write_text(
            '[core]\n\trepositoryformatversion = 0\n'
            f'[remote "{remote_name}"]\n\turl = {url}\n\tfetch = +refs/heads/*:refs/remotes/x/*\n',
            encoding="utf-8",
        )
    return d


def test_installed_nodes_include_dirs_without_git(cnm, tmp_path):
    """Un pack installé SANS remote git doit être LISTÉ (nom de dossier seul)."""
    _git_dir(tmp_path, "ComfyUI-KJNodes", url="git@github.com:kijai/ComfyUI-KJNodes.git")
    # Copie manuelle / gestionnaire sans .git : AUCUNE URL, dossier seul.
    _git_dir(tmp_path, "ManuelSansGit", url="")

    nodes = {n["name"]: n for n in cnm._get_installed_custom_nodes()}
    assert "ManuelSansGit" in nodes, "un dossier sans git DOIT figurer dans l'index (faux négatif racine)"
    assert nodes["ManuelSansGit"]["git_url"] == ""
    assert nodes["ManuelSansGit"]["has_git"] is False
    # Le dossier « sans git » doit tout de même exposer ses classes.
    assert "FakeNode" in nodes["ManuelSansGit"]["node_types"]
    # Le pack avec git garde son URL normalisable.
    assert nodes["ComfyUI-KJNodes"]["git_url"] == "git@github.com:kijai/ComfyUI-KJNodes.git"
    assert nodes["ComfyUI-KJNodes"]["has_git"] is True


def test_hidden_and_files_are_skipped(cnm, tmp_path):
    _git_dir(tmp_path, "Visible", url="https://github.com/x/Visible.git")
    (tmp_path / ".cache").mkdir()
    (tmp_path / "notes.txt").write_text("pas un dossier", encoding="utf-8")

    names = [n["name"] for n in cnm._get_installed_custom_nodes()]
    assert "Visible" in names
    assert ".cache" not in names
    assert "notes.txt" not in names


def test_read_git_url_falls_back_to_non_origin_remote(cnm, tmp_path):
    """Le remote git est réellement lu depuis le dossier installé, même renommé."""
    d = _git_dir(tmp_path, "RenamedRemote", remote_name="upstream",
                 url="https://github.com/Holaf/ComfyUI-Holaf.git")
    assert cnm._read_git_url(str(d)) == "https://github.com/Holaf/ComfyUI-Holaf.git"

    # Priorité à origin quand il existe.
    d2 = _git_dir(tmp_path, "WithOrigin", remote_name="origin",
                  url="https://github.com/a/Origin.git")
    assert cnm._read_git_url(str(d2)) == "https://github.com/a/Origin.git"

    # Sans .git/config exploitable : chaîne vide (jamais une exception).
    assert cnm._read_git_url(str(tmp_path / "introuvable")) == ""


def test_install_message_already_installed_contract(cnm, tmp_path):
    """Contrat du filet de sécurité JS : le message « already installed » reste exact."""
    _git_dir(tmp_path, "ComfyUI-KJNodes", url="git@github.com:kijai/ComfyUI-KJNodes.git")
    result = cnm._install_custom_node("https://github.com/kijai/ComfyUI-KJNodes", "ComfyUI-KJNodes")
    assert result["success"] is False
    assert "already installed" in result["message"].lower()
    assert "ComfyUI-KJNodes" in result["message"]


def test_install_security_not_relaxed(cnm, tmp_path):
    """La validation d'URL (HTTPS + hôtes autorisés) reste verrouillée."""
    assert cnm._validate_repo_url("http://github.com/x/y")[0] is None
    assert cnm._validate_repo_url("git@github.com:x/y.git")[0] is None
    assert cnm._validate_repo_url("https://evil.example/x/y")[0] is None
    ok, err = cnm._validate_repo_url("https://github.com/kijai/ComfyUI-KJNodes")
    assert err is None and ok == "https://github.com/kijai/ComfyUI-KJNodes"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
