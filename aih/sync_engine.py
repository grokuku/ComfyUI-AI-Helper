# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""
sync_engine.py — Moteur de synchronisation locale AIH (ComfyUI).

Porté depuis le monorepo AI-Helper dans le sous-package aih/
de CUI-Holaf-Utils (fusion PLAN_FUSION.md, Phase 2 chantier A) ; les blocs
d'import « exotiques » (pré-enregistrement sys.modules + chargement par
chemin via importlib) sont remplacés par des imports absolus standards,
rendus possibles par le bootstrap sys.path du __init__.py racine du pack.

Objectif P1 : rapatrier les données du backend AIH dans le store SQLite
local (store.py, tables miroirs dans user/default/aih/data/aihelper.db).

Flux :
1. GET {api_url}/sync/manifest   → état des collections + user.
2. GET {api_url}/sync/export     → paginé (cursor, limit=500), scope
   PUBLIC + MINE, filtre incrémental ``since``.
3. apply_export()                → upsert/delete dans les tables miroirs,
   sans écraser les lignes locales dont sync_state = dirty/conflict.
4. flush_outbox() (write-back)   → POST {api_url}/sync/apply avec les ops
   locales de l'outbox, résolution des results (applied/conflict/error).
5. run_sync_once()               → cycle complet : export PUIS flush + meta
   (sync.last_updated, sync.last_state).
6. start_sync_engine()           → thread daemon qui boucle run_sync_once().

Auth : Bearer (api_key lue depuis credentials.json via aih.credentials).
Aucune dépendance externe (urllib).
"""

import http.client
import json
import logging
import os
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

from aih import store

_LOG = logging.getLogger("aih.sync")

# Limite max de pages pour éviter une boucle infinie en cas de curseur défaillant.
_MAX_PAGES = 1000
# Taille de page demandée au backend (le backend plafonne à 500).
_PAGE_LIMIT = 500
# Timeout HTTP pour les appels API.
_HTTP_TIMEOUT = 10

# Dernière erreur d'export observée (reset à chaque appel export_collections).
_last_export_error = None


def _http_get_json(url, api_key, timeout=_HTTP_TIMEOUT):
    """GET JSON avec header Authorization Bearer.

    Args:
        url (str): URL complète.
        api_key (str): Clé API.
        timeout (int): Timeout en secondes.

    Retourne:
        dict|list|None: JSON parsé, ou None si erreur réseau/HTTP/JSON.
    """
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        _LOG.warning(f"[AIH sync] GET {url} échoué : {e}")
        return None


def _http_post_json(url, api_key, payload, timeout=_HTTP_TIMEOUT):
    """POST JSON avec header Authorization Bearer.

    Args:
        url (str): URL complète.
        api_key (str): Clé API.
        payload (dict): Corps JSON à envoyer.
        timeout (int): Timeout en secondes.

    Retourne:
        tuple: (dict|list|None, status). (None, status) en cas d'erreur :
            status = code HTTP (401 → auth invalide), ou None si panne
            réseau/erreur de transport.
    """
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8")), resp.status
    except urllib.error.HTTPError as e:
        _LOG.warning(f"[AIH sync] POST {url} HTTP {e.code} : {e.reason}")
        return None, e.code
    except Exception as e:
        _LOG.warning(f"[AIH sync] POST {url} échoué : {e}")
        return None, None


def _http_get_text(url, api_key, timeout=_HTTP_TIMEOUT):
    """GET texte brut avec header Authorization Bearer.

    Comme _http_get_json mais sans parsing JSON : retourne le corps brut
    décodé en UTF-8, utile pour les fichiers de référence music3.

    Args:
        url (str): URL complète.
        api_key (str): Clé API.
        timeout (int): Timeout en secondes.

    Retourne:
        str|None: Contenu texte brut, ou None si erreur réseau/HTTP.
    """
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "*/*",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8")
    except Exception as e:
        _LOG.warning(f"[AIH sync] GET {url} échoué : {e}")
        return None


def sync_manifest(api_url, api_key):
    """Récupère le manifeste de synchronisation du backend.

    GET {api_url}/sync/manifest → {"schema_version", "server_time", "user",
    "collections": {nom: {"version", "updated_at"}}}.

    Args:
        api_url (str): Base URL du backend, avec /api (get_api_url()).
        api_key (str): Clé API (Bearer).

    Retourne:
        dict|None: JSON du manifeste, ou None si erreur.
    """
    url = f"{api_url.rstrip('/')}/sync/manifest"
    data = _http_get_json(url, api_key)
    if data is None:
        return None
    if not isinstance(data, dict):
        _LOG.warning("[AIH sync] manifeste non-dict reçu")
        return None
    return data


def export_collections(api_url, api_key, collections, since=None):
    """Rapatrie les lignes des collections (scope PUBLIC+MINE) en paginant.

    GET {api_url}/sync/export?collections=...&since=...&cursor=...&limit=500
    bouclé jusqu'à ``has_more=false`` (curseur global du backend).

    Args:
        api_url (str): Base URL du backend, avec /api.
        api_key (str): Clé API (Bearer).
        collections (list[str]|tuple[str]): Noms des collections à exporter.
        since (str|None): Timestamp ISO8601 — lignes modifiées après (None =
            export complet).

    Retourne:
        list[dict]: Lignes toutes collections confondues, chacune enrichie
            d'une clé ``collection``. [] si erreur (détail dans le log et
            dans _last_export_error).
    """
    global _last_export_error
    _last_export_error = None

    names = [c for c in (collections or []) if store.is_mirror_table(c)]
    if not names:
        _last_export_error = "aucune collection valide à exporter"
        return []

    all_rows = []
    cursor = None
    for _page in range(_MAX_PAGES):
        params = {
            "collections": ",".join(names),
            "limit": str(_PAGE_LIMIT),
        }
        if since:
            params["since"] = since
        if cursor:
            params["cursor"] = cursor
        url = (
            f"{api_url.rstrip('/')}/sync/export?"
            + urllib.parse.urlencode(params)
        )

        data = _http_get_json(url, api_key)
        if data is None:
            _last_export_error = f"export échoué (page {_page + 1})"
            break
        if not isinstance(data, dict):
            _last_export_error = f"réponse d'export invalide (page {_page + 1})"
            break

        collections_payload = data.get("collections") or {}
        for name, rows in collections_payload.items():
            if not isinstance(rows, list):
                continue
            for row in rows:
                if not isinstance(row, dict):
                    continue
                item = dict(row)
                item["collection"] = name
                all_rows.append(item)

        next_cursor = data.get("next_cursor")
        if data.get("has_more") and next_cursor:
            if next_cursor == cursor:
                _last_export_error = "curseur n'avance pas (risque de boucle)"
                break
            cursor = next_cursor
            continue
        break

    return all_rows


def _local_sync_state(conn, table, client_id):
    """État de sync d'une ligne miroir locale, ou None si absente."""
    row = conn.execute(
        f"SELECT sync_state FROM {table} WHERE client_id = ?", (client_id,)
    ).fetchone()
    return row["sync_state"] if row else None


def apply_export(conn, rows):
    """Applique des lignes exportées aux tables miroirs locales.

    Pour chaque ligne :
    - si une ligne locale existe avec sync_state = dirty/conflict → ignorée
      (on ne détruit pas les modifications locales non encore syncées) ;
    - si row.deleted = 1 → delete_mirror() ;
    - sinon → upsert_mirror() avec sync_state='synced'.

    Args:
        conn (sqlite3.Connection): Connexion ouverte (store.get_conn()).
        rows (list[dict]): Lignes exportées (avec clé ``collection``).

    Retourne:
        dict: {"applied": int, "skipped": int}.
    """
    applied = 0
    skipped = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        collection = row.get("collection")
        client_id = row.get("client_id")
        if not store.is_mirror_table(collection) or not client_id:
            skipped += 1
            continue

        local_state = _local_sync_state(conn, collection, client_id)
        if local_state in ("dirty", "conflict"):
            skipped += 1
            continue

        if int(row.get("deleted") or 0):
            store.delete_mirror(conn, collection, client_id)
        else:
            mirror = dict(row)
            mirror.pop("collection", None)
            mirror["sync_state"] = "synced"
            mirror["deleted"] = 0
            store.upsert_mirror(conn, collection, mirror)
        applied += 1

    return {"applied": applied, "skipped": skipped}


# ── Write-back : écritures locales vers le backend ────────────────────

# Clés d'enveloppe gérées par le moteur de sync (présentes dans les tables
# miroir mais jamais envoyées dans le payload métier d'une op).
_ENVELOPE_KEYS = ("client_id", "id", "version", "sync_state", "deleted", "updated_at")
# Clé interne stockée dans outbox.payload pour retrouver l'op_id d'un
# result — retirée avant l'envoi au backend (l'outbox n'a pas de colonne
# op_id dédiée, on ne modifie pas le schéma existant).
_OP_ID_KEY = "_op_id"


def write_local(conn, entity_type, payload, op="update", base_version=None):
    """Enregistre une écriture locale (create/update) dans le miroir + outbox.

    - Si ``op='create'`` ou l'entité est absente du miroir → génère un
      client_id uuid4 (ou conserve celui fourni dans le payload).
    - Upsert du miroir en ``sync_state='dirty'``, ``version = version + 1``
      (ou 1 à la création), ``updated_at = now``.
    - Insert une op 'pending' dans l'outbox (op_id uuid4 stocké dans le
      payload interne, retiré à l'envoi par flush_outbox).

    Args:
        conn (sqlite3.Connection): Connexion ouverte (store.get_conn()).
        entity_type (str): Table miroir (MIRROR_TABLES).
        payload (dict): Données métier de l'entité.
        op (str): 'create' ou 'update' (défaut 'update').
        base_version (int|None): Version serveur sur laquelle l'édition est
            basée (None → version courante du miroir si la ligne existe).

    Retourne:
        dict: {"ok": True, "client_id": str, "op_id": str}.

    Lève:
        ValueError: entity_type inconnu.
        TypeError: payload n'est pas un dict.
    """
    if not store.is_mirror_table(entity_type):
        raise ValueError(f"entity_type inconnu : {entity_type!r}")
    if not isinstance(payload, dict):
        raise TypeError("payload doit être un dict")
    if op not in ("create", "update"):
        op = "update"

    now = datetime.now(timezone.utc).isoformat()
    op_id = uuid.uuid4().hex

    client_id = payload.get("client_id")
    existing = None
    if client_id:
        row = conn.execute(
            f"SELECT * FROM {entity_type} WHERE client_id = ?", (client_id,)
        ).fetchone()
        if row is not None:
            existing = dict(row)

    if existing is not None:
        client_id = existing["client_id"]
        prev_version = int(existing.get("version") or 0)
        new_version = prev_version + 1
    else:
        client_id = client_id or uuid.uuid4().hex
        prev_version = 0
        new_version = 1

    # Miroir : fusion existant + payload, enveloppe forcée en dirty.
    mirror = dict(existing) if existing else {}
    for k, v in payload.items():
        if k in _ENVELOPE_KEYS:
            continue
        mirror[k] = v
    mirror["client_id"] = client_id
    mirror["version"] = new_version
    mirror["sync_state"] = "dirty"
    mirror["deleted"] = 0
    mirror["updated_at"] = now
    store.upsert_mirror(conn, entity_type, mirror)

    if base_version is None and existing is not None:
        base_version = prev_version

    out_payload = {k: v for k, v in payload.items() if k not in _ENVELOPE_KEYS}
    out_payload[_OP_ID_KEY] = op_id
    conn.execute(
        "INSERT INTO outbox (entity_type, entity_client_id, op, payload, "
        "base_version, client_updated_at, status, attempts, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)",
        (entity_type, client_id, op,
         json.dumps(out_payload, ensure_ascii=False, default=str),
         base_version, now, now),
    )
    conn.commit()
    return {"ok": True, "client_id": client_id, "op_id": op_id}


def delete_local(conn, entity_type, client_id):
    """Marque une ligne miroir supprimée et empile une op 'delete' en outbox.

    Le miroir passe à ``deleted=1``, ``sync_state='dirty'``,
    ``version = version + 1``. Si la ligne n'existe pas, un tombstone est
    créé (deleted=1, dirty, version=1) pour que la suppression soit bien
    propagée au backend.

    Args:
        conn (sqlite3.Connection): Connexion ouverte (store.get_conn()).
        entity_type (str): Table miroir (MIRROR_TABLES).
        client_id (str): Identifiant stable de la ligne à supprimer.

    Retourne:
        dict: {"ok": True, "client_id": str, "op_id": str}.
    """
    if not store.is_mirror_table(entity_type):
        raise ValueError(f"entity_type inconnu : {entity_type!r}")

    now = datetime.now(timezone.utc).isoformat()
    op_id = uuid.uuid4().hex

    row = conn.execute(
        f"SELECT * FROM {entity_type} WHERE client_id = ?", (client_id,)
    ).fetchone()
    if row is not None:
        existing = dict(row)
        prev_version = int(existing.get("version") or 0)
        new_version = prev_version + 1
        base_version = prev_version
        conn.execute(
            f"UPDATE {entity_type} SET deleted = 1, sync_state = 'dirty', "
            f"version = ?, updated_at = ? WHERE client_id = ?",
            (new_version, now, client_id),
        )
    else:
        prev_version = 0
        new_version = 1
        base_version = None
        store.upsert_mirror(conn, entity_type, {
            "client_id": client_id,
            "deleted": 1,
            "sync_state": "dirty",
            "version": new_version,
            "updated_at": now,
        })

    out_payload = {_OP_ID_KEY: op_id, "client_id": client_id}
    conn.execute(
        "INSERT INTO outbox (entity_type, entity_client_id, op, payload, "
        "base_version, client_updated_at, status, attempts, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)",
        (entity_type, client_id, "delete",
         json.dumps(out_payload, ensure_ascii=False, default=str),
         base_version, now, now),
    )
    conn.commit()
    return {"ok": True, "client_id": client_id, "op_id": op_id}


def flush_outbox(api_url, api_key, limit=200):
    """Pousse les écritures locales (outbox) vers le backend.

    Lit les ops 'pending'/'error' (attempts < 10) triées par created_at, puis
    POST {api_url}/sync/apply avec {client_id (meta 'sync.client_id', générée
    si absente), schema_version: 3, ops}. Traite chaque result :

    - applied  → outbox 'applied', miroir 'synced' + version=server_version.
    - conflict → outbox 'conflict', miroir 'conflict' ; selon la meta
      'sync.conflict_policy' (défaut 'keep_server') on copie server_row dans
      le miroir, sinon on laisse la version locale en place.
    - error    → attempts + 1, last_error ; status='error' si attempts >= 10.

    HTTP 401 (auth invalide) → arrête le flush, les ops restent pending.
    Panne réseau / erreur 5xx → échec silencieux, retry au cycle suivant.

    Args:
        api_url (str): Base URL du backend, avec /api.
        api_key (str): Clé API (Bearer).
        limit (int): Nombre max d'ops à envoyer par cycle.

    Retourne:
        dict: {"sent": int, "applied": int, "conflicts": int,
               "errors": int} (+ "auth"/"error" en cas d'échec global).
    """
    conn = store.get_conn()
    try:
        store.init_store(conn)

        client_id = store.get_meta(conn, "sync.client_id")
        if not client_id:
            client_id = uuid.uuid4().hex
            store.set_meta(conn, "sync.client_id", client_id)

        rows = conn.execute(
            "SELECT * FROM outbox WHERE status IN ('pending', 'error') "
            "AND attempts < 10 ORDER BY created_at, id LIMIT ?",
            (int(limit),),
        ).fetchall()
        if not rows:
            return {"sent": 0, "applied": 0, "conflicts": 0, "errors": 0}

        by_op_id = {}
        ops = []
        for r in rows:
            payload = json.loads(r["payload"] or "{}")
            if not isinstance(payload, dict):
                payload = {}
            op_id = payload.pop(_OP_ID_KEY, None) or str(r["id"])
            op = {
                "op_id": op_id,
                "entity_type": r["entity_type"],
                "entity_client_id": r["entity_client_id"],
                "op": r["op"],
                "payload": payload,
            }
            if r["base_version"] is not None:
                op["base_version"] = r["base_version"]
            if r["client_updated_at"]:
                op["client_updated_at"] = r["client_updated_at"]
            by_op_id[op_id] = r
            ops.append(op)

        url = f"{api_url.rstrip('/')}/sync/apply"
        body = {"client_id": client_id, "schema_version": 3, "ops": ops}
        data, status = _http_post_json(url, api_key, body)

        if status == 401:
            # Auth invalide : on n'incrémente rien, tout reste pending.
            _LOG.warning("[AIH sync] /sync/apply 401 (auth invalide), flush stoppé")
            return {"sent": 0, "applied": 0, "conflicts": 0, "errors": 0,
                    "auth": False}
        if data is None or status != 200:
            # Réseau / erreur serveur : retry au prochain cycle.
            _LOG.warning(f"[AIH sync] /sync/apply échoué (status={status})")
            return {"sent": 0, "applied": 0, "conflicts": 0, "errors": 0,
                    "error": f"POST /sync/apply échoué (status={status})"}

        results = data.get("results") if isinstance(data, dict) else data
        if not isinstance(results, list):
            results = []

        policy = store.get_meta(conn, "sync.conflict_policy", "keep_server")
        applied = conflicts = errors = 0
        for res in results:
            if not isinstance(res, dict):
                continue
            row = by_op_id.get(res.get("op_id"))
            if row is None:
                continue
            rstatus = res.get("status")
            table = row["entity_type"]
            cid = row["entity_client_id"]

            if rstatus == "applied":
                conn.execute(
                    "UPDATE outbox SET status = 'applied', last_error = NULL "
                    "WHERE id = ?",
                    (row["id"],),
                )
                server_version = res.get("server_version")
                if server_version is not None:
                    conn.execute(
                        f"UPDATE {table} SET sync_state = 'synced', version = ? "
                        f"WHERE client_id = ?",
                        (int(server_version), cid),
                    )
                else:
                    conn.execute(
                        f"UPDATE {table} SET sync_state = 'synced' "
                        f"WHERE client_id = ?",
                        (cid,),
                    )
                applied += 1

            elif rstatus == "conflict":
                conn.execute(
                    "UPDATE outbox SET status = 'conflict' WHERE id = ?",
                    (row["id"],),
                )
                server_row = res.get("server_row")
                if policy == "keep_server" and isinstance(server_row, dict):
                    mirror = dict(server_row)
                    if res.get("server_version") is not None:
                        mirror["version"] = res["server_version"]
                    mirror["sync_state"] = "conflict"
                    mirror["deleted"] = int(mirror.get("deleted") or 0)
                    store.upsert_mirror(conn, table, mirror)
                else:
                    conn.execute(
                        f"UPDATE {table} SET sync_state = 'conflict' "
                        f"WHERE client_id = ?",
                        (cid,),
                    )
                conflicts += 1

            else:  # 'error' ou statut inconnu → tentatives + statut error.
                attempts = int(row["attempts"] or 0) + 1
                last_error = str(res.get("message") or res.get("error")
                                 or res.get("detail") or "erreur backend")
                new_status = "error" if attempts >= 10 else "pending"
                conn.execute(
                    "UPDATE outbox SET attempts = ?, last_error = ?, status = ? "
                    "WHERE id = ?",
                    (attempts, last_error, new_status, row["id"]),
                )
                errors += 1

        conn.commit()
        return {"sent": len(ops), "applied": applied,
                "conflicts": conflicts, "errors": errors}
    finally:
        try:
            conn.close()
        except Exception:
            pass


def get_pending_count(conn=None):
    """Nombre d'ops locales en attente dans l'outbox.

    Compte les lignes outbox avec status 'pending' ou 'error' (les lignes
    'error' avec attempts < 10 restent retentables au prochain flush).

    Args:
        conn (sqlite3.Connection|None): Connexion ouverte ; si None, ouvre et
            initialise une connexion courte puis la referme.

    Retourne:
        int: Nombre d'ops en attente.
    """
    own = False
    if conn is None:
        conn = store.get_conn()
        store.init_store(conn)
        own = True
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM outbox "
            "WHERE status IN ('pending', 'error')"
        ).fetchone()
        return int(row["c"] or 0)
    finally:
        if own:
            try:
                conn.close()
            except Exception:
                pass


def run_sync_once(api_url, api_key):
    """Exécute un cycle de synchronisation complet.

    1. sync_manifest() → état des collections + user.
    2. export_collections(since=<dernier sync en meta>) → rows.
    3. apply_export() → miroirs locaux.
    4. flush_outbox() → write-back des écritures locales (l'export d'abord
       pour avoir les dernières versions serveur, PUIS la remontée locale).
    5. meta['sync.last_updated'] = server_time du manifeste,
       meta['sync.last_state']  = collections du manifeste (JSON),
       meta['sync.user']        = user du manifeste (JSON).

    Args:
        api_url (str): Base URL du backend, avec /api.
        api_key (str): Clé API (Bearer).

    Retourne:
        dict: {"synced": bool, "collections": list[str],
               "error": str|None, + stats}.
    """
    conn = store.get_conn()
    try:
        store.init_store(conn)

        manifest = sync_manifest(api_url, api_key)
        if manifest is None:
            return {
                "synced": False,
                "collections": [],
                "error": "GET /sync/manifest échoué (réseau ou auth)",
            }

        last_updated = store.get_meta(conn, "sync.last_updated")
        rows = export_collections(
            api_url, api_key, list(store.MIRROR_TABLES), since=last_updated
        )
        if _last_export_error:
            return {
                "synced": False,
                "collections": [],
                "error": f"export échoué : {_last_export_error}",
            }

        stats = apply_export(conn, rows)

        server_time = manifest.get("server_time")
        if server_time:
            store.set_meta(conn, "sync.last_updated", server_time)
        store.set_meta(
            conn,
            "sync.last_state",
            json.dumps(manifest.get("collections") or {}, ensure_ascii=False, default=str),
        )
        if manifest.get("user"):
            store.set_meta(
                conn,
                "sync.user",
                json.dumps(manifest.get("user"), ensure_ascii=False, default=str),
            )
        conn.commit()

        # Write-back : le serveur est joignable (manifest/export OK) → on
        # pousse les écritures locales de l'outbox après avoir rapatrié les
        # dernières versions serveur.
        flush = flush_outbox(api_url, api_key)

        return {
            "synced": True,
            "collections": sorted((manifest.get("collections") or {}).keys()),
            "error": None,
            "rows": len(rows),
            "applied": stats["applied"],
            "skipped": stats["skipped"],
            "server_time": server_time,
            "flush": flush,
        }
    except Exception as e:
        _LOG.exception(f"[AIH sync] run_sync_once échoué : {e}")
        return {
            "synced": False,
            "collections": [],
            "error": str(e),
        }
    finally:
        try:
            conn.close()
        except Exception:
            pass


def check_server(api_url, api_key):
    """Vérifie la joignabilité du backend AIH.

    GET {api_url}/sync/manifest avec un timeout court (connexion 2 s,
    lecture 5 s) et header Authorization Bearer. Retourne True uniquement si
    la réponse est HTTP 200 (4xx/5xx, timeout ou panne réseau → False, sans
    jamais lever d'exception). Met à jour store meta 'sync.server_reachable'
    = '1'/'0' sur une connexion courte.

    Args:
        api_url (str): Base URL du backend, avec /api.
        api_key (str): Clé API (Bearer).

    Retourne:
        bool: True si le backend répond HTTP 200 sur /sync/manifest.
    """
    reachable = False
    try:
        parsed = urllib.parse.urlparse(api_url.rstrip("/") + "/sync/manifest")
        scheme = (parsed.scheme or "https").lower()
        host = parsed.hostname
        if not host:
            raise ValueError("URL invalide")
        port = parsed.port or (443 if scheme == "https" else 80)
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        conn_cls = (
            http.client.HTTPSConnection
            if scheme == "https"
            else http.client.HTTPConnection
        )
        conn = conn_cls(host, port, timeout=2)
        try:
            conn.request(
                "GET",
                path,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Accept": "application/json",
                },
            )
            sock = conn.sock
            if sock is not None:
                sock.settimeout(5)
            resp = conn.getresponse()
            resp.read()
            reachable = resp.status == 200
        finally:
            conn.close()
    except Exception as e:
        _LOG.warning(f"[AIH sync] check_server échoué : {e}")

    try:
        conn = store.get_conn()
        try:
            store.init_store(conn)
            store.set_meta(conn, "sync.server_reachable", "1" if reachable else "0")
        finally:
            conn.close()
    except Exception as e:
        _LOG.warning(f"[AIH sync] check_server: meta non mise à jour : {e}")

    return reachable


def sync_music3_local(api_url, api_key):
    """Rapatrie les fichiers de référence music3 du backend.

    GET {api_url}/music3/manifest → {"files": [...], "last_updated": ...}.
    Chaque chemin relatif est téléchargé via GET /music3/reference/{relpath}
    puis écrit en miroir sous {user_dir}/aihelper/data/music3/references/
    (user_dir = store.get_store_path().parent.parent.parent ; garde anti
    path-traversal via resolve() + os.path.commonpath). Un manifest.json
    local (files + last_updated) est écrit dans {user_dir}/aihelper/data/
    music3/ et la meta 'music3.last_updated' est positionnée à l'instant
    courant.

    Args:
        api_url (str): Base URL du backend, avec /api.
        api_key (str): Clé API (Bearer).

    Retourne:
        dict: {"files_synced": int, "last_updated": str|None}.
        list: [] en cas d'erreur (détail dans le log).
    """
    try:
        store_path = store.get_store_path()
        user_dir = store_path.parent.parent.parent
        # ⚠️ Anomalie historique VOLONTAIREMENT préservée : le calcul remonte à
        # <user>/default/ puis réinsère "aihelper" (héritage de l'ancien layout
        # d'AI-Helper, avant la migration vers aih/) → les refs music3 vivent
        # réellement sous user/default/aihelper/data/music3/, et NON sous
        # user/default/aih/. Ne PAS "corriger" sans prévoir la migration des
        # données existantes des utilisateurs.
        music3_dir = os.path.join(user_dir, "aihelper", "data", "music3")
        refs_dir = os.path.join(music3_dir, "references")

        manifest = _http_get_json(
            f"{api_url.rstrip('/')}/music3/manifest", api_key, timeout=10
        )
        if manifest is None or not isinstance(manifest, dict):
            _LOG.warning("[AIH sync] music3: manifest invalide ou absent")
            return []

        files = manifest.get("files") or []
        last_updated = manifest.get("last_updated")

        base = Path(refs_dir).resolve()
        os.makedirs(base, exist_ok=True)
        base_str = str(base)

        synced = 0
        for rel in files:
            if not isinstance(rel, str):
                continue
            rel = rel.strip()
            if not rel or rel.startswith("/") or "\\" in rel:
                _LOG.warning(f"[AIH sync] music3: chemin refusé : {rel!r}")
                continue
            try:
                target = (base / rel).resolve()
                if os.path.commonpath([base_str, str(target)]) != base_str:
                    _LOG.warning(
                        f"[AIH sync] music3: chemin hors base refusé : {rel!r}"
                    )
                    continue
                content = _http_get_text(
                    f"{api_url.rstrip('/')}/music3/reference/"
                    f"{urllib.parse.quote(rel, safe='/')}",
                    api_key,
                    timeout=10,
                )
                if content is None:
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with open(target, "w", encoding="utf-8") as f:
                    f.write(content)
                synced += 1
            except Exception as e:
                _LOG.warning(f"[AIH sync] music3: fichier {rel!r} ignoré : {e}")

        manifest_path = os.path.join(music3_dir, "manifest.json")
        os.makedirs(music3_dir, exist_ok=True)
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(
                {"files": files, "last_updated": last_updated},
                f,
                ensure_ascii=False,
                default=str,
            )

        iso_now = datetime.now(timezone.utc).isoformat()
        conn = store.get_conn()
        try:
            store.init_store(conn)
            store.set_meta(conn, "music3.last_updated", iso_now)
        finally:
            conn.close()

        return {"files_synced": synced, "last_updated": last_updated}
    except Exception as e:
        _LOG.exception(f"[AIH sync] sync_music3_local échoué : {e}")
        return []


def get_sync_status():
    """État de synchronisation (pour l'UI / le monitoring).

    Lit les meta du store sur une connexion courte, compte les écritures en
    attente (outbox) et les conflits des tables miroirs.

    Retourne:
        dict: {"server_reachable", "last_sync", "pending_sync",
               "conflicts", "store_version", "music3_last_updated"}.
    """
    conn = store.get_conn()
    try:
        store.init_store(conn)

        last_sync = store.get_meta(conn, "sync.last_updated")
        server_reachable = store.get_meta(conn, "sync.server_reachable") == "1"
        music3_last_updated = store.get_meta(conn, "music3.last_updated")

        try:
            store_version = int(store.get_meta(conn, "schema_version", "1"))
        except (TypeError, ValueError):
            store_version = 1

        pending_sync = 0
        try:
            row = conn.execute(
                "SELECT COUNT(*) AS c FROM outbox "
                "WHERE status IN ('pending', 'error')"
            ).fetchone()
            pending_sync = int(row["c"] or 0)
        except sqlite3.Error:
            pending_sync = 0

        conflicts = 0
        for table in store.MIRROR_TABLES:
            try:
                row = conn.execute(
                    f"SELECT COUNT(*) AS c FROM {table} "
                    "WHERE sync_state = 'conflict'"
                ).fetchone()
                conflicts += int(row["c"] or 0)
            except sqlite3.Error:
                continue

        return {
            "server_reachable": server_reachable,
            "last_sync": last_sync,
            "pending_sync": pending_sync,
            "conflicts": conflicts,
            "store_version": store_version,
            "music3_last_updated": music3_last_updated,
        }
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _load_credentials():
    """Charge api_url + api_key via aih.credentials.

    Retourne:
        tuple: (api_url, api_key) ou (None, None) si indisponible.
    """
    try:
        from aih import credentials as creds
        return creds.get_api_url(), creds.get_api_key()
    except Exception as e:
        _LOG.warning(f"[AIH sync] credentials indisponibles : {e}")
        return None, None


_sync_thread = None
_sync_stop = threading.Event()
_sync_lock = threading.Lock()


def start_sync_engine(interval_seconds=300):
    """Démarre le thread daemon de synchronisation périodique.

    Boucle run_sync_once() toutes les ``interval_seconds``, avec try/except
    de logging. Idempotent : ne démarre qu'un seul thread.

    Args:
        interval_seconds (int): Période du cycle (défaut 300 s).

    Retourne:
        threading.Thread|None: Le thread démarré (ou l'existant).
    """
    global _sync_thread

    with _sync_lock:
        if _sync_thread is not None and _sync_thread.is_alive():
            return _sync_thread
        _sync_stop.clear()

        def _loop():
            _LOG.info(f"[AIH sync] moteur démarré (interval={interval_seconds}s)")
            while not _sync_stop.is_set():
                try:
                    api_url, api_key = _load_credentials()
                    if not api_key or not api_url:
                        # Pas d'api_key OU pas d'URL serveur configurée
                        # (comportement dégradé : cycle ignoré, jamais d'erreur).
                        _LOG.warning("[AIH sync] credentials incomplets (api_key ou server_url manquant), cycle ignoré")
                    else:
                        result = run_sync_once(api_url, api_key)
                        if result.get("error"):
                            _LOG.warning(f"[AIH sync] cycle en erreur : {result['error']}")
                        else:
                            _LOG.info(
                                f"[AIH sync] cycle ok : {result['applied']} appliquées, "
                                f"{result['skipped']} ignorées, "
                                f"{result['rows']} lignes reçues"
                            )
                except Exception as e:
                    _LOG.exception(f"[AIH sync] exception de cycle : {e}")
                _sync_stop.wait(interval_seconds)
            _LOG.info("[AIH sync] moteur arrêté")

        t = threading.Thread(
            target=_loop, name="aih-sync-engine", daemon=True
        )
        t.start()
        _sync_thread = t
        return t


def stop_sync_engine(timeout=None):
    """Stoppe proprement le moteur (utile pour les tests/arrêt).

    Args:
        timeout (float|None): Délai d'attente de fin du thread.

    Retourne:
        threading.Thread|None: Le thread stoppé, ou None.
    """
    global _sync_thread
    with _sync_lock:
        t = _sync_thread
        if t is None:
            return None
        _sync_stop.set()
    if timeout is not None:
        t.join(timeout)
    return t
