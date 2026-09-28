"""Persistance du réglage `gallery_source` (switch de source galerie, étape 1).

La route `image_viewer_save_ui_settings_route` (__init__.py) ne persiste que
les clés présentes dans sa whitelist interne `keys_to_save`. Ce test l'extrait
par AST (le __init__.py racine n'est pas importable : il importe `server`) et
vérifie que la clé du switch y figure — le test ÉCHOUE si elle est retirée,
c'est le contrôle négatif de la persistance côté backend.

La validation des valeurs ('local' défaut, 'remote', invalide → 'local') et le
POST save-settings sont verrouillés côté JS par js/test_iv_source_switch.mjs.
"""

import ast
from pathlib import Path

import pytest

PACK_DIR = Path(__file__).resolve().parent.parent
ROUTE_NAME = "image_viewer_save_ui_settings_route"


def _keys_to_save() -> list:
    """Extrait la liste littérale `keys_to_save` de la route de sauvegarde."""
    tree = ast.parse((PACK_DIR / "__init__.py").read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == ROUTE_NAME:
            for stmt in ast.walk(node):
                if isinstance(stmt, ast.Assign):
                    names = [t.id for t in stmt.targets if isinstance(t, ast.Name)]
                    if "keys_to_save" in names and isinstance(stmt.value, ast.List):
                        return [e.value for e in stmt.value.elts if isinstance(e, ast.Constant)]
    raise AssertionError(f"whitelist keys_to_save introuvable dans {ROUTE_NAME}")


def test_gallery_source_is_persisted():
    """La clé du switch doit être dans la whitelist de save-settings."""
    keys = _keys_to_save()
    assert "gallery_source" in keys, (
        "gallery_source absente de keys_to_save : le switch ne serait pas "
        "persisté par POST /holaf/image-viewer/save-settings"
    )


@pytest.mark.parametrize("key", [
    "panel_is_fullscreen",
    "thumbnail_fit",
    "thumbnail_size",
    "theme",
    "search_text",
    "workflow_filter_internal",
    "workflow_filter_external",
])
def test_existing_settings_still_persisted(key):
    """Non-régression : les clés historiques de la whitelist restent sauvées."""
    assert key in _keys_to_save()
