// ─────────────────────────────────────────────────────────────────────────
// Chargeur « comme ComfyUI » des modules du pack (WEB_DIRECTORY = js/).
//
// ComfyUI ne référence PAS un point d'entrée unique : le front demande
// GET /api/extensions (new frontend : api.getExtensions()) qui renvoie LA LISTE
// DES FICHIERS .js du WEB_DIRECTORY, puis les importe TOUS EN PARALLÈLE
// (comfyui-frontend-src/src/services/extensionService.ts > loadExtensions :
// Promise.all(extensions.map(ext => import(api.fileURL(ext))))). Chaque échec
// est attrapé et loggé (console.error), sans bloquer les autres.
//
// Ce helper reproduit ce chemin : il énumère les .js du dossier js/ et les
// importe en parallèle, en CAPTURANT l'erreur par fichier. Un test qui importe
// un seul module (ex. 02_aih_model_browser.js) NE prouve PAS le chemin réel :
// c'est exactement ce que ce chargeur corrige.
//
// Les fichiers xterm*.js (vendor volumineux, sans rapport avec le Model
// Browser) sont exclus pour garder les tests rapides ; l'ordre/parallélisme et
// la résolution du graphe ES restent ceux de ComfyUI.
// ─────────────────────────────────────────────────────────────────────────
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const JS_DIR = dirname(fileURLToPath(import.meta.url)).replace(/\/test_helpers$/, "");

/** Liste des fichiers .js du WEB_DIRECTORY, tels que /api/extensions les sert. */
export function extensionFiles() {
    return readdirSync(JS_DIR)
        .filter((f) => f.endsWith(".js") && !f.startsWith("xterm"))
        .sort();
}

/**
 * Importe tous les modules du WEB_DIRECTORY en parallèle (chemin ComfyUI).
 * @returns {Promise<{file:string, ok:boolean, error:Error|null}[]>}
 */
export async function loadAllExtensions() {
    const files = extensionFiles();
    return await Promise.all(
        files.map(async (f) => {
            try {
                await import(pathToFileURL(join(JS_DIR, f)).href);
                return { file: f, ok: true, error: null };
            } catch (error) {
                // ComfyUI : « Error loading extension » puis continue.
                return { file: f, ok: false, error };
            }
        })
    );
}
