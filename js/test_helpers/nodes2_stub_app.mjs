// Stub minimal du module ComfyUI `scripts/app.js` pour les tests Node/jsdom.
// Le pack importe `{ app } from "../../scripts/app.js"` (chemin servi par
// ComfyUI à l'exécution, inexistant sur disque en test). Le hook de résolution
// js/test_helpers/nodes2_resolve.mjs redirige ce specifier ici. L'instance
// réelle est fournie par le test via globalThis.__aihNodes2TestApp AVANT tout
// import du pack (le stub ne fait que l'exposer).
export const app = globalThis.__aihNodes2TestApp
    || (globalThis.__aihNodes2TestApp = { registerExtension() {} });
