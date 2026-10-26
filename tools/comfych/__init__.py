"""
Modal Gateway — Backend Configuration UI
Ajoute des routes API au ComfyUI PromptServer pour :
- Lancer la sync des modèles (modal run sync.py)
- Lancer le déploiement (modal deploy apps/all_in_one.py)
- Configurer l'URL de l'API et la clé d'authentification
- Vérifier le statut de Modal

Intégré au pack ComfyUI-AI-Helper sous ``tools/comfych/`` : le code reste ici
(c'est le cwd des commandes ``modal run``/``deploy``), mais les DONNÉES
(config.json, logs/) ne vivent plus dans le pack — voir ``comfych_store.py`` —
et les dossiers ComfyUI (output/, models/, user/, custom_nodes/) ne sont plus
déduits de la position du fichier — voir ``comfych_paths.py``.
"""
from __future__ import annotations

import asyncio
import ast
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode, urlsplit

# Modules propres à ComfyCH. Import RELATIF quand le dossier est chargé comme
# paquet (cas normal : tools.comfych) ; repli à plat pour un chargement par
# chemin sans paquet (harnais d'origine, script).
try:  # pragma: no cover - dépend du mode de chargement
    from . import comfych_paths as _paths
    from . import comfych_store as _store
except ImportError:  # pragma: no cover
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import comfych_paths as _paths  # type: ignore[no-redef]
    import comfych_store as _store  # type: ignore[no-redef]

# Racine du CODE ComfyCH (tools/comfych) = cwd de `modal run sync.py` : elle
# contient sync.py, image.py, apps/, workers/. Ne PAS confondre avec la racine
# ComfyUI : celle-ci est résolue par comfych_paths (folder_paths).
PROJECT_ROOT = Path(__file__).resolve().parent
CONFIG_PATH = Path(_store.config_path())

# Les fichiers web de ComfyCH ne sont plus déclarés ici : ils sont servis par le
# WEB_DIRECTORY du pack ("js"), qui contient js/comfych/modal_gateway.js.
# Un sous-dossier d'extension n'a pas de WEB_DIRECTORY pris en charge par
# ComfyUI — et le frontend est COMMUN au pack (sous-menu « ComfyCH »).

# ─── Gestion de la configuration ───

# La config par défaut et sa persistance vivent dans comfych_store.py (elles
# partagent le CHEMIN du fichier, désormais hors du pack).
DEFAULT_CONFIG = _store.DEFAULT_CONFIG


def load_config() -> dict:
    return _store.load_config()


def save_config(config: dict) -> None:
    _store.save_config(config)


# Import AUTOMATIQUE de l'ancienne configuration (cible absente + ancien fichier
# trouvé → copie puis renommage en ``.migrated`` ; conflit → rien n'est écrasé).
# Au chargement du module : une seule fois par processus, jamais bloquant.
try:
    _store.import_legacy_config_once()
except Exception as _comfych_import_err:  # noqa: BLE001 — ne jamais casser le démarrage
    print(f"[ComfyCH] 🔴 Import de l'ancienne configuration impossible : {_comfych_import_err}")

# ─── Mode de rendu FORCÉ en mémoire (jamais écrit dans la config) ───
# Décision utilisateur : quand ComfyCH est masqué (feature WIP désactivée), le
# mode de rendu est forcé à « local » À CHAQUE DÉMARRAGE. L'interception du
# bouton Queue reste en place (l'activer/désactiver serait bancal) : en mode
# local elle ne fait simplement rien. Forçage EN MÉMOIRE uniquement : le
# fichier de config (api_url, api_key, GPU préféré, listes…) reste INTACT, si
# bien que « mémoriser » plus tard = retirer le forçage, sans rien avoir écrasé.
FORCED_RENDER_MODE = "local"


def forced_render_mode() -> str:
    """Mode de rendu imposé au démarrage ("" si aucun forçage)."""
    return FORCED_RENDER_MODE



# ─── Paquets pip supplémentaires (dépendances optionnelles des nodes) ───

# Un nom/version de paquet pip ne contient JAMAIS de métacaractère shell. La
# validation est une LISTE BLANCHE (défense en profondeur : la même règle est
# réappliquée dans image.py, config.json étant éditable à la main) : tout ce qui
# n'y correspond pas est IGNORÉ, jamais concaténé dans une commande.
_PIP_PACKAGE_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.\-+=<>!~,\[\]]*$")
_PIP_PACKAGE_MAX_LEN = 80


def _is_safe_pip_package(package) -> bool:
    """True si *package* peut être passé tel quel à ``pip install``.

    Refuse les entrées non-str, vides, trop longues et surtout tout caractère
    permettant une injection shell (espace, point-virgule, esperluette, pipe,
    backtick, ``$``, parenthèses) ou une option pip (premier caractère ``-``).
    """
    if not isinstance(package, str):
        return False
    value = package.strip()
    if not value or len(value) > _PIP_PACKAGE_MAX_LEN:
        return False
    return _PIP_PACKAGE_RE.fullmatch(value) is not None


def _filter_pip_packages(value) -> tuple[list[str], list[str]] | None:
    """Filtre la valeur brute de ``extra_pip_packages``.

    Retourne ``(acceptés, rejetés)`` (rejetés = entrées d'origine refusées), ou
    ``None`` si *value* n'est pas une liste — l'appelant ignore alors le champ
    sans rien casser.
    """
    if not isinstance(value, list):
        return None
    accepted: list[str] = []
    rejected: list[str] = []
    for item in value:
        if _is_safe_pip_package(item):
            package = item.strip()
            if package not in accepted:
                accepted.append(package)
        else:
            rejected.append(str(item))
    return accepted, rejected


def _mask_config(config: dict) -> dict:
    """Retourne une copie sûre de la config pour l'API HTTP.

    ``api_key`` n'est JAMAIS renvoyée en clair au navigateur : elle est
    remplacée par une chaîne vide et l'information utile (présence ou non
    d'une clé) est exposée via le booléen ``api_key_set``.
    """
    masked = dict(config)
    api_key = str(masked.get("api_key") or "")
    masked["api_key"] = ""
    masked["api_key_set"] = bool(api_key)
    return masked


# ─── Helpers ───

# Journaux d'opération : HORS du pack (voir comfych_store.log_dir), donc plus
# dans un dossier servi en statique par ComfyUI.
def _log_path() -> Path:
    return _store.log_path()


def _status_path() -> Path:
    return _store.status_path()


_OP_LOCK = asyncio.Lock()  # sérialise les opérations Modal (sync/deploy/sync-user)

# Durée maximale d'une opération (30 min). Au-delà, le subprocess ``modal``
# est considéré bloqué (credentials, prompt interactif, réseau) : on le tue et
# on marque l'échec, sinon la tâche ne rendrait jamais la main.
_OP_TIMEOUT_SECONDS = 1800

# Durée au-delà de laquelle le slot est considéré comme fuité (40 min, soit
# plus que le timeout de 30 min : une op a réellement loupé sa libération) et
# peut être repris de force par la requête suivante.
_OP_STALE_SECONDS = 2400

# Période du heartbeat écrit dans le log pendant le streaming (secondes).
# ``modal run`` bufferise souvent sa sortie : sans heartbeat, le SSE resterait
# muet pendant des minutes et l'utilisateur croirait l'opération bloquée.
_HEARTBEAT_SECONDS = 10.0

# Garde d'entrée anti-concurrence (M11).
# ``_OP_LOCK.locked()`` ne peut pas servir de test d'entrée : entre le check et
# l'acquisition réelle (faite dans la tâche de fond), deux requêtes peuvent
# franchir le test et lancer deux opérations. On réserve donc le slot de façon
# synchrone, sans ``await`` entre le test et l'affectation.
_op_in_progress = False

# Identité de l'opération en cours (exposée par /api/modal/op/status et dans
# le message 409), pour que l'utilisateur sache QUI bloque le slot et depuis
# combien de temps.
_op_current_name: str = ""
_op_started_at: float = 0.0

# Références fortes aux tâches de fond : l'event loop n'en garde qu'une
# référence faible, une tâche non retenue peut être collectée en cours de route.
_background_tasks: set = set()

# Jeton de propriété du slot : incrémenté à chaque acquisition. Une tâche de
# fond ne libère le slot que si elle en est toujours propriétaire — sans ça, un
# « reset » (ou une reprise de slot fuité) suivi d'une nouvelle opération
# verrait la fin de l'ancienne tâche libérer le slot de la nouvelle.
_op_token = 0
_task_op_tokens: dict = {}


def _op_elapsed_seconds() -> int:
    """Durée écoulée (s) depuis le début de l'opération en cours (0 si aucune)."""
    if not _op_in_progress or not _op_started_at:
        return 0
    return max(0, int(time.time() - _op_started_at))


def _op_busy_response():
    """Réponse HTTP 409 explicite lorsqu'une opération Modal est déjà en cours.

    Indique quelle opération occupe le slot et depuis combien de temps — le
    message générique ne permettait pas de savoir si le blocage était normal
    (op en cours) ou un slot fuité (op morte sans libération).
    """
    name = _op_current_name or "inconnue"
    elapsed = _op_elapsed_seconds()
    return web.json_response(
        {
            "ok": False,
            "error": (
                f"Une opération Modal est déjà en cours ({name}, depuis {elapsed}s)"
            ),
            "operation": name,
            "elapsed_seconds": elapsed,
        },
        status=409,
    )


def _try_acquire_op(operation: str = "") -> bool:
    """Réserve atomiquement le slot d'opération Modal. False si déjà occupé.

    Auto-recovery : si le slot est occupé depuis plus de ``_OP_STALE_SECONDS``
    (donc au-delà du timeout maximal d'une opération), il a fuité — on le
    libère de force et on réacquiert, sinon l'UI resterait bloquée à vie.
    """
    global _op_in_progress, _op_current_name, _op_started_at, _op_token
    if _op_in_progress:
        elapsed = time.time() - _op_started_at if _op_started_at else float("inf")
        if elapsed <= _OP_STALE_SECONDS:
            return False
        print(
            f"[Modal Gateway] Slot d'opération considéré comme fuité "
            f"({_op_current_name or 'inconnue'}, {int(elapsed)}s) — libération forcée"
        )
        _release_op()
    _op_token += 1
    _op_in_progress = True
    _op_current_name = operation
    _op_started_at = time.time()
    return True


def _release_op() -> None:
    """Libère le slot d'opération Modal (idempotent)."""
    global _op_in_progress, _op_current_name, _op_started_at
    _op_in_progress = False
    _op_current_name = ""
    _op_started_at = 0.0


def _on_op_task_done(task) -> None:
    """Callback de fin de tâche : oublie la tâche et libère le slot.

    Appelé dans tous les cas (succès, exception, annulation). La libération
    n'a lieu que si la tâche est encore propriétaire du slot (comparaison de
    jetons) : après un reset ou une reprise de slot fuité, la tâche
    abandonnée ne doit pas libérer le slot de l'opération suivante.
    """
    _background_tasks.discard(task)
    token = _task_op_tokens.pop(task, None)
    if token is None or token == _op_token:
        _release_op()
    else:
        print(
            "[Modal Gateway] Tâche d'opération abandonnée terminée "
            "— slot déjà réattribué, pas de libération"
        )


def _spawn_op(operation: str, cmd: list[str]) -> bool:
    """Réserve le slot puis lance l'opération en tâche de fond.

    Returns:
        False si une opération est déjà en cours (rien n'est lancé), True sinon.
    """
    if not _try_acquire_op(operation):
        return False
    task = asyncio.create_task(_run_async(operation, cmd))
    _task_op_tokens[task] = _op_token
    _background_tasks.add(task)
    task.add_done_callback(_on_op_task_done)
    return True


def _spawn_sequence(operation: str, steps: list) -> bool:
    """Réserve le slot puis lance une SÉQUENCE d'étapes en tâche de fond.

    Même contrat que :func:`_spawn_op` (``False`` = slot déjà occupé, rien n'est
    lancé), mais pour une opération composée de plusieurs étapes ordonnées
    (voir :func:`_worker_restart_steps`).
    """
    if not _try_acquire_op(operation):
        return False
    task = asyncio.create_task(_run_sequence(operation, steps))
    _task_op_tokens[task] = _op_token
    _background_tasks.add(task)
    task.add_done_callback(_on_op_task_done)
    return True


async def _run_async(operation: str, cmd: list[str]):
    """Exécute une commande modal et écrit les logs + status.

    Sérialisée par _OP_LOCK : une seule opération à la fois — les opérations
    partagent les mêmes fichiers de logs et le même volume.
    """
    async with _OP_LOCK:
        await _run_sequence_inner(operation, [_cmd_step(operation, cmd)])


async def _run_sequence(operation: str, steps: list):
    """Exécute une séquence d'étapes, sérialisée par _OP_LOCK.

    Une seule opération à la fois : elles partagent les mêmes fichiers de logs
    et le même volume Modal.
    """
    async with _OP_LOCK:
        await _run_sequence_inner(operation, steps)


async def _stream_process(
    process, log_path: Path, started_at: float | None = None
) -> None:
    """Copie la sortie du subprocess dans *log_path* ligne par ligne.

    Extrait de :func:`_run_async_inner` pour pouvoir être enveloppé dans
    ``asyncio.wait_for`` (le streaming est la partie qui peut rester bloquée).

    La lecture est faite avec un timeout : si le subprocess n'écrit rien pendant
    ``_HEARTBEAT_SECONDS`` (sortie bufferisée par ``modal run``, import Modal,
    attente réseau…), une ligne « … toujours en cours (Ns) » est écrite dans le
    log. Le SSE ne reste donc jamais muet et l'UI peut distinguer « ça travaille
    sans rien dire » de « c'est bloqué ».
    """
    if started_at is None:
        started_at = time.time()

    while True:
        try:
            line = await asyncio.wait_for(
                process.stdout.readline(), timeout=_HEARTBEAT_SECONDS
            )
        except asyncio.TimeoutError:
            elapsed = int(time.time() - started_at)
            try:
                with open(log_path, "a") as f:
                    f.write(f"… toujours en cours ({elapsed}s)\n")
            except OSError:
                pass  # log non inscriptible : ne pas tuer l'opération
            continue
        if not line:  # EOF : le subprocess a fermé sa sortie
            break
        decoded = line.decode(errors="replace").rstrip()
        with open(log_path, "a") as f:
            f.write(decoded + "\n")


def _append_log(log_path: Path, line: str) -> None:
    """Ajoute UNE ligne au log d'opération (best-effort, jamais bloquant)."""
    try:
        with open(log_path, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass  # log non inscriptible : ne jamais tuer l'opération


def _cmd_step(label: str, cmd: list[str]):
    """Étape « lancer une commande modal et streamer sa sortie ».

    Returns
    -------
    tuple[str, callable]
        ``(libellé, exécuteur)`` où l'exécuteur est une coroutine
        ``(log_path, started_at) -> code de retour``.
    """

    async def _step(log_path: Path, started_at: float) -> int:
        # Amorcer le log AVANT tout : import Modal, résolution de l'app et
        # credentials peuvent prendre plusieurs secondes pendant lesquelles le
        # SSE n'aurait rien à afficher (l'utilisateur croit que rien ne se passe).
        _append_log(log_path, f"Lancement de: {' '.join(cmd)}")
        _append_log(log_path, "Initialisation de modal (import, résolution de l'app)…")
        return await _run_cmd(cmd, log_path, started_at)

    # Commande visible sur l'étape (diagnostic + tests d'ordre de séquence).
    _step.cmd = list(cmd)

    return (label, _step)


async def _run_cmd(
    cmd: list[str], log_path: Path, started_at: float | None = None
) -> int:
    """Lance UNE commande, copie sa sortie dans *log_path*, retourne son code.

    Returns
    -------
    int
        Code de retour du subprocess, ou ``1`` s'il n'a pas pu être lancé ou
        s'il a dépassé ``_OP_TIMEOUT_SECONDS`` (il est alors tué et l'échec est
        journalisé — sans quoi ``modal run`` bloqué ne rendrait jamais la main,
        ``_on_op_task_done`` ne serait jamais appelé et le slot d'opération
        resterait réservé à vie : tous les boutons renverraient 409).
    """
    if started_at is None:
        started_at = time.time()

    # S'assurer que le CLI modal est dans le PATH
    env = os.environ.copy()
    env["PATH"] = f"{os.path.dirname(sys.executable)}:{env.get('PATH', '')}"

    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=str(PROJECT_ROOT),
            env=env,
        )
    except (OSError, ValueError) as e:
        # modal absent ou commande invalide → logguer et marquer l'échec
        # (sinon le SSE attendrait un status qui ne viendrait jamais)
        _append_log(log_path, f"ERROR: impossible de lancer la commande: {e}")
        return 1

    # Lire et écrire les logs en temps réel, avec un timeout global.
    try:
        await asyncio.wait_for(
            _stream_process(process, log_path, started_at),
            timeout=_OP_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        try:
            process.kill()
        except Exception:  # noqa: BLE001 — le process peut déjà être mort
            pass
        # Reaper le process tué (évite un zombie) : le SSE attend un status,
        # sans quoi l'UI tournerait indéfiniment.
        try:
            await process.wait()
        except Exception:  # noqa: BLE001
            pass
        _append_log(
            log_path,
            f"\nERROR: opération interrompue après {_OP_TIMEOUT_SECONDS}s "
            f"(timeout)",
        )
        return 1

    await process.wait()
    return int(process.returncode or 0)


# Opérations dont le succès met à jour une date de la configuration.
_OPERATION_DATE_KEYS = {
    "sync": "last_sync",
    "deploy": "last_deploy",
    "sync_user": "last_user_sync",
}


async def _run_sequence_inner(operation: str, steps: list) -> None:
    """Exécute les *steps* d'une opération, EN SÉQUENCE, dans le même log.

    Chaque étape est un couple ``(libellé, exécuteur)`` (voir :func:`_cmd_step`).
    Une étape qui échoue INTERROMPT la séquence : c'est ce qui garantit qu'un
    redémarrage de worker n'a JAMAIS lieu quand la synchronisation qui le
    précède a échoué (voir :func:`_worker_restart_steps`).
    """
    log_path = _log_path()
    status_path = _status_path()

    # Nettoyer les logs précédents
    log_path.write_text("")
    if status_path.exists():
        status_path.unlink()

    started_at = time.time()
    _append_log(log_path, f"═══ Opération: {operation} ═══")

    multi = len(steps) > 1
    code = 1
    for index, (label, runner) in enumerate(steps, 1):
        if multi:
            _append_log(log_path, f"─── Étape {index}/{len(steps)} : {label} ───")
        code = await runner(log_path, started_at)
        if code != 0:
            if index < len(steps):
                _append_log(
                    log_path,
                    f"ERROR: étape « {label} » échouée (code {code}) — "
                    "étapes suivantes ANNULÉES",
                )
            break

    # Écrire le code de retour (le SSE s'en sert pour conclure l'opération).
    status_path.write_text(str(code))

    # Ligne de fin : le log se termine toujours par un marqueur lisible, même
    # si la dernière ligne du subprocess était une progression partielle.
    _append_log(
        log_path,
        f"═══ Terminé (code {code}) en {int(time.time() - started_at)}s ═══",
    )

    # Mettre à jour la date de la configuration (succès uniquement).
    date_key = _OPERATION_DATE_KEYS.get(operation)
    if code == 0 and date_key:
        # NOTE : la liste des nodes installés n'est plus dérivée de la sélection
        # (custom_nodes_ext / custom_nodes_local) — elle vient du volume réel,
        # voir ``synced_custom_nodes`` (écrit par sync.py) et
        # GET /api/modal/plugins/installed.
        config = load_config()
        config[date_key] = datetime.now().isoformat()
        save_config(config)


# ─── Redémarrage du worker Modal (SYNC puis redémarrage) ────────────────────
# L'ORDRE de la séquence est vital : le worker ne recopie le volume « user »
# (/user-settings) dans ComfyUI/user qu'AU DÉMARRAGE du container
# (workers/base_worker.py, _sync_user_settings_from_volume, appelé depuis
# start_checkpoint ET start_restore — aucun reload pendant la vie du container).
# Redémarrer AVANT la sync ferait donc relire l'ANCIEN volume par le container
# neuf : la synchronisation serait perdue.
WORKER_APP_NAME = "modal-comfy-gateway"
"""Nom de l'app Modal déployée (apps/all_in_one.py) dont on redémarre les containers."""

WORKER_APP_NAME_CONFIG_KEY = "worker_app_name"
"""Clé de configuration permettant de viser une autre app (all_in_one_l4, …)."""

# Identifiants de containers Modal (``cs-…``/``ta-…``/``ct-…``/``co-…``).
_CONTAINER_ID_RE = re.compile(
    r"(?<![A-Za-z0-9])((?:cs|ta|ct|co)-[A-Za-z0-9]{4,})(?![A-Za-z0-9])"
)

# Clés possibles d'un identifiant de container dans une sortie JSON.
_CONTAINER_ID_KEYS = (
    "container_id",
    "containerId",
    "container",
    "task_id",
    "taskId",
    "id",
)


def worker_app_name(config: dict | None = None) -> str:
    """Nom de l'app Modal à redémarrer (config ``worker_app_name``, sinon défaut)."""
    source = load_config() if config is None else config
    name = str(source.get(WORKER_APP_NAME_CONFIG_KEY) or "").strip()
    return name or WORKER_APP_NAME


def _parse_container_ids(payload: str) -> list[str]:
    """Extrait les identifiants de containers d'une sortie ``modal container list``.

    Tolérant par construction : la CLI Modal a changé plusieurs fois de format.
    Accepte du JSON (liste de chaînes, ou d'objets portant ``container_id`` /
    ``id`` / ``task_id``…) ET du texte brut (identifiants ``cs-…``/``ta-…``).
    Les doublons sont retirés, l'ordre d'apparition conservé.
    """
    found: list[str] = []

    def _add(value) -> None:
        text = str(value or "").strip()
        if text and _CONTAINER_ID_RE.fullmatch(text) and text not in found:
            found.append(text)

    def _walk(value) -> None:
        if isinstance(value, str):
            _add(value)
        elif isinstance(value, (list, tuple)):
            for item in value:
                _walk(item)
        elif isinstance(value, dict):
            for key in _CONTAINER_ID_KEYS:
                if key in value:
                    _walk(value[key])
                    return

    text = str(payload or "")
    try:
        _walk(json.loads(text))
    except (json.JSONDecodeError, ValueError, TypeError):
        pass
    # Repli texte : couvre les sorties tabulaires et les JSON d'un autre format.
    for match in _CONTAINER_ID_RE.finditer(text):
        _add(match.group(1))
    return found


async def _modal_cli_output(cmd: list[str], timeout: float = 120.0) -> tuple[int, str]:
    """Exécute une commande ``modal`` et retourne ``(code, sortie combinée)``."""
    env = os.environ.copy()
    env["PATH"] = f"{os.path.dirname(sys.executable)}:{env.get('PATH', '')}"
    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=str(PROJECT_ROOT),
            env=env,
        )
    except (OSError, ValueError) as e:
        return 1, f"impossible de lancer « {' '.join(cmd)} » : {e}"
    try:
        raw, _ = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        try:
            process.kill()
        except Exception:  # noqa: BLE001
            pass
        try:
            await process.wait()
        except Exception:  # noqa: BLE001
            pass
        return 1, f"« {' '.join(cmd)} » interrompu après {int(timeout)}s (timeout)"
    return int(process.returncode or 0), raw.decode("utf-8", errors="replace")


def _worker_restart_step(app_name: str | None = None):
    """Étape « redémarrer le worker » : stoppe les containers de l'app déployée.

    Le prochain rendu démarre alors un container NEUF, qui relit le volume
    (donc le ``user/`` fraîchement synchronisé). Aucun container actif n'est un
    succès (« rien à arrêter »), mais une CLI incapable de LISTER les containers
    est un ÉCHEC explicite : on n'affiche jamais un faux « redémarré ».
    """

    async def _step(log_path: Path, started_at: float) -> int:
        name = app_name or worker_app_name()
        _append_log(log_path, f"Recherche des containers actifs de l'app « {name} »…")

        code, output = await _modal_cli_output(
            ["modal", "container", "list", "--app", name, "--json"]
        )
        ids = _parse_container_ids(output) if code == 0 else []
        if code != 0 or not ids:
            # Certaines versions de la CLI n'ont pas ``--json`` : second essai
            # en texte brut. On ne conclut JAMAIS « aucun container » sur échec.
            fallback_code, fallback_output = await _modal_cli_output(
                ["modal", "container", "list", "--app", name]
            )
            output = (output + "\n" + fallback_output).strip()
            if fallback_code == 0:
                code = 0
                ids = _parse_container_ids(fallback_output)

        if code != 0:
            # La CLI refuse de lister les containers : le redémarrage ciblé est
            # impossible. On le DIT (sortie brute conservée pour diagnostic).
            _append_log(log_path, output or "(aucune sortie)")
            _append_log(
                log_path,
                "ERROR: la CLI Modal ne permet pas de lister les containers "
                f"(code {code}). Utilisez « Déployer » pour redémarrer le worker.",
            )
            return 1

        if not ids:
            _append_log(
                log_path,
                "Aucun container actif pour cette app : le prochain rendu "
                "démarrera un worker neuf (il relira donc le volume à jour).",
            )
            return 0

        _append_log(log_path, f"{len(ids)} container(s) à arrêter : {', '.join(ids)}")
        failure = 0
        for container_id in ids:
            stop_code, stop_output = await _modal_cli_output(
                ["modal", "container", "stop", container_id], timeout=180.0
            )
            for line in (stop_output or "").strip().splitlines():
                if line.strip():
                    _append_log(log_path, f"  {line.rstrip()}")
            if stop_code != 0:
                _append_log(
                    log_path,
                    f"ERROR: arrêt de {container_id} impossible (code {stop_code})",
                )
                failure = failure or stop_code or 1
            else:
                _append_log(log_path, f"  ✓ {container_id} arrêté")
        if failure:
            return failure
        _append_log(
            log_path,
            "Worker redémarré : le prochain rendu relit le volume (user/ à jour).",
        )
        return 0

    return ("Redémarrage du worker", _step)


def _worker_restart_steps(app_name: str | None = None) -> list:
    """Séquence du bouton « Redémarrer le worker ».

    ORDRE NON NÉGOCIABLE :
      1. ``modal run sync.py`` — pousse les fichiers locaux vers le volume ;
      2. arrêt des containers — le container neuf recopie volume → ``user/``.
    Voir le commentaire au-dessus de ``WORKER_APP_NAME``.
    """
    return [
        _cmd_step(
            "Sync des fichiers vers le volume Modal", ["modal", "run", "sync.py"]
        ),
        _worker_restart_step(app_name),
    ]


def _check_modal_installed() -> bool:
    try:
        result = subprocess.run(
            ["modal", "--version"],
            capture_output=True, text=True, timeout=5,
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def _check_modal_auth() -> bool:
    try:
        result = subprocess.run(
            ["modal", "profile", "current"],
            capture_output=True, text=True, timeout=5,
        )
        return result.returncode == 0 and bool(result.stdout.strip())
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def _check_volume_exists() -> bool:
    try:
        result = subprocess.run(
            ["modal", "volume", "list"],
            capture_output=True, text=True, timeout=10,
        )
        return "comfy-models" in result.stdout
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def _check_secret_exists() -> bool:
    """Check that the gateway API-key Secret exists on the Modal account."""
    try:
        result = subprocess.run(
            ["modal", "secret", "list"],
            capture_output=True, text=True, timeout=10,
        )
        return "comfy-gateway-secret" in result.stdout
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def _detect_custom_nodes() -> list[dict]:
    """Scan the local ComfyUI custom_nodes/ directory for installed nodes."""
    results: list[dict] = []
    found_any = False

    # folder_paths.get_folder_paths("custom_nodes") : gère les emplacements
    # supplémentaires ; repli sur le dossier parent du pack hors ComfyUI.
    for custom_nodes_dir in _paths.custom_nodes_dirs():
        if not custom_nodes_dir.is_dir():
            continue
        found_any = True
        results.extend(_detect_custom_nodes_in(custom_nodes_dir))

    if not found_any:
        print(f"[Modal Gateway] custom_nodes dir not found: {_paths.custom_nodes_dirs()}")
    return results


def _detect_custom_nodes_in(custom_nodes_dir: Path) -> list[dict]:
    """Scanne UN dossier custom_nodes (les autres extensions installées)."""
    results: list[dict] = []

    for entry in sorted(custom_nodes_dir.iterdir()):
        if not entry.is_dir():
            continue
        name = entry.name
        if name.startswith(".") or name.startswith("__"):
            continue
        if name == PROJECT_ROOT.name:
            continue

        git_config_path = entry / ".git" / "config"
        git_url = None
        has_git = False

        if git_config_path.is_file():
            has_git = True
            try:
                content = git_config_path.read_text(errors="replace")
                in_origin = False
                for line in content.splitlines():
                    stripped = line.strip()
                    if stripped.startswith("[remote"):
                        in_origin = '"origin"' in stripped
                        continue
                    if in_origin and stripped.startswith("url"):
                        parts = stripped.split("=", 1)
                        if len(parts) == 2:
                            git_url = parts[1].strip()
                        break
            except OSError:
                pass

        results.append({
            "name": name,
            "git_url": git_url,
            "has_git": has_git,
        })

    return results


def _detect_local_models() -> list[dict]:
    """Scan the local ComfyUI models/ directory for installed model files.

    Looks for .safetensors, .ckpt, .pt, .bin, .gguf, .pth files in each
    subdirectory of ComfyUI/models/.

    Returns a list of {"filename": str, "model_dir": str, "size_mb": float}.
    """
    # Racine des modèles de ComfyUI : résolue par folder_paths (gère
    # --base-directory et extra_model_paths.yaml), plus par déduction de
    # position — qui pointait faux une fois ComfyCH intégré au pack.
    models_dir = _paths.models_dir()

    MODEL_EXTENSIONS = {".safetensors", ".ckpt", ".pt", ".bin", ".gguf", ".pth"}
    results: list[dict] = []

    if not models_dir.is_dir():
        print(f"[Modal Gateway] models dir not found: {models_dir}")
        return results

    for subdir in sorted(models_dir.iterdir()):
        if not subdir.is_dir():
            continue
        # Skip non-model dirs
        if subdir.name.startswith(".") or subdir.name.startswith("__"):
            continue
        for file in sorted(subdir.iterdir()):
            if file.is_file() and file.suffix.lower() in MODEL_EXTENSIONS:
                try:
                    size_mb = round(file.stat().st_size / (1024 * 1024), 1)
                except OSError:
                    size_mb = 0
                results.append({
                    "filename": file.name,
                    "model_dir": subdir.name,
                    "size_mb": size_mb,
                })

    return results


def _extract_class_mappings(init_path: Path) -> set[str]:
    """Extrait les clés de NODE_CLASS_MAPPINGS d'un __init__.py via AST.

    Évite le matching par sous-chaîne (faux positifs : commentaires, chaînes
    de doc, etc.).
    """
    try:
        tree = ast.parse(init_path.read_text(errors="replace"))
    except (SyntaxError, OSError):
        return set()

    mappings: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if not (isinstance(target, ast.Name) and target.id == "NODE_CLASS_MAPPINGS"):
                continue
            if not isinstance(node.value, ast.Dict):
                continue
            for key in node.value.keys:
                if isinstance(key, ast.Constant) and isinstance(key.value, str):
                    mappings.add(key.value)
    return mappings


def _match_nodes_to_class_types(class_types: list[str]) -> list[str]:
    """Match workflow class_types to local custom node directories.

    Parse chaque custom node's __init__.py (AST) et extrait les vraies clés de
    NODE_CLASS_MAPPINGS — pas de matching par sous-chaîne.
    Retourne une liste de noms de dossiers de nodes fournissant l'un des
    class_types donnés.
    """
    matches: list[str] = []
    wanted = set(class_types)
    if not wanted:
        return matches

    for custom_nodes_dir in _paths.custom_nodes_dirs():
        if not custom_nodes_dir.is_dir():
            continue
        matches.extend(_match_nodes_in(custom_nodes_dir, wanted))
    return matches


def _match_nodes_in(custom_nodes_dir: Path, wanted: set[str]) -> list[str]:
    """Cherche dans UN dossier custom_nodes les nodes fournissant *wanted*."""
    matches: list[str] = []

    for entry in sorted(custom_nodes_dir.iterdir()):
        if not entry.is_dir():
            continue
        if entry.name.startswith(".") or entry.name.startswith("__"):
            continue
        if entry.name == PROJECT_ROOT.name:
            continue

        init_path = entry / "__init__.py"
        if not init_path.is_file():
            continue

        if _extract_class_mappings(init_path) & wanted:
            matches.append(entry.name)

    return matches


def _sanitize_save_path(output_dir: Path, subfolder: str, filename: str) -> Path | None:
    """Valide un couple (subfolder, filename) contre le path traversal.

    Retourne le chemin cible résolu s'il est valide et situé sous *output_dir*,
    sinon None. Rejette : chemins absolus, composants ``..``/``.`` dans
    subfolder, filename avec séparateurs ou ``..``, et toute sortie du dossier
    (y compris via symlinks, grâce à ``resolve()``).
    """
    try:
        base = output_dir.resolve()
    except OSError:
        return None

    # subfolder : ni chemin absolu, ni composant ".." ou "."
    if subfolder:
        sub_path = Path(subfolder)
        if sub_path.is_absolute() or any(p in ("..", ".") for p in sub_path.parts):
            return None
        target_dir = base.joinpath(*sub_path.parts)
    else:
        target_dir = base

    # filename : un seul composant, sans séparateur de chemin
    if (
        "/" in filename
        or "\\" in filename
        or filename in ("", ".", "..")
        or Path(filename).name != filename
    ):
        return None

    try:
        target = (target_dir / filename).resolve()
    except OSError:
        return None
    if not target.is_relative_to(base):
        return None
    return target


# ─── Initialisation : patcher PromptServer.add_routes ───

try:
    from server import PromptServer
    from aiohttp import web
except ImportError:
    # Pas dans ComfyUI, tout va bien
    PromptServer = None  # type: ignore
    web = None

def _request_guard(request):
    """Retourne ``None`` si la requête est autorisée, sinon une réponse 403.

    Protège les endpoints locaux contre drive-by / DNS rebinding en
    vérifiant le Host et l'Origin de la requête. Sont acceptées : les
    origines locales (loopback, réseau privé, ``.local``), les requêtes
    same-origin, et les hôtes/origines listés dans ``config["allowed_hosts"]``
    (utile quand ComfyUI est derrière un reverse proxy).
    """

    def _hostname_of(netloc: str) -> str:
        n = netloc.strip().lower()
        if n.startswith("["):  # IPv6 [::1]:port
            return n.split("]")[0] + "]"
        if ":" in n:  # hostname:port
            return n.rsplit(":", 1)[0]
        return n

    def _is_local_hostname(hostname: str) -> bool:
        h = hostname.strip().lower()
        if h in ("localhost", "::1", "[::1]") or h.endswith(".local"):
            return True
        if h.startswith("127."):
            return True
        if h.startswith("10.") or h.startswith("192.168."):
            return True
        if h.startswith("172."):
            try:
                return 16 <= int(h.split(".")[1]) <= 31
            except (IndexError, ValueError):
                return False
        return False

    host = request.headers.get("Host", "")
    origin = request.headers.get("Origin", "")
    allowed = {
        str(a).strip().lower()
        for a in (load_config().get("allowed_hosts", []) or [])
        if str(a).strip()
    }

    if host and not _is_local_hostname(_hostname_of(host)) \
            and host not in allowed and _hostname_of(host) not in allowed:
        return web.json_response(
            {"error": f"Forbidden host: {host}"}, status=403
        )

    if origin:
        origin_netloc = urlsplit(origin).netloc
        if origin_netloc:
            if origin_netloc == host:
                return None  # same-origin OK
            if _is_local_hostname(_hostname_of(origin_netloc)):
                return None  # origine locale OK
            if origin_netloc in allowed or _hostname_of(origin_netloc) in allowed:
                return None  # origine autorisée (reverse proxy)
            return web.json_response(
                {"error": f"Forbidden origin: {origin}"}, status=403
            )

    return None


if PromptServer is not None:
    _original_add_routes = PromptServer.add_routes

    def _add_routes_with_modal(self):
        """Appelé pendant l'init de ComfyUI, AVANT que le router soit frozen."""
        # D'abord les routes originales de ComfyUI
        result = _original_add_routes(self)

        # ── GET /api/modal/config ──
        async def get_config(request):
            # La clé API n'est jamais renvoyée en clair (voir _mask_config).
            payload = _mask_config(load_config())
            # Mode de rendu FORCÉ en mémoire au démarrage (jamais persisté) : le
            # frontend l'applique sans toucher à la préférence enregistrée.
            payload["render_mode_forced"] = forced_render_mode()
            return web.json_response(payload)

        # ── POST /api/modal/config ──
        async def post_config(request):
            try:
                data = await request.json()
            except Exception:
                data = {}
            if not isinstance(data, dict):
                data = {}
            # « Paquets pip supplémentaires » : champ validé à l'écriture, mais
            # JAMAIS motif de rejet de la requête (un 400 casserait l'UI).
            # Les entrées dangereuses sont écartées et signalées.
            if "extra_pip_packages" in data:
                raw_packages = data.get("extra_pip_packages")
                filtered = _filter_pip_packages(raw_packages)
                if filtered is None:
                    # Champ inutilisable (pas une liste) : ignoré tel quel.
                    data.pop("extra_pip_packages", None)
                    print(
                        "[Modal Gateway] ⚠️ extra_pip_packages ignoré "
                        f"(liste attendue, reçu {type(raw_packages).__name__})"
                    )
                else:
                    accepted, rejected = filtered
                    if rejected:
                        print(
                            "[Modal Gateway] ⚠️ Paquet(s) pip ignoré(s) "
                            f"(caractère interdit ou nom invalide) : {rejected}"
                        )
                    data["extra_pip_packages"] = accepted
            save_config(data)
            return web.json_response(
                {"ok": True, "config": _mask_config(load_config())}
            )

        # ── GET /api/modal/status ──
        async def get_status(request):
            # Les checks subprocess tournent dans un thread pour ne pas
            # bloquer l'event loop de ComfyUI (modal list peut prendre 10s)
            status = {
                "modal_installed": await asyncio.to_thread(_check_modal_installed),
                "modal_authenticated": await asyncio.to_thread(_check_modal_auth),
                "volume_exists": await asyncio.to_thread(_check_volume_exists),
                "secret_exists": await asyncio.to_thread(_check_secret_exists),
            }
            config = load_config()
            status["last_sync"] = config.get("last_sync")
            status["last_deploy"] = config.get("last_deploy")
            status["api_configured"] = bool(config.get("api_url") and config.get("api_key"))
            return web.json_response(status)

        # ── POST /api/modal/sync — lance la sync en arrière-plan ──
        async def post_sync(request):
            if not _spawn_op("sync", ["modal", "run", "sync.py"]):
                return _op_busy_response()
            return web.json_response({"ok": True, "message": "Sync lancée"})

        # ── POST /api/modal/deploy — lance le déploiement ──
        async def post_deploy(request):
            if not _spawn_op("deploy", ["modal", "deploy", "apps/all_in_one.py"]):
                return _op_busy_response()
            return web.json_response({"ok": True, "message": "Déploiement lancé"})

        # ── POST /api/modal/token — enregistre le token Modal (remplace modal token set en CLI) ──
        async def post_token(request):
            """Configure les credentials Modal du serveur (Token ID + Token Secret du site Modal).

            Exécute ``modal token set`` qui vérifie les credentials (--verify par défaut)
            puis confirme avec ``modal token info``. Les credentials sont stockés par le
            CLI Modal lui-même (~/.modal), pas dans config.json.
            """
            try:
                data = await request.json()
            except Exception:
                return web.json_response({"ok": False, "error": "Invalid JSON"}, status=400)

            token_id = str(data.get("token_id", "")).strip()
            token_secret = str(data.get("token_secret", "")).strip()
            if not token_id or not token_secret:
                return web.json_response(
                    {"ok": False, "error": "token_id and token_secret are required"},
                    status=400,
                )

            try:
                result = await asyncio.to_thread(
                    subprocess.run,
                    ["modal", "token", "set", "--token-id", token_id, "--token-secret", token_secret],
                    capture_output=True, text=True, timeout=60,
                )
            except FileNotFoundError:
                return web.json_response({"ok": False, "error": "modal CLI not installed"}, status=500)
            except subprocess.TimeoutExpired:
                return web.json_response({"ok": False, "error": "modal token set timed out"}, status=500)

            if result.returncode != 0:
                detail = (result.stderr or result.stdout or "").strip()
                return web.json_response(
                    {"ok": False, "error": f"modal token set failed: {detail[:500]}"},
                    status=500,
                )

            # Confirmer que le token fonctionne
            authenticated = False
            try:
                info = await asyncio.to_thread(
                    subprocess.run,
                    ["modal", "token", "info"],
                    capture_output=True, text=True, timeout=15,
                )
                authenticated = info.returncode == 0
            except (FileNotFoundError, subprocess.TimeoutExpired):
                pass

            print(f"[Modal Gateway] Token Modal enregistré (authentifié: {authenticated})")
            return web.json_response({"ok": True, "authenticated": authenticated})

        # ── POST /api/modal/secret — crée/màj le Secret Modal (débloque le 503) ──
        async def post_secret(request):
            """Create or update the Modal Secret holding the gateway API key.

            Supprime d'abord le Secret s'il existe (les erreurs sont ignorées),
            puis le recrée avec la nouvelle clé — le tout depuis l'UI, sans CLI.
            Résout le 503 « API key non configurée sur le serveur ».
            """
            try:
                data = await request.json()
            except Exception:
                return web.json_response({"ok": False, "error": "Invalid JSON"}, status=400)

            api_key = str(data.get("api_key", "")).strip()
            if not api_key:
                return web.json_response(
                    {"ok": False, "error": "api_key is required"}, status=400
                )

            env = os.environ.copy()
            env["PATH"] = f"{os.path.dirname(sys.executable)}:{env.get('PATH', '')}"

            try:
                # Supprimer le Secret existant s'il y en a un (ignorer les erreurs)
                await asyncio.to_thread(
                    subprocess.run,
                    ["modal", "secret", "delete", "comfy-gateway-secret"],
                    capture_output=True, text=True, timeout=60, env=env,
                )
                # (Re)créer le Secret avec la nouvelle clé
                result = await asyncio.to_thread(
                    subprocess.run,
                    ["modal", "secret", "create", "comfy-gateway-secret", f"API_KEY={api_key}"],
                    capture_output=True, text=True, timeout=60, env=env,
                )
            except FileNotFoundError:
                return web.json_response({"ok": False, "error": "modal CLI not installed"}, status=500)
            except subprocess.TimeoutExpired:
                return web.json_response({"ok": False, "error": "modal secret create timed out"}, status=500)

            if result.returncode != 0:
                detail = (result.stderr or result.stdout or "").strip()
                return web.json_response(
                    {"ok": False, "error": f"modal secret create failed: {detail[:500]}"},
                    status=500,
                )

            print("[Modal Gateway] Secret Modal comfy-gateway-secret créé/mis à jour")
            return web.json_response({"ok": True})

        # ── GET /api/modal/logs — récupère les logs de la dernière opération ──
        async def get_logs(request):
            log_path = _log_path()
            if log_path.exists():
                return web.json_response({"logs": log_path.read_text()})
            return web.json_response({"logs": ""})

        # ── GET /api/modal/logs/stream — SSE pour logs en temps réel ──
        async def get_logs_stream(request):
            response = web.StreamResponse(
                status=200,
                reason="OK",
                headers={
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                },
            )
            await response.prepare(request)

            log_path = _log_path()
            last_size = log_path.stat().st_size if log_path.exists() else 0
            keepalive_count = 0

            try:
                while True:  # No more 5-minute limit
                    await asyncio.sleep(0.5)
                    keepalive_count += 1

                    if log_path.exists():
                        current_size = log_path.stat().st_size
                        if current_size > last_size:
                            with open(log_path, "r") as f:
                                f.seek(last_size)
                                new_content = f.read()
                                last_size = current_size
                                for line in new_content.split("\n"):
                                    if line.strip():
                                        try:
                                            await response.write(
                                                f"data: {json.dumps({'line': line.rstrip()})}\n\n".encode()
                                            )
                                        except (ConnectionResetError, ConnectionAbortedError):
                                            return response
                                    keepalive_count = 0

                    # Send keepalive every 30 seconds to prevent proxy timeout
                    if keepalive_count >= 60:  # 60 * 0.5s = 30s
                        try:
                            await response.write(f": keepalive\n\n".encode())
                        except (ConnectionResetError, ConnectionAbortedError):
                            return response
                        keepalive_count = 0

                    status_path = _status_path()
                    if status_path.exists():
                        status = status_path.read_text().strip()
                        try:
                            await response.write(
                                f"event: done\ndata: {json.dumps({'code': status})}\n\n".encode()
                            )
                        except (ConnectionResetError, ConnectionAbortedError):
                            pass
                        break
            except (ConnectionResetError, ConnectionAbortedError):
                pass
            return response

        # ── GET /api/modal/worker-logs — logs ComfyUI d'un worker Modal ──
        async def get_worker_logs(request):
            """Récupère les dernières lignes du log ComfyUI d'un worker Modal.

            Relaie ``GET {api_url}/logs`` du gateway (X-API-Key). C'est le seul
            moyen de voir les tracebacks d'import des custom nodes : côté
            client on n'obtient qu'un ``missing_node_type`` ou un HTTP 500.

            Query params : ``gpu`` (optionnel, défaut = dernier GPU utilisé) et
            ``lines`` (défaut 200, borné à 2000).
            """
            config = load_config()
            api_url = str(config.get("api_url") or "").rstrip("/")
            api_key = str(config.get("api_key") or "")
            if not api_url:
                return web.json_response(
                    {"ok": False, "error": "api_url non configurée"}, status=400
                )

            try:
                lines = max(
                    1, min(int(request.rel_url.query.get("lines", "200")), 2000)
                )
            except (TypeError, ValueError):
                lines = 200

            params = {"lines": str(lines)}
            gpu = (request.rel_url.query.get("gpu") or "").strip()
            if gpu:
                params["gpu"] = gpu
            url = f"{api_url}/logs?{urlencode(params)}"

            # urllib (stdlib) plutôt que httpx : aucune dépendance à ajouter à
            # l'environnement ComfyUI, et l'appel bloque un thread dédié (pas
            # l'event loop du serveur).
            def _fetch():
                req = urllib.request.Request(url, headers={"X-API-Key": api_key})
                try:
                    with urllib.request.urlopen(req, timeout=60) as resp:
                        return resp.status, resp.read()
                except urllib.error.HTTPError as e:
                    return e.code, e.read()

            try:
                status_code, raw = await asyncio.to_thread(_fetch)
            except (urllib.error.URLError, OSError, ValueError) as e:
                return web.json_response(
                    {"ok": False, "error": f"Appel gateway impossible : {e}"},
                    status=502,
                )

            text = raw.decode("utf-8", errors="replace")
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                payload = {"lines": text.splitlines()}

            if status_code != 200:
                detail = payload.get("error") if isinstance(payload, dict) else None
                return web.json_response(
                    {"ok": False, "error": str(detail or f"HTTP {status_code}")},
                    status=status_code,
                )
            return web.json_response(payload)

        async def get_plugins_detect(request):
            plugins = _detect_custom_nodes()
            return web.json_response({"plugins": plugins})

        async def get_plugins(request):
            config = load_config()
            return web.json_response({
                "custom_nodes": config.get("custom_nodes", []),
                "custom_nodes_ext": config.get("custom_nodes_ext", []),
                "custom_nodes_local": config.get("custom_nodes_local", []),
            })

        async def post_plugins(request):
            try:
                data = await request.json()
            except Exception:
                return web.json_response(
                    {"ok": False, "error": "Invalid JSON"}, status=400
                )
            custom_nodes = data.get("custom_nodes", [])
            custom_nodes_ext = data.get("custom_nodes_ext", [])
            custom_nodes_local = data.get("custom_nodes_local", [])
            if not isinstance(custom_nodes, list):
                return web.json_response(
                    {"ok": False, "error": "custom_nodes must be a list"}, status=400
                )
            if not isinstance(custom_nodes_ext, list):
                return web.json_response(
                    {"ok": False, "error": "custom_nodes_ext must be a list"}, status=400
                )
            if not isinstance(custom_nodes_local, list):
                return web.json_response(
                    {"ok": False, "error": "custom_nodes_local must be a list"}, status=400
                )
            save_config({
                "custom_nodes": custom_nodes,
                "custom_nodes_ext": custom_nodes_ext,
                "custom_nodes_local": custom_nodes_local,
            })
            return web.json_response({
                "ok": True,
                "custom_nodes": custom_nodes,
                "custom_nodes_ext": custom_nodes_ext,
                "custom_nodes_local": custom_nodes_local,
            })

        # ── GET /api/modal/models/detect — scan local models ──
        async def get_models_detect(request):
            models = _detect_local_models()
            return web.json_response({"models": models})

        # ── GET /api/modal/models/select — get saved model selection ──
        async def get_models_select(request):
            config = load_config()
            return web.json_response({
                "models_to_sync": config.get("models_to_sync", []),
            })

        # ── POST /api/modal/models/select — save model selection ──
        async def post_models_select(request):
            try:
                data = await request.json()
            except Exception:
                return web.json_response(
                    {"ok": False, "error": "Invalid JSON"}, status=400
                )
            models_to_sync = data.get("models_to_sync", [])
            if not isinstance(models_to_sync, list):
                return web.json_response(
                    {"ok": False, "error": "models_to_sync must be a list"}, status=400
                )
            save_config({"models_to_sync": models_to_sync})
            return web.json_response({
                "ok": True,
                "models_to_sync": models_to_sync,
            })

        # ── POST /api/modal/plugins/match — match class_types to nodes ──
        async def post_plugins_match(request):
            try:
                data = await request.json()
            except Exception:
                return web.json_response({"ok": False, "error": "Invalid JSON"}, status=400)
            class_types = data.get("class_types", [])
            if not isinstance(class_types, list):
                return web.json_response({"ok": False, "error": "class_types must be a list"}, status=400)
            matches = _match_nodes_to_class_types(class_types)
            return web.json_response({"matches": matches})

        # ── POST /api/modal/save-local — save image to local filesystem ──
        async def post_save_local(request):
            try:
                data = await request.json()
            except Exception:
                return web.json_response({"ok": False, "error": "Invalid JSON"}, status=400)

            filename = data.get("filename", "")
            subfolder = data.get("subfolder", "")
            image_type = data.get("type", "output")
            base64_data = data.get("data", "")

            if not filename or not base64_data:
                return web.json_response({"ok": False, "error": "Missing filename or data"}, status=400)

            import base64 as b64mod

            # Determine local output directory
            config = load_config()
            output_dir_str = config.get("local_output_dir", "")
            if output_dir_str:
                output_dir = Path(output_dir_str)
            else:
                # Dossier output de ComfyUI : résolu par folder_paths
                # (get_output_directory gère --output-directory).
                output_dir = _paths.output_dir()

            # ── Sanitisation anti path traversal ───────────────────────
            target_path = _sanitize_save_path(output_dir, subfolder, filename)
            if target_path is None:
                return web.json_response(
                    {"ok": False, "error": "Invalid filename or subfolder"},
                    status=400,
                )

            target_dir = target_path.parent
            target_dir.mkdir(parents=True, exist_ok=True)

            # Write the file
            try:
                file_data = b64mod.b64decode(base64_data)
                target_path.write_bytes(file_data)
                print(f"[Modal Gateway] Saved locally: {target_path}")
                return web.json_response({
                    "ok": True,
                    "path": str(target_path),
                })
            except Exception as e:
                return web.json_response({"ok": False, "error": str(e)}, status=500)

        # ── GET /api/modal/user-settings/status ──
        async def get_user_settings_status(request):
            # Dossier user de ComfyUI : MÊME référence que le reste du pack
            # (holaf_user_paths.get_comfy_user_dir, qui gère --user-directory).
            user_dir = _paths.user_dir()
            if not user_dir.is_dir():
                return web.json_response({"exists": False, "path": str(user_dir)})
            total_files = 0
            total_size = 0
            for f in user_dir.rglob("*"):
                if f.is_file():
                    total_files += 1
                    total_size += f.stat().st_size
            return web.json_response({
                "exists": True,
                "path": str(user_dir),
                "file_count": total_files,
                "size_mb": round(total_size / (1024 * 1024), 1),
            })

        # ── POST /api/modal/sync-user ──
        async def post_sync_user(request):
            if not _spawn_op(
                "sync_user", ["modal", "run", "sync.py", "--sync-user-only"]
            ):
                return _op_busy_response()
            return web.json_response({"ok": True, "message": "Sync user settings lancée"})

        # ── POST /api/modal/sync-custom-nodes ──
        async def post_sync_custom_nodes(request):
            if not _spawn_op(
                "sync_custom_nodes", ["modal", "run", "sync.py", "--sync-custom-nodes"]
            ):
                return _op_busy_response()
            return web.json_response({"ok": True, "message": "Sync custom nodes lancée"})

        # ── POST /api/modal/restart-worker — SYNC puis redémarrage du worker ──
        async def post_restart_worker(request):
            """Redémarre le worker Modal APRÈS avoir synchronisé le volume.

            L'ORDRE est la raison d'être de cette route : le worker ne recopie
            le volume ``user/`` (``/user-settings``) vers ``ComfyUI/user``
            qu'AU DÉMARRAGE du container (workers/base_worker.py,
            ``_sync_user_settings_from_volume``). Redémarrer AVANT la sync
            ferait donc recharger l'ANCIEN volume par le container neuf.

            Garde-fous :
            - une opération déjà en cours (sync, deploy…) → 409 explicite via
              :func:`_op_busy_response` (aucune séquence lancée) ;
            - un RENDU en cours n'est pas observable côté serveur (les rendus
              vont du navigateur au gateway) : c'est le client qui l'annonce
              par ``render_in_progress``, et il ne doit le faire qu'après
              confirmation de l'utilisateur (``confirm: true``), sinon 409.
            """
            try:
                data = await request.json()
            except Exception:
                data = {}
            if not isinstance(data, dict):
                data = {}

            if data.get("render_in_progress") and not data.get("confirm"):
                return web.json_response(
                    {
                        "ok": False,
                        "error": (
                            "Un rendu est en cours : confirmez le redémarrage "
                            "(confirm: true) pour interrompre le worker."
                        ),
                        "needs_confirm": True,
                    },
                    status=409,
                )

            if not _spawn_sequence("restart_worker", _worker_restart_steps()):
                return _op_busy_response()
            return web.json_response(
                {
                    "ok": True,
                    "message": "Sync puis redémarrage du worker lancés",
                    # Ordre contractuel de la séquence (le front l'affiche).
                    "sequence": ["sync", "restart"],
                }
            )

        # ── GET /api/modal/op/status — état du slot d'opération ──
        async def get_op_status(request):
            return web.json_response({
                "in_progress": _op_in_progress,
                "operation": _op_current_name,
                "elapsed_seconds": _op_elapsed_seconds(),
            })

        # ── POST /api/modal/op/reset — libère de force le slot d'opération ──
        async def post_op_reset(request):
            """Libère le verrou d'opération sans tuer le subprocess en cours.

            Filet de sécurité quand une opération est restée bloquée : le
            subprocess ``modal`` éventuellement encore vivant n'est PAS tué, il
            continue donc en tâche de fond (ses logs restent écrits).
            """
            was_running = _op_in_progress
            name = _op_current_name or "inconnue"
            _release_op()
            message = (
                f"Slot d'opération libéré (opération « {name} » "
                f"{'abandonnée' if was_running else 'aucune en cours'}) — "
                "le processus Modal sous-jacent, s'il tourne encore, n'a pas "
                "été tué."
            )
            print(f"[Modal Gateway] {message}")
            return web.json_response({
                "ok": True,
                "message": message,
                "previous_operation": name if was_running else "",
            })

        # ── GET /api/modal/plugins/installed — nodes réellement sur le volume ──
        async def get_plugins_installed(request):
            """Liste les custom nodes présents dans le volume comfy-custom-nodes.

            Lecture instantanée : ``synced_custom_nodes`` est écrit dans
            config.json par sync.py (local_entrypoint) après un sync réussi —
            pas d'appel Modal ici.
            """
            config = load_config()
            nodes = config.get("synced_custom_nodes", [])
            return web.json_response({
                "nodes": nodes if isinstance(nodes, list) else [],
                "synced_at": config.get("last_sync_custom_nodes"),
            })

        # Ensuite nos routes Modal Gateway
        routes = [
            ("GET", "/api/modal/config", get_config),
            ("POST", "/api/modal/config", post_config),
            ("GET", "/api/modal/plugins/detect", get_plugins_detect),
            ("GET", "/api/modal/plugins", get_plugins),
            ("POST", "/api/modal/plugins", post_plugins),
            ("POST", "/api/modal/plugins/match", post_plugins_match),
            ("GET", "/api/modal/models/detect", get_models_detect),
            ("GET", "/api/modal/models/select", get_models_select),
            ("POST", "/api/modal/models/select", post_models_select),
            ("GET", "/api/modal/status", get_status),
            ("POST", "/api/modal/sync", post_sync),
            ("POST", "/api/modal/deploy", post_deploy),
            ("POST", "/api/modal/token", post_token),
            ("POST", "/api/modal/secret", post_secret),
            ("GET", "/api/modal/logs", get_logs),
            ("GET", "/api/modal/logs/stream", get_logs_stream),
            ("GET", "/api/modal/worker-logs", get_worker_logs),
            ("POST", "/api/modal/save-local", post_save_local),
            ("GET", "/api/modal/user-settings/status", get_user_settings_status),
            ("POST", "/api/modal/sync-user", post_sync_user),
            ("POST", "/api/modal/sync-custom-nodes", post_sync_custom_nodes),
            ("GET", "/api/modal/op/status", get_op_status),
            ("POST", "/api/modal/restart-worker", post_restart_worker),
            ("POST", "/api/modal/op/reset", post_op_reset),
            ("GET", "/api/modal/plugins/installed", get_plugins_installed),
        ]
        for method, path, handler in routes:
            async def _guarded(request, _handler=handler):
                denied = _request_guard(request)
                if denied is not None:
                    return denied
                return await _handler(request)
            self.app.router.add_route(method, path, _guarded)

        print(f"[Modal Gateway] Routes API configurées ({len(routes)} endpoints)")
        return result

    PromptServer.add_routes = _add_routes_with_modal

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
