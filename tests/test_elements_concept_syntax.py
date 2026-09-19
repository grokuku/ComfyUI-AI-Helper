"""Non-régression : syntaxe ||concept[:count] de l'Elements Picker.

L'ancien concept inline « ;hint » a été supprimé : le caractère « ; » n'est
plus un séparateur spécial et fait désormais partie intégrante du concept
littéral.  Le hint est porté par le champ dédié de l'élément (voir les tests
de la route backend /api/generate et de ``routes.enhance._resolve_ep_keywords``).
"""

import sys
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent.parent
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))


def _parse(text, default=10):
    from nodes.elements_node import _parse_concept_syntax
    return _parse_concept_syntax(text, default)


class TestParseConceptSyntax:
    def test_concept_only(self):
        assert _parse("||color") == ("color", 10)

    def test_concept_with_count(self):
        assert _parse("||color:20") == ("color", 20)

    def test_default_count_is_used(self):
        assert _parse("||color", 7) == ("color", 7)

    def test_not_a_concept(self):
        assert _parse("hello") is None
        assert _parse("") is None
        assert _parse("||") is None

    def test_semicolon_is_literal(self):
        # Ancien « ;hint » : désormais littéral dans le concept.
        assert _parse("||color;hair") == ("color;hair", 10)
        # Le count reste détecté même après un « ; ».
        assert _parse("||color;hair:20") == ("color;hair", 20)

    def test_returns_two_values(self):
        assert len(_parse("||color:20")) == 2
