/**
 * AIH Download Window — fenêtre de progression DÉDIÉE des téléchargements de
 * modèles (Model Browser), bâtie sur AIH.Dialog (système de fenêtres unifié).
 *
 * Pourquoi : la progression « en ligne » du Model Browser (02_aih_model_browser.js
 * showProgress/_pollDownloadProgress) est peu visible — signalement utilisateur
 * « aucune fenêtre pour suivre la progression » — et n'affichait ni phase
 * explicite, ni ETA. Cette fenêtre s'ouvre AU LANCEMENT du téléchargement
 * (unitaire ET lot) et montre :
 *   - une ligne par fichier : nom, PHASE EXPLICITE (« En attente » /
 *     « Préparation côté serveur… » / « Transfert »), %, octets/total,
 *     débit MB/s (moyen), temps écoulé + ETA ;
 *   - un bouton ✕ par ligne → POST /api/aih/models/download/cancel (route
 *     d'annulation coopérative existante) ;
 *   - la progression GLOBALE N/M et une barre globale ;
 *   - un état final explicite : titre « Téléchargement terminé », récapitulatif
 *     chiffré (réussis · annulés · échecs) et bouton Fermer.
 *
 * La fermeture de la fenêtre N'ANNULE RIEN : les transferts continuent côté
 * serveur (les lignes en ligne du Model Browser restent la trace locale).
 * TANT QU'UN TRANSFERT EST ACTIF, le ✕ d'en-tête (ou Échap) est détourné vers
 * un MASQUAGE (display:none) : l'état, le polling et les compteurs survivent, et
 * le bouton « Transferts » du Model Browser (ou AIH.DownloadWindow.open())
 * rouvre la MÊME fenêtre. Sans transfert actif, le ✕ ferme réellement.
 *
 * Dépendances : js/aih_dialog.js (AIH.Dialog), vendor HolafFetch, clés i18n
 * « mb.dlw* » (aih_strings.js). API exposée :
 *   window.AIH.DownloadWindow.open()        ouvre ou rouvre (démasque)
 *   window.AIH.DownloadWindow.dismiss()     masque si actif, sinon ferme
 *   window.AIH.DownloadWindow.activeCount() transferts en cours + en attente
 *   window.AIH.DownloadWindow.isVisible()   fenêtre présente et non masquée
 *   window.AIH.DownloadWindow.isOpen()      fenêtre vivante (même masquée)
 *   window.AIH.DownloadWindow.onChange(cb)  abonnement au compteur (badge)
 */

import "./aih_dialog.js";
import { HolafFetch } from "./vendor/holaf/holaf-fetch.js";

(function () {
    "use strict";

    var AIH = (window.AIH = window.AIH || {});

    var t = function (key, params) {
        var I = window.AIH && window.AIH.I18n;
        return I && typeof I.t === "function" ? I.t(key, params) : key;
    };

    var WINDOW_ID = "aih-download-window";
    var POLL_MS = 800; // même cadence que la progression en ligne du Model Browser

    // Abonnés au NOMBRE de transferts en cours + en file d'attente (badge du
    // Model Browser). Module-level : survit à la (re)création de la fenêtre.
    var _changeListeners = [];
    function _notify(count) {
        count = Math.max(0, count | 0);
        for (var i = 0; i < _changeListeners.length; i++) {
            try { _changeListeners[i](count); } catch (e) { /* silencieux */ }
        }
    }

    // ─── Formatage ──────────────────────────────────────────────────────────
    function fmtBytes(bytes) {
        if (typeof bytes !== "number" || !isFinite(bytes) || bytes < 0) return "—";
        if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + " GB";
        if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
        if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " KB";
        return bytes + " B";
    }

    function fmtDuration(sec) {
        if (typeof sec !== "number" || !isFinite(sec) || sec < 0) return "--:--";
        sec = Math.round(sec);
        var h = Math.floor(sec / 3600);
        var m = Math.floor((sec % 3600) / 60);
        var s = sec % 60;
        var mm = (m < 10 ? "0" : "") + m;
        var ss = (s < 10 ? "0" : "") + s;
        return h > 0 ? h + ":" + mm + ":" + ss : mm + ":" + ss;
    }

    // ─── CSS (injecté une seule fois) ───────────────────────────────────────
    var _cssInjected = false;
    function _injectCSS() {
        if (_cssInjected) return;
        _cssInjected = true;
        var style = document.createElement("style");
        style.textContent = [
            ".aih-dlw-top { display: flex; align-items: center; gap: 10px; font-size: 12px; color: #bbb; margin-bottom: 6px; }",
            ".aih-dlw-count { font-family: monospace; font-weight: 600; color: #e2e8f0; }",
            ".aih-dlw-globalbar { height: 4px; background: rgba(255,255,255,0.08); border-radius: 2px; overflow: hidden; }",
            ".aih-dlw-globalfill { height: 100%; width: 0%; background: var(--aih-accent, #D8700D); transition: width 0.3s ease; }",
            ".aih-dlw-rows { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; max-height: 52vh; overflow-y: auto; }",
            ".aih-dlw-empty { margin-top: 12px; padding: 14px; text-align: center; color: #888; font-size: 12px; border: 1px dashed #444; border-radius: 6px; }",
            ".aih-dlw-row { padding: 7px 9px; border-radius: 6px; background: #2a2a2e; display: flex; flex-direction: column; gap: 4px; }",
            ".aih-dlw-row.is-ok { background: rgba(22,163,74,0.15); }",
            ".aih-dlw-row.is-cancelled { background: rgba(107,114,128,0.18); opacity: 0.85; }",
            ".aih-dlw-row.is-failed { background: rgba(220,38,38,0.15); }",
            ".aih-dlw-line1 { display: flex; align-items: center; gap: 8px; }",
            ".aih-dlw-name { flex: 1; min-width: 0; font-size: 12px; color: #ddd; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
            ".aih-dlw-phase { flex-shrink: 0; font-size: 10px; color: #9ca3af; white-space: nowrap; }",
            ".aih-dlw-row.is-transfer .aih-dlw-phase { color: #fbbf24; }",
            ".aih-dlw-cancel { flex-shrink: 0; width: 20px; height: 20px; line-height: 1; padding: 0; border: 1px solid #555; border-radius: 4px; background: transparent; color: #aaa; font-size: 11px; cursor: pointer; }",
            ".aih-dlw-cancel:hover { color: #f87171; border-color: #f87171; }",
            ".aih-dlw-cancel:disabled { opacity: 0.5; cursor: default; }",
            ".aih-dlw-line2 { display: flex; align-items: center; gap: 8px; font-size: 10px; color: #888; font-family: monospace; }",
            ".aih-dlw-bar { flex: 1; min-width: 60px; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; }",
            ".aih-dlw-fill { height: 100%; width: 0%; background: var(--aih-accent, #D8700D); border-radius: 3px; transition: width 0.3s ease; }",
            ".aih-dlw-pct { min-width: 34px; text-align: right; color: #ddd; }",
            ".aih-dlw-bytes { min-width: 96px; text-align: right; }",
            ".aih-dlw-speed { min-width: 62px; text-align: right; }",
            ".aih-dlw-time { min-width: 96px; text-align: right; }",
            ".aih-dlw-msg { font-size: 10px; color: #f87171; word-break: break-all; display: none; }",
            ".aih-dlw-msg.is-visible { display: block; }",
            ".aih-dlw-final { display: none; margin-top: 10px; padding-top: 10px; border-top: 1px solid #333; }",
            ".aih-dlw-final.is-visible { display: block; }",
            ".aih-dlw-final-text { font-size: 12px; margin-bottom: 8px; }",
            ".aih-dlw-final.is-ok .aih-dlw-final-text { color: #34d399; }",
            ".aih-dlw-final.is-warn .aih-dlw-final-text { color: #fbbf24; }",
            ".aih-dlw-final.is-fail .aih-dlw-final-text { color: #f87171; }",
            ".aih-dlw-close { padding: 6px 16px; border: 1px solid #555; border-radius: 6px; background: transparent; color: #ccc; font-size: 12px; cursor: pointer; }",
            ".aih-dlw-close:hover { border-color: var(--aih-accent, #D8700D); color: #fff; }",
        ].join("\n");
        (document.head || document.documentElement).appendChild(style);
    }

    // ─── Construction de la fenêtre ─────────────────────────────────────────
    function _buildRow(name, sizeBytes) {
        var root = document.createElement("div");
        root.className = "aih-dlw-row";

        var line1 = document.createElement("div");
        line1.className = "aih-dlw-line1";
        var nameEl = document.createElement("span");
        nameEl.className = "aih-dlw-name";
        nameEl.textContent = name || t("mb.file");
        nameEl.title = name || "";
        var phaseEl = document.createElement("span");
        phaseEl.className = "aih-dlw-phase";
        phaseEl.textContent = t("mb.dlwQueued");
        var cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "aih-dlw-cancel";
        cancelBtn.textContent = "\u2715";
        cancelBtn.title = t("mb.cancelDownload");
        line1.appendChild(nameEl);
        line1.appendChild(phaseEl);
        line1.appendChild(cancelBtn);
        root.appendChild(line1);

        var line2 = document.createElement("div");
        line2.className = "aih-dlw-line2";
        var bar = document.createElement("div");
        bar.className = "aih-dlw-bar";
        var fill = document.createElement("div");
        fill.className = "aih-dlw-fill";
        bar.appendChild(fill);
        var pctEl = document.createElement("span");
        pctEl.className = "aih-dlw-pct";
        pctEl.textContent = "0%";
        var bytesEl = document.createElement("span");
        bytesEl.className = "aih-dlw-bytes";
        bytesEl.textContent = (sizeBytes > 0 ? "0 B / " + fmtBytes(sizeBytes) : "0 B");
        var speedEl = document.createElement("span");
        speedEl.className = "aih-dlw-speed";
        speedEl.textContent = "\u2014 MB/s";
        var timeEl = document.createElement("span");
        timeEl.className = "aih-dlw-time";
        timeEl.textContent = "--:--";
        line2.appendChild(bar);
        line2.appendChild(pctEl);
        line2.appendChild(bytesEl);
        line2.appendChild(speedEl);
        line2.appendChild(timeEl);
        root.appendChild(line2);

        var msgEl = document.createElement("div");
        msgEl.className = "aih-dlw-msg";
        root.appendChild(msgEl);
        return {
            root: root, nameEl: nameEl, phaseEl: phaseEl, cancelBtn: cancelBtn,
            fill: fill, pctEl: pctEl, bytesEl: bytesEl, speedEl: speedEl,
            timeEl: timeEl, msgEl: msgEl,
        };
    }

    function _createWindow() {
        var D = AIH.Dialog;
        if (!D || typeof D.open !== "function") return null;

        _injectCSS();

        var state = {
            rows: {},            // upload_id → handle
            order: [],
            total: 0,
            finished: 0,
            ok: 0,
            cancelled: 0,
            failed: 0,
            done: false,
            closed: false,
            masked: false,       // fenêtre masquée (transferts encore actifs)
            dlg: null,
        };
        var _escHandler = null;

        var els = {};
        var root = document.createElement("div");
        root.className = "aih-dlw-root";

        els.top = document.createElement("div");
        els.top.className = "aih-dlw-top";
        els.count = document.createElement("span");
        els.count.className = "aih-dlw-count";
        els.top.appendChild(els.count);
        root.appendChild(els.top);

        els.globalBar = document.createElement("div");
        els.globalBar.className = "aih-dlw-globalbar";
        els.globalFill = document.createElement("div");
        els.globalFill.className = "aih-dlw-globalfill";
        els.globalBar.appendChild(els.globalFill);
        root.appendChild(els.globalBar);

        els.rows = document.createElement("div");
        els.rows.className = "aih-dlw-rows";
        root.appendChild(els.rows);

        els.empty = document.createElement("div");
        els.empty.className = "aih-dlw-empty";
        els.empty.textContent = t("mb.dlwEmpty");
        root.appendChild(els.empty);

        els.final = document.createElement("div");
        els.final.className = "aih-dlw-final";
        els.finalText = document.createElement("div");
        els.finalText.className = "aih-dlw-final-text";
        els.closeBtn = document.createElement("button");
        els.closeBtn.type = "button";
        els.closeBtn.className = "aih-dlw-close";
        els.closeBtn.textContent = t("dialog.close");
        els.closeBtn.style.display = "none";
        els.closeBtn.onclick = function () { state.dlg.close(); };
        els.final.appendChild(els.finalText);
        els.final.appendChild(els.closeBtn);
        root.appendChild(els.final);

        // Anti-résidu : un élément du même id laissé par une session précédente
        // ferait renvoyer l'ancien contrôleur par AIH.Dialog (anti-doublon).
        var stale = document.getElementById(WINDOW_ID);
        if (stale) stale.remove();

        state.dlg = D.open({
            id: WINDOW_ID,
            title: t("mb.dlwTitle"),
            width: "640px",
            height: "auto",
            minWidth: "440px",
            minHeight: "220px",
            maxHeight: "75vh",
            resizable: true,
            draggable: true,
            content: root,
            // Escape n'est PAS délégué au noyau : tant qu'un transfert est
            // actif, fermer doit MASQUER (le suivi ne doit pas être perdu).
            closeOnEscape: false,
            onClose: _onDialogClosed,
        });

        _installDismissHandlers();

        // ── Helpers d'état ──────────────────────────────────────────────────
        function _updateGlobal() {
            els.count.textContent = t("mb.dlwGlobal", {
                done: state.finished, total: state.total,
            });
            var pct = state.total > 0 ? Math.round((state.finished * 100) / state.total) : 0;
            els.globalFill.style.width = pct + "%";
            if (els.empty) {
                els.empty.style.display = (state.total === 0 && !state.done) ? "" : "none";
            }
            // Badge permanent du Model Browser : nombre de transferts en
            // cours + en file d'attente (jamais les lignes réglées).
            _notify(state.total - state.finished);
        }

        // ── Fermeture / masquage ────────────────────────────────────────────
        // Tant qu'il reste une ligne NON réglée, le ✕ (en-tête, Escape) MASQUE
        // la fenêtre au lieu de la détruire : la progression continue d'être
        // suivie et le bouton « Transferts » la rouvre. Sans transfert actif,
        // le ✕ ferme réellement (comportement historique).
        function _hasActive() {
            return state.total > state.finished;
        }

        function hide() {
            if (state.closed || state.masked) return;
            state.masked = true;
            if (state.dlg && state.dlg.el) state.dlg.el.style.display = "none";
            _notify(state.total - state.finished);
        }

        function show() {
            if (state.closed) return;
            if (state.masked) {
                state.masked = false;
                if (state.dlg && state.dlg.el) state.dlg.el.style.display = "";
            }
            if (state.dlg && typeof state.dlg.bringToFront === "function") {
                try { state.dlg.bringToFront(); } catch (e) { /* silencieux */ }
            }
        }

        function dismiss() {
            if (_hasActive()) hide();
            else close();
        }

        function _onDialogClosed() {
            state.closed = true;
            state.masked = false;
            stopAllPolls();
            if (_escHandler) {
                document.removeEventListener("keydown", _escHandler, true);
                _escHandler = null;
            }
            _notify(0);
        }

        function _installDismissHandlers() {
            var el = state.dlg && state.dlg.el;
            if (!el) return;
            // Le noyau câble son propre ✕ sur .aih-dialog-close : on remplace le
            // bouton (clone = écouteurs retirés) pour rediriger vers dismiss().
            var closeIcon = el.querySelector(".aih-dialog-close");
            if (closeIcon && closeIcon.parentNode) {
                var replacement = closeIcon.cloneNode(true);
                closeIcon.parentNode.replaceChild(replacement, closeIcon);
                replacement.addEventListener("click", function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    dismiss();
                });
            }
            // Escape : capture pour intercepter avant tout autre gestionnaire.
            _escHandler = function (e) {
                if (state.closed || e.key !== "Escape") return;
                if (state.masked) return; // déjà masquée : laisser passer
                if (!el || el.style.display === "none") return;
                e.preventDefault();
                e.stopPropagation();
                dismiss();
            };
            document.addEventListener("keydown", _escHandler, true);
        }

        function _setPhase(h, phase) {
            if (h.settled && phase !== "settled") return;
            h.phase = phase;
            h.root.classList.toggle("is-transfer", phase === "transferring");
            if (phase === "queued") h.els.phaseEl.textContent = t("mb.dlwQueued");
            else if (phase === "preparing") h.els.phaseEl.textContent = t("mb.dlwPhasePreparing");
            else if (phase === "transferring") h.els.phaseEl.textContent = t("mb.dlwPhaseTransferring");
        }

        function _applyProgress(h, p) {
            if (!h || h.settled || state.closed) return;
            var recv = p && typeof p.bytes_recv === "number" ? p.bytes_recv : 0;
            var total = p && typeof p.bytes_total === "number" && p.bytes_total > 0
                ? p.bytes_total : h.sizeBytes;
            var pct = p && typeof p.percent === "number"
                ? p.percent
                : (total > 0 ? (recv * 100) / total : 0);
            var serverPhase = p && p.phase;
            if (recv > 0 || serverPhase === "transferring") _setPhase(h, "transferring");
            else _setPhase(h, "preparing");

            pct = Math.max(0, Math.min(100, pct));
            h.fillWidth = pct;
            h.els.fill.style.width = pct + "%";
            h.els.pctEl.textContent = Math.round(pct) + "%";
            h.els.bytesEl.textContent = total > 0
                ? fmtBytes(recv) + " / " + fmtBytes(total)
                : fmtBytes(recv);

            // Débit MOYEN (recv / temps écoulé depuis le lancement de la ligne)
            // et ETA — stables, contrairement à la vitesse instantanée serveur.
            var elapsed = h.startedAt ? (Date.now() - h.startedAt) / 1000 : 0;
            var avg = elapsed > 0.5 ? (recv / 1048576) / elapsed : 0;
            h.els.speedEl.textContent = avg > 0
                ? avg.toFixed(1) + " MB/s"
                : "\u2014 MB/s";
            var timeText = fmtDuration(elapsed);
            if (avg > 0 && total > recv) {
                var eta = (total - recv) / 1048576 / avg;
                timeText += " · " + t("mb.dlwEta", { eta: fmtDuration(eta) });
            }
            h.els.timeEl.textContent = timeText;
        }

        function _startPoll(h) {
            if (h.timer || !h.uploadId || state.closed) return;
            var inFlight = false;
            h.timer = setInterval(function () {
                if (h.settled || state.closed || inFlight) return;
                inFlight = true;
                var release = function () { inFlight = false; };
                HolafFetch.get("/api/aih/models/download/progress?upload_id="
                    + encodeURIComponent(h.uploadId))
                    .then(function (p) { release(); _applyProgress(h, p); })
                    .catch(release);
            }, POLL_MS);
        }

        function _stopPoll(h) {
            if (h.timer) { clearInterval(h.timer); h.timer = null; }
        }

        function stopAllPolls() {
            state.order.forEach(function (h) { _stopPoll(h); });
        }

        function _resetSession() {
            stopAllPolls();
            state.rows = {};
            state.order = [];
            state.total = 0;
            state.finished = 0;
            state.ok = 0;
            state.cancelled = 0;
            state.failed = 0;
            state.done = false;
            els.rows.textContent = "";
            els.final.className = "aih-dlw-final";
            els.finalText.textContent = "";
            els.closeBtn.style.display = "none";
            state.dlg.setTitle(t("mb.dlwTitle"));
            _updateGlobal();
        }

        // ── Contrat public ──────────────────────────────────────────────────
        function addFile(name, opts) {
            opts = opts || {};
            if (state.done) _resetSession();
            var uploadId = opts.uploadId || null;
            // Réessai (conflit résolu) : la ligne existe déjà → la réutiliser.
            if (uploadId && state.rows[uploadId]) return state.rows[uploadId];

            state.total++;
            var rowEls = _buildRow(name, opts.sizeBytes || 0);
            els.rows.appendChild(rowEls.root);
            var h = {
                uploadId: uploadId,
                name: name,
                sizeBytes: opts.sizeBytes || 0,
                els: rowEls,
                root: rowEls.root,
                startedAt: null,
                timer: null,
                settled: false,
                phase: "queued",
                fillWidth: 0,
            };
            rowEls.cancelBtn.onclick = (function (handle) {
                return function (e) {
                    e.stopPropagation();
                    if (!handle.uploadId || handle.settled) return;
                    handle.els.cancelBtn.disabled = true;
                    handle.els.cancelBtn.textContent = "\u2026";
                    HolafFetch.post("/api/aih/models/download/cancel", {
                        body: { upload_id: handle.uploadId },
                        // POST bref : pas de plafond client (même politique que
                        // les transferts — l'annulation doit passer).
                        timeout: 0,
                    }).catch(function () {});
                };
            })(h);
            if (uploadId) state.rows[uploadId] = h;
            state.order.push(h);
            _updateGlobal();
            return h;
        }

        function startFile(uploadId) {
            var h = state.rows[uploadId];
            if (!h || h.settled) return;
            h.startedAt = Date.now();
            _setPhase(h, "preparing");
            _startPoll(h);
        }

        function setResult(uploadId, kind, message) {
            var h = state.rows[uploadId];
            if (!h || h.settled) return;
            h.settled = true;
            _stopPoll(h);
            h.els.cancelBtn.style.display = "none";
            state.finished++;
            h.root.classList.remove("is-transfer");
            if (kind === "ok") {
                state.ok++;
                h.root.classList.add("is-ok");
                h.els.phaseEl.textContent = t("mb.downloadDone");
                h.els.fill.style.width = "100%";
                h.els.pctEl.textContent = "100%";
            } else if (kind === "cancelled") {
                state.cancelled++;
                h.root.classList.add("is-cancelled");
                h.els.phaseEl.textContent = t("mb.downloadCancelled");
            } else {
                state.failed++;
                h.root.classList.add("is-failed");
                h.els.phaseEl.textContent = t("mb.errorPrefix");
                if (message) {
                    h.els.msgEl.textContent = message;
                    h.els.msgEl.classList.add("is-visible");
                }
            }
            _updateGlobal();
        }

        function stats() {
            return {
                total: state.total, finished: state.finished,
                ok: state.ok, cancelled: state.cancelled, failed: state.failed,
            };
        }

        function done() {
            stopAllPolls();
            if (state.done) return stats();
            state.done = true;
            state.dlg.setTitle(t("mb.dlwDoneTitle"));
            els.final.className = "aih-dlw-final is-visible"
                + (state.failed > 0 ? " is-fail" : (state.cancelled > 0 ? " is-warn" : " is-ok"));
            els.finalText.textContent = "\u2705 " + t("mb.dlwDoneTitle") + " \u2014 "
                + t("mb.dlwRecap", {
                    ok: state.ok, cancelled: state.cancelled, failed: state.failed,
                });
            els.closeBtn.style.display = "inline-block";
            _updateGlobal();
            return stats();
        }

        function close() {
            stopAllPolls();
            state.dlg.close(); // onClose (_onDialogClosed) finalise l'état.
        }

        return {
            addFile: addFile,
            startFile: startFile,
            setResult: setResult,
            done: done,
            stats: stats,
            close: close,
            hide: hide,
            show: show,
            dismiss: dismiss,
            isOpen: function () { return !state.closed; },
            isVisible: function () { return !state.closed && !state.masked; },
            pending: function () { return Math.max(0, state.total - state.finished); },
            hasActive: _hasActive,
            el: state.dlg.el,
        };
    }

    // ─── Singleton : une seule fenêtre, réutilisée d'un download à l'autre ──
    // La fenêtre SURVIT à un masquage (transferts actifs) : `open()` la
    // redonne visible. Elle n'est réellement détruite que sur un ✕/Escape sans
    // transfert en cours ou via le bouton « Fermer » de l'état final.
    var current = null;

    function open() {
        if (current && current.isOpen()) {
            current.show();
            return current;
        }
        current = _createWindow();
        return current;
    }

    function activeCount() {
        return current && current.isOpen() ? current.pending() : 0;
    }

    function isVisible() {
        return !!(current && current.isOpen() && current.isVisible());
    }

    function isOpen() {
        return !!(current && current.isOpen());
    }

    AIH.DownloadWindow = {
        open: open,
        // Masque la fenêtre si des transferts sont actifs, sinon la ferme.
        dismiss: function () {
            if (current && current.isOpen()) current.dismiss();
        },
        hide: function () {
            if (current && current.isOpen()) current.hide();
        },
        activeCount: activeCount,
        isVisible: isVisible,
        isOpen: isOpen,
        // Abonnement au compteur (badge). Renvoie une fonction de désabonnement.
        onChange: function (cb) {
            if (typeof cb !== "function") return function () {};
            _changeListeners.push(cb);
            try { cb(activeCount()); } catch (e) { /* silencieux */ }
            return function () {
                var i = _changeListeners.indexOf(cb);
                if (i >= 0) _changeListeners.splice(i, 1);
            };
        },
    };
})();
