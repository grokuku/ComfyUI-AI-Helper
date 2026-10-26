# ─────────────────────────────────────────────────────────────────────────
# ComfyCH — dépendances des custom nodes installées AU BUILD (image Modal).
#
# Contexte (bug vécu sur le worker Modal) :
#   ``ModuleNotFoundError: No module named 'watchdog'`` → le pack AI-Helper ne
#   s'importe pas du tout → « Node 'AIH Prompt Enhancer' not found ».
#   Le log de déploiement disait ``📦 Dépendances de 0 custom node(s) locales
#   installées au build`` alors que ``custom_nodes/`` contenait 31 dossiers.
#
# CAUSE : ``image.py`` déduisait le dossier des nodes par ``root_dir.parent``,
# or ``root_dir`` est ``<custom_nodes>/ComfyUI-AI-Helper/tools/comfych`` : le
# parent est ``<pack>/tools`` (qui ne contient que ``comfych``), et la boucle
# excluait précisément les dossiers nommés ``comfych``. Résultat : zéro node
# détecté, ``watchdog``/``cv2``/``gguf``/``pywt`` jamais installés.
#
# Ce fichier verrouille :
#   §1 détection > 0 sur une arborescence factice
#      — MUTANT « détection retourne 0 en dur » → rouge ;
#   §2 requirements du PACK toujours inclus, EN PREMIER, même si la découverte
#      échoue — MUTANT « requirements du pack non installés » → rouge ;
#   §3 ``watchdog`` (dépendance du pack) présent dans la commande d'install ;
#   §4 un ``requirements.txt`` en échec ne casse JAMAIS le build, et l'échec
#      est loggué avec le NOM du node — MUTANT « échec = build cassé » → rouge ;
#   §5 l'empreinte de déploiement change avec les dépendances (anti « Deployment
#      skipped: no changes detected ») et ne change pas sans modification
#      — MUTANT « skip malgré changement de deps » → rouge ;
#   §6 l'empreinte est posée en DERNIÈRE couche (cache Modal préservé).
#
# Aucun test ne construit d'image : ``modal`` est un faux module enregistreur.
#
# Usage :
#   PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
#   pytest tests/test_comfych_image_deps.py
# ─────────────────────────────────────────────────────────────────────────
import importlib.util
import sys
import types
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

COMFYCH_DIR = PACKAGE_DIR / "tools" / "comfych"
IMAGE_PATH = COMFYCH_DIR / "image.py"

PACK_NAME = "ComfyUI-AI-Helper"


# ---------------------------------------------------------------------------
# Faux ``modal.Image`` : enregistre la chaîne d'opérations, comme le vrai
# (chaque méthode retourne un NOUVEL objet immuable).
# ---------------------------------------------------------------------------
class FakeImage:
    def __init__(self, ops=()):
        self.ops = list(ops)

    def _chain(self, op):
        return FakeImage(self.ops + [op])

    # -- constructeurs / étapes de l'image -------------------------------
    @staticmethod
    def debian_slim(*_args, **_kwargs):
        return FakeImage([("debian_slim", None)])

    def add_local_python_source(self, *names, **_kwargs):
        return self._chain(("add_local_python_source", tuple(names)))

    def apt_install(self, *packages, **_kwargs):
        return self._chain(("apt_install", tuple(packages)))

    def pip_install_from_requirements(self, path, **_kwargs):
        return self._chain(("pip_install_from_requirements", str(path)))

    def run_commands(self, *commands, **_kwargs):
        return self._chain(("run_commands", tuple(commands)))

    def add_local_file(self, local_path, remote_path, **_kwargs):
        return self._chain(("add_local_file", (str(local_path), str(remote_path))))

    def add_local_dir(self, local_path, remote_path, **_kwargs):
        return self._chain(("add_local_dir", (str(local_path), str(remote_path))))

    def env(self, variables, **_kwargs):
        return self._chain(("env", dict(variables)))

    # -- lecture pratique dans les tests ---------------------------------
    def commands(self):
        found = []
        for kind, payload in self.ops:
            if kind == "run_commands":
                found.extend(payload)
        return found

    def pip_requirement_commands(self):
        return [c for c in self.commands() if c.startswith("pip install -r ")]

    def local_files(self):
        return [payload for kind, payload in self.ops if kind == "add_local_file"]

    def env_vars(self):
        merged = {}
        for kind, payload in self.ops:
            if kind == "env":
                merged.update(payload)
        return merged


@pytest.fixture
def image_module(monkeypatch):
    """Charge ``tools/comfych/image.py`` avec un faux ``modal`` et ``plugins``."""
    modal_module = types.ModuleType("modal")
    modal_module.Image = FakeImage
    monkeypatch.setitem(sys.modules, "modal", modal_module)

    # ``plugins`` est dans tools/comfych : version réelle (aucune dépendance).
    sys.modules.pop("plugins", None)
    sys.path.insert(0, str(COMFYCH_DIR))
    try:
        plugins_module = types.ModuleType("plugins")
        plugins_module.comfy_plugins = []
        plugins_module.comfy_plugins_ext = []
        monkeypatch.setitem(sys.modules, "plugins", plugins_module)

        spec = importlib.util.spec_from_file_location(
            "holaf_comfych_image_under_test", IMAGE_PATH
        )
        module = importlib.util.module_from_spec(spec)
        monkeypatch.setitem(sys.modules, spec.name, module)
        spec.loader.exec_module(module)
    finally:
        try:
            sys.path.remove(str(COMFYCH_DIR))
        except ValueError:  # pragma: no cover
            pass
    return module


@pytest.fixture
def fake_tree(tmp_path):
    """Fausse installation : ``custom_nodes/<pack>`` + nodes voisins."""
    custom_nodes = tmp_path / "ComfyUI" / "custom_nodes"
    pack = custom_nodes / PACK_NAME
    (pack / "tools" / "comfych").mkdir(parents=True)
    (pack / "requirements.txt").write_text("watchdog>=3.0.0\naiohttp>=3.9.0\n")

    def _node(name, requirements=None):
        node_dir = custom_nodes / name
        node_dir.mkdir(parents=True, exist_ok=True)
        if requirements is not None:
            (node_dir / "requirements.txt").write_text(requirements)
        return node_dir

    _node("ComfyUI-Impact-Pack", "opencv-python-headless\n")
    _node("ComfyUI-GGUF", "gguf>=0.10.0\n")
    _node("RES4LYF", "PyWavelets\n")
    _node("sans-requirements")  # dossier sans requirements.txt → ignoré
    (custom_nodes / ".cache").mkdir()  # dossier caché → ignoré
    (custom_nodes / "__pycache__").mkdir()  # dossier technique → ignoré
    return types.SimpleNamespace(
        base=tmp_path,
        custom_nodes=custom_nodes,
        pack=pack,
        code=pack / "tools" / "comfych",
    )


# ---------------------------------------------------------------------------
# §1 Détection > 0 sur une arborescence factice
# ---------------------------------------------------------------------------
def test_detection_finds_nodes_in_fake_tree(image_module, fake_tree):
    """MUTANT « détection retourne 0 en dur » : rouge.

    C'était le bug réel : 0 node détecté alors que ``custom_nodes`` était peuplé.
    """
    entries = image_module._requirements_entries(
        pack_dir=fake_tree.pack, custom_nodes_dir=fake_tree.custom_nodes
    )
    names = [entry["name"] for entry in entries]

    assert len(entries) > 1, f"aucun custom node détecté (reçu {names})"
    assert names[0] == PACK_NAME, f"le pack doit être en tête (reçu {names})"
    assert set(names[1:]) == {"ComfyUI-GGUF", "ComfyUI-Impact-Pack", "RES4LYF"}, names
    assert all(entry["path"].is_file() for entry in entries)


def test_custom_nodes_dir_is_resolved_two_levels_above_code(image_module, fake_tree):
    """``custom_nodes`` est DEUX niveaux au-dessus de ``tools/comfych``.

    Le bug venait de ``root_dir.parent`` (= ``<pack>/tools``) : un dossier qui
    existe toujours mais ne contient aucun custom node.
    """
    candidates = image_module.custom_nodes_dir_candidates(fake_tree.pack)
    assert fake_tree.custom_nodes in candidates, candidates
    assert fake_tree.code.parent not in candidates, (
        "MUTANT « <pack>/tools » : le dossier du code ne doit jamais être scanné"
    )
    assert image_module.local_custom_nodes_dir(fake_tree.pack) == (
        fake_tree.custom_nodes.resolve()
    )


def test_custom_nodes_dir_override_by_env(image_module, fake_tree, monkeypatch, tmp_path):
    """``COMFYCH_CUSTOM_NODES_DIR`` gagne (installation hors ComfyUI)."""
    other = tmp_path / "ailleurs"
    (other / "node-x").mkdir(parents=True)
    (other / "node-x" / "requirements.txt").write_text("six\n")
    monkeypatch.setenv("COMFYCH_CUSTOM_NODES_DIR", str(other))

    entries = image_module._requirements_entries(pack_dir=fake_tree.pack)
    assert [e["name"] for e in entries] == [PACK_NAME, "node-x"], entries


def test_scan_never_leaks_outside_a_custom_nodes_dir(image_module, tmp_path):
    """Un pack hors ComfyUI ne fait pas scanner son dossier parent.

    Sans le filtre de nom, un pack installé dans ``/projects/ComfyUI-AI-Helper``
    ferait installer les ``requirements.txt`` de projets voisins.
    """
    pack = tmp_path / "projets" / PACK_NAME
    pack.mkdir(parents=True)
    (pack / "requirements.txt").write_text("watchdog\n")
    (tmp_path / "projets" / "autre-projet").mkdir()
    (tmp_path / "projets" / "autre-projet" / "requirements.txt").write_text("django\n")

    entries = image_module._requirements_entries(pack_dir=pack)
    assert [e["name"] for e in entries] == [PACK_NAME], entries


# ---------------------------------------------------------------------------
# §2 Le requirements du PACK est toujours inclus, en PREMIER
# ---------------------------------------------------------------------------
def test_pack_requirements_always_included_even_without_discovery(
    image_module, fake_tree, monkeypatch
):
    """MUTANT « requirements du pack non installés » : rouge.

    Découverte en échec (dossier introuvable) → le pack doit quand même être
    installé, sinon l'import du pack échoue sur le worker et TOUS ses nodes
    disparaissent de ComfyUI.
    """
    monkeypatch.delenv("COMFYCH_CUSTOM_NODES_DIR", raising=False)
    isolated_pack = fake_tree.base / "isole" / PACK_NAME
    isolated_pack.mkdir(parents=True)
    (isolated_pack / "requirements.txt").write_text("watchdog>=3.0.0\n")

    assert image_module.local_custom_nodes_dir(isolated_pack) is None
    entries = image_module._requirements_entries(pack_dir=isolated_pack)

    assert len(entries) == 1, entries
    assert entries[0]["name"] == PACK_NAME
    assert entries[0]["is_pack"] is True


def test_pack_is_first_and_never_excluded_from_deps(image_module, fake_tree):
    """Le pack n'est pas exclu de l'installation : il est installé EN PREMIER.

    (L'exclusion du pack qui existe pour l'ARCHIVE des nodes — sync.py — ne doit
    pas s'appliquer ici : le pack a besoin de ses propres dépendances.)
    """
    entries = image_module._requirements_entries(
        pack_dir=fake_tree.pack, custom_nodes_dir=fake_tree.custom_nodes
    )
    assert entries[0]["is_pack"] is True
    assert entries[0]["name"] == PACK_NAME
    # Dédoublonné : une seule entrée pour le pack, même s'il est dans custom_nodes.
    assert sum(1 for e in entries if e["is_pack"]) == 1


# ---------------------------------------------------------------------------
# §3 ``watchdog`` (dépendance du pack) est dans les installations calculées
# ---------------------------------------------------------------------------
def test_watchdog_is_installed_by_the_build(image_module):
    """MUTANT « watchdog absent de la liste » : rouge (bug vécu sur le worker).

    On construit l'image avec le VRAI pack du dépôt : la commande
    ``pip install -r /deps/ComfyUI-AI-Helper/requirements.txt`` doit exister et
    le fichier visé doit contenir ``watchdog``.
    """
    image = image_module._build_image()
    requirement_commands = image.pip_requirement_commands()

    pack_command = next(
        (cmd for cmd in requirement_commands if f"/deps/{PACK_NAME}/" in cmd), None
    )
    assert pack_command is not None, (
        "MUTANT « requirements du pack AI-Helper non installés » : "
        f"commandes vues = {requirement_commands}"
    )
    assert requirement_commands[0] == pack_command, (
        "le pack doit être installé en PREMIER (ses dépendances conditionnent "
        f"le chargement de tous ses nodes) : {requirement_commands}"
    )

    pack_requirements = PACKAGE_DIR / "requirements.txt"
    content = pack_requirements.read_text(encoding="utf-8")
    assert "watchdog" in content, (
        "le requirements.txt du pack doit lister watchdog (import direct de "
        "holaf_image_viewer_backend/worker.py)"
    )


def test_every_detected_node_gets_its_own_pip_layer(image_module, fake_tree, monkeypatch):
    """Chaque node détecté → une couche ``pip install -r`` séparée (cache Modal)."""
    monkeypatch.setattr(image_module, "PACK_DIR", fake_tree.pack, raising=True)
    monkeypatch.setattr(
        image_module, "root_dir", fake_tree.code.parent.parent, raising=True
    )
    image = image_module._build_image()
    commands = image.pip_requirement_commands()

    for name in ("ComfyUI-Impact-Pack", "ComfyUI-GGUF", "RES4LYF"):
        assert any(f"/deps/{name}/requirements.txt" in cmd for cmd in commands), (
            f"dépendances de {name} absentes : {commands}"
        )
    # Une couche PIP par requirements : c'est ce qui garde le cache par node.
    assert len(commands) == 4, commands


# ---------------------------------------------------------------------------
# §4 Un requirements en échec ne casse jamais le build
# ---------------------------------------------------------------------------
def test_failing_requirements_never_breaks_the_build(image_module, fake_tree, monkeypatch):
    """MUTANT « échec d'un requirements = build cassé » : rouge.

    ``pip install`` est toujours suffixé d'un ``echo`` (code de retour 0) ET le
    nom du node fautif apparaît dans le log : sans ça, l'utilisateur ne voit
    qu'un ``ModuleNotFoundError`` opaque dans le log du worker.
    """
    monkeypatch.setattr(image_module, "PACK_DIR", fake_tree.pack, raising=True)
    monkeypatch.setattr(
        image_module, "root_dir", fake_tree.code.parent.parent, raising=True
    )
    image = image_module._build_image()

    for command in image.pip_requirement_commands():
        assert "|| echo" in command, f"un échec pip casserait le build : {command}"
        node = command.split("/deps/")[1].split("/")[0]
        assert node in command.split("||", 1)[1], (
            f"l'échec doit nommer le node ({node}) dans le log : {command}"
        )


def test_unreadable_requirements_does_not_raise(image_module, fake_tree, monkeypatch):
    """``add_local_file`` qui lève (fichier disparu) → build poursuivi."""
    monkeypatch.setattr(image_module, "PACK_DIR", fake_tree.pack, raising=True)
    monkeypatch.setattr(
        image_module, "root_dir", fake_tree.code.parent.parent, raising=True
    )

    real_add_local_file = FakeImage.add_local_file

    def _boom(self, local_path, remote_path, **kwargs):
        if "GHUF" in str(local_path) or "GGUF" in str(local_path):
            raise OSError("fichier disparu entre le scan et le build")
        return real_add_local_file(self, local_path, remote_path, **kwargs)

    monkeypatch.setattr(FakeImage, "add_local_file", _boom)
    image = image_module._build_image()  # ne lève pas
    commands = image.pip_requirement_commands()
    assert not any("ComfyUI-GGUF" in cmd for cmd in commands), commands
    assert any("RES4LYF" in cmd for cmd in commands), commands


# ---------------------------------------------------------------------------
# §5 Empreinte de déploiement : anti « Deployment skipped »
# ---------------------------------------------------------------------------
def test_fingerprint_is_stable_when_nothing_changes(image_module, fake_tree):
    """Sans changement, l'empreinte ne bouge pas (pas de rebuild inutile)."""
    first = image_module.deploy_stamp(
        pack_dir=fake_tree.pack,
        custom_nodes_dir=fake_tree.custom_nodes,
        extra_packages=["sageattention"],
        force_token="",
    )
    second = image_module.deploy_stamp(
        pack_dir=fake_tree.pack,
        custom_nodes_dir=fake_tree.custom_nodes,
        extra_packages=["sageattention"],
        force_token="",
    )
    assert first == second, "empreinte instable : rebuild à chaque déploiement"
    assert len(first) == 16, first


@pytest.mark.parametrize(
    "mutation",
    ["extra_pip", "requirements_content", "new_node", "pack_requirements", "force"],
)
def test_fingerprint_changes_when_dependencies_change(
    image_module, fake_tree, mutation
):
    """MUTANT « skip malgré un changement de deps » : rouge.

    L'empreinte entre dans la définition de l'image : c'est le SEUL moyen de
    empêcher ``modal deploy`` de répondre « Deployment skipped: no changes
    detected » (aucun flag ``--force`` n'existe).
    """
    baseline = image_module.deploy_stamp(
        pack_dir=fake_tree.pack,
        custom_nodes_dir=fake_tree.custom_nodes,
        extra_packages=["sageattention"],
        force_token="",
    )

    extra_packages = ["sageattention"]
    force_token = ""
    if mutation == "extra_pip":
        extra_packages = ["sageattention", "mediapipe"]
    elif mutation == "requirements_content":
        (fake_tree.custom_nodes / "ComfyUI-GGUF" / "requirements.txt").write_text(
            "gguf>=0.12.0\n"
        )
    elif mutation == "new_node":
        new_node = fake_tree.custom_nodes / "ComfyUI-KJNodes"
        new_node.mkdir()
        (new_node / "requirements.txt").write_text("sageattention\n")
    elif mutation == "pack_requirements":
        (fake_tree.pack / "requirements.txt").write_text(
            "watchdog>=3.0.0\nopencv-python-headless\n"
        )
    elif mutation == "force":
        force_token = "reconstruction-forcée"

    changed = image_module.deploy_stamp(
        pack_dir=fake_tree.pack,
        custom_nodes_dir=fake_tree.custom_nodes,
        extra_packages=extra_packages,
        force_token=force_token,
    )
    assert changed != baseline, f"changement non détecté ({mutation})"


def test_force_token_comes_from_environment(image_module, monkeypatch):
    """Le bouton « Forcer » passe par ``COMFYCH_DEPLOY_FORCE_TOKEN``."""
    monkeypatch.delenv("COMFYCH_DEPLOY_FORCE_TOKEN", raising=False)
    monkeypatch.delenv("COMFYCH_FORCE_DEPLOY", raising=False)
    assert image_module._force_token() == ""

    monkeypatch.setenv("COMFYCH_DEPLOY_FORCE_TOKEN", "jeton-123")
    assert image_module._force_token() == "jeton-123"

    monkeypatch.delenv("COMFYCH_DEPLOY_FORCE_TOKEN")
    monkeypatch.setenv("COMFYCH_FORCE_DEPLOY", "1")
    assert image_module._force_token(), "COMFYCH_FORCE_DEPLOY=1 doit forcer"


def test_force_token_makes_the_stamp_unique(image_module, fake_tree):
    """Deux forces successives → deux empreintes (deux reconstructions)."""
    kwargs = {"pack_dir": fake_tree.pack, "custom_nodes_dir": fake_tree.custom_nodes}
    first = image_module.deploy_stamp(extra_packages=[], force_token="a", **kwargs)
    second = image_module.deploy_stamp(extra_packages=[], force_token="b", **kwargs)
    assert first != second


# ---------------------------------------------------------------------------
# §6 L'empreinte est la DERNIÈRE couche (cache Modal préservé)
# ---------------------------------------------------------------------------
def test_stamp_layer_is_last_and_after_pip_installs(image_module, fake_tree, monkeypatch):
    """``add_local_python_source``/``env`` ne doivent pas précéder les pip.

    Une couche d'empreinte posée AVANT les ``pip install`` réexécuterait toutes
    les couches suivantes à chaque déploiement (cache perdu).
    """
    monkeypatch.setattr(image_module, "PACK_DIR", fake_tree.pack, raising=True)
    monkeypatch.setattr(
        image_module, "root_dir", fake_tree.code.parent.parent, raising=True
    )
    image = image_module._build_image()
    kinds = [kind for kind, _payload in image.ops]

    assert kinds[-1] == "env", f"l'empreinte doit être la dernière couche : {kinds}"
    assert image.env_vars().get("COMFYCH_DEPLOY_STAMP"), image.env_vars()

    last_pip = max(
        index
        for index, (kind, payload) in enumerate(image.ops)
        if kind == "run_commands"
        and any(str(c).startswith("pip install") for c in payload)
    )
    assert last_pip < len(kinds) - 1, "les pip doivent précéder l'empreinte"
