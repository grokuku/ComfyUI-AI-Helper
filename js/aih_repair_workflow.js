/*
 * Copyright (C) 2026 Holaf
 * AIH Repair Workflow — « Réparer un workflow » (réparation AU NIVEAU JSON)
 * ----------------------------------------------------------------------------
 * Réagit à un constat réel : les hooks post-swap de ComfyUI (change_node_type)
 * re-résolvent les connexions sur le graphe VIVANT et ont déjà détruit des
 * liens. Réparer la sérialisation JSON est déterministe et vérifiable.
 *
 * Le CŒUR MÉTIER (analyse + réparation + validation) vit côté PYTHON
 * (aih/repair_workflow.py, routes /aih/repair/*) : ce module ne fait que
 * l'UI et les appels réseau. C'est ce qui rend la logique testable hors ligne.
 *
 * Ergonomie (spécification utilisateur) :
 *   1. Sources : sélection MULTIPLE de workflows SAUVEGARDÉS et/ou collage
 *      de texte JSON.
 *   2. « Analyser » → problèmes GROUPÉS : UNE ligne par TYPE de node absent
 *      (« HolafRemoteComparer → AIHRemoteComparer · 12 occurrences »), jamais
 *      12 lignes. Chaque ligne est cochable (+ tout cocher / tout décocher),
 *      avec un détail repliable des emplacements (racine/subgraph + ids).
 *   3. « Réparer » n'applique QUE les lignes cochées.
 *   4. Sortie : JSON collé → « Copier » / « Enregistrer sous » ;
 *      fichiers sélectionnés → « Écraser » / « Enregistrer sous ».
 *
 * EXTENSIBILITÉ : l'UI ne connaît PAS les types de problèmes en dur ; elle
 * rend la liste renvoyée par le serveur (id, kind, old_type, new_type, count,
 * occurrences, checkable, action). Ajouter un détecteur Python suffit.
 *
 * i18n : clés FR/EN enregistrées via AIH.I18n.addDict (parité stricte).
 * Dépendances : aih_dialog.js (AIH.Dialog), aih_i18n.js, aih_strings.js.
 */

import "./aih_dialog.js";
import "./aih_strings.js";
import { holafExtUrl } from "./holaf_ext_base.js";

(function () {
    "use strict";

    const AIH = (window.AIH = window.AIH || {});
    const t = (key, params) => {
        const I = AIH.I18n;
        return I && typeof I.t === "function" ? I.t(key, params) : key;
    };

    // ─── Dictionnaires (parité FR/EN STRICTE) ───────────────────────────────
    // Les clés « rw.* » / « menu.repairWorkflow » sont enregistrées de façon
    // CENTRALISÉE dans js/aih_strings.js (convention du pack : un seul fichier
    // de dictionnaires centraux). Ce module ne fait que les consommer via t().

    // ══════════════════════════════════════════════════════════════════════
    // Helpers PURS (testables sans DOM)
    // ══════════════════════════════════════════════════════════════════════

    function problemId(p) {
        if (p && p.id) return p.id;
        const kind = (p && p.kind) || "problem";
        const from = p && p.old_type != null ? p.old_type : "";
        const to = p && p.new_type != null ? p.new_type : "";
        return kind + "|" + from + "|" + to;
    }

    /**
     * Garantit UNE entrée par TYPE de problème (regroupement par id).
     *
     * Le serveur groupe déjà, mais cette fonction est le filet de sécurité
     * côté client de l'exigence utilisateur : jamais une ligne par occurrence.
     * Si le serveur renvoyait des entrées par occurrence, elles sont fusionnées.
     */
    function groupProblems(rawProblems) {
        const byId = new Map();
        const order = [];
        for (const raw of rawProblems || []) {
            if (!raw || typeof raw !== "object") continue;
            const id = problemId(raw);
            let entry = byId.get(id);
            if (!entry) {
                entry = {
                    id,
                    kind: raw.kind,
                    old_type: raw.old_type,
                    new_type: raw.new_type,
                    checkable: raw.checkable !== false,
                    action: raw.action || null,
                    occurrences: [],
                    count: 0,
                };
                byId.set(id, entry);
                order.push(id);
            }
            if (Array.isArray(raw.occurrences)) entry.occurrences.push(...raw.occurrences);
            if (!entry.action && raw.action) entry.action = raw.action;
            if (raw.checkable === false) entry.checkable = false;
        }
        return order.map((id) => {
            const e = byId.get(id);
            e.count = e.occurrences.length || e.count || 0;
            return e;
        });
    }

    function scopeLabel(scope) {
        if (!scope || scope === "root") return t("rw.scope.root");
        return String(scope).split(" › ").map((p, i) => (i === 0 ? t("rw.scope.root") : p)).join(" › ");
    }

    function ensureJsonExt(name) {
        const n = String(name || "").trim();
        if (!n) return "";
        return /\.json$/i.test(n) ? n : n + ".json";
    }

    function deriveSaveAs(baseName, index, total) {
        const clean = ensureJsonExt(baseName);
        if (total <= 1) return clean;
        const stem = clean.replace(/\.json$/i, "");
        return stem + (index === 0 ? "" : "-" + (index + 1)) + ".json";
    }

    // ══════════════════════════════════════════════════════════════════════
    // API par défaut (routes du pack)
    // ══════════════════════════════════════════════════════════════════════

    function doFetch(url, opts) {
        const g = typeof window !== "undefined" ? window : globalThis;
        if (g.api && typeof g.api.fetchApi === "function") return g.api.fetchApi(url, opts);
        return fetch(url, opts);
    }

    async function parseJsonResponse(res) {
        if (!res || !res.ok) {
            const status = res ? res.status : "?";
            throw new Error("HTTP " + status);
        }
        return res.json();
    }

    function postJson(url, payload) {
        return doFetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        }).then(parseJsonResponse);
    }

    const defaultApi = {
        listWorkflows: () => doFetch("/aih/repair/workflows").then(parseJsonResponse),
        analyze: (payload) => postJson("/aih/repair/analyze", payload),
        apply: (payload) => postJson("/aih/repair/apply", payload),
    };

    // ══════════════════════════════════════════════════════════════════════
    // Montage de l'UI (deps injectables → testable)
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Construit toute l'UI dans `container`.
     *
     * @param {HTMLElement} container
     * @param {object} deps  {document, t, api, confirm, prompt, copyText, notify}
     * @returns {object} controller { state, analyze, repair, applyOutput, setPasted, setCheckedFiles }
     */
    function mountRepairUI(container, deps) {
        const doc = deps.document || (typeof document !== "undefined" ? document : null);
        const tr = deps.t || t;
        const api = deps.api || defaultApi;
        const confirmFn = deps.confirm || ((title, msg) => AIH.confirm(title, msg));
        const promptFn = deps.prompt || ((title, msg) => AIH.prompt(title, msg));
        const notify = deps.notify || (() => {});
        const copyText = deps.copyText || (async (text) => {
            if (typeof navigator !== "undefined" && navigator.clipboard) {
                return navigator.clipboard.writeText(text);
            }
            throw new Error("no clipboard");
        });

        const state = {
            workflows: [],
            checkedFiles: new Set(),
            pasted: "",
            analysis: null,
            selected: new Set(),
            repaired: null,
            busy: false,
        };

        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined && text !== null) n.textContent = text;
            return n;
        };

        // ── Section 1 : sources ─────────────────────────────────────────────
        const sourcesSection = el("div", "rw-section rw-sources");
        sourcesSection.appendChild(el("div", "rw-section-title", tr("rw.section.sources")));

        const savedTitle = el("div", "rw-subsection-title", tr("rw.saved.title"));
        const savedList = el("div", "rw-saved-list");
        const savedCount = el("span", "rw-saved-count", "");
        sourcesSection.appendChild(savedTitle);
        sourcesSection.appendChild(savedList);
        sourcesSection.appendChild(savedCount);

        const pasteTitle = el("div", "rw-subsection-title", tr("rw.paste.title"));
        const pasteArea = el("textarea", "rw-paste");
        pasteArea.setAttribute("placeholder", tr("rw.paste.placeholder"));
        pasteArea.setAttribute("rows", "6");
        const pasteHint = el("div", "rw-hint", tr("rw.paste.hint"));
        sourcesSection.appendChild(pasteTitle);
        sourcesSection.appendChild(pasteArea);
        sourcesSection.appendChild(pasteHint);
        container.appendChild(sourcesSection);

        // ── Bouton Analyser ─────────────────────────────────────────────────
        const analyzeBar = el("div", "rw-actions");
        const analyzeBtn = el("button", "rw-btn rw-btn-primary", tr("rw.analyze"));
        analyzeBtn.setAttribute("data-rw-analyze", "1");
        analyzeBar.appendChild(analyzeBtn);
        container.appendChild(analyzeBar);

        // ── Section 2 : résultats ───────────────────────────────────────────
        const resultsSection = el("div", "rw-section rw-results");
        resultsSection.style.display = "none";
        resultsSection.appendChild(el("div", "rw-section-title", tr("rw.section.results")));
        const resultsSummary = el("div", "rw-summary", "");
        const checkAllBar = el("div", "rw-actions");
        const checkAllBtn = el("button", "rw-btn", tr("rw.checkAll"));
        const uncheckAllBtn = el("button", "rw-btn", tr("rw.uncheckAll"));
        checkAllBar.appendChild(checkAllBtn);
        checkAllBar.appendChild(uncheckAllBtn);
        const problemsWrap = el("div", "rw-problems");
        resultsSection.appendChild(resultsSummary);
        resultsSection.appendChild(checkAllBar);
        resultsSection.appendChild(problemsWrap);
        container.appendChild(resultsSection);

        // ── Section 3 : réparer ─────────────────────────────────────────────
        const repairBar = el("div", "rw-actions rw-repair-bar");
        repairBar.style.display = "none";
        const repairBtn = el("button", "rw-btn rw-btn-primary", tr("rw.repair"));
        repairBtn.setAttribute("data-rw-repair", "1");
        repairBar.appendChild(repairBtn);
        container.appendChild(repairBar);

        // ── Section 4 : sortie ──────────────────────────────────────────────
        const outputSection = el("div", "rw-section rw-output");
        outputSection.style.display = "none";
        outputSection.appendChild(el("div", "rw-section-title", tr("rw.section.output")));
        const outputHint = el("div", "rw-hint", tr("rw.output.hint"));
        const outputSummary = el("div", "rw-summary", "");
        const outputBar = el("div", "rw-actions");
        const copyBtn = el("button", "rw-btn", tr("rw.copy"));
        const saveAsBtn = el("button", "rw-btn", tr("rw.saveAs"));
        const overwriteBtn = el("button", "rw-btn rw-btn-danger", tr("rw.overwrite"));
        copyBtn.setAttribute("data-rw-copy", "1");
        saveAsBtn.setAttribute("data-rw-saveas", "1");
        overwriteBtn.setAttribute("data-rw-overwrite", "1");
        outputBar.appendChild(copyBtn);
        outputBar.appendChild(saveAsBtn);
        outputBar.appendChild(overwriteBtn);
        outputSection.appendChild(outputHint);
        outputSection.appendChild(outputSummary);
        outputSection.appendChild(outputBar);
        container.appendChild(outputSection);

        // ── Chargement des workflows sauvegardés ────────────────────────────
        function renderSaved() {
            savedList.innerHTML = "";
            if (!state.workflows.length) {
                savedList.appendChild(el("div", "rw-hint", tr("rw.saved.empty")));
            }
            for (const wf of state.workflows) {
                const row = el("label", "rw-saved-row");
                const cb = doc.createElement("input");
                cb.type = "checkbox";
                cb.className = "rw-saved-check";
                cb.setAttribute("data-path", wf.path);
                cb.checked = state.checkedFiles.has(wf.path);
                cb.addEventListener("change", () => {
                    if (cb.checked) state.checkedFiles.add(wf.path);
                    else state.checkedFiles.delete(wf.path);
                    updateSavedCount();
                });
                const name = el("span", "rw-saved-name", wf.path || wf.name);
                row.appendChild(cb);
                row.appendChild(name);
                savedList.appendChild(row);
            }
            updateSavedCount();
        }

        function updateSavedCount() {
            savedCount.textContent = tr("rw.saved.count", { count: state.checkedFiles.size });
        }

        async function loadWorkflows() {
            savedList.innerHTML = "";
            savedList.appendChild(el("div", "rw-hint", tr("rw.saved.loading")));
            try {
                const data = await api.listWorkflows();
                state.workflows = (data && data.workflows) || [];
            } catch (e) {
                state.workflows = [];
                savedList.innerHTML = "";
                savedList.appendChild(el("div", "rw-hint rw-error", tr("rw.saved.error", { message: e.message })));
                return;
            }
            renderSaved();
        }

        // ── Construction des sources à envoyer ──────────────────────────────
        function buildSources() {
            const sources = [];
            const pasted = pasteArea.value.trim();
            if (pasted) {
                sources.push({ id: "pasted", kind: "pasted", name: "JSON", content: pasted });
            }
            for (const path of Array.from(state.checkedFiles)) {
                sources.push({ id: "file:" + path, kind: "file", path, name: path });
            }
            return sources;
        }

        function hasPasted(sources) {
            return sources.some((s) => s.kind === "pasted");
        }
        function hasFiles(sources) {
            return sources.some((s) => s.kind === "file");
        }

        // ── Rendu des problèmes (UNE ligne par type) ────────────────────────
        function problemLabel(problem) {
            if (problem.old_type && problem.new_type) {
                return tr("rw.problem.replacement", { from: problem.old_type, to: problem.new_type });
            }
            if (problem.old_type) {
                return problem.old_type + " — " + tr("rw.problem.noReplacement");
            }
            return problem.kind;
        }

        function renderProblem(problem) {
            const row = el("div", "rw-problem");
            row.setAttribute("data-problem-id", problem.id);
            row.setAttribute("data-count", String(problem.count));

            const head = el("div", "rw-problem-head");
            const cb = doc.createElement("input");
            cb.type = "checkbox";
            cb.className = "rw-problem-check";
            cb.setAttribute("data-problem-id", problem.id);
            cb.disabled = problem.checkable === false;
            cb.checked = problem.checkable !== false && state.selected.has(problem.id);
            cb.addEventListener("change", () => {
                if (cb.checked) state.selected.add(problem.id);
                else state.selected.delete(problem.id);
            });
            const label = el("span", "rw-problem-label", problemLabel(problem));
            const count = el("span", "rw-problem-count", tr("rw.occurrences", { count: problem.count }));
            const toggle = el("button", "rw-problem-toggle", "▸");

            head.appendChild(cb);
            head.appendChild(label);
            head.appendChild(count);
            head.appendChild(toggle);
            row.appendChild(head);

            const details = el("div", "rw-problem-details");
            details.style.display = "none";
            const detailTitle = el("div", "rw-detail-title", tr("rw.occurrences.detail"));
            const ul = el("ul", "rw-detail-list");
            for (const occ of problem.occurrences || []) {
                const src = occ.source_name ? occ.source_name + " · " : "";
                ul.appendChild(el("li", null, src + scopeLabel(occ.scope) + " · node #" + occ.node_id));
            }
            details.appendChild(detailTitle);
            details.appendChild(ul);
            toggle.addEventListener("click", () => {
                const shown = details.style.display !== "none";
                details.style.display = shown ? "none" : "block";
                toggle.textContent = shown ? "▸" : "▾";
            });
            row.appendChild(details);

            if (problem.checkable === false) row.classList.add("rw-problem-unmapped");
            return row;
        }

        function renderAnalysis(analysis) {
            const problems = groupProblems(analysis.problems || []);
            state.analysis = { ...analysis, problems };
            resultsSection.style.display = "";
            problemsWrap.innerHTML = "";

            const totalOcc = problems.reduce((n, p) => n + (p.count || 0), 0);
            resultsSummary.textContent = tr("rw.results.summary", {
                problems: problems.length,
                occurrences: totalOcc,
            });

            if (!problems.length) {
                problemsWrap.appendChild(el("div", "rw-hint rw-ok", tr("rw.results.empty")));
            }
            for (const problem of problems) {
                problemsWrap.appendChild(renderProblem(problem));
            }

            // Par défaut, tout ce qui est cochable est coché (l'utilisateur peut décocher).
            state.selected = new Set(
                problems.filter((p) => p.checkable !== false).map((p) => p.id)
            );
            for (const cb of problemsWrap.querySelectorAll(".rw-problem-check")) {
                cb.checked = !cb.disabled && state.selected.has(cb.getAttribute("data-problem-id"));
            }

            repairBar.style.display = problems.length ? "" : "none";
            outputSection.style.display = "none";
            state.repaired = null;
        }

        function setProblemChecked(checked) {
            for (const problem of (state.analysis && state.analysis.problems) || []) {
                if (problem.checkable === false) continue;
                if (checked) state.selected.add(problem.id);
                else state.selected.delete(problem.id);
            }
            for (const cb of problemsWrap.querySelectorAll(".rw-problem-check")) {
                cb.checked = !cb.disabled && checked;
            }
        }

        // ── Analyser ────────────────────────────────────────────────────────
        async function analyze() {
            if (state.busy) return;
            const sources = buildSources();
            if (!sources.length) {
                notify(tr("rw.needSource"), "warning");
                return;
            }
            state.busy = true;
            analyzeBtn.disabled = true;
            analyzeBtn.textContent = tr("rw.analyzing");
            try {
                const analysis = await api.analyze({ sources });
                renderAnalysis(analysis || { problems: [] });
            } catch (e) {
                notify(tr("rw.errorPrefix", { message: e.message }), "error");
            } finally {
                state.busy = false;
                analyzeBtn.disabled = false;
                analyzeBtn.textContent = tr("rw.analyze");
            }
        }

        // ── Réparer (aperçu, sans écriture) ─────────────────────────────────
        async function repair() {
            if (state.busy) return;
            const sources = buildSources();
            if (!sources.length) {
                notify(tr("rw.needSource"), "warning");
                return;
            }
            if (!state.selected.size) {
                notify(tr("rw.needSelection"), "warning");
                return;
            }
            state.busy = true;
            repairBtn.disabled = true;
            repairBtn.textContent = tr("rw.repairing");
            try {
                const res = await api.apply({
                    sources,
                    selected: Array.from(state.selected),
                    mode: "preview",
                });
                state.repaired = res;
                renderOutput(res, sources);
            } catch (e) {
                notify(tr("rw.errorPrefix", { message: e.message }), "error");
            } finally {
                state.busy = false;
                repairBtn.disabled = false;
                repairBtn.textContent = tr("rw.repair");
            }
        }

        function renderOutput(res, sources) {
            outputSection.style.display = "";
            const results = (res && res.results) || [];
            const sums = results.map((r) => r.summary || {});
            const nodes = sums.reduce((n, s) => n + (s.nodes_renamed || 0), 0);
            const remapped = sums.reduce((n, s) => n + (s.widgets_remapped || 0), 0);
            const unmapped = sums.reduce((n, s) => n + (s.widgets_unmapped || 0), 0);
            const pre = sums.reduce((n, s) => n + (s.pre_existing_validation_errors || 0), 0);
            let txt = tr("rw.repairedSummary", { nodes, remapped, unmapped });
            if (pre) txt += " · " + tr("rw.preExisting", { count: pre });
            outputSummary.textContent = txt;

            copyBtn.style.display = hasPasted(sources) ? "" : "none";
            overwriteBtn.style.display = hasFiles(sources) ? "" : "none";
            saveAsBtn.style.display = "";
        }

        // ── Sorties ─────────────────────────────────────────────────────────
        async function copyOutput() {
            const results = (state.repaired && state.repaired.results) || [];
            const pasted = results.find((r) => r.kind === "pasted");
            const target = pasted || results[0];
            if (!target || !target.repaired) {
                notify(tr("rw.output.noneChecked"), "warning");
                return;
            }
            try {
                await copyText(JSON.stringify(target.repaired, null, 2));
                notify(tr("rw.copied"), "success");
            } catch (e) {
                notify(tr("rw.copyFailed", { message: e.message }), "error");
            }
        }

        async function applyOutput(mode, saveAsName) {
            let sources = buildSources();
            if (mode === "overwrite") {
                // « Écraser » ne concerne que les fichiers sauvegardés.
                sources = sources.filter((s) => s.kind === "file");
            }
            if (!sources.length) {
                notify(tr("rw.needSource"), "warning");
                return;
            }
            const payload = {
                sources,
                selected: Array.from(state.selected),
                mode,
            };
            if (mode === "save_as") {
                const total = sources.length;
                sources.forEach((src, idx) => {
                    src.save_as = deriveSaveAs(saveAsName, idx, total);
                });
                payload.save_as = deriveSaveAs(saveAsName, 0, total);
            }
            try {
                const res = await api.apply(payload);
                const results = (res && res.results) || [];
                for (const r of results) {
                    if (r.written) {
                        notify(tr("rw.saved", { path: r.dest }), "success");
                        if (r.backup) notify(tr("rw.backupCreated", { path: r.backup }), "info");
                    } else if (r.error === "validation_failed") {
                        notify(tr("rw.validationFailed"), "error");
                    } else if (r.message) {
                        notify(r.message, "error");
                    }
                }
                if ((res && res.errors || []).length) {
                    for (const e of res.errors) notify(e.message || String(e), "error");
                }
            } catch (e) {
                notify(tr("rw.errorPrefix", { message: e.message }), "error");
            }
        }

        async function saveAs() {
            const total = buildSources().length;
            const suggested = total === 1 ? "repaired.json" : "repaired";
            const name = await promptFn(tr("rw.saveAsPromptTitle"), tr("rw.saveAsPrompt"), suggested);
            if (!name) return;
            await applyOutput("save_as", String(name));
        }

        async function overwrite() {
            const ok = await confirmFn(tr("rw.overwriteConfirmTitle"), tr("rw.overwriteConfirm"));
            if (!ok) return;
            await applyOutput("overwrite");
        }

        // ── Écouteurs ───────────────────────────────────────────────────────
        analyzeBtn.addEventListener("click", analyze);
        repairBtn.addEventListener("click", repair);
        copyBtn.addEventListener("click", copyOutput);
        saveAsBtn.addEventListener("click", saveAs);
        overwriteBtn.addEventListener("click", overwrite);
        checkAllBtn.addEventListener("click", () => setProblemChecked(true));
        uncheckAllBtn.addEventListener("click", () => setProblemChecked(false));
        pasteArea.addEventListener("input", () => { state.pasted = pasteArea.value; });

        loadWorkflows();

        return {
            state,
            el: container,
            analyze,
            repair,
            copyOutput,
            applyOutput,
            saveAs,
            overwrite,
            setProblemChecked,
            renderAnalysis,
            buildSources,
            setPasted: (text) => { pasteArea.value = text; state.pasted = text; },
            getPasted: () => pasteArea.value,
            setCheckedFiles: (paths) => {
                state.checkedFiles = new Set(paths);
                for (const cb of savedList.querySelectorAll(".rw-saved-check")) {
                    cb.checked = state.checkedFiles.has(cb.getAttribute("data-path"));
                }
                updateSavedCount();
            },
        };
    }

    // ══════════════════════════════════════════════════════════════════════
    // Ouverture de la fenêtre
    // ══════════════════════════════════════════════════════════════════════

    // ─── Injection de la feuille de style dédiée (idempotent) ──────────────
    const REPAIR_CSS_ID = "aih-repair-workflow-css";
    const REPAIR_CSS_HREF = "css/aih_repair_workflow.css";
    function ensureRepairCss() {
        if (typeof document === "undefined") return;
        if (document.getElementById(REPAIR_CSS_ID)) return;
        const link = document.createElement("link");
        link.id = REPAIR_CSS_ID;
        link.rel = "stylesheet";
        link.type = "text/css";
        link.href = holafExtUrl(REPAIR_CSS_HREF);
        document.head.appendChild(link);
    }

    function open() {
        if (!AIH.Dialog || typeof AIH.Dialog.open !== "function") {
            AIH.alert(t("dialog.error"), t("rw.menuUnavailable"));
            return null;
        }
        ensureRepairCss();
        return AIH.Dialog.open({
            id: "aih-repair-workflow",
            title: t("rw.title"),
            width: "640px",
            height: "620px",
            minWidth: "420px",
            minHeight: "360px",
            resizable: true,
            draggable: true,
            modal: false,
            content: (body) => {
                mountRepairUI(body, { t });
            },
        });
    }

    AIH.RepairWorkflow = {
        open,
        mountRepairUI,
        groupProblems,
        problemId,
        scopeLabel,
        ensureJsonExt,
        deriveSaveAs,
        _t: t,
    };
    window.AIHRepairWorkflow = AIH.RepairWorkflow;
})();
