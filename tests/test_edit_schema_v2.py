# ─────────────────────────────────────────────────────────────────────────
# Tests STANDALONE du schéma v2 des .edt (multi-plages tonales) — ÉTAPE 1.
#
# Couvre :
#   1. Migration v1 → v2 (_migrate_edit_data) : range='all', range='shadows',
#      type spatial avec range (bug latent v1), format plat legacy, masks /
#      crop / clés vidéo inchangés, idempotence, non-mutation de l'entrée.
#   2. NON-RÉGRESSION de rendu : apply_edits_to_image doit produire le MÊME
#      rendu (pixel à pixel) qu'avant la refonte pour les 3 cas de migration.
#      La référence « avant » est une COPIE FIGÉE du code pré-refonte
#      (fonctions extraites verbatim du source d'avant modification,
#      cf. LEGACY_*_SOURCE ci-dessous) exécutée dans un namespace séparé :
#      la preuve ne dépend ni de git ni de l'état futur du dépôt.
#   3. Nouvelle sémantique multi-zones : 2 zones non neutres sur un contrôle
#      ⇒ application restreinte par bande de luminance (les zones neutres ne
#      déclenchent aucune passe).
#   4. Politique vidéo (build_ffmpeg_filter_string) : valeur plate =
#      zones['all'] si non neutre, sinon contrôle ignoré.
#
# logic.py a des imports lourds (folder_paths, imports relatifs du package)
# qui ne se résolvent pas hors de ComfyUI : les fonctions testées sont
# extraites du SOURCE via AST (même harnais que tests/test_crop_standalone.py)
# et exécutées dans un namespace minimal (PIL + numpy).
#
# Usage :
#   python3 tests/test_edit_schema_v2.py
#   pytest tests/test_edit_schema_v2.py
# ─────────────────────────────────────────────────────────────────────────
import ast
import copy
import os

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
LOGIC_PATH = os.path.normpath(os.path.join(HERE, "..", "holaf_image_viewer_backend", "logic.py"))


# ── Extraction AST des fonctions ET constantes de premier niveau ──
def extract_defs(source_path, names):
    with open(source_path, "r", encoding="utf-8") as f:
        src = f.read()
    tree = ast.parse(src)
    found = {}
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in names:
            found[node.name] = ast.get_source_segment(src, node)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in names:
                    found[target.id] = ast.get_source_segment(src, node)
    return found


NEW_NAMES = [
    "_TONAL_TYPES", "_SPATIAL_TYPES", "_ZONE_KEYS", "_TONAL_NEUTRAL",
    "_is_neutral_zone", "_migrate_tonal_control", "_migrate_spatial_control",
    "_migrate_control", "_migrate_edit_data", "_get_luminance_mask",
    "_apply_tonal_zone", "_apply_vignette", "apply_edits_to_image",
    "build_ffmpeg_filter_string",
]

_NEW_NS = None
_LEGACY_NS = None


def new_ns():
    """Namespace du code ACTUEL (extrait de logic.py à l'exécution)."""
    global _NEW_NS
    if _NEW_NS is None:
        defs = extract_defs(LOGIC_PATH, NEW_NAMES)
        missing = [n for n in NEW_NAMES if n not in defs]
        if missing:
            raise RuntimeError(f"Définitions manquantes dans logic.py : {missing}")
        ns = {"Image": Image, "ImageEnhance": ImageEnhance, "ImageFilter": ImageFilter, "np": np}
        for name in NEW_NAMES:
            exec(defs[name], ns)
        _NEW_NS = ns
    return _NEW_NS


def legacy_ns():
    """Namespace du code PRÉ-REFONTE (copies figées LEGACY_*_SOURCE)."""
    global _LEGACY_NS
    if _LEGACY_NS is None:
        ns = {"Image": Image, "ImageEnhance": ImageEnhance, "ImageFilter": ImageFilter, "np": np}
        exec(LEGACY_MIGRATE_SOURCE, ns)    # _migrate_edit_data (v1)
        exec(LEGACY_LUMINANCE_SOURCE, ns)  # _get_luminance_mask (inchangée)
        exec(LEGACY_VIGNETTE_SOURCE, ns)   # _apply_vignette (inchangée)
        exec(LEGACY_APPLY_SOURCE, ns)      # apply_edits_to_image (v1)
        _LEGACY_NS = ns
    return _LEGACY_NS


def migrate(edit_data):
    return new_ns()["_migrate_edit_data"](edit_data)


def apply_new(image, edit_data, mask_images=None):
    return new_ns()["apply_edits_to_image"](image, edit_data, mask_images)


def apply_legacy(image, edit_data, mask_images=None):
    return legacy_ns()["apply_edits_to_image"](image, edit_data, mask_images)


def ffmpeg_new(edit_data):
    return new_ns()["build_ffmpeg_filter_string"](edit_data)


def pixels(img):
    return img.tobytes()


# ── Image de test : dégradé déterministe couvrant toutes les luminances ──
def make_gradient_image(w=48, h=32):
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = ((x * 255) // max(1, w - 1), (y * 255) // max(1, h - 1), (x * 7 + y * 13) % 256)
    return img


# ── Image de test 3 bandes grises : ombres(30) / tons moyens(120) / hautes lumières(220) ──
def make_banded_image(w=32, h=30):
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        v = 30 if y < 10 else (120 if y < 20 else 220)
        for x in range(w):
            px[x, y] = (v, v, v)
    return img


# ═══════════════════════════ 1. MIGRATION v1 → v2 ═══════════════════════════

def test_migration_v1_range_all():
    out = migrate({
        "controls": [{"id": "c_1", "type": "brightness", "value": 1.2, "range": "all"}],
        "crop": {"x": 0, "y": 0, "w": 0.75, "h": 1.0},
    })
    assert out["v"] == 2
    assert out["controls"] == [{"id": "c_1", "type": "brightness", "zones": {"all": 1.2}}]
    assert out["crop"] == {"x": 0, "y": 0, "w": 0.75, "h": 1.0}


def test_migration_v1_range_shadows():
    out = migrate({"controls": [{"id": "c_1", "type": "brightness", "value": 1.5, "range": "shadows"}]})
    assert out["v"] == 2
    ctrl = out["controls"][0]
    assert ctrl == {"id": "c_1", "type": "brightness", "zones": {"shadows": 1.5}}
    # Autres zones = neutres → ABSENTES ; value/range supprimés.
    assert set(ctrl["zones"]) == {"shadows"}
    assert "value" not in ctrl and "range" not in ctrl


def test_migration_v1_spatial_with_range():
    # Bug latent v1 : le front proposait des plages sur les effets spatiaux
    # (jamais appliquées au rendu). Migration : value conservée, range supprimé,
    # le rendu reste global.
    out = migrate({"controls": [{"id": "c_2", "type": "blur", "value": 8, "range": "midtones"}]})
    assert out["v"] == 2
    assert out["controls"] == [{"id": "c_2", "type": "blur", "value": 8}]
    ctrl = out["controls"][0]
    assert "range" not in ctrl and "zones" not in ctrl


def test_migration_masks_crop_video_unchanged():
    payload = {
        "controls": [
            {"id": "m_1", "type": "mask", "value": 12, "file": "edit/base_mask_m_1.png"},
            {"id": "c_1", "type": "brightness", "value": 1.2, "range": "all"},
        ],
        "targetFps": 30,
        "playbackRate": 1.0,
        "interpolate": False,
        "crop": {"x": 0, "y": 0, "w": 0.75, "h": 1.0},
    }
    out = migrate(payload)
    assert out["v"] == 2
    # Mask inchangé (value = feather, file conservé).
    assert out["controls"][0] == {"id": "m_1", "type": "mask", "value": 12, "file": "edit/base_mask_m_1.png"}
    assert out["controls"][1] == {"id": "c_1", "type": "brightness", "zones": {"all": 1.2}}
    assert out["targetFps"] == 30 and out["playbackRate"] == 1.0 and out["interpolate"] is False
    assert out["crop"] == {"x": 0, "y": 0, "w": 0.75, "h": 1.0}


def test_migration_flat_legacy():
    out = migrate({
        "brightness": 1.2,
        "brightnessRange": "shadows",
        "contrast": 1.1,
        "playbackRate": 1.5,
    })
    assert out["v"] == 2
    assert out["controls"] == [
        {"id": "ctrl_1", "type": "brightness", "zones": {"shadows": 1.2}},
        {"id": "ctrl_2", "type": "contrast", "zones": {"all": 1.1}},
    ]
    # Clés plates converties retirées du résultat ; clés vidéo préservées.
    assert "brightness" not in out and "brightnessRange" not in out and "contrast" not in out
    assert out["playbackRate"] == 1.5


def test_migration_idempotent_and_non_destructive():
    payload = {
        "controls": [
            {"id": "c_1", "type": "brightness", "value": 1.2, "range": "all"},
            {"id": "c_2", "type": "brightness", "value": 1.5, "range": "shadows"},
            {"id": "c_3", "type": "blur", "value": 8, "range": "midtones"},
            {"id": "m_1", "type": "mask", "value": 12, "file": "edit/base_mask_m_1.png"},
        ],
        "targetFps": 30,
        "crop": {"x": 0, "y": 0, "w": 0.75, "h": 1.0},
    }
    snapshot = copy.deepcopy(payload)
    once = migrate(payload)
    twice = migrate(once)
    assert twice == once, "la migration doit être idempotente"
    assert payload == snapshot, "la migration ne doit PAS muter l'entrée"
    assert "v" not in payload
    # Un dict déjà v2 passe inchangé (hors copie) : zones font foi.
    v2 = {"v": 2, "controls": [{"id": "c_1", "type": "hue", "zones": {"midtones": 90}}]}
    assert migrate(v2) == {"v": 2, "controls": [{"id": "c_1", "type": "hue", "zones": {"midtones": 90}}]}


# ═════════════════ 2. NON-RÉGRESSION DE RENDU (pixel à pixel) ═════════════════

# Cas v1 bruts (donnés tels quels aux DEUX pipelines : chaque pipeline migre
# en interne à sa façon — l'ancien garde value/range, le nouveau crée zones).
V1_ALL = {"controls": [{"id": "c_1", "type": "brightness", "value": 1.2, "range": "all"}]}
V1_SHADOWS = {"controls": [{"id": "c_1", "type": "brightness", "value": 1.5, "range": "shadows"}]}
V1_SPATIAL_BUG = {"controls": [{"id": "c_2", "type": "blur", "value": 8, "range": "midtones"}]}

NONREG_CASES = [
    ("range_all", V1_ALL),
    ("range_shadows", V1_SHADOWS),
    ("spatial_range_bug", V1_SPATIAL_BUG),
    ("contrast_midtones", {"controls": [{"id": "c_1", "type": "contrast", "value": 1.4, "range": "midtones"}]}),
    ("saturation_highlights", {"controls": [{"id": "c_1", "type": "saturation", "value": 0.2, "range": "highlights"}]}),
    ("hue_all", {"controls": [{"id": "c_1", "type": "hue", "value": 90, "range": "all"}]}),
    ("hue_midtones", {"controls": [{"id": "c_1", "type": "hue", "value": 90, "range": "midtones"}]}),
    ("multi_controls", {"controls": [
        {"id": "c_1", "type": "brightness", "value": 1.15, "range": "all"},
        {"id": "c_2", "type": "blur", "value": 4, "range": "shadows"},
        {"id": "c_3", "type": "sharpen", "value": 1.5, "range": "highlights"},
    ]}),
    ("flat_legacy", {"brightness": 1.5, "brightnessRange": "shadows"}),
    ("crop", {"controls": [{"id": "c_1", "type": "brightness", "value": 1.3, "range": "highlights"}],
              "crop": {"x": 0.1, "y": 0.1, "w": 0.75, "h": 0.8}}),
]


def test_render_nonregression_pixel_identical():
    """Pour chaque cas v1, le rendu APRÈS refonte == rendu AVANT (pixel à pixel)."""
    img = make_gradient_image()
    for label, data in NONREG_CASES:
        out_new = apply_new(img, data)
        out_old = apply_legacy(img, data)
        assert out_new.size == out_old.size, f"[{label}] taille différente : {out_new.size} vs {out_old.size}"
        assert pixels(out_new) == pixels(out_old), f"[{label}] rendu pixel-différent avant/après la refonte"


def test_render_single_zone_migration_equivalence():
    """Un v1 relu (→ 1 zone non neutre) donne exactement le rendu legacy."""
    img = make_banded_image()
    # v1 {value, range} et sa traduction v2 {zones} doivent rendre identiquement.
    for v1, v2 in [
        ({"controls": [{"id": "c_1", "type": "brightness", "value": 1.5, "range": "shadows"}]},
         {"controls": [{"id": "c_1", "type": "brightness", "zones": {"shadows": 1.5}}]}),
        ({"controls": [{"id": "c_1", "type": "brightness", "value": 1.2, "range": "all"}]},
         {"controls": [{"id": "c_1", "type": "brightness", "zones": {"all": 1.2}}]}),
    ]:
        assert pixels(apply_new(img, v1)) == pixels(apply_new(img, v2))
        assert pixels(apply_new(img, v1)) == pixels(apply_legacy(img, v1))


def test_render_sanity_effects_actually_applied():
    """Garde anti-vacuité : les cas de non-régression doivent RÉELLEMENT
    transformer l'image (sinon « identique à l'ancien » ne prouverait rien)."""
    img = make_gradient_image()
    baseline = pixels(img)
    assert pixels(apply_new(img, V1_ALL)) != baseline
    assert pixels(apply_new(img, V1_SHADOWS)) != baseline
    assert pixels(apply_new(img, V1_SPATIAL_BUG)) != baseline
    # La passe shadows restreinte diffère de la passe all globale.
    assert pixels(apply_new(img, V1_SHADOWS)) != pixels(apply_new(img, V1_ALL))
    # ... et reste localisée : le bas du dégradé (hautes lumières) est intact.
    sh = apply_new(img, V1_SHADOWS)
    w, h = img.size
    assert pixels(sh.crop((0, int(h * 0.8), w, h))) == pixels(img.crop((0, int(h * 0.8), w, h)))


def test_render_neutral_zones_are_identity():
    """Les zones neutres (ou absentes) ne déclenchent AUCUNE passe : identité parfaite."""
    img = make_gradient_image()
    out = apply_new(img, {"controls": [
        {"id": "c_1", "type": "brightness", "zones": {"all": 1.0, "shadows": 1.0, "midtones": 1, "highlights": 1}},
        {"id": "c_2", "type": "hue", "zones": {"midtones": 0}},
        {"id": "c_3", "type": "blur", "value": 0},
    ]})
    assert pixels(out) == pixels(img)


# ═════════════════ 3. SÉMANTIQUE MULTI-ZONES (restriction par bande) ═════════════════

def test_render_multi_zone_band_restriction():
    img = make_banded_image()
    both = apply_new(img, {"controls": [{"id": "c_1", "type": "brightness", "zones": {"shadows": 1.8, "highlights": 0.25}}]})
    sh_only = apply_new(img, {"controls": [{"id": "c_1", "type": "brightness", "zones": {"shadows": 1.8}}]})
    hi_only = apply_new(img, {"controls": [{"id": "c_1", "type": "brightness", "zones": {"highlights": 0.25}}]})

    dark_xy, mid_xy, bright_xy = (0, 2), (0, 12), (0, 22)  # lignes ombres/mid/highlights
    dark_in, mid_in, bright_in = img.getpixel(dark_xy), img.getpixel(mid_xy), img.getpixel(bright_xy)
    dark_both, mid_both, bright_both = both.getpixel(dark_xy), both.getpixel(mid_xy), both.getpixel(bright_xy)
    dark_sh, bright_sh = sh_only.getpixel(dark_xy), sh_only.getpixel(bright_xy)
    dark_hi, bright_hi = hi_only.getpixel(dark_xy), hi_only.getpixel(bright_xy)

    # Chaque bande a bien été affectée dans SON sens : ombres éclaircies (1.8),
    # hautes lumières assombries (0.25).
    assert dark_both[0] > dark_in[0], f"ombres non éclaircies : {dark_both} vs {dark_in}"
    assert bright_both[0] < bright_in[0], f"hautes lumières non assombries : {bright_both} vs {bright_in}"
    # La passe highlights (mask=0 sur les ombres) laisse la bande ombres
    # strictement identique à la passe shadows seule — preuve de restriction.
    assert dark_both == dark_sh
    assert bright_both == bright_hi
    # Chaque passe simple ne change QUE sa bande.
    assert dark_hi == dark_in, "highlights seuls ne doit pas toucher les ombres"
    assert bright_sh == bright_in, "shadows seuls ne doit pas toucher les hautes lumières"
    # Un pixel de la bande A diffère d'un pixel de la bande B.
    assert dark_both != bright_both
    # Les tons moyens sont au bord des deux falloffs : quasi inchangés.
    assert abs(mid_both[0] - mid_in[0]) <= 8


def test_render_three_zones_sequential():
    """3 zones non neutres : appliquées séquentiellement sur le résultat courant."""
    img = make_banded_image()
    zones = {"shadows": 2.0, "midtones": 1.5, "highlights": 0.5}
    out = apply_new(img, {"controls": [{"id": "c_1", "type": "brightness", "zones": zones}]})
    dark_out, mid_out, bright_out = out.getpixel((0, 2)), out.getpixel((0, 12)), out.getpixel((0, 22))
    assert dark_out[0] > 30, "ombres éclaircies attendues"
    assert mid_out[0] > 120, "tons moyens éclaircis attendus"
    assert bright_out[0] < 220, "hautes lumières assombries attendues"
    # Le rendu multi-zones diffère de chaque passe simple (les 3 bandes agissent).
    sh_only = apply_new(img, {"controls": [{"id": "c_1", "type": "brightness", "zones": {"shadows": 2.0}}]})
    assert pixels(out) != pixels(sh_only)


# ═════════════════ 4. POLITIQUE VIDÉO (FFmpeg) ═════════════════

def test_video_zones_all_gives_flat_value():
    assert ffmpeg_new({"controls": [{"id": "c_1", "type": "brightness", "zones": {"all": 1.2}}]}) == "eq=brightness=0.100"
    # Équivalent v1 (migré en zones.all) → même valeur plate.
    assert ffmpeg_new({"controls": [{"id": "c_1", "type": "brightness", "value": 1.2, "range": "all"}]}) == "eq=brightness=0.100"
    assert ffmpeg_new({"controls": [{"id": "c_1", "type": "saturation", "zones": {"all": 0.5}}]}) == "eq=saturation=0.5"
    assert ffmpeg_new({"controls": [{"id": "c_1", "type": "hue", "zones": {"all": 90}}]}) == "hue=h=90.0"


def test_video_band_only_control_ignored():
    # Bande seule (pas de all) → contrôle ignoré.
    assert ffmpeg_new({"controls": [{"id": "c_1", "type": "brightness", "zones": {"shadows": 1.5}}]}) == ""
    # all neutre mais bande non neutre → contrôle ignoré.
    assert ffmpeg_new({"controls": [{"id": "c_1", "type": "brightness", "zones": {"all": 1.0, "shadows": 1.5}}]}) == ""
    # v1 équivalent (value sur une bande) → ignoré aussi. (Avant la refonte,
    # cette valeur était appliquée GLOBALEMENT en vidéo : comportement décidé.)
    assert ffmpeg_new({"controls": [{"id": "c_1", "type": "brightness", "value": 1.5, "range": "shadows"}]}) == ""
    # hue all neutre → pas de filtre hue.
    assert ffmpeg_new({"controls": [{"id": "c_1", "type": "hue", "zones": {"all": 0}}]}) == ""


def test_video_spatial_misc_and_masks():
    assert ffmpeg_new({"controls": [{"id": "c_2", "type": "blur", "value": 8}]}) == "gblur=sigma=8.0"
    # Spatial avec range v1 (bug latent) : value globale conservée en vidéo.
    assert ffmpeg_new({"controls": [{"id": "c_2", "type": "blur", "value": 8, "range": "midtones"}]}) == "gblur=sigma=8.0"
    # Les masks ne produisent aucun filtre vidéo.
    mixed = {"controls": [
        {"id": "m_1", "type": "mask", "value": 12, "file": "edit/base_mask_m_1.png"},
        {"id": "c_1", "type": "brightness", "zones": {"all": 1.2}},
    ]}
    assert ffmpeg_new(mixed) == "eq=brightness=0.100"
    # Clés vidéo + crop.
    full = {"controls": [{"id": "c_1", "type": "hue", "zones": {"all": 90}}],
            "playbackRate": 2.0, "targetFps": 30, "interpolate": False,
            "crop": {"x": 0, "y": 0, "w": 0.5, "h": 0.5}}
    assert ffmpeg_new(full) == "setpts=PTS/2.0,hue=h=90.0,crop=w=iw*0.5000:h=ih*0.5000:x=iw*0.0000:y=ih*0.0000"


# ═════════════════ Référence figée : code PRÉ-REFONTE (HEAD avant l'étape 1) ═════════════════
# Copies VERBATIM des fonctions d'avant la refonte, pour la preuve de
# non-régression. NE PAS MODIFIER : elles doivent rester l'image exacte de
# l'ancien comportement (mono-plage value+range).

LEGACY_MIGRATE_SOURCE = '''\
def _migrate_edit_data(edit_data):
    """
    Converts old flat edit format to new controls array format.
    Old format: { 'brightness': 1.2, 'brightnessRange': 'shadows', 'contrast': 1.1 }
    New format: { 'controls': [{ 'id': 'c_1', 'type': 'brightness', 'value': 1.2, 'range': 'shadows' }, ...] }
    """
    if not isinstance(edit_data, dict):
        return edit_data

    if 'controls' in edit_data:
        return edit_data  # Already new format

    # Extract video-specific keys (keep them at top level for ffmpeg pipeline)
    result = {}
    for key in ['playbackRate', 'targetFps', 'interpolate']:
        if key in edit_data:
            result[key] = edit_data[key]

    # Build controls from flat keys
    controls = []
    cid = 0
    for ctype in ['brightness', 'contrast', 'saturation', 'hue']:
        if ctype in edit_data:
            cid += 1
            controls.append({
                'id': f'ctrl_{cid}',
                'type': ctype,
                'value': edit_data[ctype],
                'range': edit_data.get(f'{ctype}Range', 'all')
            })

    if controls:
        result['controls'] = controls
        return result

    return edit_data  # No known keys, return as-is'''

LEGACY_LUMINANCE_SOURCE = '''\
def _get_luminance_mask(image, range_type):
    """
    Creates a smooth luminance mask for the given range type.
    Returns a PIL.Image in 'L' mode (0=transparent, 255=opaque).
    Returns None if range_type is None or 'all' (no masking).
    """
    if not range_type or range_type == 'all':
        return None
    
    gray = image.convert('L')
    
    if range_type == 'shadows':
        # Dark pixels: full effect on luminance < 64, smooth falloff to 127
        table = [min(255, max(0, int(255 * (1 - i / 127)))) if i < 128 else 0 for i in range(256)]
    elif range_type == 'midtones':
        # Medium pixels: smooth rise 64→127, smooth falloff 127→191
        table = []
        for i in range(256):
            if i < 64:
                table.append(0)
            elif i < 127:
                table.append(int(255 * (i - 64) / 63))
            elif i < 192:
                table.append(int(255 * (192 - i) / 65))
            else:
                table.append(0)
    elif range_type == 'highlights':
        # Bright pixels: smooth rise from 127, full effect from 192
        table = [0 if i < 128 else min(255, max(0, int(255 * (i - 128) / 127))) for i in range(256)]
    else:
        return None  # Unknown range, apply to all
    
    return gray.point(table)'''

LEGACY_VIGNETTE_SOURCE = '''\
def _apply_vignette(img, intensity):
    """Assombrit les bords de l'image radialement (intensité 0-1)."""
    if intensity <= 0:
        return img
    alpha = img.getchannel('A') if img.mode in ('RGBA', 'LA') else None
    arr = np.asarray(img.convert('RGB'), dtype=np.float32)
    h, w = arr.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    cx, cy = w / 2, h / 2
    # Distance normalisée (0 au centre → ≥1 aux bords), mise à l'échelle
    d = np.sqrt(((xx - cx) / max(cx, 1)) ** 2 + ((yy - cy) / max(cy, 1)) ** 2)
    # Dégradé doux qui ne démarre qu'après ~55% du rayon
    falloff = np.clip((d - 0.55) / 0.9, 0, 1)
    factor = np.clip(intensity * 0.7 * falloff, 0, 1)[..., None]
    out = arr * (1.0 - factor)
    out_img = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))
    if alpha is not None:
        out_img.putalpha(alpha)
    return out_img'''

LEGACY_APPLY_SOURCE = '''\
def apply_edits_to_image(image, edit_data, mask_images=None):
    """
    Applies adjustments (brightness, contrast, saturation, hue, blur, pixelate,
    vignette, sharpen) to a PIL Image. Supports both old flat format and new
    controls array format.

    ``mask_images`` (optionnel) : dict { file: PIL Image 'L' } des masks
    référencés par les contrôles de type 'mask'. Pour rétro-compatibilité, un
    ancien paramètre ``mask_image`` (image 'L' unique) est aussi accepté et
    converti en dict { file: image }.

    Les masks sont des éléments ORDONNÉS de la pipeline : un contrôle de type
    'mask' change la zone active pour les contrôles suivants. Le traitement se
    fait par SEGMENTS : le résultat d'un segment est composité avec l'entrée du
    segment par le mask du segment (featheré). Un mask suivant REMPLACE la zone
    active pour les segments suivants.
    """
    if not isinstance(edit_data, dict):
        return image

    # Migrate old format to new controls array if needed
    edit_data = _migrate_edit_data(edit_data)

    controls = edit_data.get('controls', [])
    crop = edit_data.get('crop')

    if not controls and not crop:
        return image

    # Rétro-compat : ancien paramètre mask_image (image 'L' unique) → dict
    if mask_images is not None and not isinstance(mask_images, dict):
        mask_images = {'__legacy__': mask_images}

    # Segmente les contrôles aux entrées type=='mask'
    segments = []
    cur = {'mask_ctrl': None, 'controls': []}
    for control in controls:
        if control.get('type') == 'mask':
            if cur['controls'] or cur['mask_ctrl']:
                segments.append(cur)
            cur = {'mask_ctrl': control, 'controls': []}
        else:
            cur['controls'].append(control)
    if cur['controls'] or cur['mask_ctrl']:
        segments.append(cur)

    result = image.copy()

    for seg in segments:
        seg_controls = seg['controls']
        mask_ctrl = seg['mask_ctrl']
        if not seg_controls and not mask_ctrl:
            continue

        # Entrée du segment (avant application des contrôles du segment)
        base = result.copy()

        for control in seg_controls:
            ctype = control.get('type')
            value = control.get('value')
            range_type = control.get('range', 'all')

            if ctype == 'brightness':
                if range_type == 'all':
                    result = ImageEnhance.Brightness(result).enhance(float(value))
                else:
                    mask = _get_luminance_mask(result, range_type)
                    if mask:
                        adjusted = ImageEnhance.Brightness(result.copy()).enhance(float(value))
                        result = Image.composite(adjusted, result, mask)

            elif ctype == 'contrast':
                if range_type == 'all':
                    result = ImageEnhance.Contrast(result).enhance(float(value))
                else:
                    mask = _get_luminance_mask(result, range_type)
                    if mask:
                        adjusted = ImageEnhance.Contrast(result.copy()).enhance(float(value))
                        result = Image.composite(adjusted, result, mask)

            elif ctype == 'saturation':
                if range_type == 'all':
                    result = ImageEnhance.Color(result).enhance(float(value))
                else:
                    mask = _get_luminance_mask(result, range_type)
                    if mask:
                        adjusted = ImageEnhance.Color(result.copy()).enhance(float(value))
                        result = Image.composite(adjusted, result, mask)

            elif ctype == 'hue' and value != 0:
                try:
                    hue_deg = float(value)

                    def _apply_hue(img):
                        img_hsv = img.convert('HSV')
                        h, s, v = img_hsv.split()
                        shift = int((hue_deg % 360) * (255 / 360))
                        h = h.point(lambda i: (i + shift) % 255)
                        return Image.merge('HSV', (h, s, v)).convert('RGB')

                    if range_type == 'all':
                        result = _apply_hue(result)
                    else:
                        mask = _get_luminance_mask(result, range_type)
                        if mask:
                            adjusted = _apply_hue(result.copy())
                            result = Image.composite(adjusted, result, mask)
                except Exception as e:
                    print(f"🟡 [Holaf-Logic] Failed to apply Hue adjustment: {e}")

            elif ctype == 'blur':
                radius = max(0.0, float(value))
                if radius > 0:
                    result = result.filter(ImageFilter.GaussianBlur(radius))

            elif ctype == 'pixelate':
                size = max(2, int(value))
                w, h = result.size
                result = result.resize((max(1, w // size), max(1, h // size)), Image.Resampling.NEAREST)
                result = result.resize((w, h), Image.Resampling.NEAREST)

            elif ctype == 'vignette':
                result = _apply_vignette(result, float(value))

            elif ctype == 'sharpen':
                amount = float(value)
                if amount > 0:
                    result = result.filter(ImageFilter.UnsharpMask(radius=2, percent=round(min(300, amount * 100)), threshold=2))

        # ── Composite avec le mask du segment (featheré) ──
        if mask_ctrl and mask_images:
            try:
                file_ref = mask_ctrl.get('file')
                mask_image = mask_images.get(file_ref) if file_ref else None
                if mask_image is not None:
                    feather = float(mask_ctrl.get('value', 0) or 0)
                    if feather > 0:
                        mask_image = mask_image.filter(ImageFilter.GaussianBlur(feather))
                    if mask_image.size != result.size:
                        mask_image = mask_image.resize(result.size, Image.Resampling.BILINEAR)
                    result = Image.composite(result, base, mask_image)
            except Exception as e:
                print(f"🟡 [Holaf-Logic] Failed to apply edit mask: {e}")

    # Rétro-compat : ancien mask_image unique (sans contrôle 'mask') → appliqué
    # globalement sur le résultat final (comme l'ancien comportement).
    if mask_images is not None and '__legacy__' in mask_images:
        try:
            legacy_mask = mask_images['__legacy__']
            feather = float(((edit_data.get('mask') or {}).get('feather', 0) or 0))
            if feather > 0:
                legacy_mask = legacy_mask.filter(ImageFilter.GaussianBlur(feather))
            if legacy_mask.size != result.size:
                legacy_mask = legacy_mask.resize(result.size, Image.Resampling.BILINEAR)
            result = Image.composite(result, image, legacy_mask)
        except Exception as e:
            print(f"🟡 [Holaf-Logic] Failed to apply legacy edit mask: {e}")

    # ── Crop : recadrage appliqué EN DERNIER (décision de cadrage final) ──
    # Le crop est normalisé 0-1 relatif à l'ORIGINAL. On le convertit en
    # coordonnées pixels et on recadre le RÉSULTAT final (après contrôles et
    # composite mask). Le mask vit sur l'image COMPLÈTE : ajuster le crop ne
    # l'invalide plus.
    if crop:
        try:
            iw, ih = image.size
            x = max(0, min(1, float(crop['x']))) * iw
            y = max(0, min(1, float(crop['y']))) * ih
            w = min(iw - x, max(1, float(crop['w']) * iw))
            h = min(ih - y, max(1, float(crop['h']) * ih))
            result = result.crop((int(x), int(y), int(x + w), int(y + h)))
        except Exception as e:
            print(f"🟡 [Holaf-Logic] Crop failed: {e}")

    return result'''


if __name__ == "__main__":
    tests = sorted((name, fn) for name, fn in globals().items() if name.startswith("test_") and callable(fn))
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"✅ {name}")
        except AssertionError as e:
            failed += 1
            print(f"❌ {name} : {e or 'assertion failed'}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"💥 {name} : {type(e).__name__}: {e}")
    print()
    if failed:
        print(f"❌ {failed}/{len(tests)} tests en échec")
        raise SystemExit(1)
    print(f"🎉 TOUS LES TESTS SCHÉMA V2 PASSENT ({len(tests)}/{len(tests)})")