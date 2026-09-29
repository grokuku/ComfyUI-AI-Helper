// Tests du module PUR js/aih_model_workflow.js — extraction des modèles du
// workflow courant + filtrage des listes du Model Browser.
// Usage : node js/test_aih_model_workflow.mjs
//
// Aucun DOM, aucun réseau : le module est volontairement pur. On simule des
// graphes ComfyUI (nœuds vivants LiteGraph ET workflow sérialisé) et on
// verrouille :
//   1. extraction (plusieurs catégories de widgets, chaînes multiples,
//      tableaux, sentinelles, valeurs non-modèles, sous-graphes) ;
//   2. repli sérialisé (widgets_values sans noms → signal « extension » seul) ;
//   3. normalisation + index + matching (dossier/chemin, casse, absence) ;
//   4. filtres génériques (types + recherche + workflow = cumul) ;
//   5. comptage « présent local / distant ».
//   6. CONTRÔLES NÉGATIFS : aucun faux positif sur des valeurs non-modèles,
//      index vide → filtre strict (0), workflow absent → aucun filtrage.
import assert from "node:assert";
import {
    MODEL_FILE_EXTENSIONS,
    isModelWidgetName,
    looksLikeModelFile,
    normalizeModelName,
    collectWorkflowModelNames,
    buildWorkflowNameIndex,
    isModelInWorkflow,
    filterModelsByWorkflow,
    filterModelItems,
    countWorkflowMatches,
} from "./aih_model_workflow.js";

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

/* ─── 1. Extraction depuis un graphe « vivant » ─────────────────────────── */
console.log("1. collectWorkflowModelNames — nœuds vivants");
{
    const graph = {
        nodes: [
            { type: "CheckpointLoaderSimple", widgets: [
                { name: "ckpt_name", value: "SDXL/base.safetensors" },
            ] },
            { type: "LoraLoader", widgets: [
                { name: "lora_name", value: "style.safetensors" },
                { name: "strength_model", value: 0.8 },
            ] },
            // Chaîne de LoRA (widgets lora_name_1 / lora_name_2)
            { type: "LoraStack", widgets: [
                { name: "lora_name_1", value: "lora_a.ckpt" },
                { name: "lora_name_2", value: "lora_b.safetensors" },
            ] },
            { type: "VAELoader", widgets: [{ name: "vae_name", value: "vae-ft.pt" }] },
            { type: "ControlNetLoader", widgets: [{ name: "control_net_name", value: "canny.pth" }] },
            // Valeurs non-modèles / sentinelles : NE DOIVENT PAS ressortir.
            { type: "KSampler", widgets: [
                { name: "seed", value: 42 },
                { name: "sampler_name", value: "euler" },
                { name: "scheduler", value: "normal" },
            ] },
            { type: "SomeLoader", widgets: [{ name: "ckpt_name", value: "None" }] },
            { type: "SomeLoader", widgets: [{ name: "vae_name", value: "" }] },
            // Valeur modèle SANS extension mais widget « modèle » → signal 2.
            { type: "CustomLoader", widgets: [{ name: "unet_name", value: "flux-dev" }] },
            // Tableau de valeurs (embedded_embeddings-like) → extension seule.
            { type: "Embeddings", widgets: [{ name: "extra", value: ["a.safetensors", "not-a-file", "b.gguf"] }] },
        ],
    };
    const names = collectWorkflowModelNames({ graph });
    assert.deepStrictEqual(names, [
        "SDXL/base.safetensors", "style.safetensors", "lora_a.ckpt",
        "lora_b.safetensors", "vae-ft.pt", "canny.pth", "flux-dev",
        "a.safetensors", "b.gguf",
    ], "noms collectés (dossier conservé, non-modèles exclus) : " + JSON.stringify(names));
    ok("nœuds vivants : 9 modèles, non-modèles/sentinelles/numériques exclus");
}

/* ─── 1b. Sous-graphes + anti-cycle ─────────────────────────────────────── */
console.log("1b. Sous-graphes");
{
    const inner = {
        nodes: [{ type: "LoraLoader", widgets: [{ name: "lora_name", value: "inner.safetensors" }] }],
    };
    const subNode = { type: "SubgraphNode", subgraph: inner };
    const root = { nodes: [
        { type: "CheckpointLoaderSimple", widgets: [{ name: "ckpt_name", value: "root.safetensors" }] },
        subNode,
    ] };
    // Cycle volontaire : inner contient un nœud qui repointe vers root → pas de boucle infinie.
    inner.nodes.push({ type: "Back", subgraph: root });
    const names = collectWorkflowModelNames({ graph: root });
    assert.deepStrictEqual(names.sort(), ["inner.safetensors", "root.safetensors"], "sous-graphe parcouru, cycle évité");
    ok("sous-graphes récursifs + protection anti-cycle");
}

/* ─── 2. Repli sérialisé (widgets_values sans noms) ─────────────────────── */
console.log("2. collectWorkflowModelNames — workflow sérialisé");
{
    const wf = {
        nodes: [
            { type: "CheckpointLoaderSimple", widgets_values: ["a.safetensors", "b"] },
            { type: "KSampler", widgets_values: [42, 20, "euler", "normal", 0] },
        ],
        definitions: { subgraphs: [
            { nodes: [{ type: "LoraLoader", widgets_values: ["sub/inner.ckpt"] }] },
        ] },
    };
    const names = collectWorkflowModelNames(wf);
    assert.deepStrictEqual(names.sort(), ["a.safetensors", "sub/inner.ckpt"], "sérialisé : extension seule + sous-graphe");
    ok("repli sérialisé : widgets_values (extension) + definitions.subgraphs");
}

/* ─── 2b. Cas vides / invalides ─────────────────────────────────────────── */
console.log("2b. Cas vides");
{
    assert.deepStrictEqual(collectWorkflowModelNames(null), [], "null → []");
    assert.deepStrictEqual(collectWorkflowModelNames(undefined), [], "undefined → []");
    assert.deepStrictEqual(collectWorkflowModelNames({}), [], "objet vide → []");
    assert.deepStrictEqual(collectWorkflowModelNames({ graph: { nodes: [] } }), [], "graphe sans nœuds → []");
    ok("entrées vides/invalides → aucune exception, tableau vide");
}

/* ─── 3. Normalisation + index + matching ───────────────────────────────── */
console.log("3. Normalisation / matching");
{
    assert.strictEqual(normalizeModelName("checkpoints\\SDXL\\base.SafeTensors"), "base.safetensors", "backslash + casse");
    assert.strictEqual(normalizeModelName("loras/style.safetensors"), "style.safetensors", "dossier retiré");
    assert.strictEqual(normalizeModelName("./a/b.ckpt"), "b.ckpt", "préfixe ./ retiré");
    assert.strictEqual(normalizeModelName(""), "", "vide");
    assert.strictEqual(normalizeModelName(42), "", "non-string → ''");
    ok("normalizeModelName : basename + minuscules");

    const idx = buildWorkflowNameIndex(["SDXL/base.safetensors", "style.safetensors"]);
    assert.strictEqual(idx.size, 2, "index de 2 entrées");
    assert.ok(isModelInWorkflow({ name: "base.safetensors" }, idx), "match par basename");
    assert.ok(isModelInWorkflow({ path: "checkpoints/SDXL/base.SafeTensors" }, idx), "match par chemin + casse");
    assert.ok(!isModelInWorkflow({ name: "absent.safetensors" }, idx), "absence → false");
    assert.ok(!isModelInWorkflow(null, idx), "item null → false");
    assert.ok(!isModelInWorkflow({ name: "base.safetensors" }, new Set()), "index vide → false");
    ok("isModelInWorkflow : basename/chemin/casse, absence et index vide");
}

/* ─── 4. Filtres génériques (cumul) ─────────────────────────────────────── */
console.log("4. filterModelItems — cumul types + recherche + workflow");
{
    const items = [
        { name: "base.safetensors", type: "checkpoint" },
        { name: "style.safetensors", type: "lora" },
        { name: "other.safetensors", type: "lora" },
        { name: "unused.safetensors", type: "vae" },
    ];
    const wf = buildWorkflowNameIndex(["base.safetensors", "style.safetensors", "missing.safetensors"]);

    assert.strictEqual(filterModelItems(items, {}).length, 4, "aucun filtre → tout");
    assert.strictEqual(filterModelItems(items, { types: ["lora"] }).length, 2, "type seul");
    assert.strictEqual(filterModelItems(items, { search: "STYLE" }).length, 1, "recherche seule (casse)");
    assert.strictEqual(filterModelItems(items, { workflowIndex: wf }).length, 2, "workflow seul");
    // Cumul : type lora ET workflow → seul style.
    const cumul = filterModelItems(items, { types: ["lora"], search: "style", workflowIndex: wf });
    assert.deepStrictEqual(cumul.map((i) => i.name), ["style.safetensors"], "lora + recherche + workflow");
    // Workflow actif mais AUCUN modèle → filtre strict (0).
    assert.strictEqual(filterModelItems(items, { workflowIndex: new Set() }).length, 0, "index vide → 0");
    // Workflow inactif (null) → pas de filtrage workflow.
    assert.strictEqual(filterModelItems(items, { workflowIndex: null }).length, 4, "null → pas de filtre");
    ok("filterModelItems : cumul types+recherche+workflow, index vide strict, null neutre");
}

/* ─── 4b. filterModelsByWorkflow (liste distante, client-side) ──────────── */
console.log("4b. filterModelsByWorkflow");
{
    const remote = [
        { name: "base.safetensors", id: "1" },
        { filename: "style.safetensors", id: "2" },
        { original_name: "unused.safetensors", id: "3" },
    ];
    const wf = buildWorkflowNameIndex(["base.safetensors", "style.safetensors"]);
    assert.deepStrictEqual(
        filterModelsByWorkflow(remote, wf).map((i) => i.id), ["1", "2"],
        "filtre distant sur name/filename"
    );
    assert.strictEqual(filterModelsByWorkflow(remote, null).length, 3, "null → tout (copie)");
    assert.strictEqual(filterModelsByWorkflow(remote, new Set()).length, 0, "Set vide → rien");
    assert.deepStrictEqual(filterModelsByWorkflow(null, wf), [], "items null → []");
    ok("filterModelsByWorkflow : name/filename, null neutre, Set vide strict");
}

/* ─── 5. Récapitulatif (présent local / distant) ────────────────────────── */
console.log("5. countWorkflowMatches");
{
    const idx = buildWorkflowNameIndex(["base.safetensors", "style.safetensors", "vae.safetensors"]);
    const local = [{ name: "base.safetensors" }, { name: "style.safetensors" }];
    const remote = [{ filename: "base.safetensors" }];
    assert.strictEqual(countWorkflowMatches(local, idx), 2, "2 modèles du workflow présents en local");
    assert.strictEqual(countWorkflowMatches(remote, idx), 1, "1 présent en distant");
    assert.strictEqual(countWorkflowMatches(local, new Set()), 0, "index vide → 0");
    assert.strictEqual(countWorkflowMatches(null, idx), 0, "items null → 0");
    ok("countWorkflowMatches : local/distant, index vide et items null");
}

/* ─── 6. CONTRÔLES NÉGATIFS ─────────────────────────────────────────────── */
console.log("6. Contrôles négatifs");
{
    // Aucune valeur non-modèle ne doit être extraite.
    const junk = { nodes: [
        { type: "KSampler", widgets: [
            { name: "seed", value: "12345" },
            { name: "steps", value: "20" },
            { name: "sampler_name", value: "dpmpp_2m" },
            { name: "cfg", value: "7.5" },
            { name: "filename_prefix", value: "ComfyUI" },
            { name: "text", value: "a prompt that mentions model.safetensors in prose" },
        ] },
    ] };
    assert.deepStrictEqual(collectWorkflowModelNames({ graph: junk }), [], "prompt/numériques → aucun modèle");
    ok("contrôle négatif : valeurs non-modèles ignorées (dont prompt citant un fichier)");

    // « looksLikeModelFile » ne doit pas matcher un suffixe proche.
    assert.ok(looksLikeModelFile("m.safetensors"), "extension exacte matchée");
    assert.ok(!looksLikeModelFile("m.safetensors.bak"), "suffixe .bak ne matche pas");
    assert.ok(!looksLikeModelFile("model.ptx"), ".ptx ne matche pas .pt");
    assert.ok(!looksLikeModelFile("foo.ckptx"), ".ckptx ne matche pas");
    assert.ok(!looksLikeModelFile(""), "vide non-matché");
    ok("contrôle négatif : extensions proches (.ptx/.bak) non prises pour des modèles");

    // isModelWidgetName : « name » requis + mot-clé catégorie.
    assert.ok(isModelWidgetName("ckpt_name"), "ckpt_name");
    assert.ok(isModelWidgetName("lora_name_3"), "lora_name_3");
    assert.ok(!isModelWidgetName("sampler_name"), "sampler_name non modèle");
    assert.ok(!isModelWidgetName("filename_prefix"), "filename_prefix non modèle");
    assert.ok(!isModelWidgetName("seed"), "seed non modèle");
    ok("contrôle négatif : isModelWidgetName ne confond pas sampler_name/filename_prefix");

    // Régression : aucune extension vide ou dupliquée.
    assert.ok(MODEL_FILE_EXTENSIONS.every((e) => e.startsWith(".")), "toutes les extensions commencent par .");
    ok("intégrité de MODEL_FILE_EXTENSIONS");
}

console.log(`\n✅ test_aih_model_workflow : ${n} groupes PASSENT`);
