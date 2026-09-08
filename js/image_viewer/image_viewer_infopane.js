/*
 * Copyright (C) 2025 Holaf
 * Holaf Utilities - Image Viewer Info Pane Module
 *
 * REFACTOR: Uses HolafComfyBridge to support standalone gallery mode.
 */

import "../aih_strings.js";
import { HolafPanelManager } from "../holaf_panel_manager.js";
import { imageViewerState } from './image_viewer_state.js';
import { holafBridge } from "../holaf_comfy_bridge.js";
import { app as comfyApp } from "../holaf_api_compat.js";
import { escapeHtml } from "../holaf_dom_utils.js";
import { showToast } from "../aih_toast_bridge.js";

// Helper i18n central : traduit via AIH.I18n (clé brute si absente).
const t = (key, params) => {
    const I = window.AIH && window.AIH.I18n;
    return I && typeof I.t === "function" ? I.t(key, params) : key;
};

// Safe access to app (only available in main tab)
// comfyApp is now provided via holaf_api_compat.js, which uses window.comfyAPI
// with fallback to legacy import. In standalone mode, the proxy will return
// undefined for property access, which is handled gracefully.

// Module-level variables to manage state
let abortController = null;

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
let lastProcessedPath = null;

/**
 * Auto-resizes a textarea to fit its content, respecting max-height.
 * @param {HTMLTextAreaElement} textarea
 */
function autoResizeTextarea(textarea) {
    textarea.style.height = 'auto';
    const computed = getComputedStyle(textarea);
    const maxH = parseFloat(computed.maxHeight) || 140;
    const scrollH = textarea.scrollHeight;
    textarea.style.height = Math.min(scrollH, maxH) + 'px';
}

/**
 * Copies text to the clipboard using the best available method.
 * First tries execCommand (user gesture), then clipboard API as fallback.
 * @param {string} text - The text to copy.
 * @returns {Promise<void>}
 */
function copyTextToClipboard(text) {
    return new Promise((resolve, reject) => {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '0';
        textarea.style.top = '0';
        textarea.style.opacity = '0';
        textarea.style.pointerEvents = 'none';
        textarea.style.width = '1px';
        textarea.style.height = '1px';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();

        try {
            const success = document.execCommand('copy');
            if (success) {
                resolve();
            } else {
                // execCommand failed, try clipboard API
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(resolve, reject);
                } else {
                    reject(new Error('Copy not supported'));
                }
            }
        } catch (err) {
            // execCommand threw, try clipboard API
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(resolve, reject);
            } else {
                reject(err);
            }
        } finally {
            document.body.removeChild(textarea);
        }
    });
}

/**
 * Fetches and displays metadata for a given image in the info pane.
 * @param {object|null} image - The image data object, or null to clear the pane.
 */
async function displayInfoForImage(image) {
    const infoContentEl = document.getElementById('holaf-viewer-info-content');
    if (!infoContentEl) return;

    if (abortController) {
        abortController.abort();
    }
    abortController = new AbortController();
    const signal = abortController.signal;

    if (!image) {
         infoContentEl.innerHTML = `<p class="holaf-viewer-message">${t('iv.selectImageDetails')}</p>`;
         return;
    }

    const sizeInMB = (image.size_bytes / 1048576).toFixed(2);
    let originalPathInfo = '';
    if (image.is_trashed && image.original_path_canon) {
        originalPathInfo = `<p><strong>${t('iv.originalPath')}</strong><br>${escapeHtml(image.original_path_canon)}</p>`;
    }

    infoContentEl.innerHTML = `<p><strong>${t('iv.filename')}</strong><br>${escapeHtml(image.filename)}</p><p><strong>${t('iv.folder')}</strong> ${escapeHtml(image.subfolder || '/')}</p>${originalPathInfo}<p><strong>${t('iv.sizeLabel')}</strong> ${sizeInMB} MB</p><p><strong>${t('iv.formatLabel')}</strong> ${escapeHtml(image.format)}</p><p><strong>${t('iv.modified')}</strong><br>${new Date(image.mtime * 1000).toLocaleString()}</p><div id="holaf-resolution-container"></div><hr><div id="holaf-metadata-container"><p class="holaf-viewer-message"><em>${t('iv.loadingMetadata')}</em></p></div>`;

    try {
        const metadataUrl = new URL(window.location.origin);
        metadataUrl.pathname = '/holaf/images/metadata';
        metadataUrl.search = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '' });

        const response = await fetch(metadataUrl.href, { signal, cache: 'no-store' });
        if (signal.aborted) return;

        const metadataContainer = document.getElementById('holaf-metadata-container');
        if (!metadataContainer) return;

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: t('iv.httpError', { status: response.status }) }));
            // FIX: Re-check abort after inner await
            if (signal.aborted) return;
            metadataContainer.innerHTML = `<p class="holaf-viewer-message error"><strong>${t('iv.errorLabel')}</strong> ${escapeHtml(errorData.error || t('iv.unknownError'))}</p>`;
            return;
        }

        const data = await response.json();
        if (signal.aborted) return;
        
        const finalMetadataContainer = document.getElementById('holaf-metadata-container');
        if (!finalMetadataContainer) return;

        const resolutionContainer = document.getElementById('holaf-resolution-container');
        if (resolutionContainer) {
            let resolutionHTML = '';
            if (data.width && data.height) resolutionHTML += `<p><strong>${t('iv.resolution')}</strong> ${escapeHtml(data.width)}x${escapeHtml(data.height)} px</p>`;
            if (data.ratio) resolutionHTML += `<p><strong>${t('iv.ratio')}</strong> ${escapeHtml(data.ratio)}</p>`;
            resolutionContainer.innerHTML = resolutionHTML;
        }

        const getSourceLabel = (s) => ({ "external_txt": t('iv.fromTxt'), "external_json": t('iv.fromJson'), "internal_png": t('iv.fromPng') }[s] || "");
        finalMetadataContainer.innerHTML = '';

        const createButton = (txt, cb, dis = false) => {
            const b = document.createElement('button');
            b.className = 'holaf-viewer-info-button';
            b.textContent = txt;
            b.disabled = dis;
            if (!dis) b.onclick = cb;
            return b;
        };

        finalMetadataContainer.insertAdjacentHTML('beforeend', `<p><span class="holaf-viewer-metadata-label">${t('iv.prompt')}</span><span class="holaf-viewer-metadata-source">${getSourceLabel(data.prompt_source)}</span></p>`);
        const promptActions = document.createElement('div');
        promptActions.className = 'holaf-viewer-info-actions';
        promptActions.appendChild(createButton(t('iv.copyPrompt'), (e) => {
            copyTextToClipboard(data.prompt).then(() => {
                e.target.textContent = t('iv.copied');
                setTimeout(() => e.target.textContent = t('iv.copyPrompt'), 1500);
            }).catch(err => {
                console.error('Copy failed:', err);
                e.target.textContent = t('iv.copyFailed');
                setTimeout(() => e.target.textContent = t('iv.copyPrompt'), 2000);
            });
        }, !data.prompt));
        finalMetadataContainer.appendChild(promptActions);

        if (data.prompt) {
            const promptText = data.prompt.trim();
            if (promptText) {
                const promptBox = document.createElement('textarea');
                promptBox.className = 'holaf-viewer-metadata-box';
                promptBox.readOnly = true;
                promptBox.value = promptText;
                finalMetadataContainer.appendChild(promptBox);
                requestAnimationFrame(() => autoResizeTextarea(promptBox));
            } else {
                const msg = document.createElement('p');
                msg.className = 'holaf-viewer-message';
                msg.innerHTML = `<em>${t('iv.notAvailable')}</em>`;
                finalMetadataContainer.appendChild(msg);
            }
        } else {
            const msg = document.createElement('p');
            msg.className = 'holaf-viewer-message';
            msg.innerHTML = `<em>${t('iv.notAvailable')}</em>`;
            finalMetadataContainer.appendChild(msg);
        }

        finalMetadataContainer.insertAdjacentHTML('beforeend', `<p style="margin-top:15px;"><span class="holaf-viewer-metadata-label">${t('iv.workflow')}</span><span class="holaf-viewer-metadata-source">${getSourceLabel(data.workflow_source)}</span></p>`);
        const workflowActions = document.createElement('div');
        workflowActions.className = 'holaf-viewer-info-actions';
        
        // --- BUTTON: Load Workflow with BRIDGE Support ---
        workflowActions.appendChild(createButton(t('iv.loadWorkflow'), async () => {
            if (await AIH.ask({
                    title: t('iv.loadWorkflowTitle'),
                    message: t('iv.loadWorkflowMsg'),
                    buttons: [{ text: t('iv.cancel'), value: false }, { text: t('iv.load'), value: true }]
                })) {
                    // BRIDGE LOGIC HERE
                    if (comfyApp && typeof comfyApp.loadGraphData === 'function') {
                        // We are in the main tab, load directly
                        comfyApp.loadGraphData(data.workflow);
                    } else {
                        // We are in standalone/deported mode, send via bridge
                        holafBridge.send('LOAD_WORKFLOW', data.workflow);
                        
                        showToast({ message: t('iv.workflowSentToMain'), type: "success" });
                    }
                }
        }, !data.workflow || !!data.workflow.error));
        finalMetadataContainer.appendChild(workflowActions);

        if (data.workflow && !data.workflow.error) {
            const workflowBox = document.createElement('textarea');
            workflowBox.className = 'holaf-viewer-metadata-box';
            workflowBox.readOnly = true;
            workflowBox.value = JSON.stringify(data.workflow, null, 2);
            finalMetadataContainer.appendChild(workflowBox);
            requestAnimationFrame(() => autoResizeTextarea(workflowBox));

            // Add Copy Workflow button
            const copyWorkflowBtn = document.createElement('button');
            copyWorkflowBtn.className = 'holaf-viewer-info-button';
            copyWorkflowBtn.textContent = t('iv.copyWorkflow');
            copyWorkflowBtn.onclick = (e) => {
                workflowBox.focus();
                workflowBox.select();
                copyTextToClipboard(workflowBox.value).then(() => {
                    e.target.textContent = t('iv.copied');
                    setTimeout(() => e.target.textContent = t('iv.copyWorkflow'), 1500);
                }).catch(err => {
                    console.error('Copy workflow failed:', err);
                    e.target.textContent = t('iv.copyFailed');
                    setTimeout(() => e.target.textContent = t('iv.copyWorkflow'), 2000);
                });
            };
            const copyWfActions = document.createElement('div');
            copyWfActions.className = 'holaf-viewer-info-actions';
            copyWfActions.appendChild(copyWorkflowBtn);
            finalMetadataContainer.appendChild(copyWfActions);
        } else if (data.workflow && data.workflow.error) {
            finalMetadataContainer.insertAdjacentHTML('beforeend', `<p class="holaf-viewer-message error"><em>${t('iv.errorWorkflow', { error: escapeHtml(data.workflow.error) })}</em></p>`);
        } else {
            finalMetadataContainer.insertAdjacentHTML('beforeend', `<p class="holaf-viewer-message"><em>${t('iv.noWorkflowFound')}</em></p>`);
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error("Metadata fetch error:", err);
            const m = document.getElementById('holaf-metadata-container');
            if (m) m.innerHTML = `<p class="holaf-viewer-message error"><strong>${t('iv.errorLabel')}</strong> ${t('iv.fetchMetadataFailed')}</p>`;
        }
    }
}

/**
 * Initializes the info pane to subscribe to state changes.
 */
export function setupInfoPane() {
    imageViewerState.subscribe(newState => {
        const activeImage = newState.activeImage;
        const activeImagePath = activeImage ? activeImage.path_canon : null;

        if (activeImagePath !== lastProcessedPath) {
            lastProcessedPath = activeImagePath;
            displayInfoForImage(activeImage);
        }
    });
}