class HolafRemoteSelector:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                # The user lists their groups here (one per line)
                "group_list": ("STRING", {
                    "multiline": True, 
                    "default": "Group A\nGroup B\nGroup C",
                    "placeholder": "Enter one group name per line"
                }),
                # This field stores the current selection. 
                # The JavaScript will visually transform this text field into a Dropdown.
                "active_group": ("STRING", {"default": "Group A"}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "process"
    CATEGORY = "AIH/Flow Control"
    OUTPUT_NODE = True

    def process(self, group_list, active_group):
        # The control logic (ON/OFF) is handled by the Frontend (JS)
        # which observes the changes of this node.
        return {}

# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix).
# Legacy alias keys were removed (user decision): /api/object_info exposes
# one entry PER KEY, so a second alias key made every node appear TWICE in
# the Add Node search. Old workflows referencing the removed keys must be
# redone.
NODE_CLASS_MAPPINGS = {
    "AIHRemoteSelector": HolafRemoteSelector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHRemoteSelector": "AIH Remote Selector",
}
