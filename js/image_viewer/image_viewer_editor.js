/*
 * Copyright (C) 2025 Holaf
 * Holaf Utilities - Image Viewer Editor Module
 *
 * Auto-save: every change is saved immediately (debounced 500ms). No Save/Cancel buttons.
 * Only Reset remains. The saveInProgress flag is the "unsaved changes" guard used by
 * navigation to wait for in-flight saves before switching images.
 */

import "../aih_strings.js";
import { imageViewerState } from './image_viewer_state.js';
import { resetTransform, getFullImageUrl } from './image_viewer_navigation.js';
import { HolafFetch, HolafFetchError } from '../vendor/holaf/holaf-fetch.js';
import { showToast as bridgeShowToast } from '../aih_toast_bridge.js';
import {
    SCHEMA_VERSION,
    ZONE_KEYS,
    ZONE_LABEL_KEYS,
    ZONE_SHORT_LABEL_KEYS,
    ZONE_TINT_CLASS,
    findControlDef,
    neutralZones,
    zonesFromControl,
    zoneValue,
    controlZonePasses,
    hasRangedZones,
    buildCssFilterFromControls,
    normalizeStateV2,
    buildPickerHTML,
    buildPickerItemsHTML,
    buildControlPickerFamilies,
} from './image_viewer_editor_model.js';

// Helper i18n central : traduit via AIH.I18n (clé brute si absente).
const t = (key, params) => {
    const I = window.AIH && window.AIH.I18n;
    return I && typeof I.t === "function" ? I.t(key, params) : key;
};

// Traduit le libellé d'un type de contrôle (brightness → Luminosité/...).
function _controlTypeLabel(id) {
    return t('iv.ctrl' + id.charAt(0).toUpperCase() + id.slice(1));
}

// Catégories + types de contrôles : définis dans le module modèle pur
// (js/image_viewer/image_viewer_editor_model.js) — schéma v2, tests non-DOM.

// Note : les types zonaux portent `zones` (4 bandes) ; les autres `value`.

// ── Méta slider : traduit value ↔ slider et formate l'affichage ─────────────
function _ctrlSliderMeta(def, value) {
    if (def.raw) {
        return {
            sliderVal: value,
            display: def.unit ? `${Math.round(value * 10) / 10}${def.unit}` : String(value),
            fromSlider: (s) => parseFloat(s),
        };
    }
    return {
        sliderVal: value * 100,
        display: def.unit ? `${Math.round(value * 100)}${def.unit}` : String(Math.round(value * 100)),
        fromSlider: (s) => parseFloat(s) / 100,
    };
}

// ── Pickeur V4 master-detail (AIH.Dialog) ────────────────────────────────
// Familles à gauche (catégories + compteur), contrôles à droite (icônes SVG) ;
// un clic sur un contrôle l'ajoute DIRECTEMENT (plus d'étape « plage »).
// Le contrat `data-pick` est conservé.
function _buildPickerFamilies() {
    return buildControlPickerFamilies(_controlTypeLabel, t);
}

function _pickFromList(title, families, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
        const ids = families.map((f) => f.id);
        let activeId = ids.includes(opts.lastFamily) ? opts.lastFamily : ids[0];
        let ctrlRef = null;
        let focusActiveFamily = null;

        const ctrl = AIH.Dialog.open({
            title: title,
            modal: true,
            draggable: true,
            resizable: false,
            width: opts.width || '430px',
            _onResolve: (v) => resolve(v),
            content: (body) => {
                body.innerHTML = buildPickerHTML(families, activeId);
                const familiesEl = body.querySelector('.aih-picker-families');
                const itemsEl = body.querySelector('.aih-picker-controls');
                const familyEls = () => Array.from(familiesEl.querySelectorAll('.aih-picker-family'));
                const itemEls = () => Array.from(itemsEl.querySelectorAll('.aih-picker-item'));

                const renderItems = (fid) => {
                    activeId = fid;
                    const fam = families.find((f) => f.id === fid) || families[0];
                    itemsEl.innerHTML = buildPickerItemsHTML(fam);
                    familyEls().forEach((el) => {
                        const on = el.dataset.family === fid;
                        el.classList.toggle('active', on);
                        el.setAttribute('aria-selected', on ? 'true' : 'false');
                    });
                    if (typeof opts.onFamilyChange === 'function') opts.onFamilyChange(fid);
                };
                const pickItem = (el) => { if (el && ctrlRef) ctrlRef.close(el.dataset.pick); };

                body.addEventListener('click', (e) => {
                    const fam = e.target.closest('.aih-picker-family');
                    if (fam) { renderItems(fam.dataset.family); fam.focus(); return; }
                    const it = e.target.closest('.aih-picker-item');
                    if (it) pickItem(it);
                });

                // Navigation clavier : ↑↓ (familles / contrôles), ←→, ↵, Échap (Dialog).
                body.addEventListener('keydown', (e) => {
                    const fam = e.target.closest('.aih-picker-family');
                    const it = e.target.closest('.aih-picker-item');
                    if (e.key === 'Enter' || e.key === ' ') {
                        if (it) { e.preventDefault(); pickItem(it); return; }
                        if (fam) { e.preventDefault(); renderItems(fam.dataset.family); return; }
                    }
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        const dir = e.key === 'ArrowDown' ? 1 : -1;
                        if (fam) {
                            const list = familyEls();
                            const n = (list.indexOf(fam) + dir + list.length) % list.length;
                            renderItems(list[n].dataset.family);
                            list[n].focus();
                        } else if (it) {
                            const list = itemEls();
                            const n = (list.indexOf(it) + dir + list.length) % list.length;
                            list[n].focus();
                        }
                        return;
                    }
                    if (e.key === 'ArrowRight' && fam) {
                        e.preventDefault();
                        const list = itemEls();
                        if (list[0]) list[0].focus();
                        return;
                    }
                    if (e.key === 'ArrowLeft' && it) {
                        e.preventDefault();
                        const active = familyEls().find((el) => el.dataset.family === activeId);
                        if (active) active.focus();
                    }
                });

                focusActiveFamily = () => {
                    const f = familyEls().find((el) => el.dataset.family === activeId) || familyEls()[0];
                    if (f) f.focus();
                };
            },
            buttons: [{ text: t('iv.cancel'), value: null, type: 'cancel' }],
        });
        ctrlRef = ctrl;
        // Le focus est posé APRÈS insertion dans le document (open() rend le
        // contenu avant que `el` ne soit attaché à <body>).
        if (focusActiveFamily) focusActiveFamily();
    });
}

const DEFAULT_EDIT_STATE = () => ({
    v: SCHEMA_VERSION,
    controls: [],
    targetFps: null,
    playbackRate: 1.0,
    interpolate: false,
    crop: null
});

// ── Rendu des lignes de contrôle (zonaux / non zonaux) ─────────────────────

// Pastille compacte d'une bande (ligne repliée) : teinte + valeur.
function _zonePillHtml(zone, value, def) {
    const meta = _ctrlSliderMeta(def, value);
    const label = t(ZONE_LABEL_KEYS[zone]);
    return `<span class="holaf-editor-zone-pill" data-zone="${zone}" title="${label} : ${meta.display}">`
        + `<span class="holaf-editor-zone-dot ${ZONE_TINT_CLASS[zone]}"></span>${meta.display}</span>`;
}

// Ligne slider d'une bande (ligne dépliée). `data-zone` porte la cible du reset.
// La colonne étroite (58px) affiche le libellé COURT ; la forme LONGUE est
// conservée dans le `title` (tooltip) — et reste utilisée par les pastilles.
function _zoneRowHtml(ctrl, def, zone) {
    const value = zoneValue(zonesFromControl(ctrl), ctrl.type, zone);
    const meta = _ctrlSliderMeta(def, value);
    const label = t(ZONE_LABEL_KEYS[zone]);
    const shortLabel = t(ZONE_SHORT_LABEL_KEYS[zone]);
    return `<div class="holaf-editor-zone-row" data-zone="${zone}">`
        + `<span class="holaf-editor-zone-label" title="${label}">${shortLabel}</span>`
        + `<span class="holaf-editor-zone-dot ${ZONE_TINT_CLASS[zone]}"></span>`
        + `<input type="range" data-zone="${zone}" min="${def.min}" max="${def.max}" step="${def.step}" value="${meta.sliderVal}">`
        + `<span class="holaf-editor-slider-value">${meta.display}</span>`
        + '</div>';
}

let _ctrlIdCounter = 0;
let _maskIdCounter = 0;

export class ImageEditor {
    constructor(viewer) {
        this.viewer = viewer;
        this.panelEl = null;
        this.activeImage = null;
        this.currentState = DEFAULT_EDIT_STATE();
        this.saveInProgress = false;
        this.nativeFps = 0;
        this.processedVideoUrl = null;
        // État UI de la liste : contrôle déplié + visibilité de l'overlay mask
        this._expandedCtrlId = null;
        this._maskHidden = false;
        // Masks multiples : map id→canvas full-res + id du mask dont l'overlay est affiché
        this._maskCanvases = {};
        this._activeOverlayMaskId = null;
        this._lastToggledCtrlId = null; // mémo pour le dblclick reset après re-render
        this._lastToggledAt = 0;
        this._lastPickerFamily = null; // dernière famille du picker (mémorisée)
    }

    init() {
        this.createPanel();
        imageViewerState.subscribe(this._handleStateChange.bind(this));
    }

    hasUnsavedChanges() { return this.saveInProgress; }

    _showToast(message, type = 'info', duration = 3000) {
        return bridgeShowToast({ message, type, duration });
    }

    _handleStateChange(state) {
        if (!this.panelEl) { this.createPanel(); if (!this.panelEl) return; }
        const visible = state.activeImage && state.ui.view_mode === 'zoom';
        const shown = this.panelEl.style.display !== 'none';
        if (state.activeImage && state.activeImage.path_canon !== this.activeImage?.path_canon)
            this._show(state.activeImage);
        else if (!state.activeImage && this.activeImage)
            this._hide();
        this.panelEl.style.display = visible ? 'block' : 'none';
        if (!visible && shown && this.activeImage) this._hide();
    }

    createPanel() {
        if (this.panelEl) return;
        const col = this.viewer?.elements?.rightColumn || document.getElementById('holaf-viewer-right-column');
        if (!col) return;
        const el = document.createElement('div');
        el.id = 'holaf-viewer-editor-pane';
        el.style.display = 'none';
        el.innerHTML = `
            <h4>${t('iv.editorTitle')}</h4>
            <div id="holaf-editor-content">
                <div id="holaf-editor-controls-list"></div>
                <div style="padding: 4px 0 8px 0;">
                    <button id="holaf-editor-add-btn" class="comfy-button" style="width:100%;font-size:12px;padding:6px;">${t('iv.addControl')}</button>
                </div>
                <div id="holaf-editor-video-section" style="display:none;border-top:1px solid var(--holaf-border-color);padding-top:8px;margin-top:4px;">
                    <style>
                        #holaf-editor-fps-input::-webkit-inner-spin-button,
                        #holaf-editor-fps-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
                        #holaf-editor-fps-input { -moz-appearance: textfield; }
                    </style>
                    <div class="holaf-editor-slider-container">
                        <label for="holaf-editor-fps-slider">${t('iv.fps')}</label>
                        <input type="range" id="holaf-editor-fps-slider" min="1" max="144" step="1" style="flex-grow:1;margin:0 8px;">
                        <input type="number" id="holaf-editor-fps-input" min="1" max="144" step="1"
                               style="width:40px;background:var(--comfy-input-bg);color:var(--comfy-input-text);border:1px solid var(--border-color);border-radius:4px;padding:2px;text-align:center;">
                    </div>
                    <div class="holaf-editor-slider-container" style="justify-content:flex-start;margin-top:6px;">
                        <input type="checkbox" id="holaf-editor-interpolate-check" style="margin-right:8px;">
                        <label for="holaf-editor-interpolate-check" style="cursor:pointer;opacity:0.8;" title="${t('iv.aiInterpolation')}">${t('iv.aiInterpolation')}</label>
                    </div>
                </div>
                <div class="holaf-editor-footer">
                    <label style="display:flex;align-items:center;gap:4px;margin-right:auto;cursor:pointer;font-size:12px;opacity:0.8;" title="${t('iv.compareTitle')}">
                        <input type="checkbox" id="holaf-editor-compare-check" style="cursor:pointer;"> ${t('iv.compare')}
                    </label>
                    <button id="holaf-editor-reset-btn" class="comfy-button">${t('iv.reset')}</button>
                </div>
            </div>`;
        col.appendChild(el);
        this.panelEl = el;
        this._attachListeners();
    }

    async _show(image) {
        if (!this.panelEl) return;
        // Cancel any pending auto-save and invalidate stale save tokens
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        this._saveToken = (this._saveToken || 0) + 1; // Invalidate stale saves
        this.activeImage = image;
        this.nativeFps = 0;
        this.processedVideoUrl = null;
        this._clearCanvasCache();
        this._compareCleanup();
        // Use DEFAULT_EDIT_STATE() (function call = fresh deep copy) to prevent
        // shared reference mutation between different images
        this.currentState = DEFAULT_EDIT_STATE();
        // Nouvelle image → UI de liste fraîche : tout replié, overlay mask visible
        this._expandedCtrlId = null;
        this._maskHidden = false;
        this._maskCanvases = {};
        this._activeOverlayMaskId = null;
        this._updateUIFromState();
        this.applyPreview();
        await this._loadEditsForCurrentImage();
    }

    _hide() {
        // Détache les overlays du viewport (followers) avant de les retirer.
        const maskOv = document.getElementById('holaf-mask-overlay');
        if (maskOv) this._removeOverlayWrapper(maskOv);
        const cropOv = document.getElementById('holaf-crop-overlay');
        if (cropOv) this._removeOverlayWrapper(cropOv);
        if (this.panelEl) this.panelEl.style.display = 'none';
        this._dispatchVideoOverride(null);
        this._getPreviewElements().forEach(el => { if (el) el.style.filter = 'none'; });
        this._compareCleanup();
        this._clearCanvasCache();
        // Nettoyage mask (overlay + toolbar)
        const ov = document.getElementById('holaf-mask-overlay');
        if (ov) ov.remove();
        if (this._maskBar) { this._maskBar.remove(); this._maskBar = null; }
        this._maskOverlay = null;
        this._maskCanvases = {};
        this._activeOverlayMaskId = null;
        // Nettoyage crop (overlay + toolbar)
        const cov = document.getElementById('holaf-crop-overlay');
        if (cov) cov.remove();
        if (this._cropBar) { this._cropBar.remove(); this._cropBar = null; }
        this._cropOverlay = null;
        this._cropRect = null;
        this._cropStart = null;
        this._cropDrawing = false;
        this._cropPrev = null;
        this.activeImage = null;
    }

    _clearCanvasCache() {
        if (this._previewBlobUrl) { URL.revokeObjectURL(this._previewBlobUrl); this._previewBlobUrl = null; }
        this._originalImgSrc = null; this._originalImgData = null; this._previewCanvas = null;
    }

    _dispatchVideoOverride(url) {
        document.dispatchEvent(new CustomEvent('holaf-video-override', { detail: { url } }));
    }

    _updateGlobalImageState(path, hasEdits) {
        const s = imageViewerState.getState();
        const images = s.images.map(i => i.path_canon === path ? { ...i, has_edit_file: hasEdits } : i);
        let active = s.activeImage;
        if (active && active.path_canon === path) active = { ...active, has_edit_file: hasEdits };
        imageViewerState.setState({ images, activeImage: active });
    }

    async _loadEditsForCurrentImage() {
        if (!this.activeImage) return;
        try {
            // La brique lève sur non-2xx → catch identique (échec silencieux
            // loggé, préview/UI réinitialisées) ; plus de test r.ok.
            const d = await HolafFetch.get(`/holaf/images/load-edits?path_canon=${encodeURIComponent(this.activeImage.path_canon)}`);
            if (d.native_fps) this.nativeFps = Number(d.native_fps);
            if (d.processed_video_url) { this.processedVideoUrl = d.processed_video_url; this._dispatchVideoOverride(this.processedVideoUrl); }
            else this._dispatchVideoOverride(null);
            if (d.status === 'ok') {
                // Migration v1 → v2 à la LECTURE (le front recharge des .edt v1) :
                // idempotente, « v » absent = v1. Chaque contrôle est copié (pas
                // de partage de référence) et les champs inconnus sont conservés.
                this.currentState = normalizeStateV2({ ...DEFAULT_EDIT_STATE(), ...d.edits });
                this._syncIdCounters();
            }
            // ── Masks multiples : charger le PNG de CHAQUE contrôle type 'mask' ──
            this._maskCanvases = {};
            this._activeOverlayMaskId = null;
            const maskControls = (this.currentState.controls || []).filter(c => c.type === 'mask');
            if (maskControls.length) {
                let loaded = 0;
                maskControls.forEach((c) => {
                    if (!c.mask_base64) { loaded++; return; }
                    const img = new Image();
                    img.onload = () => {
                        const cv = document.createElement('canvas');
                        cv.width = img.naturalWidth;
                        cv.height = img.naturalHeight;
                        cv.getContext('2d').drawImage(img, 0, 0);
                        this._maskCanvases[c.id] = cv;
                        // Affiche l'overlay du dernier mask actif
                        this._activeOverlayMaskId = c.id;
                        if (!this._maskHidden) this._showMaskOverlay(c.id);
                        this.applyPreview();
                    };
                    img.onerror = () => { loaded++; if (loaded === maskControls.length) this.applyPreview(); };
                    img.src = c.mask_base64;
                });
            } else {
                const ov = document.getElementById('holaf-mask-overlay');
                if (ov) ov.remove();
            }
            if (this.nativeFps > 0 && this.currentState.targetFps == null)
                this.currentState.targetFps = Math.round(this.nativeFps * (this.currentState.playbackRate || 1.0));
        } catch (e) { console.error("[Holaf Editor] load edits:", e); }
        this._updateUIFromState();
        this.applyPreview();
    }

    // ── Auto-save (debounced) ──

    _scheduleAutoSave() {
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveToken = (this._saveToken || 0) + 1;
        const token = this._saveToken;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this._doAutoSave(token);
        }, 500);
    }

    async _doAutoSave(token) {
        if (!this.activeImage || token !== this._saveToken) return;
        if (this.saveInProgress) {
            this._scheduleAutoSave();
            return;
        }
        this.saveInProgress = true;
        const path = this.activeImage.path_canon;

        if (this.nativeFps > 0 && this.currentState.targetFps)
            this.currentState.playbackRate = this.currentState.targetFps / this.nativeFps;

        try {
            // ── Masks multiples : inclure les PNG (data URL) dans mask_layers ──
            const maskLayers = {};
            for (const c of this.currentState.controls || []) {
                if (c.type === 'mask' && this._maskCanvases[c.id]) {
                    maskLayers[c.id] = this._maskCanvases[c.id].toDataURL('image/png');
                }
            }
            // Ne pas muter currentState.controls avec les base64 : on les met dans
            // une structure séparée payload.mask_layers. On retire aussi les
            // mask_base64 injectés au load (le serveur les re-injecte au prochain load).
            // normalizeStateV2 pose `v: 2` et migre tout contrôle resté en v1.
            const normalized = normalizeStateV2(this.currentState);
            const editsPayload = {
                ...normalized,
                controls: (normalized.controls || []).map(c => {
                    const { mask_base64, ...rest } = c;
                    return rest;
                }),
            };
            const payload = { path_canon: path, edits: editsPayload, mask_layers: maskLayers };
            // La brique lève sur non-2xx → catch : auto-save raté (warning
            // console, réessayé au prochain changement), comme avant.
            await HolafFetch.post('/holaf/images/save-edits', { body: payload });
            this._updateGlobalImageState(path, true);
            if (this.viewer?.gallery) this.viewer.gallery.refreshThumbnail(path);
            if (this.nativeFps > 0) {
                const needs = this.currentState.interpolate || (this.currentState.targetFps && this.currentState.targetFps !== this.nativeFps);
                if (needs && this.activeImage?.path_canon === path) {
                    this._triggerProcessVideoBackground(path);
                }
            }
        } catch (e) {
            console.warn("[Holaf Editor] Auto-save failed:", e);
        } finally {
            this.saveInProgress = false;
            // Do NOT reschedule here — the slider/control handlers already call
            // _scheduleAutoSave() on new input events. Rescheduling here can fire
            // after the active image has changed, overwriting the new image with
            // the previous image's edits.
        }
    }

    // ── Preview ──

    applyPreview() {
        const els = this._getPreviewElements();
        let rate = 1.0;
        if (this.nativeFps > 0 && this.currentState.targetFps > 0) rate = this.currentState.targetFps / this.nativeFps;
        else rate = this.currentState.playbackRate || 1.0;
        if (this.processedVideoUrl) rate = 1.0;

        // Préview canvas : rangés OU effets spatiaux (blur/pixelate/vignette/
        // sharpen) OU mask — sinon CSS filters (rapide).
        if (this._hasRangedAdjustments() || this._requiresCanvasPreview()) {
            this._processRangedPreviewOnCanvas(els);
        } else {
            this._applyCssFilter(els, rate);
        }
        this._showCropOverlay();
        this._compareRefresh();
    }

    _schedulePreview() {
        if (this._previewTimer) clearTimeout(this._previewTimer);
        this._previewTimer = setTimeout(() => { this._previewTimer = null; this.applyPreview(); }, 16);
    }

    _compareRefresh() {
        const canvas = document.getElementById('holaf-compare-canvas');
        if (!canvas) return;
        this._compareFilterDirty = true;
    }

    _applyCssFilter(els, rate) {
        if (this._previewBlobUrl) {
            URL.revokeObjectURL(this._previewBlobUrl); this._previewBlobUrl = null;
            this._originalImgSrc = null; this._originalImgData = null;
            els.forEach(el => { if (el && el.dataset.originalSrc) { el.src = el.dataset.originalSrc; delete el.dataset.originalSrc; } });
        }
        const f = this._buildCssFilter();
        els.forEach(el => { if (el) { el.style.filter = f; if (el.tagName === 'VIDEO') el.playbackRate = rate; } });
    }

    _buildCssFilter() {
        // Fast-path CSS : ne reflète que la bande « all » de chaque contrôle
        // zonaux. Utilisé uniquement quand `_hasRangedAdjustments()` est faux
        // (ou en repli d'erreur) — sinon le rendu canvas prend le relais.
        return buildCssFilterFromControls(this.currentState.controls);
    }

    _hasRangedAdjustments() {
        // Vrai si un contrôle zonaux a une bande ≠ « all » non neutre. Les
        // edits migrés v1 (uniquement « all ») restent donc sur le fast-path CSS.
        if (this.nativeFps > 0) return false;
        return hasRangedZones(this.currentState.controls);
    }

    // Effets qui ne peuvent pas passer par les CSS filters (spatiaux) ou mask,
    // ou un crop (recadrage) qui ne peut pas être rendu par les CSS filters.
    _requiresCanvasPreview() {
        if (this.nativeFps > 0) return false;
        const spatial = ['blur', 'pixelate', 'vignette', 'sharpen'];
        return (this.currentState.controls || []).some(c => spatial.includes(c.type) || c.type === 'mask');
    }

    async _processRangedPreviewOnCanvas(els) {
        const imgEl = els.find(e => e && e.tagName === 'IMG' && (e.dataset.originalSrc || e.src)) || els[0];
        if (!imgEl || imgEl.tagName !== 'IMG') return;
        const originalUrl = imgEl.dataset.originalSrc || imgEl.src;
        if (!originalUrl) return;
        try {
            if (!this._originalImgData || this._originalImgSrc !== originalUrl) {
                this._originalImgSrc = originalUrl;
                const loadImg = new Image();
                loadImg.crossOrigin = 'anonymous';
                await new Promise((res, rej) => { loadImg.onload = res; loadImg.onerror = rej; loadImg.src = originalUrl; });
                const natW = loadImg.naturalWidth, natH = loadImg.naturalHeight;
                // MAX_PREVIEW_DIM s'applique aux dims de l'image COMPLÈTE (le
                // crop est désormais affichage-only côté client, appliqué en
                // dernier par le serveur).
                const MAX_PREVIEW_DIM = 1920;
                let pw = natW, ph = natH;
                if (pw > MAX_PREVIEW_DIM || ph > MAX_PREVIEW_DIM) {
                    const scale = MAX_PREVIEW_DIM / Math.max(pw, ph);
                    pw = Math.round(pw * scale);
                    ph = Math.round(ph * scale);
                }
                this._previewCanvas = document.createElement('canvas');
                this._previewCanvas.width = pw;
                this._previewCanvas.height = ph;
                this._previewCanvas.getContext('2d').drawImage(loadImg, 0, 0, pw, ph);
                this._originalImgData = this._previewCanvas.getContext('2d').getImageData(0, 0, pw, ph);
            }
            const w = this._previewCanvas.width, h = this._previewCanvas.height;
            const controls = this.currentState.controls || [];

            // ── Segmentation : découpe aux entrées type=='mask' ─────────────
            const segments = [];
            let cur = { maskCtrl: null, controls: [] };
            for (const c of controls) {
                if (c.type === 'mask') {
                    if (cur.controls.length || cur.maskCtrl) segments.push(cur);
                    cur = { maskCtrl: c, controls: [] };
                } else {
                    cur.controls.push(c);
                }
            }
            if (cur.controls.length || cur.maskCtrl) segments.push(cur);

            // Le résultat démarre TOUJOURS sur l'ORIGINAL : _previewCanvas est
            // écrasé par le rendu précédent en fin de fonction (il sert de
            // source au blob de préview). Cloner _previewCanvas accumulait les
            // passes à CHAQUE re-rendu (drag d'un slider) : un vignettage ne
            // faisait que s'assombrir et une zone tonale écrasée au minimum ne
            // remontait jamais (0 × facteur = 0). _originalImgData, capturé au
            // chargement, est la seule base valide → rendu idempotent (deux
            // rendus du même état = mêmes pixels).
            const resultCanvas = document.createElement('canvas');
            resultCanvas.width = w;
            resultCanvas.height = h;
            resultCanvas.getContext('2d').putImageData(this._originalImgData, 0, 0);
            const rctx = resultCanvas.getContext('2d');

            for (const seg of segments) {
                if (!seg.controls.length && !seg.maskCtrl) continue;
                const baseCanvas = this._cloneCanvas(resultCanvas);
                // Contrôles par pixel (brightness/contrast/saturation/hue + ranges)
                const srcData = rctx.getImageData(0, 0, w, h);
                rctx.putImageData(this._applyPixelControls(srcData, w, h, seg.controls), 0, 0);
                // Effets spatiaux (pixelate/blur/vignette/sharpen)
                this._applySpatialEffects(resultCanvas, seg.controls);
                // Composite avec le mask du segment (featheré)
                if (seg.maskCtrl) {
                    const maskCanvas = this._maskCanvases[seg.maskCtrl.id];
                    if (maskCanvas) {
                        this._compositeWithMask(resultCanvas, baseCanvas, maskCanvas, seg.maskCtrl.value || 0);
                    }
                }
            }

            // Copie le résultat dans _previewCanvas pour la génération du blob
            this._previewCanvas.getContext('2d').clearRect(0, 0, w, h);
            this._previewCanvas.getContext('2d').drawImage(resultCanvas, 0, 0);

            const blob = await new Promise(r => this._previewCanvas.toBlob(r, 'image/jpeg', 0.92));
            if (!blob) return;
            if (this._previewBlobUrl) URL.revokeObjectURL(this._previewBlobUrl);
            this._previewBlobUrl = URL.createObjectURL(blob);
            els.forEach(el => { if (el && el.tagName === 'IMG') { if (!el.dataset.originalSrc) el.dataset.originalSrc = el.src; el.style.filter = 'none'; el.src = this._previewBlobUrl; } });
        } catch (e) {
            console.warn('[Holaf Editor] Ranged preview fallback:', e);
            this._applyCssFilter(els, 1.0);
        }
    }

    // Applique les contrôles par pixel (brightness/contrast/saturation/hue) à un
    // ImageData source, en respectant les bandes de luminance du schéma v2.
    // Les bandes NON NEUTRES d'un contrôle sont appliquées SÉQUENTIELLEMENT
    // (ordre all → shadows → midtones → highlights), chacune restreinte à sa
    // bande de luminance ('all' = partout) et compositée sur le RÉSULTAT
    // COURANT — même sémantique que le rendu serveur. Le poids par pixel vient
    // des mêmes profils que _luminanceWeight ; une bande neutre = aucune passe.
    _applyPixelControls(srcData, w, h, controls) {
        const data = srcData.data;
        const dst = new Uint8ClampedArray(data.length);
        const len = data.length;

        // Pré-calcul (hors boucle pixel) des passes non neutres, dans l'ordre.
        const passesList = [];
        for (const ctrl of controls) {
            const passes = controlZonePasses(ctrl);
            if (passes.length) passesList.push({ type: ctrl.type, passes });
        }

        for (let i = 0; i < len; i += 4) {
            let r = data[i], g = data[i + 1], b = data[i + 2];
            const a0 = data[i + 3];

            for (let ci = 0; ci < passesList.length; ci++) {
                const type = passesList[ci].type;
                const passes = passesList[ci].passes;
                for (let pi = 0; pi < passes.length; pi++) {
                    const val = passes[pi].value;
                    const zone = passes[pi].zone;
                    // Poids de la bande, calculé sur le pixel COURANT.
                    const weight = zone === 'all' ? 1 : this._luminanceWeight(0.299 * r + 0.587 * g + 0.114 * b, zone);
                    if (weight <= 0) continue;
                    let nr = r, ng = g, nb = b;
                    if (type === 'brightness') { nr = r * val; ng = g * val; nb = b * val; }
                    else if (type === 'contrast') { nr = 128 + (r - 128) * val; ng = 128 + (g - 128) * val; nb = 128 + (b - 128) * val; }
                    else if (type === 'saturation') { const gr = 0.299 * r + 0.587 * g + 0.114 * b; nr = gr + (r - gr) * val; ng = gr + (g - gr) * val; nb = gr + (b - gr) * val; }
                    else if (type === 'hue') {
                        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
                        let hh; if (d === 0) hh = 0; else if (mx === r) hh = ((g - b) / d) % 6; else if (mx === g) hh = (b - r) / d + 2; else hh = (r - g) / d + 4;
                        hh = hh * 60; if (hh < 0) hh += 360;
                        const ss = mx === 0 ? 0 : d / mx, vv = mx;
                        let nH = (hh + val) % 360; if (nH < 0) nH += 360;
                        const c = vv * ss, x = c * (1 - Math.abs((nH / 60) % 2 - 1)), m = vv - c;
                        if (nH < 60) { nr = c; ng = x; nb = 0; } else if (nH < 120) { nr = x; ng = c; nb = 0; } else if (nH < 180) { nr = 0; ng = c; nb = x; } else if (nH < 240) { nr = 0; ng = x; nb = c; } else if (nH < 300) { nr = x; ng = 0; nb = c; } else { nr = c; ng = 0; nb = x; }
                        nr += m; ng += m; nb += m;
                    }
                    if (weight === 1) { r = nr; g = ng; b = nb; }
                    else { r += (nr - r) * weight; g += (ng - g) * weight; b += (nb - b) * weight; }
                }
            }
            dst[i] = Math.round(r); dst[i + 1] = Math.round(g); dst[i + 2] = Math.round(b); dst[i + 3] = a0;
        }
        return new ImageData(dst, w, h);
    }

    // Applique les effets spatiaux (pixelate/blur/vignette/sharpen) sur un canvas.
    _applySpatialEffects(canvas, controls) {
        const w = canvas.width, h = canvas.height;
        const ctx = canvas.getContext('2d');

        // Pixelate : downscale + upscale NEAREST
        const pix = controls.find(c => c.type === 'pixelate' && c.value > 1);
        if (pix) {
            const s = Math.max(2, pix.value);
            const tmp = document.createElement('canvas');
            tmp.width = Math.max(1, Math.round(w / s));
            tmp.height = Math.max(1, Math.round(h / s));
            const tctx = tmp.getContext('2d');
            tctx.imageSmoothingEnabled = false;
            tctx.drawImage(canvas, 0, 0, tmp.width, tmp.height);
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(tmp, 0, 0, w, h);
            ctx.imageSmoothingEnabled = true;
        }

        // Blur : ctx.filter
        const blr = controls.find(c => c.type === 'blur' && c.value > 0);
        if (blr) {
            ctx.filter = `blur(${Math.max(0.5, blr.value)}px)`;
            ctx.drawImage(canvas, 0, 0);
            ctx.filter = 'none';
        }

        // Vignette : assombrissement radial
        const vig = controls.find(c => c.type === 'vignette' && c.value > 0);
        if (vig) {
            const cx = w / 2, cy = h / 2;
            const maxR = Math.sqrt(cx * cx + cy * cy) * 1.05;
            const grad = ctx.createRadialGradient(cx, cy, maxR * 0.35, cx, cy, maxR);
            grad.addColorStop(0, 'rgba(0,0,0,0)');
            grad.addColorStop(1, `rgba(0,0,0,${Math.min(0.85, vig.value * 0.7)})`);
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);
        }

        // Sharpen : unsharp mask (original + (original - flou) * quantité)
        const shp = controls.find(c => c.type === 'sharpen' && c.value > 0);
        if (shp) {
            const tmp = document.createElement('canvas');
            tmp.width = w; tmp.height = h;
            const tctx = tmp.getContext('2d');
            tctx.filter = 'blur(2px)';
            tctx.drawImage(canvas, 0, 0);
            tctx.filter = 'none';
            const cur = ctx.getImageData(0, 0, w, h).data;
            const blrD = tctx.getImageData(0, 0, w, h).data;
            const out = new Uint8ClampedArray(cur.length);
            const amount = Math.min(3, shp.value);
            for (let i = 0; i < cur.length; i += 4) {
                for (let ch = 0; ch < 3; ch++) {
                    const d = cur[i + ch] - blrD[i + ch];
                    out[i + ch] = Math.max(0, Math.min(255, cur[i + ch] + d * amount));
                }
                out[i + 3] = cur[i + 3];
            }
            ctx.putImageData(new ImageData(out, w, h), 0, 0);
        }
    }

    // Composite resultCanvas avec baseCanvas via le mask (featheré) : hors mask,
    // on garde la base (entrée du segment).
    _compositeWithMask(resultCanvas, baseCanvas, maskCanvas, feather) {
        const w = resultCanvas.width, h = resultCanvas.height;
        const maskC = document.createElement('canvas');
        maskC.width = w; maskC.height = h;
        const mctx = maskC.getContext('2d');
        if (feather > 0) { mctx.filter = `blur(${feather}px)`; }
        mctx.drawImage(maskCanvas, 0, 0, w, h);
        mctx.filter = 'none';
        const maskData = mctx.getImageData(0, 0, w, h).data;
        const cur = resultCanvas.getContext('2d').getImageData(0, 0, w, h).data;
        const base = baseCanvas.getContext('2d').getImageData(0, 0, w, h).data;
        const out = new Uint8ClampedArray(cur.length);
        for (let i = 0; i < cur.length; i += 4) {
            const ma = maskData[i] / 255; // 0 (hors mask) → 1 (dans mask)
            out[i] = base[i] * (1 - ma) + cur[i] * ma;
            out[i + 1] = base[i + 1] * (1 - ma) + cur[i + 1] * ma;
            out[i + 2] = base[i + 2] * (1 - ma) + cur[i + 2] * ma;
            out[i + 3] = cur[i + 3];
        }
        resultCanvas.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);
    }

    _luminanceWeight(lum, range) {
        if (range === 'all') return 1;
        if (range === 'shadows') return lum < 128 ? 1 - lum / 128 : 0;
        if (range === 'midtones') {
            if (lum < 64) return 0; if (lum < 128) return (lum - 64) / 64;
            if (lum < 192) return (192 - lum) / 64; return 0;
        }
        if (range === 'highlights') return lum > 127 ? (lum - 127) / 128 : 0;
        return 1;
    }

    _getPreviewElements() {
        return [
            document.querySelector('#holaf-viewer-zoom-view img'),
            document.querySelector('#holaf-viewer-zoom-view video'),
            document.querySelector('#holaf-viewer-fullscreen-overlay img'),
            document.querySelector('#holaf-viewer-fullscreen-overlay video')
        ];
    }

    // ── Controls management (auto-save on every change) ──

    _addControl(typeId, range) {
        const def = findControlDef(typeId);
        if (!def) return;
        _ctrlIdCounter++;
        const newId = 'c_' + _ctrlIdCounter;
        // Types zonaux : `zones` (4 bandes neutres). Types non zonaux : `value`.
        // (Le paramètre `range` est conservé en signature pour compat mais ignoré :
        //  le picker n'a plus d'étape « plage ».)
        const ctrl = def.zonal
            ? { id: newId, type: typeId, zones: neutralZones(typeId) }
            : { id: newId, type: typeId, value: def.default };
        this.currentState.controls = [...this.currentState.controls, ctrl];
        this._expandedCtrlId = newId; // déplier automatiquement le contrôle ajouté
        this._updateUIFromState();
        this.applyPreview();
        this._scheduleAutoSave();
    }

    // Aligne les compteurs d'id sur les contrôles chargés (c_N / m_N) : évite de
    // ré-émettre un id déjà présent quand on rouvre une image ayant des edits.
    _syncIdCounters() {
        for (const c of this.currentState.controls || []) {
            const cm = /^c_(\d+)$/.exec(c.id || '');
            if (cm) _ctrlIdCounter = Math.max(_ctrlIdCounter, parseInt(cm[1], 10));
            const mm = /^m_(\d+)$/.exec(c.id || '');
            if (mm) _maskIdCounter = Math.max(_maskIdCounter, parseInt(mm[1], 10));
        }
    }

    // Crée un NOUVEAU layer mask (élément ordonné de la pipeline) et ouvre son éditeur.
    _addMaskLayer() {
        if (!this.activeImage) return;
        _maskIdCounter++;
        const id = 'm_' + _maskIdCounter;
        this.currentState.controls = [...this.currentState.controls, { type: 'mask', id, value: 0 }];
        // Canvas vierge full-res (taille naturelle de l'image, cap 4096)
        const img = this._maskImageEl();
        const nw = (img && img.naturalWidth) || 0;
        const nh = (img && img.naturalHeight) || 0;
        const maxDim = 4096;
        const sc = Math.min(1, maxDim / Math.max(nw, nh));
        const fw = Math.max(1, Math.round(nw * sc));
        const fh = Math.max(1, Math.round(nh * sc));
        const c = document.createElement('canvas');
        c.width = fw; c.height = fh;
        this._maskCanvases[id] = c;
        this._expandedCtrlId = id;
        this._updateUIFromState();
        this._openMaskEditor(id);
    }

    _removeControl(ctrlId) {
        this.currentState.controls = this.currentState.controls.filter(c => c.id !== ctrlId);
        if (this._expandedCtrlId === ctrlId) this._expandedCtrlId = null;
        // Suppression d'un layer mask : retire le canvas + l'overlay éventuel
        if (this._maskCanvases[ctrlId]) delete this._maskCanvases[ctrlId];
        if (this._activeOverlayMaskId === ctrlId) {
            this._activeOverlayMaskId = null;
            const ov = document.getElementById('holaf-mask-overlay');
            if (ov) this._removeOverlayWrapper(ov);
        }
        this._updateUIFromState();
        this.applyPreview();
        this._scheduleAutoSave();
    }

    _renderControlsList() {
        const container = this.panelEl?.querySelector('#holaf-editor-controls-list');
        if (!container) return;
        const controls = this.currentState.controls || [];
        const hasCrop = !!this.currentState.crop;

        if (controls.length === 0 && !hasCrop) {
            container.innerHTML = `<p style="opacity:0.5;font-size:12px;text-align:center;padding:12px 0;">${t('iv.noControlsYet')}</p>`;
            return;
        }

        const iconBtn = (attrs, glyph, extraStyle = '') =>
            `<button class="holaf-editor-remove-ctrl" ${attrs} style="background:none;border:none;cursor:pointer;padding:0 2px;font-size:14px;line-height:1;${extraStyle}">${glyph}</button>`;

        let html = '';

        controls.forEach((c, idx) => {
            const dimUp = idx === 0, dimDown = idx === controls.length - 1;
            const upBtn = iconBtn(`data-ctrl-up title="${t('iv.moveUp')}"${dimUp ? ' disabled' : ''}`, '↑', dimUp ? 'opacity:.3;cursor:default;' : '');
            const downBtn = iconBtn(`data-ctrl-down title="${t('iv.moveDown')}"${dimDown ? ' disabled' : ''}`, '↓', dimDown ? 'opacity:.3;cursor:default;' : '');

            // ── Ligne « Mask » (layer ordonné de la pipeline) ──
            if (c.type === 'mask') {
                const feather = c.value || 0;
                const hidden = this._activeOverlayMaskId !== c.id;
                html += `
                    <div class="holaf-editor-slider-container" data-mask-id="${c.id}" data-ctrl-id="${c.id}" style="grid-template-columns:80px 65px 1fr auto;">
                        <label>🎭 ${t('iv.maskLabel')}</label>
                        <span class="holaf-editor-range-label" style="font-size:11px;opacity:0.6;">${t('iv.featherLabel')}</span>
                        <input type="range" min="0" max="50" step="1" value="${feather}" data-mask-feather>
                        <div style="display:flex;align-items:center;gap:4px;">
                            <span class="holaf-editor-slider-value" style="min-width:36px;">${Math.round(feather)}px</span>
                            ${upBtn}${downBtn}
                            <button class="holaf-editor-remove-ctrl" data-mask-hide title="${t(hidden ? 'iv.showMask' : 'iv.hideMask')}" style="background:none;border:none;cursor:pointer;padding:0 2px;font-size:14px;line-height:1;">${hidden ? '🙈' : '👁'}</button>
                            <button class="holaf-editor-remove-ctrl" data-mask-edit title="${t('iv.editMask')}" style="background:none;border:none;cursor:pointer;color:var(--holaf-accent-color,#4682B4);padding:0 2px;font-size:14px;line-height:1;">✏️</button>
                            <button class="holaf-editor-remove-ctrl" data-mask-clear title="${t('iv.clearMask')}" style="background:none;border:none;cursor:pointer;color:var(--holaf-error-color,#c44);padding:0 2px;font-size:14px;line-height:1;">🗑</button>
                        </div>
                    </div>
                    <div style="height:4px;"></div>`;
                return;
            }

            const def = findControlDef(c.type);
            if (!def) return;
            const expanded = this._expandedCtrlId === c.id;
            const delBtn = iconBtn(`data-ctrl-id="${c.id}" title="${t('iv.removeCtrlTitle', { label: _controlTypeLabel(c.type) })}"`, '✕', 'color:var(--holaf-error-color,#c44);');
            const nameStyle = 'text-align:left;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

            if (!expanded) {
                // Replié : nom + pastilles des SEULES bandes ≠ neutre (ou valeur
                // pour un contrôle non zonaux). Clic sur la ligne pour déplier.
                let summary;
                if (def.zonal) {
                    const passes = controlZonePasses(c);
                    summary = passes.length
                        ? passes.map((p) => _zonePillHtml(p.zone, p.value, def)).join('')
                        : `<span class="holaf-editor-slider-value" style="opacity:0.4;">—</span>`;
                    summary = `<span class="holaf-editor-zone-pills">${summary}</span>`;
                } else {
                    const meta = _ctrlSliderMeta(def, c.value);
                    summary = `<span class="holaf-editor-slider-value" style="min-width:36px;flex-shrink:0;">${meta.display}</span>`;
                }
                html += `
                    <div class="holaf-editor-slider-container" data-ctrl-id="${c.id}" style="display:flex;align-items:center;gap:6px;">
                        <label style="${nameStyle}">${_controlTypeLabel(c.type)}</label>
                        ${summary}
                        ${upBtn}${downBtn}${delBtn}
                    </div>`;
            } else if (def.zonal) {
                // Déplié zonal : en-tête + 4 sliders étiquetés (Tout/Ombres/…).
                html += `
                    <div class="holaf-editor-slider-container holaf-editor-zonal" data-ctrl-id="${c.id}" style="display:block;padding:2px 0;">
                        <div style="display:flex;align-items:center;gap:6px;">
                            <label style="${nameStyle}">${_controlTypeLabel(c.type)}</label>
                            ${upBtn}${downBtn}${delBtn}
                        </div>
                        <div data-ctrl-body class="holaf-editor-zonal-body">
                            ${ZONE_KEYS.map((zone) => _zoneRowHtml(c, def, zone)).join('')}
                        </div>
                    </div>`;
            } else {
                // Déplié non zonal : en-tête + slider unique.
                const meta = _ctrlSliderMeta(def, c.value);
                html += `
                    <div class="holaf-editor-slider-container" data-ctrl-id="${c.id}" style="display:block;padding:2px 0;">
                        <div style="display:flex;align-items:center;gap:6px;">
                            <label style="${nameStyle}">${_controlTypeLabel(c.type)}</label>
                            ${upBtn}${downBtn}${delBtn}
                        </div>
                        <div data-ctrl-body style="display:flex;align-items:center;gap:6px;margin-top:3px;">
                            <input type="range" min="${def.min}" max="${def.max}" step="${def.step}" value="${meta.sliderVal}" style="flex-grow:1;min-width:0;margin:0;">
                            <span class="holaf-editor-slider-value" style="min-width:36px;flex-shrink:0;">${meta.display}</span>
                        </div>
                    </div>`;
            }
        });

        // ── Ligne « Crop » (EN DERNIER, après les mask rows et les effets) ──
        // Le crop est une décision de cadrage FINALE appliquée en dernier : il
        // n'est pas dans la chaîne réordonnable → pas de boutons ↑/↓.
        if (hasCrop) {
            const img = this._maskImageEl();
            const nw = (img && img.naturalWidth) || 0;
            const nh = (img && img.naturalHeight) || 0;
            const c = this.currentState.crop;
            const cw = Math.round(c.w * nw);
            const ch = Math.round(c.h * nh);
            html += `
                <div class="holaf-editor-slider-container" data-crop-row style="display:flex;align-items:center;gap:6px;">
                    <label style="text-align:left;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📐 ${t('iv.cropLabel')}</label>
                    <span style="font-size:10px;opacity:0.5;flex-shrink:0;">${t('iv.cropAppliedLast')}</span>
                    <span class="holaf-editor-range-label" style="font-size:11px;flex-shrink:0;opacity:0.6;">${cw}×${ch}px</span>
                    <button class="holaf-editor-remove-ctrl" data-crop-edit title="${t('iv.cropEditTitle')}" style="background:none;border:none;cursor:pointer;color:var(--holaf-accent-color,#4682B4);padding:0 2px;font-size:14px;line-height:1;">✏️</button>
                    <button class="holaf-editor-remove-ctrl" data-crop-clear title="${t('iv.clearMask')}" style="background:none;border:none;cursor:pointer;color:var(--holaf-error-color,#c44);padding:0 2px;font-size:14px;line-height:1;">🗑</button>
                </div>
                <div style="height:4px;"></div>`;
        }

        container.innerHTML = html;
    }

    // ── Mask editor (dessin sur l'image : formes + lasso + gomme + feather) ──

    _maskImageEl() {
        return document.querySelector('#holaf-viewer-zoom-view img');
    }

    _maskImageRect(img) {
        // Rect letterboxé réel de l'image affichée (object-fit:contain)
        const boxW = img.offsetWidth || img.naturalWidth || 100;
        const boxH = img.offsetHeight || img.naturalHeight || 100;
        const natW = img.naturalWidth || boxW, natH = img.naturalHeight || boxH;
        const s = Math.min(boxW / natW, boxH / natH);
        const dispW = Math.max(1, Math.round(natW * s));
        const dispH = Math.max(1, Math.round(natH * s));
        return {
            width: dispW, height: dispH,
            dx: (boxW - dispW) / 2, dy: (boxH - dispH) / 2,
            scale: s,
        };
    }

    // ── Viewport (holaf-viewport) : positionnement transform-aware des overlays ──

    // State viewport actif pour l'éditeur. L'éditeur est lié à la vue zoom
    // (overlays posés dans #holaf-viewer-zoom-view) → on résout le state via la
    // vue liée, pas une référence en dur dispersée. Si l'éditeur était un jour
    // lié à la vue fullscreen, seul ce helper changerait.
    _activeViewState() {
        return (this.viewer && this.viewer.zoomViewState) || null;
    }

    _activeViewport() {
        const st = this._activeViewState();
        return (st && st.viewport) || null;
    }

    // VAGUE 5 : un follower doit avoir la MÊME BOÎTE DE REPOS que le content =
    // la boîte de l'ÉLÉMENT img ENTIER (offsetLeft/Top/Width/Height). Le
    // letterbox (dx, dy, dispW, dispH) est rendu À L'INTÉRIEUR : le canvas
    // (résolution inchangée = letterbox échelle 1, peinture inchangée) est
    // positionné à (dx, dy) DANS le wrapper, taille CSS dispW×dispH. Ainsi :
    // même boîte + même transform = tracking parfait à tout zoom (plus de
    // dérive dx×(1−s)). Le wrapper est STATIQUE (boîte constante) ; seul le
    // transform bouge. La résolution canvas (canvas.width/height) reste
    // inchangée → indépendante du zoom.
    _followOverlay(wrapper, canvas) {
        const img = this._maskImageEl();
        const r = this._maskImageRect(img);
        // Wrapper : boîte de repos = boîte ÉLÉMENT de l'img (constante).
        wrapper.style.left = (img.offsetLeft || 0) + 'px';
        wrapper.style.top = (img.offsetTop || 0) + 'px';
        wrapper.style.width = (img.offsetWidth || 0) + 'px';
        wrapper.style.height = (img.offsetHeight || 0) + 'px';
        wrapper.style.transformOrigin = '0 0';
        // Canvas : letterbox À L'INTÉRIEUR du wrapper (échelle 1 — le wrapper
        // le scalera via le transform du viewport).
        canvas.style.left = r.dx + 'px';
        canvas.style.top = r.dy + 'px';
        canvas.style.width = r.width + 'px';
        canvas.style.height = r.height + 'px';
        const vp = this._activeViewport();
        if (vp) vp.addFollower(wrapper);
    }

    // Crée (ou récupère) le wrapper div follower d'un overlay canvas. Le wrapper
    // a pointer-events:none (ne vole pas les événements aux bandes letterbox →
    // le drag pan sur l'img continue de fonctionner) ; le canvas garde
    // pointer-events:auto (cible des événements de dessin : _cropOnDown/
    // _maskOnDown etc. restent bindés au canvas, non au wrapper). z-index
    // identique à l'ancien overlay.
    _ensureOverlayWrapper(canvas, zIndex) {
        const zoomView = document.getElementById('holaf-viewer-zoom-view');
        let wrapper = document.getElementById(canvas.id + '-wrap');
        if (!wrapper) {
            wrapper = document.createElement('div');
            wrapper.id = canvas.id + '-wrap';
            wrapper.style.cssText = 'position:absolute;z-index:' + zIndex + ';pointer-events:none;transition:none;';
            zoomView.appendChild(wrapper);
        }
        if (canvas.parentNode !== wrapper) wrapper.appendChild(canvas);
        return wrapper;
    }

    // Détache le wrapper du viewport (removeFollower) et le retire du DOM
    // (le canvas, enfant, est retiré avec lui). Ne retire que si le parent est
    // bien un wrapper (id finissant par '-wrap') — jamais le conteneur.
    _removeOverlayWrapper(canvas) {
        const wrapper = canvas && canvas.parentNode;
        if (wrapper && wrapper.id && wrapper.id.endsWith('-wrap')) {
            const vp = this._activeViewport();
            if (vp) vp.removeFollower(wrapper);
            wrapper.remove();
        }
    }

    // Convertit un canvas de mask (niveaux de gris ou tracés rouges) en
    // rendu rouge-alpha (R=255, G=0, B=0, A=valeur du mask) pour l'overlay.
    _maskTinted(maskCanvas, w, h) {
        const out = document.createElement('canvas');
        out.width = w || maskCanvas.width; out.height = h || maskCanvas.height;
        const ctx = out.getContext('2d');
        ctx.drawImage(maskCanvas, 0, 0, out.width, out.height);
        const d = ctx.getImageData(0, 0, out.width, out.height);
        const px = d.data;
        for (let i = 0; i < px.length; i += 4) {
            const v = px[i]; // valeur du mask (canal R)
            px[i] = 255; px[i + 1] = 0; px[i + 2] = 0;
            px[i + 3] = Math.round(v * 0.55);
        }
        ctx.putImageData(new ImageData(px, out.width, out.height), 0, 0);
        return out;
    }

    _showMaskOverlay(maskId) {
        const zoomView = document.getElementById('holaf-viewer-zoom-view');
        const img = this._maskImageEl();
        const maskCanvas = this._maskCanvases[maskId];
        if (!zoomView || !img || !maskCanvas) return;
        let overlay = document.getElementById('holaf-mask-overlay');
        if (!overlay) {
            overlay = document.createElement('canvas');
            overlay.id = 'holaf-mask-overlay';
        }
        // Résolution canvas : taille letterbox à l'échelle 1 (indépendante du zoom).
        const r = this._maskImageRect(img);
        overlay.width = r.width; overlay.height = r.height;
        overlay.style.cssText = 'position:absolute;z-index:60;pointer-events:none;opacity:0.45;transition:none;';
        // Wrapper follower (boîte = boîte de l'img) + canvas letterbox dedans :
        // le wrapper est STATIQUE, le transform du viewport fait tout.
        const wrapper = this._ensureOverlayWrapper(overlay, 60);
        this._followOverlay(wrapper, overlay);
        const ctx = overlay.getContext('2d');
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        ctx.drawImage(this._maskTinted(maskCanvas, overlay.width, overlay.height), 0, 0);
        this._activeOverlayMaskId = maskId;
    }

    // ── Crop overlay passif (affichage du cadrage final) ──
    // Le crop est désormais une décision de cadrage FINALE appliquée en dernier
    // par le serveur. Côté client, la préview n'applique plus le crop : on
    // affiche simplement un overlay passif (extérieur assombri, intérieur
    // normal, pointer-events:none) sur l'image complète. Positionné/dimensionné
    // via viewport.getImageRect() (transform-aware, aligné à tout zoom).
    _showCropOverlay() {
        const zoomView = document.getElementById('holaf-viewer-zoom-view');
        const img = this._maskImageEl();
        const crop = this.currentState.crop;
        if (!crop) {
            const ov = document.getElementById('holaf-crop-overlay');
            if (ov) this._removeOverlayWrapper(ov);
            return;
        }
        if (!zoomView || !img) return;
        // Ne pas interférer avec l'éditeur de crop ouvert (il gère son propre overlay)
        if (this._cropOverlay) return;
        let overlay = document.getElementById('holaf-crop-overlay');
        if (!overlay) {
            overlay = document.createElement('canvas');
            overlay.id = 'holaf-crop-overlay';
        }
        const r = this._maskImageRect(img);
        overlay.width = r.width; overlay.height = r.height;
        overlay.style.cssText = 'position:absolute;z-index:60;pointer-events:none;transition:none;';
        // Wrapper follower (boîte = boîte de l'img) + canvas letterbox dedans.
        const wrapper = this._ensureOverlayWrapper(overlay, 60);
        this._followOverlay(wrapper, overlay);
        this._drawPassiveCropOverlay(overlay);
    }

    // Dessine l'overlay crop passif (extérieur assombri) depuis currentState.crop.
    _drawPassiveCropOverlay(overlay) {
        const crop = this.currentState.crop;
        if (!crop) return;
        const ctx = overlay.getContext('2d');
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        const rect = { x: crop.x * overlay.width, y: crop.y * overlay.height, w: crop.w * overlay.width, h: crop.h * overlay.height };
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        // haut
        ctx.fillRect(0, 0, overlay.width, rect.y);
        // bas
        ctx.fillRect(0, rect.y + rect.h, overlay.width, overlay.height - (rect.y + rect.h));
        // gauche
        ctx.fillRect(0, rect.y, rect.x, rect.h);
        // droite
        ctx.fillRect(rect.x + rect.w, rect.y, overlay.width - (rect.x + rect.w), rect.h);
    }

    _openMaskEditor(maskId) {
        if (!this.activeImage) return;
        const zoomView = document.getElementById('holaf-viewer-zoom-view');
        const img = this._maskImageEl();
        if (!zoomView || !img) { this._showToast(t('iv.maskNoImage'), 'error'); return; }

        this._finishMaskEditor(false); // nettoie un éditeur déjà ouvert

        // Éditer le mask implique le voir : ré-affiche l'overlay s'il était caché
        this._maskHidden = false;

        // ── Forcer le zoom à l'échelle 1 : le mask vit dans le repère image ──
        const st = this._activeViewState();
        if (st) resetTransform(st, img);

        const overlay = document.getElementById('holaf-mask-overlay') || document.createElement('canvas');
        overlay.id = 'holaf-mask-overlay';
        const r = this._maskImageRect(img);
        overlay.width = r.width; overlay.height = r.height;
        // VAGUE 6 : pointer-events:auto OBLIGATOIRE — le wrapper follower a
        // pointer-events:none (hérité par défaut) ; sans ceci le canvas ne
        // reçoit AUCUN événement et le pointerdown traverse jusqu'à l'img →
        // le pan du viewport démarre (curseur grab) et le dessin ne se fait
        // jamais. Le canvas est au-dessus de l'img → il intercepte le dessin.
        overlay.style.cssText = 'position:absolute;z-index:60;pointer-events:auto;cursor:crosshair;opacity:0.5;transition:none;';
        // Wrapper follower (boîte = boîte de l'img) + canvas letterbox dedans.
        const wrapper = this._ensureOverlayWrapper(overlay, 60);
        this._followOverlay(wrapper, overlay);
        const octx = overlay.getContext('2d');
        octx.clearRect(0, 0, overlay.width, overlay.height);
        if (this._maskCanvases[maskId]) octx.drawImage(this._maskTinted(this._maskCanvases[maskId], overlay.width, overlay.height), 0, 0);

        const maskCtrl = this.currentState.controls.find(c => c.id === maskId);
        const feather = (maskCtrl && maskCtrl.value) || 0;

        const bar = document.createElement('div');
        bar.id = 'holaf-mask-toolbar';
        bar.style.cssText = 'position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:70;display:flex;align-items:center;gap:6px;padding:6px 10px;background:rgba(20,20,28,0.92);border:1px solid var(--holaf-border-color,#444);border-radius:8px;color:var(--holaf-text-primary,#eee);font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.4);max-width:96vw;flex-wrap:wrap;';
        bar.innerHTML = `
            <button data-mask-tool="rect" class="comfy-button" style="padding:3px 8px;">▭ ${t('iv.maskRect')}</button>
            <button data-mask-tool="ellipse" class="comfy-button" style="padding:3px 8px;">⬭ ${t('iv.maskEllipse')}</button>
            <button data-mask-tool="lasso" class="comfy-button" style="padding:3px 8px;">✏️ ${t('iv.maskLasso')}</button>
            <button data-mask-tool="erase" class="comfy-button" style="padding:3px 8px;">🧽 ${t('iv.maskErase')}</button>
            <button data-mask-clear class="comfy-button" style="padding:3px 8px;">🗑 ${t('iv.maskClear')}</button>
            <span style="opacity:.7;margin-left:6px;">${t('iv.featherLabel')}</span>
            <input type="range" data-mask-feather-edit min="0" max="50" step="1" value="${feather}" style="width:80px;">
            <button data-mask-ok class="comfy-button" style="padding:3px 10px;background:var(--holaf-accent-color,#4682B4);color:#fff;">${t('iv.maskValidate')}</button>
            <button data-mask-cancel class="comfy-button" style="padding:3px 10px;">${t('iv.cancel')}</button>
        `;
        zoomView.appendChild(bar);

        this._maskOverlay = overlay;
        this._maskBar = bar;
        this._maskTool = 'rect';
        this._maskFeather = feather;
        this._maskPrev = maskCtrl ? { ...maskCtrl } : null;
        this._maskPrevCanvas = this._maskCanvases[maskId] ? this._cloneCanvas(this._maskCanvases[maskId]) : null;
        this._activeMaskId = maskId;

        bar.addEventListener('click', (e) => {
            const tool = e.target.closest('[data-mask-tool]');
            if (tool) { this._maskTool = tool.dataset.maskTool; return; }
            if (e.target.closest('[data-mask-clear]')) { this._clearMaskOverlay(); return; }
            if (e.target.closest('[data-mask-ok]')) { this._finishMaskEditor(true); return; }
            if (e.target.closest('[data-mask-cancel]')) { this._finishMaskEditor(false); return; }
        });
        bar.addEventListener('input', (e) => {
            if (e.target.hasAttribute('data-mask-feather-edit')) this._maskFeather = parseFloat(e.target.value) || 0;
        });

        overlay.addEventListener('pointerdown', (e) => {
            this._maskOnDown(e);
            try { overlay.setPointerCapture(e.pointerId); } catch (err) {}
        });
        overlay.addEventListener('pointermove', (e) => this._maskOnMove(e));
        overlay.addEventListener('pointerup', (e) => this._maskOnUp(e));
        overlay.addEventListener('pointercancel', (e) => this._maskOnUp(e));
    }

    _cloneCanvas(c) {
        const out = document.createElement('canvas');
        out.width = c.width; out.height = c.height;
        out.getContext('2d').drawImage(c, 0, 0);
        return out;
    }

    _maskLocal(e) {
        const r = this._maskOverlay.getBoundingClientRect();
        return {
            x: (e.clientX - r.left) * (this._maskOverlay.width / Math.max(1, r.width)),
            y: (e.clientY - r.top) * (this._maskOverlay.height / Math.max(1, r.height)),
        };
    }

    _maskOnDown(e) {
        if (!this._maskOverlay) return;
        e.preventDefault();
        this._maskDrawing = true;
        const p = this._maskLocal(e);
        this._maskStart = p;
        this._maskPath = [p];
        // snapshot pour le live-redraw des formes (pas pour la gomme)
        this._maskSnap = this._maskTool === 'erase' ? null : this._cloneCanvas(this._maskOverlay);
    }

    _maskOnMove(e) {
        if (!this._maskDrawing || !this._maskOverlay) return;
        const p = this._maskLocal(e);
        const ctx = this._maskOverlay.getContext('2d');
        if (this._maskTool === 'erase') {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.fillStyle = '#000';
            ctx.beginPath(); ctx.arc(p.x, p.y, 10, 0, Math.PI * 2); ctx.fill();
            return;
        }
        if (this._maskTool === 'lasso') {
            this._maskPath.push(p);
        }
        // redraw depuis le snapshot
        if (this._maskSnap) {
            ctx.globalCompositeOperation = 'source-over';
            ctx.clearRect(0, 0, this._maskOverlay.width, this._maskOverlay.height);
            ctx.drawImage(this._maskSnap, 0, 0);
        }
        ctx.globalCompositeOperation = 'source-over';
        const s = this._maskStart;
        if (this._maskTool === 'rect') {
            ctx.fillStyle = '#f00';
            ctx.fillRect(Math.min(s.x, p.x), Math.min(s.y, p.y), Math.abs(p.x - s.x), Math.abs(p.y - s.y));
        } else if (this._maskTool === 'ellipse') {
            ctx.fillStyle = '#f00';
            ctx.beginPath();
            ctx.ellipse((s.x + p.x) / 2, (s.y + p.y) / 2, Math.abs(p.x - s.x) / 2, Math.abs(p.y - s.y) / 2, 0, 0, Math.PI * 2);
            ctx.fill();
        } else if (this._maskTool === 'lasso') {
            ctx.strokeStyle = '#f00'; ctx.lineWidth = 2; ctx.lineJoin = 'round';
            ctx.beginPath(); ctx.moveTo(s.x, s.y);
            this._maskPath.forEach(pt => ctx.lineTo(pt.x, pt.y));
            ctx.stroke();
        }
    }

    _maskOnUp() {
        if (!this._maskDrawing || !this._maskOverlay) return;
        this._maskDrawing = false;
        const ctx = this._maskOverlay.getContext('2d');
        if (this._maskTool === 'lasso' && this._maskPath && this._maskPath.length > 1) {
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = 'rgba(255,0,0,0.85)';
            ctx.beginPath(); ctx.moveTo(this._maskStart.x, this._maskStart.y);
            this._maskPath.forEach(pt => ctx.lineTo(pt.x, pt.y));
            ctx.closePath(); ctx.fill();
        }
        this._maskSnap = null;
        this._maskPath = null;
    }

    _clearMaskOverlay() {
        if (!this._maskOverlay) return;
        this._maskOverlay.getContext('2d').clearRect(0, 0, this._maskOverlay.width, this._maskOverlay.height);
    }

    _bakeMaskToFull() {
        const img = this._maskImageEl();
        const nw = (img && img.naturalWidth) || this._maskOverlay.width;
        const nh = (img && img.naturalHeight) || this._maskOverlay.height;
        // Borne mémoire : on ne dépasse pas 4096 px de côté
        const maxDim = 4096;
        const sc = Math.min(1, maxDim / Math.max(nw, nh));
        const fw = Math.max(1, Math.round(nw * sc));
        const fh = Math.max(1, Math.round(nh * sc));
        const full = document.createElement('canvas');
        full.width = fw; full.height = fh;
        const fctx = full.getContext('2d');
        fctx.drawImage(this._maskOverlay, 0, 0, fw, fh);
        // Convertir en gris (canal R = valeur du mask)
        const d = fctx.getImageData(0, 0, fw, fh).data;
        const gray = fctx.createImageData(fw, fh);
        for (let i = 0; i < d.length; i += 4) {
            const v = d[i];
            gray.data[i] = gray.data[i + 1] = gray.data[i + 2] = v;
            gray.data[i + 3] = 255;
        }
        fctx.putImageData(gray, 0, 0);
        return full;
    }

    _finishMaskEditor(commit) {
        if (commit && this._maskOverlay && this._activeMaskId) {
            this._maskCanvases[this._activeMaskId] = this._bakeMaskToFull();
            const maskCtrl = this.currentState.controls.find(c => c.id === this._activeMaskId);
            if (maskCtrl) maskCtrl.value = this._maskFeather || 0;
            // overlay → affichage passif du mask
            this._maskOverlay.style.pointerEvents = 'none';
            this._maskOverlay.style.opacity = '0.45';
            this._maskOverlay.style.cursor = 'default';
            this._activeOverlayMaskId = this._activeMaskId;
            this._scheduleAutoSave();
            this.applyPreview();
            this._updateUIFromState();
        } else {
            // annulation : restaure l'état précédent du layer
            if (this._activeMaskId) {
                if (this._maskPrevCanvas) this._maskCanvases[this._activeMaskId] = this._maskPrevCanvas;
                const maskCtrl = this.currentState.controls.find(c => c.id === this._activeMaskId);
                if (maskCtrl && this._maskPrev) maskCtrl.value = this._maskPrev.value;
            }
            if (this._maskOverlay) this._removeOverlayWrapper(this._maskOverlay);
        }
        if (this._maskBar) { this._maskBar.remove(); this._maskBar = null; }
        this._maskOverlay = null;
        this._maskBar = null;
        this._maskSnap = null;
        this._maskPath = null;
        this._activeMaskId = null;
        // Annulation : restaure l'affichage passif du mask précédent (sauf s'il
        // est volontairement caché via le bouton 👁)
        if (!this._maskHidden && this._activeOverlayMaskId && this._maskCanvases[this._activeOverlayMaskId] && !document.getElementById('holaf-mask-overlay'))
            this._showMaskOverlay(this._activeOverlayMaskId);
        this.applyPreview();
        this._updateUIFromState();
    }

    // ── Crop editor (recadrage basique : sélection rectangle) ──

    _openCropEditor() {
        if (!this.activeImage) return;
        const zoomView = document.getElementById('holaf-viewer-zoom-view');
        const img = this._maskImageEl();
        if (!zoomView || !img) { this._showToast(t('iv.maskNoImage'), 'error'); return; }

        this._cleanupCropEditor(); // nettoie un éditeur déjà ouvert

        // ── Forcer le zoom à l'échelle 1 : le crop vit dans le repère image ──
        const st = this._activeViewState();
        if (st) resetTransform(st, img);

        const overlay = document.getElementById('holaf-crop-overlay') || document.createElement('canvas');
        overlay.id = 'holaf-crop-overlay';
        const r = this._maskImageRect(img);
        overlay.width = r.width; overlay.height = r.height;
        // VAGUE 6 : pointer-events:auto OBLIGATOIRE (cf. _openMaskEditor) — sans
        // ceci le canvas hérite de pointer-events:none du wrapper follower et le
        // pointerdown traverse jusqu'à l'img → pan du viewport au lieu du dessin.
        overlay.style.cssText = 'position:absolute;z-index:60;pointer-events:auto;cursor:crosshair;transition:none;';
        // Wrapper follower (boîte = boîte de l'img) + canvas letterbox dedans.
        const wrapper = this._ensureOverlayWrapper(overlay, 60);
        this._followOverlay(wrapper, overlay);

        // Pré-dessine le crop existant si présent
        this._cropRect = null;
        if (this.currentState.crop) {
            const c = this.currentState.crop;
            this._cropRect = { x: c.x * r.width, y: c.y * r.height, w: c.w * r.width, h: c.h * r.height };
        }
        this._drawCropOverlay();

        const bar = document.createElement('div');
        bar.id = 'holaf-crop-toolbar';
        bar.style.cssText = 'position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:70;display:flex;align-items:center;gap:6px;padding:6px 10px;background:rgba(20,20,28,0.92);border:1px solid var(--holaf-border-color,#444);border-radius:8px;color:var(--holaf-text-primary,#eee);font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.4);';
        bar.innerHTML = `
            <button data-crop-reset class="comfy-button" style="padding:3px 8px;">🗑 ${t('iv.cropReset')}</button>
            <button data-crop-ok class="comfy-button" style="padding:3px 10px;background:var(--holaf-accent-color,#4682B4);color:#fff;">${t('iv.cropValidate')}</button>
            <button data-crop-cancel class="comfy-button" style="padding:3px 10px;">${t('iv.cancel')}</button>
        `;
        zoomView.appendChild(bar);

        this._cropOverlay = overlay;
        this._cropBar = bar;
        this._cropDrawing = false;
        this._cropStart = null;
        this._cropPrev = this.currentState.crop ? { ...this.currentState.crop } : null;

        bar.addEventListener('click', (e) => {
            if (e.target.closest('[data-crop-reset]')) { this._resetCropRect(); return; }
            if (e.target.closest('[data-crop-ok]')) { this._finishCropEditor(true); return; }
            if (e.target.closest('[data-crop-cancel]')) { this._finishCropEditor(false); return; }
        });

        overlay.addEventListener('pointerdown', (e) => {
            this._cropOnDown(e);
            try { overlay.setPointerCapture(e.pointerId); } catch (err) {}
        });
        overlay.addEventListener('pointermove', (e) => this._cropOnMove(e));
        overlay.addEventListener('pointerup', (e) => this._cropOnUp(e));
        overlay.addEventListener('pointercancel', (e) => this._cropOnUp(e));
    }

    _cropLocal(e) {
        const r = this._cropOverlay.getBoundingClientRect();
        return {
            x: (e.clientX - r.left) * (this._cropOverlay.width / Math.max(1, r.width)),
            y: (e.clientY - r.top) * (this._cropOverlay.height / Math.max(1, r.height)),
        };
    }

    _cropOnDown(e) {
        if (!this._cropOverlay) return;
        e.preventDefault();
        this._cropDrawing = true;
        const p = this._cropLocal(e);
        this._cropStart = p;
        this._cropPrev = this._cropRect ? { ...this._cropRect } : null;
        this._cropRect = { x: p.x, y: p.y, w: 0, h: 0 };
    }

    _cropOnMove(e) {
        if (!this._cropDrawing || !this._cropOverlay) return;
        const p = this._cropLocal(e);
        const s = this._cropStart;
        this._cropRect = {
            x: Math.min(s.x, p.x),
            y: Math.min(s.y, p.y),
            w: Math.abs(p.x - s.x),
            h: Math.abs(p.y - s.y),
        };
        this._drawCropOverlay();
    }

    _cropOnUp() {
        if (!this._cropDrawing || !this._cropOverlay) return;
        this._cropDrawing = false;
        // Sélection trop petite → on restaure le rect précédent
        if (this._cropRect && (this._cropRect.w < 2 || this._cropRect.h < 2)) {
            this._cropRect = this._cropPrev ? { ...this._cropPrev } : null;
            this._drawCropOverlay();
        }
    }

    _resetCropRect() {
        const r = this._maskImageRect(this._maskImageEl());
        this._cropRect = { x: 0, y: 0, w: r.width, h: r.height };
        this._drawCropOverlay();
    }

    // Dessine la sélection : l'INTÉRIEUR normal, l'EXTÉRIEUR assombri
    // (4 rects sombres autour de la sélection) + bordure.
    _drawCropOverlay() {
        if (!this._cropOverlay) return;
        const ctx = this._cropOverlay.getContext('2d');
        const w = this._cropOverlay.width, h = this._cropOverlay.height;
        ctx.clearRect(0, 0, w, h);
        const rect = this._cropRect;
        if (!rect) return;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        // haut
        ctx.fillRect(0, 0, w, rect.y);
        // bas
        ctx.fillRect(0, rect.y + rect.h, w, h - (rect.y + rect.h));
        // gauche
        ctx.fillRect(0, rect.y, rect.x, rect.h);
        // droite
        ctx.fillRect(rect.x + rect.w, rect.y, w - (rect.x + rect.w), rect.h);
        // bordure de la sélection
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1;
        ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    }

    _finishCropEditor(commit) {
        if (commit && this._cropRect) {
            const r = this._maskImageRect(this._maskImageEl());
            const rect = this._cropRect;
            // Normalise 0-1 relatif à l'ORIGINAL (image complète affichée)
            const newCrop = {
                x: Math.max(0, Math.min(1, rect.x / r.width)),
                y: Math.max(0, Math.min(1, rect.y / r.height)),
                w: Math.max(0, Math.min(1, rect.w / r.width)),
                h: Math.max(0, Math.min(1, rect.h / r.height)),
            };
            // Le mask vit sur l'image COMPLÈTE : ajuster le crop ne l'invalide
            // plus → aucune confirmation de reset des masques.
            this.currentState.crop = newCrop;
            this._scheduleAutoSave();
            this.applyPreview();
            this._updateUIFromState();
        }
        this._cleanupCropEditor();
    }

    _cleanupCropEditor() {
        const ov = document.getElementById('holaf-crop-overlay');
        if (ov) this._removeOverlayWrapper(ov);
        if (this._cropBar) { this._cropBar.remove(); this._cropBar = null; }
        this._cropOverlay = null;
        this._cropRect = null;
        this._cropStart = null;
        this._cropDrawing = false;
        this._cropPrev = null;
        this.applyPreview();
        this._updateUIFromState();
    }

    // ── UI sync ──

    _updateUIFromState() {
        if (!this.panelEl) return;
        this._renderControlsList();

        const vs = this.panelEl.querySelector('#holaf-editor-video-section');
        const compareLabel = this.panelEl.querySelector('label[title="Split view: left = original, right = edited"]');
        if (compareLabel) compareLabel.style.display = this.nativeFps > 0 ? 'none' : '';
        if (vs) {
            if (this.nativeFps > 0) {
                vs.style.display = 'block';
                const fi = vs.querySelector('#holaf-editor-fps-input');
                const fs = vs.querySelector('#holaf-editor-fps-slider');
                let v = this.currentState.targetFps; if (!v || v <= 0) v = this.nativeFps;
                if (fi) fi.value = v; if (fs) fs.value = v;
                const ic = vs.querySelector('#holaf-editor-interpolate-check');
                if (ic) ic.checked = !!this.currentState.interpolate;
            } else vs.style.display = 'none';
        }
        this._showCropOverlay();
    }

    // ── Event listeners ──

    _attachListeners() {
        if (!this.panelEl) return;

        const addBtn = this.panelEl.querySelector('#holaf-editor-add-btn');
        if (addBtn) {
            addBtn.onclick = async () => {
                // Picker V4 master-detail : familles + compteur à gauche, contrôles
                // à droite. Un clic ajoute DIRECTEMENT (plus d'étape « plage »).
                const families = _buildPickerFamilies();
                const chosenType = await _pickFromList(t('iv.addControlTitle'), families, {
                    lastFamily: this._lastPickerFamily,
                    onFamilyChange: (fid) => { this._lastPickerFamily = fid; },
                });
                if (!chosenType) return;

                // Crop : ouvre l'éditeur de recadrage (comme le mask)
                if (chosenType === 'crop') {
                    this._openCropEditor();
                    return;
                }

                // Masque : crée un nouveau layer mask et ouvre son éditeur
                if (chosenType === 'mask') {
                    this._addMaskLayer();
                    return;
                }

                // Contrôle zonaux/non zonal : ajout direct, bandes neutres.
                this._addControl(chosenType);
            };
        }

        const list = this.panelEl.querySelector('#holaf-editor-controls-list');
        if (list) {
            // Slider input → auto-save after debounce. Un slider zonal porte
            // `data-zone` (all/shadows/midtones/highlights) ; un non zonal n'a
            // qu'une `value`.
            list.addEventListener('input', (e) => {
                const slider = e.target.closest('input[type="range"]');
                if (!slider) return;
                const container = slider.closest('.holaf-editor-slider-container');
                const ctrlId = container?.dataset.ctrlId;
                const ctrl = this.currentState.controls.find(c => c.id === ctrlId);
                if (!ctrl) return;
                const def = findControlDef(ctrl.type);
                if (!def) return;
                const zone = slider.dataset.zone || null;
                const raw = parseFloat(slider.value);
                if (def.zonal && zone) {
                    if (!ctrl.zones || typeof ctrl.zones !== 'object') ctrl.zones = neutralZones(ctrl.type);
                    ctrl.zones[zone] = _ctrlSliderMeta(def, ctrl.value).fromSlider(raw);
                } else {
                    ctrl.value = _ctrlSliderMeta(def, ctrl.value).fromSlider(raw);
                }
                const scope = slider.closest('[data-zone]') || container;
                const valEl = scope.querySelector('.holaf-editor-slider-value');
                if (valEl) {
                    const v = (def.zonal && zone) ? ctrl.zones[zone] : ctrl.value;
                    valEl.textContent = _ctrlSliderMeta(def, v).display;
                }
                this._schedulePreview();
                this._scheduleAutoSave();
            });

            // Double-click → reset la BANDE ciblée (slider) à sa valeur neutre.
            // Ligne dépliée uniquement ; le re-render du toggle peut faire perdre
            // la cible du dblclick → retombe sur la dernière ligne togglée < 600ms.
            list.addEventListener('dblclick', (e) => {
                const container = e.target.closest('.holaf-editor-slider-container');
                const ctrlId = container
                    ? container.dataset.ctrlId
                    : (this._lastToggledCtrlId && Date.now() - this._lastToggledAt < 600 ? this._lastToggledCtrlId : null);
                if (!ctrlId) return;
                const ctrl = this.currentState.controls.find(c => c.id === ctrlId);
                if (!ctrl) return;
                if (this._expandedCtrlId !== ctrlId) return; // reset visible seulement déplié
                const def = findControlDef(ctrl.type);
                if (!def) return;
                const zoneEl = e.target.closest('[data-zone]');
                const zone = zoneEl ? zoneEl.dataset.zone : null;
                if (def.zonal) {
                    if (!ctrl.zones || typeof ctrl.zones !== 'object') ctrl.zones = neutralZones(ctrl.type);
                    if (zone) ctrl.zones[zone] = def.default;
                    else ctrl.zones = neutralZones(ctrl.type); // pas de cible → reset global
                } else {
                    ctrl.value = def.default;
                }
                this._updateUIFromState();
                this._schedulePreview();
                this._scheduleAutoSave();
            });

            // Clic : boutons d'abord (mask / ordre / suppression), sinon
            // clic-ligne hors boutons/inputs → replier / déplier le contrôle
            list.addEventListener('click', (e) => {
                const btn = e.target.closest('.holaf-editor-remove-ctrl');
                if (btn) {
                    if (btn.hasAttribute('data-crop-edit')) {
                        this._openCropEditor();
                        return;
                    }
                    if (btn.hasAttribute('data-crop-clear')) {
                        this.currentState.crop = null;
                        this._updateUIFromState();
                        this.applyPreview();
                        this._scheduleAutoSave();
                        return;
                    }
                    if (btn.hasAttribute('data-mask-edit')) {
                        const row = btn.closest('[data-mask-id]');
                        this._openMaskEditor(row?.dataset.maskId);
                        return;
                    }
                    if (btn.hasAttribute('data-mask-clear')) {
                        const row = btn.closest('[data-mask-id]');
                        this._removeControl(row?.dataset.maskId);
                        return;
                    }
                    if (btn.hasAttribute('data-mask-hide')) {
                        const row = btn.closest('[data-mask-id]');
                        const mid = row?.dataset.maskId;
                        if (this._activeOverlayMaskId === mid) {
                            this._activeOverlayMaskId = null;
                            const ov = document.getElementById('holaf-mask-overlay');
                            if (ov) ov.remove();
                        } else {
                            this._showMaskOverlay(mid);
                        }
                        this._updateUIFromState();
                        return;
                    }
                    if (btn.hasAttribute('data-ctrl-up') || btn.hasAttribute('data-ctrl-down')) {
                        const row = btn.closest('[data-ctrl-id]');
                        const cid = row?.dataset.ctrlId;
                        const arr = [...this.currentState.controls];
                        const i = arr.findIndex(c => c.id === cid);
                        const j = btn.hasAttribute('data-ctrl-up') ? i - 1 : i + 1;
                        if (i >= 0 && j >= 0 && j < arr.length) {
                            [arr[i], arr[j]] = [arr[j], arr[i]];
                            this.currentState.controls = arr;
                            this._updateUIFromState();
                            this.applyPreview(); // la chaîne est recalculée dans le nouvel ordre
                            this._scheduleAutoSave();
                        }
                        return;
                    }
                    this._removeControl(btn.dataset.ctrlId);
                    return;
                }
                // Clic-ligne (hors boutons/inputs, pas dans la ligne slider
                // dépliée) → toggle d'expansion du contrôle
                const row = e.target.closest('.holaf-editor-slider-container');
                if (row && row.dataset.ctrlId && !e.target.closest('input')) {
                    const bodyLine = row.querySelector('[data-ctrl-body]');
                    if (bodyLine && bodyLine.contains(e.target)) return; // zone slider dépliée
                    const cid = row.dataset.ctrlId;
                    this._expandedCtrlId = this._expandedCtrlId === cid ? null : cid;
                    this._lastToggledCtrlId = cid;
                    this._lastToggledAt = Date.now();
                    this._renderControlsList();
                }
            });

            // Feather du mask (liste) — un slider par layer mask
            list.addEventListener('input', (e) => {
                const f = e.target.closest('[data-mask-feather]');
                if (!f) return;
                const row = f.closest('[data-mask-id]');
                const mid = row?.dataset.maskId;
                const ctrl = this.currentState.controls.find(c => c.id === mid);
                if (!ctrl) return;
                ctrl.value = parseFloat(f.value) || 0;
                const valEl = f.parentNode.querySelector('.holaf-editor-slider-value');
                if (valEl) valEl.textContent = ctrl.value + 'px';
                this._schedulePreview();
                this._scheduleAutoSave();
            });
        }

        // FPS
        const fi = this.panelEl.querySelector('#holaf-editor-fps-input');
        const fs = this.panelEl.querySelector('#holaf-editor-fps-slider');
        const ic = this.panelEl.querySelector('#holaf-editor-interpolate-check');

        const setFps = (v) => {
            const val = parseFloat(v);
            if (isNaN(val) || val <= 0) return;
            this.currentState.targetFps = val;
            this.applyPreview();
            this._scheduleAutoSave();
            if (fi && fi.value != val) fi.value = val;
            if (fs && fs.value != val) fs.value = val;
        };
        const resetFps = () => { if (this.nativeFps > 0) setFps(Math.round(this.nativeFps)); };

        if (fs) { fs.addEventListener('input', e => setFps(e.target.value)); fs.addEventListener('dblclick', resetFps); }
        if (fi) fi.addEventListener('change', e => setFps(e.target.value));
        if (this.panelEl.querySelector('#holaf-editor-video-section')) {
            this.panelEl.querySelector('#holaf-editor-video-section').addEventListener('dblclick', e => { if (e.target.tagName !== 'INPUT') resetFps(); });
        }
        if (ic) ic.addEventListener('change', e => {
            this.currentState.interpolate = e.target.checked;
            if (e.target.checked && this.nativeFps > 0) setFps(this.nativeFps * 2);
            else if (!e.target.checked && this.nativeFps > 0) setFps(this.nativeFps);
            this._scheduleAutoSave();
        });

        // Reset button
        const rb = this.panelEl.querySelector('#holaf-editor-reset-btn');
        if (rb) rb.onclick = () => this._resetEdits();

        // Compare toggle
        const compareCb = this.panelEl.querySelector('#holaf-editor-compare-check');
        if (compareCb) {
            compareCb.addEventListener('change', (e) => {
                this._toggleCompareMode(e.target.checked);
            });
        }
    }

    // ── Reset ──

    async _resetEdits() {
        if (!this.activeImage) return;
        if (!await AIH.ask({
            title: t('iv.confirmReset'), message: t('iv.resetMsg'),
            buttons: [{ text: t('iv.cancel'), value: false }, { text: t('iv.reset'), value: true, type: "danger" }]
        })) return;

        const path = this.activeImage.path_canon;
        // POST « tolérant » : les anciens fetch sans test .ok laissaient le
        // reset local se poursuivre même sur une erreur HTTP serveur ; on
        // conserve ce contrat (seules les erreurs réseau/timeout bloquent,
        // via le catch ci-dessous).
        const postLenient = (url, body) => HolafFetch.post(url, { body }).catch((e) => {
            if (!(e instanceof HolafFetchError) || !(e.status >= 400)) throw e;
        });
        try {
            await postLenient('/holaf/images/delete-edits', { path_canon: path });
            if (this.processedVideoUrl)
                await postLenient('/holaf/images/rollback-video', { path_canon: path });

            this.currentState = DEFAULT_EDIT_STATE();
            if (this.nativeFps > 0) this.currentState.targetFps = this.nativeFps;
            this._maskCanvases = {};
            this._activeOverlayMaskId = null;
            const ov = document.getElementById('holaf-mask-overlay');
            if (ov) this._removeOverlayWrapper(ov);
            this.processedVideoUrl = null;
            this._dispatchVideoOverride(null);
            this._clearCanvasCache();
            this._getPreviewElements().forEach(el => {
                if (el && el.dataset.originalSrc) { el.src = el.dataset.originalSrc; delete el.dataset.originalSrc; }
            });
            this._updateUIFromState();
            this.applyPreview();
            this._updateGlobalImageState(path, false);
            if (this.viewer?.gallery) this.viewer.gallery.refreshThumbnail(path);
            this._showToast(t('iv.editsReset'), 'success');
        } catch (e) { console.error(e); }
    }

    async _triggerProcessVideoBackground(path) {
        document.dispatchEvent(new Event('holaf-video-processing-start'));
        try {
            // Requête LONGE (transcodage FFmpeg côté serveur, plusieurs minutes) :
            // timeout: 0 désactive TOUT timer côté brique (0 = aucun, mécanisme
            // prévu par HolafFetch) — la réponse JSON n'arrive qu'à la fin du
            // traitement, un timeout la couperait à tort. Pas de retry configuré
            // (défaut de la brique) → jamais de double transcodage.
            const d = await HolafFetch.post('/holaf/images/process-video', {
                timeout: 0,
                body: { path_canon: path, edits: this.currentState }
            });
            this._showToast(d.stats ? t('iv.previewReady', { duration: d.stats.duration }) : t('iv.previewGenerated'), 'success');
            if (this.activeImage?.path_canon === path) await this._loadEditsForCurrentImage();
        } catch (e) {
            if (e instanceof HolafFetchError && e.status >= 400) {
                // Non-2xx : même écran que l'ancien else (!r.ok).
                AIH.ask({ title: t('iv.processError'), message: e.data?.message || e.message });
            } else {
                this._showToast(t('iv.processFailed', { message: e.message }), 'error');
            }
        }
        finally { document.dispatchEvent(new Event('holaf-video-processing-end')); }
    }

    // ── Compare mode ──

    _toggleCompareMode(active) {
        if (!this.activeImage) { this._compareCleanup(); return; }
        if (!active) { this._compareCleanup(); return; }

        const zoomView = document.getElementById('holaf-viewer-zoom-view');
        const editedImg = zoomView?.querySelector('img');
        if (!zoomView || !editedImg || !editedImg.src) return;

        if (this._compareCleanups) { this._compareCleanups.forEach(fn => fn()); this._compareCleanups = null; }
        if (this._compareRaf) { cancelAnimationFrame(this._compareRaf); this._compareRaf = null; }
        if (this._compareResizeObserver) { this._compareResizeObserver.disconnect(); this._compareResizeObserver = null; }
        const oldCanvas = document.getElementById('holaf-compare-canvas');
        if (oldCanvas) oldCanvas.remove();

        const canvas = document.createElement('canvas');
        canvas.id = 'holaf-compare-canvas';
        canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:50;pointer-events:none;';
        zoomView.appendChild(canvas);

        const rect = zoomView.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.height;
        const ctx = canvas.getContext('2d');

        // VAGUE 10 : la source ORIGINALE doit être construite avec la MÊME
        // fonction que le viewer (getFullImageUrl → /holaf/images/full avec
        // path_canon + cache-buster mtime). L'ancien code reconstruisait une URL
        // /view?filename=...&type=output qui pouvait résoudre vers un AUTRE
        // fichier (quand path_canon ≠ subfolder/filename) ou servir une version
        // en cache périmée → « le comparer ne compare pas avec la bonne image ».
        const originalUrl = editedImg.dataset.originalSrc || getFullImageUrl(this.activeImage);
        const editedUrl = editedImg.src;

        const origImg = new Image(); origImg.crossOrigin = 'anonymous';
        const editImg = new Image(); editImg.crossOrigin = 'anonymous';

        let imagesLoaded = 0;
        const onLoad = () => {
            imagesLoaded++;
            if (imagesLoaded < 2) return;
            this._compareStartLoop(zoomView, canvas, ctx, origImg, editImg, editedUrl);
        };
        origImg.onload = onLoad; editImg.onload = onLoad;
        origImg.src = originalUrl; editImg.src = editedUrl;

        this._compareResizeObserver = new ResizeObserver(() => {
            const r = zoomView.getBoundingClientRect();
            canvas.width = r.width; canvas.height = r.height;
        });
        this._compareResizeObserver.observe(zoomView);
    }

    _compareStartLoop(zoomView, canvas, ctx, origImg, editImg, initialEditedUrl) {
        const editedEl = zoomView.querySelector('img');
        let filterValue = editedEl ? getComputedStyle(editedEl).filter : 'none';
        let mouseX = canvas.width / 2;
        let isOver = false;

        const onMove = (e) => {
            const r = canvas.getBoundingClientRect();
            mouseX = Math.max(0, Math.min(r.width, e.clientX - r.left));
            isOver = true;
        };
        const onLeave = () => { isOver = false; };

        zoomView.addEventListener('mousemove', onMove);
        zoomView.addEventListener('mouseleave', onLeave);
        this._compareCleanups = [
            () => zoomView.removeEventListener('mousemove', onMove),
            () => zoomView.removeEventListener('mouseleave', onLeave),
        ];

        let currentEditedSrc = initialEditedUrl;

        const render = () => {
            const w = canvas.width, h = canvas.height;
            if (w === 0 || h === 0) { this._compareRaf = requestAnimationFrame(render); return; }

            if (this._compareFilterDirty) {
                this._compareFilterDirty = false;
                const el = zoomView.querySelector('img');
                if (el) {
                    filterValue = getComputedStyle(el).filter;
                    if (el.src !== currentEditedSrc) {
                        currentEditedSrc = el.src;
                        editImg.src = currentEditedSrc;
                    }
                }
            }

            if (!editImg.complete || editImg.naturalWidth === 0) {
                this._compareRaf = requestAnimationFrame(render);
                return;
            }

            ctx.clearRect(0, 0, w, h);

            // Espace ÉCRAN : getImageRect() est déjà transform-aware (coords
            // écran du contenu image, incluant tx/ty/scale). On dessine SANS
            // ctx.translate/scale pour ne PAS compter le transform deux fois
            // (bug double-transform : getImageRect + ctx transform). La souris
            // (mouseX, coords écran du canvas) vit dans le MÊME espace.
            const vp = this._activeViewport();
            let ox = 0, oy = 0, dw = w, dh = h;
            if (vp) {
                const rect = vp.getImageRect();
                ox = rect.x; oy = rect.y; dw = rect.width; dh = rect.height;
            }

            // VAGUE 10 : la boîte commune (ox,oy,dw,dh) est le rect du média
            // COURANT (editImg). Si l'original et l'édité ont des ratios
            // différents (ex. après un crop qui change les dimensions
            // naturelles), dessiner les deux dans la même boîte étire l'un des
            // deux. On letterboxe CHAQUE média (contain centré) dans la boîte
            // commune — le transform du viewport n'est appliqué qu'une seule
            // fois (via getImageRect).
            const origRect = this._containRect(origImg, ox, oy, dw, dh);
            const editRect = this._containRect(editImg, ox, oy, dw, dh);

            ctx.save();
            ctx.drawImage(origImg, origRect.x, origRect.y, origRect.w, origRect.h);

            if (isOver && mouseX !== null) {
                const localMouseX = mouseX; // coords écran (même espace que le dessin)
                ctx.save();
                ctx.beginPath();
                ctx.rect(ox, oy, Math.max(0, localMouseX - ox), dh);
                ctx.clip();
                ctx.filter = filterValue;
                ctx.drawImage(editImg, editRect.x, editRect.y, editRect.w, editRect.h);
                ctx.filter = 'none';
                ctx.restore();

                if (localMouseX >= ox && localMouseX <= ox + dw) {
                    ctx.beginPath();
                    ctx.moveTo(localMouseX, oy);
                    ctx.lineTo(localMouseX, oy + dh);
                    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
                    ctx.lineWidth = 2;
                    ctx.globalCompositeOperation = 'difference';
                    ctx.stroke();
                    ctx.globalCompositeOperation = 'source-over';
                }
            }
            ctx.restore();
            this._compareRaf = requestAnimationFrame(render);
        };
        render();
    }

    // VAGUE 10 : rect « contain » (letterbox centré) d'un média dans une boîte
    // commune (ox,oy,dw,dh). Chaque média est dessiné avec son propre aspect
    // préservé — aucun étirement quand les ratios diffèrent (ex. après crop).
    _containRect(img, ox, oy, dw, dh) {
        const iw = (img && img.naturalWidth) || 1;
        const ih = (img && img.naturalHeight) || 1;
        const s = Math.min(dw / iw, dh / ih);
        const w = iw * s;
        const h = ih * s;
        return { x: ox + (dw - w) / 2, y: oy + (dh - h) / 2, w, h };
    }

    _compareCleanup() {
        const canvas = document.getElementById('holaf-compare-canvas');
        if (canvas) canvas.remove();
        if (this._compareRaf) { cancelAnimationFrame(this._compareRaf); this._compareRaf = null; }
        if (this._compareResizeObserver) { this._compareResizeObserver.disconnect(); this._compareResizeObserver = null; }
        if (this._compareCleanups) { this._compareCleanups.forEach(fn => fn()); this._compareCleanups = null; }
        this._compareFilterDirty = false;
        const cb = this.panelEl?.querySelector('#holaf-editor-compare-check');
        if (cb && cb.checked) cb.checked = false;
    }
}
