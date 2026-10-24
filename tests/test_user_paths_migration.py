# ─────────────────────────────────────────────────────────────────────────
# Tests STANDALONE des chemins de données utilisateur + du moteur de migration
# (PHASE 1 : socle; aucun consommateur n'est encore branché).
#
# Motif utilisateur (cité dans le module testé) : « mon but c'est d'alléger mon
# dossier de custom nodes ». Sur l'installation déployée, la base
# holaf_utilities.sqlite pesait 1,8 Go DANS custom_nodes/ComfyUI-AI-Helper.
# La migration déplace ces données vers <ComfyUI>/user/default/AI-Helper/
# (ou AIH_USER_ROOT), ce qui (a) allège le dossier du pack, (b) survit à une
# réinstallation du pack, (c) sépare code et données pour la sauvegarde.
#
# Couverture :
#   1. Résolution des chemins : get_user_directory() prioritaire, repli
#      base_path, dernier recours ~/.config/comfyui, AIH_USER_ROOT prioritaire,
#      accesseurs p_* et chemins legacy.
#   2. Migration d'un FAUX arbre (tmp_path) contenant une VRAIE base SQLite en
#      WAL avec des lignes : déplacement des TROIS fichiers (.db + -wal + -shm),
#      integrity_check OK, mêmes lignes, ancien disparu, idempotence (2e appel
#      = no-op).
#   3. ALLÈGEMENT mesuré : après migration le dossier du pack ne contient plus
#      holaf_utilities.sqlite (+ sidecars + backups), ni config.ini, ni
#      .sftp_known_hosts, ni .cache/thumbnails.
#   4. Conflit (les deux présents) : AUCUN écrasement, ancien intact, warning,
#      entrée dans .migration.json.
#   5. Échec partiel : un item en erreur n'interrompt rien, il garde son ancien
#      chemin et sera retenté (2e appel sans la panne → migré).
#   6. Vérité de la vérification post-déplacement : un écart simulé provoque le
#      déplacement INVERSE immédiat et l'item passe "failed".
#   7. Garde anti-test : AIH_SKIP_USER_MIGRATION=1 (posé par run_tests.sh ET
#      tests/conftest.py) ou pytest sans force → RIEN ne bouge, rien n'est créé.
#   8. Verrou .migration.lock : verrou frais = une autre instance migre (rien ne
#      bouge) ; verrou périmé (> 10 min) = cassé et la migration passe.
#   9. Journal .migration.json = audit seulement (un journal corrompu ne bloque
#      jamais la migration).
#
# Contrôles négatifs par mutation (hors dépôt, sources restaurées) :
#   /projects/.aih_tmp/user_paths_mutate/mutate.py
#     M1 .db déplacé SANS -wal            → rouge
#     M2 écrasement quand les deux existent → rouge
#     M3 plus de vérification post-move   → rouge
#     M4 échec d'un item qui interrompt les suivants → rouge
#     M5 migration exécutée sous pytest   → rouge
#     M6 AIH_USER_ROOT ignorée            → rouge
#
# Usage :
#   PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
#   pytest tests/test_user_paths_migration.py
# ─────────────────────────────────────────────────────────────────────────
import importlib.util
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
MODULE_PATH = PACKAGE_DIR / "holaf_user_paths.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("holaf_user_paths_under_test", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mod = _load_module()


# ---------------------------------------------------------------------------
# Outils de test
# ---------------------------------------------------------------------------
class _QuietLogger:
    """Logger muet qui garde tout : on vérifie les warnings sans polluer."""

    def __init__(self):
        self.messages = []

    def info(self, message):
        self.messages.append(("info", message))

    def warning(self, message):
        self.messages.append(("warning", message))

    def error(self, message):
        self.messages.append(("error", message))

    def warnings(self):
        return [msg for level, msg in self.messages if level == "warning"]

    def errors(self):
        return [msg for level, msg in self.messages if level == "error"]


class _Tree:
    """Faux arbre ComfyUI : user/, custom_nodes/ComfyUI-AI-Helper/ et cible."""

    def __init__(self, base: Path):
        self.base = base
        self.comfy_user = base / "ComfyUI" / "user"
        self.custom_nodes = base / "ComfyUI" / "custom_nodes"
        self.pack = self.custom_nodes / "ComfyUI-AI-Helper"
        self.root = self.comfy_user / "default" / "AI-Helper"

        self.legacy_aih = self.comfy_user / "default" / "aih"
        self.legacy_aihelper = self.comfy_user / "default" / "aihelper"
        self.legacy_db_utils = self.pack / "holaf_utilities.sqlite"
        self.legacy_config = self.pack / "config.ini"
        self.legacy_known_hosts = self.custom_nodes / ".sftp_known_hosts"
        self.legacy_backup = self.pack / "holaf_utilities.sqlite.backup_v12_1700000000"
        self.legacy_music3 = self.legacy_aihelper / "data" / "music3"
        self.legacy_thumbs = self.pack / ".cache" / "thumbnails"

        self.new_db_utils = self.root / "db" / "holaf_utilities.sqlite"
        self.new_config = self.root / "config" / "config.ini"
        self.new_known_hosts = self.root / "config" / "sftp_known_hosts"
        self.new_backups = self.root / "backups"

    # -- construction ------------------------------------------------------
    def build(self, rows=50):
        """Crée les anciens emplacements. Retourne la connexion WAL ouverte.

        La connexion retournée DOIT rester ouverte pendant la migration : c'est
        elle qui maintient `-wal` et `-shm` sur disque (wal_autocheckpoint=0),
        donc le scénario réaliste « base avec WAL non rapatrié ».
        """
        for directory in (
            self.legacy_aih / "data",
            self.pack,
            self.custom_nodes,
            self.legacy_music3 / "references",
            self.legacy_thumbs,
        ):
            directory.mkdir(parents=True, exist_ok=True)

        conn = sqlite3.connect(str(self.legacy_db_utils))
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA wal_autocheckpoint=0")
        conn.execute("CREATE TABLE images (id INTEGER PRIMARY KEY, name TEXT)")
        conn.execute("CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT)")
        conn.executemany(
            "INSERT INTO images(name) VALUES (?)", [(f"img-{i}.png",) for i in range(rows)]
        )
        conn.executemany("INSERT INTO tags(label) VALUES (?)", [(f"tag-{i}",) for i in range(3)])
        conn.commit()

        aih_conn = sqlite3.connect(str(self.legacy_aih / "data" / "aihelper.db"))
        aih_conn.execute("CREATE TABLE mirror (id INTEGER PRIMARY KEY, name TEXT)")
        aih_conn.executemany("INSERT INTO mirror(name) VALUES (?)", [("a",), ("b",)])
        aih_conn.commit()
        aih_conn.close()

        (self.legacy_aih / "credentials.json").write_text('{"api_key": "k"}', encoding="utf-8")
        (self.legacy_aih / "openai_keys.json").write_text('{"k": "v"}', encoding="utf-8")
        (self.legacy_aih / "aih_elements_presets.json").write_text("[1]", encoding="utf-8")
        (self.legacy_aih / "blobby.json").write_text('{"blobbyShellAccess": false}', encoding="utf-8")
        self.legacy_config.write_text("[ImageGallery]\ntheme = Dark\n", encoding="utf-8")
        self.legacy_known_hosts.write_text("host ssh-ed25519 AAAA\n", encoding="utf-8")
        self.legacy_backup.write_bytes(b"backup-bytes")
        (self.legacy_music3 / "manifest.json").write_text("{}", encoding="utf-8")
        (self.legacy_music3 / "references" / "a.md").write_text("ref", encoding="utf-8")
        (self.legacy_thumbs / "abc.png").write_bytes(b"png")
        return conn

    def kwargs(self):
        return {
            "force": True,
            "comfy_user_dir": str(self.comfy_user),
            "pack_root": str(self.pack),
            "user_root": str(self.root),
        }


@pytest.fixture(autouse=True)
def never_touch_the_real_pack(monkeypatch, tmp_path):
    """FILET DE SÉCURITÉ : le PACK_ROOT par défaut du module devient JETABLE.

    Si un test oubliait d'injecter `pack_root`, la migration viserait
    `tmp_path/pack-par-defaut` (inexistant) et JAMAIS le vrai dossier du pack.
    Mesure de sûreté, pas de confort : ces tests ne doivent jamais déplacer les
    données d'une installation réelle.
    """
    monkeypatch.setattr(mod, "PACK_ROOT", str(tmp_path / "pack-par-defaut"))
    return tmp_path / "pack-par-defaut"


@pytest.fixture
def tree(tmp_path):
    return _Tree(tmp_path)


@pytest.fixture
def allow_migration(monkeypatch):
    """Autorise la migration sur un arbre JETABLE.

    Lève le verrou AIH_SKIP_USER_MIGRATION posé par tests/conftest.py et
    run_tests.sh : les tests de migration travaillent exclusivement dans
    tmp_path (force=True + chemins injectés), aucune donnée réelle n'est lue
    ni déplacée.
    """
    monkeypatch.delenv(mod.ENV_SKIP_MIGRATION, raising=False)
    monkeypatch.delenv(mod.ENV_USER_ROOT, raising=False)
    monkeypatch.delenv(mod.ENV_SFTP_KNOWN_HOSTS, raising=False)
    return monkeypatch


@pytest.fixture
def fake_folder_paths(monkeypatch, tmp_path):
    """Stub de folder_paths : get_user_directory() + base_path."""
    import types

    user_dir = tmp_path / "stub" / "user"
    base_path = tmp_path / "stub"
    module = types.ModuleType("folder_paths")
    module.get_user_directory = lambda: str(user_dir)
    module.base_path = str(base_path)
    monkeypatch.setitem(sys.modules, "folder_paths", module)
    return module


# ---------------------------------------------------------------------------
# 1. Résolution des chemins
# ---------------------------------------------------------------------------
def test_comfy_user_dir_prefers_get_user_directory(fake_folder_paths):
    assert mod.get_comfy_user_dir() == str(Path(fake_folder_paths.get_user_directory()))


def test_comfy_user_dir_falls_back_on_base_path(monkeypatch, tmp_path):
    """get_user_directory() absente/HS → base_path + '/user'."""
    import types

    module = types.ModuleType("folder_paths")
    module.base_path = str(tmp_path / "comfy")
    monkeypatch.setitem(sys.modules, "folder_paths", module)
    assert mod.get_comfy_user_dir() == str(tmp_path / "comfy" / "user")


def test_comfy_user_dir_last_resort_is_config_dir(monkeypatch):
    """folder_paths introuvable → ~/.config/comfyui (jamais le pack)."""
    monkeypatch.setitem(sys.modules, "folder_paths", None)
    assert mod.get_comfy_user_dir() == os.path.expanduser(os.path.join("~", ".config", "comfyui"))
    assert mod.folder_paths_available() is False


def test_user_root_default_under_comfy_user(fake_folder_paths):
    expected = os.path.join(fake_folder_paths.get_user_directory(), "default", "AI-Helper")
    assert mod.get_user_root() == os.path.abspath(expected)


def test_user_root_env_override_wins(fake_folder_paths, monkeypatch, tmp_path):
    custom = tmp_path / "donnees-perso"
    monkeypatch.setenv(mod.ENV_USER_ROOT, str(custom))
    assert mod.get_user_root() == str(custom)
    # Tous les accesseurs suivent AIH_USER_ROOT.
    assert mod.p_db_utils() == str(custom / "db" / "holaf_utilities.sqlite")
    assert mod.p_db_aih() == str(custom / "db" / "aihelper.db")
    assert mod.p_config() == str(custom / "config" / "config.ini")
    assert mod.p_thumb_cache() == str(custom / "cache" / "thumbnails")


def test_accessors_layout(fake_folder_paths, tmp_path, monkeypatch):
    root = tmp_path / "racine"
    assert mod.p_db_utils(root) == str(root / "db" / "holaf_utilities.sqlite")
    assert mod.p_db_aih(root) == str(root / "db" / "aihelper.db")
    assert mod.p_db_profiler(root) == str(root / "profiler" / "holaf_profiler.db")
    assert mod.p_config(root) == str(root / "config" / "config.ini")
    assert mod.p_credentials(root) == str(root / "config" / "credentials.json")
    assert mod.p_openai_keys(root) == str(root / "config" / "openai_keys.json")
    assert mod.p_blobby(root) == str(root / "config" / "blobby.json")
    assert mod.p_presets(root) == str(root / "presets" / "aih_elements_presets.json")
    assert mod.p_music3_dir(root) == str(root / "data" / "music3")
    assert mod.p_thumb_cache(root) == str(root / "cache" / "thumbnails")
    assert mod.p_backups_dir(root) == str(root / "backups")
    assert mod.p_known_hosts(root) == str(root / "config" / "sftp_known_hosts")
    # Env explicite prioritaire pour les clés d'hôte SFTP (aucune migration).
    monkeypatch.setenv(mod.ENV_SFTP_KNOWN_HOSTS, str(tmp_path / "kh"))
    assert mod.p_known_hosts(root) == str(tmp_path / "kh")


def test_legacy_paths_point_at_historical_locations(tmp_path):
    comfy_user = tmp_path / "user"
    assert mod.legacy_aih_dir(str(comfy_user)) == str(comfy_user / "default" / "aih")
    assert mod.legacy_aihelper_dir(str(comfy_user)) == str(comfy_user / "default" / "aihelper")
    assert mod.legacy_pack_root() == str(mod.PACK_ROOT)
    # Le module testé vit bien à la racine du pack.
    assert Path(mod.__file__).resolve().parent == PACKAGE_DIR


def test_migration_plan_order_and_targets(tmp_path):
    plan = mod.build_migration_plan(
        comfy_user_dir=str(tmp_path / "user"), pack_root=str(tmp_path / "pack"), root=str(tmp_path / "r")
    )
    keys = [item["key"] for item in plan]
    assert keys == [
        "db_aih", "db_profiler", "credentials", "openai_keys", "sftp_known_hosts",
        "db_utils", "db_utils_backups", "config_ini", "presets", "blobby",
        "music3", "thumbnails",
    ]
    assert plan[5]["kind"] == "sqlite"
    assert plan[5]["new"] == str(tmp_path / "r" / "db" / "holaf_utilities.sqlite")


# ---------------------------------------------------------------------------
# 2. Migration réelle d'un faux arbre
# ---------------------------------------------------------------------------
def test_migrates_sqlite_group_with_wal_and_keeps_rows(tree, allow_migration):
    conn = tree.build(rows=50)
    try:
        assert (tree.pack / "holaf_utilities.sqlite-wal").exists()
        assert (tree.pack / "holaf_utilities.sqlite-shm").exists()

        logger = _QuietLogger()
        report = mod.ensure_user_data_layout(logger=logger, **tree.kwargs())
    finally:
        conn.close()

    assert report["status"] == "ok"
    assert report["items"]["db_utils"]["status"] == "migrated"
    assert sorted(report["items"]["db_utils"]["files"]) == [
        "holaf_utilities.sqlite", "holaf_utilities.sqlite-shm", "holaf_utilities.sqlite-wal",
    ]

    # Les TROIS fichiers sont partis (jamais le .db seul).
    assert not tree.legacy_db_utils.exists()
    assert not (tree.pack / "holaf_utilities.sqlite-wal").exists()
    assert not (tree.pack / "holaf_utilities.sqlite-shm").exists()
    assert tree.new_db_utils.exists()

    # Mêmes lignes, intégrité OK.
    snapshot = mod.sqlite_snapshot(str(tree.new_db_utils))
    assert snapshot["integrity"] == "ok"
    assert snapshot["rows"] == {"images": 50, "tags": 3}
    assert snapshot["tables"] == 2

    # Autres items attendus.
    assert report["items"]["db_aih"]["status"] == "migrated"
    assert tree.legacy_aih.joinpath("data", "aihelper.db").exists() is False
    aih_snapshot = mod.sqlite_snapshot(str(tree.root / "db" / "aihelper.db"))
    assert aih_snapshot["integrity"] == "ok"
    assert aih_snapshot["rows"] == {"mirror": 2}
    assert report["items"]["credentials"]["status"] == "migrated"
    assert (tree.root / "config" / "credentials.json").read_text(encoding="utf-8") == '{"api_key": "k"}'
    assert report["items"]["sftp_known_hosts"]["status"] == "migrated"
    assert tree.new_known_hosts.read_text(encoding="utf-8").startswith("host ssh-ed25519")
    assert report["items"]["config_ini"]["status"] == "migrated"
    assert tree.new_config.read_text(encoding="utf-8").startswith("[ImageGallery]")
    assert report["items"]["presets"]["status"] == "migrated"
    assert report["items"]["blobby"]["status"] == "migrated"
    assert report["items"]["db_utils_backups"]["status"] == "migrated"
    assert (tree.new_backups / tree.legacy_backup.name).exists()
    assert report["items"]["music3"]["status"] == "migrated"
    assert (tree.root / "data" / "music3" / "references" / "a.md").exists()
    assert report["items"]["thumbnails"]["status"] == "migrated"
    assert (tree.root / "cache" / "thumbnails" / "abc.png").exists()
    assert report["items"]["db_profiler"]["status"] == "noop"
    assert (tree.root / "profiler").is_dir()
    assert logger.errors() == []

    # Journal d'audit + marqueur de rollback.
    journal = json.loads((tree.root / ".migration.json").read_text(encoding="utf-8"))
    assert journal["items"]["db_utils"]["status"] == "migrated"
    assert journal["root"] == str(tree.root)
    marker = tree.pack / mod.MARKER_FILENAME
    assert marker.exists()
    assert str(tree.root) in marker.read_text(encoding="utf-8")
    assert (tree.legacy_aih / mod.MARKER_FILENAME).exists()


def test_pack_folder_is_lightened_after_migration(tree, allow_migration):
    """Mesure DIRECTE du besoin utilisateur : alléger custom_nodes/<pack>."""
    conn = tree.build()
    try:
        mod.ensure_user_data_layout(logger=_QuietLogger(), **tree.kwargs())
    finally:
        conn.close()

    leftovers = sorted(p.name for p in tree.pack.iterdir())
    assert "holaf_utilities.sqlite" not in leftovers
    assert "holaf_utilities.sqlite-wal" not in leftovers
    assert "holaf_utilities.sqlite-shm" not in leftovers
    assert not [name for name in leftovers if name.startswith("holaf_utilities.sqlite.backup_")]
    assert "config.ini" not in leftovers
    assert ".cache" not in leftovers
    assert not tree.legacy_known_hosts.exists()
    # Le marqueur de rollback est le SEUL fichier ajouté au pack.
    assert mod.MARKER_FILENAME in leftovers


def test_migration_is_idempotent(tree, allow_migration):
    conn = tree.build()
    try:
        first = mod.ensure_user_data_layout(logger=_QuietLogger(), **tree.kwargs())
    finally:
        conn.close()
    assert first["items"]["db_utils"]["status"] == "migrated"

    stamp = tree.new_db_utils.stat().st_mtime_ns
    second = mod.ensure_user_data_layout(logger=_QuietLogger(), **tree.kwargs())

    assert second["status"] == "ok"
    assert second["items"]["db_utils"]["status"] == "existing"
    assert second["items"]["config_ini"]["status"] == "existing"
    assert second["items"]["music3"]["status"] == "existing"
    assert tree.new_db_utils.stat().st_mtime_ns == stamp
    assert not tree.legacy_db_utils.exists()
    assert mod.sqlite_snapshot(str(tree.new_db_utils))["rows"]["images"] == 50


def test_ensure_once_is_process_idempotent(tree, allow_migration):
    mod.reset_ensure_once()
    conn = tree.build()
    try:
        first = mod.ensure_once(logger=_QuietLogger(), **tree.kwargs())
        second = mod.ensure_once(logger=_QuietLogger(), **tree.kwargs())
    finally:
        conn.close()
        mod.reset_ensure_once()
    assert first is second


def test_layout_is_created_when_nothing_exists(tree, allow_migration):
    """Les deux absents → l'ARBORESCENCE est créée, aucun fichier de données vide."""
    report = mod.ensure_user_data_layout(logger=_QuietLogger(), **tree.kwargs())

    assert report["status"] == "ok"
    for directory in mod.layout_dirs(str(tree.root)):
        assert os.path.isdir(directory), directory
    assert report["items"]["db_utils"]["status"] == "absent"
    assert report["items"]["config_ini"]["status"] == "absent"
    assert report["items"]["credentials"]["status"] == "absent"
    # On ne fabrique JAMAIS une base ou un credentials.json vide : ce serait
    # pire que l'absence (état trompeur). Les consommateurs créent à l'écriture.
    assert not tree.new_db_utils.exists()
    assert not (tree.root / "config" / "credentials.json").exists()
    assert mod.p_journal(str(tree.root)) and os.path.isfile(mod.p_journal(str(tree.root)))


# ---------------------------------------------------------------------------
# 4. Conflit : jamais d'écrasement
# ---------------------------------------------------------------------------
def test_conflict_keeps_legacy_and_new_intact(tree, allow_migration):
    conn = tree.build()
    try:
        # Les DEUX emplacements existent déjà : la cible fait autorité.
        tree.new_config.parent.mkdir(parents=True, exist_ok=True)
        tree.new_config.write_text("[NEW]\ntheme = Light\n", encoding="utf-8")
        (tree.root / "db").mkdir(parents=True, exist_ok=True)
        tree.new_db_utils.write_bytes(b"NEW-DB")
        logger = _QuietLogger()
        report = mod.ensure_user_data_layout(logger=logger, **tree.kwargs())
        # Relevé AVANT fermeture de la connexion WAL (la fermeture rejoue un
        # checkpoint et supprime les sidecars : ce n'est pas la migration).
        pack_listing = sorted(path.name for path in tree.pack.iterdir())
    finally:
        conn.close()

    assert report["items"]["config_ini"]["status"] == "conflict"
    assert tree.new_config.read_text(encoding="utf-8") == "[NEW]\ntheme = Light\n"
    assert tree.legacy_config.read_text(encoding="utf-8").startswith("[ImageGallery]")

    assert report["items"]["db_utils"]["status"] == "conflict"
    assert tree.new_db_utils.read_bytes() == b"NEW-DB"
    assert tree.legacy_db_utils.exists()
    assert "holaf_utilities.sqlite-wal" in pack_listing

    assert [entry["key"] for entry in report["conflicts"]].count("config_ini") == 1
    assert any("CONFLIT" in message for message in logger.warnings())
    journal = json.loads((tree.root / ".migration.json").read_text(encoding="utf-8"))
    assert any(entry["key"] == "db_utils" for entry in journal["conflicts"])
    marker = (tree.pack / mod.MARKER_FILENAME).read_text(encoding="utf-8")
    assert "CONFLIT" in marker


# ---------------------------------------------------------------------------
# 5. Échec par item : rien n'est bloqué, l'item garde son ancien chemin
# ---------------------------------------------------------------------------
def test_failed_item_does_not_block_following_items(tree, allow_migration, monkeypatch):
    conn = tree.build()
    real_transfer = mod.transfer_file

    def flaky_transfer(src, dst):
        if os.path.basename(dst) == "config.ini":
            raise PermissionError("permission refusée (simulée)")
        return real_transfer(src, dst)

    monkeypatch.setattr(mod, "transfer_file", flaky_transfer)
    logger = _QuietLogger()
    try:
        report = mod.ensure_user_data_layout(logger=logger, **tree.kwargs())
    finally:
        conn.close()

    assert report["status"] == "partial"
    assert report["items"]["config_ini"]["status"] == "failed"
    assert "PermissionError" in report["items"]["config_ini"]["error"]
    # L'item garde son ANCIEN chemin (retenté au démarrage suivant).
    assert tree.legacy_config.exists()
    assert not tree.new_config.exists()
    # Les items SUIVANTS ne sont pas bloqués.
    assert report["items"]["presets"]["status"] == "migrated"
    assert report["items"]["blobby"]["status"] == "migrated"
    assert report["items"]["music3"]["status"] == "migrated"
    assert report["items"]["thumbnails"]["status"] == "migrated"
    assert logger.errors()

    # 2e démarrage sans la panne : l'item est retenté et réussit.
    monkeypatch.setattr(mod, "transfer_file", real_transfer)
    retry = mod.ensure_user_data_layout(logger=_QuietLogger(), **tree.kwargs())
    assert retry["status"] == "ok"
    assert retry["items"]["config_ini"]["status"] == "migrated"
    assert tree.new_config.exists()


# ---------------------------------------------------------------------------
# 6. Vérification post-déplacement : écart ⇒ déplacement inverse
# ---------------------------------------------------------------------------
def test_verification_mismatch_rolls_back(tree, allow_migration, monkeypatch):
    conn = tree.build(rows=50)
    original = mod.sqlite_snapshot

    def corrupted_after_move(path, with_integrity=True):
        snapshot = original(path, with_integrity=with_integrity)
        if os.path.abspath(path) == str(tree.new_db_utils):
            # Simule une perte de lignes après déplacement.
            snapshot = dict(
                snapshot,
                rows={key: value + 1 for key, value in snapshot["rows"].items()},
                total=snapshot["total"] + 3,
            )
        return snapshot

    monkeypatch.setattr(mod, "sqlite_snapshot", corrupted_after_move)
    logger = _QuietLogger()
    try:
        report = mod.ensure_user_data_layout(logger=logger, **tree.kwargs())
    finally:
        conn.close()

    assert report["status"] == "partial"
    assert report["items"]["db_utils"]["status"] == "failed"
    assert "vérification" in report["items"]["db_utils"]["error"]
    # Déplacement INVERSE : la base est revenue à son ancien emplacement…
    assert tree.legacy_db_utils.exists()
    assert not tree.new_db_utils.exists()
    # … intacte (50 images + 3 tags).
    snapshot = mod.sqlite_snapshot(str(tree.legacy_db_utils))
    assert snapshot["integrity"] == "ok"
    assert snapshot["rows"]["images"] == 50
    assert snapshot["rows"]["tags"] == 3
    assert any("échec" in message for message in logger.errors())


# ---------------------------------------------------------------------------
# 7. Garde anti-test / hors ComfyUI
# ---------------------------------------------------------------------------
def test_guard_blocks_migration_when_env_is_set(tree, monkeypatch):
    """AIH_SKIP_USER_MIGRATION=1 (posé par run_tests.sh/conftest) : rien ne bouge."""
    monkeypatch.setenv(mod.ENV_SKIP_MIGRATION, "1")
    conn = tree.build()
    try:
        report = mod.ensure_user_data_layout(logger=_QuietLogger(), **tree.kwargs())
    finally:
        conn.close()

    assert report["status"] == "skipped"
    assert "AIH_SKIP_USER_MIGRATION" in report["blocked_reason"]
    assert tree.legacy_db_utils.exists()
    assert not tree.root.exists()
    assert not tree.new_config.exists()


def test_guard_blocks_migration_under_pytest_by_default(tree, allow_migration):
    """Sous pytest, sans force=True : la garde PYTEST_CURRENT_TEST suffit."""
    assert os.environ.get("PYTEST_CURRENT_TEST"), "pytest doit exposer cette variable"
    conn = tree.build()
    try:
        kwargs = dict(tree.kwargs())
        kwargs.pop("force")
        report = mod.ensure_user_data_layout(logger=_QuietLogger(), **kwargs)
    finally:
        conn.close()

    assert report["status"] == "skipped"
    assert "pytest" in report["blocked_reason"]
    assert tree.legacy_db_utils.exists()
    assert not tree.root.exists()


def test_guard_blocks_outside_comfyui(allow_migration, monkeypatch, tmp_path):
    """folder_paths absent et aucune racine explicite : on n'écrit rien.

    `force=True` ne dispense PAS de la règle « hors ComfyUI » : sans racine
    explicite, aucune donnée n'est créée ni déplacée (ici pack_root est injecté
    pour que le test ne puisse par construction pas viser le vrai pack).
    """
    monkeypatch.setitem(sys.modules, "folder_paths", None)
    report = mod.ensure_user_data_layout(
        logger=_QuietLogger(), force=True, pack_root=str(tmp_path / "pack")
    )
    assert report["status"] == "skipped"
    assert "folder_paths absent" in report["blocked_reason"]
    assert not (tmp_path / "pack").exists()


# ---------------------------------------------------------------------------
# 8. Verrou inter-processus
# ---------------------------------------------------------------------------
def test_fresh_lock_prevents_concurrent_migration(tree, allow_migration):
    conn = tree.build()
    try:
        # Une AUTRE instance ComfyUI migre en ce moment (verrou frais).
        (tree.root).mkdir(parents=True, exist_ok=True)
        (tree.root / mod.LOCK_FILENAME).write_text("pid=999999\n", encoding="utf-8")
        report = mod.ensure_user_data_layout(logger=_QuietLogger(), **tree.kwargs())
    finally:
        conn.close()

    assert report["status"] == "locked"
    assert tree.legacy_db_utils.exists()
    assert (tree.root / mod.LOCK_FILENAME).exists()


def test_stale_lock_is_broken_and_migration_runs(tree, allow_migration):
    conn = tree.build()
    try:
        (tree.root).mkdir(parents=True, exist_ok=True)
        lock = tree.root / mod.LOCK_FILENAME
        lock.write_text("pid=999999\n", encoding="utf-8")
        old = time.time() - (mod.LOCK_STALE_SECONDS + 60)
        os.utime(lock, (old, old))
        logger = _QuietLogger()
        report = mod.ensure_user_data_layout(logger=logger, **tree.kwargs())
    finally:
        conn.close()

    assert report["status"] == "ok"
    assert report["items"]["db_utils"]["status"] == "migrated"
    assert any("périmé" in message for message in logger.warnings())
    assert not (tree.root / mod.LOCK_FILENAME).exists()


# ---------------------------------------------------------------------------
# 9. Journal d'audit : jamais un drapeau bloquant
# ---------------------------------------------------------------------------
def test_corrupted_journal_never_blocks_migration(tree, allow_migration):
    conn = tree.build()
    try:
        tree.root.mkdir(parents=True, exist_ok=True)
        (tree.root / ".migration.json").write_text("{ceci n'est pas du json", encoding="utf-8")
        report = mod.ensure_user_data_layout(logger=_QuietLogger(), **tree.kwargs())
    finally:
        conn.close()

    assert report["items"]["db_utils"]["status"] == "migrated"
    journal = json.loads((tree.root / ".migration.json").read_text(encoding="utf-8"))
    assert journal["items"]["db_utils"]["status"] == "migrated"


# ---------------------------------------------------------------------------
# 10. Env explicite : gagne, aucune migration
# ---------------------------------------------------------------------------
def test_env_known_hosts_wins_over_migration(tree, allow_migration, monkeypatch):
    explicit = tree.base / "kh-explicite"
    explicit.write_text("host ssh-ed25519 BBBB\n", encoding="utf-8")
    monkeypatch.setenv(mod.ENV_SFTP_KNOWN_HOSTS, str(explicit))
    conn = tree.build()
    try:
        report = mod.ensure_user_data_layout(logger=_QuietLogger(), **tree.kwargs())
    finally:
        conn.close()

    assert report["items"]["sftp_known_hosts"]["status"] == "skipped"
    assert tree.legacy_known_hosts.exists()
    assert not tree.new_known_hosts.exists()


def test_temp_dirs_are_never_migrated(tree, allow_migration):
    """temp_uploads/ et temp_exports/ restent DEHORS (purgés au démarrage)."""
    conn = tree.build()
    (tree.pack / "temp_uploads").mkdir(parents=True, exist_ok=True)
    (tree.pack / "temp_uploads" / "chunk.bin").write_bytes(b"x")
    (tree.pack / "temp_exports").mkdir(parents=True, exist_ok=True)
    try:
        report = mod.ensure_user_data_layout(logger=_QuietLogger(), **tree.kwargs())
    finally:
        conn.close()

    assert (tree.pack / "temp_uploads" / "chunk.bin").exists()
    assert (tree.pack / "temp_exports").exists()
    assert not (tree.root / "temp_uploads").exists()
    assert "temp_uploads" not in report["items"]
