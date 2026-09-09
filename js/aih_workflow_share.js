import "./aih_dialog.js";
import "./aih_strings.js";
import { makeDraggable } from "./holaf_window_utils.js";
import { showToast as bridgeShowToast, updateToast as bridgeUpdateToast, hideToast as bridgeHideToast } from "./aih_toast_bridge.js";
import { remoteGet, remotePost, remoteDelete, HolafFetch } from "./aih_fetch_bridge.js";

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

  // ── Helpers ──

  function getApp() {
    return window.app || window.comfyAPI?.app?.app;
  }

  function getApiUrl() {
    // Aucune URL par défaut codée en dur : chaîne vide si le serveur n'est
    // pas configuré (les points d'entrée vérifient via ensureServerConfigured).
    try {
      var cfg = JSON.parse(localStorage.getItem("AIH_config") || "{}");
      var base = (cfg.serverUrl || "").replace(/\/+$/, "");
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

    var timer = setInterval(function() {
      // Mettre a jour le temps ecoule pour les uploads en cours
      for (var fn in rows) {
        var r = rows[fn];
        if (r.status.textContent === "⏳") {
          var elapsed = ((Date.now() - r.startTime) / 1000).toFixed(1);
          var mbps = (r.sizeBytes / 1048576 / elapsed).toFixed(1); r.speedEl.textContent = mbps + " MB/s";
        }
      }
    }, 500);

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
        // Speed (mis a jour via polling)
        var speedEl = document.createElement("span");
        speedEl.style.cssText = "font-size:10px;color:#888;min-width:55px;text-align:right;font-family:monospace;";
        speedEl.textContent = "0 MB/s";
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

        // Polling de progression toutes les 500ms
        var pollInterval = null;
        if (filepath) {
          pollInterval = setInterval(function() {
            HolafFetch.request('/api/aih/models/upload/progress?path=' + encodeURIComponent(filepath))
              .then(function(p) {
                if (!p || typeof p.percent !== 'number') return;
                fill.style.width = p.percent + '%';
                if (p.speed_mbs > 0) {
                  speedEl.textContent = p.speed_mbs + ' MB/s';
                }
              })
              .catch(function(){});
          }, 500);
        }
        rows[fileName] = { row: row, fill: fill, status: statusEl, startTime: Date.now(), speedEl: speedEl, sizeBytes: sizeBytes, pollInterval: pollInterval };
      },
      setResult: function(fileName, success, errorMsg) {
        var r = rows[fileName];
        if (!r) return;
        if (r.pollInterval) { clearInterval(r.pollInterval); r.pollInterval = null; }
        doneCount++;
        var elapsed = (Date.now() - r.startTime) / 1000;
        var speed = (r.sizeBytes / 1048576 / elapsed).toFixed(1);
        r.speedEl.textContent = speed + " MB/s";
        if (success) {
          r.status.textContent = "✅";
          r.fill.style.background = "#16a34a";
          r.fill.style.width = "100%";
          r.row.style.background = "rgba(22,163,74,0.15)";
        } else {
          r.status.textContent = "❌";
          r.fill.style.background = "#dc2626";
          r.fill.style.width = "100%";
          r.row.style.background = "rgba(220,38,38,0.15)";
          var errEl = document.createElement("div");
          errEl.style.cssText = "font-size:10px;color:#f87171;word-break:break-all;width:100%;margin-left:26px;";
          errEl.textContent = t("wf.errorPrefix") + (errorMsg || t("aih.unknown"));
          r.row.appendChild(errEl);
        }
        m.setTitle(t("wf.uploadProgress", { done: doneCount, total: totalCount }));
      },
      done: function() {
        clearInterval(timer);
        var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        m.setTitle(t("wf.uploadDone", { count: totalCount, seconds: elapsed }));
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

  async function getInstalledCustomNodes() {
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
      return [];
    }
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

  async function uploadModelToServer(filepath, fileType) {
    // Demande au Python d'uploader le fichier directement depuis le filesystem
    try {
      return await HolafFetch.request('/api/aih/models/upload', {
        method: 'POST',
        body: { path: filepath, type: fileType }
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
      return await HolafFetch.request('/api/aih/models/download', { method: 'POST', body: body });
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
        '</div>';

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

      // Vérifier si un workflow du même nom existe déjà
      function checkExisting(name) {
        remoteGet(getApiUrl() + "/workflows?q=" + encodeURIComponent(name) + "&limit=5")
          .then(function (data) {
            var items = data?.items || [];
            return remoteGet(getApiUrl() + "/auth/me")
              .then(function (me) {
                if (!me || typeof me.id !== 'string') return;
                for (var i = 0; i < items.length; i++) {
                  if (items[i].name.toLowerCase() === name.toLowerCase() && items[i].user_id === me.id) {
                    existingId = items[i].id;
                    var btn = container.querySelector("#wf-publish-btn");
                    btn.textContent = t("wf.update", { version: (items[i].version + 1) });
                    btn.style.background = "#f59e0b";
                    return;
                  }
                }
                existingId = null;
                var btn = container.querySelector("#wf-publish-btn");
                btn.textContent = t("wf.publish");
                btn.style.background = "var(--aih-accent, #D8700D)";
              });
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

          var uploadedCount = 0, failedCount = 0;
          var panel = createUploadPanel();

          // Upload en parallele
          var uploadPromises = [];
          for (var ui = 0; ui < uploadCbs.length; ui++) {
            (function(cb) {
              var fileType = cb.dataset.type;
              var fileName = cb.dataset.name;
              var localFile = allFilesMap[fileName];
              if (!localFile && fileName.indexOf('/') >= 0) {
                var base = fileName.substring(fileName.lastIndexOf('/') + 1);
                localFile = allFilesMap[base];
              }
              if (!localFile) {
                console.warn('[AIH] Non trouve localement: ' + fileName);
                return;
              }
              panel.addRow(fileName, localFile.size, localFile.path);
              uploadPromises.push(
                uploadModelToServer(localFile.path, fileType).then(function(upResult) {
                  if (upResult.success) {
                    console.log('[AIH] Upload OK: ' + fileName);
                    var depArray = fileType === 'lora' ? deps.loras : deps.models;
                    for (var di = 0; di < depArray.length; di++) {
                      if (depArray[di].name === fileName) {
                        depArray[di].upload_id = upResult.upload_id;
                        depArray[di].file_path = upResult.file_path;
                        break;
                      }
                    }
                    uploadedCount++;
                    panel.setResult(fileName, true);
                  } else {
                    console.error('[AIH] Upload FAIL: ' + fileName + ' → ' + (upResult.error || 'echec'));
                    failedCount++;
                    panel.setResult(fileName, false, upResult.error);
                  }
                })
              );
            })(uploadCbs[ui]);
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
            var author = w.author || w.user_id || "?";
            var depsCount = (w.required_nodes?.length || 0) + (w.required_models?.length || 0) + (w.required_loras?.length || 0);
            var delHtml =
              '<button class="wf-del-btn" data-wf-id="' + w.id + '" data-wf-name="' + esc(w.name) + '" onclick="event.stopPropagation();window._wfDeleteWorkflow(this)" style="position:absolute;top:4px;right:4px;width:22px;height:22px;border:1px solid #555;border-radius:4px;background:rgba(60,60,64,0.9);color:#f87171;font-size:11px;cursor:pointer;padding:0;line-height:20px;text-align:center;z-index:2;display:none;">🗑</button>';
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
            '<p style="font-size:12px;color:#888;margin:0;">' + t('wf.by') + esc(w.author || w.user_id) + ' · v' + (w.version || 1) +
            ' · ❤️ ' + (w.likes || 0) + ' · 📥 ' + (w.downloads || 0) + '</p>' +
            (w.description ? '<p style="font-size:12px;color:#aaa;margin:8px 0 0 0;">' + esc(w.description) + '</p>' : '') +
            '</div>' +
            '<div id="wf-install-deps" style="margin-bottom:12px;"></div>' +
            '<div style="display:flex;gap:8px;">' +
            '<button id="wf-load-btn" style="flex:1;padding:10px;border:none;border-radius:6px;background:var(--aih-accent, #D8700D);color:#fff;font-size:13px;font-weight:600;cursor:pointer;">' + t('wf.loadWorkflow') + '</button>' +
            '<button id="wf-close-btn" style="padding:10px 16px;border:1px solid #555;border-radius:6px;background:transparent;color:#999;font-size:13px;cursor:pointer;">' + t('dialog.close') + '</button></div>' +
            '<div id="wf-load-status" style="font-size:11px;color:#888;display:none;margin-top:8px;"></div>';

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
                // Check which custom node packs are already installed (by git_url)
                var installedNodes = await getInstalledCustomNodes();
                var installedUrls = {};
                for (var k = 0; k < installedNodes.length; k++) {
                  if (installedNodes[k].git_url) {
                    installedUrls[installedNodes[k].git_url] = true;
                  }
                }
                depHtml += '<div style="background:#3a3a3e;padding:6px 10px;border-bottom:1px solid #444;"><span style="font-size:11px;color:#f59e0b;font-weight:600;">' + t('wf.customNodesHeader') + '</span></div>';
                for (var i = 0; i < allDeps.nodes.length; i++) {
                  var n = allDeps.nodes[i];
                  var nodeCount = n.node_types ? n.node_types.length : 1;
                  var installed = n.url && installedUrls[n.url];
                  depHtml += '<label style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid #3a3a3e;cursor:pointer;font-size:12px;color:' + (installed ? '#34d399' : '#ccc') + ';">' +
                    '<input type="checkbox" class="wf-dep-cb" checked data-type="node" data-name="' + esc(n.name) + '" data-url="' + esc(n.url || '') + '" style="accent-color:var(--aih-accent, #D8700D);">' +
                    '<span style="flex:1;">' + esc(n.name) +
                    (nodeCount > 1 ? ' (' + t('wf.nodeCount', { count: nodeCount }) + ') ' : '') +
                    (installed ? t('wf.alreadyInstalled') : '') + '</span>' +
                    (n.url && !installed ? '<button onclick="window._wfInstallNode(\'' + esc(n.url) + '\', \'' + esc(n.name) + '\', this)" style="padding:2px 8px;border:1px solid #555;border-radius:3px;background:#4a4a4e;color:#ccc;font-size:10px;cursor:pointer;">' + t('wf.install') + '</button>' : '') +
                    (n.url ? '<a href="' + esc(n.url) + '" target="_blank" style="color:var(--aih-accent, #D8700D);text-decoration:none;font-size:11px;" onclick="event.stopPropagation();">🔗</a>' : '') +
                    '</label>';
                }
              }
              if (allDeps.models.length) {
                if (allDeps.nodes.length) depHtml += '<div style="border-top:1px solid #444;"></div>';
                depHtml += '<div style="background:#3a3a3e;padding:6px 10px;border-bottom:1px solid #444;"><span style="font-size:11px;color:var(--aih-accent, #D8700D);font-weight:600;">' + t('wf.models') + '</span></div>';
                for (var i = 0; i < allDeps.models.length; i++) {
                  var m = allDeps.models[i];
                  var installed = localModels.indexOf(m.name) >= 0;
                  var hasFile = !!m.upload_id;
                  depHtml += '<div style="padding:6px 10px;border-bottom:1px solid #3a3a3e;font-size:12px;color:' + (installed ? '#34d399' : '#ccc') + ';">' +
                    '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
                    '<input type="checkbox" class="wf-dep-cb"' + (installed ? '' : ' checked') + ' data-type="model" data-model-type="' + esc(m.type || 'model') + '" data-name="' + esc(m.name) + '" ' + (hasFile ? 'data-upload-id="' + esc(m.upload_id) + '"' : '') + ' style="accent-color:var(--aih-accent, #D8700D);">' +
                    '<span style="flex:1;">' + esc(m.name) + (installed ? t('wf.alreadyInstalled') : '') + '</span>' +
                    '<span style="font-size:10px;color:#666;">' + (m.type || t('wf.modelType')) + '</span></label>';
                  if (!installed && hasFile) {
                    var typeToFolder = {'checkpoint':'checkpoints','lora':'loras','vae':'vae','clip':'clip','clip_vision':'clip_vision','controlnet':'controlnet','unet':'unet','unet_gguf':'unet_gguf','upscale':'upscale_models','gligen':'gligen','hypernetwork':'hypernetworks','text_encoder':'text_encoders','style_model':'style_models','model':'checkpoints'};
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
                for (var i = 0; i < allDeps.loras.length; i++) {
                  var l = allDeps.loras[i];
                  var installed = localLoras.indexOf(l.name) >= 0;
                  var hasFile = !!l.upload_id;
                  depHtml += '<div style="padding:6px 10px;border-bottom:1px solid #3a3a3e;font-size:12px;color:' + (installed ? '#34d399' : '#ccc') + ';">' +
                    '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
                    '<input type="checkbox" class="wf-dep-cb"' + (installed ? '' : ' checked') + ' data-type="lora" data-name="' + esc(l.name) + '" ' + (hasFile ? 'data-upload-id="' + esc(l.upload_id) + '"' : '') + ' style="accent-color:var(--aih-accent, #D8700D);">' +
                    '<span style="flex:1;">' + esc(l.name) + (installed ? t('wf.alreadyInstalled') : '') + '</span></label>';
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
          })
          .catch(function () {
            detailBody.innerHTML = '<p style="color:#f87171;font-size:13px;text-align:center;padding:30px 0;">' + t('wf.loadError') + '</p>';
          });

// Install custom node (global for onclick)
          window._wfInstallNode = async function(gitUrl, nodeName, btn) {
            if (!gitUrl) { aihToast(t("wf.noGitUrlMsg"), "error"); return; }
            btn.textContent = t("wf.cloning");
            btn.disabled = true;
            var toast = aihToast(t("wf.installing", { name: nodeName }), "progress");
            try {
              var data = await HolafFetch.request("/api/aih/custom-nodes/install", {
                method: "POST",
                body: {git_url: gitUrl, name: nodeName}
              });
              if (data.success) {
                btn.textContent = t("wf.installed");
                btn.style.color = "#34d399";
                btn.style.borderColor = "#34d399";
                aihToastDone(toast, "success", t("wf.installedMsg", { name: nodeName }));
              } else {
                btn.textContent = "❌";
                btn.style.color = "#f87171";
                aihToastDone(toast, "error", "❌ " + (data.message || t("aih.failed")));

              }
            } catch (e) {
              btn.textContent = "❌";
              btn.style.color = "#f87171";
              aihToastDone(toast, "error", "❌ " + e.message);

            }
          };

          // ── Download progress panel (reused for install) ──
          function createDownloadPanel(title) {
            var panel = document.createElement("div");
            panel.style.cssText = "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1e1e24;border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,0.6);width:440px;max-height:70vh;z-index:100001;display:flex;flex-direction:column;overflow:hidden;";
            var header = document.createElement("div");
            header.style.cssText = "padding:12px 16px;border-bottom:1px solid #333;font-size:14px;font-weight:600;color:#e2e8f0;cursor:grab;user-select:none;";
            header.textContent = title || t("wf.downloadTitle");
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
            var footer = document.createElement("div");
            footer.style.cssText = "padding:10px 16px;border-top:1px solid #333;display:flex;justify-content:flex-end;";
            panel.appendChild(footer);
            document.body.appendChild(panel);
            var rows = {};
            return {
              panel: panel,
              addRow: function(fileName, sizeBytes, uploadId) {
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
                rows[fileName] = { row: row, fill: fill, status: statusEl, speedEl: speedEl, pollInterval: pollInterval };
              },
              setResult: function(fileName, success, errorMsg) {
                var r = rows[fileName];
                if (!r) return;
                if (r.pollInterval) { clearInterval(r.pollInterval); r.pollInterval = null; }
                if (success) {
                  r.status.textContent = "\u2705";
                  r.fill.style.background = "#16a34a";
                  r.fill.style.animation = "none";
                  r.fill.style.width = "100%";
                  r.row.style.background = "rgba(22,163,74,0.15)";
                } else {
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
              },
              done: function() {
                var closeBtn = document.createElement("button");
                closeBtn.textContent = t("dialog.close");
                closeBtn.style.cssText = "padding:6px 16px;border:1px solid #555;border-radius:6px;background:transparent;color:#999;font-size:12px;cursor:pointer;";
                closeBtn.onclick = function() { panel.remove(); };
                footer.appendChild(closeBtn);
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

              // 2. Install custom nodes (checked, not already installed)
              var nodeCbs = detailBody.querySelectorAll('.wf-dep-cb[data-type="node"]:checked');
              var newNodesInstalled = 0;
              for (var ni = 0; ni < nodeCbs.length; ni++) {
                var ncb = nodeCbs[ni];
                var nurl = ncb.dataset.url;
                var nname = ncb.dataset.name;
                if (!nurl) continue;
                statusEl.textContent = t("wf.installingNode", { i: (ni + 1), total: nodeCbs.length, name: esc(nname) });
                try {
                  var installData = await HolafFetch.request("/api/aih/custom-nodes/install", {
                    method: "POST",
                    body: {git_url: nurl, name: nname}
                  });
                  if (installData.success) newNodesInstalled++;
                } catch(e) {
                  console.warn("[AIH] Node install failed: " + nname, e);
                }
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
              for (var i = 0; i < cbs.length; i++) {
                var cb = cbs[i];
                var dtype = cb.dataset.type;
                var origName = cb.dataset.name;
                var uploadId = cb.dataset.uploadId;
                if (!uploadId || (dtype !== 'model' && dtype !== 'lora')) continue;
                var depDiv = cb.closest('div');
                var pathInput = depDiv ? depDiv.querySelector('.wf-dep-path') : null;
                var newPath = pathInput ? pathInput.value.trim() : origName;
                if (!newPath) newPath = origName;
                var modelType = dtype === 'lora' ? 'lora' : (cb.dataset.modelType || 'model');

                // Get server fingerprint + size for this upload
                var serverFp = null;
                try {
                  serverFp = await remoteGet(getApiUrl() + '/files/' + uploadId + '/fingerprint');
                } catch(e) {}
                var depSize = serverFp ? (serverFp.size || 0) : 0;

                // Check if a local file with the same size already exists, then verify by fingerprint
                var alreadyLocal = false;
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
                      downloadResults[origName] = candidates[ci].name;
                      break;
                    }
                  }
                }
                if (alreadyLocal) continue;

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
              if (toDownload.length > 0) {
                statusEl.textContent = t("wf.downloadingModels", { count: toDownload.length });
                var dlPanel = createDownloadPanel(t("wf.downloadingTitle"));
                // Downloads sequentiels par batches de 2 pour ne pas saturer SFTP
                var MAX_PARALLEL = 2;
                var dlQueue = toDownload.slice();
                var dlActive = 0;

                // Afficher toutes les lignes immediatement (meme en attente)
                for (var di = 0; di < dlQueue.length; di++) {
                  dlPanel.addRow(dlQueue[di].newName, 0, dlQueue[di].upload_id);
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
                        }
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
                // Attendre que tous les downloads soient termines
                await new Promise(function(resolve) {
                  var checkDone = setInterval(function() {
                    if (dlActive === 0 && dlQueue.length === 0) {
                      clearInterval(checkDone);
                      resolve();
                    }
                  }, 500);
                });
                dlPanel.done();
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
