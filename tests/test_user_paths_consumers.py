# ─────────────────────────────────────────────────────────────────────────
# PHASE 2 + PHASE 3 du chantier « données utilisateur » : branchement de TOUS
# les consommateurs sur holaf_user_paths, puis preuve qu'APRÈS migration ils
# lisent bien les NOUVELLES données (c'est le test qui prouve qu'on ne perd
# rien).
#
# Contexte : la migration déplace holaf_utilities.sqlite (1,8 Go sur
# l'installation déployée), config.ini, credentials.json, openai_keys.json,
# presets, blobby.json, music3 et les miniatures de
# custom_nodes/ComfyUI-AI-Helper vers <ComfyUI>/user/default/AI-Helper/.
# Un consommateur resté sur l'ancien chemin = base neuve et vide à la place des
# données de l'utilisateur → perte silencieuse.
#
# Couverture :
#   1. AVANT migration (rien n'a bougé) : chaque consommateur retrouve
#      EXACTEMENT l'ancien chemin → aucun changement de comportement ;
#   2. APRÈS migration (phase 3) : chaque consommateur lit le NOUVEAU chemin et
#      les données sont intactes (50 images / 3 tags, config.ini, aihelper.db,
#      presets, credentials, clés OpenAI, blobby, music3, miniatures) ;
#   3. config.ini est bien SUIVI (mutant « config non suivie » : rouge) ;
#   4. chaque fichier consommateur référence holaf_user_paths (mutant
#      « consommateur resté sur l'ancien chemin » : rouge) ;
#   5. le dossier du pack est réellement allégé après migration.
#
# Les arbres sont JETABLES (tmp_path) et PACK_ROOT est TOUJOURS redirigé
# (fixture autouse) : aucun fichier réel du pack n'est lu ni déplacé.
#
# Usage :
#   PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
#   pytest tests/test_user_paths_consumers.py
# ─────────────────────────────────────────────────────────────────────────
import importlib.util
import json
import sqlite3
import sys
import types
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

import holaf_user_paths as paths  # noqa: E402  (après le bootstrap sys.path)

# Consommateurs branchés en phase 2 (fichier:ligne documentés dans
# holaf_user_paths.py, section « PHASE 2 — consommateurs branchés »).
CONSUMER_FILES = (
    "holaf_database.py",
    "holaf_user_data_manager.py",
    "holaf_profiler_database.py",
    "holaf_config.py",
    "holaf_utils.py",
    "nodes/holaf_model_manager.py",
    "nodes/openai_settings_node.py",
    "aih/store.py",
    "aih/routes.py",
    "aih/credentials.py",
    "aih/local_source.py",
    "aih/sync_engine.py",
    "aih/model_manager.py",
    # ComfyCH (intégré sous tools/comfych/) : sa config et ses logs d'opération
    # vivaient dans le dossier de son code, donc dans le pack.
    "tools/comfych/comfych_store.py",
)

IMAGES = 50
TAGS = 3


class _QuietLogger:
    def info(self, message):  # pragma: no cover - silence volontaire
        pass

    def warning(self, message):  # pragma: no cover
        pass

    def error(self, message):  # pragma: no cover
        pass


class _Tree:
    """Faux arbre ComfyUI complet : TOUTES les données à l'ancien emplacement."""

    def __init__(self, base: Path):
        self.base = base
        self.comfy_user = base / "ComfyUI" / "user"
        self.custom_nodes = base / "ComfyUI" / "custom_nodes"
        self.pack = self.custom_nodes / "ComfyUI-AI-Helper"
        self.root = self.comfy_user / "default" / "AI-Helper"
        self.legacy_aih = self.comfy_user / "default" / "aih"
        self.legacy_aihelper = self.comfy_user / "default" / "aihelper"

        # -- anciens emplacements
        self.legacy_db_utils = self.pack / "holaf_utilities.sqlite"
        self.legacy_config = self.pack / "config.ini"
        self.legacy_thumbs = self.pack / ".cache" / "thumbnails"
        self.legacy_known_hosts = self.custom_nodes / ".sftp_known_hosts"
        self.legacy_db_aih = self.legacy_aih / "data" / "aihelper.db"
        self.legacy_credentials = self.legacy_aih / "credentials.json"
        self.legacy_openai_keys = self.legacy_aih / "openai_keys.json"
        self.legacy_presets = self.legacy_aih / "aih_elements_presets.json"
        self.legacy_blobby = self.legacy_aih / "blobby.json"
        self.legacy_music3 = self.legacy_aihelper / "data" / "music3"

        # -- nouvelles cibles
        self.new_db_utils = self.root / "db" / "holaf_utilities.sqlite"
        self.new_db_aih = self.root / "db" / "aihelper.db"
        self.new_config = self.root / "config" / "config.ini"
        self.new_credentials = self.root / "config" / "credentials.json"
        self.new_openai_keys = self.root / "config" / "openai_keys.json"
        self.new_blobby = self.root / "config" / "blobby.json"
        self.new_known_hosts = self.root / "config" / "sftp_known_hosts"
        self.new_presets = self.root / "presets" / "aih_elements_presets.json"
        self.new_music3 = self.root / "data" / "music3"
        self.new_thumbs = self.root / "cache" / "thumbnails"

    # -- construction ------------------------------------------------------
    def build(self, *, db_utils=True, db_aih=True, config=True, secrets=True):
        for directory in (
            self.pack / ".cache" / "thumbnails",
            self.legacy_aih / "data",
            self.legacy_aihelper / "data" / "music3" / "references",
            self.custom_nodes,
        ):
            directory.mkdir(parents=True, exist_ok=True)

        if db_utils:
            conn = sqlite3.connect(str(self.legacy_db_utils))
            conn.execute("CREATE TABLE images (id INTEGER PRIMARY KEY, name TEXT)")
            conn.execute("CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT)")
            conn.executemany(
                "INSERT INTO images(name) VALUES (?)", [(f"img-{i}.png",) for i in range(IMAGES)]
            )
            conn.executemany("INSERT INTO tags(label) VALUES (?)", [(f"tag-{i}",) for i in range(TAGS)])
            conn.commit()
            conn.close()

        if db_aih:
            conn = sqlite3.connect(str(self.legacy_db_aih))
            conn.execute("CREATE TABLE keywords (client_id TEXT PRIMARY KEY, keyword TEXT)")
            conn.execute("INSERT INTO keywords VALUES ('c1', 'chat')")
            conn.commit()
            conn.close()

        if config:
            self.legacy_config.write_text(
                "[ImageGallery]\ntheme = Solarized\n[ModelManagerUI]\ntheme = Dark\n",
                encoding="utf-8",
            )

        if secrets:
            self.legacy_credentials.write_text(
                json.dumps({"api_key": "clef-utilisateur", "server_url": "https://aih"}), encoding="utf-8"
            )
            self.legacy_openai_keys.write_text(
                json.dumps({"http://localhost:11434/v1": "clef-ollama"}), encoding="utf-8"
            )
            self.legacy_presets.write_text(json.dumps({"presets": [{"name": "P1"}]}), encoding="utf-8")
            self.legacy_blobby.write_text(json.dumps({"blobbyShellAccess": False}), encoding="utf-8")
            self.legacy_known_hosts.write_text("host ssh-ed25519 AAAA\n", encoding="utf-8")
            (self.legacy_music3 / "manifest.json").write_text('{"files": []}', encoding="utf-8")
            (self.legacy_music3 / "references" / "a.md").write_text("ref", encoding="utf-8")
            (self.legacy_thumbs / "abc.png").write_bytes(b"png")
        return self

    def kwargs(self):
        return {
            "force": True,
            "comfy_user_dir": str(self.comfy_user),
            "pack_root": str(self.pack),
            "user_root": str(self.root),
        }

    def migrate(self):
        report = paths.ensure_user_data_layout(logger=_QuietLogger(), **self.kwargs())
        assert report["status"] == "ok", report
        return report


@pytest.fixture(autouse=True)
def never_touch_the_real_pack(monkeypatch, tmp_path):
    """FILET DE SÉCURITÉ : PACK_ROOT du helper devient JETABLE.

    Les consommateurs importent CE module : tout chemin legacy qu'ils résolvent
    pointe donc vers un dossier temporaire, jamais vers le vrai pack.
    """
    monkeypatch.setattr(paths, "PACK_ROOT", str(tmp_path / "pack-par-defaut"))
    return tmp_path / "pack-par-defaut"


@pytest.fixture
def clean_env(monkeypatch):
    monkeypatch.delenv(paths.ENV_SKIP_MIGRATION, raising=False)
    monkeypatch.delenv(paths.ENV_USER_ROOT, raising=False)
    monkeypatch.delenv(paths.ENV_SFTP_KNOWN_HOSTS, raising=False)
    monkeypatch.delenv(paths.ENV_MIGRATION_ENABLED, raising=False)
    return monkeypatch


@pytest.fixture
def tree(tmp_path):
    return _Tree(tmp_path)


@pytest.fixture
def comfy(tree, clean_env, monkeypatch):
    """Simule le runtime ComfyUI : folder_paths + PACK_ROOT = faux pack."""
    monkeypatch.setattr(paths, "PACK_ROOT", str(tree.pack))
    fake = types.ModuleType("folder_paths")
    fake.get_user_directory = lambda: str(tree.comfy_user)
    fake.base_path = str(tree.base / "ComfyUI")
    fake.get_temp_directory = lambda: str(tree.base / "ComfyUI" / "temp")
    monkeypatch.setitem(sys.modules, "folder_paths", fake)
    return fake


def _load(monkeypatch, name, relative):
    """Charge un module du pack par chemin (comme le fait ComfyUI)."""
    spec = importlib.util.spec_from_file_location(name, PACKAGE_DIR / relative)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, name, module)
    spec.loader.exec_module(module)
    return module


def _rows(path):
    conn = sqlite3.connect(str(path))
    try:
        return {
            name: conn.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0]
            for name in ("images", "tags")
            if conn.execute(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?", (name,)
            ).fetchone()[0]
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 1. AVANT migration : aucun changement de comportement
# ---------------------------------------------------------------------------
def test_before_migration_consumers_keep_their_historical_paths(tree, comfy, monkeypatch):
    tree.build()
    monkeypatch.setenv(paths.ENV_SKIP_MIGRATION, "1")  # rien n'a été migré

    database = _load(monkeypatch, "consumers_holaf_database_before", "holaf_database.py")
    config = _load(monkeypatch, "consumers_holaf_config_before", "holaf_config.py")
    store = _load(monkeypatch, "consumers_aih_store_before", "aih/store.py")
    udm = _load(monkeypatch, "consumers_udm_before", "holaf_user_data_manager.py")
    profiler = _load(monkeypatch, "consumers_profiler_before", "holaf_profiler_database.py")

    assert Path(database.DB_PATH) == tree.legacy_db_utils
    assert Path(database.DB_DIR) == tree.pack
    assert Path(config.get_config_path()) == tree.legacy_config
    assert Path(store.get_store_path()) == tree.legacy_db_aih
    assert Path(store._get_aih_user_dir()) == tree.legacy_aih
    assert Path(udm.UserDataManager.get_root_path()) == \
        tree.comfy_user / "default" / "AI-Helper"
    assert Path(profiler._profiler_db_path()) == \
        tree.comfy_user / "default" / "AI-Helper" / "profiler" / "holaf_profiler.db"

    # Accesseurs partagés : tous les anciens emplacements sont retrouvés.
    assert Path(paths.resolved_db_utils()) == tree.legacy_db_utils
    assert Path(paths.resolved_config()) == tree.legacy_config
    assert Path(paths.resolved_db_aih()) == tree.legacy_db_aih
    assert Path(paths.resolved_credentials()) == tree.legacy_credentials
    assert Path(paths.resolved_openai_keys()) == tree.legacy_openai_keys
    assert Path(paths.resolved_presets()) == tree.legacy_presets
    assert Path(paths.resolved_blobby()) == tree.legacy_blobby
    assert Path(paths.resolved_known_hosts()) == tree.legacy_known_hosts
    assert Path(paths.resolved_music3_dir()) == tree.legacy_music3
    assert Path(paths.resolved_thumb_cache()) == tree.legacy_thumbs
    # Sauvegardes de schéma : à côté de la base réellement utilisée.
    assert Path(paths.resolved_backups_dir()) == tree.pack


def test_openai_node_reads_the_legacy_key_file_before_migration(tree, comfy, monkeypatch):
    tree.build()
    monkeypatch.setenv(paths.ENV_SKIP_MIGRATION, "1")
    node_module = _load(monkeypatch, "consumers_openai_node_before", "nodes/openai_settings_node.py")
    node = node_module.AIHOpenAISettingsNode()
    (config_json,) = node.generate_config(
        "http://localhost:11434/v1", "", "llama3", 0, 0.7, 0
    )
    assert json.loads(config_json)["api_key"] == "clef-ollama"


# ---------------------------------------------------------------------------
# 2. APRÈS migration (phase 3) : les consommateurs lisent les NOUVELLES données
# ---------------------------------------------------------------------------
def test_empty_new_database_never_masks_the_real_data(tree, comfy, monkeypatch):
    """Une base de 0 octet à la cible ne doit pas faire autorité sur les données.

    Scénario réel : une ouverture malencontreuse crée un fichier vide au nouveau
    chemin alors que les 1,8 Go sont encore à l'ancien. Sans cette règle, le
    consommateur ouvrirait la base VIDE (données utilisateur invisibles).
    """
    tree.build()
    monkeypatch.setenv(paths.ENV_SKIP_MIGRATION, "1")
    tree.new_db_utils.parent.mkdir(parents=True, exist_ok=True)
    tree.new_db_utils.write_bytes(b"")

    assert Path(paths.resolved_db_utils()) == tree.legacy_db_utils
    database = _load(monkeypatch, "consumers_holaf_database_empty", "holaf_database.py")
    assert Path(database.DB_PATH) == tree.legacy_db_utils


def test_after_migration_database_consumer_reads_migrated_data(tree, comfy, monkeypatch):
    tree.build()
    tree.migrate()

    database = _load(monkeypatch, "consumers_holaf_database_after", "holaf_database.py")

    assert Path(database.DB_PATH) == tree.new_db_utils, \
        "holaf_database lirait l'ancien emplacement (vide) : données perdues"
    assert Path(database.DB_DIR) == tree.new_db_utils.parent
    # Les 50 images et 3 tags sont TOUJOURS là, dans la nouvelle base.
    assert paths.sqlite_snapshot(str(tree.new_db_utils))["rows"] == {"images": IMAGES, "tags": TAGS}
    assert _rows(tree.new_db_utils) == {"images": IMAGES, "tags": TAGS}
    assert not tree.legacy_db_utils.exists()
    # Le consommateur ouvre RÉELLEMENT la nouvelle base (et la voit peuplée).
    conn = database._create_connection()
    try:
        assert conn.execute("SELECT count(*) FROM images").fetchone()[0] == IMAGES
    finally:
        conn.close()


def test_after_migration_config_consumer_follows_the_file(tree, comfy, monkeypatch):
    """Mutant « config.ini non suivi » : ce test doit devenir ROUGE."""
    tree.build()
    tree.migrate()

    config = _load(monkeypatch, "consumers_holaf_config_after", "holaf_config.py")

    assert Path(config.get_config_path()) == tree.new_config, \
        "config.ini n'est pas suivi : les préférences de l'utilisateur seraient ignorées"
    parser = config.get_config_parser()
    assert parser.get("ImageGallery", "theme") == "Solarized"
    assert parser.get("ModelManagerUI", "theme") == "Dark"
    assert not tree.legacy_config.exists()


def test_after_migration_store_consumer_reads_the_migrated_aih_db(tree, comfy, monkeypatch):
    tree.build()
    tree.migrate()

    store = _load(monkeypatch, "consumers_aih_store_after", "aih/store.py")

    assert Path(store.get_store_path()) == tree.new_db_aih
    conn = store.get_conn()
    try:
        assert conn.execute("SELECT keyword FROM keywords").fetchone()[0] == "chat"
    finally:
        conn.close()


def test_after_migration_shared_accessors_point_at_the_new_tree(tree, comfy):
    tree.build()
    tree.migrate()

    assert Path(paths.resolved_db_utils()) == tree.new_db_utils
    assert Path(paths.resolved_config()) == tree.new_config
    assert Path(paths.resolved_db_aih()) == tree.new_db_aih
    assert Path(paths.resolved_credentials()) == tree.new_credentials
    assert Path(paths.resolved_openai_keys()) == tree.new_openai_keys
    assert Path(paths.resolved_presets()) == tree.new_presets
    assert Path(paths.resolved_blobby()) == tree.new_blobby
    assert Path(paths.resolved_known_hosts()) == tree.new_known_hosts
    assert Path(paths.resolved_music3_dir()) == tree.new_music3
    assert Path(paths.resolved_thumb_cache()) == tree.new_thumbs
    assert Path(paths.resolved_backups_dir()) == tree.root / "backups"
    # Contenus préservés (aucune donnée perdue).
    assert json.loads(tree.new_openai_keys.read_text(encoding="utf-8"))["http://localhost:11434/v1"] \
        == "clef-ollama"
    assert (tree.new_music3 / "references" / "a.md").read_text(encoding="utf-8") == "ref"
    assert (tree.new_thumbs / "abc.png").read_bytes() == b"png"


def test_after_migration_openai_node_reads_the_new_key_file(tree, comfy, monkeypatch):
    tree.build()
    tree.migrate()
    node_module = _load(monkeypatch, "consumers_openai_node_after", "nodes/openai_settings_node.py")
    node = node_module.AIHOpenAISettingsNode()
    (config_json,) = node.generate_config("http://localhost:11434/v1", "", "llama3", 0, 0.7, 0)
    assert json.loads(config_json)["api_key"] == "clef-ollama"
    assert not tree.legacy_openai_keys.exists()


def test_after_migration_credentials_and_blobby_and_presets_consumers(tree, comfy, monkeypatch):
    tree.build()
    tree.migrate()

    credentials = _load(monkeypatch, "consumers_aih_credentials_after", "aih/credentials.py")
    assert Path(credentials.get_credentials_path()) == tree.new_credentials
    loaded = credentials._load_aih_credentials(use_cache=False)
    assert loaded.get("api_key") == "clef-utilisateur"

    routes = _load(monkeypatch, "consumers_aih_routes_after", "aih/routes.py")
    assert Path(routes._get_presets_path()) == tree.new_presets
    assert Path(routes._get_blobby_file()) == tree.new_blobby
    # ⚠️ Le dossier workflows du core ComfyUI n'est PAS concerné par la migration.
    assert Path(routes._get_workflows_dir()) == tree.comfy_user / "default" / "workflows"


def test_after_migration_nodes_model_manager_uses_the_same_database(tree, comfy, monkeypatch):
    """Plus de double source de vérité : le nodes manager lit la MÊME base."""
    tree.build()
    tree.migrate()

    model_manager_node = _load(
        monkeypatch, "consumers_model_manager_node_after", "nodes/holaf_model_manager.py"
    )
    database = _load(monkeypatch, "consumers_holaf_database_after2", "holaf_database.py")

    assert Path(model_manager_node.HOLAF_MODELS_DB_PATH) == tree.new_db_utils
    assert Path(model_manager_node.HOLAF_MODELS_DB_PATH) == Path(database.DB_PATH)


def test_after_migration_music3_and_known_hosts_follow(tree, comfy, monkeypatch):
    tree.build()
    tree.migrate()

    sync_engine = _load(monkeypatch, "consumers_sync_engine_after", "aih/sync_engine.py")
    local_source = _load(monkeypatch, "consumers_local_source_after", "aih/local_source.py")
    model_manager = _load(monkeypatch, "consumers_model_manager_after", "aih/model_manager.py")

    assert Path(local_source._local_music3_refs_dir()) == tree.new_music3 / "references"
    # sync_engine écrit le miroir music3 dans le MÊME dossier que local_source :
    # on vérifie la constante de résolution utilisée par sync_music3_local().
    source = (PACKAGE_DIR / "aih" / "sync_engine.py").read_text(encoding="utf-8")
    assert "resolved_music3_dir()" in source
    assert sync_engine is not None
    assert Path(model_manager._user_paths.resolved_known_hosts()) == tree.new_known_hosts


def test_pack_folder_is_lightened_after_migration(tree, comfy):
    """Le besoin utilisateur lui-même : alléger custom_nodes/ComfyUI-AI-Helper."""
    tree.build()
    tree.migrate()

    leftovers = sorted(path.name for path in tree.pack.iterdir())
    assert "holaf_utilities.sqlite" not in leftovers
    assert "config.ini" not in leftovers
    assert ".cache" not in leftovers
    assert paths.MARKER_FILENAME in leftovers  # seul ajout : le mode d'emploi du rollback


# ---------------------------------------------------------------------------
# 3. Anti-régression : aucun consommateur ne recalcule son chemin tout seul
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("relative", CONSUMER_FILES)
def test_consumer_file_uses_the_single_source_of_truth(relative):
    """Mutant « consommateur resté sur l'ancien chemin » : rouge si l'import part."""
    source = (PACKAGE_DIR / relative).read_text(encoding="utf-8")
    assert "holaf_user_paths" in source, (
        f"{relative} ne passe pas par holaf_user_paths : après migration il lirait "
        "l'ancien emplacement (données perdues)"
    )


def test_temporary_dirs_use_the_comfy_temp_directory(tree, comfy, monkeypatch):
    """Les temp du pack ne restent pas dans custom_nodes (sous-dossier dédié)."""
    tree.build()
    monkeypatch.setattr(paths, "PACK_ROOT", str(tree.pack))
    expected = tree.base / "ComfyUI" / "temp" / paths.ROOT_NAME / "temp_uploads"
    assert Path(paths.resolved_temp_dir("temp_uploads", str(tree.pack / "temp_uploads"))) == expected

    # Hors ComfyUI (ou sous le harnais de test), l'ancien dossier du pack reste.
    monkeypatch.setenv(paths.ENV_SKIP_MIGRATION, "1")
    assert paths.resolved_temp_dir("temp_uploads", str(tree.pack / "temp_uploads")) == \
        str(tree.pack / "temp_uploads")

    source = (PACKAGE_DIR / "holaf_utils.py").read_text(encoding="utf-8")
    assert "resolved_thumb_cache()" in source
    assert "resolved_temp_dir(" in source


if __name__ == "__main__":  # pragma: no cover
    sys.exit(pytest.main([__file__, "-q"]))
