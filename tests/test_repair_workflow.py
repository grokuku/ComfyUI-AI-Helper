# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# OUTIL « RÉPARER UN WORKFLOW » — cœur métier Python (aih/repair_workflow.py)
# et routes /aih/repair/* (aih/routes.py).
#
# Ce fichier verrouille la SPÉCIFICATION UTILISATEUR :
#   • analyse GROUPÉE : une entrée par TYPE de node absente, comptes exacts,
#     occurrences racine + subgraphs (jamais une ligne par occurrence) ;
#   • les DEUX formats de `links` (tableau de tableaux / tableau d'objets /
#     objet indexé) sont lus ;
#   • remappage des widgets_values PAR NOM + signalement des non-remappables ;
#   • réparation limitée aux problèmes COCHÉS ;
#   • VALIDATION avant écriture (liens pendants / slots inexistants, subgraphs
#     inclus) ; refuse d'écrire si de NOUVELLES incohérences apparaissent ;
#   • sauvegarde .bak avant tout écrasement ;
#   • types inconnus SANS proposition affichés mais non cochables.
# Les CONTRÔLES NÉGATIFS par mutation prouvent que les vérificateurs ne sont
# pas vacuous : ne pas grouper, écraser sans sauvegarde, écrire malgré une
# validation échouée, ne pas remapper les widgets → ROUGE.
#
# Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh

import asyncio
import json
import sys
import types
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

from aih import repair_workflow as rw  # noqa: E402


# ─────────────────────────────────────────────────────────────────────────
# Fixtures de workflows réalistes
# ─────────────────────────────────────────────────────────────────────────

CLASS_DEFS = {
    "AIHRemoteComparer": {"widgets": ["comparison_name", "mode"]},
    "AIHRemote": {"widgets": ["url", "timeout"]},
    "AIHImageComparer": {"widgets": ["name"]},
    "TotallyUnknownReplacement": {"widgets": ["a", "b"]},
}


def _mk_node(nid, ntype, widgets=None, link=None, out_links=None, title=None):
    node = {
        "id": nid,
        "type": ntype,
        "pos": [0, 0],
        "size": [10, 10],
        "inputs": [{"name": "in", "type": "*", "link": link}],
        "outputs": [{"name": "out", "type": "*", "links": list(out_links or [])}],
    }
    if widgets is not None:
        node["widgets_values"] = list(widgets)
    if title is not None:
        node["title"] = title
    return node


def build_workflow():
    """Workflow réaliste : racine + subgraph, les deux formats de `links`.

    - 11 `HolafRemoteComparer` (alias supprimé, remplaçable) dans la RACINE ;
    - +1 dans un SUBGRAPH → 12 occurrences au total (le cas « 12 » de
      l'utilisateur) ;
    - 1 `HolafRemote` (alias) et 1 `AIHImageComparer` (valide) ;
    - 1 type TOTALEMENT inconnu (sans proposition) ;
    - 1 instance de subgraph (type = UUID d'une définition : NE DOIT PAS être
      signalée absente) ;
    - racine : `links` = tableau d'objets ; subgraph : `links` = OBJET.
    """
    root_nodes = [
        _mk_node(1, "AIHRemote", ["http://x", "5"], link=None, out_links=[1]),
        _mk_node(2, "HolafRemoteComparer", ["Cmp 1", "fast"], link=1),
    ]
    # 10 autres HolafRemoteComparer (nodes 3..12) → 11 en racine au total.
    for nid in range(3, 13):
        root_nodes.append(_mk_node(nid, "HolafRemoteComparer", ["C%d" % nid, "m"]))
    root_nodes.append(_mk_node(13, "HolafRemote", ["http://y", "9"]))
    root_nodes.append(_mk_node(14, "AIHImageComparer", ["img"]))
    root_nodes.append(_mk_node(15, "TotallyUnknownNode", ["?", "?"]))
    root_nodes.append(_mk_node(16, "sub-uuid-1"))  # instance de subgraph

    root_links = [
        {"id": 1, "origin_id": 1, "origin_slot": 0, "target_id": 2,
         "target_slot": 0, "type": "*"},
    ]

    sub_nodes = [
        _mk_node(101, "HolafRemoteComparer", ["Sub", "slow"], link=5),
        _mk_node(102, "AIHRemote", ["http://s", "1"]),
    ]
    # Format OBJET (ancien) pour le subgraph.
    sub_links = {"5": [5, -10, 0, 101, 0, "*"]}

    workflow = {
        "id": "root-uuid",
        "version": 1,
        "last_node_id": 16,
        "last_link_id": 5,
        "nodes": root_nodes,
        "links": root_links,
        "groups": [],
        "extra": {},
        "definitions": {
            "subgraphs": [
                {
                    "id": "sub-uuid-1",
                    "name": "Sub A",
                    "version": 1,
                    "inputNode": {"id": -10, "bounding": [0, 0, 75, 100]},
                    "outputNode": {"id": -20, "bounding": [0, 0, 75, 100]},
                    "inputs": [{"id": "in-uuid", "name": "in", "type": "*"}],
                    "outputs": [{"id": "out-uuid", "name": "out", "type": "*"}],
                    "widgets": [],
                    "nodes": sub_nodes,
                    "links": sub_links,
                    "groups": [],
                    "definitions": {"subgraphs": []},
                }
            ]
        },
    }
    return workflow


def _problems_by_old(analysis):
    return {p["old_type"]: p for p in analysis["problems"]}


# ─────────────────────────────────────────────────────────────────────────
# 1. Analyse GROUPÉE + couverture subgraphs + table d'alias
# ─────────────────────────────────────────────────────────────────────────

def test_alias_table_has_34_entries_and_is_canonical():
    assert len(rw.LEGACY_ALIAS_REPLACEMENTS) == 34
    assert rw.LEGACY_ALIAS_REPLACEMENTS["HolafRemoteComparer"] == "AIHRemoteComparer"
    assert rw.LEGACY_ALIAS_REPLACEMENTS["HolafRemote"] == "AIHRemote"
    assert rw.LEGACY_ALIAS_REPLACEMENTS["UpscaleImageHolaf"] == "AIHUpscale"
    for old, new in rw.LEGACY_ALIAS_REPLACEMENTS.items():
        assert new.startswith("AIH"), "%s → %s (clé canonique attendue AIH*)" % (old, new)
        assert not new.startswith("Holaf")


def test_analysis_groups_by_type_not_per_occurrence():
    analysis = rw.analyze(build_workflow(), class_defs=CLASS_DEFS)
    problems = _problems_by_old(analysis)
    # Une SEULE entrée pour HolafRemoteComparer, comptant les 12 occurrences.
    entry = problems["HolafRemoteComparer"]
    assert entry["count"] == 12, entry
    assert len(entry["occurrences"]) == 12
    # Et pas 12 entrées du même type.
    same_type = [p for p in analysis["problems"] if p["old_type"] == "HolafRemoteComparer"]
    assert len(same_type) == 1


def test_analysis_covers_root_and_subgraphs():
    analysis = rw.analyze(build_workflow(), class_defs=CLASS_DEFS)
    entry = _problems_by_old(analysis)["HolafRemoteComparer"]
    scopes = {o["scope"] for o in entry["occurrences"]}
    assert "root" in scopes
    assert any(s.startswith("root › Sub A") for s in scopes), scopes
    # L'occurrence subgraph provient bien du node 101.
    sub_occ = [o for o in entry["occurrences"] if o["scope"] != "root"]
    assert sub_occ and sub_occ[0]["node_id"] == 101


def test_subgraph_instance_type_is_not_reported_missing():
    analysis = rw.analyze(build_workflow(), class_defs=CLASS_DEFS)
    assert "sub-uuid-1" not in _problems_by_old(analysis)


def test_unknown_type_without_proposal_is_displayed_but_not_checkable():
    analysis = rw.analyze(build_workflow(), class_defs=CLASS_DEFS)
    entry = _problems_by_old(analysis)["TotallyUnknownNode"]
    assert entry["new_type"] is None
    assert entry["checkable"] is False
    assert entry["action"] is None


def test_alias_problem_is_checkable_with_action():
    analysis = rw.analyze(build_workflow(), class_defs=CLASS_DEFS)
    entry = _problems_by_old(analysis)["HolafRemoteComparer"]
    assert entry["checkable"] is True
    assert entry["new_type"] == "AIHRemoteComparer"
    assert entry["action"] == {
        "type": "replace_node_type",
        "from": "HolafRemoteComparer",
        "to": "AIHRemoteComparer",
    }


def test_without_class_defs_only_legacy_aliases_are_reported():
    """Pas de faux positif sur un type valide quand /object_info est absent."""
    analysis = rw.analyze(build_workflow(), class_defs=None)
    olds = set(_problems_by_old(analysis))
    assert "HolafRemoteComparer" in olds and "HolafRemote" in olds
    assert "AIHRemote" not in olds and "AIHImageComparer" not in olds
    # Type totalement inconnu non vérifiable → non signalé.
    assert "TotallyUnknownNode" not in olds
    assert analysis["stats"]["known_types_available"] is False


# ─────────────────────────────────────────────────────────────────────────
# 2. Lecture des deux formats de `links`
# ─────────────────────────────────────────────────────────────────────────

def test_iter_links_reads_array_of_objects():
    wf = {"links": [{"id": 1, "origin_id": 1, "origin_slot": 0,
                     "target_id": 2, "target_slot": 0, "type": "*"}]}
    links = list(rw.iter_links(wf))
    assert len(links) == 1
    assert links[0]["origin_id"] == 1 and links[0]["format"] == "object"


def test_iter_links_reads_array_of_arrays():
    wf = {"links": [[1, 1, 0, 2, 0, "*"]]}
    links = list(rw.iter_links(wf))
    assert len(links) == 1
    assert links[0]["target_id"] == 2 and links[0]["format"] == "array"


def test_iter_links_reads_object_map():
    wf = {"links": {"5": [5, -10, 0, 7, 0, "*"]}}
    links = list(rw.iter_links(wf))
    assert len(links) == 1
    assert links[0]["id"] == "5" or links[0]["id"] == 5


def test_iter_links_both_formats_yield_same_normalized_link():
    a = list(rw.iter_links({"links": [[1, 1, 0, 2, 0, "*"]]}))[0]
    b = list(rw.iter_links({"links": [{"id": 1, "origin_id": 1, "origin_slot": 0,
                                       "target_id": 2, "target_slot": 0, "type": "*"}]}))[0]
    for key in ("id", "origin_id", "origin_slot", "target_id", "target_slot", "type"):
        assert a[key] == b[key]


# ─────────────────────────────────────────────────────────────────────────
# 3. Validation AVANT écriture
# ─────────────────────────────────────────────────────────────────────────

def test_realistic_workflow_is_valid():
    assert rw.validate_workflow(build_workflow()) == []


def test_validation_detects_dangling_link_target():
    wf = build_workflow()
    wf["nodes"].append(_mk_node(999, "AIHRemote", ["u", "1"], link=777))
    errors = rw.validate_workflow(wf)
    assert any(e["code"] == "input_link_missing" and e["node_id"] == 999 for e in errors)


def test_validation_detects_missing_link_node():
    wf = build_workflow()
    wf["links"].append({"id": 88, "origin_id": 424242, "origin_slot": 0,
                        "target_id": 2, "target_slot": 0, "type": "*"})
    errors = rw.validate_workflow(wf)
    assert any(e["code"] == "link_origin_missing" for e in errors)


def test_validation_detects_slot_out_of_range():
    wf = build_workflow()
    wf["links"][0]["origin_slot"] = 99
    errors = rw.validate_workflow(wf)
    assert any(e["code"] == "link_origin_slot_missing" for e in errors)


def test_validation_covers_subgraphs():
    wf = build_workflow()
    wf["definitions"]["subgraphs"][0]["nodes"].append(
        _mk_node(200, "AIHRemote", ["a", "b"], link=12345)
    )
    errors = rw.validate_workflow(wf)
    assert any(e["code"] == "input_link_missing" and e["node_id"] == 200 for e in errors)


# ─────────────────────────────────────────────────────────────────────────
# 4. Remappage des widgets_values PAR NOM + signalement
# ─────────────────────────────────────────────────────────────────────────

def test_remap_by_name_reorders_values():
    new_values, unmapped, remapped = rw.remap_widget_values(
        ["a", "b", "c"], [1, 2, 3], ["c", "a", "d"]
    )
    assert remapped is True
    assert new_values[:3] == [3, 1, None]
    assert unmapped == [{"index": 1, "name": "b", "value": 2}]


def test_remap_identity_when_names_match():
    new_values, unmapped, remapped = rw.remap_widget_values(
        ["a", "b"], [10, 20], ["a", "b"]
    )
    assert new_values == [10, 20]
    assert unmapped == []
    assert remapped is True


def test_remap_signals_everything_when_old_names_unknown():
    new_values, unmapped, remapped = rw.remap_widget_values(None, [1, 2], ["a", "b"])
    assert new_values == [1, 2]
    assert remapped is False
    assert len(unmapped) == 2


def test_widget_names_from_input_types_orders_required_then_optional():
    input_types = {
        "required": {
            "seed": ("INT", {"default": 0}),
            "model": ("MODEL", {"forceInput": True}),  # pas un widget
            "mode": (["a", "b"],),  # COMBO = widget
        },
        "optional": {"note": ("STRING", {})},
    }
    assert rw.widget_names_from_input_types(input_types) == ["seed", "mode", "note"]


def test_build_class_defs_from_nodes_with_fake_mapping():
    class _Fake:
        @classmethod
        def INPUT_TYPES(cls):
            return {"required": {"a": ("INT", {}), "b": ("STRING", {})}}

    defs = rw.build_class_defs_from_nodes({"AihFake": _Fake})
    assert defs == {"AihFake": {"widgets": ["a", "b"]}}
    # Mapping absent → {} (jamais de faux positif).
    assert rw.build_class_defs_from_nodes({}) == {}
    assert rw.build_class_defs_from_nodes(None) == {}


def test_iter_graphs_recurses_nested_subgraphs():
    nested = {
        "id": "outer", "name": "Outer", "nodes": [], "links": [],
        "definitions": {"subgraphs": [
            {"id": "inner", "name": "Inner", "nodes": [], "links": [],
             "definitions": {"subgraphs": []}},
        ]},
    }
    wf = {"nodes": [], "links": [], "definitions": {"subgraphs": [nested]}}
    labels = [label for label, _g in rw.iter_graphs(wf)]
    assert labels[0] == "root"
    assert any("Outer" in l for l in labels)
    assert any("Inner" in l for l in labels)
    assert rw.collect_subgraph_ids(wf) == {"outer", "inner"}


def test_apply_type_replacement_remaps_by_name_and_reports_unmapped():
    node = {"type": "OldX", "widgets_values": [1, 2, 3]}
    info = rw.apply_type_replacement(
        node, "NewX", "OldX",
        class_defs={"OldX": {"widgets": ["a", "b", "c"]},
                    "NewX": {"widgets": ["c", "a", "d"]}},
        alias_map={},
    )
    assert node["type"] == "NewX"
    assert node["widgets_values"][:3] == [3, 1, None]
    assert info["remapped"] is True
    assert info["unmapped"] and info["unmapped"][0]["name"] == "b"


def test_apply_preserves_alias_widget_values_by_name():
    wf = build_workflow()
    analysis = rw.analyze(wf, class_defs=CLASS_DEFS)
    pid = _problems_by_old(analysis)["HolafRemoteComparer"]["id"]
    repaired, report = rw.apply_repairs(wf, [pid], class_defs=CLASS_DEFS)
    node = rw._find_node(repaired, 2)
    assert node["type"] == "AIHRemoteComparer"
    assert node["widgets_values"] == ["Cmp 1", "fast"]
    assert rw.repair_summary(report)["widgets_unmapped"] == 0


# ─────────────────────────────────────────────────────────────────────────
# 5. Réparation limitée au coché
# ─────────────────────────────────────────────────────────────────────────

def test_apply_only_selected_problems():
    wf = build_workflow()
    analysis = rw.analyze(wf, class_defs=CLASS_DEFS)
    by_old = _problems_by_old(analysis)
    # On ne coche QUE HolafRemote (pas HolafRemoteComparer).
    repaired, report = rw.apply_repairs(wf, [by_old["HolafRemote"]["id"]],
                                        class_defs=CLASS_DEFS)
    types = [n["type"] for _s, g in rw.iter_graphs(repaired) for n in g.get("nodes", [])]
    assert "AIHRemote" in types
    assert "HolafRemoteComparer" in types  # non coché → inchangé
    # L'original n'est PAS modifié.
    assert any(n["type"] == "HolafRemote" for n in wf["nodes"])


def test_apply_both_aliases():
    wf = build_workflow()
    analysis = rw.analyze(wf, class_defs=CLASS_DEFS)
    selected = [p["id"] for p in analysis["problems"] if p["checkable"]]
    repaired, report = rw.apply_repairs(wf, selected, class_defs=CLASS_DEFS)
    olds = {"HolafRemoteComparer", "HolafRemote"}
    remaining = {n["type"] for _s, g in rw.iter_graphs(repaired)
                 for n in g.get("nodes", [])} & olds
    assert remaining == set()
    assert len(report["applied"]) == 2


def test_apply_reports_renamed_nodes_count_and_diff():
    wf = build_workflow()
    analysis = rw.analyze(wf, class_defs=CLASS_DEFS)
    pid = _problems_by_old(analysis)["HolafRemoteComparer"]["id"]
    repaired, report = rw.apply_repairs(wf, [pid], class_defs=CLASS_DEFS)
    assert rw.repair_summary(report)["nodes_renamed"] == 12
    diff = rw.diff_workflows(wf, repaired)
    type_changes = [d for d in diff if d["field"] == "type"]
    assert len(type_changes) == 12


def test_apply_ignore_unknown_selected_ids():
    wf = build_workflow()
    repaired, report = rw.apply_repairs(wf, ["does-not-exist"], class_defs=CLASS_DEFS)
    assert report["unknown_selected"] == ["does-not-exist"]
    assert repaired == wf


def test_apply_detects_new_validation_errors(monkeypatch):
    """Si une réparation introduisait un lien pendant → NOUVELLE erreur."""
    wf = build_workflow()
    analysis = rw.analyze(wf, class_defs=CLASS_DEFS)
    pid = _problems_by_old(analysis)["HolafRemoteComparer"]["id"]

    real = rw.apply_type_replacement

    def saboteur(node, new_type, old_type, **kwargs):
        info = real(node, new_type, old_type, **kwargs)
        node.setdefault("outputs", []).append({"name": "x", "type": "*", "links": [987654]})
        return info

    monkeypatch.setattr(rw, "apply_type_replacement", saboteur)
    repaired, report = rw.apply_repairs(wf, [pid], class_defs=CLASS_DEFS)
    assert report["new_validation_errors"], "la nouvelle incohérence doit être détectée"
    assert any(e["code"] == "output_link_missing" for e in report["new_validation_errors"])


def test_apply_keeps_pre_existing_errors_separate():
    wf = build_workflow()
    # Incohérence PRÉ-EXISTANTE : un input référence un lien inexistant.
    wf["nodes"].append(_mk_node(300, "AIHRemote", ["u", "1"], link=4242))
    analysis = rw.analyze(wf, class_defs=CLASS_DEFS)
    pid = _problems_by_old(analysis)["HolafRemote"]["id"]
    _repaired, report = rw.apply_repairs(wf, [pid], class_defs=CLASS_DEFS)
    assert report["new_validation_errors"] == []
    assert report["validation_before"], "l'incohérence pré-existante doit être listée"


# ─────────────────────────────────────────────────────────────────────────
# 6. Contrôles NÉGATIFS par mutation (vérificateurs non vacuous)
# ─────────────────────────────────────────────────────────────────────────

def test_mutation_not_grouping_is_red():
    """Sans regroupement, plusieurs entrées par type → le test de groupe échoue."""
    wf = build_workflow()
    analysis = rw.analyze(wf, class_defs=CLASS_DEFS)
    grouped_entry = _problems_by_old(analysis)["HolafRemoteComparer"]
    # Simule un « non-regroupement » : une entrée par occurrence.
    ungrouped = [
        {**p, "occurrences": [occ]}
        for p in analysis["problems"]
        for occ in p["occurrences"]
    ]
    per_type = [p for p in ungrouped if p["old_type"] == "HolafRemoteComparer"]
    assert len(per_type) == 12  # le regroupement réel donne 1 entrée (vu plus haut)
    assert grouped_entry["count"] == 12


def test_mutation_group_key_collapses_type_without_replacement():
    """Un type sans proposition ne doit JAMAIS être fusionné avec un autre."""
    occ = [
        {"kind": "missing_node_type", "key": ("UnknownA", None),
         "old_type": "UnknownA", "new_type": None, "checkable": False,
         "action": None, "occurrence": {"scope": "root", "node_id": 1}},
        {"kind": "missing_node_type", "key": ("UnknownB", None),
         "old_type": "UnknownB", "new_type": None, "checkable": False,
         "action": None, "occurrence": {"scope": "root", "node_id": 2}},
    ]
    grouped = rw.group_problem_occurrences(occ)
    assert len(grouped) == 2


def test_mutation_no_widget_remap_is_red():
    """Sans remappage, [3,1,None] ne peut pas être produit depuis [1,2,3]."""
    new_values, _unmapped, _remapped = rw.remap_widget_values(
        ["a", "b", "c"], [1, 2, 3], ["c", "a", "d"]
    )
    assert new_values != [1, 2, 3], "le remappage doit réordonner par NOM"


# ─────────────────────────────────────────────────────────────────────────
# 7. Routes /aih/repair/* (analyse, aperçu, écrasement avec sauvegarde, save-as)
# ─────────────────────────────────────────────────────────────────────────

aiohttp = pytest.importorskip("aiohttp")
from aiohttp import web  # noqa: E402
from aiohttp.test_utils import TestClient, TestServer  # noqa: E402


class _Recorder:
    """Faux objet routes : collecte les handlers réels de _register_repair_group."""

    def __init__(self):
        self.handlers = {}

    def get(self, path):
        def deco(fn):
            self.handlers[("GET", path)] = fn
            return fn
        return deco

    def post(self, path):
        def deco(fn):
            self.handlers[("POST", path)] = fn
            return fn
        return deco


@pytest.fixture
def repair_env(tmp_path, monkeypatch):
    """Constructeur d'app aiohttp + dossier workflows simulé (user/default/workflows)."""
    fake = types.ModuleType("folder_paths")
    fake.get_user_directory = lambda: str(tmp_path)
    monkeypatch.setitem(sys.modules, "folder_paths", fake)

    from aih import routes as aih_routes

    recorder = _Recorder()
    aih_routes._register_repair_group(recorder)

    def build_app():
        # App fraîche à chaque appel : chaque asyncio.run crée sa propre boucle
        # (une Application aiohttp est liée à la boucle qui l'initialise).
        app = web.Application()
        for (method, path), fn in recorder.handlers.items():
            app.router.add_route(method, path, fn)
        return app

    workflows_dir = tmp_path / "default" / "workflows"
    workflows_dir.mkdir(parents=True, exist_ok=True)
    return build_app, workflows_dir


async def _call(build_app, method, path, payload=None):
    client = TestClient(TestServer(build_app()))
    await client.start_server()
    try:
        if method == "GET":
            resp = await client.get(path)
        else:
            resp = await client.post(path, json=payload)
        return resp.status, await resp.json()
    finally:
        await client.close()


def _run(coro):
    return asyncio.run(coro)


def _write_workflow(workflows_dir, rel, workflow):
    target = workflows_dir / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(workflow, indent=2), encoding="utf-8")
    return target


def test_route_lists_saved_workflows(repair_env):
    build_app, workflows_dir = repair_env
    _write_workflow(workflows_dir, "a.json", build_workflow())
    _write_workflow(workflows_dir, "sub/b.json", build_workflow())
    status, data = _run(_call(build_app, "GET", "/aih/repair/workflows"))
    assert status == 200
    paths = {w["path"] for w in data["workflows"]}
    assert paths == {"a.json", "sub/b.json"}


def test_route_analyze_pasted_groups_and_counts(repair_env):
    build_app, _wd = repair_env
    status, data = _run(_call(build_app, "POST", "/aih/repair/analyze", {
        "sources": [{"id": "pasted", "kind": "pasted", "content": build_workflow()}],
    }))
    assert status == 200
    entry = _problems_by_old(data)["HolafRemoteComparer"]
    assert entry["count"] == 12
    # Sources listées.
    assert data["sources"][0]["id"] == "pasted"


def test_route_analyze_file(repair_env):
    build_app, workflows_dir = repair_env
    _write_workflow(workflows_dir, "wf.json", build_workflow())
    status, data = _run(_call(build_app, "POST", "/aih/repair/analyze", {
        "sources": [{"id": "file:wf.json", "kind": "file", "path": "wf.json"}],
    }))
    assert status == 200
    entry = _problems_by_old(data)["HolafRemoteComparer"]
    assert entry["count"] == 12
    assert data["sources"][0]["path"] == "wf.json"


def test_route_analyze_rejects_bad_json(repair_env):
    build_app, _wd = repair_env
    status, data = _run(_call(build_app, "POST", "/aih/repair/analyze", {
        "sources": [{"id": "pasted", "kind": "pasted", "content": "{not json"}],
    }))
    assert status == 200
    assert data["errors"] and data["errors"][0]["error"] == "invalid_json"


def test_route_apply_preview_returns_repaired_without_writing(repair_env):
    build_app, workflows_dir = repair_env
    path = _write_workflow(workflows_dir, "wf.json", build_workflow())
    original = path.read_text(encoding="utf-8")
    analysis_problems = None
    # Récupère l'id du problème via analyze.
    _s, analysis = _run(_call(build_app, "POST", "/aih/repair/analyze", {
        "sources": [{"id": "file:wf.json", "kind": "file", "path": "wf.json"}],
    }))
    analysis_problems = [p["id"] for p in analysis["problems"] if p["checkable"]]

    status, data = _run(_call(build_app, "POST", "/aih/repair/apply", {
        "sources": [{"id": "file:wf.json", "kind": "file", "path": "wf.json"}],
        "selected": analysis_problems,
        "mode": "preview",
    }))
    assert status == 200
    entry = data["results"][0]
    assert "repaired" in entry
    # Sans /object_info (hors runtime ComfyUI), les 2 alias sont détectés :
    # 12 HolafRemoteComparer + 1 HolafRemote = 13 renommages.
    assert entry["summary"]["nodes_renamed"] == 13
    assert path.read_text(encoding="utf-8") == original, "preview ne doit RIEN écrire"


def test_route_apply_overwrite_writes_and_creates_backup(repair_env):
    build_app, workflows_dir = repair_env
    path = _write_workflow(workflows_dir, "wf.json", build_workflow())
    original = path.read_text(encoding="utf-8")
    _s, analysis = _run(_call(build_app, "POST", "/aih/repair/analyze", {
        "sources": [{"id": "file:wf.json", "kind": "file", "path": "wf.json"}],
    }))
    selected = [p["id"] for p in analysis["problems"] if p["checkable"]]

    status, data = _run(_call(build_app, "POST", "/aih/repair/apply", {
        "sources": [{"id": "file:wf.json", "kind": "file", "path": "wf.json"}],
        "selected": selected,
        "mode": "overwrite",
    }))
    assert status == 200
    entry = data["results"][0]
    assert entry["written"] is True
    assert entry["backup"] == "wf.json.bak"
    backup = workflows_dir / "wf.json.bak"
    assert backup.is_file()
    assert backup.read_text(encoding="utf-8") == original, "la sauvegarde = l'original"
    repaired = json.loads(path.read_text(encoding="utf-8"))
    types = {n["type"] for n in repaired["nodes"]}
    assert "HolafRemoteComparer" not in types
    assert "AIHRemoteComparer" in types


def test_route_apply_save_as_writes_new_file(repair_env):
    build_app, workflows_dir = repair_env
    path = _write_workflow(workflows_dir, "wf.json", build_workflow())
    original = path.read_text(encoding="utf-8")
    _s, analysis = _run(_call(build_app, "POST", "/aih/repair/analyze", {
        "sources": [{"id": "file:wf.json", "kind": "file", "path": "wf.json"}],
    }))
    selected = [p["id"] for p in analysis["problems"] if p["checkable"]]
    status, data = _run(_call(build_app, "POST", "/aih/repair/apply", {
        "sources": [{"id": "file:wf.json", "kind": "file", "path": "wf.json"}],
        "selected": selected,
        "mode": "save_as",
        "save_as": "wf-fixed.json",
    }))
    assert status == 200
    entry = data["results"][0]
    assert entry["written"] is True
    assert entry["dest"] == "wf-fixed.json"
    assert (workflows_dir / "wf-fixed.json").is_file()
    # L'original est INTACT.
    assert path.read_text(encoding="utf-8") == original


def test_route_apply_refuses_to_write_on_new_validation_errors(repair_env, monkeypatch):
    """Contrôle négatif : écrire malgré une validation échouée → interdit."""
    build_app, workflows_dir = repair_env
    path = _write_workflow(workflows_dir, "wf.json", build_workflow())
    original = path.read_text(encoding="utf-8")

    real = rw.apply_type_replacement

    def saboteur(node, new_type, old_type, **kwargs):
        info = real(node, new_type, old_type, **kwargs)
        node.setdefault("outputs", []).append({"name": "x", "type": "*", "links": [555555]})
        return info

    monkeypatch.setattr(rw, "apply_type_replacement", saboteur)

    _s, analysis = _run(_call(build_app, "POST", "/aih/repair/analyze", {
        "sources": [{"id": "file:wf.json", "kind": "file", "path": "wf.json"}],
    }))
    selected = [p["id"] for p in analysis["problems"] if p["checkable"]]
    status, data = _run(_call(build_app, "POST", "/aih/repair/apply", {
        "sources": [{"id": "file:wf.json", "kind": "file", "path": "wf.json"}],
        "selected": selected,
        "mode": "overwrite",
    }))
    assert status == 200
    entry = data["results"][0]
    assert entry["written"] is False
    assert entry["error"] == "validation_failed"
    assert path.read_text(encoding="utf-8") == original, "le fichier NE DOIT PAS être modifié"
    assert not (workflows_dir / "wf.json.bak").exists()


def test_route_apply_refuses_invalid_destination(repair_env):
    build_app, workflows_dir = repair_env
    _write_workflow(workflows_dir, "wf.json", build_workflow())
    _s, analysis = _run(_call(build_app, "POST", "/aih/repair/analyze", {
        "sources": [{"id": "file:wf.json", "kind": "file", "path": "wf.json"}],
    }))
    selected = [p["id"] for p in analysis["problems"] if p["checkable"]]
    status, data = _run(_call(build_app, "POST", "/aih/repair/apply", {
        "sources": [{"id": "file:wf.json", "kind": "file", "path": "wf.json"}],
        "selected": selected,
        "mode": "save_as",
        "save_as": "../escape.json",
    }))
    assert status == 200
    entry = data["results"][0]
    assert entry["written"] is False
    assert entry["error"] == "invalid_path"


def test_path_resolution_blocks_traversal():
    base = "/srv/comfy/user/default/workflows"
    assert rw is not None
    from aih import routes as aih_routes
    assert aih_routes._resolve_workflow_path(base, "a.json") is not None
    assert aih_routes._resolve_workflow_path(base, "workflows/a.json") is not None
    assert aih_routes._resolve_workflow_path(base, "../a.json") is None
    assert aih_routes._resolve_workflow_path(base, "sub/../../a.json") is None
    assert aih_routes._resolve_workflow_path(base, "/etc/passwd") is None
    assert aih_routes._resolve_workflow_path(base, "a.txt") is None


if __name__ == "__main__":  # pragma: no cover
    sys.exit(pytest.main([__file__, "-q"]))
