/*
 * Holaf Utilities - Model Manager Actions
 * This module contains the business logic for all user actions such as
 * uploading, downloading, scanning, and deleting models.
 * MODIFIED: Removed SHA256 hashing for uploads to improve performance.
 * Replaced with a simple file size check on the server side.
 */

import "../aih_strings.js";
import { HolafPanelManager } from "../holaf_panel_manager.js";
import { HolafFetch, HolafFetchError } from "../vendor/holaf/holaf-fetch.js";

// Helper i18n central : traduit via AIH.I18n (clé brute si absente).
const t = (key, params) => {
    const I = window.AIH && window.AIH.I18n;
    return I && typeof I.t === "function" ? I.t(key, params) : key;
};

// --- UPLOAD LOGIC ---

/**
 * Adds selected files from the upload dialog to the processing queue.
 * @param {object} manager - The main model manager instance.
 */
export function addFilesToUploadQueue(manager) {
    const { fileInput, destTypeSelect, subfolderInput, dialogEl, statusMessage } = manager.uploadDialog;
    const files = fileInput.files;
    const destType = destTypeSelect.value;
    const subfolder = subfolderInput.value.trim();

    if (files.length === 0) {
        statusMessage.textContent = t("mma.selectFile");
        return;
    }

    for (const file of files) {
        const job = {
            file: file,
            id: `holaf-upload-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            status: 'queued',
            progress: 0,
            chunksSent: 0,
            totalChunks: Math.ceil(file.size / manager.UPLOAD_CHUNK_SIZE),
            destType,
            subfolder,
            errorMessage: null,
            sentBytes: 0,
            // sha256 property removed
        };
        manager.uploadQueue.push(job);
    }

    dialogEl.style.display = 'none';
    fileInput.value = '';
    manager.uploadDialog.fileListEl.style.display = 'none';

    if (!manager.isUploading) {
        processUploadQueue(manager);
    }
}

/**
 * Processes the upload queue, one file at a time.
 * @param {object} manager - The main model manager instance.
 */
export async function processUploadQueue(manager) {
    if (manager.activeUploads >= manager.MAX_CONCURRENT_UPLOADS) return;

    const nextJob = manager.uploadQueue.find(j => j.status === 'queued');
    if (!nextJob) {
        if (manager.activeUploads === 0) {
            manager.isUploading = false;
            if (manager.refreshAfterUpload) {
                setTimeout(() => { manager.filterModels(); }, 3000); // Refresh list
            }
            manager.refreshAfterUpload = false;
            // Do not clear the queue here to allow inspection of errors
        }
        return;
    }

    manager.isUploading = true;
    manager.updateActionButtonsState();
    manager.activeUploads++;
    nextJob.status = 'uploading'; // Status changed from 'hashing' to 'uploading'

    if (!manager.statusUpdateRaf) {
        manager.updateStatusBarText();
    }
    manager.uploadStats.totalBytes += nextJob.file.size;

    await uploadFile(manager, nextJob);

    manager.activeUploads--;
    processUploadQueue(manager); // Process next job
}

async function uploadFile(manager, job) {
    try {
        // Hashing step removed
        const chunkIndices = Array.from({ length: job.totalChunks }, (_, i) => i);
        let parallelQueue = [...chunkIndices];

        await new Promise((resolve, reject) => {
            const worker = async () => {
                while (parallelQueue.length > 0) {
                    const chunkIndex = parallelQueue.shift();
                    if (chunkIndex === undefined) continue;

                    try {
                        const start = chunkIndex * manager.UPLOAD_CHUNK_SIZE;
                        const end = Math.min(start + manager.UPLOAD_CHUNK_SIZE, job.file.size);
                        const chunk = job.file.slice(start, end);

                        const formData = new FormData();
                        formData.append("upload_id", job.id);
                        formData.append("chunk_index", chunkIndex);
                        formData.append("file_chunk", chunk);

                        // FormData passé tel quel (corps brut auto, pas de raw
                        // nécessaire). Chunks d'un gros modèle sur un lien lent
                        // → timeout désactivé (l'ancien fetch natif n'en avait
                        // pas). HolafFetch lève sur non-2xx (→ catch ci-dessous).
                        await HolafFetch.post('/holaf/models/upload-chunk', { body: formData, timeout: 0 });
                        job.chunksSent++;
                        job.sentBytes += chunk.size;
                        job.progress = (job.chunksSent / job.totalChunks) * 100;
                        manager.uploadStats.totalSentBytes += chunk.size;
                        calculateSpeed(manager.uploadStats);
                    } catch (err) {
                        job.status = 'error';
                        // Même message utilisateur qu'avant : champ `message` du
                        // corps JSON serveur, sinon fallback i18n (erreur HTTP)
                        // ou message réseau.
                        job.errorMessage = (err instanceof HolafFetchError && err.data && err.data.message)
                            || (err instanceof HolafFetchError && err.status >= 400
                                ? t("mma.chunkFailed", { chunk: chunkIndex })
                                : err.message);
                        reject(err);
                        return; // Stop this worker
                    }
                }
            };
            const workers = Array(manager.MAX_CONCURRENT_CHUNKS).fill(null).map(() => worker());
            Promise.all(workers).then(resolve).catch(reject);
        });

        job.status = 'finalizing';
        await finalizeUpload(manager, job);

    } catch (error) {
        job.status = 'error';
        job.errorMessage = error.message;
    }
}

async function finalizeUpload(manager, job) {
    try {
        // HolafFetch lève sur non-2xx (→ catch : même message utilisateur).
        // L'assemblage disque d'un gros modèle peut dépasser 30 s → timeout
        // désactivé (l'ancien fetch natif n'en avait pas).
        await HolafFetch.post('/holaf/models/finalize-upload', {
            body: {
                upload_id: job.id,
                filename: job.file.name,
                total_chunks: job.totalChunks,
                destination_type: job.destType,
                subfolder: job.subfolder,
                expected_size: job.file.size,
                // expected_sha256 removed from payload
            },
            timeout: 0,
        });
        job.status = 'done';
        manager.refreshAfterUpload = true;
    } catch (error) {
        job.status = 'error';
        // Même message utilisateur qu'avant : champ `message` du corps JSON
        // serveur, sinon fallback i18n (erreur HTTP) ou message réseau.
        job.errorMessage = (error instanceof HolafFetchError && error.data && error.data.message)
            || (error instanceof HolafFetchError && error.status >= 400
                ? t("mma.finalizationFailed")
                : error.message);
    }
}


// --- DOWNLOAD LOGIC ---

export function addSelectedToDownloadQueue(manager) {
    const pathsToDownload = getAvailablePathsForAction(manager, manager.selectedModelPaths);
    if (pathsToDownload.length === 0) {
        AIH.ask({ title: t("mma.downloadTitle"), message: t("mma.downloadNone") });
        return;
    }

    for (const path of pathsToDownload) {
        const model = manager.models.find(m => m.path === path);
        if (model) {
            const totalChunks = Math.ceil(model.size_bytes / manager.DOWNLOAD_CHUNK_SIZE);
            manager.downloadQueue.push({
                model,
                id: `holaf-download-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                status: 'queued',
                progress: 0,
                chunksReceived: 0,
                totalChunks,
                receivedBytes: 0,
                chunksData: new Array(totalChunks),
            });
        }
    }
    manager.selectedModelPaths.clear();
    manager.filterModels();
    manager.updateActionButtonsState();

    if (!manager.isDownloading) {
        processDownloadQueue(manager);
    }
}

export async function processDownloadQueue(manager) {
    if (manager.activeDownloads >= manager.MAX_CONCURRENT_DOWNLOADS) return;

    const nextJob = manager.downloadQueue.find(j => j.status === 'queued');
    if (!nextJob) {
        if (manager.activeDownloads === 0) manager.isDownloading = false;
        return;
    }

    manager.isDownloading = true;
    manager.updateActionButtonsState();
    manager.activeDownloads++;
    nextJob.status = 'downloading';

    if (!manager.statusUpdateRaf) manager.updateStatusBarText();
    manager.downloadStats.totalBytes += nextJob.model.size_bytes;

    await downloadFile(manager, nextJob);

    manager.activeDownloads--;
    processDownloadQueue(manager);
}

async function downloadFile(manager, job) {
    try {
        let parallelQueue = Array.from({ length: job.totalChunks }, (_, i) => i);
        await new Promise((resolve, reject) => {
            const worker = async () => {
                while (parallelQueue.length > 0) {
                    const chunkIndex = parallelQueue.shift();
                    if (chunkIndex === undefined) continue;
                    try {
                        // Chunk binaire → raw:true : Response brute (blob), la
                        // brique ne throw PAS sur non-2xx en raw → la gestion
                        // d'erreur textuelle reste identique. Timeout désactivé :
                        // gros chunks sur lien lent (en raw le timeout ne couvre
                        // que les en-têtes ; on garde la parité avec l'ancien
                        // fetch sans timeout).
                        const response = await HolafFetch.post('/holaf/models/download-chunk', {
                            body: {
                                path: job.model.path,
                                chunk_index: chunkIndex,
                                chunk_size: manager.DOWNLOAD_CHUNK_SIZE,
                            },
                            raw: true,
                            timeout: 0,
                        });
                        if (!response.ok) throw new Error(await response.text());
                        
                        const chunkBlob = await response.blob();
                        job.chunksData[chunkIndex] = chunkBlob;
                        job.chunksReceived++;
                        job.receivedBytes += chunkBlob.size;
                        job.progress = (job.chunksReceived / job.totalChunks) * 100;
                        manager.downloadStats.totalReceivedBytes += chunkBlob.size;
                        calculateSpeed(manager.downloadStats);
                    } catch (err) {
                        job.status = 'error';
                        job.errorMessage = err.message;
                        reject(err);
                        return;
                    }
                }
            };
            const workers = Array(manager.MAX_CONCURRENT_CHUNKS).fill(null).map(() => worker());
            Promise.all(workers).then(resolve).catch(reject);
        });

        await assembleAndSaveFile(job);
    } catch (error) {
        job.status = 'error';
        job.errorMessage = error.message || t("mma.unknownDownloadError");
    }
}

async function assembleAndSaveFile(job) {
    job.status = 'assembling';
    try {
        const finalBlob = new Blob(job.chunksData, { type: 'application/octet-stream' });
        if (finalBlob.size !== job.model.size_bytes) {
            throw new Error(t("mma.assembleMismatch", { expected: job.model.size_bytes, got: finalBlob.size }));
        }
        const url = window.URL.createObjectURL(finalBlob);
        const a = Object.assign(document.createElement('a'), { href: url, download: job.model.name, style: "display:none" });
        document.body.appendChild(a).click();
        document.body.removeChild(a);
        setTimeout(() => window.URL.revokeObjectURL(url), 1000);
        job.status = 'done';
    } catch (error) {
        job.status = 'error';
        job.errorMessage = error.message;
    }
}


// --- SCAN AND DELETE LOGIC ---

export function addSelectedToScanQueue(manager) {
    const allSelected = Array.from(manager.selectedModelPaths);
    const pathsToScan = getAvailablePathsForAction(manager, allSelected.filter(p => p.toLowerCase().endsWith('.safetensors')));
    if (pathsToScan.length === 0) {
        AIH.ask({ title: t("mma.scanTitle"), message: t("mma.scanNone") });
        return;
    }
    manager.scanQueue.push(...pathsToScan);
    manager.selectedModelPaths.clear();
    manager.filterModels();
    manager.updateActionButtonsState();
    if (!manager.isDeepScanning) processScanQueue(manager);
}

export async function processScanQueue(manager) {
    if (manager.scanQueue.length === 0) {
        manager.isDeepScanning = false;
        if (!manager.isUploading && !manager.isDownloading) manager.filterModels();
        return;
    }
    manager.isDeepScanning = true;
    if (!manager.statusUpdateRaf) manager.updateStatusBarText();

    const pathsToScanInBatch = manager.scanQueue.splice(0, manager.scanQueue.length);
    try {
        // Scan approfondi (lecture/hash des fichiers) : potentiellement long →
        // timeout désactivé. HolafFetch lève sur non-2xx avec le message
        // serveur (body.error) → même affichage d'erreur que l'ancien throw.
        const result = await HolafFetch.post('/holaf/models/deep-scan-local', {
            body: { paths: pathsToScanInBatch },
            timeout: 0,
        });
        if (result.details?.errors?.length > 0) console.error("[Holaf MM] Deep Scan Errors:", result.details.errors);
    } catch (error) {
        AIH.ask({ title: t("mma.scanError"), message: t("mma.scanErrorMsg", { message: error.message }) });
    } finally {
        processScanQueue(manager); // Process next batch or finish
    }
}

export async function performDelete(manager) {
    const pathsToDelete = getAvailablePathsForAction(manager, manager.selectedModelPaths);
    if (pathsToDelete.length === 0) {
        AIH.ask({ title: t("mma.deleteTitle"), message: t("mma.deleteNone") });
        return;
    }
    const confirmed = await AIH.ask({
        title: t("mma.confirmDelete"),
        message: t("mma.confirmDeleteMsg", { count: pathsToDelete.length }),
        buttons: [{ text: t("mma.cancel"), value: false }, { text: t("mma.deletePermanent"), value: true, type: "danger" }]
    });
    if (!confirmed) return;

    manager.isLoading = true;
    manager.updateActionButtonsState();
    try {
        // La brique parse et renvoie tout 2xx (y compris le 207 Multi-Status
        // de succès partiel, accepté par l'ancien code) ; les non-2xx lèvent
        // une HolafFetchError → catch ci-dessous (message serveur affiché).
        const result = await HolafFetch.post('/holaf/models/delete', { body: { paths: pathsToDelete } });
        let message = t("mma.deletedCount", { count: result.details?.deleted_count || 0 });
        if (result.details?.errors?.length > 0) {
            message += t("mma.errorsOccurred", { count: result.details.errors.length });
            console.error("[Holaf MM] Delete Errors:", result.details.errors);
        }
        await AIH.ask({ title: t("mma.deleteComplete"), message });
    } catch (error) {
        await AIH.ask({ title: t("mma.deleteError"), message: t("mma.deleteErrorMsg", { message: error.message }) });
    } finally {
        manager.isLoading = false;
        manager.selectedModelPaths.clear();
        await manager.filterModels();
    }
}


// --- UTILITY FUNCTIONS ---

function getAvailablePathsForAction(manager, selectedPaths) {
    const allSelected = Array.from(selectedPaths);
    const availablePaths = allSelected.filter(path => !isPathInActiveTransfer(manager, path));
    const skippedCount = allSelected.length - availablePaths.length;
    if (skippedCount > 0) {
        AIH.ask({ title: t("mma.notice"), message: t("mma.skippedTransfer", { count: skippedCount }) });
    }
    return availablePaths;
}

function isPathInActiveTransfer(manager, path) {
    const filename = path.split('/').pop();
    const inUpload = manager.uploadQueue.some(j => j.file.name === filename && j.status !== 'done' && j.status !== 'error');
    const inDownload = manager.downloadQueue.some(j => j.model.path === path && j.status !== 'done' && j.status !== 'error');
    return inUpload || inDownload;
}

// The calculateFileSHA256 function has been removed.

function calculateSpeed(statsObject) {
    const now = Date.now();
    const byteSource = statsObject.totalSentBytes ?? statsObject.totalReceivedBytes;
    statsObject.history.push({ time: now, bytes: byteSource });
    while (statsObject.history.length > 20 && now - statsObject.history[0].time > 5000) {
        statsObject.history.shift();
    }
    if (statsObject.history.length > 1) {
        const first = statsObject.history[0];
        const last = statsObject.history[statsObject.history.length - 1];
        const deltaTime = (last.time - first.time) / 1000;
        if (deltaTime > 0.1) {
            statsObject.currentSpeed = ((last.bytes - first.bytes) / deltaTime) / (1024 * 1024);
        }
    }
}