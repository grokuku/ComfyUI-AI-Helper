import "./aih_dialog.js";
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ComfyUI class key of this node. The legacy pre-rename alias was removed
// from the Python registry (user decision): one key per node, so the Add Node
// search lists it once. Old workflows referencing it must be redone.
const NODE_TYPES = ["AIHLoadImageVideo"];

// ── Upload helper (used both by file input and clipboard paste) ──
async function uploadFileAndSetWidget(node, file, uploadButton) {
    const widget = node.widgets.find(w => w.name === "media_file");
    if (!widget) return;
    const formData = new FormData();
    formData.append("image", file);
    formData.append("overwrite", "true");
    try {
        if (uploadButton) uploadButton.textContent = "⏳ Uploading...";
        const resp = await api.fetchApi("/upload/image", { method: "POST", body: formData });
        if (resp.status === 200) {
            const data = await resp.json();
            if (!widget.options.values.includes(data.name)) widget.options.values.push(data.name);
            widget.value = data.name;
            widget.callback?.(data.name);
        } else {
            await window.AIH.alert("Upload", `Upload failed: ${resp.status}`, "error");
        }
    } catch (err) {
        await window.AIH.alert("Upload", `Error: ${err.message}`, "error");
    } finally {
        if (uploadButton) uploadButton.textContent = "📤 Upload Image/Video";
    }
}

app.registerExtension({
    name: "AIH.LoadImageVideo",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (NODE_TYPES.includes(nodeData.name)) {

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                const node = this;
                const widget = node.widgets.find(w => w.name === "media_file");
                
                // 1. Conteneur principal — pointer-events: none pour que le clic droit
                //    (menu contextuel standard de ComfyUI) traverse vers le canvas.
                const mainContainer = document.createElement("div");
                Object.assign(mainContainer.style, {
                    width: "100%",
                    display: "flex",
                    flexDirection: "column",
                    gap: "5px",
                    pointerEvents: "none"
                });

                // 2. Le conteneur du preview — flex:1 + pointer-events:none
                //    pour que le clic droit traverse jusqu'au canvas LiteGraph.
                const previewContainer = document.createElement("div");
                Object.assign(previewContainer.style, {
                    width: "100%",
                    flex: "1 1 auto",
                    minHeight: "50px",
                    backgroundColor: "rgba(0,0,0,0.2)",
                    borderRadius: "4px",
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                    overflow: "hidden",
                    pointerEvents: "none"
                });

                // 3. Le bouton — pointer-events: auto pour rester cliquable
                const uploadButton = document.createElement("button");
                uploadButton.textContent = "📤 Upload Image/Video";
                Object.assign(uploadButton.style, {
                    width: "100%",
                    padding: "5px",
                    fontSize: "inherit",
                    backgroundColor: "#333",
                    color: "#fff",
                    border: "1px solid #555",
                    borderRadius: "4px",
                    cursor: "pointer",
                    pointerEvents: "auto"
                });

                // On assemble la structure : Preview en haut, Bouton en bas
                mainContainer.appendChild(previewContainer);
                mainContainer.appendChild(uploadButton);

                // On injecte le tout dans UN SEUL widget DOM.
                // Note : addDOMWidget crée un wrapper autour de mainContainer.
                // Ce wrapper DOIT aussi avoir pointer-events: none sinon il bloque
                // le clic droit (menu Firefox au lieu du menu LiteGraph).
                const domWidgetIdx = node.addDOMWidget("holaf_media_loader", "div", mainContainer, {
                    serialize: false,
                    hideOnZoom: false
                });
                const domWidget = (typeof domWidgetIdx === 'number')
                    ? node.widgets[domWidgetIdx]
                    : node.widgets.find(w => w.name === "holaf_media_loader");

                // Attendre que le wrapper DOM soit monté, puis forcer pointer-events: none
                requestAnimationFrame(() => {
                    const wrapper = mainContainer.parentElement;
                    if (wrapper) wrapper.style.pointerEvents = "none";
                });

                // Le conteneur DOM doit suivre la taille du nœud.
                const applyHeight = () => {
                    const titleBar = LiteGraph.NODE_TITLE_HEIGHT || 24;
                    const top = (domWidget && domWidget.last_y > 0) ? domWidget.last_y : titleBar + 40;
                    const freeHeight = Math.max(50, (node.size?.[1] || 200) - top - 8);
                    mainContainer.style.height = freeHeight + "px";
                };

                const origOnResize = node.onResize;
                node.onResize = function(size) {
                    if (origOnResize) origOnResize.apply(this, arguments);
                    applyHeight();
                };

                // Appel initial après le premier layout du canvas
                setTimeout(applyHeight, 50);

                const updatePreview = (filename) => {
                    previewContainer.innerHTML = "";
                    if (!filename) {
                        previewContainer.textContent = "No Media";
                        return;
                    }

                    const url = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input`);
                    const ext = filename.split('.').pop().toLowerCase();
                    const isVideo = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v'].includes(ext);

                    let el;
                    if (isVideo) { el = document.createElement("video"); el.autoplay = true; el.muted = true; el.loop = true; el.controls = true; } 
                    else { el = document.createElement("img"); }
                    el.src = url;

                    Object.assign(el.style, { width: "100%", height: "100%", objectFit: "contain", display: "block", pointerEvents: "none" });
                    previewContainer.appendChild(el);
                };

                // --- Upload via file input (bouton HTML) ---
                // On utilise un UID unique par instance de node (et non node.id)
                // pour éviter les collisions lors du clonage : un clone peut
                // temporairement partager le même node.id que l'original pendant
                // la phase configure() de LiteGraph, ce qui dupliquerait le
                // fileInputId et risquerait de supprimer l'input de l'original.
                if (node._holaf_file_input) {
                    node._holaf_file_input.remove();
                    node._holaf_file_input = null;
                }
                const fileInputId = 'holaf_file_input_' + (node._holaf_uid || (node._holaf_uid = 'hf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)));
                const fileInput = document.createElement("input");
                fileInput.id = fileInputId;
                fileInput.className = 'holaf_file_input';
                fileInput.dataset.holafUid = node._holaf_uid;
                Object.assign(fileInput, { type: "file", accept: "image/*,video/*,.mkv,.avi,.mov", style: "display:none" });
                document.body.appendChild(fileInput);
                node._holaf_file_input = fileInput;

                uploadButton.onclick = () => { fileInput.click(); };

                fileInput.onchange = async () => {
                    if (!fileInput.files.length) return;
                    await uploadFileAndSetWidget(node, fileInput.files[0], uploadButton);
                    fileInput.value = "";
                };

                // --- Reste de la logique (inchangée) ---
                if (widget) {
                    const originalCallback = widget.callback;
                    widget.callback = function(v) { if (originalCallback) originalCallback(v); updatePreview(v); };
                    setTimeout(() => { if (widget.value) updatePreview(widget.value); }, 100);
                }
                const onRemoved = node.onRemoved;
                node.onRemoved = function() {
                    if (onRemoved) onRemoved.apply(this, arguments);
                    // Nettoyage via la référence stockée sur l'instance plutôt
                    // que via un ID basé sur node.id (qui pourrait avoir changé).
                    if (this._holaf_file_input) {
                        this._holaf_file_input.remove();
                        this._holaf_file_input = null;
                    }
                };
            };

            const onExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function(message) {
                if (onExecuted) onExecuted.apply(this, arguments);
                if (message?.images?.length) {
                    const filename = message.images[0].filename;
                    const widget = this.widgets.find(w => w.name === "media_file");
                    if (widget && widget.value !== filename) {
                        widget.value = filename;
                        if(widget.callback) widget.callback(filename);
                    }
                }
            };


        }
    }
});