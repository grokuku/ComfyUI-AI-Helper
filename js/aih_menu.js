/**
 * AIH — Menu helpers (portage de AI-Helper/web/js/aih_menu.js).
 *
 * Note pack fusionné : ce fichier ne crée PLUS son propre bouton de menu
 * (l'ancien bouton indigo « AI Helper ▾ » est remplacé par le menu orange
 * Holaf Utilities). Il expose window.AIHMenu (pattern merge sûr) et
 * holaf_main.js intègre ses entrées dans le dropdown existant.
 *
 * Contenu porté :
 *   - openWebpage / openWorkflows / openModels : raccourcis du menu source.
 *   - openMembers        : modale draggable aihOpenModalV2 (key
 *                          "aih-modal-members"), GET {serverUrl}/api/members.
 *   - openSettings       : ouvre la fenêtre Settings AIH unifiée (panel
 *                          #holaf-settings-panel de js/holaf_settings_manager.js)
 *                          sur l'onglet AIH demandé. Les onglets eux-mêmes
 *                          (« Compte » : GET/POST /aih/credentials + migration
 *                          automatique depuis localStorage ; « Provider LLM » :
 *                          CRUD distant api/presets + list-models + mode
 *                          Client-side) sont rendus par renderAccountTab() /
 *                          renderProviderTab(), appelés par le gestionnaire
 *                          Settings AIH comme ses propres onglets.
 *   - openUpdate         : modale spinner + log git de POST /aih/update ;
 *                          si updated → confirmation utilisateur puis
 *                          redémarrage via le flux COMMUN du menu
 *                          (window.holaf.startRestartFlow de holaf_main.js :
 *                          POST /holaf/utilities/restart + compteur à rebours
 *                          + reconnexion). C'est l'unique façon de redémarrer.
 *                          Si ce flux commun n'est pas disponible, fallback
 *                          propre (toast + reload manuel) — pas de double
 *                          polling/reload local.
 *   - checkServerStatus  : GET {serverUrl}/api/stats + /api/auth/me en
 *                          parallèle (timeout 5 s, Bearer apiKey) → ligne de
 *                          statut du pied de menu.
 *   - getBlobbyState / toggleBlobby : état du Blobby Companion pour la ligne
 *                          toggle du menu.
 *
 * Dépendances : 01_aih_modal_v2.js (aihOpenModalV2, aihShowAlert,
 * aihShowConfirm, aihShowPrompt), 03_aih_shared.js (localStorage
 * "AIH_config", même mécanique que window.AIH), blobby_companion.js
 * (window.BlobbyCompanion). Endpoints locaux : /aih/update,
 * /aih/credentials, /holaf/utilities/restart (cf. aih/routes.py).
 */
import "./aih_dialog.js";
import "./aih_strings.js";
import { showToast } from "./aih_toast_bridge.js";
import { remoteGet, remoteRequest } from "./aih_fetch_bridge.js";
import { HolafFetch } from "./vendor/holaf/holaf-fetch.js";
import { escapeHtml } from "./holaf_dom_utils.js";
(function () {
    "use strict";

    const STORAGE_KEY = "AIH_config";

    // ── Helper i18n central : traduit via AIH.I18n (clé brute si absente) ──
    const t = (key, params) => {
        const I = window.AIH && window.AIH.I18n;
        return I && typeof I.t === "function" ? I.t(key, params) : key;
    };

    // Libellé lisible d'un échec HTTP : évite le cosmétique « HTTP undefined »
    // quand le statut est absent (échec réseau avant toute réponse). La valeur
    // est une DONNÉE d'origine serveur/transport : elle est échappée au moment
    // de l'interpolation HTML (escapeHtml), jamais insérée brute.
    const httpStatusLabel = (e) => (e && e.status) ? `HTTP ${e.status}` : t("menu.httpNetworkError");

    function getConfig() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
        catch { return {}; }
    }

    function setConfig(cfg) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    }

    function getApp() {
        return window.app || window.comfyAPI?.app?.app || null;
    }

    // ── Raccourcis du menu ───────────────────────────────────────────────

    function openWebpage() {
        // Aucune URL par défaut codée en dur : si le serveur n'est pas
        // configuré, on invite l'utilisateur à le faire dans Settings.
        const baseUrl = (getConfig().serverUrl || "").replace(/\/+$/, "");
        if (!baseUrl) {
            const msg = t("menu.urlNotConfiguredMsg");
            showToast({ message: msg, type: "info", duration: 8000 });
            return;
        }
        window.open(baseUrl, "_blank");
    }

    function openWorkflows() {
        if (window.openWorkflowManager) {
            window.openWorkflowManager();
        } else {
            if (window.aihShowAlert) window.aihShowAlert(t("aih.info"), t("aih.workflowsNotLoaded"), "info");
        }
    }

    function openModels() {
        if (window.openModelBrowser) {
            window.openModelBrowser();
        } else {
            if (window.aihShowAlert) window.aihShowAlert(t("aih.info"), t("aih.modelBrowserNotLoaded"), "info");
        }
    }

    // ── Blobby Companion (état pour la ligne toggle du menu) ────────────

    function getBlobbyState() {
        try {
            return !!(window.BlobbyCompanion && window.BlobbyCompanion.isActive && window.BlobbyCompanion.isActive());
        } catch { return false; }
    }

    function toggleBlobby() {
        if (window.BlobbyCompanion && window.BlobbyCompanion.toggle) {
            return !!window.BlobbyCompanion.toggle();
        }
        return getBlobbyState();
    }

    function openChat() {
        if (window.BlobbyCompanion && window.BlobbyCompanion.openChat) {
            window.BlobbyCompanion.openChat();
        }
    }

    // ── Membres ──────────────────────────────────────────────────────────

    // Charge et rend la liste des membres. Réutilisable après suppression
    // pour rafraîchir la table sans refermer la modale.
    async function refreshMembers(modal, baseUrl) {
        const [members, me] = await Promise.all([
            remoteGet(`${baseUrl}/api/members`).catch((e) => { throw new Error(httpStatusLabel(e)); }),
            remoteGet(`${baseUrl}/api/auth/me`).catch(() => null),
        ]);

        const currentUserId = me && me.id ? me.id : null;
        // La suppression d'un membre est une action admin : on n'affiche le
        // bouton que pour un utilisateur courant admin (la BDD fait foi). Le
        // serveur re-impose la garde _admin_required de toute façon.
        const canManage = !!(me && me.role === "admin");

        // Trier : admin en premier, puis kw_editor, puis par nom
        members.sort((a, b) => {
            const rank = (r) => r === "admin" ? 0 : r === "kw_editor" ? 1 : 2;
            const diff = rank(a.role) - rank(b.role);
            if (diff !== 0) return diff;
            return (a.display_name || a.username || "").localeCompare(b.display_name || b.username || "");
        });

        let html = `<table style="width:100%;border-collapse:collapse;font-size:12px;color:#ccc;">
            <thead>
                <tr style="border-bottom:1px solid #555;">
                    <th style="text-align:left;padding:6px 8px;color:#888;font-weight:600;">${t("menu.colMember")}</th>
                    <th style="text-align:center;padding:6px 4px;color:#888;font-weight:600;">${t("menu.colRole")}</th>
                    <th style="text-align:center;padding:6px 4px;color:#888;font-weight:600;">${t("menu.colFilters")}</th>
                    <th style="text-align:center;padding:6px 4px;color:#888;font-weight:600;">${t("menu.colPrompts")}</th>
                    <th style="text-align:center;padding:6px 4px;color:#888;font-weight:600;">${t("menu.colActions")}</th>
                </tr>
            </thead><tbody>`;

        for (const m of members) {
            const name = m.display_name || m.username || m.id?.substring(0, 8) || "?";
            // Toute valeur fournie par le serveur est échappée AVANT d'être
            // interpolée en innerHTML : le nom (cellule + data-name relu),
            // l'URL d'avatar (attribut src), et le nom du message de
            // confirmation (AIH.confirm l'injecte aussi en innerHTML).
            const safeName = escapeHtml(name);
            const avatarUrl = m.avatar_url || (m.avatar && m.id ? `https://cdn.discordapp.com/avatars/${m.id}/${m.avatar}.png?size=32` : null);
            const roleBadge = m.role === "admin"
                ? '<span style="background:var(--aih-accent, #D8700D);color:#fff;padding:1px 6px;border-radius:3px;font-size:10px;">admin</span>'
                : m.role === "kw_editor"
                  ? '<span style="background:#d97706;color:#fff;padding:1px 6px;border-radius:3px;font-size:10px;">kw_editor</span>'
                  : '<span style="color:#888;font-size:11px;">' + t('menu.memberBadge') + '</span>';

            // Pas de bouton sur sa propre ligne (le serveur bloque de toute
            // façon « Tu ne peux pas te supprimer ») ni pour un non-admin.
            const showDel = canManage && !(currentUserId && m.id && m.id === currentUserId);
            const delCell = showDel
                ? `<button class="aih-member-del" data-id="${escapeHtml(m.id)}" data-name="${safeName}" title="${t("menu.del")}" style="background:transparent;border:none;cursor:pointer;color:#f87171;font-size:13px;padding:2px 4px;">🗑</button>`
                : "";

            html += `<tr style="border-bottom:1px solid #333;">
                <td style="padding:6px 8px;display:flex;align-items:center;gap:8px;">
                    ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" style="width:24px;height:24px;border-radius:50%;flex-shrink:0;">` : '<span style="width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;background:#444;border-radius:50%;font-size:11px;flex-shrink:0;">👤</span>'}
                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${safeName}</span>
                </td>
                <td style="text-align:center;padding:6px 4px;">${roleBadge}</td>
                <td style="text-align:center;padding:6px 4px;">${escapeHtml(m.filter_count ?? 0)}</td>
                <td style="text-align:center;padding:6px 4px;">${escapeHtml(m.prompt_count ?? 0)}</td>
                <td style="text-align:center;padding:6px 4px;">${delCell}</td>
            </tr>`;
        }

        html += "</tbody></table>";
        modal.body.innerHTML = html;

        // Brancher les boutons de suppression.
        modal.body.querySelectorAll(".aih-member-del").forEach((btn) => {
            btn.addEventListener("click", async () => {
                const id = btn.getAttribute("data-id");
                const name = btn.getAttribute("data-name") || "?";
                // AIH.confirm insère son message en innerHTML : le nom (valeur
                // serveur) est échappé AVANT interpolation, sinon XSS stocké.
                const ok = await window.aihShowConfirm(t("dialog.delete"), t("menu.delMemberConfirm", { name: escapeHtml(name) }));
                if (!ok) return;

                // Suppression puis rafraîchissement SÉPARÉS : le refresh est hors
                // du try de suppression pour qu'un échec de refresh ne soit pas
                // présenté comme un échec de suppression (toast mensonger).
                let deleted = false;
                try {
                    // Route réelle : DELETE /api/admin/users/{id} (admin only),
                    // renvoie 200 {'status':'ok'}. La route /api/members/{id}
                    // n'a PAS de méthode DELETE côté serveur.
                    await remoteRequest(`${baseUrl}/api/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" });
                    deleted = true;
                } catch (e) {
                    // HolafFetch lève « réponse non-JSON » sur un 204/corps
                    // vide alors que la suppression a réussi : un 2xx est un
                    // succès, quel que soit le corps.
                    if (e && e.status && e.status >= 200 && e.status < 300) {
                        deleted = true;
                    } else {
                        showToast({ message: t("menu.delError", { error: (e && e.message) || String(e) }), type: "error" });
                    }
                }
                if (!deleted) return;

                showToast({ message: t("menu.memberDeleted", { name }), type: "success" });
                try {
                    await refreshMembers(modal, baseUrl);
                } catch (e) {
                    // Le membre EST supprimé : l'échec du rafraîchissement est
                    // signalé à part (liste potentiellement périmée), jamais
                    // comme une erreur de suppression.
                    showToast({ message: t("menu.membersError", { error: (e && e.message) || String(e) }), type: "error" });
                }
            });
        });
    }

    async function openMembers() {
        const cfg = getConfig();
        const baseUrl = (cfg.serverUrl || "").replace(/\/+$/, "");

        const modal = window.aihOpenModalV2({
            id: "aih-modal-members",
            title: t("menu.membersTitle"),
            content: "<p style='color:#888;font-size:12px;'>" + t('menu.loading') + "</p>",
            width: "560px",
            height: "auto",
            minHeight: "200px",
            storageKey: "aih-modal-members",
            persistSize: true,
            persistPos: true
        });

        // Comportement dégradé : pas d'URL configurée → invitation au lieu
        // d'une requête vers une destination arbitraire.
        if (!baseUrl) {
            modal.body.innerHTML = `<div style="padding:16px;color:#facc15;font-size:12px;line-height:1.6;">${t("menu.membersNotConfigured")}</div>`;
            return;
        }

        try {
            await refreshMembers(modal, baseUrl);
        } catch (err) {
            // err.message (issu du transport/serveur) est échappé AVANT innerHTML.
            modal.body.innerHTML = `<p style="color:#f87171;font-size:12px;">${t("menu.membersError", { error: escapeHtml(err.message) })}</p>`;
        }
    }

    // ── Statut serveur ───────────────────────────────────────────────────

    async function checkServerStatus(el) {
        const cfg = getConfig();
        const baseUrl = (cfg.serverUrl || "").replace(/\/+$/, "");
        const apiKey = cfg.apiKey || "";

        // Serveur non configuré : état explicite au lieu d'une sonde vers
        // une destination arbitraire.
        if (!baseUrl) {
            el.innerHTML = "";
            el.style.display = "flex";
            el.style.alignItems = "center";
            el.textContent = t("menu.serverNotConfiguredStatus");
            el.style.color = "#888";
            return;
        }

        try {
            // Compat timeout → opts.timeout de la brique (même valeur 5000 ms).
            const [statsResp, meResp] = await Promise.all([
                remoteGet(`${baseUrl}/api/stats`, { timeout: 5000 }).catch(() => null),
                remoteGet(`${baseUrl}/api/auth/me`, { timeout: 5000 }).catch((e) => (e && e.status ? e : null)),
            ]);

            // Succès = réponse parsée (pas de .status) ; non-2xx = HolafFetchError
            // (avec .status) ; erreur réseau/timeout = null.
            const serverOk = !!(statsResp && !statsResp.status);
            let user = null;
            if (meResp && !meResp.status) user = meResp;

            el.innerHTML = "";
            el.style.display = "flex";
            el.style.alignItems = "center";
            el.style.gap = "6px";

            if (user && (user.display_name || user.username)) {
                const name = user.display_name || user.username || "?";
                const avatarUrl = user.avatar_url || (user.avatar && user.id ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : null);

                const dot = document.createElement("span");
                dot.textContent = "🟢";
                dot.style.cssText = "font-size:11px;line-height:1;flex-shrink:0;";
                el.appendChild(dot);

                const nameSpan = document.createElement("span");
                nameSpan.textContent = name;
                nameSpan.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
                el.appendChild(nameSpan);

                if (avatarUrl) {
                    const img = document.createElement("img");
                    img.src = avatarUrl;
                    img.style.cssText = "width:22px;height:22px;border-radius:50%;flex-shrink:0;";
                    el.appendChild(img);
                }

                el.style.color = "#4ade80";
            } else if (serverOk) {
                el.textContent = t("menu.serverOnline");
                el.style.color = "#4ade80";
            } else if (statsResp) {
                el.textContent = t("menu.serverResponds", { status: statsResp.status });
                el.style.color = "#facc15";
            } else {
                el.textContent = t("menu.serverOffline");
                el.style.color = "#f87171";
            }
        } catch {
            el.textContent = t("menu.serverOffline");
            el.style.color = "#f87171";
        }
    }

    // ── Paramètres (délégué à la fenêtre Settings AIH unifiée) ─────────
    // Les onglets « Compte » et « Provider LLM » vivent désormais dans la
    // fenêtre Settings de AIH Utilities (panel #holaf-settings-panel,
    // js/holaf_settings_manager.js), au même niveau que ses onglets natifs.
    // Ce gestionnaire appelle directement renderCompteTab() /
    // renderProvidersTab() exposés plus bas sur window.AIHMenu ; ici, on se
    // contente d'ouvrir la fenêtre sur l'onglet AIH demandé (aucune logique
    // de rendu dupliquée).

    function openSettings(tabId = "aih-account") {
        const mgr = getApp()?.holafSettingsManager;
        if (mgr && typeof mgr.show === "function") {
            mgr.show({ tab: tabId });
            return;
        }
        // Fallback : le panneau Settings AIH n'est pas disponible
        // (holaf_settings_manager.js pas encore chargé).
        const msg = t("aih.settingsUnavailable");
        showToast({ message: msg, type: "info", duration: 6000 });
    }

    // ── Helpers partagés ─────────────────────────────────────────────────

    const _aihStyle = {
        input: "width:100%; padding:6px 10px; border-radius:4px; border:1px solid #555; background:#1a1a1e; color:#fff; font-size:12px; box-sizing:border-box;",
        label: "display:block; margin-bottom:3px; font-size:11px; color:#aaa;",
        btn: (bg = "#ff8c00") => `padding:6px 12px; border-radius:4px; border:none; background:${bg}; color:white; cursor:pointer; font-size:12px; font-weight:600;`,
        btnSecondary: "padding:6px 12px; border-radius:4px; border:1px solid #555; background:transparent; color:#ccc; cursor:pointer; font-size:12px;",
        section: "padding:12px; background:#1a1a1e; border:1px solid #333; border-radius:6px; margin-bottom:12px;",
    };

    async function _aihFetchApi(path, opts = {}) {
        const cfg = getConfig();
        // baseUrl pointe vers le backend AIH distant configuré (cfg.serverUrl,
        // renseigné dans Settings ▸ AIH · Compte) ; /api/* est préfixé
        // automatiquement. Sans URL configurée : erreur explicite.
        const baseUrl = (cfg.serverUrl || "").replace(/\/+$/, "");
        if (!baseUrl) {
            throw new Error(t("aih.notConfiguredError"));
        }
        // path peut deja commencer par /api/ (auquel cas on l'utilise tel quel) ou non
        const cleanPath = path.replace(/^\/+/, "");
        const finalPath = cleanPath.startsWith("api/") ? cleanPath : "api/" + cleanPath;
        try {
            return await remoteRequest(`${baseUrl}/${finalPath}`, opts);
        } catch (e) {
            // Reproduit le message historique : "HTTP <status>"/"échec réseau" ou body.error.
            let msg = httpStatusLabel(e);
            if (e && e.body) {
                try {
                    const j = typeof e.body === "string" ? JSON.parse(e.body) : e.body;
                    if (j.error) msg = j.error;
                } catch {}
            }
            throw new Error(msg);
        }
    }

    function mkBtn(text, css, onClick) {
        const b = document.createElement("button");
        b.textContent = text;
        b.style.cssText = typeof css === "string" ? css : "";
        b.onclick = onClick;
        return b;
    }

    // ── Onglet Compte (URL serveur + clé API) ────────────────────────────
    // Renderer autonome : appelé par la fenêtre Settings Holaf
    // (holaf_settings_manager.js, onglet « AIH · Compte »). Le backend local
    // porté expose GET/POST /aih/credentials qui gèrent le fichier
    // user/default/aih/credentials.json (cf. aih/routes.py groupe 1).

    function renderCompteTab(container) {
        const cfg = getConfig();
        container.innerHTML = "";
        const section = document.createElement("div");
        section.style.cssText = _aihStyle.section;

        // Status du fichier de credentials
        const status = document.createElement("p");
        status.style.cssText = "margin:0 0 12px; font-size:11px; color:#888;";
        status.textContent = t("menu.loading");
        section.appendChild(status);

        const lbl1 = document.createElement("label");
        lbl1.textContent = t("menu.urlServer");
        lbl1.style.cssText = _aihStyle.label;
        section.appendChild(lbl1);

        const inputUrl = document.createElement("input");
        inputUrl.type = "url";
        inputUrl.value = cfg.serverUrl || "";
        inputUrl.placeholder = t("menu.serverUrlPlaceholder");
        inputUrl.style.cssText = _aihStyle.input;
        inputUrl.style.marginBottom = "12px";
        section.appendChild(inputUrl);

        const lbl2 = document.createElement("label");
        lbl2.textContent = t("menu.apiKey");
        lbl2.style.cssText = _aihStyle.label;
        section.appendChild(lbl2);

        const inputKey = document.createElement("input");
        inputKey.type = "password";
        inputKey.value = cfg.apiKey || "";
        inputKey.style.cssText = _aihStyle.input;
        inputKey.style.marginBottom = "4px";
        section.appendChild(inputKey);

        const hint = document.createElement("p");
        hint.textContent = t("menu.apiKeyHint");
        Object.assign(hint.style, { margin: "0 0 12px", fontSize: "11px", color: "#888" });
        section.appendChild(hint);

        const saveBtn = mkBtn(t("menu.save"), _aihStyle.btn(), async () => {
            saveBtn.disabled = true;
            saveBtn.textContent = "...";
            try {
                // Route locale /aih/* → HolafFetch SANS auth (same-origin transparente).
                const data = await HolafFetch.post("/aih/credentials", {
                    body: {
                        api_key: inputKey.value.trim(),
                        server_url: inputUrl.value.trim(),
                    },
                });
                if (data.status === "ok") {
                    // Mettre a jour aussi localStorage pour le cache UI
                    setConfig({
                        serverUrl: inputUrl.value.trim(),
                        apiKey: inputKey.value.trim(),
                    });
                    status.textContent = t("menu.savedIn", { path: data.path });
                    status.style.color = "#4ade80";
                    saveBtn.textContent = t("menu.saved");
                } else {
                    status.textContent = t("menu.saveErr", { error: data.message || t("aih.unknown") });
                    status.style.color = "#ef4444";
                    saveBtn.textContent = t("dialog.error");
                }
            } catch (err) {
                status.textContent = t("menu.networkError", { error: err.message });
                status.style.color = "#ef4444";
                saveBtn.textContent = t("dialog.error");
            } finally {
                saveBtn.disabled = false;
                setTimeout(() => { saveBtn.textContent = t("menu.save"); }, 2000);
            }
        });
        section.appendChild(saveBtn);
        container.appendChild(section);

        // Charger les credentials depuis le fichier (au cas ou localStorage est vide)
        HolafFetch.get("/aih/credentials")
            .then(data => {
                if (data.status === "ok") {
                    if (data.server_url) inputUrl.value = data.server_url;
                    if (data.api_key) inputKey.value = data.api_key;
                    if (data.path) {
                        status.textContent = t("menu.file", { path: data.path });
                        status.style.color = "#888";
                    }
                    // Auto-migration : si le fichier n'existe pas mais que
                    // localStorage a une cle, on migre silencieusement.
                    if (!data.exists && cfg.apiKey) {
                        status.textContent = t("menu.migrating");
                        status.style.color = "#facc15";
                        return HolafFetch.post("/aih/credentials", {
                            body: {
                                api_key: cfg.apiKey || "",
                                server_url: cfg.serverUrl || "",
                            },
                        }).then(saveData => {
                            if (saveData.status === "ok") {
                                status.textContent = t("menu.migrated", { path: saveData.path });
                                status.style.color = "#4ade80";
                            } else {
                                status.textContent = t("menu.migrationFailed", { error: saveData.message || t("menu.unknown") });
                                status.style.color = "#ef4444";
                            }
                        });
                    }
                } else {
                    status.textContent = t("menu.readFileFailed", { error: data.message || t("menu.unknown") });
                    status.style.color = "#ef4444";
                }
            })
            .catch(err => {
                status.textContent = t("menu.loadError", { error: err.message });
                status.style.color = "#ef4444";
            });
    }

    // ── Onglet Provider LLM ──────────────────────────────────────────────
    // CRUD presets LLM sur le serveur distant configuré (cfg.serverUrl),
    // appelé directement depuis le navigateur avec Bearer apiKey :
    // GET/POST api/presets, PUT/DELETE api/presets/{id},
    // POST api/presets/list-models (proxy backend) ou appel direct
    // navigateur {base_url}/models en mode Client-side.
    // Renderer autonome appelé par la fenêtre Settings Holaf
    // (holaf_settings_manager.js, onglet « AIH · Provider LLM »).

    async function renderProvidersTab(container) {
        container.innerHTML = "";

        // Section : liste des presets existants
        const listSection = document.createElement("div");
        listSection.style.cssText = _aihStyle.section;
        const listTitle = document.createElement("h3");
        listTitle.textContent = t("menu.myPresets");
        Object.assign(listTitle.style, { margin: "0 0 8px", fontSize: "11px", color: "#888", fontWeight: "600" });
        listSection.appendChild(listTitle);
        container.appendChild(listSection);

        async function reloadPresets() {
            const presets = await _aihFetchApi("presets");
            listSection.innerHTML = "";
            // NB : ne PAS nommer cette variable `t` — elle masquerait le helper
            // de traduction du module et ferait lever « t is not a function ».
            const titleEl = document.createElement("h3");
            titleEl.textContent = t("menu.myPresets");
            Object.assign(titleEl.style, { margin: "0 0 8px", fontSize: "11px", color: "#888", fontWeight: "600" });
            listSection.appendChild(titleEl);
            if (presets.length === 0) {
                const empty = document.createElement("p");
                empty.textContent = t("menu.noPresets");
                Object.assign(empty.style, { color: "#888", fontSize: "12px", margin: "0" });
                listSection.appendChild(empty);
                return;
            }
            presets.forEach(p => {
                const row = document.createElement("div");
                Object.assign(row.style, {
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "6px 8px", borderBottom: "1px solid #2a2a2e", fontSize: "12px",
                });
                const left = document.createElement("div");
                const scope = p.is_global ? t("menu.scopeGlobal") : (p.owner_name ? `(${p.owner_name})` : t("menu.scopePersonal"));
                const clientBadge = p.is_client_side ? " <span style='color:#f59e0b;'>🖥️</span>" : "";
                // p.name / owner_name (via scope) / model / base_url sont des valeurs
                // d'origine serveur : échappées AVANT innerHTML (markup statique conservé).
                left.innerHTML = `<strong style='color:#fff;'>${escapeHtml(p.name)}</strong> <span style='color:#888;'>[${escapeHtml(scope)}]</span> ${clientBadge}<br><span style='color:#888;font-size:10px;'>${escapeHtml(p.model)} @ ${escapeHtml(p.base_url)}</span>`;
                const actions = document.createElement("div");
                Object.assign(actions.style, { display: "flex", gap: "4px" });
                const editBtn = mkBtn(t("menu.edit"), _aihStyle.btnSecondary, () => fillForm(p));
                const dupBtn = mkBtn(t("menu.dup"), _aihStyle.btnSecondary, async () => {
                    const body = { ...p };
                    delete body.id;
                    body.name = p.name + t("menu.dupCopy");
                    try {
                        await _aihFetchApi("presets", { method: "POST", body });
                        reloadPresets();
                    } catch (e) { await window.aihShowAlert(t("dialog.error"), t("menu.dupError", { error: escapeHtml(e.message) }), "error"); }
                });
                const delBtn = mkBtn(t("menu.del"), "padding:6px 12px;border-radius:4px;border:none;background:#7f1d1d;color:white;cursor:pointer;font-size:12px;", async () => {
                    // AIH.confirm injecte son message en innerHTML : p.name échappé.
                    var ok = await window.aihShowConfirm(t("dialog.delete"), t("menu.delConfirm", { name: escapeHtml(p.name) })); if (!ok) return;
                    try {
                        await _aihFetchApi(`presets/${p.id}`, { method: "DELETE" });
                        reloadPresets();
                    } catch (e) { await window.aihShowAlert(t("dialog.error"), t("menu.delError", { error: escapeHtml(e.message) }), "error"); }
                });
                actions.append(editBtn, dupBtn, delBtn);
                row.append(left, actions);
                listSection.appendChild(row);
            });
        }
        await reloadPresets();

        // Section : formulaire create/edit
        const form = document.createElement("div");
        form.style.cssText = _aihStyle.section;

        const editingId = { value: null };

        const formTitle = document.createElement("h3");
        formTitle.id = "aih-preset-form-title";
        formTitle.textContent = t("menu.newPreset");
        Object.assign(formTitle.style, { margin: "0 0 10px", fontSize: "11px", color: "#888", fontWeight: "600" });
        form.appendChild(formTitle);

        const mkField = (label, type = "text", value = "", placeholder = "") => {
            const wrap = document.createElement("div");
            wrap.style.cssText = "margin-bottom:8px;";
            const l = document.createElement("label");
            l.textContent = label;
            l.style.cssText = _aihStyle.label;
            wrap.appendChild(l);
            const input = document.createElement("input");
            input.type = type;
            input.value = value;
            input.placeholder = placeholder;
            input.style.cssText = _aihStyle.input;
            wrap.appendChild(input);
            return { wrap, input };
        };

        const fName = mkField(t("menu.presetName"), "text", "", "");
        form.appendChild(fName.wrap);

        const fUrl = mkField(t("menu.urlServer"), "url", "", t("menu.urlPlaceholder"));
        form.appendChild(fUrl.wrap);

        const fKey = mkField(t("menu.apiKeyOptional"), "password", "", "");
        form.appendChild(fKey.wrap);

        // Modele + bouton Lister
        const modelRow = document.createElement("div");
        modelRow.style.cssText = "display:flex; gap:6px; margin-bottom:8px; align-items:flex-end;";
        const fModelWrap = document.createElement("div");
        fModelWrap.style.cssText = "flex:1;";
        const lblModel = document.createElement("label");
        lblModel.textContent = t("menu.model");
        lblModel.style.cssText = _aihStyle.label;
        fModelWrap.appendChild(lblModel);
        const fModel = document.createElement("input");
        fModel.type = "text";
        fModel.placeholder = t("menu.modelPlaceholder");
        fModel.style.cssText = _aihStyle.input;
        fModelWrap.appendChild(fModel);
        modelRow.appendChild(fModelWrap);

        const listModelsBtn = mkBtn(t("menu.list"), "padding:6px 10px;border-radius:4px;border:1px solid #ff8c00;background:transparent;color:#ff8c00;cursor:pointer;font-size:11px;flex:0 0 auto;height:28px;");
        listModelsBtn.onclick = async () => {
            const url = fUrl.input.value.trim();
            if (!url) { await window.aihShowAlert(t("aih.info"), t("menu.listUrlFirst"), "info"); return; }
            try {
                let models;
                const isClient = fClientInput.checked;
                if (isClient) {
                    // Appel direct navigateur → serveur LLM (cible tierce :
                    // HolafFetch.request SANS auth AIH, le Bearer est la clé LLM).
                    const k = fKey.input.value.trim();
                    const headers = { "Content-Type": "application/json" };
                    if (k) headers["Authorization"] = "Bearer " + k;
                    let data;
                    try {
                        data = await HolafFetch.request(url.replace(/\/+$/, "") + "/models", { headers });
                    } catch (e) {
                        throw new Error(httpStatusLabel(e));
                    }
                    const raw = (data && data.data) || (data && data.models) || [];
                    models = raw.map(m => typeof m === "string" ? { id: m } : { id: m.id || m.name || "" });
                } else {
                    // Backend proxy
                    const resp = await _aihFetchApi("presets/list-models", {
                        method: "POST",
                        body: { base_url: url, api_key: fKey.input.value.trim() },
                    });
                    models = resp;
                }
                // Proposer un select inline pour choisir
                // AIH.prompt injecte son message en innerHTML : chaque id de modèle
                // (valeur d'origine serveur) est échappé avant d'être joint.
                var choice = await window.aihShowPrompt(t("menu.chooseModel"), t("menu.chooseModelMsg", { list: models.map(m => "- " + escapeHtml(m.id)).join("\n") }), models[0]?.id || "");
                if (choice) fModel.value = choice.trim();
            } catch (e) {
                await window.aihShowAlert(t("dialog.error"), t("menu.listModelsError", { error: escapeHtml(e.message) }), "error");
            }
        };
        modelRow.appendChild(listModelsBtn);
        form.appendChild(modelRow);

        // Checkboxes
        const checks = document.createElement("div");
        checks.style.cssText = "display:flex;gap:14px;margin-bottom:10px;";
        const mkCheck = (label, initial = false) => {
            const w = document.createElement("label");
            w.style.cssText = "display:flex;align-items:center;gap:5px;font-size:12px;color:#ccc;cursor:pointer;";
            const i = document.createElement("input");
            i.type = "checkbox";
            i.checked = initial;
            w.appendChild(i);
            w.appendChild(document.createTextNode(label));
            return { wrap: w, input: i };
        };
        const fGlobal = mkCheck(t("menu.globalCheck"), false);
        const fClient = mkCheck(t("menu.clientSide"), false);
        const fClientInput = fClient.input;
        checks.append(fGlobal.wrap, fClient.wrap);
        form.appendChild(checks);

        // Boutons
        const btnRow = document.createElement("div");
        btnRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end;";
        const resetForm = () => {
            editingId.value = null;
            fName.input.value = ""; fUrl.input.value = ""; fKey.input.value = "";
            fModel.value = ""; fGlobal.input.checked = false; fClientInput.checked = false;
            formTitle.textContent = t("menu.newPreset");
        };
        const cancelBtn = mkBtn(t("dialog.cancel"), _aihStyle.btnSecondary, resetForm);
        const saveBtn = mkBtn(t("menu.save"), _aihStyle.btn(), async () => {
            const body = {
                name: fName.input.value.trim(),
                base_url: fUrl.input.value.trim(),
                api_key: fKey.input.value.trim(),
                model: fModel.value.trim(),
                is_global: fGlobal.input.checked ? 1 : 0,
                is_client_side: fClientInput.checked ? 1 : 0,
            };
            if (!body.name || !body.base_url || !body.model) {
                await window.aihShowAlert(t("aih.info"), t("menu.requiredFields"), "info"); return;
            }
            try {
                if (editingId.value) {
                    await _aihFetchApi(`presets/${editingId.value}`, { method: "PUT", body });
                } else {
                    await _aihFetchApi("presets", { method: "POST", body });
                }
                resetForm();
                reloadPresets();
            } catch (e) {
                await window.aihShowAlert(t("dialog.error"), t("menu.saveError", { error: escapeHtml(e.message) }), "error");
            }
        });
        btnRow.append(cancelBtn, saveBtn);
        form.appendChild(btnRow);
        container.appendChild(form);

        function fillForm(p) {
            editingId.value = p.id;
            fName.input.value = p.name || "";
            fUrl.input.value = p.base_url || "";
            fKey.input.value = ""; // On ne pré-remplit pas la clé pour la sécurité
            fModel.value = p.model || "";
            fGlobal.input.checked = !!p.is_global;
            fClientInput.checked = !!p.is_client_side;
            formTitle.textContent = t("menu.editPreset");
        }
    }

    // ── Update (git pull sur le repo local) ──────────────────────────────
    // Adaptation fusion : POST /aih/update renvoie {status, log, updated} et
    // ne redémarre JAMAIS seule. Après un update réussi et la confirmation
    // utilisateur, le redémarrage délègue au flux COMMUN du menu
    // (startRestartFlow de holaf_main.js, exposé sous window.holaf.
    // startRestartFlow) : POST /holaf/utilities/restart + compteur à rebours
    // + reconnexion — l'unique façon de redémarrer, aucun polling/reload
    // dupliqué ici. Si ce flux commun n'est pas disponible (module aih_menu
    // chargé avant holaf_main), un fallback propre (toast + reload manuel)
    // est utilisé à la place.

    async function openUpdate() {
        // Modale d'attente
        const modal = window.aihOpenModalV2({
            id: "aih-aih-update",
            title: t("menu.updateTitle"),
            content: `
            <div style="padding:8px 0;">
                <p style="color:#ccc; font-size:13px; margin:0 0 12px;">
                    ${t("menu.updatingRepo")}
                </p>
                <div id="aih-update-spinner" style="text-align:center; padding:20px;">
                    <span style="display:inline-block; width:32px; height:32px; border:3px solid #444; border-top-color:#ff8c00; border-radius:50%; animation:aih-spin 1s linear infinite;"></span>
                </div>
                <div id="aih-update-log" style="background:#1a1a1e; border:1px solid #333; border-radius:6px; padding:10px; font-family:monospace; font-size:11px; color:#aaa; max-height:280px; overflow-y:auto; white-space:pre-wrap; display:none;"></div>
            </div>
            <style>@keyframes aih-spin { to { transform: rotate(360deg); } }</style>
            `,
            width: "520px",
            height: "auto",
            minHeight: "250px",
            storageKey: "aih:aih-update",
            persistSize: true,
            persistPos: true
        });

        const logEl = modal.body.querySelector("#aih-update-log");
        const spinnerEl = modal.body.querySelector("#aih-update-spinner");

        try {
            // Route locale /aih/* → HolafFetch SANS auth (same-origin transparente).
            const data = await HolafFetch.post("/aih/update");
            spinnerEl.style.display = "none";
            logEl.style.display = "block";
            logEl.textContent = data.log || t("menu.noLog");

            if (data.status === "ok" && data.updated) {
                // Mise à jour effectuée : proposer de redémarrer
                const restartSection = document.createElement("div");
                restartSection.style.cssText = "margin-top:14px; padding:12px; background:#1a2e1a; border:1px solid #2d5a2d; border-radius:6px;";
                restartSection.innerHTML = `
                    <p style="color:#4ade80; font-size:13px; margin:0 0 8px;">
                        ${t("menu.updateInstalledMsg")}
                    </p>
                    <div style="display:flex; gap:8px; justify-content:flex-end;">
                        <button id="aih-update-later" style="padding:6px 14px; border-radius:6px; border:1px solid #555; background:transparent; color:#ccc; cursor:pointer; font-size:12px;">${t("menu.later")}</button>
                        <button id="aih-update-restart" style="padding:6px 14px; border-radius:6px; border:none; background:#ff8c00; color:white; cursor:pointer; font-size:12px; font-weight:600;">${t("menu.restartComfy")}</button>
                    </div>
                `;
                modal.body.appendChild(restartSection);

                modal.body.querySelector("#aih-update-later").onclick = () => modal.close();
                modal.body.querySelector("#aih-update-restart").onclick = () => {
                    // Ferme la modale AIH puis délègue au flux de redémarrage
                    // COMMUN (startRestartFlow de holaf_main.js) : même mécanique
                    // avec compteur à rebours que le bouton « Restart ComfyUI »
                    // du menu. C'est l'unique façon de redémarrer (pas de double
                    // polling/reload ici).
                    modal.close();
                    const restart = window.holaf && typeof window.holaf.startRestartFlow === "function"
                        ? window.holaf.startRestartFlow
                        : null;
                    if (restart) {
                        restart();
                        return;
                    }
                    // Fallback propre : flux commun indisponible (module aih_menu
                    // chargé avant holaf_main). Toast + lien de reload manuel —
                    // on ne recrée PAS de polling/reload local.
                    showToast({
                        message: t("menu.restartUnavailable") + " " +
                            "<a href='#' onclick='event.preventDefault(); location.reload(); " +
                            "return false;' style='color:inherit;'>Recharger manuellement</a>",
                        type: "error",
                        html: true
                    });
                };
            } else if (data.status === "ok" && !data.updated) {
                // Déjà à jour
                const okSection = document.createElement("div");
                okSection.style.cssText = "margin-top:14px; padding:12px; background:#1a2e1a; border:1px solid #2d5a2d; border-radius:6px; text-align:center;";
                okSection.innerHTML = `<p style="color:#4ade80; font-size:13px; margin:0 0 8px;">${t("menu.upToDate")}</p>`;
                const closeBtn = document.createElement("button");
                closeBtn.textContent = t("menu.close");
                Object.assign(closeBtn.style, { padding: "6px 14px", borderRadius: "6px", border: "1px solid #555", background: "transparent", color: "#ccc", cursor: "pointer", fontSize: "12px" });
                closeBtn.onclick = () => modal.close();
                okSection.appendChild(closeBtn);
                modal.body.appendChild(okSection);
            } else {
                // Erreur
                const errSection = document.createElement("div");
                errSection.style.cssText = "margin-top:14px; padding:12px; background:#2e1a1a; border:1px solid #5a2d2d; border-radius:6px; text-align:center;";
                // data.message est un message du serveur : échappé AVANT innerHTML.
                errSection.innerHTML = `<p style="color:#f87171; font-size:13px; margin:0 0 8px;">✗ ${data.message ? escapeHtml(data.message) : t("menu.updateError")}</p>`;
                const closeBtn = document.createElement("button");
                closeBtn.textContent = t("menu.close");
                Object.assign(closeBtn.style, { padding: "6px 14px", borderRadius: "6px", border: "1px solid #555", background: "transparent", color: "#ccc", cursor: "pointer", fontSize: "12px" });
                closeBtn.onclick = () => modal.close();
                errSection.appendChild(closeBtn);
                modal.body.appendChild(errSection);
            }
        } catch (err) {
            spinnerEl.style.display = "none";
            logEl.style.display = "block";
            logEl.textContent = t("menu.networkError", { error: err.message });
        }
    }

    // ── Exposition (pattern merge sûr : n'écrase jamais une API existante) ──

    window.AIHMenu = Object.assign({}, window.AIHMenu, {
        getConfig,
        setConfig,
        openWebpage,
        openWorkflows,
        openModels,
        openMembers,
        openSettings,
        // Renderers d'onglets consommés par holaf_settings_manager.js :
        // chaque onglet de la fenêtre Settings AIH délègue ici.
        renderAccountTab: renderCompteTab,
        renderCompteTab,
        renderProviderTab: renderProvidersTab,
        renderProvidersTab,
        openUpdate,
        checkServerStatus,
        getBlobbyState,
        toggleBlobby,
        openChat,
    });

})();
