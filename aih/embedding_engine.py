# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""
embedding_engine.py — Moteur d'embedding 100% local pour la recherche
sémantique des keywords de l'extension AIH (ComfyUI).

Porté depuis le monorepo AI-Helper dans le sous-package
aih/ de CUI-Holaf-Utils (fusion PLAN_FUSION.md, Phase 2 chantier A) ; le bloc
d'import « robuste » de store (pré-enregistrement sys.modules + chargement
par chemin via importlib) devient un import absolu standard.

Trois sources possibles :
  - "embedded" : sentence-transformers (all-MiniLM-L6-v2 par défaut), chargé
    en lazy-load pour ne pas casser ComfyUI si le package est absent.
  - "ollama"   : serveur Ollama local via l'endpoint POST /api/embed.
  - "none"     : aucun moteur (l'appelant retombe sur du LIKE SQL).

Les embeddings sont persistés dans la table ``local_embeddings`` de store.py
(entity_type, entity_id, model_fingerprint, dim, embedding BLOB float32).
Le fingerprint (sha256 de "source|model_name|dim") permet d'invalider les
anciens embeddings quand la configuration change.

Les imports de sentence-transformers/numpy sont volontairement LAZY
(à l'intérieur des fonctions) : tant que source != "embedded", aucun de ces
packages n'est importé, ce qui préserve le démarrage de ComfyUI.
"""

import hashlib
import importlib.util
import json
import logging
import os
import sqlite3
import struct
import urllib.error
import urllib.request
from pathlib import Path

from aih import store

_LOG = logging.getLogger("aih.embeddings")

# Modèles par défaut.
DEFAULT_EMBEDDED_MODEL = "all-MiniLM-L6-v2"
DEFAULT_OLLAMA_MODEL = "nomic-embed-text"
DEFAULT_OLLAMA_URL = "http://localhost:11434"

# Dimensions connues des modèles supportés.
_DIM_MAP = {
    "minilm": 384,        # all-MiniLM-L6-v2
    "nomic": 768,         # nomic-embed-text
    "embeddinggemma": 3072,  # embeddinggemma
    "gemma": 3072,
}

# État courant du moteur (initialisé par configure()).
_source = "none"
_model_name = None
_dim = 0
_model = None  # instance SentenceTransformer chargée en lazy (source=embedded)
_ollama_url = DEFAULT_OLLAMA_URL
_ollama_model = DEFAULT_OLLAMA_MODEL


# ── Maths ────────────────────────────────────────────────────────────────

def cosine_similarity(vec_a, vec_b):
    """Cosine similarity entre deux vecteurs.

    Copie du pattern backend/embeddings.py : dot / (norm_a * norm_b),
    retourne 0.0 si l'un des vecteurs est nul.

    Args:
        vec_a (list[float]): Premier vecteur.
        vec_b (list[float]): Second vecteur.

    Retourne:
        float: Similarité cosinus dans [0.0, 1.0] pour des embeddings.
    """
    dot = sum(a * b for a, b in zip(vec_a, vec_b))
    norm_a = sum(a * a for a in vec_a) ** 0.5
    norm_b = sum(b * b for b in vec_b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


# ── Helpers internes ─────────────────────────────────────────────────────

def _guess_dim(model_name):
    """Dimension connue d'un modèle par son nom (0 si inconnu)."""
    name = (model_name or "").lower()
    for needle, dim in _DIM_MAP.items():
        if needle in name:
            return dim
    return 0


def _sentence_transformers_available():
    """True si le package sentence-transformers est importable (sans l'importer)."""
    try:
        return importlib.util.find_spec("sentence_transformers") is not None
    except Exception:
        return False


def _ping_ollama(url, timeout=3.0):
    """Ping GET {url}/api/tags — True si le serveur répond 200."""
    try:
        with urllib.request.urlopen(url.rstrip("/") + "/api/tags", timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def _load_embedded_model():
    """Importe (lazy) et charge le modèle sentence-transformers configuré.

    L'import ne se fait QUE si source == "embedded", pour ne pas casser
    ComfyUI quand sentence-transformers est absent.

    Retourne:
        SentenceTransformer|None: Modèle chargé (mis en cache), sinon None.
    """
    global _model
    if _source != "embedded":
        return None
    if _model is not None:
        return _model
    try:
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer(_model_name or DEFAULT_EMBEDDED_MODEL)
        return _model
    except Exception as e:  # pragma: no cover - dépend de l'env
        _LOG.warning("[AIH embeddings] chargement du modèle échoué : %s", e)
        _model = None
        return None


def _pack_vec(vec, dim):
    """Sérialise un vecteur en BLOB float32 (numpy si dispo, sinon struct).

    Args:
        vec (list[float]): Vecteur à stocker.
        dim (int): Dimension attendue (fallback struct).

    Retourne:
        bytes: BLOB float32.
    """
    try:
        import numpy as np
        return np.asarray(list(vec), dtype=np.float32).tobytes()
    except Exception:
        pass
    vals = [float(x) for x in vec]
    if dim and len(vals) == dim:
        return struct.pack("<%df" % dim, *vals)
    return struct.pack("<%df" % len(vals), *vals)


def _unpack_blob(blob, dim):
    """Reconstruit une liste de floats depuis un BLOB float32.

    Args:
        blob (bytes): BLOB à décoder.
        dim (int): Dimension attendue.

    Retourne:
        list[float]|None: Vecteur, ou None si le blob est invalide.
    """
    if not blob:
        return None
    try:
        import numpy as np
        arr = np.frombuffer(blob, dtype=np.float32)
        if dim and arr.size != dim:
            return None
        return [float(x) for x in arr]
    except Exception:
        pass
    if dim and len(blob) == dim * 4:
        return [float(x) for x in struct.unpack("<%df" % dim, blob)]
    if len(blob) % 4 == 0:
        return [float(x) for x in struct.unpack("<%df" % (len(blob) // 4), blob)]
    return None


# ── Configuration / état ─────────────────────────────────────────────────

def configure(model_source="auto", model_name=None, ollama_url=DEFAULT_OLLAMA_URL,
              ollama_model=DEFAULT_OLLAMA_MODEL):
    """Configure le moteur d'embeddings et persiste la config dans store.meta.

    - model_source='embedded' : sentence-transformers (all-MiniLM-L6-v2 par
      défaut, ou ``model_name``).
    - model_source='ollama'   : serveur Ollama local (``ollama_url`` +
      ``ollama_model``).
    - model_source='none'     : aucun moteur.
    - model_source='auto'     : embedded si sentence-transformers est
      importable, sinon ollama si {ollama_url}/api/tags répond (timeout 3 s),
      sinon 'none'.

    Persiste 'embedding.config' (JSON) et 'embedding.fingerprint'. Si le
    fingerprint change par rapport à la valeur précédente, les embeddings
    obsolètes sont invalidés.

    Args:
        model_source (str): 'auto' | 'embedded' | 'ollama' | 'none'.
        model_name (str|None): Modèle embedded (défaut all-MiniLM-L6-v2).
        ollama_url (str): URL du serveur Ollama.
        ollama_model (str): Modèle Ollama (défaut nomic-embed-text).

    Retourne:
        dict: {"source", "model_name", "dim", "fingerprint", "ready"}.
    """
    global _source, _model_name, _dim, _model, _ollama_url, _ollama_model

    source = (model_source or "auto").strip().lower()
    if source not in ("embedded", "ollama", "none"):
        source = "auto"

    if source == "auto":
        if _sentence_transformers_available():
            source = "embedded"
        elif _ping_ollama(ollama_url, timeout=3.0):
            source = "ollama"
        else:
            source = "none"

    # Détermine le modèle effectif + la dimension.
    if source == "embedded":
        _model_name = (model_name or DEFAULT_EMBEDDED_MODEL).strip()
        _dim = _guess_dim(_model_name)
    elif source == "ollama":
        _ollama_model = (ollama_model or DEFAULT_OLLAMA_MODEL).strip()
        _model_name = _ollama_model
        _dim = _guess_dim(_ollama_model)
    else:
        _model_name = None
        _dim = 0

    _source = source
    _model = None  # on repart d'un modèle non chargé après reconfig
    _ollama_url = ollama_url or DEFAULT_OLLAMA_URL
    _ollama_model = ollama_model or DEFAULT_OLLAMA_MODEL

    # Dimension de secours pour un modèle embedded non listé : on interroge
    # le modèle chargé (ne charge rien pour MiniLM/nomic/embeddinggemma).
    if source == "embedded" and _dim == 0:
        model = _load_embedded_model()
        if model is not None:
            try:
                dim = model.get_sentence_embedding_dimension()
                _dim = int(dim) if dim else 0
            except Exception:
                _dim = 0

    fingerprint = get_fingerprint()

    conn = store.get_conn()
    try:
        previous = store.get_meta(conn, "embedding.fingerprint")
        config = {
            "source": _source,
            "model_name": _model_name,
            "ollama_url": _ollama_url,
            "ollama_model": _ollama_model,
            "dim": _dim,
            "fingerprint": fingerprint,
        }
        store.set_meta(conn, "embedding.config", json.dumps(config, ensure_ascii=False))
        store.set_meta(conn, "embedding.fingerprint", fingerprint)
    finally:
        conn.close()

    if previous and previous != fingerprint:
        _LOG.info("[AIH embeddings] fingerprint changé → invalidation des embeddings")
        invalidate()

    return {
        "source": _source,
        "model_name": _model_name,
        "dim": _dim,
        "fingerprint": fingerprint,
        "ready": is_ready(),
    }


def get_fingerprint():
    """Empreinte sha256 hex de "source|model_name|dim".

    Retourne:
        str: 64 caractères hexadécimaux.
    """
    raw = "%s|%s|%s" % (_source or "none", _model_name or "", _dim or 0)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def is_ready():
    """True si le moteur est prêt à produire des embeddings.

    - embedded : le modèle sentence-transformers est importé et chargé.
    - ollama   : {ollama_url}/api/tags répond.
    - none     : False.
    """
    if _source == "embedded":
        return _load_embedded_model() is not None
    if _source == "ollama":
        return _ping_ollama(_ollama_url, timeout=3.0)
    return False


def get_dim():
    """Dimension des embeddings du moteur configuré.

    Retourne:
        int: 384 (MiniLM), 768 (nomic), 3072 (embeddinggemma), 0 si none.
    """
    if _source == "none":
        return 0
    if _dim:
        return _dim
    d = _guess_dim(_model_name)
    if d:
        return d
    if _source == "embedded":
        model = _load_embedded_model()
        if model is not None:
            try:
                dim = model.get_sentence_embedding_dimension()
                if dim:
                    return int(dim)
            except Exception:
                pass
    return 0


# ── Génération d'embeddings ──────────────────────────────────────────────

def embed_texts(texts):
    """Génère les embeddings d'une liste de textes.

    Args:
        texts (list[str]): Textes à encoder.

    Retourne:
        list[list[float]]|None: Vecteurs (un par texte), ou None si le
        moteur est 'none' ou en échec.
    """
    if _source == "none":
        return None
    texts = list(texts or [])
    if not texts:
        return []
    try:
        if _source == "embedded":
            model = _load_embedded_model()
            if model is None:
                return None
            vectors = model.encode(texts, normalize_embeddings=True)
            return [[float(x) for x in vec] for vec in vectors]

        if _source == "ollama":
            url = _ollama_url.rstrip("/") + "/api/embed"
            payload = json.dumps({"model": _ollama_model, "input": texts}).encode("utf-8")
            req = urllib.request.Request(
                url,
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=120) as resp:
                result = json.loads(resp.read().decode("utf-8"))
            embeddings = (result or {}).get("embeddings")
            if not isinstance(embeddings, list):
                _LOG.warning("[AIH embeddings] réponse Ollama inattendue : %s", str(result)[:200])
                return None
            return [[float(x) for x in vec] for vec in embeddings]
    except Exception as e:
        _LOG.warning("[AIH embeddings] échec embed_texts (%s) : %s", _source, e)
        return None
    return None


# ── Persistance ──────────────────────────────────────────────────────────

def compute_all(entity_type, rows, progress_cb=None, batch_size=32):
    """Calcule et stocke les embeddings de toutes les rows passées.

    Seules les rows dont l'embedding du fingerprint courant n'existe pas
    encore sont recalculées (delta). Les embeddings sont stockés en BLOB
    float32 dans local_embeddings (INSERT OR REPLACE).

    Args:
        entity_type (str): Type d'entité (ex: 'keywords').
        rows (list[dict]): Rows [{"id": ..., "text": ...}].
        progress_cb (callable|None): progress_cb(done, total) après chaque lot.
        batch_size (int): Taille des lots d'encodage.

    Retourne:
        int: Nombre d'embeddings réellement calculés et insérés.
    """
    if not is_ready():
        return 0
    dim = get_dim()
    if dim <= 0:
        return 0
    fingerprint = get_fingerprint()
    rows = list(rows or [])
    total = len(rows)
    batch_size = max(1, int(batch_size or 32))

    conn = store.get_conn()
    try:
        existing = {
            str(r["entity_id"])
            for r in conn.execute(
                "SELECT entity_id FROM local_embeddings "
                "WHERE entity_type = ? AND model_fingerprint = ?",
                (entity_type, fingerprint),
            ).fetchall()
        }
    finally:
        conn.close()

    # entity_id est une colonne TEXT : on compare/stocker en str pour éviter
    # les écarts int vs str entre les rows (dict) et la base.
    to_compute = [row for row in rows if str(row.get("id")) not in existing]
    done = total - len(to_compute)
    if progress_cb:
        progress_cb(done, total)

    n = 0
    for i in range(0, len(to_compute), batch_size):
        batch = to_compute[i:i + batch_size]
        vectors = embed_texts([row.get("text") or "" for row in batch])
        if vectors is None or len(vectors) != len(batch):
            _LOG.warning("[AIH embeddings] lot échoué (i=%d), interruption", i)
            break

        conn = store.get_conn()
        try:
            for row, vec in zip(batch, vectors):
                conn.execute(
                    "INSERT OR REPLACE INTO local_embeddings "
                    "(entity_type, entity_id, model_fingerprint, dim, embedding) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (entity_type, str(row.get("id")), fingerprint, dim,
                     _pack_vec(vec, dim)),
                )
                n += 1
            conn.commit()
        finally:
            conn.close()

        done += len(batch)
        if progress_cb:
            progress_cb(done, total)

    return n


def compute_one(entity_type, entity_id, text):
    """Calcule et stocke l'embedding d'une seule entité.

    Args:
        entity_type (str): Type d'entité.
        entity_id: Identifiant de l'entité.
        text (str): Texte à encoder.

    Retourne:
        bool: True si l'embedding a été stocké.
    """
    if not is_ready():
        return False
    vectors = embed_texts([text or ""])
    if not vectors:
        return False
    dim = get_dim()
    if dim <= 0:
        return False
    fingerprint = get_fingerprint()

    conn = store.get_conn()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO local_embeddings "
            "(entity_type, entity_id, model_fingerprint, dim, embedding) "
            "VALUES (?, ?, ?, ?, ?)",
            (entity_type, str(entity_id), fingerprint, dim,
             _pack_vec(vectors[0], dim)),
        )
        conn.commit()
        return True
    finally:
        conn.close()


def search(entity_type, query, limit=50, min_score=0.0, where_sql="", where_params=()):
    """Recherche sémantique par similarité cosinus dans local_embeddings.

    Args:
        entity_type (str): Type d'entité recherché.
        query (str): Texte de la requête.
        limit (int): Nombre max de résultats.
        min_score (float): Score minimum (cosinus) pour retenir un résultat.
        where_sql (str): Fragment SQL WHERE supplémentaire (AND ...), ex:
            "deleted = 0" ou "kind = ?".
        where_params (tuple): Paramètres SQL du fragment ``where_sql``.

    Retourne:
        list[dict]: [{"id": entity_id, "score": sim}, ...] triés par score
        décroissant. [] si le moteur est indisponible ou si aucun embedding
        n'est stocké (l'appelant retombe alors sur du LIKE SQL).
    """
    qe = embed_texts([query])
    if not qe:
        return []
    query_vec = qe[0]
    fingerprint = get_fingerprint()

    conn = store.get_conn()
    try:
        sql = (
            "SELECT entity_id, embedding FROM local_embeddings "
            "WHERE entity_type = ? AND model_fingerprint = ?"
        )
        params = [entity_type, fingerprint]
        if where_sql:
            sql += " AND (" + where_sql + ")"
            params.extend(list(where_params or ()))
        rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()

    results = []
    for row in rows:
        vec = _unpack_blob(row["embedding"], get_dim())
        if vec is None:
            continue
        sim = cosine_similarity(query_vec, vec)
        if sim >= min_score:
            raw_id = row["entity_id"]
            try:
                raw_id = int(raw_id)
            except (TypeError, ValueError):
                pass
            results.append({"id": raw_id, "score": sim})

    results.sort(key=lambda r: r["score"], reverse=True)
    return results[:limit]


def invalidate(entity_type=None):
    """Supprime les embeddings stockés (tout, ou un seul type).

    Appelé par configure() quand le fingerprint change.

    Args:
        entity_type (str|None): Type à supprimer, ou None pour tout.

    Retourne:
        int: Nombre de lignes supprimées.
    """
    conn = store.get_conn()
    try:
        if entity_type:
            cur = conn.execute(
                "DELETE FROM local_embeddings WHERE entity_type = ?",
                (entity_type,),
            )
        else:
            cur = conn.execute("DELETE FROM local_embeddings")
        conn.commit()
        return cur.rowcount or 0
    finally:
        conn.close()


# ── Divers ───────────────────────────────────────────────────────────────

def get_embedding_dir():
    """Dossier {store}/embeddings (créé si absent), utile pour les tests.

    Le stockage principal reste la table local_embeddings (BLOB) ; ce
    dossier peut accueillir d'éventuels caches auxiliaires.

    Retourne:
        Path: Dossier embeddings.
    """
    d = store.get_store_path().parent / "embeddings"
    d.mkdir(parents=True, exist_ok=True)
    return d
