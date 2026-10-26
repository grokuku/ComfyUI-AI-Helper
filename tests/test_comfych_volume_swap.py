# ─────────────────────────────────────────────────────────────────────────
# ComfyCH — swap NON DESTRUCTIF du volume custom_nodes + sélection des nodes.
#
# Deux régressions réelles, constatées en production :
#
#  1. « ComfyCH n'existe plus » sur le volume après un sync. L'ancien
#     ``_swap_volume_content`` (sync.py) SUPPRIMAIT tout le contenu de
#     ``/custom_nodes`` (``shutil.rmtree`` + ``os.remove``) AVANT d'installer le
#     nouveau : un échec au milieu du swap (quota, disque plein, container tué)
#     laissait le volume VIDE ou partiel — et Modal persiste l'état au moment où
#     le container s'arrête, donc la perte était DÉFINITIVE.
#  2. Un dossier de ``custom_nodes/`` SANS ``__init__.py`` (ex. le dossier
#     ``ComfyCH`` de l'utilisateur, dont le ``__init__.py`` avait été retiré
#     volontairement pour que ComfyUI ne le charge pas) était traité comme un
#     custom node, archivé et poussé sur le volume — alors que ComfyUI ne peut
#     pas le charger.
#
# Ce que ce fichier verrouille (chaque point a son mutant) :
#   §1 sélection : un dossier sans ``__init__.py`` (ou désactivé par suffixe) est
#      EXCLU et la raison est explicite — MUTANT « dossier sans __init__.py
#      inclus » → ROUGE ;
#   §2 le PACK AI-Helper est INCLUS (source de vérité = le volume) mais son
#      sous-package ``tools/comfych`` n'est JAMAIS archivé — MUTANT
#      « auto-archivage du gateway » → ROUGE ;
#   §3 swap : l'ancien contenu part dans ``.backup`` (renommé, jamais supprimé
#      avant la fin) et le nouveau est installé — MUTANT « suppression avant
#      extraction » → ROUGE ;
#   §4 échec du swap → RESTAURATION complète, volume inchangé — MUTANT
#      « pas de restauration » → ROUGE ;
#   §5 sauvegarde incomplète (swap interrompu) jamais écrasée ;
#   §6 archive tronquée/vide → refusée AVANT de toucher au volume (volume
#      intact, aucun ``commit()``).
#
# Usage :
#   PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
#   pytest tests/test_comfych_volume_swap.py
# ─────────────────────────────────────────────────────────────────────────
import importlib.util
import io
import json
import sys
import tarfile
import types
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
COMFYCH_DIR = PACKAGE_DIR / "tools" / "comfych"
SYNC_FILE = COMFYCH_DIR / "sync.py"

_LOCAL_MODULE_NAMES = ("comfych_paths", "helpers", "models", "comfych_store")


# ---------------------------------------------------------------------------
# Chargement du module réel ``sync.py`` (les paquets pip ``modal`` est absent)
# ---------------------------------------------------------------------------
class _FakeImage:
    def add_local_python_source(self, *a, **k):
        return self

    def apt_install(self, *a, **k):
        return self

    def pip_install(self, *a, **k):
        return self


class _FakeVolume:
    commits = 0

    @classmethod
    def from_name(cls, *a, **k):
        return cls()

    def batch_upload(self, *a, **k):
        raise AssertionError("aucun upload attendu dans ces tests")

    def commit(self):
        type(self).commits += 1


class _FakeApp:
    def __init__(self, *a, **k):
        pass

    def function(self, *a, **k):
        return lambda fn: fn

    def local_entrypoint(self, *a, **k):
        return lambda fn: fn


class _FakeSecret:
    def hydrate(self):
        return None


@pytest.fixture
def clean_module_cache():
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
    modal_stub = types.ModuleType("modal")
    modal_stub.Image = types.SimpleNamespace(debian_slim=lambda **k: _FakeImage())
    modal_stub.App = _FakeApp
    modal_stub.Volume = _FakeVolume
    modal_stub.Secret = types.SimpleNamespace(
        from_name=lambda *a, **k: _FakeSecret(),
        from_dict=lambda *a, **k: _FakeSecret(),
    )
    modal_stub.exception = types.SimpleNamespace(NotFoundError=RuntimeError)
    monkeypatch.setitem(sys.modules, "modal", modal_stub)

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

    spec = importlib.util.spec_from_file_location("comfych_sync_swap_test", SYNC_FILE)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, "comfych_sync_swap_test", module)
    spec.loader.exec_module(module)
    _FakeVolume.commits = 0
    return module


# ---------------------------------------------------------------------------
# Arborescences de test
# ---------------------------------------------------------------------------
def _make_node(root: Path, name: str, *, init=True, marker="code"):
    """Crée un faux node (``__init__.py`` + un fichier de code)."""
    node = root / name
    node.mkdir(parents=True, exist_ok=True)
    if init:
        (node / "__init__.py").write_text("# node\n", encoding="utf-8")
    (node / "marker.txt").write_text(marker, encoding="utf-8")
    return node


def _make_custom_nodes(tmp_path: Path) -> Path:
    """Faux ``custom_nodes/`` reproduisant la situation réelle de l'utilisateur."""
    root = tmp_path / "ComfyUI" / "custom_nodes"
    root.mkdir(parents=True)

    # Le pack : un vrai node (``__init__.py``) avec le gateway dans tools/.
    pack = _make_node(root, "ComfyUI-AI-Helper")
    (pack / "nodes").mkdir()
    (pack / "nodes" / "aih_enhancer.py").write_text("# node\n", encoding="utf-8")
    gateway = pack / "tools" / "comfych"
    gateway.mkdir(parents=True)
    (gateway / "__init__.py").write_text("# gateway\n", encoding="utf-8")
    (gateway / "sync.py").write_text("# sync\n", encoding="utf-8")
    (gateway / "config.json").write_text('{"api_key": "secret"}', encoding="utf-8")

    _make_node(root, "ComfyUI-GGUF")
    # Le dossier ComfyCH de l'utilisateur : __init__.py RETIRÉ volontairement.
    left_over = _make_node(root, "ComfyCH", init=False)
    (left_over / "config.json").write_text("{}", encoding="utf-8")
    # Node désactivé par suffixe.
    _make_node(root, "ComfyUI-Old.disabled")
    # Données ComfyUI + bookkeeping du volume : jamais des nodes.
    (root / "user").mkdir()
    (root / ".staging").mkdir()
    return root


def _node_dir_names(root: Path) -> list[str]:
    """Noms des dossiers qui SONT des nodes (ni internes, ni cachés)."""
    return sorted(
        p.name for p in Path(root).iterdir()
        if p.is_dir() and not p.name.startswith((".", "_"))
    )


def _fake_custom_nodes_vol(monkeypatch, tmp_path) -> Path:
    """Faux volume ``/custom_nodes`` sur disque + ``commit()`` espionné."""
    volume = tmp_path / "volume"
    volume.mkdir()
    return volume


# ═════════════════ §1. Sélection des nodes (``__init__.py`` requis) ═════════


class TestNodeSelection:
    def test_directory_without_init_is_not_a_node(self, sync_module, tmp_path):
        """MUTANT : un dossier sans ``__init__.py`` inclus → ROUGE."""
        root = _make_custom_nodes(tmp_path)

        reason = sync_module._node_skip_reason("ComfyCH", root / "ComfyCH")

        assert reason is not None, "un dossier sans __init__.py n'est pas un node"
        assert "__init__.py" in reason
        assert "custom node" in reason

    def test_disabled_suffixes_are_excluded(self, sync_module, tmp_path):
        root = _make_custom_nodes(tmp_path)

        reason = sync_module._node_skip_reason(
            "ComfyUI-Old.disabled", root / "ComfyUI-Old.disabled"
        )

        assert reason is not None
        assert "désactivé" in reason
        assert ".disabled" in reason

    def test_pack_is_kept_and_its_reason_is_none(self, sync_module, tmp_path):
        """MUTANT (l'ancienne règle) : pack exclu « déjà dans l'image » → ROUGE.

        Le pack N'EST PAS dans l'image (seuls ses ``requirements.txt`` y sont) :
        l'exclure de l'archive le rendait absent partout sur le worker.
        """
        root = _make_custom_nodes(tmp_path)

        assert sync_module._node_skip_reason(
            "ComfyUI-AI-Helper", root / "ComfyUI-AI-Helper"
        ) is None

    def test_gateway_code_dir_itself_is_never_a_node(self, sync_module, tmp_path):
        """Une installation ComfyCH AUTONOME (code du gateway) n'est pas un node."""
        _make_custom_nodes(tmp_path)
        gateway = tmp_path / "ComfyUI" / "custom_nodes" / "ComfyCH-standalone"
        gateway.mkdir()
        (gateway / "__init__.py").write_text("# gateway\n", encoding="utf-8")

        assert sync_module._node_skip_reason("ComfyCH-standalone", gateway) is None
        # Le code du gateway, lui, est exclu.
        import os
        os.rename(gateway, tmp_path / "moved")
        moved = tmp_path / "moved"
        original = sync_module.GATEWAY_CODE_DIR
        try:
            sync_module.GATEWAY_CODE_DIR = moved.resolve()
            reason = sync_module._node_skip_reason("moved", moved)
        finally:
            sync_module.GATEWAY_CODE_DIR = original
        assert reason is not None and "gateway" in reason

    def test_selection_keeps_only_real_nodes(self, sync_module, tmp_path, capsys):
        root = _make_custom_nodes(tmp_path)

        kept, skipped = sync_module._select_node_dirs(root)

        names = sorted(Path(d).name for d in kept)
        assert names == ["ComfyUI-AI-Helper", "ComfyUI-GGUF"]
        reasons = dict(skipped)
        assert "ComfyCH" in reasons and "__init__.py" in reasons["ComfyCH"]
        assert "user" in reasons
        assert ".staging" in reasons
        assert "ComfyUI-Old.disabled" in reasons

    def test_selection_logs_the_exclusion_of_the_emptied_folder(
        self, sync_module, tmp_path
    ):
        """Le log doit dire POURQUOI ComfyCH n'est plus poussé (pas de mystère)."""
        root = _make_custom_nodes(tmp_path)

        _kept, skipped = sync_module._select_node_dirs(root)

        assert ("ComfyCH", "pas de __init__.py — pas un custom node") in skipped


# ═════ §2. Le gateway ne s'archive jamais lui-même (``tools/comfych``) ══════


class TestGatewayNeverArchived:
    def test_tools_comfych_is_pruned_from_the_pack_archive(
        self, sync_module, tmp_path, monkeypatch
    ):
        """MUTANT « auto-archivage du gateway » → ROUGE."""
        root = _make_custom_nodes(tmp_path)
        pack = root / "ComfyUI-AI-Helper"
        monkeypatch.setattr(
            sync_module, "GATEWAY_CODE_DIR", (pack / "tools" / "comfych").resolve()
        )
        archive = tmp_path / "nodes.tar.gz"

        stats = sync_module._build_custom_nodes_archive([pack], archive)

        with tarfile.open(archive, "r:gz") as tar:
            members = tar.getnames()
        assert members, "l'archive doit contenir le node"
        assert "ComfyUI-AI-Helper/__init__.py" in members
        assert "ComfyUI-AI-Helper/nodes/aih_enhancer.py" in members
        assert not [m for m in members if "tools/comfych" in m], (
            "le code du gateway (et sa config locale) ne doit JAMAIS partir "
            f"dans le volume : {members}"
        )
        assert stats["skipped_gateway_dir"] == "comfych"
        lines = sync_module._archive_exclusion_summary_lines(stats)
        assert any("code du gateway" in line for line in lines)

    def test_mutant_without_pruning_leaks_the_gateway(
        self, sync_module, tmp_path, monkeypatch
    ):
        """MUTANT : gateway pointé ailleurs → le code part dans l'archive."""
        root = _make_custom_nodes(tmp_path)
        pack = root / "ComfyUI-AI-Helper"
        monkeypatch.setattr(sync_module, "GATEWAY_CODE_DIR", tmp_path / "ailleurs")
        archive = tmp_path / "mutant.tar.gz"

        sync_module._build_custom_nodes_archive([pack], archive)

        with tarfile.open(archive, "r:gz") as tar:
            members = tar.getnames()
        assert [m for m in members if "tools/comfych/sync.py" in m], (
            "sans élagage, le gateway fuit : c'est ce que le test précédent interdit"
        )


# ═════════════ §3/§4/§5. Swap non destructif, sauvegarde, restauration ══════


def _volume_with_nodes(volume: Path):
    _make_node(volume, "ComfyUI-GGUF", marker="ancien-gguf")
    _make_node(volume, "ComfyUI-Old", marker="ancien-old")
    (volume / "_upload").mkdir()
    (volume / "_upload" / "archive.tar.gz").write_bytes(b"x")
    (volume / ".nodes_manifest.json").write_text('{"nodes": []}', encoding="utf-8")
    return volume


def _staging_with_nodes(staging: Path):
    _make_node(staging, "ComfyUI-GGUF", marker="nouveau-gguf")
    _make_node(staging, "ComfyUI-AI-Helper", marker="nouveau-pack")
    return staging


class TestSwapVolumeContent:
    def test_swap_installs_new_content_and_keeps_the_old_one_in_backup(
        self, sync_module, tmp_path
    ):
        volume = _volume_with_nodes(tmp_path / "volume")
        staging = _staging_with_nodes(tmp_path / "staging")

        nodes = sync_module._swap_volume_content(str(volume), str(staging))

        assert nodes == ["ComfyUI-AI-Helper", "ComfyUI-GGUF"]
        assert (volume / "ComfyUI-GGUF" / "marker.txt").read_text() == "nouveau-gguf"
        assert not (volume / "ComfyUI-Old").exists()
        # Contenu précédent conservé (génération de secours), pas supprimé.
        backup = volume / ".backup"
        assert (backup / "ComfyUI-Old" / "marker.txt").read_text() == "ancien-old"
        assert (backup / "ComfyUI-GGUF" / "marker.txt").read_text() == "ancien-gguf"
        marker = json.loads((backup / ".complete").read_text())
        assert marker["complete"] is True
        assert sorted(marker["entries"]) == ["ComfyUI-GGUF", "ComfyUI-Old"]
        # Entrées internes préservées.
        assert (volume / "_upload" / "archive.tar.gz").is_file()
        assert (volume / ".nodes_manifest.json").is_file()
        assert not staging.exists()

    def test_staging_is_installed_before_old_content_disappears(
        self, sync_module, tmp_path, monkeypatch
    ):
        """MUTANT « suppression avant extraction » : le contenu ancien doit
        être RENOMMÉ (donc encore présent) quand l'installation commence."""
        volume = _volume_with_nodes(tmp_path / "volume")
        staging = _staging_with_nodes(tmp_path / "staging")
        observed = []
        real_move = sync_module._move_path

        def spy(src, dst):
            if Path(dst).parent == volume and not str(dst).startswith(str(volume / ".backup")):
                observed.append({
                    "backup_exists": (volume / ".backup" / "ComfyUI-Old").is_dir(),
                    "old_still_present": (volume / "ComfyUI-Old").is_dir(),
                })
            real_move(src, dst)

        monkeypatch.setattr(sync_module, "_move_path", spy)

        sync_module._swap_volume_content(str(volume), str(staging))

        assert observed, "aucune installation observée"
        assert all(item["backup_exists"] for item in observed), (
            "l'ancien contenu doit être sauvegardé AVANT d'installer le nouveau"
        )
        assert not any(item["old_still_present"] for item in observed), (
            "l'ancien contenu doit avoir été retiré (renommé) avant l'installation"
        )

    def test_failed_swap_restores_the_previous_content(self, sync_module, tmp_path, monkeypatch):
        """MUTANT « pas de restauration » → ROUGE : le volume doit être intact."""
        volume = _volume_with_nodes(tmp_path / "volume")
        staging = _staging_with_nodes(tmp_path / "staging")
        real_move = sync_module._move_path

        def flaky(src, dst):
            if Path(src).parent == staging and Path(src).name == "ComfyUI-AI-Helper":
                raise OSError("disque plein (simulé)")
            real_move(src, dst)

        monkeypatch.setattr(sync_module, "_move_path", flaky)

        with pytest.raises(RuntimeError) as excinfo:
            sync_module._swap_volume_content(str(volume), str(staging))

        assert "restauré" in str(excinfo.value)
        # Volume STRICTEMENT comme avant : les deux nodes, aucun partiel.
        assert _node_dir_names(volume) == ["ComfyUI-GGUF", "ComfyUI-Old"]
        assert (volume / "ComfyUI-Old" / "marker.txt").read_text() == "ancien-old"
        assert (volume / "ComfyUI-GGUF" / "marker.txt").read_text() == "ancien-gguf"
        assert not (volume / "ComfyUI-AI-Helper").exists(), "installation partielle retirée"
        assert not (volume / ".backup").exists(), "sauvegarde vidée par la restauration"

    def test_incomplete_backup_is_never_overwritten(self, sync_module, tmp_path):
        """Une sauvegarde d'un swap INTERROMPU est le seul exemplaire : on refuse."""
        volume = _volume_with_nodes(tmp_path / "volume")
        staging = _staging_with_nodes(tmp_path / "staging")
        backup = volume / ".backup"
        backup.mkdir()
        (backup / "ComfyUI-Previous").mkdir()
        (backup / "ComfyUI-Previous" / "marker.txt").write_text("précieux")

        with pytest.raises(RuntimeError) as excinfo:
            sync_module._swap_volume_content(str(volume), str(staging))

        assert "INCOMPLÈTE" in str(excinfo.value)
        assert (backup / "ComfyUI-Previous" / "marker.txt").read_text() == "précieux"
        assert (volume / "ComfyUI-Old").is_dir(), "le volume n'a pas été touché"

    def test_backup_retention_is_exactly_one_generation(self, sync_module, tmp_path):
        """RÉTENTION : le 2e swap REMPLACE la sauvegarde (une seule génération).

        MUTANT « sauvegarde jamais remplacée » → ROUGE : chaque sync empilerait
        une copie complète des nodes et le volume finirait plein. La règle est
        « un retour arrière possible = le sync précédent », pas plus.
        """
        volume = _volume_with_nodes(tmp_path / "volume")
        sync_module._swap_volume_content(
            str(volume), str(_staging_with_nodes(tmp_path / "staging1"))
        )
        second = _staging_with_nodes(tmp_path / "staging2")
        for name in ("ComfyUI-GGUF", "ComfyUI-AI-Helper"):
            (second / name / "marker.txt").write_text("generation-2", encoding="utf-8")

        sync_module._swap_volume_content(str(volume), str(second))

        backup = volume / ".backup"
        assert sorted(p.name for p in backup.iterdir() if p.is_dir()) == [
            "ComfyUI-AI-Helper", "ComfyUI-GGUF",
        ], "une seule génération conservée (aucun empilement)"
        assert (backup / "ComfyUI-GGUF" / "marker.txt").read_text() == "nouveau-gguf", (
            "la sauvegarde doit être celle du swap PRÉCÉDENT (génération 1)"
        )
        assert (volume / "ComfyUI-GGUF" / "marker.txt").read_text() == "generation-2"
        assert (volume / "ComfyUI-Old").exists() is False, "ancienne génération remplacée"
        marker = json.loads((backup / ".complete").read_text())
        assert marker["complete"] is True
        assert sorted(marker["entries"]) == ["ComfyUI-AI-Helper", "ComfyUI-GGUF"]

    def test_empty_staging_aborts_without_touching_the_volume(self, sync_module, tmp_path):
        volume = _volume_with_nodes(tmp_path / "volume")
        staging = tmp_path / "staging"
        staging.mkdir()

        with pytest.raises(ValueError):
            sync_module._swap_volume_content(str(volume), str(staging))

        assert (volume / "ComfyUI-Old").is_dir()
        assert (volume / "ComfyUI-GGUF").is_dir()


# ═════════ §6. Extraction : tar tronqué/corrompu = volume INTACT ════════════


def _write_tar(path: Path, entries):
    with tarfile.open(path, "w:gz") as tar:
        for name, payload in entries:
            data = payload.encode("utf-8")
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))


class TestExtractionSafety:
    def _prepare(self, sync_module, monkeypatch, tmp_path):
        volume = _volume_with_nodes(_fake_custom_nodes_vol(monkeypatch, tmp_path))
        monkeypatch.setattr(sync_module, "_CUSTOM_NODES_ROOT", str(volume))
        return volume

    def test_corrupt_archive_leaves_the_volume_untouched(
        self, sync_module, monkeypatch, tmp_path, capsys
    ):
        """MUTANT « suppression avant extraction » : volume vide → ROUGE."""
        volume = self._prepare(sync_module, monkeypatch, tmp_path)
        upload_dir = volume / "_upload"
        upload_dir.mkdir(exist_ok=True)
        archive = upload_dir / "tronque.tar.gz"
        _write_tar(archive, [("ComfyUI-GGUF/__init__.py", "# node\n")])
        archive.write_bytes(archive.read_bytes()[: 20])  # tronqué

        with pytest.raises((EOFError, OSError, tarfile.TarError, ValueError)):
            sync_module.extract_custom_nodes_from_volume("tronque.tar.gz")

        assert _node_dir_names(volume) == ["ComfyUI-GGUF", "ComfyUI-Old"]
        assert (volume / "ComfyUI-Old" / "marker.txt").read_text() == "ancien-old"
        assert _FakeVolume.commits == 0, "un échec ne doit jamais committer"
        assert "volume inchangé" in capsys.readouterr().out

    def test_empty_archive_is_refused(self, sync_module, monkeypatch, tmp_path):
        volume = self._prepare(sync_module, monkeypatch, tmp_path)
        upload_dir = volume / "_upload"
        upload_dir.mkdir(exist_ok=True)
        archive = upload_dir / "vide.tar.gz"
        _write_tar(archive, [])

        with pytest.raises(ValueError):
            sync_module.extract_custom_nodes_from_volume("vide.tar.gz")

        assert (volume / "ComfyUI-Old").is_dir()
        assert _FakeVolume.commits == 0

    def test_nominal_swap_writes_the_manifest_and_commits(
        self, sync_module, monkeypatch, tmp_path
    ):
        volume = self._prepare(sync_module, monkeypatch, tmp_path)
        upload_dir = volume / "_upload"
        upload_dir.mkdir(exist_ok=True)
        archive = upload_dir / "ok.tar.gz"
        _write_tar(archive, [
            ("ComfyUI-GGUF/__init__.py", "# node\n"),
            ("ComfyUI-AI-Helper/__init__.py", "# pack\n"),
            ("ComfyUI-AI-Helper/nodes/aih_enhancer.py", "# node\n"),
        ])

        result = sync_module.extract_custom_nodes_from_volume("ok.tar.gz")

        assert result["status"] == "ok"
        assert result["nodes"] == ["ComfyUI-AI-Helper", "ComfyUI-GGUF"]
        manifest = json.loads((volume / ".nodes_manifest.json").read_text())
        assert manifest["nodes"] == ["ComfyUI-AI-Helper", "ComfyUI-GGUF"]
        assert _FakeVolume.commits == 1
        assert (volume / ".backup" / "ComfyUI-Old").is_dir(), (
            "la génération précédente est conservée après un swap réussi"
        )
        assert not (upload_dir / "ok.tar.gz").exists(), "archive consommée"
