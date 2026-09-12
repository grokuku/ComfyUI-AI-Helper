# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""
local_source.py — Couche de lecture locale (P1) par-dessus le store SQLite.

Rôle : offrir aux nodes ComfyUI des helpers de LECTURE depuis le store local
(store.py, tables miroirs dans user/default/aih/data/aihelper.db) SANS toucher
à leur logique cloud existante.

┌─ P1 (ce fichier) — lecture seule, AUCUN câblage dans les nodes ─────────┐
│ • Les nodes continuent d'utiliser le backend par défaut.                │
│ • Les helpers de lecture sont prêts et testables :                      │
│     list_local / get_local_by_id / read_template_local /                │
│     read_style_local / read_music_ref_local.                            │
│ • is_local_ready() / get_status_dict() permettent aux widgets           │
│   d'afficher un badge "offline / mode local" sans appeler la route.     │
└──────────────────────────────────────────────────────────────────────────┘

┌─ P2 (à venir) — fallback transparent ───────────────────────────────────┐
│ Les nodes basculeront sur ces helpers quand le backend est injoignable  │
│ (ou via une option "source locale" lecture seule). Aucun changement de  │
│ signature nécessaire : read_template_local(id) retourne un dict          │
│ compatible avec ce que _fetch_template() attendait (system_prompt,       │
│ examples...), read_style_local(id) idem (style_text, negative_prompt).   │
└──────────────────────────────────────────────────────────────────────────┘

Contrat des valeurs : store.upsert_mirror() sérialise les colonnes dict/list
en JSON texte (_to_sql_value). list_local()/get_local_by_id()/read_*_local()
réhydratent ces colonnes en best-effort — uniquement quand le JSON est un
dict ou une liste (les scalaires restent tels quels, pour ne pas corrompre
des chaînes légitimes type "123").

Porté depuis le monorepo AI-Helper dans le sous-package aih/
de CUI-Holaf-Utils (fusion PLAN_FUSION.md, Phase 2 chantier A) : le chargement
« robuste » de store (pré-enregistrement sys.modules + fallback importlib)
est remplacé par un simple import absolu.
"""

import json
import logging
import os
from pathlib import Path

from aih import store

_LOG = logging.getLogger("aih.local_source")


# ── Connexions ──────────────────────────────────────────────────────────

def _open_conn():
    """Ouvre une connexion store (store.get_conn())."""
    return store.get_conn()


def _close_conn(conn):
    """Ferme une connexion si elle est ouverte (defensif)."""
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass


# ── Décodage JSON best-effort ───────────────────────────────────────────

def _decode_json_value(v):
    """Réhydrate une valeur sérialisée par store._to_sql_value.

    Ne décode QUE les JSON dont le résultat est un dict ou une liste (ce que
    le store sérialise). Les scalaires (int, float, str, bool, None) restent
    tels quels, y compris des chaînes comme "123" ou "true".
    """
    if not isinstance(v, str):
        return v
    s = v.strip()
    if not s or s[0] not in "[{":
        return v
    try:
        decoded = json.loads(s)
    except (ValueError, TypeError):
        return v
    if isinstance(decoded, (dict, list)):
        return decoded
    return v


def _decode_row(row):
    """Réhydrate toutes les valeurs JSON d'une ligne miroir."""
    return {k: _decode_json_value(v) for k, v in row.items()}


# ── Lecture générique ───────────────────────────────────────────────────

def list_local(conn, table, filters=None):
    """Liste les lignes d'une table miroir locale (lecture seule).

    Wrapper de store.list_mirror() : mêmes filtres (AND colonne = valeur),
    les lignes deleted=1 sont exclues par défaut (passer
    filters={'deleted': 1} pour les inclure). Les colonnes JSON
    (dict/list sérialisées par le store) sont réhydratées en best-effort.

    Args:
        conn (sqlite3.Connection|None): Connexion store, ou None pour en
            ouvrir/fermer une ici (usage node, tables initialisées).
        table (str): Table miroir (store.MIRROR_TABLES).
        filters (dict|None): Filtres colonne = valeur (AND).

    Retourne:
        list[dict]: Lignes, enveloppes de sync comprises (client_id,
            version, sync_state, deleted, updated_at) + colonnes métier.

    Lève:
        ValueError: Si ``table`` n'est pas une table miroir connue.
    """
    own = conn is None
    if own:
        conn = _open_conn()
    try:
        if own:
            store.init_store(conn)
        rows = store.list_mirror(conn, table, filters=filters)
        return [_decode_row(r) for r in rows]
    finally:
        if own:
            _close_conn(conn)


def get_local_by_id(conn, table, id):
    """Cherche une ligne miroir par sa colonne métier ``id``.

    Args:
        conn (sqlite3.Connection|None): Connexion store, ou None.
        table (str): Table miroir.
        id (int|str): Valeur de la colonne ``id``.

    Retourne:
        dict|None: La première ligne correspondante (colonnes JSON
            réhydratées), ou None si absente/supprimée.
    """
    rows = list_local(conn, table, filters={"id": id})
    return rows[0] if rows else None


# ── Meta / état local ───────────────────────────────────────────────────

def get_meta(key, default=None):
    """Lit une clé de la table meta du store (connexion ouverte/fermée ici).

    Args:
        key (str): Clé (ex: 'sync.last_updated').
        default: Valeur retournée si la clé est absente.

    Retourne:
        str|default: Valeur stockée.
    """
    conn = _open_conn()
    try:
        store.init_store(conn)
        return store.get_meta(conn, key, default)
    finally:
        _close_conn(conn)


def is_local_ready():
    """Le store est-il initialisé et peuplé ?

    Critères : init_store ok, meta['sync.last_updated'] renseignée ET au
    moins une table miroir contient une ligne non supprimée.

    Retourne:
        bool
    """
    conn = _open_conn()
    try:
        store.init_store(conn)
        if not store.get_meta(conn, "sync.last_updated"):
            return False
        for table in store.MIRROR_TABLES:
            try:
                if store.list_mirror(conn, table, filters={"deleted": 0}):
                    return True
            except Exception:
                continue
        return False
    except Exception as e:
        _LOG.warning(f"[AIH local_source] is_local_ready() échoué : {e}")
        return False
    finally:
        _close_conn(conn)


def get_status_dict():
    """État du mode local — même JSON que la route GET /aih/local/status.

    Permet aux nodes/widgets d'afficher un badge offline sans dépendre de la
    route HTTP (même logique : timeout court, try/except large, valeurs par
    défaut si le store échoue).

    Retourne:
        dict: {"mode": "local", "server_reachable": bool,
               "last_sync": str|None, "pending_sync": 0,
               "store_version": int} (+ "error" en cas d'échec, comme la
               route).
    """
    conn = None
    try:
        conn = _open_conn()
        # Timeout court : la base peut être verrouillée par le thread de
        # sync — on ne veut pas bloquer un widget.
        conn.execute("PRAGMA busy_timeout=1000")
        store.init_store(conn)

        last_updated = store.get_meta(conn, "sync.last_updated")
        reachable_raw = store.get_meta(conn, "sync.server_reachable")
        schema_raw = store.get_meta(conn, "schema_version")

        store_version = 1
        if schema_raw:
            try:
                store_version = int(str(schema_raw).strip())
            except (ValueError, TypeError):
                store_version = 1

        if reachable_raw is not None:
            server_reachable = str(reachable_raw).strip().lower() in (
                "1", "true", "ok", "yes", "reachable",
            )
        else:
            # Pas de flag explicite : une sync réussie
            # (sync.last_updated renseigné) implique que le serveur a été
            # joignable à ce moment-là.
            server_reachable = bool(last_updated)

        return {
            "mode": "local",
            "server_reachable": server_reachable,
            "last_sync": last_updated or None,
            "pending_sync": 0,
            "store_version": store_version,
        }
    except Exception as e:
        # Ne jamais casser un widget : retour d'un état minimal.
        return {
            "mode": "local",
            "server_reachable": False,
            "last_sync": None,
            "pending_sync": 0,
            "store_version": 1,
            "error": str(e),
        }
    finally:
        _close_conn(conn)


# ── Helpers métier prêts pour P2 ────────────────────────────────────────

def read_template_local(template_id):
    """Lit un template de prompt depuis le store local.

    Équivalent lecture locale de _fetch_template(api_url, api_key,
    template_id) de enhance_node.py. En P1 les nodes gardent le backend ;
    cette fonction sera branchée en P2 en fallback transparent.

    Args:
        template_id (int|str): Colonne ``id`` de prompt_templates.

    Retourne:
        dict|None: Ligne miroir (avec system_prompt, examples réhydraté...),
            ou None si absente / store non peuplé.
    """
    return get_local_by_id(None, "prompt_templates", template_id)


def read_style_local(style_id):
    """Lit un style depuis le store local.

    Équivalent lecture locale de _fetch_style(api_url, api_key, style_id)
    de enhance_node.py. Branchée en P2 en fallback transparent.

    Args:
        style_id (int|str): Colonne ``id`` de styles.

    Retourne:
        dict|None: Ligne miroir (avec style_text, negative_prompt...), ou
            None si absente / store non peuplé.
    """
    return get_local_by_id(None, "styles", style_id)


def _local_music3_refs_dir():
    """Dossier local des références music3 (miroir écrit par sync_engine).

    Chemin cohérent avec sync_engine.sync_music3_local() :
      user_dir = store.get_store_path().parent.parent.parent, puis
      user_dir/aihelper/data/music3/references.

    Retourne:
        str|None: Chemin du dossier références, ou None si store indispo.
    """
    try:
        store_path = store.get_store_path()
    except Exception:  # pragma: no cover - défensif
        return None
    user_dir = store_path.parent.parent.parent
    return os.path.join(user_dir, "aihelper", "data", "music3", "references")


def read_music_ref_local(relpath):
    """Lit un fichier de référence music3 depuis le cache LOCAL (lecture seule).

    Équivalent local de music_node._fetch_ref() (GET /api/music3/reference/*).
    Lit RÉELLEMENT le fichier sous
    {user_dir}/aihelper/data/music3/references/<relpath> (le miroir écrit par
    sync_engine.sync_music3_local()), avec garde anti path-traversal.

    Args:
        relpath (str): Chemin relatif (ex: 'genre-router.md',
            'families/<fam>/index.md').

    Retourne:
        str|None: Contenu texte (utf-8), ou None si absent/illisible/hors base.
    """
    if not isinstance(relpath, str) or not relpath:
        return None
    refs_dir = _local_music3_refs_dir()
    if not refs_dir:
        return None
    try:
        base = Path(refs_dir).resolve()
    except Exception:
        return None
    try:
        target = (base / relpath).resolve()
    except Exception:
        return None
    try:
        if os.path.commonpath([str(base), str(target)]) != str(base):
            return None
    except ValueError:
        return None
    if not target.is_file():
        return None
    try:
        return target.read_text(encoding="utf-8")
    except Exception as e:
        _LOG.warning(f"[AIH local_source] lecture music3 ref échouée ({relpath}): {e}")
        return None
