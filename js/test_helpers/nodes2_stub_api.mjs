// Stub minimal du module ComfyUI `scripts/api.js` (voir nodes2_stub_app.mjs).
export const api = globalThis.__aihNodes2TestApi
    || (globalThis.__aihNodes2TestApi = { addEventListener() {}, apiURL: (p) => p });
