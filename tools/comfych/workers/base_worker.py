"""Headless ComfyUI worker — exposes the ComfyUI REST API via Modal web endpoints.

La classe de base ``ComfyWorker`` définit les class-variables ``gpu_type``
et ``scaledown_window`` que les sous-classes spécialisées surchargent.

Usage (Phase 4 — ``apps/all_in_one.py``)
----------------------------------------
::

    from workers.l4_worker import L4Worker
    from image import image

    app = modal.App("my-comfy-app", image=image)
    vol = modal.Volume.from_name("comfy-models", create_if_missing=True)

    @app.cls(
        max_containers=1,
        gpu=L4Worker.gpu_type,            # ← variable de classe
        volumes={"/cache": vol},
        scaledown_window=L4Worker.scaledown_window,  # ← variable de classe
        enable_memory_snapshot=True,
        experimental_options={"enable_gpu_snapshot": True},
    )
    @modal.concurrent(max_inputs=10)
    class MyL4Worker(L4Worker):
        pass
"""

from __future__ import annotations

import base64
import hashlib
import os
import shutil
import socket
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import httpx

import modal

# ── Emplacements (constantes patchables en test) ─────────────────────────

CUSTOM_NODES_VOLUME_PATH = Path("/custom_nodes")
"""Volume Modal qui porte le code des custom nodes (monté dans les 3 apps)."""

COMFY_ROOT = Path("/root/comfy/ComfyUI")
"""Racine de l'installation ComfyUI (``comfy install`` de ``image.py``).

Le lancement vise ``COMFY_ROOT/main.py`` : c'est le seul moyen de garder la
stdout/stderr de ComfyUI dans notre log (le wrapper ``comfy launch
--background`` daemonise et redirige la sortie vers son propre log interne)."""

COMFY_CUSTOM_NODES_DIR = COMFY_ROOT / "custom_nodes"
"""Dossier scanné par ComfyUI — une seule fois, à son démarrage."""

USER_SETTINGS_VOLUME_PATH = Path("/user-settings")
"""Volume Modal qui porte le dossier ``user/`` local (réglages + bases SQLite)."""

USER_SETTINGS_DIR = COMFY_ROOT / "user"
"""Cible de la copie des réglages au démarrage du worker."""

INSTALL_NODE_DEPS_AT_STARTUP = os.environ.get("COMFYCH_INSTALL_DEPS", "0") == "1"
"""Réinstaller les deps pip des custom nodes à chaque démarrage du worker ?

**Désactivé par défaut** : les ``requirements.txt`` de tous les nodes locaux
sont installés **au build de l'image** (voir ``image.py``), donc l'étape est
un pur gaspillage à l'exécution. Mesure réelle : ``pip install -r`` coûte
3-6 s par node *même quand tout est déjà satisfait* (pip résout et vérifie),
sur 30 nodes ≈ 141-187 s de « préparation » à chaque démarrage de container.
De plus un install runtime ne survit pas au snapshot (il touche
site-packages, pas le volume) : il est repayé intégralement à chaque fois.

Le flag ``COMFYCH_INSTALL_DEPS=1`` rétablit le comportement historique —
secours pour un node ajouté sur le volume sans rebuild de l'image (le code
du node, lui, vient toujours du volume)."""

COMFY_LOG_PATH = Path("/cache/logs/comfyui.log")
"""Sortie stdout/stderr de ComfyUI (tracebacks des custom nodes inclus).

Écrit sur le volume ``comfy-models`` (monté en ``/cache`` par les 3 apps) et
non dans ``/tmp`` : le log survit à l'arrêt du container et reste lisible par
une **fonction CPU** (``read_worker_logs`` des apps ``all_in_one*``) sans
réveiller de GPU — un cold start GPU prend 1 à 3 minutes, alors que consulter
ses logs doit être instantané."""

COMFY_LOG_VOLUME_NAME = "comfy-models"
"""Volume Modal qui porte ``COMFY_LOG_PATH`` (monté en ``/cache``)."""

COMFY_LOG_MAX_BYTES = 2 * 1024 * 1024
"""Fenêtre de lecture de ``logs_tail`` (2 Mio) — un node bavard ne doit pas
faire charger des centaines de Mo en mémoire au worker."""

COMFY_LOG_KEEP_BYTES = 512 * 1024
"""Portion conservée lors de la rotation au démarrage (512 Kio).

Au-delà de ``COMFY_LOG_MAX_BYTES``, le log est tronqué à ses derniers
``COMFY_LOG_KEEP_BYTES`` avant l'append du nouvel en-tête : sans cela il
croîtrait indéfiniment sur le volume (un node bavard peut écrire des Go)."""

WORKER_BUILD_ID_PATH = Path("/cache/logs/worker_build_id")
"""Empreinte du code du worker **au moment du snapshot** (sur le volume).

Un snapshot mémoire GPU fige le process ComfyUI lancé par
``start_checkpoint``. Au redéploiement, la restauration peut réutiliser ce
snapshot : le port 8000 répond alors — mais c'est **l'ancien** ComfyUI qui
répond, et ``_launch_comfy`` (nouveau code) n'est jamais exécuté. Ce fichier
permet à ``start_restore`` de comparer l'empreinte gravée dans le snapshot à
l'empreinte du code courant (``WORKER_BUILD_ID``) et de forcer un redémarrage
quand elles diffèrent."""


def _compute_worker_build_id() -> str:
    """Empreinte du code de ce fichier (16 hex) — surchargeable par l'env.

    ``COMFYCH_BUILD_ID`` permet d'injecter un identifiant externe (CI) ; sinon
    on hache ``base_worker.py`` lui-même : toute modification du worker change
    l'empreinte, ce qui sert de détecteur de redéploiement.

    Returns
    -------
    str
        16 caractères hexadécimaux (ou l'identifiant d'environnement tel quel).
    """
    env_id = os.environ.get("COMFYCH_BUILD_ID", "").strip()
    if env_id:
        return env_id
    try:
        return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()[:16]
    except OSError:
        # Fichier illisible (rare) : on garde un identifiant stable et hex.
        return hashlib.sha256(str(__file__).encode()).hexdigest()[:16]


WORKER_BUILD_ID = _compute_worker_build_id()
"""Empreinte du code **actuellement déployé** (voir ``WORKER_BUILD_ID_PATH``)."""

COMFY_CLI_LOG_CANDIDATES = (
    Path("/root/comfy/ComfyUI/user/comfyui.log"),
    Path("/root/comfy/ComfyUI/comfyui.log"),
    Path("~/.comfy/comfyui.log"),
)
"""Logs internes écrits par ``comfy-cli`` (dont ``comfy launch``).

Réplique de la sortie ComfyUI quand le wrapper CLI est utilisé (repli) :
le wrapper daemonise le serveur et détourne sa stdout vers ces fichiers,
qui ne sont donc **pas** sur le volume ``/cache`` et disparaissent avec le
container — d'où leur rôle de simple complément de diagnostic."""

COMFY_CLI_LOG_MIN_BYTES = 2 * 1024
"""En dessous de cette taille, le log principal est jugé inexploitable et
complété par le log interne de comfy-cli (en-tête du wrapper seul)."""

COMFY_CLI_LOG_TAIL_LINES = 300
"""Nombre de lignes lues dans le log interne de comfy-cli (complément)."""


# ── Helpers ──────────────────────────────────────────────────────────────


TIMING_LABEL_WIDTH = 38
"""Largeur du libellé dans les blocs de chronométrage écrits dans le log."""

PORT_POLL_INTERVAL = 0.5
"""Intervalle (s) entre deux tentatives de connexion du port dans
``wait_for_port`` — assez court pour détecter une disponibilité rapidement,
assez long pour ne pas marteler la boucle pendant les 5 minutes d'attente."""

TIMING_VALUE_WIDTH = 5
"""Largeur de la valeur (secondes, une décimale) dans ces blocs."""

PREP_SLOW_THRESHOLD_SECONDS = 10.0
"""Somme des durées par node (préparation) au-delà de laquelle un top est écrit.

Garde-fou : avec les deps installées au build, lier les nodes doit coûter
quelques millisecondes chacun. Un dépassement signale un node à optimiser
(``install.py`` bavard, ``requirements.txt`` volumineux…)."""

PREP_SLOW_TOP_N = 5
"""Nombre de nodes listés dans le top des plus lents de la préparation."""

STARTUP_MODE_CHECKPOINT = "snapshot en préparation"
"""Mode affiché dans le timing de ``start_checkpoint`` (avant capture GPU)."""

STARTUP_MODE_SNAPSHOT = "restauré depuis snapshot"
"""ComfyUI répondait déjà : le snapshot a bien été réutilisé (aucun reload)."""

STARTUP_MODE_CODE_CHANGED = "redémarrage forcé, code modifié"
"""Le snapshot portait une autre empreinte : son process ComfyUI a été tué."""

STARTUP_MODE_NEW_NODES = "redémarrage forcé, nouveaux custom nodes"
"""Des custom nodes ont été liés après la capture : il faut rescanner."""

STARTUP_MODE_COLD = "redémarrage forcé, cold start (port muet)"
"""ComfyUI ne répondait pas au bout de l'attente : relance complète."""


class StartupTiming(dict):
    """Chronométrage du démarrage de ComfyUI, phase par phase (dict ``label → s``).

    Un simple ``dict`` suffit : il est rempli par ``start_checkpoint`` /
    ``start_restore`` puis formaté par ``write_timing_block``. ``total`` est
    exposé comme propriété pour ne pas polluer les phases du bloc.
    """

    @property
    def total(self) -> float:
        return sum(_measured_seconds(v) for v in self.values())


def _measured_seconds(value: object, fallback: object = 0.0) -> float:
    """Durée en float ≥ 0 ; ``fallback`` si la valeur est inutilisable.

    ``wait_for_port`` renvoie sa propre mesure, mais il est monkeypatché en
    test (certaines versions ne renvoient rien) : on ne veut alors ni planter
    au formatage, ni afficher une durée négative (horloge du container).
    """
    for candidate in (value, fallback):
        try:
            number = float(candidate)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            continue
        if number != number:  # NaN : ni mesurable ni affichable
            continue
        return max(0.0, number)
    return 0.0


def format_timing_line(label: str, seconds: float) -> str:
    """Une ligne de bloc de timing : ``label`` aligné, valeur en secondes."""
    value = _measured_seconds(seconds)
    return (
        f"  {label:<{TIMING_LABEL_WIDTH}} : "
        f"{value:>{TIMING_VALUE_WIDTH}.1f}s"
    )


def write_timing_block(
    title: str,
    phases,
    mode: str = "",
    path: Path | str | None = None,
) -> float:
    """Écrit un bloc de chronométrage du démarrage ComfyUI dans le log.

    Le bloc est ajouté en **append** à ``path`` (défaut ``COMFY_LOG_PATH``,
    résolu à l'appel pour rester patchable en test) et dupliqué sur la stdout
    du worker : le log du container Modal natif montre ainsi les mêmes
    durées, sans attendre le commit du volume.

    Parameters
    ----------
    title : str
        Intitulé du bloc (``démarrage (checkpoint)``, ``restauration
        (snapshot)``…).
    phases : list[tuple[str, float]]
        Phases mesurées, dans l'ordre d'exécution (libellé, secondes).
    mode : str
        Mode retenu (snapshot vs redémarrage forcé). Vide = ligne omise.
    path : Path | str | None
        Fichier de log ; ``None`` → ``COMFY_LOG_PATH`` courant.

    Returns
    -------
    float
        Le TOTAL en secondes (somme des phases).
    """
    total = sum(_measured_seconds(seconds) for _, seconds in phases)
    lines = [f"───── timing {title} ─────"]
    if mode:
        lines.append(f"  {'mode':<{TIMING_LABEL_WIDTH}} : {mode}")
    lines.extend(format_timing_line(label, seconds) for label, seconds in phases)
    lines.append("  " + "─" * 44)
    lines.append(format_timing_line("TOTAL", total))
    block = "\n".join(lines) + "\n"

    log_path = Path(COMFY_LOG_PATH if path is None else path)
    error = _append_log_block(block, log_path)
    if error:
        # Un log non inscriptible ne doit jamais faire échouer un démarrage.
        print(f"[ComfyWorker] ⚠️ timing non écrit dans {log_path} : {error}")

    # Même bloc sur la stdout du worker : visible dans les logs Modal natifs.
    print(block.rstrip("\n"))
    return total


def write_slowest_nodes_block(
    nodes,
    path: Path | str | None = None,
    threshold: float = PREP_SLOW_THRESHOLD_SECONDS,
) -> float:
    """Top des nodes les plus lents de la préparation (garde-fou de perf).

    Rien n'est écrit si la somme des durées reste sous *threshold* : le cas
    normal (liens de symlinks seuls) ne doit pas polluer le log. Au-delà, le
    bloc liste les ``PREP_SLOW_TOP_N`` nodes les plus lents — de quoi repérer
    le node qui coûte les dizaines de secondes de « préparation » du démarrage.

    Parameters
    ----------
    nodes : list[tuple[str, float]]
        Durées par node ``(nom, secondes)``, dans l'ordre de traitement.    path : Path | str | None
        Fichier de log ; ``None`` → ``COMFY_LOG_PATH`` courant.
    threshold : float
        Seuil (s) de somme en dessous duquel rien n'est écrit.

    Returns
    -------
    float
        Le TOTAL mesuré (somme des durées), même si aucun bloc n'a été écrit.
    """
    total = sum(_measured_seconds(seconds) for _, seconds in nodes)
    nodes = list(nodes)
    if total <= _measured_seconds(threshold, PREP_SLOW_THRESHOLD_SECONDS):
        return total

    slowest = sorted(
        nodes, key=lambda item: _measured_seconds(item[1]), reverse=True
    )[:PREP_SLOW_TOP_N]
    lines = [f"───── top {PREP_SLOW_TOP_N} nodes les plus lents (préparation) ─────"]
    lines.extend(
        format_timing_line(str(name), seconds) for name, seconds in slowest
    )
    lines.append("  " + "─" * 44)
    lines.append(format_timing_line("TOTAL préparation des nodes", total))
    block = "\n".join(lines) + "\n"

    log_path = Path(COMFY_LOG_PATH if path is None else path)
    error = _append_log_block(block, log_path)
    if error:
        print(f"[ComfyWorker] ⚠️ top des nodes lents non écrit dans {log_path} : {error}")
    print(block.rstrip("\n"))
    return total


def _append_log_block(block: str, log_path: Path) -> str | None:
    """Ajoute *block* à *log_path* (dossier créé au besoin), en append.

    Returns
    -------
    str | None
        Le message d'erreur si l'écriture a échoué, ``None`` sinon. Aucune
        exception ne remonte : un log non inscriptible (volume absent, disque
        plein, chemin invalide) ne doit jamais faire échouer un démarrage.
    """
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "a") as f:
            f.write("\n" + block)
            f.flush()
        return None
    except OSError as e:
        return str(e)


def wait_for_port(
    port: int, timeout: int = 60, progress_every: float = 5.0
) -> float:
    """Block until the port on ``127.0.0.1`` is accepting connections.

    Returns
    -------
    float
        Durée réellement attendue, en secondes (0.0 si le port répondait
        déjà). C'est la mesure qui alimente les blocs de timing du démarrage :
        l'écart entre « Popen rendu la main » et « ComfyUI prêt » (chargement
        des custom nodes, des modèles, du VAE) est le vrai coût d'un
        redémarrage — il n'a rien à voir avec le temps de ``Popen``.

    Raises
    ------
    TimeoutError
        Si le port n'accepte toujours pas de connexion à l'échéance.
    """
    started = time.time()
    # Budget borné : un ``timeout`` non numérique (None, 0, négatif passé par
    # mégarde) ne doit pas produire d'attente infinie dans un ``@modal.enter``
    # — ce serait un container qui ne démarre jamais.
    deadline = started + _measured_seconds(timeout, 60.0)
    # Période de progression : jamais nulle (attente sans fin / boucle serrée).
    period = _measured_seconds(progress_every, 5.0) or 5.0
    next_report = period
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                elapsed = _measured_seconds(time.time() - started)
                print(f"[ComfyWorker] port {port} prêt après {elapsed:.1f}s")
                return elapsed  # port is open — ComfyUI is ready
        except OSError:
            elapsed = time.time() - started
            # Progression périodique : sans elle, un démarrage de plusieurs
            # minutes est indiscernable d'un worker bloqué.
            if elapsed >= next_report:
                next_report += period
                print(f"[ComfyWorker] en attente du port {port}… ({elapsed:.0f}s)")
            # Pas de veille jamais plus long que le temps restant ni qu'une
            # période de progression : l'échéance est respectée à ~10 ms près
            # et une ligne de progression n'est jamais sautée par un pas trop
            # gros. Marge de 10 ms : sur une échéance courte, on préfère un
            # dernier essai de connexion plutôt qu'un TimeoutError anticipé.
            remaining = deadline - time.time()
            step = min(PORT_POLL_INTERVAL, period, max(0.01, remaining))
            time.sleep(step)
    elapsed = _measured_seconds(time.time() - started)
    raise TimeoutError(
        f"ComfyUI never became ready on port {port} after {elapsed:.1f}s"
    )


def log_freshness(path: Path | str) -> dict:
    """Âge du fichier de log : ``{"mtime": float|None, "age_seconds": int|None}``.

    Un ``modal deploy`` ne démarre aucun container : ils se créent à la
    première requête. Le log affiché peut donc dater de plusieurs heures alors
    que le code vient d'être déployé. Ces deux clés permettent à l'UI (et aux
    clients de l'API ``/logs``) de rendre cette péremption visible au lieu de
    laisser croire que le nouveau code tourne déjà.

    ``mtime``/``age_seconds`` valent ``None`` quand le fichier est absent ou
    illisible : l'absence d'information ne doit jamais faire échouer la lecture
    du log.
    """
    try:
        mtime = os.stat(path).st_mtime
    except (OSError, TypeError, ValueError):  # chemin invalide, fichier absent
        return {"mtime": None, "age_seconds": None}
    # Horloge du container en avance sur le mtime (rare) → jamais négatif.
    return {"mtime": mtime, "age_seconds": max(0, int(time.time() - mtime))}


def read_log_tail(
    path: Path | str = COMFY_LOG_PATH,
    lines: int = 200,
    max_bytes: int | None = None,
) -> dict:
    """Lit les dernières lignes d'un log ComfyUI en bornant la lecture.

    Fonction pure (aucun accès réseau, aucun accès à l'instance du worker) :
    elle est partagée par ``ComfyWorker.logs_tail`` (repli côté GPU) et par les
    fonctions CPU ``read_worker_logs`` des apps — les deux chemins doivent
    renvoyer exactement le même format.

    Parameters
    ----------
    path : Path | str
        Fichier à lire (par défaut ``COMFY_LOG_PATH``, sur le volume).
    lines : int
        Nombre de lignes demandées (borné à 2000, minimum 1).
    max_bytes : int | None
        Fenêtre de lecture (défaut ``COMFY_LOG_MAX_BYTES``).

    Returns
    -------
    dict
        ``{"lines": [...], "path": str, "size": int, "mtime": float,
        "age_seconds": int}`` ou, en cas de problème, ``{"lines": [],
        "path": str, "error": str}`` avec ``mtime``/``age_seconds`` à ``None``.
    """
    log_path = Path(path)
    window = COMFY_LOG_MAX_BYTES if max_bytes is None else max_bytes
    try:
        if not log_path.is_file():
            return {
                "lines": [],
                "path": str(log_path),
                "error": "log file not found",
                **log_freshness(log_path),
            }
        size = log_path.stat().st_size
        # Lecture bornée : on ne charge que la fin du fichier (une fenêtre
        # suffit largement pour 2000 lignes) et on jette la première ligne
        # si elle est probablement coupée par le seek.
        with open(log_path, "rb") as f:
            if size > window:
                f.seek(size - window)
                f.readline()
            content = f.read().decode("utf-8", errors="replace")
        tail = content.splitlines()[-max(1, min(int(lines), 2000)):]
        return {
            "lines": tail,
            "path": str(log_path),
            "size": size,
            **log_freshness(log_path),
        }
    except (OSError, TypeError, ValueError) as e:
        return {
            "lines": [],
            "path": str(log_path),
            "error": str(e),
            **log_freshness(log_path),
        }


def rotate_log(path: Path | str = COMFY_LOG_PATH) -> None:
    """Tronque *path* à ses derniers ``COMFY_LOG_KEEP_BYTES`` s'il est trop gros.

    Appelée au lancement de ComfyUI : le log vit sur un volume persistant, il
    ne doit donc pas grossir sans fin. Best effort — une erreur d'E/S
    n'empêche pas le démarrage (le pire cas est un log un peu plus long).
    """
    log_path = Path(path)
    try:
        size = log_path.stat().st_size
        if size <= COMFY_LOG_MAX_BYTES:
            return
        with open(log_path, "rb") as f:
            f.seek(size - COMFY_LOG_KEEP_BYTES)
            kept = f.read().split(b"\n", 1)
        # On jette la première ligne : probablement coupée par le seek.
        body = kept[1] if len(kept) > 1 else kept[0]
        with open(log_path, "wb") as f:
            f.write(body)
    except OSError:
        pass


def _fallback_cli_log_paths() -> list[Path]:
    """Chemins candidats des logs internes écrits par ``comfy-cli``.

    Returns
    -------
    list[Path]
        Candidats dans l'ordre de préférence (``~`` développé). Le premier
        fichier existant est utilisé comme complément de ``logs_tail``.
    """
    return [Path(p).expanduser() for p in COMFY_CLI_LOG_CANDIDATES]


def _append_cli_log_fallback(
    result: dict, lines: int = COMFY_CLI_LOG_TAIL_LINES
) -> dict:
    """Complète un log principal quasi vide par celui de comfy-cli.

    Quand ComfyUI est lancé par le wrapper ``comfy launch`` (repli), notre
    ``COMFY_LOG_PATH`` ne contient que 3-4 lignes du wrapper : le serveur
    daemonisé écrit ailleurs. Si le log principal fait moins de
    ``COMFY_CLI_LOG_MIN_BYTES`` et qu'un log interne existe, on concatène ses
    dernières lignes derrière un séparateur explicite.

    Parameters
    ----------
    result : dict
        Résultat de ``read_log_tail`` (non modifié : une copie est renvoyée).
    lines : int
        Nombre de lignes à reprendre du log interne.

    Returns
    -------
    dict
        ``result`` inchangé, ou complété des clés ``lines`` (concaténées),
        ``fallback_path`` et ``fallback_size``. ``mtime``/``age_seconds``
        restent ceux du log **principal** (c'est lui qui dit quand un
        container a réellement démarré, pas le log interne du wrapper).
    """
    if result.get("error"):
        return result
    if (result.get("size") or 0) >= COMFY_CLI_LOG_MIN_BYTES:
        return result

    for candidate in _fallback_cli_log_paths():
        try:
            if not candidate.is_file():
                continue
        except OSError:
            continue
        extra = read_log_tail(candidate, lines)
        if extra.get("error") or not extra.get("lines"):
            return result
        merged = dict(result)  # mtime/age_seconds du log principal conservés
        merged["lines"] = list(result.get("lines") or []) + [
            f"───── log interne comfy-cli ({candidate}) ─────"
        ] + list(extra["lines"])
        merged["fallback_path"] = str(candidate)
        merged["fallback_size"] = extra.get("size")
        return merged
    return result


def _comfyui_version(root: Path | str | None = None) -> str:
    """Version de ComfyUI lue dans ``comfyui_version.py`` (best effort)."""
    base = COMFY_ROOT if root is None else Path(root)
    try:
        for line in (base / "comfyui_version.py").read_text(
            encoding="utf-8", errors="replace"
        ).splitlines():
            stripped = line.strip()
            if stripped.startswith("__version__"):
                return stripped.split("=", 1)[1].strip().strip("\"'")
    except (OSError, IndexError):
        pass
    return "version inconnue"


def _count_custom_node_dirs(path: Path | str | None = None) -> int:
    """Nombre de dossiers présents dans ``custom_nodes/`` (best effort).

    Sert de diagnostic au lancement : si ce compte est nul, les symlinks du
    volume n'ont pas été créés et ComfyUI répondra ``missing_node_type`` quoi
    qu'il arrive.
    """
    base = Path(COMFY_CUSTOM_NODES_DIR if path is None else path)
    try:
        return sum(1 for entry in base.iterdir() if entry.is_dir())
    except OSError:
        return 0


def read_worker_build_id(path: Path | str | None = None) -> str:
    """Lit l'empreinte gravée dans le snapshot (``""`` si absente).

    Un snapshot pris par une version antérieure ne contient pas le fichier :
    l'absence est donc traitée comme « code inconnu », c'est-à-dire « différent
    du code courant » → redémarrage de ComfyUI.
    """
    target = WORKER_BUILD_ID_PATH if path is None else Path(path)
    try:
        return target.read_text().strip()
    except OSError:
        return ""


def write_worker_build_id(path: Path | str | None = None) -> str:
    """Grave l'empreinte courante sur le volume (best effort).

    Returns
    -------
    str
        L'empreinte écrite, ou ``""`` si l'écriture a échoué (volume absent ou
        en lecture seule : le démarrage de ComfyUI ne doit jamais en échouer).
    """
    target = WORKER_BUILD_ID_PATH if path is None else Path(path)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(WORKER_BUILD_ID)
        return WORKER_BUILD_ID
    except OSError as e:
        print(f"[ComfyWorker] ⚠️ Empreinte non écrite dans {target} : {e}")
        return ""


def commit_log_volume() -> None:
    """Commit best effort du volume qui porte le log (``comfy-models``).

    Sans commit, le log écrit par le container GPU n'est visible des autres
    containers (dont la fonction CPU de lecture) qu'à l'arrêt du container.
    L'appel est facultatif : Modal commite aussi le volume en arrière-plan et
    à l'arrêt du container — un échec ne doit jamais faire échouer le
    démarrage de ComfyUI.
    """
    try:
        modal.Volume.from_name(COMFY_LOG_VOLUME_NAME).commit()
    except Exception:  # noqa: BLE001 — volume non monté / API indisponible
        pass


# ── Base worker ─────────────────────────────────────────────────────────


class ComfyWorker:
    """Headless ComfyUI worker — classe de base.

    Les sous-classes surchargent ``gpu_type`` et ``scaledown_window``
    pour choisir le GPU et le délai de mise à l'échelle.

    Le décorateur ``@app.cls(gpu=cls.gpu_type, ...)`` est appliqué
    dans l'app qui importe la classe (ex. ``apps/all_in_one.py``).

    Starts ComfyUI in the background on container start (with GPU snapshot
    support) and exposes its REST API via ``@modal.web_endpoint`` methods
    that proxy requests to ``http://127.0.0.1:8000``.
    """

    # ── Paramètres GPU (surchargés par les sous-classes) ──────────────
    gpu_type: str = "L4"
    """Type de GPU Modal (``L4``, ``L40S``, ``A100-80GB``, ``H100``)."""

    scaledown_window: int = 60
    """Nombre de secondes d'inactivité avant l'arrêt du container."""

    # ── Lifecycle ───────────────────────────────────────────────────────

    @modal.enter(snap=True)
    def start_checkpoint(self) -> None:
        """Prepare the filesystem from the volumes, then launch ComfyUI.

        Contrainte forte : ComfyUI ne scanne ``custom_nodes/`` qu'UNE SEULE
        FOIS, au moment de son démarrage. Tout symlink créé après le lancement
        est ignoré — le node reste introuvable (``missing_node_type``) alors
        même qu'il est bien présent sur le volume. D'où l'ordre imposé :
        liens/copies d'abord, ``subprocess.Popen`` ensuite.

        This method runs *before* the GPU snapshot is taken, so the snapshot
        captures ComfyUI in a fully-loaded state ready to serve requests.

        L'empreinte du code (``WORKER_BUILD_ID``) est gravée sur le volume
        AVANT tout le reste : c'est la trace que ``start_restore`` comparera à
        son propre code pour détecter un redéploiement (et invalider le
        snapshot, qui contient l'ancien process ComfyUI).

        Chaque étape est chronométrée : le bloc ``timing`` écrit dans le log
        sépare le coût de la préparation (volumes, symlinks, deps) de celui
        du lancement (``Popen``) et de l'attente réelle de disponibilité de
        ComfyUI (ouverture du port 8000) — c'est cette dernière qui domine.
        """
        started_at = time.time()
        timing = StartupTiming()

        # ── 0. Graver l'empreinte du code dans le snapshot ──
        write_worker_build_id()
        print(f"[ComfyWorker] build id: {WORKER_BUILD_ID}")
        # Commit explicite : l'empreinte doit être durable sur le volume, c'est
        # elle que ``start_restore`` relira après restauration du snapshot.
        commit_log_volume()

        # ── Préparer le système de fichiers AVANT de lancer ComfyUI ──
        # ComfyUI ne scanne custom_nodes/ qu'une seule fois à son démarrage :
        # tout symlink créé après le lancement est ignoré (missing_node_type).
        self._link_models_from_manifest()
        self._sync_custom_nodes_from_volume()
        self._restore_uploads_from_volume()
        self._sync_user_settings_from_volume()
        helpers_done_at = time.time()
        timing["préparation (volumes, symlinks, deps)"] = (
            helpers_done_at - started_at
        )

        self.proc = self._launch_comfy()
        launched_at = time.time()
        timing["lancement du process ComfyUI"] = launched_at - helpers_done_at

        # ``wait_for_port`` renvoie SA mesure : c'est le temps que ComfyUI a
        # réellement mis à devenir joignable (import des custom nodes, modèles).
        wait_started_at = time.time()
        wait_seconds = wait_for_port(8000, timeout=300)
        ready_at = time.time()
        timing["attente du port 8000 (ready)"] = _measured_seconds(
            wait_seconds, ready_at - wait_started_at
        )

        self._log_startup_timing(
            "démarrage (checkpoint)", timing, STARTUP_MODE_CHECKPOINT
        )

    def _log_startup_timing(
        self, title: str, timing: StartupTiming, mode: str = ""
    ) -> float:
        """Écrit le bloc de timing dans le log puis sur la stdout du worker.

        Le volume est commité dans la foulée : sans cela, le timing du
        démarrage n'apparaîtrait qu'à l'arrêt du container — c'est-à-dire trop
        tard pour diagnostiquer un démarrage lent.

        Returns
        -------
        float
            Le TOTAL mesuré, en secondes.
        """
        total = write_timing_block(title, list(timing.items()), mode=mode)
        print(
            f"[ComfyWorker] Démarrage ComfyUI terminé en {total:.1f}s"
            f" ({mode or title})"
        )
        commit_log_volume()
        return total

    def _launch_comfy(self):
        """Lance ComfyUI headless en capturant TOUTE sa sortie dans COMFY_LOG_PATH.

        On n'utilise volontairement pas ``comfy launch --background`` : ce
        wrapper **daemonise** ComfyUI et détourne sa stdout vers son propre log
        interne (``user/comfyui.log``), ce qui rend invisibles les erreurs
        d'import des custom nodes (``missing_node_type``), les tracebacks
        d'exécution et les erreurs réseau des nodes (401, timeout…). On lance
        donc ``main.py`` directement avec l'interpréteur courant : le process
        reste notre enfant, sa sortie arrive dans ``COMFY_LOG_PATH``.

        Le fichier est ouvert en append (les redémarrages s'ajoutent au lieu
        de s'écraser) et ``start_new_session=True`` détache le process du
        groupe courant pour qu'il survive à son parent.

        Le log vit sur le volume ``/cache`` (voir ``COMFY_LOG_PATH``) : il reste
        donc lisible par une fonction CPU après l'arrêt du container. Une
        rotation simple est appliquée au lancement (``rotate_log``) puis un
        commit best effort tente de rendre l'en-tête visible sans attendre
        l'arrêt du container.

        Returns
        -------
        subprocess.Popen
            Le process ComfyUI, à mémoriser sur ``self.proc``.

        Notes
        -----
        Le détail du lancement (préparation, ``Popen``) est mémorisé sur
        ``self._launch_timing`` : ``start_checkpoint``/``start_restore``
        l'incluent dans le bloc de timing pour distinguer le coût du ``fork``
        de celui, bien plus long, du chargement de ComfyUI (visible seulement
        via l'ouverture du port).
        """
        launch_started = time.time()
        COMFY_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        rotate_log(COMFY_LOG_PATH)

        comfy_root = Path(COMFY_ROOT)
        main_py = comfy_root / "main.py"
        # Diagnostics écrits AVANT le lancement : sans eux, un log vide serait
        # indiscernable d'un ComfyUI mort au démarrage.
        node_dirs = _count_custom_node_dirs()
        main_py_ok = main_py.is_file()
        version = _comfyui_version(comfy_root) if main_py_ok else "absente"
        prepared_at = time.time()

        env = os.environ.copy()
        # Logs temps réel : sans ces deux variables, Python bufferise par blocs
        # et un traceback d'import de node n'apparaît qu'au flush/arrêt.
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"

        with open(COMFY_LOG_PATH, "a") as log_file:
            log_file.write(
                f"\n===== ComfyUI start {datetime.now().isoformat()} =====\n"
            )
            # L'empreinte du worker en tête du log : elle dit immédiatement
            # QUELLE version du code a lancé ce ComfyUI (et donc si une relance
            # a bien eu lieu après un redéploiement).
            log_file.write(f"build_id: {WORKER_BUILD_ID}\n")
            if main_py_ok:
                cmd: list[str] | str = [
                    sys.executable,
                    str(main_py),
                    "--listen",
                    "0.0.0.0",
                    "--port",
                    "8000",
                ]
                log_file.write(f"commande: {' '.join(cmd)}\n")
                log_file.write(f"main.py: présent (ComfyUI {version})\n")
            else:
                # Repli : comportement historique (sortie partielle — le wrapper
                # daemonise —, mais le serveur démarre).
                cmd = "comfy launch --background -- --listen 0.0.0.0 --port 8000"
                log_file.write(f"commande: {cmd}\n")
                log_file.write(f"main.py: {main_py} introuvable — repli comfy-cli\n")
            log_file.write(f"custom_nodes: {node_dirs} dossier(s)\n")
            log_file.flush()

            popen_kwargs: dict = {
                "stdout": log_file,
                "stderr": subprocess.STDOUT,
                "start_new_session": True,
            }
            if main_py_ok:
                proc = subprocess.Popen(
                    cmd, cwd=str(comfy_root), env=env, **popen_kwargs
                )
            else:
                proc = subprocess.Popen(cmd, shell=True, **popen_kwargs)
            popen_done_at = time.time()
        # Hors du ``with`` : le process garde son propre descripteur du fichier.
        commit_log_volume()

        # ``Popen`` rend la main dès le fork : la durée mesurée ici ne dit RIEN
        # du temps de chargement de ComfyUI (c'est ``wait_for_port`` qui le
        # mesure). On la conserve pour montrer que le lancement n'est pas le
        # goulot d'étranglement.
        self._launch_timing = {
            "préparation du lancement (rotate, diagnostics)": max(
                0.0, prepared_at - launch_started
            ),
            "Popen (fork/exec)": max(0.0, popen_done_at - prepared_at),
        }
        print(
            "[ComfyWorker] ComfyUI lancé (pid {}) : préparation {:.1f}s, "
            "Popen {:.1f}s".format(
                getattr(proc, "pid", "?"),
                self._launch_timing["préparation du lancement (rotate, diagnostics)"],
                self._launch_timing["Popen (fork/exec)"],
            )
        )
        return proc

    def _restore_uploads_from_volume(self):
        """Copy user-uploaded images from the volume to the ComfyUI input dir.

        Les images uploadées via /upload/image sont persistées dans
        /cache/uploads (volume) pour survivre au redémarrage du container —
        sinon une image uploadée sur un worker serait perdue si le container
        s'arrête (scaledown) avant le /generate.
        """
        uploads_dir = Path("/cache/uploads")
        input_dir = Path("/root/comfy/ComfyUI/input")
        if not uploads_dir.is_dir():
            return

        input_dir.mkdir(parents=True, exist_ok=True)
        count = 0
        for f in uploads_dir.iterdir():
            if f.is_file() and not f.name.startswith("."):
                dst = input_dir / f.name
                if not dst.exists():
                    shutil.copy2(str(f), str(dst))
                    count += 1

        print(f"[ComfyWorker] Restored {count} upload(s) from volume")

    def _sync_user_settings_from_volume(self):
        """Copy user settings from the mounted volume to the ComfyUI user/ directory."""
        vol_path = USER_SETTINGS_VOLUME_PATH
        user_path = USER_SETTINGS_DIR

        if not vol_path.is_dir():
            print("[ComfyWorker] No user-settings volume mounted")
            return

        if not any(vol_path.iterdir()):
            print("[ComfyWorker] User settings volume is empty — skipping")
            return

        import shutil
        user_path.mkdir(parents=True, exist_ok=True)

        # Copy each item from the volume to the user directory
        count = 0
        databases = []
        for item in vol_path.iterdir():
            dest = user_path / item.name
            if item.is_dir():
                shutil.copytree(str(item), str(dest), dirs_exist_ok=True)
                copied = [p for p in item.rglob("*") if p.is_file()]
            elif item.is_file():
                shutil.copy2(str(item), str(dest))
                copied = [item]
            else:
                continue
            count += len(copied)
            databases.extend(
                p.name for p in copied if p.suffix.lower() in (".db", ".sqlite")
            )

        # Les bases SQLite portent les réglages des custom nodes (ex. les
        # credentials de ComfyUI-AI-Helper) : les nommer confirme, depuis les
        # logs du worker, qu'elles sont bien arrivées.
        message = f"[ComfyWorker] user settings: {count} fichier(s) copié(s)"
        if databases:
            message += (
                f", dont {len(databases)} base(s) SQLite : {sorted(databases)}"
            )
        print(message)

    def _link_models_from_manifest(self):
        """Read /cache/model_manifest.json and create symlinks in ComfyUI model dirs."""
        import json
        manifest_path = Path("/cache") / "model_manifest.json"
        if not manifest_path.exists():
            print("[ComfyWorker] No model manifest found — skipping symlink creation")
            return

        try:
            manifest = json.loads(manifest_path.read_text())
        except (json.JSONDecodeError, OSError) as e:
            print(f"[ComfyWorker] Failed to read manifest: {e}")
            return

        models_root = Path("/root/comfy/ComfyUI/models")
        linked = 0
        for filename, model_dir in manifest.items():
            cache_file = Path("/cache") / filename
            if not cache_file.exists():
                print(f"[ComfyWorker] Model file not in volume: {filename}")
                continue

            target_dir = models_root / model_dir
            target_dir.mkdir(parents=True, exist_ok=True)
            target_path = target_dir / filename

            if target_path.exists() or target_path.is_symlink():
                target_path.unlink()

            target_path.symlink_to(cache_file)
            linked += 1

        print(f"[ComfyWorker] Created {linked} model symlinks from manifest")

    def _sync_custom_nodes_from_volume(self) -> int:
        """Symlink each custom node from /custom_nodes volume into ComfyUI.

        Répartition des responsabilités : **le build porte les deps, le volume
        porte le code**. ``image.py`` installe les ``requirements.txt`` de tous
        les nodes locaux dans l'image (dépendances persistantes, donc payées une
        seule fois), le volume ne transporte que le code des nodes. Au démarrage
        cette méthode ne fait donc que créer les symlinks — quelques
        millisecondes par node — au lieu de rejouer ``pip install`` + ``install.py``
        pour chacun (mesuré : 141-187 s pour 30 nodes).

        L'installation runtime reste disponible en secours (``install.py``,
        ``requirements.txt`` d'un node ajouté sans rebuild) : elle n'a lieu que
        si ``INSTALL_NODE_DEPS_AT_STARTUP`` est vrai
        (``COMFYCH_INSTALL_DEPS=1``). Les échecs sont loggés en warning sans
        jamais faire échouer le démarrage du worker.

        Chaque node est chronométré ; si la préparation dépasse
        ``PREP_SLOW_THRESHOLD_SECONDS``, un top des nodes les plus lents est
        écrit dans le log (garde-fou de perf).

        Returns
        -------
        int
            Nombre de symlinks **créés** par cet appel (les nodes déjà présents
            ne sont pas comptés : ComfyUI les a déjà chargés au démarrage
            courant). Un retour > 0 signifie donc que ComfyUI doit être
            (re)démarré pour voir ces nouveaux nodes.
        """
        vol_path = CUSTOM_NODES_VOLUME_PATH
        comfy_path = COMFY_CUSTOM_NODES_DIR

        if not vol_path.is_dir():
            print(
                "[ComfyWorker] ⚠️ volume /custom_nodes NON MONTÉ — aucun custom node "
                "ne sera chargé. Redéployez (modal deploy apps/all_in_one.py)."
            )
            return 0

        names = sorted(
            p.name for p in vol_path.iterdir()
            if p.is_dir() and not p.name.startswith(".")
        )
        if not names:
            print("[ComfyWorker] /custom_nodes est vide — aucun node à lier")
            return 0

        print(f"[ComfyWorker] Nodes trouvés sur le volume : {names}")
        if not INSTALL_NODE_DEPS_AT_STARTUP:
            print(
                "[ComfyWorker] deps des nodes déjà installées au build "
                "(COMFYCH_INSTALL_DEPS=0) — étape ignorée"
            )

        comfy_path.mkdir(parents=True, exist_ok=True)
        linked = 0
        existing = 0
        node_seconds: list[tuple[str, float]] = []
        for name in names:
            node_started_at = time.time()
            try:
                item = vol_path / name
                dst = comfy_path / name
                if dst.exists() or dst.is_symlink():
                    existing += 1
                else:
                    try:
                        dst.symlink_to(item)
                        linked += 1
                    except OSError as e:
                        print(f"[ComfyWorker] ⚠️ Impossible de lier {name} : {e}")
                        continue

                # Deps + install.py : opt-in seulement (faites au build sinon).
                if INSTALL_NODE_DEPS_AT_STARTUP:
                    self._install_node_requirements(item)
                    self._run_node_install_script(item)
            finally:
                # Mesuré même en cas d'échec de symlink (``continue``) : le
                # top des nodes lents doit refléter tout ce qui a coûté du temps.
                node_seconds.append((name, time.time() - node_started_at))

        print(f"[ComfyWorker] Custom nodes : {linked} lié(s), {existing} déjà présent(s)")
        try:
            write_slowest_nodes_block(node_seconds)
        except Exception as e:  # noqa: BLE001 — la mesure ne casse jamais le démarrage
            print(f"[ComfyWorker] ⚠️ top des nodes lents indisponible : {e}")
        return linked

    def _install_node_requirements(self, node_dir: Path) -> None:
        """Install a custom node's pip dependencies from its requirements.txt.

        Best-effort : pip est idempotent, donc re-installer des deps déjà
        cuites dans l'image au build est un no-op rapide. Les échecs sont
        loggés, jamais levés.
        """
        req_file = node_dir / "requirements.txt"
        if not req_file.is_file():
            return
        try:
            result = subprocess.run(
                [sys.executable, "-m", "pip", "install", "-r", str(req_file)],
                capture_output=True, timeout=600,
            )
            if result.returncode != 0:
                detail = (result.stderr or result.stdout or b"").decode(errors="replace").strip()
                print(f"[ComfyWorker] ⚠️ Failed to install deps for {node_dir.name}: {detail[-500:]}")
        except (subprocess.TimeoutExpired, OSError) as e:
            print(f"[ComfyWorker] ⚠️ Error installing deps for {node_dir.name}: {e}")

    def _run_node_install_script(self, node_dir: Path) -> None:
        """Run a custom node's install.py if present (best-effort)."""
        install_py = node_dir / "install.py"
        if not install_py.is_file():
            return
        try:
            result = subprocess.run(
                [sys.executable, str(install_py)],
                capture_output=True, timeout=600,
            )
            if result.returncode != 0:
                detail = (result.stderr or result.stdout or b"").decode(errors="replace").strip()
                print(f"[ComfyWorker] ⚠️ install.py failed for {node_dir.name}: {detail[-500:]}")
        except (subprocess.TimeoutExpired, OSError) as e:
            print(f"[ComfyWorker] ⚠️ Error running install.py for {node_dir.name}: {e}")

    @modal.enter(snap=False)
    def start_restore(self) -> None:
        """Restore the filesystem from the volumes, then ensure ComfyUI is up.

        Le snapshot contient ComfyUI déjà lancé. Les liens sont donc créés ici
        AVANT le test du port : si de nouveaux custom nodes ont été
        synchronisés depuis la prise du snapshot, le delta est connu avant de
        décider du redémarrage (ComfyUI ne rescanne ``custom_nodes/`` qu'à son
        démarrage).

        Si ComfyUI ne répond pas (crash avant le snapshot), il est relancé.

        Le port qui répond ne dit **pas** quelle version de ComfyUI écoute : un
        snapshot GPU pris par un ancien déploiement peut être réutilisé, et son
        process ComfyUI (ancien code) répond sur 8000. On compare donc
        l'empreinte du code gravée dans le snapshot (``WORKER_BUILD_ID_PATH``)
        à ``WORKER_BUILD_ID`` ; si elles diffèrent, on ne fait pas confiance au
        port : le process restauré est tué et ComfyUI est relancé par le code
        courant (``_launch_comfy``), ce qui recharge le nouveau code.

        Le bloc ``timing`` écrit dans le log dit **quel mode** a été retenu :
        ``restauré depuis snapshot`` (le port répondait, rien à recharger —
        quelques secondes) ou ``redémarrage forcé (…)`` (code modifié, nouveaux
        nodes ou cold start — c'est là que se jouent les dizaines de secondes).
        """
        started_at = time.time()
        timing = StartupTiming()

        # ── 1. Détecter un redéploiement (empreinte du snapshot vs actuelle) ──
        snapshot_build_id = read_worker_build_id()
        code_changed = snapshot_build_id != WORKER_BUILD_ID
        if code_changed:
            print(
                f"[ComfyWorker] ⚠️ Code du worker modifié depuis le snapshot "
                f"(snapshot={snapshot_build_id or 'inconnu'}, actuel={WORKER_BUILD_ID}) "
                f"— redémarrage de ComfyUI pour charger le nouveau code"
            )
        checked_at = time.time()
        timing["vérification build id"] = checked_at - started_at

        # ── 2. Décider si ComfyUI tourne déjà — sans se fier au port à l'aveugle ──
        comfy_already_running = False
        shutdown_seconds = 0.0
        mode = STARTUP_MODE_SNAPSHOT
        if code_changed:
            # Le process du snapshot est l'ANCIEN code : le port répondrait,
            # mais ce serait l'ancien ComfyUI. On l'arrête avant tout test.
            shutdown_seconds += self._timed_shutdown()
            mode = STARTUP_MODE_CODE_CHANGED
        after_shutdown_at = time.time()

        # ── 3. Préparer le système de fichiers AVANT tout lancement ──
        self._link_models_from_manifest()
        self._restore_uploads_from_volume()
        self._sync_user_settings_from_volume()
        new_nodes = self._sync_custom_nodes_from_volume()
        helpers_done_at = time.time()
        timing["préparation (volumes, symlinks, deps)"] = (
            helpers_done_at - after_shutdown_at
        )

        # ── 4. Test du port : snapshot réutilisable, ou cold start à mesurer ──
        snapshot_wait_seconds = 0.0
        if not code_changed:
            probe_started_at = time.time()
            try:
                snapshot_wait_seconds = _measured_seconds(
                    wait_for_port(8000, timeout=30),
                    time.time() - probe_started_at,
                )
                comfy_already_running = True
                print("[ComfyWorker] ComfyUI is running from snapshot")
            except (TimeoutError, OSError):
                # Le port n'est jamais venu : ce délai fait partie du coût réel
                # du cold start, on le compte dans « attente/relance ».
                snapshot_wait_seconds = max(
                    snapshot_wait_seconds, time.time() - probe_started_at
                )
                print("[ComfyWorker] ComfyUI not responding after snapshot — cold restarting...")
                mode = STARTUP_MODE_COLD

        # ComfyUI n'a scanné custom_nodes/ qu'au moment du snapshot :
        # si de nouveaux nodes ont été synchronisés depuis, il faut le relancer.
        # (En pratique le cas ``code_changed`` a déjà tué le process ci-dessus ;
        # la condition reste pour couvrir un reliquat de snapshot.)
        if comfy_already_running and (new_nodes > 0 or code_changed):
            if new_nodes > 0:
                print(
                    f"[ComfyWorker] {new_nodes} nouveau(x) node(s) détecté(s) — "
                    "redémarrage de ComfyUI pour les charger"
                )
            shutdown_seconds += self._timed_shutdown()
            comfy_already_running = False
            mode = STARTUP_MODE_NEW_NODES
        timing["arrêt éventuel de ComfyUI"] = shutdown_seconds

        restart_wait_seconds = 0.0
        if not comfy_already_running:
            self.proc = self._launch_comfy()
            relaunch_started_at = time.time()
            restart_wait_seconds = _measured_seconds(
                wait_for_port(8000, timeout=300),
                time.time() - relaunch_started_at,
            )
            # Garde-fou : un port qui répond ne prouve rien si le process qu'on
            # vient de lancer est mort aussitôt (port 8000 déjà tenu par un
            # ComfyUI du snapshot) — on servirait alors encore l'ancien code.
            poll = getattr(self.proc, "poll", None)
            exit_code = poll() if callable(poll) else None
            if exit_code is not None:
                print(
                    f"[ComfyWorker] ⚠️ Le ComfyUI relancé est déjà sorti "
                    f"(code {exit_code}) : le port 8000 est probablement tenu "
                    f"par un process du snapshot (ancien code)"
                )
            if exit_code is None:
                print("[ComfyWorker] ComfyUI (re)démarré — custom nodes chargés")
                # Le code qui tourne est maintenant celui-ci : on grave
                # l'empreinte pour que la prochaine restauration ne redémarre
                # pas inutilement.
                write_worker_build_id()
                commit_log_volume()
        timing["attente/relance ComfyUI"] = (
            snapshot_wait_seconds + restart_wait_seconds
        )

        self._log_startup_timing("restauration (snapshot)", timing, mode)

        print("[ComfyWorker] App restored from snapshot!")

    def _timed_shutdown(self, timeout: float = 10) -> float:
        """``_shutdown_comfy`` chronométré — 0.0 s quand rien n'est arrêté."""
        had_proc = getattr(self, "proc", None) is not None
        started_at = time.time()
        self._shutdown_comfy(timeout=timeout)
        elapsed = max(0.0, time.time() - started_at)
        # Rien à arrêter → 0.0 s exactement : la phase ne doit pas afficher un
        # bruit de mesure d'horloge dans le bloc de timing.
        return elapsed if had_proc else 0.0

    def _shutdown_comfy(self, timeout: float = 10) -> None:
        """Arrête proprement le process ComfyUI (terminate, puis kill en secours)."""
        proc = getattr(self, "proc", None)
        if proc is None:
            return
        self.proc = None
        try:
            proc.terminate()
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                proc.kill()
                print("[ComfyWorker] ComfyUI ne s'est pas arrêté proprement — kill")
            print("[ComfyWorker] ComfyUI process terminated")
        except (ProcessLookupError, OSError) as e:
            print(f"[ComfyWorker] ComfyUI shutdown: {e}")

    @modal.exit()
    def cleanup(self) -> None:
        """Terminate the ComfyUI process on container shutdown."""
        self._shutdown_comfy()

    # ── Proxy methods (called by the router via .remote()) ───────────────

    @modal.method()
    async def prompt(self, workflow: dict) -> dict:
        """Proxy to ComfyUI's ``POST /prompt``.

        Accepts a workflow JSON object and returns the prompt result
        (including the ``prompt_id``).  Called by the router via ``.remote()``.

        Non-node keys (metadata like ``"workflow"``, ``"extra_data"``,
        ``"version"``, etc.) are filtered out so that ComfyUI does not
        try to parse them as nodes and fail with a ``missing_node_type``
        error.
        """
        # ── Extraire extra_data avant le filtrage (il contient les images base64) ──
        extra_data = workflow.pop("extra_data", None) or {}

        # Restaurer les images embarquées (<4 Mo) dans le dossier input de ComfyUI
        for img in extra_data.get("images", []) or []:
            try:
                await self._restore_embedded_image(img)
            except Exception as e:
                print(f"[ComfyWorker] Failed to restore embedded image: {e}")

        # Filter out non-node keys (metadata like "workflow", "extra_data", "version", etc.)
        clean_workflow = {
            k: v for k, v in workflow.items()
            if isinstance(v, dict) and "class_type" in v
        }
        print(f"[ComfyWorker] Workflow: {len(workflow)} keys in, {len(clean_workflow)} kept. Keys filtered out: {set(workflow.keys()) - set(clean_workflow.keys())}")
        print(f"[ComfyWorker] Clean workflow keys: {list(clean_workflow.keys())}")
        print(f"[ComfyWorker] Has SaveImage? {'SaveImage' in str(clean_workflow)}")
        if len(clean_workflow) != len(workflow):
            print(f"[ComfyWorker] Filtered {len(workflow) - len(clean_workflow)} non-node keys from workflow")

        # Passthrough de extra_data SANS la clé "images" (déjà restaurées ci-dessus)
        payload = {"prompt": clean_workflow, "client_id": "modal-gateway"}
        passthrough_extra = {k: v for k, v in extra_data.items() if k != "images"}
        if passthrough_extra:
            payload["extra_data"] = passthrough_extra

        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "http://127.0.0.1:8000/prompt",
                json=payload,
            )
            if resp.status_code != 200:
                error_text = resp.text
                print(f"[ComfyWorker] /prompt error {resp.status_code}: {error_text}")
                return {"error": f"ComfyUI returned {resp.status_code}: {error_text}"}
            return resp.json()

    async def _restore_embedded_image(self, img: dict) -> None:
        """Restore a base64-embedded image into ComfyUI's input folder.

        The JS extension stores small (<4 Mo) images base64-encoded inside
        ``extra_data.images[]``. ComfyUI's ``/prompt`` cannot read those
        directly, so each image is re-uploaded via ``/upload/image`` before
        submitting the prompt.

        Raises
        ------
        RuntimeError
            If ComfyUI's /upload/image returns a non-200 status.
        """
        imagebase64 = img.get("imagebase64", "")
        if not imagebase64:
            return
        content = base64.b64decode(imagebase64)
        filename = img.get("filename") or img.get("name") or "image.png"
        subfolder = img.get("subfolder", "")

        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "http://127.0.0.1:8000/upload/image",
                files={"image": (filename, content)},
                data={
                    "subfolder": subfolder,
                    "type": "input",
                    "overwrite": "true",
                },
            )
            if resp.status_code != 200:
                raise RuntimeError(
                    f"/upload/image returned {resp.status_code}: {resp.text}"
                )

    @modal.method()
    async def history(self, job_id: str) -> dict:
        """Proxy to ComfyUI's ``GET /history/{job_id}``.

        Query parameter ``job_id`` is the prompt ID returned by ``/prompt``.
        Returns the execution history for that prompt.  Called via ``.remote()``.
        """
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"http://127.0.0.1:8000/history/{job_id}",
            )
            if resp.status_code != 200:
                error_text = resp.text
                print(f"[ComfyWorker] /history error {resp.status_code}: {error_text}")
                return {"error": f"ComfyUI returned {resp.status_code}: {error_text}"}
            return resp.json()

    @modal.method()
    async def upload_image(self, image: bytes, subfolder: str = "", image_type: str = "input") -> dict:
        """Proxy to ComfyUI's ``POST /upload/image``.

        Accepts raw image bytes and optional metadata.  Returns the uploaded
        image reference that can be used in a workflow.  Called via ``.remote()``.

        Parameters
        ----------
        image : bytes
            Raw image file content (PNG, JPG, etc.).
        subfolder : str, optional
            Subfolder within the ComfyUI input directory.
        image_type : str, optional
            Type of image folder (``"input"``, ``"output"``, ``"temp"``).
            Defaults to ``"input"``.
        """
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "http://127.0.0.1:8000/upload/image",
                files={"image": image},
                data={
                    "subfolder": subfolder,
                    "type": image_type,
                },
            )
            if resp.status_code != 200:
                error_text = resp.text
                print(f"[ComfyWorker] /upload/image error {resp.status_code}: {error_text}")
                return {"error": f"ComfyUI returned {resp.status_code}: {error_text}"}
            result = resp.json()

        # ── Persist uploaded file to the shared volume ──────────────────
        # L'image est copiée dans /cache/uploads (volume) pour survivre au
        # scaledown/restart du container. Les workers la restaurent dans leur
        # dossier input au démarrage (_restore_uploads_from_volume).
        try:
            filename = result.get("name", "")
            if filename:
                input_root = Path("/root/comfy/ComfyUI/input")
                src = (input_root / subfolder / filename) if subfolder else (input_root / filename)
                if src.is_file():
                    uploads_dir = Path("/cache/uploads")
                    uploads_dir.mkdir(parents=True, exist_ok=True)
                    dst = uploads_dir / filename
                    if dst.exists() or dst.is_symlink():
                        dst.unlink()
                    shutil.copy2(str(src), str(dst))
                    vol = modal.Volume.from_name("comfy-models")
                    vol.commit()
                    print(f"[ComfyWorker] Upload persisted to volume: {filename}")
        except Exception as e:
            print(f"[ComfyWorker] Upload persist failed (non-fatal): {e}")

        return result

    @modal.method()
    async def view(self, filename: str, subfolder: str = "", view_type: str = "output") -> dict:
        """Proxy to ComfyUI's ``GET /view``.

        Retrieves a generated image or file from the ComfyUI output/input
        directories.  Called via ``.remote()``.

        Parameters
        ----------
        filename : str
            Name of the file to retrieve.
        subfolder : str, optional
            Subfolder within the type directory.
        view_type : str, optional
            Type of folder (``"output"``, ``"input"``, ``"temp"``).
            Defaults to ``"output"``.

        Returns
        -------
        dict
            A dict with ``"data"`` (base64-encoded file content),
            ``"content_type"``, and ``"filename"`` so the client can
            reconstruct the binary response.
        """
        import base64

        async with httpx.AsyncClient() as client:
            resp = await client.get(
                "http://127.0.0.1:8000/view",
                params={
                    "filename": filename,
                    "subfolder": subfolder,
                    "type": view_type,
                },
            )
            if resp.status_code != 200:
                error_text = resp.text
                print(f"[ComfyWorker] /view error {resp.status_code}: {error_text}")
                return {"data": "", "content_type": "", "filename": filename, "error": f"ComfyUI /view returned {resp.status_code}: {error_text}"}
            return {
                "data": base64.b64encode(resp.content).decode("ascii"),
                "content_type": resp.headers.get("content-type", "application/octet-stream"),
                "filename": filename,
            }

    @modal.method()
    async def logs_tail(self, lines: int = 200) -> dict:
        """Retourne les N dernières lignes du log ComfyUI du worker.

        Le log (``COMFY_LOG_PATH``) contient la sortie de ComfyUI : c'est le
        seul endroit où apparaissent les tracebacks d'import des custom nodes,
        les dépendances pip manquantes ou les erreurs réseau d'un node (401,
        timeout…) qui se traduisent côté client par un ``missing_node_type``
        ou un HTTP 500 sans détail.

        Si ce log est quasi vide (moins de ``COMFY_CLI_LOG_MIN_BYTES``), on le
        complète par les dernières lignes du log interne de ``comfy-cli`` :
        c'est le seul contenu disponible quand ComfyUI a été lancé par le
        wrapper ``comfy launch`` (repli) qui daemonise le serveur.

        Parameters
        ----------
        lines : int, optional
            Nombre de lignes demandées (borné à 2000, minimum 1).

        Returns
        -------
        dict
            ``{"lines": [...], "path": str, "size": int, "mtime": float,
            "age_seconds": int}`` ou, en cas de problème, ``{"lines": [],
            "path": str, "error": str}`` (``mtime``/``age_seconds`` à ``None``).
            Clés supplémentaires ``fallback_path``/``fallback_size`` quand le
            log interne de comfy-cli a été concaténé (``mtime``/
            ``age_seconds`` restent ceux du log principal).
        """
        # Repli historique : lire le log via un container GPU réveille le GPU
        # (cold start 1-3 min). Le chemin principal est la fonction CPU
        # ``read_worker_logs`` des apps (``build_router(logs_reader=...)``).
        # Le complément comfy-cli reste ici (méthode du worker) : la fonction
        # CPU n'a pas accès à ces chemins et doit garder le même format.
        return _append_cli_log_fallback(read_log_tail(COMFY_LOG_PATH, lines))
