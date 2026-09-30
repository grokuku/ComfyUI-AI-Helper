import "./aih_dialog.js";
import "./aih_strings.js";
import { makeDraggable } from "./holaf_window_utils.js";
import { showToast as bridgeShowToast, updateToast as bridgeUpdateToast, hideToast as bridgeHideToast } from "./aih_toast_bridge.js";
import { remoteGet, remotePost, remoteDelete, HolafFetch, normalizeServerUrl } from "./aih_fetch_bridge.js";

/**
 * AIH Workflow Manager — Modale unique avec 2 onglets.
 *
 * Onglet 1 : 📤 Partager — upload du workflow actif + dépendances auto-détectées
 * Onglet 2 : 🌐 Parcourir — liste paginée des workflows publics + installation
 *
 * Utilise aihOpenModalV2 (01_aih_modal_v2.js) pour les fenêtres flottantes.
 */

(function () {
  "use strict";

  // ── Helper i18n central : traduit via AIH.I18n (clé brute si absente) ──
  const t = (key, params) => {
    const I = window.AIH && window.AIH.I18n;
    return I && typeof I.t === "function" ? I.t(key, params) : key;
  };

  // ── Version du module — VÉRIFIABLE par l'utilisateur ─────────────────────
  // Le pack est servi par ComfyUI sous /extensions/<dossier>/... sans
  // cache-busting : un navigateur a pu exécuter un aih_workflow_share.js
  // PÉRIMÉ après la mise à jour du pack (cause prouvée des correctifs
  // « livrés » qui semblaient inactifs). Cette constante :
  //   - est loguée au chargement du module ;
  //   - est exposée sur window.AIH_WF_SHARE (DevTools : taper AIH_WF_SHARE) ;
  //   - est affichée dans la fenêtre Workflows (bandeau bas) ;
  //   - est comparée au fichier RÉELLEMENT servi (fetch cache: no-store) pour
  //     afficher un bandeau rouge « version obsolète — Ctrl+Shift+R ».
  // ⚠️ Incrémenter à CHAQUE livraison de ce fichier.
  var AIH_WF_SHARE_BUILD = "wf-share-2026-09-30-r5";

  var AIH_WF_SHARE_BUILD_RX = /AIH_WF_SHARE_BUILD\s*=\s*["']([^"']+)["']/;

  function buildFromSource(text) {
    var m = AIH_WF_SHARE_BUILD_RX.exec(String(text == null ? "" : text));
    return m ? m[1] : "";
  }

  // Vérifie que le fichier SERVI est bien cette version (et non une copie en
  // cache). Résultat mémoïsé pour la session : null (vérification impossible),
  // false (obsolète) ou true (à jour). ``urlOverride`` n'est utilisé que par
  // les tests (pour forcer une nouvelle sonde sur une URL http simulée).
  var _servedBuildProbe = null;
  function checkServedBuildFreshness(urlOverride) {
    if (_servedBuildProbe && !urlOverride) return _servedBuildProbe;
    var run = (async function () {
      try {
        var importUrl = (typeof import.meta !== "undefined" && import.meta && import.meta.url) ? import.meta.url : "";
        var url = urlOverride || importUrl;
        if (!/^https?:/i.test(url)) return null; // file:// (tests) ou contexte sans URL
        var sep = url.indexOf("?") >= 0 ? "&" : "?";
        var res = await fetch(url + sep + "aih_build_probe=" + Date.now(), { cache: "no-store" });
        if (!res || !res.ok) return null;
        var served = buildFromSource(await res.text());
        var stale = served !== AIH_WF_SHARE_BUILD;
        if (window.AIH_WF_SHARE) {
          window.AIH_WF_SHARE.servedBuild = served;
          window.AIH_WF_SHARE.stale = stale;
        }
        if (stale) {
          console.error("[AIH] Workflow Share OBSOLÈTE — exécuté " + AIH_WF_SHARE_BUILD
            + ", servi " + (served || "(sans marqueur)") + " — Ctrl+Shift+R requis. " + url);
        }
        return stale;
      } catch (e) {
        return null;
      }
    })();
    if (urlOverride || !_servedBuildProbe) _servedBuildProbe = run;
    return run;
  }

  if (typeof window !== "undefined") {
    window.AIH_WF_SHARE = {
      build: AIH_WF_SHARE_BUILD,
      url: (typeof import.meta !== "undefined" && import.meta && import.meta.url) ? import.meta.url : "",
      stale: null,
      servedBuild: null,
      check: checkServedBuildFreshness,
    };
  }
  try {
    console.log("[AIH] Workflow Share build " + AIH_WF_SHARE_BUILD
      + " — " + (window.AIH_WF_SHARE ? window.AIH_WF_SHARE.url : ""));
  } catch (e) { /* console indisponible : jamais bloquant */ }

  // ── Helpers ──

  function getApp() {
    return window.app || window.comfyAPI?.app?.app;
  }

  function getApiUrl() {
    // Aucune URL par défaut codée en dur : chaîne vide si le serveur n'est
    // pas configuré (les points d'entrée vérifient via ensureServerConfigured).
    try {
      var cfg = JSON.parse(localStorage.getItem("AIH_config") || "{}");
      var base = normalizeServerUrl(cfg.serverUrl);
      return base ? base + "/api" : "";
    } catch { return ""; }
  }

  // Comportement dégradé : sans URL serveur configurée, on invite à la
  // renseigner au lieu de déboucher sur des erreurs réseau confuses.
  function ensureServerConfigured() {
    if (getApiUrl()) return true;
    if (window.aihShowAlert) {
      window.aihShowAlert(t("aih.notConfiguredTitle"), t("aih.notConfiguredMsg"), "info");
    }
    return false;
  }

  function esc(str) {
    if (typeof str !== "string") return "";
    var d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function formatSize(bytes) {
    var b = Number(bytes) || 0;
    if (b >= 1073741824) return (b / 1073741824).toFixed(2) + " GB";
    return (b / 1048576).toFixed(1) + " MB";
  }

  // ── Normalisation d'identité d'un dépôt git (custom nodes) ──
  // Bug réel (capture) : un pack DÉJÀ INSTALLÉ était quand même réinstallé et
  // l'installation échouait (« Node '…' already installed »), parce que la
  // détection comparait l'URL git par ÉGALITÉ DE CHAÎNE EXACTE. Or le même
  // dépôt s'écrit différemment selon la source : dossier installé par
  // ComfyUI-Manager (.git/config), aux_id du workflow (owner/repo), alias de
  // nom (ComfyUI-AI-Helper vs AI-Helper)…
  //   https://github.com/Owner/Repo.git ≡ git@github.com:owner/repo ≡
  //   http://www.github.com/Owner/Repo/ ≡ ssh://git@github.com/owner/repo.git
  // → normaliseRepoUrl() réduit à « host/path » (minuscules, sans « www. »,
  //   sans « .git », sans slash final, sans port). normalizeRepoName() réduit
  //   à un identifiant de pack (dernier segment, préfixe « comfyui[-_] »
  //   retiré, alphanumérique).
  function normalizeRepoUrl(raw) {
    var s = String(raw == null ? "" : raw).trim().toLowerCase();
    if (!s) return "";
    s = s.replace(/\.git$/, "").replace(/\/+$/, "");
    // Forme scp-like : git@host:owner/repo
    var scp = s.match(/^[^@/]+@([^:/]+):(.+)$/);
    if (scp) return scp[1].replace(/^www\./, "") + "/" + scp[2].replace(/^\/+|\/+$/g, "");
    // Forme avec schéma : proto://[user@]host[:port]/owner/repo
    var m = s.match(/^[a-z][a-z0-9+.\-]*:\/\/(?:[^@/]+@)?([^/]+?)(?::\d+)?\/(.+)$/);
    if (m) return m[1].replace(/^www\./, "") + "/" + m[2].replace(/^\/+|\/+$/g, "");
    // Forme nue : owner/repo
    return s.replace(/^\/+|\/+$/g, "");
  }

  function normalizeRepoName(raw) {
    var s = String(raw == null ? "" : raw).trim().toLowerCase();
    if (!s) return "";
    s = s.replace(/\.git$/, "").replace(/\/+$/, "");
    s = s.split("/").pop() || s;
    s = s.replace(/^comfyui[-_]/, "");
    return s.replace(/[^a-z0-9]/g, "");
  }

  // ── Check d'existence serveur AVANT upload ──
  // Appel UNIQUE et par lot de la route locale /api/aih/models/check (le pack
  // Python calcule les empreintes des fichiers — le navigateur n'a pas accès au
  // filesystem ComfyUI — et interroge le backend AIH). Retourne la sélection
  // enrichie de `status` ('identical'|'different'|'absent'|'unknown') et
  // `remote` ; `null` si la vérification est impossible (serveur non configuré,
  // route absente…) → on retombe sur le comportement historique.
  async function checkServerPresence(selection) {
    try {
      var data = await HolafFetch.request('/api/aih/models/check', {
        method: 'POST',
        body: {
          items: selection.map(function (s) { return { path: s.path, type: s.type }; }),
        },
      });
      if (!data || data.ok !== true || !Array.isArray(data.items)) return null;
      var byPath = {};
      for (var i = 0; i < data.items.length; i++) {
        var r = data.items[i];
        if (r && r.path) byPath[r.path] = r;
      }
      for (var j = 0; j < selection.length; j++) {
        var hit = byPath[selection[j].path];
        if (hit && (hit.status === 'identical' || hit.status === 'different' || hit.status === 'absent')) {
          selection[j].status = hit.status;
          selection[j].remote = hit.remote || null;
        }
      }
      return selection;
    } catch (e) {
      console.warn('[AIH] Server presence check failed: ' + (e && e.message ? e.message : e));
      return null;
    }
  }

  // ── Modale de pré-upload : modèles déjà présents à écraser ──
  // Déclenchée AVANT l'envoi, uniquement quand au moins un modèle de la
  // sélection existe déjà côté serveur. Défauts intelligents : « absent » =
  // envoyé (case cochée, verrouillée) ; « identique » / « différent » = NON
  // coché par défaut (on ne renvoie pas 13 Go pour rien) mais décochable/…
  // cocher = écrasement explicite (drapeau `overwrite` de l'upload).
  // Résolution : {action:'confirm', overwrite:[clés]} ou {action:'cancel'}.
  function showPreUploadModal(items) {
    var D = window.AIH && window.AIH.Dialog;
    if (!D || typeof D.open !== "function") {
      // Fenêtres unifiées absentes : pas de friction ajoutée, comportement
      // historique conservé (l'absence d'écrasement reste visible au résultat).
      return Promise.resolve({ action: "confirm", overwrite: [] });
    }
    return new Promise(function (resolve) {
      var byKey = {};
      var rowsHtml = "";
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        byKey[it.key] = it;
        var existing = it.status === "identical" || it.status === "different";
        var sameSize = !!(it.remote && Number(it.remote.size) === Number(it.size));
        var stateKey = it.status === "identical" ? "wf.preUploadStateIdentical"
          : it.status === "different"
            ? (sameSize ? "wf.preUploadStateDifferentHash" : "wf.preUploadStateDifferentSize")
            : "wf.preUploadStateAbsent";
        var stateColor = it.status === "identical" ? "#34d399"
          : it.status === "different" ? "#f59e0b" : "#888";
        var remoteMeta = it.remote
          ? " · " + t("wf.preUploadRemote", { size: formatSize(it.remote.size) })
            + (it.remote.created_at ? " · " + t("wf.preUploadRemoteDate", { date: it.remote.created_at }) : "")
          : "";
        rowsHtml +=
          '<label data-key="' + esc(it.key) + '" style="display:flex;flex-direction:column;gap:3px;padding:6px 8px;border:1px solid ' +
            (it.status === "different" ? "rgba(245,158,11,0.55)" : "#444") +
            ';border-radius:6px;margin-bottom:4px;background:#2a2a2e;cursor:pointer;">' +
            '<span style="display:flex;align-items:center;gap:6px;">' +
              '<input type="checkbox" class="wf-pre-cb" data-key="' + esc(it.key) + '" data-existing="' + (existing ? "1" : "0") + '"' +
                (existing ? "" : " checked disabled") +
                ' style="accent-color:var(--aih-accent, #D8700D);">' +
              '<span style="flex:1;font-size:12px;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(it.name) + '">' + esc(it.name) + '</span>' +
              (existing ? '<span style="font-size:10px;color:var(--aih-accent, #D8700D);">' + t("wf.preUploadOverwrite") + '</span>' : '') +
              '<span style="font-size:10px;color:' + stateColor + ';white-space:nowrap;">' + t(stateKey) + '</span>' +
            '</span>' +
            '<span style="font-size:10px;color:#888;margin-left:22px;">' +
              esc(t("wf.preUploadLocal", { size: formatSize(it.size) })) + esc(remoteMeta) +
            '</span>' +
          '</label>';
      }

      var content =
        '<div style="display:flex;flex-direction:column;gap:8px;">' +
          '<p style="font-size:12px;color:#aaa;margin:0;">' + t("wf.preUploadIntro") + '</p>' +
          '<div id="wf-pre-list" style="max-height:46vh;overflow-y:auto;">' + rowsHtml + '</div>' +
          '<div style="display:flex;gap:8px;">' +
            '<button id="wf-pre-all" class="aih-dialog-btn" style="flex:1;">' + t("wf.preUploadOverwriteAll") + '</button>' +
            '<button id="wf-pre-none" class="aih-dialog-btn" style="flex:1;">' + t("wf.preUploadIgnoreExisting") + '</button>' +
          '</div>' +
          '<div id="wf-pre-volume" style="font-size:11px;color:#fbbf24;"></div>' +
          '<div style="display:flex;justify-content:flex-end;gap:8px;border-top:1px solid #444;padding-top:8px;">' +
            '<button id="wf-pre-cancel" class="aih-dialog-btn aih-dialog-btn-cancel">' + t("dialog.cancel") + '</button>' +
            '<button id="wf-pre-send" class="aih-dialog-btn aih-dialog-btn-primary"></button>' +
          '</div>' +
        '</div>';

      var ctrl = D.open({
        title: t("wf.preUploadTitle"),
        width: "620px",
        height: "auto",
        maxHeight: "80vh",
        minWidth: "420px",
        modal: true,
        resizable: false,
        content: content,
        _onResolve: function (value) {
          resolve(value || { action: "cancel", overwrite: [] });
        },
      });
      var root = ctrl.el || ctrl.modal;
      var cbs = root.querySelectorAll(".wf-pre-cb");

      function updateSummary() {
        var count = 0, bytes = 0, overwrite = [];
        for (var i = 0; i < cbs.length; i++) {
          var cb = cbs[i];
          if (!cb.checked) continue;
          var it = byKey[cb.getAttribute("data-key")];
          count++;
          bytes += Number(it && it.size) || 0;
          if (cb.getAttribute("data-existing") === "1") overwrite.push(it.key);
        }
        root.querySelector("#wf-pre-volume").textContent =
          t("wf.preUploadVolume", { size: formatSize(bytes) });
        root.querySelector("#wf-pre-send").textContent =
          t("wf.preUploadSend", { count: count });
        return { count: count, overwrite: overwrite };
      }

      for (var ci = 0; ci < cbs.length; ci++) {
        cbs[ci].addEventListener("change", updateSummary);
      }
      root.querySelector("#wf-pre-all").onclick = function () {
        for (var i = 0; i < cbs.length; i++) cbs[i].checked = true;
        updateSummary();
      };
      root.querySelector("#wf-pre-none").onclick = function () {
        for (var i = 0; i < cbs.length; i++) {
          if (cbs[i].getAttribute("data-existing") === "1") cbs[i].checked = false;
        }
        updateSummary();
      };
      root.querySelector("#wf-pre-cancel").onclick = function () {
        ctrl.close({ action: "cancel", overwrite: [] });
      };
      root.querySelector("#wf-pre-send").onclick = function () {
        var summary = updateSummary();
        ctrl.close({ action: "confirm", overwrite: summary.overwrite });
      };
      updateSummary();
    });
  }

  // ── Upload progress panel ──

  function createUploadPanel() {
    var m = aihOpenModalV2({
      title: t("wf.uploadTitle"),
      width: "440px",
      height: "auto",
      maxHeight: "70vh",
      minHeight: "200px",
      storageKey: "aih-modal-upload",
      persistSize: true,
      persistPos: true,
      content: '<div id="aih-upload-body" style="display:flex;flex-direction:column;gap:8px;padding:0;"></div>',
    });
    var body = m.modal.querySelector("#aih-upload-body");

    var rows = {};
    var doneCount = 0, totalCount = 0;
    var startTime = Date.now();
    var counts = { sent: 0, overwritten: 0, skipped: 0, failed: 0 };

    return {
      addRow: function(fileName, sizeBytes, filepath) {
        totalCount++;
        var sizeMB = (sizeBytes / 1048576).toFixed(1);
        var row = document.createElement("div");
        row.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:6px 8px;border-radius:6px;background:#2a2a2e;";
        // Progress bar (determinee)
        var bar = document.createElement("div");
        bar.style.cssText = "flex:1;height:6px;background:rgba(255,255,255,0.1);border-radius:3px;overflow:hidden;";
        var fill = document.createElement("div");
        fill.style.cssText = "height:100%;width:0%;background:var(--aih-accent, #D8700D);border-radius:3px;transition:width 0.5s ease;";
        bar.appendChild(fill);
        // Name
        var nameEl = document.createElement("span");
        nameEl.style.cssText = "font-size:12px;color:#ccc;min-width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;";
        nameEl.textContent = fileName;
        nameEl.title = fileName;
        // Speed — JAMAIS de valeur inventée : la seule source autorisée est la
        // mesure RÉELLE du serveur (/upload/progress) ou la moyenne d'un
        // transfert réellement effectué ; sinon « — » (un fichier SAUTÉ ne
        // consomme aucun octet : bug « 0.2 s / 140 391 MB/s »).
        var speedEl = document.createElement("span");
        speedEl.style.cssText = "font-size:10px;color:#888;min-width:55px;text-align:right;font-family:monospace;";
        speedEl.textContent = "—";
        // Size
        var sizeEl = document.createElement("span");
        sizeEl.style.cssText = "font-size:11px;color:#888;min-width:55px;text-align:right;";
        sizeEl.textContent = sizeMB + " MB";
        // Status icon
        var statusEl = document.createElement("span");
        statusEl.style.cssText = "font-size:14px;min-width:20px;text-align:center;";
        statusEl.textContent = "⏳";
        row.appendChild(statusEl);
        row.appendChild(nameEl);
        row.appendChild(bar);
        row.appendChild(speedEl);
        row.appendChild(sizeEl);
        body.appendChild(row);

        // Polling de progression toutes les 500ms (débit RÉEL mesuré côté
        // serveur) — aucune estimation locale taille/durée en vol.
        var state = { row: row, fill: fill, status: statusEl, startTime: Date.now(), speedEl: speedEl, sizeBytes: sizeBytes, pollInterval: null, finalizingNote: null };
        rows[fileName] = state;
        if (filepath) {
          state.pollInterval = setInterval(function() {
            HolafFetch.request('/api/aih/models/upload/progress?path=' + encodeURIComponent(filepath))
              .then(function(p) {
                if (!p || typeof p.percent !== 'number') return;
                state.fill.style.width = p.percent + '%';
                if (p.phase === 'finalizing') {
                  // Tous les octets sont arrivés : le serveur recopie le fichier
                  // complet vers son stockage (étape longue pour un 13 Go, sans
                  // progression fine). On l'affiche au lieu de laisser une barre
                  // figée muette — sinon l'utilisateur croit à un blocage.
                  if (!state.finalizingNote) {
                    var noteEl = document.createElement("div");
                    noteEl.style.cssText = "font-size:10px;color:#9ca3af;width:100%;margin-left:26px;";
                    noteEl.textContent = t("wf.uploadFinalizing");
                    state.row.appendChild(noteEl);
                    state.finalizingNote = noteEl;
                  }
                  return;
                }
                if (p.speed_mbs > 0) {
                  state.speedEl.textContent = p.speed_mbs + ' MB/s';
                }
              })
              .catch(function(){});
          }, 500);
        }
      },
      // status : 'sent' | 'overwritten' | 'skipped' | 'failed' (booléens
      // historiques acceptés : true = 'sent', false = 'failed').
      setResult: function(fileName, status, errorMsg) {
        var r = rows[fileName];
        if (!r) return;
        if (status === true) status = "sent";
        if (status === false) status = "failed";
        if (r.pollInterval) { clearInterval(r.pollInterval); r.pollInterval = null; }
        if (r.finalizingNote) { r.finalizingNote.remove(); r.finalizingNote = null; }
        doneCount++;
        if (status === "sent" || status === "overwritten") {
          // Débit moyen d'un transfert RÉELLEMENT effectué (le fichier a été
          // envoyé) — seule moyenne légitime.
          var elapsed = (Date.now() - r.startTime) / 1000;
          r.speedEl.textContent = elapsed > 0
            ? (r.sizeBytes / 1048576 / elapsed).toFixed(1) + " MB/s"
            : "—";
          r.status.textContent = status === "overwritten" ? "♻️" : "✅";
          r.fill.style.background = status === "overwritten" ? "#f59e0b" : "#16a34a";
          r.fill.style.width = "100%";
          r.row.style.background = status === "overwritten"
            ? "rgba(245,158,11,0.15)" : "rgba(22,163,74,0.15)";
          counts[status]++;
        } else if (status === "skipped") {
          // Fichier DÉJÀ présent : ni ✅ de transfert, ni débit.
          r.speedEl.textContent = "—";
          r.status.textContent = "⏭";
          r.fill.style.background = "#6b7280";
          r.fill.style.width = "100%";
          r.row.style.background = "rgba(107,114,128,0.18)";
          var noteEl = document.createElement("div");
          noteEl.style.cssText = "font-size:10px;color:#9ca3af;width:100%;margin-left:26px;";
          noteEl.textContent = t("wf.preUploadSkippedNoBytes");
          r.row.appendChild(noteEl);
          counts.skipped++;
        } else {
          // Transfert ÉCHOUÉ : « taille / durée » n'a AUCUN sens (un 13 Go qui
          // échoue au bout de 30 s afficherait 449 Mo/s). On n'invente pas de
          // débit : le détail de l'erreur est affiché sous la ligne.
          r.speedEl.textContent = "—";
          r.status.textContent = "❌";
          r.fill.style.background = "#dc2626";
          r.fill.style.width = "100%";
          r.row.style.background = "rgba(220,38,38,0.15)";
          var errEl = document.createElement("div");
          errEl.style.cssText = "font-size:10px;color:#f87171;word-break:break-all;width:100%;margin-left:26px;";
          errEl.textContent = t("wf.errorPrefix") + (errorMsg || t("aih.unknown"));
          r.row.appendChild(errEl);
          counts.failed++;
        }
        m.setTitle(t("wf.uploadProgress", { done: doneCount, total: totalCount }));
      },
      done: function() {
        var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        // Récapitulatif RÉEL : envoyés / écrasés / ignorés / échecs (fini le
        // « N fichiers » indifférencié qui comptait des skips comme succès).
        m.setTitle(t("wf.uploadDone", {
          seconds: elapsed,
          sent: t("wf.uploadCountSent", { count: counts.sent }),
          overwritten: t("wf.uploadCountOverwritten", { count: counts.overwritten }),
          skipped: t("wf.uploadCountSkipped", { count: counts.skipped }),
          failed: t("wf.uploadCountFailed", { count: counts.failed }),
        }));
        var closeBtn = document.createElement("button");
        closeBtn.textContent = t("dialog.close");
        closeBtn.style.cssText = "padding:6px 16px;border:1px solid #555;border-radius:6px;background:transparent;color:#999;font-size:12px;cursor:pointer;";
        closeBtn.onclick = function() { m.close(); };
        closeBtn.onmouseenter = function() { closeBtn.style.background = "#3a3a3e"; closeBtn.style.color = "#fff"; };
        closeBtn.onmouseleave = function() { closeBtn.style.background = "transparent"; closeBtn.style.color = "#999"; };
        // Append close button inline at the bottom of body
        var footerDiv = document.createElement("div");
        footerDiv.style.cssText = "display:flex;justify-content:flex-end;padding-top:8px;border-top:1px solid #333;margin-top:4px;";
        footerDiv.appendChild(closeBtn);
        body.appendChild(footerDiv);
      }
    };
  }

  // ── Toast / progress ──
  // Délègue à la brique HolafToast via aih_toast_bridge.js (self-contained,
  // auto-injecte son CSS). La progression native de la brique (option
  // `progress: 'manual'` de show + `progress` de update) couvre le flux
  // progress des toasts "progress". aihToast renvoie l'id (string) du toast.
  // NB : plus d'échappement manuel — la brique utilise textContent par défaut.

  function aihToast(message, type) {
    // type: "info" | "success" | "error" | "progress"
    if (type === "progress") {
      // Toast persistant avec barre de progression (mis à jour via aihToastProgress)
      return bridgeShowToast({ message: message, type: "info", duration: 0, progress: "manual" });
    }
    var t = type === "success" ? "success" : type === "error" ? "error" : "info";
    return bridgeShowToast({ message: message, type: t, duration: 4000 });
  }

  function aihToastProgress(id, percent, message) {
    var opts = { progress: Math.max(0, Math.min(100, Math.round(percent))) };
    if (message) opts.message = message;
    bridgeUpdateToast(id, opts);
  }

  function aihToastDone(id, type, message) {
    var t = type === "success" ? "success" : "error";
    bridgeUpdateToast(id, { type: t, message: message });
    // Garder les toasts 8s pour avoir le temps de lire
    setTimeout(function() { bridgeHideToast(id); }, 8000);
  }

  // ── Types ComfyUI natifs ──
  // La distinction custom/natif se fait via /aih/custom-nodes :
  // on recupere les types declares par chaque pack custom_nodes, et
  // seuls les nodes du workflow qui matchent ces types sont des dependances.

  // Map complet des loaders -> {widgetIndex, category}
  // Couvre tous les loaders ComfyUI natifs + communautaires
  var MODEL_LOADERS = {
    // Checkpoints
    "CheckpointLoaderSimple":  { idx: 0, cat: "checkpoint" },
    "CheckpointLoader":        { idx: 0, cat: "checkpoint" },
    "unCLIPCheckpointLoader":  { idx: 0, cat: "checkpoint" },
    "CannyCheckpointLoader":   { idx: 0, cat: "checkpoint" },
    "CheckpointLoader|pysssss":{ idx: 0, cat: "checkpoint" },
    "EasyLoadCheckpoint":      { idx: 0, cat: "checkpoint" },
    "CheckpointLoaderSimple|bg2": { idx: 0, cat: "checkpoint" },
    // LoRAs
    "LoraLoader":              { idx: 0, cat: "lora" },
    "LoraLoaderModelOnly":     { idx: 0, cat: "lora" },
    "EasyLoraLoader":          { idx: 0, cat: "lora" },
    "LoraLoader|pysssss":      { idx: 0, cat: "lora" },
    // VAE
    "VAELoader":               { idx: 0, cat: "vae" },
    "VAELoaderFile":           { idx: 0, cat: "vae" },
    "EasyVAELoader":           { idx: 0, cat: "vae" },
    // CLIP
    "CLIPLoader":              { idx: 0, cat: "clip" },
    "DualCLIPLoader":          { idx: 0, cat: "clip" },
    "CLIPVisionLoader":        { idx: 0, cat: "clip_vision" },
    "CLIPLoaderGGUF":          { idx: 0, cat: "clip" },
    // UNET / Diffusion models
    "UNETLoader":              { idx: 0, cat: "unet" },
    "UnetLoaderGGUF":          { idx: 0, cat: "unet_gguf" },
    "DiffModelLoader":         { idx: 0, cat: "unet" },
    "EasyFullyLoader":         { idx: 0, cat: "unet" },
    // ControlNet
    "ControlNetLoader":        { idx: 0, cat: "controlnet" },
    "ControlNetLoaderAdvanced":{ idx: 0, cat: "controlnet" },
    "EasyControlnetLoader":    { idx: 0, cat: "controlnet" },
    // Upscale
    "UpscaleModelLoader":      { idx: 0, cat: "upscale" },
    "ImageUpscaleWithModel":   { idx: 0, cat: "upscale" },
    // Holaf/AIH upscale node: canonical post-rename key + legacy pre-rename
    // alias (Python registers BOTH so old workflows keep loading).
    "AIHUpscale":              { idx: 0, cat: "upscale" },
    "UpscaleImageHolaf":      { idx: 0, cat: "upscale" },
    // GLIGEN
    "GLIGENLoader":            { idx: 0, cat: "gligen" },
    // Hypernetwork
    "HypernetworkLoader":      { idx: 0, cat: "hypernetwork" },
    // Text encoders (SD3, Flux, etc.)
    "TextEncoderLoader":       { idx: 0, cat: "text_encoder" },
    "BERTLoader":              { idx: 0, cat: "text_encoder" },
    "T5Loader":                { idx: 0, cat: "text_encoder" },
    "CLIPLoaderModelOnly":     { idx: 0, cat: "text_encoder" },
    // Style models
    "StyleModelLoader":        { idx: 0, cat: "style_model" },
    // Embeddings
    "PromptStyleLoader":       { idx: 0, cat: "embedding" },
  };

  // Extensions de fichiers models connus
  var MODEL_EXTENSIONS = [".safetensors", ".ckpt", ".pt", ".pth", ".gguf", ".bin", ".t5", ".fp16", ".fp8", ".bf16"];

  // ── Custom nodes : detection des URLs git (via endpoint ComfyUI) ──

  async function getInstalledCustomNodes(strict) {
    try {
      var data = await HolafFetch.request('/api/aih/custom-nodes');
      if (!data.nodes || data.nodes.length === 0) {
        console.warn('[AIH] /aih/custom-nodes OK mais 0 packs trouves — verifier _CUSTOM_NODES_DIR et _extract_node_types');
      } else {
        console.log('[AIH] /aih/custom-nodes: ' + data.nodes.length + ' packs, ' + data.nodes.map(function(n){return n.name + "("+(n.node_types||[]).length+")";}).join(', '));
      }
      return data.nodes || [];
    } catch(e) {
      console.warn('[AIH] /aih/custom-nodes HTTP ' + (e.status||'') + (e.body ? ' ' + (typeof e.body === 'string' ? e.body : '') : '') + ' — route non enregistree ou erreur serveur');
      // strict : l'appelant VEUT distinguer « 0 pack » d'un échec réseau et
      // pourra réessayer — sans quoi un index vide figé ferait réinstaller des
      // packs pourtant présents.
      if (strict) throw e;
      return [];
    }
  }

  // Index des packs déjà installés, comparable malgré les alias/renommages.
  // Multi-signaux indexés :
  //   - urls  : URL git normalisée (« host/owner/repo ») ;
  //   - names : nom de dossier local normalisé + slug de l'URL normalisé ;
  //   - types : noms de classes de nodes fournis par le pack installé.
  // La valeur stockée est le libellé lisible du pack (nom de dossier) pour
  // pouvoir AFFICHER la raison du match dans l'UI.
  //
  // ⚠️ Le nom de dossier est un signal de PREMIÈRE CLASSE : un pack installé
  // SANS remote git (copie manuelle, gestionnaire sans `.git`) n'a AUCUNE URL
  // dans l'index ; il n'est reconnu que par son nom de dossier (et ses
  // classes). Sans ce signal, l'outil retente une installation déjà présente.
  function buildInstalledNodeIndex(list) {
    var urls = {};
    var names = {};
    var types = {};
    for (var i = 0; i < (list || []).length; i++) {
      var p = list[i] || {};
      var folder = String(p.name || "").trim();
      var label = folder || normalizeRepoUrl(p.git_url) || "";
      var u = normalizeRepoUrl(p.git_url);
      if (u) urls[u] = label || u;
      var n = normalizeRepoName(p.name);
      if (n) names[n] = label || n;
      var un = normalizeRepoName(p.git_url);
      if (un) names[un] = label || un;
      var nt = p.node_types || [];
      for (var ti = 0; ti < nt.length; ti++) {
        var tname = nt[ti];
        if (typeof tname === "string" && tname && !types[tname]) types[tname] = label || folder;
      }
    }
    return { urls: urls, names: names, types: types };
  }

  // Retourne null si non installé, sinon la RAISON du match
  // { reason: 'url' | 'folder' | 'types', detail, type? }. Du plus fort au plus
  // faible : URL normalisée identique (alias .git/casse/git@/https/www/port),
  // nom de dossier local normalisé (préfixe comfyui[-_], séparateurs), puis nom
  // de classe de node fourni par le workflow et présent dans le pack installé
  // (les classes ComfyUI sont globalement uniques : si la classe existe, le
  // workflow fonctionnera). Aucun faux positif souhaité sur un dépôt différent.
  function matchInstalledNode(idx, name, url, nodeTypes) {
    if (!idx) return null;
    var u = normalizeRepoUrl(url);
    if (u && idx.urls && idx.urls[u]) return { reason: "url", detail: idx.urls[u] };
    var n = normalizeRepoName(name);
    if (n && idx.names && idx.names[n]) return { reason: "folder", detail: idx.names[n] };
    var un = normalizeRepoName(url);
    if (un && idx.names && idx.names[un]) return { reason: "folder", detail: idx.names[un] };
    if (idx.types && nodeTypes && nodeTypes.length) {
      for (var i = 0; i < nodeTypes.length; i++) {
        var tname = nodeTypes[i];
        if (typeof tname === "string" && tname && idx.types[tname]) {
          return { reason: "types", detail: idx.types[tname], type: tname };
        }
      }
    }
    return null;
  }

  function nodeMatchesInstalledIndex(idx, name, url, nodeTypes) {
    return !!matchInstalledNode(idx, name, url, nodeTypes);
  }

  // Libellé lisible de la raison d'un match « déjà installé ».
  function installedMatchReason(match) {
    if (!match) return "";
    if (match.reason === "url") return t("wf.matchReasonUrl", { url: match.detail });
    if (match.reason === "types") return t("wf.matchReasonNode", { name: match.type });
    return t("wf.matchReasonFolder", { name: match.detail });
  }

  // Marque la ligne d'un node comme « déjà installé » dans l'UI (case décochée
  // + badge avec la raison + astuce de forçage). Idempotent : jamais deux
  // badges. Utilisé par le filet de sécurité « already installed ».
  function markNodeInstalled(cb, reasonText) {
    if (!cb) return;
    cb.checked = false;
    cb.dataset.installed = "1";
    cb.title = t("wf.forceInstallHint");
    var label = cb.closest ? cb.closest("label") : null;
    if (!label) return;
    var span = label.querySelector("span");
    if (!span || /déjà installé|already installed/i.test(span.textContent)) return;
    var reason = reasonText || t("wf.matchReasonServer");
    span.innerHTML += ' <span style="color:#34d399;">' + t("wf.alreadyInstalledMatch", { reason: reason }) + '</span>';
  }

  // Message d'erreur d'installation LISIBLE : le serveur pack renvoie
  // {success:false, message:"Node 'X' already installed"} en 400 ; HolafFetch
  // attache ce corps à err.data (et err.body pour un corps NON-JSON). On
  // préfère data.message/data.error/data.detail au « erreur serveur (statut
  // 400) » générique de la brique, puis le corps brut texte (serveur/proxy
  // qui répond du texte), pour un message TOUJOURS exploitable.
  function installErrorMessage(e) {
    if (!e) return t("aih.failed");
    var d = e.data || e.body;
    if (d && typeof d === "object") {
      if (typeof d.message === "string" && d.message) return d.message;
      if (typeof d.error === "string" && d.error) return d.error;
      if (typeof d.detail === "string" && d.detail) return d.detail;
    }
    // Corps brut (réponse non-JSON : proxy, erreur aiohttp, page…) : la brique
    // laisse e.body en texte — on le préfère lui aussi au message générique.
    if (typeof e.body === "string" && e.body.trim()) return e.body.trim().slice(0, 300);
    return e.message || t("aih.failed");
  }

  // Filet de sécurité « already installed » : le serveur pack répond
  // {success:false, message:"Node 'X' already installed"} en 400 quand le
  // dossier existe DÉJÀ côté ComfyUI. Ce n'est PAS un échec : on classe ce cas
  // en skip bénin (ligne « déjà installé », aucune erreur affichée), quel que
  // soit l'état de la détection côté front.
  function isAlreadyInstalledMessage(msg) {
    return /already installed/i.test(String(msg == null ? "" : msg));
  }

  async function detectDependencies(workflowJSON) {
    // Collecter TOUS les nodes, y compris ceux dans les subgraphs (recursif)
    function _collectAllNodes(wf) {
      var allNodes = (wf?.nodes || []).slice();
      var subgraphs = wf?.definitions?.subgraphs || [];
      for (var sgi = 0; sgi < subgraphs.length; sgi++) {
        allNodes = allNodes.concat(_collectAllNodes(subgraphs[sgi]));
      }
      return allNodes;
    }
    var nodes = _collectAllNodes(workflowJSON);
    var deps = { nodes: [], models: [], loras: [] };
    var seen = { nodes: {}, models: {}, loras: {} };

    // Recuperer les fichiers locaux pour determiner le vrai dossier de chaque model
    var localModelFiles = await getLocalModelFiles();
    var localFileToCat = {};  // filename → category (ex: "upscale_models")
    var localFileByName = {};  // filename → {name, path, size}
    for (var cat in localModelFiles) {
      for (var fi = 0; fi < localModelFiles[cat].length; fi++) {
        var lf = localModelFiles[cat][fi];
        localFileToCat[lf.name] = cat;
        localFileByName[lf.name] = lf;
      }
    }

    // Recuperer les packs installes pour trouver le git URL via .git/config
    var installedPacks = await getInstalledCustomNodes();
    var installedByName = {};
    for (var pi = 0; pi < installedPacks.length; pi++) {
      installedByName[installedPacks[pi].name] = installedPacks[pi];
    }

    // Helper recursif : scanne les widgets values (y compris subgraphs)
    function _scanWidgetValue(wv, nodeType) {
      if (typeof wv === "string" && wv.length > 3) {
        var lower = wv.toLowerCase();
        for (var ei = 0; ei < MODEL_EXTENSIONS.length; ei++) {
          if (lower.endsWith(MODEL_EXTENSIONS[ei]) && !seen.models[wv] && !seen.loras[wv]) {
            var ntLower = nodeType.toLowerCase();
            if (ntLower.indexOf("lora") >= 0) {
              seen.loras[wv] = true;
              deps.loras.push({ name: wv, type: "lora" });
            } else {
              // Determiner le type depuis le dossier local du fichier
              var realCat = localFileToCat[wv];
              // Mapper le dossier ComfyUI vers un type court
              var catToType = {
                "checkpoints": "checkpoint", "loras": "lora", "vae": "vae",
                "clip": "clip", "clip_vision": "clip_vision", "controlnet": "controlnet",
                "unet": "unet", "unet_gguf": "unet_gguf", "upscale_models": "upscale",
                "gligen": "gligen", "hypernetworks": "hypernetwork",
                "text_encoders": "text_encoder", "style_models": "style_model",
                "embeddings": "embedding", "configs": "config",
                "diffusion_models": "unet", "bbxe/models": "model",
              };
              var modelType = (realCat && catToType[realCat]) ? catToType[realCat] : "model";
              seen.models[wv] = true;
              deps.models.push({ name: wv, type: modelType, size: localFileByName[wv] ? localFileByName[wv].size : 0 });
            }
            break;
          }
        }
      } else if (Array.isArray(wv)) {
        for (var si = 0; si < wv.length; si++) {
          _scanWidgetValue(wv[si], nodeType);
        }
      }
    }

    // Detecter les packs custom via properties.aux_id / properties.cnr_id du JSON
    var packMap = {};  // packId -> {name, url, node_types: []}
    for (var i = 0; i < nodes.length; i++) {
      var type = nodes[i].type || "";
      var widgets = nodes[i].widgets_values || [];
      var props = nodes[i].properties || {};
      var auxId = props.aux_id || "";
      var cnrId = props.cnr_id || "";

      // Determiner le pack : aux_id (owner/repo) ou cnr_id (registry ID)
      var packId = auxId || cnrId || "";
      if (!packId || packId === "comfy-core") {
        // Node natif — skip la detection de pack mais continue les models
      } else {
        // Extraire le nom du pack (derniere partie apres /)
        var packName = packId.indexOf("/") >= 0 ? packId.split("/").pop() : packId;
        var packKey = packId;  // cle unique = ID complet
        if (!packMap[packKey]) {
          // Chercher le git URL dans les packs installes
          var gitUrl = "";
          var installed = installedByName[packName];
          if (installed && installed.git_url) {
            gitUrl = installed.git_url;
          } else if (auxId.indexOf("/") >= 0) {
            // Construire l'URL GitHub depuis aux_id (owner/repo)
            gitUrl = "https://github.com/" + auxId;
          }
          packMap[packKey] = { name: packName, url: gitUrl, node_types: [] };
        }
        if (type && type.indexOf("-") < 0 && packMap[packKey].node_types.indexOf(type) < 0) {
          packMap[packKey].node_types.push(type);
        }
      }

      // Models / LoRAs via les loaders connus
      var loader = MODEL_LOADERS[type];
      if (loader) {
        var filename = widgets[loader.idx];
        if (filename && typeof filename === "string" && filename !== "None" && filename !== "none") {
          if (loader.cat === "lora") {
            if (!seen.loras[filename]) {
              seen.loras[filename] = true;
              deps.loras.push({ name: filename, type: "lora" });
            }
          } else {
            if (!seen.models[filename]) {
              seen.models[filename] = true;
              deps.models.push({ name: filename, type: loader.cat, size: localFileByName[filename] ? localFileByName[filename].size : 0 });
            }
          }
        }
        for (var wi = 0; wi < widgets.length; wi++) {
          if (wi === loader.idx) continue;
          _scanWidgetValue(widgets[wi], type);
        }
      } else {
        for (var wi = 0; wi < widgets.length; wi++) {
          _scanWidgetValue(widgets[wi], type);
        }
      }
    }

    deps.nodes = Object.keys(packMap).map(function(k) { return packMap[k]; });

    return deps;
  }

  // ── Fingerprint (deduplication upload) ──

  async function computeFileFingerprint(file) {
    try {
      var headSize = Math.min(1024 * 1024, file.size);
      var head = await file.slice(0, headSize).arrayBuffer();
      var tail = await file.slice(file.size - headSize).arrayBuffer();
      var headHash = await crypto.subtle.digest('SHA-256', head);
      var tailHash = await crypto.subtle.digest('SHA-256', tail);
      function toHex(buf) {
        return Array.from(new Uint8Array(buf)).map(function(b) {
          return b.toString(16).padStart(2, '0');
        }).join('');
      }
      return { size: file.size, head: toHex(headHash), tail: toHex(tailHash) };
    } catch (e) {
      console.warn('[AIH] Fingerprint failed:', e);
      return null;
    }
  }

  // ── Local model detection (avoid unnecessary downloads) ──

  async function getLocalModelFiles() {
    // Interroge l'endpoint Python /aih/models/list qui retourne les chemins + tailles
    try {
      var data = await HolafFetch.request('/api/aih/models/list');
      var total = 0;
      for (var cat in data) { total += data[cat].length; }
      if (total === 0) {
        console.warn('[AIH] /aih/models/list OK mais 0 fichiers trouves — verifier folder_paths et MODEL_EXTENSIONS');
      } else {
        console.log('[AIH] /aih/models/list: ' + total + ' fichiers dans ' + Object.keys(data).length + ' categories');
      }
      return data;
    } catch(e) {
      console.warn('[AIH] /aih/models/list HTTP ' + (e.status||'') + (e.body ? ' ' + (typeof e.body === 'string' ? e.body : '') : '') + ' — route non enregistree ou erreur serveur');
      return {};
    }
  }

  // ── Résolution de secours d'une référence serveur PAR NOM DE FICHIER ──
  // Un workflow publié AVANT le correctif d'upload (gros unet/clip coupés par
  // les anciens timeouts 30/60 s) peut lister une dépendance SANS upload_id
  // alors que le fichier est bien présent côté serveur (upload ultérieur,
  // autre workflow…). On interroge la liste distante via la route LOCALE du
  // pack (/api/aih/models/remote, proxy authentifié) et on ne retient qu'une
  // correspondance EXACTE : nom identique, type compatible, et — si les deux
  // tailles sont connues — taille identique (jamais un homonyme d'un autre
  // contenu). Retourne {upload_id, size} ou null. Jamais bloquant.
  function remoteTypeCompatible(jsType, remoteType) {
    var a = String(jsType == null ? "" : jsType).toLowerCase();
    var b = String(remoteType == null ? "" : remoteType).toLowerCase();
    if (!a || !b) return true;
    if (a === b) return true;
    // Le backend peut stocker un unet sous « diffusion_model » (table
    // diffusion_models côté ComfyUI, type_to_cat et _ALL_MODEL_CATEGORIES du
    // pack) alors que le workflow détecte « unet » : sans cette équivalence,
    // la résolution par nom échouait et le fichier était déclaré NON
    // téléchargeable alors qu'il était bien sur le serveur.
    var equiv = { model: "checkpoint", checkpoint: "model", unet: "diffusion_model", diffusion_model: "unet" };
    return equiv[a] === b || equiv[b] === a;
  }

  async function resolveRemoteUploadId(entry) {
    var name = String((entry && entry.name) || "").trim();
    if (!name) return null;
    var base = name.split("/").pop();
    var wantType = (entry && entry.type) || "";
    var wantSize = Number(entry && entry.size) || 0;
    try {
      var data = await HolafFetch.request(
        "/api/aih/models/remote?search=" + encodeURIComponent(base) + "&limit=50&sort=created_at&order=desc",
        // Borné : si le serveur AIH ne répond pas en 8 s, on rend la main
        // (jamais une liste de dépendances figée par un réseau lent).
        { timeout: 8000 }
      );
      var items = (data && data.items) || [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i] || {};
        var fname = String(it.filename == null ? "" : it.filename).trim();
        if (!fname) continue;
        var fbase = fname.split("/").pop() || "";
        if (fname.toLowerCase() !== name.toLowerCase() &&
            fbase.toLowerCase() !== base.toLowerCase()) continue;
        if (!remoteTypeCompatible(wantType, it.type)) continue;
        var itSize = Number(it.size) || 0;
        if (wantSize > 0 && itSize > 0 && itSize !== wantSize) continue;
        if (!it.upload_id) continue;
        return { upload_id: it.upload_id, size: itSize };
      }
      return null;
    } catch (e) {
      console.warn("[AIH] Résolution upload_id par nom impossible: " + name, e);
      return null;
    }
  }

  async function uploadModelToServer(filepath, fileType, overwrite) {
    // Demande au Python d'uploader le fichier directement depuis le filesystem
    try {
      var body = { path: filepath, type: fileType };
      // Écrasement EXPLICITE décidé dans la modale de pré-upload : le pack
      // Python saute alors la déduplication → les octets sont réellement
      // renvoyés (coché = vraiment remplacé).
      if (overwrite) body.overwrite = true;
      return await HolafFetch.request('/api/aih/models/upload', {
        method: 'POST',
        body: body,
        // TRANSFERT LONG : un modèle de plusieurs Go prend plusieurs minutes.
        // Le timeout client par défaut (30 s, holaf-fetch.js) ABORDAIT le
        // transfert en plein vol → « Erreur: timeout » dès ~450 Mo (tout
        // fichier dont l'envoi dépasse 30 s). `timeout: 0` = aucun plafond
        // client ; la progression réelle est suivie par le polling
        // /upload/progress et le serveur borne chaque opération.
        timeout: 0,
      });
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async function downloadModelFromServer(uploadId, filename, fileType, destPath) {
    // Demande au Python de downloader et sauvegarder dans le bon dossier
    try {
      var body = { upload_id: uploadId, filename: filename, type: fileType };
      if (destPath) body.dest_path = destPath;
      // Téléchargement de modèle (plusieurs Go) : même plafond client de 30 s
      // à désactiver que pour l'upload.
      return await HolafFetch.request('/api/aih/models/download', {
        method: 'POST', body: body, timeout: 0,
      });
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async function getLocalModels() {
    try {
      var resp = await fetch('/object_info/CheckpointLoaderSimple');
      if (!resp.ok) return [];
      var data = await resp.json();
      var info = data.CheckpointLoaderSimple;
      if (info && info.inputs && info.inputs.required && info.inputs.required.ckpt_name) {
        return info.inputs.required.ckpt_name[0] || [];
      }
      return [];
    } catch { return []; }
  }

  async function getLocalLoras() {
    try {
      var resp = await fetch('/object_info/LoraLoader');
      if (!resp.ok) return [];
      var data = await resp.json();
      var info = data.LoraLoader;
      if (info && info.inputs && info.inputs.required && info.inputs.required.lora_name) {
        return info.inputs.required.lora_name[0] || [];
      }
      return [];
    } catch { return []; }
  }

  // ── Modale unique ──

  window.openWorkflowManager = function () {
    if (!ensureServerConfigured()) return;
    if (!document.getElementById('aih-spin-style')) {
      var spinStyle = document.createElement('style');
      spinStyle.id = 'aih-spin-style';
      spinStyle.textContent = '@keyframes aih-spin { to { transform: rotate(360deg); } }';
      document.head.appendChild(spinStyle);
    }
    var _m = aihOpenModalV2({
        title: t("wf.title"),
        width: "680px",
        height: "auto",
        minWidth: "480px",
        minHeight: "400px",
        storageKey: "aih-modal-workflows",
        persistSize: true,
        persistPos: true
    });
    var modal = _m.modal;
    var body = _m.body;

    var currentTab = "share";
    var browseState = { page: 1, query: "", sort: "downloads" };

    function updateTabStyles() {
      var shareBtn = body.querySelector("#wf-tab-share");
      var browseBtn = body.querySelector("#wf-tab-browse");
      if (shareBtn) {
        shareBtn.style.borderBottomColor = currentTab === "share" ? "var(--aih-accent, #D8700D)" : "transparent";
        shareBtn.style.color = currentTab === "share" ? "#e2e8f0" : "#888";
        shareBtn.style.fontWeight = currentTab === "share" ? "600" : "400";
      }
      if (browseBtn) {
        browseBtn.style.borderBottomColor = currentTab === "browse" ? "var(--aih-accent, #D8700D)" : "transparent";
        browseBtn.style.color = currentTab === "browse" ? "#e2e8f0" : "#888";
        browseBtn.style.fontWeight = currentTab === "browse" ? "600" : "400";
      }
    }

    function render() {
      body.innerHTML =
        '<div style="display:flex;flex-direction:column;gap:10px;min-height:350px;">' +
        // Bandeau « version obsolète » : rempli seulement si la sonde de
        // fraîcheur détecte un fichier servi différent de cette build.
        '<div id="wf-stale-banner" style="display:none;font-size:11px;color:#f87171;background:rgba(220,38,38,0.12);border:1px solid #7f1d1d;border-radius:6px;padding:6px 8px;"></div>' +
        // Tab bar
        '<div style="display:flex;gap:0;border-bottom:1px solid #444;">' +
        '<button id="wf-tab-share" style="flex:1;padding:8px;border:none;border-bottom:2px solid ' +
        (currentTab === "share" ? "var(--aih-accent, #D8700D)" : "transparent") + ';background:transparent;color:' +
        (currentTab === "share" ? "#e2e8f0" : "#888") + ';font-size:13px;font-weight:' +
        (currentTab === "share" ? "600" : "400") + ';cursor:pointer;">' + t('wf.tabShare') + '</button>' +
        '<button id="wf-tab-browse" style="flex:1;padding:8px;border:none;border-bottom:2px solid ' +
        (currentTab === "browse" ? "var(--aih-accent, #D8700D)" : "transparent") + ';background:transparent;color:' +
        (currentTab === "browse" ? "#e2e8f0" : "#888") + ';font-size:13px;font-weight:' +
        (currentTab === "browse" ? "600" : "400") + ';cursor:pointer;">' + t('wf.tabBrowse') + '</button>' +
        '</div>' +
        '<div id="wf-tab-content" style="flex:1;"></div>' +
        // Version VISIBLE : l'utilisateur peut confirmer d'un coup d'œil que le
        // navigateur exécute bien la nouvelle build (cf. cache/obsolescence).
        '<div style="font-size:10px;color:#555;text-align:right;">' + esc(t('wf.buildLabel', { build: AIH_WF_SHARE_BUILD })) + '</div>' +
        '</div>';

      // Sonde de fraîcheur : si le fichier réellement SERVI ne contient pas le
      // même marqueur de build, on affiche un bandeau explicite (jamais un
      // correctif silencieusement inactif).
      checkServedBuildFreshness().then(function (stale) {
        if (!stale) return;
        var banner = body.querySelector("#wf-stale-banner");
        if (!banner) return;
        banner.style.display = "block";
        banner.textContent = t("wf.staleBuild", {
          running: AIH_WF_SHARE_BUILD,
          served: (window.AIH_WF_SHARE && window.AIH_WF_SHARE.servedBuild) || "?",
        });
      });

      body.querySelector("#wf-tab-share").onclick = function () { currentTab = "share"; renderTab(); updateTabStyles(); };
      body.querySelector("#wf-tab-browse").onclick = function () { currentTab = "browse"; renderTab(); updateTabStyles(); };
      renderTab();
    }

    function renderTab() {
      var container = body.querySelector("#wf-tab-content");
      if (currentTab === "share") renderShareTab(container);
      else renderBrowseTab(container);
    }

    // ═══════════════════════════════════════════════
    //  TAB 1 : PARTAGER
    // ═══════════════════════════════════════════════

    async function renderShareTab(container) {
      // Lire le workflow actif
      var workflowStr = "";
      var workflowJSON = null;
      try {
        var currentApp = getApp();
        if (currentApp && currentApp.graph) {
          workflowJSON = currentApp.graph.serialize();
          workflowStr = JSON.stringify(workflowJSON, null, 2);
        }
      } catch (e) { workflowStr = ""; }

      if (!workflowStr) {
        container.innerHTML = '<p style="color:#f87171;font-size:13px;text-align:center;padding:30px 0;">' + t('wf.noWorkflow') + '</p>';
        return;
      }

      container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;gap:8px;padding:30px 0;color:#888;font-size:13px;"><span style="display:inline-block;width:16px;height:16px;border:2px solid #555;border-top-color:var(--aih-accent, #D8700D);border-radius:50%;animation:aih-spin 0.8s linear infinite;"></span> ' + t('wf.analyzingDeps') + '</div>';
      var deps = await detectDependencies(workflowJSON);
      var existingId = null;

      // Recuperer le nom du workflow actif depuis toutes les sources possibles
      var wfTitle = '';
      try {
        var _app = getApp();
        wfTitle = workflowJSON?.extra?.title || workflowJSON?.title || workflowJSON?.name
          || _app?.ui?.title || _app?.graph?.title
          || _app?.workflowName || _app?.ui?.workflowName
          || '';
        // Fallback: tab name depuis le DOM (ComfyUI new UI)
        if (!wfTitle) {
          var tabEl = document.querySelector('.tab-name, .workflow-tab-name, .comfy-tab.active .tab-name');
          if (tabEl) wfTitle = tabEl.textContent?.trim() || '';
        }
        // Fallback: document.title (souvent "WorkflowName - ComfyUI")
        if (!wfTitle) {
          var dt = document.title || '';
          if (dt.includes(' - ')) dt = dt.split(' - ')[0];
          if (dt && dt !== 'ComfyUI') wfTitle = dt;
        }
      } catch(e) {}

      container.innerHTML =
        '<div style="display:flex;flex-direction:column;gap:10px;">' +
        '<div><label style="font-size:11px;color:#888;display:block;margin-bottom:3px;">' + t('wf.labelName') + '</label>' +
        '<input id="wf-name" type="text" placeholder="' + t('wf.namePlaceholder') + '" value="' + esc(wfTitle) + '" style="width:100%;padding:6px 8px;border-radius:4px;border:1px solid #555;background:#3a3a3e;color:#ccc;font-size:13px;box-sizing:border-box;"></div>' +
        '<div><label style="font-size:11px;color:#888;display:block;margin-bottom:3px;">' + t('wf.labelDesc') + '</label>' +
        '<textarea id="wf-desc" rows="2" style="width:100%;padding:6px 8px;border-radius:4px;border:1px solid #555;background:#3a3a3e;color:#ccc;font-size:12px;box-sizing:border-box;resize:vertical;"></textarea></div>' +
        '<div><label style="font-size:11px;color:#888;display:block;margin-bottom:3px;">' + t('wf.labelTags') + '</label>' +
        '<input id="wf-tags" type="text" style="width:100%;padding:6px 8px;border-radius:4px;border:1px solid #555;background:#3a3a3e;color:#ccc;font-size:13px;box-sizing:border-box;"></div>' +
        '<div id="wf-deps" style="font-size:12px;color:#bbb;border-top:1px solid #444;padding-top:8px;"></div>' +
        '<button id="wf-publish-btn" style="padding:8px;border:none;border-radius:6px;background:var(--aih-accent, #D8700D);color:#fff;font-size:13px;font-weight:600;cursor:pointer;">' + t('wf.publish') + '</button>' +
        '<div id="wf-status" style="font-size:11px;color:#888;display:none;"></div>' +
        '</div>';

      // Remplir les dépendances avec checkboxes d'upload
      var depsHtml = '<p style="font-size:11px;color:#888;margin:0 0 6px 0;">' + t('wf.depsDetected') + '</p>';
      if (deps.nodes.length === 0 && deps.models.length === 0 && deps.loras.length === 0) {
        depsHtml += '<span style="color:#34d399;">' + t('wf.noDeps') + '</span>';
      } else {
        depsHtml += '<p style="font-size:10px;color:#666;margin:0 0 6px 0;">' + t('wf.checkUpload') + '</p>';
        if (deps.nodes.length) {
          depsHtml += '<div style="margin-bottom:4px;"><span style="color:#f59e0b;">' + t('wf.customNodes') + ' (' + deps.nodes.length + (deps.nodes.length > 1 ? ' ' + t('wf.packs') : ' ' + t('wf.pack')) + ')</span>';
          for (var i = 0; i < deps.nodes.length; i++) {
            var pk = deps.nodes[i];
            var nodeCount = pk.node_types ? pk.node_types.length : 1;
            depsHtml += '<div style="margin-left:12px;color:#ccc;">· ' + esc(pk.name) +
              (nodeCount > 1 ? ' (' + t('wf.nodeCount', { count: nodeCount }) + ') ' : '') +
              (pk.url ? ' <span style="color:#34d399;font-size:10px;">✓ ' + esc(pk.url) + '</span>' : ' <span style="color:#f87171;font-size:10px;">' + t('wf.noGitUrl') + '</span>') +
              '</div>';
          }
          depsHtml += '</div>';
        }
        if (deps.models.length) {
          depsHtml += '<div style="margin-bottom:4px;"><span style="color:var(--aih-accent, #D8700D);">' + t('wf.models') + '</span>';
          for (var i = 0; i < deps.models.length; i++) {
            var m = deps.models[i];
            depsHtml += '<label style="display:flex;align-items:center;gap:6px;margin-left:12px;color:#ccc;cursor:pointer;font-size:11px;">' +
              '<input type="checkbox" class="wf-upload-cb" checked data-type="' + esc(m.type || 'model') + '" data-name="' + esc(m.name) + '" style="accent-color:var(--aih-accent, #D8700D);">' +
              '<span style="flex:1;">' + esc(m.name) + '</span></label>';
          }
          depsHtml += '</div>';
        }
        if (deps.loras.length) {
          depsHtml += '<div style="margin-bottom:4px;"><span style="color:#a78bfa;">' + t('wf.loras') + '</span>';
          for (var i = 0; i < deps.loras.length; i++) {
            var l = deps.loras[i];
            depsHtml += '<label style="display:flex;align-items:center;gap:6px;margin-left:12px;color:#ccc;cursor:pointer;font-size:11px;">' +
              '<input type="checkbox" class="wf-upload-cb" checked data-type="lora" data-name="' + esc(l.name) + '" style="accent-color:var(--aih-accent, #D8700D);">' +
              '<span style="flex:1;">' + esc(l.name) + '</span></label>';
          }
          depsHtml += '</div>';
        }
      }
      container.querySelector("#wf-deps").innerHTML = depsHtml;

      // Vérifier si un workflow du même nom existe déjà.
      // La propriété est calculée CÔTÉ SERVEUR (`is_mine`) : le front ne
      // compare plus d'identités (user_id n'est PAS exposé — pas d'énumération).
      function checkExisting(name) {
        if (!name) { existingId = null; return; }
        remoteGet(getApiUrl() + "/workflows?q=" + encodeURIComponent(name) + "&limit=5")
          .then(function (data) {
            var items = data?.items || [];
            var btn = container.querySelector("#wf-publish-btn");
            if (!btn) return;
            for (var i = 0; i < items.length; i++) {
              // « Mettre à jour » UNIQUEMENT si le workflow est le nôtre :
              // sinon on publie un NOUVEAU workflow (jamais écraser autrui).
              if (items[i].name.toLowerCase() === name.toLowerCase() && items[i].is_mine === true) {
                existingId = items[i].id;
                btn.textContent = t("wf.update", { version: (items[i].version + 1) });
                btn.style.background = "#f59e0b";
                return;
              }
            }
            existingId = null;
            btn.textContent = t("wf.publish");
            btn.style.background = "var(--aih-accent, #D8700D)";
          })
          .catch(function(){});
      }

      container.querySelector("#wf-name").addEventListener("input", function () {
        checkExisting(this.value.trim());
      });
      // Check existing on load too
      var initialName = container.querySelector("#wf-name").value.trim();
      if (initialName) checkExisting(initialName);

      // Publish
      container.querySelector("#wf-publish-btn").onclick = async function () {
        var name = container.querySelector("#wf-name").value.trim();
        var desc = container.querySelector("#wf-desc").value.trim();
        var tags = container.querySelector("#wf-tags").value.trim();
        var statusEl = container.querySelector("#wf-status");
        statusEl.style.display = "block";
        statusEl.style.color = "#fbbf24";
        statusEl.textContent = t("wf.capturePreview");

        // 📸 Capture du canvas ComfyUI
        var thumbnail = "";
        try {
          var currentApp = getApp();
          var canvas = null;
          if (currentApp && currentApp.canvas && currentApp.canvas.canvas) {
            canvas = currentApp.canvas.canvas;
          } else if (window.canvasEl) {
            canvas = window.canvasEl;
          }
          if (canvas && canvas.toDataURL) {
            // Redimensionner pour limiter la taille (max 400px de large)
            var tmpCanvas = document.createElement("canvas");
            var maxW = 400;
            var scale = Math.min(1, maxW / canvas.width);
            tmpCanvas.width = Math.round(canvas.width * scale);
            tmpCanvas.height = Math.round(canvas.height * scale);
            var ctx = tmpCanvas.getContext("2d");
            ctx.fillStyle = "#2a2a2e";
            ctx.fillRect(0, 0, tmpCanvas.width, tmpCanvas.height);
            ctx.drawImage(canvas, 0, 0, tmpCanvas.width, tmpCanvas.height);
            thumbnail = tmpCanvas.toDataURL("image/jpeg", 0.7);
          }
        } catch (e) {
          console.warn("[AIH] Screenshot failed:", e);
        }

        statusEl.textContent = t("wf.publishing");

        // Référencer un fichier serveur dans la charge utile du workflow
        // (required_models/required_loras) — utilisé aussi pour les modèles
        // IGNORÉS (déjà présents) afin que les autres instances puissent les
        // télécharger via leur upload_id existant.
        function setDepUpload(fileType, fileName, uploadId, filePath) {
          if (!uploadId && !filePath) return;
          var depArray = fileType === 'lora' ? deps.loras : deps.models;
          for (var di = 0; di < depArray.length; di++) {
            if (depArray[di].name === fileName) {
              if (uploadId) depArray[di].upload_id = uploadId;
              if (filePath) depArray[di].file_path = filePath;
              break;
            }
          }
        }

        // Uploader les models/loras cochés vers le serveur AIH
        var uploadCbs = container.querySelectorAll(".wf-upload-cb:checked");
        if (uploadCbs.length > 0) {
          var localFiles = await getLocalModelFiles();
          // Construire un map global: filename → {name, path, size}
          var allFilesMap = {};
          for (var cat in localFiles) {
            var catFiles = localFiles[cat];
            for (var fi = 0; fi < catFiles.length; fi++) {
              allFilesMap[catFiles[fi].name] = catFiles[fi];
            }
          }

          // Sélection RÉELLE (fichiers trouvés localement) ; clé composite
          // type|nom pour distinguer un model d'un lora homonyme.
          var selection = [];
          var notFoundLocal = [];
          for (var ui = 0; ui < uploadCbs.length; ui++) {
            var ucb = uploadCbs[ui];
            var uType = ucb.dataset.type;
            var uName = ucb.dataset.name;
            var uFile = allFilesMap[uName];
            if (!uFile && uName.indexOf('/') >= 0) {
              var uBase = uName.substring(uName.lastIndexOf('/') + 1);
              uFile = allFilesMap[uBase];
            }
            if (!uFile) {
              // Fichier coché mais INTROUVABLE localement : sans upload_id le
              // workflow publié listerait une dépendance NON téléchargeable.
              // On le DIT (jamais de skip silencieux à la publication non plus).
              console.warn('[AIH] Non trouve localement: ' + uName);
              notFoundLocal.push(uName);
              continue;
            }
            selection.push({
              key: uType + '|' + uName, name: uName, type: uType,
              path: uFile.path, size: uFile.size, status: null, remote: null,
            });
          }
          if (notFoundLocal.length > 0) {
            aihToast(t('wf.uploadLocalMissing', { count: notFoundLocal.length, names: notFoundLocal.join(', ') }), 'error');
          }

          // Check PAR LOT AVANT l'envoi : on détermine ce qui existe déjà côté
          // serveur (critère identique à la déduplication d'upload) au lieu de
          // le découvrir après coup. Échec du check (route absente, serveur
          // injoignable) → retour au comportement historique, sans blocage.
          await checkServerPresence(selection);
          var hasExisting = false;
          for (var si = 0; si < selection.length; si++) {
            if (selection[si].status === 'identical' || selection[si].status === 'different') {
              hasExisting = true;
              break;
            }
          }

          var overwriteKeys = {};
          if (hasExisting) {
            var decision = await showPreUploadModal(selection);
            if (!decision || decision.action !== 'confirm') {
              // Annuler : ne rien envoyer (ni modèles, ni workflow).
              statusEl.textContent = '';
              statusEl.style.display = 'none';
              return;
            }
            for (var oi = 0; oi < (decision.overwrite || []).length; oi++) {
              overwriteKeys[decision.overwrite[oi]] = true;
            }
            // Existants IGNORÉS : rester référencés par leur upload_id serveur
            // (le workflow publié pointera sur le fichier déjà en place, sinon
            // les autres instances le verraient « manquant »).
            for (var ri = 0; ri < selection.length; ri++) {
              var selItem = selection[ri];
              var selExisting = selItem.status === 'identical' || selItem.status === 'different';
              if (selExisting && !overwriteKeys[selItem.key] && selItem.remote) {
                setDepUpload(selItem.type, selItem.name, selItem.remote.upload_id, selItem.remote.file_path);
              }
            }
          }

          var panel = createUploadPanel();
          var uploadPromises = [];
          for (var ui2 = 0; ui2 < selection.length; ui2++) {
            (function(item) {
              var isOverwrite = !!overwriteKeys[item.key];
              var isExisting = item.status === 'identical' || item.status === 'different';
              // Existant NON coché = ignoré : aucun octet envoyé, mais la
              // ligne de résultat le DIT (⏭ « ignoré », sans faux succès).
              if (isExisting && !isOverwrite) {
                panel.addRow(item.name, item.size, null);
                panel.setResult(item.name, 'skipped');
                return;
              }
              panel.addRow(item.name, item.size, item.path);
              uploadPromises.push(
                uploadModelToServer(item.path, item.type, isOverwrite).then(function(upResult) {
                  if (upResult.success) {
                    console.log('[AIH] Upload OK: ' + item.name);
                    setDepUpload(item.type, item.name, upResult.upload_id, upResult.file_path);
                    // ``deduplicated`` = le serveur n'a transféré aucun octet :
                    // « ignoré », jamais un succès de transfert.
                    var outcome = upResult.deduplicated === true
                      ? 'skipped' : (isOverwrite ? 'overwritten' : 'sent');
                    panel.setResult(item.name, outcome);
                  } else {
                    console.error('[AIH] Upload FAIL: ' + item.name + ' → ' + (upResult.error || 'echec'));
                    panel.setResult(item.name, 'failed', upResult.error);
                  }
                })
              );
            })(selection[ui2]);
          }
          await Promise.all(uploadPromises);
          panel.done();
        }

        statusEl.textContent = t("wf.publishing");
        var payload = {
          name: name, description: desc, tags: tags,
          workflow_json: workflowStr,
          required_nodes: deps.nodes,
          required_models: deps.models,
          required_loras: deps.loras,
          thumbnail: thumbnail,
        };
        if (existingId) payload.existing_id = existingId;

        remotePost(getApiUrl() + "/workflows", payload)
          .then(function (data) {
            if (data.error) throw new Error(data.error);
            statusEl.style.color = "#34d399";
            statusEl.textContent = existingId ? t("wf.updated") : t("wf.published");
            setTimeout(function () { statusEl.textContent = ""; statusEl.style.display = "none"; }, 2000);
          })
          .catch(function (e) {
            statusEl.style.color = "#f87171";
            statusEl.textContent = "❌ " + e.message;
          });
      };
    }

    // ═══════════════════════════════════════════════
    //  TAB 2 : PARCOURIR
    // ═══════════════════════════════════════════════

    async function renderBrowseTab(container, ctx) {
      ctx = ctx || browseState;
      var q = encodeURIComponent(ctx.query);
      var s = encodeURIComponent(ctx.sort);
      var url = getApiUrl() + "/workflows?q=" + q + "&sort=" + s + "&page=" + ctx.page + "&limit=20";

      // Injecter les styles CSS pour le hover des cards
      if (!document.getElementById("wf-browse-styles")) {
        var s = document.createElement("style");
        s.id = "wf-browse-styles";
        s.textContent = '.wf-card:hover .wf-del-btn { display: block !important; }';
        document.head.appendChild(s);
      }

      container.innerHTML =
        '<div style="display:flex;flex-direction:column;gap:8px;min-height:300px;">' +
        '<div style="display:flex;gap:8px;">' +
        '<input id="wf-search" type="text" placeholder="' + t('wf.searchPlaceholder') + '" value="' + esc(ctx.query) + '" style="flex:1;padding:6px 8px;border-radius:4px;border:1px solid #555;background:#3a3a3e;color:#ccc;font-size:13px;">' +
        '<select id="wf-sort" style="padding:6px 8px;border-radius:4px;border:1px solid #555;background:#3a3a3e;color:#ccc;font-size:12px;">' +
        '<option value="downloads"' + (ctx.sort === "downloads" ? " selected" : "") + '>' + t('wf.sortDl') + '</option>' +
        '<option value="likes"' + (ctx.sort === "likes" ? " selected" : "") + '>' + t('wf.sortLikes') + '</option>' +
        '<option value="created_at"' + (ctx.sort === "created_at" ? " selected" : "") + '>' + t('wf.sortDate') + '</option>' +
        '</select></div>' +
        '<div id="wf-list" style="flex:1;"><p style="color:#888;font-size:13px;text-align:center;padding:30px 0;">' + t('wf.loading') + '</p></div>' +
        '<div id="wf-pages" style="display:flex;justify-content:center;gap:6px;"></div>' +
        '</div>';

      container.querySelector("#wf-search").addEventListener("input", function () {
        clearTimeout(window._wfSearchTimer);
        window._wfSearchTimer = setTimeout(function () {
          ctx.query = container.querySelector("#wf-search").value.trim();
          ctx.page = 1;
          renderBrowseTab(container, ctx);
        }, 300);
      });

      container.querySelector("#wf-sort").addEventListener("change", function () {
        ctx.sort = container.querySelector("#wf-sort").value;
        ctx.page = 1;
        renderBrowseTab(container, ctx);
      });

      remoteGet(url)
        .then(async function (data) {
          var items = data?.items || [];
          var total = data?.total || 0;
          var pages = Math.ceil(total / 20);
          var listEl = container.querySelector("#wf-list");

          if (items.length === 0) {
            listEl.innerHTML = '<p style="color:#888;font-size:13px;text-align:center;padding:30px 0;">' + t('wf.noWorkflows') + '</p>';
            return;
          }

          var html = "";
          for (var i = 0; i < items.length; i++) {
            var w = items[i];
            var author = w.author || "?";
            var depsCount = (w.required_nodes?.length || 0) + (w.required_models?.length || 0) + (w.required_loras?.length || 0);
            // Le bouton de suppression n'est proposé QUE sur nos propres
            // workflows (is_mine calculé côté serveur) — le serveur reste la
            // garde finale (403 sur DELETE d'autrui).
            var delHtml = (w.is_mine === true)
              ? '<button class="wf-del-btn" data-wf-id="' + w.id + '" data-wf-name="' + esc(w.name) + '" onclick="event.stopPropagation();window._wfDeleteWorkflow(this)" style="position:absolute;top:4px;right:4px;width:22px;height:22px;border:1px solid #555;border-radius:4px;background:rgba(60,60,64,0.9);color:#f87171;font-size:11px;cursor:pointer;padding:0;line-height:20px;text-align:center;z-index:2;display:none;">🗑</button>'
              : '';
            html +=
              '<div class="wf-card" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid #444;border-radius:6px;margin-bottom:4px;cursor:pointer;background:#3a3a3e;position:relative;"' +

              ' onclick="window._wfOpenDetail(' + w.id + ', this)">' +
              delHtml +
              (w.thumbnail ? '<img src="' + w.thumbnail + '" style="width:48px;height:48px;border-radius:4px;object-fit:cover;flex-shrink:0;">' : '<div style="width:48px;height:48px;border-radius:4px;background:#444;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;">📤</div>') +
              '<div style="flex:1;min-width:0;">' +
              '<div style="font-size:13px;font-weight:600;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(w.name) + '</div>' +
              '<div style="font-size:11px;color:#888;">' + t('wf.by') + esc(author) + (depsCount > 0 ? ' · ' + depsCount + t('wf.depsAbbr') : '') + '</div></div>' +
              '<div style="text-align:right;font-size:11px;color:#888;white-space:nowrap;">' +
              '❤️ ' + (w.likes || 0) + ' 📥 ' + (w.downloads || 0) + ' <span style="color:#666;">v' + (w.version || 1) + '</span></div></div>';
          }
          listEl.innerHTML = html;

          // Pagination
          var pagEl = container.querySelector("#wf-pages");
          if (pages > 1) {
            var pagHtml = "";
            if (ctx.page > 1)
              pagHtml += '<button onclick="window._wfGoPage(' + (ctx.page - 1) + ')" style="padding:4px 10px;border:1px solid #555;border-radius:4px;background:#3a3a3e;color:#ccc;cursor:pointer;font-size:12px;">←</button>';
            pagHtml += '<span style="font-size:12px;color:#888;padding:4px 8px;">' + ctx.page + ' / ' + pages + '</span>';
            if (ctx.page < pages)
              pagHtml += '<button onclick="window._wfGoPage(' + (ctx.page + 1) + ')" style="padding:4px 10px;border:1px solid #555;border-radius:4px;background:#3a3a3e;color:#ccc;cursor:pointer;font-size:12px;">→</button>';
            pagEl.innerHTML = pagHtml;
          }
        })
        .catch(function () {
          container.querySelector("#wf-list").innerHTML = '<p style="color:#f87171;font-size:13px;text-align:center;padding:30px 0;">' + t('wf.loadError') + '</p>';
        });
    }

    // ── Detail / Install (global pour les onclick HTML) ──

    window._wfGoPage = function (page) {
      browseState.page = page;
      render();
    };

    window._wfDeleteWorkflow = async function(btn) {
      var id = parseInt(btn.getAttribute("data-wf-id"));
      var name = btn.getAttribute("data-wf-name") || "?";
      var confirmed = await aihShowConfirm(t("dialog.delete"), t("wf.deleteConfirm", { name: name }));
      if (!confirmed) return;
      btn.textContent = "⏳";
      try {
        var data = await remoteDelete(getApiUrl() + "/workflows/" + id);
        if (data.error) throw new Error(data.error);
        var card = btn.closest('[class*="wf-card"]');
        if (card) { card.style.transition = "opacity 0.3s, transform 0.3s"; card.style.opacity = "0"; card.style.transform = "scale(0.9)"; setTimeout(function() { if (card) card.remove(); }, 300); }
        aihToast(t('wf.deleted', { name: name }) + (data.deleted_files && data.deleted_files.length ? ' (' + t('wf.orphansDeleted', { count: data.deleted_files.length }) + ')' : ''), "success");
      } catch (e) {
        aihToast(t("wf.errorPrefix") + e.message, "error");
      }
    };



    window._wfOpenDetail = function (workflowId) {
      var _dm = aihOpenModalV2({
          title: t("wf.detailTitle"),
          width: "580px",
          height: "auto",
          minWidth: "400px",
          minHeight: "300px",
          storageKey: "aih-modal-workflow-detail",
          persistSize: true,
          persistPos: true
      });
      var detailModal = _dm.modal;
      var detailBody = _dm.body;
      detailBody.innerHTML = '<p style="color:#888;font-size:13px;text-align:center;padding:30px 0;">' + t('wf.loading') + '</p>';

      remoteGet(getApiUrl() + "/workflows/" + workflowId)
        .then(function (w) {
          var html =
            '<div style="margin-bottom:12px;">' +
            '<h2 style="font-size:16px;font-weight:700;color:#e2e8f0;margin:0 0 4px 0;">' + esc(w.name) + '</h2>' +
            '<p style="font-size:12px;color:#888;margin:0;">' + t('wf.by') + esc(w.author || "?") + ' · v' + (w.version || 1) +
            ' · ❤️ ' + (w.likes || 0) + ' · 📥 ' + (w.downloads || 0) + '</p>' +
            (w.description ? '<p style="font-size:12px;color:#aaa;margin:8px 0 0 0;">' + esc(w.description) + '</p>' : '') +
            '</div>' +
            '<div id="wf-install-deps" style="margin-bottom:12px;"></div>' +
            '<div style="display:flex;gap:8px;">' +
            '<button id="wf-load-btn" style="flex:1;padding:10px;border:none;border-radius:6px;background:var(--aih-accent, #D8700D);color:#fff;font-size:13px;font-weight:600;cursor:pointer;">' + t('wf.loadWorkflow') + '</button>' +
            '<button id="wf-close-btn" style="padding:10px 16px;border:1px solid #555;border-radius:6px;background:transparent;color:#999;font-size:13px;cursor:pointer;">' + t('dialog.close') + '</button></div>' +
            '<div id="wf-load-status" style="font-size:11px;color:#888;display:none;margin-top:8px;"></div>' +
            '<div id="wf-detail-build" style="font-size:10px;color:#555;text-align:right;margin-top:4px;">' + esc(t('wf.buildLabel', { build: AIH_WF_SHARE_BUILD })) + '</div>';

          detailBody.innerHTML = html;
          detailBody.querySelector("#wf-close-btn").onclick = function() { _dm.close(); };

          // Dépendances — vérifier les models/loras locaux en async
          var allDeps = {
            nodes: w.required_nodes || [],
            models: w.required_models || [],
            loras: w.required_loras || [],
          };
          var totalDeps = allDeps.nodes.length + allDeps.models.length + allDeps.loras.length;
          var depsEl = detailBody.querySelector("#wf-install-deps");

          // Index des packs déjà installés, résolu UNE fois puis partagé par le
          // rendu de la liste ET le bouton « Charger le workflow » (sinon la
          // détection d'installation serait faite deux fois, avec risque de
          // divergence). Les alias (comfyui-ai-helper vs AI-Helper, .git,
          // ssh/https, casse…) matchent le même index.
          var _installedIndexPromise = null;
          function getInstalledIndex() {
            if (!_installedIndexPromise) {
              _installedIndexPromise = getInstalledCustomNodes(true)
                .then(function (list) { return buildInstalledNodeIndex(list); })
                .catch(function () {
                  // Échec réseau/route : NE PAS mémoriser un index vide (sinon
                  // le bouton « Charger le workflow » réutiliserait ce vide et
                  // réinstallerait des packs présents). L'appel suivant réessaie.
                  _installedIndexPromise = null;
                  return buildInstalledNodeIndex([]);
                });
            }
            return _installedIndexPromise;
          }

          if (totalDeps === 0) {
            depsEl.innerHTML = '<p style="font-size:12px;color:#34d399;">' + t('wf.noDeps') + '</p>';
          } else {
            depsEl.innerHTML = '<p style="font-size:12px;color:#888;">' + t('wf.checkingDeps') + '</p>';
            
            // Interroger ComfyUI pour les models/loras déjà installés
            Promise.all([getLocalModels(), getLocalLoras()]).then(async function(results) {
              var localModels = results[0];
              var localLoras = results[1];
              
              var depHtml = '<p style="font-size:12px;color:#fbbf24;margin:0 0 8px 0;">' + t('wf.requiredDeps') + '</p>';
              depHtml += '<div style="border:1px solid #444;border-radius:6px;overflow:hidden;">';

              if (allDeps.nodes.length) {
                // Packs déjà installés : comparaison NORMALISÉE (URL git + nom de
                // dossier + slug) pour reconnaître les alias du même dépôt.
                var installedIndex = await getInstalledIndex();
                depHtml += '<div style="background:#3a3a3e;padding:6px 10px;border-bottom:1px solid #444;"><span style="font-size:11px;color:#f59e0b;font-weight:600;">' + t('wf.customNodesHeader') + '</span></div>';
                for (var i = 0; i < allDeps.nodes.length; i++) {
                  var n = allDeps.nodes[i];
                  var nodeCount = n.node_types ? n.node_types.length : 1;
                  var match = matchInstalledNode(installedIndex, n.name, n.url, n.node_types);
                  var installed = !!match;
                  var reason = installed ? installedMatchReason(match) : "";
                  // Déjà installé → case DÉCOCHÉE (aucune tentative d'installation,
                  // aucun échec) + RAISON affichée. La case reste COCHABLE : la
                  // recocher FORCE l'installation (filet « already installed » en
                  // secours). Sinon cochée par défaut.
                  depHtml += '<label style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid #3a3a3e;cursor:pointer;font-size:12px;color:' + (installed ? '#34d399' : '#ccc') + ';">' +
                    '<input type="checkbox" class="wf-dep-cb"' + (installed ? '' : ' checked') + ' data-type="node" data-name="' + esc(n.name) + '" data-url="' + esc(n.url || '') + '"' + ' data-node-types="' + esc(encodeURIComponent(JSON.stringify(n.node_types || []))) + '"' + (installed ? ' data-installed="1" data-installed-reason="' + esc(reason) + '" title="' + esc(t('wf.forceInstallHint')) + '"' : '') + ' style="accent-color:var(--aih-accent, #D8700D);">' +
                    '<span style="flex:1;">' + esc(n.name) +
                    (nodeCount > 1 ? ' (' + t('wf.nodeCount', { count: nodeCount }) + ') ' : '') +
                    (installed ? ' <span style="color:#34d399;">' + t('wf.alreadyInstalledMatch', { reason: reason }) + '</span>' : '') +
                    (!installed && !n.url ? ' <span style="color:#f87171;">' + t('wf.noGitUrl') + '</span>' : '') + '</span>' +
                    (n.url && !installed ? '<button onclick="window._wfInstallNode(\'' + esc(n.url) + '\', \'' + esc(n.name) + '\', this)" style="padding:2px 8px;border:1px solid #555;border-radius:3px;background:#4a4a4e;color:#ccc;font-size:10px;cursor:pointer;">' + t('wf.install') + '</button>' : '') +
                    (n.url ? '<a href="' + esc(n.url) + '" target="_blank" style="color:var(--aih-accent, #D8700D);text-decoration:none;font-size:11px;" onclick="event.stopPropagation();">🔗</a>' : '') +
                    '</label>';
                }
              }
              if (allDeps.models.length) {
                if (allDeps.nodes.length) depHtml += '<div style="border-top:1px solid #444;"></div>';
                depHtml += '<div style="background:#3a3a3e;padding:6px 10px;border-bottom:1px solid #444;"><span style="font-size:11px;color:var(--aih-accent, #D8700D);font-weight:600;">' + t('wf.models') + '</span></div>';
                // Références serveur absentes : résolution PAR NOM en PARALLÈLE
                // (le fichier peut déjà être sur le serveur sans que le
                // workflow publié porte son upload_id — cas réel des 2 gros
                // unet/clip publiés avant le correctif d'upload). Un échec
                // laisse la ligne « non téléchargeable » avec sa raison.
                var missingRefs = [];
                for (var mi = 0; mi < allDeps.models.length; mi++) {
                  if (localModels.indexOf(allDeps.models[mi].name) < 0 && !allDeps.models[mi].upload_id) {
                    missingRefs.push(allDeps.models[mi]);
                  }
                }
                if (missingRefs.length) {
                  var resolvedRefs = await Promise.all(missingRefs.map(function (mm) {
                    return resolveRemoteUploadId(mm);
                  }));
                  for (var ri = 0; ri < missingRefs.length; ri++) {
                    if (resolvedRefs[ri] && resolvedRefs[ri].upload_id) {
                      missingRefs[ri].upload_id = resolvedRefs[ri].upload_id;
                      missingRefs[ri]._resolved_ref = true;
                      if ((!missingRefs[ri].size || !Number(missingRefs[ri].size)) && resolvedRefs[ri].size) {
                        missingRefs[ri].size = resolvedRefs[ri].size;
                      }
                    }
                  }
                }
                for (var i = 0; i < allDeps.models.length; i++) {
                  var m = allDeps.models[i];
                  var installed = localModels.indexOf(m.name) >= 0;
                  var hasFile = !!m.upload_id;
                  depHtml += '<div style="padding:6px 10px;border-bottom:1px solid #3a3a3e;font-size:12px;color:' + (installed ? '#34d399' : '#ccc') + ';">' +
                    '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
                    '<input type="checkbox" class="wf-dep-cb"' + (installed ? '' : ' checked') + ' data-type="model" data-model-type="' + esc(m.type || 'model') + '" data-name="' + esc(m.name) + '" ' + (hasFile ? 'data-upload-id="' + esc(m.upload_id) + '"' : '') + ' style="accent-color:var(--aih-accent, #D8700D);">' +
                    '<span style="flex:1;">' + esc(m.name) + (installed ? t('wf.alreadyInstalled') : '') + (!installed && hasFile && m._resolved_ref ? ' <span style="color:#38bdf8;">' + t('wf.depResolved') + '</span>' : '') + (!installed && !hasFile ? ' <span style="color:#f87171;">' + t('wf.depNoServerRef') + '</span>' : '') + '</span>' +
                    '<span style="font-size:10px;color:#666;">' + (m.type || t('wf.modelType')) + '</span></label>';
                  if (!installed && hasFile) {
                    var typeToFolder = {'checkpoint':'checkpoints','lora':'loras','vae':'vae','clip':'clip','clip_vision':'clip_vision','controlnet':'controlnet','unet':'unet','unet_gguf':'unet_gguf','upscale':'upscale_models','gligen':'gligen','hypernetwork':'hypernetworks','text_encoder':'text_encoders','style_model':'style_models','diffusion_model':'diffusion_models','embedding':'embeddings','config':'configs','model':'checkpoints'};
                    var modelBase = (typeToFolder[m.type] || 'checkpoints') + '/';
                    depHtml += '<div style="display:flex;align-items:center;gap:4px;margin-top:4px;">' +
                      '<span class="wf-dep-basepath" style="font-size:10px;color:#666;font-family:monospace;white-space:nowrap;flex-shrink:0;">' + esc(modelBase) + '</span>' +
                      '<input type="text" class="wf-dep-path" value="' + esc(m.name) + '" data-orig="' + esc(m.name) + '" style="flex:1;padding:4px 6px;border:1px solid #555;border-radius:3px;background:#2a2a2e;color:#ccc;font-size:11px;font-family:monospace;box-sizing:border-box;" placeholder="' + t('wf.filePlaceholder') + '">' +
                      '</div>';
                  }
                  depHtml += '</div>';
                }
              }
              if (allDeps.loras.length) {
                if (allDeps.nodes.length || allDeps.models.length) depHtml += '<div style="border-top:1px solid #444;"></div>';
                depHtml += '<div style="background:#3a3a3e;padding:6px 10px;border-bottom:1px solid #444;"><span style="font-size:11px;color:#a78bfa;font-weight:600;">' + t('wf.loras') + '</span></div>';
                // Même résolution de secours par nom pour les loras sans upload_id
                // (parallèle, bornée à 8 s par requête).
                var missingLoraRefs = [];
                for (var li = 0; li < allDeps.loras.length; li++) {
                  if (localLoras.indexOf(allDeps.loras[li].name) < 0 && !allDeps.loras[li].upload_id) {
                    missingLoraRefs.push(allDeps.loras[li]);
                  }
                }
                if (missingLoraRefs.length) {
                  var resolvedLRefs = await Promise.all(missingLoraRefs.map(function (ll) {
                    return resolveRemoteUploadId({ name: ll.name, type: 'lora', size: ll.size });
                  }));
                  for (var lri = 0; lri < missingLoraRefs.length; lri++) {
                    if (resolvedLRefs[lri] && resolvedLRefs[lri].upload_id) {
                      missingLoraRefs[lri].upload_id = resolvedLRefs[lri].upload_id;
                      missingLoraRefs[lri]._resolved_ref = true;
                    }
                  }
                }
                for (var i = 0; i < allDeps.loras.length; i++) {
                  var l = allDeps.loras[i];
                  var installed = localLoras.indexOf(l.name) >= 0;
                  var hasFile = !!l.upload_id;
                  depHtml += '<div style="padding:6px 10px;border-bottom:1px solid #3a3a3e;font-size:12px;color:' + (installed ? '#34d399' : '#ccc') + ';">' +
                    '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
                    '<input type="checkbox" class="wf-dep-cb"' + (installed ? '' : ' checked') + ' data-type="lora" data-name="' + esc(l.name) + '" ' + (hasFile ? 'data-upload-id="' + esc(l.upload_id) + '"' : '') + ' style="accent-color:var(--aih-accent, #D8700D);">' +
                    '<span style="flex:1;">' + esc(l.name) + (installed ? t('wf.alreadyInstalled') : '') + (!installed && hasFile && l._resolved_ref ? ' <span style="color:#38bdf8;">' + t('wf.depResolved') + '</span>' : '') + (!installed && !hasFile ? ' <span style="color:#f87171;">' + t('wf.depNoServerRef') + '</span>' : '') + '</span></label>';
                  if (!installed && hasFile) {
                    depHtml += '<div style="display:flex;align-items:center;gap:4px;margin-top:4px;">' +
                      '<span class="wf-dep-basepath" style="font-size:10px;color:#666;font-family:monospace;white-space:nowrap;flex-shrink:0;">loras/</span>' +
                      '<input type="text" class="wf-dep-path" value="' + esc(l.name) + '" data-orig="' + esc(l.name) + '" style="flex:1;padding:4px 6px;border:1px solid #555;border-radius:3px;background:#2a2a2e;color:#ccc;font-size:11px;font-family:monospace;box-sizing:border-box;" placeholder="' + t('wf.filePlaceholder') + '">' +
                      '</div>';
                  }
                  depHtml += '</div>';
                }
              }
              depHtml += '</div>';
              depsEl.innerHTML = depHtml;
            });
          }

// Install custom node (global for onclick)
          window._wfInstallNode = async function(gitUrl, nodeName, btn) {
            if (!gitUrl) { aihToast(t("wf.noGitUrlMsg"), "error"); return; }
            btn.textContent = t("wf.cloning");
            btn.disabled = true;
            var toast = aihToast(t("wf.installing", { name: nodeName }), "progress");
            var cb = btn.closest && btn.closest("label") ? btn.closest("label").querySelector("input.wf-dep-cb") : null;
            // Succès (installation réelle OU déjà présent côté serveur) : la
            // ligne passe en « installé », jamais un échec pour un node déjà là.
            function _markInstalled(msgKey) {
              btn.textContent = t("wf.installed");
              btn.style.color = "#34d399";
              btn.style.borderColor = "#34d399";
              btn.disabled = true;
              markNodeInstalled(cb);
              aihToastDone(toast, "success", t(msgKey, { name: nodeName }));
            }
            try {
              var data = await HolafFetch.request("/api/aih/custom-nodes/install", {
                method: "POST",
                body: {git_url: gitUrl, name: nodeName}
              });
              if (data.success) {
                _markInstalled("wf.installedMsg");
              } else if (isAlreadyInstalledMessage(data.message)) {
                // Filet de sécurité : dossier déjà présent côté ComfyUI.
                _markInstalled("wf.alreadyInstalledMsg");
              } else {
                btn.textContent = "❌";
                btn.style.color = "#f87171";
                aihToastDone(toast, "error", "❌ " + (data.message || t("aih.failed")));
              }
            } catch (e) {
              var emsg = installErrorMessage(e);
              if (isAlreadyInstalledMessage(emsg)) {
                // Filet de sécurité : le serveur répond « Node 'X' already
                // installed » (400) → skip bénin, AUCUNE erreur affichée.
                _markInstalled("wf.alreadyInstalledMsg");
              } else {
                btn.textContent = "❌";
                btn.style.color = "#f87171";
                aihToastDone(toast, "error", t("wf.nodeInstallFailed", { name: nodeName, error: emsg }));
              }
            }
          };

          // ── Download progress panel (reused for install) ──
          function createDownloadPanel(title) {
            var panel = document.createElement("div");
            panel.style.cssText = "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1e1e24;border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,0.6);width:440px;max-height:70vh;z-index:100001;display:flex;flex-direction:column;overflow:hidden;";
            var header = document.createElement("div");
            header.style.cssText = "padding:12px 16px;border-bottom:1px solid #333;font-size:14px;font-weight:600;color:#e2e8f0;cursor:grab;user-select:none;display:flex;align-items:center;justify-content:space-between;gap:8px;";
            var headerTitle = document.createElement("span");
            headerTitle.textContent = title || t("wf.downloadTitle");
            // Progression GLOBALE du lot (N/M) — visible en permanence.
            var countEl = document.createElement("span");
            countEl.style.cssText = "font-size:11px;font-weight:600;color:#888;font-family:monospace;white-space:nowrap;";
            header.appendChild(headerTitle);
            header.appendChild(countEl);
            panel.appendChild(header);
            makeDraggable(panel, {
              handle: header,
              anchor: "left-top",
              clamp: false,
              bakeTransform: function() {
                var r = panel.getBoundingClientRect();
                panel.style.transform = "none";
                panel.style.left = r.left + "px";
                panel.style.top = r.top + "px";
              },
              cursor: "grabbing",
              cursorRestore: "grab",
            });
            var body = document.createElement("div");
            body.style.cssText = "padding:12px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:8px;";
            panel.appendChild(body);
            // Barre de progression GLOBALE (fine, sous l'en-tête).
            var globalBar = document.createElement("div");
            globalBar.style.cssText = "height:4px;background:rgba(255,255,255,0.08);flex-shrink:0;";
            var globalFill = document.createElement("div");
            globalFill.style.cssText = "height:100%;width:0%;background:var(--aih-accent, #D8700D);transition:width 0.3s ease;";
            globalBar.appendChild(globalFill);
            panel.insertBefore(globalBar, body);
            // Bandeau de FIN (récapitulatif) — masqué tant que le lot tourne.
            var summaryEl = document.createElement("div");
            summaryEl.style.cssText = "display:none;padding:8px 16px;border-top:1px solid #333;font-size:11px;text-align:center;line-height:1.5;";
            panel.appendChild(summaryEl);
            var footer = document.createElement("div");
            footer.style.cssText = "padding:10px 16px;border-top:1px solid #333;display:flex;justify-content:flex-end;";
            panel.appendChild(footer);
            document.body.appendChild(panel);
            var rows = {};
            // Compteurs du récapitulatif final (jamais un échec masqué) :
            // téléchargés / déjà présents / non téléchargeables / échecs, plus
            // la progression terminés/total.
            var stats = { total: 0, finished: 0, downloaded: 0, already: 0, noref: 0, failed: 0, state: "running" };
            function updateProgress() {
              countEl.textContent = t("wf.dlProgress", { done: stats.finished, total: stats.total });
              var pct = stats.total > 0 ? Math.round((stats.finished * 100) / stats.total) : 0;
              globalFill.style.width = pct + "%";
            }
            function renderSummary() {
              summaryEl.style.display = "block";
              summaryEl.style.color = stats.failed > 0 ? "#f87171" : (stats.noref > 0 ? "#fbbf24" : "#34d399");
              summaryEl.textContent = "\u2705 " + t("wf.dlDoneTitle") + " \u2014 " + t("wf.dlRecap", {
                downloaded: stats.downloaded,
                already: stats.already,
                noref: stats.noref,
                failed: stats.failed,
              });
            }
            updateProgress();
            return {
              panel: panel,
              addRow: function(fileName, sizeBytes, uploadId) {
                stats.total++;
                updateProgress();
                var sizeMB = sizeBytes > 0 ? (sizeBytes / 1048576).toFixed(1) + " MB" : "";
                var row = document.createElement("div");
                row.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:6px 8px;border-radius:6px;background:#2a2a2e;";
                var bar = document.createElement("div");
                bar.style.cssText = "flex:1;height:6px;background:rgba(255,255,255,0.1);border-radius:3px;overflow:hidden;";
                var fill = document.createElement("div");
                fill.style.cssText = "height:100%;width:0%;background:var(--aih-accent, #D8700D);border-radius:3px;transition:width 0.5s ease;";
                bar.appendChild(fill);
                var nameEl = document.createElement("span");
                nameEl.style.cssText = "font-size:12px;color:#ccc;min-width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;";
                nameEl.textContent = fileName;
                nameEl.title = fileName;
                var speedEl = document.createElement("span");
                speedEl.style.cssText = "font-size:10px;color:#888;min-width:55px;text-align:right;font-family:monospace;";
                speedEl.textContent = "0 MB/s";
                var sizeEl = document.createElement("span");
                sizeEl.style.cssText = "font-size:11px;color:#888;min-width:55px;text-align:right;";
                sizeEl.textContent = sizeMB;
                var statusEl = document.createElement("span");
                statusEl.style.cssText = "font-size:14px;min-width:20px;text-align:center;";
                statusEl.textContent = "\u23f3";
                row.appendChild(statusEl);
                row.appendChild(nameEl);
                row.appendChild(bar);
                row.appendChild(speedEl);
                row.appendChild(sizeEl);
                // Bouton d'annulation : le transfert tourne CÔTÉ SERVEUR (un
                // modèle de plusieurs Go) — sans ✕, l'utilisateur devrait
                // attendre la fin ou recharger la page, et le transfert
                // continuerait dans le vide. Masqué dès que la ligne est réglée.
                var cancelBtn = null;
                if (uploadId) {
                  cancelBtn = document.createElement("button");
                  cancelBtn.type = "button";
                  cancelBtn.className = "wf-dl-cancel";
                  cancelBtn.textContent = "\u2715";
                  cancelBtn.title = t("mb.cancelDownload");
                  cancelBtn.style.cssText = "flex-shrink:0;width:20px;height:20px;line-height:1;padding:0;border:1px solid #555;border-radius:4px;background:transparent;color:#aaa;font-size:11px;cursor:pointer;";
                  cancelBtn.onclick = (function(uid, btn) {
                    return function(e) {
                      e.stopPropagation();
                      btn.disabled = true;
                      btn.textContent = "\u2026";
                      // Route locale /api/aih/* → même brique que les
                      // transferts (aucun plafond client sur ce POST bref).
                      HolafFetch.request('/api/aih/models/download/cancel', {
                        method: 'POST',
                        body: { upload_id: uid },
                        timeout: 0,
                      }).catch(function() {});
                    };
                  })(uploadId, cancelBtn);
                  row.appendChild(cancelBtn);
                }
                body.appendChild(row);
                // Polling de progression
                var pollInterval = null;
                if (uploadId) {
                  pollInterval = setInterval(function() {
                    HolafFetch.request('/api/aih/models/download/progress?upload_id=' + encodeURIComponent(uploadId))
                      .then(function(p) {
                        if (!p || typeof p.percent !== 'number') return;
                        fill.style.width = p.percent + '%';
                        if (p.speed_mbs > 0) speedEl.textContent = p.speed_mbs + ' MB/s';
                      })
                      .catch(function(){});
                  }, 500);
                }
                rows[fileName] = { row: row, fill: fill, status: statusEl, speedEl: speedEl, pollInterval: pollInterval, settled: false, cancelBtn: cancelBtn };
              },
              setResult: function(fileName, success, errorMsg, kind) {
                var r = rows[fileName];
                if (!r || r.settled) return;
                r.settled = true;
                stats.finished++;
                if (r.pollInterval) { clearInterval(r.pollInterval); r.pollInterval = null; }
                if (r.cancelBtn) { r.cancelBtn.style.display = "none"; }
                if (success === 'skipped') {
                  // Non téléchargé (aucune référence serveur, déjà local, ou
                  // conservé) : état NEUTRE + raison explicite — jamais un faux
                  // succès ni un skip muet. `kind` distingue « non
                  // téléchargeable » (noref) de « déjà présent » (already).
                  if (kind === 'noref') stats.noref++; else stats.already++;
                  r.status.textContent = "\u23ed";
                  r.fill.style.background = "#6b7280";
                  r.fill.style.animation = "none";
                  r.fill.style.width = "100%";
                  r.row.style.background = "rgba(107,114,128,0.15)";
                  if (errorMsg) {
                    var skipEl = document.createElement("div");
                    skipEl.style.cssText = "font-size:10px;color:#cbd5e1;word-break:break-all;width:100%;margin-left:26px;";
                    skipEl.textContent = errorMsg;
                    r.row.appendChild(skipEl);
                  }
                } else if (success) {
                  stats.downloaded++;
                  r.status.textContent = "\u2705";
                  r.fill.style.background = "#16a34a";
                  r.fill.style.animation = "none";
                  r.fill.style.width = "100%";
                  r.row.style.background = "rgba(22,163,74,0.15)";
                } else {
                  stats.failed++;
                  r.status.textContent = "\u274c";
                  r.fill.style.background = "#dc2626";
                  r.fill.style.animation = "none";
                  r.fill.style.width = "100%";
                  r.row.style.background = "rgba(220,38,38,0.15)";
                  if (errorMsg) {
                    var errEl = document.createElement("div");
                    errEl.style.cssText = "font-size:10px;color:#f87171;word-break:break-all;width:100%;margin-left:26px;";
                    errEl.textContent = t("wf.errorPrefix") + errorMsg;
                    r.row.appendChild(errEl);
                  }
                }
                updateProgress();
                if (stats.state === "done") renderSummary();
              },
              done: function() {
                // État FINAL explicite : titre « Téléchargement terminé »,
                // récapitulatif chiffré toujours affiché (jamais masquer un
                // échec ni un non-téléchargeable) et bouton « Fermer ».
                if (stats.state !== "done") {
                  stats.state = "done";
                  panel.dataset.state = "done";
                  headerTitle.textContent = t("wf.dlDoneTitle");
                  renderSummary();
                  var closeBtn = document.createElement("button");
                  closeBtn.textContent = t("dialog.close");
                  closeBtn.style.cssText = "padding:6px 16px;border:1px solid #555;border-radius:6px;background:transparent;color:#999;font-size:12px;cursor:pointer;";
                  closeBtn.onclick = function() { panel.remove(); };
                  footer.appendChild(closeBtn);
                }
                return {
                  total: stats.total, finished: stats.finished,
                  downloaded: stats.downloaded, already: stats.already,
                  noref: stats.noref, failed: stats.failed,
                };
              },
              stats: function() {
                return {
                  total: stats.total, finished: stats.finished,
                  downloaded: stats.downloaded, already: stats.already,
                  noref: stats.noref, failed: stats.failed,
                };
              },
              close: function() { panel.remove(); }
            };
          }

          // ── Reboot prompt modal ──
          function showRebootPrompt() {
            var m = aihOpenModalV2({
              title: t("wf.rebootTitle"),
              width: "380px",
              height: "auto",
              minHeight: "auto",
              resizable: false,
              storageKey: null,
              content: '<p style="color:#aaa;font-size:13px;margin-bottom:16px;text-align:center;">' + t('wf.rebootMsg') + '</p>' +
                '<div style="display:flex;gap:8px;justify-content:center;">' +
                '<button id="reboot-cancel" style="padding:8px 16px;border:1px solid #555;border-radius:6px;background:transparent;color:#999;font-size:13px;cursor:pointer;">' + t('wf.later') + '</button>' +
                '<button id="reboot-now" style="padding:8px 16px;border:none;border-radius:6px;background:var(--aih-accent, #D8700D);color:#fff;font-size:13px;font-weight:600;cursor:pointer;">' + t('wf.reboot') + '</button>' +
                '</div>',
            });
            m.modal.querySelector("#reboot-cancel").onclick = function() { m.close(); };
            m.modal.querySelector("#reboot-now").onclick = function() {
              m.setBody('<div style="padding:20px;text-align:center;color:#fbbf24;font-size:13px;">' + t('wf.rebooting') + '</div>');
              setTimeout(function() { window.location.reload(); }, 500);
            };
          }

          // ── Conflict resolution modal ──
          function showConflictModal(fileName, localInfo, remoteInfo, localFilesFlat) {
            localFilesFlat = localFilesFlat || {};
            return new Promise(function(resolve) {
              var m = aihOpenModalV2({
                title: t("wf.conflictTitle"),
                width: "440px",
                height: "auto",
                minHeight: "auto",
                resizable: false,
                content: '<div style="font-size:13px;color:#ccc;margin-bottom:8px;">' + t('wf.conflictDesc') + '</div>' +
                  '<div style="background:#1a1a1e;padding:10px;border-radius:6px;margin-bottom:12px;font-size:12px;color:#aaa;font-family:monospace;">' +
                  '<div>📁 <b style="color:#e2e8f0;">' + esc(fileName) + '</b></div>' +
                  '<div style="margin-top:4px;">Local: ' + (localInfo.size/1048576).toFixed(1) + ' MB (' + (localInfo.path || t('wf.unknownPath')) + ')</div>' +
                  '<div>Server: ' + (remoteInfo.size/1048576).toFixed(1) + ' MB</div></div>' +
                  '<div style="display:flex;flex-direction:column;gap:8px;">' +
                  '<button id="conflict-overwrite" class="aih-btn-warning" style="padding:10px;border:1px solid #f59e0b;border-radius:6px;background:transparent;color:#f59e0b;font-size:13px;cursor:pointer;">' + t('wf.overwrite') + '</button>' +
                  '<button id="conflict-suffix" class="aih-btn-primary" style="padding:10px;border:1px solid var(--aih-accent, #D8700D);border-radius:6px;background:transparent;color:var(--aih-accent, #D8700D);font-size:13px;cursor:pointer;">' + t('wf.suffix') + '</button>' +
                  '<button id="conflict-keep" class="aih-btn-success" style="padding:10px;border:1px solid #34d399;border-radius:6px;background:transparent;color:#34d399;font-size:13px;cursor:pointer;">' + t('wf.keep') + '</button></div>',
              });
              m.modal.querySelector("#conflict-overwrite").onclick = function() {
                m.close();
                resolve({action: 'overwrite', newName: fileName});
              };
              m.modal.querySelector("#conflict-suffix").onclick = function() {
                var dotIdx = fileName.lastIndexOf('.');
                var base = dotIdx > 0 ? fileName.substring(0, dotIdx) : fileName;
                var ext = dotIdx > 0 ? fileName.substring(dotIdx) : '';
                var suffixName = base + '_2' + ext;
                var counter = 2;
                while (localFilesFlat[suffixName]) {
                  counter++;
                  suffixName = base + '_' + counter + ext;
                }
                m.close();
                resolve({action: 'suffix', newName: suffixName});
              };
              m.modal.querySelector("#conflict-keep").onclick = function() {
                m.close();
                resolve({action: 'keep', newName: fileName});
              };
            });
          }

          // ── Build model name map and apply to workflow ──
          function buildNameMap(allDeps, downloadResults) {
            var nameMap = {};
            for (var i = 0; i < allDeps.models.length; i++) {
              var m = allDeps.models[i];
              var dlPath = downloadResults[m.name];
              if (dlPath && dlPath !== m.name) nameMap[m.name] = dlPath;
            }
            for (var i = 0; i < allDeps.loras.length; i++) {
              var l = allDeps.loras[i];
              var dlPath = downloadResults[l.name];
              if (dlPath && dlPath !== l.name) nameMap[l.name] = dlPath;
            }
            return nameMap;
          }

          function applyNameMap(parsed, nameMap) {
            if (Object.keys(nameMap).length === 0) return;
            var allNodes = [];
            if (parsed.nodes) allNodes = allNodes.concat(parsed.nodes);
            if (parsed.definitions && parsed.definitions.subgraphs) {
              for (var si = 0; si < parsed.definitions.subgraphs.length; si++) {
                if (parsed.definitions.subgraphs[si].nodes) {
                  allNodes = allNodes.concat(parsed.definitions.subgraphs[si].nodes);
                }
              }
            }
            for (var ni = 0; ni < allNodes.length; ni++) {
              var node = allNodes[ni];
              if (!node.widgets_values) continue;
              for (var wi = 0; wi < node.widgets_values.length; wi++) {
                var val = node.widgets_values[wi];
                if (typeof val !== 'string') continue;
                if (nameMap[val]) {
                  node.widgets_values[wi] = nameMap[val];
                } else {
                  var basename = val.split('/').pop();
                  for (var origN in nameMap) {
                    if (origN === basename || origN.split('/').pop() === basename) {
                      node.widgets_values[wi] = nameMap[origN];
                      break;
                    }
                  }
                }
              }
            }
          }

          // ── Load button: install nodes → download models → adapt workflow → load ──
          detailBody.querySelector("#wf-load-btn").onclick = async function () {
            var statusEl = detailBody.querySelector("#wf-load-status");
            var loadBtn = detailBody.querySelector("#wf-load-btn");
            statusEl.style.display = "block";
            statusEl.style.color = "#fbbf24";
            loadBtn.disabled = true;
            loadBtn.style.opacity = "0.6";

            try {
              // 1. Download workflow JSON (téléchargement → raw:true, lecture inchangée)
              statusEl.textContent = t("wf.downloadingWorkflow");
              var resp = await remoteGet(getApiUrl() + "/workflows/" + workflowId + "/download", { raw: true });
              if (!resp.ok) {
                const txt = await resp.text().catch(() => "");
                let msg = "HTTP " + resp.status;
                try { const j = JSON.parse(txt); if (j.error) msg = j.error; } catch {}
                throw new Error(msg);
              }
              var data = await resp.json();
              if (data.error) throw new Error(data.error);
              var wfJson = data.workflow_json;
              var parsed = JSON.parse(wfJson);
              if (data.name) {
                if (!parsed.extra) parsed.extra = {};
                parsed.extra.title = data.name;
              }

              // 2. Install custom nodes (checked, PAS déjà installés)
              // Un pack DÉJÀ INSTALLÉ (même sous un alias : ComfyUI-AI-Helper
              // vs AI-Helper, .git, ssh/https, casse, dossier sans remote git…)
              // est SKIPPÉ — aucune tentative, aucune erreur. La détection est la
              // même que celle du badge rendu dans la liste (index normalisé
              // partagé). Récocher une case marquée `data-installed="1"`
              // = FORÇAGE explicite (on tente l'installation).
              var nodeCbs = detailBody.querySelectorAll('.wf-dep-cb[data-type="node"]:checked');
              var installedIndex = nodeCbs.length > 0 ? await getInstalledIndex() : null;
              var newNodesInstalled = 0;
              var nodesSkippedInstalled = 0;
              var nodesAlreadyOnServer = [];
              var nodesWithoutUrl = [];
              for (var ni = 0; ni < nodeCbs.length; ni++) {
                var ncb = nodeCbs[ni];
                var nurl = ncb.dataset.url;
                var nname = ncb.dataset.name;
                // `:checked` + data-installed="1" ⇒ l'utilisateur a RECOCHÉ un
                // node détecté installé ⇒ forçage : on ne le saute pas.
                var forced = ncb.dataset.installed === '1';
                // MÊME détection que le badge affiché : le signal « classes de
                // nodes » (node_types) fait partie de l'index. Il était OMIS ici
                // (seuls URL/dossier étaient testés) alors que le rendu, lui,
                // badge sur les classes → un pack reconnu uniquement par ses
                // classes était quand même installé (400 « already installed »).
                var ntypes = [];
                try { ntypes = JSON.parse(decodeURIComponent(ncb.dataset.nodeTypes || "")) || []; }
                catch (eNt) { ntypes = []; }
                if (!forced && nodeMatchesInstalledIndex(installedIndex, nname, nurl, ntypes)) {
                  nodesSkippedInstalled++;
                  // Détection d'installation ABSENTE au rendu (index en panne,
                  // pack apparu depuis…) mais POSITIVE au chargement : on
                  // RÉALIGNE l'UI sur l'état réel — case décochée + badge +
                  // raison — au lieu de laisser une case cochée pour un pack
                  // déjà installé (aucune tentative, aucun échec).
                  if (ncb.dataset.installed !== '1') markNodeInstalled(ncb);
                  console.log('[AIH] Node déjà installé, skip: ' + nname);
                  continue;
                }
                // Ni détecté installé, ni installable (aucune URL git) : message
                // clair, jamais une erreur brute ni un échec muet.
                if (!nurl) { nodesWithoutUrl.push(nname); continue; }
                statusEl.textContent = t("wf.installingNode", { i: (ni + 1), total: nodeCbs.length, name: esc(nname) });
                try {
                  var installData = await HolafFetch.request("/api/aih/custom-nodes/install", {
                    method: "POST",
                    body: {git_url: nurl, name: nname}
                  });
                  if (installData && installData.success === false && isAlreadyInstalledMessage(installData.message)) {
                    // Filet de sécurité : dossier déjà présent côté ComfyUI.
                    markNodeInstalled(ncb);
                    nodesAlreadyOnServer.push(nname);
                  } else if (installData && installData.success) {
                    newNodesInstalled++;
                  }
                } catch(e) {
                  var emsg = installErrorMessage(e);
                  if (isAlreadyInstalledMessage(emsg)) {
                    // FILET DE SÉCURITÉ : le serveur répond « Node 'X' already
                    // installed » (400) → skip bénin, la ligne passe en « déjà
                    // installé », AUCUNE erreur affichée.
                    markNodeInstalled(ncb);
                    nodesAlreadyOnServer.push(nname);
                    console.log('[AIH] Node ' + nname + ' déjà installé côté serveur — skip bénin');
                  } else {
                    // L'erreur RÉELLE (5xx, git clone impossible…) est remontée
                    // avec le message serveur exact — jamais un échec muet ni un
                    // « erreur serveur (statut 400) » générique.
                    console.warn("[AIH] Node install failed: " + nname, e);
                    aihToast(t("wf.nodeInstallFailed", { name: nname, error: emsg }), "error");
                  }
                }
              }
              if (nodesSkippedInstalled > 0) {
                console.log('[AIH] ' + nodesSkippedInstalled + ' custom node(s) déjà installé(s), non réinstallé(s)');
              }
              if (nodesAlreadyOnServer.length > 0) {
                // Message CLAIR et non bloquant : déjà présents, aucun échec.
                aihToast(t("wf.alreadyInstalledSummary", { count: nodesAlreadyOnServer.length, names: nodesAlreadyOnServer.join(', ') }), "info");
              }
              if (nodesWithoutUrl.length > 0) {
                aihToast(t("wf.nodesNoGitUrl", { count: nodesWithoutUrl.length, names: nodesWithoutUrl.join(', ') }), "error");
              }

              // 3. Collect models/loras to download (with local existence check)
              var cbs = detailBody.querySelectorAll(".wf-dep-cb:checked");
              var toDownload = [];
              var downloadResults = {};

              // Fetch all local model files for size comparison + conflict detection
              var localFiles = await getLocalModelFiles();
              var localBySize = {};
              var localFilesFlat = {};  // name → {name, path, size}
              for (var cat in localFiles) {
                for (var fi = 0; fi < localFiles[cat].length; fi++) {
                  var lf = localFiles[cat][fi];
                  if (!localBySize[lf.size]) localBySize[lf.size] = [];
                  localBySize[lf.size].push(lf);
                  localFilesFlat[lf.name] = lf;
                }
              }
              // Helper: compute fingerprint of a local file via Python
              async function getLocalFingerprint(path) {
                try {
                  return await HolafFetch.request('/api/aih/models/fingerprint', {
                    method: 'POST',
                    body: { path: path }
                  });
                } catch(e) { return null; }
              }
              var skippedDeps = [];  // deps cochées mais NON téléchargées : {name, kind, reason}
              for (var i = 0; i < cbs.length; i++) {
                var cb = cbs[i];
                var dtype = cb.dataset.type;
                var origName = cb.dataset.name;
                var uploadId = cb.dataset.uploadId;
                if (dtype !== 'model' && dtype !== 'lora') continue;
                var modelType = dtype === 'lora' ? 'lora' : (cb.dataset.modelType || 'model');
                // Dernier filet : si le rendu n'a pas pu résoudre la référence
                // par nom (liste distante momentanément indisponible), on
                // retente ICI avant de déclarer l'entrée non téléchargeable.
                if (!uploadId) {
                  var lateRef = await resolveRemoteUploadId({ name: origName, type: modelType, size: 0 });
                  if (lateRef && lateRef.upload_id) {
                    uploadId = lateRef.upload_id;
                    cb.dataset.uploadId = uploadId;
                  }
                }
                // Référence serveur TOUJOURS absente (upload_id manquant) :
                // l'entrée est listée dans le workflow mais n'est PAS
                // téléchargeable. On le DIT explicitement — plus jamais de
                // skip silencieux (cause « 8 annoncés / 6 téléchargés »).
                if (!uploadId) {
                  skippedDeps.push({ name: origName, kind: 'noref', reason: t('wf.depSkippedNoRef') });
                  continue;
                }
                var depDiv = cb.closest('div');
                var pathInput = depDiv ? depDiv.querySelector('.wf-dep-path') : null;
                var newPath = pathInput ? pathInput.value.trim() : origName;
                if (!newPath) newPath = origName;

                // Get server fingerprint + size for this upload
                var serverFp = null;
                try {
                  serverFp = await remoteGet(getApiUrl() + '/files/' + uploadId + '/fingerprint');
                } catch(e) {}
                var depSize = serverFp ? (serverFp.size || 0) : 0;

                // Check if a local file with the same size already exists, then verify by fingerprint
                var alreadyLocal = false;
                var alreadyLocalName = origName;
                if (depSize > 0 && localBySize[depSize]) {
                  var candidates = localBySize[depSize];
                  for (var ci = 0; ci < candidates.length; ci++) {
                    var match = false;
                    if (serverFp && serverFp.head && serverFp.tail) {
                      // Full fingerprint comparison: compute local fingerprint via Python
                      var localFp = await getLocalFingerprint(candidates[ci].path);
                      if (localFp && localFp.head === serverFp.head && localFp.tail === serverFp.tail) {
                        match = true;
                        console.log('[AIH] Fingerprint match: ' + origName + ' = ' + candidates[ci].name);
                      }
                    } else {
                      // No server fingerprint — fallback to size match only
                      match = true;
                      console.log('[AIH] Size match (no server fingerprint): ' + origName + ' = ' + candidates[ci].name);
                    }
                    if (match) {
                      alreadyLocal = true;
                      alreadyLocalName = candidates[ci].name;
                      downloadResults[origName] = candidates[ci].name;
                      break;
                    }
                  }
                }
                if (alreadyLocal) {
                  skippedDeps.push({ name: origName, kind: 'already', reason: t('wf.depSkippedAlreadyLocal', { name: alreadyLocalName }) });
                  continue;
                }

                // Check for name conflict: a local file with the same name exists but different content
                if (localFilesFlat[newPath]) {
                  var localFile = localFilesFlat[newPath];
                  var isDifferent = true;
                  // If we have server fingerprint, verify
                  if (serverFp && serverFp.head && serverFp.tail) {
                    var localFp2 = await getLocalFingerprint(localFile.path);
                    if (localFp2 && localFp2.head === serverFp.head && localFp2.tail === serverFp.tail) {
                      isDifferent = false;  // Same content, already handled above
                    }
                  }
                  if (isDifferent) {
                    // Conflict! Ask the user
                    statusEl.textContent = t("wf.resolvingConflict", { name: esc(newPath) });
                    var conflictResult = await showConflictModal(newPath,
                      {size: localFile.size, path: localFile.name},
                      {size: depSize},
                      localFilesFlat
                    );
                    if (conflictResult.action === 'keep') {
                      // Skip download, use local file
                      downloadResults[origName] = newPath;
                      skippedDeps.push({ name: origName, kind: 'already', reason: t('wf.depSkippedKept') });
                      console.log('[AIH] Conflict resolved: keep local for ' + origName);
                      continue;
                    } else if (conflictResult.action === 'suffix') {
                      newPath = conflictResult.newName;
                      console.log('[AIH] Conflict resolved: suffix → ' + newPath);
                    }
                    // If 'overwrite', keep newPath as is
                  }
                }

                toDownload.push({
                  upload_id: uploadId, origName: origName, newName: newPath,
                  type: modelType,
                });
                downloadResults[origName] = newPath;
              }

              // 4. Download models with progress panel (parallel)
              // Le panneau liste TOUTES les deps cochées : celles réellement
              // téléchargées ET celles NON téléchargées (raison visible). Le
              // compteur reflète le nombre réel de téléchargements.
              if (toDownload.length > 0 || skippedDeps.length > 0) {
                if (toDownload.length > 0) {
                  statusEl.textContent = t("wf.downloadingModels", { count: toDownload.length })
                    + (skippedDeps.length ? t("wf.depsSkippedSuffix", { count: skippedDeps.length }) : "");
                } else {
                  statusEl.textContent = t("wf.depsNoneDownloadable", { count: skippedDeps.length });
                }
                var dlPanel = createDownloadPanel(t("wf.downloadingTitle"));
                // Downloads sequentiels par batches de 2 pour ne pas saturer SFTP
                var MAX_PARALLEL = 2;
                var dlQueue = toDownload.slice();
                var dlActive = 0;

                // TOUTES les lignes sont ajoutées AVANT tout résultat (non
                // téléchargées D'ABORD, puis téléchargements en attente) : la
                // progression globale « N/M » est donc exacte dès l'ouverture.
                for (var si2 = 0; si2 < skippedDeps.length; si2++) {
                  dlPanel.addRow(skippedDeps[si2].name, 0, null);
                }
                for (var di = 0; di < dlQueue.length; di++) {
                  dlPanel.addRow(dlQueue[di].newName, 0, dlQueue[di].upload_id);
                }
                // Puis l'état (raison explicite) des non téléchargées — chaque
                // ligne porte sa raison, jamais un skip muet.
                for (var si3 = 0; si3 < skippedDeps.length; si3++) {
                  dlPanel.setResult(skippedDeps[si3].name, 'skipped', skippedDeps[si3].reason,
                                    skippedDeps[si3].kind || 'already');
                }

                function startNext() {
                  while (dlActive < MAX_PARALLEL && dlQueue.length > 0) {
                    var item = dlQueue.shift();
                    dlActive++;
                    (function(it) {
                      HolafFetch.request('/api/aih/models/download', {
                        method: 'POST',
                        body: {
                          upload_id: it.upload_id,
                          filename: it.origName,
                          type: it.type,
                          dest_path: it.newName,
                        },
                        // Install d'un workflow : les modèles peuvent peser
                        // plusieurs Go → pas de plafond client de 30 s.
                        timeout: 0,
                      }).then(function(result) {
                        if (!result.success && !result.error) {
                          result.error = t('wf.unknownError');
                        }
                        dlPanel.setResult(it.newName, result.success, result.error);
                        return result;
                      }).catch(function(e) {
                        dlPanel.setResult(it.newName, false, e.message);
                        return { success: false, error: e.message };
                      }).then(function() {
                        dlActive--;
                        startNext();
                      });
                    })(item);
                  }
                }
                startNext();
                // Attendre que tous les downloads soient termines. try/finally :
                // une exception entre l'ouverture du panneau et la fin ne doit
                // JAMAIS laisser la fenêtre figée en « en cours » (l'état final
                // « Terminé » + récap doit toujours être posé).
                try {
                  await new Promise(function(resolve) {
                    var checkDone = setInterval(function() {
                      if (dlActive === 0 && dlQueue.length === 0) {
                        clearInterval(checkDone);
                        resolve();
                      }
                    }, 500);
                  });
                } finally {
                  dlPanel.done();
                }
                var dlStats = dlPanel.stats();
                // Récapitulatif final AUSSI en toast si des échecs réels sont
                // survenus : jamais d'échec visible uniquement dans un panneau
                // qu'on peut fermer.
                if (dlStats.failed > 0) {
                  aihToast(t('wf.dlRecapToast', {
                    downloaded: dlStats.downloaded,
                    already: dlStats.already,
                    noref: dlStats.noref,
                    failed: dlStats.failed,
                  }), 'error');
                }
              }

              // Résumé explicite des déps non téléchargées (toast) : même quand
              // aucun download n'a été lancé, l'utilisateur est informé.
              if (skippedDeps.length > 0) {
                aihToast(t('wf.depsSkippedToast', {
                  count: skippedDeps.length,
                  names: skippedDeps.map(function (s) { return s.name; }).join(', '),
                }), 'info');
              }

              // 5. Always verify and adapt model names in workflow
              statusEl.textContent = t("wf.adaptingWorkflow");
              var nameMap = buildNameMap(allDeps, downloadResults);
              applyNameMap(parsed, nameMap);

              // 6. Load into ComfyUI (only after models are downloaded)
              statusEl.textContent = t("wf.loadingIntoComfy");
              var currentApp = getApp();
              if (currentApp && currentApp.loadGraphData) {
                currentApp.loadGraphData(parsed).then(function () {
                  statusEl.style.color = "#34d399";
                  statusEl.textContent = t("wf.loaded");
                  setTimeout(function () { _dm.close(); }, 1500);
                  if (newNodesInstalled > 0) {
                    setTimeout(function() { showRebootPrompt(); }, 1600);
                  }
                }).catch(function (err) {
                  statusEl.style.color = "#f87171";
                  statusEl.textContent = t("wf.errorPrefixColon") + err.message;
                  loadBtn.disabled = false;
                  loadBtn.style.opacity = "1";
                });
              } else if (currentApp && currentApp.graph) {
                currentApp.graph.clear();
                currentApp.loadGraphData(parsed);
                statusEl.style.color = "#34d399";
                statusEl.textContent = t("wf.loaded");
                setTimeout(function () { _dm.close(); }, 1500);
                if (newNodesInstalled > 0) {
                  setTimeout(function() { showRebootPrompt(); }, 1600);
                }
              } else {
                navigator.clipboard.writeText(JSON.stringify(parsed)).then(function () {
                  statusEl.style.color = "#fbbf24";
                  statusEl.textContent = t("wf.copiedClipboard");
                }).catch(function () {
                  statusEl.style.color = "#f87171";
                  statusEl.textContent = t("wf.cannotLoad");
                });
              }
            } catch (e) {
              statusEl.style.color = "#f87171";
              statusEl.textContent = "\u274c " + e.message;
              loadBtn.disabled = false;
              loadBtn.style.opacity = "1";
            }
          };
        })
        .catch(function () {
          detailBody.innerHTML = '<p style="color:#f87171;font-size:13px;text-align:center;padding:30px 0;">' + t('wf.loadError') + '</p>';
        });
    };

    render();
  };
})();
