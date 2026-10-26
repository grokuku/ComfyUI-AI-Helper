# ─────────────────────────────────────────────────────────────────────────
# ComfyCH — bouton « Redémarrer le worker Modal » (route + séquence).
#
# Contexte : le worker Modal ne recopie le volume ``/user-settings`` dans
# ``ComfyUI/user`` qu'AU DÉMARRAGE du container
# (tools/comfych/workers/base_worker.py, ``_sync_user_settings_from_volume``,
# appelé depuis ``start_checkpoint`` ET ``start_restore`` — aucun reload
# pendant la vie du container). Un redémarrage SANS sync préalable ferait donc
# relire l'ANCIEN volume : la synchronisation serait perdue en silence.
#
# Ce fichier verrouille :
#   §1 la route existe et est montée (POST /api/modal/restart-worker) ;
#   §2 l'ORDRE de la séquence : sync AVANT redémarrage
#      — MUTANT « restart sans sync » → rouge ;
#   §3 une sync en échec ANNULE le redémarrage
#      — MUTANT « restart même si la sync a échoué » → rouge ;
#   §4 garde-fous de la route : rendu en cours sans confirmation → 409,
#      opération déjà en cours (sync) → 409, aucune séquence lancée ;
#   §5 l'étape de redémarrage est honnête : liste impossible = ÉCHEC explicite
#      (jamais un faux « redémarré »), aucun container = succès, arrêt par
#      container sinon ;
#   §6 ``_parse_container_ids`` tolérant (JSON et texte brut).
#
# Aucun test n'exécute la vraie CLI Modal : ``_modal_cli_output`` est remplacé.
#
# Usage :
#   PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
#   pytest tests/test_comfych_restart_worker.py
# ─────────────────────────────────────────────────────────────────────────
import asyncio
import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

import holaf_user_paths as aih_paths  # après le bootstrap sys.path

COMFYCH_DIR = PACKAGE_DIR / "tools" / "comfych"

RESTART_PATH = "/api/modal/restart-worker"


# ---------------------------------------------------------------------------
# Chargement du module réel, avec un faux ``server`` de ComfyUI
# ---------------------------------------------------------------------------
@pytest.fixture
def tree(tmp_path):
    """Fausse installation ComfyUI (arborescence utilisateur JETABLE).

    Le chargement de ``tools/comfych/__init__.py`` déclenche l'import
    automatique de la configuration : sans redirection, le module écrirait dans
    le VRAI dossier utilisateur (~/.config/comfyui/…) et polluerait les autres
    suites de tests.
    """
    comfy = tmp_path / "ComfyUI"
    pack = comfy / "custom_nodes" / "ComfyUI-AI-Helper"
    code = pack / "tools" / "comfych"
    code.mkdir(parents=True)
    user_root = comfy / "user" / "default" / "AI-Helper"
    user_root.mkdir(parents=True)
    return types.SimpleNamespace(comfy=comfy, pack=pack, code=code, user_root=user_root)


def _load_comfych(monkeypatch, tree):
    """Charge tools/comfych/__init__.py comme le fait le pack (paquet nommé)."""
    monkeypatch.setattr(aih_paths, "PACK_ROOT", str(tree.pack))
    monkeypatch.setenv(aih_paths.ENV_USER_ROOT, str(tree.user_root))
    monkeypatch.delenv(aih_paths.ENV_SKIP_MIGRATION, raising=False)

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
            return "orig"

    server_module = types.ModuleType("server")
    server_module.PromptServer = PromptServer
    monkeypatch.setitem(sys.modules, "server", server_module)
    PromptServer()  # instance : ComfyUI la crée au démarrage

    spec = importlib.util.spec_from_file_location(
        "holaf_comfych_restart_under_test",
        COMFYCH_DIR / "__init__.py",
        submodule_search_locations=[str(COMFYCH_DIR)],
    )
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, "holaf_comfych_restart_under_test", module)
    spec.loader.exec_module(module)

    # Les routines du store doivent viser l'arbre jetable, pas le vrai pack.
    monkeypatch.setattr(module._store, "CODEFYCH_CODE_ROOT", tree.code)
    monkeypatch.setattr(module._store, "custom_nodes_dirs", lambda: [tree.comfy / "custom_nodes"])

    # Les routes ne sont montées que lorsque ComfyUI appelle add_routes().
    PromptServer.instance.add_routes()
    return module, routes


@pytest.fixture
def comfych(tree, monkeypatch):
    """Module chargé (routes montées) sur une arborescence utilisateur jetable."""
    return _load_comfych(monkeypatch, tree)


class _Request:
    """Requête minimale (le strict nécessaire pour les handlers testés)."""

    def __init__(self, body=None):
        self._body = body
        self.rel_url = types.SimpleNamespace(query={})
        # ``_request_guard`` lit Host/Origin (requête locale en test).
        self.headers = {"Host": "localhost:8188"}

    async def json(self):
        if self._body is None:
            raise ValueError("pas de corps JSON")
        return self._body


def _handler(routes, method, path):
    for route_method, route_path, handler in routes:
        if route_method == method and route_path == path:
            return handler
    raise AssertionError(f"route absente : {method} {path}")


def _body(response) -> dict:
    return json.loads(response.text)


def _redirect_logs(monkeypatch, module, tmp_path):
    """Redirige le log d'opération et son fichier de statut vers tmp_path."""
    log_path = tmp_path / "last_operation.log"
    status_path = tmp_path / "last_operation.status"
    monkeypatch.setattr(module, "_log_path", lambda: log_path)
    monkeypatch.setattr(module, "_status_path", lambda: status_path)
    return log_path, status_path


@pytest.fixture
def loaded(comfych):
    """(module, routes, log_path, status_path) avec log/status dans tmp."""
    module, routes = comfych[0], comfych[1]
    return module, routes


# ---------------------------------------------------------------------------
# §1 La route existe et est montée
# ---------------------------------------------------------------------------
def test_restart_worker_route_is_mounted(comfych, monkeypatch):
    """MUTANT « route absente » : rouge si POST /api/modal/restart-worker saute."""
    module, routes = comfych

    handler = _handler(routes, "POST", RESTART_PATH)
    assert callable(handler), "le handler de redémarrage doit être monté"

    # Non-régression : les routes historiques restent là.
    paths = {path for _method, path, _handler in routes}
    for expected in ("/api/modal/sync", "/api/modal/op/status", "/api/modal/logs"):
        assert expected in paths, f"route historique perdue : {expected}"


# ---------------------------------------------------------------------------
# §2 L'ORDRE de la séquence : sync AVANT redémarrage
# ---------------------------------------------------------------------------
def test_restart_sequence_starts_with_sync(comfych):
    """MUTANT « restart sans sync » (ou ordre inversé) : rouge.

    Le worker ne relit le volume qu'au démarrage du container : redémarrer
    d'abord ferait recharger l'ANCIEN volume par le container neuf.
    """
    module, _routes = comfych
    steps = module._worker_restart_steps()

    assert len(steps) == 2, f"la séquence doit avoir 2 étapes (reçu {len(steps)})"
    first_label, first_runner = steps[0]
    second_label, second_runner = steps[1]

    assert "Sync" in first_label, f"1re étape = la sync (reçu « {first_label} »)"
    assert getattr(first_runner, "cmd", None) == ["modal", "run", "sync.py"], \
        "MUTANT : la 1re étape doit lancer `modal run sync.py`"
    assert "Redémarrage" in second_label, \
        f"2e étape = le redémarrage (reçu « {second_label} »)"
    assert not hasattr(second_runner, "cmd"), \
        "MUTANT : le redémarrage n'est pas une simple commande (liste puis arrêt)"


def test_worker_app_name_comes_from_config(comfych, monkeypatch):
    """Le nom de l'app est configurable (variante all_in_one_l4) sinon défaut."""
    module, _routes = comfych
    monkeypatch.setattr(module, "load_config", lambda: {"worker_app_name": ""})
    assert module.worker_app_name() == "modal-comfy-gateway"
    monkeypatch.setattr(
        module, "load_config", lambda: {"worker_app_name": "modal-comfy-gateway-l4"}
    )
    assert module.worker_app_name() == "modal-comfy-gateway-l4"


# ---------------------------------------------------------------------------
# §3 Une sync en échec ANNULE le redémarrage
# ---------------------------------------------------------------------------
def test_failed_sync_aborts_the_restart(comfych, monkeypatch, tmp_path):
    """MUTANT « restart même si la sync a échoué » : rouge.

    Une sync ratée (credentials, réseau, volume) laisse le volume dans son
    ANCIEN état : redémarrer ensuite rechargerait cet ancien volume.
    """
    module, _routes = comfych
    log_path, status_path = _redirect_logs(monkeypatch, module, tmp_path)
    calls = []

    async def _failing_sync(log_path_arg, started_at):
        calls.append("sync")
        return 7

    async def _restart(log_path_arg, started_at):
        calls.append("restart")
        return 0

    asyncio.run(
        module._run_sequence_inner(
            "restart_worker",
            [("Sync des fichiers vers le volume Modal", _failing_sync), ("Redémarrage du worker", _restart)],
        )
    )

    assert calls == ["sync"], f"MUTANT : le redémarrage ne doit pas avoir lieu ({calls})"
    text = log_path.read_text(encoding="utf-8")
    assert "étapes suivantes ANNULÉES" in text, text
    assert f"═══ Terminé (code 7)" in text, "le code de la sync en échec doit conclure le log"
    assert status_path.read_text().strip() == "7", "le SSE lit ce statut pour conclure"


def test_successful_sync_then_restart_runs_both_steps(comfych, monkeypatch, tmp_path):
    """Contrôle positif : sync OK → redémarrage exécuté, code final 0."""
    module, _routes = comfych
    log_path, status_path = _redirect_logs(monkeypatch, module, tmp_path)
    calls = []

    async def _sync(log_path_arg, started_at):
        calls.append("sync")
        return 0

    async def _restart(log_path_arg, started_at):
        calls.append("restart")
        return 0

    asyncio.run(
        module._run_sequence_inner(
            "restart_worker",
            [("Sync des fichiers vers le volume Modal", _sync), ("Redémarrage du worker", _restart)],
        )
    )

    assert calls == ["sync", "restart"], "les DEUX étapes doivent tourner, dans cet ordre"
    text = log_path.read_text(encoding="utf-8")
    assert "─── Étape 1/2" in text and "─── Étape 2/2" in text, text
    assert "═══ Terminé (code 0)" in text
    assert status_path.read_text().strip() == "0"


def test_single_command_operation_keeps_its_log_shape(comfych, monkeypatch, tmp_path):
    """Non-régression : une opération mono-commande garde son log d'origine."""
    module, _routes = comfych
    log_path, status_path = _redirect_logs(monkeypatch, module, tmp_path)

    async def _ok(log_path_arg, started_at):
        module._append_log(log_path_arg, "Lancement de: modal run sync.py")
        return 0

    asyncio.run(module._run_sequence_inner("sync", [("sync", _ok)]))
    text = log_path.read_text(encoding="utf-8")
    assert "═══ Opération: sync ═══" in text
    assert "─── Étape" not in text, "aucun en-tête d'étape pour une opération mono-commande"
    assert status_path.read_text().strip() == "0"


# ---------------------------------------------------------------------------
# §4 Garde-fous de la route
# ---------------------------------------------------------------------------
def test_render_in_progress_requires_confirmation(comfych, monkeypatch, tmp_path):
    """MUTANT « redémarrage pendant un rendu sans demander » : rouge.

    Le serveur ne voit pas les rendus (navigateur → gateway) : c'est le client
    qui les annonce, et seulement après confirmation de l'utilisateur.
    """
    module, routes = comfych
    _redirect_logs(monkeypatch, module, tmp_path)
    handler = _handler(routes, "POST", RESTART_PATH)

    spawned = []
    monkeypatch.setattr(
        module, "_spawn_sequence", lambda op, steps: spawned.append(op) or True
    )

    response = asyncio.run(handler(_Request({"render_in_progress": True})))
    assert response.status == 409, "un rendu en cours exige une confirmation explicite"
    assert _body(response)["needs_confirm"] is True
    assert spawned == [], "MUTANT : aucune séquence ne doit démarrer sans confirmation"

    # Confirmation donnée → la séquence part.
    response = asyncio.run(
        handler(_Request({"render_in_progress": True, "confirm": True}))
    )
    assert response.status == 200
    assert spawned == ["restart_worker"]
    assert _body(response)["sequence"] == ["sync", "restart"]
    assert _body(response)["sequence"][0] == "sync", "l'ordre annoncé au front = sync d'abord"


def test_busy_operation_returns_the_explicit_conflict(comfych, monkeypatch, tmp_path):
    """Une sync (ou autre op) en cours → 409 explicite, rien n'est lancé."""
    module, routes = comfych
    _redirect_logs(monkeypatch, module, tmp_path)
    handler = _handler(routes, "POST", RESTART_PATH)

    monkeypatch.setattr(module, "_spawn_sequence", lambda op, steps: False)

    response = asyncio.run(handler(_Request({})))
    assert response.status == 409
    payload = _body(response)
    assert payload["ok"] is False
    assert "déjà en cours" in payload["error"], payload


def test_route_tolerates_a_missing_or_invalid_body(comfych, monkeypatch, tmp_path):
    """Corps absent / non-objet : la route reste utilisable (cas curl)."""
    module, routes = comfych
    _redirect_logs(monkeypatch, module, tmp_path)
    handler = _handler(routes, "POST", RESTART_PATH)

    spawned = []
    monkeypatch.setattr(
        module, "_spawn_sequence", lambda op, steps: spawned.append(op) or True
    )

    response = asyncio.run(handler(_Request(None)))
    assert response.status == 200, "l'absence de corps JSON n'est pas une erreur"
    response = asyncio.run(handler(_Request(["pas", "un", "objet"])))
    assert response.status == 200
    assert spawned == ["restart_worker", "restart_worker"]


# ---------------------------------------------------------------------------
# §5 L'étape de redémarrage est honnête
# ---------------------------------------------------------------------------
def _run_restart_step(module, monkeypatch, tmp_path, cli):
    """Exécute l'étape de redémarrage avec une fausse CLI ``cli(cmd) -> (code, out)``."""
    log_path, _status = _redirect_logs(monkeypatch, module, tmp_path)
    calls = []

    async def _fake_cli(cmd, timeout=120.0):
        calls.append(list(cmd))
        return cli(cmd)

    monkeypatch.setattr(module, "_modal_cli_output", _fake_cli)
    _label, runner = module._worker_restart_step("modal-comfy-gateway")
    code = asyncio.run(runner(log_path, 0.0))
    return code, calls, log_path.read_text(encoding="utf-8")


def test_restart_fails_loudly_when_containers_cannot_be_listed(
    comfych, monkeypatch, tmp_path
):
    """MUTANT « faux succès alors que la CLI ne sait pas lister » : rouge."""
    module, _routes = comfych

    def _cli(cmd):
        return 2, "Error: No such command 'container'."

    code, calls, text = _run_restart_step(module, monkeypatch, tmp_path, _cli)

    assert code != 0, "MUTANT : une CLI incapable de lister n'est PAS un succès"
    assert "ERROR: la CLI Modal ne permet pas de lister les containers" in text, text
    assert "No such command" in text, "la sortie brute doit rester lisible pour diagnostiquer"
    assert not any(cmd[:3] == ["modal", "container", "stop"] for cmd in calls), \
        "aucun arrêt ne doit être tenté sans identifiant"


def test_restart_succeeds_when_no_container_is_running(comfych, monkeypatch, tmp_path):
    """Aucun container actif = rien à arrêter (et le volume sera relu)."""
    module, _routes = comfych

    def _cli(cmd):
        return 0, "[]"

    code, calls, text = _run_restart_step(module, monkeypatch, tmp_path, _cli)
    assert code == 0
    assert "Aucun container actif" in text, text
    assert not any(cmd[:3] == ["modal", "container", "stop"] for cmd in calls)


def test_restart_stops_each_container_found(comfych, monkeypatch, tmp_path):
    """Un container listé → un ``modal container stop <id>`` par container."""
    module, _routes = comfych

    def _cli(cmd):
        if cmd[2] == "list":
            payload = [{"container_id": "cs-aaaa1111"}, {"container_id": "cs-bbbb2222"}]
            return 0, json.dumps(payload)
        return 0, f"Stopped {cmd[3]}"

    code, calls, text = _run_restart_step(module, monkeypatch, tmp_path, _cli)

    assert code == 0, text
    stops = [cmd for cmd in calls if cmd[:3] == ["modal", "container", "stop"]]
    assert stops == [
        ["modal", "container", "stop", "cs-aaaa1111"],
        ["modal", "container", "stop", "cs-bbbb2222"],
    ], stops
    assert "Worker redémarré" in text, text


def test_restart_reports_a_failing_stop(comfych, monkeypatch, tmp_path):
    """Un arrêt qui échoue n'est JAMAIS présenté comme un succès."""
    module, _routes = comfych

    def _cli(cmd):
        if cmd[2] == "list":
            return 0, json.dumps([{"container_id": "cs-aaaa1111"}])
        return 3, "permission denied"

    code, _calls, text = _run_restart_step(module, monkeypatch, tmp_path, _cli)
    assert code != 0, text
    assert "ERROR: arrêt de cs-aaaa1111 impossible (code 3)" in text, text
    assert "Worker redémarré" not in text


def test_restart_falls_back_to_plain_text_listing(comfych, monkeypatch, tmp_path):
    """CLI sans ``--json`` : deuxième essai en texte brut, identifiants extraits."""
    module, _routes = comfych

    def _cli(cmd):
        if cmd[2] == "list" and cmd[-1] == "--json":
            return 2, "Error: No such option: --json"
        if cmd[2] == "list":
            return 0, "CONTAINER ID  APP ID\ncs-cccc3333   ap-1234\n"
        return 0, "ok"

    code, calls, text = _run_restart_step(module, monkeypatch, tmp_path, _cli)
    assert code == 0, text
    stops = [cmd for cmd in calls if cmd[:3] == ["modal", "container", "stop"]]
    assert stops == [["modal", "container", "stop", "cs-cccc3333"]], stops


# ---------------------------------------------------------------------------
# §6 Parsing tolérant des identifiants de containers
# ---------------------------------------------------------------------------
def test_parse_container_ids_accepts_json_and_text(comfych):
    module, _routes = comfych
    parse = module._parse_container_ids

    assert parse("") == []
    assert parse("[]") == []
    assert parse('["cs-aaaa1111", "cs-bbbb2222"]') == ["cs-aaaa1111", "cs-bbbb2222"]
    assert parse('[{"container_id": "cs-aaaa1111"}, {"id": "cs-bbbb2222"}]') == [
        "cs-aaaa1111",
        "cs-bbbb2222",
    ]
    assert parse('[{"task_id": "ta-cccc3333"}]') == ["ta-cccc3333"]
    # Sortie tabulaire (texte brut).
    assert parse("CONTAINER ID   APP ID\ncs-dddd4444   ap-9\n") == ["cs-dddd4444"]
    # Doublons retirés, ordre conservé ; bruit ignoré.
    assert parse("cs-eeee5555 cs-eeee5555 n-importe-quoi") == ["cs-eeee5555"]
    # Un identifiant trop court (bruit) n'est pas retenu.
    assert parse("cs-ab") == []


def test_restart_worker_never_touches_the_volume_directly(comfych):
    """Contrat de lecture : la séquence reste « sync puis arrêt », pas autre chose.

    Garde anti-dérive : si quelqu'un remplace l'arrêt des containers par un
    ``modal app stop`` (qui SUPPRIME le déploiement), ce test tombe.
    """
    module, _routes = comfych
    source = (COMFYCH_DIR / "__init__.py").read_text(encoding="utf-8")
    assert '"modal", "container", "stop"' in source
    assert '"modal", "app", "stop"' not in source
    assert '"modal", "run", "sync.py"' in source
