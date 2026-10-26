# ─────────────────────────────────────────────────────────────────────────
# ComfyCH intégré au pack (tools/comfych/) — import automatique de l'ancienne
# configuration, résolution des chemins, mode de rendu forcé, routes montées.
#
# Contexte : ComfyCH (extension ComfyUI « Modal Gateway ») écrivait son
# ``config.json`` (dont ``api_key``) et ses ``logs/`` DANS son dossier de code,
# c'est-à-dire dans le pack, et déduisait output/models/user/custom_nodes de sa
# propre position (``PROJECT_ROOT.parent.parent``). Intégré sous
# ``tools/comfych/``, ces quatre chemins pointaient FAUX silencieusement.
#
# Ce fichier verrouille le comportement ET sert de garde anti-mutation :
#   §1 chemins            — MUTANT « chemin de config retombant dans le pack »
#   §2 import automatique — MUTANT « import qui écrase alors que les deux
#                           existent », MUTANT « clé API journalisée »,
#                           MUTANT « ancien fichier supprimé »
#   §3 aucun ancien       — config vide + message d'aide
#   §4 mode local forcé   — MUTANT « local écrit dans le fichier de config »
#   §5 routes montées     — /api/modal/* toujours en place, api_key masquée
#
# Aucun test n'écrit dans le vrai pack : PACK_ROOT de holaf_user_paths et
# CODEFYCH_CODE_ROOT du store sont redirigés vers une arborescence jetable.
#
# Usage :
#   PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
#   pytest tests/test_comfych_integration.py
# ─────────────────────────────────────────────────────────────────────────
import importlib.util
import json
import os
import sys
import types
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

import holaf_user_paths as aih_paths  # après le bootstrap sys.path

COMFYCH_DIR = PACKAGE_DIR / "tools" / "comfych"

# Secret factice : sa présence dans une sortie de log fait échouer le test.
API_SECRET = "clef-modale-TRES-secrete-42"


def _load(monkeypatch, name, relative):
    """Charge un fichier du pack par chemin (comme le fait ComfyUI)."""
    spec = importlib.util.spec_from_file_location(name, PACKAGE_DIR / relative)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, name, module)
    spec.loader.exec_module(module)
    return module


class _Tree:
    """Fausse installation ComfyUI : pack + arborescence utilisateur jetables."""

    def __init__(self, base: Path):
        self.base = base
        self.comfy = base / "ComfyUI"
        self.custom_nodes = self.comfy / "custom_nodes"
        self.pack = self.custom_nodes / "ComfyUI-AI-Helper"
        self.code = self.pack / "tools" / "comfych"
        self.user_root = self.comfy / "user" / "default" / "AI-Helper"
        self.code.mkdir(parents=True)
        self.custom_nodes.mkdir(parents=True, exist_ok=True)

        # Ancien emplacement (dans le code de ComfyCH) et nouvelle cible.
        self.legacy_config = self.code / "config.json"
        self.legacy_logs = self.code / "logs"
        self.new_config = self.user_root / "config" / "comfych.json"
        self.new_logs = self.user_root / "logs" / "comfych"

    def write_legacy(self, api_key=API_SECRET, **overrides):
        config = {
            "api_url": "https://mon-gateway.modal.run",
            "api_key": api_key,
            "models_to_sync": [{"name": "sdxl.safetensors", "dir": "checkpoints"}],
            "custom_nodes_ext": ["ComfyUI-Impact-Pack"],
            "synced_custom_nodes": ["ComfyUI-Impact-Pack"],
        }
        config.update(overrides)
        self.legacy_config.write_text(json.dumps(config, indent=2), encoding="utf-8")
        return config


@pytest.fixture
def tree(tmp_path):
    return _Tree(tmp_path)


@pytest.fixture
def comfych(tree, monkeypatch):
    """Charge les modules RÉELS de tools/comfych sur une arborescence jetable."""
    # holaf_user_paths : le pack devient jetable, la racine utilisateur passe
    # par l'env (user_layout_adopted() vrai → écritures dans l'arbre utilisateur).
    monkeypatch.setattr(aih_paths, "PACK_ROOT", str(tree.pack))
    monkeypatch.delenv(aih_paths.ENV_SKIP_MIGRATION, raising=False)
    monkeypatch.delenv(aih_paths.ENV_MIGRATION_ENABLED, raising=False)
    monkeypatch.setenv(aih_paths.ENV_USER_ROOT, str(tree.user_root))

    paths = _load(monkeypatch, "comfych_paths_under_test", "tools/comfych/comfych_paths.py")
    store = _load(monkeypatch, "comfych_store_under_test", "tools/comfych/comfych_store.py")
    # `from .comfych_paths import ...` copie les valeurs par nom : on redirige
    # les deux modules vers l'arbre jetable (aucune écriture dans le vrai pack).
    monkeypatch.setattr(paths, "CODEFYCH_CODE_ROOT", tree.code)
    monkeypatch.setattr(store, "CODEFYCH_CODE_ROOT", tree.code)
    monkeypatch.setattr(store, "custom_nodes_dirs", lambda: [tree.custom_nodes])
    return types.SimpleNamespace(paths=paths, store=store, tree=tree)


def _import_legacy(store, log_lines=None):
    """Appelle import_legacy_config en capturant les lignes de log."""
    lines = log_lines if log_lines is not None else []
    result = store.import_legacy_config(log=lines.append)
    return result, "\n".join(lines)


# ---------------------------------------------------------------------------
# 1. Chemins : la config et les logs quittent le pack
# ---------------------------------------------------------------------------
def test_config_and_logs_live_in_the_user_tree(comfych):
    """MUTANT « chemin de config retombant dans le pack » : rouge si on régresse."""
    tree, store = comfych.tree, comfych.store

    assert aih_paths.p_comfych_config() == str(tree.new_config)
    assert Path(aih_paths.resolved_comfych_config()) == tree.new_config
    assert Path(store.config_path()) == tree.new_config, \
        "la config de ComfyCH doit être lue dans l'arborescence utilisateur"

    assert aih_paths.p_comfych_logs() == str(tree.new_logs)
    assert Path(aih_paths.resolved_comfych_logs()) == tree.new_logs
    assert Path(store.log_path()) == tree.new_logs / "last_operation.log"
    assert Path(store.status_path()) == tree.new_logs / "last_operation.status"

    # Ancien emplacement documenté (dans le code, donc dans le pack).
    assert aih_paths.legacy_comfych_config_paths() == [str(tree.legacy_config)]
    assert aih_paths.legacy_comfych_logs_paths() == [str(tree.legacy_logs)]


def test_before_migration_the_legacy_config_is_still_used(comfych, monkeypatch):
    """Tant que rien n'a bougé, le comportement d'origine est conservé."""
    tree = comfych.tree
    tree.write_legacy()
    monkeypatch.setenv(aih_paths.ENV_SKIP_MIGRATION, "1")

    assert Path(aih_paths.resolved_comfych_config()) == tree.legacy_config
    assert Path(comfych.store.config_path()) == tree.legacy_config


def test_migration_plan_declares_both_comfych_items(comfych):
    """Les deux données de ComfyCH sont SUIVIES par la migration du pack."""
    plan = aih_paths.build_migration_plan(
        comfy_user_dir=str(comfych.tree.comfy / "user"),
        pack_root=str(comfych.tree.pack),
        root=str(comfych.tree.user_root),
    )
    items = {item["key"]: item for item in plan}
    assert items["comfych_config"]["new"] == str(comfych.tree.new_config)
    assert items["comfych_config"]["kind"] == "file"
    assert items["comfych_config"]["legacy"] == [str(comfych.tree.legacy_config)]
    assert items["comfych_logs"]["new"] == str(comfych.tree.new_logs)
    assert items["comfych_logs"]["kind"] == "dir"


# ---------------------------------------------------------------------------
# 2. Import automatique de l'ancienne configuration
# ---------------------------------------------------------------------------
def test_import_copies_and_renames_but_never_deletes(comfych):
    """Ancien présent + cible absente → copie, puis ancien renommé ``.migrated``.

    MUTANTS tués : « import qui supprime l'ancien fichier » et « import qui
    copie au mauvais endroit ».
    """
    tree, store = comfych.tree, comfych.store
    original = tree.write_legacy()

    result, log_text = _import_legacy(store)

    assert result["status"] == "imported", result
    assert Path(result["source"]) == tree.legacy_config
    assert tree.new_config.is_file(), "la config doit être copiée dans l'arborescence utilisateur"
    assert json.loads(tree.new_config.read_text(encoding="utf-8")) == original, \
        "la configuration importée doit être IDENTIQUE à l'ancienne"

    migrated = tree.code / "config.json.migrated"
    assert migrated.is_file(), "l'ancienne config doit être renommée en .migrated"
    assert not tree.legacy_config.exists(), "l'ancien nom ne doit plus exister (ré-import évité)"
    assert migrated.read_text(encoding="utf-8") == tree.new_config.read_text(encoding="utf-8")

    # MUTANT « clé API journalisée » : aucune ligne de log ne doit la contenir.
    assert API_SECRET not in log_text, f"la clé API a fui dans un log : {log_text!r}"


def test_import_conflict_never_overwrites_and_warns(comfych):
    """Les DEUX existent → rien n'est écrasé, avertissement explicite.

    MUTANT « import qui écrase alors que les deux existent » : rouge si la
    cible est modifiée.
    """
    tree, store = comfych.tree, comfych.store
    tree.write_legacy(api_key="ancienne-clef")
    tree.new_config.parent.mkdir(parents=True, exist_ok=True)
    current = {"api_url": "https://courant.modal.run", "api_key": "clef-courante"}
    tree.new_config.write_text(json.dumps(current), encoding="utf-8")

    result, log_text = _import_legacy(store)

    assert result["status"] == "conflict", result
    assert json.loads(tree.new_config.read_text(encoding="utf-8")) == current, \
        "MUTANT : la configuration en place ne doit JAMAIS être écrasée"
    assert tree.legacy_config.is_file(), "l'ancien fichier doit rester intact en cas de conflit"
    assert not (tree.code / "config.json.migrated").exists(), \
        "aucun renommage quand rien n'a été importé"
    # L'avertissement cite les DEUX chemins (l'utilisateur doit pouvoir choisir).
    assert str(tree.new_config) in log_text and str(tree.legacy_config) in log_text
    # Et jamais la clé API.
    assert "ancienne-clef" not in log_text and "clef-courante" not in log_text


def test_import_is_noop_when_only_the_target_exists(comfych):
    tree, store = comfych.tree, comfych.store
    tree.new_config.parent.mkdir(parents=True, exist_ok=True)
    tree.new_config.write_text(json.dumps({"api_url": "https://deja-ligne.modal.run"}), encoding="utf-8")

    result, log_text = _import_legacy(store)

    assert result["status"] == "present"
    assert json.loads(tree.new_config.read_text(encoding="utf-8"))["api_url"] == "https://deja-ligne.modal.run"
    assert log_text == "", "aucun bruit quand il n'y a rien à faire"


def test_import_finds_a_nearby_custom_node_config(comfych):
    """Scan ``<custom_nodes>/*/config.json`` : retenu seulement s'il ressemble à ComfyCH."""
    tree, store = comfych.tree, comfych.store
    other = tree.custom_nodes / "UneAutreExtension"
    other.mkdir(parents=True)
    # Un config.json d'une AUTRE extension doit être IGNORÉ (1 seule clé connue).
    (other / "config.json").write_text(
        json.dumps({"api_url": "https://pas-comfych.example"}), encoding="utf-8"
    )
    comfych_like = tree.custom_nodes / "VieuxDossier"
    comfych_like.mkdir(parents=True)
    (comfych_like / "config.json").write_text(
        json.dumps({"api_url": "https://trouve.modal.run", "api_key": API_SECRET,
                    "models_to_sync": []}),
        encoding="utf-8",
    )

    assert store.find_legacy_config(tree.new_config) == comfych_like / "config.json"
    result, log_text = _import_legacy(store)
    assert result["status"] == "imported"
    assert json.loads(tree.new_config.read_text(encoding="utf-8"))["api_url"] == "https://trouve.modal.run"
    assert API_SECRET not in log_text


def test_import_prefers_the_documented_order(comfych):
    """L'ordre de recherche documenté est respecté (code → ComfyCH → ~/.comfych)."""
    tree, store = comfych.tree, comfych.store
    named = tree.custom_nodes / "ComfyCH"
    named.mkdir(parents=True)
    (named / "config.json").write_text(json.dumps({"api_url": "https://nomme.modal.run"}), encoding="utf-8")

    candidates = store.legacy_config_candidates()
    assert candidates[0] == tree.legacy_config, "le dossier de code de ComfyCH est cherché EN PREMIER"
    assert named / "config.json" in candidates
    assert Path(os.path.expanduser("~/.comfych/config.json")) in candidates
    assert candidates[-1] == Path(os.path.expanduser("~/.comfych/config.json")), \
        "~/.comfych est le DERNIER emplacement essayé"


# ---------------------------------------------------------------------------
# 3. Aucun ancien fichier : config vide + message d'aide, jamais dans le pack
# ---------------------------------------------------------------------------
def test_no_legacy_creates_an_empty_config_and_explains_where_to_put_it(comfych):
    """MUTANT « chemin de config retombant dans le pack » : rouge si on y écrit."""
    tree, store = comfych.tree, comfych.store
    before = sorted(p.name for p in tree.code.iterdir())

    result, log_text = _import_legacy(store)

    assert result["status"] == "created", result
    assert tree.new_config.is_file()
    created = json.loads(tree.new_config.read_text(encoding="utf-8"))
    assert created["api_url"] == "" and created["models_to_sync"] == []
    # Le message indique OÙ déposer l'ancien fichier.
    assert "config.json" in log_text
    assert "ComfyCH" in log_text or "comfych" in log_text
    # Rien n'a été créé dans le dossier du code (= dans le pack).
    assert sorted(p.name for p in tree.code.iterdir()) == before
    assert not (tree.code / "logs").exists()


def test_hors_comfyui_nothing_is_written_in_the_pack(tree, monkeypatch):
    """Hors arborescence utilisateur, la cible est DANS le pack : on n'écrit RIEN."""
    monkeypatch.setattr(aih_paths, "PACK_ROOT", str(tree.pack))
    monkeypatch.delenv(aih_paths.ENV_USER_ROOT, raising=False)
    monkeypatch.setenv(aih_paths.ENV_SKIP_MIGRATION, "1")
    store = _load(monkeypatch, "comfych_store_hors_comfy", "tools/comfych/comfych_store.py")
    monkeypatch.setattr(store, "CODEFYCH_CODE_ROOT", tree.code)
    monkeypatch.setattr(store, "custom_nodes_dirs", lambda: [tree.custom_nodes])

    result, log_text = _import_legacy(store)

    assert result["status"] == "absent"
    assert not tree.legacy_config.exists(), "aucun fichier de données créé dans le pack"
    assert "aucun fichier créé" in log_text


# ---------------------------------------------------------------------------
# 4. Mode de rendu forcé « local » — EN MÉMOIRE, fichier intact
# ---------------------------------------------------------------------------
def _fake_server_module(monkeypatch):
    """Faux ``server`` de ComfyUI : PromptServer.add_routes + app.router."""
    routes = []

    class _Router:
        def add_route(self, method, path, handler):
            routes.append((method, path, handler))

    class _App:
        def __init__(self):
            self.router = _Router()
            self.middlewares = []

    class PromptServer:
        instance = None

        def __init__(self):
            self.app = _App()
            self.routes = []
            PromptServer.instance = self

        def add_routes(self):
            """Implémentation d'origine (appelée par le monkeypatch de ComfyCH)."""
            return "orig"

    module = types.ModuleType("server")
    module.PromptServer = PromptServer
    monkeypatch.setitem(sys.modules, "server", module)
    return module, routes


def _load_comfych(monkeypatch, tree):
    """Charge tools/comfych/__init__.py comme le fait le pack (paquet nommé)."""
    server_module, routes = _fake_server_module(monkeypatch)
    server_module.PromptServer()  # instance (ComfyUI la crée au démarrage)
    spec = importlib.util.spec_from_file_location(
        "holaf_comfych_under_test",
        COMFYCH_DIR / "__init__.py",
        submodule_search_locations=[str(COMFYCH_DIR)],
    )
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, "holaf_comfych_under_test", module)
    spec.loader.exec_module(module)
    return module, routes


def test_render_mode_is_forced_to_local_without_touching_the_config(comfych, monkeypatch):
    """MUTANT « local écrit dans le fichier de config » : rouge si mtime/contenu bouge."""
    tree = comfych.tree
    tree.new_config.parent.mkdir(parents=True, exist_ok=True)
    user_config = {
        "api_url": "https://mon-gateway.modal.run",
        "api_key": API_SECRET,
        "models_to_sync": [{"name": "sdxl.safetensors", "dir": "checkpoints"}],
        "custom_nodes_ext": ["ComfyUI-Impact-Pack"],
        "render_mode": "modal:h100",
    }
    tree.new_config.write_text(json.dumps(user_config), encoding="utf-8")
    before_text = tree.new_config.read_text(encoding="utf-8")
    before_mtime = tree.new_config.stat().st_mtime_ns

    module, _routes = _load_comfych(monkeypatch, tree)

    assert module.forced_render_mode() == "local", "le mode de rendu doit être forcé à « local »"
    after_text = tree.new_config.read_text(encoding="utf-8")
    assert after_text == before_text, "MUTANT : le fichier de config ne doit PAS être modifié"
    assert tree.new_config.stat().st_mtime_ns == before_mtime, \
        "MUTANT : le fichier ne doit même pas être réécrit à l'identique"
    # La config de l'utilisateur reste intacte, GPU préféré compris.
    assert json.loads(after_text) == user_config

    # Et la route de config annonce le forçage SANS jamais renvoyer la clé.
    masked = module._mask_config(module.load_config())
    assert masked["api_key"] == ""
    assert masked["api_key_set"] is True


def test_startup_does_not_cancel_running_jobs(comfych, monkeypatch):
    """Aucune annulation de tâche / de processus au démarrage (jobs Modal laissés)."""
    calls = []

    real_create_task = None

    def _record(name):
        def _fn(*args, **kwargs):
            calls.append(name)
            raise AssertionError(f"{name} ne doit pas être appelé au démarrage")
        return _fn

    monkeypatch.setattr("subprocess.Popen", _record("subprocess.Popen"))
    monkeypatch.setattr("os.kill", _record("os.kill"))
    import asyncio

    real_create_task = asyncio.create_task
    monkeypatch.setattr(asyncio, "create_task", _record("asyncio.create_task"))

    module, _routes = _load_comfych(monkeypatch, comfych.tree)
    assert module.forced_render_mode() == "local"
    assert calls == [], f"le démarrage ne doit rien lancer/annuler : {calls}"
    monkeypatch.setattr(asyncio, "create_task", real_create_task)


# ---------------------------------------------------------------------------
# 5. Routes /api/modal/* montées par le monkeypatch de PromptServer.add_routes
# ---------------------------------------------------------------------------
def test_modal_routes_are_mounted_and_api_key_stays_masked(comfych, monkeypatch):
    _module, routes = _load_comfych(monkeypatch, comfych.tree)
    server = sys.modules["server"]
    instance = server.PromptServer.instance

    # ComfyUI appelle add_routes() APRÈS le chargement des custom nodes.
    assert instance.add_routes() == "orig", "les routes d'origine doivent être appelées d'abord"
    paths = {path for _method, path, _handler in routes}
    for expected in (
        "/api/modal/config",
        "/api/modal/status",
        "/api/modal/sync",
        "/api/modal/logs",
        "/api/modal/user-settings/status",
    ):
        assert expected in paths, f"route manquante : {expected}"
    # Plusieurs chemins portent DEUX méthodes (GET/POST) : on compte les
    # ENDPOINTS, pas les chemins uniques.
    assert len(routes) >= 23, f"les 23 routes de ComfyCH doivent être montées (reçu {len(routes)})"

    # Le mode forcé est exposé par la route de config (source, garde statique).
    source = (COMFYCH_DIR / "__init__.py").read_text(encoding="utf-8")
    assert 'payload["render_mode_forced"] = forced_render_mode()' in source
    assert "FORCED_RENDER_MODE = \"local\"" in source


def test_module_load_is_not_blocked_by_a_missing_modal_package(comfych, monkeypatch):
    """`modal`/`fastapi` sont OPTIONNELS : leur absence ne casse pas le démarrage."""
    monkeypatch.setitem(sys.modules, "modal", None)
    monkeypatch.setitem(sys.modules, "fastapi", None)
    module, _routes = _load_comfych(monkeypatch, comfych.tree)
    assert module.forced_render_mode() == "local"


if __name__ == "__main__":  # pragma: no cover
    sys.exit(pytest.main([__file__, "-q"]))
