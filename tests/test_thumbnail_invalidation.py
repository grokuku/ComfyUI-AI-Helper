# ─────────────────────────────────────────────────────────────────────────
# Tests STANDALONE de l'invalidation des miniatures.
#
# Couvre le bug « la galerie recalcule régulièrement toutes les miniatures » :
#   1. add_or_update_single_image() ne remet thumbnail_status=0 / priority /
#      last_generated_at=NULL QUE si le fichier a réellement changé
#      (mtime/size/thumb_hash), selon le même prédicat tolérant que le sync.
#      - ligne existante, mtime/size/hash IDENTIQUES → status reste 2 ;
#      - mtime à epsilon près (< 1e-3) → considéré inchangé ;
#      - mtime différent → status repasse à 0 ;
#      - image NOUVELLE → status 0 (mise en file) ;
#      - size / thumb_hash différents → status 0.
#   2. Le prédicat partagé _should_process_image() / _image_file_changed()
#      (utilisé par sync_image_database_blocking) est tolérant au mtime.
#   3. Le sync ne bump LAST_DB_UPDATE_TIME que sur un vrai changement (no-op
#      quand rien ne change) : la boucle de refresh front ne peut plus démarrer.
#   4. edit_routes.py ne doit PLUS écrire de thumb_hash aléatoire
#      (sha1(safe_path + time.time())[:12]) : la clé écrite est la clé
#      CANONIQUE sha1(path_canon) partagée partout.
#
# logic.py a des imports lourds (folder_paths, imports relatifs du package) qui
# ne se résolvent pas hors de ComfyUI : les fonctions ciblées sont extraites du
# SOURCE via AST (même harnais que tests/test_crop_standalone.py) et exécutées
# dans un namespace minimal avec une vraie base sqlite3 en mémoire.
#
# Usage :
#   python3 tests/test_thumbnail_invalidation.py
#   pytest tests/test_thumbnail_invalidation.py
# ─────────────────────────────────────────────────────────────────────────
import ast
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import time
import traceback
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
LOGIC_PATH = os.path.normpath(os.path.join(HERE, "..", "holaf_image_viewer_backend", "logic.py"))
EDIT_ROUTES_PATH = os.path.normpath(
    os.path.join(HERE, "..", "holaf_image_viewer_backend", "routes", "edit_routes.py")
)


def _extract_defs(source_path, names):
    """Extrait les définitions de fonctions ET constantes de premier niveau."""
    with open(source_path, "r", encoding="utf-8") as f:
        src = f.read()
    tree = ast.parse(src)
    defs = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names:
            defs[node.name] = ast.get_source_segment(src, node)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in names:
                    defs[target.id] = ast.get_source_segment(src, node)
    return defs


# ── Base sqlite3 en mémoire partagée (images) ──
_CREATE_IMAGES = """
CREATE TABLE images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT, subfolder TEXT, top_level_subfolder TEXT, path_canon TEXT,
    format TEXT, mtime REAL, size_bytes INTEGER, last_synced_at REAL,
    is_trashed INTEGER DEFAULT 0, original_path_canon TEXT,
    prompt_text TEXT, workflow_json TEXT, prompt_source TEXT, workflow_source TEXT,
    width INTEGER, height INTEGER, aspect_ratio_str TEXT, has_edit_file INTEGER,
    thumb_hash TEXT, has_prompt INTEGER, has_workflow INTEGER, has_edits INTEGER,
    has_tags INTEGER, thumbnail_status INTEGER, thumbnail_priority_score INTEGER,
    thumbnail_last_generated_at REAL
)
"""


class _Harness:
    """Namespace d'exécution de add_or_update_single_image() avec de vraies
    connexions sqlite3 (en mémoire) et des stubs pour les dépendances lourdes."""

    def __init__(self, output_dir):
        self.output_dir = output_dir
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.execute(_CREATE_IMAGES)
        self.conn.commit()
        self.last_update_calls = []
        self.stats_increments = []

    def build_namespace(self, helper_defs):
        ns = {
            "os": os,
            "json": json,
            "time": time,
            "sqlite3": sqlite3,
            "hashlib": hashlib,
            "traceback": traceback,
            "SUPPORTED_IMAGE_FORMATS": {".png", ".jpg"},
            "TRASHCAN_DIR_NAME": "trashcan",
            "EDIT_DIR_NAME": "edit",
            "folder_paths": SimpleNamespace(get_output_directory=lambda: self.output_dir),
            "holaf_database": SimpleNamespace(
                get_db_connection=lambda: self.conn,
                close_db_connection=lambda exception=None: None,
            ),
            "stats_manager": SimpleNamespace(increment_total=lambda: self.stats_increments.append(1)),
            "_extract_image_metadata_blocking": lambda path: {
                "width": 100, "height": 100, "ratio": "1:1",
                "prompt_source": "none", "workflow_source": "none",
                "has_edits": False, "tags": [],
            },
            "_update_image_tags_in_db": lambda cursor, image_id, tags: None,
            "_increment_folder_count": lambda cursor, subfolder: None,
            "update_last_db_update_time": lambda: self.last_update_calls.append(1),
        }
        for source in helper_defs.values():
            exec(source, ns)  # noqa: S102 — harnais de test (extraction AST)
        return ns

    def call(self, ns, image_path):
        return ns["add_or_update_single_image"](image_path)

    def status_row(self, path_canon):
        return self.conn.execute(
            "SELECT thumbnail_status, thumbnail_priority_score, thumbnail_last_generated_at, mtime, size_bytes, thumb_hash "
            "FROM images WHERE path_canon = ?", (path_canon,)
        ).fetchone()


def _build_harness(tmpdir):
    defs = _extract_defs(LOGIC_PATH, [
        "_MTIME_TOLERANCE_S", "_SYNC_CHANGED_ANOMALY_ABS", "_SYNC_CHANGED_ANOMALY_RATIO",
        "thumb_hash_for_path", "_image_file_changed", "_should_process_image",
        "add_or_update_single_image",
    ])
    missing = [n for n in (
        "thumb_hash_for_path", "_image_file_changed", "_should_process_image", "add_or_update_single_image"
    ) if n not in defs]
    if missing:
        raise AssertionError(f"Fonctions manquantes dans logic.py : {missing}")
    harness = _Harness(tmpdir)
    ns = harness.build_namespace(defs)
    return harness, ns


def _make_file(tmpdir, name="a.png", content=b"fake", mtime=1_700_000_000.0):
    path = os.path.join(tmpdir, name)
    with open(path, "wb") as f:
        f.write(content)
    os.utime(path, (mtime, mtime))
    return path


def _insert_existing(harness, path_canon, path, **overrides):
    st = os.stat(path)
    row = {
        "filename": os.path.basename(path),
        "subfolder": "",
        "top_level_subfolder": "root",
        "path_canon": path_canon,
        "format": "PNG",
        "mtime": st.st_mtime,
        "size_bytes": st.st_size,
        "last_synced_at": time.time(),
        "is_trashed": 0,
        "thumb_hash": hashlib.sha1(path_canon.encode("utf-8")).hexdigest(),
        "thumbnail_status": 2,
        "thumbnail_priority_score": 5,
        "thumbnail_last_generated_at": 123.0,
    }
    row.update(overrides)
    cols = ",".join(row.keys())
    placeholders = ",".join("?" for _ in row)
    harness.conn.execute(
        f"INSERT INTO images ({cols}) VALUES ({placeholders})", tuple(row.values())
    )
    harness.conn.commit()


# ═════════════════════════════════════════════════════════════════════════
# 1. add_or_update_single_image — n'invalide la vignette que sur vrai changement
# ═════════════════════════════════════════════════════════════════════════
def test_existing_identical_does_not_reset_thumbnail():
    with tempfile.TemporaryDirectory() as tmpdir:
        harness, ns = _build_harness(tmpdir)
        path = _make_file(tmpdir, mtime=1_700_000_000.0)
        canon = "a.png"
        # Ligne existante identique (mtime/size/hash = état disque), déjà générée.
        _insert_existing(harness, canon, path)

        harness.call(ns, path)

        row = harness.status_row(canon)
        assert row["thumbnail_status"] == 2, f"status attendu 2, obtenu {row['thumbnail_status']}"
        assert row["thumbnail_priority_score"] == 5, "priority ne doit pas être réécrite"
        assert row["thumbnail_last_generated_at"] == 123.0, "last_generated_at ne doit pas être NULLifié"
        assert not harness.last_update_calls, "un no-op ne doit pas bumper LAST_DB_UPDATE_TIME"
        print("✅ add_or_update — ligne identique : thumbnail_status reste 2, pas de bump")


def test_existing_mtime_within_tolerance_does_not_reset():
    with tempfile.TemporaryDirectory() as tmpdir:
        harness, ns = _build_harness(tmpdir)
        path = _make_file(tmpdir, mtime=1_700_000_000.0)
        canon = "a.png"
        # mtime DB à < 1e-3 de l'état disque → toléré (flottants FS).
        _insert_existing(harness, canon, path, mtime=os.stat(path).st_mtime + 5e-4)

        harness.call(ns, path)

        assert harness.status_row(canon)["thumbnail_status"] == 2, "mtime à epsilon près = inchangé"
        print("✅ add_or_update — mtime à epsilon près : thumbnail_status reste 2")


def test_existing_mtime_changed_resets_thumbnail():
    with tempfile.TemporaryDirectory() as tmpdir:
        harness, ns = _build_harness(tmpdir)
        path = _make_file(tmpdir, mtime=1_700_000_000.0)
        canon = "a.png"
        _insert_existing(harness, canon, path, mtime=os.stat(path).st_mtime - 100.0)

        harness.call(ns, path)

        row = harness.status_row(canon)
        assert row["thumbnail_status"] == 0, f"status attendu 0 (régénération), obtenu {row['thumbnail_status']}"
        assert row["thumbnail_priority_score"] == 1000
        assert row["thumbnail_last_generated_at"] is None
        assert harness.last_update_calls, "un vrai changement doit bumper LAST_DB_UPDATE_TIME"
        print("✅ add_or_update — mtime modifié : thumbnail_status repasse à 0 + bump")


def test_existing_size_changed_resets_thumbnail():
    with tempfile.TemporaryDirectory() as tmpdir:
        harness, ns = _build_harness(tmpdir)
        path = _make_file(tmpdir, mtime=1_700_000_000.0)
        canon = "a.png"
        _insert_existing(harness, canon, path, size_bytes=os.stat(path).st_size + 1)

        harness.call(ns, path)
        assert harness.status_row(canon)["thumbnail_status"] == 0, "size différent = vrai changement"
        print("✅ add_or_update — size différent : thumbnail_status repasse à 0")


def test_existing_thumb_hash_mismatch_resets_thumbnail():
    with tempfile.TemporaryDirectory() as tmpdir:
        harness, ns = _build_harness(tmpdir)
        path = _make_file(tmpdir, mtime=1_700_000_000.0)
        canon = "a.png"
        _insert_existing(harness, canon, path, thumb_hash="deadbeef" * 5)

        harness.call(ns, path)
        assert harness.status_row(canon)["thumbnail_status"] == 0, "thumb_hash divergent = vrai changement"
        print("✅ add_or_update — thumb_hash divergent : thumbnail_status repasse à 0")


def test_new_image_is_queued():
    with tempfile.TemporaryDirectory() as tmpdir:
        harness, ns = _build_harness(tmpdir)
        path = _make_file(tmpdir, name="brand_new.png", mtime=1_700_000_500.0)
        canon = "brand_new.png"

        harness.call(ns, path)

        row = harness.status_row(canon)
        assert row is not None, "l'image nouvelle doit être insérée"
        assert row["thumbnail_status"] == 0, "une image nouvelle doit être mise en file"
        assert row["thumbnail_priority_score"] == 1000
        assert row["thumbnail_last_generated_at"] is None
        assert harness.last_update_calls, "une insertion doit bumper LAST_DB_UPDATE_TIME"
        print("✅ add_or_update — image nouvelle : status 0 (mise en file)")


# ═════════════════════════════════════════════════════════════════════════
# 2. Prédicat partagé _should_process_image / _image_file_changed (sync)
# ═════════════════════════════════════════════════════════════════════════
def test_should_process_predicate_tolerant():
    with tempfile.TemporaryDirectory() as tmpdir:
        _harness, ns = _build_harness(tmpdir)
        sp = ns["_should_process_image"]

        record = {"mtime": 1000.0, "size_bytes": 10, "thumb_hash": "abc"}
        assert sp(None, 1000.0, 10, "abc") is True, "pas de ligne → à traiter"
        assert sp(record, 1000.0, 10, "abc") is False, "identique → pas à traiter"
        # mtime à epsilon près (< 1e-3) → inchangé (tolérance flottants FS)
        assert sp(record, 1000.0 + 5e-4, 10, "abc") is False, "mtime epsilon → inchangé"
        assert sp(record, 1000.0 + 0.5, 10, "abc") is True, "mtime réellement différent → à traiter"
        assert sp(record, 1000.0, 11, "abc") is True, "size différent → à traiter"
        assert sp(record, 1000.0, 10, "xyz") is True, "thumb_hash différent → à traiter"
        # legacy : thumb_hash NULL en DB vs hash calculé → à traiter
        assert sp({"mtime": 1000.0, "size_bytes": 10, "thumb_hash": None}, 1000.0, 10, "abc") is True
        print("✅ _should_process_image — prédicat tolérant (epsilon) et strict size/hash")


# ═════════════════════════════════════════════════════════════════════════
# 3. Clé canonique partagée
# ═════════════════════════════════════════════════════════════════════════
def test_thumb_hash_for_path_is_canonical_sha1():
    with tempfile.TemporaryDirectory() as tmpdir:
        _harness, ns = _build_harness(tmpdir)
        fn = ns["thumb_hash_for_path"]
        canon = "sub dir/img.png"
        assert fn(canon) == hashlib.sha1(canon.encode("utf-8")).hexdigest()
        print("✅ thumb_hash_for_path — clé canonique = sha1(path_canon)")


# ═════════════════════════════════════════════════════════════════════════
# 4. edit_routes : plus de thumb_hash aléatoire
# ═════════════════════════════════════════════════════════════════════════
def test_edit_route_writes_canonical_thumb_hash_only():
    with open(EDIT_ROUTES_PATH, "r", encoding="utf-8") as f:
        src = f.read()

    # Bug d'origine : sha1(safe_path + time.time())[:12] → faux changement au sync.
    assert "sha1((safe_path + str(time.time()))" not in src, (
        "edit_routes ne doit plus calculer de thumb_hash aléatoire (sha1 + time.time())"
    )
    assert ".hexdigest()[:12]" not in src, (
        "edit_routes ne doit plus tronquer un hash (hash tronqué != clé canonique)"
    )
    # La colonne thumb_hash doit être écrite avec la clé canonique partagée.
    assert "logic.thumb_hash_for_path(safe_path)" in src, (
        "edit_routes doit écrire la clé canonique sha1(path_canon) dans thumb_hash"
    )
    print("✅ edit_routes — thumb_hash canonique, plus de hash aléatoire")


# ═════════════════════════════════════════════════════════════════════════
# Runner standalone (hors pytest)
# ═════════════════════════════════════════════════════════════════════════
def main():
    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
    print(f"\n🎉 TOUS LES TESTS D'INVALIDATION MINIATURES PASSENT ({len(tests)} tests)")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print(f"❌ ÉCHEC : {e}")
        sys.exit(1)
