# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Harnais E2E RÉEL pour l'outil « Workflow Share » — support du test JS
# js/test_aih_workflow_share_real_server.mjs (lancé en sous-processus, jamais
# collecté par pytest : ce fichier ne s'appelle pas test_*.py).
#
# Il monte dans UN process :
#   1. le VRAI backend AI-Helper (Flask, code + DB réels) sur un port éphémère ;
#   2. les VRAIS handlers aiohttp du pack (/api/aih/custom-nodes*,
#      /api/aih/models/*) via aih.routes._register_models_group() — AUCUN mock
#      de handler (les variantes « watch » réutilisent le handler réel pour
#      journaliser les appels) ;
#   3. des stubs ComfyUI /object_info (contrat réel) et des endpoints de
#      contrôle (__calls, __uploads/*, __fault/custom-nodes-once).
#
# Sortie : UNE ligne JSON sur stdout (ports, token, id du workflow), puis le
# process reste vivant jusqu'à SIGTERM.

import asyncio
import json
import os
import sys
import tempfile
import threading
from pathlib import Path

os.environ["JWT_SECRET_KEY"] = "test-jwt-secret-key-for-pytest-0123456789"
os.environ["SECRET_KEY"] = "test-flask-secret-key-for-pytest"
os.environ["ENCRYPTION_KEY"] = "ZmDfcTF7_60GrrY167zsiPc4z_R0GfV9nJWz3z4YqXc="
os.environ["DISCORD_CLIENT_ID"] = "test-discord-id"
os.environ["DISCORD_CLIENT_SECRET"] = "test-discord-secret"
os.environ["DISCORD_GUILD_ID"] = ""

_TMP_DB = tempfile.mkdtemp(prefix="wfs_e2e_")
os.environ["AIH_DB_PATH"] = os.path.join(_TMP_DB, "test.db")

_PACK = os.environ.get(
    "AIH_E2E_PACK", str(Path(__file__).resolve().parent.parent)
)
_BACKEND = os.environ.get("AIH_E2E_BACKEND", "/projects/AI-Helper/backend")
sys.path.insert(0, _BACKEND)
sys.path.insert(0, _PACK)

# ── 1. Backend Flask réel ────────────────────────────────────────────────
import app as app_module  # noqa: E402
from db.init import _init_db  # noqa: E402

_init_db()
flask_app = app_module.app
flask_app.config["TESTING"] = True

from auth import create_jwt  # noqa: E402
from routes.helpers import get_db  # noqa: E402

USER_ID = "wfs-e2e-user"

UPLOAD_ROWS = [
    {"upload_id": "u-unet", "filename": "Krea2-Turbo-int8-ConvRot.safetensors", "size": 13500000000, "type": "unet"},
    {"upload_id": "u-clip", "filename": "qwen3-vl-4b-heritic_int8.safetensors", "size": 4600000000, "type": "clip"},
    {"upload_id": "u-up2", "filename": "OmniSR_X2_DIV2K.safetensors", "size": 100000000, "type": "upscale"},
    {"upload_id": "u-vae", "filename": "qwen_image_vae.safetensors", "size": 200000000, "type": "vae"},
    {"upload_id": "u-la", "filename": "lora-a.safetensors", "size": 10000000, "type": "lora"},
]

WORKFLOW_PAYLOAD = {
    "name": "Krea 2 E2E",
    "workflow_json": json.dumps({"nodes": [], "links": [], "extra": {"title": "Krea 2 E2E"}}),
    # Les 5 packs de la capture utilisateur, sous des alias (casse/.git/ssh/
    # dossier renommé/sans .git) + un pack reconnaissable UNIQUEMENT par ses
    # classes de nodes (dossier renommé + URL d'un autre dépôt).
    "required_nodes": [
        {"name": "ComfyUI-Holaf", "url": "https://github.com/Holaf/ComfyUI-Holaf"},
        {"name": "ComfyUI-AI-Helper", "url": "https://github.com/Holaf/ComfyUI-AI-Helper.git"},
        {"name": "AI-Helper", "url": "https://github.com/Holaf/AI-Helper"},
        {"name": "comfyui-vrgamedevgirl", "url": "https://github.com/vrgamedevgirl/comfyui-vrgamedevgirl"},
        {"name": "ComfyUI-Holaf-Utilities", "url": "https://github.com/Holaf/ComfyUI-Holaf-Utilities"},
        {"name": "ComfyUI-KJRenamed", "url": "https://github.com/kijai/ComfyUI-KJRenamed",
         "node_types": ["KJRenamedNode"]},
    ],
    "required_models": [
        {"name": "Krea2-Turbo-int8-ConvRot.safetensors", "type": "unet", "size": 13500000000},
        {"name": "qwen3-vl-4b-heritic_int8.safetensors", "type": "clip", "size": 4600000000},
        {"name": "OmniSR_X2_DIV2K.safetensors", "type": "upscale", "size": 100000000,
         "upload_id": "u-up2", "file_path": "upscale_models/OmniSR_X2_DIV2K.safetensors"},
        {"name": "qwen_image_vae.safetensors", "type": "vae", "size": 200000000,
         "upload_id": "u-vae", "file_path": "vae/qwen_image_vae.safetensors"},
    ],
    "required_loras": [
        {"name": "lora-a.safetensors", "type": "lora", "size": 10000000,
         "upload_id": "u-la", "file_path": "loras/lora-a.safetensors"},
    ],
}

# Workflow dédié au corps d'erreur TEXTE (serveur/proxy non-JSON).
WORKFLOW_TEXTFAIL_PAYLOAD = {
    "name": "TextFail E2E",
    "workflow_json": json.dumps({"nodes": [], "links": [], "extra": {"title": "TextFail E2E"}}),
    "required_nodes": [
        {"name": "__TEXT_FAIL__", "url": "https://github.com/Holaf/TextFail"},
    ],
    "required_models": [],
    "required_loras": [],
}

# Workflow dédié au chemin « bouton Installer par node » : le pack apparaît
# côté serveur ENTRE le rendu et le clic (dossier créé par /__pack/add).
WORKFLOW_LATE_PAYLOAD = {
    "name": "Late E2E",
    "workflow_json": json.dumps({"nodes": [], "links": [], "extra": {"title": "Late E2E"}}),
    "required_nodes": [
        {"name": "ComfyUI-LateAdded", "url": "https://github.com/Holaf/ComfyUI-LateAdded"},
    ],
    "required_models": [],
    "required_loras": [],
}


def _seed_user():
    conn = get_db()
    conn.execute(
        "INSERT OR REPLACE INTO users (id, username, display_name, role) VALUES (?, ?, ?, ?)",
        (USER_ID, "wfs_user", "WFS User", "user"),
    )
    conn.commit()
    conn.close()


def _seed_uploads(rows):
    conn = get_db()
    for it in rows:
        conn.execute(
            "INSERT OR REPLACE INTO file_uploads (upload_id, user_id, filename, size, type, "
            "chunk_size, total_chunks, received_chunks, temp_path, final_path, status, "
            "fingerprint_head, fingerprint_tail, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (it["upload_id"], USER_ID, it["filename"], it["size"], it["type"],
             25 * 1024 * 1024, 1, 1, "", it.get("final_path", ""), "complete",
             "h", "t", "2026-09-30 00:00:00"),
        )
    conn.commit()
    conn.close()


def _delete_uploads():
    conn = get_db()
    conn.execute("DELETE FROM file_uploads")
    conn.commit()
    conn.close()


_seed_user()
TOKEN = create_jwt(USER_ID, role="user")

from werkzeug.serving import make_server  # noqa: E402

_flask_srv = make_server("127.0.0.1", 0, flask_app, threaded=True)
_PORT_B = _flask_srv.server_port
threading.Thread(target=_flask_srv.serve_forever, daemon=True).start()

# ── 2. Handlers aiohttp RÉELS du pack ────────────────────────────────────
from aiohttp import web  # noqa: E402

from aih import custom_nodes_manager as cnm  # noqa: E402
from aih import model_manager as mm  # noqa: E402
from aih import routes as R  # noqa: E402

CUSTOM_NODES_DIR = Path(tempfile.mkdtemp(prefix="wfs_e2e_nodes_"))
cnm._CUSTOM_NODES_DIR = str(CUSTOM_NODES_DIR)


def _seed_installed_pack(folder, git_url="", mappings=None):
    d = CUSTOM_NODES_DIR / folder
    d.mkdir(parents=True, exist_ok=True)
    body = "NODE_CLASS_MAPPINGS = {"
    if mappings:
        body += ", ".join("'%s': object" % k for k in mappings)
    else:
        body += "'%sNode': object" % folder.replace("-", "").replace("_", "")
    body += "}\n"
    (d / "__init__.py").write_text(body, encoding="utf-8")
    if git_url:
        git = d / ".git"
        git.mkdir(exist_ok=True)
        (git / "config").write_text(
            '[core]\n\trepositoryformatversion = 0\n'
            f'[remote "origin"]\n\turl = {git_url}\n\tfetch = +refs/heads/*:refs/remotes/x/*\n',
            encoding="utf-8",
        )


# Les 5 packs détectables par URL/dossier… et UN seul par classes uniquement
# (dossier + URL différents du dépôt référencé par le workflow).
_seed_installed_pack("ComfyUI-Holaf", "https://github.com/Holaf/ComfyUI-Holaf.git")
_seed_installed_pack("ComfyUI-AI-Helper", "git@github.com:Holaf/ComfyUI-AI-Helper.git")
_seed_installed_pack("AI-Helper")  # alias sans .git (dossier seul)
_seed_installed_pack("comfyui-vrgamedevgirl", "https://github.com/vrgamedevgirl/comfyui-vrgamedevgirl")
_seed_installed_pack("ComfyUI-Holaf-Utilities")  # sans .git
_seed_installed_pack("RenamedKJ", mappings=["KJRenamedNode"])  # classes uniquement

# Credentials pack → VRAI backend Flask (proxy requests réel).
mm._get_aih_credentials = lambda: (f"http://127.0.0.1:{_PORT_B}/api", TOKEN)

CALLS = {"install": [], "download": [], "custom_nodes": 0}
FAULT_ONCE = {"custom-nodes": False}


class _Recorder:
    """Shim décorateur : collecte les (méthode, chemin, handler) réels.

    aiohttp 3.14 exige le handler dans add_get/add_post (formes décorateurs
    retirées) : on monte donc nous-mêmes les handlers sur le routeur.
    """

    def __init__(self):
        self.routes = []

    def _deco(self, method):
        def factory(path):
            def deco(handler):
                self.routes.append((method, path, handler))
                return handler
            return deco
        return factory

    def get(self, path):
        return self._deco("GET")(path)

    def post(self, path):
        return self._deco("POST")(path)


aio_app = web.Application()
rec = _Recorder()
R._register_models_group(rec)
_HANDLERS = {}
for method, path, handler in rec.routes:
    _HANDLERS[(method, path)] = handler
_WATCHED = {
    ("GET", "/api/aih/custom-nodes"),
    ("POST", "/api/aih/custom-nodes/install"),
    ("POST", "/api/aih/models/download"),
}
for (method, path), handler in _HANDLERS.items():
    if (method, path) in _WATCHED:
        continue  # remplacé par les variantes « watch » (handler VRAI réutilisé)
    if method == "GET":
        aio_app.router.add_get(path, handler)
    elif method == "POST":
        aio_app.router.add_post(path, handler)


def _real(method, path):
    return _HANDLERS[(method, path)]


# ── Stubs ComfyUI (contrat réel) + contrôle ──────────────────────────────
async def object_info_checkpoint(request):
    return web.json_response({
        "CheckpointLoaderSimple": {"inputs": {"required": {"ckpt_name": [[]]}}}
    })


async def object_info_lora(request):
    return web.json_response({
        "LoraLoader": {"inputs": {"required": {"lora_name": [[]]}}}
    })


async def custom_nodes_watch(request):
    CALLS["custom_nodes"] += 1
    if FAULT_ONCE["custom-nodes"]:
        # Panne transitoire UNE fois : la route réelle répond ensuite.
        FAULT_ONCE["custom-nodes"] = False
        return web.json_response({"error": "transient list failure"}, status=500)
    return await _real("GET", "/api/aih/custom-nodes")(request)


async def install_watch(request):
    body = await request.json()
    CALLS["install"].append(body)
    if body.get("name") == "__TEXT_FAIL__":
        # Réponse NON-JSON (proxy/erreur brute) : le message serveur réel est
        # dans le corps texte — le front doit le montrer, pas « réponse non-JSON ».
        return web.Response(text="git explode: permission denied",
                            status=500, content_type="text/plain")
    return await _real("POST", "/api/aih/custom-nodes/install")(request)


async def download_watch(request):
    body = await request.json()
    CALLS["download"].append(body)
    return await _real("POST", "/api/aih/models/download")(request)


async def calls(request):
    return web.json_response(CALLS)


async def calls_reset(request):
    CALLS["install"].clear()
    CALLS["download"].clear()
    CALLS["custom_nodes"] = 0
    return web.json_response({"ok": True})


async def uploads_delete(request):
    _delete_uploads()
    return web.json_response({"ok": True})


async def uploads_seed(request):
    body = await request.json()
    _seed_uploads(body.get("items", []))
    return web.json_response({"ok": True})


async def fault_custom_nodes_once(request):
    FAULT_ONCE["custom-nodes"] = True
    return web.json_response({"ok": True})


async def pack_add(request):
    """Ajoute un pack « déjà installé » APRÈS le rendu (entre rendu et clic)."""
    body = await request.json()
    _seed_installed_pack(body["folder"], body.get("git_url", ""))
    return web.json_response({"ok": True})


aio_app.router.add_get("/api/aih/custom-nodes", custom_nodes_watch)
aio_app.router.add_post("/api/aih/custom-nodes/install", install_watch)
aio_app.router.add_post("/api/aih/models/download", download_watch)
aio_app.router.add_get("/object_info/CheckpointLoaderSimple", object_info_checkpoint)
aio_app.router.add_get("/object_info/LoraLoader", object_info_lora)
aio_app.router.add_get("/__calls", calls)
aio_app.router.add_post("/__calls/reset", calls_reset)
aio_app.router.add_post("/__uploads/delete", uploads_delete)
aio_app.router.add_post("/__uploads/seed", uploads_seed)
aio_app.router.add_post("/__fault/custom-nodes-once", fault_custom_nodes_once)
aio_app.router.add_post("/__pack/add", pack_add)


async def main():
    import requests as _req
    _seed_uploads(UPLOAD_ROWS)
    ids = {}
    for key, payload in (("main", WORKFLOW_PAYLOAD), ("textfail", WORKFLOW_TEXTFAIL_PAYLOAD),
                         ("late", WORKFLOW_LATE_PAYLOAD)):
        resp = _req.post(
            f"http://127.0.0.1:{_PORT_B}/api/workflows",
            headers={"Authorization": f"Bearer {TOKEN}"},
            json=payload, timeout=10,
        )
        resp.raise_for_status()
        ids[key] = resp.json()["id"]

    runner = web.AppRunner(aio_app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port_a = site._server.sockets[0].getsockname()[1]
    print(json.dumps({
        "PACK_URL": f"http://127.0.0.1:{port_a}",
        "BACKEND_URL": f"http://127.0.0.1:{_PORT_B}",
        "TOKEN": TOKEN,
        "WORKFLOW_ID": ids["main"],
        "TEXTFAIL_WORKFLOW_ID": ids["textfail"],
        "LATE_WORKFLOW_ID": ids["late"],
        "CUSTOM_NODES_DIR": str(CUSTOM_NODES_DIR),
    }), flush=True)
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
