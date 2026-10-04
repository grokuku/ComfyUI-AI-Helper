import { app } from "../../scripts/app.js";
import { ComfyWidgets } from "../../scripts/widgets.js";
import { onCanvasDraw } from "./holaf_nodes2_compat.js";

// ComfyUI class key of this node. The legacy pre-rename alias was removed
// from the Python registry (user decision): one key per node, so the Add Node
// search lists it once. Old workflows referencing it must be redone.
const NODE_TYPES = ["AIHToText"];

app.registerExtension({
    name: "AIH.ToText",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (NODE_TYPES.includes(nodeData.name)) {

            // --- 1. RENDER HELPERS ---

            // Security: sanitize URLs to prevent XSS via dangerous protocols.
            // The URL is already HTML-escaped at this point, but javascript: and
            // similar protocols contain no HTML-special chars and would pass through.
            const sanitizeUrl = (url) => {
                // Remove whitespace/control chars that browsers ignore when parsing protocols
                const cleaned = url.replace(/[\s\x00-\x20]/g, '');
                if (/^(javascript|vbscript|data|file):/i.test(cleaned)) {
                    return "";
                }
                return url;
            };

            const renderMarkdown = (text) => {
                if (!text) return "";
                
                let html = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

                // 1. HTML escape — applied first so all user content is escaped
                //    before any markdown processing or innerHTML injection.
                //    Quotes are escaped too to prevent attribute breakout (e.g. in href).
                html = html
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;")
                    .replace(/"/g, "&quot;");

                // 2. Code blocks (fenced) — must be before inline code
                // NOTE: lang is already HTML-escaped above, but we use textContent via
                // a temporary element for defense-in-depth rather than string interpolation.
                html = html.replace(/```(\w*)\n?([\s\S]*?)```/gim, (match, lang, code) => {
                    const tempSpan = document.createElement("span");
                    tempSpan.textContent = lang;
                    const langLabel = lang ? `<span style="color:#666; font-size:10px;">${tempSpan.innerHTML}</span><br>` : "";
                    return `<div style="background:#1a1a1a; border:1px solid #333; border-radius:4px; padding:8px; margin:4px 0; overflow-x:auto;">${langLabel}<code style="color:#c9d1d9; font-family:monospace; font-size:11px; white-space:pre;">${code.trim()}</code></div>`;
                });

                // 3. Block elements
                html = html
                    // Headers
                    .replace(/^### (.*$)/gim, '<h3 style="margin:4px 0 1px 0; font-size:1.1em; font-weight:bold; color:#e0e0e0; border-bottom:1px solid #444;">$1</h3>')
                    .replace(/^## (.*$)/gim, '<h2 style="margin:6px 0 2px 0; font-size:1.2em; font-weight:bold; color:#fff; border-bottom:1px solid #555;">$1</h2>')
                    .replace(/^# (.*$)/gim, '<h1 style="margin:8px 0 3px 0; font-size:1.4em; font-weight:bold; color:#fff; border-bottom:1px solid #777;">$1</h1>')
                    
                    // Separator
                    .replace(/^---$/gim, '<hr style="border:0; border-top:1px solid #555; margin:6px 0;">')

                    // Lists
                    .replace(/^\s*[\-\*] (.*$)/gim, 
                        '<div style="display:flex; align-items:flex-start; margin-bottom:2px;">' +
                            '<span style="display:inline-block; width:5px; height:5px; border-radius:50%; background-color:#888; margin-top:6px; margin-right:8px; flex-shrink:0;"></span>' +
                            '<span style="color:#ddd; flex:1;">$1</span>' +
                        '</div>');

                // 4. Tables
                html = html.replace(/^(\|.+\|)\n(\|[\s\-:|]+\|)\n((?:\|.+\|\n?)*)/gim, (match, headerRow, sepRow, bodyRows) => {
                    const parseRow = (row) => row.split('|').filter(c => c.trim() !== '');
                    const headers = parseRow(headerRow);
                    
                    let tableHtml = '<table style="border-collapse:collapse; margin:4px 0; font-size:11px; width:100%;">';
                    tableHtml += '<thead><tr>';
                    headers.forEach(h => {
                        tableHtml += `<th style="border:1px solid #444; padding:3px 6px; background:#333; color:#fff; text-align:left;">${h.trim()}</th>`;
                    });
                    tableHtml += '</tr></thead><tbody>';
                    
                    const bodyLines = bodyRows.trim().split('\n');
                    bodyLines.forEach(line => {
                        const cells = parseRow(line);
                        if (cells.length > 0) {
                            tableHtml += '<tr>';
                            cells.forEach(c => {
                                tableHtml += `<td style="border:1px solid #333; padding:2px 6px; color:#ddd;">${c.trim()}</td>`;
                            });
                            tableHtml += '</tr>';
                        }
                    });
                    
                    tableHtml += '</tbody></table>';
                    return tableHtml;
                });

                // 5. Inline elements
                html = html
                    .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#fff; font-weight:700;">$1</strong>')
                    .replace(/`([^`]+)`/g, '<code style="background:#333; color:#ff9f89; padding:1px 4px; border-radius:3px; font-family:monospace;">$1</code>')
                    // Links — URL is already HTML-escaped; sanitize to block
                    // javascript:, vbscript:, data:, file: protocols
                    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, linkText, url) => {
                        const safeUrl = sanitizeUrl(url);
                        if (!safeUrl) return linkText;
                        return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="color:#58a6ff; text-decoration:none;">${linkText}</a>`;
                    });

                // 6. Clean line breaks after block elements
                html = html.replace(/(<\/div>|<\/h[1-3]>|<\/table>|<\/hr>)\s*\n/g, '$1');

                // 7. Remaining line breaks
                html = html.replace(/\n/g, '<br>');

                return html;
            };

            const updateWidgetVisuals = (el, text, mode) => {
                if (!el) return;
                
                el.style.whiteSpace = "pre-wrap"; 
                el.style.fontFamily = "monospace";
                
                if (mode === "Markdown") {
                    el.innerHTML = renderMarkdown(text);
                    el.style.fontFamily = "Segoe UI, Tahoma, sans-serif";
                    el.style.whiteSpace = "normal"; 
                } else if (mode === "JSON") {
                    el.innerHTML = "";
                    const pre = document.createElement("pre");
                    pre.style.margin = "0";
                    pre.style.color = "#8ec07c";
                    pre.style.fontFamily = "monospace";
                    pre.style.fontSize = "11px";
                    pre.textContent = text;
                    el.appendChild(pre);
                    el.style.whiteSpace = "pre";
                } else {
                    el.textContent = text;
                }
            };

            // --- 2. COMPUTE AVAILABLE HEIGHT ---
            
            const computeDivHeight = (node, widget) => {
                // Calculate available space in the node for the custom widget
                if (!node.size || !widget) return 80;
                
                const nodeHeight = node.size[1];
                // Estimate: widget starts around y=60 (title + first widget margin)
                // Leave ~30px at bottom for node padding
                const occupiedHeight = widget.last_y ? widget.last_y : 60;
                const available = nodeHeight - occupiedHeight - 30;
                return Math.max(60, available);
            };

            // --- 3. SETUP ---
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                ComfyWidgets.STRING(this, "display_text", ["STRING", { multiline: true }], app);
                this.custom_widget_el = null; 
                this.last_display_mode = "Plain";
                // Nodes 2.0 : node.onDrawForeground n'est jamais appelé (le rendu
                // Vue saute le dessin canvas du node). On entretient donc le rendu
                // riche via le hook canvas-level (Vue uniquement ; strictement
                // inactif en mode classique).
                if (!this._holafToTextOff) {
                    this._holafToTextOff = onCanvasDraw(() => ensureToTextRenderer(this));
                    const prevRemoved = this.onRemoved;
                    this.onRemoved = function () {
                        if (prevRemoved) prevRemoved.apply(this, arguments);
                        if (this._holafToTextOff) { this._holafToTextOff(); this._holafToTextOff = null; }
                    };
                }
                return r;
            };

            // --- 4. DOM INJECTION (Lazy Swap) ---
            // Le rendu riche du ToText (Markdown/JSON) est un <div> DOM injecté à
            // côté du textarea de `display_text` (lui-même un DOM widget). Cette
            // injection était déclenchée depuis node.onDrawForeground — hook SAUTÉ
            // en Nodes 2.0. On l'extrait dans une fonction idempotente appelée
            // depuis les DEUX chemins : onDrawForeground (classique, inchangé) et
            // onCanvasDraw (canvas-level, Vue uniquement).
            const ensureToTextRenderer = (node) => {
                const widget = node.widgets?.find((w) => w.name === "display_text");
                if (!widget || !widget.inputEl || !widget.inputEl.parentNode) return false;

                if (widget.inputEl.holaf_patched) {
                    // Update height on every draw if node was resized
                    if (node.custom_widget_el && node.custom_widget_el.isConnected) {
                        const targetH = computeDivHeight(node, widget);
                        node.custom_widget_el.style.height = targetH + "px";
                    }
                    return true;
                }

                // Hide original widget
                widget.inputEl.style.display = "none";
                
                const myDiv = document.createElement("div");
                myDiv.className = "holaf-totext-custom comfy-multiline-input";
                Object.assign(myDiv.style, {
                    width: "100%",
                    overflowY: "auto",
                    padding: "8px",
                    boxSizing: "border-box",
                    backgroundColor: "#222",
                    color: "#ddd",
                    fontSize: "12px",
                    fontFamily: "monospace",
                    lineHeight: "1.4",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    userSelect: "text",
                    border: "1px solid #444",
                    borderRadius: "4px",
                    cursor: "text",
                    marginTop: "5px"
                });

                // Set initial height
                const initialH = computeDivHeight(node, widget);
                myDiv.style.height = initialH + "px";

                widget.inputEl.parentNode.appendChild(myDiv);
                node.custom_widget_el = myDiv;
                widget.inputEl.holaf_patched = true; 
                
                updateWidgetVisuals(myDiv, widget.value || "", node.last_display_mode);
                return true;
            };

            const onDrawForeground = nodeType.prototype.onDrawForeground;
            nodeType.prototype.onDrawForeground = function (ctx) {
                onDrawForeground?.apply(this, arguments);
                ensureToTextRenderer(this);
            };

            // --- 5. DATA UPDATE ---
            const onExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (message) {
                onExecuted?.apply(this, arguments);

                if (message && message.text) {
                    const widget = this.widgets.find((w) => w.name === "display_text");
                    
                    if (widget) {
                        const text = message.text[0];
                        const mode = message.mode ? message.mode[0] : "Plain";
                        
                        widget.value = text;
                        this.last_display_mode = mode;

                        if (this.custom_widget_el && this.custom_widget_el.isConnected) {
                            updateWidgetVisuals(this.custom_widget_el, text, mode);
                        } else {
                            if (widget.inputEl) widget.inputEl.holaf_patched = false;
                        }
                        
                        this.onResize?.(this.size);
                    }
                }
            };
        }
    },
});