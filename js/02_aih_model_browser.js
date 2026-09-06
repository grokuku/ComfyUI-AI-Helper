/**
 * AIH Model Browser — Parcourir, uploader et télécharger des modèles.
 *
 * Dépend : 01_aih_modal_v2.js (aihOpenModalV2)
 *           aih_elements_widget.js (esc, getApiUrl, getApiKey, apiHeaders)
 *
 * Fonctions exportées sur window :
 *   - openModelBrowser()    → ouvre la fenêtre Model Browser
 */

import "./aih_dialog.js";
import "./aih_strings.js";

(function () {
    "use strict";

    // ─── Helper i18n central : traduit via AIH.I18n (clé brute si absente) ──────
    var t = function (key, params) {
        var I = window.AIH && window.AIH.I18n;
        return I && typeof I.t === "function" ? I.t(key, params) : key;
    };

    // ─── Injection CSS (une seule fois) ──────────────────────────────────────────
    var _cssInjected = false;
    function _mbInjectCSS() {
        if (_cssInjected) return;
        _cssInjected = true;
        var style = document.createElement("style");
        style.textContent = [
            /* Filtres */
            ".mb-filters {",
            "  display: flex;",
            "  flex-wrap: wrap;",
            "  gap: 6px;",
            "  padding: 8px 0;",
            "  align-items: center;",
            "  flex-shrink: 0;",
            "}",
            ".mb-filters .mb-filter-checkbox {",
            "  display: inline-flex;",
            "  align-items: center;",
            "  gap: 4px;",
            "  font-size: 11px;",
            "  cursor: pointer;",
            "  padding: 2px 8px;",
            "  border-radius: 4px;",
            "  border: 1px solid #444;",
            "  background: #1e1e22;",
            "  color: #ccc;",
            "  user-select: none;",
            "  transition: background 0.15s, border-color 0.15s;",
            "}",
            ".mb-filters .mb-filter-checkbox:hover {",
            "  background: #2a2a2e;",
            "  border-color: #666;",
            "}",
            ".mb-filters .mb-filter-checkbox.active {",
            "  border-color: var(--mb-color, var(--aih-accent, #D8700D));",
            "  background: var(--mb-color, var(--aih-accent, #D8700D));",
            "  color: #fff;",
            "}",
            ".mb-filters .mb-filter-checkbox input {",
            "  display: none;",
            "}",
            ".mb-filters .mb-filter-search {",
            "  display: flex;",
            "  align-items: center;",
            "  gap: 4px;",
            "  margin-left: auto;",
            "}",
            ".mb-filters .mb-filter-search input {",
            "  padding: 4px 8px;",
            "  border-radius: 4px;",
            "  border: 1px solid #444;",
            "  background: #1e1e22;",
            "  color: #ccc;",
            "  font-size: 11px;",
            "  width: 120px;",
            "  outline: none;",
            "}",
            ".mb-filter-search input:focus {",
            "  border-color: var(--aih-accent, #D8700D);",
            "}",
            /* Panneaux */
            ".mb-panels {",
            "  display: flex;",
            "  flex: 1;",
            "  gap: 8px;",
            "  min-height: 0;",
            "}",
            ".mb-panel {",
            "  flex: 1;",
            "  display: flex;",
            "  flex-direction: column;",
            "  min-width: 0;",
            "}",
            ".mb-panel-header {",
            "  font-size: 11px;",
            "  color: #888;",
            "  padding: 4px 0;",
            "  font-weight: 600;",
            "  flex-shrink: 0;",
            "}",
            ".mb-panel-list {",
            "  flex: 1;",
            "  overflow-y: auto;",
            "  border: 1px solid #444;",
            "  border-radius: 6px;",
            "  background: #1e1e22;",
            "}",
            ".mb-panel-list .mb-empty {",
            "  padding: 20px;",
            "  text-align: center;",
            "  color: #666;",
            "  font-size: 12px;",
            "}",
            ".mb-panel-list .mb-loading {",
            "  padding: 20px;",
            "  text-align: center;",
            "  color: #888;",
            "  font-size: 12px;",
            "}",
            /* Items */
            ".mb-item {",
            "  padding: 6px 8px;",
            "  cursor: pointer;",
            "  font-size: 12px;",
            "  color: #ccc;",
            "  border-bottom: 1px solid #333;",
            "  display: flex;",
            "  align-items: center;",
            "  gap: 6px;",
            "  position: relative;",
            "}",
            ".mb-item:hover {",
            "  background: #2a2a2e;",
            "}",
            ".mb-item.selected {",
            "  background: #2a2a4e;",
            "  border-left: 3px solid var(--aih-accent, #D8700D);",
            "}",
            ".mb-item .mb-badge {",
            "  font-size: 9px;",
            "  padding: 1px 4px;",
            "  border-radius: 3px;",
            "  font-weight: 600;",
            "  flex-shrink: 0;",
            "  color: #fff;",
            "}",
            ".mb-item .mb-name {",
            "  flex: 1;",
            "  overflow: hidden;",
            "  text-overflow: ellipsis;",
            "  white-space: nowrap;",
            "}",
            ".mb-path { font-size: 10px; color: #666; display: block; margin-top: 1px; }",
            ".mb-checkbox { margin-right: 6px; flex-shrink: 0; accent-color: var(--aih-accent, #D8700D); }",
            /* Footers */
            ".mb-panel-footer {",
            "  display: flex;",
            "  align-items: center;",
            "  gap: 6px;",
            "  padding: 6px 0 0;",
            "  flex-shrink: 0;",
            "}",
            ".mb-panel-footer-remote { justify-content: flex-start; }",
            ".mb-panel-footer-local { justify-content: flex-end; }",
            ".mb-batch-btn { padding: 6px 12px; border-radius: 6px; border: none; font-size: 11px; cursor: pointer; font-weight: 600; transition: all 0.15s; }",
            ".mb-batch-btn:disabled { opacity: 0.4; cursor: default; }",
            ".mb-batch-upload { background: var(--aih-accent, #D8700D); color: #fff; }",
            ".mb-batch-download { background: #22c55e; color: #fff; }",
            /* Destination input — toujours visible, 80px */
            ".mb-dest-input { width: 80px; padding: 2px 4px; border-radius: 3px; border: 1px solid #555; background: #1e1e22; color: #ccc; font-size: 10px; outline: none; flex-shrink: 0; }",
            ".mb-dest-input:focus { border-color: var(--aih-accent, #D8700D); }",
            ".mb-dest-input::placeholder { color: #555; }",
            ".mb-del-btn { background: none; border: none; cursor: pointer; font-size: 14px; padding: 0 4px; opacity: 0.5; transition: opacity 0.15s; flex-shrink: 0; }",
            ".mb-del-btn:hover { opacity: 1; }",
            ".mb-item .mb-size {",
            "  font-size: 10px;",
            "  color: #666;",
            "  flex-shrink: 0;",
            "  margin-left: 4px;",
            "}",
            ".mb-item .mb-check {",
            "  font-size: 12px;",
            "  flex-shrink: 0;",
            "}",
            ".mb-item .mb-extra {",
            "  font-size: 10px;",
            "  color: #666;",
            "  flex-shrink: 0;",
            "  margin-left: 4px;",
            "}",
            ".mb-sep { color: #555; font-size: 12px; margin: 0 2px; flex-shrink: 0; }",
            /* Divider vertical */
            ".mb-divider {",
            "  width: 1px;",
            "  background: #444;",
            "  flex-shrink: 0;",
            "}",
            /* Progress */
            ".mb-progress {",
            "  border-top: 1px solid #444;",
            "  padding: 8px 0;",
            "  max-height: 120px;",
            "  overflow-y: auto;",
            "  flex-shrink: 0;",
            "}",
            ".mb-progress-row {",
            "  display: flex;",
            "  align-items: center;",
            "  gap: 8px;",
            "  padding: 4px 0;",
            "  font-size: 11px;",
            "  color: #aaa;",
            "}",
            ".mb-progress-name {",
            "  flex: 1;",
            "  overflow: hidden;",
            "  text-overflow: ellipsis;",
            "  white-space: nowrap;",
            "  min-width: 0;",
            "}",
            ".mb-progress-bar {",
            "  width: 120px;",
            "  height: 8px;",
            "  background: #333;",
            "  border-radius: 4px;",
            "  overflow: hidden;",
            "  flex-shrink: 0;",
            "}",
            ".mb-progress-fill {",
            "  height: 100%;",
            "  width: 0%;",
            "  background: linear-gradient(90deg, var(--aih-accent, #D8700D), #22c55e);",
            "  border-radius: 4px;",
            "  transition: width 0.3s;",
            "}",
            ".mb-progress-pct {",
            "  width: 40px;",
            "  text-align: right;",
            "  color: #888;",
            "  flex-shrink: 0;",
            "}",
            ".mb-loading-spinner {",
            "  display: inline-block;",
            "  width: 14px;",
            "  height: 14px;",
            "  border: 2px solid #444;",
            "  border-top-color: var(--aih-accent, #D8700D);",
            "  border-radius: 50%;",
            "  animation: mb-spin 0.8s linear infinite;",
            "  vertical-align: middle;",
            "}",
            "@keyframes mb-spin {",
            "  to { transform: rotate(360deg); }",
            "}",
        ].join("\n");
        document.head.appendChild(style);
    }

    // ─── Helper d'échappement HTML local ────────────────────────────────────────
    function _esc(str) {
        if (typeof str !== 'string') return String(str || '');
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ─── Types de modèles ────────────────────────────────────────────────────────
    var MODEL_TYPES = [
        { key: 'unet', label: 'UNET', color: 'var(--aih-accent, #D8700D)' },
        { key: 'unet_gguf', label: 'GGUF', color: '#a78bfa' },
        { key: 'checkpoint', label: 'Checkpoints', color: '#34d399' },
        { key: 'lora', label: 'LoRAs', color: '#f472b6' },
        { key: 'vae', label: 'VAE', color: '#fbbf24' },
        { key: 'clip', label: 'CLIP', color: '#f87171' },
        { key: 'clip_vision', label: 'CLIP Vision', color: '#f87171' },
        { key: 'controlnet', label: 'ControlNet', color: '#38bdf8' },
        { key: 'upscale', label: 'Upscale', color: '#fb923c' },
        { key: 'text_encoder', label: 'Text Enc.', color: '#e879f9' },
        { key: 'style_model', label: 'Style', color: '#2dd4bf' },
        { key: 'diffusion_model', label: 'Diffusion', color: '#f0abfc' },
        { key: 'gligen', label: 'GLIGEN', color: '#a78bfa' },
        { key: 'hypernetwork', label: 'HyperNet', color: '#f472b6' },
        { key: 'embedding', label: 'Embeddings', color: '#94a3b8' },
        { key: 'other', label: t('mb.type.other'), color: '#888' },
    ];

    // ─── Cache local (évite les re-fetch inutiles) ──────────────────────────────
    var _localModelsCache = null;

    // ─── Helpers ─────────────────────────────────────────────────────────────────
    function formatSize(bytes) {
        if (!bytes && bytes !== 0) return "";
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
        if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
        return (bytes / 1073741824).toFixed(2) + " GB";
    }

    function formatDate(d) {
        if (!d) return "";
        var date = new Date(d);
        if (isNaN(date.getTime())) return d;
        return date.toLocaleDateString("fr-FR", {
            day: "numeric", month: "short", year: "numeric",
        });
    }

    // ─── Fetch vers l'API AIH (backend distant configuré) ───────────────────────────
    function _fetchAihApi(path, opts) {
        opts = opts || {};
        // Lire la config depuis localStorage (même clé que aih_menu.js)
        var cfg = {};
        try { cfg = JSON.parse(localStorage.getItem('AIH_config') || '{}'); } catch(e) {}
        var baseUrl = (cfg.serverUrl || '').replace(/\/+$/, '');
        if (!baseUrl) {
            return Promise.reject(new Error(t('aih.notConfiguredError')));
        }
        var headers = { 'Content-Type': 'application/json' };
        if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
        var cleanPath = path.replace(/^\/+/, '');
        var finalPath = cleanPath.startsWith('api/') ? cleanPath : 'api/' + cleanPath;
        return fetch(baseUrl + '/' + finalPath, Object.assign({}, opts, { headers: Object.assign({}, opts.headers || {}, headers) }));
    }

    function getActiveTypeFilters() {
        var checked = document.querySelectorAll('.mb-filter-checkbox.active');
        var types = [];
        checked.forEach(function (el) {
            types.push(el.dataset.type);
        });
        return types.length ? types : null;
    }

    function getSearchQuery() {
        var input = document.getElementById('mb-search-local');
        var val = input ? input.value.trim() : "";
        return val || null;
    }

    function getRemoteSearchQuery() {
        var input = document.getElementById('mb-search-remote');
        var val = input ? input.value.trim() : "";
        return val || null;
    }

    // ─── Filtre les items locaux depuis le cache (type + search) ───────────────
    function filterLocalItems(items, types, search) {
        if (!items) return [];
        var result = items.slice();
        if (types && types.length) {
            result = result.filter(function (i) {
                return types.indexOf(getEffectiveType(i)) >= 0;
            });
        }
        if (search) {
            var q = search.toLowerCase();
            result = result.filter(function (i) {
                var name = (i.name || i.filename || '').toLowerCase();
                return name.indexOf(q) >= 0;
            });
        }
        return result;
    }

    // ─── Helpers multi-sélection ───────────────────────────────────────────────
    function getSelected(items) {
        return items.filter(function (i) { return i._selected; });
    }

    function updateBatchButtons(m) {
        var localSel = getSelected(m._localItems || []).length;
        var remoteSel = getSelected(m._remoteItems || []).length;
        var localBtn = m.modal ? m.modal.querySelector('.mb-batch-upload') : null;
        var remoteBtn = m.modal ? m.modal.querySelector('.mb-batch-download') : null;
        if (localBtn) {
            localBtn.disabled = localSel === 0;
            localBtn.textContent = t('mb.uploadSelected', { count: localSel });
        }
        if (remoteBtn) {
            remoteBtn.disabled = remoteSel === 0;
            remoteBtn.textContent = t('mb.downloadSelected', { count: remoteSel });
        }
    }

    function toggleItemSelect(checkbox, selected, items) {
        if (!checkbox) return;
        var itemEl = checkbox.closest ? checkbox.closest('.mb-item') : null;
        if (!itemEl) itemEl = checkbox;
        if (!itemEl) return;
        var idx = parseInt(itemEl.dataset.index);
        if (!isNaN(idx) && items && items[idx]) {
            items[idx]._selected = selected;
        }
        itemEl.classList.toggle('selected', selected);
    }

    // ─── uploadFile (promise-based, pour batch) ────────────────────────────────
    function uploadFile(m, item) {
        return new Promise(function (resolve, reject) {
            var filepath = item.path || item.filepath;
            var fileType = getEffectiveType(item);
            var filename = item.name || item.filename || '?';

            if (!filepath) {
                reject(new Error(t('mb.missingPath')));
                return;
            }

            var progressEl = showProgress(m, filename);

            fetch('/api/aih/models/upload', {
                method: 'POST',
                body: JSON.stringify({
                    path: filepath,
                    type: fileType,
                }),
            })
                .then(function (r) {
                    if (!r.ok) return r.json().then(function (d) {
                        throw new Error(d.error || d.message || 'HTTP ' + r.status);
                    });
                    return r.json();
                })
                .then(function (data) {
                    if (data.status === 'ok' || data.success) {
                        updateProgress(progressEl, 100, t('mb.uploadDone'));
                        resolve();
                    } else {
                        updateProgress(progressEl, 0, t('mb.errorPrefix') + (data.error || data.message || t('aih.unknown')));
                        reject(new Error(data.error || t('aih.failed')));
                    }
                })
                .catch(function (err) {
                    updateProgress(progressEl, 0, t('mb.errorPrefix') + err.message);
                    reject(err);
                });
        });
    }

    // ─── downloadFile (promise-based, pour batch) ──────────────────────────────
    function downloadFile(m, item, overrideDestSubdir) {
        return new Promise(function (resolve, reject) {
            var uploadId = item.id || item.upload_id || item._id;
            var displayName = item.name || item.filename || '?';
            var fileType = getEffectiveType(item);
            var destSubdir = overrideDestSubdir || getDefaultDestDir(item);

            if (!uploadId) {
                reject(new Error(t('mb.missingRemoteId')));
                return;
            }

            var progressEl = showProgress(m, displayName);

            fetch('/api/aih/models/download', {
                method: 'POST',
                body: JSON.stringify({
                    upload_id: uploadId,
                    filename: displayName,
                    type: fileType,
                    dest_path: destSubdir,
                }),
            })
                .then(function (r) {
                    if (!r.ok) return r.json().then(function (d) {
                        throw new Error(d.error || d.message || 'HTTP ' + r.status);
                    });
                    return r.json();
                })
                .then(function (data) {
                    if (data.status === 'ok' || data.success) {
                        if (data.conflict) {
                            updateProgress(progressEl, 50, t('mb.conflictIgnore'));
                            resolve();
                            return;
                        }
                        updateProgress(progressEl, 100, t('mb.downloadDone'));
                        resolve();
                    } else {
                        updateProgress(progressEl, 0, t('mb.errorPrefix') + (data.error || data.message || t('aih.unknown')));
                        reject(new Error(data.error || t('aih.failed')));
                    }
                })
                .catch(function (err) {
                    updateProgress(progressEl, 0, t('mb.errorPrefix') + err.message);
                    reject(err);
                });
        });
    }

    // ─── batchUpload ────────────────────────────────────────────────────────────
    function batchUpload(m) {
        var selected = getSelected(m._localItems || []);
        if (selected.length === 0) return;
        var btn = m.modal.querySelector('.mb-batch-upload');
        if (!btn) return;
        btn.disabled = true;
        btn.textContent = t('mb.uploading');

        var done = 0;
        function next() {
            if (done >= selected.length) {
                btn.textContent = t('mb.done');
                setTimeout(function () {
                    btn.textContent = t('mb.uploadSelected', { count: 0 });
                    btn.disabled = true;
                }, 2000);
                // Désélectionner tout
                selected.forEach(function (i) { i._selected = false; });
                m._remotePage = 1;
                m._remoteHasMore = true;
                loadRemoteModels(m);
                loadLocalModels(m, true);
                return;
            }
            var item = selected[done];
            btn.textContent = '↗ ' + (done + 1) + '/' + selected.length + ' ' + (item.name || item.filename || '?');
            uploadFile(m, item).then(function () {
                done++;
                next();
            }).catch(function () {
                done++;
                next();
            });
        }
        next();
    }

    // ─── batchDownload ──────────────────────────────────────────────────────────
    function batchDownload(m) {
        var selected = getSelected(m._remoteItems || []);
        if (selected.length === 0) return;
        var btn = m.modal.querySelector('.mb-batch-download');
        if (!btn) return;
        btn.disabled = true;
        btn.textContent = t('mb.downloading');

        var done = 0;
        function next() {
            if (done >= selected.length) {
                btn.textContent = t('mb.done');
                setTimeout(function () {
                    btn.textContent = t('mb.downloadSelected', { count: 0 });
                    btn.disabled = true;
                }, 2000);
                // Désélectionner tout
                selected.forEach(function (i) { i._selected = false; });
                m._remotePage = 1;
                m._remoteHasMore = true;
                loadRemoteModels(m);
                loadLocalModels(m, true);
                return;
            }
            var item = selected[done];
            btn.textContent = '↙ ' + (done + 1) + '/' + selected.length + ' ' + (item.name || item.filename || '?');

            // Lire la valeur du champ destination depuis le DOM (si modifié par l'utilisateur)
            var destSubdir = getDefaultDestDir(item);
            // Chercher l'élément correspondant dans la liste
            var list = m._remoteList;
            if (list) {
                var allItems = list.querySelectorAll('.mb-item');
                for (var i = 0; i < allItems.length; i++) {
                    var el = allItems[i];
                    var nameEl = el.querySelector('.mb-name');
                    if (nameEl && (nameEl.textContent === item.name || nameEl.textContent === item.filename)) {
                        var di = el.querySelector('.mb-dest-input');
                        if (di && di.value.trim()) {
                            destSubdir = di.value.trim();
                        }
                        break;
                    }
                }
            }

            downloadFile(m, item, destSubdir).then(function () {
                done++;
                next();
            }).catch(function () {
                done++;
                next();
            });
        }
        next();
    }

    // ─── openModelBrowser ────────────────────────────────────────────────────────
    window.openModelBrowser = function () {
        // Comportement dégradé : la liste distante dépend du backend AIH ;
        // sans URL configurée, on invite à configurer au lieu de laisser
        // le panneau distant échouer avec une erreur réseau confuse.
        try {
            var cfg = JSON.parse(localStorage.getItem('AIH_config') || '{}');
            if (!(cfg.serverUrl || '').replace(/\/+$/, '')) {
                if (window.aihShowAlert) {
                    window.aihShowAlert(t('aih.notConfiguredTitle'), t('mb.notConfiguredMsgLocal'), "info");
                }
            }
        } catch (e) {}

        _mbInjectCSS();

        var m = aihOpenModalV2({
            id: "aih-modal-model-browser",
            title: t("mb.title"),
            width: "920px",
            height: "620px",
            minWidth: "700px",
            minHeight: "400px",
            storageKey: "aih-modal-model-browser",
            persistSize: true,
            persistPos: true,
            className: "aih-model-browser",
        });
        renderModelBrowser(m);

    };

    // ─── renderModelBrowser ──────────────────────────────────────────────────────
    function renderModelBrowser(m) {
        m.body.style.display = "flex";
        m.body.style.flexDirection = "column";
        m.body.style.padding = "8px 12px";

        m.body.innerHTML = "" +
            '<div class="mb-filters" id="mb-filters"></div>' +
            '<div class="mb-panels" id="mb-panels">' +
            '  <div class="mb-panel mb-panel-local">' +
            '    <div class="mb-panel-header">' + t('mb.panelLocal') + '</div>' +
            '    <div class="mb-panel-list" id="mb-local-list"></div>' +
            '    <div class="mb-panel-footer mb-panel-footer-local">' +
            '      <button class="mb-batch-btn mb-batch-upload" disabled>' + t('mb.uploadSelected', { count: 0 }) + '</button>' +
            '    </div>' +
            '  </div>' +
            '  <div class="mb-divider"></div>' +
            '  <div class="mb-panel mb-panel-remote">' +
            '    <div class="mb-panel-header">' + t('mb.panelRemote') + '</div>' +
            '    <div class="mb-panel-list" id="mb-remote-list"></div>' +
            '    <div class="mb-panel-footer mb-panel-footer-remote">' +
            '      <button class="mb-batch-btn mb-batch-download" disabled>' + t('mb.downloadSelected', { count: 0 }) + '</button>' +
            '    </div>' +
            '  </div>' +
            '</div>' +
            '<div class="mb-progress" id="mb-progress" style="display:none;"></div>';

        // Références utiles
        m._localList = m.modal.querySelector('#mb-local-list');
        m._remoteList = m.modal.querySelector('#mb-remote-list');
        m._progressContainer = m.modal.querySelector('#mb-progress');
        m._localLoading = false;
        m._remoteLoading = false;
        m._localPage = 1;
        m._remotePage = 1;
        m._remoteHasMore = true;
        m._currentUser = null;

        // Récupérer le rôle de l'utilisateur (pour les actions admin)
        _fetchAihApi('auth/me')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data && data.role) {
                    m._currentUser = { role: data.role };
                    // Re-rendre le panneau distant si déjà chargé
                    if (m._remoteItems && m._remoteItems.length) {
                        renderRemotePanel(m, { items: m._remoteItems });
                    }
                }
            })
            .catch(function () {
                // Pas grave, on reste en mode non-admin
                m._currentUser = { role: 'user' };
            });

        // Filtres
        renderFilters(m);

        // Chargement initial
        loadLocalModels(m);
        loadRemoteModels(m);

        // Infinite scroll sur le panneau distant
        m._remoteList.addEventListener('scroll', function () {
            if (m._remoteLoading || !m._remoteHasMore) return;
            var el = m._remoteList;
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60) {
                m._remotePage++;
                loadRemoteModels(m);
            }
        });

        // Bouton batch upload
        var batchUploadBtn = m.modal.querySelector('.mb-batch-upload');
        if (batchUploadBtn) {
            batchUploadBtn.addEventListener('click', function () {
                batchUpload(m);
            });
        }

        // Bouton batch download
        var batchDownloadBtn = m.modal.querySelector('.mb-batch-download');
        if (batchDownloadBtn) {
            batchDownloadBtn.addEventListener('click', function () {
                batchDownload(m);
            });
        }

    }

    // ─── renderFilters ──────────────────────────────────────────────────────────
    function renderFilters(m) {
        var container = m.modal.querySelector('#mb-filters');
        container.innerHTML = "";

        // Checkboxes de type
        MODEL_TYPES.forEach(function (t) {
            var label = document.createElement('label');
            label.className = 'mb-filter-checkbox active';
            label.style.setProperty('--mb-color', t.color);
            label.dataset.type = t.key;

            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = true;
            label.appendChild(cb);

            var dot = document.createElement('span');
            dot.textContent = '●';
            dot.style.color = t.color;
            dot.style.marginRight = '2px';
            label.appendChild(dot);

            label.appendChild(document.createTextNode(t.label));

            label.addEventListener('click', function (e) {
                e.preventDefault();
                var isActive = label.classList.toggle('active');
                cb.checked = isActive;
                // Re-filtrer les deux listes
                m._remotePage = 1;
                m._remoteHasMore = true;
                loadLocalModels(m);
                loadRemoteModels(m);
            });

            container.appendChild(label);
        });

        // Select All / Deselect All
        var selectAllSpan = document.createElement('span');
        selectAllSpan.className = 'mb-select-all';
        selectAllSpan.style.cssText = 'font-size:10px;color:#888;cursor:pointer;user-select:none;';
        selectAllSpan.innerHTML = '[<a href="#" class="mb-select-all-link" data-action="all">' + t('mb.selectAll') + '</a>] [<a href="#" class="mb-select-all-link" data-action="none">' + t('mb.selectNone') + '</a>]';
        selectAllSpan.addEventListener('click', function (e) {
            if (e.target.tagName === 'A') {
                e.preventDefault();
                var action = e.target.dataset.action;
                var checkboxes = container.querySelectorAll('.mb-filter-checkbox');
                checkboxes.forEach(function (label) {
                    var cb = label.querySelector('input[type="checkbox"]');
                    if (action === 'all') {
                        if (!label.classList.contains('active')) {
                            label.classList.add('active');
                            cb.checked = true;
                        }
                    } else {
                        if (label.classList.contains('active')) {
                            label.classList.remove('active');
                            cb.checked = false;
                        }
                    }
                });
                // Re-filtrer les deux listes
                m._remotePage = 1;
                m._remoteHasMore = true;
                loadLocalModels(m);
                loadRemoteModels(m);
            }
        });
        container.appendChild(selectAllSpan);

        // Champs de recherche
        var searchGroup = document.createElement('div');
        searchGroup.className = 'mb-filter-search';

        var s1 = document.createElement('input');
        s1.type = 'text';
        s1.id = 'mb-search-local';
        s1.placeholder = t('mb.searchLocal');

        var s2 = document.createElement('input');
        s2.type = 'text';
        s2.id = 'mb-search-remote';
        s2.placeholder = t('mb.searchRemote');

        var debounceTimer = null;
        function onSearchInput() {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(function () {
                m._remotePage = 1;
                m._remoteHasMore = true;
                loadLocalModels(m);
                loadRemoteModels(m);
            }, 300);
        }
        s1.addEventListener('input', onSearchInput);
        s2.addEventListener('input', onSearchInput);

        searchGroup.appendChild(s1);
        searchGroup.appendChild(s2);
        container.appendChild(searchGroup);
    }

    // ─── loadLocalModels ───────────────────────────────────────────────────────
    function loadLocalModels(m, forceRefresh) {
        var types = getActiveTypeFilters();
        var search = getSearchQuery();

        // Cache : si déjà chargé et pas de force refresh, filtrer depuis le cache
        if (_localModelsCache && !forceRefresh) {
            var filtered = filterLocalItems(_localModelsCache, types, search);
            m._localItems = _localModelsCache; // pour isLocalByFingerprint (liste complète)
            renderLocalPanel(m, filtered);
            return;
        }

        // Premier chargement ou refresh forcé : on fetch TOUT (pas de filtre serveur)
        var url = '/api/aih/models/local';

        m._localList.innerHTML = '<div class="mb-loading"><span class="mb-loading-spinner"></span> ' + t('mb.loading') + '</div>';

        fetch(url)
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                // data.items est un dictionnaire { catégorie: [modèles] }
                // On l'aplatit en tableau en déduisant le type depuis la catégorie
                var itemsObj = data.items || {};
                var flatItems = [];
                var CATEGORY_TO_TYPE = {
                    'checkpoints':     'checkpoint',
                    'loras':           'lora',
                    'vae':             'vae',
                    'clip':            'clip',
                    'clip_vision':     'clip_vision',
                    'controlnet':      'controlnet',
                    'unet':            'unet',
                    'unet_gguf':       'unet_gguf',
                    'upscale_models':  'upscale',
                    'gligen':          'gligen',
                    'hypernetworks':   'hypernetwork',
                    'text_encoders':   'text_encoder',
                    'style_models':    'style_model',
                    'diffusion_models':'unet',
                    'configs':         'model',
                    'embeddings':      'model',
                    'bbxe/models':     'model',
                };
                Object.keys(itemsObj).forEach(function (category) {
                    (itemsObj[category] || []).forEach(function (item) {
                        item.type = CATEGORY_TO_TYPE[category] || category;
                        flatItems.push(item);
                    });
                });
                _localModelsCache = flatItems;  // mise en cache
                m._localItems = flatItems;       // pour isLocalByFingerprint

                // Filtrer selon les filtres actifs
                var filtered = filterLocalItems(flatItems, types, search);
                renderLocalPanel(m, filtered);
            })
            .catch(function (err) {
                m._localLoading = false;
                m._localList.innerHTML = '<div class="mb-empty">' + t('mb.errorPrefix') + _esc(err.message || t('mb.requestFailed')) + '</div>';
            });
    }

    // ─── loadRemoteModels ──────────────────────────────────────────────────────
    function loadRemoteModels(m) {
        if (m._remoteLoading) return;
        m._remoteLoading = true;

        var types = getActiveTypeFilters();
        var search = getRemoteSearchQuery();
        var page = m._remotePage || 1;

        var url = '/api/aih/models/remote?page=' + page + '&limit=50';
        // N'envoyer le filtre type que si certains types sont DESACTIVES.
        // Quand tous sont actifs, pas de filtre = tout afficher.
        if (types && types.length && types.length < MODEL_TYPES.length) {
            url += '&type=' + encodeURIComponent(types.join(','));
        }
        if (search) url += '&search=' + encodeURIComponent(search);

        if (page === 1) {
            m._remoteList.innerHTML = '<div class="mb-loading"><span class="mb-loading-spinner"></span> ' + t('mb.loading') + '</div>';
        }

        fetch(url)
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                renderRemotePanel(m, data);
                m._remoteLoading = false;
            })
            .catch(function (err) {
                m._remoteLoading = false;  // TOUJOURS réinitialiser
                if (page === 1) {
                    m._remoteList.innerHTML = '<div class="mb-empty">' + t('mb.errorPrefix') + _esc(err.message || t('mb.requestFailed')) + '</div>';
                }
            });
    }

    // ─── renderLocalPanel ──────────────────────────────────────────────────────
    function renderLocalPanel(m, items) {
        var list = m._localList;
        list.innerHTML = "";

        if (!items || items.length === 0) {
            list.innerHTML = '<div class="mb-empty">' + t('mb.noLocal') + '</div>';
            return;
        }

        // Index des modèles distants pour vérifier les fingerprints
        var remoteIndex = {};
        var remoteItems = m._remoteItems || [];
        for (var i = 0; i < remoteItems.length; i++) {
            var ri = remoteItems[i];
            if (ri.fingerprint) {
                remoteIndex[ri.fingerprint] = ri;
            }
        }

        // Variable pour le Shift+Click
        if (typeof m._lastCheckedIndex === 'undefined') m._lastCheckedIndex = -1;

        items.forEach(function (item, idx) {
            var div = document.createElement('div');
            div.className = 'mb-item';
            div.dataset.index = idx;
            item._selected = false;

            // ── Checkbox + multi-sélection (shift, ctrl) ──
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'mb-checkbox';
            cb.addEventListener('change', function (e) {
                var isShift = e.shiftKey;
                var isCtrl = e.ctrlKey || e.metaKey;
                var allCbs = list.querySelectorAll('.mb-checkbox');
                var currentIdx = Array.prototype.indexOf.call(allCbs, this);

                if (isShift && m._lastCheckedIndex >= 0) {
                    // Shift+Click : sélection par plage
                    var start = Math.min(m._lastCheckedIndex, currentIdx);
                    var end = Math.max(m._lastCheckedIndex, currentIdx);
                    for (var si = start; si <= end; si++) {
                        allCbs[si].checked = this.checked;
                        toggleItemSelect(allCbs[si], this.checked, items);
                    }
                } else if (!isCtrl) {
                    // Click normal sans modifieur : sélection unique
                    allCbs.forEach(function (c, i) {
                        var checked = (i === currentIdx) ? this.checked : false;
                        c.checked = checked;
                        toggleItemSelect(c, checked, items);
                    }, this);
                } else {
                    // Ctrl+Click : toggle uniquement celui-ci
                    toggleItemSelect(this, this.checked, items);
                }

                m._lastCheckedIndex = currentIdx;
                updateBatchButtons(m);
                e.stopPropagation();
            });
            div.appendChild(cb);

            // ── Badge type ──
            var typeInfo = getTypeInfo(getEffectiveType(item));
            var badge = document.createElement('span');
            badge.className = 'mb-badge';
            badge.textContent = typeInfo.label;
            badge.style.background = typeInfo.color;
            div.appendChild(badge);

            // Clic sur le badge → éditer le type
            badge.addEventListener('click', function (e) {
                e.stopPropagation();
                var sel = document.createElement('select');
                sel.className = 'mb-type-edit';
                MODEL_TYPES.forEach(function (t) {
                    var opt = document.createElement('option');
                    opt.value = t.key;
                    opt.textContent = t.label;
                    sel.appendChild(opt);
                });
                sel.value = getEffectiveType(item);
                badge.replaceWith(sel);
                sel.focus();
                sel.addEventListener('change', function () {
                    item._overrideType = sel.value;
                    badge.textContent = getTypeInfo(sel.value).label;
                    badge.style.background = getTypeInfo(sel.value).color;
                    sel.replaceWith(badge);
                });
                sel.addEventListener('blur', function () {
                    if (sel.parentNode) { sel.replaceWith(badge); }
                });
                sel.addEventListener('keydown', function (ev) {
                    if (ev.key === 'Escape') { sel.replaceWith(badge); }
                });
            });

            // ── Séparateur ──
            var sep1 = document.createElement('span');
            sep1.className = 'mb-sep';
            sep1.textContent = '/';
            div.appendChild(sep1);

            // ── Destination input (toujours visible) ──
            var destInput = document.createElement('input');
            destInput.type = 'text';
            destInput.className = 'mb-dest-input';
            destInput.placeholder = 'sous-dossier (opt.)';
            destInput.value = '';
            destInput.title = 'Sous-dossier de destination (optionnel)';
            destInput.addEventListener('click', function (e) { e.stopPropagation(); });
            div.appendChild(destInput);

            // ── Séparateur ──
            var sep2 = document.createElement('span');
            sep2.className = 'mb-sep';
            sep2.textContent = '/';
            div.appendChild(sep2);

            // ── Nom ──
            var nameSpan = document.createElement('span');
            nameSpan.className = 'mb-name';
            nameSpan.textContent = item.name || item.filename || '?';
            nameSpan.title = item.name || item.filename || '';
            div.appendChild(nameSpan);

            // ── Taille ──
            var sizeSpan = document.createElement('span');
            sizeSpan.className = 'mb-size';
            sizeSpan.textContent = formatSize(item.size || item.file_size);
            div.appendChild(sizeSpan);

            // ── Icône ✅ si déjà sur le serveur ──
            if (item.fingerprint && remoteIndex[item.fingerprint]) {
                var check = document.createElement('span');
                check.className = 'mb-check';
                check.textContent = '✅';
                check.title = t('mb.alreadyOnServer');
                div.appendChild(check);
            }

            // ── Double-clic → upload direct ──
            div.addEventListener('dblclick', function () {
                uploadLocalModel(m, item.path || item.filepath, getEffectiveType(item), item.name || item.filename);
            });

            list.appendChild(div);
        });
    }

    // ─── renderRemotePanel ─────────────────────────────────────────────────────
    function renderRemotePanel(m, data) {
        var list = m._remoteList;
        var raw = data.items || data.uploads || [];
        var items = Array.isArray(raw) ? raw : [];
        var page = m._remotePage || 1;

        // Si data a une structure paginée
        if (data.items && Array.isArray(data.items)) {
            items = data.items;
            m._remoteHasMore = items.length >= (data.limit || 50);
            if (data.total !== undefined) {
                m._remoteHasMore = (page * (data.limit || 50)) < data.total;
            }
        } else if (Array.isArray(data)) {
            items = data;
            m._remoteHasMore = false;
        }

        if (page === 1) {
            list.innerHTML = "";
        }

        // Stocker les items distants pour le matching local
        var flatItems;
        if (page === 1) {
            m._remoteItems = items.slice();
            flatItems = items;
        } else {
            m._remoteItems = (m._remoteItems || []).concat(items);
            flatItems = items;
        }

        if (items.length === 0 && page === 1) {
            list.innerHTML = '<div class="mb-empty">' + t('mb.noRemote') + '</div>';
            return;
        }

        // Variable pour le Shift+Click
        if (typeof m._lastCheckedIndex === 'undefined') m._lastCheckedIndex = -1;

        // Offset d'index pour la pagination (index global dans m._remoteItems)
        var globalOffset = (page - 1) * 50;

        items.forEach(function (item, idx) {
            var globalIdx = globalOffset + idx;
            var div = document.createElement('div');
            div.className = 'mb-item';
            div.dataset.index = globalIdx;
            item._selected = false;

            // ── Checkbox + multi-sélection (shift, ctrl) ──
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'mb-checkbox';
            cb.addEventListener('change', function (e) {
                var isShift = e.shiftKey;
                var isCtrl = e.ctrlKey || e.metaKey;
                var allCbs = list.querySelectorAll('.mb-checkbox');
                var currentIdx = Array.prototype.indexOf.call(allCbs, this);
                var currentGlobalIdx = globalOffset + currentIdx;
                var remoteAll = m._remoteItems || [];

                if (isShift && m._lastCheckedIndex >= 0) {
                    // Shift+Click : sélection par plage
                    var start = Math.min(m._lastCheckedIndex, currentGlobalIdx);
                    var end = Math.max(m._lastCheckedIndex, currentGlobalIdx);
                    for (var si = start; si <= end; si++) {
                        var sEl = list.querySelector('.mb-item[data-index="' + si + '"]');
                        if (sEl) {
                            var sCb = sEl.querySelector('.mb-checkbox');
                            if (sCb) sCb.checked = this.checked;
                            toggleItemSelect(sCb || sEl, this.checked, remoteAll);
                        }
                    }
                } else if (!isCtrl) {
                    // Click normal sans modifieur : sélection unique
                    allCbs.forEach(function (c, i) {
                        var checked = (i === currentIdx) ? this.checked : false;
                        c.checked = checked;
                        toggleItemSelect(c, checked, remoteAll);
                    }, this);
                } else {
                    // Ctrl+Click : toggle uniquement celui-ci
                    toggleItemSelect(this, this.checked, remoteAll);
                }

                m._lastCheckedIndex = currentGlobalIdx;
                updateBatchButtons(m);
                e.stopPropagation();
            });
            div.appendChild(cb);

            // ── Badge type ──
            var typeInfo = getTypeInfo(getEffectiveType(item));
            var badge = document.createElement('span');
            badge.className = 'mb-badge';
            badge.textContent = typeInfo.label;
            badge.style.background = typeInfo.color;
            div.appendChild(badge);

            // Clic sur le badge → éditer le type
            badge.addEventListener('click', function (e) {
                e.stopPropagation();
                var sel = document.createElement('select');
                sel.className = 'mb-type-edit';
                MODEL_TYPES.forEach(function (t) {
                    var opt = document.createElement('option');
                    opt.value = t.key;
                    opt.textContent = t.label;
                    sel.appendChild(opt);
                });
                sel.value = getEffectiveType(item);
                badge.replaceWith(sel);
                sel.focus();
                sel.addEventListener('change', function () {
                    item._overrideType = sel.value;
                    badge.textContent = getTypeInfo(sel.value).label;
                    badge.style.background = getTypeInfo(sel.value).color;
                    sel.replaceWith(badge);
                });
                sel.addEventListener('blur', function () {
                    if (sel.parentNode) { sel.replaceWith(badge); }
                });
                sel.addEventListener('keydown', function (ev) {
                    if (ev.key === 'Escape') { sel.replaceWith(badge); }
                });
            });

            // ── Séparateur ──
            var sep1 = document.createElement('span');
            sep1.className = 'mb-sep';
            sep1.textContent = '/';
            div.appendChild(sep1);

            // ── Destination input (toujours visible) ──
            var destInput = document.createElement('input');
            destInput.type = 'text';
            destInput.className = 'mb-dest-input';
            destInput.placeholder = 'sous-dossier (opt.)';
            destInput.value = '';
            destInput.title = 'Sous-dossier de destination (optionnel)';
            destInput.addEventListener('click', function (e) { e.stopPropagation(); });
            div.appendChild(destInput);

            // ── Séparateur ──
            var sep2 = document.createElement('span');
            sep2.className = 'mb-sep';
            sep2.textContent = '/';
            div.appendChild(sep2);

            // ── Nom ──
            var nameSpan = document.createElement('span');
            nameSpan.className = 'mb-name';
            var displayName = item.name || item.filename || item.original_name || '?';
            nameSpan.textContent = displayName;
            nameSpan.title = displayName;
            div.appendChild(nameSpan);

            // ── Taille + downloads ──
            var downloadCount = item.downloads || item.download_count || 0;
            var sizeSpan = document.createElement('span');
            sizeSpan.className = 'mb-size';
            var sizeTxt = formatSize(item.size || item.file_size || item.original_size);
            var dlTxt = downloadCount > 0 ? ' ⬇' + downloadCount : '';
            sizeSpan.textContent = sizeTxt + dlTxt;
            div.appendChild(sizeSpan);

            // ── Icône ✅ si déjà en local ──
            if (item.fingerprint && isLocalByFingerprint(m, item.fingerprint)) {
                var check = document.createElement('span');
                check.className = 'mb-check';
                check.textContent = '✅';
                check.title = t('mb.alreadyLocal');
                div.appendChild(check);
            }

            // ── Extra info (uploader + date) ──
            var extraSpan = document.createElement('span');
            extraSpan.className = 'mb-extra';
            var uploader = item.uploader || item.uploader_name || item.owner_name || '';
            var dateStr = formatDate(item.created_at || item.uploaded_at || item.date);
            var extraParts = [];
            if (uploader) extraParts.push(uploader);
            if (dateStr) extraParts.push(dateStr);
            extraSpan.textContent = extraParts.join(' · ');
            div.appendChild(extraSpan);

            // ── Bouton supprimer (admin seulement) ──
            if (m._currentUser && m._currentUser.role === 'admin') {
                var delBtn = document.createElement('button');
                delBtn.textContent = '🗑';
                delBtn.className = 'mb-del-btn';
                delBtn.title = t('mb.deleteModelTitle');
                delBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    if (typeof aihShowConfirm === 'function') {
                        aihShowConfirm(t('dialog.delete'), t('mb.deleteConfirm', { name: _esc(item.filename || displayName) })).then(function (ok) {
                            if (!ok) return;
                            _fetchAihApi('aih/models/remote/' + (item.upload_id || item.id || item._id), { method: 'DELETE' })
                                .then(function (r) { return r.json(); })
                                .then(function (d) {
                                    if (d.status === 'ok') {
                                        m._remotePage = 1;
                                        m._remoteLoading = false;
                                        m._remoteHasMore = true;
                                        m._remoteList.innerHTML = '<div class="mb-loading"><span class="mb-loading-spinner"></span> ' + t('mb.loading') + '</div>';
                                        loadRemoteModels(m);
                                    } else {
                                        if (typeof aihShowAlert === 'function') {
                                            aihShowAlert(t('dialog.error'), d.error || t('aih.failed'), 'error');
                                        }
                                    }
                                });
                        });
                    }
                });
                div.appendChild(delBtn);
            }

            // ── Double-clic → download direct ──
            div.addEventListener('dblclick', function () {
                var uploadId = item.id || item.upload_id || item._id;
                var destSubdir = destInput.value.trim() || getDefaultDestDir(item) || '';
                downloadRemoteModel(m, uploadId, displayName, getEffectiveType(item), destSubdir);
            });

            list.appendChild(div);
        });

        // Indicateur de chargement pour la page suivante
        if (m._remoteHasMore) {
            var loadMore = document.createElement('div');
            loadMore.className = 'mb-loading';
            loadMore.style.padding = '12px';
            loadMore.style.borderBottom = 'none';
            loadMore.innerHTML = '<span class="mb-loading-spinner"></span> ' + t('mb.scrollMore');
            list.appendChild(loadMore);
        }
    }

    // ─── getEffectiveType ───────────────────────────────────────────────────────
    function getEffectiveType(item) {
        return item._overrideType || item.type || 'model';
    }

    // ─── getTypeInfo ────────────────────────────────────────────────────────────
    function getTypeInfo(typeKey) {
        if (!typeKey) return { key: 'other', label: t('mb.type.other'), color: '#888' };
        var key = typeKey.toLowerCase().replace(/[^a-z0-9_]/g, '');
        for (var i = 0; i < MODEL_TYPES.length; i++) {
            if (MODEL_TYPES[i].key === key) return MODEL_TYPES[i];
        }
        return { key: 'other', label: t('mb.type.other'), color: '#888' };
    }

    // ─── getDefaultDestDir ─────────────────────────────────────────────────────
    function getDefaultDestDir(item) {
        return ''; // Optionnel : l'utilisateur remplit s'il veut un sous-dossier
    }

    // ─── isLocalByFingerprint ──────────────────────────────────────────────────
    function isLocalByFingerprint(m, fingerprint) {
        if (!fingerprint) return false;
        // Vérifie dans les items locaux déjà chargés
        var localItems = m._localItems || [];
        for (var i = 0; i < localItems.length; i++) {
            if (localItems[i].fingerprint === fingerprint) return true;
        }
        return false;
    }

    // ─── uploadLocalModel ──────────────────────────────────────────────────────
    function uploadLocalModel(m, filepath, fileType, filename) {
        if (!filepath) {
            aihShowAlert(t('dialog.error'), t('mb.missingPath'), "error");
            return;
        }

        var progressEl = showProgress(m, filename || filepath);

        fetch('/api/aih/models/upload', {
            method: 'POST',
            body: JSON.stringify({
                path: filepath,
                type: fileType || 'model',
            }),
        })
            .then(function (r) {
                if (!r.ok) return r.json().then(function (d) {
                    throw new Error(d.error || d.message || 'HTTP ' + r.status);
                });
                return r.json();
            })
            .then(function (data) {
                if (data.status === 'ok' || data.success) {
                    updateProgress(progressEl, 100, t('mb.uploadDone'));
                    // Rafraîchir les deux listes
                    m._remotePage = 1;
                    m._remoteHasMore = true;
                    loadRemoteModels(m);
                    loadLocalModels(m, true);
                } else {
                    updateProgress(progressEl, 0, t('mb.errorPrefix') + (data.error || data.message || t('aih.unknown')));
                }
            })
            .catch(function (err) {
                updateProgress(progressEl, 0, t('mb.errorPrefix') + err.message);
            });
    }

    // ─── downloadRemoteModel ───────────────────────────────────────────────────
    function downloadRemoteModel(m, uploadId, filename, fileType, destSubdir) {
        if (!uploadId) {
            aihShowAlert(t('dialog.error'), t('mb.missingRemoteId'), "error");
            return;
        }

        var progressEl = showProgress(m, filename);

        fetch('/api/aih/models/download', {
            method: 'POST',
            body: JSON.stringify({
                upload_id: uploadId,
                filename: filename,
                type: fileType || 'model',
                dest_path: destSubdir || '',
            }),
        })
            .then(function (r) {
                if (!r.ok) return r.json().then(function (d) {
                    throw new Error(d.error || d.message || 'HTTP ' + r.status);
                });
                return r.json();
            })
            .then(function (data) {
                if (data.status === 'ok' || data.success) {
                    if (data.conflict) {
                        // Conflit détecté par le serveur
                        updateProgress(progressEl, 50, t('mb.conflictResolve'));
                        return handleDownloadConflict(m, uploadId, filename, fileType, destSubdir, data, progressEl);
                    }
                    updateProgress(progressEl, 100, t('mb.downloadDone'));
                    m._remotePage = 1;
                    m._remoteHasMore = true;
                    loadLocalModels(m, true);
                    loadRemoteModels(m);
                } else {
                    updateProgress(progressEl, 0, t('mb.errorPrefix') + (data.error || data.message || t('aih.unknown')));
                }
            })
            .catch(function (err) {
                updateProgress(progressEl, 0, t('mb.errorPrefix') + err.message);
            });
    }

    // ─── handleDownloadConflict ────────────────────────────────────────────────
    function handleDownloadConflict(m, uploadId, filename, fileType, destSubdir, conflictData, progressEl) {
        // Si showConflictModal est disponible globalement, l'utiliser
        if (typeof window.showConflictModal === 'function') {
            window.showConflictModal(filename, conflictData.local, conflictData.remote)
                .then(function (result) {
                    if (result.action === 'overwrite') {
                        return retryDownload(m, uploadId, filename, fileType, destSubdir, 'overwrite', progressEl);
                    } else if (result.action === 'suffix') {
                        return retryDownload(m, uploadId, result.newName, fileType, destSubdir, 'suffix', progressEl);
                    } else {
                        updateProgress(progressEl, 0, t('mb.downloadCancelledConflict'));
                    }
                });
        } else {
            // Fallback : aihShowConfirm simple
            aihShowConfirm(
                t('mb.conflictTitle'),
                t('mb.conflictMsg', { name: _esc(filename) })
            ).then(function (ok) {
                if (ok) {
                    retryDownload(m, uploadId, filename, fileType, destSubdir, 'overwrite', progressEl);
                } else {
                    updateProgress(progressEl, 0, t('mb.downloadCancelledConflict'));
                }
            });
        }
    }

    // ─── retryDownload ─────────────────────────────────────────────────────────
    function retryDownload(m, uploadId, filename, fileType, destSubdir, resolution, progressEl) {
        var body = {
            upload_id: uploadId,
            filename: filename,
            type: fileType || 'model',
            dest_path: destSubdir || '',
            conflict_resolution: resolution,
        };

        fetch('/api/aih/models/download', {
            method: 'POST',
            body: JSON.stringify(body),
        })
            .then(function (r) {
                if (!r.ok) return r.json().then(function (d) {
                    throw new Error(d.error || d.message || 'HTTP ' + r.status);
                });
                return r.json();
            })
            .then(function (data) {
                if (data.status === 'ok' || data.success) {
                    updateProgress(progressEl, 100, t('mb.downloadDone'));
                    m._remotePage = 1;
                    m._remoteHasMore = true;
                    loadLocalModels(m, true);
                    loadRemoteModels(m);
                } else {
                    updateProgress(progressEl, 0, t('mb.errorPrefix') + (data.error || data.message || t('aih.unknown')));
                }
            })
            .catch(function (err) {
                updateProgress(progressEl, 0, t('mb.errorPrefix') + err.message);
            });
    }

    // ─── showProgress / updateProgress ─────────────────────────────────────────
    function showProgress(m, filename) {
        var container = m.modal.querySelector('#mb-progress');
        if (!container) return null;
        container.style.display = 'block';

        var row = document.createElement('div');
        row.className = 'mb-progress-row';

        var nameSpan = document.createElement('span');
        nameSpan.className = 'mb-progress-name';
        nameSpan.textContent = filename || t('mb.file');
        row.appendChild(nameSpan);

        var barWrap = document.createElement('div');
        barWrap.className = 'mb-progress-bar';
        var fill = document.createElement('div');
        fill.className = 'mb-progress-fill';
        fill.style.width = '0%';
        barWrap.appendChild(fill);
        row.appendChild(barWrap);

        var pctSpan = document.createElement('span');
        pctSpan.className = 'mb-progress-pct';
        pctSpan.textContent = '0%';
        row.appendChild(pctSpan);

        container.appendChild(row);

        // Scroll en bas pour voir la progression
        container.scrollTop = container.scrollHeight;

        return {
            row: row,
            fill: fill,
            pctSpan: pctSpan,
            nameSpan: nameSpan,
        };
    }

    function updateProgress(progressEl, pct, text) {
        if (!progressEl) return;
        progressEl.fill.style.width = pct + '%';
        progressEl.pctSpan.textContent = (typeof pct === 'number' ? Math.round(pct) : pct) + '%';
        if (text) {
            progressEl.nameSpan.textContent = text;
        }
    }

})();
