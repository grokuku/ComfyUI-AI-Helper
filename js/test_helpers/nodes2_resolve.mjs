// Hook de résolution Node (module.register) : redirige les imports ComfyUI
// `../../scripts/{app,api,widgets}.js` des modules du pack (chemins servis par
// ComfyUI en HTTP, absents du disque en test) vers des stubs locaux, afin de
// charger les VRAIS modules du pack sous Node/jsdom exactement comme ComfyUI
// les importe (Promise.all des .js du WEB_DIRECTORY).
//
// Usage (dans un test) :
//   import { register } from "node:module";
//   register(new URL("./test_helpers/nodes2_resolve.mjs", import.meta.url), import.meta.url);
//   ... puis await import("./holaf_remote_control.js");
const STUBS = {
    app: new URL("./nodes2_stub_app.mjs", import.meta.url).href,
    api: new URL("./nodes2_stub_api.mjs", import.meta.url).href,
    widgets: new URL("./nodes2_stub_widgets.mjs", import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
    const m = /(?:^|\/)scripts\/(app|api|widgets)\.js$/.exec(specifier);
    if (m) return { url: STUBS[m[1]], shortCircuit: true };
    return nextResolve(specifier, context);
}
