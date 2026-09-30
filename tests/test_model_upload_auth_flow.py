"""Upload de modèles du pack : la garde d'authentification BOUT EN BOUT.

Contrat verrouillé (routes RÉELLES extraites de __init__.py par AST, serveur
aiohttp réel, garde réelle holaf_auth.require_auth) :
  1. POST /holaf/models/upload-chunk sans cookie de session → 401
     {"success": false, "error": "Authentication required."} et AUCUN chunk
     écrit sur disque ;
  2. POST /holaf/models/finalize-upload sans cookie → 401 et AUCUN fichier ;
  3. avec le cookie holaf_session (posé par le login réel) : la séquence
     nominale chunks → finalize assemble le fichier sur disque (contenu
     identique) et répond 200 — c'est le flux que le front doit rejoindre ;
  4. contrôle négatif : un cookie signé mais ALTÉRÉ → 401 (pas de laisser-passer).

Pourquoi extraire les handlers par AST : __init__.py importe `server` (ComfyUI)
et n'est pas importable tel quel. L'extraction fait tourner le CODE RÉEL des
routes (pas une copie), avec des dépendances minimales pointées vers tmp_path
(folder_paths.base_path, TEMP_UPLOAD_DIR) pour ne rien écrire dans le dépôt.

Le bug client corrigé (js/model_manager/model_manager_actions.js) était de ne
JAMAIS déclencher l'invite partagée ni rejouer la requête sur ce 401 : la
preuve front est js/test_model_manager_auth_upload.mjs ; ce fichier verrouille
le contrat HTTP que ce test simule.
"""

import ast
import asyncio
import importlib.util
import os
import re
import sys
import threading
import traceback
import types
from pathlib import Path

import pytest
from aiohttp import FormData, web
from aiohttp.test_utils import TestClient, TestServer

# Le minimum de mot de passe doit être déterministe dans les tests.
os.environ.pop("AIH_MIN_PASSWORD_LENGTH", None)

PACKAGE_DIR = Path(__file__).resolve().parent.parent
_PKG = "holaf_utils_pkg"

PASSWORD = "password-8"
UPLOAD_ID = "holaf-upload-test-123"
CHUNKS = [b"hello ", b"world!"]
TOTAL = sum(len(c) for c in CHUNKS)

_holaf_auth = None


def _ensure_pkg():
    if _PKG not in sys.modules:
        pkg = types.ModuleType(_PKG)
        pkg.__path__ = [str(PACKAGE_DIR)]
        sys.modules[_PKG] = pkg


def _load_module(name):
    _ensure_pkg()
    spec = importlib.util.spec_from_file_location(f"{_PKG}.{name}", PACKAGE_DIR / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[f"{_PKG}.{name}"] = module
    spec.loader.exec_module(module)
    return module


def _auth():
    global _holaf_auth
    if _holaf_auth is None:
        _load_module("holaf_config")
        _holaf_auth = _load_module("holaf_auth")
    return _holaf_auth


def _extract_functions(file_path, names, namespace):
    """Exécute le CODE RÉEL des fonctions top-level demandées (sans décorateurs).

    __init__.py n'est pas importable (import `server`) : on compile uniquement
    les handlers voulus avec le namespace de dépendances fourni.
    """
    tree = ast.parse(Path(file_path).read_text(encoding="utf-8"))
    picked = [
        node for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names
    ]
    assert {node.name for node in picked} == set(names), f"fonctions absentes de {file_path}"
    for node in picked:
        node.decorator_list = []
    module = ast.Module(body=picked, type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), str(file_path), "exec"), namespace)
    return namespace


def _build_app(tmp_path):
    """App aiohttp réelle : login holaf_auth + les 2 routes d'upload gardées."""
    a = _auth()
    config = {"password_hash": a.hash_password(PASSWORD)}

    temp_uploads = tmp_path / "temp_uploads"
    temp_uploads.mkdir()
    models_dir = tmp_path / "models" / "checkpoints"
    models_dir.mkdir(parents=True)

    holaf_utils_stub = types.SimpleNamespace(TEMP_UPLOAD_DIR=str(temp_uploads))
    ns = {
        "os": os,
        "re": re,
        "traceback": traceback,
        "threading": threading,
        "asyncio": asyncio,
        "web": web,
        "holaf_utils": holaf_utils_stub,
        "TEMP_UPLOAD_DIR": str(temp_uploads),
        "folder_paths": types.SimpleNamespace(
            base_path=str(tmp_path),
            get_folder_paths=lambda folder_type: (
                [str(models_dir)] if folder_type == "checkpoints" else []
            ),
        ),
        "model_manager_helper": None,
    }

    utils_names = (
        "sanitize_upload_id",
        "sanitize_filename",
        "sanitize_directory_component",
        "assemble_chunks_blocking",
    )
    _extract_functions(PACKAGE_DIR / "holaf_utils.py", set(utils_names), ns)
    for name in utils_names:
        setattr(holaf_utils_stub, name, ns[name])

    _extract_functions(
        PACKAGE_DIR / "__init__.py",
        {"upload_model_chunk_route", "finalize_upload_model_route"},
        ns,
    )

    async def login(request):
        return await a.login_route(request, config)

    app = web.Application()
    app.router.add_post("/holaf/auth/login", login)
    app.router.add_post(
        "/holaf/models/upload-chunk", a.require_auth(ns["upload_model_chunk_route"])
    )
    app.router.add_post(
        "/holaf/models/finalize-upload", a.require_auth(ns["finalize_upload_model_route"])
    )
    return app, temp_uploads, models_dir


def _chunk_form(upload_id, index, data):
    form = FormData()
    form.add_field("upload_id", upload_id)
    form.add_field("chunk_index", str(index))
    form.add_field("file_chunk", data, filename=f"chunk{index}.bin",
                   content_type="application/octet-stream")
    return form


async def _post_finalize(client, upload_id):
    return await client.post("/holaf/models/finalize-upload", json={
        "upload_id": upload_id,
        "filename": "model.safetensors",
        "total_chunks": len(CHUNKS),
        "destination_type": "checkpoints",
        "subfolder": "",
        "expected_size": TOTAL,
    })


def test_model_upload_without_session_is_rejected_and_writes_nothing(tmp_path):
    """Sans cookie : 401 exact (message du front) et AUCUN octet sur disque."""
    app, temp_uploads, models_dir = _build_app(tmp_path)

    async def scenario():
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            resp = await client.post(
                "/holaf/models/upload-chunk", data=_chunk_form(UPLOAD_ID, 0, CHUNKS[0])
            )
            assert resp.status == 401, f"attendu 401, reçu {resp.status}"
            assert await resp.json() == {
                "success": False,
                "error": "Authentication required.",
            }, "corps 401 exact attendu (celui géré par le front)"
            assert list(temp_uploads.iterdir()) == [], "aucun chunk ne doit être écrit"

            resp = await _post_finalize(client, UPLOAD_ID)
            assert resp.status == 401, f"attendu 401, reçu {resp.status}"
            assert await resp.json() == {
                "success": False,
                "error": "Authentication required.",
            }
            assert not (models_dir / "model.safetensors").exists(), "aucun fichier assemblé"
        finally:
            await client.close()

    asyncio.run(scenario())


def test_model_upload_with_session_assembles_file_over_the_wire(tmp_path):
    """Avec le cookie posé par le login : chunks + finalize 200 → fichier sur disque."""
    app, temp_uploads, models_dir = _build_app(tmp_path)

    async def scenario():
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            resp = await client.post("/holaf/auth/login", json={"password": PASSWORD})
            assert resp.status == 200, "login réel du pack"
            assert "holaf_session" in {c.key for c in client.session.cookie_jar}, "cookie posé"

            for index, chunk in enumerate(CHUNKS):
                resp = await client.post(
                    "/holaf/models/upload-chunk", data=_chunk_form(UPLOAD_ID, index, chunk)
                )
                assert resp.status == 200, f"chunk {index} : {resp.status}"
                assert (await resp.json())["status"] == "ok"
            assert sorted(p.name for p in temp_uploads.iterdir()) == [
                f"{UPLOAD_ID}-0.chunk", f"{UPLOAD_ID}-1.chunk"
            ], "les chunks reçus sont bien sur disque avant finalisation"

            resp = await _post_finalize(client, UPLOAD_ID)
            assert resp.status == 200, f"finalize : {resp.status}"
            assert (await resp.json())["status"] == "ok"

            final_path = models_dir / "model.safetensors"
            assert final_path.is_file(), "fichier final assemblé"
            assert final_path.read_bytes() == b"".join(CHUNKS), "contenu identique (octet à octet)"
            assert list(temp_uploads.iterdir()) == [], "chunks nettoyés après assemblage"
        finally:
            await client.close()

    asyncio.run(scenario())


def test_tampered_session_cookie_is_rejected(tmp_path):
    """Contrôle négatif : un cookie signé puis ALTÉRÉ ne passe pas la garde."""
    app, _temp_uploads, _models_dir = _build_app(tmp_path)
    a = _auth()

    async def scenario():
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            token = a.create_session_token()
            tampered = token[:-1] + ("0" if token[-1] != "0" else "1")
            client.session.cookie_jar.update_cookies({"holaf_session": tampered})
            resp = await client.post(
                "/holaf/models/upload-chunk", data=_chunk_form(UPLOAD_ID, 0, CHUNKS[0])
            )
            assert resp.status == 401, f"cookie altéré : attendu 401, reçu {resp.status}"
        finally:
            await client.close()

    asyncio.run(scenario())


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
