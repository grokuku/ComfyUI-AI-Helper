/*
 * Copyright (C) 2025 Holaf
 * Logic for the AIH remote-control node family: Remote, Bypasser,
 * Group Bypasser, Remote Selector and Simple Bypasser.
 */

import { app } from "../../scripts/app.js";
import { onCanvasDraw, setWidgetHidden } from "./holaf_nodes2_compat.js";

// Constants
const MODE_ALWAYS = 0;
const MODE_MUTE = 2;
const MODE_BYPASS = 4;

// ---------------------------------------------------------------------------
// Node-type keys — canonical "AIH*" forms only.
//
// The legacy pre-rename "Holaf*" aliases were removed from the Python
// registry (user decision): /api/object_info exposes one entry PER KEY, so a
// second alias key made every node appear TWICE in the Add Node search. Old
// workflows that serialize the removed keys must be redone. All type checks
// below (on nodeData.name or node.type) go through isFamilyType().
const FAMILY_TYPES_BY_GROUP = {
    bypasser:       "AIHBypasser",
    groupBypasser:  "AIHGroupBypasser",
    remote:         "AIHRemote",
    remoteSelector: "AIHRemoteSelector",
    simpleBypasser: "AIHSimpleBypasser",
};

/** Every ComfyUI class key of the family. */
const ALL_FAMILY_TYPES = Object.values(FAMILY_TYPES_BY_GROUP);

/** Family groups that REACT to syncGroupState (the Selector drives others but is not driven). */
const SYNC_GROUPS = ["bypasser", "remote", "groupBypasser", "simpleBypasser"];

/**
 * True if `t` is one of the family's ComfyUI class keys.
 * @param {string} t value of nodeData.name or node.type to test
 * @param {string} [group] optional family group (FAMILY_TYPES_BY_GROUP key) to restrict the match
 */
function isFamilyType(t, group) {
    const expected = group ? FAMILY_TYPES_BY_GROUP[group] : null;
    return expected ? t === expected : ALL_FAMILY_TYPES.includes(t);
}

// IS_SYNCING prevents recursive group state synchronization.
// JavaScript is single-threaded, so this flag is sufficient.
// Scoped per-graph to avoid interference across multiple graph instances.
const _holafSyncingPerGraph = new WeakMap();

app.registerExtension({
    name: "AIH.RemoteControl",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        // Family keys only (see FAMILY_TYPES_BY_GROUP).
        if (isFamilyType(nodeData.name)) {

            // --- 1. SETUP ON CREATION ---
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                if (isFamilyType(this.type, "simpleBypasser")) {
                    this.setupSimpleBypassLogic();
                } else if (isFamilyType(this.type, "remoteSelector")) {
                    this.setupRemoteSelectorLogic();
                } else {
                    this.setupRemoteLogic();
                }

                if (isFamilyType(this.type, "groupBypasser")) {
                    this.setupGroupSelector();
                }
            };

            // --- 2. UPDATE ON LOAD ---
            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function () {
                if (onConfigure) onConfigure.apply(this, arguments);

                // Fix Label for standard Remotes
                if (!isFamilyType(this.type, "remoteSelector")) {
                    const groupWidget = this.widgets?.find(w => w.name === "group_name");
                    const activeWidget = this.widgets?.find(w => w.name === "active");
                    if (groupWidget && activeWidget) {
                        // Piste 2: If the "active" widget is promoted (its slot
                        // is linked from outside the SubgraphNode), the promoted
                        // slot drives the value — don't overwrite the label.
                        const isPromoted = this.getSlotFromWidget && this.getSlotFromWidget(activeWidget)?.link != null;
                        if (!isPromoted) {
                            activeWidget.label = groupWidget.value || "active";
                        }
                    }
                }

                // Setup Group Selector immediately
                if (isFamilyType(this.type, "groupBypasser")) {
                    this.setupGroupSelector();
                }

                // Setup Remote Selector logic immediately (restore dropdown options)
                if (isFamilyType(this.type, "remoteSelector")) {
                    // Use setTimeout to ensure widgets are fully loaded/restored before swapping
                    setTimeout(() => {
                        this.setupRemoteSelectorLogic();
                    }, 50);
                }

                // Fix Dynamic Slots
                if (isFamilyType(this.type, "bypasser")) {
                    setTimeout(() => this.checkDynamicSlots(), 100);
                }

                // Re-apply setupSimpleBypassLogic (restore widget.hidden=true)
                if (isFamilyType(this.type, "simpleBypasser")) {
                    this.setupSimpleBypassLogic();
                }
            };

            // --- 3. DYNAMIC INPUTS LISTENER ---
            if (isFamilyType(nodeData.name, "bypasser")) {
                const onConnectionsChange = nodeType.prototype.onConnectionsChange;
                nodeType.prototype.onConnectionsChange = function (type, index, connected, link_info, ...args) {
                    if (onConnectionsChange) onConnectionsChange.apply(this, [type, index, connected, link_info, ...args]);
                    if (type === 1) {
                        this.checkDynamicSlots();
                    }
                };

                nodeType.prototype.checkDynamicSlots = function () {
                    const originalSlot = this.findInputSlot("original");

                    if (originalSlot !== -1 && this.inputs[originalSlot].link !== null) {
                        const hasBypassSlot = this.inputs.some(i => i.name.startsWith("other_bypass"));
                        if (!hasBypassSlot) {
                            this.addInput("other_bypass_1", "*");
                        }
                    }

                    const bypassInputs = this.inputs.filter(i => i.name.startsWith("other_bypass"));
                    if (bypassInputs.length > 0) {
                        const lastBypass = bypassInputs[bypassInputs.length - 1];
                        if (lastBypass.link !== null) {
                            const nextIndex = bypassInputs.length + 1;
                            this.addInput(`other_bypass_${nextIndex}`, "*");
                        }
                    }
                    this.setSize(this.computeSize());
                }
            }


            // --- CORE LOGIC : STANDARD REMOTE ---
            nodeType.prototype.setupRemoteLogic = function () {
                // Ensure this logic doesn't run for the Selector
                if (isFamilyType(this.type, "remoteSelector")) return;

                const groupWidget = this.widgets.find(w => w.name === "group_name");
                const activeWidget = this.widgets.find(w => w.name === "active");

                if (!groupWidget || !activeWidget) return;

                const updateLabel = (text) => {
                    activeWidget.label = text || "active";
                    this.setDirtyCanvas(true, true);
                };

                updateLabel(groupWidget.value);
                groupWidget.callback = (value) => { updateLabel(value); };

                const originalActiveCallback = activeWidget.callback;
                activeWidget.callback = (value) => {
                    if (originalActiveCallback) originalActiveCallback(value);
                    if (_holafSyncingPerGraph.get(app.graph)) return;

                    const groupName = groupWidget.value;
                    this.syncGroupState(app.graph, groupName, value);
                    this.triggerBypassLogic(value);
                };
            };

            // --- CORE LOGIC : REMOTE SELECTOR (NEW) ---
            nodeType.prototype.setupRemoteSelectorLogic = function () {
                const listWidget = this.widgets.find(w => w.name === "group_list");
                let activeWidgetIndex = this.widgets.findIndex(w => w.name === "active_group");
                let activeWidget = this.widgets[activeWidgetIndex];

                if (!listWidget || !activeWidget) return;

                // --- KEY FIX: FORCE WIDGET REPLACEMENT ---
                // If the widget is still a text input (STRING), we destroy it and create a proper COMBO widget.
                if (activeWidget.type !== "combo") {
                    const currentValue = activeWidget.value;

                    // Remove the old text widget
                    this.widgets.splice(activeWidgetIndex, 1);

                    // Create configuration for the new combo widget
                    // We initialize it with empty values, they will be populated by updateDropdownOptions
                    const newWidget = this.addWidget("combo", "active_group", currentValue, (v) => { }, { values: [] });

                    // addWidget appends to the end of the list; move the new widget
                    // back to its original position so the visual widget order is preserved.
                    const insertedIndex = this.widgets.indexOf(newWidget);
                    if (insertedIndex !== activeWidgetIndex) {
                        this.widgets.splice(insertedIndex, 1);
                        this.widgets.splice(activeWidgetIndex, 0, newWidget);
                    }

                    // Ensure the new widget is in the correct variable for the rest of the function
                    activeWidget = newWidget;
                }

                // Parser function: Updates the dropdown options based on the text list
                const updateDropdownOptions = () => {
                    const text = listWidget.value || "";
                    const lines = text.split("\n").map(s => s.trim()).filter(s => s);

                    // Update options on the combo widget
                    activeWidget.options.values = lines;

                    // Validation: if current selection is invalid or empty, default to first available
                    if (lines.length > 0 && !lines.includes(activeWidget.value)) {
                        // Optional: Force a valid value if current is invalid. 
                        // Useful for initial setup.
                        if (activeWidget.value === "") {
                            activeWidget.value = lines[0];
                        }
                    }
                };

                // Listener on the List Widget
                listWidget.callback = (v) => {
                    updateDropdownOptions();
                    this.setDirtyCanvas(true, true);
                };

                // Logic on Selection Change
                // We assign the callback directly to the (potentially new) widget
                activeWidget.callback = (value) => {
                    if (_holafSyncingPerGraph.get(app.graph)) return;

                    const allGroups = listWidget.value.split("\n").map(s => s.trim()).filter(s => s);

                    allGroups.forEach(groupName => {
                        const isActive = (groupName === value);
                        this.syncGroupState(app.graph, groupName, isActive);
                    });
                };

                // Initial run to populate the list based on current text
                updateDropdownOptions();
            };

            // --- CORE LOGIC : SIMPLE BYPASSER ---
            nodeType.prototype.setupSimpleBypassLogic = function () {
                const groupWidget = this.widgets.find(w => w.name === "group_name");
                const activeWidget = this.widgets.find(w => w.name === "active");
                const invertWidget = this.widgets.find(w => w.name === "invert");
                // Cacher le widget "active" — piloté par syncGroupState, pas par l'utilisateur.
                // setWidgetHidden pose hidden (canvas) ET options.hidden (Vue) : le
                // renderer classique lit widget.hidden, le renderer Nodes 2.0 lit
                // options.hidden — sans les deux, le widget reste visible en Vue.
                if (activeWidget) setWidgetHidden(activeWidget, true);
                if (!invertWidget) return;
                // Callback sur "invert" : re-évaluer le bypass avec la valeur active courante. LOCAL, pas de syncGroupState.
                const originalInvertCallback = invertWidget.callback;
                invertWidget.callback = (value) => {
                    if (originalInvertCallback) originalInvertCallback(value);
                    const currentActive = activeWidget ? activeWidget.value : false;
                    this.triggerBypassLogic(currentActive);
                };
            };

            // --- GROUP SELECTOR LOGIC (Simplified) ---
            nodeType.prototype.setupGroupSelector = function () {
                const comfyGroupWidget = this.widgets.find(w => w.name === "comfy_group");
                if (!comfyGroupWidget) return;

                // Function to refresh the list of groups
                const refreshGroups = () => {
                    const groups = app.graph._groups || [];
                    const names = groups.map(g => g.title).filter(t => t);

                    // Always ensure "None" is first
                    const values = ["None", ...names];
                    comfyGroupWidget.options.values = values;
                };

                // Refresh immediately
                refreshGroups();

                // Refresh on interaction (renderer classique : hook node-level).
                this.onMouseEnter = function (e) {
                    refreshGroups();
                };

                // Nodes 2.0 (Vue) : le hook node-level onMouseEnter n'est JAMAIS
                // appelé (LGraphCanvas.processMouseMove met node=null en
                // vueNodesMode). On rafraîchit donc aussi le combo depuis le hook
                // canvas-level (survivant), STRICTEMENT en vueNodesMode : en mode
                // classique le callback n'est jamais exécuté (no-op total).
                if (!this._holafGroupRefreshOff) {
                    this._holafGroupRefreshOff = onCanvasDraw(refreshGroups);
                    const prevRemoved = this.onRemoved;
                    this.onRemoved = function () {
                        if (prevRemoved) prevRemoved.apply(this, arguments);
                        if (this._holafGroupRefreshOff) {
                            this._holafGroupRefreshOff();
                            this._holafGroupRefreshOff = null;
                        }
                    };
                }
            };


            // --- SYNC ENGINE ---
            nodeType.prototype.syncGroupState = function (targetGraph, groupName, newState) {
                if (!_holafSyncingPerGraph.has(targetGraph)) _holafSyncingPerGraph.set(targetGraph, false);
                const wasSyncing = _holafSyncingPerGraph.get(targetGraph);
                _holafSyncingPerGraph.set(targetGraph, true);

                try {
                    const traverse = (graph) => {
                        // Guard: ensure graph is a valid object with an array of nodes before traversing.
                        if (!graph || typeof graph !== 'object' || !Array.isArray(graph._nodes)) return;
                        for (const node of graph._nodes) {
                            if (node === this) continue;
                            if (node.subgraph && typeof node.subgraph === 'object') traverse(node.subgraph);

                            // Sync targets: same groups as the original list
                            // (Bypasser/Remote/GroupBypasser/SimpleBypasser — the
                            // Selector is excluded), canonical + legacy keys.
                            if (SYNC_GROUPS.some(g => isFamilyType(node.type, g))) {
                                const otherGroupWidget = node.widgets.find(w => w.name === "group_name");
                                const otherActiveWidget = node.widgets.find(w => w.name === "active");

                                if (otherGroupWidget && otherActiveWidget && otherGroupWidget.value === groupName) {
                                    otherActiveWidget.value = newState;
                                    node.triggerBypassLogic(newState);
                                    // If the target's "active" widget is promoted
                                    // to a SubgraphNode, the interior value set
                                    // above does not refresh the store-backed
                                    // host widget on the SubgraphNode. Push the
                                    // new value to the host widget too so the
                                    // promoted visual stays in sync.
                                    holafSyncPromotedHostWidget(node, otherActiveWidget, newState);
                                }
                            }
                        }
                    };
                    if (!wasSyncing) traverse(targetGraph);
                } finally {
                    if (!wasSyncing) _holafSyncingPerGraph.set(targetGraph, false);
                }
            };

            // --- TRIGGER LOGIC ---
            nodeType.prototype.triggerBypassLogic = function (isActive) {
                if (isFamilyType(this.type, "bypasser")) {
                    this.handleStandardBypass(isActive);
                } else if (isFamilyType(this.type, "groupBypasser")) {
                    this.handleGroupBypass(isActive);
                } else if (isFamilyType(this.type, "simpleBypasser")) {
                    this.handleSimpleBypass(isActive);
                }
                // Remote and RemoteSelector have no internal bypass logic to trigger
            };

            // --- LOGIC 1: STANDARD BYPASSER ---
            nodeType.prototype.handleStandardBypass = function (isActive) {
                const targetMode = isActive ? MODE_ALWAYS : MODE_BYPASS;
                const graph = this.graph;
                if (!graph) return;

                const updateLink = (linkId) => {
                    if (!linkId) return;
                    const link = graph.links[linkId];
                    if (!link) return;
                    const node = graph.getNodeById(link.origin_id);
                    if (node && node.mode !== targetMode) {
                        node.mode = targetMode;
                    }
                };

                const originalSlot = this.findInputSlot("original");
                if (originalSlot !== -1 && this.inputs[originalSlot].link) {
                    updateLink(this.inputs[originalSlot].link);
                }

                if (this.inputs) {
                    for (const input of this.inputs) {
                        if (input.name && input.name.startsWith("other_bypass")) {
                            if (input.link) updateLink(input.link);
                        }
                    }
                }
                app.graph.change();
            };

            // --- LOGIC: SIMPLE BYPASSER ---
            nodeType.prototype.handleSimpleBypass = function (isActive) {
                const invertWidget = this.widgets.find(w => w.name === "invert");
                const invert = invertWidget ? invertWidget.value : false;
                // Normal (invert=false) : bypass quand groupe OFF → shouldBypass = !isActive
                // Inverted (invert=true) : bypass quand groupe ON → shouldBypass = isActive
                const shouldBypass = invert ? isActive : !isActive;
                const targetMode = shouldBypass ? MODE_BYPASS : MODE_ALWAYS;
                const graph = this.graph;
                if (!graph) return;
                const updateLink = (linkId) => {
                    if (!linkId) return;
                    const link = graph.links[linkId];
                    if (!link) return;
                    const node = graph.getNodeById(link.origin_id);
                    if (node && node.mode !== targetMode) node.mode = targetMode;
                };
                const inputSlot = this.findInputSlot("input");
                if (inputSlot !== -1 && this.inputs[inputSlot].link) {
                    updateLink(this.inputs[inputSlot].link);
                }
                app.graph.change();
            };

            // --- LOGIC 2: GROUP BYPASSER ---
            nodeType.prototype.handleGroupBypass = function (isActive) {
                const comfyGroupWidget = this.widgets.find(w => w.name === "comfy_group");
                const modeWidget = this.widgets.find(w => w.name === "bypass_mode");

                if (!comfyGroupWidget || !comfyGroupWidget.value || comfyGroupWidget.value === "None") return;

                const targetGroupName = comfyGroupWidget.value;
                const graph = this.graph;

                const visualGroup = graph._groups.find(g => g.title === targetGroupName);
                if (!visualGroup) return;

                let inactiveMode = MODE_BYPASS;
                if (modeWidget && modeWidget.value === "Mute") {
                    inactiveMode = MODE_MUTE;
                }

                const targetMode = isActive ? MODE_ALWAYS : inactiveMode;

                const gX = visualGroup.pos[0];
                const gY = visualGroup.pos[1];
                const gW = visualGroup.size[0];
                const gH = visualGroup.size[1];

                for (const node of graph._nodes) {
                    if (node.id === this.id) continue;
                    // Skip family nodes themselves (canonical + legacy keys):
                    // they are driven by the remote, not by the group rectangle.
                    if (["bypasser", "remote", "groupBypasser"].some(g => isFamilyType(node.type, g))) continue;

                    // Use node center for more accurate hit-testing
                    const cx = node.pos[0] + (node.size?.[0] || 0) / 2;
                    const cy = node.pos[1] + (node.size?.[1] || 0) / 2;
                    if (cx >= gX && cx <= gX + gW && cy >= gY && cy <= gY + gH) {

                        if (node.mode !== targetMode) {
                            node.mode = targetMode;
                        }
                    }
                }
                app.graph.change();
            };
        }
    }
});

/*
 * Piste 3 — SubgraphWatcher
 *
 * When a Holaf widget is promoted to the SubgraphNode and the user toggles it
 * there, BaseWidget.setValue() calls node.onWidgetChanged(name, value, oldValue,
 * widget) on the SubgraphNode. We wrap that hook to detect changes on promoted
 * Holaf widgets and forward them to the interior Holaf node, mirroring exactly
 * what the in-graph widget callback (setupRemoteLogic / setupRemoteSelectorLogic)
 * does for the non-promoted case.
 *
 * Coexistence:
 *   - Non-promoted: click interior widget -> interior callback -> sync/bypass
 *   - Promoted:     click SubgraphNode widget -> onWidgetChanged -> watcher
 *                   -> holafOnPromotedValueChange -> sync/bypass
 */

// Module-level: resolve the interior Holaf node(s) behind a promoted widget.
function holafHandlePromotedChange(subgraphNode, widgetName, newValue) {
    // The promoted widget name becomes the input slot name on the SubgraphNode.
    const input = subgraphNode.inputs.find(i => i.name === widgetName);
    if (!input || !input._subgraphSlot) return; // not a promoted input

    // Skip if the slot is linked from outside — the value is being driven
    // externally (e.g. by another node), not toggled by the user on the
    // SubgraphNode widget. In that case the interior node should not be
    // forced to follow.
    if (input.link != null) return;

    const subgraph = subgraphNode.subgraph;
    if (!subgraph) return;

    // Family keys only (see FAMILY_TYPES_BY_GROUP).

    // Each promoted input keeps a reference to its SubgraphInput slot, whose
    // linkIds point at interior links inside the subgraph. Resolve them to
    // find the interior node that actually owns the original widget.
    for (const linkId of input._subgraphSlot.linkIds) {
        const link = (typeof subgraph.getLink === "function")
            ? subgraph.getLink(linkId)
            : subgraph._links?.get(linkId);
        if (!link) continue;

        const interiorNode = subgraph.getNodeById(link.target_id);
        if (!interiorNode) continue;
        if (!isFamilyType(interiorNode.type)) continue;

        holafOnPromotedValueChange(interiorNode, widgetName, newValue);
    }

    // Keep the host widget label in sync after a promoted toggle (matters for
    // the RemoteSelector, whose promoted "active_group" value is the label).
    holafUpdatePromotedLabels(subgraphNode);
}

// Module-level: apply the promoted toggle to the interior Holaf node, mirroring
// the in-graph widget callback logic. Shares the same reentrance guard
// (_holafSyncingPerGraph) as syncGroupState to prevent recursive loops.
function holafOnPromotedValueChange(interiorNode, widgetName, newValue) {
    // Use the root graph for the reentrance guard, consistent with the
    // non-promoted callbacks that use app.graph.
    const graph = app.graph || interiorNode.graph?.rootGraph;
    if (!graph) return;

    // Reentrance guard — same mechanism as syncGroupState.
    if (_holafSyncingPerGraph.get(graph)) return;

    if (isFamilyType(interiorNode.type, "remoteSelector")) {
        const listWidget = interiorNode.widgets?.find(w => w.name === "group_list");
        const activeWidget = interiorNode.widgets?.find(w => w.name === "active_group");
        if (!listWidget || !activeWidget) return;

        activeWidget.value = newValue;

        const allGroups = listWidget.value.split("\n").map(s => s.trim()).filter(s => s);
        allGroups.forEach(groupName => {
            const isActive = (groupName === newValue);
            interiorNode.syncGroupState(graph, groupName, isActive);
        });
    } else if (isFamilyType(interiorNode.type, "simpleBypasser")) {
        const activeWidget = interiorNode.widgets?.find(w => w.name === "active");
        const invertWidget = interiorNode.widgets?.find(w => w.name === "invert");

        if (widgetName === "invert") {
            // invert est local : on met à jour la valeur et on re-évalue le bypass
            // avec la valeur active courante. NE PAS appeler syncGroupState.
            if (invertWidget) invertWidget.value = newValue;
            const currentActive = activeWidget ? activeWidget.value : false;
            interiorNode.triggerBypassLogic(currentActive);
        } else {
            // "active" (ou autre) : même logique que les autres types
            if (!activeWidget) return;
            const groupWidget = interiorNode.widgets?.find(w => w.name === "group_name");
            activeWidget.value = newValue;
            interiorNode.syncGroupState(graph, groupWidget?.value || "", newValue);
            interiorNode.triggerBypassLogic(newValue);
        }
    } else {
        // Family nodes (canonical + legacy keys): Bypasser / Remote / GroupBypasser
        const groupWidget = interiorNode.widgets?.find(w => w.name === "group_name");
        const activeWidget = interiorNode.widgets?.find(w => w.name === "active");
        if (!groupWidget || !activeWidget) return;

        activeWidget.value = newValue;
        interiorNode.syncGroupState(graph, groupWidget.value, newValue);
        interiorNode.triggerBypassLogic(newValue);
    }
}

// Module-level: fix the label of promoted Holaf host widgets on a SubgraphNode
// so they display the interior node's group_name (or active group for the
// selector) instead of the raw input name ("active"/"active_group") that
// ComfyUI assigns during promotion (SubgraphNode._setWidget registers the
// host widget with `label: input.label ?? subgraphInput.name`).
function holafUpdatePromotedLabels(subgraphNode) {
    try {
        if (!subgraphNode || !subgraphNode.isSubgraphNode || !subgraphNode.isSubgraphNode()) return;
        const subgraph = subgraphNode.subgraph;
        if (!subgraph) return;

        for (const input of subgraphNode.inputs || []) {
            // Only promoted inputs carry a _subgraphSlot reference.
            if (!input._subgraphSlot) continue;

            // Resolve the interior Holaf node behind this promoted input,
            // mirroring the link resolution used in holafHandlePromotedChange.
            let interiorNode = null;
            for (const linkId of input._subgraphSlot.linkIds || []) {
                const link = (typeof subgraph.getLink === "function")
                    ? subgraph.getLink(linkId)
                    : subgraph._links?.get(linkId);
                if (!link) continue;
                const node = subgraph.getNodeById(link.target_id);
                if (node && isFamilyType(node.type)) {
                    interiorNode = node;
                    break;
                }
            }
            if (!interiorNode) continue;

            // Determine the label to display from the interior node.
            let groupLabel = null;
            if (isFamilyType(interiorNode.type, "remoteSelector")) {
                const activeGroupWidget = interiorNode.widgets?.find(w => w.name === "active_group");
                groupLabel = activeGroupWidget?.value || null;
            } else {
                const groupWidget = interiorNode.widgets?.find(w => w.name === "group_name");
                groupLabel = groupWidget?.value || null;
            }
            if (!groupLabel) continue;

            // Find the host widget on the SubgraphNode for this promoted input.
            // ComfyUI stores it as input._widget (set in SubgraphNode._setWidget).
            // Fall back to a widgetId match, then to a name match.
            let hostWidget = input._widget;
            if (!hostWidget && input.widgetId) {
                hostWidget = subgraphNode.widgets?.find(w => w.widgetId === input.widgetId);
            }
            if (!hostWidget) {
                hostWidget = subgraphNode.widgets?.find(w => w.name === input.name);
            }
            if (!hostWidget) continue;

            // Set the label on the host widget. For store-backed projections
            // (the _projectPromotedWidget path) the `label` setter writes
            // through to the widget value store; for concrete widgets it sets
            // the property directly. Also keep input.label in sync so a future
            // re-resolution (_setWidget) picks up the corrected label.
            hostWidget.label = groupLabel;
            input.label = groupLabel;
        }
    } catch (e) {
        console.warn("[Holaf] holafUpdatePromotedLabels error:", e);
    }
}

/*
 * Promotion host sync helper.
 *
 * syncGroupState sets `otherActiveWidget.value = newState` on the interior
 * Holaf node. When that interior widget is promoted to a SubgraphNode, the
 * interior write alone does NOT update the store-backed host widget that the
 * SubgraphNode renders (it reads from useWidgetValueStore). This helper
 * resolves the promoted host widget from the interior node and pushes the
 * same value to it, so the visible SubgraphNode widget stays in sync.
 *
 * Resolution path (interior node → host widget):
 *   1. targetNode.getSlotFromWidget(activeWidget) → the interior input slot
 *      linked to the SubgraphInput. slot.link != null  == promoted.
 *   2. subgraph (targetNode.graph) .getLink(slot.link) → interior link.
 *   3. link.origin_id === SubgraphInputNode id, link.origin_slot is the index
 *      into subgraph.inputs → the SubgraphInput slot.
 *   4. Walk the graph tree from the root graph to find the SubgraphNode whose
 *      .subgraph === this subgraph (handles nesting).
 *   5. On that SubgraphNode, find the input whose _subgraphSlot ===
 *      SubgraphInput; its _widget is the store-backed host widget.
 *   6. Set hostWidget.value = newState — the projected setter writes through
 *      to useWidgetValueStore.setValue, refreshing the visual. The value
 *      setter does not invoke the widget callback, so there is no reentrance
 *      back into syncGroupState (and the _holafSyncingPerGraph flag is set
 *      during the whole traverse anyway).
 */
function holafSyncPromotedHostWidget(targetNode, activeWidget, newState) {
    try {
        if (!targetNode || !activeWidget) return;
        if (typeof targetNode.getSlotFromWidget !== 'function') return;

        // Step 1: locate the interior input slot bound to the widget.
        const slot = targetNode.getSlotFromWidget(activeWidget);
        if (!slot || slot.link == null) return; // widget is not promoted

        // Step 2: resolve the interior link inside the subgraph.
        const subgraph = targetNode.graph;
        if (!subgraph) return;
        const linkId = slot.link;
        const link = (typeof subgraph.getLink === 'function')
            ? subgraph.getLink(linkId)
            : (subgraph.links?.[linkId] ?? subgraph.links?.get?.(linkId));
        if (!link) return;

        // Step 3: the link originates from the SubgraphInputNode; origin_slot
        // is the index into subgraph.inputs (the SubgraphInput list).
        const subgraphInput = subgraph.inputs?.[link.origin_slot];
        if (!subgraphInput) return;

        // Step 4: find the SubgraphNode owning this subgraph. The subgraph
        // object has no direct back-reference to its SubgraphNode, so walk the
        // graph tree from the root graph (handles arbitrarily nested
        // subgraphs).
        const rootGraph = subgraph.rootGraph;
        if (!rootGraph) return;
        const subgraphNode = _holafFindSubgraphNodeBySubgraph(rootGraph, subgraph);
        if (!subgraphNode) return;

        // Step 5: resolve the SubgraphNode input slot for this SubgraphInput,
        // then its store-backed host widget.
        const hostInput = subgraphNode.inputs?.find(
            (i) => i && i._subgraphSlot === subgraphInput
        );
        if (!hostInput) return;

        let hostWidget = hostInput._widget;
        if (!hostWidget && hostInput.widgetId) {
            hostWidget = subgraphNode.widgets?.find(
                (w) => w.widgetId === hostInput.widgetId
            );
        }
        if (!hostWidget) return;

        // Step 6: push the value through the projected widget. Its value
        // setter writes to useWidgetValueStore.setValue, updating the visual
        // rendered by the SubgraphNode. It does not invoke the callback, so
        // this does not re-enter syncGroupState.
        hostWidget.value = newState;
    } catch (e) {
        console.warn("[Holaf] holafSyncPromotedHostWidget error:", e);
    }
}

// Recursive/iterative search: find the SubgraphNode whose .subgraph ===
// targetSubgraph by walking the graph tree from the root. Visits each graph
// once to avoid infinite loops on pathological cycles.
function _holafFindSubgraphNodeBySubgraph(rootGraph, targetSubgraph) {
    if (!rootGraph || !targetSubgraph) return null;
    const stack = [rootGraph];
    const seen = new Set();
    while (stack.length) {
        const graph = stack.pop();
        if (!graph || seen.has(graph)) continue;
        seen.add(graph);
        const nodes = graph._nodes || graph.nodes;
        if (!Array.isArray(nodes)) continue;
        for (const node of nodes) {
            if (!node) continue;
            if (typeof node.isSubgraphNode === 'function' && node.isSubgraphNode()) {
                if (node.subgraph === targetSubgraph) return node;
                // Descend into nested subgraphs.
                if (node.subgraph) stack.push(node.subgraph);
            }
        }
    }
    return null;
}

// Separate extension: wrap onWidgetChanged on every SubgraphNode instance so
// promoted widget toggles are forwarded to the interior family nodes.
app.registerExtension({
    name: "AIH.SubgraphWatcher",

    nodeCreated(node) {
        if (!node.isSubgraphNode || !node.isSubgraphNode()) return;

        const original = node.onWidgetChanged;
        node.onWidgetChanged = function (name, value, oldValue, widget) {
            if (original) original.call(this, name, value, oldValue, widget);
            try {
                holafHandlePromotedChange(this, name, value);
            } catch (e) {
                console.warn("[Holaf] SubgraphWidgetChange handler error:", e);
            }
        };

        // Fix promoted Holaf widget labels (group_name instead of "active").
        // Interior nodes may not be resolved yet at nodeCreated time, so retry
        // after the current tick.
        try {
            holafUpdatePromotedLabels(node);
            setTimeout(() => holafUpdatePromotedLabels(node), 0);
        } catch (e) {
            console.warn("[Holaf] SubgraphWatcher label init error:", e);
        }

        // Refresh labels after a graph load/configure cycle: interior nodes
        // are reconstructed during configure and may only be ready afterwards.
        const originalConfigure = node.onConfigure;
        node.onConfigure = function (o) {
            if (originalConfigure) originalConfigure.call(this, o);
            try {
                holafUpdatePromotedLabels(this);
                setTimeout(() => holafUpdatePromotedLabels(this), 0);
            } catch (e) {
                console.warn("[Holaf] SubgraphWatcher onConfigure label error:", e);
            }
        };
    }
});