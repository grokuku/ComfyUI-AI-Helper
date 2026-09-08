/*
 * Copyright (C) 2025 Holaf
 * Holaf Utilities - Image Viewer Actions Module
 *
 * This module handles the logic for user actions like deleting, restoring,
 * and managing metadata for selected images.
 * REFACTOR: Updated to use the central imageViewerState.
 * CORRECTIF: Actions now correctly target the active image in zoom/fullscreen view.
 * FEATURE: Added a confirmation dialog for exporting when there are unsaved edits.
 * MODIFICATION: Made the export dialog fully keyboard-navigable with 2D-aware controls.
 * BUGFIX: The delete operation now provides detailed feedback from the backend, especially on failure.
 */

import "../aih_strings.js";
import { HolafPanelManager, dialogState } from "../holaf_panel_manager.js";
import { imageViewerState } from "./image_viewer_state.js";
import { showToast, updateToast, hideToast } from "../aih_toast_bridge.js";

// Helper i18n central : traduit via AIH.I18n (clé brute si absente).
const t = (key, params) => {
    const I = window.AIH && window.AIH.I18n;
    return I && typeof I.t === "function" ? I.t(key, params) : key;
};

// --- CORRECTIF : Nouvelle fonction d'aide pour déterminer la cible des actions ---
/**
 * Determines the target images for an action based on the current view mode.
 * @returns {object[]} An array of image objects to be processed.
 */
function _getTargets() {
    const state = imageViewerState.getState();
    const viewMode = state.ui.view_mode;

    if (viewMode === 'zoom' || viewMode === 'fullscreen') {
        // En vue zoom ou plein écran, la cible est l'image active.
        return state.activeImage ? [state.activeImage] : [];
    }
    
    // Sinon, en vue galerie, la cible est la sélection multiple.
    return Array.from(state.selectedImages);
}


/**
 * Attaches click listeners to the main action buttons.
 * @param {object} viewer - The main image viewer instance.
 */
export function attachActionListeners(viewer) {
    const btnDelete = document.getElementById('holaf-viewer-btn-delete');
    const btnRestore = document.getElementById('holaf-viewer-btn-restore');
    const btnExtract = document.getElementById('holaf-viewer-btn-extract');
    const btnInject = document.getElementById('holaf-viewer-btn-inject');
    const btnExport = document.getElementById('holaf-viewer-btn-export');
    const btnImport = document.getElementById('holaf-viewer-btn-import');

    if (btnDelete) btnDelete.onclick = () => handleDelete(viewer);
    if (btnRestore) btnRestore.onclick = () => handleRestore(viewer);
    if (btnExtract) btnExtract.onclick = () => handleExtractMetadata(viewer);
    if (btnInject) btnInject.onclick = () => handleInjectMetadata(viewer);
    if (btnExport) btnExport.onclick = () => handleExport(viewer);
}

/**
 * Updates the enabled/disabled state of action buttons based on the current selection.
 * @param {object} viewer - The main image viewer instance.
 */
export function updateActionButtonsState(viewer) {
    // CORRECTIF : Utiliser _getTargets() pour obtenir les images concernées.
    const targetImages = _getTargets();

    const btnDelete = document.getElementById('holaf-viewer-btn-delete');
    const btnRestore = document.getElementById('holaf-viewer-btn-restore');
    const btnExtract = document.getElementById('holaf-viewer-btn-extract');
    const btnInject = document.getElementById('holaf-viewer-btn-inject');
    const btnExport = document.getElementById('holaf-viewer-btn-export');
    const btnImport = document.getElementById('holaf-viewer-btn-import');

    const hasSelection = targetImages.length > 0;
    const hasPngSelection = hasSelection && targetImages.some(img => img.format.toLowerCase() === 'png');

    let canRestore = false;
    if (hasSelection) {
        canRestore = targetImages.every(img => img.is_trashed);
    }
    const canPerformNonTrashActions = hasSelection && targetImages.every(img => !img.is_trashed);

    if (btnDelete) btnDelete.disabled = !canPerformNonTrashActions;
    if (btnRestore) btnRestore.disabled = !canRestore;
    if (btnExtract) btnExtract.disabled = !canPerformNonTrashActions || !hasPngSelection;
    if (btnInject) btnInject.disabled = !canPerformNonTrashActions || !hasPngSelection;
    if (btnExport) btnExport.disabled = !canPerformNonTrashActions;
    if (btnImport) btnImport.disabled = true;
}

/**
 * Handles deletion of selected images, with an option for permanent deletion.
 * @param {object} viewer - The main image viewer instance.
 * @param {boolean} [permanent=false] - If true, permanently deletes files.
 * @param {object[]|null} [imagesToProcess=null] - Specific images to delete. If null, uses context-aware targets.
 * @returns {Promise<boolean>} True if the operation was successful and caused changes, otherwise false.
 */
export async function handleDeletion(viewer, permanent = false, imagesToProcess = null) {
    const imagesForDeletion = imagesToProcess || _getTargets();
    if (imagesForDeletion.length === 0) return false;
    
    const isAnyFileTrashed = imagesForDeletion.some(img => img.is_trashed);
    if (isAnyFileTrashed) {
        AIH.ask({
            title: t("iv.actionNotAllowed"),
            message: t("iv.actionNotAllowedMsg"),
            buttons: [{ text: t("iv.ok") }],
            parentElement: document.body
        });
        return false;
    }

    const pathsToDelete = imagesForDeletion.map(img => img.path_canon);
    const dialogTitle = permanent ? t("iv.confirmPermanentDeletion") : t("iv.confirmDelete");
    const dialogMessage = permanent 
        ? t("iv.confirmPermanentDeleteMsg", { count: imagesForDeletion.length })
        : t("iv.confirmDeleteMsg", { count: imagesForDeletion.length });
    const confirmButtonText = permanent ? t("iv.permanentlyDelete") : t("iv.delete");

    const confirmed = await AIH.ask({
        title: dialogTitle,
        message: dialogMessage,
        buttons: [
            { text: t("iv.cancel"), value: false, type: "cancel" },
            { text: confirmButtonText, value: true, type: "danger" }
        ],
        parentElement: document.body
    });

    if (!confirmed) return false;

    try {
        const apiUrl = permanent ? "/holaf/images/delete-permanently" : "/holaf/images/delete";
        const response = await fetch(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paths_canon: pathsToDelete })
        });
        const result = await response.json();

        if (response.ok || response.status === 207) {
            let finalMessage = result.message || t('iv.operationProcessed');
            let dialogTitle = t("iv.operationComplete");
            let showDialog = false;

            // BUGFIX: Always check for details first and build a detailed message.
            if (result.details && result.details.length > 0) {
                const errorDetails = result.details.map(d => `• <strong>${d.path.split('/').pop()}</strong>:<br>  ${d.error}`).join('<br>');
                finalMessage += `<br><br>${t('iv.errorDetails')}<br>${errorDetails}`;
                dialogTitle = t("iv.deletionError");
                showDialog = true;
            }

            // If files were successfully deleted, show a success toast.
            // If some failed, the dialog above will still show the errors.
            if (result.deleted_count > 0) {
                showToast({
                    message: t('iv.movedToTrash', { count: result.deleted_count }),
                    type: 'success'
                });
            } else if (!showDialog) {
                // If NO files were deleted AND there were NO errors, show the generic dialog.
                showDialog = true;
            }

            if (showDialog) {
                AIH.ask({
                    title: dialogTitle,
                    message: finalMessage,
                    html: true,           // finalMessage contient <strong>/<br>
                    maxWidth: 620,        // les détails d'erreurs ont besoin de place
                    buttons: [{ text: t("iv.ok") }],
                    parentElement: document.body
                });
            }
            
            // Refresh the UI only if at least one file was successfully deleted.
            return result.deleted_count > 0;

        } else {
            // Handle fatal server errors (5xx, etc.)
            AIH.ask({
                title: t("iv.serverError"),
                message: t('iv.deleteFailed', { message: result.message || t('iv.unknownServerError') }),
                buttons: [{ text: t("iv.ok") }],
                parentElement: document.body
            });
            return false;
        }
    } catch (error) {
        console.error("[Holaf ImageViewer] Error calling delete API:", error);
        AIH.ask({
            title: t("iv.apiError"),
            message: t('iv.apiErrorDeleteMsg', { message: error.message }),
            buttons: [{ text: t("iv.ok") }],
            parentElement: document.body
        });
        return false;
    }
}


/**
 * Handles the "Delete" button click. Now a wrapper around handleDeletion.
 * @param {object} viewer - The main image viewer instance.
 */
export async function handleDelete(viewer) {
    const success = await handleDeletion(viewer, false);
    if (!success) return;

    // Resynchronisation complète : recharge la fenêtre 0 + total_count et
    // vide le cache de fenêtres via resetWindowCache() dans loadFilteredImages().
    imageViewerState.setState({
        selectedImages: new Set(),
        activeImage: null,
        currentNavIndex: -1
    });
    await viewer.loadFilteredImages();
}

/**
 * Handles the "Restore" action for selected images.
 * @param {object} viewer - The main image viewer instance.
 */
export async function handleRestore(viewer) {
    // CORRECTIF : Utiliser _getTargets() pour obtenir les images concernées.
    const imagesToRestore = _getTargets();
    if (imagesToRestore.length === 0) return;
    const pathsToRestore = imagesToRestore.map(img => img.path_canon);

    if (await AIH.ask({
        title: t("iv.confirmRestore"),
        message: t('iv.confirmRestoreMsg', { count: imagesToRestore.length }),
        buttons: [
            { text: t("iv.cancel"), value: false, type: "cancel" },
            { text: t("iv.restore"), value: true, type: "confirm" }
        ],
        parentElement: document.body
    })) {
        try {
            const response = await fetch("/holaf/images/restore", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ paths_canon: pathsToRestore })
            });
            const result = await response.json();

            if (response.ok || response.status === 207) {
                AIH.ask({
                    title: t("iv.restoreOperation"),
                    message: result.message || t('iv.restoreProcessed'),
                    buttons: [{ text: t("iv.ok"), value: true }],
                    parentElement: document.body
                });
                imageViewerState.setState({
                    selectedImages: new Set(),
                    activeImage: null,
                    currentNavIndex: -1
                });
                viewer.loadFilteredImages();
            } else {
                AIH.ask({
                    title: t("iv.restoreError"),
                    message: t('iv.restoreFailed', { message: result.message || t('iv.unknownServerError') }),
                    buttons: [{ text: t("iv.ok"), value: true }],
                    parentElement: document.body
                });
            }
        } catch (error) {
            console.error("[Holaf ImageViewer] Error calling restore API:", error);
            AIH.ask({
                title: t("iv.apiError"),
                message: t('iv.apiErrorRestoreMsg', { message: error.message }),
                buttons: [{ text: t("iv.ok"), value: true }],
                parentElement: document.body
            });
        }
    }
}

/**
 * Processes the next conflict in the viewer's conflict queue for metadata operations.
 * @param {object} viewer - The main image viewer instance.
 * @param {string} operation - The name of the operation ('extract' or 'inject').
 */
async function processNextConflict(viewer, operation) {
    if (!viewer.conflictQueue || viewer.conflictQueue.length === 0) {
        viewer.isProcessingConflicts = false;
        const opDisplay = operation === 'extract' ? t('iv.opExtraction') : t('iv.opInjection');
        AIH.ask({
            title: t("iv.processFinished"),
            message: t('iv.allMetadataProcessed', { op: opDisplay.toLowerCase() }),
            buttons: [{ text: t("iv.ok") }],
            parentElement: document.body
        });
        viewer.loadFilteredImages(); // Refresh the gallery
        return;
    }

    viewer.isProcessingConflicts = true;
    const conflict = viewer.conflictQueue.shift();
    const filename = conflict.path.split('/').pop();

    const choice = await AIH.ask({
        title: t('iv.conflictOn', { filename }),
        message: t('iv.conflictMsg', { filename, error: conflict.error, details: (conflict.details || []).join("\n") }),
        buttons: [
            { text: t('iv.skip'), value: 'skip', type: 'cancel' },
            { text: t('iv.cancelAll'), value: 'cancel_all' },
            { text: t('iv.overwrite'), value: 'overwrite', type: 'danger' },
        ],
        parentElement: document.body
    });

    if (choice === 'overwrite') {
        try {
            const apiUrl = `/holaf/images/${operation}-metadata`;
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paths_canon: [conflict.path], force: true })
            });
            const result = await response.json();
            if (!response.ok || result.results?.failures?.length > 0) {
                const errorMsg = result.results?.failures[0]?.error || result.message || t('iv.unknownErrorDuringOverwrite');
                AIH.ask({ title: t('iv.errorOverwriting', { filename }), message: errorMsg, parentElement: document.body });
            }
        } catch (e) {
             AIH.ask({ title: t('iv.apiError'), message: t('iv.overwriteFailed', { filename, message: e.message }), parentElement: document.body });
        }
    } else if (choice === 'cancel_all') {
        viewer.conflictQueue = [];
    }
    await processNextConflict(viewer, operation);
}


/**
 * Handles the "Extract Metadata" action. Extracts embedded metadata from PNGs to sidecar files.
 * @param {object} viewer - The main image viewer instance.
 */
export async function handleExtractMetadata(viewer) {
    if (viewer.isProcessingConflicts) {
        AIH.ask({ title: t("iv.processBusy"), message: t("iv.processBusyMsg"), parentElement: document.body });
        return;
    }

    // CORRECTIF : Utiliser _getTargets() pour obtenir les images concernées.
    const targetImages = _getTargets();
    const pngImages = targetImages.filter(img => img.format.toLowerCase() === 'png');

    if (pngImages.length === 0) {
        AIH.ask({
            title: t("iv.invalidSelection"),
            message: t("iv.extractPngOnlyMsg"),
            buttons: [{ text: t("iv.ok") }],
            parentElement: document.body
        });
        return;
    }

    const pathsToProcess = pngImages.map(img => img.path_canon);

    try {
        const response = await fetch('/holaf/images/extract-metadata', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths_canon: pathsToProcess, force: false })
        });
        const result = await response.json();

        if (!response.ok) throw new Error(result.message || `Server returned status ${response.status}`);
        
        viewer.conflictQueue = result.results?.conflicts || [];
        viewer.isProcessingConflicts = false;

        const successes = result.results?.successes || [];
        const failures = result.results?.failures || [];
        
        if (failures.length > 0) {
            const failureMessage = failures.map(f => `- ${f.path.split('/').pop()}: ${f.error}`).join('\n');
            AIH.ask({
                title: t("iv.extractionErrors"),
                message: t('iv.extractionFailedMsg', { list: failureMessage }),
                buttons: [{ text: t("iv.ok") }], parentElement: document.body
            });
        }
        
        if (viewer.conflictQueue.length > 0) {
            processNextConflict(viewer, 'extract');
        } else {
            if (successes.length > 0 && failures.length === 0) {
                 AIH.ask({
                    title: t("iv.extractionComplete"),
                    message: t('iv.extractionCompleteMsg', { count: successes.length }),
                    buttons: [{ text: t("iv.ok") }], parentElement: document.body
                });
            }
            viewer.loadFilteredImages();
        }
    } catch (error) {
        console.error("[Holaf ImageViewer] Error calling extract API:", error);
        AIH.ask({
            title: t("iv.apiError"),
            message: t('iv.apiErrorExtractMsg', { message: error.message }),
            buttons: [{ text: t("iv.ok") }], parentElement: document.body
        });
    }
}

/**
 * Handles the "Inject Metadata" action. Injects sidecar metadata into PNG files.
 * @param {object} viewer - The main image viewer instance.
 */
export async function handleInjectMetadata(viewer) {
    if (viewer.isProcessingConflicts) {
        AIH.ask({ title: t("iv.processBusy"), message: t("iv.processBusyMsg"), parentElement: document.body });
        return;
    }

    // CORRECTIF : Utiliser _getTargets() pour obtenir les images concernées.
    const targetImages = _getTargets();
    const pngImages = targetImages.filter(img => img.format.toLowerCase() === 'png');

    if (pngImages.length === 0) {
        AIH.ask({
            title: t("iv.invalidSelection"),
            message: t("iv.injectPngOnlyMsg"),
            buttons: [{ text: t("iv.ok") }], parentElement: document.body
        });
        return;
    }
    
    const pathsToProcess = pngImages.map(img => img.path_canon);

    try {
        const response = await fetch('/holaf/images/inject-metadata', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths_canon: pathsToProcess, force: false })
        });
        const result = await response.json();

        if (!response.ok) throw new Error(result.message || `Server returned status ${response.status}`);
        
        viewer.conflictQueue = result.results?.conflicts || [];
        viewer.isProcessingConflicts = false;

        const successes = result.results?.successes || [];
        const failures = result.results?.failures || [];

        if (failures.length > 0) {
            const failureMessage = failures.map(f => `- ${f.path.split('/').pop()}: ${f.error}`).join('\n');
            AIH.ask({
                title: t("iv.injectionErrors"),
                message: t('iv.injectionFailedMsg', { list: failureMessage }),
                buttons: [{ text: t("iv.ok") }], parentElement: document.body
            });
        }
        
        if (viewer.conflictQueue.length > 0) {
            processNextConflict(viewer, 'inject');
        } else {
            if (successes.length > 0 && failures.length === 0) {
                 AIH.ask({
                    title: t("iv.injectionComplete"),
                    message: t('iv.injectionCompleteMsg', { count: successes.length }),
                    buttons: [{ text: t("iv.ok") }], parentElement: document.body
                });
            }
            viewer.loadFilteredImages();
        }

    } catch (error) {
        console.error("[Holaf ImageViewer] Error calling inject API:", error);
        AIH.ask({
            title: t("iv.apiError"),
            message: t('iv.apiErrorInjectMsg', { message: error.message }),
            buttons: [{ text: t("iv.ok") }], parentElement: document.body
        });
    }
}

/**
 * Shows the export options dialog.
 * @param {object} viewer - The main image viewer instance.
 * @param {object[]} imagesToExport - The array of image objects to export.
 */
function _showExportOptionsDialog(viewer, imagesToExport) {
    dialogState.openCount++; // Block main viewer keyboard shortcuts

    const overlay = document.createElement('div');
    overlay.id = 'holaf-viewer-export-dialog-overlay';
    
    const imageCount = imagesToExport.length;
    const savedSettings = viewer.settings;
    
    // --- MODIFICATION: Format Filter Logic ---
    const hasVideo = imagesToExport.some(img => ['MP4', 'WEBM'].includes(img.format));
    const hasAudio = imagesToExport.some(img => ['WAV', 'MP3', 'OGG', 'FLAC', 'AAC', 'M4A'].includes(img.format));
    const hasImage = imagesToExport.some(img => !['MP4', 'WEBM', 'WAV', 'MP3', 'OGG', 'FLAC', 'AAC', 'M4A'].includes(img.format));
    
    // Determine default based on content type
    let defaultFormat = savedSettings.export_format;
    if (hasVideo && !['mp4', 'gif'].includes(defaultFormat)) {
        defaultFormat = 'mp4';
    } else if (hasAudio && !['wav', 'mp3'].includes(defaultFormat)) {
        defaultFormat = 'wav';
    } else if (!hasVideo && !hasAudio && hasImage && ['mp4', 'gif', 'wav', 'mp3'].includes(defaultFormat)) {
        defaultFormat = 'png';
    }

    let formatOptionsHTML = '';
    
    if (hasImage) {
        formatOptionsHTML += `
            <label><input type="radio" name="export-format" value="png" ${defaultFormat === 'png' ? 'checked' : ''}> PNG</label>
            <label><input type="radio" name="export-format" value="jpg" ${defaultFormat === 'jpg' ? 'checked' : ''}> JPG</label>
            <label><input type="radio" name="export-format" value="tiff" ${defaultFormat === 'tiff' ? 'checked' : ''}> TIFF</label>
        `;
    }
    
    if (hasVideo) {
        formatOptionsHTML += `
            <label><input type="radio" name="export-format" value="mp4" ${defaultFormat === 'mp4' ? 'checked' : ''}> MP4</label>
            <label><input type="radio" name="export-format" value="gif" ${defaultFormat === 'gif' ? 'checked' : ''}> GIF</label>
        `;
    }

    if (hasAudio) {
        formatOptionsHTML += `
            <label><input type="radio" name="export-format" value="wav" ${defaultFormat === 'wav' ? 'checked' : ''}> WAV</label>
            <label><input type="radio" name="export-format" value="mp3" ${defaultFormat === 'mp3' ? 'checked' : ''}> MP3</label>
        `;
    }
    // ------------------------------------------

    overlay.innerHTML = `
        <div id="holaf-viewer-export-dialog">
            <div class="holaf-viewer-export-header">
                ${t('iv.exportingItems', { count: imageCount })}
            </div>
            <div class="holaf-viewer-export-content">
                <div class="holaf-viewer-export-option-group">
                    <label>${t('iv.format')}</label>
                    <div class="holaf-export-choices">
                        ${formatOptionsHTML}
                    </div>
                </div>

                <!-- === QUALITY / COMPRESSION OPTIONS === -->
                <div id="holaf-export-quality-group" class="holaf-viewer-export-option-group">
                    <label>${t('iv.qualityCompression')}</label>
                    <div style="display: flex; flex-direction: column; gap: 8px;">
                        <!-- JPG Quality -->
                        <div id="holaf-export-jpg-quality-row" style="display: none; align-items: center; gap: 8px;">
                            <label style="min-width: 90px;">${t('iv.jpgQuality')}</label>
                            <input type="range" id="holaf-export-jpg-quality" min="1" max="100" value="95" style="flex:1;">
                            <span id="holaf-export-jpg-quality-val" style="min-width: 32px; text-align: right;">95</span>
                        </div>
                        <!-- MP4 CRF -->
                        <div id="holaf-export-mp4-crf-row" style="display: none; align-items: center; gap: 8px; flex-wrap: wrap;">
                            <label style="min-width: 90px;">${t('iv.mp4Quality')}</label>
                            <input type="range" id="holaf-export-mp4-crf" min="0" max="51" value="23" style="flex:1; min-width: 80px;">
                            <span id="holaf-export-mp4-crf-val" style="min-width: 32px; text-align: right;">23</span>
                            <select id="holaf-export-mp4-codec" style="width: 90px;" title="${t('iv.videoCodec')}">
                                <option value="libx264" selected>H.264</option>
                                <option value="libx265">H.265</option>
                                <option value="libsvtav1">AV1</option>
                            </select>
                            <select id="holaf-export-mp4-preset" style="width: 100px;" title="${t('iv.encodingPreset')}">
                                <option value="ultrafast">Ultrafast</option>
                                <option value="superfast">Superfast</option>
                                <option value="veryfast">Veryfast</option>
                                <option value="faster">Faster</option>
                                <option value="fast" selected>Fast</option>
                                <option value="medium">Medium</option>
                                <option value="slow">Slow</option>
                            </select>
                        </div>
                        <!-- GIF FPS -->
                        <div id="holaf-export-gif-fps-row" style="display: none; align-items: center; gap: 8px;">
                            <label style="min-width: 90px;">${t('iv.gifFps')}</label>
                            <input type="range" id="holaf-export-gif-fps" min="1" max="30" value="15" style="flex:1;">
                            <span id="holaf-export-gif-fps-val" style="min-width: 32px; text-align: right;">15</span>
                        </div>
                        <!-- WAV/MP3 Info -->
                        <div id="holaf-export-audio-info-row" style="display: none;">
                            <span style="opacity: 0.6; font-size: 0.85em;">${t('iv.audioCopiedOrTranscoded')}</span>
                        </div>
                        <!-- MP3 Bitrate -->
                        <div id="holaf-export-mp3-bitrate-row" style="display: none; align-items: center; gap: 8px;">
                            <label style="min-width: 90px;">${t('iv.mp3Bitrate')}</label>
                            <input type="range" id="holaf-export-mp3-bitrate" min="64" max="320" value="192" step="32" style="flex:1;">
                            <span id="holaf-export-mp3-bitrate-val" style="min-width: 48px; text-align: right;">192kbps</span>
                        </div>
                        <!-- WAV Audio Info -->
                        <div id="holaf-export-wav-info-row" style="display: none;">
                            <span style="opacity: 0.6; font-size: 0.85em;">${t('iv.losslessAudio')}</span>
                        </div>
                        <!-- PNG/TIFF Info -->
                        <div id="holaf-export-png-info-row" style="display: none;">
                            <span style="opacity: 0.6; font-size: 0.85em;">${t('iv.losslessFormat')}</span>
                        </div>
                    </div>
                </div>

                <div class="holaf-viewer-export-option-group">
                    <label>${t('iv.metadata')}</label>
                    <div style="display: flex; flex-direction: column; gap: 10px;">
                        <label>
                            <input type="checkbox" id="holaf-export-include-meta" name="include-meta" ${savedSettings.export_include_meta ? 'checked' : ''}>
                            ${t('iv.includePromptWorkflow')}
                        </label>
                        <div id="holaf-export-meta-method-group" style="padding-left: 20px; display: flex; flex-direction: column; gap: 8px;">
                            <label><input type="radio" name="meta-method" value="embed" ${savedSettings.export_meta_method === 'embed' ? 'checked' : ''}> ${t('iv.embedInFile')}</label>
                            <label><input type="radio" name="meta-method" value="sidecar" ${savedSettings.export_meta_method === 'sidecar' ? 'checked' : ''}> ${t('iv.saveSidecar')}</label>
                        </div>
                    </div>
                </div>
            </div>
            <div class="holaf-viewer-export-footer">
                <button id="holaf-export-cancel-btn" class="comfy-button secondary">${t('iv.cancel')}</button>
                <button id="holaf-export-start-btn" class="comfy-button">${t('iv.addToExportQueue')}</button>
            </div>
        </div>
    `;

    viewer.panelElements.panelEl.appendChild(overlay);

    const includeMetaCheckbox = overlay.querySelector('#holaf-export-include-meta');
    const metaMethodGroup = overlay.querySelector('#holaf-export-meta-method-group');
    const toggleMetaMethod = () => {
        const isEnabled = includeMetaCheckbox.checked;
        metaMethodGroup.style.opacity = isEnabled ? '1' : '0.5';
        metaMethodGroup.style.pointerEvents = isEnabled ? 'auto' : 'none';
        setupKeyboardNavigation();
    };
    includeMetaCheckbox.addEventListener('change', toggleMetaMethod);

    // --- QUALITY / COMPRESSION DYNAMIC VISIBILITY ---
    const qualityGroup = overlay.querySelector('#holaf-export-quality-group');
    const jpgRow = overlay.querySelector('#holaf-export-jpg-quality-row');
    const mp4Row = overlay.querySelector('#holaf-export-mp4-crf-row');
    const gifRow = overlay.querySelector('#holaf-export-gif-fps-row');
    const wavInfoRow = overlay.querySelector('#holaf-export-wav-info-row');
    const mp3BitrateRow = overlay.querySelector('#holaf-export-mp3-bitrate-row');
    const pngInfoRow = overlay.querySelector('#holaf-export-png-info-row');
    const jpgSlider = overlay.querySelector('#holaf-export-jpg-quality');
    const jpgVal = overlay.querySelector('#holaf-export-jpg-quality-val');
    const crfSlider = overlay.querySelector('#holaf-export-mp4-crf');
    const crfVal = overlay.querySelector('#holaf-export-mp4-crf-val');
    const gifFpsSlider = overlay.querySelector('#holaf-export-gif-fps');
    const gifFpsVal = overlay.querySelector('#holaf-export-gif-fps-val');
    const mp3BitrateSlider = overlay.querySelector('#holaf-export-mp3-bitrate');
    const mp3BitrateVal = overlay.querySelector('#holaf-export-mp3-bitrate-val');

    jpgSlider.addEventListener('input', () => { jpgVal.textContent = jpgSlider.value; });
    crfSlider.addEventListener('input', () => { crfVal.textContent = crfSlider.value; });
    gifFpsSlider.addEventListener('input', () => { gifFpsVal.textContent = gifFpsSlider.value; });
    mp3BitrateSlider.addEventListener('input', () => { mp3BitrateVal.textContent = mp3BitrateSlider.value + 'kbps'; });

    const updateQualityVisibility = () => {
        const fmt = overlay.querySelector('input[name="export-format"]:checked')?.value || defaultFormat;
        jpgRow.style.display = (fmt === 'jpg') ? 'flex' : 'none';
        mp4Row.style.display = (fmt === 'mp4') ? 'flex' : 'none';
        gifRow.style.display = (fmt === 'gif') ? 'flex' : 'none';
        mp3BitrateRow.style.display = (fmt === 'mp3') ? 'flex' : 'none';
        wavInfoRow.style.display = (fmt === 'wav') ? 'block' : 'none';
        pngInfoRow.style.display = (fmt === 'png' || fmt === 'tiff') ? 'block' : 'none';
    };
    overlay.querySelectorAll('input[name="export-format"]').forEach(r => r.addEventListener('change', updateQualityVisibility));
    updateQualityVisibility();
    // ------------------------------------------

    // --- START: Keyboard Navigation Logic (v2 - 2D Aware) ---
    let focusableElements = [];
    let elementGrid = []; // A 2D array representing the layout
    let currentFocusCoords = { row: -1, col: -1 };

    const setupKeyboardNavigation = () => {
        const query = 'input[name="export-format"], #holaf-export-include-meta, input[name="meta-method"], #holaf-export-cancel-btn, #holaf-export-start-btn';
        const allElements = [...overlay.querySelectorAll(query)].filter(el => {
            // Filter out disabled elements
            const parentGroup = el.closest('#holaf-export-meta-method-group');
            return !(parentGroup && parentGroup.style.pointerEvents === 'none');
        });

        // The element we want to apply style/focus to is the label or the button itself.
        focusableElements = allElements.map(el => el.tagName === 'BUTTON' ? el : el.parentElement);

        // Group elements by row
        elementGrid = [];
        if (focusableElements.length > 0) {
            let currentRow = [];
            let lastY = focusableElements[0].getBoundingClientRect().top;
            focusableElements.forEach(el => {
                const elY = el.getBoundingClientRect().top;
                if (Math.abs(elY - lastY) > 10) { // Threshold for a new row
                    elementGrid.push(currentRow);
                    currentRow = [];
                }
                currentRow.push(el);
                lastY = elY;
            });
            elementGrid.push(currentRow); // Add the last row
        }

        // If the current focus is now invalid, reset it
        if (currentFocusCoords.row >= elementGrid.length || 
            (elementGrid[currentFocusCoords.row] && currentFocusCoords.col >= elementGrid[currentFocusCoords.row].length)) {
             const lastRow = elementGrid.length - 1;
             const lastCol = elementGrid[lastRow].length - 1;
             updateFocus(lastRow, lastCol);
        }
    };
    
    const updateFocus = (newRow, newCol) => {
        // Remove focus from old element
        if (currentFocusCoords.row > -1 && elementGrid[currentFocusCoords.row]?.[currentFocusCoords.col]) {
            elementGrid[currentFocusCoords.row][currentFocusCoords.col].classList.remove('holaf-dialog-item-focused');
        }
        
        // Clamp new coordinates and set focus
        const clampedRow = Math.max(0, Math.min(newRow, elementGrid.length - 1));
        const clampedCol = Math.max(0, Math.min(newCol, elementGrid[clampedRow].length - 1));
        
        const newFocusedEl = elementGrid[clampedRow][clampedCol];
        newFocusedEl.classList.add('holaf-dialog-item-focused');
        newFocusedEl.focus();
        currentFocusCoords = { row: clampedRow, col: clampedCol };
    };

    const handleKeyDown = (e) => {
        e.preventDefault();
        e.stopPropagation();

        const { row, col } = currentFocusCoords;

        switch(e.key) {
            case 'ArrowUp':
                if (row > 0) {
                    const currentElRect = elementGrid[row][col].getBoundingClientRect();
                    const prevRow = elementGrid[row - 1];
                    // Find the element in the previous row that's closest horizontally
                    let closestCol = 0;
                    let minDx = Infinity;
                    prevRow.forEach((el, index) => {
                        const dx = Math.abs(el.getBoundingClientRect().left - currentElRect.left);
                        if (dx < minDx) {
                            minDx = dx;
                            closestCol = index;
                        }
                    });
                    updateFocus(row - 1, closestCol);
                }
                break;
            case 'ArrowDown':
                if (row < elementGrid.length - 1) {
                    const currentElRect = elementGrid[row][col].getBoundingClientRect();
                    const nextRow = elementGrid[row + 1];
                    let closestCol = 0;
                    let minDx = Infinity;
                    nextRow.forEach((el, index) => {
                        const dx = Math.abs(el.getBoundingClientRect().left - currentElRect.left);
                        if (dx < minDx) {
                            minDx = dx;
                            closestCol = index;
                        }
                    });
                    updateFocus(row + 1, closestCol);
                }
                break;
            case 'ArrowRight':
                if (col < elementGrid[row].length - 1) {
                    updateFocus(row, col + 1);
                }
                break;
            case 'ArrowLeft':
                if (col > 0) {
                    updateFocus(row, col - 1);
                }
                break;
            case ' ':
            case 'Enter': {
                const focusedEl = elementGrid[row][col];
                if (focusedEl) {
                    (focusedEl.querySelector('input') || focusedEl).click();
                }
                break;
            }
            case 'Escape':
                cleanupAndClose();
                break;
        }
    };

    const cleanupAndClose = () => {
        document.removeEventListener('keydown', handleKeyDown, true);
        dialogState.openCount--;
        if(overlay) overlay.remove();
    };

    document.addEventListener('keydown', handleKeyDown, true);

    overlay.querySelector('#holaf-export-cancel-btn').addEventListener('click', cleanupAndClose);

    overlay.querySelector('#holaf-export-start-btn').addEventListener('click', async () => {
        // FIX: Capture form values BEFORE removing overlay to avoid null references on error
        const formatEl = overlay.querySelector('input[name="export-format"]:checked');
        const format = formatEl ? formatEl.value : 'png'; // Fallback
        const includeMeta = overlay.querySelector('#holaf-export-include-meta').checked;
        const metaMethod = includeMeta ? overlay.querySelector('input[name="meta-method"]:checked').value : null;

        // --- READ QUALITY / COMPRESSION SETTINGS ---
        const exportOptions = {};
        if (format === 'jpg') {
            exportOptions.jpg_quality = parseInt(overlay.querySelector('#holaf-export-jpg-quality').value);
        } else if (format === 'mp4') {
            exportOptions.crf = parseInt(overlay.querySelector('#holaf-export-mp4-crf').value);
            exportOptions.preset = overlay.querySelector('#holaf-export-mp4-preset').value;
            exportOptions.codec = overlay.querySelector('#holaf-export-mp4-codec').value;
        } else if (format === 'gif') {
            exportOptions.gif_fps = parseInt(overlay.querySelector('#holaf-export-gif-fps').value);
        } else if (format === 'mp3') {
            exportOptions.mp3_bitrate = parseInt(overlay.querySelector('#holaf-export-mp3-bitrate').value);
        }

        // Important: cleanup removes overlay from DOM, so all DOM reads must be done above
        cleanupAndClose();

        const toastId = `export-${Date.now()}`;
        
        if (!imageViewerState.getState().status.isExporting) {
            showToast({
                id: toastId, message: t('iv.preparingExport', { count: imageCount }),
                type: 'info', duration: 0, progress: 'manual'
            });
            imageViewerState.setState({ exporting: { activeToastId: toastId } });
        }
        
        viewer.saveSettings({
            export_format: format,
            export_include_meta: includeMeta,
            export_meta_method: metaMethod
        });
        
        const payload = {
            paths_canon: imagesToExport.map(img => img.path_canon),
            export_format: format,
            include_meta: includeMeta,
            meta_method: metaMethod,
            export_options: exportOptions
        };
        
        try {
            const response = await fetch('/holaf/images/prepare-export', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await response.json();

            if (!response.ok || result.status !== 'ok') {
                throw new Error(result.message || t('iv.failedToPrepareExport'));
            }
            
            if (result.errors && result.errors.length > 0) {
                 const errorMessage = t('iv.someFilesNotPrepared', { list: result.errors.map(e => `- ${e.path.split('/').pop()}: ${e.error}`).join('<br>') });
                 showToast({ message: errorMessage, type: 'error', duration: 0, html: true });
            }

            const manifestUrl = `/holaf/images/export-chunk?export_id=${result.export_id}&file_path=manifest.json&chunk_index=0&chunk_size=1000000`;
            const manifestResponse = await fetch(manifestUrl);
            const manifest = await manifestResponse.json();

            if (manifest && manifest.length > 0) {
                const newFiles = manifest.map(file => ({ ...file, export_id: result.export_id }));
                
                const oldState = imageViewerState.getState();
                const newQueue = [...oldState.exporting.queue, ...newFiles];
                const newTotalFiles = oldState.exporting.stats.totalFiles + newFiles.length;
                imageViewerState.setState({ exporting: { queue: newQueue, stats: { ...oldState.exporting.stats, totalFiles: newTotalFiles }}});

                const activeToastId = imageViewerState.getState().exporting.activeToastId;
                if (activeToastId) {
                    updateToast(activeToastId, {
                        message: t('iv.addedToQueue', { count: newFiles.length }),
                        type: 'info'
                    });
                }
                
                if (!imageViewerState.getState().status.isExporting) {
                    imageViewerState.setState({ status: { isExporting: true }});
                    viewer.updateStatusBar();
                    viewer.processExportDownloadQueue();
                } else {
                    viewer.updateStatusBar();
                }
            } else {
                 const activeToastId = imageViewerState.getState().exporting.activeToastId;
                 if (activeToastId) {
                     updateToast(activeToastId, {
                        message: t('iv.noNewFiles'),
                        type: 'info', progress: 100
                     });
                     setTimeout(() => hideToast(activeToastId), 5000);
                 }
                 if (!imageViewerState.getState().status.isExporting) viewer.updateStatusBar();
            }
        } catch (error) {
            console.error('[Holaf ImageViewer] Export preparation failed:', error);
            const activeToastId = imageViewerState.getState().exporting.activeToastId;
            if (activeToastId) {
                updateToast(activeToastId, {
                    message: t('iv.exportFailedStrong', { message: error.message }),
                    type: 'error', progress: 100, html: true
                });
            } else {
                showToast({ message: t('iv.exportFailed', { message: error.message }), type: 'error', duration: 0 });
            }
        }
    });

    toggleMetaMethod();
    setupKeyboardNavigation();
    const lastRow = elementGrid.length - 1;
    const lastCol = elementGrid.length > 0 ? elementGrid[lastRow].length - 1 : 0;
    updateFocus(lastRow, lastCol);
    // --- END: Keyboard Navigation Logic (v2) ---
}

/**
 * Handles the "Export" action, checking for unsaved changes first.
 * @param {object} viewer - The main image viewer instance.
 */
export async function handleExport(viewer) {
    const imagesToExport = _getTargets();
    if (imagesToExport.length === 0) return;

    const editor = viewer.editor;

    // Check if the currently edited image (if any) is part of the export batch and has unsaved changes.
    const activeImageHasUnsavedChanges = editor &&
                                         editor.hasUnsavedChanges() &&
                                         editor.activeImage &&
                                         imagesToExport.some(img => img.path_canon === editor.activeImage.path_canon);

    if (activeImageHasUnsavedChanges) {
        const choice = await AIH.ask({
            title: t("iv.unsavedChangesTitle"),
            message: t("iv.unsavedChangesMsg"),
            buttons: [
                { text: t("iv.cancel"), value: "cancel", type: "cancel" },
                { text: t("iv.exportWithoutSaving"), value: "export_without_saving" },
                { text: t("iv.saveAndExport"), value: "save_and_export", type: "confirm" }
            ],
            parentElement: viewer.panelElements.panelEl
        });

        switch (choice) {
            case "save_and_export":
                await editor.save(); // Await the save operation
                _showExportOptionsDialog(viewer, imagesToExport);
                break;
            case "export_without_saving":
                _showExportOptionsDialog(viewer, imagesToExport);
                break;
            case "cancel":
            default:
                return; // Do nothing
        }
    } else {
        // No unsaved changes, or the unsaved image is not part of the export batch.
        _showExportOptionsDialog(viewer, imagesToExport);
    }
}