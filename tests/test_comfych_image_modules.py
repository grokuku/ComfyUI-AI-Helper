# ─────────────────────────────────────────────────────────────────────────
# ComfyCH — modules LOCAUX embarqués dans les images Modal (BUG « comfych_paths »).
#
# Bug constaté en exécution réelle (``modal run sync.py --sync-custom-nodes``) :
#
#     File "/root/sync.py", line 36, in <module>
#         from comfych_paths import (  # bootstrap sys.path ci-dessus
#     ModuleNotFoundError: No module named 'comfych_paths'
#     Runner failed with exception …
#     … toujours en cours (66s) (76s) (86s) (96s) (108s) (118s)
#
# ``modal run`` monte ``/root/sync.py`` mais PAS ses modules frères : seuls ceux
# déclarés dans ``add_local_python_source`` existent dans le container. Depuis
# que la résolution des chemins ComfyUI vit dans ``comfych_paths.py``, l'absence
# de ce module tue l'import de ``sync.py`` — donc TOUTES les fonctions distantes
# — et Modal réessaie en boucle (temps GPU brûlé, aucun node synchronisé).
#
# Ce que ce fichier verrouille (chaque point a son mutant) :
#   §1 ``local_import_modules`` classe les imports locaux (requis vs optionnels
#      « sous try: ») et ignore stdlib/paquets pip ;
#   §2 la liste déclarée COUVRE tous les imports locaux de ``sync.py``
#      — MUTANT M1 « comfych_paths retiré de la déclaration » → ROUGE ;
#   §3 l'image ``_sync_image`` utilise la MÊME constante (aucune 2e vérité) et
#      déclare ses sources APRÈS apt/pip — MUTANT M2 « sources avant pip » →
#      ROUGE (chaque édition d'un module rejouerait les installations) ;
#   §4 import de ``sync.py`` dans un contexte RESTREINT (seuls les modules
#      déclarés existent, comme dans le container) : OK ; MUTANT M1 → ROUGE
#      (``ModuleNotFoundError`` reproduit à l'identique) ;
#   §5 ``_preflight_image_modules`` échoue VITE et clairement quand la
#      déclaration est incomplète (au lieu d'un retry infini) ;
#   §6 même vérification pour ``image.py`` (image du worker) : sa liste couvre
#      ses imports locaux et ``comfych_paths`` n'y est PAS nécessaire.
#
# Usage :
#   PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
#   pytest tests/test_comfych_image_modules.py
# ─────────────────────────────────────────────────────────────────────────
import ast
import importlib.util
import shutil
import sys
import types
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
COMFYCH_DIR = PACKAGE_DIR / "tools" / "comfych"
SYNC_FILE = COMFYCH_DIR / "sync.py"
IMAGE_FILE = COMFYCH_DIR / "image.py"

# Modules locaux de ``tools/comfych`` pouvant traîner dans ``sys.modules``
# (chargés par un autre test) : ils fausseraient le test « contexte restreint ».
_LOCAL_MODULE_NAMES = (
    "comfych_paths",
    "helpers",
    "models",
    "comfych_store",
    "plugins",
    "auth",
    "gateway_router",
    "workers",
)


# ---------------------------------------------------------------------------
# Stubs Modal : le paquet pip ``modal`` n'est PAS dans le venv de test
# ---------------------------------------------------------------------------
class _FakeImage:
    """Chaîne d'image Modal factice (chaque méthode renvoie l'image)."""

    def __init__(self, events=None):
        self.events = events if events is not None else []

    def _record(self, name):
        self.events.append(name)
        return self

    def add_local_python_source(self, *names, **kwargs):
        self.declared_sources = tuple(names)
        return self._record("add_local_python_source")

    def apt_install(self, *args, **kwargs):
        return self._record("apt_install")

    def pip_install(self, *args, **kwargs):
        return self._record("pip_install")

    def pip_install_from_requirements(self, *args, **kwargs):
        return self._record("pip_install_from_requirements")

    def run_commands(self, *args, **kwargs):
        return self._record("run_commands")

    def add_local_file(self, *args, **kwargs):
        return self._record("add_local_file")

    def add_local_dir(self, *args, **kwargs):
        return self._record("add_local_dir")

    def env(self, *args, **kwargs):
        return self._record("env")


class _FakeApp:
    def __init__(self, *args, **kwargs):
        pass

    def function(self, *args, **kwargs):
        return lambda fn: fn

    def local_entrypoint(self, *args, **kwargs):
        return lambda fn: fn


class _FakeSecret:
    """Secret Modal factice (``helpers.get_hf_secrets`` appelle ``hydrate()``)."""

    def hydrate(self):
        return None


def _modal_stub():
    modal_stub = types.ModuleType("modal")
    modal_stub.Image = types.SimpleNamespace(
        debian_slim=lambda **kwargs: _FakeImage()
    )
    modal_stub.App = _FakeApp
    modal_stub.Volume = types.SimpleNamespace(from_name=lambda *a, **k: None)
    modal_stub.Secret = types.SimpleNamespace(
        from_name=lambda *a, **k: _FakeSecret(),
        from_dict=lambda *a, **k: _FakeSecret(),
    )
    modal_stub.exception = types.SimpleNamespace(NotFoundError=RuntimeError)
    return modal_stub


@pytest.fixture
def clean_module_cache():
    """Retire les modules locaux de ``sys.modules``/``sys.path`` puis restaure."""
    saved_modules = {
        name: sys.modules.pop(name) for name in _LOCAL_MODULE_NAMES
        if name in sys.modules
    }
    saved_path = list(sys.path)
    yield
    for name in _LOCAL_MODULE_NAMES:
        sys.modules.pop(name, None)
    sys.modules.update(saved_modules)
    sys.path[:] = saved_path


@pytest.fixture
def sync_module(monkeypatch, tmp_path, clean_module_cache):
    """Charge ``tools/comfych/sync.py`` (modal/helpers/models/comfych_store stubbés)."""
    monkeypatch.setitem(sys.modules, "modal", _modal_stub())
    helpers_stub = types.ModuleType("helpers")
    helpers_stub.download_external_model = lambda *a, **k: None
    helpers_stub.get_hf_secrets = list
    helpers_stub.hf_download = lambda *a, **k: None
    helpers_stub.resolve_model_dir = lambda name: tmp_path / str(name)
    monkeypatch.setitem(sys.modules, "helpers", helpers_stub)
    models_stub = types.ModuleType("models")
    models_stub.models = []
    models_stub.models_ext = []
    monkeypatch.setitem(sys.modules, "models", models_stub)
    store_stub = types.ModuleType("comfych_store")
    store_stub.config_path = lambda: tmp_path / "config.json"
    monkeypatch.setitem(sys.modules, "comfych_store", store_stub)

    spec = importlib.util.spec_from_file_location("comfych_sync_modules_test", SYNC_FILE)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, "comfych_sync_modules_test", module)
    spec.loader.exec_module(module)
    return module


# ═════════════ §1. Analyse AST : imports locaux requis / optionnels ══════════


class TestLocalImportAnalysis:
    def test_required_local_imports_of_sync_are_detected(self, sync_module):
        analysis = sync_module.local_import_modules()

        assert "comfych_paths" in analysis["required"]
        assert "helpers" in analysis["required"]
        assert "models" in analysis["required"]

    def test_guarded_import_is_optional_not_required(self, sync_module):
        """``comfych_store`` est importé sous ``try:`` : optionnel, jamais exigé."""
        analysis = sync_module.local_import_modules()

        assert "comfych_store" in analysis["optional"]
        assert "comfych_store" not in analysis["required"]

    def test_stdlib_and_pip_modules_are_never_local(self, sync_module):
        analysis = sync_module.local_import_modules()

        for external in ("modal", "json", "os", "pathlib", "sqlite3"):
            assert external not in analysis["available"]

    def test_analysis_survives_an_unreadable_file(self, sync_module, tmp_path):
        analysis = sync_module.local_import_modules(tmp_path / "absent.py")

        assert analysis == {"required": [], "optional": [], "available": []}


# ═══════ §2. La déclaration de l'image COUVRE les imports locaux de sync.py ══


class TestDeclaredSourcesCoverLocalImports:
    def test_no_required_local_module_is_missing(self, sync_module):
        """LE test anti-récidive : « comfych_paths oublié » devient impossible."""
        assert sync_module.missing_local_python_sources() == []

    def test_comfych_paths_is_declared(self, sync_module):
        assert "comfych_paths" in sync_module.IMAGE_LOCAL_PYTHON_SOURCES

    def test_every_declared_module_exists_on_disk(self, sync_module):
        for name in sync_module.IMAGE_LOCAL_PYTHON_SOURCES:
            assert (COMFYCH_DIR / f"{name}.py").is_file() or (
                COMFYCH_DIR / name / "__init__.py"
            ).is_file(), f"{name} déclaré mais introuvable dans tools/comfych"

    def test_mutant_m1_removing_comfych_paths_is_detected(self, sync_module, monkeypatch):
        """MUTANT M1 : la liste déclarée perd ``comfych_paths`` → ROUGE."""
        monkeypatch.setattr(
            sync_module, "IMAGE_LOCAL_PYTHON_SOURCES", ("helpers", "models")
        )

        assert sync_module.missing_local_python_sources() == ["comfych_paths"]

    def test_mutant_m1_bis_removing_helpers_is_detected(self, sync_module, monkeypatch):
        monkeypatch.setattr(
            sync_module, "IMAGE_LOCAL_PYTHON_SOURCES", ("comfych_paths", "models")
        )

        assert sync_module.missing_local_python_sources() == ["helpers"]


# ═════════ §3. L'image utilise la constante, et dans le bon ORDRE ════════════


def _image_chain_block(source, variable):
    """Bloc source de ``<variable> = ( modal.Image… )`` (chaîne d'appels)."""
    start = source.index(f"{variable} = (")
    return source[start: source.index("\n)\n", start)]


def _chain_positions(block, names):
    """Position de CHAQUE appel ``.<name>(`` (les commentaires citent les noms)."""
    return {name: block.index(f".{name}(") for name in names}


class TestImageDefinition:
    def test_image_declares_the_constant_itself(self, sync_module):
        """Aucune 2e liste en dur : l'image lit ``IMAGE_LOCAL_PYTHON_SOURCES``."""
        source = SYNC_FILE.read_text(encoding="utf-8")

        assert "add_local_python_source(*IMAGE_LOCAL_PYTHON_SOURCES" in source
        assert 'add_local_python_source("helpers"' not in source, (
            "l'ancienne liste en dur (sans comfych_paths) ne doit pas revenir"
        )

    def test_local_sources_come_after_apt_and_pip(self, sync_module):
        """Les sources en DERNIER : éditer un module ne rejoue pas apt/pip."""
        block = _image_chain_block(SYNC_FILE.read_text(encoding="utf-8"), "_sync_image")
        position = _chain_positions(
            block, ("apt_install", "pip_install", "add_local_python_source")
        )

        assert position["apt_install"] < position["pip_install"]
        assert position["pip_install"] < position["add_local_python_source"], (
            "add_local_python_source AVANT pip_install invaliderait les couches "
            "apt/pip à chaque édition d'un module du pack"
        )

    def test_the_order_assertion_rejects_a_mutant(self, sync_module):
        """MUTANT M2 : sources déclarées AVANT les installations → détecté."""
        mutant = (
            "_sync_image = (\n"
            '    modal.Image.debian_slim(python_version="3.11")\n'
            "    .add_local_python_source(*IMAGE_LOCAL_PYTHON_SOURCES, copy=True)\n"
            '    .apt_install("aria2")\n'
            '    .pip_install("huggingface_hub")\n'
            "\n)\n"
        )
        position = _chain_positions(
            mutant, ("apt_install", "pip_install", "add_local_python_source")
        )

        assert position["add_local_python_source"] < position["pip_install"], (
            "l'assertion d'ordre du test précédent doit échouer sur ce mutant"
        )


# ═════ §4. Import dans un contexte RESTREINT (comme le container Modal) ══════


def _stage_container_root(tmp_path, module_names):
    """Reproduit ce que Modal monte : ``sync.py`` + les modules DÉCLARÉS seuls."""
    container = tmp_path / "root"
    container.mkdir()
    shutil.copy(SYNC_FILE, container / "sync.py")
    for name in module_names:
        source_file = COMFYCH_DIR / f"{name}.py"
        if source_file.is_file():
            shutil.copy(source_file, container / source_file.name)
            continue
        package_dir = COMFYCH_DIR / name
        if (package_dir / "__init__.py").is_file():
            shutil.copytree(
                package_dir, container / name,
                ignore=shutil.ignore_patterns("__pycache__"),
            )
    return container


def _import_staged_sync(monkeypatch, container):
    """Importe ``<container>/sync.py`` comme le fait le container distant.

    Les modules locaux sont purgés de ``sys.modules`` et le vrai dossier du pack
    est retiré de ``sys.path`` : seuls les fichiers copiés dans *container*
    peuvent satisfaire les imports (c'est tout l'intérêt du test).
    """
    for name in _LOCAL_MODULE_NAMES:
        sys.modules.pop(name, None)
    sys.path[:] = [
        entry for entry in sys.path
        if not entry or Path(entry).resolve() != COMFYCH_DIR
    ]
    monkeypatch.setitem(sys.modules, "modal", _modal_stub())
    spec = importlib.util.spec_from_file_location(
        "comfych_sync_in_container_test", container / "sync.py"
    )
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, "comfych_sync_in_container_test", module)
    spec.loader.exec_module(module)
    return module


class TestRestrictedImport:
    def test_declared_modules_are_enough_to_import_sync(
        self, sync_module, monkeypatch, tmp_path
    ):
        """Le container n'a QUE les modules déclarés : l'import doit réussir."""
        container = _stage_container_root(
            tmp_path, sync_module.IMAGE_LOCAL_PYTHON_SOURCES
        )

        module = _import_staged_sync(monkeypatch, container)

        assert module.IMAGE_LOCAL_PYTHON_SOURCES == sync_module.IMAGE_LOCAL_PYTHON_SOURCES

    def test_mutant_missing_comfych_paths_fails_the_import(
        self, sync_module, monkeypatch, tmp_path
    ):
        """MUTANT M1 (reproduction EXACTE du bug) : sans le module → rouge."""
        declared_without_paths = tuple(
            name for name in sync_module.IMAGE_LOCAL_PYTHON_SOURCES
            if name != "comfych_paths"
        )
        container = _stage_container_root(tmp_path, declared_without_paths)

        with pytest.raises(ModuleNotFoundError) as excinfo:
            _import_staged_sync(monkeypatch, container)

        assert "comfych_paths" in str(excinfo.value)
        assert "No module named" in str(excinfo.value)


# ═════════ §5. Garde-fou : échec VITE, pas de retry infini ══════════════════


class TestPreflightFailFast:
    def test_preflight_passes_with_the_real_declaration(self, sync_module, capsys):
        sync_module._preflight_image_modules()  # ne lève pas

        assert "❌" not in capsys.readouterr().out

    def test_preflight_fails_fast_when_a_module_is_missing(
        self, sync_module, monkeypatch, capsys
    ):
        """Une déclaration incomplète sort en code 1 AVANT tout appel distant."""
        monkeypatch.setattr(
            sync_module, "IMAGE_LOCAL_PYTHON_SOURCES", ("helpers", "models")
        )

        with pytest.raises(SystemExit) as excinfo:
            sync_module._preflight_image_modules()

        assert excinfo.value.code == 1
        out = capsys.readouterr().out
        assert "Image Modal INCOMPLÈTE" in out
        assert "comfych_paths" in out
        assert "add_local_python_source" in out
        assert "réessaie en boucle" in out, "le message doit expliquer le retry infini"

    def test_main_preflights_before_any_remote_call(
        self, sync_module, monkeypatch, capsys
    ):
        """``main`` refuse de lancer un sync avec une image incomplète."""
        monkeypatch.setattr(
            sync_module, "IMAGE_LOCAL_PYTHON_SOURCES", ("helpers", "models")
        )
        called = []
        monkeypatch.setattr(
            sync_module,
            "extract_custom_nodes_from_volume",
            types.SimpleNamespace(remote=lambda *a, **k: called.append("remote")),
        )

        with pytest.raises(SystemExit) as excinfo:
            sync_module.main(sync_custom_nodes=True)

        assert excinfo.value.code == 1
        assert called == [], "aucune fonction distante ne doit être appelée"


# ═════════ §6. Même vérification pour l'image du worker (image.py) ══════════


def _local_imports_of(path: Path) -> set[str]:
    """Imports de niveau module de *path* qui désignent un module FRÈRE.

    Analyse indépendante de celle de production : si les deux divergeaient, ce
    test le signalerait (aucune confiance aveugle dans l'outil qu'on teste).
    """
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found: set[str] = set()
    stack = list(tree.body)
    while stack:
        node = stack.pop()
        if isinstance(node, ast.Import):
            found.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if not getattr(node, "level", 0) and node.module:
                found.add(node.module.split(".")[0])
        elif isinstance(node, (ast.Try, ast.If)):
            stack.extend(node.body)
    directory = path.parent
    return {
        name for name in found
        if (directory / f"{name}.py").is_file()
        or (directory / name / "__init__.py").is_file()
    }


class TestWorkerImageSources:
    def test_worker_image_sources_cover_its_local_imports(self):
        """``plugins`` est requis ; ``comfych_paths`` n'est PAS nécessaire."""
        required = _local_imports_of(IMAGE_FILE)
        source = IMAGE_FILE.read_text(encoding="utf-8")
        block = source[source.index("IMAGE_LOCAL_PYTHON_SOURCES = ("):]
        block = block[: block.index("\n)\n")]
        declared = {
            line.strip().strip('",') for line in block.splitlines()[1:]
            if line.strip().startswith('"')
        }

        assert required <= declared, (
            f"modules locaux importés mais non déclarés : {sorted(required - declared)}"
        )
        assert "plugins" in required and "plugins" in declared
        assert "comfych_paths" not in required, (
            "aucun module de l'image worker n'importe comfych_paths : l'exiger "
            "ferait planter le container du worker pour rien"
        )

    def test_worker_image_declares_sources_after_heavy_installs(self):
        """Éditer un module du gateway ne doit pas rejouer apt/pip/torch."""
        source = IMAGE_FILE.read_text(encoding="utf-8")
        function_source = source[source.index("def _build_image()"):]

        assert function_source.index("pip_install_from_requirements") < \
            function_source.index("add_local_python_source(*IMAGE_LOCAL_PYTHON_SOURCES")
        assert function_source.index('run_commands("comfy --skip-prompt install --nvidia")') < \
            function_source.index("add_local_python_source(*IMAGE_LOCAL_PYTHON_SOURCES")
