# Copyright (C) Holaf / grokuku — CUI-Holaf-Utils.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""
store.py — Store SQLite local pour le socle AIH (ex-extension AI-Helper,
sous-package aih/ de CUI-Holaf-Utils — PLAN_FUSION.md Phase 2 chantier A).

Objectif P1 (partie extension) : conserver localement les miroirs des
collections backend (keywords, saved_filters, styles, prompt_templates,
elements_presets) rapatriés par sync_engine.py.

Emplacement de la base : <ComfyUI>/user/default/aih/data/aihelper.db
⚠️ Chemin conservé À L'IDENTIQUE de l'extension AI-Helper d'origine pour ne
pas perdre les données existantes des utilisateurs. Ce répertoire cohabite
avec user/default/AI-Helper/ (racine des sous-systèmes Holaf) : noms
distincts, aucune collision.

Tables créées par init_store() :
- Une table miroir par collection : client_id (PRIMARY KEY), id, version,
  sync_state (DEFAULT 'synced'), deleted (DEFAULT 0), updated_at + les
  colonnes « pertinentes » ajoutées dynamiquement (ALTER TABLE ADD COLUMN)
  à mesure que le backend envoie de nouvelles colonnes.
- meta(key TEXT PRIMARY KEY, value TEXT) : sync.last_updated,
  sync.last_state, sync.user ...
- local_embeddings : réservée pour P3 (embeddings locaux).
- outbox : réservée pour P3 (file d'écriture différée vers le backend).

Connexions : WAL + busy_timeout 30 s + check_same_thread=False (le thread
daemon de sync et les nodes ComfyUI partagent l'accès à la base).
"""

import json
import logging
import os
import re
import sqlite3
import uuid
from pathlib import Path

# Collections mises en miroir localement (ordre = ordre du backend).
MIRROR_TABLES = (
    "keywords",
    "saved_filters",
    "styles",
    "prompt_templates",
    "elements_presets",
)

# Colonnes d'enveloppe de synchronisation présentes dans TOUTES les tables
# miroir. Les autres colonnes (keyword, description, config, name ...) sont
# ajoutées dynamiquement par upsert_mirror() au fil des exports.
_MIRROR_BASE_COLUMNS = {
    "client_id": "TEXT PRIMARY KEY",
    "id": "INTEGER",
    "version": "INTEGER DEFAULT 1",
    "sync_state": "TEXT DEFAULT 'synced'",
    "deleted": "INTEGER DEFAULT 0",
    "updated_at": "TEXT",
}

_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _get_aih_user_dir():
    """Dossier user/default/aih de ComfyUI.

    En runtime ComfyUI, passe par folder_paths.get_user_directory(). Hors
    runtime (tests), on retombe sur la racine ComfyUI via
    folder_paths.base_path ; dernier recours : un dossier user_data/aih
    DANS le pack (jamais custom_nodes/).

    Retourne:
        str: Chemin absolu vers user/default/aih.
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


def get_store_path():
    """Chemin du fichier SQLite local.

    Retourne:
        Path: {user_dir}/aihelper/data/aihelper.db, avec les parents créés.
    """
    data_dir = os.path.join(_get_aih_user_dir(), "data")
    os.makedirs(data_dir, exist_ok=True)
    return Path(data_dir) / "aihelper.db"


def get_conn():
    """Ouvre une connexion SQLite configurée pour l'usage multi-thread.

    - check_same_thread=False : partage possible entre le thread de sync et
      les nodes ComfyUI.
    - WAL : lectures sans blocage + écritures concurrentes via busy_timeout.
    - row_factory=sqlite3.Row : accès par nom de colonne.

    Retourne:
        sqlite3.Connection: Connexion prête (tables non créées).
    """
    conn = sqlite3.connect(str(get_store_path()), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
    except sqlite3.Error as e:
        logging.warning(f"[AIH store] WAL indisponible : {e}")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def _validated_table(table):
    """Vérifie que ``table`` est une table miroir connue (anti-injection SQL).

    Args:
        table (str): Nom de la table miroir.

    Retourne:
        str: Le nom de table validé.

    Lève:
        ValueError: Si le nom n'est pas dans MIRROR_TABLES.
    """
    if table not in MIRROR_TABLES:
        raise ValueError(f"table miroir inconnue : {table!r}")
    return table


def is_mirror_table(table):
    """True si ``table`` est une collection mise en miroir."""
    return isinstance(table, str) and table in MIRROR_TABLES


def _is_identifier(s):
    """True si ``s`` est un identifiant SQL sûr (nom de colonne/table)."""
    return isinstance(s, str) and bool(_IDENT_RE.match(s))


def init_store(conn):
    """Crée les tables miroirs + meta + local_embeddings + outbox.

    Idempotent : utilise CREATE TABLE IF NOT EXISTS partout.

    Args:
        conn (sqlite3.Connection): Connexion ouverte.
    """
    for table in MIRROR_TABLES:
        cols = ", ".join(f"{name} {ddl}" for name, ddl in _MIRROR_BASE_COLUMNS.items())
        conn.execute(
            f"CREATE TABLE IF NOT EXISTS {table} ({cols})"
        )

    conn.execute(
        "CREATE TABLE IF NOT EXISTS meta ("
        "  key TEXT PRIMARY KEY,"
        "  value TEXT"
        ")"
    )

    # Réservée pour P3 : embeddings locaux (recherche sémantique hors-ligne).
    conn.execute(
        "CREATE TABLE IF NOT EXISTS local_embeddings ("
        "  entity_type TEXT,"
        "  entity_id TEXT,"
        "  model_fingerprint TEXT,"
        "  dim INTEGER,"
        "  embedding BLOB,"
        "  PRIMARY KEY (entity_type, entity_id)"
        ")"
    )

    # Réservée pour P3 : écritures locales à pousser vers le backend.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS outbox ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  entity_type TEXT,"
        "  entity_client_id TEXT,"
        "  op TEXT,"
        "  payload TEXT,"
        "  base_version INTEGER,"
        "  client_updated_at TEXT,"
        "  status TEXT DEFAULT 'pending',"
        "  attempts INTEGER DEFAULT 0,"
        "  last_error TEXT,"
        "  created_at TEXT"
        ")"
    )

    conn.commit()


def _ensure_columns(conn, table, row_dict):
    """Ajoute les colonnes manquantes d'une table miroir (ALTER TABLE).

    Permet à upsert_mirror() de matérialiser les colonnes « pertinentes »
    envoyées par le backend sans schéma figé.

    Args:
        conn (sqlite3.Connection): Connexion ouverte.
        table (str): Table miroir validée.
        row_dict (dict): Dictionnaire source.
    """
    existing = {
        r["name"]
        for r in conn.execute(f"PRAGMA table_info({table})").fetchall()
    }
    for col in row_dict:
        if col not in existing and _is_identifier(col):
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} TEXT")
            existing.add(col)


def _to_sql_value(v):
    """Convertit une valeur Python en valeur SQLite stockable.

    Les dict/list (config JSON etc.) sont sérialisés en JSON texte.

    Args:
        v: Valeur à stocker.

    Retourne:
        Valeur storable (None, int, float, str, bytes, ou JSON str).
    """
    if v is None or isinstance(v, (int, float, str, bytes)):
        return v
    return json.dumps(v, ensure_ascii=False, default=str)


# ── CRUD miroirs ───────────────────────────────────────────────────────

def upsert_mirror(conn, table, row_dict):
    """Insère ou remplace une ligne dans une table miroir.

    Les colonnes sont construites à partir des clés du dict (ajoutées
    dynamiquement si absentes). ``client_id`` est généré si absent.

    Args:
        conn (sqlite3.Connection): Connexion ouverte.
        table (str): Table miroir (MIRROR_TABLES).
        row_dict (dict): Ligne à écrire (clés = colonnes).
    """
    table = _validated_table(table)
    data = dict(row_dict)

    cid = data.get("client_id")
    if not cid:
        data["client_id"] = uuid.uuid4().hex

    _ensure_columns(conn, table, data)
    cols = list(data.keys())
    sql = (
        f"INSERT OR REPLACE INTO {table} ({', '.join(cols)}) "
        f"VALUES ({', '.join('?' for _ in cols)})"
    )
    conn.execute(sql, [_to_sql_value(data[c]) for c in cols])
    conn.commit()


def delete_mirror(conn, table, client_id):
    """Supprime une ligne d'une table miroir par client_id.

    Args:
        conn (sqlite3.Connection): Connexion ouverte.
        table (str): Table miroir (MIRROR_TABLES).
        client_id (str): Identifiant stable de la ligne.
    """
    table = _validated_table(table)
    conn.execute(f"DELETE FROM {table} WHERE client_id = ?", (client_id,))
    conn.commit()


def list_mirror(conn, table, filters=None):
    """Liste les lignes d'une table miroir.

    Par défaut les lignes marquées ``deleted = 1`` sont exclues ; passer
    ``filters={"deleted": 1}`` pour les inclure.

    Args:
        conn (sqlite3.Connection): Connexion ouverte.
        table (str): Table miroir (MIRROR_TABLES).
        filters (dict|None): Filtres colonne = valeur (AND).

    Retourne:
        list[dict]: Lignes (enveloppées en dict).
    """
    table = _validated_table(table)
    where = []
    params = []
    filters = dict(filters or {})
    if "deleted" not in filters:
        where.append("deleted = 0")
    for k, v in filters.items():
        if not _is_identifier(k):
            continue
        where.append(f"{k} = ?")
        params.append(_to_sql_value(v))
    sql = f"SELECT * FROM {table}"
    if where:
        sql += " WHERE " + " AND ".join(where)
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


# ── Meta (clés/valeurs) ────────────────────────────────────────────────

def get_meta(conn, key, default=None):
    """Lit une valeur de la table meta.

    Args:
        conn (sqlite3.Connection): Connexion ouverte.
        key (str): Clé.
        default: Valeur retournée si la clé est absente.

    Retourne:
        str|default: Valeur stockée.
    """
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_meta(conn, key, value):
    """Écrit (ou remplace) une valeur dans la table meta.

    Args:
        conn (sqlite3.Connection): Connexion ouverte.
        key (str): Clé.
        value (str): Valeur (texte).
    """
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
        (key, value),
    )
    conn.commit()
