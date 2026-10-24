# ─────────────────────────────────────────────────────────────────────────
# GARDE-FOU PERMANENT de la migration des données utilisateur.
#
# RISQUE COUVERT (perte de données, pas un détail cosmétique) : la migration
# DÉPLACE holaf_utilities.sqlite (1,8 Go sur l'installation déployée), config.ini,
# credentials.json, openai_keys.json, presets, blobby.json, music3, miniatures…
# hors de custom_nodes/ComfyUI-AI-Helper. Si un seul consommateur lisait encore
# l'ancien emplacement, le pack créerait une base NEUVE et VIDE et ignorerait
# les données de l'utilisateur (modèles indexés, tags, statistiques).
#
# La migration ne doit donc s'exécuter QUE si :
#   - holaf_user_paths.CONSUMERS_WIRED est True (tous les consommateurs lisent
#     les accesseurs resolved_*) — verrou ABSOLU, insensible à l'environnement
#     et à force=True ;
#   - AIH_USER_MIGRATION_ENABLED ne la désactive pas (« 0 »/« false »).
# Défaut = ne rien déplacer.
#
# Couverture :
#   1. Matrice de décision migration_enabled() / migration_blocked_reason() ;
#   2. drapeau False ⇒ un démarrage simulé (ensure_once, comme __init__.py) ne
#      déplace RIEN : base, config.ini et credentials toujours en place, aucune
#      arborescence cible créée, aucun journal, aucun marqueur ;
#   3. AIH_USER_MIGRATION_ENABLED=1 ne contourne JAMAIS le drapeau (mutant
#      « garde ignorée » : rouge) ;
#   4. AIH_USER_MIGRATION_ENABLED=0 bloque une migration par ailleurs autorisée ;
#   5. cohérence drapeau/branchement : CONSUMERS_WIRED=True exige que CHAQUE
#      consommateur référence holaf_user_paths (mutant « migration activée avant
#      branchement » : rouge) ;
#   6. imports : importer le helper ET les consommateurs ne migre rien.
#
# Les arbres de test sont JETABLES (tmp_path) et PACK_ROOT est TOUJOURS redirigé
# (fixture autouse) : aucun fichier réel du pack n'est lu ni déplacé.
#
# Usage :
#   PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
#   pytest tests/test_user_paths_guard.py
# ─────────────────────────────────────────────────────────────────────────
import importlib.util
import sqlite3
import sys
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

MODULE_PATH = PACKAGE_DIR / "holaf_user_paths.py"


def _load_helper():
    spec = importlib.util.spec_from_file_location("holaf_user_paths_guard_under_test", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mod = _load_helper()

# Fichiers dont la PERMISSION de migration est verrouillée par le drapeau.
# (fichier:ligne des consommateurs = cf. tests/test_user_paths_consumers.py)
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
)


class _QuietLogger:
    def __init__(self):
        self.messages = []

    def info(self, message):
        self.messages.append(("info", message))

    def warning(self, message):
        self.messages.append(("warning", message))

    def error(self, message):
        self.messages.append(("error", message))


class _Tree:
    """Faux arbre ComfyUI : les données RÉELLEMENT migrables sont à l'ancien
    emplacement (base SQLite valide, config.ini, credentials.json)."""

    def __init__(self, base: Path):
        self.comfy_user = base / "ComfyUI" / "user"
        self.pack = base / "ComfyUI" / "custom_nodes" / "ComfyUI-AI-Helper"
        self.root = self.comfy_user / "default" / "AI-Helper"
        self.legacy_aih = self.comfy_user / "default" / "aih"

    def build(self):
        self.legacy_aih.mkdir(parents=True, exist_ok=True)
        self.pack.mkdir(parents=True, exist_ok=True)
        # VRAIE base SQLite : si la garde était contournée, la migration la
        # déplacerait réellement (le test ne peut donc pas passer par accident).
        conn = sqlite3.connect(str(self.pack / "holaf_utilities.sqlite"))
        conn.execute("CREATE TABLE images (id INTEGER PRIMARY KEY, name TEXT)")
        conn.executemany("INSERT INTO images(name) VALUES (?)", [("a",), ("b",), ("c",)])
        conn.commit()
        conn.close()
        (self.pack / "config.ini").write_text("[ImageGallery]\ntheme = Dark\n", encoding="utf-8")
        (self.legacy_aih / "credentials.json").write_text('{"api_key": "k"}', encoding="utf-8")
        return self

    def kwargs(self):
        return {
            "force": True,
            "comfy_user_dir": str(self.comfy_user),
            "pack_root": str(self.pack),
            "user_root": str(self.root),
        }

    def legacy_db(self):
        return self.pack / "holaf_utilities.sqlite"

    def target_db(self):
        return self.root / "db" / "holaf_utilities.sqlite"

    def assert_nothing_moved(self):
        """Aucun fichier de données déplacé, aucune trace de migration."""
        assert self.legacy_db().is_file(), "la base a été déplacée alors que la migration est interdite"
        conn = sqlite3.connect(str(self.legacy_db()))
        try:
            rows = conn.execute("SELECT count(*) FROM images").fetchone()[0]
        finally:
            conn.close()
        assert rows == 3
        assert (self.pack / "config.ini").is_file()
        assert (self.legacy_aih / "credentials.json").is_file()
        assert not self.root.exists(), "l'arborescence cible a été créée alors que rien ne devait bouger"
        assert not (self.root / ".migration.json").exists()
        assert not (self.pack / mod.MARKER_FILENAME).exists()


@pytest.fixture(autouse=True)
def never_touch_the_real_pack(monkeypatch, tmp_path):
    """FILET DE SÉCURITÉ : PACK_ROOT du module testé devient JETABLE."""
    monkeypatch.setattr(mod, "PACK_ROOT", str(tmp_path / "pack-par-defaut"))
    return tmp_path / "pack-par-defaut"


@pytest.fixture
def clean_env(monkeypatch):
    """Aucun verrou d'environnement ne fausse la mesure de la garde."""
    monkeypatch.delenv(mod.ENV_SKIP_MIGRATION, raising=False)
    monkeypatch.delenv(mod.ENV_USER_ROOT, raising=False)
    monkeypatch.delenv(mod.ENV_SFTP_KNOWN_HOSTS, raising=False)
    monkeypatch.delenv(mod.ENV_MIGRATION_ENABLED, raising=False)
    return monkeypatch


@pytest.fixture
def tree(tmp_path):
    return _Tree(tmp_path).build()


# ---------------------------------------------------------------------------
# 1. Matrice de décision
# ---------------------------------------------------------------------------
def test_flag_is_the_absolute_guard(clean_env):
    """CONSUMERS_WIRED prime sur TOUT, y compris AIH_USER_MIGRATION_ENABLED=1."""
    clean_env.setattr(mod, "CONSUMERS_WIRED", False)
    assert mod.migration_enabled() is False
    clean_env.setenv(mod.ENV_MIGRATION_ENABLED, "1")
    assert mod.migration_enabled() is False, "l'env ne doit JAMAIS outrepasser le drapeau"
    assert mod.migration_blocked_reason(force=True) is not None
    assert "CONSUMERS_WIRED" in mod.migration_blocked_reason(force=True)


def test_flag_true_follows_the_environment(clean_env):
    clean_env.setattr(mod, "CONSUMERS_WIRED", True)
    assert mod.migration_enabled() is True, "drapeau levé + rien d'explicite ⇒ migration permise"
    for value in ("0", "false", "no", "off", "FALSE"):
        clean_env.setenv(mod.ENV_MIGRATION_ENABLED, value)
        assert mod.migration_enabled() is False, value
        assert mod.ENV_MIGRATION_ENABLED in mod.migration_blocked_reason(force=True)
    clean_env.setenv(mod.ENV_MIGRATION_ENABLED, "1")
    assert mod.migration_enabled() is True
    clean_env.delenv(mod.ENV_MIGRATION_ENABLED)
    # AIH_SKIP_USER_MIGRATION reste un refus absolu (harnais de test).
    clean_env.setenv(mod.ENV_SKIP_MIGRATION, "1")
    assert mod.migration_blocked_reason(force=True) is not None


# ---------------------------------------------------------------------------
# 2. Démarrage simulé avec le drapeau à False : RIEN ne bouge
# ---------------------------------------------------------------------------
def test_startup_simulation_moves_nothing_while_flag_is_false(tree, clean_env):
    """Le point d'entrée appelé par __init__.py (ensure_once) ne déplace rien."""
    clean_env.setattr(mod, "CONSUMERS_WIRED", False)
    mod.reset_ensure_once()
    logger = _QuietLogger()
    try:
        report = mod.ensure_once(logger=logger, **tree.kwargs())
    finally:
        mod.reset_ensure_once()

    assert report["status"] == "skipped"
    assert "CONSUMERS_WIRED" in report["blocked_reason"]
    tree.assert_nothing_moved()
    assert logger.messages, "le report doit être journalisé (pas silencieux)"


def test_env_opt_in_cannot_bypass_the_flag(tree, clean_env):
    """Mutant « garde ignorée » : ce test doit devenir ROUGE s'il l'est."""
    clean_env.setattr(mod, "CONSUMERS_WIRED", False)
    clean_env.setenv(mod.ENV_MIGRATION_ENABLED, "1")
    report = mod.ensure_user_data_layout(logger=_QuietLogger(), **tree.kwargs())
    assert report["status"] == "skipped"
    tree.assert_nothing_moved()


def test_env_opt_out_blocks_an_otherwise_allowed_migration(tree, clean_env):
    """Même drapeau levé, AIH_USER_MIGRATION_ENABLED=0 interdit tout déplacement."""
    clean_env.setattr(mod, "CONSUMERS_WIRED", True)
    clean_env.setenv(mod.ENV_MIGRATION_ENABLED, "0")
    report = mod.ensure_user_data_layout(logger=_QuietLogger(), **tree.kwargs())
    assert report["status"] == "skipped"
    tree.assert_nothing_moved()


def test_migration_runs_when_flag_is_true_and_nothing_opposes_it(tree, clean_env):
    """Contrôle positif : la garde n'est pas un blocage définitif."""
    clean_env.setattr(mod, "CONSUMERS_WIRED", True)
    report = mod.ensure_user_data_layout(logger=_QuietLogger(), **tree.kwargs())
    assert report["status"] == "ok"
    assert report["items"]["db_utils"]["status"] == "migrated"
    assert tree.target_db().is_file()
    assert not tree.legacy_db().exists()


# ---------------------------------------------------------------------------
# 3. Cohérence drapeau ⇄ branchement des consommateurs
# ---------------------------------------------------------------------------
def test_wired_flag_requires_every_consumer_to_use_the_helper():
    """CONSUMERS_WIRED=True n'est légitime que si les consommateurs sont branchés.

    Mutant « migration activée avant branchement » : retirer l'import de
    holaf_user_paths d'UN consommateur rend ce test ROUGE.
    """
    if not mod.CONSUMERS_WIRED:
        pytest.skip("phase 1 : la migration est désactivée, rien à prouver")

    missing = []
    for relative in CONSUMER_FILES:
        path = PACKAGE_DIR / relative
        source = path.read_text(encoding="utf-8")
        if "holaf_user_paths" not in source:
            missing.append(relative)
    assert not missing, (
        "CONSUMERS_WIRED=True mais ces consommateurs ne lisent pas holaf_user_paths "
        f"(la migration les rendrait aveugles → perte de données) : {missing}"
    )


def test_helper_has_no_import_side_effect(tmp_path, clean_env):
    """Importer le helper ne migre rien, même drapeau levé (aucun effet de bord)."""
    clean_env.setattr(mod, "CONSUMERS_WIRED", True)
    clean_env.delenv(mod.ENV_SKIP_MIGRATION, raising=False)
    fresh = _load_helper()  # ré-exécution du module : aucun appel ne doit migrer
    assert fresh.CONSUMERS_WIRED is True
    assert fresh._ENSURE_STATE["done"] is False, "ensure_once ne doit pas être appelé à l'import"


def test_importing_consumers_never_migrates(tree, clean_env, monkeypatch):
    """Importer les consommateurs (comme le fait ComfyUI) ne déplace aucune donnée."""
    import types

    clean_env.setattr(mod, "CONSUMERS_WIRED", True)
    clean_env.setenv(mod.ENV_MIGRATION_ENABLED, "1")
    clean_env.setattr(mod, "PACK_ROOT", str(tree.pack))

    fake = types.ModuleType("folder_paths")
    fake.get_user_directory = lambda: str(tree.comfy_user)
    fake.base_path = str(tree.comfy_user.parent)
    fake.get_temp_directory = lambda: str(tree.comfy_user.parent / "temp")
    monkeypatch.setitem(sys.modules, "folder_paths", fake)

    for name, relative in (
        ("guard_holaf_database", "holaf_database.py"),
        ("guard_holaf_config", "holaf_config.py"),
        ("guard_holaf_user_data_manager", "holaf_user_data_manager.py"),
        ("guard_openai_settings_node", "nodes/openai_settings_node.py"),
        ("guard_aih_store", "aih/store.py"),
        ("guard_aih_credentials", "aih/credentials.py"),
    ):
        # holaf_utils.py est écarté : il importe aiofiles (dépendance runtime
        # ComfyUI, absente ici). Sa résolution est prouvée séparément par
        # tests/test_user_paths_consumers.py (accesseurs + constante du module).
        spec = importlib.util.spec_from_file_location(name, PACKAGE_DIR / relative)
        module = importlib.util.module_from_spec(spec)
        monkeypatch.setitem(sys.modules, name, module)
        spec.loader.exec_module(module)

    tree.assert_nothing_moved()


if __name__ == "__main__":  # pragma: no cover
    sys.exit(pytest.main([__file__, "-q"]))
