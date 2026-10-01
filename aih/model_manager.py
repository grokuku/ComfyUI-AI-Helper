# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""model_manager.py — List, upload et download de models/loras (Phase 2 chantier C).

Porté depuis l'ancien monorepo AI-Helper (fusion PLAN_FUSION.md,
routes /api/aih/models/* — « SFTP chunked + fingerprint » gardées §2.2).
Le module ne déclare AUCUNE node ComfyUI : il est consommé exclusivement
par aih/routes.py (groupe « models »).

Utilise folder_paths (ComfyUI) pour connaître les chemins des models.
Upload les fichiers directement depuis le filesystem Python (pas de file
picker navigateur). Les transferts vont vers/depuis le backend AIH distant
(URL configurée dans user/default/aih/credentials.json), en deux modes :
  - direct SFTP : paramiko sftp.put()/get() avec callback de progression
    (imports paramiko paresseux — uniquement quand le backend fournit une
    config sftp) ;
  - chunked HTTP : /api/files/chunk (storage local du backend), par paquets
    de CHUNK_SIZE.
Le fingerprint (hash sha256 du premier et du dernier Mo + taille) permet la
déduplication côté backend sans lire tout le fichier.

Endpoints servis par aih/routes.py :
  GET  /api/aih/models/list              → liste locale complète + fingerprints
  GET  /api/aih/models/remote            → proxy liste distante (paginée)
  GET  /api/aih/models/local             → liste locale filtrée (type/search)
  POST /api/aih/models/check             → check PAR LOT d'existence serveur
                                           (pré-upload : présent/absent + taille)
  POST /api/aih/models/upload            → upload chunked/SFTP d'un fichier local
                                           (overwrite=true = écrasement explicite)
  GET  /api/aih/models/upload/progress   → progression de l'upload courant
  POST /api/aih/models/fingerprint       → fingerprint head/tail d'un fichier
  GET  /api/aih/models/download/progress → progression du download courant
  POST /api/aih/models/download          → download vers les dossiers ComfyUI

Différences vs source (documentées) :
  - credentials lus via ``from aih import credentials`` (ex nodes/_credentials,
    renommé au chantier A) — la migration de l'ancien fichier
    user/default/aih_credentials.json est gérée par ce module ;
  - import subprocess mort supprimé.
"""

import os
import json
import logging
import hashlib
import shutil
import threading
import time

try:
    import folder_paths
    _HAS_FOLDER_PATHS = True
except Exception:
    _HAS_FOLDER_PATHS = False

# Chunk size pour l'upload (doit correspondre au backend)
CHUNK_SIZE = 25 * 1024 * 1024  # 25 MB

# Morceaux lus de la réponse HTTP de DOWNLOAD. Ne PAS réutiliser CHUNK_SIZE
# (25 Mo = taille d'upload) : à 1,3 Mo/s un morceau de 25 Mo ne publiait la
# progression que toutes les ~19 s (la fenêtre de transferts affichait « serveur
# muet » à tort) et retardait l'annulation. 1 Mo : progression/annulation
# réactives, mise à jour toutes les ~20 ms à 50 Mo/s, coût nul (mesuré : débit
# identique à 25 Mo).
DOWNLOAD_READ_CHUNK = 1024 * 1024


# ── Connexion SFTP sécurisée (TOFU sur la host key, anti-MITM) ────────

def _sftp_connect(sftp_config):
    """Connexion SFTP avec host key TOFU (Trust On First Use).

    La 1re clé d'hôte rencontrée est mémorisée dans un fichier known_hosts
    persistant ; toute clé différente ensuite est refusée (BadHostKeyException)
    au lieu d'être acceptée silencieusement (AutoAddPolicy).
    Emplacement : ``AIH_SFTP_KNOWN_HOSTS`` ou ``<pack>/.sftp_known_hosts``.
    """
    import paramiko  # lazy : uniquement si le backend sert du SFTP

    class _TOFUMissingHostKeyPolicy(paramiko.MissingHostKeyPolicy):
        def __init__(self, path):
            self._path = path

        def missing_host_key(self, client, hostname, key):
            client.get_host_keys().add(hostname, key.get_name(), key)
            try:
                client.get_host_keys().save(self._path)
                logging.info("[model_manager] Host key mémorisée (TOFU) pour %s → %s",
                             hostname, self._path)
            except OSError as exc:
                raise paramiko.SSHException(
                    f"Impossible de persister la host key TOFU ({self._path}) : {exc}"
                ) from exc

    known_hosts = os.environ.get("AIH_SFTP_KNOWN_HOSTS") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", ".sftp_known_hosts"
    )
    ssh = paramiko.SSHClient()
    if os.path.exists(known_hosts):
        ssh.load_host_keys(known_hosts)
    ssh.set_missing_host_key_policy(_TOFUMissingHostKeyPolicy(known_hosts))
    if sftp_config.get('key_path'):
        ssh.connect(sftp_config['host'], port=sftp_config['port'],
                    username=sftp_config['username'],
                    key_filename=sftp_config['key_path'], timeout=15)
    else:
        ssh.connect(sftp_config['host'], port=sftp_config['port'],
                    username=sftp_config['username'],
                    password=sftp_config['password'], timeout=15)
    return ssh

# Progression des uploads en cours : filepath → {chunk, total, speed_mbs, start, phase}
_upload_progress = {}

# Progression des downloads : upload_id → {bytes_recv, bytes_total, speed_mbs, start}
_download_progress = {}

# Annulations demandées pour les downloads en cours : set d'``upload_id``.
# Posé par POST /api/aih/models/download/cancel et consommé par la boucle de
# transfert, qui abandonne et nettoie le fichier partiel (jamais de .part ni de
# fichier tronqué laissé dans le dossier ComfyUI).
_download_cancel = set()


class DownloadCancelled(Exception):
    """Annulation utilisateur pendant un transfert (partiel nettoyé)."""


def request_download_cancel(upload_id):
    """Demande l'annulation du download en cours pour ``upload_id``.

    Idempotent ; un upload_id sans download actif est simplement ignoré (le
    drapeau est réinitialisé au démarrage du prochain download du même id).
    """
    if not upload_id:
        return False
    _download_cancel.add(str(upload_id))
    return True


def _format_backend_error(resp):
    """Message d'erreur backend lisible : JSON ``error``/``detail`` sinon texte.

    Convention maison du backend : ``error`` (Flask) ; ``detail`` couvre les
    proxies FastAPI. Toujours suffixé du statut HTTP pour le diagnostic.
    """
    msg = ''
    try:
        data = resp.json()
        if isinstance(data, dict):
            msg = str(data.get('error') or data.get('detail') or '')
    except Exception:
        msg = ''
    if not msg:
        try:
            msg = (getattr(resp, 'text', '') or '')[:200]
        except Exception:
            msg = ''
    msg = msg.strip()
    return f"HTTP {resp.status_code}: {msg}" if msg else f"HTTP {resp.status_code}"


def _download_http_error(resp):
    """Erreur explicite pour un statut non-ok (404 = absent côté serveur).

    Un modèle jamais uploadé (ou supprimé) côté serveur doit produire un
    message compréhensible, pas un « HTTP 404 » brut.
    """
    if resp.status_code == 404:
        return "Modèle introuvable côté serveur (jamais uploadé ou supprimé)"
    return _format_backend_error(resp)


def _cleanup_partial(path):
    """Supprime un fichier partiel de download. Ne lève jamais."""
    try:
        if path and os.path.exists(path):
            os.remove(path)
    except OSError as e:
        logging.warning(f"[AIH] Nettoyage du fichier partiel impossible ({path}): {e}")


def _replace_download_file(tmp_path, dest_path):
    """Remplace la destination par le fichier téléchargé (atomique si possible)."""
    try:
        os.replace(tmp_path, dest_path)
    except OSError:
        # Windows : MoveFileEx échoue si la destination est ouverte par un autre
        # process (ComfyUI qui charge un modèle). Repli non atomique.
        if os.path.exists(dest_path):
            os.remove(dest_path)
        os.rename(tmp_path, dest_path)


# ── Timeout des étapes SYNCHRONES côté serveur (/files/complete, download) ──
# POST /files/complete n'est PAS une simple écriture DB : le backend recopie
# le fichier TEMPORAIRE COMPLET (reçu chunk par chunk) vers le stockage réel
# (SFTPStorage.upload → sftp.put ; LocalStorage.upload → copie cross-device
# possible) AVANT de répondre. La requête ne reçoit donc AUCUN octet pendant
# toute la durée de l'opération : le « read timeout » de requests s'applique à
# la DURÉE TOTALE, pas à l'inactivité entre deux paquets.
#
# Même problème sur /files/<id>/download : le backend précharge d'abord TOUT le
# fichier du stockage vers un temp local, puis le streame — le client ne voit
# donc rien pendant le préchargement.
#
# L'ancien plafond FIXE de 60 s faisait échouer toute finalisation de plus de
# 60 s — exactement le symptôme observé : « Complete failed:
# HTTPSConnectionPool(...): Read timed out. (read timeout=60) » sur 4,6 Go et
# 13,5 Go, alors que 1,5 Go (finalisé en <60 s) passait.
#
# On dimensionne donc le timeout SUR LA TAILLE, avec un débit plancher
# volontairement pessimiste (débit mesuré : 9-13 Mo/s côté client→backend) :
# 13,5 Go → ~56 min de budget, 4,6 Go → ~19 min, un petit fichier garde 5 min.
_SERVER_SYNC_MIN_MBPS = 4.0        # débit plancher supposé de la recopie serveur (Mo/s)
_SERVER_SYNC_MIN_TIMEOUT = 300     # plancher absolu du read timeout (s)
_SERVER_SYNC_CONNECT_TIMEOUT = 30  # connexion + TLS (s)


def _server_side_timeout(size_bytes):
    """Timeout ``(connect, read)`` pour une étape SYNCHRONE côté backend, selon
    la taille du fichier.

    Le read timeout couvre la recopie SYNCHRONE du fichier complet côté serveur
    (temp → stockage pour ``/complete`` ; stockage → temp pour le download). Il
    est calculé sur un débit plancher de ``_SERVER_SYNC_MIN_MBPS`` : c'est un
    PLAFOND de sécurité, pas une durée prévue (le transfert réel est bien plus
    rapide) — il ne doit jamais couper un gros fichier en pleine finalisation,
    mais doit finir par rendre la main si le serveur est réellement figé.
    """
    try:
        size = int(size_bytes)
    except (TypeError, ValueError):
        size = 0
    if size <= 0:
        read_timeout = _SERVER_SYNC_MIN_TIMEOUT
    else:
        read_timeout = max(
            _SERVER_SYNC_MIN_TIMEOUT,
            size / (_SERVER_SYNC_MIN_MBPS * 1024 * 1024),
        )
    return (_SERVER_SYNC_CONNECT_TIMEOUT, read_timeout)


# ── Watchdog de download : jamais d'attente silencieuse INFINIE ────────
# Un backend ANTÉRIEUR au correctif de streaming précharge TOUT le fichier du
# stockage avant d'envoyer le 1er octet : pour 13,5 Go, des minutes à 0 octet
# (« Préparation côté serveur… »). Un flux de stockage muet donne le MÊME
# symptôme. Le transfert est donc abandonné (erreur explicite actionnable,
# partiel nettoyé) dès qu'AUCUN octet n'est arrivé pendant
# ``DOWNLOAD_STALL_TIMEOUT`` secondes — jamais d'attente sans fin. C'est aussi
# le read timeout par lecture socket de la requête HTTP.
# Surchargeable via ``AIH_DL_STALL_TIMEOUT`` (secondes, plancher 10 s).
try:
    DOWNLOAD_STALL_TIMEOUT = max(10.0, float(os.environ.get("AIH_DL_STALL_TIMEOUT", "60")))
except (TypeError, ValueError):
    DOWNLOAD_STALL_TIMEOUT = 60.0

# Seuil d'affichage côté fenêtre de transferts : au-delà de N secondes sans le
# moindre octet, la phase dit EXPLICITEMENT que le serveur est muet (l'utilisateur
# voit la cause probable au lieu d'un « Préparation… » qui n'en finit pas).
DOWNLOAD_IDLE_WARN_S = 15.0


def _quiet_close(obj):
    """Ferme un objet sans jamais lever (utilisé par le watchdog)."""
    if obj is None:
        return
    try:
        obj.close()
    except Exception:
        pass


class _DownloadStallWatchdog:
    """Abandonne un transfert qui ne reçoit AUCUN octet pendant ``timeout`` s.

    Un thread daemon surveille ``last_activity`` (remis à zéro à chaque octet
    reçu) ; au dépassement il marque ``stalled`` puis appelle ``on_stall`` —
    fermeture de la réponse HTTP ou de la connexion SFTP — ce qui débloque la
    lecture en cours. L'appelant consulte ``stalled`` pour produire un message
    actionnable au lieu d'attendre indéfiniment.

    ``stop()`` est idempotent et sans attente : appelable dans un ``finally``.
    """

    def __init__(self, timeout, on_stall=None):
        self._timeout = max(0.1, float(timeout))
        # Sondage plus fin que le délai (délais courts en test → pas de flakiness).
        self._interval = max(0.02, min(1.0, self._timeout / 4.0))
        self._on_stall = on_stall
        self._last = time.monotonic()
        self._stop = threading.Event()
        self._stalled = threading.Event()
        self._thread = None

    def start(self):
        self._thread = threading.Thread(
            target=self._run, name="aih-dl-stall-watchdog", daemon=True
        )
        self._thread.start()
        return self

    def touch(self):
        """Signale un octet reçu (progression réelle du transfert)."""
        self._last = time.monotonic()

    @property
    def stalled(self):
        return self._stalled.is_set()

    def _run(self):
        while not self._stop.wait(self._interval):
            if time.monotonic() - self._last >= self._timeout:
                self._stalled.set()
                if self._on_stall is not None:
                    try:
                        self._on_stall()
                    except Exception:
                        pass
                return

    def stop(self):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1.0)
            self._thread = None


def _backend_streaming_capability(api_url, auth_headers, timeout=10):
    """Interroge ``GET <api_url>/health`` : le backend STREAME-t-il les downloads ?

    Retourne ``(True, '')`` si la capacité est déclarée ; ``(False, raison)`` si
    le backend est manifestement ANTÉRIEUR au correctif (404 sur ``/api/health``
    ou 200 sans ``features.download_streaming``) ; ``(None, raison)`` si le
    verdict est impossible (réseau, 401/403/5xx, corps illisible) — dans ce cas
    on NE bloque PAS (un proxy restrictif ne doit pas empêcher un backend
    moderne), le watchdog de transfert reste la ceinture de sécurité.
    """
    import requests
    try:
        resp = requests.get(f"{api_url}/health", headers=auth_headers, timeout=timeout)
    except Exception as e:
        return None, f"sonde impossible ({e})"
    if resp.status_code == 404:
        return False, "route /api/health absente (backend antérieur au streaming)"
    if resp.status_code != 200:
        return None, f"sonde HTTP {resp.status_code}"
    try:
        data = resp.json()
    except Exception:
        return None, "réponse /api/health illisible"
    features = data.get("features") if isinstance(data, dict) else None
    if isinstance(features, dict) and features.get("download_streaming") is True:
        return True, ""
    return False, "le backend ne déclare pas features.download_streaming"


def _backend_outdated_error(api_url, detail):
    """Refus IMMÉDIAT (5 s) d'un backend qui ne streame pas.

    Un backend ancien précharge le fichier complet avant le 1er octet : pour
    13,5 Go c'est le symptôme « 0 octet pendant des minutes ». Mieux vaut
    refuser tout de suite avec la marche à suivre que laisser attendre.
    """
    return (
        f"Backend AI-Helper obsolète : {detail}. Il précharge le fichier complet "
        f"avant le 1er octet (des minutes à 0 % pour un gros modèle). "
        f"Démarre/redémarre le service backend, puis vérifie "
        f"GET {api_url}/health (features.download_streaming doit valoir true), "
        f"et relance le téléchargement."
    )


def _download_stall_error(api_url, stall_s, received, total):
    """Message d'abandon EXPLICITE et actionnable (ni muet, ni générique)."""
    hint = (
        f"Redémarre le backend s'il vient d'être mis à jour, puis vérifie "
        f"GET {api_url}/health (features.download_streaming=true)."
    )
    if received <= 0:
        return (
            f"Aucun octet reçu pendant {stall_s:.0f} s — transfert abandonné. "
            f"Le backend AI-Helper n'envoie rien : il est peut-être ANTÉRIEUR au "
            f"correctif de streaming (préchargement complet avant le 1er octet) ou "
            f"le flux de stockage est bloqué. {hint}"
        )
    total_txt = f"{total}" if total else "?"
    return (
        f"Flux figé ou coupé par le backend : reçu {received} sur {total_txt}, "
        f"plus aucun octet depuis {stall_s:.0f} s — transfert abandonné, le "
        f"stockage du backend ne fournit plus de données. {hint}"
    )


# Toutes les categories de models connues par ComfyUI
_ALL_MODEL_CATEGORIES = [
    'checkpoints', 'loras', 'vae', 'clip', 'clip_vision', 'controlnet',
    'unet', 'unet_gguf', 'upscale_models', 'gligen', 'hypernetworks',
    'text_encoders', 'style_models', 'diffusion_models', 'configs',
    'embeddings', 'bbxe/models',
]

def _get_model_dirs():
    """Retourne {type: [paths]} pour toutes les categories de models ComfyUI.
    Fallback : scanne les dossiers courants si folder_paths est vide ou indisponible."""
    result = {}
    if _HAS_FOLDER_PATHS:
        for cat in _ALL_MODEL_CATEGORIES:
            try:
                paths = folder_paths.get_folder_paths(cat)
                if paths:
                    result[cat] = paths
            except Exception:
                pass

    # Fallback : si rien trouve via folder_paths, on scanne les dossiers courants
    if not result:
        # Chercher ComfyUI/models/ et ses sous-dossiers
        for base_dir in [
            "ComfyUI/models",
            os.path.expanduser("~/ComfyUI/models"),
            "../ComfyUI/models",
            # <pack>/aih/../.. = custom_nodes/ ; un niveau de plus = racine ComfyUI
            os.path.join(os.path.dirname(__file__), "..", "..", "..", "models"),
        ]:
            if os.path.isdir(base_dir):
                for name in os.listdir(base_dir):
                    sub = os.path.join(base_dir, name)
                    if os.path.isdir(sub):
                        result[name] = [sub]
                break
    return result


def _list_models_in_dirs(dirs, extensions=None):
    """Liste les fichiers dans une liste de dossiers (scan recursif 1 niveau)."""
    if extensions is None:
        extensions = ['.safetensors', '.ckpt', '.pt', '.pth', '.gguf', '.bin', '.t5', '.fp16', '.fp8', '.bf16']
    results = []
    for d in dirs:
        if not os.path.isdir(d):
            continue
        for name in os.listdir(d):
            full = os.path.join(d, name)
            if os.path.isfile(full):
                ext = os.path.splitext(name)[1].lower()
                if ext in extensions:
                    results.append({
                        'name': name,
                        'path': full,
                        'size': os.path.getsize(full),
                    })
            elif os.path.isdir(full):
                # Scan 1 niveau de sous-dossier (ex: gguf/, lora/, etc.)
                for sub_name in os.listdir(full):
                    sub_full = os.path.join(full, sub_name)
                    if os.path.isfile(sub_full):
                        ext = os.path.splitext(sub_name)[1].lower()
                        if ext in extensions:
                            results.append({
                                'name': sub_name,
                                'path': sub_full,
                                'size': os.path.getsize(sub_full),
                            })
    return results


def _get_aih_credentials():
    """Lit les credentials AIH (URL du serveur + API key) via aih.credentials.

    Retourne un tuple (api_url_avec_/api, api_key). Le fallback historique
    (lecture brute de user/default/aih_credentials.json) n'est plus nécessaire :
    aih.credentials migre lui-même l'ancien fichier vers user/default/aih/.
    api_url est une chaîne vide si l'URL du serveur n'est pas configurée :
    les appelants doivent dégrader proprement dans ce cas.
    """
    try:
        from aih import credentials
        return credentials.get_api_url(), credentials.get_api_key()
    except Exception:
        return "", ""


def list_remote_models(page=1, limit=50, type_filter=None, search=None, sort='created_at', order='desc'):
    """
    Interroge le backend AIH pour lister les modèles distants.
    Retourne directement la réponse JSON du backend.
    """
    import requests as _req
    api_url, api_key = _get_aih_credentials()
    if not api_url:
        return {'items': [], 'total': 0, 'page': page, 'limit': limit,
                'error': "Serveur AIH non configuré (Settings ▸ onglet « AIH · Compte »)"}

    params = {'page': page, 'limit': min(limit, 200), 'sort': sort, 'order': order}
    if type_filter:
        params['type'] = type_filter
    if search:
        params['search'] = search

    headers = {}
    if api_key:
        headers['Authorization'] = f'Bearer {api_key}'

    try:
        resp = _req.get(
            f'{api_url}/aih/models/remote',
            params=params, headers=headers, timeout=30
        )
        if resp.ok:
            return resp.json()
        return {'items': [], 'total': 0, 'page': page, 'limit': limit, 'error': f'HTTP {resp.status_code}'}
    except Exception as e:
        return {'items': [], 'total': 0, 'page': page, 'limit': limit, 'error': str(e)}


def list_local_models(type_filter=None, search=None):
    """Liste tous les models locaux dans toutes les categories ComfyUI.

    Args:
        type_filter: Filtre par categorie (ex: 'checkpoints', 'loras').
        search: Filtre par nom (recherche insensible a la casse).

    Chaque entree est enrichie avec sha256_head et sha256_tail (fingerprint
    partiel O(1) — seuls les 2 premiers et derniers Mo sont lus).
    """
    dirs = _get_model_dirs()
    result = {}
    for cat, cat_dirs in dirs.items():
        if type_filter:
            # Support de la liste de types séparés par des virgules (ex: 'checkpoints,loras')
            type_list = [t.strip() for t in type_filter.split(',')]
            if cat not in type_list:
                continue
        models = _list_models_in_dirs(cat_dirs)
        # Filtrer par recherche textuelle
        if search:
            search_lower = search.lower()
            models = [m for m in models if search_lower in m['name'].lower()]
        # Ajouter le fingerprint (sha256_head + sha256_tail) a chaque modele
        for m in models:
            fp = _compute_fingerprint(m['path'])
            if fp:
                m['sha256_head'] = fp['head']
                m['sha256_tail'] = fp['tail']
        result[cat] = models
    return result


def _compute_fingerprint(filepath):
    """Calcule le fingerprint (hash premier/dernier Mo + taille)."""
    try:
        size = os.path.getsize(filepath)
        head_size = min(1024 * 1024, size)
        with open(filepath, 'rb') as f:
            head = f.read(head_size)
            f.seek(max(0, size - head_size))
            tail = f.read(head_size)
        head_hash = hashlib.sha256(head).hexdigest()
        tail_hash = hashlib.sha256(tail).hexdigest()
        return {'size': size, 'head': head_hash, 'tail': tail_hash}
    except Exception as e:
        logging.warning(f"[AIH] Fingerprint failed: {e}")
        return None


def upload_model_to_server(filepath, file_type="model", on_progress=None, overwrite=False):
    """
    Upload un fichier model vers le serveur AIH via chunked upload.
    Retourne {success, upload_id, file_path} ou {success: False, error}.
    Import paramiko paresseux (uniquement en mode SFTP direct).

    ``overwrite=True`` : ÉCRASEMENT EXPLICITE choisi par l'utilisateur dans la
    modale de pré-upload — la déduplication par fingerprint est alors SAUTÉE et
    un nouvel upload est créé (les octets sont réellement renvoyés). Sans ce
    drapeau, un fichier déjà présent est IGNORÉ (aucun octet transféré) et la
    réponse porte ``deduplicated: True`` pour que l'UI distingue « ignoré »
    d'un vrai transfert.
    """
    import requests

    api_url, api_key = _get_aih_credentials()
    if not api_url:
        return {'success': False,
                'error': "Serveur AIH non configuré (Settings ▸ onglet « AIH · Compte »)"}

    filename = os.path.basename(filepath)
    size = os.path.getsize(filepath)

    auth_headers = {}
    if api_key:
        auth_headers["Authorization"] = f"Bearer {api_key}"

    # 1. Fingerprint pour déduplication — SAUF écrasement explicite
    # (`fp` sert aussi au /complete : empreinte mémorisée pour les futurs checks)
    fp = _compute_fingerprint(filepath)
    if fp and not overwrite:
        try:
            resp = requests.post(f"{api_url}/files/check", json={
                'size': fp['size'], 'head': fp['head'], 'tail': fp['tail']
            }, headers={**auth_headers, 'Content-Type': 'application/json'}, timeout=10)
            if resp.ok:
                data = resp.json()
                if data.get('exists'):
                    logging.info(f"[AIH] Model {filename} already on server, skipping upload")
                    return {'success': True, 'upload_id': data['upload_id'],
                            'file_path': data['file_path'], 'deduplicated': True}
        except Exception as e:
            logging.warning(f"[AIH] Fingerprint check failed: {e}")

    # 2. Init upload — on preserve le type original (UNET, LoRA, etc.) pour le Model Browser
    # Normaliser le type pour le Model Browser (singulier, pas de _models).
    # Aligné sur la whitelist /api/files/init (backend files.py) : model, node,
    # screenshot, checkpoint, lora, vae, clip, clip_vision, controlnet, unet,
    # unet_gguf, upscale, gligen, hypernetwork, text_encoder, style_model.
    _type_normalization = {
        'checkpoints': 'checkpoint',
        'loras': 'lora',
        'upscale_models': 'upscale',
        'text_encoders': 'text_encoder',
        'style_models': 'style_model',
        'diffusion_models': 'unet',
        'hypernetworks': 'hypernetwork',
        'embeddings': 'model',
        'clip_vision': 'clip_vision',
        'controlnet': 'controlnet',
        'gligen': 'gligen',
        'unet': 'unet',
        'unet_gguf': 'unet_gguf',
        'vae': 'vae',
        'clip': 'clip',
        'configs': 'model',
        'model': 'model',
    }
    backend_type = _type_normalization.get(file_type, file_type)
    try:
        resp = requests.post(f"{api_url}/files/init", json={
            'filename': filename, 'size': size, 'type': backend_type
        }, headers={**auth_headers, 'Content-Type': 'application/json'}, timeout=30)
        if not resp.ok:
            try:
                err = resp.json().get('error', resp.text)
            except Exception:
                err = resp.text[:300] or f'HTTP {resp.status_code} (body empty)'
            return {'success': False, 'error': f'Init failed: HTTP {resp.status_code} {err}'}
        init_data = resp.json()
    except Exception as e:
        return {'success': False, 'error': f'Init failed: {e}'}

    upload_id = init_data['upload_id']
    sftp_config = init_data.get('sftp')  # None si storage local

    # 3. Upload du fichier
    if sftp_config:
        # ── Mode direct SFTP : paramiko sftp.put() ──
        # Un seul handle, un seul flux, pas de round-trips HTTP par chunk
        _upload_progress[filepath] = {
            'chunk': 0, 'total': 1,
            'speed_mbs': 0.0, 'start': time.time(), 'last_chunk_time': time.time(),
            'bytes_sent': 0, 'bytes_total': size,
        }
        try:
            ssh = _sftp_connect(sftp_config)
            sftp = ssh.open_sftp()
            sftp.sftp_chunk_size = 2 * 1024 * 1024  # 2MB buffer

            full_remote = sftp_config['base_path'].rstrip('/') + '/' + sftp_config['remote_path']

            # Creer les dossiers parents
            remote_dir = "/".join(full_remote.split("/")[:-1])
            _sftp_mkdir_p(sftp, remote_dir)

            # Callback de progression
            def _cb(sent, total):
                now = time.time()
                elapsed = now - _upload_progress[filepath]['start']
                speed = (sent / 1048576) / elapsed if elapsed > 0 else 0
                _upload_progress[filepath].update({
                    'bytes_sent': sent,
                    'speed_mbs': round(speed, 1),
                    'chunk': sent,  # reuse pour le percent
                    'total': total,
                })

            sftp.put(filepath, full_remote, callback=_cb)
            sftp.close()
            ssh.close()
            logging.info(f"[AIH] Direct SFTP upload OK: {filename} → {full_remote}")
        except Exception as e:
            _upload_progress.pop(filepath, None)
            return {'success': False, 'error': f'SFTP upload failed: {e}'}
    else:
        # ── Mode chunked via Flask (storage local) ──
        chunk_size = init_data['chunk_size']
        total_chunks = init_data['total_chunks']
        _upload_progress[filepath] = {'chunk': 0, 'total': total_chunks, 'speed_mbs': 0.0, 'start': time.time(), 'last_chunk_time': time.time()}
        try:
            with open(filepath, 'rb') as f:
                for i in range(total_chunks):
                    chunk = f.read(chunk_size)
                    resp = requests.post(f"{api_url}/files/chunk", data={
                        'upload_id': upload_id,
                        'chunk_index': str(i),
                    }, files={'data': (filename, chunk)}, headers=auth_headers, timeout=300)
                    if not resp.ok:
                        _upload_progress.pop(filepath, None)
                        return {'success': False, 'error': f'Chunk {i} failed: HTTP {resp.status_code} {resp.text[:200]}'}
                    now = time.time()
                    chunk_elapsed = now - _upload_progress[filepath].get('last_chunk_time', now)
                    chunk_mb = chunk_size / 1048576
                    speed = chunk_mb / chunk_elapsed if chunk_elapsed > 0 else 0
                    _upload_progress[filepath].update({'chunk': i + 1, 'speed_mbs': round(speed, 1), 'last_chunk_time': now})
                    if on_progress:
                        on_progress(i + 1, total_chunks)
        except Exception as e:
            _upload_progress.pop(filepath, None)
            return {'success': False, 'error': f'Chunk upload failed: {e}'}

    # 4. Complete — étape SYNCHRONE côté serveur (recopie du fichier temporaire
    # complet vers le stockage), donc potentiellement LONGUE pour un gros
    # modèle : timeout dimensionné sur la taille (cf. _server_side_timeout).
    # On CONSERVE une entrée de progression pendant l'attente (phase
    # « finalizing ») pour que l'UI affiche une finalisation au lieu d'une
    # barre figée muette.
    prev = _upload_progress.get(filepath) or {}
    _upload_progress[filepath] = {
        'chunk': prev.get('chunk', 1),
        'total': prev.get('total', 1),
        'speed_mbs': prev.get('speed_mbs', 0.0),
        'start': prev.get('start', time.time()),
        'phase': 'finalizing',
    }
    timeout = _server_side_timeout(size)
    try:
        complete_data = {'upload_id': upload_id}
        if fp:
            complete_data['fingerprint_head'] = fp['head']
            complete_data['fingerprint_tail'] = fp['tail']
        resp = requests.post(f"{api_url}/files/complete", json=complete_data,
                             headers={**auth_headers, 'Content-Type': 'application/json'},
                             timeout=timeout)
        if not resp.ok:
            err = resp.json().get('error', resp.text)
            return {'success': False, 'error': f'Complete failed: {err}'}
        result = resp.json()
        return {'success': True, 'upload_id': upload_id,
                'file_path': result.get('file_path', ''),
                'deduplicated': False, 'overwrite': bool(overwrite)}
    except Exception as e:
        # Erreur EXPLICITE : on nomme l'étape, la taille et le budget de timeout
        # pour que « Erreur: timeout » ne soit plus ambigu (finalisation serveur
        # ≠ transfert des octets, qui a, lui, réussi).
        return {'success': False, 'error': (
            f'Complete failed (finalisation serveur, {size} octets, '
            f'timeout read {timeout[1]:.0f}s) : {e}'
        )}
    finally:
        _upload_progress.pop(filepath, None)


def check_models_on_server(items):
    """Vérifie en lot la présence des modèles sur le serveur AIH (AVANT upload).

    Utilisé par l'onglet 📤 Partager : la modale de pré-upload liste les modèles
    de la sélection avec leur état serveur (« absent » / « déjà présent
    (identique) » / « déjà présent (version différente) ») pour que l'utilisateur
    choisisse explicitement ce qu'il écrase — au lieu de sauter silencieusement
    les doublons en affichant un faux succès (bug « 8 fichiers, 0.2 s »).

    `items` : [{'path': chemin local, 'type': type ComfyUI}, ...].
    Retour : {'ok': bool, 'error': str|None, 'items': [
        {'path', 'name', 'type', 'size',
         'status': 'identical'|'different'|'absent'|'unknown',
         'remote': {'upload_id', 'filename', 'size', 'file_path', 'created_at'}|None,
         'error': str|None} ]}.
    `ok=False` (serveur non configuré / réseau / HTTP) → l'appelant NE DOIT PAS
    bloquer l'upload : il retombe sur le comportement historique (dédup côté
    serveur) — mais l'UI distingue désormais les fichiers ignorés.

    Le critère d'« identique » est EXACTEMENT celui de la déduplication
    d'upload : size + sha256(1er Mo) + sha256(dernier Mo), vérifié par le
    backend sur un fichier réellement présent sur le stockage.
    """
    import requests

    results = []
    pending = []
    for raw in (items or []):
        path = str((raw or {}).get('path') or '')
        item_type = str((raw or {}).get('type') or 'model')
        entry = {'path': path, 'name': os.path.basename(path), 'type': item_type,
                 'size': 0, 'status': 'unknown', 'remote': None, 'error': None}
        if not path or not os.path.isfile(path):
            entry['error'] = 'fichier local introuvable'
            results.append(entry)
            continue
        entry['size'] = os.path.getsize(path)
        fp = _compute_fingerprint(path)
        if not fp:
            entry['error'] = 'fingerprint impossible'
            results.append(entry)
            continue
        entry['_fp'] = fp
        pending.append(entry)
        results.append(entry)

    if not pending:
        return {'ok': False, 'error': 'aucun fichier vérifiable', 'items': results}

    api_url, api_key = _get_aih_credentials()
    if not api_url:
        err = "Serveur AIH non configuré (Settings ▸ onglet « AIH · Compte »)"
    else:
        headers = {'Content-Type': 'application/json'}
        if api_key:
            headers['Authorization'] = f'Bearer {api_key}'
        payload = {'items': [
            {'filename': e['name'], 'size': e['_fp']['size'],
             'head': e['_fp']['head'], 'tail': e['_fp']['tail']}
            for e in pending
        ]}
        try:
            resp = requests.post(f'{api_url}/files/check-batch', json=payload,
                                 headers=headers, timeout=30)
            if resp.ok:
                data = resp.json()
                by_name = {}
                for r in (data.get('items') or []):
                    if isinstance(r, dict) and r.get('filename'):
                        by_name[str(r['filename'])] = r
                for e in pending:
                    r = by_name.get(e['name'])
                    if r and r.get('status') in ('identical', 'different', 'absent'):
                        e['status'] = r['status']
                        e['remote'] = r.get('remote')
                    else:
                        e['error'] = 'réponse serveur incomplète'
                for e in results:
                    e.pop('_fp', None)
                return {'ok': True, 'error': None, 'items': results}
            try:
                err = resp.json().get('error', resp.text[:200])
            except Exception:
                err = resp.text[:200] or f'HTTP {resp.status_code}'
        except Exception as e:
            err = str(e)

    for e in results:
        e.pop('_fp', None)
        if e['status'] == 'unknown':
            e['error'] = e['error'] or err
    return {'ok': False, 'error': err, 'items': results}


def get_download_progress(upload_id):
    """Retourne la progression d'un download en cours.

    ``phase`` distingue explicitement les deux états visibles côté client :
      - ``'preparing'`` : le transfert est en cours d'établissement (aucun octet
        reçu). Avec l'ancien backend (préchargement complet du stockage vers un
        temp), cette phase durait des dizaines de minutes pour 13,5 Go ; elle
        reste possible avec le repli temp ou un premier paquet lent.
      - ``'transferring'`` : des octets sont déjà arrivés (débit/% affichables).
    ``elapsed_s`` permet à l'UI de calculer un débit MOYEN stable (et une ETA)
    au lieu de la vitesse instantanée sujet aux à-coups réseau.
    """
    p = _download_progress.get(upload_id)
    if not p:
        return None
    pct = round(p['bytes_recv'] / p['bytes_total'] * 100, 1) if p['bytes_total'] > 0 else 0
    elapsed = max(0.0, time.time() - p.get('start', time.time()))
    # ``idle_s`` = secondes depuis le DERNIER octet reçu (ou depuis le début si
    # aucun). La fenêtre de transferts s'en sert pour dire EXPLICITEMENT
    # « serveur muet depuis N s » au-delà de ``DOWNLOAD_IDLE_WARN_S`` — au lieu
    # d'un « Préparation côté serveur… » muet qui dure des minutes.
    idle = max(0.0, time.monotonic() - p.get('last_activity', time.monotonic()))
    return {
        'bytes_recv': p['bytes_recv'],
        'bytes_total': p['bytes_total'],
        'percent': pct,
        'speed_mbs': p['speed_mbs'],
        'phase': 'transferring' if p['bytes_recv'] > 0 else 'preparing',
        'elapsed_s': round(elapsed, 1),
        'idle_s': round(idle, 1),
        'backend_streaming': p.get('backend_streaming'),
    }


def _sftp_mkdir_p(sftp, remote_dir):
    """Cree les dossiers parents recursivement sur SFTP."""
    if not remote_dir or remote_dir == "/":
        return
    dirs_to_create = []
    current = remote_dir
    while current and current != "/":
        try:
            sftp.stat(current)
            break
        except IOError:
            dirs_to_create.append(current)
            current = "/".join(current.split("/")[:-1])
    for d in reversed(dirs_to_create):
        try:
            sftp.mkdir(d)
        except Exception:
            pass


def get_upload_progress(filepath):
    """Retourne la progression d'un upload en cours.

    ``phase`` vaut ``'uploading'`` (envoi des chunks) ou ``'finalizing'``
    (tous les chunks reçus, le serveur recopie le fichier complet vers le
    stockage — étape longue et sans progression fine). L'UI s'en sert pour
    afficher une finalisation explicite au lieu d'une barre figée muette.
    """
    p = _upload_progress.get(filepath)
    if not p:
        return None
    phase = p.get('phase', 'uploading')
    if phase == 'finalizing':
        # Les octets sont TOUS arrivés : 100 % pendant la finalisation serveur.
        return {
            'chunk': p.get('chunk', 1),
            'total': p.get('total', 1),
            'percent': 100.0,
            'speed_mbs': p.get('speed_mbs', 0.0),
            'phase': 'finalizing',
        }
    if 'bytes_total' in p and p['bytes_total'] > 0:
        pct = round(p['bytes_sent'] / p['bytes_total'] * 100, 1)
    else:
        pct = round(p['chunk'] / p['total'] * 100, 1) if p['total'] > 0 else 0
    return {
        'chunk': p['chunk'],
        'total': p['total'],
        'percent': pct,
        'speed_mbs': p['speed_mbs'],
        'phase': phase,
    }


def download_model_from_server(upload_id, filename, file_type="model", dest_path=None):
    """
    Download un model depuis le serveur AIH et le sauvegarde dans le dossier local.
    Si dest_path est fourni, sauvegarde a cet emplacement exact (chemin relatif
    au dossier du type). Sinon, sauvegarde dans le dossier par defaut du type.
    Retourne {success, path} ou {success: False, error[, cancelled: True]}.
    Import paramiko paresseux (uniquement en mode SFTP direct).

    Garanties :
      - le transfert s'ecrit dans ``<dest>.part`` puis REMPLACE la destination :
        jamais de modele tronque ou de 0 octet visible dans models/ (un
        fichier partiel charge par un workflow fait planter ComfyUI) ;
      - le partiel est nettoye en cas d'echec ou d'annulation ;
      - progression publiee pendant tout le transfert (``_download_progress``)
        et annulation cooperative via ``request_download_cancel`` ;
      - refus AVANT le transfert si le disque ne peut pas accueillir le fichier.
    """
    import requests

    api_url, api_key = _get_aih_credentials()
    if not api_url:
        return {'success': False,
                'error': "Serveur AIH non configuré (Settings ▸ onglet « AIH · Compte »)"}
    auth_headers = {}
    if api_key:
        auth_headers["Authorization"] = f"Bearer {api_key}"

    # Un download RELANCÉ pour le même upload_id ne doit pas hériter d'une
    # annulation posée juste avant : le drapeau est à usage unique.
    _download_cancel.discard(upload_id)

    # Déterminer le dossier de destination selon le type
    dirs = _get_model_dirs()

    # Mapper les categories de detection vers les dossiers ComfyUI
    type_to_cat = {
        'checkpoint': 'checkpoints',
        'lora': 'loras',
        'vae': 'vae',
        'clip': 'clip',
        'clip_vision': 'clip_vision',
        'controlnet': 'controlnet',
        'unet': 'unet',
        'unet_gguf': 'unet_gguf',
        'upscale': 'upscale_models',
        'gligen': 'gligen',
        'hypernetwork': 'hypernetworks',
        'text_encoder': 'text_encoders',
        'style_model': 'style_models',
        'diffusion_model': 'diffusion_models',
        'embedding': 'embeddings',
        'config': 'configs',
        'model': 'checkpoints',  # fallback
    }

    cat = type_to_cat.get(file_type, 'checkpoints')
    dest_dirs = dirs.get(cat, dirs.get('checkpoints', []))

    if not dest_dirs:
        return {'success': False, 'error': f'No model directory for type {file_type}'}

    dest_dir = dest_dirs[0]
    # Si dest_path est fourni, utiliser le chemin personnalise (peut inclure des sous-dossiers)
    if dest_path:
        # Nettoyer le chemin (enlever les ../ etc)
        clean_path = os.path.normpath(dest_path).lstrip('/')
        # Si le chemin contient des sous-dossiers, les creer
        sub_dir = os.path.dirname(clean_path)
        if sub_dir:
            full_dir = os.path.join(dest_dir, sub_dir)
            os.makedirs(full_dir, exist_ok=True)
            dest_path = os.path.join(full_dir, os.path.basename(clean_path))
        else:
            dest_path = os.path.join(dest_dir, clean_path)
    else:
        dest_path = os.path.join(dest_dir, filename)

    # Security: ensure the final path stays within dest_dir
    dest_real = os.path.realpath(dest_path)
    dest_dir_real = os.path.realpath(dest_dir)
    if not (dest_real == dest_dir_real or dest_real.startswith(dest_dir_real + os.sep)):
        return {'success': False, 'error': 'Invalid destination path'}

    # Le dossier cible peut ne pas encore exister (categorie jamais utilisee).
    try:
        os.makedirs(os.path.dirname(dest_path) or dest_dir, exist_ok=True)
    except OSError as e:
        return {'success': False, 'error': f'Dossier de destination invalide: {e}'}

    # 0. Préflight SANTÉ/VERSION du backend (5 s au lieu de minutes) : un
    # backend antérieur au correctif de streaming précharge 13,5 Go avant le
    # 1er octet → refus immédiat avec la marche à suivre, jamais une fenêtre
    # bloquée à 0 octet. Sonde impossible (réseau/proxy) = on continue
    # (best effort : le watchdog du transfert reste la ceinture de sécurité).
    streaming_ok, streaming_detail = _backend_streaming_capability(api_url, auth_headers)
    if streaming_ok is False:
        logging.warning("[AIH] Backend sans streaming (%s) — download refusé", streaming_detail)
        return {'success': False, 'backend_outdated': True,
                'error': _backend_outdated_error(api_url, streaming_detail)}

    # 1. Récupérer la config de download (SFTP direct ou HTTP fallback)
    try:
        info_resp = requests.get(f"{api_url}/files/{upload_id}/download-info",
                                 headers=auth_headers, timeout=30)
        if not info_resp.ok:
            return {'success': False, 'error': _download_http_error(info_resp)}
        info = info_resp.json()
    except Exception as e:
        return {'success': False, 'error': f'Download-info failed: {e}'}

    sftp_cfg = info.get('sftp')
    file_size = info.get('size', 0)

    # 1b. Refuser AVANT le transfert si le disque ne peut pas accueillir le
    # fichier (13,5 Go) : un disque plein a mi-transfert casse ComfyUI, pas
    # seulement le download. Best effort : mesure impossible = pas de blocage.
    if file_size and file_size > 0:
        try:
            free = shutil.disk_usage(os.path.dirname(dest_path) or dest_dir).free
            needed = int(file_size * 1.02) + 32 * 1024 * 1024
            if free < needed:
                return {'success': False, 'error': (
                    f"Espace disque insuffisant dans {dest_dir} : "
                    f"{free / 1073741824:.1f} Go libres, {file_size / 1073741824:.1f} Go requis")}
        except OSError:
            pass

    # Le transfert ecrit dans un fichier .part puis REMPLACE la destination :
    # jamais de modele tronque/0 octet visible dans models/ (un workflow qui
    # charge un fichier partiel fait planter ComfyUI).
    tmp_path = dest_path + '.part'
    _cleanup_partial(tmp_path)

    if sftp_cfg:
        # ── Mode direct SFTP : paramiko sftp.get() ──
        _download_progress[upload_id] = {
            'bytes_recv': 0, 'bytes_total': file_size,
            'speed_mbs': 0.0, 'start': time.time(), 'last_time': time.time(),
            'backend_streaming': streaming_ok, 'last_activity': time.monotonic(),
        }
        ssh = None
        watchdog = None
        try:
            ssh = _sftp_connect(sftp_cfg)
            # Même watchdog que le chemin HTTP : une connexion SFTP qui ne rend
            # rien est fermée de force → échec explicite au lieu d'un attente
            # sans fin (le callback de progression ne rappelle que sur octets).
            watchdog = _DownloadStallWatchdog(
                DOWNLOAD_STALL_TIMEOUT, on_stall=lambda: _quiet_close(ssh)
            ).start()
            try:
                sftp = ssh.open_sftp()
                sftp.sftp_chunk_size = 2 * 1024 * 1024

                full_remote = sftp_cfg['base_path'].rstrip('/') + '/' + sftp_cfg['remote_path']

                # Callback de progression + point d'annulation (une exception
                # levée ici est propagée par paramiko et interrompt le transfert).
                def _dl_cb(sent, total):
                    if upload_id in _download_cancel:
                        raise DownloadCancelled()
                    watchdog.touch()
                    now = time.time()
                    elapsed = now - _download_progress[upload_id]['start']
                    speed = (sent / 1048576) / elapsed if elapsed > 0 else 0
                    _download_progress[upload_id].update({
                        'bytes_recv': sent,
                        'speed_mbs': round(speed, 1),
                        'last_activity': time.monotonic(),
                    })

                sftp.get(full_remote, tmp_path, callback=_dl_cb)
                sftp.close()
            finally:
                ssh.close()
            _replace_download_file(tmp_path, dest_path)
            logging.info(f"[AIH] Direct SFTP download OK: {full_remote} → {dest_path}")
            return {'success': True, 'path': dest_path}
        except DownloadCancelled:
            return {'success': False, 'cancelled': True, 'error': 'Téléchargement annulé'}
        except Exception as e:
            if watchdog is not None and watchdog.stalled:
                return {'success': False, 'stalled': True,
                        'error': _download_stall_error(
                            api_url, DOWNLOAD_STALL_TIMEOUT,
                            _download_progress.get(upload_id, {}).get('bytes_recv', 0),
                            file_size)}
            return {'success': False, 'error': f'SFTP download failed: {e}'}
        finally:
            if watchdog is not None:
                watchdog.stop()
            _download_progress.pop(upload_id, None)
            _download_cancel.discard(upload_id)
            _cleanup_partial(tmp_path)
    else:
        # ── Mode HTTP (storage du backend) ──
        # Entrée de progression créée AVANT la requête : la fenêtre de transferts
        # voit « en préparation » dès la 1re seconde et ``idle_s`` grandir, MÊME
        # quand le backend n'a pas encore envoyé ses en-têtes (préchargement
        # d'un backend ancien = exactement le symptôme signalé).
        _download_progress[upload_id] = {
            'bytes_recv': 0, 'bytes_total': file_size,
            'speed_mbs': 0.0, 'start': time.time(), 'last_time': time.time(),
            'backend_streaming': streaming_ok, 'last_activity': time.monotonic(),
        }
        resp = None
        received = 0
        total = 0
        watchdog = _DownloadStallWatchdog(
            DOWNLOAD_STALL_TIMEOUT, on_stall=lambda: _quiet_close(resp)
        ).start()
        try:
            # Le read timeout EST le délai d'inactivité du watchdog : un backend
            # qui n'envoie AUCUN octet (ancien préchargement, stockage muet) fait
            # lever ReadTimeout au lieu d'attendre ~56 min pour 13,5 Go.
            resp = requests.get(f"{api_url}/files/{upload_id}/download",
                               headers=auth_headers, stream=True,
                               timeout=(_SERVER_SYNC_CONNECT_TIMEOUT,
                                        max(10.0, DOWNLOAD_STALL_TIMEOUT)))
            watchdog.touch()
            try:
                if not resp.ok:
                    return {'success': False, 'error': _download_http_error(resp)}

                total = int(resp.headers.get('Content-Length', 0))
                if total:
                    _download_progress[upload_id]['bytes_total'] = total

                with open(tmp_path, 'wb') as f:
                    for chunk in resp.iter_content(chunk_size=DOWNLOAD_READ_CHUNK):
                        if upload_id in _download_cancel:
                            raise DownloadCancelled()
                        f.write(chunk)
                        received += len(chunk)
                        watchdog.touch()
                        now = time.time()
                        chunk_elapsed = now - _download_progress[upload_id].get('last_time', now)
                        chunk_mb = len(chunk) / 1048576
                        speed = chunk_mb / chunk_elapsed if chunk_elapsed > 0 else 0
                        _download_progress[upload_id].update({
                            'bytes_recv': received,
                            'speed_mbs': round(speed, 1),
                            'last_time': now,
                            'last_activity': time.monotonic(),
                        })

                expected = total or file_size
                if expected and received < expected:
                    if watchdog.stalled:
                        return {'success': False, 'stalled': True,
                                'error': _download_stall_error(
                                    api_url, DOWNLOAD_STALL_TIMEOUT, received, total)}
                    raise IOError(f'Transfert incomplet: {received} octets recus sur {expected}')
            finally:
                # Libère la connexion même en cas d'annulation/erreur.
                _quiet_close(resp)

            _replace_download_file(tmp_path, dest_path)
            logging.info(f"[AIH] Downloaded {filename} → {dest_path}")
            return {'success': True, 'path': dest_path}
        except DownloadCancelled:
            return {'success': False, 'cancelled': True, 'error': 'Téléchargement annulé'}
        except Exception as e:
            if watchdog.stalled or isinstance(e, requests.exceptions.ReadTimeout):
                logging.warning("[AIH] Download %s figé (%s s sans octet) : %s",
                                upload_id, DOWNLOAD_STALL_TIMEOUT, e)
                return {'success': False, 'stalled': True,
                        'error': _download_stall_error(
                            api_url, DOWNLOAD_STALL_TIMEOUT, received, total)}
            if received > 0 and isinstance(
                e, (requests.exceptions.ChunkedEncodingError,
                    requests.exceptions.ConnectionError)
            ):
                # Le backend a coupé le flux en plein transfert (cas réel : son
                # propre watchdog d'inactivité a abandonné un stockage muet) :
                # message explicite au lieu d'un « connection reset » brut.
                logging.warning("[AIH] Download %s coupé en plein flux : %s", upload_id, e)
                return {'success': False, 'stalled': True,
                        'error': _download_stall_error(
                            api_url, DOWNLOAD_STALL_TIMEOUT, received, total)}
            if isinstance(e, requests.exceptions.ConnectTimeout):
                return {'success': False, 'error': (
                    f"Connexion au backend AI-Helper impossible ({e}). "
                    f"Vérifie que le service backend tourne et que l'URL "
                    f"({api_url}) est correcte.")}
            if isinstance(e, requests.exceptions.ConnectionError):
                return {'success': False, 'error': (
                    f"Connexion au backend AI-Helper interrompue ({e}). Vérifie que "
                    f"le service backend tourne et que GET {api_url}/health répond.")}
            return {'success': False, 'error': f'Transfert interrompu : {e}'}
        finally:
            watchdog.stop()
            _download_progress.pop(upload_id, None)
            _download_cancel.discard(upload_id)
            _cleanup_partial(tmp_path)
