/*
 * Holaf Profiler standalone app.
 *
 * NOTE ON IMPORTS: this entry module is served through the alias route
 * /holaf/profiler/app.js (a MIME-type workaround, see __init__.py). Its browser
 * URL therefore does NOT mirror its disk location: static relative imports
 * would resolve against /holaf/ and fail. The host page (PROFILER_HTML in
 * __init__.py) exposes the resolved extension asset base as window.HOLAF_EXT_BASE
 * before calling initProfiler(); pack modules are imported dynamically from it.
 *
 * NOTE: the AIH foundation (aih_i18n + aih_dialog) is NOT statically imported
 * here. This entry module is served through the alias route, so a static
 * relative import would resolve against /holaf/ (forbidden MIME type and a
 * blank page). Instead it is loaded dynamically from the REAL extension path
 * (/extensions/<pack>/...) resolved via window.HOLAF_EXT_BASE — see
 * loadAihFoundation() below.
 */

/**
 * Resolves a pack asset URL from the base injected by the host page.
 * @param {string} relativePath e.g. "aih_dialog.js" (no "js/" segment —
 *   WEB_DIRECTORY="js" is mounted directly at /extensions/<pack>/, so the
 *   browser URL never contains the "js/" segment).
 */
function holafPackUrl(relativePath) {
    const rel = String(relativePath).replace(/^\/+/, "");
    const base = (typeof window !== "undefined" && window.HOLAF_EXT_BASE) || null;
    if (base) {
        return `${base.replace(/\/+$/, "")}/${rel}`;
    }
    // No explicit base injected. Anchor the specifier to the current document
    // origin so the dynamic import is ALWAYS an absolute http(s) URL and can
    // never resolve to a bare relative path that — when the module route and
    // the page origin differ — could fall back to file:// (blocked by the
    // browser with a security error on https pages).
    const docBase = (typeof document !== "undefined" && document.baseURI) || "";
    if (docBase && /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(docBase)) {
        try {
            return new URL(rel, docBase).href;
        } catch (e) {
            /* malformed base; fall through to the loud warning below */
        }
    }
    console.warn("[Holaf Profiler] window.HOLAF_EXT_BASE is not set and no valid document origin; cannot resolve pack asset absolutely:", rel);
    return rel;
}

/**
 * Loads the AIH foundation (aih_i18n then aih_dialog) from the REAL extension
 * asset path so the JS is served with the correct MIME type. Because this entry
 * module is served through the alias route /holaf/profiler/app.js, static
 * relative imports must not be used (they would resolve under /holaf/ and be
 * served as application/octet-stream → blank page). Resolving via
 * window.HOLAF_EXT_BASE (host-injected in PROFILER_HTML) locates the pack JS on
 * the real /extensions/<pack>/ path. Guarantees window.AIH (I18n, Dialog and
 * confirm/prompt/alert) is defined before any consumer uses it.
 */
async function loadAihFoundation() {
    try {
        await import(holafPackUrl("aih_i18n.js"));
        await import(holafPackUrl("aih_strings.js"));
        await import(holafPackUrl("aih_dialog.js"));
        return !!(
            window.AIH &&
            typeof window.AIH.I18n === "object" &&
            typeof window.AIH.confirm === "function" &&
            typeof window.AIH.prompt === "function"
        );
    } catch (err) {
        console.warn("[Holaf Profiler] Could not load AIH foundation; falling back to native dialogs.", err);
        return false;
    }
}

/**
 * Loads HolafComfyBridge dynamically (see import note above).
 * Falls back to an inert stub so the profiler remains usable without the
 * live group-sync feature if the bridge cannot be located.
 */
async function loadHolafComfyBridge() {
    try {
        // NOTE: no "js/" prefix — WEB_DIRECTORY="js" is mounted directly at
        // /extensions/<pack>/, so the module lives at
        // <HOLAF_EXT_BASE>/holaf_comfy_bridge.js (a "js/" segment would 404 and
        // be served as application/octet-stream, blocking the MIME type).
        const mod = await import(holafPackUrl("holaf_comfy_bridge.js"));
        return mod.HolafComfyBridge;
    } catch (err) {
        console.warn("[Holaf Profiler] Could not load holaf_comfy_bridge.js; live group-sync disabled.", err);
        const InertBridge = class InertBridge { listen() {} send() {} };
        // Marker so callers can degrade gracefully (e.g. "Update Nodes") when
        // the real bridge is unavailable instead of silently doing nothing.
        InertBridge.isInert = true;
        return InertBridge;
    }
}

export async function initProfiler() {
    console.log("Holaf Profiler Initializing...");
    
    // Load the AIH foundation (aih_i18n + aih_dialog) from the real extension
    // path before anything can call window.AIH.confirm/prompt.
    const aihLoaded = await loadAihFoundation();

    // ── Brique HolafFetch — import DYNAMIQUE obligatoire ──
    // Ce module est servi via l'alias /holaf/profiler/app.js : un import
    // statique relatif ("../vendor/…") résoudrait sous /holaf/ (MIME interdit
    // → page blanche), exactement comme pour aih_dialog / holaf_comfy_bridge
    // ci-dessus (voir la note d'imports en tête de fichier).
    let HolafFetch = null;
    let HolafFetchError = null;
    try {
        const fetchMod = await import(holafPackUrl("vendor/holaf/holaf-fetch.js"));
        HolafFetch = fetchMod.HolafFetch;
        HolafFetchError = fetchMod.HolafFetchError;
    } catch (err) {
        console.warn("[Holaf Profiler] Could not load holaf-fetch.js; network calls unavailable.", err);
    }
    // instanceof sûr même si la brique n'a pas pu être chargée.
    const isFetchError = (e) => !!(HolafFetchError && e instanceof HolafFetchError);

    const HolafComfyBridge = await loadHolafComfyBridge();
    const bridge = new HolafComfyBridge();
    const comfyBridgeActive = !(HolafComfyBridge.isInert === true);

    // Safe AIH helpers: use the unified AIH dialogs when the foundation loaded,
    // otherwise fall back to native browser dialogs so the profiler never breaks.
    const aihConfirm = (message) => {
        if (aihLoaded && window.AIH && typeof window.AIH.confirm === 'function') {
            return window.AIH.confirm(message);
        }
        return window.confirm(message);
    };
    const aihPrompt = (message, defaultValue, placeholder) => {
        if (aihLoaded && window.AIH && typeof window.AIH.prompt === 'function') {
            return window.AIH.prompt(message, defaultValue, placeholder);
        }
        return window.prompt(message, defaultValue ?? '');
    };

    // Helper i18n central : traduit via AIH.I18n (clé brute si absente).
    const t = (key, params) => {
        const I = window.AIH && window.AIH.I18n;
        return I && typeof I.t === "function" ? I.t(key, params) : key;
    };
    
    // --- STATE ---
    let currentRunId = null;
    let pollInterval = null;
    let nodesMap = new Map();
    let executionCounter = 0;
    let runFinished = false;
    let currentTotalTime = null;
    
    // Polling / auto-stop detection
    let lastStepCount = null;    // step count from previous poll (feeds the stuck-run safety timeout)
    let lastProgressTime = null; // timestamp of the last observed progress (new node or step-count change)
    
    // Group Mapping
    let groupMapping = {}; 

    let config = {
        filterNonExecuted: false,
        filterTypeExclude: "",
        minTime: 0.0,
        sortBy: 'exec_order',
        sortDir: 'asc'
    };

    // Run History state
    let historyRuns = [];
    let selectedRunIds = new Set();
    let comparisonRunIds = [];

    // Compare state
    let compareData = null;
    let compareMetric = 'exec_time';
    let compareNodesMap = new Map();

    const root = document.getElementById('holaf-profiler-root');
    
    // --- LOAD SAVED GROUPS ---
    try {
        const saved = localStorage.getItem('holaf_profiler_groups');
        if (saved) groupMapping = JSON.parse(saved);
    } catch(e) {}

    // --- BRIDGE LISTENER ---
    bridge.listen((data) => {
        if (data && data.type === 'profiler_group_data') {
            groupMapping = data.map;
            applyGroupsAndRender();
        }
    });

    // --- UI STRUCTURE ---
    root.innerHTML = `
        <style>
            #holaf-profiler-root { display:flex; flex-direction:column; height:100%; box-sizing:border-box; }

            /* --- Tab Bar --- */
            .profiler-tabs {
                display: flex;
                gap: 6px;
                padding: 10px 20px 0;
                background-color: color-mix(in srgb, var(--holaf-background-primary, #1E1E1E) 60%, black);
                border-bottom: 1px solid var(--holaf-border-color, #3F3F3F);
            }
            .profiler-tab {
                padding: 8px 18px;
                background: transparent;
                color: var(--holaf-text-secondary, #A0A0A0);
                border: 1px solid transparent;
                border-bottom: none;
                border-radius: 6px 6px 0 0;
                cursor: pointer;
                font-size: 0.9rem;
                font-family: inherit;
                transition: color .15s, background-color .15s, border-color .15s;
            }
            .profiler-tab:hover { color: var(--holaf-text-primary, #E0E0E0); }
            .profiler-tab.active {
                background-color: color-mix(in srgb, var(--holaf-text-primary, #E0E0E0) 6%, transparent);
                color: var(--holaf-text-primary, #E0E0E0);
                border-color: var(--holaf-border-color, #3F3F3F);
                font-weight: 600;
            }
            .profiler-tab-content {
                flex: 1;
                display: flex;
                flex-direction: column;
                min-height: 0;
            }

            /* --- Summary Bar --- */
            .profiler-summary-bar {
                display: none;
                align-items: center;
                gap: 8px;
                padding: 8px 20px;
                background-color: color-mix(in srgb, var(--holaf-background-primary, #1E1E1E) 50%, black);
                border-bottom: 1px solid var(--holaf-border-color, #3F3F3F);
                font-family: monospace;
                font-size: 0.9rem;
                color: var(--holaf-text-secondary, #A0A0A0);
            }
            .profiler-summary-bar .summary-label { color: var(--holaf-text-secondary, #A0A0A0); }
            .profiler-summary-bar .summary-value { color: var(--holaf-success-color, #4CAF50); font-weight: bold; }
            .profiler-summary-bar.finished .summary-value { color: var(--holaf-accent-color, #D8700D); }
            .profiler-summary-bar .summary-status { font-family: inherit; font-size: 0.8rem; opacity: 0.7; }

            /* --- History --- */
            .history-toolbar {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 10px 20px;
                background-color: color-mix(in srgb, var(--holaf-background-primary, #1E1E1E) 50%, black);
                border-bottom: 1px solid var(--holaf-border-color, #3F3F3F);
                flex-wrap: wrap;
            }
            .history-table-wrap, .compare-table-wrap {
                flex: 1;
                overflow: auto;
                padding: 20px;
                min-height: 0;
            }
            .empty-state {
                padding: 40px 20px;
                text-align: center;
                color: var(--holaf-text-secondary, #A0A0A0);
            }
            .history-checkbox { cursor: pointer; }
            .history-comment {
                min-width: 140px;
                cursor: text;
                color: var(--holaf-text-secondary, #A0A0A0);
                border-radius: 3px;
            }
            .history-comment:empty::before { content: '${t("pr.addComment")}'; opacity: .5; }
            .history-comment:focus {
                outline: 1px solid var(--holaf-accent-color, #D8700D);
                color: var(--holaf-text-primary, #E0E0E0);
                background-color: color-mix(in srgb, var(--holaf-background-primary, #1E1E1E) 40%, black);
            }

            /* --- Compare --- */
            .compare-toolbar {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 10px 20px;
                background-color: color-mix(in srgb, var(--holaf-background-primary, #1E1E1E) 50%, black);
                border-bottom: 1px solid var(--holaf-border-color, #3F3F3F);
                flex-wrap: wrap;
            }
            .compare-toolbar label {
                color: var(--holaf-text-secondary, #A0A0A0);
                font-size: 0.85rem;
            }
            .compare-toolbar input[type="text"],
            .compare-toolbar input[type="range"] {
                background-color: var(--holaf-input-background, #1A1A1A);
                border: 1px solid var(--holaf-border-color, #3F3F3F);
                color: var(--holaf-text-primary, #E0E0E0);
                padding: 2px 5px;
                border-radius: 3px;
                outline: none;
            }
            .compare-toolbar input[type="text"]:focus { border-color: var(--holaf-accent-color, #D8700D); }
            .compare-metric-select {
                background-color: var(--holaf-input-background, #1A1A1A);
                border: 1px solid var(--holaf-border-color, #3F3F3F);
                color: var(--holaf-text-primary, #E0E0E0);
                padding: 4px 8px;
                border-radius: 3px;
                outline: none;
            }
            .compare-metric-select:focus { border-color: var(--holaf-accent-color, #D8700D); }
            .compare-cell {
                font-family: monospace;
                text-align: right;
                color: var(--holaf-text-secondary, #A0A0A0);
                white-space: nowrap;
            }
            .compare-cell.best  { color: var(--holaf-success-color, #4CAF50); font-weight: bold; }
            .compare-cell.worst { color: var(--holaf-error-color, #F44336); font-weight: bold; }
            .compare-delta.good    { color: var(--holaf-success-color, #4CAF50); }
            .compare-delta.bad     { color: var(--holaf-error-color, #F44336); }
            .compare-delta.neutral { color: var(--holaf-text-secondary, #A0A0A0); }
            .compare-footer-row td {
                font-weight: bold;
                border-top: 2px solid var(--holaf-border-color, #3F3F3F);
                background-color: color-mix(in srgb, var(--holaf-text-primary, #E0E0E0) 3%, transparent);
            }
            .compare-node-name { font-size: 0.85em; }

            /* --- Misc buttons --- */
            .btn-danger { background-color: var(--holaf-error-color, #F44336); }
            .btn-outline {
                background-color: transparent;
                color: var(--holaf-text-secondary, #A0A0A0);
                border: 1px solid var(--holaf-border-color, #3F3F3F);
            }
            .btn-outline:hover { color: var(--holaf-text-primary, #E0E0E0); }
        </style>

        <header class="profiler-header">
            <div class="header-title">
                <h1>${t("pr.title")}</h1>
            </div>
            <div class="header-actions">
                <button id="btn-update-nodes" class="btn btn-secondary">${t("pr.updateNodes")}</button>
                <button id="btn-run-profile" class="btn">${t("pr.runProfile")}</button>
            </div>
        </header>

        <!-- TAB BAR -->
        <div class="profiler-tabs">
            <button class="profiler-tab active" data-tab="live">${t("pr.tabLive")}</button>
            <button class="profiler-tab" data-tab="history">${t("pr.tabHistory")}</button>
            <button class="profiler-tab" data-tab="compare">${t("pr.tabCompare")}</button>
        </div>

        <!-- ============ TAB 1: LIVE PROFILE ============ -->
        <div class="profiler-tab-content" data-tab="live">
            <div class="profiler-summary-bar" id="profiler-summary-bar" style="display:none;">
                <span class="summary-label">${t("pr.summaryTotal")}</span>
                <span class="summary-value" id="summary-total">0.00s</span>
                <span class="summary-status" id="summary-status"></span>
            </div>

            <div class="profiler-toolbar">
                <div class="filter-group">
                    <label title="Only active if at least one node has finished execution">
                        <input type="checkbox" id="chk-hide-non-executed"> ${t("pr.hideNonExecuted")}
                    </label>
                </div>
                <div class="filter-group">
                    <label>${t("pr.minTime")} <span id="lbl-min-time" style="font-weight:bold; color:var(--holaf-success-color, #4CAF50);">0.0s</span></label>
                    <input type="range" id="rng-min-time" min="0" max="5" step="0.1" value="0">
                </div>
                <div class="filter-group">
                    <label>${t("pr.excludeType")}</label>
                    <input type="text" id="inp-filter-type" placeholder="${t("pr.typePlaceholder")}" style="width: 100px;">
                </div>
                <div class="filter-group" style="flex-grow:1; text-align:right;">
                    <span style="font-size:0.8rem; color:var(--holaf-text-secondary);">${t("pr.clickHeaders")}</span>
                </div>
            </div>

            <div class="profiler-content">
                <table class="data-table">
                    <thead>
                        <tr id="table-header-row">
                            <th data-sort="exec_order" class="sortable" style="width:60px;">${t("pr.colOrder")} <span class="sort-icon"></span></th>
                            <th data-sort="id" class="sortable">${t("pr.colId")} <span class="sort-icon"></span></th>
                            <th data-sort="title" class="sortable">${t("pr.colNodeName")} <span class="sort-icon"></span></th>
                            <th data-sort="holaf_group" class="sortable">${t("pr.colGroup")} <span class="sort-icon"></span></th>
                            <th data-sort="type" class="sortable">${t("pr.colType")} <span class="sort-icon"></span></th>
                            <th data-sort="vram" class="sortable col-vram">${t("pr.colVram")} <span class="sort-icon"></span></th>
                            <th data-sort="exec_time" class="sortable col-time">${t("pr.colTime")} <span class="sort-icon"></span></th>
                            <th data-sort="gpu" class="sortable col-gpu">${t("pr.colGpu")} <span class="sort-icon"></span></th>
                        </tr>
                    </thead>
                    <tbody id="profiler-table-body">
                        <tr><td colspan="8" style="text-align:center; color:var(--holaf-text-secondary);">${t("pr.readyUpdate")}</td></tr>
                    </tbody>
                </table>
            </div>
        </div>

        <!-- ============ TAB 2: RUN HISTORY ============ -->
        <div class="profiler-tab-content" data-tab="history" style="display:none;">
            <div class="history-toolbar">
                <h2 style="margin:0; font-size:1rem; flex-grow:1; color:var(--holaf-text-primary, #E0E0E0);">${t("pr.historyTitle")}</h2>
                <button id="btn-refresh-history" class="btn btn-secondary">${t("pr.refresh")}</button>
            </div>
            <div class="history-table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th style="width:36px; text-align:center;"></th>
                            <th>${t("pr.colName")}</th>
                            <th>${t("pr.colTime")}</th>
                            <th>${t("pr.colDate")}</th>
                            <th>${t("pr.colNodes")}</th>
                            <th>${t("pr.colComment")}</th>
                        </tr>
                    </thead>
                    <tbody id="history-table-body">
                        <tr><td colspan="6" class="empty-state">${t("pr.loading")}</td></tr>
                    </tbody>
                </table>
            </div>
            <div class="history-toolbar" style="border-top:1px solid var(--holaf-border-color, #3F3F3F); border-bottom:none;">
                <button id="btn-compare-selected" class="btn" disabled>${t("pr.compareSelected")}</button>
                <button id="btn-delete-selected" class="btn btn-danger" disabled>${t("pr.deleteSelected")}</button>
                <span style="flex-grow:1; font-size:0.8rem; color:var(--holaf-text-secondary, #A0A0A0);" id="history-selection-info">${t("pr.selectionInfo")}</span>
            </div>
        </div>

        <!-- ============ TAB 3: RUN COMPARISON ============ -->
        <div class="profiler-tab-content" data-tab="compare" style="display:none;">
            <div class="compare-toolbar">
                <h2 id="compare-title" style="margin:0; font-size:1rem; flex-grow:1; color:var(--holaf-text-primary, #E0E0E0);">${t("pr.compareTitle")}</h2>
                <label style="display:flex; align-items:center; gap:6px; font-size:0.85rem; color:var(--holaf-text-secondary, #A0A0A0);">
                    ${t("pr.metric")}
                    <select id="compare-metric-select" class="compare-metric-select">
                        <option value="exec_time">${t("pr.optionTime")}</option>
                        <option value="vram_max">${t("pr.optionVramMax")}</option>
                        <option value="gpu_load_max">${t("pr.optionGpuLoadMax")}</option>
                        <option value="gpu_load_avg">${t("pr.optionGpuLoadAvg")}</option>
                    </select>
                </label>
                <div class="filter-group">
                    <label title="Only active if at least one node has finished execution">
                        <input type="checkbox" id="chk-hide-non-executed-cmp"> ${t("pr.hideNonExecuted")}
                    </label>
                </div>
                <div class="filter-group">
                    <label>${t("pr.minTime")} <span id="lbl-min-time-cmp" style="font-weight:bold; color:var(--holaf-success-color, #4CAF50);">0.0s</span></label>
                    <input type="range" id="rng-min-time-cmp" min="0" max="5" step="0.1" value="0">
                </div>
                <div class="filter-group">
                    <label>${t("pr.excludeType")}</label>
                    <input type="text" id="inp-filter-type-cmp" placeholder="${t("pr.typePlaceholder")}" style="width: 100px;">
                </div>
                <button id="btn-compare-back" class="btn btn-outline">${t("pr.back")}</button>
            </div>
            <div class="compare-table-wrap" id="compare-content">
                <div class="empty-state">${t("pr.compareEmpty")}</div>
            </div>
        </div>
    `;

    // --- TAB SYSTEM ---
    function switchTab(name) {
        document.querySelectorAll('.profiler-tab-content').forEach(div => {
            div.style.display = div.dataset.tab === name ? 'flex' : 'none';
        });
        document.querySelectorAll('.profiler-tab').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === name);
        });
        if (name === 'history') {
            loadHistory();
        } else if (name === 'compare') {
            if (comparisonRunIds.length > 0) {
                loadComparison();
            } else {
                const content = document.getElementById('compare-content');
                if (content) content.innerHTML = '<div class="empty-state">' + t('pr.compareEmpty') + '</div>';
            }
        }
    }

    document.querySelectorAll('.profiler-tab').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // --- LIVE PROFILE EVENT LISTENERS ---
    
    const chkNonExec = document.getElementById('chk-hide-non-executed');
    if (chkNonExec) chkNonExec.addEventListener('change', (e) => {
        config.filterNonExecuted = e.target.checked;
        renderTable();
    });

    const rangeTime = document.getElementById('rng-min-time');
    const labelTime = document.getElementById('lbl-min-time');
    if (rangeTime) rangeTime.addEventListener('input', (e) => {
        config.minTime = parseFloat(e.target.value);
        labelTime.textContent = config.minTime.toFixed(1) + "s";
        renderTable();
    });

    const inpType = document.getElementById('inp-filter-type');
    if (inpType) inpType.addEventListener('input', (e) => {
        config.filterTypeExclude = e.target.value.toLowerCase();
        renderTable();
    });

    // --- COMPARE TAB FILTER CONTROLS (share the same config object as the Live Profile) ---
    const chkNonExecCmp = document.getElementById('chk-hide-non-executed-cmp');
    if (chkNonExecCmp) chkNonExecCmp.addEventListener('change', (e) => {
        config.filterNonExecuted = e.target.checked;
        renderComparison();
    });

    const rangeTimeCmp = document.getElementById('rng-min-time-cmp');
    const labelTimeCmp = document.getElementById('lbl-min-time-cmp');
    if (rangeTimeCmp) rangeTimeCmp.addEventListener('input', (e) => {
        config.minTime = parseFloat(e.target.value);
        if (labelTimeCmp) labelTimeCmp.textContent = config.minTime.toFixed(1) + "s";
        renderComparison();
    });

    const inpTypeCmp = document.getElementById('inp-filter-type-cmp');
    if (inpTypeCmp) inpTypeCmp.addEventListener('input', (e) => {
        config.filterTypeExclude = e.target.value.toLowerCase();
        renderComparison();
    });

    document.querySelectorAll('th.sortable').forEach(th => {
        th.addEventListener('click', () => {
            const key = th.dataset.sort;
            if (config.sortBy === key) {
                config.sortDir = config.sortDir === 'asc' ? 'desc' : 'asc';
            } else {
                config.sortBy = key;
                config.sortDir = 'desc'; 
                if (key === 'exec_order' || key === 'id' || key === 'holaf_group') config.sortDir = 'asc';
            }
            renderTable();
        });
    });

    // --- HISTORY EVENT LISTENERS ---
    const btnRefresh = document.getElementById('btn-refresh-history');
    if (btnRefresh) btnRefresh.addEventListener('click', loadHistory);

    const btnCompareSelected = document.getElementById('btn-compare-selected');
    if (btnCompareSelected) {
        btnCompareSelected.addEventListener('click', () => {
            if (selectedRunIds.size < 2) return;
            comparisonRunIds = [...selectedRunIds];
            switchTab('compare');
        });
    }

    const btnDeleteSelected = document.getElementById('btn-delete-selected');
    if (btnDeleteSelected) {
        btnDeleteSelected.addEventListener('click', async () => {
            if (!selectedRunIds.size) return;
            const ids = [...selectedRunIds];
            if (!(await aihConfirm(t('pr.deleteRunConfirm', { count: ids.length })))) return;
            for (const id of ids) {
                try {
                    // HolafFetch lève sur non-2xx (→ catch : log existant).
                    await HolafFetch.delete(`/holaf/profiler/run/${id}`);
                } catch (e) {
                    console.error(`Failed to delete run ${id}:`, e);
                }
            }
            ids.forEach(id => selectedRunIds.delete(id));
            comparisonRunIds = comparisonRunIds.filter(id => !ids.includes(id));
            await loadHistory();
        });
    }

    const historyBody = document.getElementById('history-table-body');
    if (historyBody) {
        // Checkbox selection
        historyBody.addEventListener('change', (e) => {
            const cb = e.target.closest('.history-checkbox');
            if (!cb) return;
            const runId = Number(cb.dataset.runId);
            if (cb.checked) selectedRunIds.add(runId);
            else selectedRunIds.delete(runId);
            updateHistoryActions();
        });

        // View a past run in the Live Profile tab
        historyBody.addEventListener('click', (e) => {
            const btn = e.target.closest('.history-view');
            if (!btn) return;
            viewRun(Number(btn.dataset.runId));
        });

        // Double-click to edit comment inline
        historyBody.addEventListener('dblclick', (e) => {
            const cell = e.target.closest('.history-comment');
            if (!cell) return;
            cell.contentEditable = 'true';
            cell.focus();
            const range = document.createRange();
            range.selectNodeContents(cell);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        });

        // Save comment on blur
        historyBody.addEventListener('focusout', (e) => {
            const cell = e.target.closest('.history-comment');
            if (!cell || !cell.isContentEditable) return;
            const runId = Number(cell.dataset.runId);
            const comment = cell.textContent.trim();
            cell.contentEditable = 'false';
            // Fire-and-forget conservé (+ .catch, même log qu'avant) ; le try
            // protège uniquement le cas (théorique) brique non chargée.
            try {
                HolafFetch.patch(`/holaf/profiler/run/${runId}/comment`, { body: { comment } })
                    .catch(err => console.error('Comment update failed:', err));
            } catch (err) {
                console.error('Comment update failed:', err);
            }
        });

        // Enter to save, Escape to cancel editing
        historyBody.addEventListener('keydown', (e) => {
            const cell = e.target.closest('.history-comment');
            if (!cell || !cell.isContentEditable) return;
            if (e.key === 'Enter' || e.key === 'Escape') {
                e.preventDefault();
                cell.blur();
            }
        });
    }

    // --- COMPARE EVENT LISTENERS ---
    const metricSelect = document.getElementById('compare-metric-select');
    if (metricSelect) {
        metricSelect.addEventListener('change', (e) => {
            compareMetric = e.target.value;
            if (compareData) renderComparison();
        });
    }

    const btnCompareBack = document.getElementById('btn-compare-back');
    if (btnCompareBack) {
        btnCompareBack.addEventListener('click', () => switchTab('history'));
    }

    // --- HELPERS ---

    function esc(str) {
        return String(str ?? '').replace(/[&<>"']/g, c => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    function formatBytes(bytes) {
        if (!+bytes) return '-';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
    }

    function formatTime(seconds) {
        if (seconds === undefined || seconds === null) return '-';
        if (seconds < 1) return (seconds * 1000).toFixed(1) + " ms";
        return seconds.toFixed(2) + " s";
    }

    function formatOrder(num) {
        if (!num) return '-';
        return num.toString().padStart(3, '0');
    }

    function formatTimestamp(ts) {
        if (ts === null || ts === undefined || isNaN(ts)) return '-';
        const d = new Date(Number(ts) * 1000);
        if (isNaN(d.getTime())) return '-';
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function formatMetric(value, metric) {
        if (value === null || value === undefined || isNaN(value)) return '-';
        if (metric === 'exec_time') return formatTime(value);
        if (metric === 'vram_max') return formatBytes(value);
        return Number(value).toFixed(1) + '%';
    }

    function formatDelta(delta, metric) {
        if (delta === null || delta === undefined || isNaN(delta)) return '-';
        const sign = delta > 0 ? '+' : '';
        if (metric === 'exec_time') {
            if (Math.abs(delta) < 1) return `${sign}${delta.toFixed(1)} ms`;
            return `${sign}${delta.toFixed(2)} s`;
        }
        if (metric === 'vram_max') {
            const abs = Math.abs(delta);
            return `${delta > 0 ? '+' : (delta < 0 ? '-' : '±')}${formatBytes(abs)}`;
        }
        return `${delta > 0 ? '+' : (delta < 0 ? '-' : '±')}${Math.abs(delta).toFixed(1)}%`;
    }

    // Multi-level subgraph name resolution (uses the live nodesMap)
    function resolveNodeName(nodeId, nodeData) {
        const idStr = String(nodeId);
        if (!idStr.includes(':')) {
            return nodeData.title || nodeData.type || t("pr.unknown");
        }
        const parts = idStr.split(':');
        const breadcrumb = [];
        let prefix = "";
        for (let i = 0; i < parts.length - 1; i++) {
            prefix = prefix ? `${prefix}:${parts[i]}` : parts[i];
            const parent = nodesMap.get(prefix);
            breadcrumb.push(parent ? (parent.title || parent.type) : `?${parts[i]}`);
        }
        const leafName = nodeData.title || nodeData.type || t('pr.nodeLabel', { id: parts[parts.length - 1] });
        return `<span style="opacity:0.5">${breadcrumb.join(' › ')} ›</span> ${leafName}`;
    }

    // Same logic but against an arbitrary map (used by the Compare tab)
    function resolveNodeNameFromMap(nodeId, nodeData, map) {
        const idStr = String(nodeId);
        if (!idStr.includes(':')) {
            return nodeData.title || nodeData.type || t("pr.unknown");
        }
        const parts = idStr.split(':');
        const breadcrumb = [];
        let prefix = "";
        for (let i = 0; i < parts.length - 1; i++) {
            prefix = prefix ? `${prefix}:${parts[i]}` : parts[i];
            const parent = map.get(prefix);
            breadcrumb.push(parent ? (parent.title || parent.type) : `?${parts[i]}`);
        }
        const leafName = nodeData.title || nodeData.type || t('pr.nodeLabel', { id: parts[parts.length - 1] });
        return `<span style="opacity:0.5">${breadcrumb.join(' › ')} ›</span> ${leafName}`;
    }

    function applyGroupsAndRender() {
        if (nodesMap.size > 0 && Object.keys(groupMapping).length > 0) {
            nodesMap.forEach((node, id) => {
                if (groupMapping[id]) {
                    node.holaf_group = groupMapping[id];
                }
            });
            renderTable();
        }
    }

    // --- SUMMARY BAR ---
    function updateSummaryBar(totalTime) {
        const bar = document.getElementById('profiler-summary-bar');
        const value = document.getElementById('summary-total');
        const status = document.getElementById('summary-status');
        if (!bar || !value) return;

        const hasTotal = totalTime !== null && totalTime !== undefined && totalTime > 0;
        value.textContent = hasTotal ? formatTime(totalTime) : '0.00s';
        bar.classList.toggle('finished', hasTotal);
        bar.style.display = 'flex';
        if (status) status.textContent = hasTotal ? t('pr.summaryCompleted') : t('pr.summaryProfiling');
    }

    // --- RENDER LOGIC ---

    function updateHeaderIcons() {
        document.querySelectorAll('th.sortable').forEach(th => {
            const iconSpan = th.querySelector('.sort-icon');
            if (!iconSpan) return;
            th.style.color = "";
            iconSpan.textContent = "";

            if (th.dataset.sort === config.sortBy) {
                th.style.color = "var(--holaf-text-primary)";
                iconSpan.textContent = config.sortDir === 'asc' ? ' ▲' : ' ▼';
                iconSpan.style.color = "var(--holaf-success-color, #4CAF50)";
            }
        });
    }

    // Keep both the Live Profile and Compare tab filter controls in sync with config
    function syncFilterControls() {
        const chk = document.getElementById('chk-hide-non-executed');
        if (chk) chk.checked = config.filterNonExecuted;
        const rng = document.getElementById('rng-min-time');
        if (rng) rng.value = config.minTime;
        const lbl = document.getElementById('lbl-min-time');
        if (lbl) lbl.textContent = config.minTime.toFixed(1) + "s";
        const inp = document.getElementById('inp-filter-type');
        if (inp) inp.value = config.filterTypeExclude;

        const chkCmp = document.getElementById('chk-hide-non-executed-cmp');
        if (chkCmp) chkCmp.checked = config.filterNonExecuted;
        const rngCmp = document.getElementById('rng-min-time-cmp');
        if (rngCmp) rngCmp.value = config.minTime;
        const lblCmp = document.getElementById('lbl-min-time-cmp');
        if (lblCmp) lblCmp.textContent = config.minTime.toFixed(1) + "s";
        const inpCmp = document.getElementById('inp-filter-type-cmp');
        if (inpCmp) inpCmp.value = config.filterTypeExclude;
    }

    function renderTable() {
        updateHeaderIcons();
        syncFilterControls();

        const tbody = document.getElementById('profiler-table-body');
        if (!tbody) return;

        const rows = [];
        nodesMap.forEach((data, id) => {
            rows.push({ id: id, ...data });
        });

        if (rows.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:#777;">' + t('pr.noNodesData') + '</td></tr>';
            return;
        }

        const excludeTypes = config.filterTypeExclude.split(',').map(s => s.trim()).filter(s => s);
        const anyNodeExecuted = rows.some(r => (r.exec_time || 0) > 0);

        // --- FILTERING ---
        const filteredRows = rows.filter(row => {
            if (config.filterNonExecuted && anyNodeExecuted) {
                if (!row.exec_time || row.exec_time <= 0) return false;
            }
            
            const t = row.exec_time || 0;
            if (t > 0 && t < config.minTime) return false;

            if (excludeTypes.length > 0) {
                const rowType = (row.type || "").toLowerCase();
                for (let ex of excludeTypes) {
                    if (rowType.includes(ex)) return false;
                }
            }
            return true;
        });

        // --- SORTING ---
        filteredRows.sort((a, b) => {
            let valA = a[config.sortBy];
            let valB = b[config.sortBy];

            if (config.sortBy === 'exec_order') {
                if (!valA) valA = 999999;
                if (!valB) valB = 999999;
            } else {
                if (valA === undefined) valA = 0;
                if (valB === undefined) valB = 0;
            }
            
            if (['title', 'type', 'holaf_group'].includes(config.sortBy)) {
                valA = (valA || "").toString().toLowerCase();
                valB = (valB || "").toString().toLowerCase();
                if (valA < valB) return config.sortDir === 'asc' ? -1 : 1;
                if (valA > valB) return config.sortDir === 'asc' ? 1 : -1;
                return 0;
            }
            return config.sortDir === 'asc' ? valA - valB : valB - valA;
        });

        // --- HTML GEN ---
        tbody.innerHTML = filteredRows.map(row => {
            const isSubNode = String(row.id).includes(':');
            const rowStyle = isSubNode ? 'background-color: color-mix(in srgb, var(--holaf-text-primary) 2%, transparent);' : '';
            const finishedStyle = row.exec_time ? 'background-color: color-mix(in srgb, var(--holaf-success-color) 10%, transparent);' : '';
            
            const groupBadge = row.holaf_group 
                ? `<span class="badge-group">${row.holaf_group}</span>` 
                : '<span style="color:var(--holaf-border-color)">-</span>';

            const orderBadge = row.exec_order
                ? `<span style="font-family:monospace; color:var(--holaf-success-color);">${formatOrder(row.exec_order)}</span>`
                : `<span style="color:var(--holaf-border-color)">-</span>`;

            let gpuDisplay = "-";
            if (row.gpu_load_max !== undefined && row.gpu_load_max !== null) {
                gpuDisplay = row.gpu_load_max + "%";
            }

            return `
                <tr style="${rowStyle} ${finishedStyle}">
                    <td style="text-align:center;">${orderBadge}</td>
                    <td>${row.id}</td>
                    <td>${resolveNodeName(row.id, row)}</td>
                    <td>${groupBadge}</td>
                    <td style="font-size:0.85em; color:var(--holaf-text-secondary)">${row.type}</td>
                    <td class="metric-cell vram">${formatBytes(row.vram_max)}</td>
                    <td class="metric-cell time">${formatTime(row.exec_time)}</td>
                    <td class="metric-cell gpu">${gpuDisplay}</td>
                </tr>
            `;
        }).join('');
    }

    // --- NETWORK ACTIONS ---

    async function refreshContextView() {
        try {
            const saved = localStorage.getItem('holaf_profiler_groups');
            if (saved) groupMapping = JSON.parse(saved);

            // HolafFetch lève sur non-2xx (→ catch : log existant, comme
            // l'ancien throw « Context fetch failed »).
            const data = await HolafFetch.get('/holaf/profiler/context');

            if (data.nodes && Array.isArray(data.nodes)) {
                nodesMap.clear();

                data.nodes.forEach(node => {
                    nodesMap.set(String(node.id), {
                        id: String(node.id),
                        title: node.title,
                        type: node.type,
                        mode: node.mode,
                        holaf_group: groupMapping[String(node.id)] || null,
                        exec_order: null,
                        vram_max: 0,
                        exec_time: 0,
                        gpu_load_max: 0
                    });
                });
                renderTable();
            }
        } catch (e) {
            console.error("Error fetching context:", e);
        }
    }

    // Apply a run's steps to nodesMap (shared by live polling and historical "View")
    function applyStepsToMap(steps) {
        let newNodesAdded = 0;
        if (!Array.isArray(steps)) return newNodesAdded;
        steps.forEach(step => {
            const idStr = String(step.node_id);
            let nodeData = nodesMap.get(idStr);
            
            if (!nodeData) {
                nodeData = {
                    id: idStr,
                    title: step.node_title || t("pr.unknown"),
                    type: step.node_type || t("pr.unknown"),
                    holaf_group: groupMapping[idStr] || null, 
                    mode: 0,
                    exec_order: null,
                    vram_max: 0, exec_time: 0, gpu_load_max: 0
                };
                if (!nodeData.holaf_group && idStr.includes(':')) {
                    const parentId = idStr.split(':')[0];
                    const parent = nodesMap.get(parentId);
                    if (parent && parent.holaf_group) nodeData.holaf_group = parent.holaf_group;
                }
                nodesMap.set(idStr, nodeData);
                newNodesAdded++;
            }

            nodeData.vram_max = step.vram_max;
            nodeData.exec_time = step.exec_time;
            nodeData.gpu_load_max = step.gpu_load_max;
            if (step.gpu_load_avg !== undefined) nodeData.gpu_load_avg = step.gpu_load_avg;
            
            if (step.exec_time > 0 && !nodeData.exec_order) {
                executionCounter++;
                nodeData.exec_order = executionCounter;
            }
        });
        return newNodesAdded;
    }

    async function pollRunData() {
        if (!currentRunId) return;
        try {
            // HolafFetch lève sur non-2xx (→ catch ci-dessous, même sémantique).
            const data = await HolafFetch.get(`/holaf/profiler/run/${currentRunId}`);
            let newNodesAdded = 0;

            if (data.steps && Array.isArray(data.steps)) {
                newNodesAdded = applyStepsToMap(data.steps);
                renderTable();
            }

            // --- AUTO-STOP DETECTION ---
            const stepCount = (data.steps && data.steps.length) || 0;

            // Track the last time we observed real progress (a new node OR a step-count
            // change). During a long-running single node (e.g. a ~140s sampler) the step
            // count stays constant, so this must NOT be used as a finish signal — it only
            // feeds the generous stuck-run safety timeout below.
            if (newNodesAdded > 0 || stepCount !== lastStepCount) {
                lastProgressTime = Date.now();
            }
            lastStepCount = stepCount;

            // Fetch run metadata for total_time (authoritative finish signal)
            let totalTime = null;
            try {
                // HolafFetch lève sur non-2xx (→ catch : ignore, comme avant).
                const metaData = await HolafFetch.get(`/holaf/profiler/run/${currentRunId}/meta`);
                if (metaData.run) totalTime = metaData.run.total_time;
            } catch (e) {}

            updateSummaryBar(totalTime);

            // The ONLY authoritative finish signal is the backend's total_time: it stays
            // null/0 while the run is in progress and becomes >0 once the backend finalizes
            // the run on the real end-of-run events
            // (execution_success/error/interrupted/finished).
            const finished = (totalTime !== null && totalTime !== undefined && totalTime > 0);

            if (finished) {
                stopPolling(totalTime);
                return;
            }

            // Generous safety net: never poll forever if the backend somehow never finalizes
            // the run. 10 minutes without any progress (no new node, no step-count change)
            // means the run is genuinely stuck — this will NOT trigger during long samplers
            // (10 min >> 140s).
            if (lastProgressTime && (Date.now() - lastProgressTime) > 600000) {
                console.warn("Run polling timeout (no progress for 10 min) — run may still be active; check History.");
                stopPolling(totalTime);
            }
        } catch (e) {
            // Ancien « if (!resp.ok) return; » : un non-2xx (run pas encore
            // visible…) était ignoré silencieusement ; seule l'erreur réseau
            // loggait.
            if (isFetchError(e) && e.status > 0) return;
            console.error("Polling error:", e);
        }
    }

    function stopPolling(finalTotal) {
        if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
        }
        runFinished = true;
        if (finalTotal !== null && finalTotal !== undefined && finalTotal > 0) {
            currentTotalTime = finalTotal;
        }
        updateSummaryBar(currentTotalTime);
        // Refresh history so the completed run shows up in the list
        loadHistory();
    }

    const btnUpdate = document.getElementById('btn-update-nodes');
    if (btnUpdate) {
        btnUpdate.addEventListener('click', async () => {
            const originalText = btnUpdate.innerText;

            // Update-nodes relies on the live group-sync bridge talking to the
            // main ComfyUI tab. If the bridge could not be loaded (inert stub),
            // degrade clearly instead of silently doing nothing.
            if (!comfyBridgeActive) {
                console.warn("[Holaf Profiler] Update Nodes skipped: holaf_comfy_bridge.js is not available (live group-sync disabled).");
                await aihConfirm(t('pr.bridgeDisabledMsg'));
                await refreshContextView();
                return;
            }

            btnUpdate.innerText = t('pr.syncing');
            btnUpdate.disabled = true;

            bridge.send('get_workflow_for_profiler');
            
            setTimeout(async () => {
                await refreshContextView();
                btnUpdate.innerText = originalText;
                btnUpdate.disabled = false;
            }, 800);
        });
    }

    const btnRun = document.getElementById('btn-run-profile');
    if (btnRun) {
        btnRun.addEventListener('click', async () => {
            const runName = await aihPrompt(t('pr.runNamePrompt'), "", t('pr.defaultRunNamePrefix') + " " + new Date().toLocaleTimeString());
            executionCounter = 0;
            nodesMap.forEach(node => {
                node.vram_max = 0;
                node.exec_time = 0;
                node.exec_order = null;
                node.gpu_load_max = 0;
            });
            renderTable();

            // Reset polling / auto-stop state
            lastStepCount = null;
            lastProgressTime = Date.now();
            runFinished = false;
            currentTotalTime = null;
            updateSummaryBar(null);

            try {
                // HolafFetch lève sur non-2xx (→ catch : log existant).
                const data = await HolafFetch.post('/holaf/profiler/run-start', { body: { name: runName } });
                if (data.status === 'ok') {
                    currentRunId = data.run_id;
                    bridge.send('queue_prompt');
                    if (pollInterval) clearInterval(pollInterval);
                    pollInterval = setInterval(pollRunData, 1000);
                }
            } catch (e) { console.error("Run start failed:", e); }
        });
    }

    // ============ TAB 2: RUN HISTORY ============

    function updateHistoryActions() {
        const btnCompare = document.getElementById('btn-compare-selected');
        const btnDelete = document.getElementById('btn-delete-selected');
        const info = document.getElementById('history-selection-info');
        if (btnCompare) btnCompare.disabled = selectedRunIds.size < 2;
        if (btnDelete) btnDelete.disabled = selectedRunIds.size === 0;
        if (info) {
            if (selectedRunIds.size === 0) info.textContent = t('pr.selectionInfo');
            else if (selectedRunIds.size === 1) info.textContent = t('pr.oneRunSelected');
            else info.textContent = t('pr.runsSelected', { count: selectedRunIds.size });
        }
    }

    // Load a past run's steps into the live profile table, identical to a live run
    async function viewRun(runId) {
        if (!runId) return;
        try {
            // HolafFetch lève sur non-2xx (→ catch : log existant).
            const data = await HolafFetch.get(`/holaf/profiler/run/${runId}`);

            // Reset order/metrics so the historical run renders faithfully, but keep
            // nodesMap entries (context names) so breadcrumbs still resolve for
            // compound ids like "1131:1113".
            executionCounter = 0;
            nodesMap.forEach(node => {
                node.exec_order = null;
                node.vram_max = 0;
                node.exec_time = 0;
                node.gpu_load_max = 0;
            });

            if (data.steps && Array.isArray(data.steps)) {
                applyStepsToMap(data.steps);
            }

            // Fetch total_time from meta (same endpoint pollRunData uses)
            let totalTime = null;
            try {
                // HolafFetch lève sur non-2xx (→ catch : ignore, comme avant).
                const metaData = await HolafFetch.get(`/holaf/profiler/run/${runId}/meta`);
                if (metaData.run) totalTime = metaData.run.total_time;
            } catch (e) {}

            switchTab('live');
            renderTable();
            updateSummaryBar(totalTime);
        } catch (e) {
            console.error(`Failed to view run ${runId}:`, e);
        }
    }

    async function loadHistory() {
        const tbody = document.getElementById('history-table-body');
        const btnRefresh = document.getElementById('btn-refresh-history');
        if (!tbody) return;
        if (btnRefresh) btnRefresh.disabled = true;
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">' + t('pr.loading') + '</td></tr>';
        try {
            // HolafFetch lève sur non-2xx (→ catch : message i18n existant).
            const data = await HolafFetch.get('/holaf/profiler/runs?limit=50&offset=0');
            historyRuns = data.runs || [];
            renderHistory();
        } catch (e) {
            // Ancien comportement conservé : échec HTTP → message i18n seul ;
            // erreur réseau → détail technique affiché.
            const detail = isFetchError(e) ? '' : esc(e.message);
            tbody.innerHTML = `<tr><td colspan="6" class="empty-state">${t('pr.failedLoadRuns', { message: detail })}</td></tr>`;
        } finally {
            if (btnRefresh) btnRefresh.disabled = false;
        }
    }

    function renderHistory() {
        const tbody = document.getElementById('history-table-body');
        if (!tbody) return;

        if (!historyRuns.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty-state">' + t('pr.noRunsYet') + '</td></tr>';
            updateHistoryActions();
            return;
        }

        tbody.innerHTML = historyRuns.map(run => {
            const id = run.id;
            const checked = selectedRunIds.has(id) ? 'checked' : '';
            const comment = run.global_comment || '';
            return `
                <tr>
                    <td style="text-align:center;"><input type="checkbox" class="history-checkbox" data-run-id="${id}" ${checked}></td>
                    <td>
                        <button class="btn btn-outline history-view" data-run-id="${id}" title="${t('pr.viewTitle')}" style="padding:2px 8px; font-size:0.8rem; margin-right:8px;">${t('pr.view')}</button>
                        ${esc(run.name || t('pr.runLabel', { id }))}
                    </td>
                    <td class="metric-cell">${formatTime(run.total_time)}</td>
                    <td class="metric-cell" style="font-size:0.85em;">${formatTimestamp(run.timestamp)}</td>
                    <td class="metric-cell">${run.node_count ?? '-'}</td>
                    <td class="history-comment" data-run-id="${id}" contenteditable="false">${esc(comment)}</td>
                </tr>
            `;
        }).join('');

        updateHistoryActions();
    }

    // ============ TAB 3: RUN COMPARISON ============

    async function loadComparison() {
        const container = document.getElementById('compare-content');
        if (!container) return;

        if (!comparisonRunIds.length) {
            container.innerHTML = '<div class="empty-state">' + t('pr.compareEmpty') + '</div>';
            return;
        }

        container.innerHTML = '<div class="empty-state">' + t('pr.loadingComparison') + '</div>';

        try {
            // HolafFetch lève sur non-2xx (→ catch : message i18n existant).
            const data = await HolafFetch.post('/holaf/profiler/compare', { body: { run_ids: comparisonRunIds } });
            compareData = data;
            renderComparison();
        } catch (e) {
            // Ancien comportement conservé : échec HTTP → message i18n dédié ;
            // erreur réseau → détail technique affiché.
            const msg = isFetchError(e) ? t('pr.compareRequestFailed') : e.message;
            container.innerHTML = `<div class="empty-state">${t('pr.compareFailed', { message: esc(msg) })}</div>`;
        }
    }

    // Applies the same config filters as renderTable to a unified compare node.
    // The compare table shows every run in a single row, so a step that would be
    // hidden by a filter in any one run is hidden from all runs (consistent rows).
    function compareNodePassesFilters(entry, anyNodeExecuted) {
        const excludeTypes = config.filterTypeExclude.split(',').map(s => s.trim()).filter(s => s);
        const runValues = Object.values(entry.values);

        // filterNonExecuted: hide nodes that never executed in the compared runs
        if (config.filterNonExecuted && anyNodeExecuted) {
            for (const v of runValues) {
                const t = v ? (v.exec_time || 0) : 0;
                if (t <= 0) return false;
            }
        }

        // minTime: hide a node if any run's positive exec_time is below the threshold
        for (const v of runValues) {
            const t = v ? (v.exec_time || 0) : 0;
            if (t > 0 && t < config.minTime) return false;
        }

        // type exclude
        if (excludeTypes.length > 0) {
            const rowType = (entry.type || "").toLowerCase();
            for (const ex of excludeTypes) {
                if (rowType.includes(ex)) return false;
            }
        }
        return true;
    }

    function renderComparison() {
        const container = document.getElementById('compare-content');
        if (!container) return;

        if (!compareData || !compareData.runs || !compareData.runs.length) {
            container.innerHTML = '<div class="empty-state">' + t('pr.noCompareData') + '</div>';
            return;
        }

        const runs = compareData.runs;
        const steps = compareData.steps || [];
        const runOrder = runs.map(r => String(r.run_id));
        const metric = compareMetric;

        syncFilterControls();

        // Rebuild the name map from step titles
        compareNodesMap.clear();

        // Unified map: node_id -> { title, type, values: { runId: {exec_time, vram_max, gpu_load_max, gpu_load_avg} } }
        const unified = new Map();
        steps.forEach(step => {
            const idStr = String(step.node_id);
            compareNodesMap.set(idStr, { title: step.node_title, type: step.node_type });
            if (!unified.has(idStr)) {
                unified.set(idStr, { title: step.node_title, type: step.node_type, values: {} });
            }
            unified.get(idStr).values[step.run_id] = {
                exec_time: step.exec_time,
                vram_max: step.vram_max,
                gpu_load_max: step.gpu_load_max,
                gpu_load_avg: step.gpu_load_avg
            };
        });

        // Title
        const title = document.getElementById('compare-title');
        if (title) {
            title.textContent = t('pr.comparisonColon') + runs.map(r => (
                (r.meta && r.meta.name) ? r.meta.name : t('pr.runLabel', { id: r.run_id })
            )).join(t('pr.vs'));
        }

        // Rows (respect the shared Live Profile filters from config)
        const anyNodeExecuted = [...unified.values()].some(entry =>
            Object.values(entry.values).some(v => v && (v.exec_time || 0) > 0)
        );
        const filterActive = config.filterNonExecuted || config.minTime > 0 || config.filterTypeExclude !== '';

        const rowsHtml = [];
        unified.forEach((entry, nodeId) => {
            if (!compareNodePassesFilters(entry, anyNodeExecuted)) return;
            rowsHtml.push(renderCompareRow(nodeId, entry, runOrder, metric));
        });
        if (rowsHtml.length === 0) {
            rowsHtml.push(`<tr><td colspan="${runOrder.length + 2}" class="empty-state">${filterActive ? t('pr.noNodesMatchFilter') : t('pr.noNodesFound')}</td></tr>`);
        }

        // Footer (summary)
        const footerHtml = renderCompareFooter(runs, runOrder);

        container.innerHTML = `
            <table class="data-table">
                <thead>
                    <tr>
                        <th>${t('pr.node')}</th>
                        ${runs.map(r => `<th>${esc((r.meta && r.meta.name) ? r.meta.name : t('pr.runLabel', { id: r.run_id }))}</th>`).join('')}
                        <th>Δ</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml.join('')}
                </tbody>
                <tfoot>
                    ${footerHtml}
                </tfoot>
            </table>
        `;
    }

    function renderCompareRow(nodeId, entry, runOrder, metric) {
        const values = runOrder.map(rid => {
            const v = entry.values[rid];
            return v ? v[metric] : null;
        });

        // Best / worst coloring across the runs that have a value
        let best = null, worst = null;
        values.forEach(v => {
            if (v === null || v === undefined) return;
            if (best === null || v < best) best = v;
            if (worst === null || v > worst) worst = v;
        });

        const name = resolveNodeNameFromMap(nodeId, entry, compareNodesMap);

        const cells = values.map((v, i) => {
            let cls = 'compare-cell';
            if (v !== null && v !== undefined) {
                if (best !== null && v === best) cls += ' best';
                if (worst !== null && v === worst && worst !== best) cls += ' worst';
            }
            return `<td class="${cls}">${formatMetric(v, metric)}</td>`;
        }).join('');

        // Delta between the first two selected runs (later run minus earlier run)
        const first = values[0];
        const second = values[1];
        let deltaHtml = '<td class="compare-cell compare-delta neutral">-</td>';
        if (first !== null && first !== undefined && second !== null && second !== undefined) {
            const delta = second - first;
            const cls = delta < 0 ? 'good' : (delta > 0 ? 'bad' : 'neutral');
            deltaHtml = `<td class="compare-cell compare-delta ${cls}">${formatDelta(delta, metric)}</td>`;
        }

        return `<tr><td class="compare-node-name">${name}</td>${cells}${deltaHtml}</tr>`;
    }

    function renderCompareFooter(runs, runOrder) {
        const rows = [];

        // TOTAL TIME (sum exec_time)
        rows.push(buildCompareFooterRow(
            t('pr.totalTime'),
            runs,
            r => (r.summary && r.summary.total_exec_time !== null && r.summary.total_exec_time !== undefined) ? r.summary.total_exec_time : null,
            'exec_time'
        ));

        // VRAM MAX
        rows.push(buildCompareFooterRow(
            t('pr.vramMax'),
            runs,
            r => (r.summary && r.summary.max_vram) ? r.summary.max_vram : null,
            'vram_max'
        ));

        // GPU AVG
        rows.push(buildCompareFooterRow(
            t('pr.gpuAvg'),
            runs,
            r => (r.summary && r.summary.avg_gpu !== null && r.summary.avg_gpu !== undefined) ? r.summary.avg_gpu : null,
            'gpu_load_avg'
        ));

        return rows.join('');
    }

    function buildCompareFooterRow(label, runs, getter, metric) {
        const values = runs.map(r => {
            const v = getter(r);
            return (v === null || v === undefined) ? null : v;
        });

        const first = values[0];
        const second = values[1];
        let deltaHtml = '<td class="compare-cell compare-delta neutral">-</td>';
        if (first !== null && second !== null) {
            const delta = second - first;
            const cls = delta < 0 ? 'good' : (delta > 0 ? 'bad' : 'neutral');
            deltaHtml = `<td class="compare-cell compare-delta ${cls}">${formatDelta(delta, metric)}</td>`;
        }

        const cells = values.map(v => `<td class="compare-cell">${formatMetric(v, metric)}</td>`).join('');
        return `<tr class="compare-footer-row"><td>${label}</td>${cells}${deltaHtml}</tr>`;
    }

    // --- INITIAL LOAD ---
    switchTab('live');
}
