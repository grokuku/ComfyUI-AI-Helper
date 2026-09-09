import { app } from "../holaf_api_compat.js";
import { holafBridge } from "../holaf_comfy_bridge.js";
import { HolafFetch } from "../vendor/holaf/holaf-fetch.js";

/*
 * Listener for Holaf Profiler
 * Runs in the main ComfyUI window.
 */

app.registerExtension({
    name: "Holaf.Profiler.Listener",
    async setup() {
        console.log("[Holaf Profiler] Listener registered.");

        holafBridge.listen(async (data) => {
            if (!data || !data.type) return;

            // 1. Send Workflow Context
            if (data.type === 'get_workflow_for_profiler') {
                console.log("[Holaf Profiler] Processing workflow request...");
                
                // --- 1. GROUP CALCULATION ---
                const liveNodes = app.graph._nodes || [];
                const liveGroups = app.graph._groups || [];
                const nodeGroupMap = {};
                let matchCount = 0;

                console.log(`[Holaf Profiler] analyzing ${liveNodes.length} nodes and ${liveGroups.length} groups.`);

                if (liveNodes.length > 0 && liveGroups.length > 0) {
                    liveNodes.forEach(node => {
                        if (!node.pos || !node.size) return;

                        // Center of node
                        const cx = node.pos[0] + (node.size[0] / 2);
                        const cy = node.pos[1] + (node.size[1] / 2);

                        for (const g of liveGroups) {
                            if (!g.pos || !g.size) continue;
                            const gx = g.pos[0];
                            const gy = g.pos[1];
                            const gw = g.size[0];
                            const gh = g.size[1];

                            if (cx >= gx && cx <= (gx + gw) &&
                                cy >= gy && cy <= (gy + gh)) {
                                nodeGroupMap[node.id] = g.title;
                                matchCount++;
                                break; 
                            }
                        }
                    });
                }
                console.log(`[Holaf Profiler] Found ${matchCount} group associations.`);

                // --- 2. SEND VIA LOCALSTORAGE (BULLETPROOF) ---
                // We use localStorage as a shared buffer between tabs
                localStorage.setItem('holaf_profiler_groups', JSON.stringify(nodeGroupMap));

                // --- 3. SEND VIA BRIDGE (REALTIME) ---
                holafBridge.send('profiler_group_data', { map: nodeGroupMap });

                // --- 4. SYNC WITH BACKEND ---
                try {
                    const workflow = app.graph.serialize();
                    // HolafFetch lève sur non-2xx (→ catch : log existant).
                    await HolafFetch.post('/holaf/profiler/context', { body: workflow });
                    console.log("[Holaf Profiler] Context sent to backend.");
                } catch (e) {
                    console.error("[Holaf Profiler] Backend sync failed:", e);
                }
            }
            
            // 2. Queue Prompt
            else if (data.type === 'queue_prompt') {
                app.queuePrompt(0);
            }
        });
    }
});