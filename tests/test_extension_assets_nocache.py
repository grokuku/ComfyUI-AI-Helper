"""Anti-cache des assets de l'extension servis par ComfyUI.

Contexte (problème « les correctifs ne sont pas actifs ») : ComfyUI sert le
``WEB_DIRECTORY`` du pack sous ``/extensions/<dossier>/...`` **sans
Cache-Control**. Le navigateur pouvait donc continuer à exécuter un
``aih_workflow_share.js`` PÉRIMÉ après une mise à jour du pack (ancien message
d'erreur générique, cases cochées, badge sans raison : signature exacte des
captures utilisateur).

Correctif : une middleware aiohttp (enregistrée par ``__init__.py``) pose
``Cache-Control: no-cache, must-revalidate`` sur CES assets uniquement. La
fonction pure ``extension_assets_no_cache_headers`` est verrouillée ici :
revalidation forcée pour notre dossier, ZÉRO effet sur les autres extensions
ou les autres routes.

Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh
"""

import sys
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

pytest.importorskip("aiohttp")

from aih import routes as aih_routes  # noqa: E402  (après le bootstrap sys.path)

EXT = "ComfyUI-AI-Helper"


def _headers_for(path, ext=EXT):
    headers = {}
    changed = aih_routes.extension_assets_no_cache_headers(headers, path, ext)
    return changed, headers


@pytest.mark.parametrize("path", [
    f"/extensions/{EXT}/aih_workflow_share.js",
    f"/extensions/{EXT}/image_viewer/image_viewer_source.js",
    f"/extensions/{EXT}/css/holaf_themes.css",
])
def test_matching_assets_force_revalidation(path):
    changed, headers = _headers_for(path)
    assert changed is True
    assert headers["Cache-Control"] == "no-cache, must-revalidate"
    assert headers["Pragma"] == "no-cache"


def test_extension_root_without_slash_untouched():
    """``/extensions/<nom>`` (sans slash) n'est pas un asset : neutre."""
    changed, headers = _headers_for(f"/extensions/{EXT}")
    assert changed is False
    assert headers == {}


@pytest.mark.parametrize("path", [
    "/extensions/Other-Pack/foo.js",
    f"/extensions/{EXT}-OLD/foo.js",       # préfixe trompeur → jamais inclus
    f"/extensions/{EXT}/../Other/foo.js",  # chemin tordu → jamais inclus
    "/aih/local/js/app-core.js",
    "/api/aih/custom-nodes",
    "/",
])
def test_other_paths_untouched(path):
    changed, headers = _headers_for(path)
    assert changed is False
    assert headers == {}


def test_missing_inputs_untouched():
    assert aih_routes.extension_assets_no_cache_headers({}, "", EXT) is False
    assert aih_routes.extension_assets_no_cache_headers({}, "/extensions/x/a.js", "") is False
    assert aih_routes.extension_assets_no_cache_headers(None, "/extensions/x/a.js", EXT) is False


def test_idempotent_and_multidict_like():
    """Ré-appel idempotent (middleware exécutée après d'autres en-têtes)."""
    headers = {"Content-Type": "application/javascript"}
    assert aih_routes.extension_assets_no_cache_headers(
        headers, f"/extensions/{EXT}/aih_workflow_share.js", EXT) is True
    assert headers["Content-Type"] == "application/javascript"
    assert aih_routes.extension_assets_no_cache_headers(
        headers, f"/extensions/{EXT}/aih_workflow_share.js", EXT) is True
    assert headers["Cache-Control"] == "no-cache, must-revalidate"


def test_init_registers_the_middleware():
    """Verrou statique : la middleware est réellement BRANCHÉE dans __init__.py.

    (On ne peut pas importer l'entrée d'extension sans l'environnement ComfyUI —
    ``import server`` — donc on verrouille le câblage sur la source.)
    """
    src = (PACKAGE_DIR / "__init__.py").read_text(encoding="utf-8")
    assert "extension_assets_no_cache_headers" in src, "helper non importé"
    assert "app.middlewares.append(holaf_extension_nocache_middleware)" in src, \
        "middleware non enregistrée sur l'app aiohttp"
    assert "@web.middleware" in src, \
        "middleware sans décorateur @web.middleware = appelée en old-style (cassée)"
    assert '_HOLAF_EXT_DIR_NAME = os.path.basename(os.path.dirname(os.path.abspath(__file__)))' in src, \
        "nom du dossier d'extension non résolu"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
