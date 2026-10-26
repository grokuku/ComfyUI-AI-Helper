"""Diagnostic « credentials » (worker Modal) — 2 lignes, ZÉRO fuite de clé.

CONTEXTE RÉEL (logs du worker) : les nodes AIH échouaient sur des URL relatives
(``Invalid URL '/keywords/llm-process': No scheme supplied``,
``Invalid URL '/styles': No scheme supplied``) parce que ``server_url`` et
``api_key`` étaient VIDES côté worker, alors que l'utilisateur les avait
renseignés dans Settings ▸ « AIH · Compte ». Le log ne permettait pas de
trancher entre trois causes très différentes :

  1. le fichier ``credentials.json`` n'est PAS dans le périmètre poussé par
     ``tools/comfych/sync.py`` (résolution de ``user/`` qui ne voit pas le
     fichier écrit par l'UI) ;
  2. il EST poussé mais le VOLUME garde une version périmée — piège Modal :
     ``batch_upload()`` refuse d'écraser un fichier existant (``force=False``)
     et l'ancien code comptait « already present » en silence ;
  3. il est correct et le problème est en aval (worker pas redémarré, URL…).

Ce fichier verrouille les deux lignes de diagnostic ajoutées :

  A. ``tools/comfych/sync.py::_credentials_sync_report`` — « 📁 user/ :
     N fichier(s), credentials.json présent=oui/non, server_url=<…>,
     api_key=<…> » (chemin relatif cité) ;
  B. ``aih/credentials.py::credentials_status_line`` — « credentials:
     server_url=<vide|renseignée> api_key=<vide|renseignée> (source: fichier
     …) », plus ``log_credentials_status`` qui l'écrit en INFO.

Garde-fou ABSOLU testé ici : AUCUNE des deux lignes ne contient la clé API
(elles partent dans un volume, puis dans le navigateur via le suivi de run).

Mutants (assertions qui deviennent ROUGES) :
  M1 ``batch_upload()`` sans ``force=True`` → le volume ne reçoit jamais la
     version remplie de ``credentials.json`` (assertion « force ») ;
  M2 la ligne de diagnostic affiche la VALEUR de la clé au lieu de sa présence
     (assertions « la clé n'apparaît pas ») ;
  M3 ``_credentials_sync_report`` ne regarde plus ``credentials.json`` et
     répond toujours « présent=non » (assertions « présent=oui »).

Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
"""

import importlib.util
import json
import logging
import sys
import types
from pathlib import Path

import pytest

PACK_DIR = Path(__file__).resolve().parent.parent
CREDENTIALS_FILE = PACK_DIR / "aih" / "credentials.py"
SYNC_FILE = PACK_DIR / "tools" / "comfych" / "sync.py"

# Clé factice : sa VALEUR ne doit jamais apparaître dans un log.
REAL_KEY = "aih_SECRET_0123456789abcdef"
SERVER_URL = "https://aih.test"


# ── A/B : chargement des modules RÉELS par chemin ───────────────────────


def _load_credentials_module():
    """Charge ``aih/credentials.py`` par chemin (aucune dépendance ComfyUI)."""
    spec = importlib.util.spec_from_file_location("aih_credentials_diag_test", CREDENTIALS_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def credentials_mod(tmp_path, monkeypatch):
    """Module réel, fichier de credentials isolé dans ``tmp_path``."""
    module = _load_credentials_module()
    monkeypatch.setattr(module, "_CREDENTIALS_PATH", str(tmp_path / "aih" / "credentials.json"))
    monkeypatch.setattr(module, "_CREDENTIALS_CACHE", None)
    return module


def _write(credentials_mod, payload):
    path = Path(credentials_mod.get_credentials_path())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    credentials_mod.invalidate_cache()
    return path


# ═══════════════ B. Ligne de diagnostic côté worker (démarrage) ═════════════


class TestWorkerStatusLine:
    def test_file_absent_says_absent_and_vide(self, credentials_mod):
        line = credentials_mod.credentials_status_line()

        assert line.startswith("credentials: "), line
        assert "server_url=vide" in line
        assert "api_key=vide" in line
        assert "ABSENT" in line, "un fichier absent doit être dit explicitement"
        assert str(Path(credentials_mod.get_credentials_path())) in line, \
            "le CHEMIN lu doit être cité (mauvaise résolution de user/ = cause n°1)"

    def test_empty_file_is_vide_not_absent(self, credentials_mod):
        path = _write(credentials_mod, {})

        line = credentials_mod.credentials_status_line()

        assert f"source: fichier {path}" in line
        assert "ABSENT" not in line, "le fichier existe : ne pas annoncer « ABSENT »"
        assert "server_url=vide" in line and "api_key=vide" in line

    def test_filled_file_is_renseignee(self, credentials_mod):
        _write(credentials_mod, {"server_url": SERVER_URL, "api_key": REAL_KEY,
                                 "updated_at": "2026-01-01T00:00:00Z"})

        line = credentials_mod.credentials_status_line()

        assert "server_url=renseignée" in line
        assert "api_key=renseignée" in line
        assert "ABSENT" not in line

    def test_masked_key_is_reported_as_ignored(self, credentials_mod):
        _write(credentials_mod, {"server_url": SERVER_URL,
                                 "api_key": "Clé masquée — clique sur « Régénérer »"})

        line = credentials_mod.credentials_status_line()

        assert "server_url=renseignée" in line
        assert "masquée" in line and "ignorée" in line, \
            "une valeur de masquage n'est pas une clé utilisable : le dire"

    @pytest.mark.parametrize("payload", [
        {"server_url": SERVER_URL, "api_key": REAL_KEY},
        {"server_url": "", "api_key": ""},
        {},
    ])
    def test_never_leaks_the_key(self, credentials_mod, payload):
        """MUTANT M2 : la ligne ne contient JAMAIS la valeur de la clé."""
        _write(credentials_mod, payload)

        line = credentials_mod.credentials_status_line()

        assert REAL_KEY not in line, "la clé API ne doit JAMAIS être journalisée"
        assert line.count("api_key=") == 1, "seule la PRÉSENCE est décrite"

    def test_log_status_line_is_written_at_info(self, credentials_mod, caplog):
        _write(credentials_mod, {"server_url": SERVER_URL, "api_key": REAL_KEY})

        with caplog.at_level(logging.INFO, logger=""):
            returned = credentials_mod.log_credentials_status()

        assert returned == credentials_mod.credentials_status_line()
        assert "credentials: server_url=renseignée" in caplog.text
        assert REAL_KEY not in caplog.text, "aucune fuite de clé dans les logs"

    def test_unreadable_file_does_not_raise(self, credentials_mod):
        path = Path(credentials_mod.get_credentials_path())
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{ pas du json", encoding="utf-8")
        credentials_mod.invalidate_cache()

        line = credentials_mod.credentials_status_line()

        assert "server_url=vide" in line and "api_key=vide" in line


# ═════════════ A. Ligne de diagnostic côté sync (périmètre poussé) ══════════


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
    uploads: list = []
    forces: list = []

    @classmethod
    def from_name(cls, *_a, **_k):
        return cls()

    def batch_upload(self, force=False):
        type(self).forces.append(bool(force))
        return _FakeBatchUpload(self.uploads)


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
    """Charge ``tools/comfych/sync.py`` avec ``modal``/``helpers``/``models`` stubbés."""
    uploads: list = []
    _FakeVolume.uploads = uploads
    _FakeVolume.forces = []

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

    config_file = tmp_path / "config.json"
    store_stub = types.ModuleType("comfych_store")
    store_stub.config_path = lambda: config_file
    monkeypatch.setitem(sys.modules, "comfych_store", store_stub)

    spec = importlib.util.spec_from_file_location("comfych_sync_credentials_test", SYNC_FILE)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, "comfych_sync_credentials_test", module)
    spec.loader.exec_module(module)
    return types.SimpleNamespace(module=module, uploads=uploads, forces=_FakeVolume.forces)


def _user_tree(tmp_path, credentials_rel=None, payload=None):
    """Faux ``<ComfyUI>/user`` : workflows + (éventuellement) credentials.json."""
    user_dir = tmp_path / "ComfyUI" / "user"
    (user_dir / "workflows").mkdir(parents=True)
    (user_dir / "workflows" / "wf.json").write_text("{}", encoding="utf-8")
    if credentials_rel:
        path = user_dir / credentials_rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload or {}, ensure_ascii=False), encoding="utf-8")
    return user_dir


class TestSyncReportLine:
    def test_present_and_filled_is_announced_with_relative_path(self, sync_module, tmp_path):
        module = sync_module.module
        user_dir = _user_tree(
            tmp_path,
            "default/AI-Helper/config/credentials.json",
            {"server_url": SERVER_URL, "api_key": REAL_KEY},
        )
        selected = module._select_user_setting_files(user_dir)

        lines = module._credentials_sync_report(user_dir, selected)

        assert len(lines) == 1, lines
        line = lines[0]
        assert line.startswith("📁 user/ :"), line
        assert f"{len(selected)} fichier(s)" in line
        assert "credentials.json présent=oui" in line
        assert str(Path("default") / "AI-Helper" / "config" / "credentials.json") in line
        assert "server_url=renseignée" in line and "api_key=renseignée" in line
        # MUTANT M2 : jamais la valeur de la clé.
        assert REAL_KEY not in line, "la clé ne doit JAMAIS apparaître dans le log de sync"

    def test_legacy_location_is_also_detected(self, sync_module, tmp_path):
        module = sync_module.module
        user_dir = _user_tree(
            tmp_path,
            "default/aih/credentials.json",
            {"server_url": SERVER_URL, "api_key": REAL_KEY},
        )

        line = module._credentials_sync_report(
            user_dir, module._select_user_setting_files(user_dir)
        )[0]

        assert "credentials.json présent=oui" in line
        assert "api_key=renseignée" in line

    def test_present_but_empty_points_at_the_right_field(self, sync_module, tmp_path):
        """Fichier poussé mais VIDE : le dire champ par champ (cause n°2)."""
        module = sync_module.module
        user_dir = _user_tree(tmp_path, "default/aih/credentials.json", {})

        lines = module._credentials_sync_report(
            user_dir, module._select_user_setting_files(user_dir)
        )

        assert "credentials.json présent=oui" in lines[0]
        assert "server_url=vide" in lines[0] and "api_key=vide" in lines[0]
        joined = "\n".join(lines)
        assert "server_url VIDE en local" in joined, "une aide explicite doit suivre"
        assert "api_key VIDE en local" in joined

    def test_absent_says_absent(self, sync_module, tmp_path):
        """MUTANT M3 : sans fichier, le diagnostic doit répondre « présent=non »."""
        module = sync_module.module
        user_dir = _user_tree(tmp_path)  # aucun credentials.json

        lines = module._credentials_sync_report(
            user_dir, module._select_user_setting_files(user_dir)
        )

        assert len(lines) == 1
        assert "credentials.json présent=non" in lines[0]
        assert "server_url=" not in lines[0] and "api_key=" not in lines[0], \
            "sans fichier, parler de champs vides serait trompeur"

    def test_untouched_perimeter_still_includes_credentials(self, sync_module, tmp_path):
        """Le fichier EST dans le périmètre : sinon le diagnostic mentirait."""
        module = sync_module.module
        user_dir = _user_tree(tmp_path, "default/AI-Helper/config/credentials.json", {})

        selected = module._select_user_setting_files(user_dir)

        assert any(Path(p).name == "credentials.json" for p in selected)


class TestSyncUploadsWithForce:
    def test_user_settings_upload_overwrites_existing_volume_files(
        self, sync_module, monkeypatch, tmp_path
    ):
        """MUTANT M1 : sans ``force=True``, Modal REFUSE d'écraser.

        ``Volume.batch_upload(force=False)`` (défaut Modal) fait lever
        ``FileExistsError`` sur tout fichier déjà présent : ``credentials.json``
        restait alors sur le volume dans sa toute première version (souvent
        vide), et le worker recopiait cette version périmée à chaque démarrage.
        """
        module = sync_module.module
        user_dir = _user_tree(
            tmp_path,
            "default/AI-Helper/config/credentials.json",
            {"server_url": SERVER_URL, "api_key": REAL_KEY},
        )
        monkeypatch.setattr(module, "user_dir_candidates", lambda: [("walk-up", user_dir)])

        module.main(sync_user_only=True)

        assert sync_module.forces == [True], (
            "batch_upload doit être appelé avec force=True (sinon le volume garde "
            "l'ancienne version de credentials.json)"
        )
        destinations = " ".join(dest for _src, dest in sync_module.uploads)
        assert "credentials.json" in destinations
