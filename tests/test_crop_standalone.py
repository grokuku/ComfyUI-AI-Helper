# ─────────────────────────────────────────────────────────────────────────
# Test fonctionnel BACKEND STANDALONE du CROP.
#
# logic.py a des imports lourds (folder_paths, imports relatifs du package)
# qui ne sont pas résolus hors de ComfyUI. On extrait donc les définitions de
# fonctions ciblées depuis le SOURCE (méthode extract_defs) et on les exécute
# dans un namespace minimal (PIL + numpy) pour tester la pipeline de crop.
#
# Usage :
#   python3 tests/test_crop_standalone.py
# ─────────────────────────────────────────────────────────────────────────
import ast
import os
import sys

from PIL import Image

# ── extract_defs : extrait les définitions de fonctions nommées du source ──
# (ainsi que les constantes de premier niveau, ex. _TONAL_TYPES, dont
# apply_edits_to_image dépend depuis le schéma v2 multi-plages)
def extract_defs(source_path, names):
    with open(source_path, "r", encoding="utf-8") as f:
        src = f.read()
    tree = ast.parse(src)
    defs = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names:
            defs[node.name] = ast.get_source_segment(src, node)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in names:
                    defs[target.id] = ast.get_source_segment(src, node)
    return defs


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    logic_path = os.path.join(here, "..", "holaf_image_viewer_backend", "logic.py")
    logic_path = os.path.normpath(logic_path)

    names = [
        # Constantes du schéma v2 (utilisées par apply_edits_to_image et la migration)
        "_TONAL_TYPES", "_ZONE_KEYS", "_TONAL_NEUTRAL",
        # Migration + helpers de rendu
        "_migrate_edit_data", "_migrate_control", "_migrate_tonal_control",
        "_migrate_spatial_control", "_is_neutral_zone", "_apply_tonal_zone",
        "_get_luminance_mask", "_apply_vignette", "apply_edits_to_image",
    ]
    defs = extract_defs(logic_path, names)
    missing = [n for n in names if n not in defs]
    if missing:
        print(f"❌ Fonctions manquantes dans logic.py : {missing}")
        sys.exit(1)

    # Namespace minimal : PIL + numpy (dépendances de apply_edits_to_image)
    import numpy as np
    from PIL import ImageEnhance, ImageFilter
    ns = {"Image": Image, "ImageEnhance": ImageEnhance, "ImageFilter": ImageFilter, "np": np}
    for name in names:
        exec(defs[name], ns)

    apply_edits_to_image = ns["apply_edits_to_image"]

    # ── Test 1 : crop + effet → le crop est appliqué EN DERNIER ──
    # Image 64×48, crop 0.75×1 (x=0, y=0) → 48×48 attendu (les contrôles
    # s'appliquent sur l'image complète, puis le crop cadre le résultat).
    img = Image.new("RGB", (64, 48), (120, 120, 120))
    edit_data = {
        "crop": {"x": 0, "y": 0, "w": 0.75, "h": 1.0},
        "controls": [{"id": "c_1", "type": "brightness", "value": 1.5, "range": "all"}],
    }
    out = apply_edits_to_image(img, edit_data)
    assert out.size == (48, 48), f"❌ Crop 0.75×1 sur 64×48 → attendu 48×48, obtenu {out.size}"
    print(f"✅ Crop + effet (crop en dernier) : dimensions {out.size} (attendu 48×48)")

    # ── Test 2 : crop seul (pas de contrôles) → retourne l'image croppée ──
    edit_data2 = {"crop": {"x": 0, "y": 0, "w": 0.5, "h": 0.5}}
    out2 = apply_edits_to_image(img, edit_data2)
    assert out2.size == (32, 24), f"❌ Crop seul 0.5×0.5 → attendu 32×24, obtenu {out2.size}"
    print(f"✅ Crop seul (sans contrôles) : dimensions {out2.size} (attendu 32×24)")

    # ── Test 3 : pas de crop → dimensions inchangées ──
    edit_data3 = {"controls": [{"id": "c_1", "type": "contrast", "value": 1.2, "range": "all"}]}
    out3 = apply_edits_to_image(img, edit_data3)
    assert out3.size == (64, 48), f"❌ Sans crop → attendu 64×48, obtenu {out3.size}"
    print(f"✅ Sans crop : dimensions {out3.size} (attendu 64×48)")

    # ── Test 4 : crop + mask legacy → composite sur image PLEINE, PUIS crop ──
    # Le mask vit sur l'image complète : le composite se fait sur l'original
    # 64×48 (pas sur une base croppée), puis le crop cadre le résultat en 48×48.
    # Mask plein blanc → le résultat = brightness 1.5 sur 120 = 180 partout.
    mask = Image.new("L", (64, 48), 255)
    edit_data4 = {
        "crop": {"x": 0, "y": 0, "w": 0.75, "h": 1.0},
        "controls": [{"id": "c_1", "type": "brightness", "value": 1.5, "range": "all"}],
    }
    out4 = apply_edits_to_image(img, edit_data4, mask_images=mask)
    assert out4.size == (48, 48), f"❌ Crop + mask legacy → attendu 48×48, obtenu {out4.size}"
    assert out4.getpixel((0, 0)) == (180, 180, 180), f"❌ Composite mask sur image pleine → attendu (180,180,180), obtenu {out4.getpixel((0, 0))}"
    print(f"✅ Crop + mask legacy (composite image pleine, puis crop) : dimensions {out4.size}, pixel (180,180,180)")

    print("\n🎉 TOUS LES TESTS CROP STANDALONE PASSENT")


if __name__ == "__main__":
    main()
