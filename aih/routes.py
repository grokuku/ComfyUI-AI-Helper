# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""routes.py — Routes HTTP AIH du pack fusionné (Phase 2 chantier C).

Ce module porte les ~35 routes inline qui vivaient dans le ``__init__.py``
racine d'AI-Helper (refactorées conformément au PLAN_FUSION.md §3.5 :
suppression du chargement exotique via sys.modules pré-enregistrés,
imports standardisés, préfixes ``/aih/*`` et ``/api/aih/*`` conservés).

Architecture
------------
Un unique point d'entrée : ``register(server_routes, require_auth=None)``,
appelé UNE seule fois par le ``__init__.py`` racine de l'extension, juste
après le bootstrap du sous-package ``aih/`` (qui a ajouté la racine du pack
au ``sys.path``, rendant les imports absolus ``from aih import X`` valides).

- ``server_routes`` : l'objet ``server.PromptServer.instance.routes`` (table
  de décorateurs aiohttp) — le même que celui utilisé par toutes les routes
  ``/holaf/*`` d'Utils.
- ``require_auth``  : le décorateur d'authentification partagé Holaf
  (``holaf_auth.require_auth``), passé par le ``__init__.py`` racine. Il
  sécurise les routes sensibles du pack (credentials, clés OpenAI, update,
  install de custom nodes, blobby save/load/exec). S'il n'est pas fourni,
  la garde fail-closed ``_fail_closed_auth_guard`` remplace la route de
  shell par un refus permanent (503) : jamais de shell ouvert par défaut.

Les groupes sont enregistrés indépendamment : l'échec d'un groupe est
journalisé mais ne prive pas les autres (robustesse héritée de la source).

Groupes (ordre historique des commits du chantier C) :
  1. ``credentials`` : GET/POST /aih/credentials, GET/POST
     /aih/elements/presets, POST /aih/elements/presets/delete,
     GET/POST /aih/openai/keys — chemins de données inchangés
     (``user/default/aih/``).
  2. ``update``      : POST /aih/update — git fetch + reset --hard
     FETCH_HEAD (stratégie d'origine conservée), renvoie ``{updated: bool}``.
     PAS d'auto-restart : le redémarrage post-update est délégué à
     l'endpoint Utils existant POST /holaf/utilities/restart (le frontend
     proposera le redémarrage quand ``updated`` est vrai). L'ancienne route
     POST /aih/restart n'est PAS recréée : le bouton Restart autonome du
     frontend appelle directement /holaf/utilities/restart.
  3. ``blobby``      : POST /aih/blobby/save + GET /aih/blobby/load
     (paramètres du companion, fichier user/default/aih/blobby.json) et
     POST /aih/blobby/exec (shell local) — cette dernière SÉCURISÉE derrière
     l'authentification par mot de passe du terminal Holaf (même mécanisme
     que GET /holaf/terminal : cookie de session signé ``holaf_session``,
     obtenu via POST /holaf/auth/login ou POST /holaf/terminal/auth) ; 401 sinon.
  4. ``models``      : /api/aih/models/* (liste locale/distante, upload et
     download SFTP chunked via paramiko, fingerprint head/tail, progression)
     portés fidèlement depuis l'ancien monorepo AI-Helper →
     ``aih/model_manager.py`` ; /api/aih/custom-nodes* depuis
     l'ancien manager custom-nodes du monorepo → ``aih/custom_nodes_manager.py``
     (SANS l'auto ``pip install`` post-clone, interdit — cf. §3.3).
  5. ``local``       : GET /aih/local/status, /aih/local/api/* (miroirs du
     store SQLite, sync/outbox/conflicts/retry, recherche sémantique,
     embeddings, music3), service statique du frontend site (copié dans
     ``<pack>/aih_frontend/``) sous /aih/local/, et démarrage du moteur de
     synchronisation daemon (comportement d'origine du mode local).

Non portés volontairement :
  - GET /aih/terminal (WebSocket PTY **sans mot de passe**) : ABANDONNÉ —
    décision « terminal unique Utils » (PLAN_FUSION.md §2.2). Le seul shell
    interactif du pack fusionné reste GET /holaf/terminal (authentifié).
  - POST /aih/restart : REMPLACÉ par la réutilisation directe de
    POST /holaf/utilities/restart (rien à créer côté backend).
  - Tout ``pip install`` automatique (INTERDIT, PLAN_FUSION.md §3.3).

Contrat POST /aih/update (pour le chantier D — widgets JS) :
    200 {"status": "ok"|..., "message": str, "log": str, "updated": bool,
         "before": "<sha>", "after": "<sha>"}   (before/after présents selon
                                                    le cas « déjà à jour » /
                                                    mise à jour appliquée)
    500 {"status": "error", "message": str, "log": str, "updated": false}
    Si ``updated`` est vrai, le repo a été reset --hard sur FETCH_HEAD :
    le frontend DOIT proposer un redémarrage via POST /holaf/utilities/restart
    pour charger le nouveau code.
"""

import json
import logging
import os
from datetime import datetime

from aiohttp import web

# Socle léger (pur Python, aucun effet de bord à l'import) : le helper de
# credentials partagé du sous-package aih/ — mêmes fonctions que la source
# (ex ancien helper _credentials du monorepo AI-Helper, renommé aih.credentials au chantier A).
from aih import credentials

# Racine du pack (routes.py vit dans <pack>/aih/). Utilisée par le groupe
# « local » pour localiser aih_frontend/.
_PACK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ── Helpers communs ───────────────────────────────────────────────────

def _get_aih_user_dir():
    """Dossier user/default/aih de ComfyUI (identique à la source AI-Helper).

    ⚠️ Chemin conservé À L'IDENTIQUE (presets, clés OpenAI, blobby.json...)
    pour ne pas perdre les données des utilisateurs d'AI-Helper.
    """
    # 1) Source canonique : ComfyUI user directory
    try:
        import folder_paths
        user_dir = folder_paths.get_user_directory()
        if user_dir:
            return os.path.join(user_dir, "default", "aih")
    except Exception:
        pass
    # 2) Fallback sûr : la racine ComfyUI (folder_paths.base_path), JAMAIS custom_nodes
    try:
        base = getattr(folder_paths, "base_path", None)
        if base:
            d = os.path.join(base, "user", "default", "aih")
            os.makedirs(d, exist_ok=True)
            return d
    except Exception:
        pass
    # 3) Dernier recours : DANS le pack lui-même (jamais custom_nodes/)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "user_data", "aih")


def _get_presets_path():
    """Chemin du fichier de presets de l'Elements Picker (inchangé)."""
    return os.path.join(_get_aih_user_dir(), "aih_elements_presets.json")


class _RecordingRoutes:
    """Proxy mince autour de l'objet ``routes`` du PromptServer.

    Journalise chaque couple (méthode, chemin) au moment du décorateur afin
    d'afficher un récapitulatif au boot et de permettre un test hors ComfyUI
    (un faux objet exposant seulement get/post suffit à ``register()``).
    Les méthodes retournent directement le décorateur aiohttp sous-jacent.
    """

    def __init__(self, target, log):
        self._target = target
        self._log = log

    def get(self, path):
        self._log.append(("GET", path))
        return self._target.get(path)

    def post(self, path):
        self._log.append(("POST", path))
        return self._target.post(path)


def _fail_closed_auth_guard(handler):
    """Garde-fou fail-closed si aucune fonction d'auth n'est fournie.

    Utilisé pour /aih/blobby/exec quand ``register()`` est appelé sans
    ``require_auth`` (contexte où holaf_auth serait indisponible) : on
    préfère une route morte (503 permanent) à une route de shell ouverte.
    """
    async def wrapper(request):
        return web.json_response(
            {"ok": False, "error": "Authentication unavailable: endpoint disabled."},
            status=503,
        )
    return wrapper


# ══════════════════════════════════════════════════════════════════════
# GROUPE 1 — Credentials & clés & presets (chemins de données inchangés)
# ══════════════════════════════════════════════════════════════════════

def _register_credentials_group(r, require_auth):
    """GET/POST /aih/credentials, /aih/elements/presets*, /aih/openai/keys."""

    # ── Credentials (lecture / ecriture du fichier local) ──────────────
    # Le menu AIH → Compte appelle ces routes pour lire/ecrire
    # user/default/aih/credentials.json (api_key + server_url).
    # Les nodes Python lisent ce fichier via aih.credentials.

    @r.get("/aih/credentials")
    @require_auth
    async def aih_get_credentials_route(request):
        try:
            creds = credentials._load_aih_credentials(use_cache=False)
            creds_path = credentials.get_credentials_path()
            return web.json_response({
                "status": "ok",
                "api_key": creds.get("api_key", ""),
                "server_url": creds.get("server_url", ""),
                "path": creds_path,
                "exists": os.path.isfile(creds_path),
            })
        except Exception as e:
            return web.json_response({
                "status": "error",
                "message": f"Exception: {e}",
            }, status=500)

    @r.post("/aih/credentials")
    @require_auth
    async def aih_save_credentials_route(request):
        try:
            data = await request.json()
            api_key = (data.get("api_key") or "").strip()
            server_url = (data.get("server_url") or "").strip()

            creds_path = credentials.get_credentials_path()
            os.makedirs(os.path.dirname(creds_path), exist_ok=True)

            # Permissions restrictives (Linux)
            old_umask = None
            if os.name != 'nt':
                old_umask = os.umask(0o077)
            try:
                with open(creds_path, "w", encoding="utf-8") as f:
                    json.dump({
                        "api_key": api_key,
                        "server_url": server_url,
                        "updated_at": datetime.utcnow().isoformat() + "Z",
                    }, f, indent=2)
            finally:
                if old_umask is not None:
                    os.umask(old_umask)

            # Invalider le cache pour que les nodes lisent la nouvelle valeur
            credentials.invalidate_cache()

            return web.json_response({
                "status": "ok",
                "path": creds_path,
                "api_key_len": len(api_key),
            })
        except Exception as e:
            import traceback
            return web.json_response({
                "status": "error",
                "message": f"Exception: {e}",
                "log": traceback.format_exc(),
            }, status=500)

    # ── Elements Presets (sauvegarde locale dans user/default/aih/) ────
    # Les presets de l'Elements Picker sont stockés dans un fichier JSON
    # local pour ne pas saturer le workflow ni être partagés avec d'autres.

    @r.get("/aih/elements/presets")
    async def aih_get_elements_presets(request):
        """Liste tous les presets sauvegardés."""
        try:
            presets_path = _get_presets_path()
            if os.path.isfile(presets_path):
                with open(presets_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                return web.json_response({"status": "ok", "presets": data.get("presets", [])})
            return web.json_response({"status": "ok", "presets": []})
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)}, status=500)

    @r.post("/aih/elements/presets")
    async def aih_save_elements_preset(request):
        """Sauvegarde ou met à jour un preset, ou action cleanup."""
        try:
            body = await request.json()

            # ── Action cleanup : vide le fichier local (après migration distante) ──
            if body.get("action") == "cleanup":
                presets_path = _get_presets_path()
                if os.path.isfile(presets_path):
                    with open(presets_path, "w", encoding="utf-8") as f:
                        json.dump({"presets": []}, f)
                return web.json_response({"status": "ok", "cleaned": True})

            name = body.get("name", "").strip()
            preset_data = body.get("data", {})
            if not name:
                return web.json_response({"status": "error", "message": "Name required"}, status=400)

            presets_path = _get_presets_path()
            os.makedirs(os.path.dirname(presets_path), exist_ok=True)

            # Lire les presets existants
            presets = []
            if os.path.isfile(presets_path):
                with open(presets_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    presets = data.get("presets", [])

            # Chercher si un preset avec ce nom existe déjà (update)
            existing_idx = None
            for i, p in enumerate(presets):
                if p.get("name") == name:
                    existing_idx = i
                    break

            preset_obj = {
                "name": name,
                "data": preset_data,
                "updated_at": datetime.utcnow().isoformat() + "Z",
            }

            if existing_idx is not None:
                presets[existing_idx] = preset_obj
            else:
                presets.append(preset_obj)

            with open(presets_path, "w", encoding="utf-8") as f:
                json.dump({"presets": presets}, f, indent=2, ensure_ascii=False)

            return web.json_response({"status": "ok", "name": name, "count": len(presets)})
        except Exception as e:
            import traceback
            return web.json_response({"status": "error", "message": str(e), "log": traceback.format_exc()}, status=500)

    @r.post("/aih/elements/presets/delete")
    async def aih_delete_elements_preset(request):
        """Supprime un preset par son nom."""
        try:
            body = await request.json()
            name = body.get("name", "").strip()
            if not name:
                return web.json_response({"status": "error", "message": "Name required"}, status=400)

            presets_path = _get_presets_path()
            if not os.path.isfile(presets_path):
                return web.json_response({"status": "ok", "deleted": False})

            with open(presets_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                presets = data.get("presets", [])

            new_presets = [p for p in presets if p.get("name") != name]

            with open(presets_path, "w", encoding="utf-8") as f:
                json.dump({"presets": new_presets}, f, indent=2, ensure_ascii=False)

            return web.json_response({"status": "ok", "deleted": len(presets) != len(new_presets)})
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)}, status=500)

    # ── OpenAI API Keys (stockage local par base_url) ──────────────────

    @r.get("/aih/openai/keys")
    @require_auth
    async def aih_get_openai_keys(request):
        """Retourne les clés API stockées, optionnellement filtrées par base_url."""
        try:
            keys_path = os.path.join(_get_aih_user_dir(), "openai_keys.json")
            data = {}
            if os.path.isfile(keys_path):
                with open(keys_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
            # Filtrer par base_url si demandé
            base_url = request.query.get("base_url", "").rstrip("/")
            if base_url:
                return web.json_response({"status": "ok", "key": data.get(base_url, "")})
            return web.json_response({"status": "ok", "keys": data})
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)}, status=500)

    @r.post("/aih/openai/keys")
    async def aih_save_openai_key(request):
        """Sauvegarde une clé API pour un base_url donné."""
        try:
            body = await request.json()
            base_url = (body.get("base_url") or "").strip().rstrip("/")
            api_key = (body.get("api_key") or "").strip()
            if not base_url:
                return web.json_response({"status": "error", "message": "base_url required"}, status=400)

            keys_path = os.path.join(_get_aih_user_dir(), "openai_keys.json")
            os.makedirs(os.path.dirname(keys_path), exist_ok=True)

            # Lire les clés existantes
            data = {}
            if os.path.isfile(keys_path):
                with open(keys_path, "r", encoding="utf-8") as f:
                    data = json.load(f)

            if api_key:
                data[base_url] = api_key
            elif base_url in data:
                del data[base_url]  # Supprimer si clé vide

            with open(keys_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)

            return web.json_response({"status": "ok", "base_url": base_url})
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)}, status=500)


# ══════════════════════════════════════════════════════════════════════
# GROUPE 2 — Update (POST /aih/update, SANS auto-restart)

def _register_update_group(r, require_auth):
    """POST /aih/update — git fetch + reset --hard FETCH_HEAD.

    Contrat pour le chantier D (widgets JS) :
        200 {"status": str, "message": str, "log": str, "updated": bool,
             "before"?: sha, "after"?: sha}
        500 {"status": "error", ..., "updated": false}
    Si ``updated`` est vrai : le repo local a été mis à jour sur disque mais
    le code chargé en mémoire est l'ancien. Le frontend doit PROPOSER un
    redémarrage et appeler l'endpoint Utils existant
    POST /holaf/utilities/restart — cette route ne redémarre JAMAIS seule
    (l'auto os.execv de la source AI-Helper a été retiré volontairement,
    cf. aih/update_manager.py). L'ancienne POST /aih/restart n'est pas
    recréée : le bouton Restart autonome appelle directement
    /holaf/utilities/restart.
    """
    from aih import update_manager as _update_manager

    @r.post("/aih/update")
    @require_auth
    async def aih_update_route(request):
        try:
            result = _update_manager.update_repo()
            return web.json_response(result)
        except Exception as e:
            import traceback
            return web.json_response({
                "status": "error",
                "message": f"Exception: {e}",
                "log": traceback.format_exc(),
                "updated": False,
            }, status=500)



# GROUPE 3 — Blobby Companion (settings + exec SÉCURISÉ)

def _get_blobby_file():
    """Chemin des paramètres du companion : user/default/aih/blobby.json.

    Porté du blobby companion de l'ancien monorepo AI-Helper (chemin inchangé),
    avec migration paresseuse depuis l'ancien user/default/aih_blobby.json.
    Calculé à la volée (et non à l'import comme la source) pour rester
    testable hors ComfyUI.
    """
    try:
        import folder_paths
        user_dir = folder_paths.get_user_directory()
    except Exception:
        user_dir = os.path.expanduser("~")
    blobby_file = os.path.join(user_dir, "default", "aih", "blobby.json")

    # Migration depuis l'ancien emplacement : user/default/aih_blobby.json
    try:
        old_blobby = os.path.join(user_dir, "default", "aih_blobby.json")
        if os.path.isfile(old_blobby) and not os.path.isfile(blobby_file):
            import shutil
            os.makedirs(os.path.dirname(blobby_file), exist_ok=True)
            shutil.move(old_blobby, blobby_file)
            logging.info(f"[Blobby] Migrated {old_blobby} → {blobby_file}")
    except Exception as e:
        logging.warning(f"[Blobby] Migration failed: {e}")
    return blobby_file


def _register_blobby_group(r, require_auth):
    """Routes du Blobby Companion.

    - POST /aih/blobby/save + GET /aih/blobby/load : stockage JSON clé→valeur
      des paramètres du companion (fichier local). SÉCURISÉES derrière
      ``require_auth`` (même cookie de session signé que /aih/blobby/exec) :
      lecture/écriture des paramètres du companion exigent une session valide.
    - POST /aih/blobby/exec : exécution shell locale. 🔴 À la source, cette
      route était OUVERTE (aucune auth). Elle est ici PORTÉE UNIQUEMENT
      SÉCURISÉE derrière l'authentification par mot de passe du terminal
      Holaf : le décorateur ``require_auth`` (holaf_auth.require_auth, passé
      par le __init__.py racine) vérifie le cookie de session signé
      ``holaf_session`` — exactement la même garde que GET /holaf/terminal.
      Le client doit donc s'authentifier au préalable via
      POST /holaf/auth/login ou POST /holaf/terminal/auth (le cookie part
      ensuite automatiquement sur chaque requête même origine). Sans session
      valide → 401. Si aucun décorateur n'a été fourni à register(), une
      garde fail-closed renvoie 503 en permanence : jamais de shell ouvert.
    """

    @r.post("/aih/blobby/save")
    @require_auth
    async def aih_blobby_save_route(request):
        try:
            body = await request.json()
            key = body.get("key")
            data = body.get("data")
            if not key:
                return web.json_response({"error": "key required"}, status=400)
            blobby_file = _get_blobby_file()
            all_data = {}
            if os.path.isfile(blobby_file):
                with open(blobby_file, "r", encoding="utf-8") as f:
                    all_data = json.load(f)
            all_data[key] = data
            os.makedirs(os.path.dirname(blobby_file), exist_ok=True)
            with open(blobby_file, "w", encoding="utf-8") as f:
                json.dump(all_data, f, indent=2, ensure_ascii=False)
            return web.json_response({"status": "ok"})
        except Exception as e:
            logging.error(f"[Blobby] save error: {e}")
            return web.json_response({"error": str(e)}, status=500)

    @r.get("/aih/blobby/load")
    @require_auth
    async def aih_blobby_load_route(request):
        try:
            key = request.query.get("key")
            if not key:
                return web.json_response({"error": "key required"}, status=400)
            blobby_file = _get_blobby_file()
            all_data = {}
            if os.path.isfile(blobby_file):
                with open(blobby_file, "r", encoding="utf-8") as f:
                    all_data = json.load(f)
            return web.json_response({"data": all_data.get(key, None)})
        except Exception as e:
            logging.error(f"[Blobby] load error: {e}")
            return web.json_response({"error": str(e)}, status=500)

    # ── Blobby Exec (commandes shell locales) — AUTH OBLIGATOIRE ────────

    guard = require_auth if require_auth is not None else _fail_closed_auth_guard

    @r.post("/aih/blobby/exec")
    @guard
    async def aih_blobby_exec_route(request):
        """Exécute une commande shell locale sur la machine ComfyUI."""
        import subprocess as _sp
        try:
            data = await request.json()
            action = (data.get("action") or "").strip()

            if action == "shell":
                cmd = (data.get("command") or "").strip()
                if not cmd:
                    return web.json_response({"ok": False, "output": "⚠️ Commande vide"}, status=400)
                # Limiter la durée des commandes shell.
                # Utiliser /bin/bash si disponible (boucles for, etc.)
                shell = os.environ.get('SHELL', '/bin/sh')
                if os.path.exists('/bin/bash'):
                    shell = '/bin/bash'
                try:
                    proc = _sp.run(cmd, shell=True, executable=shell,
                                   capture_output=True, text=True, timeout=15)
                    out = proc.stdout.strip()
                    if proc.stderr:
                        out += "\n" + proc.stderr.strip()
                    if proc.returncode != 0:
                        out += f"\n❌ Code: {proc.returncode}"
                    if not out:
                        out = "✅ Commande exécutée (pas de sortie)"
                    return web.json_response({"ok": True, "output": out})
                except _sp.TimeoutExpired:
                    return web.json_response({"ok": False, "output": "⏱️ Commande trop longue (>15s)"})
                except Exception as e:
                    return web.json_response({"ok": False, "output": f"❌ Erreur: {e}"})

            return web.json_response({"ok": False, "output": f"Action '{action}' inconnue"}, status=400)

        except Exception as e:
            import traceback
            return web.json_response(
                {"ok": False, "output": f"❌ Erreur: {e}", "log": traceback.format_exc()},
                status=500,
            )



# GROUPE 4 — Models SFTP chunked + fingerprint & Custom Nodes

def _register_models_group(r, require_auth):
    """Routes /api/aih/models/* (via aih.model_manager) et /api/aih/custom-nodes*
    (via aih.custom_nodes_manager). Contrats identiques à la source AI-Helper ;
    les transferts SFTP (paramiko) et HTTP sont lancés dans un executor pour ne
    jamais bloquer l'event loop aiohttp."""

    from aih import model_manager as _model_mgr
    from aih import custom_nodes_manager as _custom_nodes_mgr

    # ── Custom nodes (workflow sharing : liste + install) ──────────────

    @r.get("/api/aih/custom-nodes")
    async def aih_list_custom_nodes(request):
        try:
            nodes = _custom_nodes_mgr._get_installed_custom_nodes()
            return web.json_response({"nodes": nodes})
        except Exception as e:
            import logging as _log
            _log.exception(f"[AIH] custom-nodes error: {e}")
            return web.json_response({"error": str(e)}, status=500)

    @r.post("/api/aih/custom-nodes/install")
    @require_auth
    async def aih_install_node(request):
        try:
            body = await request.json()
            git_url = body.get("git_url", "").strip()
            name = body.get("name", "").strip()
            if not git_url:
                return web.json_response({"error": "git_url required"}, status=400)
            import asyncio as _aio
            import functools as _ft
            loop = _aio.get_event_loop()
            result = await loop.run_in_executor(
                None, _ft.partial(_custom_nodes_mgr._install_custom_node, git_url, name)
            )
            status = 200 if result["success"] else 400
            return web.json_response(result, status=status)
        except Exception as e:
            import logging as _log
            _log.exception(f"[AIH] install-node error: {e}")
            return web.json_response({"error": str(e)}, status=500)

    # ── Models : listes locale / distante ──────────────────────────────

    @r.get("/api/aih/models/list")
    async def aih_list_models(request):
        try:
            import asyncio as _aio
            import functools as _ft
            loop = _aio.get_event_loop()
            models = await loop.run_in_executor(None, _model_mgr.list_local_models)
            return web.json_response(models)
        except Exception as e:
            import logging as _log
            _log.exception(f"[AIH] models-list error: {e}")
            return web.json_response({"error": str(e)}, status=500)

    @r.get("/api/aih/models/remote")
    async def aih_list_remote_models(request):
        """Proxy : liste les modèles distants depuis le backend AIH."""
        try:
            page = int(request.query.get('page', 1))
            limit = int(request.query.get('limit', 50))
            type_filter = request.query.get('type', '') or None
            search = request.query.get('search', '') or None
            sort = request.query.get('sort', 'created_at')
            order = request.query.get('order', 'desc')
        except (ValueError, TypeError):
            return web.json_response({'error': 'Paramètres invalides'}, status=400)

        import asyncio as _aio
        import functools as _ft
        loop = _aio.get_event_loop()
        data = await loop.run_in_executor(
            None, _ft.partial(
                _model_mgr.list_remote_models,
                page, limit, type_filter, search, sort, order
            )
        )
        return web.json_response(data)

    @r.get("/api/aih/models/local")
    async def aih_list_local_models(request):
        """Liste les modèles locaux (scan du dossier models/ de ComfyUI)."""
        try:
            type_filter = request.query.get('type', '') or None
            search = request.query.get('search', '') or None
        except (ValueError, TypeError):
            return web.json_response({'error': 'Paramètres invalides'}, status=400)

        import asyncio as _aio
        import functools as _ft
        loop = _aio.get_event_loop()
        models = await loop.run_in_executor(
            None, _ft.partial(
                _model_mgr.list_local_models,
                type_filter=type_filter, search=search
            )
        )
        return web.json_response({'items': models, 'total': len(models)})

    # ── Models : upload (chunked ou SFTP direct) + progression ─────────

    @r.post("/api/aih/models/upload")
    async def aih_upload_model(request):
        try:
            body = await request.json()
            filepath = body.get("path", "")
            file_type = body.get("type", "model")
            if not filepath or not os.path.isfile(filepath):
                return web.json_response({"error": "path required and must exist"}, status=400)
            # Lancer l'upload dans un thread pour ne pas bloquer l'event loop
            import asyncio as _aio
            import functools as _ft
            loop = _aio.get_event_loop()
            result = await loop.run_in_executor(
                None, _ft.partial(_model_mgr.upload_model_to_server, filepath, file_type)
            )
            status = 200 if result["success"] else 400
            return web.json_response(result, status=status)
        except Exception as e:
            import logging as _log
            _log.exception(f"[AIH] upload-model error: {e}")
            return web.json_response({"error": str(e)}, status=500)

    @r.get("/api/aih/models/upload/progress")
    async def aih_upload_progress(request):
        try:
            filepath = request.query.get("path", "")
            if not filepath:
                return web.json_response({"error": "path required"}, status=400)
            p = _model_mgr.get_upload_progress(filepath)
            if p is None:
                return web.json_response(None, status=200)
            return web.json_response(p)
        except Exception as e:
            import logging as _log
            _log.exception(f"[AIH] upload-progress error: {e}")
            return web.json_response({"error": str(e)}, status=500)

    # ── Models : fingerprint (déduplication head/tail) ─────────────────

    @r.post("/api/aih/models/fingerprint")
    async def aih_fingerprint_model(request):
        try:
            body = await request.json()
            filepath = body.get("path", "")
            if not filepath or not os.path.isfile(filepath):
                return web.json_response({"error": "path required and must exist"}, status=400)
            fp = _model_mgr._compute_fingerprint(filepath)
            if fp:
                return web.json_response(fp)
            return web.json_response({"error": "fingerprint failed"}, status=500)
        except Exception as e:
            import logging as _log
            _log.exception(f"[AIH] fingerprint error: {e}")
            return web.json_response({"error": str(e)}, status=500)

    # ── Models : download (SFTP direct ou HTTP fallback) + progression ──

    @r.get("/api/aih/models/download/progress")
    async def aih_download_progress(request):
        try:
            upload_id = request.query.get("upload_id", "")
            if not upload_id:
                return web.json_response({"error": "upload_id required"}, status=400)
            p = _model_mgr.get_download_progress(upload_id)
            if p is None:
                return web.json_response(None, status=200)
            return web.json_response(p)
        except Exception as e:
            import logging as _log
            _log.exception(f"[AIH] download-progress error: {e}")
            return web.json_response({"error": str(e)}, status=500)

    @r.post("/api/aih/models/download")
    async def aih_download_model(request):
        try:
            body = await request.json()
            upload_id = body.get("upload_id", "")
            filename = body.get("filename", "")
            file_type = body.get("type", "model")
            dest_path = body.get("dest_path", None)
            if not upload_id or not filename:
                return web.json_response({"error": "upload_id and filename required"}, status=400)
            import asyncio as _aio
            import functools as _ft
            loop = _aio.get_event_loop()
            result = await loop.run_in_executor(
                None, _ft.partial(_model_mgr.download_model_from_server, upload_id, filename, file_type, dest_path)
            )
            status = 200 if result["success"] else 400
            return web.json_response(result, status=status)
        except Exception as e:
            import logging as _log
            _log.exception(f"[AIH] download-model error: {e}")
            return web.json_response({"error": str(e)}, status=500)



# GROUPE 5 — Mode miroir local (status, /aih/local/api/*, embeddings, music3,
# frontend statique) + démarrage du moteur de synchronisation.

def _load_local_modules():
    """Importe store, sync_engine et embedding_engine du socle aih/.

    Imports absolus standard (le bootstrap sys.path du __init__.py racine
    garantit un module unique pack-wide). Défensif : chaque import est
    indépendant, un échec laisse None et le groupe « local » dégrade son
    comportement (comme la source AI-Helper qui chargeait ces modules par
    importlib avec fallback None).
    """
    store_mod = sync_mod = emb_mod = None
    try:
        from aih import store as store_mod
    except Exception as e:
        logging.warning(f"[AIH-Routes] store indisponible : {e}")
    try:
        from aih import sync_engine as sync_mod
    except Exception as e:
        logging.warning(f"[AIH-Routes] sync_engine indisponible : {e}")
    try:
        from aih import embedding_engine as emb_mod
    except Exception as e:
        logging.warning(f"[AIH-Routes] embedding_engine indisponible : {e}")
    return store_mod, sync_mod, emb_mod


def _register_local_group(r):
    """Routes /aih/local/* — mode miroir local complet.

    Portage fidèle des routes inline d'AI-Helper :
      - GET /aih/local/status                     état store+sync (jamais d'exception)
      - GET /aih/local/api/music3/manifest        manifest.json local
      - GET /aih/local/api/music3/reference/{..}  contenu texte d'une référence
      - GET /aih/local/api/search/semantic        recherche sémantique keywords
      - GET|POST /aih/local/api/embeddings/*      état/build/progression
      - GET /aih/local/                           frontend site (index.html)
      - GET /aih/local/css/{..} | js/{..} | favicon{..}  assets statiques
      - GET /api/... non : /aih/local/api/{sections,subsections,stats,keywords,
            filters,elements-presets,styles,prompts/templates}   lecture miroirs
      - GET /aih/local/api/sync/{outbox,conflicts,retry}          outbox/conflits

    Le moteur de synchronisation daemon (sync_engine.start_sync_engine) est
    démarré par register() après ce groupe, reproduisant le comportement de
    fin de chargement de la source (idempotent ; sans api_key il ne fait
    qu'ignorer les cycles).
    """
    _store, _sync, _emb = _load_local_modules()
    if _store is None:
        logging.warning("[AIH-Routes] Groupe 'local' ignoré : store SQLite indisponible.")
        return

    # ── Route statut local (store SQLite + sync engine) ────────────────
    # GET /aih/local/status → état du mode local. La route doit être robuste
    # et ne JAMAIS bloquer l'event loop : lectures avec timeout court,
    # try/except large, valeurs par défaut si le store échoue.

    @r.get("/aih/local/status")
    async def aih_local_status_route(request):
        """État du mode local (store + sync engine + music3).

        Quand sync_engine.get_sync_status() est dispo, on fusionne son JSON
        (server_reachable, last_sync, pending_sync, conflicts, store_version,
        music3_last_updated) avec le contrat historique de la route (mode,
        etc.). Sinon fallback sur le store direct. Ne lève JAMAIS.
        """
        conn = None
        try:
            status = {}
            if _sync is not None and hasattr(_sync, "get_sync_status"):
                status = _sync.get_sync_status() or {}

            if not status:
                # Fallback store direct (sync_engine absent ou à vide).
                conn = _store.get_conn()
                # Timeout court : la base peut être verrouillée par le thread
                # de sync — on ne veut pas bloquer ici.
                conn.execute("PRAGMA busy_timeout=1000")
                _store.init_store(conn)

                last_updated = _store.get_meta(conn, "sync.last_updated")
                reachable_raw = _store.get_meta(conn, "sync.server_reachable")
                schema_raw = _store.get_meta(conn, "schema_version")

                store_version = 1
                if schema_raw:
                    try:
                        store_version = int(str(schema_raw).strip())
                    except (ValueError, TypeError):
                        store_version = 1

                if reachable_raw is not None:
                    server_reachable = str(reachable_raw).strip().lower() in (
                        "1", "true", "ok", "yes", "reachable"
                    )
                else:
                    # Pas de flag explicite : une sync réussie implique que
                    # le serveur était joignable à ce moment-là.
                    server_reachable = bool(last_updated)

                status = {
                    "server_reachable": server_reachable,
                    "last_sync": last_updated or None,
                    "pending_sync": 0,
                    "conflicts": 0,
                    "store_version": store_version,
                    "music3_last_updated": None,
                }

            # Fusion avec le contrat JSON historique de la route.
            return web.json_response({
                "mode": "local",
                "server_reachable": bool(status.get("server_reachable", False)),
                "last_sync": status.get("last_sync") or None,
                "pending_sync": int(status.get("pending_sync") or 0),
                "conflicts": int(status.get("conflicts") or 0),
                "store_version": int(status.get("store_version") or 1),
                "music3_last_updated": status.get("music3_last_updated") or None,
            })
        except Exception as e:
            # Ne jamais casser la route : retour d'un état minimal.
            return web.json_response({
                "mode": "local",
                "server_reachable": False,
                "last_sync": None,
                "pending_sync": 0,
                "conflicts": 0,
                "store_version": 1,
                "error": str(e),
            })
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    # ── Routes lecture locale music3 (miroir écrit par sync_engine) ────

    def _music3_paths():
        """Retourne (music3_dir, refs_dir) ou (None, None) si indispo.

        ⚠️ Anomalie historique PRÉSERVÉE (PLAN_FUSION.md §3.9) : les refs
        music3 vivent sous user/default/aihelper/data/music3/ (layout pré-aih/
        d'AI-Helper), PAS sous user/default/aih/. Ne pas « corriger » sans
        migration des données utilisateurs.
        """
        try:
            store_path = _store.get_store_path()
            user_dir = store_path.parent.parent.parent
            music3_dir = os.path.join(user_dir, "aihelper", "data", "music3")
            return music3_dir, os.path.join(music3_dir, "references")
        except Exception:
            return None, None

    @r.get("/aih/local/api/music3/manifest")
    async def aih_music3_manifest_route(request):
        """JSON du manifest local music3, ou 404 si absent."""
        try:
            music3_dir, _refs = _music3_paths()
            if not music3_dir:
                return web.json_response({"error": "not found"}, status=404)
            manifest_path = os.path.join(music3_dir, "manifest.json")
            if not os.path.isfile(manifest_path):
                return web.json_response({"error": "not found"}, status=404)
            with open(manifest_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return web.json_response(data)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @r.get("/aih/local/api/music3/reference/{path:.*}")
    async def aih_music3_reference_route(request):
        """Contenu texte d'une référence music3 locale (anti path-traversal).

        Le chemin résolu doit rester sous base.resolve() (sinon 403), et le
        fichier doit exister (sinon 404). mimetype text/plain.
        """
        from pathlib import Path as _Path
        try:
            relpath = request.match_info.get("path", "")
            _music3_dir, refs_dir = _music3_paths()
            if not refs_dir:
                return web.json_response({"error": "not found"}, status=404)
            base = _Path(refs_dir).resolve()
            target = (base / relpath).resolve()
            # Anti path-traversal : le fichier doit rester sous refs_dir.
            if os.path.commonpath([str(base), str(target)]) != str(base):
                return web.json_response({"error": "forbidden"}, status=403)
            if not target.is_file():
                return web.json_response({"error": "not found"}, status=404)
            with open(target, "r", encoding="utf-8") as f:
                content = f.read()
            return web.Response(text=content, content_type="text/plain")
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    # ── Recherche sémantique locale (embedding_engine) ──────────────────

    def _embedding_rows(rows):
        """Rows [{"id", "text"}] pour compute_all depuis le miroir keywords."""
        out = []
        for row in rows:
            if row.get("id") is None:
                continue
            text = " ".join(
                filter(None, [row.get("keyword"), row.get("description")])
            ).strip()
            out.append({"id": row.get("id"), "text": text})
        return out

    def _keyword_result(row, score):
        """Dictionnaire résultat ({id, keyword, description, ..., score})."""
        return {
            "id": row.get("id"),
            "keyword": row.get("keyword") or "",
            "description": row.get("description") or "",
            "section_title": row.get("section_title") or "",
            "subsection_title": row.get("subsection_title") or "",
            "nsfw": int(row.get("nsfw") or 0),
            "score": round(float(score or 0.0), 4),
        }

    def _building_flag(raw):
        return str(raw or "").strip().lower() in ("1", "true", "ok", "yes")

    def _start_embedding_build(emb_rows):
        """Lance compute_all('keyword', emb_rows) en thread daemon.

        Marque meta 'embedding.building'='1' et enregistre la progression dans
        meta 'embedding.progress' (JSON {done,total}). Retourne le nombre de
        rows à traiter (0 si le moteur est indisponible).
        """
        import threading as _threading
        if _emb is None:
            return 0
        emb_rows = [row for row in (emb_rows or []) if row.get("id") is not None]
        total = len(emb_rows)
        if total == 0:
            return 0

        def _write_progress(conn, done, total_):
            _store.set_meta(
                conn, "embedding.progress",
                json.dumps({"done": int(done), "total": int(total_)}),
            )

        def _progress_cb(done, total_):
            try:
                conn = _store.get_conn()
                try:
                    _write_progress(conn, done, total_)
                finally:
                    conn.close()
            except Exception:
                pass

        def _worker():
            done = 0
            try:
                done = _emb.compute_all("keyword", emb_rows, progress_cb=_progress_cb) or 0
            except Exception:
                done = 0
            finally:
                # Toujours lever le flag building + progress final.
                try:
                    conn = _store.get_conn()
                    try:
                        _store.set_meta(conn, "embedding.building", "0")
                        _write_progress(conn, done, total)
                    finally:
                        conn.close()
                except Exception:
                    pass

        # Statut "building" immédiat (avant le démarrage du thread).
        try:
            conn = _store.get_conn()
            try:
                _store.set_meta(conn, "embedding.building", "1")
                _write_progress(conn, 0, total)
            finally:
                conn.close()
        except Exception:
            pass

        t = threading.Thread(target=_worker, name="aih-embedding-build", daemon=True)
        t.start()
        return total

    @r.get("/aih/local/api/search/semantic")
    async def aih_local_search_semantic_route(request):
        """Recherche sémantique locale dans le miroir keywords.

        q obligatoire (400 si vide). Moteur prêt → embedding_engine.search()
        avec lazy build en arrière-plan ; sinon fallback LIKE SQL (score 0).
        Filtres nsfw / section appliqués après coup, tri par score desc.
        """
        try:
            q = (request.query.get("q") or "").strip()
            if not q:
                return web.json_response({"error": "q required"}, status=400)
            try:
                limit = int(request.query.get("limit", 50))
            except (TypeError, ValueError):
                return web.json_response({"error": "limit invalide"}, status=400)
            if limit < 0:
                limit = 50
            nsfw = (request.query.get("nsfw") or "").strip()
            section = (request.query.get("section") or "").strip()
            try:
                min_score = float(
                    request.query.get("min_confidence")
                    or request.query.get("confidence")
                    or 0
                )
            except (TypeError, ValueError):
                return web.json_response({"error": "confidence invalide"}, status=400)

            conn = _store.get_conn()
            try:
                rows = _store.list_mirror(conn, "keywords", {})
            finally:
                conn.close()

            by_id = {}
            for row in rows:
                try:
                    by_id[int(row.get("id"))] = row
                except (TypeError, ValueError):
                    continue

            results = []
            eng_ready = bool(
                _emb is not None and getattr(_emb, "is_ready", lambda: False)()
            )

            if eng_ready:
                hits = _emb.search("keyword", q, limit, min_score)
                if not hits:
                    # Build paresseux : aucun embedding pour ce fingerprint ?
                    fp = _emb.get_fingerprint()
                    conn = _store.get_conn()
                    try:
                        count = conn.execute(
                            "SELECT COUNT(*) AS c FROM local_embeddings "
                            "WHERE entity_type = 'keyword' "
                            "AND model_fingerprint = ?",
                            (fp,),
                        ).fetchone()["c"]
                    finally:
                        conn.close()
                    emb_rows = _embedding_rows(rows)
                    if int(count or 0) == 0 and emb_rows:
                        _start_embedding_build(emb_rows)
                        return web.json_response({"building": True, "results": []})
                for h in hits:
                    row = by_id.get(h.get("id"))
                    if row is None:
                        continue
                    results.append(_keyword_result(row, h.get("score")))
            else:
                # Fallback : recherche LIKE simple sur le store, score 0.
                like = q.lower()
                for row in rows:
                    hay = " ".join(
                        str(row.get(k) or "")
                        for k in ("keyword", "description", "section_title", "subsection_title")
                    ).lower()
                    if like in hay:
                        results.append(_keyword_result(row, 0.0))

            # Filtres nsfw / section (si fournis).
            if nsfw in ("0", "1"):
                target = int(nsfw)
                results = [x for x in results if int(x.get("nsfw") or 0) == target]
            if section:
                sections = [s.strip() for s in section.split(",") if s.strip()]
                if sections:
                    results = [
                        x for x in results
                        if str(x.get("section_title") or "").strip() in sections
                        or str(by_id.get(x.get("id"), {}).get("section_id") or "").strip() in sections
                    ]

            results.sort(key=lambda x: x.get("score") or 0, reverse=True)
            return web.json_response(results[:limit])
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @r.get("/aih/local/api/embeddings/status")
    async def aih_local_embeddings_status_route(request):
        """État du moteur d'embeddings local (config meta + compteur)."""
        try:
            conn = _store.get_conn()
            try:
                total = conn.execute(
                    "SELECT COUNT(*) AS c FROM local_embeddings"
                ).fetchone()["c"]
                cfg_raw = _store.get_meta(conn, "embedding.config")
                building_raw = _store.get_meta(conn, "embedding.building", "0")
            finally:
                conn.close()
            cfg = {}
            if cfg_raw:
                try:
                    cfg = json.loads(cfg_raw)
                except (TypeError, ValueError):
                    cfg = {}
            ready = False
            if _emb is not None:
                try:
                    ready = bool(_emb.is_ready())
                except Exception:
                    ready = False
            return web.json_response({
                "source": cfg.get("source") if cfg else None,
                "model_name": cfg.get("model_name") if cfg else None,
                "dim": int(cfg.get("dim") or 0) if cfg else 0,
                "fingerprint": cfg.get("fingerprint") if cfg else None,
                "ready": ready,
                "total": int(total or 0),
                "building": _building_flag(building_raw),
            })
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @r.post("/aih/local/api/embeddings/build")
    async def aih_local_embeddings_build_route(request):
        """Lance compute_all('keyword', rows) en thread daemon (non bloquant)."""
        try:
            conn = _store.get_conn()
            try:
                rows = _store.list_mirror(conn, "keywords", {})
            finally:
                conn.close()
            total = _start_embedding_build(_embedding_rows(rows))
            return web.json_response({"started": True, "total": total})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @r.get("/aih/local/api/embeddings/progress")
    async def aih_local_embeddings_progress_route(request):
        """Progression du build en cours (meta embedding.progress)."""
        try:
            conn = _store.get_conn()
            try:
                building_raw = _store.get_meta(conn, "embedding.building", "0")
                prog_raw = _store.get_meta(conn, "embedding.progress")
            finally:
                conn.close()
            building = _building_flag(building_raw)
            done = 0
            total = 0
            if prog_raw:
                try:
                    prog = json.loads(prog_raw)
                    done = int(prog.get("done") or 0)
                    total = int(prog.get("total") or 0)
                except (TypeError, ValueError):
                    pass
            return web.json_response({
                "building": building,
                "done": done,
                "total": total,
            })
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    # ── Frontend local (routes statiques /aih/local/*) ─────────────────
    # Le site frontend (copié dans <pack>/aih_frontend/) est servi depuis
    # ComfyUI en mode local : index + assets css/js + favicon. Anti
    # path-traversal via realpath containment. Même logique de réécriture
    # que la source : le backend Flask servait le site à la racine (assets
    # en absolu /css/... et /js/...) → on préfixe à la volée pour index.html.
    # Aucun autre chemin absolu codé n'existe dans les assets (vérifié :
    # seuls /css/app.css et /js/app-*.js sont référencés depuis index.html ;
    # les appels API du JS basculent sur /aih/local/api en mode local).

    _frontend_dir = os.path.join(_PACK_ROOT, "aih_frontend")
    _frontend_base = os.path.realpath(_frontend_dir)

    def _frontend_file(relpath):
        """Résout <aih_frontend>/<relpath> (None si absent ou hors base)."""
        from pathlib import Path as _P
        try:
            base = _P(_frontend_base)
            target = (base / relpath).resolve()
            if os.path.commonpath([str(base), str(target)]) != str(base):
                return None
            if not target.is_file():
                return None
            return str(target)
        except Exception:
            return None

    @r.get("/aih/local/")
    async def aih_local_index_route(request):
        """Sert aih_frontend/index.html (assets absolus réécrits en /aih/local/)."""
        try:
            idx = os.path.join(_frontend_dir, "index.html")
            if not os.path.isfile(idx):
                return web.json_response({"error": "not found"}, status=404)
            with open(idx, "r", encoding="utf-8") as f:
                html = f.read()
            # Réécriture identique à la source (backend Flask = racine).
            html = html.replace('href="/css/', 'href="/aih/local/css/')
            html = html.replace('src="/js/', 'src="/aih/local/js/')
            return web.Response(text=html, content_type="text/html")
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @r.get("/aih/local/css/{path:.*}")
    async def aih_local_css_route(request):
        """Sert un fichier CSS du frontend (mime text/css)."""
        try:
            relpath = request.match_info.get("path", "")
            if not relpath:
                return web.json_response({"error": "not found"}, status=404)
            path = _frontend_file(os.path.join("css", relpath))
            if path is None:
                return web.json_response({"error": "not found"}, status=404)
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
            return web.Response(text=content, content_type="text/css")
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @r.get("/aih/local/js/{path:.*}")
    async def aih_local_js_route(request):
        """Sert un fichier JS du frontend (mime application/javascript)."""
        try:
            relpath = request.match_info.get("path", "")
            if not relpath:
                return web.json_response({"error": "not found"}, status=404)
            path = _frontend_file(os.path.join("js", relpath))
            if path is None:
                return web.json_response({"error": "not found"}, status=404)
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
            return web.Response(text=content, content_type="application/javascript")
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @r.get("/aih/local/favicon{rest:.*}")
    async def aih_local_favicon_route(request):
        """Sert le favicon du frontend s'il existe (ico/png/svg)."""
        try:
            rest = request.match_info.get("rest", "")
            name = ("favicon" + rest).strip("/") or "favicon.ico"
            path = _frontend_file(name)
            if path is None:
                return web.json_response({"error": "not found"}, status=404)
            with open(path, "rb") as f:
                content = f.read()
            low = name.lower()
            if low.endswith(".png"):
                ctype = "image/png"
            elif low.endswith(".svg"):
                ctype = "image/svg+xml"
            else:
                ctype = "image/x-icon"
            return web.Response(body=content, content_type=ctype)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    # ── Proxy JSON local (lecture du store) ────────────────────────────
    # Endpoints /aih/local/api/* : mêmes contrats JSON que le backend Flask,
    # mais lus depuis les tables miroirs du store SQLite local.

    def _local_conn():
        """Ouvre une connexion store (init_store défensif)."""
        conn = _store.get_conn()
        try:
            _store.init_store(conn)
        except Exception:
            pass
        return conn

    def _local_decode(v):
        """Réhydrate un JSON dict/list stocké en texte (best-effort)."""
        if not isinstance(v, str):
            return v
        s = v.strip()
        if not s or s[0] not in "[{":
            return v
        try:
            d = json.loads(s)
        except (TypeError, ValueError):
            return v
        return d if isinstance(d, (dict, list)) else v

    def _local_decode_row(row):
        return {k: _local_decode(v) for k, v in row.items()}

    @r.get("/aih/local/api/sections")
    async def aih_local_api_sections_route(request):
        """Liste des sections (dédupliquée sur section_id)."""
        conn = None
        try:
            conn = _local_conn()
            seen = {}
            for row in _store.list_mirror(conn, "keywords", {}):
                sid = row.get("section_id")
                if sid is None or str(sid).strip() == "":
                    continue
                sid = str(sid)
                if sid in seen:
                    seen[sid]["total"] = seen[sid]["total"] + 1
                    seen[sid]["nsfw_count"] = seen[sid]["nsfw_count"] + int(row.get("nsfw") or 0)
                else:
                    seen[sid] = {
                        "section_id": sid,
                        "section_title": row.get("section_title") or "",
                        "total": 1,
                        "nsfw_count": int(row.get("nsfw") or 0),
                    }
            items = [seen[k] for k in sorted(seen)]
            return web.json_response(items)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    @r.get("/aih/local/api/subsections")
    async def aih_local_api_subsections_route(request):
        """Liste des sous-sections dédupliquées (filtre ?section=)."""
        conn = None
        try:
            section = (request.query.get("section") or "").strip()
            sections = [s.strip() for s in section.split(",") if s.strip()] if section else None
            conn = _local_conn()
            seen = {}
            for row in _store.list_mirror(conn, "keywords", {}):
                sid = row.get("subsection_id")
                if sid is None or str(sid).strip() == "":
                    continue
                if sections and str(row.get("section_id") or "").strip() not in sections:
                    continue
                sid = str(sid)
                if sid in seen:
                    seen[sid]["total"] = seen[sid]["total"] + 1
                else:
                    seen[sid] = {
                        "subsection_id": sid,
                        "subsection_title": row.get("subsection_title") or "",
                        "total": 1,
                    }
            items = [seen[k] for k in sorted(seen)]
            return web.json_response(items)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    @r.get("/aih/local/api/stats")
    async def aih_local_api_stats_route(request):
        """Statistiques globales (total / nsfw / public)."""
        conn = None
        try:
            conn = _local_conn()
            rows = _store.list_mirror(conn, "keywords", {})
            total = len(rows)
            nsfw = sum(1 for row in rows if int(row.get("nsfw") or 0) == 1)
            public = sum(1 for row in rows if str(row.get("privacy_status") or "").strip() == "public")
            sections = set(
                str(row.get("section_id") or "").strip()
                for row in rows if row.get("section_id") not in (None, "")
            )
            subsections = set(
                str(row.get("subsection_id") or "").strip()
                for row in rows if row.get("subsection_id") not in (None, "")
            )
            return web.json_response({
                "total": total,
                "nsfw": nsfw,
                "nsfw_total": nsfw,
                "public": public,
                "section_count": len(sections),
                "subsection_count": len(subsections),
                "generated_total": 0,
            })
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    @r.get("/aih/local/api/keywords")
    async def aih_local_api_keywords_route(request):
        """Liste des keywords filtrés (q / q_neg / section / subsection / nsfw / limit)."""
        conn = None
        try:
            q = (request.query.get("q") or "").strip().lower()
            q_neg = (request.query.get("q_neg") or "").strip().lower()
            nsfw = (request.query.get("nsfw") or "").strip()
            section = (request.query.get("section") or "").strip()
            subsection = (request.query.get("subsection") or "").strip()
            limit_raw = (request.query.get("limit") or "").strip()
            limit = None
            if limit_raw:
                try:
                    limit = int(limit_raw)
                except (TypeError, ValueError):
                    return web.json_response({"error": "limit invalide"}, status=400)
                if limit < 0:
                    limit = None
            sections = [s.strip() for s in section.split(",") if s.strip()] if section else None
            subsections = [s.strip() for s in subsection.split(",") if s.strip()] if subsection else None

            conn = _local_conn()
            out = []
            for row in _store.list_mirror(conn, "keywords", {}):
                kw = row.get("keyword") or ""
                desc = row.get("description") or ""
                sec_id = str(row.get("section_id") or "").strip()
                sec_title = str(row.get("section_title") or "").strip()
                sub_id = str(row.get("subsection_id") or "").strip()
                sub_title = str(row.get("subsection_title") or "").strip()
                kw_nsfw = int(row.get("nsfw") or 0)
                hay = " ".join([kw, desc, sec_title, sub_title]).lower()
                if q and q not in hay:
                    continue
                if q_neg and q_neg in hay:
                    continue
                if nsfw in ("0", "1") and kw_nsfw != int(nsfw):
                    continue
                if sections and sec_id not in sections and sec_title not in sections:
                    continue
                if subsections and sub_id not in subsections and sub_title not in subsections:
                    continue
                out.append({
                    "id": row.get("id"),
                    "keyword": kw,
                    "description": desc,
                    "section_id": sec_id,
                    "section_title": sec_title,
                    "subsection_id": sub_id,
                    "subsection_title": sub_title,
                    "nsfw": kw_nsfw,
                    "privacy_status": row.get("privacy_status") or "public",
                    "user_id": row.get("user_id"),
                })
            out.sort(key=lambda x: (x["section_id"], x["subsection_id"], x["keyword"]))
            if limit is not None:
                out = out[:limit]
            return web.json_response(out)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    @r.get("/aih/local/api/filters")
    async def aih_local_api_filters_route(request):
        """Liste des saved_filters (exclut les deleted)."""
        conn = None
        try:
            conn = _local_conn()
            rows = _store.list_mirror(conn, "saved_filters", {})
            return web.json_response([_local_decode_row(row) for row in rows])
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    @r.get("/aih/local/api/elements-presets")
    async def aih_local_api_elements_presets_route(request):
        """Liste des elements_presets."""
        conn = None
        try:
            conn = _local_conn()
            rows = _store.list_mirror(conn, "elements_presets", {})
            return web.json_response([_local_decode_row(row) for row in rows])
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    @r.get("/aih/local/api/styles")
    async def aih_local_api_styles_route(request):
        """Liste des styles."""
        conn = None
        try:
            conn = _local_conn()
            rows = _store.list_mirror(conn, "styles", {})
            return web.json_response([_local_decode_row(row) for row in rows])
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    @r.get("/aih/local/api/prompts/templates")
    async def aih_local_api_prompts_templates_route(request):
        """Liste des prompt_templates."""
        conn = None
        try:
            conn = _local_conn()
            rows = _store.list_mirror(conn, "prompt_templates", {})
            return web.json_response([_local_decode_row(row) for row in rows])
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    # ── Écritures en attente / conflits (outbox + miroirs) ─────────────
    # GET /aih/local/api/sync/outbox    → ops locales (pending/conflict/error)
    # GET /aih/local/api/sync/conflicts → lignes miroir en conflit
    # GET /aih/local/api/sync/retry     → flush manuel immédiat de l'outbox

    @r.get("/aih/local/api/sync/outbox")
    async def aih_local_sync_outbox_route(request):
        """Liste les écritures locales en attente (outbox, max 200).

        Contrat : {"items": [{id, entity_type, entity_client_id, op, status,
        attempts, last_error, created_at, client_updated_at}], "count": N}.
        Lecture directe de la table outbox via get_conn (pas list_mirror,
        qui ne connaît pas cette table).
        """
        conn = None
        try:
            conn = _local_conn()
            rows = conn.execute(
                "SELECT id, entity_type, entity_client_id, op, status, "
                "attempts, last_error, created_at, client_updated_at "
                "FROM outbox ORDER BY created_at DESC, id DESC LIMIT 200"
            ).fetchall()
            items = [dict(r) for r in rows]
            return web.json_response({"items": items, "count": len(items)})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    @r.get("/aih/local/api/sync/conflicts")
    async def aih_local_sync_conflicts_route(request):
        """Liste les lignes miroir en conflit (toutes tables, agrégées).

        Contrat : {"items": [{table, client_id, id, sync_state, updated_at}],
        "count": N}. Chaque table est traitée en try/except : une table
        absente ou sans colonnes n'arrête pas la route.
        """
        conn = None
        try:
            conn = _local_conn()
            items = []
            tables = getattr(_store, "MIRROR_TABLES", ()) or ()
            for table in tables:
                try:
                    rows = conn.execute(
                        f"SELECT client_id, id, sync_state, updated_at "
                        f"FROM {table} WHERE sync_state = 'conflict'"
                    ).fetchall()
                except Exception:
                    continue  # table absente / schéma différent
                for row in rows:
                    items.append({
                        "table": table,
                        "client_id": row["client_id"],
                        "id": row["id"],
                        "sync_state": row["sync_state"],
                        "updated_at": row["updated_at"],
                    })
            return web.json_response({"items": items, "count": len(items)})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    @r.get("/aih/local/api/sync/retry")
    async def aih_local_sync_retry_route(request):
        """Force un flush manuel immédiat de l'outbox (sync_engine).

        Appelle sync_engine.flush_outbox(api_url, api_key) dans un executor
        (flush synchrone/urllib → on ne bloque pas l'event loop). Retourne
        {"sent", "applied", "conflicts", "errors"} (+ auth/error).
        """
        try:
            if _sync is None:
                return web.json_response(
                    {"error": "sync_engine indisponible"}, status=500
                )
            api_url = api_key = None
            if hasattr(_sync, "_load_credentials"):
                try:
                    api_url, api_key = _sync._load_credentials()
                except Exception:
                    api_url = api_key = None
            if not api_url or not api_key:
                return web.json_response(
                    {"error": "credentials absentes (api_key / api_url non configurés)"},
                    status=400,
                )
            import asyncio as _aio
            import functools as _ft
            loop = _aio.get_event_loop()
            result = await loop.run_in_executor(
                None,
                _ft.partial(_sync.flush_outbox, api_url, api_key, 200),
            )
            if not isinstance(result, dict):
                result = {"sent": 0, "applied": 0, "conflicts": 0, "errors": 0}
            return web.json_response(result)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)


def start_sync_engine_if_available():
    """Démarre le moteur de synchronisation daemon (mode miroir local).

    Reproduit le comportement de fin de chargement de la source AI-Helper :
    thread daemon idempotent, cycles run_sync_once() toutes les 300 s, cycle
    simplement ignoré sans api_key. Échec = warning non bloquant.
    """
    try:
        from aih import sync_engine
        sync_engine.start_sync_engine()
        logging.info("[AIH-Routes] Sync engine started (local mirror mode)")
        return True
    except Exception as e:
        logging.warning(f"[AIH-Routes] Sync engine start failed: {e}")
        return False



# POINT D'ENTRÉE — appelé une fois par le __init__.py racine
# ══════════════════════════════════════════════════════════════════════

def register(server_routes, require_auth=None):
    """Enregistre toutes les routes AIH sur l'objet routes du PromptServer.

    Args:
        server_routes: ``server.PromptServer.instance.routes``.
        require_auth: décorateur d'authentification partagé Holaf
            (``holaf_auth.require_auth``). Il sécurise les routes sensibles
            (credentials, clés OpenAI, update, install de custom nodes,
            blobby save/load/exec). S'il n'est pas fourni, la garde
            fail-closed ``_fail_closed_auth_guard`` remplace la route de
            shell par un refus permanent (503) : jamais de shell ouvert
            par défaut.

    Returns:
        int: nombre de routes effectivement enregistrées.
    """
    log = []
    r = _RecordingRoutes(server_routes, log)

    def _safe(name, fn, *args):
        try:
            fn(*args)
            return True
        except Exception:
            logging.exception(f"[AIH-Routes] Échec de l'enregistrement du groupe '{name}'.")
            return False

    print("--- Registering AIH HTTP routes (aih/routes.py) ---")
    _safe("credentials", _register_credentials_group, r, require_auth)
    _safe("update", _register_update_group, r, require_auth)
    _safe("blobby", _register_blobby_group, r, require_auth)
    _safe("models", _register_models_group, r, require_auth)
    if _safe("local", _register_local_group, r):
        # Comportement d'origine de la source : le moteur de synchronisation
        # daemon du mode miroir démarre avec le chargement des routes local.
        # Idempotent ; sans api_key configurée les cycles sont simplement ignorés.
        start_sync_engine_if_available()

    for method, path in log:
        print(f"  • [AIH] {method:<4} {path}")
    print(f"✅ [AIH-Routes] {len(log)} route(s) AIH enregistrée(s).")
    return len(log)



