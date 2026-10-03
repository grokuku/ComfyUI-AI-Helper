# Copyright (C) 2025 Holaf
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.

"""
HolafSimpleBypasser — Reactive bypasser node.

Unlike AIH Remote (which *initiates* group synchronization), this node is a
*reactive* bypasser: it listens for group state changes pushed by the JS layer
via the ``syncGroupState`` mechanism and never initiates synchronization itself.

The node exposes three widgets on the Python side:

* ``group_name`` — the name of the group this node reacts to.
* ``invert``    — when True, the node's ``active`` state is inverted relative
                  to the group's state (i.e. the node is active when the group
                  is OFF and vice-versa).
* ``active``    — stores the current group state received via sync. This widget
                  is declared here for serialization purposes but is **hidden**
                  on the JS side; its value is driven exclusively by
                  ``syncGroupState``.

The node also accepts an optional ``input`` of any type so it can be wired into
the graph as a pass-through / sink.
"""

# --- Shared-module bootstrap ------------------------------------------------
# Nodes in this pack are loaded one-file-at-a-time by the extension's dynamic
# loader (importlib.util.spec_from_file_location), which registers each file
# under a synthetic "<package>.nodes.<stem>" name WITHOUT importing any parent
# package: package-relative imports therefore cannot work here. Instead we put
# this directory on sys.path and import the shared module absolutely, so every
# node resolves the SAME module instance (one ANY_TYPE singleton pack-wide).
import os as _os
import sys as _sys

_NODE_DIR = _os.path.dirname(_os.path.abspath(__file__))
if _NODE_DIR not in _sys.path:
    _sys.path.insert(0, _NODE_DIR)

from holaf_node_helpers import ANY_TYPE  # noqa: E402  (requires _NODE_DIR above)


class HolafSimpleBypasser:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "group_name": ("STRING", {"default": "Group A"}),
                "invert": ("BOOLEAN", {"default": False, "label_on": "Inverted", "label_off": "Normal"}),
                "active": ("BOOLEAN", {"default": False, "label_on": "ON", "label_off": "OFF"}),
            },
            "optional": {
                "input": (ANY_TYPE,),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "process"
    CATEGORY = "AIH/Flow Control"
    OUTPUT_NODE = True

    def process(self, group_name, invert, active, input=None, **kwargs):
        return {}

# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix).
# Legacy alias keys were removed (user decision): /api/object_info exposes
# one entry PER KEY, so a second alias key made every node appear TWICE in
# the Add Node search. Old workflows referencing the removed keys must be
# redone.
NODE_CLASS_MAPPINGS = {
    "AIHSimpleBypasser": HolafSimpleBypasser,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHSimpleBypasser": "AIH Simple Bypasser",
}
