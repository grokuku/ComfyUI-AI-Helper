"""Persistance des filtres de la source SERVEUR (étape 5).

La route `image_viewer_save_ui_settings_route` (__init__.py) ne persiste que les
clés présentes dans sa whitelist `keys_to_save` (scalaires) et dans les blocs
`json.dumps(...)` (tableaux). Ce test l'extrait par AST (le __init__.py racine
n'est pas importable : il importe `server`) et vérifie que :

  - les scalaires `remote_*` figurent dans `keys_to_save` ;
  - les tableaux `remote_subfolders` / `remote_tags` sont stockés en JSON
    (comme folder_filters/format_filters), et NON comme des chaînes `str()`.

Le test du POST save-settings et la relecture des tableaux JSON côté JS sont
verrouillés par js/test_iv_remote_filters.mjs.
"""

import ast
from pathlib import Path

import pytest

PACK_DIR = Path(__file__).resolve().parent.parent
ROUTE_NAME = "image_viewer_save_ui_settings_route"

# Scalaires des filtres serveur (persistés via keys_to_save).
REMOTE_SCALAR_KEYS = [
    "remote_kind",
    "remote_from",
    "remote_to",
    "remote_q",
    "remote_favorite",
    "remote_status",
    "remote_sort",
]
# Tableaux des filtres serveur (persistés en JSON).
REMOTE_LIST_KEYS = ["remote_subfolders", "remote_tags"]


def _route_node():
    """Nœud AST de la route de sauvegarde des réglages de la galerie."""
    tree = ast.parse((PACK_DIR / "__init__.py").read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == ROUTE_NAME:
            return node
    raise AssertionError(f"route {ROUTE_NAME} introuvable dans __init__.py")


def _keys_to_save() -> list:
    """Liste littérale `keys_to_save` de la route de sauvegarde."""
    for stmt in ast.walk(_route_node()):
        if isinstance(stmt, ast.Assign):
            names = [t.id for t in stmt.targets if isinstance(t, ast.Name)]
            if "keys_to_save" in names and isinstance(stmt.value, ast.List):
                return [e.value for e in stmt.value.elts if isinstance(e, ast.Constant)]
    raise AssertionError(f"whitelist keys_to_save introuvable dans {ROUTE_NAME}")


def _json_persisted_keys() -> set:
    """Clés persistées via un bloc JSON (isinstance(data[key], list))."""
    keys = set()
    for stmt in ast.walk(_route_node()):
        if not isinstance(stmt, ast.If):
            continue
        for sub in ast.walk(stmt.test):
            if isinstance(sub, ast.Subscript) and isinstance(sub.slice, ast.Constant):
                value = sub.value
                if isinstance(value, ast.Name) and value.id == "data":
                    keys.add(sub.slice.value)
    return keys


@pytest.mark.parametrize("key", REMOTE_SCALAR_KEYS)
def test_remote_scalar_keys_persisted(key):
    """Chaque scalaire remote_* doit être dans la whitelist keys_to_save."""
    assert key in _keys_to_save(), (
        f"{key} absente de keys_to_save : le filtre serveur ne serait pas "
        "persisté par POST /holaf/image-viewer/save-settings"
    )


@pytest.mark.parametrize("key", REMOTE_LIST_KEYS)
def test_remote_list_keys_persisted_as_json(key):
    """remote_subfolders/remote_tags doivent être stockés en JSON (tableaux)."""
    assert key in _json_persisted_keys(), (
        f"{key} n'est pas persistée en JSON : les tableaux (multi-sélection "
        "dossiers/tags) seraient sérialisés en chaîne Python non relisible côté JS"
    )
    assert key not in _keys_to_save(), (
        f"{key} ne doit PAS être dans keys_to_save (str() produirait une chaîne "
        "non-JSON ; elle est traitée par le bloc json.dumps)"
    )


def test_gallery_source_still_persisted():
    """Non-régression : le switch de source (étape 1) reste persisté."""
    assert "gallery_source" in _keys_to_save()
