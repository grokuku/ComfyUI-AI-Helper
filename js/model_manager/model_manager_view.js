/*
 * Holaf Utilities - Model Manager View
 * This module handles rendering data to the UI, including filtering, sorting,
 * and updating status indicators.
 */
import { HolafPanelManager } from "../holaf_panel_manager.js";
import { HolafFetch, HolafFetchError } from "../vendor/holaf/holaf-fetch.js";

/**
 * Fetches the list of models from the server.
 * @param {object} manager - The main model manager instance.
 */
async function fetchModels(manager) {
    if (manager.isLoading) return;
    manager.isLoading = true;
    updateActionButtonsState(manager);

    const modelsArea = document.getElementById("holaf-manager-models-area");
    if (modelsArea) modelsArea.innerHTML = `<p class="holaf-manager-message">Loading models...</p>`;
    
    manager.models = [];
    manager.modelCountsPerDisplayType = {};
    
    try {
        // HolafFetch lève sur non-2xx (→ catch : message d'erreur existant) ;
        // `cache` est une option native, forwardée telle quelle.
        manager.models = await HolafFetch.get("/holaf/models", { cache: "no-store" });

        // Calculate counts for each display type for the filter dropdown
        manager.models.forEach(model => {
            const dtype = model.display_type || "Undefined";
            manager.modelCountsPerDisplayType[dtype] = (manager.modelCountsPerDisplayType[dtype] || 0) + 1;
        });

        populateModelTypes(manager);
        filterAndSortModels(manager);
    } catch (error) {
        console.error("[Holaf ModelManager] Error loading models:", error);
        if (modelsArea) modelsArea.innerHTML = `<p class="holaf-manager-message error">Error loading models: ${error.message}</p>`;
        updateStatusBarText(manager);
    } finally {
        manager.isLoading = false;
        updateActionButtonsState(manager);
    }
}

/**
 * Filters and sorts the models based on current settings, then renders them.
 * This is the main function to call to refresh the view.
 * @param {object} manager - The main model manager instance.
 */
export async function filterAndSortModels(manager) {
    // If models are not loaded yet, fetch them first.
    if (manager.models.length === 0 && !manager.isLoading) {
        await fetchModels(manager);
        return; // fetchModels will call this function again after loading
    }
    
    const selectedTypeFilterValue = manager.settings.filter_type || "All";
    const searchText = (manager.settings.filter_search_text || "").toLowerCase();

    let modelsToDisplay = manager.models.filter(model => {
        let typeMatch = false;
        if (selectedTypeFilterValue === "All") {
            typeMatch = true;
        } else if (selectedTypeFilterValue === "Holaf--Category--Others") {
            typeMatch = model.display_type && model.display_type.startsWith("Others (");
        } else {
            typeMatch = (model.display_type === selectedTypeFilterValue);
        }

        const textMatch = (
            model.name.toLowerCase().includes(searchText) ||
            (model.model_family && model.model_family.toLowerCase().includes(searchText)) ||
            model.path.toLowerCase().includes(searchText)
        );
        return typeMatch && textMatch;
    });

    // Sort the filtered models
    const { column, order } = manager.currentSort;
    modelsToDisplay.sort((a, b) => {
        let valA = a[column];
        let valB = b[column];
        if (column === 'size_bytes') {
            valA = Number(valA) || 0;
            valB = Number(valB) || 0;
        } else {
            valA = String(valA || "").toLowerCase();
            valB = String(valB || "").toLowerCase();
        }
        
        if (valA < valB) return order === 'asc' ? -1 : 1;
        if (valA > valB) return order === 'asc' ? 1 : -1;

        // Secondary sort by name if primary sort values are equal
        if (column !== 'name') {
            let nameA = String(a.name || "").toLowerCase();
            let nameB = String(b.name || "").toLowerCase();
            if (nameA < nameB) return -1;
            if (nameA > nameB) return 1;
        }
        return 0;
    });

    renderModels(manager, modelsToDisplay);
    updateSortIndicators();
    updateStatusBarText(manager);
}

/**
 * Renders the provided list of models into the DOM.
 * @param {object} manager - The main model manager instance.
 * @param {Array} modelsToRender - The array of model objects to display.
 */
export function renderModels(manager, modelsToRender) {
    const modelsArea = document.getElementById("holaf-manager-models-area");
    if (!modelsArea) return;

    modelsArea.innerHTML = ''; // Clear previous content

    if (modelsToRender.length === 0) {
        modelsArea.innerHTML = `<p class="holaf-manager-message">No models match your criteria.</p>`;
        updateSelectAllCheckboxState();
        return;
    }

    modelsToRender.forEach(model => {
        const card = document.createElement("div");
        card.className = "holaf-model-card";
        const sizeMB = (Number(model.size_bytes) / (1024 * 1024)).toFixed(2);
        
        card.innerHTML = `
            <div class="holaf-model-col holaf-col-checkbox">
                <input type="checkbox" class="holaf-model-checkbox" data-model-path="${model.path}" ${manager.selectedModelPaths.has(model.path) ? 'checked' : ''}>
            </div>
            <div class="holaf-model-col holaf-col-name" title="${model.name}\n${model.path}">
                <span class="holaf-model-name">${model.name}</span>
                <span class="holaf-model-path">${model.path}</span>
            </div>
            <div class="holaf-model-col holaf-col-type">
                <span class="holaf-model-type-tag">${model.display_type || 'N/A'}</span>
            </div>
            <div class="holaf-model-col holaf-col-family">
                <span class="holaf-model-family-tag">${model.model_family || 'N/A'}</span>
            </div>
            <div class="holaf-model-col holaf-col-size">
                <span class="holaf-model-size">${sizeMB} MB</span>
            </div>
        `;

        const checkbox = card.querySelector(".holaf-model-checkbox");
        checkbox.onclick = (e) => { // Use onclick for better compatibility
            const path = e.target.dataset.modelPath;
            if (e.target.checked) {
                manager.selectedModelPaths.add(path);
            } else {
                manager.selectedModelPaths.delete(path);
            }
            updateSelectAllCheckboxState();
            updateActionButtonsState(manager);
        };
        modelsArea.appendChild(card);
    });

    updateSelectAllCheckboxState();
}


/**
 * Populates the model type filter dropdown based on loaded models.
 * @param {object} manager - The main model manager instance.
 */
function populateModelTypes(manager) {
    const selectEl = document.getElementById("holaf-manager-type-select");
    if (!selectEl) return;
    
    selectEl.innerHTML = `<option value="All">All Model Types</option>`;
    const displayTypesFromModels = Object.keys(manager.modelCountsPerDisplayType).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    let hasOtherCategoryModels = false;
    displayTypesFromModels.forEach(displayType => {
        if (manager.modelCountsPerDisplayType[displayType] > 0) {
            if (displayType.startsWith("Autres (")) {
                hasOtherCategoryModels = true;
            } else {
                const option = document.createElement("option");
                option.value = displayType;
                option.textContent = `${displayType} (${manager.modelCountsPerDisplayType[displayType]})`;
                selectEl.appendChild(option);
            }
        }
    });

    if (hasOtherCategoryModels) {
        const otherCount = Object.entries(manager.modelCountsPerDisplayType)
            .filter(([type, count]) => type.startsWith("Autres (") && count > 0)
            .reduce((sum, [, count]) => sum + count, 0);
        if (otherCount > 0) {
            const option = document.createElement("option");
            option.value = "Holaf--Category--Others";
            option.textContent = `Others (${otherCount})`;
            selectEl.appendChild(option);
        }
    }
    selectEl.value = manager.settings.filter_type || "All";

    // Populate the upload dialog's destination dropdown as well
    if (manager.uploadDialog && manager.uploadDialog.destTypeSelect) {
        manager.uploadDialog.destTypeSelect.innerHTML = '';
        manager.modelTypesConfig
            .filter(mt => !mt.storage_hint || mt.storage_hint !== 'directory')
            .forEach(mt => {
                const option = document.createElement("option");
                option.value = mt.folder_name;
                option.textContent = mt.type;
                manager.uploadDialog.destTypeSelect.appendChild(option);
            });
    }
}

/**
 * Updates the sort indicator arrows in the list header.
 */
function updateSortIndicators() {
    const headerCols = document.querySelectorAll(".holaf-manager-list-header .holaf-manager-header-col[data-sort-by]");
    headerCols.forEach(col => {
        col.classList.remove('sort-asc', 'sort-desc');
        const manager = window.app.holafModelManager; // Access global instance
        if (col.dataset.sortBy === manager.currentSort.column) {
            col.classList.add(manager.currentSort.order === 'asc' ? 'sort-asc' : 'sort-desc');
        }
    });
}

/**
 * Updates the state of the "select all" checkbox (checked, indeterminate, or unchecked).
 */
function updateSelectAllCheckboxState() {
    const selectAllCheckbox = document.getElementById("holaf-manager-select-all-checkbox");
    if (!selectAllCheckbox) return;

    const visibleCheckboxes = document.querySelectorAll("#holaf-manager-models-area .holaf-model-checkbox");
    if (visibleCheckboxes.length === 0) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
        return;
    }

    let allChecked = true;
    let noneChecked = true;
    for (const cb of visibleCheckboxes) {
        if (cb.checked) noneChecked = false;
        else allChecked = false;
    }
    
    selectAllCheckbox.checked = allChecked;
    selectAllCheckbox.indeterminate = !allChecked && !noneChecked;
}

/**
 * Enables or disables action buttons based on selection and current operations.
 * @param {object} manager - The main model manager instance.
 */
export function updateActionButtonsState(manager) {
    const uploadButton = document.getElementById("holaf-manager-upload-button");
    const downloadButton = document.getElementById("holaf-manager-download-button");
    const deepScanButton = document.getElementById("holaf-manager-deep-scan-button");
    const deleteButton = document.getElementById("holaf-manager-delete-button");

    const isGloballyBlocked = manager.isLoading;

    if (uploadButton) uploadButton.disabled = isGloballyBlocked;
    
    if (downloadButton) {
        downloadButton.disabled = isGloballyBlocked || manager.selectedModelPaths.size === 0;
        downloadButton.textContent = `Download (${manager.selectedModelPaths.size})`;
    }

    if (deepScanButton) {
        const hasSafetensorsSelected = Array.from(manager.selectedModelPaths).some(p => p.toLowerCase().endsWith('.safetensors'));
        deepScanButton.disabled = isGloballyBlocked || !hasSafetensorsSelected;
        deepScanButton.textContent = "Deep Scan";
    }

    if (deleteButton) {
        deleteButton.disabled = isGloballyBlocked || manager.selectedModelPaths.size === 0;
        deleteButton.textContent = `Delete (${manager.selectedModelPaths.size})`;
    }

    [uploadButton, downloadButton, deepScanButton, deleteButton].forEach(btn => {
        if (btn) {
            btn.style.opacity = btn.disabled ? '0.5' : '1';
            btn.style.cursor = btn.disabled ? 'not-allowed' : 'pointer';
        }
    });
}

/**
 * Updates the text in the status bar based on current operations.
 * @param {object} manager - The main model manager instance.
 */
export function updateStatusBarText(manager) {
    const statusBar = document.getElementById("holaf-manager-statusbar");
    if (!statusBar) return;

    const operationActive = manager.isUploading || manager.isDownloading || manager.isDeepScanning;

    if (operationActive) {
        let statusParts = [];
        // Upload status
        if (manager.isUploading) {
            const currentJob = manager.uploadQueue.find(j => ['hashing', 'uploading', 'finalizing'].includes(j.status));
            const queuedJobs = manager.uploadQueue.filter(j => j.status === 'queued').length;
            if (currentJob) {
                const speed = manager.uploadStats.currentSpeed > 0 ? manager.uploadStats.currentSpeed.toFixed(2) : '...';
                let progressText = `(${currentJob.progress.toFixed(1)}%)`;
                if (currentJob.status === 'hashing') progressText = '(hashing...)';
                statusParts.push(`Uploading: ${currentJob.file.name.substring(0, 20)}... ${progressText} @ ${speed} MB/s`);
            }
            if (queuedJobs > 0) statusParts.push(`${queuedJobs} upload(s) queued`);
        }
        // Download status
        if (manager.isDownloading) {
            const currentJob = manager.downloadQueue.find(j => j.status === 'downloading' || j.status === 'assembling');
            const queuedJobs = manager.downloadQueue.filter(j => j.status === 'queued').length;
            if (currentJob) {
                const speed = manager.downloadStats.currentSpeed > 0 ? manager.downloadStats.currentSpeed.toFixed(2) : '...';
                statusParts.push(`Downloading: ${currentJob.model.name.substring(0, 20)}... (${currentJob.progress.toFixed(1)}%) @ ${speed} MB/s`);
            }
            if (queuedJobs > 0) statusParts.push(`${queuedJobs} download(s) queued`);
        }
        // Scan status
        if (manager.isDeepScanning) {
            statusParts.push(`Scanning ${manager.scanQueue.length} more models...`);
        }
        // Error status
        const erroredUploads = manager.uploadQueue.filter(j => j.status === 'error').length;
        if (erroredUploads > 0) statusParts.push(`${erroredUploads} upload error(s)`);
        const erroredDownloads = manager.downloadQueue.filter(j => j.status === 'error').length;
        if (erroredDownloads > 0) statusParts.push(`${erroredDownloads} download error(s)`);

        statusBar.textContent = 'Status: ' + (statusParts.length > 0 ? statusParts.join(' | ') : 'Processing...');
        manager.statusUpdateRaf = requestAnimationFrame(() => updateStatusBarText(manager));
    } else {
        // Default status text when idle
        if (manager.statusUpdateRaf) cancelAnimationFrame(manager.statusUpdateRaf);
        manager.statusUpdateRaf = null;
        
        const modelsArea = document.getElementById("holaf-manager-models-area");
        const totalShown = modelsArea ? modelsArea.childElementCount : 0;
        const totalAvailable = manager.models.length;

        if (totalAvailable > 0 && totalShown < totalAvailable) {
            statusBar.textContent = `Status: Displaying ${totalShown} of ${totalAvailable} models.`;
        } else if (totalAvailable > 0) {
            statusBar.textContent = `Status: ${totalAvailable} models loaded.`;
        } else {
             statusBar.textContent = "Status: Ready";
        }
    }
}