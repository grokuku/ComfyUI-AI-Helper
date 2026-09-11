# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""update_manager.py — Mise à jour git du pack fusionné (Phase 2 chantier C).

Porté depuis AI-Helper/AIH_ComfyUI/update_manager.py avec UNE différence
majeure et assumée : le redémarrage automatique du serveur a été SUPPRIMÉ.

- La stratégie de mise à jour d'origine est conservée à l'identique :
  ``git fetch origin`` puis comparaison FETCH_HEAD/HEAD puis
  ``git reset --hard FETCH_HEAD`` (jamais un simple pull : on veut un état
  propre même en cas de divergences locales).
- L'ancienne fonction restart_server() (``os.execv`` dans un thread) n'est
  PAS portée. Le redémarrage post-update est DÉLÉGUÉ au mécanisme existant
  d'Utils : endpoint HTTP **POST /holaf/utilities/restart**
  (holaf_server_management.restart_server_route). Le contrat voulu
  (PLAN_FUSION.md §2.2) est :
      POST /aih/update → {updated: bool}
      si updated=true, le FRONTEND propose le redémarrage et appelle
      POST /holaf/utilities/restart ; il existe aussi un bouton Restart
      autonome qui appelle directement ce même endpoint Utils.

Le module est volontairement silencieux sur les threads : aucune tâche de
fond, uniquement update_repo() appelé par la route POST /aih/update
(aih/routes.py, groupe « update »).
"""

import os
import subprocess


def _find_repo_root(start_path):
    """Remonte l'arborescence depuis start_path jusqu'à trouver un dossier .git."""
    current = os.path.abspath(start_path)
    while current and current != os.path.dirname(current):
        if os.path.isdir(os.path.join(current, ".git")):
            return current
        current = os.path.dirname(current)
    return None


def update_repo(repo_root=None):
    """Met à jour le repo via git fetch + reset --hard FETCH_HEAD.

    Args:
        repo_root: racine du repo à mettre à jour. None (défaut, comportement
            de production) = détection en remontant depuis ce fichier
            (<pack>/aih/) jusqu'au .git — dans le pack fusionné c'est la
            racine du pack elle-même ; dans l'extension AI-Helper d'origine
            c'était son parent (AIH_ComfyUI/ étant un sous-dossier), ce que
            la boucle générique couvre aussi. Le paramètre existe pour les
            tests : NE JAMAIS passer la racine du pack en cours d'exécution
            depuis un harnais, au risque de rewinder le repo (reset --hard).

    Retourne un dict :
        {"status": "ok"|"error", "message": str, "log": str,
         "updated": bool, "before"?: sha, "after"?: sha}
    ``updated=True`` signifie que HEAD a avancé : un redémarrage est requis
    pour charger le nouveau code (à demander via POST /holaf/utilities/restart,
    JAMAIS déclenché ici).
    """
    if repo_root is None:
        here = os.path.dirname(os.path.abspath(__file__))
        repo_root = _find_repo_root(here)
    if not repo_root:
        return {
            "status": "error",
            "message": "Impossible de trouver le repo Git (.git introuvable en remontant l'arborescence).",
            "log": "",
            "updated": False,
        }

    log_lines = []
    log_lines.append(f"Repo: {repo_root}")
    log_lines.append("")

    # Etape 1 : verifier l'etat actuel (on veut savoir si on est en retard)
    try:
        before = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True, text=True, cwd=repo_root, timeout=10, encoding="utf-8", errors="replace",
        )
        before_hash = before.stdout.strip()
        log_lines.append(f"Avant : HEAD = {before_hash[:12]}")
    except Exception as e:
        return {
            "status": "error",
            "message": f"Impossible de lire HEAD : {e}",
            "log": "\n".join(log_lines),
            "updated": False,
        }

    # Etape 2 : git fetch origin
    log_lines.append("→ git fetch origin")
    try:
        fetch = subprocess.run(
            ["git", "fetch", "origin"],
            capture_output=True, text=True, cwd=repo_root, timeout=120, encoding="utf-8", errors="replace",
        )
        log_lines.append(fetch.stdout.strip())
        if fetch.stderr.strip():
            log_lines.append(fetch.stderr.strip())
        if fetch.returncode != 0:
            return {
                "status": "error",
                "message": "git fetch a echoue.",
                "log": "\n".join(log_lines),
                "updated": False,
            }
    except subprocess.TimeoutExpired:
        return {
            "status": "error",
            "message": "git fetch a timeout (120s).",
            "log": "\n".join(log_lines),
            "updated": False,
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"git fetch erreur : {e}",
            "log": "\n".join(log_lines),
            "updated": False,
        }

    # Etape 3 : comparer FETCH_HEAD avec HEAD
    try:
        fetch_head = subprocess.run(
            ["git", "rev-parse", "FETCH_HEAD"],
            capture_output=True, text=True, cwd=repo_root, timeout=10, encoding="utf-8", errors="replace",
        )
        fetch_hash = fetch_head.stdout.strip()
        log_lines.append(f"Apres fetch : FETCH_HEAD = {fetch_hash[:12]}")

        if fetch_hash == before_hash:
            log_lines.append("")
            log_lines.append("✓ Deja a jour — aucune modification disponible.")
            return {
                "status": "ok",
                "message": "Deja a jour.",
                "log": "\n".join(log_lines),
                "updated": False,
                "before": before_hash,
                "after": before_hash,
            }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Impossible de lire FETCH_HEAD : {e}",
            "log": "\n".join(log_lines),
            "updated": False,
        }

    # Etape 4 : git reset --hard FETCH_HEAD
    log_lines.append("")
    log_lines.append("→ git reset --hard FETCH_HEAD")
    try:
        reset = subprocess.run(
            ["git", "reset", "--hard", "FETCH_HEAD"],
            capture_output=True, text=True, cwd=repo_root, timeout=60, encoding="utf-8", errors="replace",
        )
        log_lines.append(reset.stdout.strip())
        if reset.stderr.strip():
            log_lines.append(reset.stderr.strip())
        if reset.returncode != 0:
            return {
                "status": "error",
                "message": "git reset a echoue.",
                "log": "\n".join(log_lines),
                "updated": False,
            }
    except Exception as e:
        return {
            "status": "error",
            "message": "git reset erreur : {e}".format(e=e),
            "log": "\n".join(log_lines),
            "updated": False,
        }

    # Etape 5 : resume des changements
    log_lines.append("")
    try:
        diff = subprocess.run(
            ["git", "diff", "--stat", f"{before_hash}..{fetch_hash}"],
            capture_output=True, text=True, cwd=repo_root, timeout=10, encoding="utf-8", errors="replace",
        )
        if diff.stdout.strip():
            log_lines.append("Fichiers modifies :")
            log_lines.append(diff.stdout.strip())
        else:
            log_lines.append("(Aucun fichier different)")
    except Exception:
        pass

    log_lines.append("")
    log_lines.append(f"✓ Mise a jour terminee : {before_hash[:12]} → {fetch_hash[:12]}")
    log_lines.append("⚠ Redémarrage requis pour charger le nouveau code "
                     "(POST /holaf/utilities/restart — jamais déclenché ici).")

    return {
        "status": "ok",
        "message": "Mise a jour reussie.",
        "log": "\n".join(log_lines),
        "updated": True,
        "before": before_hash,
        "after": fetch_hash,
    }
