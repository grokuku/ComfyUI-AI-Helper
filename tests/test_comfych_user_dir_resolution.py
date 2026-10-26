# ─────────────────────────────────────────────────────────────────────────
# ComfyCH — résolution des dossiers ComfyUI HORS ComfyUI + échec BRUYANT du sync.
#
# Bug constaté en exécution réelle (``modal run sync.py``) :
#
#     ❌ Local user/ directory not found at /home/abc/.config/comfyui
#     ✅ Sync terminée !
#     ═══ Terminé (code 0) en 3s ═══
#
# alors que le vrai dossier était ``/config/instances/ComfyUI/ComfyUI/user``.
# Cause : ``modal run`` s'exécute dans un PROCESSUS SÉPARÉ de ComfyUI, où
# ``folder_paths`` n'est pas importable ; le repli ``~/.config/comfyui`` (chemin
# INEXISTANT sur la machine) était accepté comme s'il était bon, puis le script
# affichait la réussite et sortait en code 0 — ce qui laissait le gateway
# redémarrer le worker sur un volume inchangé.
#
# Ce que ce fichier verrouille (chaque point a son mutant) :
#   §1 hors ComfyUI, ``user_dir()`` trouve ``<ComfyUI>/user`` par WALK-UP
#      — MUTANT M1 « repli ~/.config/comfyui prioritaire » → ROUGE ;
#   §2 un dossier inexistant n'est JAMAIS retourné : échec explicite listant
#      TOUS les chemins essayés — MUTANT M2 « chemin inexistant retourné sans
#      erreur » → ROUGE ;
#   §3 la même rigueur vaut pour models/ output/ custom_nodes/ ;
#   §4 ``sync.py`` sans dossier ``user/`` sort en code ≠ 0 et n'affiche AUCUN
#      message de succès — MUTANT M3 « succès affiché malgré l'échec » et
#      MUTANT M4 « code 0 malgré l'échec » → ROUGE ;
#   §5 le cas nominal (dossier présent) continue de réussir.
#
# Aucun test n'exécute la vraie CLI Modal ni n'écrit dans le vrai pack :
# ``modal``/``helpers``/``models``/``comfych_store`` sont remplacés (le paquet
# pip ``modal`` n'est PAS installé dans le venv de test).
#
# Usage :
#   PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
#   pytest tests/test_comfych_user_dir_resolution.py
# ─────────────────────────────────────────────────────────────────────────
import importlib.util
import sys
import types
from pathlib import Path
from typing import ClassVar

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

COMFYCH_DIR = PACKAGE_DIR / "tools" / "comfych"
PATHS_FILE = COMFYCH_DIR / "comfych_paths.py"
SYNC_FILE = COMFYCH_DIR / "sync.py"


# ---------------------------------------------------------------------------
# Chargement de comfych_paths.py sur une fausse installation ComfyUI
# ---------------------------------------------------------------------------
class _ComfyTree:
    """Fausse installation ComfyUI reproduisant la disposition de l'utilisateur.

    ``/config/instances/ComfyUI/ComfyUI/{user,custom_nodes/ComfyUI-AI-Helper/
    tools/comfych}`` : c'est EXACTEMENT la structure du rapport de bug (le
    dossier ``instances/ComfyUI`` contient une installation ``ComfyUI``).
    """

    def __init__(self, instances: Path, *, with_user=True, with_models=True):
        self.base = instances
        self.comfy = instances / "ComfyUI"
        self.custom_nodes = self.comfy / "custom_nodes"
        self.pack = self.custom_nodes / "ComfyUI-AI-Helper"
        self.code = self.pack / "tools" / "comfych"
        self.code.mkdir(parents=True)
        self.custom_nodes.mkdir(parents=True, exist_ok=True)
        self.user = self.comfy / "user"
        if with_user:
            self.user.mkdir(parents=True, exist_ok=True)
        if with_models:
            (self.comfy / "models" / "checkpoints").mkdir(parents=True, exist_ok=True)
            (self.comfy / "output").mkdir(parents=True, exist_ok=True)


def _real_case(tmp_path, **kwargs) -> _ComfyTree:
    """Arbre identique au cas réel rapporté (/config/instances/ComfyUI/ComfyUI)."""
    return _ComfyTree(tmp_path / "config" / "instances" / "ComfyUI", **kwargs)


@pytest.fixture
def outside_comfyui(monkeypatch):
    """Environnement « hors ComfyUI » : ``folder_paths`` NON importable.

    ``sys.modules['folder_paths'] = None`` fait lever ImportError à l'import —
    exactement ce que vit ``modal run sync.py`` (processus séparé de ComfyUI).
    """
    monkeypatch.setitem(sys.modules, "folder_paths", None)
    # Un env explicite résiduel fausserait le test du walk-up.
    monkeypatch.delenv("AIH_COMFY_USER_DIR", raising=False)
    return monkeypatch


def _load_paths(monkeypatch, tree: _ComfyTree):
    """Charge comfych_paths.py par chemin, racine du code = arbre jetable."""
    spec = importlib.util.spec_from_file_location(
        "comfych_paths_under_test", PATHS_FILE
    )
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, "comfych_paths_under_test", module)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "CODEFYCH_CODE_ROOT", tree.code)
    return module


# ---------------------------------------------------------------------------
# 1. Hors ComfyUI : walk-up vers <ComfyUI>/user
# ---------------------------------------------------------------------------
def test_user_dir_is_found_by_walk_up_outside_comfyui(outside_comfyui, tmp_path):
    """MUTANT M1 : rouge si le repli ~/.config/comfyui redevient prioritaire.

    Le faux HOME contient un ``~/.config/comfyui`` RÉEL (cas d'une installation
    ComfyUI par défaut) : un repli prioritaire le choisirait, alors que le
    dossier ``user/`` de l'installation visée est à côté de ``custom_nodes``.
    """
    tree = _real_case(tmp_path)
    fake_home = tmp_path / "home"
    (fake_home / ".config" / "comfyui").mkdir(parents=True)
    outside_comfyui.setenv("HOME", str(fake_home))
    outside_comfyui.setattr(Path, "home", classmethod(lambda cls: fake_home))
    paths = _load_paths(outside_comfyui, tree)

    found = paths.user_dir()
    assert found == tree.user.resolve(), (
        "hors ComfyUI, le dossier user/ doit être trouvé par walk-up "
        f"(attendu {tree.user}, obtenu {found})"
    )
    assert found != fake_home / ".config" / "comfyui", (
        "MUTANT M1 : le repli ~/.config/comfyui ne doit JAMAIS gagner sur un "
        "dossier adjacent à custom_nodes"
    )
    assert found.is_dir()


def test_walk_up_candidates_are_listed_in_order(outside_comfyui, tmp_path):
    """Le diagnostic peut citer chaque chemin essayé, avec son origine."""
    tree = _real_case(tmp_path)
    paths = _load_paths(outside_comfyui, tree)

    candidates = paths.user_dir_candidates()
    sources = [source for source, _path in candidates]
    assert any("walk-up" in source for source in sources), \
        "le walk-up figure parmi les candidats"
    assert any(".config" in str(path) for _s, path in candidates), \
        "~/.config/comfyui reste le DERNIER recours (jamais supprimé)"
    assert candidates[-1][1] == Path.home() / ".config" / "comfyui", \
        "le dernier recours est bien en dernière position"
    assert tree.user.resolve() in [path for _s, path in candidates]


def test_env_variable_forces_the_user_dir(outside_comfyui, tmp_path):
    """AIH_COMFY_USER_DIR reste prioritaire (disposition exotique)."""
    tree = _real_case(tmp_path)
    other = tmp_path / "ailleurs" / "user"
    other.mkdir(parents=True)
    outside_comfyui.setenv("AIH_COMFY_USER_DIR", str(other))
    paths = _load_paths(outside_comfyui, tree)

    assert paths.user_dir() == other.resolve()


# ---------------------------------------------------------------------------
# 2. Jamais un chemin inexistant « comme si c'était bon »
# ---------------------------------------------------------------------------
def test_missing_user_dir_raises_with_every_tried_path(outside_comfyui, tmp_path):
    """MUTANT M2 : rouge si un chemin inexistant est retourné sans erreur."""
    tree = _real_case(tmp_path, with_user=False)
    paths = _load_paths(outside_comfyui, tree)

    with pytest.raises(paths.ComfyPathNotFound) as exc:
        paths.user_dir()

    message = str(exc.value)
    tried = [path for _source, path in paths.user_dir_candidates()]
    assert len(tried) >= 2, "plusieurs chemins doivent être essayés"
    for path in tried:
        assert str(path) in message, f"le diagnostic doit citer {path}"
    assert "user/" in message
    assert "AIH_COMFY_USER_DIR" in message, "le remède est indiqué dans le message"
    assert exc.value.candidates, "l'exception porte la liste structurée des essais"


def test_home_fallback_requires_the_directory_to_exist(outside_comfyui, tmp_path, monkeypatch):
    """``~/.config/comfyui`` n'est accepté que s'il EXISTE vraiment."""
    tree = _real_case(tmp_path, with_user=False)
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))
    paths = _load_paths(outside_comfyui, tree)

    # Absent : échec explicite (aucun candidat n'existe).
    with pytest.raises(paths.ComfyPathNotFound):
        paths.user_dir()

    # Présent : il est accepté (dernier recours assumé).
    (fake_home / ".config" / "comfyui").mkdir(parents=True)
    assert paths.user_dir() == (fake_home / ".config" / "comfyui").resolve()


# ---------------------------------------------------------------------------
# 3. Même rigueur pour models/ output/ custom_nodes/
# ---------------------------------------------------------------------------
def test_other_dirs_use_walk_up_outside_comfyui(outside_comfyui, tmp_path):
    """Les trois autres dossiers ne retombent plus sur un chemin inventé."""
    tree = _real_case(tmp_path)
    paths = _load_paths(outside_comfyui, tree)

    assert paths.models_dir() == (tree.comfy / "models").resolve()
    assert paths.output_dir() == (tree.comfy / "output").resolve()
    assert paths.custom_nodes_dir() == tree.custom_nodes.resolve()
    assert paths.custom_nodes_dirs()[0] == tree.custom_nodes.resolve()


def test_custom_nodes_never_points_into_the_pack_tools_dir(outside_comfyui, tmp_path):
    """Régression : ``<pack>/tools`` n'est PAS un dossier custom_nodes."""
    tree = _real_case(tmp_path)
    paths = _load_paths(outside_comfyui, tree)

    for candidate in paths.custom_nodes_dirs():
        assert candidate.name == "custom_nodes", (
            f"{candidate} n'est pas un dossier custom_nodes"
        )


def test_models_and_output_fail_explicitly_when_absent(outside_comfyui, tmp_path):
    """Sans dossier réel, l'appel strict lève (models/ et output/ compris)."""
    tree = _real_case(tmp_path, with_models=False)
    paths = _load_paths(outside_comfyui, tree)

    with pytest.raises(paths.ComfyPathNotFound):
        paths.first_existing_or_raise("models/", paths.models_dir_candidates())
    with pytest.raises(paths.ComfyPathNotFound):
        paths.first_existing_or_raise("output/", paths.output_dir_candidates())


# ---------------------------------------------------------------------------
# 4. sync.py : échec BRUYANT (code ≠ 0, aucun message de succès)
# ---------------------------------------------------------------------------
class _FakeUploads(list):
    """Journal des ``put_file`` d'un volume factice."""


class _FakeBatchUpload:
    def __init__(self, uploads):
        self.uploads = uploads

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def put_file(self, src, dest):
        self.uploads.append((str(src), str(dest)))


class _FakeVolume:
    uploads: ClassVar[list] = []

    @classmethod
    def from_name(cls, *_args, **_kwargs):
        return cls()

    def batch_upload(self):
        return _FakeBatchUpload(self.uploads)

    def commit(self):
        return None


class _FakeImage:
    def add_local_python_source(self, *_a, **_k):
        return self

    def apt_install(self, *_a, **_k):
        return self

    def pip_install(self, *_a, **_k):
        return self


class _FakeApp:
    def __init__(self, *_a, **_k):
        pass

    def function(self, *_a, **_k):
        return lambda fn: fn

    def local_entrypoint(self, *_a, **_k):
        return lambda fn: fn


@pytest.fixture
def sync_module(monkeypatch, tmp_path):
    """Charge ``sync.py`` avec ``modal``/``helpers``/``models`` remplacés."""
    uploads: list = []
    _FakeVolume.uploads = uploads

    modal_stub = types.ModuleType("modal")
    modal_stub.Volume = _FakeVolume
    modal_stub.Image = types.SimpleNamespace(debian_slim=lambda **_k: _FakeImage())
    modal_stub.App = _FakeApp
    modal_stub.Secret = types.SimpleNamespace(
        from_name=lambda *_a, **_k: None,
        from_dict=lambda *_a, **_k: None,
    )
    modal_stub.exception = types.SimpleNamespace(NotFoundError=RuntimeError)
    monkeypatch.setitem(sys.modules, "modal", modal_stub)

    helpers_stub = types.ModuleType("helpers")
    helpers_stub.download_external_model = lambda *_a, **_k: None
    helpers_stub.get_hf_secrets = list
    helpers_stub.hf_download = lambda *_a, **_k: None
    helpers_stub.resolve_model_dir = lambda name: tmp_path / "models" / str(name)
    monkeypatch.setitem(sys.modules, "helpers", helpers_stub)

    models_stub = types.ModuleType("models")
    models_stub.models = []
    models_stub.models_ext = []
    monkeypatch.setitem(sys.modules, "models", models_stub)

    # Le config.json de ComfyCH : jamais celui du vrai dossier utilisateur.
    config_file = tmp_path / "config.json"
    store_stub = types.ModuleType("comfych_store")
    store_stub.config_path = lambda: config_file
    monkeypatch.setitem(sys.modules, "comfych_store", store_stub)

    spec = importlib.util.spec_from_file_location("comfych_sync_under_test", SYNC_FILE)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, "comfych_sync_under_test", module)
    spec.loader.exec_module(module)
    return types.SimpleNamespace(module=module, uploads=uploads, config_file=config_file)


def _missing_candidates(tmp_path):
    """Candidats tous INEXISTANTS (aucun dossier réel à trouver)."""
    return [
        ("env AIH_COMFY_USER_DIR", tmp_path / "env" / "user"),
        ("walk-up (racine ComfyUI déduite du code)", tmp_path / "instances" / "ComfyUI" / "user"),
        ("dernier recours (~/.config/comfyui)", tmp_path / "home" / ".config" / "comfyui"),
    ]


def test_sync_user_only_exits_non_zero_without_user_dir(
    sync_module, monkeypatch, tmp_path, capsys
):
    """MUTANT M3 (succès affiché) et MUTANT M4 (code 0) : rouges si on régresse."""
    module = sync_module.module
    candidates = _missing_candidates(tmp_path)
    monkeypatch.setattr(module, "user_dir_candidates", lambda: candidates)

    with pytest.raises(SystemExit) as exc_info:
        module.main(sync_user_only=True)

    code = exc_info.value.code
    assert code not in (0, None), f"MUTANT M4 : code de sortie attendu ≠ 0, obtenu {code!r}"

    out = capsys.readouterr().out
    assert "✅ Sync terminée" not in out, \
        "MUTANT M3 : aucun message de succès ne doit être affiché"
    assert "❌" in out, "l'échec est affiché"
    for _source, path in candidates:
        assert str(path) in out, f"le message doit lister le chemin essayé {path}"
    assert "IMPOSSIBLE" in out


def test_full_sync_also_exits_non_zero_without_user_dir(
    sync_module, monkeypatch, tmp_path, capsys
):
    """Le sync COMPLET (celui du bouton « Redémarrer ») échoue aussi en code ≠ 0."""
    module = sync_module.module
    monkeypatch.setattr(module, "user_dir_candidates", lambda: _missing_candidates(tmp_path))
    monkeypatch.setattr(module, "models_to_sync", [])

    with pytest.raises(SystemExit) as exc_info:
        module.main()
    assert exc_info.value.code not in (0, None)
    out = capsys.readouterr().out
    assert "✅ Sync terminée" not in out


def test_sync_custom_nodes_exits_non_zero_when_dir_is_absent(
    sync_module, monkeypatch, tmp_path, capsys
):
    """custom_nodes introuvable : échec explicite (plus de « 0 node » silencieux)."""
    module = sync_module.module
    candidates = [
        ("walk-up (racine ComfyUI déduite du code)", tmp_path / "instances" / "ComfyUI" / "custom_nodes"),
        ("dossier contenant le code ComfyCH", tmp_path / "vide"),
    ]
    monkeypatch.setattr(module, "custom_nodes_dir_candidates", lambda: candidates)

    with pytest.raises(SystemExit) as exc_info:
        module.main(sync_custom_nodes=True)
    assert exc_info.value.code not in (0, None)
    out = capsys.readouterr().out
    assert "custom_nodes" in out
    for _source, path in candidates:
        assert str(path) in out


# ---------------------------------------------------------------------------
# 5. Cas nominal : le sync réussit quand le dossier existe
# ---------------------------------------------------------------------------
def test_sync_user_only_succeeds_when_the_user_dir_exists(
    sync_module, monkeypatch, tmp_path, capsys
):
    """Aucune régression : un dossier réel présent → succès + uploads."""
    module = sync_module.module
    user_dir = tmp_path / "ComfyUI" / "user"
    (user_dir / "default" / "AI-Helper" / "config").mkdir(parents=True)
    (user_dir / "default" / "AI-Helper" / "config" / "comfych.json").write_text("{}")
    (user_dir / "workflows").mkdir()
    (user_dir / "workflows" / "wf.json").write_text("{}")
    monkeypatch.setattr(module, "user_dir_candidates", lambda: [("walk-up", user_dir)])

    module.main(sync_user_only=True)  # ne lève pas

    out = capsys.readouterr().out
    assert "✅ Sync terminée" in out
    assert str(user_dir) in out, "le chemin réellement utilisé est affiché"
    assert len(sync_module.uploads) >= 2, "les fichiers du dossier user/ sont poussés"
    destinations = " ".join(dest for _src, dest in sync_module.uploads)
    assert "comfych.json" in destinations and "wf.json" in destinations
