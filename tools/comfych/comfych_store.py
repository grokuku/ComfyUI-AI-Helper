"""Persistance des réglages et des journaux de ComfyCH — HORS du pack.

Deux responsabilités, volontairement réunies ici (elles touchent les mêmes
deux chemins) :

1. **Emplacement des données.** Historiquement ComfyCH écrivait
   ``config.json`` (dont ``api_key``) et ``logs/`` DANS son dossier de code,
   c'est-à-dire dans ``custom_nodes/``. Le pack AI-Helper a un chantier dédié
   (« les données utilisateur ne vivent jamais dans le pack », cf.
   ``holaf_user_paths``) : les deux chemins passent donc par ses accesseurs —
   ``resolved_comfych_config()`` et ``resolved_comfych_logs()`` — qui savent
   suivre une migration (nouveau chemin si déplacé, ancien sinon).

2. **Import AUTOMATIQUE de l'ancienne configuration.** L'utilisateur ne sait
   pas où son ancien ``config.json`` a été écrit (l'extension a pu être posée à
   plat dans ``custom_nodes/ComfyCH``, dans un autre dossier, ou avoir gardé sa
   config dans ``~/.comfych``). Au démarrage, si la cible est ABSENTE et qu'un
   ancien fichier est trouvé, il est **copié** puis renommé ``*.migrated``
   (jamais supprimé). Si les deux existent, RIEN n'est écrasé : un
   avertissement explique quoi faire.

⚠️ La clé API n'est JAMAIS journalisée ni renvoyée dans un statut : les
messages ne citent que des CHEMINS et des compteurs.
"""
from __future__ import annotations

import json
import os
import shutil
import threading
from pathlib import Path

try:  # paquet (cas normal : tools.comfych chargé par le pack)
    from .comfych_paths import CODEFYCH_CODE_ROOT, custom_nodes_dirs
except ImportError:  # pragma: no cover - chargement à plat (script isolé)
    import sys as _sys

    _sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from comfych_paths import CODEFYCH_CODE_ROOT, custom_nodes_dirs  # type: ignore

# Nom du fichier de configuration historique (inchangé : c'est celui que
# l'utilisateur peut avoir sur son disque).
LEGACY_CONFIG_NAME = "config.json"

# Suffixe donné à l'ancien fichier après import (jamais de suppression).
MIGRATED_SUFFIX = ".migrated"

LOG_FILENAME = "last_operation.log"
STATUS_FILENAME = "last_operation.status"

DEFAULT_CONFIG = {
    "api_url": "",
    "api_key": "",
    # Nom de l'app Modal dont le bouton « Redémarrer le worker » arrête les
    # containers (vide = nom par défaut de apps/all_in_one.py). Utile quand
    # l'utilisateur déploie une variante (all_in_one_l4 → « modal-comfy-gateway-l4 »).
    "worker_app_name": "",
    "last_sync": None,
    "last_deploy": None,
    "last_user_sync": None,
    "custom_nodes": [],
    "custom_nodes_ext": [],
    "custom_nodes_local": [],
    # Paquets pip supplémentaires installés au build de l'image (dépendances
    # OPTIONNELLES des custom nodes, souvent absentes de leur requirements.txt :
    # ex. ``sageattention`` requis par comfyui-kjnodes, ``mediapipe`` pour
    # comfyui_facetools). Installés en best-effort (cf. image.py) : un échec
    # n'empêche jamais le build.
    "extra_pip_packages": [],
    "models_to_sync": [],
    "local_output_dir": "",
    "allowed_hosts": [],
    # Déprécié : les badges « déjà installé » se basent désormais sur
    # ``synced_custom_nodes`` (contenu réel du volume comfy-custom-nodes).
    # Conservé pour compatibilité des config.json existants.
    "last_deployed_custom_nodes": [],
    # Nodes réellement présents sur le volume comfy-custom-nodes, écrits par
    # sync.py (main → upload streaming → extract_custom_nodes_from_volume)
    # après un sync réussi.
    "synced_custom_nodes": [],
    "last_sync_custom_nodes": None,
}

# Clés qui font qu'un ``config.json`` inconnu PEUT être celui de ComfyCH (scan
# des dossiers voisins de custom_nodes). Volontairement spécifiques : un
# config.json de ComfyUI core ou d'une autre extension n'a pas ces clés.
COMFYCH_CONFIG_KEYS = ("api_url", "api_key", "models_to_sync", "custom_nodes_ext")

_CONFIG_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# Emplacement des données
# ---------------------------------------------------------------------------
def _user_paths():
    """Module ``holaf_user_paths`` du pack, ou None hors pack (script isolé)."""
    try:
        import holaf_user_paths  # import paresseux assumé
        return holaf_user_paths
    except Exception:  # noqa: BLE001, S110 — hors pack : repli sur l'ancien chemin
        pass
    # Processus SÉPARÉS (``modal run sync.py``) : le dossier du pack n'est pas
    # forcément dans sys.path, alors que le chemin de config doit être LE MÊME
    # que celui du serveur. On tente une dernière fois en l'ajoutant.
    try:
        import sys

        pack_root = str(CODEFYCH_CODE_ROOT.parents[1])
        if pack_root not in sys.path:
            sys.path.insert(0, pack_root)
        import holaf_user_paths
        return holaf_user_paths
    except Exception:  # noqa: BLE001 — hors pack : repli assumé
        return None


def config_path() -> Path:
    """Fichier de configuration EFFECTIF en LECTURE (jamais créé ici).

    ``<user>/default/AI-Helper/config/comfych.json`` via holaf_user_paths — qui
    renvoie l'ancien emplacement ``tools/comfych/config.json`` tant que la
    migration n'a pas eu lieu (comportement identique à avant l'intégration).
    """
    module = _user_paths()
    if module is not None:
        try:
            return Path(module.resolved_comfych_config())
        except Exception:  # noqa: BLE001, S110 — accesseur indisponible : repli
            pass
    return CODEFYCH_CODE_ROOT / LEGACY_CONFIG_NAME


def new_config_path() -> Path:
    """Cible CANONIQUE (nouvelle arborescence), indépendamment de l'existant.

    C'est la DESTINATION de l'import automatique : même quand l'ancien
    ``tools/comfych/config.json`` est encore là (et donc que :func:`config_path`
    le renvoie en lecture), la copie doit atterrir ici.
    """
    module = _user_paths()
    if module is not None:
        try:
            return Path(module.p_comfych_config())
        except Exception:  # noqa: BLE001, S110 — accesseur indisponible : repli
            pass
    return CODEFYCH_CODE_ROOT / LEGACY_CONFIG_NAME


def log_dir(create: bool = True) -> Path:
    """Dossier des journaux d'opération (``logs/comfych`` par défaut)."""
    module = _user_paths()
    directory = None
    if module is not None:
        try:
            directory = Path(module.resolved_comfych_logs())
        except Exception:  # noqa: BLE001 — accesseur indisponible : repli
            directory = None
    if directory is None:
        directory = CODEFYCH_CODE_ROOT / "logs"
    if create:
        try:
            directory.mkdir(parents=True, exist_ok=True)
        except OSError:
            # Dossier non inscriptible : les appelants écriront en best-effort.
            pass
    return directory


def log_path() -> Path:
    return log_dir() / LOG_FILENAME


def status_path() -> Path:
    return log_dir() / STATUS_FILENAME


# ---------------------------------------------------------------------------
# Lecture / écriture de la configuration
# ---------------------------------------------------------------------------
def load_config() -> dict:
    path = config_path()
    if path.exists():
        try:
            return {**DEFAULT_CONFIG, **json.loads(path.read_text(encoding="utf-8"))}
        except (json.JSONDecodeError, OSError):
            pass
    return dict(DEFAULT_CONFIG)


def save_config(config: dict) -> None:
    with _CONFIG_LOCK:
        current = load_config()
        current.update(config)
        path = config_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(current, indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# IMPORT AUTOMATIQUE de l'ancienne configuration
# ---------------------------------------------------------------------------
# Emplacements cherchés, DANS CET ORDRE :
#   1. ``<pack>/tools/comfych/config.json``  — là où ComfyCH écrivait quand il
#      était posé à plat dans custom_nodes ;
#   2. ``<custom_nodes>/ComfyCH/config.json`` puis
#      ``<custom_nodes>/modal_gateway/config.json`` (anciens noms du dossier) ;
#   3. ``<custom_nodes>/*/config.json`` — mais SEULEMENT si le contenu
#      ressemble à du ComfyCH (clés COMFYCH_CONFIG_KEYS) : on ne prend jamais
#      le config.json d'une autre extension ;
#   4. ``~/.comfych/config.json`` — emplacement « à la main » historique.
#
# ``<custom_nodes>`` vient de folder_paths (liste complète), donc l'ordre 1→4
# est répété pour CHAQUE dossier custom_nodes déclaré.
def _parse_config(path: Path) -> dict | None:
    """Charge *path* si c'est un objet JSON valide, sinon None."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _looks_like_comfych(data) -> bool:
    """True si *data* porte au moins deux clés propres à ComfyCH."""
    if not isinstance(data, dict):
        return False
    return sum(1 for key in COMFYCH_CONFIG_KEYS if key in data) >= 2


def _is_own_tree(path: Path) -> bool:
    """*path* est-il le pack AI-Helper lui-même, ou un dossier à l'intérieur ?

    Sert à exclure le pack du scan des « dossiers voisins » : ses fichiers ne
    sont jamais d'anciens emplacements externes de ComfyCH. Un dossier qui
    CONTIENT le pack (typiquement ``custom_nodes``) n'est PAS exclu.
    """
    try:
        candidate = path.resolve()
        pack_root = CODEFYCH_CODE_ROOT.parents[1].resolve()
        return candidate == pack_root or candidate.is_relative_to(pack_root)
    except (OSError, IndexError, ValueError):
        return False


def iter_legacy_config_candidates():
    """Génère les emplacements plausibles, dans l'ordre documenté ci-dessus."""
    seen: set[str] = set()

    def _yield(path: Path):
        try:
            key = str(path.resolve())
        except OSError:
            key = str(path)
        if key not in seen:
            seen.add(key)
            return path
        return None

    # 1. Dossier du code ComfyCH (disposition « à plat » : tools/comfych).
    first = _yield(CODEFYCH_CODE_ROOT / LEGACY_CONFIG_NAME)
    if first is not None:
        yield first, True  # nom CONNU de ComfyCH : contenu non filtré

    for root in custom_nodes_dirs():
        # Le pack lui-même n'est pas un dossier custom_nodes : quand
        # folder_paths est absent (hors ComfyUI), le repli vaut le pack, et
        # scanner ses sous-dossiers n'aurait aucun sens.
        if _is_own_tree(root):
            continue
        # 2. Anciens noms du dossier d'extension.
        for name in ("ComfyCH", "modal_gateway"):
            candidate = _yield(root / name / LEGACY_CONFIG_NAME)
            if candidate is not None:
                yield candidate, True
        # 3. N'importe quel dossier voisin : contenu filtré par
        #    _looks_like_comfych (jamais le config.json d'une autre extension).
        #    Le pack lui-même (et ses sous-dossiers) est EXCLU : ce sont NOS
        #    fichiers, pas d'anciens emplacements externes.
        try:
            neighbours = sorted(p for p in root.iterdir() if p.is_dir())
        except OSError:
            neighbours = []
        for neighbour in neighbours:
            if neighbour.name in ("ComfyCH", "modal_gateway") or neighbour.name.startswith("."):
                continue
            if _is_own_tree(neighbour):
                continue
            candidate = _yield(neighbour / LEGACY_CONFIG_NAME)
            if candidate is not None:
                yield candidate, False

    # 4. Emplacement « à la main » historique.
    home = os.path.expanduser(os.path.join("~", ".comfych", LEGACY_CONFIG_NAME))
    candidate = _yield(Path(home))
    if candidate is not None:
        yield candidate, True


def legacy_config_candidates() -> list[Path]:
    """Liste DOCUMENTAIRE des emplacements cherchés (ordre d'import inclus).

    Les entrées marquées « contenu filtré » (scan des dossiers voisins) sont
    présentes ici pour la documentation/tests : au moment de l'import, un
    fichier n'y est retenu que s'il ressemble à du ComfyCH.
    """
    return [path for path, _known in iter_legacy_config_candidates()]


def _same_path(left: Path, right: Path) -> bool:
    """Deux chemins désignent-ils le même fichier (résolution tolérante) ?"""
    try:
        return left.resolve() == right.resolve()
    except OSError:
        return str(left) == str(right)


def _rotated_migrated_path(path: Path) -> Path:
    """``config.json.migrated``, ou ``.migrated.1``, ``.2``… s'il existe déjà.

    On ne renomme JAMAIS par-dessus un fichier existant : l'utilisateur peut
    avoir plusieurs configurations historiques.
    """
    target = path.with_name(path.name + MIGRATED_SUFFIX)
    index = 1
    while target.exists():
        target = path.with_name(f"{path.name}{MIGRATED_SUFFIX}.{index}")
        index += 1
    return target


def find_legacy_config(target: Path | None = None) -> Path | None:
    """Premier ancien ``config.json`` exploitable (hors de la cible *target*)."""
    target = target or new_config_path()
    try:
        target_key = str(target.resolve())
    except OSError:
        target_key = str(target)
    for candidate, known_name in iter_legacy_config_candidates():
        if not candidate.is_file():
            continue
        try:
            if str(candidate.resolve()) == target_key:
                continue  # c'est déjà LA config utilisée
        except OSError:
            pass
        if not known_name and not _looks_like_comfych(_parse_config(candidate)):
            continue
        return candidate
    return None


def _describe_candidates() -> str:
    """Liste lisible (une ligne) des emplacements cherchés, pour les messages."""
    return ", ".join(str(path) for path in legacy_config_candidates())


def import_legacy_config(log=print) -> dict:
    """Importe une seule fois l'ancienne configuration vers la cible.

    Comportement :
      - cible ABSENTE + ancien trouvé → **copie** vers la cible, puis renomme
        l'ancien en ``*.migrated`` (jamais supprimé) ;
      - cible PRÉSENTE + ancien trouvé → **rien n'est écrasé** : avertissement
        (l'utilisateur décide) ;
      - cible PRÉSENTE seule → rien à faire ;
      - rien trouvé → création d'une configuration VIDE à la cible (sauf hors
        ComfyUI : on n'écrit jamais hors de l'arborescence utilisateur) et
        message indiquant où déposer l'ancien fichier.

    Returns:
        dict: ``{"status", "target", "source", "migrated"}`` — jamais la clé API.
    """
    target = new_config_path()
    result = {"status": "absent", "target": str(target), "source": None, "migrated": None}
    source = find_legacy_config(target)

    if target.is_file():
        result["status"] = "present"
        if source is not None:
            result["status"] = "conflict"
            result["source"] = str(source)
            log(
                "[ComfyCH] ⚠️ Deux configurations coexistent — RIEN n'a été écrasé.\n"
                f"          conservée : {target}\n"
                f"          ignorée  : {source}\n"
                "          Pour importer celle de gauche : renommez/supprimez la "
                "cible puis redémarrez ComfyUI."
            )
        return result

    if source is not None:
        if _same_path(source, target):
            # Cible et source confondues (hors ComfyUI, la cible est dans le
            # pack) : rien à copier, et surtout aucune copie sur soi-même.
            result["status"] = "present"
            return result
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        except OSError as exc:
            result["status"] = "error"
            result["source"] = str(source)
            log(f"[ComfyCH] 🔴 Import de {source} impossible ({exc}) — réglages inchangés.")
            return result
        result["status"] = "imported"
        result["source"] = str(source)
        # L'ancien fichier n'est JAMAIS supprimé : il est renommé, ce qui
        # empêche un ré-import en boucle au démarrage suivant.
        try:
            migrated = _rotated_migrated_path(source)
            source.rename(migrated)
            result["migrated"] = str(migrated)
        except OSError as exc:
            log(f"[ComfyCH] 🟡 Ancienne configuration non renommée ({source} : {exc}).")
        # Jamais de contenu dans le log (le fichier contient la clé API).
        log(
            f"[ComfyCH] ✅ Réglages importés : {source} → {target} "
            f"(ancien conservé sous {result['migrated'] or source})."
        )
        return result

    # Rien trouvé : on ne bloque JAMAIS le démarrage, mais on n'écrit rien
    # quand l'arborescence utilisateur n'est pas ADOPTÉE (hors ComfyUI sans
    # AIH_USER_ROOT, ex. tests/scripts : la cible serait dans ~/.config ou dans
    # le pack) — règle du chantier « aucune donnée utilisateur dans le pack ».
    if not _user_layout_ready(target):
        log(
            "[ComfyCH] Aucune configuration existante trouvée — aucun fichier créé "
            f"(cible : {target}). Emplacements cherchés : {_describe_candidates()}."
        )
        return result
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(DEFAULT_CONFIG, indent=2), encoding="utf-8")
        result["status"] = "created"
    except OSError as exc:
        log(f"[ComfyCH] 🟡 Configuration par défaut non créée ({exc}).")
        return result
    log(
        "[ComfyCH] Aucune configuration existante trouvée : un fichier par défaut "
        f"a été créé ({target}).\n"
        "          Pour récupérer vos anciens réglages (URL, clé, GPU, listes), "
        "déposez votre ancien config.json à côté de sync.py "
        f"({CODEFYCH_CODE_ROOT / LEGACY_CONFIG_NAME}), dans "
        f"{custom_nodes_dir_hint()}, ou dans ~/.comfych/config.json, puis "
        "redémarrez ComfyUI — il sera importé automatiquement."
    )
    return result


def custom_nodes_dir_hint() -> str:
    """Chemin lisible d'un dossier custom_nodes (message d'aide uniquement)."""
    roots = custom_nodes_dirs()
    return str(roots[0] / "ComfyCH" / LEGACY_CONFIG_NAME) if roots else "custom_nodes/ComfyCH/config.json"


def _user_layout_ready(target: Path) -> bool:
    """Peut-on écrire à *target* sans sortir des règles du pack ?

    True seulement si holaf_user_paths considère l'arborescence utilisateur
    comme adoptée (runtime ComfyUI ou AIH_USER_ROOT explicite) ET que la cible
    n'est pas dans le pack. Hors ComfyUI, la cible retomberait sur
    ``~/.config/comfyui/...`` ou sur le pack : on n'écrit alors RIEN.
    """
    module = _user_paths()
    if module is None:
        return False
    try:
        adopted = bool(module.user_layout_adopted())
    except Exception:  # noqa: BLE001 — accesseur indisponible : prudence
        return False
    return adopted and not _is_inside_pack(target)


def _is_inside_pack(path: Path) -> bool:
    """True si *path* est dans le DOSSIER DU PACK AI-Helper (code + données).

    Le pack est le parent de ``tools/`` : rien ne doit y être écrit (règle du
    chantier holaf_user_paths). Hors ComfyUI, ``config_path()`` y retombe —
    c'est alors un simple emplacement d'ATTENTE, jamais créé ici.
    """
    try:
        pack_root = CODEFYCH_CODE_ROOT.parent.parent.resolve()
        path.resolve().relative_to(pack_root)
        return True
    except (ValueError, OSError):
        return False


_IMPORT_LOCK = threading.Lock()
_IMPORT_STATE: dict = {"done": False, "result": None}


def import_legacy_config_once(log=print) -> dict:
    """Idempotence PROCESSUS de :func:`import_legacy_config` (démarrage)."""
    with _IMPORT_LOCK:
        if _IMPORT_STATE["done"]:
            return _IMPORT_STATE["result"]
        result = import_legacy_config(log=log)
        _IMPORT_STATE["result"] = result
        _IMPORT_STATE["done"] = True
        return result


__all__ = [
    "COMFYCH_CONFIG_KEYS",
    "DEFAULT_CONFIG",
    "LEGACY_CONFIG_NAME",
    "MIGRATED_SUFFIX",
    "config_path",
    "find_legacy_config",
    "import_legacy_config",
    "import_legacy_config_once",
    "legacy_config_candidates",
    "load_config",
    "log_dir",
    "log_path",
    "new_config_path",
    "save_config",
    "status_path",
]
