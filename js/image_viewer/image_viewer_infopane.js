/*
 * Copyright (C) 2025 Holaf
 * Holaf Utilities - Image Viewer Info Pane Module
 *
 * ADAPTATEUR vers la brique VENDUE js/vendor/holaf/holaf-infopane.js
 * (HolafInfoPane). Ce fichier ne porte plus la mécanique générique du volet
 * (états vide/chargement/erreur, champs, blocs copiables, auto-resize des
 * textarea, bouton copier avec confirmation puis retour, annulation de la
 * requête précédente via AbortSignal) : elle est désormais dans la brique.
 *
 * Il ne garde que le MÉTIER de la galerie du node :
 *   - l'endpoint /holaf/images/metadata et les sources internal_png /
 *     external_json / external_txt ;
 *   - la mise en forme des champs (nom, dossier, chemin d'origine, taille,
 *     format, modifié, résolution, ratio) ;
 *   - les blocs prompt/workflow (libellés i18n FR/EN existants) ;
 *   - le bouton « Load workflow » (comfyApp.loadGraphData ou holafBridge vers
 *     la fenêtre principale) et sa confirmation via AIH.ask ;
 *   - le preview synchrone (infos déjà connues de l'item) pour garder
 *     l'affichage instantané historique avant la réponse des métadonnées ;
 *   - le scope Ctrl+A (garde-fou contre le handler global de ComfyUI).
 *
 * RÈGLE : toute correction GÉNÉRIQUE se fait dans holaf-lib puis se re-vend via
 * `scripts/holaf` ; ce fichier ne doit contenir que du métier node/ComfyUI.
 */

import "../aih_strings.js";
import { imageViewerState } from './image_viewer_state.js';
import { holafBridge } from "../holaf_comfy_bridge.js";
import { app as comfyApp } from "../holaf_api_compat.js";
import { HolafFetch, HolafFetchError } from "../vendor/holaf/holaf-fetch.js";
import { showToast } from "../aih_toast_bridge.js";
import { HolafInfoPane } from "../vendor/holaf/holaf-infopane.js";

// Helper i18n central : traduit via AIH.I18n (clé brute si absente).
const t = (key, params) => {
    const I = window.AIH && window.AIH.I18n;
    return I && typeof I.t === "function" ? I.t(key, params) : key;
};

// FIX: Scope Ctrl+A (Select All) to the focused textarea within the viewer,
// instead of letting ComfyUI's global handler select the entire page.
// This listener is registered once at module load and uses event delegation.
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) {
        const target = e.target;
        if (target && target.tagName === 'TEXTAREA' && target.closest('#holaf-viewer-info-content')) {
            e.stopPropagation();
            e.target.select();
        }
    }
}, true); // capture: true to intercept before ComfyUI's handler

const INFO_CONTENT_ID = 'holaf-viewer-info-content';

// Instance unique du panneau pour la galerie (recréée si setupInfoPane est
// rappelé) + dédoublonnage de l'item déjà traité (comportement historique).
let infoPane = null;
let lastProcessedPath = null;

// ─── Libellés (parité FR/EN via AIH.I18n ; recalculés à chaque show pour
//     suivre un éventuel changement de langue) ────────────────────────────
function buildLabels() {
    return {
        copy: t('iv.copyPrompt'),
        copied: t('iv.copied'),
        copyFailed: t('iv.copyFailed'),
        loading: t('iv.loadingMetadata'),
        selectItem: t('iv.selectImageDetails'),
        notAvailable: t('iv.notAvailable'),
        error: t('iv.errorLabel'),
    };
}

// ─── Champs métier (mêmes libellés que l'ancien rendu) ──────────────────────
function buildFields(image) {
    const fields = [];
    fields.push({ label: t('iv.filename'), value: image.filename, stacked: true });
    fields.push({ label: t('iv.folder'), value: image.subfolder || '/' });
    if (image.is_trashed && image.original_path_canon) {
        fields.push({ label: t('iv.originalPath'), value: image.original_path_canon, stacked: true });
    }
    const bytes = Number(image.size_bytes);
    if (Number.isFinite(bytes)) {
        fields.push({ label: t('iv.sizeLabel'), value: `${(bytes / 1048576).toFixed(2)} MB` });
    }
    if (image.format) {
        fields.push({ label: t('iv.formatLabel'), value: image.format });
    }
    const mtime = Number(image.mtime);
    if (Number.isFinite(mtime)) {
        fields.push({ label: t('iv.modified'), value: new Date(mtime * 1000).toLocaleString(), stacked: true });
    }
    return fields;
}

// Badge de provenance du prompt/du workflow (sources du backend).
function getSourceLabel(source) {
    return {
        "external_txt": t('iv.fromTxt'),
        "external_json": t('iv.fromJson'),
        "internal_png": t('iv.fromPng'),
    }[source] || "";
}

// ─── Blocs prompt/workflow (le bouton « Load workflow » reste métier) ───────
async function onLoadWorkflow(workflow) {
    if (comfyApp && typeof comfyApp.loadGraphData === 'function') {
        // Onglet principal : chargement direct.
        comfyApp.loadGraphData(workflow);
    } else {
        // Mode autonome/déporté : envoi via le bridge.
        holafBridge.send('LOAD_WORKFLOW', workflow);
        showToast({ message: t('iv.workflowSentToMain'), type: "success" });
    }
}

function buildBlocks(data) {
    const blocks = [];

    const promptText = data.prompt ? String(data.prompt).trim() : '';
    blocks.push({
        id: 'prompt',
        label: t('iv.prompt'),
        source: getSourceLabel(data.prompt_source),
        text: promptText,
        copyable: true,
        copyDisabled: !data.prompt,
        copyPlacement: 'before',
        copyLabel: t('iv.copyPrompt'),
        empty: t('iv.notAvailable'),
    });

    const workflow = data.workflow;
    const workflowError = workflow && workflow.error ? String(workflow.error) : null;
    const canLoad = !!workflow && !workflowError;
    const workflowBlock = {
        id: 'workflow',
        label: t('iv.workflow'),
        source: getSourceLabel(data.workflow_source),
        text: canLoad ? JSON.stringify(workflow, null, 2) : '',
        copyable: canLoad,
        copyLabel: t('iv.copyWorkflow'),
        actions: [{
            id: 'load-workflow',
            label: t('iv.loadWorkflow'),
            disabled: !canLoad,
            confirm: { title: t('iv.loadWorkflowTitle'), message: t('iv.loadWorkflowMsg') },
            onClick: () => onLoadWorkflow(workflow),
        }],
    };
    if (workflowError) {
        workflowBlock.error = t('iv.errorWorkflow', { error: workflowError });
    } else if (!workflow) {
        workflowBlock.empty = t('iv.noWorkflowFound');
    }
    blocks.push(workflowBlock);

    return blocks;
}

// ─── Preview synchrone : infos déjà connues de l'item (affichage immédiat) ──
function previewImageInfo(image) {
    if (!image) return null;
    return { fields: buildFields(image) };
}

// ─── Confirmation du chargement de workflow (AIH.ask, comme avant) ──────────
function confirmLoadWorkflow(req) {
    return AIH.ask({
        title: req.title,
        message: req.message,
        buttons: [{ text: t('iv.cancel'), value: false }, { text: t('iv.load'), value: true }],
    });
}

// ─── Résolution métier : endpoint /holaf/images/metadata ────────────────────
async function resolveImageInfo(image, { signal } = {}) {
    const fields = buildFields(image);
    try {
        const metadataUrl = new URL(window.location.origin);
        metadataUrl.pathname = '/holaf/images/metadata';
        metadataUrl.search = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '' });

        // HolafFetch : GET JSON parsé ; lève sur non-2xx/non-JSON → mappé sur
        // l'affichage d'erreur historique ci-dessous.
        const data = await HolafFetch.get(metadataUrl.href, { signal, cache: 'no-store' });
        if (signal && signal.aborted) return null;

        if (data.width && data.height) fields.push({ label: t('iv.resolution'), value: `${data.width}x${data.height} px` });
        if (data.ratio) fields.push({ label: t('iv.ratio'), value: data.ratio });
        return { fields, blocks: buildBlocks(data) };
    } catch (err) {
        // Annulation (nouvelle image affichée) : silencieux, comme avant.
        // (HolafFetch encapsule l'AbortError → on teste le signal, pas err.name.)
        if (signal && signal.aborted) return null;
        if (err && err.name === 'AbortError') return { fields, blocks: [] };
        if (err instanceof HolafFetchError && err.status >= 400) {
            // Non-2xx : même message que l'ancien test !response.ok
            // (message du corps JSON s'il existe).
            return { fields, blocks: [], error: err.data?.error || t('iv.unknownError') };
        }
        console.error("Metadata fetch error:", err);
        return { fields, blocks: [], error: t('iv.fetchMetadataFailed') };
    }
}

/**
 * Initializes the info pane to subscribe to state changes.
 */
export function setupInfoPane() {
    const container = document.getElementById(INFO_CONTENT_ID);
    if (!container) return;

    if (infoPane) {
        try { infoPane.destroy(); } catch (e) { /* ignore */ }
        infoPane = null;
    }
    // Retire le message statique initial de l'UI (la brique le remplace).
    container.textContent = '';

    infoPane = HolafInfoPane.create(container, {
        labels: buildLabels(),
        preview: previewImageInfo,
        resolve: resolveImageInfo,
        confirm: confirmLoadWorkflow,
    });

    imageViewerState.subscribe(newState => {
        const activeImage = newState.activeImage;
        const activeImagePath = activeImage ? activeImage.path_canon : null;

        if (activeImagePath !== lastProcessedPath) {
            lastProcessedPath = activeImagePath;
            // Recalcule les libellés (changement de langue éventuel).
            infoPane.setLabels(buildLabels());
            infoPane.show(activeImage);
        }
    });
}
