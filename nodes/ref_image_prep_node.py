# Copyright (C) Holaf — ComfyUI-AI-Helper.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License, version 3 or any later
# version. <https://www.gnu.org/licenses/>

"""
AIH Ref Image Prep Node — Combine jusqu'à 4 images de référence en une
seule image composite (grille dynamique 1×1, 1×2, 2+1 ou 2×2).

Pipeline par image connectée :
  1. Conversion tensor [B,H,W,C] → PIL Image (premier élément du batch)
  2. Auto-crop des bordures uniformes (RGBA via alpha, RGB via couleur de coin)
  3. Détermination de la disposition et des tailles de cellules
  4. Resize « contain » (préserve le ratio, pad avec bg_color)
  5. Labels optionnels (ref1, ref2, …) en haut à gauche
  6. Gap entre cellules (mis à l'échelle pour rester visuel après downscale)
  7. Composite final → downscale Lanczos pour que le plus long côté = target_size
  8. Conversion en tensor [1, H, W, C] float 0-1

Conventions ComfyUI :
  - IMAGE = tensor [B,H,W,C], float 0-1, RGB (3 canaux)
  - Sortie IMAGE = tensor [1, H, W, C], float 0-1
  - CATEGORY = "AIH"
"""

import logging
import math

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

_logger = logging.getLogger(__name__)


# ── Helpers ────────────────────────────────────────────────────────


def _parse_bg_color(hex_str):
    """Convertit une chaîne hex '#RRGGBB' en tuple (R, G, B).

    Valeur par défaut (0,0,0) si le parsing échoue.
    """
    s = (hex_str or "").strip().lstrip("#")
    if len(s) == 6:
        try:
            r = int(s[0:2], 16)
            g = int(s[2:4], 16)
            b = int(s[4:6], 16)
            return (r, g, b)
        except ValueError:
            pass
    # Forme courte #RGB
    if len(s) == 3:
        try:
            r = int(s[0] * 2, 16)
            g = int(s[1] * 2, 16)
            b = int(s[2] * 2, 16)
            return (r, g, b)
        except ValueError:
            pass
    return (0, 0, 0)


def _tensor_to_pil(tensor_item):
    """Convertit un tensor [H,W,C] float 0-1 → PIL Image RGB."""
    if hasattr(tensor_item, "cpu"):
        t = tensor_item.cpu()
    else:
        t = tensor_item
    arr = np.asarray(t)
    # Clamp + uint8
    arr = np.clip(arr * 255.0, 0, 255).astype(np.uint8)
    if arr.ndim == 3 and arr.shape[2] == 4:
        pil = Image.fromarray(arr, mode="RGBA")
    elif arr.ndim == 3 and arr.shape[2] == 3:
        pil = Image.fromarray(arr, mode="RGB")
    elif arr.ndim == 3 and arr.shape[2] == 1:
        pil = Image.fromarray(arr[:, :, 0], mode="L").convert("RGB")
    elif arr.ndim == 2:
        pil = Image.fromarray(arr, mode="L").convert("RGB")
    else:
        # Fallback : prendre les 3 premiers canaux
        pil = Image.fromarray(arr[:, :, :3], mode="RGB")
    return pil


def _auto_crop(pil_img, tolerance=10):
    """Détecte et croppe les bordures uniformes.

    - RGBA : utilise alpha channel getbbox().
    - RGB  : échantillonne les 4 coins, détermine la couleur dominante,
             puis scanne chaque bord jusqu'à trouver un pixel dont au
             moins un canal diffère de plus de `tolerance`.
    """
    if pil_img.mode == "RGBA":
        bbox = pil_img.getbbox()
        if bbox and bbox != (0, 0, pil_img.width, pil_img.height):
            pil_img = pil_img.crop(bbox)
        return pil_img

    # Travailler en RGB pour le scan
    rgb = pil_img.convert("RGB") if pil_img.mode != "RGB" else pil_img
    w, h = rgb.width, rgb.height
    if w == 0 or h == 0:
        return rgb

    px = np.asarray(rgb, dtype=np.int16)  # [H, W, 3]

    # Couleur des 4 coins
    corners = [
        px[0, 0],
        px[0, w - 1],
        px[h - 1, 0],
        px[h - 1, w - 1],
    ]
    # Couleur dominante : moyenne des coins (ils devraient être similaires)
    corner_color = np.median(np.array(corners), axis=0).astype(np.int16)

    def _row_diff(row):
        """True si au moins un pixel de la ligne diffère de corner_color > tolerance."""
        diff = np.abs(row - corner_color)
        return bool(np.any(diff.max(axis=-1) > tolerance))

    # Bordure haute
    top = 0
    while top < h and not _row_diff(px[top, :, :]):
        top += 1
    # Bordure basse
    bottom = h - 1
    while bottom > top and not _row_diff(px[bottom, :, :]):
        bottom -= 1
    # Bordure gauche (sur la zone déjà cropée verticalement)
    left = 0
    while left < w and not _row_diff(px[top:bottom + 1, left, :]):
        left += 1
    # Bordure droite
    right = w - 1
    while right > left and not _row_diff(px[top:bottom + 1, right, :]):
        right -= 1

    # Sécurité : si tout est uniforme, top peut dépasser bottom
    if top >= h or left >= w or top > bottom or left > right:
        # Image entièrement uniforme → garder telle quelle
        return rgb

    # Ajouter 1px de marge si possible (ne pas rogner trop serré)
    top = max(0, top - 1)
    left = max(0, left - 1)
    bottom = min(h - 1, bottom + 1)
    right = min(w - 1, right + 1)

    if top == 0 and left == 0 and bottom == h - 1 and right == w - 1:
        return rgb  # rien à cropper

    return rgb.crop((left, top, right + 1, bottom + 1))


def _resize_to_area(pil_img, target_area):
    """Redimensionne l'image pour qu'elle ait la zone (aire) donnée en pixels,
    en préservant le ratio largeur/hauteur."""
    w, h = pil_img.size
    if w == 0 or h == 0:
        return pil_img
    ratio = w / float(h)
    new_w = max(1, int(round(math.sqrt(target_area * ratio))))
    new_h = max(1, int(round(math.sqrt(target_area / ratio))))
    return pil_img.resize((new_w, new_h), Image.LANCZOS)


def _get_font(size):
    """Retourne une police lisible, taille `size`. Fallback load_default()."""
    size = max(8, size)
    candidates = [
        "arial.ttf",
        "Arial.ttf",
        "DejaVuSans.ttf",
        "LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for name in candidates:
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            continue
    # Fallback : police bitmap par défaut de PIL (taille non contrôlable)
    return ImageFont.load_default()


def _draw_label(pil_img, label):
    """Dessine `label` en haut à gauche sur rectangle semi-transparent noir."""
    if not label:
        return
    draw = ImageDraw.Draw(pil_img, "RGBA")
    font_size = max(10, pil_img.height // 20)
    font = _get_font(font_size)

    # Mesurer le texte (compat PIL anciennes versions)
    try:
        bbox = draw.textbbox((0, 0), label, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        text_origin = bbox[0], bbox[1]
    except AttributeError:
        # Pillow < 8.0
        tw, th = draw.textsize(label, font=font)
        text_origin = (0, 0)

    pad = max(2, font_size // 4)
    rx0 = 2
    ry0 = 2
    rx1 = rx0 + tw + pad * 2
    ry1 = ry0 + th + pad * 2

    # Rectangle semi-transparent
    draw.rectangle([rx0, ry0, rx1, ry1], fill=(0, 0, 0, 160))

    # Texte blanc
    tx = rx0 + pad - text_origin[0]
    ty = ry0 + pad - text_origin[1]
    draw.text((tx, ty), label, fill=(255, 255, 255, 255), font=font)


def _contain_fit(pil_img, cell_w, cell_h, bg_color):
    """Redimensionne `pil_img` pour tenir dans (cell_w, cell_h) en
    préservant le ratio, puis colle centré sur un canvas bg_color.
    """
    canvas = Image.new("RGB", (cell_w, cell_h), bg_color)
    img = pil_img.convert("RGB").copy()
    # thumbnail modifie en place et préserve le ratio
    img.thumbnail((cell_w, cell_h), Image.LANCZOS)
    ox = (cell_w - img.width) // 2
    oy = (cell_h - img.height) // 2
    canvas.paste(img, (ox, oy))
    return canvas


def _pil_to_tensor(pil_img):
    """Convertit une PIL Image RGB → tensor [1, H, W, C] float 0-1."""
    rgb = pil_img.convert("RGB")
    arr = np.asarray(rgb, dtype=np.float32) / 255.0
    # [H, W, C] → [1, H, W, C]
    t = torch.from_numpy(arr).unsqueeze(0)
    return t


# ── Node ───────────────────────────────────────────────────────────


class AIHRefImagePrepNode:
    """Combine jusqu'à 4 images de référence en un seul composite."""

    CATEGORY = "AIH/Media"
    FUNCTION = "composite"
    OUTPUT_NODE = False
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "target_size": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 1}),
                "bg_color": ("STRING", {"default": "#000000"}),
                "show_labels": ("BOOLEAN", {"default": True}),
                "gap": ("INT", {"default": 4, "min": 0, "max": 256, "step": 1}),
            },
            "optional": {
                "image1": ("IMAGE",),
                "image2": ("IMAGE",),
                "image3": ("IMAGE",),
                "image4": ("IMAGE",),
            },
        }

    # ── Méthode principale ──────────────────────────────────────────

    def composite(self, target_size, bg_color, show_labels, gap, image1=None, image2=None, image3=None, image4=None):
        bg = _parse_bg_color(bg_color)

        # Collecter les images connectées (non-None)
        raw_inputs = [image1, image2, image3, image4]
        labels = ["ref1", "ref2", "ref3", "ref4"]

        imgs = []  # liste de PIL Image RGB auto-croppées
        lbls = []
        for idx, raw in enumerate(raw_inputs):
            if raw is None:
                continue
            try:
                # raw = tensor [B,H,W,C]
                if hasattr(raw, "shape") and len(raw.shape) == 4:
                    pil = _tensor_to_pil(raw[0])
                else:
                    pil = _tensor_to_pil(raw)
            except Exception as e:
                _logger.warning(f"[AIH RefImagePrep] Failed to convert image{idx + 1}: {e}")
                continue
            pil = _auto_crop(pil)
            imgs.append(pil)
            lbls.append(labels[idx])

        n = len(imgs)

        # ── Cas : aucune image connectée ─────────────────────────────
        if n == 0:
            _logger.warning("[AIH RefImagePrep] No image connected — returning black 64×64.")
            return {"ui": {"text": ["⚠️ No image connected"]}, "result": (torch.zeros(1, 64, 64, 3),)}

        # ── Equal area : toutes les images ont la même aire (pixel²) ─
        # Cela équilibre le « poids visuel » de chaque image quel que soit
        # son ratio, avant de calculer la disposition en grille.
        if n >= 2:
            target_area = (target_size * target_size) // n
            imgs = [_resize_to_area(img, target_area) for img in imgs]

        # ── Cas : 1 seule image → auto-crop + resize direct ──────────
        if n == 1:
            img = imgs[0].convert("RGB")
            if show_labels and lbls[0]:
                _draw_label(img, lbls[0])
            # Resize pour que le plus long côté = target_size
            w, h = img.size
            scale = target_size / float(max(w, h))
            nw = max(1, int(round(w * scale)))
            nh = max(1, int(round(h * scale)))
            img = img.resize((nw, nh), Image.LANCZOS)
            return {"result": (_pil_to_tensor(img),)}

        # ── Cas : 2+ images → disposition en grille ──────────────────

        # Calculer la disposition (layout) et les dimensions des cellules
        # à l'échelle « naturelle » (sans gap), on rajoutera le gap ensuite.
        layout, composite_w, composite_h, cell_sizes = self._compute_layout(imgs, gap=0)
        # layout = liste de (row, col, rowspan, colspan) pour chaque image
        # cell_sizes = liste de (cell_w, cell_h) pour chaque image

        # Construire chaque cellule (contain fit + label)
        cells = []
        for i, pil in enumerate(imgs):
            cw, ch = cell_sizes[i]
            cell = _contain_fit(pil, cw, ch, bg)
            if show_labels and lbls[i]:
                _draw_label(cell, lbls[i])
            cells.append(cell)

        # Composite sans gap
        composite = Image.new("RGB", (composite_w, composite_h), bg)
        for i, (info, cell) in enumerate(zip(layout, cells)):
            row, col, rspan, cspan, x, y = info
            composite.paste(cell, (x, y))

        # ── Gap : calculer à l'échelle du composite, puis downscale ──
        # On veut que `gap` pixels soient visibles dans l'image finale
        # (de taille target_size). Le composite naturel peut être plus
        # grand, donc on calcule gap_pre = gap / scale_final.
        scale_final = target_size / float(max(composite_w, composite_h))
        gap_pre = int(math.ceil(gap / max(scale_final, 1e-6))) if gap > 0 else 0

        if gap_pre > 0:
            # Reconstruire le composite avec gap_pre
            layout, composite_w, composite_h, cell_sizes = self._compute_layout(imgs, gap=gap_pre)
            cells = []
            for i, pil in enumerate(imgs):
                cw, ch = cell_sizes[i]
                cell = _contain_fit(pil, cw, ch, bg)
                if show_labels and lbls[i]:
                    _draw_label(cell, lbls[i])
                cells.append(cell)
            composite = Image.new("RGB", (composite_w, composite_h), bg)
            for i, (info, cell) in enumerate(zip(layout, cells)):
                row, col, rspan, cspan, x, y = info
                composite.paste(cell, (x, y))
            # scale_final peut avoir légèrement changé → recalculer
            scale_final = target_size / float(max(composite_w, composite_h))

        # ── Downscale final : plus long côté = target_size ───────────
        w, h = composite.size
        longest = max(w, h)
        if longest > target_size:
            scale = target_size / float(longest)
            nw = max(1, int(round(w * scale)))
            nh = max(1, int(round(h * scale)))
            composite = composite.resize((nw, nh), Image.LANCZOS)
        elif longest < target_size:
            # Upscale aussi pour respecter target_size
            scale = target_size / float(longest)
            nw = max(1, int(round(w * scale)))
            nh = max(1, int(round(h * scale)))
            composite = composite.resize((nw, nh), Image.LANCZOS)

        return {"result": (_pil_to_tensor(composite),)}

    # ── Layout ──────────────────────────────────────────────────────

    def _compute_layout(self, imgs, gap=0):
        """Détermine la disposition des images et calcule les positions
        et tailles des cellules.

        Retourne :
          layout      : liste de (row, col, rowspan, colspan, x, y)
          composite_w : largeur totale du composite
          composite_h : hauteur totale du composite
          cell_sizes  : liste de (cell_w, cell_h) par image
        """
        n = len(imgs)
        sizes = [img.size for img in imgs]  # [(w, h), ...]

        if n == 1:
            w, h = sizes[0]
            return (
                [(0, 0, 1, 1, 0, 0)],
                w, h,
                [(w, h)],
            )

        if n == 2:
            # 1×2 horizontal : les deux images ont déjà la même aire
            # (equal-area resizing). On les place côte à côte avec leurs
            # dimensions naturelles ; la hauteur de ligne = max des deux.
            w0, h0 = sizes[0]
            w1, h1 = sizes[1]
            row_h = max(h0, h1)
            total_w = w0 + gap + w1
            composite_w = total_w
            composite_h = row_h
            layout = [
                (0, 0, 1, 1, 0, 0),
                (0, 1, 1, 1, w0 + gap, 0),
            ]
            cell_sizes = [(w0, row_h), (w1, row_h)]
            return layout, composite_w, composite_h, cell_sizes

        if n == 3:
            # 2 en haut + 1 en bas. Les 3 images ont déjà la même aire
            # (equal-area resizing). L'image la plus horizontale (ratio w/h
            # le plus élevé) va en bas. Les dimensions sont adaptatives : on
            # utilise les dimensions naturelles (post-resize) de chaque image
            # et on centre les rangées qui sont plus étroites que le composite.
            ratios = [w / float(h) if h else 0.0 for w, h in sizes]
            bottom_idx = int(np.argmax(ratios))
            top_idxs = [i for i in range(3) if i != bottom_idx]

            bw, bh = sizes[bottom_idx]
            t0w, t0h = sizes[top_idxs[0]]
            t1w, t1h = sizes[top_idxs[1]]

            top_w = t0w + gap + t1w
            composite_w = max(top_w, bw)
            top_h = max(t0h, t1h)
            bottom_h = bh
            composite_h = top_h + gap + bottom_h

            # Centrer la rangée du haut si plus étroite que le composite
            top_start_x = (composite_w - top_w) // 2 if top_w < composite_w else 0
            # Centrer l'image du bas si plus étroite que le composite
            bottom_start_x = (composite_w - bw) // 2 if bw < composite_w else 0

            layout = [None] * 3
            cell_sizes = [None] * 3

            for k, idx in enumerate(top_idxs):
                x = top_start_x + (0 if k == 0 else t0w + gap)
                layout[idx] = (0, k, 1, 1, x, 0)
                cell_sizes[idx] = (t0w if k == 0 else t1w, top_h)

            layout[bottom_idx] = (1, 0, 1, 2, bottom_start_x, top_h + gap)
            cell_sizes[bottom_idx] = (bw, bottom_h)

            return layout, composite_w, composite_h, cell_sizes

        # n == 4 : grille 2×2
        # Lignes : 0 (haut) et 1 (bas). Colonnes : 0 et 1.
        # Ordre : image0 → (0,0), image1 → (0,1), image2 → (1,0), image3 → (1,1)
        w0, h0 = sizes[0]
        w1, h1 = sizes[1]
        w2, h2 = sizes[2]
        w3, h3 = sizes[3]

        # Largeur de colonne = max des largeurs de la colonne
        col0_w = max(w0, w2)
        col1_w = max(w1, w3)
        # Hauteur de ligne = max des hauteurs de la ligne
        row0_h = max(h0, h1)
        row1_h = max(h2, h3)

        composite_w = col0_w + gap + col1_w
        composite_h = row0_h + gap + row1_h

        # Positions x,y de chaque cellule
        positions = [
            (0, 0),                         # (0,0)
            (col0_w + gap, 0),              # (0,1)
            (0, row0_h + gap),              # (1,0)
            (col0_w + gap, row0_h + gap),   # (1,1)
        ]
        cell_sizes = [
            (col0_w, row0_h),
            (col1_w, row0_h),
            (col0_w, row1_h),
            (col1_w, row1_h),
        ]
        layout = []
        grid = [(0, 0), (0, 1), (1, 0), (1, 1)]
        for i in range(4):
            row, col = grid[i]
            x, y = positions[i]
            layout.append((row, col, 1, 1, x, y))

        return layout, composite_w, composite_h, cell_sizes

# === ComfyUI node registration =============================================
# Per-file registry read by the extension's dynamic loader. Canonical key
# follows the AIH naming convention (AIH<PascalCase>, no Node suffix);
# the legacy pre-fusion key ("AIH Ref Image Prep", with spaces) stays as an
# alias pointing to the SAME class so existing workflows keep loading.
# Legacy aliases are never purged.
NODE_CLASS_MAPPINGS = {
    "AIHRefImagePrep": AIHRefImagePrepNode,
    # Legacy alias - never purge.
    "AIH Ref Image Prep": AIHRefImagePrepNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIHRefImagePrep": "AIH Ref Image Prep",
    "AIH Ref Image Prep": "AIH Ref Image Prep",
}
