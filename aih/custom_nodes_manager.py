# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""custom_nodes_manager.py — Détection et installation de custom nodes.

Porté depuis l'ancien monorepo AI-Helper (Phase 2 chantier C).
Le module ne déclare AUCUNE node ComfyUI : il est consommé exclusivement par
aih/routes.py (groupe « models », routes /api/aih/custom-nodes*).

Endpoints servis par aih/routes.py :
  GET  /api/aih/custom-nodes         → liste des nodes installés + URLs git
  POST /api/aih/custom-nodes/install → git clone d'un node manquant

Usage côté JS (workflow share, chantier D) :
  - Au partage : GET /api/aih/custom-nodes pour enrichir required_nodes avec les URLs
  - À l'install : POST /api/aih/custom-nodes/install {git_url, name} pour cloner

Différence vs source (documentée) : la fonction _install_custom_node() ne lance
PAS de ``pip install -r requirements.txt`` après le clone — l'auto pip install
est INTERDIT dans le pack fusionné (PLAN_FUSION.md §3.3). L'utilisateur installe
les requirements via le Nodes Manager d'Utils (POST /holaf/nodes/install-requirements,
protégé par authentification) ou manuellement ; un message explicite est renvoyé.
"""

import os
import logging
import re
import subprocess
import configparser
from urllib.parse import urlparse

try:
    import folder_paths
    _BASE_DIR = os.path.dirname(folder_paths.__file__)
    _CUSTOM_NODES_DIR = os.path.join(_BASE_DIR, "custom_nodes")
except Exception:
    _CUSTOM_NODES_DIR = None


# Trusted Git origins for custom node installation. Only HTTPS clones from
# these hosts are allowed. This blocks RCE via attacker-supplied file://,
# git://, ssh:// or http:// clone URLs (porté depuis nodes/holaf_nodes_manager.py).
ALLOWED_GIT_HOSTS = {'github.com', 'www.github.com'}


def _validate_repo_url(repo_url):
    """Validate a clone URL for custom node install.

    Returns (normalized_url, None) on success or (None, error_message) on
    failure. Only HTTPS URLs on trusted hosts are accepted.
    """
    if not isinstance(repo_url, str) or not repo_url.strip():
        return None, "Repository URL is required."

    repo_url = repo_url.strip()
    try:
        parsed = urlparse(repo_url)
    except ValueError:
        return None, "Invalid repository URL."

    if parsed.scheme != 'https':
        return None, "Only HTTPS repository URLs are allowed."

    if parsed.username is not None or parsed.password is not None:
        return None, "Repository URLs with embedded credentials are not allowed."

    hostname = (parsed.hostname or '').lower()
    if hostname not in ALLOWED_GIT_HOSTS:
        return None, "Repository host is not allowed."

    if not parsed.path or parsed.path.rstrip('/') == '':
        return None, "Repository URL is missing a repository path."

    return repo_url, None


def _sanitize_node_name(node_name_from_client: str) -> str | None:
    """Sanitize a node folder name to prevent path traversal.

    Allows only alphanumeric characters, underscores, hyphens, and dots.
    Ensures the name is a single path component (rejects ``..`` and any
    path separator).
    """
    if not node_name_from_client:
        return None

    if "/" in node_name_from_client or "\\" in node_name_from_client:
        return None

    if ".." in node_name_from_client:
        return None

    sanitized = re.sub(r'[^a-zA-Z0-9_.-]', '', node_name_from_client)

    if not sanitized or all(c == '.' for c in sanitized):
        return None

    return sanitized


def _read_git_url(node_dir):
    """Lit l'URL du remote origin depuis .git/config."""
    git_config = os.path.join(node_dir, ".git", "config")
    if not os.path.isfile(git_config):
        return ""
    try:
        config = configparser.ConfigParser()
        config.read(git_config)
        if 'remote "origin"' in config:
            return config['remote "origin"'].get('url', '')
    except Exception:
        pass
    return ""


def _get_node_types_from_sys_modules():
    """
    Parcourt sys.modules pour trouver les modules charges dans
    custom_nodes/ qui ont un attribut NODE_CLASS_MAPPINGS.
    Retourne {folder_name: [node_type1, ...]}.
    """
    result = {}
    try:
        import sys

        # Methode 1: scan sys.modules pour NODE_CLASS_MAPPINGS
        for mod_name, mod in sys.modules.items():
            try:
                if not hasattr(mod, 'NODE_CLASS_MAPPINGS'):
                    continue
                filepath = getattr(mod, '__file__', None)
                if not filepath:
                    continue
                filepath = os.path.normpath(filepath)
                parts = filepath.split('custom_nodes')
                if len(parts) < 2:
                    continue
                sub = parts[1].lstrip(os.sep).split(os.sep)[0]
                if not sub or sub.startswith('.'):
                    continue
                mapping = mod.NODE_CLASS_MAPPINGS
                if not isinstance(mapping, dict):
                    continue
                if sub not in result:
                    result[sub] = []
                for node_type in mapping.keys():
                    if isinstance(node_type, str) and node_type not in result[sub]:
                        result[sub].append(node_type)
            except Exception:
                continue

        # Methode 2: utilise class.__module__ depuis le registre global de ComfyUI
        # Marche meme si le pack construit NODE_CLASS_MAPPINGS dynamiquement
        try:
            import nodes as comfy_nodes
            global_mapping = comfy_nodes.NODE_CLASS_MAPPINGS
            for node_type, node_class in global_mapping.items():
                try:
                    module_name = getattr(node_class, '__module__', None)
                    if not module_name:
                        continue
                    mod = sys.modules.get(module_name)
                    if not mod:
                        continue
                    filepath = getattr(mod, '__file__', None)
                    if not filepath:
                        continue
                    filepath = os.path.normpath(filepath)
                    if 'custom_nodes' not in filepath:
                        continue
                    parts = filepath.split('custom_nodes')
                    sub = parts[1].lstrip(os.sep).split(os.sep)[0]
                    if not sub or sub.startswith('.'):
                        continue
                    if sub not in result:
                        result[sub] = []
                    if isinstance(node_type, str) and node_type not in result[sub]:
                        result[sub].append(node_type)
                except Exception:
                    continue
        except Exception as e:
            logging.warning(f"[AIH] comfy registry scan error: {e}")

    except Exception as e:
        logging.warning(f"[AIH] _get_node_types_from_sys_modules error: {e}")

    logging.info(f"[AIH] Node type detection: {len(result)} packs found: {list(result.keys())}")
    return result


# Pas de cache — toujours re-scanner (rapide, iterate sys.modules une fois)
def _get_node_type_map():
    return _get_node_types_from_sys_modules()


def _extract_node_types(node_dir):
    """Retourne les node types fournis par ce dossier custom_nodes.
    Priorite 1: NODE_CLASS_MAPPINGS global (sys.modules scan).
    Priorite 2: ast.parse() du __init__.py (fiable, gere les dicts imbriques).
    """
    folder_name = os.path.basename(node_dir)
    type_map = _get_node_type_map()

    if folder_name in type_map:
        return type_map[folder_name]

    # Fallback: parsing AST du __init__.py
    init_file = os.path.join(node_dir, "__init__.py")
    if not os.path.isfile(init_file):
        return []
    try:
        import ast
        with open(init_file, "r", encoding="utf-8", errors="ignore") as f:
            source = f.read()
        tree = ast.parse(source)
        keys = []
        for node in ast.walk(tree):
            # Cas 1: NODE_CLASS_MAPPINGS = {...}
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id == 'NODE_CLASS_MAPPINGS':
                        if isinstance(node.value, ast.Dict):
                            for k in node.value.keys:
                                if isinstance(k, ast.Constant) and isinstance(k.value, str):
                                    keys.append(k.value)
            # Cas 2: from .module import NODE_CLASS_MAPPINGS (on ne peut pas resoudre, mais on sait que ca existe)
            # Cas 3: NODE_CLASS_MAPPINGS.update({...})
            if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
                func = node.value.func
                if (isinstance(func, ast.Attribute) and
                    isinstance(func.value, ast.Name) and
                    func.value.id == 'NODE_CLASS_MAPPINGS' and
                    func.attr == 'update'):
                    if node.value.args and isinstance(node.value.args[0], ast.Dict):
                        for k in node.value.args[0].keys:
                            if isinstance(k, ast.Constant) and isinstance(k.value, str):
                                keys.append(k.value)
        return keys
    except Exception as e:
        logging.warning(f"[AIH] AST parse failed for {folder_name}: {e}")
        return []


def _get_installed_custom_nodes():
    """Scanne custom_nodes/ et retourne [{name, git_url, has_git, node_types}]."""
    if not _CUSTOM_NODES_DIR or not os.path.isdir(_CUSTOM_NODES_DIR):
        return []

    results = []
    for name in os.listdir(_CUSTOM_NODES_DIR):
        node_dir = os.path.join(_CUSTOM_NODES_DIR, name)
        if not os.path.isdir(node_dir) or name.startswith('.'):
            continue
        git_url = _read_git_url(node_dir)
        has_git = os.path.isdir(os.path.join(node_dir, ".git"))
        if has_git or git_url:
            node_types = _extract_node_types(node_dir)
            results.append({
                "name": name,
                "git_url": git_url,
                "has_git": has_git,
                "node_types": node_types,
            })
    return results


def _install_custom_node(git_url, name=""):
    """Clone un repo git dans custom_nodes/. Retourne {success, message}.

    ⚠️ Ne lance PAS pip install (interdit dans le pack fusionné) — voir le
    docstring du module pour la procédure recommandée.
    """
    if not _CUSTOM_NODES_DIR:
        return {"success": False, "message": "custom_nodes directory not found"}
    if not git_url:
        return {"success": False, "message": "git_url required"}

    # SECURITY: validate the clone URL (HTTPS only, trusted hosts) before it
    # is ever passed to git clone — porté depuis nodes/holaf_nodes_manager.py.
    git_url, url_err = _validate_repo_url(git_url)
    if not git_url:
        return {"success": False, "message": url_err}

    # Déduire le nom depuis l'URL si non fourni
    if not name:
        name = git_url.rstrip('/').split('/')[-1]
        if name.endswith('.git'):
            name = name[:-4]

    # SECURITY: sanitize the folder name to a single path component so the
    # clone can never escape custom_nodes/ (anti path-traversal).
    name = _sanitize_node_name(name)
    if not name:
        return {"success": False, "message": "Invalid node name."}

    target = os.path.join(_CUSTOM_NODES_DIR, name)
    if os.path.isdir(target):
        return {"success": False, "message": f"Node '{name}' already installed"}

    try:
        result = subprocess.run(
            ['git', 'clone', git_url, target],
            capture_output=True, text=True, timeout=120
        )
        if result.returncode != 0:
            return {"success": False, "message": f"git clone failed: {result.stderr[:200]}"}

        # Auto pip install volontairement NON porté (INTERDIT, PLAN_FUSION.md §3.3).
        # Signaler poliment si un requirements.txt existe.
        notice = ""
        req_file = os.path.join(target, "requirements.txt")
        if os.path.isfile(req_file):
            notice = (" Note: a requirements.txt exists — install dependencies manually"
                      " or via the Holaf Nodes Manager (auto pip install is disabled).")
            logging.info(f"[AIH] Installed '{name}' ships requirements.txt (not auto-installed)")

        return {"success": True, "message": f"Installed {name}.{notice}", "path": target}
    except subprocess.TimeoutExpired:
        return {"success": False, "message": "git clone timed out (120s)"}
    except Exception as e:
        return {"success": False, "message": str(e)}
