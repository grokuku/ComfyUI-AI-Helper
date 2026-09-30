/**
 * AIH Model Browser — Parcourir, uploader et télécharger des modèles.
 *
 * Dépend : 01_aih_modal_v2.js (aihOpenModalV2)
 *           aih_elements_widget.js (esc, getApiUrl)
 *
 * Fonctions exportées sur window :
 *   - openModelBrowser()    → ouvre la fenêtre Model Browser
 *
 * Multi-sélection : clic simple = sélection unique ; Ctrl/Cmd+clic =
 * ajouter/retirer ; Maj+clic = plage ; case « tout sélectionner » par panneau
 * (sur le résultat filtré) ; barre « N sélectionné(s) » + lot + effacement.
 * Les modifieurs sont lus sur le CLIC (jamais sur 'change', qui ne les porte
 * pas dans un navigateur réel).
 *
 * Transferts : bouton permanent « Transferts » (badge = transferts en cours +
 * en attente) ; le double-clic d'une ligne DISTANTE télécharge et ouvre la
 * fenêtre (js/aih_download_window.js), délégué sur le conteneur de liste.
 */

import "./aih_dialog.js";
import "./aih_download_window.js";
import "./aih_strings.js";
import { remoteRequest, normalizeServerUrl } from "./aih_fetch_bridge.js";
import { HolafFetch } from "./vendor/holaf/holaf-fetch.js";
import {
    collectWorkflowModelNames,
    buildWorkflowNameIndex,
    filterModelItems,
    filterModelsByWorkflow,
    countWorkflowMatches,
} from "./aih_model_workflow.js";

// ─── Budget de pagination du filtre « workflow » ────────────────────────────
// Le filtre distant est appliqué CÔTÉ CLIENT (le proxy serveur ne connaît pas
// la liste des modèles du workflow). Quand le filtre est actif, on charge donc
// automatiquement les pages successives jusqu'à épuisement du catalogue, dans
// la limite de ce plafond (page de 200 modèles → 4000 modèles max). Au-delà,
// un bandeau prévient que la liste peut être partielle.
var WF_REMOTE_PAGE_LIMIT = 200;
var WF_REMOTE_MAX_PAGES = 20;

(function () {
    "use strict";

    // ─── Helper i18n central : traduit via AIH.I18n (clé brute si absente) ──────
    var t = function (key, params) {
        var I = window.AIH && window.AIH.I18n;
        return I && typeof I.t === "function" ? I.t(key, params) : key;
    };

    // ─── Build marker + sonde d'obsolescence (motif Workflow Share) ────────────
    // Cause PROUVÉE d'un correctif « livré mais invisible » : le navigateur
    // exécute un 02_aih_model_browser.js PÉRIMÉ (cache heuristique du serveur
    // statique ComfyUI, antérieur au middleware no-cache du pack). La sonde
    // relit le fichier RÉELLEMENT servi (fetch cache:no-store) et compare son
    // marqueur à celui-ci : si le code en cours est plus ancien que le fichier
    // servi, on le DIT (console + bandeau). Les symptômes exacts d'un build
    // périmé — barre d'outils « Transferts » absente et fenêtre de progression
    // jamais ouverte — cessent alors d'être confondus avec un bug de code.
    var AIH_MB_BUILD = "mb-transfers-2026-09-30-r7";
    var AIH_MB_BUILD_RX = /AIH_MB_BUILD\s*=\s*["']([^"']+)["']/;
    var _mbStaleWarned = false;

    function _mbExtractBuild(text) {
        var m = AIH_MB_BUILD_RX.exec(String(text == null ? "" : text));
        return m ? m[1] : null;
    }

    // Compare le marqueur EN COURS à celui du fichier réellement servi.
    // @returns {Promise<boolean|null>} true=obsolète, false=à jour, null=indéterminé.
    function checkServedBuildFreshness() {
        if (typeof fetch !== "function" || typeof window === "undefined") {
            return Promise.resolve(null);
        }
        var url;
        try {
            url = new URL(import.meta.url, window.location.href);
            url.searchParams.set("aih_build_probe", String(Date.now()));
        } catch (e) {
            return Promise.resolve(null);
        }
        return fetch(url.toString(), { cache: "no-store" })
            .then(function (res) { return res && res.ok ? res.text() : null; })
            .then(function (text) {
                var served = _mbExtractBuild(text);
                var stale = served !== null && served !== AIH_MB_BUILD;
                if (window.AIH_MB) window.AIH_MB.stale = stale;
                if (stale && !_mbStaleWarned) {
                    _mbStaleWarned = true;
                    console.error("[AIH] Model Browser OBSOLÈTE — exécuté " + AIH_MB_BUILD
                        + " / servi " + served
                        + " : le navigateur exécute un JS périmé. Recharge FORCÉE"
                        + " (Ctrl+Shift+R / Cmd+Shift+R).");
                }
                return stale;
            })
            .catch(function () { return null; });
    }

    // Exposé pour les tests et le diagnostic utilisateur.
    window.AIH_MB = {
        build: AIH_MB_BUILD,
        stale: null,
        checkServedBuildFreshness: checkServedBuildFreshness,
    };

    // ─── Fenêtre de progression dédiée (js/aih_download_window.js) ─────────────
    // Ouverte AU LANCEMENT d'un téléchargement (unitaire ET lot) : c'est la vue
    // demandée (nom du fichier, PHASE explicite, %, octets/total, MB/s, ETA,
    // ✕ par ligne, progression globale N/M, récap final). La progression « en
    // ligne » de la liste reste en place (aucune régression). Si AIH.DownloadWindow
    // est absent (build périmé ou module non chargé), on le SIGNALE bruyamment
    // une seule fois au lieu de continuer en silence sans fenêtre.
    var _dlWindow = null;
    var _dlWinUnavailableWarned = false;
    function _dlWinOpen() {
        if (!(window.AIH && window.AIH.DownloadWindow)) {
            if (!_dlWinUnavailableWarned) {
                _dlWinUnavailableWarned = true;
                console.error("[AIH] Fenêtre de transferts INDISPONIBLE : "
                    + "window.AIH.DownloadWindow absent (build " + AIH_MB_BUILD
                    + " / module aih_download_window.js non chargé). Recharge FORCÉE"
                    + " (Ctrl+Shift+R / Cmd+Shift+R).");
            }
            return null;
        }
        _dlWindow = window.AIH.DownloadWindow.open();
        return _dlWindow;
    }
    function _dlWinAdd(uploadId, name, sizeBytes) {
        var w = _dlWinOpen();
        return w ? w.addFile(name, { uploadId: uploadId, sizeBytes: sizeBytes }) : null;
    }
    function _dlWinStart(uploadId) {
        var w = _dlWinOpen();
        if (w) w.startFile(uploadId);
    }
    function _dlWinSettle(uploadId, kind, message) {
        if (_dlWindow && _dlWindow.isOpen()) _dlWindow.setResult(uploadId, kind, message);
    }
    function _dlWinDone() {
        if (_dlWindow && _dlWindow.isOpen()) _dlWindow.done();
    }

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
            /* Filtre « modèles du workflow » + récapitulatif */
            ".mb-filters .mb-filter-workflow {",
            "  font-weight: 600;",
            "}",
            ".mb-workflow-summary {",
            "  width: 100%;",
            "  font-size: 10px;",
            "  color: #888;",
            "  padding: 1px 2px 0;",
            "}",
            ".mb-workflow-summary .mb-wf-missing {",
            "  color: #f87171;",
            "  font-weight: 600;",
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
            /* Barre d'outils + point d'entrée permanent « Transferts » */
            ".mb-toolbar { display: flex; align-items: center; gap: 8px; padding: 2px 0 6px; flex-shrink: 0; }",
            ".mb-transfers-btn { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 6px; border: 1px solid #444; background: #1e1e22; color: #ddd; font-size: 11px; font-weight: 600; cursor: pointer; transition: border-color 0.15s, background 0.15s; }",
            ".mb-transfers-btn:hover { border-color: var(--aih-accent, #D8700D); background: #2a2a2e; }",
            ".mb-transfers-badge { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--aih-accent, #D8700D); color: #fff; font-size: 10px; font-weight: 700; line-height: 18px; text-align: center; }",
            ".mb-transfers-badge.is-empty { background: #444; color: #999; }",
            ".mb-build-label { margin-left: auto; font-size: 10px; color: #555; user-select: text; }",
            ".mb-stale-banner { font-size: 11px; color: #f87171; background: rgba(220,38,38,0.12); border: 1px solid #7f1d1d; border-radius: 6px; padding: 6px 8px; margin: 2px 0 6px; flex-shrink: 0; }",
            /* Sélection : barre de compteur + effacement */
            ".mb-selection-bar { display: flex; align-items: center; gap: 8px; padding: 6px 0 0; flex-shrink: 0; }",
            ".mb-selection-count { font-size: 10px; color: #9ca3af; white-space: nowrap; }",
            ".mb-clear-selection { padding: 5px 10px; border-radius: 6px; border: 1px solid #444; background: transparent; color: #bbb; font-size: 10px; cursor: pointer; }",
            ".mb-clear-selection:hover { border-color: #f87171; color: #f87171; }",
            ".mb-clear-selection:disabled { opacity: 0.4; cursor: default; }",
            ".mb-select-all-row { display: inline-flex; align-items: center; gap: 4px; font-weight: 400; color: #888; font-size: 10px; cursor: pointer; user-select: none; margin-left: 8px; }",
            ".mb-select-all-row input { accent-color: var(--aih-accent, #D8700D); }",
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
            ".mb-progress-cancel {",
            "  flex-shrink: 0;",
            "  width: 20px;",
            "  height: 20px;",
            "  line-height: 1;",
            "  padding: 0;",
            "  border: 1px solid #555;",
            "  border-radius: 4px;",
            "  background: transparent;",
            "  color: #aaa;",
            "  font-size: 11px;",
            "  cursor: pointer;",
            "}",
            ".mb-progress-cancel:hover {",
            "  border-color: #dc2626;",
            "  color: #f87171;",
            "}",
            ".mb-progress-cancel:disabled {",
            "  opacity: 0.5;",
            "  cursor: default;",
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
    // Retourne une Response (contrat inchangé : les appelants font r.json()).
    function _fetchAihApi(path, opts) {
        opts = opts || {};
        // Lire la config depuis localStorage (même clé que aih_menu.js)
        var cfg = {};
        try { cfg = JSON.parse(localStorage.getItem('AIH_config') || '{}'); } catch(e) {}
        var baseUrl = normalizeServerUrl(cfg.serverUrl);
        if (!baseUrl) {
            return Promise.reject(new Error(t('aih.notConfiguredError')));
        }
        var cleanPath = path.replace(/^\/+/, '');
        var finalPath = cleanPath.startsWith('api/') ? cleanPath : 'api/' + cleanPath;
        // raw:true → on rend la Response brute ; l'auth Bearer est injectée par
        // la brique (même source : cfg.apiKey / AIH_config).
        return remoteRequest(baseUrl + '/' + finalPath, Object.assign({}, opts, { raw: true }));
    }

    function getActiveTypeFilters() {
        // NB : on exclut le toggle « modèles du workflow » (dataset.type absent) :
        // il a sa propre classe mb-filter-workflow et son propre état.
        var checked = document.querySelectorAll('.mb-filter-checkbox.active:not(.mb-filter-workflow)');
        var types = [];
        checked.forEach(function (el) {
            if (el.dataset && el.dataset.type) types.push(el.dataset.type);
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

    // ─── Filtre « modèles du workflow courant » ─────────────────────────────
    // L'extraction vit dans aih_model_workflow.js (pur, testé). Ici on ne fait
    // que résoudre l'app ComfyUI et mémoriser le résultat par modale.
    //
    // RAFRAÎCHISSEMENT : recalculé (a) à l'ouverture du navigateur et (b) à
    // chaque ACTIVATION du bouton (le workflow a pu changer entre deux
    // ouvertures). Pas de listener sur les évènements du graphe ComfyUI : une
    // modification du workflow pendant que la fenêtre est OUVERTE n'est pas
    // reflétée tant que le bouton n'est pas re-cliqué ou la fenêtre rouverte.
    function getComfyApp() {
        try {
            return (typeof window !== 'undefined' &&
                (window.app || (window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app))) || null;
        } catch (e) {
            return null;
        }
    }

    function refreshWorkflowModels(m) {
        var names = [];
        try { names = collectWorkflowModelNames(getComfyApp()); } catch (e) { names = []; }
        m._workflowModelNames = names;
        m._workflowIndex = buildWorkflowNameIndex(names);
        return names;
    }

    // Index du workflow si le filtre est actif, sinon null (= pas de filtre).
    function getWorkflowIndex(m) {
        if (!m._workflowFilterActive) return null;
        if (!m._workflowIndex) m._workflowIndex = buildWorkflowNameIndex(m._workflowModelNames || []);
        return m._workflowIndex;
    }

    function workflowFilterLabelText(m) {
        var count = (m._workflowModelNames || []).length;
        return t('mb.workflowFilterCount', { count: count });
    }

    // Clé i18n du message « liste vide » : distingue « aucun modèle détecté
    // dans le workflow » de « aucun résultat avec ces filtres ».
    function _emptyFilteredKey(m, fallbackKey) {
        if (!m._workflowFilterActive) return fallbackKey;
        return (m._workflowModelNames || []).length === 0
            ? 'mb.workflowEmpty'
            : 'mb.workflowNoMatch';
    }

    // Met à jour le libellé (avec compteur) du toggle.
    function updateWorkflowFilterLabel(m) {
        if (!m._workflowFilterEl) return;
        var txt = m._workflowFilterEl.querySelector('.mb-filter-workflow-text');
        if (txt) txt.textContent = workflowFilterLabelText(m);
    }

    // Récapitulatif « présent local / distant / manquant » (affiché uniquement
    // quand le filtre workflow est actif). Valeur ajoutée du partage : montre
    // d'un coup d'œil ce qu'il reste à uploader/télécharger.
    function updateWorkflowSummary(m) {
        var el = m._workflowSummaryEl;
        if (!el) return;
        if (!m._workflowFilterActive) {
            el.style.display = 'none';
            el.textContent = '';
            return;
        }
        var names = m._workflowModelNames || [];
        var idx = m._workflowIndex || buildWorkflowNameIndex(names);
        var total = names.length;
        var localCount = countWorkflowMatches(_localModelsCache || m._localItems || [], idx);
        var remoteCount = countWorkflowMatches(m._remoteItems || [], idx);
        var missing = Math.max(0, total - remoteCount);
        el.style.display = '';
        el.innerHTML = t('mb.workflowSummary', {
            total: total, local: localCount, remote: remoteCount, missing: missing,
        }) + (m._wfRemoteCapped ? ' ' + t('mb.workflowCapped') : '');
    }

    // ─── Filtre les items locaux depuis le cache (type + search + workflow) ────
    function filterLocalItems(items, types, search, workflowIndex) {
        return filterModelItems(items, {
            types: types,
            search: search,
            workflowIndex: workflowIndex,
            getType: getEffectiveType,
        });
    }

    // ─── Helpers multi-sélection (source de vérité = cases cochées du DOM) ─────
    // La sélection vit dans le DOM : elle reste correcte après un re-render,
    // un changement de filtre ou une pagination (aucun état fantôme possible
    // dans les listes complètes, contrairement à un flag sur les items).
    function getSelectedItems(list) {
        if (!list) return [];
        var rows = list.querySelectorAll('.mb-item');
        var out = [];
        for (var i = 0; i < rows.length; i++) {
            var cb = rows[i].querySelector('.mb-checkbox');
            if (cb && cb.checked && rows[i]._aihItem) out.push(rows[i]._aihItem);
        }
        return out;
    }

    function _countChecked(list) {
        return getSelectedItems(list).length;
    }

    function _setRowChecked(row, selected, items) {
        if (!row) return;
        var cb = row.querySelector('.mb-checkbox');
        if (cb) cb.checked = !!selected;
        var idx = parseInt(row.dataset.index, 10);
        if (!isNaN(idx) && items && items[idx]) items[idx]._selected = !!selected;
        row.classList.toggle('selected', !!selected);
    }

    function clearSelection(list, m) {
        if (!list) return;
        var rows = list.querySelectorAll('.mb-item');
        for (var i = 0; i < rows.length; i++) {
            _setRowChecked(rows[i], false, null);
            if (rows[i]._aihItem) rows[i]._aihItem._selected = false;
        }
        if (m) {
            if (list === m._localList) m._lastCheckedLocal = -1;
            else m._lastCheckedRemote = -1;
            updateBatchButtons(m);
        }
    }

    function setAllRows(m, list, items, state) {
        if (!list) return;
        var rows = list.querySelectorAll('.mb-item');
        for (var i = 0; i < rows.length; i++) {
            var cb = rows[i].querySelector('.mb-checkbox');
            if (cb) cb.checked = !!state;
            var it = rows[i]._aihItem;
            if (it) it._selected = !!state;
            rows[i].classList.toggle('selected', !!state);
        }
        if (m) updateBatchButtons(m);
    }

    function updateBatchButtons(m) {
        if (!m || !m.modal) return;
        var localSel = _countChecked(m._localList);
        var remoteSel = _countChecked(m._remoteList);
        var localBtn = m.modal.querySelector('.mb-batch-upload');
        var remoteBtn = m.modal.querySelector('.mb-batch-download');
        if (localBtn) {
            localBtn.disabled = localSel === 0;
            localBtn.textContent = t('mb.uploadSelected', { count: localSel });
        }
        if (remoteBtn) {
            remoteBtn.disabled = remoteSel === 0;
            remoteBtn.textContent = t('mb.downloadSelected', { count: remoteSel });
        }
        var lc = m.modal.querySelector('.mb-selection-count[data-scope="local"]');
        if (lc) lc.textContent = t('mb.selectionCount', { count: localSel });
        var rc = m.modal.querySelector('.mb-selection-count[data-scope="remote"]');
        if (rc) rc.textContent = t('mb.selectionCount', { count: remoteSel });
        var lb = m.modal.querySelector('.mb-clear-selection[data-scope="local"]');
        if (lb) lb.disabled = localSel === 0;
        var rb = m.modal.querySelector('.mb-clear-selection[data-scope="remote"]');
        if (rb) rb.disabled = remoteSel === 0;
        _syncSelectAll(m, m._localList, 'local');
        _syncSelectAll(m, m._remoteList, 'remote');
    }

    function _syncSelectAll(m, list, scope) {
        var rows = list ? list.querySelectorAll('.mb-item') : [];
        var total = rows.length;
        var checked = _countChecked(list);
        var box = m.modal.querySelector('.mb-select-all-row[data-scope="' + scope + '"] .mb-select-all-cb');
        if (!box) return;
        box.checked = total > 0 && checked === total;
        box.indeterminate = checked > 0 && checked < total;
    }

    // Sélection par clic : Ctrl/Cmd = ajouter/retirer, Maj = plage, clic simple
    // = sélection unique. Les modifieurs sont lus sur l'évènement SOURIS (click) :
    // dans un vrai navigateur, un évènement 'change' de case à cocher ne porte
    // PAS shiftKey/ctrlKey (undefined) — cause du multi-sélection impossible
    // (chaque case décochait les autres, même avec Ctrl enfoncé).
    function _selectionClick(e, row, list, items, m) {
        var cb = row.querySelector('.mb-checkbox');
        if (!cb) return;
        var allRows = Array.prototype.slice.call(list.querySelectorAll('.mb-item'));
        var domIdx = allRows.indexOf(row);
        if (domIdx < 0) return;
        var isShift = !!e.shiftKey;
        var isCtrl = !!(e.ctrlKey || e.metaKey);
        var clickedCheckbox = (e.target === cb);
        var globalIdx = parseInt(row.dataset.index, 10);
        if (isNaN(globalIdx)) globalIdx = domIdx;
        var anchorKey = (list === m._localList) ? '_lastCheckedLocal' : '_lastCheckedRemote';
        var anchor = (typeof m[anchorKey] === 'number') ? m[anchorKey] : -1;

        function rowAt(g) { return list.querySelector('.mb-item[data-index="' + g + '"]'); }

        if (isShift && anchor >= 0) {
            var anchorRow = rowAt(anchor) || allRows[anchor];
            var anchorCb = anchorRow ? anchorRow.querySelector('.mb-checkbox') : null;
            var fill = anchorCb ? anchorCb.checked : true;
            var s = Math.min(anchor, globalIdx);
            var en = Math.max(anchor, globalIdx);
            for (var g = s; g <= en; g++) {
                var rEl = rowAt(g);
                if (rEl) _setRowChecked(rEl, fill, items);
            }
        } else if (isCtrl) {
            _setRowChecked(row, clickedCheckbox ? cb.checked : !cb.checked, items);
            m[anchorKey] = globalIdx;
        } else {
            allRows.forEach(function (rEl) {
                _setRowChecked(rEl, rEl === row, items);
            });
            m[anchorKey] = globalIdx;
        }
        updateBatchButtons(m);
    }

    // Double-clic délégué sur la liste : ligne → action (download distant,
    // upload local). Ignore les contrôles interactifs (case, champ, bouton).
    function _onListDblClick(e, m, isRemote) {
        var row = e.target && e.target.closest ? e.target.closest('.mb-item') : null;
        if (!row) return;
        if (e.target.closest && e.target.closest('input, button, select, textarea, a')) return;
        var item = row._aihItem;
        if (!item) return;
        if (isRemote) {
            var uploadId = item.id || item.upload_id || item._id;
            var destInput = row.querySelector('.mb-dest-input');
            var destSubdir = (destInput && destInput.value.trim()) || getDefaultDestDir(item) || '';
            downloadRemoteModel(m, uploadId, item.name || item.filename || '?',
                getEffectiveType(item), destSubdir, item.size);
        } else {
            uploadLocalModel(m, item.path || item.filepath, getEffectiveType(item),
                item.name || item.filename);
        }
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

            // Route locale /api/aih/* → HolafFetch SANS auth (same-origin transparente).
            HolafFetch.post('/api/aih/models/upload', {
                body: {
                    path: filepath,
                    type: fileType,
                },
                // Transfert LONG (modèle de plusieurs Go) : le timeout client
                // par défaut (30 s) abandonnerait l'envoi → « Erreur: timeout ».
                timeout: 0,
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

            var progressEl = showProgress(m, displayName, { cancelable: true });

            // Fenêtre de progression dédiée : la ligne a été créée au lancement
            // du lot (état « En attente ») ; startFile bascule vers
            // « Préparation côté serveur… » puis « Transfert ».
            _dlWinStart(uploadId);

            // Progression live + bouton d'annulation (voir _downloadRequest).
            _downloadRequest({
                upload_id: uploadId,
                filename: displayName,
                type: fileType,
                dest_path: destSubdir,
            }, progressEl)
                .then(function (data) {
                    if (data.status === 'ok' || data.success) {
                        if (data.conflict) {
                            // Lot : conflit ignoré (résolution manuelle non
                            // proposée ici) → la ligne de fenêtre n'est PAS un
                            // succès : classée « annulé ».
                            updateProgress(progressEl, 50, t('mb.conflictIgnore'));
                            _dlWinSettle(uploadId, 'cancelled');
                            resolve();
                            return;
                        }
                        updateProgress(progressEl, 100, t('mb.downloadDone'));
                        _dlWinSettle(uploadId, 'ok');
                        resolve();
                    } else if (data.cancelled) {
                        // Annulation utilisateur : message dédié, pas « ❌ Erreur ».
                        updateProgress(progressEl, 0, t('mb.downloadCancelled'));
                        _dlWinSettle(uploadId, 'cancelled');
                        reject(new Error(t('mb.downloadCancelled')));
                    } else {
                        var errMsg = data.error || data.message || t('aih.unknown');
                        updateProgress(progressEl, 0, t('mb.errorPrefix') + errMsg);
                        _dlWinSettle(uploadId, 'failed', errMsg);
                        reject(new Error(data.error || t('aih.failed')));
                    }
                })
                .catch(function (err) {
                    updateProgress(progressEl, 0, t('mb.errorPrefix') + err.message);
                    _dlWinSettle(uploadId, 'failed', err.message);
                    reject(err);
                });
        });
    }

    // ─── batchUpload ────────────────────────────────────────────────────────────
    function batchUpload(m) {
        var selected = getSelectedItems(m._localList);
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
                clearSelection(m._localList, m);
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
        var selected = getSelectedItems(m._remoteList);
        if (selected.length === 0) return;
        var btn = m.modal.querySelector('.mb-batch-download');
        if (!btn) return;
        btn.disabled = true;
        btn.textContent = t('mb.downloading');

        // Fenêtre de progression : une ligne par fichier AVANT le premier
        // transfert (« En attente ») → progression globale N/M exacte et
        // visibilité immédiate du lot (demande utilisateur).
        var win = _dlWinOpen();
        if (win) {
            selected.forEach(function (it) {
                var uid = it.id || it.upload_id || it._id;
                if (uid) win.addFile(it.name || it.filename || '?', { uploadId: uid, sizeBytes: it.size });
            });
        }

        var done = 0;
        function next() {
            if (done >= selected.length) {
                btn.textContent = t('mb.done');
                setTimeout(function () {
                    btn.textContent = t('mb.downloadSelected', { count: 0 });
                    btn.disabled = true;
                }, 2000);
                // Désélectionner tout
                clearSelection(m._remoteList, m);
                m._remotePage = 1;
                m._remoteHasMore = true;
                loadRemoteModels(m);
                loadLocalModels(m, true);
                // État final de la fenêtre : « Téléchargement terminé » + récap.
                _dlWinDone();
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

        var _mRef = { controller: null };
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
            // Désabonne le badge du compteur de transferts quand la fenêtre est
            // fermée (aucune fuite d'abonné d'une ouverture à l'autre).
            onClose: function () {
                var c = _mRef.controller;
                if (c && typeof c._transfersUnsub === "function") {
                    try { c._transfersUnsub(); } catch (e) { /* silencieux */ }
                    c._transfersUnsub = null;
                }
            },
        });
        _mRef.controller = m;
        renderModelBrowser(m);

    };

    // ─── renderModelBrowser ──────────────────────────────────────────────────────
    function renderModelBrowser(m) {
        m.body.style.display = "flex";
        m.body.style.flexDirection = "column";
        m.body.style.padding = "8px 12px";

        m.body.innerHTML = "" +
            '<div class="mb-filters" id="mb-filters"></div>' +
            // Bandeau « build obsolète » : rempli par la sonde de fraîcheur
            // (voir checkServedBuildFreshness). Masqué par défaut.
            '<div id="mb-stale-banner" class="mb-stale-banner" style="display:none;"></div>' +
            '<div class="mb-toolbar" id="mb-toolbar">' +
            '  <button type="button" class="mb-transfers-btn" title="' + t('mb.transfersTitle') + '">' +
            '    <span class="mb-transfers-label">' + t('mb.transfers') + '</span>' +
            '    <span class="mb-transfers-badge is-empty">0</span>' +
            '  </button>' +
            '  <span class="mb-build-label">' + _esc(AIH_MB_BUILD) + '</span>' +
            '</div>' +
            '<div class="mb-panels" id="mb-panels">' +
            '  <div class="mb-panel mb-panel-local">' +
            '    <div class="mb-panel-header">' + t('mb.panelLocal') +
            '      <label class="mb-select-all-row" data-scope="local"><input type="checkbox" class="mb-select-all-cb"> ' + t('mb.selectAllRows') + '</label>' +
            '    </div>' +
            '    <div class="mb-panel-list" id="mb-local-list"></div>' +
            '    <div class="mb-panel-footer mb-panel-footer-local">' +
            '      <span class="mb-selection-count" data-scope="local">' + t('mb.selectionCount', { count: 0 }) + '</span>' +
            '      <button class="mb-batch-btn mb-batch-upload" disabled>' + t('mb.uploadSelected', { count: 0 }) + '</button>' +
            '      <button type="button" class="mb-clear-selection" data-scope="local" disabled>' + t('mb.clearSelection') + '</button>' +
            '    </div>' +
            '  </div>' +
            '  <div class="mb-divider"></div>' +
            '  <div class="mb-panel mb-panel-remote">' +
            '    <div class="mb-panel-header">' + t('mb.panelRemote') +
            '      <label class="mb-select-all-row" data-scope="remote"><input type="checkbox" class="mb-select-all-cb"> ' + t('mb.selectAllRows') + '</label>' +
            '    </div>' +
            '    <div class="mb-panel-list" id="mb-remote-list"></div>' +
            '    <div class="mb-panel-footer mb-panel-footer-remote">' +
            '      <span class="mb-selection-count" data-scope="remote">' + t('mb.selectionCount', { count: 0 }) + '</span>' +
            '      <button class="mb-batch-btn mb-batch-download" disabled>' + t('mb.downloadSelected', { count: 0 }) + '</button>' +
            '      <button type="button" class="mb-clear-selection" data-scope="remote" disabled>' + t('mb.clearSelection') + '</button>' +
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
        // Filtre « modèles du workflow » : état initial inactif ; l'extraction
        // est faite ici (ouverture du navigateur) puis à chaque activation.
        m._workflowFilterActive = false;
        m._workflowModelNames = [];
        m._workflowIndex = buildWorkflowNameIndex([]);
        m._workflowFilterEl = null;
        m._workflowSummaryEl = null;
        m._remoteLimit = 50;
        m._wfRemoteCapped = false;
        refreshWorkflowModels(m);

        // Récupérer le rôle de l'utilisateur (pour les actions admin)
        _fetchAihApi('auth/me')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data && data.role) {
                    m._currentUser = { role: data.role };
                    // Re-rendre le panneau distant si déjà chargé (page 1
                    // uniquement : évite tout doublon quand le filtre workflow
                    // a auto-chargé plusieurs pages).
                    if (m._remoteItems && m._remoteItems.length && (m._remotePage || 1) === 1) {
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
            // En filtre workflow, le chargement des pages est piloté en boucle
            // (loadRemoteModels) : on neutralise le scroll pour éviter un
            // double incrément de page.
            if (m._workflowFilterActive) return;
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

        // Point d'entrée PERMANENT « Transferts » : ouvre (ou rouvre) la
        // fenêtre de progression à tout moment, même après un masquage.
        var transfersBtn = m.modal.querySelector('.mb-transfers-btn');
        if (transfersBtn) {
            transfersBtn.addEventListener('click', function () {
                if (window.AIH && window.AIH.DownloadWindow) window.AIH.DownloadWindow.open();
            });
        }

        // Badge : reflète en continu le nombre de transferts en cours + en file.
        m._transfersUnsub = null;
        if (window.AIH && window.AIH.DownloadWindow && typeof window.AIH.DownloadWindow.onChange === 'function') {
            var badgeEl = m.modal.querySelector('.mb-transfers-badge');
            m._transfersUnsub = window.AIH.DownloadWindow.onChange(function (count) {
                if (!badgeEl || !badgeEl.isConnected) return;
                badgeEl.textContent = String(count);
                badgeEl.classList.toggle('is-empty', count === 0);
                badgeEl.title = t('mb.transfersBadgeTitle', { count: count });
            });
        }

        // Effacer la sélection par panneau.
        m.modal.querySelectorAll('.mb-clear-selection').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var scope = btn.dataset.scope;
                clearSelection(scope === 'local' ? m._localList : m._remoteList, m);
            });
        });

        // Case « tout sélectionner » sur le résultat filtré, par panneau.
        m.modal.querySelectorAll('.mb-select-all-row').forEach(function (label) {
            var box = label.querySelector('.mb-select-all-cb');
            if (!box) return;
            box.addEventListener('change', function () {
                var scope = label.dataset.scope;
                setAllRows(m, scope === 'local' ? m._localList : m._remoteList,
                    scope === 'local' ? m._localItems : m._remoteItems, box.checked);
            });
        });

        // DELÉGATION du double-clic sur les listes : le handler survit à tout
        // re-render (auth/me, changement de filtre, pagination) sans re-câblage
        // par ligne — cause possible d'un double-clic muet si une ligne était
        // remplacée sans son binding.
        if (m._localList) {
            m._localList.addEventListener('dblclick', function (e) { _onListDblClick(e, m, false); });
        }
        if (m._remoteList) {
            m._remoteList.addEventListener('dblclick', function (e) { _onListDblClick(e, m, true); });
        }

        // Sonde de fraîcheur : si le fichier SERVI contient un marqueur de build
        // différent de celui en cours, ce code est PÉRIMÉ. On l'affiche au lieu
        // de laisser croire à une fonctionnalité cassée.
        var staleBanner = m.modal.querySelector('#mb-stale-banner');
        if (staleBanner) {
            checkServedBuildFreshness().then(function (stale) {
                if (!stale || !staleBanner.isConnected) return;
                staleBanner.textContent = t('mb.staleBuild', { running: AIH_MB_BUILD });
                staleBanner.style.display = 'block';
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
                var checkboxes = container.querySelectorAll('.mb-filter-checkbox:not(.mb-filter-workflow)');
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

        // Filtre « modèles du workflow courant » (toggle, cumulable avec les
        // types et la recherche). Placé à côté des filtres existants.
        var wfLabel = document.createElement('label');
        wfLabel.className = 'mb-filter-checkbox mb-filter-workflow' + (m._workflowFilterActive ? ' active' : '');
        wfLabel.style.setProperty('--mb-color', '#38bdf8');
        wfLabel.title = t('mb.workflowFilterTitle');
        var wfCb = document.createElement('input');
        wfCb.type = 'checkbox';
        wfCb.checked = !!m._workflowFilterActive;
        wfLabel.appendChild(wfCb);
        var wfDot = document.createElement('span');
        wfDot.textContent = '🧩';
        wfDot.style.marginRight = '2px';
        wfLabel.appendChild(wfDot);
        var wfText = document.createElement('span');
        wfText.className = 'mb-filter-workflow-text';
        wfText.textContent = workflowFilterLabelText(m);
        wfLabel.appendChild(wfText);
        wfLabel.addEventListener('click', function (e) {
            e.preventDefault();
            var isActive = wfLabel.classList.toggle('active');
            wfCb.checked = isActive;
            m._workflowFilterActive = isActive;
            if (isActive) {
                // Recalcul à l'activation : le workflow a pu changer depuis l'ouverture.
                refreshWorkflowModels(m);
            }
            updateWorkflowFilterLabel(m);
            m._remotePage = 1;
            m._remoteHasMore = true;
            m._wfRemoteCapped = false;
            loadLocalModels(m);
            loadRemoteModels(m);
        });
        container.appendChild(wfLabel);
        m._workflowFilterEl = wfLabel;

        // Récapitulatif (affiché seulement quand le filtre workflow est actif).
        var summary = document.createElement('div');
        summary.className = 'mb-workflow-summary';
        summary.style.display = m._workflowFilterActive ? '' : 'none';
        container.appendChild(summary);
        m._workflowSummaryEl = summary;

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
        var wfIndex = getWorkflowIndex(m);

        // Cache : si déjà chargé et pas de force refresh, filtrer depuis le cache
        if (_localModelsCache && !forceRefresh) {
            var filtered = filterLocalItems(_localModelsCache, types, search, wfIndex);
            m._localItems = _localModelsCache; // pour isLocalByFingerprint (liste complète)
            renderLocalPanel(m, filtered);
            return;
        }

        // Premier chargement ou refresh forcé : on fetch TOUT (pas de filtre serveur)
        var url = '/api/aih/models/local';

        m._localList.innerHTML = '<div class="mb-loading"><span class="mb-loading-spinner"></span> ' + t('mb.loading') + '</div>';

        // Route locale /api/aih/* → HolafFetch SANS auth (same-origin transparente).
        HolafFetch.get(url)
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

                // Filtrer selon les filtres actifs (types + recherche + workflow)
                var filtered = filterLocalItems(flatItems, types, search, wfIndex);
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
        var wfActive = !!m._workflowFilterActive;
        // Le filtre workflow est CLIENT : quand il est actif, on charge tout le
        // catalogue (pages de 200, plafonné) pour ne pas rater un modèle au-delà
        // de la première page. Sinon pagination historique (50).
        var limit = wfActive ? WF_REMOTE_PAGE_LIMIT : 50;
        m._remoteLimit = limit;

        var url = '/api/aih/models/remote?page=' + page + '&limit=' + limit;
        // N'envoyer le filtre type que si certains types sont DESACTIVES.
        // Quand tous sont actifs, pas de filtre = tout afficher.
        if (types && types.length && types.length < MODEL_TYPES.length) {
            url += '&type=' + encodeURIComponent(types.join(','));
        }
        if (search) url += '&search=' + encodeURIComponent(search);

        if (page === 1) {
            m._remoteList.innerHTML = '<div class="mb-loading"><span class="mb-loading-spinner"></span> ' + t('mb.loading') + '</div>';
        }

        // Route locale /api/aih/* → HolafFetch SANS auth (same-origin transparente).
        HolafFetch.get(url)
            .then(function (data) {
                renderRemotePanel(m, data);
                m._remoteLoading = false;
                // Filtre workflow actif : enchaîner les pages jusqu'à épuisement
                // (ou plafond), pour que la liste filtrée soit complète.
                if (wfActive && m._remoteHasMore) {
                    if (page < WF_REMOTE_MAX_PAGES) {
                        m._remotePage = page + 1;
                        loadRemoteModels(m);
                    } else {
                        m._wfRemoteCapped = true;
                        updateWorkflowSummary(m);
                    }
                }
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
            list.innerHTML = '<div class="mb-empty">' + t(_emptyFilteredKey(m, 'mb.noLocal')) + '</div>';
            updateWorkflowSummary(m);
            updateBatchButtons(m);
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

        // Ancrage Shift+Click propre à CE panneau (local ≠ distant).
        if (typeof m._lastCheckedLocal !== 'number') m._lastCheckedLocal = -1;

        items.forEach(function (item, idx) {
            var div = document.createElement('div');
            div.className = 'mb-item';
            div.dataset.index = idx;
            div._aihItem = item;

            // ── Checkbox + multi-sélection (clic, Ctrl/Cmd, Maj) ──
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'mb-checkbox';
            cb.addEventListener('click', function (e) {
                _selectionClick(e, div, list, items, m);
                e.stopPropagation();
            });
            div.appendChild(cb);

            // ── Clic sur la ligne → sélection (Ctrl/Cmd = toggle, Maj = plage) ──
            div.addEventListener('click', function (e) {
                if (e.target && e.target.closest && e.target.closest('input, button, select, textarea, a')) return;
                _selectionClick(e, div, list, items, m);
            });

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

            // ── Double-clic → upload direct (délégué sur la liste) ──

            list.appendChild(div);
        });

        updateWorkflowSummary(m);
        updateBatchButtons(m);
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
            var lim = data.limit || m._remoteLimit || 50;
            m._remoteHasMore = items.length >= lim;
            if (data.total !== undefined) {
                m._remoteHasMore = (page * lim) < data.total;
            }
        } else if (Array.isArray(data)) {
            items = data;
            m._remoteHasMore = false;
        }

        if (page === 1) {
            list.innerHTML = "";
        }
        // Retire l'indicateur « charger plus » de la page précédente (évite
        // l'accumulation de spinners pendant le chargement automatique du
        // filtre workflow).
        var prevMore = list.querySelector ? list.querySelector('.mb-load-more') : null;
        if (prevMore && prevMore.parentNode) prevMore.parentNode.removeChild(prevMore);

        // Filtre « modèles du workflow » : appliqué CÔTÉ CLIENT (le proxy serveur
        // ne connaît pas le workflow). m._remoteItems garde les items COMPLETS
        // (matching local + compteur « présente en distant ») ; la liste AFFICHÉE
        // ne montre que les correspondances.
        var wfIndex = getWorkflowIndex(m);

        // Stocker les items distants pour le matching local
        var globalOffset;
        if (page === 1) {
            m._remoteItems = items.slice();
            globalOffset = 0;
        } else {
            globalOffset = (m._remoteItems || []).length;
            m._remoteItems = (m._remoteItems || []).concat(items);
        }
        var displayItems = filterModelsByWorkflow(items, wfIndex);

        if (displayItems.length === 0 && page === 1 && !m._remoteHasMore) {
            list.innerHTML = '<div class="mb-empty">' + t(_emptyFilteredKey(m, 'mb.noRemote')) + '</div>';
            updateWorkflowSummary(m);
            updateBatchButtons(m);
            return;
        }

        // Ancrage Shift+Click propre à CE panneau (local ≠ distant).
        if (typeof m._lastCheckedRemote !== 'number') m._lastCheckedRemote = -1;

        displayItems.forEach(function (item, idx) {
            var globalIdx = globalOffset + idx;
            var div = document.createElement('div');
            div.className = 'mb-item';
            div.dataset.index = globalIdx;
            div._aihItem = item;

            // ── Checkbox + multi-sélection (clic, Ctrl/Cmd, Maj) ──
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'mb-checkbox';
            cb.addEventListener('click', function (e) {
                _selectionClick(e, div, list, m._remoteItems || [], m);
                e.stopPropagation();
            });
            div.appendChild(cb);

            // ── Clic sur la ligne → sélection (Ctrl/Cmd = toggle, Maj = plage) ──
            div.addEventListener('click', function (e) {
                if (e.target && e.target.closest && e.target.closest('input, button, select, textarea, a')) return;
                _selectionClick(e, div, list, m._remoteItems || [], m);
            });

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

            // ── Double-clic → download direct (délégué sur la liste) ──

            list.appendChild(div);
        });

        // Indicateur de chargement pour la page suivante
        if (m._remoteHasMore) {
            var loadMore = document.createElement('div');
            loadMore.className = 'mb-loading mb-load-more';
            loadMore.style.padding = '12px';
            loadMore.style.borderBottom = 'none';
            loadMore.innerHTML = '<span class="mb-loading-spinner"></span> ' + t('mb.scrollMore');
            list.appendChild(loadMore);
        }

        updateWorkflowSummary(m);
        updateBatchButtons(m);
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

        // Route locale /api/aih/* → HolafFetch SANS auth (same-origin transparente).
        HolafFetch.post('/api/aih/models/upload', {
            body: {
                path: filepath,
                type: fileType || 'model',
            },
            // Transfert LONG (modèle de plusieurs Go) : pas de plafond client de 30 s.
            timeout: 0,
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
    function downloadRemoteModel(m, uploadId, filename, fileType, destSubdir, sizeBytes) {
        if (!uploadId) {
            aihShowAlert(t('dialog.error'), t('mb.missingRemoteId'), "error");
            return;
        }

        // Fenêtre de progression dédiée (téléchargement unitaire).
        _dlWinAdd(uploadId, filename, sizeBytes);
        _dlWinStart(uploadId);

        var progressEl = showProgress(m, filename, { cancelable: true });

        // Progression live + bouton d'annulation (voir _downloadRequest).
        _downloadRequest({
            upload_id: uploadId,
            filename: filename,
            type: fileType || 'model',
            dest_path: destSubdir || '',
        }, progressEl)
            .then(function (data) {
                if (data.status === 'ok' || data.success) {
                    if (data.conflict) {
                        // Conflit détecté par le serveur : la ligne de fenêtre
                        // reste ouverte, la résolution (écraser/renommer/
                        // conserver) la réglera.
                        updateProgress(progressEl, 50, t('mb.conflictResolve'));
                        return handleDownloadConflict(m, uploadId, filename, fileType, destSubdir, data, progressEl);
                    }
                    updateProgress(progressEl, 100, t('mb.downloadDone'));
                    _dlWinSettle(uploadId, 'ok');
                    _dlWinDone();
                    m._remotePage = 1;
                    m._remoteHasMore = true;
                    loadLocalModels(m, true);
                    loadRemoteModels(m);
                } else if (data.cancelled) {
                    // Annulation utilisateur : message dédié, pas « ❌ Erreur ».
                    updateProgress(progressEl, 0, t('mb.downloadCancelled'));
                    _dlWinSettle(uploadId, 'cancelled');
                    _dlWinDone();
                } else {
                    var errMsg = data.error || data.message || t('aih.unknown');
                    updateProgress(progressEl, 0, t('mb.errorPrefix') + errMsg);
                    _dlWinSettle(uploadId, 'failed', errMsg);
                    _dlWinDone();
                }
            })
            .catch(function (err) {
                updateProgress(progressEl, 0, t('mb.errorPrefix') + err.message);
                _dlWinSettle(uploadId, 'failed', err.message);
                _dlWinDone();
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
                        // Conserver le fichier local = pas de téléchargement →
                        // ligne de fenêtre réglée en « annulé » (récap final).
                        _dlWinSettle(uploadId, 'cancelled');
                        _dlWinDone();
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
                    _dlWinSettle(uploadId, 'cancelled');
                    _dlWinDone();
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

        // Le transfert REDÉMARRE après résolution du conflit : la ligne de la
        // fenêtre repasse en « Préparation côté serveur… » avec un chrono neuf.
        _dlWinStart(uploadId);

        // Progression live + bouton d'annulation (voir _downloadRequest).
        _downloadRequest(body, progressEl)
            .then(function (data) {
                if (data.status === 'ok' || data.success) {
                    updateProgress(progressEl, 100, t('mb.downloadDone'));
                    _dlWinSettle(uploadId, 'ok');
                    _dlWinDone();
                    m._remotePage = 1;
                    m._remoteHasMore = true;
                    loadLocalModels(m, true);
                    loadRemoteModels(m);
                } else if (data.cancelled) {
                    // Annulation utilisateur : message dédié, pas « ❌ Erreur ».
                    updateProgress(progressEl, 0, t('mb.downloadCancelled'));
                    _dlWinSettle(uploadId, 'cancelled');
                    _dlWinDone();
                } else {
                    var errMsg = data.error || data.message || t('aih.unknown');
                    updateProgress(progressEl, 0, t('mb.errorPrefix') + errMsg);
                    _dlWinSettle(uploadId, 'failed', errMsg);
                    _dlWinDone();
                }
            })
            .catch(function (err) {
                updateProgress(progressEl, 0, t('mb.errorPrefix') + err.message);
                _dlWinSettle(uploadId, 'failed', err.message);
                _dlWinDone();
            });
    }

    // ─── showProgress / updateProgress ─────────────────────────────────────────
    function showProgress(m, filename, opts) {
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

        // Bouton d'annulation (downloads seulement) : posé masqué, activé par
        // _downloadRequest qui connaît l'upload_id.
        var cancelBtn = null;
        if (opts && opts.cancelable) {
            cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'mb-progress-cancel';
            cancelBtn.textContent = '\u2715';
            cancelBtn.title = t('mb.cancelDownload');
            cancelBtn.style.display = 'none';
            row.appendChild(cancelBtn);
        }

        container.appendChild(row);

        // Scroll en bas pour voir la progression
        container.scrollTop = container.scrollHeight;

        return {
            row: row,
            fill: fill,
            pctSpan: pctSpan,
            nameSpan: nameSpan,
            baseName: filename || t('mb.file'),
            cancelBtn: cancelBtn,
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

    // ─── Download : progression live + annulation ──────────────────────────────
    // Le serveur publie la progression dans /api/aih/models/download/progress
    // pendant TOUT le transfert (un modèle de 13,5 Go dure des dizaines de
    // minutes — sans polling l'UI semble figée). Un seul appel en vol à la
    // fois (jamais d'empilement), arrêt dès que la requête est réglée. Le
    // bouton ✕ pose une annulation coopérative côté serveur : le transfert
    // s'arrête, le fichier partiel est nettoyé.
    var DOWNLOAD_POLL_MS = 800;

    function _pollDownloadProgress(progressEl, uploadId) {
        if (!progressEl || !uploadId) return function () {};
        var stopped = false;
        var inFlight = false;
        var timer = setInterval(function () {
            if (stopped || inFlight) return;
            inFlight = true;
            var release = function () { inFlight = false; };
            // Route locale /api/aih/* → HolafFetch SANS auth (same-origin transparente).
            HolafFetch.get('/api/aih/models/download/progress?upload_id=' + encodeURIComponent(uploadId))
                .then(function (p) {
                    release();
                    if (stopped || !p || typeof p.percent !== 'number') return;
                    progressEl.fill.style.width = p.percent + '%';
                    progressEl.pctSpan.textContent = Math.round(p.percent) + '%';
                    if (!progressEl.baseName) return;
                    if (p.bytes_recv > 0 && p.speed_mbs > 0) {
                        progressEl.nameSpan.textContent = progressEl.baseName + ' · ' + p.speed_mbs + ' MB/s';
                    } else if (!p.bytes_recv) {
                        // Aucun octet encore reçu : le backend précharge le
                        // fichier du stockage vers son temp (peut durer des
                        // minutes sur 13,5 Go) — l'UI doit le DIRE au lieu de
                        // rester muette à 0 %.
                        progressEl.nameSpan.textContent = progressEl.baseName + ' · ' + t('mb.downloadPreparing');
                    }
                })
                .catch(release);
        }, DOWNLOAD_POLL_MS);
        return function stop() {
            stopped = true;
            clearInterval(timer);
        };
    }

    function _settleProgress(progressEl, cancelled) {
        if (!progressEl) return;
        if (progressEl.cancelBtn) progressEl.cancelBtn.style.display = 'none';
        if (cancelled) {
            updateProgress(progressEl, 0, t('mb.downloadCancelled'));
            progressEl.row.style.opacity = '0.6';
        }
    }

    function _downloadRequest(body, progressEl) {
        var stopPoll = _pollDownloadProgress(progressEl, body.upload_id);
        if (progressEl && progressEl.cancelBtn) {
            progressEl.cancelBtn.style.display = 'inline-block';
            progressEl.cancelBtn.onclick = function (e) {
                e.stopPropagation();
                progressEl.cancelBtn.disabled = true;
                progressEl.cancelBtn.textContent = '…';
                HolafFetch.post('/api/aih/models/download/cancel', {
                    body: { upload_id: body.upload_id },
                    timeout: 0,
                }).catch(function () {});
            };
        }
        // Route locale /api/aih/* → HolafFetch SANS auth (same-origin transparente).
        return HolafFetch.post('/api/aih/models/download', {
            body: body,
            // Téléchargement LONG (modèle de plusieurs Go) : pas de plafond client de 30 s.
            timeout: 0,
        })
            .then(function (data) {
                stopPoll();
                _settleProgress(progressEl, false);
                return data;
            })
            .catch(function (err) {
                stopPoll();
                // Annulation coopérative : le serveur répond 400 +
                // {cancelled: true} → message dédié, pas une « erreur » brute.
                if (err && err.data && err.data.cancelled) {
                    _settleProgress(progressEl, true);
                    return { success: false, cancelled: true, error: t('mb.downloadCancelled') };
                }
                throw err;
            });
    }

})();
