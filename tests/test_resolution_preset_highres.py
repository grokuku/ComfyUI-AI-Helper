# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# PLAFOND HAUTE RÉSOLUTION des deux nodes de résolution — tests PURS (sans torch).
#
# Question verrouillée ici : « le node permet-il d'atteindre AU MOINS 32 Mpx ? »
#
# Réponse par node, figée sous forme de test :
#
#   v1 (`AIHResolutionPreset`) → NON. Aucun widget numérique : les dimensions
#      viennent d'une table FERMÉE (`MASTER_RESOLUTIONS`). La plus grande entrée
#      est 2048×2048 = 4 194 304 px (= 4,00 Mpx binaires / 4,19 Mpx décimaux) et
#      AUCUNE des 130 entrées n'atteint 32 Mpx. Passer la v1 à 32 Mpx est une
#      DÉCISION PRODUIT (ajout d'un mode budget/mégapixels), pas un simple
#      plafond de widget : les tests ci-dessous VERROUILLENT le plafond CONSTATÉ
#      pour qu'il ne baisse pas en silence, sans changer le comportement.
#
#   v2 (`AIHResolutionPresetV2`) → OUI, en mode « Megapixels » : le budget est un
#      widget FLOAT dont le `max` doit rester ≥ 32 (il valait 16.00 avant ce
#      chantier → plafond effectif 16 Mpx). En mode table (model_type !=
#      "Megapixels"), c'est la MÊME table que la v1 → même plafond de 4,19 Mpx.
#
# Contrat d'ARRONDI verrouillé ici :
#   * chaque côté reste un MULTIPLE EXACT de `multiple_of` ;
#   * le produit ne DÉPASSE JAMAIS le budget demandé (boucle de rognage) ;
#   * demander 34 MP (marge au-dessus de 32) garantit ≥ 32 Mpx pour TOUS les
#     ratios et TOUS les multiples ; demander PILE 32 MP peut rendre ~31,8-32,0
#     Mpx (l'arrondi au multiple puis le rognage coûtent < 0,7 %) — c'est la
#     raison du plafond à 64 MP et non 32 : il faut de la marge de demande ;
#   * le garde-fou par côté (16384 px) n'est PAS le facteur limitant sous 64 MP.
#
# Contrôles négatifs par mutation : /projects/.aih_tmp/highres_mutate/mutate.py
#   (plafond du widget rabaissé à 16, garde-fou 16384 → 4096, rognage qui
#   descend à 90 % du budget, champ DOM désaligné, plus grande entrée de la table
#   rabaissée).
#
# Usage : PYTHON=/projects/AI-Helper/.venv/bin/python ./run_tests.sh

import re
import sys
import types
from pathlib import Path

import pytest

PACK_DIR = Path(__file__).resolve().parent.parent
NODES_DIR = PACK_DIR / "nodes"
for _path in (PACK_DIR, NODES_DIR):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

# ═══════════════════════ torch : vrai si présent, sinon stub ════════════════
# Ces nodes ne lisent du tensor que `shape`/`ndim`. Un autre fichier de tests du
# pack peut avoir installé un STUB dans sys.modules : on le réutilise alors tel
# quel (deux classes `torch.Tensor` différentes feraient échouer `isinstance`).
try:  # pragma: no cover - dépend de l'environnement
    import torch as _candidate

    _HAS_REAL_TORCH = hasattr(_candidate, "zeros")
    if not _HAS_REAL_TORCH:
        sys.modules["torch"] = _candidate
except ImportError:  # venv de dev : pas de torch du tout
    _HAS_REAL_TORCH = False
    if "torch" not in sys.modules:
        _TORCH = types.ModuleType("torch")

        class _StubTensor:
            """Tenseur factice : seuls `shape` et `ndim` sont lus par les nodes."""

        _TORCH.Tensor = _StubTensor
        sys.modules["torch"] = _TORCH


from nodes import holaf_resolution_preset as V1  # noqa: E402
from nodes import holaf_resolution_preset_v2 as V2  # noqa: E402

MEGAPIXELS = "Megapixels"
# 32 Mpx au sens du node : 1 MP = 1024×1024 px (cf. PIXELS_PER_MP).
MEGAPIXEL_32 = 32 * V2.PIXELS_PER_MP
# Définition « marketing » (1 MP = 10^6 px) : 32 Mpx décimaux.
MEGAPIXEL_32_DECIMAL = 32_000_000


def _resolution(megapixels, multiple, short, orientation):
    return V2.HolafResolutionPresetV2().get_resolution(
        MEGAPIXELS, False, megapixels, multiple, short, orientation, False)


# ═════════════════ 1. Plafond du widget `megapixels` (v2) ═══════════════════

class TestV2MegapixelsCap:
    """Le plafond EFFECTIF de la v2 en mode Megapixels = le `max` du widget."""

    @staticmethod
    def _widget():
        return V2.HolafResolutionPresetV2.INPUT_TYPES()["required"]["megapixels"]

    def test_widget_max_allows_at_least_32_mpx(self):
        """PLAFOND : `max` du widget FLOAT doit rester ≥ 32 (il valait 16.00)."""
        spec = self._widget()
        assert spec[0] == "FLOAT"
        assert spec[1]["max"] >= 32.0, (
            f"plafond megapixels {spec[1]['max']} < 32 : le node ne peut pas "
            "atteindre 32 Mpx")

    def test_widget_max_leaves_room_to_actually_reach_32_mpx(self):
        """`max` STRICTEMENT au-dessus de 32 : demander 32 pile rend ~31,9 Mpx
        (arrondi au multiple + rognage sous le budget), donc un plafond à 32,00
        interdisait de facto d'atteindre 32 Mpx."""
        assert self._widget()[1]["max"] > 32.0

    def test_other_widget_bounds_unchanged(self):
        """Non-régression : défaut/min/pas/arrondi du widget inchangés."""
        bounds = self._widget()[1]
        assert bounds["default"] == 2.50
        assert bounds["min"] == 0.25
        assert bounds["step"] == 0.01
        assert bounds["round"] == 0.01

    def test_dom_field_max_follows_the_backend_max(self):
        """2e plafond possible : le champ DOM (js/holaf_resolution_preset_v2.js).

        Il doit être AU MOINS égal au `max` du backend, sinon l'UI refuse une
        valeur que le node accepte (champ « megapixels » du widget custom).
        """
        source = (PACK_DIR / "js" / "holaf_resolution_preset_v2.js").read_text(
            encoding="utf-8")
        match = re.search(r'megapixelsInput\.max\s*=\s*"([0-9.]+)"', source)
        assert match, "champ DOM `megapixelsInput.max` introuvable"
        assert float(match.group(1)) >= self._widget()[1]["max"]
        assert float(match.group(1)) >= 32.0


# ══════════════ 2. v2 : ≥ 32 Mpx réellement produit et arrondi ══════════════

class TestV2AcceptsAtLeast32Mpx:
    """Demande ≥ 32 Mpx : acceptée, arrondie au multiple, budget respecté."""

    @pytest.mark.parametrize("megapixels,multiple", [
        (34, 8), (34, 16), (34, 32), (34, 64),      # marge minimale au-dessus de 32
        (40, 16), (48, 64), (64, 16),               # marges larges / plafond
    ])
    def test_every_ratio_and_orientation_reaches_32_mpx(self, megapixels, multiple):
        """Tous les ratios × les deux orientations atteignent ≥ 32 Mpx."""
        node = V2.HolafResolutionPresetV2()
        for short in V2.FIVE_RATIOS:
            for orientation in (False, True):
                width, height, label = node.get_resolution(
                    MEGAPIXELS, False, megapixels, multiple, short, orientation, False)
                pixels = width * height
                where = f"{megapixels} MP / multiple {multiple} / {short} / {label}"
                # ≥ 32 Mpx dans l'unité DU NODE (1 MP = 1024×1024)…
                assert pixels >= MEGAPIXEL_32, f"{where} → {width}x{height} < 32 Mpx"
                # …donc a fortiori ≥ 32 Mpx décimaux (33,5 Mpx).
                assert pixels >= MEGAPIXEL_32_DECIMAL, f"{where} → {width}x{height}"
                # Le budget demandé n'est jamais dépassé.
                assert pixels <= megapixels * V2.PIXELS_PER_MP, f"{where} dépasse le budget"
                # L'arrondi ne casse pas le multiple.
                assert width % multiple == 0 and height % multiple == 0, (
                    f"{where} → {width}x{height} n'est pas un multiple de {multiple}")
                # Le garde-fou par côté reste inerte sous 64 MP.
                assert 0 < width < 16384 and 0 < height < 16384
                assert label  # la 3e sortie reste renseignée

    def test_8k_uhd_budget_is_reachable(self):
        """7680×4320 (8K UHD, 33,18 Mpx décimaux) est du même ordre : demander
        33,2 MP en 16:9 le dépasse sans toucher aucun plafond."""
        width, height, label = _resolution(33.2, 16, "9:16", True)
        assert width * height >= MEGAPIXEL_32
        assert label == "16:9 (landscape)"

    @pytest.mark.parametrize("megapixels,multiple,short,orientation,expected", [
        (32, 64, "1:1", False, (5824, 5760)),
        (32, 16, "9:16", True, (7696, 4352)),
        (34, 32, "3:4", False, (5184, 6848)),
        (34, 8, "4:5", False, (5344, 6664)),
        (34, 64, "9:16", True, (7936, 4480)),
        (40, 16, "3:4", False, (5616, 7456)),
        (64, 16, "1:1", False, (8192, 8192)),
    ])
    def test_dimensions_frozen(self, megapixels, multiple, short, orientation, expected):
        """Valeurs FIGÉES : toute retouche d'arrondi/rognage casse ici."""
        width, height, _ = _resolution(megapixels, multiple, short, orientation)
        assert (width, height) == expected


class TestV2RoundingInvariants:
    """Ce que l'arrondi peut (et ne peut pas) faire au budget demandé."""

    @pytest.mark.parametrize("multiple", [8, 16, 32, 64])
    def test_exact_32_request_never_exceeds_the_budget(self, multiple):
        """32 MP pile : jamais au-dessus du budget, jamais loin en dessous.

        Le rognage peut rendre jusqu'à ~0,7 % de moins (31,8 Mpx binaires) : c'est
        une propriété assumée (« rester sous le budget »), PAS une régression —
        et c'est pourquoi demander 34 MP est la façon déterministe d'avoir ≥ 32.
        """
        for short in V2.FIVE_RATIOS:
            for orientation in (False, True):
                width, height, _ = _resolution(32, multiple, short, orientation)
                pixels = width * height
                assert pixels <= MEGAPIXEL_32
                assert pixels >= 0.99 * MEGAPIXEL_32, (
                    f"32 MP / multiple {multiple} / {short} → {width}x{height} "
                    "perd plus de 1 % du budget")

    def test_multiple_64_is_still_exact_and_does_not_skip_below_32_mpx(self):
        """Le multiple le plus grossier (64) est celui qui perd le plus à
        l'arrondi : il ne doit toujours pas faire repasser sous 32 Mpx."""
        for short in V2.FIVE_RATIOS:
            for orientation in (False, True):
                width, height, _ = _resolution(34, 64, short, orientation)
                assert width % 64 == 0 and height % 64 == 0
                assert width * height >= MEGAPIXEL_32

    def test_dimension_guard_16384_is_not_the_limit_below_64_mpx(self):
        """Le garde-fou `min(dim, 16384)` ne bride rien tant qu'on reste ≤ 64 MP :
        le plafond vient du WIDGET, pas de lui."""
        for megapixels in (34, 40, 48, 64):
            for short in V2.FIVE_RATIOS:
                for orientation in (False, True):
                    width, height, _ = _resolution(megapixels, 8, short, orientation)
                    assert max(width, height) < 16384

    def test_below_the_plafond_still_small(self):
        """Non-régression : les petites demandes gardent le comportement d'avant."""
        assert _resolution(1.0, 64, "1:1", False)[:2] == (1024, 1024)
        assert _resolution(0.25, 8, "9:16", True)[:2] == (680, 384)
        assert _resolution(2.5, 16, "9:16", True)[:2] == (2144, 1216)


# ═════════ 3. v1 : plafond FERMÉ (table) — documenté, non modifié ══════════

class TestV1CeilingIsClosed:
    """La v1 n'a AUCUN chemin numérique : son plafond est sa plus grande entrée."""

    def test_v1_has_no_numeric_resolution_input(self):
        """Aucun widget INT/FLOAT : impossible de « demander » 32 Mpx en v1."""
        inputs = V1.HolafResolutionPreset.INPUT_TYPES()
        assert list(inputs["required"]) == [
            "model_type", "aspect_ratio", "use_image_ratio"]
        assert list(inputs["optional"]) == ["image"]
        widget_types = [
            spec[0]
            for spec in (list(inputs["required"].values())
                         + list(inputs["optional"].values()))
            if isinstance(spec, tuple) and spec
        ]
        assert isinstance(widget_types, list)
        assert not any(
            isinstance(kind, str) and kind in {"INT", "FLOAT"}
            for kind in widget_types
        ), f"widget numérique inattendu en v1 : {widget_types}"

    def test_largest_v1_preset_is_2048_square(self):
        """Plafond CONSTATÉ : 2048×2048 = 4 194 304 px (Krea2 Turbo (Quality) et
        Ideogram4 (Quality) en 1:1). Sert de sentinelle : toute entrée plus grande
        ajoutée à la table doit être un CHOIX explicite, pas un effet de bord."""
        largest = max(
            (w * h, w, h)
            for table in V1.MASTER_RESOLUTIONS.values()
            for (w, h) in table.values()
        )
        assert largest == (2048 * 2048, 2048, 2048)
        assert largest[0] == 4_194_304

    def test_no_v1_preset_reaches_32_mpx(self):
        """Réponse honnête et verrouillée : la v1 ne peut PAS produire 32 Mpx."""
        above = [
            (model, key, w * h)
            for model, table in V1.MASTER_RESOLUTIONS.items()
            for key, (w, h) in table.items()
            if w * h >= MEGAPIXEL_32_DECIMAL
        ]
        assert above == []
        assert len(V1.MASTER_RESOLUTIONS) > 0

    @pytest.mark.parametrize("model_type", ["Krea2 Turbo (Quality)", "Ideogram4 (Quality)"])
    def test_top_preset_is_actually_returned(self, model_type):
        """La borne est ATTEIGNABLE (pas seulement théorique) — mutant « entrée
        rabaissée » : rouge ici."""
        assert V1.HolafResolutionPreset().get_resolution(
            model_type, "1:1 Square (Instagram-Medium Format)", False
        ) == (2048, 2048, "1:1 (square)")


class TestV1V2Consistency:
    """Cohérence v1 ↔ v2 en mode TABLE : mêmes entrées, donc même plafond."""

    def test_v2_table_mode_has_the_same_ceiling_as_v1(self):
        """En mode table (model_type != Megapixels), la v2 suit la MÊME table :
        plafond global 2048×2048 → AUCUN modèle n'atteint 32 Mpx par preset."""
        node_v2 = V2.HolafResolutionPresetV2()
        per_model = {}
        for model_option in V2.MODEL_OPTIONS:
            if model_option == MEGAPIXELS:
                continue
            for use_hd in (False, True):
                biggest = max(
                    (lambda wh: wh[0] * wh[1])(
                        node_v2.get_resolution(
                            model_option, use_hd, 2.5, 16, short, orientation, False)[:2])
                    for short in V2.FIVE_RATIOS
                    for orientation in (False, True)
                )
                per_model[(model_option, use_hd)] = biggest
                assert biggest <= 2048 * 2048, (
                    f"{model_option} (hd={use_hd}) → {biggest} px dépasse le plafond v1")
                assert biggest < MEGAPIXEL_32
        # Les variantes HD atteignent EXACTEMENT la borne de la v1 (1:1).
        for model_option in ("Krea2 Turbo", "Ideogram4"):
            assert per_model[(model_option, True)] == 2048 * 2048

    def test_both_nodes_share_the_same_master_table_content(self):
        """La v2 IMPORTE la table de la v1 : contenu identique, y compris les
        modèles (aucun presets « haute résolution » cachés d'un seul côté)."""
        assert V2.MASTER_RESOLUTIONS == V1.MASTER_RESOLUTIONS
        assert V2.ASPECT_RATIOS == V1.ASPECT_RATIOS

    def test_only_v2_exposes_a_high_resolution_path(self):
        """Synthèse : la clé du déplafonnement est le MODE, pas la table —
        seul la v2 a un mode Megapixels (et donc un plafond réglable)."""
        assert "Megapixels" in V2.MODEL_OPTIONS
        assert MEGAPIXELS not in V1.MASTER_RESOLUTIONS
        assert V2.HolafResolutionPresetV2.INPUT_TYPES()["required"]["megapixels"][1]["max"] > 32.0
