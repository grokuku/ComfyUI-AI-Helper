"""Upload de modèles du pack : AUCUNE authentification applicative (décision produit).

Contrat verrouillé (routes RÉELLES extraites de __init__.py par AST, serveur
aiohttp réel, AUCUNE garde) :
  1. POST /holaf/models/upload-chunk SANS aucun cookie → 200 et le chunk est
     écrit sur disque (comportement « zéro mot de passe ») ;
  2. POST /holaf/models/finalize-upload SANS aucun cookie → 200 et le fichier
     est assemblé octet à octet ;
  3. contrôle négatif : aucune requête n'exige de session (pas de 401), et le
     module holaf_auth n'existe plus dans le pack.

C'est la preuve INVERSE de l'ancien tests/test_model_upload_auth_flow.py
(supprimé) : le pack ne garde plus ses routes ; l'accès est filtré en amont
par le reverse-proxy (Caddy basic_auth / Authentik).

Pourquoi extraire les handlers par AST : __init__.py importe `server` (ComfyUI)
et n'est pas importable tel quel. L'extraction fait tourner le CODE RÉEL des
routes, avec des dépendances minimales pointées vers tmp_path
(folder_paths.base_path, TEMP_UPLOAD_DIR) pour ne rien écrire dans le dépôt.
"""

import ast
import asyncio
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

PACKAGE_DIR = Path(__file__).resolve().parent.parent
_PKG = "holaf_utils_pkg"

UPLOAD_ID = "holaf-upload-test-123"
CHUNKS = [b"hello ", b"world!"]
TOTAL = sum(len(c) for c in CHUNKS)


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
    """App aiohttp réelle : les 2 routes d'upload, SANS aucune garde."""
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

    app = web.Application()
    app.router.add_post("/holaf/models/upload-chunk", ns["upload_model_chunk_route"])
    app.router.add_post("/holaf/models/finalize-upload", ns["finalize_upload_model_route"])
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


def test_upload_chunk_without_any_cookie_is_accepted(tmp_path):
    """Sans le moindre cookie : 200 et le chunk est bien écrit sur disque."""
    app, temp_uploads, _models_dir = _build_app(tmp_path)

    async def scenario():
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            resp = await client.post(
                "/holaf/models/upload-chunk", data=_chunk_form(UPLOAD_ID, 0, CHUNKS[0])
            )
            assert resp.status == 200, f"attendu 200 (aucune garde), reçu {resp.status}"
            assert (await resp.json())["status"] == "ok"
            assert [p.name for p in temp_uploads.iterdir()] == [f"{UPLOAD_ID}-0.chunk"], \
                "le chunk doit être écrit sans authentification"
        finally:
            await client.close()

    asyncio.run(scenario())


def test_full_upload_without_cookie_assembles_file(tmp_path):
    """chunks + finalize sans aucun cookie → fichier final octet à octet."""
    app, temp_uploads, models_dir = _build_app(tmp_path)

    async def scenario():
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
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
            assert final_path.is_file(), "fichier final assemblé sans authentification"
            assert final_path.read_bytes() == b"".join(CHUNKS), "contenu identique (octet à octet)"
            assert list(temp_uploads.iterdir()) == [], "chunks nettoyés après assemblage"
        finally:
            await client.close()

    asyncio.run(scenario())


def test_no_auth_module_in_pack():
    """Le module d'authentification applicative n'existe plus dans le pack."""
    assert not (PACKAGE_DIR / "holaf_auth.py").exists(), "holaf_auth.py doit avoir été supprimé"
    assert not (PACKAGE_DIR / "__main__.py").exists(), "le CLI de hash doit avoir été supprimé"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
